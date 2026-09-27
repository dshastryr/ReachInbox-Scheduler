import "dotenv/config";
import { ensureEmailJobsIndex, getElasticsearchClient } from "../lib/elasticsearch";

async function main(): Promise<void> {
  const client = getElasticsearchClient();
  try {
    await client.ping();
    await ensureEmailJobsIndex(client);
    console.log("Elasticsearch is reachable; email-jobs index is ready");
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(`Elasticsearch initialization failed (${error instanceof Error ? error.name : "Error"})`);
  process.exitCode = 1;
});
