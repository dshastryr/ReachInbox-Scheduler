import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import Redis from "ioredis";
import { getRedisConnectionOptions } from "./queue";

export const SESSION_COOKIE_NAME = "reachinbox_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_KEY_PREFIX = "auth:session:";
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
let sessionRedis: Redis | undefined;

function redis(): Redis {
  if (!sessionRedis) sessionRedis = new Redis(getRedisConnectionOptions());
  return sessionRedis;
}

function sessionKey(sessionId: string): string {
  return SESSION_KEY_PREFIX + createHash("sha256").update(sessionId).digest("hex");
}

function sessionIdFromRequest(req: Request): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName !== SESSION_COOKIE_NAME) continue;
    const value = rawValue.join("=");
    try { return decodeURIComponent(value); } catch { return null; }
  }
  return null;
}

export async function createBrowserSession(userId: string, ttlSeconds = SESSION_TTL_SECONDS): Promise<string> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > SESSION_TTL_SECONDS) {
    throw new Error("Session lifetime is invalid");
  }
  const sessionId = randomBytes(32).toString("base64url");
  const result = await redis().set(sessionKey(sessionId), userId, "EX", ttlSeconds, "NX");
  if (result !== "OK") throw new Error("Unable to create browser session");
  return sessionId;
}

export async function getSessionUserId(req: Request): Promise<string | null> {
  const sessionId = sessionIdFromRequest(req);
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) return null;
  return redis().get(sessionKey(sessionId));
}

/** Resolve browser sessions first; retain x-user-id only for non-production development/tests. */
export async function getRequestUserId(req: Request): Promise<string | null> {
  const sessionId = sessionIdFromRequest(req);
  if (sessionId !== null) return getSessionUserId(req);
  if (process.env.NODE_ENV !== "production") return req.header("x-user-id")?.trim() || null;
  return null;
}

export async function destroyBrowserSession(req: Request): Promise<void> {
  const sessionId = sessionIdFromRequest(req);
  if (sessionId) await revokeBrowserSession(sessionId);
}

export async function revokeBrowserSession(sessionId: string): Promise<void> {
  if (SESSION_ID_PATTERN.test(sessionId)) await redis().del(sessionKey(sessionId));
}

export async function getBrowserSessionTTL(sessionId: string): Promise<number> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return -2;
  return redis().ttl(sessionKey(sessionId));
}

export function setBrowserSessionCookie(res: Response, sessionId: string): void {
  const production = process.env.NODE_ENV === "production";
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: production,
    // The Vercel and Render hosts are different sites. Browser fetch requests
    // need a SameSite=None cookie, which browsers require to also be Secure.
    sameSite: production ? "none" : "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

export function clearBrowserSessionCookie(res: Response): void {
  const production = process.env.NODE_ENV === "production";
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: production,
    sameSite: production ? "none" : "lax",
    path: "/",
  });
}

export async function closeAuthSessionRedis(): Promise<void> {
  if (sessionRedis) {
    await sessionRedis.quit();
    sessionRedis = undefined;
  }
}
