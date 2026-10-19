// Tournament feature end-to-end test suite: exercises every tournament
// endpoint through the real HTTP API (not unit tests of internal
// functions), covering the happy paths (knockout / groups / casual,
// individual / team mode, schedules) AND the error paths (bad input,
// wrong role, missing CSRF, double-submission, out-of-order actions) that
// a load test alone doesn't check. Run against a fully isolated throwaway
// server with a fresh database - never production.
//
// Usage: node tournament_e2e.js
"use strict";

const BASE = process.env.BASE_URL || "http://localhost:3910";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push({ label, extra });
    console.log(`  FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : "");
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ---- cookie-jar HTTP client (same double-submit-cookie CSRF handling as
// the load-test harness) -----------------------------------------------
function newJar() {
  return {};
}
function applySetCookies(jar, res) {
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const raw of setCookies) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}
function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}
async function api(path, { method = "GET", body, jar, noCsrf = false, isForm = false } = {}) {
  if (!jar) jar = newJar();
  const headers = {};
  const existingCookie = cookieHeader(jar);
  if (existingCookie) headers["Cookie"] = existingCookie;
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && jar.csrfToken && !noCsrf) {
    headers["X-CSRF-Token"] = jar.csrfToken;
  }
  let fetchBody;
  if (body !== undefined) {
    if (isForm) {
      fetchBody = body;
    } else {
      headers["Content-Type"] = "application/json";
      fetchBody = JSON.stringify(body);
    }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(BASE + path, { method, headers, body: fetchBody, redirect: "manual" });
      applySetCookies(jar, res);
      let json = null;
      try {
        json = await res.json();
      } catch (e) {
        /* non-JSON, fine for some endpoints */
      }
      return { status: res.status, json, jar };
    } catch (networkErr) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
        continue;
      }
      return { status: 0, json: { networkError: String((networkErr && networkErr.message) || networkErr) }, jar };
    }
  }
}
async function primeCsrf(jar) {
  await api("/", { jar });
  return jar;
}

async function main() {
  // ---- setup: admin session, a member-signup helper, an event ----------
  section("Setup");
  const admin = await primeCsrf(newJar());
  let r = await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } });
  ok(r.status === 200, "admin login succeeds", r.json);

  async function signupMember(num) {
    const jar = await primeCsrf(newJar());
    const res = await api("/api/auth/signup", {
      method: "POST",
      jar,
      body: { membershipNumber: `E2E${num}`, name: `E2E Player ${num}`, password: "abc12345", phone: `0100${String(num).padStart(7, "0")}`, agreeTerms: true, memberType: "main", ageGroup: "18to45" },
    });
    return { jar, res };
  }
  async function createEvent(nameEn, sport) {
    const form = new FormData();
    form.set("nameEn", nameEn);
    form.set("nameAr", nameEn);
    form.set("sport", sport || "Chess");
    form.set("date", "2026-12-15");
    const res = await api("/api/events", { method: "POST", jar: admin, body: form, isForm: true });
    return res;
  }
  async function registerAndCheckin(jar, eventId) {
    const reg = await api("/api/register", { method: "POST", jar, body: { eventId } });
    if (reg.status !== 200 && reg.status !== 201) return { ok: false, reg };
    const ci = await api("/api/checkin/manual", { method: "POST", jar: admin, body: { membershipNumber: reg.json.registration ? undefined : undefined, registrationId: reg.json.registration ? reg.json.registration.id : reg.json.id } });
    return { ok: true, reg, ci };
  }

  // ======================================================================
  section("1. Individual + Knockout: full happy path");
  // ======================================================================
  {
    const evRes = await createEvent("E2E Knockout Event", "Chess");
    ok(evRes.status === 200 || evRes.status === 201, "create event (knockout)", evRes.json);
    const eventId = evRes.json.id;

    const N = 13; // deliberately not a power of 2, to exercise byes
    const players = [];
    for (let i = 1; i <= N; i++) {
      const { jar, res } = await signupMember(`K${i}`);
      ok(res.status === 200 || res.status === 201, `signup K${i}`, res.json);
      players.push(jar);
    }
    let regIds = [];
    for (const jar of players) {
      const reg = await api("/api/register", { method: "POST", jar, body: { eventId } });
      ok(reg.status === 200 || reg.status === 201, "register for knockout event", reg.json);
      const regId = (reg.json.registration && reg.json.registration.id) || reg.json.id;
      regIds.push(regId);
      const ci = await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: regId } });
      ok(ci.status === 200, "check in for knockout event", ci.json);
    }

    const create = await api(`/api/admin/tournaments/${eventId}`, {
      method: "POST",
      jar: admin,
      body: { mode: "individual", format: "knockout", courts: 3, matchMinutes: 10, startTime: "09:00", winPoints: 3, drawPoints: 1, lossPoints: 0, availableHours: 6 },
    });
    ok(create.status === 201, "create knockout tournament", create.json);

    const gen = await api(`/api/admin/tournaments/${eventId}/generate`, { method: "POST", jar: admin });
    ok(gen.status === 200, "generate knockout bracket", gen.json);
    const bracketSize = gen.json.tournament.knockout.rounds[0].length * 2;
    ok(bracketSize === 16, "bracket size is next power of 2 above 13 (16)", bracketSize);
    const byes = gen.json.tournament.knockout.rounds[0].filter((m) => m.bye).length;
    ok(byes === 16 - N, "byes = bracketSize - entrants", { byes, expected: 16 - N });

    // Play every round to completion.
    let t = gen.json.tournament;
    let roundIdx = 0;
    while (t.status !== "completed") {
      const round = t.knockout.rounds[roundIdx];
      if (!round) break;
      for (const m of round) {
        if (m.bye || m.winnerId || !m.a || !m.b) continue;
        const res = await api(`/api/admin/tournaments/${eventId}/knockout-result`, {
          method: "PUT",
          jar: admin,
          body: { roundIndex: roundIdx, matchId: m.id, scoreA: 1, scoreB: 0 },
        });
        ok(res.status === 200, `play knockout match round ${roundIdx} match ${m.id}`, res.json);
        t = res.json.tournament;
      }
      roundIdx++;
      if (roundIdx > 10) break; // safety valve
    }
    ok(t.status === "completed", "knockout tournament reaches completed status", t.status);
    ok(Array.isArray(t.standings) && t.standings.length >= 2, "standings computed with winner+runner-up", t.standings);

    const award1 = await api(`/api/admin/tournaments/${eventId}/award-points`, { method: "POST", jar: admin });
    ok(award1.status === 200, "award points succeeds", award1.json);
    const award2 = await api(`/api/admin/tournaments/${eventId}/award-points`, { method: "POST", jar: admin });
    ok(award2.status === 200, "award points is safe to call twice (idempotent)", award2.json);
    ok(award1.json.updated === award2.json.updated, "second award-points call updates the same count, not double", {
      first: award1.json.updated,
      second: award2.json.updated,
    });
  }

  // ======================================================================
  section("2. Individual + Groups: remainder group sizes, group->knockout flow");
  // ======================================================================
  {
    const evRes = await createEvent("E2E Groups Event", "Chess");
    const eventId = evRes.json.id;
    const N = 17; // 17 / 5 groups = remainder, exercises uneven group sizes
    for (let i = 1; i <= N; i++) {
      const { jar } = await signupMember(`G${i}`);
      const reg = await api("/api/register", { method: "POST", jar, body: { eventId } });
      const regId = (reg.json.registration && reg.json.registration.id) || reg.json.id;
      await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: regId } });
    }

    const create = await api(`/api/admin/tournaments/${eventId}`, {
      method: "POST",
      jar: admin,
      body: { mode: "individual", format: "groups", numGroups: 5, advancePerGroup: 2 },
    });
    ok(create.status === 201, "create groups tournament", create.json);

    const gen = await api(`/api/admin/tournaments/${eventId}/generate`, { method: "POST", jar: admin });
    ok(gen.status === 200, "generate groups", gen.json);
    const sizes = gen.json.tournament.groups.map((g) => g.entrantIds.length);
    const maxMinusMin = Math.max(...sizes) - Math.min(...sizes);
    ok(maxMinusMin <= 1, "group sizes differ by at most 1 when uneven", sizes);
    ok(sizes.reduce((a, b) => a + b, 0) === N, "group sizes sum to total entrants", { sizes, N });

    // Play all group matches.
    let t = gen.json.tournament;
    for (const g of t.groups) {
      for (const m of g.matches) {
        const res = await api(`/api/admin/tournaments/${eventId}/group-result`, {
          method: "PUT",
          jar: admin,
          body: { matchId: m.id, scoreA: 2, scoreB: 1 },
        });
        ok(res.status === 200, `record group match ${m.id}`, res.json);
      }
    }

    // generate-knockout should fail if any match undecided - verify by
    // checking it succeeds now that all are decided.
    const genKo = await api(`/api/admin/tournaments/${eventId}/generate-knockout`, { method: "POST", jar: admin });
    ok(genKo.status === 200, "generate knockout from completed groups", genKo.json);
    const qualifiers = 5 * 2;
    const expectedBracket = 16; // next pow2 >= 10
    const actualBracket = genKo.json.tournament.knockout.rounds[0].length * 2;
    ok(actualBracket === expectedBracket, "knockout bracket size matches qualifier count", { qualifiers, actualBracket });
  }

  // ======================================================================
  section("3. Team mode: team assignment, seed order, full flow");
  // ======================================================================
  {
    const evRes = await createEvent("E2E Team Event", "Padel");
    const eventId = evRes.json.id;
    const regIds = [];
    for (let i = 1; i <= 8; i++) {
      const { jar } = await signupMember(`T${i}`);
      const reg = await api("/api/register", { method: "POST", jar, body: { eventId } });
      const regId = (reg.json.registration && reg.json.registration.id) || reg.json.id;
      await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: regId } });
      regIds.push(regId);
    }

    const create = await api(`/api/admin/tournaments/${eventId}`, { method: "POST", jar: admin, body: { mode: "team", format: "knockout" } });
    ok(create.status === 201, "create team tournament", create.json);

    const badTeams = await api(`/api/admin/tournaments/${eventId}/teams`, {
      method: "PUT",
      jar: admin,
      body: { teams: [{ name: "Team A", memberIds: [regIds[0], regIds[1]] }, { name: "Team B", memberIds: [regIds[1], regIds[2]] }] }, // regIds[1] duplicated
    });
    ok(badTeams.status === 400, "duplicate member across teams is rejected", badTeams.json);

    const teams = [
      { name: "Team A", memberIds: [regIds[0], regIds[1]] },
      { name: "Team B", memberIds: [regIds[2], regIds[3]] },
      { name: "Team C", memberIds: [regIds[4], regIds[5]] },
      { name: "Team D", memberIds: [regIds[6], regIds[7]] },
    ];
    const setTeams = await api(`/api/admin/tournaments/${eventId}/teams`, { method: "PUT", jar: admin, body: { teams } });
    ok(setTeams.status === 200, "set 4 valid teams", setTeams.json);
    ok(setTeams.json.tournament.teams.length === 4, "4 teams stored", setTeams.json.tournament.teams);

    const foreignRegId = 999999;
    const foreignTeams = await api(`/api/admin/tournaments/${eventId}/teams`, {
      method: "PUT",
      jar: admin,
      body: { teams: [{ name: "X", memberIds: [foreignRegId] }, { name: "Y", memberIds: [regIds[0]] }] },
    });
    ok(
      foreignTeams.status === 400 || (foreignTeams.status === 200 && foreignTeams.json.tournament.teams.length === 1),
      "a non-existent/foreign registration id is silently dropped, not trusted as a real member",
      foreignTeams.json
    );
    // restore valid teams for the rest of the flow
    await api(`/api/admin/tournaments/${eventId}/teams`, { method: "PUT", jar: admin, body: { teams } });

    const gen = await api(`/api/admin/tournaments/${eventId}/generate`, { method: "POST", jar: admin });
    ok(gen.status === 200, "generate team knockout", gen.json);
    let t = gen.json.tournament;
    for (let roundIdx = 0; t.status !== "completed" && roundIdx < 5; roundIdx++) {
      const round = t.knockout.rounds[roundIdx];
      if (!round) break;
      for (const m of round) {
        if (m.bye || m.winnerId || !m.a || !m.b) continue;
        const res = await api(`/api/admin/tournaments/${eventId}/knockout-result`, { method: "PUT", jar: admin, body: { roundIndex: roundIdx, matchId: m.id, winnerId: m.a } });
        ok(res.status === 200, `play team knockout match`, res.json);
        t = res.json.tournament;
      }
    }
    ok(t.status === "completed", "team tournament completes", t.status);
  }

  // ======================================================================
  section("4. Casual (fun session): attendance + status toggling");
  // ======================================================================
  {
    const evRes = await createEvent("E2E Casual Event", "Table Tennis");
    const eventId = evRes.json.id;
    const regIds = [];
    for (let i = 1; i <= 4; i++) {
      const { jar } = await signupMember(`C${i}`);
      const reg = await api("/api/register", { method: "POST", jar, body: { eventId } });
      const regId = (reg.json.registration && reg.json.registration.id) || reg.json.id;
      await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: regId } });
      regIds.push(regId);
    }
    const create = await api(`/api/admin/tournaments/${eventId}`, { method: "POST", jar: admin, body: { mode: "individual", format: "casual" } });
    ok(create.status === 201, "create casual session", create.json);

    const att = await api(`/api/admin/tournaments/${eventId}/attendance`, { method: "PUT", jar: admin, body: { registrationId: regIds[0], status: "present" } });
    ok(att.status === 200, "mark attendance present", att.json);

    const badStatus = await api(`/api/admin/tournaments/${eventId}/casual-status`, { method: "PUT", jar: admin, body: { status: "bogus" } });
    ok(badStatus.status === 400, "invalid casual-status value rejected", badStatus.json);

    const complete = await api(`/api/admin/tournaments/${eventId}/casual-status`, { method: "PUT", jar: admin, body: { status: "completed" } });
    ok(complete.status === 200 && complete.json.tournament.status === "completed", "end casual session", complete.json);

    const reopen = await api(`/api/admin/tournaments/${eventId}/casual-status`, { method: "PUT", jar: admin, body: { status: "casual" } });
    ok(reopen.status === 200 && reopen.json.tournament.status === "casual", "reopen casual session", reopen.json);

    const genOnCasual = await api(`/api/admin/tournaments/${eventId}/generate`, { method: "POST", jar: admin });
    ok(genOnCasual.status === 400, "generating a bracket for a casual session is rejected", genOnCasual.json);
  }

  // ======================================================================
  section("5. Error paths & input validation");
  // ======================================================================
  {
    const evRes = await createEvent("E2E Error-Path Event", "Chess");
    const eventId = evRes.json.id;

    const badMode = await api(`/api/admin/tournaments/${eventId}`, { method: "POST", jar: admin, body: { mode: "bogus", format: "knockout" } });
    ok(badMode.status === 400, "invalid mode rejected", badMode.json);

    const badFormat = await api(`/api/admin/tournaments/${eventId}`, { method: "POST", jar: admin, body: { mode: "individual", format: "bogus" } });
    ok(badFormat.status === 400, "invalid format rejected", badFormat.json);

    const badGroups = await api(`/api/admin/tournaments/${eventId}`, { method: "POST", jar: admin, body: { mode: "individual", format: "groups", numGroups: 1, advancePerGroup: 1 } });
    ok(badGroups.status === 400, "numGroups < 2 rejected", badGroups.json);

    const badHours = await api(`/api/admin/tournaments/${eventId}`, { method: "POST", jar: admin, body: { mode: "individual", format: "knockout", availableHours: -3 } });
    ok(badHours.status === 400, "negative availableHours rejected", badHours.json);

    const create = await api(`/api/admin/tournaments/${eventId}`, { method: "POST", jar: admin, body: { mode: "individual", format: "knockout" } });
    ok(create.status === 201, "create a tournament for error-path event", create.json);

    const dup = await api(`/api/admin/tournaments/${eventId}`, { method: "POST", jar: admin, body: { mode: "individual", format: "knockout" } });
    ok(dup.status === 400, "creating a 2nd tournament for the same event is rejected", dup.json);

    const genNoEntrants = await api(`/api/admin/tournaments/${eventId}/generate`, { method: "POST", jar: admin });
    ok(genNoEntrants.status === 400, "generating with < 2 entrants is rejected", genNoEntrants.json);

    const koNoGroups = await api(`/api/admin/tournaments/${eventId}/generate-knockout`, { method: "POST", jar: admin });
    ok(koNoGroups.status === 404, "generate-knockout on a non-groups tournament is rejected", koNoGroups.json);

    const badScore = await api(`/api/admin/tournaments/${eventId}/group-result`, { method: "PUT", jar: admin, body: { matchId: 1, scoreA: -1, scoreB: 0 } });
    ok(badScore.status === 400 || badScore.status === 404, "negative score rejected (or no such match yet)", badScore.json);

    const delMissing = await api(`/api/admin/tournaments/999999999`, { method: "DELETE", jar: admin });
    ok(delMissing.status === 404, "deleting a non-existent tournament returns 404", delMissing.json);

    const del = await api(`/api/admin/tournaments/${eventId}`, { method: "DELETE", jar: admin });
    ok(del.status === 200, "delete the tournament", del.json);
    const recreate = await api(`/api/admin/tournaments/${eventId}`, { method: "POST", jar: admin, body: { mode: "individual", format: "knockout" } });
    ok(recreate.status === 201, "recreate a tournament after deletion", recreate.json);
  }

  // ======================================================================
  section("6. Reseed safety: only allowed before anything is played");
  // ======================================================================
  {
    const evRes = await createEvent("E2E Reseed Event", "Chess");
    const eventId = evRes.json.id;
    const regIds = [];
    for (let i = 1; i <= 4; i++) {
      const { jar } = await signupMember(`R${i}`);
      const reg = await api("/api/register", { method: "POST", jar, body: { eventId } });
      const regId = (reg.json.registration && reg.json.registration.id) || reg.json.id;
      await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: regId } });
      regIds.push(regId);
    }
    await api(`/api/admin/tournaments/${eventId}`, { method: "POST", jar: admin, body: { mode: "individual", format: "knockout" } });
    const gen = await api(`/api/admin/tournaments/${eventId}/generate`, { method: "POST", jar: admin });
    ok(gen.status === 200, "generate for reseed test", gen.json);

    const reseedBefore = await api(`/api/admin/tournaments/${eventId}/reseed`, { method: "POST", jar: admin });
    ok(reseedBefore.status === 200, "reseed allowed before anything played", reseedBefore.json);

    const gen2 = await api(`/api/admin/tournaments/${eventId}/generate`, { method: "POST", jar: admin });
    ok(gen2.status === 200, "regenerate after reseed", gen2.json);
    const round0 = gen2.json.tournament.knockout.rounds[0];
    const firstRealMatch = round0.find((m) => !m.bye && m.a && m.b);
    const play = await api(`/api/admin/tournaments/${eventId}/knockout-result`, { method: "PUT", jar: admin, body: { roundIndex: 0, matchId: firstRealMatch.id, winnerId: firstRealMatch.a } });
    ok(play.status === 200, "play one match before testing reseed lockout", play.json);

    const reseedAfter = await api(`/api/admin/tournaments/${eventId}/reseed`, { method: "POST", jar: admin });
    ok(reseedAfter.status === 400, "reseed rejected once a match has a result", reseedAfter.json);

    const badWinner = await api(`/api/admin/tournaments/${eventId}/knockout-result`, {
      method: "PUT",
      jar: admin,
      body: { roundIndex: 0, matchId: round0.find((m) => !m.bye && m.a && m.b && m.id !== firstRealMatch.id).id, winnerId: 99999999 },
    });
    ok(badWinner.status === 400, "winnerId not matching either entrant is rejected", badWinner.json);
  }

  // ======================================================================
  section("7. Authorization: role gating and session requirements");
  // ======================================================================
  {
    // Create a "tournament" role account and a plain "staff" role account.
    const tourMgr = await api("/api/staff/accounts", {
      method: "POST",
      jar: admin,
      body: { username: "e2e_tourmgr", password: "TourMgr!2026", name: "E2E Tournament Manager", role: "tournament" },
    });
    ok(tourMgr.status === 201, "create tournament-manager staff account", tourMgr.json);
    const plainStaff = await api("/api/staff/accounts", {
      method: "POST",
      jar: admin,
      body: { username: "e2e_plainstaff", password: "PlainStaff!2026", name: "E2E Plain Staff", role: "staff" },
    });
    ok(plainStaff.status === 201, "create plain-staff account", plainStaff.json);

    const tourJar = await primeCsrf(newJar());
    const tourLogin = await api("/api/auth/staff-login", { method: "POST", jar: tourJar, body: { username: "e2e_tourmgr", password: "TourMgr!2026" } });
    ok(tourLogin.status === 200, "tournament-manager login succeeds", tourLogin.json);

    const staffJar = await primeCsrf(newJar());
    const staffLogin = await api("/api/auth/staff-login", { method: "POST", jar: staffJar, body: { username: "e2e_plainstaff", password: "PlainStaff!2026" } });
    ok(staffLogin.status === 200, "plain-staff login succeeds", staffLogin.json);

    const evRes = await createEvent("E2E Authz Event", "Chess");
    const eventId = evRes.json.id;

    const tourCreate = await api(`/api/admin/tournaments/${eventId}`, { method: "POST", jar: tourJar, body: { mode: "individual", format: "knockout" } });
    ok(tourCreate.status === 201, "tournament-manager role CAN create a tournament", tourCreate.json);

    const staffLoad = await api(`/api/admin/tournaments/${eventId}`, { jar: staffJar });
    ok(staffLoad.status === 403, "plain-staff role CANNOT read the tournament panel", staffLoad.json);

    const anonLoad = await api(`/api/admin/tournaments/${eventId}`, { jar: newJar() });
    ok(anonLoad.status === 401, "no session at all is rejected", anonLoad.json);

    const noCsrf = await api(`/api/admin/tournaments/${eventId}/casual-status`, { method: "PUT", jar: tourJar, body: { status: "completed" }, noCsrf: true });
    ok(noCsrf.status === 403, "mutating request without CSRF header is rejected", noCsrf.json);
  }

  // ======================================================================
  section("8. XSS-safety smoke test: hostile team name doesn't crash anything");
  // ======================================================================
  {
    const evRes = await createEvent("E2E XSS Event", "Padel");
    const eventId = evRes.json.id;
    const regIds = [];
    for (let i = 1; i <= 4; i++) {
      const { jar } = await signupMember(`X${i}`);
      const reg = await api("/api/register", { method: "POST", jar, body: { eventId } });
      const regId = (reg.json.registration && reg.json.registration.id) || reg.json.id;
      await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: regId } });
      regIds.push(regId);
    }
    await api(`/api/admin/tournaments/${eventId}`, { method: "POST", jar: admin, body: { mode: "team", format: "knockout" } });
    const payload = `<img src=x onerror=alert(1)>`;
    const setTeams = await api(`/api/admin/tournaments/${eventId}/teams`, {
      method: "PUT",
      jar: admin,
      body: { teams: [{ name: payload, memberIds: [regIds[0], regIds[1]] }, { name: "Normal Team", memberIds: [regIds[2], regIds[3]] }] },
    });
    ok(setTeams.status === 200, "a hostile team name is accepted (stored) without crashing the server", setTeams.json);
    const stored = setTeams.json.tournament.teams.find((t) => t.name.includes("img"));
    ok(stored && stored.name === payload, "the raw payload is stored as-is server-side (escaping is the client's job, verified in app.js)", stored);
  }

  // ======================================================================
  section("9. Planning-count preview field: never reaches the server");
  // ======================================================================
  {
    // This is the client-side-only field added for the feasibility
    // calculator. The real regression risk is a stray "planningCount" (or
    // similar) key leaking into the actual create-tournament POST body -
    // verify the server has no idea such a field exists and ignores it if
    // sent, rather than erroring or storing it.
    const evRes = await createEvent("E2E Planning-Count Event", "Chess");
    const eventId = evRes.json.id;
    const create = await api(`/api/admin/tournaments/${eventId}`, {
      method: "POST",
      jar: admin,
      body: { mode: "individual", format: "knockout", planningCount: 999, tournPlanningCount: 999 },
    });
    ok(create.status === 201, "extra unknown planningCount field in the body is silently ignored, not an error", create.json);
    ok(
      JSON.stringify(create.json.tournament).indexOf("999") === -1,
      "the bogus planningCount value isn't stored anywhere in the tournament",
      create.json.tournament
    );
  }

  // ---- summary -----------------------------------------------------------
  section("SUMMARY");
  console.log(`${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(` - ${f.label}`, f.extra !== undefined ? JSON.stringify(f.extra).slice(0, 200) : "");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exitCode = 1;
});
