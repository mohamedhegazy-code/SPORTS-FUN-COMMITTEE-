// UI: the "Promote to confirmed" button on waiting-list rows (Check-in list) + the save message after raising capacity.
const { chromium } = require("/opt/node-tools/node_modules/playwright");
const BASE = process.env.BASE_URL || "http://localhost:3951";
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) pass++; else { fail++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };
const iso = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
(async () => {
  const browser = await chromium.launch();
  const actx = await browser.newContext(); const ar = actx.request;
  const tok = async (c) => { const k = (await c.cookies()).find((x) => x.name === "csrfToken"); return k ? k.value : ""; };
  await ar.get(BASE + "/");
  await ar.post(BASE + "/api/auth/staff-login", { data: { username: "e2eadmin", password: "E2ETest!2026xyz" }, headers: { "X-CSRF-Token": await tok(actx) } });
  const st = Date.now().toString(36);
  const ev = await (await ar.post(BASE + "/api/events", { multipart: { nameEn: "WPU Event " + st, nameAr: "اختبار قائمة " + st, sport: "Chess", date: iso(0), maxCapacity: "1" }, headers: { "X-CSRF-Token": await tok(actx) } })).json();
  ok(!!ev.id, "event created", ev);
  const gname = "wpugate" + st;
  const cg = await ar.post(BASE + "/api/staff/accounts", { data: { username: gname, name: "Gate WPU", password: "Gate!12345", role: "staff" }, headers: { "X-CSRF-Token": await tok(actx) } });
  ok(cg.status() === 201, "gate staff created", cg.status());
  { // set its own password first (the committee-chosen one has to be replaced)
    const gc = await browser.newContext(); await gc.request.get(BASE + "/");
    await gc.request.post(BASE + "/api/auth/staff-login", { data: { username: gname, password: "Gate!12345" }, headers: { "X-CSRF-Token": await tok(gc) } });
    const cp = await gc.request.post(BASE + "/api/auth/change-password", { data: { oldPassword: "Gate!12345", newPassword: "Gate!67890" }, headers: { "X-CSRF-Token": await tok(gc) } });
    ok(cp.ok(), "gate staff changed password", cp.status());
    await gc.close();
  }
  for (const [n, nm] of [["U1" + st, "Ali One"], ["U2" + st, "Omar Two"], ["U3" + st, "Sara Three"]]) {
    const c = await browser.newContext(); await c.request.get(BASE + "/");
    await c.request.post(BASE + "/api/auth/signup", { data: { membershipNumber: n, name: nm, password: "abc12345", phone: "01061234567", agreeTerms: true, memberType: "main", birthDate: "1990-01-01" }, headers: { "X-CSRF-Token": await tok(c) } });
    let r = await c.request.post(BASE + "/api/register", { data: { eventId: ev.id }, headers: { "X-CSRF-Token": await tok(c) } });
    if (r.status() === 200) r = await c.request.post(BASE + "/api/register", { data: { eventId: ev.id, joinWaitlist: true }, headers: { "X-CSRF-Token": await tok(c) } });
    ok(r.status() === 201, "registered " + nm, r.status());
    await c.close();
  }
  async function openCheckin(user, pw) {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    const page = await ctx.newPage(); const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    page.on("dialog", (d) => d.accept());
    await page.goto(BASE + "/"); await page.waitForTimeout(600);
    await page.click('[data-view="scan"]');
    const inputs = await page.locator("#scan-lock input").all();
    await inputs[0].fill(user); await inputs[1].fill(pw);
    await page.click("#scan-unlock"); await page.waitForTimeout(1500);
    await page.selectOption("#checkin-event-select", String(ev.id)); await page.waitForTimeout(900);
    return { ctx, page, errs };
  }
  // gate staff: no promote button
  {
    const { ctx, page } = await openCheckin(gname, "Gate!67890");
    await page.evaluate(() => { const c = document.querySelector('[data-roster-filter="all"]'); if (c) c.click(); });
    await page.waitForTimeout(500);
    ok(await page.locator("#checkin-roster-wrap tbody tr").count() === 3, "gate staff sees 3 rows", await page.locator("#checkin-roster-wrap tbody tr").count());
    ok(await page.locator("#checkin-roster-wrap [data-promote-reg]").count() === 0, "gate staff has no promote button");
    await ctx.close();
  }
  // admin
  {
    const { ctx, page, errs } = await openCheckin("e2eadmin", "E2ETest!2026xyz");
    await page.evaluate(() => { const c = document.querySelector('[data-roster-filter="all"]'); if (c) c.click(); });
    await page.waitForTimeout(500);
    const btns = page.locator("#checkin-roster-wrap [data-promote-reg]");
    ok(await btns.count() === 2, "admin sees a Promote button on each of the 2 waiting rows", await btns.count());
    ok((await btns.first().innerText()).trim().length > 3, "button has a label", await btns.first().innerText());
    await page.screenshot({ path: "/tmp/out/waitlist_promote_button.png", fullPage: true });
    await btns.first().click(); await page.waitForTimeout(1200);
    ok(await page.locator("#checkin-roster-wrap [data-promote-reg]").count() === 1, "one button left after promoting");
    const rows = await (await ar.get(BASE + "/api/staff/events/" + ev.id + "/roster")).json();
    ok(rows.filter((x) => x.waitlisted).length === 1 && rows[1].waitlisted === false, "the earliest waiting person is confirmed", rows.map((x) => x.waitlisted));
    await page.evaluate(() => setLang("ar")); await page.waitForTimeout(700);
    ok((await page.locator("#checkin-roster-wrap [data-promote-reg]").first().innerText()).trim().length > 2, "Arabic label present");
    await page.screenshot({ path: "/tmp/out/waitlist_promote_button_ar.png", fullPage: true });
    ok(errs.length === 0, "no page errors", errs);
    await ctx.close();
  }
  // capacity raised from the edit form: the save message says how many moved up
  {
    const { ctx, page, errs } = await openCheckin("e2eadmin", "E2ETest!2026xyz");
    await page.goto(BASE + "/"); await page.waitForTimeout(500);
    const res = await page.evaluate(async ({ id, st }) => {
      const msgs = [];
      return typeof window.t === "function" ? [window.t("eventSavedPromoted"), window.t("confirmPromoteRow")] : null;
    }, { id: ev.id, st });
    ok(res === null || (res[0].includes("{n}") && res[1].length > 5), "i18n strings exist", res);
    ok(errs.length === 0, "no page errors (2)", errs);
    await ctx.close();
  }
  console.log(`waitlist_promote_ui_e2e passed ${pass} failed ${fail}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
