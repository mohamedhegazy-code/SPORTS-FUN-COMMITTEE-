// WhatsApp confirmation / 2-day reminder / event-day messages: the event info block (QR at the gate, arrive 30 min before,
// location inside the club, site + community links), built from event setup. Event setup form (create + edit) wiring too.
// Usage: BASE_URL=http://localhost:3951 node whatsapp_event_info_ui_e2e.js
"use strict";
const { chromium } = require("/opt/node-tools/node_modules/playwright");
const BASE = process.env.BASE_URL || "http://localhost:3951";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
let passed = 0, failed = 0;
const serverErrors = [];
const ok = (c, l, x) => { if (c) passed++; else { failed++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 500)); } };
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
const cairoToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });

const plusDays = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
const COMMUNITY = "https://chat.whatsapp.com/IiF2wsmyiwuEUKMga84dnN";
(async () => {
  const stamp = Date.now().toString(36);
  const admin = await prime({});
  ok((await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } })).status === 200, "admin login");
  const mkEvent = async (name, date, extra) => {
    const r = await api("/api/events", { method: "POST", jar: admin, form: form({ nameEn: name + " " + stamp, nameAr: name + "ع", sport: "Padel", date, ...(extra || {}) }) });
    ok(r.status === 200 || r.status === 201, "event " + name, r.json); return r.json.id;
  };
  const evFull2 = await mkEvent("WaFull2", plusDays(2), { startTime: "18:00", locationAr: "الصالة الرئيسية - ملعب 3", locationEn: "Main hall - Court 3" });
  const evToday = await mkEvent("WaToday", plusDays(0), { startTime: "09:15", locationEn: "Garden terrace" });
  const evBare = await mkEvent("WaBare", plusDays(2));
  const evFar = await mkEvent("WaFar", plusDays(3), { startTime: "20:00", locationEn: "Hall B" });
  const list = (await api("/api/events", { jar: admin })).json;
  const got = list.find((e) => e.id === evFull2);
  ok(got && got.locationAr === "الصالة الرئيسية - ملعب 3" && got.locationEn === "Main hall - Court 3", "location saved and returned by the API", got && [got.locationAr, got.locationEn]);
  const lp = (await api("/api/settings")).json.landingPage;
  ok(lp && lp.whatsapp && lp.whatsapp.link === COMMUNITY, "community link is in the Landing Page WhatsApp settings", lp && lp.whatsapp);
  // one registered member with a phone on every event
  const mjar = await prime({}); const num = `WA${stamp}`;
  await api("/api/auth/signup", { method: "POST", jar: mjar, body: { membershipNumber: num, name: "Sara Ahmed", password: "abc12345", phone: "01012345678", agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
  for (const ev of [evFull2, evToday, evBare, evFar]) { const r = await api("/api/register", { method: "POST", jar: mjar, body: { eventId: ev } }); ok(r.status === 200 || r.status === 201, "register on " + ev, r.json); }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
  await ctx.addCookies(Object.entries(admin).map(([name, value]) => ({ name, value, url: BASE })));
  const page = await ctx.newPage(); const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(BASE + "/"); await page.waitForTimeout(900);
  await page.click('[data-view="admin"]'); await page.waitForTimeout(700);
  const chip = async (evId, type) => {
    await page.evaluate((id) => openAdminEventHub(id, "hub"), evId); await page.waitForTimeout(1500);
    const sel = type === "confirm" ? ".wa-chip:not(.reminder):not(.dayof)" : `.wa-chip.${type === "reminder" ? "reminder" : "dayof"}`;
    const c = page.locator(`#admin-event-hub-panel ${sel}`).first();
    if (!(await c.count())) return { found: false };
    const disabled = await c.isDisabled();
    const href = disabled ? "" : await c.getAttribute("data-wa-href");
    const text = href ? decodeURIComponent(href.split("text=")[1] || "") : "";
    return { found: true, disabled, text };
  };

  section("Confirmation message");
  let c = await chip(evFull2, "confirm");
  ok(c.found && !c.disabled, "confirm chip is available");
  const T = c.text;
  ok(T.includes("1- أحضر رمز QR الخاص بك واعرضه عند بوابة الفعالية."), "AR: bring your QR to the gate", T);
  ok(T.includes("2- يرجى الحضور قبل موعد البدء بـ 30 دقيقة (الحضور 5:30 م، وبداية الفعالية 6:00 م)."), "AR: arrive 30 min before, times from the event start time", T);
  ok(T.includes("📍 مكان الفعالية داخل النادي: الصالة الرئيسية - ملعب 3"), "AR: location from event setup", T);
  ok(T.includes("1- Bring your QR code and show it at the event gate."), "EN: bring your QR to the gate", T);
  ok(T.includes("2- Please arrive 30 minutes before the start (arrive 5:30 PM, event starts 6:00 PM)."), "EN: arrive 30 min before, times from the event start time", T);
  ok(T.includes("📍 Location inside the club: Main hall - Court 3"), "EN: location from event setup", T);
  ok(T.includes("https://myahlawy.com") && T.includes("MyAhlawy"), "site link", T);
  ok(T.includes(COMMUNITY) && T.includes("انضم إلى مجتمعنا على واتساب") && T.includes("Join our WhatsApp community"), "community link in both languages", T);
  ok(T.indexOf("مرحبًا Sara Ahmed") === 0 && T.indexOf("Hi Sara Ahmed") > T.indexOf("نراك هناك!"), "Arabic first, then English; greeting + signature kept", T.slice(0, 80));
  ok(T.includes("لجنة الرياضة الترفيهية") && T.includes("Recreational Sports Committee"), "committee signature kept");

  section("Reminder: 2 days before");
  c = await chip(evFull2, "reminder");
  ok(c.found && !c.disabled, "reminder is open 2 days before the event");
  ok(c.text.includes("تذكير بموعد") && c.text.includes("a reminder about") && c.text.includes("5:30 PM") && c.text.includes("Main hall - Court 3") && c.text.includes(COMMUNITY), "reminder carries the same info block", c.text);
  c = await chip(evFull2, "dayof");
  ok(c.found && c.disabled, "event-day message not open yet 2 days before");
  c = await chip(evFar, "reminder");
  ok(c.found && c.disabled, "reminder not open 3 days before");

  section("Event-day message");
  c = await chip(evToday, "dayof");
  ok(c.found && !c.disabled, "event-day message open on the event date");
  ok(c.text.includes("اليوم هو موعد") && c.text.includes("today is the day for") && c.text.includes("arrive 8:45 AM, event starts 9:15 AM") && c.text.includes("الحضور 8:45 ص") && c.text.includes("Location inside the club: Garden terrace") && c.text.includes(COMMUNITY), "event-day message carries the info block (AM times)", c.text);
  ok(!c.text.includes("مكان الفعالية داخل النادي: undefined") && c.text.includes("مكان الفعالية داخل النادي: Garden terrace"), "Arabic location falls back to the English one when only that is set", c.text);

  section("Only what the event setup has");
  c = await chip(evBare, "confirm");
  ok(c.text.includes("1- Bring your QR code") && !c.text.includes("2- ") && !c.text.includes("arrive") && !c.text.includes("📍"), "no start time / location -> no arrival or location lines, numbering stays tidy", c.text);
  ok(c.text.includes("https://myahlawy.com") && c.text.includes(COMMUNITY), "site + community lines still there");

  section("Event setup form (create + edit) in the UI");
  await page.click('[data-admin-tab="events"]'); await page.waitForTimeout(800);
  await page.fill("#ev-name-en", "WaUi " + stamp); await page.fill("#ev-name-ar", "واتساب" + stamp);
  await page.fill("#ev-date", plusDays(5)); await page.fill("#ev-start-time", "17:00");
  await page.fill("#ev-location-ar", "قاعة الشطرنج"); await page.fill("#ev-location-en", "Chess room");
  await page.click("#ev-submit"); await page.waitForTimeout(1500);
  const created = (await api("/api/events", { jar: admin })).json.find((e) => e.nameEn === "WaUi " + stamp);
  ok(created && created.locationEn === "Chess room" && created.locationAr === "قاعة الشطرنج" && created.startTime === "17:00", "UI create saves start time + location", created);
  ok((await page.inputValue("#ev-location-en")) === "", "create form is cleared after saving");
  await page.selectOption("#ev-edit-select", String(evBare)); await page.click("#ev-edit-load"); await page.waitForTimeout(800);
  ok((await page.inputValue("#ev-edit-location-en")) === "", "edit form loads an empty location");
  await page.fill("#ev-edit-start-time", "19:30"); await page.fill("#ev-edit-location-en", "Court 7"); await page.fill("#ev-edit-location-ar", "ملعب 7");
  await page.click("#ev-edit-save"); await page.waitForTimeout(1500);
  const edited = (await api("/api/events", { jar: admin })).json.find((e) => e.id === evBare);
  ok(edited && edited.locationEn === "Court 7" && edited.locationAr === "ملعب 7" && edited.startTime === "19:30", "UI edit saves start time + location", edited);
  await page.click('[data-admin-tab="overview"]').catch(() => {}); await page.waitForTimeout(500);
  await page.goto(BASE + "/"); await page.waitForTimeout(900); await page.click('[data-view="admin"]'); await page.waitForTimeout(700);
  c = await chip(evBare, "confirm");
  ok(c.text.includes("arrive 7:00 PM, event starts 7:30 PM") && c.text.includes("Court 7") && c.text.includes("ملعب 7"), "the edited event now produces the full message", c.text);

  section("Message links tab (admin)");
  const st = (await api("/api/settings")).json;
  ok(Array.isArray(st.messageLinks) && st.messageLinks.length === 2 && st.messageLinks[0].url === "https://myahlawy.com" && st.messageLinks[1].url === COMMUNITY, "settings carry the two seeded links, in order", st.messageLinks);
  const plain = await prime({});
  ok((await api("/api/admin/message-links", { jar: plain })).status === 401, "links admin API needs a login");
  ok((await api("/api/admin/message-links", { method: "PUT", jar: admin, body: { links: [{ titleEn: "Bad", url: "javascript:alert(1)" }] } })).status === 400, "a non-http address is refused");
  ok((await api("/api/admin/message-links", { method: "PUT", jar: admin, body: { links: [{ titleEn: "", titleAr: "", url: "https://x.com" }] } })).status === 400, "a link without any title is refused");
  await page.goto(BASE + "/"); await page.waitForTimeout(900);
  await page.click('[data-view="admin"]'); await page.waitForTimeout(700);
  await page.click('[data-admin-tab="links"]'); await page.waitForTimeout(900);
  ok(await page.locator("#msl-list .msl-row").count() === 2, "the tab lists the two links");
  ok((await page.locator("#msl-preview").innerText()).includes("https://myahlawy.com"), "preview shows the links");
  await page.screenshot({ path: "/tmp/msl_tab.png" });
  await page.click("#msl-add"); await page.waitForTimeout(200);
  const rows = page.locator("#msl-list .msl-row");
  ok(await rows.count() === 3, "a third row is added");
  await rows.nth(2).locator('[data-msl-f="titleAr"]').fill("تابعنا على إنستجرام");
  await rows.nth(2).locator('[data-msl-f="titleEn"]').fill("Follow us on Instagram");
  await rows.nth(2).locator('[data-msl-f="url"]').fill("https://instagram.com/ahly.recreational");
  await rows.nth(2).locator('[data-msl-act="up"]').click(); await page.waitForTimeout(200);
  await rows.nth(2).locator('[data-msl-f="enabled"]').uncheck();   // after moving up, the community row is the last one
  ok((await page.locator("#msl-preview").innerText()).includes("Follow us on Instagram") && !(await page.locator("#msl-preview").innerText()).includes("chat.whatsapp.com"), "preview follows the edits (community switched off)");
  await page.click("#msl-save"); await page.waitForTimeout(1200);
  ok((await page.locator("#msl-msg").innerText()).length > 0 && await page.locator("#msl-msg.err").count() === 0, "saved message shown");
  const saved = (await api("/api/admin/message-links", { jar: admin })).json.links;
  ok(saved.length === 3 && saved[1].titleEn === "Follow us on Instagram" && saved[2].enabled === false && saved[2].url === COMMUNITY, "order and on/off saved", saved);
  await page.goto(BASE + "/"); await page.waitForTimeout(900); await page.click('[data-view="admin"]'); await page.waitForTimeout(700);
  c = await chip(evFull2, "confirm");
  const iAt = c.text.indexOf("Follow us on Instagram: https://instagram.com/ahly.recreational");
  ok(c.text.includes("تابعنا على إنستجرام: https://instagram.com/ahly.recreational") && iAt > c.text.indexOf("https://myahlawy.com") && iAt > 0, "new link is in the message, after the site link (both languages)", c.text);
  ok(!c.text.includes("chat.whatsapp.com") && !c.text.includes("Join our WhatsApp community"), "the switched-off community link is left out", c.text);
  c = await chip(evFull2, "reminder");
  ok(c.text.includes("instagram.com/ahly.recreational"), "reminder uses the same links", c.text);
  // restore the original list
  await api("/api/admin/message-links", { method: "PUT", jar: admin, body: { links: st.messageLinks } });

  ok(errs.length === 0, "no page errors", errs);
  ok(serverErrors.length === 0, "no 5xx", serverErrors);
  await browser.close();
  console.log(`\nwhatsapp_event_info_ui_e2e: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
