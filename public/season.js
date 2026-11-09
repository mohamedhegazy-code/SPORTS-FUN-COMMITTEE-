"use strict";
// Public season calendar (see season.html). Data: GET /api/season/:eventId.
currentLang = new URLSearchParams(location.search).get("lang") === "en" ? "en" : "ar";
document.documentElement.lang = currentLang;
document.documentElement.dir = currentLang === "ar" ? "rtl" : "ltr";
const T = (k) => (I18N[currentLang] && I18N[currentLang][k]) || (I18N.en && I18N.en[k]) || k;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nameHtml = (x) => {
  const ar = (x.nameAr || "").trim(), en = (x.nameEn || "").trim();
  return ar && en && ar !== en ? `<span class="lang-ar">${esc(ar)}</span><span class="lang-en">${esc(en)}</span>` : esc(ar || en);
};
const catName = (m) => (currentLang === "ar" ? m.eventNameAr || m.eventNameEn : m.eventNameEn || m.eventNameAr);
function dayLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(currentLang === "ar" ? "ar-EG-u-nu-latn" : "en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
function kindTag(m) {
  if (m.kind === "final") return `<span class="tag final">${esc(T("seasonFinalLabel"))}</span>`;
  if (m.kind === "third") return `<span class="tag third">${esc(T("seasonThirdLabel"))}</span>`;
  return `<span class="tag">${m.round ? esc(T("roundNo").replace("{n}", m.round)) : esc(T("seasonLeagueMatch"))}</span>`;
}
function resultHtml(m) {
  if (m.tbd) return `<span class="tbd">${esc(T("seasonTbd"))}</span>`;
  if (!m.result) return `<span class="tbd">${esc(T("matchNotYetPlayed"))}</span>`;
  const a = m.result.scoreA, b = m.result.scoreB;
  return a == null || b == null ? "" : `<span class="score">${esc(a)} - ${esc(b)}</span>`;
}
function matchRow(m) {
  const teams = m.tbd ? `<span class="tbd">${esc(T("seasonTbd"))}</span>` : `${esc(m.aLabel)} <span style="color:var(--muted)">–</span> ${esc(m.bLabel)}`;
  return `<tr><td>${esc(m.time || "")}</td><td>${m.court ? esc(T("courtLabel")) + " " + esc(m.court) : ""}</td><td>${esc(catName(m))}</td><td>${kindTag(m)}</td><td class="teams">${teams}</td><td>${resultHtml(m)}</td></tr>`;
}
const wt = (p) => (p.entrantLabel && p.entrantLabel !== p.name ? `${p.name} — ${p.entrantLabel}` : p.name);
function awardsHtml(c) {
  const aw = c.awards;
  if (!aw) return "";
  const top = (aw.topScorer || []).map((r) => `${r.name} (${r.goals})`).join("، ");
  const lines = [
    [T("awardTopScorer"), top],
    [T("awardBestGoalkeeper"), aw.bestGoalkeeper ? wt(aw.bestGoalkeeper) : ""],
    [T("awardBestPlayer"), aw.bestPlayer ? wt(aw.bestPlayer) : ""],
    [T("awardFairPlay"), aw.fairPlay ? aw.fairPlay.label : ""],
  ];
  if (!lines.some((l) => l[1])) return "";
  const scorers = (aw.topScorers || []).slice(0, 5).map((r, i) => `<tr><td>${i + 1}</td><td style="white-space:normal">${esc(r.name)}</td><td style="white-space:normal">${r.entrantLabel !== r.name ? esc(r.entrantLabel) : "—"}</td><td><strong>${r.goals}</strong></td></tr>`).join("");
  return `<div class="awards"><h4>${esc(T("awardsCardTitle"))}</h4>${lines.map((l) => `<div class="award-line"><span>${esc(l[0])}</span><span>${l[1] ? esc(l[1]) : `<span class="tbd">${esc(T("awardNotSet"))}</span>`}</span></div>`).join("")}${scorers ? `<div class="rows"><table><thead><tr><th>#</th><th>${esc(T("colName"))}</th><th>${esc(T("scorersTeam"))}</th><th>${esc(T("scorersGoals"))}</th></tr></thead><tbody>${scorers}</tbody></table></div>` : ""}</div>`;
}
function standingsHtml(c) {
  const rows = (c.standings || []).map((s, i) => `<tr><td>${i + 1}</td><td style="white-space:normal">${esc(s.label)}</td><td>${s.played}</td><td>${s.gd}</td><td><strong>${s.points}</strong></td></tr>`).join("");
  return `<div class="cat"><h3>${nameHtml(c)}</h3><div class="rows"><table><thead><tr><th>#</th><th>${esc(T("colName"))}</th><th>${esc(T("colPlayed"))}</th><th>${esc(T("colGD"))}</th><th>${esc(T("colPoints"))}</th></tr></thead><tbody>${rows}</tbody></table></div>${awardsHtml(c)}</div>`;
}
async function main() {
  const id = new URLSearchParams(location.search).get("event");
  document.getElementById("title").textContent = T("seasonPageTitle");
  document.title = "MyAhlawy — " + T("seasonPageTitle");
  try {
    const st = await (await fetch("/api/settings")).json();
    const th = st.theme || {};
    const root = document.documentElement.style;
    if (th.primaryColor) root.setProperty("--red", th.primaryColor);
    if (th.primaryColorDark) root.setProperty("--red-dark", th.primaryColorDark);
    if (th.accentColor) root.setProperty("--gold", th.accentColor);
    if (th.logoUrl) { const l = document.getElementById("logo"); l.src = th.logoUrl; l.hidden = false; }
  } catch (e) { /* cosmetic */ }
  const body = document.getElementById("body");
  let data;
  try {
    const r = await fetch("/api/season/" + encodeURIComponent(id));
    data = await r.json();
    if (!r.ok) throw new Error(data.error || "error");
  } catch (e) {
    body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  document.getElementById("subtitle").innerHTML = nameHtml(data);
  const dated = data.matches.filter((m) => m.date);
  if (!dated.length && !(data.categories || []).length) { body.innerHTML = `<div class="empty">${esc(T("seasonPageEmpty"))}</div>`; return; }
  const days = [];
  for (const m of dated) {
    let d = days[days.length - 1];
    if (!d || d.date !== m.date) { d = { date: m.date, rows: [] }; days.push(d); }
    d.rows.push(m);
  }
  const head = `<thead><tr><th></th><th></th><th></th><th></th><th></th><th></th></tr></thead>`;
  body.innerHTML =
    days.map((d) => `<section class="day"><h2>${esc(dayLabel(d.date))}</h2><div class="rows"><table>${head.replace(/<thead>.*<\/thead>/, "")}<tbody>${d.rows.map(matchRow).join("")}</tbody></table></div></section>`).join("") +
    `<h2 class="section">${esc(T("seasonStandings"))}</h2><div class="cats">${(data.categories || []).map(standingsHtml).join("")}</div>`;
}
main();
