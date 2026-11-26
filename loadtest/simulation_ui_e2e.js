// UI test for tournament simulations: Tournament Manager (event-day gating + auto-load), the
// practice card, banner, auto-play, what-if comparison, English and Arabic, and the admin view.
const { chromium } = require("/opt/node-tools/node_modules/playwright");
const BASE = process.env.BASE_URL || "http://localhost:3951";
const ADMIN = { username: "e2eadmin", password: "E2ETest!2026xyz" };
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) pass++; else { fail++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };
const cairo = (n = 0) => new Date(Date.now() + n * 86400000).toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
(async () => {
  const browser = await chromium.launch();
  const tok = async (c) => { const k = (await c.cookies()).find((x) => x.name === "csrfToken"); return k ? k.value : ""; };
  const actx = await browser.newContext(); const ar = actx.request;
  await ar.get(BASE + "/");
  const lg = await ar.post(BASE + "/api/auth/staff-login", { data: ADMIN, headers: { "X-CSRF-Token": await tok(actx) } });
  ok(lg.ok(), "admin login");
  const stamp = Date.now().toString(36);
  const mgrName = "uimgr" + stamp;
  const acc = await ar.post(BASE + "/api/staff/accounts", { data: { username: mgrName, password: "Manager#1234", name: "UI Manager", role: "tournament" }, headers: { "X-CSRF-Token": await tok(actx) } });
  ok(acc.status() === 201, "manager account", await acc.text());
  {
    const c = await browser.newContext(); await c.request.get(BASE + "/");
    await c.request.post(BASE + "/api/auth/staff-login", { data: { username: mgrName, password: "Manager#1234" }, headers: { "X-CSRF-Token": await tok(c) } });
    const cp = await c.request.post(BASE + "/api/auth/change-password", { data: { oldPassword: "Manager#1234", newPassword: "Manager#5678" }, headers: { "X-CSRF-Token": await tok(c) } });
    ok(cp.ok(), "manager sets own password", await cp.text());
    await c.close();
  }
  const mkEv = async (name, date) => (await (await ar.post(BASE + "/api/events", { multipart: { nameEn: name + stamp, nameAr: name, sport: "Chess", date, maxCapacity: "16", managerUsernames: JSON.stringify([mgrName]) }, headers: { "X-CSRF-Token": await tok(actx) } })).json());
  const evF = await mkEv("UiFuture", cairo(20));
  const evT = await mkEv("UiToday", cairo(0));
  ok(evF.id && evT.id, "events created");
  const tr = await ar.post(BASE + "/api/admin/tournaments/" + evT.id, { data: { mode: "individual", format: "knockout", courts: 2, matchMinutes: 15, startTime: "09:00" }, headers: { "X-CSRF-Token": await tok(actx) } });
  ok(tr.status() === 201, "real tournament for today's event", await tr.text());
  for (const n of ["UA" + stamp, "UB" + stamp]) {
    const c = await browser.newContext(); await c.request.get(BASE + "/");
    await c.request.post(BASE + "/api/auth/signup", { data: { membershipNumber: n, name: "Real " + n, password: "abc12345", phone: "01061234567", agreeTerms: true, memberType: "main", birthDate: "1990-01-01" }, headers: { "X-CSRF-Token": await tok(c) } });
    const r = await c.request.post(BASE + "/api/register", { data: { eventId: evF.id }, headers: { "X-CSRF-Token": await tok(c) } });
    ok(r.ok(), "registered " + n);
  }

  async function openTournamentsTab(user, pass2) {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
    const page = await ctx.newPage(); const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await ctx.request.get(BASE + "/");
    const r = await ctx.request.post(BASE + "/api/auth/staff-login", { data: { username: user, password: pass2 }, headers: { "X-CSRF-Token": await tok(ctx) } });
    ok(r.ok(), "login " + user, await r.text());
    await page.goto(BASE + "/"); await page.waitForTimeout(900);
    await page.click('[data-view="admin"]'); await page.waitForTimeout(700);
    await page.click('[data-admin-tab="tournaments"]'); await page.waitForTimeout(1500);
    return { ctx, page, errs };
  }

  // ---------- Tournament Manager
  {
    const { ctx, page, errs } = await openTournamentsTab(mgrName, "Manager#5678");
    ok((await page.locator("#tourn-event-select").inputValue()) === String(evT.id), "event day: today's event is picked automatically");
    ok(await page.locator("#tourn-body .tourn-hero").count() === 1, "event day: the real tournament loaded by itself");
    ok(!(await page.locator("#sim-banner").isVisible()), "no simulation banner in real mode");
    // future event -> not open
    await page.selectOption("#tourn-event-select", String(evF.id)); await page.waitForTimeout(500);
    await page.click("#tourn-load"); await page.waitForTimeout(1000);
    ok(await page.locator("#tourn-body .sim-not-open").count() === 1, "future event: friendly 'not open yet' message");
    ok((await page.locator("#tourn-body .sim-not-open").innerText()).includes(cairo(20)), "message shows the opening date");
    ok(await page.locator("#sim-card").isVisible(), "practice card is available");
    // create a dummy simulation
    await page.selectOption("#sim-mode", "dummy");
    await page.fill("#sim-players", "12");
    await page.fill("#sim-name", "Rehearsal A");
    await page.click("#sim-create-btn"); await page.waitForTimeout(1800);
    ok(await page.locator("#sim-banner").isVisible(), "banner shown once the simulation opens");
    ok((await page.locator("#sim-banner").innerText()).includes("Rehearsal A"), "banner shows the name");
    ok(await page.locator(".sim-row.active").count() === 1, "list highlights the open simulation");
    ok(await page.locator("#tourn-body #tourn-format").count() === 1, "empty simulation shows the tournament creation form");
    // create the tournament via the normal form
    await page.selectOption("#tourn-format", "knockout");
    await page.fill("#tourn-courts", "2"); await page.fill("#tourn-match-minutes", "20"); await page.fill("#tourn-start-time", "10:00");
    await page.click('[data-tourn-action="create-tournament"]'); await page.waitForTimeout(1200);
    ok(await page.locator("#tourn-body .tourn-hero").count() === 1, "tournament created inside the simulation");
    ok(await page.locator("#tourn-body .tourn-live-link").count() === 0, "no link to the real public matches page in a simulation");
    await page.click('[data-sim-auto="draw"]'); await page.waitForTimeout(1200);
    ok((await page.locator("#sim-auto-msg").innerText()).length > 0, "draw message");
    ok(await page.locator("#tourn-body .bracket, #tourn-body .tourn-card-live").count() > 0, "draw is shown");
    // by hand: stage then end
    await page.click('[data-sim-auto="end"]'); await page.waitForTimeout(1500);
    ok((await page.locator("#tourn-body").innerText()).toLowerCase().includes("final") || (await page.locator("#tourn-body .tourn-card-standings").count()) > 0, "tournament played to the end");
    await page.screenshot({ path: "/tmp/regtest/t/sim_done.png", fullPage: true });
    // what-if
    await page.click("[data-sim-whatif-toggle]"); await page.waitForTimeout(500);
    ok(await page.locator("#sim-whatif-panel").isVisible(), "what-if panel opens");
    ok(await page.locator("#sim-whatif tr[data-wi-row]").count() === 2, "two starting scenarios (current + one more court)");
    await page.click("[data-wi-run]"); await page.waitForTimeout(1000);
    const finishes = await page.locator(".sim-wi-finish strong").allInnerTexts();
    ok(finishes.length === 2 && finishes.every((x) => /^\d\d:\d\d$/.test(x)), "finish times shown for both scenarios", finishes);
    ok(await page.locator(".sim-wi-finish.best").count() >= 1, "fastest scenario highlighted");
    await page.click("[data-wi-add]"); await page.waitForTimeout(300);
    ok(await page.locator("#sim-whatif tr[data-wi-row]").count() === 3, "scenario added");
    await page.screenshot({ path: "/tmp/regtest/t/sim_whatif.png", fullPage: true });
    // real data untouched
    const real = await (await ar.get(BASE + "/api/admin/tournaments/" + evF.id)).json();
    ok(real.tournament === null && real.registrations.length === 2, "REAL future event has no tournament and still 2 registrants", real);
    // Arabic
    await page.evaluate(() => setLang("ar")); await page.waitForTimeout(700);
    await page.click('[data-admin-tab="tournaments"]'); await page.waitForTimeout(600);
    ok((await page.locator("#sim-card h2").innerText()).includes("محاكاة"), "Arabic card title");
    await page.screenshot({ path: "/tmp/regtest/t/sim_ar.png", fullPage: true });
    await page.evaluate(() => setLang("en")); await page.waitForTimeout(500);
    // exit
    await page.click("[data-sim-exit]"); await page.waitForTimeout(1200);
    ok(!(await page.locator("#sim-banner").isVisible()), "banner gone after exit");
    ok(await page.locator("#tourn-body .sim-not-open").count() === 1, "back to the real (not-open) view");
    // delete
    page.once("dialog", (d) => d.accept());
    await page.click("[data-sim-delete]"); await page.waitForTimeout(1000);
    ok(await page.locator(".sim-row").count() === 0, "simulation deleted");
    ok(errs.length === 0, "no page errors (manager)", errs);
    await ctx.close();
  }
  // ---------- Admin
  {
    const { ctx, page, errs } = await openTournamentsTab(ADMIN.username, ADMIN.password);
    await page.selectOption("#tourn-event-select", String(evF.id)); await page.waitForTimeout(500);
    await page.click("#tourn-load"); await page.waitForTimeout(1000);
    ok(await page.locator("#tourn-body .sim-not-open").count() === 0, "admin is never held back");
    await page.selectOption("#sim-mode", "registrants");
    ok(!(await page.locator("#sim-players-wrap").isVisible()), "player count hidden for registrants-only");
    await page.click("#sim-create-btn"); await page.waitForTimeout(1500);
    ok(await page.locator("#sim-banner").isVisible(), "admin can run a simulation with the real registrants");
    ok((await page.locator(".sim-row.active").innerText()).includes("2 players"), "the two real registrants are the players");
    ok(errs.length === 0, "no page errors (admin)", errs);
    await ctx.close();
  }
  await browser.close();
  console.log(`passed ${pass} failed ${fail}`);
  process.exit(fail ? 1 : 0);
})();
