"use strict";
// Player-reported scores.
//  * Members: a "My matches" card in the Member Profile. Either player (or any team member) enters the
//    score from their phone, the opponent confirms (or disputes), and the result is recorded.
//  * Managers: a per-tournament switch, a "Needs your attention" list in the match runner, and a panel on
//    the Swiss round screen. A manager can always overwrite a result or dismiss a report.
// Server side lives in /api/me/tournament-matches* and /api/admin/tournaments/:eventId/(player-scores|report-clear).
const PS = { items: [], drafts: {}, disputing: null, busy: false, loaded: false };

function psSideOther(side) { return side === "a" ? "b" : "a"; }
function psKeyOf(it) { return [it.eventId, it.kind, it.matchId, it.roundNumber || 0, it.roundIndex == null ? 0 : it.roundIndex].join("_"); }
function psStageLabel(it) {
  const s = it.stage || {};
  if (s.type === "group") return t("groupLabel") + " " + String.fromCharCode(65 + (s.groupIndex || 0));
  if (s.type === "swiss") return t("roundNo").replace("{n}", s.roundNumber);
  if (s.place) return t(s.place === 3 ? "matchThirdTitle" : "matchFinalTitle");
  if (s.table) return t("roundFinals");
  if (s.roundIndex === s.totalRounds - 1) return t("roundFinal");
  if (s.roundIndex === s.totalRounds - 2) return t("roundSemifinal");
  return t("roundLabel") + " " + ((s.roundIndex || 0) + 1);
}
function psMine(it) { return it.side === "a" ? it.aLabel : it.bLabel; }
function psOpp(it) { return it.side === "a" ? it.bLabel : it.aLabel; }
// A score object ({scoreA, scoreB, winnerId, result}) seen from the member's own side.
function psScoreText(it, sc) {
  if (!sc) return "";
  if (it.kind === "sw") {
    const r = sc.result;
    if (r === "1/2-1/2") return t("matchDraw");
    const aWon = r === "1-0";
    return (it.side === "a") === aWon ? t("psIWon") : t("psILost");
  }
  const me = it.side === "a" ? sc.scoreA : sc.scoreB;
  const opp = it.side === "a" ? sc.scoreB : sc.scoreA;
  let txt = `${me} – ${opp}`;
  if (it.kind === "ko" && sc.scoreA === sc.scoreB && sc.winnerId) {
    const wName = sc.winnerId === it.aId ? it.aLabel : it.bLabel;
    txt += ` (${t("psTieWinner").replace("{name}", wName)})`;
  }
  return txt;
}
function psDraft(it) {
  const k = psKeyOf(it);
  if (!PS.drafts[k]) PS.drafts[k] = { me: 0, opp: 0, winner: null, res: null, touched: false };
  return PS.drafts[k];
}

// ---- member card ------------------------------------------------------------------------------------------
function psStepper(who, value) {
  return `<div class="rn-step"><button type="button" data-ps-act="dec" data-ps-who="${who}" aria-label="${escapeAttr(t("rnMinus"))}">&minus;</button><output>${value}</output><button type="button" data-ps-act="inc" data-ps-who="${who}" aria-label="${escapeAttr(t("rnPlus"))}">+</button></div>`;
}
function psFormHtml(it) {
  const d = psDraft(it);
  if (it.kind === "sw") {
    const b = (res, label) => `<button type="button" class="ps-res${d.res === res ? " picked" : ""}" data-ps-act="res" data-ps-res="${res}">${escapeAttr(label)}</button>`;
    return `<p class="rn-hint">${escapeAttr(t("psPickResult"))}</p>
      <div class="ps-res-row">${b("win", t("psIWon"))}${b("draw", t("matchDraw"))}${b("loss", t("psILost"))}</div>
      <div class="rn-actions"><button type="button" class="rn-go" data-ps-act="send" ${d.res ? "" : "disabled"}>${escapeAttr(t("psSend"))}</button></div>`;
  }
  const tie = it.kind === "ko" && d.touched && d.me === d.opp;
  const pick = (who, label) => `<button type="button" class="ps-res${d.winner === who ? " picked" : ""}" data-ps-act="winner" data-ps-who="${who}">${escapeAttr(label)}</button>`;
  const ready = d.touched && (!tie || d.winner);
  return `
    <div class="rn-row"><div class="rn-name">${escapeAttr(t("psYou"))}<span class="ps-sub">${escapeAttr(psMine(it))}</span></div>${psStepper("me", d.me)}</div>
    <div class="rn-row"><div class="rn-name">${escapeAttr(psOpp(it))}<span class="ps-sub">${escapeAttr(t("psOpponent"))}</span></div>${psStepper("opp", d.opp)}</div>
    ${tie ? `<p class="rn-hint">${escapeAttr(t("psTieWho"))}</p><div class="ps-res-row two">${pick("me", t("psYou"))}${pick("opp", psOpp(it))}</div>` : ""}
    <div class="rn-actions"><button type="button" class="rn-go" data-ps-act="send" ${ready ? "" : "disabled"}>${escapeAttr(t("psSend"))}</button></div>
    <p class="rn-hint">${escapeAttr(t("psSendHint"))}</p>`;
}
function psMatchHtml(it) {
  const key = psKeyOf(it);
  const when = it.court && it.time ? `${t("courtLabel")} ${it.court} · ${it.time}` : it.court ? `${t("courtLabel")} ${it.court}` : "";
  const head = `<div class="rn-card-head"><span class="rn-stage">${escapeAttr(bilingual(it.eventNameEn, it.eventNameAr))} · ${escapeAttr(psStageLabel(it))}</span>${when ? `<span class="rn-when">${escapeAttr(when)}</span>` : ""}</div>`;
  const vs = `<div class="ps-vs"><b>${escapeAttr(psMine(it))}</b><span>${escapeAttr(t("psVs"))}</span><b>${escapeAttr(psOpp(it))}</b></div>`;
  let body = "";
  const rep = it.report;
  if (it.state === "to_report") body = psFormHtml(it);
  else if (it.state === "waiting_opponent") {
    body = `<p class="ps-state wait">${escapeAttr(t("psWaiting").replace("{name}", psOpp(it)))}</p>
      <p class="ps-score">${escapeAttr(psScoreText(it, rep))}</p>
      <div class="rn-actions"><button type="button" class="secondary" data-ps-act="retract">${escapeAttr(t("psTakeBack"))}</button></div>`;
  } else if (it.state === "to_confirm") {
    const disputing = PS.disputing === key;
    body = `<p class="ps-state ask">${escapeAttr(t("psConfirmAsk").replace("{name}", psOpp(it)))}</p>
      <p class="ps-score">${escapeAttr(psScoreText(it, rep))}</p>
      ${disputing
        ? `<textarea class="ps-note" maxlength="200" rows="2" placeholder="${escapeAttr(t("psDisputePh"))}"></textarea>
           <div class="rn-actions"><button type="button" class="secondary" data-ps-act="dispute-cancel">${escapeAttr(t("rnCancel"))}</button><button type="button" class="danger" data-ps-act="dispute-send">${escapeAttr(t("psDisputeSend"))}</button></div>`
        : `<div class="rn-actions"><button type="button" class="secondary" data-ps-act="dispute">${escapeAttr(t("psDispute"))}</button><button type="button" class="rn-go" data-ps-act="confirm">${escapeAttr(t("psConfirm"))}</button></div>`}`;
  } else if (it.state === "disputed") {
    body = `<p class="ps-state bad">${escapeAttr(t("psDisputedMsg"))}</p>
      <p class="ps-score">${escapeAttr(psScoreText(it, rep))}</p>
      ${rep && rep.disputeNote ? `<p class="rn-hint">${escapeAttr(rep.disputeNote)}</p>` : ""}`;
  } else if (it.state === "scheduled") {
    body = `<p class="ps-state sched">${escapeAttr(t(it.time ? "psScheduledAt" : "psScheduled").replace("{time}", it.time || ""))}</p>`;
  } else {
    const res = it.result || {};
    const w = it.kind === "sw" ? (res.result === "1-0" ? it.aLabel : res.result === "0-1" ? it.bLabel : "") : res.winnerId ? (res.winnerId === it.aId ? it.aLabel : it.bLabel) : "";
    const iWon = w && w === psMine(it);
    body = `<p class="ps-state ok">${escapeAttr(t("psFinal"))}</p><p class="ps-score">${escapeAttr(psScoreText(it, it.result))}</p>
      <p class="rn-hint">${w ? `<strong>${escapeAttr(t(iWon ? "psYouWon" : "psWinnerIs").replace("{name}", w))}</strong>` : escapeAttr(t("matchDraw"))}</p>`;
  }
  const link = `<a class="ps-link" href="/matches.html?event=${it.eventId}&lang=${currentLang}" target="_blank" rel="noopener">${escapeAttr(t("psViewTournament"))}</a>`;
  return `<div class="rn-card ps-card ps-${it.state}" data-ps-key="${escapeAttr(key)}">${head}${vs}${body}${link}</div>`;
}
function psRenderMine() {
  const card = document.getElementById("mp-matches-card");
  const list = document.getElementById("mp-matches-list");
  const badge = document.getElementById("mp-match-badge");
  if (!card || !list) return;
  const todo = PS.items.filter((x) => x.state === "to_confirm").length;
  if (badge) { badge.textContent = String(todo); badge.classList.toggle("hidden", !todo); }
  card.classList.toggle("hidden", !PS.items.length);
  const intro = document.getElementById("mp-matches-intro");
  if (intro) intro.textContent = t(PS.items.some((x) => x.scoring) ? "psMyMatchesIntroScoring" : "psMyMatchesIntro");
  if (!PS.items.length) { list.innerHTML = ""; return; }
  list.innerHTML = PS.items.map(psMatchHtml).join("");
}

// ---- EA-style match card at the top of "My matches" (data from the public card endpoint) ----------------------
let PS_HERO = { token: null, data: null, at: 0 };
async function psRenderHero() {
  const el = document.getElementById("mp-matches-hero");
  if (!el) return;
  const it = PS.items.find((x) => x.state !== "done") || PS.items[0];
  if (!it || !it.cardToken || typeof pcMount !== "function") { el.classList.add("hidden"); return; }
  try {
    const res = await fetch("/api/public/card/" + encodeURIComponent(it.cardToken), { cache: "no-store" });
    if (!res.ok) { el.classList.add("hidden"); return; }
    const d = await res.json();
    PS_HERO = { token: it.cardToken, data: d, at: Date.now() };
    el.classList.remove("hidden");
    el.innerHTML = `<div id="mp-hero-card"></div>
      <div class="pc-actions"><button type="button" class="pc-primary" data-ps-hero="share">${escapeAttr(t("cardShare"))}</button><button type="button" data-ps-hero="copy">${escapeAttr(t("cardCopyLink"))}</button></div>
      <div class="pc-msg" id="mp-hero-msg" aria-live="polite"></div>`;
    pcMount(document.getElementById("mp-hero-card"), d);
  } catch (e) { /* keep whatever was shown */ }
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-ps-hero]");
  if (!b || !PS_HERO.data) return;
  const msg = document.getElementById("mp-hero-msg");
  if (b.dataset.psHero === "share") { const r = await pcShare(PS_HERO.data); if (msg) msg.textContent = r === "downloaded" ? t("cardSaved") : ""; }
  else { const url = location.origin + "/card.html?c=" + encodeURIComponent(PS_HERO.token) + "&lang=" + currentLang; const ok = await pcCopy(url); if (msg) msg.textContent = ok ? t("cardLinkCopied") : url; }
});
async function psLoadMyMatches() {
  if (!(CURRENT_SESSION && CURRENT_SESSION.type === "member")) {
    PS.items = []; psRenderMine();
    return;
  }
  try {
    const data = await api("/api/me/tournament-matches");
    PS.items = data.matches || [];
    PS.loaded = true;
    // Forget drafts of matches that moved on.
    const live = new Set(PS.items.filter((x) => x.state === "to_report").map(psKeyOf));
    for (const k of Object.keys(PS.drafts)) if (!live.has(k)) delete PS.drafts[k];
    psRenderMine();
    psRenderHero();
  } catch (e) { /* the card just stays as it was */ }
}
async function psMemberCall(action, it, extra) {
  if (PS.busy) return;
  PS.busy = true;
  try {
    await api("/api/me/tournament-matches/" + action, {
      method: "POST",
      body: JSON.stringify({ eventId: it.eventId, kind: it.kind, matchId: it.matchId, roundIndex: it.roundIndex, roundNumber: it.roundNumber, ...extra }),
    });
    PS.disputing = null;
    delete PS.drafts[psKeyOf(it)];
    rnToast(t({ report: "psToastSent", confirm: "psToastConfirmed", dispute: "psToastDisputed", retract: "psToastRetracted" }[action]), false);
  } catch (e) {
    rnToast(e.message, true);
  } finally {
    PS.busy = false;
    await psLoadMyMatches();
  }
}
function psReportBody(it, d) {
  if (it.kind === "sw") {
    const iWin = d.res === "win";
    const result = d.res === "draw" ? "1/2-1/2" : (it.side === "a") === iWin ? "1-0" : "0-1";
    return { result };
  }
  const scoreA = it.side === "a" ? d.me : d.opp;
  const scoreB = it.side === "a" ? d.opp : d.me;
  const body = { scoreA, scoreB };
  if (it.kind === "ko" && scoreA === scoreB) body.winner = d.winner === "me" ? it.side : psSideOther(it.side);
  return body;
}
(function bindMemberCard() {
  const list = document.getElementById("mp-matches-list");
  if (!list) return;
  list.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-ps-act]");
    const cardEl = btn && btn.closest("[data-ps-key]");
    if (!cardEl) return;
    const it = PS.items.find((x) => psKeyOf(x) === cardEl.dataset.psKey);
    if (!it) return;
    const act = btn.dataset.psAct;
    const d = it.state === "to_report" ? psDraft(it) : null;
    const redraw = () => { cardEl.outerHTML = psMatchHtml(it); };
    if (act === "inc" || act === "dec") {
      const who = btn.dataset.psWho;
      d[who] = Math.max(0, d[who] + (act === "inc" ? 1 : -1));
      d.touched = true;
      if (d.me !== d.opp) d.winner = null;
      return redraw();
    }
    if (act === "winner") { d.winner = btn.dataset.psWho; return redraw(); }
    if (act === "res") { d.res = btn.dataset.psRes; return redraw(); }
    if (act === "send") return psMemberCall("report", it, psReportBody(it, d));
    if (act === "retract") return psMemberCall("retract", it);
    if (act === "confirm") return psMemberCall("confirm", it);
    if (act === "dispute") { PS.disputing = psKeyOf(it); return redraw(); }
    if (act === "dispute-cancel") { PS.disputing = null; return redraw(); }
    if (act === "dispute-send") {
      const note = cardEl.querySelector(".ps-note");
      return psMemberCall("dispute", it, { note: note ? note.value : "" });
    }
  });
})();
// Keep the card fresh while the profile is open (opponent confirmations, manager decisions).
setInterval(() => {
  if (document.hidden || PS.busy) return;
  if (!(CURRENT_SESSION && CURRENT_SESSION.type === "member")) return;
  const card = document.getElementById("mp-matches-card");
  if (!card || card.offsetParent === null) return;
  const ae = document.activeElement;
  if (ae && ae.tagName === "TEXTAREA") return;
  psLoadMyMatches();
}, 25000);

// ---- manager side -----------------------------------------------------------------------------------------
function psManagerSwitchHtml() {
  const tn = typeof TOURNAMENT_DATA !== "undefined" ? TOURNAMENT_DATA : null;
  if (SIM_ID || !tn || tn.format === "casual") return "";
  const on = !!tn.playerScores;
  return `<div class="ps-switch${on ? " on" : ""}">
    <div class="ps-switch-text"><strong>${escapeAttr(t("psSwitchTitle"))}</strong><span>${escapeAttr(t(on ? "psSwitchOnHint" : "psSwitchOffHint"))}</span></div>
    <button type="button" role="switch" aria-checked="${on ? "true" : "false"}" class="ps-toggle" data-ps-mgr="toggle" aria-label="${escapeAttr(t("psSwitchTitle"))}"><span></span></button>
  </div>`;
}
// Short notice for a report on a match (shown inside the runner card).
function psReportNoticeHtml(m) {
  const rep = m.report;
  if (!rep) return "";
  const aWon = m.kind === "ko" ? rep.winnerId === m.a : rep.scoreA > rep.scoreB;
  const txt = `${m.aLabel} ${rep.scoreA} – ${rep.scoreB} ${m.bLabel}${m.kind === "ko" && rep.scoreA === rep.scoreB ? ` (${t("psTieWinner").replace("{name}", aWon ? m.aLabel : m.bLabel)})` : ""}`;
  const dis = rep.status === "disputed";
  return `<div class="ps-notice${dis ? " bad" : ""}">
    <strong>${escapeAttr(t(dis ? "psMgrDisputed" : "psMgrPending").replace("{name}", rep.byName || ""))}</strong>
    <span>${escapeAttr(txt)}</span>
    ${dis && rep.disputeNote ? `<em>${escapeAttr(rep.disputeNote)}</em>` : ""}
    <small>${escapeAttr(t("psMgrHint"))}</small>
    <button type="button" class="secondary small" data-ps-mgr="clear" data-ps-kind="${m.kind}" data-ps-id="${m.id}" data-ps-ri="${m.ri == null ? "" : m.ri}">${escapeAttr(t("psDismiss"))}</button>
  </div>`;
}
// Swiss: reports for the round being looked at, with one-tap "use this result".
function psSwissPanelHtml(round) {
  const tn = TOURNAMENT_DATA;
  if (SIM_ID || !tn || !tn.playerScores || !round) return "";
  const rows = round.pairings.filter((p) => p.b != null && p.result == null && p.report).map((p) => {
    const r = p.report;
    const label = r.result === "1-0" ? `${p.aLabel} 1–0 ${p.bLabel}` : r.result === "0-1" ? `${p.aLabel} 0–1 ${p.bLabel}` : `${p.aLabel} ½–½ ${p.bLabel}`;
    const dis = r.status === "disputed";
    return `<div class="ps-notice${dis ? " bad" : ""}">
      <strong>${escapeAttr(t(dis ? "psMgrDisputed" : "psMgrPending").replace("{name}", r.byName || ""))}</strong>
      <span>${escapeAttr(label)}</span>
      ${dis && r.disputeNote ? `<em>${escapeAttr(r.disputeNote)}</em>` : ""}
      <div class="ps-notice-actions">
        <button type="button" class="primary small" data-tourn-action="swiss-result" data-round="${round.number}" data-pairing="${p.id}" data-result="${escapeAttr(r.result)}">${escapeAttr(t("psUseResult"))}</button>
        <button type="button" class="secondary small" data-ps-mgr="clear" data-ps-kind="sw" data-ps-id="${p.id}" data-ps-round="${round.number}">${escapeAttr(t("psDismiss"))}</button>
      </div>
    </div>`;
  });
  if (!rows.length) return "";
  return `<div class="ps-attn"><h4>${escapeAttr(t("psAttention"))} (${rows.length})</h4>${rows.join("")}</div>`;
}
async function psManagerToggle() {
  const tn = TOURNAMENT_DATA;
  try {
    const data = await api(tournBase() + "/player-scores", { method: "PUT", body: JSON.stringify({ enabled: !tn.playerScores }) });
    TOURNAMENT_DATA = data.tournament;
    const y = window.scrollY;
    renderTournamentBody();
    window.scrollTo(0, y);
    rnToast(t(TOURNAMENT_DATA.playerScores ? "psToastOn" : "psToastOff"), false);
  } catch (e) { rnToast(e.message, true); }
}
async function psManagerClear(btn) {
  const card = btn.closest("[data-rn-key]");
  try {
    const data = await api(tournBase() + "/report-clear", {
      method: "PUT",
      body: JSON.stringify({ kind: btn.dataset.psKind, matchId: Number(btn.dataset.psId), roundIndex: btn.dataset.psRi === "" ? undefined : Number(btn.dataset.psRi), roundNumber: btn.dataset.psRound ? Number(btn.dataset.psRound) : undefined }),
    });
    if (card && typeof RN !== "undefined") delete RN.drafts[card.dataset.rnKey];
    TOURNAMENT_DATA = data.tournament;
    const y = window.scrollY;
    renderTournamentBody();
    window.scrollTo(0, y);
    rnToast(t("psToastCleared"), false);
  } catch (e) { rnToast(e.message, true); }
}
document.getElementById("tourn-body").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-ps-mgr]");
  if (!btn) return;
  if (btn.dataset.psMgr === "toggle") psManagerToggle();
  else if (btn.dataset.psMgr === "clear") psManagerClear(btn);
});
// Light fingerprint of everything a player report can change, so we only redraw when something happened.
function psSignature(tn) {
  const bits = [];
  const mark = (m, done) => bits.push((m.report ? m.report.at + m.report.status : "-") + (done ? "d" : ""));
  if (tn.groups) tn.groups.forEach((g) => g.matches.forEach((m) => mark(m, !!m.result)));
  if (tn.knockout) tn.knockout.rounds.forEach((r) => r.forEach((m) => mark(m, !!m.winnerId)));
  if (tn.swiss) tn.swiss.rounds.forEach((r) => r.pairings.forEach((p) => mark(p, p.result != null)));
  return bits.join("|");
}
// Managers see reports arrive without refreshing the page.
setInterval(async () => {
  try {
    if (document.hidden || SIM_ID || typeof TOURNAMENT_DATA === "undefined" || !TOURNAMENT_DATA || !TOURNAMENT_DATA.playerScores) return;
    const body = document.getElementById("tourn-body");
    if (!body || body.offsetParent === null || !body.querySelector(".ps-switch")) return;
    const ae = document.activeElement;
    if (ae && body.contains(ae) && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return;
    const before = psSignature(TOURNAMENT_DATA);
    const evId = TOURNAMENT_EVENT_ID;
    const data = await api(tournBase(evId));
    if (evId !== TOURNAMENT_EVENT_ID || SIM_ID) return;
    if (psSignature(data.tournament) === before) return;
    TOURNAMENT_DATA = data.tournament;
    const y = window.scrollY;
    renderTournamentBody();
    window.scrollTo(0, y);
  } catch (e) { /* try again next time */ }
}, 20000);
