// How many people can enter / confirm scores at the same moment? Real HTTP load against the server:
//  A) 32 scorekeepers submit all 32 Round-1 results of a 64-player knockout at once
//  B) 64 players report + confirm their own Round-2 scores at once
//  C) two managers submit CONFLICTING winners for the same match at the same instant (no corruption)
//  D) 8 tournaments x 32 matches = 256 results in flight at once
// Usage: BASE_URL=http://localhost:3951 node score_concurrency_e2e.js
"use strict";
const BASE = process.env.BASE_URL || "http://localhost:3951";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
let passed = 0, failed = 0; const serverErrors = [];
const ok = (c, l, x) => { if (c) passed++; else { failed++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 500)); } };
const section = (s) => console.log("\n=== " + s + " ===");
const applySetCookies = (jar, res) => { const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []; for (const raw of sc) { const [pair] = raw.split(";"); const eq = pair.indexOf("="); if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); } };
const lat = [];
async function api(path, { method = "GET", body, jar, form, timed } = {}) {
  jar = jar || {};
  const headers = {};
  if (Object.keys(jar).length) headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (!["GET", "HEAD"].includes(method) && jar.csrfToken) headers["X-CSRF-Token"] = jar.csrfToken;
  let fb; if (form) fb = form; else if (body !== undefined) { headers["Content-Type"] = "application/json"; fb = JSON.stringify(body); }
  const t0 = Date.now(); let res;
  try { res = await fetch(BASE + path, { method, headers, body: fb, redirect: "manual" }); } catch (e) { return { status: 0, json: { networkError: String(e) }, jar }; }
  if (timed) timed.push(Date.now() - t0);
  applySetCookies(jar, res);
  if (res.status >= 500) serverErrors.push(`${method} ${path} -> ${res.status}`);
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, jar };
}
const prime = async (jar) => { await api("/", { jar }); return jar; };
const form = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const cairoToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
const pct = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0; };
const stats = (arr) => `n=${arr.length} p50=${pct(arr, 0.5)}ms p95=${pct(arr, 0.95)}ms max=${Math.max(0, ...arr)}ms`;
async function pool(items, size, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }

(async () => {
  const stamp = Date.now().toString(36);
  const admin = await prime({});
  ok((await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } })).status === 200, "admin login");
  // 64 real member accounts
  const players = [];
  await pool(Array.from({ length: 64 }, (_, i) => i), 8, async (i) => {
    const jar = await prime({}); const name = `CC ${stamp} P${String(i + 1).padStart(2, "0")}`;
    const s = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: `CC${stamp}${i}`, name, password: "abc12345", phone: `0101${String(i).padStart(7, "0")}`, agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
    ok(s.status === 200 || s.status === 201, "signup " + name, s.json);
    players[i] = { jar, name };
  });
  const byName = Object.fromEntries(players.map((p) => [p.name, p]));
  const T = (ev, s = "") => `/api/admin/tournaments/${ev}${s}`;
  async function mkTournament(label, { scores = false } = {}) {
    const e = await api("/api/events", { method: "POST", jar: admin, form: form({ nameEn: `${label} ${stamp}`, nameAr: label, sport: "PlayStation", date: cairoToday(), maxCapacity: "64" }) });
    const ev = e.json.id;
    await pool(players, 16, async (p) => { const r = await api("/api/register", { method: "POST", jar: p.jar, body: { eventId: ev } }); if (!(r.status === 200 || r.status === 201)) ok(false, "register", r.json); const id = r.json && ((r.json.registration && r.json.registration.id) || r.json.id); if (id) await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: id } }); });
    let r = await api(T(ev), { method: "POST", jar: admin, body: { mode: "individual", format: "knockout", courts: 6, matchMinutes: 15, startTime: "15:00" } });
    ok(r.status === 201, label + ": create", r.json);
    r = await api(T(ev, "/generate"), { method: "POST", jar: admin });
    ok(r.status === 200, label + ": generate", r.json);
    if (scores) await api(T(ev, "/player-scores"), { method: "PUT", jar: admin, body: { enabled: true } });
    return { ev, t: r.json.tournament };
  }
  const getT = async (ev) => (await api(T(ev), { jar: admin })).json.tournament;

  // ---------------- A: 32 staff results at once
  section("A) 32 results submitted at the same moment (one 64-player knockout)");
  const A = await mkTournament("CC-A", { scores: true });
  const lA = [];
  const t0 = Date.now();
  const resA = await Promise.all(A.t.knockout.rounds[0].map((m, i) => api(T(A.ev, "/knockout-result"), { method: "PUT", jar: admin, timed: lA, body: { roundIndex: 0, matchId: m.id, scoreA: 2, scoreB: i % 2 } })));
  const wallA = Date.now() - t0;
  console.log(`  32 simultaneous results: wall ${wallA}ms, ${stats(lA)}`);
  ok(resA.every((r) => r.status === 200), "A: every simultaneous result accepted", resA.filter((r) => r.status !== 200).map((r) => [r.status, r.json]).slice(0, 3));
  let tA = await getT(A.ev);
  ok(tA.knockout.rounds[0].every((m) => m.winnerId), "A: all 32 matches decided (no lost update)");
  const r2ids = tA.knockout.rounds[1].flatMap((m) => [m.a, m.b]);
  const winners = tA.knockout.rounds[0].map((m) => m.winnerId);
  ok(r2ids.length === 32 && new Set(r2ids).size === 32 && winners.every((w) => r2ids.includes(w)), "A: all 32 winners reached Round 2, once each", [r2ids.length, new Set(r2ids).size]);

  // ---------------- B: 64 players report + confirm at once
  section("B) 64 players report their own Round-2 scores at the same moment, then their opponents confirm");
  const r2 = tA.knockout.rounds[1];
  const ref = (m) => ({ eventId: A.ev, kind: "ko", roundIndex: 1, matchId: m.id });
  const lRep = [], lConf = [];
  const reps = await Promise.all(r2.map((m) => api("/api/me/tournament-matches/report", { method: "POST", jar: byName[m.aLabel].jar, timed: lRep, body: { ...ref(m), scoreA: 3, scoreB: 1 } })));
  console.log(`  16 simultaneous reports: ${stats(lRep)}`);
  ok(reps.every((r) => r.status === 200), "B: every report accepted", reps.filter((r) => r.status !== 200).map((r) => [r.status, r.json]).slice(0, 3));
  const cfs = await Promise.all(r2.map((m) => api("/api/me/tournament-matches/confirm", { method: "POST", jar: byName[m.bLabel].jar, timed: lConf, body: ref(m) })));
  console.log(`  16 simultaneous confirmations: ${stats(lConf)}`);
  ok(cfs.every((r) => r.status === 200), "B: every confirmation accepted", cfs.filter((r) => r.status !== 200).map((r) => [r.status, r.json]).slice(0, 3));
  // all 64 players poll their match card at once
  const lMine = [];
  const mines = await Promise.all(players.map((p) => api("/api/me/tournament-matches", { jar: p.jar, timed: lMine })));
  console.log(`  64 players open "My matches" at once: ${stats(lMine)}`);
  ok(mines.every((r) => r.status === 200), "B: every player can load My matches");
  tA = await getT(A.ev);
  ok(tA.knockout.rounds[1].every((m) => m.winnerId === m.a), "B: all 16 confirmed results recorded, winners are the reporting side");
  ok(tA.knockout.rounds[2].flatMap((m) => [m.a, m.b]).filter(Boolean).length === 16, "B: 16 winners reached Round 3");

  // ---------------- C: conflicting submissions for the same match
  section("C) two managers submit opposite results for the same match at the same instant");
  let raceOk = 0;
  for (const m of tA.knockout.rounds[2]) {
    const rs = await Promise.all([
      api(T(A.ev, "/knockout-result"), { method: "PUT", jar: admin, body: { roundIndex: 2, matchId: m.id, scoreA: 5, scoreB: 0 } }),
      api(T(A.ev, "/knockout-result"), { method: "PUT", jar: admin, body: { roundIndex: 2, matchId: m.id, scoreA: 0, scoreB: 5 } }),
      api(T(A.ev, "/knockout-result"), { method: "PUT", jar: admin, body: { roundIndex: 2, matchId: m.id, scoreA: 1, scoreB: 4 } }),
    ]);
    ok(rs.every((r) => r.status === 200 || r.status === 409), "C: no server error on a double submit", rs.map((r) => r.status));
  }
  tA = await getT(A.ev);
  const consistent = tA.knockout.rounds[2].every((m, i) => { const nxt = tA.knockout.rounds[3][Math.floor(i / 2)]; const slot = i % 2 === 0 ? nxt.a : nxt.b; return (m.winnerId === m.a || m.winnerId === m.b) && slot === m.winnerId && ((m.scoreA > m.scoreB) === (m.winnerId === m.a)); });
  ok(consistent, "C: every match ends with ONE coherent winner that matches its score and the next round slot");

  // ---------------- D: 8 tournaments x 32 results at once
  section("D) 8 tournaments running together: 256 results in flight at the same instant");
  const Ds = []; for (let i = 0; i < 8; i++) Ds.push(await mkTournament("CC-D" + i));
  const lD = [];
  const tD = Date.now();
  const resD = await Promise.all(Ds.flatMap((d) => d.t.knockout.rounds[0].map((m, i) => api(T(d.ev, "/knockout-result"), { method: "PUT", jar: admin, timed: lD, body: { roundIndex: 0, matchId: m.id, scoreA: 1, scoreB: i % 2 ? 0 : 3 } }))));
  const wallD = Date.now() - tD;
  console.log(`  256 simultaneous results: wall ${wallD}ms (${Math.round(256 / (wallD / 1000))} results/s), ${stats(lD)}`);
  ok(resD.every((r) => r.status === 200), "D: all 256 simultaneous results accepted", resD.filter((r) => r.status !== 200).map((r) => [r.status, r.json]).slice(0, 3));
  let bad = 0; for (const d of Ds) { const t = await getT(d.ev); if (!t.knockout.rounds[0].every((m) => m.winnerId)) bad++; const ids = t.knockout.rounds[1].flatMap((m) => [m.a, m.b]); if (new Set(ids).size !== 32) bad++; }
  ok(bad === 0, "D: all 8 tournaments fully and correctly recorded", bad);
  // 150 spectators watch the public page while scores come in
  const lPub = [];
  const tP = Date.now();
  const pubs = await Promise.all(Array.from({ length: 300 }, (_, i) => api(`/api/tournaments/${Ds[i % 8].ev}`, { timed: lPub })));
  console.log(`  300 public live-page loads at once: wall ${Date.now() - tP}ms, ${stats(lPub)}`);
  ok(pubs.every((r) => r.status === 200), "D: public page serves 300 simultaneous viewers");

  ok(serverErrors.length === 0, "no 5xx anywhere", serverErrors.slice(0, 5));
  console.log(`\nScore concurrency E2E: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
