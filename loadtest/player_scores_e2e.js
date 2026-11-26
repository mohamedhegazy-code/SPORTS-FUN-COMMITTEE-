// Players report their own scores; the opponent confirms or disputes; the manager can always override.
// Usage: BASE_URL=http://localhost:3951 node player_scores_e2e.js
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
  const mkEvent = async (name) => { const r = await api("/api/events", { method: "POST", jar: admin, form: form({ nameEn: name + " " + stamp, nameAr: name, sport: "Padel", date: cairoToday() }) }); ok(r.status === 201 || r.status === 200, "event " + name, r.json); return r.json.id; };
  const players = {}; // name -> {jar, num}
  const mkPlayer = async (tag, i) => {
    const jar = await prime({}); const num = `PS${stamp}${tag}${i}`; const name = `PS ${tag}${i} ${stamp}`;
    const s = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: num, name, password: "abc12345", phone: `0100${String(i).padStart(7, "0")}`, agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
    ok(s.status === 200 || s.status === 201, "signup " + name, s.json);
    players[name] = { jar, num, name };
    return players[name];
  };
  const register = async (p, eventId) => { const r = await api("/api/register", { method: "POST", jar: p.jar, body: { eventId } }); ok(r.status === 200 || r.status === 201, "register " + p.name, r.json); };
  const byLabel = (label) => players[label];
  const rep = (p, body) => api("/api/me/tournament-matches/report", { method: "POST", jar: p.jar, body });
  const conf = (p, body) => api("/api/me/tournament-matches/confirm", { method: "POST", jar: p.jar, body });
  const disp = (p, body) => api("/api/me/tournament-matches/dispute", { method: "POST", jar: p.jar, body });
  const retr = (p, body) => api("/api/me/tournament-matches/retract", { method: "POST", jar: p.jar, body });
  const mine = async (p) => (await api("/api/me/tournament-matches", { jar: p.jar })).json.matches;
  const adminT = async (ev) => (await api(`/api/admin/tournaments/${ev}`, { jar: admin })).json.tournament;

  section("Knockout: report -> confirm");
  const evK = await mkEvent("PSKO");
  const K = []; for (let i = 1; i <= 4; i++) { const p = await mkPlayer("K", i); K.push(p); await register(p, evK); }
  let r = await api(`/api/admin/tournaments/${evK}`, { method: "POST", jar: admin, body: { mode: "individual", format: "knockout", courts: 2, matchMinutes: 15, startTime: "09:00" } });
  ok(r.status === 201, "create knockout", r.json);
  r = await api(`/api/admin/tournaments/${evK}/generate`, { method: "POST", jar: admin });
  ok(r.status === 200, "generate", r.json);
  const m0 = r.json.tournament.knockout.rounds[0][0];
  const A = byLabel(m0.aLabel), B = byLabel(m0.bLabel);
  const other = K.find((p) => p !== A && p !== B);
  const ref = { eventId: evK, kind: "ko", roundIndex: 0, matchId: m0.id };
  r = await rep(A, { ...ref, scoreA: 3, scoreB: 1 });
  ok(r.status === 403, "switch is off by default -> 403", r.json);
  r = await api(`/api/admin/tournaments/${evK}/player-scores`, { method: "PUT", jar: admin, body: { enabled: true } });
  ok(r.status === 200 && r.json.tournament.playerScores === true, "manager switches it on", r.json);
  ok((await api("/api/me/tournament-matches", { jar: await prime({}) })).status === 401, "my matches needs login");
  let list = await mine(A);
  ok(list.length === 1 && list[0].state === "to_report" && list[0].side === "a", "player sees the match to report", list);
  ok(list[0].aLabel === m0.aLabel && list[0].bLabel === m0.bLabel, "names shown");
  r = await rep(other, { ...ref, scoreA: 1, scoreB: 0 });
  ok(r.status === 403, "someone not in the match can't report", r.json);
  r = await rep(A, { ...ref, scoreA: -1, scoreB: 0 });
  ok(r.status === 400, "negative score rejected", r.json);
  r = await rep(A, { ...ref, scoreA: 2, scoreB: 2 });
  ok(r.status === 400 && r.json.code === "winner_needed", "level knockout score needs a winner", r.json);
  r = await rep(A, { ...ref, scoreA: 3, scoreB: 1 });
  ok(r.status === 200, "player A reports 3-1", r.json);
  list = await mine(A); ok(list[0].state === "waiting_opponent" && list[0].report.scoreA === 3, "A waits for the opponent", list[0]);
  list = await mine(B); ok(list[0].state === "to_confirm" && list[0].report.scoreA === 3 && list[0].side === "b", "B has a score to confirm", list[0]);
  r = await conf(A, ref); ok(r.status === 403, "reporter can't confirm own score", r.json);
  r = await rep(B, { ...ref, scoreA: 0, scoreB: 5 }); ok(r.status === 409 && r.json.code === "opponent_reported", "opponent must confirm/dispute instead of re-reporting", r.json);
  const pub = (await api(`/api/tournaments/${evK}`)).json;
  ok(!JSON.stringify(pub).includes('"report"') && !JSON.stringify(pub).includes(A.num), "public tournament never exposes reports");
  const adm = await adminT(evK);
  ok(adm.knockout.rounds[0][0].report && adm.knockout.rounds[0][0].report.scoreA === 3 && !adm.knockout.rounds[0][0].winnerId, "manager sees the pending report, not yet official", adm.knockout.rounds[0][0]);
  r = await retr(A, ref); ok(r.status === 200, "A takes the report back");
  list = await mine(B); ok(list[0].state === "to_report", "back to to_report", list[0]);
  await rep(A, { ...ref, scoreA: 3, scoreB: 1 });
  r = await disp(B, { ...ref, note: "I won 3-2" }); ok(r.status === 200, "B disputes", r.json);
  list = await mine(A); ok(list[0].state === "disputed" && list[0].report.disputeNote === "I won 3-2", "A sees the dispute", list[0]);
  r = await conf(B, ref); ok(r.status === 409, "disputed score can't be confirmed", r.json);
  ok((await adminT(evK)).knockout.rounds[0][0].report.status === "disputed", "manager sees the dispute");
  r = await api(`/api/admin/tournaments/${evK}/report-clear`, { method: "PUT", jar: admin, body: { kind: "ko", roundIndex: 0, matchId: m0.id } });
  ok(r.status === 200 && !r.json.tournament.knockout.rounds[0][0].report, "manager dismisses the report", r.json);
  r = await rep(B, { ...ref, scoreA: 1, scoreB: 1, winner: "b" });
  ok(r.status === 200, "B reports a level score with a penalties winner", r.json);
  r = await conf(A, ref); ok(r.status === 200, "A confirms", r.json);
  const after = await adminT(evK);
  const mm = after.knockout.rounds[0][0];
  ok(mm.winnerId === m0.b && mm.scoreA === 1 && mm.scoreB === 1 && !mm.report, "confirmed score is official; winner = penalties winner", mm);
  ok(after.knockout.rounds[1][0].a === m0.b || after.knockout.rounds[1][0].b === m0.b, "winner advanced to the next round");
  list = await mine(A); ok(list.some((x) => x.state === "done" && x.result.winnerId === m0.b), "done shows in history", list);
  r = await rep(A, { ...ref, scoreA: 9, scoreB: 0 }); ok(r.status === 409, "can't report a decided match", r.json);
  // manager edit of a confirmed result
  r = await api(`/api/admin/tournaments/${evK}/knockout-result`, { method: "PUT", jar: admin, body: { roundIndex: 0, matchId: m0.id, winnerId: m0.b, scoreA: 2, scoreB: 4 } });
  ok(r.status === 200 && r.json.tournament.knockout.rounds[0][0].scoreB === 4, "manager can edit the confirmed score", r.json);
  // manager's Save while a report is pending clears it
  const m1 = after.knockout.rounds[0][1];
  const C = byLabel(m1.aLabel), D = byLabel(m1.bLabel);
  await rep(C, { eventId: evK, kind: "ko", roundIndex: 0, matchId: m1.id, scoreA: 1, scoreB: 0 });
  r = await api(`/api/admin/tournaments/${evK}/knockout-result`, { method: "PUT", jar: admin, body: { roundIndex: 0, matchId: m1.id, winnerId: m1.b, scoreA: 0, scoreB: 2 } });
  ok(r.status === 200 && !r.json.tournament.knockout.rounds[0][1].report, "manager result replaces a pending report", r.json);
  ok((await mine(D)).find((x) => x.matchId === m1.id).state === "done", "players see the manager's result");

  section("Groups");
  const evG = await mkEvent("PSGR");
  const G = []; for (let i = 1; i <= 4; i++) { const p = await mkPlayer("G", i); G.push(p); await register(p, evG); }
  await api(`/api/admin/tournaments/${evG}`, { method: "POST", jar: admin, body: { mode: "individual", format: "groups", numGroups: 2, advancePerGroup: 1, courts: 2, matchMinutes: 10, startTime: "10:00" } });
  r = await api(`/api/admin/tournaments/${evG}/generate`, { method: "POST", jar: admin });
  const gm = r.json.tournament.groups[0].matches[0];
  await api(`/api/admin/tournaments/${evG}/player-scores`, { method: "PUT", jar: admin, body: { enabled: true } });
  const gA = byLabel(gm.aLabel), gB = byLabel(gm.bLabel);
  const gref = { eventId: evG, kind: "gr", matchId: gm.id };
  r = await rep(gB, { ...gref, scoreA: 0, scoreB: 2 }); ok(r.status === 200, "B reports 0-2 (a-b order)", r.json);
  r = await conf(gA, gref); ok(r.status === 200, "A confirms", r.json);
  const gt = await adminT(evG);
  const gmatch = gt.groups[0].matches.find((x) => x.id === gm.id);
  ok(gmatch.result && gmatch.result.scoreA === 0 && gmatch.result.scoreB === 2 && gmatch.result.winnerId === gm.b, "group result recorded; table updated", gmatch);
  ok(gt.groups[0].standings.find((s) => s.entrantId === gm.b).points === 3, "winner has 3 points");
  r = await rep(gA, { ...gref, scoreA: 1, scoreB: 1 }); ok(r.status === 409, "decided group match can't be reported again");

  section("Swiss");
  const evS = await mkEvent("PSSW");
  const S = []; for (let i = 1; i <= 4; i++) { const p = await mkPlayer("S", i); S.push(p); await register(p, evS); }
  await api(`/api/admin/tournaments/${evS}`, { method: "POST", jar: admin, body: { mode: "individual", format: "swiss", swissRounds: 2 } });
  r = await api(`/api/admin/tournaments/${evS}/generate`, { method: "POST", jar: admin });
  ok(r.status === 200, "swiss round 1", r.json);
  await api(`/api/admin/tournaments/${evS}/player-scores`, { method: "PUT", jar: admin, body: { enabled: true } });
  const rd = r.json.tournament.swiss.rounds[0];
  for (const pr of rd.pairings.filter((x) => x.b != null)) {
    const w = byLabel(pr.aLabel), l = byLabel(pr.bLabel);
    const sref = { eventId: evS, kind: "sw", roundNumber: 1, matchId: pr.id };
    r = await rep(w, { ...sref, result: "bad" }); ok(r.status === 400, "bad swiss result rejected");
    r = await rep(w, { ...sref, result: "1-0" }); ok(r.status === 200, "swiss report", r.json);
    r = await conf(l, sref); ok(r.status === 200, "swiss confirm", r.json);
  }
  const st = await adminT(evS);
  ok(st.swiss.rounds[0].pairings.filter((x) => x.b != null).every((x) => x.result === "1-0" && !x.report), "swiss results recorded");
  ok(!JSON.stringify((await api(`/api/tournaments/${evS}`)).json).includes('"report":{'), "public swiss has no reports");

  section("Guards");
  const evC = await mkEvent("PSCAS");
  await api(`/api/admin/tournaments/${evC}`, { method: "POST", jar: admin, body: { mode: "individual", format: "casual" } });
  r = await api(`/api/admin/tournaments/${evC}/player-scores`, { method: "PUT", jar: admin, body: { enabled: true } });
  ok(r.status === 400, "fun sessions have no scores to report", r.json);
  const stranger = await mkPlayer("X", 1);
  r = await api(`/api/admin/tournaments/${evK}/player-scores`, { method: "PUT", jar: stranger.jar, body: { enabled: false } });
  ok(r.status === 401 || r.status === 403, "players can't switch it", r.status);
  r = await api(`/api/admin/tournaments/${evK}/report-clear`, { method: "PUT", jar: stranger.jar, body: { kind: "ko", roundIndex: 0, matchId: 1 } });
  ok(r.status === 401 || r.status === 403, "players can't clear reports", r.status);
  r = await rep(stranger, { eventId: evK, kind: "ko", roundIndex: 0, matchId: m0.id, scoreA: 1, scoreB: 0 });
  ok(r.status === 403, "an unregistered member can't report", r.json);
  r = await api(`/api/admin/tournaments/${evK}/player-scores`, { method: "PUT", jar: admin, body: { enabled: false } });
  ok(r.status === 200 && r.json.tournament.playerScores === false, "manager switches it off");
  ok((await mine(A)).length === 0, "off -> nothing to report");
  ok(serverErrors.length === 0, "no 5xx", serverErrors);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
