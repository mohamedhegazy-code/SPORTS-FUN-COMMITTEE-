// Birthday video E2E: public greeting (day before .. end of birthday), name privacy,
// signed personal links, WhatsApp link in the sent endpoint, guards.
// Usage: BASE_URL=http://localhost:3917 node birthday_video_e2e.js
"use strict";
const BASE = process.env.BASE_URL || "http://localhost:3917";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
let passed = 0, failed = 0;
const serverErrors = [];
const ok = (c, l, x) => { if (c) passed++; else { failed++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 400)); } };
const section = (s) => console.log("\n=== " + s + " ===");
const newJar = () => ({});
function applySetCookies(jar, res) {
  const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const raw of sc) { const [pair] = raw.split(";"); const eq = pair.indexOf("="); if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); }
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
async function api(path, { method = "GET", body, jar } = {}) {
  jar = jar || newJar();
  const headers = {};
  if (Object.keys(jar).length) headers.Cookie = cookieHeader(jar);
  if (!["GET", "HEAD"].includes(method) && jar.csrfToken) headers["X-CSRF-Token"] = jar.csrfToken;
  let fb; if (body !== undefined) { headers["Content-Type"] = "application/json"; fb = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: fb, redirect: "manual" });
  applySetCookies(jar, res);
  if (res.status >= 500) serverErrors.push(`${method} ${path} -> ${res.status}`);
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, jar };
}
const prime = async (jar) => { await api("/", { jar }); return jar; };
const admin = newJar();
const A = (p, m = "GET", b) => api(p, { method: m, jar: admin, body: b });
const cairoToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const shift = (iso, days) => new Date(Date.parse(iso + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
const withYear = (iso, y) => `${y}-${iso.slice(5)}`;

(async () => {
  const lg = await api("/api/auth/staff-login", { method: "POST", jar: await prime(admin), body: { username: ADMIN_USER, password: ADMIN_PASS } });
  ok(lg.status === 200, "admin login", lg.json);
  const today = cairoToday();
  const Y = Number(today.slice(0, 4));
  const add = async (num, name, birthDate, phone) => { const r = await A("/api/admin/members", "POST", { membershipNumber: num, name, birthDate, phone }); ok([200, 201].includes(r.status), `add ${num}`, r.json); };
  const active = async () => (await api("/api/public/birthdays/active", { jar: await prime(newJar()) }));

  section("Nobody yet");
  let r = await active();
  ok(r.status === 200 && Array.isArray(r.json.items) && r.json.items.length === 0, "no birthdays -> empty list", r.json);

  section("Fixtures");
  await add("BV1", "Mona Ahmed Said Hassan", withYear(today, Y - 30), "01011110001");   // today, adult, 4 parts
  await add("BV2", "Karim Adel", withYear(shift(today, 1), Y - 25), "01011110002");      // tomorrow
  await add("BV3", "Dina Later", withYear(shift(today, 2), Y - 25), "01011110003");      // in two days: not shown
  await add("BV4", "Yara Yesterday", withYear(shift(today, -1), Y - 25), "01011110004"); // yesterday: not shown
  await add("BV5", "Gone Member", withYear(today, Y - 40), "01011110005");
  await add("BV7", "Single", withYear(today, Y - 33), "01011110007");                    // one-word name
  const jar = await prime(newJar());
  await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: "BV6", name: "Parent Person", password: "abc12345", phone: "01011110006", agreeTerms: true, memberType: "main", birthDate: "1980-01-01" } });
  const dep = await api("/api/me/dependents", { method: "POST", jar, body: { name: "Little Kid Family Name", relationship: "Son", birthDate: withYear(today, Y - 9) } });
  ok([200, 201].includes(dep.status), "add child", dep.json);
  const depId = ((dep.json.dependents || []).slice(-1)[0] || dep.json.dependent || {}).id;
  const arch = await A("/api/admin/members/bulk", "POST", { action: "archive", membershipNumbers: ["BV5"] });
  ok(arch.status === 200, "archive BV5", arch.json);

  section("Public greeting list");
  r = await active();
  const names = (r.json.items || []).map((x) => `${x.when}:${x.name}`);
  ok(names.includes("0:Mona Hassan"), "adult -> first + last name only", names);
  ok(names.includes("1:Karim Adel"), "tomorrow's birthday is shown", names);
  ok(names.includes("0:Single"), "single-word name kept", names);
  ok(names.includes("0:Little"), "child under 18 -> first name only", names);
  ok(!names.some((n) => /Dina|Yara|Gone/.test(n)), "two days away / yesterday / archived are hidden", names);
  ok(r.json.items.every((x) => Object.keys(x).sort().join() === "name,when"), "only name + when are exposed", r.json.items[0]);
  ok(!JSON.stringify(r.json).match(/0101111|BV\d|19\d\d-|20\d\d-/), "no phone, number or date leaks");
  const firstTomorrow = r.json.items.findIndex((x) => x.when === 1);
  ok(firstTomorrow === -1 || r.json.items.slice(0, firstTomorrow).every((x) => x.when === 0), "today's birthdays come first");

  section("Personal link");
  const anon = await prime(newJar());
  ok((await api("/api/admin/birthdays/link", { method: "POST", jar: anon, body: { membershipNumber: "BV1" } })).status === 401, "link: anonymous 401");
  ok((await A("/api/admin/birthdays/link", "POST", { membershipNumber: "NOPE" })).status === 404, "link: unknown member 404");
  ok((await A("/api/admin/birthdays/link", "POST", { membershipNumber: "BV6", dependentId: 999999 })).status === 404, "link: unknown child 404");
  r = await A("/api/admin/birthdays/link", "POST", { membershipNumber: "BV1" });
  ok(r.status === 200 && /\/birthday\/[\w-]+\.[0-9a-f]{20}$/.test(r.json.url), "link looks right", r.json);
  const token = r.json.url.split("/birthday/")[1];
  let pub = await api(`/api/public/birthday/${token}`, { jar: anon });
  ok(pub.status === 200 && pub.json.name === "Mona Hassan" && Object.keys(pub.json).join() === "name", "token -> display name only", pub.json);
  const page = await fetch(`${BASE}/birthday/${token}`);
  const html = await page.text();
  ok(page.status === 200 && html.includes("Happy Birthday Mona Hassan") && !html.includes("__OG_"), "page rendered with the name in the preview tags");
  ok(/<script src="\/birthday.js">/.test(html) && !/<script>/.test(html), "page uses an external script (CSP safe)");
  const [pl, sig] = token.split(".");
  ok((await api(`/api/public/birthday/${pl}.${"0".repeat(20)}`, { jar: anon })).status === 404, "wrong signature 404");
  ok((await api(`/api/public/birthday/${Buffer.from("BV2~0").toString("base64url")}.${sig}`, { jar: anon })).status === 404, "signature does not transfer to another member");
  ok((await api(`/api/public/birthday/garbage`, { jar: anon })).status === 404, "garbage 404");
  const bad = await fetch(`${BASE}/birthday/garbage`);
  const badHtml = await bad.text();
  ok(bad.status === 404 && !badHtml.includes("__OG_") && !/<script>/.test(badHtml), "invalid link page is a clean 404");
  r = await A("/api/admin/birthdays/link", "POST", { membershipNumber: "BV6", dependentId: depId });
  pub = await api(`/api/public/birthday/${r.json.url.split("/birthday/")[1]}`, { jar: anon });
  ok(pub.status === 200 && pub.json.name === "Little", "child's link shows first name only", pub.json);
  const arch2 = await A("/api/admin/members/bulk", "POST", { action: "archive", membershipNumbers: ["BV2"] });
  r = await A("/api/admin/birthdays/link", "POST", { membershipNumber: "BV2" });
  const t2 = r.json.url.split("/birthday/")[1];
  ok((await api(`/api/public/birthday/${t2}`, { jar: anon })).status === 404, "archived member's link stops working");

  section("Sent endpoint carries the link");
  r = await A("/api/admin/birthdays/sent", "POST", { membershipNumber: "BV1" });
  ok(r.status === 200 && r.json.url === `${BASE}/birthday/${token}` || (r.status === 200 && r.json.url.endsWith(`/birthday/${token}`)), "sent returns the same link", r.json);
  ok(r.json.phone === "01011110001", "sent still returns the phone");

  section("Video files are served");
  for (const f of ["/videos/happy-birthday.mp4", "/videos/happy-birthday-poster.jpg", "/birthday.js"]) {
    const x = await fetch(BASE + f, { method: "HEAD" });
    ok(x.status === 200, `${f} served`, x.status);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (serverErrors.length) console.log("SERVER 5xx:", serverErrors);
  process.exit(failed || serverErrors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
