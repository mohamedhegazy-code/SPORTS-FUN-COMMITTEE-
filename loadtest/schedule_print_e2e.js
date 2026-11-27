// Printable schedule: by court (one page per court) and by time, for a real knockout, a group tournament and a practice run.
const { chromium } = require("/opt/node-tools/node_modules/playwright");
const BASE = process.env.BASE_URL || "http://localhost:3951";
const ADMIN = { username: "e2eadmin", password: "E2ETest!2026xyz" };
const SHOTS = process.env.SHOTS || "/tmp/shots_print"; require("fs").mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) pass++; else { fail++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };
const cairo = (n = 0) => new Date(Date.now() + n * 86400000).toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1100 } });
  const page = await ctx.newPage(); const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  const tok = async () => { const k = (await ctx.cookies()).find((x) => x.name === "csrfToken"); return k ? k.value : ""; };
  const get = async (path) => { const r = await ctx.request.get(BASE + path); return { status: r.status(), text: await r.text() }; };
  await ctx.request.get(BASE + "/");
  ok((await ctx.request.post(BASE + "/api/auth/staff-login", { data: ADMIN, headers: { "X-CSRF-Token": await tok() } })).ok(), "login");
  const stamp = Date.now().toString(36);
  const mk = async (n) => (await (await ctx.request.post(BASE + "/api/events", { multipart: { nameEn: n + stamp, nameAr: "طباعة " + n, sport: "PlayStation", date: cairo(3), maxCapacity: "64" }, headers: { "X-CSRF-Token": await tok() } })).json());
  const evK = await mk("PrintKO"), evG = await mk("PrintGR");
  await page.goto(BASE + "/"); await page.waitForTimeout(900);
  await page.click('[data-view="admin"]'); await page.waitForTimeout(600);
  await page.click('[data-admin-tab="tournaments"]'); await page.waitForTimeout(1200);
  async function newSim(eventId, players, form) {
    await page.selectOption("#tourn-event-select", String(eventId)); await page.waitForTimeout(400);
    await page.selectOption("#sim-mode", "dummy"); await page.fill("#sim-players", String(players));
    await page.click("#sim-create-btn"); await page.waitForTimeout(2000);
    await page.selectOption("#tourn-format", form.format);
    await page.fill("#tourn-courts", "6"); await page.fill("#tourn-match-minutes", "15"); await page.fill("#tourn-start-time", "15:00");
    if (form.groups) { await page.fill("#tourn-num-groups", String(form.groups)); await page.fill("#tourn-advance-per-group", "2"); }
    await page.click('[data-tourn-action="create-tournament"]'); await page.waitForTimeout(1000);
    await page.click('[data-tourn-action="generate-tournament"]'); await page.waitForTimeout(1500);
  }
  // ---- knockout 64 (practice run)
  await newSim(evK.id, 64, { format: "knockout" });
  await page.click('[data-rn-view="bracket"]'); await page.waitForTimeout(500);
  const links = await page.locator(".rn-print a, .rn-print-one a").evaluateAll((a) => a.map((x) => x.getAttribute("href")));
  ok(links.length === 8, "2 main + 6 per-court print links", links.length);
  ok(links.every((h) => /[?&]sim=\d+/.test(h)), "links carry the practice run id", links[0]);
  // play 2 matches so a result shows on the sheet
  await page.click('[data-rn-view="play"]'); await page.waitForTimeout(300);
  for (let i = 0; i < 2; i++) { await page.locator(".rn-card.is-now").first().locator(".rn-pick").first().click(); await page.waitForTimeout(150); await page.locator(".rn-card.is-now").first().locator('[data-rn-act="save-ko"]').click(); await page.waitForTimeout(900); }
  await page.click('[data-rn-view="bracket"]'); await page.waitForTimeout(400);
  const hrefAr = await page.locator(".rn-print a").first().getAttribute("href");
  const courtsAr = await get(hrefAr.replace("lang=en", "lang=ar"));
  ok(courtsAr.status === 200, "courts sheet loads", courtsAr.status);
  ok((courtsAr.text.match(/class="sheet"/g) || []).length === 6, "6 court pages", (courtsAr.text.match(/class="sheet"/g) || []).length);
  ok((courtsAr.text.match(/<tr class="/g) || []).length === 63, "63 match rows over all court pages", (courtsAr.text.match(/<tr class="/g) || []).length);
  ok(/dir="rtl"/.test(courtsAr.text) && /الملعب/.test(courtsAr.text), "Arabic RTL sheet");
  ok(/SIM Player/.test(courtsAr.text) && /لم يُحدد بعد/.test(courtsAr.text), "names + TBD placeholders");
  ok(/class="done"/.test(courtsAr.text), "played matches shown as done");
  const courtsEn = await get(hrefAr.replace("lang=ar", "lang=en"));
  ok(/dir="ltr"/.test(courtsEn.text) && /Court referee/.test(courtsEn.text), "English LTR sheet");
  const timeEn = await get(hrefAr.replace("view=courts", "view=time").replace("lang=ar", "lang=en"));
  ok(timeEn.status === 200 && /Full schedule by time/.test(timeEn.text) && /Matches per court per round/.test(timeEn.text), "time sheet with chart");
  ok((timeEn.text.match(/<tr class="/g) || []).length === 63, "time sheet has 63 rows");
  const one = await get(hrefAr.replace("lang=ar", "lang=en") + "&court=3");
  ok((one.text.match(/class="sheet"/g) || []).length === 1 && /court-badge[^]*?<b>3<\/b>/.test(one.text), "single-court sheet");
  // open in a browser and screenshot
  const p2 = await ctx.newPage();
  await p2.goto(BASE + hrefAr.replace("lang=en", "lang=ar") + "&court=1"); await p2.waitForTimeout(500);
  await p2.screenshot({ path: SHOTS + "/schedule_court_ar.png", fullPage: true });
  await p2.goto(BASE + hrefAr.replace("view=courts", "view=time").replace("lang=ar", "lang=en")); await p2.waitForTimeout(500);
  await p2.screenshot({ path: SHOTS + "/schedule_time_en.png", fullPage: true });
  await p2.pdf({ path: SHOTS + "/schedule_time_en.pdf", format: "A4", printBackground: true });
  // without the sim id the real tournament does not exist yet -> 404
  const real = await get(hrefAr.replace(/&sim=\d+/, ""));
  ok(real.status === 404, "no real tournament -> 404 (practice run data is not exposed)", real.status);
  // not signed in -> blocked
  const anon = await browser.newContext(); const ar = await anon.request.get(BASE + hrefAr);
  ok(ar.status() === 401 || ar.status() === 403 || ar.status() === 302, "anonymous cannot print", ar.status());
  // ---- groups + knockout
  await page.goto(BASE + "/"); await page.waitForTimeout(800);
  await page.click('[data-view="admin"]'); await page.waitForTimeout(500);
  await page.click('[data-admin-tab="tournaments"]'); await page.waitForTimeout(1000);
  await newSim(evG.id, 12, { format: "groups", groups: 3 });
  await page.click('[data-rn-view="bracket"]'); await page.waitForTimeout(500);
  const gl = await page.locator(".rn-print a").first().getAttribute("href");
  const gs = await get(gl.replace("lang=ar", "lang=en"));
  ok(gs.status === 200 && /Group A/.test(gs.text), "group-stage schedule sheet", gs.status);
  ok(errs.length === 0, "no page errors", errs);
  console.log(`Schedule print E2E: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
