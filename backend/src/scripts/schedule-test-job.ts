import "dotenv/config";
import { randomUUID } from "node:crypto";
import { emailQueue } from "../lib/queue";
import { scheduleEmailJob } from "../services/email-scheduler";

async function main(): Promise<void> {
  const requestedDelay = process.argv[2] === undefined ? 5000 : Number(process.argv[2]);
  if (!Number.isInteger(requestedDelay) || requestedDelay < 1) {
    throw new Error("Provide a positive delay in milliseconds");
  }

  const emailJobId = randomUUID();
  const scheduledAt = new Date(Date.now() + requestedDelay);

  try {
    const job = await scheduleEmailJob(emailJobId, scheduledAt);
    console.log(
      JSON.stringify({
        jobId: job.id,
        emailJobId,
        scheduledAt: scheduledAt.toISOString(),
        delayMs: requestedDelay,
        state: await job.getState(),
      }),
    );
  } finally {
    await emailQueue.close();
  }
}

main().catch((error: unknown) => {
  console.error("Unable to schedule test job:", error);
  process.exitCode = 1;
});
