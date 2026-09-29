import { Router } from "express";
import { prisma } from "../lib/prisma";
import { createBrowserSession, setBrowserSessionCookie } from "../lib/auth-session";
import {
  buildGoogleAuthorizationUrl,
  consumeGoogleOAuthState,
  createGoogleOAuthState,
  exchangeGoogleCode,
  getGoogleProfile,
  getGoogleFrontendUrl,
  type GoogleProfile,
} from "../lib/google";

interface GoogleAuthDependencies {
  makeState: typeof createGoogleOAuthState;
  consumeState: typeof consumeGoogleOAuthState;
  authorizationUrl: typeof buildGoogleAuthorizationUrl;
  exchangeCode: typeof exchangeGoogleCode;
  profile: typeof getGoogleProfile;
  createSession: typeof createBrowserSession;
}

const defaults: GoogleAuthDependencies = {
  makeState: createGoogleOAuthState,
  consumeState: consumeGoogleOAuthState,
  authorizationUrl: buildGoogleAuthorizationUrl,
  exchangeCode: exchangeGoogleCode,
  profile: getGoogleProfile,
  createSession: createBrowserSession,
};

export function createGoogleAuthRouter(dependencies: GoogleAuthDependencies = defaults): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const state = await dependencies.makeState();
      res.redirect(302, dependencies.authorizationUrl(state));
    } catch {
      res.status(503).json({ error: "Google OAuth is unavailable or not configured" });
    }
  });

  router.get("/callback", async (req, res) => {
    const frontendUrl = () => {
      try { return getGoogleFrontendUrl(); } catch { return "http://localhost:5173"; }
    };
    const fail = (stage: string, error?: unknown) => {
      // Keep OAuth diagnostics useful without logging codes, tokens, emails,
      // cookies, or provider response bodies.
      const errorName = error instanceof Error ? error.name : undefined;
      console.warn(`[google-oauth] callback failed at ${stage}${errorName ? ` (${errorName})` : ""}`);
      const destination = new URL("/", frontendUrl());
      destination.searchParams.set("auth_error", "google");
      res.redirect(302, destination.toString());
    };
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!state) {
      fail("missing_state");
      return;
    }
    let validState = false;
    try { validState = await dependencies.consumeState(state); }
    catch (error) {
      fail("state_validation", error);
      return;
    }
    if (!validState) {
      fail("invalid_or_expired_state");
      return;
    }
    if (typeof req.query.error === "string") {
      fail("provider_declined");
      return;
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) {
      fail("missing_code");
      return;
    }

    let stage = "google_token_exchange";
    try {
      const accessToken = await dependencies.exchangeCode(code);
      stage = "profile_lookup";
      const profile = await dependencies.profile(accessToken);
      if (!profile.email_verified) {
        fail("unverified_email");
        return;
      }
      const email = profile.email.trim().toLowerCase();
      if (!email || !email.includes("@")) {
        fail("invalid_profile_email");
        return;
      }
      stage = "account_or_session_creation";
      const user = await findOrLinkUser(profile, email);
      const sessionId = await dependencies.createSession(user.id);
      setBrowserSessionCookie(res, sessionId);
      res.redirect(302, frontendUrl());
    } catch (error) {
      fail(stage, error);
    }
  });

  return router;
}

async function findOrLinkUser(profile: GoogleProfile, email: string) {
  return prisma.$transaction(async (tx) => {
    const byGoogleId = await tx.user.findUnique({ where: { googleId: profile.sub } });
    if (byGoogleId) {
      const emailOwner = await tx.user.findUnique({ where: { email }, select: { id: true } });
      if (emailOwner && emailOwner.id !== byGoogleId.id) throw new Error("Google email is already associated with another account");
      return tx.user.update({
        where: { id: byGoogleId.id },
        data: { email, name: profile.name.trim(), avatarUrl: profile.picture ?? null },
        select: { id: true, name: true, email: true, avatarUrl: true, createdAt: true, updatedAt: true },
      });
    }

    const byEmail = await tx.user.findUnique({ where: { email } });
    if (byEmail) {
      if (byEmail.googleId && byEmail.googleId !== profile.sub) throw new Error("Google email is already linked to another Google account");
      return tx.user.update({
        where: { id: byEmail.id },
        data: { googleId: profile.sub, name: profile.name.trim(), avatarUrl: profile.picture ?? null },
        select: { id: true, name: true, email: true, avatarUrl: true, createdAt: true, updatedAt: true },
      });
    }

    return tx.user.create({
      data: { googleId: profile.sub, email, name: profile.name.trim(), avatarUrl: profile.picture ?? null },
      select: { id: true, name: true, email: true, avatarUrl: true, createdAt: true, updatedAt: true },
    });
  });
}

export default createGoogleAuthRouter();
