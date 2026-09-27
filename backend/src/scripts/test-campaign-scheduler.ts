import { randomUUID } from "node:crypto";
import { emailQueue } from "../lib/queue";
import {
  calculateCampaignSchedule,
} from "../services/campaign-scheduler";
import { calculateBullMqDelay, scheduleEmailJob } from "../services/email-scheduler";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Campaign scheduler test failed: ${message}`);
  }
}

function assertSpacing(actual: Date[], expectedMs: number, label: string): void {
  for (let index = 1; index < actual.length; index += 1) {
    const spacing = actual[index].getTime() - actual[index - 1].getTime();
    assert(spacing === expectedMs, `${label}: expected ${expectedMs}ms, received ${spacing}ms`);
  }
}

async function main(): Promise<void> {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const jobs = [0, 1, 2].map((index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    createdAt: new Date(now.getTime() + index),
  }));
  const base = { startAt: new Date(now.getTime() + 30_000), delayMs: 5_000, hourlyLimit: 1000 };

  const delaySlots = calculateCampaignSchedule(base, jobs, now);
  assert(delaySlots[0].getTime() === base.startAt.getTime(), "first email must not precede startAt");
  assertSpacing(delaySlots, 5_000, "A delay test");
  console.log("PASS A: first slot honors startAt; subsequent slots are 5,000ms apart");

  const hourlySlots = calculateCampaignSchedule({ ...base, delayMs: 0, hourlyLimit: 10 }, jobs, now);
  assertSpacing(hourlySlots, 360_000, "B hourly limit");
  console.log("PASS B: hourlyLimit 10 spaces jobs 360,000ms (6 minutes) apart");

  const combinedSlots = calculateCampaignSchedule({ ...base, delayMs: 120_000, hourlyLimit: 60 }, jobs, now);
  assertSpacing(combinedSlots, 120_000, "C combined constraint");
  console.log("PASS C: delayMs dominates at 120,000ms");

  const lowerLimitSlots = calculateCampaignSchedule({ ...base, delayMs: 1_000, hourlyLimit: 2 }, jobs, now);
  assertSpacing(lowerLimitSlots, 1_800_000, "D low hourly limit");
  console.log("PASS D: hourlyLimit 2 spaces jobs 1,800,000ms (30 minutes) apart");

  const pastSlots = calculateCampaignSchedule({ ...base, startAt: new Date(now.getTime() - 60_000) }, jobs, now);
  assert(pastSlots[0].getTime() === now.getTime(), "past campaign must begin immediately");
  assert(calculateBullMqDelay(pastSlots[0], now) === 0, "past/immediate schedule must clamp to zero delay");
  assert(calculateBullMqDelay(new Date(now.getTime() - 1), now) === 0, "past dates must never have negative delay");
  console.log("PASS F: past startAt is handled immediately with a non-negative delay");

  // A long-lived delayed probe verifies the configured queue writes to Redis
  // and that a repeated enqueue with the same EmailJob UUID stays idempotent.
  // The UUID is intentionally not backed by an EmailJob, so no real email can
  // be sent by this verification job.
  const probeId = randomUUID();
  const probeAt = new Date(Date.now() + 15 * 60 * 1000);
  const first = await scheduleEmailJob(probeId, probeAt);
  const duplicate = await scheduleEmailJob(probeId, probeAt);
  assert(first.id === probeId && duplicate.id === probeId, "queue job ID must be deterministic");
  const persisted = await emailQueue.getJob(probeId);
  assert(persisted?.id === probeId, "delayed job must be present in Redis");
  const state = await persisted.getState();
  assert(state === "delayed", `probe must persist as delayed, received ${state}`);
  console.log(`PASS E: duplicate enqueue retained one deterministic BullMQ job (${probeId})`);
  console.log(`PASS 10: Redis contains that job in delayed state until ${probeAt.toISOString()}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Campaign scheduler test failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await emailQueue.close();
  });
