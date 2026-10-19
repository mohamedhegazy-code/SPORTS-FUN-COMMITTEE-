// Admin > Reports tab E2E: the event list endpoint, the three printable event
// sheets (registrations / attendance / points) in both languages, role guards,
// HTML escaping, empty/past/waitlist events, and the Swiss tournament sheets
// the tab links to.
// Usage: BASE_URL=http://localhost:3914 node reports_e2e.js
"use strict";
const BASE = process.env.BASE_URL || "http://localhost:3914";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";

let passed = 0, failed = 0;
const serverErrors = [];
const ok = (cond, label, extra) => {
  if (cond) passed++;
  else { failed++; console.log("FAIL:", label, extra === undefined ? "" : JSON.stringify(extra).slice(0, 300)); }
};
const section = (s) => console.log("\n=== " + s + " ===");

const newJar = () => ({});
function applySetCookies(jar, res) {
  const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const raw of sc) { const [pair] = raw.split(";"); const eq = pair.indexOf("="); if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); }
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
async function api(path, { method = "GET", body, jar, isForm = false, raw = false } = {}) {
  jar = jar || newJar();
  const headers = {};
  if (Object.keys(jar).length) headers.Cookie = cookieHeader(jar);
  if (!["GET", "HEAD"].includes(method) && jar.csrfToken) headers["X-CSRF-Token"] = jar.csrfToken;
  let fb;
  if (body !== undefined) { if (isForm) fb = body; else { headers["Content-Type"] = "application/json"; fb = JSON.stringify(body); } }
  const res = await fetch(BASE + path, { method, headers, body: fb, redirect: "manual" });
  applySetCookies(jar, res);
  if (res.status >= 500) serverErrors.push(`${method} ${path} -> ${res.status}`);
  if (raw) { const text = await res.text(); return { status: res.status, text, type: res.headers.get("content-type") || "", jar }; }
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, jar };
}
const prime = async (jar) => { await api("/", { jar }); return jar; };
const admin = newJar();
const A = (p, m = "GET", b) => api(p, { method: m, jar: admin, body: b });

async function mkEvent(nameEn, nameAr, { date = "2026-12-15", max } = {}) {
  const f = new FormData();
  f.set("nameEn", nameEn); f.set("nameAr", nameAr); f.set("sport", "Chess"); f.set("date", date);
  if (max) f.set("maxCapacity", String(max));
  const r = await api("/api/events", { method: "POST", jar: admin, body: f, isForm: true });
  if (r.status !== 200 && r.status !== 201) throw new Error("event create failed " + JSON.stringify(r.json));
  return r.json.id;
}
const members = [];
async function member(i, name) {
  const jar = await prime(newJar());
  const r = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: `RP${i}`, name, password: "abc12345", phone: `0106${String(i).padStart(7, "0")}`, agreeTerms: true, memberType: "main" } });
  if (r.status !== 200 && r.status !== 201) throw new Error("signup failed " + JSON.stringify(r.json));
  const m = { jar, num: `RP${i}`, name, regs: {} };
  members.push(m);
  return m;
}
async function register(m, eventId) {
  const r = await api("/api/register", { method: "POST", jar: m.jar, body: { eventId, joinWaitlist: true } });
  const reg = r.json && (r.json.registration || r.json);
  if (!(r.status === 200 || r.status === 201) || !reg) { ok(false, `register ${m.num}`, r.json); return null; }
  m.regs[eventId] = reg.id;
  return { id: reg.id, waitlisted: !!(reg.waitlisted || (r.json && r.json.waitlisted)) };
}
const checkin = (m, eventId) => A("/api/checkin/manual", "POST", { registrationId: m.regs[eventId] });
const getHtml = (path, jar) => api(path, { jar: jar || admin, raw: true });

(async () => {
  const lg = await api("/api/auth/staff-login", { method: "POST", jar: await prime(admin), body: { username: ADMIN_USER, password: ADMIN_PASS } });
  ok(lg.status === 200, "admin login", lg.json);

  // ---------------------------------------------------------------- fixtures
  section("Fixtures");
  const XSS = `<script>alert(1)</script> & "Q'`;
  const evChess = await mkEvent("Reports Chess Cup", "كأس التقارير للشطرنج");
  const evPast = await mkEvent("Reports Past Event", "فعالية سابقة للتقارير", { date: "2025-01-10" });
  const evEmpty = await mkEvent("Reports Empty Event", "فعالية فارغة", { date: "2026-11-01" });
  const evSmall = await mkEvent("Reports Small Capacity", "سعة صغيرة", { date: "2026-11-20", max: 2 });
  const names = ["Amr Hassan", XSS, "محمد الأهلاوي", "Zeinab Ali", "Omar Said", "Laila Fathy", "Youssef Adel", "Nour Samir"];
  for (let i = 0; i < names.length; i++) await member(i + 1, names[i]);
  for (const m of members) await register(m, evChess);
  for (let i = 0; i < 6; i++) await checkin(members[i], evChess);
  for (let i = 0; i < 3; i++) await register(members[i], evPast);
  await checkin(members[0], evPast);
  const smallRegs = [];
  for (let i = 0; i < 4; i++) smallRegs.push(await register(members[i], evSmall));
  ok(smallRegs.filter((r) => r && r.waitlisted).length === 2, "capacity 2 -> two waitlisted", smallRegs);
  const cr = await A(`/api/admin/tournaments/${evChess}`, "POST", { mode: "individual", format: "swiss", swissRounds: 3 });
  ok(cr.status === 200 || cr.status === 201, "create swiss tournament", cr.json);

  // -------------------------------------------------------------- list endpoint
  section("GET /api/admin/reports/events");
  let r = await A("/api/admin/reports/events");
  ok(r.status === 200 && Array.isArray(r.json), "admin gets the list", r.status);
  const list = r.json || [];
  const byId = Object.fromEntries(list.map((e) => [e.eventId, e]));
  for (const id of [evChess, evPast, evEmpty, evSmall]) ok(!!byId[id], `event ${id} listed (past + future)`);
  ok(list.map((e) => e.date).join() === list.map((e) => e.date).slice().sort().reverse().join(), "sorted newest first");
  ok(byId[evChess].confirmedCount === 8 && byId[evChess].checkedInCount === 6 && byId[evChess].waitlistCount === 0, "chess counts", byId[evChess]);
  ok(byId[evPast].confirmedCount === 3 && byId[evPast].checkedInCount === 1, "past event counts", byId[evPast]);
  ok(byId[evSmall].confirmedCount === 2 && byId[evSmall].waitlistCount === 2, "waitlist counted separately", byId[evSmall]);
  ok(byId[evEmpty].confirmedCount === 0 && byId[evEmpty].tournament === null && byId[evEmpty].swiss === null, "empty event", byId[evEmpty]);
  ok(byId[evChess].tournament && byId[evChess].tournament.format === "swiss" && byId[evChess].swiss && byId[evChess].swiss.totalRounds === 3 && byId[evChess].swiss.generatedRounds === 0, "swiss not drawn yet", byId[evChess]);
  const gen = await A(`/api/admin/tournaments/${evChess}/generate`, "POST");
  ok(gen.status === 200, "generate round 1", gen.json);
  r = await A("/api/admin/reports/events");
  const chess2 = (r.json || []).find((e) => e.eventId === evChess);
  ok(chess2 && chess2.swiss.generatedRounds === 1 && chess2.tournament.generated === true, "list reflects drawn round", chess2);

  // ------------------------------------------------------------------ roles
  section("Role matrix");
  const roles = {};
  for (const role of ["staff", "management", "tournament"]) {
    const username = `rp_${role}`;
    const cr2 = await A("/api/staff/accounts", "POST", { username, password: "Role!Pass2026xyz", role, name: role });
    ok(cr2.status === 200 || cr2.status === 201, `create ${role}`, cr2.json);
    const jar = await prime(newJar());
    const l = await api("/api/auth/staff-login", { method: "POST", jar, body: { username, password: "Role!Pass2026xyz" } });
    ok(l.status === 200, `${role} login`, l.json);
    roles[role] = jar;
  }
  const anon = await prime(newJar());
  const memberJar = members[0].jar;
  const paths = ["/api/admin/reports/events", `/admin/print/event/${evChess}?view=registrations`, `/admin/print/event/${evChess}?view=attendance`, `/admin/print/event/${evChess}?view=points`];
  for (const p of paths) {
    const isApi = p.startsWith("/api");
    const rA = await api(p, { jar: anon, raw: !isApi });
    ok(rA.status === 401, `anon blocked ${p}`, rA.status);
    const rM = await api(p, { jar: memberJar, raw: !isApi });
    ok(rM.status === 401 || rM.status === 403, `member blocked ${p}`, rM.status);
    for (const role of ["staff", "management"]) {
      const rr = await api(p, { jar: roles[role], raw: !isApi });
      ok(rr.status === 403, `${role} blocked ${p}`, rr.status);
    }
    const rT = await api(p, { jar: roles.tournament, raw: !isApi });
    ok(rT.status === 200, `tournament role allowed ${p}`, rT.status);
    const rAd = await api(p, { jar: admin, raw: !isApi });
    ok(rAd.status === 200, `admin allowed ${p}`, rAd.status);
  }

  // ------------------------------------------------------------ print sheets
  section("Printable sheets");
  const norm = (h) => h.replace(/\s+/g, " ");
  for (const lang of ["en", "ar"]) {
    for (const view of ["registrations", "attendance", "points"]) {
      const res = await getHtml(`/admin/print/event/${evChess}?view=${view}&lang=${lang}`);
      const h = res.text;
      const tag = `${view}/${lang}`;
      ok(res.status === 200 && /text\/html/.test(res.type), `${tag}: 200 html`, [res.status, res.type]);
      ok(h.includes(`dir="${lang === "ar" ? "rtl" : "ltr"}"`) && h.includes(`lang="${lang}"`), `${tag}: direction + lang`);
      ok(lang === "ar" ? h.includes("كأس التقارير للشطرنج") : h.includes("Reports Chess Cup"), `${tag}: event title in the right language`);
      ok(h.includes('id="print-btn"') && h.includes('/print.js'), `${tag}: print button wired`);
      ok(!h.includes("<script>alert(1)</script>"), `${tag}: no raw script injection`);
      ok(h.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Q&#39;"), `${tag}: hostile name escaped`);
      ok(!/<script(?![^>]*src=)/.test(h), `${tag}: no inline scripts (CSP-safe)`);
      ok(h.includes("Amr Hassan") && h.includes("محمد الأهلاوي"), `${tag}: lists players`);
    }
  }
  // registrations: waitlist + status
  let res = await getHtml(`/admin/print/event/${evSmall}?view=registrations&lang=en`);
  ok((res.text.match(/class="tag wait"/g) || []).length === 2, "registrations: 2 waitlist tags", res.text.match(/class="tag wait"/g));
  ok(/<tr class="wait">/.test(res.text), "registrations: waitlist rows styled");
  ok(/Waiting list<\/div><div class="v">2</.test(norm(res.text)) || /Waiting list<\/div> ?<div class="v">2</.test(norm(res.text)), "registrations: waiting-list stat = 2");
  // attendance: confirmed only, check marks, signature column
  res = await getHtml(`/admin/print/event/${evChess}?view=attendance&lang=en`);
  ok((res.text.match(/class="sig"/g) || []).length === 8, "attendance: one signature box per confirmed player", (res.text.match(/class="sig"/g) || []).length);
  ok((res.text.match(/✓/g) || []).length === 6, "attendance: 6 check marks", (res.text.match(/✓/g) || []).length);
  res = await getHtml(`/admin/print/event/${evSmall}?view=attendance&lang=en`);
  ok((res.text.match(/class="sig"/g) || []).length === 2, "attendance: waitlisted players excluded", (res.text.match(/class="sig"/g) || []).length);
  // points: checked-in only, total = sum of rows
  res = await getHtml(`/admin/print/event/${evChess}?view=points&lang=en`);
  const cells = [...res.text.matchAll(/<td class="num"><b>(\d+)<\/b><\/td>/g)].map((m) => Number(m[1]));
  const total = Number((res.text.match(/class="total"><td colspan="5">[^<]*<\/td><td class="num">(\d+)<\/td>/) || [])[1]);
  ok(cells.length === 6, "points: 6 rows (checked-in only)", cells);
  ok(cells.every((n) => n >= 100), "points: each at least the participation award", cells);
  ok(total === cells.reduce((a, b) => a + b, 0) && total > 0, "points: total equals the sum of the rows", [total, cells]);
  res = await getHtml(`/admin/print/event/${evEmpty}?view=points&lang=en`);
  ok(/Nobody has been checked in/.test(res.text), "points: empty message");
  for (const v of ["registrations", "attendance"]) {
    res = await getHtml(`/admin/print/event/${evEmpty}?view=${v}&lang=ar`);
    ok(res.status === 200 && /لا يوجد مسجّلون بعد/.test(res.text), `${v}: empty event message (ar)`);
  }
  // past event still printable
  res = await getHtml(`/admin/print/event/${evPast}?view=registrations&lang=en`);
  ok(res.status === 200 && res.text.includes("Reports Past Event") && res.text.includes("Amr Hassan"), "past event printable");
  // fallbacks and bad input
  res = await getHtml(`/admin/print/event/${evChess}?view=nonsense&lang=xx`);
  ok(res.status === 200 && res.text.includes("Registrations list") === false && res.text.includes("قائمة المسجّلين"), "unknown view + lang fall back to registrations (ar)");
  res = await getHtml(`/admin/print/event/999999?view=registrations`);
  ok(res.status === 404, "unknown event -> 404", res.status);
  res = await getHtml(`/admin/print/event/abc?view=registrations`);
  ok(res.status === 404, "non-numeric event id -> 404", res.status);
  res = await getHtml(`/admin/print/event/${evChess}?view=attendance&lang=en&x=<script>`);
  ok(res.status === 200 && !res.text.includes("<script>"), "query noise ignored");

  // Swiss tournament sheets (the other half of the tab)
  section("Swiss tournament sheets linked from the tab");
  for (const q of ["view=regulation", "view=pairings&round=1", "view=standings"]) {
    for (const lang of ["en", "ar"]) {
      res = await getHtml(`/admin/print/tournament/${evChess}?${q}&lang=${lang}`);
      ok(res.status === 200 && /text\/html/.test(res.type) && res.text.includes('id="print-btn"'), `swiss ${q}/${lang}`, res.status);
    }
  }
  res = await getHtml(`/admin/print/tournament/${evEmpty}?view=regulation&lang=en`);
  ok(res.status === 404, "event without a Swiss tournament -> 404", res.status);

  // static assets the sheets rely on
  for (const asset of ["/print.js", "/ahly-crest.png"]) {
    const a = await api(asset, { jar: anon, raw: true });
    ok(a.status === 200, `asset ${asset}`, a.status);
  }

  ok(serverErrors.length === 0, "no 5xx", serverErrors);
  console.log(`\nReports E2E: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
