import type { Client } from "@elastic/elasticsearch";
import type { EmailJobStatus } from "../generated/prisma/client";
import { EMAIL_JOBS_INDEX, ensureEmailJobsIndex, getElasticsearchClient } from "../lib/elasticsearch";
import { prisma } from "../lib/prisma";

export interface EmailSearchDocument {
  id: string;
  userId: string;
  status: EmailJobStatus;
  sender: { id: string; name: string; email: string };
  recipientEmail: string;
  subject: string;
  body: string;
  campaignId: string | null;
  campaign: { id: string; name: string | null } | null;
  scheduledAt: string;
  sentAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailSearchHit extends Omit<EmailSearchDocument, "userId"> {}

export async function indexEmailJob(emailJobId: string, esClient: Client = getElasticsearchClient()): Promise<void> {
  const emailJob = await prisma.emailJob.findUnique({
    where: { id: emailJobId },
    select: {
      id: true,
      userId: true,
      status: true,
      recipientEmail: true,
      subject: true,
      body: true,
      campaignId: true,
      scheduledAt: true,
      sentAt: true,
      failedAt: true,
      failureReason: true,
      createdAt: true,
      updatedAt: true,
      sender: { select: { id: true, name: true, email: true } },
      campaign: { select: { id: true, name: true } },
    },
  });

  if (!emailJob) throw new Error("EmailJob not found for indexing");
  if (emailJob.status !== "SENT" || !emailJob.sentAt) {
    throw new Error("Only successfully sent EmailJobs can be indexed");
  }

  const document: EmailSearchDocument = {
    id: emailJob.id,
    userId: emailJob.userId,
    status: emailJob.status,
    sender: emailJob.sender,
    recipientEmail: emailJob.recipientEmail,
    subject: emailJob.subject,
    body: emailJob.body,
    campaignId: emailJob.campaignId,
    campaign: emailJob.campaign,
    scheduledAt: emailJob.scheduledAt.toISOString(),
    sentAt: emailJob.sentAt.toISOString(),
    failedAt: emailJob.failedAt?.toISOString() ?? null,
    failureReason: emailJob.failureReason,
    createdAt: emailJob.createdAt.toISOString(),
    updatedAt: emailJob.updatedAt.toISOString(),
  };

  await ensureEmailJobsIndex(esClient);
  await esClient.index({
    index: EMAIL_JOBS_INDEX,
    id: emailJob.id,
    document,
  });
}

export async function searchEmailJobs(
  userId: string,
  query?: string,
  esClient: Client = getElasticsearchClient(),
): Promise<{ total: number; items: EmailSearchHit[] }> {
  const cleanedQuery = query?.trim();
  const response = await esClient.search<EmailSearchDocument>({
    index: EMAIL_JOBS_INDEX,
    size: 50,
    query: {
      bool: {
        filter: [{ term: { userId } }, { term: { status: "SENT" } }],
        ...(cleanedQuery
          ? {
              must: [
                {
                  multi_match: {
                    query: cleanedQuery,
                    fields: [
                      "id",
                      "subject^3",
                      "recipientEmail",
                      "recipientEmail.keyword",
                      "sender.name",
                      "sender.email",
                      "sender.email.keyword",
                      "campaign.name",
                      "campaignId",
                      "campaign.id",
                      "body",
                    ],
                    type: "best_fields",
                  },
                },
              ],
            }
          : {}),
      },
    },
    sort: [{ sentAt: { order: "desc", missing: "_last" } }, { createdAt: { order: "desc" } }],
  });

  const total = typeof response.hits.total === "number" ? response.hits.total : response.hits.total?.value ?? 0;
  const items = response.hits.hits.flatMap((hit) => {
    if (!hit._source) return [];
    const { userId: _ownerId, ...safeDocument } = hit._source;
    return [safeDocument];
  });
  return { total, items };
}
