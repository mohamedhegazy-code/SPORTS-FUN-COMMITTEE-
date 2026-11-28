"use strict";
// Run the tournament from the Check-in screen + per-event attendance-confirmation switch.
// API checks (roles, defaults, check-in-driven players, locking at the draw, team mode) and a
// Playwright pass over the Check-in screen (panel, switch, Run button, Arabic, gate-staff view).
// Usage (fresh server, empty data dir): BASE_URL=http://localhost:3951 node loadtest/checkin_run_e2e.js
const { chromium } = require("/opt/node-tools/node_modules/playwright");
const BASE = process.env.BASE_URL || "http://localhost:3951";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) pass++; else { fail++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };
const section = (s) => console.log("\n=== " + s + " ===");

function applySetCookies(jar, res) {
  const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const raw of sc) { const [pair] = raw.split(";"); const i = pair.indexOf("="); if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
}
async function api(path, { method = "GET", body, jar = {}, form } = {}) {
  const headers = {};
  const ck = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (ck) headers.Cookie = ck;
  if (method !== "GET" && jar.csrfToken) headers["X-CSRF-Token"] = jar.csrfToken;
  let b;
  if (form) b = form; else if (body !== undefined) { headers["Content-Type"] = "application/json"; b = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: b, redirect: "manual" });
  applySetCookies(jar, res);
  let json = null; try { json = await res.json(); } catch (e) { /* none */ }
  return { status: res.status, json };
}
const prime = async (jar) => { await api("/", { jar }); return jar; };
const mkForm = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
const stamp = Date.now().toString(36);

(async () => {
  const admin = await prime({});
  ok((await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } })).status === 200, "admin login");
  const mkStaff = async (name, role) => {
    const username = name + stamp;
    const r = await api("/api/staff/accounts", { method: "POST", jar: admin, body: { username, password: "Manager#1234", name, role } });
    ok(r.status === 201, "create " + name, r.json);
    const jar = await prime({});
    ok((await api("/api/auth/staff-login", { method: "POST", jar, body: { username, password: "Manager#1234" } })).status === 200, name + " login");
    return { username, jar };
  };
  const mgr = await mkStaff("mgr", "tournament");
  const other = await mkStaff("other", "tournament");
  const gate = await mkStaff("gate", "staff");

  const mkEvent = async (nameEn) => {
    const r = await api("/api/events", { method: "POST", jar: admin, form: mkForm({ nameEn, nameAr: nameEn, sport: "Chess", date: today }) });
    ok(r.status === 201 || r.status === 200, "create event " + nameEn, r.json);
    return r.json.id;
  };
  const members = [];
  for (let i = 1; i <= 8; i++) {
    const jar = await prime({});
    const r = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: `CR${stamp}${i}`, name: `CheckinRun ${i}`, password: "abc12345", phone: `0100${String(i).padStart(7, "0")}`, agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
    ok(r.status === 200 || r.status === 201, "signup " + i, r.json);
    members.push(jar);
  }
  const registerAll = async (eventId, n) => {
    const ids = [];
    for (let i = 0; i < n; i++) {
      const r = await api("/api/register", { method: "POST", jar: members[i], body: { eventId } });
      ok(r.status === 200 || r.status === 201, "register " + (i + 1), r.json);
      ids.push((r.json.registration && r.json.registration.id) || r.json.id);
    }
    return ids;
  };
  const checkin = (regId) => api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: regId } });

  // ============================================================== A. attendance switch
  section("A. Attendance confirmation switch");
  const evA = await mkEvent("CR Attendance " + stamp);
  await api(`/api/admin/events/${evA}/managers`, { method: "PUT", jar: admin, body: { managerUsernames: [mgr.username] } });
  const regA = await registerAll(evA, 3);
  let list = (await api("/api/events", { jar: admin })).json;
  ok(!list.find((e) => e.id === evA).attendanceConfirmEnabled, "off by default");
  let r = await api(`/api/staff/registrations/${regA[0]}/attendance-confirmation`, { method: "POST", jar: admin, body: { status: "yes" } });
  ok(r.status === 409 && r.json.code === "attendance_confirmation_off", "answering is refused while off", r.json);
  r = await api(`/api/staff/events/${evA}/attendance-confirmation-setting`, { method: "PUT", jar: gate.jar, body: { enabled: true } });
  ok(r.status === 403, "gate staff cannot switch it", r.status);
  r = await api(`/api/staff/events/${evA}/attendance-confirmation-setting`, { method: "PUT", jar: other.jar, body: { enabled: true } });
  ok(r.status === 403, "a manager of another event cannot switch it", r.status);
  r = await api(`/api/staff/events/${evA}/attendance-confirmation-setting`, { method: "PUT", jar: mgr.jar, body: { enabled: true } });
  ok(r.status === 200 && r.json.attendanceConfirmEnabled === true, "the event's Tournament Manager switches it on", r.json);
  list = (await api("/api/events", { jar: admin })).json;
  ok(list.find((e) => e.id === evA).attendanceConfirmEnabled === true, "events list shows it on");
  r = await api(`/api/staff/registrations/${regA[0]}/attendance-confirmation`, { method: "POST", jar: admin, body: { status: "yes" } });
  ok(r.status === 200, "answering works while on", r.json);
  r = await api(`/api/staff/events/${evA}/attendance-confirmation-setting`, { method: "PUT", jar: admin, body: { enabled: false } });
  ok(r.status === 200 && r.json.attendanceConfirmEnabled === false, "admin switches it off", r.json);
  r = await api(`/api/staff/registrations/${regA[1]}/attendance-confirmation`, { method: "POST", jar: admin, body: { status: "no" } });
  ok(r.status === 409, "refused again once off", r.status);
  await api(`/api/staff/events/${evA}/attendance-confirmation-setting`, { method: "PUT", jar: admin, body: { enabled: true } });
  let roster = (await api(`/api/staff/events/${evA}/roster`, { jar: admin })).json;
  ok(roster.find((x) => x.registrationId === regA[0]).attendanceConfirm === "yes", "earlier answer kept after off and on");
  const other2 = await mkEvent("CR Other " + stamp);
  list = (await api("/api/events", { jar: admin })).json;
  ok(!list.find((e) => e.id === other2).attendanceConfirmEnabled, "another event is unaffected");

  // ============================================================== B. check-in mode (individual)
  section("B. Only checked-in players play (individual knockout)");
  const evB = await mkEvent("CR Run " + stamp);
  await api(`/api/admin/events/${evB}/managers`, { method: "PUT", jar: admin, body: { managerUsernames: [mgr.username] } });
  const regB = await registerAll(evB, 8);
  r = await api(`/api/admin/tournaments/${evB}/checkin-summary`, { jar: admin });
  ok(r.status === 200 && r.json.exists === false, "summary: no tournament yet", r.json);
  r = await api(`/api/admin/tournaments/${evB}`, { method: "POST", jar: admin, body: { mode: "individual", format: "knockout", courts: 2, matchMinutes: 10, startTime: "09:00", winPoints: 3, drawPoints: 1, lossPoints: 0 } });
  ok(r.status === 201, "create tournament", r.json);
  r = await api(`/api/admin/tournaments/${evB}/checkin-summary`, { jar: mgr.jar });
  ok(r.status === 200 && r.json.exists && !r.json.fromCheckin && r.json.checkin.registered === 8 && r.json.checkin.checkedIn === 0 && !r.json.generated, "summary: 8 registered, none in, mode off", r.json);
  r = await api(`/api/admin/tournaments/${evB}/checkin-summary`, { jar: gate.jar });
  ok(r.status === 403, "gate staff cannot read the tournament panel data", r.status);
  r = await api(`/api/admin/tournaments/${evB}/checkin-summary`, { jar: other.jar });
  ok(r.status === 403, "an unrelated manager cannot either", r.status);
  r = await api(`/api/admin/tournaments/${evB}/checkin-mode`, { method: "PUT", jar: gate.jar, body: { enabled: true } });
  ok(r.status === 403, "gate staff cannot switch the mode", r.status);
  r = await api(`/api/admin/tournaments/${evB}/checkin-mode`, { method: "PUT", jar: mgr.jar, body: { enabled: true } });
  ok(r.status === 200 && r.json.tournament.fromCheckin === true && r.json.tournament.entrants.length === 0, "manager switches the mode on; nobody checked in yet", r.json && r.json.tournament && r.json.tournament.entrants);
  r = await api(`/api/admin/tournaments/${evB}/generate`, { method: "POST", jar: admin });
  ok(r.status === 400 && /checked-in/i.test(r.json.error || ""), "cannot draw with nobody checked in", r.json);
  for (let i = 0; i < 5; i++) ok((await checkin(regB[i])).status === 200, "check in " + (i + 1));
  r = await api(`/api/admin/tournaments/${evB}`, { jar: admin });
  ok(r.json.tournament.entrants.length === 5, "5 checked in = 5 entrants", r.json.tournament.entrants.length);
  ok(r.json.tournament.attendance.length === 5 && r.json.tournament.attendance.every((a) => a.status === "present"), "attendance comes from check-in (all present)");
  r = await api(`/api/admin/tournaments/${evB}/attendance`, { method: "PUT", jar: admin, body: { registrationId: regB[0], status: "absent" } });
  ok(r.status === 409 && r.json.code === "attendance_from_checkin", "the tournament's own Present/Absent is read-only in this mode", r.json);
  r = await api(`/api/admin/tournaments/${evB}/checkin-summary`, { jar: admin });
  ok(r.json.checkin.checkedIn === 5 && r.json.fromCheckin === true, "summary: 5 in, mode on", r.json);
  r = await api(`/api/admin/tournaments/${evB}/generate`, { method: "POST", jar: admin });
  ok(r.status === 200, "draw is made", r.json);
  const rounds0 = r.json.tournament.knockout.rounds[0];
  ok(rounds0.length * 2 === 8 && rounds0.filter((m) => m.bye).length === 3, "bracket of 8 with 3 byes for 5 players", { size: rounds0.length * 2, byes: rounds0.filter((m) => m.bye).length });
  const names = new Set(r.json.tournament.entrants.map((e) => e.label));
  ok(names.size === 5 && !names.has("CheckinRun 8"), "the three who were not checked in are left out");
  r = await api(`/api/admin/tournaments/${evB}/checkin-summary`, { jar: admin });
  ok(r.json.generated === true && r.json.checkin.locked === true, "summary: locked at the draw", r.json);
  ok((await checkin(regB[5])).status === 200, "a latecomer checks in after the draw");
  r = await api("/api/checkin/undo", { method: "POST", jar: admin, body: { registrationId: regB[0] } });
  ok(r.status === 200, "gate undoes one drawn player's check-in", r.json);
  r = await api(`/api/admin/tournaments/${evB}`, { jar: admin });
  ok(r.json.tournament.entrants.length === 5, "entrants unchanged after the draw (late check-in / undo do nothing)", r.json.tournament.entrants.length);
  const undone = r.json.tournament.attendance.find((a) => a.registrationId === regB[0]);
  ok(undone && undone.status === "absent", "the undone player shows absent", undone);
  r = await api(`/api/admin/tournaments/${evB}/checkin-mode`, { method: "PUT", jar: admin, body: { enabled: false } });
  ok(r.status === 409 && r.json.code === "already_generated", "mode cannot change after the draw", r.json);
  r = await api(`/api/admin/tournaments/${evB}/reseed`, { method: "POST", jar: admin });
  ok(r.status === 200, "reseed (nothing played yet)", r.json);
  r = await api(`/api/admin/tournaments/${evB}`, { jar: admin });
  ok(r.json.tournament.entrants.length === 5, "after reseed the list is live again (5 in now: 4 + the latecomer)", r.json.tournament.entrants.length);
  r = await api(`/api/admin/tournaments/${evB}/checkin-mode`, { method: "PUT", jar: admin, body: { enabled: false } });
  ok(r.status === 200 && r.json.tournament.entrants.length === 8 && r.json.tournament.fromCheckin === false, "switched off: all 8 registered play again", r.json.tournament && r.json.tournament.entrants.length);
  r = await api(`/api/admin/tournaments/${evB}/attendance`, { method: "PUT", jar: admin, body: { registrationId: regB[0], status: "absent" } });
  ok(r.status === 200, "Present/Absent works again when the mode is off", r.status);

  // ============================================================== C. team mode
  section("C. Team mode needs every member checked in");
  const evC = await mkEvent("CR Teams " + stamp);
  const regC = await registerAll(evC, 4);
  r = await api(`/api/admin/tournaments/${evC}`, { method: "POST", jar: admin, body: { mode: "team", format: "knockout", courts: 2, matchMinutes: 10, startTime: "09:00" } });
  ok(r.status === 201, "create team tournament", r.json);
  r = await api(`/api/admin/tournaments/${evC}/teams`, { method: "PUT", jar: admin, body: { teams: [{ name: "Red", memberIds: [regC[0], regC[1]] }, { name: "Blue", memberIds: [regC[2], regC[3]] }] } });
  ok(r.status === 200, "two teams of two", r.json);
  await api(`/api/admin/tournaments/${evC}/checkin-mode`, { method: "PUT", jar: admin, body: { enabled: true } });
  await checkin(regC[0]); await checkin(regC[1]); await checkin(regC[2]);
  r = await api(`/api/admin/tournaments/${evC}/checkin-summary`, { jar: admin });
  ok(r.json.checkin.teamsTotal === 2 && r.json.checkin.teamsReady === 1 && r.json.checkin.checkedIn === 3, "summary: 1 of 2 teams complete", r.json.checkin);
  r = await api(`/api/admin/tournaments/${evC}`, { jar: admin });
  ok(r.json.tournament.entrants.length === 1 && r.json.tournament.entrants[0].label === "Red", "only the complete team is in", r.json.tournament.entrants.map((e) => e.label));
  await checkin(regC[3]);
  r = await api(`/api/admin/tournaments/${evC}`, { jar: admin });
  ok(r.json.tournament.entrants.length === 2, "both teams in once the last member arrives");
  r = await api(`/api/admin/tournaments/${evC}/generate`, { method: "POST", jar: admin });
  ok(r.status === 200, "team draw is made", r.json);

  // ============================================================== D. screen
  section("D. Check-in screen");
  const evD = await mkEvent("CR Screen " + stamp);
  await api(`/api/admin/events/${evD}/managers`, { method: "PUT", jar: admin, body: { managerUsernames: [mgr.username] } });
  const regD = await registerAll(evD, 4);
  r = await api(`/api/admin/tournaments/${evD}`, { method: "POST", jar: admin, body: { mode: "individual", format: "knockout", courts: 2, matchMinutes: 10, startTime: "09:00" } });
  ok(r.status === 201, "create tournament for the screen test");
  await checkin(regD[0]);

  const browser = await chromium.launch();
  async function openScan(user, pw) {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
    const page = await ctx.newPage(); const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await page.goto(BASE + "/"); await page.waitForTimeout(600);
    await page.click('[data-view="scan"]');
    const inputs = await page.locator("#scan-lock input").all();
    await inputs[0].fill(user); await inputs[1].fill(pw);
    await page.click("#scan-unlock"); await page.waitForTimeout(1300);
    await page.selectOption("#checkin-event-select", String(evD)); await page.waitForTimeout(1200);
    return { ctx, page, errs };
  }
  {
    const { ctx, page, errs } = await openScan(ADMIN_USER, ADMIN_PASS);
    const panel = page.locator("#checkin-tourn-panel");
    ok(await panel.isVisible(), "admin sees the Tournament panel");
    ok(/1 of 4 checked in/.test(await panel.innerText()), "panel shows the live count", await panel.innerText());
    ok(await page.locator("#checkin-roster-wrap [data-att-conf]").count() === 0, "no Will attend / Won't attend buttons by default");
    ok(await page.locator("#checkin-roster-wrap thead").innerText().then((x) => !/Attendance confirmation/.test(x)), "no attendance-confirmation column by default");
    ok(await page.locator('#checkin-roster-wrap [data-roster-filter="noreply"]').count() === 0, "no Confirmed / No answer / Declined chips by default");
    await page.locator("#checkin-roster-wrap [data-att-switch]").click(); await page.waitForTimeout(1000);
    ok(await page.locator("#checkin-roster-wrap [data-att-conf]").count() === 6, "switch on: buttons appear for the 3 not checked in (2 each)", await page.locator("#checkin-roster-wrap [data-att-conf]").count());
    ok(await page.locator('#checkin-roster-wrap [data-roster-filter="noreply"]').count() === 1, "switch on: filter chips appear");
    await page.screenshot({ path: "/tmp/checkin_run_en.png", fullPage: true });
    await page.locator("#checkin-roster-wrap [data-att-switch]").click(); await page.waitForTimeout(1000);
    ok(await page.locator("#checkin-roster-wrap [data-att-conf]").count() === 0, "switch off again hides them");
    // tournament mode switch
    await panel.locator("[data-ci-mode]").click(); await page.waitForTimeout(1000);
    ok(await panel.locator("[data-ci-mode]").isChecked(), "Only checked-in players play is on");
    // check someone in from the list -> panel count updates
    await page.locator("#checkin-roster-wrap [data-checkin-reg]").first().click(); await page.waitForTimeout(1200);
    ok(/2 of 4 checked in/.test(await panel.innerText()), "count follows a new check-in", await panel.innerText());
    // Run
    await panel.locator("[data-ci-run]").click(); await page.waitForTimeout(2000);
    ok(await page.locator("#view-admin.active").count() === 1, "Run opens the Admin area");
    ok(await page.locator('.admin-tab[data-admin-tab="tournaments"].active').count() === 1, "on the Tournaments tab");
    const body = await page.locator("#tourn-body").innerText();
    ok(/CR Screen/i.test(await page.locator("#tourn-event-select option:checked").innerText()), "the event is selected");
    ok(body.length > 50 && !/error/i.test(body.slice(0, 40)), "the tournament screen loaded", body.slice(0, 120));
    ok(/gate check-in|check-in/i.test(body), "the Attendance card says players come from the check-in", body.slice(0, 200));
    await page.waitForTimeout(1200);
    const top = await page.evaluate(() => document.getElementById("tourn-manage-card").getBoundingClientRect().top);
    ok(top < 300, "the tournament card is scrolled into view", top);
    await page.screenshot({ path: "/tmp/checkin_run_tournament.png", fullPage: false });
    // Arabic
    await page.click('[data-view="scan"]'); await page.waitForTimeout(800);
    await page.evaluate(() => setLang("ar")); await page.waitForTimeout(800);
    const pt = await page.locator("#checkin-tourn-panel").innerText();
    ok(pt.includes("تشغيل البطولة") && pt.includes("يلعب من سجّل حضوره فقط"), "panel in Arabic", pt);
    await page.screenshot({ path: "/tmp/checkin_run_ar.png", fullPage: true });
    ok(errs.length === 0, "no page errors (admin)", errs);
    await ctx.close();
  }
  {
    const { ctx, page, errs } = await openScan(mgr.username, "Manager#1234");
    ok(await page.locator("#checkin-tourn-panel").isVisible(), "the event's Tournament Manager sees the panel");
    ok(await page.locator("#checkin-roster-wrap [data-att-switch]").count() === 1, "and the attendance switch");
    ok(errs.length === 0, "no page errors (manager)", errs);
    await ctx.close();
  }
  {
    const { ctx, page, errs } = await openScan(gate.username, "Manager#1234");
    ok(!(await page.locator("#checkin-tourn-panel").isVisible()), "gate staff do not see the Tournament panel");
    ok(await page.locator("#checkin-roster-wrap [data-att-switch]").count() === 0, "gate staff do not see the attendance switch");
    await page.evaluate(() => document.querySelector('#checkin-roster-wrap [data-roster-filter="all"]').click()); await page.waitForTimeout(300); // the first-login password modal sits on top for a new staff account
    ok(await page.locator("#checkin-roster-wrap tbody tr").count() === 4, "gate staff still see the whole list (All chip)");
    ok(errs.length === 0, "no page errors (gate)", errs);
    await ctx.close();
  }
  await browser.close();
  console.log(`\npassed ${pass} failed ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
