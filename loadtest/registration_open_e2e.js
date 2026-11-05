// Registration "opens soon" + automatic opening E2E.
// - an event can be announced with registration closed; the SERVER refuses member sign-ups until it opens
// - one-click open / close, an optional opening time that opens it by itself, parent event day closing its activities
// - admin invites still work while closed; role guards; dashboard rows; activity log
// Usage: BASE_URL=http://localhost:3945 node registration_open_e2e.js   (fresh data folder, e2e admin below)
"use strict";
const path = require("path");
const BASE = process.env.BASE_URL || "http://localhost:3945";
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
async function mkEvent(nameEn, date, extra = {}, jar) {
  const f = new FormData();
  f.set("nameEn", nameEn); f.set("nameAr", nameEn + " ع"); f.set("sport", "Chess"); f.set("date", date);
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  const r = await api("/api/events", { method: "POST", jar: jar || admin, body: f, isForm: true });
  return r;
}
async function signup(num, name, birthDate) {
  const jar = await prime(newJar());
  const r = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: num, name, password: "abc12345", phone: "0106" + num.replace(/\D/g, "").padStart(7, "0"), agreeTerms: true, memberType: "main", birthDate } });
  if (![200, 201].includes(r.status)) throw new Error("signup failed " + JSON.stringify(r.json));
  return { jar, num, name };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evOf = async (id) => { const r = await api("/api/events", { jar: newJar() }); return (r.json || []).find((e) => e.id === id); };
const tryReg = (m, ev) => api("/api/register", { method: "POST", jar: m.jar, body: { eventId: ev } });

(async () => {
  const lg = await api("/api/auth/staff-login", { method: "POST", jar: await prime(admin), body: { username: ADMIN_USER, password: ADMIN_PASS } });
  ok(lg.status === 200, "admin login", lg.json);
  const m1 = await signup("RO1", "RO Alice", bd(30));
  const m2 = await signup("RO2", "RO Bob", bd(40));
  const m3 = await signup("RO3", "RO Carol", bd(25));
  const future = (secs) => new Date(Date.now() + secs * 1000).toISOString();

  section("Events made before this feature are open");
  const plain = await mkEvent("RO Plain", addDays(10));
  ok(plain.status === 201, "plain event created", plain.json);
  let e = await evOf(plain.json.id);
  ok(e.registrationOpen === true && e.registrationStatus === "open" && e.registrationOpensAt === null, "default is open", e);
  const rp = await tryReg(m1, plain.json.id);
  ok(rp.status === 201 || rp.status === 200, "member registers on an open event", rp.json);

  section("Announced with registration closed");
  const soon = await mkEvent("RO Soon", addDays(12), { registrationStatus: "soon" });
  ok(soon.status === 201, "closed event created", soon.json);
  const sid = soon.json.id;
  e = await evOf(sid);
  ok(e.registrationOpen === false && e.registrationStatus === "soon" && e.registrationOpensAt === null, "listed as opens-soon", e);
  const blocked = await tryReg(m1, sid);
  ok(blocked.status === 403 && blocked.json.code === "registration_not_open", "member sign-up refused by the server", [blocked.status, blocked.json]);
  const blocked2 = await tryReg(m2, sid);
  ok(blocked2.status === 403, "second member refused too");
  const mine = await api("/api/me/registrations", { jar: m1.jar });
  ok(!(mine.json || []).some((r) => r.eventId === sid), "no registration was created while closed");
  const inv = await A(`/api/admin/events/${sid}/invite`, "POST", { membershipNumbers: ["RO3"] });
  ok(inv.status === 200 && (inv.json.invited || []).length === 1, "admin invite still works while closed", inv.json);

  section("One-click open and close");
  let t1 = await A(`/api/events/${sid}/registration`, "POST", { status: "open" });
  ok(t1.status === 200 && t1.json.registrationOpen === true && t1.json.registrationStatus === "open", "open now", t1.json);
  const okReg = await tryReg(m1, sid);
  ok([200, 201].includes(okReg.status), "member registers once opened", okReg.json);
  t1 = await A(`/api/events/${sid}/registration`, "POST", { status: "soon" });
  ok(t1.status === 200 && t1.json.registrationOpen === false, "closed again", t1.json);
  const again = await tryReg(m2, sid);
  ok(again.status === 403, "closed again refuses new sign-ups");
  const bad = await A(`/api/events/${sid}/registration`, "POST", { status: "maybe" });
  ok(bad.status === 400, "unknown status rejected", bad.json);
  const noEv = await A(`/api/events/999999/registration`, "POST", { status: "open" });
  ok([403, 404].includes(noEv.status), "unknown event rejected", noEv.status);

  section("Opens by itself at the chosen time");
  const at = future(3);
  const sch = await A(`/api/events/${sid}/registration`, "POST", { status: "soon", opensAt: at });
  ok(sch.status === 200 && sch.json.registrationOpen === false && sch.json.registrationOpensAt === at, "scheduled", sch.json);
  e = await evOf(sid);
  ok(e.registrationOpen === false && e.registrationOpensAt === at, "list shows the opening time");
  const early = await tryReg(m2, sid);
  ok(early.status === 403, "still refused before the time");
  const past = await A(`/api/events/${sid}/registration`, "POST", { status: "soon", opensAt: new Date(Date.now() - 60000).toISOString() });
  ok(past.status === 400, "a time in the past is refused", past.json);
  const junk = await A(`/api/events/${sid}/registration`, "POST", { status: "soon", opensAt: "not a date" });
  ok(junk.status === 400, "an invalid time is refused", junk.json);
  e = await evOf(sid);
  ok(e.registrationOpensAt === at, "refused changes left the schedule alone");
  await sleep(3500);
  e = await evOf(sid);
  ok(e.registrationOpen === true && e.registrationStatus === "soon", "open by itself after the time (no timer, no click)", e);
  const late = await tryReg(m2, sid);
  ok([200, 201].includes(late.status), "member registers after the automatic opening", late.json);
  const dash = await A("/api/admin/dashboard");
  const row = (dash.json || []).find((r) => r.eventId === sid);
  ok(row && row.registrationOpen === true, "dashboard row agrees (open)", row);

  section("Add / edit forms");
  const withTime = await mkEvent("RO Timed", addDays(14), { registrationStatus: "soon", registrationOpensAt: future(3600) });
  ok(withTime.status === 201 && withTime.json.registrationStatus === "soon" && !!withTime.json.registrationOpensAt, "created with an opening time", withTime.json);
  const openForcesClear = await mkEvent("RO Open+time", addDays(14), { registrationStatus: "open", registrationOpensAt: future(3600) });
  ok(openForcesClear.json.registrationStatus === "open" && openForcesClear.json.registrationOpensAt === null, "open ignores any time", openForcesClear.json);
  const badCreate = await mkEvent("RO Bad", addDays(14), { registrationStatus: "soon", registrationOpensAt: "2001-01-01T00:00:00Z" });
  ok(badCreate.status === 400, "create with a past opening time refused", badCreate.json);
  const eid = withTime.json.id;
  const put = (extra) => { const f = new FormData(); f.set("nameEn", "RO Timed"); f.set("nameAr", ""); f.set("date", addDays(14)); for (const [k, v] of Object.entries(extra)) f.set(k, v); return api(`/api/events/${eid}`, { method: "PUT", jar: admin, body: f, isForm: true }); };
  const keep = await put({});
  ok(keep.status === 200 && keep.json.registrationStatus === "soon" && !!keep.json.registrationOpensAt, "an edit that sends no status keeps it", keep.json);
  const editOpen = await put({ registrationStatus: "open", registrationOpensAt: "" });
  ok(editOpen.status === 200 && editOpen.json.registrationOpen === true && editOpen.json.registrationOpensAt === null, "edit can open it", editOpen.json);
  const editSoon = await put({ registrationStatus: "soon", registrationOpensAt: "" });
  ok(editSoon.status === 200 && editSoon.json.registrationOpen === false, "edit can close it", editSoon.json);

  section("Event day closes its activities");
  const parent = await mkEvent("RO Day", addDays(20), { registrationStatus: "soon" });
  const child = await mkEvent("RO Activity", addDays(20), { parentEventId: String(parent.json.id) });
  ok(parent.status === 201 && child.status === 201, "parent and activity created", [parent.json, child.json]);
  e = await evOf(child.json.id);
  ok(e.registrationStatus === "open" && e.registrationOpen === false, "activity is closed because its day is", e);
  const cb = await tryReg(m1, child.json.id);
  ok(cb.status === 403 && cb.json.code === "registration_not_open", "activity sign-up refused while the day is closed", cb.json);
  await A(`/api/events/${parent.json.id}/registration`, "POST", { status: "open" });
  e = await evOf(child.json.id);
  ok(e.registrationOpen === true, "opening the day opens its activities");
  const co = await tryReg(m1, child.json.id);
  ok([200, 201].includes(co.status), "activity sign-up works once the day is open", co.json);
  await A(`/api/events/${child.json.id}/registration`, "POST", { status: "soon" });
  const cc = await tryReg(m2, child.json.id);
  ok(cc.status === 403, "an activity can also be closed on its own");

  section("Who may change it");
  const anon = await prime(newJar());
  const g = async (jar, st) => api(`/api/events/${sid}/registration`, { method: "POST", jar, body: { status: st } });
  ok((await g(anon, "open")).status === 401, "anonymous: 401");
  ok([401, 403].includes((await g(m1.jar, "open")).status), "a member cannot");
  await A("/api/staff/accounts", "POST", { username: "ro_gate", password: "Role!Pass2026xyz", role: "staff", name: "g" });
  const gate = await prime(newJar());
  await api("/api/auth/staff-login", { method: "POST", jar: gate, body: { username: "ro_gate", password: "Role!Pass2026xyz" } });
  ok((await g(gate, "open")).status === 403, "gate staff: 403");
  await A("/api/staff/accounts", "POST", { username: "ro_t1", password: "Role!Pass2026xyz", role: "tournament", name: "t1" });
  const t1j = await prime(newJar());
  await api("/api/auth/staff-login", { method: "POST", jar: t1j, body: { username: "ro_t1", password: "Role!Pass2026xyz" } });
  await A("/api/staff/accounts", "POST", { username: "ro_mg", password: "Role!Pass2026xyz", role: "management", name: "mg" });
  const mgj = await prime(newJar());
  await api("/api/auth/staff-login", { method: "POST", jar: mgj, body: { username: "ro_mg", password: "Role!Pass2026xyz" } });
  ok((await g(mgj, "open")).status === 403, "management role: 403");
  // Admin only: even the manager of the event cannot open or close registration.
  const mine1 = await mkEvent("RO Managed", addDays(30), { managerUsernames: JSON.stringify(["ro_t1"]), registrationStatus: "soon" });
  ok(mine1.status === 201 && mine1.json.registrationOpen === false, "admin creates a closed event for manager t1", mine1.json);
  const mid = mine1.json.id;
  const tg = (jar, st) => api(`/api/events/${mid}/registration`, { method: "POST", jar, body: { status: st } });
  ok((await tg(t1j, "open")).status === 403, "the event's own Tournament Manager cannot open it: 403");
  e = await evOf(mid);
  ok(e.registrationOpen === false, "still closed after the manager's attempt");
  const putAs = (jar, id, extra) => { const f = new FormData(); f.set("nameEn", "RO Managed"); f.set("nameAr", ""); f.set("date", addDays(30)); for (const [k, v] of Object.entries(extra)) f.set(k, v); return api(`/api/events/${id}`, { method: "PUT", jar, body: f, isForm: true }); };
  const mEdit = await putAs(t1j, mid, { registrationStatus: "open" });
  ok(mEdit.status === 200 && mEdit.json.registrationOpen === false, "a manager's edit cannot open it either", mEdit.json);
  const adminOpens = await A(`/api/events/${mid}/registration`, "POST", { status: "open" });
  ok(adminOpens.status === 200 && adminOpens.json.registrationOpen === true, "admin opens it", adminOpens.json);

  section("Activity log");
  const log = await A("/api/admin/activity-log?limit=200");
  const rows = (log.json && (log.json.entries || log.json.rows || log.json)) || [];
  ok(Array.isArray(rows) && rows.some((r) => r.action === "event_registration_toggled"), "opening / closing is recorded", Array.isArray(rows) ? rows.slice(0, 2) : log.json);

  console.log(`\nRegistration-open E2E: ${passed} passed, ${failed} failed`);
  if (serverErrors.length) console.log("5xx:", serverErrors);
  process.exit(failed || serverErrors.length ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
