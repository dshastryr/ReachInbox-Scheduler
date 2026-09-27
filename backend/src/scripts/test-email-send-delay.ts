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
const MINIMUM_DELAY_MS = 200;
const HOURLY_LIMIT = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const testId = randomUUID();
  const queueName = `email-send-delay-test-${testId}`;
  const queue = new Queue<EmailQueueJobData>(queueName, { connection: getRedisConnectionOptions() });
  const redis = new Redis(getRedisConnectionOptions());
  const workers: Array<ReturnType<typeof createEmailWorker>> = [];
  let userId: string | undefined;
  const rateKeys: string[] = [];
  let delayKey: string | undefined;

  try {
    // Keep this short test inside one fixed UTC-hour bucket.
    const untilBoundary = HOUR_MS - (Date.now() % HOUR_MS);
    if (untilBoundary < 20_000) await sleep(untilBoundary + 250);
    const windowStart = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;

    const user = await prisma.user.create({
      data: { name: "Send Delay Test", email: `send-delay-${testId}@example.test` },
      select: { id: true },
    });
    userId = user.id;
    const sender = await prisma.sender.create({
      data: {
        userId,
        name: "Send Delay Test Sender",
        email: `send-delay-sender-${testId}@example.test`,
        smtpHost: "unused.invalid",
        smtpPort: 587,
        smtpUser: "test-user",
        smtpPassword: "test-password",
      },
      select: { id: true },
    });
    const campaign = await prisma.campaign.create({
      data: {
        userId,
        name: "Send Delay Test Campaign",
        subject: "Send delay test",
        body: "Fake SMTP only",
        startAt: new Date(),
        delayMs: MINIMUM_DELAY_MS,
        hourlyLimit: HOURLY_LIMIT,
      },
      select: { id: true, delayMs: true, hourlyLimit: true },
    });

    const jobs = await Promise.all(Array.from({ length: 4 }, (_, index) => prisma.emailJob.create({
      data: {
        userId: userId!,
        senderId: sender.id,
        campaignId: campaign.id,
        recipientEmail: `delay-${index}-${testId}@example.test`,
        subject: "Send delay test",
        body: "Fake SMTP only",
        scheduledAt: new Date(),
        idempotencyKey: randomUUID(),
      },
      select: { id: true },
    })));

    const rateKey = `email-rate:${sender.id}:${windowStart}`;
    delayKey = `email-send-delay:${sender.id}`;
    rateKeys.push(rateKey);
    await Promise.all(jobs.map((job) => scheduleEmailJob(job.id, new Date(), queue)));

    const sendTimes: number[] = [];
    let redisDelayValueSeen = false;
    for (let index = 0; index < 4; index += 1) {
      const worker = createEmailWorker(
        async () => {
          sendTimes.push(Date.now());
          if (!redisDelayValueSeen) {
            const nextAllowedAt = Number(await redis.get(delayKey!));
            assert(Number.isFinite(nextAllowedAt) && nextAllowedAt > Date.now(),
              "the Redis sender-delay key should reserve the next send time");
            redisDelayValueSeen = true;
          }
          return { previewUrl: undefined };
        },
        async () => undefined,
        async () => ({ sent: false as const, reason: "not_connected" as const }),
        queueName,
      );
      workers.push(worker);
    }
    await Promise.all(workers.map((worker) => worker.waitUntilReady()));

    const deadline = Date.now() + 15_000;
    const nextHour = windowStart + HOUR_MS;
    let rows = await prisma.emailJob.findMany({
      where: { id: { in: jobs.map((job) => job.id) } },
      select: { id: true, status: true, scheduledAt: true },
    });
    while (Date.now() < deadline) {
      const sent = rows.filter((row) => row.status === "SENT").length;
      const deferred = rows.filter((row) => row.status === "SCHEDULED" && row.scheduledAt.getTime() === nextHour);
      const bullmqDelayed = deferred.length === 1 &&
        (await (await queue.getJob(deferred[0].id))?.getState()) === "delayed";
      if (sent === HOURLY_LIMIT && bullmqDelayed) break;
      await sleep(50);
      rows = await prisma.emailJob.findMany({
        where: { id: { in: jobs.map((job) => job.id) } },
        select: { id: true, status: true, scheduledAt: true },
      });
    }

    const sentRows = rows.filter((row) => row.status === "SENT");
    const deferredRows = rows.filter((row) => row.status === "SCHEDULED" && row.scheduledAt.getTime() === nextHour);
    assert.equal(sendTimes.length, HOURLY_LIMIT, "hourlyLimit should cap delivery at three sends");
    assert.equal(sentRows.length, HOURLY_LIMIT);
    assert.equal(redisDelayValueSeen, true, "the Redis delay key must be involved before SMTP");
    assert.equal(await redis.get(rateKey), String(HOURLY_LIMIT), "the campaign hourly limit should still use Redis");
    assert.equal(deferredRows.length, 1, "the excess email should remain scheduled");
    assert.equal(deferredRows[0].scheduledAt.getTime(), nextHour,
      "the hourly cap should defer the excess email to the next UTC hour");
    assert.equal(rows.some((row) => row.status === "FAILED"), false, "delay and rate deferrals must not fail jobs");

    const orderedSends = [...sendTimes].sort((a, b) => a - b);
    for (let index = 1; index < orderedSends.length; index += 1) {
      assert.ok(orderedSends[index] - orderedSends[index - 1] >= campaign.delayMs,
        `SMTP sends ${index} and ${index + 1} were less than ${campaign.delayMs}ms apart`);
    }

    const delayedJob = await queue.getJob(deferredRows[0].id);
    assert.equal(await delayedJob?.getState(), "delayed");
    assert.equal(delayedJob?.attemptsMade, 0, "BullMQ deferral must not consume a failed attempt");

    console.log(`PASS 1: ${campaign.delayMs}ms campaign delay was enforced between actual fake SMTP sends`);
    console.log("PASS 2: four concurrent workers could not bypass the sender-wide delay");
    console.log("PASS 3: campaign hourlyLimit=3 still limited sends; excess job remained delayed, not FAILED");
    console.log("PASS 4: Redis sender-delay and hourly counters were read and verified; no cron used");
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    try {
      await queue.obliterate({ force: true });
    } finally {
      await queue.close();
      await emailQueue.close();
      if (rateKeys.length > 0) await redis.del(...rateKeys);
      if (delayKey) await redis.del(delayKey);
      await redis.quit();
      await closeEmailRateLimiterRedis();
      if (userId) await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
    }
  }
}

main().catch((error: unknown) => {
  console.error("Send-delay test failed:");
  console.error(error);
  process.exitCode = 1;
});
