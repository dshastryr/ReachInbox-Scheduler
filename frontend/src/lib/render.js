const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const date = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
export const NAV_ITEMS = [
  ["dashboard", "Overview", "▦"], ["scheduled", "Scheduled", "◷"], ["sent", "Sent emails", "✉"],
  ["campaigns", "Campaigns", "◉"], ["compose", "Compose", "＋"], ["search", "Search", "⌕"],
  ["integrations", "Integrations", "⌘"], ["settings", "Settings", "⚙"],
];

function avatar(user, className = "avatar") {
  const safeImage = (() => {
    try { const url = new URL(user?.avatarUrl); return url.protocol === "https:" ? url.href : ""; }
    catch { return ""; }
  })();
  const initials = user?.name?.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "RI";
  return safeImage ? `<img class="${className}" src="${escapeHtml(safeImage)}" alt="" referrerpolicy="no-referrer"/>` : `<span class="${className}">${escapeHtml(initials)}</span>`;
}

function header(user, page) {
  const title = NAV_ITEMS.find(([id]) => id === page)?.[1] ?? "Email detail";
  return `<header class="topbar"><button class="mobile-menu" data-action="toggle-menu" aria-label="Toggle navigation">☰</button><div class="crumb"><span>Workspace</span><b>/</b><strong>${escapeHtml(title)}</strong></div><div class="topbar-right"><button class="user-chip" data-page="settings">${avatar(user)}<span class="user-details"><b>${escapeHtml(user.name)}</b><small>${escapeHtml(user.email)}</small></span></button><button class="button button-quiet logout-button" data-action="logout">Log out</button></div></header>`;
}

function sidebar(page) {
  const active = page === "email-detail" ? "sent" : page;
  return `<aside class="sidebar"><a class="brand" href="#dashboard" data-page="dashboard"><span class="brand-mark">r</span><span>reachinbox</span></a><div class="workspace-switch"><span class="workspace-icon">R</span><span><b>ReachInbox</b><small>Personal workspace</small></span><span class="chevron">⌄</span></div><p class="nav-label">WORKSPACE</p><nav>${NAV_ITEMS.map(([id, label, icon]) => `<button class="nav-item ${active === id ? "active" : ""}" data-page="${id}"><span class="nav-icon">${icon}</span><span>${label}</span>${id === "compose" ? "<span class=\"nav-plus\">↗</span>" : ""}</button>`).join("")}</nav><div class="sidebar-bottom"><div class="help-card"><span class="help-icon">?</span><span><b>ReachInbox Scheduler</b><small>Manage your email workflow</small></span></div><div class="sidebar-foot"><span class="online-dot"></span>Workspace connected</div></div></aside>`;
}

function statusBadge(status) {
  const known = ["SCHEDULED", "PROCESSING", "SENT", "FAILED"].includes(status) ? status : "UNKNOWN";
  return `<span class="status status-${known.toLowerCase()}"><i></i>${escapeHtml(known === "UNKNOWN" ? "Unavailable" : known.charAt(0) + known.slice(1).toLowerCase())}</span>`;
}

function loginPage({ authLoading, authError }) {
  return `<main class="login-page"><div class="login-top"><a class="brand" href="#"><span class="brand-mark">r</span><span>reachinbox</span></a><span>EMAIL SCHEDULER</span></div><section class="login-card"><div class="login-art"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="login-envelope">✉</div><span class="float-dot dot-one"></span><span class="float-dot dot-two"></span><span class="float-dot dot-three"></span></div><div class="eyebrow">YOUR WORKSPACE, IN SYNC</div><h1>Welcome to ReachInbox</h1><p>Sign in to organize your outreach, schedule emails, and keep every conversation moving.</p>${authError ? `<div class="error-banner" role="alert"><span>!</span><div><b>Sign-in didn’t finish</b><p>${escapeHtml(authError)}</p></div></div>` : ""}<button class="button google-login" data-action="google-login" ${authLoading ? "disabled" : ""}><span class="google-g">G</span>${authLoading ? "Checking your session…" : "Continue with Google"}<span class="login-arrow">↗</span></button><div class="login-security"><span>▣</span> Secure sign-in with Google <i></i> No passwords stored here</div><small>By continuing, you agree to use ReachInbox responsibly.</small></section><footer class="login-footer">© ReachInbox Scheduler <span>Built for thoughtful outreach</span></footer></main>`;
}

function errorBox(error) {
  return error ? `<div class="error-banner" role="alert"><span>!</span><div><b>Something went wrong</b><p>${escapeHtml(error)}</p></div><button data-action="retry" aria-label="Retry">↻</button></div>` : "";
}

function emptyState(icon, title, description) {
  return `<div class="empty-state"><span class="empty-art">${icon}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div>`;
}

function statCard(label, value, detail, icon, color) {
  return `<article class="stat-card"><div class="stat-label">${label}<span class="stat-icon ${color}">${icon}</span></div><strong>${value}</strong><small>${detail}</small></article>`;
}

function emailTable(items, { loading = false, emptyMessage = "No emails yet.", emptyDescription = "Messages will appear here when they are available." } = {}) {
  if (loading) return `<div class="loading-state"><span class="spinner"></span>Loading emails…</div>`;
  if (!items?.length) return emptyState("✉", emptyMessage, emptyDescription);
  return `<div class="table-scroll"><table class="data-table"><thead><tr><th>Email</th><th>Subject</th><th>Campaign</th><th>Status</th><th>Scheduled time</th><th>Sent time</th><th>Created</th></tr></thead><tbody>${items.map((item) => `<tr class="clickable-row" data-open-email="${escapeHtml(item.id)}"><td><div class="recipient-cell"><span class="mini-avatar">${escapeHtml((item.recipientEmail || "?")[0].toUpperCase())}</span><span>${escapeHtml(item.recipientEmail)}</span></div></td><td class="subject-cell">${escapeHtml(item.subject)}</td><td>${escapeHtml(item.campaign?.name || "—")}</td><td>${statusBadge(item.status)}</td><td>${date(item.scheduledAt)}</td><td>${date(item.sentAt)}</td><td>${date(item.createdAt)}</td></tr>`).join("")}</tbody></table></div>`;
}

function scheduleTable(items, loading) {
  if (loading) return `<div class="loading-state"><span class="spinner"></span>Loading scheduled emails…</div>`;
  if (!items?.length) return emptyState("◷", "Nothing scheduled yet.", "Compose an email and schedule it to see it here.");
  return `<div class="table-scroll"><table class="data-table"><thead><tr><th>Email</th><th>Subject</th><th>Scheduled time</th><th>Status</th></tr></thead><tbody>${items.map((item) => `<tr class="clickable-row" data-open-email="${escapeHtml(item.id)}"><td>${escapeHtml(item.recipientEmail)}</td><td>${escapeHtml(item.subject)}</td><td>${date(item.scheduledAt)}</td><td>${statusBadge(item.status)}</td></tr>`).join("")}</tbody></table></div>`;
}

function emailHistoryTable(items, { loading = false, emptyMessage = "No delivery history yet.", emptyDescription = "Sent and failed messages will appear here." } = {}) {
  if (loading) return `<div class="loading-state"><span class="spinner"></span>Loading sent emails…</div>`;
  if (!items?.length) return emptyState("✉", emptyMessage, emptyDescription);
  return `<div class="table-scroll"><table class="data-table"><thead><tr><th>Email</th><th>Subject</th><th>Sent time</th><th>Status</th></tr></thead><tbody>${items.map((item) => {
    const activityAt = item.sentAt ?? item.failedAt;
    const failure = item.status === "FAILED" && item.failureReason
      ? `<small class="failure-detail">${escapeHtml(item.failureReason)}</small>`
      : "";
    return `<tr class="clickable-row" data-open-email="${escapeHtml(item.id)}"><td><div class="recipient-cell"><span class="mini-avatar">${escapeHtml((item.recipientEmail || "?")[0].toUpperCase())}</span><span>${escapeHtml(item.recipientEmail)}</span></div></td><td class="subject-cell">${escapeHtml(item.subject)}</td><td>${date(activityAt)}${failure}</td><td>${statusBadge(item.status)}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function campaignTable(campaigns, loading) {
  if (loading) return `<div class="loading-state"><span class="spinner"></span>Loading campaigns…</div>`;
  if (!campaigns?.length) return emptyState("◷", "No campaigns yet.", "Schedule an email to create your first campaign.");
  return `<div class="table-scroll"><table class="data-table"><thead><tr><th>Campaign</th><th>Subject</th><th>Status</th><th>Start time</th><th>Delay</th><th>Hourly limit</th></tr></thead><tbody>${campaigns.map((campaign) => `<tr><td><b>${escapeHtml(campaign.name || "Untitled campaign")}</b></td><td>${escapeHtml(campaign.subject)}</td><td><span class="status status-neutral"><i></i>Not provided</span></td><td>${date(campaign.startAt)}</td><td>${escapeHtml(campaign.delayMs)} ms</td><td>${escapeHtml(campaign.hourlyLimit)}</td></tr>`).join("")}</tbody></table></div>`;
}

function recipientsMarkup(recipients = []) {
  return recipients.map((email, index) => `<span class="recipient-chip">${escapeHtml(email)}<button type="button" data-remove-recipient="${index}" aria-label="Remove ${escapeHtml(email)}">×</button></span>`).join("");
}

function composePage(state) {
  const startAt = state.compose?.startAt ?? "";
  const recipients = state.recipients ?? [];
  return `<div class="compose-heading"><button class="back-button" data-page="dashboard">← <span>Back</span></button><div><div class="eyebrow">CAMPAIGN BUILDER</div><h1>Compose New Email</h1><p>Prepare your message and choose when it should reach your recipients.</p></div></div>${errorBox(state.error)}<form class="compose-card" data-form="compose" novalidate><div class="compose-grid"><label class="field-label">From <span class="required">*</span><select name="senderId" required><option value="">Select a sender</option>${(state.senders ?? []).map((sender) => `<option value="${escapeHtml(sender.id)}" ${state.compose?.senderId === sender.id ? "selected" : ""}>${escapeHtml(sender.name)} · ${escapeHtml(sender.email)}</option>`).join("")}</select>${!state.senders?.length && !state.loading ? `<small class="field-help">No sender accounts found. Add one before scheduling.</small>` : ""}</label><label class="field-label">Campaign name<input name="name" value="${escapeHtml(state.compose?.name ?? "")}" placeholder="Optional campaign name"/></label></div><div class="compose-section"><label class="field-label">To <span class="required">*</span></label><div class="recipient-box"><div class="recipient-chips">${recipientsMarkup(recipients)}<input name="recipientInput" value="${escapeHtml(state.recipientInput ?? "")}" placeholder="Add an email address…" autocomplete="off"/></div><button class="button button-outline upload-trigger" type="button" data-action="choose-file">↑ Upload list</button><input class="visually-hidden" id="lead-file" type="file" accept=".csv,.txt,text/csv,text/plain"/></div><div class="recipient-meta"><span>${recipients.length} recipient${recipients.length === 1 ? "" : "s"} detected</span>${state.fileStats ? `<span>${state.fileStats.duplicates} duplicate${state.fileStats.duplicates === 1 ? "" : "s"} skipped · ${state.fileStats.invalid} invalid ignored</span>` : ""}<button type="button" class="text-button" data-action="add-recipient">Add recipient</button></div>${state.fileError ? `<p class="field-error">${escapeHtml(state.fileError)}</p>` : ""}</div><div class="compose-section"><label class="field-label">Subject <span class="required">*</span><input name="subject" value="${escapeHtml(state.compose?.subject ?? "")}" placeholder="Give your email a clear subject" required/></label></div><div class="compose-grid timing-grid"><label class="field-label">Delay between emails <span class="required">*</span><div class="input-suffix"><input name="delayMs" type="number" min="0" step="1" value="${escapeHtml(state.compose?.delayMs ?? 5000)}" required/><span>milliseconds</span></div><small class="field-help">Minimum spacing also respects your hourly limit.</small></label><label class="field-label">Hourly limit <span class="required">*</span><div class="input-suffix"><input name="hourlyLimit" type="number" min="1" step="1" value="${escapeHtml(state.compose?.hourlyLimit ?? 100)}" required/><span>emails / hour</span></div></label></div><div class="compose-section"><label class="field-label">Email body <span class="required">*</span><div class="editor-toolbar"><button type="button" title="Bold"><b>B</b></button><button type="button" title="Italic"><i>I</i></button><button type="button" title="Underline"><u>U</u></button><span></span><button type="button" title="Bulleted list">•≡</button><button type="button" title="Link">↗</button></div><textarea name="body" rows="8" placeholder="Write your email…" required>${escapeHtml(state.compose?.body ?? "")}</textarea></label></div><div class="compose-footer"><div class="send-later"><span class="calendar-icon">▦</span><label>Send later <input name="startAt" type="datetime-local" value="${escapeHtml(startAt)}" required/></label></div><button class="button button-primary schedule-button" type="submit" ${state.scheduling ? "disabled" : ""}>${state.scheduling ? "Scheduling…" : "Schedule emails"}<span>→</span></button></div>${state.scheduleMessage ? `<p class="success-message" role="status">${escapeHtml(state.scheduleMessage)}</p>` : ""}</form>`;
}

export function renderDashboard(state = {}) {
  if (!state.user) return loginPage(state);
  const { user, page = "dashboard", emails = [], emailTotal, campaigns = [], scheduled = [], senders = [], slack, loading = false, error = "" } = state;
  let content = "";
  if (page === "dashboard") {
    const stats = state.emailStats;
    const metric = (value) => loading ? "···" : value ?? "—";
    content = `<div class="page-heading"><div><div class="eyebrow">WORKSPACE OVERVIEW</div><h1>Good to see you, ${escapeHtml(user.name.split(" ")[0])} <span class="wave">✦</span></h1><p>Your outreach activity at a glance.</p></div><button class="button button-primary" data-page="compose">＋ Compose email</button></div>${errorBox(error)}<section class="stats-grid">${statCard("Total emails", metric(stats?.total), "All EmailJobs", "✉", "icon-blue")}${statCard("Scheduled", metric(stats?.scheduled), "Waiting to send", "◷", "icon-purple")}${statCard("Processing", metric(stats?.processing), "Being delivered", "⟳", "icon-amber")}${statCard("Sent", metric(stats?.sent), "Successfully delivered", "↗", "icon-green")}${statCard("Failed", metric(stats?.failed), "Delivery attempts failed", "!", "icon-rose")}</section><section class="panel table-panel"><div class="panel-heading"><div><h2>Upcoming emails</h2><p>Your next scheduled messages</p></div><button class="button button-quiet" data-page="scheduled">View schedule →</button></div>${scheduleTable(scheduled.slice(0, 5), loading)}</section>`;
  } else if (page === "scheduled") {
    content = `<div class="page-heading"><div><div class="eyebrow">EMAIL ACTIVITY</div><h1>Scheduled emails</h1><p>Track messages waiting or currently being sent.</p></div><button class="button button-primary" data-page="compose">＋ Compose email</button></div>${errorBox(error)}<section class="panel table-panel"><div class="panel-heading"><div><h2>Upcoming schedule</h2><p>${loading ? "Loading…" : `${state.scheduledTotal ?? scheduled.length} scheduled emails`}${!loading && scheduled.length >= 500 ? " · showing first 500" : ""}</p></div></div>${scheduleTable(scheduled, loading)}</section>`;
  } else if (page === "sent" || page === "emails") {
    content = `<div class="page-heading"><div><div class="eyebrow">EMAIL ACTIVITY</div><h1>Sent emails</h1><p>Delivery history, including failed attempts.</p></div></div>${errorBox(error)}<section class="panel table-panel"><div class="panel-heading"><div><h2>Delivery history</h2><p>${emailTotal ?? 0} messages</p></div><button class="button button-quiet" data-page="search">Search messages ⌕</button></div>${emailHistoryTable(emails, { loading, emptyMessage: "No delivery history yet.", emptyDescription: "Sent and failed messages will appear here." })}</section>`;
  } else if (page === "campaigns") {
    content = `<div class="page-heading"><div><div class="eyebrow">OUTREACH</div><h1>Campaigns</h1><p>Your scheduled campaign plans, sorted by start time.</p></div><button class="button button-primary" data-page="compose">＋ Schedule email</button></div>${errorBox(error)}<section class="panel table-panel"><div class="panel-heading"><div><h2>All campaigns</h2><p>${loading ? "Loading…" : `${campaigns.length} campaigns`}</p></div></div>${campaignTable(campaigns, loading)}</section>`;
  } else if (page === "compose") {
    content = composePage(state);
  } else if (page === "search") {
    content = `<div class="page-heading"><div><div class="eyebrow">FIND A MESSAGE</div><h1>Search sent emails</h1><p>Search by subject, recipient, sender, campaign, or body.</p></div></div>${errorBox(error)}<section class="search-panel"><form data-form="search" class="search-form"><span class="search-symbol">⌕</span><input name="query" value="${escapeHtml(state.searchQuery ?? "")}" placeholder="Try a subject, recipient, or keyword…" aria-label="Search sent emails"/><button class="button button-primary" type="submit">Search</button></form><p class="search-hint">Search is scoped to your account and only includes sent messages.</p></section>${state.searchQuery ? `<section class="panel table-panel"><div class="panel-heading"><div><h2>Results for “${escapeHtml(state.searchQuery)}”</h2><p>${emailTotal ?? 0} results</p></div></div>${emailTable(emails, { loading, emptyMessage: "No sent emails match your search." })}</section>` : emptyState("⌕", "Find a message", "Enter a recipient, subject, or phrase to get started.")}`;
  } else if (page === "integrations") {
    content = `<div class="page-heading"><div><div class="eyebrow">CONNECTED TOOLS</div><h1>Integrations</h1><p>Connect the services that keep your workflow moving.</p></div></div>${errorBox(error)}<div class="integration-grid"><article class="panel integration-card"><div class="integration-logo google-logo">G</div><div class="integration-main"><div class="integration-title"><h2>Google</h2><span class="status status-sent"><i></i>Signed in</span></div><p>Authenticated as ${escapeHtml(user.email)}. Your Google OAuth tokens remain on the backend.</p><button class="button button-secondary" data-action="logout">Sign out</button></div></article><article class="panel integration-card"><div class="integration-logo slack-logo">#</div><div class="integration-main"><div class="integration-title"><h2>Slack</h2>${slack?.connected ? `<span class="status status-sent"><i></i>Connected</span>` : `<span class="status status-neutral"><i></i>${slack ? "Not connected" : "Status unavailable"}</span>`}</div><p>${slack?.connected ? `Connected to ${escapeHtml(slack.teamName || "your workspace")}. Access token remains private.` : "Send delivery updates to your configured Slack workspace."}</p><div class="integration-actions">${slack?.connected ? `<button class="button button-secondary" data-action="disconnect-slack">Disconnect</button>` : `<button class="button button-secondary" data-action="connect-slack">Connect Slack ↗</button>`}</div></div></article></div>`;
  } else if (page === "settings") {
    const senderList = state.senders?.length
      ? `<div class="sender-list">${state.senders.map((sender) => `<article class="sender-item"><div><b>${escapeHtml(sender.name)}</b><span>${escapeHtml(sender.email)}</span></div><small>${escapeHtml(sender.smtpHost)} · port ${escapeHtml(sender.smtpPort)}</small></article>`).join("")}</div>`
      : `<p class="sender-empty">No sender accounts configured yet. Add an SMTP account below to use it in Compose.</p>`;
    const draft = state.senderDraft ?? {};
    content = `<div class="page-heading"><div><div class="eyebrow">PREFERENCES</div><h1>Settings</h1><p>Your account and outgoing mail configuration.</p></div></div><section class="panel settings-panel"><div class="settings-row identity-row">${avatar(user, "profile-avatar")}<div><h2>${escapeHtml(user.name)}</h2><p>${escapeHtml(user.email)}</p></div><button class="button button-quiet" data-action="logout">Log out</button></div><div class="settings-row"><div><h2>Account created</h2><p>${date(user.createdAt)}</p></div><span class="status status-sent"><i></i>Google authenticated</span></div></section><section class="panel sender-settings"><div class="sender-settings-heading"><div><h2>Sender accounts</h2><p>Saved for your account. SMTP passwords are never returned to the browser.</p></div><span class="status status-neutral">${state.senders?.length ?? 0} configured</span></div>${senderList}<form class="sender-form" data-form="sender"><h3>Add an SMTP sender</h3><div class="sender-form-grid"><label class="field-label">Display name<input name="name" value="${escapeHtml(draft.name ?? "")}" autocomplete="organization-title" required/></label><label class="field-label">Sender email<input name="email" type="email" value="${escapeHtml(draft.email ?? "")}" autocomplete="email" required/></label><label class="field-label">SMTP host<input name="smtpHost" value="${escapeHtml(draft.smtpHost ?? "smtp.ethereal.email")}" placeholder="smtp.ethereal.email" required/></label><label class="field-label">SMTP port<input name="smtpPort" type="number" min="1" max="65535" step="1" value="${escapeHtml(draft.smtpPort ?? "587")}" required/><small class="field-help">Port 465 uses implicit TLS; other ports use STARTTLS when supported (Ethereal: 587).</small></label><label class="field-label">SMTP username<input name="smtpUser" value="${escapeHtml(draft.smtpUser ?? "")}" autocomplete="username" required/></label><label class="field-label">SMTP password<input name="smtpPassword" type="password" autocomplete="new-password" required/><small class="field-help">Stored on the backend and omitted from sender API responses.</small></label></div><div class="sender-form-footer"><span class="field-help">Ethereal test accounts work here with their SMTP username and password.</span><button class="button button-primary" type="submit" ${state.senderSaving ? "disabled" : ""}>${state.senderSaving ? "Saving…" : "Save sender"}</button></div>${state.senderMessage ? `<p class="success-message" role="status">${escapeHtml(state.senderMessage)}</p>` : ""}</form></section>`;
  } else if (page === "email-detail") {
    const email = state.selectedEmail;
    content = email ? `<div class="page-heading"><div><button class="back-button" data-page="sent">← <span>Sent emails</span></button><h1>${escapeHtml(email.subject)}</h1></div>${statusBadge(email.status)}</div><article class="panel detail-panel"><div class="detail-line"><span>To</span><b>${escapeHtml(email.recipientEmail)}</b></div><div class="detail-line"><span>From</span><b>${escapeHtml(email.sender?.email)}</b></div><div class="detail-line"><span>${email.status === "FAILED" ? "Failed" : "Sent"}</span><b>${date(email.sentAt ?? email.failedAt)}</b></div>${email.status === "FAILED" && email.failureReason ? `<div class="detail-line"><span>Reason</span><b>${escapeHtml(email.failureReason)}</b></div>` : ""}<hr/><div class="email-body">${escapeHtml(email.body).replace(/\n/g, "<br>")}</div></article>` : `${errorBox(error)}${emptyState("✉", "Email not found", "This email may no longer be available.")}`;
  }
  return `<div class="app-shell">${sidebar(page)}<main class="main-area">${header(user, page)}<div class="page-content">${content}</div><footer class="app-footer"><span>ReachInbox Scheduler</span><span>Thoughtful email, on your schedule.</span></footer></main><div class="mobile-scrim" data-action="close-menu"></div></div>`;
}

export { statusBadge, emailTable, emailHistoryTable, scheduleTable, campaignTable };
