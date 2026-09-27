import type { Job } from "bullmq";
import { emailQueue, type EmailQueueJobData } from "../lib/queue";
import type { Queue } from "bullmq";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function calculateBullMqDelay(scheduledAt: Date, now: Date = new Date()): number {
  if (!(scheduledAt instanceof Date) || !Number.isFinite(scheduledAt.getTime())) {
    throw new Error("scheduledAt must be a valid Date");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("now must be a valid Date");
  }
  return Math.max(0, scheduledAt.getTime() - now.getTime());
}

export async function scheduleEmailJob(
  emailJobId: string,
  scheduledAt: Date,
  queue: Queue<EmailQueueJobData> = emailQueue,
): Promise<Job<EmailQueueJobData>> {
  if (!UUID_PATTERN.test(emailJobId)) {
    throw new Error("emailJobId must be a valid UUID");
  }

  // BullMQ accepts zero delay for an immediately available job. Clamp past
  // dates so a late campaign never creates an invalid negative delay.
  const delay = calculateBullMqDelay(scheduledAt);

  // Retained completed/failed jobs also count as already scheduled. This
  // keeps repeat requests idempotent throughout development and retries.
  const existingJob = await queue.getJob(emailJobId);
  if (existingJob) {
    return existingJob;
  }

  return queue.add(
    "send-email",
    { emailJobId },
    {
      jobId: emailJobId,
      delay,
    },
  );
}
