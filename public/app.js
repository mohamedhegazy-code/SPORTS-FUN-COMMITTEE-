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
    // Keep the full response body on the thrown error (not just .message) -
    // some error responses (e.g. "already registered") carry extra fields
    // like a still-valid QR code that callers want to use instead of just
    // showing the error text.
    const err = new Error(data.error || t("errGeneric"));
    err.data = data;
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
function eventLabel(ev) {
  return currentLang === "ar" ? (ev.nameAr || ev.nameEn) : ev.nameEn;
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
function isUpcoming(ev) {
  return ev.date >= todayStr();
}
function isPastEvent(ev) {
  return ev.date < todayStr();
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
function eventDesc(ev) {
  return currentLang === "ar" ? ev.descriptionAr || ev.descriptionEn : ev.descriptionEn || ev.descriptionAr;
}
function eventRecapDesc(ev) {
  const r = ev.recap || {};
  return currentLang === "ar" ? r.descriptionAr || r.descriptionEn : r.descriptionEn || r.descriptionAr;
}

// ------------------------------------------------------------------- tabs --
function switchTab(view) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
  // Re-fetch events whenever the landing page (or Annual Activities) is
  // opened, so any admin edit made elsewhere shows up without a full page
  // reload.
  if (view === "events" || view === "annual") loadEvents();
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
  renderEventDropdowns();
  renderEventsGrid();
  renderAnnualGrid();
  renderFeaturedEvents();
  loadCommunityContent();
}
function renderEventDropdowns() {
  // Members can only register for events that haven't happened yet. Full
  // events stay in the list (not hidden) - selecting one still works, it
  // just leads to a waiting-list offer instead of an instant confirmed spot.
  const upcoming = EVENTS_DATA.filter(isUpcoming);
  const regOpts = upcoming
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
function eventCardHtml(ev, isPast, featured) {
  const photo = isPast && ev.recap && ev.recap.photos && ev.recap.photos.length ? ev.recap.photos[0] : ev.coverPhoto;
  const photoStyle = photo ? ` style="background-image:url('${escapeAttr(photo)}')"` : "";
  const desc = isPast ? eventRecapDesc(ev) || eventDesc(ev) : eventDesc(ev);
  return `
    <div class="event-card" data-event-id="${ev.id}">
      <div class="photo" data-action="details"${photoStyle}>${photo ? "" : escapeAttr(t("noPhoto"))}</div>
      <div class="body">
        ${featured ? `<span class="featured-tag">${escapeAttr(t("featuredEventsTitle"))}</span>` : ""}
        <h3 data-action="details">${escapeAttr(eventLabel(ev))}</h3>
        <div class="meta">${escapeAttr(ev.date)}${ev.sport ? " · " + escapeAttr(ev.sport) : ""} ${capacityBadgeHtml(ev)}</div>
        <div class="snippet">${escapeAttr(truncate(desc, 110))}</div>
        <div class="actions">
          <button class="secondary" data-action="details">${t("btnMoreDetails")}</button>
          ${isPast ? "" : `<button class="primary" data-action="register">${t("btnRegisterCard")}</button>`}
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
  });
}
function renderEventsGrid() {
  const grid = document.getElementById("events-grid");
  const empty = document.getElementById("events-empty");
  if (!grid) return;
  const upcoming = EVENTS_DATA.filter(isUpcoming).sort((a, b) => a.date.localeCompare(b.date));
  empty.classList.toggle("hidden", upcoming.length > 0);
  grid.innerHTML = upcoming.map((ev) => eventCardHtml(ev, false)).join("");
  wireEventCardButtons(grid, upcoming, false);
}
function renderAnnualGrid() {
  const grid = document.getElementById("annual-grid");
  const empty = document.getElementById("annual-empty");
  if (!grid) return;
  const past = EVENTS_DATA.filter(isPastEvent).sort((a, b) => b.date.localeCompare(a.date));
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
  const upcoming = EVENTS_DATA.filter(isUpcoming).sort((a, b) => a.date.localeCompare(b.date));
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
  const desc = eventDesc(ev);
  const recap = ev.recap || {};
  const recapDesc = eventRecapDesc(ev);
  const recapPhotos = recap.photos || [];
  const heroPhoto = isPast && recapPhotos.length ? recapPhotos[0] : ev.coverPhoto;
  const galleryPhotos = isPast && recapPhotos.length > 1 ? recapPhotos.slice(1) : [];
  content.innerHTML = `
    <span class="event-badge ${isPast ? "past" : ""}">${isPast ? t("eventPast") : t("eventUpcoming")}</span>
    ${heroPhoto ? `<img class="photo-hero" src="${escapeAttr(heroPhoto)}" alt="" />` : ""}
    <h2>${escapeAttr(eventLabel(ev))}</h2>
    <div class="meta" style="margin-bottom:12px;">${escapeAttr(ev.date)}${ev.sport ? " · " + escapeAttr(ev.sport) : ""}</div>
    ${desc ? `<h3>${t("aboutTitle")}</h3><p class="desc">${escapeAttr(desc)}</p>` : ""}
    ${isPast && recapDesc ? `<h3>${t("recapTitle")}</h3><p class="desc">${escapeAttr(recapDesc)}</p>` : ""}
    ${
      galleryPhotos.length
        ? `<h3>${t("photosTitle")}</h3><div class="photo-gallery">${galleryPhotos
            .map((p) => `<img src="${escapeAttr(p)}" alt="" />`)
            .join("")}</div>`
        : ""
    }
    ${!isPast ? `<p style="color:var(--muted);font-size:0.85rem;">${t("goToRegisterHint")}</p><button class="primary" id="modal-register-btn" style="width:100%;">${t("btnRegisterCard")}</button>` : ""}
  `;
  if (!isPast) {
    document.getElementById("modal-register-btn").addEventListener("click", () => {
      closeEventModal();
      startRegisterFlow(ev);
    });
  }
  document.getElementById("event-modal").classList.remove("hidden");
}
function closeEventModal() {
  document.getElementById("event-modal").classList.add("hidden");
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
  if (!badge) return;
  if (!CURRENT_SESSION || CURRENT_SESSION.type !== "staff" || CURRENT_SESSION.staff.role !== "admin") {
    badge.classList.add("hidden");
    return;
  }
  try {
    const { count } = await api("/api/staff/chats/unread-count");
    if (count > 0) {
      badge.textContent = count > 9 ? "9+" : String(count);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
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
      </tr>`;
    })
    .join("");
  wrap.innerHTML = `<div class="dashboard-table-wrap"><table class="dashboard-table">
    <thead><tr>
      <th>${t("colEvent")}</th><th>${t("colDate")}</th><th>${t("colRegistrations")}</th>
      <th>${t("colWaitlist")}</th><th>${t("colCheckedIn")}</th><th>${t("colAttendance")}</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
  wrap.querySelectorAll("[data-waitlist-event]").forEach((btn) => {
    btn.addEventListener("click", () =>
      openAdminWaitlist(Number(btn.dataset.waitlistEvent), btn.dataset.waitlistLabel)
    );
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
      <th></th><th>${t("colMembershipNumber")}</th><th>${t("colName")}</th>
      <th>${t("colPhone")}</th><th>${t("colFamilyGroup")}</th><th>${t("colHasAccount")}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
  applyMembersSearchFilter();
}

// Filtering hides/shows existing rows rather than rebuilding the table, so
// any checkboxes the admin already ticked survive typing in the search box.
function applyMembersSearchFilter() {
  const query = document.getElementById("members-search").value.trim().toLowerCase();
  document.querySelectorAll("#members-table [data-member-row]").forEach((row) => {
    row.classList.toggle("hidden", !!query && !row.dataset.search.includes(query));
  });
}
document.getElementById("members-search").addEventListener("input", applyMembersSearchFilter);

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
    showMsg(
      msg,
      `${t("importedLabel")}: ${fmt(result.created.length)} ${t("addedLabel")}, ${fmt(result.updated.length)} ${t("updatedLabel")}, ${fmt(result.errors.length)} ${t("skippedLabel")}.`,
      true
    );
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
  const earlyDeadline = document.getElementById("ev-deadline").value;
  const descriptionEn = document.getElementById("ev-desc-en").value.trim();
  const descriptionAr = document.getElementById("ev-desc-ar").value.trim();
  const minCapacity = document.getElementById("ev-min-capacity").value;
  const maxCapacity = document.getElementById("ev-max-capacity").value;
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
  fd.append("earlyDeadline", datetimeLocalToIsoOrEmpty(earlyDeadline));
  fd.append("descriptionEn", descriptionEn);
  fd.append("descriptionAr", descriptionAr);
  fd.append("minCapacity", minCapacity);
  fd.append("maxCapacity", maxCapacity);
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
  const earlyDeadline = document.getElementById("ev-edit-deadline").value;
  const descriptionEn = document.getElementById("ev-edit-desc-en").value.trim();
  const descriptionAr = document.getElementById("ev-edit-desc-ar").value.trim();
  const minCapacity = document.getElementById("ev-edit-min-capacity").value;
  const maxCapacity = document.getElementById("ev-edit-max-capacity").value;
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
  fd.append("earlyDeadline", datetimeLocalToIsoOrEmpty(earlyDeadline));
  fd.append("descriptionEn", descriptionEn);
  fd.append("descriptionAr", descriptionAr);
  fd.append("minCapacity", minCapacity);
  fd.append("maxCapacity", maxCapacity);
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
          ${r.status === "Pending" ? `<button class="secondary" onclick="setRedemptionStatus(${r.id},'Approved')">${t("approve")}</button>
          <button class="secondary" onclick="setRedemptionStatus(${r.id},'Rejected')">${t("reject")}</button>` : ""}
          ${r.status === "Approved" ? `<button class="secondary" onclick="setRedemptionStatus(${r.id},'Fulfilled')">${t("fulfill")}</button>` : ""}
        </td>
      </tr>`
        )
        .join("")}
    </tbody>
  </table>`;
}
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
            : `<button class="secondary" onclick="removeStaffAccount('${s.username}')">${t("btnRemove")}</button>`
        }</td>
      </tr>`
        )
        .join("")}
    </tbody>
  </table>`;
}
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

// ------------------------------------------------------------------- init --
(async function init() {
  applyI18n();
  await loadSettings();
  await loadEvents();
  await loadLadder();
  await checkSession();
})();
