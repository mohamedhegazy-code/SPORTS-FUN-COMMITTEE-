// Admin edits a member's details / membership number / login, member confirms + sets a new password.
// Usage: BASE_URL=http://localhost:3917 node member_details_e2e.js
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

const dayOffset = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
(async () => {
  const stamp = Date.now().toString(36);
  const admin = await prime({});
  ok((await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } })).status === 200, "admin login");
  const A = (p, m = "GET", b) => api(p, { method: m, jar: admin, body: b });
  const signup = async (num, name, phone) => {
    const jar = await prime({});
    const s = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: num, name, password: "abc12345", phone, agreeTerms: true, memberType: "main", birthDate: "1990-01-01" } });
    ok(s.status === 201, "signup " + num, s.json);
    return jar;
  };
  const form = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

  section("Fixtures");
  const OLD = "MD1" + stamp, NEW = "MD1X" + stamp, OTHER = "MD2" + stamp, FAM = "MD3" + stamp;
  const jarOld = await signup(OLD, "Details Member", "01033330001");
  await signup(OTHER, "Other Member", "01033330002");
  const ev = await api("/api/events", { method: "POST", jar: admin, form: form({ nameEn: "Details Event " + stamp, sport: "Chess", date: dayOffset(15), maxCapacity: "10" }) });
  ok(ev.status === 201, "event created", ev.json);
  const regR = await api("/api/register", { method: "POST", jar: jarOld, body: { eventId: ev.json.id } });
  ok(regR.status === 201, "member registers", regR.json);
  ok((await api("/api/me/chat/messages", { method: "POST", jar: jarOld, body: { text: "hello" } })).status === 201, "chat message");
  ok((await A(`/api/admin/members/${OLD}/points-adjust`, "POST", { mode: "add", amount: 5, reason: "test" })).status < 300, "points adjustment");

  section("Guards");
  const anon = await prime({});
  ok((await api(`/api/admin/members/${OLD}/details`, { method: "PUT", jar: anon, body: { name: "x" } })).status === 401, "anonymous 401");
  ok([401, 403].includes((await api(`/api/admin/members/${OLD}/details`, { method: "PUT", jar: jarOld, body: { name: "x" } })).status), "member cannot edit");
  ok((await A("/api/admin/members/NOPE999/details", "PUT", { name: "x" })).status === 404, "unknown member 404");
  ok((await A(`/api/admin/members/${OLD}/details`, "PUT", { name: "  " })).status === 400, "blank name 400");
  ok((await A(`/api/admin/members/${OLD}/details`, "PUT", { email: "not-an-email" })).status === 400, "bad email 400");
  ok((await A(`/api/admin/members/${OLD}/details`, "PUT", { memberType: "boss" })).status === 400, "bad member type 400");
  ok((await A(`/api/admin/members/${OLD}/details`, "PUT", { newMembershipNumber: "bad number!" })).status === 400, "bad number format 400");
  ok((await A(`/api/admin/members/${OLD}/details`, "PUT", { newMembershipNumber: OTHER })).status === 409, "number already used 409");
  ok((await A(`/api/admin/members/${OLD}/details`, "PUT", { name: "Details Member" })).status === 400, "nothing changed 400");
  ok((await api("/api/auth/me", { jar: jarOld })).status === 200, "failed edits did not drop the session");

  section("Edit details only (no rename, no new password)");
  let r = await A(`/api/admin/members/${OLD}/details`, "PUT", { name: "Details Member Renamed", phone: "01033339999", email: "dm@example.com", memberType: "follower", relationshipToMain: "Son" });
  ok(r.status === 200 && r.json.tempPassword === null && r.json.detailsConfirmPending === true, "saved, confirmation pending, no temp password", r.json);
  ok((r.json.changes || []).includes("name") && r.json.changes.includes("phone") && r.json.changes.includes("email"), "changes listed", r.json.changes);
  ok((await api("/api/auth/me", { jar: jarOld })).status === 401, "member's old session closed");
  let login = await api("/api/auth/login", { method: "POST", jar: await prime({}), body: { membershipNumber: OLD, password: "abc12345" } });
  ok(login.status === 200 && login.json.member.detailsConfirmPending === true, "member still logs in with the same password, flagged", login.json);
  ok(login.json.member.pendingDetailsChange.changes.some((c) => c.field === "name" && c.from === "Details Member"), "pending change keeps the old value");
  ok(!("passwordHash" in login.json.member), "no password hash leaked");

  section("Rename + issue new temporary password");
  r = await A(`/api/admin/members/${OLD}/details`, "PUT", { newMembershipNumber: NEW, issueLogin: true });
  ok(r.status === 200 && r.json.membershipNumber === NEW && typeof r.json.tempPassword === "string" && r.json.tempPassword.length >= 8, "renamed + temp password", r.json);
  const temp = r.json.tempPassword;
  ok((await api("/api/auth/login", { method: "POST", jar: await prime({}), body: { membershipNumber: OLD, password: "abc12345" } })).status === 401, "old number no longer logs in");
  ok((await api("/api/auth/login", { method: "POST", jar: await prime({}), body: { membershipNumber: NEW, password: "abc12345" } })).status === 401, "old password rejected");
  const dir = (await A("/api/admin/directory")).json;
  ok(!dir.find((m) => m.membershipNumber === OLD), "old number gone from directory");
  const row = dir.find((m) => m.membershipNumber === NEW);
  ok(row && row.name === "Details Member Renamed" && row.registeredCount === 1 && row.detailsConfirmPending === true, "directory row moved with its registration", row && { n: row.name, rc: row.registeredCount });
  ok(row && row.adjustments.length === 1 && row.balance !== undefined, "point adjustment moved", row && row.adjustments);
  ok(row && row.mustChangePassword === true, "temp-password flag set");
  const chat = await A(`/api/staff/chats/${NEW}`);
  ok(chat.status === 200 && chat.json.length === 1, "chat thread moved", chat.json);
  ok((await A(`/api/staff/chats/${OLD}`)).status === 404, "old chat thread gone");

  section("Member signs in with the new details");
  const jarNew = await prime({});
  const li = await api("/api/auth/login", { method: "POST", jar: jarNew, body: { membershipNumber: NEW, password: temp } });
  ok(li.status === 200 && li.json.member.detailsConfirmPending === true && li.json.member.pendingDetailsChange.previousMembershipNumber === OLD, "login ok, shows previous number", li.json.member && li.json.member.pendingDetailsChange);
  const myRegs = await api("/api/me/registrations", { jar: jarNew });
  ok(myRegs.status === 200 && JSON.stringify(myRegs.json).includes(String(ev.json.id)), "registration visible under the new number", myRegs.status);
  r = await api("/api/me/details/confirm", { method: "POST", jar: jarNew, body: { oldPassword: temp, newPassword: "Brand-new-1", confirmed: false } });
  ok(r.status === 400, "must tick confirmation", r.json);
  r = await api("/api/me/details/confirm", { method: "POST", jar: jarNew, body: { oldPassword: "wrong-one", newPassword: "Brand-new-1", confirmed: true } });
  ok(r.status === 401, "wrong temporary password 401");
  r = await api("/api/me/details/confirm", { method: "POST", jar: jarNew, body: { oldPassword: temp, newPassword: "abc", confirmed: true } });
  ok(r.status === 400, "short password 400");
  r = await api("/api/me/details/confirm", { method: "POST", jar: jarNew, body: { oldPassword: temp, newPassword: temp, confirmed: true } });
  ok(r.status === 400, "same password refused");
  r = await api("/api/me/details/confirm", { method: "POST", jar: jarNew, body: { oldPassword: temp, newPassword: "Brand-new-1", confirmed: true } });
  ok(r.status === 200 && r.json.member.detailsConfirmPending === false && r.json.member.mustChangePassword === false && r.json.member.pendingDetailsChange === null, "confirmed", r.json);
  r = await api("/api/me/details/confirm", { method: "POST", jar: jarNew, body: { oldPassword: "Brand-new-1", newPassword: "Another-2x", confirmed: true } });
  ok(r.status === 409, "nothing left to confirm 409");
  ok((await api("/api/auth/login", { method: "POST", jar: await prime({}), body: { membershipNumber: NEW, password: temp } })).status === 401, "temporary password stops working");
  const fin = await api("/api/auth/login", { method: "POST", jar: await prime({}), body: { membershipNumber: NEW, password: "Brand-new-1" } });
  ok(fin.status === 200 && !fin.json.member.detailsConfirmPending, "logs in with the new password, no gate", fin.json);
  const dir2 = (await A("/api/admin/directory")).json.find((m) => m.membershipNumber === NEW);
  ok(dir2 && !dir2.detailsConfirmPending && !dir2.mustChangePassword, "directory badge cleared");

  section("Edits before confirmation keep the ORIGINAL value");
  await A(`/api/admin/members/${NEW}/details`, "PUT", { name: "Step One" });
  r = await A(`/api/admin/members/${NEW}/details`, "PUT", { name: "Step Two" });
  const l2 = await api("/api/auth/login", { method: "POST", jar: await prime({}), body: { membershipNumber: NEW, password: "Brand-new-1" } });
  const nameChange = l2.json.member.pendingDetailsChange.changes.find((c) => c.field === "name");
  ok(nameChange && nameChange.from === "Details Member Renamed" && nameChange.to === "Step Two", "from = first old value, to = latest", nameChange);

  section("Profile that nobody has claimed yet");
  const un = "MD9" + stamp;
  ok((await A("/api/admin/members", "POST", { membershipNumber: un, name: "Unclaimed", phone: "01033330009" })).status === 201, "unclaimed profile");
  r = await A(`/api/admin/members/${un}/details`, "PUT", { name: "Unclaimed Fixed", newMembershipNumber: un + "B" });
  ok(r.status === 200 && r.json.detailsConfirmPending === false, "no confirmation needed without a login", r.json);
  r = await A(`/api/admin/members/${un}B/details`, "PUT", { issueLogin: true });
  ok(r.status === 200 && r.json.tempPassword && r.json.detailsConfirmPending === true, "issuing a login on it works", r.json);

  section("Shared family card keeps pooling");
  const famJar = await prime({});
  await api("/api/auth/signup", { method: "POST", jar: famJar, body: { membershipNumber: FAM, name: "Family Main", password: "abc12345", phone: "01033330010", agreeTerms: true, memberType: "main", birthDate: "1980-01-01" } });
  const famJar2 = await prime({});
  const s2 = await api("/api/auth/signup", { method: "POST", jar: famJar2, body: { membershipNumber: FAM, name: "Family Second", password: "abc12345", phone: "01033330011", agreeTerms: true, memberType: "follower", relationshipToMain: "Son", birthDate: "2010-01-01" } });
  ok(s2.status === 201 && s2.json.assignedLoginId === FAM + "-2", "second family account", s2.json);
  r = await A(`/api/admin/members/${FAM}-2/details`, "PUT", { newMembershipNumber: "MD3NEW" + stamp });
  ok(r.status === 200, "rename second family account", r.json);
  const d3 = (await A("/api/admin/directory")).json;
  const mainRow = d3.find((m) => m.membershipNumber === FAM), sonRow = d3.find((m) => m.membershipNumber === "MD3NEW" + stamp);
  ok(mainRow && sonRow && mainRow.familyPooled === sonRow.familyPooled, "pooling unchanged", { a: mainRow && mainRow.familyPooled, b: sonRow && sonRow.familyPooled });
  r = await A(`/api/admin/members/${FAM}/details`, "PUT", { newMembershipNumber: FAM + "Z" });
  ok(r.status === 200, "main account of a shared card can be renamed too", r.json);
  const d4 = (await A("/api/admin/directory")).json;
  ok(d4.find((m) => m.membershipNumber === FAM + "Z") && d4.find((m) => m.membershipNumber === "MD3NEW" + stamp).familyPooled === true, "still pooled after both renames");

  section("Plain password reset now forces a new password");
  const RP = "MD7" + stamp;
  const rpJar = await signup(RP, "Reset Person", "01033330077");
  r = await A(`/api/staff/members/${RP}/reset-password`, "POST", { newPassword: "Admin-set-1" });
  ok(r.status === 200, "reset ok", r.json);
  ok((await api("/api/auth/me", { jar: rpJar })).status === 401, "open session closed after reset");
  const rl = await api("/api/auth/login", { method: "POST", jar: await prime({}), body: { membershipNumber: RP, password: "Admin-set-1" } });
  ok(rl.status === 200 && rl.json.member.mustChangePassword === true, "logs in with admin-set password and must change it", rl.json);
  r = await api("/api/auth/change-password", { method: "POST", jar: rl.jar, body: { oldPassword: "Admin-set-1", newPassword: "Mine-only-2" } });
  ok(r.status === 200 && r.json.member.mustChangePassword === false, "member sets their own", r.json);

  section("Activity log");
  const act = await A("/api/admin/activity-log?limit=100");
  ok(act.status !== 200 || JSON.stringify(act.json).includes("member.details_edited"), "edit logged");
  ok(act.status !== 200 || JSON.stringify(act.json).includes("member.details_confirmed"), "confirmation logged");
  ok(!JSON.stringify(act.json || "").includes(temp), "temporary password never written to the log");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (serverErrors.length) { console.log("SERVER 5xx:", serverErrors); }
  process.exit(failed || serverErrors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
