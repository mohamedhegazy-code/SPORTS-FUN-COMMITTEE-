"use strict";
// EA-style player match card, shared by the public page (/card.html?c=TOKEN) and the Member Profile "My matches" card.
// Data comes from GET /api/public/card/:token (see buildPlayerCard in server.js).
const pcEsc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pcT = (key, vars) => { let s = t(key); for (const k in vars || {}) s = s.split("{" + k + "}").join(vars[k]); return s; };

function pcStageLabel(stage) {
  const s = stage || {};
  if (s.type === "group") return t("groupLabel") + " " + String.fromCharCode(65 + (s.groupIndex || 0));
  if (s.type === "swiss") return pcT("roundNo", { n: s.roundNumber });
  if (s.place) return t(s.place === 3 ? "matchThirdTitle" : "matchFinalTitle");
  if (s.roundIndex === s.totalRounds - 1) return t("roundFinal");
  if (s.roundIndex === s.totalRounds - 2) return t("roundSemifinal");
  if (s.roundIndex === s.totalRounds - 3 && s.totalRounds >= 3) return t("cardQuarter");
  return t("roundLabel") + " " + ((s.roundIndex || 0) + 1);
}
function pcRoundName(i, total) {
  if (i === total - 1) return t("roundFinal");
  if (i === total - 2) return t("roundSemifinal");
  if (i === total - 3 && total >= 3) return t("cardQuarter");
  return t("roundLabel") + " " + (i + 1);
}
function pcInitials(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  const chars = parts.length > 1 ? [parts[0][0], parts[1][0]] : [String(parts[0] || "?").slice(0, 2)];
  return chars.join("").toUpperCase();
}
function pcEventName(d) { const e = d.event; return (currentLang === "ar" ? e.nameAr || e.nameEn : e.nameEn || e.nameAr) || ""; }

// Instant of a Cairo wall-clock time (handles Egypt's daylight-saving offset correctly).
function pcCairoEpoch(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number), [hh, mm] = timeStr.split(":").map(Number);
  if (![y, m, d, hh, mm].every(Number.isFinite)) return null;
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const off = (ms) => { const p = fmt.formatToParts(new Date(ms)); const g = (k) => Number(p.find((x) => x.type === k).value); return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - ms; };
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  return guess - off(guess - off(guess));
}
function pcNextEpoch(d) { return d.next && d.next.time ? pcCairoEpoch(d.next.date || d.event.date, d.next.time) : null; }
function pcCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return (days ? days + (currentLang === "ar" ? " ي " : "d ") : "") + p(h) + ":" + p(m) + ":" + p(sec);
}

function pcPathHtml(d) {
  const j = d.journey, tn = d.tournament;
  const chips = [];
  const chip = (label, state) => `<li class="pc-chip ${state}"><i></i><span>${pcEsc(label)}</span></li>`;
  const next = d.next;
  if (tn.format === "swiss") {
    if (j.swissInfo) return `<p class="pc-line">${pcEsc(pcT("cardSwissRank", { rank: j.swissInfo.rank || "-", pts: j.swissInfo.points, n: j.swissInfo.generated, total: j.swissInfo.totalRounds }))}</p>`;
    return "";
  }
  const koTotal = tn.koRounds || 0;
  const inGroups = !!j.groupInfo;
  const outInGroups = inGroups && koTotal > 0 && !j.inKnockout;
  if (inGroups) {
    const gs = next && next.stage.type === "group";
    const gi = j.groupInfo;
    const groupState = outInGroups ? "lost" : gs ? "now" : "done";
    chips.push(chip(t("cardGroupStage"), groupState));
  }
  if (koTotal > 0) {
    const played = d.played.filter((x) => x.stage.type === "ko").map((x) => x.stage.roundIndex);
    const maxPlayed = played.length ? Math.max(...played) : -1;
    const cur = next && next.stage.type === "ko" ? next.stage.roundIndex : maxPlayed + 1;
    for (let i = 0; i < koTotal; i++) {
      let st = "future";
      if (j.champion) st = "done";
      else if (outInGroups) st = "future";
      else if (j.lostAtRound != null) st = i < j.lostAtRound ? "done" : i === j.lostAtRound ? "lost" : "future";
      else st = i < cur ? "done" : i === cur ? "now" : "future";
      chips.push(chip(pcRoundName(i, koTotal), st));
    }
  } else if (inGroups) {
    chips.push(chip(t("cardKnockout"), "future"), chip(t("roundFinal"), "future"));
  }
  const line = inGroups && d.played.some((x) => x.stage.type === "group") ? `<p class="pc-line">${pcEsc(pcT("cardGroupRank", { rank: j.groupInfo.rank, size: j.groupInfo.size, pts: j.groupInfo.points }))}</p>` : "";
  return chips.length ? `<ul class="pc-chips">${chips.join("")}</ul>${line}` : line;
}

function pcNextHtml(d) {
  const j = d.journey, n = d.next;
  if (!n) {
    let title = t("cardNoNext"), cls = "";
    if (j.champion) { title = "🏆 " + t("rnChampion"); cls = "gold"; }
    else if (j.finished && j.finalPlace) { title = pcT("cardPlace", { place: j.finalPlace }); cls = "gold"; }
    else if (j.lostAtRound != null) title = pcT("cardOutKo", { stage: pcRoundName(j.lostAtRound, d.tournament.koRounds) });
    else if (j.groupInfo && d.tournament.koRounds > 0 && !j.inKnockout) title = t("cardOutGroup");
    return `<section class="pc-next none ${cls}"><div class="pc-nonext">${pcEsc(title)}</div></section>`;
  }
  const hasEpoch = pcNextEpoch(d) != null;
  return `<section class="pc-next">
    <div class="pc-ribbon">${pcEsc(pcStageLabel(n.stage))}</div>
    <div class="pc-vs"><span class="pc-me">${pcEsc(d.player.label)}</span><b>${pcEsc(t("vs"))}</b><span class="pc-opp ${n.opponentKnown ? "" : "tbd"}">${pcEsc(n.opponentKnown ? n.opponent : t("cardTbaOpp"))}</span></div>
    <div class="pc-facts"><div><small>${pcEsc(t("courtLabel"))}</small><strong>${n.court ? pcEsc(n.court) : "—"}</strong></div><div><small>${pcEsc(t("cardTime"))}</small><strong>${n.time ? pcEsc(n.time) : "—"}</strong></div></div>
    <div class="pc-cd" data-pc-cd="${hasEpoch ? "1" : ""}">${hasEpoch ? "" : pcEsc(t("cardTbaTime"))}</div>
  </section>`;
}
function pcResultsHtml(d) {
  if (!d.played.length) return `<p class="pc-line dim">${pcEsc(t("cardNoResults"))}</p>`;
  return `<ul class="pc-res">${d.played.slice(-6).reverse().map((m) => {
    const sc = m.scoreFor != null && m.scoreAgainst != null ? `${m.scoreFor} – ${m.scoreAgainst}` : "";
    const cls = m.won === true ? "w" : m.won === false ? "l" : "d";
    const label = m.won === true ? t("cardWon") : m.won === false ? t("cardLost") : t("cardDraw");
    return `<li class="${cls}"><span class="pc-badge">${pcEsc(label)}</span><span class="pc-oppn">${pcEsc(m.opponent)}<small>${pcEsc(pcStageLabel(m.stage))}</small></span><b>${pcEsc(sc)}</b></li>`;
  }).join("")}</ul>`;
}
function pcHtml(d) {
  const fmtKey = { knockout: "cardFmtKnockout", groups: "cardFmtGroups", swiss: "cardFmtSwiss", league: "cardFmtLeague" }[d.tournament.format];
  return `<article class="pc ${d.journey.champion ? "is-champ" : ""}">
    <header class="pc-top"><span class="pc-brand">MyAhlawy</span><span class="pc-ev">${pcEsc(pcEventName(d))}</span></header>
    <div class="pc-hero"><div class="pc-avatar"><span>${pcEsc(pcInitials(d.player.label))}</span></div>
      <div class="pc-name" role="heading" aria-level="3">${pcEsc(d.player.label)}</div>
      <p class="pc-sub">${pcEsc([d.event.sport, fmtKey ? t(fmtKey) : ""].filter(Boolean).join(" · "))}${d.player.players ? `<br>${pcEsc(d.player.players.join(" · "))}` : ""}</p></div>
    <h3 class="pc-h">${pcEsc(t("cardNext"))}</h3>${pcNextHtml(d)}
    <h3 class="pc-h">${pcEsc(t("cardPath"))}</h3>${pcPathHtml(d)}
    <h3 class="pc-h">${pcEsc(t("cardResults"))}</h3>${pcResultsHtml(d)}
  </article>`;
}

// One shared 1-second ticker for every countdown on the page.
let PC_DATA = null, PC_TIMER = null;
function pcTick() {
  document.querySelectorAll("[data-pc-cd='1']").forEach((el) => {
    const at = PC_DATA ? pcNextEpoch(PC_DATA) : null;
    if (at == null) return;
    const ms = at - Date.now();
    if (ms > 0) { el.className = "pc-cd"; el.innerHTML = `<small>${pcEsc(t("cardStartsIn"))}</small><b>${pcCountdown(ms)}</b>`; }
    else { el.className = "pc-cd now"; el.textContent = t("cardItsTime"); }
  });
}
function pcMount(el, d) {
  PC_DATA = d;
  el.innerHTML = pcHtml(d);
  pcTick();
  if (!PC_TIMER) PC_TIMER = setInterval(pcTick, 1000);
}

// ---- share as a picture (1080 x 1350) ----------------------------------------------------------------------
function pcFit(ctx, text, maxW, size, weight) {
  let s = size;
  for (; s > 30; s -= 4) { ctx.font = `${weight} ${s}px Cairo, "Segoe UI", Tahoma, Arial, sans-serif`; if (ctx.measureText(text).width <= maxW) break; }
  return s;
}
async function pcShareBlob(d) {
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) { /* fine */ }
  const W = 1080, H = 1350, cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  const cs = getComputedStyle(document.documentElement);
  const red = (cs.getPropertyValue("--red") || "#8B0000").trim(), gold = (cs.getPropertyValue("--gold") || "#C9A227").trim(), dark = (cs.getPropertyValue("--red-dark") || "#4a0000").trim();
  const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, red); g.addColorStop(0.55, dark); g.addColorStop(1, "#0e0709");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = gold; ctx.lineWidth = 10; ctx.strokeRect(36, 36, W - 72, H - 72);
  ctx.lineWidth = 2; ctx.strokeRect(54, 54, W - 108, H - 108);
  ctx.direction = currentLang === "ar" ? "rtl" : "ltr"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const text = (str, y, size, color, weight, maxW) => { const s = pcFit(ctx, str, maxW || 900, size, weight || 800); ctx.font = `${weight || 800} ${s}px Cairo, "Segoe UI", Tahoma, Arial, sans-serif`; ctx.fillStyle = color; ctx.fillText(str, W / 2, y); };
  text("MyAhlawy", 130, 54, gold, 900);
  text(pcEventName(d), 200, 44, "#f6efe6", 600);
  // avatar
  ctx.beginPath(); ctx.arc(W / 2, 340, 96, 0, Math.PI * 2); ctx.fillStyle = gold; ctx.fill();
  text(pcInitials(d.player.label), 340, 84, "#2b2200", 900, 150);
  text(d.player.label, 505, 76, "#ffffff", 900);
  const n = d.next, j = d.journey;
  if (n) {
    ctx.fillStyle = "rgba(255,255,255,.1)"; ctx.fillRect(110, 580, W - 220, 520);
    text(pcStageLabel(n.stage).toUpperCase(), 625, 40, gold, 800);
    text(t("vs"), 700, 44, gold, 900);
    text(n.opponentKnown ? n.opponent : t("cardTbaOpp"), 790, 72, "#ffffff", 800);
    text(t("courtLabel") + "  " + (n.court || "—"), 900, 74, gold, 900);
    text(n.time || t("cardTbaTime"), 1000, 110, "#ffffff", 900);
    const at = pcNextEpoch(d);
    if (at) {
      const when = new Date(at).toLocaleDateString(currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-GB", { timeZone: "Africa/Cairo", weekday: "long", day: "numeric", month: "long" });
      text(when, 1070, 40, "#d8c9bd", 600);
    }
  } else {
    text(j.champion ? "🏆 " + t("rnChampion") : j.finished && j.finalPlace ? pcT("cardPlace", { place: j.finalPlace }) : t("cardNoNext"), 840, 90, gold, 900);
  }
  const rec = d.played.length ? d.played.filter((m) => m.won === true).length + " " + t("cardWon") + " · " + d.played.filter((m) => m.won === false).length + " " + t("cardLost") : "";
  if (rec) text(rec, 1190, 44, "#f6efe6", 700);
  text("myahlawy.com", 1262, 38, gold, 700);
  return new Promise((res) => cv.toBlob(res, "image/png"));
}
async function pcShare(d, msgEl) {
  const blob = await pcShareBlob(d);
  const file = new File([blob], "MyAhlawy-match-card.png", { type: "image/png" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: pcEventName(d) }); return "shared"; }
  } catch (e) { if (e && e.name === "AbortError") return "cancelled"; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  return "downloaded";
}
async function pcCopy(url) {
  try { await navigator.clipboard.writeText(url); return true; } catch (e) {
    const ta = document.createElement("textarea"); ta.value = url; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (x) { /* none */ } ta.remove(); return ok;
  }
}
