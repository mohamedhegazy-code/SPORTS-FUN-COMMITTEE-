"use strict";
// Member event page: /me.html?event=ID[&no=NUMBER][&lang=en]. No sign-in; the short number printed above the QR code is the key.
// Data comes from GET /api/public/me (see buildMemberView in server.js).
const meParams = new URLSearchParams(location.search);
currentLang = meParams.get("lang") === "en" ? "en" : "ar";
document.documentElement.lang = currentLang;
document.documentElement.dir = currentLang === "ar" ? "rtl" : "ltr";
const meEventId = Number(meParams.get("event")) || 0;
const meEl = (id) => document.getElementById(id);
const meT = (key, vars) => pcT(key, vars);
let meNo = "";
let meTimer = null;
let meData = null;
const meStoreKey = "me:no:" + meEventId;
function meStoreGet() { try { return localStorage.getItem(meStoreKey) || ""; } catch (e) { return ""; } }
function meStoreSet(v) { try { if (v) localStorage.setItem(meStoreKey, v); else localStorage.removeItem(meStoreKey); } catch (e) { /* private mode: fine */ } }

(function chrome() {
  const a = meEl("me-lang");
  const other = currentLang === "ar" ? "en" : "ar";
  const q = new URLSearchParams(location.search); q.set("lang", other);
  a.textContent = other === "en" ? "EN" : "عربي";
  a.href = "?" + q.toString();
  document.title = "MyAhlawy - " + t("meTitle");
  meEl("me-no-label").textContent = t("meEnterNumber");
  meEl("me-go").textContent = t("meShow");
  meEl("me-change").textContent = t("meChange");
})();

function meEventName(ev) { return ev ? (currentLang === "ar" ? ev.nameAr || ev.nameEn : ev.nameEn || ev.nameAr) || "" : ""; }
function meSay(text, info) { const m = meEl("me-msg"); m.textContent = text || ""; m.classList.toggle("info", !!info); }
function meDate(d) {
  try { return new Date(d + "T12:00:00Z").toLocaleDateString(currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }); } catch (e) { return d; }
}
function meOppHtml(item) {
  if (item.opponentKnown) return `<div class="me-opp"><bdi>${pcEsc(item.opponent)}</bdi></div>`;
  const h = item.hint;
  let hint = "";
  if (h) hint = h.a && h.b ? meT("meWinnerOf", { a: h.a, b: h.b }) : t("meWinnerUnknown");
  return `<div class="me-opp tbd">${pcEsc(t("cardTbaOpp"))}</div>${hint ? `<div class="me-opp-hint">${pcEsc(hint)}</div>` : ""}`;
}
function meWaitHtml(d) {
  const e = d.estimate, n = d.card && d.card.next;
  if (!e || !n) return "";
  if (e.kind === "due") return `<div class="me-wait due">${pcEsc(n.court ? meT("meDueNow", { court: n.court }) : t("meDueNowNoCourt"))}</div>`;
  if (e.kind === "waiting") return `<div class="me-wait"><div class="sub">${pcEsc(t("meWaitingOpp"))}</div></div>`;
  if (e.kind === "later") return `<div class="me-wait"><div class="sub">${pcEsc(meT("meLater", { date: meDate(e.date), time: e.time }))}</div></div>`;
  if (e.kind === "soon") {
    const mins = e.minutes;
    const big = mins >= 60 ? meT("meHoursMin", { h: Math.floor(mins / 60), m: mins % 60 }) : meT("meMinutes", { n: mins });
    return `<div class="me-wait"><div class="sub">${pcEsc(t("meEstWaitLabel"))}</div><div class="big">${pcEsc("~ " + big)}</div>
      <div class="sub">${pcEsc(meT("meExpectedAt", { time: e.startAt }))}${e.delayMinutes >= 5 ? " · " + pcEsc(meT("meBehind", { n: e.delayMinutes })) : ""}</div></div>`;
  }
  return `<div class="me-wait"><div class="sub">${pcEsc(t("cardTbaTime"))}</div></div>`;
}
function meNextHtml(d) {
  const n = d.card && d.card.next;
  if (!n) {
    const j = d.card && d.card.journey;
    let title = t("cardNoNext");
    if (j && j.champion) title = "🏆 " + t("rnChampion");
    else if (j && j.finished && j.finalPlace) title = pcT("cardPlace", { place: j.finalPlace });
    else if (j && j.lostAtRound != null) title = pcT("cardOutKo", { stage: pcRoundName(j.lostAtRound, d.card.tournament.koRounds) });
    else if (j && j.groupInfo && d.card.tournament.koRounds > 0 && !j.inKnockout) title = t("cardOutGroup");
    return `<div class="me-next"><div class="me-opp">${pcEsc(title)}</div></div>`;
  }
  return `<div class="me-next">
    <div class="pc-ribbon">${pcEsc(pcStageLabel(n.stage))}</div>
    <div class="me-vs">${pcEsc(t("vs"))}</div>
    ${meOppHtml(n)}
    <div class="me-facts"><div><small>${pcEsc(t("courtLabel"))}</small><strong>${n.court ? pcEsc(n.court) : "—"}</strong></div><div><small>${pcEsc(t("cardTime"))}</small><strong>${n.time ? pcEsc(n.time) : "—"}</strong></div></div>
    ${meWaitHtml(d)}
  </div>`;
}
function mePathHtml(d) {
  const path = (d.card && d.card.path) || [];
  if (!path.length) return "";
  let nowDone = false;
  const rows = path.map((m) => {
    let cls = "", right = "";
    if (m.projected) {
      cls = "proj";
      right = `<div class="rt">${m.time ? pcEsc(m.time) : "—"}<small>${m.court ? pcEsc(t("courtLabel") + " " + m.court) : ""}</small></div>`;
    } else if (m.decided) {
      cls = m.won === true ? "won" : m.won === false ? "lost" : "";
      const sc = m.scoreFor != null && m.scoreAgainst != null ? `${m.scoreFor} – ${m.scoreAgainst}` : "";
      right = `<div class="rt">${pcEsc(sc)}<small>${pcEsc(m.won === true ? t("cardWon") : m.won === false ? t("cardLost") : t("cardDraw"))}</small></div>`;
    } else {
      if (!nowDone) { cls = "now"; nowDone = true; }
      right = `<div class="rt">${m.time ? pcEsc(m.time) : "—"}<small>${m.court ? pcEsc(t("courtLabel") + " " + m.court) : ""}</small></div>`;
    }
    const opp = m.opponentKnown
      ? `<div class="op"><bdi>${pcEsc(m.opponent)}</bdi></div>`
      : `<div class="op tbd">${pcEsc(t("cardTbaOpp"))}${m.hint && m.hint.a && m.hint.b ? ` · ${pcEsc(meT("meWinnerOf", { a: m.hint.a, b: m.hint.b }))}` : ""}</div>`;
    return `<li class="${cls}"><div><div class="st">${m.projected ? pcEsc(t("meIfWin")) + " · " : ""}${pcEsc(pcStageLabel(m.stage))}</div>${opp}</div>${right}</li>`;
  });
  return `<h3 class="me-h">${pcEsc(t("mePathTitle"))}</h3><ul class="me-path">${rows.join("")}</ul>`;
}
function meHtml(d) {
  const p = d.player;
  const pills = [];
  pills.push(`<span class="me-pill ${p.waitlisted ? "warn" : "ok"}">${pcEsc(p.waitlisted ? t("meWaitlist") : t("meRegistered"))}</span>`);
  if (!p.waitlisted) {
    const at = p.checkedInAt ? new Date(p.checkedInAt).toLocaleTimeString(currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
    pills.push(p.checkedIn ? `<span class="me-pill ok">✓ ${pcEsc(t("meCheckedIn"))}${at ? " · " + pcEsc(at) : ""}</span>` : `<span class="me-pill warn">${pcEsc(t("meNotCheckedIn"))}</span>`);
  }
  let body = "";
  const tn = d.tournament;
  if (p.waitlisted) body = `<p class="me-hint">${pcEsc(t("meWaitlistNote"))}</p>`;
  else if (!tn) body = `<p class="me-hint">${pcEsc(t("meNoMatches"))}</p>`;
  else if (!tn.generated) body = `<p class="me-hint">${pcEsc(t("meNoDraw"))}</p>`;
  else if (!tn.inDraw) body = `<p class="me-hint">${pcEsc(t(tn.fromCheckin ? "meNotInDraw" : "meNotInDrawPlain"))}</p>`;
  else body = `<h3 class="me-h">${pcEsc(t("cardNext"))}</h3>${meNextHtml(d)}${mePathHtml(d)}`;
  return `<section class="me-card">
    <div class="me-who"><div><div class="me-who-name"><bdi>${pcEsc(p.name)}</bdi></div>${p.teamName ? `<div class="me-who-team">${pcEsc(p.teamName)}</div>` : ""}</div><div class="me-no-badge">#${pcEsc(p.eventNo)}</div></div>
    <div class="me-status">${pills.join("")}</div>${body}</section>`;
}
function meShowForm(show) { meEl("me-form").hidden = !show; meEl("me-change").hidden = show; }
const meStateKey = { off: "meOff", not_started: "meNotStarted", ended: "meEnded", no_such_number: "meNoSuchNumber", no_event: "meNoEvent", blocked: "meBlocked", bad_request: "meBadNumber" };
async function meFetch(no) {
  const res = await fetch(`/api/public/me?event=${meEventId}&no=${encodeURIComponent(no || "")}`, { cache: "no-store" });
  let body = null; try { body = await res.json(); } catch (e) { /* not json */ }
  return { status: res.status, body: body || {} };
}
function meStateMessage(b) {
  const key = meStateKey[b.state];
  return key ? meT(key, { date: b.event && b.event.date ? meDate(b.event.date) : "" }) : t("meLoadFail");
}
async function meLookup(no, quiet) {
  try {
    const { status, body } = await meFetch(no);
    if (body.event) meEl("me-event").textContent = meEventName(body.event);
    if (status === 200 && body.state === "ok") {
      meData = body; meNo = no; meStoreSet(no);
      meEl("me-result").innerHTML = meHtml(body);
      meSay("");
      meShowForm(false);
      meEl("me-updated").textContent = meT("meUpdated", { time: body.now.time });
      if (!meTimer) meTimer = setInterval(() => meLookup(meNo, true), 20000);
      return;
    }
    if (quiet && status === 200) return;
    meEl("me-result").innerHTML = "";
    meSay(meStateMessage(body), false);
    if (body.state === "no_such_number") { meStoreSet(""); meShowForm(true); }
    if (["off", "not_started", "ended", "no_event"].includes(body.state)) meEl("me-form").hidden = true;
  } catch (e) {
    if (!quiet) meSay(t("meLoadFail"), false);
  }
}
meEl("me-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const no = meEl("me-no").value.replace(/\D/g, "");
  if (!no) { meSay(t("meBadNumber"), false); return; }
  meLookup(no, false);
});
meEl("me-change").addEventListener("click", () => {
  clearInterval(meTimer); meTimer = null; meData = null; meNo = ""; meStoreSet("");
  meEl("me-result").innerHTML = ""; meEl("me-updated").textContent = "";
  meShowForm(true); meEl("me-no").value = ""; meEl("me-no").focus();
});
(async function start() {
  if (!meEventId) { meSay(t("meNoEvent"), false); meEl("me-form").hidden = true; return; }
  const first = await meFetch("").catch(() => null);
  if (!first) { meSay(t("meLoadFail"), false); return; }
  if (first.body.event) meEl("me-event").textContent = meEventName(first.body.event);
  if (first.body.state !== "ready") { meSay(meStateMessage(first.body), true); meEl("me-form").hidden = true; return; }
  const want = (meParams.get("no") || "").replace(/\D/g, "") || meStoreGet();
  if (want) { meEl("me-no").value = want; await meLookup(want, false); } else meEl("me-no").focus();
})();
