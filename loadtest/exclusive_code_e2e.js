// Event code (mutually exclusive events) E2E - real HTTP API, throwaway server.
// Usage: BASE_URL=http://localhost:3947 node loadtest/exclusive_code_e2e.js
"use strict";
const BASE = process.env.BASE_URL || "http://localhost:3947";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ""); }
}
const section = (t) => console.log(`\n=== ${t} ===`);

const newJar = () => ({});
function applySetCookies(jar, res) {
  const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const raw of sc) { const [pair] = raw.split(";"); const eq = pair.indexOf("="); if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); }
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
async function api(path, { method = "GET", body, jar, isForm = false } = {}) {
  jar = jar || newJar();
  const headers = {};
  if (Object.keys(jar).length) headers.Cookie = cookieHeader(jar);
  if (!["GET", "HEAD"].includes(method) && jar.csrfToken) headers["X-CSRF-Token"] = jar.csrfToken;
  let fb;
  if (body !== undefined) { if (isForm) fb = body; else { headers["Content-Type"] = "application/json"; fb = JSON.stringify(body); } }
  const res = await fetch(BASE + path, { method, headers, body: fb, redirect: "manual" });
  applySetCookies(jar, res);
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, jar };
}
const prime = async () => { const jar = newJar(); await api("/api/settings", { jar }); return jar; };
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
const yearsAgoDate = (y) => `${new Date().getFullYear() - y}-06-15`;

async function main() {
  const admin = await prime();
  let r = await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } });
  ok(r.status === 200, "admin login", r.json);

  async function mkEvent(jar, name, extra = {}, method = "POST", id = "") {
    const f = new FormData();
    f.set("nameEn", `${name} ${RUN}`); f.set("nameAr", `${name} ${RUN}`); f.set("sport", "Tennis"); f.set("date", "2026-12-20");
    for (const [k, v] of Object.entries(extra)) f.set(k, String(v));
    return api(`/api/events${id ? "/" + id : ""}`, { method, jar, body: f, isForm: true });
  }
  async function signup(tag) {
    const jar = await prime();
    const res = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: `XC${RUN}${tag}`, name: `Exclusive ${tag}`, password: "abc12345", phone: `0120${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`, agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
    ok(res.status === 201, `signup ${tag}`, res.json);
    return { jar, mn: `XC${RUN}${tag}` };
  }

  section("Create events with a code (normalised) and check visibility");
  r = await mkEvent(admin, "Amateurs Cup", { exclusiveCode: " tennis   cup " });
  ok(r.status === 201 || r.status === 200, "create Amateurs", r.json);
  const A = r.json.id;
  ok(r.json.eventCode === "TENNIS CUP", "code trimmed/upper-cased/collapsed for the admin", r.json.eventCode);
  r = await mkEvent(admin, "Professionals Cup", { exclusiveCode: "TENNIS CUP" });
  const B = r.json.id;
  r = await mkEvent(admin, "Open Day (no code)");
  const C = r.json.id;
  r = await mkEvent(admin, "Padel Cup", { exclusiveCode: "PADEL" });
  const D = r.json.id;
  r = await mkEvent(admin, "Too long", { exclusiveCode: "X".repeat(31) });
  ok(r.status === 400, "code over 30 characters refused", r.status);

  r = await api("/api/events", { jar: admin });
  ok(r.json.find((e) => e.id === A).eventCode === "TENNIS CUP", "admin list shows the code");
  ok(!JSON.stringify(r.json).includes("exclusiveCode"), "raw field never serialised");
  r = await api("/api/events");
  ok(r.json.every((e) => e.eventCode === undefined) && !JSON.stringify(r.json).includes("TENNIS CUP"), "anonymous never sees the code");
  const m1 = await signup("1");
  r = await api("/api/events", { jar: m1.jar });
  ok(!JSON.stringify(r.json).includes("TENNIS CUP"), "member never sees the code");

  section("Tournament manager cannot set or see the code");
  r = await api("/api/staff/accounts", { method: "POST", jar: admin, body: { username: `tm${RUN}`, password: "Tm!Pass2026xyz", role: "tournament", name: "TM" } });
  ok(r.status === 201 || r.status === 200, "create tournament manager", r.json);
  const tm = await prime();
  r = await api("/api/auth/staff-login", { method: "POST", jar: tm, body: { username: `tm${RUN}`, password: "Tm!Pass2026xyz" } });
  ok(r.status === 200, "manager login");
  r = await mkEvent(tm, "Manager Event", { exclusiveCode: "TENNIS CUP" });
  ok(r.status === 403, "a manager cannot create events", r.status);
  // admin creates an event the manager runs; the manager then edits it
  r = await mkEvent(admin, "Manager Event", { managerUsernames: JSON.stringify([`tm${RUN}`]), exclusiveCode: "MGR" });
  const M = r.json.id;
  r = await mkEvent(tm, "Manager Event Renamed", { exclusiveCode: "TENNIS CUP" }, "PUT", M);
  ok(r.status === 200, "manager edits their own event", r.json);
  ok(r.json.eventCode === undefined, "manager response has no code");
  r = await api("/api/events", { jar: admin });
  ok(r.json.find((e) => e.id === M).eventCode === "MGR", "manager's attempt to change the code is ignored");
  r = await api("/api/events", { jar: tm });
  ok(!JSON.stringify(r.json).includes("TENNIS CUP"), "manager list never shows codes");

  section("Registration: one event per code");
  r = await api("/api/register", { method: "POST", jar: m1.jar, body: { eventId: A } });
  ok(r.status === 201, "register Amateurs", r.json);
  const regA = r.json.registration.id;
  r = await api("/api/register", { method: "POST", jar: m1.jar, body: { eventId: B } });
  ok(r.status === 409 && r.json.code === "exclusive_event", "Professionals refused for the same person", r.json);
  ok(r.json.otherEventNameEn && r.json.otherEventNameEn.includes("Amateurs"), "message names the event already joined", r.json);
  ok(!JSON.stringify(r.json).includes("TENNIS CUP"), "refusal does not reveal the code");
  r = await api("/api/register", { method: "POST", jar: m1.jar, body: { eventId: C } });
  ok(r.status === 201, "event without a code is unaffected");
  r = await api("/api/register", { method: "POST", jar: m1.jar, body: { eventId: D } });
  ok(r.status === 201, "event with a different code is unaffected");
  const m2 = await signup("2");
  r = await api("/api/register", { method: "POST", jar: m2.jar, body: { eventId: B } });
  ok(r.status === 201, "another person can take Professionals");
  r = await api("/api/me/registrations", { jar: m1.jar });
  ok(!JSON.stringify(r.json).includes("TENNIS CUP"), "my-registrations never exposes the code");

  section("Switching: cancel, then register the other");
  r = await api(`/api/me/registrations/${regA}`, { method: "DELETE", jar: m1.jar });
  ok(r.status === 200, "cancel Amateurs", r.json);
  r = await api("/api/register", { method: "POST", jar: m1.jar, body: { eventId: B } });
  ok(r.status === 201, "now Professionals is allowed", r.json);
  r = await api("/api/register", { method: "POST", jar: m1.jar, body: { eventId: A } });
  ok(r.status === 409 && r.json.code === "exclusive_event", "and Amateurs is now blocked");

  section("Family members are separate people");
  const m3 = await signup("3");
  r = await api("/api/me/dependents", { method: "POST", jar: m3.jar, body: { name: "XC Kid", relationship: "Son", birthDate: yearsAgoDate(12) } });
  ok(r.status === 201, "add family member", r.json);
  const kid = r.json.dependents[0].id;
  r = await api("/api/register", { method: "POST", jar: m3.jar, body: { eventId: A } });
  ok(r.status === 201, "parent registers Amateurs");
  r = await api("/api/register", { method: "POST", jar: m3.jar, body: { eventId: B, dependentId: kid } });
  ok(r.status === 201, "child may take the other event (different person)", r.json);
  r = await api("/api/register", { method: "POST", jar: m3.jar, body: { eventId: A, dependentId: kid } });
  ok(r.status === 409 && r.json.code === "exclusive_event", "child cannot take both", r.json);
  ok(r.json.attendeeName === "XC Kid", "refusal names the child", r.json);

  section("Waiting list counts as registered");
  r = await mkEvent(admin, "Tiny Amateurs", { exclusiveCode: "SMALL", maxCapacity: 1 });
  const S1 = r.json.id;
  r = await mkEvent(admin, "Tiny Pros", { exclusiveCode: "SMALL" });
  const S2 = r.json.id;
  const m4 = await signup("4"), m5 = await signup("5");
  r = await api("/api/register", { method: "POST", jar: m4.jar, body: { eventId: S1 } });
  ok(r.status === 201, "first player takes the only place");
  r = await api("/api/register", { method: "POST", jar: m5.jar, body: { eventId: S1, joinWaitlist: true } });
  ok(r.status === 201 && r.json.waitlisted === true, "second joins the waiting list", r.json);
  r = await api("/api/register", { method: "POST", jar: m5.jar, body: { eventId: S2 } });
  ok(r.status === 409 && r.json.code === "exclusive_event", "waiting-list player cannot also join the other event", r.json);

  section("Admin invite skips people already in the other event");
  r = await api(`/api/admin/events/${A}/invite`, { method: "POST", jar: admin, body: { membershipNumbers: [m1.mn, m2.mn] } });
  ok(r.status === 200, "invite call", r.json);
  ok(r.json.invited.length === 0 && r.json.skipped.length === 2, "both already hold the other event", r.json);
  ok(r.json.skipped.every((s) => /same event code/.test(s.reason)), "reason mentions the event code", r.json.skipped);
  const m6 = await signup("6");
  r = await api(`/api/admin/events/${A}/invite`, { method: "POST", jar: admin, body: { membershipNumbers: [m6.mn] } });
  ok(r.json.invited.length === 1, "a free player is invited normally", r.json);

  section("Editing the code");
  r = await mkEvent(admin, "Amateurs Cup", {}, "PUT", A);
  ok(r.status === 200 && r.json.eventCode === "TENNIS CUP", "saving without a code field keeps it", r.json);
  r = await mkEvent(admin, "Amateurs Cup", { exclusiveCode: "" }, "PUT", B);
  ok(r.status === 200 && r.json.eventCode === "", "admin can clear a code", r.json);
  r = await api("/api/register", { method: "POST", jar: m1.jar, body: { eventId: A } });
  ok(r.status === 201, "after clearing, the same person can join both", r.json);
  r = await mkEvent(admin, "Professionals Cup", { exclusiveCode: "tennis cup" }, "PUT", B);
  ok(r.status === 200 && r.json.exclusiveOverlap >= 1, "re-adding the code reports people already in both", r.json.exclusiveOverlap);
  r = await mkEvent(admin, "Professionals Cup", { exclusiveCode: "TENNIS CUP", maxCapacity: "x" }, "PUT", B);
  ok(r.status === 400, "bad edit refused");

  section("Static pages");
  for (const f of ["/index.html", "/i18n.js", "/league.js"]) {
    const res = await fetch(BASE + f);
    ok(res.status === 200, `GET ${f}`);
    if (f === "/index.html") { const html = await res.text(); ok(html.includes('id="ev-code"') && html.includes('id="ev-edit-code"'), "both event forms have the code field"); }
  }

  console.log(`\nEvent code E2E: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(2); });
