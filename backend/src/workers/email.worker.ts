import { DelayedError, Worker } from "bullmq";
import {
  EMAIL_QUEUE_NAME,
  getRedisConnectionOptions,
  type EmailQueueJobData,
} from "../lib/queue";
import { sendEmail } from "../lib/mailer";
import { processEmailJob } from "../services/process-email-job";
import { indexEmailJob } from "../services/email-search";
import { notifySlack, notifySlackRateLimitOnce } from "../services/slack-notifier";

function getWorkerConcurrency(): number {
  const configuredConcurrency = process.env.WORKER_CONCURRENCY;

  if (configuredConcurrency === undefined) {
    return 5;
  }

  const concurrency = Number(configuredConcurrency);

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("WORKER_CONCURRENCY must be a positive integer");
  }

  return concurrency;
}

export function createEmailWorker(
  send = sendEmail,
  index = indexEmailJob,
  notify = notifySlack,
  queueName = EMAIL_QUEUE_NAME,
  notifyRateLimit = notifySlackRateLimitOnce,
): Worker<EmailQueueJobData> {
  const worker = new Worker<EmailQueueJobData>(
    queueName,
    async (job, token) => {
      console.log(`[email-worker] Received BullMQ job ${job.id}`);

      const result = await processEmailJob(
        job.data.emailJobId,
        send,
        String(job.id),
        index,
        notify,
      );

      if (!result.sent && result.skipped === "rate-limited") {
        await job.moveToDelayed(result.deferredUntil.getTime(), token);
        if (result.deferredBy === "hourly-limit") {
          try {
            await notifyRateLimit(
              result.userId,
              result.senderId,
              result.windowStart,
              result.windowEnd,
            );
          } catch (error) {
            const errorName = error instanceof Error ? error.name : "Error";
            console.error(`[email-worker] Slack rate-limit notification failed (${errorName})`);
          }
        }
        throw new DelayedError();
      }

      return result;
    },
    {
      connection: getRedisConnectionOptions(),
      concurrency: getWorkerConcurrency(),
    },
  );

  worker.on("completed", (job) => {
    console.log(`[email-worker] Completed job ${job.id}`);
  });

  worker.on("failed", (job, error) => {
    console.error(`[email-worker] Job ${job?.id ?? "unknown"} failed`);

    if (error instanceof Error) {
      console.error("Error name:", error.name);
      console.error("Error message:", error.message);
      console.error("Error stack:", error.stack);
    } else {
      console.error("Unknown error:", error);
    }
  });

  worker.on("error", (error) => {
    console.error(`[email-worker] Worker error (${error.name})`);
    console.error("Worker error message:", error.message);
    console.error("Worker error stack:", error.stack);
  });

  return worker;
}
