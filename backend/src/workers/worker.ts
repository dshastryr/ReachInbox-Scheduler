import "dotenv/config";
import { emailQueue } from "../lib/queue";
import { prisma } from "../lib/prisma";
import { createEmailWorker } from "./email.worker";
import { closeEmailRateLimiterRedis } from "../lib/email-rate-limiter";
import { closeSlackNotifierRedis } from "../services/slack-notifier";

const emailWorker = createEmailWorker();

console.log(`[email-worker] Started with concurrency ${emailWorker.concurrency}`);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[email-worker] Received ${signal}; shutting down`);

  try {
    await emailWorker.close();
    await emailQueue.close();
    await closeEmailRateLimiterRedis();
    await closeSlackNotifierRedis();
    await prisma.$disconnect();
    console.log("[email-worker] Shutdown complete");
  } catch (error) {
    console.error("[email-worker] Shutdown failed", error);
    throw error;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
