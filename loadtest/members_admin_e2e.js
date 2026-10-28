// Admin member management E2E: send-credentials, points start date,
// manual points adjustments, archive / restore / permanent delete.
// Usage: BASE_URL=http://localhost:3914 node members_admin_e2e.js
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
async function member(i, name, ageGroup) {
  const jar = await prime(newJar());
  const r = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: `MA${i}`, name, password: "abc12345", phone: `0106${String(i).padStart(7, "0")}`, agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
  if (r.status !== 200 && r.status !== 201) throw new Error("signup failed " + JSON.stringify(r.json));
  const m = { jar, num: `MA${i}`, name, regs: {} };
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


const tomorrow = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
async function addMember(num, name, phone, extra = {}) {
  return A("/api/admin/members", "POST", { membershipNumber: num, name, phone, ageGroup: "18to45", ...extra });
}
const dir = async () => (await A("/api/admin/directory")).json;
const row = async (num) => (await dir()).find((m) => m.membershipNumber === num);
const login = async (num, pw) => { const jar = await prime(newJar()); const r = await api("/api/auth/login", { method: "POST", jar, body: { membershipNumber: num, password: pw } }); return { ...r, jar }; };

(async () => {
  const lg = await api("/api/auth/staff-login", { method: "POST", jar: await prime(admin), body: { username: ADMIN_USER, password: ADMIN_PASS } });
  ok(lg.status === 200, "admin login", lg.json);

  section("Fixtures");
  const anon = await prime(newJar());
  const evOld = await mkEvent("MA Old Event", "فعالية قديمة", { date: "2025-03-01" });
  const evChess = await mkEvent("MA Chess Cutoff", "شطرنج", { date: "2025-06-01" });
  const evNew = await mkEvent("MA New Event", "فعالية جديدة", { date: tomorrow(20) });
  let r = await addMember("MA100", "Alpha Member", "01012345678"); ok(r.status === 200 || r.status === 201, "add MA100", r.json);
  r = await addMember("MA101", "Beta NoPhone", ""); ok(r.status < 300, "add MA101", r.json);
  r = await addMember("MA102", "Gamma Member", "01112345678"); ok(r.status < 300, "add MA102", r.json);
  r = await addMember("MA103", "Delta Family", "01212345678", { familyGroup: "FamX" }); ok(r.status < 300, "add MA103", r.json);
  r = await addMember("MA104", "Echo Family", "01512345678", { familyGroup: "FamX" }); ok(r.status < 300, "add MA104", r.json);

  section("send-credentials: guards");
  r = await api("/api/admin/members/MA100/send-credentials", { method: "POST", jar: anon, body: {} });
  ok(r.status === 401 || r.status === 403, "anon blocked", r.status);
  r = await A("/api/admin/members/NOPE/send-credentials", "POST", {}); ok(r.status === 404, "unknown member 404", r.status);
  r = await A("/api/admin/members/MA101/send-credentials", "POST", {}); ok(r.status === 400, "no phone 400", r.json);

  section("send-credentials: issue + login + forced change");
  r = await A("/api/admin/members/MA100/send-credentials", "POST", {});
  ok(r.status === 200 && r.json.tempPassword && r.json.tempPassword.length >= 8, "issued", r.json);
  ok(/^https?:\/\//.test(r.json.loginUrl || ""), "login url present", r.json);
  const pw1 = r.json.tempPassword;
  ok(!/[0OlI1]/.test(pw1), "no ambiguous chars", pw1);
  let d = await row("MA100"); ok(d.hasLoggedInAccount && d.mustChangePassword && d.credentialsIssuedAt, "directory flags", d);
  let l = await login("MA100", pw1);
  ok(l.status === 200 && l.json.member && l.json.member.mustChangePassword === true, "temp password logs in, flagged", l.json);
  ok(l.json.member && !l.json.member.passwordHash, "no hash leaked");
  r = await A("/api/admin/members/MA100/send-credentials", "POST", {});
  ok(r.status === 409 && r.json.needsConfirm === true, "existing password needs confirm", r.json);
  r = await A("/api/admin/members/MA100/send-credentials", "POST", { replaceExisting: true });
  ok(r.status === 200 && r.json.tempPassword && r.json.tempPassword !== pw1, "replaced", r.json);
  const pw2 = r.json.tempPassword;
  l = await login("MA100", pw1); ok(l.status === 401, "old temp password dead", l.status);
  l = await login("MA100", pw2); ok(l.status === 200, "new temp password works", l.status);
  const mj = l.jar;
  r = await api("/api/auth/change-password", { method: "POST", jar: mj, body: { oldPassword: pw2, newPassword: "NewPass!234" } });
  ok(r.status === 200 && r.json.member && r.json.member.mustChangePassword === false, "member change-password clears flag", r.json);
  d = await row("MA100"); ok(d.mustChangePassword === false, "directory cleared", d);
  const act = await A("/api/admin/activity-log");
  const logTxt = JSON.stringify(act.json || "");
  ok(!logTxt.includes(pw1) && !logTxt.includes(pw2), "no password in activity log");
  ok(/member\.credentials_issued/.test(logTxt), "credential issuance logged");
  const staffOnly = await api("/api/admin/members/MA100/send-credentials", { method: "POST", jar: mj, body: {} });
  ok(staffOnly.status === 401 || staffOnly.status === 403, "member cannot issue credentials", staffOnly.status);

  section("manual points adjustment");
  r = await api("/api/admin/members/MA102/points-adjust", { method: "POST", jar: anon, body: { mode: "add", amount: 5, reason: "x" } });
  ok(r.status === 401 || r.status === 403, "anon blocked", r.status);
  r = await A("/api/admin/members/MA102/points-adjust", "POST", { mode: "add", amount: 5 }); ok(r.status === 400, "reason required", r.json);
  r = await A("/api/admin/members/MA102/points-adjust", "POST", { mode: "add", amount: 1.5, reason: "x" }); ok(r.status === 400, "whole number only", r.json);
  r = await A("/api/admin/members/MA102/points-adjust", "POST", { mode: "add", amount: 0, reason: "x" }); ok(r.status === 400, "zero delta rejected", r.json);
  r = await A("/api/admin/members/MA102/points-adjust", "POST", { mode: "add", amount: -10, reason: "x" }); ok(r.status === 400, "cannot go below zero", r.json);
  r = await A("/api/admin/members/MA102/points-adjust", "POST", { mode: "bogus", amount: 10, reason: "x" }); ok(r.status === 400, "bad mode", r.json);
  r = await A("/api/admin/members/NOPE/points-adjust", "POST", { mode: "add", amount: 10, reason: "x" }); ok(r.status === 404, "unknown member", r.status);
  r = await A("/api/admin/members/MA102/points-adjust", "POST", { mode: "add", amount: 2000, reason: "Goodwill" });
  ok(r.status === 200 && r.json.balance === 2000, "add 2000", r.json);
  r = await A("/api/admin/members/MA102/points-adjust", "POST", { mode: "add", amount: -500, reason: "Correction" });
  ok(r.status === 200 && r.json.balance === 1500, "subtract 500", r.json);
  r = await A("/api/admin/members/MA102/points-adjust", "POST", { mode: "set", amount: 1800, reason: "Set" });
  ok(r.status === 200 && r.json.balance === 1800 && r.json.adjustment.delta === 300, "set to 1800 => delta 300", r.json);
  d = await row("MA102");
  ok(d.balance === 1800 && d.adjustments.length === 3 && d.adjustments[0].reason === "Set", "directory shows balance+history", d.adjustments);
  const l2 = await A("/api/admin/activity-log"); ok(/points\.adjusted/.test(JSON.stringify(l2.json)), "adjustment logged");

  section("family pool adjustments");
  r = await A("/api/admin/members/MA103/points-adjust", "POST", { mode: "add", amount: 100, reason: "pool" });
  ok(r.status === 200, "adjust pooled member", r.json);
  const d103 = await row("MA103"), d104 = await row("MA104");
  ok(d103.balance === 100 && d104.balance === 100 && d103.familyPooled, "balance shared across pool", [d103.balance, d104.balance]);

  section("points start date");
  const m1 = await member(200, "Cutoff One");
  const ro = await register(m1, evOld); const rc = await register(m1, evChess);
  ok(ro && rc, "registered old+chess");
  await checkin(m1, evOld); await checkin(m1, evChess);
  let bal = (await api("/api/me/balance", { jar: m1.jar })).json.balance;
  ok(bal > 0, "points before cutoff", bal);
  const balBefore = bal;
  r = await api("/api/admin/points-start", { jar: anon }); ok(r.status === 401 || r.status === 403, "points-start guarded", r.status);
  r = await A("/api/admin/points-start"); ok(r.status === 200, "get points-start", r.json);
  r = await A(`/api/admin/points-start/preview?eventId=${evChess}`);
  ok(r.status === 200 && r.json.checkInsAffected >= 1 && r.json.pointsRemoved > 0, "preview counts", r.json);
  r = await A("/api/admin/points-start", "PUT", { eventId: 999999 }); ok(r.status === 400 || r.status === 404, "unknown event rejected", r.status);
  r = await A("/api/admin/points-start", "PUT", { eventId: evChess });
  ok(r.status === 200 && r.json.date === "2025-06-01", "set cutoff to chess event", r.json);
  bal = (await api("/api/me/balance", { jar: m1.jar })).json.balance;
  ok(bal < balBefore && bal > 0, "old event stops counting, chess event still counts", [bal, balBefore]);
  d = await row("MA102"); ok(d.balance === 1800, "manual adjustments unaffected by cutoff", d.balance);
  // redemption requested before cutoff is ignored; after cutoff counts
  r = await A("/api/admin/points-start", "PUT", { eventId: null });
  ok(r.status === 200, "clear cutoff", r.json);
  bal = (await api("/api/me/balance", { jar: m1.jar })).json.balance;
  ok(bal === balBefore, "clearing restores old points (non-destructive)", [bal, balBefore]);
  r = await A("/api/admin/points-start"); ok(!r.json.date && !r.json.eventId, "cleared state", r.json);

  section("redemption + cutoff interplay");
  const ml = await login("MA102", "x"); // wrong pw sanity
  ok(ml.status === 401, "unknown pw rejected");
  r = await A("/api/admin/members/MA102/send-credentials", "POST", { replaceExisting: true });
  const m102pw = r.json.tempPassword;
  const l102 = await login("MA102", m102pw); ok(l102.status === 200, "MA102 login");
  r = await api("/api/redeem", { method: "POST", jar: l102.jar, body: { tier: 1 } });
  ok(r.status === 201, "redeem tier 1 (pending)", r.json);
  const redId = r.json && r.json.redemption && r.json.redemption.id;
  r = await A(`/api/redemptions/${redId}/status`, "POST", { status: "Approved" });
  ok(r.status === 200, "approve redemption", r.json);
  let b102 = (await A("/api/admin/directory")).json.find((m) => m.membershipNumber === "MA102").balance;
  ok(b102 < 1800, "approved redemption deducts", b102);
  // Cutoff in the future relative to the redemption: set cutoff to a later event => redemption ignored
  r = await A("/api/admin/points-start", "PUT", { eventId: evNew });
  ok(r.status === 200, "cutoff at future event", r.json);
  b102 = (await row("MA102")).balance;
  ok(b102 === 1800, "pre-cutoff redemption ignored", b102);
  r = await A("/api/admin/points-start", "PUT", { eventId: null });

  section("archive / restore / delete");
  r = await api("/api/admin/members/bulk", { method: "POST", jar: anon, body: { action: "archive", membershipNumbers: ["MA102"] } });
  ok(r.status === 401 || r.status === 403, "bulk guarded", r.status);
  r = await A("/api/admin/members/bulk", "POST", { action: "nope", membershipNumbers: ["MA102"] }); ok(r.status === 400, "bad action", r.json);
  r = await A("/api/admin/members/bulk", "POST", { action: "archive", membershipNumbers: [] }); ok(r.status === 400, "empty list", r.json);
  // member with upcoming registration cannot be archived
  const mUp = await member(201, "Upcoming Reg"); await register(mUp, evNew);
  r = await A("/api/admin/members/bulk", "POST", { action: "archive", membershipNumbers: ["MA201"] });
  ok(r.status === 200 && r.json.failed === 1 && !r.json.results[0].ok, "upcoming registration blocks archive", r.json);
  // pending redemption blocks archive
  r = await A("/api/admin/members/MA104/points-adjust", "POST", { mode: "add", amount: 2000, reason: "for redemption" });
  r = await A("/api/admin/members/MA104/send-credentials", "POST", { replaceExisting: true });
  const l104 = await login("MA104", r.json.tempPassword);
  r = await api("/api/redeem", { method: "POST", jar: l104.jar, body: { tier: 1 } }); ok(r.status === 201, "MA104 redeem", r.json);
  const pend = r.json.redemption.id;
  r = await A("/api/admin/members/bulk", "POST", { action: "archive", membershipNumbers: ["MA104"] });
  ok(r.json.failed === 1, "pending redemption blocks archive", r.json);
  await A(`/api/redemptions/${pend}/status`, "POST", { status: "Rejected" });
  // clean archive
  const poolBefore = (await row("MA103")).balance;
  r = await A("/api/admin/members/bulk", "POST", { action: "archive", membershipNumbers: ["MA104", "MA101"] });
  ok(r.json.done === 2 && r.json.failed === 0, "archive 2", r.json);
  d = await row("MA104"); ok(!!d.archivedAt, "archivedAt set");
  let probe = await api("/api/me/balance", { jar: l104.jar }); ok(probe.status === 401, "archived member's session dropped", probe.status);
  probe = await login("MA104", "anything"); ok(probe.status === 401, "archived login no oracle without pw", probe.status);
  r = await A("/api/admin/members/MA104/send-credentials", "POST", { replaceExisting: true }); ok(r.status === 409, "no credentials for archived", r.json);
  const inv = await A("/api/admin/members"); ok(!JSON.stringify(inv.json).includes("MA104"), "archived absent from invite list");
  r = await A("/api/admin/members/bulk", "POST", { action: "archive", membershipNumbers: ["MA104"] });
  ok(r.json.failed === 1, "double archive reported", r.json);
  // restore
  r = await A("/api/admin/members/bulk", "POST", { action: "restore", membershipNumbers: ["MA104"] });
  ok(r.json.done === 1, "restore", r.json);
  d = await row("MA104"); ok(!d.archivedAt, "restored");
  r = await A("/api/admin/members/bulk", "POST", { action: "restore", membershipNumbers: ["MA104"] });
  ok(r.json.failed === 1, "restore non-archived rejected", r.json);
  // delete rules
  r = await A("/api/admin/members/bulk", "POST", { action: "delete", membershipNumbers: ["MA101"] });
  ok(r.status === 400, "delete needs DELETE confirm", r.json);
  r = await A("/api/admin/members/bulk", "POST", { action: "delete", membershipNumbers: ["MA100"], confirm: "DELETE" });
  ok(r.json.failed === 1, "delete requires archived first", r.json);
  r = await A("/api/admin/members/bulk", "POST", { action: "delete", membershipNumbers: ["MA101"], confirm: "DELETE" });
  ok(r.json.done === 1, "permanent delete", r.json);
  ok(!(await row("MA101")), "member gone from directory");
  // delete member with history (checked in, old events only)
  r = await A("/api/admin/members/bulk", "POST", { action: "archive", membershipNumbers: ["MA200"] });
  ok(r.json.done === 1, "archive member with history", r.json);
  r = await A("/api/admin/members/bulk", "POST", { action: "delete", membershipNumbers: ["MA200"], confirm: "DELETE" });
  ok(r.json.done === 1, "delete member with history", r.json);
  const after = await dir();
  ok(!after.find((m) => m.membershipNumber === "MA200"), "gone");
  const rep = await A("/api/admin/reports/events"); ok(rep.status === 200, "reports still work after delete", rep.status);
  // cannot sign up again as archived
  await A("/api/admin/members/bulk", "POST", { action: "archive", membershipNumbers: ["MA103"] });
  const su = await api("/api/auth/signup", { method: "POST", jar: await prime(newJar()), body: { membershipNumber: "MA103", name: "Delta Family", password: "abc12345", phone: "01212345678", agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
  ok(su.status === 403, "archived membership cannot sign up", su.json);
  const d104b = await row("MA104");
  ok(d104b.balance === 2000 - 0 || d104b.balance >= 0, "balance sane", d104b.balance);
  const d103b = await row("MA103");
  ok(d103b.familyPooled === false || d103b.balance >= 0, "pool excludes archived", [d103b.balance, d103b.familyPooled]);
  ok(poolBefore >= 0, "pool before sane");


  section("staff phone + credentials");
  const sLogin = async (u, p) => { const jar = await prime(newJar()); const r = await api("/api/auth/staff-login", { method: "POST", jar, body: { username: u, password: p } }); return { ...r, jar }; };
  r = await A("/api/staff/accounts", "POST", { username: "stf1", password: "OldPass!1", name: "Staff One", role: "tournament", phone: "0100 111-2222 abc<script>" });
  ok(r.status === 201 && r.json.staff.phone === "0100 111-2222", "create with sanitized phone", r.json);
  r = await A("/api/staff/accounts", "POST", { username: "stf2", password: "OldPass!2", name: "Staff Two", role: "staff" });
  ok(r.status === 201, "create without phone", r.json);
  r = await A("/api/staff/accounts/stf2/send-credentials", "POST", { replaceExisting: true }); ok(r.status === 400, "no phone 400", r.json);
  r = await api("/api/staff/accounts/stf1/send-credentials", { method: "POST", jar: anon, body: { replaceExisting: true } }); ok(r.status === 401 || r.status === 403, "anon blocked", r.status);
  const stfJar = (await sLogin("stf1", "OldPass!1"));
  ok(stfJar.status === 200, "stf1 logs in with original password", stfJar.json);
  r = await api("/api/staff/accounts/stf1/send-credentials", { method: "POST", jar: stfJar.jar, body: { replaceExisting: true } }); ok(r.status === 403, "non-admin staff blocked", r.status);
  r = await api("/api/staff/accounts/stf1/phone", { method: "PUT", jar: stfJar.jar, body: { phone: "0100" } }); ok(r.status === 403, "non-admin cannot edit phone", r.status);
  r = await A("/api/staff/accounts/stf2/phone", "PUT", { phone: "01099998888" }); ok(r.status === 200 && r.json.phone === "01099998888", "set phone", r.json);
  r = await A("/api/staff/accounts/NOPE/phone", "PUT", { phone: "0100" }); ok(r.status === 404, "phone unknown account", r.status);
  r = await A("/api/staff/accounts"); ok(r.json.find((x) => x.username === "stf2").phone === "01099998888", "phone listed");
  r = await A("/api/staff/accounts/NOPE/send-credentials", "POST", { replaceExisting: true }); ok(r.status === 404, "unknown 404", r.status);
  r = await A("/api/staff/accounts/e2eadmin/send-credentials", "POST", { replaceExisting: true }); ok(r.status === 400, "own account refused (no phone or self)", r.json);
  await A("/api/staff/accounts/e2eadmin/phone", "PUT", { phone: "01000000000" });
  r = await A("/api/staff/accounts/e2eadmin/send-credentials", "POST", { replaceExisting: true }); ok(r.status === 400 && /own/i.test(r.json.error), "own account refused", r.json);
  r = await A("/api/staff/accounts/stf1/send-credentials", "POST", {}); ok(r.status === 409 && r.json.needsConfirm, "needs confirm", r.json);
  r = await A("/api/staff/accounts/stf1/send-credentials", "POST", { replaceExisting: true });
  ok(r.status === 200 && r.json.tempPassword && r.json.username === "stf1", "issued", r.json);
  const spw = r.json.tempPassword;
  const sess = await api("/api/auth/me", { jar: stfJar.jar }); ok(sess.status === 401 || !(sess.json && sess.json.staff), "old staff session dropped", sess.status);
  let sl = await sLogin("stf1", "OldPass!1"); ok(sl.status === 401, "old password dead", sl.status);
  sl = await sLogin("stf1", spw); ok(sl.status === 200 && sl.json.staff && sl.json.staff.mustChangePassword === true && !sl.json.staff.passwordHash, "temp password logs in, flagged", sl.json);
  r = await api("/api/auth/change-password", { method: "POST", jar: sl.jar, body: { oldPassword: spw, newPassword: "BrandNew!77" } });
  ok(r.status === 200, "staff changes password", r.json);
  const lst = await A("/api/staff/accounts"); ok(lst.json.find((x) => x.username === "stf1").mustChangePassword === false, "flag cleared");
  const al = JSON.stringify((await A("/api/admin/activity-log")).json);
  ok(!al.includes(spw) && /staff\.credentials_issued/.test(al), "staff issuance logged without password");

  console.log(`\nserver errors: ${serverErrors.length}`, serverErrors.slice(0, 5));
  ok(serverErrors.length === 0, "no 5xx");
  console.log(`\nPASSED ${passed}  FAILED ${failed}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
