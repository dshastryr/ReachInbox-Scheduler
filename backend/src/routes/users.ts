import { Router } from "express";
import { prisma } from "../lib/prisma";
import { getRequestUserId } from "../lib/auth-session";

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/me", async (req, res) => {
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
      select: {
        id: true,
        name: true,
        email: true,
        avatarUrl: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.status(200).json(user);
  } catch {
    res.status(500).json({ error: "Unable to retrieve user" });
  }
});

export default router;
