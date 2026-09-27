import "dotenv/config";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { QueueEvents } from "bullmq";
import { prisma } from "../lib/prisma";
import { emailQueue, getRedisConnectionOptions } from "../lib/queue";
import { closeAuthSessionRedis, createBrowserSession, getBrowserSessionTTL, revokeBrowserSession, SESSION_TTL_SECONDS } from "../lib/auth-session";
import authRouter from "../routes/auth";
import campaignsRouter from "../routes/campaigns";
import emailsRouter from "../routes/emails";
import { createEmailWorker } from "../workers/email.worker";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Auth/scheduling test failed: ${message}`);
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function main(): Promise<void> {
  const priorNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const tag = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const sessionIds: string[] = [];
  const senderIds: string[] = [];
  const campaignIds: string[] = [];
  const queueJobIds: string[] = [];
  let server: Server | undefined;
  let worker: ReturnType<typeof createEmailWorker> | undefined;
  let queueEvents: QueueEvents | undefined;

  try {
    const pending = await emailQueue.getJobs(["waiting", "active", "delayed"], 0, 999, true);
    const pendingIds = pending.map((job) => job.data.emailJobId);
    const pendingRows = pendingIds.length ? await prisma.emailJob.findMany({
      where: { id: { in: pendingIds } }, select: { id: true, status: true, sentAt: true },
    }) : [];
    const byId = new Map(pendingRows.map((row) => [row.id, row]));
    assert(pending.every((job) => {
      const row = byId.get(job.data.emailJobId);
      return row?.status === "SENT" || row?.sentAt !== null || !row;
    }), "unrelated pending queue work exists; refusing to start a test worker");

    const user = await prisma.user.create({ data: { name: `Schedule Test ${tag}`, email: `schedule-${tag}@example.test` }, select: { id: true } });
    userIds.push(user.id);
    const otherUser = await prisma.user.create({ data: { name: `Other Schedule ${tag}`, email: `other-schedule-${tag}@example.test` }, select: { id: true } });
    userIds.push(otherUser.id);

    const smtpHost = process.env.SMTP_HOST?.trim() || "smtp.example.invalid";
    const smtpPort = Number(process.env.SMTP_PORT) || 587;
    const smtpUser = process.env.SMTP_USER?.trim() || `test-${tag}@example.test`;
    const smtpPassword = process.env.SMTP_PASSWORD || "test-only-placeholder";
    const sender = await prisma.sender.create({
      data: { userId: user.id, name: "Scheduling Test Sender", email: smtpUser, smtpHost, smtpPort, smtpUser, smtpPassword },
      select: { id: true },
    });
    senderIds.push(sender.id);
    const otherSender = await prisma.sender.create({
      data: { userId: otherUser.id, name: "Other Test Sender", email: `other-${tag}@example.test`, smtpHost: "not-used.invalid", smtpPort: 587, smtpUser: "not-used", smtpPassword: "test-only-placeholder" },
      select: { id: true },
    });
    senderIds.push(otherSender.id);

    const sessionId = await createBrowserSession(user.id);
    const otherSessionId = await createBrowserSession(otherUser.id);
    sessionIds.push(sessionId, otherSessionId);
    assert(sessionId.length === 43 && SESSION_TTL_SECONDS >= 60 * 60, "session uses a random ID and reasonable expiry");
    const sessionTtl = await getBrowserSessionTTL(sessionId);
    assert(sessionTtl > 0 && sessionTtl <= SESSION_TTL_SECONDS, "Redis session expires within its configured lifetime");

    const app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    app.use("/api/campaigns", campaignsRouter);
    app.use("/api/emails", emailsRouter);
    server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address !== null && typeof address !== "string", "test API should listen");
    const base = `http://127.0.0.1:${address.port}`;
    const cookie = `reachinbox_session=${sessionId}`;
    const otherCookie = `reachinbox_session=${otherSessionId}`;

    const unauthenticated = await fetch(`${base}/api/auth/me`);
    assert(unauthenticated.status === 401, "auth/me must reject unauthenticated requests");
    const headerOnly = await fetch(`${base}/api/auth/me`, { headers: { "x-user-id": user.id } });
    assert(headerOnly.status === 401, "production authentication must ignore x-user-id");
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    const meBody = await me.json() as { id: string; email: string };
    assert(me.status === 200 && meBody.id === user.id, "cookie session resolves the authenticated user");
    const noAuthCampaigns = await fetch(`${base}/api/campaigns`);
    assert(noAuthCampaigns.status === 401, "campaign API must reject unauthenticated browser requests");
    console.log("PASS A-C: browser requests authenticate through HTTP-only session cookies; production ignores x-user-id");

    const requestId = randomUUID();
    const recipients = [`ethereal-${tag}@example.test`, `ETHEREAL-${tag}@example.test`, `second-${tag}@example.test`];
    const startAt = new Date(Date.now() + 15_000).toISOString();
    const payload = {
      requestId,
      senderId: sender.id,
      name: `Compose Test ${tag}`,
      subject: "Controlled scheduler integration test",
      body: "This test message is used only with an Ethereal test sender.",
      recipients,
      startAt,
      delayMs: 1000,
      hourlyLimit: 3600,
    };

    const invalid = await fetch(`${base}/api/campaigns/schedule`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ ...payload, recipients: ["bad-address"] }),
    });
    assert(invalid.status === 400, "invalid recipient addresses must be rejected");
    const invalidDate = await fetch(`${base}/api/campaigns/schedule`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ ...payload, startAt: "not-a-date" }),
    });
    assert(invalidDate.status === 400, "invalid scheduling date must be rejected");
    const invalidDelay = await fetch(`${base}/api/campaigns/schedule`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ ...payload, delayMs: -1 }),
    });
    assert(invalidDelay.status === 400, "negative delay must be rejected");
    const invalidLimit = await fetch(`${base}/api/campaigns/schedule`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ ...payload, hourlyLimit: 0 }),
    });
    assert(invalidLimit.status === 400, "zero hourly limit must be rejected");

    const forbiddenSender = await fetch(`${base}/api/campaigns/schedule`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ ...payload, requestId: randomUUID(), senderId: otherSender.id }),
    });
    assert(forbiddenSender.status === 404, "user cannot schedule through another user's sender");

    const response = await fetch(`${base}/api/campaigns/schedule`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    const result = await response.json() as {
      campaign: { id: string; name: string | null };
      created: boolean;
      deduplicatedRecipientCount: number;
      jobs: Array<{ emailJobId: string; scheduledAt: string; bullJobId: string }>;
    };
    campaignIds.push(requestId);
    assert(response.status === 201 && result.created, "valid compose request should create campaign and enqueue jobs");
    assert(result.jobs.length === 2 && result.deduplicatedRecipientCount === 1, "case-insensitive duplicate recipients are removed");
    campaignIds.push(result.campaign.id);
    queueJobIds.push(...result.jobs.map((job) => job.emailJobId));
    assert(result.jobs.every((job) => job.bullJobId === job.emailJobId), "BullMQ identifiers are deterministic EmailJob IDs");
    const spacing = new Date(result.jobs[1].scheduledAt).getTime() - new Date(result.jobs[0].scheduledAt).getTime();
    assert(spacing === 1000, "campaign scheduler applies max(delayMs, hourly-limit spacing)");

    const dbJobs = await prisma.emailJob.findMany({
      where: { campaignId: result.campaign.id },
      select: { id: true, userId: true, campaignId: true, senderId: true, recipientEmail: true, status: true, idempotencyKey: true },
      orderBy: { recipientEmail: "asc" },
    });
    assert(dbJobs.length === 2 && dbJobs.every((job) => job.userId === user.id && job.senderId === sender.id && job.campaignId === result.campaign.id), "EmailJobs belong to authenticated user, campaign, and sender");
    assert(new Set(dbJobs.map((job) => job.idempotencyKey)).size === 2, "each recipient job has a unique idempotency key");
    const queueJobs = await Promise.all(dbJobs.map((job) => emailQueue.getJob(job.id)));
    assert(queueJobs.every((job) => job !== undefined), "all EmailJobs have BullMQ queue entries");
    console.log("PASS D-G: scheduling validates ownership, deduplicates leads, atomically creates campaign/jobs, and enqueues deterministic BullMQ jobs");

    const retry = await fetch(`${base}/api/campaigns/schedule`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    const retryResult = await retry.json() as typeof result;
    assert(retry.status === 200 && !retryResult.created && retryResult.jobs.length === 2, "same request ID safely retries without duplicates");
    const conflict = await fetch(`${base}/api/campaigns/schedule`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ ...payload, subject: "Different request body" }),
    });
    assert(conflict.status === 409, "reused request ID with changed content must conflict");
    assert(await prisma.emailJob.count({ where: { campaignId: result.campaign.id } }) === 2, "retry does not duplicate database EmailJobs");
    console.log("PASS H-I: repeated scheduling is idempotent; changed payload cannot reuse request ID");

    const scheduled = await fetch(`${base}/api/emails/scheduled`, { headers: { cookie } });
    const scheduledBody = await scheduled.json() as { total: number; items: Array<{ id: string; recipientEmail: string; subject: string; scheduledAt: string; status: string }> };
    assert(scheduled.status === 200 && scheduledBody.total === 2 && scheduledBody.items.length === 2, "scheduled list returns owner's jobs and total count");
    assert(scheduledBody.items.every((job) => job.status === "SCHEDULED" && job.subject === payload.subject), "scheduled response includes requested status and message fields");
    const statsResponse = await fetch(`${base}/api/emails/stats`, { headers: { cookie } });
    const stats = await statsResponse.json() as { total: number; scheduled: number; processing: number; sent: number; failed: number };
    assert(statsResponse.status === 200 && stats.total === 2 && stats.scheduled === 2 && stats.processing === 0 && stats.sent === 0 && stats.failed === 0, "email statistics should reflect only authenticated user's jobs");
    const otherScheduled = await fetch(`${base}/api/emails/scheduled`, { headers: { cookie: otherCookie } });
    const otherScheduledBody = await otherScheduled.json() as { total: number; items: unknown[] };
    assert(otherScheduled.status === 200 && otherScheduledBody.total === 0 && otherScheduledBody.items.length === 0, "scheduled list is isolated by session user");
    const otherStats = await fetch(`${base}/api/emails/stats`, { headers: { cookie: otherCookie } });
    assert((await otherStats.json() as { total: number }).total === 0, "email statistics are isolated by session user");
    const crossUserDetail = await fetch(`${base}/api/emails/${dbJobs[0].id}`, { headers: { cookie: otherCookie } });
    assert(crossUserDetail.status === 404, "email detail cannot be accessed by another user");
    console.log("PASS J-K: scheduled email list and detail enforce user ownership");

    await prisma.emailJob.update({ where: { id: dbJobs[0].id }, data: { status: "PROCESSING" } });
    const processingList = await fetch(`${base}/api/emails/scheduled`, { headers: { cookie } });
    const processingBody = await processingList.json() as { items: Array<{ id: string; status: string }> };
    assert(processingBody.items.some((job) => job.id === dbJobs[0].id && job.status === "PROCESSING"),
      "scheduled view should retain jobs while the worker is processing them");
    await prisma.emailJob.update({ where: { id: dbJobs[0].id }, data: { status: "SCHEDULED" } });

    const failedEmail = await prisma.emailJob.create({
      data: {
        userId: user.id,
        campaignId: result.campaign.id,
        senderId: sender.id,
        recipientEmail: `failed-${tag}@example.test`,
        subject: "Controlled failed delivery",
        body: "This fixture verifies failed email history.",
        scheduledAt: new Date(startAt),
        status: "FAILED",
        failedAt: new Date(),
        failureReason: "SMTP delivery failed",
        idempotencyKey: `dashboard-failed-${randomUUID()}`,
      },
      select: { id: true },
    });
    const sentList = await fetch(`${base}/api/emails/sent?userId=${otherUser.id}`, { headers: { cookie } });
    const sentListBody = await sentList.json() as { total: number; items: Array<{ id: string; status: string; failedAt: string | null; failureReason: string | null }> };
    assert(sentList.status === 200 && sentListBody.total === 1 && sentListBody.items[0]?.id === failedEmail.id,
      "sent history should include the authenticated user's failed jobs and ignore a client-supplied userId");
    assert(sentListBody.items[0].status === "FAILED" && sentListBody.items[0].failedAt && sentListBody.items[0].failureReason === "SMTP delivery failed",
      "failed history should include failure status, time, and reason");
    const otherSent = await fetch(`${base}/api/emails/sent`, { headers: { cookie: otherCookie } });
    assert((await otherSent.json() as { total: number; items: unknown[] }).total === 0,
      "sent history must not expose another user's failed jobs");
    const failedDetail = await fetch(`${base}/api/emails/${failedEmail.id}`, { headers: { cookie } });
    assert((await failedDetail.json() as { failureReason?: string }).failureReason === "SMTP delivery failed",
      "email detail should include the recorded failure reason");
    console.log("PASS K2: sent history includes FAILED details, ignores client userId, and remains user-scoped");

    const smtpIsEthereal = process.env.SMTP_HOST?.trim().toLowerCase() === "smtp.ethereal.email" &&
      Boolean(process.env.SMTP_USER?.trim() && process.env.SMTP_PASSWORD);
    if (smtpIsEthereal) {
      queueEvents = new QueueEvents("email-scheduler", { connection: getRedisConnectionOptions() });
      await queueEvents.waitUntilReady();
      worker = createEmailWorker();
      await worker.waitUntilReady();
      await Promise.all(queueJobs.map((job) => job!.waitUntilFinished(queueEvents!, 120_000)));
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const rows = await prisma.emailJob.findMany({ where: { id: { in: queueJobIds } }, select: { status: true, sentAt: true } });
        if (rows.length === queueJobIds.length && rows.every((row) => row.status === "SENT" && row.sentAt !== null)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const finalRows = await prisma.emailJob.findMany({ where: { id: { in: queueJobIds } }, select: { status: true, sentAt: true } });
      const finalQueue = await Promise.all(queueJobIds.map((id) => emailQueue.getJob(id)));
      assert(finalRows.length === 2 && finalRows.every((row) => row.status === "SENT" && row.sentAt), "Ethereal worker should mark both jobs SENT");
      assert((await Promise.all(finalQueue.map((job) => job?.getState()))).every((jobState) => jobState === "completed"), "Ethereal BullMQ jobs should complete");
      console.log("PASS L: controlled Ethereal worker delivered scheduled jobs, persisted SENT, and completed BullMQ jobs");
      const finalSentList = await fetch(`${base}/api/emails/sent`, { headers: { cookie } });
      const finalSentBody = await finalSentList.json() as { total: number; items: Array<{ status: string }> };
      assert(finalSentList.status === 200 && finalSentBody.total === 3 &&
        finalSentBody.items.filter((job) => job.status === "SENT").length === 2 &&
        finalSentBody.items.filter((job) => job.status === "FAILED").length === 1,
      "sent history should reflect worker-delivered jobs alongside failed records");
      console.log("PASS M: sent history refresh exposes SENT and FAILED worker outcomes");
    } else {
      console.log("SKIP L: SMTP is not configured for the controlled Ethereal test host; jobs remain scheduled in Redis");
    }
  } finally {
    if (worker) await worker.close();
    if (queueEvents) await queueEvents.close();
    await closeServer(server);
    if (campaignIds.length) {
      const associatedJobs = await prisma.emailJob.findMany({ where: { campaignId: { in: campaignIds } }, select: { id: true } });
      queueJobIds.push(...associatedJobs.map((job) => job.id));
    }
    for (const sessionId of sessionIds) await revokeBrowserSession(sessionId);
    for (const id of queueJobIds) {
      const job = await emailQueue.getJob(id);
      if (job) await job.remove().catch(() => undefined);
    }
    if (campaignIds.length) await prisma.emailJob.deleteMany({ where: { campaignId: { in: campaignIds } } });
    if (campaignIds.length) await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    if (senderIds.length) await prisma.sender.deleteMany({ where: { id: { in: senderIds } } });
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await emailQueue.close();
    await closeAuthSessionRedis();
    await prisma.$disconnect();
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown failure";
  const redacted = [process.env.SMTP_PASSWORD, process.env.DATABASE_URL, process.env.REDIS_URL]
    .filter((value): value is string => Boolean(value))
    .reduce((safe, value) => safe.split(value).join("[redacted]"), message);
  console.error(`Auth/scheduling test failed: ${redacted}`);
  process.exitCode = 1;
});
