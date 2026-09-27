import { Router } from "express";
import { prisma } from "../lib/prisma";
import { getRequestUserId } from "../lib/auth-session";
import {
  assertSlackOAuthConfigured,
  buildSlackAuthorizationUrl,
  consumeSlackOAuthState,
  createSlackOAuthState,
  exchangeSlackCode,
  getSlackFrontendUrl,
} from "../lib/slack";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSlackRouter(exchangeCode: typeof exchangeSlackCode = exchangeSlackCode): Router {
const router = Router();

router.use(async (req, res, next) => {
  if (req.path === "/callback") {
    next();
    return;
  }

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

router.get("/connect", async (_req, res) => {
  try {
    assertSlackOAuthConfigured();
    const state = await createSlackOAuthState(res.locals.userId as string);
    const authorizationUrl = await buildSlackAuthorizationUrl(state);
    res.redirect(302, authorizationUrl);
  } catch {
    res.status(503).json({ error: "Slack OAuth is unavailable or not configured" });
  }
});

router.get("/callback", async (req, res) => {
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!state) {
    res.status(400).json({ error: "Slack OAuth state is required" });
    return;
  }

  let userId: string | null;
  try {
    userId = await consumeSlackOAuthState(state);
  } catch {
    res.status(503).json({ error: "Unable to validate Slack OAuth state" });
    return;
  }
  if (!userId) {
    res.status(400).json({ error: "Slack OAuth state is invalid, expired, or already used" });
    return;
  }

  if (typeof req.query.error === "string") {
    res.status(400).json({ error: "Slack authorization was declined" });
    return;
  }
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) {
    res.status(400).json({ error: "Slack authorization code is required" });
    return;
  }

  try {
    const installation = await exchangeCode(code);
    const connection = await prisma.slackConnection.upsert({
      where: { userId },
      create: {
        userId,
        accessToken: installation.accessToken,
        teamId: installation.teamId,
        teamName: installation.teamName,
      },
      update: {
        accessToken: installation.accessToken,
        teamId: installation.teamId,
        teamName: installation.teamName,
      },
      select: { teamId: true, teamName: true },
    });
    res.redirect(302, `${getSlackFrontendUrl()}/#integrations`);
  } catch {
    res.status(502).json({ error: "Slack OAuth could not be completed" });
  }
});

router.get("/status", async (_req, res) => {
  try {
    const connection = await prisma.slackConnection.findUnique({
      where: { userId: res.locals.userId as string },
      select: { teamId: true, teamName: true },
    });
    res.status(200).json({
      connected: connection !== null,
      teamId: connection?.teamId ?? null,
      teamName: connection?.teamName ?? null,
    });
  } catch {
    res.status(500).json({ error: "Unable to retrieve Slack connection status" });
  }
});

router.delete("/", async (_req, res) => {
  try {
    const result = await prisma.slackConnection.deleteMany({
      where: { userId: res.locals.userId as string },
    });
    if (result.count === 0) {
      res.status(404).json({ error: "Slack connection not found" });
      return;
    }
    res.status(204).end();
  } catch {
    res.status(500).json({ error: "Unable to disconnect Slack" });
  }
});

return router;
}

export default createSlackRouter();
