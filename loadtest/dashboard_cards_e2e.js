// Clickable dashboard cards + report name E2E.
// - GET /api/admin/stat-details?kind=...: one list behind every tile; the row count must equal the number on the tile
// - POST /api/admin/export-table: Excel of the table a card window shows
// - report builder: the typed report name becomes the title on screen / Excel / print
// Usage: BASE_URL=http://localhost:3942 node dashboard_cards_e2e.js   (server started with the e2e admin below)
"use strict";
const fs = require("fs");
const path = require("path");
const XLSX = require(path.join(__dirname, "..", "node_modules", "xlsx"));
const BASE = process.env.BASE_URL || "http://localhost:3942";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "db.json");
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
async function api(p, { method = "GET", body, jar, isForm = false, raw = false, buf = false } = {}) {
  jar = jar || newJar();
  const headers = {};
  if (Object.keys(jar).length) headers.Cookie = cookieHeader(jar);
  if (!["GET", "HEAD"].includes(method) && jar.csrfToken) headers["X-CSRF-Token"] = jar.csrfToken;
  let fb;
  if (body !== undefined) { if (isForm) fb = body; else { headers["Content-Type"] = "application/json"; fb = JSON.stringify(body); } }
  const res = await fetch(BASE + p, { method, headers, body: fb, redirect: "manual" });
  applySetCookies(jar, res);
  if (res.status >= 500) serverErrors.push(`${method} ${p} -> ${res.status}`);
  const h = { disposition: res.headers.get("content-disposition") || "" };
  if (buf) return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), ...h, jar };
  if (raw) return { status: res.status, text: await res.text(), ...h, jar };
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, jar };
}
const prime = async (jar) => { await api("/", { jar }); return jar; };
const admin = newJar();
const A = (p, m = "GET", b) => api(p, { method: m, jar: admin, body: b });
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (n) => iso(new Date(Date.now() + n * 86400000));
const bd = (years) => iso(new Date(Date.now() - (years * 365.25 + 40) * 86400000));
async function mkEvent(nameEn, nameAr, date) {
  const f = new FormData();
  f.set("nameEn", nameEn); f.set("nameAr", nameAr); f.set("sport", "Chess"); f.set("date", date);
  const r = await api("/api/events", { method: "POST", jar: admin, body: f, isForm: true });
  if (![200, 201].includes(r.status)) throw new Error("event create failed " + JSON.stringify(r.json));
  return r.json.id;
}
async function signup(num, name, birthDate) {
  const jar = await prime(newJar());
  const r = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: num, name, password: "abc12345", phone: "0106" + num.replace(/\D/g, "").padStart(7, "0"), agreeTerms: true, memberType: "main", birthDate } });
  if (![200, 201].includes(r.status)) throw new Error("signup failed " + JSON.stringify(r.json));
  return { jar, num, name };
}
const sheetRows = (buffer, idx = 0) => { const wb = XLSX.read(buffer, { type: "buffer" }); const name = wb.SheetNames[idx]; return { names: wb.SheetNames, rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" }) }; };

(async () => {
  const lg = await api("/api/auth/staff-login", { method: "POST", jar: await prime(admin), body: { username: ADMIN_USER, password: ADMIN_PASS } });
  ok(lg.status === 200, "admin login", lg.json);

  section("Fixtures");
  const evA = await mkEvent("DC Event A", "فعالية دي سي أ", addDays(20));
  const evB = await mkEvent("DC Event B", "فعالية دي سي ب", addDays(5));
  const m1 = await signup("DC1", "DC Alice", bd(30));
  const m2 = await signup("DC2", "DC <img src=x onerror=alert(1)> Bob", bd(40));
  const m3 = await signup("DC3", "DC Carol", bd(25));
  await A("/api/admin/members", "POST", { membershipNumber: "DC4", name: "DC Roster Only" });
  const reg = async (m, ev) => { const r = await api("/api/register", { method: "POST", jar: m.jar, body: { eventId: ev, joinWaitlist: true } }); ok([200, 201].includes(r.status), `register ${m.num}`, r.json); return r.json.registration || r.json; };
  const r1 = await reg(m1, evA); await reg(m2, evA); await reg(m1, evB); await reg(m3, evB);
  const ci = await A("/api/checkin/manual", "POST", { registrationId: r1.id }); ok(ci.status === 200, "check-in", ci.json);
  // a tournament (completed would need a full bracket; an in-progress casual one is enough for the lists)
  const tr = await A(`/api/admin/tournaments/${evA}`, "POST", { mode: "individual", format: "casual" });
  ok([200, 201].includes(tr.status), "casual tournament", tr.json);
  // redemptions are inserted straight into the data file (earning 1500 points through the UI would need hundreds of events)
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  const nid = () => (db.nextIds.redemption = (db.nextIds.redemption || 1) + 1) - 1;
  db.redemptions = db.redemptions || [];
  db.redemptions.push({ id: nid(), membershipNumber: "DC1", tier: 1, pointsCost: 1500, approvalLevel: "x", requestedAt: new Date().toISOString(), status: "Pending", approvedBy: null, fulfilledAt: null, balanceAtRequestTime: 1600 });
  db.redemptions.push({ id: nid(), membershipNumber: "DC2", tier: 2, pointsCost: 3000, approvalLevel: "x", requestedAt: new Date().toISOString(), status: "Fulfilled", approvedBy: "a", fulfilledAt: new Date().toISOString(), balanceAtRequestTime: 3100 });
  fs.writeFileSync(DB_PATH, JSON.stringify(db));
  const tourn = await prime(newJar());
  const mkT = await A("/api/staff/accounts", "POST", { username: "dc_tour", password: "Role!Pass2026xyz", role: "tournament", name: "t" });
  ok([200, 201].includes(mkT.status), "tournament account", mkT.json);
  await api("/api/auth/staff-login", { method: "POST", jar: tourn, body: { username: "dc_tour", password: "Role!Pass2026xyz" } });
  const mgmt = await prime(newJar());
  const mkM = await A("/api/staff/accounts", "POST", { username: "dc_mgmt", password: "Role!Pass2026xyz", role: "management", name: "m" });
  ok([200, 201].includes(mkM.status), "management account", mkM.json);
  await api("/api/auth/staff-login", { method: "POST", jar: mgmt, body: { username: "dc_mgmt", password: "Role!Pass2026xyz" } });
  const gate = await prime(newJar());
  await A("/api/staff/accounts", "POST", { username: "dc_gate", password: "Role!Pass2026xyz", role: "staff", name: "g" });
  await api("/api/auth/staff-login", { method: "POST", jar: gate, body: { username: "dc_gate", password: "Role!Pass2026xyz" } });

  section("Guards");
  const anon = await prime(newJar());
  const KINDS = ["members", "withAccount", "active", "neverRegistered", "events", "registrations", "checkedIn", "redemptions_pending", "redemptions_all", "redemptions_fulfilled", "points", "tournaments", "tournaments_done"];
  for (const [who, label, want] of [[anon, "anonymous", 401], [tourn, "tournament role", 403], [gate, "gate staff", 403], [mgmt, "management", 200], [admin, "admin", 200]]) {
    const r = await api("/api/admin/stat-details?kind=members&lang=en", { jar: who });
    ok(r.status === want, `${label} stat-details -> ${want}`, r.status);
  }
  const bad = await A("/api/admin/stat-details?kind=__proto__&lang=en");
  ok(bad.status === 400, "unknown kind -> 400", bad.status);
  const bad2 = await A("/api/admin/stat-details?lang=en");
  ok(bad2.status === 400, "missing kind -> 400", bad2.status);
  for (const [who, label, want] of [[anon, "anonymous", 401], [gate, "gate staff", 403], [tourn, "tournament role", 200], [mgmt, "management", 200], [admin, "admin", 200]]) {
    const r = await api("/api/admin/export-table", { method: "POST", jar: who, body: { title: "t", head: ["a"], rows: [["x"]] }, buf: true });
    ok(r.status === want, `${label} export-table -> ${want}`, r.status);
  }

  section("Every card's list matches the number on the card");
  const ov = (await A("/api/admin/overview")).json;
  const md = (await api("/api/admin/management/dashboard", { jar: mgmt })).json;
  const get = async (kind, lang = "en", jar = admin) => (await api(`/api/admin/stat-details?kind=${kind}&lang=${lang}`, { jar })).json;
  const D = {};
  for (const k of KINDS) {
    D[k] = await get(k);
    ok(D[k] && Array.isArray(D[k].head) && Array.isArray(D[k].rows) && typeof D[k].title === "string" && D[k].title.length > 2, `${k}: shape`, D[k] && Object.keys(D[k]));
    ok(D[k].rows.every((r) => r.length === D[k].head.length), `${k}: every row has one cell per column`);
    const ar = await get(k, "ar");
    ok(ar.title !== D[k].title && ar.head[0] !== D[k].head[0], `${k}: Arabic title and headings differ from English`, [ar.title, D[k].title]);
    ok(ar.rows.length === D[k].rows.length, `${k}: same rows in both languages`);
  }
  ok(D.members.rows.length === ov.totalMembers && ov.totalMembers >= 4, "members = Overview total", [D.members.rows.length, ov.totalMembers]);
  ok(D.events.rows.length === ov.totalEvents, "events = Overview total");
  ok(D.registrations.rows.length === ov.totalRegistrations, "registrations = Overview total", [D.registrations.rows.length, ov.totalRegistrations]);
  ok(D.checkedIn.rows.length === ov.totalCheckedIn && ov.totalCheckedIn >= 1, "checked in = Overview total", [D.checkedIn.rows.length, ov.totalCheckedIn]);
  ok(D.redemptions_pending.rows.length === ov.pendingRedemptions && ov.pendingRedemptions === 1, "pending redemptions = Overview total");
  const g = md.clubGrowth, p = md.pointsActivity, ta = md.tournamentActivity;
  ok(D.members.rows.length === g.totalMembers, "management: all members");
  ok(D.withAccount.rows.length === g.membersWithAccount, "management: with login", [D.withAccount.rows.length, g.membersWithAccount]);
  ok(D.active.rows.length === g.activeCount, "management: active", [D.active.rows.length, g.activeCount]);
  ok(D.neverRegistered.rows.length === g.neverRegisteredCount && g.neverRegisteredCount >= 1, "management: never registered");
  ok(D.active.rows.length + D.neverRegistered.rows.length === D.members.rows.length, "active + never registered = all members");
  ok(D.redemptions_all.rows.length === p.redemptions.total && p.redemptions.total === 2, "management: all redemptions");
  ok(D.redemptions_fulfilled.rows.length === p.redemptions.fulfilled && p.redemptions.fulfilled === 1, "management: fulfilled redemptions");
  ok(D.tournaments.rows.length === ta.totalTournaments && ta.totalTournaments === 1, "management: tournaments");
  ok(D.tournaments_done.rows.length === ta.completedCount, "management: completed tournaments");
  ok(D.tournaments.rows[0][3] === "Fun session" && D.tournaments.rows[0][2] === "Individuals", "tournament row wording", D.tournaments.rows[0]);
  const ptsTotal = D.points.rows.reduce((s, r) => s + Number(r[2]), 0);
  ok(ptsTotal === p.totalPointsAwarded, "points list adds up to the total awarded", [ptsTotal, p.totalPointsAwarded]);
  ok(D.points.rows.every((r, i, a) => !i || a[i - 1][2] >= r[2]), "points list is sorted high to low");
  const mgmtMembers = await get("members", "en", mgmt);
  ok(mgmtMembers.rows.length === D.members.rows.length, "management role gets the same member list");
  ok(D.members.rows.some((r) => String(r[1]).includes("<img")), "hostile name travels as data (escaped in the browser)");
  ok(D.checkedIn.rows[0][3] === "Checked in" && /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(D.checkedIn.rows[0][5]), "checked-in row shows status and time", D.checkedIn.rows[0]);
  ok(D.events.rows.every((r) => ["Upcoming", "Ended"].includes(r[2])), "event rows say Upcoming/Ended");
  ok(D.events.goto === "events" && D.members.goto === "members" && D.registrations.goto === "reports" && D.redemptions_pending.goto === "points", "each list names the tab it belongs to");

  section("Export of a card window to Excel");
  const ex = await api("/api/admin/export-table", { method: "POST", jar: admin, body: { title: "Members: all / ✓ [test]*", head: ["#", "Name", "Note"], rows: [[1, "Alice", "=1+1"], [2, "Bob", "+cmd|calc"], [3, "Carl", "@x"], [4, "Dee", "-5"], [5, "Eve", "ok"], "notarow"] }, buf: true });
  ok(ex.status === 200 && ex.buffer.slice(0, 2).toString() === "PK", "export is a real .xlsx", ex.status);
  ok(/filename\*=UTF-8''Members/.test(ex.disposition), "file named after the title", ex.disposition);
  const x = sheetRows(ex.buffer);
  ok(x.names[0] === "Members all ✓ test" || x.names[0].startsWith("Members"), "sheet name sanitised", x.names);
  ok(x.rows[0][0] === "Members: all / ✓ [test]*" && x.rows[1].every((c) => c === "") && x.rows[2].join("|") === "#|Name|Note", "title row, blank row, headings", x.rows.slice(0, 3));
  ok(x.rows[3][2] === "'=1+1" && x.rows[4][2] === "'+cmd|calc" && x.rows[5][2] === "'@x", "formula-looking text neutralised", x.rows.slice(3, 6));
  ok(x.rows[6][2] === -5 || x.rows[6][2] === "-5", "plain negative number left alone", x.rows[6]);
  ok(x.rows.length === 8, "non-array rows ignored", x.rows.length);
  const nohead = await api("/api/admin/export-table", { method: "POST", jar: admin, body: { rows: [["a"]] }, buf: true });
  ok(nohead.status === 400, "no headings -> 400", nohead.status);
  const notitle = await api("/api/admin/export-table", { method: "POST", jar: admin, body: { head: ["A"], rows: [["1"]] }, buf: true });
  ok(sheetRows(notitle.buffer).rows[0][0] === "A", "without a title the headings are row 1");
  const big = await api("/api/admin/export-table", { method: "POST", jar: admin, body: { head: ["A"], rows: Array.from({ length: 20500 }, (_, i) => [i]) }, buf: true });
  ok(sheetRows(big.buffer).rows.length === 20001, "export capped at 20,000 rows", sheetRows(big.buffer).rows.length);

  section("Report name on screen, Excel and print");
  const spec = { source: "people", columns: ["name", "phone"], filters: { search: "DC" } };
  const run = (title) => api("/api/admin/report-builder/run", { method: "POST", jar: admin, body: { spec, lang: "en", title } });
  const r1o = await run("  Kids   under 12 \n attendance\u0007  ");
  ok(r1o.json.title === "Kids under 12 attendance", "name trimmed, spaces collapsed, control characters removed", r1o.json.title);
  const r2o = await run("x".repeat(300));
  ok(r2o.json.title.length === 80, "name capped at 80 characters", r2o.json.title.length);
  const r3o = await run(undefined);
  ok(r3o.json.title === "", "no name -> empty title", r3o.json.title);
  const rep = await api("/api/admin/report-builder/export", { method: "POST", jar: admin, body: { spec: { ...spec, groupBy: "memberType", layout: "both" }, lang: "ar", title: "تقرير أعضاء أكتوبر" }, buf: true });
  ok(rep.status === 200 && rep.buffer.slice(0, 2).toString() === "PK", "report Excel", rep.status);
  const rx = sheetRows(rep.buffer);
  ok(rx.names[0] === "تقرير أعضاء أكتوبر", "report sheet named after the report", rx.names);
  ok(rx.rows[0][0] === "تقرير أعضاء أكتوبر" && rx.rows[1].every((c) => c === ""), "Excel first row = report name", rx.rows.slice(0, 2));
  ok(/filename\*=UTF-8''%D8%AA%D9%82%D8%B1%D9%8A%D8%B1/.test(rep.disposition), "download file named after the report", rep.disposition);
  const wb = XLSX.read(rep.buffer, { type: "buffer" });
  const filtersRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[wb.SheetNames.length - 1]], { header: 1 });
  ok(String(filtersRows[1][0]).startsWith("اسم التقرير: تقرير أعضاء أكتوبر"), "Filters sheet records the report name", filtersRows.slice(0, 3));
  const sumRows = XLSX.utils.sheet_to_json(wb.Sheets["الملخص"], { header: 1 });
  ok(sumRows[0][0] === "تقرير أعضاء أكتوبر", "Summary sheet also starts with the name", sumRows[0]);
  const plain = await api("/api/admin/report-builder/export", { method: "POST", jar: admin, body: { spec, lang: "en" }, buf: true });
  const px = sheetRows(plain.buffer);
  ok(px.names[0] === "Report" && px.rows[0][0] === "Name", "no report name -> the old layout is unchanged", [px.names, px.rows[0]]);
  ok(/filename="ahlawy-custom-report.xlsx"/.test(plain.disposition), "no report name -> default file name", plain.disposition);
  const b64 = Buffer.from(JSON.stringify(spec)).toString("base64url");
  const pr = await api(`/admin/print/custom-report?lang=en&spec=${b64}&title=${encodeURIComponent("Kids <script>alert(1)</script> Oct")}`, { jar: admin, raw: true });
  ok(pr.status === 200 && pr.text.includes("<h1>Kids &lt;script&gt;alert(1)&lt;/script&gt; Oct</h1>") && !pr.text.includes("<script>alert(1)"), "print page: title shown and HTML-escaped", pr.text.match(/<h1>.*?<\/h1>/));
  ok(pr.text.includes("<title>Kids &lt;script&gt;"), "print page <title> uses the name too");
  const pr0 = await api(`/admin/print/custom-report?lang=en&spec=${b64}`, { jar: admin, raw: true });
  ok(pr0.text.includes("<h1>Custom report</h1>"), "print page without a name keeps the default heading");
  const pr1 = await api(`/admin/print/custom-report?lang=ar&spec=${b64}`, { jar: admin, raw: true });
  ok(pr1.text.includes("<h1>تقرير مخصص</h1>"), "Arabic default heading");
  const sv = await A("/api/admin/saved-reports", "POST", { name: "Saved Name", spec });
  ok([200, 201].includes(sv.status), "save report", sv.json);
  const ps = await api(`/admin/print/custom-report?lang=en&id=${sv.json.id}`, { jar: admin, raw: true });
  ok(ps.text.includes("<h1>Saved Name</h1>"), "saved report prints under its saved name");
  const ps2 = await api(`/admin/print/custom-report?lang=en&id=${sv.json.id}&title=${encodeURIComponent("Edited name")}`, { jar: admin, raw: true });
  ok(ps2.text.includes("<h1>Edited name</h1>"), "a name typed now beats the saved one");
  const prT = await api(`/admin/print/custom-report?lang=en&spec=${b64}&title=x`, { jar: tourn, raw: true });
  ok([401, 403].includes(prT.status), "tournament role still cannot print custom reports", prT.status);

  ok(serverErrors.length === 0, "no server errors", serverErrors);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
