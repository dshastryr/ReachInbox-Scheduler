import { Router } from "express";
import { prisma } from "../lib/prisma";
import { getRequestUserId } from "../lib/auth-session";

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENDER_RESPONSE_FIELDS = {
  id: true,
  userId: true,
  name: true,
  email: true,
  smtpHost: true,
  smtpPort: true,
  smtpUser: true,
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

router.post("/", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const smtpHost = typeof req.body?.smtpHost === "string" ? req.body.smtpHost.trim() : "";
  const smtpUser = typeof req.body?.smtpUser === "string" ? req.body.smtpUser.trim() : "";
  const smtpPassword = typeof req.body?.smtpPassword === "string" ? req.body.smtpPassword : "";
  const smtpPort = req.body?.smtpPort;

  if (!name || !email || !smtpHost || !smtpUser || !smtpPassword || smtpPort === undefined || smtpPort === null) {
    res.status(400).json({ error: "All sender fields are required" });
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "A valid email address is required" });
    return;
  }

  if (typeof smtpPort !== "number" || !Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    res.status(400).json({ error: "smtpPort must be an integer between 1 and 65535" });
    return;
  }

  try {
    const sender = await prisma.sender.create({
      data: {
        userId: res.locals.userId as string,
        name,
        email,
        smtpHost,
        smtpPort,
        smtpUser,
        smtpPassword,
      },
      select: SENDER_RESPONSE_FIELDS,
    });

    res.status(201).json(sender);
  } catch {
    res.status(500).json({ error: "Unable to create sender" });
  }
});

router.get("/", async (_req, res) => {
  try {
    const senders = await prisma.sender.findMany({
      where: { userId: res.locals.userId as string },
      select: SENDER_RESPONSE_FIELDS,
      orderBy: { createdAt: "asc" },
    });

    res.status(200).json(senders);
  } catch {
    res.status(500).json({ error: "Unable to retrieve senders" });
  }
});

router.get("/:id", async (req, res) => {
  const { id } = req.params;

  if (!UUID_PATTERN.test(id)) {
    res.status(404).json({ error: "Sender not found" });
    return;
  }

  try {
    const sender = await prisma.sender.findFirst({
      where: { id, userId: res.locals.userId as string },
      select: SENDER_RESPONSE_FIELDS,
    });

    if (!sender) {
      res.status(404).json({ error: "Sender not found" });
      return;
    }

    res.status(200).json(sender);
  } catch {
    res.status(500).json({ error: "Unable to retrieve sender" });
  }
});

router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  if (!UUID_PATTERN.test(id)) {
    res.status(404).json({ error: "Sender not found" });
    return;
  }

  try {
    const result = await prisma.sender.deleteMany({
      where: { id, userId: res.locals.userId as string },
    });

    if (result.count === 0) {
      res.status(404).json({ error: "Sender not found" });
      return;
    }

    res.status(204).end();
  } catch {
    res.status(500).json({ error: "Unable to delete sender" });
  }
});

export default router;
