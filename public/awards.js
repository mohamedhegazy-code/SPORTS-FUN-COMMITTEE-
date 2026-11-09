"use strict";
// Scorers & awards for a tournament (loaded after app.js, shares its globals):
//  - admin card in the tournament panel: record who scored in each match, pick the
//    best goalkeeper / best player / fair-play team; the top scorer is calculated
//  - public card on the Tournaments page and the season calendar
// app.js calls window.AWARDS through aw(name, ...args), so a missing file never breaks the page.
(function () {
  const A = (window.AWARDS = {});
  const fill = (key, vars) => {
    let s = t(key);
    for (const k of Object.keys(vars || {})) s = s.split("{" + k + "}").join(vars[k]);
    return s;
  };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => escapeAttr(s == null ? "" : String(s));
  var PICKED = null; // match id currently open in the scorers form

  // Every match that already has a score, in a stable order, with a readable title.
  function scoredMatches(tn) {
    const out = [];
    (tn.groups || []).forEach((g) => g.matches.forEach((m) => {
      if (m.result && m.a && m.b) out.push({ m, a: m.result.scoreA, b: m.result.scoreB, stage: m.round ? fill("roundNo", { n: m.round }) : t("seasonLeagueMatch") });
    }));
    ((tn.knockout && tn.knockout.rounds) || []).forEach((round) => round.forEach((m) => {
      if (m.bye || !m.a || !m.b || !Number.isInteger(m.scoreA) || !Number.isInteger(m.scoreB)) return;
      out.push({ m, a: m.scoreA, b: m.scoreB, stage: m.place === 3 ? t("matchThirdTitle") : m.place === 1 ? t("matchFinalTitle") : t("roundLabel") });
    }));
    return out;
  }
  function playersOf(tn, entrantId) {
    return (tn.attendance || []).filter((p) => p.entrantId === entrantId);
  }
  function awardSelectHtml(id, label, options, selected, emptyLabel) {
    return `<label>${esc(label)}</label><select id="${id}"><option value="">${esc(emptyLabel)}</option>${options}</select>`.replace(
      `value="${selected}"`, `value="${selected}" selected`
    );
  }
  function playerOptionsHtml(tn, selected) {
    const byTeam = new Map();
    (tn.attendance || []).forEach((p) => {
      if (!byTeam.has(p.entrantId)) byTeam.set(p.entrantId, { label: p.entrantLabel, players: [] });
      byTeam.get(p.entrantId).players.push(p);
    });
    const opt = (p) => `<option value="${p.registrationId}"${selected === p.registrationId ? " selected" : ""}>${esc(p.name)}</option>`;
    if (tn.mode !== "team") return [...byTeam.values()].flatMap((g) => g.players).map(opt).join("");
    return [...byTeam.values()].map((g) => `<optgroup label="${esc(g.label)}">${g.players.map(opt).join("")}</optgroup>`).join("");
  }

  const withTeam = (p) => (p.entrantLabel && p.entrantLabel !== p.name ? `${p.name} — ${p.entrantLabel}` : p.name);
  A.topScorersTableHtml = function (aw) {
    const rows = (aw && aw.topScorers) || [];
    if (!rows.length) return `<p class="hint-note">${esc(t("scorersNone"))}</p>`;
    return `<table class="dashboard-table awards-table"><thead><tr><th>#</th><th>${esc(t("colName"))}</th><th>${esc(t("scorersTeam"))}</th><th>${esc(t("scorersGoals"))}</th></tr></thead><tbody>${rows
      .map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${r.entrantLabel !== r.name ? esc(r.entrantLabel) : "—"}</td><td><strong>${r.goals}</strong></td></tr>`)
      .join("")}</tbody></table>`;
  };
  // The four awards as a small list of "title - winner" lines (public + admin summary).
  A.awardsListHtml = function (aw) {
    if (!aw) return "";
    const topNames = (aw.topScorer || []).map((r) => `${r.name} (${r.goals})`).join("، ");
    const line = (title, val) => `<div class="award-line"><span class="award-title">${esc(title)}</span><span class="award-val${val ? "" : " award-none"}">${val ? esc(val) : esc(t("awardNotSet"))}</span></div>`;
    return `<div class="awards-list">
      ${line(t("awardTopScorer"), topNames)}
      ${line(t("awardBestGoalkeeper"), aw.bestGoalkeeper ? withTeam(aw.bestGoalkeeper) : "")}
      ${line(t("awardBestPlayer"), aw.bestPlayer ? withTeam(aw.bestPlayer) : "")}
      ${line(t("awardFairPlay"), aw.fairPlay ? aw.fairPlay.label : "")}
    </div>`;
  };
  // Public card: only shown once there is something to show.
  A.publicHtml = function (tn) {
    const aw = tn && tn.awards;
    if (!aw) return "";
    const any = (aw.topScorers && aw.topScorers.length) || aw.bestGoalkeeper || aw.bestPlayer || aw.fairPlay;
    if (!any) return "";
    return tournCardHtml(TOURN_ICON.standings, t("awardsCardTitle"), A.awardsListHtml(aw) + `<h5 class="awards-sub">${esc(t("scorersTitle"))}</h5>` + A.topScorersTableHtml(aw), "tourn-card-standings");
  };

  A.matchFormHtml = function (tn, entry) {
    const m = entry.m;
    const side = (entrantId, label, score) => {
      const have = {};
      (m.scorers || []).forEach((s) => { have[s.registrationId] = s.goals; });
      const rows = playersOf(tn, entrantId)
        .map((p) => `<label class="scorer-row"><span>${esc(p.name)}</span><input type="number" min="0" max="30" class="scorer-input" data-reg="${p.registrationId}" data-side="${entrantId === m.a ? "a" : "b"}" value="${have[p.registrationId] || ""}" placeholder="0" /></label>`)
        .join("");
      return `<div class="scorer-side"><h5>${esc(label)} <span class="scorer-score">${score}</span></h5>${rows || `<p class="hint-note">${esc(t("scorersNoPlayers"))}</p>`}</div>`;
    };
    return `<div class="scorer-form" data-a-score="${entry.a}" data-b-score="${entry.b}">
      <div class="scorer-sides">${side(m.a, m.aLabel, entry.a)}${side(m.b, m.bLabel, entry.b)}</div>
      <p class="hint-note">${esc(t("scorersOwnGoalHint"))}</p>
      <button class="primary small" type="button" data-tourn-action="scorers-save" data-match-id="${m.id}">${esc(t("btnSaveScorers"))}</button>
    </div>`;
  };

  // Admin card (inside the tournament panel).
  A.cardHtml = function () {
    const tn = TOURNAMENT_DATA;
    if (!tn || !tn.groups && !tn.knockout) return "";
    const aw = tn.awards || {};
    const matches = scoredMatches(tn);
    if (PICKED != null && !matches.some((e) => e.m.id === PICKED)) PICKED = null;
    const matchOpts = matches.map((e) => `<option value="${e.m.id}"${PICKED === e.m.id ? " selected" : ""}>${esc(e.stage)}: ${esc(e.m.aLabel)} ${e.a}-${e.b} ${esc(e.m.bLabel)}${(e.m.scorers || []).length ? " ✓" : ""}</option>`).join("");
    const picked = matches.find((e) => e.m.id === PICKED);
    const teamOpts = (tn.entrants || []).map((e) => `<option value="${esc(e.id)}"${aw.fairPlay && aw.fairPlay.entrantId === e.id ? " selected" : ""}>${esc(e.label)}</option>`).join("");
    return `
      <h5 class="awards-sub">${esc(t("scorersTitle"))}</h5>
      ${matches.length ? `<label>${esc(t("scorersPickMatch"))}</label><select id="scorers-match"><option value="">${esc(t("scorersPickMatchPlaceholder"))}</option>${matchOpts}</select>` : `<p class="hint-note">${esc(t("scorersNoScoredMatches"))}</p>`}
      <div id="scorers-form">${picked ? A.matchFormHtml(tn, picked) : ""}</div>
      <h5 class="awards-sub">${esc(t("scorersTop"))}</h5>
      ${A.topScorersTableHtml(aw)}
      <h5 class="awards-sub">${esc(t("awardsCardTitle"))}</h5>
      <div class="awards-form">
        <div><label>${esc(t("awardBestGoalkeeper"))}</label><select id="award-gk"><option value="">${esc(t("awardNotSet"))}</option>${playerOptionsHtml(tn, aw.bestGoalkeeper ? aw.bestGoalkeeper.registrationId : null)}</select></div>
        <div><label>${esc(t("awardBestPlayer"))}</label><select id="award-best"><option value="">${esc(t("awardNotSet"))}</option>${playerOptionsHtml(tn, aw.bestPlayer ? aw.bestPlayer.registrationId : null)}</select></div>
        <div><label>${esc(t("awardFairPlay"))}</label><select id="award-fair"><option value="">${esc(t("awardNotSet"))}</option>${teamOpts}</select></div>
      </div>
      <button class="secondary small" type="button" data-tourn-action="awards-save" style="margin-top:10px;">${esc(t("btnSaveAwards"))}</button>
      <p class="hint-note">${esc(t("awardTopScorerAuto"))}</p>
      <div class="msg" id="awards-msg"></div>`;
  };

  A.handleAction = async function (action, btn) {
    const msg = $("awards-msg");
    try {
      if (action === "scorers-save") {
        const form = btn.closest(".scorer-form");
        const scorers = [...form.querySelectorAll(".scorer-input")]
          .map((i) => ({ registrationId: Number(i.dataset.reg), goals: Number(i.value || 0) }))
          .filter((r) => r.goals > 0);
        const data = await api("/api/admin/tournaments/" + TOURNAMENT_EVENT_ID + "/match-scorers", {
          method: "PUT", body: JSON.stringify({ matchId: Number(btn.dataset.matchId), scorers }),
        });
        TOURNAMENT_DATA = data.tournament;
        renderTournamentBody();
        showMsg($("awards-msg"), t("okScorersSaved"), true);
      } else if (action === "awards-save") {
        const val = (id) => ($(id) && $(id).value ? $(id).value : null);
        const data = await api("/api/admin/tournaments/" + TOURNAMENT_EVENT_ID + "/awards", {
          method: "PUT", body: JSON.stringify({ bestGoalkeeper: val("award-gk"), bestPlayer: val("award-best"), fairPlay: val("award-fair") }),
        });
        TOURNAMENT_DATA = data.tournament;
        renderTournamentBody();
        showMsg($("awards-msg"), t("okAwardsSaved"), true);
      }
    } catch (e) {
      const code = e.data && e.data.code;
      const text = code === "scorers_exceed_score" ? t("errScorersExceed") : code === "score_first" ? t("errScoreFirst") : e.message;
      showMsg($("awards-msg") || $("tourn-msg"), text, false);
    }
  };

  // Picking a match shows its form (delegated: #tourn-body is re-rendered, the wrapper is not).
  const body = $("tourn-body");
  if (body) {
    body.addEventListener("change", (e) => {
      if (e.target && e.target.id === "scorers-match") {
        PICKED = e.target.value ? Number(e.target.value) : null;
        const tn = TOURNAMENT_DATA;
        const entry = tn && PICKED != null ? scoredMatches(tn).find((x) => x.m.id === PICKED) : null;
        $("scorers-form").innerHTML = entry ? A.matchFormHtml(tn, entry) : "";
      }
    });
  }
})();
