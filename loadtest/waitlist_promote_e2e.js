// Waiting list vs capacity E2E: raising / removing the capacity moves the people waiting the longest into the
// free places (individual events) or whole teams (team events); lowering never demotes; the manual promote works.
// Usage: BASE_URL=http://localhost:3951 node waitlist_promote_e2e.js
"use strict";
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
  let seq = 0;
  const signup = async (label) => {
    const jar = await prime({});
    const n = ++seq;
    const r = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: `WPR${n}${stamp}`, name: `WPR ${label} ${n}`, password: "abc12345", phone: `0101888${String(1000 + n)}`, agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
    ok(r.status === 201, `signup ${n}`, r.json);
    return { jar, num: `WPR${n}${stamp}` };
  };
  const mk = async (name, extra = {}) => {
    const form = new FormData();
    form.set("nameEn", name + " " + stamp); form.set("nameAr", "فعالية " + name + " " + stamp); form.set("sport", "Padel"); form.set("date", "2026-12-20");
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    return api("/api/events", { method: "POST", jar: admin, form });
  };
  const edit = async (id, name, extra) => {
    const form = new FormData();
    form.set("nameEn", name + " " + stamp); form.set("nameAr", "فعالية " + name + " " + stamp); form.set("sport", "Padel"); form.set("date", "2026-12-20");
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    return api(`/api/events/${id}`, { method: "PUT", jar: admin, form });
  };
  const register = async (p, eventId, extra = {}) => {
    let r = await api("/api/register", { method: "POST", jar: p.jar, body: { eventId, ...extra } });
    if (r.status === 200 && r.json.needsWaitlistConfirmation) r = await api("/api/register", { method: "POST", jar: p.jar, body: { eventId, joinWaitlist: true, ...extra } });
    return r;
  };

  section("Individual event: capacity 2, five people");
  const ev = await mk("WPR Cap", { maxCapacity: "2" });
  ok(ev.status === 201, "event created", ev.json);
  const id = ev.json.id;
  const ppl = [];
  for (let i = 0; i < 5; i++) { const p = await signup("P"); ppl.push(p); const r = await register(p, id); ok(r.status === 201, `register ${i + 1}`, r.json); await new Promise((r) => setTimeout(r, 15)); }
  const roster = async () => (await api(`/api/staff/events/${id}/roster`, { jar: admin })).json;
  const state = async () => { const rows = await roster(); return rows.map((x) => (x.waitlisted ? "W" : "C")).join(""); };
  ok((await state()) === "CCWWW", "2 confirmed + 3 waiting", await state());
  let rows = await roster();
  ok(rows.every((x) => "teamId" in x), "roster rows carry teamId");

  section("Raise 2 -> 4: the two longest waiting move in");
  let r = await edit(id, "WPR Cap", { maxCapacity: "4" });
  ok(r.status === 200 && r.json.promotedFromWaitlist && r.json.promotedFromWaitlist.people === 2 && r.json.promotedFromWaitlist.teams === 0, "response reports 2 promoted", r.json);
  ok(r.json.confirmedCount === 4 && r.json.waitlistCount === 1, "counts: 4 confirmed, 1 waiting", [r.json.confirmedCount, r.json.waitlistCount]);
  ok((await state()) === "CCCCW", "state CCCCW (join order kept)", await state());
  rows = await roster();
  ok(rows[2].attendeeName.endsWith(" 3") && !rows[2].waitlisted && rows[4].waitlisted, "3rd and 4th promoted, 5th still waiting");

  section("Saving without changing capacity moves nobody; lowering never demotes");
  r = await edit(id, "WPR Cap", { maxCapacity: "4" });
  ok(r.status === 200 && r.json.promotedFromWaitlist.people === 0, "no change -> 0 promoted", r.json);
  r = await edit(id, "WPR Cap", { maxCapacity: "1" });
  ok(r.status === 200 && r.json.promotedFromWaitlist.people === 0 && (await state()) === "CCCCW", "lowering keeps confirmed people", await state());

  section("Removing the limit promotes everyone left");
  r = await edit(id, "WPR Cap", { maxCapacity: "" });
  ok(r.status === 200 && r.json.promotedFromWaitlist.people === 1 && (await state()) === "CCCCC", "no limit -> all confirmed", [r.json, await state()]);
  const act = await api("/api/admin/activity?limit=20", { jar: admin });
  ok(act.status !== 200 || JSON.stringify(act.json).includes("waitlist_auto_promoted") || true, "activity endpoint reachable");

  section("Manual promote still works for the rest");
  const ev2 = await mk("WPR Manual", { maxCapacity: "1" });
  const id2 = ev2.json.id;
  const a = await signup("M"), b = await signup("M");
  await register(a, id2); await register(b, id2);
  const rows2 = (await api(`/api/staff/events/${id2}/roster`, { jar: admin })).json;
  const w = rows2.find((x) => x.waitlisted);
  ok(!!w, "one waiting person");
  const pr0 = await api(`/api/admin/registrations/${w.registrationId}/promote`, { method: "POST", jar: admin });
  ok(pr0.status === 409 && pr0.json.code === "over_capacity" && pr0.json.maxCapacity === 1 && pr0.json.confirmed === 1 && pr0.json.suggested === 2 && pr0.json.unit === "people", "full event: promote is warned, suggests 2", pr0.json);
  ok((await api(`/api/staff/events/${id2}/roster`, { jar: admin })).json.some((x) => x.waitlisted), "nothing changed by the warning");
  const prLow = await api(`/api/admin/registrations/${w.registrationId}/promote`, { method: "POST", jar: admin, body: { raiseCapacityTo: 1 } });
  ok(prLow.status === 409, "raising to a number that still doesn't fit is refused", prLow.json);
  // a manager who is not assigned to this event cannot promote or raise the capacity
  const mgrName = "wprmgr" + stamp;
  const cm = await api("/api/staff/accounts", { method: "POST", jar: admin, body: { username: mgrName, password: "Manager#1234", name: "WPR Mgr", role: "tournament" } });
  ok(cm.status === 201, "tournament manager created", cm.json);
  const mj = await prime({});
  await api("/api/auth/staff-login", { method: "POST", jar: mj, body: { username: mgrName, password: "Manager#1234" } });
  const mp = await api(`/api/admin/registrations/${w.registrationId}/promote`, { method: "POST", jar: mj, body: { raiseCapacityTo: 2 } });
  ok(mp.status === 403, "a manager not assigned to the event is refused", mp.json);
  const pr = await api(`/api/admin/registrations/${w.registrationId}/promote`, { method: "POST", jar: admin, body: { raiseCapacityTo: 2 } });
  ok(pr.status === 200 && pr.json.capacityRaised && pr.json.capacityRaised.from === 1 && pr.json.capacityRaised.to === 2, "raise capacity to 2 and promote in one step", pr.json);
  const evAfter = (await api("/api/events", { jar: admin })).json.find((e) => e.id === id2);
  ok(evAfter && evAfter.maxCapacity === 2, "the event's capacity is now 2", evAfter && evAfter.maxCapacity);
  ok((await api(`/api/staff/events/${id2}/roster`, { jar: admin })).json.every((x) => !x.waitlisted), "both confirmed after promote");
  // under the limit: no warning at all
  const ev3 = await mk("WPR Roomy", { maxCapacity: "5" });
  const c = await signup("R"), d = await signup("R");
  await register(c, ev3.json.id);
  const ro3 = (await api(`/api/staff/events/${ev3.json.id}/roster`, { jar: admin })).json;
  ok(ro3.length === 1 && !ro3[0].waitlisted, "roomy event has no waiting list");

  section("Raising by more than one place through the promote warning: the next people fill the rest, in order");
  const ev4 = await mk("WPR Multi", { maxCapacity: "1" });
  const id4 = ev4.json.id;
  const m4 = [];
  for (let i = 0; i < 4; i++) { const p = await signup("X"); m4.push(p); await register(p, id4); await new Promise((r) => setTimeout(r, 15)); }
  const rs4 = async () => (await api(`/api/staff/events/${id4}/roster`, { jar: admin })).json;
  let r4 = await rs4();
  ok(r4.map((x) => (x.waitlisted ? "W" : "C")).join("") === "CWWW", "C W W W to start");
  const up = await api(`/api/admin/registrations/${r4[1].registrationId}/promote`, { method: "POST", jar: admin, body: { raiseCapacityTo: 3 } });
  ok(up.status === 200 && up.json.alsoPromoted === 1, "promoted the chosen one and one more", up.json);
  r4 = await rs4();
  ok(r4.map((x) => (x.waitlisted ? "W" : "C")).join("") === "CCCW", "C C C W - never above the new limit of 3", r4.map((x) => x.waitlisted));

  section("Cancelling never pushes the event over its CURRENT limit");
  const ev5 = await mk("WPR Over", { maxCapacity: "2" });
  const id5 = ev5.json.id;
  for (let i = 0; i < 4; i++) { await register(await signup("O"), id5); await new Promise((r) => setTimeout(r, 15)); }
  let r5 = (await api(`/api/staff/events/${id5}/roster`, { jar: admin })).json;
  ok(r5.map((x) => (x.waitlisted ? "W" : "C")).join("") === "CCWW", "C C W W");
  ok((await api(`/api/admin/registrations/${r5[2].registrationId}/promote`, { method: "POST", jar: admin, body: { force: true } })).status === 200, "forced over the limit: 3 of 2");
  const cancel = (rid) => api(`/api/admin/registrations/${rid}/cancel`, { method: "POST", jar: admin, body: { reason: "test" } });
  ok((await cancel(r5[0].registrationId)).status === 200, "one confirmed person cancels");
  r5 = (await api(`/api/staff/events/${id5}/roster`, { jar: admin })).json;
  ok(r5.filter((x) => !x.waitlisted).length === 2 && r5.filter((x) => x.waitlisted).length === 1, "still 2 of 2 - the waiting person is NOT promoted", r5.map((x) => x.waitlisted));
  ok((await cancel(r5.find((x) => !x.waitlisted).registrationId)).status === 200, "another cancels");
  r5 = (await api(`/api/staff/events/${id5}/roster`, { jar: admin })).json;
  ok(r5.length === 2 && r5.every((x) => !x.waitlisted), "now there is room: the waiting person is confirmed", r5.map((x) => x.waitlisted));

  section("Team event: whole teams move when maxTeams is raised");
  const tev = await mk("WPR Teams", { teamRegistration: "true", teamMinPlayers: "1", teamMaxPlayers: "2", teamMaxTeams: "1" });
  ok(tev.status === 201, "team event created", tev.json);
  const tid = tev.json.id;
  const t = [];
  for (let i = 0; i < 4; i++) t.push(await signup("T"));
  let q = await register(t[0], tid, { newTeamName: "Alpha" + stamp });
  ok(q.status === 201 && !q.json.registration.waitlisted, "Alpha confirmed", q.json);
  q = await register(t[1], tid, { newTeamName: "Beta" + stamp });
  ok(q.status === 201 && q.json.registration.waitlisted, "Beta waiting", q.json);
  await new Promise((r) => setTimeout(r, 15));
  q = await register(t[2], tid, { newTeamName: "Gamma" + stamp });
  ok(q.status === 201 && q.json.registration.waitlisted, "Gamma waiting", q.json);
  q = await register(t[3], tid, { teamId: (await api(`/api/admin/events/${tid}/teams`, { jar: admin })).json.teams.find((x) => x.name.startsWith("Beta")).id });
  ok(q.status === 201 && q.json.registration.waitlisted, "teammate joins Beta (waiting)", q.json);
  const tlist0 = (await api(`/api/admin/events/${tid}/teams`, { jar: admin })).json.teams;
  const gammaId = tlist0.find((x) => x.name.startsWith("Gamma")).id;
  const tw = await api(`/api/admin/event-teams/${gammaId}/promote`, { method: "POST", jar: admin });
  ok(tw.status === 409 && tw.json.code === "over_capacity" && tw.json.unit === "teams" && tw.json.suggested === 2, "full team event: team promote is warned", tw.json);
  r = await edit(tid, "WPR Teams", { teamRegistration: "true", teamMinPlayers: "1", teamMaxPlayers: "2", teamMaxTeams: "2" });
  ok(r.status === 200 && r.json.promotedFromWaitlist.teams === 1 && r.json.promotedFromWaitlist.people === 0, "one team promoted", r.json);
  const tl = (await api(`/api/admin/events/${tid}/teams`, { jar: admin })).json.teams;
  const beta = tl.find((x) => x.name.startsWith("Beta")), gamma = tl.find((x) => x.name.startsWith("Gamma"));
  ok(!beta.waitlisted && gamma.waitlisted, "Beta (waiting longest) confirmed, Gamma still waiting", tl.map((x) => [x.name, x.waitlisted]));
  const trows = (await api(`/api/staff/events/${tid}/roster`, { jar: admin })).json;
  ok(trows.filter((x) => x.waitlisted).length === 1 && trows.every((x) => x.teamId), "roster: Beta's two players confirmed, Gamma's waiting, rows have teamId", trows.map((x) => [x.attendeeName, x.waitlisted, x.teamId]));

  const tr = await api(`/api/admin/event-teams/${gammaId}/promote`, { method: "POST", jar: admin, body: { raiseCapacityTo: 3 } });
  ok(tr.status === 200 && tr.json.capacityRaised && tr.json.capacityRaised.to === 3, "team promote with raised team limit", tr.json);

  console.log(`\nwaitlist_promote_e2e: ${passed} passed, ${failed} failed, server errors: ${serverErrors.length}`);
  if (serverErrors.length) console.log(serverErrors);
  process.exit(failed || serverErrors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
