import "dotenv/config";
import Redis from "ioredis";
import { getRedisConnectionOptions } from "./queue";

const HOUR_MS = 60 * 60 * 1000;

// Reserve the hourly quota and minimum sender spacing together. Lua makes the
// checks and reservations indivisible across all worker instances.
const RESERVE_SLOT_SCRIPT = `
local clock = redis.call("TIME")
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local count = tonumber(redis.call("GET", KEYS[1]) or "0")
local limit = tonumber(ARGV[1])
local minimumDelay = tonumber(ARGV[3])

if minimumDelay > 0 then
  local nextAllowed = tonumber(redis.call("GET", KEYS[2]) or "0")
  if now < nextAllowed then
    return { 0, nextAllowed, 2 }
  end
end

if count >= limit then
  return { 0, tonumber(ARGV[2]) * 1000, 1 }
end
count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIREAT", KEYS[1], tonumber(ARGV[2]))
end

if minimumDelay > 0 then
  local nextAllowed = now + minimumDelay
  redis.call("SET", KEYS[2], nextAllowed, "PX", minimumDelay)
end

return { 1, 0, 0 }
`;

let redis: Redis | undefined;

function getRedis(): Redis {
  if (!redis) redis = new Redis(getRedisConnectionOptions());
  return redis;
}

export interface EmailRateLimitResult {
  allowed: boolean;
  windowStart: Date;
  nextWindowAt: Date;
  deferredUntil?: Date;
  deferredBy?: "hourly-limit" | "minimum-delay";
}

export async function reserveEmailRateLimitSlot(
  senderId: string,
  hourlyLimit: number,
  minimumDelayMs = 0,
  now = new Date(),
): Promise<EmailRateLimitResult> {
  if (!senderId.trim()) throw new Error("senderId is required for email rate limiting");
  if (!Number.isInteger(hourlyLimit) || hourlyLimit < 1) {
    throw new Error("hourlyLimit must be a positive integer");
  }
  if (!Number.isInteger(minimumDelayMs) || minimumDelayMs < 0) {
    throw new Error("minimumDelayMs must be a non-negative integer");
  }
  if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid Date");

  const windowStartMs = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  const nextWindowAt = new Date(windowStartMs + HOUR_MS);
  const rateKey = `email-rate:${senderId}:${windowStartMs}`;
  const delayKey = `email-send-delay:${senderId}`;
  const [allowedValue, deferTimestamp, deferReason] = await getRedis().eval(
    RESERVE_SLOT_SCRIPT,
    2,
    rateKey,
    delayKey,
    String(hourlyLimit),
    String(Math.ceil(nextWindowAt.getTime() / 1000)),
    String(minimumDelayMs),
  ) as [number, number, number];
  const allowed = Number(allowedValue) === 1;

  return {
    allowed,
    windowStart: new Date(windowStartMs),
    nextWindowAt,
    ...(!allowed ? {
      deferredUntil: new Date(Number(deferTimestamp)),
      deferredBy: Number(deferReason) === 2 ? "minimum-delay" as const : "hourly-limit" as const,
    } : {}),
  };
}

export async function closeEmailRateLimiterRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = undefined;
  }
}
