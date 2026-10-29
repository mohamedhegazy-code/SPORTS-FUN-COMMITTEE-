// Partner role E2E: a read-only account that sees ONLY the checked-in people
// (name, age, date of birth, check-in time) of the events an admin assigned.
// Usage: BASE_URL=http://localhost:3917 node partner_e2e.js
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
const isoDaysFromNow = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
(async () => {
  const stamp = Date.now().toString(36);
  const admin = await prime({});
  ok((await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } })).status === 200, "admin login");

  const mkEvent = async (name, date, extra = {}) => {
    const form = new FormData();
    form.set("nameEn", name + " " + stamp); form.set("nameAr", "فعالية"); form.set("sport", "Padel"); form.set("date", date);
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    const r = await api("/api/events", { method: "POST", jar: admin, form });
    ok(r.status === 201, "create event " + name, r.json);
    return r.json.id;
  };
  section("Fixtures");
  const evA = await mkEvent("Partner A", isoDaysFromNow(3));
  const evB = await mkEvent("Partner B", isoDaysFromNow(4));
  const evOld = await mkEvent("Partner Old", isoDaysFromNow(-30));
  const evParent = await mkEvent("Partner Day", isoDaysFromNow(5));
  const evChild = await mkEvent("Partner Child", isoDaysFromNow(5), { parentEventId: String(evParent) });

  const signup = async (n, birth) => {
    const jar = await prime({});
    const num = `PT${n}${stamp}`;
    const r = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: num, name: `Partner Person ${n}`, password: "abc12345", phone: `0101888${String(1000 + n)}`, agreeTerms: true, memberType: "main", birthDate: birth } });
    ok(r.status === 201, `signup ${n}`, r.json);
    return { jar, num };
  };
  const p1 = await signup(1, "1985-04-12");
  const p2 = await signup(2, "1990-06-15");
  const p3 = await signup(3, "2000-01-01");
  const dep = await api("/api/me/dependents", { method: "POST", jar: p1.jar, body: { name: "Kid One", relationship: "Son", birthDate: "2015-09-09" } });
  ok(dep.status === 201 || dep.status === 200, "add dependent", dep.json);
  const depId = (dep.json.dependents || []).find((d) => d.name === "Kid One").id;

  const reg = async (who, eventId, dependentId) => { const r = await api("/api/register", { method: "POST", jar: who.jar, body: { eventId, dependentId } }); ok(r.status === 201, "register", r.json); return r.json; };
  await reg(p1, evA); await reg(p1, evA, depId); await reg(p2, evA); await reg(p3, evB); await reg(p2, evChild);
  const rosterOf = async (id) => (await api(`/api/staff/events/${id}/roster`, { jar: admin })).json;
  let rosterA = await rosterOf(evA);
  const rid = (rows, name) => rows.find((x) => x.attendeeName === name).registrationId;
  // check in p1 + Kid One (not p2)
  ok((await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: rid(rosterA, "Partner Person 1") } })).status === 200, "check in member");
  ok((await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: rid(rosterA, "Kid One") } })).status === 200, "check in dependent");
  const rosterB = await rosterOf(evB);
  ok((await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: rid(rosterB, "Partner Person 3") } })).status === 200, "check in event B member");
  const rosterC = await rosterOf(evChild);
  ok((await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: rid(rosterC, "Partner Person 2") } })).status === 200, "check in child activity member");

  section("Admin creates the partner account");
  const uname = "partner" + stamp;
  let r = await api("/api/staff/accounts", { method: "POST", jar: admin, body: { username: uname, password: "Partner#1234", name: "Test Partner", role: "partner" } });
  ok(r.status === 201 && r.json.staff.role === "partner", "partner account created", r.json);
  ok((await api("/api/staff/accounts", { method: "POST", jar: admin, body: { username: "x" + uname, password: "Partner#1234", name: "X", role: "nonsense" } })).status === 400, "unknown role still rejected");
  // assignment
  r = await api(`/api/staff/accounts/${uname}/partner-events`, { method: "PUT", jar: admin, body: { eventIds: [evA, evOld, evParent, 99999, "abc", evA] } });
  ok(r.status === 200 && JSON.stringify(r.json.partnerEventIds) === JSON.stringify([evA, evOld, evParent]), "assignment keeps valid unique ids only", r.json);
  ok((await api(`/api/staff/accounts/${ADMIN_USER}/partner-events`, { method: "PUT", jar: admin, body: { eventIds: [evA] } })).status === 400, "only partner accounts take assignments");
  ok((await api(`/api/staff/accounts/nobody/partner-events`, { method: "PUT", jar: admin, body: { eventIds: [] } })).status === 404, "unknown account -> 404");
  const listed = (await api("/api/staff/accounts", { jar: admin })).json.find((s) => s.username === uname);
  ok(listed && listed.partnerEventIds.length === 3, "staff list shows assigned events", listed);

  section("Partner sees only assigned events and only checked-in people");
  const partner = await prime({});
  ok((await api("/api/auth/staff-login", { method: "POST", jar: partner, body: { username: uname, password: "Partner#1234" } })).status === 200, "partner login");
  const evs = await api("/api/partner/events", { jar: partner });
  ok(evs.status === 200, "partner events 200", evs.json);
  const ids = evs.json.events.map((e) => e.id);
  ok(ids.includes(evA) && ids.includes(evParent) && !ids.includes(evB), "lists assigned events, not B", ids);
  ok(!ids.includes(evOld), "event finished more than 7 days ago is closed", ids);
  ok(!ids.includes(evChild), "child activity is not listed on its own");
  const a = await api(`/api/partner/events/${evA}/attendees`, { jar: partner });
  ok(a.status === 200, "attendees A 200", a.json);
  const names = a.json.attendees.map((x) => x.name).sort();
  ok(JSON.stringify(names) === JSON.stringify(["Kid One", "Partner Person 1"]), "only checked-in people (not the registered-only one)", names);
  const m1 = a.json.attendees.find((x) => x.name === "Partner Person 1");
  const kid = a.json.attendees.find((x) => x.name === "Kid One");
  ok(m1.birthDate === "1985-04-12" && m1.age >= 40, "member birth date + age", m1);
  ok(kid.birthDate === "2015-09-09" && kid.age >= 9 && kid.age <= 11, "dependent shows own birth date + age", kid);
  ok(!!m1.checkedInAt, "check-in time present");
  const keys = new Set(a.json.attendees.flatMap((x) => Object.keys(x)));
  ok([...keys].every((k) => ["name", "age", "birthDate", "checkedInAt", "activityEn", "activityAr"].includes(k)), "no extra fields leak (no phone / membership number)", [...keys]);
  ok(!JSON.stringify(a.json).includes("0101888") && !JSON.stringify(a.json).includes("PT1" + stamp), "no phone or membership number anywhere in the payload");
  ok(a.json.event && a.json.event.checkedInCount === 2, "event summary count", a.json.event);
  const pd = await api(`/api/partner/events/${evParent}/attendees`, { jar: partner });
  ok(pd.status === 200 && pd.json.attendees.length === 1 && pd.json.attendees[0].name === "Partner Person 2" && !!pd.json.attendees[0].activityEn, "parent event includes checked-in people of its activities", pd.json);
  ok((await api(`/api/partner/events/${evB}/attendees`, { jar: partner })).status === 403, "event B (not assigned) -> 403");
  ok((await api(`/api/partner/events/${evOld}/attendees`, { jar: partner })).status === 403, "closed event -> 403");
  ok((await api(`/api/partner/events/99999/attendees`, { jar: partner })).status === 404, "unknown event -> 404");

  section("Partner cannot reach anything else");
  const blocked = [
    ["GET", `/api/staff/events/${evA}/roster`], ["POST", "/api/checkin", { code: "x" }], ["POST", "/api/checkin/manual", { registrationId: 1 }],
    ["POST", "/api/checkin/undo", { registrationId: 1 }], ["GET", "/api/admin/dashboard"], ["GET", "/api/admin/directory"], ["GET", "/api/admin/members"],
    ["GET", "/api/staff/accounts"], ["PUT", `/api/staff/accounts/${uname}/partner-events`, { eventIds: [evB] }], ["POST", "/api/staff/accounts", { username: "z", password: "123456", name: "z", role: "admin" }],
    ["GET", "/api/admin/reports/events"], ["GET", "/api/staff/chats"], ["GET", "/api/staff/inquiries"], ["GET", "/api/admin/management/dashboard"],
    ["GET", `/admin/print/event/${evA}?view=registrations&lang=en`], ["GET", "/admin/print/age-report?lang=en"], ["POST", "/api/staff/recovery-pin", { pin: "123456" }],
    ["GET", `/api/admin/events/${evA}/attendance-rollup`], ["POST", `/api/staff/registrations/1/whatsapp-confirmed`, { type: "confirm" }],
    ["GET", "/api/admin/activity-log"],
  ];
  for (const [method, path, body] of blocked) {
    const x = await api(path, { method, jar: partner, body });
    ok(x.status === 401 || x.status === 403 || x.status === 404, `${method} ${path} refused`, x.status); if (process.env.VERBOSE) console.log(x.status, method, path);
  }
  // admin can still preview
  ok((await api(`/api/partner/events/${evA}/attendees`, { jar: admin })).status === 200, "admin can preview the partner view");
  // a member session / anonymous cannot use it
  ok((await api(`/api/partner/events/${evA}/attendees`, { jar: p1.jar })).status === 401, "member session refused");
  ok((await api(`/api/partner/events`, { jar: await prime({}) })).status === 401, "anonymous refused");
  // other staff roles cannot use it either
  const tmu = "tm" + stamp;
  await api("/api/staff/accounts", { method: "POST", jar: admin, body: { username: tmu, password: "Manager#1234", name: "TM", role: "tournament" } });
  const tm = await prime({});
  await api("/api/auth/staff-login", { method: "POST", jar: tm, body: { username: tmu, password: "Manager#1234" } });
  ok((await api(`/api/partner/events`, { jar: tm })).status === 403, "tournament manager refused on partner endpoints");

  section("Audit trail + un-assigning");
  const log = (await api("/api/admin/activity-log?limit=200", { jar: admin })).json;
  const text = JSON.stringify(log);
  ok(/partner\.viewed_attendees/.test(text) && /staff\.partner_events_set/.test(text), "partner views and assignments are logged");
  await api(`/api/staff/accounts/${uname}/partner-events`, { method: "PUT", jar: admin, body: { eventIds: [] } });
  const none = await api("/api/partner/events", { jar: partner });
  ok(none.status === 200 && none.json.events.length === 0, "after un-assigning, the partner sees nothing", none.json);
  ok((await api(`/api/partner/events/${evA}/attendees`, { jar: partner })).status === 403, "attendees refused after un-assigning");

  console.log(`\nserver errors: ${serverErrors.length}`, serverErrors);
  ok(serverErrors.length === 0, "no 5xx");
  console.log(`\nPartner E2E: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
