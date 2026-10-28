// WhatsApp vs waiting list E2E: no confirmation / reminder / event-day message
// may be recorded or sent for a waitlisted registration; once promoted (manual
// or automatic after a cancellation) the person becomes eligible.
// Usage: BASE_URL=http://localhost:3917 node waitlist_whatsapp_e2e.js
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
(async () => {
  const admin = await prime({});
  ok((await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } })).status === 200, "admin login");
  const stamp = Date.now().toString(36);
  const signup = async (n) => {
    const jar = await prime({});
    const num = `WLW${n}${stamp}`;
    const r = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: num, name: `WLW Person ${n}`, password: "abc12345", phone: `0101999${String(1000 + n)}`, agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
    ok(r.status === 201, `signup ${n}`, r.json);
    return { jar, num };
  };
  const form = new FormData();
  form.set("nameEn", "WLW Capacity 2 " + stamp); form.set("nameAr", "فعالية"); form.set("sport", "Padel"); form.set("date", "2026-12-20"); form.set("maxCapacity", "2");
  const ev = await api("/api/events", { method: "POST", jar: admin, form });
  ok(ev.status === 201, "create capacity-2 event", ev.json);
  const eventId = ev.json.id;

  section("Fixtures: 2 confirmed + 2 waitlisted");
  const people = [];
  for (let i = 1; i <= 4; i++) people.push(await signup(i));
  const regs = [];
  for (let i = 0; i < 4; i++) {
    let r = await api("/api/register", { method: "POST", jar: people[i].jar, body: { eventId } });
    if (r.status === 200 && r.json.needsWaitlistConfirmation) r = await api("/api/register", { method: "POST", jar: people[i].jar, body: { eventId, joinWaitlist: true } });
    ok(r.status === 201, `register ${i + 1}`, r.json);
    regs.push(r.json);
  }
  const roster = async () => (await api(`/api/staff/events/${eventId}/roster`, { jar: admin })).json;
  let rows = await roster();
  const byNum = (n) => rows.find((x) => (x.membershipNumber || "") === n || (x.attendeeName || "").endsWith(String(n)));
  const idOf = (i) => rows.find((x) => x.attendeeName === `WLW Person ${i + 1}`).registrationId;
  ok(rows.filter((x) => !x.waitlisted).length === 2 && rows.filter((x) => x.waitlisted).length === 2, "2 confirmed + 2 waitlisted in roster", rows.map((x) => [x.attendeeName, x.waitlisted]));

  section("Waitlisted registrations: every WhatsApp record is refused (409)");
  for (const type of ["confirm", "reminder", "dayof"]) {
    const r = await api(`/api/staff/registrations/${idOf(2)}/whatsapp-confirmed`, { method: "POST", jar: admin, body: { type } });
    ok(r.status === 409, `waitlisted ${type} -> 409`, r.json);
  }
  const noType = await api(`/api/staff/registrations/${idOf(3)}/whatsapp-confirmed`, { method: "POST", jar: admin, body: {} });
  ok(noType.status === 409, "waitlisted default type -> 409", noType.json);
  rows = await roster();
  ok(rows.filter((x) => x.waitlisted).every((x) => !x.whatsappConfirmedAt && !x.whatsappReminderAt && !x.whatsappDayOfAt), "nothing was stamped on waitlisted rows");

  section("Confirmed registrations still work");
  for (const type of ["confirm", "reminder", "dayof"]) {
    const r = await api(`/api/staff/registrations/${idOf(0)}/whatsapp-confirmed`, { method: "POST", jar: admin, body: { type } });
    ok(r.status === 200, `confirmed ${type} -> 200`, r.json);
  }
  ok((await api(`/api/staff/registrations/${idOf(0)}/whatsapp-confirmed`, { method: "POST", jar: admin, body: { type: "nonsense" } })).status === 400, "unknown type -> 400");
  ok((await api(`/api/staff/registrations/999999/whatsapp-confirmed`, { method: "POST", jar: admin, body: {} })).status === 404, "unknown registration -> 404");

  section("Manual promote makes a waitlisted person eligible");
  const pr = await api(`/api/admin/registrations/${idOf(2)}/promote`, { method: "POST", jar: admin });
  ok(pr.status === 200, "promote", pr.json);
  ok((await api(`/api/staff/registrations/${idOf(2)}/whatsapp-confirmed`, { method: "POST", jar: admin, body: { type: "confirm" } })).status === 200, "after promotion confirm -> 200");

  section("Automatic promotion after a cancellation clears stale stamps and enables sending");
  // member 1 cancels -> the remaining waitlisted person (4th) is auto-promoted
  const canc = await api(`/api/me/registrations/${idOf(0)}`, { method: "DELETE", jar: people[0].jar });
  ok(canc.status === 200, "member cancels", canc.json);
  rows = await roster();
  const p4 = rows.find((x) => x.attendeeName === "WLW Person 4");
  ok(p4 && !p4.waitlisted, "person 4 auto-promoted", p4);
  ok(p4 && !p4.whatsappConfirmedAt && !p4.whatsappReminderAt && !p4.whatsappDayOfAt, "promoted row has no earlier WhatsApp stamps");
  ok((await api(`/api/staff/registrations/${p4.registrationId}/whatsapp-confirmed`, { method: "POST", jar: admin, body: { type: "confirm" } })).status === 200, "auto-promoted person can now be messaged");

  section("Server health");
  ok(serverErrors.length === 0, "no 5xx", serverErrors);
  console.log(`\nWaitlist WhatsApp E2E: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
