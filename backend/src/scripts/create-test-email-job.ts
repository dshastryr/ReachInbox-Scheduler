import "dotenv/config";
import { randomUUID } from "node:crypto";
import { QueueEvents } from "bullmq";
import { prisma } from "../lib/prisma";
import { emailQueue, getRedisConnectionOptions } from "../lib/queue";
import type { SmtpSettings } from "../lib/mailer";
import { scheduleEmailJob } from "../services/email-scheduler";

const failureTest = process.argv.includes("--failure");
const requiredVariables = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_SECURE",
] as const;

function loadTestSmtpSettings(): Required<SmtpSettings> {
  const missing = requiredVariables.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Set these environment variables before sending: ${missing.join(", ")}`);
  }

  const port = Number(process.env.SMTP_PORT);
  const secureValue = process.env.SMTP_SECURE?.trim().toLowerCase();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP_PORT must be an integer between 1 and 65535");
  }
  if (secureValue !== "true" && secureValue !== "false") {
    throw new Error("SMTP_SECURE must be either true or false");
  }

  return {
    host: process.env.SMTP_HOST!.trim(),
    port,
    user: process.env.SMTP_USER!.trim(),
    password: process.env.SMTP_PASSWORD!,
    secure: secureValue === "true",
  };
}

async function main(): Promise<void> {
  const smtp = loadTestSmtpSettings();
  const queueEvents = new QueueEvents("email-scheduler", {
    connection: getRedisConnectionOptions(),
  });
  await queueEvents.waitUntilReady();

  let senderId: string | undefined;
  let senderCreated = false;

  try {
    const testUser = await prisma.user.upsert({
      where: { email: "reachinbox-ethereal-test@example.com" },
      create: {
        name: "ReachInbox Ethereal Test",
        email: "reachinbox-ethereal-test@example.com",
      },
      update: {},
      select: { id: true },
    });

    const sender = await prisma.sender.create({
      data: {
        userId: testUser.id,
        name: "Ethereal Test Sender",
        email: smtp.user,
        smtpHost: failureTest ? "invalid-smtp.invalid" : smtp.host,
        smtpPort: smtp.port,
        smtpUser: smtp.user,
        smtpPassword: smtp.password,
      },
      select: { id: true },
    });
    senderId = sender.id;
    senderCreated = true;

    const scheduledAt = new Date(Date.now() + 1000);
    const emailJob = await prisma.emailJob.create({
      data: {
        userId: testUser.id,
        senderId: sender.id,
        recipientEmail: smtp.user,
        subject: "ReachInbox test email",
        body: "This is a test email from the ReachInbox scheduler.",
        scheduledAt,
        idempotencyKey: randomUUID(),
      },
      select: { id: true, scheduledAt: true },
    });

    const queueJob = await scheduleEmailJob(emailJob.id, emailJob.scheduledAt);
    console.log(
      `[email-test] Enqueued EmailJob ${emailJob.id} as BullMQ job ${queueJob.id}${failureTest ? " (failure test)" : ""}`,
    );

    let deliveryResult: unknown;
    try {
      deliveryResult = await queueJob.waitUntilFinished(queueEvents, 120_000);
    } catch {
      // Failure details are read from the database below; SMTP error text is not logged.
    }

    const result = await prisma.emailJob.findUniqueOrThrow({
      where: { id: emailJob.id },
      select: { status: true, sentAt: true, failedAt: true, failureReason: true },
    });
    const persistedQueueJob = await emailQueue.getJob(queueJob.id!);
    if (!persistedQueueJob) {
      throw new Error("BullMQ job was not found after processing");
    }
    const queueState = await persistedQueueJob.getState();
    const attemptsMade = persistedQueueJob.attemptsMade;
    const previewUrl =
      typeof deliveryResult === "object" &&
      deliveryResult !== null &&
      "previewUrl" in deliveryResult &&
      typeof deliveryResult.previewUrl === "string"
        ? deliveryResult.previewUrl
        : undefined;

    if (
      !failureTest &&
      (result.status !== "SENT" || !result.sentAt || queueState !== "completed")
    ) {
      throw new Error("Email test did not reach SENT status");
    }
    if (
      failureTest &&
      (result.status !== "FAILED" ||
        !result.failedAt ||
        !result.failureReason ||
        queueState !== "failed" ||
        attemptsMade !== 3)
    ) {
      throw new Error("Email failure test did not reach FAILED status");
    }
    if (
      result.failureReason?.includes(smtp.password) ||
      result.failureReason?.includes(smtp.user)
    ) {
      throw new Error("Failure reason unexpectedly contains an SMTP credential");
    }

    console.log(
      JSON.stringify({
        emailJobId: emailJob.id,
        queueJobId: queueJob.id,
        queueState,
        status: result.status,
        sentAt: result.sentAt,
        failedAt: result.failedAt,
        failureReason: result.failureReason,
        attemptsMade,
        previewUrl,
        smtpCredentialsLogged: false,
      }),
    );
  } finally {
    if (failureTest && senderCreated && senderId) {
      await prisma.sender.update({
        where: { id: senderId },
        data: {
          smtpHost: smtp.host,
          smtpPort: smtp.port,
          smtpUser: smtp.user,
          smtpPassword: smtp.password,
        },
      });
    }
    await queueEvents.close();
    await emailQueue.close();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("Email test could not complete:", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
