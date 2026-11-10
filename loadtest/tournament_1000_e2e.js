// 1000-player tournament E2E (real HTTP API, throwaway server - never production).
//
// Signs up N members once, then for each selected format creates an event,
// registers ALL N players through the member endpoint, builds the tournament
// through the staff API, plays every match, and verifies counts, brackets,
// standings, points and the public view.
//
// Usage (fresh server first, e.g. PORT=3946 with e2eadmin credentials):
//   BASE_URL=http://localhost:3946 node loadtest/tournament_1000_e2e.js
//
// Env:
//   N=1000                 players (members) to sign up
//   FORMATS=knockout,groups,swiss,teamgroups,casual,league   (default: all)
//   SWISS_ROUNDS=7         Swiss rounds
//   TEAM_SIZE=5            players per team for "teamgroups"
//   LEAGUE_TEAMS=16        clubs in the "league" (rosters of N/LEAGUE_TEAMS)
//   EXTRA=5                extra members that join the waiting list in "knockout"
//   CONCURRENCY=100        parallel requests
//   SIGNUP_CONCURRENCY=60  parallel sign-ups (password hashing is CPU-heavy)
//   ADMIN_USER / ADMIN_PASS
//   REPORT=path.json       write a timing report
"use strict";

const BASE = process.env.BASE_URL || "http://localhost:3946";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
const N = Number(process.env.N || 1000);
const EXTRA = Number(process.env.EXTRA || 5);
const CONCURRENCY = Number(process.env.CONCURRENCY || 100);
const SIGNUP_CONCURRENCY = Number(process.env.SIGNUP_CONCURRENCY || 60);
const SWISS_ROUNDS = Number(process.env.SWISS_ROUNDS || 7);
const TEAM_SIZE = Number(process.env.TEAM_SIZE || 5);
const LEAGUE_TEAMS = Number(process.env.LEAGUE_TEAMS || 16);
const ALL_FORMATS = ["knockout", "groups", "swiss", "teamgroups", "casual", "league"];
const FORMATS = (process.env.FORMATS || ALL_FORMATS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const RUN_ID = Date.now().toString(36).slice(-5).toUpperCase();

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; return true; }
  fail++;
  const line = `  FAIL: ${label}${extra !== undefined ? " " + JSON.stringify(extra).slice(0, 300) : ""}`;
  if (failures.length < 200) console.log(line);
  failures.push(label);
  return false;
}
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`;
const log = (...a) => console.log(stamp(), ...a);
function section(t) { console.log(`\n${stamp()} === ${t} ===`); }

const timings = [];
async function timed(name, fn) {
  const s = Date.now();
  const out = await fn();
  const ms = Date.now() - s;
  timings.push({ name, seconds: +(ms / 1000).toFixed(2) });
  log(`${name}: ${(ms / 1000).toFixed(1)}s`);
  return out;
}

// deterministic PRNG so a failing run can be reproduced
let seed = 20261109;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

// ---- HTTP harness (never throws; retries a network error once) -------------
const newJar = () => ({});
function applySetCookies(jar, res) {
  const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const raw of sc) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
async function api(path, { method = "GET", body, jar, isForm = false } = {}) {
  jar = jar || newJar();
  const headers = {};
  if (Object.keys(jar).length) headers.Cookie = cookieHeader(jar);
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && jar.csrfToken) headers["X-CSRF-Token"] = jar.csrfToken;
  let fb;
  if (body !== undefined) {
    if (isForm) fb = body;
    else { headers["Content-Type"] = "application/json"; fb = JSON.stringify(body); }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(BASE + path, { method, headers, body: fb, redirect: "manual" });
      applySetCookies(jar, res);
      let json = null;
      try { json = await res.json(); } catch (e) { /* non-JSON */ }
      return { status: res.status, json, jar };
    } catch (e) {
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 50 + Math.random() * 100)); continue; }
      return { status: 0, json: { networkError: String(e && e.message || e) }, jar };
    }
  }
}
const prime = async () => { const jar = newJar(); await api("/api/settings", { jar }); return jar; };

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = await worker(items[i], i); }
      catch (e) { results[i] = { error: String(e && e.message || e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

// ---- shared state ------------------------------------------------------------
let admin;
const members = []; // { mn, jar }
const extraMembers = [];
const memberByMn = new Map();

async function createEvent(name, sport, capacity) {
  const form = new FormData();
  form.set("nameEn", `${name} ${RUN_ID}`);
  form.set("nameAr", `${name} ${RUN_ID}`);
  form.set("sport", sport);
  form.set("date", "2026-12-05");
  if (capacity) form.set("maxCapacity", String(capacity));
  const r = await api("/api/events", { method: "POST", jar: admin, body: form, isForm: true });
  if (r.status !== 201 && r.status !== 200) throw new Error("event create failed " + JSON.stringify(r.json));
  return r.json.id;
}

// Every member registers themselves. Returns [{ member, regId }] (confirmed only).
async function registerAll(eventId, list) {
  const out = [];
  let failed = 0;
  await pool(list, CONCURRENCY, async (m) => {
    const r = await api("/api/register", { method: "POST", jar: m.jar, body: { eventId } });
    if (r.status === 201 && r.json && r.json.registration && !r.json.waitlisted) out.push({ member: m, regId: r.json.registration.id });
    else { failed++; if (failed <= 3) console.log("  register problem:", r.status, JSON.stringify(r.json).slice(0, 200)); }
  });
  return { regs: out, failed };
}

const adminGet = (eventId) => api(`/api/admin/tournaments/${eventId}`, { jar: admin });
const adminTn = async (eventId) => (await adminGet(eventId)).json.tournament;
const tpath = (eventId, suffix) => `/api/admin/tournaments/${eventId}${suffix}`;

async function createTournament(eventId, body) {
  const r = await api(tpath(eventId, ""), { method: "POST", jar: admin, body });
  ok(r.status === 201, `create tournament ${JSON.stringify(body)}`, r.json);
  return r.json && r.json.tournament;
}

// Public pages must work and must not leak private data at this size.
async function checkPublic(eventId, label, expectFormat) {
  const s = Date.now();
  const r = await api(`/api/tournaments/${eventId}`);
  ok(r.status === 200 && r.json.tournament, `${label}: public view loads`, r.status);
  ok(r.json && r.json.tournament && r.json.tournament.format === expectFormat, `${label}: public format`, r.json && r.json.tournament && r.json.tournament.format);
  const text = JSON.stringify(r.json);
  ok(!text.includes("LT1K-"), `${label}: no membership numbers leaked publicly`);
  ok(!text.includes("01000000") && !/"phone"/.test(text), `${label}: no phone numbers leaked publicly`);
  log(`${label}: public view ${(text.length / 1024).toFixed(0)} KB in ${Date.now() - s} ms`);
  const list = await api("/api/tournaments");
  ok(list.status === 200 && list.json.some((x) => x.eventId === eventId), `${label}: listed in /api/tournaments`);
}

// Positions are written by award-points; verify through the member's own view.
async function checkPositions(regsByEntrant, standings, label, sample = 3) {
  // standings: [{entrantId, rank}] ; regsByEntrant: entrantId -> [{member, regId}]
  let checked = 0;
  for (const s of standings.slice(0, sample)) {
    const rows = regsByEntrant.get(s.entrantId) || [];
    if (!rows.length) continue;
    const row = rows[0];
    const r = await api("/api/me/registrations", { jar: row.member.jar });
    const mine = Array.isArray(r.json) ? r.json.find((x) => x.id === row.regId) : null;
    ok(mine && mine.position === s.rank, `${label}: rank ${s.rank} reflected on the member's registration`, mine && mine.position);
    checked++;
  }
  ok(checked > 0, `${label}: at least one position verified`);
}

// Plays a knockout bracket round by round; returns count of matches played.
async function playKnockout(eventId, label, scoreFn) {
  let tn = await adminTn(eventId);
  const rounds = tn.knockout.rounds.length;
  let played = 0, failed = 0;
  for (let ri = 0; ri < rounds; ri++) {
    tn = await adminTn(eventId);
    const playable = tn.knockout.rounds[ri].filter((m) => !m.bye && !m.winnerId && m.a && m.b);
    await pool(playable, CONCURRENCY, async (m) => {
      const [sa, sb] = scoreFn(m.a, m.b);
      const r = await api(tpath(eventId, "/knockout-result"), { method: "PUT", jar: admin, body: { roundIndex: ri, matchId: m.id, scoreA: sa, scoreB: sb } });
      if (r.status === 200) played++; else { failed++; if (failed <= 3) console.log("  knockout result failed", r.status, JSON.stringify(r.json).slice(0, 200)); }
    });
    log(`  ${label} round ${ri + 1}/${rounds}: ${playable.length} matches`);
  }
  ok(failed === 0, `${label}: every knockout result accepted`, failed);
  return played;
}

async function playGroups(eventId, label, scoreFn) {
  const tn = await adminTn(eventId);
  const matches = tn.groups.flatMap((g) => g.matches.map((m) => ({ id: m.id, a: m.a, b: m.b })));
  let failed = 0;
  const results = new Map();
  await pool(matches, CONCURRENCY, async (m) => {
    const [sa, sb] = scoreFn(m.a, m.b, true);
    const r = await api(tpath(eventId, "/group-result"), { method: "PUT", jar: admin, body: { matchId: m.id, scoreA: sa, scoreB: sb } });
    if (r.status === 200) results.set(m.id, [sa, sb]); else { failed++; if (failed <= 3) console.log("  group result failed", r.status, JSON.stringify(r.json).slice(0, 200)); }
  });
  ok(failed === 0, `${label}: every group result accepted (${matches.length})`, failed);
  return { matches, results };
}

// A hidden "strength" per entrant makes results realistic and lets us check
// that the champion is among the strongest, not just that something finished.
function makeStrength() {
  const strength = new Map();
  const of = (id) => { if (!strength.has(id)) strength.set(id, rnd()); return strength.get(id); };
  const score = (a, b, allowDraw) => {
    const d = of(a) - of(b) + (rnd() - 0.5) * 0.5;
    let sa = Math.floor(rnd() * 3 + (d > 0 ? 1 : 0));
    let sb = Math.floor(rnd() * 3 + (d < 0 ? 1 : 0));
    if (!allowDraw && sa === sb) { if (d >= 0) sa++; else sb++; }
    return [sa, sb];
  };
  return { of, score };
}

function ceilLog2(n) { let r = 0; while ((1 << r) < n) r++; return r; }

// ---- scenarios ---------------------------------------------------------------

async function scenarioKnockout() {
  section(`KNOCKOUT - ${N} players, single elimination (+${EXTRA} on the waiting list)`);
  const eventId = await createEvent("E2E Knockout", "PlayStation", N);
  const { regs, failed } = await timed("knockout: register all", () => registerAll(eventId, members));
  ok(regs.length === N && failed === 0, `knockout: all ${N} registered`, { registered: regs.length, failed });

  // capacity: the extras are offered the waiting list, then join it
  if (EXTRA > 0) {
    let offered = 0, waitlisted = 0;
    for (const m of extraMembers) {
      const r1 = await api("/api/register", { method: "POST", jar: m.jar, body: { eventId } });
      if (r1.status === 200 && r1.json.needsWaitlistConfirmation) offered++;
      const r2 = await api("/api/register", { method: "POST", jar: m.jar, body: { eventId, joinWaitlist: true } });
      if (r2.status === 201 && r2.json.waitlisted === true) waitlisted++;
    }
    ok(offered === extraMembers.length, "knockout: full event offers the waiting list", offered);
    ok(waitlisted === extraMembers.length, "knockout: extras joined the waiting list", waitlisted);
  }
  // double registration is refused
  const dup = await api("/api/register", { method: "POST", jar: members[0].jar, body: { eventId } });
  ok(dup.status >= 400 && dup.status < 500, "knockout: duplicate registration refused", dup.status);

  await createTournament(eventId, { mode: "individual", format: "knockout" });
  let g = await api(tpath(eventId, "/generate"), { method: "POST", jar: admin });
  ok(g.status === 200, "knockout: generate", g.json);
  let tn = g.json.tournament;
  ok(tn.entrants.length === N, `knockout: ${N} entrants (waitlist excluded)`, tn.entrants.length);
  const rounds = tn.knockout.rounds.length;
  ok(rounds === ceilLog2(N), `knockout: ${ceilLog2(N)} rounds`, rounds);
  const size = 1 << ceilLog2(N);
  ok(tn.knockout.rounds[0].length === size / 2, "knockout: first round has a full bracket", tn.knockout.rounds[0].length);
  ok(tn.knockout.rounds[0].filter((m) => m.bye).length === size - N, `knockout: ${size - N} byes`, tn.knockout.rounds[0].filter((m) => m.bye).length);
  const ids = new Set();
  tn.knockout.rounds[0].forEach((m) => { if (m.a) ids.add(m.a); if (m.b) ids.add(m.b); });
  ok(ids.size === N, "knockout: every player placed exactly once", ids.size);
  const g2 = await api(tpath(eventId, "/generate"), { method: "POST", jar: admin });
  ok(g2.status === 400, "knockout: cannot generate twice");

  const st = makeStrength();
  const played = await timed("knockout: play bracket", () => playKnockout(eventId, "knockout", (a, b) => st.score(a, b, false)));
  ok(played === N - 1, `knockout: ${N - 1} matches played in total`, played);

  tn = await adminTn(eventId);
  ok(tn.status === "completed", "knockout: completed", tn.status);
  ok(tn.knockout.rounds.flat().every((m) => m.bye || m.winnerId), "knockout: no undecided match");
  ok(tn.standings && tn.standings[0].rank === 1 && tn.standings.length >= 3, "knockout: podium recorded", tn.standings && tn.standings.length);
  const finalMatch = tn.knockout.rounds[rounds - 1][0];
  ok(tn.standings[0].entrantId === finalMatch.winnerId, "knockout: champion is the final's winner");
  // everyone who won a match must have lost only once: exactly one champion
  const winners = new Map();
  tn.knockout.rounds.flat().forEach((m) => { if (m.winnerId && !m.bye) winners.set(m.winnerId, (winners.get(m.winnerId) || 0) + 1); });
  ok(winners.get(finalMatch.winnerId) >= rounds - 1, "knockout: champion won every round it played", winners.get(finalMatch.winnerId));

  const regOf = new Map(tn.entrants.map((e) => [e.id, e.registrationIds.map((id) => regs.find((x) => x.regId === id)).filter(Boolean)]));
  const aw = await timed("knockout: award points", () => api(tpath(eventId, "/award-points"), { method: "POST", jar: admin }));
  ok(aw.status === 200 && aw.json.updated >= 3, "knockout: points awarded to the podium", aw.json);
  await checkPositions(regOf, tn.standings, "knockout");
  await checkPublic(eventId, "knockout", "knockout");
  return { eventId, regs };
}

async function scenarioGroups() {
  const numGroups = Math.floor(N / 4);
  section(`GROUPS + KNOCKOUT - ${N} players, ${numGroups} groups of ~4, top 2 advance`);
  const eventId = await createEvent("E2E Groups", "Table Tennis");
  const { regs, failed } = await timed("groups: register all", () => registerAll(eventId, members));
  ok(regs.length === N && failed === 0, `groups: all ${N} registered`, { registered: regs.length, failed });
  await createTournament(eventId, { mode: "individual", format: "groups", numGroups, advancePerGroup: 2 });
  const g = await api(tpath(eventId, "/generate"), { method: "POST", jar: admin });
  ok(g.status === 200, "groups: generate", g.json);
  let tn = g.json.tournament;
  ok(tn.groups.length === numGroups, `groups: ${numGroups} groups`, tn.groups.length);
  const seen = new Set();
  tn.groups.forEach((gr) => gr.entrantIds.forEach((id) => seen.add(id)));
  ok(seen.size === N, "groups: every player in exactly one group", seen.size);
  const sizes = tn.groups.map((gr) => gr.entrantIds.length);
  ok(Math.max(...sizes) - Math.min(...sizes) <= 1, "groups: balanced group sizes", [Math.min(...sizes), Math.max(...sizes)]);
  const expectMatches = sizes.reduce((s, n) => s + (n * (n - 1)) / 2, 0);
  const totalMatches = tn.groups.reduce((s, gr) => s + gr.matches.length, 0);
  ok(totalMatches === expectMatches, `groups: ${expectMatches} round-robin matches`, totalMatches);
  const kEarly = await api(tpath(eventId, "/generate-knockout"), { method: "POST", jar: admin });
  ok(kEarly.status === 400, "groups: knockout refused before the group stage is finished", kEarly.status);

  const st = makeStrength();
  const gp = await timed("groups: play group stage", () => playGroups(eventId, "groups", st.score));
  ok(gp.results.size === expectMatches, "groups: all group matches recorded", gp.results.size);
  tn = await adminTn(eventId);
  const pts = tn.groups.reduce((s, gr) => s + gr.standings.reduce((x, r) => x + r.points, 0), 0);
  ok(pts > 0 && tn.groups.every((gr) => gr.standings.every((r) => r.played === gr.entrantIds.length - 1)), "groups: every player played everyone in their group");
  // standings sorted by points inside each group
  ok(tn.groups.every((gr) => gr.standings.every((r, i) => i === 0 || gr.standings[i - 1].points >= r.points)), "groups: tables sorted by points");

  const ko = await timed("groups: draw knockout", () => api(tpath(eventId, "/generate-knockout"), { method: "POST", jar: admin }));
  ok(ko.status === 200, "groups: knockout generated", ko.json);
  tn = ko.json.tournament;
  const qualified = new Set();
  tn.knockout.rounds[0].forEach((m) => { if (m.a) qualified.add(m.a); if (m.b) qualified.add(m.b); });
  ok(qualified.size === numGroups * 2, `groups: ${numGroups * 2} qualifiers in the bracket`, qualified.size);
  const top2 = new Set();
  tn.groups.forEach((gr) => gr.standings.slice(0, 2).forEach((r) => top2.add(r.entrantId)));
  ok([...top2].every((id) => qualified.has(id)), "groups: qualifiers are exactly the top 2 of each group");
  // nobody meets a group mate in round 1 (where avoidable)
  const groupOf = new Map();
  tn.groups.forEach((gr, i) => gr.entrantIds.forEach((id) => groupOf.set(id, i)));
  const sameGroup = tn.knockout.rounds[0].filter((m) => m.a && m.b && groupOf.get(m.a) === groupOf.get(m.b)).length;
  ok(sameGroup === 0, "groups: no same-group clash in round 1", sameGroup);

  await timed("groups: play knockout", () => playKnockout(eventId, "groups-ko", (a, b) => st.score(a, b, false)));
  tn = await adminTn(eventId);
  ok(tn.status === "completed" && tn.standings && tn.standings[0].rank === 1, "groups: completed with a champion", tn.status);
  const regOf = new Map(tn.entrants.map((e) => [e.id, e.registrationIds.map((id) => regs.find((x) => x.regId === id)).filter(Boolean)]));
  const aw = await api(tpath(eventId, "/award-points"), { method: "POST", jar: admin });
  ok(aw.status === 200 && aw.json.updated >= 3, "groups: points awarded", aw.json);
  await checkPositions(regOf, tn.standings, "groups");
  await checkPublic(eventId, "groups", "groups");
}

async function scenarioSwiss() {
  section(`SWISS - ${N} players, ${SWISS_ROUNDS} rounds`);
  const eventId = await createEvent("E2E Swiss Chess", "Chess");
  await createTournament(eventId, { mode: "individual", format: "swiss", swissRounds: SWISS_ROUNDS, courts: 250, matchMinutes: 25, startTime: "10:00", breakMinutes: 5 });
  const { regs, failed } = await timed("swiss: register all", () => registerAll(eventId, members));
  ok(regs.length === N && failed === 0, `swiss: all ${N} registered`, { registered: regs.length, failed });
  // some players declare the women / junior rankings (staff corrects through the API)
  const womenIdx = new Set(), juniorIdx = new Set();
  for (let i = 0; i < regs.length; i += 5) womenIdx.add(i);
  for (let i = 2; i < regs.length; i += 7) juniorIdx.add(i);
  await pool([...new Set([...womenIdx, ...juniorIdx])], CONCURRENCY, async (i) => {
    const r = await api(tpath(eventId, "/categories"), { method: "PUT", jar: admin, body: { registrationId: regs[i].regId, women: womenIdx.has(i), junior: juniorIdx.has(i) } });
    if (r.status !== 200) ok(false, "swiss: set categories", r.json);
  });

  let g = await timed("swiss: draw round 1", () => api(tpath(eventId, "/generate"), { method: "POST", jar: admin }));
  ok(g.status === 200, "swiss: generate round 1", g.json);
  let tn = g.json.tournament;
  ok(tn.entrants.length === N, "swiss: all entrants in the draw", tn.entrants.length);
  const st = makeStrength();
  const seenPairs = new Set();
  let withdrew = null;
  for (let round = 1; round <= SWISS_ROUNDS; round++) {
    const rd = tn.swiss.rounds[round - 1];
    ok(rd && rd.number === round, `swiss: round ${round} drawn`);
    const inRound = new Set();
    let dup = 0, rematch = 0;
    for (const p of rd.pairings) {
      if (inRound.has(p.a)) dup++; inRound.add(p.a);
      if (p.b != null) {
        if (inRound.has(p.b)) dup++; inRound.add(p.b);
        const key = [p.a, p.b].sort().join("|");
        if (seenPairs.has(key)) rematch++;
        seenPairs.add(key);
      }
    }
    ok(dup === 0, `swiss: round ${round} nobody paired twice`, dup);
    ok(rematch === 0, `swiss: round ${round} no rematches`, rematch);
    const expectActive = N - (withdrew && round >= 3 ? 1 : 0);
    ok(inRound.size === expectActive, `swiss: round ${round} pairs all ${expectActive} active players`, inRound.size);
    ok(rd.pairings.filter((p) => p.b == null).length === expectActive % 2, `swiss: round ${round} bye count`, rd.pairings.filter((p) => p.b == null).length);
    let rfail = 0;
    const games = rd.pairings.filter((p) => p.b != null);
    await pool(games, CONCURRENCY, async (p) => {
      const d = st.of(p.a) - st.of(p.b) + (rnd() - 0.5) * 0.4;
      const result = Math.abs(d) < 0.06 ? "1/2-1/2" : d > 0 ? "1-0" : "0-1";
      const r = await api(tpath(eventId, "/swiss/result"), { method: "PUT", jar: admin, body: { roundNumber: round, pairingId: p.id, result } });
      if (r.status !== 200) { rfail++; if (rfail <= 3) console.log("  swiss result failed", r.status, JSON.stringify(r.json).slice(0, 200)); }
    });
    ok(rfail === 0, `swiss: round ${round} every result accepted (${games.length})`, rfail);
    log(`  swiss round ${round}/${SWISS_ROUNDS}: ${games.length} games`);
    tn = await adminTn(eventId);
    ok(tn.swiss.rounds[round - 1].complete === true, `swiss: round ${round} complete`);
    if (round === 2) {
      const victim = tn.swiss.standings[tn.swiss.standings.length - 1].entrantId;
      const w = await api(tpath(eventId, "/swiss/withdraw"), { method: "PUT", jar: admin, body: { entrantId: victim, withdrawn: true } });
      ok(w.status === 200, "swiss: withdraw a player", w.json);
      withdrew = victim;
    }
    if (round < SWISS_ROUNDS) {
      const nr = await api(tpath(eventId, "/swiss/next-round"), { method: "POST", jar: admin });
      ok(nr.status === 200, `swiss: draw round ${round + 1}`, nr.json);
      if (nr.status !== 200) break;
      tn = nr.json.tournament;
    }
  }
  tn = await adminTn(eventId);
  ok(tn.status === "completed" && tn.swiss.final === true, "swiss: completed", tn.status);
  const extra = await api(tpath(eventId, "/swiss/next-round"), { method: "POST", jar: admin });
  ok(extra.status === 400, "swiss: no round beyond the last");
  const stand = tn.swiss.standings;
  ok(stand.length === N, "swiss: standings list everyone", stand.length);
  ok(stand.every((x, i) => x.rank === i + 1), "swiss: ranks run 1..N");
  ok(stand.every((x, i) => i === 0 || stand[i - 1].points >= x.points), "swiss: sorted by points");
  const totalPts = stand.reduce((s, x) => s + x.points, 0);
  const totalGames = tn.swiss.rounds.reduce((s, rd) => s + rd.pairings.length, 0);
  ok(Math.abs(totalPts - totalGames) < 1e-9, `swiss: points conserved (${totalPts} = ${totalGames})`);
  const rk = tn.swiss.rankings;
  ok(rk.open.length >= 3 && rk.women.length >= 3 && rk.junior.length >= 3, "swiss: open / women / junior podiums", [rk.open.length, rk.women.length, rk.junior.length]);
  ok(rk.women.every((x) => stand.find((s) => s.entrantId === x.entrantId).women), "swiss: women's ranking only has women");
  ok(rk.junior.every((x) => stand.find((s) => s.entrantId === x.entrantId).junior), "swiss: junior ranking only has juniors");
  const wd = stand.find((x) => x.entrantId === withdrew);
  ok(wd && wd.withdrawn === true, "swiss: withdrawn player flagged but keeps their points");
  // top seeds by hidden strength should dominate the top of the table
  const top10 = stand.slice(0, 10).map((x) => st.of(x.entrantId));
  const avgTop = top10.reduce((s, x) => s + x, 0) / top10.length;
  ok(avgTop > 0.6, `swiss: strongest players finish near the top (avg strength ${avgTop.toFixed(2)})`, avgTop);
  const regOf = new Map(tn.entrants.map((e) => [e.id, e.registrationIds.map((id) => regs.find((x) => x.regId === id)).filter(Boolean)]));
  const aw = await api(tpath(eventId, "/award-points"), { method: "POST", jar: admin });
  ok(aw.status === 200 && aw.json.updated >= 3, "swiss: points awarded", aw.json);
  await checkPositions(regOf, tn.standings, "swiss");
  await checkPublic(eventId, "swiss", "swiss");
}

// Chunks registrations into teams
function chunkTeams(regs, teamCount) {
  const teams = Array.from({ length: teamCount }, () => []);
  regs.forEach((r, i) => teams[i % teamCount].push(r));
  return teams;
}

async function scenarioTeamGroups() {
  const teamCount = Math.floor(N / TEAM_SIZE);
  const numGroups = Math.max(2, Math.floor(teamCount / 4));
  section(`TEAM GROUPS + KNOCKOUT - ${teamCount} teams of ${TEAM_SIZE}, ${numGroups} groups`);
  const eventId = await createEvent("E2E Team Cup", "Football 5-a-side");
  const { regs, failed } = await timed("teamgroups: register all", () => registerAll(eventId, members));
  ok(regs.length === N && failed === 0, `teamgroups: all ${N} registered`, { registered: regs.length, failed });
  await createTournament(eventId, { mode: "team", format: "groups", numGroups, advancePerGroup: 2 });
  const teams = chunkTeams(regs, teamCount).map((rows, i) => ({ name: `Team ${String(i + 1).padStart(3, "0")}`, memberIds: rows.map((r) => r.regId) }));
  const badTeams = await api(tpath(eventId, "/teams"), { method: "PUT", jar: admin, body: { teams: [{ name: "A", memberIds: [regs[0].regId] }, { name: "B", memberIds: [regs[0].regId] }] } });
  ok(badTeams.status === 400, "teamgroups: a player cannot be in two teams", badTeams.status);
  const tr = await timed("teamgroups: save rosters", () => api(tpath(eventId, "/teams"), { method: "PUT", jar: admin, body: { teams } }));
  ok(tr.status === 200, "teamgroups: save teams", tr.json);
  let tn = tr.json.tournament;
  ok(tn.entrants.length === teamCount, `teamgroups: ${teamCount} entrants`, tn.entrants.length);
  const g = await api(tpath(eventId, "/generate"), { method: "POST", jar: admin });
  ok(g.status === 200, "teamgroups: generate", g.json);
  tn = g.json.tournament;
  ok(tn.groups.length === numGroups, `teamgroups: ${numGroups} groups`, tn.groups.length);
  const st = makeStrength();
  const gp = await timed("teamgroups: play group stage", () => playGroups(eventId, "teamgroups", st.score));
  const ko = await api(tpath(eventId, "/generate-knockout"), { method: "POST", jar: admin });
  ok(ko.status === 200, "teamgroups: knockout generated", ko.json);
  await timed("teamgroups: play knockout", () => playKnockout(eventId, "teamgroups-ko", (a, b) => st.score(a, b, false)));
  tn = await adminTn(eventId);
  ok(tn.status === "completed" && tn.standings && tn.standings[0].rank === 1, "teamgroups: completed", tn.status);
  ok(gp.results.size === gp.matches.length, "teamgroups: all group matches recorded");
  const regOf = new Map(tn.entrants.map((e) => [e.id, e.registrationIds.map((id) => regs.find((x) => x.regId === id)).filter(Boolean)]));
  const aw = await api(tpath(eventId, "/award-points"), { method: "POST", jar: admin });
  // every member of a ranked team gets that team's rank
  ok(aw.status === 200 && aw.json.updated >= 3 * TEAM_SIZE, `teamgroups: whole squads credited (${aw.json && aw.json.updated})`, aw.json);
  await checkPositions(regOf, tn.standings, "teamgroups");
  // the last member of the champion team also sees rank 1
  const champ = regOf.get(tn.standings[0].entrantId);
  const lastRow = champ[champ.length - 1];
  const mine = await api("/api/me/registrations", { jar: lastRow.member.jar });
  const mr = Array.isArray(mine.json) ? mine.json.find((x) => x.id === lastRow.regId) : null;
  ok(mr && mr.position === 1, "teamgroups: every squad member gets the team's rank", mr && mr.position);
  await checkPublic(eventId, "teamgroups", "groups");
}

async function scenarioCasual() {
  section(`CASUAL (fun session) - attendance for ${N} players`);
  const eventId = await createEvent("E2E Fun Day", "Padel");
  const { regs, failed } = await timed("casual: register all", () => registerAll(eventId, members));
  ok(regs.length === N && failed === 0, `casual: all ${N} registered`, { registered: regs.length, failed });
  const tn0 = await createTournament(eventId, { mode: "individual", format: "casual" });
  ok(tn0 && tn0.status === "casual", "casual: individual session starts straight away", tn0 && tn0.status);
  const gen = await api(tpath(eventId, "/generate"), { method: "POST", jar: admin });
  ok(gen.status === 400, "casual: no bracket to generate");
  let present = 0, absent = 0, failedAtt = 0;
  await timed("casual: mark attendance", () => pool(regs, CONCURRENCY, async (r, i) => {
    const status = i % 10 === 0 ? "absent" : "present";
    const res = await api(tpath(eventId, "/attendance"), { method: "PUT", jar: admin, body: { registrationId: r.regId, status } });
    if (res.status === 200) { if (status === "present") present++; else absent++; } else failedAtt++;
  }));
  ok(failedAtt === 0, "casual: every attendance mark accepted", failedAtt);
  const tn = await adminTn(eventId);
  const att = tn.attendance || [];
  ok(att.length === N, `casual: attendance list has all ${N}`, att.length);
  ok(att.filter((a) => a.status === "present").length === present, `casual: ${present} present`, att.filter((a) => a.status === "present").length);
  ok(att.filter((a) => a.status === "absent").length === absent, `casual: ${absent} absent`);
  const bad = await api(tpath(eventId, "/attendance"), { method: "PUT", jar: admin, body: { registrationId: 99999999, status: "present" } });
  ok(bad.status === 400, "casual: unknown registration refused");
  const end = await api(tpath(eventId, "/casual-status"), { method: "PUT", jar: admin, body: { status: "completed" } });
  ok(end.status === 200 && end.json.tournament.status === "completed", "casual: session ended", end.json);
  await checkPublic(eventId, "casual", "casual");
}

async function scenarioLeague() {
  const teamCount = LEAGUE_TEAMS;
  section(`LEAGUE WITH FINALS - ${teamCount} clubs, rosters of ~${Math.floor(N / teamCount)}, final + 3rd place, scorers and awards`);
  const eventId = await createEvent("E2E Club League", "Football");
  const { regs, failed } = await timed("league: register all", () => registerAll(eventId, members));
  ok(regs.length === N && failed === 0, `league: all ${N} registered`, { registered: regs.length, failed });
  await createTournament(eventId, { mode: "team", format: "groups", finalsMode: "table" });
  const teams = chunkTeams(regs, teamCount).map((rows, i) => ({ name: `Club ${String(i + 1).padStart(2, "0")}`, memberIds: rows.map((r) => r.regId) }));
  const tr = await api(tpath(eventId, "/teams"), { method: "PUT", jar: admin, body: { teams } });
  ok(tr.status === 200, "league: save rosters", tr.json);
  const g = await api(tpath(eventId, "/generate"), { method: "POST", jar: admin });
  ok(g.status === 200, "league: generate round robin", g.json);
  let tn = g.json.tournament;
  const expectMatches = (teamCount * (teamCount - 1)) / 2;
  ok(tn.groups.length === 1 && tn.groups[0].matches.length === expectMatches, `league: single table with ${expectMatches} matches`, tn.groups[0].matches.length);
  const entrantReg = new Map(tn.entrants.map((e) => [e.id, e.registrationIds]));

  const st = makeStrength();
  const goalsBy = new Map(); // regId -> goals we recorded
  let scorerFail = 0;
  const matches = tn.groups[0].matches.map((m) => ({ id: m.id, a: m.a, b: m.b }));
  await timed("league: play season + record scorers", () => pool(matches, CONCURRENCY, async (m) => {
    const [sa, sb] = st.score(m.a, m.b, true);
    const r = await api(tpath(eventId, "/group-result"), { method: "PUT", jar: admin, body: { matchId: m.id, scoreA: sa, scoreB: sb } });
    if (r.status !== 200) { ok(false, "league: result accepted", r.json); return; }
    const pick = (teamId, goals) => {
      const roster = entrantReg.get(teamId);
      const tally = new Map();
      for (let k = 0; k < goals; k++) { const id = roster[Math.floor(rnd() * roster.length)]; tally.set(id, (tally.get(id) || 0) + 1); }
      return tally;
    };
    const ta = pick(m.a, sa), tb = pick(m.b, sb);
    const scorers = [...ta, ...tb].map(([registrationId, goals]) => ({ registrationId, goals }));
    const rr = await api(tpath(eventId, "/match-scorers"), { method: "PUT", jar: admin, body: { matchId: m.id, scorers } });
    if (rr.status !== 200) { scorerFail++; return; }
    scorers.forEach((s) => goalsBy.set(s.registrationId, (goalsBy.get(s.registrationId) || 0) + s.goals));
  }));
  ok(scorerFail === 0, "league: every scorer sheet accepted", scorerFail);
  tn = await adminTn(eventId);
  ok(tn.groups[0].matches.every((m) => m.result), "league: every match has a result");
  ok(tn.groups[0].standings.every((r) => r.played === teamCount - 1), "league: every club played everybody");
  const early = await api(tpath(eventId, "/award-points"), { method: "POST", jar: admin });
  ok(early.status === 400, "league: points not awarded before the finals");

  const fin = await api(tpath(eventId, "/generate-knockout"), { method: "POST", jar: admin });
  ok(fin.status === 200, "league: finals drawn from the table", fin.json);
  tn = fin.json.tournament;
  ok(tn.knockout.rounds.length === 1 && tn.knockout.rounds[0].length === 2, "league: final + 3rd place only", tn.knockout.rounds.map((r) => r.length));
  const table = tn.groups[0].standings.map((r) => r.entrantId);
  const final = tn.knockout.rounds[0].find((m) => m.place === 1), third = tn.knockout.rounds[0].find((m) => m.place === 3);
  ok(final && [final.a, final.b].sort().join() === [table[0], table[1]].sort().join(), "league: final is 1st vs 2nd");
  ok(third && [third.a, third.b].sort().join() === [table[2], table[3]].sort().join(), "league: 3rd-place match is 3rd vs 4th");
  await playKnockout(eventId, "league", (a, b) => st.score(a, b, false));
  tn = await adminTn(eventId);
  ok(tn.status === "completed" && tn.standings.length === 4, "league: completed with four places", tn.standings && tn.standings.length);

  // awards
  const top = tn.awards.topScorers;
  const maxGoals = Math.max(...goalsBy.values());
  ok(top.length > 0 && top[0].goals === maxGoals, `league: top scorer has ${maxGoals} goals`, top[0] && top[0].goals);
  const sumGoals = top.reduce((s, x) => s + x.goals, 0);
  ok(sumGoals <= [...goalsBy.values()].reduce((s, x) => s + x, 0), "league: scorer totals never exceed recorded goals");
  const gk = regs[3].regId, best = top[0].registrationId;
  const aws = await api(tpath(eventId, "/awards"), { method: "PUT", jar: admin, body: { bestGoalkeeper: gk, bestPlayer: best, fairPlay: tn.entrants[0].id } });
  ok(aws.status === 200 && aws.json.tournament.awards.bestGoalkeeper && aws.json.tournament.awards.fairPlay, "league: awards saved", aws.json);
  const aw = await api(tpath(eventId, "/award-points"), { method: "POST", jar: admin });
  ok(aw.status === 200 && aw.json.updated >= Math.floor(N / teamCount) * 4 - 4, `league: four clubs' squads credited (${aw.json && aw.json.updated})`, aw.json);
  const regOf = new Map(tn.entrants.map((e) => [e.id, e.registrationIds.map((id) => regs.find((x) => x.regId === id)).filter(Boolean)]));
  await checkPositions(regOf, tn.standings, "league", 4);
  await checkPublic(eventId, "league", "groups");
}

// ---- main --------------------------------------------------------------------
(async () => {
  log(`BASE=${BASE} N=${N} FORMATS=${FORMATS.join(",")} CONCURRENCY=${CONCURRENCY}`);
  const unknown = FORMATS.filter((f) => !ALL_FORMATS.includes(f));
  if (unknown.length) { console.log("Unknown FORMATS:", unknown.join(","), "- valid:", ALL_FORMATS.join(",")); process.exit(2); }

  admin = await prime();
  const login = await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } });
  if (login.status !== 200) { console.log("admin login failed", login.status, login.json); process.exit(2); }

  section(`SIGN-UP - ${N} members${FORMATS.includes("knockout") && EXTRA ? ` (+${EXTRA} extra)` : ""}`);
  const total = N + (FORMATS.includes("knockout") ? EXTRA : 0);
  const ids = Array.from({ length: total }, (_, i) => i + 1);
  let signupFail = 0;
  await timed("sign up members", () => pool(ids, SIGNUP_CONCURRENCY, async (i) => {
    const jar = await prime();
    const mn = `LT1K-${RUN_ID}-${String(i).padStart(5, "0")}`;
    const r = await api("/api/auth/signup", {
      method: "POST", jar,
      body: { membershipNumber: mn, name: `Player ${i}`, password: "TestPass123!", memberType: "main", birthDate: "1990-06-15", phone: `010${String(1000000 + i).padStart(8, "0")}`, agreeTerms: true },
    });
    if (r.status !== 201) { signupFail++; if (signupFail <= 3) console.log("  signup problem:", r.status, JSON.stringify(r.json).slice(0, 200)); return; }
    const m = { mn, jar };
    (i <= N ? members : extraMembers).push(m);
    memberByMn.set(mn, m);
  }));
  ok(signupFail === 0 && members.length === N, `all ${N} members signed up`, { ok: members.length, failed: signupFail });
  if (members.length < 2) { console.log("Not enough members to continue"); process.exit(1); }
  const me = await api("/api/auth/me", { jar: members[0].jar });
  ok(me.status === 200, "a new member is logged in after sign-up", me.status);

  const scenarios = { knockout: scenarioKnockout, groups: scenarioGroups, swiss: scenarioSwiss, teamgroups: scenarioTeamGroups, casual: scenarioCasual, league: scenarioLeague };
  for (const f of FORMATS) {
    try { await scenarios[f](); }
    catch (e) { ok(false, `scenario ${f} crashed: ${e && e.stack || e}`); }
  }

  section("TIMINGS");
  timings.forEach((t) => console.log(`  ${t.name.padEnd(36)} ${String(t.seconds).padStart(8)} s`));
  const mem = process.memoryUsage();
  console.log(`\n${pass} passed, ${fail} failed  (total ${((Date.now() - t0) / 1000).toFixed(0)}s, client heap ${(mem.heapUsed / 1048576).toFixed(0)} MB)`);
  if (process.env.REPORT) {
    require("fs").writeFileSync(process.env.REPORT, JSON.stringify({ n: N, formats: FORMATS, pass, fail, seconds: +((Date.now() - t0) / 1000).toFixed(1), timings, failures: failures.slice(0, 50) }, null, 2));
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
