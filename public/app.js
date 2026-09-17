let CURRENT_SESSION = null; // null | { type: 'member', member } | { type: 'staff', staff }
let CURRENT_BALANCE = null; // the signed-in member's own points balance, kept in sync by loadMyBalance() - used to grey out redemption-ladder tiers the member can't afford yet
let LADDER_DATA = null;
let EVENTS_DATA = [];
let NEWS_DATA = [];
let SPOTLIGHTS_DATA = [];
let COMMITTEE_PUBLIC_DATA = []; // public Committee tab's last-loaded roster, kept for a language-switch re-render (see setLang())
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
// Landing page customization: hero banner text, About block, sponsors, photo
// gallery, and section order/visibility. Mirrors SETTINGS.landingPage once
// loaded (see loadSettings()/applySettingsToUI()) - kept as its own variable
// just so admin-panel code reads "LANDING_PAGE" instead of reaching into
// SETTINGS every time.
let LANDING_PAGE = null;
const LANDING_SECTION_DEFAULT_ORDER = ["hero", "events", "annual", "about", "news", "community", "spotlight", "gallery", "sponsors"];
// Same EN/AR-pick pattern used everywhere else for admin-authored bilingual
// content (news titles, spotlight blurbs): prefer the current language,
// fall back to whichever one was actually filled in.
function bilingual(en, ar) {
  return currentLang === "ar" ? ar || en || "" : en || ar || "";
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
// Reads the "csrfToken" cookie the server sets on every response (see the
// CSRF middleware in server.js) - a plain, non-httpOnly cookie meant to be
// read by this site's own JS and echoed back as a header on every mutating
// request, proving the request actually came from a page that can read
// this origin's cookies (a cross-site forger can't).
function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrfToken=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}
async function api(path, opts = {}) {
  // FormData bodies (photo uploads) must NOT get a manual Content-Type - the
  // browser needs to set its own multipart boundary, or the server can't
  // parse the upload at all.
  const isFormData = typeof FormData !== "undefined" && opts.body instanceof FormData;
  const headers = isFormData
    ? Object.assign({ "X-CSRF-Token": getCsrfToken() }, opts.headers || {})
    : Object.assign({ "Content-Type": "application/json", "X-CSRF-Token": getCsrfToken() }, opts.headers || {});
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
// Visually highlights whichever of the given required-field ids are
// currently empty (red border), in addition to the existing text error
// message shown via showMsg(msg, t("errFillFields"), false) - so a visitor
// sees exactly which field(s) need attention, not just a general notice.
// Focuses the first empty one. Each highlighted field clears itself the
// moment it's edited (see the delegated listener below).
function highlightMissingFields(fieldIds) {
  let firstEmpty = null;
  (fieldIds || []).forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const isEmpty =
      el.type === "checkbox" ? !el.checked : el.type === "file" ? !(el.files && el.files.length) : !String(el.value || "").trim();
    if (isEmpty) {
      el.classList.add("field-missing");
      if (!firstEmpty) firstEmpty = el;
    }
  });
  if (firstEmpty) firstEmpty.focus();
}
document.addEventListener("input", (e) => {
  if (e.target.classList && e.target.classList.contains("field-missing")) {
    e.target.classList.remove("field-missing");
  }
});
document.addEventListener("change", (e) => {
  if (e.target.classList && e.target.classList.contains("field-missing")) {
    e.target.classList.remove("field-missing");
  }
});
// "-u-nu-latn" (the same Unicode locale extension used everywhere else in
// this file that formats a number/date in Arabic mode) keeps Arabic text
// for everything else (weekday/month names, RTL layout) but forces plain
// Western digits (0123...) instead of Arabic-Indic numerals (٠١٢٣...) -
// requested directly, since the Arabic-Indic "0" in particular renders as
// a tiny, easy-to-miss dot in most fonts.
function fmt(n) {
  return Number(n || 0).toLocaleString(currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-US");
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
  return d.toLocaleDateString(currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-US", { weekday: "long" });
}
// "18:30" -> "6:30 PM" (or the Arabic equivalent) for display.
function formatTimeOfDay(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return "";
  const d = new Date(2000, 0, 1, h, m);
  return d.toLocaleTimeString(currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-US", { hour: "numeric", minute: "2-digit" });
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
  // Manual check-in only ever loaded on a dropdown "change" event, so if the
  // event a visitor cares about is already the default-selected option when
  // the tab opens (e.g. it's the newest event, first in the sorted list),
  // nobody ever fires that event and the roster silently never loads - the
  // search box shows up with nothing underneath it, even though the event
  // genuinely has registrations (confirmed via the Admin hub's identical
  // Attendance section, which loads explicitly and always worked). Loading
  // it here too means opening (or returning to) the tab always reflects
  // whatever event is currently selected, default or not.
  if (view === "committee") loadCommittee();
  if (view === "scan") loadCheckinRoster();
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

// Header "Log In" button: only shown to signed-out visitors (see
// updateSessionBadge). Jumps straight to the Register tab's member-login
// card (the "Already have an account?" form) and focuses its membership
// number field, rather than making the visitor scroll past the sign-up
// form or hunt for the Register tab themselves.
document.getElementById("header-login-btn").addEventListener("click", () => {
  switchTab("register");
  const membershipField = document.getElementById("li-membership");
  if (membershipField) {
    membershipField.scrollIntoView({ behavior: "smooth", block: "center" });
    membershipField.focus();
  }
});

// Landing page "Annual Activities" section's "See all" button - jumps to
// the full, unbounded Annual Activities tab (see renderLandingAnnualPreview
// above for why the landing section itself only shows a handful).
document.getElementById("landing-annual-viewall").addEventListener("click", () => switchTab("annual"));

// Hero banner CTA buttons - "Register now" jumps to the Register tab (same
// destination as the header's own Log In button/tab), "View all events"
// just scrolls down to the events grid already on this same landing page
// rather than navigating anywhere.
document.getElementById("hero-cta-register").addEventListener("click", () => switchTab("register"));
document.getElementById("hero-cta-events").addEventListener("click", () => {
  const target = document.getElementById("featured-events-section");
  const grid = document.getElementById("events-grid");
  (target && !target.classList.contains("hidden") ? target : grid).scrollIntoView({ behavior: "smooth", block: "start" });
});
// Sidebar "View full calendar" link - same destination as "View all events"
// above, just a second entry point (matches the reference layout's sidebar
// card having its own link rather than sharing the hero's own button).
document.getElementById("hero-upcoming-viewall").addEventListener("click", () => {
  const target = document.getElementById("featured-events-section");
  const grid = document.getElementById("events-grid");
  (target && !target.classList.contains("hidden") ? target : grid).scrollIntoView({ behavior: "smooth", block: "start" });
});

document.getElementById("lang-en").addEventListener("click", () => setLang("en"));
document.getElementById("lang-ar").addEventListener("click", () => setLang("ar"));
function setLang(lang) {
  currentLang = lang;
  applyI18n();
  renderEventDropdowns();
  renderEventsGrid();
  renderRegisterEventsGrid();
  renderAnnualGrid();
  renderLandingAnnualPreview();
  renderFeaturedEvents();
  renderHeroUpcoming();
  renderNewsList(NEWS_DATA);
  renderSpotlightGrid(SPOTLIGHTS_DATA);
  // Committee page/admin list are both built with t() at render time (tier
  // labels), same reasoning as renderFamilyList()/renderTournamentBody()
  // below - re-render from the already-fetched data rather than re-fetching.
  renderPublicCommittee(COMMITTEE_PUBLIC_DATA);
  renderCommitteeAdminList();
  {
    const committeeTierSel = document.getElementById("committee-tier");
    if (committeeTierSel) committeeTierSel.innerHTML = committeeTierSelectHtml(committeeTierSel.value || COMMITTEE_TIERS[0]);
  }
  renderCommunityStats(COMMUNITY_STATS);
  renderHeroStats(COMMUNITY_STATS);
  applyLandingPageToUI();
  renderLandingSectionsAdminList();
  renderLadder();
  // My Family's relationship dropdowns are built with t() at render time
  // (like the tournament panel below), so without this they'd keep showing
  // English/Arabic option labels after a language switch even though the
  // rest of the page flipped. Safe to call unconditionally: it no-ops when
  // there's no logged-in member or the #mp-family-list element isn't there.
  renderFamilyList();
  // Same reasoning as renderFamilyList() above, for the sign-up form's own
  // relationship dropdown (built with t() at population time, not re-run on
  // every render like renderFamilyList()) - preserves whatever was already
  // selected instead of resetting it.
  {
    const suRel = document.getElementById("su-relationship");
    if (suRel) suRel.innerHTML = familyRelationSelectHtml(suRel.value);
  }
  // Tournament admin panel (progress stepper, setup/schedule cards, setup
  // preview) has its own render function driven by the TOURNAMENT_DATA
  // global rather than by setLang's usual per-section calls above - without
  // this it stays in whatever language it was last loaded in, and once the
  // page's dir flips to rtl that stale content renders with bidi artifacts.
  // Safe to call unconditionally: it no-ops into the (possibly hidden)
  // #tourn-body element whether or not a tournament is currently loaded.
  renderTournamentBody();
  // Same gap on the public/member-facing tournament viewer: re-render
  // whichever of the list or an open tournament's detail is currently
  // showing, using PUBLIC_TOURNAMENT_OPEN_EVENT_ID to know which.
  if (document.getElementById("view-tournaments").classList.contains("active")) {
    if (PUBLIC_TOURNAMENT_OPEN_EVENT_ID != null) {
      openPublicTournament(PUBLIC_TOURNAMENT_OPEN_EVENT_ID);
    } else {
      renderPublicTournamentsList();
    }
  }
  if (document.getElementById("mp-result").classList.contains("hidden") === false) {
    renderTierDropdown();
  }
  if (CURRENT_SESSION && CURRENT_SESSION.type === "member") {
    renderAttendeesChecklist();
    renderFamilyList();
    loadFamilyPoolMembers();
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
    loadActivityLog(false);
    renderMembersInviteEventDropdown();
    renderMemberAddEventDropdown();
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
  applyLandingPageToUI();
  populateTermsAdminForm();
  // Committee tier titles are admin-editable data on SETTINGS (see
  // committeeTierLabel() above) - refresh the form and every place that
  // reads them whenever settings (re)load.
  populateCommitteeTierLabelsForm();
  renderPublicCommittee(COMMITTEE_PUBLIC_DATA);
  renderCommitteeAdminList();
  {
    const committeeTierSel = document.getElementById("committee-tier");
    if (committeeTierSel) committeeTierSel.innerHTML = committeeTierSelectHtml(committeeTierSel.value || COMMITTEE_TIERS[0]);
  }
}

// -------------------------------------------------------- terms & conditions --
// Bilingual text a member accepts at sign-up and again whenever the
// committee edits it (see PUT /api/admin/terms in server.js, which bumps
// SETTINGS.terms.version). Unlike other bilingual content (About/Hero, which
// follow bilingual(en, ar) and show only whichever language is currently
// active), the terms modal always shows BOTH languages - English first, then
// Arabic - regardless of the site's current language toggle, so acceptance
// is never gated on which language a member happens to be browsing in.
function renderTermsModalBody() {
  const container = document.getElementById("terms-modal-body");
  container.innerHTML = "";
  const terms = SETTINGS && SETTINGS.terms;
  if (!terms) return;

  const labelStyle = "font-size:0.7rem;font-weight:700;letter-spacing:0.06em;color:var(--muted);margin-bottom:4px;";

  const enLabel = document.createElement("div");
  enLabel.textContent = "EN";
  enLabel.style.cssText = labelStyle;
  const enText = document.createElement("div");
  enText.textContent = terms.textEn || "";
  enText.style.cssText = "direction:ltr;text-align:left;";

  const divider = document.createElement("hr");
  divider.style.cssText = "margin:14px 0;border:none;border-top:1px solid rgba(0,0,0,0.12);";

  const arLabel = document.createElement("div");
  arLabel.textContent = "AR";
  arLabel.style.cssText = labelStyle;
  const arText = document.createElement("div");
  arText.textContent = terms.textAr || "";
  arText.style.cssText = "direction:rtl;text-align:right;";

  container.append(enLabel, enText, divider, arLabel, arText);
}
// Keeps the admin's Terms & Conditions textareas in sync with server truth -
// runs every time settings are (re)loaded, same pattern as
// populateThemeAdminForm()/populateLandingAdminForms().
function populateTermsAdminForm() {
  const terms = SETTINGS && SETTINGS.terms;
  const arField = document.getElementById("terms-text-ar");
  if (!terms || !arField) return;
  arField.value = terms.textAr || "";
  document.getElementById("terms-text-en").value = terms.textEn || "";
  const meta = document.getElementById("terms-admin-meta");
  if (meta) {
    const updated = terms.updatedAt ? new Date(terms.updatedAt).toLocaleString(currentLang === "ar" ? "ar-EG" : "en-GB") : "";
    meta.textContent = `${t("termsVersionLabel")}: ${terms.version} · ${t("termsLastUpdated")}: ${updated}`;
  }
}
document.getElementById("terms-save-btn").addEventListener("click", async () => {
  const msg = document.getElementById("terms-admin-msg");
  const textAr = document.getElementById("terms-text-ar").value.trim();
  const textEn = document.getElementById("terms-text-en").value.trim();
  if (!textAr || !textEn) {
    highlightMissingFields(["terms-text-ar", "terms-text-en"]);
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  try {
    const result = await api("/api/admin/terms", { method: "PUT", body: JSON.stringify({ textEn, textAr }) });
    SETTINGS = { ...SETTINGS, terms: result.termsAndConditions };
    populateTermsAdminForm();
    showMsg(msg, t("termsSaved"), true);
  } catch (err) {
    showMsg(msg, err.message, false);
  }
});

// One shared modal, two modes - both let the member read AND accept in the
// same window, they just differ in what "accept" does and whether the
// window can be dismissed without accepting:
//  - "signup": closeable (X shown), opened from the sign-up screen's Terms &
//    Conditions link. There's no account yet to record server-side
//    acceptance against, so its "I Agree" button simply checks the
//    #su-agree-terms box and closes - the real acceptance is recorded when
//    the signup form is submitted (agreeTerms: true, validated server-side
//    too). A prospective member can still just tick the box on the form
//    directly without ever opening this window.
//  - "gate": non-dismissible (no X, no close-on-click-outside), shown to an
//    already-logged-in member whose own termsAcceptedVersion is behind
//    SETTINGS.terms.version (see applyMaybeShowTermsGate(), called from
//    updateUIForSession()) - e.g. right after the committee edits the text.
//    Its "I Agree" button calls the server to record acceptance for real.
let TERMS_MODAL_MODE = null;
function openTermsModal(mode) {
  TERMS_MODAL_MODE = mode;
  renderTermsModalBody();
  document.getElementById("terms-modal-close").classList.toggle("hidden", mode === "gate");
  document.getElementById("terms-gate-intro").classList.toggle("hidden", mode !== "gate");
  document.getElementById("terms-agree-btn").classList.remove("hidden");
  document.getElementById("terms-modal").classList.remove("hidden");
}
function closeTermsModal() {
  document.getElementById("terms-modal").classList.add("hidden");
}
document.getElementById("terms-modal-close").addEventListener("click", closeTermsModal);
document.getElementById("su-terms-link").addEventListener("click", (e) => {
  e.preventDefault();
  openTermsModal("signup");
});
document.getElementById("terms-agree-btn").addEventListener("click", async () => {
  if (TERMS_MODAL_MODE === "signup") {
    // No session exists yet at sign-up time - just reflect the agreement on
    // the form itself, same as if the member had ticked the box directly.
    const checkbox = document.getElementById("su-agree-terms");
    checkbox.checked = true;
    checkbox.classList.remove("field-missing");
    closeTermsModal();
    return;
  }
  try {
    const result = await api("/api/me/accept-terms", { method: "POST" });
    if (CURRENT_SESSION && CURRENT_SESSION.type === "member") CURRENT_SESSION.member = result.member;
    closeTermsModal();
  } catch (err) {
    // Session likely died in the meantime - handleSessionExpired() (wired
    // into api()'s error path) already surfaces this; nothing extra to do.
  }
});
// True once the gate is open for the current session, so a re-render (e.g.
// another updateUIForSession() call from an unrelated settings refresh)
// doesn't repeatedly yank focus back to an already-open modal.
let TERMS_GATE_OPEN = false;
function applyMaybeShowTermsGate() {
  const isMember = CURRENT_SESSION && CURRENT_SESSION.type === "member";
  const terms = SETTINGS && SETTINGS.terms;
  if (!isMember || !terms) {
    TERMS_GATE_OPEN = false;
    return;
  }
  const accepted = CURRENT_SESSION.member.termsAcceptedVersion || 0;
  if (accepted < terms.version) {
    if (!TERMS_GATE_OPEN) {
      TERMS_GATE_OPEN = true;
      openTermsModal("gate");
    }
  } else if (TERMS_GATE_OPEN) {
    TERMS_GATE_OPEN = false;
    closeTermsModal();
  }
}

// A staff/tournament/management account whose password was set by the
// committee admin (see mustChangePassword in server.js, POST
// /api/staff/accounts) must replace it with one only they know before doing
// anything else - this covers the whole "Tournament Manager gets handed a
// shared starting password" case, not just Admin (the only role that
// previously had any self-service way to change its own password at all,
// via the Settings tab's "Change my password" card - see updateUIForSession()
// for how that tab is hidden from every other staff role). Mirrors
// applyMaybeShowTermsGate() just above: a non-dismissible modal that stays
// open until the server confirms the password actually changed.
let MUST_CHANGE_PASSWORD_GATE_OPEN = false;
function applyMaybeShowMustChangePasswordGate() {
  const isStaff = CURRENT_SESSION && CURRENT_SESSION.type === "staff";
  const mustChange = isStaff && CURRENT_SESSION.staff.mustChangePassword;
  const modal = document.getElementById("must-change-password-modal");
  if (mustChange) {
    if (!MUST_CHANGE_PASSWORD_GATE_OPEN) {
      MUST_CHANGE_PASSWORD_GATE_OPEN = true;
      document.getElementById("mcp-old").value = "";
      document.getElementById("mcp-new").value = "";
      document.getElementById("mcp-msg").classList.remove("show");
      modal.classList.remove("hidden");
    }
  } else if (MUST_CHANGE_PASSWORD_GATE_OPEN) {
    MUST_CHANGE_PASSWORD_GATE_OPEN = false;
    modal.classList.add("hidden");
  }
}
document.getElementById("mcp-submit").addEventListener("click", async () => {
  const oldPassword = document.getElementById("mcp-old").value;
  const newPassword = document.getElementById("mcp-new").value;
  const msg = document.getElementById("mcp-msg");
  if (!oldPassword || !newPassword) {
    highlightMissingFields(["mcp-old", "mcp-new"]);
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  if (newPassword.length < 6) {
    showMsg(msg, t("errPasswordShort"), false);
    return;
  }
  try {
    const result = await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ oldPassword, newPassword }),
    });
    if (CURRENT_SESSION && CURRENT_SESSION.type === "staff" && result.staff) {
      CURRENT_SESSION.staff = result.staff;
    }
    document.getElementById("mcp-old").value = "";
    document.getElementById("mcp-new").value = "";
    // Closes the gate and, since CURRENT_SESSION.staff.mustChangePassword is
    // now false, reveals whatever this role's normal view actually is.
    updateUIForSession();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

// ------------------------------------------------------------ landing page --
// Renders the admin-customized hero text, About block, gallery, sponsors,
// and section order/visibility onto the public Events landing page. Called
// after every settings load and after every landing-page admin save, so the
// public page and the admin form never drift out of sync with each other.
function applyLandingPageToUI() {
  const lp = SETTINGS && SETTINGS.landingPage;
  if (!lp) return;
  LANDING_PAGE = lp;

  const headlineEl = document.getElementById("landing-hero-headline");
  const taglineEl = document.getElementById("landing-hero-tagline");
  if (headlineEl) headlineEl.textContent = bilingual(lp.hero.headlineEn, lp.hero.headlineAr);
  if (taglineEl) taglineEl.textContent = bilingual(lp.hero.taglineEn, lp.hero.taglineAr);
  const heroPhotoCard = document.getElementById("hero-photo-card");
  if (heroPhotoCard) {
    // No photo set: leave the inline background-image off entirely, so the
    // card falls back to the plain club-color gradient defined in CSS
    // (.hero-photo-card's own background) rather than an empty url(). When
    // a photo IS set, .hero-photo-overlay (a separate absolutely-positioned
    // layer on top) is what tints it in the club's own colors. Still set
    // even when a video is also active - it's the video's poster/fallback,
    // see the video block right below.
    heroPhotoCard.style.backgroundImage = lp.hero.photo ? `url("${lp.hero.photo}")` : "";
  }
  const heroVideoEl = document.getElementById("hero-video-bg");
  if (heroVideoEl) {
    // A video takes priority over the plain photo when both are set - the
    // photo becomes the <video poster> (shown while it loads, and as the
    // fallback for a browser/network that can't play it) instead of just
    // disappearing. Only touch .src when it's actually changing, so this
    // (called on every settings load) doesn't restart an already-playing
    // video on every unrelated re-render.
    if (lp.hero.video) {
      if (heroVideoEl.getAttribute("src") !== lp.hero.video) heroVideoEl.setAttribute("src", lp.hero.video);
      heroVideoEl.poster = lp.hero.photo || "";
      heroVideoEl.classList.remove("hidden");
      // Autoplay can still be blocked by some browsers even when muted; if
      // so this just fails silently and the poster (or the plain photo/
      // gradient behind it) keeps showing - never an error the visitor sees.
      heroVideoEl.play().catch(() => {});
    } else {
      heroVideoEl.classList.add("hidden");
      heroVideoEl.removeAttribute("src");
      heroVideoEl.load();
    }
  }

  const aboutTitleEl = document.getElementById("landing-about-title");
  const aboutBodyEl = document.getElementById("landing-about-body");
  const aboutPhotoEl = document.getElementById("landing-about-photo");
  if (aboutTitleEl) aboutTitleEl.textContent = bilingual(lp.about.titleEn, lp.about.titleAr) || t("aboutUsTitle");
  if (aboutBodyEl) aboutBodyEl.textContent = bilingual(lp.about.bodyEn, lp.about.bodyAr);
  if (aboutPhotoEl) {
    if (lp.about.photo) {
      aboutPhotoEl.src = lp.about.photo;
      aboutPhotoEl.classList.remove("hidden");
    } else {
      aboutPhotoEl.removeAttribute("src");
      aboutPhotoEl.classList.add("hidden");
    }
  }

  const waTitleEl = document.getElementById("landing-whatsapp-title");
  const waBodyEl = document.getElementById("landing-whatsapp-body");
  const waQrEl = document.getElementById("landing-whatsapp-qr");
  const waLinkEl = document.getElementById("landing-whatsapp-link");
  if (waTitleEl) waTitleEl.textContent = bilingual(lp.whatsapp.titleEn, lp.whatsapp.titleAr) || t("whatsappCommunityTitle");
  if (waBodyEl) waBodyEl.textContent = bilingual(lp.whatsapp.bodyEn, lp.whatsapp.bodyAr);
  if (waQrEl) {
    if (lp.whatsapp.qrImage) {
      waQrEl.src = lp.whatsapp.qrImage;
      waQrEl.classList.remove("hidden");
    } else {
      waQrEl.removeAttribute("src");
      waQrEl.classList.add("hidden");
    }
  }
  if (waLinkEl) {
    if (lp.whatsapp.link) {
      waLinkEl.href = lp.whatsapp.link;
      waLinkEl.classList.remove("hidden");
    } else {
      waLinkEl.classList.add("hidden");
    }
  }
  renderMpWhatsappCard();

  renderGalleryGrid(lp.gallery || []);
  renderSponsorsStrip(lp.sponsors || []);
  applyLandingSectionOrder(lp.sections || []);
}

// The community WhatsApp QR is also shown on Member Profile, independent of
// whether the landing-page section is toggled on - members who never visit
// the landing page (they land straight on Register/Member Profile) should
// still be able to find it. Only requires a QR image to be set; the
// landing-page enabled flag doesn't gate this copy at all.
function renderMpWhatsappCard() {
  const card = document.getElementById("mp-whatsapp-card");
  if (!card) return;
  const lp = SETTINGS && SETTINGS.landingPage;
  const wa = lp && lp.whatsapp;
  const isMember = !!(CURRENT_SESSION && CURRENT_SESSION.member);
  if (!isMember || !wa || !wa.qrImage) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  document.getElementById("mp-whatsapp-title").textContent = bilingual(wa.titleEn, wa.titleAr) || t("whatsappCommunityTitle");
  document.getElementById("mp-whatsapp-body").textContent = bilingual(wa.bodyEn, wa.bodyAr);
  const img = document.getElementById("mp-whatsapp-qr");
  img.src = wa.qrImage;
  const link = document.getElementById("mp-whatsapp-link");
  if (wa.link) {
    link.href = wa.link;
    link.classList.remove("hidden");
  } else {
    link.classList.add("hidden");
  }
}

function renderGalleryGrid(items) {
  const wrap = document.getElementById("gallery-grid");
  const empty = document.getElementById("gallery-empty");
  if (!wrap) return;
  if (empty) empty.classList.toggle("hidden", items.length > 0);
  wrap.innerHTML = items
    .map((g) => {
      const caption = bilingual(g.captionEn, g.captionAr);
      return `<div class="gallery-card">
        <img class="photo" src="${escapeAttr(g.photo)}" alt="" />
        ${caption ? `<div class="caption">${escapeAttr(caption)}</div>` : ""}
      </div>`;
    })
    .join("");
}

function renderSponsorsStrip(items) {
  const wrap = document.getElementById("sponsors-strip");
  const empty = document.getElementById("sponsors-empty");
  if (!wrap) return;
  if (empty) empty.classList.toggle("hidden", items.length > 0);
  wrap.innerHTML = items
    .map((s) => {
      const logoHtml = s.logo
        ? `<img src="${escapeAttr(s.logo)}" alt="" />`
        : `<div style="font-weight:700;color:var(--red-dark);">${escapeAttr(s.name)}</div>`;
      const inner = `${logoHtml}<div class="name">${escapeAttr(s.name)}</div>`;
      return s.url
        ? `<a class="sponsor-item" href="${escapeAttr(s.url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
        : `<div class="sponsor-item">${inner}</div>`;
    })
    .join("");
}

// Moves each landing-page section's wrapper element (see the
// data-landing-section attributes in index.html) into the config's order,
// and shows/hides it per the config's enabled flag. Hiding "events" here
// only affects the landing page - members can still register from the
// Register tab's own card grid (see renderRegisterEventsGrid()), so there's
// no dead end even with this section turned off.
function applyLandingSectionOrder(sections) {
  const parent = document.getElementById("view-events");
  if (!parent) return;
  const list = sections && sections.length ? sections : LANDING_SECTION_DEFAULT_ORDER.map((key) => ({ key, enabled: true }));
  list.forEach((s) => {
    const el = parent.querySelector(`[data-landing-section="${s.key}"]`);
    if (!el) return;
    parent.appendChild(el);
    el.classList.toggle("hidden", !s.enabled);
  });
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
  const headerLoginBtn = document.getElementById("header-login-btn");
  if (!CURRENT_SESSION) {
    badge.classList.add("hidden");
    if (headerLoginBtn) headerLoginBtn.classList.remove("hidden");
    return;
  }
  badge.classList.remove("hidden");
  if (headerLoginBtn) headerLoginBtn.classList.add("hidden");
  if (CURRENT_SESSION.type === "member") {
    text.textContent = `${t("sessionAsMember")} ${CURRENT_SESSION.member.name} (#${CURRENT_SESSION.member.membershipNumber})`;
  } else {
    const roleLabel =
      CURRENT_SESSION.staff.role === "admin" ? t("roleAdminShort") :
      CURRENT_SESSION.staff.role === "tournament" ? t("roleTournamentShort") :
      CURRENT_SESSION.staff.role === "management" ? t("roleManagementShort") : t("roleStaffShort");
    text.textContent = `${t("sessionAsStaff")} ${CURRENT_SESSION.staff.name} (${roleLabel})`;
  }
}

function updateUIForSession() {
  updateSessionBadge();
  const isMember = CURRENT_SESSION && CURRENT_SESSION.type === "member";
  const isStaff = CURRENT_SESSION && CURRENT_SESSION.type === "staff";
  const isAdmin = isStaff && CURRENT_SESSION.staff.role === "admin";
  // Tournament Manager: a narrower staff role that can only reach
  // tournaments, the Event dashboard, and check-in - see requireStaffRole()
  // in server.js for the matching backend gate. isAdminAreaVisible covers
  // both roles that get *some* view of the Admin section; .admin-full-only
  // elements (tagged in index.html) are then hidden for anyone who isn't
  // the real isAdmin, so a Tournament Manager only ever sees the cards this
  // role is actually allowed to use.
  const isTournamentRole = isStaff && CURRENT_SESSION.staff.role === "tournament";
  // Management: another narrow staff role, this one scoped the other way -
  // it can ONLY reach the new Management Dashboard tab (cross-event
  // analytics + per-event auto-reports), nothing else in Admin. See
  // requireStaffRole(["management"]) in server.js for the matching backend
  // gate on the dashboard/report endpoints.
  const isManagementRole = isStaff && CURRENT_SESSION.staff.role === "management";
  const isAdminAreaVisible = isAdmin || isTournamentRole || isManagementRole;

  // Register tab
  document.getElementById("reg-auth").classList.toggle("hidden", isMember);
  document.getElementById("reg-form").classList.toggle("hidden", !isMember);
  document.getElementById("reg-events-section").classList.toggle("hidden", !isMember);
  if (!isMember) document.getElementById("reg-qr-card").classList.add("hidden");
  if (isMember) {
    renderAttendeesChecklist();
    renderRegisterEventsGrid();
    applyPendingEventSelection();
  }

  // My Points tab
  document.getElementById("mp-signed-out").classList.toggle("hidden", isMember);
  document.getElementById("mp-nickname-card").classList.toggle("hidden", !isMember);
  document.getElementById("mp-family-card").classList.toggle("hidden", !isMember);
  document.getElementById("mp-registrations-card").classList.toggle("hidden", !isMember);
  document.getElementById("mp-chat-card").classList.toggle("hidden", !isMember);
  document.getElementById("mp-security-card").classList.toggle("hidden", !isMember);
  renderMpWhatsappCard();
  if (isMember) {
    renderRecoveryPinStatus("mp-recovery-pin-status", CURRENT_SESSION.member.hasRecoveryPin);
    renderNicknameStatus();
    if (pointsVisible()) {
      document.getElementById("mp-points-disabled-note").classList.add("hidden");
      loadMyBalance();
    } else {
      document.getElementById("mp-result").classList.add("hidden");
      document.getElementById("mp-points-disabled-note").classList.remove("hidden");
    }
    renderFamilyList();
    loadFamilyPoolMembers();
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
  document.getElementById("admin-denied").classList.toggle("hidden", !isStaff || isAdminAreaVisible);
  document.getElementById("admin-panel").classList.toggle("hidden", !isAdminAreaVisible);
  // Cards/tabs only the full Admin role should see (Members, Points &
  // Rewards, Content & Chat, Settings tabs; Add/Edit/Delete-event and Enter
  // results within Events; the Overview stats card; "Register a member"
  // within the per-event hub) - reset every time so switching sessions
  // (e.g. a Tournament Manager logs out, an admin logs in) doesn't leave
  // stale visibility from the previous session.
  document.querySelectorAll(".admin-full-only").forEach((el) => el.classList.toggle("hidden", !isAdmin));
  // Management Dashboard tab/panel: visible to Admin and the Management
  // role, hidden from a Tournament Manager or plain Staff account.
  document.querySelectorAll(".mgmt-tab-only").forEach((el) => el.classList.toggle("hidden", !(isAdmin || isManagementRole)));
  // Overview/Events tabs (and everything inside them not already
  // admin-full-only) are for Admin + Tournament Manager - a pure Management
  // role account has no use for event editing or the old per-event mini
  // dashboard, so it only ever sees the Management Dashboard tab.
  document.querySelectorAll(".evt-tab-only").forEach((el) => el.classList.toggle("hidden", isManagementRole && !isAdmin));
  if (isAdminAreaVisible) {
    initAdminTabs();
    // A Tournament Manager can't reach Members/Points/Content/Settings - if
    // the currently-active tab is one of those (remembered from an earlier
    // full-admin session in this same browser, or a mid-session role
    // switch with no page reload in between), land on Events instead of a
    // blank panel with no tab button to get back out of.
    if (isTournamentRole) {
      const activeTab = document.querySelector(".admin-tab.active");
      if (activeTab && activeTab.classList.contains("admin-full-only")) switchAdminTab("events");
    }
    // A pure Management role account only has the Management tab available
    // at all, so always land there regardless of what was remembered from
    // an earlier full-admin/tournament session in this same browser.
    if (isManagementRole && !isAdmin) {
      switchAdminTab("management");
      loadManagementDashboard();
    } else {
      loadAdminDashboard();
    }
    if (isAdmin) {
      loadManagementDashboard();
      loadAdminOverview();
      loadActivityLog(true);
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
      loadCommitteeAdminList();
      applySettingsToUI();
      populateLandingAdminForms();
      renderRecoveryPinStatus("staff-recovery-pin-status", CURRENT_SESSION.staff.hasRecoveryPin);
    }
  } else {
    document.getElementById("admin-chat-badge").classList.add("hidden");
  }

  applyMaybeShowTermsGate();
  applyMaybeShowMustChangePasswordGate();

  // Idle auto-logout timers track CURRENT_SESSION, not the individual
  // login/logout call sites - every one of them already calls
  // updateUIForSession() right after changing CURRENT_SESSION (login,
  // signup, checkSession, manual logout, a stale-session recovery), so this
  // single chokepoint keeps the timers in sync with every one of them.
  if (CURRENT_SESSION) {
    scheduleIdleTimers();
  } else {
    clearIdleTimers();
    hideIdleWarning();
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

// ------------------------------------------------------- idle auto-logout --
// Security requirement: ANY signed-in session (member, plain staff/Gate
// Scanner, Tournament Manager, Management, or full Admin) is automatically
// signed out after 30 minutes with no real user activity on the page, with a
// "still there?" warning shown 1 minute before that happens (a non-closeable
// modal with a countdown and a button that cancels it). Only a genuine
// mouse/keyboard/touch/scroll interaction counts as activity - a tab left
// open and truly untouched times out on schedule even while the warning
// itself is on screen, since showing it isn't itself user activity.
const IDLE_LOGOUT_MS = 30 * 60 * 1000; // 30 minutes, uniform across every role
const IDLE_WARNING_LEAD_MS = 60 * 1000; // warn 1 minute before logging out
let idleWarningTimer = null;
let idleLogoutTimer = null;
let idleCountdownInterval = null;
let idleWarningShownAt = 0;

function clearIdleTimers() {
  clearTimeout(idleWarningTimer);
  clearTimeout(idleLogoutTimer);
  clearInterval(idleCountdownInterval);
  idleWarningTimer = null;
  idleLogoutTimer = null;
  idleCountdownInterval = null;
}

function hideIdleWarning() {
  document.getElementById("idle-warning-modal").classList.add("hidden");
  clearInterval(idleCountdownInterval);
  idleCountdownInterval = null;
}

// A language-neutral "1:00" / "0:45" clock, rather than assembling a
// translated sentence around a changing number - sidesteps word-order and
// pluralization differences between English and Arabic entirely.
function formatIdleCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function showIdleWarning() {
  if (!CURRENT_SESSION) return;
  idleWarningShownAt = Date.now();
  document.getElementById("idle-warning-modal").classList.remove("hidden");
  const countdownEl = document.getElementById("idle-warning-countdown");
  countdownEl.textContent = formatIdleCountdown(IDLE_WARNING_LEAD_MS);
  idleCountdownInterval = setInterval(() => {
    const remaining = IDLE_WARNING_LEAD_MS - (Date.now() - idleWarningShownAt);
    countdownEl.textContent = formatIdleCountdown(remaining);
    if (remaining <= 0) clearInterval(idleCountdownInterval);
  }, 1000);
}

// Real, server-side logout (not just clearing local state) - reuses the
// exact same endpoint and post-logout UI reset as the manual "Log out"
// button, plus a friendly explanation left on every sign-in surface a
// member/staff/admin could be looking at (mirrors handleSessionExpired()'s
// pattern above for a stale/expired session).
async function performIdleLogout() {
  hideIdleWarning();
  clearIdleTimers();
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (e) {
    /* ignore - the UI is being signed out regardless */
  }
  CURRENT_SESSION = null;
  updateUIForSession();
  ["admin-lock-msg", "scan-lock-msg", "li-msg"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) showMsg(el, t("idleLoggedOutMsg"), false);
  });
}

function scheduleIdleTimers() {
  clearIdleTimers();
  if (!CURRENT_SESSION) return;
  idleWarningTimer = setTimeout(showIdleWarning, IDLE_LOGOUT_MS - IDLE_WARNING_LEAD_MS);
  idleLogoutTimer = setTimeout(performIdleLogout, IDLE_LOGOUT_MS);
}

// Resets the clock and (only when called explicitly, e.g. by the "I'm still
// here" button) dismisses an already-open warning.
function registerIdleActivity() {
  if (!CURRENT_SESSION) return;
  hideIdleWarning();
  scheduleIdleTimers();
}
// Throttled so a mousemove/scroll burst doesn't reschedule timers dozens of
// times a second - activity is only "counted" at most once every 2 seconds.
// Deliberately a no-op once the warning modal is already showing: it covers
// the whole page and blocks interaction with everything behind it, so the
// only thing left to click IS the "I'm still here" button - but the mouse
// still has to travel across the screen to reach it, and ambient
// mousemove/scroll events along the way must not silently dismiss the
// warning before that explicit click lands (confirmed with Playwright: a
// plain hover-then-click sequence fires a mousemove right over the button
// first, which used to hide the modal out from under the click). Requiring
// the explicit button click is also the more correct security behavior
// anyway - incidental mouse jitter (a bumped desk, a monitor vibrating)
// shouldn't be able to silently cancel a security-driven idle warning.
let lastIdleActivityAt = 0;
function onIdleActivityEvent() {
  if (!document.getElementById("idle-warning-modal").classList.contains("hidden")) return;
  const now = Date.now();
  if (now - lastIdleActivityAt < 2000) return;
  lastIdleActivityAt = now;
  registerIdleActivity();
}
["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"].forEach((evt) => {
  document.addEventListener(evt, onIdleActivityEvent, { passive: true });
});
// A background tab brought back to the front (or a laptop woken from sleep)
// re-checks activity immediately, rather than the idle clock having kept
// running invisibly the whole time it was hidden.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) onIdleActivityEvent();
});
document.getElementById("idle-warning-stay-btn").addEventListener("click", () => {
  lastIdleActivityAt = Date.now();
  registerIdleActivity();
});

// --------------------------------------------------------------- loading --
async function loadEvents() {
  EVENTS_DATA = await api("/api/events");
  await refreshTournamentEventIds();
  renderEventDropdowns();
  renderEventsGrid();
  renderRegisterEventsGrid();
  renderAnnualGrid();
  renderLandingAnnualPreview();
  renderFeaturedEvents();
  renderHeroUpcoming();
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
  updateRegSelectedEventLabel();

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
// The Register tab shows a card grid, not the underlying <select> (see
// #reg-event in index.html - kept in the DOM as the form's source of truth,
// but hidden) - this is what tells the member which event that hidden
// selection actually points at, in place of the dropdown they'd otherwise
// read that off of.
function updateRegSelectedEventLabel() {
  const label = document.getElementById("reg-selected-event-label");
  if (!label) return;
  const sel = document.getElementById("reg-event");
  const ev = EVENTS_DATA.find((e) => e.id === Number(sel.value));
  if (!ev) {
    label.textContent = t("regNoEventSelected");
    label.classList.add("empty");
    return;
  }
  label.classList.remove("empty");
  label.textContent = `${t("regSelectedEventPrefix")} ${eventLabel(ev)} — ${ev.date}`;
}
document.getElementById("reg-event").addEventListener("change", () => {
  updateRegCapacityNote();
  updateRegSelectedEventLabel();
});

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
// Same upcoming-events data and card markup as the Events tab's grid above -
// shown on the Register tab itself (member-signed-in state only) so someone
// who navigates straight to Register, without going through Events first,
// still sees photo cards with details/register actions instead of only the
// bare <select> below. Clicking a card's Register button reuses
// startRegisterFlow(), which just preselects that event in the dropdown
// (already on this tab, so no tab switch actually happens).
function renderRegisterEventsGrid() {
  const grid = document.getElementById("reg-events-grid");
  const empty = document.getElementById("reg-events-empty");
  if (!grid) return;
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
// The landing page's "Annual Activities" section: a bounded preview (most
// recent few, newest first) of the same past-events data the standalone
// Annual Activities tab shows in full (renderAnnualGrid above) - not a
// separate data source, and not admin-curated content like Gallery/News.
// Kept short deliberately: the standalone tab has no limit at all and is
// meant to grow forever as a full history, but embedding that whole
// unbounded list directly in the homepage would make it longer every year;
// a "View all" link (wired up further down) sends anyone who wants the
// full list to that tab instead.
const LANDING_ANNUAL_PREVIEW_COUNT = 6;
function renderLandingAnnualPreview() {
  const grid = document.getElementById("landing-annual-grid");
  const empty = document.getElementById("landing-annual-empty");
  if (!grid) return;
  const past = EVENTS_DATA.filter((ev) => isPastEvent(ev) && !ev.parentEventId).sort((a, b) => b.date.localeCompare(a.date));
  const preview = past.slice(0, LANDING_ANNUAL_PREVIEW_COUNT);
  empty.classList.toggle("hidden", preview.length > 0);
  grid.innerHTML = preview.map((ev) => eventCardHtml(ev, true)).join("");
  wireEventCardButtons(grid, preview, true);
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
    renderHeroStats(COMMUNITY_STATS);
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
// Small stat pill that floats over the hero photo's corner - members,
// events held, and events currently open for registration. Reuses the
// same COMMUNITY_STATS the Community section's stat row already loads
// (see loadCommunityContent) - no extra request - plus a live count off
// the already-loaded EVENTS_DATA for the "upcoming" figure.
function renderHeroStats(stats) {
  const wrap = document.getElementById("hero-stats-pill");
  if (!wrap || !stats) return;
  const upcoming = (EVENTS_DATA || []).filter((ev) => isUpcoming(ev) && !ev.parentEventId).length;
  wrap.innerHTML = `
    <div class="hs"><div class="n">${fmt(stats.totalMembers)}</div><div class="l">${escapeAttr(t("statTotalMembers"))}</div></div>
    <div class="hs"><div class="n">${fmt(stats.eventsHeld)}</div><div class="l">${escapeAttr(t("statEventsHeld"))}</div></div>
    <div class="hs"><div class="n">${fmt(upcoming)}</div><div class="l">${escapeAttr(t("statUpcomingEvents"))}</div></div>
  `;
}
// Compact "SEP 22" / equivalent-Arabic style date badge for the hero
// sidebar's Upcoming Events list - anchored to local midnight like
// weekdayName() above, for the same reason (a bare "YYYY-MM-DD" string
// parses as UTC and can shift a day depending on the viewer's timezone).
function shortDateBadge(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  const s = d.toLocaleDateString(currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-US", { month: "short", day: "numeric" });
  return currentLang === "ar" ? s : s.toUpperCase();
}
// The hero sidebar's "Upcoming Events" card - a compact list of the same
// soonest-first upcoming events renderFeaturedEvents() shows in full-size
// cards below the hero (same data/filter, no extra request), styled as a
// quick-glance list with a date badge instead of a full event card.
function renderHeroUpcoming() {
  const list = document.getElementById("hero-upcoming-list");
  if (!list) return;
  const upcoming = (EVENTS_DATA || [])
    .filter((ev) => isUpcoming(ev) && !ev.parentEventId)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 4);
  if (!upcoming.length) {
    list.innerHTML = `<div class="hero-upcoming-empty">${escapeAttr(t("heroUpcomingEmpty"))}</div>`;
    return;
  }
  list.innerHTML = upcoming
    .map(
      (ev) => `<div class="hero-upcoming-item">
        <div class="date">${escapeAttr(shortDateBadge(ev.date))}${ev.endDate && ev.endDate !== ev.date ? ` &ndash; ${escapeAttr(shortDateBadge(ev.endDate))}` : ""}</div>
        <div class="name">${eventNameHtml(ev)}</div>
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
      const date = new Date(p.postedAt).toLocaleDateString(currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-US");
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
  // A video (recap video once the event is past, cover video otherwise)
  // takes priority over the photo here, same rule as the landing page hero
  // banner - the photo still renders as the <video>'s poster frame, so
  // there's no blank flash while the video loads or if it fails to play.
  const heroVideo = isPast ? recap.video || "" : ev.coverVideo || "";
  const galleryPhotos = isPast && recapPhotos.length > 1 ? recapPhotos.slice(1) : [];
  const children = EVENTS_DATA.filter((e) => e.parentEventId === ev.id);
  const isParent = children.length > 0;
  content.innerHTML = `
    <span class="event-badge ${isPast ? "past" : ""}">${isPast ? t("eventPast") : t("eventUpcoming")}</span>
    ${
      heroVideo
        ? `<video class="photo-hero" controls playsinline ${heroPhoto ? `poster="${escapeAttr(heroPhoto)}"` : ""}><source src="${escapeAttr(heroVideo)}" /></video>`
        : heroPhoto
        ? `<img class="photo-hero" src="${escapeAttr(heroPhoto)}" alt="" />`
        : ""
    }
    <h2>${eventNameHtml(ev)}</h2>
    <div class="meta" style="margin-bottom:12px;">${escapeAttr(eventDateTimeLabel(ev))}${ev.sport ? " · " + escapeAttr(ev.sport) : ""}</div>
    ${TOURNAMENT_EVENT_IDS.has(ev.id) ? `<button class="secondary" id="modal-view-tournament-btn" style="margin-bottom:10px;">${t("btnViewTournament")}</button>` : ""}
    ${hasDesc ? `<h3>${t("aboutTitle")}</h3><p class="desc">${eventDescHtml(ev)}</p>` : ""}
    ${
      ev.whatsappQr
        ? `<h3>${t("eventWhatsappGroupTitle")}</h3><div style="text-align:center;"><img src="${escapeAttr(
            ev.whatsappQr
          )}" alt="" style="max-width:200px;border-radius:10px;display:block;margin:8px auto;" /></div>`
        : ""
    }
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
    // Setting .value programmatically doesn't fire "change", so the capacity
    // note and the card-grid-driven "Registering for: ..." label (see
    // updateRegSelectedEventLabel()) need an explicit refresh here - this is
    // the only path a click on an event card's Register button takes.
    updateRegCapacityNote();
    updateRegSelectedEventLabel();
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
// Redemption requests must start from the ladder's own tier-1 minimum
// (1500 points by default, admin-editable) and follow the hierarchy from
// there - a tier is only requestable once the member's balance actually
// covers it (enforced server-side too, see POST /api/redeem). Options the
// member can't yet afford are shown but disabled, with how many more
// points they need, so the dropdown itself makes the rule visible instead
// of only failing after the fact.
function renderTierDropdown() {
  if (!LADDER_DATA) return;
  const sel = document.getElementById("mp-tier");
  const balance = Number.isFinite(CURRENT_BALANCE) ? CURRENT_BALANCE : 0;
  sel.innerHTML = LADDER_DATA.ladder
    .map((tier) => {
      const reachable = balance >= tier.pointsRequired;
      const label = reachable
        ? `${fmt(tier.pointsRequired)} — ${ladderLabel(tier)}`
        : `${fmt(tier.pointsRequired)} — ${ladderLabel(tier)} (${fmt(tier.pointsRequired - balance)} ${t("tierPointsNeededSuffix")})`;
      return `<option value="${tier.tier}"${reachable ? "" : " disabled"}>${label}</option>`;
    })
    .join("");
  // Default the dropdown to the lowest tier the member can actually afford
  // (rather than always tier 1, which may itself be disabled) so the button
  // below starts in a sensible, submittable state whenever one exists.
  const firstReachable = LADDER_DATA.ladder.find((tier) => balance >= tier.pointsRequired);
  if (firstReachable) sel.value = String(firstReachable.tier);
  updateRedeemButtonState();
}

// The "Submit redemption request" button must be inactive whenever the
// currently selected tier isn't one the member's balance actually covers -
// this is the belt to the disabled-<option> braces above: a member can't
// submit a request for a reward they can't afford, whether that's because
// every tier is out of reach (balance below the 1,500-point tier-1 floor)
// or a stale selection is left over from before their balance changed.
function updateRedeemButtonState() {
  const sel = document.getElementById("mp-tier");
  const btn = document.getElementById("mp-redeem");
  if (!sel || !btn) return;
  const selected = sel.options[sel.selectedIndex];
  btn.disabled = !selected || selected.disabled;
}
document.getElementById("mp-tier").addEventListener("change", updateRedeemButtonState);

// ------------------------------------------------------------- sign up/in --
// Member type (Main Member/Follower Member - عضو اساسي/عضو تابع) is a
// self-declared social role, independent of which of them technically ends
// up with the bare club ID vs an auto-suffixed one (see nextFamilyAccountId
// in server.js) - e.g. a son who happens to sign up first still tags
// himself "Follower Member" if his father is the real head of the family's
// account. Only a Follower Member picks a relationship (who are they a
// follower OF) - a Main Member has no one to relate to, so that field stays
// hidden and empty for them.
document.getElementById("su-type-main").addEventListener("change", updateSignupRelationshipVisibility);
document.getElementById("su-type-follower").addEventListener("change", updateSignupRelationshipVisibility);
function updateSignupRelationshipVisibility() {
  const isFollower = document.getElementById("su-type-follower").checked;
  document.getElementById("su-relationship-wrap").classList.toggle("hidden", !isFollower);
}
document.getElementById("su-relationship").addEventListener("change", (e) => {
  const otherInput = document.getElementById("su-relationship-other");
  otherInput.classList.toggle("hidden", e.target.value !== "other");
  if (e.target.value === "other") otherInput.focus();
});

document.getElementById("su-submit").addEventListener("click", async () => {
  const membershipNumber = document.getElementById("su-membership").value.trim();
  const name = document.getElementById("su-name").value.trim();
  const password = document.getElementById("su-password").value;
  const nickname = document.getElementById("su-nickname").value.trim();
  const familyGroup = document.getElementById("su-family").value.trim();
  const phone = document.getElementById("su-phone").value.trim();
  const email = document.getElementById("su-email").value.trim();
  const agreeTerms = document.getElementById("su-agree-terms").checked;
  const memberType = document.getElementById("su-type-follower").checked ? "follower" : "main";
  const relSel = document.getElementById("su-relationship").value;
  const relationshipToMain = memberType === "follower" ? (relSel === "other" ? document.getElementById("su-relationship-other").value.trim() : relSel) : "";
  const msg = document.getElementById("su-msg");
  if (!membershipNumber || !name || !password) {
    highlightMissingFields(["su-membership", "su-name", "su-password"]);
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  if (password.length < 6) {
    showMsg(msg, t("errPasswordShort"), false);
    return;
  }
  if (memberType === "follower" && !relationshipToMain) {
    highlightMissingFields(["su-relationship"]);
    showMsg(msg, t("errRelationshipRequired"), false);
    return;
  }
  if (!agreeTerms) {
    highlightMissingFields(["su-agree-terms"]);
    showMsg(msg, t("errMustAcceptTerms"), false);
    return;
  }
  try {
    const result = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ membershipNumber, name, password, familyGroup, phone, email, agreeTerms, memberType, relationshipToMain }),
    });
    CURRENT_SESSION = { type: "member", member: result.member };
    SESSION_EXPIRY_HANDLED = false;
    document.getElementById("su-password").value = "";
    // Best-effort - reuses the same unique-nickname endpoint Member Profile
    // uses, so a taken nickname is skipped with a note rather than blocking
    // the account that was just successfully created; they can retry it
    // from Member Profile any time.
    let nicknameNote = "";
    if (nickname) {
      try {
        const nickResult = await api("/api/me/nickname", { method: "POST", body: JSON.stringify({ nickname }) });
        CURRENT_SESSION.member.nickname = nickResult.nickname;
      } catch (nickErr) {
        nicknameNote = " " + t("signupNicknameSkipped");
      }
    }
    msg.classList.remove("show");
    // Their family's club ID already had an account (e.g. a parent
    // registering after their child), so the server minted them their own
    // login id (e.g. 10234-2) under the same club ID, auto-pooled with the
    // rest of the family. Make sure they see and can save it - it's what
    // they log in with from now on, not the shared club card number - before
    // moving on into the signed-in app.
    if (result.assignedLoginId) {
      document.getElementById("su-form-fields").classList.add("hidden");
      const panel = document.getElementById("su-newid-panel");
      document.getElementById("su-newid-msg").textContent = t("newLoginIdMsg").replace("{id}", result.assignedLoginId) + nicknameNote;
      panel.classList.remove("hidden");
      document.getElementById("su-newid-continue").onclick = () => {
        panel.classList.add("hidden");
        document.getElementById("su-form-fields").classList.remove("hidden");
        updateUIForSession();
      };
      return;
    }
    if (nicknameNote) showMsg(msg, nicknameNote.trim(), true);
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
    highlightMissingFields(["li-membership", "li-password"]);
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
    highlightMissingFields(["reg-event"]);
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
    CURRENT_BALANCE = snap.balance;
    renderTierDropdown();
  } catch (e) {
    document.getElementById("mp-result").classList.add("hidden");
    CURRENT_BALANCE = null;
  }
}

document.getElementById("mp-redeem").addEventListener("click", async () => {
  const msg = document.getElementById("mp-redeem-msg");
  const tier = document.getElementById("mp-tier").value;
  if (!tier) return;
  try {
    // The server now rejects a request for a tier the current balance
    // doesn't cover (see POST /api/redeem) - the disabled options in this
    // dropdown already prevent picking one, this is just the confirming
    // success path.
    await api("/api/redeem", {
      method: "POST",
      body: JSON.stringify({ tier }),
    });
    showMsg(msg, t("okRedeemRequested"), true);
    loadMyBalance();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

// ------------------------------------------------- my family (linked IDs) --
// Distinct from the dependents below: these are OTHER club members (their
// own membershipNumber, possibly their own login) linked into the same
// familyGroup so points pool together server-side (see poolingKey() and
// /api/me/family/link|unlink in server.js). Loaded independently of
// loadMyBalance() so the linked-members list still works even when the
// points system itself is toggled off (pointsVisible() === false).
let FAMILY_POOL_MEMBERS = [];
async function loadFamilyPoolMembers() {
  const member = CURRENT_SESSION && CURRENT_SESSION.type === "member" ? CURRENT_SESSION.member : null;
  if (!member) {
    FAMILY_POOL_MEMBERS = [];
    renderFamilyLinkedList();
    return;
  }
  try {
    const snap = await api("/api/me/balance");
    FAMILY_POOL_MEMBERS = (snap.poolMembers || []).filter((m) => m.membershipNumber !== member.membershipNumber);
  } catch (e) {
    FAMILY_POOL_MEMBERS = [];
  }
  renderFamilyLinkedList();
}
// Refreshes both the linked-members list and (when points are visible) the
// balance hero's pool note - called after a successful link/unlink so the
// UI reflects the new pool immediately instead of waiting for a reload.
async function refreshFamilyAndBalance() {
  await loadFamilyPoolMembers();
  if (pointsVisible()) loadMyBalance();
}
function renderFamilyLinkedList() {
  const wrap = document.getElementById("mp-family-linked-list");
  const member = CURRENT_SESSION && CURRENT_SESSION.type === "member" ? CURRENT_SESSION.member : null;
  if (!wrap || !member) return;
  wrap.innerHTML = FAMILY_POOL_MEMBERS.length
    ? FAMILY_POOL_MEMBERS.map(
        (m) => `<div class="family-item" data-member-id="${escapeAttr(m.membershipNumber)}">
        <span class="name">${escapeAttr(m.name)} (#${escapeAttr(m.membershipNumber)})</span>
        <button class="secondary fam-unlink" data-member-id="${escapeAttr(m.membershipNumber)}" style="margin-top:0;padding:6px 12px;font-size:0.8rem;">${t("btnUnlink")}</button>
      </div>`
      ).join("")
    : `<p style="color:var(--muted);font-size:0.85rem;">${t("noLinkedFamilyMembersYet")}</p>`;
  wrap.querySelectorAll(".fam-unlink").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm(t("confirmUnlinkFamilyMember"))) return;
      try {
        await api("/api/me/family/unlink", {
          method: "POST",
          body: JSON.stringify({ membershipNumber: btn.dataset.memberId }),
        });
        showMsg(document.getElementById("fam-link-msg"), t("famUnlinked"), true);
        refreshFamilyAndBalance();
      } catch (e) {
        showMsg(document.getElementById("fam-link-msg"), e.message, false);
      }
    });
  });
}
document.getElementById("fam-link-add").addEventListener("click", async () => {
  const idInput = document.getElementById("fam-link-id");
  const membershipNumber = idInput.value.trim();
  const msg = document.getElementById("fam-link-msg");
  if (!membershipNumber) {
    highlightMissingFields(["fam-link-id"]);
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  try {
    await api("/api/me/family/link", {
      method: "POST",
      body: JSON.stringify({ membershipNumber }),
    });
    idInput.value = "";
    showMsg(msg, t("famLinked"), true);
    refreshFamilyAndBalance();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

// -------------------------------------------------------------- my family --
// Fixed relationship choices offered in the dropdown (stored as-is, in
// English, regardless of UI language - "Other" reveals a free-text field so
// wording that doesn't fit this list, including Arabic terms, still works).
const FAMILY_RELATIONS = ["Father", "Mother", "Husband", "Wife", "Son", "Daughter", "Brother", "Sister"];
function familyRelationSelectHtml(currentValue) {
  const isKnown = FAMILY_RELATIONS.includes(currentValue);
  const isOther = !!currentValue && !isKnown;
  const options = [`<option value="" ${!currentValue ? "selected" : ""}>${t("relSelectPlaceholder")}</option>`]
    .concat(
      FAMILY_RELATIONS.map(
        (r) => `<option value="${r}" ${currentValue === r ? "selected" : ""}>${t("rel" + r)}</option>`
      )
    )
    .concat([`<option value="other" ${isOther ? "selected" : ""}>${t("relOther")}</option>`]);
  return options.join("");
}
// Sign-up's "relationship to the main member" reuses this same fixed list
// (Father/Mother/.../Other) - populated once here since su-relationship is
// a plain <select>, not re-rendered per session like the family list below.
document.getElementById("su-relationship").innerHTML = familyRelationSelectHtml("");
function renderFamilyList() {
  const wrap = document.getElementById("mp-family-list");
  const member = CURRENT_SESSION && CURRENT_SESSION.type === "member" ? CURRENT_SESSION.member : null;
  if (!wrap || !member) return;
  const deps = member.dependents || [];
  wrap.innerHTML = deps.length
    ? deps
        .map(
          (d) => `<div class="family-item" data-dep-id="${d.id}">
        <span class="name">${escapeAttr(d.name)}${
            d.relationship ? ` <span class="fam-rel-badge">(${escapeAttr(d.relationship)})</span>` : ""
          }${d.phone || d.email ? ` <span class="fam-rel-badge">${[d.phone, d.email].filter(Boolean).map(escapeAttr).join(" · ")}</span>` : ""}</span>
        <span class="fam-rel-edit">
          <select class="fam-rel-select" data-dep-id="${d.id}">${familyRelationSelectHtml(d.relationship || "")}</select>
          <input class="fam-rel-other-input ${
            !!d.relationship && !FAMILY_RELATIONS.includes(d.relationship) ? "" : "hidden"
          }" data-dep-id="${d.id}" value="${
            !!d.relationship && !FAMILY_RELATIONS.includes(d.relationship) ? escapeAttr(d.relationship) : ""
          }" placeholder="${t("fieldRelationship")}" style="margin-top:6px;" />
          <input class="fam-phone-input" type="tel" data-dep-id="${d.id}" value="${escapeAttr(
            d.phone || ""
          )}" placeholder="${t("fieldFamilyMemberPhone")}" style="margin-top:6px;" />
          <input class="fam-email-input" type="email" data-dep-id="${d.id}" value="${escapeAttr(
            d.email || ""
          )}" placeholder="${t("fieldFamilyMemberEmail")}" style="margin-top:6px;" />
          <button class="secondary fam-rel-save" data-dep-id="${d.id}" style="margin-top:6px;padding:6px 10px;font-size:0.75rem;">${t(
            "btnSaveRelationship"
          )}</button>
        </span>
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
  // Toggle the free-text "other" field per row as its dropdown changes.
  wrap.querySelectorAll(".fam-rel-select").forEach((sel) => {
    sel.addEventListener("change", () => {
      const otherInput = wrap.querySelector(`.fam-rel-other-input[data-dep-id="${sel.dataset.depId}"]`);
      if (!otherInput) return;
      otherInput.classList.toggle("hidden", sel.value !== "other");
      if (sel.value === "other") otherInput.focus();
    });
  });
  // Lets a member identify who each family member actually is - tag (or
  // retag) the relationship on a dependent added before this feature
  // existed, without deleting and re-adding them (which would disconnect
  // them from any registrations already made in their name).
  wrap.querySelectorAll(".fam-rel-save").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const sel = wrap.querySelector(`.fam-rel-select[data-dep-id="${btn.dataset.depId}"]`);
      const otherInput = wrap.querySelector(`.fam-rel-other-input[data-dep-id="${btn.dataset.depId}"]`);
      const phoneInput = wrap.querySelector(`.fam-phone-input[data-dep-id="${btn.dataset.depId}"]`);
      const emailInput = wrap.querySelector(`.fam-email-input[data-dep-id="${btn.dataset.depId}"]`);
      const relationship = sel.value === "other" ? otherInput.value.trim() : sel.value;
      const msg = document.getElementById("fam-msg");
      try {
        const result = await api("/api/me/dependents/" + btn.dataset.depId, {
          method: "PUT",
          body: JSON.stringify({ relationship, phone: phoneInput.value.trim(), email: emailInput.value.trim() }),
        });
        CURRENT_SESSION.member.dependents = result.dependents;
        showMsg(msg, t("famRelationshipSaved"), true);
        renderFamilyList();
      } catch (e) {
        showMsg(document.getElementById("fam-msg"), e.message, false);
      }
    });
  });
}

document.getElementById("fam-relationship").addEventListener("change", (e) => {
  const otherInput = document.getElementById("fam-relationship-other");
  otherInput.classList.toggle("hidden", e.target.value !== "other");
  if (e.target.value === "other") otherInput.focus();
  else otherInput.value = "";
});

document.getElementById("fam-add").addEventListener("click", async () => {
  const nameInput = document.getElementById("fam-name");
  const relSelect = document.getElementById("fam-relationship");
  const relOtherInput = document.getElementById("fam-relationship-other");
  const phoneInput = document.getElementById("fam-phone");
  const emailInput = document.getElementById("fam-email");
  const name = nameInput.value.trim();
  const relationship = relSelect.value === "other" ? relOtherInput.value.trim() : relSelect.value;
  const msg = document.getElementById("fam-msg");
  if (!name) {
    highlightMissingFields(["fam-name"]);
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  try {
    const result = await api("/api/me/dependents", {
      method: "POST",
      body: JSON.stringify({ name, relationship, phone: phoneInput.value.trim(), email: emailInput.value.trim() }),
    });
    CURRENT_SESSION.member.dependents = result.dependents;
    nameInput.value = "";
    relSelect.value = "";
    relOtherInput.value = "";
    relOtherInput.classList.add("hidden");
    phoneInput.value = "";
    emailInput.value = "";
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
      const time = new Date(m.sentAt).toLocaleString(currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-US");
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
    highlightMissingFields([usernameId, passwordId]);
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

// ------------------------------------------------------- activity log -----
// Admin-only platform-wide audit report (see logActivity()/filterActivityLog()
// in server.js). Filters are applied server-side via query params; offset/
// limit page through the already-filtered, newest-first result set.
const ACTIVITY_LOG_STATE = { offset: 0, limit: 50, total: 0 };
function activityActionLabel(action) {
  const map = {
    member_signup: "alActionMemberSignup",
    member_login: "alActionMemberLogin",
    member_logout: "alActionMemberLogout",
    staff_login: "alActionStaffLogin",
    staff_logout: "alActionStaffLogout",
    staff_account_created: "alActionStaffAccountCreated",
    staff_account_removed: "alActionStaffAccountRemoved",
    event_created: "alActionEventCreated",
    event_edited: "alActionEventEdited",
    event_deleted: "alActionEventDeleted",
    event_registered: "alActionEventRegistered",
    event_waitlisted: "alActionEventWaitlisted",
    checkin: "alActionCheckin",
    redemption_requested: "alActionRedemptionRequested",
    redemption_status_changed: "alActionRedemptionStatusChanged",
    member_added: "alActionMemberAdded",
    members_imported: "alActionMembersImported",
    members_invited_to_event: "alActionMembersInvitedToEvent",
    family_linked: "alActionFamilyLinked",
    family_unlinked: "alActionFamilyUnlinked",
  };
  // Falls back to the raw action tag for anything not in the map yet, so a
  // newly added logActivity() call site still shows *something* readable
  // instead of silently disappearing from the report.
  const key = map[action];
  return key ? t(key) : action;
}
function activityLogQueryParams() {
  const params = new URLSearchParams();
  const q = document.getElementById("al-filter-q").value.trim();
  const actorType = document.getElementById("al-filter-type").value;
  const action = document.getElementById("al-filter-action").value;
  const from = document.getElementById("al-filter-from").value;
  const to = document.getElementById("al-filter-to").value;
  if (q) params.set("q", q);
  if (actorType) params.set("actorType", actorType);
  if (action) params.set("action", action);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return params;
}
async function loadActivityLog(resetOffset) {
  if (resetOffset) ACTIVITY_LOG_STATE.offset = 0;
  const wrap = document.getElementById("activity-log-table");
  try {
    const params = activityLogQueryParams();
    params.set("limit", ACTIVITY_LOG_STATE.limit);
    params.set("offset", ACTIVITY_LOG_STATE.offset);
    const result = await api(`/api/admin/activity-log?${params.toString()}`);
    ACTIVITY_LOG_STATE.total = result.total;
    populateActivityLogActionOptions(result.actions);
    renderActivityLogTable(result.entries);
    updateActivityLogPager(result.entries.length);
  } catch (e) {
    wrap.innerHTML = `<p class="dashboard-empty-note">${escapeAttr(e.message)}</p>`;
  }
}
function populateActivityLogActionOptions(actions) {
  const select = document.getElementById("al-filter-action");
  const current = select.value;
  select.innerHTML = [`<option value="">${escapeAttr(t("activityLogFilterActionAll"))}</option>`]
    .concat(actions.map((a) => `<option value="${escapeAttr(a)}">${escapeAttr(activityActionLabel(a))}</option>`))
    .join("");
  if (actions.includes(current)) select.value = current;
}
function renderActivityLogTable(entries) {
  const wrap = document.getElementById("activity-log-table");
  if (!entries.length) {
    wrap.innerHTML = `<p class="dashboard-empty-note">${t("activityLogEmpty")}</p>`;
    return;
  }
  const locale = currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-US";
  const body = entries
    .map((r) => {
      const time = new Date(r.at).toLocaleString(locale);
      const userType = r.actorType === "member" ? t("activityLogFilterTypeMember") : t("activityLogFilterTypeStaff");
      const userLabel = r.actorName ? `${r.actorName} (${r.actorId})` : r.actorId || "—";
      return `<tr>
        <td>${escapeAttr(time)}</td>
        <td>${escapeAttr(userType)}</td>
        <td>${escapeAttr(userLabel)}</td>
        <td>${escapeAttr(activityActionLabel(r.action))}</td>
        <td>${escapeAttr(r.details || "—")}</td>
      </tr>`;
    })
    .join("");
  wrap.innerHTML = `<div class="dashboard-table-wrap"><table class="dashboard-table">
    <thead><tr>
      <th>${t("colTime")}</th><th>${t("colUserType")}</th><th>${t("colUser")}</th><th>${t("colAction")}</th><th>${t("colDetails")}</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}
function updateActivityLogPager(currentCount) {
  const info = document.getElementById("al-page-info");
  const total = ACTIVITY_LOG_STATE.total;
  const from = total === 0 ? 0 : ACTIVITY_LOG_STATE.offset + 1;
  const to = ACTIVITY_LOG_STATE.offset + currentCount;
  info.textContent = t("activityLogPageInfo")
    .replace("{from}", fmt(from))
    .replace("{to}", fmt(to))
    .replace("{total}", fmt(total));
  document.getElementById("al-prev-page").disabled = ACTIVITY_LOG_STATE.offset <= 0;
  document.getElementById("al-next-page").disabled = ACTIVITY_LOG_STATE.offset + ACTIVITY_LOG_STATE.limit >= total;
}
document.getElementById("al-apply-filters").addEventListener("click", () => loadActivityLog(true));
document.getElementById("al-clear-filters").addEventListener("click", () => {
  document.getElementById("al-filter-q").value = "";
  document.getElementById("al-filter-type").value = "";
  document.getElementById("al-filter-action").value = "";
  document.getElementById("al-filter-from").value = "";
  document.getElementById("al-filter-to").value = "";
  loadActivityLog(true);
});
document.getElementById("al-prev-page").addEventListener("click", () => {
  ACTIVITY_LOG_STATE.offset = Math.max(0, ACTIVITY_LOG_STATE.offset - ACTIVITY_LOG_STATE.limit);
  loadActivityLog(false);
});
document.getElementById("al-next-page").addEventListener("click", () => {
  ACTIVITY_LOG_STATE.offset += ACTIVITY_LOG_STATE.limit;
  loadActivityLog(false);
});
document.getElementById("al-export-btn").addEventListener("click", () => {
  const params = activityLogQueryParams();
  window.location.href = `/api/admin/activity-log/export.xlsx?${params.toString()}`;
});

// ------------------------------------------------ management dashboard ----
// Cross-event analytics for the restricted "management" staff role (Admin
// sees it too, in its own tab - see requireStaffRole(["management"]) on the
// matching /api/admin/management/* endpoints in server.js).
function tournamentStatusLabel(status) {
  const map = {
    "team-setup": t("tournStepTeams"),
    seeding: t("tournStepSeeding"),
    groups: t("tournStepGroups"),
    knockout: t("tournStepKnockout"),
    casual: t("tournStatusCasual"),
    completed: t("tournStepCompleted"),
  };
  return map[status] || status;
}
function monthLabel(key) {
  if (key === "before") return t("mgmtBeforeTracking");
  const [y, m] = key.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-US", { year: "numeric", month: "short" });
}

// Event performance trends: which events to include is a client-side
// filter, not a server query - the dashboard already returns every event's
// row in one call, so narrowing to a chosen subset is just re-rendering
// from the same cached data. The chosen subset is remembered per-browser
// (sessionStorage, same pattern as the admin tab memory) so it survives a
// dashboard reload but not a full log-out/new-session.
const MGMT_TRENDS_STORAGE_KEY = "mgmtTrendsSelectedEvents";
let MGMT_EVENT_TRENDS_ALL = [];
let MGMT_TOURNAMENT_ROWS_ALL = [];
let MGMT_TRENDS_SELECTED_IDS = new Set();
function loadMgmtTrendsSelection() {
  try {
    const raw = sessionStorage.getItem(MGMT_TRENDS_STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : null;
  } catch (e) {
    return null; // sessionStorage unavailable - fall back to "show everything"
  }
}
function saveMgmtTrendsSelection() {
  try {
    sessionStorage.setItem(MGMT_TRENDS_STORAGE_KEY, JSON.stringify([...MGMT_TRENDS_SELECTED_IDS]));
  } catch (e) {
    /* ignore - non-fatal, selection just won't be remembered on next visit */
  }
}
function eventTrendsSectionHtml(rows, selectedIds) {
  const filterHtml = rows.length
    ? `<div class="mgmt-trend-filter" style="margin-bottom:12px;">
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
          <button type="button" class="secondary small" id="mgmt-trends-select-all">${t("mgmtSelectAllEvents")}</button>
          <button type="button" class="secondary small" id="mgmt-trends-clear-all">${t("mgmtClearEvents")}</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:4px 16px;max-height:160px;overflow-y:auto;">
          ${rows
            .map(
              (r) => `<label style="display:flex;align-items:center;gap:5px;font-size:0.85rem;white-space:nowrap;">
              <input type="checkbox" data-trend-event-id="${r.eventId}" ${selectedIds.has(r.eventId) ? "checked" : ""} />
              ${escapeAttr(eventLabel({ nameEn: r.nameEn, nameAr: r.nameAr }))} <span class="hint-note" style="display:inline;">(${escapeAttr(r.date)})</span>
            </label>`
            )
            .join("")}
        </div>
        <p class="hint-note">${t("mgmtFilterAlsoAppliesToTournaments")}</p>
      </div>`
    : "";
  const filtered = rows.filter((r) => selectedIds.has(r.eventId));
  const eventRows = filtered
    .map(
      (r) => `<tr>
      <td>${escapeAttr(eventLabel({ nameEn: r.nameEn, nameAr: r.nameAr }))}</td>
      <td>${escapeAttr(r.date)}</td>
      <td class="num">${fmt(r.confirmedCount)}</td>
      <td class="num">${fmt(r.waitlistCount)}</td>
      <td class="num">${fmt(r.checkedInCount)}</td>
      <td>${r.attendanceRate === null ? "—" : r.attendanceRate + "%"}</td>
    </tr>`
    )
    .join("");
  const tableOrEmpty = filtered.length
    ? `<div class="dashboard-table-wrap"><table class="dashboard-table">
      <thead><tr><th>${t("colEvent")}</th><th>${t("colDate")}</th><th>${t("colRegistrations")}</th><th>${t("colWaitlist")}</th><th>${t("colCheckedIn")}</th><th>${t("colAttendance")}</th></tr></thead>
      <tbody>${eventRows}</tbody>
    </table></div>`
    : `<p class="dashboard-empty-note">${t(rows.length ? "mgmtNoEventsSelected" : "noEventsYet")}</p>`;
  return `<h3>${t("mgmtEventTrends")}</h3>${filterHtml}${tableOrEmpty}`;
}
// The Tournament activity table (per-event rows only, not the four total
// tiles above it) is filtered by this exact same event selection - one
// checklist drives both tables, so narrowing down to a handful of events
// narrows both at once instead of needing two separate filters.
function tournamentActivityTableHtml(allRows, selectedIds) {
  const filtered = allRows.filter((r) => selectedIds.has(r.eventId));
  const tournRows = filtered
    .map(
      (r) => `<tr>
      <td>${escapeAttr(eventLabel({ nameEn: r.nameEn, nameAr: r.nameAr }))}</td>
      <td>${escapeAttr(r.date)}</td>
      <td>${r.mode === "team" ? t("tournamentModeTeam") : t("tournamentModeIndividual")}</td>
      <td class="num">${fmt(r.participantCount)}</td>
      <td>${escapeAttr(tournamentStatusLabel(r.status))}</td>
    </tr>`
    )
    .join("");
  return filtered.length
    ? `<div class="dashboard-table-wrap"><table class="dashboard-table">
      <thead><tr><th>${t("colEvent")}</th><th>${t("colDate")}</th><th>${t("fieldMode")}</th><th>${t("mgmtColParticipants")}</th><th>${t("colStatus")}</th></tr></thead>
      <tbody>${tournRows}</tbody>
    </table></div>`
    : `<p class="dashboard-empty-note">${t(allRows.length ? "mgmtNoEventsSelected" : "mgmtNoTournamentsYet")}</p>`;
}
function renderMgmtEventFilterViews() {
  const trendsContainer = document.getElementById("mgmt-event-trends-section");
  if (trendsContainer) {
    trendsContainer.innerHTML = eventTrendsSectionHtml(MGMT_EVENT_TRENDS_ALL, MGMT_TRENDS_SELECTED_IDS);
    trendsContainer.querySelectorAll("[data-trend-event-id]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = Number(cb.dataset.trendEventId);
        if (cb.checked) MGMT_TRENDS_SELECTED_IDS.add(id);
        else MGMT_TRENDS_SELECTED_IDS.delete(id);
        saveMgmtTrendsSelection();
        renderMgmtEventFilterViews();
      });
    });
    const selectAllBtn = document.getElementById("mgmt-trends-select-all");
    if (selectAllBtn) {
      selectAllBtn.addEventListener("click", () => {
        MGMT_TRENDS_SELECTED_IDS = new Set(MGMT_EVENT_TRENDS_ALL.map((r) => r.eventId));
        saveMgmtTrendsSelection();
        renderMgmtEventFilterViews();
      });
    }
    const clearAllBtn = document.getElementById("mgmt-trends-clear-all");
    if (clearAllBtn) {
      clearAllBtn.addEventListener("click", () => {
        MGMT_TRENDS_SELECTED_IDS = new Set();
        saveMgmtTrendsSelection();
        renderMgmtEventFilterViews();
      });
    }
  }
  const tournContainer = document.getElementById("mgmt-tournament-activity-table");
  if (tournContainer) {
    tournContainer.innerHTML = tournamentActivityTableHtml(MGMT_TOURNAMENT_ROWS_ALL, MGMT_TRENDS_SELECTED_IDS);
  }
}
async function loadManagementDashboard() {
  const wrap = document.getElementById("mgmt-dashboard-body");
  if (!wrap) return;
  try {
    const data = await api("/api/admin/management/dashboard");
    renderManagementDashboard(data);
  } catch (e) {
    wrap.innerHTML = `<p class="dashboard-empty-note">${escapeAttr(e.message)}</p>`;
  }
  loadManagementReportEventOptions();
}
function renderManagementDashboard(data) {
  const wrap = document.getElementById("mgmt-dashboard-body");
  const g = data.clubGrowth;
  const p = data.pointsActivity;
  const ta = data.tournamentActivity;

  const growthHtml = `
    <h3>${t("mgmtClubGrowth")}</h3>
    <div class="stat-row">
      <div class="stat"><div class="n">${fmt(g.totalMembers)}</div><div class="l">${t("mgmtTotalMembers")}</div></div>
      <div class="stat"><div class="n">${fmt(g.membersWithAccount)}</div><div class="l">${t("mgmtMembersWithAccount")}</div></div>
      <div class="stat"><div class="n">${fmt(g.activeCount)}</div><div class="l">${t("mgmtActiveMembers")}</div></div>
      <div class="stat"><div class="n">${fmt(g.neverRegisteredCount)}</div><div class="l">${t("mgmtNeverRegistered")}</div></div>
    </div>
    <p class="hint-note">${t("mgmtNewSignups")}: ${g.newSignupsByMonth.map((r) => `${monthLabel(r.month)} (${fmt(r.count)})`).join(" · ")}</p>`;

  // Which events show in the trends table is a client-side filter over
  // this same data - see eventTrendsSectionHtml()/renderEventTrendsSection()
  // above. Preserve whatever the user already picked (sessionStorage) if
  // this isn't the first load; default to "show everything" the first time.
  MGMT_EVENT_TRENDS_ALL = data.eventTrends;
  const storedTrendsSelection = loadMgmtTrendsSelection();
  const allTrendIds = data.eventTrends.map((r) => r.eventId);
  MGMT_TRENDS_SELECTED_IDS = storedTrendsSelection
    ? new Set(allTrendIds.filter((id) => storedTrendsSelection.has(id)))
    : new Set(allTrendIds);
  const trendsHtml = `<div id="mgmt-event-trends-section"></div>`;

  const leaderboardRows = p.leaderboard
    .map(
      (r, i) => `<tr><td>${i + 1}</td><td>${escapeAttr(r.name)} (#${escapeAttr(r.membershipNumber)})</td><td class="num">${fmt(r.balance)}</td></tr>`
    )
    .join("");
  const pointsHtml = `
    <h3>${t("mgmtPointsActivity")}</h3>
    <div class="stat-row">
      <div class="stat"><div class="n">${fmt(p.totalPointsAwarded)}</div><div class="l">${t("mgmtTotalPointsAwarded")}</div></div>
      <div class="stat"><div class="n">${fmt(p.redemptions.total)}</div><div class="l">${t("mgmtRedemptionRequests")}</div></div>
      <div class="stat"><div class="n">${fmt(p.redemptions.pending)}</div><div class="l">${t("mgmtRedemptionsPending")}</div></div>
      <div class="stat"><div class="n">${fmt(p.redemptions.fulfilled)}</div><div class="l">${t("mgmtRedemptionsFulfilled")}</div></div>
    </div>
    ${
      p.leaderboard.length
        ? `<div class="dashboard-table-wrap"><table class="dashboard-table">
      <thead><tr><th>#</th><th>${t("colMember")}</th><th>${t("colPointsBalance")}</th></tr></thead>
      <tbody>${leaderboardRows}</tbody>
    </table></div>`
        : ""
    }`;

  // Per-event rows filtered by the exact same selection as Event
  // performance trends above (see renderMgmtEventFilterViews()) - the four
  // total tiles below stay as absolute totals across every event.
  MGMT_TOURNAMENT_ROWS_ALL = ta.rows;
  const tournamentHtml = `
    <h3>${t("mgmtTournamentActivity")}</h3>
    <div class="stat-row">
      <div class="stat"><div class="n">${fmt(ta.totalTournaments)}</div><div class="l">${t("mgmtTotalTournaments")}</div></div>
      <div class="stat"><div class="n">${fmt(ta.completedCount)}</div><div class="l">${t("mgmtCompletedTournaments")}</div></div>
      <div class="stat"><div class="n">${ta.completionRate === null ? "—" : ta.completionRate + "%"}</div><div class="l">${t("mgmtCompletionRate")}</div></div>
      <div class="stat"><div class="n">${fmt(ta.totalParticipants)}</div><div class="l">${t("mgmtTotalParticipants")}</div></div>
    </div>
    <div id="mgmt-tournament-activity-table"></div>`;

  wrap.innerHTML = `${growthHtml}<hr style="margin:18px 0;border-color:var(--border);" />${trendsHtml}<hr style="margin:18px 0;border-color:var(--border);" />${pointsHtml}<hr style="margin:18px 0;border-color:var(--border);" />${tournamentHtml}`;
  renderMgmtEventFilterViews();
}

// Per-event auto-report: a picker plus the report body, with a link to
// download the same report as a Word document (see the .docx endpoint).
function loadManagementReportEventOptions() {
  const select = document.getElementById("mgmt-report-event-select");
  if (!select) return;
  const previouslySelected = select.value;
  const sorted = EVENTS_DATA.slice().sort((a, b) => b.date.localeCompare(a.date));
  select.innerHTML =
    `<option value="">${t("mgmtPickEvent")}</option>` +
    sorted.map((ev) => `<option value="${ev.id}">${escapeAttr(eventLabel(ev))} (${escapeAttr(ev.date)})</option>`).join("");
  if (previouslySelected && sorted.some((ev) => String(ev.id) === previouslySelected)) select.value = previouslySelected;
}
document.getElementById("mgmt-report-event-select").addEventListener("change", (e) => {
  const eventId = e.target.value;
  const body = document.getElementById("mgmt-report-body");
  if (!eventId) {
    body.innerHTML = "";
    return;
  }
  loadManagementReport(Number(eventId));
});
async function loadManagementReport(eventId) {
  const body = document.getElementById("mgmt-report-body");
  body.innerHTML = `<p style="color:var(--muted);">${t("loading")}</p>`;
  try {
    const r = await api(`/api/admin/management/events/${eventId}/report`);
    renderManagementReport(body, eventId, r);
  } catch (e) {
    body.innerHTML = `<p class="dashboard-empty-note">${escapeAttr(e.message)}</p>`;
  }
}
function renderManagementReport(body, eventId, r) {
  const noShowText = r.attendance.eventOver ? fmt(r.attendance.noShow) : t("mgmtNotYetOver");
  const downloadUrl = `/api/admin/management/events/${eventId}/report.docx?lang=${currentLang}`;
  body.innerHTML = `
    <h3>${escapeAttr(eventLabel({ nameEn: r.event.nameEn, nameAr: r.event.nameAr }))}</h3>
    <p class="hint-note">${escapeAttr(r.event.date)}${r.event.endDate ? " – " + escapeAttr(r.event.endDate) : ""}</p>
    <a class="secondary" href="${downloadUrl}" download><button class="secondary" type="button">${t("mgmtDownloadReport")}</button></a>

    <h4>${t("mgmtAttendanceSummary")}</h4>
    <div class="stat-row">
      <div class="stat"><div class="n">${fmt(r.attendance.confirmed)}</div><div class="l">${t("mgmtConfirmed")}</div></div>
      <div class="stat"><div class="n">${fmt(r.attendance.waitlisted)}</div><div class="l">${t("waitlistLabel")}</div></div>
      <div class="stat"><div class="n">${fmt(r.attendance.checkedIn)}</div><div class="l">${t("colCheckedIn")}</div></div>
      <div class="stat"><div class="n">${noShowText}</div><div class="l">${t("mgmtNoShows")}</div></div>
    </div>
    <p class="hint-note">${t("colAttendance")}: ${r.attendance.checkedInRate === null ? "—" : r.attendance.checkedInRate + "%"}</p>

    <h4>${t("mgmtTimingDetails")}</h4>
    <div class="stat-row">
      <div class="stat"><div class="n">${fmt(r.timing.earlyRegistrationsCount)}</div><div class="l">${t("mgmtEarlyRegs")}</div></div>
      <div class="stat"><div class="n">${r.timing.avgDaysBeforeEvent === null ? "—" : r.timing.avgDaysBeforeEvent}</div><div class="l">${t("mgmtAvgDaysBefore")}</div></div>
      <div class="stat"><div class="n">${r.timing.filledPercent === null ? "—" : r.timing.filledPercent + "%"}</div><div class="l">${t("mgmtCapacityFilled")}</div></div>
    </div>

    <h4>${t("mgmtPointsAwarded")}</h4>
    <div class="stat-row">
      <div class="stat"><div class="n">${fmt(r.points.totalAwarded)}</div><div class="l">${t("mgmtTotalPointsAwarded")}</div></div>
      <div class="stat"><div class="n">${fmt(r.points.participationTotal)}</div><div class="l">${t("mgmtParticipationPoints")}</div></div>
      <div class="stat"><div class="n">${fmt(r.points.earlyBonusTotal)}</div><div class="l">${t("mgmtEarlyBonusPoints")}</div></div>
      <div class="stat"><div class="n">${fmt(r.points.positionBonusTotal)}</div><div class="l">${t("mgmtPositionBonusPoints")}</div></div>
    </div>

    <h4>${t("mgmtTournamentResults")}</h4>
    ${
      r.tournament
        ? `<p class="hint-note">${t("mgmtWinner")}: ${escapeAttr(r.tournament.winnerLabel || t("mgmtNotDecidedYet"))} · ${t("mgmtColParticipants")}: ${fmt(r.tournament.participantCount)}</p>`
        : `<p class="dashboard-empty-note">${t("mgmtNoTournamentForEvent")}</p>`
    }`;
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
          // Member directory is admin-only - a Tournament Manager can also
          // promote from the waiting list (bundled with Event dashboard
          // access), but has no access to that tool to refresh.
          if (CURRENT_SESSION && CURRENT_SESSION.type === "staff" && CURRENT_SESSION.staff.role === "admin") loadAdminDirectory();
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
  document.getElementById("admin-hub-attendance-breakdown").innerHTML = "";
  document.getElementById("admin-hub-tournament-summary").innerHTML = `<p style="color:var(--muted);">${escapeAttr(t("loading"))}</p>`;
  document.getElementById("hub-add-member-search").value = "";
  document.getElementById("hub-add-member-results").innerHTML = "";
  document.getElementById("hub-add-member-msg").textContent = "";
  // MEMBERS_DATA normally only gets loaded when the admin visits the
  // Members tab - fetch it here too (harmless if already loaded elsewhere)
  // so "Register a member" can search the full roster right away. Skipped
  // for a Tournament Manager: that role has no access to the members list
  // or the invite endpoint "Register a member" needs, and its section of
  // this panel is hidden for them (see .admin-full-only above), so there's
  // nothing here for the extra request to serve.
  const isAdmin = CURRENT_SESSION && CURRENT_SESSION.type === "staff" && CURRENT_SESSION.staff.role === "admin";
  const loaders = [loadHubRoster(), loadHubTournamentSummary()];
  if (isAdmin) loaders.push(loadAdminMembers());
  await Promise.all(loaders);
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
    // A parent "event day" rolls up every sub-activity's own attendance into
    // one combined figure here (plus a per-activity breakdown below), so
    // checking someone in on "Foot volley" is reflected on the "Sports
    // Entertainment Day" parent's own numbers too, not just its own (usually
    // empty) direct registrations. See eventHasChildren()'s server-side
    // comment - the hierarchy is always exactly one level deep.
    const hasChildren = EVENTS_DATA.some((e) => e.parentEventId === HUB_EVENT_ID);
    const breakdownEl = document.getElementById("admin-hub-attendance-breakdown");
    if (hasChildren) {
      const rollup = await api("/api/admin/events/" + HUB_EVENT_ID + "/attendance-rollup");
      document.getElementById("admin-hub-stats").innerHTML = `
        <span class="tourn-summary-badge">${fmt(rollup.combined.confirmedCount)} ${t("colRegistrations")}</span>
        <span class="tourn-summary-badge">${fmt(rollup.combined.checkedInCount)} / ${fmt(rollup.combined.confirmedCount)} ${t("colCheckedIn")}</span>
      `;
      const rows = rollup.children
        .map(
          (c) => `<div class="waitlist-row">
            <span>${escapeAttr(eventLabel(c))}</span>
            <span class="tourn-summary-badge">${fmt(c.checkedInCount)} / ${fmt(c.confirmedCount)} ${t("colCheckedIn")}</span>
          </div>`
        )
        .join("");
      breakdownEl.innerHTML = `
        <p class="hint-note">${escapeAttr(t("hubAttendanceCombinedNote"))}</p>
        <h4 style="margin:10px 0 6px;font-size:0.82rem;text-transform:uppercase;color:var(--muted);">${escapeAttr(t("hubAttendanceByActivity"))}</h4>
        ${rows}
      `;
    } else {
      breakdownEl.innerHTML = "";
    }
  } catch (e) {
    wrap.innerHTML = `<p class="msg err show">${escapeAttr(e.message)}</p>`;
  }
}
async function loadHubTournamentSummary() {
  const wrap = document.getElementById("admin-hub-tournament-summary");
  try {
    const data = await api("/api/admin/tournaments/" + HUB_EVENT_ID);
    if (!data.tournament) {
      // "Enter results" jumps to a card a Tournament Manager doesn't have
      // access to (that's the plain manual-results tool, out of this
      // role's scope) - only offer it to the full Admin role.
      const isAdmin = CURRENT_SESSION && CURRENT_SESSION.type === "staff" && CURRENT_SESSION.staff.role === "admin";
      wrap.innerHTML = `
        <p class="hint-note">${t("hubNoTournament")}</p>
        <button class="secondary small" id="hub-goto-tournament">${t("btnSetUpTournament")}</button>
        ${isAdmin ? `<button class="secondary small" id="hub-goto-results">${t("btnEnterResults")}</button>` : ""}
      `;
    } else {
      const tn = data.tournament;
      const modeLabel = tn.mode === "team" ? t("tournamentModeTeam") : t("tournamentModeIndividual");
      const formatLabel = tournamentFormatLabel(tn.format);
      const statusLabel = tournamentActiveStatusLabel(tn);
      let standingsHtml;
      if (tn.format === "casual") {
        const presentCount = (tn.attendance || []).filter((a) => a.status === "present").length;
        standingsHtml = `<p class="hint-note">${presentCount}/${(tn.attendance || []).length} ${t("adminTournamentAttendance")}</p>`;
      } else {
        standingsHtml = tn.standings
          ? `<table><thead><tr><th>${t("colPosition")}</th><th>${t("colName")}</th></tr></thead><tbody>${tn.standings
              .map((s) => `<tr><td>${s.rank}</td><td>${escapeAttr(s.label)}</td></tr>`)
              .join("")}</tbody></table>`
          : `<p class="hint-note">${t("tournPublicNotStarted")}</p>`;
      }
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
  renderMemberAddEventDropdown();
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

// Same upcoming-events list as the bulk-invite dropdown above, but with a
// leading "don't register" option since registering the newly-added member
// for an event is optional here (unlike the bulk-invite flow, which only
// runs once members are already checked).
function renderMemberAddEventDropdown() {
  const sel = document.getElementById("member-add-event");
  const prevValue = sel.value;
  const upcoming = EVENTS_DATA.filter(isUpcoming);
  const noInviteOption = `<option value="">${t("optionNoInvite")}</option>`;
  sel.innerHTML =
    noInviteOption + upcoming.map((ev) => `<option value="${ev.id}">${eventLabel(ev)} — ${ev.date}</option>`).join("");
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

document.getElementById("member-add-btn").addEventListener("click", async () => {
  const msg = document.getElementById("member-add-msg");
  const membershipNumber = document.getElementById("member-add-number").value.trim();
  const name = document.getElementById("member-add-name").value.trim();
  const phone = document.getElementById("member-add-phone").value.trim();
  const familyGroup = document.getElementById("member-add-family").value.trim();
  const eventId = document.getElementById("member-add-event").value;
  if (!membershipNumber || !name) {
    highlightMissingFields(["member-add-number", "member-add-name"]);
    return showMsg(msg, t("pleaseFillMembershipAndName"), false);
  }
  try {
    const result = await api("/api/admin/members", {
      method: "POST",
      body: JSON.stringify({ membershipNumber, name, phone, familyGroup }),
    });
    let text = `${t("memberAddedLabel")} ${escapeAttr(result.member.name)}.`;
    // Registering the brand-new member for an event is a second, independent
    // call to the same bulk-invite endpoint the "Invite members to an event"
    // table below uses - reusing it here keeps capacity/waitlist/multi-
    // activity handling in exactly one place rather than duplicating it.
    if (eventId) {
      try {
        const inviteResult = await api(`/api/admin/events/${eventId}/invite`, {
          method: "POST",
          body: JSON.stringify({ membershipNumbers: [membershipNumber] }),
        });
        if (inviteResult.invited.length) {
          text += ` ${t("registeredForEventLabel")}.`;
        } else if (inviteResult.skipped.length) {
          text += ` ${inviteResult.skipped[0].reason}.`;
        }
      } catch (e) {
        text += ` ${t("registeredForEventFailedLabel")}: ${e.message}`;
      }
    }
    showMsg(msg, text, true);
    document.getElementById("member-add-number").value = "";
    document.getElementById("member-add-name").value = "";
    document.getElementById("member-add-phone").value = "";
    document.getElementById("member-add-family").value = "";
    document.getElementById("member-add-event").value = "";
    await loadAdminMembers();
    loadAdminDashboard();
    loadAdminOverview();
    loadAdminDirectory();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
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
    const searchBlob = escapeAttr(
      `${m.name} ${m.membershipNumber} ${m.phone} ${m.email || ""} ${m.familyGroup} ${m.relationshipToMain || ""}`.toLowerCase()
    );
    const dependentsHtml = m.dependents.length
      ? `<ul class="directory-list">${m.dependents
          .map((d) => {
            const bits = [d.relationship, d.phone, d.email].filter(Boolean).map(escapeAttr).join(" · ");
            return `<li>${escapeAttr(d.name)}${bits ? ` <span style="color:var(--muted);">(${bits})</span>` : ""}</li>`;
          })
          .join("")}</ul>`
      : `<p class="dashboard-empty-note">${t("noDependents")}</p>`;
    const regsHtml = m.registrations.length
      ? `<table class="dashboard-table"><thead><tr>
          <th>${t("colEvent")}</th><th>${t("colDate")}</th><th>${t("colStatus")}</th><th>${t("colPoints")}</th><th></th>
        </tr></thead><tbody>${m.registrations
          .map((r) => {
            const label = currentLang === "ar" ? r.nameAr || r.nameEn : r.nameEn;
            const who = r.dependentName ? ` (${escapeAttr(r.dependentName)})` : "";
            const status = r.waitlisted ? t("waitlistLabel") : r.checkedIn ? t("colCheckedIn") : t("statusRegistered");
            return `<tr><td>${escapeAttr(label)}${who}</td><td>${escapeAttr(r.date)}</td><td>${status}</td><td class="num">${fmt(r.points)}</td><td>${rosterQrCellHtml(r.qrDataUrl, `${m.membershipNumber}-${r.eventId}`)}</td></tr>`;
          })
          .join("")}</tbody></table>`
      : `<p class="dashboard-empty-note">${t("noRegistrationsYet")}</p>`;
    // Distinct from Family Members (dependents) above: these are OTHER club
    // members with their OWN account/login, pooled into this member's
    // familyGroup so their points count together (see poolingKey() in
    // server.js) while each still registers for events independently. A
    // member can link these themselves under My Family, and staff can do
    // the same here for any two (or more) existing accounts - e.g. once a
    // family member gets their own membership number and login, link it to
    // the parent's here so their points still pool.
    const poolMembers = (m.familyGroup || "").trim()
      ? DIRECTORY_DATA.filter((other) => (other.familyGroup || "").trim() === m.familyGroup.trim())
      : [];
    const linkedHtml = poolMembers.length > 1
      ? `<ul class="directory-list">${poolMembers
          .filter((p) => p.membershipNumber !== m.membershipNumber)
          .map(
            (p) =>
              `<li>${escapeAttr(p.name)} (#${escapeAttr(p.membershipNumber)}) <button class="secondary family-unlink-btn" data-me="${escapeAttr(
                m.membershipNumber
              )}" data-target="${escapeAttr(p.membershipNumber)}" style="margin-inline-start:8px;padding:2px 8px;font-size:0.72rem;">${t(
                "btnUnlink"
              )}</button></li>`
          )
          .join("")}</ul>`
      : `<p class="dashboard-empty-note">${t("noLinkedAccounts")}</p>`;
    const familyLinkHtml = `<div style="margin-top:14px;">
        <h4 style="margin:6px 0;">${t("colLinkedAccounts")}</h4>
        ${linkedHtml}
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center;">
          <input class="family-link-input" data-me="${escapeAttr(m.membershipNumber)}" placeholder="${t(
      "fieldMembership"
    )}" style="max-width:140px;padding:6px 8px;font-size:0.8rem;" />
          <button class="secondary family-link-btn" data-me="${escapeAttr(m.membershipNumber)}" style="padding:6px 10px;font-size:0.78rem;">${t(
      "btnLinkFamilyMember"
    )}</button>
        </div>
        <div class="msg family-link-msg" data-me="${escapeAttr(m.membershipNumber)}"></div>
      </div>`;
    const memberTypeBadge =
      m.memberType === "follower"
        ? ` <span class="fam-rel-badge">${t("memberTypeFollower")}${m.relationshipToMain ? ` · ${escapeAttr(m.relationshipToMain)}` : ""}</span>`
        : "";
    return `<tr data-directory-row data-search="${searchBlob}">
        <td>${escapeAttr(m.membershipNumber)}</td>
        <td>${escapeAttr(m.name)}${memberTypeBadge}</td>
        <td>${escapeAttr(m.phone)}</td>
        <td>${escapeAttr(m.email || "")}</td>
        <td>${escapeAttr(m.familyGroup)}</td>
        <td class="num">${fmt(m.balance)}</td>
        <td class="num">${fmt(m.registeredCount)}</td>
        <td class="num">${fmt(m.checkedInCount)}</td>
        <td><button class="secondary" data-directory-toggle="${i}" style="padding:3px 10px;font-size:0.78rem;">${t("btnDetails")}</button></td>
      </tr>
      <tr data-directory-row data-search="${searchBlob}" data-directory-detail="${i}" data-open="false" class="hidden">
        <td colspan="9">
          <div class="grid-2">
            <div><h4 style="margin:6px 0;">${t("colFamilyMembers")}</h4>${dependentsHtml}</div>
            <div><h4 style="margin:6px 0;">${t("colRegistrations")}</h4>${regsHtml}</div>
          </div>
          ${familyLinkHtml}
        </td>
      </tr>`;
  }).join("");
  wrap.innerHTML = `<div class="dashboard-table-wrap"><table class="dashboard-table">
    <thead><tr>
      <th>${t("colMembershipNumber")}</th><th>${t("colName")}</th><th>${t("colPhone")}</th><th>${t("colEmail")}</th>
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
  wrap.querySelectorAll(".family-link-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const me = btn.dataset.me;
      const input = wrap.querySelector(`.family-link-input[data-me="${me}"]`);
      const msg = wrap.querySelector(`.family-link-msg[data-me="${me}"]`);
      const otherId = input.value.trim();
      if (!otherId) return showMsg(msg, t("errFillFields"), false);
      try {
        await api(`/api/admin/members/${encodeURIComponent(me)}/family/link`, {
          method: "POST",
          body: JSON.stringify({ membershipNumber: otherId }),
        });
        await loadAdminDirectory();
      } catch (e) {
        showMsg(msg, e.message, false);
      }
    });
  });
  wrap.querySelectorAll(".family-unlink-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const me = btn.dataset.me;
      const target = btn.dataset.target;
      const msg = wrap.querySelector(`.family-link-msg[data-me="${me}"]`);
      if (!confirm(t("confirmUnlinkFamilyMember"))) return;
      try {
        await api(`/api/admin/members/${encodeURIComponent(me)}/family/unlink`, {
          method: "POST",
          body: JSON.stringify({ membershipNumber: target }),
        });
        await loadAdminDirectory();
      } catch (e) {
        showMsg(msg, e.message, false);
      }
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
  const videoInput = document.getElementById("ev-video");
  const whatsappQrInput = document.getElementById("ev-whatsapp-qr");
  const msg = document.getElementById("ev-msg");
  if (!nameEn || !date) {
    highlightMissingFields(["ev-name-en", "ev-date"]);
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
  if (videoInput.files[0]) fd.append("coverVideo", videoInput.files[0]);
  if (whatsappQrInput.files[0]) fd.append("whatsappQr", whatsappQrInput.files[0]);
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
    videoInput.value = "";
    whatsappQrInput.value = "";
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
  document.getElementById("ev-edit-video").value = "";
  document.getElementById("ev-edit-whatsapp-qr").value = "";
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
  const videoInput = document.getElementById("ev-edit-video");
  const whatsappQrInput = document.getElementById("ev-edit-whatsapp-qr");
  if (!eventId) return;
  if (!nameEn || !date) {
    highlightMissingFields(["ev-edit-name-en", "ev-edit-date"]);
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
  if (videoInput.files[0]) fd.append("coverVideo", videoInput.files[0]);
  if (whatsappQrInput.files[0]) fd.append("whatsappQr", whatsappQrInput.files[0]);
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
    highlightMissingFields(["news-title-en", "news-body-en"]);
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
    highlightMissingFields(["spotlight-name"]);
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

// --------------------------------------------------------------- committee --
// Fixed tier slugs the backend validates against (see COMMITTEE_TIERS in
// server.js). Unlike most static UI text, the three tiers' DISPLAY titles
// are admin-editable data (SETTINGS.committeeTierLabels, set via the
// "Section titles" form below and PUT /api/admin/committee/tier-labels) -
// not i18n keys - since this is the club's own organizational naming, which
// the admin should be able to fix directly rather than asking for a code
// change. The i18n committeeTier* keys are only a last-resort fallback for
// the brief window before SETTINGS has loaded.
const COMMITTEE_TIERS = ["top", "higher", "committee"];
function committeeTierLabel(tier) {
  const labels = SETTINGS && SETTINGS.committeeTierLabels && SETTINGS.committeeTierLabels[tier];
  if (labels) {
    const preferred = currentLang === "ar" ? labels.nameAr : labels.nameEn;
    const fallback = currentLang === "ar" ? labels.nameEn : labels.nameAr;
    if (preferred || fallback) return preferred || fallback;
  }
  return t("committeeTier" + tier.charAt(0).toUpperCase() + tier.slice(1));
}
function committeeTierSelectHtml(selected) {
  return COMMITTEE_TIERS.map((tr) => `<option value="${tr}" ${tr === selected ? "selected" : ""}>${committeeTierLabel(tr)}</option>`).join("");
}
document.getElementById("committee-tier").innerHTML = committeeTierSelectHtml(COMMITTEE_TIERS[0]);

// Admin-editable section titles (see committeeTierLabel() above for why
// these are data, not i18n) - one EN + one AR text input per tier, all
// saved together in one PUT so the three always stay in sync.
function populateCommitteeTierLabelsForm() {
  const wrap = document.getElementById("committee-tier-labels-form");
  if (!wrap) return;
  const labels = (SETTINGS && SETTINGS.committeeTierLabels) || {};
  wrap.innerHTML = COMMITTEE_TIERS.map((tier) => {
    const entry = labels[tier] || {};
    return `<div class="grid-2" style="margin-bottom:6px;">
      <div><input class="committee-tier-label-en" data-tier="${tier}" value="${escapeAttr(entry.nameEn || "")}" placeholder="${committeeTierLabel(tier)} (EN)" /></div>
      <div><input class="committee-tier-label-ar" data-tier="${tier}" dir="rtl" value="${escapeAttr(entry.nameAr || "")}" placeholder="${committeeTierLabel(tier)} (AR)" /></div>
    </div>`;
  }).join("");
}
document.getElementById("committee-tier-labels-save").addEventListener("click", async () => {
  const msg = document.getElementById("committee-tier-labels-msg");
  const wrap = document.getElementById("committee-tier-labels-form");
  const labels = {};
  COMMITTEE_TIERS.forEach((tier) => {
    labels[tier] = {
      nameEn: wrap.querySelector(`.committee-tier-label-en[data-tier="${tier}"]`).value.trim(),
      nameAr: wrap.querySelector(`.committee-tier-label-ar[data-tier="${tier}"]`).value.trim(),
    };
  });
  try {
    const result = await api("/api/admin/committee/tier-labels", { method: "PUT", body: JSON.stringify({ labels }) });
    SETTINGS.committeeTierLabels = result.committeeTierLabels;
    populateCommitteeTierLabelsForm();
    renderPublicCommittee(COMMITTEE_PUBLIC_DATA);
    renderCommitteeAdminList();
    document.getElementById("committee-tier").innerHTML = committeeTierSelectHtml(document.getElementById("committee-tier").value);
    showMsg(msg, t("committeeTierLabelsSaved"), true);
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

async function loadCommittee() {
  try {
    const members = await api("/api/committee");
    COMMITTEE_PUBLIC_DATA = members;
    renderPublicCommittee(members);
  } catch (e) {
    /* leave whatever was last rendered - a transient fetch failure here
       shouldn't blank out an already-visible public page */
  }
}
function committeeMemberCardHtml(m) {
  const name = currentLang === "ar" ? m.nameAr || m.nameEn : m.nameEn || m.nameAr;
  const title = currentLang === "ar" ? m.titleAr || m.titleEn : m.titleEn || m.titleAr;
  return `<div class="committee-card">
    ${m.photo ? `<img class="committee-photo" src="${escapeAttr(m.photo)}" alt="" />` : `<div class="committee-photo committee-photo-placeholder"></div>`}
    <div class="committee-name">${escapeAttr(name)}</div>
    ${title ? `<div class="committee-title">${escapeAttr(title)}</div>` : ""}
  </div>`;
}
function renderPublicCommittee(members) {
  const body = document.getElementById("committee-public-body");
  const empty = document.getElementById("committee-public-empty");
  if (!body) return;
  if (!members.length) {
    body.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  body.innerHTML = COMMITTEE_TIERS.map((tier) => {
    const tierMembers = members.filter((m) => m.tier === tier);
    if (!tierMembers.length) return "";
    return `<h2 class="section-title">${committeeTierLabel(tier)}</h2>
      <div class="committee-grid">${tierMembers.map(committeeMemberCardHtml).join("")}</div>`;
  }).join("");
}

// --------------------------------------------------- admin: committee --
let COMMITTEE_ADMIN_DATA = [];
async function loadCommitteeAdminList() {
  const wrap = document.getElementById("committee-admin-list");
  if (!wrap) return;
  try {
    COMMITTEE_ADMIN_DATA = await api("/api/committee");
    renderCommitteeAdminList();
  } catch (e) {
    wrap.innerHTML = "";
  }
}
function renderCommitteeAdminList() {
  const wrap = document.getElementById("committee-admin-list");
  if (!wrap) return;
  if (!COMMITTEE_ADMIN_DATA.length) {
    wrap.innerHTML = "";
    return;
  }
  wrap.innerHTML = COMMITTEE_TIERS.map((tier) => {
    const tierMembers = COMMITTEE_ADMIN_DATA.filter((m) => m.tier === tier).sort((a, b) => a.order - b.order);
    if (!tierMembers.length) return "";
    return `<h4 style="margin:10px 0 6px;">${committeeTierLabel(tier)}</h4>${tierMembers
      .map(
        (m, i) => `<div class="content-admin-item" data-id="${m.id}">
      <div style="display:flex;align-items:center;gap:8px;">
        ${m.photo ? `<img src="${escapeAttr(m.photo)}" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover;" />` : ""}
        <div>
          <div class="title">${escapeAttr(m.nameEn || m.nameAr)}</div>
          <div class="sub">${escapeAttr(m.titleEn || m.titleAr || "")}</div>
        </div>
      </div>
      <div style="display:flex;gap:4px;align-items:center;">
        <button class="secondary committee-move" data-id="${m.id}" data-dir="up" ${i === 0 ? "disabled" : ""} style="margin-top:0;padding:4px 8px;font-size:0.75rem;">&uarr;</button>
        <button class="secondary committee-move" data-id="${m.id}" data-dir="down" ${i === tierMembers.length - 1 ? "disabled" : ""} style="margin-top:0;padding:4px 8px;font-size:0.75rem;">&darr;</button>
        <button class="secondary committee-edit" data-id="${m.id}" style="margin-top:0;">${escapeAttr(t("btnEdit"))}</button>
        <button class="secondary committee-delete" data-id="${m.id}" style="margin-top:0;">${escapeAttr(t("btnRemove"))}</button>
      </div>
    </div>`
      )
      .join("")}`;
  }).join("");
  wrap.querySelectorAll(".committee-move").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api("/api/admin/committee/" + btn.dataset.id + "/move", { method: "PUT", body: JSON.stringify({ direction: btn.dataset.dir }) });
        await loadCommitteeAdminList();
        await loadCommittee();
      } catch (e) {
        /* ignore - list stays as-is if the move fails */
      }
    });
  });
  wrap.querySelectorAll(".committee-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm(t("confirmDeleteCommitteeMember"))) return;
      try {
        await api("/api/admin/committee/" + btn.dataset.id, { method: "DELETE" });
        await loadCommitteeAdminList();
        await loadCommittee();
      } catch (e) {
        /* ignore */
      }
    });
  });
  wrap.querySelectorAll(".committee-edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const m = COMMITTEE_ADMIN_DATA.find((x) => x.id === Number(btn.dataset.id));
      if (!m) return;
      document.getElementById("committee-edit-id").value = m.id;
      document.getElementById("committee-name-en").value = m.nameEn || "";
      document.getElementById("committee-name-ar").value = m.nameAr || "";
      document.getElementById("committee-title-en").value = m.titleEn || "";
      document.getElementById("committee-title-ar").value = m.titleAr || "";
      document.getElementById("committee-tier").innerHTML = committeeTierSelectHtml(m.tier);
      const previewWrap = document.getElementById("committee-photo-preview-wrap");
      const preview = document.getElementById("committee-photo-preview");
      if (m.photo) {
        preview.src = m.photo;
        previewWrap.classList.remove("hidden");
      } else {
        previewWrap.classList.add("hidden");
      }
      document.getElementById("committee-submit").textContent = t("btnSaveCommitteeMember");
      document.getElementById("committee-cancel-edit").classList.remove("hidden");
      document.getElementById("committee-name-en").scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}
function resetCommitteeForm() {
  document.getElementById("committee-edit-id").value = "";
  document.getElementById("committee-name-en").value = "";
  document.getElementById("committee-name-ar").value = "";
  document.getElementById("committee-title-en").value = "";
  document.getElementById("committee-title-ar").value = "";
  document.getElementById("committee-tier").innerHTML = committeeTierSelectHtml(COMMITTEE_TIERS[0]);
  document.getElementById("committee-photo").value = "";
  document.getElementById("committee-photo-preview-wrap").classList.add("hidden");
  document.getElementById("committee-submit").textContent = t("btnAddCommitteeMember");
  document.getElementById("committee-cancel-edit").classList.add("hidden");
}
document.getElementById("committee-cancel-edit").addEventListener("click", resetCommitteeForm);
document.getElementById("committee-submit").addEventListener("click", async () => {
  const editId = document.getElementById("committee-edit-id").value;
  const nameEn = document.getElementById("committee-name-en").value.trim();
  const nameAr = document.getElementById("committee-name-ar").value.trim();
  const titleEn = document.getElementById("committee-title-en").value.trim();
  const titleAr = document.getElementById("committee-title-ar").value.trim();
  const tier = document.getElementById("committee-tier").value;
  const photoInput = document.getElementById("committee-photo");
  const msg = document.getElementById("committee-msg");
  if (!nameEn && !nameAr) {
    highlightMissingFields(["committee-name-en"]);
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  const fd = new FormData();
  fd.append("nameEn", nameEn);
  fd.append("nameAr", nameAr);
  fd.append("titleEn", titleEn);
  fd.append("titleAr", titleAr);
  fd.append("tier", tier);
  if (photoInput.files[0]) fd.append("photo", photoInput.files[0]);
  try {
    if (editId) {
      await api("/api/admin/committee/" + editId, { method: "PUT", body: fd });
      showMsg(msg, t("committeeMemberSaved"), true);
    } else {
      await api("/api/admin/committee", { method: "POST", body: fd });
      showMsg(msg, t("committeeMemberAdded"), true);
    }
    resetCommitteeForm();
    await loadCommitteeAdminList();
    await loadCommittee();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

// ----------------------------------------------------- admin: landing page --
// Fills in the Landing Page admin tab's form fields/lists from the current
// SETTINGS.landingPage (already fetched by loadSettings()/applySettingsToUI()
// - this just puts it into the editable inputs, separate from
// applyLandingPageToUI() which renders the same data onto the public page).
function populateLandingAdminForms() {
  const lp = SETTINGS && SETTINGS.landingPage;
  if (!lp) return;
  LANDING_PAGE = lp;
  const heroHeadlineEn = document.getElementById("hero-headline-en");
  if (heroHeadlineEn) {
    heroHeadlineEn.value = lp.hero.headlineEn || "";
    document.getElementById("hero-headline-ar").value = lp.hero.headlineAr || "";
    document.getElementById("hero-tagline-en").value = lp.hero.taglineEn || "";
    document.getElementById("hero-tagline-ar").value = lp.hero.taglineAr || "";
    const heroPreview = document.getElementById("hero-photo-preview");
    const heroPreviewWrap = document.getElementById("hero-photo-preview-wrap");
    const heroRemoveBtn = document.getElementById("hero-remove-photo-btn");
    if (lp.hero.photo) {
      heroPreview.src = lp.hero.photo;
      heroPreviewWrap.classList.remove("hidden");
      heroRemoveBtn.classList.remove("hidden");
    } else {
      heroPreviewWrap.classList.add("hidden");
      heroRemoveBtn.classList.add("hidden");
    }
    const heroVideoPreview = document.getElementById("hero-video-preview");
    const heroVideoPreviewWrap = document.getElementById("hero-video-preview-wrap");
    const heroRemoveVideoBtn = document.getElementById("hero-remove-video-btn");
    if (lp.hero.video) {
      heroVideoPreview.src = lp.hero.video;
      heroVideoPreviewWrap.classList.remove("hidden");
      heroRemoveVideoBtn.classList.remove("hidden");
    } else {
      heroVideoPreview.removeAttribute("src");
      heroVideoPreviewWrap.classList.add("hidden");
      heroRemoveVideoBtn.classList.add("hidden");
    }
  }
  const aboutTitleEn = document.getElementById("about-title-en");
  if (aboutTitleEn) {
    aboutTitleEn.value = lp.about.titleEn || "";
    document.getElementById("about-title-ar").value = lp.about.titleAr || "";
    document.getElementById("about-body-en").value = lp.about.bodyEn || "";
    document.getElementById("about-body-ar").value = lp.about.bodyAr || "";
    const preview = document.getElementById("about-photo-preview");
    const previewWrap = document.getElementById("about-photo-preview-wrap");
    const removeBtn = document.getElementById("about-remove-photo-btn");
    if (lp.about.photo) {
      preview.src = lp.about.photo;
      previewWrap.classList.remove("hidden");
      removeBtn.classList.remove("hidden");
    } else {
      previewWrap.classList.add("hidden");
      removeBtn.classList.add("hidden");
    }
  }
  const whatsappTitleEn = document.getElementById("whatsapp-title-en");
  if (whatsappTitleEn) {
    whatsappTitleEn.value = lp.whatsapp.titleEn || "";
    document.getElementById("whatsapp-title-ar").value = lp.whatsapp.titleAr || "";
    document.getElementById("whatsapp-body-en").value = lp.whatsapp.bodyEn || "";
    document.getElementById("whatsapp-body-ar").value = lp.whatsapp.bodyAr || "";
    document.getElementById("whatsapp-link").value = lp.whatsapp.link || "";
    const preview = document.getElementById("whatsapp-qr-preview");
    const previewWrap = document.getElementById("whatsapp-qr-preview-wrap");
    const removeBtn = document.getElementById("whatsapp-remove-qr-btn");
    if (lp.whatsapp.qrImage) {
      preview.src = lp.whatsapp.qrImage;
      previewWrap.classList.remove("hidden");
      removeBtn.classList.remove("hidden");
    } else {
      previewWrap.classList.add("hidden");
      removeBtn.classList.add("hidden");
    }
  }
  renderLandingSectionsAdminList();
  renderGalleryAdminList(lp.gallery || []);
  renderSponsorsAdminList(lp.sponsors || []);
}

const LANDING_SECTION_LABEL_KEYS = {
  hero: "landingSecHero",
  events: "landingSecEvents",
  annual: "landingSecAnnual",
  about: "landingSecAbout",
  news: "landingSecNews",
  community: "landingSecCommunity",
  spotlight: "landingSecSpotlight",
  gallery: "landingSecGallery",
  sponsors: "landingSecSponsors",
  whatsapp: "landingSecWhatsapp",
};
// Index of the row currently being mouse-dragged, while a drag is in
// progress - shared across the drag*/drop handlers wired up below, and
// reset (via dragend, which always fires - even on a drop outside any
// valid target) so a stray leftover value can never cause a later drop to
// silently reorder from the wrong row.
let landingDragIndex = null;
function renderLandingSectionsAdminList() {
  const wrap = document.getElementById("landing-sections-list");
  if (!wrap || !LANDING_PAGE) return;
  const sections = LANDING_PAGE.sections || [];
  wrap.innerHTML = sections
    .map((s, i) => {
      const label = t(LANDING_SECTION_LABEL_KEYS[s.key] || s.key);
      return `<div class="landing-section-row" draggable="true" data-index="${i}" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
        <span class="landing-drag-handle" title="${escapeAttr(t("landingSecDragHint"))}">&#10021;</span>
        <span style="flex:1;font-size:0.9rem;">${escapeAttr(label)}</span>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;color:var(--muted);"><input type="checkbox" class="landing-sec-enabled" data-index="${i}" ${s.enabled ? "checked" : ""} /> ${escapeAttr(t("landingSecShown"))}</label>
        <button type="button" class="secondary landing-sec-up" data-index="${i}" ${i === 0 ? "disabled" : ""} style="padding:4px 10px;margin-top:0;">&uarr;</button>
        <button type="button" class="secondary landing-sec-down" data-index="${i}" ${i === sections.length - 1 ? "disabled" : ""} style="padding:4px 10px;margin-top:0;">&darr;</button>
      </div>`;
    })
    .join("");
  wrap.querySelectorAll(".landing-sec-up").forEach((btn) => {
    btn.addEventListener("click", () => moveLandingSection(Number(btn.dataset.index), -1));
  });
  wrap.querySelectorAll(".landing-sec-down").forEach((btn) => {
    btn.addEventListener("click", () => moveLandingSection(Number(btn.dataset.index), 1));
  });
  wrap.querySelectorAll(".landing-sec-enabled").forEach((cb) => {
    cb.addEventListener("change", () => toggleLandingSection(Number(cb.dataset.index), cb.checked));
  });
  // Mouse drag-to-reorder, on top of the up/down buttons above (which stay
  // for anyone on a touchscreen/keyboard, where native HTML drag-and-drop
  // doesn't work). Plain browser drag events - no library needed.
  wrap.querySelectorAll(".landing-section-row").forEach((row) => {
    row.addEventListener("dragstart", (e) => {
      landingDragIndex = Number(row.dataset.index);
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      // Firefox refuses to start a drag at all unless dataTransfer carries
      // something - the value itself is unused, the module-level
      // landingDragIndex above is what drop() actually reads.
      e.dataTransfer.setData("text/plain", String(landingDragIndex));
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      wrap.querySelectorAll(".landing-section-row").forEach((r) => r.classList.remove("drag-over"));
      landingDragIndex = null;
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault(); // required - a dragover with no preventDefault() rejects the drop
      e.dataTransfer.dropEffect = "move";
      if (Number(row.dataset.index) !== landingDragIndex) row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      const targetIndex = Number(row.dataset.index);
      if (landingDragIndex === null || landingDragIndex === targetIndex) return;
      reorderLandingSection(landingDragIndex, targetIndex);
      landingDragIndex = null;
    });
  });
}
async function saveLandingSections(sections) {
  const msg = document.getElementById("landing-sections-msg");
  try {
    const result = await api("/api/admin/landing/sections", { method: "PUT", body: JSON.stringify({ sections }) });
    SETTINGS.landingPage.sections = result.sections;
    LANDING_PAGE.sections = result.sections;
    renderLandingSectionsAdminList();
    applyLandingSectionOrder(result.sections);
  } catch (e) {
    if (msg) showMsg(msg, e.message, false);
  }
}
function moveLandingSection(index, dir) {
  const sections = LANDING_PAGE.sections.slice();
  const newIndex = index + dir;
  if (newIndex < 0 || newIndex >= sections.length) return;
  const [item] = sections.splice(index, 1);
  sections.splice(newIndex, 0, item);
  saveLandingSections(sections);
}
// Same idea as moveLandingSection above, but to an arbitrary drop target
// rather than one step up/down - used by the drag-and-drop handlers.
function reorderLandingSection(fromIndex, toIndex) {
  const sections = LANDING_PAGE.sections.slice();
  const [item] = sections.splice(fromIndex, 1);
  sections.splice(toIndex, 0, item);
  saveLandingSections(sections);
}
function toggleLandingSection(index, enabled) {
  const sections = LANDING_PAGE.sections.slice();
  sections[index] = { ...sections[index], enabled };
  saveLandingSections(sections);
}

document.getElementById("hero-save-btn").addEventListener("click", async () => {
  const msg = document.getElementById("hero-msg");
  const headlineEn = document.getElementById("hero-headline-en").value.trim();
  if (!headlineEn) {
    highlightMissingFields(["hero-headline-en"]);
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  const fd = new FormData();
  fd.append("headlineEn", headlineEn);
  fd.append("headlineAr", document.getElementById("hero-headline-ar").value.trim());
  fd.append("taglineEn", document.getElementById("hero-tagline-en").value.trim());
  fd.append("taglineAr", document.getElementById("hero-tagline-ar").value.trim());
  const fileInput = document.getElementById("hero-photo-file");
  if (fileInput.files[0]) fd.append("photo", fileInput.files[0]);
  const videoInput = document.getElementById("hero-video-file");
  if (videoInput.files[0]) fd.append("video", videoInput.files[0]);
  try {
    const result = await api("/api/admin/landing/hero", { method: "PUT", body: fd });
    SETTINGS.landingPage.hero = result.hero;
    LANDING_PAGE.hero = result.hero;
    fileInput.value = "";
    videoInput.value = "";
    populateLandingAdminForms();
    applyLandingPageToUI();
    showMsg(msg, t("settingsSaved"), true);
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});
document.getElementById("hero-remove-photo-btn").addEventListener("click", async () => {
  const msg = document.getElementById("hero-msg");
  const fd = new FormData();
  fd.append("headlineEn", document.getElementById("hero-headline-en").value.trim());
  fd.append("headlineAr", document.getElementById("hero-headline-ar").value.trim());
  fd.append("taglineEn", document.getElementById("hero-tagline-en").value.trim());
  fd.append("taglineAr", document.getElementById("hero-tagline-ar").value.trim());
  fd.append("removePhoto", "true");
  try {
    const result = await api("/api/admin/landing/hero", { method: "PUT", body: fd });
    SETTINGS.landingPage.hero = result.hero;
    LANDING_PAGE.hero = result.hero;
    populateLandingAdminForms();
    applyLandingPageToUI();
    showMsg(msg, t("settingsSaved"), true);
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});
document.getElementById("hero-remove-video-btn").addEventListener("click", async () => {
  const msg = document.getElementById("hero-msg");
  const fd = new FormData();
  fd.append("headlineEn", document.getElementById("hero-headline-en").value.trim());
  fd.append("headlineAr", document.getElementById("hero-headline-ar").value.trim());
  fd.append("taglineEn", document.getElementById("hero-tagline-en").value.trim());
  fd.append("taglineAr", document.getElementById("hero-tagline-ar").value.trim());
  fd.append("removeVideo", "true");
  try {
    const result = await api("/api/admin/landing/hero", { method: "PUT", body: fd });
    SETTINGS.landingPage.hero = result.hero;
    LANDING_PAGE.hero = result.hero;
    populateLandingAdminForms();
    applyLandingPageToUI();
    showMsg(msg, t("settingsSaved"), true);
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

document.getElementById("about-save-btn").addEventListener("click", async () => {
  const msg = document.getElementById("about-msg");
  const fd = new FormData();
  fd.append("titleEn", document.getElementById("about-title-en").value.trim());
  fd.append("titleAr", document.getElementById("about-title-ar").value.trim());
  fd.append("bodyEn", document.getElementById("about-body-en").value.trim());
  fd.append("bodyAr", document.getElementById("about-body-ar").value.trim());
  const fileInput = document.getElementById("about-photo-file");
  if (fileInput.files[0]) fd.append("photo", fileInput.files[0]);
  try {
    const result = await api("/api/admin/landing/about", { method: "PUT", body: fd });
    SETTINGS.landingPage.about = result.about;
    LANDING_PAGE.about = result.about;
    fileInput.value = "";
    populateLandingAdminForms();
    applyLandingPageToUI();
    showMsg(msg, t("settingsSaved"), true);
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

document.getElementById("whatsapp-save-btn").addEventListener("click", async () => {
  const msg = document.getElementById("whatsapp-msg");
  const fd = new FormData();
  fd.append("titleEn", document.getElementById("whatsapp-title-en").value.trim());
  fd.append("titleAr", document.getElementById("whatsapp-title-ar").value.trim());
  fd.append("bodyEn", document.getElementById("whatsapp-body-en").value.trim());
  fd.append("bodyAr", document.getElementById("whatsapp-body-ar").value.trim());
  fd.append("link", document.getElementById("whatsapp-link").value.trim());
  const fileInput = document.getElementById("whatsapp-qr-file");
  if (fileInput.files[0]) fd.append("qrImage", fileInput.files[0]);
  try {
    const result = await api("/api/admin/landing/whatsapp", { method: "PUT", body: fd });
    SETTINGS.landingPage.whatsapp = result.whatsapp;
    LANDING_PAGE.whatsapp = result.whatsapp;
    fileInput.value = "";
    populateLandingAdminForms();
    applyLandingPageToUI();
    showMsg(msg, t("settingsSaved"), true);
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});
document.getElementById("whatsapp-remove-qr-btn").addEventListener("click", async () => {
  const msg = document.getElementById("whatsapp-msg");
  const fd = new FormData();
  fd.append("titleEn", document.getElementById("whatsapp-title-en").value.trim());
  fd.append("titleAr", document.getElementById("whatsapp-title-ar").value.trim());
  fd.append("bodyEn", document.getElementById("whatsapp-body-en").value.trim());
  fd.append("bodyAr", document.getElementById("whatsapp-body-ar").value.trim());
  fd.append("link", document.getElementById("whatsapp-link").value.trim());
  fd.append("removeQrImage", "true");
  try {
    const result = await api("/api/admin/landing/whatsapp", { method: "PUT", body: fd });
    SETTINGS.landingPage.whatsapp = result.whatsapp;
    LANDING_PAGE.whatsapp = result.whatsapp;
    populateLandingAdminForms();
    applyLandingPageToUI();
    showMsg(msg, t("settingsSaved"), true);
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});
document.getElementById("about-remove-photo-btn").addEventListener("click", async () => {
  const msg = document.getElementById("about-msg");
  const fd = new FormData();
  fd.append("titleEn", document.getElementById("about-title-en").value.trim());
  fd.append("titleAr", document.getElementById("about-title-ar").value.trim());
  fd.append("bodyEn", document.getElementById("about-body-en").value.trim());
  fd.append("bodyAr", document.getElementById("about-body-ar").value.trim());
  fd.append("removePhoto", "true");
  try {
    const result = await api("/api/admin/landing/about", { method: "PUT", body: fd });
    SETTINGS.landingPage.about = result.about;
    LANDING_PAGE.about = result.about;
    populateLandingAdminForms();
    applyLandingPageToUI();
    showMsg(msg, t("settingsSaved"), true);
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

function renderGalleryAdminList(items) {
  const wrap = document.getElementById("gallery-admin-list");
  if (!wrap) return;
  if (!items.length) {
    wrap.innerHTML = "";
    return;
  }
  wrap.innerHTML = items
    .map(
      (g) => `<div class="content-admin-item" data-id="${g.id}">
      <div style="display:flex;align-items:center;gap:10px;">
        <img src="${escapeAttr(g.photo)}" alt="" style="width:52px;height:52px;object-fit:cover;object-position:center;border-radius:6px;" />
        <div class="sub">${escapeAttr(truncate(bilingual(g.captionEn, g.captionAr), 50))}</div>
      </div>
      <button class="secondary gallery-delete" data-id="${g.id}" style="margin-top:0;">${escapeAttr(t("btnRemove"))}</button>
    </div>`
    )
    .join("");
  wrap.querySelectorAll(".gallery-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm(t("confirmRemovePhoto"))) return;
      try {
        await api("/api/admin/landing/gallery/" + btn.dataset.id, { method: "DELETE" });
        SETTINGS.landingPage.gallery = (SETTINGS.landingPage.gallery || []).filter((x) => x.id !== Number(btn.dataset.id));
        LANDING_PAGE.gallery = SETTINGS.landingPage.gallery;
        renderGalleryAdminList(LANDING_PAGE.gallery);
        applyLandingPageToUI();
      } catch (e) {
        /* ignore - list stays as-is if delete fails */
      }
    });
  });
}
document.getElementById("gallery-add-btn").addEventListener("click", async () => {
  const msg = document.getElementById("gallery-msg");
  const fileInput = document.getElementById("gallery-photo-file");
  if (!fileInput.files[0]) {
    highlightMissingFields(["gallery-photo-file"]);
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  const fd = new FormData();
  fd.append("photo", fileInput.files[0]);
  fd.append("captionEn", document.getElementById("gallery-caption-en").value.trim());
  fd.append("captionAr", document.getElementById("gallery-caption-ar").value.trim());
  try {
    const item = await api("/api/admin/landing/gallery", { method: "POST", body: fd });
    SETTINGS.landingPage.gallery = [...(SETTINGS.landingPage.gallery || []), item];
    LANDING_PAGE.gallery = SETTINGS.landingPage.gallery;
    fileInput.value = "";
    document.getElementById("gallery-caption-en").value = "";
    document.getElementById("gallery-caption-ar").value = "";
    renderGalleryAdminList(LANDING_PAGE.gallery);
    applyLandingPageToUI();
    showMsg(msg, t("settingsSaved"), true);
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

function renderSponsorsAdminList(items) {
  const wrap = document.getElementById("sponsors-admin-list");
  if (!wrap) return;
  if (!items.length) {
    wrap.innerHTML = "";
    return;
  }
  wrap.innerHTML = items
    .map(
      (s) => `<div class="content-admin-item" data-id="${s.id}">
      <div style="display:flex;align-items:center;gap:10px;">
        ${s.logo ? `<img src="${escapeAttr(s.logo)}" alt="" style="width:52px;height:52px;object-fit:contain;object-position:center;border-radius:6px;" />` : ""}
        <div class="title">${escapeAttr(s.name)}</div>
      </div>
      <button class="secondary sponsor-delete" data-id="${s.id}" style="margin-top:0;">${escapeAttr(t("btnRemove"))}</button>
    </div>`
    )
    .join("");
  wrap.querySelectorAll(".sponsor-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm(t("confirmRemoveSponsor"))) return;
      try {
        await api("/api/admin/landing/sponsors/" + btn.dataset.id, { method: "DELETE" });
        SETTINGS.landingPage.sponsors = (SETTINGS.landingPage.sponsors || []).filter((x) => x.id !== Number(btn.dataset.id));
        LANDING_PAGE.sponsors = SETTINGS.landingPage.sponsors;
        renderSponsorsAdminList(LANDING_PAGE.sponsors);
        applyLandingPageToUI();
      } catch (e) {
        /* ignore - list stays as-is if delete fails */
      }
    });
  });
}
document.getElementById("sponsor-add-btn").addEventListener("click", async () => {
  const msg = document.getElementById("sponsor-msg");
  const name = document.getElementById("sponsor-name").value.trim();
  if (!name) {
    highlightMissingFields(["sponsor-name"]);
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  const fd = new FormData();
  fd.append("name", name);
  fd.append("url", document.getElementById("sponsor-url").value.trim());
  const fileInput = document.getElementById("sponsor-logo-file");
  if (fileInput.files[0]) fd.append("logo", fileInput.files[0]);
  try {
    const item = await api("/api/admin/landing/sponsors", { method: "POST", body: fd });
    SETTINGS.landingPage.sponsors = [...(SETTINGS.landingPage.sponsors || []), item];
    LANDING_PAGE.sponsors = SETTINGS.landingPage.sponsors;
    document.getElementById("sponsor-name").value = "";
    document.getElementById("sponsor-url").value = "";
    fileInput.value = "";
    renderSponsorsAdminList(LANDING_PAGE.sponsors);
    applyLandingPageToUI();
    showMsg(msg, t("settingsSaved"), true);
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
  document.getElementById("res-recap-video").value = "";
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
  const recapVideoInput = document.getElementById("res-recap-video");
  if (recapVideoInput.files[0]) fd.append("recapVideo", recapVideoInput.files[0]);
  try {
    await api("/api/events/" + eventId + "/results", { method: "POST", body: fd });
    showMsg(msg, t("recapSaved"), true);
    document.getElementById("res-recap-photos").value = "";
    recapVideoInput.value = "";
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
// Team mode, pre-generation only: toggled on by the "Edit teams" button on
// the Seeding card so the admin can get back to the per-registrant
// team-name table after already saving teams once (saving teams moves
// status straight to "seeding", so the table normally never reappears).
// Purely a client-side view flag - the PUT .../teams endpoint itself has
// always accepted being called again pre-generation, this just gives the
// UI a way back to it. Reset whenever a different tournament is loaded.
let TOURN_EDITING_TEAMS = false;
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
  else if (action === "reseed-tournament") reseedTournament();
  else if (action === "edit-teams") { TOURN_EDITING_TEAMS = true; renderTournamentBody(); }
  else if (action === "cancel-edit-teams") cancelEditTournamentTeams();
  else if (action === "group-result") recordTournamentGroupResult(btn);
  else if (action === "generate-knockout") generateTournamentKnockout();
  else if (action === "knockout-result") recordTournamentKnockoutResult(btn);
  else if (action === "award-points") awardTournamentPoints();
  else if (action === "set-attendance") setTournamentAttendance(Number(btn.dataset.registrationId), btn.dataset.status);
  else if (action === "update-schedule") updateTournamentSchedule();
  else if (action === "end-casual-session") setCasualSessionStatus("completed");
  else if (action === "reopen-casual-session") setCasualSessionStatus("casual");
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
  TOURN_EDITING_TEAMS = false;
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

// ---- Tournament page visual shell: card wrapper + icons + progress
// stepper. Purely presentational (no new endpoints/state) - groups the
// existing sections into consistently-styled cards and reorders them into
// the real operational flow an admin runs an event day in: set up the
// logistics first, sort teams/seeding, check people in as they arrive,
// then play matches and finalize standings.
const TOURN_ICON = {
  setup: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="2.6" stroke="currentColor" stroke-width="1.5"/><path d="M10 3.3v1.8M10 14.9v1.8M16.7 10h-1.8M5.1 10H3.3M14.7 5.3l-1.3 1.3M6.6 13.4l-1.3 1.3M14.7 14.7l-1.3-1.3M6.6 6.6L5.3 5.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  teams: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="7.2" cy="6.5" r="2.6" stroke="currentColor" stroke-width="1.5"/><path d="M2.3 16c.6-2.9 2.5-4.4 4.9-4.4s4.3 1.5 4.9 4.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="14.3" cy="7" r="2" stroke="currentColor" stroke-width="1.3"/><path d="M13 11.9c1.9.1 3.4 1.5 3.9 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  attendance: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="4.5" y="3.5" width="11" height="14" rx="1.4" stroke="currentColor" stroke-width="1.5"/><path d="M7.5 2.5h5v2h-5z" stroke="currentColor" stroke-width="1.3"/><path d="M7 10.5l1.8 1.8L13.5 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  live: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.3" stroke="currentColor" stroke-width="1.5"/><path d="M8.3 6.8l5 3.2-5 3.2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  standings: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.5l2.2 4.6 5 .7-3.6 3.6.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.6 5-.7L10 2.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
};
// Shared format/status badge text - a tiny helper rather than repeating the
// same ternary at every place a tournament badge is rendered (admin hub
// summary, admin tournament hero, the public list, the public detail page).
// "casual" ("just for fun", see below) is a third format alongside
// knockout/groups, and gets its own status wording while active since
// "In progress" implies matches are actually being played.
function tournamentFormatLabel(format) {
  if (format === "groups") return t("tournamentFormatGroups");
  if (format === "casual") return t("tournamentFormatCasual");
  return t("tournamentFormatKnockout");
}
// Deliberately NOT named tournamentStatusLabel - that name is already taken
// (above, ~line 2074) by the Management Dashboard's helper, which maps a raw
// status string ("team-setup"/"seeding"/.../"completed") to its stepper
// label. This one takes the whole tournament object because a casual
// session's badge also depends on its format, not just its status.
function tournamentActiveStatusLabel(tn) {
  if (tn.status === "completed") return t("tournStatusCompleted");
  if (tn.format === "casual") return t("tournStatusCasual");
  return t("tournStatusInProgress");
}
function tournCardHtml(icon, title, bodyHtml, extraClass) {
  if (!bodyHtml) return "";
  return `
    <section class="tourn-card ${extraClass || ""}">
      <div class="tourn-card-head"><span class="tourn-card-icon">${icon}</span><h4>${title}</h4></div>
      <div class="tourn-card-body">${bodyHtml}</div>
    </section>
  `;
}
// Computes the ordered list of lifecycle steps this specific tournament
// goes through (varies with mode/format - e.g. an individual/knockout
// tournament skips the Teams step and the Group Stage step entirely) and
// marks each done/active/upcoming relative to the tournament's current status.
function renderTournamentProgressStepper(tn) {
  tn = tn || TOURNAMENT_DATA;
  const steps = [];
  if (tn.mode === "team") steps.push({ key: "team-setup", label: t("tournStepTeams") });
  steps.push({ key: "seeding", label: t("tournStepSeeding") });
  if (tn.format === "groups") steps.push({ key: "groups", label: t("tournStepGroups") });
  steps.push({ key: "knockout", label: t("tournStepKnockout") });
  steps.push({ key: "completed", label: t("tournStepCompleted") });
  const curIdx = steps.findIndex((s) => s.key === tn.status);
  const pills = steps
    .map((s, i) => {
      const state = i < curIdx ? "done" : i === curIdx ? "active" : "upcoming";
      const mark = state === "done" ? "✓" : String(i + 1);
      return `<div class="tourn-step ${state}"><span class="tourn-step-dot">${mark}</span><span class="tourn-step-label">${s.label}</span></div>`;
    })
    .join('<div class="tourn-step-line"></div>');
  return `<div class="tourn-stepper">${pills}</div>`;
}

function renderTournamentBody() {
  const body = document.getElementById("tourn-body");
  if (!body) return;
  if (!TOURNAMENT_DATA) {
    body.innerHTML = renderTournamentCreateForm();
    refreshCreateSetupPreview();
    return;
  }
  if (TOURNAMENT_DATA.format === "casual") {
    renderCasualTournamentBody(body);
    return;
  }
  // Operational order, not build order: logistics (Setup & Schedule) are
  // decided first and stay editable throughout; Teams/Seeding is whichever
  // pre-generation step is active; Attendance (day-of check-in) sits right
  // before the actual matches since that's when it's actually used; Matches
  // & Scores plus the final Standings close out the flow.
  let preGenContent = "";
  if (TOURNAMENT_DATA.status === "team-setup") preGenContent = renderTournamentTeamSetup();
  else if (TOURNAMENT_DATA.status === "seeding" && TOURNAMENT_DATA.mode === "team" && TOURN_EDITING_TEAMS) preGenContent = renderTournamentTeamSetup();
  else if (TOURNAMENT_DATA.status === "seeding") preGenContent = renderTournamentSeeding();
  else if (TOURNAMENT_DATA.status === "groups" || TOURNAMENT_DATA.status === "knockout") preGenContent = renderTournamentReseedPanel();
  let liveContent = "";
  if (TOURNAMENT_DATA.status === "groups") liveContent = renderTournamentGroups();
  else if (TOURNAMENT_DATA.status === "knockout") liveContent = renderTournamentBracket();
  else if (TOURNAMENT_DATA.status === "completed") liveContent = renderTournamentBracket();
  const standingsContent = TOURNAMENT_DATA.status === "completed" ? renderTournamentStandings() : "";

  const setupCard = tournCardHtml(TOURN_ICON.setup, t("tournCardSetupTitle"), renderTournamentScheduleEditor(), "tourn-card-setup");
  const teamsCard = tournCardHtml(
    TOURN_ICON.teams,
    TOURNAMENT_DATA.status === "team-setup" ? t("tournCardTeamsTitle") : t("tournCardSeedingTitle"),
    preGenContent,
    "tourn-card-teams"
  );
  const attendanceCard = TOURNAMENT_DATA.status !== "team-setup" ? renderTournamentAttendance() : "";
  const liveCard = tournCardHtml(TOURN_ICON.live, t("tournCardLiveTitle"), liveContent, "tourn-card-live");
  const standingsCard = tournCardHtml(TOURN_ICON.standings, t("finalStandingsTitle"), standingsContent, "tourn-card-standings");

  const modeLabel = TOURNAMENT_DATA.mode === "team" ? t("tournamentModeTeam") : t("tournamentModeIndividual");
  const formatLabel = tournamentFormatLabel(TOURNAMENT_DATA.format);
  const matchesLink = TOURNAMENT_DATA.schedule
    ? `<a class="secondary small tourn-live-link" href="/matches.html?event=${TOURNAMENT_EVENT_ID}&lang=${currentLang}" target="_blank" rel="noopener">${t("btnViewLiveMatches")}</a>`
    : "";
  body.innerHTML = `
    <div class="tourn-summary tourn-hero">
      <span class="tourn-summary-badge">${escapeAttr(modeLabel)}</span>
      <span class="tourn-summary-badge">${escapeAttr(formatLabel)}</span>
      ${matchesLink}
      <button class="danger small" style="margin-inline-start:auto;" data-tourn-action="delete-tournament">${t("btnDeleteTournament")}</button>
    </div>
    ${renderTournamentProgressStepper()}
    ${setupCard}
    ${teamsCard}
    ${attendanceCard}
    ${liveCard}
    ${standingsCard}
  `;
  refreshEditSetupPreview();
}

// "Just for fun" sessions: no seeding, no generated bracket, no scores or
// standings - only entrants/teams and attendance, which is the whole point
// (a casual kickabout where people just want to show up and play, not chase
// a ranking). Deliberately its own small render path rather than threading
// "casual" through every branch of renderTournamentBody() above - the two
// have almost nothing in common past the shared team-setup step and the
// attendance card, both reused as-is below.
function renderCasualTournamentBody(body) {
  const tn = TOURNAMENT_DATA;
  const modeLabel = tn.mode === "team" ? t("tournamentModeTeam") : t("tournamentModeIndividual");
  const formatLabel = tournamentFormatLabel(tn.format);
  const statusLabel = tournamentActiveStatusLabel(tn);
  let mainContent;
  if (tn.status === "team-setup" || (tn.mode === "team" && TOURN_EDITING_TEAMS)) {
    mainContent = tournCardHtml(TOURN_ICON.teams, t("tournCardTeamsTitle"), renderTournamentTeamSetup(), "tourn-card-teams");
  } else {
    const attendanceCard = renderTournamentAttendance() ||
      `<p class="hint-note">${t("tournamentEntrantCountHint").replace("{count}", TOURNAMENT_REGISTRATIONS.length)}</p>`;
    const editTeamsBtn = tn.mode === "team" && tn.status !== "completed"
      ? `<button class="secondary small" data-tourn-action="edit-teams">${t("btnEditTeams")}</button>`
      : "";
    const toggleBtn = tn.status === "completed"
      ? `<button class="secondary small" data-tourn-action="reopen-casual-session">${t("btnReopenSession")}</button>`
      : `<button class="secondary small" data-tourn-action="end-casual-session">${t("btnEndSession")}</button>`;
    mainContent = `
      ${attendanceCard}
      <div class="tourn-summary" style="margin-top:10px;">${editTeamsBtn}${toggleBtn}</div>
    `;
  }
  body.innerHTML = `
    <div class="tourn-summary tourn-hero">
      <span class="tourn-summary-badge">${escapeAttr(modeLabel)}</span>
      <span class="tourn-summary-badge">${escapeAttr(formatLabel)}</span>
      <span class="tourn-summary-badge">${escapeAttr(statusLabel)}</span>
      <button class="danger small" style="margin-inline-start:auto;" data-tourn-action="delete-tournament">${t("btnDeleteTournament")}</button>
    </div>
    ${mainContent}
  `;
}
async function setCasualSessionStatus(status) {
  const msg = document.getElementById("tourn-msg");
  try {
    const data = await api("/api/admin/tournaments/" + TOURNAMENT_EVENT_ID + "/casual-status", {
      method: "PUT",
      body: JSON.stringify({ status }),
    });
    TOURNAMENT_DATA = data.tournament;
    showMsg(msg, status === "completed" ? t("tournSessionEnded") : t("tournSessionReopened"), true);
    renderTournamentBody();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
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
  const rowHtml = (a, num) => `
    <div class="tourn-attendance-row tourn-att-${a.status}">
      <span class="tourn-attendance-name">${num != null ? `${num}. ` : ""}${escapeAttr(a.name)}</span>
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
          ${grp.rows.map((a, i) => rowHtml(a, i + 1)).join("")}
          ${matchesBlockHtml(allMatches, grp.entrantId, TOURNAMENT_DATA.entrants)}
        </div>`
      )
      .join("");
  } else {
    body = list.map((a) => rowHtml(a) + matchesBlockHtml(allMatches, a.entrantId, TOURNAMENT_DATA.entrants)).join("");
  }
  const presentCount = list.filter((a) => a.status === "present").length;
  return tournCardHtml(
    TOURN_ICON.attendance,
    `${t("adminTournamentAttendance")} <span class="tourn-card-count">${presentCount}/${list.length}</span>`,
    body,
    "tourn-card-attendance"
  );
}
// Manage courts/matchMinutes/startTime/breakMinutes at any point, not just
// at creation - filling these in for the first time turns on scheduling,
// changing them once a group stage or bracket already exists recalculates
// every still-to-play match's court/time (results already recorded are
// untouched).
function renderTournamentScheduleEditor() {
  const s = TOURNAMENT_DATA.schedule;
  return `
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
          <option value="casual">${t("tournamentFormatCasual")}</option>
        </select>
      </div>
    </div>
    <div class="grid-2" id="tourn-group-fields" style="display:none;">
      <div><label>${t("fieldNumGroups")}</label><input id="tourn-num-groups" type="number" min="2" value="2" /></div>
      <div><label>${t("fieldAdvancePerGroup")}</label><input id="tourn-advance-per-group" type="number" min="1" value="2" /></div>
    </div>
    <p class="hint-note" id="tourn-casual-hint" style="display:none;">${t("tournCasualCreateHint")}</p>
    <div id="tourn-match-config-fields">
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
    </div>
    <button class="primary" style="margin-top:10px;" data-tourn-action="create-tournament">${t("btnCreateTournament")}</button>
  `;
}
function toggleTournamentGroupFields() {
  const format = document.getElementById("tourn-format").value;
  document.getElementById("tourn-group-fields").style.display = format === "groups" ? "grid" : "none";
  const casual = format === "casual";
  const matchConfig = document.getElementById("tourn-match-config-fields");
  if (matchConfig) matchConfig.style.display = casual ? "none" : "";
  const casualHint = document.getElementById("tourn-casual-hint");
  if (casualHint) casualHint.style.display = casual ? "" : "none";
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
  // A fun session skips all of this entirely - no matches means no courts/
  // timing/win-draw-loss points to set up.
  if (format !== "casual") {
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
  }
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
// sits out the tournament. A registrant with no partner is still a valid
// team - just give them a team name nobody else shares (e.g. their own
// name) and they'll show up as a one-person team.
// When teams already exist (TOURN_EDITING_TEAMS - see above), every input
// is prefilled with that registrant's current team name so re-saving only
// requires touching the rows that actually need to change, and a Cancel
// button returns to the seeding view without submitting anything.
function renderTournamentTeamSetup() {
  const editing = (TOURNAMENT_DATA.status === "seeding" || TOURNAMENT_DATA.status === "casual") && TOURN_EDITING_TEAMS;
  const teamNameByReg = {};
  if (editing) {
    (TOURNAMENT_DATA.teams || []).forEach((team) => {
      (team.memberIds || []).forEach((id) => { teamNameByReg[id] = team.name; });
    });
  }
  const rows = TOURNAMENT_REGISTRATIONS.map(
    (r) => `<tr>
      <td>${escapeAttr(r.label)}</td>
      <td><input type="text" class="tourn-team-name" data-reg-id="${r.id}" placeholder="${escapeAttr(t("teamNamePlaceholder"))}" value="${escapeAttr(teamNameByReg[r.id] || "")}" /></td>
    </tr>`
  ).join("");
  return `
    <p class="hint-note">${t("teamSetupHint")}</p>
    <table><thead><tr><th>${t("colName")}</th><th>${t("colTeam")}</th></tr></thead><tbody>${rows}</tbody></table>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="primary" data-tourn-action="save-teams">${t("btnSaveTeams")}</button>
      ${editing ? `<button class="secondary" data-tourn-action="cancel-edit-teams">${t("btnCancel")}</button>` : ""}
    </div>
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
    TOURN_EDITING_TEAMS = false;
    showMsg(msg, t("teamsSaved"), true);
    renderTournamentBody();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}
function cancelEditTournamentTeams() {
  TOURN_EDITING_TEAMS = false;
  renderTournamentBody();
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
        <div class="tourn-seed-label">${escapeAttr(e ? e.label : id)}${teamRosterHtml(entrants, id)}</div>
        <span class="tourn-seed-actions">
          <button class="secondary small" ${i === 0 ? "disabled" : ""} data-tourn-action="move-entrant" data-entrant-id="${escapeAttr(id)}" data-dir="-1">↑</button>
          <button class="secondary small" ${i === order.length - 1 ? "disabled" : ""} data-tourn-action="move-entrant" data-entrant-id="${escapeAttr(id)}" data-dir="1">↓</button>
        </span>
      </div>`;
    })
    .join("");
  const genLabel = TOURNAMENT_DATA.format === "groups" ? t("btnGenerateGroups") : t("btnGenerateBracket");
  const editTeamsBtn = TOURNAMENT_DATA.mode === "team"
    ? `<button class="secondary" data-tourn-action="edit-teams">${t("btnEditTeams")}</button>`
    : "";
  return `
    <p class="hint-note">${t("seedingHint")}</p>
    <div class="tourn-seed-list">${rows}</div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="secondary" data-tourn-action="randomize-seed">${t("btnRandomize")}</button>
      ${editTeamsBtn}
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

// Shown once a bracket/groups already exist (status "groups" or
// "knockout"): a read-only view of the seed order that generated it, plus a
// Reseed button that sends the tournament back to the seeding step so the
// admin can fix the order and regenerate through the same flow as before.
// Only offered here in the UI when nothing has been played yet - the server
// re-checks this too (byes don't count, see the /reseed endpoint), so this
// is just keeping the button honest rather than the actual guard.
function renderTournamentReseedPanel() {
  const entrants = TOURNAMENT_DATA.entrants;
  const order = TOURNAMENT_DATA.seedOrder;
  const rows = order
    .map((id, i) => {
      const e = entrants.find((x) => x.id === id);
      return `<div class="tourn-seed-row">
        <span class="tourn-seed-num">${i + 1}</span>
        <div class="tourn-seed-label">${escapeAttr(e ? e.label : id)}${teamRosterHtml(entrants, id)}</div>
      </div>`;
    })
    .join("");
  return `
    <p class="hint-note">${t("reseedHint")}</p>
    <div class="tourn-seed-list">${rows}</div>
    <div style="margin-top:10px;">
      <button class="secondary" data-tourn-action="reseed-tournament">${t("btnReseed")}</button>
    </div>
  `;
}
async function reseedTournament() {
  if (!confirm(t("confirmReseedTournament"))) return;
  const msg = document.getElementById("tourn-msg");
  try {
    const data = await api("/api/admin/tournaments/" + TOURNAMENT_EVENT_ID + "/reseed", { method: "POST" });
    TOURNAMENT_DATA = data.tournament;
    showMsg(msg, t("tournamentReseeded"), true);
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

// Team mode only: a numbered "1. Alice · 2. Bob" line for a team entrant,
// shown wherever that team's name appears on its own (seeding, standings,
// bracket slots, group matches, the public/big-screen/live-matches pages)
// so a team is never just a name - who's actually on it is always visible
// alongside it. Individual-mode entrants carry no separate roster (the
// entrant already IS the one player), so this renders nothing for them -
// purely additive, never changes individual-mode UI. `entrants` is
// whichever tournament's resolved entrant list is in scope (TOURNAMENT_DATA
// .entrants on the admin page, tn.entrants on the public/screen/matches
// pages), so this works identically everywhere a team name is drawn.
// Members are stored with a full name (often 3-4 words for Arabic names -
// first, father's, grandfather's, family). A team roster is meant to be a
// quick "who's on this team" glance, not a formal ID, so it shows just the
// first two words (first + second/father's name) rather than the whole
// thing.
function firstTwoNames(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).join(" ") || fullName || "";
}
function teamRosterText(entrants, entrantId) {
  const e = entrants && entrants.find((x) => x.id === entrantId);
  if (!e || !e.players || !e.players.length) return "";
  return e.players.map((p, i) => `${i + 1}. ${escapeAttr(firstTwoNames(p))}`).join(" &middot; ");
}
function teamRosterHtml(entrants, entrantId, cls) {
  const text = teamRosterText(entrants, entrantId);
  return text ? `<div class="${cls || "tourn-team-roster"}">${text}</div>` : "";
}
// Shared "TeamA vs TeamB" line for a group/knockout match, with each side's
// numbered player roster shown underneath it in team mode (nothing extra in
// individual mode, since teamRosterHtml already renders empty there). Used
// everywhere a match is shown as one inline row rather than two separate
// bracket slots (group-stage match rows, admin and public alike).
function matchTeamsLineHtml(entrants, m, extra) {
  return `<span class="tourn-match-teams">
    <span class="tourn-match-side">${escapeAttr(m.aLabel)}${teamRosterHtml(entrants, m.a)}</span>
    <span class="tourn-vs">${t("vs")}</span>
    <span class="tourn-match-side">${escapeAttr(m.bLabel)}${teamRosterHtml(entrants, m.b)}</span>
    ${extra || ""}
  </span>`;
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
function attendeeMatchLineHtml(m, entrantId, entrants) {
  const isA = m.a === entrantId;
  const opponentLabel = isA ? m.bLabel || t("tbd") : m.aLabel || t("tbd");
  const opponentId = isA ? m.b : m.a;
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
    <span class="tourn-my-match-opp">${t("vs")} ${escapeAttr(opponentLabel)}${teamRosterHtml(entrants, opponentId, "tourn-team-roster tourn-my-match-opp-roster")}</span>
    ${timeBadge}
    <span class="tourn-my-match-result">${resultBit}</span>
  </div>`;
}
// Collapsed by default (native <details> - no extra JS needed) so a long
// attendee list doesn't turn into a wall of match cards; the summary shows
// just a count until someone opens it.
function matchesBlockHtml(allMatches, entrantId, entrants) {
  const mine = allMatches.filter((m) => m.a === entrantId || m.b === entrantId);
  if (!mine.length) return "";
  return `<details class="tourn-my-matches">
    <summary>${t("attendeeMatchesLabel")} (${mine.length})</summary>
    ${mine.map((m) => attendeeMatchLineHtml(m, entrantId, entrants)).join("")}
  </details>`;
}
function renderTournamentGroups() {
  const entrants = TOURNAMENT_DATA.entrants;
  const groupsHtml = TOURNAMENT_DATA.groups
    .map((g, gi) => {
      const standingsRows = g.standings
        .map(
          (s, i) =>
            `<tr><td>${i + 1}</td><td>${escapeAttr(s.label)}${teamRosterHtml(entrants, s.entrantId)}</td><td>${s.played}</td><td>${s.wins}</td><td>${s.draws}</td><td>${s.losses}</td><td>${s.gf}</td><td>${s.ga}</td><td>${s.gd}</td><td><strong>${s.points}</strong></td></tr>`
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
              ${matchTeamsLineHtml(entrants, m, timeBadge)}
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
            ${matchTeamsLineHtml(entrants, m, timeBadge)}
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
  const entrants = TOURNAMENT_DATA.entrants;
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
            <div class="tourn-bracket-slot ${m.winnerId && m.winnerId === m.a ? "winner" : ""}">${escapeAttr(aLabel)}${teamRosterHtml(entrants, m.a)}</div>
            <div class="tourn-bracket-slot ${m.winnerId && m.winnerId === m.b ? "winner" : ""}">${escapeAttr(bLabel)}${teamRosterHtml(entrants, m.b)}</div>
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
  const entrants = TOURNAMENT_DATA.entrants;
  const rows = TOURNAMENT_DATA.standings.map((s) => `<tr><td>${s.rank}</td><td>${escapeAttr(s.label)}${teamRosterHtml(entrants, s.entrantId)}</td></tr>`).join("");
  const awardedNote = TOURNAMENT_DATA.pointsAwardedAt
    ? `<p class="hint-note">${t("pointsAwardedOn")} ${escapeAttr(new Date(TOURNAMENT_DATA.pointsAwardedAt).toLocaleString())}</p>`
    : "";
  return `
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
// Which public tournament detail (if any) is currently open, so setLang()
// can re-render it in the new language without guessing. null means the
// list view is showing instead.
let PUBLIC_TOURNAMENT_OPEN_EVENT_ID = null;
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
  PUBLIC_TOURNAMENT_OPEN_EVENT_ID = null;
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
    const formatLabel = tournamentFormatLabel(tn.format);
    const statusLabel = tournamentActiveStatusLabel(tn);
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
  PUBLIC_TOURNAMENT_OPEN_EVENT_ID = null;
  document.getElementById("tourn-public-detail").classList.add("hidden");
  document.getElementById("tourn-public-list").classList.remove("hidden");
});
async function openPublicTournament(eventId) {
  PUBLIC_TOURNAMENT_OPEN_EVENT_ID = eventId;
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
  const formatLabel = tournamentFormatLabel(tn.format);
  let notStartedHtml = "";
  let groupsCard = "";
  let bracketCard = "";
  let standingsCard = "";
  if (tn.format === "casual") {
    notStartedHtml = `<p class="hint-note">${t("tournCasualPublicHint")}</p>`;
  } else if (tn.status === "team-setup" || tn.status === "setup" || tn.status === "seeding") {
    notStartedHtml = `<p class="hint-note">${t("tournPublicNotStarted")}</p>`;
  } else if (tn.status === "groups") {
    groupsCard = tournCardHtml(TOURN_ICON.live, t("tournStepGroups"), renderPublicGroups(tn.groups, tn.entrants), "tourn-card-live");
  } else if (tn.status === "knockout") {
    bracketCard = tournCardHtml(TOURN_ICON.live, t("tournStepKnockout"), renderPublicBracket(tn.knockout, tn.entrants), "tourn-card-live");
  } else if (tn.status === "completed") {
    if (tn.format === "groups") groupsCard = tournCardHtml(TOURN_ICON.live, t("tournStepGroups"), renderPublicGroups(tn.groups, tn.entrants), "tourn-card-live");
    bracketCard = tournCardHtml(TOURN_ICON.live, t("tournStepKnockout"), renderPublicBracket(tn.knockout, tn.entrants), "tourn-card-live");
    standingsCard = tournCardHtml(TOURN_ICON.standings, t("finalStandingsTitle"), renderPublicStandings(tn.standings, tn.entrants), "tourn-card-standings");
  }
  const matchesLink = tn.schedule
    ? `<a class="secondary small tourn-live-link" href="/matches.html?event=${eventId}&lang=${currentLang}" target="_blank" rel="noopener">${t("btnViewLiveMatches")}</a>`
    : "";
  return `
    <div class="tourn-summary tourn-hero">
      ${meta ? `<h3 style="margin:0 0 6px;">${eventNameHtml(meta)}</h3>` : ""}
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
        <span class="tourn-summary-badge">${escapeAttr(modeLabel)}</span>
        <span class="tourn-summary-badge">${escapeAttr(formatLabel)}</span>
        ${matchesLink}
        ${ev ? `<button class="secondary small" id="tourn-public-view-event-btn" style="margin-inline-start:auto;">${t("btnViewEventDetails")}</button>` : ""}
      </div>
    </div>
    ${tn.format === "casual" ? "" : renderTournamentProgressStepper(tn)}
    ${notStartedHtml}
    ${groupsCard}
    ${bracketCard}
    ${standingsCard}
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
    ${matchesBlockHtml(allMatches, a.entrantId, tn.entrants)}`;
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
              (a, i) => `<div class="tourn-attendance-row tourn-att-${a.status}">
                <span class="tourn-attendance-name">${i + 1}. ${escapeAttr(a.name)}</span>
                <span class="tourn-att-status-badge">${escapeAttr(attStatusLabel(a.status))}</span>
              </div>`
            )
            .join("")}
          ${matchesBlockHtml(allMatches, grp.entrantId, tn.entrants)}
        </div>`
      )
      .join("");
  } else {
    body = list.map(rowHtml).join("");
  }
  const presentCount = list.filter((a) => a.status === "present").length;
  return tournCardHtml(
    TOURN_ICON.attendance,
    `${t("adminTournamentAttendance")} <span class="tourn-card-count">${presentCount}/${list.length}</span>`,
    body,
    "tourn-card-attendance"
  );
}
function renderPublicGroups(groups, entrants) {
  const groupsHtml = (groups || [])
    .map((g, gi) => {
      const standingsRows = g.standings
        .map(
          (s, i) =>
            `<tr><td>${i + 1}</td><td>${escapeAttr(s.label)}${teamRosterHtml(entrants, s.entrantId)}</td><td>${s.played}</td><td>${s.wins}</td><td>${s.draws}</td><td>${s.losses}</td><td>${s.gf}</td><td>${s.ga}</td><td>${s.gd}</td><td><strong>${s.points}</strong></td></tr>`
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
          return `<div class="tourn-match${m.result ? " decided" : ""}">${matchTeamsLineHtml(entrants, m, timeBadge)}<span class="tourn-match-result">${resultText}</span></div>`;
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
function renderPublicBracket(knockout, entrants) {
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
            <div class="tourn-bracket-slot ${m.winnerId && m.winnerId === m.a ? "winner" : ""}">${escapeAttr(aLabel)}${teamRosterHtml(entrants, m.a)}</div>
            <div class="tourn-bracket-slot ${m.winnerId && m.winnerId === m.b ? "winner" : ""}">${escapeAttr(bLabel)}${teamRosterHtml(entrants, m.b)}</div>
            ${footer}
          </div>`;
        })
        .join("");
      return `<div class="tourn-bracket-round"><h4>${escapeAttr(roundLabel)}</h4>${matchesHtml}</div>`;
    })
    .join("");
  return `<div class="tourn-bracket">${roundsHtml}</div>`;
}
function renderPublicStandings(standings, entrants) {
  if (!standings) return "";
  const rows = standings.map((s) => `<tr><td>${s.rank}</td><td>${escapeAttr(s.label)}${teamRosterHtml(entrants, s.entrantId)}</td></tr>`).join("");
  return `<table><thead><tr><th>${t("colPosition")}</th><th>${t("colName")}</th></tr></thead><tbody>${rows}</tbody></table>`;
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
        <td>${escapeAttr(r.member ? r.member.name : r.membershipNumber)}<br/><small style="color:var(--muted);">${t("mpCurrentBalance")}: ${fmt(r.currentBalance)}</small></td>
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
        <td>${escapeAttr(s.username)}</td>
        <td>${escapeAttr(s.name)}</td>
        <td>${
          s.role === "admin"
            ? t("roleAdmin")
            : s.role === "tournament"
            ? t("roleTournament")
            : s.role === "management"
            ? t("roleManagement")
            : t("roleStaff")
        }</td>
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
    highlightMissingFields(["sa-username", "sa-name", "sa-password"]);
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
    highlightMissingFields(["rp-membership", "rp-password"]);
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
    highlightMissingFields(["cp-old", "cp-new"]);
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

// Member-side "Change my password" (Member Profile → Account & security) -
// same endpoint as the staff cp-* card above, just a separate form/ids so
// the two surfaces don't fight over the same inputs.
document.getElementById("mp-cp-submit").addEventListener("click", async () => {
  const oldPassword = document.getElementById("mp-cp-old").value;
  const newPassword = document.getElementById("mp-cp-new").value;
  const msg = document.getElementById("mp-cp-msg");
  if (!oldPassword || !newPassword) {
    highlightMissingFields(["mp-cp-old", "mp-cp-new"]);
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
    document.getElementById("mp-cp-old").value = "";
    document.getElementById("mp-cp-new").value = "";
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

// ------------------------------------------------------------ recovery PIN --
// Lets a member or staff/admin account set (or remove) a short PIN of their
// own choosing while logged in, so they can later reset their own password
// via the "Forgot your password?" link on the sign-in screen instead of
// waiting on an admin. See /api/me/recovery-pin, /api/staff/recovery-pin,
// /api/auth/forgot-password, /api/auth/staff-forgot-password in server.js.
function renderRecoveryPinStatus(elId, hasPin) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = hasPin ? t("recoveryPinStatusSet") : t("recoveryPinStatusNotSet");
}

async function saveRecoveryPin({ passwordId, pinId, msgId, statusId, sessionKey, endpoint }) {
  const password = document.getElementById(passwordId).value;
  const pin = document.getElementById(pinId).value.trim();
  const msg = document.getElementById(msgId);
  if (!password || !pin) {
    highlightMissingFields([passwordId, pinId]);
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  if (pin.length < 6) {
    showMsg(msg, t("errRecoveryPinShort"), false);
    return;
  }
  try {
    const result = await api(endpoint, { method: "POST", body: JSON.stringify({ password, pin }) });
    if (CURRENT_SESSION && CURRENT_SESSION[sessionKey]) CURRENT_SESSION[sessionKey].hasRecoveryPin = result.hasRecoveryPin;
    renderRecoveryPinStatus(statusId, result.hasRecoveryPin);
    showMsg(msg, t("okRecoveryPinSaved"), true);
    document.getElementById(passwordId).value = "";
    document.getElementById(pinId).value = "";
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}

async function clearRecoveryPin({ passwordId, msgId, statusId, sessionKey, endpoint }) {
  const password = document.getElementById(passwordId).value;
  const msg = document.getElementById(msgId);
  if (!password) {
    highlightMissingFields([passwordId]);
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  if (!confirm(t("confirmClearRecoveryPin"))) return;
  try {
    const result = await api(endpoint, { method: "POST", body: JSON.stringify({ password, pin: "" }) });
    if (CURRENT_SESSION && CURRENT_SESSION[sessionKey]) CURRENT_SESSION[sessionKey].hasRecoveryPin = result.hasRecoveryPin;
    renderRecoveryPinStatus(statusId, result.hasRecoveryPin);
    showMsg(msg, t("okRecoveryPinCleared"), true);
    document.getElementById(passwordId).value = "";
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}

document.getElementById("mp-pin-save").addEventListener("click", () =>
  saveRecoveryPin({
    passwordId: "mp-pin-password",
    pinId: "mp-pin-new",
    msgId: "mp-pin-msg",
    statusId: "mp-recovery-pin-status",
    sessionKey: "member",
    endpoint: "/api/me/recovery-pin",
  })
);
document.getElementById("mp-pin-clear").addEventListener("click", () =>
  clearRecoveryPin({
    passwordId: "mp-pin-password",
    msgId: "mp-pin-msg",
    statusId: "mp-recovery-pin-status",
    sessionKey: "member",
    endpoint: "/api/me/recovery-pin",
  })
);
document.getElementById("staff-pin-save").addEventListener("click", () =>
  saveRecoveryPin({
    passwordId: "staff-pin-password",
    pinId: "staff-pin-new",
    msgId: "staff-pin-msg",
    statusId: "staff-recovery-pin-status",
    sessionKey: "staff",
    endpoint: "/api/staff/recovery-pin",
  })
);
document.getElementById("staff-pin-clear").addEventListener("click", () =>
  clearRecoveryPin({
    passwordId: "staff-pin-password",
    msgId: "staff-pin-msg",
    statusId: "staff-recovery-pin-status",
    sessionKey: "staff",
    endpoint: "/api/staff/recovery-pin",
  })
);

// -------------------------------------------------------------- nickname --
// A member-chosen display name (unique across the whole platform, enforced
// server-side in POST /api/me/nickname) shown instead of their real name on
// public-facing surfaces only - the community leaderboard and public
// tournament pages/big-screen/live-matches. See publicDisplayName() in
// server.js for exactly where it does and doesn't apply.
function renderNicknameStatus() {
  const el = document.getElementById("mp-nickname-status");
  if (!el) return;
  const member = CURRENT_SESSION && CURRENT_SESSION.type === "member" ? CURRENT_SESSION.member : null;
  const nickname = member && member.nickname;
  el.textContent = nickname ? `${t("nicknameStatusSet")} "${nickname}"` : t("nicknameStatusNotSet");
  const input = document.getElementById("mp-nickname-input");
  if (input && document.activeElement !== input) input.value = nickname || "";
}

document.getElementById("mp-nickname-save").addEventListener("click", async () => {
  const input = document.getElementById("mp-nickname-input");
  const msg = document.getElementById("mp-nickname-msg");
  const nickname = input.value.trim();
  if (!nickname) {
    highlightMissingFields(["mp-nickname-input"]);
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  try {
    const result = await api("/api/me/nickname", { method: "POST", body: JSON.stringify({ nickname }) });
    CURRENT_SESSION.member.nickname = result.nickname;
    renderNicknameStatus();
    showMsg(msg, t("okNicknameSaved"), true);
  } catch (e) {
    // The server's 409 "nickname taken" message is shown verbatim - it's
    // already the exact user-facing wording this feature was asked for.
    showMsg(msg, e.message, false);
  }
});

document.getElementById("mp-nickname-clear").addEventListener("click", async () => {
  const msg = document.getElementById("mp-nickname-msg");
  try {
    await api("/api/me/nickname", { method: "DELETE" });
    CURRENT_SESSION.member.nickname = "";
    document.getElementById("mp-nickname-input").value = "";
    renderNicknameStatus();
    showMsg(msg, t("okNicknameCleared"), true);
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

// --------------------------------------------------- forgot password modal --
// One shared modal for all three sign-in screens (member Register tab,
// Gate Scanner, Admin) - which endpoint it calls and which id field it asks
// for depends on which link opened it.
let FORGOT_PASSWORD_TYPE = "member";

function openForgotPasswordModal(type) {
  FORGOT_PASSWORD_TYPE = type;
  document.getElementById("fp-id").value = "";
  document.getElementById("fp-pin").value = "";
  document.getElementById("fp-new-password").value = "";
  const msg = document.getElementById("fp-msg");
  msg.textContent = "";
  msg.classList.remove("show", "ok", "err");
  const idLabel = document.getElementById("fp-id-label");
  const idInput = document.getElementById("fp-id");
  const intro = document.getElementById("fp-intro");
  if (type === "staff") {
    idLabel.setAttribute("data-i18n", "fieldUsername");
    idLabel.textContent = t("fieldUsername");
    idInput.placeholder = "";
    intro.textContent = t("forgotPasswordIntroStaff");
  } else {
    idLabel.setAttribute("data-i18n", "fieldMembership");
    idLabel.textContent = t("fieldMembership");
    idInput.placeholder = "e.g. 10234";
    intro.textContent = t("forgotPasswordIntroMember");
  }
  document.getElementById("forgot-password-modal").classList.remove("hidden");
}
function closeForgotPasswordModal() {
  document.getElementById("forgot-password-modal").classList.add("hidden");
}
document.getElementById("forgot-password-modal-close").addEventListener("click", closeForgotPasswordModal);
document.getElementById("li-forgot-link").addEventListener("click", (e) => {
  e.preventDefault();
  openForgotPasswordModal("member");
});
document.getElementById("scan-forgot-link").addEventListener("click", (e) => {
  e.preventDefault();
  openForgotPasswordModal("staff");
});
document.getElementById("admin-forgot-link").addEventListener("click", (e) => {
  e.preventDefault();
  openForgotPasswordModal("staff");
});

document.getElementById("fp-submit").addEventListener("click", async () => {
  const id = document.getElementById("fp-id").value.trim();
  const pin = document.getElementById("fp-pin").value;
  const newPassword = document.getElementById("fp-new-password").value;
  const msg = document.getElementById("fp-msg");
  if (!id || !pin || !newPassword) {
    highlightMissingFields(["fp-id", "fp-pin", "fp-new-password"]);
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  if (newPassword.length < 6) {
    showMsg(msg, t("errPasswordShort"), false);
    return;
  }
  try {
    if (FORGOT_PASSWORD_TYPE === "staff") {
      const result = await api("/api/auth/staff-forgot-password", {
        method: "POST",
        body: JSON.stringify({ username: id, pin, newPassword }),
      });
      CURRENT_SESSION = { type: "staff", staff: result.staff };
    } else {
      const result = await api("/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ membershipNumber: id, pin, newPassword }),
      });
      CURRENT_SESSION = { type: "member", member: result.member };
    }
    SESSION_EXPIRY_HANDLED = false;
    showMsg(msg, t("okPasswordReset"), true);
    updateUIForSession();
    setTimeout(closeForgotPasswordModal, 1200);
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
      headers: { "Content-Type": "application/json", "X-CSRF-Token": getCsrfToken() },
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
        <td>${rosterQrCellHtml(r.qrDataUrl, r.registrationId)}</td>
        <td>${action}</td>
      </tr>`;
    })
    .join("")}</tbody></table>`;
}
// Small QR thumbnail + a Download link, shown next to a roster row whenever
// the backend decided this registration's QR is still worth showing (not
// checked in, not waitlisted, event not over - see the server's roster/
// directory endpoints). Lets staff/admin resend a code to someone who
// missed it at the gate without needing a real "send" mechanism this app
// doesn't have (no email/SMS infra) - they download the image here and
// share it however they normally would.
function rosterQrCellHtml(qrDataUrl, downloadKey) {
  if (!qrDataUrl) return "";
  return `<div class="roster-qr">
    <img src="${qrDataUrl}" alt="QR" class="roster-qr-thumb" />
    <a class="roster-qr-download" href="${qrDataUrl}" download="qr-${escapeAttr(String(downloadKey))}.png">${t("btnDownloadQr")}</a>
  </div>`;
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
