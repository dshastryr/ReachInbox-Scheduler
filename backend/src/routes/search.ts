import { Router } from "express";
import { prisma } from "../lib/prisma";
import { searchEmailJobs } from "../services/email-search";
import { getRequestUserId } from "../lib/auth-session";

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
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

router.get("/emails", async (req, res) => {
  const query = req.query.q;
  if (query !== undefined && typeof query !== "string") {
    res.status(400).json({ error: "q must be a single search string" });
    return;
  }
  if (typeof query === "string" && query.length > 200) {
    res.status(400).json({ error: "q must be 200 characters or fewer" });
    return;
  }

  try {
    const result = await searchEmailJobs(res.locals.userId as string, query as string | undefined);
    res.status(200).json(result);
  } catch {
    res.status(503).json({ error: "Email search is temporarily unavailable" });
  }
});

export default router;
