import "dotenv/config";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { emailQueue, EMAIL_QUEUE_NAME } from "../lib/queue";
import queueDashboardRouter from "../routes/queue-dashboard";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Queue dashboard test failed: ${message}`);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function main(): Promise<void> {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const app = express();
  app.use("/admin/queues", queueDashboardRouter);
  const server = createServer(app);

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address !== null && typeof address !== "string", "test server should listen");
    const base = `http://127.0.0.1:${address.port}/admin/queues`;

    const denied = await fetch(base, { redirect: "manual" });
    assert(denied.status === 401, "unauthenticated dashboard requests must be rejected");
    console.log("PASS A: dashboard is protected by existing authentication");

    const headers = { "x-user-id": "00000000-0000-4000-8000-000000000001" };
    const page = await fetch(base, { headers });
    const html = await page.text();
    assert(page.status === 200 && html.includes("Bull Dashboard"), "authenticated request should load Bull Board");
    console.log("PASS B: authenticated request loads the dashboard page");

    const response = await fetch(`${base}/api/queues`, { headers });
    const payload = await response.json() as { queues?: Array<{ name?: string; readOnlyMode?: boolean; counts?: Record<string, number> }> };
    const queue = payload.queues?.find((item) => item.name === EMAIL_QUEUE_NAME);
    assert(response.status === 200 && queue, "dashboard API should expose the real email-scheduler queue");
    assert(queue.readOnlyMode === true, "dashboard queue should be read-only");
    assert(queue.counts && ["waiting", "active", "delayed", "completed", "failed"].every((state) => state in queue.counts!),
      "dashboard should expose the required queue state counts");
    console.log("PASS C: live API reports email-scheduler state counts in read-only mode");
  } finally {
    await closeServer(server);
    await emailQueue.close();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Queue dashboard test failed");
  process.exitCode = 1;
});
