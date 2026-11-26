// UI test: "Matches per court per round" chart on the Bracket & tables tab (64-player knockout, 6 courts, EN + AR).
const { chromium } = require("/opt/node-tools/node_modules/playwright");
const BASE = process.env.BASE_URL || "http://localhost:3951";
const ADMIN = { username: "e2eadmin", password: "E2ETest!2026xyz" };
const SHOTS = process.env.SHOTS || "/tmp/shots_cc";
require("fs").mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) pass++; else { fail++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };
const cairo = (n = 0) => new Date(Date.now() + n * 86400000).toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1100 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage(); const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  const tok = async () => { const k = (await ctx.cookies()).find((x) => x.name === "csrfToken"); return k ? k.value : ""; };
  await ctx.request.get(BASE + "/");
  ok((await ctx.request.post(BASE + "/api/auth/staff-login", { data: ADMIN, headers: { "X-CSRF-Token": await tok() } })).ok(), "login");
  const stamp = Date.now().toString(36);
  const ev = await (await ctx.request.post(BASE + "/api/events", { multipart: { nameEn: "CourtChart" + stamp, nameAr: "CourtChart", sport: "PlayStation", date: cairo(3), maxCapacity: "64" }, headers: { "X-CSRF-Token": await tok() } })).json();
  await page.goto(BASE + "/"); await page.waitForTimeout(900);
  await page.click('[data-view="admin"]'); await page.waitForTimeout(600);
  await page.click('[data-admin-tab="tournaments"]'); await page.waitForTimeout(1200);
  await page.selectOption("#tourn-event-select", String(ev.id)); await page.waitForTimeout(400);
  await page.selectOption("#sim-mode", "dummy"); await page.fill("#sim-players", "64");
  await page.click("#sim-create-btn"); await page.waitForTimeout(2000);
  await page.selectOption("#tourn-format", "knockout");
  await page.fill("#tourn-courts", "6"); await page.fill("#tourn-match-minutes", "15"); await page.fill("#tourn-start-time", "15:00");
  await page.click('[data-tourn-action="create-tournament"]'); await page.waitForTimeout(1000);
  await page.click('[data-tourn-action="generate-tournament"]'); await page.waitForTimeout(1500);
  await page.click('[data-rn-view="bracket"]'); await page.waitForTimeout(500);
  const tbl = page.locator(".cc-table");
  ok(await tbl.count() === 1, "chart is shown on the Bracket & tables tab");
  const heads = await tbl.locator("thead th").allInnerTexts();
  ok(heads.length === 8, "court + 6 rounds + total columns", heads);
  const rows = await tbl.locator("tbody tr").count();
  ok(rows === 6, "one row per court", rows);
  const cellNums = async (r) => (await tbl.locator(`tbody tr:nth-child(${r}) td b`).allInnerTexts()).map(Number);
  const r1 = await cellNums(1), r6 = await cellNums(6);
  ok(r1[r1.length - 1] === 11 || r1[r1.length - 1] === 10, "court 1 total is 10 or 11", r1);
  ok(r6[r6.length - 1] === 11 || r6[r6.length - 1] === 10, "court 6 total is 10 or 11", r6);
  const foot = (await tbl.locator("tfoot td b").allInnerTexts()).map(Number);
  ok(JSON.stringify(foot) === JSON.stringify([32, 16, 8, 4, 2, 1, 63]), "column totals 32/16/8/4/2/1 and 63", foot);
  ok((await page.locator("#rn-list .hint-note").first().innerText()).includes("evenly"), "says the courts are evenly loaded");
  await page.locator(".cc-table").scrollIntoViewIfNeeded();
  await page.locator("#rn-root").screenshot({ path: SHOTS + "/court_chart_en.png" });
  // play 3 matches -> played counts appear
  await page.click('[data-rn-view="play"]'); await page.waitForTimeout(300);
  for (let i = 0; i < 3; i++) {
    await page.locator(".rn-card.is-now").first().locator(".rn-pick").first().click(); await page.waitForTimeout(150);
    await page.locator(".rn-card.is-now").first().locator('[data-rn-act="save-ko"]').click(); await page.waitForTimeout(1000);
  }
  await page.click('[data-rn-view="bracket"]'); await page.waitForTimeout(400);
  ok(await page.locator(".cc-table td small").count() >= 1, "played counts shown after results");
  // Arabic
  await page.evaluate(() => setLang("ar")); await page.waitForTimeout(600);
  const ttl = await page.locator("#rn-root .rn-h").first().innerText();
  ok(/عدد المباريات/.test(ttl), "Arabic title", ttl);
  await page.locator("#rn-root").screenshot({ path: SHOTS + "/court_chart_ar.png" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  ok(!overflow, "no horizontal page scroll");
  ok(errs.length === 0, "no page errors", errs);
  console.log(`Court chart UI E2E: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
