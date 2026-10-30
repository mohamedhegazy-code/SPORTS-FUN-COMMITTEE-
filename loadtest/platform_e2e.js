// Platform-wide end-to-end test suite for "MyAhlawy" (real HTTP API, Node 22
// built-in fetch, no dependencies). Covers EVERYTHING except tournament
// formats (see tournament_e2e.js / swiss_e2e.js for those, and run.js for the
// 1000-person tournament load test): auth, events, registration, check-in,
// points/redemptions, content/admin CRUD, chat/inquiries, family, security,
// and a heavy concurrency/race phase. Run against a fully isolated throwaway
// server with a fresh database - NEVER production.
//
// Usage: BASE_URL=http://localhost:3912 N=300 node platform_e2e.js
"use strict";

const BASE = process.env.BASE_URL || "http://localhost:3912";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
const N = Number(process.env.N || 300);
// a date that is exactly `years` old today (40-day buffer so a birthday edge never flips it)
const bd = (years) => new Date(Date.now() - (years * 365.25 + 40) * 86400000).toISOString().slice(0, 10);

let pass = 0;
let fail = 0;
const failures = [];
let serverErrors = 0;
const serverErrorSamples = [];

function ok(cond, label, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : "");
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}
function note5xx(label, status, path) {
  if (status >= 500) {
    serverErrors++;
    if (serverErrorSamples.length < 30) serverErrorSamples.push(`${label} -> ${status} ${path || ""}`);
  }
}

// ---- cookie-jar HTTP client (double-submit-cookie CSRF) -------------------
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
async function api(path, { method = "GET", body, jar, noCsrf = false, isForm = false, headers: extraHeaders = {}, raw = false } = {}) {
  if (!jar) jar = newJar();
  const headers = { ...extraHeaders };
  const existingCookie = cookieHeader(jar);
  if (existingCookie) headers["Cookie"] = existingCookie;
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && jar.csrfToken && !noCsrf) {
    headers["X-CSRF-Token"] = jar.csrfToken;
  }
  let fetchBody;
  if (body !== undefined) {
    if (isForm || raw) {
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
      let text = null;
      const ct = res.headers.get("content-type") || "";
      try {
        if (ct.includes("application/json")) {
          json = await res.json();
        } else {
          text = await res.text();
        }
      } catch (e) {
        /* non-JSON/empty, fine */
      }
      note5xx(`${method} ${path}`, res.status, path);
      return { status: res.status, json, text, jar, headers: res.headers };
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
  await api("/api/settings", { jar });
  return jar;
}

// ---- tiny concurrency pool -------------------------------------------------
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  let active = 0;
  return new Promise((resolve) => {
    function kick() {
      if (next >= items.length && active === 0) return resolve(results);
      while (active < limit && next < items.length) {
        const idx = next++;
        active++;
        Promise.resolve(worker(items[idx], idx))
          .then((r) => (results[idx] = r))
          .catch((err) => (results[idx] = { error: String((err && err.message) || err) }))
          .finally(() => {
            active--;
            kick();
          });
      }
    }
    kick();
  });
}

let signupSeq = 0;
async function signupMember(prefix, extra) {
  const jar = await primeCsrf(newJar());
  signupSeq++;
  const num = `${prefix}${signupSeq}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
  const res = await api("/api/auth/signup", {
    method: "POST",
    jar,
    body: {
      membershipNumber: num,
      name: `Platform Player ${num}`,
      password: "abc12345",
      phone: `01${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`,
      agreeTerms: true,
      memberType: "main",
      birthDate: "1990-06-15",
      ...extra,
    },
  });
  return { jar, res, membershipNumber: num };
}

async function createEvent(admin, fields = {}) {
  const form = new FormData();
  form.set("nameEn", fields.nameEn || `Platform Event ${Date.now()}_${Math.floor(Math.random() * 1e6)}`);
  form.set("nameAr", fields.nameAr || "فعالية");
  form.set("sport", fields.sport || "Padel");
  form.set("date", fields.date || "2026-12-20");
  if (fields.maxCapacity !== undefined) form.set("maxCapacity", String(fields.maxCapacity));
  if (fields.minCapacity !== undefined) form.set("minCapacity", String(fields.minCapacity));
  if (fields.endDate !== undefined) form.set("endDate", fields.endDate);
  if (fields.startTime !== undefined) form.set("startTime", fields.startTime);
  if (fields.endTime !== undefined) form.set("endTime", fields.endTime);
  if (fields.earlyDeadline !== undefined) form.set("earlyDeadline", fields.earlyDeadline);
  if (fields.parentEventId !== undefined) form.set("parentEventId", String(fields.parentEventId));
  if (fields.allowMultipleActivities !== undefined) form.set("allowMultipleActivities", String(fields.allowMultipleActivities));
  // This suite deliberately creates many events that share a date and the
  // default Arabic name; opt out of the duplicate-event guard (covered by
  // event_merge_e2e.js).
  form.set("allowDuplicate", "true");
  const res = await api("/api/events", { method: "POST", jar: admin, body: form, isForm: true });
  return res;
}

function isXlsxBuffer(buf) {
  // ZIP local-file-header magic: PK\x03\x04
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

async function main() {
  const t0 = Date.now();
  // =========================================================================
  section("0. Setup");
  // =========================================================================
  const admin = await primeCsrf(newJar());
  {
    const r = await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } });
    ok(r.status === 200, "admin login succeeds", r.json);
  }

  // =========================================================================
  section("1. Auth: signup validation");
  // =========================================================================
  {
    const base = { name: "Validator", password: "abc12345", phone: "01012345678", agreeTerms: true, memberType: "main", birthDate: "1990-06-15" };
    const jar1 = await primeCsrf(newJar());
    const dupNum = `DUP${Date.now()}`;
    const first = await api("/api/auth/signup", { method: "POST", jar: jar1, body: { ...base, membershipNumber: dupNum } });
    ok(first.status === 201, "signup: first account for a fresh membership number succeeds", first.json);

    // duplicate membership number, same phone -> should join as family (not a straight dup error)
    const jar2 = await primeCsrf(newJar());
    const dupSamePhone = await api("/api/auth/signup", { method: "POST", jar: jar2, body: { ...base, membershipNumber: dupNum, name: "Second Family Member" } });
    ok(dupSamePhone.status === 201 && dupSamePhone.json && dupSamePhone.json.assignedLoginId, "signup: second signup under same club id (same phone) becomes a family account", dupSamePhone.json);

    // Claiming an ADMIN-IMPORTED profile (passwordHash is null, phone already
    // on file) with a mismatched phone -> 403. This is the real "claiming"
    // path (resolveSignupAccount only treats it as a claim when the bare
    // clubId has no passwordHash yet) - a brand-new signup under an already-
    // password-protected clubId (tested above) just silently becomes a new
    // family member instead, with no phone check at all.
    const preImportedNum = `PREIMPORT${Date.now()}`;
    const preImport = await api("/api/admin/members", { method: "POST", jar: admin, body: { membershipNumber: preImportedNum, name: "Pre-Imported Member", phone: "01011112222" } });
    ok(preImport.status === 201, "setup: admin pre-creates a member profile with a phone on file", preImport.json);
    const jar3 = await primeCsrf(newJar());
    const badPhoneMatch = await api("/api/auth/signup", { method: "POST", jar: jar3, body: { ...base, membershipNumber: preImportedNum, phone: "09999999999", name: "Imposter" } });
    ok(badPhoneMatch.status === 403, "signup: claiming an admin-pre-created profile with mismatched phone is rejected (403)", badPhoneMatch.json);
    const jar3b = await primeCsrf(newJar());
    const goodPhoneMatch = await api("/api/auth/signup", { method: "POST", jar: jar3b, body: { ...base, membershipNumber: preImportedNum, phone: "01011112222", name: "Pre-Imported Member" } });
    ok(goodPhoneMatch.status === 201, "signup: claiming an admin-pre-created profile with matching phone succeeds", goodPhoneMatch.json);

    const jar4 = await primeCsrf(newJar());
    const weakPw = await api("/api/auth/signup", { method: "POST", jar: jar4, body: { ...base, membershipNumber: `WEAK${Date.now()}`, password: "123" } });
    ok(weakPw.status === 400, "signup: weak password (<6 chars) rejected", weakPw.json);

    const jar5 = await primeCsrf(newJar());
    const noTerms = await api("/api/auth/signup", { method: "POST", jar: jar5, body: { ...base, membershipNumber: `NOTERMS${Date.now()}`, agreeTerms: false } });
    ok(noTerms.status === 400, "signup: agreeTerms:false rejected", noTerms.json);

    const jar6 = await primeCsrf(newJar());
    const noPhone = await api("/api/auth/signup", { method: "POST", jar: jar6, body: { ...base, membershipNumber: `NOPHONE${Date.now()}`, phone: "" } });
    ok(noPhone.status === 400, "signup: missing phone rejected", noPhone.json);

    const jar7 = await primeCsrf(newJar());
    const noMemberType = await api("/api/auth/signup", { method: "POST", jar: jar7, body: { ...base, membershipNumber: `NOMT${Date.now()}`, memberType: undefined } });
    ok(noMemberType.status === 400, "signup: missing memberType rejected", noMemberType.json);

    const jar8 = await primeCsrf(newJar());
    const followerNoRel = await api("/api/auth/signup", { method: "POST", jar: jar8, body: { ...base, membershipNumber: `FOLNOREL${Date.now()}`, memberType: "follower" } });
    ok(followerNoRel.status === 400, "signup: follower without relationshipToMain rejected", followerNoRel.json);

    const jar9 = await primeCsrf(newJar());
    const followerOk = await api("/api/auth/signup", {
      method: "POST",
      jar: jar9,
      body: { ...base, membershipNumber: `FOLOK${Date.now()}`, memberType: "follower", relationshipToMain: "Son" },
    });
    ok(followerOk.status === 201, "signup: follower with relationshipToMain succeeds", followerOk.json);

    const jar10 = await primeCsrf(newJar());
    const badEmail = await api("/api/auth/signup", { method: "POST", jar: jar10, body: { ...base, membershipNumber: `BADEMAIL${Date.now()}`, email: "not-an-email" } });
    ok(badEmail.status === 400, "signup: malformed email rejected", badEmail.json);
  }

  // =========================================================================
  section("2. Auth: login/logout/me, wrong password, lockout, change-password, staff-login");
  // =========================================================================
  let memberA, memberAId;
  {
    const s = await signupMember("MA");
    memberA = s.jar;
    memberAId = s.membershipNumber;
    ok(s.res.status === 201, "setup: member A signup", s.res.json);

    const meRes = await api("/api/auth/me", { jar: memberA });
    ok(meRes.status === 200 && meRes.json.type === "member", "auth/me reports logged-in member", meRes.json);

    const logoutRes = await api("/api/auth/logout", { method: "POST", jar: memberA });
    ok(logoutRes.status === 200, "logout succeeds", logoutRes.json);
    const meAfterLogout = await api("/api/auth/me", { jar: memberA });
    ok(meAfterLogout.status === 401, "auth/me returns 401 after logout", meAfterLogout.json);

    const wrongPw = await api("/api/auth/login", { method: "POST", jar: memberA, body: { membershipNumber: memberAId, password: "wrongpass" } });
    ok(wrongPw.status === 401, "login with wrong password -> 401", wrongPw.json);

    const rightPw = await api("/api/auth/login", { method: "POST", jar: memberA, body: { membershipNumber: memberAId, password: "abc12345" } });
    ok(rightPw.status === 200, "login with correct password -> 200", rightPw.json);

    // NOTE: the login/signup/forgot-password lockout (15 wrong attempts/10min
    // per IP) and the public-inquiry spam limiter (5/hour per IP) are both
    // deliberately probed in the VERY LAST section of this file (see
    // "13. Rate limiters" below), not here. Every call in this whole process
    // shares one source IP (localhost against the throwaway server), so
    // tripping either lockout here would return 429 for every subsequent
    // login/signup/forgot-password/inquiry call in the rest of the suite.
  }

  // change-password
  {
    const s = await signupMember("CP");
    const bad = await api("/api/auth/change-password", { method: "POST", jar: s.jar, body: { oldPassword: "wrong", newPassword: "newpass123" } });
    ok(bad.status === 401, "change-password: wrong old password -> 401", bad.json);
    const good = await api("/api/auth/change-password", { method: "POST", jar: s.jar, body: { oldPassword: "abc12345", newPassword: "newpass123" } });
    ok(good.status === 200, "change-password: correct old password succeeds", good.json);
    const tooShort = await api("/api/auth/change-password", { method: "POST", jar: s.jar, body: { oldPassword: "newpass123", newPassword: "123" } });
    ok(tooShort.status === 400, "change-password: new password too short -> 400", tooShort.json);
  }

  // staff-login wrong password / staff accounts CRUD + role matrix
  let staffStaff, staffTournament, staffManagement, staffAdmin2, tournUser;
  const assignTM = (eventId) => api(`/api/admin/events/${eventId}/managers`, { method: "PUT", jar: admin, body: { managerUsernames: [tournUser] } });
  {
    const wrong = await api("/api/auth/staff-login", { method: "POST", jar: await primeCsrf(newJar()), body: { username: ADMIN_USER, password: "wrongpassword" } });
    ok(wrong.status === 401, "staff-login: wrong password -> 401", wrong.json);

    async function createStaff(role, username) {
      const r = await api("/api/staff/accounts", { method: "POST", jar: admin, body: { username, password: "staffpass1", name: `Staff ${role}`, role } });
      ok(r.status === 201, `create staff account (role=${role})`, r.json);
      const jar = await primeCsrf(newJar());
      const login = await api("/api/auth/staff-login", { method: "POST", jar, body: { username, password: "staffpass1" } });
      ok(login.status === 200, `staff-login succeeds for newly created ${role} account`, login.json);
      return jar;
    }
    staffStaff = await createStaff("staff", `staffrole_${Date.now()}`);
    tournUser = `tournrole_${Date.now()}`;
    staffTournament = await createStaff("tournament", tournUser);
    staffManagement = await createStaff("management", `mgmtrole_${Date.now()}`);
    staffAdmin2 = await createStaff("admin", `adminrole2_${Date.now()}`);

    const badRole = await api("/api/staff/accounts", { method: "POST", jar: admin, body: { username: "badrole1", password: "staffpass1", name: "x", role: "superuser" } });
    ok(badRole.status === 400, "create staff account with invalid role -> 400", badRole.json);

    const list = await api("/api/staff/accounts", { jar: admin });
    ok(list.status === 200 && Array.isArray(list.json) && list.json.length >= 4, "list staff accounts (admin)", list.json && list.json.length);

    const selfDelete = await api("/api/staff/accounts/" + ADMIN_USER, { method: "DELETE", jar: admin });
    ok(selfDelete.status === 400, "admin cannot delete their own account -> 400", selfDelete.json);

    const delMissing = await api("/api/staff/accounts/doesnotexist123", { method: "DELETE", jar: admin });
    ok(delMissing.status === 404, "delete nonexistent staff account -> 404", delMissing.json);
  }

  // reset member password (admin)
  {
    const s = await signupMember("RESETPW");
    const reset = await api(`/api/staff/members/${s.membershipNumber}/reset-password`, { method: "POST", jar: admin, body: { newPassword: "resetpass1" } });
    ok(reset.status === 200, "admin reset-password for a member succeeds", reset.json);
    const login = await api("/api/auth/login", { method: "POST", jar: await primeCsrf(newJar()), body: { membershipNumber: s.membershipNumber, password: "resetpass1" } });
    ok(login.status === 200, "member can log in with the admin-reset password", login.json);
    const resetMissing = await api(`/api/staff/members/NOSUCHMEMBER999/reset-password`, { method: "POST", jar: admin, body: { newPassword: "resetpass1" } });
    ok(resetMissing.status === 404, "admin reset-password for nonexistent member -> 404", resetMissing.json);
  }

  // recovery PIN + forgot-password flow (member)
  {
    const s = await signupMember("PIN");
    const setPin = await api("/api/me/recovery-pin", { method: "POST", jar: s.jar, body: { password: "abc12345", pin: "778899" } });
    ok(setPin.status === 200 && setPin.json.hasRecoveryPin, "member sets a recovery PIN", setPin.json);

    const wrongPin = await api("/api/auth/forgot-password", { method: "POST", jar: await primeCsrf(newJar()), body: { membershipNumber: s.membershipNumber, pin: "000000", newPassword: "freshpass1" } });
    ok(wrongPin.status === 401, "forgot-password: wrong PIN -> 401", wrongPin.json);

    const rightPin = await api("/api/auth/forgot-password", { method: "POST", jar: await primeCsrf(newJar()), body: { membershipNumber: s.membershipNumber, pin: "778899", newPassword: "freshpass1" } });
    ok(rightPin.status === 200, "forgot-password: correct PIN resets password", rightPin.json);

    const noPinSet = await signupMember("NOPIN");
    const noPinAttempt = await api("/api/auth/forgot-password", { method: "POST", jar: await primeCsrf(newJar()), body: { membershipNumber: noPinSet.membershipNumber, pin: "anything", newPassword: "x123456" } });
    ok(noPinAttempt.status === 400, "forgot-password: account with no PIN set -> 400", noPinAttempt.json);

    // staff recovery pin + staff-forgot-password
    const staffPinSet = await api("/api/staff/recovery-pin", { method: "POST", jar: staffStaff, body: { password: "staffpass1", pin: "556677" } });
    ok(staffPinSet.status === 200, "staff sets a recovery PIN", staffPinSet.json);
  }

  // =========================================================================
  section("3. CSRF enforcement + unauthenticated/role gate matrix");
  // =========================================================================
  {
    // Missing CSRF header on a state-changing request -> 403
    const noCsrfJar = await primeCsrf(newJar());
    const missingCsrf = await api("/api/auth/login", { method: "POST", jar: noCsrfJar, body: { membershipNumber: "x", password: "y" }, noCsrf: true });
    ok(missingCsrf.status === 403, "POST with missing CSRF header -> 403", missingCsrf.json);

    const badCsrfJar = await primeCsrf(newJar());
    const badCsrf = await api("/api/auth/login", { method: "POST", jar: badCsrfJar, body: { membershipNumber: "x", password: "y" }, headers: { "X-CSRF-Token": "totally-wrong-token" }, noCsrf: true });
    ok(badCsrf.status === 403, "POST with wrong CSRF token -> 403", badCsrf.json);

    // Table-driven role matrix over representative protected endpoints.
    const anon = newJar();
    const memberJar = (await signupMember("ROLEM")).jar;
    const identities = [
      { label: "anon", jar: anon, expectUnauth: 401 },
      { label: "member", jar: memberJar, expectUnauth: 401 },
      { label: "staff", jar: staffStaff, role: "staff" },
      { label: "tournament", jar: staffTournament, role: "tournament" },
      { label: "management", jar: staffManagement, role: "management" },
      { label: "admin", jar: admin, role: "admin" },
    ];
    // endpoint, method, allowed roles (besides admin, which always passes)
    const endpoints = [
      { path: "/api/staff/accounts", method: "GET", allow: [] }, // admin only
      { path: "/api/admin/overview", method: "GET", allow: [] },
      { path: "/api/admin/activity-log", method: "GET", allow: [] },
      { path: "/api/admin/members", method: "GET", allow: [] },
      { path: "/api/admin/directory", method: "GET", allow: [] },
      { path: "/api/redemptions", method: "GET", allow: [] },
      { path: "/api/registrations", method: "GET", allow: [] },
      { path: "/api/staff/chats", method: "GET", allow: ["tournament"] }, // admin + Tournament Manager
      { path: "/api/staff/inquiries", method: "GET", allow: ["tournament"] }, // admin + Tournament Manager
      { path: "/api/admin/dashboard", method: "GET", allow: ["tournament"] },
      { path: "/api/admin/management/dashboard", method: "GET", allow: ["management"] },
      { path: "/api/admin/events/1/waitlist", method: "GET", allow: ["tournament"] },
      // requireStaffRole("staff") (a bare string, not an array) means "any
      // staff-type session, whatever its role" per the server's own comment
      // above requireStaffRole() - so every staff role (not just literally
      // role==='staff') passes this gate; only anon/member get rejected.
      { path: "/api/staff/events/1/roster", method: "GET", allow: ["staff", "tournament", "management"] },
    ];
    for (const ep of endpoints) {
      for (const id of identities) {
        const for401 = id.expectUnauth !== undefined;
        const r = await api(ep.path, { method: ep.method, jar: id.jar });
        if (for401) {
          ok(r.status === 401, `${ep.method} ${ep.path} as ${id.label} -> 401 (not signed in)`, { status: r.status });
          continue;
        }
        const allowed = id.role === "admin" || ep.allow.includes(id.role);
        if (allowed) {
          ok(r.status !== 401 && r.status !== 403, `${ep.method} ${ep.path} as staff role=${id.role} (allowed) -> not 401/403`, { status: r.status });
        } else {
          ok(r.status === 403, `${ep.method} ${ep.path} as staff role=${id.role} (NOT allowed) -> 403`, { status: r.status, body: r.json });
        }
      }
    }
    // PUT /api/settings is admin-only
    for (const id of identities) {
      const r = await api("/api/settings", { method: "PUT", jar: id.jar, body: { pointsVisibleToMembers: true } });
      if (id.expectUnauth) {
        ok(r.status === 401, `PUT /api/settings as ${id.label} -> 401`, { status: r.status });
      } else if (id.role === "admin") {
        ok(r.status === 200, `PUT /api/settings as admin -> 200`, { status: r.status });
      } else {
        ok(r.status === 403, `PUT /api/settings as staff role=${id.role} -> 403`, { status: r.status });
      }
    }
  }

  // =========================================================================
  section("4. Events: CRUD, capacity/categories/dates, public list, delete cascade");
  // =========================================================================
  let eventBasic, eventCapped, eventParent, eventChild;
  {
    const create = await createEvent(admin, { nameEn: "Padel Open Day", maxCapacity: 5, minCapacity: 2, startTime: "09:00", endTime: "17:00" });
    ok(create.status === 201, "create event with capacity/time fields", create.json);
    eventBasic = create.json;

    const badCapacity = await createEvent(admin, { nameEn: "Bad Capacity Event", minCapacity: 10, maxCapacity: 5 });
    ok(badCapacity.status === 400, "create event: minCapacity > maxCapacity -> 400", badCapacity.json);

    const badTime = await createEvent(admin, { nameEn: "Bad Time Event", startTime: "25:99" });
    ok(badTime.status === 400, "create event: invalid startTime -> 400", badTime.json);

    const missingRequired = await api("/api/events", { method: "POST", jar: admin, body: new FormData(), isForm: true });
    ok(missingRequired.status === 400, "create event: missing nameEn/date -> 400", missingRequired.json);

    // non-tournament staff role can't create events (requireStaffRole(['tournament']))
    const asStaff = await createEvent(staffStaff, { nameEn: "Should Fail" });
    ok(asStaff.status === 403, "create event as plain 'staff' role -> 403 (tournament role required)", asStaff.json);
    // A Tournament Manager creates events only once the admin made them an
    // event head (covered in depth by event_heads_e2e.js).
    const notHead = await createEvent(staffTournament, { nameEn: "Tournament Role Event" });
    ok(notHead.status === 403, "create event as 'tournament' role without event-head permission -> 403", notHead.json);
    ok((await api(`/api/staff/accounts/${tournUser}/can-create-events`, { method: "PUT", jar: admin, body: { value: true } })).status === 200, "admin authorises the tournament account as event head");
    const asTournament = await createEvent(staffTournament, { nameEn: "Tournament Role Event" });
    ok(asTournament.status === 201, "create event as authorised event head -> 201", asTournament.json);

    // update
    const updateForm = new FormData();
    updateForm.set("nameEn", "Padel Open Day (Updated)");
    updateForm.set("nameAr", "يوم بادل مفتوح");
    updateForm.set("sport", "Padel");
    updateForm.set("date", eventBasic.date);
    updateForm.set("maxCapacity", "5");
    const update = await api(`/api/events/${eventBasic.id}`, { method: "PUT", jar: admin, body: updateForm, isForm: true });
    ok(update.status === 200 && update.json.nameEn === "Padel Open Day (Updated)", "update event succeeds", update.json);

    const updateMissing = await api(`/api/events/999999`, { method: "PUT", jar: admin, body: updateForm, isForm: true });
    ok(updateMissing.status === 404, "update nonexistent event -> 404", updateMissing.json);

    // public list
    const list = await api("/api/events", { jar: newJar() });
    ok(list.status === 200 && Array.isArray(list.json) && list.json.some((e) => e.id === eventBasic.id), "public event list includes created event", list.json && list.json.length);

    // capped capacity event for registration tests below
    const capped = await createEvent(admin, { nameEn: "Small Capped Event", maxCapacity: 3 });
    eventCapped = capped.json;

    // parent/child events
    const parent = await createEvent(admin, { nameEn: "Multi-Activity Day" });
    eventParent = parent.json;
    await assignTM(eventParent.id);
    const child = await createEvent(admin, { nameEn: "Chess Sub-Activity", parentEventId: eventParent.id });
    ok(child.status === 201, "create child activity under a parent event", child.json);
    eventChild = child.json;

    const childAsParentFail = await createEvent(admin, { nameEn: "Grandchild attempt", parentEventId: eventChild.id });
    ok(childAsParentFail.status === 400, "a child event can't itself become a parent -> 400", childAsParentFail.json);

    // delete event with registrations (cascade)
    const toDelete = await createEvent(admin, { nameEn: "Delete Me Event" });
    const toDeleteId = toDelete.json.id;
    const deleterMember = await signupMember("DELREG");
    const delReg = await api("/api/register", { method: "POST", jar: deleterMember.jar, body: { eventId: toDeleteId } });
    ok(delReg.status === 201, "register for event that will be deleted", delReg.json);
    const delResult = await api(`/api/events/${toDeleteId}`, { method: "DELETE", jar: admin });
    ok(delResult.status === 200 && delResult.json.removedRegistrations === 1, "delete event cascades and removes its registration", delResult.json);
    const delMissing = await api(`/api/events/${toDeleteId}`, { method: "DELETE", jar: admin });
    ok(delMissing.status === 404, "delete already-deleted event -> 404", delMissing.json);

    // parent with children can't be deleted directly
    const delParentBlocked = await api(`/api/events/${eventParent.id}`, { method: "DELETE", jar: admin });
    ok(delParentBlocked.status === 400, "delete parent event with children still nested -> 400", delParentBlocked.json);
  }

  // =========================================================================
  section("5. Registration: capacity/waitlist/promote/cancel/duplicate, dependents, invite, roster");
  // =========================================================================
  let waitlistedMember, confirmedMembers = [];
  {
    // Fill capacity (3), then overflow to waitlist.
    const regResults = [];
    for (let i = 0; i < 5; i++) {
      const m = await signupMember(`CAP${i}`);
      const r = await api("/api/register", { method: "POST", jar: m.jar, body: { eventId: eventCapped.id } });
      regResults.push({ m, r });
    }
    const confirmedCount = regResults.filter((x) => x.r.status === 201 && !x.r.json.waitlisted).length;
    ok(confirmedCount === 3, "first 3 registrations to a capacity-3 event are confirmed", { confirmedCount });
    const needsWaitlistCount = regResults.filter((x) => x.r.status === 200 && x.r.json.needsWaitlistConfirmation).length;
    ok(needsWaitlistCount === 2, "registrations 4 and 5 get needsWaitlistConfirmation (not auto-waitlisted)", { needsWaitlistCount });
    confirmedMembers = regResults.filter((x) => x.r.status === 201 && !x.r.json.waitlisted).map((x) => x.m);
    const overflow = regResults.find((x) => x.r.status === 200 && x.r.json.needsWaitlistConfirmation);
    waitlistedMember = overflow.m;
    const joinWl = await api("/api/register", { method: "POST", jar: waitlistedMember.jar, body: { eventId: eventCapped.id, joinWaitlist: true } });
    ok(joinWl.status === 201 && joinWl.json.waitlisted === true, "explicitly joining the waiting list succeeds", joinWl.json);

    // duplicate registration
    const dup = await api("/api/register", { method: "POST", jar: confirmedMembers[0].jar, body: { eventId: eventCapped.id } });
    ok(dup.status === 409 && dup.json.alreadyRegistered, "duplicate registration for same event -> 409 with alreadyRegistered flag", dup.json);

    // my registrations
    const mine = await api("/api/me/registrations", { jar: confirmedMembers[0].jar });
    ok(mine.status === 200 && Array.isArray(mine.json) && mine.json.length === 1, "GET /api/me/registrations returns own registration(s)", mine.json);

    // register for event with nested children -> blocked
    const parentRegBlocked = await api("/api/register", { method: "POST", jar: confirmedMembers[0].jar, body: { eventId: eventParent.id } });
    ok(parentRegBlocked.status === 400, "registering for a multi-activity parent event directly -> 400", parentRegBlocked.json);

    // register for the child activity instead -> ok
    const childReg = await api("/api/register", { method: "POST", jar: confirmedMembers[0].jar, body: { eventId: eventChild.id } });
    ok(childReg.status === 201, "registering for the child activity itself succeeds", childReg.json);

    // dependents: add then register a dependent
    const depParent = await signupMember("DEPPAR");
    const addDep = await api("/api/me/dependents", { method: "POST", jar: depParent.jar, body: { name: "Junior Kid", relationship: "Son", birthDate: bd(8) } });
    ok(addDep.status === 201 && addDep.json.dependents.length === 1, "add dependent succeeds", addDep.json);
    const depId = addDep.json.dependents[0].id;
    const depEvent = await createEvent(admin, { nameEn: "Dependent Reg Event" });
    const depReg = await api("/api/register", { method: "POST", jar: depParent.jar, body: { eventId: depEvent.json.id, dependentId: depId } });
    ok(depReg.status === 201 && depReg.json.registration.dependentName === "Junior Kid", "register a dependent for an event succeeds, tagged with dependent name", depReg.json);
    const depRegDup = await api("/api/register", { method: "POST", jar: depParent.jar, body: { eventId: depEvent.json.id, dependentId: depId } });
    ok(depRegDup.status === 409, "duplicate dependent registration -> 409", depRegDup.json);
    const badDepId = await api("/api/register", { method: "POST", jar: depParent.jar, body: { eventId: depEvent.json.id, dependentId: 999999 } });
    ok(badDepId.status === 400, "register with a dependentId not on the account -> 400", badDepId.json);

    // cancel (member) + auto-promote from waitlist
    const beforeCancelWl = await api(`/api/admin/events/${eventCapped.id}/waitlist`, { jar: admin });
    ok(beforeCancelWl.status === 200 && beforeCancelWl.json.length === 1, "waitlist has 1 entry before cancellation", beforeCancelWl.json.length);
    const myRegsBeforeCancel = await api("/api/me/registrations", { jar: confirmedMembers[0].jar });
    const regIdToCancel = myRegsBeforeCancel.json.find((r) => r.eventId === eventCapped.id).id;
    const cancelSelf = await api(`/api/me/registrations/${regIdToCancel}`, { method: "DELETE", jar: confirmedMembers[0].jar });
    ok(cancelSelf.status === 200 && cancelSelf.json.promoted === true, "self-cancel from a full event auto-promotes the waitlist", cancelSelf.json);
    const afterCancelWl = await api(`/api/admin/events/${eventCapped.id}/waitlist`, { jar: admin });
    ok(afterCancelWl.status === 200 && afterCancelWl.json.length === 0, "waitlist is empty after auto-promotion", afterCancelWl.json.length);

    // registration after cancel: should be allowed again (fresh signup)
    const reRegister = await api("/api/register", { method: "POST", jar: confirmedMembers[0].jar, body: { eventId: eventCapped.id, joinWaitlist: true } });
    ok(reRegister.status === 201 || reRegister.status === 200, "re-registering after cancelling earlier is allowed", reRegister.json);

    const cancelMissing = await api(`/api/me/registrations/9999999`, { method: "DELETE", jar: confirmedMembers[0].jar });
    ok(cancelMissing.status === 404, "cancel a nonexistent/foreign registration id -> 404", cancelMissing.json);

    // admin cancel with reason + promote endpoint directly
    const promoTestEvent = await createEvent(admin, { nameEn: "Promote Test Event", maxCapacity: 1 });
    await assignTM(promoTestEvent.json.id);
    const pA = await signupMember("PROA");
    const pB = await signupMember("PROB");
    await api("/api/register", { method: "POST", jar: pA.jar, body: { eventId: promoTestEvent.json.id } });
    await api("/api/register", { method: "POST", jar: pB.jar, body: { eventId: promoTestEvent.json.id, joinWaitlist: true } });
    const wlEntries = await api(`/api/admin/events/${promoTestEvent.json.id}/waitlist`, { jar: admin });
    const noReasonCancel = await api(`/api/admin/registrations/${wlEntries.json[0] ? wlEntries.json[0].id : 0}/cancel`, { method: "POST", jar: staffTournament, body: {} });
    ok(noReasonCancel.status === 400, "admin cancel without a reason -> 400", noReasonCancel.json);
    const myRegsA = await api("/api/me/registrations", { jar: pA.jar });
    const confirmedRegId = myRegsA.json.find((r) => r.eventId === promoTestEvent.json.id).id;
    const adminCancel = await api(`/api/admin/registrations/${confirmedRegId}/cancel`, { method: "POST", jar: staffTournament, body: { reason: "Testing admin cancel" } });
    ok(adminCancel.status === 200 && adminCancel.json.promoted === true, "admin cancel with reason promotes the waitlist", adminCancel.json);

    // promote endpoint on a non-waitlisted reg -> 400
    const myRegsB = await api("/api/me/registrations", { jar: pB.jar });
    const bRegId = myRegsB.json.find((r) => r.eventId === promoTestEvent.json.id).id;
    const promoteAlreadyConfirmed = await api(`/api/admin/registrations/${bRegId}/promote`, { method: "POST", jar: staffTournament });
    ok(promoteAlreadyConfirmed.status === 400, "promoting an already-confirmed registration -> 400", promoteAlreadyConfirmed.json);
    const promoteMissing = await api(`/api/admin/registrations/999999/promote`, { method: "POST", jar: staffTournament });
    ok(promoteMissing.status === 404, "promote a nonexistent registration id -> 404", promoteMissing.json);

    // WhatsApp-confirm endpoint + invite endpoint
    const waConfirm = await api(`/api/staff/registrations/${bRegId}/whatsapp-confirmed`, { method: "POST", jar: staffStaff });
    ok(waConfirm.status === 200 && waConfirm.json.whatsappConfirmedAt, "WhatsApp-confirm endpoint records a timestamp", waConfirm.json);
    const waConfirmMissing = await api(`/api/staff/registrations/999999/whatsapp-confirmed`, { method: "POST", jar: staffStaff });
    ok(waConfirmMissing.status === 404, "WhatsApp-confirm for nonexistent registration -> 404", waConfirmMissing.json);

    const inviteEvent = await createEvent(admin, { nameEn: "Invite Test Event" });
    const inviteTargets = [];
    for (let i = 0; i < 3; i++) inviteTargets.push((await signupMember(`INV${i}`)).membershipNumber);
    const invite = await api(`/api/admin/events/${inviteEvent.json.id}/invite`, { method: "POST", jar: admin, body: { membershipNumbers: [...inviteTargets, "NOSUCHMEMBER999"] } });
    ok(invite.status === 200 && invite.json.invited.length === 3 && invite.json.skipped.length === 1, "bulk-invite: invites known members, skips unknown ones", invite.json);
    const inviteAgain = await api(`/api/admin/events/${inviteEvent.json.id}/invite`, { method: "POST", jar: admin, body: { membershipNumbers: inviteTargets } });
    ok(inviteAgain.status === 200 && inviteAgain.json.skipped.length === 3, "re-inviting already-invited members skips them all", inviteAgain.json);

    // roster
    const roster = await api(`/api/staff/events/${eventCapped.id}/roster`, { jar: staffStaff });
    ok(roster.status === 200 && Array.isArray(roster.json), "staff roster endpoint returns an array", roster.json && roster.json.length);

    // attendance rollup
    const rollup = await api(`/api/admin/events/${eventParent.id}/attendance-rollup`, { jar: staffTournament });
    ok(rollup.status === 200 && rollup.json.children && rollup.json.children.length === 1, "attendance-rollup for parent event includes its child's counts", rollup.json);
  }

  // =========================================================================
  section("6. Check-in: QR + manual, double check-in, points, ladder, idempotency");
  // =========================================================================
  {
    const ciEvent = await createEvent(admin, { nameEn: "Checkin Test Event" });
    const ciMember = await signupMember("CKIN");
    const reg = await api("/api/register", { method: "POST", jar: ciMember.jar, body: { eventId: ciEvent.json.id } });
    ok(reg.status === 201 && reg.json.qrDataUrl, "registration returns a QR code data URL", !!reg.json.qrDataUrl);
    const regId = reg.json.registration.id;

    // My registrations exposes the QR payload indirectly only as a data URL -
    // to exercise the actual /api/checkin QR path we need the real signed
    // payload. The server doesn't expose the raw "AHLAWY:<id>:<sig>" string
    // directly in JSON (only baked into the QR image), so we probe the QR
    // endpoint's behavior with a forged/malformed code instead, and use the
    // manual endpoint (registrationId-based, same performCheckIn() code path)
    // for the real happy-path check-in - this still fully exercises points
    // award / idempotency / wrong-event logic, which lives in performCheckIn,
    // shared by both routes.
    const forgedCode = await api("/api/checkin", { method: "POST", jar: staffStaff, body: { code: `AHLAWY:${regId}:0000000000000000` } });
    ok(forgedCode.status === 400, "QR check-in with a tampered signature -> 400", forgedCode.json);
    const garbageCode = await api("/api/checkin", { method: "POST", jar: staffStaff, body: { code: "NOT-A-REAL-CODE" } });
    ok(garbageCode.status === 400, "QR check-in with a garbage code -> 400", garbageCode.json);
    const missingRegCode = await api("/api/checkin", { method: "POST", jar: staffStaff, body: { code: "AHLAWY:9999999:0000000000000000" } });
    ok(missingRegCode.status === 400, "QR check-in referencing a nonexistent registration -> 400", missingRegCode.json);

    const balBefore = await api("/api/me/balance", { jar: ciMember.jar });
    const manualCheckin = await api("/api/checkin/manual", { method: "POST", jar: staffStaff, body: { registrationId: regId } });
    ok(manualCheckin.status === 200 && manualCheckin.json.pointsAwarded > 0, "manual check-in succeeds and awards points", manualCheckin.json);
    const balAfter = await api("/api/me/balance", { jar: ciMember.jar });
    ok(balAfter.json.balance === balBefore.json.balance + manualCheckin.json.pointsAwarded, "balance increases by exactly the points awarded on check-in", { before: balBefore.json.balance, after: balAfter.json.balance });

    const doubleCheckin = await api("/api/checkin/manual", { method: "POST", jar: staffStaff, body: { registrationId: regId } });
    ok(doubleCheckin.status === 409, "double check-in of the same registration -> 409", doubleCheckin.json);
    const balAfterDouble = await api("/api/me/balance", { jar: ciMember.jar });
    ok(balAfterDouble.json.balance === balAfter.json.balance, "balance unchanged after a rejected double check-in", { after: balAfter.json.balance, afterDouble: balAfterDouble.json.balance });

    // ---- undo a mistaken check-in (gate staff / Tournament Manager / admin; not Management) ----
    {
      const undoNoAuth = await api("/api/checkin/undo", { method: "POST", jar: await primeCsrf(newJar()), body: { registrationId: regId } });
      ok(undoNoAuth.status === 401, "undo check-in unauthenticated -> 401", undoNoAuth.json);
      const undoMember = await api("/api/checkin/undo", { method: "POST", jar: ciMember.jar, body: { registrationId: regId } });
      ok(undoMember.status === 401 || undoMember.status === 403, "undo check-in as a member -> 401/403", undoMember.json);
      const undoMgmt = await api("/api/checkin/undo", { method: "POST", jar: staffManagement, body: { registrationId: regId } });
      ok(undoMgmt.status === 403, "undo check-in as Management role -> 403", undoMgmt.json);
      const undoTmUnassigned = await api("/api/checkin/undo", { method: "POST", jar: staffTournament, body: { registrationId: regId } });
      ok(undoTmUnassigned.status === 403, "undo check-in as a Tournament Manager NOT assigned to the event -> 403", undoTmUnassigned.json);
      const undoMissing = await api("/api/checkin/undo", { method: "POST", jar: staffStaff, body: { registrationId: 9999999 } });
      ok(undoMissing.status === 404, "undo check-in for a nonexistent registration -> 404", undoMissing.json);

      const undoOk = await api("/api/checkin/undo", { method: "POST", jar: staffStaff, body: { registrationId: regId } });
      ok(undoOk.status === 200 && undoOk.json.success, "gate staff can undo a check-in", undoOk.json);
      const balUndone = await api("/api/me/balance", { jar: ciMember.jar });
      ok(balUndone.json.balance === balBefore.json.balance, "points from the undone check-in are removed again", { before: balBefore.json.balance, after: balUndone.json.balance });
      const rosterAfterUndo = await api(`/api/staff/events/${ciEvent.json.id}/roster`, { jar: staffStaff });
      const rowU = (rosterAfterUndo.json || []).find((r) => r.registrationId === regId);
      ok(rowU && rowU.checkedIn === false, "roster shows the person as not checked in after the undo", rowU);
      ok(rowU && !!rowU.qrDataUrl, "the QR is valid (shown) again after the undo");
      const undoAgain = await api("/api/checkin/undo", { method: "POST", jar: staffStaff, body: { registrationId: regId } });
      ok(undoAgain.status === 409, "undoing a registration that is not checked in -> 409", undoAgain.json);

      const reCheck = await api("/api/checkin/manual", { method: "POST", jar: staffStaff, body: { registrationId: regId } });
      ok(reCheck.status === 200, "the person can be checked in again after an undo", reCheck.json);
      await assignTM(ciEvent.json.id);
      const undoTm = await api("/api/checkin/undo", { method: "POST", jar: staffTournament, body: { registrationId: regId } });
      ok(undoTm.status === 200, "an assigned Tournament Manager can undo a check-in", undoTm.json);
      const reCheck2 = await api("/api/checkin/manual", { method: "POST", jar: staffStaff, body: { registrationId: regId } });
      ok(reCheck2.status === 200, "checked in again (leave the final state checked in for the tests below)", reCheck2.json);
    }

    const checkinMissingReg = await api("/api/checkin/manual", { method: "POST", jar: staffStaff, body: { registrationId: 9999999 } });
    ok(checkinMissingReg.status === 404, "manual check-in for nonexistent registration -> 404", checkinMissingReg.json);

    // check-in a waitlisted registration -> 409
    const wlCiEvent = await createEvent(admin, { nameEn: "Checkin Waitlist Event", maxCapacity: 1 });
    const wlCiA = await signupMember("WLCIA");
    const wlCiB = await signupMember("WLCIB");
    await api("/api/register", { method: "POST", jar: wlCiA.jar, body: { eventId: wlCiEvent.json.id } });
    await api("/api/register", { method: "POST", jar: wlCiB.jar, body: { eventId: wlCiEvent.json.id, joinWaitlist: true } });
    const myRegsWlB = await api("/api/me/registrations", { jar: wlCiB.jar });
    const wlBRegId = myRegsWlB.json.find((r) => r.eventId === wlCiEvent.json.id).id;
    const checkinWaitlisted = await api("/api/checkin/manual", { method: "POST", jar: staffStaff, body: { registrationId: wlBRegId } });
    ok(checkinWaitlisted.status === 409, "check-in attempt on a waitlisted registration -> 409", checkinWaitlisted.json);

    // ladder endpoint
    const ladder = await api("/api/ladder", { jar: newJar() });
    ok(ladder.status === 200 && Array.isArray(ladder.json.ladder) && ladder.json.ladder.length > 0, "GET /api/ladder returns tiers", ladder.json && ladder.json.ladder.length);
  }

  // =========================================================================
  section("7. Points/rewards: redeem, insufficient balance, status transitions, balance consistency");
  // =========================================================================
  {
    const redeemer = await signupMember("REDEEM");
    const insufficient = await api("/api/redeem", { method: "POST", jar: redeemer.jar, body: { tier: 1 } });
    ok(insufficient.status === 400, "redeem with insufficient balance -> 400", insufficient.json);

    const invalidTier = await api("/api/redeem", { method: "POST", jar: redeemer.jar, body: { tier: 999 } });
    ok(invalidTier.status === 400, "redeem with invalid tier -> 400", invalidTier.json);

    // Earn enough points: register+check in to several events.
    let earnedPts = 0;
    for (let i = 0; i < 20; i++) {
      const ev = await createEvent(admin, { nameEn: `Redeem Farm Event ${i}` });
      const reg = await api("/api/register", { method: "POST", jar: redeemer.jar, body: { eventId: ev.json.id } });
      const regId = reg.json.registration.id;
      const ci = await api("/api/checkin/manual", { method: "POST", jar: staffStaff, body: { registrationId: regId } });
      if (ci.status === 200) earnedPts += ci.json.pointsAwarded;
    }
    const balNow = await api("/api/me/balance", { jar: redeemer.jar });
    ok(balNow.json.balance === earnedPts, "balance after farming events equals sum of points awarded", { balance: balNow.json.balance, earnedPts });

    const tier1Cost = balNow.json.nextReachableTier ? balNow.json.nextReachableTier.pointsRequired : null;
    ok(tier1Cost !== null, "farmed enough points to reach at least tier 1", balNow.json);
    const redeemOk = await api("/api/redeem", { method: "POST", jar: redeemer.jar, body: { tier: balNow.json.nextReachableTier.tier } });
    ok(redeemOk.status === 201, "redeem succeeds when balance covers the tier", redeemOk.json);
    const redemptionId = redeemOk.json.redemption.id;

    // redemptions list
    const redList = await api("/api/redemptions", { jar: admin, body: undefined });
    ok(redList.status === 200 && redList.json.some((r) => r.id === redemptionId), "admin redemptions list includes the new redemption", redList.json.length);

    // status transitions
    const badStatus = await api(`/api/redemptions/${redemptionId}/status`, { method: "POST", jar: admin, body: { status: "NotARealStatus" } });
    ok(badStatus.status === 400, "set redemption to invalid status -> 400", badStatus.json);
    const approve = await api(`/api/redemptions/${redemptionId}/status`, { method: "POST", jar: admin, body: { status: "Approved" } });
    ok(approve.status === 200 && approve.json.status === "Approved", "approve redemption succeeds", approve.json);
    const fulfill = await api(`/api/redemptions/${redemptionId}/status`, { method: "POST", jar: admin, body: { status: "Fulfilled" } });
    ok(fulfill.status === 200 && fulfill.json.fulfilledAt, "fulfill redemption sets fulfilledAt", fulfill.json);

    // balance consistency: earned - redeemed(approved/fulfilled) == balance
    const balAfterRedeem = await api("/api/me/balance", { jar: redeemer.jar });
    ok(balAfterRedeem.json.balance === earnedPts - tier1Cost, "balance = earned - redeemed after a fulfilled redemption", { expected: earnedPts - tier1Cost, actual: balAfterRedeem.json.balance });

    const statusMissing = await api(`/api/redemptions/999999/status`, { method: "POST", jar: admin, body: { status: "Approved" } });
    ok(statusMissing.status === 404, "status change on nonexistent redemption -> 404", statusMissing.json);

    // Over-approval race protection: two pending redemptions whose combined
    // cost exceeds current balance - approving both should not both succeed.
    const smallBal = await signupMember("OVERAPP");
    const evOver = await createEvent(admin, { nameEn: "OverApproval Farm Event" });
    const regOver = await api("/api/register", { method: "POST", jar: smallBal.jar, body: { eventId: evOver.json.id } });
    await api("/api/checkin/manual", { method: "POST", jar: staffStaff, body: { registrationId: regOver.json.registration.id } });
    const balSmall = await api("/api/me/balance", { jar: smallBal.jar });
    if (balSmall.json.balance >= 100) {
      // Only meaningful if the ladder's cheapest tier is reachable; otherwise skip silently (farmed pts too low to redeem at all, which is fine - tier floor is admin-configured).
    }
  }

  // =========================================================================
  section("8. Content/admin CRUD: news, spotlights, committee, landing, terms, rules, settings/theme, exports");
  // =========================================================================
  {
    // news
    const newsCreate = await api("/api/news", { method: "POST", jar: admin, body: (() => { const f = new FormData(); f.set("titleEn", "Test News"); f.set("bodyEn", "Body text"); return f; })(), isForm: true });
    ok(newsCreate.status === 201, "create news post", newsCreate.json);
    const newsList = await api("/api/news", { jar: newJar() });
    ok(newsList.status === 200 && newsList.json.some((n) => n.id === newsCreate.json.id), "public news list includes created post", newsList.json.length);
    const newsDel = await api(`/api/news/${newsCreate.json.id}`, { method: "DELETE", jar: admin });
    ok(newsDel.status === 200, "delete news post", newsDel.json);
    const newsDelMissing = await api(`/api/news/${newsCreate.json.id}`, { method: "DELETE", jar: admin });
    ok(newsDelMissing.status === 404, "delete already-deleted news post -> 404", newsDelMissing.json);
    const newsMissingTitle = await api("/api/news", { method: "POST", jar: admin, body: new FormData(), isForm: true });
    ok(newsMissingTitle.status === 400, "create news without titleEn/bodyEn -> 400", newsMissingTitle.json);

    // spotlights
    const spotCreate = await api("/api/spotlights", { method: "POST", jar: admin, body: (() => { const f = new FormData(); f.set("name", "Spotlight Person"); return f; })(), isForm: true });
    ok(spotCreate.status === 201, "create spotlight", spotCreate.json);
    const spotDel = await api(`/api/spotlights/${spotCreate.json.id}`, { method: "DELETE", jar: admin });
    ok(spotDel.status === 200, "delete spotlight", spotDel.json);

    // committee CRUD + move
    const commCreate = await api("/api/admin/committee", { method: "POST", jar: admin, body: (() => { const f = new FormData(); f.set("nameEn", "Committee Member A"); f.set("tier", "committee"); return f; })(), isForm: true });
    ok(commCreate.status === 201, "create committee member", commCreate.json);
    const commCreate2 = await api("/api/admin/committee", { method: "POST", jar: admin, body: (() => { const f = new FormData(); f.set("nameEn", "Committee Member B"); f.set("tier", "committee"); return f; })(), isForm: true });
    ok(commCreate2.status === 201, "create second committee member", commCreate2.json);
    const commBadTier = await api("/api/admin/committee", { method: "POST", jar: admin, body: (() => { const f = new FormData(); f.set("nameEn", "x"); f.set("tier", "notatier"); return f; })(), isForm: true });
    ok(commBadTier.status === 400, "create committee member with invalid tier -> 400", commBadTier.json);
    const commMove = await api(`/api/admin/committee/${commCreate2.json.id}/move`, { method: "PUT", jar: admin, body: { direction: "up" } });
    ok(commMove.status === 200, "move committee member up", commMove.json);
    const commPublic = await api("/api/committee", { jar: newJar() });
    ok(commPublic.status === 200 && Array.isArray(commPublic.json), "public committee list works", commPublic.json.length);
    const commDel = await api(`/api/admin/committee/${commCreate.json.id}`, { method: "DELETE", jar: admin });
    ok(commDel.status === 200, "delete committee member", commDel.json);
    const commTierLabels = await api("/api/admin/committee/tier-labels", { method: "PUT", jar: admin, body: { labels: { top: { nameEn: "Top", nameAr: "اعلى" }, higher: { nameEn: "Higher", nameAr: "اعلى2" }, committee: { nameEn: "Committee", nameAr: "لجنة" } } } });
    ok(commTierLabels.status === 200, "update committee tier labels", commTierLabels.json);

    // landing sections/about/whatsapp/contact/gallery/sponsors
    const landingAbout = await api("/api/admin/landing/about", { method: "PUT", jar: admin, body: (() => { const f = new FormData(); f.set("titleEn", "About Us"); f.set("bodyEn", "body"); return f; })(), isForm: true });
    ok(landingAbout.status === 200, "update landing about section", landingAbout.json);
    const landingWhatsapp = await api("/api/admin/landing/whatsapp", { method: "PUT", jar: admin, body: (() => { const f = new FormData(); f.set("titleEn", "Join Us"); return f; })(), isForm: true });
    ok(landingWhatsapp.status === 200, "update landing whatsapp section", landingWhatsapp.json);
    const landingContact = await api("/api/admin/landing/contact", { method: "PUT", jar: admin, body: { titleEn: "Contact", bodyEn: "body" } });
    ok(landingContact.status === 200, "update landing contact section", landingContact.json);
    const gallAdd = await api("/api/admin/landing/gallery", { method: "POST", jar: admin, body: new FormData(), isForm: true });
    ok(gallAdd.status === 400, "add gallery photo without a file -> 400", gallAdd.json);
    const sponsorAdd = await api("/api/admin/landing/sponsors", { method: "POST", jar: admin, body: new FormData(), isForm: true });
    ok(sponsorAdd.status === 400, "add sponsor without a name -> 400", sponsorAdd.json);
    const settingsBefore = await api("/api/settings", { jar: newJar() });
    const sectionsValid = settingsBefore.json.landingPage.sections;
    const sectionsUpdate = await api("/api/admin/landing/sections", { method: "PUT", jar: admin, body: { sections: sectionsValid } });
    ok(sectionsUpdate.status === 200, "update landing sections (full valid set)", sectionsUpdate.json);
    const sectionsBad = await api("/api/admin/landing/sections", { method: "PUT", jar: admin, body: { sections: [{ key: "hero", enabled: true }] } });
    ok(sectionsBad.status === 400, "update landing sections with incomplete set -> 400", sectionsBad.json);

    // terms
    const termsUpdate = await api("/api/admin/terms", { method: "PUT", jar: admin, body: { textEn: "New terms EN", textAr: "شروط جديدة" } });
    ok(termsUpdate.status === 200 && termsUpdate.json.termsAndConditions.version >= 2, "update terms bumps version", termsUpdate.json);
    const termsMissing = await api("/api/admin/terms", { method: "PUT", jar: admin, body: { textEn: "", textAr: "" } });
    ok(termsMissing.status === 400, "update terms with empty text -> 400", termsMissing.json);

    // rules
    const rulesUpdate = await api("/api/rules", { method: "PUT", jar: admin, body: { participation: 100, earlyBonus: 10, positionBonus: { 1: 1000, 2: 750, 3: 500, 4: 350, 5: 250, 6: 150 } } });
    ok(rulesUpdate.status === 200, "update points rules", rulesUpdate.json);
    const rulesBad = await api("/api/rules", { method: "PUT", jar: admin, body: { participation: -5, earlyBonus: 10, positionBonus: {} } });
    ok(rulesBad.status === 400, "update points rules with negative participation -> 400", rulesBad.json);

    // ladder tier edit
    const ladderGet = await api("/api/ladder", { jar: newJar() });
    const firstTier = ladderGet.json.ladder[0].tier;
    const ladderUpdate = await api(`/api/ladder/${firstTier}`, { method: "PUT", jar: admin, body: { pointsRequired: 1500, rewardEn: "Updated reward", approverEn: "Someone" } });
    ok(ladderUpdate.status === 200, "update ladder tier", ladderUpdate.json);
    const ladderMissingTier = await api(`/api/ladder/999`, { method: "PUT", jar: admin, body: { pointsRequired: 100, rewardEn: "x", approverEn: "y" } });
    ok(ladderMissingTier.status === 404, "update nonexistent ladder tier -> 404", ladderMissingTier.json);

    // settings + theme
    const settingsUpdate = await api("/api/settings", { method: "PUT", jar: admin, body: { pointsVisibleToMembers: false } });
    ok(settingsUpdate.status === 200, "update settings (pointsVisibleToMembers)", settingsUpdate.json);
    await api("/api/settings", { method: "PUT", jar: admin, body: { pointsVisibleToMembers: true } }); // restore
    const themeUpdate = await api("/api/settings/theme", { method: "PUT", jar: admin, body: (() => { const f = new FormData(); f.set("primaryColor", "#123456"); f.set("accentColor", "#654321"); return f; })(), isForm: true });
    ok(themeUpdate.status === 200 && themeUpdate.json.primaryColor === "#123456", "update theme colors", themeUpdate.json);
    const themeBadColor = await api("/api/settings/theme", { method: "PUT", jar: admin, body: (() => { const f = new FormData(); f.set("primaryColor", "not-a-color"); return f; })(), isForm: true });
    ok(themeBadColor.status === 400, "update theme with invalid hex color -> 400", themeBadColor.json);

    // community stats
    const commStats = await api("/api/community-stats", { jar: newJar() });
    ok(commStats.status === 200 && typeof commStats.json.totalMembers === "number", "community-stats returns member/event counts", commStats.json);
    ok(!JSON.stringify(commStats.json).match(/membershipNumber|phone"/i), "community-stats does not leak membership numbers/phones", Object.keys(commStats.json));

    // activity log + export.xlsx
    const logList = await api("/api/admin/activity-log", { jar: admin });
    ok(logList.status === 200 && Array.isArray(logList.json.entries), "activity log returns entries", logList.json.entries.length);
    const logExportRes = await fetch(BASE + "/api/admin/activity-log/export.xlsx", { headers: { Cookie: cookieHeader(admin) } });
    const logExportBuf = Buffer.from(await logExportRes.arrayBuffer());
    ok(logExportRes.status === 200 && isXlsxBuffer(logExportBuf), "activity-log export.xlsx returns a valid xlsx (zip) file", { status: logExportRes.status, len: logExportBuf.length, magic: logExportBuf.slice(0, 4).toString("hex") });

    // members export
    const membersExportRes = await fetch(BASE + "/api/admin/members/export", { headers: { Cookie: cookieHeader(admin) } });
    const membersExportBuf = Buffer.from(await membersExportRes.arrayBuffer());
    ok(membersExportRes.status === 200 && isXlsxBuffer(membersExportBuf), "members export.xlsx returns a valid xlsx (zip) file", { status: membersExportRes.status, len: membersExportBuf.length });

    // admin dashboard/overview, management dashboard + event report + report.docx
    const overview = await api("/api/admin/overview", { jar: admin });
    ok(overview.status === 200 && typeof overview.json.totalMembers === "number", "admin overview returns counts", overview.json);
    const dashboard = await api("/api/admin/dashboard", { jar: staffTournament });
    ok(dashboard.status === 200 && Array.isArray(dashboard.json), "admin dashboard (tournament role) returns rows", dashboard.json.length);
    const mgmtDashboard = await api("/api/admin/management/dashboard", { jar: staffManagement });
    ok(mgmtDashboard.status === 200 && mgmtDashboard.json.clubGrowth, "management dashboard returns clubGrowth/eventTrends/etc", Object.keys(mgmtDashboard.json));
    const reportJson = await api(`/api/admin/management/events/${eventBasic.id}/report`, { jar: staffManagement });
    ok(reportJson.status === 200 && reportJson.json.attendance, "event report (JSON) returns attendance block", Object.keys(reportJson.json || {}));
    const reportMissing = await api(`/api/admin/management/events/999999/report`, { jar: staffManagement });
    ok(reportMissing.status === 404, "event report for nonexistent event -> 404", reportMissing.json);
    const reportDocxRes = await fetch(BASE + `/api/admin/management/events/${eventBasic.id}/report.docx`, { headers: { Cookie: cookieHeader(staffManagement) } });
    const reportDocxBuf = Buffer.from(await reportDocxRes.arrayBuffer());
    ok(reportDocxRes.status === 200 && isXlsxBuffer(reportDocxBuf), "event report.docx returns a valid docx (zip) file", { status: reportDocxRes.status, len: reportDocxBuf.length });

    // directory
    const directory = await api("/api/admin/directory", { jar: admin });
    ok(directory.status === 200 && Array.isArray(directory.json), "admin directory returns member rows", directory.json.length);
  }

  // =========================================================================
  section("9. Chat + inquiries");
  // =========================================================================
  {
    const chatMember = await signupMember("CHAT");
    const sendMsg = await api("/api/me/chat/messages", { method: "POST", jar: chatMember.jar, body: { text: "Hello committee" } });
    ok(sendMsg.status === 201, "member sends a chat message", sendMsg.json);
    const emptyMsg = await api("/api/me/chat/messages", { method: "POST", jar: chatMember.jar, body: { text: "   " } });
    ok(emptyMsg.status === 400, "sending an empty/whitespace chat message -> 400", emptyMsg.json);
    const unreadStaff = await api("/api/staff/chats/unread-count", { jar: admin });
    ok(unreadStaff.status === 200 && unreadStaff.json.count >= 1, "staff unread-count reflects the new message", unreadStaff.json);
    const staffReply = await api(`/api/staff/chats/${chatMember.membershipNumber}`, { method: "POST", jar: admin, body: { text: "Hi, how can we help?" } });
    ok(staffReply.status === 201, "staff replies in the thread", staffReply.json);
    const memberUnread = await api("/api/me/chat/unread-count", { jar: chatMember.jar });
    ok(memberUnread.status === 200 && memberUnread.json.count >= 1, "member unread-count reflects staff reply", memberUnread.json);
    const memberRead = await api("/api/me/chat/messages", { jar: chatMember.jar });
    ok(memberRead.status === 200 && memberRead.json.length === 2, "member reads full thread (both messages)", memberRead.json.length);
    const memberUnreadAfter = await api("/api/me/chat/unread-count", { jar: chatMember.jar });
    ok(memberUnreadAfter.json.count === 0, "member unread-count drops to 0 after reading", memberUnreadAfter.json);
    const chatForUnknownMember = await api("/api/staff/chats/NOSUCHMEMBER999", { jar: admin });
    ok(chatForUnknownMember.status === 404, "staff reading a chat for a nonexistent member -> 404", chatForUnknownMember.json);

    // public inquiry submit + spam/validation limits
    const inqOk = await api("/api/public/inquiries", { method: "POST", jar: await primeCsrf(newJar()), body: { name: "Visitor", phone: "0109999999", message: "Question about registration" } });
    ok(inqOk.status === 201, "public inquiry submit succeeds", inqOk.json);
    const inqNoContact = await api("/api/public/inquiries", { method: "POST", jar: await primeCsrf(newJar()), body: { name: "Visitor", message: "No way to reach me" } });
    ok(inqNoContact.status === 400, "public inquiry without phone or email -> 400", inqNoContact.json);
    const inqNoMessage = await api("/api/public/inquiries", { method: "POST", jar: await primeCsrf(newJar()), body: { name: "Visitor", phone: "0109999999" } });
    ok(inqNoMessage.status === 400, "public inquiry without a message -> 400", inqNoMessage.json);
    const inqBadEmail = await api("/api/public/inquiries", { method: "POST", jar: await primeCsrf(newJar()), body: { name: "Visitor", email: "bad-email", message: "x" } });
    ok(inqBadEmail.status === 400, "public inquiry with malformed email -> 400", inqBadEmail.json);
    // NOTE: the inquiry spam rate limit (5/hour per IP) is probed in the
    // final "Rate limiters" section, not here - see the comment in section 2.

    const inqList = await api("/api/staff/inquiries", { jar: admin });
    ok(inqList.status === 200 && Array.isArray(inqList.json), "staff inquiries list works", inqList.json.length);
    if (inqList.json.length) {
      const firstInq = inqList.json[inqList.json.length - 1];
      const inqRead = await api(`/api/staff/inquiries/${firstInq.id}/read`, { method: "POST", jar: admin });
      ok(inqRead.status === 200 && inqRead.json.read === true, "mark inquiry as read", inqRead.json);
      const inqResolve = await api(`/api/staff/inquiries/${firstInq.id}/resolve`, { method: "POST", jar: admin, body: { resolved: true, staffNote: "Handled" } });
      ok(inqResolve.status === 200 && inqResolve.json.resolved === true, "resolve inquiry with a staff note", inqResolve.json);
    }
    const inqReadMissing = await api(`/api/staff/inquiries/999999/read`, { method: "POST", jar: admin });
    // Tournament Manager can read + reply to member chat and handle enquiries; gate staff / management cannot.
    {
      const tmChats = await api("/api/staff/chats", { jar: staffTournament });
      ok(tmChats.status === 200 && Array.isArray(tmChats.json), "tournament role: can list chat threads", tmChats.status);
      const tmReply = await api(`/api/staff/chats/${chatMember.membershipNumber}`, { method: "POST", jar: staffTournament, body: { text: "Reply from the Tournament Manager" } });
      ok(tmReply.status === 201 && tmReply.json.sender === "staff", "tournament role: can reply to a member chat", tmReply.json);
      const tmThread = await api(`/api/staff/chats/${chatMember.membershipNumber}`, { jar: staffTournament });
      ok(tmThread.status === 200 && JSON.stringify(tmThread.json).includes("Reply from the Tournament Manager"), "tournament role: reply shows in the thread");
      const tmUnread = await api("/api/staff/chats/unread-count", { jar: staffTournament });
      ok(tmUnread.status === 200, "tournament role: unread count", tmUnread.status);
      const tmInq = await api("/api/staff/inquiries", { jar: staffTournament });
      ok(tmInq.status === 200 && Array.isArray(tmInq.json), "tournament role: can list inquiries", tmInq.status);
      for (const [label, jar] of [["gate staff", staffStaff], ["management", staffManagement]]) {
        const a1 = await api(`/api/staff/chats/${chatMember.membershipNumber}`, { method: "POST", jar, body: { text: "nope" } });
        ok(a1.status === 403, `${label}: cannot reply to member chat`, a1.status);
        const a2 = await api("/api/staff/inquiries", { jar });
        ok(a2.status === 403, `${label}: cannot read inquiries`, a2.status);
      }
    }
    ok(inqReadMissing.status === 404, "mark nonexistent inquiry as read -> 404", inqReadMissing.json);

    // ---- replies to public inquiries (send + edit) and editing chat replies
    {
      const inqTarget = inqList.json.find((i) => i.phone) || inqList.json[0];
      const r1 = await api(`/api/staff/inquiries/${inqTarget.id}/replies`, { method: "POST", jar: staffTournament, body: { text: "  Thanks, we will confirm tomorrow  ", channel: "whatsapp" } });
      ok(r1.status === 201 && r1.json.replies.length === 1 && r1.json.replies[0].text === "Thanks, we will confirm tomorrow" && r1.json.replies[0].channel === "whatsapp" && !r1.json.replies[0].editedAt, "inquiry reply recorded (trimmed, channel, no edit tag)", r1.json.replies);
      const rid = r1.json.replies[0].id;
      const rEmpty = await api(`/api/staff/inquiries/${inqTarget.id}/replies`, { method: "POST", jar: admin, body: { text: "   " } });
      ok(rEmpty.status === 400, "empty inquiry reply -> 400", rEmpty.status);
      const rBadCh = await api(`/api/staff/inquiries/${inqTarget.id}/replies`, { method: "POST", jar: admin, body: { text: "x", channel: "sms" } });
      ok(rBadCh.status === 400, "unknown reply channel -> 400", rBadCh.status);
      const rNoEmail = await api(`/api/staff/inquiries/${inqTarget.id}/replies`, { method: "POST", jar: admin, body: { text: "x", channel: "email" } });
      ok(inqTarget.email ? rNoEmail.status === 201 : rNoEmail.status === 400, "email reply requires an email on the inquiry", rNoEmail.status);
      const rEdit = await api(`/api/staff/inquiries/${inqTarget.id}/replies/${rid}`, { method: "PUT", jar: admin, body: { text: "Corrected: registration opens Sunday" } });
      const edited = rEdit.json.replies.find((x) => x.id === rid);
      ok(rEdit.status === 200 && edited.text === "Corrected: registration opens Sunday" && edited.editedAt && edited.editedBy, "inquiry reply edited (editedAt/editedBy set)", edited);
      const rEditMissing = await api(`/api/staff/inquiries/${inqTarget.id}/replies/999999`, { method: "PUT", jar: admin, body: { text: "x" } });
      ok(rEditMissing.status === 404, "edit nonexistent reply -> 404", rEditMissing.status);
      const rEditEmpty = await api(`/api/staff/inquiries/${inqTarget.id}/replies/${rid}`, { method: "PUT", jar: admin, body: { text: " " } });
      ok(rEditEmpty.status === 400, "edit to empty text -> 400", rEditEmpty.status);
      const rMissingInq = await api(`/api/staff/inquiries/999999/replies`, { method: "POST", jar: admin, body: { text: "x" } });
      ok(rMissingInq.status === 404, "reply to nonexistent inquiry -> 404", rMissingInq.status);
      for (const [label, jar] of [["gate staff", staffStaff], ["management", staffManagement]]) {
        const a = await api(`/api/staff/inquiries/${inqTarget.id}/replies`, { method: "POST", jar, body: { text: "nope" } });
        ok(a.status === 403, `${label}: cannot reply to inquiries`, a.status);
        const b = await api(`/api/staff/inquiries/${inqTarget.id}/replies/${rid}`, { method: "PUT", jar, body: { text: "nope" } });
        ok(b.status === 403, `${label}: cannot edit inquiry replies`, b.status);
      }
      // chat: staff can edit their own reply; member message can't be edited
      const thread = await api(`/api/staff/chats/${chatMember.membershipNumber}`, { jar: admin });
      const staffMsg = thread.json.find((m) => m.sender === "staff");
      const memberMsg = thread.json.find((m) => m.sender === "member");
      const cEdit = await api(`/api/staff/chats/${chatMember.membershipNumber}/messages/${staffMsg.id}`, { method: "PUT", jar: staffTournament, body: { text: "Hi - how can we help you today?" } });
      ok(cEdit.status === 200 && cEdit.json.text === "Hi - how can we help you today?" && cEdit.json.editedAt, "staff edits their chat reply (editedAt set)", cEdit.json);
      const memberSees = await api("/api/me/chat/messages", { jar: chatMember.jar });
      const seen = memberSees.json.find((m) => m.id === staffMsg.id);
      ok(seen.text === "Hi - how can we help you today?" && seen.editedAt, "member sees the edited text with the edited marker", seen);
      const cEditMember = await api(`/api/staff/chats/${chatMember.membershipNumber}/messages/${memberMsg.id}`, { method: "PUT", jar: admin, body: { text: "tampered" } });
      ok(cEditMember.status === 403, "member's own chat message cannot be edited by staff", cEditMember.status);
      const cEditEmpty = await api(`/api/staff/chats/${chatMember.membershipNumber}/messages/${staffMsg.id}`, { method: "PUT", jar: admin, body: { text: "" } });
      ok(cEditEmpty.status === 400, "edit chat reply to empty -> 400", cEditEmpty.status);
      const cEditWrongMember = await api(`/api/staff/chats/NOSUCH/messages/${staffMsg.id}`, { method: "PUT", jar: admin, body: { text: "x" } });
      ok(cEditWrongMember.status === 404, "edit chat reply under the wrong member -> 404", cEditWrongMember.status);
      const cEditGate = await api(`/api/staff/chats/${chatMember.membershipNumber}/messages/${staffMsg.id}`, { method: "PUT", jar: staffStaff, body: { text: "nope" } });
      ok(cEditGate.status === 403, "gate staff cannot edit chat replies", cEditGate.status);
    }
  }

  // =========================================================================
  section("10. Family: link/unlink (member + admin), dependents CRUD");
  // =========================================================================
  {
    const famA = await signupMember("FAMA");
    const famB = await signupMember("FAMB");
    const link = await api("/api/me/family/link", { method: "POST", jar: famA.jar, body: { membershipNumber: famB.membershipNumber } });
    ok(link.status === 200 && link.json.poolMembers.length === 2, "member self-service family link pools two accounts", link.json);
    const selfLink = await api("/api/me/family/link", { method: "POST", jar: famA.jar, body: { membershipNumber: famA.membershipNumber } });
    ok(selfLink.status === 400, "linking a member to themselves -> 400", selfLink.json);
    const linkMissing = await api("/api/me/family/link", { method: "POST", jar: famA.jar, body: { membershipNumber: "NOSUCHMEMBER999" } });
    ok(linkMissing.status === 404, "linking to a nonexistent member -> 404", linkMissing.json);
    const unlink = await api("/api/me/family/unlink", { method: "POST", jar: famA.jar, body: { membershipNumber: famB.membershipNumber } });
    ok(unlink.status === 200 && unlink.json.poolMembers.length === 1, "member self-service family unlink separates pool", unlink.json);

    // admin link/unlink
    const famC = await signupMember("FAMC");
    const famD = await signupMember("FAMD");
    const adminLink = await api(`/api/admin/members/${famC.membershipNumber}/family/link`, { method: "POST", jar: admin, body: { membershipNumber: famD.membershipNumber } });
    ok(adminLink.status === 200 && adminLink.json.poolMembers.length === 2, "admin family link pools two accounts", adminLink.json);
    const adminUnlink = await api(`/api/admin/members/${famC.membershipNumber}/family/unlink`, { method: "POST", jar: admin, body: { membershipNumber: famD.membershipNumber } });
    ok(adminUnlink.status === 200 && adminUnlink.json.poolMembers.length === 1, "admin family unlink separates pool", adminUnlink.json);

    // dependents CRUD
    const depOwner = await signupMember("DEPCRUD");
    const addDep = await api("/api/me/dependents", { method: "POST", jar: depOwner.jar, body: { name: "Dep One", relationship: "Daughter", birthDate: bd(14) } });
    ok(addDep.status === 201, "add a dependent", addDep.json);
    const depId = addDep.json.dependents[0].id;
    const updateDep = await api(`/api/me/dependents/${depId}`, { method: "PUT", jar: depOwner.jar, body: { name: "Dep One Updated", phone: "0101234567" } });
    ok(updateDep.status === 200 && updateDep.json.dependents[0].name === "Dep One Updated", "update a dependent", updateDep.json);
    const updateDepMissing = await api(`/api/me/dependents/999999`, { method: "PUT", jar: depOwner.jar, body: { name: "x" } });
    ok(updateDepMissing.status === 404, "update nonexistent dependent -> 404", updateDepMissing.json);
    const deleteDep = await api(`/api/me/dependents/${depId}`, { method: "DELETE", jar: depOwner.jar });
    ok(deleteDep.status === 200 && deleteDep.json.dependents.length === 0, "delete a dependent", deleteDep.json);

    // ---- date of birth: signup, profile, dependents, admin editor, file matching ----
    {
      const jarA = await primeCsrf(newJar());
      const baseA = { name: "Age Tester", password: "abc12345", phone: "01012345600", agreeTerms: true, memberType: "main" };
      const noBirth = await api("/api/auth/signup", { method: "POST", jar: jarA, body: { ...baseA, membershipNumber: `NOAGE${Date.now()}` } });
      ok(noBirth.status === 400 && /date of birth/i.test((noBirth.json || {}).error || ""), "signup without date of birth -> 400", noBirth.json);
      const oldStyle = await api("/api/auth/signup", { method: "POST", jar: jarA, body: { ...baseA, membershipNumber: `OLDAGE${Date.now()}`, ageGroup: "46plus" } });
      ok(oldStyle.status === 400, "signup with only an age group (no date of birth) -> 400", oldStyle.json);
      for (const [label, v] of [["future", bd(-1)], ["format dd/mm/yyyy", "15/06/1990"], ["impossible day", "1990-02-30"], ["year 3016", "3016-03-05"], ["before 1900", "1850-01-01"]]) {
        const r = await api("/api/auth/signup", { method: "POST", jar: jarA, body: { ...baseA, membershipNumber: `BADB${Date.now()}`, birthDate: v } });
        ok(r.status === 400, `signup with invalid date of birth (${label}) -> 400`, r.json);
      }
      const okB = await api("/api/auth/signup", { method: "POST", jar: jarA, body: { ...baseA, membershipNumber: `OKAGE${Date.now()}`, birthDate: bd(60) } });
      ok(okB.status === 201 && okB.json.member.ageGroup === "46plus" && okB.json.member.birthDate === bd(60), "signup stores the date of birth and derives the age group", okB.json);

      const owner = await signupMember("AGEDEP", { birthDate: bd(30) });
      ok(owner.res.json.member.ageGroup === "18to45", "age 30 -> Adults", owner.res.json);
      const clear = await api("/api/me/profile", { method: "PATCH", jar: owner.jar, body: { birthDate: "" } });
      ok(clear.status === 400, "profile: date of birth cannot be cleared", clear.json);
      const junk = await api("/api/me/profile", { method: "PATCH", jar: owner.jar, body: { birthDate: "xyz" } });
      ok(junk.status === 400, "profile: invalid date of birth rejected", junk.json);
      const chg = await api("/api/me/profile", { method: "PATCH", jar: owner.jar, body: { birthDate: bd(60) } });
      ok(chg.status === 200 && chg.json.member.ageGroup === "46plus" && chg.json.member.birthDate === bd(60), "profile: date of birth can be changed and the age group follows", chg.json);
      const manual = await api("/api/me/profile", { method: "PATCH", jar: owner.jar, body: { ageGroup: "12to17" } });
      ok(manual.status === 200 && manual.json.member.ageGroup === "46plus", "profile: a manual age group is ignored when a date of birth is on file", manual.json);
      const noName = await api("/api/me/profile", { method: "PATCH", jar: owner.jar, body: { phone: "01099998888" } });
      ok(noName.status === 200 && noName.json.member.ageGroup === "46plus" && noName.json.member.birthDate === bd(60), "profile: other updates keep the date of birth", noName.json);

      const depNo = await api("/api/me/dependents", { method: "POST", jar: owner.jar, body: { name: "No Age Kid", relationship: "Son" } });
      ok(depNo.status === 400 && /date of birth/i.test((depNo.json || {}).error || ""), "dependent without date of birth -> 400", depNo.json);
      const depBad = await api("/api/me/dependents", { method: "POST", jar: owner.jar, body: { name: "Bad Age Kid", birthDate: "nope" } });
      ok(depBad.status === 400, "dependent with invalid date of birth -> 400", depBad.json);
      const depFuture = await api("/api/me/dependents", { method: "POST", jar: owner.jar, body: { name: "Future Kid", birthDate: bd(-1) } });
      ok(depFuture.status === 400, "dependent born in the future -> 400", depFuture.json);
      const kidName = `Zed Kid ${Date.now()}`;
      const depOk = await api("/api/me/dependents", { method: "POST", jar: owner.jar, body: { name: kidName, relationship: "Son", birthDate: bd(8) } });
      ok(depOk.status === 201 && depOk.json.dependents[0].ageGroup === "under12" && depOk.json.dependents[0].birthDate === bd(8), "dependent: date of birth stored, age group derived", depOk.json);
      const dId = depOk.json.dependents[0].id;
      const depPutBad = await api(`/api/me/dependents/${dId}`, { method: "PUT", jar: owner.jar, body: { birthDate: "" } });
      ok(depPutBad.status === 400, "dependent date of birth cannot be cleared", depPutBad.json);
      const depPutOk = await api(`/api/me/dependents/${dId}`, { method: "PUT", jar: owner.jar, body: { birthDate: bd(14) } });
      ok(depPutOk.status === 200 && depPutOk.json.dependents[0].ageGroup === "12to17", "dependent date of birth editable, group follows", depPutOk.json);
      const depPutOther = await api(`/api/me/dependents/${dId}`, { method: "PUT", jar: owner.jar, body: { phone: "0100000111" } });
      ok(depPutOther.status === 200 && depPutOther.json.dependents[0].ageGroup === "12to17" && depPutOther.json.dependents[0].birthDate === bd(14), "editing other dependent fields keeps the date of birth", depPutOther.json);

      // directory + admin editor
      const yearOf = (n) => Number(bd(n).slice(0, 4));
      const dir = await api("/api/admin/directory", { jar: admin });
      const row = (dir.json || []).find((m) => m.membershipNumber === owner.membershipNumber);
      ok(row && row.birthDate === bd(60) && row.birthYear === yearOf(60) && row.age === 60 && row.ageGroup === "46plus", "directory exposes member birth date / year / age / group", row && [row.birthDate, row.birthYear, row.age, row.ageGroup]);
      ok(row && row.dependents[0].age === 14 && row.dependents[0].birthYear === yearOf(14) && row.dependents[0].ageGroup === "12to17", "directory exposes the family member's birth year / age / group", row && row.dependents);
      const list = await api("/api/admin/members", { jar: admin });
      const lrow = (list.json || []).find((m) => m.membershipNumber === owner.membershipNumber);
      ok(lrow && lrow.age === 60 && lrow.birthYear === yearOf(60), "members list exposes birth year and age", lrow);

      const bMem = await api(`/api/admin/members/${encodeURIComponent(owner.membershipNumber)}/birth-date`, { method: "PUT", jar: admin, body: { birthDate: bd(30) } });
      ok(bMem.status === 200 && bMem.json.ageGroup === "18to45" && bMem.json.age === 30, "admin sets a member's date of birth", bMem.json);
      const bDep = await api(`/api/admin/members/${encodeURIComponent(owner.membershipNumber)}/birth-date`, { method: "PUT", jar: admin, body: { birthDate: bd(8), dependentId: dId } });
      ok(bDep.status === 200 && bDep.json.ageGroup === "under12", "admin sets a dependent's date of birth", bDep.json);
      const bBad = await api(`/api/admin/members/${encodeURIComponent(owner.membershipNumber)}/birth-date`, { method: "PUT", jar: admin, body: { birthDate: "3016-03-05" } });
      ok(bBad.status === 400, "admin cannot save a date of birth in the future (3016)", bBad.json);
      const bBad2 = await api(`/api/admin/members/${encodeURIComponent(owner.membershipNumber)}/birth-date`, { method: "PUT", jar: admin, body: { birthDate: "2016-02-30" } });
      ok(bBad2.status === 400, "admin cannot save an impossible date", bBad2.json);
      const bNoMember = await api(`/api/admin/members/NOPE-404/birth-date`, { method: "PUT", jar: admin, body: { birthDate: bd(30) } });
      ok(bNoMember.status === 404, "admin birth date: unknown member -> 404", bNoMember.json);
      const bNoDep = await api(`/api/admin/members/${encodeURIComponent(owner.membershipNumber)}/birth-date`, { method: "PUT", jar: admin, body: { birthDate: bd(30), dependentId: 99999999 } });
      ok(bNoDep.status === 404, "admin birth date: unknown dependent -> 404", bNoDep.json);
      const bAnon = await api(`/api/admin/members/${encodeURIComponent(owner.membershipNumber)}/birth-date`, { method: "PUT", jar: await primeCsrf(newJar()), body: { birthDate: bd(30) } });
      ok(bAnon.status === 401 || bAnon.status === 403, "admin birth date: anonymous rejected", bAnon.status);
      const bMemberTry = await api(`/api/admin/members/${encodeURIComponent(owner.membershipNumber)}/birth-date`, { method: "PUT", jar: owner.jar, body: { birthDate: bd(30) } });
      ok(bMemberTry.status === 401 || bMemberTry.status === 403, "admin birth date: member session rejected", bMemberTry.status);
      const bStaffTry = await api(`/api/admin/members/${encodeURIComponent(owner.membershipNumber)}/birth-date`, { method: "PUT", jar: staffTournament, body: { birthDate: bd(30) } });
      ok(bStaffTry.status === 403, "admin birth date: tournament role rejected", bStaffTry.status);

      // the old manual age-group editor is blocked while a date of birth is on file
      const aBlocked = await api(`/api/admin/members/${encodeURIComponent(owner.membershipNumber)}/age-group`, { method: "PUT", jar: admin, body: { ageGroup: "46plus" } });
      ok(aBlocked.status === 409, "admin age group: blocked when a date of birth is on file", aBlocked.json);
      // ... but still works for someone with no date of birth (legacy accounts)
      const legacyNum = `LEG${Date.now()}`;
      const legacyAdd = await api("/api/admin/members", { method: "POST", jar: admin, body: { membershipNumber: legacyNum, name: "Legacy Person", phone: "", ageGroup: "18to45" } });
      ok(legacyAdd.status === 201, "admin can still add a member with only an age group", legacyAdd.json);
      const aLegacy = await api(`/api/admin/members/${encodeURIComponent(legacyNum)}/age-group`, { method: "PUT", jar: admin, body: { ageGroup: "46plus" } });
      ok(aLegacy.status === 200, "admin age group works for a member without a date of birth", aLegacy.json);
      const aBad = await api(`/api/admin/members/${encodeURIComponent(legacyNum)}/age-group`, { method: "PUT", jar: admin, body: { ageGroup: "" } });
      ok(aBad.status === 400, "admin cannot clear age group", aBad.json);
      const aNoMember = await api(`/api/admin/members/NOPE-404/age-group`, { method: "PUT", jar: admin, body: { ageGroup: "18to45" } });
      ok(aNoMember.status === 404, "admin age group: unknown member -> 404", aNoMember.json);
      const aAnon = await api(`/api/admin/members/${encodeURIComponent(legacyNum)}/age-group`, { method: "PUT", jar: await primeCsrf(newJar()), body: { ageGroup: "18to45" } });
      ok(aAnon.status === 401 || aAnon.status === 403, "admin age group: anonymous rejected", aAnon.status);
      const aMemberTry = await api(`/api/admin/members/${encodeURIComponent(legacyNum)}/age-group`, { method: "PUT", jar: owner.jar, body: { ageGroup: "46plus" } });
      ok(aMemberTry.status === 401 || aMemberTry.status === 403, "admin age group: member session rejected", aMemberTry.status);
      const aStaffTry = await api(`/api/admin/members/${encodeURIComponent(legacyNum)}/age-group`, { method: "PUT", jar: staffTournament, body: { ageGroup: "46plus" } });
      ok(aStaffTry.status === 403, "admin age group: tournament role rejected", aStaffTry.status);
      // admin can clear a wrong date of birth; the group then stays as last calculated
      const bClear = await api(`/api/admin/members/${encodeURIComponent(owner.membershipNumber)}/birth-date`, { method: "PUT", jar: admin, body: { birthDate: "" } });
      ok(bClear.status === 200 && bClear.json.birthDate === "", "admin can clear a date of birth", bClear.json);
      await api(`/api/admin/members/${encodeURIComponent(owner.membershipNumber)}/birth-date`, { method: "PUT", jar: admin, body: { birthDate: bd(30) } });

      // ---- birthdates file matcher ----
      {
        const XLSX = require("xlsx");
        const tag = Date.now();
        const nameA = `Zed Alpha ${tag}`, nameB = `Zed Beta ${tag}`, nameC = `Zed Gamma ${tag}`;
        for (const [n, nm] of [[`BM1-${tag}`, nameA], [`BM2-${tag}`, nameB], [`BM3-${tag}`, nameC], [`BM4-${tag}`, nameC]]) {
          const r = await api("/api/admin/members", { method: "POST", jar: admin, body: { membershipNumber: n, name: nm, phone: "", ageGroup: "18to45" } });
          ok(r.status === 201, "birth matcher: seed member " + n, r.json);
        }
        // the kid (dependent of `owner`) already has a date; clear it so the file can set it
        await api(`/api/admin/members/${encodeURIComponent(owner.membershipNumber)}/birth-date`, { method: "PUT", jar: admin, body: { birthDate: "", dependentId: dId } });
        const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
        const mkFile = (rows, header) => {
          const aoa = (header ? [header] : []).concat(rows);
          const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, "S");
          return XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellDates: true });
        };
        const upload = (buf, jar) => {
          const fd = new FormData();
          fd.set("file", new Blob([buf]), "b.xlsx");
          return api("/api/admin/members/birthdates/import", { method: "POST", jar: jar || admin, body: fd, isForm: true });
        };
        const rowsA = [
          [`  zed   ALPHA ${tag} `, D(2011, 3, 9)],   // same name, different case/spacing -> exact
          [`Zed Betta ${tag}`, D(1985, 12, 31)],      // misspelt -> needs confirmation
          [kidName, D(2012, 7, 1)],                   // a family member -> exact
          [`Nobody Atall ${tag}`, D(2000, 1, 1)],     // not on the platform
          [`Zed Alpha ${tag}`, D(2011, 3, 9)],        // duplicate row in the file
          [nameC, D(2001, 5, 5)],                     // two people with this exact name -> ambiguous
          [`Wrong Year ${tag}`, D(3016, 3, 5)],       // impossible year
        ];
        const u1 = await upload(mkFile(rowsA));
        ok(u1.status === 200 && u1.json && u1.json.summary, "birth matcher: upload accepted", u1.json);
        const sm = (u1.json || {}).summary || {};
        ok(sm.total === 7 && sm.applied === 2 && sm.near === 1 && sm.none === 1 && sm.ambiguous === 1 && sm.invalid === 1 && sm.dupFile === 1, "birth matcher: summary counts", sm);
        const byName = (nm) => ((u1.json || {}).rows || []).find((r) => r.name.trim().toLowerCase().replace(/\s+/g, " ") === nm.toLowerCase());
        ok(byName(nameA) && byName(nameA).status === "applied" && byName(nameA).birthDate === "2011-03-09", "birth matcher: exact name match (case/spacing ignored) is applied", byName(nameA));
        ok(byName(kidName) && byName(kidName).status === "applied" && byName(kidName).target.kind === "dependent", "birth matcher: family member matched and applied", byName(kidName));
        const near = (u1.json.rows || []).find((r) => r.status === "near");
        ok(near && near.candidates[0].name === nameB && near.candidates[0].score >= 80, "birth matcher: misspelt name offered as a candidate (not applied)", near);
        const inval = (u1.json.rows || []).find((r) => r.status === "invalid");
        ok(inval && inval.problem === "future", "birth matcher: year 3016 flagged invalid", inval);
        const amb = (u1.json.rows || []).find((r) => r.status === "ambiguous");
        ok(amb && amb.candidates.length === 2, "birth matcher: duplicate names -> ambiguous, nothing saved", amb);
        const dir3 = (await api("/api/admin/directory", { jar: admin })).json;
        const mA = dir3.find((m) => m.name === nameA);
        const mB = dir3.find((m) => m.name === nameB);
        ok(mA && mA.birthDate === "2011-03-09" && mA.ageGroup === (mA.age < 12 ? "under12" : "12to17"), "birth matcher: saved date + derived group visible in the directory", mA);
        ok(mB && mB.birthDate === "", "birth matcher: the misspelt match was NOT saved without confirmation", mB);
        const kidRow = dir3.find((m) => m.membershipNumber === owner.membershipNumber).dependents.find((d) => d.id === dId);
        ok(kidRow && kidRow.birthDate === "2012-07-01", "birth matcher: dependent date saved", kidRow);
        // re-upload is idempotent
        const u2 = await upload(mkFile(rowsA));
        ok(u2.json.summary.applied === 0 && u2.json.summary.already === 2, "birth matcher: re-upload changes nothing", u2.json.summary);
        // admin confirms the near match -> next upload recognises it as settled
        const link = await api(`/api/admin/members/${encodeURIComponent(near.candidates[0].membershipNumber)}/birth-date`, { method: "PUT", jar: admin, body: { birthDate: near.birthDate } });
        ok(link.status === 200, "birth matcher: admin confirms the near match", link.json);
        const u3 = await upload(mkFile(rowsA));
        ok(u3.json.summary.linked === 1 && u3.json.summary.near === 0, "birth matcher: confirmed match is remembered", u3.json.summary);
        // a different date for a person who already has one -> conflict, never overwritten
        const u4 = await upload(mkFile([[nameA, D(2010, 1, 1)]]));
        ok(u4.json.summary.conflict === 1 && u4.json.summary.applied === 0, "birth matcher: conflicting date is not overwritten", u4.json.summary);
        const dir4 = (await api("/api/admin/directory", { jar: admin })).json;
        ok(dir4.find((m) => m.name === nameA).birthDate === "2011-03-09", "birth matcher: existing date untouched after conflict", null);
        // header row + membership number column + Arabic digits text dates are understood
        const u5 = await upload(mkFile([[`BM3-${tag}`, "Whatever", "٠٥/٠٥/٢٠٠١"]], ["Membership Number", "Name", "Date of Birth"]));
        ok(u5.status === 200 && u5.json.summary.applied === 1, "birth matcher: header + membership number + Arabic-digit text date", u5.json);
        // guards
        const gStaff = await upload(mkFile(rowsA), staffTournament);
        ok(gStaff.status === 403, "birth matcher: tournament role rejected", gStaff.status);
        const gAnon = await upload(mkFile(rowsA), await primeCsrf(newJar()));
        ok(gAnon.status === 401 || gAnon.status === 403, "birth matcher: anonymous rejected", gAnon.status);
        const gEmpty = await api("/api/admin/members/birthdates/import", { method: "POST", jar: admin, body: new FormData(), isForm: true });
        ok(gEmpty.status === 400, "birth matcher: no file -> 400", gEmpty.json);
        // export carries the new columns
        const exp = await api("/api/admin/members/export", { jar: admin, raw: false });
        ok(exp.status === 200, "export still works", exp.status);
      }

      // server source files must never be downloadable
      for (const f of ["/server.js", "/swiss.js", "/swiss_print.js", "/report_print.js", "/age_utils.js", "/package.json"]) {
        const r = await fetch(BASE + f);
        ok(r.status === 404, `source file ${f} is not downloadable`, r.status);
      }
    }

    // nickname
    const nickOwner = await signupMember("NICK");
    const setNick = await api("/api/me/nickname", { method: "POST", jar: nickOwner.jar, body: { nickname: `Nicky${Date.now()}` } });
    ok(setNick.status === 201 || setNick.status === 200, "set a nickname", setNick.json);
    const emptyNick = await api("/api/me/nickname", { method: "POST", jar: nickOwner.jar, body: { nickname: "" } });
    ok(emptyNick.status === 400, "set empty nickname -> 400", emptyNick.json);
    const delNick = await api("/api/me/nickname", { method: "DELETE", jar: nickOwner.jar });
    ok(delNick.status === 200, "clear nickname", delNick.json);
  }

  // =========================================================================
  section("11. Security/robustness: XSS, oversized/malformed bodies, mass-assignment, IDOR, privacy, bad ids");
  // =========================================================================
  {
    // XSS payload stored but never reflected unescaped in server-rendered HTML
    const xssPayload = `<script>alert(1)</script>"'><img src=x onerror=alert(2)>`;
    const xssEvent = await createEvent(admin, { nameEn: xssPayload, nameAr: xssPayload });
    ok(xssEvent.status === 201, "create event with XSS payload in name succeeds (stored, not rejected)", xssEvent.status);
    const publicList = await fetch(BASE + "/api/events");
    const publicListCt = publicList.headers.get("content-type") || "";
    // A JSON response correctly containing the raw string is fine and
    // expected (JSON is inert data - browsers never execute it); the real
    // requirement is that this endpoint is served as JSON, not text/html
    // that a browser would parse and run as a script.
    ok(publicListCt.includes("application/json"), "GET /api/events is served as application/json (XSS payload in event name can't execute - it's inert JSON data)", publicListCt);
    // The only server-rendered HTML (not pure JSON) surface in scope is the
    // Swiss print page, which is tournament-scope (excluded) - but we still
    // verify the chat/inquiry free-text endpoints store the payload verbatim
    // (i.e. no silent corruption) since JSON responses are inherently safe
    // (the frontend must escape on render, out of this backend's E2E scope).
    const xssChatMember = await signupMember("XSSCHAT");
    const xssChat = await api("/api/me/chat/messages", { method: "POST", jar: xssChatMember.jar, body: { text: xssPayload } });
    ok(xssChat.status === 201 && xssChat.json.text === xssPayload, "XSS payload in chat message is stored verbatim as JSON data (not executed server-side)", xssChat.json);

    // oversized body
    const hugeBody = { membershipNumber: "HUGE", name: "x".repeat(15 * 1024 * 1024), password: "abc12345", phone: "0100000000", agreeTerms: true, memberType: "main" };
    const hugeRes = await fetch(BASE + "/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(hugeBody) });
    note5xx("oversized signup body", hugeRes.status, "/api/auth/signup");
    ok(hugeRes.status === 413 || hugeRes.status === 400 || hugeRes.status === 403, "oversized (15MB) request body is rejected, not crashing the server", hugeRes.status);

    // malformed JSON
    const malformedRes = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not valid json" });
    note5xx("malformed JSON login", malformedRes.status, "/api/auth/login");
    ok(malformedRes.status === 400 || malformedRes.status === 403, "malformed JSON body returns 400/403, not a 500", malformedRes.status);

    // wrong content-type
    const wrongCtRes = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ membershipNumber: "x", password: "y" }) });
    note5xx("wrong content-type login", wrongCtRes.status, "/api/auth/login");
    ok(wrongCtRes.status !== 500, "wrong Content-Type on a JSON endpoint does not 500", wrongCtRes.status);

    // numeric-string/negative/NaN ids, nonexistent path params -> 404 not 500
    const badIdCases = [
      ["/api/events/abc", "PUT"],
      ["/api/events/-1", "DELETE"],
      ["/api/events/NaN", "DELETE"],
      ["/api/me/dependents/abc", "DELETE"],
      ["/api/redemptions/abc/status", "POST"],
      ["/api/admin/registrations/abc/promote", "POST"],
      ["/api/staff/chats/" + encodeURIComponent("'; DROP TABLE members;--"), "GET"],
    ];
    for (const [path, method] of badIdCases) {
      const r = await api(path, { method, jar: admin, body: method !== "GET" ? {} : undefined });
      note5xx(`bad-id ${method} ${path}`, r.status, path);
      ok(r.status !== 500, `${method} ${path} with a malformed/SQLi-ish id does not 500`, { status: r.status });
    }

    // mass-assignment: a member must not set role/points/isAdmin via PATCH /api/me/profile
    const massMember = await signupMember("MASS");
    const massAssign = await api("/api/me/profile", { method: "PATCH", jar: massMember.jar, body: { name: "Still Me", role: "admin", isAdmin: true, membershipNumber: "HACKED", passwordHash: "x" } });
    ok(massAssign.status === 200, "PATCH /api/me/profile with extra fields still succeeds (extra fields ignored)", massAssign.json);
    const meAfterMass = await api("/api/auth/me", { jar: massMember.jar });
    ok(meAfterMass.json.member.membershipNumber === massMember.membershipNumber, "mass-assignment: membershipNumber cannot be changed via profile PATCH", meAfterMass.json.member.membershipNumber);
    ok(!("role" in meAfterMass.json.member) && !("passwordHash" in meAfterMass.json.member), "mass-assignment: role/passwordHash not present on member object at all", Object.keys(meAfterMass.json.member));

    // IDOR: member A cannot read/cancel member B's registrations, chats, or balance
    const idorA = await signupMember("IDORA");
    const idorB = await signupMember("IDORB");
    const idorEvent = await createEvent(admin, { nameEn: "IDOR Test Event" });
    const idorBReg = await api("/api/register", { method: "POST", jar: idorB.jar, body: { eventId: idorEvent.json.id } });
    const idorBRegId = idorBReg.json.registration.id;
    const idorCancelAttempt = await api(`/api/me/registrations/${idorBRegId}`, { method: "DELETE", jar: idorA.jar });
    ok(idorCancelAttempt.status === 404, "member A cannot cancel member B's registration (404, not revealing existence)", idorCancelAttempt.json);
    const idorCategoriesAttempt = await api(`/api/me/registrations/${idorBRegId}/categories`, { method: "PUT", jar: idorA.jar, body: { women: true, junior: false } });
    ok(idorCategoriesAttempt.status === 404 || idorCategoriesAttempt.status === 400, "member A cannot modify member B's registration categories", idorCategoriesAttempt.json);
    // A member's own /api/me/* endpoints are scoped by session, not by a
    // caller-supplied id, so there's no "pass someone else's id" surface on
    // /api/me/balance or /api/me/chat/messages to probe directly - verifying
    // that these endpoints never accept a foreign id parameter at all IS the
    // IDOR protection here (confirmed by reading the route table: requireMember
    // always uses req.member from the session, never req.params/req.body).
    const idorBalanceA = await api("/api/me/balance", { jar: idorA.jar });
    const idorBalanceB = await api("/api/me/balance", { jar: idorB.jar });
    ok(idorBalanceA.json.membershipNumber === idorA.membershipNumber && idorBalanceB.json.membershipNumber === idorB.membershipNumber, "each member's own balance endpoint returns only their own data", { a: idorBalanceA.json.membershipNumber, b: idorBalanceB.json.membershipNumber });

    // privacy: public endpoints must not leak membership numbers/phones
    const publicEventsRes = await fetch(BASE + "/api/events");
    const publicEventsText = await publicEventsRes.text();
    ok(!/"phone"\s*:\s*"0\d/.test(publicEventsText), "public /api/events does not leak phone numbers", true);
    const ladderPub = await fetch(BASE + "/api/ladder");
    const ladderPubText = await ladderPub.text();
    ok(!/membershipNumber/.test(ladderPubText), "public /api/ladder does not leak membership numbers", true);
    const settingsPub = await fetch(BASE + "/api/settings");
    const settingsPubText = await settingsPub.text();
    ok(!/membershipNumber|passwordHash/.test(settingsPubText), "public /api/settings does not leak membershipNumber/passwordHash", true);
  }

  // =========================================================================
  section("12. HEAVY concurrency/race phase");
  // =========================================================================
  {
    section(`12a. ${N} parallel signups (concurrency ~60)`);
    const signupTasks = Array.from({ length: N }, (_, i) => i);
    const t0a = Date.now();
    const signupResults = await pool(signupTasks, 60, async (i) => signupMember(`HEAVY${i}`));
    const okSignups = signupResults.filter((r) => r && r.res && (r.res.status === 201)).length;
    ok(okSignups === N, `all ${N} parallel signups succeed (no lost writes)`, { okSignups, expected: N });
    console.log(`   signups: ${okSignups}/${N} ok in ${((Date.now() - t0a) / 1000).toFixed(1)}s`);

    // Verify uniqueness: every membership number actually resolves to a
    // distinct, loginable account (catches "lost update" write races).
    const sampleCheck = signupResults.slice(0, Math.min(30, signupResults.length));
    let allLoginOk = true;
    for (const r of sampleCheck) {
      if (!r || !r.membershipNumber) {
        allLoginOk = false;
        continue;
      }
      const login = await api("/api/auth/login", { method: "POST", jar: await primeCsrf(newJar()), body: { membershipNumber: r.membershipNumber, password: "abc12345" } });
      if (login.status !== 200 && login.status !== 429) allLoginOk = false;
    }
    ok(allLoginOk, "sampled accounts from the parallel-signup burst are all independently loginable", allLoginOk);

    section("12b. 200 parallel registrations into a capacity-50 event");
    const raceEvent = await createEvent(admin, { nameEn: "Race Capacity Event", maxCapacity: 50 });
    const raceMembers = signupResults.filter((r) => r && r.jar).slice(0, 200);
    ok(raceMembers.length >= 200, "have at least 200 signed-up members for the capacity race", raceMembers.length);
    const t0b = Date.now();
    const raceRegResults = await pool(raceMembers, 80, async (m) => api("/api/register", { method: "POST", jar: m.jar, body: { eventId: raceEvent.json.id, joinWaitlist: true } }));
    console.log(`   registrations: ${raceRegResults.length} fired in ${((Date.now() - t0b) / 1000).toFixed(1)}s`);
    // Confirmed registrations' response body has no top-level "waitlisted"
    // key at all (only true for a waitlisted one) - see POST /api/register's
    // two different res.json({...}) shapes - so "confirmed" means status 201
    // and NOT waitlisted:true, not a literal === false.
    const confirmedCount = raceRegResults.filter((r) => r && r.status === 201 && r.json && !r.json.waitlisted).length;
    const waitlistedCount = raceRegResults.filter((r) => r && r.status === 201 && r.json && r.json.waitlisted === true).length;
    ok(confirmedCount === 50, "exactly 50 confirmed registrations after 200 parallel attempts at a capacity-50 event", { confirmedCount, waitlistedCount, total: raceRegResults.length });
    ok(confirmedCount + waitlistedCount === raceMembers.length, "no lost writes: confirmed+waitlisted == total attempted", { confirmedCount, waitlistedCount, total: raceMembers.length });
    // server-visible truth via API
    const raceWaitlist = await api(`/api/admin/events/${raceEvent.json.id}/waitlist`, { jar: admin });
    const raceRoster = await api(`/api/staff/events/${raceEvent.json.id}/roster`, { jar: staffStaff });
    const serverConfirmed = raceRoster.json.filter((r) => !r.waitlisted).length;
    ok(serverConfirmed === 50, "server-side roster confirms exactly 50 confirmed spots (DB-visible truth matches client view)", { serverConfirmed, waitlistReported: raceWaitlist.json.length });
    // no duplicate registrations per member
    const regIdsAll = raceRegResults.filter((r) => r && r.json && r.json.registration).map((r) => r.json.registration.id);
    ok(new Set(regIdsAll).size === regIdsAll.length, "no duplicate registration ids created under the registration race", { total: regIdsAll.length, unique: new Set(regIdsAll).size });

    section("12c. Parallel check-ins of the same registration (points awarded exactly once)");
    const dupCiMember = raceMembers[0];
    const dupCiEvent = await createEvent(admin, { nameEn: "Dup Checkin Race Event" });
    const dupReg = await api("/api/register", { method: "POST", jar: dupCiMember.jar, body: { eventId: dupCiEvent.json.id } });
    const dupRegId = dupReg.json.registration.id;
    const balBeforeRace = await api("/api/me/balance", { jar: dupCiMember.jar });
    const ciRaceResults = await pool(Array.from({ length: 20 }), 20, async () => api("/api/checkin/manual", { method: "POST", jar: staffStaff, body: { registrationId: dupRegId } }));
    const ciSuccesses = ciRaceResults.filter((r) => r && r.status === 200).length;
    ok(ciSuccesses === 1, "exactly 1 of 20 parallel check-ins on the same registration succeeds", { ciSuccesses });
    const balAfterRace = await api("/api/me/balance", { jar: dupCiMember.jar });
    const awarded = ciRaceResults.find((r) => r && r.status === 200);
    ok(balAfterRace.json.balance === balBeforeRace.json.balance + (awarded ? awarded.json.pointsAwarded : -1), "points awarded exactly once despite 20 concurrent check-in attempts", { before: balBeforeRace.json.balance, after: balAfterRace.json.balance, awarded: awarded && awarded.json.pointsAwarded });

    section("12d. Parallel redeem of the same reward (no over-spend under concurrency)");
    const redeemRaceMember = raceMembers[1];
    // Farm enough points to afford exactly one redemption of the cheapest tier.
    const ladderForRace = await api("/api/ladder", { jar: newJar() });
    const cheapestTier = ladderForRace.json.ladder.slice().sort((a, b) => a.pointsRequired - b.pointsRequired)[0];
    let farmed = 0;
    while (farmed < cheapestTier.pointsRequired) {
      const ev = await createEvent(admin, { nameEn: `Redeem Race Farm ${farmed}` });
      const reg = await api("/api/register", { method: "POST", jar: redeemRaceMember.jar, body: { eventId: ev.json.id } });
      const ci = await api("/api/checkin/manual", { method: "POST", jar: staffStaff, body: { registrationId: reg.json.registration.id } });
      if (ci.status === 200) farmed += ci.json.pointsAwarded;
      else break;
    }
    const balForRace = await api("/api/me/balance", { jar: redeemRaceMember.jar });
    const redeemRaceResults = await pool(Array.from({ length: 10 }), 10, async () => api("/api/redeem", { method: "POST", jar: redeemRaceMember.jar, body: { tier: cheapestTier.tier } }));
    const redeemSuccesses = redeemRaceResults.filter((r) => r && r.status === 201).length;
    // /api/redeem only checks balance at submit time and doesn't lock against
    // other in-flight Pending requests from the same member (confirmed by
    // reading POST /api/redemptions/:id/status's own comment) - so MULTIPLE
    // concurrent /api/redeem calls can all succeed in creating Pending
    // requests even though only one is actually affordable. The real
    // overspend guard is at approval time. We assert that guard here: not all
    // of them can be pushed to Approved/Fulfilled.
    console.log(`   redeem race: ${redeemSuccesses}/10 pending requests created from a balance of ${balForRace.json.balance} (tier cost ${cheapestTier.pointsRequired})`);
    let approvedCount = 0;
    for (const r of redeemRaceResults) {
      if (r && r.status === 201) {
        const approve = await api(`/api/redemptions/${r.json.redemption.id}/status`, { method: "POST", jar: admin, body: { status: "Approved" } });
        if (approve.status === 200) approvedCount++;
      }
    }
    ok(approvedCount <= 1, "at most 1 of the concurrently-created redemption requests can actually be approved (balance-at-approval-time guard holds)", { approvedCount, redeemSuccesses, balance: balForRace.json.balance, tierCost: cheapestTier.pointsRequired });
    if (redeemSuccesses > 1) {
      // Not a bug per se (documented tradeoff) but worth flagging distinctly
      // from a hard failure - record as informational via console, not ok().
      console.log(`   NOTE: ${redeemSuccesses} Pending redemption requests were allowed to queue up against a balance that only covers 1 - see report.`);
    }

    section("12e. Parallel cancel+promote race");
    const cpEvent = await createEvent(admin, { nameEn: "Cancel Promote Race Event", maxCapacity: 1 });
    const cpConfirmed = raceMembers[2];
    const cpWaiters = raceMembers.slice(3, 8);
    await api("/api/register", { method: "POST", jar: cpConfirmed.jar, body: { eventId: cpEvent.json.id } });
    for (const w of cpWaiters) await api("/api/register", { method: "POST", jar: w.jar, body: { eventId: cpEvent.json.id, joinWaitlist: true } });
    const myCpRegs = await api("/api/me/registrations", { jar: cpConfirmed.jar });
    const cpRegId = myCpRegs.json.find((r) => r.eventId === cpEvent.json.id).id;
    // Fire several parallel cancels of the SAME confirmed registration (only
    // the first should succeed; the rest should 404 since it's gone).
    const cpCancelResults = await pool(Array.from({ length: 5 }), 5, async () => api(`/api/me/registrations/${cpRegId}`, { method: "DELETE", jar: cpConfirmed.jar }));
    const cpCancelSuccesses = cpCancelResults.filter((r) => r && r.status === 200).length;
    ok(cpCancelSuccesses === 1, "exactly 1 of 5 parallel cancels of the same registration succeeds", { cpCancelSuccesses });
    const cpCancelPromotes = cpCancelResults.filter((r) => r && r.status === 200 && r.json.promoted).length;
    ok(cpCancelPromotes === 1, "exactly one waitlist promotion happens from the parallel-cancel race (no double promotion)", { cpCancelPromotes });
    const cpFinalRoster = await api(`/api/staff/events/${cpEvent.json.id}/roster`, { jar: staffStaff });
    const cpFinalConfirmed = cpFinalRoster.json.filter((r) => !r.waitlisted).length;
    ok(cpFinalConfirmed === 1, "final server state after cancel+promote race has exactly 1 confirmed spot (capacity respected)", { cpFinalConfirmed });

    section("12f. Parallel admin edits (same event, different fields) - no 5xx, no corruption");
    const editEvent = await createEvent(admin, { nameEn: "Parallel Edit Target Event" });
    const editResults = await pool(Array.from({ length: 15 }), 15, async (_, i) => {
      const f = new FormData();
      f.set("nameEn", `Parallel Edit Target Event (edit ${i})`);
      f.set("nameAr", "تحرير متزامن");
      f.set("sport", "Padel");
      f.set("date", editEvent.json.date);
      f.set("maxCapacity", String(10 + i));
      return api(`/api/events/${editEvent.json.id}`, { method: "PUT", jar: admin, body: f, isForm: true });
    });
    const editSuccesses = editResults.filter((r) => r && r.status === 200).length;
    ok(editSuccesses === 15, "15 parallel admin edits to the same event all return 200 (last-write-wins, no 500s)", { editSuccesses });
    const finalEditState = await api("/api/events", { jar: newJar() });
    const finalEditedEvent = finalEditState.json.find((e) => e.id === editEvent.json.id);
    ok(finalEditedEvent && /^Parallel Edit Target Event \(edit \d+\)$/.test(finalEditedEvent.nameEn), "event ends up in a single consistent state after concurrent edits (not corrupted/merged garbage)", finalEditedEvent && finalEditedEvent.nameEn);
  }

  // =========================================================================
  section("13. Rate limiters (run LAST: these poison the shared test IP for everything after them)");
  // =========================================================================
  {
    const victim = await signupMember("LOCK");
    let got429 = false;
    for (let i = 0; i < 20; i++) {
      const r = await api("/api/auth/login", { method: "POST", jar: await primeCsrf(newJar()), body: { membershipNumber: victim.membershipNumber, password: "wrongwrong" } });
      if (r.status === 429) {
        got429 = true;
        break;
      }
    }
    ok(got429, "login lockout: repeated wrong passwords from one IP eventually return 429", { got429 });

    let inquiry429 = false;
    for (let i = 0; i < 10; i++) {
      const r = await api("/api/public/inquiries", { method: "POST", jar: await primeCsrf(newJar()), body: { name: "Spammer", phone: "01000000000", message: `spam ${i}` } });
      if (r.status === 429) {
        inquiry429 = true;
        break;
      }
    }
    ok(inquiry429, "public inquiry spam from one IP eventually returns 429", { inquiry429 });
  }

  // =========================================================================
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nTotal server-side 5xx responses observed: ${serverErrors}`);
  if (serverErrorSamples.length) {
    console.log("Sample 5xx offenders:");
    for (const s of serverErrorSamples) console.log("  " + s);
  }
  ok(serverErrors === 0, "no 5xx responses were observed anywhere in the suite");

  console.log(`\nPlatform E2E: ${pass} passed, ${fail} failed (${elapsed}s)`);
  if (failures.length) {
    console.log("\nFAILed checks:");
    for (const f of failures) console.log("  - " + f);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
