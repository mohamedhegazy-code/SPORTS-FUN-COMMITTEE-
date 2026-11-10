"use strict";
// League season features (loaded after app.js, shares its globals):
//  - birth-year eligibility + team-registration fields on the Add / Edit event forms
//  - Register tab: team box (join or start a team) and eligibility hints on the attendee list
//  - tournament panel: registered-teams card and the shared-pitch season scheduler card
// app.js calls into window.LEAGUE through lg(name, ...args) so a missing file never breaks the page.
(function () {
  const L = (window.LEAGUE = {});
  const fill = (key, vars) => {
    let s = t(key);
    for (const k of Object.keys(vars || {})) s = s.split("{" + k + "}").join(vars[k]);
    return s;
  };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => escapeAttr(s == null ? "" : String(s));

  // ------------------------------------------------------------ display ----
  L.fmtDate = function (iso) {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-GB", { weekday: "short", day: "numeric", month: "short" });
  };
  L.bornRangeText = function (ev) {
    const from = ev && ev.birthYearFrom != null ? ev.birthYearFrom : null;
    const to = ev && ev.birthYearTo != null ? ev.birthYearTo : null;
    if (from === null && to === null) return "";
    if (from !== null && to !== null) return fill("bornBetween", { from, to });
    return from !== null ? fill("bornFrom", { from }) : fill("bornTo", { to });
  };
  L.genderRuleText = function (g) {
    return g === "female" ? t("genderBadgeFemale") : g === "male" ? t("genderBadgeMale") : "";
  };
  L.bornBadgeHtml = function (ev) {
    const txt = L.bornRangeText(ev);
    const g = ev && ev.genderRestriction ? L.genderRuleText(ev.genderRestriction) : "";
    return (txt ? `<span class="capacity-badge ok born-badge">${esc(txt)}</span>` : "") + (g ? `<span class="capacity-badge ok gender-badge">${esc(g)}</span>` : "");
  };
  L.teamBadgeHtml = function (ev) {
    const ts = ev && ev.teamRegistration;
    if (!ts) return "";
    const n = Number(ev.teamCount) || 0;
    const wl = Number(ev.waitlistTeamCount) || 0;
    const full = ts.maxTeams != null && n >= ts.maxTeams;
    const main = full
      ? `<span class="capacity-badge full">${esc(t("teamsFullBadge"))}</span>`
      : `<span class="capacity-badge ok">${esc(ts.maxTeams != null ? fill("teamsBadge", { n, max: ts.maxTeams }) : fill("teamsBadgeNoMax", { n }))}</span>`;
    return main + (wl > 0 ? `<span class="capacity-badge waitlist">${esc(fill("teamWaitlistBadge", { n: wl }))}</span>` : "");
  };
  // "{date} · {time} · Court n" prefix used on match lines.
  L.matchWhen = function (m) {
    const bits = [];
    if (m.date) bits.push(L.fmtDate(m.date));
    if (m.time) bits.push(m.time);
    if (m.court) bits.push(`${t("courtLabel")} ${m.court}`);
    return bits.join(" · ");
  };

  // ------------------------------------------------- event form fields ----
  function bindTeamToggle(prefix) {
    const on = $(prefix + "-team-on");
    if (!on || on.dataset.bound) return;
    on.dataset.bound = "1";
    const sync = () => {
      $(prefix + "-team-fields").classList.toggle("hidden", !on.checked);
      $(prefix + "-team-hint").classList.toggle("hidden", !on.checked);
    };
    on.addEventListener("change", sync);
    sync();
  }
  L.bindSeasonFields = function () {
    bindTeamToggle("ev");
    bindTeamToggle("ev-edit");
  };
  L.appendSeasonFields = function (fd, prefix) {
    const val = (id) => ($(prefix + id) ? $(prefix + id).value.trim() : "");
    fd.append("birthYearFrom", val("-birth-from"));
    fd.append("birthYearTo", val("-birth-to"));
    fd.append("genderRestriction", val("-gender"));
    const on = $(prefix + "-team-on");
    fd.append("teamRegistration", on && on.checked ? "true" : "false");
    if (on && on.checked) {
      fd.append("teamMinPlayers", val("-team-min"));
      fd.append("teamMaxPlayers", val("-team-max"));
      fd.append("teamMaxTeams", val("-team-maxteams"));
      fd.append("teamMinTeams", val("-team-minteams"));
    }
  };
  L.fillSeasonFields = function (prefix, ev) {
    const set = (id, v) => { if ($(prefix + id)) $(prefix + id).value = v == null ? "" : v; };
    set("-birth-from", ev ? ev.birthYearFrom : "");
    set("-birth-to", ev ? ev.birthYearTo : "");
    set("-gender", ev ? ev.genderRestriction || "" : "");
    const ts = ev && ev.teamRegistration;
    if ($(prefix + "-team-on")) $(prefix + "-team-on").checked = !!ts;
    set("-team-min", ts ? ts.minPlayers : 5);
    set("-team-max", ts ? ts.maxPlayers : 8);
    set("-team-maxteams", ts ? ts.maxTeams : "");
    set("-team-minteams", ts ? ts.minTeams : "");
    bindTeamToggle(prefix);
    if ($(prefix + "-team-on")) $(prefix + "-team-on").dispatchEvent(new Event("change"));
  };

  // ------------------------------------------------------ register tab ----
  var REG_TEAMS = null; // { eventId, data }
  function selectedRegEvent() {
    const sel = $("reg-event");
    return sel ? EVENTS_DATA.find((e) => e.id === Number(sel.value)) : null;
  }
  L.eligibilityFor = function (ev, person) {
    if (!ev) return null;
    const gr = ev.genderRestriction || "";
    if (gr) {
      const pg = person && person.gender;
      if (!pg) return { code: "gender_required" };
      if (pg !== gr) return { code: "not_eligible_gender", rule: gr };
    }
    if (ev.birthYearFrom == null && ev.birthYearTo == null) return null;
    const bd = person && person.birthDate;
    if (!bd) return { code: "birthdate_required" };
    const y = Number(String(bd).slice(0, 4));
    if ((ev.birthYearFrom != null && y < ev.birthYearFrom) || (ev.birthYearTo != null && y > ev.birthYearTo)) return { code: "not_eligible", year: y };
    return null;
  };
  L.refreshAttendeeEligibility = function () {
    const ev = selectedRegEvent();
    const member = CURRENT_SESSION && CURRENT_SESSION.type === "member" ? CURRENT_SESSION.member : null;
    document.querySelectorAll("#reg-attendees-list .att-elig-note").forEach((n) => n.remove());
    const rows = [];
    const self = $("att-self");
    if (self && member) rows.push({ box: self, person: member });
    document.querySelectorAll("#reg-attendees-list .att-dep").forEach((box) => {
      const dep = ((member && member.dependents) || []).find((d) => String(d.id) === String(box.dataset.depId));
      if (dep) rows.push({ box, person: dep });
    });
    for (const { box, person } of rows) {
      const problem = L.eligibilityFor(ev, person);
      if (problem) {
        box.dataset.eligOff = "1";
        box.checked = false;
        box.disabled = true;
        const note = document.createElement("span");
        note.className = "att-elig-note capacity-badge full";
        note.textContent = problem.code === "not_eligible" ? fill("attNotEligible", { year: problem.year })
          : problem.code === "not_eligible_gender" ? fill("attNotEligibleGender", { rule: L.genderRuleText(problem.rule) })
          : problem.code === "gender_required" ? t("attNeedsGender") : t("attNeedsBirth");
        const label = box.parentElement && box.parentElement.querySelector("label");
        if (label) { label.appendChild(document.createTextNode(" ")); label.appendChild(note); }
      } else if (box.dataset.eligOff) {
        delete box.dataset.eligOff;
        box.disabled = false;
        if (box === self) box.checked = true; // the default "me" tick comes back
      }
    }
    const hint = $("reg-born-hint");
    if (hint) hint.remove();
    const ruleBits = ev ? [ev.genderRestriction ? L.genderRuleText(ev.genderRestriction) : "", L.bornRangeText(ev)].filter(Boolean) : [];
    if (ruleBits.length) {
      const p = document.createElement("p");
      p.id = "reg-born-hint";
      p.className = "hint-note";
      p.textContent = ruleBits.join(" · ");
      const list = $("reg-attendees-list");
      if (list) list.parentNode.insertBefore(p, list);
    }
  };
  L.onRegEventChanged = async function () {
    L.refreshAttendeeEligibility();
    const box = $("reg-team-box");
    if (!box) return;
    const ev = selectedRegEvent();
    if (!ev || !ev.teamRegistration) {
      box.classList.add("hidden");
      box.innerHTML = "";
      REG_TEAMS = null;
      return;
    }
    try {
      const data = await api("/api/events/" + ev.id + "/teams");
      // the member may have switched events while this loaded
      const now = selectedRegEvent();
      if (!now || now.id !== ev.id) return;
      REG_TEAMS = { eventId: ev.id, data };
      renderTeamBox(ev, data);
    } catch (e) {
      box.classList.add("hidden");
    }
  };
  function renderTeamBox(ev, data) {
    const box = $("reg-team-box");
    const ts = data.teamRegistration || ev.teamRegistration;
    const prev = box.querySelector('input[name="reg-team-mode"]:checked');
    const prevMode = prev ? prev.value : null;
    const prevTeam = $("reg-team-select") ? $("reg-team-select").value : "";
    const prevName = $("reg-team-name") ? $("reg-team-name").value : "";
    const teams = data.teams || [];
    const hasTeams = teams.length > 0;
    const mode = prevMode || (hasTeams ? "join" : "new");
    const options = teams
      .map((tm) => {
        const tags = [tm.full ? t("regTeamFull") : "", tm.waitlisted ? t("regTeamWaiting") : ""].filter(Boolean).join(" · ");
        return `<option value="${tm.id}" ${tm.full ? "disabled" : ""}>${esc(tm.name)} — ${esc(fill("regTeamSeats", { n: tm.playerCount, max: tm.maxPlayers }))}${tags ? " — " + esc(tags) : ""}</option>`;
      })
      .join("");
    box.classList.remove("hidden");
    box.innerHTML = `
      <h3 class="reg-team-title">${esc(t("regTeamTitle"))}</h3>
      <p class="hint-note">${esc(t("regTeamIntro"))} ${esc(fill("regTeamRules", { min: ts.minPlayers, max: ts.maxPlayers }))}</p>
      ${hasTeams ? `<label class="checkbox-row"><input type="radio" name="reg-team-mode" value="join" ${mode === "join" ? "checked" : ""}/> <span>${esc(t("regTeamJoinOpt"))}</span></label>
      <select id="reg-team-select" ${mode === "join" ? "" : "disabled"}><option value="">${esc(t("regTeamPick"))}</option>${options}</select>` : `<p class="hint-note">${esc(t("regTeamNone"))}</p>`}
      <label class="checkbox-row"><input type="radio" name="reg-team-mode" value="new" ${mode === "new" || !hasTeams ? "checked" : ""}/> <span>${esc(t("regTeamNewOpt"))}</span></label>
      <input id="reg-team-name" type="text" maxlength="40" placeholder="${esc(t("regTeamNamePh"))}" aria-label="${esc(t("regTeamNameLabel"))}" ${mode === "new" || !hasTeams ? "" : "disabled"} />
    `;
    if (prevTeam && $("reg-team-select")) $("reg-team-select").value = prevTeam;
    if (prevName && $("reg-team-name")) $("reg-team-name").value = prevName;
  }
  document.addEventListener("change", (e) => {
    if (e.target && e.target.name === "reg-team-mode") {
      const join = e.target.value === "join";
      if ($("reg-team-select")) $("reg-team-select").disabled = !join;
      if ($("reg-team-name")) $("reg-team-name").disabled = join;
    }
  });
  // What the member chose in the team box: {} for an ordinary event,
  // {error} when it is incomplete, otherwise {teamId} or {newTeamName}.
  L.teamChoice = function () {
    const ev = selectedRegEvent();
    if (!ev || !ev.teamRegistration) return {};
    const mode = document.querySelector('input[name="reg-team-mode"]:checked');
    if (!mode) return { error: t("errTeamRequired") };
    if (mode.value === "join") {
      const id = $("reg-team-select") && $("reg-team-select").value;
      return id ? { teamId: Number(id) } : { error: t("errTeamRequired") };
    }
    const name = $("reg-team-name") ? $("reg-team-name").value.trim().replace(/\s+/g, " ") : "";
    return name ? { newTeamName: name } : { error: t("errTeamNameNeeded") };
  };
  // Translates the server's error codes (eligibility, teams); null = not ours.
  L.mapRegError = function (e) {
    const d = e && e.data;
    if (!d || !d.code) return null;
    if (d.code === "not_eligible") {
      const ev = { birthYearFrom: d.birthYearFrom, birthYearTo: d.birthYearTo };
      return fill("errNotEligible", { name: d.attendeeName || "", year: d.birthYear || "", range: L.bornRangeText(ev) });
    }
    if (d.code === "exclusive_event") {
      const other = (currentLang === "ar" ? d.otherEventNameAr : d.otherEventNameEn) || d.otherEventNameEn || "";
      return fill("errExclusiveEvent", { name: d.attendeeName || "", event: other });
    }
    if (d.code === "gender_required") return fill("errGenderNeeded", { name: d.attendeeName || "" });
    if (d.code === "not_eligible_gender") {
      return fill("errNotEligibleGender", { name: d.attendeeName || "", rule: d.genderRestriction === "female" ? t("genderFemaleOnly") : t("genderMaleOnly") });
    }
    const map = {
      birthdate_required: "errBirthDateNeeded", team_required: "errTeamRequired", team_full: "errTeamFull", team_name_taken: "errTeamNameTaken",
      team_not_found: "errTeamNotFound", team_name_invalid: "errTeamNameInvalid",
    };
    return map[d.code] ? t(map[d.code]) : null;
  };

  // ------------------------------------ admin: registered teams card --------
  var TEAMS_ADMIN = null;
  var TEAMS_INCLUDE_INCOMPLETE = false;
  var TOURN_LIST = [];
  L.loadTeams = async function (eventId) {
    TEAMS_ADMIN = null;
    try { TOURN_LIST = (await api("/api/tournaments")) || []; } catch (e) { TOURN_LIST = []; }
    const ev = EVENTS_DATA.find((e) => e.id === Number(eventId));
    if (!ev || !ev.teamRegistration) return;
    try {
      TEAMS_ADMIN = await api("/api/admin/events/" + eventId + "/teams");
    } catch (e) { TEAMS_ADMIN = null; }
  };
  L.teamsCardHtml = function () {
    const d = TEAMS_ADMIN;
    if (!d || !d.teamRegistration) return "";
    const ts = d.teamRegistration;
    const rows = d.teams.length
      ? d.teams
          .map((tm) => {
            const players = tm.players.map((p) => `<li>${esc(p.name)}${p.isCaptain ? ` <span class="capacity-badge ok">${esc(t("adminTeamCaptain"))}</span>` : ""}</li>`).join("");
            const flags = [
              `<span class="capacity-badge ${tm.complete ? "ok" : "full"}">${esc(fill("adminTeamPlayers", { n: tm.playerCount, max: ts.maxPlayers }))}</span>`,
              !tm.complete ? `<span class="capacity-badge full">${esc(fill("adminTeamIncomplete", { min: ts.minPlayers }))}</span>` : "",
              tm.waitlisted ? `<span class="capacity-badge waitlist">${esc(t("adminTeamWaiting"))}</span>` : "",
            ].join("");
            return `<div class="team-admin-row">
              <div class="team-admin-head"><strong>${esc(tm.name)}</strong> ${flags}</div>
              <ol class="team-admin-players">${players}</ol>
              <div class="team-admin-actions">
                <button class="secondary small" data-tourn-action="team-rename" data-team-id="${tm.id}" data-team-name="${esc(tm.name)}">${esc(t("adminTeamRename"))}</button>
                ${tm.waitlisted ? `<button class="secondary small" data-tourn-action="team-promote" data-team-id="${tm.id}">${esc(t("adminTeamPromote"))}</button>` : ""}
                <button class="danger small" data-tourn-action="team-remove" data-team-id="${tm.id}">${esc(t("adminTeamRemove"))}</button>
              </div>
            </div>`;
          })
          .join("")
      : `<p class="hint-note">${esc(t("adminTeamsNone"))}</p>`;
    const canImport = TOURNAMENT_DATA && TOURNAMENT_DATA.mode === "team" && (TOURNAMENT_DATA.status === "team-setup" || TOURNAMENT_DATA.status === "seeding");
    const importHtml = canImport
      ? `<div style="margin-top:10px;">
           <label class="checkbox-row"><input type="checkbox" id="team-include-incomplete" ${TEAMS_INCLUDE_INCOMPLETE ? "checked" : ""}/> <span>${esc(t("adminTeamsIncludeIncomplete"))}</span></label>
           <button class="primary" data-tourn-action="team-import">${esc(t("adminTeamsImport"))}</button>
         </div>`
      : "";
    return `<p class="hint-note">${esc(fill("adminTeamsSummary", { confirmed: d.confirmedTeams, waiting: d.waitlistedTeams }))}</p>
      ${d.belowMinTeams ? `<p class="hint-note" style="color:var(--red,#8b0000);">${esc(fill("adminTeamsBelowMin", { min: ts.minTeams }))}</p>` : ""}
      ${rows}${importHtml}`;
  };
  document.addEventListener("change", (e) => {
    if (e.target && e.target.id === "team-include-incomplete") TEAMS_INCLUDE_INCOMPLETE = e.target.checked;
  });

  // ------------------------------------------ admin: season scheduler -------
  var SEASON = { selected: null, matchMinutes: 30, gapMinutes: 5, maxPerTeamPerDay: 2, days: null, finals: null, ready: false };
  function siblingLeagues() {
    const me = EVENTS_DATA.find((e) => e.id === TOURNAMENT_EVENT_ID);
    if (!me) return [];
    const list = me.parentEventId ? EVENTS_DATA.filter((e) => e.parentEventId === me.parentEventId) : [me];
    return list.map((e) => {
      const meta = TOURN_LIST.find((x) => x.eventId === e.id);
      const ready = e.id === TOURNAMENT_EVENT_ID ? !!(TOURNAMENT_DATA && TOURNAMENT_DATA.groups) : !!(meta && meta.format === "groups" && meta.status !== "seeding" && meta.status !== "team-setup");
      return { id: e.id, label: eventLabel(e), ready };
    });
  }
  function initSeasonState() {
    const tn = TOURNAMENT_DATA;
    const saved = tn && tn.seasonSchedule;
    if (SEASON.ready && SEASON.forEvent === TOURNAMENT_EVENT_ID) return;
    SEASON.forEvent = TOURNAMENT_EVENT_ID;
    SEASON.ready = true;
    SEASON.selected = new Set([TOURNAMENT_EVENT_ID]);
    SEASON.matchMinutes = saved ? saved.matchMinutes : 30;
    SEASON.gapMinutes = saved ? saved.gapMinutes : 5;
    SEASON.maxPerTeamPerDay = saved ? saved.maxPerTeamPerDay : 2;
    SEASON.days = saved && saved.days ? saved.days.map((d) => ({ ...d })) : [{ date: "", pitches: 3, startTime: "10:00", slots: 4 }];
    const f = saved && saved.finals;
    SEASON.finals = f ? { date: f.date, thirdPlaceTime: f.thirdPlaceTime, finalTime: f.finalTime, pitches: (f.pitches || []).join(",") } : { date: "", thirdPlaceTime: "11:20", finalTime: "12:00", pitches: "" };
  }
  L.seasonCardHtml = function () {
    const tn = TOURNAMENT_DATA;
    if (!tn || tn.finalsMode !== "table" || !tn.groups) return "";
    initSeasonState();
    const sibs = siblingLeagues();
    const sibHtml = sibs
      .map((s) => `<label class="checkbox-row"><input type="checkbox" class="season-league" data-event-id="${s.id}" ${SEASON.selected.has(s.id) ? "checked" : ""} ${s.ready ? "" : "disabled"}/> <span>${esc(s.label)} ${s.ready ? "" : esc(t("seasonNeedGenerate"))}</span></label>`)
      .join("");
    const dayRows = SEASON.days
      .map(
        (d, i) => `<div class="grid-2 season-day" data-day="${i}">
          <div><label>${esc(t("seasonDayDate"))}</label><input type="date" data-season-field="date" value="${esc(d.date)}" /></div>
          <div><label>${esc(t("seasonDayPitches"))}</label><input type="number" min="1" max="30" data-season-field="pitches" value="${esc(d.pitches)}" /></div>
          <div><label>${esc(t("seasonDayStart"))}</label><input type="time" data-season-field="startTime" value="${esc(d.startTime)}" /></div>
          <div><label>${esc(t("seasonDaySlots"))}</label><input type="number" min="1" max="40" data-season-field="slots" value="${esc(d.slots)}" /></div>
          ${SEASON.days.length > 1 ? `<div><button class="secondary small" data-tourn-action="season-remove-day" data-day="${i}">${esc(t("seasonRemoveDay"))}</button></div>` : ""}
        </div>`
      )
      .join("");
    const f = SEASON.finals;
    const me = EVENTS_DATA.find((e) => e.id === TOURNAMENT_EVENT_ID);
    const parentId = me && me.parentEventId ? me.parentEventId : TOURNAMENT_EVENT_ID;
    return `<div id="season-card">
      <p class="hint-note">${esc(t("seasonIntro"))}</p>
      <label>${esc(t("seasonLeagues"))}</label>${sibHtml}
      ${sibs.length < 2 ? `<p class="hint-note">${esc(t("seasonNoSiblings"))}</p>` : ""}
      <div class="grid-2" style="margin-top:8px;">
        <div><label>${esc(t("seasonMatchMinutes"))}</label><input type="number" min="1" data-season-top="matchMinutes" value="${esc(SEASON.matchMinutes)}" /></div>
        <div><label>${esc(t("seasonGapMinutes"))}</label><input type="number" min="0" data-season-top="gapMinutes" value="${esc(SEASON.gapMinutes)}" /></div>
        <div><label>${esc(t("seasonMaxPerDay"))}</label><input type="number" min="1" max="10" data-season-top="maxPerTeamPerDay" value="${esc(SEASON.maxPerTeamPerDay)}" /></div>
      </div>
      <label style="margin-top:10px;">${esc(t("seasonDays"))}</label>${dayRows}
      <button class="secondary small" data-tourn-action="season-add-day">${esc(t("seasonAddDay"))}</button>
      <label style="margin-top:12px;">${esc(t("seasonFinalsTitle"))}</label>
      <div class="grid-2">
        <div><label>${esc(t("seasonFinalsDate"))}</label><input type="date" data-season-finals="date" value="${esc(f.date)}" /></div>
        <div><label>${esc(t("seasonFinalsThird"))}</label><input type="time" data-season-finals="thirdPlaceTime" value="${esc(f.thirdPlaceTime)}" /></div>
        <div><label>${esc(t("seasonFinalsFinal"))}</label><input type="time" data-season-finals="finalTime" value="${esc(f.finalTime)}" /></div>
        <div><label>${esc(t("seasonFinalsPitches"))}</label><input type="text" data-season-finals="pitches" value="${esc(f.pitches)}" placeholder="1,2" /></div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;">
        <button class="secondary" data-tourn-action="season-check">${esc(t("seasonCheck"))}</button>
        <button class="primary" data-tourn-action="season-apply">${esc(t("seasonApply"))}</button>
        <a class="secondary small tourn-live-link" href="/season.html?event=${parentId}&lang=${currentLang}" target="_blank" rel="noopener">${esc(t("seasonViewPublic"))}</a>
      </div>
      <div class="msg" id="season-msg"></div>
    </div>`;
  };
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (!el || !el.closest || !el.closest("#season-card")) return;
    if (el.dataset.seasonTop) SEASON[el.dataset.seasonTop] = el.value;
    else if (el.dataset.seasonFinals) SEASON.finals[el.dataset.seasonFinals] = el.value;
    else if (el.dataset.seasonField) {
      const row = el.closest(".season-day");
      if (row) SEASON.days[Number(row.dataset.day)][el.dataset.seasonField] = el.value;
    }
  });
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el && el.classList && el.classList.contains("season-league")) {
      const id = Number(el.dataset.eventId);
      if (el.checked) SEASON.selected.add(id);
      else SEASON.selected.delete(id);
    }
  });
  function seasonBody(dryRun) {
    const finalsPitches = String(SEASON.finals.pitches || "").split(/[,،\s]+/).filter(Boolean).map(Number);
    const body = {
      eventIds: Array.from(SEASON.selected),
      matchMinutes: Number(SEASON.matchMinutes),
      gapMinutes: Number(SEASON.gapMinutes),
      maxPerTeamPerDay: Number(SEASON.maxPerTeamPerDay),
      days: SEASON.days.map((d) => ({ date: d.date, pitches: Number(d.pitches), startTime: d.startTime, slots: Number(d.slots) })),
    };
    if (SEASON.finals.date) {
      body.finals = { date: SEASON.finals.date, thirdPlaceTime: SEASON.finals.thirdPlaceTime, finalTime: SEASON.finals.finalTime, pitches: finalsPitches };
    }
    if (dryRun) body.dryRun = "true";
    return body;
  }
  async function runSeason(dryRun) {
    const msg = $("season-msg");
    try {
      const data = await api("/api/admin/season-schedule", { method: "POST", body: JSON.stringify(seasonBody(dryRun)) });
      if (dryRun) {
        const ends = Object.entries(data.lastEnd || {}).map(([d, tm]) => `${L.fmtDate(d)} ${tm}`).join(" · ");
        showMsg(msg, fill("seasonChecked", { n: data.scheduled, ends }), true);
      } else {
        await loadTournamentPanel(TOURNAMENT_EVENT_ID);
        showMsg($("season-msg"), fill("seasonApplied", { n: data.scheduled }), true);
      }
    } catch (e) {
      showMsg(msg, e.message, false);
    }
  }
  // Actions dispatched from the tournament panel (data-tourn-action).
  L.handleAction = async function (action, btn) {
    const msg = $("tourn-msg");
    try {
      if (action === "season-add-day") {
        const last = SEASON.days[SEASON.days.length - 1];
        let next = "";
        if (last && last.date) { const d = new Date(last.date + "T00:00:00"); d.setDate(d.getDate() + 7); next = d.toISOString().slice(0, 10); }
        SEASON.days.push({ date: next, pitches: last ? last.pitches : 3, startTime: last ? last.startTime : "10:00", slots: last ? last.slots : 4 });
        renderTournamentBody();
      } else if (action === "season-remove-day") {
        SEASON.days.splice(Number(btn.dataset.day), 1);
        renderTournamentBody();
      } else if (action === "season-check") await runSeason(true);
      else if (action === "season-apply") await runSeason(false);
      else if (action === "team-promote") {
        await api("/api/admin/event-teams/" + btn.dataset.teamId + "/promote", { method: "POST", body: JSON.stringify({}) });
        await refreshAfterTeamChange();
        showMsg($("tourn-msg"), t("adminTeamPromoted"), true);
      } else if (action === "team-remove") {
        const reason = prompt(t("adminTeamRemoveReason"));
        if (!reason || !reason.trim()) return;
        await api("/api/admin/event-teams/" + btn.dataset.teamId + "/remove", { method: "POST", body: JSON.stringify({ reason: reason.trim() }) });
        await refreshAfterTeamChange();
        showMsg($("tourn-msg"), t("adminTeamRemoved"), true);
      } else if (action === "team-rename") {
        const name = prompt(t("adminTeamRenamePrompt"), btn.dataset.teamName || "");
        if (!name || !name.trim()) return;
        await api("/api/admin/event-teams/" + btn.dataset.teamId, { method: "PUT", body: JSON.stringify({ name: name.trim() }) });
        await refreshAfterTeamChange();
      } else if (action === "team-import") {
        const data = await api("/api/admin/tournaments/" + TOURNAMENT_EVENT_ID + "/import-teams", {
          method: "POST",
          body: JSON.stringify({ includeIncomplete: TEAMS_INCLUDE_INCOMPLETE ? "true" : "false" }),
        });
        TOURNAMENT_DATA = data.tournament;
        await L.loadTeams(TOURNAMENT_EVENT_ID);
        renderTournamentBody();
        const skipped = (data.skipped || []).map((s) => s.name).join("، ");
        showMsg($("tourn-msg"), t("adminTeamsImportDone") + (skipped ? " " + fill("adminTeamsSkipped", { list: skipped }) : ""), true);
      }
    } catch (e) {
      const skipped = e.data && e.data.skipped && e.data.skipped.length ? " " + fill("adminTeamsSkipped", { list: e.data.skipped.map((s) => s.name).join("، ") }) : "";
      showMsg(msg || $("season-msg"), e.message + skipped, false);
    }
  };
  async function refreshAfterTeamChange() {
    await loadEvents();
    await loadTournamentPanel(TOURNAMENT_EVENT_ID);
  }

  // wire the form fields once the DOM is ready (script sits at the end of <body>)
  L.bindSeasonFields();
})();
