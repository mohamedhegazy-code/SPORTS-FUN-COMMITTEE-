// Duplicate-event protection + merge tool E2E.
// Usage: BASE_URL=http://localhost:3917 node event_merge_e2e.js
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
  const form = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
  const create = (o) => api("/api/events", { method: "POST", jar: admin, form: form(o) });

  section("Duplicate guard on event creation");
  const d1 = dayOffset(10);
  let r = await create({ nameEn: "Chess Dup " + stamp, nameAr: "شطرنج " + stamp, sport: "Chess", date: d1 });
  ok(r.status === 201, "first event created", r.json);
  const firstId = r.json.id;
  r = await create({ nameEn: "Chess Dup " + stamp, sport: "Chess", date: d1 });
  ok(r.status === 409 && r.json.code === "duplicate_event" && r.json.duplicate.id === firstId, "same name + date -> 409 with the existing event", r.json);
  r = await create({ nameEn: "  chess   DUP " + stamp, sport: "Chess", date: d1 });
  ok(r.status === 409, "case/space differences still caught");
  r = await create({ nameEn: "Another name " + stamp, nameAr: "شطرنج " + stamp, sport: "Chess", date: d1 });
  ok(r.status === 409, "same Arabic name + date caught");
  r = await create({ nameEn: "Chess Dup " + stamp, sport: "Chess", date: dayOffset(11) });
  ok(r.status === 201, "same name, different date is fine", r.json);
  r = await create({ nameEn: "Chess Dup " + stamp, sport: "Chess", date: d1, allowDuplicate: "true" });
  ok(r.status === 201, "allowDuplicate=true creates it anyway", r.json);

  section("Fixtures for merging");
  const people = [];
  for (let i = 1; i <= 7; i++) {
    const jar = await prime({});
    const num = `MG${i}${stamp}`;
    const s = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: num, name: `Merge Person ${i}`, password: "abc12345", phone: `0101777${String(1000 + i)}`, agreeTerms: true, memberType: "main", birthDate: "1990-01-01" } });
    ok(s.status === 201, `signup ${i}`, s.json);
    people.push({ jar, num });
  }
  const A = (await create({ nameEn: "Merge Source " + stamp, sport: "Chess", date: dayOffset(20), maxCapacity: "4" })).json.id;
  const B = (await create({ nameEn: "Merge Target " + stamp, sport: "Chess", date: dayOffset(20), maxCapacity: "3" })).json.id;
  const reg = async (p, eventId) => {
    let x = await api("/api/register", { method: "POST", jar: p.jar, body: { eventId } });
    if (x.status === 200 && x.json.needsWaitlistConfirmation) x = await api("/api/register", { method: "POST", jar: p.jar, body: { eventId, joinWaitlist: true } });
    ok(x.status === 201, "register", x.json);
  };
  // A: p1..p4 confirmed, p5,p6 waiting. B: p2 and p7 confirmed.
  for (let i = 0; i < 6; i++) await reg(people[i], A);
  await reg(people[1], B); await reg(people[6], B);
  const roster = async (id) => (await api(`/api/staff/events/${id}/roster`, { jar: admin })).json;
  const nameRow = (rows, n) => rows.find((x) => x.attendeeName === n);
  let rA = await roster(A);
  ok(rA.filter((x) => x.waitlisted).length === 2, "A has 2 waiting", rA.length);
  ok((await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: nameRow(rA, "Merge Person 1").registrationId } })).status === 200, "check in person 1 (in A)");
  ok((await api(`/api/staff/registrations/${nameRow(rA, "Merge Person 3").registrationId}/whatsapp-confirmed`, { method: "POST", jar: admin, body: { type: "confirm" } })).status === 200, "person 3 got a WhatsApp confirmation stamp");

  section("Validation and permissions");
  ok((await api(`/api/admin/events/${A}/move-registrations`, { method: "POST", jar: admin, body: { toEventId: A } })).status === 400, "same event -> 400");
  ok((await api(`/api/admin/events/${A}/move-registrations`, { method: "POST", jar: admin, body: { toEventId: 999999 } })).status === 404, "unknown target -> 404");
  ok((await api(`/api/admin/events/999999/move-registrations`, { method: "POST", jar: admin, body: { toEventId: B } })).status === 404, "unknown source -> 404");
  const tmu = "tmm" + stamp;
  await api("/api/staff/accounts", { method: "POST", jar: admin, body: { username: tmu, password: "Manager#1234", name: "TM", role: "tournament" } });
  const tm = await prime({});
  await api("/api/auth/staff-login", { method: "POST", jar: tm, body: { username: tmu, password: "Manager#1234" } });
  ok((await api(`/api/admin/events/${A}/move-registrations`, { method: "POST", jar: tm, body: { toEventId: B } })).status === 403, "tournament manager refused");
  ok((await api(`/api/admin/events/${A}/move-registrations`, { method: "POST", jar: people[0].jar, body: { toEventId: B } })).status === 401, "member refused");
  const parent = (await create({ nameEn: "Merge Day " + stamp, sport: "Day", date: dayOffset(30) })).json.id;
  await create({ nameEn: "Merge Activity " + stamp, sport: "Day", date: dayOffset(30), parentEventId: String(parent) });
  ok((await api(`/api/admin/events/${parent}/move-registrations`, { method: "POST", jar: admin, body: { toEventId: B } })).status === 400, "event day with activities can't be merged");

  section("Preview changes nothing");
  const before = JSON.stringify([await roster(A), await roster(B)]);
  const pv = await api(`/api/admin/events/${A}/move-registrations`, { method: "POST", jar: admin, body: { toEventId: B, dryRun: true } });
  ok(pv.status === 200 && pv.json.dryRun === true, "preview ok", pv.json);
  ok(pv.json.total === 6 && pv.json.moved === 5 && pv.json.conflicts === 1, "5 move, 1 conflict (person 2 already in target)", pv.json);
  ok(pv.json.movedConfirmed === 1 && pv.json.movedWaitlisted === 4 && pv.json.demotedToWaitlist === 2, "1 confirmed (checked-in) fits; 2 confirmed demoted; 2 already waiting", pv.json);
  ok(pv.json.conflictList[0].name === "Merge Person 2", "conflict names the person", pv.json.conflictList);
  ok(JSON.stringify([await roster(A), await roster(B)]) === before, "preview left everything untouched");

  section("Real merge");
  const mv = await api(`/api/admin/events/${A}/move-registrations`, { method: "POST", jar: admin, body: { toEventId: B, deleteSourceWhenEmpty: true } });
  ok(mv.status === 200 && mv.json.moved === 5 && mv.json.remainingInSource === 1 && mv.json.sourceDeleted === false, "merged; the conflicting registration stays so the source is kept", mv.json);
  const rB = await roster(B);
  const st = (n) => { const x = nameRow(rB, n); return x ? (x.waitlisted ? "wait" : "conf") : "missing"; };
  ok(st("Merge Person 1") === "conf" && nameRow(rB, "Merge Person 1").checkedIn, "checked-in person keeps confirmed + checked-in");
  ok(st("Merge Person 3") === "wait" && st("Merge Person 4") === "wait" && st("Merge Person 5") === "wait" && st("Merge Person 6") === "wait", "others are on the waiting list", rB.map((x) => [x.attendeeName, x.waitlisted]));
  ok(st("Merge Person 2") === "conf" && st("Merge Person 7") === "conf", "people already in the target are untouched");
  ok(!nameRow(rB, "Merge Person 3").whatsappConfirmedAt, "demoted person's WhatsApp stamp cleared");
  ok((await roster(A)).length === 1, "source keeps only the conflicting registration");
  // waiting-list order preserved: cancel a confirmed spot -> person 3 (earliest) is promoted
  const cancel = await api(`/api/admin/registrations/${nameRow(rB, "Merge Person 7").registrationId}/cancel`, { method: "POST", jar: admin, body: { reason: "test cancellation" } });
  ok(cancel.status === 200, "cancel a confirmed spot in the target", cancel.json);
  const rB2 = await roster(B);
  ok(!nameRow(rB2, "Merge Person 3").waitlisted && nameRow(rB2, "Merge Person 4").waitlisted, "original waiting order kept: person 3 is promoted first");
  // moved registration is fully usable: manual check-in on a moved person works
  ok((await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: nameRow(rB2, "Merge Person 3").registrationId } })).status === 200, "moved registration can be checked in");

  section("Clean merge deletes the source");
  const C = (await create({ nameEn: "Clean Source " + stamp, sport: "Chess", date: dayOffset(40) })).json.id;
  const D = (await create({ nameEn: "Clean Target " + stamp, sport: "Chess", date: dayOffset(40) })).json.id;
  await reg(people[0], C); await reg(people[1], C);
  const mv2 = await api(`/api/admin/events/${C}/move-registrations`, { method: "POST", jar: admin, body: { toEventId: D, deleteSourceWhenEmpty: true } });
  ok(mv2.status === 200 && mv2.json.moved === 2 && mv2.json.sourceDeleted === true && mv2.json.remainingInSource === 0, "all moved and the empty source deleted", mv2.json);
  const evs = (await api("/api/events", { jar: admin })).json;
  ok(!evs.some((e) => e.id === C) && evs.some((e) => e.id === D), "source gone from the events list, target kept");
  ok((await roster(D)).length === 2, "target holds both registrations");
  // member sees the registration under the surviving event
  const mine = await api("/api/me/registrations", { jar: people[0].jar });
  ok(mine.status === 200 && JSON.stringify(mine.json).includes(String(D)), "member sees the registration under the kept event");

  section("Who created an event (admin only)");
  const adminEvs = (await api("/api/events", { jar: admin })).json;
  const dupA = adminEvs.filter((e) => e.nameEn === "Chess Dup " + stamp && e.date === d1).sort((a, b) => a.id - b.id);
  ok(dupA.length === 2 && dupA.every((e) => e.createdByName === "Committee Admin" && e.createdByUsername === ADMIN_USER && e.createdAtIso), "admin sees creator + time on both same-named events", dupA.map((e) => [e.id, e.createdByName]));
  const pubEvs = (await api("/api/events", { jar: await prime({}) })).json;
  ok(pubEvs.every((e) => e.createdBy === undefined && e.createdByName === undefined && e.createdByUsername === undefined && e.createdAt === undefined && e.createdAtIso === undefined), "public list never exposes the creator");
  const tmEvs = (await api("/api/events", { jar: tm })).json;
  ok(tmEvs.every((e) => e.createdByName === undefined && e.createdBy === undefined), "non-admin staff don't see the creator either");

  section("Audit log");
  const log = JSON.stringify((await api("/api/admin/activity-log?limit=200", { jar: admin })).json);
  ok(/events_merged/.test(log), "merge recorded in the activity log");

  console.log(`\nserver errors: ${serverErrors.length}`, serverErrors);
  ok(serverErrors.length === 0, "no 5xx");
  console.log(`\nEvent merge E2E: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
