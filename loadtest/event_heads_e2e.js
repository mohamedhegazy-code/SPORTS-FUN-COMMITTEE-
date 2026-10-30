// Who may create events: the admin, or event heads (Tournament Managers) the
// admin authorised. Co-heads are chosen by the admin only.
// Usage: BASE_URL=http://localhost:3917 node event_heads_e2e.js
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
const form = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
(async () => {
  const stamp = Date.now().toString(36);
  const admin = await prime({});
  ok((await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } })).status === 200, "admin login");
  const mkStaff = async (name, extra = {}) => {
    const username = name + stamp;
    const r = await api("/api/staff/accounts", { method: "POST", jar: admin, body: { username, password: "Manager#1234", name, role: "tournament", ...extra } });
    ok(r.status === 201, "create " + name, r.json);
    const jar = await prime({});
    ok((await api("/api/auth/staff-login", { method: "POST", jar, body: { username, password: "Manager#1234" } })).status === 200, name + " login");
    return { username, jar, account: r.json.staff };
  };

  section("Defaults");
  const plain = await mkStaff("plain");
  const head1 = await mkStaff("head1", { canCreateEvents: true });
  const head2 = await mkStaff("head2");
  ok(plain.account.canCreateEvents === false, "a new Tournament Manager can NOT create events by default", plain.account);
  ok(head1.account.canCreateEvents === true, "admin can authorise at account creation", head1.account);

  section("Who can create");
  let r = await api("/api/events", { method: "POST", jar: plain.jar, form: form({ nameEn: "Plain try " + stamp, nameAr: "x", sport: "Padel", date: "2027-01-10" }) });
  ok(r.status === 403, "unauthorised manager -> 403", r.json);
  const before = (await api("/api/events", { jar: admin })).json.length;
  ok(before === 0 || !(await api("/api/events", { jar: admin })).json.some((e) => e.nameEn === "Plain try " + stamp), "nothing was created");
  r = await api("/api/events", { method: "POST", jar: head1.jar, form: form({ nameEn: "Head1 Event " + stamp, nameAr: "ح1", sport: "Padel", date: "2027-01-11" }) });
  ok(r.status === 201 && JSON.stringify(r.json.managerUsernames) === JSON.stringify([head1.username]), "authorised head creates and automatically manages it", r.json);
  const evH1 = r.json.id;
  r = await api("/api/events", { method: "POST", jar: admin, form: form({ nameEn: "Admin Event " + stamp, nameAr: "أ", sport: "Padel", date: "2027-01-12", managerUsernames: JSON.stringify([head1.username, head2.username]) }) });
  ok(r.status === 201 && r.json.managerUsernames.length === 2, "admin creates with several heads at once", r.json);
  const evAdmin = r.json.id;
  ok((await api("/api/events", { method: "POST", jar: await prime({}), form: form({ nameEn: "Anon", sport: "x", date: "2027-01-13" }) })).status === 401, "anonymous -> 401");

  section("Admin switches the permission");
  ok((await api(`/api/staff/accounts/${plain.username}/can-create-events`, { method: "PUT", jar: admin, body: { value: true } })).json.canCreateEvents === true, "admin authorises plain");
  r = await api("/api/events", { method: "POST", jar: plain.jar, form: form({ nameEn: "Plain now " + stamp, nameAr: "ب", sport: "Padel", date: "2027-01-14" }) });
  ok(r.status === 201, "now allowed", r.json);
  await api(`/api/staff/accounts/${plain.username}/can-create-events`, { method: "PUT", jar: admin, body: { value: false } });
  r = await api("/api/events", { method: "POST", jar: plain.jar, form: form({ nameEn: "Plain again " + stamp, nameAr: "ج", sport: "Padel", date: "2027-01-15" }) });
  ok(r.status === 403, "withdrawn -> 403 again");
  ok((await api(`/api/staff/accounts/${plain.username}/can-create-events`, { method: "PUT", jar: head1.jar, body: { value: true } })).status === 403, "a head can't change permissions");
  ok((await api(`/api/staff/accounts/${ADMIN_USER}/can-create-events`, { method: "PUT", jar: admin, body: { value: true } })).status === 400, "only Tournament Manager accounts take the setting");
  ok((await api(`/api/staff/accounts/nobody/can-create-events`, { method: "PUT", jar: admin, body: { value: true } })).status === 404, "unknown account -> 404");
  const listed = (await api("/api/staff/accounts", { jar: admin })).json;
  ok(listed.find((s) => s.username === head1.username).canCreateEvents === true && listed.find((s) => s.username === plain.username).canCreateEvents === false, "staff list shows the flag");

  section("Co-heads: admin only");
  ok((await api(`/api/admin/events/${evH1}/managers`, { method: "PUT", jar: head1.jar, body: { managerUsernames: [head1.username, head2.username] } })).status === 403, "a head can't add co-heads");
  r = await api(`/api/admin/events/${evH1}/managers`, { method: "PUT", jar: admin, body: { managerUsernames: [head1.username, head2.username] } });
  ok(r.status === 200 && r.json.managerUsernames.length === 2, "admin adds a second head", r.json);
  r = await api(`/api/events/${evH1}`, { method: "PUT", jar: head1.jar, form: form({ nameEn: "Head1 Event " + stamp, date: "2027-01-11", managerUsernames: JSON.stringify([head1.username]) }) });
  const evAfter = (await api("/api/events", { jar: admin })).json.find((e) => e.id === evH1);
  ok(evAfter.managerUsernames.length === 2, "editing the event as a head does not change the head list", evAfter.managerUsernames);
  const asHead2 = (await api("/api/events", { jar: head2.jar })).json;
  ok(asHead2.find((e) => e.id === evH1).managedByMe === true && asHead2.find((e) => e.id === evAdmin).managedByMe === true, "second head manages both events");

  section("Activities under an event day");
  const day = (await api("/api/events", { method: "POST", jar: admin, form: form({ nameEn: "Day " + stamp, nameAr: "ي", sport: "Day", date: "2027-02-01" }) })).json.id;
  r = await api("/api/events", { method: "POST", jar: head1.jar, form: form({ nameEn: "Act " + stamp, nameAr: "ن", sport: "Day", date: "2027-02-01", parentEventId: String(day) }) });
  ok(r.status === 403, "a head can't add an activity under a day they don't manage", r.json);
  await api(`/api/admin/events/${day}/managers`, { method: "PUT", jar: admin, body: { managerUsernames: [head1.username] } });
  r = await api("/api/events", { method: "POST", jar: head1.jar, form: form({ nameEn: "Act " + stamp, nameAr: "ن", sport: "Day", date: "2027-02-01", parentEventId: String(day) }) });
  ok(r.status === 201, "…but can once the admin made them its head", r.json);

  section("Audit");
  ok(/staff\.can_create_events_set/.test(JSON.stringify((await api("/api/admin/activity-log?limit=300", { jar: admin })).json)), "permission changes are logged");

  console.log(`\nserver errors: ${serverErrors.length}`, serverErrors);
  ok(serverErrors.length === 0, "no 5xx");
  console.log(`\nEvent heads E2E: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
