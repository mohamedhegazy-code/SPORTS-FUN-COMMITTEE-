// Admin birthday-cards E2E: list scopes (today / week / month / all), family
// members, Feb-29 handling, phone fallback, sent tracking, guards.
// Usage: BASE_URL=http://localhost:3917 node birthday_e2e.js
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

  section("Fixtures");
  await add("BDX1", "BDX Today Person", withYear(today, Y - 30), "01011110001");
  await add("BDX2", "BDX In Three Days", withYear(shift(today, 3), Y - 20), "01011110002");
  await add("BDX3", "BDX Next Month Person", withYear(shift(today, 40), Y - 45), "");
  await add("BDX4", "BDX Yesterday Person", withYear(shift(today, -1), Y - 12), "01011110004");
  await add("BDX5", "BDX No Birthdate", "", "01011110005");
  // a family member with a birthday tomorrow (inherits the parent's phone)
  const jar = await prime(newJar());
  const su = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: "BDX6", name: "BDX Parent", password: "abc12345", phone: "01011110006", agreeTerms: true, memberType: "main", birthDate: "1980-01-01" } });
  ok([200, 201].includes(su.status), "signup parent", su.json);
  const dep = await api("/api/me/dependents", { method: "POST", jar, body: { name: "BDX Kid", relationship: "Son", birthDate: withYear(shift(today, 1), Y - 9) } });
  ok([200, 201].includes(dep.status), "add dependent", dep.json);
  const depId = ((dep.json.dependents || []).slice(-1)[0] || dep.json.dependent || {}).id;

  section("Guards");
  const anon = await prime(newJar());
  ok((await api("/api/admin/birthdays", { jar: anon })).status === 401, "anonymous 401");
  ok((await api("/api/admin/birthdays/sent", { method: "POST", jar: anon, body: {} })).status === 401, "anonymous POST 401");
  const mk = await A("/api/staff/accounts", "POST", { username: "bdx_tour", password: "Role!Pass2026xyz", role: "tournament", name: "t" });
  const tour = await prime(newJar());
  await api("/api/auth/staff-login", { method: "POST", jar: tour, body: { username: "bdx_tour", password: "Role!Pass2026xyz" } });
  ok((await api("/api/admin/birthdays", { jar: tour })).status === 403, "tournament manager 403");
  ok((await api("/api/admin/birthdays", { jar })).status === 401 || (await api("/api/admin/birthdays", { jar })).status === 403, "member cannot list");

  section("List scopes");
  const q = async (qs) => (await A("/api/admin/birthdays?" + qs)).json;
  const names = (d) => d.items.filter((x) => x.name.startsWith("BDX")).map((x) => x.name);
  let d = await q("scope=today");
  ok(JSON.stringify(names(d)) === JSON.stringify(["BDX Today Person"]), "today", names(d));
  ok(d.items[0].turning === 30 && d.items[0].daysUntil === 0 && d.items[0].phone === "01011110001", "turning age + phone", d.items[0]);
  d = await q("scope=week");
  ok(JSON.stringify(names(d)) === JSON.stringify(["BDX Today Person", "BDX Kid", "BDX In Three Days"]), "week sorted by days (today, tomorrow kid, +3)", names(d));
  const kid = d.items.find((x) => x.name === "BDX Kid");
  ok(kid.kind === "dependent" && kid.parentName === "BDX Parent" && kid.phone === "01011110006" && kid.turning === 9 && kid.dependentId === depId, "dependent inherits parent's phone", kid);
  ok(d.counts.today >= 1 && d.counts.week >= 3 && d.counts.total >= 5, "counts", d.counts);
  d = await q("scope=week&family=0");
  ok(!names(d).includes("BDX Kid"), "family=0 hides dependents", names(d));
  d = await q("scope=all");
  ok(names(d).length === 6 && !names(d).includes("BDX No Birthdate"), "all: 6 with a date, none without", names(d));
  const yest = d.items.find((x) => x.name === "BDX Yesterday Person");
  ok(yest.daysUntil >= 364 && yest.daysUntil <= 365 && yest.turning === 13, "yesterday's birthday is ~a year away, turning 13", yest);
  ok(names(d)[names(d).length - 1] === "BDX Yesterday Person", "all sorted by next birthday");
  const m3 = Number(shift(today, 40).slice(5, 7));
  d = await q(`scope=month&month=${m3}`);
  ok(names(d).includes("BDX Next Month Person"), "month scope", names(d));
  d = await q("scope=month&month=99");
  ok(d.month === Number(today.slice(5, 7)), "bad month falls back to this month", d.month);
  d = await q("scope=bogus");
  ok(d.scope === "week", "bad scope -> week");
  const nm = (await q("scope=all")).items.find((x) => x.name === "BDX Next Month Person");
  ok(nm.phone === "", "member without phone has empty phone");

  section("Feb 29");
  await add("BDX7", "BDX Leap Baby", "2000-02-29", "01011110007");
  const leap = (await q("scope=all")).items.find((x) => x.name === "BDX Leap Baby");
  ok(leap && leap.month === 2 && leap.day === 29 && leap.turning > 20, "leap-day birthday listed", leap);
  const nextY = Number(leap.nextDate.slice(0, 4));
  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  ok(leap.nextDate.slice(5) === (isLeap(nextY) ? "02-29" : "02-28"), "falls on 28 Feb in non-leap years", leap.nextDate);

  section("Sent tracking");
  let s = await A("/api/admin/birthdays/sent", "POST", { membershipNumber: "BDX1" });
  ok(s.status === 200 && s.json.phone === "01011110001" && s.json.sentAt, "mark sent", s.json);
  d = await q("scope=today");
  ok(d.items.find((x) => x.name === "BDX Today Person").sentAt, "list shows sentAt");
  s = await A("/api/admin/birthdays/sent", "POST", { membershipNumber: "BDX6", dependentId: depId });
  ok(s.status === 200 && s.json.phone === "01011110006", "mark dependent sent (parent's phone)", s.json);
  ok((await q("scope=week")).items.find((x) => x.name === "BDX Kid").sentAt, "dependent sentAt");
  ok((await q("scope=week")).items.find((x) => x.name === "BDX In Three Days").sentAt === "", "others unaffected");
  ok((await A("/api/admin/birthdays/sent", "POST", { membershipNumber: "NOPE" })).status === 404, "unknown member 404");
  ok((await A("/api/admin/birthdays/sent", "POST", { membershipNumber: "BDX6", dependentId: 99999 })).status === 404, "unknown dependent 404");
  ok((await A("/api/admin/birthdays/sent", "POST", { membershipNumber: "BDX5" })).status === 400, "no birthdate 400");
  ok(/birthday_card_sent/.test(JSON.stringify((await A("/api/admin/activity-log")).json)), "logged in activity log");
  // archived members are not listed
  const arch = await A("/api/admin/members/BDX2/archive", "POST");
  if ([200, 201].includes(arch.status)) ok(!names(await q("scope=week")).includes("BDX In Three Days"), "archived member hidden");

  ok(serverErrors.length === 0, "no 5xx", serverErrors);
  console.log(`\nBirthday E2E: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
