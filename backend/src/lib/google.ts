import "dotenv/config";
import { randomBytes } from "node:crypto";
import Redis from "ioredis";
import { getRedisConnectionOptions } from "./queue";

export const GOOGLE_OAUTH_SCOPES = ["openid", "email", "profile"] as const;
export const GOOGLE_OAUTH_STATE_TTL_SECONDS = 10 * 60;
const STATE_KEY_PREFIX = "google:oauth:state:";
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

let stateRedis: Redis | undefined;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  picture?: string;
}

export function getGoogleOAuthConfig(): GoogleOAuthConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google OAuth is not configured");
  }
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new Error("Google OAuth redirect URI is invalid");
  }
  const localHttp = parsed.protocol === "http:" && parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new Error("Google OAuth redirect URI must use HTTPS except on localhost");
  }
  return { clientId, clientSecret, redirectUri: parsed.toString() };
}

export function assertGoogleOAuthConfigured(): void {
  void getGoogleOAuthConfig();
}

export function getGoogleFrontendUrl(): string {
  const configured = process.env.FRONTEND_URL?.trim() || "http://localhost:5173";
  let parsed: URL;
  try { parsed = new URL(configured); }
  catch { throw new Error("Frontend URL is invalid"); }
  const localHttp = parsed.protocol === "http:" && parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !localHttp) throw new Error("Frontend URL must use HTTPS except on localhost");
  return parsed.origin;
}

export function getGoogleStateRedis(): Redis {
  if (!stateRedis) stateRedis = new Redis(getRedisConnectionOptions());
  return stateRedis;
}

export function getGoogleOAuthStateKey(state: string): string {
  return `${STATE_KEY_PREFIX}${state}`;
}

export async function createGoogleOAuthState(): Promise<string> {
  const redis = getGoogleStateRedis();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = randomBytes(32).toString("base64url");
    const stored = await redis.set(
      getGoogleOAuthStateKey(state),
      JSON.stringify({ flow: "google-login", expiresAt: Date.now() + GOOGLE_OAUTH_STATE_TTL_SECONDS * 1000 }),
      "EX",
      GOOGLE_OAUTH_STATE_TTL_SECONDS,
      "NX",
    );
    if (stored === "OK") return state;
  }
  throw new Error("Unable to create Google OAuth state");
}

/** Atomically consumes state so it is single-use, including expired values. */
export async function consumeGoogleOAuthState(state: string): Promise<boolean> {
  if (!STATE_PATTERN.test(state)) return false;
  const raw = (await getGoogleStateRedis().call("GETDEL", getGoogleOAuthStateKey(state))) as string | null;
  if (!raw) return false;
  try {
    const value = JSON.parse(raw) as { flow?: unknown; expiresAt?: unknown };
    return value.flow === "google-login" && typeof value.expiresAt === "number" && value.expiresAt > Date.now();
  } catch {
    return false;
  }
}

export function buildGoogleAuthorizationUrl(state: string): string {
  if (!STATE_PATTERN.test(state)) throw new Error("Google OAuth state is invalid");
  const config = getGoogleOAuthConfig();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "online");
  return url.toString();
}

interface GoogleTokenResponse { access_token?: unknown; token_type?: unknown; }

export async function exchangeGoogleCode(code: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!code.trim()) throw new Error("Google authorization code is required");
  const config = getGoogleOAuthConfig();
  let response: Response;
  try {
    response = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
      }),
    });
  } catch {
    throw new Error("Google OAuth token exchange could not connect");
  }
  let payload: GoogleTokenResponse;
  try { payload = (await response.json()) as GoogleTokenResponse; }
  catch { throw new Error("Google OAuth token exchange returned an invalid response"); }
  if (!response.ok || typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("Google OAuth token exchange failed");
  }
  return payload.access_token;
}

export async function getGoogleProfile(accessToken: string, fetcher: typeof fetch = fetch): Promise<GoogleProfile> {
  let response: Response;
  try {
    response = await fetcher("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new Error("Google profile request could not connect");
  }
  let payload: Partial<GoogleProfile>;
  try { payload = (await response.json()) as Partial<GoogleProfile>; }
  catch { throw new Error("Google profile response was invalid"); }
  if (!response.ok || typeof payload.sub !== "string" || !payload.sub || typeof payload.email !== "string" ||
      typeof payload.email_verified !== "boolean" || typeof payload.name !== "string" || !payload.name.trim()) {
    throw new Error("Google profile response was incomplete");
  }
  return {
    sub: payload.sub,
    email: payload.email,
    email_verified: payload.email_verified,
    name: payload.name,
    ...(typeof payload.picture === "string" ? { picture: payload.picture } : {}),
  };
}
