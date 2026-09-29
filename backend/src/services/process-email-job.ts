import { prisma } from "../lib/prisma";
import { sendEmail } from "../lib/mailer";
import { indexEmailJob } from "./email-search";
import { notifySlack } from "./slack-notifier";
import { reserveEmailRateLimitSlot } from "../lib/email-rate-limiter";

type SendEmail = typeof sendEmail;
type IndexEmailJob = typeof indexEmailJob;
type NotifySlack = typeof notifySlack;

export type EmailProcessingResult =
  | { sent: true; previewUrl?: string }
  | {
      sent: false;
      skipped: "rate-limited";
      deferredUntil: Date;
      deferredBy: "hourly-limit" | "minimum-delay";
      senderId: string;
      userId: string;
      windowStart: Date;
      windowEnd: Date;
    }
  | { sent: false; skipped: "missing" | "already-sent" | "already-processing" | "job-id-mismatch" };

/**
 * Claims and delivers one EmailJob. PROCESSING is deliberately not reclaimed:
 * after a crash, SMTP may already have accepted the message, so retrying it
 * automatically could send a duplicate. This favors avoiding duplicates over
 * automatic recovery of ambiguous jobs.
 */
export async function processEmailJob(
  emailJobId: string,
  send: SendEmail = sendEmail,
  bullJobId: string = emailJobId,
  index: IndexEmailJob = indexEmailJob,
  notify: NotifySlack = notifySlack,
): Promise<EmailProcessingResult> {
  if (bullJobId !== emailJobId) {
    console.warn(`[email-worker] Skipping mismatched BullMQ job ${bullJobId}`);
    return { sent: false, skipped: "job-id-mismatch" };
  }

  const emailJob = await prisma.emailJob.findUnique({
    where: { id: emailJobId },
    include: { sender: true, campaign: { select: { hourlyLimit: true, delayMs: true } } },
  });

  if (!emailJob) {
    console.info(`[email-worker] Skipping missing EmailJob ${emailJobId}`);
    return { sent: false, skipped: "missing" };
  }

  if (emailJob.status === "SENT" || emailJob.sentAt !== null) {
    console.info(`[email-worker] EmailJob ${emailJobId} was already sent; skipping`);
    return { sent: false, skipped: "already-sent" };
  }

  if (emailJob.status === "PROCESSING") {
    console.warn(`[email-worker] EmailJob ${emailJobId} is PROCESSING; skipping ambiguous retry`);
    return { sent: false, skipped: "already-processing" };
  }

  if (!emailJob.sender) {
    throw new Error(`Sender for EmailJob ${emailJobId} was not found`);
  }
  if (!emailJob.campaign) {
    throw new Error(`Campaign rate limit for EmailJob ${emailJobId} was not found`);
  }

  // Compare-and-set prevents concurrent workers from both sending the same
  // scheduled or explicitly failed job. FAILED is eligible for BullMQ retry.
  const claimed = await prisma.emailJob.updateMany({
    where: {
      id: emailJobId,
      status: { in: ["SCHEDULED", "FAILED"] },
      sentAt: null,
    },
    data: {
      status: "PROCESSING",
      failedAt: null,
      failureReason: null,
    },
  });

  if (claimed.count !== 1) {
    const current = await prisma.emailJob.findUnique({
      where: { id: emailJobId },
      select: { status: true, sentAt: true },
    });
    if (!current) {
      console.info(`[email-worker] Skipping missing EmailJob ${emailJobId}`);
      return { sent: false, skipped: "missing" };
    }
    if (current.status === "SENT" || current.sentAt !== null) {
      console.info(`[email-worker] EmailJob ${emailJobId} was already sent; skipping`);
      return { sent: false, skipped: "already-sent" };
    }
    console.warn(`[email-worker] EmailJob ${emailJobId} could not be claimed; skipping`);
    return { sent: false, skipped: "already-processing" };
  }

  console.log(`[email-worker] EmailJob ${emailJobId} status PROCESSING`);

  let rateLimit: Awaited<ReturnType<typeof reserveEmailRateLimitSlot>>;
  try {
    rateLimit = await reserveEmailRateLimitSlot(
      emailJob.senderId,
      emailJob.campaign.hourlyLimit,
      emailJob.campaign.delayMs,
    );
  } catch (error) {
    // A Redis outage must not leave a claimed job stuck in PROCESSING.
    await prisma.emailJob.updateMany({
      where: { id: emailJobId, status: "PROCESSING", sentAt: null },
      data: { status: "SCHEDULED" },
    });
    throw error;
  }

  if (!rateLimit.allowed) {
    const deferredUntil = rateLimit.deferredUntil ?? rateLimit.nextWindowAt;
    await prisma.emailJob.updateMany({
      where: { id: emailJobId, status: "PROCESSING", sentAt: null },
      data: {
        status: "SCHEDULED",
        scheduledAt: deferredUntil,
        failedAt: null,
        failureReason: null,
      },
    });
    return {
      sent: false,
      skipped: "rate-limited",
      deferredUntil,
      deferredBy: rateLimit.deferredBy ?? "hourly-limit",
      senderId: emailJob.senderId,
      userId: emailJob.userId,
      windowStart: rateLimit.windowStart,
      windowEnd: rateLimit.nextWindowAt,
    };
  }

  let delivery: Awaited<ReturnType<SendEmail>>;
  try {
    const smtp = {
      host: emailJob.sender.smtpHost,
      port: emailJob.sender.smtpPort,
      user: emailJob.sender.smtpUser,
      password: emailJob.sender.smtpPassword,
      // Sender-specific SMTP security is inferred from the selected port;
      // don't let a global SMTP_SECURE setting override each user's account.
      secure: emailJob.sender.smtpPort === 465,
    };
    delivery = await send({
      smtp,
      from: emailJob.sender.email,
      to: emailJob.recipientEmail,
      subject: emailJob.subject,
      text: emailJob.body,
    });
  } catch (error) {
    await prisma.emailJob.updateMany({
      where: { id: emailJobId, status: "PROCESSING", sentAt: null },
      data: {
        status: "FAILED",
        failedAt: new Date(),
        failureReason: "SMTP delivery failed",
      },
    });
    throw error;
  }

  const markedSent = await prisma.emailJob.updateMany({
    where: { id: emailJobId, status: "PROCESSING", sentAt: null },
    data: {
      status: "SENT",
      sentAt: new Date(),
      failedAt: null,
      failureReason: null,
    },
  });

  if (markedSent.count !== 1) {
    throw new Error(`Unable to persist SENT state for EmailJob ${emailJobId}`);
  }

  // Search indexing is best-effort and independent from delivery. In
  // particular, an Elasticsearch outage must not make BullMQ retry SMTP.
  try {
    await index(emailJobId);
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "Error";
    console.error(`[email-worker] Elasticsearch indexing failed for ${emailJobId} (${errorName})`);
  }

  try {
    await notify(emailJob.userId, `Email sent successfully to ${emailJob.recipientEmail}`);
  } catch (error) {
  const errorName = error instanceof Error ? error.name : "Error";
  const errorMessage = error instanceof Error ? error.message : String(error);

  console.error(
    `[email-worker] Slack notification failed for ${emailJobId} (${errorName}): ${errorMessage}`,
  );

  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
}

  return { sent: true, previewUrl: delivery.previewUrl };
}
