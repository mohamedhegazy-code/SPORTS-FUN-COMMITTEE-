const { chromium } = require("/opt/node-tools/node_modules/playwright");
const BASE = "http://localhost:3951";
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) pass++; else { fail++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };
const iso = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
(async () => {
  const browser = await chromium.launch();
  const actx = await browser.newContext(); const ar = actx.request;
  const tok = async (c) => { const k = (await c.cookies()).find((x) => x.name === "csrfToken"); return k ? k.value : ""; };
  await ar.get(BASE + "/");
  await ar.post(BASE + "/api/auth/staff-login", { data: { username: "e2eadmin", password: "E2ETest!2026xyz" }, headers: { "X-CSRF-Token": await tok(actx) } });
  const ev = await (await ar.post(BASE + "/api/events", { multipart: { nameEn: "Gate Test", nameAr: "اختبار", sport: "Chess", date: iso(0) }, headers: { "X-CSRF-Token": await tok(actx) } })).json();
  // staff accounts: gate staff
  const sa = await ar.post(BASE + "/api/admin/staff", { data: { username: "gate1", name: "Gate One", password: "Gate!12345", role: "staff" }, headers: { "X-CSRF-Token": await tok(actx) } });
  console.log("staff create", sa.status());
  for (const [n, nm] of [["G1", "Ali Test"], ["G2", "Omar Test"]]) {
    const c = await browser.newContext(); await c.request.get(BASE + "/");
    await c.request.post(BASE + "/api/auth/signup", { data: { membershipNumber: n, name: nm, password: "abc12345", phone: "01061234567", agreeTerms: true, memberType: "main", birthDate: "1990-01-01" }, headers: { "X-CSRF-Token": await tok(c) } });
    const r = await c.request.post(BASE + "/api/register", { data: { eventId: ev.id }, headers: { "X-CSRF-Token": await tok(c) } });
    ok(r.ok(), "registered " + n);
  }
  async function loginGate(user, pass2) {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    const page = await ctx.newPage(); const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await page.goto(BASE + "/"); await page.waitForTimeout(600);
    await page.click('[data-view="scan"]');
    await page.fill("#scan-lock input:nth-of-type(1)", user);
    return { ctx, page, errs };
  }
  // admin
  {
    const { ctx, page, errs } = await loginGate("e2eadmin");
    const inputs = await page.locator("#scan-lock input").all();
    await inputs[0].fill("e2eadmin"); await inputs[1].fill("E2ETest!2026xyz");
    await page.click("#scan-unlock"); await page.waitForTimeout(1200);
    await page.selectOption("#checkin-event-select", String(ev.id)); await page.waitForTimeout(800);
    ok(await page.locator("#checkin-roster-wrap [data-att-conf]").count() === 4, "two buttons per member");
    const chip = async (k) => Number(await page.locator('[data-roster-filter="' + k + '"] b').first().innerText());
    ok(await chip("noreply") === 2, "2 no answer at start");
    await page.locator('#checkin-roster-wrap .conf-yes').first().click(); await page.waitForTimeout(800);
    ok(await chip("conf") === 1 && await chip("noreply") === 1, "1 confirmed, 1 no answer", [await chip("conf"), await chip("noreply")]);
    await page.locator('#checkin-roster-wrap tbody tr').nth(1).locator('.conf-no').click(); await page.waitForTimeout(800);
    ok(await chip("decl") === 1 && await chip("noreply") === 0, "1 declined");
    await page.screenshot({ path: "/tmp/regtest/t/gate_conf.png", fullPage: true });
    await page.locator('#checkin-roster-wrap .conf-yes.on').first().click(); await page.waitForTimeout(800);
    ok(await chip("conf") === 0 && await chip("noreply") === 1, "tap again clears", [await chip("conf"), await chip("noreply")]);
    await page.click('[data-roster-filter="decl"]'); await page.waitForTimeout(300);
    ok(await page.locator("#checkin-roster-wrap tbody tr").count() === 1, "declined filter shows 1 row");
    // Arabic
    await page.evaluate(() => setLang("ar")); await page.waitForTimeout(600);
    ok((await page.locator("#checkin-roster-wrap thead").innerText()).includes("تأكيد الحضور"), "Arabic column header");
    await page.screenshot({ path: "/tmp/regtest/t/gate_conf_ar.png", fullPage: true });
    ok(errs.length === 0, "no page errors", errs);
    await ctx.close();
  }
  // API guards
  {
    const regs = await (await ar.get(BASE + "/api/staff/events/" + ev.id + "/roster")).json();
    const r0 = regs[0];
    const bad = await ar.post(BASE + "/api/staff/registrations/" + r0.registrationId + "/attendance-confirmation", { data: { status: "maybe" }, headers: { "X-CSRF-Token": await tok(actx) } });
    ok(bad.status() === 400, "invalid status rejected");
    const nf = await ar.post(BASE + "/api/staff/registrations/99999/attendance-confirmation", { data: { status: "yes" }, headers: { "X-CSRF-Token": await tok(actx) } });
    ok(nf.status() === 404, "unknown registration 404");
    const ci = await ar.post(BASE + "/api/checkin/manual", { data: { registrationId: r0.registrationId }, headers: { "X-CSRF-Token": await tok(actx) } });
    const after = await ar.post(BASE + "/api/staff/registrations/" + r0.registrationId + "/attendance-confirmation", { data: { status: "yes" }, headers: { "X-CSRF-Token": await tok(actx) } });
    ok(ci.ok() && after.status() === 409, "checked-in person can't be confirmed", [ci.status(), after.status()]);
  }
  // gate-only staff
  {
    const { ctx, page } = await loginGate("gate1");
    const inputs = await page.locator("#scan-lock input").all();
    await inputs[0].fill("gate1"); await inputs[1].fill("Gate!12345");
    await page.click("#scan-unlock"); await page.waitForTimeout(1500);
    const pwModal = await page.locator("#must-change-password-modal, .modal-overlay:not(.hidden)").count();
    console.log("modals open:", pwModal);
    await page.screenshot({ path: "/tmp/regtest/t/gate_staff.png" });
    await ctx.close();
  }
  console.log(`passed ${pass} failed ${fail}`);
  await browser.close();
})();
