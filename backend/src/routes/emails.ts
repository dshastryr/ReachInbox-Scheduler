import { Router } from "express";
import { EmailJobStatus } from "../generated/prisma/enums";
import { prisma } from "../lib/prisma";
import { getRequestUserId } from "../lib/auth-session";

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(async (req, res, next) => {
  let userId: string | null;
  try { userId = await getRequestUserId(req); }
  catch { res.status(503).json({ error: "Unable to verify authentication" }); return; }
  if (!userId) { res.status(401).json({ error: "Authentication is required" }); return; }
  if (!UUID_PATTERN.test(userId)) { res.status(401).json({ error: "Authentication is required" }); return; }
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) { res.status(401).json({ error: "Authentication is required" }); return; }
    res.locals.userId = user.id;
    next();
  } catch { res.status(503).json({ error: "Unable to verify authentication" }); }
});

router.get("/stats", async (_req, res) => {
  const userId = res.locals.userId as string;
  try {
    const [total, scheduled, processing, sent, failed] = await Promise.all([
      prisma.emailJob.count({ where: { userId } }),
      prisma.emailJob.count({ where: { userId, status: "SCHEDULED" } }),
      prisma.emailJob.count({ where: { userId, status: "PROCESSING" } }),
      prisma.emailJob.count({ where: { userId, status: "SENT" } }),
      prisma.emailJob.count({ where: { userId, status: "FAILED" } }),
    ]);
    res.status(200).json({ total, scheduled, processing, sent, failed });
  } catch { res.status(503).json({ error: "Unable to retrieve email statistics" }); }
});

router.get("/scheduled", async (_req, res) => {
  try {
    const where = { userId: res.locals.userId as string, status: { in: [EmailJobStatus.SCHEDULED, EmailJobStatus.PROCESSING] } };
    const [total, jobs] = await Promise.all([prisma.emailJob.count({ where }), prisma.emailJob.findMany({
      where,
      select: {
        id: true,
        recipientEmail: true,
        subject: true,
        scheduledAt: true,
        status: true,
        createdAt: true,
        campaign: { select: { id: true, name: true } },
        sender: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
      take: 500,
    })]);
    res.status(200).json({ total, items: jobs });
  } catch { res.status(503).json({ error: "Unable to retrieve scheduled emails" }); }
});

router.get("/sent", async (_req, res) => {
  try {
    const where = { userId: res.locals.userId as string, status: { in: [EmailJobStatus.SENT, EmailJobStatus.FAILED] } };
    const [total, jobs] = await Promise.all([prisma.emailJob.count({ where }), prisma.emailJob.findMany({
      where,
      select: {
        id: true,
        recipientEmail: true,
        subject: true,
        scheduledAt: true,
        sentAt: true,
        failedAt: true,
        failureReason: true,
        status: true,
        createdAt: true,
        campaign: { select: { id: true, name: true } },
        sender: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ createdAt: "desc" }],
      take: 500,
    })]);
    res.status(200).json({ total, items: jobs });
  } catch { res.status(503).json({ error: "Unable to retrieve sent emails" }); }
});

router.get("/:id", async (req, res) => {
  if (!UUID_PATTERN.test(req.params.id)) { res.status(404).json({ error: "Email not found" }); return; }
  try {
    const job = await prisma.emailJob.findFirst({
      where: { id: req.params.id, userId: res.locals.userId as string },
      select: {
        id: true, recipientEmail: true, subject: true, body: true, scheduledAt: true,
        status: true, sentAt: true, failedAt: true, failureReason: true, createdAt: true,
        campaign: { select: { id: true, name: true } },
        sender: { select: { id: true, name: true, email: true } },
      },
    });
    if (!job) { res.status(404).json({ error: "Email not found" }); return; }
    res.status(200).json(job);
  } catch { res.status(503).json({ error: "Unable to retrieve email" }); }
});

export default router;
