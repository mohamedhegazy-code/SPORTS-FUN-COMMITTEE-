// End-to-end load test: 1000 members sign up -> each registers for a
// "PlayStation Tournament" event -> all 1000 get checked in at the gate ->
// admin runs the real tournament feature (groups -> knockout -> final)
// through the real server code. Runs against a fully isolated local test
// server (loadtest/ in a throwaway clone), never production.
//
// Usage: node loadtest/run.js
"use strict";

const BASE = process.env.BASE_URL || "http://localhost:3900";
const N = Number(process.env.N || 1000);
const SIGNUP_CONCURRENCY = Number(process.env.SIGNUP_CONCURRENCY || 60);
const GENERAL_CONCURRENCY = Number(process.env.GENERAL_CONCURRENCY || 120);
const GROUP_SIZE = 4;
const ADVANCE_PER_GROUP = 2;
const NUM_GROUPS = Math.floor(N / GROUP_SIZE);

const report = {
  startedAt: new Date().toISOString(),
  n: N,
  phases: {},
  errors: [],
  counts: {},
};

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}

// ---- tiny concurrency pool -------------------------------------------------
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  let active = 0;
  let failures = 0;
  return new Promise((resolve) => {
    function kick() {
      if (next >= items.length && active === 0) return resolve({ results, failures });
      while (active < limit && next < items.length) {
        const idx = next++;
        active++;
        Promise.resolve(worker(items[idx], idx))
          .then((r) => {
            results[idx] = r;
          })
          .catch((err) => {
            failures++;
            results[idx] = { error: String((err && err.message) || err) };
          })
          .finally(() => {
            active--;
            kick();
          });
      }
    }
    kick();
  });
}

// The app uses double-submit-cookie CSRF protection: a non-httpOnly
// "csrfToken" cookie must be echoed back as an X-CSRF-Token header on every
// state-changing request, alongside whatever session cookie (member or
// staff) is in play. Each virtual identity below carries its own tiny
// cookie jar { ahlawy_sid, csrfToken } rather than a single shared cookie
// string, since every member needs their own independent session.
function newJar() {
  return {};
}
function applySetCookies(jar, res) {
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const raw of setCookies) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    jar[name] = value;
  }
}
function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function api(path, { method = "GET", body, jar, isForm = false } = {}) {
  if (!jar) jar = newJar();
  const headers = {};
  const existingCookie = cookieHeader(jar);
  if (existingCookie) headers["Cookie"] = existingCookie;
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && jar.csrfToken) {
    headers["X-CSRF-Token"] = jar.csrfToken;
  }
  let fetchBody = undefined;
  if (body !== undefined) {
    if (isForm) {
      fetchBody = body; // FormData, fetch sets content-type itself
    } else {
      headers["Content-Type"] = "application/json";
      fetchBody = JSON.stringify(body);
    }
  }
  // Network-level failures (connection reset, socket exhaustion under heavy
  // localhost concurrency, etc.) must never be lost silently - they're
  // returned as a synthetic status:0 response instead of thrown, so every
  // call site's normal "status !== 200" failure handling catches them too.
  // One retry (after a short pause) separates "the app actually failed
  // this request" from "the client's local connection churned under load."
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(BASE + path, { method, headers, body: fetchBody, redirect: "manual" });
      applySetCookies(jar, res);
      let json = null;
      try {
        json = await res.json();
      } catch (e) {
        /* non-JSON response, fine for some endpoints */
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

// Primes a fresh identity's csrfToken cookie with a harmless GET before its
// first state-changing request (signup, login, ...) - the token is minted
// server-side on first contact and must be known to the client in advance
// to pass the CSRF check on the very next POST.
async function primeCsrf() {
  const jar = newJar();
  await api("/api/settings", { jar });
  return jar;
}

async function timePhase(name, fn) {
  const t0 = Date.now();
  log(`--- ${name}: starting`);
  const result = await fn();
  const ms = Date.now() - t0;
  report.phases[name] = { ms, seconds: +(ms / 1000).toFixed(2) };
  log(`--- ${name}: done in ${(ms / 1000).toFixed(2)}s`);
  return result;
}

// ---- main -------------------------------------------------------------------
(async () => {
  // Phase 1: sign up N members
  const signupIds = Array.from({ length: N }, (_, i) => i + 1);
  const members = []; // { membershipNumber, jar }
  let signupFailures = [];
  await timePhase("1_signup", async () => {
    const { results, failures } = await pool(signupIds, SIGNUP_CONCURRENCY, async (i) => {
      const jar = await primeCsrf();
      const membershipNumber = `LT-${String(i).padStart(5, "0")}`;
      const r = await api("/api/auth/signup", {
        method: "POST",
        jar,
        body: {
          membershipNumber,
          name: `Load Test Member ${i}`,
          password: "TestPass123!",
          memberType: "main",
          birthDate: "1990-06-15",
          phone: `01${String(100000000 + i).padStart(9, "0")}`,
          agreeTerms: true,
        },
      });
      if (r.status !== 201) {
        signupFailures.push({ i, status: r.status, body: r.json });
        return null;
      }
      members.push({ membershipNumber, jar });
      return r.status;
    });
    report.counts.signup_ok = members.length;
    report.counts.signup_failed = signupFailures.length;
    if (signupFailures.length) report.errors.push({ phase: "signup", sample: signupFailures.slice(0, 5) });
  });
  log(`signed up ${members.length}/${N} (failed: ${signupFailures.length})`);

  // Admin login (used for every staff-side action from here on)
  const adminJar = await primeCsrf();
  await timePhase("2_admin_login_and_event", async () => {
    const loginRes = await api("/api/auth/staff-login", {
      method: "POST",
      jar: adminJar,
      body: { username: "loadtest_admin", password: "LoadTest!2026xyz" },
    });
    if (loginRes.status !== 200) throw new Error("admin login failed: " + JSON.stringify(loginRes.json));

    const form = new FormData();
    form.set("nameEn", "PlayStation Tournament - Load Test");
    form.set("nameAr", "بطولة بلايستيشن - اختبار تحميل");
    form.set("sport", "PlayStation");
    form.set("date", "2026-12-01");
    form.set("maxCapacity", String(N + 50));
    const evRes = await api("/api/events", { method: "POST", body: form, isForm: true, jar: adminJar });
    if (evRes.status !== 201) throw new Error("event creation failed: " + JSON.stringify(evRes.json));
    report.eventId = evRes.json.id;
  });
  log(`event id = ${report.eventId}`);

  // Phase 3: every member registers themselves for the event
  const registrations = []; // { membershipNumber, registrationId }
  let registerFailures = [];
  await timePhase("3_self_register", async () => {
    await pool(members, GENERAL_CONCURRENCY, async (m) => {
      const r = await api("/api/register", {
        method: "POST",
        body: { eventId: report.eventId },
        jar: m.jar,
      });
      if (r.status !== 201) {
        registerFailures.push({ membershipNumber: m.membershipNumber, status: r.status, body: r.json });
        return;
      }
      registrations.push({ membershipNumber: m.membershipNumber, registrationId: r.json.registration.id, hadQr: !!r.json.qrDataUrl });
    });
    report.counts.register_ok = registrations.length;
    report.counts.register_failed = registerFailures.length;
    report.counts.qr_issued = registrations.filter((r) => r.hadQr).length;
    if (registerFailures.length) report.errors.push({ phase: "register", sample: registerFailures.slice(0, 5) });
  });
  log(`registered ${registrations.length}/${members.length} (QR issued: ${report.counts.qr_issued}, failed: ${registerFailures.length})`);

  // Phase 4: gate "scans" every registration (manual check-in = same
  // performCheckIn() code path as a real QR scan, just a different lookup)
  let checkinFailures = [];
  let checkinOk = 0;
  await timePhase("4_gate_checkin", async () => {
    await pool(registrations, GENERAL_CONCURRENCY, async (r) => {
      const res = await api("/api/checkin/manual", {
        method: "POST",
        body: { registrationId: r.registrationId },
        jar: adminJar,
      });
      if (res.status !== 200) {
        checkinFailures.push({ registrationId: r.registrationId, status: res.status, body: res.json });
        return;
      }
      checkinOk++;
    });
    report.counts.checkin_ok = checkinOk;
    report.counts.checkin_failed = checkinFailures.length;
    if (checkinFailures.length) report.errors.push({ phase: "checkin", sample: checkinFailures.slice(0, 5) });
  });
  log(`checked in ${checkinOk}/${registrations.length} (failed: ${checkinFailures.length})`);

  // Phase 5: create the tournament (individual mode, groups of 4, top 2 advance)
  await timePhase("5_create_tournament_and_generate_groups", async () => {
    const createRes = await api(`/api/admin/tournaments/${report.eventId}`, {
      method: "POST",
      body: { mode: "individual", format: "groups", numGroups: NUM_GROUPS, advancePerGroup: ADVANCE_PER_GROUP },
      jar: adminJar,
    });
    if (createRes.status !== 201) throw new Error("tournament create failed: " + JSON.stringify(createRes.json));

    const genRes = await api(`/api/admin/tournaments/${report.eventId}/generate`, { method: "POST", jar: adminJar });
    if (genRes.status !== 200) throw new Error("group generation failed: " + JSON.stringify(genRes.json));
    report.groupsCreated = genRes.json.tournament.groups.length;
    report.groupMatchesTotal = genRes.json.tournament.groups.reduce((s, g) => s + g.matches.length, 0);
  });
  log(`groups: ${report.groupsCreated}, total group matches: ${report.groupMatchesTotal}`);

  // Phase 6: play out every group match with a random-but-deterministic score
  let groupMatchFailures = [];
  let groupMatchOk = 0;
  await timePhase("6_play_group_stage", async () => {
    const t0Res = await api(`/api/admin/tournaments/${report.eventId}`, { jar: adminJar });
    const allMatches = t0Res.json.tournament.groups.flatMap((g) => g.matches.map((m) => m.id));
    await pool(allMatches, GENERAL_CONCURRENCY, async (matchId) => {
      const scoreA = Math.floor(Math.random() * 5);
      let scoreB = Math.floor(Math.random() * 5);
      if (scoreA === scoreB) scoreB = scoreA + 1; // avoid draws so standings always separate cleanly
      const res = await api(`/api/admin/tournaments/${report.eventId}/group-result`, {
        method: "PUT",
        body: { matchId, scoreA, scoreB },
        jar: adminJar,
      });
      if (res.status !== 200) {
        groupMatchFailures.push({ matchId, status: res.status, body: res.json });
        return;
      }
      groupMatchOk++;
    });
    report.counts.group_matches_ok = groupMatchOk;
    report.counts.group_matches_failed = groupMatchFailures.length;
    if (groupMatchFailures.length) report.errors.push({ phase: "group_matches", sample: groupMatchFailures.slice(0, 5) });
  });
  log(`group matches recorded: ${groupMatchOk}/${report.groupMatchesTotal} (failed: ${groupMatchFailures.length})`);

  // Phase 7: generate the knockout bracket from group qualifiers
  await timePhase("7_generate_knockout", async () => {
    const res = await api(`/api/admin/tournaments/${report.eventId}/generate-knockout`, { method: "POST", jar: adminJar });
    if (res.status !== 200) throw new Error("knockout generation failed: " + JSON.stringify(res.json));
    report.knockoutRounds = res.json.tournament.knockout.rounds.length;
    report.knockoutRound0Size = res.json.tournament.knockout.rounds[0].length;
  });
  log(`knockout bracket: ${report.knockoutRounds} rounds, round-0 has ${report.knockoutRound0Size} matches`);

  // Phase 8: play out the knockout bracket round by round until the final is decided
  let knockoutMatchOk = 0;
  let knockoutMatchFailures = [];
  await timePhase("8_play_knockout", async () => {
    for (let roundIndex = 0; roundIndex < report.knockoutRounds; roundIndex++) {
      const tRes = await api(`/api/admin/tournaments/${report.eventId}`, { jar: adminJar });
      const round = tRes.json.tournament.knockout.rounds[roundIndex];
      const playable = round.filter((m) => !m.bye && !m.winnerId && m.a && m.b);
      await pool(playable, GENERAL_CONCURRENCY, async (m) => {
        const scoreA = Math.floor(Math.random() * 5);
        let scoreB = Math.floor(Math.random() * 5);
        if (scoreA === scoreB) scoreB = scoreA + 1;
        const res = await api(`/api/admin/tournaments/${report.eventId}/knockout-result`, {
          method: "PUT",
          body: { roundIndex, matchId: m.id, scoreA, scoreB },
          jar: adminJar,
        });
        if (res.status !== 200) {
          knockoutMatchFailures.push({ roundIndex, matchId: m.id, status: res.status, body: res.json });
          return;
        }
        knockoutMatchOk++;
      });
      log(`  round ${roundIndex}: played ${playable.length} matches`);
    }
    report.counts.knockout_matches_ok = knockoutMatchOk;
    report.counts.knockout_matches_failed = knockoutMatchFailures.length;
    if (knockoutMatchFailures.length) report.errors.push({ phase: "knockout_matches", sample: knockoutMatchFailures.slice(0, 5) });
  });
  log(`knockout matches recorded: ${knockoutMatchOk} (failed: ${knockoutMatchFailures.length})`);

  // Phase 9: award points + verify final state
  await timePhase("9_award_points_and_verify", async () => {
    const awardRes = await api(`/api/admin/tournaments/${report.eventId}/award-points`, { method: "POST", jar: adminJar });
    if (awardRes.status !== 200) throw new Error("award-points failed: " + JSON.stringify(awardRes.json));

    const finalRes = await api(`/api/admin/tournaments/${report.eventId}`, { jar: adminJar });
    const t = finalRes.json.tournament;
    report.finalStatus = t.status;
    report.standings = t.standings;
    report.winnerEntrantId = (t.standings || []).find((s) => s.rank === 1)?.entrantId || null;

    const undecidedKnockout = t.knockout.rounds.flat().filter((m) => !m.bye && !m.winnerId).length;
    const undecidedGroup = t.groups.reduce((s, g) => s + g.matches.filter((m) => !m.result).length, 0);
    report.undecidedKnockoutMatches = undecidedKnockout;
    report.undecidedGroupMatches = undecidedGroup;
  });

  // Final sanity: reconcile headline counts
  report.counts.members_target = N;
  report.summary = {
    allMembersSignedUp: report.counts.signup_ok === N,
    allMembersRegistered: report.counts.register_ok === N,
    allQrIssued: report.counts.qr_issued === N,
    allCheckedIn: report.counts.checkin_ok === N,
    allGroupMatchesPlayed: report.counts.group_matches_ok === report.groupMatchesTotal,
    allKnockoutMatchesPlayed: report.counts.knockout_matches_failed === 0 && report.undecidedKnockoutMatches === 0,
    tournamentCompleted: report.finalStatus === "completed",
    hasWinner: !!report.winnerEntrantId,
    totalErrors: report.errors.length,
  };
  report.finishedAt = new Date().toISOString();
  report.totalSeconds = Object.values(report.phases).reduce((s, p) => s + p.seconds, 0);

  const fs = require("fs");
  fs.writeFileSync(require("path").join(__dirname, "report.json"), JSON.stringify(report, null, 2));
  log("=== SUMMARY ===");
  log(JSON.stringify(report.summary, null, 2));
  log(`Total time: ${report.totalSeconds}s`);
  log("Full report written to loadtest/report.json");
})().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
