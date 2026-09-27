import { Router } from "express";
import { prisma } from "../lib/prisma";
import { getRequestUserId } from "../lib/auth-session";
import { createAndScheduleCampaign, ScheduleConflictError } from "../services/create-campaign-schedule";

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
const CAMPAIGN_RESPONSE_FIELDS = {
  id: true,
  userId: true,
  name: true,
  subject: true,
  body: true,
  startAt: true,
  delayMs: true,
  hourlyLimit: true,
  createdAt: true,
  updatedAt: true,
} as const;

router.use(async (req, res, next) => {
  let userId: string | null;
  try { userId = await getRequestUserId(req); }
  catch { res.status(503).json({ error: "Unable to verify authentication" }); return; }

  if (!userId) {
    res.status(401).json({ error: "The x-user-id header is required" });
    return;
  }

  if (!UUID_PATTERN.test(userId)) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.locals.userId = user.id;
    next();
  } catch {
    res.status(500).json({ error: "Unable to verify user" });
  }
});

router.post("/schedule", async (req, res) => {
  const { requestId, senderId, name, subject, body, recipients, startAt, delayMs, hourlyLimit } = req.body ?? {};
  if (typeof requestId !== "string" || !UUID_PATTERN.test(requestId)) {
    res.status(400).json({ error: "requestId must be a UUID and must be reused when retrying this request" });
    return;
  }
  if (typeof senderId !== "string" || !UUID_PATTERN.test(senderId)) {
    res.status(400).json({ error: "senderId must be a valid UUID" });
    return;
  }
  if (name !== undefined && name !== null && (typeof name !== "string" || !name.trim())) {
    res.status(400).json({ error: "name must be a non-empty string when provided" });
    return;
  }
  if (typeof subject !== "string" || !subject.trim()) {
    res.status(400).json({ error: "subject is required" });
    return;
  }
  if (typeof body !== "string" || !body.trim()) {
    res.status(400).json({ error: "body is required" });
    return;
  }
  if (!Array.isArray(recipients) || recipients.length === 0 || recipients.length > 1000 ||
      recipients.some((recipient: unknown) => typeof recipient !== "string")) {
    res.status(400).json({ error: "recipients must contain between 1 and 1000 email addresses" });
    return;
  }
  const normalizedRecipients = [...new Set((recipients as string[]).map((email) => email.trim().toLowerCase()))];
  if (normalizedRecipients.some((email) => email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    res.status(400).json({ error: "One or more recipient email addresses are invalid", invalidRecipientCount: normalizedRecipients.filter((email) => email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)).length });
    return;
  }
  if (typeof startAt !== "string" || !ISO_DATETIME_PATTERN.test(startAt) || !Number.isFinite(Date.parse(startAt))) {
    res.status(400).json({ error: "startAt must be a valid ISO date-time" });
    return;
  }
  const dateParts = startAt.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (dateParts) {
    const [, year, month, day] = dateParts;
    const calendarDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (calendarDate.getUTCFullYear() !== Number(year) || calendarDate.getUTCMonth() !== Number(month) - 1 || calendarDate.getUTCDate() !== Number(day)) {
      res.status(400).json({ error: "startAt must be a valid ISO date-time" });
      return;
    }
  }
  if (typeof delayMs !== "number" || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 2147483647) {
    res.status(400).json({ error: "delayMs must be a non-negative integer" });
    return;
  }
  if (typeof hourlyLimit !== "number" || !Number.isInteger(hourlyLimit) || hourlyLimit <= 0 || hourlyLimit > 2147483647) {
    res.status(400).json({ error: "hourlyLimit must be a positive integer" });
    return;
  }

  try {
    const result = await createAndScheduleCampaign(res.locals.userId as string, {
      requestId,
      senderId,
      name: typeof name === "string" ? name.trim() : null,
      subject: subject.trim(),
      body: body.trim(),
      recipients: normalizedRecipients,
      startAt: new Date(startAt),
      delayMs,
      hourlyLimit,
    });
    res.status(result.created ? 201 : 200).json({
      ...result,
      deduplicatedRecipientCount: (recipients as string[]).length - normalizedRecipients.length,
    });
  } catch (error) {
    if (error instanceof ScheduleConflictError) {
      res.status(error.message === "Sender not found" ? 404 : 409).json({ error: error.message });
      return;
    }
    res.status(503).json({ error: "Unable to enqueue campaign emails. Retry with the same requestId." });
  }
});

router.post("/", async (req, res) => {
  const { name, subject, body, startAt, delayMs, hourlyLimit } = req.body ?? {};

  if (name !== undefined && name !== null && (typeof name !== "string" || !name.trim())) {
    res.status(400).json({ error: "name must be a non-empty string when provided" });
    return;
  }

  if (typeof subject !== "string" || !subject.trim()) {
    res.status(400).json({ error: "subject is required and must be a non-empty string" });
    return;
  }

  if (typeof body !== "string" || !body.trim()) {
    res.status(400).json({ error: "body is required and must be a non-empty string" });
    return;
  }

  if (typeof startAt !== "string" || !ISO_DATETIME_PATTERN.test(startAt) || !Number.isFinite(Date.parse(startAt))) {
    res.status(400).json({ error: "startAt must be a valid ISO date-time" });
    return;
  }

  const dateParts = startAt.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (dateParts) {
    const [, year, month, day] = dateParts;
    const calendarDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (
      calendarDate.getUTCFullYear() !== Number(year) ||
      calendarDate.getUTCMonth() !== Number(month) - 1 ||
      calendarDate.getUTCDate() !== Number(day)
    ) {
      res.status(400).json({ error: "startAt must be a valid ISO date-time" });
      return;
    }
  }

  if (typeof delayMs !== "number" || !Number.isInteger(delayMs) || delayMs < 0) {
    res.status(400).json({ error: "delayMs must be a non-negative integer" });
    return;
  }

  if (typeof hourlyLimit !== "number" || !Number.isInteger(hourlyLimit) || hourlyLimit <= 0) {
    res.status(400).json({ error: "hourlyLimit must be a positive integer" });
    return;
  }

  try {
    const campaign = await prisma.campaign.create({
      data: {
        userId: res.locals.userId as string,
        name: typeof name === "string" ? name.trim() : null,
        subject: subject.trim(),
        body: body.trim(),
        startAt: new Date(startAt),
        delayMs,
        hourlyLimit,
      },
      select: CAMPAIGN_RESPONSE_FIELDS,
    });

    res.status(201).json(campaign);
  } catch {
    res.status(500).json({ error: "Unable to create campaign" });
  }
});

router.get("/", async (_req, res) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { userId: res.locals.userId as string },
      select: CAMPAIGN_RESPONSE_FIELDS,
      orderBy: { startAt: "asc" },
    });

    res.status(200).json(campaigns);
  } catch {
    res.status(500).json({ error: "Unable to retrieve campaigns" });
  }
});

router.get("/:id", async (req, res) => {
  const { id } = req.params;

  if (!UUID_PATTERN.test(id)) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id, userId: res.locals.userId as string },
      select: CAMPAIGN_RESPONSE_FIELDS,
    });

    if (!campaign) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    res.status(200).json(campaign);
  } catch {
    res.status(500).json({ error: "Unable to retrieve campaign" });
  }
});

router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  if (!UUID_PATTERN.test(id)) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  try {
    const result = await prisma.campaign.deleteMany({
      where: { id, userId: res.locals.userId as string },
    });

    if (result.count === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    res.status(204).end();
  } catch {
    res.status(500).json({ error: "Unable to delete campaign" });
  }
});

export default router;
