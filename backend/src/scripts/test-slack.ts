import "dotenv/config";
import express from "express";
import { Queue } from "bullmq";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { prisma } from "../lib/prisma";
import { emailQueue, getRedisConnectionOptions, type EmailQueueJobData } from "../lib/queue";
import {
  consumeSlackOAuthState,
  createSlackOAuthState,
  getSlackOAuthStateKey,
  getSlackStateRedis,
  SLACK_OAUTH_STATE_TTL_SECONDS,
  SLACK_OAUTH_SCOPES,
} from "../lib/slack";
import { createSlackRouter } from "../routes/slack";
import { processEmailJob } from "../services/process-email-job";
import { notifySlack } from "../services/slack-notifier";
import { closeSlackNotifierRedis, notifySlackRateLimitOnce } from "../services/slack-notifier";
import { reserveEmailRateLimitSlot, closeEmailRateLimiterRedis } from "../lib/email-rate-limiter";
import { scheduleEmailJob } from "../services/email-scheduler";
import { createEmailWorker } from "../workers/email.worker";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Slack test failed: ${message}`);
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main(): Promise<void> {
  const oldEnv = {
    clientId: process.env.SLACK_CLIENT_ID,
    clientSecret: process.env.SLACK_CLIENT_SECRET,
    redirectUri: process.env.SLACK_REDIRECT_URI,
    channelId: process.env.SLACK_NOTIFICATION_CHANNEL_ID,
    frontendUrl: process.env.FRONTEND_URL,
  };
  const realCredentialsConfigured = Boolean(oldEnv.clientId?.trim() && oldEnv.clientSecret?.trim());
  process.env.SLACK_CLIENT_ID = "slack-test-client-id";
  process.env.SLACK_CLIENT_SECRET = "slack-test-client-secret";
  process.env.SLACK_REDIRECT_URI = "http://localhost:5000/api/slack/callback";
  process.env.SLACK_NOTIFICATION_CHANNEL_ID = "C_TEST_CHANNEL";
  process.env.FRONTEND_URL = "http://localhost:5173";

  const tag = randomUUID().slice(0, 8);
  const app = express();
  app.use(express.json());
  let exchangeCalls = 0;
  app.use(
    "/api/slack",
    createSlackRouter(async (code) => {
      exchangeCalls += 1;
      assert(code === "controlled-test-code", "callback should pass OAuth code to exchange helper");
      return {
        accessToken: `xoxb-test-token-${tag}`,
        teamId: `T_${tag}`,
        teamName: `Test Workspace ${tag}`,
      };
    }),
  );
  const server = createServer(app);
  const testUserIds: string[] = [];
  const stateKeys: string[] = [];
  const limiterKeysToDelete: string[] = [];
  let emailJobId: string | undefined;
  let testQueue: Queue<EmailQueueJobData> | undefined;
  let testWorker: ReturnType<typeof createEmailWorker> | undefined;

  try {
    const userA = await prisma.user.create({
      data: { name: `Slack Test A ${tag}`, email: `slack-a-${tag}@example.test` },
      select: { id: true },
    });
    testUserIds.push(userA.id);
    const userB = await prisma.user.create({
      data: { name: `Slack Test B ${tag}`, email: `slack-b-${tag}@example.test` },
      select: { id: true },
    });
    testUserIds.push(userB.id);

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address !== null && typeof address !== "string", "test API should have a TCP address");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const missingUserResponse = await fetch(`${baseUrl}/api/slack/status`);
    assert(missingUserResponse.status === 401, "missing x-user-id must return 401");
    const invalidUserResponse = await fetch(`${baseUrl}/api/slack/status`, {
      headers: { "x-user-id": "not-a-uuid" },
    });
    assert(invalidUserResponse.status === 404, "invalid x-user-id must return 404");
    console.log("PASS A-B: missing x-user-id returns 401; invalid x-user-id returns 404");

    const statusBefore = await fetch(`${baseUrl}/api/slack/status`, {
      headers: { "x-user-id": userA.id },
    });
    const statusBeforeBody = (await statusBefore.json()) as { connected: boolean };
    assert(statusBefore.status === 200 && !statusBeforeBody.connected, "unconnected user status should be false");
    console.log("PASS C: Slack status reports disconnected before OAuth");

    const connectMissingAuth = await fetch(`${baseUrl}/api/slack/connect`);
    assert(connectMissingAuth.status === 401, "connect must require x-user-id");
    const connectResponse = await fetch(`${baseUrl}/api/slack/connect`, {
      headers: { "x-user-id": userA.id },
      redirect: "manual",
    });
    assert(connectResponse.status === 302, "connect should redirect to Slack");
    const location = connectResponse.headers.get("location");
    assert(location, "Slack authorization URL should be present");
    const authorizationUrl = new URL(location);
    const state = authorizationUrl.searchParams.get("state");
    assert(state, "OAuth URL should include state");
    assert(authorizationUrl.searchParams.get("client_id") === "slack-test-client-id", "client ID should be configured");
    assert(authorizationUrl.searchParams.get("scope") === SLACK_OAUTH_SCOPES.join(","), "only minimum chat:write scope should be requested");
    assert(!authorizationUrl.searchParams.has("client_secret"), "authorization URL must not expose client secret");
    console.log("PASS D: connect returns Slack OAuth URL with minimum chat:write scope");

    const stateKey = getSlackOAuthStateKey(state);
    stateKeys.push(stateKey);
    const storedState = await getSlackStateRedis().get(stateKey);
    const parsedState = JSON.parse(storedState ?? "{}") as { userId?: string; expiresAt?: number };
    const ttl = await getSlackStateRedis().ttl(stateKey);
    assert(parsedState.userId === userA.id, "Redis state must map to initiating user");
    assert(typeof parsedState.expiresAt === "number" && parsedState.expiresAt > Date.now(), "state should have a future expiration");
    assert(ttl > 0 && ttl <= SLACK_OAUTH_STATE_TTL_SECONDS, "Redis state should expire within ten minutes");
    console.log("PASS E: OAuth state maps to the initiating user and expires within ten minutes");

    const missingStateResponse = await fetch(`${baseUrl}/api/slack/callback`);
    assert(missingStateResponse.status === 400, "missing OAuth state should be rejected");
    const invalidStateResponse = await fetch(`${baseUrl}/api/slack/callback?state=invalid`);
    assert(invalidStateResponse.status === 400, "invalid OAuth state should be rejected");

    // Store a valid-format state with a past embedded expiry to test rejection
    // without waiting for real time to pass.
    const pastExpiryState = Buffer.from(randomUUID()).toString("base64url").slice(0, 43).padEnd(43, "A");
    const expiredKey = getSlackOAuthStateKey(pastExpiryState);
    stateKeys.push(expiredKey);
    await getSlackStateRedis().set(
      expiredKey,
      JSON.stringify({ userId: userA.id, expiresAt: Date.now() - 1000 }),
      "EX",
      SLACK_OAUTH_STATE_TTL_SECONDS,
    );
    const expiredResponse = await fetch(`${baseUrl}/api/slack/callback?state=${pastExpiryState}&error=access_denied`);
    assert(expiredResponse.status === 400, "expired OAuth state should be rejected");
    assert((await getSlackStateRedis().get(expiredKey)) === null, "expired state should be consumed");

    const callbackResponse = await fetch(
      `${baseUrl}/api/slack/callback?state=${encodeURIComponent(state)}&code=controlled-test-code`,
      { redirect: "manual" },
    );
    assert(callbackResponse.status === 302, "valid callback should redirect after storing the Slack connection");
    assert(callbackResponse.headers.get("location") === "http://localhost:5173/#integrations",
      "OAuth callback should return the user to the frontend integrations page");
    assert(exchangeCalls === 1, "controlled OAuth exchange should run once");
    console.log("PASS F: missing, invalid, and expired OAuth states are rejected; valid state is consumed once");

    const reusedStateResponse = await fetch(
      `${baseUrl}/api/slack/callback?state=${encodeURIComponent(state)}&code=controlled-test-code`,
    );
    assert(reusedStateResponse.status === 400, "reused OAuth state should be rejected");
    console.log("PASS F: OAuth state cannot be reused");

    const connectionA = await prisma.slackConnection.findUniqueOrThrow({
      where: { userId: userA.id },
      select: { accessToken: true },
    });
    const slackTokenForTest = connectionA.accessToken;
    const statusAfter = await fetch(`${baseUrl}/api/slack/status`, {
      headers: { "x-user-id": userA.id },
    });
    const statusAfterText = await statusAfter.text();
    assert(statusAfter.status === 200 && statusAfterText.includes("Test Workspace"), "status should return team information");
    assert(!statusAfterText.includes(slackTokenForTest), "status must never expose accessToken");
    assert(!statusAfterText.includes("accessToken"), "status JSON must omit accessToken field");
    console.log("PASS G: Slack status includes workspace but never accessToken");

    await prisma.slackConnection.create({
      data: { userId: userB.id, accessToken: `xoxb-user-b-${tag}`, teamId: `T_B_${tag}`, teamName: "Other Workspace" },
    });
    const disconnectResponse = await fetch(`${baseUrl}/api/slack`, {
      method: "DELETE",
      headers: { "x-user-id": userA.id },
    });
    assert(disconnectResponse.status === 204, "disconnect should delete verified user's connection");
    const remainingB = await prisma.slackConnection.findUnique({
      where: { userId: userB.id },
      select: { userId: true },
    });
    assert(remainingB?.userId === userB.id, "disconnect must leave the other user's connection intact");
    const missingDisconnect = await fetch(`${baseUrl}/api/slack`, {
      method: "DELETE",
      headers: { "x-user-id": userA.id },
    });
    assert(missingDisconnect.status === 404, "disconnect without a connection should return 404");
    console.log("PASS H: disconnect removed only the verified user's Slack connection");

    const noConnectionResult = await notifySlack(userA.id, "test notification", async () => {
      throw new Error("should not be called");
    });
    assert(!noConnectionResult.sent && noConnectionResult.reason === "not_connected", "no connection should return safe result");
    console.log("PASS I: notifier without a Slack connection returns safely");

    const testQueueName = `slack-rate-limit-test-${tag}`;
    testQueue = new Queue<EmailQueueJobData>(testQueueName, { connection: getRedisConnectionOptions() });
    async function createRateLimitedFixture(ownerId: string, suffix: string, jobCount: number) {
      const fixtureSender = await prisma.sender.create({
        data: {
          userId: ownerId,
          name: `Rate Limit Sender ${suffix}`,
          email: `rate-sender-${suffix}-${tag}@example.test`,
          smtpHost: "unused.invalid",
          smtpPort: 587,
          smtpUser: "test-user",
          smtpPassword: "test-password",
        },
        select: { id: true },
      });
      const fixtureCampaign = await prisma.campaign.create({
        data: {
          userId: ownerId,
          name: `Rate Limit Campaign ${suffix}`,
          subject: "Slack rate limit test",
          body: "Controlled fake SMTP test",
          startAt: new Date(),
          delayMs: 0,
          hourlyLimit: 1,
        },
        select: { id: true },
      });
      const reserved = await reserveEmailRateLimitSlot(fixtureSender.id, 1);
      assert(reserved.allowed, "test should consume the sender's one hourly slot before worker runs");
      limiterKeysToDelete.push(`email-rate:${fixtureSender.id}:${reserved.windowStart.getTime()}`);
      limiterKeysToDelete.push(`slack:rate-limit-alert:${fixtureSender.id}:${reserved.windowStart.getTime()}`);

      const fixtureJobs = await Promise.all(Array.from({ length: jobCount }, (_, index) =>
        prisma.emailJob.create({
          data: {
            userId: ownerId,
            senderId: fixtureSender.id,
            campaignId: fixtureCampaign.id,
            recipientEmail: `rate-recipient-${suffix}-${index}-${tag}@example.test`,
            subject: "Slack rate limit test",
            body: "Controlled fake SMTP test",
            scheduledAt: new Date(),
            idempotencyKey: randomUUID(),
          },
          select: { id: true },
        }),
      ));
      await Promise.all(fixtureJobs.map((job) => scheduleEmailJob(job.id, new Date(), testQueue!)));
      return { senderId: fixtureSender.id, windowStart: reserved.windowStart, windowEnd: reserved.nextWindowAt, jobs: fixtureJobs };
    }

    async function assertJobsRemainDelayed(jobIds: string[]): Promise<void> {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const states = await Promise.all(jobIds.map(async (id) => {
          const [row, queueJob] = await Promise.all([
            prisma.emailJob.findUnique({ where: { id }, select: { status: true, scheduledAt: true } }),
            testQueue!.getJob(id),
          ]);
          return row?.status === "SCHEDULED" && row.scheduledAt > new Date() &&
            (await queueJob?.getState()) === "delayed" && queueJob?.attemptsMade === 0;
        }));
        if (states.every(Boolean)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Rate-limited Slack test jobs did not remain delayed and scheduled");
    }

    const noSlackFixture = await createRateLimitedFixture(userA.id, "disconnected", 1);
    let disconnectedPostCalls = 0;
    testWorker = createEmailWorker(
      async () => { throw new Error("SMTP must not run for a rate-limited job"); },
      async () => {},
      async () => ({ sent: false, reason: "not_connected" }),
      testQueueName,
      (ownerId, senderId, windowStart, windowEnd) => notifySlackRateLimitOnce(
        ownerId, senderId, windowStart, windowEnd,
        async () => { disconnectedPostCalls += 1; },
        "C_TEST_CHANNEL",
      ),
    );
    await testWorker.waitUntilReady();
    await assertJobsRemainDelayed(noSlackFixture.jobs.map((job) => job.id));
    assert(disconnectedPostCalls === 0, "disconnected Slack must not make a Slack API call");
    await testWorker.close();
    testWorker = undefined;
    console.log("PASS K: disconnected user's rate-limited job remained delayed without a Slack call");

    const reconnectStart = await fetch(`${baseUrl}/api/slack/connect`, {
      headers: { "x-user-id": userA.id }, redirect: "manual",
    });
    const reconnectUrl = new URL(reconnectStart.headers.get("location") ?? "");
    const reconnectState = reconnectUrl.searchParams.get("state");
    assert(reconnectStart.status === 302 && reconnectState, "disconnected user should be able to start OAuth reconnect");
    stateKeys.push(getSlackOAuthStateKey(reconnectState!));
    const reconnectCallback = await fetch(
      `${baseUrl}/api/slack/callback?state=${encodeURIComponent(reconnectState!)}&code=controlled-test-code`,
      { redirect: "manual" },
    );
    assert(reconnectCallback.status === 302 && Number(exchangeCalls) === 2, "reconnect should store a fresh OAuth connection without restart");

    const connectedFixture = await createRateLimitedFixture(userA.id, "connected", 2);
    let connectedPostCalls = 0;
    testWorker = createEmailWorker(
      async () => { throw new Error("SMTP must not run for a rate-limited job"); },
      async () => {},
      async () => ({ sent: false, reason: "not_connected" }),
      testQueueName,
      (ownerId, senderId, windowStart, windowEnd) => notifySlackRateLimitOnce(
        ownerId, senderId, windowStart, windowEnd,
        async (token, channel, message) => {
          assert(ownerId === userA.id, "rate-limit notification must use the email owner's user ID");
          assert(token === `xoxb-test-token-${tag}`, "notifier must use the connected user's stored token");
          assert(channel === "C_TEST_CHANNEL" && message.includes(connectedFixture.senderId),
            "Slack call should target the configured channel and identify the limited sender");
          connectedPostCalls += 1;
        },
        "C_TEST_CHANNEL",
      ),
    );
    await testWorker.waitUntilReady();
    await assertJobsRemainDelayed(connectedFixture.jobs.map((job) => job.id));
    assert(Number(connectedPostCalls) === 1, "concurrent rate-limit hits should produce one alert per sender/hour");
    await testWorker.close();
    testWorker = undefined;
    console.log("PASS L: reconnect enabled one user-scoped Slack API notification for concurrent rate-limit hits");

    const failingFixture = await createRateLimitedFixture(userA.id, "slack-failure", 1);
    testWorker = createEmailWorker(
      async () => { throw new Error("SMTP must not run for a rate-limited job"); },
      async () => {},
      async () => ({ sent: false, reason: "not_connected" }),
      testQueueName,
      (ownerId, senderId, windowStart, windowEnd) => notifySlackRateLimitOnce(
        ownerId, senderId, windowStart, windowEnd,
        async () => { throw new Error("controlled Slack API failure"); },
        "C_TEST_CHANNEL",
      ),
    );
    await testWorker.waitUntilReady();
    await assertJobsRemainDelayed(failingFixture.jobs.map((job) => job.id));
    const afterSlackFailure = await prisma.emailJob.findUniqueOrThrow({
      where: { id: failingFixture.jobs[0].id }, select: { status: true, failedAt: true },
    });
    assert(afterSlackFailure.status === "SCHEDULED" && afterSlackFailure.failedAt === null,
      "Slack API failure must not fail the deferred email job");
    await testWorker.close();
    testWorker = undefined;
    console.log("PASS M: Slack API failure did not fail or retry the rate-limited email");

    const sender = await prisma.sender.create({
      data: {
        userId: userB.id,
        name: "Slack Test SMTP Sender",
        email: `sender-${tag}@example.test`,
        smtpHost: "not-used.invalid",
        smtpPort: 587,
        smtpUser: "not-used",
        smtpPassword: "NOT_A_REAL_SMTP_SECRET",
      },
      select: { id: true },
    });
    const successCampaign = await prisma.campaign.create({
      data: {
        userId: userB.id,
        name: "Slack Success Notification Test",
        subject: "Slack notification failure test",
        body: "Controlled test fixture",
        startAt: new Date(),
        delayMs: 0,
        hourlyLimit: 60,
      },
      select: { id: true },
    });
    const emailJob = await prisma.emailJob.create({
      data: {
        userId: userB.id,
        senderId: sender.id,
        campaignId: successCampaign.id,
        recipientEmail: `recipient-${tag}@example.test`,
        subject: "Slack notification failure test",
        body: "Controlled test fixture",
        scheduledAt: new Date(),
        idempotencyKey: randomUUID(),
      },
      select: { id: true },
    });
    emailJobId = emailJob.id;
    let sendCalls = 0;
    const processResult = await processEmailJob(
      emailJob.id,
      async () => {
        sendCalls += 1;
        return { previewUrl: undefined };
      },
      emailJob.id,
      async () => {},
      async (userId, message) =>
        notifySlack(
          userId,
          message,
          async (token) => {
            assert(token === `xoxb-user-b-${tag}`, "notifier should use that user's token");
            throw new Error("controlled Slack API failure");
          },
          "C_TEST_CHANNEL",
        ),
    );
    const finalEmail = await prisma.emailJob.findUniqueOrThrow({
      where: { id: emailJob.id },
      select: { status: true, sentAt: true },
    });
    assert(processResult.sent, "Slack failure must not fail successful email delivery");
    assert(sendCalls === 1, "Slack failure must not trigger another SMTP send");
    assert(finalEmail.status === "SENT" && finalEmail.sentAt !== null, "EmailJob must remain SENT after Slack failure");
    console.log("PASS J: Slack API failure left EmailJob SENT and did not repeat SMTP delivery");

    if (!realCredentialsConfigured) {
      console.log("Real Slack OAuth exchange skipped: Slack credentials are not configured.");
    } else {
      console.log("Real Slack OAuth exchange skipped: no user-authorized Slack callback code was supplied.");
    }
  } finally {
    await testWorker?.close();
    if (testQueue) {
      await testQueue.obliterate({ force: true });
      await testQueue.close();
    }
    await closeServer(server);
    if (emailJobId) await prisma.emailJob.deleteMany({ where: { id: emailJobId } });
    if (testUserIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: testUserIds } } });
    if (stateKeys.length > 0 || limiterKeysToDelete.length > 0) {
      await getSlackStateRedis().del(...stateKeys, ...limiterKeysToDelete);
    }
    await emailQueue.close();
    await getSlackStateRedis().quit();
    await closeEmailRateLimiterRedis();
    await closeSlackNotifierRedis();
    await prisma.$disconnect();
    for (const [key, value] of Object.entries({
      SLACK_CLIENT_ID: oldEnv.clientId,
      SLACK_CLIENT_SECRET: oldEnv.clientSecret,
      SLACK_REDIRECT_URI: oldEnv.redirectUri,
      SLACK_NOTIFICATION_CHANNEL_ID: oldEnv.channelId,
      FRONTEND_URL: oldEnv.frontendUrl,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch((error: unknown) => {
  console.error(`Slack test failed (${error instanceof Error ? error.name : "Error"})`);
  process.exitCode = 1;
});
