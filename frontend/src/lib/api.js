const DEFAULT_API_BASE_URL = "http://localhost:5000";

export function getApiBaseUrl() {
  const configured = globalThis.REACHINBOX_API_BASE_URL;
  return (typeof configured === "string" && configured.trim() ? configured : DEFAULT_API_BASE_URL).replace(/\/$/, "");
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiRequest(path, options = {}, fetcher = fetch) {
  const headers = new Headers(options.headers ?? {});
  headers.set("accept", "application/json");
  if (options.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  let response;
  try {
    response = await fetcher(`${getApiBaseUrl()}${path}`, { ...options, headers, credentials: "include" });
  } catch {
    throw new ApiError(0, "Unable to reach the ReachInbox API. Check that the backend is running.");
  }
  if (!response.ok) {
    const message = response.status === 401
      ? "Your session has expired. Sign in again."
      : response.status === 404
        ? "The requested account or resource could not be found."
      : response.status >= 500
        ? "This service is temporarily unavailable. Try again."
        : "The request could not be completed. Check the information and try again.";
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return null;
  try { return await response.json(); }
  catch { throw new ApiError(response.status, "The API returned an unreadable response."); }
}

export const api = {
  register(name, email) {
    return apiRequest("/api/auth/register", { method: "POST", body: JSON.stringify({ name, email }) });
  },
  me() { return apiRequest("/api/users/me"); },
  authMe(fetcher = fetch) { return apiRequest("/api/auth/me", {}, fetcher); },
  logout() { return apiRequest("/api/auth/logout", { method: "POST" }); },
  campaigns() { return apiRequest("/api/campaigns"); },
  emailStats() { return apiRequest("/api/emails/stats"); },
  senders() { return apiRequest("/api/senders"); },
  scheduledEmails() { return apiRequest("/api/emails/scheduled"); },
  sentEmails(fetcher = fetch) { return apiRequest("/api/emails/sent", {}, fetcher); },
  email(id) { return apiRequest(`/api/emails/${encodeURIComponent(id)}`); },
  searchEmails(query = "", fetcher = fetch) {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    return apiRequest(`/api/search/emails${params.size ? `?${params}` : ""}`, {}, fetcher);
  },
  scheduleCampaign(input, fetcher = fetch) {
    return apiRequest("/api/campaigns/schedule", { method: "POST", body: JSON.stringify(input) }, fetcher);
  },
  slackStatus() { return apiRequest("/api/slack/status"); },
  disconnectSlack() { return apiRequest("/api/slack", { method: "DELETE" }); },
  async connectSlack() {
    return `${getApiBaseUrl()}/api/slack/connect`;
  },
};
