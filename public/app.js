let CURRENT_SESSION = null; // null | { type: 'member', member } | { type: 'staff', staff }
let LADDER_DATA = null;
let EVENTS_DATA = [];
let NEWS_DATA = [];
let SPOTLIGHTS_DATA = [];
let COMMUNITY_STATS = null;
let MEMBERS_DATA = []; // admin: full member roster, for the Members card (import/export/invite)
// Admin-controlled feature toggle: whether the points system (balance,
// Redemption Ladder tab, points mentions on registration) is shown to
// members. Points still accumulate server-side regardless.
let SETTINGS = {
  pointsVisibleToMembers: true,
  theme: { primaryColor: "#8B0000", primaryColorDark: "#650000", accentColor: "#C9A227", logoUrl: "" },
};
function pointsVisible() {
  return !!(SETTINGS && SETTINGS.pointsVisibleToMembers);
}

// ----------------------------------------------------------------- utils --
// Exact server-side messages that mean "your session cookie no longer maps
// to a live session" (as opposed to e.g. a wrong password, which is also a
// 401 but not a session problem). Used below to recognize a session that
// died server-side - most commonly because the server restarted (every
// deploy does this) and, since sessions used to live only in memory, wiped
// everyone's login. Sessions now persist across restarts (see server.js),
// but a session can still legitimately expire after its 7-day TTL, so this
// handling stays regardless.
const SESSION_EXPIRED_MESSAGES = new Set(["Please sign in", "Please log in", "Not signed in"]);
// True once we've already flipped the UI back to a logged-out state for the
// *current* staleness - reset the moment a fresh login happens (see
// checkSession/staff-login/member-login) - so a burst of requests that all
// fail at once (e.g. the six-odd calls admin's initial load fires) shows the
// user one clear "please log in again" moment instead of repeatedly
// clobbering whatever they're doing.
let SESSION_EXPIRY_HANDLED = false;
function handleSessionExpired() {
  if (SESSION_EXPIRY_HANDLED) return;
  SESSION_EXPIRY_HANDLED = true;
  CURRENT_SESSION = null;
  if (typeof updateUIForSession === "function") updateUIForSession();
  // updateUIForSession() just switched the Admin/Gate Scanner tabs back to
  // their sign-in screens - leave the reason sitting right there on the
  // login form itself (rather than only on whatever card the failed request
  // happened to be on), so a returning admin sees why they were logged out
  // instead of an unexplained empty login box.
  ["admin-lock-msg", "scan-lock-msg"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) showMsg(el, t("errSessionExpired"), false);
  });
}
async function api(path, opts = {}) {
  // FormData bodies (photo uploads) must NOT get a manual Content-Type - the
  // browser needs to set its own multipart boundary, or the server can't
  // parse the upload at all.
  const isFormData = typeof FormData !== "undefined" && opts.body instanceof FormData;
  const headers = isFormData
    ? opts.headers || {}
    : Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  const res = await fetch(path, Object.assign({ credentials: "include" }, opts, { headers }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const isSessionExpiry = res.status === 401 && SESSION_EXPIRED_MESSAGES.has(data.error);
    // Keep the full response body on the thrown error (not just .message) -
    // some error responses (e.g. "already registered") carry extra fields
    // like a still-valid QR code that callers want to use instead of just
    // showing the error text.
    const err = new Error(isSessionExpiry ? t("errSessionExpired") : data.error || t("errGeneric"));
    err.data = data;
    err.sessionExpired = isSessionExpiry;
    if (isSessionExpiry) handleSessionExpired();
    throw err;
  }
  return data;
}
function showMsg(el, text, ok) {
  el.textContent = text;
  el.classList.remove("ok", "err");
  el.classList.add("show", ok ? "ok" : "err");
}
function fmt(n) {
  return Number(n || 0).toLocaleString(currentLang === "ar" ? "ar-EG" : "en-US");
}
// Plain-text event name for compact contexts (dropdowns, admin tables,
// buttons) where HTML markup isn't rendered. Always shows the Arabic name
// first, then the English name, regardless of the site's current EN/AR
// toggle (which still controls all the surrounding UI text) - falls back
// to whichever single language is actually filled in.
function eventLabel(ev) {
  const ar = (ev.nameAr || "").trim();
  const en = (ev.nameEn || "").trim();
  if (ar && en && ar !== en) return `${ar} / ${en}`;
  return ar || en;
}
// Two-line HTML version for headings (card titles, modal title) - Arabic
// on its own line first, English below it.
function eventNameHtml(ev) {
  const ar = (ev.nameAr || "").trim();
  const en = (ev.nameEn || "").trim();
  if (ar && en && ar !== en) {
    return `<span class="lang-ar" dir="rtl">${escapeAttr(ar)}</span><span class="lang-en">${escapeAttr(en)}</span>`;
  }
  return escapeAttr(ar || en);
}
function ladderLabel(tier) {
  return currentLang === "ar" ? tier.rewardAr : tier.rewardEn;
}
function ladderDesc(tier) {
  return currentLang === "ar" ? tier.descAr : tier.descEn;
}
function ladderApprover(tier) {
  return currentLang === "ar" ? tier.approverAr : tier.approverEn;
}
function escapeAttr(str) {
  return String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
// The date an event is actually over - a multi-day event (endDate set)
// isn't done until its end date passes, not its start date.
function eventEndDate(ev) {
  return ev.endDate || ev.date;
}
function isUpcoming(ev) {
  return eventEndDate(ev) >= todayStr();
}
function isPastEvent(ev) {
  return eventEndDate(ev) < todayStr();
}
// Full weekday name for a "YYYY-MM-DD" date string, in the current
// language. Anchors to local midnight (rather than parsing the bare date
// string, which JS treats as UTC) so the weekday can't shift by a day
// depending on the viewer's timezone.
function weekdayName(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(currentLang === "ar" ? "ar-EG" : "en-US", { weekday: "long" });
}
// "18:30" -> "6:30 PM" (or the Arabic equivalent) for display.
function formatTimeOfDay(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return "";
  const d = new Date(2000, 0, 1, h, m);
  return d.toLocaleTimeString(currentLang === "ar" ? "ar-EG" : "en-US", { hour: "numeric", minute: "2-digit" });
}
// How long between a start and end "HH:MM" time, as a short label like "3h"
// or "1h 30m". Assumes the end time is later the same day unless it's
// numerically earlier, in which case it's treated as crossing midnight.
function timeDurationLabel(startTime, endTime) {
  if (!startTime || !endTime) return "";
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  if (![sh, sm, eh, em].every(Number.isFinite)) return "";
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
// Builds the full date/time line shown on an event card and in the details
// modal - weekday + date (and end date, for multi-day events) plus start/end
// time and the computed duration, wherever each piece is actually set.
// Everything here is optional except the start date, so this degrades
// gracefully back to a bare date for events that don't set any of it.
function eventDateTimeLabel(ev) {
  const wd = weekdayName(ev.date);
  let label = wd ? `${wd}, ${ev.date}` : ev.date;
  if (ev.endDate && ev.endDate !== ev.date) {
    const endWd = weekdayName(ev.endDate);
    label += ` – ${endWd ? endWd + ", " : ""}${ev.endDate}`;
  }
  if (ev.startTime) {
    label += ` · ${formatTimeOfDay(ev.startTime)}`;
    if (ev.endTime) {
      const dur = timeDurationLabel(ev.startTime, ev.endTime);
      label += `–${formatTimeOfDay(ev.endTime)}${dur ? ` (${dur})` : ""}`;
    }
  }
  return label;
}
// Compact time-only label for an activity row nested under a parent card -
// the date is already shown once on the parent card, so activities only
// need their own start/end time (if set).
function activityTimeLabel(ev) {
  if (!ev.startTime) return "";
  if (!ev.endTime) return formatTimeOfDay(ev.startTime);
  const dur = timeDurationLabel(ev.startTime, ev.endTime);
  return `${formatTimeOfDay(ev.startTime)}–${formatTimeOfDay(ev.endTime)}${dur ? ` (${dur})` : ""}`;
}
// Converts a stored ISO deadline (e.g. "2026-08-20T18:30:00.000Z") back into
// the "YYYY-MM-DDTHH:mm" local-time format a <input type="datetime-local">
// expects, so the edit form can be pre-filled with the value that was saved.
function isoToDatetimeLocal(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// The reverse of isoToDatetimeLocal - converts a <input type="datetime-local">
// value back to ISO for the server. Guarded against throwing: a malformed or
// unsupported value (some browsers/autofill edge cases) should just be
// dropped instead of blowing up the whole save/submit handler before it
// even reaches the try/catch around the network call.
function datetimeLocalToIsoOrEmpty(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  return d.toISOString();
}
function truncate(str, n) {
  str = str || "";
  return str.length > n ? str.slice(0, n).trim() + "…" : str;
}
// Per-language description text (with the same "prefer this language, fall
// back to the other if it's blank" rule the old currentLang-based versions
// used) - kept as explicit-language helpers so callers can render both
// languages together instead of picking one based on the site's toggle.
function eventDescForLang(ev, lang) {
  return lang === "ar" ? ev.descriptionAr || ev.descriptionEn : ev.descriptionEn || ev.descriptionAr;
}
function eventRecapDescForLang(ev, lang) {
  const r = ev.recap || {};
  return lang === "ar" ? r.descriptionAr || r.descriptionEn : r.descriptionEn || r.descriptionAr;
}
// Bilingual HTML for the event's own description (used in the details
// modal's "About" section) - Arabic paragraph first, English below.
function eventDescHtml(ev) {
  const ar = (ev.descriptionAr || "").trim();
  const en = (ev.descriptionEn || "").trim();
  if (ar && en && ar !== en) {
    return `<span class="lang-ar" dir="rtl">${escapeAttr(ar)}</span><span class="lang-en">${escapeAttr(en)}</span>`;
  }
  return escapeAttr(ar || en);
}
// Bilingual HTML for the after-event recap write-up (modal "Recap" section).
function eventRecapDescHtml(ev) {
  const r = ev.recap || {};
  const ar = (r.descriptionAr || "").trim();
  const en = (r.descriptionEn || "").trim();
  if (ar && en && ar !== en) {
    return `<span class="lang-ar" dir="rtl">${escapeAttr(ar)}</span><span class="lang-en">${escapeAttr(en)}</span>`;
  }
  return escapeAttr(ar || en);
}
// Bilingual HTML for the event card's snippet - for a past event this
// prefers the recap write-up over the plain description in each language
// independently (mirroring the old blended currentLang logic), and
// truncates each language's text separately so the card stays a
// reasonable height.
function eventCardDescHtml(ev, isPast, maxLen) {
  const forLang = (lang) => (isPast ? eventRecapDescForLang(ev, lang) : "") || eventDescForLang(ev, lang) || "";
  let ar = forLang("ar").trim();
  let en = forLang("en").trim();
  if (maxLen) {
    ar = truncate(ar, maxLen);
    en = truncate(en, maxLen);
  }
  if (ar && en && ar !== en) {
    return `<span class="lang-ar" dir="rtl">${escapeAttr(ar)}</span><span class="lang-en">${escapeAttr(en)}</span>`;
  }
  return escapeAttr(ar || en);
}

// ------------------------------------------------------------------- tabs --
function switchTab(view) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
  // Re-fetch events whenever the landing page (or Annual Activities) is
  // opened, so any admin edit made elsewhere shows up without a full page
  // reload.
  if (view === "events" || view === "annual") loadEvents();
  if (view === "tournaments") {
    // A direct deep-link (goToEventTournament) sets this so we open that one
    // tournament's detail straight away, skipping the list load entirely -
    // otherwise the list load's own async refresh (refreshTournamentEventIds
    // awaits a fetch) can resolve afterward and flip the view back to the
    // list out from under the detail page that was just opened.
    if (PENDING_TOURNAMENT_EVENT_ID != null) {
      const id = PENDING_TOURNAMENT_EVENT_ID;
      PENDING_TOURNAMENT_EVENT_ID = null;
      openPublicTournament(id);
    } else {
      loadPublicTournamentsList();
    }
  }
  if (view === "mypoints" && CURRENT_SESSION && CURRENT_SESSION.type === "member") loadMyChat();
  if (view === "admin" && CURRENT_SESSION && CURRENT_SESSION.type === "staff" && CURRENT_SESSION.staff.role === "admin") {
    loadChatThreadsList();
  }
}
// While the Events or Annual Activities tab is the one on screen, keep
// polling for changes every 20s - so if an admin edits an event's details
// (or another committee member adds one) while someone already has the
// landing page open, it updates on its own instead of looking stale.
setInterval(() => {
  const eventsActive = document.getElementById("view-events").classList.contains("active");
  const annualActive = document.getElementById("view-annual").classList.contains("active");
  if (eventsActive || annualActive) loadEvents();
}, 20000);
// Support chat: poll fast (5s) for new messages while the relevant thread
// is actually on screen, so a back-and-forth conversation feels close to
// real time without needing websockets. Badge counts poll slower (20s)
// from anywhere in the app, so an unread reply is noticed even if the
// member/admin is off doing something else.
setInterval(() => {
  const isMember = CURRENT_SESSION && CURRENT_SESSION.type === "member";
  const isAdmin = CURRENT_SESSION && CURRENT_SESSION.type === "staff" && CURRENT_SESSION.staff.role === "admin";
  if (isMember && document.getElementById("view-mypoints").classList.contains("active")) loadMyChat();
  if (isAdmin && document.getElementById("view-admin").classList.contains("active") && ADMIN_CHAT_OPEN_MEMBERSHIP) {
    refreshOpenAdminChatThread();
  }
}, 5000);
setInterval(() => {
  updateMemberChatBadge();
  updateAdminChatBadge();
}, 20000);
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.view));
});

document.getElementById("lang-en").addEventListener("click", () => setLang("en"));
document.getElementById("lang-ar").addEventListener("click", () => setLang("ar"));
function setLang(lang) {
  currentLang = lang;
  applyI18n();
  renderEventDropdowns();
  renderEventsGrid();
  renderAnnualGrid();
  renderFeaturedEvents();
  renderNewsList(NEWS_DATA);
  renderSpotlightGrid(SPOTLIGHTS_DATA);
  renderCommunityStats(COMMUNITY_STATS);
  renderLadder();
  if (document.getElementById("mp-result").classList.contains("hidden") === false) {
    renderTierDropdown();
  }
  if (CURRENT_SESSION && CURRENT_SESSION.type === "member") {
    renderAttendeesChecklist();
    renderFamilyList();
    loadMyRegistrations();
    // Same "don't mark as read unless the tab is actually open" guard as
    // updateUIForSession() - a language toggle shouldn't silently clear
    // the unread badge either.
    if (document.getElementById("view-mypoints").classList.contains("active")) loadMyChat();
  }
  if (
    CURRENT_SESSION &&
    CURRENT_SESSION.type === "staff" &&
    CURRENT_SESSION.staff.role === "admin" &&
    document.getElementById("view-admin").classList.contains("active")
  ) {
    loadAdminDashboard();
    renderMembersInviteEventDropdown();
    renderMembersTable();
    renderDirectoryTable();
  }
  if (ADMIN_CHAT_OPEN_MEMBERSHIP) refreshOpenAdminChatThread();
  updateSessionBadge();
}

// -------------------------------------------------------------- settings --
async function loadSettings() {
  try {
    SETTINGS = await api("/api/settings");
  } catch (e) {
    /* keep the previous/default value if this fails - not worth blocking the whole app over */
  }
  applySettingsToUI();
}
function applySettingsToUI() {
  const show = pointsVisible();
  const ladderBtn = document.getElementById("tab-ladder-btn");
  if (ladderBtn) ladderBtn.classList.toggle("hidden", !show);
  const toggle = document.getElementById("settings-points-visible");
  if (toggle) toggle.checked = show;
  applyThemeToUI();
}

// Branding: colors are just CSS custom properties, so overriding them at
// runtime re-themes every page at once (header, buttons, badges, ladder,
// hero banners - anything already built on var(--red)/var(--gold)). The
// logo is a plain <img> shown in the header whenever one is set.
function applyThemeToUI() {
  const theme = (SETTINGS && SETTINGS.theme) || {};
  const root = document.documentElement.style;
  if (theme.primaryColor) root.setProperty("--red", theme.primaryColor);
  if (theme.primaryColorDark) root.setProperty("--red-dark", theme.primaryColorDark);
  if (theme.accentColor) root.setProperty("--gold", theme.accentColor);
  const logo = document.getElementById("site-logo");
  if (logo) {
    if (theme.logoUrl) {
      logo.src = theme.logoUrl;
      logo.classList.remove("hidden");
    } else {
      logo.removeAttribute("src");
      logo.classList.add("hidden");
    }
  }
  populateThemeAdminForm();
}

// Keeps the admin's color pickers/logo preview in sync with server truth -
// runs every time settings are (re)loaded, not just when the Admin tab is
// first opened, so it never shows a stale value after e.g. a language switch.
function populateThemeAdminForm() {
  const primaryInput = document.getElementById("theme-primary");
  const accentInput = document.getElementById("theme-accent");
  if (!primaryInput || !accentInput) return; // admin panel not in the DOM yet
  const theme = (SETTINGS && SETTINGS.theme) || {};
  primaryInput.value = theme.primaryColor || "#8B0000";
  accentInput.value = theme.accentColor || "#C9A227";
  const previewWrap = document.getElementById("theme-logo-preview-wrap");
  const preview = document.getElementById("theme-logo-preview");
  const removeBtn = document.getElementById("theme-remove-logo-btn");
  if (theme.logoUrl) {
    preview.src = theme.logoUrl;
    previewWrap.classList.remove("hidden");
    removeBtn.classList.remove("hidden");
  } else {
    previewWrap.classList.add("hidden");
    removeBtn.classList.add("hidden");
  }
}

// --------------------------------------------------------------- session --
async function checkSession() {
  try {
    const data = await api("/api/auth/me");
    CURRENT_SESSION = data;
    SESSION_EXPIRY_HANDLED = false;
  } catch (e) {
    CURRENT_SESSION = null;
  }
  updateUIForSession();
}

function updateSessionBadge() {
  const badge = document.getElementById("session-badge");
  const text = document.getElementById("session-badge-text");
  if (!CURRENT_SESSION) {
    badge.classList.add("hidden");
    return;
  }
  badge.classList.remove("hidden");
  if (CURRENT_SESSION.type === "member") {
    text.textContent = `${t("sessionAsMember")} ${CURRENT_SESSION.member.name} (#${CURRENT_SESSION.member.membershipNumber})`;
  } else {
    text.textContent = `${t("sessionAsStaff")} ${CURRENT_SESSION.staff.name} (${CURRENT_SESSION.staff.role})`;
  }
}

function updateUIForSession() {
  updateSessionBadge();
  const isMember = CURRENT_SESSION && CURRENT_SESSION.type === "member";
  const isStaff = CURRENT_SESSION && CURRENT_SESSION.type === "staff";
  const isAdmin = isStaff && CURRENT_SESSION.staff.role === "admin";

  // Register tab
  document.getElementById("reg-auth").classList.toggle("hidden", isMember);
  document.getElementById("reg-form").classList.toggle("hidden", !isMember);
  if (!isMember) document.getElementById("reg-qr-card").classList.add("hidden");
  if (isMember) {
    renderAttendeesChecklist();
    applyPendingEventSelection();
  }

  // My Points tab
  document.getElementById("mp-signed-out").classList.toggle("hidden", isMember);
  document.getElementById("mp-family-card").classList.toggle("hidden", !isMember);
  document.getElementById("mp-registrations-card").classList.toggle("hidden", !isMember);
  document.getElementById("mp-chat-card").classList.toggle("hidden", !isMember);
  if (isMember) {
    if (pointsVisible()) {
      document.getElementById("mp-points-disabled-note").classList.add("hidden");
      loadMyBalance();
    } else {
      document.getElementById("mp-result").classList.add("hidden");
      document.getElementById("mp-points-disabled-note").classList.remove("hidden");
    }
    renderFamilyList();
    loadMyRegistrations();
    // Only fetch (and thus mark-as-read) the chat thread if the Member
    // Profile tab is actually the one on screen - otherwise this would
    // silently clear the unread badge before the member ever saw it,
    // e.g. right after a plain page reload while sitting on another tab.
    if (document.getElementById("view-mypoints").classList.contains("active")) loadMyChat();
    updateMemberChatBadge();
  } else {
    document.getElementById("mp-result").classList.add("hidden");
    document.getElementById("mp-points-disabled-note").classList.add("hidden");
    document.getElementById("mp-chat-badge").classList.add("hidden");
  }

  // Gate Scanner tab
  document.getElementById("scan-lock").classList.toggle("hidden", isStaff);
  document.getElementById("scan-panel").classList.toggle("hidden", !isStaff);
  if (!isStaff) stopScanner();

  // Admin tab
  document.getElementById("admin-lock").classList.toggle("hidden", isStaff);
  document.getElementById("admin-denied").classList.toggle("hidden", !isStaff || isAdmin);
  document.getElementById("admin-panel").classList.toggle("hidden", !isAdmin);
  if (isAdmin) {
    initAdminTabs();
    loadAdminOverview();
    loadAdminDashboard();
    loadAdminMembers();
    loadAdminDirectory();
    loadRedemptionsTable();
    loadStaffAccountsTable();
    loadRulesForEdit();
    renderLadderEdit();
    loadChatThreadsList();
    updateAdminChatBadge();
    loadNewsAdminList();
    loadSpotlightAdminList();
    applySettingsToUI();
  } else {
    document.getElementById("admin-chat-badge").classList.add("hidden");
  }
}

document.getElementById("session-logout").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (e) {
    /* ignore */
  }
  CURRENT_SESSION = null;
  updateUIForSession();
});

// --------------------------------------------------------------- loading --
async function loadEvents() {
  EVENTS_DATA = await api("/api/events");
  await refreshTournamentEventIds();
  renderEventDropdowns();
  renderEventsGrid();
  renderAnnualGrid();
  renderFeaturedEvents();
  loadCommunityContent();
}
// Is this event a "parent" event day that has activities nested under it?
// Parent events with children are poster/wrapper cards only - members
// register for one of the individual activities, never for the parent.
function isParentEventWithChildren(ev) {
  return EVENTS_DATA.some((e) => e.parentEventId === ev.id);
}
function renderEventDropdowns() {
  // Members can only register for events that haven't happened yet. Full
  // events stay in the list (not hidden) - selecting one still works, it
  // just leads to a waiting-list offer instead of an instant confirmed spot.
  // Parent "event day" wrappers with activities under them are excluded -
  // there's nothing to directly register for on the parent itself.
  const upcoming = EVENTS_DATA.filter(isUpcoming);
  const regOpts = upcoming
    .filter((ev) => !isParentEventWithChildren(ev))
    .map(
      (ev) =>
        `<option value="${ev.id}">${eventLabel(ev)} — ${ev.date}${isEventFull(ev) ? " — " + t("badgeFull") : ""}</option>`
    )
    .join("");
  const regSel = document.getElementById("reg-event");
  const prevRegValue = regSel.value;
  regSel.innerHTML = regOpts || `<option value="">--</option>`;
  if (prevRegValue && Array.from(regSel.options).some((o) => o.value === prevRegValue)) regSel.value = prevRegValue;
  updateRegCapacityNote();

  const upcomingOpts = upcoming.map((ev) => `<option value="${ev.id}">${eventLabel(ev)} — ${ev.date}</option>`).join("");

  // Admins need every event (including past ones) to enter results.
  const allOpts = EVENTS_DATA.map((ev) => `<option value="${ev.id}">${eventLabel(ev)} — ${ev.date}</option>`).join("");
  const resSel = document.getElementById("res-event");
  if (resSel) resSel.innerHTML = allOpts || `<option value="">--</option>`;

  // Editing is only allowed up until an event's date has passed.
  const editSel = document.getElementById("ev-edit-select");
  if (editSel) editSel.innerHTML = upcomingOpts || `<option value="">--</option>`;

  // Deleting has no date lock - every event (new or old, standalone or
  // parent/activity) is selectable here, newest first.
  const deleteSel = document.getElementById("ev-delete-select");
  if (deleteSel) {
    const prevDeleteValue = deleteSel.value;
    const deleteOpts = EVENTS_DATA.slice()
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(
        (ev) =>
          `<option value="${ev.id}">${eventLabel(ev)} — ${ev.date}${isPastEvent(ev) ? ` — ${t("eventPast")}` : ""}</option>`
      )
      .join("");
    deleteSel.innerHTML = deleteOpts || `<option value="">--</option>`;
    if (prevDeleteValue && Array.from(deleteSel.options).some((o) => o.value === prevDeleteValue)) {
      deleteSel.value = prevDeleteValue;
    }
  }

  // Tournament: any event that isn't itself a parent-with-children (which
  // has no direct registrations of its own to run a tournament from),
  // upcoming or past.
  const tournSel = document.getElementById("tourn-event-select");
  if (tournSel) {
    const prevTournValue = tournSel.value;
    const tournOpts = EVENTS_DATA.filter((ev) => !isParentEventWithChildren(ev))
      .map((ev) => `<option value="${ev.id}">${eventLabel(ev)} — ${ev.date}</option>`)
      .join("");
    tournSel.innerHTML = tournOpts || `<option value="">--</option>`;
    if (prevTournValue && Array.from(tournSel.options).some((o) => o.value === prevTournValue)) {
      tournSel.value = prevTournValue;
    }
  }

  // Manual check-in roster (Gate Scanner tab): same "any event with its own
  // registrations" filter as the tournament dropdown above.
  const checkinSel = document.getElementById("checkin-event-select");
  if (checkinSel) {
    const prevCheckinValue = checkinSel.value;
    const checkinOpts = EVENTS_DATA.filter((ev) => !isParentEventWithChildren(ev))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((ev) => `<option value="${ev.id}">${eventLabel(ev)} — ${ev.date}</option>`)
      .join("");
    checkinSel.innerHTML = checkinOpts || `<option value="">--</option>`;
    if (prevCheckinValue && Array.from(checkinSel.options).some((o) => o.value === prevCheckinValue)) {
      checkinSel.value = prevCheckinValue;
    }
  }

  populateParentEventOptions();
}
// Fills the "Parent event" dropdowns on the Add/Edit event admin forms.
// Eligible parents are any event that is not itself a child of another
// event (keeps the hierarchy exactly 2 levels deep) - and, on the Edit
// form, never the event currently being edited (can't be its own parent),
// and never an event that already has activities under it (a parent can't
// also become a child).
function populateParentEventOptions() {
  const noneLabel = t("parentEventNone");
  const buildOptions = (excludeEventId) =>
    `<option value="">${escapeAttr(noneLabel)}</option>` +
    EVENTS_DATA.filter((ev) => !ev.parentEventId && ev.id !== excludeEventId)
      .map((ev) => `<option value="${ev.id}">${escapeAttr(eventLabel(ev))} — ${ev.date}</option>`)
      .join("");

  const addSel = document.getElementById("ev-parent-event");
  if (addSel) {
    const prev = addSel.value;
    addSel.innerHTML = buildOptions(null);
    if (prev && Array.from(addSel.options).some((o) => o.value === prev)) addSel.value = prev;
  }
  const editSel = document.getElementById("ev-edit-parent-event");
  if (editSel) {
    const fields = document.getElementById("ev-edit-fields");
    const editingId = fields && fields.dataset.eventId ? Number(fields.dataset.eventId) : null;
    const prev = editSel.value;
    editSel.innerHTML = buildOptions(editingId);
    if (prev && Array.from(editSel.options).some((o) => o.value === prev)) editSel.value = prev;
  }
}
// Shows a plain-language capacity status under the Register event picker
// ("14/20 registered", or a full/waiting-list note) for whichever event is
// currently selected.
function updateRegCapacityNote() {
  const note = document.getElementById("reg-capacity-note");
  if (!note) return;
  const sel = document.getElementById("reg-event");
  const ev = EVENTS_DATA.find((e) => e.id === Number(sel.value));
  if (!ev || ev.maxCapacity == null) {
    note.classList.add("hidden");
    return;
  }
  note.classList.remove("hidden");
  note.textContent = isEventFull(ev)
    ? t("regEventFullNote")
    : `${fmt(ev.confirmedCount || 0)}/${fmt(ev.maxCapacity)} ${t("regSpotsNote")}`;
}
document.getElementById("reg-event").addEventListener("change", updateRegCapacityNote);

// ------------------------------------------------------ events landing page --
// Small helper shared by the event cards and the Register dropdown: is this
// event at/over its admin-set maximum? (null maxCapacity = no limit.)
function isEventFull(ev) {
  return ev.maxCapacity != null && (ev.confirmedCount || 0) >= ev.maxCapacity;
}
function capacityBadgeHtml(ev) {
  if (ev.maxCapacity == null) return "";
  if (isEventFull(ev)) {
    return `<span class="capacity-badge full">${escapeAttr(t("badgeFull"))}</span>`;
  }
  return `<span class="capacity-badge ok">${fmt(ev.confirmedCount || 0)}/${fmt(ev.maxCapacity)}</span>`;
}
// Builds the inline "activities" list shown on a parent event day's card -
// one row per sub-activity, each with its own capacity badge and its own
// mini register button (registration is still per-activity, exactly as
// before - there's just no separate details page for it).
function activityRowsHtml(children, isPast) {
  return children
    .map((child) => {
      const timeLabel = activityTimeLabel(child);
      return `
      <div class="activity-row" data-child-id="${child.id}">
        <span class="activity-name">${escapeAttr(eventLabel(child))}${
        timeLabel ? ` <span class="activity-time">${escapeAttr(timeLabel)}</span>` : ""
      }</span>
        ${capacityBadgeHtml(child)}
        ${
          isPast
            ? ""
            : `<button class="secondary small" data-action="register-child" data-child-id="${child.id}">${t(
                "btnRegisterCard"
              )}</button>`
        }
      </div>`;
    })
    .join("");
}
function eventCardHtml(ev, isPast, featured) {
  const children = EVENTS_DATA.filter((e) => e.parentEventId === ev.id);
  const isParent = children.length > 0;
  const photo = isPast && ev.recap && ev.recap.photos && ev.recap.photos.length ? ev.recap.photos[0] : ev.coverPhoto;
  const photoStyle = photo ? ` style="background-image:url('${escapeAttr(photo)}')"` : "";
  return `
    <div class="event-card${isParent ? " event-card-parent" : ""}" data-event-id="${ev.id}">
      <div class="photo" data-action="details"${photoStyle}>${photo ? "" : escapeAttr(t("noPhoto"))}</div>
      <div class="body">
        ${featured ? `<span class="featured-tag">${escapeAttr(t("featuredEventsTitle"))}</span>` : ""}
        <h3 data-action="details">${eventNameHtml(ev)}</h3>
        <div class="meta">${escapeAttr(eventDateTimeLabel(ev))}${ev.sport ? " · " + escapeAttr(ev.sport) : ""} ${
    isParent ? "" : capacityBadgeHtml(ev)
  }</div>
        <div class="snippet">${eventCardDescHtml(ev, isPast, 110)}</div>
        ${
          isParent
            ? `<div class="activities-list"><div class="activities-title">${escapeAttr(
                t("activitiesTitle")
              )}</div>${activityRowsHtml(children, isPast)}</div>`
            : ""
        }
        <div class="actions">
          <button class="secondary" data-action="details">${t("btnMoreDetails")}</button>
          ${isPast || isParent ? "" : `<button class="primary" data-action="register">${t("btnRegisterCard")}</button>`}
          ${TOURNAMENT_EVENT_IDS.has(ev.id) ? `<button class="secondary" data-action="view-tournament">${t("btnViewTournament")}</button>` : ""}
        </div>
      </div>
    </div>`;
}
function wireEventCardButtons(grid, events, isPast) {
  grid.querySelectorAll(".event-card").forEach((card) => {
    const ev = events.find((e) => e.id === Number(card.dataset.eventId));
    if (!ev) return;
    card.querySelectorAll('[data-action="details"]').forEach((el) => {
      el.addEventListener("click", () => openEventModal(ev, isPast));
    });
    const regBtn = card.querySelector('[data-action="register"]');
    if (regBtn) regBtn.addEventListener("click", () => startRegisterFlow(ev));
    card.querySelectorAll('[data-action="register-child"]').forEach((btn) => {
      const child = EVENTS_DATA.find((e) => e.id === Number(btn.dataset.childId));
      if (child) btn.addEventListener("click", () => startRegisterFlow(child));
    });
    const tournBtn = card.querySelector('[data-action="view-tournament"]');
    if (tournBtn) tournBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      goToEventTournament(ev.id);
    });
  });
}
function renderEventsGrid() {
  const grid = document.getElementById("events-grid");
  const empty = document.getElementById("events-empty");
  if (!grid) return;
  // Sub-activities never get their own top-level card - they render nested
  // inside their parent event day's card instead.
  const upcoming = EVENTS_DATA.filter((ev) => isUpcoming(ev) && !ev.parentEventId).sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  empty.classList.toggle("hidden", upcoming.length > 0);
  grid.innerHTML = upcoming.map((ev) => eventCardHtml(ev, false)).join("");
  wireEventCardButtons(grid, upcoming, false);
}
function renderAnnualGrid() {
  const grid = document.getElementById("annual-grid");
  const empty = document.getElementById("annual-empty");
  if (!grid) return;
  const past = EVENTS_DATA.filter((ev) => isPastEvent(ev) && !ev.parentEventId).sort((a, b) =>
    b.date.localeCompare(a.date)
  );
  empty.classList.toggle("hidden", past.length > 0);
  grid.innerHTML = past.map((ev) => eventCardHtml(ev, true)).join("");
  wireEventCardButtons(grid, past, true);
}
// The 3 soonest upcoming events, featured prominently at the top of the
// landing page ("coming up next") - a subset of the same data as the full
// grid below, not a separate data source.
function renderFeaturedEvents() {
  const section = document.getElementById("featured-events-section");
  const grid = document.getElementById("featured-events-grid");
  if (!section || !grid) return;
  const upcoming = EVENTS_DATA.filter((ev) => isUpcoming(ev) && !ev.parentEventId).sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  const featured = upcoming.slice(0, 3);
  section.classList.toggle("hidden", featured.length === 0);
  grid.innerHTML = featured.map((ev) => eventCardHtml(ev, false, true)).join("");
  wireEventCardButtons(grid, featured, false);
}

// ------------------------------------------------------- committee news --
async function loadCommunityContent() {
  try {
    const [news, spotlights, stats] = await Promise.all([
      api("/api/news"),
      api("/api/spotlights"),
      api("/api/community-stats"),
    ]);
    NEWS_DATA = news;
    SPOTLIGHTS_DATA = spotlights;
    COMMUNITY_STATS = stats;
    renderNewsList(NEWS_DATA);
    renderSpotlightGrid(SPOTLIGHTS_DATA);
    renderCommunityStats(COMMUNITY_STATS);
  } catch (e) {
    /* landing page still works without news/spotlights/stats if this fails */
  }
}
// Deliberately no personal data beyond a name + points total here - this is
// meant to make the club feel alive (member count, events run, a small
// leaderboard), not a member directory.
function renderCommunityStats(stats) {
  const row = document.getElementById("community-stats-row");
  const earnersCard = document.getElementById("top-earners-card");
  const earnersList = document.getElementById("top-earners-list");
  if (!row || !stats) return;
  row.innerHTML = `
    <div class="stat"><div class="n">${fmt(stats.totalMembers)}</div><div class="l">${escapeAttr(t("statTotalMembers"))}</div></div>
    <div class="stat"><div class="n">${fmt(stats.eventsHeld)}</div><div class="l">${escapeAttr(t("statEventsHeld"))}</div></div>
  `;
  if (!stats.topEarners || !stats.topEarners.length) {
    earnersCard.classList.add("hidden");
    return;
  }
  earnersCard.classList.remove("hidden");
  earnersList.innerHTML = stats.topEarners
    .map(
      (m, i) => `<div class="top-earner-row">
        <div class="rank">${i + 1}</div>
        <div class="name">${escapeAttr(m.name)}</div>
        <div class="pts">${fmt(m.balance)}</div>
      </div>`
    )
    .join("");
}
function renderNewsList(posts) {
  const wrap = document.getElementById("news-list");
  const empty = document.getElementById("news-empty");
  if (!wrap) return;
  empty.classList.toggle("hidden", posts.length > 0);
  wrap.innerHTML = posts
    .map((p) => {
      const title = currentLang === "ar" ? p.titleAr || p.titleEn : p.titleEn || p.titleAr;
      const body = currentLang === "ar" ? p.bodyAr || p.bodyEn : p.bodyEn || p.bodyAr;
      const date = new Date(p.postedAt).toLocaleDateString(currentLang === "ar" ? "ar-EG" : "en-US");
      return `<div class="news-item">
        ${p.photo ? `<img class="photo" src="${escapeAttr(p.photo)}" alt="" />` : ""}
        <div class="body">
          <h3>${escapeAttr(title)}</h3>
          <div class="date">${escapeAttr(date)}</div>
          <div class="text">${escapeAttr(body)}</div>
        </div>
      </div>`;
    })
    .join("");
}
function renderSpotlightGrid(spotlights) {
  const wrap = document.getElementById("spotlight-grid");
  const empty = document.getElementById("spotlight-empty");
  if (!wrap) return;
  empty.classList.toggle("hidden", spotlights.length > 0);
  wrap.innerHTML = spotlights
    .map((s) => {
      const blurb = currentLang === "ar" ? s.blurbAr || s.blurbEn : s.blurbEn || s.blurbAr;
      const initial = (s.name || "?").trim().charAt(0).toUpperCase();
      return `<div class="spotlight-card">
        ${s.photo ? `<img class="avatar" src="${escapeAttr(s.photo)}" alt="" />` : `<div class="avatar">${escapeAttr(initial)}</div>`}
        <div class="name">${escapeAttr(s.name)}</div>
        ${blurb ? `<div class="blurb">${escapeAttr(blurb)}</div>` : ""}
      </div>`;
    })
    .join("");
}

// ---------------------------------------------------------- event details modal --
function openEventModal(ev, isPast) {
  const content = document.getElementById("event-modal-content");
  const hasDesc = !!((ev.descriptionAr || "").trim() || (ev.descriptionEn || "").trim());
  const recap = ev.recap || {};
  const hasRecapDesc = !!((recap.descriptionAr || "").trim() || (recap.descriptionEn || "").trim());
  const recapPhotos = recap.photos || [];
  const heroPhoto = isPast && recapPhotos.length ? recapPhotos[0] : ev.coverPhoto;
  const galleryPhotos = isPast && recapPhotos.length > 1 ? recapPhotos.slice(1) : [];
  const children = EVENTS_DATA.filter((e) => e.parentEventId === ev.id);
  const isParent = children.length > 0;
  content.innerHTML = `
    <span class="event-badge ${isPast ? "past" : ""}">${isPast ? t("eventPast") : t("eventUpcoming")}</span>
    ${heroPhoto ? `<img class="photo-hero" src="${escapeAttr(heroPhoto)}" alt="" />` : ""}
    <h2>${eventNameHtml(ev)}</h2>
    <div class="meta" style="margin-bottom:12px;">${escapeAttr(eventDateTimeLabel(ev))}${ev.sport ? " · " + escapeAttr(ev.sport) : ""}</div>
    ${TOURNAMENT_EVENT_IDS.has(ev.id) ? `<button class="secondary" id="modal-view-tournament-btn" style="margin-bottom:10px;">${t("btnViewTournament")}</button>` : ""}
    ${hasDesc ? `<h3>${t("aboutTitle")}</h3><p class="desc">${eventDescHtml(ev)}</p>` : ""}
    ${isPast && hasRecapDesc ? `<h3>${t("recapTitle")}</h3><p class="desc">${eventRecapDescHtml(ev)}</p>` : ""}
    ${
      galleryPhotos.length
        ? `<h3>${t("photosTitle")}</h3><div class="photo-gallery">${galleryPhotos
            .map((p) => `<img src="${escapeAttr(p)}" alt="" />`)
            .join("")}</div>`
        : ""
    }
    ${
      isParent
        ? `<h3>${escapeAttr(t("activitiesTitle"))}</h3><div class="activities-list">${activityRowsHtml(
            children,
            isPast
          )}</div>`
        : !isPast
        ? `<p style="color:var(--muted);font-size:0.85rem;">${t("goToRegisterHint")}</p><button class="primary" id="modal-register-btn" style="width:100%;">${t("btnRegisterCard")}</button>`
        : ""
    }
  `;
  if (!isPast && !isParent) {
    document.getElementById("modal-register-btn").addEventListener("click", () => {
      closeEventModal();
      startRegisterFlow(ev);
    });
  }
  if (!isPast && isParent) {
    content.querySelectorAll('[data-action="register-child"]').forEach((btn) => {
      const child = EVENTS_DATA.find((e) => e.id === Number(btn.dataset.childId));
      if (!child) return;
      btn.addEventListener("click", () => {
        closeEventModal();
        startRegisterFlow(child);
      });
    });
  }
  const tournBtn = document.getElementById("modal-view-tournament-btn");
  if (tournBtn) tournBtn.addEventListener("click", () => goToEventTournament(ev.id));
  document.getElementById("event-modal").classList.remove("hidden");
}
function closeEventModal() {
  document.getElementById("event-modal").classList.add("hidden");
}
// Cross-link from an event's card/modal straight into its tournament's
// bracket on the public Tournaments tab - and the reverse link back lives on
// that tournament's detail view (see renderPublicTournamentBody). See the
// PENDING_TOURNAMENT_EVENT_ID check in switchTab() for why this is a queued
// flag rather than calling openPublicTournament() directly here.
let PENDING_TOURNAMENT_EVENT_ID = null;
function goToEventTournament(eventId) {
  closeEventModal();
  PENDING_TOURNAMENT_EVENT_ID = eventId;
  switchTab("tournaments");
}
document.getElementById("event-modal-close").addEventListener("click", closeEventModal);
document.getElementById("event-modal").addEventListener("click", (e) => {
  if (e.target.id === "event-modal") closeEventModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeEventModal();
});

// ------------------------------------------------------- register-from-card --
let PENDING_EVENT_ID = null;
function startRegisterFlow(ev) {
  PENDING_EVENT_ID = ev.id;
  switchTab("register");
  if (CURRENT_SESSION && CURRENT_SESSION.type === "member") {
    applyPendingEventSelection();
  }
}
function applyPendingEventSelection() {
  if (PENDING_EVENT_ID == null) return;
  const sel = document.getElementById("reg-event");
  if (sel && Array.from(sel.options).some((o) => o.value === String(PENDING_EVENT_ID))) {
    sel.value = String(PENDING_EVENT_ID);
  }
  PENDING_EVENT_ID = null;
}

async function loadLadder() {
  LADDER_DATA = await api("/api/ladder");
  renderLadder();
  renderTierDropdown();
}
function renderLadder() {
  if (!LADDER_DATA) return;
  const wrap = document.getElementById("ladder-list");
  wrap.innerHTML = LADDER_DATA.ladder
    .map(
      (tier) => `
    <div class="ladder-item">
      <div class="pts">${fmt(tier.pointsRequired)}</div>
      <div class="info">
        <div class="name">${ladderLabel(tier)}</div>
        <div class="desc">${ladderDesc(tier)}</div>
      </div>
      <div class="approver">${ladderApprover(tier)}</div>
    </div>`
    )
    .join("");
}
function renderTierDropdown() {
  if (!LADDER_DATA) return;
  const sel = document.getElementById("mp-tier");
  sel.innerHTML = LADDER_DATA.ladder
    .map((tier) => `<option value="${tier.tier}">${fmt(tier.pointsRequired)} — ${ladderLabel(tier)}</option>`)
    .join("");
}

// ------------------------------------------------------------- sign up/in --
document.getElementById("su-submit").addEventListener("click", async () => {
  const membershipNumber = document.getElementById("su-membership").value.trim();
  const name = document.getElementById("su-name").value.trim();
  const password = document.getElementById("su-password").value;
  const familyGroup = document.getElementById("su-family").value.trim();
  const phone = document.getElementById("su-phone").value.trim();
  const msg = document.getElementById("su-msg");
  if (!membershipNumber || !name || !password) {
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  if (password.length < 6) {
    showMsg(msg, t("errPasswordShort"), false);
    return;
  }
  try {
    const result = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ membershipNumber, name, password, familyGroup, phone }),
    });
    CURRENT_SESSION = { type: "member", member: result.member };
    SESSION_EXPIRY_HANDLED = false;
    document.getElementById("su-password").value = "";
    msg.classList.remove("show");
    updateUIForSession();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

document.getElementById("li-submit").addEventListener("click", async () => {
  const membershipNumber = document.getElementById("li-membership").value.trim();
  const password = document.getElementById("li-password").value;
  const msg = document.getElementById("li-msg");
  if (!membershipNumber || !password) {
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  try {
    const result = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ membershipNumber, password }),
    });
    CURRENT_SESSION = { type: "member", member: result.member };
    SESSION_EXPIRY_HANDLED = false;
    document.getElementById("li-password").value = "";
    msg.classList.remove("show");
    updateUIForSession();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

// ------------------------------------------------------------- register --
// "Who's attending?" checklist: the member themselves (checked by default)
// plus one row per family member (dependent) already added under My Points
// → My Family. Rebuilt any time the session or the dependent list changes.
function renderAttendeesChecklist() {
  const wrap = document.getElementById("reg-attendees-list");
  if (!wrap) return;
  const member = CURRENT_SESSION && CURRENT_SESSION.type === "member" ? CURRENT_SESSION.member : null;
  if (!member) {
    wrap.innerHTML = "";
    return;
  }
  const deps = member.dependents || [];
  const rows = [
    `<div class="attendee-row">
      <input type="checkbox" id="att-self" checked />
      <label for="att-self">${escapeAttr(member.name)} <span style="color:var(--muted);font-size:0.8rem;">(${t("attendeeSelfLabel")})</span></label>
    </div>`,
    ...deps.map(
      (d) => `<div class="attendee-row">
      <input type="checkbox" class="att-dep" id="att-dep-${d.id}" data-dep-id="${d.id}" data-dep-name="${escapeAttr(d.name)}" />
      <label for="att-dep-${d.id}">${escapeAttr(d.name)}</label>
    </div>`
    ),
  ];
  wrap.innerHTML = rows.join("");
}

// Points might be hidden from members right now (admin toggle) - when so,
// suppress the "(+N points)" clause everywhere it would normally appear
// rather than showing a number for a system members can't otherwise see.
function pointsAwardedSuffix(points) {
  return pointsVisible() ? ` (+${fmt(points)} ${escapeAttr(t("scanPointsAwarded"))})` : "";
}
function renderQrList(entries) {
  const wrap = document.getElementById("reg-qr-list");
  wrap.innerHTML = entries
    .map((e) => {
      if (e.ok && e.result.waitlisted) {
        return `<div class="qr-entry">
            <h4>${escapeAttr(e.label)} <span class="capacity-badge waitlist">${escapeAttr(t("waitlistLabel"))}</span></h4>
            <p class="note">${escapeAttr(e.result.message)}</p>
          </div>`;
      }
      if (e.ok) {
        return `<div class="qr-entry">
            <h4>${escapeAttr(e.label)}</h4>
            <img src="${e.result.qrDataUrl}" alt="QR code" />
            <p class="note">${escapeAttr(e.result.message)}${pointsAwardedSuffix(e.result.potentialPoints)}</p>
          </div>`;
      }
      // "Already registered" isn't really a failure from the member's point
      // of view - they're still booked in. Show their still-valid QR again
      // (or a plain "you're already checked in"/"already on the waiting
      // list" note) instead of a bare error with nothing they can act on.
      const already = e.data && e.data.alreadyRegistered;
      if (already && e.data.qrDataUrl) {
        return `<div class="qr-entry">
            <h4>${escapeAttr(e.label)}</h4>
            <img src="${e.data.qrDataUrl}" alt="QR code" />
            <p class="note">${escapeAttr(t("alreadyRegisteredNote"))}${pointsAwardedSuffix(e.data.potentialPoints)}</p>
          </div>`;
      }
      if (already && e.data.checkedIn) {
        return `<div class="qr-entry">
            <h4>${escapeAttr(e.label)}</h4>
            <p class="note">${escapeAttr(t("alreadyCheckedInNote"))}</p>
          </div>`;
      }
      if (already && e.data.waitlisted) {
        return `<div class="qr-entry">
            <h4>${escapeAttr(e.label)} <span class="capacity-badge waitlist">${escapeAttr(t("waitlistLabel"))}</span></h4>
            <p class="note">${escapeAttr(t("alreadyOnWaitlistNote"))}</p>
          </div>`;
      }
      return `<div class="qr-entry">
            <h4>${escapeAttr(e.label)}</h4>
            <p class="note err">${escapeAttr(e.error)}</p>
          </div>`;
    })
    .join("");
}

// Set while a batch is paused waiting on the member to confirm/decline the
// waiting list, so the Confirm button knows what to resubmit.
let PENDING_REG_SUBMISSION = null; // { eventId, attendees } | null

document.getElementById("reg-submit").addEventListener("click", async () => {
  const eventId = document.getElementById("reg-event").value;
  const msg = document.getElementById("reg-msg");
  if (!eventId) {
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  const member = CURRENT_SESSION.member;
  const selfBox = document.getElementById("att-self");
  const selfChecked = selfBox && selfBox.checked;
  const depChecked = Array.from(document.querySelectorAll(".att-dep:checked")).map((el) => ({
    id: el.dataset.depId,
    name: el.dataset.depName,
  }));
  if (!selfChecked && !depChecked.length) {
    showMsg(msg, t("errSelectAttendee"), false);
    return;
  }

  const attendees = [];
  if (selfChecked) attendees.push({ dependentId: null, label: member.name });
  depChecked.forEach((d) => attendees.push({ dependentId: d.id, label: d.name }));

  await submitRegistrations(eventId, attendees, false);
});

// Registers every attendee in the batch. If the event is full, the server
// doesn't error - it comes back with needsWaitlistConfirmation instead, and
// this pauses the WHOLE batch (not just that one attendee) behind a single
// bilingual confirmation card. Re-submitting with joinWaitlist=true is safe
// even for attendees who already got a confirmed spot in the first pass -
// the server just hands their existing registration back again (see the
// "already registered" branch), nothing is double-booked.
async function submitRegistrations(eventId, attendees, joinWaitlist) {
  const msg = document.getElementById("reg-msg");
  const entries = [];
  let waitlistPrompt = null;
  for (const att of attendees) {
    try {
      const body = { eventId, dependentId: att.dependentId };
      if (joinWaitlist) body.joinWaitlist = true;
      const result = await api("/api/register", { method: "POST", body: JSON.stringify(body) });
      if (result.needsWaitlistConfirmation) {
        waitlistPrompt = waitlistPrompt || result;
        continue;
      }
      entries.push({ ok: true, label: att.label, result });
    } catch (e) {
      entries.push({ ok: false, label: att.label, error: e.message, data: e.data });
    }
  }

  if (waitlistPrompt) {
    PENDING_REG_SUBMISSION = { eventId, attendees };
    document.getElementById("reg-waitlist-message-en").textContent = waitlistPrompt.messageEn;
    document.getElementById("reg-waitlist-message-ar").textContent = waitlistPrompt.messageAr;
    document.getElementById("reg-waitlist-confirm-check").checked = false;
    document.getElementById("reg-waitlist-msg").classList.remove("show");
    document.getElementById("reg-waitlist-card").classList.remove("hidden");
    msg.classList.remove("show");
    return;
  }

  document.getElementById("reg-waitlist-card").classList.add("hidden");
  renderQrList(entries);
  msg.classList.remove("show");
  document.getElementById("reg-qr-card").classList.remove("hidden");
  loadMyRegistrations();
  loadEvents(); // refresh capacity badges/counts everywhere else on the page
}

document.getElementById("reg-waitlist-confirm").addEventListener("click", async () => {
  const waitlistMsg = document.getElementById("reg-waitlist-msg");
  if (!document.getElementById("reg-waitlist-confirm-check").checked) {
    showMsg(waitlistMsg, t("waitlistMustCheckBox"), false);
    return;
  }
  if (!PENDING_REG_SUBMISSION) return;
  const { eventId, attendees } = PENDING_REG_SUBMISSION;
  PENDING_REG_SUBMISSION = null;
  await submitRegistrations(eventId, attendees, true);
});
document.getElementById("reg-waitlist-cancel").addEventListener("click", () => {
  PENDING_REG_SUBMISSION = null;
  document.getElementById("reg-waitlist-card").classList.add("hidden");
});

// ------------------------------------------------------------- my points --
async function loadMyBalance() {
  try {
    const snap = await api("/api/me/balance");
    document.getElementById("mp-result").classList.remove("hidden");
    document.getElementById("mp-balance").textContent = fmt(snap.balance);
    document.getElementById("mp-earned").textContent = fmt(snap.totalEarned);
    document.getElementById("mp-redeemed").textContent = fmt(snap.totalRedeemed);
    document.getElementById("mp-next").textContent = snap.nextReachableTier
      ? ladderLabel(snap.nextReachableTier)
      : t("belowThreshold");
    document.getElementById("mp-pool-note").textContent = snap.familyPooled
      ? `${t("familyPooled")} (${snap.poolMembers.map((m) => m.name).join(", ")})`
      : t("individualTracking");
  } catch (e) {
    document.getElementById("mp-result").classList.add("hidden");
  }
}

document.getElementById("mp-redeem").addEventListener("click", async () => {
  const msg = document.getElementById("mp-redeem-msg");
  const tier = document.getElementById("mp-tier").value;
  if (!tier) return;
  try {
    const result = await api("/api/redeem", {
      method: "POST",
      body: JSON.stringify({ tier }),
    });
    let text = t("okRedeemRequested");
    if (!result.sufficientBalance) text += " " + t("warnInsufficient");
    showMsg(msg, text, result.sufficientBalance);
    loadMyBalance();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

// -------------------------------------------------------------- my family --
function renderFamilyList() {
  const wrap = document.getElementById("mp-family-list");
  const member = CURRENT_SESSION && CURRENT_SESSION.type === "member" ? CURRENT_SESSION.member : null;
  if (!wrap || !member) return;
  const deps = member.dependents || [];
  wrap.innerHTML = deps.length
    ? deps
        .map(
          (d) => `<div class="family-item" data-dep-id="${d.id}">
        <span class="name">${escapeAttr(d.name)}</span>
        <button class="secondary fam-remove" data-dep-id="${d.id}" style="margin-top:0;padding:6px 12px;font-size:0.8rem;">${t("btnRemove")}</button>
      </div>`
        )
        .join("")
    : `<p style="color:var(--muted);font-size:0.85rem;">${t("noFamilyMembersYet")}</p>`;
  wrap.querySelectorAll(".fam-remove").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm(t("confirmRemoveFamilyMember"))) return;
      try {
        const result = await api("/api/me/dependents/" + btn.dataset.depId, { method: "DELETE" });
        CURRENT_SESSION.member.dependents = result.dependents;
        renderFamilyList();
        renderAttendeesChecklist();
      } catch (e) {
        showMsg(document.getElementById("fam-msg"), e.message, false);
      }
    });
  });
}

document.getElementById("fam-add").addEventListener("click", async () => {
  const nameInput = document.getElementById("fam-name");
  const name = nameInput.value.trim();
  const msg = document.getElementById("fam-msg");
  if (!name) {
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  try {
    const result = await api("/api/me/dependents", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    CURRENT_SESSION.member.dependents = result.dependents;
    nameInput.value = "";
    showMsg(msg, t("famAdded"), true);
    renderFamilyList();
    renderAttendeesChecklist();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

// -------------------------------------------------------- my registrations --
async function loadMyRegistrations() {
  const wrap = document.getElementById("mp-registrations-list");
  if (!wrap) return;
  const member = CURRENT_SESSION && CURRENT_SESSION.type === "member" ? CURRENT_SESSION.member : null;
  if (!member) return;
  try {
    const regs = await api("/api/me/registrations");
    if (!regs.length) {
      wrap.innerHTML = `<p style="color:var(--muted);font-size:0.85rem;">${t("noRegistrationsYet")}</p>`;
      return;
    }
    const sorted = regs.slice().sort((a, b) => (a.event ? a.event.date : "").localeCompare(b.event ? b.event.date : ""));
    wrap.innerHTML = sorted
      .map((r) => {
        const attendee = r.dependentName || member.name;
        const evLabel = r.event ? eventLabel(r.event) : "";
        const evDate = r.event ? r.event.date : "";
        const finished = r.event ? isPastEvent(r.event) : true;
        const statusBadge = r.waitlisted
          ? `<span class="capacity-badge waitlist">${escapeAttr(t("waitlistLabel"))}</span>`
          : r.checkedIn
          ? `<span class="checkin-badge">${escapeAttr(t("scanSuccess"))} — ${escapeAttr(new Date(r.checkInAt).toLocaleString())}</span>`
          : `<span class="checkin-badge pending">${finished ? escapeAttr(t("eventFinishedNoShow")) : escapeAttr(t("regStatusRegistered"))}</span>`;
        const canViewQr = !r.checkedIn && !r.waitlisted && !finished && r.qrDataUrl;
        // The QR is shown directly (not behind a "View QR" click) - members
        // were missing it entirely after logging back in because the extra
        // click wasn't obvious, so now it's just visible whenever it's
        // relevant (not checked in yet, event hasn't happened).
        return `<div class="my-reg-item" data-reg-id="${r.id}">
          <div class="info">
            <div class="name">${escapeAttr(attendee)} — ${escapeAttr(evLabel)}</div>
            <div class="meta">${escapeAttr(evDate)}</div>
            ${statusBadge}
          </div>
        </div>
        ${canViewQr ? `<div class="qr-entry" id="myreg-qr-${r.id}"><h4>${escapeAttr(t("qrTitle"))}</h4><img src="${r.qrDataUrl}" alt="QR code" /><p class="note">${escapeAttr(t("qrReminderNote"))}</p></div>` : ""}`;
      })
      .join("");
  } catch (e) {
    wrap.innerHTML = `<p style="color:var(--muted);font-size:0.85rem;">${t("errGeneric")}</p>`;
  }
}

// --------------------------------------------------------------- support chat --
// Renders one thread (member view or an admin's open thread) as chat
// bubbles. `mineSender` is "member" when rendering a member's own view of
// their thread, or "staff" when rendering an admin's view of a member's
// thread - whichever sender value counts as "my" message gets the "mine"
// bubble style.
function renderChatBubbles(containerId, messages, mineSender) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  if (!messages.length) {
    wrap.innerHTML = `<div class="chat-empty">${escapeAttr(t("chatEmpty"))}</div>`;
    return;
  }
  wrap.innerHTML = messages
    .map((m) => {
      const mine = m.sender === mineSender;
      const time = new Date(m.sentAt).toLocaleString(currentLang === "ar" ? "ar-EG" : "en-US");
      return `<div class="chat-bubble ${mine ? "mine" : "theirs"}">
        <div class="text">${escapeAttr(m.text)}</div>
        <div class="meta">${escapeAttr(m.senderName)} · ${escapeAttr(time)}</div>
      </div>`;
    })
    .join("");
  wrap.scrollTop = wrap.scrollHeight;
}

// -- member side --
async function loadMyChat() {
  const wrap = document.getElementById("mp-chat-thread");
  if (!wrap) return;
  if (!CURRENT_SESSION || CURRENT_SESSION.type !== "member") return;
  try {
    const messages = await api("/api/me/chat/messages");
    renderChatBubbles("mp-chat-thread", messages, "member");
    updateMemberChatBadge();
  } catch (e) {
    wrap.innerHTML = `<div class="chat-empty">${escapeAttr(t("errGeneric"))}</div>`;
  }
}
async function updateMemberChatBadge() {
  const badge = document.getElementById("mp-chat-badge");
  if (!badge) return;
  if (!CURRENT_SESSION || CURRENT_SESSION.type !== "member") {
    badge.classList.add("hidden");
    return;
  }
  try {
    const { count } = await api("/api/me/chat/unread-count");
    if (count > 0) {
      badge.textContent = count > 9 ? "9+" : String(count);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  } catch (e) {
    /* ignore - badge just won't update this cycle */
  }
}
document.getElementById("mp-chat-send").addEventListener("click", sendMyChatMessage);
document.getElementById("mp-chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMyChatMessage();
  }
});
async function sendMyChatMessage() {
  const input = document.getElementById("mp-chat-input");
  const msg = document.getElementById("mp-chat-msg");
  const text = input.value.trim();
  if (!text) return;
  try {
    await api("/api/me/chat/messages", { method: "POST", body: JSON.stringify({ text }) });
    input.value = "";
    msg.classList.remove("show");
    await loadMyChat();
  } catch (e) {
    showMsg(msg, e.message || t("chatSendError"), false);
  }
}

// -- admin side --
let ADMIN_CHAT_OPEN_MEMBERSHIP = null;
let CHAT_THREADS_CACHE = [];
async function loadChatThreadsList() {
  const wrap = document.getElementById("chat-threads-list");
  if (!wrap) return;
  if (!CURRENT_SESSION || CURRENT_SESSION.type !== "staff" || CURRENT_SESSION.staff.role !== "admin") return;
  try {
    CHAT_THREADS_CACHE = await api("/api/staff/chats");
    if (!CHAT_THREADS_CACHE.length) {
      wrap.innerHTML = `<p style="color:var(--muted);font-size:0.85rem;">${escapeAttr(t("noChatThreads"))}</p>`;
    } else {
      wrap.innerHTML = CHAT_THREADS_CACHE
        .map(
          (th) => `<div class="chat-thread-item ${th.membershipNumber === ADMIN_CHAT_OPEN_MEMBERSHIP ? "active" : ""}" data-membership="${escapeAttr(th.membershipNumber)}">
        <div>
          <div class="name">${escapeAttr(th.memberName)} <span style="color:var(--muted);font-weight:400;">(#${escapeAttr(th.membershipNumber)})</span></div>
          <div class="snippet">${escapeAttr(th.lastMessage)}</div>
        </div>
        ${th.unreadCount > 0 ? `<div class="unread-dot">${th.unreadCount > 9 ? "9+" : th.unreadCount}</div>` : ""}
      </div>`
        )
        .join("");
      wrap.querySelectorAll(".chat-thread-item").forEach((el) => {
        el.addEventListener("click", () => openChatThread(el.dataset.membership));
      });
    }
    updateAdminChatBadge();
  } catch (e) {
    wrap.innerHTML = `<p style="color:var(--muted);font-size:0.85rem;">${escapeAttr(t("errGeneric"))}</p>`;
  }
}
async function openChatThread(membershipNumber) {
  ADMIN_CHAT_OPEN_MEMBERSHIP = membershipNumber;
  document.getElementById("chat-thread-panel").classList.remove("hidden");
  const thread = CHAT_THREADS_CACHE.find((th) => th.membershipNumber === membershipNumber);
  document.getElementById("chat-thread-panel-title").textContent = thread
    ? `${thread.memberName} (#${thread.membershipNumber})`
    : membershipNumber;
  await refreshOpenAdminChatThread();
  loadChatThreadsList();
}
async function refreshOpenAdminChatThread() {
  if (!ADMIN_CHAT_OPEN_MEMBERSHIP) return;
  try {
    const messages = await api("/api/staff/chats/" + encodeURIComponent(ADMIN_CHAT_OPEN_MEMBERSHIP));
    renderChatBubbles("admin-chat-thread", messages, "staff");
  } catch (e) {
    /* ignore - next poll will retry */
  }
}
async function updateAdminChatBadge() {
  const badge = document.getElementById("admin-chat-badge");
  const tabBadge = document.getElementById("admin-tab-badge-content");
  if (!badge) return;
  if (!CURRENT_SESSION || CURRENT_SESSION.type !== "staff" || CURRENT_SESSION.staff.role !== "admin") {
    badge.classList.add("hidden");
    if (tabBadge) tabBadge.classList.add("hidden");
    return;
  }
  try {
    const { count } = await api("/api/staff/chats/unread-count");
    if (count > 0) {
      const text = count > 9 ? "9+" : String(count);
      badge.textContent = text;
      badge.classList.remove("hidden");
      if (tabBadge) {
        tabBadge.textContent = text;
        tabBadge.classList.remove("hidden");
      }
    } else {
      badge.classList.add("hidden");
      if (tabBadge) tabBadge.classList.add("hidden");
    }
  } catch (e) {
    /* ignore */
  }
}
document.getElementById("admin-chat-send").addEventListener("click", sendAdminChatMessage);
document.getElementById("admin-chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendAdminChatMessage();
  }
});
async function sendAdminChatMessage() {
  if (!ADMIN_CHAT_OPEN_MEMBERSHIP) return;
  const input = document.getElementById("admin-chat-input");
  const msg = document.getElementById("admin-chat-msg");
  const text = input.value.trim();
  if (!text) return;
  try {
    await api("/api/staff/chats/" + encodeURIComponent(ADMIN_CHAT_OPEN_MEMBERSHIP), {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    input.value = "";
    msg.classList.remove("show");
    await refreshOpenAdminChatThread();
  } catch (e) {
    showMsg(msg, e.message || t("chatSendError"), false);
  }
}

// ------------------------------------------------------------------ admin/staff login --
async function staffLogin(usernameId, passwordId, msgId) {
  const username = document.getElementById(usernameId).value.trim();
  const password = document.getElementById(passwordId).value;
  const msg = document.getElementById(msgId);
  if (!username || !password) {
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  try {
    const result = await api("/api/auth/staff-login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    CURRENT_SESSION = { type: "staff", staff: result.staff };
    SESSION_EXPIRY_HANDLED = false;
    document.getElementById(passwordId).value = "";
    msg.classList.remove("show");
    updateUIForSession();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}
document.getElementById("scan-unlock").addEventListener("click", () =>
  staffLogin("staff-username-input", "staff-password-input", "scan-lock-msg")
);
document.getElementById("admin-unlock").addEventListener("click", () =>
  staffLogin("admin-username-input", "admin-password-input", "admin-lock-msg")
);

async function loadAdminOverview() {
  const stats = await api("/api/admin/overview");
  document.getElementById("admin-stats").innerHTML = `
    <div class="stat"><div class="n">${stats.totalMembers}</div><div class="l">${t("statMembers")}</div></div>
    <div class="stat"><div class="n">${stats.totalEvents}</div><div class="l">${t("statEvents")}</div></div>
    <div class="stat"><div class="n">${stats.totalRegistrations}</div><div class="l">${t("statRegistrations")}</div></div>
    <div class="stat"><div class="n">${stats.totalCheckedIn}</div><div class="l">${t("statCheckedIn")}</div></div>
    <div class="stat"><div class="n">${stats.pendingRedemptions}</div><div class="l">${t("statPending")}</div></div>
  `;
  const pointsBadge = document.getElementById("admin-tab-badge-points");
  if (pointsBadge) {
    if (stats.pendingRedemptions > 0) {
      pointsBadge.textContent = stats.pendingRedemptions > 9 ? "9+" : String(stats.pendingRedemptions);
      pointsBadge.classList.remove("hidden");
    } else {
      pointsBadge.classList.add("hidden");
    }
  }
}

// ---------------------------------------------------------- admin: sub-tabs --
// The Admin section groups its ~19 cards into a handful of sub-tabs (Overview,
// Events, Members, Points & Rewards, Content & Chat, Settings) so committee
// members aren't scrolling through one very long page to find a specific
// tool. Tab state (which one is showing) is remembered per-browser via
// sessionStorage so switching the site language or navigating away and back
// doesn't reset it mid-task.
let ADMIN_TABS_WIRED = false;
function initAdminTabs() {
  if (ADMIN_TABS_WIRED) return;
  ADMIN_TABS_WIRED = true;
  document.querySelectorAll(".admin-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchAdminTab(btn.dataset.adminTab));
  });
  let saved = "overview";
  try {
    saved = sessionStorage.getItem("adminActiveTab") || "overview";
  } catch (e) {
    /* ignore - sessionStorage unavailable, default to overview */
  }
  if (!document.querySelector(`.admin-tab[data-admin-tab="${saved}"]`)) saved = "overview";
  switchAdminTab(saved);
}
function switchAdminTab(tabKey) {
  document.querySelectorAll(".admin-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.adminTab === tabKey);
  });
  document.querySelectorAll(".admin-tab-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.adminPanel !== tabKey);
  });
  try {
    sessionStorage.setItem("adminActiveTab", tabKey);
  } catch (e) {
    /* ignore - non-fatal, tab just won't be remembered on next visit */
  }
}

// ---------------------------------------------------------- admin: settings --
document.getElementById("settings-points-visible").addEventListener("change", async (e) => {
  const msg = document.getElementById("settings-msg");
  const wanted = e.target.checked;
  try {
    // This endpoint only returns pointsVisibleToMembers, not theme - merge
    // rather than replace so the branding half of SETTINGS isn't wiped out.
    const result = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ pointsVisibleToMembers: wanted }),
    });
    SETTINGS = { ...SETTINGS, ...result };
    applySettingsToUI();
    showMsg(msg, t("settingsSaved"), true);
  } catch (err) {
    e.target.checked = !wanted; // revert the checkbox if the save failed
    showMsg(msg, err.message, false);
  }
});

// ----------------------------------------------------------- admin: branding --
document.getElementById("theme-save-btn").addEventListener("click", async () => {
  const msg = document.getElementById("theme-msg");
  const fd = new FormData();
  fd.append("primaryColor", document.getElementById("theme-primary").value);
  fd.append("accentColor", document.getElementById("theme-accent").value);
  const fileInput = document.getElementById("theme-logo-file");
  if (fileInput.files[0]) fd.append("logo", fileInput.files[0]);
  try {
    const theme = await api("/api/settings/theme", { method: "PUT", body: fd });
    SETTINGS = { ...SETTINGS, theme };
    fileInput.value = "";
    applyThemeToUI();
    showMsg(msg, t("settingsSaved"), true);
  } catch (err) {
    showMsg(msg, err.message, false);
  }
});

document.getElementById("theme-remove-logo-btn").addEventListener("click", async () => {
  const msg = document.getElementById("theme-msg");
  const fd = new FormData();
  fd.append("removeLogo", "true");
  try {
    const theme = await api("/api/settings/theme", { method: "PUT", body: fd });
    SETTINGS = { ...SETTINGS, theme };
    applyThemeToUI();
    showMsg(msg, t("logoRemoved"), true);
  } catch (err) {
    showMsg(msg, err.message, false);
  }
});

document.getElementById("theme-reset-btn").addEventListener("click", async () => {
  const msg = document.getElementById("theme-msg");
  const fd = new FormData();
  fd.append("primaryColor", "#8B0000");
  fd.append("accentColor", "#C9A227");
  fd.append("removeLogo", "true");
  try {
    const theme = await api("/api/settings/theme", { method: "PUT", body: fd });
    SETTINGS = { ...SETTINGS, theme };
    document.getElementById("theme-logo-file").value = "";
    applyThemeToUI();
    showMsg(msg, t("themeReset"), true);
  } catch (err) {
    showMsg(msg, err.message, false);
  }
});

// -------------------------------------------------------- admin: dashboard --
// One row per event: registrations vs. capacity, waiting-list size, and how
// many of the confirmed registrants actually checked in. Min capacity is
// shown as a plain target, never enforced.
async function loadAdminDashboard() {
  try {
    const rows = await api("/api/admin/dashboard");
    renderAdminDashboardTable(rows);
  } catch (e) {
    document.getElementById("admin-dashboard-table").innerHTML =
      `<p class="dashboard-empty-note">${escapeAttr(e.message)}</p>`;
  }
}
function renderAdminDashboardTable(rows) {
  const wrap = document.getElementById("admin-dashboard-table");
  if (!rows.length) {
    wrap.innerHTML = `<p class="dashboard-empty-note">${t("noEventsYet")}</p>`;
    return;
  }
  const body = rows
    .map((r) => {
      const capacityText = r.maxCapacity != null ? `${fmt(r.confirmedCount)} / ${fmt(r.maxCapacity)}` : fmt(r.confirmedCount);
      const minNote = r.minCapacity != null ? ` <span class="hint-note" style="display:inline;">(${t("minTarget")} ${fmt(r.minCapacity)})</span>` : "";
      const attendance = r.attendanceRate === null ? "—" : `${r.attendanceRate}%`;
      const waitlistCell =
        r.waitlistCount > 0
          ? `<button class="secondary" data-waitlist-event="${r.eventId}" data-waitlist-label="${escapeAttr(eventLabel({ nameEn: r.nameEn, nameAr: r.nameAr }))}" style="padding:3px 10px;font-size:0.78rem;">${fmt(r.waitlistCount)} ${t("waitlistLabel")}</button>`
          : "0";
      return `<tr>
        <td>${escapeAttr(eventLabel({ nameEn: r.nameEn, nameAr: r.nameAr }))}</td>
        <td>${escapeAttr(r.date)}</td>
        <td class="num">${capacityText}${minNote}</td>
        <td>${waitlistCell}</td>
        <td class="num">${fmt(r.checkedInCount)}</td>
        <td>${attendance}</td>
        <td><button class="secondary small" data-hub-event="${r.eventId}" data-hub-label="${escapeAttr(eventLabel({ nameEn: r.nameEn, nameAr: r.nameAr }))}">${t("btnManageEvent")}</button></td>
      </tr>`;
    })
    .join("");
  wrap.innerHTML = `<div class="dashboard-table-wrap"><table class="dashboard-table">
    <thead><tr>
      <th>${t("colEvent")}</th><th>${t("colDate")}</th><th>${t("colRegistrations")}</th>
      <th>${t("colWaitlist")}</th><th>${t("colCheckedIn")}</th><th>${t("colAttendance")}</th><th></th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
  wrap.querySelectorAll("[data-waitlist-event]").forEach((btn) => {
    btn.addEventListener("click", () =>
      openAdminWaitlist(Number(btn.dataset.waitlistEvent), btn.dataset.waitlistLabel)
    );
  });
  wrap.querySelectorAll("[data-hub-event]").forEach((btn) => {
    btn.addEventListener("click", () => openAdminEventHub(Number(btn.dataset.hubEvent), btn.dataset.hubLabel));
  });
}
async function openAdminWaitlist(eventId, eventLabelText) {
  const panel = document.getElementById("admin-waitlist-panel");
  const title = document.getElementById("admin-waitlist-title");
  const list = document.getElementById("admin-waitlist-list");
  panel.classList.remove("hidden");
  title.textContent = `${t("waitlistFor")} ${eventLabelText}`;
  list.innerHTML = "";
  try {
    const entries = await api(`/api/admin/events/${eventId}/waitlist`);
    if (!entries.length) {
      list.innerHTML = `<p class="dashboard-empty-note">${t("waitlistEmpty")}</p>`;
      return;
    }
    list.innerHTML = entries
      .map(
        (r) => `<div class="waitlist-row">
          <span>${escapeAttr(r.attendeeName)} ${r.member ? "(#" + escapeAttr(r.member.membershipNumber) + ")" : ""}</span>
          <button class="primary" data-promote-id="${r.id}" style="padding:3px 10px;font-size:0.78rem;">${t("btnPromote")}</button>
        </div>`
      )
      .join("");
    list.querySelectorAll("[data-promote-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const waitlistMsg = document.getElementById("admin-waitlist-msg");
        try {
          await api(`/api/admin/registrations/${btn.dataset.promoteId}/promote`, { method: "POST" });
          await openAdminWaitlist(eventId, eventLabelText);
          await loadAdminDashboard();
          loadAdminDirectory();
          showMsg(document.getElementById("admin-waitlist-msg"), t("promoted"), true);
        } catch (e) {
          showMsg(waitlistMsg, e.message, false);
        }
      });
    });
  } catch (e) {
    list.innerHTML = `<p class="dashboard-empty-note">${escapeAttr(e.message)}</p>`;
  }
}

// ---------------------------------------------- admin: per-event "manage" hub --
// Opened from the "Manage" button on each Event dashboard row - one place to
// see attendance and check people in (reusing the same roster/manual-checkin
// endpoints as the Gate Scanner tab, via the shared rosterTableHtml above),
// and a tournament/winners summary with a one-click jump into the full
// Tournament card (or the manual results tool, if there's no tournament) for
// that same event. Deliberately does NOT duplicate the tournament rendering
// engine itself - the "Manage tournament" jump reuses the existing Events-tab
// Tournament card rather than re-implementing seeding/results here too.
let HUB_EVENT_ID = null;
let HUB_ROSTER = [];
document.getElementById("admin-hub-close").addEventListener("click", () => {
  document.getElementById("admin-event-hub-panel").classList.add("hidden");
  HUB_EVENT_ID = null;
});
document.getElementById("hub-checkin-search").addEventListener("input", () => {
  const wrap = document.getElementById("hub-checkin-wrap");
  const query = (document.getElementById("hub-checkin-search").value || "").trim().toLowerCase();
  wrap.innerHTML = rosterTableHtml(HUB_ROSTER, query);
});
document.getElementById("hub-checkin-wrap").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-checkin-reg]");
  if (!btn) return;
  btn.disabled = true;
  const msg = document.getElementById("hub-checkin-msg");
  try {
    const result = await api("/api/checkin/manual", {
      method: "POST",
      body: JSON.stringify({ registrationId: Number(btn.dataset.checkinReg) }),
    });
    showMsg(msg, `${result.attendeeName} — ${t("scanSuccess")} (+${fmt(result.pointsAwarded)} ${t("scanPointsAwarded")})`, true);
    await loadHubRoster(true);
  } catch (err) {
    showMsg(msg, err.message, false);
    btn.disabled = false;
  }
});

async function openAdminEventHub(eventId, label) {
  HUB_EVENT_ID = eventId;
  document.getElementById("admin-waitlist-panel").classList.add("hidden");
  const panel = document.getElementById("admin-event-hub-panel");
  panel.classList.remove("hidden");
  document.getElementById("admin-hub-title").textContent = label;
  document.getElementById("hub-checkin-search").value = "";
  document.getElementById("hub-checkin-msg").textContent = "";
  document.getElementById("admin-hub-stats").innerHTML = "";
  document.getElementById("admin-hub-tournament-summary").innerHTML = `<p style="color:var(--muted);">${escapeAttr(t("loading"))}</p>`;
  document.getElementById("hub-add-member-search").value = "";
  document.getElementById("hub-add-member-results").innerHTML = "";
  document.getElementById("hub-add-member-msg").textContent = "";
  // MEMBERS_DATA normally only gets loaded when the admin visits the
  // Members tab - fetch it here too (harmless if already loaded elsewhere)
  // so "Register a member" can search the full roster right away.
  await Promise.all([loadHubRoster(), loadHubTournamentSummary(), loadAdminMembers()]);
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// "Register a member" (per-event hub): a lightweight type-to-search that
// adds one member directly to HUB_EVENT_ID via the same bulk-invite
// endpoint the Members tab uses (just with a single membershipNumber) -
// same "confirmed spot + QR, no self-service flow" behavior, just reachable
// from the event you're already looking at instead of a separate tab.
function renderHubAddMemberResults() {
  const wrap = document.getElementById("hub-add-member-results");
  const query = (document.getElementById("hub-add-member-search").value || "").trim().toLowerCase();
  if (!query) {
    wrap.innerHTML = "";
    return;
  }
  const registeredNumbers = new Set(HUB_ROSTER.map((r) => r.membershipNumber));
  const matches = MEMBERS_DATA.filter((m) =>
    `${m.name} ${m.membershipNumber} ${m.phone}`.toLowerCase().includes(query)
  ).slice(0, 20);
  if (!matches.length) {
    wrap.innerHTML = `<p class="hint-note">${escapeAttr(t("noMembersFound"))}</p>`;
    return;
  }
  wrap.innerHTML = matches
    .map((m) => {
      const already = registeredNumbers.has(m.membershipNumber);
      return `<div class="hub-add-member-row" style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);">
        <span>${escapeAttr(m.name)} <span style="color:var(--muted);">— ${escapeAttr(m.membershipNumber)}</span></span>
        ${
          already
            ? `<span class="badge Approved">${escapeAttr(t("alreadyRegisteredLabel"))}</span>`
            : `<button class="secondary small" data-hub-add-member="${escapeAttr(m.membershipNumber)}">${escapeAttr(t("btnAdd"))}</button>`
        }
      </div>`;
    })
    .join("");
}
document.getElementById("hub-add-member-search").addEventListener("input", renderHubAddMemberResults);
document.getElementById("hub-add-member-results").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-hub-add-member]");
  if (!btn) return;
  btn.disabled = true;
  const msg = document.getElementById("hub-add-member-msg");
  try {
    const result = await api(`/api/admin/events/${HUB_EVENT_ID}/invite`, {
      method: "POST",
      body: JSON.stringify({ membershipNumbers: [btn.dataset.hubAddMember] }),
    });
    if (result.invited.length) {
      showMsg(msg, `${result.invited[0].name} ${t("hubMemberAddedLabel")}`, true);
    } else if (result.skipped.length) {
      showMsg(msg, result.skipped[0].reason, false);
    }
    await loadHubRoster(true);
    renderHubAddMemberResults();
    loadAdminDashboard();
    loadAdminOverview();
  } catch (err) {
    showMsg(msg, err.message, false);
    btn.disabled = false;
  }
});
async function loadHubRoster(preserveMsg) {
  const wrap = document.getElementById("hub-checkin-wrap");
  const msg = document.getElementById("hub-checkin-msg");
  if (!preserveMsg && msg) msg.textContent = "";
  wrap.innerHTML = `<p style="color:var(--muted);">${escapeAttr(t("loading"))}</p>`;
  try {
    HUB_ROSTER = await api("/api/staff/events/" + HUB_EVENT_ID + "/roster");
    const query = (document.getElementById("hub-checkin-search").value || "").trim().toLowerCase();
    wrap.innerHTML = rosterTableHtml(HUB_ROSTER, query);
    const checkedIn = HUB_ROSTER.filter((r) => r.checkedIn).length;
    const confirmed = HUB_ROSTER.filter((r) => !r.waitlisted).length;
    document.getElementById("admin-hub-stats").innerHTML = `
      <span class="tourn-summary-badge">${fmt(confirmed)} ${t("colRegistrations")}</span>
      <span class="tourn-summary-badge">${fmt(checkedIn)} / ${fmt(confirmed)} ${t("colCheckedIn")}</span>
    `;
  } catch (e) {
    wrap.innerHTML = `<p class="msg err show">${escapeAttr(e.message)}</p>`;
  }
}
async function loadHubTournamentSummary() {
  const wrap = document.getElementById("admin-hub-tournament-summary");
  try {
    const data = await api("/api/admin/tournaments/" + HUB_EVENT_ID);
    if (!data.tournament) {
      wrap.innerHTML = `
        <p class="hint-note">${t("hubNoTournament")}</p>
        <button class="secondary small" id="hub-goto-tournament">${t("btnSetUpTournament")}</button>
        <button class="secondary small" id="hub-goto-results">${t("btnEnterResults")}</button>
      `;
    } else {
      const tn = data.tournament;
      const modeLabel = tn.mode === "team" ? t("tournamentModeTeam") : t("tournamentModeIndividual");
      const formatLabel = tn.format === "groups" ? t("tournamentFormatGroups") : t("tournamentFormatKnockout");
      const statusLabel = tn.status === "completed" ? t("tournStatusCompleted") : t("tournStatusInProgress");
      const standingsHtml = tn.standings
        ? `<table><thead><tr><th>${t("colPosition")}</th><th>${t("colName")}</th></tr></thead><tbody>${tn.standings
            .map((s) => `<tr><td>${s.rank}</td><td>${escapeAttr(s.label)}</td></tr>`)
            .join("")}</tbody></table>`
        : `<p class="hint-note">${t("tournPublicNotStarted")}</p>`;
      wrap.innerHTML = `
        <div class="tourn-summary">
          <span class="tourn-summary-badge">${escapeAttr(modeLabel)}</span>
          <span class="tourn-summary-badge">${escapeAttr(formatLabel)}</span>
          <span class="tourn-summary-badge">${escapeAttr(statusLabel)}</span>
        </div>
        ${standingsHtml}
        <button class="secondary small" id="hub-goto-tournament" style="margin-top:8px;">${t("btnManageTournament")}</button>
      `;
    }
    const gotoTourn = document.getElementById("hub-goto-tournament");
    if (gotoTourn) gotoTourn.addEventListener("click", () => jumpToTournamentCard(HUB_EVENT_ID));
    const gotoResults = document.getElementById("hub-goto-results");
    if (gotoResults) gotoResults.addEventListener("click", () => jumpToResultsCard(HUB_EVENT_ID));
  } catch (e) {
    wrap.innerHTML = `<p class="msg err show">${escapeAttr(e.message)}</p>`;
  }
}
function jumpToTournamentCard(eventId) {
  switchAdminTab("events");
  const sel = document.getElementById("tourn-event-select");
  if (sel && Array.from(sel.options).some((o) => o.value === String(eventId))) {
    sel.value = String(eventId);
    document.getElementById("tourn-load").click();
    sel.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}
function jumpToResultsCard(eventId) {
  switchAdminTab("events");
  const sel = document.getElementById("res-event");
  if (sel && Array.from(sel.options).some((o) => o.value === String(eventId))) {
    sel.value = String(eventId);
    document.getElementById("res-load").click();
    sel.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

// ------------------------------------------------- admin: members import/export/invite --
async function loadAdminMembers() {
  try {
    MEMBERS_DATA = await api("/api/admin/members");
  } catch (e) {
    MEMBERS_DATA = [];
  }
  renderMembersInviteEventDropdown();
  renderMembersTable();
}

function renderMembersInviteEventDropdown() {
  const sel = document.getElementById("members-invite-event");
  const prevValue = sel.value;
  const upcoming = EVENTS_DATA.filter(isUpcoming);
  sel.innerHTML = upcoming.length
    ? upcoming.map((ev) => `<option value="${ev.id}">${eventLabel(ev)} — ${ev.date}</option>`).join("")
    : `<option value="">${t("noEventsToInvite")}</option>`;
  if (upcoming.some((ev) => String(ev.id) === prevValue)) sel.value = prevValue;
}

function renderMembersTable() {
  const wrap = document.getElementById("members-table");
  if (!MEMBERS_DATA.length) {
    wrap.innerHTML = `<p class="dashboard-empty-note">${t("noMembersYet")}</p>`;
    return;
  }
  const rows = MEMBERS_DATA.map((m) => {
    const searchBlob = escapeAttr(
      `${m.name} ${m.membershipNumber} ${m.phone} ${m.familyGroup}`.toLowerCase()
    );
    return `<tr data-member-row data-search="${searchBlob}">
      <td><input type="checkbox" data-member-checkbox value="${escapeAttr(m.membershipNumber)}" /></td>
      <td>${escapeAttr(m.membershipNumber)}</td>
      <td>${escapeAttr(m.name)}</td>
      <td>${escapeAttr(m.phone)}</td>
      <td>${escapeAttr(m.familyGroup)}</td>
      <td>${m.hasLoggedInAccount ? t("yesLabel") : t("noLabel")}</td>
    </tr>`;
  }).join("");
  wrap.innerHTML = `<div class="dashboard-table-wrap"><table class="dashboard-table">
    <thead><tr>
      <th><input type="checkbox" data-select-all-members title="${escapeAttr(t("selectAllLabel"))}" aria-label="${escapeAttr(t("selectAllLabel"))}" /></th>
      <th>${t("colMembershipNumber")}</th><th>${t("colName")}</th>
      <th>${t("colPhone")}</th><th>${t("colFamilyGroup")}</th><th>${t("colHasAccount")}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
  applyMembersSearchFilter();
  updateMembersSelectAllState();
}

// Filtering hides/shows existing rows rather than rebuilding the table, so
// any checkboxes the admin already ticked survive typing in the search box.
function applyMembersSearchFilter() {
  const query = document.getElementById("members-search").value.trim().toLowerCase();
  document.querySelectorAll("#members-table [data-member-row]").forEach((row) => {
    row.classList.toggle("hidden", !!query && !row.dataset.search.includes(query));
  });
  updateMembersSelectAllState();
}
document.getElementById("members-search").addEventListener("input", applyMembersSearchFilter);

// "Select all" only ever acts on the currently *visible* (unfiltered-out)
// rows - checking it while a search is active shouldn't silently select
// members the admin can't even see. Individually (un)checking a row keeps
// the header checkbox's checked/indeterminate state honest too.
function visibleMemberCheckboxes() {
  return Array.from(
    document.querySelectorAll("#members-table [data-member-row]:not(.hidden) [data-member-checkbox]")
  );
}
function updateMembersSelectAllState() {
  const selectAll = document.querySelector("#members-table [data-select-all-members]");
  if (!selectAll) return;
  const visible = visibleMemberCheckboxes();
  const checkedCount = visible.filter((cb) => cb.checked).length;
  selectAll.checked = visible.length > 0 && checkedCount === visible.length;
  selectAll.indeterminate = checkedCount > 0 && checkedCount < visible.length;
}
document.getElementById("members-table").addEventListener("change", (e) => {
  if (e.target.matches("[data-select-all-members]")) {
    visibleMemberCheckboxes().forEach((cb) => (cb.checked = e.target.checked));
    updateMembersSelectAllState();
  } else if (e.target.matches("[data-member-checkbox]")) {
    updateMembersSelectAllState();
  }
});

document.getElementById("members-export-btn").addEventListener("click", () => {
  window.location.href = "/api/admin/members/export";
});

document.getElementById("members-import-btn").addEventListener("click", async () => {
  const msg = document.getElementById("members-import-msg");
  const fileInput = document.getElementById("members-import-file");
  const file = fileInput.files[0];
  if (!file) return showMsg(msg, t("pleaseChooseFile"), false);
  const fd = new FormData();
  fd.append("file", file);
  try {
    const result = await api("/api/admin/members/import", { method: "POST", body: fd });
    const dependentsAdded = result.dependentsAdded || [];
    const dependentsSkipped = result.dependentsSkipped || [];
    const lines = [
      `${t("importedLabel")}: ${fmt(result.created.length)} ${t("addedLabel")}, ${fmt(result.updated.length)} ${t("updatedLabel")}, ${fmt(dependentsAdded.length)} ${t("dependentsAddedLabel")}, ${fmt(result.errors.length)} ${t("skippedLabel")}.`,
    ];
    // Show *why* rows were skipped instead of just a bare count - a bare
    // count gave no way to diagnose e.g. a header-name mismatch (see the
    // "0 added, 0 updated, 34 skipped" bug report this came from).
    if (result.errors.length) {
      const shown = result.errors.slice(0, 5).map((e) => `${t("rowLabel")} ${e.row}: ${e.reason}`);
      lines.push(shown.join(" · "));
      if (result.errors.length > 5) lines.push(`+${fmt(result.errors.length - 5)} ${t("moreLabel")}`);
    }
    if (dependentsSkipped.length) {
      lines.push(`${fmt(dependentsSkipped.length)} ${t("dependentsSkippedLabel")}`);
    }
    showMsg(msg, lines.join("\n"), result.errors.length === 0);
    fileInput.value = "";
    await loadAdminMembers();
    loadAdminOverview();
    loadAdminDirectory();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

document.getElementById("members-invite-btn").addEventListener("click", async () => {
  const msg = document.getElementById("members-invite-msg");
  const eventId = document.getElementById("members-invite-event").value;
  if (!eventId) return showMsg(msg, t("pleaseSelectEvent"), false);
  const membershipNumbers = Array.from(
    document.querySelectorAll("#members-table [data-member-checkbox]:checked")
  ).map((cb) => cb.value);
  if (!membershipNumbers.length) return showMsg(msg, t("pleaseSelectMembers"), false);
  try {
    const result = await api(`/api/admin/events/${eventId}/invite`, {
      method: "POST",
      body: JSON.stringify({ membershipNumbers }),
    });
    let text = `${t("invitedLabel")} ${fmt(result.invited.length)}. ${fmt(result.skipped.length)} ${t("skippedLabel")}.`;
    if (result.overCapacity > 0) text += ` ${t("overCapacityByLabel")} ${fmt(result.overCapacity)}.`;
    showMsg(msg, text, true);
    document.querySelectorAll("#members-table [data-member-checkbox]:checked").forEach((cb) => (cb.checked = false));
    updateMembersSelectAllState();
    loadAdminDashboard();
    loadAdminOverview();
    loadAdminDirectory();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

// --------------------------------------------------- admin: member directory --
let DIRECTORY_DATA = [];

async function loadAdminDirectory() {
  try {
    DIRECTORY_DATA = await api("/api/admin/directory");
  } catch (e) {
    DIRECTORY_DATA = [];
  }
  renderDirectoryTable();
}

function renderDirectoryTable() {
  const wrap = document.getElementById("directory-table");
  if (!DIRECTORY_DATA.length) {
    wrap.innerHTML = `<p class="dashboard-empty-note">${t("noMembersYet")}</p>`;
    return;
  }
  const rows = DIRECTORY_DATA.map((m, i) => {
    const searchBlob = escapeAttr(`${m.name} ${m.membershipNumber} ${m.phone} ${m.familyGroup}`.toLowerCase());
    const dependentsHtml = m.dependents.length
      ? `<ul class="directory-list">${m.dependents.map((d) => `<li>${escapeAttr(d.name)}</li>`).join("")}</ul>`
      : `<p class="dashboard-empty-note">${t("noDependents")}</p>`;
    const regsHtml = m.registrations.length
      ? `<table class="dashboard-table"><thead><tr>
          <th>${t("colEvent")}</th><th>${t("colDate")}</th><th>${t("colStatus")}</th><th>${t("colPoints")}</th>
        </tr></thead><tbody>${m.registrations
          .map((r) => {
            const label = currentLang === "ar" ? r.nameAr || r.nameEn : r.nameEn;
            const who = r.dependentName ? ` (${escapeAttr(r.dependentName)})` : "";
            const status = r.waitlisted ? t("waitlistLabel") : r.checkedIn ? t("colCheckedIn") : t("statusRegistered");
            return `<tr><td>${escapeAttr(label)}${who}</td><td>${escapeAttr(r.date)}</td><td>${status}</td><td class="num">${fmt(r.points)}</td></tr>`;
          })
          .join("")}</tbody></table>`
      : `<p class="dashboard-empty-note">${t("noRegistrationsYet")}</p>`;
    return `<tr data-directory-row data-search="${searchBlob}">
        <td>${escapeAttr(m.membershipNumber)}</td>
        <td>${escapeAttr(m.name)}</td>
        <td>${escapeAttr(m.phone)}</td>
        <td>${escapeAttr(m.familyGroup)}</td>
        <td class="num">${fmt(m.balance)}</td>
        <td class="num">${fmt(m.registeredCount)}</td>
        <td class="num">${fmt(m.checkedInCount)}</td>
        <td><button class="secondary" data-directory-toggle="${i}" style="padding:3px 10px;font-size:0.78rem;">${t("btnDetails")}</button></td>
      </tr>
      <tr data-directory-row data-search="${searchBlob}" data-directory-detail="${i}" data-open="false" class="hidden">
        <td colspan="8">
          <div class="grid-2">
            <div><h4 style="margin:6px 0;">${t("colFamilyMembers")}</h4>${dependentsHtml}</div>
            <div><h4 style="margin:6px 0;">${t("colRegistrations")}</h4>${regsHtml}</div>
          </div>
        </td>
      </tr>`;
  }).join("");
  wrap.innerHTML = `<div class="dashboard-table-wrap"><table class="dashboard-table">
    <thead><tr>
      <th>${t("colMembershipNumber")}</th><th>${t("colName")}</th><th>${t("colPhone")}</th>
      <th>${t("colFamilyGroup")}</th><th>${t("colPointsBalance")}</th><th>${t("colRegistrations")}</th>
      <th>${t("colCheckedIn")}</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
  wrap.querySelectorAll("[data-directory-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const detailRow = wrap.querySelector(`[data-directory-detail="${btn.dataset.directoryToggle}"]`);
      const nowOpen = detailRow.dataset.open !== "true";
      detailRow.dataset.open = String(nowOpen);
      btn.textContent = nowOpen ? t("btnHideDetails") : t("btnDetails");
      applyDirectorySearchFilter();
    });
  });
  applyDirectorySearchFilter();
}

// A detail row is visible only when BOTH its summary row matches the search
// AND the admin has explicitly opened it via the "Details" button - so
// typing in the search box never forces a detail panel open, and it also
// doesn't leave a stale open panel visible once its member is filtered out.
function applyDirectorySearchFilter() {
  const query = document.getElementById("directory-search").value.trim().toLowerCase();
  document.querySelectorAll("#directory-table [data-directory-row]").forEach((row) => {
    const matches = !query || row.dataset.search.includes(query);
    if (row.hasAttribute("data-directory-detail")) {
      row.classList.toggle("hidden", !matches || row.dataset.open !== "true");
    } else {
      row.classList.toggle("hidden", !matches);
    }
  });
}
document.getElementById("directory-search").addEventListener("input", applyDirectorySearchFilter);

// -------------------------------------------------------- edit points rules --

async function loadRulesForEdit() {
  try {
    const data = await api("/api/ladder");
    LADDER_DATA = data;
    const r = data.rules;
    document.getElementById("rules-participation").value = r.participation;
    document.getElementById("rules-early-bonus").value = r.earlyBonus;
    [1, 2, 3, 4, 5, 6].forEach((p) => {
      document.getElementById("rules-pos-" + p).value = r.positionBonus[p];
    });
  } catch (e) {
    /* admin panel still usable even if this fails to preload */
  }
}

document.getElementById("rules-save").addEventListener("click", async () => {
  const msg = document.getElementById("rules-msg");
  const participation = parseInt(document.getElementById("rules-participation").value, 10);
  const earlyBonus = parseInt(document.getElementById("rules-early-bonus").value, 10);
  const positionBonus = {};
  for (const p of [1, 2, 3, 4, 5, 6]) {
    positionBonus[p] = parseInt(document.getElementById("rules-pos-" + p).value, 10);
  }
  if (!confirm(t("rulesWarning"))) return;
  try {
    await api("/api/rules", {
      method: "PUT",
      body: JSON.stringify({ participation, earlyBonus, positionBonus }),
    });
    await loadLadder();
    showMsg(msg, t("rulesSaved"), true);
    if (CURRENT_SESSION && CURRENT_SESSION.type === "member") loadMyBalance();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

// ------------------------------------------------------ edit redemption ladder --
function renderLadderEdit() {
  if (!LADDER_DATA) return;
  const wrap = document.getElementById("ladder-edit-list");
  wrap.innerHTML = LADDER_DATA.ladder
    .map(
      (tier) => `
    <div class="ladder-edit-item" data-tier="${tier.tier}">
      <h4>${t("ladderTierLabel")} ${tier.tier}</h4>
      <div class="grid-2">
        <div><label>${t("fieldPointsRequired")}</label><input type="number" min="1" step="1" class="le-points" value="${tier.pointsRequired}" /></div>
        <div><label>${t("fieldRewardEn")}</label><input class="le-reward-en" value="${escapeAttr(tier.rewardEn)}" /></div>
        <div><label>${t("fieldRewardAr")}</label><input class="le-reward-ar" dir="rtl" value="${escapeAttr(tier.rewardAr)}" /></div>
        <div><label>${t("fieldDescEn")}</label><input class="le-desc-en" value="${escapeAttr(tier.descEn)}" /></div>
        <div><label>${t("fieldDescAr")}</label><input class="le-desc-ar" dir="rtl" value="${escapeAttr(tier.descAr)}" /></div>
        <div><label>${t("fieldApproverEn")}</label><input class="le-approver-en" value="${escapeAttr(tier.approverEn)}" /></div>
        <div><label>${t("fieldApproverAr")}</label><input class="le-approver-ar" dir="rtl" value="${escapeAttr(tier.approverAr)}" /></div>
      </div>
      <button class="secondary le-save" data-tier="${tier.tier}">${t("btnSaveTier")}</button>
      <div class="msg le-msg"></div>
    </div>`
    )
    .join("");
  wrap.querySelectorAll(".le-save").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest(".ladder-edit-item");
      const tierNum = Number(btn.dataset.tier);
      const msg = item.querySelector(".le-msg");
      const pointsRequired = parseInt(item.querySelector(".le-points").value, 10);
      const rewardEn = item.querySelector(".le-reward-en").value.trim();
      const rewardAr = item.querySelector(".le-reward-ar").value.trim();
      const descEn = item.querySelector(".le-desc-en").value.trim();
      const descAr = item.querySelector(".le-desc-ar").value.trim();
      const approverEn = item.querySelector(".le-approver-en").value.trim();
      const approverAr = item.querySelector(".le-approver-ar").value.trim();
      if (!confirm(t("rulesWarning"))) return;
      try {
        await api("/api/ladder/" + tierNum, {
          method: "PUT",
          body: JSON.stringify({ pointsRequired, rewardEn, rewardAr, descEn, descAr, approverEn, approverAr }),
        });
        await loadLadder();
        showMsg(msg, t("tierSaved"), true);
        if (CURRENT_SESSION && CURRENT_SESSION.type === "member") loadMyBalance();
      } catch (e) {
        showMsg(msg, e.message, false);
      }
    });
  });
}

document.getElementById("ev-submit").addEventListener("click", async () => {
  const nameEn = document.getElementById("ev-name-en").value.trim();
  const nameAr = document.getElementById("ev-name-ar").value.trim();
  const sport = document.getElementById("ev-sport").value.trim();
  const date = document.getElementById("ev-date").value;
  const endDate = document.getElementById("ev-end-date").value;
  const startTime = document.getElementById("ev-start-time").value;
  const endTime = document.getElementById("ev-end-time").value;
  const earlyDeadline = document.getElementById("ev-deadline").value;
  const descriptionEn = document.getElementById("ev-desc-en").value.trim();
  const descriptionAr = document.getElementById("ev-desc-ar").value.trim();
  const minCapacity = document.getElementById("ev-min-capacity").value;
  const maxCapacity = document.getElementById("ev-max-capacity").value;
  const parentEventId = document.getElementById("ev-parent-event").value;
  const allowMultipleActivities = document.getElementById("ev-allow-multi").checked;
  const photoInput = document.getElementById("ev-photo");
  const msg = document.getElementById("ev-msg");
  if (!nameEn || !date) {
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  const fd = new FormData();
  fd.append("nameEn", nameEn);
  fd.append("nameAr", nameAr);
  fd.append("sport", sport);
  fd.append("date", date);
  fd.append("endDate", endDate);
  fd.append("startTime", startTime);
  fd.append("endTime", endTime);
  fd.append("earlyDeadline", datetimeLocalToIsoOrEmpty(earlyDeadline));
  fd.append("descriptionEn", descriptionEn);
  fd.append("descriptionAr", descriptionAr);
  fd.append("minCapacity", minCapacity);
  fd.append("maxCapacity", maxCapacity);
  fd.append("parentEventId", parentEventId);
  fd.append("allowMultipleActivities", allowMultipleActivities ? "true" : "false");
  if (photoInput.files[0]) fd.append("coverPhoto", photoInput.files[0]);
  try {
    await api("/api/events", { method: "POST", body: fd });
    showMsg(msg, "OK", true);
    document.getElementById("ev-name-en").value = "";
    document.getElementById("ev-name-ar").value = "";
    document.getElementById("ev-sport").value = "";
    document.getElementById("ev-desc-en").value = "";
    document.getElementById("ev-desc-ar").value = "";
    document.getElementById("ev-min-capacity").value = "";
    document.getElementById("ev-max-capacity").value = "";
    document.getElementById("ev-end-date").value = "";
    document.getElementById("ev-start-time").value = "";
    document.getElementById("ev-end-time").value = "";
    document.getElementById("ev-parent-event").value = "";
    document.getElementById("ev-allow-multi").checked = false;
    photoInput.value = "";
    await loadEvents();
    await loadAdminOverview();
    await loadAdminDashboard();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

function populateEditForm(ev) {
  const fields = document.getElementById("ev-edit-fields");
  if (!ev) {
    fields.classList.add("hidden");
    return;
  }
  document.getElementById("ev-edit-name-en").value = ev.nameEn || "";
  document.getElementById("ev-edit-name-ar").value = ev.nameAr || "";
  document.getElementById("ev-edit-sport").value = ev.sport || "";
  document.getElementById("ev-edit-date").value = ev.date || "";
  document.getElementById("ev-edit-end-date").value = ev.endDate || "";
  document.getElementById("ev-edit-start-time").value = ev.startTime || "";
  document.getElementById("ev-edit-end-time").value = ev.endTime || "";
  document.getElementById("ev-edit-deadline").value = isoToDatetimeLocal(ev.earlyDeadline);
  document.getElementById("ev-edit-desc-en").value = ev.descriptionEn || "";
  document.getElementById("ev-edit-desc-ar").value = ev.descriptionAr || "";
  document.getElementById("ev-edit-min-capacity").value = ev.minCapacity != null ? ev.minCapacity : "";
  document.getElementById("ev-edit-max-capacity").value = ev.maxCapacity != null ? ev.maxCapacity : "";
  document.getElementById("ev-edit-photo").value = "";
  const statusEl = document.getElementById("ev-edit-capacity-status");
  if (ev.confirmedCount !== undefined) {
    statusEl.textContent = `${t("currentlyRegistered")}: ${fmt(ev.confirmedCount)}${
      ev.waitlistCount ? ` (${fmt(ev.waitlistCount)} ${t("waitlistLabel")})` : ""
    }`;
  } else {
    statusEl.textContent = "";
  }
  fields.dataset.eventId = ev.id;
  // The parent-event dropdown's eligible options depend on which event is
  // being edited (an event with children can't be assigned a parent, and an
  // event can't be its own parent) - repopulate now that dataset.eventId is set.
  populateParentEventOptions();
  const editParentSel = document.getElementById("ev-edit-parent-event");
  if (editParentSel) editParentSel.value = ev.parentEventId ? String(ev.parentEventId) : "";
  const editAllowMulti = document.getElementById("ev-edit-allow-multi");
  if (editAllowMulti) editAllowMulti.checked = !!ev.allowMultipleActivities;
  fields.classList.remove("hidden");
}
document.getElementById("ev-edit-load").addEventListener("click", () => {
  const eventId = document.getElementById("ev-edit-select").value;
  document.getElementById("ev-edit-msg").classList.remove("show");
  if (!eventId) {
    document.getElementById("ev-edit-fields").classList.add("hidden");
    return;
  }
  populateEditForm(EVENTS_DATA.find((e) => e.id === Number(eventId)));
});

document.getElementById("ev-edit-save").addEventListener("click", async () => {
  const eventId = document.getElementById("ev-edit-fields").dataset.eventId;
  const msg = document.getElementById("ev-edit-msg");
  const nameEn = document.getElementById("ev-edit-name-en").value.trim();
  const nameAr = document.getElementById("ev-edit-name-ar").value.trim();
  const sport = document.getElementById("ev-edit-sport").value.trim();
  const date = document.getElementById("ev-edit-date").value;
  const endDate = document.getElementById("ev-edit-end-date").value;
  const startTime = document.getElementById("ev-edit-start-time").value;
  const endTime = document.getElementById("ev-edit-end-time").value;
  const earlyDeadline = document.getElementById("ev-edit-deadline").value;
  const descriptionEn = document.getElementById("ev-edit-desc-en").value.trim();
  const descriptionAr = document.getElementById("ev-edit-desc-ar").value.trim();
  const minCapacity = document.getElementById("ev-edit-min-capacity").value;
  const maxCapacity = document.getElementById("ev-edit-max-capacity").value;
  const parentEventId = document.getElementById("ev-edit-parent-event").value;
  const allowMultipleActivities = document.getElementById("ev-edit-allow-multi").checked;
  const photoInput = document.getElementById("ev-edit-photo");
  if (!eventId) return;
  if (!nameEn || !date) {
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  const fd = new FormData();
  fd.append("nameEn", nameEn);
  fd.append("nameAr", nameAr);
  fd.append("sport", sport);
  fd.append("date", date);
  fd.append("endDate", endDate);
  fd.append("startTime", startTime);
  fd.append("endTime", endTime);
  fd.append("earlyDeadline", datetimeLocalToIsoOrEmpty(earlyDeadline));
  fd.append("descriptionEn", descriptionEn);
  fd.append("descriptionAr", descriptionAr);
  fd.append("minCapacity", minCapacity);
  fd.append("maxCapacity", maxCapacity);
  fd.append("parentEventId", parentEventId);
  fd.append("allowMultipleActivities", allowMultipleActivities ? "true" : "false");
  if (photoInput.files[0]) fd.append("coverPhoto", photoInput.files[0]);
  try {
    const saved = await api("/api/events/" + eventId, { method: "PUT", body: fd });
    showMsg(msg, t("eventSaved"), true);
    await loadEvents();
    await loadAdminDashboard();
    // Re-populate the edit form from the freshly-saved event (picks up the
    // new cover photo URL if one was just uploaded) rather than leaving
    // stale values sitting in the fields. Read straight from the save
    // response instead of re-deriving from the select's value, since a
    // date change can move the event out of the (upcoming-only) dropdown.
    populateEditForm(saved);
    const sel = document.getElementById("ev-edit-select");
    if (sel && Array.from(sel.options).some((o) => o.value === String(saved.id))) sel.value = String(saved.id);
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

document.getElementById("ev-delete-btn").addEventListener("click", async () => {
  const sel = document.getElementById("ev-delete-select");
  const msg = document.getElementById("ev-delete-msg");
  const eventId = sel.value;
  if (!eventId) return;
  const ev = EVENTS_DATA.find((e) => e.id === Number(eventId));
  const label = ev ? `${eventLabel(ev)} — ${ev.date}` : eventId;
  const regCount = ev ? (ev.confirmedCount || 0) + (ev.waitlistCount || 0) : 0;
  const warning = regCount
    ? t("confirmDeleteEventWithRegs").replace("{name}", label).replace("{count}", fmt(regCount))
    : t("confirmDeleteEvent").replace("{name}", label);
  if (!confirm(warning)) return;
  try {
    await api("/api/events/" + eventId, { method: "DELETE" });
    showMsg(msg, t("eventDeleted"), true);
    document.getElementById("ev-edit-fields").classList.add("hidden");
    document.getElementById("ev-edit-select").value = "";
    await loadEvents();
    await loadAdminOverview();
    await loadAdminDashboard();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

// --------------------------------------------------------- admin: news --
async function loadNewsAdminList() {
  const wrap = document.getElementById("news-admin-list");
  if (!wrap) return;
  try {
    const posts = await api("/api/news");
    if (!posts.length) {
      wrap.innerHTML = "";
      return;
    }
    wrap.innerHTML = posts
      .map(
        (p) => `<div class="content-admin-item" data-id="${p.id}">
      <div>
        <div class="title">${escapeAttr(p.titleEn || p.titleAr)}</div>
        <div class="sub">${escapeAttr(new Date(p.postedAt).toLocaleDateString())}</div>
      </div>
      <button class="secondary news-delete" data-id="${p.id}" style="margin-top:0;">${escapeAttr(t("btnRemove"))}</button>
    </div>`
      )
      .join("");
    wrap.querySelectorAll(".news-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(t("confirmDeleteNews"))) return;
        try {
          await api("/api/news/" + btn.dataset.id, { method: "DELETE" });
          await loadNewsAdminList();
          await loadCommunityContent();
        } catch (e) {
          /* ignore - list stays as-is if delete fails */
        }
      });
    });
  } catch (e) {
    wrap.innerHTML = "";
  }
}
document.getElementById("news-submit").addEventListener("click", async () => {
  const titleEn = document.getElementById("news-title-en").value.trim();
  const titleAr = document.getElementById("news-title-ar").value.trim();
  const bodyEn = document.getElementById("news-body-en").value.trim();
  const bodyAr = document.getElementById("news-body-ar").value.trim();
  const photoInput = document.getElementById("news-photo");
  const msg = document.getElementById("news-msg");
  if (!titleEn || !bodyEn) {
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  const fd = new FormData();
  fd.append("titleEn", titleEn);
  fd.append("titleAr", titleAr);
  fd.append("bodyEn", bodyEn);
  fd.append("bodyAr", bodyAr);
  if (photoInput.files[0]) fd.append("photo", photoInput.files[0]);
  try {
    await api("/api/news", { method: "POST", body: fd });
    showMsg(msg, t("newsPosted"), true);
    document.getElementById("news-title-en").value = "";
    document.getElementById("news-title-ar").value = "";
    document.getElementById("news-body-en").value = "";
    document.getElementById("news-body-ar").value = "";
    photoInput.value = "";
    await loadNewsAdminList();
    await loadCommunityContent();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

// --------------------------------------------------- admin: spotlights --
async function loadSpotlightAdminList() {
  const wrap = document.getElementById("spotlight-admin-list");
  if (!wrap) return;
  try {
    const spotlights = await api("/api/spotlights");
    if (!spotlights.length) {
      wrap.innerHTML = "";
      return;
    }
    wrap.innerHTML = spotlights
      .map(
        (s) => `<div class="content-admin-item" data-id="${s.id}">
      <div>
        <div class="title">${escapeAttr(s.name)}</div>
        <div class="sub">${escapeAttr(truncate(s.blurbEn || s.blurbAr || "", 60))}</div>
      </div>
      <button class="secondary spotlight-delete" data-id="${s.id}" style="margin-top:0;">${escapeAttr(t("btnRemove"))}</button>
    </div>`
      )
      .join("");
    wrap.querySelectorAll(".spotlight-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(t("confirmDeleteSpotlight"))) return;
        try {
          await api("/api/spotlights/" + btn.dataset.id, { method: "DELETE" });
          await loadSpotlightAdminList();
          await loadCommunityContent();
        } catch (e) {
          /* ignore - list stays as-is if delete fails */
        }
      });
    });
  } catch (e) {
    wrap.innerHTML = "";
  }
}
document.getElementById("spotlight-submit").addEventListener("click", async () => {
  const name = document.getElementById("spotlight-name").value.trim();
  const blurbEn = document.getElementById("spotlight-blurb-en").value.trim();
  const blurbAr = document.getElementById("spotlight-blurb-ar").value.trim();
  const photoInput = document.getElementById("spotlight-photo");
  const msg = document.getElementById("spotlight-msg");
  if (!name) {
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  const fd = new FormData();
  fd.append("name", name);
  fd.append("blurbEn", blurbEn);
  fd.append("blurbAr", blurbAr);
  if (photoInput.files[0]) fd.append("photo", photoInput.files[0]);
  try {
    await api("/api/spotlights", { method: "POST", body: fd });
    showMsg(msg, t("spotlightAdded"), true);
    document.getElementById("spotlight-name").value = "";
    document.getElementById("spotlight-blurb-en").value = "";
    document.getElementById("spotlight-blurb-ar").value = "";
    photoInput.value = "";
    await loadSpotlightAdminList();
    await loadCommunityContent();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

document.getElementById("res-load").addEventListener("click", async () => {
  const eventId = document.getElementById("res-event").value;
  const wrap = document.getElementById("res-table-wrap");
  const recapFields = document.getElementById("res-recap-fields");
  if (!eventId) return;
  const regs = await api("/api/registrations?eventId=" + eventId);
  // Note: the recap write-up/photos below don't depend on there being any
  // registrations - an admin should be able to add an after-event recap
  // even for an event with zero (or not-yet-loaded) sign-ups.
  if (!regs.length) {
    wrap.innerHTML = `<p style="color:var(--muted);">--</p>`;
  } else {
    wrap.innerHTML = `<table>
    <thead><tr><th>${t("colName")}</th><th>${t("colMembership")}</th><th>${t("tabScan")}</th><th>${t("colPosition")}</th></tr></thead>
    <tbody>
      ${regs
        .map(
          (r) => `<tr>
        <td>${escapeAttr(r.attendeeName || (r.member ? r.member.name : ""))}${r.dependentName ? ` <span style="color:var(--muted);font-size:0.75rem;">(${t("familyMemberOf")} ${escapeAttr(r.member ? r.member.name : "")})</span>` : ""}</td>
        <td>${escapeAttr(r.membershipNumber)}</td>
        <td>${r.checkedIn ? `<span class="badge Fulfilled">${t("scanSuccess")}</span>` : `<span class="badge Pending">${t("statPending")}</span>`}</td>
        <td>
          <select data-reg-id="${r.id}" class="res-position">
            <option value="">${t("noPosition")}</option>
            ${[1, 2, 3, 4, 5, 6].map((p) => `<option value="${p}" ${r.position === p ? "selected" : ""}>${p}</option>`).join("")}
          </select>
        </td>
      </tr>`
        )
        .join("")}
    </tbody>
  </table>`;
  }
  document.getElementById("res-save").classList.remove("hidden");
  document.getElementById("res-save").dataset.eventId = eventId;

  // Prefill any recap text already saved for this event, so re-entering
  // results (e.g. a late position correction) doesn't blank out the recap.
  const ev = EVENTS_DATA.find((e) => e.id === Number(eventId));
  document.getElementById("res-recap-desc-en").value = (ev && ev.recap && ev.recap.descriptionEn) || "";
  document.getElementById("res-recap-desc-ar").value = (ev && ev.recap && ev.recap.descriptionAr) || "";
  document.getElementById("res-recap-photos").value = "";
  recapFields.classList.remove("hidden");
});

document.getElementById("res-save").addEventListener("click", async () => {
  const eventId = document.getElementById("res-save").dataset.eventId;
  const msg = document.getElementById("res-msg");
  const results = Array.from(document.querySelectorAll(".res-position")).map((sel) => ({
    registrationId: sel.dataset.regId,
    position: sel.value || null,
  }));
  const fd = new FormData();
  fd.append("results", JSON.stringify(results));
  fd.append("recapDescriptionEn", document.getElementById("res-recap-desc-en").value.trim());
  fd.append("recapDescriptionAr", document.getElementById("res-recap-desc-ar").value.trim());
  Array.from(document.getElementById("res-recap-photos").files).forEach((file) => fd.append("recapPhotos", file));
  try {
    await api("/api/events/" + eventId + "/results", { method: "POST", body: fd });
    showMsg(msg, t("recapSaved"), true);
    document.getElementById("res-recap-photos").value = "";
    await loadEvents();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

// ------------------------------------------------------ admin: tournament --
// Generates a group stage and/or knockout bracket from an event's confirmed
// registrations (or from teams the admin groups them into), and can push
// the final standings straight into that event's points via the same
// reg.position field Enter Event Results uses. All state lives server-side
// (db.tournaments) - these globals just hold the last-loaded snapshot so
// the UI doesn't have to refetch after every click.
let TOURNAMENT_EVENT_ID = null;
let TOURNAMENT_DATA = null;
let TOURNAMENT_REGISTRATIONS = [];

document.getElementById("tourn-load").addEventListener("click", () => {
  const eventId = document.getElementById("tourn-event-select").value;
  if (eventId) loadTournamentPanel(eventId);
});

// Delegated once on the static #tourn-body wrapper (its innerHTML is
// replaced on every render, but the element itself never is) - inline
// onclick="" attributes are blocked by this app's CSP (script-src has no
// 'unsafe-inline'), so every button injected by the render* functions below
// carries data-tourn-action (+ any data-* args) instead and is dispatched
// from here.
document.getElementById("tourn-body").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-tourn-action]");
  if (!btn) return;
  const action = btn.dataset.tournAction;
  if (action === "delete-tournament") deleteTournament();
  else if (action === "create-tournament") createTournament();
  else if (action === "save-teams") saveTournamentTeams();
  else if (action === "move-entrant") moveTournamentEntrant(btn.dataset.entrantId, Number(btn.dataset.dir));
  else if (action === "randomize-seed") randomizeTournamentSeed();
  else if (action === "generate-tournament") generateTournament();
  else if (action === "group-result") recordTournamentGroupResult(btn);
  else if (action === "generate-knockout") generateTournamentKnockout();
  else if (action === "knockout-result") recordTournamentKnockoutResult(btn);
  else if (action === "award-points") awardTournamentPoints();
  else if (action === "set-attendance") setTournamentAttendance(Number(btn.dataset.registrationId), btn.dataset.status);
  else if (action === "update-schedule") updateTournamentSchedule();
});
document.getElementById("tourn-body").addEventListener("change", (e) => {
  if (e.target.id === "tourn-format") toggleTournamentGroupFields();
});
// Live-recomputes the setup dashboard preview (see computeTournamentSetupPreview
// above) on every keystroke/change to any field that feeds it, in either the
// creation form or the post-creation schedule editor.
const TOURN_CREATE_PREVIEW_FIELDS = new Set([
  "tourn-mode", "tourn-format", "tourn-num-groups", "tourn-advance-per-group",
  "tourn-win-points", "tourn-draw-points", "tourn-loss-points",
  "tourn-courts", "tourn-match-minutes", "tourn-start-time", "tourn-break-minutes", "tourn-available-hours",
]);
const TOURN_EDIT_PREVIEW_FIELDS = new Set([
  "tourn-edit-win-points", "tourn-edit-draw-points", "tourn-edit-loss-points",
  "tourn-edit-courts", "tourn-edit-match-minutes", "tourn-edit-start-time", "tourn-edit-break-minutes", "tourn-edit-available-hours",
]);
function tournPreviewInputHandler(e) {
  if (TOURN_CREATE_PREVIEW_FIELDS.has(e.target.id)) refreshCreateSetupPreview();
  else if (TOURN_EDIT_PREVIEW_FIELDS.has(e.target.id)) refreshEditSetupPreview();
}
document.getElementById("tourn-body").addEventListener("input", tournPreviewInputHandler);
document.getElementById("tourn-body").addEventListener("change", tournPreviewInputHandler);

async function loadTournamentPanel(eventId) {
  TOURNAMENT_EVENT_ID = Number(eventId);
  const msg = document.getElementById("tourn-msg");
  if (msg) msg.textContent = "";
  try {
    const data = await api("/api/admin/tournaments/" + eventId);
    TOURNAMENT_DATA = data.tournament;
    TOURNAMENT_REGISTRATIONS = data.registrations || [];
    renderTournamentBody();
  } catch (e) {
    document.getElementById("tourn-body").innerHTML = `<p class="msg err show">${escapeAttr(e.message)}</p>`;
  }
}

function renderTournamentBody() {
  const body = document.getElementById("tourn-body");
  if (!body) return;
  if (!TOURNAMENT_DATA) {
    body.innerHTML = renderTournamentCreateForm();
    refreshCreateSetupPreview();
    return;
  }
  let inner = "";
  if (TOURNAMENT_DATA.status === "team-setup") inner = renderTournamentTeamSetup();
  else if (TOURNAMENT_DATA.status === "seeding") inner = renderTournamentSeeding();
  else if (TOURNAMENT_DATA.status === "groups") inner = renderTournamentGroups();
  else if (TOURNAMENT_DATA.status === "knockout") inner = renderTournamentBracket();
  else if (TOURNAMENT_DATA.status === "completed") inner = renderTournamentBracket() + renderTournamentStandings();
  if (TOURNAMENT_DATA.status !== "team-setup") inner += renderTournamentScheduleEditor() + renderTournamentAttendance();
  const modeLabel = TOURNAMENT_DATA.mode === "team" ? t("tournamentModeTeam") : t("tournamentModeIndividual");
  const formatLabel = TOURNAMENT_DATA.format === "groups" ? t("tournamentFormatGroups") : t("tournamentFormatKnockout");
  const matchesLink = TOURNAMENT_DATA.schedule
    ? `<a class="secondary small" style="margin-inline-start:8px;text-decoration:none;display:inline-block;" href="/matches.html?event=${TOURNAMENT_EVENT_ID}&lang=${currentLang}" target="_blank" rel="noopener">${t("btnViewLiveMatches")}</a>`
    : "";
  body.innerHTML = `
    <div class="tourn-summary">
      <span class="tourn-summary-badge">${escapeAttr(modeLabel)}</span>
      <span class="tourn-summary-badge">${escapeAttr(formatLabel)}</span>
      ${matchesLink}
      <button class="danger small" style="margin-inline-start:auto;" data-tourn-action="delete-tournament">${t("btnDeleteTournament")}</button>
    </div>
    ${inner}
  `;
  if (TOURNAMENT_DATA.status !== "team-setup") refreshEditSetupPreview();
}

// Present/absent check-in for the actual players in this tournament -
// every registration behind every entrant (in team mode, every member of
// every team individually, not just the team as a whole). Shown from the
// seeding step onward, once entrants are known, independent of match
// status - marking someone present doesn't require the bracket to exist yet.
function renderTournamentAttendance() {
  const list = TOURNAMENT_DATA.attendance || [];
  if (!list.length) return "";
  const allMatches = collectAllTournamentMatches(TOURNAMENT_DATA);
  const statusBtn = (regId, status, label, cls) =>
    `<button class="secondary small ${cls}" data-tourn-action="set-attendance" data-registration-id="${regId}" data-status="${status}">${label}</button>`;
  const rowHtml = (a) => `
    <div class="tourn-attendance-row tourn-att-${a.status}">
      <span class="tourn-attendance-name">${escapeAttr(a.name)}</span>
      <span class="tourn-attendance-actions">
        ${statusBtn(a.registrationId, "present", t("attStatusPresent"), a.status === "present" ? "active" : "")}
        ${statusBtn(a.registrationId, "not_yet", t("attStatusNotYet"), a.status === "not_yet" ? "active" : "")}
        ${statusBtn(a.registrationId, "absent", t("attStatusAbsent"), a.status === "absent" ? "active" : "")}
      </span>
    </div>`;
  let body;
  if (TOURNAMENT_DATA.mode === "team") {
    const byEntrant = {};
    list.forEach((a) => {
      if (!byEntrant[a.entrantId]) byEntrant[a.entrantId] = { label: a.entrantLabel, entrantId: a.entrantId, rows: [] };
      byEntrant[a.entrantId].rows.push(a);
    });
    body = Object.values(byEntrant)
      .map(
        (grp) => `<div class="tourn-attendance-team">
          <h5>${escapeAttr(grp.label)}${grp.rows.every((r) => r.status === "present") ? ` <span class="tourn-att-complete">${t("teamAttendanceComplete")}</span>` : ""}</h5>
          ${grp.rows.map(rowHtml).join("")}
          ${matchesBlockHtml(allMatches, grp.entrantId)}
        </div>`
      )
      .join("");
  } else {
    body = list.map((a) => rowHtml(a) + matchesBlockHtml(allMatches, a.entrantId)).join("");
  }
  const presentCount = list.filter((a) => a.status === "present").length;
  return `
    <div class="tourn-attendance" style="margin-top:24px;border-top:1px solid var(--border);padding-top:16px;">
      <h4>${t("adminTournamentAttendance")} <span class="hint-note" style="display:inline;">(${presentCount}/${list.length})</span></h4>
      ${body}
    </div>
  `;
}
// Manage courts/matchMinutes/startTime/breakMinutes at any point, not just
// at creation - filling these in for the first time turns on scheduling,
// changing them once a group stage or bracket already exists recalculates
// every still-to-play match's court/time (results already recorded are
// untouched).
function renderTournamentScheduleEditor() {
  const s = TOURNAMENT_DATA.schedule;
  return `
    <div class="tourn-schedule-editor" style="margin-top:24px;border-top:1px solid var(--border);padding-top:16px;">
      <h4>${t("adminTournamentSchedule")}</h4>
      <p class="hint-note">${t("editScheduleHint")}</p>
      <div class="grid-2">
        <div><label>${t("fieldWinPoints")}</label><input id="tourn-edit-win-points" type="number" min="0" value="${TOURNAMENT_DATA.winPoints}" /></div>
        <div><label>${t("fieldDrawPoints")}</label><input id="tourn-edit-draw-points" type="number" min="0" value="${TOURNAMENT_DATA.drawPoints}" /></div>
        <div><label>${t("fieldLossPoints")}</label><input id="tourn-edit-loss-points" type="number" min="0" value="${TOURNAMENT_DATA.lossPoints}" /></div>
      </div>
      <div class="grid-2" style="margin-top:8px;">
        <div><label>${t("fieldCourts")}</label><input id="tourn-edit-courts" type="number" min="1" value="${s ? s.courts : ""}" /></div>
        <div><label>${t("fieldMatchMinutes")}</label><input id="tourn-edit-match-minutes" type="number" min="1" value="${s ? s.matchMinutes : ""}" /></div>
        <div><label>${t("fieldStartTime")}</label><input id="tourn-edit-start-time" type="time" value="${s ? escapeAttr(s.startTime) : ""}" /></div>
        <div><label>${t("fieldBreakMinutes")}</label><input id="tourn-edit-break-minutes" type="number" min="0" value="${s ? s.breakMinutes : 0}" /></div>
        <div><label>${t("fieldAvailableHours")}</label><input id="tourn-edit-available-hours" type="number" min="0" step="0.5" value="${TOURNAMENT_DATA.availableHours != null ? TOURNAMENT_DATA.availableHours : ""}" placeholder="${escapeAttr(t("optionalPlaceholder"))}" /></div>
      </div>
      <div id="tourn-setup-preview-edit"></div>
      <button class="secondary" style="margin-top:8px;" data-tourn-action="update-schedule">${t("btnUpdateSchedule")}</button>
    </div>
  `;
}
async function updateTournamentSchedule() {
  const msg = document.getElementById("tourn-msg");
  const courts = document.getElementById("tourn-edit-courts").value.trim();
  const matchMinutes = document.getElementById("tourn-edit-match-minutes").value.trim();
  const startTime = document.getElementById("tourn-edit-start-time").value.trim();
  const breakMinutes = document.getElementById("tourn-edit-break-minutes").value.trim();
  const winPoints = document.getElementById("tourn-edit-win-points").value.trim();
  const drawPoints = document.getElementById("tourn-edit-draw-points").value.trim();
  const lossPoints = document.getElementById("tourn-edit-loss-points").value.trim();
  const availableHours = document.getElementById("tourn-edit-available-hours").value.trim();
  if (!courts || !matchMinutes || !startTime) return showMsg(msg, t("scheduleFieldsRequired"), false);
  try {
    const data = await api("/api/admin/tournaments/" + TOURNAMENT_EVENT_ID + "/schedule", {
      method: "PUT",
      body: JSON.stringify({
        courts: Number(courts),
        matchMinutes: Number(matchMinutes),
        startTime,
        breakMinutes: breakMinutes === "" ? 0 : Number(breakMinutes),
        winPoints: winPoints === "" ? undefined : Number(winPoints),
        drawPoints: drawPoints === "" ? undefined : Number(drawPoints),
        lossPoints: lossPoints === "" ? undefined : Number(lossPoints),
        availableHours: availableHours === "" ? null : Number(availableHours),
      }),
    });
    TOURNAMENT_DATA = data.tournament;
    showMsg(msg, t("scheduleUpdated"), true);
    renderTournamentBody();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}
async function setTournamentAttendance(registrationId, status) {
  const msg = document.getElementById("tourn-msg");
  try {
    const data = await api("/api/admin/tournaments/" + TOURNAMENT_EVENT_ID + "/attendance", {
      method: "PUT",
      body: JSON.stringify({ registrationId, status }),
    });
    TOURNAMENT_DATA = data.tournament;
    renderTournamentBody();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}

// ---- Live "setup dashboard" calculator, matching the committee's own
// tournament-planning spreadsheet: as the admin fills in groups/qualifiers,
// courts/minutes/start time and win-draw-loss points, this recomputes match
// counts, time slots, total duration, expected finish time and a plain-
// language readiness message - all before anything is actually generated.
// Pure function, no server round-trip, so it updates on every keystroke.
function tournNextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
function tournCombinations2(n) {
  return n > 1 ? (n * (n - 1)) / 2 : 0;
}
function tournMinutesLabel(mins) {
  if (!mins || mins <= 0) return "0m";
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
function tournTimeStrToMinutes(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}
function tournMinutesToTimeStr(mins) {
  const wrapped = ((Math.round(mins) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

function computeTournamentSetupPreview(cfg) {
  const activeTeams = Math.max(0, Number(cfg.activeTeams) || 0);
  const courts = Number(cfg.courts) > 0 ? Number(cfg.courts) : 0;
  const matchMinutes = Number(cfg.matchMinutes) > 0 ? Number(cfg.matchMinutes) : 0;
  const numGroups = Number(cfg.numGroups) > 0 ? Number(cfg.numGroups) : 0;
  const advancePerGroup = Number(cfg.advancePerGroup) > 0 ? Number(cfg.advancePerGroup) : 0;

  let groupStageMatches = 0;
  let knockoutTeams = 0;
  let avgTeamsPerGroup = 0;
  if (cfg.format === "groups" && numGroups > 0) {
    avgTeamsPerGroup = activeTeams / numGroups;
    const base = Math.floor(activeTeams / numGroups);
    const remainder = activeTeams % numGroups;
    groupStageMatches = remainder * tournCombinations2(base + 1) + (numGroups - remainder) * tournCombinations2(base);
    knockoutTeams = Math.min(activeTeams, numGroups * advancePerGroup);
  } else {
    knockoutTeams = activeTeams;
  }

  const bracketSize = knockoutTeams >= 2 ? tournNextPowerOfTwo(knockoutTeams) : 0;
  const byes = bracketSize ? bracketSize - knockoutTeams : 0;
  const roundReal = [];
  if (bracketSize >= 2) {
    let pairs = bracketSize / 2;
    roundReal.push(Math.max(0, pairs - byes));
    pairs = Math.floor(pairs / 2);
    while (pairs >= 1) {
      roundReal.push(pairs);
      pairs = Math.floor(pairs / 2);
    }
  }
  const knockoutMatches = roundReal.reduce((a, b) => a + b, 0);
  const totalMatches = groupStageMatches + knockoutMatches;

  const groupStageSlots = courts > 0 ? Math.ceil(groupStageMatches / courts) : 0;
  const knockoutSlots = courts > 0 ? roundReal.reduce((sum, r) => sum + Math.ceil(r / courts), 0) : 0;
  const totalSlots = groupStageSlots + knockoutSlots;

  const hasBreak = groupStageMatches > 0 && knockoutMatches > 0;
  const totalMinutes = matchMinutes > 0 ? totalSlots * matchMinutes + (hasBreak ? Number(cfg.breakMinutes) || 0 : 0) : 0;

  const availableHours = Number(cfg.availableHours) > 0 ? Number(cfg.availableHours) : null;
  const availableMinutes = availableHours != null ? availableHours * 60 : null;
  const fitsAvailableHours = availableMinutes != null && totalMinutes > 0 ? totalMinutes <= availableMinutes : null;
  const oneDayCapacity = availableMinutes != null && matchMinutes > 0 && courts > 0 ? Math.floor(availableMinutes / matchMinutes) * courts : null;

  let expectedFinish = null;
  if (cfg.startTime && totalMinutes > 0) {
    const startMins = tournTimeStrToMinutes(cfg.startTime);
    if (startMins != null) expectedFinish = tournMinutesToTimeStr(startMins + totalMinutes);
  }

  let ready = false;
  if (cfg.format === "groups") {
    ready = numGroups >= 2 && advancePerGroup >= 1 && activeTeams >= numGroups * 2 && knockoutTeams >= 2;
  } else {
    ready = activeTeams >= 2;
  }

  return {
    activeTeams,
    avgTeamsPerGroup,
    groupStageMatches,
    knockoutTeams,
    knockoutMatches,
    totalMatches,
    groupStageSlots,
    knockoutSlots,
    totalMinutes,
    fitsAvailableHours,
    oneDayCapacity,
    expectedFinish,
    ready,
  };
}

// Renders the computed numbers as a friendly little stat-tile dashboard,
// reusing the app's existing .stat-row/.stat tiles so it feels like the rest
// of the admin panel rather than a bolted-on spreadsheet.
function setupPreviewHtml(p, cfg) {
  const durationLabel = tournMinutesLabel(p.totalMinutes);
  const readyBadge = p.ready
    ? `<span class="tourn-setup-ready ok">${t("statConfigReady").replace("{count}", p.knockoutTeams)}</span>`
    : `<span class="tourn-setup-ready pending">${cfg.mode === "team" && p.activeTeams === 0 ? t("statConfigNeedTeams") : t("statConfigNeedMore")}</span>`;
  const fitsLine =
    p.fitsAvailableHours === null
      ? ""
      : `<div class="stat"><div class="n">${p.fitsAvailableHours ? "✓" : "✗"}</div><div class="l">${t("statFitsHours")}</div></div>`;
  const activeLabel = cfg.mode === "team" ? t("statActiveTeams") : t("statActivePlayers");
  const slotsLine = p.groupStageSlots || p.knockoutSlots
    ? `
      <div class="stat-row" style="margin-top:10px;">
        <div class="stat"><div class="n">${p.groupStageSlots}</div><div class="l">${t("statGroupSlots")}</div></div>
        <div class="stat"><div class="n">${p.knockoutSlots}</div><div class="l">${t("statKnockoutSlots")}</div></div>
        ${p.oneDayCapacity != null ? `<div class="stat"><div class="n">${p.oneDayCapacity}</div><div class="l">${t("statOneDayCapacity")}</div></div>` : ""}
      </div>`
    : "";
  return `
    <div class="tourn-setup-dashboard">
      <h5>${t("setupDashboardTitle")} ${readyBadge}</h5>
      <p class="hint-note">${t("setupDashboardHint")}</p>
      <div class="stat-row">
        <div class="stat"><div class="n">${p.activeTeams}</div><div class="l">${activeLabel}</div></div>
        <div class="stat"><div class="n">${p.groupStageMatches}</div><div class="l">${t("statGroupMatches")}</div></div>
        <div class="stat"><div class="n">${p.knockoutMatches}</div><div class="l">${t("statKnockoutMatches")}</div></div>
        <div class="stat"><div class="n">${p.totalMatches}</div><div class="l">${t("statTotalMatches")}</div></div>
      </div>
      <div class="stat-row" style="margin-top:10px;">
        <div class="stat"><div class="n">${durationLabel}</div><div class="l">${t("statEstDuration")}</div></div>
        <div class="stat"><div class="n">${p.expectedFinish ? formatTimeOfDay(p.expectedFinish) : "—"}</div><div class="l">${t("statExpectedFinish")}</div></div>
        ${fitsLine}
      </div>
      ${slotsLine}
    </div>
  `;
}

function tournSetupCfgFromCreateForm() {
  const mode = document.getElementById("tourn-mode") ? document.getElementById("tourn-mode").value : "individual";
  const format = document.getElementById("tourn-format") ? document.getElementById("tourn-format").value : "knockout";
  const activeTeams = mode === "team" ? 0 : TOURNAMENT_REGISTRATIONS.length;
  return {
    mode,
    format,
    activeTeams,
    numGroups: byIdVal("tourn-num-groups"),
    advancePerGroup: byIdVal("tourn-advance-per-group"),
    courts: byIdVal("tourn-courts"),
    matchMinutes: byIdVal("tourn-match-minutes"),
    startTime: byIdVal("tourn-start-time"),
    breakMinutes: byIdVal("tourn-break-minutes"),
    availableHours: byIdVal("tourn-available-hours"),
  };
}
function tournSetupCfgFromEditor() {
  const mode = TOURNAMENT_DATA.mode;
  const activeTeams = TOURNAMENT_DATA.entrants ? TOURNAMENT_DATA.entrants.length : 0;
  return {
    mode,
    format: TOURNAMENT_DATA.format,
    activeTeams,
    numGroups: TOURNAMENT_DATA.numGroups,
    advancePerGroup: TOURNAMENT_DATA.advancePerGroup,
    courts: byIdVal("tourn-edit-courts"),
    matchMinutes: byIdVal("tourn-edit-match-minutes"),
    startTime: byIdVal("tourn-edit-start-time"),
    breakMinutes: byIdVal("tourn-edit-break-minutes"),
    availableHours: byIdVal("tourn-edit-available-hours"),
  };
}
function byIdVal(id) {
  const el = document.getElementById(id);
  return el ? el.value : "";
}
function refreshCreateSetupPreview() {
  const el = document.getElementById("tourn-setup-preview");
  if (!el) return;
  const cfg = tournSetupCfgFromCreateForm();
  el.innerHTML = setupPreviewHtml(computeTournamentSetupPreview(cfg), cfg);
}
function refreshEditSetupPreview() {
  const el = document.getElementById("tourn-setup-preview-edit");
  if (!el || !TOURNAMENT_DATA) return;
  const cfg = tournSetupCfgFromEditor();
  el.innerHTML = setupPreviewHtml(computeTournamentSetupPreview(cfg), cfg);
}

function renderTournamentCreateForm() {
  const count = TOURNAMENT_REGISTRATIONS.length;
  return `
    <p class="hint-note">${t("tournamentEntrantCountHint").replace("{count}", count)}</p>
    <div class="grid-2">
      <div>
        <label>${t("fieldTournamentMode")}</label>
        <select id="tourn-mode">
          <option value="individual">${t("tournamentModeIndividual")}</option>
          <option value="team">${t("tournamentModeTeam")}</option>
        </select>
      </div>
      <div>
        <label>${t("fieldTournamentFormat")}</label>
        <select id="tourn-format">
          <option value="knockout">${t("tournamentFormatKnockout")}</option>
          <option value="groups">${t("tournamentFormatGroups")}</option>
        </select>
      </div>
    </div>
    <div class="grid-2" id="tourn-group-fields" style="display:none;">
      <div><label>${t("fieldNumGroups")}</label><input id="tourn-num-groups" type="number" min="2" value="2" /></div>
      <div><label>${t("fieldAdvancePerGroup")}</label><input id="tourn-advance-per-group" type="number" min="1" value="2" /></div>
    </div>
    <div class="grid-2">
      <div><label>${t("fieldWinPoints")}</label><input id="tourn-win-points" type="number" min="0" value="3" /></div>
      <div><label>${t("fieldDrawPoints")}</label><input id="tourn-draw-points" type="number" min="0" value="1" /></div>
      <div><label>${t("fieldLossPoints")}</label><input id="tourn-loss-points" type="number" min="0" value="0" /></div>
    </div>
    <p class="hint-note" style="margin-top:14px;">${t("scheduleSetupHint")}</p>
    <div class="grid-2">
      <div><label>${t("fieldCourts")}</label><input id="tourn-courts" type="number" min="1" placeholder="${escapeAttr(t("optionalPlaceholder"))}" /></div>
      <div><label>${t("fieldMatchMinutes")}</label><input id="tourn-match-minutes" type="number" min="1" placeholder="${escapeAttr(t("optionalPlaceholder"))}" /></div>
      <div><label>${t("fieldStartTime")}</label><input id="tourn-start-time" type="time" /></div>
      <div><label>${t("fieldBreakMinutes")}</label><input id="tourn-break-minutes" type="number" min="0" placeholder="0" /></div>
      <div><label>${t("fieldAvailableHours")}</label><input id="tourn-available-hours" type="number" min="0" step="0.5" placeholder="${escapeAttr(t("optionalPlaceholder"))}" /></div>
    </div>
    <div id="tourn-setup-preview"></div>
    <button class="primary" style="margin-top:10px;" data-tourn-action="create-tournament">${t("btnCreateTournament")}</button>
  `;
}
function toggleTournamentGroupFields() {
  const format = document.getElementById("tourn-format").value;
  document.getElementById("tourn-group-fields").style.display = format === "groups" ? "grid" : "none";
}
async function createTournament() {
  const msg = document.getElementById("tourn-msg");
  const mode = document.getElementById("tourn-mode").value;
  const format = document.getElementById("tourn-format").value;
  const body = { mode, format };
  if (format === "groups") {
    body.numGroups = Number(document.getElementById("tourn-num-groups").value);
    body.advancePerGroup = Number(document.getElementById("tourn-advance-per-group").value);
  }
  const courts = document.getElementById("tourn-courts").value.trim();
  const matchMinutes = document.getElementById("tourn-match-minutes").value.trim();
  const startTime = document.getElementById("tourn-start-time").value.trim();
  if (courts || matchMinutes || startTime) {
    body.courts = Number(courts);
    body.matchMinutes = Number(matchMinutes);
    body.startTime = startTime;
    const breakMinutes = document.getElementById("tourn-break-minutes").value.trim();
    if (breakMinutes) body.breakMinutes = Number(breakMinutes);
  }
  const winPoints = document.getElementById("tourn-win-points").value.trim();
  const drawPoints = document.getElementById("tourn-draw-points").value.trim();
  const lossPoints = document.getElementById("tourn-loss-points").value.trim();
  const availableHours = document.getElementById("tourn-available-hours").value.trim();
  if (winPoints) body.winPoints = Number(winPoints);
  if (drawPoints) body.drawPoints = Number(drawPoints);
  if (lossPoints) body.lossPoints = Number(lossPoints);
  if (availableHours) body.availableHours = Number(availableHours);
  try {
    const data = await api("/api/admin/tournaments/" + TOURNAMENT_EVENT_ID, { method: "POST", body: JSON.stringify(body) });
    TOURNAMENT_DATA = data.tournament;
    showMsg(msg, t("tournamentCreated"), true);
    renderTournamentBody();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}

async function deleteTournament() {
  if (!confirm(t("confirmDeleteTournament"))) return;
  const msg = document.getElementById("tourn-msg");
  try {
    await api("/api/admin/tournaments/" + TOURNAMENT_EVENT_ID, { method: "DELETE" });
    TOURNAMENT_DATA = null;
    showMsg(msg, t("tournamentDeleted"), true);
    renderTournamentBody();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}

// Team mode only: a plain text-input-per-registrant sheet rather than
// drag-and-drop - deliberately simple. Registrants sharing the exact same
// (trimmed, case-insensitive) team name become one team; anyone left blank
// sits out the tournament.
function renderTournamentTeamSetup() {
  const rows = TOURNAMENT_REGISTRATIONS.map(
    (r) => `<tr>
      <td>${escapeAttr(r.label)}</td>
      <td><input type="text" class="tourn-team-name" data-reg-id="${r.id}" placeholder="${escapeAttr(t("teamNamePlaceholder"))}" /></td>
    </tr>`
  ).join("");
  return `
    <p class="hint-note">${t("teamSetupHint")}</p>
    <table><thead><tr><th>${t("colName")}</th><th>${t("colTeam")}</th></tr></thead><tbody>${rows}</tbody></table>
    <button class="primary" style="margin-top:10px;" data-tourn-action="save-teams">${t("btnSaveTeams")}</button>
  `;
}
async function saveTournamentTeams() {
  const msg = document.getElementById("tourn-msg");
  const groups = {};
  Array.from(document.querySelectorAll(".tourn-team-name")).forEach((inp) => {
    const name = inp.value.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (!groups[key]) groups[key] = { name, memberIds: [] };
    groups[key].memberIds.push(Number(inp.dataset.regId));
  });
  try {
    const data = await api("/api/admin/tournaments/" + TOURNAMENT_EVENT_ID + "/teams", {
      method: "PUT",
      body: JSON.stringify({ teams: Object.values(groups) }),
    });
    TOURNAMENT_DATA = data.tournament;
    showMsg(msg, t("teamsSaved"), true);
    renderTournamentBody();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}

// Seeding: the order here becomes group placement or bracket seeding once
// generated. Randomize gives a fair draw in one click; the arrows let the
// admin place specific entrants by hand afterward (e.g. keep club rivals
// apart). Every reorder saves immediately so there's nothing to lose track of.
function renderTournamentSeeding() {
  const entrants = TOURNAMENT_DATA.entrants;
  const order = TOURNAMENT_DATA.seedOrder;
  const rows = order
    .map((id, i) => {
      const e = entrants.find((x) => x.id === id);
      return `<div class="tourn-seed-row">
        <span class="tourn-seed-num">${i + 1}</span>
        <span class="tourn-seed-label">${escapeAttr(e ? e.label : id)}</span>
        <span class="tourn-seed-actions">
          <button class="secondary small" ${i === 0 ? "disabled" : ""} data-tourn-action="move-entrant" data-entrant-id="${escapeAttr(id)}" data-dir="-1">↑</button>
          <button class="secondary small" ${i === order.length - 1 ? "disabled" : ""} data-tourn-action="move-entrant" data-entrant-id="${escapeAttr(id)}" data-dir="1">↓</button>
        </span>
      </div>`;
    })
    .join("");
  const genLabel = TOURNAMENT_DATA.format === "groups" ? t("btnGenerateGroups") : t("btnGenerateBracket");
  return `
    <p class="hint-note">${t("seedingHint")}</p>
    <div class="tourn-seed-list">${rows}</div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="secondary" data-tourn-action="randomize-seed">${t("btnRandomize")}</button>
      <button class="primary" data-tourn-action="generate-tournament">${escapeAttr(genLabel)}</button>
    </div>
  `;
}
async function moveTournamentEntrant(entrantId, dir) {
  const order = TOURNAMENT_DATA.seedOrder.slice();
  const idx = order.indexOf(entrantId);
  const newIdx = idx + dir;
  if (idx === -1 || newIdx < 0 || newIdx >= order.length) return;
  [order[idx], order[newIdx]] = [order[newIdx], order[idx]];
  await saveTournamentSeedOrder(order);
}
async function randomizeTournamentSeed() {
  const order = TOURNAMENT_DATA.seedOrder.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  await saveTournamentSeedOrder(order);
}
async function saveTournamentSeedOrder(order) {
  const msg = document.getElementById("tourn-msg");
  try {
    const data = await api("/api/admin/tournaments/" + TOURNAMENT_EVENT_ID + "/seed-order", {
      method: "PUT",
      body: JSON.stringify({ seedOrder: order }),
    });
    TOURNAMENT_DATA = data.tournament;
    renderTournamentBody();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}
async function generateTournament() {
  const msg = document.getElementById("tourn-msg");
  try {
    const data = await api("/api/admin/tournaments/" + TOURNAMENT_EVENT_ID + "/generate", { method: "POST" });
    TOURNAMENT_DATA = data.tournament;
    showMsg(msg, t("tournamentGenerated"), true);
    renderTournamentBody();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}

// Small "Court 1 · 19:30" badge shown next to a match once the tournament
// has courts/matchMinutes/startTime set; matches created before scheduling
// existed (or a tournament with no schedule at all) just show nothing here.
function matchTimeBadge(m) {
  if (!m.court || !m.time) return "";
  return `<span class="tourn-match-time">${escapeAttr(t("courtLabel"))} ${m.court} &middot; ${escapeAttr(m.time)}</span>`;
}

// Flattens every group-stage and knockout match into one list, each tagged
// with a human stage label ("Group A", "Semifinal", ...) - shared by the
// per-attendee "my matches" lists below (admin and public alike) so a
// player's own schedule/results can be pulled out with a simple filter by
// entrant id, without re-deriving stage labels in three different places.
function collectAllTournamentMatches(tn) {
  const list = [];
  (tn.groups || []).forEach((g, gi) => {
    const stage = `${t("groupLabel")} ${String.fromCharCode(65 + gi)}`;
    g.matches.forEach((m) => list.push({ ...m, stage, kind: "group" }));
  });
  if (tn.knockout) {
    const rounds = tn.knockout.rounds;
    rounds.forEach((round, ri) => {
      const isFinal = ri === rounds.length - 1;
      const isSemi = ri === rounds.length - 2;
      const stage = isFinal ? t("roundFinal") : isSemi ? t("roundSemifinal") : `${t("roundLabel")} ${ri + 1}`;
      round.forEach((m) => {
        if (!m.bye) list.push({ ...m, stage, kind: "knockout" });
      });
    });
  }
  return list;
}
// One line in a player's own match list, from that player's point of view
// (opponent, not "a"/"b"; "Won"/"Lost" rather than a neutral winner name).
function attendeeMatchLineHtml(m, entrantId) {
  const isA = m.a === entrantId;
  const opponentLabel = isA ? m.bLabel || t("tbd") : m.aLabel || t("tbd");
  const timeBadge = matchTimeBadge(m);
  let resultBit = t("matchNotYetPlayed");
  let cls = "pending";
  if (m.kind === "group") {
    if (m.result) {
      const scoreLine = `${m.result.scoreA} - ${m.result.scoreB}`;
      if (m.result.winnerId === null) {
        resultBit = `${scoreLine} &middot; ${t("matchDraw")}`;
        cls = "draw";
      } else {
        const won = m.result.winnerId === entrantId;
        resultBit = `${scoreLine} &middot; ${won ? t("attResultWon") : t("attResultLost")}`;
        cls = won ? "win" : "loss";
      }
    }
  } else {
    if (m.winnerId) {
      const won = m.winnerId === entrantId;
      const scoreText = m.scoreA != null && m.scoreB != null ? `${m.scoreA} - ${m.scoreB} &middot; ` : "";
      resultBit = `${scoreText}${won ? t("attResultWon") : t("attResultLost")}`;
      cls = won ? "win" : "loss";
    } else if (!m.a || !m.b) {
      resultBit = t("waitingOnPreviousRound");
    }
  }
  return `<div class="tourn-my-match ${cls}">
    <span class="tourn-my-match-stage">${escapeAttr(m.stage)}</span>
    <span class="tourn-my-match-opp">${t("vs")} ${escapeAttr(opponentLabel)}</span>
    ${timeBadge}
    <span class="tourn-my-match-result">${resultBit}</span>
  </div>`;
}
// Collapsed by default (native <details> - no extra JS needed) so a long
// attendee list doesn't turn into a wall of match cards; the summary shows
// just a count until someone opens it.
function matchesBlockHtml(allMatches, entrantId) {
  const mine = allMatches.filter((m) => m.a === entrantId || m.b === entrantId);
  if (!mine.length) return "";
  return `<details class="tourn-my-matches">
    <summary>${t("attendeeMatchesLabel")} (${mine.length})</summary>
    ${mine.map((m) => attendeeMatchLineHtml(m, entrantId)).join("")}
  </details>`;
}
function renderTournamentGroups() {
  const groupsHtml = TOURNAMENT_DATA.groups
    .map((g, gi) => {
      const standingsRows = g.standings
        .map(
          (s, i) =>
            `<tr><td>${i + 1}</td><td>${escapeAttr(s.label)}</td><td>${s.played}</td><td>${s.wins}</td><td>${s.draws}</td><td>${s.losses}</td><td>${s.gf}</td><td>${s.ga}</td><td>${s.gd}</td><td><strong>${s.points}</strong></td></tr>`
        )
        .join("");
      const matchesHtml = g.matches
        .map((m) => {
          const timeBadge = matchTimeBadge(m);
          if (m.result) {
            const resultText =
              m.result.winnerId === null
                ? t("matchDraw")
                : `${escapeAttr(m.result.winnerId === m.a ? m.aLabel : m.bLabel)} ${t("wins")}`;
            return `<div class="tourn-match decided">
              <span>${escapeAttr(m.aLabel)} ${t("vs")} ${escapeAttr(m.bLabel)} ${timeBadge}</span>
              <span class="tourn-match-result">${m.result.scoreA} - ${m.result.scoreB} &middot; ${resultText}</span>
              <details class="tourn-edit-score">
                <summary>${t("btnEditScore")}</summary>
                <span class="tourn-match-actions tourn-score-entry">
                  <input type="number" min="0" class="tourn-score-input" data-score-side="a" value="${m.result.scoreA}" aria-label="${escapeAttr(m.aLabel)}" />
                  <span>-</span>
                  <input type="number" min="0" class="tourn-score-input" data-score-side="b" value="${m.result.scoreB}" aria-label="${escapeAttr(m.bLabel)}" />
                  <button class="secondary small" data-tourn-action="group-result" data-match-id="${m.id}">${t("btnSaveScore")}</button>
                </span>
              </details>
            </div>`;
          }
          return `<div class="tourn-match">
            <span>${escapeAttr(m.aLabel)} ${t("vs")} ${escapeAttr(m.bLabel)} ${timeBadge}</span>
            <span class="tourn-match-actions tourn-score-entry">
              <input type="number" min="0" class="tourn-score-input" data-score-side="a" placeholder="0" aria-label="${escapeAttr(m.aLabel)}" />
              <span>-</span>
              <input type="number" min="0" class="tourn-score-input" data-score-side="b" placeholder="0" aria-label="${escapeAttr(m.bLabel)}" />
              <button class="secondary small" data-tourn-action="group-result" data-match-id="${m.id}">${t("btnSaveScore")}</button>
            </span>
          </div>`;
        })
        .join("");
      return `<div class="tourn-group">
        <h4>${escapeAttr(t("groupLabel"))} ${String.fromCharCode(65 + gi)}</h4>
        <div class="tourn-table-scroll"><table><thead><tr><th>#</th><th>${t("colName")}</th><th>${t("colPlayed")}</th><th>${t("colWins")}</th><th>${t("colDraws")}</th><th>${t("colLosses")}</th><th>${t("colGF")}</th><th>${t("colGA")}</th><th>${t("colGD")}</th><th>${t("colPoints")}</th></tr></thead><tbody>${standingsRows}</tbody></table></div>
        <div class="tourn-matches">${matchesHtml}</div>
      </div>`;
    })
    .join("");
  const undecided = TOURNAMENT_DATA.groups.reduce((sum, g) => sum + g.matches.filter((m) => !m.result).length, 0);
  return `
    <div class="tourn-groups-grid">${groupsHtml}</div>
    <div style="margin-top:14px;">
      ${undecided > 0 ? `<p class="hint-note">${t("groupsRemainingHint").replace("{count}", undecided)}</p>` : ""}
      <button class="primary" ${undecided > 0 ? "disabled" : ""} data-tourn-action="generate-knockout">${t("btnGenerateKnockout")}</button>
    </div>
  `;
}
async function recordTournamentGroupResult(btn) {
  const msg = document.getElementById("tourn-msg");
  const wrap = btn.closest(".tourn-match-actions");
  const scoreA = wrap.querySelector('[data-score-side="a"]').value;
  const scoreB = wrap.querySelector('[data-score-side="b"]').value;
  if (scoreA === "" || scoreB === "") return showMsg(msg, t("bothScoresRequired"), false);
  try {
    const data = await api("/api/admin/tournaments/" + TOURNAMENT_EVENT_ID + "/group-result", {
      method: "PUT",
      body: JSON.stringify({ matchId: Number(btn.dataset.matchId), scoreA: Number(scoreA), scoreB: Number(scoreB) }),
    });
    TOURNAMENT_DATA = data.tournament;
    renderTournamentBody();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}
async function generateTournamentKnockout() {
  const msg = document.getElementById("tourn-msg");
  try {
    const data = await api("/api/admin/tournaments/" + TOURNAMENT_EVENT_ID + "/generate-knockout", { method: "POST" });
    TOURNAMENT_DATA = data.tournament;
    showMsg(msg, t("knockoutGenerated"), true);
    renderTournamentBody();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}

function knockoutResultText(m) {
  const winnerLabel = m.winnerId === m.a ? m.aLabel : m.bLabel;
  const scoreText = m.scoreA != null && m.scoreB != null ? `${m.scoreA} - ${m.scoreB}` : "";
  const bits = [scoreText, m.note].filter(Boolean).join(" &middot; ");
  return `${escapeAttr(winnerLabel)} ${t("wins")}${bits ? " (" + bits + ")" : ""}`;
}
function renderTournamentBracket() {
  const rounds = TOURNAMENT_DATA.knockout.rounds;
  const roundsHtml = rounds
    .map((round, ri) => {
      const isFinal = ri === rounds.length - 1;
      const isSemi = ri === rounds.length - 2;
      const roundLabel = isFinal ? t("roundFinal") : isSemi ? t("roundSemifinal") : `${t("roundLabel")} ${ri + 1}`;
      const matchesHtml = round
        .map((m) => {
          const aLabel = m.aLabel || t("tbd");
          const bLabel = m.bLabel || t("tbd");
          const timeBadge = matchTimeBadge(m);
          let footer;
          if (m.bye) {
            footer = `<div class="tourn-bracket-result">${t("byeLabel")}</div>`;
          } else if (m.winnerId) {
            footer = `<div class="tourn-bracket-result">${knockoutResultText(m)}</div>
              <details class="tourn-edit-score">
                <summary>${t("btnEditScore")}</summary>
                <div class="tourn-bracket-actions">
                  <div class="tourn-score-entry">
                    <input type="number" min="0" class="tourn-score-input" data-ko-side="a" value="${m.scoreA != null ? m.scoreA : ""}" aria-label="${escapeAttr(m.aLabel)}" />
                    <span>-</span>
                    <input type="number" min="0" class="tourn-score-input" data-ko-side="b" value="${m.scoreB != null ? m.scoreB : ""}" aria-label="${escapeAttr(m.bLabel)}" />
                  </div>
                  <input type="text" class="tourn-ko-note" placeholder="${escapeAttr(t("koNotePlaceholder"))}" maxlength="60" value="${escapeAttr(m.note || "")}" />
                  <div class="tourn-bracket-winner-btns">
                    <button data-tourn-action="knockout-result" data-round-index="${ri}" data-match-id="${m.id}" data-winner-id="${escapeAttr(m.a)}">${escapeAttr(m.aLabel)}</button>
                    <button data-tourn-action="knockout-result" data-round-index="${ri}" data-match-id="${m.id}" data-winner-id="${escapeAttr(m.b)}">${escapeAttr(m.bLabel)}</button>
                  </div>
                </div>
              </details>`;
          } else if (m.a && m.b) {
            footer = `<div class="tourn-bracket-actions">
              <div class="tourn-score-entry">
                <input type="number" min="0" class="tourn-score-input" data-ko-side="a" placeholder="0" aria-label="${escapeAttr(m.aLabel)}" />
                <span>-</span>
                <input type="number" min="0" class="tourn-score-input" data-ko-side="b" placeholder="0" aria-label="${escapeAttr(m.bLabel)}" />
              </div>
              <input type="text" class="tourn-ko-note" placeholder="${escapeAttr(t("koNotePlaceholder"))}" maxlength="60" />
              <div class="tourn-bracket-winner-btns">
                <button data-tourn-action="knockout-result" data-round-index="${ri}" data-match-id="${m.id}" data-winner-id="${escapeAttr(m.a)}">${escapeAttr(m.aLabel)}</button>
                <button data-tourn-action="knockout-result" data-round-index="${ri}" data-match-id="${m.id}" data-winner-id="${escapeAttr(m.b)}">${escapeAttr(m.bLabel)}</button>
              </div>
            </div>`;
          } else {
            footer = `<div class="tourn-bracket-pending">${t("waitingOnPreviousRound")}</div>`;
          }
          return `<div class="tourn-bracket-match">
            ${timeBadge ? `<div class="tourn-bracket-time">${timeBadge}</div>` : ""}
            <div class="tourn-bracket-slot ${m.winnerId && m.winnerId === m.a ? "winner" : ""}">${escapeAttr(aLabel)}</div>
            <div class="tourn-bracket-slot ${m.winnerId && m.winnerId === m.b ? "winner" : ""}">${escapeAttr(bLabel)}</div>
            ${footer}
          </div>`;
        })
        .join("");
      return `<div class="tourn-bracket-round"><h4>${escapeAttr(roundLabel)}</h4>${matchesHtml}</div>`;
    })
    .join("");
  return `<div class="tourn-bracket">${roundsHtml}</div>`;
}
async function recordTournamentKnockoutResult(btn) {
  const msg = document.getElementById("tourn-msg");
  const wrap = btn.closest(".tourn-bracket-actions");
  const scoreA = wrap.querySelector('[data-ko-side="a"]').value;
  const scoreB = wrap.querySelector('[data-ko-side="b"]').value;
  const note = wrap.querySelector(".tourn-ko-note").value;
  try {
    const data = await api("/api/admin/tournaments/" + TOURNAMENT_EVENT_ID + "/knockout-result", {
      method: "PUT",
      body: JSON.stringify({
        roundIndex: Number(btn.dataset.roundIndex),
        matchId: Number(btn.dataset.matchId),
        winnerId: btn.dataset.winnerId,
        scoreA: scoreA === "" ? null : Number(scoreA),
        scoreB: scoreB === "" ? null : Number(scoreB),
        note,
      }),
    });
    TOURNAMENT_DATA = data.tournament;
    renderTournamentBody();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}

function renderTournamentStandings() {
  const rows = TOURNAMENT_DATA.standings.map((s) => `<tr><td>${s.rank}</td><td>${escapeAttr(s.label)}</td></tr>`).join("");
  const awardedNote = TOURNAMENT_DATA.pointsAwardedAt
    ? `<p class="hint-note">${t("pointsAwardedOn")} ${escapeAttr(new Date(TOURNAMENT_DATA.pointsAwardedAt).toLocaleString())}</p>`
    : "";
  return `
    <h4 style="margin-top:18px;">${t("finalStandingsTitle")}</h4>
    <table><thead><tr><th>${t("colPosition")}</th><th>${t("colName")}</th></tr></thead><tbody>${rows}</tbody></table>
    ${awardedNote}
    <button class="primary" style="margin-top:10px;" data-tourn-action="award-points">${TOURNAMENT_DATA.pointsAwardedAt ? t("btnReAwardPoints") : t("btnAwardPoints")}</button>
  `;
}
async function awardTournamentPoints() {
  const msg = document.getElementById("tourn-msg");
  try {
    const data = await api("/api/admin/tournaments/" + TOURNAMENT_EVENT_ID + "/award-points", { method: "POST" });
    TOURNAMENT_DATA = data.tournament;
    showMsg(msg, t("pointsAwarded").replace("{count}", data.updated), true);
    renderTournamentBody();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}

// =====================================================================
// PUBLIC TOURNAMENTS PAGE - read-only bracket/group/standings viewer, no
// login required. Reuses the same CSS classes as the admin tournament card
// (.tourn-bracket, .tourn-groups-grid, etc. - see styles.css) but renders
// no action controls, since members can only look, not record results.
// =====================================================================
let PUBLIC_TOURNAMENTS_LIST = [];
// Which event ids currently have a tournament - kept in sync via
// refreshTournamentEventIds() (called from loadEvents(), so it's already
// fresh by the time event cards/modals render) so the Events/Annual views
// can show a "View Tournament" link without a separate round trip per card.
let TOURNAMENT_EVENT_IDS = new Set();
async function refreshTournamentEventIds() {
  PUBLIC_TOURNAMENTS_LIST = await api("/api/tournaments").catch(() => []);
  TOURNAMENT_EVENT_IDS = new Set(PUBLIC_TOURNAMENTS_LIST.map((tn) => tn.eventId));
}

async function loadPublicTournamentsList() {
  await refreshTournamentEventIds();
  document.getElementById("tourn-public-detail").classList.add("hidden");
  document.getElementById("tourn-public-list").classList.remove("hidden");
  renderPublicTournamentsList();
}
function renderPublicTournamentsList() {
  const grid = document.getElementById("tourn-public-list");
  const empty = document.getElementById("tourn-public-empty");
  if (!grid) return;
  empty.classList.toggle("hidden", PUBLIC_TOURNAMENTS_LIST.length > 0);
  grid.innerHTML = PUBLIC_TOURNAMENTS_LIST.map((tn) => {
    const modeLabel = tn.mode === "team" ? t("tournamentModeTeam") : t("tournamentModeIndividual");
    const formatLabel = tn.format === "groups" ? t("tournamentFormatGroups") : t("tournamentFormatKnockout");
    const statusLabel = tn.status === "completed" ? t("tournStatusCompleted") : t("tournStatusInProgress");
    return `
    <div class="event-card" data-event-id="${tn.eventId}">
      <div class="body">
        <h3>${eventNameHtml(tn)}</h3>
        <div class="meta">${escapeAttr(tn.date || "")}${tn.sport ? " &middot; " + escapeAttr(tn.sport) : ""}</div>
        <div class="tourn-summary" style="margin-top:8px;">
          <span class="tourn-summary-badge">${escapeAttr(modeLabel)}</span>
          <span class="tourn-summary-badge">${escapeAttr(formatLabel)}</span>
          <span class="tourn-summary-badge">${escapeAttr(statusLabel)}</span>
        </div>
        <div class="actions" style="margin-top:10px;">
          <button class="secondary" data-action="view-tournament">${t("btnViewTournament")}</button>
        </div>
      </div>
    </div>`;
  }).join("");
  grid.querySelectorAll(".event-card").forEach((card) => {
    const eventId = Number(card.dataset.eventId);
    card.querySelectorAll('[data-action="view-tournament"], h3').forEach((el) => {
      el.addEventListener("click", () => openPublicTournament(eventId));
    });
  });
}
document.getElementById("tourn-public-back").addEventListener("click", () => {
  document.getElementById("tourn-public-detail").classList.add("hidden");
  document.getElementById("tourn-public-list").classList.remove("hidden");
});
async function openPublicTournament(eventId) {
  const wrap = document.getElementById("tourn-public-detail-body");
  document.getElementById("tourn-public-list").classList.add("hidden");
  document.getElementById("tourn-public-detail").classList.remove("hidden");
  wrap.innerHTML = `<p style="color:var(--muted);">${escapeAttr(t("loading"))}</p>`;
  try {
    const data = await api("/api/tournaments/" + eventId);
    wrap.innerHTML = renderPublicTournamentBody(data.tournament, eventId);
    const backBtn = document.getElementById("tourn-public-view-event-btn");
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        const ev = EVENTS_DATA.find((e) => e.id === eventId);
        if (ev) openEventModal(ev, isPastEvent(ev));
      });
    }
  } catch (e) {
    wrap.innerHTML = `<p class="msg err show">${escapeAttr(e.message)}</p>`;
  }
}
function renderPublicTournamentBody(tn, eventId) {
  if (!tn) return `<p style="color:var(--muted);">${escapeAttr(t("tournPublicEmpty"))}</p>`;
  const meta = PUBLIC_TOURNAMENTS_LIST.find((x) => x.eventId === eventId);
  const ev = EVENTS_DATA.find((e) => e.id === eventId);
  const modeLabel = tn.mode === "team" ? t("tournamentModeTeam") : t("tournamentModeIndividual");
  const formatLabel = tn.format === "groups" ? t("tournamentFormatGroups") : t("tournamentFormatKnockout");
  let inner = "";
  if (tn.status === "team-setup" || tn.status === "setup" || tn.status === "seeding") {
    inner = `<p class="hint-note">${t("tournPublicNotStarted")}</p>`;
  } else if (tn.status === "groups") {
    inner = renderPublicGroups(tn.groups);
  } else if (tn.status === "knockout") {
    inner = renderPublicBracket(tn.knockout);
  } else if (tn.status === "completed") {
    inner = (tn.format === "groups" ? renderPublicGroups(tn.groups) : "") + renderPublicBracket(tn.knockout) + renderPublicStandings(tn.standings);
  }
  const matchesLink = tn.schedule
    ? `<a class="secondary small" style="text-decoration:none;display:inline-block;" href="/matches.html?event=${eventId}&lang=${currentLang}" target="_blank" rel="noopener">${t("btnViewLiveMatches")}</a>`
    : "";
  return `
    ${meta ? `<h3 style="margin-top:0;">${eventNameHtml(meta)}</h3>` : ""}
    <div class="tourn-summary">
      <span class="tourn-summary-badge">${escapeAttr(modeLabel)}</span>
      <span class="tourn-summary-badge">${escapeAttr(formatLabel)}</span>
      ${matchesLink}
      ${ev ? `<button class="secondary small" id="tourn-public-view-event-btn" style="margin-inline-start:auto;">${t("btnViewEventDetails")}</button>` : ""}
    </div>
    ${inner}
    ${renderPublicAttendance(tn)}
  `;
}
// Read-only mirror of the admin attendance section - each attendee's name,
// check-in status, and (via the same matchesBlockHtml helper) their own
// schedule and results, with no action controls since members can only
// look, not record anything.
function attStatusLabel(status) {
  return status === "present" ? t("attStatusPresent") : status === "absent" ? t("attStatusAbsent") : t("attStatusNotYet");
}
function renderPublicAttendance(tn) {
  const list = tn.attendance || [];
  if (!list.length) return "";
  const allMatches = collectAllTournamentMatches(tn);
  const rowHtml = (a) => `
    <div class="tourn-attendance-row tourn-att-${a.status}">
      <span class="tourn-attendance-name">${escapeAttr(a.name)}</span>
      <span class="tourn-att-status-badge">${escapeAttr(attStatusLabel(a.status))}</span>
    </div>
    ${matchesBlockHtml(allMatches, a.entrantId)}`;
  let body;
  if (tn.mode === "team") {
    const byEntrant = {};
    list.forEach((a) => {
      if (!byEntrant[a.entrantId]) byEntrant[a.entrantId] = { label: a.entrantLabel, entrantId: a.entrantId, rows: [] };
      byEntrant[a.entrantId].rows.push(a);
    });
    body = Object.values(byEntrant)
      .map(
        (grp) => `<div class="tourn-attendance-team">
          <h5>${escapeAttr(grp.label)}</h5>
          ${grp.rows
            .map(
              (a) => `<div class="tourn-attendance-row tourn-att-${a.status}">
                <span class="tourn-attendance-name">${escapeAttr(a.name)}</span>
                <span class="tourn-att-status-badge">${escapeAttr(attStatusLabel(a.status))}</span>
              </div>`
            )
            .join("")}
          ${matchesBlockHtml(allMatches, grp.entrantId)}
        </div>`
      )
      .join("");
  } else {
    body = list.map(rowHtml).join("");
  }
  return `
    <div class="tourn-attendance" style="margin-top:24px;border-top:1px solid var(--border);padding-top:16px;">
      <h4>${t("adminTournamentAttendance")}</h4>
      ${body}
    </div>
  `;
}
function renderPublicGroups(groups) {
  const groupsHtml = (groups || [])
    .map((g, gi) => {
      const standingsRows = g.standings
        .map(
          (s, i) =>
            `<tr><td>${i + 1}</td><td>${escapeAttr(s.label)}</td><td>${s.played}</td><td>${s.wins}</td><td>${s.draws}</td><td>${s.losses}</td><td>${s.gf}</td><td>${s.ga}</td><td>${s.gd}</td><td><strong>${s.points}</strong></td></tr>`
        )
        .join("");
      const matchesHtml = g.matches
        .map((m) => {
          const timeBadge = matchTimeBadge(m);
          const resultText = !m.result
            ? t("matchNotYetPlayed")
            : m.result.winnerId === null
            ? `${m.result.scoreA} - ${m.result.scoreB} &middot; ${t("matchDraw")}`
            : `${m.result.scoreA} - ${m.result.scoreB} &middot; ${escapeAttr(m.result.winnerId === m.a ? m.aLabel : m.bLabel)} ${t("wins")}`;
          return `<div class="tourn-match${m.result ? " decided" : ""}"><span>${escapeAttr(m.aLabel)} ${t("vs")} ${escapeAttr(m.bLabel)} ${timeBadge}</span><span class="tourn-match-result">${resultText}</span></div>`;
        })
        .join("");
      return `<div class="tourn-group">
        <h4>${escapeAttr(t("groupLabel"))} ${String.fromCharCode(65 + gi)}</h4>
        <div class="tourn-table-scroll"><table><thead><tr><th>#</th><th>${t("colName")}</th><th>${t("colPlayed")}</th><th>${t("colWins")}</th><th>${t("colDraws")}</th><th>${t("colLosses")}</th><th>${t("colGF")}</th><th>${t("colGA")}</th><th>${t("colGD")}</th><th>${t("colPoints")}</th></tr></thead><tbody>${standingsRows}</tbody></table></div>
        <div class="tourn-matches">${matchesHtml}</div>
      </div>`;
    })
    .join("");
  return `<div class="tourn-groups-grid">${groupsHtml}</div>`;
}
function renderPublicBracket(knockout) {
  if (!knockout) return "";
  const rounds = knockout.rounds;
  const roundsHtml = rounds
    .map((round, ri) => {
      const isFinal = ri === rounds.length - 1;
      const isSemi = ri === rounds.length - 2;
      const roundLabel = isFinal ? t("roundFinal") : isSemi ? t("roundSemifinal") : `${t("roundLabel")} ${ri + 1}`;
      const matchesHtml = round
        .map((m) => {
          const aLabel = m.aLabel || t("tbd");
          const bLabel = m.bLabel || t("tbd");
          const timeBadge = matchTimeBadge(m);
          let footer;
          if (m.bye) {
            footer = `<div class="tourn-bracket-result">${t("byeLabel")}</div>`;
          } else if (m.winnerId) {
            footer = `<div class="tourn-bracket-result">${knockoutResultText(m)}</div>`;
          } else {
            footer = `<div class="tourn-bracket-pending">${t("waitingOnPreviousRound")}</div>`;
          }
          return `<div class="tourn-bracket-match">
            ${timeBadge ? `<div class="tourn-bracket-time">${timeBadge}</div>` : ""}
            <div class="tourn-bracket-slot ${m.winnerId && m.winnerId === m.a ? "winner" : ""}">${escapeAttr(aLabel)}</div>
            <div class="tourn-bracket-slot ${m.winnerId && m.winnerId === m.b ? "winner" : ""}">${escapeAttr(bLabel)}</div>
            ${footer}
          </div>`;
        })
        .join("");
      return `<div class="tourn-bracket-round"><h4>${escapeAttr(roundLabel)}</h4>${matchesHtml}</div>`;
    })
    .join("");
  return `<div class="tourn-bracket">${roundsHtml}</div>`;
}
function renderPublicStandings(standings) {
  if (!standings) return "";
  const rows = standings.map((s) => `<tr><td>${s.rank}</td><td>${escapeAttr(s.label)}</td></tr>`).join("");
  return `
    <h4 style="margin-top:18px;">${t("finalStandingsTitle")}</h4>
    <table><thead><tr><th>${t("colPosition")}</th><th>${t("colName")}</th></tr></thead><tbody>${rows}</tbody></table>
  `;
}

async function loadRedemptionsTable() {
  const wrap = document.getElementById("redemptions-table-wrap");
  const list = await api("/api/redemptions");
  if (!list.length) {
    wrap.innerHTML = `<p style="color:var(--muted);">--</p>`;
    return;
  }
  wrap.innerHTML = `<table>
    <thead><tr>
      <th>${t("colName")}</th><th>${t("colReward")}</th><th>${t("colPoints")}</th>
      <th>${t("colApproval")}</th><th>${t("colStatus")}</th><th>${t("colActions")}</th>
    </tr></thead>
    <tbody>
      ${list
        .map(
          (r) => `<tr>
        <td>${r.member ? r.member.name : r.membershipNumber}<br/><small style="color:var(--muted);">${t("mpCurrentBalance")}: ${fmt(r.currentBalance)}</small></td>
        <td>${r.reward ? ladderLabel(r.reward) : r.tier}</td>
        <td>${fmt(r.pointsCost)}</td>
        <td>${r.approvalLevel}</td>
        <td><span class="badge ${r.status}">${r.status}</span>${r.approvedBy ? `<br/><small style="color:var(--muted);">${r.approvedBy}</small>` : ""}</td>
        <td>
          ${r.status === "Pending" ? `<button class="secondary" data-redemption-action="Approved" data-redemption-id="${r.id}">${t("approve")}</button>
          <button class="secondary" data-redemption-action="Rejected" data-redemption-id="${r.id}">${t("reject")}</button>` : ""}
          ${r.status === "Approved" ? `<button class="secondary" data-redemption-action="Fulfilled" data-redemption-id="${r.id}">${t("fulfill")}</button>` : ""}
        </td>
      </tr>`
        )
        .join("")}
    </tbody>
  </table>`;
}
// Delegated once on the static wrapper (never replaced itself, only its
// innerHTML is) so it keeps working across every re-render of the table -
// inline onclick="" attributes are blocked by this app's CSP (script-src has
// no 'unsafe-inline'), so every dynamically-injected button must be wired
// this way instead.
document.getElementById("redemptions-table-wrap").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-redemption-action]");
  if (!btn) return;
  setRedemptionStatus(Number(btn.dataset.redemptionId), btn.dataset.redemptionAction);
});
async function setRedemptionStatus(id, status) {
  await api(`/api/redemptions/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
  loadRedemptionsTable();
  loadAdminOverview();
}

// ------------------------------------------------------------ staff accounts --
async function loadStaffAccountsTable() {
  const wrap = document.getElementById("staff-accounts-table-wrap");
  const list = await api("/api/staff/accounts");
  wrap.innerHTML = `<table>
    <thead><tr><th>${t("fieldUsername")}</th><th>${t("fieldFullName")}</th><th>${t("fieldRole")}</th><th>${t("colActions")}</th></tr></thead>
    <tbody>
      ${list
        .map(
          (s) => `<tr>
        <td>${s.username}</td>
        <td>${s.name}</td>
        <td>${s.role === "admin" ? t("roleAdmin") : t("roleStaff")}</td>
        <td>${
          CURRENT_SESSION && CURRENT_SESSION.type === "staff" && CURRENT_SESSION.staff.username === s.username
            ? ""
            : `<button class="secondary" data-remove-staff="${escapeAttr(s.username)}">${t("btnRemove")}</button>`
        }</td>
      </tr>`
        )
        .join("")}
    </tbody>
  </table>`;
}
document.getElementById("staff-accounts-table-wrap").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-remove-staff]");
  if (!btn) return;
  removeStaffAccount(btn.dataset.removeStaff);
});
async function removeStaffAccount(username) {
  if (!confirm(t("confirmRemoveStaff"))) return;
  try {
    await api(`/api/staff/accounts/${encodeURIComponent(username)}`, { method: "DELETE" });
    loadStaffAccountsTable();
    loadAdminOverview();
  } catch (e) {
    alert(e.message);
  }
}
document.getElementById("sa-submit").addEventListener("click", async () => {
  const username = document.getElementById("sa-username").value.trim();
  const name = document.getElementById("sa-name").value.trim();
  const password = document.getElementById("sa-password").value;
  const role = document.getElementById("sa-role").value;
  const msg = document.getElementById("sa-msg");
  if (!username || !name || !password) {
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  if (password.length < 6) {
    showMsg(msg, t("errPasswordShort"), false);
    return;
  }
  try {
    await api("/api/staff/accounts", {
      method: "POST",
      body: JSON.stringify({ username, password, name, role }),
    });
    showMsg(msg, t("okStaffAdded"), true);
    document.getElementById("sa-username").value = "";
    document.getElementById("sa-name").value = "";
    document.getElementById("sa-password").value = "";
    loadStaffAccountsTable();
    loadAdminOverview();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

document.getElementById("rp-submit").addEventListener("click", async () => {
  const membership = document.getElementById("rp-membership").value.trim();
  const newPassword = document.getElementById("rp-password").value;
  const msg = document.getElementById("rp-msg");
  if (!membership || !newPassword) {
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  if (newPassword.length < 6) {
    showMsg(msg, t("errPasswordShort"), false);
    return;
  }
  try {
    await api("/api/staff/members/" + encodeURIComponent(membership) + "/reset-password", {
      method: "POST",
      body: JSON.stringify({ newPassword }),
    });
    showMsg(msg, t("passwordResetDone"), true);
    document.getElementById("rp-membership").value = "";
    document.getElementById("rp-password").value = "";
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

document.getElementById("cp-submit").addEventListener("click", async () => {
  const oldPassword = document.getElementById("cp-old").value;
  const newPassword = document.getElementById("cp-new").value;
  const msg = document.getElementById("cp-msg");
  if (!oldPassword || !newPassword) {
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  if (newPassword.length < 6) {
    showMsg(msg, t("errPasswordShort"), false);
    return;
  }
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ oldPassword, newPassword }),
    });
    showMsg(msg, t("okPasswordChanged"), true);
    document.getElementById("cp-old").value = "";
    document.getElementById("cp-new").value = "";
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

// ---------------------------------------------------------- gate scanner --
let SCAN_STREAM = null;
let SCAN_RAF = null;
let SCAN_BUSY = false; // true while a check-in request is in flight or result is showing

document.getElementById("scan-start").addEventListener("click", startScanner);
document.getElementById("scan-stop").addEventListener("click", stopScanner);

async function startScanner() {
  const video = document.getElementById("scan-video");
  const resultMsg = document.getElementById("scan-result-msg");
  try {
    SCAN_STREAM = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = SCAN_STREAM;
    await video.play();
    document.getElementById("scan-start").classList.add("hidden");
    document.getElementById("scan-stop").classList.remove("hidden");
    resultMsg.className = "msg";
    scanLoop();
  } catch (e) {
    showMsg(resultMsg, t("cameraError"), false);
  }
}
function stopScanner() {
  if (SCAN_RAF) cancelAnimationFrame(SCAN_RAF);
  SCAN_RAF = null;
  if (SCAN_STREAM) SCAN_STREAM.getTracks().forEach((tr) => tr.stop());
  SCAN_STREAM = null;
  document.getElementById("scan-start").classList.remove("hidden");
  document.getElementById("scan-stop").classList.add("hidden");
}

function scanLoop() {
  const video = document.getElementById("scan-video");
  const canvas = document.getElementById("scan-canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  function tick() {
    if (!SCAN_STREAM) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA && !SCAN_BUSY) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      if (code && code.data) {
        handleScannedCode(code.data);
      }
    }
    SCAN_RAF = requestAnimationFrame(tick);
  }
  SCAN_RAF = requestAnimationFrame(tick);
}

async function handleScannedCode(data) {
  SCAN_BUSY = true;
  const resultMsg = document.getElementById("scan-result-msg");
  try {
    const res = await fetch("/api/checkin", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: data }),
    });
    const result = await res.json();
    if (res.status === 409) {
      const time = result.checkedInAt ? new Date(result.checkedInAt).toLocaleString() : "";
      const who = result.attendeeName || (result.member ? result.member.name : "");
      showMsg(resultMsg, `${who} — ${t("scanAlready")} ${time}`, false);
    } else if (!res.ok) {
      showMsg(resultMsg, result.error || t("scanInvalid"), false);
    } else {
      const time = result.checkedInAt ? new Date(result.checkedInAt).toLocaleString() : "";
      showMsg(
        resultMsg,
        `${result.attendeeName} — ${t("scanSuccess")} ${time} (+${fmt(result.pointsAwarded)} ${t("scanPointsAwarded")})`,
        true
      );
    }
  } catch (e) {
    showMsg(resultMsg, t("errGeneric"), false);
  }
  // brief pause so the same code isn't re-scanned instantly, and staff can read the result
  setTimeout(() => {
    SCAN_BUSY = false;
  }, 2500);
}

// --------------------------------------------------- manual check-in (gate) --
// Beside the QR scanner: a searchable roster of everyone registered for the
// selected event, with a one-click Check in button, for a member who
// couldn't show a working QR code (lost phone, dead battery, screenshot
// didn't save, etc). Uses /api/checkin/manual, which shares the exact same
// performCheckIn logic (and therefore the same points-award behavior) as
// the QR path server-side - see server.js.
let CHECKIN_ROSTER = [];
document.getElementById("checkin-event-select").addEventListener("change", () => loadCheckinRoster());
document.getElementById("checkin-search").addEventListener("input", renderCheckinRoster);

// preserveMsg=true skips clearing #checkin-roster-msg - used when this is
// called right after a successful manual check-in to refresh the roster
// without immediately wiping the "Checked in" confirmation that was just
// shown (a plain reload clears it before the fetch even resolves, which
// otherwise makes the confirmation flash and disappear).
async function loadCheckinRoster(preserveMsg) {
  const eventId = document.getElementById("checkin-event-select").value;
  const wrap = document.getElementById("checkin-roster-wrap");
  const msg = document.getElementById("checkin-roster-msg");
  if (!preserveMsg && msg) msg.textContent = "";
  if (!eventId) {
    CHECKIN_ROSTER = [];
    wrap.innerHTML = "";
    return;
  }
  wrap.innerHTML = `<p style="color:var(--muted);">${escapeAttr(t("loading"))}</p>`;
  try {
    CHECKIN_ROSTER = await api("/api/staff/events/" + eventId + "/roster");
    renderCheckinRoster();
  } catch (e) {
    wrap.innerHTML = `<p class="msg err show">${escapeAttr(e.message)}</p>`;
  }
}
function renderCheckinRoster() {
  const wrap = document.getElementById("checkin-roster-wrap");
  if (!wrap) return;
  if (!CHECKIN_ROSTER.length) {
    wrap.innerHTML = `<p style="color:var(--muted);">${escapeAttr(t("checkinRosterEmpty"))}</p>`;
    return;
  }
  const query = (document.getElementById("checkin-search").value || "").trim().toLowerCase();
  wrap.innerHTML = rosterTableHtml(CHECKIN_ROSTER, query);
}
// Shared by the Gate Scanner's manual check-in list and the per-event Admin
// hub's attendance section, so the two never drift - one row shape, one set
// of status/action rules. Pure function (no DOM reads/writes) so it's safe
// to call from either context; the caller wires its own data-checkin-reg
// click delegation on whatever container it rendered into.
function rosterTableHtml(roster, query) {
  const filtered = roster.filter(
    (r) => !query || r.attendeeName.toLowerCase().includes(query) || String(r.membershipNumber).toLowerCase().includes(query)
  );
  if (!filtered.length) {
    return `<p style="color:var(--muted);">${escapeAttr(t("checkinNoMatches"))}</p>`;
  }
  return `<table><tbody>${filtered
    .map((r) => {
      let status, action;
      if (r.waitlisted) {
        status = `<span class="capacity-badge waitlist">${t("waitlistLabel")}</span>`;
        action = "";
      } else if (r.checkedIn) {
        const time = r.checkInAt ? new Date(r.checkInAt).toLocaleString() : "";
        status = `<span class="badge Approved">${t("scanSuccess")}</span><br/><small style="color:var(--muted);">${escapeAttr(time)}</small>`;
        action = "";
      } else {
        status = "";
        action = `<button class="secondary small" data-checkin-reg="${r.registrationId}">${t("btnCheckIn")}</button>`;
      }
      return `<tr>
        <td>${escapeAttr(r.attendeeName)}<br/><small style="color:var(--muted);">${escapeAttr(r.membershipNumber)}</small></td>
        <td>${status}</td>
        <td>${action}</td>
      </tr>`;
    })
    .join("")}</tbody></table>`;
}
document.getElementById("checkin-roster-wrap").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-checkin-reg]");
  if (!btn) return;
  btn.disabled = true;
  const msg = document.getElementById("checkin-roster-msg");
  try {
    const result = await api("/api/checkin/manual", {
      method: "POST",
      body: JSON.stringify({ registrationId: Number(btn.dataset.checkinReg) }),
    });
    showMsg(msg, `${result.attendeeName} — ${t("scanSuccess")} (+${fmt(result.pointsAwarded)} ${t("scanPointsAwarded")})`, true);
    await loadCheckinRoster(true);
  } catch (err) {
    showMsg(msg, err.message, false);
    btn.disabled = false;
  }
});

// ------------------------------------------------------------------- init --
(async function init() {
  applyI18n();
  await loadSettings();
  await loadEvents();
  await loadLadder();
  await checkSession();
})();
