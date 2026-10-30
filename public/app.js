// build: 2026-09-25T07:02:00Z (deploy-staleness test)
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
// Option text that tells two same-named events apart: date, time range and how
// many people are registered / waiting in each.
function eventChooserLabel(ev) {
  const time = ev.startTime ? ` ${ev.startTime}${ev.endTime ? "–" + ev.endTime : ""}` : "";
  const counts = ev.confirmedCount !== undefined ? ` · ${t("dupBadgeRegs").replace("{c}", fmt(ev.confirmedCount || 0)).replace("{w}", fmt(ev.waitlistCount || 0))}` : "";
  const by = ev.createdByName ? ` · ${t("createdByLabel")}: ${ev.createdByName}${ev.createdAtIso ? " " + ev.createdAtIso.slice(0, 10) : ""}` : "";
  return `${eventLabel(ev)} — ${ev.date}${time}${counts}${by}${isPastEvent(ev) ? ` — ${t("eventPast")}` : ""}`;
}
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
// Shared ordering for every event-picker dropdown that lists more than one
// event: whichever event is most relevant right now should be first (and
// so the browser's default selection), not whatever happens to be first in
// storage order. Upcoming events always sort before past ones, soonest
// upcoming first; past events (where a chooser includes them at all, e.g.
// Tournament or Enter results) sort most-recent-first after that, so an
// admin opening any of these dropdowns lands on the next event by default.
function sortEventsForChooser(events) {
  return events.slice().sort((a, b) => {
    const aUp = isUpcoming(a);
    const bUp = isUpcoming(b);
    if (aUp !== bUp) return aUp ? -1 : 1;
    return aUp ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
  });
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
    loadInquiriesList();
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
  const isAdmin = CURRENT_SESSION && CURRENT_SESSION.type === "staff" && ["admin", "tournament"].includes(CURRENT_SESSION.staff.role);
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
  setQrHowtoLang(lang === "ar" ? "ar" : "en");
  renderEventDropdowns();
  renderEventsGrid();
  renderRegisterEventsGrid();
  renderAnnualGrid();
  renderLandingAnnualPreview();
  renderFeaturedEvents();
  renderHeroUpcoming();
  if (CURRENT_SESSION && CURRENT_SESSION.type === "staff" && CURRENT_SESSION.staff.role === "partner") loadPartnerEvents();
  renderNewsList(NEWS_DATA);
  renderSpotlightGrid(SPOTLIGHTS_DATA);
  // Committee page/admin list are both built with t() at render time (tier
  // labels), same reasoning as renderFamilyList()/renderTournamentBody()
  // below - re-render from the already-fetched data rather than re-fetching.
  renderPublicCommittee(COMMITTEE_PUBLIC_DATA);
  renderCommitteeAdminList();
  renderReports();
  renderAgeReportBuilder();
  if (RB && RB.meta) rbEnsure().catch(() => {});
  if (typeof BD !== "undefined" && BD.items.length) { bdLabelMonths(); bdRender(); }
  // Rosters are built with t() at render time - redraw them in the new language
  try {
    if (CHECKIN_ROSTER && CHECKIN_ROSTER.length) renderCheckinRoster();
    if (HUB_ROSTER && HUB_ROSTER.length && HUB_EVENT_ID) document.getElementById("hub-checkin-search").dispatchEvent(new Event("input"));
  } catch (e) {
    /* roster not mounted yet */
  }
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
    // Nickname/age-group status lines are plain textContent set with t() at
    // render time (not data-i18n markup), so without this they'd keep
    // showing whichever language they were last rendered in after a
    // language toggle, same gap as renderFamilyList() above.
    renderNicknameStatus();
    renderAgeGroupStatus();
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
    if (document.querySelector('[data-admin-panel="points"]:not(.hidden)')) loadPointsStart();
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
  const isMember = CURRENT_SESSION && CURRENT_SESSION.type === "member";
  // Members get the same gate when the committee issued them a temporary
  // password (Admin > Member directory > Send login details).
  const mustChange = !!((isStaff && CURRENT_SESSION.staff.mustChangePassword) || (isMember && CURRENT_SESSION.member && CURRENT_SESSION.member.mustChangePassword));
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
// First-login date-of-birth confirmation. Non-dismissible: it stays open until
// the server confirms (POST /api/me/birth-date/confirm). The date shown is the
// one on file (typed at sign-up or loaded by the committee), editable.
let BIRTH_GATE_OPEN = false;
function applyMaybeShowBirthConfirmGate() {
  const member = CURRENT_SESSION && CURRENT_SESSION.type === "member" ? CURRENT_SESSION.member : null;
  const need = !!(member && !member.birthConfirmedAt);
  const modal = document.getElementById("birth-confirm-modal");
  if (!modal) return;
  if (need) {
    if (!BIRTH_GATE_OPEN) {
      BIRTH_GATE_OPEN = true;
      document.getElementById("bc-birthdate").value = member.birthDate || "";
      document.getElementById("bc-check").checked = false;
      document.getElementById("bc-msg").classList.remove("show");
      updateBirthConfirmPreview();
      modal.classList.remove("hidden");
    }
  } else if (BIRTH_GATE_OPEN) {
    BIRTH_GATE_OPEN = false;
    modal.classList.add("hidden");
  }
}
function updateBirthConfirmPreview() {
  const v = document.getElementById("bc-birthdate").value;
  const el = document.getElementById("bc-preview");
  if (!v || v > todayISO() || v < "1900-01-01") { el.textContent = ""; return; }
  el.textContent = bornAgeText({ birthDate: v });
}
document.getElementById("bc-birthdate").addEventListener("input", updateBirthConfirmPreview);
document.getElementById("bc-submit").addEventListener("click", async () => {
  const msg = document.getElementById("bc-msg");
  const birthDate = document.getElementById("bc-birthdate").value;
  if (!birthDate) {
    highlightMissingFields(["bc-birthdate"]);
    return showMsg(msg, t("errBirthDateRequired"), false);
  }
  if (birthDate > todayISO() || birthDate < "1900-01-01") return showMsg(msg, t("errBirthDateInvalid"), false);
  if (!document.getElementById("bc-check").checked) return showMsg(msg, t("bcNeedCheck"), false);
  try {
    const result = await api("/api/me/birth-date/confirm", { method: "POST", body: JSON.stringify({ birthDate }) });
    if (CURRENT_SESSION && CURRENT_SESSION.type === "member" && result.member) CURRENT_SESSION.member = result.member;
    applyMaybeShowBirthConfirmGate();
    renderAgeGroupStatus();
  } catch (err) {
    showMsg(msg, err.message, false);
  }
});
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
    if (CURRENT_SESSION && CURRENT_SESSION.type === "member") {
      if (result.member) CURRENT_SESSION.member = result.member;
      else if (CURRENT_SESSION.member) CURRENT_SESSION.member.mustChangePassword = false;
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
// The uploaded WhatsApp image is a QR with a caption and wide white margins.
// Find the QR itself (jsQR) and crop to it, so the code fills the same box and
// is as large as possible. If it can't be found the image is shown as it is.
function fitHeroQr(img) {
  if (img.classList.contains("fitted") || String(img.src).startsWith("data:") || typeof jsQR !== "function") return;
  try {
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) return;
    const scale = Math.min(1, 1000 / Math.max(nw, nh));
    const w = Math.round(nw * scale), h = Math.round(nh * scale);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" });
    if (!code) return;
    const pts = [code.location.topLeftCorner, code.location.topRightCorner, code.location.bottomLeftCorner, code.location.bottomRightCorner];
    const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
    const side = Math.max(maxX - minX, maxY - minY) * 1.14; // small quiet zone around the code
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const out = document.createElement("canvas");
    out.width = out.height = 420;
    const octx = out.getContext("2d");
    octx.fillStyle = "#fff";
    octx.fillRect(0, 0, 420, 420);
    octx.imageSmoothingEnabled = false;
    octx.drawImage(c, cx - side / 2, cy - side / 2, side, side, 0, 0, 420, 420);
    // Gold code: dark modules become deep gold, white stays warm white. It is
    // only used if the recoloured code still decodes, so it can never break scanning.
    const px = octx.getImageData(0, 0, 420, 420);
    const gold = px.data.slice();
    const G = [150, 112, 6], W0 = [255, 252, 242];
    for (let i = 0; i < gold.length; i += 4) {
      const lum = (0.299 * gold[i] + 0.587 * gold[i + 1] + 0.114 * gold[i + 2]) / 255;
      const k = Math.min(1, Math.max(0, (lum - 0.15) / 0.7));
      for (let ch = 0; ch < 3; ch++) gold[i + ch] = Math.round(G[ch] + (W0[ch] - G[ch]) * k);
    }
    if (jsQR(gold, 420, 420, { inversionAttempts: "dontInvert" })) {
      octx.putImageData(new ImageData(gold, 420, 420), 0, 0);
      img.classList.add("gold");
    }
    img.classList.add("fitted");
    img.src = out.toDataURL("image/png");
  } catch (e) { /* tainted or unreadable image: keep the original */ }
}
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
  // Same community QR, repeated inside the landing-page hero so members see
  // it on the very first screen. Shown whenever a QR image or invite link is
  // set, independent of the lower "WhatsApp" section's on/off switch.
  const heroWaCard = document.getElementById("hero-wa-card");
  if (heroWaCard) {
    const heroQr = document.getElementById("hero-wa-qr");
    const heroQrLink = document.getElementById("hero-wa-qr-link");
    const heroLink = document.getElementById("hero-wa-link");
    const hasQr = !!lp.whatsapp.qrImage;
    const hasLink = !!lp.whatsapp.link;
    heroWaCard.classList.toggle("hidden", !hasQr && !hasLink);
    document.getElementById("hero-wa-title").textContent = bilingual(lp.whatsapp.titleEn, lp.whatsapp.titleAr) || t("whatsappCommunityTitle");
    if (hasQr) {
      heroQr.classList.remove("fitted");
      heroQr.onload = () => fitHeroQr(heroQr);
      heroQr.src = lp.whatsapp.qrImage;
      heroQrLink.href = lp.whatsapp.qrImage;
    }
    heroQrLink.classList.toggle("hidden", !hasQr);
    if (hasLink) heroLink.href = lp.whatsapp.link;
    heroLink.classList.toggle("hidden", !hasLink);
  }
  renderMpWhatsappCard();

  const contactTitleEl = document.getElementById("landing-contact-title");
  const contactBodyEl = document.getElementById("landing-contact-body");
  const contact = lp.contact || {};
  if (contactTitleEl) contactTitleEl.textContent = bilingual(contact.titleEn, contact.titleAr) || t("contactCommunityTitle");
  if (contactBodyEl) contactBodyEl.textContent = bilingual(contact.bodyEn, contact.bodyAr);

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

// Public "Contact the Committee" form on the landing page - no login
// required (unlike the Member Profile chat card), so this just posts a
// one-way message and clears the form on success rather than opening any
// kind of thread.
const contactSubmitBtn = document.getElementById("contact-submit");
if (contactSubmitBtn) {
  contactSubmitBtn.addEventListener("click", async () => {
    const msg = document.getElementById("contact-msg");
    const nameInput = document.getElementById("contact-name");
    const phoneInput = document.getElementById("contact-phone");
    const emailInput = document.getElementById("contact-email");
    const messageInput = document.getElementById("contact-message");
    const name = nameInput.value.trim();
    const phone = phoneInput.value.trim();
    const email = emailInput.value.trim();
    const message = messageInput.value.trim();
    if (!name || !message) {
      highlightMissingFields(["contact-name", "contact-message"]);
      showMsg(msg, t("errFillFields"), false);
      return;
    }
    if (!phone && !email) {
      showMsg(msg, t("contactFormHint"), false);
      return;
    }
    contactSubmitBtn.disabled = true;
    try {
      await api("/api/public/inquiries", { method: "POST", body: JSON.stringify({ name, phone, email, message }) });
      nameInput.value = "";
      phoneInput.value = "";
      emailInput.value = "";
      messageInput.value = "";
      showMsg(msg, t("inquirySent"), true);
    } catch (e) {
      showMsg(msg, e.message || t("inquirySendError"), false);
    } finally {
      contactSubmitBtn.disabled = false;
    }
  });
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
  await refreshStaffEventScope();
}
// Event assignments (managedByMe / managerUsernames) depend on who is signed in,
// so the event list is fetched again once a staff session is known.
async function refreshStaffEventScope() {
  // Gate staff and Tournament Managers mostly need the people still to arrive:
  // open their rosters on "Not checked in" (the chips switch it back).
  if (CURRENT_SESSION && CURRENT_SESSION.type === "staff" && ["staff", "tournament"].includes(CURRENT_SESSION.staff.role)) {
    ROSTER_FILTER = "pending";
  }
  if (CURRENT_SESSION && CURRENT_SESSION.type === "staff" && ["admin", "tournament"].includes(CURRENT_SESSION.staff.role)) {
    try {
      await loadEvents();
    } catch (e) {
      /* keep the public list */
    }
    if (CURRENT_SESSION.staff.role === "admin") loadEventManagerChoices();
  }
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
      CURRENT_SESSION.staff.role === "management" ? t("roleManagementShort") :
      CURRENT_SESSION.staff.role === "partner" ? t("rolePartnerShort") : t("roleStaffShort");
    text.textContent = `${t("sessionAsStaff")} ${CURRENT_SESSION.staff.name} (${roleLabel})`;
  }
}

function updateUIForSession() {
  updateSessionBadge();
  renderAgeReminder();
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
  // Partner: read-only account that only sees who checked in to the events an
  // admin assigned to it (see requireStaffRole(["partner"]) in server.js).
  const isPartnerRole = isStaff && CURRENT_SESSION.staff.role === "partner";
  const isAdminAreaVisible = isAdmin || isTournamentRole || isManagementRole || isPartnerRole;
  // A partner has no use for the gate scanner.
  const scanTabBtn = document.querySelector('.tab-btn[data-view="scan"]');
  if (scanTabBtn) scanTabBtn.classList.toggle("hidden", isPartnerRole);
  document.querySelectorAll(".partner-tab-only").forEach((el) => el.classList.toggle("hidden", !isPartnerRole));

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
  document.getElementById("mp-agegroup-card").classList.toggle("hidden", !isMember);
  document.getElementById("mp-phone-card").classList.toggle("hidden", !isMember);
  document.getElementById("mp-family-card").classList.toggle("hidden", !isMember);
  document.getElementById("mp-registrations-card").classList.toggle("hidden", !isMember);
  document.getElementById("mp-chat-card").classList.toggle("hidden", !isMember);
  document.getElementById("mp-security-card").classList.toggle("hidden", !isMember);
  renderMpWhatsappCard();
  if (isMember) {
    renderRecoveryPinStatus("mp-recovery-pin-status", CURRENT_SESSION.member.hasRecoveryPin);
    renderNicknameStatus();
    renderAgeGroupStatus();
    renderMyPhoneInput();
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
  document.querySelectorAll(".evt-tab-only").forEach((el) => el.classList.toggle("hidden", (isManagementRole || isPartnerRole) && !isAdmin));
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
    if (isPartnerRole) {
      // Signing in happens on the Gate Scanner tab, which a partner doesn't
      // get - move them to the Admin tab where their attendee list lives.
      const activeView = document.querySelector(".tab-btn.active");
      if (activeView && activeView.dataset.view === "scan") switchTab("admin");
      switchAdminTab("partner");
      loadPartnerEvents();
    } else if (isManagementRole && !isAdmin) {
      switchAdminTab("management");
      loadManagementDashboard();
    } else {
      loadAdminDashboard();
    }
    if (isTournamentRole) {
      // Tournament Managers handle member chat + public enquiries too.
      loadChatThreadsList();
      loadInquiriesList();
      updateAdminChatBadge();
    }
    if (isAdmin) {
      loadManagementDashboard();
      loadAdminOverview();
      loadActivityLog(true);
      loadAdminMembers();
      loadAdminDirectory();
      loadRedemptionsTable();
      loadStaffAccountsTable();
      populateStaffCommitteePicker();
      loadRulesForEdit();
      renderLadderEdit();
      loadChatThreadsList();
      loadInquiriesList();
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
  applyMaybeShowBirthConfirmGate();

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
// A Tournament Manager only works with the events assigned to them (the server
// sets managedByMe and enforces the same rule); admins and other roles see all.
function isTournamentManagerSession() {
  return !!(CURRENT_SESSION && CURRENT_SESSION.type === "staff" && CURRENT_SESSION.staff.role === "tournament");
}
function managerScoped(list) {
  return isTournamentManagerSession() ? list.filter((ev) => ev.managedByMe) : list;
}
function renderEventDropdowns() {
  // Members can only register for events that haven't happened yet. Full
  // events stay in the list (not hidden) - selecting one still works, it
  // just leads to a waiting-list offer instead of an instant confirmed spot.
  // Parent "event day" wrappers with activities under them are excluded -
  // there's nothing to directly register for on the parent itself.
  const upcoming = sortEventsForChooser(EVENTS_DATA.filter(isUpcoming));
  const regOpts = upcoming
    .filter((ev) => !isParentEventWithChildren(ev))
    .map(
      (ev) =>
        `<option value="${ev.id}">${escapeAttr(eventLabel(ev))} — ${ev.date}${isEventFull(ev) ? " — " + t("badgeFull") : ""}</option>`
    )
    .join("");
  const regSel = document.getElementById("reg-event");
  const prevRegValue = regSel.value;
  regSel.innerHTML = regOpts || `<option value="">--</option>`;
  if (prevRegValue && Array.from(regSel.options).some((o) => o.value === prevRegValue)) regSel.value = prevRegValue;
  updateRegCapacityNote();
  updateRegSelectedEventLabel();

  const upcomingOpts = managerScoped(upcoming).map((ev) => `<option value="${ev.id}">${escapeAttr(eventLabel(ev))} — ${ev.date}</option>`).join("");

  // Admins need every event (including past ones) to enter results - the
  // soonest upcoming one first, so the dropdown defaults to what's actually
  // next instead of an arbitrary past event (see sortEventsForChooser).
  const allOpts = sortEventsForChooser(managerScoped(EVENTS_DATA))
    .map((ev) => `<option value="${ev.id}">${escapeAttr(eventLabel(ev))} — ${ev.date}</option>`)
    .join("");
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
      .map((ev) => `<option value="${ev.id}">${escapeAttr(eventChooserLabel(ev))}</option>`)
      .join("");
    deleteSel.innerHTML = deleteOpts || `<option value="">--</option>`;
    if (prevDeleteValue && Array.from(deleteSel.options).some((o) => o.value === prevDeleteValue)) {
      deleteSel.value = prevDeleteValue;
    }
    // Same list (with times and registration counts, so two events with the
    // same name can be told apart) feeds the "merge duplicate events" card.
    for (const id of ["ev-merge-from", "ev-merge-to"]) {
      const el = document.getElementById(id);
      if (!el) continue;
      const prev = el.value;
      el.innerHTML = deleteOpts || `<option value="">--</option>`;
      if (prev && Array.from(el.options).some((o) => o.value === prev)) el.value = prev;
    }
  }

  // Tournament: any event that isn't itself a parent-with-children (which
  // has no direct registrations of its own to run a tournament from),
  // upcoming or past - soonest upcoming event first (see
  // sortEventsForChooser), so this defaults to the next event rather than
  // whichever event happens to sort first in storage.
  const tournSel = document.getElementById("tourn-event-select");
  if (tournSel) {
    const prevTournValue = tournSel.value;
    const tournOpts = sortEventsForChooser(managerScoped(EVENTS_DATA).filter((ev) => !isParentEventWithChildren(ev)))
      .map((ev) => `<option value="${ev.id}">${escapeAttr(eventLabel(ev))} — ${ev.date}</option>`)
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
    const checkinOpts = managerScoped(EVENTS_DATA).filter((ev) => !isParentEventWithChildren(ev))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((ev) => `<option value="${ev.id}">${escapeAttr(eventLabel(ev))} — ${ev.date}</option>`)
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
    sortEventsForChooser(EVENTS_DATA.filter((ev) => !ev.parentEventId && ev.id !== excludeEventId))
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
  updateRegCategoryVisibility();
});

// ------------------------------------------------------ events landing page --
// Small helper shared by the event cards and the Register dropdown: is this
// event at/over its admin-set maximum? (null maxCapacity = no limit.)
function isEventFull(ev) {
  return ev.maxCapacity != null && (ev.confirmedCount || 0) >= ev.maxCapacity;
}
// "Waiting list: 3" - shown next to the capacity badge, and inside the
// "event is full" note, whenever somebody is on the waiting list.
function waitlistCountBadgeHtml(ev) {
  const n = Number(ev.waitlistCount) || 0;
  return n > 0 ? `<span class="capacity-badge waitlist">${escapeAttr(t("waitlistLabel"))}: ${fmt(n)}</span>` : "";
}
function eventFullNoteHtml(ev, withCount) {
  const n = Number(ev.waitlistCount) || 0;
  const count = withCount !== false && n > 0 ? ` <strong>${escapeAttr(t("waitlistLabel"))}: ${fmt(n)}</strong>` : "";
  return `<p class="event-full-note">${escapeAttr(t("eventFullWaitlistNote"))}${count}</p>`;
}
function capacityBadgeHtml(ev) {
  if (ev.maxCapacity == null) return "";
  if (isEventFull(ev)) {
    return `<span class="capacity-badge full">${escapeAttr(t("badgeFull"))}</span>${waitlistCountBadgeHtml(ev)}`;
  }
  return `<span class="capacity-badge ok">${fmt(ev.confirmedCount || 0)}/${fmt(ev.maxCapacity)}</span>${waitlistCountBadgeHtml(ev)}`;
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
  // The cover is a real <img> (not a CSS background) so the frame takes the
  // picture's own proportions: a wide banner with text on it shows full-width
  // and readable instead of a small strip inside a fixed 16:10 box.
  return `
    <div class="event-card${isParent ? " event-card-parent" : ""}" data-event-id="${ev.id}">
      <div class="photo${photo ? " has-img" : ""}" data-action="details">${
        photo ? `<img src="${escapeAttr(photo)}" alt="" loading="lazy" />` : escapeAttr(t("noPhoto"))
      }</div>
      <div class="body">
        ${featured ? `<span class="featured-tag">${escapeAttr(t("featuredEventsTitle"))}</span>` : ""}
        <h3 data-action="details">${eventNameHtml(ev)}</h3>
        <div class="meta">${escapeAttr(eventDateTimeLabel(ev))}${ev.sport ? " · " + escapeAttr(ev.sport) : ""} ${
    isParent ? "" : capacityBadgeHtml(ev)
  }</div>
        <div class="snippet">${eventCardDescHtml(ev, isPast, 110)}</div>
        ${!isPast && !isParent && isEventFull(ev) ? eventFullNoteHtml(ev, false) : ""}
        ${
          isParent
            ? `<div class="activities-list"><div class="activities-title">${escapeAttr(
                t("activitiesTitle")
              )}</div>${activityRowsHtml(children, isPast)}</div>`
            : ""
        }
        <div class="actions">
          <button class="secondary" data-action="details">${t("btnMoreDetails")}</button>
          ${isPast || isParent ? "" : `<button class="primary" data-action="register">${t(isEventFull(ev) ? "btnJoinWaitlistCard" : "btnRegisterCard")}</button>`}
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
const FEATURED_EVENTS_COUNT = 3;
function renderEventsGrid() {
  const grid = document.getElementById("events-grid");
  const empty = document.getElementById("events-empty");
  if (!grid) return;
  // Sub-activities never get their own top-level card - they render nested
  // inside their parent event day's card instead.
  const upcoming = EVENTS_DATA.filter((ev) => isUpcoming(ev) && !ev.parentEventId).sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  // The soonest FEATURED_EVENTS_COUNT already appear in "Coming up next"
  // above, so this section lists only the rest instead of repeating them.
  const rest = upcoming.slice(FEATURED_EVENTS_COUNT);
  empty.classList.toggle("hidden", upcoming.length > 0);
  const title = document.getElementById("all-events-title");
  if (title) title.classList.toggle("hidden", rest.length === 0 && upcoming.length > 0);
  grid.innerHTML = rest.map((ev) => eventCardHtml(ev, false)).join("");
  wireEventCardButtons(grid, rest, false);
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
  const featured = upcoming.slice(0, FEATURED_EVENTS_COUNT);
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
        ? `${isEventFull(ev) ? eventFullNoteHtml(ev) : ""}<p style="color:var(--muted);font-size:0.85rem;">${t("goToRegisterHint")}</p><button class="primary" id="modal-register-btn" style="width:100%;">${t(isEventFull(ev) ? "btnJoinWaitlistCard" : "btnRegisterCard")}</button>`
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
        <div class="name">${escapeAttr(ladderLabel(tier))}</div>
        <div class="desc">${escapeAttr(ladderDesc(tier))}</div>
      </div>
      <div class="approver">${escapeAttr(ladderApprover(tier))}</div>
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
        ? `${fmt(tier.pointsRequired)} — ${escapeAttr(ladderLabel(tier))}`
        : `${fmt(tier.pointsRequired)} — ${escapeAttr(ladderLabel(tier))} (${fmt(tier.pointsRequired - balance)} ${t("tierPointsNeededSuffix")})`;
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
  const claimCode = document.getElementById("su-claimcode").value.trim();
  const birthDate = document.getElementById("su-birthdate").value;
  const email = document.getElementById("su-email").value.trim();
  const agreeTerms = document.getElementById("su-agree-terms").checked;
  const memberType = document.getElementById("su-type-follower").checked ? "follower" : "main";
  const relSel = document.getElementById("su-relationship").value;
  const relationshipToMain = memberType === "follower" ? (relSel === "other" ? document.getElementById("su-relationship-other").value.trim() : relSel) : "";
  const msg = document.getElementById("su-msg");
  if (!membershipNumber || !name || !password || !phone) {
    highlightMissingFields(["su-membership", "su-name", "su-password", "su-phone"]);
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  if (!birthDate) {
    highlightMissingFields(["su-birthdate"]);
    showMsg(msg, t("errBirthDateRequired"), false);
    return;
  }
  if (birthDate > todayISO() || birthDate < "1900-01-01") {
    highlightMissingFields(["su-birthdate"]);
    showMsg(msg, t("errBirthDateInvalid"), false);
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
      body: JSON.stringify({ membershipNumber, name, password, familyGroup, phone, claimCode, birthDate, email, agreeTerms, memberType, relationshipToMain }),
    });
    CURRENT_SESSION = { type: "member", member: result.member };
    SESSION_EXPIRY_HANDLED = false;
    document.getElementById("su-password").value = "";
    document.getElementById("su-claimcode").value = "";
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
      ${swissCatBoxesHtml("self", false, false, 'data-att="self"')}
    </div>`,
    ...deps.map(
      (d) => `<div class="attendee-row">
      <input type="checkbox" class="att-dep" id="att-dep-${d.id}" data-dep-id="${d.id}" data-dep-name="${escapeAttr(d.name)}" />
      <label for="att-dep-${d.id}">${escapeAttr(d.name)}</label>
      ${swissCatBoxesHtml("dep", false, false, `data-att="${d.id}"`)}
    </div>`
    ),
  ];
  wrap.innerHTML = rows.join("") + `<p class="hint-note hidden" id="reg-cat-note">${escapeAttr(t("regCatNote"))}</p>`;
  updateRegCategoryVisibility();
}

// Points might be hidden from members right now (admin toggle) - when so,
// suppress the "(+N points)" clause everywhere it would normally appear
// rather than showing a number for a system members can't otherwise see.
function pointsAwardedSuffix(points) {
  return pointsVisible() ? ` (+${fmt(points)} ${escapeAttr(t("scanPointsAwarded"))})` : "";
}
function renderQrList(entries) {
  const wrap = document.getElementById("reg-qr-list");
  const waBtn = document.getElementById("reg-wa-committee");
  if (waBtn) {
    const href = committeeWaHref(entries.map((e) => e.label).filter(Boolean).join(" / "));
    waBtn.classList.toggle("hidden", !href);
    if (href) waBtn.setAttribute("href", href);
  }
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

  const catFor = (key) => ({
    women: !!document.querySelector(`#reg-attendees-list .att-cat[data-att="${key}"][data-cat="women"]:checked`),
    junior: !!document.querySelector(`#reg-attendees-list .att-cat[data-att="${key}"][data-cat="junior"]:checked`),
  });
  const attendees = [];
  if (selfChecked) attendees.push({ dependentId: null, label: member.name, cats: catFor("self") });
  depChecked.forEach((d) => attendees.push({ dependentId: d.id, label: d.name, cats: catFor(String(d.id)) }));

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
      if (att.cats) { body.women = att.cats.women; body.junior = att.cats.junior; }
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
          } <span class="fam-rel-badge ${d.birthDate ? "" : "fam-age-missing"}">${d.birthDate ? escapeAttr(ageGroupLabel(effectiveAgeGroup(d)) + " · " + bornAgeText(d)) : escapeAttr(t("famBirthMissing"))}</span>${d.phone || d.email ? ` <span class="fam-rel-badge">${[d.phone, d.email].filter(Boolean).map(escapeAttr).join(" · ")}</span>` : ""}</span>
        <span class="fam-rel-edit">
          <select class="fam-rel-select" data-dep-id="${d.id}">${familyRelationSelectHtml(d.relationship || "")}</select>
          <input class="fam-birth-input" type="date" data-dep-id="${d.id}" value="${escapeAttr(d.birthDate || "")}" min="1900-01-01" max="${todayISO()}" title="${escapeAttr(t("fieldBirthDateRequired"))}" style="margin-top:6px;" />
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
      const birthInput = wrap.querySelector(`.fam-birth-input[data-dep-id="${btn.dataset.depId}"]`);
      const relationship = sel.value === "other" ? otherInput.value.trim() : sel.value;
      const msg = document.getElementById("fam-msg");
      const payload = { relationship, phone: phoneInput.value.trim(), email: emailInput.value.trim() };
      if (birthInput && birthInput.value) {
        if (birthInput.value > todayISO() || birthInput.value < "1900-01-01") return showMsg(msg, t("errBirthDateInvalid"), false);
        payload.birthDate = birthInput.value;
      }
      try {
        const result = await api("/api/me/dependents/" + btn.dataset.depId, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        CURRENT_SESSION.member.dependents = result.dependents;
        renderAgeReminder();
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
  const birthInputEl = document.getElementById("fam-birthdate");
  const name = nameInput.value.trim();
  const relationship = relSelect.value === "other" ? relOtherInput.value.trim() : relSelect.value;
  const msg = document.getElementById("fam-msg");
  if (!name) {
    highlightMissingFields(["fam-name"]);
    showMsg(msg, t("errFillFields"), false);
    return;
  }
  if (!birthInputEl.value) {
    highlightMissingFields(["fam-birthdate"]);
    showMsg(msg, t("errFamilyBirthDateRequired"), false);
    return;
  }
  if (birthInputEl.value > todayISO() || birthInputEl.value < "1900-01-01") {
    highlightMissingFields(["fam-birthdate"]);
    showMsg(msg, t("errBirthDateInvalid"), false);
    return;
  }
  try {
    const result = await api("/api/me/dependents", {
      method: "POST",
      body: JSON.stringify({ name, relationship, phone: phoneInput.value.trim(), email: emailInput.value.trim(), birthDate: birthInputEl.value }),
    });
    CURRENT_SESSION.member.dependents = result.dependents;
    renderAgeReminder();
    birthInputEl.value = "";
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
          <div class="myreg-actions">
            ${!finished && committeeWaHref(`${attendee} — ${r.event ? bilingual(r.event.nameEn, r.event.nameAr) : ""} (${evDate})`) ? `<a class="roster-btn wa small committee-wa" href="${escapeAttr(committeeWaHref(`${attendee} — ${r.event ? bilingual(r.event.nameEn, r.event.nameAr) : ""} (${evDate})`))}" target="_blank" rel="noopener">${escapeAttr(t("btnMessageCommitteeWaShort"))}</a>` : ""}
            <button type="button" class="danger small myreg-cancel-btn" data-reg-id="${r.id}">${escapeAttr(t("btnCancelRegistration"))}</button>
          </div>
        </div>
        ${r.rankingCategories && !r.waitlisted ? `<div class="my-reg-cats" data-reg-id="${r.id}">
          <strong>${escapeAttr(t("regCatTitle"))}:</strong>
          <label class="reg-cat"><input type="checkbox" class="myreg-cat" data-reg-id="${r.id}" data-cat="women" ${r.catWomen ? "checked" : ""} ${r.categoriesLocked ? "disabled" : ""} /> ${escapeAttr(t("regCatWomen"))}</label>
          <label class="reg-cat"><input type="checkbox" class="myreg-cat" data-reg-id="${r.id}" data-cat="junior" ${r.catJunior ? "checked" : ""} ${r.categoriesLocked ? "disabled" : ""} /> ${escapeAttr(t("regCatJunior"))}</label>
          <span class="myreg-cat-msg hint-note" style="margin:0;">${r.categoriesLocked ? escapeAttr(t("myregCatLocked")) : ""}</span>
        </div>` : ""}
        ${canViewQr ? `<div class="qr-entry" id="myreg-qr-${r.id}"><h4>${escapeAttr(t("qrTitle"))}</h4><img src="${r.qrDataUrl}" alt="QR code" /><p class="note">${escapeAttr(t("qrReminderNote"))}</p></div>` : ""}`;
      })
      .join("");
    wrap.querySelectorAll(".myreg-cancel-btn").forEach((btn) => {
      btn.addEventListener("click", () => cancelMyRegistration(Number(btn.dataset.regId)));
    });
    wrap.querySelectorAll(".myreg-cat").forEach((box) => {
      box.addEventListener("change", async () => {
        const regId = box.dataset.regId;
        const row = box.closest(".my-reg-cats");
        const women = row.querySelector('[data-cat="women"]').checked;
        const junior = row.querySelector('[data-cat="junior"]').checked;
        const msgEl = row.querySelector(".myreg-cat-msg");
        try {
          await api("/api/me/registrations/" + regId + "/categories", { method: "PUT", body: JSON.stringify({ women, junior }) });
          msgEl.textContent = t("myregCatSaved");
        } catch (e) {
          msgEl.textContent = e.message;
        }
      });
    });
  } catch (e) {
    wrap.innerHTML = `<p style="color:var(--muted);font-size:0.85rem;">${t("errGeneric")}</p>`;
  }
}

// Self-service cancellation - see DELETE /api/me/registrations/:id in
// server.js for the rules (allowed any time, even after check-in; blocked
// only if this event's tournament bracket has already been generated). No
// separate confirm-then-choose-waitlist flow is needed here since the
// server itself decides whether a freed confirmed spot gets auto-handed to
// the next person waiting - the member just gets told if that happened.
async function cancelMyRegistration(regId) {
  if (!confirm(t("confirmCancelRegistration"))) return;
  try {
    const result = await api("/api/me/registrations/" + regId, { method: "DELETE" });
    await loadMyRegistrations();
    await loadMyBalance();
    if (result.promoted) alert(t("cancelRegistrationPromotedNote"));
  } catch (e) {
    alert(e.message);
  }
}

// --------------------------------------------------------------- support chat --
// Renders one thread (member view or an admin's open thread) as chat
// bubbles. `mineSender` is "member" when rendering a member's own view of
// their thread, or "staff" when rendering an admin's view of a member's
// thread - whichever sender value counts as "my" message gets the "mine"
// bubble style.
function renderChatBubbles(containerId, messages, mineSender, opts) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  const editable = !!(opts && opts.editable);
  const editingId = opts && opts.editingId;
  if (!messages.length) {
    wrap.innerHTML = `<div class="chat-empty">${escapeAttr(t("chatEmpty"))}</div>`;
    return;
  }
  wrap.innerHTML = messages
    .map((m) => {
      const mine = m.sender === mineSender;
      const time = new Date(m.sentAt).toLocaleString(currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-US");
      const editedTag = m.editedAt ? `<span class="edited-tag">(${escapeAttr(t("editedTag"))})</span>` : "";
      if (editable && mine && m.id === editingId) {
        return `<div class="chat-bubble mine chat-edit-box" style="width:78%;">
          <textarea id="chat-edit-input" rows="2">${escapeAttr(m.text)}</textarea>
          <div class="chat-edit-actions">
            <button type="button" class="secondary" data-chat-edit-save="${m.id}">${escapeAttr(t("btnSaveEdit"))}</button>
            <button type="button" class="secondary" data-chat-edit-cancel="1">${escapeAttr(t("btnCancel"))}</button>
          </div>
        </div>`;
      }
      const editLink = editable && mine ? `<button type="button" class="chat-edit-link" data-chat-edit="${m.id}">${escapeAttr(t("btnEdit"))}</button>` : "";
      return `<div class="chat-bubble ${mine ? "mine" : "theirs"}">
        <div class="text">${escapeAttr(m.text)}</div>
        <div class="meta">${escapeAttr(m.senderName)} · ${escapeAttr(time)}${editedTag}${editLink}</div>
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
  if (!CURRENT_SESSION || CURRENT_SESSION.type !== "staff" || !["admin", "tournament"].includes(CURRENT_SESSION.staff.role)) return;
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
  ADMIN_CHAT_EDIT_ID = null;
  document.getElementById("chat-thread-panel").classList.remove("hidden");
  const thread = CHAT_THREADS_CACHE.find((th) => th.membershipNumber === membershipNumber);
  document.getElementById("chat-thread-panel-title").textContent = thread
    ? `${thread.memberName} (#${thread.membershipNumber})`
    : membershipNumber;
  await refreshOpenAdminChatThread();
  loadChatThreadsList();
}
let ADMIN_CHAT_MESSAGES = [];
let ADMIN_CHAT_EDIT_ID = null;
document.getElementById("admin-chat-thread").addEventListener("click", async (e) => {
  const rerender = () => renderChatBubbles("admin-chat-thread", ADMIN_CHAT_MESSAGES, "staff", { editable: true, editingId: ADMIN_CHAT_EDIT_ID });
  const editBtn = e.target.closest("[data-chat-edit]");
  if (editBtn) {
    ADMIN_CHAT_EDIT_ID = Number(editBtn.dataset.chatEdit);
    rerender();
    const inp = document.getElementById("chat-edit-input");
    if (inp) inp.focus();
    return;
  }
  if (e.target.closest("[data-chat-edit-cancel]")) {
    ADMIN_CHAT_EDIT_ID = null;
    rerender();
    return;
  }
  const saveBtn = e.target.closest("[data-chat-edit-save]");
  if (saveBtn) {
    const text = document.getElementById("chat-edit-input").value.trim();
    const msg = document.getElementById("admin-chat-msg");
    if (!text) return showMsg(msg, t("errReplyEmpty"), false);
    saveBtn.disabled = true;
    try {
      await api(`/api/staff/chats/${encodeURIComponent(ADMIN_CHAT_OPEN_MEMBERSHIP)}/messages/${saveBtn.dataset.chatEditSave}`, {
        method: "PUT",
        body: JSON.stringify({ text }),
      });
      ADMIN_CHAT_EDIT_ID = null;
      await refreshOpenAdminChatThread();
    } catch (err) {
      showMsg(msg, err.message, false);
      saveBtn.disabled = false;
    }
  }
});
async function refreshOpenAdminChatThread() {
  if (!ADMIN_CHAT_OPEN_MEMBERSHIP) return;
  try {
    const messages = await api("/api/staff/chats/" + encodeURIComponent(ADMIN_CHAT_OPEN_MEMBERSHIP));
    ADMIN_CHAT_MESSAGES = messages;
    // Don't wipe a reply that is being edited when the poll refreshes the thread.
    if (!ADMIN_CHAT_EDIT_ID) renderChatBubbles("admin-chat-thread", messages, "staff", { editable: true });
  } catch (e) {
    /* ignore - next poll will retry */
  }
}
// Combines member-chat and public-inquiry unread counts into one number for
// the "Content & Chat" tab badge, while also updating each feature's own
// badge (admin-chat-badge, admin-inquiries-badge) separately - so the tab
// pill reflects "anything needs attention in here" while each card still
// shows its own specific count.
async function updateAdminChatBadge() {
  const badge = document.getElementById("admin-chat-badge");
  const inquiriesBadge = document.getElementById("admin-inquiries-badge");
  const tabBadge = document.getElementById("admin-tab-badge-messages");
  if (!badge) return;
  if (!CURRENT_SESSION || CURRENT_SESSION.type !== "staff" || !["admin", "tournament"].includes(CURRENT_SESSION.staff.role)) {
    badge.classList.add("hidden");
    if (inquiriesBadge) inquiriesBadge.classList.add("hidden");
    if (tabBadge) tabBadge.classList.add("hidden");
    return;
  }
  try {
    const [chatResult, inquiriesResult] = await Promise.all([
      api("/api/staff/chats/unread-count"),
      api("/api/staff/inquiries/unread-count"),
    ]);
    const chatCount = chatResult.count;
    const inquiriesCount = inquiriesResult.count;
    if (chatCount > 0) {
      badge.textContent = chatCount > 9 ? "9+" : String(chatCount);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
    if (inquiriesBadge) {
      if (inquiriesCount > 0) {
        inquiriesBadge.textContent = inquiriesCount > 9 ? "9+" : String(inquiriesCount);
        inquiriesBadge.classList.remove("hidden");
      } else {
        inquiriesBadge.classList.add("hidden");
      }
    }
    const total = chatCount + inquiriesCount;
    if (tabBadge) {
      if (total > 0) {
        tabBadge.textContent = total > 9 ? "9+" : String(total);
        tabBadge.classList.remove("hidden");
      } else {
        tabBadge.classList.add("hidden");
      }
    }
  } catch (e) {
    /* ignore */
  }
}
// -- admin: public contact-form inquiries inbox --
// Same list/detail-panel shape as the member-chat inbox above, but each
// inquiry is a single message (no thread/reply-in-app - see the PUBLIC
// CONTACT FORM comment in server.js for why) with read/resolved tracking
// and an optional internal note instead of a reply box.
let ADMIN_INQUIRY_OPEN_ID = null;
let INQUIRIES_CACHE = [];
async function loadInquiriesList() {
  const wrap = document.getElementById("inquiries-list");
  if (!wrap) return;
  if (!CURRENT_SESSION || CURRENT_SESSION.type !== "staff" || !["admin", "tournament"].includes(CURRENT_SESSION.staff.role)) return;
  try {
    INQUIRIES_CACHE = await api("/api/staff/inquiries");
    if (!INQUIRIES_CACHE.length) {
      wrap.innerHTML = `<p style="color:var(--muted);font-size:0.85rem;">${escapeAttr(t("noInquiries"))}</p>`;
    } else {
      wrap.innerHTML = INQUIRIES_CACHE
        .map(
          (inq) => `<div class="chat-thread-item ${inq.id === ADMIN_INQUIRY_OPEN_ID ? "active" : ""}" data-id="${inq.id}">
        <div>
          <div class="name">${escapeAttr(inq.name)}${inq.resolved ? ` <span style="color:var(--muted);font-weight:400;">(${escapeAttr(t("inquiryResolvedLabel"))})</span>` : ""}${inq.replies && inq.replies.length ? ` <span style="color:#0e7266;font-weight:400;">&#8617; ${escapeAttr(t("inquiryRepliedLabel"))}</span>` : ""}</div>
          <div class="snippet">${escapeAttr(inq.message)}</div>
        </div>
        ${!inq.read ? `<div class="unread-dot">&bull;</div>` : ""}
      </div>`
        )
        .join("");
      wrap.querySelectorAll(".chat-thread-item").forEach((el) => {
        el.addEventListener("click", () => openInquiryDetail(Number(el.dataset.id)));
      });
    }
    updateAdminChatBadge();
  } catch (e) {
    wrap.innerHTML = `<p style="color:var(--muted);font-size:0.85rem;">${escapeAttr(t("errGeneric"))}</p>`;
  }
}
async function openInquiryDetail(id) {
  ADMIN_INQUIRY_OPEN_ID = id;
  const panel = document.getElementById("inquiry-detail-panel");
  panel.classList.remove("hidden");
  const inquiry = INQUIRIES_CACHE.find((i) => i.id === id);
  if (!inquiry) return;
  document.getElementById("inquiry-detail-name").textContent = inquiry.name;
  const contactBits = [inquiry.phone, inquiry.email].filter(Boolean).join(" · ");
  document.getElementById("inquiry-detail-contact").textContent =
    contactBits + " · " + new Date(inquiry.submittedAt).toLocaleString();
  document.getElementById("inquiry-detail-message").textContent = inquiry.message;
  document.getElementById("inquiry-note-input").value = inquiry.staffNote || "";
  document.getElementById("inquiry-reply-input").value = "";
  INQUIRY_EDIT_REPLY_ID = null;
  renderInquiryReplies(inquiry);
  const toggleBtn = document.getElementById("inquiry-toggle-resolved-btn");
  toggleBtn.textContent = inquiry.resolved ? t("btnMarkUnresolved") : t("btnMarkResolved");
  document.getElementById("inquiry-detail-msg").textContent = "";
  if (!inquiry.read) {
    try {
      await api(`/api/staff/inquiries/${id}/read`, { method: "POST" });
      inquiry.read = true;
      loadInquiriesList();
    } catch (e) {
      /* ignore - next poll will retry */
    }
  }
}
// ---- inquiry replies: send (WhatsApp / email / save only) and edit ----
let INQUIRY_EDIT_REPLY_ID = null;
function inquiryChannelLabel(ch) {
  return ch === "whatsapp" ? t("chReplyWhatsapp") : ch === "email" ? t("chReplyEmail") : t("chReplyNote");
}
function inquiryMailtoHref(inquiry, text) {
  return `mailto:${encodeURIComponent(inquiry.email)}?subject=${encodeURIComponent(t("replyEmailSubject"))}&body=${encodeURIComponent(text)}`;
}
function openReplyChannel(inquiry, channel, text) {
  if (channel === "whatsapp") window.open(waLink(inquiry.phone, text), "_blank", "noopener");
  else if (channel === "email") {
    const a = document.createElement("a");
    a.href = inquiryMailtoHref(inquiry, text);
    a.click();
  }
}
function renderInquiryReplies(inquiry) {
  const wrap = document.getElementById("inquiry-replies");
  const replies = inquiry.replies || [];
  document.getElementById("inquiry-reply-wa-btn").classList.toggle("hidden", !inquiry.phone);
  document.getElementById("inquiry-reply-email-btn").classList.toggle("hidden", !inquiry.email);
  if (!replies.length) {
    wrap.innerHTML = "";
    return;
  }
  const loc = currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-US";
  wrap.innerHTML =
    `<h4 style="margin:0 0 6px;">${escapeAttr(t("inquiryRepliesTitle"))}</h4>` +
    replies
      .map((r) => {
        const editedTag = r.editedAt ? `<span><i>(${escapeAttr(t("editedTag"))} ${escapeAttr(new Date(r.editedAt).toLocaleString(loc))})</i></span>` : "";
        const meta = `<span class="ch ${r.channel}">${escapeAttr(inquiryChannelLabel(r.channel))}</span><span>${escapeAttr(r.sentBy || "")} · ${escapeAttr(new Date(r.sentAt).toLocaleString(loc))}</span>${editedTag}`;
        if (r.id === INQUIRY_EDIT_REPLY_ID) {
          return `<div class="inq-reply">
            <textarea id="inquiry-reply-edit-input" rows="3">${escapeAttr(r.text)}</textarea>
            <div class="inq-reply-actions">
              <button type="button" class="primary" data-reply-save="${r.id}">${escapeAttr(t("btnSaveEdit"))}</button>
              ${inquiry.phone ? `<button type="button" class="roster-btn wa" data-reply-save="${r.id}" data-resend="whatsapp">${escapeAttr(t("btnSaveResendWa"))}</button>` : ""}
              ${inquiry.email ? `<button type="button" class="secondary" data-reply-save="${r.id}" data-resend="email">${escapeAttr(t("btnSaveResendEmail"))}</button>` : ""}
              <button type="button" class="secondary" data-reply-cancel="1">${escapeAttr(t("btnCancel"))}</button>
            </div>
          </div>`;
        }
        return `<div class="inq-reply"><div class="text">${escapeAttr(r.text)}</div>
          <div class="meta">${meta}</div>
          <div class="inq-reply-actions"><button type="button" class="secondary" data-reply-edit="${r.id}">${escapeAttr(t("btnEdit"))}</button></div>
        </div>`;
      })
      .join("");
}
async function sendInquiryReply(channel) {
  if (!ADMIN_INQUIRY_OPEN_ID) return;
  const inquiry = INQUIRIES_CACHE.find((i) => i.id === ADMIN_INQUIRY_OPEN_ID);
  if (!inquiry) return;
  const msg = document.getElementById("inquiry-detail-msg");
  const input = document.getElementById("inquiry-reply-input");
  const text = input.value.trim();
  if (!text) return showMsg(msg, t("errReplyEmpty"), false);
  try {
    // Record first, so the reply is kept even if the WhatsApp/email window is closed unsent.
    const result = await api(`/api/staff/inquiries/${inquiry.id}/replies`, { method: "POST", body: JSON.stringify({ text, channel }) });
    Object.assign(inquiry, result);
    input.value = "";
    renderInquiryReplies(inquiry);
    openReplyChannel(inquiry, channel, text);
    showMsg(msg, t("replySavedMsg"), true);
    loadInquiriesList();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}
document.getElementById("inquiry-reply-wa-btn").addEventListener("click", () => sendInquiryReply("whatsapp"));
document.getElementById("inquiry-reply-email-btn").addEventListener("click", () => sendInquiryReply("email"));
document.getElementById("inquiry-reply-save-btn").addEventListener("click", () => sendInquiryReply("note"));
document.getElementById("inquiry-replies").addEventListener("click", async (e) => {
  const inquiry = INQUIRIES_CACHE.find((i) => i.id === ADMIN_INQUIRY_OPEN_ID);
  if (!inquiry) return;
  const edit = e.target.closest("[data-reply-edit]");
  if (edit) {
    INQUIRY_EDIT_REPLY_ID = Number(edit.dataset.replyEdit);
    renderInquiryReplies(inquiry);
    return;
  }
  if (e.target.closest("[data-reply-cancel]")) {
    INQUIRY_EDIT_REPLY_ID = null;
    renderInquiryReplies(inquiry);
    return;
  }
  const save = e.target.closest("[data-reply-save]");
  if (save) {
    const msg = document.getElementById("inquiry-detail-msg");
    const text = document.getElementById("inquiry-reply-edit-input").value.trim();
    if (!text) return showMsg(msg, t("errReplyEmpty"), false);
    const resend = save.dataset.resend || "";
    save.disabled = true;
    try {
      const result = await api(`/api/staff/inquiries/${inquiry.id}/replies/${save.dataset.replySave}`, {
        method: "PUT",
        body: JSON.stringify({ text, resent: !!resend }),
      });
      Object.assign(inquiry, result);
      INQUIRY_EDIT_REPLY_ID = null;
      renderInquiryReplies(inquiry);
      if (resend) openReplyChannel(inquiry, resend, text);
      showMsg(msg, t("replySavedMsg"), true);
    } catch (err) {
      showMsg(msg, err.message, false);
      save.disabled = false;
    }
  }
});

document.getElementById("inquiry-save-note-btn").addEventListener("click", async () => {
  if (!ADMIN_INQUIRY_OPEN_ID) return;
  const inquiry = INQUIRIES_CACHE.find((i) => i.id === ADMIN_INQUIRY_OPEN_ID);
  if (!inquiry) return;
  const msg = document.getElementById("inquiry-detail-msg");
  const note = document.getElementById("inquiry-note-input").value.trim();
  try {
    // Sends the CURRENT resolved value explicitly - the endpoint toggles
    // resolved when that field is left out of the request body, which
    // would flip it as a side effect of an unrelated "just save the note"
    // click if omitted here.
    const result = await api(`/api/staff/inquiries/${ADMIN_INQUIRY_OPEN_ID}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolved: inquiry.resolved, staffNote: note }),
    });
    Object.assign(inquiry, result);
    showMsg(msg, t("settingsSaved"), true);
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});
document.getElementById("inquiry-toggle-resolved-btn").addEventListener("click", async () => {
  if (!ADMIN_INQUIRY_OPEN_ID) return;
  const inquiry = INQUIRIES_CACHE.find((i) => i.id === ADMIN_INQUIRY_OPEN_ID);
  if (!inquiry) return;
  const msg = document.getElementById("inquiry-detail-msg");
  try {
    const result = await api(`/api/staff/inquiries/${ADMIN_INQUIRY_OPEN_ID}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolved: !inquiry.resolved }),
    });
    Object.assign(inquiry, result);
    document.getElementById("inquiry-toggle-resolved-btn").textContent = inquiry.resolved
      ? t("btnMarkUnresolved")
      : t("btnMarkResolved");
    showMsg(msg, t("settingsSaved"), true);
    loadInquiriesList();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});
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
    await refreshStaffEventScope();
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
  if (tabKey === "reports") { loadReports(); rbEnsure().catch(() => {}); }
  if (tabKey === "members") loadBirthdays();
  if (tabKey === "points") loadPointsStart();
  if (tabKey === "messages") {
    loadChatThreadsList();
    loadInquiriesList();
  }
}

// ------------------------------------------------------ admin: reports tab --
// One card per event with one-click print buttons (registrations list,
// attendance / check-in sheet, points sheet, plus the Swiss tournament sheets
// when the event runs one). Each button opens the printable A4 page in a new
// tab; staff press Print > Save as PDF there.
let REPORTS_DATA = null;
async function loadReports() {
  const msg = document.getElementById("reports-msg");
  const wrap = document.getElementById("reports-list");
  if (wrap && !REPORTS_DATA) wrap.innerHTML = `<p style="color:var(--muted);">${escapeAttr(t("loading"))}</p>`;
  try {
    REPORTS_DATA = await api("/api/admin/reports/events");
    if (msg) msg.textContent = "";
    renderReports();
    renderAgeReportBuilder();
  } catch (e) {
    if (wrap) wrap.innerHTML = "";
    if (msg) showMsg(msg, e.message, false);
  }
}
function renderReports() {
  const wrap = document.getElementById("reports-list");
  if (!wrap || !REPORTS_DATA) return;
  if (!REPORTS_DATA.length) {
    wrap.innerHTML = `<p class="hint-note">${escapeAttr(t("reportsEmpty"))}</p>`;
    return;
  }
  const isAdmin = CURRENT_SESSION && CURRENT_SESSION.type === "staff" && CURRENT_SESSION.staff.role === "admin";
  const link = (href, label) => `<a href="${escapeAttr(href)}" target="_blank" rel="noopener">${escapeAttr(label)}</a>`;
  wrap.innerHTML = REPORTS_DATA.map((ev) => {
    const eventBase = `/admin/print/event/${ev.eventId}`;
    const tournBase = `/admin/print/tournament/${ev.eventId}`;
    const lang = `lang=${currentLang}`;
    const counts = t("reportsCounts")
      .replace("{reg}", fmt(ev.confirmedCount))
      .replace("{wait}", fmt(ev.waitlistCount))
      .replace("{in}", fmt(ev.checkedInCount));
    const dates = ev.endDate && ev.endDate !== ev.date ? `${ev.date} → ${ev.endDate}` : ev.date;
    const sheets = `
      <div class="reports-group">
        <span class="reports-group-title">${escapeAttr(t("reportsEventSheets"))}</span>
        <div class="reports-btns">
          ${link(`${eventBase}?view=registrations&${lang}`, t("reportsRegistrations"))}
          ${link(`${eventBase}?view=attendance&${lang}`, t("reportsAttendance"))}
          ${isAdmin ? link(`${eventBase}?view=points&${lang}`, t("reportsPoints")) : ""}
          ${isAdmin ? link(`/api/admin/management/events/${ev.eventId}/report.docx?${lang}`, t("reportsEventDoc")) : ""}
        </div>
      </div>`;
    let tournament = "";
    if (ev.swiss) {
      const rounds = [];
      for (let r = 1; r <= ev.swiss.generatedRounds; r++) rounds.push(link(`${tournBase}?view=pairings&round=${r}&${lang}`, String(r)));
      tournament = `
      <div class="reports-group">
        <span class="reports-group-title">${escapeAttr(t("reportsTournamentSheets"))} <span class="tourn-summary-badge">${escapeAttr(tournamentFormatLabel("swiss"))}</span></span>
        <div class="reports-btns">
          ${link(`${tournBase}?view=regulation&${lang}`, t("btnPrintRegulation"))}
          ${ev.swiss.generatedRounds ? link(`${tournBase}?view=standings&${lang}`, t("btnPrintStandings")) : ""}
        </div>
        ${ev.swiss.generatedRounds ? `<div class="reports-btns reports-rounds"><span class="hint-note" style="margin:0;">${escapeAttr(t("reportsPairingsRound"))}</span>${rounds.join("")}</div>` : `<p class="hint-note" style="margin:6px 0 0;">${escapeAttr(t("reportsSwissNotStarted"))}</p>`}
      </div>`;
    } else if (ev.tournament) {
      tournament = `<p class="hint-note" style="margin:8px 0 0;">${escapeAttr(t("reportsOtherTournament"))}</p>`;
    }
    return `
    <div class="reports-event">
      <div class="reports-event-head">
        <b>${escapeAttr(eventLabel(ev))}</b>
        <span class="hint-note" style="margin:0;">${escapeAttr(dates)} · ${escapeAttr(counts)}</span>
      </div>
      ${sheets}
      ${tournament}
    </div>`;
  }).join("");
}

// ----------------------------------------------- admin: age group report --
// Builds the link to /admin/print/age-report from the chosen events, period,
// age groups and level of detail. The link is rebuilt on every change.
let AGEREP_SEL = null; // Set of selected event ids (null = not initialised yet)
function renderAgeReportBuilder() {
  const box = document.getElementById("agerep-events");
  if (!box || !REPORTS_DATA) return;
  if (AGEREP_SEL === null) AGEREP_SEL = new Set(REPORTS_DATA.map((e) => e.eventId));
  box.innerHTML = REPORTS_DATA.map((ev) => {
    const dates = ev.endDate && ev.endDate !== ev.date ? `${ev.date} → ${ev.endDate}` : ev.date;
    return `<label class="agerep-chk"><input type="checkbox" data-evid="${ev.eventId}" ${AGEREP_SEL.has(ev.eventId) ? "checked" : ""} /> <span><b>${escapeAttr(eventLabel(ev))}</b> <span class="hint-note" style="margin:0;">${escapeAttr(dates)}</span></span></label>`;
  }).join("");
  updateAgeReportLink();
}
function updateAgeReportLink() {
  const link = document.getElementById("agerep-open");
  if (!link || !REPORTS_DATA) return;
  const total = REPORTS_DATA.length;
  const ages = [...document.querySelectorAll("#agerep-ages input:checked")].map((i) => i.value);
  const sel = AGEREP_SEL || new Set();
  const count = document.getElementById("agerep-count");
  if (count) count.textContent = t("ageRepSelected").replace("{n}", fmt(sel.size)).replace("{total}", fmt(total));
  const hint = document.getElementById("agerep-hint");
  const valid = sel.size > 0 && ages.length > 0;
  link.classList.toggle("disabled", !valid);
  if (hint) hint.textContent = valid ? t("ageRepPeriodHint") : t("ageRepPickEvent");
  if (!valid) {
    link.setAttribute("href", "#");
    return;
  }
  const q = new URLSearchParams();
  q.set("lang", currentLang);
  q.set("detail", document.getElementById("agerep-detail").value);
  q.set("ages", ages.join(","));
  q.set("events", sel.size === total ? "all" : [...sel].join(","));
  const from = document.getElementById("agerep-from").value;
  const to = document.getElementById("agerep-to").value;
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  link.setAttribute("href", `/admin/print/age-report?${q.toString()}`);
}
(function wireAgeReportBuilder() {
  const card = document.getElementById("agerep-card");
  if (!card) return;
  card.addEventListener("change", (e) => {
    const cb = e.target.closest && e.target.closest("input[data-evid]");
    if (cb && AGEREP_SEL) {
      const id = Number(cb.dataset.evid);
      if (cb.checked) AGEREP_SEL.add(id);
      else AGEREP_SEL.delete(id);
    }
    updateAgeReportLink();
  });
  document.getElementById("agerep-all").addEventListener("click", () => {
    if (!REPORTS_DATA) return;
    AGEREP_SEL = new Set(REPORTS_DATA.map((e) => e.eventId));
    renderAgeReportBuilder();
  });
  document.getElementById("agerep-none").addEventListener("click", () => {
    AGEREP_SEL = new Set();
    renderAgeReportBuilder();
  });
  document.getElementById("agerep-open").addEventListener("click", (e) => {
    if (e.currentTarget.classList.contains("disabled")) e.preventDefault();
  });
})();

// -------------------------------------------- admin: custom report builder --
// The form is turned into a "spec" (source, columns, filters, sort, group-by)
// that the server whitelists and runs; the same spec drives the on-screen
// table, the Excel download, the A4 print page and saved reports.
var RB = { meta: null, events: [], saved: [], lang: null, savedId: 0, lastSpec: null };
const rbEl = (id) => document.getElementById(id);
const rbIsAdmin = () => !!(CURRENT_SESSION && CURRENT_SESSION.type === "staff" && CURRENT_SESSION.staff.role === "admin");
const rbSource = () => ((document.querySelector('input[name="rb-source"]:checked') || {}).value === "registrations" ? "registrations" : "people");
const rbChecked = (boxId) => [...document.querySelectorAll(`#${boxId} input:checked`)].map((i) => i.value);
const rbNum = (id) => {
  const v = rbEl(id).value.trim();
  return v === "" ? "" : v;
};
function rbChips(boxId, items, checkedSet) {
  rbEl(boxId).innerHTML = items
    .map((it) => `<label class="agerep-chk"><input type="checkbox" value="${escapeAttr(String(it.key))}" ${checkedSet && checkedSet.has(it.key) ? "checked" : ""} /> <span>${escapeAttr(it.label)}</span></label>`)
    .join("");
}
function rbReadSpec() {
  return {
    source: rbSource(),
    columns: rbChecked("rb-columns"),
    filters: {
      kinds: rbChecked("rb-kinds"),
      memberTypes: rbChecked("rb-membertypes"),
      ageGroups: rbChecked("rb-agegroups"),
      ageMin: rbNum("rb-agemin"),
      ageMax: rbNum("rb-agemax"),
      birthYearMin: rbNum("rb-bymin"),
      birthYearMax: rbNum("rb-bymax"),
      hasBirthDate: rbEl("rb-hasdob").value,
      birthConfirmed: rbEl("rb-birthconf").value,
      phone: rbEl("rb-phone").value,
      phoneContains: rbEl("rb-phonecontains").value,
      search: rbEl("rb-search").value,
      familyGroup: rbEl("rb-familygroup").value,
      account: rbEl("rb-account").value,
      status: rbEl("rb-status").value,
      activity: rbEl("rb-activity").value,
      pointsMin: rbNum("rb-ptsmin"),
      pointsMax: rbNum("rb-ptsmax"),
      events: [...document.querySelectorAll("#rb-events input:checked")].map((i) => Number(i.value)),
      from: rbEl("rb-from").value,
      to: rbEl("rb-to").value,
      regStatus: rbChecked("rb-regstatus"),
    },
    sortBy: rbEl("rb-sortby").value,
    sortDir: rbEl("rb-sortdir").value,
    groupBy: rbEl("rb-groupby").value,
    layout: rbEl("rb-layout").value,
  };
}
// Rebuilds everything that depends on the chosen source / language, keeping
// the values the admin already typed where they still make sense.
function rbBuildSourceParts(source, colsChecked, sortBy, groupBy) {
  const def = RB.meta[source];
  const set = new Set(colsChecked && colsChecked.length ? colsChecked : def.columns.filter((c) => c.def).map((c) => c.key));
  rbChips("rb-columns", def.columns, set);
  rbEl("rb-sortby").innerHTML = `<option value="">${escapeAttr(t("rbSortNone"))}</option>` + def.columns.map((c) => `<option value="${c.key}">${escapeAttr(c.label)}</option>`).join("");
  rbEl("rb-groupby").innerHTML = `<option value="">${escapeAttr(t("rbGroupNone"))}</option>` + def.groups.map((g) => `<option value="${g.key}">${escapeAttr(g.label)}</option>`).join("");
  if (def.columns.some((c) => c.key === sortBy)) rbEl("rb-sortby").value = sortBy;
  if (def.groups.some((g) => g.key === groupBy)) rbEl("rb-groupby").value = groupBy;
  document.querySelectorAll(".rb-people-only").forEach((el) => el.classList.toggle("hidden", source !== "people"));
  document.querySelectorAll(".rb-regs-only").forEach((el) => el.classList.toggle("hidden", source !== "registrations"));
}
function rbBuildAll(spec) {
  spec = spec || RB.lastSpec || null;
  const o = RB.meta.options;
  const f = (spec && spec.filters) || {};
  rbChips("rb-membertypes", o.memberTypes, new Set(f.memberTypes || []));
  rbChips("rb-agegroups", o.ageGroups, new Set(f.ageGroups || []));
  rbChips("rb-regstatus", o.regStatus, new Set(f.regStatus && f.regStatus.length ? f.regStatus : ["confirmed", "checkedin"]));
  const evSel = new Set(f.events || []);
  rbEl("rb-events").innerHTML = RB.events
    .map((ev) => `<label class="agerep-chk"><input type="checkbox" data-rbev="1" value="${ev.id}" ${evSel.has(ev.id) ? "checked" : ""} /> <span><b>${escapeAttr(ev.name)}</b> <span class="hint-note" style="margin:0;">${escapeAttr(ev.date)}</span></span></label>`)
    .join("");
  rbBuildSourceParts(spec ? spec.source : rbSource(), spec && spec.columns, spec && spec.sortBy, spec && spec.groupBy);
  rbUpdateEventCount();
  rbBuildSaved();
}
function rbApplySpec(spec) {
  document.querySelector(`input[name="rb-source"][value="${spec.source}"]`).checked = true;
  RB.lastSpec = spec;
  rbBuildAll(spec);
  const f = spec.filters;
  const setChecks = (id, arr) => document.querySelectorAll(`#${id} input`).forEach((i) => { i.checked = (arr || []).includes(i.value); });
  setChecks("rb-kinds", f.kinds);
  const val = (id, v) => { rbEl(id).value = v == null ? "" : v; };
  val("rb-agemin", f.ageMin); val("rb-agemax", f.ageMax);
  val("rb-bymin", f.birthYearMin); val("rb-bymax", f.birthYearMax);
  val("rb-hasdob", f.hasBirthDate); val("rb-birthconf", f.birthConfirmed); val("rb-phone", f.phone); val("rb-phonecontains", f.phoneContains);
  val("rb-search", f.search); val("rb-familygroup", f.familyGroup); val("rb-account", f.account);
  val("rb-status", f.status); val("rb-activity", f.activity);
  val("rb-ptsmin", f.pointsMin); val("rb-ptsmax", f.pointsMax);
  val("rb-from", f.from); val("rb-to", f.to);
  rbEl("rb-sortdir").value = spec.sortDir || "asc";
  rbEl("rb-layout").value = spec.layout || "detail";
}
function rbUpdateEventCount() {
  const n = document.querySelectorAll("#rb-events input:checked").length;
  rbEl("rb-ev-count").textContent = n ? t("rbEventsSel").replace("{n}", fmt(n)) : t("rbEventsNoneSel");
}
function rbBuildSaved() {
  const sel = rbEl("rb-saved");
  sel.innerHTML = `<option value="0">${escapeAttr(t("rbSavedNone"))}</option>` + RB.saved.map((r) => `<option value="${r.id}">${escapeAttr(r.name)}</option>`).join("");
  if (!RB.saved.some((r) => r.id === RB.savedId)) RB.savedId = 0;
  sel.value = String(RB.savedId);
  rbEl("rb-update").disabled = !RB.savedId;
  rbEl("rb-delete").disabled = !RB.savedId;
}
async function rbEnsure(force) {
  if (!rbIsAdmin() || !rbEl("rb-card")) return;
  if (RB.meta && RB.lang === currentLang && !force) return;
  const keep = RB.meta ? rbReadSpec() : null;
  const data = await api(`/api/admin/report-builder/meta?lang=${currentLang}`);
  RB.meta = data.meta;
  RB.events = data.events;
  RB.saved = data.saved;
  RB.lang = currentLang;
  if (keep) rbApplySpec(keep);
  else rbBuildAll(null);
}
function rbTable(head, rows, totalRow) {
  const th = head.map((h) => `<th>${escapeAttr(h)}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${escapeAttr(c == null ? "" : String(c))}</td>`).join("")}</tr>`).join("");
  const tot = totalRow ? `<tr class="rb-total">${totalRow.map((c) => `<td>${escapeAttr(String(c))}</td>`).join("")}</tr>` : "";
  return `<div class="rb-table-wrap"><table class="rb-table"><thead><tr>${th}</tr></thead><tbody>${body}${tot}</tbody></table></div>`;
}
function rbRender(out) {
  const box = rbEl("rb-result");
  let html = `<p class="rb-count"><b>${escapeAttr(t("rbResults").replace("{n}", fmt(out.total)))}</b></p>`;
  html += `<p class="hint-note rb-filters-text">${(out.filters || []).map((f) => escapeAttr(f)).join(" · ")}</p>`;
  if (out.summary) html += rbTable(out.summary.head, out.summary.rows, out.summary.total);
  if (out.spec.layout !== "summary") {
    html += out.rows.length
      ? rbTable(["#", ...out.columns.map((c) => c.label)], out.rows.map((r, i) => [i + 1, ...r]))
      : `<p class="hint-note">${escapeAttr(t("rbNoResults"))}</p>`;
    if (out.truncated) html += `<p class="hint-note">${escapeAttr(t("rbShowing").replace("{shown}", fmt(out.rows.length)).replace("{n}", fmt(out.total)))}</p>`;
  }
  box.innerHTML = html;
}
function rbCheckSpec(spec) {
  if (!spec.columns.length && spec.layout !== "summary") {
    showMsg(rbEl("rb-msg"), t("rbPickColumn"), false);
    return false;
  }
  return true;
}
async function rbRun() {
  const msg = rbEl("rb-msg");
  const spec = rbReadSpec();
  if (!rbCheckSpec(spec)) return;
  msg.classList.remove("show");
  rbEl("rb-run").disabled = true;
  try {
    const out = await api("/api/admin/report-builder/run", { method: "POST", body: JSON.stringify({ spec, lang: currentLang }) });
    RB.lastSpec = out.spec;
    rbRender(out);
  } catch (err) {
    showMsg(msg, err.message, false);
  } finally {
    rbEl("rb-run").disabled = false;
  }
}
async function rbExcel() {
  const msg = rbEl("rb-msg");
  const spec = rbReadSpec();
  if (!rbCheckSpec(spec)) return;
  msg.classList.remove("show");
  try {
    const res = await fetch("/api/admin/report-builder/export", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": getCsrfToken() },
      body: JSON.stringify({ spec, lang: currentLang }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || t("errGeneric"));
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ahlawy-custom-report.xlsx";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (err) {
    showMsg(msg, err.message, false);
  }
}
function rbPrint() {
  const spec = rbReadSpec();
  if (!rbCheckSpec(spec)) return;
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(spec)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (b64.length > 7800) {
    showMsg(rbEl("rb-msg"), t("rbPrintTooLong"), false);
    return;
  }
  window.open(`/admin/print/custom-report?lang=${currentLang}&spec=${b64}`, "_blank", "noopener");
}
async function rbSaveNew() {
  const msg = rbEl("rb-saved-msg");
  const name = rbEl("rb-name").value.trim();
  if (!name) return showMsg(msg, t("rbNeedName"), false);
  try {
    const rec = await api("/api/admin/saved-reports", { method: "POST", body: JSON.stringify({ name, spec: rbReadSpec() }) });
    RB.saved.push(rec);
    RB.savedId = rec.id;
    rbBuildSaved();
    showMsg(msg, t("rbSavedMsg"), true);
  } catch (err) {
    showMsg(msg, err.message, false);
  }
}
async function rbUpdate() {
  const msg = rbEl("rb-saved-msg");
  if (!RB.savedId) return;
  const name = rbEl("rb-name").value.trim();
  if (!name) return showMsg(msg, t("rbNeedName"), false);
  try {
    const rec = await api(`/api/admin/saved-reports/${RB.savedId}`, { method: "PUT", body: JSON.stringify({ name, spec: rbReadSpec() }) });
    RB.saved = RB.saved.map((r) => (r.id === rec.id ? rec : r));
    rbBuildSaved();
    showMsg(msg, t("rbUpdatedMsg"), true);
  } catch (err) {
    showMsg(msg, err.message, false);
  }
}
async function rbDelete() {
  const msg = rbEl("rb-saved-msg");
  if (!RB.savedId || !window.confirm(t("rbDeleteConfirm"))) return;
  try {
    await api(`/api/admin/saved-reports/${RB.savedId}`, { method: "DELETE" });
    RB.saved = RB.saved.filter((r) => r.id !== RB.savedId);
    RB.savedId = 0;
    rbEl("rb-name").value = "";
    rbBuildSaved();
    showMsg(msg, t("rbDeletedMsg"), true);
  } catch (err) {
    showMsg(msg, err.message, false);
  }
}
(function wireReportBuilder() {
  const card = rbEl("rb-card");
  if (!card) return;
  card.addEventListener("change", (e) => {
    if (e.target.name === "rb-source") {
      RB.lastSpec = null;
      rbBuildSourceParts(rbSource(), null, "", "");
    }
    if (e.target.closest("#rb-events")) rbUpdateEventCount();
  });
  rbEl("rb-saved").addEventListener("change", (e) => {
    RB.savedId = Number(e.target.value) || 0;
    const rec = RB.saved.find((r) => r.id === RB.savedId);
    rbEl("rb-update").disabled = !rec;
    rbEl("rb-delete").disabled = !rec;
    rbEl("rb-saved-msg").classList.remove("show");
    if (rec) {
      rbEl("rb-name").value = rec.name;
      rbApplySpec(rec.spec);
      rbRun();
    } else {
      rbEl("rb-name").value = "";
    }
  });
  rbEl("rb-col-default").addEventListener("click", () => {
    const def = new Set(RB.meta[rbSource()].columns.filter((c) => c.def).map((c) => c.key));
    document.querySelectorAll("#rb-columns input").forEach((i) => { i.checked = def.has(i.value); });
  });
  rbEl("rb-col-all").addEventListener("click", () => document.querySelectorAll("#rb-columns input").forEach((i) => { i.checked = true; }));
  rbEl("rb-col-none").addEventListener("click", () => document.querySelectorAll("#rb-columns input").forEach((i) => { i.checked = false; }));
  rbEl("rb-ev-none").addEventListener("click", () => {
    document.querySelectorAll("#rb-events input").forEach((i) => { i.checked = false; });
    rbUpdateEventCount();
  });
  rbEl("rb-run").addEventListener("click", rbRun);
  rbEl("rb-excel").addEventListener("click", rbExcel);
  rbEl("rb-print").addEventListener("click", rbPrint);
  rbEl("rb-save-new").addEventListener("click", rbSaveNew);
  rbEl("rb-update").addEventListener("click", rbUpdate);
  rbEl("rb-delete").addEventListener("click", rbDelete);
})();

// ------------------------------------------------------ admin: birthday cards --
// The card is drawn on a canvas in the browser (1080x1350 PNG, 4:5 - the shape
// WhatsApp shows best). wa.me can only pre-fill TEXT, so for each member the
// card is copied to the clipboard when the admin presses "Open WhatsApp";
// they paste it into the chat (Ctrl/Cmd+V) and press Send themselves.
const BDCARD = { W: 1080, H: 1350, crest: null };
function bdRng(seed) {
  let h = 2166136261;
  for (const c of String(seed)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => {
    h += 0x6d2b79f5;
    let x = h;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function bdLoadCrest() {
  return new Promise((resolve) => {
    if (BDCARD.crest) return resolve(BDCARD.crest);
    const img = new Image();
    img.onload = () => { BDCARD.crest = img; resolve(img); };
    img.onerror = () => resolve(null);
    img.src = "/ahly-crest-logo.png";
  });
}
async function bdLoadFonts() {
  try {
    await Promise.race([
      Promise.all([document.fonts.load('110px "Pacifico"'), document.fonts.load('800 80px "Cairo"'), document.fonts.load('700 40px "Cairo"')]),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch (e) { /* fall back to system fonts */ }
}
const BD_FONT_AR = '"Cairo","Segoe UI",Tahoma,Arial,sans-serif';
const BD_FONT_SCRIPT = '"Pacifico","Brush Script MT","Segoe Script",cursive';
function bdRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function bdFit(ctx, text, maxW, startPx, weight, family) {
  let px = startPx;
  ctx.font = `${weight} ${px}px ${family}`;
  while (ctx.measureText(text).width > maxW && px > 16) { px -= 3; ctx.font = `${weight} ${px}px ${family}`; }
  return px;
}
function bdBalloon(ctx, x, y, rx, ry, color, tilt, stringLen) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  // string
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, ry + 10);
  ctx.bezierCurveTo(-24, ry + stringLen * 0.35, 24, ry + stringLen * 0.65, -6, ry + stringLen);
  ctx.stroke();
  // body (slightly egg shaped)
  ctx.beginPath();
  ctx.moveTo(0, -ry);
  ctx.bezierCurveTo(rx * 1.25, -ry, rx * 1.15, ry * 0.75, 0, ry);
  ctx.bezierCurveTo(-rx * 1.15, ry * 0.75, -rx * 1.25, -ry, 0, -ry);
  ctx.closePath();
  const g = ctx.createRadialGradient(-rx * 0.35, -ry * 0.4, rx * 0.1, 0, 0, ry * 1.1);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.18, color[0]);
  g.addColorStop(1, color[1]);
  ctx.fillStyle = g;
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 10;
  ctx.fill();
  ctx.shadowColor = "transparent";
  // shine
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.beginPath();
  ctx.ellipse(-rx * 0.45, -ry * 0.45, rx * 0.16, ry * 0.26, -0.5, 0, Math.PI * 2);
  ctx.fill();
  // knot
  ctx.fillStyle = color[1];
  ctx.beginPath();
  ctx.moveTo(0, ry - 2);
  ctx.lineTo(-11, ry + 16);
  ctx.lineTo(11, ry + 16);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
function bdStar(ctx, x, y, r, fill) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = fill;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i;
    const rad = i % 2 === 0 ? r : r * 0.28;
    ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
function bdIcingBand(ctx, x1, x2, y, rng) {
  ctx.fillStyle = "#fffaf0";
  ctx.shadowColor = "rgba(0,0,0,0.18)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  bdRoundRect(ctx, x1, y - 16, x2 - x1, 32, 16);
  ctx.fill();
  ctx.shadowColor = "transparent";
  for (let x = x1 + 22; x < x2 - 22; x += 38 + rng() * 12) {
    const len = 18 + rng() * 34;
    ctx.beginPath();
    ctx.moveTo(x - 11, y);
    ctx.lineTo(x - 11, y + len);
    ctx.arc(x, y + len, 11, Math.PI, 0, true);
    ctx.lineTo(x + 11, y);
    ctx.closePath();
    ctx.fill();
  }
}
function bdCake(ctx, cx, baseY, rng) {
  // plate
  const pg = ctx.createLinearGradient(0, baseY - 6, 0, baseY + 40);
  pg.addColorStop(0, "#fff3c4");
  pg.addColorStop(1, "#d9a526");
  ctx.fillStyle = pg;
  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 12;
  ctx.beginPath();
  ctx.ellipse(cx, baseY + 12, 300, 34, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = "transparent";
  const tiers = [
    { w: 460, h: 105, y: baseY - 105, c: ["#e63946", "#a4161a"] },
    { w: 340, h: 92, y: baseY - 105 - 92, c: ["#ff9ebb", "#ff6f9c"] },
    { w: 220, h: 84, y: baseY - 105 - 92 - 84, c: ["#ffd166", "#f4a62a"] },
  ];
  for (const t of tiers) {
    const g = ctx.createLinearGradient(cx - t.w / 2, 0, cx + t.w / 2, 0);
    g.addColorStop(0, t.c[1]);
    g.addColorStop(0.35, t.c[0]);
    g.addColorStop(1, t.c[1]);
    ctx.fillStyle = g;
    bdRoundRect(ctx, cx - t.w / 2, t.y, t.w, t.h, 14);
    ctx.fill();
    // sprinkles
    for (let i = 0; i < 16; i++) {
      ctx.fillStyle = ["#ffffff", "#fff3b0", "#a8f0d8", "#bde0ff"][i % 4];
      ctx.save();
      ctx.translate(cx - t.w / 2 + 20 + rng() * (t.w - 40), t.y + 46 + rng() * (t.h - 62));
      ctx.rotate(rng() * Math.PI);
      ctx.fillRect(-7, -2.5, 14, 5);
      ctx.restore();
    }
    bdIcingBand(ctx, cx - t.w / 2 - 4, cx + t.w / 2 + 4, t.y + 2, rng);
  }
  // candles + flames
  const top = tiers[2];
  const flameCols = ["#fff7c2", "#ffb703"];
  [-80, -40, 0, 40, 80].forEach((dx, i) => {
    const x = cx + dx;
    const cy = top.y - 8;
    const cg = ctx.createLinearGradient(x - 8, 0, x + 8, 0);
    cg.addColorStop(0, i % 2 ? "#ffffff" : "#ff5d73");
    cg.addColorStop(1, i % 2 ? "#ffd6dc" : "#c1121f");
    ctx.fillStyle = cg;
    bdRoundRect(ctx, x - 8, cy - 70, 16, 72, 5);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.65)";
    ctx.lineWidth = 3;
    for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.moveTo(x - 8, cy - 62 + k * 17); ctx.lineTo(x + 8, cy - 50 + k * 17); ctx.stroke(); }
    const glow = ctx.createRadialGradient(x, cy - 100, 2, x, cy - 100, 56);
    glow.addColorStop(0, "rgba(255,220,120,0.75)");
    glow.addColorStop(1, "rgba(255,200,80,0)");
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, cy - 100, 56, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x, cy - 128);
    ctx.bezierCurveTo(x + 18, cy - 104, x + 14, cy - 76, x, cy - 76);
    ctx.bezierCurveTo(x - 14, cy - 76, x - 18, cy - 104, x, cy - 128);
    const fg = ctx.createLinearGradient(0, cy - 128, 0, cy - 76);
    fg.addColorStop(0, flameCols[0]);
    fg.addColorStop(1, flameCols[1]);
    ctx.fillStyle = fg;
    ctx.fill();
  });
}
// opts: { name, age (number|null) }  ->  Promise<HTMLCanvasElement>
async function renderBirthdayCard(opts) {
  const [crest] = await Promise.all([bdLoadCrest(), bdLoadFonts()]);
  const W = BDCARD.W, H = BDCARD.H;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const rng = bdRng(opts.name || "ahly");
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // background: Al Ahly red with a warm glow behind the title
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#e5001c");
  bg.addColorStop(0.55, "#a3000f");
  bg.addColorStop(1, "#52000a");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2, 560);
  for (let i = 0; i < 16; i++) {
    ctx.rotate((Math.PI * 2) / 16);
    ctx.fillStyle = i % 2 ? "rgba(255,225,150,0.10)" : "rgba(255,225,150,0.03)";
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-90, -1100); ctx.lineTo(90, -1100); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  const glow = ctx.createRadialGradient(W / 2, 560, 40, W / 2, 560, 760);
  glow.addColorStop(0, "rgba(255,196,90,0.50)");
  glow.addColorStop(1, "rgba(255,160,60,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 34; i++) { // soft bokeh
    ctx.fillStyle = `rgba(255,${200 + Math.floor(rng() * 40)},120,${0.05 + rng() * 0.12})`;
    ctx.beginPath(); ctx.arc(rng() * W, rng() * H, 14 + rng() * 46, 0, Math.PI * 2); ctx.fill();
  }
  // gold frame
  ctx.strokeStyle = "#f2c230";
  ctx.lineWidth = 10;
  bdRoundRect(ctx, 22, 22, W - 44, H - 44, 36);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,240,190,0.55)";
  ctx.lineWidth = 2;
  bdRoundRect(ctx, 40, 40, W - 80, H - 80, 26);
  ctx.stroke();

  // confetti
  const confetti = ["#ffd23f", "#ffffff", "#ff7a59", "#5fe0b7", "#6ec8ff", "#ff9ebb", "#f2c230"];
  for (let i = 0; i < 170; i++) {
    const x = 50 + rng() * (W - 100), y = 50 + rng() * (H - 100);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rng() * Math.PI * 2);
    ctx.fillStyle = confetti[Math.floor(rng() * confetti.length)];
    ctx.globalAlpha = 0.85;
    if (rng() < 0.35) { ctx.beginPath(); ctx.arc(0, 0, 5 + rng() * 5, 0, Math.PI * 2); ctx.fill(); }
    else ctx.fillRect(-4, -9, 8 + rng() * 6, 16 + rng() * 8);
    ctx.restore();
  }

  // balloons
  const balloons = [
    [150, 330, 62, 80, ["#ffd23f", "#e0a100"], -0.12, 300], [265, 215, 54, 70, ["#ff7a8a", "#d6203a"], 0.1, 280],
    [88, 520, 52, 68, ["#8be8cf", "#1fa985"], -0.08, 250], [930, 320, 62, 80, ["#ffffff", "#c8c8d0"], 0.12, 300],
    [815, 205, 54, 70, ["#ffd23f", "#e0a100"], -0.1, 280], [992, 520, 52, 68, ["#ff9ebb", "#e0457b"], 0.08, 250],
  ];
  balloons.forEach((b) => bdBalloon(ctx, b[0], b[1], b[2], b[3], b[4], b[5], b[6]));

  // crest + club line
  if (crest) {
    const ch = 150, cw = (crest.width / crest.height) * ch;
    ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = 18;
    ctx.drawImage(crest, W / 2 - cw / 2, 70, cw, ch);
    ctx.shadowColor = "transparent";
  }
  ctx.fillStyle = "#ffe9a8";
  if ("letterSpacing" in ctx) ctx.letterSpacing = "2px";
  bdFit(ctx, "AL AHLY CLUB · RECREATIONAL SPORTS COMMITTEE", 640, 25, 700, BD_FONT_AR);
  ctx.fillText("AL AHLY CLUB · RECREATIONAL SPORTS COMMITTEE", W / 2, 258);
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";

  // headline
  const gold = ctx.createLinearGradient(0, 300, 0, 420);
  gold.addColorStop(0, "#fff6c9"); gold.addColorStop(0.5, "#ffd23f"); gold.addColorStop(1, "#e09a00");
  ctx.lineJoin = "round";
  ctx.font = `800 128px ${BD_FONT_AR}`;
  ctx.lineWidth = 14; ctx.strokeStyle = "#7a0010";
  ctx.strokeText("عيد ميلاد سعيد", W / 2, 400);
  ctx.fillStyle = gold;
  ctx.fillText("عيد ميلاد سعيد", W / 2, 400);
  ctx.font = `112px ${BD_FONT_SCRIPT}`;
  ctx.lineWidth = 12; ctx.strokeStyle = "#7a0010";
  ctx.strokeText("Happy Birthday", W / 2, 548);
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(255,200,80,0.8)"; ctx.shadowBlur = 24;
  ctx.fillText("Happy Birthday", W / 2, 548);
  ctx.shadowColor = "transparent";
  bdStar(ctx, 205, 372, 30, "#fff3b0"); bdStar(ctx, 880, 340, 24, "#ffffff"); bdStar(ctx, 840, 470, 18, "#ffd23f"); bdStar(ctx, 236, 496, 20, "#ffffff");

  // name plate on a ribbon
  const py = 600, ph = 150, px = 130, pw = W - 260;
  ctx.fillStyle = "#5d000b";
  ctx.beginPath(); ctx.moveTo(78, py + 36); ctx.lineTo(px + 40, py + 36); ctx.lineTo(px + 40, py + ph + 36); ctx.lineTo(78, py + ph + 36); ctx.lineTo(112, py + ph / 2 + 36); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(W - 78, py + 36); ctx.lineTo(W - px - 40, py + 36); ctx.lineTo(W - px - 40, py + ph + 36); ctx.lineTo(W - 78, py + ph + 36); ctx.lineTo(W - 112, py + ph / 2 + 36); ctx.closePath(); ctx.fill();
  const plate = ctx.createLinearGradient(0, py, 0, py + ph);
  plate.addColorStop(0, "#fffdf6"); plate.addColorStop(1, "#ffeec0");
  ctx.shadowColor = "rgba(0,0,0,0.4)"; ctx.shadowBlur = 26; ctx.shadowOffsetY = 12;
  ctx.fillStyle = plate;
  bdRoundRect(ctx, px, py, pw, ph, 30);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "#e0a100"; ctx.lineWidth = 6;
  bdRoundRect(ctx, px + 10, py + 10, pw - 20, ph - 20, 22);
  ctx.stroke();
  const name = String(opts.name || "").trim();
  const px2 = bdFit(ctx, name, pw - 90, 92, 800, BD_FONT_AR);
  ctx.fillStyle = "#8b000f";
  ctx.fillText(name, W / 2, py + ph / 2 + px2 * 0.34);

  // optional age badge
  if (opts.age != null && opts.age > 0) {
    ctx.save();
    ctx.translate(W - 165, py + ph - 4);
    ctx.rotate(0.14);
    ctx.fillStyle = "#ffd23f";
    ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = 16; ctx.shadowOffsetY = 6;
    ctx.beginPath();
    for (let i = 0; i < 28; i++) { const a = (Math.PI * 2 * i) / 28; const r = i % 2 ? 66 : 80; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    ctx.closePath(); ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "#8b000f";
    ctx.font = `800 ${String(opts.age).length > 2 ? 52 : 68}px ${BD_FONT_AR}`;
    ctx.fillText(String(opts.age), 0, 14);
    ctx.font = `700 20px ${BD_FONT_AR}`;
    ctx.fillText("YEARS · سنة", 0, 46);
    ctx.restore();
  }

  // cake
  bdCake(ctx, W / 2, 1115, rng);
  bdStar(ctx, 250, 930, 26, "#fff3b0"); bdStar(ctx, 830, 900, 30, "#ffffff"); bdStar(ctx, 300, 1040, 18, "#ffd23f"); bdStar(ctx, 790, 1030, 20, "#fff3b0");

  // wishes
  ctx.fillStyle = "#ffffff";
  const wishAr = "كل عام وأنت بخير .. أيام مليئة بالسعادة والصحة والانتصارات";
  bdFit(ctx, wishAr, 880, 44, 800, BD_FONT_AR);
  ctx.shadowColor = "rgba(60,0,8,0.7)"; ctx.shadowBlur = 8;
  ctx.fillText(wishAr, W / 2, 1204);
  ctx.fillStyle = "#ffe9a8";
  const wishEn = "Wishing you a year full of joy, health and victories!";
  bdFit(ctx, wishEn, 880, 33, 700, BD_FONT_AR);
  ctx.fillText(wishEn, W / 2, 1250);
  ctx.shadowColor = "transparent";
  ctx.fillStyle = "rgba(255,255,255,0.78)";
  const foot = "لجنة الرياضة الترفيهية – فرع القاهرة الجديدة  ·  Recreational Sports Committee — New Cairo";
  bdFit(ctx, foot, 880, 23, 700, BD_FONT_AR);
  ctx.fillText(foot, W / 2, 1303);
  return canvas;
}
const bdCanvasBlob = (canvas) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("render"))), "image/png"));
const bdCardOpts = (it) => ({ name: it.name, age: document.getElementById("bd-showage").checked ? it.turning : null });
const bdCardBlob = (it) => renderBirthdayCard(bdCardOpts(it)).then(bdCanvasBlob);
function bdDownloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `birthday-${String(name).replace(/[^\w؀-ۿ]+/g, "_")}.png`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
function waBirthdayMessage(name) {
  const ar = `🎉🎂 كل عام وأنت بخير يا ${name}! أسرة لجنة الرياضة الترفيهية – فرع القاهرة الجديدة تتمنى لك عيد ميلاد سعيدًا وعامًا مليئًا بالصحة والسعادة والانتصارات. 🎈`;
  const en = `🎉🎂 Happy Birthday, ${name}! The Recreational Sports Committee — New Cairo Branch wishes you a wonderful year full of health, happiness and victories. 🎈`;
  return `${ar}\n\n${en}`;
}

var BD = { items: [], counts: { today: 0, week: 0, total: 0 }, sel: new Set(), previewKey: "", copy: null };
const bdKey = (it) => `${it.membershipNumber}#${it.dependentId == null ? "" : it.dependentId}`;
const bdFind = (key) => BD.items.find((x) => bdKey(x) === key);
function bdDateText(it) {
  return new Date(Date.UTC(2001, it.month - 1, it.day)).toLocaleDateString(currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
}
function bdWhen(it) {
  if (it.daysUntil === 0) return `<span class="bd-today">${escapeAttr(t("bdWhenToday"))}</span>`;
  if (it.daysUntil === 1) return escapeAttr(t("bdWhenTomorrow"));
  return escapeAttr(t("bdWhenDays").replace("{n}", fmt(it.daysUntil)));
}
function bdBuildMonths() {
  const sel = document.getElementById("bd-month");
  if (sel.options.length) return;
  for (let m = 1; m <= 12; m++) {
    const o = document.createElement("option");
    o.value = String(m);
    sel.appendChild(o);
  }
  sel.value = String(new Date().getMonth() + 1);
}
function bdLabelMonths() {
  document.querySelectorAll("#bd-month option").forEach((o) => {
    o.textContent = new Date(Date.UTC(2001, Number(o.value) - 1, 1)).toLocaleDateString(currentLang === "ar" ? "ar-EG" : "en-GB", { month: "long", timeZone: "UTC" });
  });
}
function bdRender() {
  const wrap = document.getElementById("bd-table");
  document.getElementById("bd-summary").textContent = t("bdSummary").replace("{today}", fmt(BD.counts.today)).replace("{week}", fmt(BD.counts.week));
  if (!BD.items.length) {
    wrap.innerHTML = `<p class="hint-note">${escapeAttr(t("bdEmpty"))}</p>`;
  } else {
    const rows = BD.items
      .map((it) => {
        const key = bdKey(it);
        const sent = it.sentAt ? `<span class="bd-sent">${escapeAttr(t("bdSentOn").replace("{date}", it.sentAt.slice(0, 10)))}</span>` : `<span class="hint-note" style="margin:0;">${escapeAttr(t("bdNotSent"))}</span>`;
        const who = it.kind === "dependent" ? `<small class="hint-note" style="margin:0;display:block;">${escapeAttr(t("bdFamilyOf").replace("{name}", it.parentName))}</small>` : "";
        return `<tr class="${it.daysUntil === 0 ? "bd-row-today" : ""}${BD.previewKey === key ? " bd-row-active" : ""}">
          <td><input type="checkbox" class="bd-sel" value="${escapeAttr(key)}" ${BD.sel.has(key) ? "checked" : ""} ${it.phone ? "" : "disabled"} /></td>
          <td><button type="button" class="bd-name" data-bd-preview="${escapeAttr(key)}">${escapeAttr(it.name)}</button>${who}</td>
          <td>${escapeAttr(bdDateText(it))}<small class="hint-note" style="margin:0;display:block;">${bdWhen(it)}</small></td>
          <td class="num">${fmt(it.turning)}</td>
          <td class="num">${it.phone ? escapeAttr(it.phone) : `<span class="hint-note" style="margin:0;">${escapeAttr(t("bdNoPhone"))}</span>`}</td>
          <td>${sent}</td>
          <td><button type="button" class="secondary small" data-bd-dl="${escapeAttr(key)}">${escapeAttr(t("bdDlShort"))}</button></td>
        </tr>`;
      })
      .join("");
    wrap.innerHTML = `<div class="rb-table-wrap"><table class="rb-table"><thead><tr><th></th><th>${escapeAttr(t("bdColName"))}</th><th>${escapeAttr(t("bdColDate"))}</th><th>${escapeAttr(t("bdColTurning"))}</th><th>${escapeAttr(t("bdColPhone"))}</th><th>${escapeAttr(t("bdColSent"))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  bdUpdateSendBtn();
}
function bdUpdateSendBtn() {
  const btn = document.getElementById("bd-send");
  btn.textContent = t("bdSendSelected").replace("{n}", fmt(BD.sel.size));
  btn.disabled = !BD.sel.size;
}
async function bdPreview(key) {
  const it = bdFind(key);
  if (!it) return;
  BD.previewKey = key;
  const canvas = await renderBirthdayCard(bdCardOpts(it));
  const pv = document.getElementById("bd-preview");
  pv.width = canvas.width;
  pv.height = canvas.height;
  pv.getContext("2d").drawImage(canvas, 0, 0);
  document.getElementById("bd-preview-wrap").classList.remove("hidden");
  document.getElementById("bd-preview-name").textContent = it.name;
  document.querySelectorAll("#bd-table tbody tr").forEach((tr) => {
    const b = tr.querySelector("[data-bd-preview]");
    tr.classList.toggle("bd-row-active", !!b && b.dataset.bdPreview === key);
  });
}
async function loadBirthdays() {
  if (!rbIsAdmin() || !document.getElementById("bd-card")) return;
  bdBuildMonths();
  bdLabelMonths();
  const scope = document.getElementById("bd-scope").value;
  document.getElementById("bd-month").classList.toggle("hidden", scope !== "month");
  const q = new URLSearchParams({ scope, month: document.getElementById("bd-month").value, family: document.getElementById("bd-family").checked ? "1" : "0" });
  try {
    const data = await api(`/api/admin/birthdays?${q}`);
    BD.items = data.items;
    BD.counts = data.counts;
    BD.sel = new Set([...BD.sel].filter((k) => BD.items.some((x) => bdKey(x) === k && x.phone)));
    bdRender();
    if (BD.previewKey && bdFind(BD.previewKey)) bdPreview(BD.previewKey);
    else if (BD.items.length) bdPreview(bdKey(BD.items[0]));
    else document.getElementById("bd-preview-wrap").classList.add("hidden");
  } catch (err) {
    showMsg(document.getElementById("bd-msg"), err.message, false);
  }
}
function bdCopyCard(it) {
  const blobP = bdCardBlob(it);
  BD.copy = (async () => {
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blobP })]);
        return "copied";
      }
    } catch (e) { /* fall through to a download */ }
    try { bdDownloadBlob(await blobP, it.name); return "downloaded"; } catch (e) { return "failed"; }
  })();
}
function bdSend() {
  const msg = document.getElementById("bd-msg");
  const people = BD.items.filter((x) => BD.sel.has(bdKey(x)) && x.phone);
  if (!people.length) return showMsg(msg, t("bdNeedSelect"), false);
  if (people.length > CREDS_BIG_BATCH && !confirm(`${fmt(people.length)} — ${t("credsBigBatch")}`)) return;
  waQueueStart({
    title: t("bdQueueTitle"),
    warn: t("bdQueueWarn"),
    items: people.map((it) => ({ label: `${it.name} — ${bdDateText(it)}`, it })),
    beforeOpen: (item) => bdCopyCard(item.it),
    async prepare(item) {
      const r = await api("/api/admin/birthdays/sent", { method: "POST", body: JSON.stringify({ membershipNumber: item.it.membershipNumber, dependentId: item.it.dependentId }) });
      item.it.sentAt = r.sentAt;
      return { phone: r.phone || item.it.phone, text: waBirthdayMessage(item.it.name) };
    },
    async afterOpen() {
      const res = BD.copy ? await BD.copy : "failed";
      showMsg(document.getElementById("creds-msg"), t(res === "copied" ? "bdCopied" : res === "downloaded" ? "bdDownloaded" : "bdCopyFailed"), res !== "failed");
    },
    onClose: () => loadBirthdays(),
  });
}
(function wireBirthdayCards() {
  const card = document.getElementById("bd-card");
  if (!card) return;
  ["bd-scope", "bd-month", "bd-family"].forEach((id) => document.getElementById(id).addEventListener("change", () => loadBirthdays()));
  document.getElementById("bd-showage").addEventListener("change", () => { if (BD.previewKey) bdPreview(BD.previewKey); });
  document.getElementById("bd-select-all").addEventListener("click", () => {
    BD.items.forEach((x) => { if (x.phone) BD.sel.add(bdKey(x)); });
    bdRender();
  });
  document.getElementById("bd-select-none").addEventListener("click", () => { BD.sel.clear(); bdRender(); });
  document.getElementById("bd-select-unsent").addEventListener("click", () => {
    BD.sel.clear();
    BD.items.forEach((x) => { if (x.phone && !x.sentAt) BD.sel.add(bdKey(x)); });
    bdRender();
  });
  document.getElementById("bd-send").addEventListener("click", bdSend);
  document.getElementById("bd-preview-dl").addEventListener("click", async () => {
    const it = bdFind(BD.previewKey);
    if (it) bdDownloadBlob(await bdCardBlob(it), it.name);
  });
  card.addEventListener("change", (e) => {
    const cb = e.target.closest && e.target.closest(".bd-sel");
    if (!cb) return;
    if (cb.checked) BD.sel.add(cb.value); else BD.sel.delete(cb.value);
    bdUpdateSendBtn();
  });
  card.addEventListener("click", async (e) => {
    const pv = e.target.closest("[data-bd-preview]");
    if (pv) return bdPreview(pv.dataset.bdPreview);
    const dl = e.target.closest("[data-bd-dl]");
    if (dl) {
      const it = bdFind(dl.dataset.bdDl);
      if (it) bdDownloadBlob(await bdCardBlob(it), it.name);
    }
  });
})();

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
    const glance = document.getElementById("admin-dashboard-glance");
    if (glance) glance.innerHTML = "";
  }
}
// Not-started/in-progress/completed/casual pill for a dashboard row's
// tournament column - mirrors tournamentActiveStatusLabel()'s wording for
// the three states a tournament object can already be in, plus the
// "no tournament record yet" state that only this table-level view needs.
function tournamentDashboardStatusInfo(row) {
  if (!row.tournamentStatus) return { label: t("tournStatusNotStarted"), cls: "not-started" };
  if (row.tournamentStatus === "completed") return { label: t("tournStatusCompleted"), cls: "completed" };
  if (row.tournamentFormat === "casual") return { label: t("tournStatusCasual"), cls: "casual" };
  return { label: t("tournStatusInProgress"), cls: "in-progress" };
}
// "Today" / "Tomorrow" / "In N days" for the glance row's next-event tile.
function daysUntilLabel(dateStr) {
  const diffMs = new Date(dateStr + "T00:00:00Z") - new Date(todayStr() + "T00:00:00Z");
  const diffDays = Math.round(diffMs / 86400000);
  if (diffDays <= 0) return t("glanceToday");
  if (diffDays === 1) return t("glanceTomorrow");
  return t("glanceInDays").replace("{n}", diffDays);
}
// Compact "at a glance" strip above the Event dashboard table - visible to
// Admin and Tournament Manager alike (unlike #admin-stats, which is
// admin-full-only and shows platform-wide totals a Tournament Manager has
// no access to). Built from the same upcoming-events rows the table itself
// renders, so no extra request.
function renderAdminDashboardGlance(rows) {
  const wrap = document.getElementById("admin-dashboard-glance");
  if (!wrap) return;
  if (!rows.length) {
    wrap.innerHTML = "";
    return;
  }
  const totalRegs = rows.reduce((sum, r) => sum + r.confirmedCount, 0);
  const totalWaitlist = rows.reduce((sum, r) => sum + r.waitlistCount, 0);
  const tournEligible = rows.filter((r) => !r.hasChildren);
  const tournDone = tournEligible.filter((r) => r.tournamentStatus === "completed").length;
  const next = rows[0];
  const tournamentsTile = tournEligible.length
    ? `<div class="stat"><div class="n">${fmt(tournDone)} / ${fmt(tournEligible.length)}</div><div class="l">${t("glanceTournamentsDone")}</div></div>`
    : "";
  wrap.innerHTML = `
    <div class="stat"><div class="n">${fmt(rows.length)}</div><div class="l">${t("glanceUpcomingEvents")}</div></div>
    <div class="stat"><div class="n">${fmt(totalRegs)}</div><div class="l">${t("glanceRegistrations")}</div></div>
    <div class="stat"><div class="n">${fmt(totalWaitlist)}</div><div class="l">${t("glanceWaitlisted")}</div></div>
    <div class="stat stat-accent"><div class="n">${escapeAttr(daysUntilLabel(next.date))}</div><div class="l">${escapeAttr(t("glanceNextEvent"))}: ${escapeAttr(eventLabel({ nameEn: next.nameEn, nameAr: next.nameAr }))}</div></div>
    ${tournamentsTile}
  `;
}
function renderAdminDashboardTable(rows) {
  const wrap = document.getElementById("admin-dashboard-table");
  renderAdminDashboardGlance(rows);
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
      // Parent "event day" posters have no tournament of their own (see
      // hasChildren on the /api/admin/dashboard row) - nothing to show or
      // jump to, so the column is a plain dash for those rows.
      const statusInfo = r.hasChildren ? null : tournamentDashboardStatusInfo(r);
      const tournCell = statusInfo
        ? `<span class="tourn-status-pill ${statusInfo.cls}">${escapeAttr(statusInfo.label)}</span>`
        : `<span class="hint-note">—</span>`;
      const tournBtn = r.hasChildren
        ? ""
        : `<button class="secondary small" data-tourn-jump="${r.eventId}">${t("btnOpenTournament")}</button>`;
      return `<tr>
        <td>${escapeAttr(eventLabel({ nameEn: r.nameEn, nameAr: r.nameAr }))}</td>
        <td>${escapeAttr(r.date)}</td>
        <td class="num">${capacityText}${minNote}</td>
        <td>${waitlistCell}</td>
        <td class="num">${fmt(r.checkedInCount)}</td>
        <td>${attendance}</td>
        <td>${tournCell}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="secondary small" data-hub-event="${r.eventId}" data-hub-label="${escapeAttr(eventLabel({ nameEn: r.nameEn, nameAr: r.nameAr }))}">${t("btnManageEvent")}</button>
          ${tournBtn}
        </td>
      </tr>`;
    })
    .join("");
  wrap.innerHTML = `<div class="dashboard-table-wrap"><table class="dashboard-table">
    <thead><tr>
      <th>${t("colEvent")}</th><th>${t("colDate")}</th><th>${t("colRegistrations")}</th>
      <th>${t("colWaitlist")}</th><th>${t("colCheckedIn")}</th><th>${t("colAttendance")}</th><th>${t("colTournament")}</th><th></th>
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
  wrap.querySelectorAll("[data-tourn-jump]").forEach((btn) => {
    btn.addEventListener("click", () => jumpToTournamentCard(Number(btn.dataset.tournJump)));
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
    event_registration_cancelled: "alActionEventRegistrationCancelled",
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
  wrap.innerHTML = rosterTableHtml(HUB_ROSTER, query, HUB_EVENT_ID, true);
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
// "Cancel registration" (Event Manage hub only - see showCancel in
// rosterTableHtml): opens a small modal asking for a short reason rather
// than acting immediately, since this removes someone else's spot on their
// behalf and the reason is kept in the activity log. Works the same way
// for a confirmed, checked-in, or waitlisted row - the backend endpoint
// handles all three (see POST /api/admin/registrations/:id/cancel).
let CANCEL_REG_ID = null;
document.getElementById("hub-checkin-wrap").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-cancel-reg]");
  if (!btn) return;
  openCancelRegModal(Number(btn.dataset.cancelReg), btn.dataset.cancelName);
});
document.getElementById("hub-checkin-wrap").addEventListener("click", (e) => {
  const waBtn = e.target.closest("[data-wa-confirm]");
  if (!waBtn) return;
  sendWhatsappConfirm(waBtn, document.getElementById("hub-checkin-msg"), () => loadHubRoster(true));
});
function openCancelRegModal(registrationId, attendeeName) {
  CANCEL_REG_ID = registrationId;
  document.getElementById("cancel-reg-name").textContent = attendeeName || "";
  document.getElementById("cancel-reg-reason").value = "";
  document.getElementById("cancel-reg-msg").textContent = "";
  document.getElementById("cancel-reg-modal").classList.remove("hidden");
}
function closeCancelRegModal() {
  document.getElementById("cancel-reg-modal").classList.add("hidden");
  CANCEL_REG_ID = null;
}
document.getElementById("cancel-reg-modal-close").addEventListener("click", closeCancelRegModal);
document.getElementById("cancel-reg-modal").addEventListener("click", (e) => {
  if (e.target.id === "cancel-reg-modal") closeCancelRegModal();
});
document.getElementById("cancel-reg-confirm-btn").addEventListener("click", async () => {
  const msg = document.getElementById("cancel-reg-msg");
  const reason = document.getElementById("cancel-reg-reason").value.trim();
  if (!reason) {
    showMsg(msg, t("cancelRegReasonRequired"), false);
    return;
  }
  const btn = document.getElementById("cancel-reg-confirm-btn");
  btn.disabled = true;
  try {
    const result = await api(`/api/admin/registrations/${CANCEL_REG_ID}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    closeCancelRegModal();
    const hubMsg = document.getElementById("hub-checkin-msg");
    showMsg(
      hubMsg,
      `${result.attendeeName} — ${t("cancelRegSuccess")}${result.promoted ? ` ${t("cancelRegPromotedNote")}` : ""}`,
      true
    );
    await loadHubRoster(true);
    loadAdminDashboard();
    loadAdminOverview();
  } catch (err) {
    showMsg(msg, err.message, false);
  } finally {
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
    wrap.innerHTML = rosterTableHtml(HUB_ROSTER, query, HUB_EVENT_ID, true);
    const checkedIn = HUB_ROSTER.filter((r) => r.checkedIn).length;
    const confirmed = HUB_ROSTER.filter((r) => !r.waitlisted).length;
    const waitlisted = HUB_ROSTER.length - confirmed;
    const hubEvent = EVENTS_DATA.find((e) => e.id === HUB_EVENT_ID);
    const capacityBadge =
      hubEvent && hubEvent.maxCapacity != null
        ? `<span class="tourn-summary-badge">${fmt(confirmed)} / ${fmt(hubEvent.maxCapacity)} ${t("colCapacity")}</span>`
        : "";
    document.getElementById("admin-hub-stats").innerHTML = `
      <span class="tourn-summary-badge">${fmt(confirmed)} ${t("colRegistrations")}</span>
      <span class="tourn-summary-badge">${fmt(checkedIn)} / ${fmt(confirmed)} ${t("colCheckedIn")}</span>
      <span class="tourn-summary-badge">${fmt(waitlisted)} ${t("colWaitlist")}</span>
      ${capacityBadge}
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
        <span class="tourn-summary-badge">${fmt(rollup.combined.waitlistCount)} ${t("colWaitlist")}</span>
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
  const upcoming = sortEventsForChooser(EVENTS_DATA.filter(isUpcoming));
  sel.innerHTML = upcoming.length
    ? upcoming.map((ev) => `<option value="${ev.id}">${escapeAttr(eventLabel(ev))} — ${ev.date}</option>`).join("")
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
  const upcoming = sortEventsForChooser(EVENTS_DATA.filter(isUpcoming));
  const noInviteOption = `<option value="">${t("optionNoInvite")}</option>`;
  sel.innerHTML =
    noInviteOption + upcoming.map((ev) => `<option value="${ev.id}">${escapeAttr(eventLabel(ev))} — ${ev.date}</option>`).join("");
  if (upcoming.some((ev) => String(ev.id) === prevValue)) sel.value = prevValue;
}

function renderMembersTable() {
  const wrap = document.getElementById("members-table");
  if (!MEMBERS_DATA.length) {
    wrap.innerHTML = `<p class="dashboard-empty-note">${t("noMembersYet")}</p>`;
    return;
  }
  const rows = MEMBERS_DATA.map((m) => {
    const searchBlob = escapeAttr(searchNorm(`${m.name} ${m.membershipNumber} ${m.phone} ${m.familyGroup}`));
    return `<tr data-member-row data-search="${searchBlob}">
      <td><input type="checkbox" data-member-checkbox value="${escapeAttr(m.membershipNumber)}" /></td>
      <td>${escapeAttr(m.membershipNumber)}</td>
      <td>${escapeAttr(m.name)}</td>
      <td>${escapeAttr(m.phone)}</td>
      <td>${escapeAttr(m.familyGroup)}</td>
      <td>${escapeAttr(ageGroupLabel(m.ageGroup))}</td>
      <td class="num" style="white-space:nowrap;">${m.birthDate ? escapeAttr(birthDateText(m.birthDate)) : "—"}</td>
      <td class="num">${m.age != null ? escapeAttr(m.age) : "—"}</td>
      <td>${m.hasLoggedInAccount ? t("yesLabel") : t("noLabel")}</td>
      <td>${m.hasClaimCode ? t("yesLabel") : t("noLabel")}</td>
    </tr>`;
  }).join("");
  wrap.innerHTML = `<div class="dashboard-table-wrap"><table class="dashboard-table">
    <thead><tr>
      <th><input type="checkbox" data-select-all-members title="${escapeAttr(t("selectAllLabel"))}" aria-label="${escapeAttr(t("selectAllLabel"))}" /></th>
      <th>${t("colMembershipNumber")}</th><th>${t("colName")}</th>
      <th>${t("colPhone")}</th><th>${t("colFamilyGroup")}</th><th>${t("colAgeGroup")}</th><th>${t("colBirthYear")}</th><th>${t("colAge")}</th><th>${t("colHasAccount")}</th><th>${t("colHasClaimCode")}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
  applyMembersSearchFilter();
  updateMembersSelectAllState();
}

// Filtering hides/shows existing rows rather than rebuilding the table, so
// any checkboxes the admin already ticked survive typing in the search box.
function applyMembersSearchFilter() {
  const query = searchNorm(document.getElementById("members-search").value);
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
  const ageGroup = document.getElementById("member-add-age-group").value;
  const birthDate = document.getElementById("member-add-birthdate").value;
  const claimCode = document.getElementById("member-add-claimcode").value.trim();
  const eventId = document.getElementById("member-add-event").value;
  if (!membershipNumber || !name) {
    highlightMissingFields(["member-add-number", "member-add-name"]);
    return showMsg(msg, t("pleaseFillMembershipAndName"), false);
  }
  try {
    const result = await api("/api/admin/members", {
      method: "POST",
      body: JSON.stringify({ membershipNumber, name, phone, familyGroup, ageGroup, birthDate, claimCode }),
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
    document.getElementById("member-add-age-group").value = "";
    document.getElementById("member-add-birthdate").value = "";
    document.getElementById("member-add-claimcode").value = "";
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

// Search normaliser shared by the directory boxes: case, Arabic diacritics,
// alef/yaa/taa-marbuta spelling variants, Arabic-Indic digits and extra spaces
// are all ignored so "احمد" finds "أحمد" and "هانى" finds "هاني".
function searchNorm(str) {
  return String(str == null ? "" : str)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
    .replace(/\u0649/g, "\u064A")
    .replace(/\u0629/g, "\u0647")
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/\s+/g, " ")
    .trim();
}

// "Filter by event": options come from the events members are actually
// registered for (newest first). The selection survives re-renders / language switches.
function populateDirectoryEventFilter() {
  const sel = document.getElementById("dir-f-event");
  if (!sel) return;
  const prev = sel.value;
  const seen = new Map();
  for (const m of DIRECTORY_DATA) {
    for (const r of m.registrations || []) {
      if (!seen.has(r.eventId)) seen.set(r.eventId, { id: r.eventId, label: bilingual(r.nameEn, r.nameAr) || `#${r.eventId}`, date: r.date || "" });
    }
  }
  const list = Array.from(seen.values()).sort((x, y) => (y.date || "").localeCompare(x.date || "") || y.id - x.id);
  sel.innerHTML =
    `<option value="">${escapeAttr(t("dirFilterEventAll"))}</option>` +
    list.map((e) => `<option value="${e.id}">${escapeAttr(e.label)}${e.date ? " — " + escapeAttr(e.date) : ""}</option>`).join("");
  if (prev && seen.has(Number(prev))) sel.value = prev;
}
function renderDirectoryTable() {
  const wrap = document.getElementById("directory-table");
  if (!DIRECTORY_DATA.length) {
    wrap.innerHTML = `<p class="dashboard-empty-note">${t("noMembersYet")}</p>`;
    return;
  }
  populateDirectoryEventFilter();
  const rows = DIRECTORY_DATA.map((m, i) => {
    // The blob also carries every family member's name / phone / email, so
    // searching a child's name finds the parent's row (it used to be invisible).
    const searchBlob = escapeAttr(
      searchNorm(
        `${m.name} ${m.membershipNumber} ${m.phone} ${m.email || ""} ${m.familyGroup} ${m.relationshipToMain || ""} ` +
          (m.dependents || []).map((d) => `${d.name || ""} ${d.phone || ""} ${d.email || ""}`).join(" ")
      )
    );
    const dependentsHtml = m.dependents.length
      ? `<ul class="directory-list">${m.dependents
          .map((d) => {
            const bits = [d.relationship, d.birthDate ? ageGroupLabel(effectiveAgeGroup(d)) : d.ageGroup ? ageGroupLabel(d.ageGroup) : "", d.birthDate ? bornAgeText(d) : "", d.phone, d.email].filter(Boolean).map(escapeAttr).join(" · ");
            return `<li>${escapeAttr(d.name)}${bits ? ` <span style="color:var(--muted);">(${bits})</span>` : ""}</li>`;
          })
          .join("")}</ul>`
      : `<p class="dashboard-empty-note">${t("noDependents")}</p>`;
    // Admin age-group editor: one row for the member plus one per family
    // member, so accounts created before age group became mandatory can be
    // completed from here (PUT /api/admin/members/:n/age-group).
    const ageRow = (label, person, depId) =>
      `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0;">
        <span style="min-width:120px;">${escapeAttr(label)}</span>
        <input type="date" class="dir-birth-input" data-me="${escapeAttr(m.membershipNumber)}" data-dep="${depId == null ? "" : depId}" value="${escapeAttr(person.birthDate || "")}" min="1900-01-01" max="${todayISO()}" style="max-width:160px;padding:4px 6px;font-size:0.8rem;" />
        ${
          person.birthDate
            ? `<span class="fam-rel-badge dir-birth-badge" data-me="${escapeAttr(m.membershipNumber)}" data-dep="${depId == null ? "" : depId}">${escapeAttr(ageGroupLabel(effectiveAgeGroup(person)) + " · " + bornAgeText(person))}</span>`
            : `<select class="dir-age-select" data-me="${escapeAttr(m.membershipNumber)}" data-dep="${depId == null ? "" : depId}" style="max-width:200px;padding:4px 6px;font-size:0.8rem;">${ageGroupOptionsHtml(person.ageGroup || "")}</select>`
        }
        <button class="secondary dir-age-save" data-me="${escapeAttr(m.membershipNumber)}" data-dep="${depId == null ? "" : depId}" style="padding:3px 10px;font-size:0.75rem;">${t("btnSaveShort")}</button>
      </div>`;
    const ageEditorHtml = `<div style="margin-top:14px;">
        <h4 style="margin:6px 0;">${t("directoryAgeGroupsTitle")}</h4>
        ${m.birthRequestAt ? `<p class="hint-note" style="margin:0 0 6px;">${escapeAttr(t("birthReqAskedOn"))}: ${escapeAttr(new Date(m.birthRequestAt).toLocaleDateString())}</p>` : ""}
        ${ageRow(m.name, m, null)}
        ${m.dependents.map((d) => ageRow(d.name, d, d.id)).join("")}
        <div class="msg dir-age-msg" data-me="${escapeAttr(m.membershipNumber)}"></div>
      </div>`;
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
    const archived = !!m.archivedAt;
    const badges =
      (archived ? ` <span class="dir-badge archived">${t("archivedBadge")}</span>` : "") +
      (!m.hasLoggedInAccount ? ` <span class="dir-badge nologin">${t("noLoginBadge")}</span>` : m.mustChangePassword ? ` <span class="dir-badge temp">${t("tempPasswordBadge")}</span>` : "");
    const dataAttrs = [
      `data-status="${archived ? "archived" : "active"}"`,
      `data-account="${m.hasLoggedInAccount ? "has" : "none"}"`,
      `data-must="${m.mustChangePassword ? "1" : "0"}"`,
      `data-age="${m.ageGroup || "none"}"`,
      `data-evs="|${(m.registrations || []).map((r) => `${r.eventId}:${r.waitlisted ? "w" : r.checkedIn ? "i" : "c"}`).join("|")}|"`,
      `data-nobirth="${!m.birthDate || (m.dependents || []).some((d) => !d.birthDate) ? "1" : "0"}"`,
      `data-type="${m.memberType === "follower" ? "follower" : "main"}"`,
      `data-act="${m.checkedInCount > 0 ? "attended" : m.registeredCount > 0 ? "registered" : "never"}"`,
      `data-phone="${m.phone ? "1" : "0"}"`,
    ].join(" ");
    // Admin-only manual points editor. Changes are stored as an adjustment
    // (never overwrites history) and always require a reason.
    const adjHistory = (m.adjustments || []).length
      ? `<ul class="directory-list">${m.adjustments
          .map(
            (a) =>
              `<li><b class="${a.delta >= 0 ? "pos" : "neg"}">${a.delta >= 0 ? "+" : ""}${fmt(a.delta)}</b> · ${escapeAttr(a.reason)} <span style="color:var(--muted);">(${escapeAttr((a.createdAt || "").slice(0, 10))}${a.byName ? " · " + escapeAttr(a.byName) : ""})</span></li>`
          )
          .join("")}</ul>`
      : `<p class="dashboard-empty-note">${t("pointsEditNone")}</p>`;
    const me = escapeAttr(m.membershipNumber);
    const pointsEditorHtml = `<div class="dir-points-editor" style="margin-top:14px;">
        <h4 style="margin:6px 0;">${t("pointsEditTitle")}</h4>
        <p class="hint-note" style="margin:0 0 6px;">${t("pointsEditBalance")}: <b>${fmt(m.balance)}</b>${m.familyPooled ? ` · ${t("pointsEditPooledNote")}` : ""}</p>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          <select class="dir-pts-mode" data-me="${me}" style="max-width:190px;padding:5px 6px;font-size:0.8rem;">
            <option value="add">${t("pointsModeAdd")}</option>
            <option value="set">${t("pointsModeSet")}</option>
          </select>
          <input class="dir-pts-amount" data-me="${me}" type="number" step="1" placeholder="${t("pointsEditAmount")}" style="max-width:120px;padding:5px 8px;font-size:0.8rem;" />
          <input class="dir-pts-reason" data-me="${me}" type="text" maxlength="200" placeholder="${t("pointsEditReason")}" style="flex:1;min-width:180px;padding:5px 8px;font-size:0.8rem;" />
          <button class="secondary dir-pts-save" data-me="${me}" style="padding:5px 12px;font-size:0.78rem;">${t("pointsEditSave")}</button>
        </div>
        <div class="msg dir-pts-msg" data-me="${me}"></div>
        <h4 style="margin:10px 0 4px;">${t("pointsEditHistory")}</h4>
        ${adjHistory}
      </div>`;
    const sendCredsHtml = archived
      ? ""
      : `<div style="margin-top:14px;"><button type="button" class="roster-btn wa dir-send-one" data-me="${me}">${t("btnSendCredsRow")}</button></div>`;
    return `<tr data-directory-row data-search="${searchBlob}" ${dataAttrs}${archived ? ' class="dir-archived"' : ""}>
        <td><input type="checkbox" class="dir-sel" value="${me}" aria-label="${me}" /></td>
        <td>${escapeAttr(m.membershipNumber)}</td>
        <td>${escapeAttr(m.name)}${memberTypeBadge}${badges}</td>
        <td style="white-space:nowrap;">${m.ageGroup ? escapeAttr(ageGroupLabel(m.ageGroup)) : `<span class="fam-age-missing">—</span>`}</td>
        <td class="num dir-birth-cell" data-me="${me}" style="white-space:nowrap;">${m.birthDate ? escapeAttr(birthDateText(m.birthDate)) : `<span class="fam-age-missing">—</span>`}</td>
        <td class="num">${m.age != null ? escapeAttr(m.age) : `<span class="fam-age-missing">—</span>`}</td>
        <td>${escapeAttr(m.phone)}</td>
        <td>${escapeAttr(m.email || "")}</td>
        <td>${escapeAttr(m.familyGroup)}</td>
        <td class="num">${fmt(m.balance)}</td>
        <td class="num">${fmt(m.registeredCount)}</td>
        <td class="num">${fmt(m.checkedInCount)}</td>
        <td><button class="secondary" data-directory-toggle="${i}" style="padding:3px 10px;font-size:0.78rem;">${t("btnDetails")}</button></td>
      </tr>
      <tr data-directory-row data-search="${searchBlob}" ${dataAttrs} data-directory-detail="${i}" data-open="false" class="hidden">
        <td colspan="13">
          <div class="grid-2">
            <div><h4 style="margin:6px 0;">${t("colFamilyMembers")}</h4>${dependentsHtml}</div>
            <div><h4 style="margin:6px 0;">${t("colRegistrations")}</h4>${regsHtml}</div>
          </div>
          ${ageEditorHtml}
          ${pointsEditorHtml}
          ${familyLinkHtml}
          ${sendCredsHtml}
        </td>
      </tr>`;
  }).join("");
  wrap.innerHTML = `<div class="dashboard-table-wrap"><table class="dashboard-table">
    <thead><tr>
      <th></th><th>${t("colMembershipNumber")}</th><th>${t("colName")}</th><th>${t("colAgeGroup")}</th><th>${t("colBirthYear")}</th><th>${t("colAge")}</th><th>${t("colPhone")}</th><th>${t("colEmail")}</th>
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
  wrap.querySelectorAll(".dir-age-save").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const me = btn.dataset.me;
      const dep = btn.dataset.dep;
      const sel = wrap.querySelector(`.dir-age-select[data-me="${me}"][data-dep="${dep}"]`);
      const birthIn = wrap.querySelector(`.dir-birth-input[data-me="${me}"][data-dep="${dep}"]`);
      const msg = wrap.querySelector(`.dir-age-msg[data-me="${me}"]`);
      const depId = dep === "" ? undefined : Number(dep);
      try {
        const m = DIRECTORY_DATA.find((x) => x.membershipNumber === me);
        const holder = m ? (dep === "" ? m : m.dependents.find((x) => String(x.id) === dep)) : null;
        if (birthIn && birthIn.value && (!holder || birthIn.value !== holder.birthDate)) {
          if (birthIn.value > todayISO() || birthIn.value < "1900-01-01") return showMsg(msg, t("errBirthDateInvalid"), false);
          const r = await api(`/api/admin/members/${encodeURIComponent(me)}/birth-date`, {
            method: "PUT",
            body: JSON.stringify({ birthDate: birthIn.value, dependentId: depId }),
          });
          if (holder) Object.assign(holder, { birthDate: r.birthDate, birthYear: r.birthYear, age: r.age, ageGroup: r.ageGroup });
          const badgeText = `${ageGroupLabel(effectiveAgeGroup({ birthDate: r.birthDate, ageGroup: r.ageGroup }))} · ${bornAgeText({ birthDate: r.birthDate })}`;
          let badge = wrap.querySelector(`.dir-birth-badge[data-me="${me}"][data-dep="${dep}"]`);
          if (!badge) {
            badge = document.createElement("span");
            badge.className = "fam-rel-badge dir-birth-badge";
            badge.dataset.me = me;
            badge.dataset.dep = dep;
            if (sel) sel.replaceWith(badge); else birthIn.after(badge);
          }
          badge.textContent = badgeText;
          if (dep === "") {
            const cell = wrap.querySelector(`.dir-birth-cell[data-me="${me}"]`);
            if (cell) cell.textContent = birthDateText(r.birthDate);
          }
          showMsg(msg, `${t("okAgeGroupSavedShort")} — ${badgeText}`, true);
          return;
        }
        if (!sel || !sel.value) return showMsg(msg, t("errBirthDateRequired"), false);
        await api(`/api/admin/members/${encodeURIComponent(me)}/age-group`, {
          method: "PUT",
          body: JSON.stringify({ ageGroup: sel.value, dependentId: depId }),
        });
        if (holder) holder.ageGroup = sel.value;
        showMsg(msg, t("okAgeGroupSavedShort"), true);
      } catch (e) {
        showMsg(msg, e.message, false);
      }
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
  wrap.querySelectorAll(".dir-pts-save").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const me = btn.dataset.me;
      const q = (cls) => wrap.querySelector(`.${cls}[data-me="${me}"]`);
      const msg = q("dir-pts-msg");
      const mode = q("dir-pts-mode").value;
      const raw = q("dir-pts-amount").value.trim();
      const reason = q("dir-pts-reason").value.trim();
      if (!/^-?\d+$/.test(raw)) return showMsg(msg, t("errPointsAmount"), false);
      if (!reason) return showMsg(msg, t("errPointsReason"), false);
      btn.disabled = true;
      try {
        await api(`/api/admin/members/${encodeURIComponent(me)}/points-adjust`, {
          method: "POST",
          body: JSON.stringify({ mode, amount: Number(raw), reason }),
        });
        const openIdx = Array.from(wrap.querySelectorAll("[data-directory-detail][data-open='true']")).map((r) => r.dataset.directoryDetail);
        await loadAdminDirectory();
        openIdx.forEach((idx) => {
          const row = wrap.querySelector(`[data-directory-detail="${idx}"]`);
          const tgl = wrap.querySelector(`[data-directory-toggle="${idx}"]`);
          if (row && tgl) tgl.click();
        });
        const m2 = wrap.querySelector(`.dir-pts-msg[data-me="${me}"]`);
        if (m2) showMsg(m2, t("pointsEditSaved"), true);
      } catch (e) {
        showMsg(msg, e.message, false);
        btn.disabled = false;
      }
    });
  });
  wrap.querySelectorAll(".dir-send-one").forEach((btn) => {
    btn.addEventListener("click", () => credsStart([btn.dataset.me]));
  });
  wrap.querySelectorAll(".dir-sel").forEach((cb) => cb.addEventListener("change", updateDirectorySelectionUI));
  applyDirectorySearchFilter();
}

// A detail row is visible only when BOTH its summary row matches the search
// AND the admin has explicitly opened it via the "Details" button - so
// typing in the search box never forces a detail panel open, and it also
// doesn't leave a stale open panel visible once its member is filtered out.
function directoryFilterState() {
  const v = (id) => document.getElementById(id).value;
  return {
    query: searchNorm(v("directory-search")),
    status: v("dir-f-status"),
    account: v("dir-f-account"),
    age: v("dir-f-age"),
    type: v("dir-f-type"),
    act: v("dir-f-act"),
    phone: v("dir-f-phone"),
    event: v("dir-f-event"),
    evstatus: v("dir-f-evstatus"),
  };
}
function directoryRowMatches(row, f) {
  const d = row.dataset;
  if (f.query && !d.search.includes(f.query)) return false;
  if (f.status !== "all" && d.status !== f.status) return false;
  if (f.account === "has" && d.account !== "has") return false;
  if (f.account === "none" && d.account !== "none") return false;
  if (f.account === "must" && d.must !== "1") return false;
  if (f.age === "nobirth") { if (d.nobirth !== "1") return false; }
  else if (f.age && d.age !== f.age) return false;
  if (f.type && d.type !== f.type) return false;
  if (f.act && d.act !== f.act) return false;
  if (f.event || f.evstatus) {
    // data-evs looks like "|12:c|15:w|" (c confirmed, i checked in, w waiting list)
    const codes = [];
    const re = /\|(\d+):([ciw])/g;
    let mm;
    while ((mm = re.exec(d.evs || "")) !== null) if (!f.event || mm[1] === f.event) codes.push(mm[2]);
    const okCode = (c) =>
      !f.evstatus ||
      (f.evstatus === "confirmed" && (c === "c" || c === "i")) ||
      (f.evstatus === "waitlisted" && c === "w") ||
      (f.evstatus === "checkedin" && c === "i") ||
      (f.evstatus === "notchecked" && c === "c");
    if (!codes.some(okCode)) return false;
  }
  if (f.phone === "has" && d.phone !== "1") return false;
  if (f.phone === "missing" && d.phone !== "0") return false;
  return true;
}
function applyDirectorySearchFilter() {
  const f = directoryFilterState();
  let shown = 0;
  let total = 0;
  document.querySelectorAll("#directory-table [data-directory-row]").forEach((row) => {
    const matches = directoryRowMatches(row, f);
    if (row.hasAttribute("data-directory-detail")) {
      row.classList.toggle("hidden", !matches || row.dataset.open !== "true");
    } else {
      total++;
      if (matches) shown++;
      row.classList.toggle("hidden", !matches);
    }
  });
  const count = document.getElementById("dir-count");
  if (count) count.textContent = DIRECTORY_DATA.length ? `${t("dirShowing")} ${fmt(shown)} / ${fmt(total)}` : "";
  updateDirectorySelectionUI();
}
["directory-search", "dir-f-status", "dir-f-account", "dir-f-age", "dir-f-type", "dir-f-act", "dir-f-phone", "dir-f-event", "dir-f-evstatus"].forEach((id) => {
  document.getElementById(id).addEventListener(id === "directory-search" ? "input" : "change", applyDirectorySearchFilter);
});

// ---- selection + bulk actions (archive / restore / delete / credentials) ----
// Only checked rows that are ALSO currently visible count, so a filter change
// can never leave a hidden member silently selected for a destructive action.
function directorySelected() {
  return Array.from(document.querySelectorAll("#directory-table .dir-sel:checked"))
    .filter((cb) => !cb.closest("tr").classList.contains("hidden"))
    .map((cb) => cb.value);
}
function updateDirectorySelectionUI() {
  const el = document.getElementById("dir-sel-count");
  if (!el) return;
  const n = directorySelected().length;
  el.textContent = n ? `${fmt(n)} ${t("dirSelected")}` : "";
  ["dir-send-creds", "dir-birth-request", "dir-archive", "dir-restore", "dir-delete"].forEach((id) => {
    document.getElementById(id).disabled = !n;
  });
}
document.getElementById("dir-select-visible").addEventListener("click", () => {
  document.querySelectorAll("#directory-table tr[data-directory-row]:not([data-directory-detail]):not(.hidden) .dir-sel").forEach((cb) => (cb.checked = true));
  updateDirectorySelectionUI();
});
document.getElementById("dir-clear-sel").addEventListener("click", () => {
  document.querySelectorAll("#directory-table .dir-sel").forEach((cb) => (cb.checked = false));
  updateDirectorySelectionUI();
});
async function directoryBulk(action) {
  const msg = document.getElementById("dir-action-msg");
  const nums = directorySelected();
  if (!nums.length) return;
  const body = { action, membershipNumbers: nums };
  if (action === "archive" && !confirm(`${t("confirmArchiveMembers")} (${fmt(nums.length)})`)) return;
  if (action === "restore" && !confirm(`${t("confirmRestoreMembers")} (${fmt(nums.length)})`)) return;
  if (action === "delete") {
    const typed = window.prompt(`${t("confirmDeleteMembers")} (${fmt(nums.length)})`);
    if (typed !== "DELETE") return;
    body.confirm = "DELETE";
  }
  try {
    const r = await api("/api/admin/members/bulk", { method: "POST", body: JSON.stringify(body) });
    const fails = (r.results || []).filter((x) => !x.ok).map((x) => `#${x.membershipNumber}: ${x.error}`);
    await loadAdminDirectory();
    showMsg(msg, `${t("bulkDone")}: ${fmt(r.done)} · ${t("bulkFailed")}: ${fmt(r.failed)}${fails.length ? "\n" + fails.slice(0, 8).join("\n") : ""}`, !r.failed);
    msg.style.whiteSpace = "pre-line";
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}
document.getElementById("dir-archive").addEventListener("click", () => directoryBulk("archive"));
document.getElementById("dir-restore").addEventListener("click", () => directoryBulk("restore"));
document.getElementById("dir-delete").addEventListener("click", () => directoryBulk("delete"));
document.getElementById("dir-send-creds").addEventListener("click", () => credsStart(directorySelected()));

// ---- sending login details over WhatsApp (one wa.me chat per member) --------
// A fresh temporary password is generated on the server only when the admin
// presses "Open WhatsApp" for that member, so skipped members keep whatever
// password they had. Each chat is opened by a human click, with a short
// cool-down between sends, so this never looks like automated bulk sending.
// ---- Ask members who have no date of birth on file to add it --------------
const BIRTH_REQ_BATCH = 15; // keep chats per sitting small - WhatsApp restricts accounts that message many people at once
const BIRTH_REQ_RECENT_DAYS = 7;
function waBirthRequestMessage(name, missing, url) {
  const self = missing.some((x) => x.self);
  const others = missing.filter((x) => !x.self).map((x) => x.name);
  const arWho = self ? (others.length ? `بتاريخ ميلادك وتاريخ ميلاد: ${others.join("، ")}` : "بتاريخ ميلادك") : `بتاريخ ميلاد: ${others.join("، ")}`;
  const enWho = self ? (others.length ? `your date of birth and the date of birth of: ${others.join(", ")}` : "your date of birth") : `the date of birth of: ${others.join(", ")}`;
  const ar = `مرحبًا ${name}،\nنرجو تزويدنا ${arWho} على منصة أهلاوي، ليُحدَّد التصنيف العمري المناسب للفعاليات.\nسجّل الدخول من: ${url} ثم افتح "الملف الشخصي"، أو ردّ على هذه الرسالة بالتاريخ (يوم/شهر/سنة).\n- لجنة الرياضة الترفيهية - فرع القاهرة الجديدة\nإن لم ترغب في استلام رسائل من اللجنة ردّ بكلمة: إيقاف.`;
  const en = `Hi ${name},\nPlease share ${enWho} on the MyAhlawy platform so we can place everyone in the right age group for events.\nLog in at ${url} and open "Member Profile", or simply reply to this message with the date (day/month/year).\n- Recreational Sports Committee — New Cairo Branch\nIf you prefer not to receive messages from the committee, reply: STOP.`;
  return `${ar}\n\n${en}`;
}
function birthRequestStart(numbers) {
  const msg = document.getElementById("dir-action-msg");
  const members = numbers.map((n) => DIRECTORY_DATA.find((m) => m.membershipNumber === n)).filter(Boolean).filter((m) => !m.archivedAt);
  const missingOf = (m) => (!m.birthDate ? 1 : 0) + (m.dependents || []).filter((d) => !d.birthDate).length;
  const withMissing = members.filter((m) => missingOf(m) > 0);
  const withPhone = withMissing.filter((m) => m.phone);
  const cutoff = Date.now() - BIRTH_REQ_RECENT_DAYS * 86400000;
  const recent = withPhone.filter((m) => m.birthRequestAt && Date.parse(m.birthRequestAt) > cutoff);
  const queue = withPhone.filter((m) => !recent.includes(m));
  if (!queue.length) return showMsg(msg, t("birthReqNone"), false);
  const notes = [];
  if (members.length - withMissing.length) notes.push(`${fmt(members.length - withMissing.length)} ${t("birthReqSkipHave")}`);
  if (withMissing.length - withPhone.length) notes.push(`${fmt(withMissing.length - withPhone.length)} ${t("credsNoPhone")}`);
  if (recent.length) notes.push(`${fmt(recent.length)} ${t("birthReqSkipRecent")}`);
  if (notes.length) showMsg(msg, notes.join(" · "), true);
  if (queue.length > BIRTH_REQ_BATCH && !confirm(`${fmt(queue.length)} — ${t("birthReqBigBatch")}`)) return;
  waQueueStart({
    title: t("birthReqTitle"),
    warn: t("birthReqWarn"),
    items: queue.map((m) => ({ label: `${m.name} (${m.membershipNumber})`, m })),
    async prepare(item) {
      const r = await api(`/api/admin/members/${encodeURIComponent(item.m.membershipNumber)}/birthdate-request`, { method: "POST", body: JSON.stringify({}) });
      item.m.birthRequestAt = r.birthRequestAt;
      return { phone: r.phone || item.m.phone, text: waBirthRequestMessage(r.name || item.m.name, r.missing || [], r.loginUrl) };
    },
    onClose: () => { try { applyDirectorySearchFilter(); } catch (e) { /* ignore */ } },
  });
}
document.getElementById("dir-birth-request").addEventListener("click", () => birthRequestStart(directorySelected()));
function waCredentialsMessage(name, num, pw, url) {
  const ar = `مرحبًا ${name}،\nبيانات الدخول إلى منصة أهلاوي (لجنة الرياضة الترفيهية - فرع القاهرة الجديدة):\nرابط الدخول: ${url}\nاسم المستخدم (رقم العضوية): ${num}\nكلمة المرور المؤقتة: ${pw}\nسيُطلب منك تغيير كلمة المرور عند أول دخول. من فضلك لا تشارك هذه البيانات مع أحد.`;
  const en = `Hi ${name},\nYour MyAhlawy login (Recreational Sports Committee — New Cairo Branch):\nLogin page: ${url}\nUsername (membership number): ${num}\nTemporary password: ${pw}\nYou will be asked to change the password the first time you sign in. Please do not share these details.`;
  return `${ar}\n\n${en}`;
}
const CREDS_COOLDOWN_SECONDS = 8;
const CREDS_BIG_BATCH = 30;
let CREDS = null;
let CREDS_TIMER = null;
// Generic one-chat-at-a-time WhatsApp queue shared by member credentials and
// the staff messages. cfg = { title, warn, items:[{label,...}], prepare(item)
// -> Promise<{phone,text}>, after(item) }.
function waQueueStart(cfg) {
  CREDS = { queue: cfg.items, idx: 0, sent: 0, skipped: 0, cfg };
  document.getElementById("creds-title").textContent = cfg.title;
  document.getElementById("creds-warn").textContent = cfg.warn;
  document.getElementById("creds-modal").classList.remove("hidden");
  credsRender();
}
function credsStart(numbers) {
  const msg = document.getElementById("dir-action-msg");
  const members = numbers.map((n) => DIRECTORY_DATA.find((m) => m.membershipNumber === n)).filter(Boolean);
  const queue = members.filter((m) => !m.archivedAt && m.phone);
  const noPhone = members.filter((m) => !m.archivedAt && !m.phone).length;
  if (!queue.length) return showMsg(msg, t("credsNoPhone"), false);
  if (noPhone) showMsg(msg, `${fmt(noPhone)} ${t("credsNoPhone")}`, false);
  const hasPw = queue.filter((m) => m.hasLoggedInAccount).length;
  if (hasPw && !confirm(`${fmt(hasPw)} ${t("credsReplaceConfirm")}`)) return;
  if (queue.length > CREDS_BIG_BATCH && !confirm(`${fmt(queue.length)} — ${t("credsBigBatch")}`)) return;
  waQueueStart({
    title: t("credsTitle"),
    warn: t("credsWarn"),
    items: queue.map((m) => ({ label: `${m.name} (${m.membershipNumber})`, m })),
    async prepare(item) {
      const r = await api(`/api/admin/members/${encodeURIComponent(item.m.membershipNumber)}/send-credentials`, {
        method: "POST",
        body: JSON.stringify({ replaceExisting: true }),
      });
      item.m.hasLoggedInAccount = true;
      item.m.mustChangePassword = true;
      return { phone: r.phone || item.m.phone, text: waCredentialsMessage(r.name || item.m.name, r.membershipNumber, r.tempPassword, r.loginUrl) };
    },
  });
}
function credsStopTimer() {
  if (CREDS_TIMER) clearInterval(CREDS_TIMER);
  CREDS_TIMER = null;
}
function credsRender() {
  const c = CREDS;
  const openBtn = document.getElementById("creds-open");
  const skipBtn = document.getElementById("creds-skip");
  credsStopTimer();
  document.getElementById("creds-msg").classList.remove("show");
  if (c.idx >= c.queue.length) {
    document.getElementById("creds-progress").textContent = t("credsDone");
    document.getElementById("creds-name").textContent = `${fmt(c.sent)} ${t("credsSentWord")} · ${fmt(c.skipped)} ${t("credsSkippedWord")}`;
    openBtn.classList.add("hidden");
    skipBtn.textContent = t("waBulkClose");
    return;
  }
  const item = c.queue[c.idx];
  document.getElementById("creds-progress").textContent = `${t("credsProgress")} ${fmt(c.idx + 1)} / ${fmt(c.queue.length)}`;
  document.getElementById("creds-name").textContent = item.label;
  openBtn.classList.remove("hidden");
  openBtn.disabled = false;
  openBtn.textContent = t("credsOpen");
  skipBtn.textContent = t("waBulkSkip");
}
function credsCooldown() {
  const openBtn = document.getElementById("creds-open");
  let left = CREDS_COOLDOWN_SECONDS;
  openBtn.disabled = true;
  openBtn.textContent = `${t("credsWait")} ${left}`;
  credsStopTimer();
  CREDS_TIMER = setInterval(() => {
    left--;
    if (left <= 0) {
      credsStopTimer();
      openBtn.disabled = false;
      openBtn.textContent = t("credsOpen");
    } else {
      openBtn.textContent = `${t("credsWait")} ${left}`;
    }
  }, 1000);
}
function credsClose() {
  credsStopTimer();
  document.getElementById("creds-modal").classList.add("hidden");
  const after = CREDS && CREDS.cfg && CREDS.cfg.onClose;
  CREDS = null;
  if (after) after();
  else loadAdminDirectory();
}
document.getElementById("creds-close").addEventListener("click", credsClose);
document.getElementById("creds-skip").addEventListener("click", () => {
  const c = CREDS;
  if (!c) return;
  if (c.idx >= c.queue.length) return credsClose();
  c.skipped++;
  c.idx++;
  credsRender();
});
document.getElementById("creds-open").addEventListener("click", async () => {
  const c = CREDS;
  if (!c || c.idx >= c.queue.length) return;
  const item = c.queue[c.idx];
  const btn = document.getElementById("creds-open");
  const msg = document.getElementById("creds-msg");
  btn.disabled = true;
  // Runs synchronously inside the click (e.g. copy the birthday card to the clipboard).
  if (c.cfg.beforeOpen) c.cfg.beforeOpen(item);
  try {
    const { phone, text } = await c.cfg.prepare(item);
    const href = waLink(phone, text);
    if (!href) throw new Error(t("waNoPhoneNote"));
    window.open(href, "_blank", "noopener");
    c.sent++;
    c.idx++;
    credsRender();
    if (c.cfg.afterOpen) c.cfg.afterOpen(item);
    if (c.idx < c.queue.length) credsCooldown();
  } catch (e) {
    showMsg(msg, e.message, false);
    btn.disabled = false;
  }
});

// ---- Staff accounts: phone numbers + WhatsApp messages ----------------------
let STAFF_ACCOUNTS_DATA = [];
function waStaffCredentialsMessage(name, username, pw, url) {
  const ar = `مرحبًا ${name}،\nبيانات دخولك إلى منصة أهلاوي (لجنة الرياضة الترفيهية - فرع القاهرة الجديدة):\nرابط الموقع: ${url}\nاضغط على تبويب «الإدارة» أو «ماسح البوابة» ثم سجّل الدخول.\nاسم المستخدم: ${username}\nكلمة المرور المؤقتة: ${pw}\nسيُطلب منك تغيير كلمة المرور عند أول دخول. من فضلك لا تشارك هذه البيانات مع أحد.`;
  const en = `Hi ${name},\nYour MyAhlawy staff login (Recreational Sports Committee — New Cairo Branch):\nWebsite: ${url}\nOpen the "Admin" or "Gate Scanner" tab and sign in.\nUsername: ${username}\nTemporary password: ${pw}\nYou will be asked to change the password the first time you sign in. Please do not share these details.`;
  return `${ar}\n\n${en}`;
}
function waStaffReminderMessage(name, ev) {
  const eventDate = ev.date;
  const ar = `مرحبًا ${name}، تذكير بأنك مكلّف بإدارة "${ev.nameAr || ev.nameEn}"${eventDate ? ` بتاريخ ${eventDate}` : ""}. من فضلك أكّد جاهزيتك. - لجنة الرياضة الترفيهية - فرع القاهرة الجديدة`;
  const en = `Hi ${name}, a reminder that you are assigned to run "${ev.nameEn || ev.nameAr}"${eventDate ? ` on ${eventDate}` : ""}. Please confirm you are ready. - Recreational Sports Committee — New Cairo Branch`;
  return `${ar}\n\n${en}`;
}
function staffWaSelected() {
  return Array.from(document.querySelectorAll("#staff-accounts-table-wrap .staff-sel:checked")).map((cb) => cb.value);
}
function staffWaUpdateUI() {
  const el = document.getElementById("staff-wa-count");
  if (!el) return;
  const n = staffWaSelected().length;
  el.textContent = n ? `${fmt(n)} ${t("dirSelected")}` : "";
  const kind = document.getElementById("staff-wa-kind").value;
  document.getElementById("staff-wa-event-wrap").classList.toggle("hidden", kind !== "reminder");
  document.getElementById("staff-wa-free-wrap").classList.toggle("hidden", kind !== "free");
}
function staffWaFillEvents() {
  const sel = document.getElementById("staff-wa-event");
  if (!sel) return;
  const keep = sel.value;
  const evs = EVENTS_DATA.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  sel.innerHTML = evs.map((e) => `<option value="${e.id}">${escapeAttr(bilingual(e.nameEn, e.nameAr))} — ${escapeAttr(e.date || "")}</option>`).join("");
  if (keep) sel.value = keep;
}
document.getElementById("staff-wa-kind").addEventListener("change", staffWaUpdateUI);
document.getElementById("staff-wa-select-all").addEventListener("click", () => {
  document.querySelectorAll("#staff-accounts-table-wrap .staff-sel").forEach((cb) => (cb.checked = !cb.disabled));
  staffWaUpdateUI();
});
document.getElementById("staff-wa-clear").addEventListener("click", () => {
  document.querySelectorAll("#staff-accounts-table-wrap .staff-sel").forEach((cb) => (cb.checked = false));
  staffWaUpdateUI();
});
document.getElementById("staff-wa-pick-mgrs").addEventListener("click", () => {
  const ev = EVENTS_DATA.find((e) => String(e.id) === document.getElementById("staff-wa-event").value);
  const mgrs = (ev && ev.managerUsernames) || [];
  document.querySelectorAll("#staff-accounts-table-wrap .staff-sel").forEach((cb) => (cb.checked = mgrs.includes(cb.value)));
  staffWaUpdateUI();
  if (!mgrs.length) showMsg(document.getElementById("staff-wa-msg"), t("staffWaNoManagers"), false);
});
document.getElementById("staff-accounts-table-wrap").addEventListener("change", (e) => {
  if (e.target.classList.contains("staff-sel")) staffWaUpdateUI();
});
document.getElementById("staff-accounts-table-wrap").addEventListener("click", async (e) => {
  const btn = e.target.closest(".staff-phone-save");
  if (!btn) return;
  const u = btn.dataset.u;
  const input = document.querySelector(`#staff-accounts-table-wrap .staff-phone-input[data-u="${CSS.escape(u)}"]`);
  const msg = document.getElementById("staff-wa-msg");
  btn.disabled = true;
  try {
    const r = await api(`/api/staff/accounts/${encodeURIComponent(u)}/phone`, { method: "PUT", body: JSON.stringify({ phone: input.value }) });
    const acc = STAFF_ACCOUNTS_DATA.find((s) => s.username === u);
    if (acc) acc.phone = r.phone;
    input.value = r.phone;
    showMsg(msg, t("staffPhoneSaved"), true);
  } catch (err) {
    showMsg(msg, err.message, false);
  }
  btn.disabled = false;
});
document.getElementById("staff-wa-send").addEventListener("click", () => {
  const msg = document.getElementById("staff-wa-msg");
  const kind = document.getElementById("staff-wa-kind").value;
  const picked = staffWaSelected();
  if (!picked.length) return showMsg(msg, t("staffWaNone"), false);
  const me = CURRENT_SESSION && CURRENT_SESSION.type === "staff" ? CURRENT_SESSION.staff.username : "";
  // Read the phone from the (possibly just edited) input, so an unsaved number still works for messages.
  const accounts = picked
    .map((u) => {
      const acc = STAFF_ACCOUNTS_DATA.find((s) => s.username === u);
      const input = document.querySelector(`#staff-accounts-table-wrap .staff-phone-input[data-u="${CSS.escape(u)}"]`);
      return acc ? { ...acc, phone: acc.phone || "" , typedPhone: input ? input.value.trim() : "" } : null;
    })
    .filter(Boolean);
  if (accounts.some((a) => a.typedPhone !== a.phone)) return showMsg(msg, t("staffWaUnsavedPhone"), false);
  let list = accounts.filter((a) => a.phone);
  const missing = accounts.filter((a) => !a.phone);
  if (missing.length) {
    return showMsg(msg, `${t("staffWaNoPhone")} ${missing.map((a) => a.name).join("، ")}`, false);
  }
  let cfg;
  if (kind === "creds") {
    const self = list.some((a) => a.username === me);
    list = list.filter((a) => a.username !== me);
    if (!list.length) return showMsg(msg, self ? t("staffWaSelfCreds") : t("staffWaNoPhone"), false);
    if (!confirm(`${fmt(list.length)} ${t("staffWaCredsConfirm")}`)) return;
    cfg = {
      title: t("credsTitle"),
      warn: t("credsWarn"),
      items: list.map((a) => ({ label: `${a.name} (${a.username})`, a })),
      async prepare(item) {
        const r = await api(`/api/staff/accounts/${encodeURIComponent(item.a.username)}/send-credentials`, { method: "POST", body: JSON.stringify({ replaceExisting: true }) });
        return { phone: r.phone || item.a.phone, text: waStaffCredentialsMessage(r.name || item.a.name, r.username, r.tempPassword, r.loginUrl) };
      },
    };
  } else {
    if (!list.length) return showMsg(msg, t("staffWaNoPhone"), false);
    let build;
    if (kind === "reminder") {
      const ev = EVENTS_DATA.find((e) => String(e.id) === document.getElementById("staff-wa-event").value);
      if (!ev) return showMsg(msg, t("staffWaNoEvent"), false);
      build = (a) => waStaffReminderMessage(a.name, ev);
    } else {
      const text = document.getElementById("staff-wa-text").value.trim();
      if (!text) return showMsg(msg, t("staffWaNoText"), false);
      build = (a) => text.replace(/\{name\}/g, a.name);
    }
    cfg = {
      title: t("staffWaModalTitle"),
      warn: t("staffWaWarn"),
      items: list.map((a) => ({ label: `${a.name} (${a.username})`, a })),
      async prepare(item) {
        return { phone: item.a.phone, text: build(item.a) };
      },
    };
  }
  cfg.onClose = () => loadStaffAccountsTable();
  msg.classList.remove("show");
  waQueueStart(cfg);
});

// ---- Points & Rewards: the date points start counting ----------------------
async function loadPointsStart() {
  const sel = document.getElementById("pstart-event");
  if (!sel) return;
  try {
    const cur = await api("/api/admin/points-start");
    const evs = EVENTS_DATA.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    sel.innerHTML =
      `<option value="">${escapeAttr(t("pstartNone"))}</option>` +
      evs.map((e) => `<option value="${e.id}">${escapeAttr(bilingual(e.nameEn, e.nameAr))} — ${escapeAttr(e.date || "")}</option>`).join("");
    sel.value = cur.eventId ? String(cur.eventId) : "";
    const label = document.getElementById("pstart-current");
    label.textContent = cur.date
      ? `${t("pstartCurrent")} ${cur.eventId ? bilingual(cur.nameEn, cur.nameAr) : ""} (${cur.date})`
      : t("pstartCurrentNone");
  } catch (e) {
    showMsg(document.getElementById("pstart-msg"), e.message, false);
  }
}
document.getElementById("pstart-save").addEventListener("click", async () => {
  const msg = document.getElementById("pstart-msg");
  const eventId = document.getElementById("pstart-event").value;
  if (!eventId) return showMsg(msg, t("pstartPickEvent"), false);
  try {
    const p = await api(`/api/admin/points-start/preview?eventId=${encodeURIComponent(eventId)}`);
    const text = `${t("pstartConfirm")}\n\n${fmt(p.checkInsAffected)} ${t("pstartCheckins")}\n${fmt(p.pointsRemoved)} ${t("pstartPoints")}\n${fmt(p.redemptionsIgnored)} ${t("pstartRedemptions")}`;
    if (!confirm(text)) return;
    await api("/api/admin/points-start", { method: "PUT", body: JSON.stringify({ eventId: Number(eventId) }) });
    showMsg(msg, t("pstartSaved"), true);
    await loadPointsStart();
    if (typeof loadAdminDirectory === "function") loadAdminDirectory();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});
document.getElementById("pstart-clear").addEventListener("click", async () => {
  const msg = document.getElementById("pstart-msg");
  try {
    await api("/api/admin/points-start", { method: "PUT", body: JSON.stringify({ eventId: null }) });
    showMsg(msg, t("pstartCleared"), true);
    await loadPointsStart();
    loadAdminDirectory();
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

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
  appendManagers(fd, "ev-managers-add");
  if (photoInput.files[0]) fd.append("coverPhoto", photoInput.files[0]);
  if (videoInput.files[0]) fd.append("coverVideo", videoInput.files[0]);
  if (whatsappQrInput.files[0]) fd.append("whatsappQr", whatsappQrInput.files[0]);
  try {
    try {
      await api("/api/events", { method: "POST", body: fd });
    } catch (dupErr) {
      // Same name + date already exists: ask before creating a second copy.
      if (!(dupErr.data && dupErr.data.code === "duplicate_event")) throw dupErr;
      if (!confirm(dupErr.message)) return showMsg(msg, dupErr.message, false);
      fd.set("allowDuplicate", "true");
      await api("/api/events", { method: "POST", body: fd });
    }
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


// ---- Event managers (admin): tick which Tournament Managers run an event ----
let EVENT_MANAGER_CHOICES = [];
async function loadEventManagerChoices() {
  try {
    const list = await api("/api/staff/accounts");
    EVENT_MANAGER_CHOICES = list.filter((s) => s.role === "tournament");
  } catch (e) {
    EVENT_MANAGER_CHOICES = [];
  }
  renderEventManagerPicker("ev-managers-add", []);
  const fields = document.getElementById("ev-edit-fields");
  const editing = fields && fields.dataset.eventId ? EVENTS_DATA.find((e) => e.id === Number(fields.dataset.eventId)) : null;
  renderEventManagerPicker("ev-managers-edit", editing ? editing.managerUsernames || [] : []);
}
function renderEventManagerPicker(containerId, selected) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  const prevChecked = selected === null ? getCheckedManagers(containerId) : selected;
  wrap.innerHTML = EVENT_MANAGER_CHOICES.length
    ? EVENT_MANAGER_CHOICES.map(
        (s) =>
          `<label><input type="checkbox" value="${escapeAttr(s.username)}" ${prevChecked.includes(s.username) ? "checked" : ""} /> ${escapeAttr(s.name)} <small style="color:var(--muted);">(${escapeAttr(s.username)})</small></label>`
      ).join("")
    : `<small style="color:var(--muted);">${escapeAttr(t("noManagersAvailable"))}</small>`;
}
// Only sent when the picker actually listed accounts (never wipe assignments by accident).
function appendManagers(fd, containerId) {
  const wrap = document.getElementById(containerId);
  if (wrap && wrap.querySelector("input[type=checkbox]")) fd.append("managerUsernames", JSON.stringify(getCheckedManagers(containerId)));
}
function getCheckedManagers(containerId) {
  const wrap = document.getElementById(containerId);
  return wrap ? Array.from(wrap.querySelectorAll("input[type=checkbox]:checked")).map((i) => i.value) : [];
}

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
    }${ev.createdByName ? ` · ${t("createdByLabel")}: ${ev.createdByName}${ev.createdAtIso ? " (" + ev.createdAtIso.slice(0, 10) + ")" : ""}` : ""}`;
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
  renderEventManagerPicker("ev-managers-edit", ev.managerUsernames || []);
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
  appendManagers(fd, "ev-managers-edit");
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

// ------------------------------------------------- admin: merge duplicate events --
async function runEventMerge(dryRun) {
  const fromSel = document.getElementById("ev-merge-from");
  const toSel = document.getElementById("ev-merge-to");
  const msg = document.getElementById("ev-merge-msg");
  if (!fromSel.value || !toSel.value || fromSel.value === toSel.value) return showMsg(msg, t("mergeSamePick"), false);
  const from = EVENTS_DATA.find((e) => String(e.id) === fromSel.value);
  const to = EVENTS_DATA.find((e) => String(e.id) === toSel.value);
  try {
    if (!dryRun && !confirm(t("mergeConfirm").replace("{from}", from ? eventLabel(from) : fromSel.value).replace("{to}", to ? eventLabel(to) : toSel.value))) return;
    const r = await api(`/api/admin/events/${encodeURIComponent(fromSel.value)}/move-registrations`, {
      method: "POST",
      body: JSON.stringify({ toEventId: Number(toSel.value), dryRun: !!dryRun, deleteSourceWhenEmpty: document.getElementById("ev-merge-delete").checked }),
    });
    if (dryRun) {
      const names = (r.conflictList || []).map((c) => c.name).join("، ");
      showMsg(
        msg,
        t("mergePreviewText").replace("{moved}", fmt(r.moved)).replace("{total}", fmt(r.total)).replace("{conf}", fmt(r.movedConfirmed)).replace("{wait}", fmt(r.movedWaitlisted)).replace("{demoted}", fmt(r.demotedToWaitlist)).replace("{conflicts}", fmt(r.conflicts)) + (names ? ` (${names})` : ""),
        true
      );
    } else {
      showMsg(msg, t("mergeDoneText").replace("{moved}", fmt(r.moved)).replace("{conflicts}", fmt(r.conflicts)).replace("{deleted}", r.sourceDeleted ? t("mergeSourceDeleted") : t("mergeSourceKept")), true);
      await loadEvents();
      await loadAdminOverview();
      await loadAdminDashboard();
    }
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}
document.getElementById("ev-merge-preview").addEventListener("click", () => runEventMerge(true));
document.getElementById("ev-merge-run").addEventListener("click", () => runEventMerge(false));

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
  // Mirrors the club's own printed committee ID card - red header with the
  // Al Ahly crest, a gold wave, the photo straddling the divide, name and
  // title on the cream body below. See the .committee-card rules in
  // styles.css for the wave/color details.
  return `<div class="committee-card">
    <div class="committee-card-header"><img class="committee-crest" src="/ahly-crest.png" alt="" /></div>
    <div class="committee-photo-wrap">
      ${m.photo ? `<img class="committee-photo" src="${escapeAttr(m.photo)}" alt="" />` : `<div class="committee-photo committee-photo-placeholder"></div>`}
    </div>
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
    document.getElementById("whatsapp-committee-phone").value = lp.whatsapp.committeePhone || "";
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
  const contactTitleEnInput = document.getElementById("contact-title-en");
  if (contactTitleEnInput && lp.contact) {
    contactTitleEnInput.value = lp.contact.titleEn || "";
    document.getElementById("contact-title-ar").value = lp.contact.titleAr || "";
    document.getElementById("contact-body-en").value = lp.contact.bodyEn || "";
    document.getElementById("contact-body-ar").value = lp.contact.bodyAr || "";
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
  contact: "landingSecContact",
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
  fd.append("committeePhone", document.getElementById("whatsapp-committee-phone").value.trim());
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
  fd.append("committeePhone", document.getElementById("whatsapp-committee-phone").value.trim());
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
document.getElementById("contact-save-btn").addEventListener("click", async () => {
  const msg = document.getElementById("contact-admin-msg");
  try {
    const result = await api("/api/admin/landing/contact", {
      method: "PUT",
      body: JSON.stringify({
        titleEn: document.getElementById("contact-title-en").value.trim(),
        titleAr: document.getElementById("contact-title-ar").value.trim(),
        bodyEn: document.getElementById("contact-body-en").value.trim(),
        bodyAr: document.getElementById("contact-body-ar").value.trim(),
      }),
    });
    SETTINGS.landingPage.contact = result.contact;
    LANDING_PAGE.contact = result.contact;
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
  else if (action === "swiss-view-round") { SWISS_VIEW_ROUND = Number(btn.dataset.round); swissKeepScroll(() => renderTournamentBody()); }
  else if (action === "swiss-standings-tab") { SWISS_STANDINGS_TAB = btn.dataset.tab; swissKeepScroll(() => renderTournamentBody()); }
  else if (action === "swiss-result") swissSetResult(Number(btn.dataset.round), Number(btn.dataset.pairing), btn.dataset.result);
  else if (action === "swiss-next-round") swissNextRound();
  else if (action === "swiss-save-info") swissSaveInfo();
  else if (action === "swiss-save-settings") swissSaveSettings();
  else if (action === "swiss-undo") swissUndoDraw();
  else if (action === "swiss-swap") swissSwap();
  else if (action === "swiss-withdraw") swissWithdraw(btn.dataset.entrantId, btn.dataset.withdrawn === "1");
  else if (action === "end-casual-session") setCasualSessionStatus("completed");
  else if (action === "reopen-casual-session") setCasualSessionStatus("casual");
});
document.getElementById("tourn-body").addEventListener("change", (e) => {
  if (e.target.id === "tourn-format") toggleTournamentGroupFields();
  if (e.target.classList && e.target.classList.contains("swiss-cat-box")) {
    swissSetCategory(Number(e.target.dataset.regId), e.target.dataset.cat, e.target.checked);
  }
  if (e.target.classList && e.target.classList.contains("swiss-ff-select")) {
    swissSetResult(Number(e.target.dataset.round), Number(e.target.dataset.pairing), e.target.value);
  }
});
document.getElementById("tourn-body").addEventListener("input", (e) => {
  if (e.target.id !== "swiss-player-filter") return;
  SWISS_PLAYER_FILTER = e.target.value;
  const q = SWISS_PLAYER_FILTER.trim().toLowerCase();
  document.querySelectorAll("#tourn-body .swiss-player-row").forEach((row) => {
    const name = row.children[1] ? row.children[1].textContent.toLowerCase() : "";
    row.style.display = q && !name.includes(q) ? "none" : "";
  });
});
// Live-recomputes the setup dashboard preview (see computeTournamentSetupPreview
// above) on every keystroke/change to any field that feeds it, in either the
// creation form or the post-creation schedule editor.
const TOURN_CREATE_PREVIEW_FIELDS = new Set([
  "tourn-mode", "tourn-format", "tourn-num-groups", "tourn-advance-per-group",
  "tourn-win-points", "tourn-draw-points", "tourn-loss-points", "tourn-planning-count", "tourn-swiss-rounds",
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
  if (format === "swiss") return t("tournamentFormatSwiss");
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
  if (TOURNAMENT_DATA.format === "swiss") {
    renderSwissTournamentBody(body);
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

// =====================================================================
// SWISS (CHESS) TOURNAMENTS - admin panel. Its own render path (like the
// casual format above) because nothing here resembles a bracket or group
// stage: players are re-paired every round by score, results are entered
// board by board, and the standings (Open / Women / Juniors) are computed
// server-side with FIDE tie-breaks (see swiss.js).
// =====================================================================
let SWISS_VIEW_ROUND = null; // round tab being looked at; null = newest
let SWISS_STANDINGS_TAB = "open"; // "open" | "women" | "junior"
let SWISS_PLAYER_FILTER = "";

function swissFmtPts(n) {
  const whole = Math.floor(n);
  return n - whole === 0.5 ? (whole ? `${whole}½` : "½") : String(n);
}
function swissFmtTb(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100).replace(/\.5$/, "½");
}
function swissCatTagsHtml(women, junior) {
  return (women ? `<span class="swiss-tag women">${escapeAttr(t("swissTagWomen"))}</span>` : "") +
    (junior ? `<span class="swiss-tag junior">${escapeAttr(t("swissTagJunior"))}</span>` : "");
}
function swissEgp(n) {
  return t("swissPrizeEgp").replace("{n}", Number(n).toLocaleString("en-US"));
}
function swissKeepScroll(fn) {
  const y = window.scrollY;
  fn();
  window.scrollTo(0, y);
}

function renderSwissTournamentBody(body) {
  const tn = TOURNAMENT_DATA;
  const sw = tn.swiss;
  const generated = sw.generatedRounds > 0;
  const statusLabel = tn.status === "completed"
    ? t("tournStatusCompleted")
    : generated
    ? t("swissRoundOf").replace("{n}", sw.generatedRounds).replace("{total}", sw.totalRounds)
    : t("swissNotDrawn");
  const steps = [
    { label: t("swissStepPlayers"), state: generated ? "done" : "active" },
    { label: t("swissStepRounds"), state: tn.status === "completed" ? "done" : generated ? "active" : "upcoming" },
    { label: t("swissStepFinal"), state: tn.status === "completed" ? "active" : "upcoming" },
  ];
  const stepper = `<div class="tourn-stepper">${steps
    .map((s, i) => `<div class="tourn-step ${s.state}"><span class="tourn-step-dot">${s.state === "done" ? "✓" : i + 1}</span><span class="tourn-step-label">${escapeAttr(s.label)}</span></div>`)
    .join('<div class="tourn-step-line"></div>')}</div>`;
  const printBase = `/admin/print/tournament/${TOURNAMENT_EVENT_ID}`;
  const printLinks = `
    <a class="secondary small" href="${printBase}?view=regulation&lang=${currentLang}" target="_blank" rel="noopener">${t("btnPrintRegulation")}</a>
    ${generated ? `<a class="secondary small" href="${printBase}?view=pairings&round=${swissViewRound()}&lang=${currentLang}" target="_blank" rel="noopener">${t("btnPrintPairings")}</a>` : ""}
    ${generated ? `<a class="secondary small" href="${printBase}?view=standings&lang=${currentLang}" target="_blank" rel="noopener">${t("btnPrintStandings")}</a>` : ""}`;
  const roundsCard = generated
    ? tournCardHtml(TOURN_ICON.live, t("swissRoundsTitle"), renderSwissRounds(), "tourn-card-live")
    : "";
  const standingsCard = generated
    ? tournCardHtml(TOURN_ICON.standings, t("swissStandingsTitle"), renderSwissStandings(), "tourn-card-standings")
    : "";
  const prizesCard = tn.status === "completed"
    ? tournCardHtml(TOURN_ICON.standings, t("swissPrizesTitle"), renderSwissPrizes(), "tourn-card-standings")
    : "";
  const playersCard = tournCardHtml(
    TOURN_ICON.teams,
    `${t("swissPlayersTitle")} <span class="tourn-card-count">${tn.entrants.length}</span>`,
    renderSwissPlayers(),
    "tourn-card-teams"
  );
  body.innerHTML = `
    <div class="tourn-summary tourn-hero">
      <span class="tourn-summary-badge">${escapeAttr(t("tournamentModeIndividual"))}</span>
      <span class="tourn-summary-badge">${escapeAttr(tournamentFormatLabel("swiss"))}</span>
      <span class="tourn-summary-badge">${escapeAttr(statusLabel)}</span>
      <button class="danger small" style="margin-inline-start:auto;" data-tourn-action="delete-tournament">${t("btnDeleteTournament")}</button>
    </div>
    <div class="tourn-summary swiss-print-row">${printLinks}</div>
    ${stepper}
    ${generated ? roundsCard + standingsCard + prizesCard + playersCard : playersCard}
    ${renderSwissSettingsCard()}
    ${renderSwissInfoCard()}
  `;
}

// Board number, plus table + start time when the round runs in waves
// (fewer boards than games).
function swissBoardCell(p, round) {
  if (round.waves > 1 && p.time) return `${p.board}<div class="hint-note" style="margin:0;white-space:nowrap;">${escapeAttr(t("swissTableAt").replace("{table}", p.table).replace("{time}", formatTimeOfDay(p.time)))}</div>`;
  return String(p.board);
}
// Venue / organizer / time-control text for the printable regulation sheet.
function renderSwissInfoCard() {
  const info = TOURNAMENT_DATA.swiss.info || {};
  const field = (id, key, label, extra) =>
    `<div><label>${escapeAttr(label)}</label><input id="swiss-info-${id}" type="${extra === "time" ? "time" : "text"}" maxlength="120" value="${escapeAttr(info[key] || "")}" /></div>`;
  const body = `
    <p class="hint-note">${t("swissInfoHint")}</p>
    <div class="grid-2">
      ${field("venueAr", "venueAr", t("swissInfoVenueAr"))}
      ${field("venueEn", "venueEn", t("swissInfoVenueEn"))}
      ${field("organizerAr", "organizerAr", t("swissInfoOrganizerAr"))}
      ${field("organizerEn", "organizerEn", t("swissInfoOrganizerEn"))}
      ${field("timeControlAr", "timeControlAr", t("swissInfoTimeAr"))}
      ${field("timeControlEn", "timeControlEn", t("swissInfoTimeEn"))}
      ${field("ceremonyTime", "ceremonyTime", t("swissInfoCeremony"), "time")}
    </div>
    <button class="secondary" style="margin-top:10px;" data-tourn-action="swiss-save-info">${t("swissInfoSave")}</button>`;
  return `<details class="swiss-info-details"><summary>${escapeAttr(t("swissInfoTitle"))}</summary>${body}</details>`;
}
// Number of rounds + optional prizes, both editable per tournament.
function renderSwissSettingsCard() {
  const sw = TOURNAMENT_DATA.swiss;
  const list = (k) => escapeAttr((sw.prizes[k] || []).join(" "));
  const minRounds = Math.max(1, sw.generatedRounds);
  const sch = TOURNAMENT_DATA.schedule;
  const body = `
    <div class="grid-2">
      <div><label>${t("fieldSwissRounds")}</label><input id="swiss-set-rounds" type="number" min="${minRounds}" max="${sw.maxRounds}" value="${sw.totalRounds}" />
        <p class="hint-note">${escapeAttr(t("swissRoundsEditHint").replace("{drawn}", sw.generatedRounds).replace("{max}", sw.maxRounds))}</p></div>
    </div>
    <h5 style="margin:12px 0 4px;">${t("swissTimingEditTitle")}</h5>
    <p class="hint-note">${t("swissTimingEditHint")}</p>
    <div class="grid-2">
      <div><label>${t("fieldStartTime")}</label><input id="swiss-set-start" type="time" value="${sch ? escapeAttr(sch.startTime) : ""}" /></div>
      <div><label>${t("swissFieldRoundMinutes")}</label><input id="swiss-set-minutes" type="number" min="1" value="${sch ? sch.matchMinutes : ""}" /></div>
      <div><label>${t("swissFieldBoards")}</label><input id="swiss-set-courts" type="number" min="1" value="${sch ? sch.courts : ""}" /></div>
      <div><label>${t("swissFieldBreak")}</label><input id="swiss-set-break" type="number" min="0" value="${sch ? sch.breakMinutes : 0}" /></div>
    </div>
    <h5 style="margin:12px 0 4px;">${t("swissPrizesEditTitle")}</h5>
    <p class="hint-note">${t("swissPrizesEditHint")}</p>
    <div class="grid-2">
      <div><label>${t("swissCatOpen")}</label><input id="swiss-prize-open" type="text" inputmode="decimal" placeholder="2500 1500 1000" value="${list("open")}" /></div>
      <div><label>${t("swissCatWomen")}</label><input id="swiss-prize-women" type="text" inputmode="decimal" placeholder="1000 600 400" value="${list("women")}" /></div>
      <div><label>${t("swissCatJunior")}</label><input id="swiss-prize-junior" type="text" inputmode="decimal" placeholder="800 600 400" value="${list("junior")}" /></div>
    </div>
    <p class="hint-note">${sw.hasPrizes ? escapeAttr(t("swissPrizeNote").replace("{total}", Number(sw.prizeTotal).toLocaleString("en-US"))) : t("swissNoPrizesSet")}</p>
    <div class="grid-2" style="margin-top:6px;">
      <div><label>${t("swissInfoPrizeNoteAr")}</label><input id="swiss-prize-noteAr" type="text" maxlength="120" value="${escapeAttr((sw.info || {}).prizeNoteAr || "")}" /></div>
      <div><label>${t("swissInfoPrizeNoteEn")}</label><input id="swiss-prize-noteEn" type="text" maxlength="120" value="${escapeAttr((sw.info || {}).prizeNoteEn || "")}" /></div>
    </div>
    <button class="secondary" style="margin-top:10px;" data-tourn-action="swiss-save-settings">${t("swissSettingsSave")}</button>`;
  return `<details class="swiss-info-details" ${sw.generatedRounds === 0 ? "open" : ""}><summary>${escapeAttr(t("swissSettingsTitle"))}</summary>${body}</details>`;
}
function swissParsePrizes(text) {
  const norm = String(text || "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776));
  const tokens = norm.split(/[\s,;،]+/).filter(Boolean);
  const nums = tokens.map((x) => Number(x));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return nums;
}
async function swissSaveSettings() {
  const msg = document.getElementById("tourn-msg");
  const prizes = {};
  for (const k of ["open", "women", "junior"]) {
    const parsed = swissParsePrizes(document.getElementById("swiss-prize-" + k).value);
    if (!parsed) return showMsg(msg, t("swissPrizesBadInput"), false);
    prizes[k] = parsed;
  }
  const rounds = Number(document.getElementById("swiss-set-rounds").value);
  const noteAr = document.getElementById("swiss-prize-noteAr").value;
  const noteEn = document.getElementById("swiss-prize-noteEn").value;
  const val = (id) => document.getElementById(id).value.trim();
  const timing = { startTime: val("swiss-set-start"), matchMinutes: val("swiss-set-minutes"), courts: val("swiss-set-courts"), breakMinutes: val("swiss-set-break") };
  const timingAny = timing.startTime || timing.matchMinutes || timing.courts;
  if (timingAny && (!timing.startTime || !timing.matchMinutes || !timing.courts)) return showMsg(msg, t("scheduleFieldsRequired"), false);
  const data = await swissCall("/swiss/settings", "PUT", { totalRounds: rounds, prizes });
  if (!data) return;
  if (timingAny) {
    const sched = await swissCall("/schedule", "PUT", { courts: Number(timing.courts), matchMinutes: Number(timing.matchMinutes), startTime: timing.startTime, breakMinutes: timing.breakMinutes === "" ? 0 : Number(timing.breakMinutes) });
    if (!sched) return;
  }
  const info = await swissCall("/swiss/info", "PUT", { prizeNoteAr: noteAr, prizeNoteEn: noteEn });
  if (info) showMsg(document.getElementById("tourn-msg"), t("swissSettingsSaved"), true);
}
async function swissSaveInfo() {
  const get = (id) => document.getElementById("swiss-info-" + id).value;
  const data = await swissCall("/swiss/info", "PUT", {
    venueAr: get("venueAr"), venueEn: get("venueEn"), organizerAr: get("organizerAr"), organizerEn: get("organizerEn"),
    timeControlAr: get("timeControlAr"), timeControlEn: get("timeControlEn"), ceremonyTime: get("ceremonyTime"),
  });
  if (data) showMsg(document.getElementById("tourn-msg"), t("swissInfoSaved"), true);
}
function swissViewRound() {
  const sw = TOURNAMENT_DATA.swiss;
  if (SWISS_VIEW_ROUND && SWISS_VIEW_ROUND <= sw.generatedRounds) return SWISS_VIEW_ROUND;
  return sw.generatedRounds;
}

// Players: category tick-boxes (Women / Juniors), attendance and - once
// the draw has started - withdrawal. Filterable since fields run to 100+.
function renderSwissPlayers() {
  const tn = TOURNAMENT_DATA;
  const sw = tn.swiss;
  const generated = sw.generatedRounds > 0;
  const regById = new Map(TOURNAMENT_REGISTRATIONS.map((r) => [r.id, r]));
  const attByReg = new Map((tn.attendance || []).map((a) => [a.registrationId, a.status]));
  const withdrawn = new Set(sw.withdrawn.map((w) => w.entrantId));
  const q = SWISS_PLAYER_FILTER.trim().toLowerCase();
  const order = tn.seedOrder.map((id) => tn.entrants.find((e) => e.id === id)).filter(Boolean);
  const rows = order
    .map((e, i) => {
      const regId = e.registrationIds[0];
      const reg = regById.get(regId) || {};
      const status = attByReg.get(regId) || "not_yet";
      const hidden = q && !e.label.toLowerCase().includes(q) ? ' style="display:none;"' : "";
      const attBtn = (st, label) =>
        `<button class="secondary small ${status === st ? "active" : ""}" data-tourn-action="set-attendance" data-registration-id="${regId}" data-status="${st}">${label}</button>`;
      const wBtn = generated
        ? `<button class="secondary small ${withdrawn.has(e.id) ? "active" : ""}" data-tourn-action="swiss-withdraw" data-entrant-id="${escapeAttr(e.id)}" data-withdrawn="${withdrawn.has(e.id) ? "0" : "1"}">${withdrawn.has(e.id) ? t("swissReinstate") : t("swissWithdraw")}</button>`
        : "";
      return `<tr class="swiss-player-row"${hidden}>
        <td>${i + 1}</td>
        <td>${escapeAttr(e.label)}${withdrawn.has(e.id) ? ` <span class="swiss-tag out">${escapeAttr(t("swissWithdrawn"))}</span>` : ""}</td>
        <td><input type="checkbox" class="swiss-cat-box" data-reg-id="${regId}" data-cat="women" ${reg.women ? "checked" : ""} aria-label="${escapeAttr(t("colWomen"))}" /></td>
        <td><input type="checkbox" class="swiss-cat-box" data-reg-id="${regId}" data-cat="junior" ${reg.junior ? "checked" : ""} aria-label="${escapeAttr(t("colJunior"))}" /></td>
        <td class="swiss-att-cell">${attBtn("present", t("attStatusPresent"))}${attBtn("absent", t("attStatusAbsent"))}${attBtn("not_yet", "–")}${wBtn}</td>
      </tr>`;
    })
    .join("");
  const drawBlock = generated
    ? ""
    : `<div class="swiss-draw-row">
        <button class="secondary" data-tourn-action="randomize-seed">${t("btnRandomize")}</button>
        <button class="primary" data-tourn-action="generate-tournament">${t("btnDrawRound1")}</button>
      </div>
      <p class="hint-note">${t("swissDrawHint")}</p>`;
  return `
    <p class="hint-note">${t("swissCatHint")}</p>
    <input type="search" id="swiss-player-filter" placeholder="${escapeAttr(t("swissSearchPlaceholder"))}" value="${escapeAttr(SWISS_PLAYER_FILTER)}" style="max-width:280px;" />
    <div class="tourn-table-scroll swiss-players-scroll">
      <table class="swiss-table"><thead><tr><th>#</th><th>${t("colName")}</th><th>${t("colWomen")}</th><th>${t("colJunior")}</th><th>${t("swissAttendanceCol")}</th></tr></thead><tbody>${rows}</tbody></table>
    </div>
    ${drawBlock}
  `;
}

function swissResultButtons(round, p, latest) {
  const btn = (res, label) =>
    `<button class="secondary small swiss-res ${p.result === res ? "active" : ""}" data-tourn-action="swiss-result" data-round="${round.number}" data-pairing="${p.id}" data-result="${res}">${label}</button>`;
  const ffValue = ["1-0f", "0-1f", "0-0f"].includes(p.result) ? p.result : "";
  const ff = `<select class="swiss-ff-select ${ffValue ? "active" : ""}" data-round="${round.number}" data-pairing="${p.id}" aria-label="${escapeAttr(t("swissForfeit"))}">
      <option value="">${escapeAttr(t("swissForfeit"))}</option>
      <option value="1-0f" ${ffValue === "1-0f" ? "selected" : ""}>${escapeAttr(t("swissFfWhite"))}</option>
      <option value="0-1f" ${ffValue === "0-1f" ? "selected" : ""}>${escapeAttr(t("swissFfBlack"))}</option>
      <option value="0-0f" ${ffValue === "0-0f" ? "selected" : ""}>${escapeAttr(t("swissFfBoth"))}</option>
    </select>`;
  const clear = latest && p.result ? `<button class="secondary small" data-tourn-action="swiss-result" data-round="${round.number}" data-pairing="${p.id}" data-result="">✕</button>` : "";
  return `${btn("1-0", "1–0")}${btn("1/2-1/2", "½–½")}${btn("0-1", "0–1")}${ff}${clear}`;
}

function renderSwissRounds() {
  const tn = TOURNAMENT_DATA;
  const sw = tn.swiss;
  const cur = swissViewRound();
  const latest = cur === sw.generatedRounds;
  const round = sw.rounds[cur - 1];
  const tabs = sw.rounds
    .map((r) => `<button class="secondary small swiss-round-tab ${r.number === cur ? "active" : ""}" data-tourn-action="swiss-view-round" data-round="${r.number}">${r.number}${r.complete ? " ✓" : ""}</button>`)
    .join("");
  const boards = round.pairings
    .filter((p) => p.b != null)
    .map(
      (p) => `<tr class="${p.result ? "decided" : ""}">
        <td>${swissBoardCell(p, round)}</td>
        <td class="swiss-white">${escapeAttr(p.aLabel)}</td>
        <td class="swiss-res-cell">${swissResultButtons(round, p, latest)}</td>
        <td class="swiss-black">${escapeAttr(p.bLabel)}</td>
      </tr>`
    )
    .join("");
  const bye = round.pairings.find((p) => p.b == null);
  const byeRow = bye ? `<p class="hint-note">${escapeAttr(t("swissByeLine").replace("{name}", bye.aLabel))}</p>` : "";
  const warn = round.warnings.length
    ? `<p class="msg err show">${round.warnings.map((w) => escapeAttr(t("swissRematchWarn").replace("{a}", w.aLabel).replace("{b}", w.bLabel))).join("<br>")}</p>`
    : "";
  const missing = round.pairings.filter((p) => p.b != null && p.result == null).length;
  const hasResults = round.pairings.some((p) => p.b != null && p.result != null);
  let controls = "";
  if (latest) {
    const nextBtn = sw.nextRound
      ? `<button class="primary" ${sw.canGenerateNext ? "" : "disabled"} data-tourn-action="swiss-next-round">${escapeAttr(t("btnDrawNextRound").replace("{n}", sw.nextRound))}</button>`
      : "";
    const undoBtn = !hasResults ? `<button class="secondary" data-tourn-action="swiss-undo">${t("btnUndoDraw")}</button>` : "";
    const missingNote = missing ? `<span class="hint-note" style="margin:0;">${escapeAttr(t("swissMissing").replace("{n}", missing))}</span>` : "";
    const timeNote = sw.nextRound && sw.nextRoundTime && !missing ? `<span class="hint-note" style="margin:0;">${escapeAttr(t("swissNextRoundTime").replace("{time}", formatTimeOfDay(sw.nextRoundTime)))}</span>` : "";
    controls = `<div class="swiss-controls">${nextBtn}${undoBtn}${missingNote}${timeNote}</div>`;
    if (!hasResults || missing) {
      const opts = round.pairings
        .flatMap((p) => [
          { id: p.a, label: p.aLabel, board: p.board },
          ...(p.b != null ? [{ id: p.b, label: p.bLabel, board: p.board }] : []),
        ])
        .map((o) => `<option value="${escapeAttr(o.id)}">${o.board ? `#${o.board} ` : ""}${escapeAttr(o.label)}</option>`)
        .join("");
      controls += `<details class="swiss-swap"><summary>${t("swissSwapTitle")}</summary>
        <p class="hint-note">${t("swissSwapHint")}</p>
        <div class="swiss-swap-row"><select id="swiss-swap-a">${opts}</select><select id="swiss-swap-b">${opts}</select>
        <button class="secondary small" data-tourn-action="swiss-swap">${t("swissSwapBtn")}</button></div></details>`;
    }
  }
  return `
    <div class="swiss-round-tabs">${tabs}</div>
    <p class="hint-note">${escapeAttr(t("swissRoundOf").replace("{n}", cur).replace("{total}", sw.totalRounds))}${round.time ? " · " + escapeAttr(t("swissStarts").replace("{time}", formatTimeOfDay(round.time))) : ""}</p>
    ${warn}
    <div class="tourn-table-scroll"><table class="swiss-table swiss-boards"><thead><tr><th>${t("swissBoard")}</th><th>${t("swissWhite")}</th><th>${t("colResult")}</th><th>${t("swissBlack")}</th></tr></thead><tbody>${boards}</tbody></table></div>
    ${byeRow}
    ${controls}
  `;
}

// Standings with the three prize rankings as tabs. Everything shown is
// computed server-side; this only filters and formats.
function renderSwissStandings() {
  return swissStandingsHtml(TOURNAMENT_DATA.swiss, SWISS_STANDINGS_TAB, false);
}
function swissStandingsHtml(sw, tab, isPublic) {
  const rows = sw.standings.filter((r) => tab === "open" || (tab === "women" ? r.women : r.junior));
  const placeOf = (r, i) => (tab === "open" ? r.rank : tab === "women" ? r.rankWomen : r.rankJunior);
  const prizes = sw.prizes[tab];
  const body = rows
    .map((r, i) => {
      const place = placeOf(r, i);
      const prize = sw.hasPrizes && place && place <= prizes.length ? swissEgp(prizes[place - 1]) : "";
      return `<tr class="${prize ? "swiss-prize-row" : ""}${r.withdrawn ? " swiss-out" : ""}">
        <td>${place != null ? place : "–"}</td>
        <td>${escapeAttr(r.label)} ${swissCatTagsHtml(r.women, r.junior)}${r.tiedOnAll ? ` <span class="swiss-tag warn" title="${escapeAttr(t("swissTiedWarn"))}">⚠</span>` : ""}</td>
        <td><strong>${swissFmtPts(r.points)}</strong></td>
        <td>${swissFmtTb(r.buchholzCut1)}</td><td>${swissFmtTb(r.buchholz)}</td><td>${swissFmtTb(r.sonnebornBerger)}</td><td>${r.wins}</td>
        ${sw.hasPrizes ? `<td>${escapeAttr(prize)}</td>` : ""}
      </tr>`;
    })
    .join("");
  const tabAttr = isPublic ? "data-swiss-pub-tab" : 'data-tourn-action="swiss-standings-tab" data-tab';
  const tabBtn = (key, label) => `<button class="secondary small swiss-round-tab ${tab === key ? "active" : ""}" ${tabAttr}="${key}">${label}</button>`;
  const anyTie = sw.standings.some((r) => r.tiedOnAll);
  return `
    <div class="swiss-round-tabs">${tabBtn("open", t("swissCatOpen"))}${tabBtn("women", t("swissCatWomen"))}${tabBtn("junior", t("swissCatJunior"))}</div>
    <div class="tourn-table-scroll"><table class="swiss-table"><thead><tr><th>#</th><th>${t("colName")}</th><th>${t("swissColPts")}</th><th>${t("swissColBch1")}</th><th>${t("swissColBch")}</th><th>${t("swissColSB")}</th><th>${t("colWins")}</th>${sw.hasPrizes ? `<th>${t("swissColPrize")}</th>` : ""}</tr></thead><tbody>${body || `<tr><td colspan="8">${t("swissNoPlayersInCat")}</td></tr>`}</tbody></table></div>
    <p class="hint-note">${t("swissTieBreakNote")}</p>
    ${anyTie ? `<p class="hint-note">⚠ ${t("swissTiedWarn")}</p>` : ""}
  `;
}

function renderSwissPrizes() {
  const sw = TOURNAMENT_DATA.swiss;
  const awarded = TOURNAMENT_DATA.pointsAwardedAt
    ? `<p class="hint-note">${t("pointsAwardedOn")} ${escapeAttr(new Date(TOURNAMENT_DATA.pointsAwardedAt).toLocaleString())}</p>`
    : "";
  return `
    ${swissPrizeColsHtml(sw)}
    ${awarded}
    <button class="primary" style="margin-top:10px;" data-tourn-action="award-points">${TOURNAMENT_DATA.pointsAwardedAt ? t("btnReAwardPoints") : t("btnAwardPoints")}</button>
  `;
}
function swissPrizeColsHtml(sw) {
  const col = (title, list) => `<div class="swiss-prize-col"><h5>${escapeAttr(title)}</h5>
      ${list.length ? list.map((x) => `<div class="swiss-prize-line"><span class="swiss-place">${x.place}</span><span class="swiss-pname">${escapeAttr(x.label)}${x.tiedOnAll ? " ⚠" : ""}</span>${x.prize != null ? `<span class="swiss-pamt">${escapeAttr(swissEgp(x.prize))}</span>` : ""}</div>`).join("") : `<p class="hint-note">–</p>`}
    </div>`;
  return `
    <div class="swiss-prize-grid">${col(t("swissCatOpen"), sw.rankings.open)}${col(t("swissCatWomen"), sw.rankings.women)}${col(t("swissCatJunior"), sw.rankings.junior)}</div>
    ${sw.hasPrizes ? `<p class="hint-note">${t("swissPrizeNote").replace("{total}", Number(sw.prizeTotal).toLocaleString("en-US"))}</p>` : ""}
  `;
}

async function swissCall(path, method, body) {
  const msg = document.getElementById("tourn-msg");
  try {
    const data = await api("/api/admin/tournaments/" + TOURNAMENT_EVENT_ID + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    if (data.tournament) TOURNAMENT_DATA = data.tournament;
    swissKeepScroll(() => renderTournamentBody());
    return data;
  } catch (e) {
    showMsg(msg, e.message, false);
    return null;
  }
}
async function swissSetResult(roundNumber, pairingId, result) {
  await swissCall("/swiss/result", "PUT", { roundNumber, pairingId, result: result === "" ? null : result });
}
async function swissNextRound() {
  const data = await swissCall("/swiss/next-round", "POST");
  if (data) {
    SWISS_VIEW_ROUND = null;
    renderTournamentBody();
    const msg = document.getElementById("tourn-msg");
    if (data.warnings && data.warnings.length) showMsg(msg, t("swissRematchNotice"), false);
    else showMsg(msg, t("swissRoundDrawn"), true);
  }
}
async function swissUndoDraw() {
  if (!confirm(t("swissConfirmUndo"))) return;
  await swissCall("/swiss/undo-round", "POST");
  SWISS_VIEW_ROUND = null;
  renderTournamentBody();
}
async function swissSwap() {
  const a = document.getElementById("swiss-swap-a").value;
  const b = document.getElementById("swiss-swap-b").value;
  const data = await swissCall("/swiss/swap", "PUT", { a, b });
  if (data && data.warnings && data.warnings.length) showMsg(document.getElementById("tourn-msg"), t("swissRematchNotice"), false);
}
async function swissWithdraw(entrantId, withdrawn) {
  await swissCall("/swiss/withdraw", "PUT", { entrantId, withdrawn });
}
async function swissSetCategory(regId, cat, checked) {
  const reg = TOURNAMENT_REGISTRATIONS.find((r) => r.id === regId);
  if (!reg) return;
  const next = { women: !!reg.women, junior: !!reg.junior };
  next[cat] = checked;
  const msg = document.getElementById("tourn-msg");
  try {
    const data = await api("/api/admin/tournaments/" + TOURNAMENT_EVENT_ID + "/categories", {
      method: "PUT",
      body: JSON.stringify({ registrationId: regId, women: next.women, junior: next.junior }),
    });
    reg.women = next.women;
    reg.junior = next.junior;
    if (data.tournament) TOURNAMENT_DATA = data.tournament;
    swissKeepScroll(() => renderTournamentBody());
  } catch (e) {
    showMsg(msg, e.message, false);
    swissKeepScroll(() => renderTournamentBody());
  }
}

// Setup preview for the creation form: boards needed vs available, how
// long all rounds take and the expected finish - the same "will this fit?"
// guidance the other formats get.
function swissCreatePreviewHtml() {
  const planningRaw = byIdVal("tourn-planning-count").trim();
  const isPlanning = planningRaw !== "";
  const players = isPlanning ? Number(planningRaw) : TOURNAMENT_REGISTRATIONS.length;
  const rounds = Number(byIdVal("tourn-swiss-rounds")) || 7;
  const boards = Number(byIdVal("tourn-courts")) || 0;
  const minutes = Number(byIdVal("tourn-match-minutes")) || 0;
  const brk = Number(byIdVal("tourn-break-minutes")) || 0;
  const start = byIdVal("tourn-start-time");
  // With an odd number of players one sits out each round (bye) - that is
  // not a game, so games per round = floor(players / 2).
  const needed = Math.floor(players / 2);
  const waves = boards ? Math.max(1, Math.ceil(needed / boards)) : 1;
  const total = minutes ? rounds * waves * minutes + (rounds - 1) * brk : 0;
  let finish = "—";
  if (start && minutes) {
    const [h, m] = start.split(":").map(Number);
    finish = formatTimeOfDay(minutesToHHMM(h * 60 + m + total));
  }
  const msgs = [];
  if (players && players < rounds + 1) msgs.push(t("swissPreviewFewPlayers").replace("{min}", rounds + 1));
  const badge = msgs.length
    ? `<span class="tourn-setup-ready pending">${escapeAttr(msgs.join(" · "))}</span>`
    : `<span class="tourn-setup-ready ok">${escapeAttr(t("swissPreviewOk"))}</span>`;
  const wavesNote = waves > 1 ? `<p class="hint-note">${escapeAttr(t("swissPreviewWaves").replace("{needed}", needed).replace("{boards}", boards).replace("{waves}", waves))}</p>` : "";
  const activeLabel = t("statActivePlayers") + (isPlanning ? ` ${t("planningBadge")}` : "");
  return `<div class="tourn-setup-dashboard">
    <h5>${t("setupDashboardTitle")} ${badge}</h5>
    <div class="stat-row">
      <div class="stat"><div class="n">${players}</div><div class="l">${activeLabel}</div></div>
      <div class="stat"><div class="n">${rounds}</div><div class="l">${t("swissStatRounds")}</div></div>
      <div class="stat"><div class="n">${needed}</div><div class="l">${t("swissStatBoardsNeeded")}</div></div>
      <div class="stat"><div class="n">${needed * rounds}</div><div class="l">${t("statTotalMatches")}</div></div>
    </div>
    <div class="stat-row" style="margin-top:10px;">
      <div class="stat"><div class="n">${total ? tournMinutesLabel(total) : "—"}</div><div class="l">${t("statEstDuration")}</div></div>
      <div class="stat"><div class="n">${finish}</div><div class="l">${t("statExpectedFinish")}</div></div>
      <div class="stat"><div class="n">${waves}</div><div class="l">${t("swissStatWaves")}</div></div>
    </div>
    ${wavesNote}
  </div>`;
}
function minutesToHHMM(mins) {
  const w = ((Math.round(mins) % 1440) + 1440) % 1440;
  return String(Math.floor(w / 60)).padStart(2, "0") + ":" + String(w % 60).padStart(2, "0");
}


// ---- public (read-only) Swiss page ----------------------------------
let PUBLIC_SWISS_TN = null;
let PUBLIC_SWISS_ROUND = null;
let PUBLIC_SWISS_TAB = "open";
let PUBLIC_SWISS_QUERY = "";
function renderPublicSwiss(tn, eventId, meta, ev) {
  PUBLIC_SWISS_TN = tn;
  const sw = tn.swiss;
  const generated = sw.generatedRounds > 0;
  const statusLabel = tn.status === "completed"
    ? t("tournStatusCompleted")
    : generated
    ? t("swissRoundOf").replace("{n}", sw.generatedRounds).replace("{total}", sw.totalRounds)
    : t("swissNotDrawn");
  return `
    <div class="tourn-summary tourn-hero">
      ${meta ? `<h3 style="margin:0 0 6px;">${eventNameHtml(meta)}</h3>` : ""}
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
        <span class="tourn-summary-badge">${escapeAttr(tournamentFormatLabel("swiss"))}</span>
        <span class="tourn-summary-badge">${escapeAttr(statusLabel)}</span>
        ${ev ? `<button class="secondary small" id="tourn-public-view-event-btn" style="margin-inline-start:auto;">${t("btnViewEventDetails")}</button>` : ""}
      </div>
    </div>
    <div id="swiss-pub-body">${renderPublicSwissInner()}</div>
  `;
}
function renderPublicSwissInner() {
  const tn = PUBLIC_SWISS_TN;
  const sw = tn.swiss;
  if (!sw.generatedRounds) return `<p class="hint-note">${t("tournPublicNotStarted")}</p>`;
  const cur = PUBLIC_SWISS_ROUND && PUBLIC_SWISS_ROUND <= sw.generatedRounds ? PUBLIC_SWISS_ROUND : sw.generatedRounds;
  const round = sw.rounds[cur - 1];
  const q = PUBLIC_SWISS_QUERY.trim().toLowerCase();
  const resText = { "1-0": "1–0", "0-1": "0–1", "1/2-1/2": "½–½", "1-0f": "1–0 (f)", "0-1f": "0–1 (f)", "0-0f": "0–0 (f)" };
  const tabs = sw.rounds
    .map((r) => `<button class="secondary small swiss-round-tab ${r.number === cur ? "active" : ""}" data-swiss-pub-round="${r.number}">${r.number}</button>`)
    .join("");
  const boards = round.pairings
    .filter((p) => p.b != null)
    .map((p) => {
      const hit = q && (p.aLabel.toLowerCase().includes(q) || p.bLabel.toLowerCase().includes(q));
      const hide = q && !hit ? ' style="display:none;"' : "";
      return `<tr class="${p.result ? "decided" : ""}${hit ? " swiss-hit" : ""}"${hide}><td>${swissBoardCell(p, round)}</td><td class="swiss-white">${escapeAttr(p.aLabel)}</td><td class="swiss-res-cell"><strong>${p.result ? escapeAttr(resText[p.result] || p.result) : "—"}</strong></td><td class="swiss-black">${escapeAttr(p.bLabel)}</td></tr>`;
    })
    .join("");
  const bye = round.pairings.find((p) => p.b == null);
  const roundCard = tournCardHtml(
    TOURN_ICON.live,
    t("swissRoundsTitle"),
    `<div class="swiss-round-tabs">${tabs}</div>
     <p class="hint-note">${escapeAttr(t("swissRoundOf").replace("{n}", cur).replace("{total}", sw.totalRounds))}${round.time ? " · " + escapeAttr(t("swissStarts").replace("{time}", formatTimeOfDay(round.time))) : ""}</p>
     <input type="search" id="swiss-pub-search" placeholder="${escapeAttr(t("swissFindBoard"))}" value="${escapeAttr(PUBLIC_SWISS_QUERY)}" style="max-width:280px;" />
     <div class="tourn-table-scroll"><table class="swiss-table swiss-boards"><thead><tr><th>${t("swissBoard")}</th><th>${t("swissWhite")}</th><th>${t("colResult")}</th><th>${t("swissBlack")}</th></tr></thead><tbody>${boards}</tbody></table></div>
     ${bye ? `<p class="hint-note">${escapeAttr(t("swissByeLine").replace("{name}", bye.aLabel))}</p>` : ""}`,
    "tourn-card-live"
  );
  const standingsCard = tournCardHtml(TOURN_ICON.standings, t("swissStandingsTitle"), swissStandingsHtml(sw, PUBLIC_SWISS_TAB, true), "tourn-card-standings");
  const prizesCard = tn.status === "completed" ? tournCardHtml(TOURN_ICON.standings, t("swissPrizesTitle"), swissPrizeColsHtml(sw), "tourn-card-standings") : "";
  return roundCard + standingsCard + prizesCard;
}
document.getElementById("tourn-public-detail-body").addEventListener("click", (e) => {
  const rb = e.target.closest("[data-swiss-pub-round]");
  const tb = e.target.closest("[data-swiss-pub-tab]");
  if (!rb && !tb) return;
  if (rb) PUBLIC_SWISS_ROUND = Number(rb.dataset.swissPubRound);
  if (tb) PUBLIC_SWISS_TAB = tb.dataset.swissPubTab;
  const wrap = document.getElementById("swiss-pub-body");
  if (wrap) wrap.innerHTML = renderPublicSwissInner();
});
document.getElementById("tourn-public-detail-body").addEventListener("input", (e) => {
  if (e.target.id !== "swiss-pub-search") return;
  PUBLIC_SWISS_QUERY = e.target.value;
  const wrap = document.getElementById("swiss-pub-body");
  if (!wrap) return;
  wrap.innerHTML = renderPublicSwissInner();
  const input = document.getElementById("swiss-pub-search");
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
});

// ---- Register / My Registrations: Women & Juniors ranking tick-boxes ----
function swissCatBoxesHtml(prefix, women, junior, extraAttrs) {
  return `<span class="reg-cat-wrap hidden">
    <label class="reg-cat"><input type="checkbox" class="att-cat" data-cat="women" ${extraAttrs} ${women ? "checked" : ""} /> ${escapeAttr(t("regCatWomen"))}</label>
    <label class="reg-cat"><input type="checkbox" class="att-cat" data-cat="junior" ${extraAttrs} ${junior ? "checked" : ""} /> ${escapeAttr(t("regCatJunior"))}</label>
  </span>`;
}
function updateRegCategoryVisibility() {
  const sel = document.getElementById("reg-event");
  const ev = sel ? EVENTS_DATA.find((e) => e.id === Number(sel.value)) : null;
  const on = !!(ev && ev.rankingCategories);
  document.querySelectorAll("#reg-attendees-list .reg-cat-wrap").forEach((el) => el.classList.toggle("hidden", !on));
  const note = document.getElementById("reg-cat-note");
  if (note) note.classList.toggle("hidden", !on);
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
  const activeLabel = (cfg.mode === "team" ? t("statActiveTeams") : t("statActivePlayers")) + (cfg.isPlanning ? ` ${t("planningBadge")}` : "");
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
  const realCount = mode === "team" ? 0 : TOURNAMENT_REGISTRATIONS.length;
  // Optional "what if" planning count: lets an admin test a hypothetical
  // tournament size (e.g. "what if we had 150 players") before that many
  // people have actually signed up, instead of only ever previewing against
  // today's real registration count.
  const planningRaw = byIdVal("tourn-planning-count").trim();
  const isPlanning = planningRaw !== "";
  const activeTeams = isPlanning ? Number(planningRaw) : realCount;
  return {
    mode,
    format,
    activeTeams,
    isPlanning,
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
  if (cfg.format === "swiss") {
    el.innerHTML = swissCreatePreviewHtml();
    return;
  }
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
          <option value="swiss">${t("tournamentFormatSwiss")}</option>
        </select>
      </div>
    </div>
    <div class="grid-2" id="tourn-group-fields" style="display:none;">
      <div><label>${t("fieldNumGroups")}</label><input id="tourn-num-groups" type="number" min="2" value="2" /></div>
      <div><label>${t("fieldAdvancePerGroup")}</label><input id="tourn-advance-per-group" type="number" min="1" value="2" /></div>
    </div>
    <div class="grid-2" id="tourn-swiss-fields" style="display:none;">
      <div><label>${t("fieldSwissRounds")}</label><input id="tourn-swiss-rounds" type="number" min="1" max="30" value="7" /></div>
    </div>
    <p class="hint-note" id="tourn-swiss-hint" style="display:none;">${t("swissCreateHint")}</p>
    <p class="hint-note" id="tourn-casual-hint" style="display:none;">${t("tournCasualCreateHint")}</p>
    <div id="tourn-match-config-fields">
      <div class="grid-2" id="tourn-points-fields">
        <div><label>${t("fieldWinPoints")}</label><input id="tourn-win-points" type="number" min="0" value="3" /></div>
        <div><label>${t("fieldDrawPoints")}</label><input id="tourn-draw-points" type="number" min="0" value="1" /></div>
        <div><label>${t("fieldLossPoints")}</label><input id="tourn-loss-points" type="number" min="0" value="0" /></div>
      </div>
      <div class="grid-2" style="margin-top:14px;">
        <div><label>${t("fieldPlanningCount")}</label><input id="tourn-planning-count" type="number" min="0" placeholder="${escapeAttr(t("optionalPlaceholder"))}" /></div>
      </div>
      <p class="hint-note">${t("planningCountHint")}</p>
      <p class="hint-note" id="tourn-schedule-hint" style="margin-top:14px;">${t("scheduleSetupHint")}</p>
      <div class="grid-2">
        <div><label id="tourn-lbl-courts">${t("fieldCourts")}</label><input id="tourn-courts" type="number" min="1" placeholder="${escapeAttr(t("optionalPlaceholder"))}" /></div>
        <div><label id="tourn-lbl-match-minutes">${t("fieldMatchMinutes")}</label><input id="tourn-match-minutes" type="number" min="1" placeholder="${escapeAttr(t("optionalPlaceholder"))}" /></div>
        <div><label>${t("fieldStartTime")}</label><input id="tourn-start-time" type="time" /></div>
        <div><label id="tourn-lbl-break">${t("fieldBreakMinutes")}</label><input id="tourn-break-minutes" type="number" min="0" placeholder="0" /></div>
        <div id="tourn-wrap-available-hours"><label>${t("fieldAvailableHours")}</label><input id="tourn-available-hours" type="number" min="0" step="0.5" placeholder="${escapeAttr(t("optionalPlaceholder"))}" /></div>
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
  const swiss = format === "swiss";
  const swissFields = document.getElementById("tourn-swiss-fields");
  if (swissFields) swissFields.style.display = swiss ? "grid" : "none";
  const swissHint = document.getElementById("tourn-swiss-hint");
  if (swissHint) swissHint.style.display = swiss ? "" : "none";
  const pointsFields = document.getElementById("tourn-points-fields");
  if (pointsFields) pointsFields.style.display = swiss ? "none" : "";
  // Chess wording for the schedule fields (boards / round time / break between rounds).
  const setText = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
  setText("tourn-lbl-courts", swiss ? "swissFieldBoards" : "fieldCourts");
  setText("tourn-lbl-match-minutes", swiss ? "swissFieldRoundMinutes" : "fieldMatchMinutes");
  setText("tourn-lbl-break", swiss ? "swissFieldBreak" : "fieldBreakMinutes");
  setText("tourn-schedule-hint", swiss ? "swissScheduleSetupHint" : "scheduleSetupHint");
  const avail = document.getElementById("tourn-wrap-available-hours");
  if (avail) avail.style.display = swiss ? "none" : "";
  // Swiss is always individual players - lock the mode selector.
  const modeSel = document.getElementById("tourn-mode");
  if (modeSel) {
    if (swiss) modeSel.value = "individual";
    modeSel.disabled = swiss;
  }
  refreshCreateSetupPreview();
}
async function createTournament() {
  const msg = document.getElementById("tourn-msg");
  const mode = document.getElementById("tourn-mode").value;
  const format = document.getElementById("tourn-format").value;
  const body = { mode, format };
  if (format === "swiss") body.swissRounds = Number(document.getElementById("tourn-swiss-rounds").value) || 7;
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
    if (format !== "swiss") {
      if (winPoints) body.winPoints = Number(winPoints);
      if (drawPoints) body.drawPoints = Number(drawPoints);
      if (lossPoints) body.lossPoints = Number(lossPoints);
    }
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
  if (tn.format === "swiss" && tn.swiss) return renderPublicSwiss(tn, eventId, meta, ev);
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
        <td>${r.reward ? escapeAttr(ladderLabel(r.reward)) : escapeAttr(r.tier)}</td>
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

// ------------------------------------------------------- partner account --
// Read-only view for the "partner" role: who checked in to the events an admin
// assigned (name, age, date of birth, check-in time - nothing else).
let PARTNER_ATTENDEES = [];
function partnerEventLabel(ev) {
  const name = currentLang === "ar" ? ev.nameAr || ev.nameEn : ev.nameEn || ev.nameAr;
  return `${name} · ${ev.date}`;
}
async function loadPartnerEvents() {
  const sel = document.getElementById("partner-event-select");
  if (!sel) return;
  const noEv = document.getElementById("partner-no-events");
  const controls = document.getElementById("partner-controls");
  const wrap = document.getElementById("partner-table-wrap");
  try {
    const { events } = await api("/api/partner/events");
    const keep = sel.value;
    sel.innerHTML = events.map((ev) => `<option value="${ev.id}">${escapeAttr(partnerEventLabel(ev))}</option>`).join("");
    if (keep && events.some((e) => String(e.id) === keep)) sel.value = keep;
    noEv.classList.toggle("hidden", events.length > 0);
    controls.classList.toggle("hidden", events.length === 0);
    controls.style.display = events.length ? "flex" : "none";
    if (!events.length) {
      wrap.innerHTML = "";
      return;
    }
    await loadPartnerAttendees();
  } catch (e) {
    wrap.innerHTML = `<p class="msg error">${escapeAttr(e.message)}</p>`;
  }
}
async function loadPartnerAttendees() {
  const sel = document.getElementById("partner-event-select");
  const wrap = document.getElementById("partner-table-wrap");
  if (!sel || !sel.value) return;
  try {
    const r = await api(`/api/partner/events/${encodeURIComponent(sel.value)}/attendees`);
    PARTNER_ATTENDEES = r.attendees;
    renderPartnerAttendees();
  } catch (e) {
    wrap.innerHTML = `<p class="msg error">${escapeAttr(e.message)}</p>`;
  }
}
function renderPartnerAttendees() {
  const wrap = document.getElementById("partner-table-wrap");
  const q = searchNorm((document.getElementById("partner-search") || {}).value || "");
  const list = PARTNER_ATTENDEES.filter((a) => !q || searchNorm(a.name).includes(q));
  document.getElementById("partner-count").textContent = t("partnerCount").replace("{n}", String(PARTNER_ATTENDEES.length));
  if (!list.length) {
    wrap.innerHTML = `<p style="color:var(--muted);">${escapeAttr(t("partnerNone"))}</p>`;
    return;
  }
  const hasActivity = list.some((a) => a.activityEn || a.activityAr);
  const timeText = (iso) => {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return "—";
    return d.toLocaleTimeString(currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-GB", { hour: "2-digit", minute: "2-digit" });
  };
  wrap.innerHTML = `<table class="dashboard-table">
    <thead><tr><th>#</th><th>${t("colName")}</th><th>${t("colAge")}</th><th>${t("colBirthYear")}</th>${hasActivity ? `<th>${t("partnerColActivity")}</th>` : ""}<th>${t("partnerColCheckin")}</th></tr></thead>
    <tbody>${list
      .map(
        (a, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td>${escapeAttr(a.name)}</td>
      <td class="num">${a.age != null ? escapeAttr(a.age) : "—"}</td>
      <td class="num" style="white-space:nowrap;">${a.birthDate ? escapeAttr(birthDateText(a.birthDate)) : "—"}</td>
      ${hasActivity ? `<td>${escapeAttr(currentLang === "ar" ? a.activityAr || a.activityEn : a.activityEn || a.activityAr)}</td>` : ""}
      <td class="num">${escapeAttr(timeText(a.checkedInAt))}</td>
    </tr>`
      )
      .join("")}</tbody></table>`;
}
document.getElementById("partner-event-select").addEventListener("change", loadPartnerAttendees);
document.getElementById("partner-refresh").addEventListener("click", loadPartnerAttendees);
document.getElementById("partner-search").addEventListener("input", renderPartnerAttendees);

// Admin side: tick the events a partner account may see.
function partnerEventsEditorHtml(s) {
  const assigned = new Set((s.partnerEventIds || []).map(Number));
  const events = (typeof EVENTS_DATA !== "undefined" ? EVENTS_DATA : []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const u = escapeAttr(s.username);
  return `<details class="partner-ev-box" data-u="${u}" style="margin-top:6px;">
    <summary style="cursor:pointer;font-size:0.8rem;color:var(--muted);">${escapeAttr(t("partnerEventsLabel"))} — ${
      assigned.size ? escapeAttr(t("partnerEventsCount").replace("{n}", String(assigned.size))) : escapeAttr(t("partnerEventsNone"))
    }</summary>
    <div style="max-height:180px;overflow:auto;margin:6px 0;font-size:0.82rem;">${events
      .map(
        (ev) =>
          `<label style="display:flex;gap:6px;align-items:center;margin:2px 0;"><input type="checkbox" class="partner-ev-cb" value="${ev.id}"${assigned.has(ev.id) ? " checked" : ""} /> ${escapeAttr(partnerEventLabel(ev))}</label>`
      )
      .join("")}</div>
    <button type="button" class="secondary partner-ev-save" data-u="${u}" style="padding:3px 10px;font-size:0.75rem;">${escapeAttr(t("partnerEventsSave"))}</button>
    <span class="partner-ev-msg" style="font-size:0.78rem;margin-inline-start:8px;"></span>
  </details>`;
}
document.getElementById("staff-accounts-table-wrap").addEventListener("click", async (e) => {
  const btn = e.target.closest(".partner-ev-save");
  if (!btn) return;
  const box = btn.closest(".partner-ev-box");
  const eventIds = [...box.querySelectorAll(".partner-ev-cb:checked")].map((c) => Number(c.value));
  const msg = box.querySelector(".partner-ev-msg");
  try {
    const r = await api(`/api/staff/accounts/${encodeURIComponent(btn.dataset.u)}/partner-events`, {
      method: "PUT",
      body: JSON.stringify({ eventIds }),
    });
    const acct = (STAFF_ACCOUNTS_DATA || []).find((x) => x.username === btn.dataset.u);
    if (acct) acct.partnerEventIds = r.partnerEventIds;
    msg.textContent = t("partnerEventsSaved");
    msg.style.color = "var(--green, #1b7f3b)";
  } catch (err) {
    msg.textContent = err.message;
    msg.style.color = "var(--red)";
  }
});

// ------------------------------------------------------------ staff accounts --
async function loadStaffAccountsTable() {
  const wrap = document.getElementById("staff-accounts-table-wrap");
  const list = await api("/api/staff/accounts");
  EVENT_MANAGER_CHOICES = list.filter((s) => s.role === "tournament");
  renderEventManagerPicker("ev-managers-add", null);
  renderEventManagerPicker("ev-managers-edit", null);
  STAFF_ACCOUNTS_DATA = list;
  staffWaFillEvents();
  const checked = new Set(staffWaSelected());
  const me = CURRENT_SESSION && CURRENT_SESSION.type === "staff" ? CURRENT_SESSION.staff.username : "";
  wrap.innerHTML = `<table>
    <thead><tr><th></th><th>${t("fieldUsername")}</th><th>${t("fieldFullName")}</th><th>${t("fieldRole")}</th><th>${t("colPhone")}</th><th>${t("colActions")}</th></tr></thead>
    <tbody>
      ${list
        .map(
          (s) => `<tr>
        <td><input type="checkbox" class="staff-sel" value="${escapeAttr(s.username)}" aria-label="${escapeAttr(s.username)}"${checked.has(s.username) ? " checked" : ""} /></td>
        <td>${escapeAttr(s.username)}</td>
        <td>${escapeAttr(s.name)}${s.mustChangePassword ? ` <span class="dir-badge temp">${t("tempPasswordBadge")}</span>` : ""}</td>
        <td>${
          s.role === "admin"
            ? t("roleAdmin")
            : s.role === "tournament"
            ? t("roleTournament")
            : s.role === "management"
            ? t("roleManagement")
            : s.role === "partner"
            ? t("rolePartner")
            : t("roleStaff")
        }${s.role === "partner" ? partnerEventsEditorHtml(s) : ""}</td>
        <td style="white-space:nowrap;"><input class="staff-phone-input" data-u="${escapeAttr(s.username)}" type="tel" value="${escapeAttr(s.phone || "")}" placeholder="01xxxxxxxxx" style="width:140px;padding:4px 6px;font-size:0.8rem;" /> <button class="secondary staff-phone-save" data-u="${escapeAttr(s.username)}" style="padding:3px 10px;font-size:0.75rem;">${t("btnSaveShort")}</button></td>
        <td>${
          me === s.username
            ? ""
            : `<button class="secondary" data-remove-staff="${escapeAttr(s.username)}">${t("btnRemove")}</button>`
        }</td>
      </tr>`
        )
        .join("")}
    </tbody>
  </table>`;
  staffWaUpdateUI();
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
// "Pick from committee members": fills the full name (and a suggested
// username) from a committee member and selects the Tournament Manager role.
// Any number of Tournament Managers can be created - one account each.
async function populateStaffCommitteePicker() {
  const sel = document.getElementById("sa-committee");
  if (!sel) return;
  try {
    const list = await api("/api/committee");
    const keep = sel.value;
    sel.innerHTML =
      `<option value="">${escapeAttr(t("optPickCommittee"))}</option>` +
      list
        .map((m) => `<option value="${m.id}">${escapeAttr(currentLang === "ar" ? m.nameAr || m.nameEn : m.nameEn || m.nameAr)}</option>`)
        .join("");
    sel.value = keep;
    sel._committee = list;
  } catch (e) {
    /* non-fatal: the form still works by typing the name */
  }
}
document.getElementById("sa-committee").addEventListener("change", (e) => {
  const m = (e.target._committee || []).find((x) => String(x.id) === e.target.value);
  if (!m) return;
  document.getElementById("sa-name").value = currentLang === "ar" ? m.nameAr || m.nameEn : m.nameEn || m.nameAr;
  const base = (m.nameEn || "").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
  if (base && !document.getElementById("sa-username").value) document.getElementById("sa-username").value = base;
  document.getElementById("sa-role").value = "tournament";
});
document.getElementById("sa-submit").addEventListener("click", async () => {
  const username = document.getElementById("sa-username").value.trim();
  const name = document.getElementById("sa-name").value.trim();
  const password = document.getElementById("sa-password").value;
  const role = document.getElementById("sa-role").value;
  const phone = document.getElementById("sa-phone").value.trim();
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
      body: JSON.stringify({ username, password, name, role, phone }),
    });
    showMsg(msg, t("okStaffAdded"), true);
    document.getElementById("sa-username").value = "";
    document.getElementById("sa-name").value = "";
    document.getElementById("sa-password").value = "";
    document.getElementById("sa-phone").value = "";
    document.getElementById("sa-committee").value = "";
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

// ------------------------------------------------------------- age group --
// Optional self-reported age band (Kids/Teens/Adults/Seniors), shown only to
// club staff (e.g. the Members list/export) - never surfaced on public pages.
// Saved via the existing PATCH /api/me/profile endpoint rather than a new
// one, since that endpoint already accepts partial profile updates.
const AGE_GROUP_LABEL_KEYS = {
  under12: "ageGroupKids",
  "12to17": "ageGroupTeens",
  "18to45": "ageGroupAdults",
  "46plus": "ageGroupSeniors",
};
function ageGroupLabel(code) {
  return code && AGE_GROUP_LABEL_KEYS[code] ? t(AGE_GROUP_LABEL_KEYS[code]) : "—";
}
function ageGroupOptionsHtml(selected) {
  return (
    `<option value="">${escapeAttr(t("ageGroupPlaceholderRequired"))}</option>` +
    Object.keys(AGE_GROUP_LABEL_KEYS)
      .map((code) => `<option value="${code}"${code === selected ? " selected" : ""}>${escapeAttr(t(AGE_GROUP_LABEL_KEYS[code]))}</option>`)
      .join("")
  );
}
// ------------------------------------------------------ date of birth helpers --
function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function ageFromBirth(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return null;
  const n = new Date();
  let age = n.getFullYear() - Number(m[1]);
  const mo = n.getMonth() + 1;
  if (mo < Number(m[2]) || (mo === Number(m[2]) && n.getDate() < Number(m[3]))) age--;
  return Math.max(0, age);
}
function ageGroupFromYears(a) {
  return a == null ? "" : a < 12 ? "under12" : a < 18 ? "12to17" : a < 46 ? "18to45" : "46plus";
}
// With a date of birth the group is always recalculated here too, so a long
// open session never shows yesterday's group after a birthday.
function effectiveAgeGroup(p) {
  if (p && p.birthDate) {
    const a = ageFromBirth(p.birthDate);
    if (a != null) return ageGroupFromYears(a);
  }
  return (p && p.ageGroup) || "";
}
function birthDateText(iso) {
  const d = new Date(String(iso || "") + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return String(iso || "");
  try {
    return d.toLocaleDateString(currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  } catch (e) {
    return String(iso);
  }
}
function bornAgeText(p) {
  if (!p || !p.birthDate) return "";
  return t("bornAge").replace("{date}", birthDateText(p.birthDate)).replace("{age}", String(ageFromBirth(p.birthDate)));
}
function initBirthInputs() {
  const max = todayISO();
  document.querySelectorAll('input[type="date"][min="1900-01-01"]').forEach((i) => (i.max = max));
}
initBirthInputs();

// Non-blocking reminder banner: lists whoever on this account (the member
// and/or their family members) still has no age group. Accounts created
// before the field became mandatory simply see this until it is filled in.
function renderAgeReminder() {
  const box = document.getElementById("age-reminder");
  if (!box) return;
  const member = CURRENT_SESSION && CURRENT_SESSION.type === "member" ? CURRENT_SESSION.member : null;
  const missing = [];
  if (member) {
    if (!member.birthDate) missing.push(t("ageReminderYou"));
    (member.dependents || []).forEach((d) => {
      if (!d.birthDate) missing.push(d.name);
    });
  }
  box.classList.toggle("hidden", !missing.length);
  if (missing.length) document.getElementById("age-reminder-text").textContent = `${t("ageReminderLead")} ${missing.join(", ")}`;
}
document.getElementById("age-reminder-btn").addEventListener("click", () => {
  switchTab("mypoints");
  const card = document.getElementById("mp-agegroup-card");
  if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
});
function renderAgeGroupStatus() {
  renderAgeReminder();
  const el = document.getElementById("mp-agegroup-status");
  if (!el) return;
  const member = CURRENT_SESSION && CURRENT_SESSION.type === "member" ? CURRENT_SESSION.member : null;
  if (member && member.birthDate) {
    el.textContent = t("ageStatusLine")
      .replace("{date}", birthDateText(member.birthDate))
      .replace("{age}", String(ageFromBirth(member.birthDate)))
      .replace("{group}", ageGroupLabel(effectiveAgeGroup(member)));
  } else {
    el.textContent = member && member.ageGroup ? `${t("ageGroupStatusSet")} ${ageGroupLabel(member.ageGroup)} — ${t("ageGroupStatusNotSet")}` : t("ageGroupStatusNotSet");
  }
  const input = document.getElementById("mp-birthdate");
  if (input && document.activeElement !== input) input.value = (member && member.birthDate) || "";
}

function renderMyPhoneInput() {
  const input = document.getElementById("mp-phone");
  const member = CURRENT_SESSION && CURRENT_SESSION.type === "member" ? CURRENT_SESSION.member : null;
  if (input && member && document.activeElement !== input) input.value = member.phone || "";
}
document.getElementById("mp-phone-save").addEventListener("click", async () => {
  const input = document.getElementById("mp-phone");
  const msg = document.getElementById("mp-phone-msg");
  const phone = input.value.trim();
  if (!phone) {
    highlightMissingFields(["mp-phone"]);
    return showMsg(msg, t("errPhoneRequired"), false);
  }
  try {
    const result = await api("/api/me/profile", { method: "PATCH", body: JSON.stringify({ phone }) });
    CURRENT_SESSION.member.phone = result.member.phone;
    renderMyPhoneInput();
    showMsg(msg, t("okPhoneSaved"), true);
  } catch (e) {
    showMsg(msg, e.message, false);
  }
});

document.getElementById("mp-agegroup-save").addEventListener("click", async () => {
  const input = document.getElementById("mp-birthdate");
  const msg = document.getElementById("mp-agegroup-msg");
  const birthDate = input.value;
  if (!birthDate) {
    highlightMissingFields(["mp-birthdate"]);
    showMsg(msg, t("errBirthDateRequired"), false);
    return;
  }
  if (birthDate > todayISO() || birthDate < "1900-01-01") {
    highlightMissingFields(["mp-birthdate"]);
    showMsg(msg, t("errBirthDateInvalid"), false);
    return;
  }
  try {
    const result = await api("/api/me/profile", { method: "PATCH", body: JSON.stringify({ birthDate }) });
    CURRENT_SESSION.member.ageGroup = result.member.ageGroup;
    CURRENT_SESSION.member.birthDate = result.member.birthDate;
    renderAgeGroupStatus();
    renderAgeReminder();
    showMsg(msg, t("okAgeGroupSaved"), true);
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
  wrap.innerHTML = rosterTableHtml(CHECKIN_ROSTER, query, document.getElementById("checkin-event-select").value);
}
// Direct WhatsApp "click to chat" - the official wa.me URL scheme, not the
// Cloud API. This only ever builds a link; the admin/staff member still has
// to click it and tap Send themselves in their own WhatsApp (app or Web), so
// there's no bot, no automated sending, and no account-ban risk - the same
// mechanism millions of businesses link from a "Chat on WhatsApp" button.
// Turns whatever a phone field has on file (local "01xxxxxxxxx", "+20...",
// "0020...", or already-bare digits) into the "2xxxxxxxxxxx" country-code
// form wa.me requires. Assumes Egypt (country code 20) for a bare local
// number, since that's every phone number this club collects.
function waDigits(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("0020")) d = d.slice(2); // 0020xxxxxxxxxx -> 20xxxxxxxxxx
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = "20" + d.slice(1); // local 01xxxxxxxxx -> 201xxxxxxxxx
  else if (!d.startsWith("20")) d = "20" + d; // bare 1xxxxxxxxx -> 201xxxxxxxxx
  return d;
}
// ---- Member -> committee WhatsApp (the member starts the chat) --------------
// One shared committee number (set by the admin under WhatsApp Community).
// The button opens a chat with it, pre-filled with who the member is and which
// event they mean. A message the member starts is far safer for the number's
// reputation than the committee messaging people first.
function committeeWaDigits() {
  const p = String(((LANDING_PAGE && LANDING_PAGE.whatsapp) || {}).committeePhone || "").trim();
  if (!p) return "";
  if (p.startsWith("+")) return p.replace(/\D/g, "");
  return waDigits(p);
}
function committeeWaMessage(about) {
  const m = CURRENT_SESSION && CURRENT_SESSION.type === "member" ? CURRENT_SESSION.member : null;
  const name = m ? m.name : "";
  const num = m ? m.membershipNumber : "";
  const ar = `السلام عليكم، أنا ${name} (رقم العضوية ${num}). لدي استفسار بخصوص تسجيلي${about ? ` في: ${about}` : ""}.`;
  const en = `Hello, I am ${name} (membership no. ${num}). I have a question about my registration${about ? ` for: ${about}` : ""}.`;
  return `${ar}\n\n${en}`;
}
function committeeWaHref(about) {
  const d = committeeWaDigits();
  return d ? `https://wa.me/${d}?text=${encodeURIComponent(committeeWaMessage(about))}` : "";
}
function waLink(phone, message) {
  const digits = waDigits(phone);
  if (!digits) return "";
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
// The pre-filled confirmation text - always both languages, Arabic first
// then English, regardless of which language the admin/staff member
// currently has the UI set to (the member on the receiving end may prefer
// either). Staff can still edit it in WhatsApp itself before hitting Send.
function waConfirmMessage(attendeeName, eventName, eventDate) {
  const ar = `مرحبًا ${attendeeName}، تم تأكيد تسجيلك في "${eventName}"${eventDate ? ` بتاريخ ${eventDate}` : ""}. نراك هناك! - لجنة الرياضة الترفيهية - فرع القاهرة الجديدة`;
  const en = `Hi ${attendeeName}, this confirms your registration for "${eventName}"${eventDate ? ` on ${eventDate}` : ""}. See you there! - Recreational Sports Committee — New Cairo Branch`;
  return `${ar}\n\n${en}`;
}
// wa.me's click-to-chat link can only pre-fill TEXT (it's a URL scheme, not
// an API - there's no official way to pre-attach an image/file to the draft
// message). So when this registration actually has a QR to send, we show a
// one-line reminder pointing at the QR thumbnail/download button that
// already sits in the previous column (rosterQrCellHtml) - staff download it
// once, then drag/attach that image into the WhatsApp chat before sending.
//
// Builds the whole WhatsApp cell: a status pill (sent-at time, or "not sent
// yet") plus a Send/Resend button. The button is a <button> (not a plain
// <a>), because clicking it does two things in order - record the send via
// POST /api/staff/registrations/:id/whatsapp-confirmed (see
// sendWhatsappConfirm() below) so the status persists for whoever looks at
// this roster next, THEN open the pre-filled wa.me chat. No phone on file
// shows a plain note instead of a dead button.
// Reminder / event-day messages (follow-up and attendance check). Reminder is
// available from 3 days before the event until the day before; the event-day
// message from the event date (to the end date for multi-day events).
function waReminderMessage(attendeeName, eventName, eventDate) {
  const ar = `مرحبًا ${attendeeName}، تذكير بموعد "${eventName}"${eventDate ? ` بتاريخ ${eventDate}` : ""}. من فضلك أكّد حضورك بالرد على هذه الرسالة. - لجنة الرياضة الترفيهية - فرع القاهرة الجديدة`;
  const en = `Hi ${attendeeName}, a reminder about "${eventName}"${eventDate ? ` on ${eventDate}` : ""}. Please reply to confirm that you will attend. - Recreational Sports Committee — New Cairo Branch`;
  return `${ar}\n\n${en}`;
}
function waDayOfMessage(attendeeName, eventName, eventDate) {
  const ar = `مرحبًا ${attendeeName}، اليوم هو موعد "${eventName}"${eventDate ? ` (${eventDate})` : ""}. نتطلع لرؤيتك! من فضلك أكّد لنا حضورك بالرد على هذه الرسالة. - لجنة الرياضة الترفيهية - فرع القاهرة الجديدة`;
  const en = `Hi ${attendeeName}, today is the day for "${eventName}"${eventDate ? ` (${eventDate})` : ""}. We look forward to seeing you! Please reply to confirm your attendance. - Recreational Sports Committee — New Cairo Branch`;
  return `${ar}\n\n${en}`;
}
function eventDaysUntil(ev) {
  if (!ev || !ev.date) return null;
  const [y, m, d] = ev.date.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((start - today) / 86400000);
}
function eventReminderOpen(ev) {
  const n = eventDaysUntil(ev);
  return n === null ? true : n >= 1 && n <= 3;
}
function waStatusCellHtml(r, eventName, eventDate, ev) {
  // No WhatsApp messages (confirmation, reminder, event-day) to anyone still on
  // the waiting list: they only become eligible once confirmed (promoted).
  if (r.waitlisted) {
    return `<small style="color:var(--muted);">${escapeAttr(t("waWaitlistNote"))}</small>`;
  }
  const hasPhoneNow = !!r.phone;
  // Tournament Manager: the list carries no phone numbers (hasPhone only);
  // the number is fetched from the server at the moment of sending.
  if (!hasPhoneNow && !r.hasPhone) {
    return `<small style="color:var(--muted);">${escapeAttr(t("waNoPhoneNote"))}</small>`;
  }
  const attending = !r.waitlisted && !r.checkedIn;
  const types = [
    { key: "confirm", field: "whatsappConfirmedAt", label: "waTypeConfirm", short: "waShortConfirm", resend: "waResendConfirm", build: waConfirmMessage, open: true, cls: "wa" },
  ];
  if (attending) {
    types.push({ key: "reminder", field: "whatsappReminderAt", label: "waTypeReminder", short: "waShortReminder", resend: "waResendReminder", build: waReminderMessage, open: eventReminderOpen(ev), cls: "wa reminder", tip: "waOnlyBeforeEvent" });
    types.push({ key: "dayof", field: "whatsappDayOfAt", label: "waTypeDayOf", short: "waShortDayOf", resend: "waResendDayOf", build: waDayOfMessage, open: eventCheckInOpen(ev), cls: "wa dayof", tip: "checkinOnlyOnEventDate" });
  }
  const chips = types
    .map((ty) => {
      const sentAt = r[ty.field];
      const message = ty.build(r.attendeeName, eventName || "", eventDate || "");
      const href = hasPhoneNow ? waLink(r.phone, message) : "";
      const label = sentAt ? "\u21BB " + t(ty.resend) : t(ty.short);
      const cls = `roster-btn wa-chip ${ty.cls}${sentAt ? " sent" : ""}`;
      const dataAttrs = `data-wa-confirm="${r.registrationId}" data-wa-type="${ty.key}" ${href ? `data-wa-href="${escapeAttr(href)}"` : `data-wa-msg="${escapeAttr(message)}"`}`;
      if (!ty.open) {
        return `<button class="${cls}" disabled title="${escapeAttr(t(ty.label) + " - " + t(ty.tip))}">${escapeAttr(label)}</button>`;
      }
      const title = sentAt
        ? `${t(ty.label)} - ${t("waStatusSent")} ${new Date(sentAt).toLocaleString()} (${t("btnResendWhatsappConfirm")})`
        : `${t(ty.label)} - ${t("waStatusNotSent")}`;
      return `<button class="${cls}" ${dataAttrs} title="${escapeAttr(title)}">${escapeAttr(label)}</button>`;
    })
    .join("");
  return `<div class="wa-chips">${chips}</div>`;
}
// Shared by the Gate Scanner's and the Event hub's WhatsApp confirm/resend
// buttons (data-wa-confirm, built above). Records the send via the server
// first - so the "Sent"/time status persists even if the staff member closes
// the WhatsApp tab without actually hitting Send in there - then opens the
// pre-filled wa.me chat. onDone is the caller's own roster reload, run only
// after a successful record so the pill/button flip to "Sent"/"Resend".
async function sendWhatsappConfirm(btn, msgEl, onDone) {
  btn.disabled = true;
  try {
    const sent = await api(`/api/staff/registrations/${btn.dataset.waConfirm}/whatsapp-confirmed`, {
      method: "POST",
      body: JSON.stringify({ type: btn.dataset.waType || "confirm" }),
    });
    const href = btn.dataset.waHref || waLink(sent.phone, btn.dataset.waMsg || "");
    if (!href) throw new Error(t("waNoPhoneNote"));
    window.open(href, "_blank", "noopener");
    if (onDone) await onDone();
  } catch (e) {
    if (msgEl) showMsg(msgEl, e.message, false);
    btn.disabled = false;
  }
}
// Shared by the Gate Scanner's manual check-in list and the per-event Admin
// hub's attendance section, so the two never drift - one row shape, one set
// of status/action rules. Pure function (no DOM reads/writes) so it's safe
// to call from either context; the caller wires its own data-checkin-reg
// click delegation on whatever container it rendered into. eventId is
// optional context just for the WhatsApp confirmation link's message text
// (event name/date) - everything else about the row works without it.
// showCancel (default false) adds a "Cancel registration" button to every
// row regardless of status - opt-in, and only passed true from the Event
// Manage hub (see loadHubRoster below), so the Gate Scanner's check-in list
// is unchanged: cancelling isn't something staff should be able to do from
// a fast-moving gate queue, only from the hub where the fuller event
// context (and the reason prompt - see openCancelRegModal) is in view.
// Sortable roster: one shared sort state for every roster table (Gate Scanner,
// Event hub), toggled by clicking a column header (data-roster-sort).
let ROSTER_SORT = { key: "", dir: 1 };
const ROSTER_SORT_COLS = [
  ["member", "colMember"],
  ["registered", "colRegisteredAt"],
  ["status", "colStatus"],
  ["qr", "colQrCode"],
  ["actions", "colActions"],
  ["whatsapp", "colWhatsapp"],
];
function rosterSortValue(r, key) {
  switch (key) {
    case "member":
      return (r.attendeeName || "").toLowerCase();
    case "registered":
      return r.registeredAt ? new Date(r.registeredAt).getTime() : 0;
    case "status": // waiting for check-in first, then checked in, then waiting list
      return r.waitlisted ? 2 : r.checkedIn ? 1 : 0;
    case "qr":
      return r.qrDataUrl ? 0 : 1;
    case "actions": // rows that still need a check-in action first
      return !r.waitlisted && !r.checkedIn ? 0 : 1;
    case "whatsapp": // not sent yet, then sent, then no phone
      return !r.phone ? 2 : r.whatsappConfirmedAt ? 1 : 0;
    default:
      return 0;
  }
}
// Check-in is only possible on the event's date (or between start and end
// date for a multi-day event). UI-level rule: the button is greyed out on
// any other day. Dates are plain YYYY-MM-DD strings compared as text.
function localTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function canUndoCheckIn(ev) {
  if (!CURRENT_SESSION || CURRENT_SESSION.type !== "staff" || !["admin", "staff", "tournament"].includes(CURRENT_SESSION.staff.role)) return false;
  if (!ev || !ev.date) return true;
  const end = ev.endDate && ev.endDate > ev.date ? ev.endDate : ev.date;
  return localTodayStr() <= end;
}
// Undo a mistaken check-in from either roster (Gate Scanner list or Event hub).
async function undoCheckInClick(btn, msgId, reload) {
  const name = btn.dataset.undoName || "";
  if (!window.confirm(`${name}\n${t("confirmUndoCheckIn")}`)) return;
  btn.disabled = true;
  const msg = document.getElementById(msgId);
  try {
    await api("/api/checkin/undo", { method: "POST", body: JSON.stringify({ registrationId: Number(btn.dataset.undoReg) }) });
    showMsg(msg, `${name} — ${t("undoCheckInDone")}`, true);
    await reload();
  } catch (err) {
    showMsg(msg, err.message, false);
    btn.disabled = false;
  }
}
document.getElementById("hub-checkin-wrap").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-undo-reg]");
  if (btn) undoCheckInClick(btn, "hub-checkin-msg", () => loadHubRoster(true));
});
document.getElementById("checkin-roster-wrap").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-undo-reg]");
  if (btn) undoCheckInClick(btn, "checkin-roster-msg", () => loadCheckinRoster(true));
});
function eventCheckInOpen(ev) {
  if (!ev || !ev.date) return true;
  const today = localTodayStr();
  const end = ev.endDate && ev.endDate > ev.date ? ev.endDate : ev.date;
  return today >= ev.date && today <= end;
}
document.addEventListener("click", (e) => {
  const fbtn = e.target.closest("[data-roster-filter]");
  if (fbtn) {
    ROSTER_FILTER = fbtn.dataset.rosterFilter;
    if (fbtn.closest("#hub-checkin-wrap")) document.getElementById("hub-checkin-search").dispatchEvent(new Event("input"));
    else renderCheckinRoster();
    return;
  }
  const th = e.target.closest("[data-roster-sort]");
  if (!th) return;
  const key = th.dataset.rosterSort;
  ROSTER_SORT = ROSTER_SORT.key === key ? { key, dir: -ROSTER_SORT.dir } : { key, dir: 1 };
  if (th.closest("#hub-checkin-wrap")) {
    document.getElementById("hub-checkin-search").dispatchEvent(new Event("input"));
  } else if (th.closest("#checkin-roster-wrap")) {
    renderCheckinRoster();
  }
});
// Quick filter chips above the roster (shared by the Gate Scanner and the Event hub).
let ROSTER_FILTER = "all";
function rosterFilterMatch(r, f) {
  if (f === "pending") return !r.waitlisted && !r.checkedIn;
  if (f === "in") return !!r.checkedIn;
  if (f === "wait") return !!r.waitlisted;
  return true;
}
function rosterToolbarHtml(roster, ev) {
  const defs = [["all", "rosterFilterAll"], ["pending", "rosterFilterPending"], ["in", "rosterFilterIn"], ["wait", "rosterFilterWait"]];
  const chips = defs
    .map(([key, label]) => {
      const n = roster.filter((r) => rosterFilterMatch(r, key)).length;
      if (key === "wait" && !n) return "";
      return `<button type="button" class="roster-filter${ROSTER_FILTER === key ? " active" : ""}" data-roster-filter="${key}">${escapeAttr(t(label))} <b>${fmt(n)}</b></button>`;
    })
    .join("");
  return `<div class="roster-toolbar"><div class="roster-filters">${chips}</div>${waBulkBarHtml(roster, ev)}</div>`;
}
function rosterTableHtml(roster, query, eventId, showCancel) {
  let filtered = roster.filter(
    (r) =>
      rosterFilterMatch(r, ROSTER_FILTER) &&
      (!query || r.attendeeName.toLowerCase().includes(query) || String(r.membershipNumber).toLowerCase().includes(query))
  );
  const evForBar = eventId ? EVENTS_DATA.find((e) => e.id === Number(eventId)) : null;
  if (!filtered.length) {
    return `${rosterToolbarHtml(roster, evForBar)}<p style="color:var(--muted);">${escapeAttr(t("checkinNoMatches"))}</p>`;
  }
  if (ROSTER_SORT.key) {
    const { key, dir } = ROSTER_SORT;
    filtered = filtered.slice().sort((a, b) => {
      const va = rosterSortValue(a, key);
      const vb = rosterSortValue(b, key);
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return (a.attendeeName || "").localeCompare(b.attendeeName || "");
    });
  }
  const ev = eventId ? EVENTS_DATA.find((e) => e.id === Number(eventId)) : null;
  const eventName = ev ? bilingual(ev.nameEn, ev.nameAr) : "";
  const eventDate = ev ? ev.date : "";
  const checkInOpen = eventCheckInOpen(ev);
  const body = filtered
    .map((r) => {
      let status, action;
      if (r.waitlisted) {
        status = `<span class="capacity-badge waitlist">${t("waitlistLabel")}</span>`;
        action = "";
      } else if (r.checkedIn) {
        const time = r.checkInAt ? new Date(r.checkInAt).toLocaleString() : "";
        status = `<span class="badge Approved">${t("scanSuccess")}</span><br/><small style="color:var(--muted);">${escapeAttr(time)}</small>`;
        // A wrong tap at the gate can be undone (gate staff, Tournament
        // Managers, admins) until the event is over.
        action = canUndoCheckIn(ev)
          ? `<button class="roster-btn undo" data-undo-reg="${r.registrationId}" data-undo-name="${escapeAttr(r.attendeeName)}">${t("btnUndoCheckIn")}</button>`
          : "";
      } else {
        status = "";
        action = checkInOpen
          ? `<button class="roster-btn checkin" data-checkin-reg="${r.registrationId}">${t("btnCheckIn")}</button>`
          : `<button class="roster-btn checkin" disabled title="${escapeAttr(t("checkinOnlyOnEventDate"))}${eventDate ? " (" + escapeAttr(eventDate) + ")" : ""}">${t("btnCheckIn")}</button>`;
      }
      const cancelBtn = showCancel
        ? `<button class="roster-btn cancel" data-cancel-reg="${r.registrationId}" data-cancel-name="${escapeAttr(r.attendeeName)}">${t("btnCancelRegistration")}</button>`
        : "";
      const registeredAt = r.registeredAt ? new Date(r.registeredAt).toLocaleString() : "—";
      return `<tr>
        <td>${escapeAttr(r.attendeeName)}<br/><small style="color:var(--muted);">${escapeAttr(r.membershipNumber)}</small></td>
        <td><small style="color:var(--muted);">${escapeAttr(registeredAt)}</small></td>
        <td>${status}</td>
        <td>${rosterQrCellHtml(r.qrDataUrl, r.registrationId, true)}</td>
        <td><div class="roster-actions">${action}${cancelBtn}</div></td>
        <td class="wa-cell">${waStatusCellHtml(r, eventName, eventDate, ev)}</td>
      </tr>`;
    })
    .join("");
  const headCells = ROSTER_SORT_COLS.map(([key, label]) => {
    const active = ROSTER_SORT.key === key;
    const arrow = active ? (ROSTER_SORT.dir === 1 ? " ▲" : " ▼") : " ↕";
    return `<th aria-sort="${active ? (ROSTER_SORT.dir === 1 ? "ascending" : "descending") : "none"}"><button type="button" class="roster-sort${active ? " active" : ""}" data-roster-sort="${key}">${t(label)}<span class="roster-sort-arrow">${arrow}</span></button></th>`;
  }).join("");
  const dateNote =
    !checkInOpen && filtered.some((r) => !r.waitlisted && !r.checkedIn)
      ? `<p class="roster-date-banner">${escapeAttr(t("checkinOnlyOnEventDate"))}${eventDate ? " (" + escapeAttr(eventDate) + ")" : ""}</p>`
      : "";
  const qrNote = filtered.some((r) => r.qrDataUrl) ? `<p class="wa-hint roster-qr-note">${escapeAttr(t("waConfirmQrHint"))}</p>` : "";
  return `${rosterToolbarHtml(roster, ev)}${dateNote}${qrNote}<div class="dashboard-table-wrap roster-scroll"><table class="dashboard-table roster-table">
    <thead><tr>${headCells}</tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}
// Small QR thumbnail + a Download link, shown next to a roster row whenever
// the backend decided this registration's QR is still worth showing (not
// checked in, not waitlisted, event not over - see the server's roster/
// directory endpoints). Lets staff/admin resend a code to someone who
// missed it at the gate without needing a real "send" mechanism this app
// doesn't have (no email/SMS infra) - they download the image here and
// share it however they normally would.
function rosterQrCellHtml(qrDataUrl, downloadKey, compact) {
  if (!qrDataUrl) return "";
  return `<div class="roster-qr${compact ? " compact" : ""}">
    <img src="${qrDataUrl}" alt="QR" class="roster-qr-thumb" />
    <a class="roster-qr-download" href="${qrDataUrl}" download="qr-${escapeAttr(String(downloadKey))}.png" title="${escapeAttr(t("btnDownloadQr"))}">${compact ? "\u2B07 QR" : t("btnDownloadQr")}</a>
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
document.getElementById("checkin-roster-wrap").addEventListener("click", (e) => {
  const waBtn = e.target.closest("[data-wa-confirm]");
  if (!waBtn) return;
  sendWhatsappConfirm(waBtn, document.getElementById("checkin-roster-msg"), () => loadCheckinRoster(true));
});


// ---- Bulk WhatsApp: one button per message type for the whole event --------
// Eligible = attending (not waitlisted, not checked in), has a number on file,
// and not already marked Sent for that message type.
const WA_BULK_TYPES = {
  reminder: { field: "whatsappReminderAt", label: "waBulkReminder", title: "waTypeReminder", build: waReminderMessage, open: (ev) => eventReminderOpen(ev), tip: "waOnlyBeforeEvent", cls: "reminder" },
  dayof: { field: "whatsappDayOfAt", label: "waBulkDayOf", title: "waTypeDayOf", build: waDayOfMessage, open: (ev) => eventCheckInOpen(ev), tip: "checkinOnlyOnEventDate", cls: "dayof" },
};
function waBulkPendingRows(roster, type) {
  const def = WA_BULK_TYPES[type];
  return (roster || []).filter((r) => !r.waitlisted && !r.checkedIn && (r.phone || r.hasPhone) && !r[def.field]);
}
function waBulkBarHtml(roster, ev) {
  if (!ev) return "";
  const buttons = Object.keys(WA_BULK_TYPES)
    .map((type) => {
      const def = WA_BULK_TYPES[type];
      const n = waBulkPendingRows(roster, type).length;
      const label = `${t(def.label)} (${fmt(n)} ${t("waBulkPending")})`;
      return def.open(ev) && n > 0
        ? `<button type="button" class="roster-btn wa ${def.cls}" data-wa-bulk="${type}">${escapeAttr(label)}</button>`
        : `<button type="button" class="roster-btn wa ${def.cls}" disabled title="${escapeAttr(def.open(ev) ? t("waBulkNone") : t(def.tip))}">${escapeAttr(label)}</button>`;
    })
    .join("");
  return `<div class="wa-bulk-bar">${buttons}</div>`;
}
let WA_BULK = null;
function waBulkRender() {
  const b = WA_BULK;
  const def = WA_BULK_TYPES[b.type];
  document.getElementById("wa-bulk-title").textContent = t(def.title);
  document.getElementById("wa-bulk-hint").textContent = t("waBulkHint");
  const msg = document.getElementById("wa-bulk-msg");
  const openBtn = document.getElementById("wa-bulk-open");
  const skipBtn = document.getElementById("wa-bulk-skip");
  openBtn.className = "roster-btn wa " + def.cls;
  openBtn.textContent = t("waBulkOpen");
  if (b.idx >= b.queue.length) {
    document.getElementById("wa-bulk-progress").textContent = t("waBulkDone");
    document.getElementById("wa-bulk-name").textContent = `${fmt(b.sent)} ${t("waBulkSentWord")} · ${fmt(b.skipped)} ${t("waBulkSkippedWord")}`;
    openBtn.classList.add("hidden");
    skipBtn.textContent = t("waBulkClose");
    return;
  }
  const r = b.queue[b.idx];
  document.getElementById("wa-bulk-progress").textContent = `${t("waBulkProgress")} ${fmt(b.idx + 1)} ${t("waBulkOf")} ${fmt(b.queue.length)}`;
  document.getElementById("wa-bulk-name").textContent = `${r.attendeeName} (${r.membershipNumber})`;
  openBtn.classList.remove("hidden");
  openBtn.disabled = false;
  skipBtn.textContent = t("waBulkSkip");
  if (msg) msg.textContent = "";
}
function waBulkStart(type, roster, ev, onDone) {
  const queue = waBulkPendingRows(roster, type);
  if (!queue.length) return;
  WA_BULK = { type, queue, idx: 0, sent: 0, skipped: 0, ev, onDone };
  document.getElementById("wa-bulk-modal").classList.remove("hidden");
  waBulkRender();
}
function waBulkClose() {
  document.getElementById("wa-bulk-modal").classList.add("hidden");
  const done = WA_BULK && WA_BULK.onDone;
  WA_BULK = null;
  if (done) done();
}
document.getElementById("wa-bulk-close").addEventListener("click", waBulkClose);
document.getElementById("wa-bulk-skip").addEventListener("click", () => {
  if (!WA_BULK) return;
  if (WA_BULK.idx >= WA_BULK.queue.length) return waBulkClose();
  WA_BULK.skipped++;
  WA_BULK.idx++;
  waBulkRender();
});
document.getElementById("wa-bulk-open").addEventListener("click", async () => {
  const b = WA_BULK;
  if (!b || b.idx >= b.queue.length) return;
  const r = b.queue[b.idx];
  if (r.waitlisted) { b.skipped++; b.idx++; return waBulkRender(); } // never message the waiting list
  const def = WA_BULK_TYPES[b.type];
  const btn = document.getElementById("wa-bulk-open");
  const msg = document.getElementById("wa-bulk-msg");
  btn.disabled = true;
  try {
    const sent = await api(`/api/staff/registrations/${r.registrationId}/whatsapp-confirmed`, {
      method: "POST",
      body: JSON.stringify({ type: b.type }),
    });
    const evName = bilingual(b.ev.nameEn, b.ev.nameAr);
    const href = waLink(r.phone || sent.phone, def.build(r.attendeeName, evName, b.ev.date));
    if (!href) throw new Error(t("waNoPhoneNote"));
    r[def.field] = sent[def.field] || new Date().toISOString();
    window.open(href, "_blank", "noopener");
    b.sent++;
    b.idx++;
    waBulkRender();
  } catch (e) {
    if (msg) showMsg(msg, e.message, false);
    btn.disabled = false;
  }
});
for (const [wrapId, getCtx] of [
  ["checkin-roster-wrap", () => ({ roster: CHECKIN_ROSTER, eventId: document.getElementById("checkin-event-select").value, reload: () => loadCheckinRoster(true) })],
  ["hub-checkin-wrap", () => ({ roster: HUB_ROSTER, eventId: HUB_EVENT_ID, reload: () => loadHubRoster(true) })],
]) {
  document.getElementById(wrapId).addEventListener("click", (e) => {
    const btn = e.target.closest("[data-wa-bulk]");
    if (!btn || btn.disabled) return;
    const ctx = getCtx();
    const ev = EVENTS_DATA.find((x) => x.id === Number(ctx.eventId));
    if (ev) waBulkStart(btn.dataset.waBulk, ctx.roster, ev, ctx.reload);
  });
}

// ------------------------------------------------------------------- init --
(async function init() {
  applyI18n();
  await loadSettings();
  await loadEvents();
  await loadLadder();
  await checkSession();
})();


// "Watch how" links (My Family card, event registration form): jump to the
// Member Profile's help-video card and start the matching video. The click is
// the user gesture browsers require before play() is allowed to run.
document.addEventListener("click", (ev) => {
  const link = ev.target.closest && ev.target.closest(".howto-link");
  if (!link) return;
  ev.preventDefault();
  const which = link.dataset.howto === "qr-entry" ? "howto-qr-entry" : link.dataset.howto === "register-family" ? "howto-register-family" : "howto-add-family";
  switchTab("mypoints");
  const fig = document.getElementById(which);
  if (!fig) return;
  document.querySelectorAll(".howto-item").forEach((f) => f.classList.remove("howto-flash"));
  fig.classList.add("howto-flash");
  fig.scrollIntoView({ behavior: "smooth", block: "center" });
  const v = fig.querySelector("video");
  if (v) {
    try {
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    } catch (_) {}
  }
});


// Entry-QR help video exists in Arabic and English. It follows the UI language
// by default; the two small buttons under it let a member pick the other one.
function setQrHowtoLang(l) {
  const fig = document.getElementById("howto-qr-entry");
  if (!fig) return;
  const v = fig.querySelector("video");
  const src = "videos/how-to-qr-entry-" + l + ".mp4?v=2";
  if (v && v.getAttribute("src") !== src) {
    try { v.pause(); } catch (_) {}
    clearHowtoErr(fig);
    v.setAttribute("poster", "videos/how-to-qr-entry-" + l + "-poster.jpg?v=2");
    v.setAttribute("src", src);
    try { v.load(); } catch (_) {}
  }
  fig.querySelectorAll(".howto-lang").forEach((b) => b.classList.toggle("active", b.dataset.vlang === l));
}
document.addEventListener("click", (ev) => {
  const b = ev.target.closest && ev.target.closest(".howto-lang");
  if (b) setQrHowtoLang(b.dataset.vlang);
});
setQrHowtoLang(typeof currentLang !== "undefined" && currentLang === "ar" ? "ar" : "en");

// If a help video cannot be loaded (file missing on the server, blocked, or an
// unsupported format) show a short note under it instead of a silent black box.
// "error" does not bubble, so listen in the capture phase.
document.addEventListener(
  "error",
  (ev) => {
    const v = ev.target;
    if (!v || v.tagName !== "VIDEO" || !v.closest || !v.closest(".howto-item")) return;
    const fig = v.closest(".howto-item");
    if (fig.querySelector(".howto-err")) return;
    const p = document.createElement("p");
    p.className = "howto-err";
    p.setAttribute("data-i18n", "howToVideoError");
    p.textContent = t("howToVideoError");
    v.insertAdjacentElement("afterend", p);
  },
  true
);
// A new source (language switch) gets a fresh chance: drop the old note.
function clearHowtoErr(fig) { const e = fig && fig.querySelector(".howto-err"); if (e) e.remove(); }

// ----------------------------------------- admin: match a birthdates file --
// Upload a "name + date of birth" sheet. The server saves every EXACT name
// match straight away and sends back the rest; the admin then confirms each
// remaining name here (pick the person, fix the date if needed, Link & save).
let BIRTH_REPORT = null;

function birthIssueText(row) {
  if (row.status === "invalid") {
    const why = { future: "birthProblemFuture", year: "birthProblemYear", format: "birthProblemFormat", empty: "birthProblemEmpty", noname: "birthProblemNoname" }[row.problem];
    return `${t("birthIssueInvalid")}${why ? " — " + t(why) : ""}`;
  }
  return {
    near: t("birthIssueNear"),
    ambiguous: t("birthIssueAmbiguous"),
    conflict: t("birthIssueConflict"),
    none: t("birthIssueNone"),
    "dup-diff": t("birthIssueDupDiff"),
  }[row.status] || row.status;
}
function birthPersonLabel(p) {
  const kind = p.kind === "dependent" ? `${t("birthKindDep")} ${p.parentName}` : t("birthKindMember");
  const has = p.currentBirthDate ? ` · ${t("birthHasDate")} ${p.currentBirthDate}` : "";
  return `${p.name} — ${kind} (#${p.membershipNumber})${has}${p.archived ? " · " + t("birthArchivedTag") : ""}`;
}
const BIRTH_OPEN = new Set(["near", "ambiguous", "conflict", "none", "invalid", "dup-diff"]);

function renderBirthResult() {
  const box = document.getElementById("birth-result");
  const csvBtn = document.getElementById("birth-csv-btn");
  if (!BIRTH_REPORT) {
    box.innerHTML = "";
    csvBtn.classList.add("hidden");
    return;
  }
  csvBtn.classList.remove("hidden");
  const rows = BIRTH_REPORT.rows;
  const s = BIRTH_REPORT.summary;
  const manual = rows.filter((r) => r.resolved).length;
  const open = rows.filter((r) => BIRTH_OPEN.has(r.status) && !r.resolved);
  const total = s.total - s.dupFile;
  const matched = s.applied + s.already + s.linked + manual;
  const pct = total ? Math.round((matched / total) * 1000) / 10 : 0;
  const chips = [
    [t("birthStatSaved"), s.applied],
    [t("birthStatAlready"), s.already],
    [t("birthStatLinked"), s.linked + manual],
    [t("birthStatNeeds"), open.length],
  ]
    .map(([k, v]) => `<span class="fam-rel-badge" style="margin-inline-end:6px;">${escapeAttr(k)}: <b>${fmt(v)}</b></span>`)
    .join("");
  const summaryLine = t("birthSummary").replace("{matched}", fmt(matched)).replace("{total}", fmt(total)).replace("{pct}", String(pct));
  let html = `<div style="margin:10px 0;"><b style="font-size:1.05rem;">${escapeAttr(summaryLine)}</b><div style="margin-top:6px;">${chips}</div></div>`;
  if (!open.length && matched === total) html += `<p class="msg ok" style="display:block;">${escapeAttr(t("birthAllDone"))}</p>`;
  if (open.length) {
    const today = todayISO();
    const body = open
      .map((r) => {
        const idx = BIRTH_REPORT.rows.indexOf(r);
        let pick;
        if (r.candidates.length) {
          const ph = r.status === "ambiguous" || r.status === "dup-diff" ? `<option value="">${escapeAttr(t("birthPickPerson"))}</option>` : "";
          pick = `<select class="birth-pick" data-i="${idx}" style="max-width:340px;">${ph}${r.candidates
            .map((c, k) => `<option value="${escapeAttr(c.membershipNumber)}|${c.dependentId == null ? "" : c.dependentId}"${k === 0 && !ph ? " selected" : ""}>${escapeAttr(birthPersonLabel(c))}${c.score < 100 ? " · " + c.score + "%" : ""}</option>`)
            .join("")}</select>`;
        } else if (r.status === "conflict" && r.target) {
          pick = `<span>${escapeAttr(birthPersonLabel(r.target))}</span><input type="hidden" class="birth-pick" data-i="${idx}" value="${escapeAttr(r.target.membershipNumber)}|${r.target.dependentId == null ? "" : r.target.dependentId}" />`;
        } else {
          pick = `<input class="birth-mn" data-i="${idx}" placeholder="${escapeAttr(t("birthMnPlaceholder"))}" style="max-width:150px;" />`;
        }
        return `<tr data-birth-row="${idx}">
          <td class="num">${escapeAttr(r.rowNum)}</td>
          <td><bdi>${escapeAttr(r.name)}</bdi></td>
          <td><input type="date" class="birth-date" data-i="${idx}" value="${escapeAttr(r.birthDate || "")}" min="1900-01-01" max="${today}" style="max-width:150px;" /></td>
          <td>${escapeAttr(birthIssueText(r))}</td>
          <td>${pick}</td>
          <td><button class="secondary birth-link" data-i="${idx}" style="padding:4px 10px;font-size:0.78rem;">${escapeAttr(t("btnBirthLink"))}</button><div class="msg birth-row-msg" data-i="${idx}"></div></td>
        </tr>`;
      })
      .join("");
    html += `<h4 style="margin:12px 0 6px;">${escapeAttr(t("birthNeedsTitle"))} (${fmt(open.length)})</h4>
      <div class="dashboard-table-wrap"><table class="dashboard-table"><thead><tr>
        <th>${escapeAttr(t("birthColRow"))}</th><th>${escapeAttr(t("birthColName"))}</th><th>${escapeAttr(t("birthColDate"))}</th><th>${escapeAttr(t("birthColIssue"))}</th><th>${escapeAttr(t("birthColMatch"))}</th><th></th>
      </tr></thead><tbody>${body}</tbody></table></div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll(".birth-link").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const i = Number(btn.dataset.i);
      const row = BIRTH_REPORT.rows[i];
      const msg = box.querySelector(`.birth-row-msg[data-i="${i}"]`);
      const dateVal = box.querySelector(`.birth-date[data-i="${i}"]`).value;
      let mn;
      let dep = "";
      const pickEl = box.querySelector(`.birth-pick[data-i="${i}"]`);
      const mnEl = box.querySelector(`.birth-mn[data-i="${i}"]`);
      if (pickEl) {
        if (!pickEl.value) return showMsg(msg, t("birthPickPerson"), false);
        [mn, dep] = pickEl.value.split("|");
      } else {
        mn = (mnEl && mnEl.value.trim()) || "";
        if (!mn) return showMsg(msg, t("birthMnPlaceholder"), false);
      }
      if (!dateVal) return showMsg(msg, t("errBirthDateRequired"), false);
      if (dateVal > todayISO() || dateVal < "1900-01-01") return showMsg(msg, t("errBirthDateInvalid"), false);
      const cand = (row.candidates || []).concat(row.target ? [row.target] : []).find((c) => String(c.membershipNumber) === mn && String(c.dependentId == null ? "" : c.dependentId) === dep);
      if (cand && cand.currentBirthDate && cand.currentBirthDate !== dateVal) {
        if (!confirm(t("birthOverwriteConfirm").replace("{date}", cand.currentBirthDate))) return;
      }
      try {
        const r = await api(`/api/admin/members/${encodeURIComponent(mn)}/birth-date`, {
          method: "PUT",
          body: JSON.stringify({ birthDate: dateVal, dependentId: dep === "" ? undefined : Number(dep) }),
        });
        row.resolved = true;
        row.savedDate = r.birthDate;
        row.savedTo = cand ? birthPersonLabel(cand) : `#${mn}`;
        row.savedMn = mn;
        row.savedDep = dep;
        renderBirthResult();
        loadAdminMembers();
        loadAdminDirectory();
      } catch (e) {
        showMsg(msg, e.message, false);
      }
    });
  });
}

document.getElementById("birth-match-btn").addEventListener("click", async () => {
  const msg = document.getElementById("birth-msg");
  const fileInput = document.getElementById("birth-file");
  const file = fileInput.files[0];
  if (!file) return showMsg(msg, t("pleaseChooseFile"), false);
  const fd = new FormData();
  fd.append("file", file);
  showMsg(msg, t("birthBusy"), true);
  try {
    BIRTH_REPORT = await api("/api/admin/members/birthdates/import", { method: "POST", body: fd });
    msg.textContent = "";
    msg.className = "msg";
    renderBirthResult();
    loadAdminMembers();
    loadAdminDirectory();
  } catch (e) {
    BIRTH_REPORT = null;
    renderBirthResult();
    showMsg(msg, e.message, false);
  }
});

document.getElementById("birth-csv-btn").addEventListener("click", () => {
  if (!BIRTH_REPORT) return;
  const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const head = ["Row", "Name in file", "Date in file", "Result", "Matched to", "Membership no.", "Date saved"];
  const lines = [head.map(q).join(",")];
  for (const r of BIRTH_REPORT.rows) {
    let result = r.status;
    let to = r.target ? r.target.name : "";
    let mn = r.target ? r.target.membershipNumber : "";
    let saved = r.status === "applied" || r.status === "already" || r.status === "linked" ? r.birthDate : "";
    if (r.resolved) {
      result = "linked-by-admin";
      to = r.savedTo || "";
      mn = r.savedMn || "";
      saved = r.savedDate || "";
    }
    lines.push([r.rowNum, r.name, r.birthDate, result, to, mn, saved].map(q).join(","));
  }
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "birthdates-match-report.csv";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
});
