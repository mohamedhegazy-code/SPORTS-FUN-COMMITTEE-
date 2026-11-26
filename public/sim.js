"use strict";
// Tournament simulations (practice runs) - Admin, Event Manager and Tournament Manager.
// A simulation is a private copy of an event's players + tournament on the server. While one is
// open (SIM_ID set in app.js) every tournament screen talks to /api/sim/:id/... instead of the real
// tournament, so nothing can leak into real registrations, points or public pages.
// Also: on the event day the Tournament Manager's real tournament loads automatically.
let SIM_LIST = [];
let SIM_WHATIF_ROWS = null;
let SIM_AUTO_LOADED_FOR = null;

function simSelectedEventId() {
  const sel = document.getElementById("tourn-event-select");
  return sel && sel.value ? Number(sel.value) : null;
}
function simEventObj() {
  const id = simSelectedEventId();
  return (typeof EVENTS_DATA !== "undefined" && EVENTS_DATA.find((e) => e.id === id)) || null;
}
function simTodayCairo() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}
function simModeLabel(mode) {
  return mode === "dummy" ? t("simModeDummy") : mode === "both" ? t("simModeBoth") : t("simModeRegistrants");
}
function simStatusLabel(tn) {
  if (!tn) return t("simNoTournamentYet");
  return tournamentActiveStatusLabel({ format: tn.format, status: tn.status });
}

// ---- the list / create card -------------------------------------------------------------
async function simLoadList() {
  const wrap = document.getElementById("sim-list");
  if (!wrap) return;
  const eventId = simSelectedEventId();
  if (!eventId) { wrap.innerHTML = ""; return; }
  try {
    const data = await api("/api/sim?eventId=" + eventId);
    SIM_LIST = data.simulations || [];
    simRenderList();
  } catch (e) {
    wrap.innerHTML = `<p class="msg err show">${escapeAttr(e.message)}</p>`;
  }
}
function simRenderList() {
  const wrap = document.getElementById("sim-list");
  if (!wrap) return;
  if (!SIM_LIST.length) {
    wrap.innerHTML = `<p class="hint-note">${escapeAttr(t("simListEmpty"))}</p>`;
    return;
  }
  wrap.innerHTML = SIM_LIST.map((s) => `
    <div class="sim-row${SIM_ID === s.id ? " active" : ""}" data-sim-id="${s.id}">
      <div class="sim-row-main">
        <strong>${escapeAttr(s.name || t("simDefaultName").replace("{n}", s.id))}</strong>
        <span class="meta">${escapeAttr(simModeLabel(s.mode))} &middot; ${escapeAttr(t("simRowPlayers").replace("{n}", s.playerCount))} &middot; ${escapeAttr(simStatusLabel(s.tournament))}</span>
      </div>
      <div class="sim-row-actions">
        <button class="secondary small" type="button" data-sim-open="${s.id}">${escapeAttr(t("simBtnOpen"))}</button>
        <button class="secondary small" type="button" data-sim-restart="${s.id}">${escapeAttr(t("simBtnRestart"))}</button>
        <button class="danger small" type="button" data-sim-delete="${s.id}">${escapeAttr(t("simBtnDelete"))}</button>
      </div>
    </div>`).join("");
}
function simSyncCreateForm() {
  const mode = document.getElementById("sim-mode").value;
  document.getElementById("sim-players-wrap").classList.toggle("hidden", mode === "registrants");
  const ev = simEventObj();
  const label = document.getElementById("sim-event-name");
  if (label) label.textContent = ev ? eventLabel(ev) + " - " + ev.date : "";
  const players = document.getElementById("sim-players");
  if (players && !players.dataset.touched) players.value = (ev && ev.maxCapacity) || 16;
}
async function simCreate() {
  const msg = document.getElementById("sim-msg");
  const eventId = simSelectedEventId();
  if (!eventId) return showMsg(msg, t("simPickEvent"), false);
  const mode = document.getElementById("sim-mode").value;
  const body = {
    eventId, mode,
    playerCount: document.getElementById("sim-players").value,
    teamSize: document.getElementById("sim-team-size").value,
    name: document.getElementById("sim-name").value.trim(),
    copySetup: document.getElementById("sim-copy").checked,
  };
  try {
    const data = await api("/api/sim", { method: "POST", body: JSON.stringify(body) });
    showMsg(msg, t("simCreated"), true);
    document.getElementById("sim-name").value = "";
    await simLoadList();
    await simOpen(data.simulation.id);
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}
async function simOpen(id) {
  setSimMode(id);
  SIM_WHATIF_ROWS = null;
  await loadTournamentPanel(simSelectedEventId());
  simRenderList();
  simRefreshUi();
  document.getElementById("tourn-manage-card").scrollIntoView({ behavior: "smooth", block: "start" });
}
async function simExit() {
  setSimMode(null);
  SIM_WHATIF_ROWS = null;
  const eventId = simSelectedEventId();
  if (eventId) await loadTournamentPanel(eventId);
  simRenderList();
}

// ---- banner (shown while a simulation is open) ---------------------------------------------
function simRefreshUi() {
  const bar = document.getElementById("sim-banner");
  if (!bar) return;
  if (!SIM_ID) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
  const s = SIM_LIST.find((x) => x.id === SIM_ID);
  const prevOpen = !!document.getElementById("sim-whatif-panel");
  bar.classList.remove("hidden");
  bar.innerHTML = `
    <div class="sim-banner-head">
      <span class="sim-badge">${escapeAttr(t("simBannerBadge"))}</span>
      <strong>${escapeAttr(s && s.name ? s.name : t("simDefaultName").replace("{n}", SIM_ID))}</strong>
      <button class="secondary small" type="button" data-sim-exit style="margin-inline-start:auto;">${escapeAttr(t("simBtnExit"))}</button>
    </div>
    <p class="hint-note">${escapeAttr(t("simBannerText"))}</p>
    <div class="sim-auto">
      <span class="sim-auto-title">${escapeAttr(t("simAutoTitle"))}</span>
      <select id="sim-style" aria-label="${escapeAttr(t("simAutoStyle"))}">
        <option value="random">${escapeAttr(t("simStyleRandom"))}</option>
        <option value="seeded">${escapeAttr(t("simStyleSeeded"))}</option>
      </select>
      <button class="secondary small" type="button" data-sim-auto="draw">${escapeAttr(t("simBtnDrawOnly"))}</button>
      <button class="secondary small" type="button" data-sim-auto="stage">${escapeAttr(t("simBtnStage"))}</button>
      <button class="small" type="button" data-sim-auto="end">${escapeAttr(t("simBtnToEnd"))}</button>
      <button class="secondary small" type="button" data-sim-whatif-toggle>${escapeAttr(t("simBtnWhatIf"))}</button>
    </div>
    <div class="msg" id="sim-auto-msg"></div>
    <div id="sim-whatif" class="${prevOpen ? "" : "hidden"}"></div>`;
  if (prevOpen) simRenderWhatIf();
}
async function simAutoPlay(until) {
  const msg = document.getElementById("sim-auto-msg");
  const style = document.getElementById("sim-style").value;
  try {
    const data = await api("/api/sim/" + SIM_ID + "/autoplay", { method: "POST", body: JSON.stringify({ until, style }) });
    TOURNAMENT_DATA = data.tournament;
    renderTournamentBody();
    showMsg(msg, until === "draw" ? t("simAutoDrawn") : t("simAutoDone").replace("{n}", data.played), true);
    simLoadList();
  } catch (e) {
    showMsg(msg, e.code === "sim_no_tournament" || (e.data && e.data.code === "sim_no_tournament") ? t("simNoTournamentNote") : e.message, false);
  }
}

// ---- what-if comparison ----------------------------------------------------------------------
function simWiBaseDefaults() {
  const tn = TOURNAMENT_DATA;
  const sched = tn && tn.schedule;
  const players = TOURNAMENT_REGISTRATIONS && TOURNAMENT_REGISTRATIONS.length ? TOURNAMENT_REGISTRATIONS.length : (SIM_LIST.find((x) => x.id === SIM_ID) || {}).playerCount || 16;
  const courts = sched ? sched.courts : 2;
  return {
    base: {
      format: tn ? (tn.format === "groups" && tn.finalsMode === "table" ? "league" : tn.format === "casual" ? "knockout" : tn.format) : "knockout",
      mode: tn ? tn.mode : "individual",
      numGroups: tn && tn.numGroups ? tn.numGroups : 2,
      advancePerGroup: tn && tn.advancePerGroup ? tn.advancePerGroup : 2,
      swissRounds: tn && tn.swiss ? tn.swiss.totalRounds : 7,
      teamSize: tn && tn.mode === "team" && tn.teams.length ? Math.round(tn.teams.reduce((a, x) => a + x.memberIds.length, 0) / tn.teams.length) : 3,
    },
    rows: [
      { label: t("simWiCurrent"), players, courts, matchMinutes: sched ? sched.matchMinutes : 20, breakMinutes: sched ? sched.breakMinutes : 0, startTime: sched ? sched.startTime : "10:00" },
      { label: "", players, courts: courts + 1, matchMinutes: sched ? sched.matchMinutes : 20, breakMinutes: sched ? sched.breakMinutes : 0, startTime: sched ? sched.startTime : "10:00" },
    ],
  };
}
function simRenderWhatIf(results) {
  const box = document.getElementById("sim-whatif");
  if (!box) return;
  if (!SIM_WHATIF_ROWS) SIM_WHATIF_ROWS = simWiBaseDefaults();
  const { base, rows } = SIM_WHATIF_ROWS;
  const fmt = (v, label) => `<option value="${v}"${base.format === v ? " selected" : ""}>${escapeAttr(label)}</option>`;
  const hm = (min) => t("simWiHm").replace("{h}", Math.floor(Math.abs(min) / 60)).replace("{m}", Math.abs(min) % 60);
  let best = null;
  if (results) results.forEach((r) => { if (!r.error && (best === null || r.durationMinutes < best)) best = r.durationMinutes; });
  box.classList.remove("hidden");
  box.innerHTML = `
    <div id="sim-whatif-panel" class="sim-whatif">
      <h3>${escapeAttr(t("simWiTitle"))}</h3>
      <p class="hint-note">${escapeAttr(t("simWiIntro"))}</p>
      <div class="sim-wi-base">
        <label>${escapeAttr(t("simWiFormat"))}
          <select id="sim-wi-format">${fmt("knockout", t("tournamentFormatKnockout"))}${fmt("groups", t("tournamentFormatGroups"))}${fmt("league", t("tournamentFormatLeague"))}${fmt("swiss", t("tournamentFormatSwiss"))}</select></label>
        <label>${escapeAttr(t("simWiGroups"))}<input id="sim-wi-groups" type="number" min="1" value="${base.numGroups}" /></label>
        <label>${escapeAttr(t("simWiAdvance"))}<input id="sim-wi-advance" type="number" min="1" value="${base.advancePerGroup}" /></label>
        <label>${escapeAttr(t("simWiRounds"))}<input id="sim-wi-rounds" type="number" min="1" value="${base.swissRounds}" /></label>
        <label>${escapeAttr(t("simWiTeamSize"))}<input id="sim-wi-teamsize" type="number" min="1" value="${base.teamSize}" ${base.mode === "team" ? "" : "disabled"} /></label>
      </div>
      <div class="sim-wi-scroll"><table class="sim-wi-table">
        <thead><tr><th>${escapeAttr(t("simWiScenario"))}</th><th>${escapeAttr(t("simWiPlayers"))}</th><th>${escapeAttr(t("simWiCourts"))}</th><th>${escapeAttr(t("simWiMinutes"))}</th><th>${escapeAttr(t("simWiBreak"))}</th><th>${escapeAttr(t("simWiStart"))}</th><th></th>${results ? `<th>${escapeAttr(t("simWiMatches"))}</th><th>${escapeAttr(t("simWiFinish"))}</th><th>${escapeAttr(t("simWiDuration"))}</th>` : ""}</tr></thead>
        <tbody>${rows.map((r, i) => {
          const res = results && results[i];
          return `<tr data-wi-row="${i}">
            <td><input class="wi-label" type="text" maxlength="40" value="${escapeAttr(r.label)}" placeholder="#${i + 1}" /></td>
            <td><input class="wi-players" type="number" min="2" value="${r.players}" /></td>
            <td><input class="wi-courts" type="number" min="1" value="${r.courts}" /></td>
            <td><input class="wi-minutes" type="number" min="1" value="${r.matchMinutes}" /></td>
            <td><input class="wi-break" type="number" min="0" value="${r.breakMinutes}" /></td>
            <td><input class="wi-start" type="time" value="${escapeAttr(r.startTime)}" /></td>
            <td><button class="secondary small" type="button" data-wi-remove="${i}" aria-label="${escapeAttr(t("simWiRemove"))}">&times;</button></td>
            ${results ? (res && res.error ? `<td colspan="3" class="sim-wi-err">${escapeAttr(res.error)}</td>` : res ? `
              <td>${res.totalMatches}</td>
              <td class="sim-wi-finish${res.durationMinutes === best ? " best" : ""}"><strong>${escapeAttr(res.finishTime)}</strong>${res.nextDay ? ` <small>${escapeAttr(t("simWiNextDay"))}</small>` : ""}${res.fitsAvailableHours === false ? ` <small class="sim-wi-warn">${escapeAttr(t("simWiTooLong"))}</small>` : ""}</td>
              <td>${escapeAttr(hm(res.durationMinutes))}</td>` : "<td></td><td></td><td></td>") : ""}
          </tr>`;
        }).join("")}</tbody>
      </table></div>
      <div class="sim-wi-actions">
        <button class="secondary small" type="button" data-wi-add>${escapeAttr(t("simWiAdd"))}</button>
        <button class="small" type="button" data-wi-run>${escapeAttr(t("simWiRun"))}</button>
      </div>
      <div class="msg" id="sim-wi-msg"></div>
    </div>`;
}
function simWiReadForm() {
  const g = (id) => document.getElementById(id);
  const fmtSel = g("sim-wi-format").value;
  const base = {
    format: fmtSel === "league" ? "groups" : fmtSel,
    finalsMode: fmtSel === "league" ? "table" : null,
    numGroups: Number(g("sim-wi-groups").value),
    advancePerGroup: Number(g("sim-wi-advance").value),
    swissRounds: Number(g("sim-wi-rounds").value),
    teamSize: Number(g("sim-wi-teamsize").value) || 1,
    mode: SIM_WHATIF_ROWS.base.mode,
  };
  SIM_WHATIF_ROWS.base = { ...SIM_WHATIF_ROWS.base, format: fmtSel, numGroups: base.numGroups, advancePerGroup: base.advancePerGroup, swissRounds: base.swissRounds, teamSize: base.teamSize };
  const rows = Array.from(document.querySelectorAll("#sim-whatif tr[data-wi-row]")).map((tr) => ({
    label: tr.querySelector(".wi-label").value.trim(),
    players: Number(tr.querySelector(".wi-players").value),
    courts: Number(tr.querySelector(".wi-courts").value),
    matchMinutes: Number(tr.querySelector(".wi-minutes").value),
    breakMinutes: Number(tr.querySelector(".wi-break").value || 0),
    startTime: tr.querySelector(".wi-start").value,
  }));
  SIM_WHATIF_ROWS.rows = rows;
  return { base, rows };
}
async function simWiRun() {
  const msg = document.getElementById("sim-wi-msg");
  const { base, rows } = simWiReadForm();
  try {
    const data = await api("/api/sim/" + SIM_ID + "/whatif", { method: "POST", body: JSON.stringify({ base, scenarios: rows }) });
    simRenderWhatIf(data.results);
  } catch (e) {
    showMsg(msg, e.message, false);
  }
}

// ---- wiring ------------------------------------------------------------------------------------
document.getElementById("sim-create-btn").addEventListener("click", simCreate);
document.getElementById("sim-mode").addEventListener("change", simSyncCreateForm);
document.getElementById("sim-players").addEventListener("input", (e) => { e.target.dataset.touched = "1"; });
document.getElementById("tourn-event-select").addEventListener("change", () => {
  if (SIM_ID) setSimMode(null);
  const players = document.getElementById("sim-players");
  if (players) delete players.dataset.touched;
  simSyncCreateForm();
  simLoadList();
});
document.getElementById("sim-card").addEventListener("click", async (e) => {
  const open = e.target.closest("[data-sim-open]");
  const restart = e.target.closest("[data-sim-restart]");
  const del = e.target.closest("[data-sim-delete]");
  const msg = document.getElementById("sim-msg");
  try {
    if (open) await simOpen(Number(open.dataset.simOpen));
    else if (restart) {
      if (!confirm(t("simConfirmRestart"))) return;
      await api("/api/sim/" + restart.dataset.simRestart + "/restart", { method: "POST", body: "{}" });
      showMsg(msg, t("simRestarted"), true);
      await simLoadList();
      if (SIM_ID === Number(restart.dataset.simRestart)) await simOpen(SIM_ID);
    } else if (del) {
      if (!confirm(t("simConfirmDelete"))) return;
      const id = Number(del.dataset.simDelete);
      await api("/api/sim/" + id, { method: "DELETE" });
      showMsg(msg, t("simDeleted"), true);
      if (SIM_ID === id) { setSimMode(null); document.getElementById("tourn-body").innerHTML = ""; TOURNAMENT_DATA = null; }
      await simLoadList();
    }
  } catch (err) {
    showMsg(msg, err.message, false);
  }
});
document.getElementById("sim-banner").addEventListener("click", (e) => {
  if (e.target.closest("[data-sim-exit]")) return simExit();
  const auto = e.target.closest("[data-sim-auto]");
  if (auto) return simAutoPlay(auto.dataset.simAuto);
  if (e.target.closest("[data-sim-whatif-toggle]")) {
    const box = document.getElementById("sim-whatif");
    if (box.classList.contains("hidden")) simRenderWhatIf(); else { box.classList.add("hidden"); box.innerHTML = ""; }
    return;
  }
  if (e.target.closest("[data-wi-add]")) {
    const { rows } = simWiReadForm();
    rows.push({ ...rows[rows.length - 1], label: "" });
    return simRenderWhatIf();
  }
  const rm = e.target.closest("[data-wi-remove]");
  if (rm) {
    const { rows } = simWiReadForm();
    if (rows.length > 1) rows.splice(Number(rm.dataset.wiRemove), 1);
    return simRenderWhatIf();
  }
  if (e.target.closest("[data-wi-run]")) return simWiRun();
});

// Called each time the Tournaments tab opens. Fills the practice card, and - for a Tournament
// Manager - loads today's real tournament automatically on the event day.
function simTabOpened() {
  simSyncCreateForm();
  simLoadList();
  if (typeof isTournamentManagerSession === "function" && isTournamentManagerSession() && !SIM_ID) {
    const today = simTodayCairo();
    const sel = document.getElementById("tourn-event-select");
    const ev = (typeof EVENTS_DATA !== "undefined" ? EVENTS_DATA : []).find((e) => e.managedByMe && e.date === today && sel && Array.from(sel.options).some((o) => o.value === String(e.id)));
    if (ev && SIM_AUTO_LOADED_FOR !== ev.id && TOURNAMENT_EVENT_ID !== ev.id) {
      SIM_AUTO_LOADED_FOR = ev.id;
      sel.value = String(ev.id);
      simSyncCreateForm();
      simLoadList();
      loadTournamentPanel(ev.id);
    }
  }
}
