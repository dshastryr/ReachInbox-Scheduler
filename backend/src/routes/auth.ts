import { Router } from "express";
import { Prisma } from "../generated/prisma/client";
import { prisma } from "../lib/prisma";
import { clearBrowserSessionCookie, destroyBrowserSession, getRequestUserId } from "../lib/auth-session";

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/me", async (req, res) => {
  try {
    const userId = await getRequestUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Authentication is required" });
      return;
    }
    if (!UUID_PATTERN.test(userId)) {
      res.status(401).json({ error: "Authentication is required" });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, avatarUrl: true, createdAt: true, updatedAt: true },
    });
    if (!user) {
      res.status(401).json({ error: "Authentication is required" });
      return;
    }
    res.status(200).json(user);
  } catch {
    res.status(503).json({ error: "Unable to verify authentication" });
  }
});

router.post("/logout", async (req, res) => {
  try {
    await destroyBrowserSession(req);
    clearBrowserSessionCookie(res);
    res.status(204).end();
  } catch {
    res.status(503).json({ error: "Unable to end this session" });
  }
});

router.post("/register", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";

  if (!name || !email) {
    res.status(400).json({ error: "Name and email are required" });
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "A valid email address is required" });
    return;
  }

  try {
    const existingUser = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      res.status(409).json({ error: "A user with this email already exists" });
      return;
    }

    const user = await prisma.user.create({
      data: { name, email },
      select: {
        id: true,
        name: true,
        email: true,
        avatarUrl: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.status(201).json(user);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      res.status(409).json({ error: "A user with this email already exists" });
      return;
    }

    res.status(500).json({ error: "Unable to register user" });
  }
});

export default router;
