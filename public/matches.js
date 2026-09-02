currentLang = new URLSearchParams(location.search).get("lang") === "en" ? "en" : "ar";
document.documentElement.lang = currentLang;
document.documentElement.dir = currentLang === "ar" ? "rtl" : "ltr";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function eventNameHtml(ev) {
  const ar = (ev.nameAr || "").trim();
  const en = (ev.nameEn || "").trim();
  if (ar && en && ar !== en) return `<span class="lang-ar">${esc(ar)}</span><span class="lang-en">${esc(en)}</span>`;
  return esc(ar || en);
}

const params = new URLSearchParams(location.search);
const eventId = params.get("event");

async function applyTheme() {
  try {
    const res = await fetch("/api/settings");
    const data = await res.json();
    const theme = data.theme || {};
    const root = document.documentElement.style;
    if (theme.primaryColor) root.setProperty("--red", theme.primaryColor);
    if (theme.primaryColorDark) root.setProperty("--red-dark", theme.primaryColorDark);
    if (theme.accentColor) root.setProperty("--gold", theme.accentColor);
    const logo = document.getElementById("screen-logo");
    if (theme.logoUrl) {
      logo.src = theme.logoUrl;
      logo.classList.remove("hidden");
    }
  } catch (e) { /* theme is cosmetic only - never block the page on it */ }
}

function timeToMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

// Flattens every scheduled (court+time set) match across the group stage
// and the knockout bracket into one list, each carrying a human stage
// label and whether it's already decided.
function collectScheduledMatches(tn) {
  const list = [];
  (tn.groups || []).forEach((g, gi) => {
    const groupLabel = `${t("groupLabel")} ${String.fromCharCode(65 + gi)}`;
    g.matches.forEach((m) => {
      if (!m.court || !m.time) return;
      list.push({ ...m, stage: groupLabel, decided: !!m.result });
    });
  });
  if (tn.knockout) {
    const rounds = tn.knockout.rounds;
    rounds.forEach((round, ri) => {
      const isFinal = ri === rounds.length - 1;
      const isSemi = ri === rounds.length - 2;
      const roundLabel = isFinal ? t("roundFinal") : isSemi ? t("roundSemifinal") : `${t("roundLabel")} ${ri + 1}`;
      round.forEach((m) => {
        if (!m.court || !m.time || m.bye) return;
        list.push({ ...m, stage: roundLabel, decided: !!m.winnerId });
      });
    });
  }
  return list.sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time) || a.court - b.court);
}

function matchCardHtml(m, isLive) {
  const stateClass = m.decided ? "done" : isLive ? "live" : "upcoming";
  const badge = isLive && !m.decided ? `<span class="live-badge"><span class="live-badge-dot"></span>${esc(t("liveNow"))}</span>` : "";
  return `<div class="match-card ${stateClass}">
    ${badge}
    <div class="mc-top"><span class="mc-court">${esc(t("courtLabel"))} ${m.court}</span><span class="mc-time">${esc(m.time)}</span></div>
    <div class="mc-stage">${esc(m.stage)}</div>
    <div class="mc-teams">${esc(m.aLabel || t("tbd"))}<span class="mc-vs">${esc(t("vs"))}</span>${esc(m.bLabel || t("tbd"))}</div>
  </div>`;
}

function renderSlots(nowMatches, nextMatches, nowLabel, nextTime) {
  const nowHtml = nowMatches.length
    ? `<div class="slot-section"><h2><span class="live-dot"></span>${esc(t("liveNow"))}</h2><div class="match-grid">${nowMatches.map((m) => matchCardHtml(m, true)).join("")}</div></div>`
    : "";
  const nextHtml = nextMatches.length
    ? `<div class="slot-section"><h2>${esc(t("upNext"))}${nextTime ? ` <span class="slot-time">${esc(nextTime)}</span>` : ""}</h2><div class="match-grid">${nextMatches.map((m) => matchCardHtml(m, false)).join("")}</div></div>`
    : "";
  return nowHtml + nextHtml;
}

async function loadAndRenderPicker() {
  const body = document.getElementById("screen-body");
  document.getElementById("screen-title").textContent = t("tournPublicTitle");
  document.getElementById("screen-subtitle").textContent = t("liveMatchesIntro");
  try {
    const list = await (await fetch("/api/tournaments")).json();
    const scheduled = list.filter((tn) => tn.hasSchedule);
    if (!scheduled.length) {
      body.innerHTML = `<div class="empty-state"><h2>${esc(t("noScheduledTournaments"))}</h2></div>`;
      return;
    }
    body.innerHTML = `<div class="picker"><div class="picker-grid">${scheduled
      .map(
        (tn) => `<a class="picker-card" href="?event=${tn.eventId}&lang=${currentLang}">
          <h3>${eventNameHtml(tn)}</h3>
          <div class="meta">${esc(tn.date || "")}${tn.sport ? " · " + esc(tn.sport) : ""}</div>
        </a>`
      )
      .join("")}</div></div>`;
  } catch (e) {
    body.innerHTML = `<div class="empty-state"><h2>${esc(e.message)}</h2></div>`;
  }
}

async function loadAndRenderEvent() {
  const body = document.getElementById("screen-body");
  try {
    const [tnRes, listRes] = await Promise.all([fetch("/api/tournaments/" + eventId), fetch("/api/tournaments")]);
    const tnData = await tnRes.json();
    const list = await listRes.json();
    const meta = list.find((x) => String(x.eventId) === String(eventId));
    document.getElementById("screen-title").innerHTML = meta ? eventNameHtml(meta) : "Ahlawy";
    document.getElementById("screen-subtitle").textContent = meta ? `${meta.date || ""}${meta.sport ? " · " + meta.sport : ""}` : "";
    document.getElementById("screen-updated").textContent = new Date().toLocaleTimeString(currentLang === "ar" ? "ar-EG" : "en-US");

    const tn = tnData.tournament;
    if (!tn || !tn.schedule) {
      body.innerHTML = `<div class="empty-state"><h2>${esc(t("noScheduleForTournament"))}</h2></div>`;
      return;
    }
    const matches = collectScheduledMatches(tn);
    if (!matches.length) {
      body.innerHTML = `<div class="empty-state"><h2>${esc(t("tournPublicNotStarted"))}</h2></div>`;
      return;
    }
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const matchLen = tn.schedule.matchMinutes;
    const times = [...new Set(matches.map((m) => timeToMinutes(m.time)))].sort((a, b) => a - b);
    // The "current" slot is the one whose window [start, start+matchLen)
    // contains the wall-clock time; before the first slot or after the
    // last slot's window there simply is no "now", only "next"/"finished".
    let currentSlotMin = times.find((tmin) => nowMin >= tmin && nowMin < tmin + matchLen);
    let nextSlotMin;
    if (currentSlotMin !== undefined) {
      nextSlotMin = times.find((tmin) => tmin > currentSlotMin);
    } else {
      nextSlotMin = times.find((tmin) => tmin > nowMin);
    }
    const nowMatches = currentSlotMin !== undefined ? matches.filter((m) => timeToMinutes(m.time) === currentSlotMin) : [];
    const nextMatches = nextSlotMin !== undefined ? matches.filter((m) => timeToMinutes(m.time) === nextSlotMin) : [];
    let inner;
    if (!nowMatches.length && !nextMatches.length) {
      inner = `<div class="empty-state"><h2>${esc(t("tournStatusCompleted"))}</h2></div>`;
    } else {
      inner = renderSlots(nowMatches, nextMatches, null, nextSlotMin !== undefined ? minutesToStr(nextSlotMin) : null);
    }
    body.innerHTML = inner;
  } catch (e) {
    body.innerHTML = `<div class="empty-state"><h2>${esc(e.message)}</h2></div>`;
  }
}
function minutesToStr(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

async function tick() {
  if (eventId) await loadAndRenderEvent();
  else await loadAndRenderPicker();
}

const liveIndicator = document.querySelector(".live");
if (liveIndicator) liveIndicator.style.display = eventId ? "" : "none";

applyTheme();
tick();
if (eventId) setInterval(tick, 15000);
