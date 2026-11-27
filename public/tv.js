"use strict";
// Venue TV board (tv.html). Reads the same public data as the other public pages: GET /api/tournaments/:eventId.
currentLang = new URLSearchParams(location.search).get("lang") === "en" ? "en" : "ar";
document.documentElement.lang = currentLang;
document.documentElement.dir = currentLang === "ar" ? "rtl" : "ltr";
const params = new URLSearchParams(location.search);
const eventId = params.get("event");
const REFRESH_MS = 10000, ROTATE_MS = 12000;

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (id) => document.getElementById(id);
const tv = (key, vars) => { let s = t(key); for (const k in vars || {}) s = s.replace("{" + k + "}", vars[k]); return s; };
function eventNameHtml(ev) {
  const ar = (ev.nameAr || "").trim(), en = (ev.nameEn || "").trim();
  if (ar && en && ar !== en) return `<span class="lang-${currentLang === "ar" ? "ar" : "en"}">${esc(currentLang === "ar" ? ar : en)}</span><span class="lang-${currentLang === "ar" ? "en" : "ar"}">${esc(currentLang === "ar" ? en : ar)}</span>`;
  return esc(ar || en);
}
const firstTwo = (n) => String(n || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).join(" ") || n || "";
function roster(entrants, id) {
  const e = entrants && entrants.find((x) => x.id === id);
  return e && e.players && e.players.length ? e.players.map(firstTwo).join(" · ") : "";
}
const toMin = (hhmm) => { const [h, m] = String(hhmm || "99:99").split(":").map(Number); return h * 60 + m; };
// The club works on Cairo time: schedules are Cairo clock times whatever time zone the TV's computer is set to.
const cairoFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
function cairoNow() { const p = Object.fromEntries(cairoFmt.formatToParts(new Date()).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute), hhmm: `${p.hour}:${p.minute}` }; }
const todayStr = () => cairoNow().date;

// ---------------------------------------------------------------- data -> flat match list
function roundLabel(ri, total, m) {
  if (m && m.place) return t(m.place === 3 ? "matchThirdTitle" : "matchFinalTitle");
  if (ri === total - 1) return t("roundFinal");
  if (ri === total - 2) return t("roundSemifinal");
  return t("roundLabel") + " " + (ri + 1);
}
function collect(tn) {
  const list = [];
  (tn.groups || []).forEach((g, gi) => {
    const stage = t("groupLabel") + " " + String.fromCharCode(65 + gi);
    g.matches.forEach((m, mi) => list.push({ kind: "gr", stage, rank: 0, seq: gi * 1000 + mi, a: m.a, b: m.b, aLabel: m.aLabel, bLabel: m.bLabel, court: m.court || null, time: m.time || null, date: m.date || null, decided: !!m.result, scoreA: m.result ? m.result.scoreA : null, scoreB: m.result ? m.result.scoreB : null, winnerId: m.result ? m.result.winnerId : null, decidedAt: m.decidedAt || null }));
  });
  if (tn.knockout) {
    const total = tn.knockout.rounds.length;
    tn.knockout.rounds.forEach((round, ri) => round.forEach((m, mi) => {
      if (m.bye) return;
      list.push({ kind: "ko", stage: roundLabel(ri, total, m), rank: 1 + ri, ri, total, seq: ri * 1000 + mi, a: m.a, b: m.b, aLabel: m.aLabel, bLabel: m.bLabel, court: m.court || null, time: m.time || null, date: m.date || null, decided: !!m.winnerId, scoreA: m.scoreA, scoreB: m.scoreB, winnerId: m.winnerId || null, decidedAt: m.decidedAt || null });
    }));
  }
  if (tn.swiss) {
    tn.swiss.rounds.forEach((r) => r.pairings.forEach((p, pi) => {
      if (p.b == null) return;
      const res = p.result;
      list.push({ kind: "sw", stage: tv("roundNo", { n: r.number }), rank: r.number, seq: r.number * 1000 + pi, a: p.a, b: p.b, aLabel: p.aLabel, bLabel: p.bLabel, court: p.table || p.board || null, time: p.time || r.time || null, date: null, decided: res != null, scoreA: null, scoreB: null, winnerId: res === "1-0" ? p.a : res === "0-1" ? p.b : null, swissResult: res || null, decidedAt: null });
    }));
  }
  return list;
}
const isReady = (m) => !!m.a && !!m.b;
const today = () => todayStr();
const isTodayOrUndated = (m) => !m.date || m.date === today();

function buildState(tn) {
  const all = collect(tn).filter(isTodayOrUndated);
  const done = all.filter((m) => m.decided);
  const pending = all.filter((m) => !m.decided && isReady(m) && m.court).sort((x, y) => toMin(x.time) - toMin(y.time) || x.rank - y.rank || x.seq - y.seq);
  const courts = [...new Set(all.filter((m) => m.court).map((m) => m.court))].sort((a, b) => a - b);
  const nowByCourt = new Map();
  for (const m of pending) if (!nowByCourt.has(m.court)) nowByCourt.set(m.court, m);
  const nowSet = new Set(nowByCourt.values());
  const next = pending.filter((m) => !nowSet.has(m)).slice(0, 7);
  const results = done.slice().sort((x, y) => (y.decidedAt || "").localeCompare(x.decidedAt || "") || y.rank - x.rank || y.seq - x.seq).slice(0, 8);
  return { all, done, pending, courts, nowByCourt, next, results, total: all.length, played: done.length };
}

// ---------------------------------------------------------------- pieces
function namesOf(tn, m) {
  return [["a", m.aLabel, m.a], ["b", m.bLabel, m.b]].map(([, label, id]) => ({ label: label || t("tbd"), sub: roster(tn.entrants, id) }));
}
function courtTile(tn, court, m) {
  const no = `<span class="court-no"><i>${court}</i>${esc(t("courtLabel"))}</span>`;
  if (!m) return `<div class="court idle"><div class="court-top">${no}<span class="court-badge">${esc(t("tvFree"))}</span></div><div class="court-empty">${esc(t("tvFree"))}</div></div>`;
  const [A, B] = namesOf(tn, m);
  const soon = !m.time || toMin(m.time) - cairoNow().min <= 10;
  const badge = soon ? esc(t("liveNow")) : esc(tv("tvStarts", { time: m.time }));
  return `<div class="court ${soon ? "live" : ""}">
    <div><div class="court-top">${no}<span class="court-badge">${badge}</span></div><div class="court-stage">${esc(m.stage)}</div></div>
    <div class="court-sides"><div class="side">${esc(A.label)}${A.sub ? `<small>${esc(A.sub)}</small>` : ""}</div><div class="vs">${esc(t("vs"))}</div><div class="side">${esc(B.label)}${B.sub ? `<small>${esc(B.sub)}</small>` : ""}</div></div>
    <div class="court-foot">${m.time ? esc(m.time) : ""}</div>
  </div>`;
}
function nextRow(m) {
  return `<div class="row"><span class="when">${esc(m.time || "—")}</span><span class="who">${esc(m.aLabel)}<em>${esc(t("vs"))}</em>${esc(m.bLabel)}<span class="meta">${esc(t("courtLabel"))} ${m.court} · ${esc(m.stage)}</span></span></div>`;
}
function resultRow(m) {
  let sc = "–";
  if (m.kind === "sw") sc = m.swissResult === "1/2-1/2" ? "½ – ½" : m.swissResult === "1-0" ? "1 – 0" : "0 – 1";
  else if (m.scoreA != null && m.scoreB != null) sc = `${m.scoreA} – ${m.scoreB}`;
  else if (m.winnerId) sc = "✓";
  return `<div class="row res"><span class="t a ${m.winnerId === m.a ? "w" : ""}">${esc(m.aLabel)}</span><span class="sc">${esc(sc)}</span><span class="t b ${m.winnerId === m.b ? "w" : ""}">${esc(m.bLabel)}</span><span class="st">${esc(m.stage)}${m.court ? " · " + esc(t("courtLabel")) + " " + m.court : ""}</span></div>`;
}

// ---------------------------------------------------------------- rotating panel slides
function groupTables(tn) {
  const q = tn.advancePerGroup || 0;
  const chunks = [];
  const groups = tn.groups || [];
  const per = groups.length > 4 ? 4 : groups.length;
  for (let i = 0; i < groups.length; i += per) chunks.push(groups.slice(i, i + per).map((g, k) => ({ g, gi: i + k })));
  return chunks.map((chunk) => ({
    key: "g" + chunk[0].gi,
    title: t("tvTables"),
    html: `<div class="slide tables" style="--cols:${chunk.length > 1 ? 2 : 1}">${chunk.map(({ g, gi }) => `<div class="gt"><h3>${esc(t("groupLabel"))} ${String.fromCharCode(65 + gi)}</h3><table><thead><tr><th></th><th class="n" style="text-align:start">${esc(t("colName"))}</th><th>${esc(t("tvColP"))}</th><th>${esc(t("tvColGD"))}</th><th>${esc(t("tvColPts"))}</th></tr></thead><tbody>${g.standings.slice(0, 6).map((s, i) => `<tr class="${q && i < q && g.standings.some((x) => x.played > 0) ? "q" : ""}"><td>${i + 1}</td><td class="n">${esc(s.label)}</td><td>${s.played}</td><td>${s.gf - s.ga > 0 ? "+" : ""}${s.gf - s.ga}</td><td class="p">${s.points}</td></tr>`).join("")}</tbody></table></div>`).join("")}</div>`,
  }));
}
function bracketSlide(tn) {
  const rounds = tn.knockout ? tn.knockout.rounds : [];
  if (!rounds.length) return [];
  const real = rounds.map((r, ri) => ({ ri, ms: r.filter((m) => !m.bye) }));
  let first = real.findIndex((r) => r.ms.some((m) => !m.winnerId));
  if (first < 0) first = Math.max(0, real.length - 3);
  const shown = real.slice(first, first + 3);
  const cols = shown.map(({ ri, ms }) => {
    const cap = 6;
    const doneN = ms.filter((m) => m.winnerId).length;
    const items = ms.slice(0, cap).map((m) => {
      const sc = (x) => (m.scoreA != null && m.scoreB != null ? (x === "a" ? m.scoreA : m.scoreB) : "");
      const cls = (id) => (m.winnerId ? (m.winnerId === id ? "w" : "l") : "");
      return `<div class="bm"><div class="${cls(m.a)}"><span>${esc(m.aLabel || t("tbd"))}</span><span>${sc("a")}</span></div><div class="${cls(m.b)}"><span>${esc(m.bLabel || t("tbd"))}</span><span>${sc("b")}</span></div></div>`;
    }).join("");
    const more = ms.length > cap ? `<div class="tv-more">${esc(tv("tvMore", { n: ms.length - cap }))} · ${esc(tv("tvRoundDone", { done: doneN, total: ms.length }))}</div>` : "";
    return `<div class="bcol"><h3>${esc(roundLabel(ri, rounds.length, ms[0]))}</h3>${items}${more}</div>`;
  });
  return [{ key: "bracket", title: t("tvBracket"), html: `<div class="slide bracket" style="--cols:${shown.length}">${cols.join("")}</div>` }];
}
function swissSlide(tn) {
  const sw = tn.swiss;
  if (!sw || !sw.standings) return [];
  const rows = sw.standings.filter((s) => s.recorded > 0).slice(0, 8);
  if (!rows.length) return [];
  return [{ key: "swiss", title: t("tvTables"), html: `<div class="slide tables" style="--cols:1"><div class="gt"><h3>${esc(t("swissStandingsTitle"))}</h3><table><thead><tr><th></th><th style="text-align:start">${esc(t("colName"))}</th><th>${esc(t("tvColPts"))}</th></tr></thead><tbody>${rows.map((s) => `<tr><td>${s.rank}</td><td class="n">${esc(s.label)}</td><td class="p">${s.points}</td></tr>`).join("")}</tbody></table></div></div>` }];
}
function championSlide(tn) {
  if (tn.status !== "completed" || !tn.standings || !tn.standings.length) return [];
  const [w, s2, s3] = tn.standings;
  const nm = (x) => (x ? esc(x.label) : "");
  return [{ key: "champ", title: t("rnChampion"), html: `<div class="slide champ"><div class="champ-trophy">🏆</div><div class="champ-label">${esc(t("rnChampion"))}</div><div class="champ-name">${nm(w)}</div>${s2 || s3 ? `<div class="podium">${s2 ? `<span>🥈 <b>${nm(s2)}</b></span>` : ""}${s3 ? `<span>🥉 <b>${nm(s3)}</b></span>` : ""}</div>` : ""}</div>` }];
}
function buildSlides(tn) {
  return [...championSlide(tn), ...swissSlide(tn), ...groupTables(tn), ...bracketSlide(tn)];
}

// ---------------------------------------------------------------- render
let slides = [], slideKey = null, lastTn = null;
function renderSlide() {
  const box = $("tv-slide");
  if (!box) return;
  if (!slides.length) { box.innerHTML = `<div class="tv-empty">${esc(t("tvNoTables"))}</div>`; $("tv-dots").innerHTML = ""; return; }
  let i = slides.findIndex((s) => s.key === slideKey);
  if (i < 0) { i = 0; slideKey = slides[0].key; }
  const s = slides[i];
  $("tv-panel-title").textContent = s.title;
  $("tv-dots").innerHTML = slides.length > 1 ? slides.map((_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("") : "";
  if (box.dataset.k !== s.key || box.dataset.h !== String(s.html.length)) { box.innerHTML = s.html; box.dataset.k = s.key; box.dataset.h = String(s.html.length); }
}
function rotate() {
  if (slides.length < 2) return;
  const i = slides.findIndex((s) => s.key === slideKey);
  slideKey = slides[(i + 1) % slides.length].key;
  const box = $("tv-slide"); if (box) box.dataset.k = "";
  renderSlide();
}
// Show only the rows that fit completely - a half-cut row on a TV looks broken.
function fitList(el) {
  if (!el) return;
  [...el.children].forEach((c) => c.classList.remove("fit-hide"));
  const rows = [...el.children];
  for (let i = rows.length - 1; i >= 0 && el.scrollHeight > el.clientHeight + 1; i--) rows[i].classList.add("fit-hide");
}
function skeleton() {
  $("tv-main").innerHTML = `
    <section class="tv-box tv-live"><h2><span class="tv-live-dot"></span>${esc(t("liveNow"))}</h2><div class="tv-courts" id="tv-courts"></div></section>
    <section class="tv-box tv-next"><h2>${esc(t("upNext"))}</h2><div class="tv-list" id="tv-next"></div></section>
    <section class="tv-box tv-panel"><div class="panel-head"><h2 id="tv-panel-title">${esc(t("tvTables"))}</h2><div class="dots" id="tv-dots"></div></div><div id="tv-slide" style="flex:1;min-height:0;display:flex;flex-direction:column"></div></section>
    <section class="tv-box tv-results"><h2>${esc(t("tvResults"))}</h2><div class="tv-list" id="tv-results"></div></section>`;
}
function fullMessage(html) { $("tv-main").innerHTML = `<div class="tv-fullmsg"><div>${html}</div></div>`; $("tv-progress").hidden = true; }

function render(tn, meta) {
  lastTn = tn;
  const st = buildState(tn);
  if (!$("tv-courts")) skeleton();
  const n = st.courts.length || 1;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
  $("tv-courts").style.setProperty("--cols", cols);
  $("tv-courts").innerHTML = st.courts.length ? st.courts.map((c) => courtTile(tn, c, st.nowByCourt.get(c))).join("") : `<div class="tv-empty">${esc(t("tvWaiting"))}</div>`;
  $("tv-next").innerHTML = st.next.length ? st.next.map(nextRow).join("") : `<div class="tv-empty">${esc(t("tvNothingNext"))}</div>`;
  $("tv-results").innerHTML = st.results.length ? st.results.map(resultRow).join("") : `<div class="tv-empty">${esc(t("tvNoResults"))}</div>`;
  fitList($("tv-next")); fitList($("tv-results"));
  $("tv-progress").hidden = !st.total;
  $("tv-progress-text").textContent = tv("tvProgress", { done: st.played, total: st.total });
  $("tv-bar-fill").style.width = st.total ? Math.round((st.played / st.total) * 100) + "%" : "0";
  slides = buildSlides(tn);
  renderSlide();
}

async function applyTheme() {
  try {
    const theme = (await (await fetch("/api/settings")).json()).theme || {};
    const root = document.documentElement.style;
    if (theme.primaryColor) root.setProperty("--red", theme.primaryColor);
    if (theme.primaryColorDark) root.setProperty("--red-dark", theme.primaryColorDark);
    if (theme.accentColor) root.setProperty("--gold", theme.accentColor);
    if (theme.logoUrl) { $("tv-logo").src = theme.logoUrl; $("tv-logo").classList.remove("hidden"); }
  } catch (e) { /* cosmetic only */ }
}

let metaCache = null, metaAt = 0;
async function loadMeta() {
  if (metaCache && Date.now() - metaAt < 60000) return metaCache;
  metaCache = await (await fetch("/api/tournaments")).json(); metaAt = Date.now();
  return metaCache;
}
async function loadPicker() {
  $("tv-title").textContent = "MyAhlawy TV";
  $("tv-sub").textContent = t("tvPickIntro");
  const list = (await loadMeta()).filter((x) => x.hasSchedule);
  $("tv-main").innerHTML = list.length
    ? `<div class="tv-pick"><h2>${esc(t("tvPickIntro"))}</h2>${list.map((x) => `<a href="?event=${x.eventId}&lang=${currentLang}">${eventNameHtml(x)}<small>${esc(x.date || "")}${x.sport ? " · " + esc(x.sport) : ""}</small></a>`).join("")}</div>`
    : `<div class="tv-fullmsg"><div>${esc(t("noScheduledTournaments"))}</div></div>`;
}
async function loadEvent() {
  const [tnRes, meta] = await Promise.all([fetch("/api/tournaments/" + eventId), loadMeta()]);
  const tn = (await tnRes.json()).tournament;
  const m = meta.find((x) => String(x.eventId) === String(eventId));
  if (m) { $("tv-title").innerHTML = eventNameHtml(m); $("tv-sub").textContent = `${m.date || ""}${m.sport ? " · " + m.sport : ""}`; }
  if (!tn || !(tn.groups || tn.knockout || tn.swiss)) return fullMessage(`<b>${esc(t("tvNotStarted"))}</b>${esc(t("tournPublicNotStarted"))}`);
  render(tn, m);
}
async function tick() {
  try {
    if (eventId) await loadEvent(); else await loadPicker();
    $("tv-note").hidden = true;
  } catch (e) { $("tv-note").textContent = t("tvReconnecting"); $("tv-note").hidden = false; }
}
function clock() { $("tv-clock").textContent = cairoNow().hhmm; }

applyTheme(); clock(); setInterval(clock, 1000); tick();
if (eventId) { setInterval(tick, REFRESH_MS); setInterval(rotate, ROTATE_MS); }
document.addEventListener("keydown", (e) => { if (e.key === "f" || e.key === "F") { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); } });
let idleTimer; const wake = () => { document.body.classList.remove("idle"); clearTimeout(idleTimer); idleTimer = setTimeout(() => document.body.classList.add("idle"), 3000); };
document.addEventListener("mousemove", wake); wake();
