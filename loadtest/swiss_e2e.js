// Swiss chess tournament end-to-end test (real HTTP API, throwaway server).
// Usage: BASE_URL=http://localhost:3911 N=33 node swiss_e2e.js
"use strict";
const BASE = process.env.BASE_URL || "http://localhost:3911";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
const N = Number(process.env.N || 33);
const ROUNDS = 7;

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ""); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const newJar = () => ({});
function applySetCookies(jar, res) {
  const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const raw of sc) { const [pair] = raw.split(";"); const eq = pair.indexOf("="); if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); }
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
async function api(path, { method = "GET", body, jar, noCsrf = false, isForm = false } = {}) {
  jar = jar || newJar();
  const headers = {};
  if (Object.keys(jar).length) headers.Cookie = cookieHeader(jar);
  if (!["GET", "HEAD"].includes(method) && jar.csrfToken && !noCsrf) headers["X-CSRF-Token"] = jar.csrfToken;
  let fb;
  if (body !== undefined) { if (isForm) fb = body; else { headers["Content-Type"] = "application/json"; fb = JSON.stringify(body); } }
  const res = await fetch(BASE + path, { method, headers, body: fb, redirect: "manual" });
  applySetCookies(jar, res);
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, jar };
}
const prime = async (jar) => { await api("/", { jar }); return jar; };

let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

async function main() {
  section("Setup");
  const admin = await prime(newJar());
  let r = await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } });
  ok(r.status === 200, "admin login", r.json);

  async function signup(num, name) {
    const jar = await prime(newJar());
    const res = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: `SW${num}`, name: name || `Swiss Player ${num}`, password: "abc12345", phone: `0111${String(num).padStart(7, "0")}`, agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
    return { jar, res };
  }
  const form = new FormData();
  form.set("nameEn", "Al Ahly Rapid Chess"); form.set("nameAr", "بطولة الشطرنج"); form.set("sport", "Chess"); form.set("date", "2026-10-23");
  r = await api("/api/events", { method: "POST", jar: admin, body: form, isForm: true });
  ok(r.status === 200 || r.status === 201, "create event", r.json);
  const eventId = r.json.id;

  // Events list shows no ranking categories yet
  r = await api("/api/events");
  ok(r.json.find((e) => e.id === eventId).rankingCategories === false, "rankingCategories false before tournament");

  section("Validation of tournament creation");
  r = await api(`/api/admin/tournaments/${eventId}`, { method: "POST", jar: admin, body: { mode: "team", format: "swiss" } });
  ok(r.status === 400, "swiss rejects team mode", r.json);
  for (const bad of [0, 31, 2.5, "abc"]) {
    r = await api(`/api/admin/tournaments/${eventId}`, { method: "POST", jar: admin, body: { mode: "individual", format: "swiss", swissRounds: bad } });
    ok(r.status === 400, `swissRounds ${bad} rejected`, r.json);
  }

  section("Players register (some with categories)");
  const players = [];
  const specials = { women: new Set(), junior: new Set(), both: new Set() };
  const names = [];
  for (let i = 1; i <= N; i++) {
    const name = i === 3 ? "<img src=x onerror=alert(1)> Evil" : `Swiss Player ${i}`;
    names.push(name);
  }
  // sign up in small parallel batches
  for (let i = 1; i <= N; i += 6) {
    const batch = [];
    for (let k = i; k < Math.min(N + 1, i + 6); k++) batch.push(signup(k, names[k - 1]).then((s) => { players[k - 1] = s.jar; ok(s.res.status === 200 || s.res.status === 201, `signup ${k}`, s.res.json); }));
    await Promise.all(batch);
  }
  // create tournament first so registration sees rankingCategories
  r = await api(`/api/admin/tournaments/${eventId}`, { method: "POST", jar: admin, body: { mode: "individual", format: "swiss", swissRounds: ROUNDS, courts: 25, matchMinutes: 25, startTime: "15:00", breakMinutes: 5 } });
  ok(r.status === 201, "create swiss tournament", r.json);
  ok(r.json.tournament.format === "swiss" && r.json.tournament.swiss && r.json.tournament.swiss.totalRounds === ROUNDS, "swiss payload present");
  ok(r.json.tournament.status === "seeding", "status seeding", r.json.tournament.status);
  r = await api(`/api/admin/tournaments/${eventId}`, { method: "POST", jar: admin, body: { mode: "individual", format: "swiss" } });
  ok(r.status === 400, "second tournament for same event rejected");
  r = await api("/api/events");
  ok(r.json.find((e) => e.id === eventId).rankingCategories === true, "rankingCategories true after swiss tournament");

  const regIds = [];
  for (let i = 0; i < N; i++) {
    const women = i % 5 === 1; // ~20%
    const junior = i % 7 === 2; // ~14%
    if (women) specials.women.add(i); if (junior) specials.junior.add(i);
    const body = { eventId };
    if (women) body.women = true; if (junior) body.junior = true;
    const rr = await api("/api/register", { method: "POST", jar: players[i], body });
    ok(rr.status === 201, `register ${i + 1}`, rr.json);
    regIds[i] = rr.json.registration.id;
    ok(rr.json.registration.catWomen === women && rr.json.registration.catJunior === junior, `flags stored ${i + 1}`, rr.json.registration);
  }

  section("Member category self-service + staff correction");
  // player 0: toggle via member endpoint
  r = await api(`/api/me/registrations/${regIds[0]}/categories`, { method: "PUT", jar: players[0], body: { women: true, junior: false } });
  ok(r.status === 200 && r.json.catWomen === true, "member sets own categories", r.json);
  specials.women.add(0);
  r = await api(`/api/me/registrations/${regIds[0]}/categories`, { method: "PUT", jar: players[1], body: { women: false, junior: true } });
  ok(r.status === 404, "member cannot change someone else's categories", r.json);
  r = await api(`/api/me/registrations/${regIds[0]}/categories`, { method: "PUT", jar: players[0], body: { women: "yes", junior: 1 } });
  ok(r.status === 400, "non-boolean rejected", r.json);
  r = await api(`/api/me/registrations/${regIds[0]}/categories`, { method: "PUT", jar: await prime(newJar()), body: { women: true, junior: true } });
  ok(r.status === 401 || r.status === 403, "anonymous cannot set categories", r.status);
  r = await api(`/api/me/registrations`, { jar: players[0] });
  ok(r.json[0].rankingCategories === true && r.json[0].categoriesLocked === false, "my registrations shows picker state", r.json[0]);
  r = await api(`/api/admin/tournaments/${eventId}/categories`, { method: "PUT", jar: admin, body: { registrationId: regIds[4], women: true, junior: true } });
  ok(r.status === 200, "staff sets categories", r.json);
  specials.women.add(4); specials.junior.add(4);
  r = await api(`/api/admin/tournaments/${eventId}/categories`, { method: "PUT", jar: admin, body: { registrationId: 999999, women: true, junior: true } });
  ok(r.status === 404, "staff categories: unknown registration");
  r = await api(`/api/admin/tournaments/${eventId}/categories`, { method: "PUT", jar: players[0], body: { registrationId: regIds[4], women: false, junior: false } });
  ok(r.status === 401 || r.status === 403, "member cannot use staff categories endpoint", r.status);

  section("Admin-editable rounds + prizes (before round 1)");
  const SET = `/api/admin/tournaments/${eventId}/swiss/settings`;
  r = await api(`/api/tournaments/${eventId}`);
  ok(r.json.tournament.swiss.hasPrizes === false && r.json.tournament.swiss.prizeTotal === 0, "no prizes by default");
  ok(r.json.tournament.swiss.places.open === 3 && r.json.tournament.swiss.places.women === 3, "podium of 3 shown when no prizes");
  r = await api(SET, { method: "PUT", jar: admin, body: { totalRounds: 9 } });
  ok(r.status === 200 && r.json.tournament.swiss.totalRounds === 9, "rounds raised to 9", r.json);
  r = await api(SET, { method: "PUT", jar: admin, body: { totalRounds: 30 } });
  ok(r.status === 200 && r.json.tournament.swiss.totalRounds === 30, "rounds up to 30 allowed");
  for (const bad of [0, 31, 2.5, "abc", "", null]) {
    r = await api(SET, { method: "PUT", jar: admin, body: { totalRounds: bad } });
    ok(r.status === 400, `settings: totalRounds ${JSON.stringify(bad)} rejected`, r.json);
  }
  const badPrizes = [[{ open: [-5] }, "negative"], [{ open: ["abc"] }, "text"], [{ open: [1e9] }, "too large"], [{ open: new Array(21).fill(1) }, "too many places"], [[1, 2], "array"], ["x", "string"], [{ women: "100" }, "not a list"]];
  for (const [p, why] of badPrizes) {
    r = await api(SET, { method: "PUT", jar: admin, body: { prizes: p } });
    ok(r.status === 400, `settings: prizes rejected (${why})`, r.json);
  }
  r = await api(SET, { method: "PUT", jar: await prime(newJar()), body: { totalRounds: 5 } });
  ok(r.status === 401 || r.status === 403, "settings: anonymous blocked");
  r = await api(SET, { method: "PUT", jar: admin, body: { totalRounds: ROUNDS, prizes: { open: [2500, "1500", 1000, 700, 500], women: [1000, 600, 400], junior: [800, 600, 400] } } });
  ok(r.status === 200 && r.json.tournament.swiss.totalRounds === ROUNDS && r.json.tournament.swiss.prizeTotal === 10000 && r.json.tournament.swiss.hasPrizes, "flyer prizes + 7 rounds saved", r.json);
  ok(r.json.tournament.swiss.places.open === 5 && r.json.tournament.swiss.places.women === 3, "places follow prize lists");

  section("Error paths before round 1");
  r = await api(`/api/admin/tournaments/${eventId}/swiss/next-round`, { method: "POST", jar: admin });
  ok(r.status === 400, "next-round before round 1 rejected", r.json);
  r = await api(`/api/admin/tournaments/${eventId}/swiss/undo-round`, { method: "POST", jar: admin });
  ok(r.status === 400, "undo with no rounds rejected");
  r = await api(`/api/admin/tournaments/${eventId}/reseed`, { method: "POST", jar: admin });
  ok(r.status === 400, "reseed refused for swiss");

  section("Round 1 draw");
  r = await api(`/api/admin/tournaments/${eventId}/generate`, { method: "POST", jar: admin });
  ok(r.status === 200, "generate round 1", r.json);
  let tn = r.json.tournament;
  ok(tn.status === "swiss" && tn.swiss.generatedRounds === 1, "status swiss, 1 round", tn.status);
  r = await api(`/api/admin/tournaments/${eventId}/generate`, { method: "POST", jar: admin });
  ok(r.status === 400, "generate twice rejected");
  r = await api(`/api/me/registrations/${regIds[0]}/categories`, { method: "PUT", jar: players[0], body: { women: false, junior: false } });
  ok(r.status === 400, "member categories locked after round 1", r.json);
  r = await api(`/api/me/registrations/${regIds[5]}`, { method: "DELETE", jar: players[5] });
  ok(r.status === 400, "cancel blocked after draw", r.json);
  // bye in odd field
  const rd1 = tn.swiss.rounds[0];
  ok(rd1.pairings.filter((p) => p.b == null).length === N % 2, "bye count round 1");
  ok(rd1.time === "15:00", "round 1 time from schedule", rd1.time);
  r = await api(`/api/admin/tournaments/${eventId}/swiss/next-round`, { method: "POST", jar: admin });
  ok(r.status === 400 && /without a result/.test(r.json.error), "next-round blocked until results in", r.json);

  section("Result validation + arbiter tools");
  const p0 = rd1.pairings.find((p) => p.b != null);
  for (const bad of ["2-0", "1-1", "", 5, "white", "1/2"]) {
    r = await api(`/api/admin/tournaments/${eventId}/swiss/result`, { method: "PUT", jar: admin, body: { roundNumber: 1, pairingId: p0.id, result: bad } });
    ok(r.status === 400, `result ${JSON.stringify(bad)} rejected`, r.json);
  }
  r = await api(`/api/admin/tournaments/${eventId}/swiss/result`, { method: "PUT", jar: admin, body: { roundNumber: 9, pairingId: p0.id, result: "1-0" } });
  ok(r.status === 404, "unknown round");
  r = await api(`/api/admin/tournaments/${eventId}/swiss/result`, { method: "PUT", jar: admin, body: { roundNumber: 1, pairingId: 99999, result: "1-0" } });
  ok(r.status === 404, "unknown pairing");
  const byeP = rd1.pairings.find((p) => p.b == null);
  if (byeP) {
    r = await api(`/api/admin/tournaments/${eventId}/swiss/result`, { method: "PUT", jar: admin, body: { roundNumber: 1, pairingId: byeP.id, result: "1-0" } });
    ok(r.status === 400, "cannot set result on a bye", r.json);
  }
  // swap two players on different boards (round 1 still has no results)
  const pA = rd1.pairings.filter((p) => p.b != null)[0], pB = rd1.pairings.filter((p) => p.b != null)[1];
  r = await api(`/api/admin/tournaments/${eventId}/swiss/swap`, { method: "PUT", jar: admin, body: { a: pA.a, b: pB.b } });
  ok(r.status === 200, "swap players across boards", r.json);
  let r1 = r.json.tournament.swiss.rounds[0];
  ok(r1.pairings.find((p) => p.id === pA.id).a === pB.b && r1.pairings.find((p) => p.id === pB.id).b === pA.a, "swap applied");
  // swap back
  r = await api(`/api/admin/tournaments/${eventId}/swiss/swap`, { method: "PUT", jar: admin, body: { a: pA.a, b: pB.b } });
  ok(r.status === 200, "swap back");
  // flip colours on one board
  r = await api(`/api/admin/tournaments/${eventId}/swiss/swap`, { method: "PUT", jar: admin, body: { a: pA.a, b: pA.b } });
  ok(r.status === 200 && r.json.tournament.swiss.rounds[0].pairings.find((p) => p.id === pA.id).a === pA.b, "flip colours");
  r = await api(`/api/admin/tournaments/${eventId}/swiss/swap`, { method: "PUT", jar: admin, body: { a: pA.a, b: pA.a } });
  ok(r.status === 400, "swap same player rejected");
  r = await api(`/api/admin/tournaments/${eventId}/swiss/swap`, { method: "PUT", jar: admin, body: { a: "nope", b: pA.a } });
  ok(r.status === 400, "swap unknown player rejected");
  // undo round 1 then redraw
  r = await api(`/api/admin/tournaments/${eventId}/swiss/undo-round`, { method: "POST", jar: admin });
  ok(r.status === 200 && r.json.tournament.status === "seeding" && r.json.tournament.swiss.generatedRounds === 0, "undo round 1 returns to seeding", r.json && r.json.tournament && r.json.tournament.status);
  r = await api(`/api/admin/tournaments/${eventId}/generate`, { method: "POST", jar: admin });
  ok(r.status === 200, "redraw round 1");
  tn = r.json.tournament;

  section("Role / auth checks");
  const staffJar = await prime(newJar());
  // create a plain 'staff' role account
  r = await api("/api/staff/accounts", { method: "POST", jar: admin, body: { username: "swissgate", password: "Gate!Pass2026xyz", role: "staff", name: "Gate" } });
  ok(r.status === 201 || r.status === 200, "create staff account", r.json);
  r = await api("/api/auth/staff-login", { method: "POST", jar: staffJar, body: { username: "swissgate", password: "Gate!Pass2026xyz" } });
  ok(r.status === 200, "staff login", r.json);
  for (const [m, path, body] of [
    ["POST", `/api/admin/tournaments/${eventId}/swiss/next-round`, {}],
    ["POST", `/api/admin/tournaments/${eventId}/swiss/undo-round`, {}],
    ["PUT", `/api/admin/tournaments/${eventId}/swiss/result`, { roundNumber: 1, pairingId: 1, result: "1-0" }],
    ["PUT", `/api/admin/tournaments/${eventId}/swiss/swap`, { a: "x", b: "y" }],
    ["PUT", `/api/admin/tournaments/${eventId}/swiss/withdraw`, { entrantId: "x", withdrawn: true }],
    ["PUT", `/api/admin/tournaments/${eventId}/swiss/settings`, { totalRounds: 5 }],
    ["PUT", `/api/admin/tournaments/${eventId}/categories`, { registrationId: 1, women: true, junior: false }],
  ]) {
    r = await api(path, { method: m, jar: staffJar, body });
    ok(r.status === 403 || r.status === 401, `staff role blocked: ${path.split("/").slice(-2).join("/")}`, r.status);
    r = await api(path, { method: m, jar: players[0], body });
    ok(r.status === 403 || r.status === 401, `member blocked: ${path.split("/").slice(-2).join("/")}`, r.status);
    r = await api(path, { method: m, jar: admin, body, noCsrf: true });
    ok(r.status === 403, `no CSRF blocked: ${path.split("/").slice(-2).join("/")}`, r.status);
  }

  section("Play 7 rounds");
  const regOfEntrant = {};
  tn.entrants.forEach((e) => (regOfEntrant[e.id] = e.registrationIds[0]));
  const strength = {};
  tn.entrants.forEach((e) => (strength[e.id] = rnd()));
  const seenPairs = new Set();
  let withdrew = null;
  for (let round = 1; round <= ROUNDS; round++) {
    const rd = tn.swiss.rounds[round - 1];
    ok(rd.number === round, `round ${round} number`);
    // validity
    const inRound = new Set();
    for (const p of rd.pairings) {
      ok(!inRound.has(p.a), `r${round} dup ${p.a}`); inRound.add(p.a);
      if (p.b != null) {
        ok(!inRound.has(p.b), `r${round} dup ${p.b}`); inRound.add(p.b);
        const key = [p.a, p.b].sort().join("|");
        ok(!seenPairs.has(key), `r${round} rematch ${key}`);
        seenPairs.add(key);
      }
    }
    const expectActive = tn.entrants.length - (withdrew && round > 2 ? 1 : 0);
    ok(inRound.size === expectActive, `r${round}: ${inRound.size} paired vs ${expectActive} active`);
    ok(rd.time !== null, `r${round} has time`, rd.time);
    // enter results
    for (const p of rd.pairings) {
      if (p.b == null) continue;
      const d = strength[p.a] - strength[p.b] + (rnd() - 0.5) * 0.4;
      let result = Math.abs(d) < 0.07 ? "1/2-1/2" : d > 0 ? "1-0" : "0-1";
      if (round === 4 && p === rd.pairings[0]) result = "1-0f";
      r = await api(`/api/admin/tournaments/${eventId}/swiss/result`, { method: "PUT", jar: admin, body: { roundNumber: round, pairingId: p.id, result } });
      ok(r.status === 200, `r${round} result`, r.json);
      tn = r.json.tournament;
    }
    ok(tn.swiss.rounds[round - 1].complete === true, `round ${round} complete`);
    if (round === 2) {
      // withdraw someone after round 2 (they sit out round 3+... we withdraw after round 3 draw is not made yet)
      const victim = tn.swiss.standings[tn.swiss.standings.length - 1].entrantId;
      r = await api(`/api/admin/tournaments/${eventId}/swiss/withdraw`, { method: "PUT", jar: admin, body: { entrantId: victim, withdrawn: true } });
      ok(r.status === 200, "withdraw", r.json);
      withdrew = victim;
      ok(r.json.tournament.swiss.withdrawn.some((w) => w.entrantId === victim), "withdrawn listed");
    }
    if (round === 3) {
      // withdrawn set after round 2 means round 3 already excludes them -> adjust expectation
    }
    if (round < ROUNDS) {
      // mid-event: correct a result in the previous round (correction allowed)
      r = await api(`/api/admin/tournaments/${eventId}/swiss/next-round`, { method: "POST", jar: admin });
      ok(r.status === 200, `draw round ${round + 1}`, r.json);
      tn = r.json.tournament;
    }
  }
  // fix: expectation for withdrawn in rounds 3.. was computed using round>3; verify directly
  ok(tn.status === "completed", "tournament completed after last result", tn.status);
  ok(tn.swiss.final === true, "swiss.final");
  r = await api(`/api/admin/tournaments/${eventId}/swiss/next-round`, { method: "POST", jar: admin });
  ok(r.status === 400, "no round 8", r.json);

  section("Standings / rankings integrity");
  const st = tn.swiss.standings;
  ok(st.length === N, "standings has everyone", st.length);
  for (let i = 1; i < st.length; i++) ok(st[i - 1].points >= st[i].points, "points sorted");
  ok(st.every((x, i) => x.rank === i + 1), "ranks 1..N");
  const totalPts = st.reduce((s, x) => s + x.points, 0);
  const totalGames = tn.swiss.rounds.reduce((s, rd) => s + rd.pairings.length, 0);
  ok(Math.abs(totalPts - totalGames) < 1e-9, `points conserved ${totalPts} vs ${totalGames}`);
  const rk = tn.swiss.rankings;
  ok(rk.open.length === 5 && rk.women.length === 3 && rk.junior.length === 3, "5/3/3 prize places", [rk.open.length, rk.women.length, rk.junior.length]);
  ok(rk.women.every((x) => st.find((s) => s.entrantId === x.entrantId).women), "women ranking only women");
  ok(rk.junior.every((x) => st.find((s) => s.entrantId === x.entrantId).junior), "junior ranking only juniors");
  ok(rk.open.map((x) => x.prize).join() === "2500,1500,1000,700,500", "open prizes");
  ok(rk.women.map((x) => x.prize).join() === "1000,600,400" && rk.junior.map((x) => x.prize).join() === "800,600,400", "women/junior prizes");
  ok(tn.swiss.prizeTotal === 10000, "prize total 10000", tn.swiss.prizeTotal);
  // each category ranking order is consistent with overall order
  const womenOrder = st.filter((x) => x.women && x.recorded > 0).slice(0, 3).map((x) => x.entrantId).join();
  ok(womenOrder === rk.women.map((x) => x.entrantId).join(), "women ranking follows overall order");
  // a player in both categories appears in both
  const both = st.find((x) => x.women && x.junior);
  ok(!!both, "someone is in both categories");
  ok(tn.standings && tn.standings.length === 5, "generic standings = top 5", tn.standings && tn.standings.length);
  // withdrawn player kept their points
  const wd = st.find((x) => x.entrantId === withdrew);
  ok(wd && wd.withdrawn === true, "withdrawn flag in standings");
  ok(tn.swiss.rounds[2].pairings.every((p) => p.a !== withdrew && p.b !== withdrew), "withdrawn player not drawn in round 3");

  section("Public view");
  r = await api(`/api/tournaments/${eventId}`);
  ok(r.status === 200 && r.json.tournament.swiss && r.json.tournament.swiss.rankings.open.length === 5, "public swiss view", r.status);
  ok(!JSON.stringify(r.json).includes("membershipNumber"), "no membership numbers leaked publicly");
  r = await api(`/api/tournaments`);
  ok(r.json.some((x) => x.eventId === eventId && x.format === "swiss"), "listed publicly as swiss");

  section("Result correction after completion + award points");
  r = await api(`/api/admin/tournaments/${eventId}/award-points`, { method: "POST", jar: admin });
  ok(r.status === 200 && r.json.updated >= 5, "award points", r.json && r.json.updated);
  const winner = rk.open[0].entrantId;
  const winnerReg = regOfEntrant[winner];
  r = await api(`/api/me/registrations`, { jar: players[regIds.indexOf(winnerReg)] });
  ok(r.json.find((x) => x.id === winnerReg).position === 1, "winner has position 1", r.json.find((x) => x.id === winnerReg));
  // clear a result in an earlier round -> not allowed
  const early = tn.swiss.rounds[0].pairings.find((p) => p.b != null);
  r = await api(`/api/admin/tournaments/${eventId}/swiss/result`, { method: "PUT", jar: admin, body: { roundNumber: 1, pairingId: early.id, result: null } });
  ok(r.status === 400, "cannot clear earlier-round result", r.json);
  // correct it instead
  const flipped = early.result === "1-0" ? "0-1" : "1-0";
  r = await api(`/api/admin/tournaments/${eventId}/swiss/result`, { method: "PUT", jar: admin, body: { roundNumber: 1, pairingId: early.id, result: flipped } });
  ok(r.status === 200 && r.json.tournament.status === "completed", "correction keeps completed", r.json && r.json.tournament && r.json.tournament.status);
  // clear last-round result -> reopens
  const lastRound = r.json.tournament.swiss.rounds[ROUNDS - 1];
  const lp = lastRound.pairings.find((p) => p.b != null);
  r = await api(`/api/admin/tournaments/${eventId}/swiss/result`, { method: "PUT", jar: admin, body: { roundNumber: ROUNDS, pairingId: lp.id, result: null } });
  ok(r.status === 200 && r.json.tournament.status === "swiss" && r.json.tournament.standings === null, "clearing last result reopens", r.json && r.json.tournament && r.json.tournament.status);
  r = await api(`/api/admin/tournaments/${eventId}/swiss/result`, { method: "PUT", jar: admin, body: { roundNumber: ROUNDS, pairingId: lp.id, result: lp.result } });
  ok(r.status === 200 && r.json.tournament.status === "completed", "re-entering completes again");

  async function getHtml(path, jar) {
    const headers = {};
    if (jar && Object.keys(jar).length) headers.Cookie = cookieHeader(jar);
    const res = await fetch(BASE + path, { headers });
    return { status: res.status, text: await res.text(), type: res.headers.get("content-type") || "" };
  }

  section("Editing rounds / prizes after play");
  r = await api(`/api/admin/tournaments/${eventId}/schedule`, { method: "PUT", jar: admin, body: { courts: 25, matchMinutes: 30, startTime: "16:00", breakMinutes: 10 } });
  const t2 = r.json.tournament;
  const mins = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
  ok(r.status === 200 && t2.swiss.rounds[0].time === "16:00" && mins(t2.swiss.rounds[1].time) - mins(t2.swiss.rounds[0].time) === t2.swiss.rounds[0].waves * 30 + 10, "game time/start/break editable: round times recalculated", t2.swiss.rounds.slice(0, 2).map((x) => x.time));
  ok(t2.schedule.matchMinutes === 30 && t2.schedule.startTime === "16:00" && t2.schedule.breakMinutes === 10, "schedule stored");
  r = await api(`/api/admin/tournaments/${eventId}/schedule`, { method: "PUT", jar: admin, body: { courts: 25, matchMinutes: 0, startTime: "16:00" } });
  ok(r.status === 400, "bad game time rejected");
  r = await api(`/api/admin/tournaments/${eventId}/schedule`, { method: "PUT", jar: admin, body: { courts: 25, matchMinutes: 25, startTime: "15:00", breakMinutes: 5 } });
  ok(r.status === 200 && r.json.tournament.swiss.rounds[0].time === "15:00", "schedule restored");
  r = await api(SET, { method: "PUT", jar: admin, body: { totalRounds: ROUNDS + 1 } });
  ok(r.status === 200 && r.json.tournament.status === "swiss" && r.json.tournament.swiss.canGenerateNext && r.json.tournament.swiss.nextRound === ROUNDS + 1, "raising rounds reopens the event for another round", r.json && r.json.tournament && r.json.tournament.status);
  r = await api(SET, { method: "PUT", jar: admin, body: { totalRounds: ROUNDS } });
  ok(r.status === 200 && r.json.tournament.status === "completed", "back to 7 completes again");
  r = await api(SET, { method: "PUT", jar: admin, body: { totalRounds: ROUNDS - 1 } });
  ok(r.status === 400, "cannot go below rounds already drawn", r.json);
  r = await api(SET, { method: "PUT", jar: admin, body: { prizes: { open: [], women: [], junior: [] } } });
  const sw0 = r.json.tournament.swiss;
  ok(r.status === 200 && !sw0.hasPrizes && sw0.prizeTotal === 0 && sw0.rankings.open.length === 3 && sw0.rankings.open.every((x) => x.prize === null), "clearing prizes -> podium without amounts");
  for (const lang of ["ar", "en"]) {
    const noP = await getHtml(`/admin/print/tournament/${eventId}?view=regulation&lang=${lang}`, admin);
    ok(noP.status === 200 && !noP.text.includes("10,000") && !noP.text.includes("2,500") && !/Total prize fund|إجمالي جوائز/.test(noP.text), `regulation (${lang}) hides prizes when none`);
    const noS = await getHtml(`/admin/print/tournament/${eventId}?view=standings&lang=${lang}`, admin);
    ok(noS.status === 200 && !noS.text.includes("EGP") && !noS.text.includes("جنيه"), `standings sheet (${lang}) shows no amounts when none`);
  }
  r = await api(SET, { method: "PUT", jar: admin, body: { prizes: { open: [3000, 2000], women: [], junior: [500] } } });
  const sw1 = r.json.tournament.swiss;
  ok(sw1.rankings.open.length === 2 && sw1.rankings.women.length === 0 && sw1.rankings.junior.length === 1 && sw1.prizeTotal === 5500, "custom places 2/0/1, total 5500", [sw1.rankings.open.length, sw1.rankings.women.length, sw1.rankings.junior.length, sw1.prizeTotal]);
  ok(r.json.tournament.standings.length === 2, "generic standings follow open places");
  r = await api(`/api/admin/tournaments/${eventId}/swiss/info`, { method: "PUT", jar: admin, body: { prizeNoteEn: "Top 3 also get a <trophy>", prizeNoteAr: "الثلاثة الأوائل كأس" } });
  ok(r.status === 200, "prize note saved");
  const noteSheet = await getHtml(`/admin/print/tournament/${eventId}?view=regulation&lang=en`, admin);
  ok(noteSheet.text.includes("Top 3 also get a &lt;trophy&gt;") && noteSheet.text.includes("5,500"), "prize note (escaped) + custom total on sheet");
  r = await api(SET, { method: "PUT", jar: admin, body: { prizes: { open: [2500, 1500, 1000, 700, 500], women: [1000, 600, 400], junior: [800, 600, 400] } } });
  ok(r.status === 200 && r.json.tournament.swiss.prizeTotal === 10000, "flyer prizes restored");
  r = await api(`/api/admin/tournaments/${eventId}/swiss/info`, { method: "PUT", jar: admin, body: { prizeNoteEn: "", prizeNoteAr: "" } });
  r = await api(`/api/admin/tournaments/${eventId}/award-points`, { method: "POST", jar: admin });
  ok(r.status === 200, "award points again");
  r = await api(SET, { method: "PUT", jar: admin, body: { totalRounds: ROUNDS + 1 } });
  ok(r.status === 400, "rounds locked once points are awarded", r.json);
  r = await api(SET, { method: "PUT", jar: admin, body: { totalRounds: ROUNDS, prizes: { open: [2500, 1500, 1000, 700, 500], women: [1000, 600, 400], junior: [800, 600, 400] } } });
  ok(r.status === 200, "same rounds + prizes still editable after points awarded");

  section("Printable sheets + print details");
  for (const lang of ["ar", "en"]) {
    const reg = await getHtml(`/admin/print/tournament/${eventId}?view=regulation&lang=${lang}`, admin);
    ok(reg.status === 200 && /html/.test(reg.type), `regulation sheet (${lang}) renders`, reg.status);
    ok(reg.text.includes("10,000") && reg.text.includes("2,500"), `regulation (${lang}) shows prizes`);
    ok(reg.text.includes('src="/print.js"') && !/<script>[^<]/.test(reg.text), "print page uses external script only");
  }
  const pr = await getHtml(`/admin/print/tournament/${eventId}?view=pairings&round=2&lang=en`, admin);
  ok(pr.status === 200 && pr.text.includes("Round pairings"), "pairings sheet", pr.status);
  const stp = await getHtml(`/admin/print/tournament/${eventId}?view=standings&lang=ar`, admin);
  ok(stp.status === 200, "standings sheet", stp.status);
  ok(!stp.text.includes("<img src=x") && stp.text.includes("&lt;img src=x"), "player names are HTML-escaped on printed sheets");
  const bad = await getHtml(`/admin/print/tournament/${eventId}?view=%3Cscript%3E&lang=zz&round=abc`, admin);
  ok(bad.status === 200 && !bad.text.includes("<script>alert"), "garbage query params fall back safely", bad.status);
  ok((await getHtml(`/admin/print/tournament/${eventId}?view=regulation`, null)).status === 401, "print: anonymous blocked");
  ok([401, 403].includes((await getHtml(`/admin/print/tournament/${eventId}?view=regulation`, players[0])).status), "print: member blocked");
  ok((await getHtml(`/admin/print/tournament/${eventId}?view=regulation`, staffJar)).status === 403, "print: gate-staff role blocked");
  ok((await getHtml(`/admin/print/tournament/99999?view=regulation`, admin)).status === 404, "print: unknown event 404");
  r = await api(`/api/admin/tournaments/${eventId}/swiss/info`, { method: "PUT", jar: admin, body: { venueAr: "فرع <b>مدينة</b> نصر", venueEn: "Venue X", ceremonyTime: "21:15" } });
  ok(r.status === 200 && r.json.tournament.swiss.info.ceremonyTime === "21:15" && r.json.tournament.swiss.info.organizerEn, "info saved, defaults kept", r.json && r.json.tournament && r.json.tournament.swiss.info);
  const reg2 = await getHtml(`/admin/print/tournament/${eventId}?view=regulation&lang=ar`, admin);
  ok(reg2.text.includes("9:15 مساءً") && reg2.text.includes("&lt;b&gt;"), "saved info appears (escaped) on sheet");
  r = await api(`/api/admin/tournaments/${eventId}/swiss/info`, { method: "PUT", jar: admin, body: { ceremonyTime: "25:99" } });
  ok(r.status === 400, "bad ceremony time rejected");
  r = await api(`/api/admin/tournaments/${eventId}/swiss/info`, { method: "PUT", jar: admin, body: { venueEn: "x".repeat(200) } });
  ok(r.status === 400, "overlong info rejected");
  r = await api(`/api/admin/tournaments/${eventId}/swiss/info`, { method: "PUT", jar: staffJar, body: { venueEn: "x" } });
  ok(r.status === 403, "info: staff role blocked");

  section("XSS payload stored as plain text only");
  const evil = st.find((x) => /onerror/.test(x.label));
  ok(!!evil, "evil name present as data (escaping is client-side)");

  console.log(`\nSwiss E2E: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
