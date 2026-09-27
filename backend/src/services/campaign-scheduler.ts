import type { Campaign, EmailJob } from "../generated/prisma/client";
import { prisma } from "../lib/prisma";
import { emailQueue } from "../lib/queue";
import { scheduleEmailJob } from "./email-scheduler";

const HOUR_MS = 60 * 60 * 1000;

export type CampaignScheduleSettings = Pick<Campaign, "startAt" | "delayMs" | "hourlyLimit">;
export type CampaignEmail = Pick<EmailJob, "id" | "createdAt">;

/** Returns deterministic send slots for jobs ordered by creation time then ID. */
export function calculateCampaignSchedule(
  campaign: CampaignScheduleSettings,
  jobs: CampaignEmail[],
  now: Date = new Date(),
): Date[] {
  if (!Number.isFinite(campaign.startAt.getTime())) {
    throw new Error("campaign.startAt must be a valid Date");
  }
  if (!Number.isInteger(campaign.delayMs) || campaign.delayMs < 0) {
    throw new Error("campaign.delayMs must be a non-negative integer");
  }
  if (!Number.isInteger(campaign.hourlyLimit) || campaign.hourlyLimit < 1) {
    throw new Error("campaign.hourlyLimit must be a positive integer");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("now must be a valid Date");
  }

  const rateLimitSpacingMs = Math.ceil(HOUR_MS / campaign.hourlyLimit);
  const spacingMs = Math.max(campaign.delayMs, rateLimitSpacingMs);
  const firstSlotMs = Math.max(campaign.startAt.getTime(), now.getTime());
  const orderedJobs = [...jobs].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );

  return orderedJobs.map((_, index) => new Date(firstSlotMs + index * spacingMs));
}

/** Schedules the currently pending EmailJobs for one campaign into BullMQ. */
export async function scheduleCampaignEmailJobs(
  campaignId: string,
): Promise<Array<{ emailJobId: string; scheduledAt: Date; bullJobId: string }>> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      emailJobs: {
        where: { status: "SCHEDULED" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  });

  if (!campaign) {
    throw new Error("Campaign not found");
  }

  const now = new Date();
  const schedule = calculateCampaignSchedule(campaign, campaign.emailJobs, now);
  const results: Array<{ emailJobId: string; scheduledAt: Date; bullJobId: string }> = [];

  for (const [index, emailJob] of campaign.emailJobs.entries()) {
    // Preserve an existing queue entry's timing when this service is retried.
    const existing = await emailQueue.getJob(emailJob.id);
    if (existing) {
      results.push({
        emailJobId: emailJob.id,
        scheduledAt: emailJob.scheduledAt,
        bullJobId: String(existing.id),
      });
      continue;
    }

    const scheduledAt = schedule[index];
    const queueJob = await scheduleEmailJob(emailJob.id, scheduledAt);
    await prisma.emailJob.update({
      where: { id: emailJob.id },
      data: { scheduledAt, bullJobId: emailJob.id },
    });
    results.push({ emailJobId: emailJob.id, scheduledAt, bullJobId: String(queueJob.id) });
  }

  return results;
}
