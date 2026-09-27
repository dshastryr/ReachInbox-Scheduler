import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma";
import { scheduleCampaignEmailJobs } from "./campaign-scheduler";

export interface CreateCampaignScheduleInput {
  requestId: string;
  senderId: string;
  name: string | null;
  subject: string;
  body: string;
  recipients: string[];
  startAt: Date;
  delayMs: number;
  hourlyLimit: number;
}

export class ScheduleConflictError extends Error {}

function keyFor(userId: string, requestId: string, recipient: string): string {
  return createHash("sha256").update(`${userId}:${requestId}:${recipient}`).digest("hex");
}

function sameRecipients(existing: Array<{ recipientEmail: string; senderId: string }>, recipients: string[], senderId: string): boolean {
  const fromDatabase = existing.map((job) => job.recipientEmail).sort();
  const requested = [...recipients].sort();
  return existing.every((job) => job.senderId === senderId) &&
    fromDatabase.length === requested.length &&
    fromDatabase.every((email, index) => email === requested[index]);
}

/** Database writes are atomic; deterministic campaign/job identifiers make retries safe. */
export async function createAndScheduleCampaign(userId: string, input: CreateCampaignScheduleInput) {
  const result = await prisma.$transaction(async (tx) => {
    const ownedSender = await tx.sender.findFirst({ where: { id: input.senderId, userId }, select: { id: true } });
    if (!ownedSender) throw new ScheduleConflictError("Sender not found");

    const existing = await tx.campaign.findUnique({
      where: { id: input.requestId },
      include: { emailJobs: { select: { recipientEmail: true, senderId: true } } },
    });
    if (existing) {
      const sameRequest = existing.userId === userId && existing.name === input.name &&
        existing.subject === input.subject && existing.body === input.body &&
        existing.startAt.getTime() === input.startAt.getTime() &&
        existing.delayMs === input.delayMs && existing.hourlyLimit === input.hourlyLimit &&
        sameRecipients(existing.emailJobs, input.recipients, input.senderId);
      if (!sameRequest) throw new ScheduleConflictError("This request ID was already used for a different schedule");
      return { campaign: existing, created: false };
    }

    const campaign = await tx.campaign.create({
      data: {
        id: input.requestId,
        userId,
        name: input.name,
        subject: input.subject,
        body: input.body,
        startAt: input.startAt,
        delayMs: input.delayMs,
        hourlyLimit: input.hourlyLimit,
        emailJobs: {
          create: input.recipients.map((recipientEmail) => ({
            userId,
            senderId: input.senderId,
            recipientEmail,
            subject: input.subject,
            body: input.body,
            scheduledAt: input.startAt,
            idempotencyKey: keyFor(userId, input.requestId, recipientEmail),
          })),
        },
      },
      include: { emailJobs: { select: { id: true, recipientEmail: true, scheduledAt: true, status: true } } },
    });
    return { campaign, created: true };
  });

  // BullMQ uses each EmailJob UUID as its deterministic job ID. Retrying this
  // call after a partial Redis outage will re-use existing jobs and enqueue gaps.
  const scheduledJobs = await scheduleCampaignEmailJobs(result.campaign.id);
  return {
    campaign: {
      id: result.campaign.id,
      name: result.campaign.name,
      subject: result.campaign.subject,
      body: result.campaign.body,
      startAt: result.campaign.startAt,
      delayMs: result.campaign.delayMs,
      hourlyLimit: result.campaign.hourlyLimit,
      createdAt: result.campaign.createdAt,
      updatedAt: result.campaign.updatedAt,
    },
    created: result.created,
    jobs: scheduledJobs,
  };
}
