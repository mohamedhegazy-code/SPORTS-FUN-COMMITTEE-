// "Ask for date of birth" E2E: admin-only endpoint that works out who is missing a
// date of birth (member + family members), stamps "asked on" and returns the phone.
// Usage: BASE_URL=http://localhost:3917 node birthdate_request_e2e.js
"use strict";
const BASE = process.env.BASE_URL || "http://localhost:3917";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
let passed = 0, failed = 0;
const serverErrors = [];
const ok = (c, l, x) => { if (c) passed++; else { failed++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 400)); } };
const section = (s) => console.log("\n=== " + s + " ===");
const applySetCookies = (jar, res) => { const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []; for (const raw of sc) { const [pair] = raw.split(";"); const eq = pair.indexOf("="); if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); } };
async function api(path, { method = "GET", body, jar } = {}) {
  jar = jar || {};
  const headers = {};
  if (Object.keys(jar).length) headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (!["GET", "HEAD"].includes(method) && jar.csrfToken) headers["X-CSRF-Token"] = jar.csrfToken;
  let fb; if (body !== undefined) { headers["Content-Type"] = "application/json"; fb = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: fb, redirect: "manual" });
  applySetCookies(jar, res);
  if (res.status >= 500) serverErrors.push(`${method} ${path} -> ${res.status}`);
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, jar };
}
const prime = async (jar) => { await api("/", { jar }); return jar; };
(async () => {
  const admin = await prime({});
  ok((await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } })).status === 200, "admin login");
  const A = (p, m = "GET", b) => api(p, { method: m, jar: admin, body: b });
  const stamp = Date.now().toString(36);
  const add = async (num, name, birthDate, phone) => { const r = await A("/api/admin/members", "POST", { membershipNumber: num, name, birthDate, phone }); ok([200, 201].includes(r.status), `add ${num}`, r.json); };

  section("Fixtures");
  await add("BRQ1" + stamp, "BRQ No Birth", "", "01022220001");
  await add("BRQ2" + stamp, "BRQ Has Birth", "1990-05-05", "01022220002");
  await add("BRQ3" + stamp, "BRQ No Phone", "", "");
  // (Family members can no longer be added without a date of birth, so the
  // "only a legacy dependent is missing" case is covered by a seeded-db check.)
  const jar = await prime({});
  const numP = "BRQ4" + stamp;
  const su = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: numP, name: "BRQ Parent", password: "abc12345", phone: "01022220004", agreeTerms: true, memberType: "main", birthDate: "1985-01-01" } });
  ok(su.status === 201, "signup parent", su.json);

  section("Guards");
  const anon = await prime({});
  ok((await api(`/api/admin/members/BRQ1${stamp}/birthdate-request`, { method: "POST", jar: anon, body: {} })).status === 401, "anonymous 401");
  ok([401, 403].includes((await api(`/api/admin/members/BRQ1${stamp}/birthdate-request`, { method: "POST", jar, body: {} })).status), "member cannot call it");
  ok((await A("/api/admin/members/NOPE999/birthdate-request", "POST", {})).status === 404, "unknown member 404");
  ok((await A(`/api/admin/members/BRQ3${stamp}/birthdate-request`, "POST", {})).status === 400, "no phone 400");
  const full = await A(`/api/admin/members/BRQ2${stamp}/birthdate-request`, "POST", {});
  ok(full.status === 409 && full.json.nothingMissing === true, "nobody missing -> 409", full.json);

  section("Success: member without a date of birth");
  let r = await A(`/api/admin/members/BRQ1${stamp}/birthdate-request`, "POST", {});
  ok(r.status === 200 && r.json.phone === "01022220001", "returns the phone", r.json);
  ok(JSON.stringify(r.json.missing) === JSON.stringify([{ name: "BRQ No Birth", self: true }]), "lists the member", r.json.missing);
  ok(typeof r.json.loginUrl === "string" && r.json.loginUrl.startsWith("http"), "login url present", r.json.loginUrl);

  section("Directory + activity log");
  const dir = (await A("/api/admin/directory")).json;
  const row = dir.find((x) => x.membershipNumber === "BRQ1" + stamp);
  ok(row && row.birthRequestAt, "directory shows birthRequestAt", row && row.birthRequestAt);
  ok(!dir.find((x) => x.membershipNumber === "BRQ2" + stamp).birthRequestAt, "untouched member has none");
  const act = await A("/api/admin/activity-log?limit=50");
  const text = JSON.stringify(act.json || "");
  ok(act.status !== 200 || text.includes("birthdate_requested"), "activity logged", act.status);

  section("Archived member");
  const arch = await A("/api/admin/members/bulk", "POST", { action: "archive", membershipNumbers: ["BRQ1" + stamp] });
  if (arch.status === 200) ok((await A(`/api/admin/members/BRQ1${stamp}/birthdate-request`, "POST", {})).status === 409, "archived member refused (409)");

  ok(serverErrors.length === 0, "no 5xx", serverErrors);
  console.log(`\nBirthdate request E2E: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
