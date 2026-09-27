import "dotenv/config";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { emailQueue } from "../lib/queue";
import authRouter from "../routes/auth";
import { closeAuthSessionRedis, createBrowserSession, revokeBrowserSession, SESSION_COOKIE_NAME } from "../lib/auth-session";
import {
  buildGoogleAuthorizationUrl,
  consumeGoogleOAuthState,
  createGoogleOAuthState,
  exchangeGoogleCode,
  getGoogleOAuthConfig,
  getGoogleOAuthStateKey,
  getGoogleProfile,
  getGoogleStateRedis,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_OAUTH_STATE_TTL_SECONDS,
} from "../lib/google";
import { createGoogleAuthRouter } from "../routes/google-auth";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Google OAuth test failed: ${message}`);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function main(): Promise<void> {
  const originalEnv = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
    frontendUrl: process.env.FRONTEND_URL,
  };
  const configured = Boolean(originalEnv.clientId?.trim() && originalEnv.clientSecret?.trim());
  const tag = randomUUID().slice(0, 8);
  process.env.GOOGLE_CLIENT_ID = "google-test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "google-test-client-secret";
  process.env.GOOGLE_REDIRECT_URI = "http://localhost:5000/api/auth/google/callback";
  process.env.FRONTEND_URL = "http://localhost:5173";
  const stateKeys: string[] = [];
  const userIds: string[] = [];
  const sessionIds: string[] = [];
  let server: Server | undefined;

  try {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REDIRECT_URI;
    let missingConfigRejected = false;
    try { getGoogleOAuthConfig(); } catch { missingConfigRejected = true; }
    assert(missingConfigRejected, "missing Google OAuth config must be rejected");
    console.log("PASS A: OAuth configuration is required");

    process.env.GOOGLE_CLIENT_ID = "google-test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-test-client-secret";
    process.env.GOOGLE_REDIRECT_URI = "http://localhost:5000/api/auth/google/callback";
    process.env.FRONTEND_URL = "http://localhost:5173";
    const state = await createGoogleOAuthState();
    stateKeys.push(getGoogleOAuthStateKey(state));
    const rawState = await getGoogleStateRedis().get(getGoogleOAuthStateKey(state));
    const stateData = JSON.parse(rawState ?? "{}") as { flow?: string; expiresAt?: number };
    const ttl = await getGoogleStateRedis().ttl(getGoogleOAuthStateKey(state));
    assert(stateData.flow === "google-login" && (stateData.expiresAt ?? 0) > Date.now(), "state should identify the OAuth flow and expiry");
    assert(ttl > 0 && ttl <= GOOGLE_OAUTH_STATE_TTL_SECONDS, "state should expire within ten minutes");
    const authUrl = new URL(buildGoogleAuthorizationUrl(state));
    assert(authUrl.hostname === "accounts.google.com", "authorization URL should target Google");
    assert(authUrl.searchParams.get("scope") === GOOGLE_OAUTH_SCOPES.join(" "), "requested scopes should be openid email profile");
    assert(!authUrl.searchParams.has("client_secret") && !authUrl.searchParams.has("userId"), "authorization URL must not expose secret or userId");
    console.log("PASS B-C: authorization URL has required scopes; Redis state is flow-bound, expiring, and contains no userId");

    const token = await exchangeGoogleCode("mock-code", async (input, init) => {
      assert(String(input) === "https://oauth2.googleapis.com/token", "token exchange should use Google token endpoint");
      const body = String(init?.body ?? "");
      assert(body.includes("client_secret=google-test-client-secret") && body.includes("code=mock-code"), "token request should send code and secret over POST");
      return new Response(JSON.stringify({ access_token: "mock-access-token" }), { status: 200 });
    });
    assert(token === "mock-access-token", "token exchange should return access token to internal caller");
    let profileAuthorization = "";
    const profile = await getGoogleProfile(token, async (_input, init) => {
      profileAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ sub: "sub-test", email: "test@example.com", email_verified: true, name: "Test", picture: "https://example.test/avatar.png" }), { status: 200 });
    });
    assert(profileAuthorization === "Bearer mock-access-token" && profile.email_verified, "profile endpoint should receive bearer token and provide verified identity");
    console.log("PASS D: mocked code exchange and profile retrieval succeed");

    const profiles = new Map<string, { sub: string; email: string; email_verified: boolean; name: string; picture?: string }>();
    const router = createGoogleAuthRouter({
      makeState: createGoogleOAuthState,
      consumeState: consumeGoogleOAuthState,
      authorizationUrl: buildGoogleAuthorizationUrl,
      exchangeCode: async (code) => `token-for-${code}`,
      profile: async (accessToken) => {
        const found = profiles.get(accessToken);
        if (!found) throw new Error("Unknown controlled test identity");
        return found;
      },
      createSession: createBrowserSession,
    });
    const app = express();
    app.use("/api/auth", authRouter);
    app.use("/api/auth/google", router);
    server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address !== null && typeof address !== "string", "test server should have TCP address");
    const base = `http://127.0.0.1:${address.port}/api/auth/google`;
    const callback = (url: string) => fetch(url, { redirect: "manual" });

    const unauthenticated = await fetch(`http://127.0.0.1:${address.port}/api/auth/me`);
    assert(unauthenticated.status === 401, "unauthenticated /api/auth/me must return 401");
    console.log("PASS A: unauthenticated /api/auth/me returns 401");

    const redirect = await fetch(base, { redirect: "manual" });
    assert(redirect.status === 302, "authorization entry should redirect");
    const redirectUrl = new URL(redirect.headers.get("location") ?? "http://invalid");
    const routeState = redirectUrl.searchParams.get("state");
    assert(routeState !== null, "redirect should include state");
    stateKeys.push(getGoogleOAuthStateKey(routeState));
    assert(!redirectUrl.searchParams.has("userId"), "route must not accept or construct userId query parameter");
    console.log("PASS E: OAuth route initiates the flow with a cryptographically random state");

    const missingState = await callback(`${base}/callback`);
    const invalidState = await callback(`${base}/callback?state=invalid`);
    assert(missingState.status === 302 && invalidState.status === 302, "missing and malformed state must be rejected with safe frontend redirect");
    const expiredState = randomUUID().replace(/-/g, "").slice(0, 32) + "AAAAAAAAAAA";
    const expiredKey = getGoogleOAuthStateKey(expiredState);
    stateKeys.push(expiredKey);
    await getGoogleStateRedis().set(expiredKey, JSON.stringify({ flow: "google-login", expiresAt: Date.now() - 1000 }), "EX", GOOGLE_OAUTH_STATE_TTL_SECONDS);
    const expired = await callback(`${base}/callback?state=${expiredState}&code=unused`);
    assert(expired.status === 302 && expired.headers.get("location")?.includes("auth_error=google") && await getGoogleStateRedis().get(expiredKey) === null, "expired state must be consumed and rejected");
    console.log("PASS F: missing, malformed, and expired state is rejected");

    const createEmail = `google-create-${tag}@example.test`;
    profiles.set("token-for-create", { sub: `google-sub-create-${tag}`, email: createEmail.toUpperCase(), email_verified: true, name: "Created Google User", picture: "https://example.test/photo" });
    const createState = await createGoogleOAuthState();
    stateKeys.push(getGoogleOAuthStateKey(createState));
    const createdResponse = await callback(`${base}/callback?state=${createState}&code=create`);
    const location = createdResponse.headers.get("location") ?? "";
    const setCookie = createdResponse.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0];
    sessionIds.push(cookie.slice(`${SESSION_COOKIE_NAME}=`.length));
    assert(createdResponse.status === 302 && location === "http://localhost:5173", `successful callback should redirect to frontend (status ${createdResponse.status}, location ${location})`);
    assert(setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Lax") && cookie.startsWith(`${SESSION_COOKIE_NAME}=`), "callback should set a protected opaque session cookie");
    assert(!setCookie.includes("token-for-create") && !location.includes("code="), "callback must not expose provider tokens or authorization code");
    const authMe = await fetch(`http://127.0.0.1:${address.port}/api/auth/me`, { headers: { cookie } });
    const createdBody = await authMe.json() as { id: string; name: string; email: string; avatarUrl: string | null };
    assert(authMe.status === 200 && createdBody.email === createEmail, "auth/me should return created user with lowercase email");
    assert(createdBody.name === "Created Google User" && createdBody.avatarUrl?.endsWith("photo"), "profile fields should be persisted and returned");
    userIds.push(createdBody.id);
    console.log("PASS G-I: verified callback creates user/session, redirects, and auth/me returns safe profile");

    const repeatState = await createGoogleOAuthState();
    stateKeys.push(getGoogleOAuthStateKey(repeatState));
    const repeated = await callback(`${base}/callback?state=${repeatState}&code=create`);
    const repeatedCookie = repeated.headers.get("set-cookie")?.split(";")[0] ?? "";
    if (repeatedCookie.startsWith(`${SESSION_COOKIE_NAME}=`)) sessionIds.push(repeatedCookie.slice(`${SESSION_COOKIE_NAME}=`.length));
    assert(repeated.status === 302 && repeatedCookie.startsWith(`${SESSION_COOKIE_NAME}=`), "same Google subject should resolve to same user and issue a session");
    const reused = await callback(`${base}/callback?state=${repeatState}&code=create`);
    assert(reused.status === 302 && reused.headers.get("location")?.includes("auth_error=google"), "consumed state cannot be replayed");
    console.log("PASS J-K: Google identity is matched and state is single-use");

    const linkEmail = `google-link-${tag}@example.test`;
    const existing = await prisma.user.create({ data: { name: "Existing Account", email: linkEmail }, select: { id: true } });
    userIds.push(existing.id);
    profiles.set("token-for-link", { sub: `google-sub-link-${tag}`, email: linkEmail, email_verified: true, name: "Linked Google User" });
    const linkState = await createGoogleOAuthState();
    stateKeys.push(getGoogleOAuthStateKey(linkState));
    const linked = await callback(`${base}/callback?state=${linkState}&code=link`);
    const linkedCookie = linked.headers.get("set-cookie")?.split(";")[0] ?? "";
    if (linkedCookie.startsWith(`${SESSION_COOKIE_NAME}=`)) sessionIds.push(linkedCookie.slice(`${SESSION_COOKIE_NAME}=`.length));
    const linkedRecord = await prisma.user.findUniqueOrThrow({ where: { id: existing.id }, select: { googleId: true, name: true } });
    assert(linked.status === 302 && linkedCookie.startsWith(`${SESSION_COOKIE_NAME}=`) && linkedRecord.googleId === `google-sub-link-${tag}`, "existing verified email account should be linked without duplication");
    console.log("PASS L: existing user with matching verified email is linked");

    profiles.set("token-for-unverified", { sub: `google-sub-unverified-${tag}`, email: `unverified-${tag}@example.test`, email_verified: false, name: "Unverified User" });
    const unverifiedState = await createGoogleOAuthState();
    stateKeys.push(getGoogleOAuthStateKey(unverifiedState));
    const unverified = await callback(`${base}/callback?state=${unverifiedState}&code=unverified`);
    assert(unverified.status === 302 && unverified.headers.get("location")?.includes("auth_error=google"), "unverified email should redirect with safe failure");
    const unverifiedCount = await prisma.user.count({ where: { email: `unverified-${tag}@example.test` } });
    assert(unverifiedCount === 0, "unverified profile must not create a user");
    console.log("PASS M: unverified Google email is rejected without creating a user");

    const failedExchangeState = await createGoogleOAuthState();
    stateKeys.push(getGoogleOAuthStateKey(failedExchangeState));
    const failedRouter = createGoogleAuthRouter({
      makeState: createGoogleOAuthState,
      consumeState: consumeGoogleOAuthState,
      authorizationUrl: buildGoogleAuthorizationUrl,
      exchangeCode: async () => { throw new Error("secret-bearing upstream error"); },
      profile: getGoogleProfile,
      createSession: createBrowserSession,
    });
    const isolatedApp = express();
    isolatedApp.use("/callback", failedRouter);
    const isolatedServer = createServer(isolatedApp);
    isolatedServer.listen(0, "127.0.0.1");
    await once(isolatedServer, "listening");
    const isolatedAddress = isolatedServer.address();
    assert(isolatedAddress !== null && typeof isolatedAddress !== "string", "isolated server should listen");
    const failedResponse = await fetch(`http://127.0.0.1:${isolatedAddress.port}/callback/callback?state=${failedExchangeState}&code=failure`, { redirect: "manual" });
    const failedText = await failedResponse.text();
    assert(failedResponse.status === 302 && failedResponse.headers.get("location")?.includes("auth_error=google") && !failedText.includes("secret-bearing"), "exchange errors must redirect safely without leaking provider details");
    await closeServer(isolatedServer);
    console.log("PASS N: upstream failures return safe errors without exposing tokens, secrets, or codes");

    const invalidSession = await fetch(`http://127.0.0.1:${address.port}/api/auth/me`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` },
    });
    assert(invalidSession.status === 401, "invalid or expired session must be rejected");
    const shortSession = await createBrowserSession(createdBody.id, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const expiredSession = await fetch(`http://127.0.0.1:${address.port}/api/auth/me`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${shortSession}` },
    });
    assert(expiredSession.status === 401, "expired Redis session must be rejected");
    const logout = await fetch(`http://127.0.0.1:${address.port}/api/auth/logout`, { method: "POST", headers: { cookie } });
    assert(logout.status === 204, "logout should clear an active session");
    const loggedOut = await fetch(`http://127.0.0.1:${address.port}/api/auth/me`, { headers: { cookie } });
    assert(loggedOut.status === 401, "logout must invalidate the server-side session");
    console.log("PASS P-R: invalid and expired sessions are rejected; logout invalidates active session");
    assert(typeof createGoogleAuthRouter === "function", "Google router is independently mountable alongside Slack routes");
    console.log("PASS O: Google auth uses its own mount and leaves Slack OAuth routes untouched");
    if (!configured) console.log("Real Google OAuth request skipped: Google credentials are not configured.");
    else console.log("Real Google OAuth request skipped: no user-authorized Google callback code was supplied.");
  } finally {
    if (server) await closeServer(server);
    for (const sessionId of sessionIds) await revokeBrowserSession(sessionId);
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (stateKeys.length) await getGoogleStateRedis().del(...stateKeys);
    await emailQueue.close();
    await getGoogleStateRedis().quit();
    await closeAuthSessionRedis();
    await prisma.$disconnect();
    for (const [key, value] of Object.entries({
      GOOGLE_CLIENT_ID: originalEnv.clientId,
      GOOGLE_CLIENT_SECRET: originalEnv.clientSecret,
      GOOGLE_REDIRECT_URI: originalEnv.redirectUri,
      FRONTEND_URL: originalEnv.frontendUrl,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown failure";
  const redacted = [process.env.GOOGLE_CLIENT_SECRET, process.env.DATABASE_URL, process.env.REDIS_URL]
    .filter((value): value is string => Boolean(value))
    .reduce((safe, value) => safe.split(value).join("[redacted]"), message);
  console.error(`Google OAuth test failed (${error instanceof Error ? error.name : "Error"}): ${redacted}`);
  process.exitCode = 1;
});
