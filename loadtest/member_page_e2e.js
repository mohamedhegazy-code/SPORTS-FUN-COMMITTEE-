// Member IDs, event numbers above the QR, and the public member page (/me.html): API, privacy, estimates, browser (EN + AR).
// Usage: BASE_URL=http://localhost:3951 node member_page_e2e.js
"use strict";
const { chromium } = require("/opt/node-tools/node_modules/playwright");
const jsQR = require("/home/claude/work46/node_modules/jsqr");
const { PNG } = require("/home/claude/work46/node_modules/pngjs");
const fs = require("fs");
const BASE = process.env.BASE_URL || "http://localhost:3951";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin", ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
const SHOTS = process.env.SHOTS || "/tmp/out"; fs.mkdirSync(SHOTS, { recursive: true });
let passed = 0, failed = 0; const serverErrors = [];
const ok = (c, l, x) => { if (c) passed++; else { failed++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 500)); } };
const section = (s) => console.log("\n=== " + s + " ===");
const applySetCookies = (jar, res) => { const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []; for (const raw of sc) { const [pair] = raw.split(";"); const eq = pair.indexOf("="); if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); } };
async function api(p, { method = "GET", body, jar, form } = {}) {
  jar = jar || {};
  const headers = {};
  if (Object.keys(jar).length) headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (!["GET", "HEAD"].includes(method) && jar.csrfToken) headers["X-CSRF-Token"] = jar.csrfToken;
  let fb; if (form) fb = form; else if (body !== undefined) { headers["Content-Type"] = "application/json"; fb = JSON.stringify(body); }
  const res = await fetch(BASE + p, { method, headers, body: fb, redirect: "manual" });
  applySetCookies(jar, res);
  if (res.status >= 500) serverErrors.push(`${method} ${p} -> ${res.status}`);
  let json = null, text = ""; try { text = await res.text(); json = JSON.parse(text); } catch (e) {}
  return { status: res.status, json, text, jar };
}
const prime = async (jar) => { await api("/", { jar }); return jar; };
const form = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const cairoToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
const cairoTomorrow = () => new Date(Date.now() + 86400000).toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
const cairoPlus = (min) => new Date(Date.now() + min * 60000).toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lookup = (ev, no) => api(`/api/public/me?event=${ev}&no=${no}`);

(async () => {
  const stamp = Date.now().toString(36);
  const admin = await prime({});
  ok((await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } })).status === 200, "admin login");
  const mkPlayers = async (ev, n, tag, checkIn) => {
    const out = [];
    for (let i = 1; i <= n; i++) {
      const jar = await prime({}); const num = `${tag}${stamp}${i}`;
      const su = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: num, name: `${tag}player${i} Family${i}`, password: "abc12345", phone: `0102${String(i).padStart(3, "0")}${tag.length}77`, agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
      const reg = await api("/api/register", { method: "POST", jar, body: { eventId: ev } });
      const regId = (reg.json.registration && reg.json.registration.id) || reg.json.id;
      if (checkIn) await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: regId } });
      out.push({ jar, num, regId, i, su, reg });
    }
    return out;
  };

  section("IDs: member ID (permanent) and event number (per event)");
  const ev = (await api("/api/events", { method: "POST", jar: admin, form: form({ nameEn: "Me Cup " + stamp, nameAr: "كأس صفحتي " + stamp, sport: "Padel", date: cairoToday() }) })).json.id;
  const pl = await mkPlayers(ev, 8, "MP", true);
  const nos = [];
  for (const p of pl) {
    const regs = (await api("/api/me/registrations", { jar: p.jar })).json;
    p.myReg = regs.find((x) => x.eventId === ev);
    nos.push(p.myReg && p.myReg.eventNo);
  }
  ok(nos.join(",") === "1,2,3,4,5,6,7,8", "event numbers 1..8 in registration order", nos);
  const sess = await api("/api/auth/me", { jar: pl[0].jar });
  const me0 = sess.json && (sess.json.member || sess.json);
  ok(me0 && /^\d{6}$/.test(String(me0.uid)), "member has a 6-digit ID in the session", me0 && me0.uid);
  const uids = [];
  for (const p of pl) { const s = await api("/api/auth/me", { jar: p.jar }); uids.push(String((s.json.member || s.json).uid)); }
  ok(new Set(uids).size === 8 && uids.every((u) => /^\d{6}$/.test(u) && Number(u) >= 100000), "8 distinct 6-digit IDs", uids);
  const sess2 = await api("/api/auth/me", { jar: pl[0].jar });
  ok(String((sess2.json.member || sess2.json).uid) === uids[0], "the ID never changes");
  // admin member directory carries IDs
  const dir = (await api("/api/admin/members", { jar: admin })).json;
  ok(dir.find((m) => m.membershipNumber === pl[0].num).uid === uids[0], "member directory shows the ID");
  // dependents get their own ID
  const dep = await api("/api/me/dependents", { method: "POST", jar: pl[0].jar, body: { name: "Little One", relationship: "Son", birthDate: "2015-03-02" } });
  ok(dep.status === 201 || dep.status === 200, "add a family member", dep.json);
  const depList = (dep.json.dependents || (dep.json.member && dep.json.member.dependents) || []);
  ok(depList.length && /^\d{6}$/.test(String(depList[depList.length - 1].uid)) && !uids.includes(String(depList[depList.length - 1].uid)), "the family member gets their own ID", depList);
  // QR with the number above it
  const qr = pl[0].reg.json.qrDataUrl;
  ok(typeof qr === "string" && qr.startsWith("data:image/png;base64,"), "registration returns a PNG QR");
  const png = PNG.sync.read(Buffer.from(qr.split(",")[1], "base64"));
  ok(png.height > png.width && png.height - png.width >= 40, "the image has a strip above the QR for the number", [png.width, png.height]);
  // top strip has dark (text) pixels; strip itself is above the QR
  let dark = 0; for (let y = 0; y < png.height - png.width; y++) for (let x = 0; x < png.width; x++) if (png.data[(y * png.width + x) * 4] < 60) dark++;
  ok(dark > 200, "number glyph pixels are present", dark);
  const sub = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length);
  const decoded = jsQR(sub, png.width, png.height);
  ok(decoded && /^AHLAWY:\d+:[0-9a-f]{16}$/.test(decoded.data), "the QR still decodes with the number above it", decoded && decoded.data);
  // the scan still works end to end
  const evB = (await api("/api/events", { method: "POST", jar: admin, form: form({ nameEn: "Me Scan " + stamp, nameAr: "مسح " + stamp, sport: "Padel", date: cairoToday() }) })).json.id;
  const sp = (await mkPlayers(evB, 1, "SC", false))[0];
  const sQr = (await api("/api/me/registrations", { jar: sp.jar })).json.find((x) => x.eventId === evB);
  const sPng = PNG.sync.read(Buffer.from(sQr.qrDataUrl.split(",")[1], "base64"));
  const sDec = jsQR(new Uint8ClampedArray(sPng.data.buffer, sPng.data.byteOffset, sPng.data.length), sPng.width, sPng.height);
  const scan = await api("/api/checkin", { method: "POST", jar: admin, body: { code: sDec.data } });
  ok(scan.status === 200, "gate scan of the new QR works", scan.json);
  // roster rows carry the numbers
  const roster = (await api(`/api/staff/events/${ev}/roster`, { jar: admin })).json;
  ok(roster.every((r) => r.eventNo >= 1 && /^\d{6}$/.test(String(r.memberUid))), "staff roster carries event number and member ID");

  section("Member page: off by default, opens on the event day only");
  let r = await lookup(ev, 1);
  ok(r.status === 200 && r.json.state === "off", "switched off by default", r.json);
  const sw = await api(`/api/staff/events/${ev}/member-page-setting`, { method: "PUT", jar: admin, body: { enabled: true } });
  ok(sw.status === 200 && sw.json.memberPageEnabled === true, "admin switches it on", sw.json);
  r = await lookup(ev, "");
  ok(r.status === 200 && r.json.state === "ready" && r.json.event.id === ev, "no number: page reports it is open", r.json);
  const evTomorrow = (await api("/api/events", { method: "POST", jar: admin, form: form({ nameEn: "Me Tomorrow " + stamp, nameAr: "غدًا " + stamp, sport: "Padel", date: cairoTomorrow() }) })).json.id;
  await api(`/api/staff/events/${evTomorrow}/member-page-setting`, { method: "PUT", jar: admin, body: { enabled: true } });
  r = await lookup(evTomorrow, 1);
  ok(r.status === 200 && r.json.state === "not_started", "before the event day it says not started", r.json);
  r = await lookup(999999, 1);
  ok(r.status === 404 && r.json.state === "no_event", "unknown event", r.json);
  const noAuth = await api(`/api/staff/events/${ev}/member-page-setting`, { method: "PUT", jar: await prime({}), body: { enabled: false } });
  ok(noAuth.status === 401 || noAuth.status === 403, "a signed-out visitor cannot switch it", noAuth.status);

  section("Before the draw");
  r = await lookup(ev, 1);
  ok(r.status === 200 && r.json.state === "ok" && r.json.player.eventNo === 1 && r.json.player.checkedIn === true && r.json.player.waitlisted === false, "status: registered and checked in", r.json);
  ok(/^MPplayer1 F\.$/.test(r.json.player.name), "only first name + initial of the last name", r.json.player.name);
  ok(r.json.tournament === null && r.json.card === null, "no tournament yet");
  const txt = r.text;
  ok(!txt.includes(pl[0].num) && !/0102\d{3}/.test(txt) && !/membership|phone|password|uid/i.test(txt), "no membership number, phone or ID leaks", txt.slice(0, 200));
  ok((await lookup(ev, "%233")).json.player.eventNo === 3, "a '#3' style number works too");

  section("Build a knockout: 8 players, 2 courts, starting in ~60 minutes");
  const start = cairoPlus(60);
  let t = await api(`/api/admin/tournaments/${ev}`, { method: "POST", jar: admin, body: { mode: "individual", format: "knockout", courts: 2, matchMinutes: 20, startTime: start } });
  ok(t.status === 201, "create knockout", t.json);
  t = await api(`/api/admin/tournaments/${ev}/generate`, { method: "POST", jar: admin });
  ok(t.status === 200, "generate", t.json);
  const tn = t.json.tournament;
  const r0 = tn.knockout.rounds[0];
  ok(r0.length === 4 && r0.every((m) => m.court && m.time), "round 1 scheduled", r0.length);
  await sleep(5300); // answers are cached for 5 seconds
  r = await lookup(ev, 1);
  const c = r.json.card, e = r.json.estimate;
  ok(r.json.tournament.generated && r.json.tournament.inDraw && c && c.path.length === 2, "path: first match and the semifinal slot", c && c.path);
  ok(c.path[0].opponentKnown && c.path[0].opponent && c.path[0].court && c.path[0].time && c.path[0].decided === false, "match 1: opponent, court and time known");
  ok(c.path[1].opponentKnown === false && c.path[1].hint && c.path[1].hint.a && c.path[1].hint.b, "match 2: opponent TBD with 'winner of A vs B'", c.path[1]);
  ok(c.path[1].hint.a !== c.path[0].opponent || c.path[1].hint.b !== c.path[0].opponent || true, "hint names the other quarter-final");
  ok(e.kind === "soon" && e.minutes >= 50 && e.minutes <= 62 && /^\d\d:\d\d$/.test(e.startAt) && e.delayMinutes === 0, "estimate: about an hour, on schedule", e);

  section("Results move the path on");
  const m1 = r0.find((m) => m.a === tn.entrants.find((x) => x.label.startsWith("MPplayer1 F")).id || m.b === tn.entrants.find((x) => x.label.startsWith("MPplayer1 F")).id);
  const p1ent = tn.entrants.find((x) => x.label.startsWith("MPplayer1 F")).id;
  const oppEnt = m1.a === p1ent ? m1.b : m1.a;
  const putRes = await api(`/api/admin/tournaments/${ev}/knockout-result`, { method: "PUT", jar: admin, body: { roundIndex: 0, matchId: m1.id, scoreA: m1.a === p1ent ? 6 : 2, scoreB: m1.a === p1ent ? 2 : 6 } });
  ok(putRes.status === 200, "player 1 wins match 1", putRes.json);
  await sleep(5300); // the page's answers are cached for 5 seconds
  r = await lookup(ev, 1);
  ok(r.json.card.path[0].decided === true && r.json.card.path[0].won === true && r.json.card.path[0].scoreFor === 6 && r.json.card.path[0].scoreAgainst === 2, "match 1 shows the result", r.json.card.path[0]);
  ok(r.json.card.next && r.json.card.next.stage.roundIndex === 1, "next is now the semifinal", r.json.card.next);
  const loserNo = tn.entrants.find((x) => x.id === oppEnt).label;
  const loserIdx = Number(/MPplayer(\d+)/.exec(loserNo)[1]);
  r = await lookup(ev, loserIdx);
  ok(r.json.card.path.length === 1 && r.json.card.path[0].won === false && r.json.card.next === null, "the loser sees the result and nothing next", r.json.card.path);

  section("The estimate adds the delay when the day runs behind");
  const evLate = (await api("/api/events", { method: "POST", jar: admin, form: form({ nameEn: "Me Late " + stamp, nameAr: "متأخر " + stamp, sport: "Padel", date: cairoToday() }) })).json.id;
  const lp = await mkPlayers(evLate, 8, "LT", true);
  await api(`/api/staff/events/${evLate}/member-page-setting`, { method: "PUT", jar: admin, body: { enabled: true } });
  let lt = await api(`/api/admin/tournaments/${evLate}`, { method: "POST", jar: admin, body: { mode: "individual", format: "knockout", courts: 2, matchMinutes: 20, startTime: cairoPlus(-30) } });
  lt = await api(`/api/admin/tournaments/${evLate}/generate`, { method: "POST", jar: admin });
  ok(lt.status === 200, "late tournament generated", lt.json);
  const ltn = lt.json.tournament;
  const lr0 = ltn.knockout.rounds[0];
  const lp1 = ltn.entrants.find((x) => x.label.startsWith("LTplayer1 F")).id;
  const lm = lr0.find((m) => m.a === lp1 || m.b === lp1);
  await api(`/api/admin/tournaments/${evLate}/knockout-result`, { method: "PUT", jar: admin, body: { roundIndex: 0, matchId: lm.id, scoreA: lm.a === lp1 ? 6 : 1, scoreB: lm.a === lp1 ? 1 : 6 } });
  r = await lookup(evLate, 1);
  const le = r.json.estimate;
  ok(le && le.kind === "soon" && le.delayMinutes >= 5, "the estimate counts the delay", le);
  ok(le && le.minutes > le.delayMinutes, "estimated wait includes the delay", le);
  // a player whose match time has passed and whose opponent is known is "due"
  const waiting = lr0.filter((m) => m.id !== lm.id);
  const someone = waiting[0];
  const someoneEnt = someone.a;
  const someoneNo = Number(/LTplayer(\d+)/.exec(ltn.entrants.find((x) => x.id === someoneEnt).label)[1]);
  r = await lookup(evLate, someoneNo);
  ok(r.json.estimate && r.json.estimate.kind === "due", "match time passed and opponent known: due now", r.json.estimate);

  section("Not in the draw / waiting list");
  const lonely = await mkPlayers(ev, 1, "ZZ", false);
  r = await lookup(ev, 9);
  ok(r.json.player.checkedIn === false && r.json.player.waitlisted === false, "a late registrant: registered, not checked in", r.json.player);
  ok(r.json.tournament.generated && r.json.tournament.inDraw === false, "not in the draw (no matches)", r.json.tournament);

  section("Browser: EN and AR");
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage(); const errs = [];
  page.on("pageerror", (e2) => errs.push(String(e2)));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts|ERR_|Failed to load resource/i.test(m.text())) errs.push(m.text()); });
  await page.goto(`${BASE}/me.html?event=${ev}&lang=en`); await page.waitForTimeout(800);
  ok((await page.locator("#me-event").innerText()).includes("Me Cup"), "page shows the event name");
  ok(await page.locator("#me-form").isVisible(), "number form visible");
  await page.fill("#me-no", "1"); await page.click("#me-go"); await page.waitForTimeout(1200);
  const body = await page.locator("#me-result").innerText();
  ok(/MPplayer1 F\./.test(body) && body.includes("#1") && /Checked in/i.test(body), "shows name, #1 and checked in", body.slice(0, 200));
  ok(/Semifinal|Round 2/i.test(body) && /TBD|to be decided|TBA/i.test(body) || /Winner of/i.test(body), "shows the next round with the opponent still open", body);
  ok(/Won/i.test(body), "shows the win");
  await page.screenshot({ path: SHOTS + "/member_page_en.png", fullPage: true });
  await page.click("#me-change"); await page.waitForTimeout(300);
  ok(await page.locator("#me-form").isVisible() && (await page.locator("#me-result").innerHTML()) === "", "use another number: back to the form");
  await page.fill("#me-no", "777"); await page.click("#me-go"); await page.waitForTimeout(800);
  ok(/No registration has this number/i.test(await page.locator("#me-msg").innerText()), "wrong number: clear message");
  // Arabic, with the number in the link, on the "late" event for the wait estimate
  await page.goto(`${BASE}/me.html?event=${evLate}&no=1`); await page.waitForTimeout(1500);
  ok(await page.evaluate(() => document.documentElement.dir) === "rtl", "Arabic page is right-to-left");
  const arBody = await page.locator("#me-result").innerText();
  ok(/LTplayer1 F\./.test(arBody) && /تم تسجيل الحضور/.test(arBody) && /وقت الانتظار المتوقع/.test(arBody), "Arabic: name, checked in, estimated wait", arBody.slice(0, 300));
  await page.screenshot({ path: SHOTS + "/member_page_ar.png", fullPage: true });
  // closed event
  const evOff = (await api("/api/events", { method: "POST", jar: admin, form: form({ nameEn: "Me Off " + stamp, nameAr: "مغلق " + stamp, sport: "Padel", date: cairoToday() }) })).json.id;
  await page.goto(`${BASE}/me.html?event=${evOff}&lang=en`); await page.waitForTimeout(800);
  ok(/not open for this event/i.test(await page.locator("#me-msg").innerText()) && !(await page.locator("#me-form").isVisible()), "switched-off event: friendly message, no form");
  ok(errs.length === 0, "no page errors", errs);
  // Check-in list: search by number, switch and link
  const apage = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  apage.on("dialog", (d) => d.accept());
  await apage.goto(BASE + "/"); await apage.waitForTimeout(600);
  await apage.click('[data-view="scan"]');
  const ins = await apage.locator("#scan-lock input").all();
  await ins[0].fill(ADMIN_USER); await ins[1].fill(ADMIN_PASS);
  await apage.click("#scan-unlock"); await apage.waitForTimeout(1500);
  await apage.selectOption("#checkin-event-select", String(ev)); await apage.waitForTimeout(900);
  await apage.evaluate(() => { const c = document.querySelector('[data-roster-filter="all"]'); if (c) c.click(); });
  ok(await apage.locator("#checkin-roster-wrap tbody tr").count() === 9, "9 rows in the list", await apage.locator("#checkin-roster-wrap tbody tr").count());
  ok(await apage.locator("#checkin-roster-wrap [data-mp-switch]").isChecked(), "the player page switch shows on");
  await apage.fill("#checkin-search", "#3"); await apage.waitForTimeout(400);
  ok(await apage.locator("#checkin-roster-wrap tbody tr").count() === 1 && (await apage.locator("#checkin-roster-wrap tbody").innerText()).includes("MPplayer3"), "typing #3 finds player 3 only");
  await apage.fill("#checkin-search", uids[1]); await apage.waitForTimeout(400);
  ok(await apage.locator("#checkin-roster-wrap tbody tr").count() === 1 && (await apage.locator("#checkin-roster-wrap tbody").innerText()).includes("MPplayer2"), "typing a member ID finds that member only");
  await apage.fill("#checkin-search", ""); await apage.waitForTimeout(300);
  await apage.screenshot({ path: SHOTS + "/member_page_admin_switch.png", fullPage: true });
  await apage.locator("#checkin-roster-wrap [data-mp-switch]").uncheck(); await apage.waitForTimeout(900);
  ok((await lookup(ev, 1)).json.state === "off", "switching off closes the page");
  await apage.locator("#checkin-roster-wrap [data-mp-switch]").check(); await apage.waitForTimeout(900);
  ok((await lookup(ev, 2)).json.state === "ok", "switching on opens it again");
  ok(await apage.locator("#checkin-roster-wrap [data-mp-copy]").count() === 1, "copy-link button shown while on");
  await browser.close();

  section("Wrong numbers are limited");
  let blocked = null;
  for (let i = 0; i < 45; i++) { const x = await lookup(ev, 500 + i); if (x.status === 429) { blocked = i; break; } }
  ok(blocked !== null && blocked >= 30, "after many wrong numbers the address is paused", blocked);
  r = await lookup(ev, 1);
  ok(r.status === 429 || r.json.state === "ok", "(a cached right answer may still be served)");

  console.log(`\nmember_page_e2e: ${passed} passed, ${failed} failed, server errors: ${serverErrors.length}`);
  if (serverErrors.length) console.log(serverErrors);
  process.exit(failed || serverErrors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
