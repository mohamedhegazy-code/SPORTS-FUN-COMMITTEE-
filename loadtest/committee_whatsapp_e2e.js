// Committee WhatsApp number E2E: admin-only setting, validation, public exposure,
// "omitted keeps the saved value", clearing it.
// Usage: BASE_URL=http://localhost:3917 node committee_whatsapp_e2e.js
"use strict";
const BASE = process.env.BASE_URL || "http://localhost:3917";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
let passed = 0, failed = 0;
const serverErrors = [];
const ok = (c, l, x) => { if (c) passed++; else { failed++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 400)); } };
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
const putWa = (jar, fields) => { const f = new FormData(); f.set("titleEn", "Join our WhatsApp Community"); for (const [k, v] of Object.entries(fields)) f.set(k, v); return api("/api/admin/landing/whatsapp", { method: "PUT", jar, form: f }); };
(async () => {
  const admin = await prime({});
  ok((await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } })).status === 200, "admin login");
  const settings = async () => (await api("/api/settings", { jar: await prime({}) })).json;

  section("Default");
  let s = await settings();
  ok(s.landingPage && s.landingPage.whatsapp && s.landingPage.whatsapp.committeePhone === "", "committeePhone defaults to empty", s.landingPage && s.landingPage.whatsapp);

  section("Guards");
  const anon = await prime({});
  ok((await putWa(anon, { committeePhone: "01012345678" })).status === 401, "anonymous cannot set it");
  const mem = await prime({});
  const su = await api("/api/auth/signup", { method: "POST", jar: mem, body: { membershipNumber: "CWA1" + Date.now().toString(36), name: "CWA Member", password: "abc12345", phone: "01077770001", agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
  ok(su.status === 201, "member signup", su.json);
  ok([401, 403].includes((await putWa(mem, { committeePhone: "01012345678" })).status), "member cannot set it");

  section("Validation");
  for (const bad of ["abc", "123", "0101234567890123456789", "+20 10 1234 5678 99999999", "0101<script>"]) {
    const r = await putWa(admin, { committeePhone: bad });
    ok(r.status === 400, `rejects ${JSON.stringify(bad)}`, r.json);
  }
  s = await settings();
  ok(s.landingPage.whatsapp.committeePhone === "", "rejected values were not saved");

  section("Saving");
  let r = await putWa(admin, { committeePhone: " 0101 234-5678 " });
  ok(r.status === 200 && r.json.whatsapp.committeePhone === "01012345678", "spaces/dashes stripped", r.json);
  s = await settings();
  ok(s.landingPage.whatsapp.committeePhone === "01012345678", "visible in public settings (needed by the member button)");
  r = await putWa(admin, { committeePhone: "(+20) 10-1234 5678" });
  ok(r.status === 200 && r.json.whatsapp.committeePhone === "+201012345678", "international format with + kept", r.json);

  section("Omitted keeps the saved value; empty clears it");
  r = await putWa(admin, { bodyEn: "Hello" });
  ok(r.status === 200 && r.json.whatsapp.committeePhone === "+201012345678", "omitted field keeps the number", r.json);
  r = await putWa(admin, { committeePhone: "" });
  ok(r.status === 200 && r.json.whatsapp.committeePhone === "", "empty value clears it", r.json);

  ok(serverErrors.length === 0, "no 5xx", serverErrors);
  console.log(`\nCommittee WhatsApp E2E: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
