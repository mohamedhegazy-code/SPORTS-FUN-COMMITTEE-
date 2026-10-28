// Admin > Reports tab E2E: the event list endpoint, the three printable event
// sheets (registrations / attendance / points) in both languages, role guards,
// HTML escaping, empty/past/waitlist events, and the Swiss tournament sheets
// the tab links to.
// Usage: BASE_URL=http://localhost:3914 node reports_e2e.js
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
const bd = (years) => new Date(Date.now() - (years * 365.25 + 40) * 86400000).toISOString().slice(0, 10); // a date that is exactly `years` old (40-day buffer from a birthday edge)
const BDG = { under12: bd(8), "12to17": bd(14), "18to45": bd(30), "46plus": bd(60) };
async function member(i, name, ageGroup) {
  const jar = await prime(newJar());
  const r = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: `RP${i}`, name, password: "abc12345", phone: `0106${String(i).padStart(7, "0")}`, agreeTerms: true, memberType: "main", birthDate: BDG[ageGroup || "18to45"] } });
  if (r.status !== 200 && r.status !== 201) throw new Error("signup failed " + JSON.stringify(r.json));
  const m = { jar, num: `RP${i}`, name, regs: {} };
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

(async () => {
  const lg = await api("/api/auth/staff-login", { method: "POST", jar: await prime(admin), body: { username: ADMIN_USER, password: ADMIN_PASS } });
  ok(lg.status === 200, "admin login", lg.json);

  // ---------------------------------------------------------------- fixtures
  section("Fixtures");
  const XSS = `<script>alert(1)</script> & "Q'`;
  const evChess = await mkEvent("Reports Chess Cup", "كأس التقارير للشطرنج");
  const evPast = await mkEvent("Reports Past Event", "فعالية سابقة للتقارير", { date: "2025-01-10" });
  const evEmpty = await mkEvent("Reports Empty Event", "فعالية فارغة", { date: "2026-11-01" });
  const evSmall = await mkEvent("Reports Small Capacity", "سعة صغيرة", { date: "2026-11-20", max: 2 });
  const names = ["Amr Hassan", XSS, "محمد الأهلاوي", "Zeinab Ali", "Omar Said", "Laila Fathy", "Youssef Adel", "Nour Samir"];
  for (let i = 0; i < names.length; i++) await member(i + 1, names[i]);
  for (const m of members) await register(m, evChess);
  for (let i = 0; i < 6; i++) await checkin(members[i], evChess);
  for (let i = 0; i < 3; i++) await register(members[i], evPast);
  await checkin(members[0], evPast);
  const smallRegs = [];
  for (let i = 0; i < 4; i++) smallRegs.push(await register(members[i], evSmall));
  ok(smallRegs.filter((r) => r && r.waitlisted).length === 2, "capacity 2 -> two waitlisted", smallRegs);
  const cr = await A(`/api/admin/tournaments/${evChess}`, "POST", { mode: "individual", format: "swiss", swissRounds: 3 });
  ok(cr.status === 200 || cr.status === 201, "create swiss tournament", cr.json);

  // -------------------------------------------------------------- list endpoint
  section("GET /api/admin/reports/events");
  let r = await A("/api/admin/reports/events");
  ok(r.status === 200 && Array.isArray(r.json), "admin gets the list", r.status);
  const list = r.json || [];
  const byId = Object.fromEntries(list.map((e) => [e.eventId, e]));
  for (const id of [evChess, evPast, evEmpty, evSmall]) ok(!!byId[id], `event ${id} listed (past + future)`);
  ok(list.map((e) => e.date).join() === list.map((e) => e.date).slice().sort().reverse().join(), "sorted newest first");
  ok(byId[evChess].confirmedCount === 8 && byId[evChess].checkedInCount === 6 && byId[evChess].waitlistCount === 0, "chess counts", byId[evChess]);
  ok(byId[evPast].confirmedCount === 3 && byId[evPast].checkedInCount === 1, "past event counts", byId[evPast]);
  ok(byId[evSmall].confirmedCount === 2 && byId[evSmall].waitlistCount === 2, "waitlist counted separately", byId[evSmall]);
  ok(byId[evEmpty].confirmedCount === 0 && byId[evEmpty].tournament === null && byId[evEmpty].swiss === null, "empty event", byId[evEmpty]);
  ok(byId[evChess].tournament && byId[evChess].tournament.format === "swiss" && byId[evChess].swiss && byId[evChess].swiss.totalRounds === 3 && byId[evChess].swiss.generatedRounds === 0, "swiss not drawn yet", byId[evChess]);
  const gen = await A(`/api/admin/tournaments/${evChess}/generate`, "POST");
  ok(gen.status === 200, "generate round 1", gen.json);
  r = await A("/api/admin/reports/events");
  const chess2 = (r.json || []).find((e) => e.eventId === evChess);
  ok(chess2 && chess2.swiss.generatedRounds === 1 && chess2.tournament.generated === true, "list reflects drawn round", chess2);

  // ------------------------------------------------------------------ roles
  section("Role matrix");
  const roles = {};
  for (const role of ["staff", "management", "tournament"]) {
    const username = `rp_${role}`;
    const cr2 = await A("/api/staff/accounts", "POST", { username, password: "Role!Pass2026xyz", role, name: role });
    ok(cr2.status === 200 || cr2.status === 201, `create ${role}`, cr2.json);
    const jar = await prime(newJar());
    const l = await api("/api/auth/staff-login", { method: "POST", jar, body: { username, password: "Role!Pass2026xyz" } });
    ok(l.status === 200, `${role} login`, l.json);
    roles[role] = jar;
  }
  // ---------------------------------------------------- event managers scope
  section("Event managers: a Tournament Manager only sees assigned events (7-day window)");
  {
    const tm = roles.tournament;
    const tmUser = "rp_tournament";
    const unassigned = [
      ["GET", `/api/staff/events/${evChess}/roster`],
      ["GET", `/admin/print/event/${evChess}?view=registrations`],
      ["GET", `/api/admin/tournaments/${evChess}`],
      ["GET", `/api/admin/events/${evChess}/waitlist`],
    ];
    for (const [m, p] of unassigned) {
      const rr = await api(p, { method: m, jar: tm, raw: !p.startsWith("/api") });
      ok(rr.status === 403, `unassigned manager blocked: ${p}`, rr.status);
    }
    const listBefore = await api("/api/admin/reports/events", { jar: tm });
    ok(listBefore.status === 200 && listBefore.json.length === 0, "unassigned manager: reports list empty", listBefore.json);
    const dashBefore = await api("/api/admin/dashboard", { jar: tm });
    ok(dashBefore.status === 200 && dashBefore.json.length === 0, "unassigned manager: dashboard empty", dashBefore.json);
    // assign (garbage + non-manager usernames are ignored)
    const asg = await A(`/api/admin/events/${evChess}/managers`, "PUT", { managerUsernames: [tmUser, "rp_staff", "nobody", tmUser] });
    ok(asg.status === 200 && asg.json.managerUsernames.length === 1 && asg.json.managerUsernames[0] === tmUser, "only real Tournament Manager accounts are kept", asg.json);
    const asgTm = await api(`/api/admin/events/${evChess}/managers`, { method: "PUT", jar: tm, body: { managerUsernames: [tmUser] } });
    ok(asgTm.status === 403, "a Tournament Manager cannot assign managers", asgTm.status);
    const rosterOk = await api(`/api/staff/events/${evChess}/roster`, { jar: tm });
    ok(rosterOk.status === 200 && rosterOk.json.length > 0, "assigned manager can open the roster", rosterOk.status);
    const regId = rosterOk.json[0].registrationId;
    const waOk = await api(`/api/staff/registrations/${regId}/whatsapp-confirmed`, { method: "POST", jar: tm, body: { type: "reminder" } });
    ok(waOk.status === 200, "assigned manager can send WhatsApp", waOk.status);
    const printOk = await api(`/admin/print/event/${evChess}?view=registrations`, { jar: tm, raw: true });
    ok(printOk.status === 200, "assigned manager can print the sheet", printOk.status);
    const listAfter = await api("/api/admin/reports/events", { jar: tm });
    ok(listAfter.json.length === 1 && listAfter.json[0].eventId === evChess, "reports list shows only the assigned event", listAfter.json.map((e) => e.eventId));
    // another event stays closed
    const other = await api(`/api/staff/events/${evEmpty}/roster`, { jar: tm });
    ok(other.status === 403, "other events stay blocked", other.status);
    const manualOther = await api(`/api/checkin/manual`, { method: "POST", jar: tm, body: { registrationId: 999999 } });
    ok(manualOther.status === 404, "unknown registration still 404", manualOther.status);
    // public list hides managers, admin sees them, manager sees the flag
    const pub = await api("/api/events", { jar: await prime(newJar()) });
    ok(pub.json.every((e) => e.managerUsernames === undefined && e.managedByMe === undefined), "public events list exposes no manager data");
    const adm = await api("/api/events", { jar: admin });
    ok(adm.json.find((e) => e.id === evChess).managerUsernames.includes(tmUser), "admin sees the managers of an event");
    const tmEv = await api("/api/events", { jar: tm });
    ok(tmEv.json.find((e) => e.id === evChess).managedByMe === true && tmEv.json.find((e) => e.id === evEmpty).managedByMe === false && tmEv.json.every((e) => e.managerUsernames === undefined), "manager sees managedByMe only", tmEv.json.map((e) => e.managedByMe));
    // gate staff are not event-scoped
    const gate = await api(`/api/staff/events/${evEmpty}/roster`, { jar: roles.staff });
    ok(gate.status === 200, "gate staff are not event-scoped", gate.status);
    // 7-day window: events that ended 8 days ago close, 6 days ago stay open
    const dayStr = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const mk = async (name, date, extra = {}) => {
      const fd = new FormData();
      fd.set("nameEn", name); fd.set("nameAr", name); fd.set("sport", "Chess"); fd.set("date", date);
      for (const [k, v] of Object.entries(extra)) fd.set(k, v);
      const r = await api("/api/events", { method: "POST", jar: admin, body: fd, isForm: true });
      return r.json;
    };
    const evOld = await mk("Window closed", dayStr(-8), { managerUsernames: JSON.stringify([tmUser]) });
    const evRecent = await mk("Window open", dayStr(-6), { managerUsernames: JSON.stringify([tmUser]) });
    const evMulti = await mk("Multi-day ends recently", dayStr(-20), { endDate: dayStr(-7), managerUsernames: JSON.stringify([tmUser]) });
    const evMultiOld = await mk("Multi-day closed", dayStr(-20), { endDate: dayStr(-8), managerUsernames: JSON.stringify([tmUser]) });
    const wOld = await api(`/api/staff/events/${evOld.id}/roster`, { jar: tm });
    ok(wOld.status === 403 && /7 days/.test(wOld.json.error || ""), "access closes 8 days after the event", wOld);
    const wRecent = await api(`/api/staff/events/${evRecent.id}/roster`, { jar: tm });
    ok(wRecent.status === 200, "access still open 6 days after the event", wRecent.status);
    const wMulti = await api(`/api/staff/events/${evMulti.id}/roster`, { jar: tm });
    ok(wMulti.status === 200, "multi-day event: window counts from the END date (open)", wMulti.status);
    const wMultiOld = await api(`/api/staff/events/${evMultiOld.id}/roster`, { jar: tm });
    ok(wMultiOld.status === 403, "multi-day event: closed 8 days after the END date", wMultiOld.status);
    const wOldAdmin = await api(`/api/staff/events/${evOld.id}/roster`, { jar: admin });
    ok(wOldAdmin.status === 200, "admin keeps access to old events", wOldAdmin.status);
    const listWin = await api("/api/admin/reports/events", { jar: tm });
    const ids = listWin.json.map((e) => e.eventId);
    ok(ids.includes(evRecent.id) && !ids.includes(evOld.id), "reports list drops the event after the window", ids);
    // a manager creating an event becomes its manager; cannot reassign; cannot edit others'
    const fdNew = new FormData();
    fdNew.set("nameEn", "Made by TM"); fdNew.set("nameAr", "x"); fdNew.set("sport", "Chess"); fdNew.set("date", dayStr(10)); fdNew.set("managerUsernames", JSON.stringify([]));
    const made = await api("/api/events", { method: "POST", jar: tm, body: fdNew, isForm: true });
    ok(made.status === 201 && made.json.managerUsernames.length === 1 && made.json.managerUsernames[0] === tmUser, "TM-created event is auto-assigned to its creator", made.json);
    const fdEdit = new FormData();
    fdEdit.set("nameEn", "Made by TM v2"); fdEdit.set("nameAr", "x"); fdEdit.set("sport", "Chess"); fdEdit.set("date", dayStr(10)); fdEdit.set("managerUsernames", JSON.stringify([]));
    const edited = await api(`/api/events/${made.json.id}`, { method: "PUT", jar: tm, body: fdEdit, isForm: true });
    const admView = await api("/api/events", { jar: admin });
    ok(edited.status === 200 && admView.json.find((e) => e.id === made.json.id).managerUsernames.includes(tmUser), "TM cannot clear managers through the edit form", edited.status);
    const fdForeign = new FormData();
    fdForeign.set("nameEn", "Hijack"); fdForeign.set("nameAr", "x"); fdForeign.set("sport", "Chess"); fdForeign.set("date", dayStr(10));
    const foreign = await api(`/api/events/${evEmpty}`, { method: "PUT", jar: tm, body: fdForeign, isForm: true });
    ok(foreign.status === 403, "TM cannot edit an event they do not manage", foreign.status);
    // admin edit form sets managers; omitting the field keeps them
    const fdA = new FormData();
    fdA.set("nameEn", "Made by TM v3"); fdA.set("nameAr", "x"); fdA.set("sport", "Chess"); fdA.set("date", dayStr(10));
    const keep = await api(`/api/events/${made.json.id}`, { method: "PUT", jar: admin, body: fdA, isForm: true });
    ok(keep.status === 200 && keep.json.managerUsernames.includes(tmUser), "admin edit without the field keeps managers", keep.json);
    fdA.set("managerUsernames", JSON.stringify([]));
    const clear = await api(`/api/events/${made.json.id}`, { method: "PUT", jar: admin, body: fdA, isForm: true });
    ok(clear.status === 200 && clear.json.managerUsernames.length === 0, "admin can clear managers", clear.json);
    // parent manager also covers the activities under it
    const parent = await mk("Parent day", dayStr(5), { managerUsernames: JSON.stringify([tmUser]) });
    const child = await mk("Child activity", dayStr(5), { parentEventId: String(parent.id) });
    const wChild = await api(`/api/staff/events/${child.id}/roster`, { jar: tm });
    ok(wChild.status === 200, "manager of the parent event also covers its activities", wChild.status);
  }

  const anon = await prime(newJar());
  const memberJar = members[0].jar;
  const paths = ["/api/admin/reports/events", `/admin/print/event/${evChess}?view=registrations`, `/admin/print/event/${evChess}?view=attendance`, `/admin/print/event/${evChess}?view=points`];
  for (const p of paths) {
    const isApi = p.startsWith("/api");
    const rA = await api(p, { jar: anon, raw: !isApi });
    ok(rA.status === 401, `anon blocked ${p}`, rA.status);
    const rM = await api(p, { jar: memberJar, raw: !isApi });
    ok(rM.status === 401 || rM.status === 403, `member blocked ${p}`, rM.status);
    for (const role of ["staff", "management"]) {
      const rr = await api(p, { jar: roles[role], raw: !isApi });
      ok(rr.status === 403, `${role} blocked ${p}`, rr.status);
    }
    const rT = await api(p, { jar: roles.tournament, raw: !isApi });
    const isPoints = p.includes("view=points");
    ok(rT.status === (isPoints ? 403 : 200), isPoints ? `tournament role blocked from the Points sheet ${p}` : `tournament role allowed ${p}`, rT.status);
    const rAd = await api(p, { jar: admin, raw: !isApi });
    ok(rAd.status === 200, `admin allowed ${p}`, rAd.status);
  }

  // ---------------------------------------------- tournament manager privacy
  section("Tournament Manager: no points sheet, no mobile numbers");
  const phoneOf = members[0].num.replace("RP", "");
  const myPhone = `0106${String(Number(phoneOf)).padStart(7, "0")}`;
  for (const lang of ["en", "ar"]) {
    for (const view of ["registrations", "attendance"]) {
      const tH = (await api(`/admin/print/event/${evChess}?view=${view}&lang=${lang}`, { jar: roles.tournament, raw: true })).text;
      const aH = (await api(`/admin/print/event/${evChess}?view=${view}&lang=${lang}`, { jar: admin, raw: true })).text;
      ok(!tH.includes(myPhone) && !/0106\d{7}/.test(tH), `tournament ${view}/${lang}: no mobile numbers`);
      ok(!tH.includes(lang === "ar" ? "الهاتف" : ">Phone<"), `tournament ${view}/${lang}: no phone column header`);
      ok(aH.includes(myPhone) && aH.includes(lang === "ar" ? "الهاتف" : ">Phone<"), `admin ${view}/${lang}: phone column still shown`);
      ok(tH.includes("Amr Hassan") || tH.includes("عمرو"), `tournament ${view}/${lang}: names still listed`);
    }
  }
  const tPts = await api(`/admin/print/event/${evChess}?view=points&lang=en`, { jar: roles.tournament, raw: true });
  ok(tPts.status === 403 && !/Total points/.test(tPts.text), "tournament role: points sheet refused", tPts.status);
  const aPts = await api(`/admin/print/event/${evChess}?view=points&lang=en`, { jar: admin, raw: true });
  ok(aPts.status === 200 && /Total points awarded/.test(aPts.text), "admin: points sheet still works", aPts.status);
  const rosterT = await api(`/api/staff/events/${evChess}/roster`, { jar: roles.tournament });
  ok(rosterT.status === 200 && rosterT.json.length > 0 && rosterT.json.every((x) => x.phone === ""), "tournament role: roster API sends no phone numbers", rosterT.json && rosterT.json.slice(0, 2));
  const rosterA = await api(`/api/staff/events/${evChess}/roster`, { jar: admin });
  ok(rosterA.status === 200 && rosterA.json.some((x) => x.phone), "admin: roster API still has phone numbers");
  const rosterS = await api(`/api/staff/events/${evChess}/roster`, { jar: roles.staff });
  ok(rosterS.status === 200 && rosterS.json.some((x) => x.phone), "gate staff: roster API still has phone numbers");
  ok(rosterT.json.every((x) => x.hasPhone === true), "tournament role: roster says a number exists (hasPhone) without sending it");
  const waT = await api(`/api/staff/registrations/${rosterA.json[0].registrationId}/whatsapp-confirmed`, { method: "POST", jar: roles.tournament });
  ok(waT.status === 200 && /^0106\d{7}$/.test(waT.json.phone || ""), "tournament role: can send WhatsApp (number returned only at send time)", waT.json);
  const rosterT2 = await api(`/api/staff/events/${evChess}/roster`, { jar: roles.tournament });
  ok(rosterT2.json.find((x) => x.registrationId === rosterA.json[0].registrationId).whatsappConfirmedAt, "WhatsApp-sent status recorded for the Tournament Manager");
  // Separate message types: confirmation / 3-day reminder / event-day attendance check, each with its own sent status
  const rid0 = rosterA.json[0].registrationId;
  const waRem = await api(`/api/staff/registrations/${rid0}/whatsapp-confirmed`, { method: "POST", jar: roles.tournament, body: { type: "reminder" } });
  ok(waRem.status === 200 && waRem.json.whatsappReminderAt && /^0106\d{7}$/.test(waRem.json.phone || ""), "WhatsApp type=reminder recorded (TM gets number only at send time)", waRem.json);
  const waDay = await api(`/api/staff/registrations/${rid0}/whatsapp-confirmed`, { method: "POST", jar: admin, body: { type: "dayof" } });
  ok(waDay.status === 200 && waDay.json.whatsappDayOfAt, "WhatsApp type=dayof recorded", waDay.json);
  const waBad = await api(`/api/staff/registrations/${rid0}/whatsapp-confirmed`, { method: "POST", jar: admin, body: { type: "spam" } });
  ok(waBad.status === 400, "WhatsApp unknown type rejected (400)", waBad.status);
  const rosterT3 = await api(`/api/staff/events/${evChess}/roster`, { jar: roles.tournament });
  const row0 = rosterT3.json.find((x) => x.registrationId === rid0);
  ok(row0.whatsappConfirmedAt && row0.whatsappReminderAt && row0.whatsappDayOfAt, "roster returns all three WhatsApp sent timestamps", row0);
  const row1 = rosterT3.json.find((x) => x.registrationId !== rid0);
  ok(!row1 || (!row1.whatsappReminderAt && !row1.whatsappDayOfAt), "other registrations untouched by reminder/dayof", row1);
  const waS = await api(`/api/staff/registrations/${rosterA.json[0].registrationId}/whatsapp-confirmed`, { method: "POST", jar: roles.staff });
  ok(waS.status === 200 && waS.json.phone === undefined, "gate staff: send works and no phone echoed back", waS.json);

  // ------------------------------------------------------------ print sheets
  section("Printable sheets");
  const norm = (h) => h.replace(/\s+/g, " ");
  for (const lang of ["en", "ar"]) {
    for (const view of ["registrations", "attendance", "points"]) {
      const res = await getHtml(`/admin/print/event/${evChess}?view=${view}&lang=${lang}`);
      const h = res.text;
      const tag = `${view}/${lang}`;
      ok(res.status === 200 && /text\/html/.test(res.type), `${tag}: 200 html`, [res.status, res.type]);
      ok(h.includes(`dir="${lang === "ar" ? "rtl" : "ltr"}"`) && h.includes(`lang="${lang}"`), `${tag}: direction + lang`);
      ok(lang === "ar" ? h.includes("كأس التقارير للشطرنج") : h.includes("Reports Chess Cup"), `${tag}: event title in the right language`);
      ok(h.includes('id="print-btn"') && h.includes('/print.js'), `${tag}: print button wired`);
      ok(!h.includes("<script>alert(1)</script>"), `${tag}: no raw script injection`);
      ok(h.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Q&#39;"), `${tag}: hostile name escaped`);
      ok(!/<script(?![^>]*src=)/.test(h), `${tag}: no inline scripts (CSP-safe)`);
      ok(h.includes("Amr Hassan") && h.includes("محمد الأهلاوي"), `${tag}: lists players`);
    }
  }
  // registrations: waitlist + status
  let res = await getHtml(`/admin/print/event/${evSmall}?view=registrations&lang=en`);
  ok((res.text.match(/class="tag wait"/g) || []).length === 2, "registrations: 2 waitlist tags", res.text.match(/class="tag wait"/g));
  ok(/<tr class="wait">/.test(res.text), "registrations: waitlist rows styled");
  ok(/Waiting list<\/div><div class="v">2</.test(norm(res.text)) || /Waiting list<\/div> ?<div class="v">2</.test(norm(res.text)), "registrations: waiting-list stat = 2");
  // attendance: confirmed only, check marks, signature column
  res = await getHtml(`/admin/print/event/${evChess}?view=attendance&lang=en`);
  ok((res.text.match(/class="sig"/g) || []).length === 8, "attendance: one signature box per confirmed player", (res.text.match(/class="sig"/g) || []).length);
  ok((res.text.match(/✓/g) || []).length === 6, "attendance: 6 check marks", (res.text.match(/✓/g) || []).length);
  res = await getHtml(`/admin/print/event/${evSmall}?view=attendance&lang=en`);
  ok((res.text.match(/class="sig"/g) || []).length === 2, "attendance: waitlisted players excluded", (res.text.match(/class="sig"/g) || []).length);
  // points: checked-in only, total = sum of rows
  res = await getHtml(`/admin/print/event/${evChess}?view=points&lang=en`);
  const cells = [...res.text.matchAll(/<td class="num"><b>(\d+)<\/b><\/td>/g)].map((m) => Number(m[1]));
  const total = Number((res.text.match(/class="total"><td colspan="8">[^<]*<\/td><td class="num">(\d+)<\/td>/) || [])[1]);
  ok(cells.length === 6, "points: 6 rows (checked-in only)", cells);
  ok(cells.every((n) => n >= 100), "points: each at least the participation award", cells);
  ok(total === cells.reduce((a, b) => a + b, 0) && total > 0, "points: total equals the sum of the rows", [total, cells]);
  res = await getHtml(`/admin/print/event/${evEmpty}?view=points&lang=en`);
  ok(/Nobody has been checked in/.test(res.text), "points: empty message");

  // ---------------------------------------------------------------- age group
  section("Age group column + breakdown");
  const evAge = await mkEvent("Reports Age Groups", "فئات عمرية", { date: "2026-12-20" });
  const aKids = await member(21, "Kid Player", "under12");
  const aTeen = await member(22, "Teen Player", "12to17");
  const aAdult = await member(23, "Adult Player", "18to45");
  const aSenior = await member(24, "Senior Player", "46plus");
  for (const m of [aKids, aTeen, aAdult, aSenior]) await register(m, evAge);
  const dep = await api("/api/me/dependents", { method: "POST", jar: aSenior.jar, body: { name: "Dependent Child", relationship: "Son", birthDate: bd(8) } });
  ok(dep.status === 201, "add dependent", dep.json);
  const depId = dep.json && dep.json.dependents && dep.json.dependents[0] && dep.json.dependents[0].id;
  const dr = await api("/api/register", { method: "POST", jar: aSenior.jar, body: { eventId: evAge, dependentId: depId } });
  ok(dr.status === 200 || dr.status === 201, "register the dependent", dr.json);
  for (const m of [aKids, aTeen, aAdult, aSenior]) await checkin(m, evAge);
  for (const lang of ["en", "ar"]) {
    for (const view of ["registrations", "attendance", "points"]) {
      const h = (await getHtml(`/admin/print/event/${evAge}?view=${view}&lang=${lang}`)).text;
      ok(h.includes(lang === "ar" ? "الفئة العمرية" : "Age group"), `age group header ${view}/${lang}`);
      ok(h.includes(lang === "ar" ? "أطفال (أقل من 12)" : "Kids (under 12)") && h.includes(lang === "ar" ? "ماسترز (+46)" : "Masters (46+)"), `age labels shown ${view}/${lang}`);
    }
  }
  const ageHtml = (await getHtml(`/admin/print/event/${evAge}?view=registrations&lang=en`)).text;
  const bar = (ageHtml.match(/<div class="agebar">.*?<\/div>/s) || [""])[0];
  const cnt = (label) => Number((bar.match(new RegExp(label.replace(/[()+]/g, "\\$&") + " <b>(\\d+)</b>")) || [])[1]);
  ok(cnt("Kids (under 12)") === 2 && cnt("Youth (12–17)") === 1 && cnt("Adults (18–45)") === 1 && cnt("Masters (46+)") === 1, "age breakdown counts (dependent counted in its OWN band)", bar);
  ok(cnt("Not set") === 0, "nobody is 'not set' now that age group is mandatory", bar);
  const depRow = (ageHtml.match(/<tr[^>]*>(?:(?!<\/tr>).)*Dependent Child(?:(?!<\/tr>).)*<\/tr>/s) || [""])[0];
  ok(depRow && !/Masters/.test(depRow) && /Kids \(under 12\)/.test(depRow), "dependent shows its own age group, not the parent's", depRow.slice(0, 300));
  const adultRow = (ageHtml.match(/<tr[^>]*>(?:(?!<\/tr>).)*Adult Player(?:(?!<\/tr>).)*<\/tr>/s) || [""])[0];
  ok(/Adults \(18–45\)/.test(adultRow), "own registration shows own age group", adultRow.slice(0, 200));
  // birth year + age columns, calculated as of the event's start date
  ok(/Birth year/.test(ageHtml) && /<th class="c">Age<\/th>/.test(ageHtml), "registrations sheet has Birth year and Age columns");
  const yr30 = bd(30).slice(0, 4);
  ok(new RegExp(yr30).test(adultRow) && />30<\/td>/.test(adultRow), "adult row shows birth year and age 30", adultRow.slice(0, 300));
  const AU = require("../age_utils.js");
  const evFutDate = new Date(Date.now() + 3 * 365.25 * 86400000).toISOString().slice(0, 10);
  const evFut = await mkEvent("Reports Future Event", "فعالية مستقبلية", { date: evFutDate });
  const youth = await member(25, "Almost Adult", "12to17");
  const youthBirth = bd(17);
  await api("/api/me/profile", { method: "PATCH", jar: youth.jar, body: { birthDate: youthBirth } });
  await register(youth, evFut);
  const todayAge = AU.ageInfo({ birthDate: youthBirth });
  const futAge = AU.ageInfo({ birthDate: youthBirth }, evFutDate);
  ok(todayAge.ageGroup === "12to17" && futAge.ageGroup === "18to45", "fixture: Youth today, Adult on the event date", [todayAge, futAge]);
  const futHtml = (await getHtml(`/admin/print/event/${evFut}?view=registrations&lang=en`)).text;
  const futRow = (futHtml.match(/<tr[^>]*>(?:(?!<\/tr>).)*Almost Adult(?:(?!<\/tr>).)*<\/tr>/s) || [""])[0];
  ok(/Adults \(18–45\)/.test(futRow) && new RegExp(`>${futAge.age}</td>`).test(futRow), "event sheet: age and group are calculated as of the event start date", futRow.slice(0, 300));
  const futRep = (await getHtml(`/admin/print/age-report?lang=en&detail=names&events=${evFut}`)).text;
  ok(/Adults \(18–45\)/.test(futRep) && /Almost Adult/.test(futRep) && !/Youth \(12–17\) <span class="muted">\(1\)/.test(futRep), "age report: person counted in the group they will be in on the event date", futRep.slice(0, 200));
  ok(/Birth year/.test(futRep) && new RegExp(`>${youthBirth.slice(0, 4)}</td>`).test(futRep), "age report names table shows birth year", null);
  const futRepAr = (await getHtml(`/admin/print/age-report?lang=ar&detail=names&events=${evFut}`)).text;
  ok(/سنة الميلاد/.test(futRepAr) && /العمر/.test(futRepAr), "age report (ar) has birth year / age headers");
  const ptsHtml = (await getHtml(`/admin/print/event/${evAge}?view=points&lang=en`)).text;
  ok(/class="total"><td colspan="8">/.test(ptsHtml), "points total row spans the new column");
  for (const v of ["registrations", "attendance"]) {
    res = await getHtml(`/admin/print/event/${evEmpty}?view=${v}&lang=ar`);
    ok(res.status === 200 && /لا يوجد مسجّلون بعد/.test(res.text), `${v}: empty event message (ar)`);
  }
  // past event still printable
  res = await getHtml(`/admin/print/event/${evPast}?view=registrations&lang=en`);
  ok(res.status === 200 && res.text.includes("Reports Past Event") && res.text.includes("Amr Hassan"), "past event printable");
  // fallbacks and bad input
  res = await getHtml(`/admin/print/event/${evChess}?view=nonsense&lang=xx`);
  ok(res.status === 200 && res.text.includes("Registrations list") === false && res.text.includes("قائمة المسجّلين"), "unknown view + lang fall back to registrations (ar)");
  res = await getHtml(`/admin/print/event/999999?view=registrations`);
  ok(res.status === 404, "unknown event -> 404", res.status);
  res = await getHtml(`/admin/print/event/abc?view=registrations`);
  ok(res.status === 404, "non-numeric event id -> 404", res.status);
  res = await getHtml(`/admin/print/event/${evChess}?view=attendance&lang=en&x=<script>`);
  ok(res.status === 200 && !res.text.includes("<script>"), "query noise ignored");

  // ----------------------------------------------------- age-group report
  section("Age group report (customisable cross-event report)");
  const AR = (q, jar) => api(`/admin/print/age-report?${q}`, { jar: jar || admin, raw: true });
  const totalOf = (h) => {
    const m = h.match(/class="total"><td>[^<]*<\/td><td class="num">(\d+)<\/td><td class="num">(\d+)<\/td><td class="num">(\d+)<\/td><td class="num">(\d+)<\/td>/);
    return m ? { people: +m[1], regs: +m[2], attPeople: +m[3], att: +m[4] } : null;
  };
  const rowOf = (h, label) => {
    const esc2 = label.replace(/[()+]/g, "\\$&");
    const m = h.match(new RegExp(`<tr><td class="name nw">${esc2}</td><td class="num">(\\d+)</td><td class="num">(\\d+)</td><td class="num">(\\d+)</td><td class="num">(\\d+)</td>`));
    return m ? { people: +m[1], regs: +m[2], attPeople: +m[3], att: +m[4] } : null;
  };
  // guards
  res = await api(`/admin/print/age-report?events=all`, { jar: anon, raw: true });
  ok(res.status === 401, "age report: anonymous -> 401", res.status);
  res = await AR(`events=all`, aKids.jar);
  ok(res.status === 401 || res.status === 403, "age report: a member is refused", res.status);
  for (const role of ["staff", "management"]) {
    res = await AR(`events=all`, roles[role]);
    ok(res.status === 403, `age report: ${role} role refused`, res.status);
  }
  // single event, admin, summary
  res = await AR(`events=${evAge}&lang=en`);
  ok(res.status === 200 && /text\/html/.test(res.type) && res.text.includes('id="print-btn"') && res.text.includes("Age group report"), "age report: admin 200 html", res.status);
  ok(!/<script(?![^>]*src=)/.test(res.text), "age report: no inline scripts (CSP-safe)");
  let h = res.text;
  const kidsR = rowOf(h, "Kids (under 12)"), youthR = rowOf(h, "Youth (12–17)"), adultsR = rowOf(h, "Adults (18–45)"), mastersR = rowOf(h, "Masters (46+)"), unsetR = rowOf(h, "Not set");
  ok(kidsR && kidsR.people === 2 && kidsR.regs === 2 && kidsR.attPeople === 1 && kidsR.att === 1, "age report: Kids row (member kid + dependent; only the member checked in)", kidsR);
  ok(youthR && youthR.people === 1 && youthR.regs === 1 && youthR.att === 1, "age report: Youth row", youthR);
  ok(adultsR && adultsR.people === 1 && adultsR.regs === 1 && adultsR.att === 1, "age report: Adults row", adultsR);
  ok(mastersR && mastersR.people === 1 && mastersR.regs === 1 && mastersR.att === 1, "age report: Masters row (dependent NOT counted here)", mastersR);
  ok(unsetR && unsetR.regs === 0, "age report: Not set row is empty", unsetR);
  const tot = totalOf(h);
  ok(tot && tot.people === 5 && tot.regs === 5 && tot.att === 4 && tot.attPeople === 4, "age report: totals 5 people / 5 regs / 4 check-ins", tot);
  ok(/80\.0%/.test(h), "age report: attendance rate 80.0%");
  ok(!h.includes("By event") && !h.includes("Dependent Child"), "age report: summary level has no per-event table or names");
  // detail levels
  h = (await AR(`events=${evAge}&lang=en&detail=events`)).text;
  ok(h.includes("By event") && h.includes("Reports Age Groups") && /<td class="num">2 \/ 1<\/td>/.test(h), "age report: per-event table shows registered / checked-in (2 / 1 for Kids)");
  ok(!h.includes("Dependent Child"), "age report: events level still has no names");
  h = (await AR(`events=${evAge}&lang=en&detail=names`)).text;
  ok(h.includes("Dependent Child") && h.includes("Senior Player") && h.includes("Kid Player") && h.includes("Teen Player"), "age report: names level lists every person");
  ok(/Masters \(46\+\) <span class="muted">\(1\)<\/span>/.test(h), "age report: names section headings carry the head-count");
  ok(h.includes("0106"), "age report: admin sees phone numbers in the names list");
  // age filter
  h = (await AR(`events=${evAge}&lang=en&ages=under12`)).text;
  const t2 = totalOf(h);
  ok(rowOf(h, "Kids (under 12)") && !rowOf(h, "Adults (18–45)") && t2 && t2.regs === 2, "age report: ages filter keeps only the chosen group", t2);
  h = (await AR(`events=${evAge}&lang=en&ages=under12,none`)).text;
  ok(rowOf(h, "Not set") && rowOf(h, "Kids (under 12)") && !rowOf(h, "Masters (46+)"), "age report: 'none' can be chosen as a group");
  // all events + waitlist exclusion + multiple events
  const listAll = (await A("/api/admin/reports/events")).json;
  const confirmedTotal = listAll.reduce((a, e) => a + e.confirmedCount, 0);
  h = (await AR(`events=all&lang=en`)).text;
  const allTot = totalOf(h);
  ok(allTot && allTot.regs === confirmedTotal, "age report: all events = every CONFIRMED registration (waitlist excluded)", [allTot, confirmedTotal]);
  const smallInfo = listAll.find((e) => e.eventId === evSmall);
  ok(smallInfo.waitlistCount === 2, "(fixture) small event has 2 waitlisted");
  const hSmall = (await AR(`events=${evSmall}&lang=en`)).text;
  ok(totalOf(hSmall).regs === smallInfo.confirmedCount, "age report: waitlisted players are not counted", [totalOf(hSmall), smallInfo.confirmedCount]);
  const hTwo = (await AR(`events=${evSmall},${evAge}&lang=en&detail=events`)).text;
  ok(totalOf(hTwo).regs === smallInfo.confirmedCount + 5, "age report: several chosen events add up", totalOf(hTwo));
  ok(hTwo.includes("Reports Age Groups") && !hTwo.includes("Reports Past Event"), "age report: only the chosen events appear");
  const hEmptyEv = (await AR(`events=${evEmpty},${evAge}&lang=en&detail=events`)).text;
  ok(hEmptyEv.includes("Reports Age Groups") && !hEmptyEv.includes("Reports Empty Event") && /2 event\(s\)/.test(hEmptyEv), "age report: events with no registrations are not listed in the per-event table (but count as selected)");
  // period filter
  h = (await AR(`events=all&lang=en&from=2099-01-01`)).text;
  ok(/No events match this selection/.test(h) && !/class="total"/.test(h), "age report: empty period -> friendly message");
  const hRange = await AR(`events=all&lang=en&from=2026-12-20&to=2026-12-20&detail=events`);
  ok(hRange.text.includes("Reports Age Groups") && !hRange.text.includes("Reports Chess Cup"), "age report: date range excludes other dates");
  // language
  h = (await AR(`events=${evAge}&lang=ar&detail=names`)).text;
  ok(h.includes('dir="rtl"') && h.includes("تقرير الفئات العمرية") && h.includes("ماسترز (+46)") && h.includes("أطفال (أقل من 12)"), "age report: Arabic version");
  // bad input never crashes
  for (const q of ["events=abc", "events=", "ages=zzz", "detail=bogus", "from=notadate&to=2026-13-99", "events=1,2,,x&ages=,,", `events=${"9".repeat(40)}`]) {
    res = await AR(q + "&lang=en");
    ok(res.status === 200 && /Age group report/.test(res.text), `age report: bad input handled (${q.slice(0, 30)})`, res.status);
  }
  h = (await AR(`events=all&lang=en&detail=bogus&ages=zzz`)).text;
  ok(!h.includes("By event") && rowOf(h, "Kids (under 12)") && rowOf(h, "Masters (46+)"), "age report: bogus detail -> summary, bogus ages -> all groups");
  // XSS
  h = (await AR(`events=${evChess}&lang=en&detail=names`)).text;
  ok(!h.includes("<script>alert(1)</script>") && h.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "age report: hostile names escaped");
  // Tournament Manager: only own events, never phones
  const tmEvents = (await api("/api/admin/reports/events", { jar: roles.tournament })).json.map((e) => e.eventId);
  h = (await AR(`events=all&lang=en&detail=events`, roles.tournament)).text;
  ok(tmEvents.length >= 1 && h.includes("Reports Chess Cup") && !h.includes("Reports Age Groups"), "age report: Tournament Manager only sees assigned events", tmEvents);
  h = (await AR(`events=all&lang=en&detail=names`, roles.tournament)).text;
  ok(!/0106\d{7}/.test(h) && !h.includes(">Phone<"), "age report: Tournament Manager gets no phone numbers");
  h = (await AR(`events=${evAge}&lang=en`, roles.tournament)).text;
  ok(/No events match this selection/.test(h), "age report: asking a Tournament Manager for an unassigned event returns nothing");

  // Swiss tournament sheets (the other half of the tab)
  section("Swiss tournament sheets linked from the tab");
  for (const q of ["view=regulation", "view=pairings&round=1", "view=standings"]) {
    for (const lang of ["en", "ar"]) {
      res = await getHtml(`/admin/print/tournament/${evChess}?${q}&lang=${lang}`);
      ok(res.status === 200 && /text\/html/.test(res.type) && res.text.includes('id="print-btn"'), `swiss ${q}/${lang}`, res.status);
    }
  }
  res = await getHtml(`/admin/print/tournament/${evEmpty}?view=regulation&lang=en`);
  ok(res.status === 404, "event without a Swiss tournament -> 404", res.status);

  // static assets the sheets rely on
  for (const asset of ["/print.js", "/ahly-crest-logo.png"]) {
    const a = await api(asset, { jar: anon, raw: true });
    ok(a.status === 200, `asset ${asset}`, a.status);
  }

  ok(serverErrors.length === 0, "no 5xx", serverErrors);
  console.log(`\nReports E2E: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
