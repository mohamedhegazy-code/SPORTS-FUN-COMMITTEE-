// Tournament simulations: isolated practice runs for Admin / Event Manager / Tournament Manager,
// plus the "real tournament opens on the event day" rule for Tournament Managers.
// Usage: BASE_URL=http://localhost:3951 node simulation_e2e.js
"use strict";
const BASE = process.env.BASE_URL || "http://localhost:3951";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
let passed = 0, failed = 0;
const serverErrors = [];
const ok = (c, l, x) => { if (c) passed++; else { failed++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 500)); } };
const section = (s) => console.log("\n=== " + s + " ===");
const applySetCookies = (jar, res) => { const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []; for (const raw of sc) { const [pair] = raw.split(";"); const eq = pair.indexOf("="); if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); } };
async function api(path, { method = "GET", body, jar, form } = {}) {
  jar = jar || {};
  const headers = {};
  if (Object.keys(jar).length) headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (!["GET", "HEAD"].includes(method) && jar.csrfToken) headers["X-CSRF-Token"] = jar.csrfToken;
  let fb; if (form) fb = form; else if (body !== undefined) { headers["Content-Type"] = "application/json"; fb = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: fb, redirect: "manual" });
  applySetCookies(jar, res);
  if (res.status >= 500) serverErrors.push(`${method} ${path} -> ${res.status}`);
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, jar };
}
const prime = async (jar) => { await api("/", { jar }); return jar; };
const form = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const cairoToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
(async () => {
  const stamp = Date.now().toString(36);
  const admin = await prime({});
  ok((await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } })).status === 200, "admin login");
  const mkMgr = async (name) => {
    const username = name + stamp;
    const r = await api("/api/staff/accounts", { method: "POST", jar: admin, body: { username, password: "Manager#1234", name, role: "tournament" } });
    ok(r.status === 201, "create " + name, r.json);
    const jar = await prime({});
    ok((await api("/api/auth/staff-login", { method: "POST", jar, body: { username, password: "Manager#1234" } })).status === 200, name + " login");
    return { username, jar };
  };
  const mgr = await mkMgr("mgr");
  const other = await mkMgr("other");
  const mkEvent = async (name, date, managers) => {
    const r = await api("/api/events", { method: "POST", jar: admin, form: form({ nameEn: name + " " + stamp, nameAr: name, sport: "Chess", date, managerUsernames: JSON.stringify(managers) }) });
    ok(r.status === 201 || r.status === 200, "create event " + name, r.json);
    return r.json.id;
  };
  const evFuture = await mkEvent("SimFuture", "2027-06-01", [mgr.username]);
  const evToday = await mkEvent("SimToday", cairoToday(), [mgr.username]);
  const evOther = await mkEvent("SimOther", "2027-06-02", [other.username]);
  // six real registrants on the future event
  for (let i = 1; i <= 6; i++) {
    const jar = await prime({});
    const num = `SM${stamp}${i}`;
    const s = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: num, name: `Real Player ${i}`, password: "abc12345", phone: `0100${String(i).padStart(7, "0")}`, agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
    ok(s.status === 200 || s.status === 201, "signup " + i, s.json);
    const r = await api("/api/register", { method: "POST", jar, body: { eventId: evFuture } });
    ok(r.status === 200 || r.status === 201, "register " + i, r.json);
  }

  section("Event-day opening of the REAL tournament");
  let r = await api(`/api/admin/tournaments/${evFuture}`, { jar: mgr.jar });
  ok(r.status === 403 && r.json.code === "tournament_not_open_yet" && r.json.opensOn === "2027-06-01", "manager is held back before the event day", r.json);
  r = await api(`/api/admin/tournaments/${evFuture}`, { method: "POST", jar: mgr.jar, body: { mode: "individual", format: "knockout" } });
  ok(r.status === 403, "manager cannot create the real tournament early", r.json);
  r = await api(`/api/admin/tournaments/${evFuture}`, { jar: admin });
  ok(r.status === 200 && r.json.tournament === null && r.json.registrations.length === 6, "admin is never held back", r.json);
  r = await api(`/api/admin/tournaments/${evToday}`, { jar: mgr.jar });
  ok(r.status === 200, "on the event day the manager's real tournament loads", r.json);
  r = await api(`/api/admin/tournaments/${evOther}`, { jar: mgr.jar });
  ok(r.status === 403 && r.json.code !== "tournament_not_open_yet", "other managers' events stay forbidden", r.json);

  section("Creating simulations");
  r = await api("/api/sim", { jar: mgr.jar });
  ok(r.status === 200 && r.json.simulations.length === 0, "empty list at first", r.json);
  r = await api("/api/sim", { method: "POST", jar: mgr.jar, body: { eventId: evOther, mode: "dummy", playerCount: 8 } });
  ok(r.status === 403, "manager can't simulate someone else's event", r.json);
  r = await api("/api/sim", { method: "POST", jar: await prime({}), body: { eventId: evFuture, mode: "dummy", playerCount: 8 } });
  ok(r.status === 401, "anonymous -> 401");
  r = await api("/api/sim", { method: "POST", jar: mgr.jar, body: { eventId: evFuture, mode: "dummy", playerCount: 1 } });
  ok(r.status === 400, "player count validated", r.json);
  r = await api("/api/sim", { method: "POST", jar: mgr.jar, body: { eventId: evFuture, mode: "bogus" } });
  ok(r.status === 400, "mode validated", r.json);
  r = await api("/api/sim", { method: "POST", jar: mgr.jar, body: { eventId: evFuture, mode: "both", playerCount: 16, name: "Knockout rehearsal" } });
  ok(r.status === 201 && r.json.simulation.playerCount === 16, "manager creates a simulation (6 real + 10 dummy)", r.json);
  const sim1 = r.json.simulation.id;
  r = await api("/api/sim", { method: "POST", jar: admin, body: { eventId: evFuture, mode: "registrants" } });
  ok(r.status === 201 && r.json.simulation.playerCount === 6, "admin simulates with real registrants only", r.json);
  const simReal = r.json.simulation.id;
  r = await api("/api/sim", { jar: other.jar });
  ok(r.json.simulations.length === 0, "other manager does not see them", r.json);
  r = await api("/api/sim", { jar: admin });
  ok(r.json.simulations.length === 2, "admin sees all", r.json);
  r = await api("/api/sim", { method: "POST", jar: mgr.jar, body: { eventId: evToday, mode: "registrants" } });
  ok(r.status === 400 && r.json.code === "sim_too_few", "registrants-only needs at least 2 real registrants", r.json);

  section("Knockout simulation: draw, schedule, finish time, auto-play");
  const S = (id, ev, suffix = "") => `/api/sim/${id}/admin/tournaments/${ev}${suffix}`;
  r = await api(S(sim1, evFuture), { jar: mgr.jar });
  ok(r.status === 200 && r.json.tournament === null && r.json.registrations.length === 16, "sim shows its 16 players", r.json);
  r = await api(S(sim1, evFuture), { method: "POST", jar: mgr.jar, body: { mode: "individual", format: "knockout", courts: 2, matchMinutes: 20, startTime: "10:00", availableHours: 6 } });
  ok(r.status === 201, "create tournament inside the simulation", r.json);
  r = await api(S(sim1, evFuture, "/generate"), { method: "POST", jar: mgr.jar });
  ok(r.status === 200 && r.json.tournament.knockout.rounds[0].length === 8, "draw generated (16 players)", r.json);
  const finishPlanned = r.json.tournament.schedule.estimatedFinishTime;
  ok(/^\d\d:\d\d$/.test(finishPlanned), "finish time is estimated", finishPlanned);
  // isolation
  r = await api(`/api/admin/tournaments/${evFuture}`, { jar: admin });
  ok(r.json.tournament === null && r.json.registrations.length === 6, "REAL tournament untouched, real registrants unchanged", r.json);
  r = await api("/api/tournaments");
  ok(!(r.json.tournaments || r.json || []).some((t) => t.eventId === evFuture), "simulation not on the public tournaments list");
  r = await api("/api/sim/" + sim1 + "/autoplay", { method: "POST", jar: mgr.jar, body: { until: "draw" } });
  ok(r.status === 400, "draw already made -> error", r.json);
  r = await api("/api/sim/" + sim1 + "/autoplay", { method: "POST", jar: mgr.jar, body: { until: "stage" } });
  ok(r.status === 200 && r.json.played === 8, "auto-play one round (8 matches)", r.json);
  r = await api("/api/sim/" + sim1 + "/autoplay", { method: "POST", jar: mgr.jar, body: { until: "end", style: "seeded" } });
  ok(r.status === 200 && r.json.tournament.status === "completed" && r.json.tournament.standings[0].rank === 1, "auto-play to the final", r.json);
  ok(r.json.played === 7, "remaining 7 matches played", r.json.played);
  r = await api("/api/sim/" + sim1 + "/autoplay", { method: "POST", jar: mgr.jar, body: { until: "end" } });
  ok(r.status === 400, "finished tournament can't be auto-played again", r.json);
  // manual play inside the sim
  r = await api("/api/sim/" + simReal + "/autoplay", { method: "POST", jar: admin, body: {} });
  ok(r.status === 400 && r.json.code === "sim_no_tournament", "autoplay needs a tournament first", r.json);
  await api(S(simReal, evFuture), { method: "POST", jar: mgr.jar, body: { mode: "individual", format: "knockout" } });
  r = await api(S(simReal, evFuture, "/generate"), { method: "POST", jar: mgr.jar });
  const m0 = r.json.tournament.knockout.rounds[0].find((m) => !m.bye);
  r = await api(S(simReal, evFuture, "/knockout-result"), { method: "PUT", jar: mgr.jar, body: { roundIndex: 0, matchId: m0.id, scoreA: 3, scoreB: 1 } });
  ok(r.status === 200, "a match can be played by hand in the simulation", r.json);
  r = await api(S(sim1, evToday), { jar: mgr.jar });
  ok(r.status === 404, "simulation URL with another event id -> 404", r.json);
  r = await api(S(sim1, evFuture), { jar: other.jar });
  ok(r.status === 403, "other manager can't open this simulation", r.json);
  r = await api(`/api/sim/${sim1}/admin/tournaments/${evFuture}/not-a-route`, { jar: mgr.jar });
  ok(r.status === 404, "unknown sub-route is not reachable through a simulation", r.status);

  section("What-if comparison");
  r = await api(`/api/sim/${sim1}/whatif`, { method: "POST", jar: mgr.jar, body: { scenarios: [{ label: "2 courts" }, { label: "4 courts", courts: 4 }, { label: "30 players", players: 30, courts: 4 }, { label: "bad", courts: 0 }] } });
  ok(r.status === 200 && r.json.results.length === 4, "what-if returns every scenario", r.json);
  const w = r.json.results;
  ok(w[0].finishTime === finishPlanned, "same settings give the same finish time as the real schedule (" + w[0].finishTime + ")", { w0: w[0], finishPlanned });
  ok(w[1].durationMinutes < w[0].durationMinutes, "more courts finish sooner", w);
  ok(w[2].players === 30 && w[2].totalMatches === 29, "players can be changed (30 players -> 29 matches)", w[2]);
  ok(w[3].error, "invalid scenario reports its own error", w[3]);
  ok(w[0].fitsAvailableHours === true, "available-hours check", w[0]);

  section("Groups, Swiss, league-with-finals simulations");
  r = await api("/api/sim", { method: "POST", jar: mgr.jar, body: { eventId: evToday, mode: "dummy", playerCount: 12 } });
  const simG = r.json.simulation.id;
  r = await api(S(simG, evToday), { method: "POST", jar: mgr.jar, body: { mode: "individual", format: "groups", numGroups: 3, advancePerGroup: 2, courts: 3, matchMinutes: 15, startTime: "09:00" } });
  ok(r.status === 201, "groups tournament in sim", r.json);
  r = await api(`/api/sim/${simG}/autoplay`, { method: "POST", jar: mgr.jar, body: { until: "draw" } });
  ok(r.status === 200 && r.json.tournament.groups.length === 3 && r.json.tournament.status === "groups", "draw only", r.json);
  r = await api(`/api/sim/${simG}/autoplay`, { method: "POST", jar: mgr.jar, body: { until: "stage" } });
  ok(r.status === 200 && r.json.tournament.groups.every((g) => g.matches.every((m) => m.result)) && !r.json.tournament.knockout, "group stage played, knockout not drawn yet", r.json.steps);
  r = await api(`/api/sim/${simG}/autoplay`, { method: "POST", jar: mgr.jar, body: { until: "end" } });
  ok(r.status === 200 && r.json.tournament.status === "completed", "group + knockout completed", r.json.tournament && r.json.tournament.status);
  r = await api(`/api/sim/${simG}/whatif`, { method: "POST", jar: mgr.jar, body: { scenarios: [{ label: "now" }, { label: "start 14:00", startTime: "14:00" }] } });
  ok(r.json.results[1].finishTime !== r.json.results[0].finishTime && r.json.results[0].totalMatches === 3 * 6 + 5, "groups what-if (18 group matches + 5 knockout)", r.json.results);
  // real tournament on the event day is still empty
  r = await api(`/api/admin/tournaments/${evToday}`, { jar: mgr.jar });
  ok(r.json.tournament === null, "real tournament of the event day still empty after the simulation", r.json);

  r = await api("/api/sim", { method: "POST", jar: mgr.jar, body: { eventId: evToday, mode: "dummy", playerCount: 21 } });
  const simW = r.json.simulation.id;
  await api(S(simW, evToday), { method: "POST", jar: mgr.jar, body: { mode: "individual", format: "swiss", swissRounds: 5, courts: 10, matchMinutes: 30, startTime: "10:00" } });
  r = await api(`/api/sim/${simW}/autoplay`, { method: "POST", jar: mgr.jar, body: { until: "stage" } });
  ok(r.status === 200 && r.json.tournament.swiss.rounds.length === 1 && r.json.tournament.status === "swiss", "swiss: one round", r.json.steps);
  r = await api(`/api/sim/${simW}/autoplay`, { method: "POST", jar: mgr.jar, body: { until: "end" } });
  ok(r.status === 200 && r.json.tournament.status === "completed" && r.json.tournament.swiss.rounds.length === 5, "swiss: all 5 rounds", r.json.steps);
  r = await api(`/api/sim/${simW}/whatif`, { method: "POST", jar: mgr.jar, body: { scenarios: [{ courts: 10 }, { courts: 5 }] } });
  ok(r.json.results[1].durationMinutes > r.json.results[0].durationMinutes, "swiss what-if: fewer boards take longer", r.json.results);

  r = await api("/api/sim", { method: "POST", jar: mgr.jar, body: { eventId: evToday, mode: "dummy", playerCount: 8 } });
  const simT = r.json.simulation.id;
  await api(S(simT, evToday), { method: "POST", jar: mgr.jar, body: { mode: "individual", format: "groups", finalsMode: "table", courts: 2, matchMinutes: 10, startTime: "09:00" } });
  r = await api(`/api/sim/${simT}/autoplay`, { method: "POST", jar: mgr.jar, body: { until: "end" } });
  ok(r.status === 200 && r.json.tournament.status === "completed" && r.json.tournament.standings.length === 4, "league with finals from the table", r.json);

  section("Copy of the real set-up, team mode, restart, delete, limits");
  r = await api(`/api/admin/tournaments/${evToday}`, { method: "POST", jar: mgr.jar, body: { mode: "team", format: "knockout", courts: 2, matchMinutes: 25, startTime: "11:30" } });
  ok(r.status === 201, "manager creates the real tournament on the event day", r.json);
  r = await api("/api/sim", { method: "POST", jar: mgr.jar, body: { eventId: evToday, mode: "dummy", playerCount: 12, teamSize: 3, name: "copy" } });
  const simC = r.json.simulation.id;
  ok(r.json.simulation.tournament && r.json.simulation.tournament.mode === "team" && r.json.simulation.tournament.status === "seeding", "set-up copied from the real tournament", r.json);
  r = await api(S(simC, evToday), { jar: mgr.jar });
  ok(r.json.tournament.teams.length === 4 && r.json.tournament.schedule.matchMinutes === 25 && r.json.tournament.schedule.startTime === "11:30", "teams of 3 formed, schedule copied", r.json.tournament && r.json.tournament.teams);
  r = await api(`/api/sim/${simC}/autoplay`, { method: "POST", jar: mgr.jar, body: { until: "end" } });
  ok(r.status === 200 && r.json.tournament.status === "completed", "team simulation played", r.json);
  r = await api(`/api/admin/tournaments/${evToday}`, { jar: mgr.jar });
  ok(r.json.tournament.status === "team-setup" && r.json.tournament.teams.length === 0, "the real tournament was not changed by the copy", r.json.tournament);
  r = await api(`/api/sim/${simC}/restart`, { method: "POST", jar: mgr.jar });
  ok(r.status === 200 && r.json.simulation.tournament.status === "seeding", "restart gives a fresh, unplayed simulation", r.json);
  r = await api(`/api/sim/${simC}`, { method: "DELETE", jar: other.jar });
  ok(r.status === 403, "other manager can't delete it");
  r = await api(`/api/sim/${simC}`, { method: "DELETE", jar: mgr.jar });
  ok(r.status === 200, "delete simulation");
  r = await api(S(simC, evToday), { jar: mgr.jar });
  ok(r.status === 404, "deleted simulation is gone", r.status);
  let last;
  for (let i = 0; i < 7; i++) last = await api("/api/sim", { method: "POST", jar: admin, body: { eventId: evOther, mode: "dummy", playerCount: 4 } });
  ok(last.status === 400 && last.json.code === "sim_limit", "at most 6 simulations per event", last.json);
  r = await api("/api/sim", { method: "POST", jar: admin, body: { eventId: evOther, mode: "dummy", playerCount: 1200 } });
  ok(r.status === 400, "limit reached before the size check passes or size ok", r.json);

  section("Big simulation");
  r = await api("/api/sim", { method: "POST", jar: admin, body: { eventId: evFuture, mode: "dummy", playerCount: 1000 } });
  ok(r.status === 201, "1000 dummy players", r.json);
  const simBig = r.json.simulation.id;
  await api(S(simBig, evFuture), { method: "POST", jar: admin, body: { mode: "individual", format: "knockout", courts: 20, matchMinutes: 15, startTime: "08:00" } });
  const t0 = Date.now();
  r = await api(`/api/sim/${simBig}/autoplay`, { method: "POST", jar: admin, body: { until: "end" } });
  ok(r.status === 200 && r.json.played === 999 && r.json.tournament.status === "completed", "999 matches auto-played in " + (Date.now() - t0) + " ms", r.json && r.json.played);

  ok(serverErrors.length === 0, "no 5xx errors", serverErrors);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
