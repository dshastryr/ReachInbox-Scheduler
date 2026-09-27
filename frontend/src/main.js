import { api, ApiError, getApiBaseUrl } from "./lib/api.js";
import { auth } from "./lib/auth.js";
import { renderDashboard } from "./lib/render.js";
import { mergeRecipients, parseRecipients } from "./lib/recipients.js";
import { validateScheduleDraft } from "./lib/compose.js";

function toLocalDateTime(date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function createComposeDraft() {
  return { name: "", subject: "", body: "", senderId: "", startAt: toLocalDateTime(new Date(Date.now() + 5 * 60_000)), delayMs: 5000, hourlyLimit: 100 };
}

const state = {
  page: location.hash.slice(1) || "dashboard",
  user: null,
  authLoading: true,
  authError: new URLSearchParams(location.search).has("auth_error") ? "Google sign-in could not be completed. Please try again." : "",
  emails: [], emailTotal: null, emailStats: null, campaigns: [], scheduled: [], scheduledTotal: 0, senders: [], slack: null,
  loading: false, error: "", searchQuery: "", menuOpen: false,
  recipients: [], recipientInput: "", fileStats: null, fileError: "", scheduling: false,
  scheduleMessage: "", scheduleRequestId: null, selectedEmail: null,
  compose: createComposeDraft(),
};

const root = document.querySelector("#app");
let searchTimer;
let activityRefreshInFlight = false;

function render() {
  root.innerHTML = renderDashboard(state);
  document.body.classList.toggle("menu-open", state.menuOpen);
}

function showError(error) {
  state.error = error instanceof ApiError ? error.message : "Unable to load this section. Try again.";
}

async function loadSession() {
  state.authLoading = true;
  render();
  try {
    state.user = await api.authMe();
    state.authError = "";
  } catch (error) {
    state.user = null;
    if (!(error instanceof ApiError) || error.status !== 401) {
      showError(error);
      state.authError = error instanceof ApiError ? error.message : "Unable to check your session. Try again.";
    }
  }
  state.authLoading = false;
  const url = new URL(location.href);
  url.searchParams.delete("auth_error");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  render();
  if (state.user) await loadPageData();
}

async function loadPageData() {
  if (!state.user) return;
  state.error = "";
  state.loading = true;
  render();
  const tasks = [];
  if (state.page === "dashboard") tasks.push(api.emailStats().then((data) => { state.emailStats = data; }));
  if (["dashboard", "scheduled"].includes(state.page)) {
    tasks.push(api.scheduledEmails().then((data) => { state.scheduled = data.items; state.scheduledTotal = data.total; }));
  }
  if (["sent", "emails"].includes(state.page)) {
    tasks.push(api.sentEmails().then((data) => { state.emails = data.items; state.emailTotal = data.total; }));
  }
  if (state.page === "search") {
    tasks.push(api.searchEmails(state.page === "search" ? state.searchQuery : "").then((data) => {
      state.emails = data.items;
      state.emailTotal = data.total;
    }));
  }
  if (state.page === "campaigns") {
    tasks.push(api.campaigns().then((data) => { state.campaigns = data; }));
  }
  if (state.page === "integrations") tasks.push(api.slackStatus().then((data) => { state.slack = data; }));
  if (state.page === "compose") tasks.push(api.senders().then((data) => { state.senders = data; }));
  if (state.page === "email-detail" && state.selectedEmail?.id) {
    tasks.push(api.email(state.selectedEmail.id).then((data) => { state.selectedEmail = data; }));
  }
  const outcomes = await Promise.allSettled(tasks);
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed?.status === "rejected") showError(failed.reason);
  state.loading = false;
  render();
}

async function refreshEmailActivity() {
  if (!state.user || state.loading || state.scheduling || activityRefreshInFlight || document.visibilityState === "hidden") return;
  const page = state.page;
  if (!["dashboard", "scheduled", "sent"].includes(page)) return;
  activityRefreshInFlight = true;
  try {
    if (page === "dashboard") {
      const [stats, upcoming] = await Promise.all([api.emailStats(), api.scheduledEmails()]);
      if (state.page === page) {
        state.emailStats = stats;
        state.scheduled = upcoming.items;
        state.scheduledTotal = upcoming.total;
      }
    } else if (page === "scheduled") {
      const upcoming = await api.scheduledEmails();
      if (state.page === page) {
        state.scheduled = upcoming.items;
        state.scheduledTotal = upcoming.total;
      }
    } else {
      const history = await api.sentEmails();
      if (state.page === page) {
        state.emails = history.items;
        state.emailTotal = history.total;
      }
    }
    if (state.page === page) {
      state.error = "";
      render();
    }
  } catch (error) {
    if (state.page === page) {
      showError(error);
      render();
    }
  } finally {
    activityRefreshInFlight = false;
  }
}

function navigate(page) {
  state.page = page;
  state.error = "";
  state.menuOpen = false;
  history.replaceState(null, "", `#${page}`);
  if (state.user) void loadPageData(); else render();
}

function setComposeField(name, value) {
  if (name in state.compose) {
    state.compose[name] = value;
    state.scheduleRequestId = null;
    state.scheduleMessage = "";
  }
}

async function addRecipientFromInput() {
  const parsed = parseRecipients(state.recipientInput);
  if (!parsed.recipients.length) {
    state.fileError = parsed.detected ? "That address is not valid." : "Enter a valid email address.";
    render();
    return;
  }
  const merged = mergeRecipients(state.recipients, parsed.recipients);
  state.recipients = merged.recipients;
  state.fileStats = { duplicates: parsed.duplicates + merged.duplicates, invalid: parsed.invalid };
  state.recipientInput = "";
  state.fileError = "";
  state.scheduleRequestId = null;
  render();
}

root.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-page], [data-action], [data-remove-recipient], [data-open-email]");
  if (!target) return;
  if (target.dataset.page) {
    event.preventDefault();
    navigate(target.dataset.page);
    return;
  }
  if (target.dataset.openEmail) {
    state.selectedEmail = { id: target.dataset.openEmail };
    state.page = "email-detail";
    history.replaceState(null, "", "#email-detail");
    void loadPageData();
    return;
  }
  if (target.dataset.removeRecipient !== undefined) {
    state.recipients.splice(Number(target.dataset.removeRecipient), 1);
    state.scheduleRequestId = null;
    render();
    return;
  }
  const action = target.dataset.action;
  if (action === "toggle-menu") { state.menuOpen = !state.menuOpen; render(); }
  if (action === "close-menu") { state.menuOpen = false; render(); }
  if (action === "retry") void loadPageData();
  if (action === "google-login") window.location.assign(auth.loginUrl(getApiBaseUrl()));
  if (action === "choose-file") root.querySelector("#lead-file")?.click();
  if (action === "add-recipient") await addRecipientFromInput();
  if (action === "logout") {
    target.disabled = true;
    try {
      await api.logout();
      state.user = null;
      state.slack = null;
      state.emails = [];
      state.emailStats = null;
      state.scheduled = [];
      state.scheduledTotal = 0;
      state.campaigns = [];
      state.page = "dashboard";
      history.replaceState(null, "", "/");
      render();
    } catch (error) { showError(error); render(); }
  }
  if (action === "connect-slack") window.location.assign(await api.connectSlack());
  if (action === "disconnect-slack") {
    try { await api.disconnectSlack(); state.slack = { connected: false, teamId: null, teamName: null }; }
    catch (error) { showError(error); }
    render();
  }
  if (action === "view-schedule") navigate("scheduled");
});

root.addEventListener("change", async (event) => {
  const input = event.target;
  if (input.id !== "lead-file") {
    if (input.form?.dataset.form === "compose") setComposeField(input.name, input.value);
    return;
  }
  if (!input.files?.length) return;
  const file = input.files[0];
  const validExtension = /\.(csv|txt)$/i.test(file.name);
  if (!validExtension) {
    state.fileError = "Choose a .csv or .txt file.";
    render();
    return;
  }
  try {
    const text = await file.text();
    if (!text.trim()) {
      state.fileError = "This file is empty.";
      render();
      return;
    }
    const parsed = parseRecipients(text);
    if (parsed.detected === 0) {
      state.fileError = "No email addresses were found in this file.";
      state.fileStats = { duplicates: 0, invalid: 0 };
      render();
      return;
    }
    const merged = mergeRecipients(state.recipients, parsed.recipients);
    state.recipients = merged.recipients;
    state.fileStats = { duplicates: parsed.duplicates + merged.duplicates, invalid: parsed.invalid };
    state.fileError = parsed.recipients.length ? "" : "No valid email addresses were found.";
    state.scheduleRequestId = null;
    render();
  } catch {
    state.fileError = "Unable to read this file.";
    render();
  } finally {
    const fileInput = root.querySelector("#lead-file");
    if (fileInput) fileInput.value = "";
  }
});

root.addEventListener("input", (event) => {
  const input = event.target;
  if (input.form?.dataset.form === "compose") {
    if (input.name === "recipientInput") state.recipientInput = input.value;
    else setComposeField(input.name, input.value);
    return;
  }
  if (input.name === "query" && state.page === "search") {
    state.searchQuery = input.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { if (state.user) void loadPageData(); }, 350);
  }
});

root.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.name === "recipientInput") {
    event.preventDefault();
    void addRecipientFromInput();
  }
});

root.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  if (form.dataset.form === "search") {
    state.searchQuery = String(data.get("query") ?? "").trim();
    state.page = "search";
    history.replaceState(null, "", "#search");
    await loadPageData();
    return;
  }
  if (form.dataset.form !== "compose") return;
  const values = Object.fromEntries(["senderId", "name", "subject", "body", "startAt", "delayMs", "hourlyLimit"].map((key) => [key, String(data.get(key) ?? "").trim()]));
  for (const key of Object.keys(values)) state.compose[key] = values[key];
  const delayMs = Number(values.delayMs);
  const hourlyLimit = Number(values.hourlyLimit);
  const startDate = new Date(values.startAt);
  state.error = validateScheduleDraft({
    senderId: values.senderId,
    senderIds: state.senders.map((sender) => sender.id),
    recipients: state.recipients,
    subject: values.subject,
    body: values.body,
    delayMs,
    hourlyLimit,
    startAt: startDate,
  });
  if (state.error) { render(); return; }
  if (!state.scheduleRequestId) state.scheduleRequestId = crypto.randomUUID();
  state.scheduling = true;
  state.scheduleMessage = "";
  render();
  try {
    const result = await api.scheduleCampaign({
      requestId: state.scheduleRequestId,
      senderId: values.senderId,
      name: values.name || null,
      subject: values.subject,
      body: values.body,
      recipients: state.recipients,
      startAt: startDate.toISOString(),
      delayMs,
      hourlyLimit,
    });
    state.scheduleMessage = `Scheduled ${result.jobs.length} email${result.jobs.length === 1 ? "" : "s"}.`;
    state.scheduleRequestId = null;
    state.error = "";
    state.compose = createComposeDraft();
    state.recipients = [];
    state.recipientInput = "";
    state.fileStats = null;
    state.fileError = "";
    try {
      const upcoming = await api.scheduledEmails();
      state.scheduled = upcoming.items;
      state.scheduledTotal = upcoming.total;
    } catch {
      state.error = "Emails were scheduled, but the scheduled list could not be refreshed. Open Scheduled to retry.";
    }
  } catch (error) {
    showError(error);
  } finally {
    state.scheduling = false;
    render();
  }
});

window.setInterval(() => { void refreshEmailActivity(); }, 5000);

window.addEventListener("hashchange", () => {
  const page = location.hash.slice(1);
  if (page && page !== state.page) navigate(page);
});

render();
void loadSession();
