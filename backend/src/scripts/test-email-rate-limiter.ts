import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { Queue } from "bullmq";
import { prisma } from "../lib/prisma";
import { closeEmailRateLimiterRedis } from "../lib/email-rate-limiter";
import { emailQueue, getRedisConnectionOptions, type EmailQueueJobData } from "../lib/queue";
import { scheduleEmailJob } from "../services/email-scheduler";
import { createEmailWorker } from "../workers/email.worker";

const HOUR_MS = 60 * 60 * 1000;
const HOURLY_LIMIT = 2;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const testId = randomUUID();
  const queueName = `email-rate-limit-test-${testId}`;
  const queue = new Queue<EmailQueueJobData>(queueName, { connection: getRedisConnectionOptions() });
  const redis = new Redis(getRedisConnectionOptions());
  const workers: Array<ReturnType<typeof createEmailWorker>> = [];
  let userId: string | undefined;
  const rateKeys: string[] = [];

  try {
    // Avoid straddling a fixed UTC-hour boundary during this short integration test.
    const untilBoundary = HOUR_MS - (Date.now() % HOUR_MS);
    if (untilBoundary < 20_000) await sleep(untilBoundary + 250);

    const testWindowStart = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const user = await prisma.user.create({
      data: { name: "Rate Limit Test", email: `rate-limit-${testId}@example.test` },
      select: { id: true },
    });
    userId = user.id;

    const senderA = await prisma.sender.create({
      data: {
        userId,
        name: "Rate Limit Sender A",
        email: `sender-a-${testId}@example.test`,
        smtpHost: "unused.invalid",
        smtpPort: 587,
        smtpUser: "test-user",
        smtpPassword: "test-password",
      },
      select: { id: true, email: true },
    });
    const senderB = await prisma.sender.create({
      data: {
        userId,
        name: "Rate Limit Sender B",
        email: `sender-b-${testId}@example.test`,
        smtpHost: "unused.invalid",
        smtpPort: 587,
        smtpUser: "test-user",
        smtpPassword: "test-password",
      },
      select: { id: true, email: true },
    });
    const campaign = await prisma.campaign.create({
      data: {
        userId,
        name: "Rate Limit Test Campaign",
        subject: "Rate limit test",
        body: "Fake SMTP only",
        startAt: new Date(),
        delayMs: 0,
        hourlyLimit: HOURLY_LIMIT,
      },
      select: { id: true },
    });

    const fixtures = [
      ...Array.from({ length: 4 }, (_, index) => ({ sender: senderA, label: `a-${index}` })),
      { sender: senderB, label: "b-0" },
    ];
    const jobs = await Promise.all(fixtures.map(({ sender, label }) => prisma.emailJob.create({
      data: {
        userId: userId!,
        senderId: sender.id,
        campaignId: campaign.id,
        recipientEmail: `${label}-${testId}@example.test`,
        subject: "Rate limit test",
        body: "Fake SMTP only",
        scheduledAt: new Date(),
        idempotencyKey: randomUUID(),
      },
      select: { id: true, senderId: true },
    })));

    const senderAKey = `email-rate:${senderA.id}:${testWindowStart}`;
    const senderBKey = `email-rate:${senderB.id}:${testWindowStart}`;
    rateKeys.push(senderAKey, senderBKey);
    assert.notEqual(senderAKey, senderBKey, "Redis rate-limit keys must include sender ID");

    await Promise.all(jobs.map((job) => scheduleEmailJob(job.id, new Date(), queue)));

    let sendCount = 0;
    const sendsBySender = new Map<string, number>();
    for (let index = 0; index < 4; index += 1) {
      const worker = createEmailWorker(
        async ({ from }) => {
          sendCount += 1;
          sendsBySender.set(from, (sendsBySender.get(from) ?? 0) + 1);
          return { previewUrl: undefined };
        },
        async () => undefined,
        async () => ({ sent: false as const, reason: "not_connected" as const }),
        queueName,
      );
      workers.push(worker);
    }
    await Promise.all(workers.map((worker) => worker.waitUntilReady()));

    const deadline = Date.now() + 20_000;
    let rows = await prisma.emailJob.findMany({
      where: { id: { in: jobs.map((job) => job.id) } },
      select: { id: true, senderId: true, status: true, scheduledAt: true },
    });
    while (Date.now() < deadline) {
      const sentA = rows.filter((row) => row.senderId === senderA.id && row.status === "SENT").length;
      const sentB = rows.filter((row) => row.senderId === senderB.id && row.status === "SENT").length;
      const deferredA = rows.filter((row) =>
        row.senderId === senderA.id && row.status === "SCHEDULED" && row.scheduledAt.getTime() > Date.now(),
      ).length;
      const delayedA = await Promise.all(rows
        .filter((row) => row.senderId === senderA.id && row.status === "SCHEDULED" && row.scheduledAt.getTime() > Date.now())
        .map(async (row) => await (await queue.getJob(row.id))?.getState() === "delayed"));
      if (sentA === HOURLY_LIMIT && sentB === 1 && deferredA === 2 && delayedA.every(Boolean)) break;
      await sleep(50);
      rows = await prisma.emailJob.findMany({
        where: { id: { in: jobs.map((job) => job.id) } },
        select: { id: true, senderId: true, status: true, scheduledAt: true },
      });
    }

    const sentA = rows.filter((row) => row.senderId === senderA.id && row.status === "SENT");
    const sentB = rows.filter((row) => row.senderId === senderB.id && row.status === "SENT");
    const deferredA = rows.filter((row) => row.senderId === senderA.id && row.status === "SCHEDULED");
    assert.equal(sentA.length, HOURLY_LIMIT, "sender A should send exactly two messages");
    assert.equal(sentB.length, 1, "sender B should have an independent quota");
    assert.equal(sendCount, 3, "rate-limited jobs must not call SMTP");
    assert.equal(sendsBySender.get(senderA.email), HOURLY_LIMIT);
    assert.equal(sendsBySender.get(senderB.email), 1);
    assert.equal(deferredA.length, 2, "excess sender A jobs should remain SCHEDULED");

    const nextHour = testWindowStart + HOUR_MS;
    for (const row of deferredA) {
      assert.equal(row.scheduledAt.getTime(), nextHour, "deferred time should be the next UTC-hour boundary");
      const queueJob = await queue.getJob(row.id);
      assert.equal(await queueJob?.getState(), "delayed", "rate-limited BullMQ job should be delayed");
      assert.equal(queueJob?.attemptsMade, 0, "delay must not count as a failed attempt");
    }
    assert.equal(rows.filter((row) => row.status === "FAILED").length, 0);

    assert.equal(await redis.get(senderAKey), String(HOURLY_LIMIT), "Redis should record sender A's two reservations");
    assert.equal(await redis.get(senderBKey), "1", "Redis should record sender B independently");

    console.log("PASS 1: campaign.hourlyLimit=2 allowed exactly two concurrent sends per sender");
    console.log("PASS 2: excess jobs stayed SCHEDULED and were delayed to the next UTC-hour boundary");
    console.log("PASS 3: delayed jobs remained at attemptsMade=0 and were not marked FAILED");
    console.log("PASS 4: Redis counters used sender-specific keys and enforced independent sender quotas");
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    try {
      await queue.obliterate({ force: true });
    } finally {
      await queue.close();
      await emailQueue.close();
      await redis.del(...rateKeys);
      await redis.quit();
      await closeEmailRateLimiterRedis();
      if (userId) await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
    }
  }
}

main().catch((error: unknown) => {
  console.error("Rate-limit test failed:");
  console.error(error);
  process.exitCode = 1;
});
