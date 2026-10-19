// Tournament MATRIX end-to-end suite: every tournament format (knockout,
// groups->knockout, casual, swiss) x both modes (individual / team) x many
// field sizes, each played to the very end through the real HTTP API, with
// independent oracles for the maths (byes, round-robin pair counts, standings
// order, Swiss pairing invariants, points conservation), plus setup
// operations (validation, seeding, reseed, schedule edits, attendance, late
// registrations, cancellations), role matrix, race conditions and public /
// print / report views. Any 5xx response anywhere is a failure.
//
// Usage: BASE_URL=http://localhost:3913 node tournaments_matrix_e2e.js
"use strict";

const BASE = process.env.BASE_URL || "http://localhost:3913";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
const POOL = Number(process.env.POOL || 70);

let pass = 0, fail = 0;
const failures = [];
const serverErrors = [];
const notes = [];
function ok(cond, label, extra) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
    console.log(`  FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : "");
  }
}
function note(s) { notes.push(s); console.log("  NOTE:", s); }
function section(t) { console.log(`\n=== ${t} ===`); }

// deterministic PRNG
let seed = 987654321;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

// ---- http client ---------------------------------------------------------
const newJar = () => ({});
function applySetCookies(jar, res) {
  const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const raw of sc) { const [pair] = raw.split(";"); const eq = pair.indexOf("="); if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); }
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
async function api(path, { method = "GET", body, jar, noCsrf = false, isForm = false, raw = false } = {}) {
  jar = jar || newJar();
  const headers = {};
  if (Object.keys(jar).length) headers.Cookie = cookieHeader(jar);
  if (!["GET", "HEAD"].includes(method) && jar.csrfToken && !noCsrf) headers["X-CSRF-Token"] = jar.csrfToken;
  let fb;
  if (body !== undefined) { if (isForm) fb = body; else { headers["Content-Type"] = "application/json"; fb = JSON.stringify(body); } }
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { res = await fetch(BASE + path, { method, headers, body: fb, redirect: "manual" }); break; }
    catch (e) { if (attempt === 2) return { status: 0, json: { networkError: String(e) }, jar }; await new Promise((r) => setTimeout(r, 80)); }
  }
  applySetCookies(jar, res);
  if (res.status >= 500) serverErrors.push(`${method} ${path} -> ${res.status}`);
  if (raw) { const text = await res.text(); return { status: res.status, text, type: res.headers.get("content-type") || "", jar }; }
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, jar };
}
const prime = async (jar) => { await api("/", { jar }); return jar; };

const admin = newJar();
const T = (eventId, suffix = "") => `/api/admin/tournaments/${eventId}${suffix}`;
const A = (path, method = "GET", body) => api(path, { method, jar: admin, body });

// ---- fixtures ------------------------------------------------------------
const pool = []; // {jar, num, regByEvent: {}}
let eventSeq = 0;
async function ensurePool(n) {
  while (pool.length < n) {
    const i = pool.length + 1;
    const jar = await prime(newJar());
    const r = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: `TM${i}`, name: `Matrix Player ${i}`, password: "abc12345", phone: `0105${String(i).padStart(7, "0")}`, agreeTerms: true, memberType: "main", ageGroup: "18to45" } });
    if (r.status !== 200 && r.status !== 201) throw new Error("signup failed " + JSON.stringify(r.json));
    pool.push({ jar, num: i, regByEvent: {} });
  }
}
async function mkEvent(label, sport) {
  const f = new FormData();
  const name = `${label} #${++eventSeq}`;
  f.set("nameEn", name); f.set("nameAr", name); f.set("sport", sport || "Chess"); f.set("date", "2026-12-15");
  const r = await api("/api/events", { method: "POST", jar: admin, body: f, isForm: true });
  if (r.status !== 200 && r.status !== 201) throw new Error("event create failed " + JSON.stringify(r.json));
  return r.json.id;
}
// registers pool members [from, from+n) and checks them in
async function enroll(eventId, n, { from = 0, women = () => false, junior = () => false, checkin = true } = {}) {
  await ensurePool(from + n);
  const regIds = [];
  for (let i = from; i < from + n; i++) {
    const p = pool[i];
    const body = { eventId };
    if (women(i)) body.women = true;
    if (junior(i)) body.junior = true;
    const r = await api("/api/register", { method: "POST", jar: p.jar, body });
    const id = r.json && ((r.json.registration && r.json.registration.id) || r.json.id);
    if (!(r.status === 200 || r.status === 201) || !id) { ok(false, `register pool member ${i}`, r.json); continue; }
    if (r.json.waitlisted || (r.json.registration && r.json.registration.waitlisted)) ok(false, "unexpected waitlist while enrolling", r.json);
    p.regByEvent[eventId] = id;
    regIds.push(id);
    if (checkin) await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: id } });
  }
  return regIds;
}
const create = (eventId, body) => A(T(eventId), "POST", body);
const nextPow2 = (n) => { let p = 1; while (p < n) p *= 2; return p; };
const C2 = (n) => (n * (n - 1)) / 2;
const mins = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const unique = (a) => new Set(a).size === a.length;

// ==========================================================================
// KNOCKOUT
// ==========================================================================
function knockoutStrategies(m, i) {
  // rotate through every way an admin can enter a knockout result
  switch (i % 6) {
    case 0: return { scoreA: 3, scoreB: 1 };
    case 1: return { scoreA: 0, scoreB: 2 };
    case 2: return { winnerId: m.a };
    case 3: return { winnerId: m.b };
    case 4: return { scoreA: 2, scoreB: 2, winnerId: m.b, note: "penalties" };
    default: return { scoreA: "", scoreB: "", winnerId: m.a };
  }
}
function expectedWinner(m, body) {
  if (body.scoreA !== undefined && body.scoreA !== "" && body.scoreB !== undefined && body.scoreB !== "" && body.scoreA !== body.scoreB) return body.scoreA > body.scoreB ? m.a : m.b;
  return body.winnerId;
}

async function playKnockoutFully(eventId, t, label, { expectEntrants, seeded = true }) {
  const N = expectEntrants;
  const size = nextPow2(N);
  const rounds = t.knockout.rounds;
  ok(rounds.length === Math.log2(size), `${label}: round count = log2(bracket)`, [rounds.length, size]);
  ok(rounds[0].length === size / 2, `${label}: round 0 has size/2 matches`);
  const slot0 = rounds[0].flatMap((m) => [m.a, m.b]).filter(Boolean);
  ok(slot0.length === N && unique(slot0), `${label}: every entrant appears exactly once in round 0`, [slot0.length, N]);
  ok(rounds[0].filter((m) => m.bye).length === size - N, `${label}: byes = bracket - entrants`);
  if (size - N > 0 && seeded) {
    const topSeed = t.seedOrder[0];
    ok(rounds[0].some((m) => m.bye && (m.a === topSeed || m.b === topSeed)), `${label}: top seed gets a bye`);
  }
  // schedule invariants
  if (t.schedule) {
    const real = rounds.flatMap((r) => r.filter((m) => !m.bye));
    ok(real.every((m) => m.court >= 1 && m.court <= t.schedule.courts && /^\d\d:\d\d$/.test(m.time || "")), `${label}: every real match has a court+time`);
    ok(unique(real.map((m) => `${m.court}@${m.time}`)), `${label}: no court double-booked`);
    for (let r = 1; r < rounds.length; r++) {
      const prev = rounds[r - 1].filter((m) => !m.bye).map((m) => mins(m.time));
      const cur = rounds[r].filter((m) => !m.bye).map((m) => mins(m.time));
      if (prev.length && cur.length) ok(Math.min(...cur) >= Math.max(...prev), `${label}: round ${r + 1} starts after round ${r} slots`);
    }
  }
  let played = 0, k = 0;
  let cur = t;
  for (let ri = 0; ri < rounds.length; ri++) {
    for (const m0 of cur.knockout.rounds[ri]) {
      if (m0.bye) continue;
      const m = cur.knockout.rounds[ri].find((x) => x.id === m0.id);
      ok(m.a && m.b, `${label}: round ${ri} match ${m.id} has both entrants before play`);
      const body = knockoutStrategies(m, k++);
      const r = await A(T(eventId, "/knockout-result"), "PUT", { roundIndex: ri, matchId: m.id, ...body });
      ok(r.status === 200, `${label}: result r${ri} m${m.id}`, r.json);
      if (r.status !== 200) return null;
      cur = r.json.tournament;
      played++;
      const mm = cur.knockout.rounds[ri].find((x) => x.id === m.id);
      ok(mm.winnerId === expectedWinner(m, body), `${label}: winner recorded as expected`, [mm.winnerId, expectedWinner(m, body)]);
      if (ri + 1 < rounds.length) {
        const idx = cur.knockout.rounds[ri].findIndex((x) => x.id === m.id);
        const next = cur.knockout.rounds[ri + 1][Math.floor(idx / 2)];
        ok((idx % 2 === 0 ? next.a : next.b) === mm.winnerId, `${label}: winner propagated to next round`);
      }
    }
  }
  ok(played === N - 1, `${label}: exactly N-1 real matches played`, [played, N - 1]);
  ok(cur.status === "completed", `${label}: completed`, cur.status);
  const final = cur.knockout.rounds[rounds.length - 1][0];
  ok(cur.standings && cur.standings[0].entrantId === final.winnerId && cur.standings[0].rank === 1, `${label}: champion ranked 1`);
  ok(cur.standings.length >= Math.min(N, 2), `${label}: standings has podium entries`, cur.standings.length);
  ok(cur.standings.every((s) => s.rank >= 1) && unique(cur.standings.map((s) => s.entrantId)), `${label}: standings ranks valid and unique entrants`);
  if (N >= 4) ok(cur.standings.filter((s) => s.rank === 3).length === 2, `${label}: two semi-final losers share rank 3`);
  return cur;
}

async function knockoutIndividual(N, withSchedule) {
  const label = `KO individual N=${N}${withSchedule ? " +schedule" : ""}`;
  const eventId = await mkEvent(`KO ${N}`, "Chess");
  const regIds = await enroll(eventId, N);
  const body = { mode: "individual", format: "knockout" };
  if (withSchedule) Object.assign(body, { courts: 3, matchMinutes: 10, startTime: "09:00", breakMinutes: 5 });
  let r = await create(eventId, body);
  ok(r.status === 201, `${label}: create`, r.json);
  r = await A(T(eventId, "/generate"), "POST");
  if (N < 2) { ok(r.status === 400, `${label}: generate rejected with <2 entrants`, r.json); return; }
  ok(r.status === 200, `${label}: generate`, r.json);
  if (r.status !== 200) return;
  const done = await playKnockoutFully(eventId, r.json.tournament, label, { expectEntrants: N });
  if (!done) return;
  // award points
  const aw = await A(T(eventId, "/award-points"), "POST");
  ok(aw.status === 200 && aw.json.updated >= Math.min(N, 2), `${label}: award points`, aw.json);
  const champ = done.standings[0].entrantId;
  const champReg = Number(champ.replace("reg", ""));
  const owner = pool.find((p) => p.regByEvent[eventId] === champReg);
  const mine = await api("/api/me/registrations", { jar: owner.jar });
  const row = (mine.json || []).find((x) => x.id === champReg);
  ok(row && row.position === 1, `${label}: champion's registration has position 1`, row && row.position);
  // public view
  const pub = await api(`/api/tournaments/${eventId}`);
  ok(pub.status === 200 && pub.json.tournament.status === "completed", `${label}: public view completed`);
  ok(!/membershipNumber|\"phone\"|0105\d{7}/.test(JSON.stringify(pub.json)), `${label}: public view leaks no membership number/phone`);
  return { eventId, done };
}

async function knockoutTeams(teamSizes) {
  const label = `KO teams ${teamSizes.join("/")}`;
  const total = teamSizes.reduce((a, b) => a + b, 0);
  const eventId = await mkEvent(`KO teams ${teamSizes.length}`, "Padel");
  const regIds = await enroll(eventId, total);
  let r = await create(eventId, { mode: "team", format: "knockout", courts: 2, matchMinutes: 20, startTime: "10:00" });
  ok(r.status === 201 && r.json.tournament.status === "team-setup", `${label}: create in team-setup`);
  r = await A(T(eventId, "/generate"), "POST");
  ok(r.status === 400, `${label}: generate before teams rejected`, r.json);
  let off = 0;
  const teams = teamSizes.map((sz, i) => { const t = { name: `Team ${i + 1}`, memberIds: regIds.slice(off, off + sz) }; off += sz; return t; });
  r = await A(T(eventId, "/teams"), "PUT", { teams });
  if (teamSizes.length < 2) { ok(r.status === 400, `${label}: <2 teams rejected`); return; }
  ok(r.status === 200 && r.json.tournament.teams.length === teamSizes.length, `${label}: teams saved`, r.json);
  r = await A(T(eventId, "/generate"), "POST");
  ok(r.status === 200, `${label}: generate`, r.json);
  const done = await playKnockoutFully(eventId, r.json.tournament, label, { expectEntrants: teamSizes.length });
  if (!done) return;
  const aw = await A(T(eventId, "/award-points"), "POST");
  const champTeam = done.teams.find((t) => t.id === done.standings[0].entrantId);
  ok(aw.status === 200 && aw.json.updated >= champTeam.memberIds.length, `${label}: award points`, aw.json);
  for (const regId of champTeam.memberIds) {
    const owner = pool.find((p) => p.regByEvent[eventId] === regId);
    const mine = await api("/api/me/registrations", { jar: owner.jar });
    const row = (mine.json || []).find((x) => x.id === regId);
    ok(row && row.position === 1, `${label}: every member of the winning team gets position 1`, row && row.position);
  }
}

// ==========================================================================
// GROUPS -> KNOCKOUT
// ==========================================================================
function oracleGroupOrder(group, seedOrder, pts) {
  const stat = {};
  group.entrantIds.forEach((id) => (stat[id] = { p: 0, gf: 0, ga: 0, w: 0, d: 0, l: 0, played: 0 }));
  for (const m of group.matches) {
    if (!m.result) continue;
    const { scoreA, scoreB } = m.result;
    stat[m.a].played++; stat[m.b].played++;
    stat[m.a].gf += scoreA; stat[m.a].ga += scoreB; stat[m.b].gf += scoreB; stat[m.b].ga += scoreA;
    if (scoreA === scoreB) { stat[m.a].p += pts.draw; stat[m.b].p += pts.draw; stat[m.a].d++; stat[m.b].d++; }
    else { const w = scoreA > scoreB ? m.a : m.b, l = w === m.a ? m.b : m.a; stat[w].p += pts.win; stat[l].p += pts.loss; stat[w].w++; stat[l].l++; }
  }
  const order = [...group.entrantIds].sort((a, b) => {
    const A_ = stat[a], B_ = stat[b];
    if (B_.p !== A_.p) return B_.p - A_.p;
    const ga = A_.gf - A_.ga, gb = B_.gf - B_.ga;
    if (gb !== ga) return gb - ga;
    if (B_.gf !== A_.gf) return B_.gf - A_.gf;
    return seedOrder.indexOf(a) - seedOrder.indexOf(b);
  });
  return { order, stat };
}

async function groupsRun({ N, numGroups, advance, mode = "individual", teamSizes, points, schedule }) {
  const label = `GROUPS ${mode} N=${mode === "team" ? teamSizes.length + " teams" : N} g=${numGroups} adv=${advance}${points ? " pts=" + points.join("/") : ""}`;
  const entrantsCount = mode === "team" ? teamSizes.length : N;
  const total = mode === "team" ? teamSizes.reduce((a, b) => a + b, 0) : N;
  const eventId = await mkEvent(`GR ${entrantsCount}`, "Padel");
  const regIds = await enroll(eventId, total);
  const body = { mode, format: "groups", numGroups, advancePerGroup: advance };
  if (points) Object.assign(body, { winPoints: points[0], drawPoints: points[1], lossPoints: points[2] });
  if (schedule) Object.assign(body, { courts: 4, matchMinutes: 15, startTime: "09:00", breakMinutes: 10 });
  let r = await create(eventId, body);
  ok(r.status === 201, `${label}: create`, r.json);
  if (mode === "team") {
    let off = 0;
    const teams = teamSizes.map((sz, i) => { const t = { name: `Squad ${i + 1}`, memberIds: regIds.slice(off, off + sz) }; off += sz; return t; });
    r = await A(T(eventId, "/teams"), "PUT", { teams });
    ok(r.status === 200, `${label}: teams saved`, r.json);
  }
  r = await A(T(eventId, "/generate"), "POST");
  if (entrantsCount < numGroups * 2) { ok(r.status === 400, `${label}: generate rejected - too few entrants for groups`, r.json); return; }
  ok(r.status === 200, `${label}: generate`, r.json);
  if (r.status !== 200) return;
  let t = r.json.tournament;
  const sizes = t.groups.map((g) => g.entrantIds.length);
  ok(sizes.reduce((a, b) => a + b, 0) === entrantsCount, `${label}: group sizes sum to entrants`);
  ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${label}: group sizes balanced`, sizes);
  ok(unique(t.groups.flatMap((g) => g.entrantIds)), `${label}: nobody in two groups`);
  for (const g of t.groups) {
    ok(g.matches.length === C2(g.entrantIds.length), `${label}: round-robin match count`, [g.matches.length, g.entrantIds.length]);
    const pairs = g.matches.map((m) => [m.a, m.b].sort().join("|"));
    ok(unique(pairs), `${label}: every pair meets exactly once`);
  }
  if (schedule) {
    const all = t.groups.flatMap((g) => g.matches);
    ok(all.every((m) => m.court >= 1 && m.court <= 4 && m.time), `${label}: all group matches scheduled`);
    ok(unique(all.map((m) => `${m.court}@${m.time}`)), `${label}: no court double-booking in group stage`);
    const slotMap = {};
    for (const m of all) { for (const e of [m.a, m.b]) { const key = `${e}@${m.time}`; slotMap[key] = (slotMap[key] || 0) + 1; } }
    ok(Object.values(slotMap).every((v) => v === 1), `${label}: no entrant double-booked in a slot`);
  }
  // premature knockout generation must be rejected
  r = await A(T(eventId, "/generate-knockout"), "POST");
  ok(r.status === 400, `${label}: generate-knockout rejected while matches undecided`);
  // play every group match with random scores (draws included), in a shuffled order
  const matches = t.groups.flatMap((g) => g.matches.map((m) => m.id));
  matches.sort(() => rnd() - 0.5);
  for (const id of matches) {
    const rr = await A(T(eventId, "/group-result"), "PUT", { matchId: id, scoreA: rint(0, 4), scoreB: rint(0, 4) });
    ok(rr.status === 200, `${label}: group result`, rr.json);
    if (rr.status === 200) t = rr.json.tournament;
  }
  const pts = { win: points ? points[0] : 3, draw: points ? points[1] : 1, loss: points ? points[2] : 0 };
  let draws = 0;
  t.groups.forEach((g) => {
    const { order, stat } = oracleGroupOrder(g, t.seedOrder, pts);
    ok(g.standings.map((s) => s.entrantId).join() === order.join(), `${label}: group standings order matches independent oracle`);
    for (const s of g.standings) {
      const o = stat[s.entrantId];
      ok(s.points === o.p && s.wins === o.w && s.draws === o.d && s.losses === o.l && s.played === g.entrantIds.length - 1, `${label}: standings row maths`, [s, o]);
      draws += o.d;
    }
  });
  // edit a result before knockout: allowed, standings follow
  const g0 = t.groups[0]; const m0 = g0.matches[0];
  r = await A(T(eventId, "/group-result"), "PUT", { matchId: m0.id, scoreA: 5, scoreB: 0 });
  ok(r.status === 200 && r.json.tournament.groups[0].matches[0].result.winnerId === m0.a, `${label}: group result can be corrected`);
  t = r.json.tournament;
  r = await A(T(eventId, "/group-result"), "PUT", { matchId: m0.id, scoreA: -1, scoreB: 0 });
  ok(r.status === 400, `${label}: negative score rejected`);
  r = await A(T(eventId, "/group-result"), "PUT", { matchId: 999999, scoreA: 1, scoreB: 0 });
  ok(r.status === 404, `${label}: unknown match 404`);
  r = await A(T(eventId, "/generate-knockout"), "POST");
  ok(r.status === 200, `${label}: generate knockout`, r.json);
  if (r.status !== 200) return;
  t = r.json.tournament;
  const expectedQ = t.groups.reduce((s, g) => s + Math.min(advance, g.entrantIds.length), 0);
  const slots0 = t.knockout.rounds[0].flatMap((m) => [m.a, m.b]).filter(Boolean);
  ok(slots0.length === expectedQ && unique(slots0), `${label}: knockout has exactly the qualifiers`, [slots0.length, expectedQ]);
  const qualifiedOk = t.groups.every((g) => g.standings.slice(0, Math.min(advance, g.entrantIds.length)).every((s) => slots0.includes(s.entrantId)));
  ok(qualifiedOk, `${label}: the top ${advance} of every group qualified`);
  ok(t.groups.every((g) => g.standings.slice(advance).every((s) => !slots0.includes(s.entrantId))), `${label}: nobody below the cut qualified`);
  // cross-group seeding quality (informational)
  const sameGroup = t.knockout.rounds[0].filter((m) => m.a && m.b && t.groups.some((g) => g.entrantIds.includes(m.a) && g.entrantIds.includes(m.b))).length;
  if (advance <= 2 && t.groups.length >= 2) ok(sameGroup === 0, `${label}: no first-round knockout match pairs two players from the same group`, sameGroup);
  else if (sameGroup > 0) note(`${label}: ${sameGroup} first-round knockout match(es) pair players from the same group (advance=${advance})`);
  r = await A(T(eventId, "/generate-knockout"), "POST");
  ok(r.status === 400, `${label}: second generate-knockout rejected`);
  // editing a group result AFTER the knockout was drawn: allowed only if the same players still qualify
  const probe = t.groups[0].matches[1] || t.groups[0].matches[0];
  const bracketIds = () => JSON.stringify([...new Set(t.knockout.rounds[0].flatMap((m) => [m.a, m.b]).filter(Boolean))].sort());
  const beforeIds = bracketIds();
  let flips = 0;
  let lastStored = { scoreA: probe.result.scoreA, scoreB: probe.result.scoreB };
  for (const [sa, sb] of [[0, 9], [9, 0], [3, 3]]) {
    r = await A(T(eventId, "/group-result"), "PUT", { matchId: probe.id, scoreA: sa, scoreB: sb });
    ok(r.status === 200 || r.status === 400, `${label}: late group edit is accepted or cleanly refused`, r.status);
    const cur = (await A(T(eventId))).json.tournament;
    ok(JSON.stringify([...new Set(cur.knockout.rounds[0].flatMap((m) => [m.a, m.b]).filter(Boolean))].sort()) === beforeIds, `${label}: bracket entrants unchanged by a late group edit`);
    const stored = cur.groups[0].matches.find((m) => m.id === probe.id).result;
    if (r.status === 400) { flips++; ok(stored.scoreA === lastStored.scoreA && stored.scoreB === lastStored.scoreB, `${label}: refused edit left the previous result intact`); }
    else { ok(stored.scoreA === sa && stored.scoreB === sb, `${label}: accepted edit stored`); lastStored = { scoreA: sa, scoreB: sb }; }
  }
  if (flips) note(`${label}: ${flips} late group edit(s) correctly refused because they would change who qualifies`);
  // put the original result back (always allowed - qualifiers identical)
  r = await A(T(eventId, "/group-result"), "PUT", { matchId: probe.id, scoreA: probe.result.scoreA, scoreB: probe.result.scoreB });
  ok(r.status === 200, `${label}: original result can be restored`, r.json);
  const done = await playKnockoutFully(eventId, t, label + " [KO stage]", { expectEntrants: expectedQ, seeded: false });
  if (!done) return;
  const aw = await A(T(eventId, "/award-points"), "POST");
  ok(aw.status === 200, `${label}: award points`, aw.json);
  return { eventId, draws };
}

// ==========================================================================
// CASUAL
// ==========================================================================
async function casualRun(mode) {
  const label = `CASUAL ${mode}`;
  const eventId = await mkEvent(`Fun ${mode}`, "Padel");
  const regIds = await enroll(eventId, 8);
  let r = await create(eventId, { mode, format: "casual" });
  ok(r.status === 201, `${label}: create`, r.json);
  ok(r.json.tournament.status === (mode === "team" ? "team-setup" : "casual"), `${label}: initial status`, r.json.tournament.status);
  if (mode === "team") {
    r = await A(T(eventId, "/casual-status"), "PUT", { status: "completed" });
    ok(r.status === 400, `${label}: cannot end before teams are set`);
    r = await A(T(eventId, "/teams"), "PUT", { teams: [{ name: "A", memberIds: regIds.slice(0, 4) }, { name: "B", memberIds: regIds.slice(4) }] });
    ok(r.status === 200 && r.json.tournament.status === "casual", `${label}: teams -> casual`);
  }
  r = await A(T(eventId, "/generate"), "POST");
  ok(r.status === 400, `${label}: generate rejected`);
  r = await A(T(eventId, "/seed-order"), "PUT", { seedOrder: [] });
  ok(r.status === 400, `${label}: bad seed order rejected`);
  for (const [i, st] of ["present", "absent", "present", "not_yet"].entries()) {
    r = await A(T(eventId, "/attendance"), "PUT", { registrationId: regIds[i], status: st });
    ok(r.status === 200 && r.json.tournament.attendance.find((a) => a.registrationId === regIds[i]).status === st, `${label}: attendance ${st}`);
  }
  r = await A(T(eventId, "/attendance"), "PUT", { registrationId: regIds[0], status: "maybe" });
  ok(r.status === 400, `${label}: invalid attendance status rejected`);
  r = await A(T(eventId, "/attendance"), "PUT", { registrationId: 999999, status: "present" });
  ok(r.status === 400, `${label}: foreign registration rejected`);
  for (const st of ["completed", "casual", "completed"]) {
    r = await A(T(eventId, "/casual-status"), "PUT", { status: st });
    ok(r.status === 200 && r.json.tournament.status === st, `${label}: status -> ${st}`);
  }
  r = await A(T(eventId, "/award-points"), "POST");
  ok(r.status === 400 || (r.status === 200), `${label}: award-points handled (no standings)`, r.status);
  r = await A(T(eventId, "/knockout-result"), "PUT", { roundIndex: 0, matchId: 1, winnerId: "x" });
  ok(r.status === 404, `${label}: knockout result on casual -> 404`);
  r = await A(T(eventId, "/group-result"), "PUT", { matchId: 1, scoreA: 1, scoreB: 0 });
  ok(r.status === 404, `${label}: group result on casual -> 404`);
  r = await A(T(eventId, "/swiss/next-round"), "POST");
  ok(r.status === 400, `${label}: swiss op on casual -> 400`);
  const pub = await api(`/api/tournaments/${eventId}`);
  ok(pub.status === 200, `${label}: public view`);
}

// ==========================================================================
// SWISS
// ==========================================================================
async function swissRun({ N, rounds, withdraw = 0, absent = 0, swap = true, undo = true, label: extra = "", lateJoin = false, cancelOne = false }) {
  const label = `SWISS N=${N} R=${rounds}${extra ? " " + extra : ""}`;
  const eventId = await mkEvent(`Swiss ${N}`, "Chess");
  await enroll(eventId, N, { women: (i) => i % 5 === 1, junior: (i) => i % 7 === 2 });
  let r = await create(eventId, { mode: "individual", format: "swiss", swissRounds: rounds, courts: Math.max(1, Math.floor(N / 3)), matchMinutes: 30, startTime: "15:00", breakMinutes: 5 });
  ok(r.status === 201, `${label}: create`, r.json);
  if (N >= 2) {
    // randomize seed order like the Randomize button
    const ids = r.json.tournament.entrants.map((e) => e.id).sort(() => rnd() - 0.5);
    const so = await A(T(eventId, "/seed-order"), "PUT", { seedOrder: ids });
    ok(so.status === 200, `${label}: randomize seed order`);
  }
  r = await A(T(eventId, "/generate"), "POST");
  if (N < 2) { ok(r.status === 400, `${label}: generate rejected with <2 players`, r.json); return; }
  ok(r.status === 200, `${label}: draw round 1`, r.json);
  if (r.status !== 200) return;
  let tn = r.json.tournament;
  const pairedEver = new Set(); // "a|b"
  const byeCount = {};
  const withdrawn = new Set();
  const absentSet = new Set();
  let expectedPointsTotal = 0;
  let expectRematchWarnings = false;
  const results = ["1-0", "0-1", "1/2-1/2", "1-0", "0-1", "1/2-1/2", "1-0f", "0-1f", "0-0f"];
  let lateEntrant = null;
  for (let round = 1; round <= rounds; round++) {
    const sw = tn.swiss;
    ok(sw.generatedRounds === round, `${label}: round ${round} drawn`, sw.generatedRounds);
    // ---- arbiter tools on the fresh draw
    const rd0 = sw.rounds[round - 1];
    const games = rd0.pairings.filter((p) => p.b != null);
    if (swap && round === 2 && games.length >= 2) {
      const g1 = games[0], g2 = games[1];
      const sr = await A(T(eventId, "/swiss/swap"), "PUT", { a: g1.b, b: g2.b });
      ok(sr.status === 200, `${label} R${round}: arbiter swap ok`, sr.json);
      const r2 = sr.json.tournament.swiss.rounds[round - 1].pairings;
      ok(r2.find((p) => p.id === g1.id).b === g2.b && r2.find((p) => p.id === g2.id).b === g1.b, `${label} R${round}: swap applied`);
      // undo the swap by swapping back
      await A(T(eventId, "/swiss/swap"), "PUT", { a: g1.b, b: g2.b });
      const flip = await A(T(eventId, "/swiss/swap"), "PUT", { a: g1.a, b: g1.b });
      ok(flip.status === 200 && flip.json.tournament.swiss.rounds[round - 1].pairings.find((p) => p.id === g1.id).a === g1.b, `${label} R${round}: colour flip`);
      await A(T(eventId, "/swiss/swap"), "PUT", { a: g1.a, b: g1.b });
      const bad = await A(T(eventId, "/swiss/swap"), "PUT", { a: g1.a, b: g1.a });
      ok(bad.status === 400, `${label} R${round}: swap with self rejected`);
    }
    if (undo && round === 2) {
      const u = await A(T(eventId, "/swiss/undo-round"), "POST");
      ok(u.status === 200 && u.json.tournament.swiss.generatedRounds === 1, `${label}: undo fresh round 2`, u.json);
      const again = await A(T(eventId, "/swiss/next-round"), "POST");
      ok(again.status === 200 && again.json.tournament.swiss.generatedRounds === 2, `${label}: redraw round 2`, again.json);
      tn = again.json.tournament;
    }
    // ---- draw invariants
    const rd = tn.swiss.rounds[round - 1];
    const active = tn.entrants.map((e) => e.id).filter((id) => !withdrawn.has(id) && !absentSet.has(id));
    const seen = [];
    rd.pairings.forEach((p) => { seen.push(p.a); if (p.b != null) seen.push(p.b); });
    ok(unique(seen), `${label} R${round}: nobody paired twice in a round`);
    ok(seen.every((id) => !withdrawn.has(id) && !absentSet.has(id)), `${label} R${round}: withdrawn/absent players not drawn`);
    ok(seen.length === active.length, `${label} R${round}: every active player is in the draw`, [seen.length, active.length]);
    const byes = rd.pairings.filter((p) => p.b == null);
    ok(byes.length === (active.length % 2), `${label} R${round}: byes = active % 2`, byes.length);
    byes.forEach((p) => { byeCount[p.a] = (byeCount[p.a] || 0) + 1; });
    const gamesNow = rd.pairings.filter((p) => p.b != null);
    const boards = gamesNow.map((p) => p.board).sort((a, b) => a - b);
    ok(boards.every((b, i) => b === i + 1), `${label} R${round}: boards numbered 1..G`, boards);
    let rematches = 0;
    gamesNow.forEach((p) => { const key = [p.a, p.b].sort().join("|"); if (pairedEver.has(key)) rematches++; pairedEver.add(key); });
    ok(rd.warnings.length === rematches, `${label} R${round}: rematch warnings == actual rematches`, [rd.warnings.length, rematches]);
    if (rematches === 0) ok(true, "");
    else note(`${label} R${round}: ${rematches} unavoidable rematch(es) flagged to the arbiter`);
    // schedule per round
    if (rd.time) ok(/^\d\d:\d\d$/.test(rd.time), `${label} R${round}: round time present`);
    const rd2 = tn.swiss.rounds[round - 1];
    // next-round must be refused until every result is in
    if (round < rounds && rd2.pairings.some((p) => p.b != null)) {
      const early = await A(T(eventId, "/swiss/next-round"), "POST");
      ok(early.status === 400, `${label} R${round}: next round refused while games undecided`);
    }
    // ---- enter results (shuffled)
    const gs = rd2.pairings.filter((p) => p.b != null).sort(() => rnd() - 0.5);
    for (const p of gs) {
      const res = pick(results);
      const rr = await A(T(eventId, "/swiss/result"), "PUT", { roundNumber: round, pairingId: p.id, result: res });
      ok(rr.status === 200, `${label} R${round}: result ${res}`, rr.json);
      if (rr.status === 200) tn = rr.json.tournament;
      expectedPointsTotal += res === "0-0f" ? 0 : 1;
    }
    expectedPointsTotal += rd2.pairings.filter((p) => p.b == null).length; // bye = 1 point
    // a bye cannot take a result
    const bp = rd2.pairings.find((p) => p.b == null);
    if (bp) { const rr = await A(T(eventId, "/swiss/result"), "PUT", { roundNumber: round, pairingId: bp.id, result: "1-0" }); ok(rr.status === 400, `${label} R${round}: result on a bye rejected`); }
    // correction of an earlier result in this round and re-correct
    if (gs.length) {
      const p = gs[0];
      const fix = await A(T(eventId, "/swiss/result"), "PUT", { roundNumber: round, pairingId: p.id, result: "1-0" });
      const was = tn.swiss.rounds[round - 1].pairings.find((q) => q.id === p.id).result;
      ok(fix.status === 200, `${label} R${round}: result correction`);
      // restore counted points: it was recorded earlier with some value; recompute total after loop instead
      tn = fix.json.tournament;
    }
    ok(tn.swiss.allResultsIn === true, `${label} R${round}: all results in`);
    // ---- between rounds: withdrawals / absences / late join / cancellation
    if (round === 2 && withdraw && N - withdraw >= 2) {
      const cand = tn.entrants.map((e) => e.id).filter((id) => !withdrawn.has(id));
      for (let i = 0; i < withdraw; i++) {
        const id = cand[i * 2 % cand.length];
        const wr = await A(T(eventId, "/swiss/withdraw"), "PUT", { entrantId: id, withdrawn: true });
        ok(wr.status === 200, `${label}: withdraw`); withdrawn.add(id);
      }
    }
    if (round === 2 && absent && N - withdraw - absent >= 2) {
      const cand = tn.attendance.filter((a) => !withdrawn.has(a.entrantId));
      for (let i = 0; i < absent; i++) {
        const a = cand[cand.length - 1 - i];
        const ar = await A(T(eventId, "/attendance"), "PUT", { registrationId: a.registrationId, status: "absent" });
        ok(ar.status === 200, `${label}: mark absent`); absentSet.add(a.entrantId);
      }
    }
    if (round === 2 && lateJoin) {
      await ensurePool(N + 1);
      const p = pool[N];
      const rg = await api("/api/register", { method: "POST", jar: p.jar, body: { eventId } });
      ok(rg.status === 200 || rg.status === 201, `${label}: late registration`);
      p.regByEvent[eventId] = (rg.json.registration && rg.json.registration.id) || rg.json.id;
      lateEntrant = "reg" + p.regByEvent[eventId];
      const cur = await A(T(eventId));
      tn = cur.json.tournament;
      ok(tn.entrants.some((e) => e.id === lateEntrant), `${label}: late entrant visible to admin`);
    }
    if (round === 2 && cancelOne) {
      const victim = pool[1];
      const self = await api(`/api/me/registrations/${victim.regByEvent[eventId]}`, { method: "DELETE", jar: victim.jar });
      ok(self.status === 400, `${label}: member can't self-cancel once the draw exists`, self.json);
      const del = await A(`/api/admin/registrations/${victim.regByEvent[eventId]}/cancel`, "POST", { reason: "E2E: player left" });
      ok(del.status === 400, `${label}: admin cancel is refused once the draw exists (by design)`, del.json);
      const cur = await A(T(eventId));
      ok(cur.status === 200, `${label}: admin view still loads after a cancellation`);
      tn = cur.json.tournament;
      // cancel is refused by design, so the player stays an entrant (withdraw is the supported route)
    }
    if (round < rounds) {
      const nr = await A(T(eventId, "/swiss/next-round"), "POST");
      if (nr.status !== 200) {
        ok(nr.status === 400 && /at least 2|rounds have already/.test((nr.json && nr.json.error) || ""), `${label}: next round after R${round}`, nr.json);
        return { eventId, stoppedEarly: true };
      }
      tn = nr.json.tournament;
      if (lateEntrant && round === 2) {
        const nrd = tn.swiss.rounds[2 - 0];
        ok(nrd.pairings.some((p) => p.a === lateEntrant || p.b === lateEntrant), `${label}: late entrant is drawn into the next round`);
      }
    }
  }
  // ---- final invariants
  ok(tn.status === "completed", `${label}: completed after the last round`, tn.status);
  const st = tn.swiss.standings;
  for (let i = 1; i < st.length; i++) ok(st[i - 1].points >= st[i].points, `${label}: standings sorted by points`);
  ok(st.every((x, i) => x.rank === i + 1), `${label}: ranks are 1..n`);
  const total = st.reduce((s, x) => s + x.points, 0);
  const recomputed = tn.swiss.rounds.reduce((s, rd) => s + rd.pairings.reduce((a, p) => a + (p.b == null ? 1 : p.result === "0-0f" ? 0 : 1), 0), 0);
  ok(Math.abs(total - recomputed) < 1e-9, `${label}: points conserved (${total} vs ${recomputed})`);
  ok(Object.values(byeCount).every((c) => c <= 1) || tn.swiss.rounds.length > N, `${label}: nobody gets two byes`, byeCount);
  ok(tn.swiss.rankings.open.length === Math.min(3, N) && tn.swiss.rankings.open.every((x) => x.prize === null), `${label}: no prizes -> podium without amounts`, tn.swiss.rankings.open.length);
  const aw = await A(T(eventId, "/award-points"), "POST");
  ok(aw.status === 200, `${label}: award points`, aw.json);
  // settings edits after completion
  const sv = await A(T(eventId, "/swiss/settings"), "PUT", { prizes: { open: [100, 50], women: [], junior: [20] } });
  ok(sv.status === 200 && sv.json.tournament.swiss.prizeTotal === 170 && sv.json.tournament.status === "completed", `${label}: prizes editable after the end`);
  // print sheets + public
  for (const v of ["regulation", "pairings", "standings"]) for (const lang of ["ar", "en"]) {
    const res = await api(`/admin/print/tournament/${eventId}?view=${v}&lang=${lang}`, { jar: admin, raw: true });
    ok(res.status === 200 && /html/.test(res.type) && !/<script>[^<]/.test(res.text), `${label}: print ${v}/${lang}`, res.status);
  }
  const pub = await api(`/api/tournaments/${eventId}`);
  ok(pub.status === 200 && pub.json.tournament.swiss.final === true, `${label}: public view`);
  ok(!/membershipNumber|0105\d{7}/.test(JSON.stringify(pub.json)), `${label}: public swiss view leaks nothing`);
  return { eventId, tn };
}

// ==========================================================================
// SETUP OPERATIONS
// ==========================================================================
async function setupOperations() {
  section("Setup: creation validation (every format)");
  const ev = await mkEvent("Setup validation", "Chess");
  const bad = [
    [{ mode: "x", format: "knockout" }, "bad mode"],
    [{ mode: "individual", format: "league" }, "bad format"],
    [{ mode: "individual", format: "groups", numGroups: 1, advancePerGroup: 1 }, "numGroups 1"],
    [{ mode: "individual", format: "groups", numGroups: 2.5, advancePerGroup: 1 }, "numGroups fractional"],
    [{ mode: "individual", format: "groups", numGroups: "abc", advancePerGroup: 1 }, "numGroups text"],
    [{ mode: "individual", format: "groups", numGroups: 2, advancePerGroup: 0 }, "advance 0"],
    [{ mode: "individual", format: "groups" }, "groups missing params"],
    [{ mode: "individual", format: "knockout", courts: 0, matchMinutes: 10, startTime: "09:00" }, "courts 0"],
    [{ mode: "individual", format: "knockout", courts: 2, matchMinutes: -1, startTime: "09:00" }, "minutes negative"],
    [{ mode: "individual", format: "knockout", courts: 2, matchMinutes: 10, startTime: "25:00" }, "start 25:00"],
    [{ mode: "individual", format: "knockout", courts: 2, matchMinutes: 10, startTime: "9:00" }, "start 9:00 (not zero padded)"],
    [{ mode: "individual", format: "knockout", courts: 2 }, "partial schedule"],
    [{ mode: "individual", format: "knockout", courts: 2, matchMinutes: 10, startTime: "09:00", breakMinutes: -3 }, "break negative"],
    [{ mode: "individual", format: "knockout", winPoints: -1 }, "negative win points"],
    [{ mode: "individual", format: "knockout", winPoints: "abc" }, "text win points"],
    [{ mode: "individual", format: "knockout", availableHours: -2 }, "negative available hours"],
    [{ mode: "team", format: "swiss" }, "swiss team mode"],
    [{ mode: "individual", format: "swiss", swissRounds: 0 }, "swiss 0 rounds"],
    [{ mode: "individual", format: "swiss", swissRounds: 31 }, "swiss 31 rounds"],
    [{ mode: "individual", format: "swiss", swissRounds: "x" }, "swiss text rounds"],
  ];
  for (const [b, why] of bad) {
    const r = await create(ev, b);
    ok(r.status === 400, `create rejected: ${why}`, [r.status, r.json]);
  }
  let r = await create(999999, { mode: "individual", format: "knockout" });
  ok(r.status === 404, "create on unknown event -> 404");
  r = await A(T(ev), "GET");
  ok(r.status === 404 || (r.status === 200 && !r.json.tournament), "no tournament was created by the rejected attempts", r.status);
  r = await create(ev, { mode: "individual", format: "knockout" });
  ok(r.status === 201, "create valid knockout");
  r = await create(ev, { mode: "individual", format: "knockout" });
  ok(r.status === 400, "second tournament on the same event rejected");
  r = await A(T(ev, "/teams"), "PUT", { teams: [] });
  ok(r.status === 400, "teams endpoint on an individual tournament rejected");
  r = await A(T(ev), "DELETE");
  ok(r.status === 200, "delete tournament");
  r = await A(T(ev), "DELETE");
  ok(r.status === 404, "delete again -> 404");
  r = await create(ev, { mode: "individual", format: "groups", numGroups: 2, advancePerGroup: 1 });
  ok(r.status === 201, "recreate after delete");
  await A(T(ev), "DELETE");

  section("Setup: seeding, generate, reseed rules (knockout)");
  const e2 = await mkEvent("Seeding", "Chess");
  await enroll(e2, 5);
  r = await create(e2, { mode: "individual", format: "knockout", courts: 2, matchMinutes: 10, startTime: "09:00" });
  let tn = r.json.tournament;
  const ids = tn.entrants.map((e) => e.id);
  ok(tn.seedOrder.length === 5, "seed order covers all entrants");
  for (const [so, why] of [[ids.slice(1), "missing one"], [[...ids, ids[0]], "extra duplicate"], [[...ids.slice(1), "nope"], "foreign id"], ["x", "not an array"], [[ids[0], ids[0], ids[2], ids[3], ids[4]], "duplicate id"]]) {
    r = await A(T(e2, "/seed-order"), "PUT", { seedOrder: so });
    ok(r.status === 400, `seed-order rejected: ${why}`);
  }
  const reversed = [...ids].reverse();
  r = await A(T(e2, "/seed-order"), "PUT", { seedOrder: reversed });
  ok(r.status === 200 && r.json.tournament.seedOrder.join() === reversed.join(), "seed order saved");
  r = await A(T(e2, "/reseed"), "POST");
  ok(r.status === 400, "reseed before generate rejected");
  r = await A(T(e2, "/generate"), "POST");
  tn = r.json.tournament;
  const byeEntrants = tn.knockout.rounds[0].filter((m) => m.bye).map((m) => m.a || m.b);
  ok(byeEntrants.includes(reversed[0]) && byeEntrants.includes(reversed[1]) && byeEntrants.includes(reversed[2]), "the top 3 seeds (after reordering) get the byes");
  r = await A(T(e2, "/generate"), "POST");
  ok(r.status === 400, "second generate rejected");
  r = await A(T(e2, "/seed-order"), "PUT", { seedOrder: ids });
  ok(r.status === 200, "seed order can still be saved (no effect on the drawn bracket)");
  r = await A(T(e2, "/reseed"), "POST");
  ok(r.status === 200 && r.json.tournament.status === "seeding" && !r.json.tournament.knockout, "reseed after generate (no results) returns to seeding");
  r = await A(T(e2, "/generate"), "POST");
  tn = r.json.tournament;
  const m1 = tn.knockout.rounds[0].find((m) => !m.bye);
  r = await A(T(e2, "/knockout-result"), "PUT", { roundIndex: 0, matchId: m1.id, winnerId: m1.a });
  ok(r.status === 200, "play one match");
  r = await A(T(e2, "/reseed"), "POST");
  ok(r.status === 400, "reseed after a result rejected");

  section("Setup: knockout result edge cases");
  const e2b = await mkEvent("KO edge cases", "Chess");
  await enroll(e2b, 7);
  await create(e2b, { mode: "individual", format: "knockout" });
  r = await A(T(e2b, "/generate"), "POST");
  tn = r.json.tournament;
  const ee = e2b;
  const r0 = tn.knockout.rounds[0];
  const real = r0.filter((m) => !m.bye);
  const mm1 = real[0];
  const other = real[1];
  r = await A(T(ee, "/knockout-result"), "PUT", { roundIndex: 0, matchId: mm1.id, winnerId: mm1.a });
  ok(r.status === 200, "edge: play first match");
  r = await A(T(ee, "/knockout-result"), "PUT", { roundIndex: 0, matchId: other.id, scoreA: 1, scoreB: 1 });
  ok(r.status === 400, "tied score without winnerId rejected");
  r = await A(T(ee, "/knockout-result"), "PUT", { roundIndex: 0, matchId: other.id, winnerId: "reg999999" });
  ok(r.status === 400, "winner who is not in the match rejected");
  r = await A(T(ee, "/knockout-result"), "PUT", { roundIndex: 0, matchId: other.id, scoreA: "x", scoreB: 1 });
  ok(r.status === 400, "non-numeric score rejected");
  r = await A(T(ee, "/knockout-result"), "PUT", { roundIndex: 0, matchId: other.id, scoreA: 1.5, scoreB: 1 });
  ok(r.status === 400, "fractional score rejected");
  r = await A(T(ee, "/knockout-result"), "PUT", { roundIndex: 9, matchId: other.id, winnerId: other.a });
  ok(r.status === 404, "unknown round 404");
  r = await A(T(ee, "/knockout-result"), "PUT", { roundIndex: 0, matchId: 999999, winnerId: other.a });
  ok(r.status === 404, "unknown match 404");
  const byeMatch = r0.find((m) => m.bye);
  r = await A(T(ee, "/knockout-result"), "PUT", { roundIndex: 0, matchId: byeMatch.id, winnerId: byeMatch.a || byeMatch.b });
  ok(r.status === 400, "result on a bye rejected");
  const finalM = tn.knockout.rounds[tn.knockout.rounds.length - 1][0];
  r = await A(T(ee, "/knockout-result"), "PUT", { roundIndex: tn.knockout.rounds.length - 1, matchId: finalM.id, winnerId: finalM.a || "x" });
  ok(r.status === 400, "final with missing entrants rejected");
  // correct a score without changing the winner
  r = await A(T(ee, "/knockout-result"), "PUT", { roundIndex: 0, matchId: mm1.id, scoreA: 9, scoreB: 0 });
  ok(r.status === 200 && r.json.tournament.knockout.rounds[0].find((m) => m.id === mm1.id).winnerId === mm1.a, "score correction keeping winner");
  // change the winner while the next round is undecided -> propagates
  r = await A(T(ee, "/knockout-result"), "PUT", { roundIndex: 0, matchId: mm1.id, winnerId: mm1.b });
  ok(r.status === 200, "winner change allowed while next round undecided");
  const idx1 = r.json.tournament.knockout.rounds[0].findIndex((m) => m.id === mm1.id);
  const nx = r.json.tournament.knockout.rounds[1][Math.floor(idx1 / 2)];
  ok((idx1 % 2 === 0 ? nx.a : nx.b) === mm1.b, "changed winner propagated to the next round");

  section("Setup: schedule edits before and after generate");
  const e3 = await mkEvent("Schedule edits", "Padel");
  await enroll(e3, 8);
  r = await create(e3, { mode: "individual", format: "groups", numGroups: 2, advancePerGroup: 2 });
  ok(r.status === 201 && r.json.tournament.schedule === null, "no schedule when none given");
  for (const [b, why] of [[{ courts: 0, matchMinutes: 10, startTime: "09:00" }, "courts 0"], [{ courts: 2, matchMinutes: 0, startTime: "09:00" }, "minutes 0"], [{ courts: 2, matchMinutes: 10, startTime: "9am" }, "bad time"], [{ courts: 2, matchMinutes: 10 }, "no start"], [{ courts: 2, matchMinutes: 10, startTime: "09:00", breakMinutes: -1 }, "negative break"], [{ courts: 2, matchMinutes: 10, startTime: "09:00", availableHours: -1 }, "negative hours"]]) {
    r = await A(T(e3, "/schedule"), "PUT", b);
    ok(r.status === 400, `schedule rejected: ${why}`, r.json);
  }
  r = await A(T(e3, "/schedule"), "PUT", { courts: 2, matchMinutes: 20, startTime: "10:00", breakMinutes: 5 });
  ok(r.status === 200 && r.json.tournament.schedule.courts === 2, "schedule can be added before generate");
  r = await A(T(e3, "/generate"), "POST");
  let g = r.json.tournament;
  ok(g.groups.flatMap((x) => x.matches).every((m) => m.court && m.time), "matches scheduled after adding schedule");
  const first = g.groups[0].matches[0];
  r = await A(T(e3, "/group-result"), "PUT", { matchId: first.id, scoreA: 2, scoreB: 0 });
  r = await A(T(e3, "/schedule"), "PUT", { courts: 4, matchMinutes: 30, startTime: "14:00", breakMinutes: 0 });
  ok(r.status === 200, "schedule edited after generate");
  g = r.json.tournament;
  const all = g.groups.flatMap((x) => x.matches);
  ok(all.every((m) => m.court >= 1 && m.court <= 4 && mins(m.time) >= mins("14:00")), "all matches rescheduled to the new courts/start");
  ok(unique(all.map((m) => `${m.court}@${m.time}`)), "no court double-booking after reschedule");
  ok(g.groups[0].matches[0].result && g.groups[0].matches[0].result.scoreA === 2, "recorded result survives a reschedule");

  section("Setup: late registration & cancellation after the bracket is drawn");
  const e4 = await mkEvent("Late changes", "Chess");
  const regs = await enroll(e4, 8);
  r = await create(e4, { mode: "individual", format: "knockout" });
  r = await A(T(e4, "/generate"), "POST");
  tn = r.json.tournament;
  await ensurePool(9);
  const late = pool[8];
  const lr = await api("/api/register", { method: "POST", jar: late.jar, body: { eventId: e4 } });
  late.regByEvent[e4] = (lr.json.registration && lr.json.registration.id) || lr.json.id;
  const cur = await A(T(e4));
  ok(cur.status === 200, "admin view OK after a late registration");
  ok(cur.json.tournament.knockout.rounds[0].flatMap((m) => [m.a, m.b]).filter(Boolean).length === 8, "late registrant is NOT inserted into the drawn bracket");
  // cancel a drawn player
  const victim = pool[0];
  const selfCancel = await api(`/api/me/registrations/${victim.regByEvent[e4]}`, { method: "DELETE", jar: victim.jar });
  ok(selfCancel.status === 400, "member can't self-cancel after the draw", selfCancel.json);
  const cancel = await A(`/api/admin/registrations/${victim.regByEvent[e4]}/cancel`, "POST", { reason: "E2E: player left" });
  ok(cancel.status === 400, "admin cancel of a drawn player is refused (by design - use withdraw)", cancel.json);
  const cur2 = await A(T(e4));
  ok(cur2.status === 200, "admin view OK after a cancellation");
  const pub = await api(`/api/tournaments/${e4}`);
  ok(pub.status === 200, "public view OK after a cancellation");
  // finish the tournament regardless
  tn = cur2.json.tournament;
  let guard = 0;
  for (let ri = 0; ri < tn.knockout.rounds.length; ri++) {
    for (const m0 of tn.knockout.rounds[ri]) {
      const m = tn.knockout.rounds[ri].find((x) => x.id === m0.id);
      if (m.bye || m.winnerId || !m.a || !m.b) continue;
      const rr = await A(T(e4, "/knockout-result"), "PUT", { roundIndex: ri, matchId: m.id, winnerId: m.a });
      ok(rr.status === 200, "can still enter results involving a cancelled player", rr.json);
      if (rr.status === 200) tn = rr.json.tournament;
      if (++guard > 20) break;
    }
  }
  ok(tn.status === "completed", "tournament still completes after cancellation/late registration", tn.status);
  const aw = await A(T(e4, "/award-points"), "POST");
  ok(aw.status === 200, "award points with a cancelled entrant doesn't crash", aw.json);

  section("Setup: attendance + team validation");
  const e5 = await mkEvent("Team validation", "Padel");
  const r5 = await enroll(e5, 6);
  r = await create(e5, { mode: "team", format: "knockout" });
  for (const [teams, why] of [[[{ name: "A", memberIds: [r5[0]] }], "only one team"], [[{ name: "", memberIds: [r5[0]] }, { name: "B", memberIds: [r5[1]] }], "unnamed team (dropped -> 1 team)"], [[{ name: "A", memberIds: [] }, { name: "B", memberIds: [r5[1]] }], "empty team (dropped)"], [[{ name: "A", memberIds: [r5[0], r5[1]] }, { name: "B", memberIds: [r5[1]] }], "member in two teams"], ["x", "not an array"]]) {
    r = await A(T(e5, "/teams"), "PUT", { teams });
    ok(r.status === 400, `teams rejected: ${why}`);
  }
  r = await A(T(e5, "/teams"), "PUT", { teams: [{ name: "A", memberIds: [r5[0], r5[1], 999999] }, { name: "B", memberIds: [r5[2]] }, { name: "C", memberIds: [r5[3], r5[4]] }] });
  ok(r.status === 200 && r.json.tournament.teams[0].memberIds.length === 2, "unknown registration ids are dropped from teams", r.json);
  ok(r.json.tournament.teams.length === 3, "3 valid teams stored");
  r = await A(T(e5, "/attendance"), "PUT", { registrationId: r5[1], status: "present" });
  ok(r.status === 200, "team member attendance");
  r = await A(T(e5, "/attendance"), "PUT", { registrationId: r5[5], status: "present" });
  ok(r.status === 400, "attendance for a registration not on any team rejected");
  // redefine teams after seeding order exists: seed order reconciles
  r = await A(T(e5, "/teams"), "PUT", { teams: [{ name: "A", memberIds: [r5[0]] }, { name: "D", memberIds: [r5[5]] }] });
  ok(r.status === 200 && r.json.tournament.seedOrder.length === 2, "re-saving teams reconciles the seed order");

  section("Event deletion with a tournament attached");
  const e6 = await mkEvent("Doomed event", "Chess");
  await enroll(e6, 4);
  await create(e6, { mode: "individual", format: "knockout" });
  await A(T(e6, "/generate"), "POST");
  const dv = await A(`/api/events/${e6}`, "DELETE");
  ok(dv.status === 200 || dv.status === 400, "event delete handled", [dv.status, dv.json]);
  const list = await api("/api/tournaments");
  ok(list.status === 200 && Array.isArray(list.json), "public tournament list still loads after event deletion");
  const gone = await api(`/api/tournaments/${e6}`);
  ok(gone.status === 200 || gone.status === 404, "deleted event's tournament page does not 500", gone.status);
}

// ==========================================================================
// ROLES
// ==========================================================================
async function roleMatrix() {
  section("Role matrix on every tournament endpoint");
  const ev = await mkEvent("Roles", "Chess");
  await enroll(ev, 4);
  await create(ev, { mode: "individual", format: "swiss", swissRounds: 3 });
  const ev2 = await mkEvent("Roles2", "Chess");
  await enroll(ev2, 4);
  const roles = {};
  for (const role of ["staff", "management", "tournament"]) {
    const username = `rm_${role}`;
    const cr = await A("/api/staff/accounts", "POST", { username, password: "Role!Pass2026xyz", role, name: role });
    ok(cr.status === 200 || cr.status === 201, `create ${role} account`, cr.json);
    const jar = await prime(newJar());
    const lg = await api("/api/auth/staff-login", { method: "POST", jar, body: { username, password: "Role!Pass2026xyz" } });
    ok(lg.status === 200, `${role} login`, lg.json);
    roles[role] = jar;
  }
  const member = pool[0].jar;
  const anon = await prime(newJar());
  const eps = [
    ["GET", T(ev)], ["POST", T(ev2)], ["DELETE", T(ev2)], ["PUT", T(ev, "/teams")], ["PUT", T(ev, "/seed-order")], ["PUT", T(ev, "/schedule")],
    ["POST", T(ev, "/generate")], ["POST", T(ev, "/reseed")], ["PUT", T(ev, "/casual-status")], ["PUT", T(ev, "/group-result")], ["PUT", T(ev, "/attendance")],
    ["POST", T(ev, "/generate-knockout")], ["PUT", T(ev, "/knockout-result")], ["POST", T(ev, "/award-points")], ["POST", T(ev, "/swiss/next-round")],
    ["POST", T(ev, "/swiss/undo-round")], ["PUT", T(ev, "/swiss/result")], ["PUT", T(ev, "/swiss/swap")], ["PUT", T(ev, "/swiss/withdraw")],
    ["PUT", T(ev, "/swiss/info")], ["PUT", T(ev, "/swiss/settings")], ["PUT", T(ev, "/categories")], ["GET", `/admin/print/tournament/${ev}`],
  ];
  for (const [m, p] of eps) {
    const body = m === "GET" ? undefined : {};
    const ra = await api(p, { method: m, jar: anon, body, raw: m === "GET" && p.includes("/admin/print") });
    ok(ra.status === 401, `anon blocked ${m} ${p.replace(/\/\d+/, "/:id")}`, ra.status);
    const rm = await api(p, { method: m, jar: member, body, raw: m === "GET" && p.includes("/admin/print") });
    ok(rm.status === 401 || rm.status === 403, `member blocked ${m} ${p.replace(/\/\d+/, "/:id")}`, rm.status);
    for (const role of ["staff", "management"]) {
      const rr = await api(p, { method: m, jar: roles[role], body, raw: m === "GET" && p.includes("/admin/print") });
      ok(rr.status === 403, `${role} role blocked ${m} ${p.replace(/\/\d+/, "/:id")}`, rr.status);
    }
    const rt = await api(p, { method: m, jar: roles.tournament, body, raw: m === "GET" && p.includes("/admin/print") });
    ok(rt.status !== 401 && rt.status !== 403, `tournament role allowed ${m} ${p.replace(/\/\d+/, "/:id")}`, rt.status);
  }
  // CSRF
  const noCsrf = await api(T(ev, "/swiss/next-round"), { method: "POST", jar: admin, noCsrf: true });
  ok(noCsrf.status === 403, "state-changing tournament call without CSRF token -> 403", noCsrf.status);
  // public endpoints are open and read-only
  const pubList = await api("/api/tournaments");
  ok(pubList.status === 200, "public tournaments list is open");
  const w = await api(`/api/tournaments/${ev}`, { method: "PUT", jar: anon, body: {} });
  ok(w.status === 404 || w.status === 405 || w.status === 401 || w.status === 403, "public tournament URL accepts no writes", w.status);
}

// ==========================================================================
// RACES
// ==========================================================================
async function races() {
  section("Concurrency: parallel result entry, double generate, double next-round");
  // knockout 32: every match of a round written at the same time
  const ev = await mkEvent("Race KO", "Chess");
  await enroll(ev, 32);
  await create(ev, { mode: "individual", format: "knockout" });
  let r = await A(T(ev, "/generate"), "POST");
  const gens = await Promise.all([1, 2, 3, 4].map(() => A(T(ev, "/generate"), "POST")));
  ok(gens.every((g) => g.status === 400), "repeated generate rejected under race");
  let tn = r.json.tournament;
  for (let ri = 0; ri < tn.knockout.rounds.length; ri++) {
    const ms = tn.knockout.rounds[ri].filter((m) => !m.bye);
    const rs = await Promise.all(ms.map((m) => A(T(ev, "/knockout-result"), "PUT", { roundIndex: ri, matchId: m.id, winnerId: m.a })));
    ok(rs.every((x) => x.status === 200), `parallel results round ${ri}`, rs.map((x) => x.status));
    tn = (await A(T(ev))).json.tournament;
    ok(tn.knockout.rounds[ri].every((m) => m.winnerId), `round ${ri}: no lost writes`);
    if (ri + 1 < tn.knockout.rounds.length) {
      const nxt = tn.knockout.rounds[ri + 1];
      ok(nxt.every((m) => m.a && m.b), `round ${ri + 1}: all slots filled after parallel results`);
    }
  }
  ok(tn.status === "completed", "parallel-played knockout completed");
  // same match, conflicting winners at the same time
  const ev2 = await mkEvent("Race same match", "Chess");
  await enroll(ev2, 4);
  await create(ev2, { mode: "individual", format: "knockout" });
  r = await A(T(ev2, "/generate"), "POST");
  const m = r.json.tournament.knockout.rounds[0][0];
  const conflict = await Promise.all(Array.from({ length: 10 }, (_, i) => A(T(ev2, "/knockout-result"), "PUT", { roundIndex: 0, matchId: m.id, winnerId: i % 2 ? m.a : m.b })));
  ok(conflict.every((x) => x.status === 200 || x.status === 400), "conflicting writes to one match never 5xx");
  const after = (await A(T(ev2))).json.tournament;
  const mm = after.knockout.rounds[0][0];
  const nxt = after.knockout.rounds[1][0];
  ok(mm.winnerId === m.a || mm.winnerId === m.b, "one valid winner remains");
  ok(nxt.a === mm.winnerId, "next round slot consistent with the final winner");

  // groups: parallel results then parallel knockout generation
  const ev3 = await mkEvent("Race groups", "Padel");
  await enroll(ev3, 16);
  await create(ev3, { mode: "individual", format: "groups", numGroups: 4, advancePerGroup: 2 });
  r = await A(T(ev3, "/generate"), "POST");
  const gm = r.json.tournament.groups.flatMap((g) => g.matches);
  const rs = await Promise.all(gm.map((x) => A(T(ev3, "/group-result"), "PUT", { matchId: x.id, scoreA: rint(0, 3), scoreB: rint(0, 3) })));
  ok(rs.every((x) => x.status === 200), "parallel group results");
  const after3 = (await A(T(ev3))).json.tournament;
  ok(after3.groups.flatMap((g) => g.matches).every((x) => x.result), "no lost group results");
  const kos = await Promise.all([1, 2, 3, 4, 5].map(() => A(T(ev3, "/generate-knockout"), "POST")));
  ok(kos.filter((x) => x.status === 200).length === 1 && kos.filter((x) => x.status === 400).length === 4, "exactly one parallel generate-knockout wins", kos.map((x) => x.status));

  // swiss: parallel next-round, results, awards
  const ev4 = await mkEvent("Race swiss", "Chess");
  await enroll(ev4, 20);
  await create(ev4, { mode: "individual", format: "swiss", swissRounds: 3 });
  r = await A(T(ev4, "/generate"), "POST");
  tn = r.json.tournament;
  const rs4 = await Promise.all(tn.swiss.rounds[0].pairings.filter((p) => p.b != null).map((p) => A(T(ev4, "/swiss/result"), "PUT", { roundNumber: 1, pairingId: p.id, result: pick(["1-0", "0-1", "1/2-1/2"]) })));
  ok(rs4.every((x) => x.status === 200), "parallel swiss results");
  const nrs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => A(T(ev4, "/swiss/next-round"), "POST")));
  ok(nrs.filter((x) => x.status === 200).length === 1, "exactly one parallel next-round draws round 2", nrs.map((x) => x.status));
  const st4 = (await A(T(ev4))).json.tournament;
  ok(st4.swiss.generatedRounds === 2, "only one extra round exists after parallel next-round");
  const sets = await Promise.all([2, 3, 4, 5].map((n) => A(T(ev4, "/swiss/settings"), "PUT", { totalRounds: n + 1, prizes: { open: [n * 100] } })));
  ok(sets.every((x) => x.status === 200), "parallel settings edits never 5xx");
  const fin = (await A(T(ev4))).json.tournament.swiss;
  ok(fin.totalRounds >= 3 && fin.prizes.open.length === 1, "settings end in a consistent state");
  // award points many times
  const awards = await Promise.all(Array.from({ length: 8 }, () => A(T(ev, "/award-points"), "POST")));
  ok(awards.every((x) => x.status === 200 && x.json.updated === awards[0].json.updated), "parallel award-points stable");
}

// ==========================================================================
// REPORTS / PUBLIC
// ==========================================================================
async function reportsAndPublic(eventIds) {
  section("Public lists, big screen, management reports for every format");
  const list = await api("/api/tournaments");
  ok(list.status === 200 && list.json.length >= eventIds.length, "public list includes the tournaments", list.json && list.json.length);
  for (const eid of eventIds) {
    const pub = await api(`/api/tournaments/${eid}`);
    ok(pub.status === 200, `public detail ${eid}`);
    const rep = await A(`/api/admin/management/events/${eid}/report`);
    ok(rep.status === 200, `management report ${eid}`, rep.status);
    const docx = await api(`/api/admin/management/events/${eid}/report.docx`, { jar: admin, raw: true });
    ok(docx.status === 200 && docx.text.startsWith("PK"), `management report.docx ${eid} is a zip`, docx.status);
  }
  const dash = await A("/api/admin/management/dashboard");
  ok(dash.status === 200, "management dashboard");
  for (const page of ["/", "/screen.html", "/print.js", "/app.js", "/i18n.js", "/styles.css"]) {
    const res = await api(page, { raw: true });
    ok(res.status === 200, `static ${page}`);
  }
}

// ==========================================================================
async function main() {
  const started = Date.now();
  section("Login");
  await prime(admin);
  const lg = await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } });
  ok(lg.status === 200, "admin login", lg.json);
  await ensurePool(POOL);
  const eventIds = [];

  section("KNOCKOUT individual: sizes 2..64, with and without schedule");
  for (const N of [2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 33, 64]) {
    const x = await knockoutIndividual(N, N % 2 === 1);
    if (x) eventIds.push(x.eventId);
  }
  await knockoutIndividual(1, false);

  section("KNOCKOUT teams");
  await knockoutTeams([2, 2]);
  await knockoutTeams([2, 3, 2]);
  await knockoutTeams([1, 1, 1, 1, 1]);
  await knockoutTeams([3, 3, 3, 3, 3, 3, 3]);
  await knockoutTeams([2]);

  section("GROUPS (individual): sizes, group counts, advance, custom points");
  for (const cfg of [
    { N: 4, numGroups: 2, advance: 1 }, { N: 6, numGroups: 2, advance: 2 }, { N: 8, numGroups: 2, advance: 2, schedule: true },
    { N: 9, numGroups: 3, advance: 2 }, { N: 10, numGroups: 3, advance: 1 }, { N: 13, numGroups: 4, advance: 2, points: [2, 1, 0] },
    { N: 17, numGroups: 5, advance: 2, schedule: true }, { N: 20, numGroups: 4, advance: 3 }, { N: 12, numGroups: 3, advance: 2, points: [3, 0, 0] },
    { N: 5, numGroups: 2, advance: 3 }, { N: 3, numGroups: 2, advance: 1 }, { N: 24, numGroups: 6, advance: 2, schedule: true },
  ]) { const x = await groupsRun(cfg); if (x) eventIds.push(x.eventId); }

  section("GROUPS (team)");
  await groupsRun({ mode: "team", teamSizes: [2, 2, 2, 2, 2, 2], numGroups: 2, advance: 2 });
  await groupsRun({ mode: "team", teamSizes: [3, 2, 3, 2, 3, 2, 3, 2, 3], numGroups: 3, advance: 1, schedule: true });

  section("CASUAL");
  await casualRun("individual");
  await casualRun("team");

  section("SWISS: sizes, rounds, withdrawals, absences, swaps, undo, late join, cancellation");
  const swissEvents = [];
  for (const cfg of [
    { N: 2, rounds: 1 }, { N: 2, rounds: 3, label: "(more rounds than possible)" }, { N: 3, rounds: 3 }, { N: 4, rounds: 3 }, { N: 4, rounds: 7, label: "(rounds > N-1)" },
    { N: 5, rounds: 5 }, { N: 8, rounds: 5, withdraw: 1 }, { N: 9, rounds: 7 }, { N: 16, rounds: 7, withdraw: 2, absent: 1 },
    { N: 17, rounds: 7, lateJoin: true }, { N: 24, rounds: 7, cancelOne: true, withdraw: 1 }, { N: 31, rounds: 7, absent: 2 }, { N: 39, rounds: 7, withdraw: 2, absent: 2, swap: true },
    { N: 50, rounds: 9 },
  ]) { const x = await swissRun(cfg); if (x && x.eventId) swissEvents.push(x.eventId); }
  await swissRun({ N: 1, rounds: 3 });
  eventIds.push(...swissEvents);

  await setupOperations();
  await roleMatrix();
  await races();
  await reportsAndPublic(eventIds.slice(0, 12));

  section("5xx audit");
  ok(serverErrors.length === 0, "no 5xx response anywhere in the whole run", serverErrors.slice(0, 10));
  console.log(`\nObservations (${notes.length}):`);
  [...new Set(notes)].slice(0, 40).forEach((n) => console.log("  -", n));
  console.log(`\nTournament matrix E2E: ${pass} passed, ${fail} failed (${Math.round((Date.now() - started) / 1000)}s)`);
  if (failures.length) console.log("FAILED:\n  " + [...new Set(failures)].join("\n  "));
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
