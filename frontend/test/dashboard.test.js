import test from "node:test";
import assert from "node:assert/strict";
import { api, apiRequest, ApiError } from "../src/lib/api.js";
import { emailHistoryTable, renderDashboard } from "../src/lib/render.js";
import { parseRecipients, mergeRecipients } from "../src/lib/recipients.js";
import { validateScheduleDraft } from "../src/lib/compose.js";

const user = { id: "8fac60e4-8fdb-4ab1-ae66-4583294a8b5f", name: "Mina Chen", email: "mina@example.test", avatarUrl: null, createdAt: "2026-09-27T08:00:00Z" };
const email = { id: "job-1", status: "SENT", recipientEmail: "client@example.test", subject: "Quarterly update", sender: { email: "mina@example.test" }, campaign: { name: "Quarterly" }, scheduledAt: "2026-09-27T08:00:00Z", sentAt: "2026-09-27T08:01:00Z", createdAt: "2026-09-26T08:00:00Z" };
const scheduledEmail = { ...email, id: "job-2", status: "SCHEDULED", sentAt: null };

test("unauthenticated login page renders Google entry point", () => {
  const html = renderDashboard({ authLoading: false });
  assert.match(html, /Welcome to ReachInbox/);
  assert.match(html, /Continue with Google/);
  assert.doesNotMatch(html, /client_secret|access_token|development user ID/i);
});

test("authenticated dashboard renders user and real statistics", () => {
  const html = renderDashboard({ user, page: "dashboard", scheduled: [scheduledEmail], emailStats: { total: 24, scheduled: 8, processing: 2, sent: 12, failed: 2 }, emailTotal: 18 });
  assert.match(html, /Good to see you, Mina/);
  assert.match(html, /mina@example\.test/);
  assert.match(html, /Total emails/);
  assert.match(html, /Processing/);
  assert.match(html, /Sent/);
  assert.match(html, />24</);
  assert.match(html, /Scheduled/);
});

test("scheduled list renders recipient, subject, time, and status", () => {
  const html = renderDashboard({ user, page: "scheduled", scheduled: [scheduledEmail] });
  assert.match(html, /client@example\.test/);
  assert.match(html, /Quarterly update/);
  assert.match(html, /status-scheduled/);
  assert.match(html, /Scheduled time/);
});

test("sent list and detail render status and safe message data", () => {
  const html = renderDashboard({ user, page: "sent", emails: [email], emailTotal: 1 });
  assert.match(html, /Sent emails/);
  assert.match(html, /status-sent/);
  const detail = renderDashboard({ user, page: "email-detail", selectedEmail: { ...email, body: "Hello" } });
  assert.match(detail, /Hello/);
  assert.doesNotMatch(detail, /smtpPassword|accessToken/);
});

test("sent history shows sent and failed states, timestamps, and failure reasons", () => {
  const html = emailHistoryTable([
    { ...email, status: "SENT", sentAt: "2026-09-27T08:01:00Z" },
    { ...email, id: "failed-1", status: "FAILED", sentAt: null, failedAt: "2026-09-27T08:02:00Z", failureReason: "SMTP delivery failed <safely>" },
  ]);
  assert.match(html, /client@example\.test/);
  assert.match(html, /Quarterly update/);
  assert.match(html, /Sent time/);
  assert.match(html, /status-sent/);
  assert.match(html, /status-failed/);
  assert.match(html, /SMTP delivery failed &lt;safely&gt;/);
  assert.match(emailHistoryTable([], { loading: true }), /Loading sent emails/);
  assert.match(emailHistoryTable([]), /No delivery history yet/);
});

test("empty, loading and safe error states render", () => {
  assert.match(renderDashboard({ user, page: "scheduled", scheduled: [] }), /Nothing scheduled yet/);
  assert.match(renderDashboard({ user, page: "scheduled", loading: true }), /Loading scheduled emails/);
  const error = renderDashboard({ user, page: "scheduled", error: "This service is temporarily unavailable." });
  assert.match(error, /role="alert"/);
  assert.doesNotMatch(error, /PrismaClient|stack|password/i);
});

test("campaign list renders backend fields and does not fabricate status", () => {
  const html = renderDashboard({ user, page: "campaigns", campaigns: [{ name: "Quarterly", subject: "News", startAt: "2026-09-27T08:00:00Z", delayMs: 3000, hourlyLimit: 40 }] });
  assert.match(html, /Quarterly/);
  assert.match(html, /News/);
  assert.match(html, /Not provided/);
});

test("integration status shows Slack and Google without tokens", () => {
  const html = renderDashboard({ user, page: "integrations", slack: { connected: true, teamId: "T123", teamName: "Design Team" } });
  assert.match(html, /Design Team/);
  assert.match(html, /Disconnect/);
  assert.match(html, /Google/);
  assert.doesNotMatch(html, /xoxb|accessToken/);
});

test("settings provides a real SMTP sender form and never renders saved passwords", () => {
  const html = renderDashboard({
    user,
    page: "settings",
    senders: [{ id: "sender-1", name: "Ethereal Test", email: "sender@ethereal.email", smtpHost: "smtp.ethereal.email", smtpPort: 587, smtpPassword: "must-not-render" }],
  });
  assert.match(html, /Add an SMTP sender/);
  assert.match(html, /name="smtpPassword" type="password"/);
  assert.match(html, /smtp\.ethereal\.email/);
  assert.match(html, /Ethereal Test/);
  assert.match(html, /sender@ethereal\.email/);
  assert.doesNotMatch(html, /must-not-render/);
});

test("CSV/TXT parser normalizes, deduplicates, and counts malformed addresses", () => {
  const parsed = parseRecipients("email,name\nALICE@example.test,Alice\nalice@example.test,Duplicate\nbad@@example.test,Bad\nbob@example.test,Bob");
  assert.deepEqual(parsed.recipients, ["alice@example.test", "bob@example.test"]);
  assert.equal(parsed.duplicates, 1);
  assert.ok(parsed.invalid >= 1);
  assert.deepEqual(mergeRecipients(parsed.recipients, ["bob@example.test", "third@example.test"]).recipients, ["alice@example.test", "bob@example.test", "third@example.test"]);
  assert.deepEqual(parseRecipients("  ").recipients, []);
});

test("compose validation rejects missing and malformed scheduling fields", () => {
  const base = { senderId: "s1", senderIds: ["s1"], recipients: ["a@example.test"], subject: "Hello", body: "Text", delayMs: 5000, hourlyLimit: 20, startAt: new Date("2026-09-27T10:00:00Z") };
  assert.equal(validateScheduleDraft(base), "");
  assert.match(validateScheduleDraft({ ...base, senderId: "other" }), /sender/);
  assert.match(validateScheduleDraft({ ...base, recipients: [] }), /recipient/);
  assert.match(validateScheduleDraft({ ...base, delayMs: -1 }), /Delay/);
  assert.match(validateScheduleDraft({ ...base, hourlyLimit: 0 }), /Hourly/);
  assert.match(validateScheduleDraft({ ...base, startAt: "bad" }), /date/);
});

test("compose screen shows recipient chips, upload control, and schedule fields", () => {
  const html = renderDashboard({
    user,
    page: "compose",
    senders: [{ id: "sender-1", name: "Primary", email: "mina@example.test" }],
    recipients: ["a@example.test", "b@example.test"],
    compose: { senderId: "sender-1", subject: "Hello", body: "Message", startAt: "2026-09-27T10:00", delayMs: 5000, hourlyLimit: 50 },
  });
  assert.match(html, /Compose New Email/);
  assert.match(html, /2 recipients detected/);
  assert.match(html, /Upload list/);
  assert.match(html, /Hourly limit/);
  assert.match(html, /Schedule emails/);
});

test("search calls user-scoped endpoint with cookie credentials only", async () => {
  let captured;
  const result = await api.searchEmails("to me", async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ total: 1, items: [email] }), { status: 200 });
  });
  assert.equal(result.total, 1);
  assert.match(captured.url, /\/api\/search\/emails\?q=to\+me$/);
  assert.doesNotMatch(captured.url, /userId=/);
  assert.equal(captured.options.credentials, "include");
  assert.equal(captured.options.headers.get("x-user-id"), null);
});

test("schedule API uses the centralized campaign scheduling endpoint", async () => {
  let captured;
  const result = await api.scheduleCampaign({ requestId: "r", recipients: ["a@example.test"] }, async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ jobs: [{ emailJobId: "j1" }] }), { status: 201 });
  });
  assert.equal(result.jobs.length, 1);
  assert.match(captured.url, /\/api\/campaigns\/schedule$/);
  assert.equal(captured.options.method, "POST");
  assert.equal(JSON.parse(captured.options.body).requestId, "r");
});

test("sent history API uses its centralized endpoint with cookie credentials", async () => {
  let captured;
  const result = await api.sentEmails(async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ total: 1, items: [{ ...email, status: "FAILED" }] }), { status: 200 });
  });
  assert.equal(result.total, 1);
  assert.match(captured.url, /\/api\/emails\/sent$/);
  assert.equal(captured.options.credentials, "include");
  assert.equal(captured.options.headers.get("x-user-id"), null);
});

test("sender creation posts SMTP credentials over the authenticated API without echoing them", async () => {
  let captured;
  const input = { name: "Ethereal Test", email: "sender@ethereal.email", smtpHost: "smtp.ethereal.email", smtpPort: 587, smtpUser: "test-user", smtpPassword: "test-secret" };
  const sender = await api.createSender(input, async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ id: "sender-1", name: input.name, email: input.email, smtpHost: input.smtpHost, smtpPort: input.smtpPort, smtpUser: input.smtpUser }), { status: 201 });
  });
  assert.match(captured.url, /\/api\/senders$/);
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.credentials, "include");
  assert.equal(JSON.parse(captured.options.body).smtpPassword, "test-secret");
  assert.equal("smtpPassword" in sender, false);
});

test("session API is centralized and backend errors are safely redacted", async () => {
  let url;
  await apiRequest("/api/auth/me", {}, async (requestedUrl) => {
    url = requestedUrl;
    return new Response(JSON.stringify({ id: user.id }), { status: 200 });
  });
  assert.match(url, /\/api\/auth\/me$/);
  await assert.rejects(apiRequest("/api/search/emails", {}, async () => new Response(JSON.stringify({ error: "Prisma stack secret" }), { status: 503 })),
    (error) => error instanceof ApiError && error.message === "This service is temporarily unavailable. Try again.");
});
