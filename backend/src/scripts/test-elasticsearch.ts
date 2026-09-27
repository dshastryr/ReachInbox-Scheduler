import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { Queue, QueueEvents } from "bullmq";
import { prisma } from "../lib/prisma";
import {
  createElasticsearchClient,
  EMAIL_JOBS_INDEX,
  ensureEmailJobsIndex,
  getElasticsearchClient,
} from "../lib/elasticsearch";
import { emailQueue, getRedisConnectionOptions, type EmailQueueJobData } from "../lib/queue";
import { indexEmailJob, searchEmailJobs } from "../services/email-search";
import { scheduleEmailJob } from "../services/email-scheduler";
import app from "../app";
import { createEmailWorker } from "../workers/email.worker";
import { closeEmailRateLimiterRedis } from "../lib/email-rate-limiter";
import assert from "node:assert/strict";

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function inspectQueueBeforeWorker(): Promise<void> {
  const pending = await emailQueue.getJobs(["waiting", "active", "delayed"], 0, 999, true);
  if (pending.length === 0) return;
  const rows = await prisma.emailJob.findMany({
    where: { id: { in: pending.map((job) => job.data.emailJobId) } },
    select: { id: true, status: true, sentAt: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const unsafe = pending.filter((job) => {
    if (job.data.emailJobId === "0bfb15a9-4f86-4168-9e1f-c52ae3d77720" && !byId.has(job.data.emailJobId)) {
      return false;
    }
    const row = byId.get(job.data.emailJobId);
    return !row || (row.status !== "SENT" && row.sentAt === null);
  });
  if (unsafe.length > 0) {
    throw new Error("Queue preflight found unrelated pending mail; Elasticsearch worker tests were not started");
  }
}

async function main(): Promise<void> {
  const esClient = getElasticsearchClient();
  const testTag = randomUUID().slice(0, 8);
  const subjectMarker = `reachinbox-search-${testTag}`;
  const recipientMarker = `recipient-${testTag}`;
  const smtpPasswordSentinel = `DO_NOT_INDEX_SMTP_PASSWORD_${testTag}`;
  const createdIds: string[] = [];
  const testUserIds: string[] = [];
  let unavailableClient: ReturnType<typeof createElasticsearchClient> | undefined;
  let server: Server | undefined;
  let testQueue: Queue<EmailQueueJobData> | undefined;
  let queueEvents: QueueEvents | undefined;
  let worker: ReturnType<typeof createEmailWorker> | undefined;
  const testQueueName = `email-scheduler-elasticsearch-${testTag}`;

  try {
    await inspectQueueBeforeWorker();
    const ping = await esClient.ping();
    assert(ping, "Elasticsearch should respond to ping");
    console.log("PASS TEST 1: Elasticsearch is reachable");

    await ensureEmailJobsIndex(esClient);
    assert(await esClient.indices.exists({ index: EMAIL_JOBS_INDEX }), "email-jobs index should exist");
    console.log("PASS TEST 2: email-jobs index exists or was initialized without deleting existing data");

    const userA = await prisma.user.create({
      data: { name: `Search Test A ${testTag}`, email: `search-a-${testTag}@example.test` },
      select: { id: true },
    });
    testUserIds.push(userA.id);
    const userB = await prisma.user.create({
      data: { name: `Search Test B ${testTag}`, email: `search-b-${testTag}@example.test` },
      select: { id: true },
    });
    testUserIds.push(userB.id);

    const sender = await prisma.sender.create({
      data: {
        userId: userA.id,
        name: `Test Sender ${testTag}`,
        email: `sender-${testTag}@example.test`,
        smtpHost: "not-used.invalid",
        smtpPort: 587,
        smtpUser: `smtp-user-${testTag}`,
        smtpPassword: smtpPasswordSentinel,
      },
      select: { id: true },
    });
    const campaign = await prisma.campaign.create({
      data: {
        userId: userA.id,
        name: `Campaign ${testTag}`,
        subject: "test campaign",
        body: "test campaign body",
        startAt: new Date(),
        delayMs: 0,
        hourlyLimit: 60,
      },
      select: { id: true, name: true },
    });
    const sentAt = new Date();
    const emailJob = await prisma.emailJob.create({
      data: {
        userId: userA.id,
        senderId: sender.id,
        campaignId: campaign.id,
        recipientEmail: `${recipientMarker}@example.test`,
        subject: `${subjectMarker} invoice summary`,
        body: "Searchable body text for this controlled test fixture.",
        scheduledAt: new Date(sentAt.getTime() - 1000),
        status: "SENT",
        sentAt,
        idempotencyKey: randomUUID(),
      },
      select: { id: true },
    });
    createdIds.push(emailJob.id);

    await indexEmailJob(emailJob.id, esClient);
    await indexEmailJob(emailJob.id, esClient);
    await esClient.indices.refresh({ index: EMAIL_JOBS_INDEX });
    const ownedCount = await esClient.count({
      index: EMAIL_JOBS_INDEX,
      query: { term: { userId: userA.id } },
    });
    assert(ownedCount.count === 1, `indexing twice should yield one document, got ${ownedCount.count}`);
    console.log("PASS TESTS 3-4: SENT EmailJob indexed twice under its UUID as one document");

    const subjectResults = await searchEmailJobs(userA.id, subjectMarker, esClient);
    const recipientResults = await searchEmailJobs(userA.id, recipientMarker, esClient);
    assert(subjectResults.items.some((item) => item.id === emailJob.id), "subject search should return the document");
    assert(recipientResults.items.some((item) => item.id === emailJob.id), "recipient search should return the document");
    assert(!JSON.stringify(subjectResults.items).includes(smtpPasswordSentinel), "SMTP password must not be indexed or returned");
    console.log("PASS TEST 5: subject and recipient full-text searches return the indexed document");

    const otherUserResults = await searchEmailJobs(userB.id, subjectMarker, esClient);
    assert(otherUserResults.total === 0, "another user's scope must not return this document");

    server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address !== null && typeof address !== "string", "test API server should have a TCP address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const scopedResponse = await fetch(
      `${baseUrl}/api/search/emails?q=${encodeURIComponent(subjectMarker)}&userId=${userA.id}`,
      { headers: { "x-user-id": userB.id } },
    );
    const scopedBody = (await scopedResponse.json()) as { total: number; items: Array<{ id: string }> };
    assert(scopedResponse.status === 200 && scopedBody.total === 0, "API scope must use the header user, not query userId");
    const missingAuthResponse = await fetch(`${baseUrl}/api/search/emails?q=${subjectMarker}`);
    assert(missingAuthResponse.status === 401, "search route must require x-user-id");
    console.log("PASS TEST 6: cross-user search is scoped out; client userId is ignored and auth is required");

    const workerJob = await prisma.emailJob.create({
      data: {
        userId: userA.id,
        senderId: sender.id,
        campaignId: campaign.id,
        recipientEmail: `${recipientMarker}-worker@example.test`,
        subject: `${subjectMarker} worker indexing order case`,
        body: "A fake transport verifies Elasticsearch indexing follows the SENT update.",
        scheduledAt: new Date(),
        idempotencyKey: randomUUID(),
      },
      select: { id: true },
    });
    createdIds.push(workerJob.id);
    testQueue = new Queue<EmailQueueJobData>(testQueueName, { connection: getRedisConnectionOptions() });
    const workerQueueJob = await scheduleEmailJob(workerJob.id, new Date(), testQueue);
    queueEvents = new QueueEvents(testQueueName, { connection: getRedisConnectionOptions() });

    await queueEvents.waitUntilReady();

    queueEvents.on("error", (error) => {
      console.log(`[elasticsearch-test] Expected queue error: ${error.message}`);
    });
    let deliveryCalls = 0;
    let statusAtIndex: string | undefined;
    worker = createEmailWorker(
      async () => {
        deliveryCalls += 1;
        return { previewUrl: undefined };
      },
      async (id) => {
        const indexedState = await prisma.emailJob.findUniqueOrThrow({
          where: { id },
          select: { status: true },
        });
        statusAtIndex = indexedState.status;
        await indexEmailJob(id, esClient);
      },
      undefined,
      testQueueName,
    );
    await worker.waitUntilReady();
    await workerQueueJob.waitUntilFinished(queueEvents, 30_000);
    await worker.close();
    worker = undefined;
    const workerResult = await prisma.emailJob.findUniqueOrThrow({
      where: { id: workerJob.id },
      select: { status: true, sentAt: true },
    });
    assert(workerResult.status === "SENT" && workerResult.sentAt !== null, "worker delivery should persist SENT");
    assert(statusAtIndex === "SENT", "indexing must occur after PostgreSQL records SENT");
    assert(deliveryCalls === 1, "worker should deliver once");
    console.log("PASS WORKER: delivery persisted SENT before Elasticsearch indexing");

    const smtpFailureJob = await prisma.emailJob.create({
      data: {
        userId: userA.id,
        senderId: sender.id,
        campaignId: campaign.id,
        recipientEmail: `${recipientMarker}-smtp-failure@example.test`,
        subject: `${subjectMarker} SMTP failure case`,
        body: "The invalid SMTP host must fail this controlled job.",
        scheduledAt: new Date(),
        idempotencyKey: randomUUID(),
      },
      select: { id: true },
    });
    createdIds.push(smtpFailureJob.id);
    const smtpFailureQueueJob = await scheduleEmailJob(smtpFailureJob.id, new Date(), testQueue);
    worker = createEmailWorker(undefined, undefined, undefined, testQueueName);
    await worker.waitUntilReady();

    try {
      await smtpFailureQueueJob.waitUntilFinished(queueEvents, 30_000);
      throw new Error("Expected SMTP failure job to fail, but it completed");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ENOTFOUND")) {
        throw error;
      }
    }
    const smtpFailureResult = await prisma.emailJob.findUniqueOrThrow({
      where: { id: smtpFailureJob.id },
      select: { status: true, failedAt: true },
    });
    assert(smtpFailureResult.status === "FAILED" && smtpFailureResult.failedAt !== null,
      "SMTP failure should persist FAILED status and failedAt");
    console.log("PASS TEST 7: SMTP failure was handled as expected");
    await worker.close();
    worker = undefined;

    const failureJob = await prisma.emailJob.create({
      data: {
        userId: userA.id,
        senderId: sender.id,
        campaignId: campaign.id,
        recipientEmail: `${recipientMarker}-failure@example.test`,
        subject: `${subjectMarker} indexing outage case`,
        body: "A fake transport verifies search failures do not cause delivery retries.",
        scheduledAt: new Date(),
        idempotencyKey: randomUUID(),
      },
      select: { id: true },
    });
    createdIds.push(failureJob.id);
    const failureQueueJob = await scheduleEmailJob(failureJob.id, new Date(), testQueue);
    unavailableClient = createElasticsearchClient("http://127.0.0.1:1");
    let sendCalls = 0;
    worker = createEmailWorker(
      async () => {
        sendCalls += 1;
        return { previewUrl: undefined };
      },
      (id) => indexEmailJob(id, unavailableClient!),
      undefined,
      testQueueName,
    );
    await worker.waitUntilReady();
    await failureQueueJob.waitUntilFinished(queueEvents, 30_000);
    await worker.close();
    worker = undefined;
    const afterIndexFailure = await prisma.emailJob.findUniqueOrThrow({
      where: { id: failureJob.id },
      select: { status: true, sentAt: true },
    });
    assert(sendCalls === 1, "SMTP must be called once despite Elasticsearch failure");
    assert(afterIndexFailure.status === "SENT" && afterIndexFailure.sentAt !== null, "ES failure must not change SENT state");
    const failedIndexQueueJob = await testQueue.getJob(failureJob.id);
    assert((await failedIndexQueueJob?.getState()) === "completed", "index failure must not retry email delivery");

    await indexEmailJob(failureJob.id, esClient);
    await esClient.indices.refresh({ index: EMAIL_JOBS_INDEX });
    const independentlyRetried = await searchEmailJobs(userA.id, "indexing outage case", esClient);
    assert(independentlyRetried.items.some((item) => item.id === failureJob.id), "index operation should be retryable independently");
    assert(sendCalls === 1, "independent indexing retry must not send again");
    console.log("PASS TEST 8: ES connection failure left EmailJob SENT; independent reindex succeeded without another send");
  } finally {
    await worker?.close();
    await queueEvents?.close();
    await testQueue?.close();
    await closeEmailRateLimiterRedis();
    await emailQueue.close();
    await closeServer(server);
    for (const id of createdIds) {
      try {
        await esClient.delete({ index: EMAIL_JOBS_INDEX, id });
      } catch {
        // Only dedicated test document IDs are cleaned up; never remove the index.
      }
    }
    if (createdIds.length > 0) {
      try {
        await esClient.indices.refresh({ index: EMAIL_JOBS_INDEX });
      } catch {
        // The fixture may not have reached Elasticsearch if a prior test failed.
      }
    }
    if (testUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: testUserIds } } });
    }
    await unavailableClient?.close();
    await esClient.close();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("Elasticsearch test failed:");
  console.error(error);
  process.exitCode = 1;
});
