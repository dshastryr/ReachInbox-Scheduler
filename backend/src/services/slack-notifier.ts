import Redis from "ioredis";
import { prisma } from "../lib/prisma";
import { getRedisConnectionOptions } from "../lib/queue";
import { postSlackMessage } from "../lib/slack";

const RATE_LIMIT_ALERT_KEY_PREFIX = "slack:rate-limit-alert:";
let alertRedis: Redis | undefined;

function getAlertRedis(): Redis {
  if (!alertRedis) alertRedis = new Redis(getRedisConnectionOptions());
  return alertRedis;
}

export type SlackPost = typeof postSlackMessage;
export type SlackNotificationResult =
  | { sent: true }
  | { sent: false; reason: "not_connected" | "destination_not_configured" | "already_notified" | "window_expired" };

export async function notifySlack(
  userId: string,
  message: string,
  post: SlackPost = postSlackMessage,
  channelId = process.env.SLACK_NOTIFICATION_CHANNEL_ID?.trim(),
): Promise<SlackNotificationResult> {
  const connection = await prisma.slackConnection.findUnique({
    where: { userId },
    select: { accessToken: true },
  });
  if (!connection) return { sent: false, reason: "not_connected" };
  if (!channelId) return { sent: false, reason: "destination_not_configured" };
  if (!message.trim()) throw new Error("Slack notification message is required");
  await post(connection.accessToken, channelId, message.slice(0, 4000));
  return { sent: true };
}

/** Sends at most one rate-limit alert per sender and UTC-hour window. */
export async function notifySlackRateLimitOnce(
  userId: string,
  senderId: string,
  windowStart: Date,
  windowEnd: Date,
  post: SlackPost = postSlackMessage,
  channelId = process.env.SLACK_NOTIFICATION_CHANNEL_ID?.trim(),
): Promise<SlackNotificationResult> {
  const connection = await prisma.slackConnection.findUnique({
    where: { userId },
    select: { accessToken: true },
  });
  if (!connection) return { sent: false, reason: "not_connected" };
  if (!channelId) return { sent: false, reason: "destination_not_configured" };
  if (!senderId.trim() || !Number.isFinite(windowStart.getTime()) || !Number.isFinite(windowEnd.getTime())) {
    throw new Error("Rate-limit alert details are invalid");
  }

  const ttlSeconds = Math.ceil((windowEnd.getTime() - Date.now()) / 1000);
  if (ttlSeconds < 1) return { sent: false, reason: "window_expired" };

  const key = `${RATE_LIMIT_ALERT_KEY_PREFIX}${senderId}:${windowStart.getTime()}`;
  const claimed = await getAlertRedis().set(key, "1", "EX", ttlSeconds, "NX");
  if (claimed !== "OK") return { sent: false, reason: "already_notified" };

  const message = `Hourly email limit reached for sender ${senderId}. Further emails are paused until ${windowEnd.toISOString()}.`;
  // Keep the deduplication key even if Slack is temporarily unavailable so a
  // burst of deferred jobs cannot flood the workspace with repeated alerts.
  await post(connection.accessToken, channelId, message);
  return { sent: true };
}

export async function closeSlackNotifierRedis(): Promise<void> {
  if (alertRedis) {
    await alertRedis.quit();
    alertRedis = undefined;
  }
}
