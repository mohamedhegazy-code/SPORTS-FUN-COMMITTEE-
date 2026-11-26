// Phone UI test of player-reported scores: member card (report / confirm / dispute), manager attention list + override.
// Usage: BASE_URL=http://localhost:3951 node player_scores_ui_e2e.js
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

(async () => {
  const stamp = Date.now().toString(36);
  const admin = await prime({});
  ok((await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } })).status === 200, "admin login");
  const ev = (await api("/api/events", { method: "POST", jar: admin, form: form({ nameEn: "PSUI " + stamp, nameAr: "بطولة " + stamp, sport: "Padel", date: cairoToday() }) })).json.id;
  const players = {};
  const mk = async (i) => {
    const jar = await prime({}); const num = `PU${stamp}${i}`; const name = `PU${i} ${stamp}`;
    await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: num, name, password: "abc12345", phone: `0101${String(i).padStart(7, "0")}`, agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
    await api("/api/register", { method: "POST", jar, body: { eventId: ev } });
    players[name] = { jar, name };
    return players[name];
  };
  for (let i = 1; i <= 4; i++) await mk(i);
  let r = await api(`/api/admin/tournaments/${ev}`, { method: "POST", jar: admin, body: { mode: "individual", format: "knockout", courts: 2, matchMinutes: 15, startTime: "09:00" } });
  ok(r.status === 201, "create knockout", r.json);
  r = await api(`/api/admin/tournaments/${ev}/generate`, { method: "POST", jar: admin });
  ok(r.status === 200, "generate", r.json);
  const [m0, m1] = r.json.tournament.knockout.rounds[0];
  const A = players[m0.aLabel], B = players[m0.bLabel], C = players[m1.aLabel], D = players[m1.bLabel];
  ok(A && B && C && D, "players mapped");

  const browser = await chromium.launch();
  const mkCtx = async (jar, mobile) => {
    const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } : { viewport: { width: 1200, height: 900 } });
    await ctx.addCookies(Object.entries(jar).map(([name, value]) => ({ name, value, url: BASE })));
    const page = await ctx.newPage(); const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    page.errs = errs;
    return page;
  };
  const openProfile = async (page, lang) => {
    await page.goto(BASE + "/"); await page.waitForTimeout(900);
    if (lang === "ar") { await page.evaluate(() => setLang("ar")); await page.waitForTimeout(300); }
    await page.click('[data-view="mypoints"]'); await page.waitForTimeout(1200);
  };
  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);

  section("switch off -> no card");
  const pA = await mkCtx(A.jar, true);
  await openProfile(pA);
  ok(await pA.locator("#mp-matches-card:not(.hidden)").count() === 0, "card hidden while the switch is off");

  section("manager turns the switch on (UI)");
  const pM = await mkCtx(admin, false);
  const openManager = async () => {
    await pM.goto(BASE + "/"); await pM.waitForTimeout(900);
    await pM.click('[data-view="admin"]'); await pM.waitForTimeout(600);
    await pM.click('[data-admin-tab="tournaments"]'); await pM.waitForTimeout(1200);
    await pM.selectOption("#tourn-event-select", String(ev)); await pM.click("#tourn-load"); await pM.waitForTimeout(1500);
  };
  await openManager();
  ok(await pM.locator(".ps-switch").count() === 1 && await pM.locator(".ps-switch.on").count() === 0, "switch is shown, off");
  await pM.locator('[data-ps-mgr="toggle"]').click(); await pM.waitForTimeout(1200);
  ok(await pM.locator(".ps-switch.on").count() === 1, "switch is on");
  ok((await api(`/api/admin/tournaments/${ev}`, { jar: admin })).json.tournament.playerScores === true, "saved on the server");

  section("player A reports from the phone");
  await openProfile(pA);
  ok(await pA.locator("#mp-matches-card:not(.hidden)").count() === 1, "card appears");
  let card = pA.locator(".ps-card.ps-to_report").first();
  ok(await card.count() === 1, "one match to report");
  ok(await card.locator('[data-ps-act="send"]').isDisabled(), "send disabled until a score is entered");
  const bp = await card.locator('[data-ps-act="inc"]').first().boundingBox();
  ok(bp && bp.height >= 44, "stepper is a big touch target", bp);
  for (let i = 0; i < 3; i++) await card.locator('[data-ps-act="inc"][data-ps-who="me"]').tap();
  await card.locator('[data-ps-act="inc"][data-ps-who="opp"]').tap(); await pA.waitForTimeout(200);
  card = pA.locator(".ps-card.ps-to_report").first();
  ok((await card.locator("output").first().innerText()) === "3", "my score shows 3");
  ok(!(await card.locator('[data-ps-act="send"]').isDisabled()), "send enabled");
  ok(await noOverflow(pA), "no horizontal scroll at 390px");
  await card.locator('[data-ps-act="send"]').tap(); await pA.waitForTimeout(1500);
  ok(await pA.locator(".ps-card.ps-waiting_opponent").count() === 1, "A now waits for the opponent");
  ok((await pA.locator(".ps-card.ps-waiting_opponent .ps-score").innerText()).includes("3 – 1"), "A sees 3 - 1");
  ok(await pA.locator('[data-ps-act="retract"]').count() === 1, "A can take it back");
  await pA.locator("#mp-matches-card").screenshot({ path: "/tmp/ps_phone_waiting.png" });

  section("opponent B confirms / disputes");
  const pB = await mkCtx(B.jar, true);
  await openProfile(pB);
  ok(await pB.locator(".ps-card.ps-to_confirm").count() === 1, "B has a score to confirm");
  ok((await pB.locator("#mp-match-badge").innerText()) === "1" && await pB.locator("#mp-match-badge:not(.hidden)").count() === 1, "tab badge shows 1");
  ok((await pB.locator(".ps-card.ps-to_confirm .ps-score").innerText()).includes("1 – 3"), "B sees the score from their side (1 - 3)");
  await pB.locator('[data-ps-act="dispute"]').tap(); await pB.waitForTimeout(200);
  ok(await pB.locator(".ps-note").count() === 1, "dispute note box opens");
  await pB.locator(".ps-note").fill("I won 3-2");
  await pB.locator('[data-ps-act="dispute-send"]').tap(); await pB.waitForTimeout(1500);
  ok(await pB.locator(".ps-card.ps-disputed").count() === 1, "B sees disputed state");
  ok(await pB.locator("#mp-match-badge:not(.hidden)").count() === 0, "badge gone");

  section("manager sees what needs attention and overrides");
  await openManager();
  ok(await pM.locator(".rn-h-attn").count() === 1, "'Needs your attention' heading");
  const att = pM.locator(".rn-card.has-report").first();
  ok(await att.count() === 1 && await att.locator(".ps-notice.bad").count() === 1, "disputed card is flagged");
  ok((await att.locator(".ps-notice").innerText()).includes("I won 3-2"), "dispute note shown to the manager");
  ok(await att.locator(".rn-pick.picked").count() === 1, "winner prefilled from the report");
  ok((await att.locator(".rn-step output").first().innerText()) === "3", "score prefilled from the report");
  await pM.locator("#rn-root").screenshot({ path: "/tmp/ps_manager_attention.png" });
  await att.locator('[data-rn-act="save-ko"]').click(); await pM.waitForTimeout(1500);
  ok(await pM.locator(".has-report").count() === 0, "attention cleared after saving");
  const t1 = (await api(`/api/admin/tournaments/${ev}`, { jar: admin })).json.tournament.knockout.rounds[0][0];
  ok(t1.winnerId && t1.scoreA != null && !t1.report, "result recorded, report gone", t1);
  await openProfile(pB);
  ok(await pB.locator(".ps-card.ps-done").count() >= 1, "B sees the final result");

  section("second match: report -> confirm (phone, Arabic)");
  const pC = await mkCtx(C.jar, true), pD = await mkCtx(D.jar, true);
  await openProfile(pC);
  let cc = pC.locator(".ps-card.ps-to_report").first();
  await cc.locator('[data-ps-act="inc"][data-ps-who="opp"]').tap();
  await cc.locator('[data-ps-act="inc"][data-ps-who="opp"]').tap(); await pC.waitForTimeout(150);
  await pC.locator(".ps-card.ps-to_report").first().locator('[data-ps-act="send"]').tap(); await pC.waitForTimeout(1500);
  await openProfile(pD, "ar");
  ok(await pD.locator(".ps-card.ps-to_confirm").count() === 1, "D has it to confirm (Arabic UI)");
  ok((await pD.locator("#mp-matches-card h2").innerText()).includes("مبارياتي"), "card title in Arabic");
  ok(await noOverflow(pD), "no horizontal scroll in Arabic at 390px");
  await pD.locator('[data-ps-act="confirm"]').tap(); await pD.waitForTimeout(1500);
  ok(await pD.locator(".ps-card.ps-done").count() >= 1, "D sees it as final after confirming");
  ok((await pD.locator(".ps-card.ps-done .ps-score").first().innerText()).includes("2"), "final score shown");
  const t2 = (await api(`/api/admin/tournaments/${ev}`, { jar: admin })).json.tournament.knockout.rounds[0][1];
  ok(t2.winnerId === m1.b && t2.scoreB === 2, "confirmed result is official; winner advances", t2);

  section("switch off again");
  await openManager();
  await pM.locator('[data-ps-mgr="toggle"]').click(); await pM.waitForTimeout(1200);
  ok(await pM.locator(".ps-switch.on").count() === 0, "switch off");
  await openProfile(pA);
  ok(await pA.locator("#mp-matches-card:not(.hidden)").count() === 0, "player card disappears");

  const allErrs = [pA, pB, pC, pD, pM].flatMap((p) => p.errs);
  ok(allErrs.length === 0, "no page errors", allErrs);
  ok(serverErrors.length === 0, "no 5xx", serverErrors);
  await browser.close();
  console.log(`\nplayer_scores_ui_e2e: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
