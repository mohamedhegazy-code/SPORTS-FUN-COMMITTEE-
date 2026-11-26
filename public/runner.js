"use strict";
// Match runner: the phone-first "Matches & Scores" screen for knockout, group-stage and league
// tournaments (real or simulated). Three views - To play (now / up next / later), Played, and
// Bracket & tables - big touch targets, one-tap winner + confirm, +/- score steppers, court and
// player filters, and a progress bar. Results are saved through the same endpoints as before
// (group-result / knockout-result), via tournBase() so it also works inside a simulation.
const RN = { owner: null, view: "play", court: null, query: "", open: null, edit: null, drafts: {}, limitLater: 10, limitPlayed: 15, wide: false };

function rnReset() {
  Object.assign(RN, { view: "play", court: null, query: "", open: null, edit: null, drafts: {}, limitLater: 10, limitPlayed: 15, wide: false });
}
function rnKey(m) { return m.kind === "ko" ? "k" + m.ri + "_" + m.id : "g" + m.id; }
function rnMin(time) {
  if (!time) return null;
  const [h, mm] = String(time).split(":").map(Number);
  return h * 60 + mm;
}
function rnStageLabel(tn, ri, m) {
  if (m.place) return t(m.place === 3 ? "matchThirdTitle" : "matchFinalTitle");
  const rounds = tn.knockout.rounds;
  if (tn.finalsMode === "table") return t("roundFinals");
  if (ri === rounds.length - 1) return t("roundFinal");
  if (ri === rounds.length - 2) return t("roundSemifinal");
  return t("roundLabel") + " " + (ri + 1);
}
// One flat list of every real match (groups first, then knockout rounds).
function rnAllMatches() {
  const tn = TOURNAMENT_DATA;
  const out = [];
  if (tn.groups) {
    tn.groups.forEach((g, gi) => g.matches.forEach((m) => out.push({
      kind: "gr", id: m.id, a: m.a, b: m.b, aLabel: m.aLabel, bLabel: m.bLabel, time: m.time, court: m.court, date: m.date, round: m.round,
      stage: t("groupLabel") + " " + String.fromCharCode(65 + gi), decided: !!m.result, scoreA: m.result ? m.result.scoreA : null, scoreB: m.result ? m.result.scoreB : null,
      winnerId: m.result ? m.result.winnerId : null, bye: false, ready: true, order: out.length,
    })));
  }
  if (tn.knockout) {
    tn.knockout.rounds.forEach((round, ri) => round.forEach((m) => out.push({
      kind: "ko", ri, id: m.id, a: m.a, b: m.b, aLabel: m.aLabel || t("tbd"), bLabel: m.bLabel || t("tbd"), time: m.time, court: m.court, date: m.date, place: m.place,
      stage: rnStageLabel(tn, ri, m), decided: !!m.winnerId, scoreA: m.scoreA, scoreB: m.scoreB, winnerId: m.winnerId, note: m.note || "", bye: !!m.bye, ready: !!(m.a && m.b), order: out.length,
    })));
  }
  return out;
}
function rnSortKey(m) {
  const tm = rnMin(m.time);
  return [tm === null ? 1e6 : tm, m.court || 99, m.order];
}
function rnCompare(x, y) {
  const a = rnSortKey(x), b = rnSortKey(y);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
function rnMatchFilter(m) {
  if (RN.court && m.court !== RN.court) return false;
  const q = RN.query.trim().toLowerCase();
  if (q && !(String(m.aLabel).toLowerCase().includes(q) || String(m.bLabel).toLowerCase().includes(q))) return false;
  return true;
}
function rnWhen(m) {
  if (m.court && m.time) return `${t("courtLabel")} ${m.court} · ${m.time}`;
  return "";
}

// ---- draft (what the person has typed/tapped but not saved) ------------------------------------
function rnDraft(m) {
  const key = rnKey(m);
  if (!RN.drafts[key]) {
    if (m.decided) RN.drafts[key] = m.kind === "gr" ? { a: m.scoreA, b: m.scoreB, touched: true } : { a: m.scoreA, b: m.scoreB, winner: m.winnerId, note: m.note || "", scoring: m.scoreA != null && m.scoreB != null };
    else RN.drafts[key] = m.kind === "gr" ? { a: 0, b: 0, touched: false } : { a: null, b: null, winner: null, note: "", scoring: false };
  }
  return RN.drafts[key];
}
function rnKoWinner(m, d) {
  if (d.scoring && d.a != null && d.b != null && d.a !== d.b) return d.a > d.b ? m.a : m.b;
  return d.winner || null;
}

// ---- rendering ----------------------------------------------------------------------------------
function rnStepper(side, value) {
  return `<div class="rn-step"><button type="button" data-rn-act="dec" data-rn-side="${side}" aria-label="${escapeAttr(t("rnMinus"))}">&minus;</button><output>${value == null ? 0 : value}</output><button type="button" data-rn-act="inc" data-rn-side="${side}" aria-label="${escapeAttr(t("rnPlus"))}">+</button></div>`;
}
function rnTag(cls) {
  if (!cls) return null;
  return { cls, text: cls === "now" ? t("rnNow") : cls === "next" ? t("rnUpNext") : t("rnEditing") };
}
function rnCardHtml(m, tag) {
  const tn = TOURNAMENT_DATA;
  const d = rnDraft(m);
  const entrants = tn.entrants;
  const nm = (side) => escapeAttr(side === "a" ? m.aLabel : m.bLabel) + teamRosterHtml(entrants, side === "a" ? m.a : m.b, "tourn-team-roster rn-roster");
  const head = `<div class="rn-card-head"><span class="rn-stage">${escapeAttr(m.stage)}</span>${rnWhen(m) ? `<span class="rn-when">${escapeAttr(rnWhen(m))}</span>` : ""}${tag ? `<span class="rn-tag ${tag.cls}">${escapeAttr(tag.text)}</span>` : ""}</div>`;
  let body;
  if (m.kind === "gr") {
    body = `
      <div class="rn-row"><div class="rn-name">${nm("a")}</div>${rnStepper("a", d.a)}</div>
      <div class="rn-row"><div class="rn-name">${nm("b")}</div>${rnStepper("b", d.b)}</div>
      <div class="rn-quick">
        <button type="button" data-rn-act="quick" data-rn-q="a">${escapeAttr(t("rnQuickWin").replace("{name}", m.aLabel))}</button>
        <button type="button" data-rn-act="quick" data-rn-q="d">${escapeAttr(t("rnDraw"))}</button>
        <button type="button" data-rn-act="quick" data-rn-q="b">${escapeAttr(t("rnQuickWin").replace("{name}", m.bLabel))}</button>
      </div>
      <div class="rn-actions">
        ${m.decided ? `<button type="button" class="secondary" data-rn-act="cancel">${escapeAttr(t("rnCancel"))}</button>` : ""}
        <button type="button" class="rn-go" data-rn-act="save-group" ${d.touched ? "" : "disabled"}>${escapeAttr(t("rnSaveResult"))}</button>
      </div>`;
  } else {
    const w = rnKoWinner(m, d);
    const tie = d.scoring && d.a != null && d.b != null && d.a === d.b;
    const side = (s) => {
      const id = s === "a" ? m.a : m.b;
      return `<div class="rn-row"><button type="button" class="rn-pick${w === id ? " picked" : ""}" data-rn-act="pick" data-rn-side="${s}"><span class="rn-name">${nm(s)}</span>${w === id ? '<span class="rn-tick" aria-hidden="true">&#10003;</span>' : ""}</button>${d.scoring ? rnStepper(s, d[s]) : ""}</div>`;
    };
    body = `
      ${w ? "" : `<p class="rn-hint">${escapeAttr(tie ? t("rnTie") : t("rnTapWinner"))}</p>`}
      ${side("a")}${side("b")}
      ${tie && !w ? `<p class="rn-hint">${escapeAttr(t("rnTie"))}</p>` : ""}
      ${d.scoring ? `<input type="text" class="rn-note" maxlength="60" placeholder="${escapeAttr(t("rnNoteLabel"))}" value="${escapeAttr(d.note || "")}" />` : ""}
      <div class="rn-actions">
        ${m.decided ? `<button type="button" class="secondary" data-rn-act="cancel">${escapeAttr(t("rnCancel"))}</button>` : ""}
        <button type="button" class="secondary" data-rn-act="toggle-score">${escapeAttr(d.scoring ? t("rnHideScore") : t("rnAddScore"))}</button>
        <button type="button" class="rn-go" data-rn-act="save-ko" ${w ? "" : "disabled"}>${escapeAttr(w ? t("rnConfirmWinner").replace("{name}", w === m.a ? m.aLabel : m.bLabel) : t("rnConfirm"))}</button>
      </div>`;
  }
  return `<div class="rn-card${tag && tag.cls === "now" ? " is-now" : ""}" data-rn-key="${rnKey(m)}" data-rn-tag="${tag ? tag.cls : ""}">${head}${body}</div>`;
}
function rnPlayedRowHtml(m) {
  if (RN.edit === rnKey(m)) return rnCardHtml(m, { text: t("rnEditing"), cls: "edit" });
  const aWon = m.winnerId && m.winnerId === m.a, bWon = m.winnerId && m.winnerId === m.b;
  const score = m.scoreA != null && m.scoreB != null ? `${m.scoreA} - ${m.scoreB}` : "&check;";
  return `<div class="rn-played" data-rn-key="${rnKey(m)}">
    <div class="rn-played-main">
      <span class="rn-played-stage">${escapeAttr(m.stage)}${rnWhen(m) ? " · " + escapeAttr(rnWhen(m)) : ""}</span>
      <span class="rn-played-names"><b class="${aWon ? "won" : ""}">${escapeAttr(m.aLabel)}</b> <i>${score}</i> <b class="${bWon ? "won" : ""}">${escapeAttr(m.bLabel)}</b>${m.decided && !m.winnerId ? ` <em>${escapeAttr(t("matchDraw"))}</em>` : ""}${m.note ? ` <em>${escapeAttr(m.note)}</em>` : ""}</span>
    </div>
    <button type="button" class="secondary small" data-rn-act="edit">${escapeAttr(t("rnEdit"))}</button>
  </div>`;
}
function rnOverviewHtml() {
  const tn = TOURNAMENT_DATA;
  let html = "";
  if (tn.groups) {
    html += `<h4 class="rn-h">${escapeAttr(t("rnTablesTitle"))}</h4><div class="rn-tables">` + tn.groups.map((g, gi) => `
      <div class="tourn-group"><h4>${escapeAttr(t("groupLabel"))} ${String.fromCharCode(65 + gi)}</h4>
      <div class="tourn-table-scroll"><table><thead><tr><th>#</th><th>${t("colName")}</th><th>${t("colPlayed")}</th><th>${t("colWins")}</th><th>${t("colDraws")}</th><th>${t("colLosses")}</th><th>${t("colGD")}</th><th>${t("colPoints")}</th></tr></thead><tbody>${g.standings.map((s, i) => `<tr><td>${i + 1}</td><td>${escapeAttr(s.label)}</td><td>${s.played}</td><td>${s.wins}</td><td>${s.draws}</td><td>${s.losses}</td><td>${s.gd}</td><td><strong>${s.points}</strong></td></tr>`).join("")}</tbody></table></div></div>`).join("") + `</div>${tn.h2hTiebreak ? `<p class="hint-note">${t("tournTiebreakNote")}</p>` : ""}`;
  }
  if (tn.knockout) {
    html += `<h4 class="rn-h">${escapeAttr(t("rnRoundsTitle"))}</h4>`;
    tn.knockout.rounds.forEach((round, ri) => {
      const byes = round.filter((m) => m.bye).length;
      const rows = round.filter((m) => !m.bye).map((m) => {
        const aWon = m.winnerId && m.winnerId === m.a, bWon = m.winnerId && m.winnerId === m.b;
        const score = m.scoreA != null && m.scoreB != null ? `${m.scoreA} - ${m.scoreB}` : m.winnerId ? "&check;" : "vs";
        return `<div class="rn-ov-row${m.winnerId ? " done" : ""}"><span class="rn-ov-time">${escapeAttr(m.time || "")}</span><b class="${aWon ? "won" : ""}">${escapeAttr(m.aLabel || t("tbd"))}</b><i>${score}</i><b class="${bWon ? "won" : ""}">${escapeAttr(m.bLabel || t("tbd"))}</b></div>`;
      }).join("");
      html += `<div class="rn-ov-round"><div class="rn-ov-title">${escapeAttr(rnStageLabel(tn, ri, round[0] || {}))}${byes ? ` <small>${escapeAttr(t("rnByes").replace("{n}", byes))}</small>` : ""}</div>${rows}</div>`;
    });
    html += `<details class="rn-wide"><summary>${escapeAttr(t("rnWideBracket"))}</summary>${renderTournamentBracket()}</details>`;
  }
  return html;
}
function rnListHtml() {
  const tn = TOURNAMENT_DATA;
  const all = rnAllMatches();
  if (RN.view === "bracket") return rnOverviewHtml();
  if (RN.view === "played") {
    const done = all.filter((m) => m.decided && !m.bye && rnMatchFilter(m)).reverse();
    if (!done.length) return `<p class="hint-note">${escapeAttr(t("rnPlayedEmpty"))}</p>`;
    const shown = done.slice(0, RN.limitPlayed);
    return shown.map(rnPlayedRowHtml).join("") + (done.length > shown.length ? `<button type="button" class="secondary rn-more" data-rn-act="more-played">${escapeAttr(t("rnShowMore").replace("{n}", done.length - shown.length))}</button>` : "");
  }
  const playable = all.filter((m) => !m.decided && !m.bye && m.ready && rnMatchFilter(m)).sort(rnCompare);
  const waiting = all.filter((m) => !m.decided && !m.bye && !m.ready).length;
  const n = Math.max(1, (tn.schedule && tn.schedule.courts) || 1);
  let html = "";
  if (!playable.length) {
    const groupsDone = tn.groups && !tn.knockout && !all.some((m) => !m.decided);
    html += groupsDone ? "" : `<p class="hint-note">${escapeAttr(waiting && !RN.court && !RN.query ? t("rnNothingNow") : RN.court || RN.query ? t("rnNoMatchFilter") : t("rnAllDone"))}</p>`;
  }
  const sections = [
    { title: t("rnNow"), items: playable.slice(0, n), cls: "now" },
    { title: t("rnUpNext"), items: playable.slice(n, n * 2), cls: "next" },
    { title: t("rnLater"), items: playable.slice(n * 2, n * 2 + RN.limitLater), cls: "later" },
  ];
  for (const s of sections) {
    if (!s.items.length) continue;
    html += `<h4 class="rn-h">${escapeAttr(s.title)}</h4>` + s.items.map((m) => rnCardHtml(m, s.cls === "later" ? null : { text: s.title, cls: s.cls })).join("");
  }
  const laterTotal = Math.max(0, playable.length - n * 2);
  if (laterTotal > RN.limitLater) html += `<button type="button" class="secondary rn-more" data-rn-act="more-later">${escapeAttr(t("rnShowMore").replace("{n}", laterTotal - RN.limitLater))}</button>`;
  if (waiting) html += `<p class="hint-note rn-waiting">${escapeAttr(t("rnWaiting").replace("{n}", waiting))}</p>`;
  return html;
}
function rnHeaderHtml() {
  const tn = TOURNAMENT_DATA;
  const all = rnAllMatches().filter((m) => !m.bye);
  const done = all.filter((m) => m.decided).length;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;
  const fin = tn.schedule && tn.schedule.estimatedFinishTime;
  const groupsDone = tn.groups && !tn.knockout && tn.groups.every((g) => g.matches.every((m) => m.result));
  const champion = tn.status === "completed" && tn.standings && tn.standings[0] ? tn.standings[0].label : "";
  let banner = "";
  if (champion) banner = `<div class="rn-banner champ"><span>${escapeAttr(t("rnChampion"))}</span><strong>${escapeAttr(champion)}</strong></div>`;
  else if (groupsDone) banner = `<div class="rn-banner"><span>${escapeAttr(t("rnGroupDone"))}</span><button type="button" class="rn-go" data-tourn-action="generate-knockout">${escapeAttr(t(tn.finalsMode === "table" ? "btnGenerateFinals" : "btnGenerateKnockout"))}</button></div>`;
  const courts = tn.schedule && tn.schedule.courts > 1 ? tn.schedule.courts : 0;
  const chips = courts ? `<div class="rn-chips" role="group"><button type="button" class="rn-chip${RN.court ? "" : " on"}" data-rn-act="court" data-rn-court="0">${escapeAttr(t("rnAllCourts"))}</button>${Array.from({ length: courts }, (_, i) => `<button type="button" class="rn-chip${RN.court === i + 1 ? " on" : ""}" data-rn-act="court" data-rn-court="${i + 1}">${escapeAttr(t("courtLabel"))} ${i + 1}</button>`).join("")}</div>` : "";
  const tabs = [["play", t("rnTabPlay")], ["played", `${t("rnTabPlayed")} (${done})`], ["bracket", t("rnTabOverview")]];
  return `${banner}
    <div class="rn-progress"><div class="rn-bar"><span style="width:${pct}%"></span></div><div class="rn-progress-text"><strong>${escapeAttr(t("rnProgress").replace("{done}", done).replace("{total}", all.length))}</strong>${fin ? `<span>${escapeAttr(t("rnExpectedFinish").replace("{time}", fin))}</span>` : ""}</div></div>
    <div class="rn-tabs" role="tablist">${tabs.map(([k, label]) => `<button type="button" role="tab" class="rn-tab${RN.view === k ? " on" : ""}" data-rn-act="tab" data-rn-view="${k}">${escapeAttr(label)}</button>`).join("")}</div>
    ${RN.view !== "bracket" ? `<div class="rn-filters">${chips}<input id="rn-search" type="search" class="rn-search" placeholder="${escapeAttr(t("rnSearchPh"))}" value="${escapeAttr(RN.query)}" autocomplete="off" /></div>` : ""}`;
}
function renderMatchRunner() {
  const owner = tournBase();
  if (RN.owner !== owner) { rnReset(); RN.owner = owner; }
  return `<div class="rn" id="rn-root"><div id="rn-head">${rnHeaderHtml()}</div><div id="rn-list">${rnListHtml()}</div></div>`;
}
function rnRefresh(headToo) {
  const list = document.getElementById("rn-list");
  if (!list) return;
  if (headToo) document.getElementById("rn-head").innerHTML = rnHeaderHtml();
  list.innerHTML = rnListHtml();
}
function rnToast(text, isErr) {
  let el = document.getElementById("rn-toast");
  if (!el) { el = document.createElement("div"); el.id = "rn-toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = text;
  el.className = "rn-toast show" + (isErr ? " err" : "");
  clearTimeout(rnToast.timer);
  rnToast.timer = setTimeout(() => el.classList.remove("show"), isErr ? 5000 : 2600);
}

// ---- saving ----------------------------------------------------------------------------------------
async function rnApply(path, body, doneText) {
  try {
    const data = await api(tournBase() + path, { method: "PUT", body: JSON.stringify(body) });
    TOURNAMENT_DATA = data.tournament;
    RN.open = null; RN.edit = null;
    const y = window.scrollY;
    renderTournamentBody();
    window.scrollTo(0, y);
    rnToast(doneText, false);
  } catch (e) {
    rnToast(e.message, true);
  }
}
function rnSave(m) {
  const d = rnDraft(m);
  delete RN.drafts[rnKey(m)];
  if (m.kind === "gr") {
    return rnApply("/group-result", { matchId: m.id, scoreA: d.a, scoreB: d.b }, t("rnSaved").replace("{text}", `${m.aLabel} ${d.a} - ${d.b} ${m.bLabel}`));
  }
  const w = rnKoWinner(m, d);
  const scored = d.scoring && d.a != null && d.b != null;
  return rnApply("/knockout-result", { roundIndex: m.ri, matchId: m.id, winnerId: w, scoreA: scored ? d.a : null, scoreB: scored ? d.b : null, note: scored ? (d.note || "") : "" },
    t("rnSaved").replace("{text}", t("rnWinnerSaved").replace("{name}", w === m.a ? m.aLabel : m.bLabel)));
}

// ---- events (delegated once on the static #tourn-body) ----------------------------------------------
document.getElementById("tourn-body").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-rn-act]");
  if (!btn || !document.getElementById("rn-root")) return;
  const act = btn.dataset.rnAct;
  const card = btn.closest("[data-rn-key]");
  const m = card ? rnAllMatches().find((x) => rnKey(x) === card.dataset.rnKey) : null;
  const side = btn.dataset.rnSide;
  if (act === "tab") { RN.view = btn.dataset.rnView; return rnRefresh(true); }
  if (act === "court") { RN.court = Number(btn.dataset.rnCourt) || null; return rnRefresh(true); }
  if (act === "more-later") { RN.limitLater += 15; return rnRefresh(); }
  if (act === "more-played") { RN.limitPlayed += 20; return rnRefresh(); }
  if (!m) return;
  const d = rnDraft(m);
  const redraw = () => { card.outerHTML = rnCardHtml(m, rnTag(card.dataset.rnTag)); };
  if (act === "edit") { RN.edit = rnKey(m); delete RN.drafts[rnKey(m)]; return rnRefresh(); }
  if (act === "cancel") { RN.edit = null; delete RN.drafts[rnKey(m)]; return rnRefresh(); }
  if (act === "pick") {
    const id = side === "a" ? m.a : m.b;
    if (d.scoring && d.a != null && d.b != null && d.a !== d.b) return; // the score already decides
    d.winner = d.winner === id ? null : id;
    return redraw();
  }
  if (act === "toggle-score") {
    d.scoring = !d.scoring;
    if (d.scoring && d.a == null) { d.a = 0; d.b = 0; }
    return redraw();
  }
  if (act === "inc" || act === "dec") {
    const delta = act === "inc" ? 1 : -1;
    if (d.a == null) { d.a = 0; d.b = 0; }
    d[side] = Math.max(0, (d[side] || 0) + delta);
    if (m.kind === "gr") d.touched = true;
    else if (d.a !== d.b) d.winner = null;
    return redraw();
  }
  if (act === "quick") {
    const q = btn.dataset.rnQ;
    d.a = q === "a" ? 1 : 0; d.b = q === "b" ? 1 : 0; d.touched = true;
    return redraw();
  }
  if (act === "save-group" || act === "save-ko") return rnSave(m);
});
document.getElementById("tourn-body").addEventListener("input", (e) => {
  if (e.target.id === "rn-search") { RN.query = e.target.value; RN.limitLater = 10; RN.limitPlayed = 15; return rnRefresh(); }
  if (e.target.classList && e.target.classList.contains("rn-note")) {
    const card = e.target.closest("[data-rn-key]");
    const m = card && rnAllMatches().find((x) => rnKey(x) === card.dataset.rnKey);
    if (m) rnDraft(m).note = e.target.value;
  }
});
