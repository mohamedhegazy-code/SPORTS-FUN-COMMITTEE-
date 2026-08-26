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

  function renderStandings(standings) {
    if (!standings || !standings.length) return "";
    const winner = standings.find((s) => s.rank === 1);
    const rows = standings
      .map((s) => `<tr><td>${s.rank}</td><td>${esc(s.label)}</td></tr>`)
      .join("");
    const banner = winner
      ? `<div class="winner-banner">
          <div class="trophy">🏆</div>
          <div class="label">${esc(t("finalStandingsTitle"))}</div>
          <div class="name">${esc(winner.label)}</div>
        </div>`
      : "";
    return `
      ${banner}
      <div class="section-title">${esc(t("finalStandingsTitle"))}</div>
      <div class="standings-card">
        <table><thead><tr><th>${esc(t("colPosition"))}</th><th>${esc(t("colName"))}</th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
  }

  function renderGroups(groups) {
    if (!groups || !groups.length) return "";
    const cards = groups
      .map((g, gi) => {
        const standingsRows = g.standings.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.label)}</td><td>${s.points}</td></tr>`).join("");
        const matches = g.matches
          .map((m) => {
            const resultText = !m.result
              ? t("matchNotYetPlayed")
              : m.result.winnerId === null
              ? t("matchDraw")
              : `${esc(m.result.winnerId === m.a ? m.aLabel : m.bLabel)} ${t("wins")}`;
            return `<div class="group-match${m.result ? " decided" : ""}"><span>${esc(m.aLabel)} ${esc(t("vs"))} ${esc(m.bLabel)}</span><span class="result">${esc(resultText)}</span></div>`;
          })
          .join("");
        return `<div class="group-card">
          <h3>${esc(t("groupLabel"))} ${String.fromCharCode(65 + gi)}</h3>
          <table><thead><tr><th>#</th><th>${esc(t("colName"))}</th><th>${esc(t("colPoints"))}</th></tr></thead><tbody>${standingsRows}</tbody></table>
          <div style="margin-top:12px;">${matches}</div>
        </div>`;
      })
      .join("");
    return `<div class="section-title">${esc(t("tournamentFormatGroups"))}</div><div class="groups-grid">${cards}</div>`;
  }

  function renderBracket(knockout) {
    if (!knockout) return "";
    const rounds = knockout.rounds;
    const roundsHtml = rounds
      .map((round, ri) => {
        const isFinal = ri === rounds.length - 1;
        const isSemi = ri === rounds.length - 2;
        const roundLabel = isFinal ? t("roundFinal") : isSemi ? t("roundSemifinal") : `${t("roundLabel")} ${ri + 1}`;
        const matches = round
          .map((m) => {
            const aLabel = m.aLabel || t("tbd");
            const bLabel = m.bLabel || t("tbd");
            let footer;
            if (m.bye) footer = t("byeLabel");
            else if (m.winnerId) {
              const winnerLabel = m.winnerId === m.a ? m.aLabel : m.bLabel;
              footer = `${esc(winnerLabel)} ${t("wins")}${m.score ? " (" + esc(m.score) + ")" : ""}`;
            } else footer = t("waitingOnPreviousRound");
            return `<div class="bracket-match">
              <div class="bracket-slot ${m.winnerId && m.winnerId === m.a ? "winner" : ""}">${esc(aLabel)}</div>
              <div class="bracket-slot ${m.winnerId && m.winnerId === m.b ? "winner" : ""}">${esc(bLabel)}</div>
              <div class="bracket-footer">${esc(footer)}</div>
            </div>`;
          })
          .join("");
        return `<div class="bracket-round"><h4>${esc(roundLabel)}</h4>${matches}</div>`;
      })
      .join("");
    return `<div class="section-title">${esc(t("tournamentFormatKnockout"))}</div><div class="bracket-wrap"><div class="bracket-rounds">${roundsHtml}</div></div>`;
  }

  async function loadAndRenderPicker() {
    const body = document.getElementById("screen-body");
    document.getElementById("screen-title").textContent = t("tournPublicTitle");
    document.getElementById("screen-subtitle").textContent = t("tournPublicIntro");
    try {
      const list = await (await fetch("/api/tournaments")).json();
      if (!list.length) {
        body.innerHTML = `<div class="empty-state"><h2>${esc(t("tournPublicEmpty"))}</h2></div>`;
        return;
      }
      body.innerHTML = `<div class="picker"><div class="picker-grid">${list
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
      document.getElementById("screen-subtitle").textContent = meta
        ? `${meta.date || ""}${meta.sport ? " · " + meta.sport : ""}`
        : "";
      document.getElementById("screen-updated").textContent = new Date().toLocaleTimeString(currentLang === "ar" ? "ar-EG" : "en-US");

      const tn = tnData.tournament;
      if (!tn) {
        body.innerHTML = `<div class="empty-state"><h2>${esc(t("tournPublicEmpty"))}</h2></div>`;
        return;
      }
      const modeLabel = tn.mode === "team" ? t("tournamentModeTeam") : t("tournamentModeIndividual");
      const formatLabel = tn.format === "groups" ? t("tournamentFormatGroups") : t("tournamentFormatKnockout");
      const statusLabel = tn.status === "completed" ? t("tournStatusCompleted") : t("tournStatusInProgress");
      let inner = "";
      if (tn.status === "team-setup" || tn.status === "setup" || tn.status === "seeding") {
        inner = `<div class="empty-state"><h2>${esc(t("tournPublicNotStarted"))}</h2></div>`;
      } else if (tn.status === "groups") {
        inner = renderGroups(tn.groups);
      } else if (tn.status === "knockout") {
        inner = renderBracket(tn.knockout);
      } else if (tn.status === "completed") {
        inner = renderStandings(tn.standings) + (tn.format === "groups" ? renderGroups(tn.groups) : "") + renderBracket(tn.knockout);
      }
      body.innerHTML = `
        <div class="badges">
          <span class="badge-pill">${esc(modeLabel)}</span>
          <span class="badge-pill">${esc(formatLabel)}</span>
          <span class="badge-pill">${esc(statusLabel)}</span>
        </div>
        ${inner}
      `;
    } catch (e) {
      body.innerHTML = `<div class="empty-state"><h2>${esc(e.message)}</h2></div>`;
    }
  }

  async function tick() {
    if (eventId) await loadAndRenderEvent();
    else await loadAndRenderPicker();
  }

  // The live dot + timestamp only mean something on the single-event view,
  // which actually auto-refreshes. The picker is a one-time launcher screen
  // that never refreshes itself, so showing "live" there would be misleading.
  const liveIndicator = document.querySelector(".live");
  if (liveIndicator) liveIndicator.style.display = eventId ? "" : "none";

  applyTheme();
  tick();
  // Only the single-event view needs to auto-refresh live - the picker
  // screen is just a launcher, not something meant to sit open on a TV.
  if (eventId) setInterval(tick, 15000);
