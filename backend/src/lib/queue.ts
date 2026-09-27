import "dotenv/config";
import { Queue } from "bullmq";

export const EMAIL_QUEUE_NAME = "email-scheduler";

export interface EmailQueueJobData {
  emailJobId: string;
}

export function getRedisConnectionOptions() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL must be set to connect to Redis");
  }

  let url: URL;
  try {
    url = new URL(redisUrl);
  } catch {
    throw new Error("REDIS_URL must be a valid Redis URL");
  }

  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use the redis:// or rediss:// protocol");
  }

  const database = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  if (!Number.isInteger(database) || database < 0) {
    throw new Error("REDIS_URL must contain a valid Redis database number");
  }

  return {
    host: url.hostname,
    port: Number(url.port) || (url.protocol === "rediss:" ? 6380 : 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: database,
    maxRetriesPerRequest: null,
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

export const emailQueue = new Queue<EmailQueueJobData>(EMAIL_QUEUE_NAME, {
  connection: getRedisConnectionOptions(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
  },
});
