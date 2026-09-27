import "dotenv/config";
import { randomUUID } from "node:crypto";
import { QueueEvents } from "bullmq";
import { prisma } from "../lib/prisma";
import { emailQueue, getRedisConnectionOptions } from "../lib/queue";
import { sendEmail } from "../lib/mailer";
import { processEmailJob } from "../services/process-email-job";
import { scheduleEmailJob } from "../services/email-scheduler";
import { createEmailWorker } from "../workers/email.worker";

const LEGACY_STEP_13_PROBE_ID = "0bfb15a9-4f86-4168-9e1f-c52ae3d77720";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Idempotency test failed: ${message}`);
}

function assertSmtpConfigured(): void {
  const required = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"];
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`SMTP is not configured; missing ${missing.join(", ")}`);
  }
}

async function inspectQueueBeforeWorkers(): Promise<void> {
  const pending = await emailQueue.getJobs(["waiting", "active", "delayed"], 0, 999, true);
  if (pending.length === 0) {
    console.log("Queue preflight: no pending jobs found");
    return;
  }

  const ids = pending.map((job) => job.data.emailJobId);
  const rows = await prisma.emailJob.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, sentAt: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const unsafe = pending.filter((job) => {
    const row = byId.get(job.data.emailJobId);
    if (job.data.emailJobId === LEGACY_STEP_13_PROBE_ID && !row) return false;
    return !row || (row.status !== "SENT" && row.sentAt === null);
  });

  if (unsafe.length > 0) {
    throw new Error(
      `Queue preflight found ${unsafe.length} unrelated pending job(s); worker tests were not started`,
    );
  }
  console.log(
    `Queue preflight: ${pending.length} pending job(s); all are already SENT or the known missing-job probe`,
  );
}

async function main(): Promise<void> {
  assertSmtpConfigured();
  await inspectQueueBeforeWorkers();

  const smtpUser = process.env.SMTP_USER!.trim();
  const smtpPort = Number(process.env.SMTP_PORT);
  assert(Number.isInteger(smtpPort) && smtpPort > 0, "SMTP_PORT must be valid");

  const user = await prisma.user.upsert({
    where: { email: "reachinbox-idempotency-test@example.com" },
    create: { name: "ReachInbox Idempotency Test", email: "reachinbox-idempotency-test@example.com" },
    update: {},
    select: { id: true },
  });
  const sender = await prisma.sender.create({
    data: {
      userId: user.id,
      name: "Idempotency Test Sender",
      email: smtpUser,
      smtpHost: process.env.SMTP_HOST!.trim(),
      smtpPort,
      smtpUser,
      smtpPassword: process.env.SMTP_PASSWORD!,
    },
    select: { id: true },
  });

  const delayedAt = new Date(Date.now() + 90_000);
  const delayedEmail = await prisma.emailJob.create({
    data: {
      userId: user.id,
      senderId: sender.id,
      recipientEmail: smtpUser,
      subject: "ReachInbox idempotency verification",
      body: "A controlled Ethereal message for the scheduler idempotency test.",
      scheduledAt: delayedAt,
      idempotencyKey: randomUUID(),
    },
    select: { id: true, scheduledAt: true },
  });

  const firstSchedule = await scheduleEmailJob(delayedEmail.id, delayedEmail.scheduledAt);
  const repeatedSchedule = await scheduleEmailJob(delayedEmail.id, delayedEmail.scheduledAt);
  const persistedDelayedJob = await emailQueue.getJob(delayedEmail.id);
  assert(firstSchedule.id === delayedEmail.id, "BullMQ ID must equal the EmailJob UUID");
  assert(repeatedSchedule.id === firstSchedule.id, "duplicate scheduling must reuse the same job");
  assert(persistedDelayedJob?.id === delayedEmail.id, "one matching BullMQ job must exist");
  assert((await persistedDelayedJob.getState()) === "delayed", "EmailJob must persist as delayed");
  console.log("PASS TEST 1: repeated scheduling reuses one delayed job with the EmailJob UUID");

  const sentAtBefore = new Date(Date.now() - 60_000);
  const alreadySent = await prisma.emailJob.create({
    data: {
      userId: user.id,
      senderId: sender.id,
      recipientEmail: smtpUser,
      subject: "Already sent idempotency test",
      body: "This job must never be delivered.",
      scheduledAt: new Date(),
      status: "SENT",
      sentAt: sentAtBefore,
      idempotencyKey: randomUUID(),
    },
    select: { id: true },
  });
  const sentQueueJob = await scheduleEmailJob(alreadySent.id, new Date());
  let sentJobSmtpCalls = 0;
  const sentResult = await processEmailJob(alreadySent.id, async () => {
    sentJobSmtpCalls += 1;
    return { previewUrl: undefined };
  });
  const sentAfter = await prisma.emailJob.findUniqueOrThrow({
    where: { id: alreadySent.id },
    select: { status: true, sentAt: true },
  });
  assert(!sentResult.sent && sentResult.skipped === "already-sent", "SENT job must be skipped");
  assert(sentJobSmtpCalls === 0, "SENT job must not call SMTP");
  assert(sentAfter.status === "SENT", "SENT status must remain unchanged");
  assert(sentAfter.sentAt?.getTime() === sentAtBefore.getTime(), "sentAt must not change");
  console.log("PASS TEST 2: SENT EmailJob was not sent again and sentAt stayed unchanged");

  const missingId = randomUUID();
  const missingQueueJob = await scheduleEmailJob(missingId, new Date());
  let missingSmtpCalls = 0;
  const missingResult = await processEmailJob(missingId, async () => {
    missingSmtpCalls += 1;
    return { previewUrl: undefined };
  });
  assert(!missingResult.sent && missingResult.skipped === "missing", "missing EmailJob must be skipped safely");
  assert(missingSmtpCalls === 0, "missing EmailJob must not call SMTP");
  console.log("PASS TEST 3: missing EmailJob was safely skipped without SMTP");

  const queueEvents = new QueueEvents("email-scheduler", {
    connection: getRedisConnectionOptions(),
  });
  await queueEvents.waitUntilReady();
  let smtpCalls = 0;
  const countedSend = async (options: Parameters<typeof sendEmail>[0]) => {
    smtpCalls += 1;
    return sendEmail(options);
  };

  const workerBeforeRestart = createEmailWorker(countedSend);
  await workerBeforeRestart.waitUntilReady();
  await Promise.all([
    sentQueueJob.waitUntilFinished(queueEvents, 30_000),
    missingQueueJob.waitUntilFinished(queueEvents, 30_000),
  ]);
  await workerBeforeRestart.close();

  assert(Date.now() < delayedAt.getTime(), "first worker must stop before the delayed job is due");
  const afterStop = await emailQueue.getJob(delayedEmail.id);
  assert(afterStop?.id === delayedEmail.id, "delayed job must remain in Redis after worker stop");
  assert((await afterStop.getState()) === "delayed", "job must still be delayed after worker stop");
  const delayedState = await prisma.emailJob.findUniqueOrThrow({
    where: { id: delayedEmail.id },
    select: { status: true },
  });
  assert(delayedState.status === "SCHEDULED", "job must remain SCHEDULED before its due time");
  console.log("PASS TEST 4A: worker stopped before execution; Redis retained the delayed job");

  const workerAfterRestart = createEmailWorker(countedSend);
  await workerAfterRestart.waitUntilReady();
  const result = await afterStop.waitUntilFinished(queueEvents, 180_000);
  await workerAfterRestart.close();

  const finalEmail = await prisma.emailJob.findUniqueOrThrow({
    where: { id: delayedEmail.id },
    select: { status: true, sentAt: true },
  });
  const finalQueueState = await (await emailQueue.getJob(delayedEmail.id))?.getState();
  const databaseRows = await prisma.emailJob.count({ where: { id: delayedEmail.id } });
  assert(finalEmail.status === "SENT" && finalEmail.sentAt !== null, "restarted worker must send and persist SENT");
  assert(finalQueueState === "completed", "BullMQ job must complete");
  assert(smtpCalls === 1, `duplicate schedule must produce one SMTP call, got ${smtpCalls}`);
  assert(databaseRows === 1, "only one EmailJob row must exist");
  assert(result !== undefined, "worker should return successful delivery result");
  console.log("PASS TEST 4B: restarted worker processed the persisted job and marked it SENT");
  console.log("PASS TEST 5: duplicate enqueue + worker produced one SMTP call and one EmailJob");

  const retryEmail = await prisma.emailJob.create({
    data: {
      userId: user.id,
      senderId: sender.id,
      recipientEmail: smtpUser,
      subject: "BullMQ retry verification",
      body: "A controlled retry test that does not contact SMTP.",
      scheduledAt: new Date(),
      idempotencyKey: randomUUID(),
    },
    select: { id: true, scheduledAt: true },
  });
  const retryQueueJob = await scheduleEmailJob(retryEmail.id, retryEmail.scheduledAt);
  let retryCalls = 0;
  const transientSend = async () => {
    retryCalls += 1;
    if (retryCalls === 1) throw new Error("controlled transient failure");
    return { previewUrl: undefined };
  };
  const retryWorker = createEmailWorker(transientSend);
  await retryWorker.waitUntilReady();
  await retryQueueJob.waitUntilFinished(queueEvents, 30_000);
  await retryWorker.close();
  const retryResult = await prisma.emailJob.findUniqueOrThrow({
    where: { id: retryEmail.id },
    select: { status: true, failedAt: true },
  });
  const completedRetryJob = await emailQueue.getJob(retryEmail.id);
  assert(retryCalls === 2, `BullMQ should retry once before success, got ${retryCalls} calls`);
  assert(retryResult.status === "SENT", "retry should transition FAILED back through PROCESSING to SENT");
  assert(retryResult.failedAt === null, "successful retry should clear failedAt");
  assert((await completedRetryJob?.getState()) === "completed", "retried BullMQ job should complete");
  console.log("PASS RETRY: transient error was retried by BullMQ and the FAILED job recovered to SENT");

  await queueEvents.close();
}

main()
  .catch((_error: unknown) => {
    // The underlying SMTP error can include provider details; never print it.
    console.error("Idempotency test did not complete; see the preceding non-sensitive diagnostics");
    process.exitCode = 1;
  })
  .finally(async () => {
    await emailQueue.close();
    await prisma.$disconnect();
  });
