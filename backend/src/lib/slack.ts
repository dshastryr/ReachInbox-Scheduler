import "dotenv/config";
import { randomBytes } from "node:crypto";
import Redis from "ioredis";
import { getRedisConnectionOptions } from "./queue";

export const SLACK_OAUTH_SCOPES = ["chat:write"] as const;
export const SLACK_OAUTH_STATE_TTL_SECONDS = 10 * 60;
const STATE_KEY_PREFIX = "slack:oauth:state:";
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

let stateRedis: Redis | undefined;

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface SlackInstallation {
  accessToken: string;
  teamId: string | null;
  teamName: string | null;
}

function getSlackOAuthConfig(): SlackOAuthConfig {
  const clientId = process.env.SLACK_CLIENT_ID?.trim();
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  const redirectUri = process.env.SLACK_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret?.trim() || !redirectUri) {
    throw new Error("SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, and SLACK_REDIRECT_URI must be configured");
  }
  let parsedRedirect: URL;
  try {
    parsedRedirect = new URL(redirectUri);
  } catch {
    throw new Error("SLACK_REDIRECT_URI must be a valid URL");
  }
  const isLocalHttp = parsedRedirect.protocol === "http:" && parsedRedirect.hostname === "localhost";
  if (parsedRedirect.protocol !== "https:" && !isLocalHttp) {
    throw new Error("SLACK_REDIRECT_URI must use HTTPS, except for localhost development");
  }
  return { clientId, clientSecret, redirectUri: parsedRedirect.toString() };
}

export function assertSlackOAuthConfigured(): void {
  void getSlackOAuthConfig();
}

export function getSlackFrontendUrl(): string {
  const configured = process.env.FRONTEND_URL?.trim() || "http://localhost:5173";
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("FRONTEND_URL must be a valid URL");
  }
  const localHttp = parsed.protocol === "http:" && parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new Error("FRONTEND_URL must use HTTPS except on localhost");
  }
  return parsed.origin;
}

export function getSlackStateRedis(): Redis {
  if (!stateRedis) stateRedis = new Redis(getRedisConnectionOptions());
  return stateRedis;
}

export function getSlackOAuthStateKey(state: string): string {
  return `${STATE_KEY_PREFIX}${state}`;
}

export async function createSlackOAuthState(userId: string): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  const value = JSON.stringify({ userId, expiresAt: Date.now() + SLACK_OAUTH_STATE_TTL_SECONDS * 1000 });
  const stored = await getSlackStateRedis().set(
    getSlackOAuthStateKey(state),
    value,
    "EX",
    SLACK_OAUTH_STATE_TTL_SECONDS,
    "NX",
  );
  if (stored !== "OK") throw new Error("Unable to create Slack OAuth state");
  return state;
}

/** Atomically consumes a state value so it cannot be replayed. */
export async function consumeSlackOAuthState(state: string): Promise<string | null> {
  if (!STATE_PATTERN.test(state)) return null;
  const raw = (await getSlackStateRedis().call("GETDEL", getSlackOAuthStateKey(state))) as string | null;
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { userId?: unknown; expiresAt?: unknown };
    if (
      typeof value.userId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.userId) ||
      typeof value.expiresAt !== "number" ||
      value.expiresAt <= Date.now()
    ) {
      return null;
    }
    return value.userId;
  } catch {
    return null;
  }
}

export async function buildSlackAuthorizationUrl(state: string): Promise<string> {
  if (!STATE_PATTERN.test(state)) throw new Error("Slack OAuth state is invalid");
  const config = getSlackOAuthConfig();
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("scope", SLACK_OAUTH_SCOPES.join(","));
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

interface SlackOAuthResponse {
  ok?: boolean;
  access_token?: string;
  team?: { id?: string; name?: string } | null;
}

export async function exchangeSlackCode(
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<SlackInstallation> {
  const config = getSlackOAuthConfig();
  const form = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });
  let response: Response;
  try {
    response = await fetcher("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
  } catch {
    throw new Error("Slack OAuth token exchange could not connect");
  }
  let payload: SlackOAuthResponse;
  try {
    payload = (await response.json()) as SlackOAuthResponse;
  } catch {
    throw new Error("Slack OAuth token exchange returned an invalid response");
  }
  if (!response.ok || payload.ok !== true || typeof payload.access_token !== "string") {
    throw new Error("Slack OAuth token exchange failed");
  }
  return {
    accessToken: payload.access_token,
    teamId: typeof payload.team?.id === "string" ? payload.team.id : null,
    teamName: typeof payload.team?.name === "string" ? payload.team.name : null,
  };
}

export async function postSlackMessage(
  accessToken: string,
  channelId: string,
  message: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: channelId, text: message }),
    });
  } catch {
    throw new Error("Slack notification could not connect");
  }
  let payload: { ok?: boolean };
  try {
    payload = (await response.json()) as { ok?: boolean };
  } catch {
    throw new Error("Slack notification returned an invalid response");
  }
  if (!response.ok || payload.ok !== true) throw new Error("Slack notification failed");
}
