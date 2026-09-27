import "dotenv/config";
import { Client } from "@elastic/elasticsearch";

export const EMAIL_JOBS_INDEX = "email-jobs";

let client: Client | undefined;

export function getElasticsearchClient(): Client {
  if (client) return client;

  const configuredUrl = process.env.ELASTICSEARCH_URL?.trim();
  if (!configuredUrl) {
    throw new Error("ELASTICSEARCH_URL must be set to connect to Elasticsearch");
  }

  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error("ELASTICSEARCH_URL must be a valid URL");
  }

  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new Error("ELASTICSEARCH_URL must use http:// or https:// and include a hostname");
  }

  client = new Client({ node: url.toString() });
  return client;
}

export function createElasticsearchClient(url: string): Client {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Elasticsearch test URL must be valid");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    throw new Error("Elasticsearch test URL must use http:// or https:// and include a hostname");
  }
  return new Client({ node: parsed.toString(), maxRetries: 0, requestTimeout: 1000 });
}

export const emailJobsMappings = {
  dynamic: "strict",
  properties: {
    id: { type: "keyword" },
    userId: { type: "keyword" },
    status: { type: "keyword" },
    sender: {
      properties: {
        id: { type: "keyword" },
        name: { type: "text", fields: { keyword: { type: "keyword" } } },
        email: { type: "text", fields: { keyword: { type: "keyword" } } },
      },
    },
    recipientEmail: { type: "text", fields: { keyword: { type: "keyword" } } },
    subject: { type: "text", fields: { keyword: { type: "keyword" } } },
    body: { type: "text" },
    campaignId: { type: "keyword" },
    campaign: {
      properties: {
        id: { type: "keyword" },
        name: { type: "text", fields: { keyword: { type: "keyword" } } },
      },
    },
    scheduledAt: { type: "date" },
    sentAt: { type: "date" },
    failedAt: { type: "date" },
    failureReason: { type: "text" },
    createdAt: { type: "date" },
    updatedAt: { type: "date" },
  },
} as const;

export async function ensureEmailJobsIndex(esClient: Client = getElasticsearchClient()): Promise<void> {
  const exists = await esClient.indices.exists({ index: EMAIL_JOBS_INDEX });
  if (exists) return;

  try {
    await esClient.indices.create({
      index: EMAIL_JOBS_INDEX,
      mappings: emailJobsMappings,
    });
  } catch (error) {
    const statusCode = (error as { meta?: { statusCode?: number } })?.meta?.statusCode;
    if (statusCode === 400 && (await esClient.indices.exists({ index: EMAIL_JOBS_INDEX }))) {
      return;
    }
    throw error;
  }
}
