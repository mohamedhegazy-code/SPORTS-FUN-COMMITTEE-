const { chromium } = require("/opt/node-tools/node_modules/playwright");
const BASE = "http://localhost:3951";
const ADMIN = { username: "e2eadmin", password: "E2ETest!2026xyz" };
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) pass++; else { fail++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };
const iso = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
(async () => {
  const browser = await chromium.launch();
  // --- setup via API from a browser context request
  const actx = await browser.newContext();
  const ar = actx.request;
  const csrf = async () => { const c = (await actx.cookies()).find((c) => c.name === "csrfToken"); return c ? c.value : ""; };
  await ar.get(BASE + "/");
  let r = await ar.post(BASE + "/api/auth/staff-login", { data: ADMIN, headers: { "X-CSRF-Token": await csrf() } });
  ok(r.ok(), "admin login", await r.text());
  const mk = async (fields) => { const r = await ar.post(BASE + "/api/events", { multipart: fields, headers: { "X-CSRF-Token": await csrf() } }); const j = await r.json(); if (!r.ok()) console.log("mk fail", j); return j; };
  const evA = await mk({ nameEn: "Padel Night", nameAr: "ليلة البادل", sport: "Padel", date: iso(5), startTime: "19:00", endTime: "21:00", maxCapacity: "10" });
  const evFull = await mk({ nameEn: "Chess Cup", nameAr: "كأس الشطرنج", sport: "Chess", date: iso(6), maxCapacity: "1" });
  // member
  const mctx = await browser.newContext();
  const mr = mctx.request;
  await mr.get(BASE + "/");
  const mcsrf = async () => { const c = (await mctx.cookies()).find((c) => c.name === "csrfToken"); return c ? c.value : ""; };
  const mkMember = async (ctx, num, name) => {
    const q = ctx.request; await q.get(BASE + "/");
    const tok = async () => { const c = (await ctx.cookies()).find((c) => c.name === "csrfToken"); return c ? c.value : ""; };
    const s = await q.post(BASE + "/api/auth/signup", { data: { membershipNumber: num, name, password: "abc12345", phone: "01061234567", agreeTerms: true, memberType: "main", birthDate: "1990-01-01" }, headers: { "X-CSRF-Token": await tok() } });
    if (!s.ok()) console.log("signup fail", await s.text());
    return tok;
  };
  const tok = await mkMember(mctx, "UI1", "Sara Hassan Ali");
  let d = await mr.post(BASE + "/api/me/dependents", { data: { name: "Omar Sara", relationship: "Son", birthDate: "2015-05-05" }, headers: { "X-CSRF-Token": await tok() } });
  ok(d.ok(), "dependent added", await d.text());
  // filler member fills the 1-seat event
  const fctx = await browser.newContext();
  const ftok = await mkMember(fctx, "UI2", "Filler Person");
  const fr = await fctx.request.post(BASE + "/api/register", { data: { eventId: evFull.id }, headers: { "X-CSRF-Token": await ftok() } });
  ok(fr.ok(), "filler registered", await fr.text());

  for (const lang of ["en", "ar"]) {
    console.log("=== " + lang);
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, timezoneId: "Africa/Cairo" });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|401/.test(m.text())) errs.push(m.text()); });
    await page.goto(BASE + "/");
    await page.waitForTimeout(800);
    if (lang === "ar") { await page.evaluate(() => setLang("ar")); await page.waitForTimeout(300); }
    // signed out: click Register on the card -> login tab, no modal yet
    const cardBtn = page.locator('.event-card[data-event-id="' + evA.id + '"] [data-action="register"]').first();
    await cardBtn.click();
    ok(await page.locator("#reg-modal").isHidden(), lang + " signed out: no modal yet");
    ok(await page.locator("#view-register").isVisible(), lang + " signed out goes to Register tab");
    await page.fill("#li-membership", "UI1"); await page.fill("#li-password", "abc12345");
    await page.click("#li-submit");
    await page.waitForTimeout(1200);
    ok(await page.locator("#reg-modal").isVisible(), lang + " modal opens right after sign-in for the pending event");
    let name = await page.locator("#reg-event-summary .reg-sum-name").innerText();
    ok(/Padel Night|ليلة البادل/.test(name), lang + " summary shows event name", name);
    let sum = await page.locator("#reg-event-summary").innerText();
    ok(sum.includes(iso(5)), lang + " summary shows the date", sum);
    ok(await page.locator("#att-self").isChecked(), lang + " member pre-ticked");
    ok(await page.locator(".att-dep").count() === 1 && !(await page.locator(".att-dep").isChecked()), lang + " family listed, unticked");
    await page.screenshot({ path: `/tmp/regtest/t/modal_${lang}.png` });
    // cancel closes
    await page.click("#reg-modal-cancel");
    ok(await page.locator("#reg-modal").isHidden(), lang + " cancel closes");
    // go to Events tab, click Register on a card - modal opens WITHOUT switching tab
    await page.click('[data-view="events"]');
    await page.waitForTimeout(400);
    await page.locator('.event-card[data-event-id="' + evA.id + '"] [data-action="register"]').first().click();
    ok(await page.locator("#reg-modal").isVisible(), lang + " modal opens from Events tab");
    ok(await page.locator("#view-events").isVisible(), lang + " stays on Events tab");
    // Escape closes
    await page.keyboard.press("Escape");
    ok(await page.locator("#reg-modal").isHidden(), lang + " Esc closes");
    await page.locator('.event-card[data-event-id="' + evA.id + '"] [data-action="register"]').first().click();
    // include family member, confirm
    await page.check(".att-dep");
    await page.click("#reg-submit");
    await page.waitForSelector("#reg-qr-card:not(.hidden)", { timeout: 5000 });
    ok(await page.locator("#reg-qr-list .qr-entry img").count() === 2, lang + " two QR codes shown (member + family)");
    ok(await page.locator("#reg-form").isHidden(), lang + " form hidden in result stage");
    await page.screenshot({ path: `/tmp/regtest/t/result_${lang}.png` });
    await page.click("#reg-modal-done");
    ok(await page.locator("#reg-modal").isHidden(), lang + " Done closes");
    // second open: already registered -> existing QR handling
    await page.locator('.event-card[data-event-id="' + evA.id + '"] [data-action="register"]').first().click();
    await page.click("#reg-submit");
    await page.waitForSelector("#reg-qr-card:not(.hidden)");
    ok(await page.locator("#reg-qr-list .qr-entry img").count() >= 1, lang + " already-registered shows QR again");
    await page.click("#reg-modal-done");
    // full event -> waitlist
    await page.locator('.event-card[data-event-id="' + evFull.id + '"] [data-action="register"]').first().click();
    const btnTxt = await page.locator("#reg-submit").innerText();
    ok(/waiting|الانتظار/i.test(btnTxt), lang + " full event button says waiting list", btnTxt);
    ok(await page.locator(".reg-sum-full").count() === 1, lang + " full note shown");
    await page.click("#reg-submit");
    await page.waitForSelector("#reg-waitlist-card:not(.hidden)");
    ok(await page.locator("#reg-form").isHidden(), lang + " waitlist stage hides form");
    await page.screenshot({ path: `/tmp/regtest/t/waitlist_${lang}.png` });
    await page.click("#reg-waitlist-confirm"); // without checkbox -> message
    ok(await page.locator("#reg-waitlist-msg.show").count() === 1, lang + " must tick waitlist box");
    await page.check("#reg-waitlist-confirm-check");
    await page.click("#reg-waitlist-confirm");
    await page.waitForSelector("#reg-qr-card:not(.hidden)");
    ok(/waiting|الانتظار/i.test(await page.locator("#reg-qr-list").innerText()), lang + " waitlist result text");
    await page.click("#reg-modal-done");
    // double submit protection: click twice quickly on a fresh member? just check disabled state resets
    ok(!(await page.locator("#reg-submit").isDisabled()), lang + " submit re-enabled");
    ok(errs.length === 0, lang + " no console errors", errs);
    // log out & clear registrations for second language pass: use a different member next loop
    await ctx.close();
    if (lang === "en") {
      // reset: cancel member's registrations so ar pass starts fresh
      const regs = await (await mr.get(BASE + "/api/me/registrations")).json();
      for (const g of regs) await mr.delete(BASE + "/api/me/registrations/" + g.id, { headers: { "X-CSRF-Token": await tok() } });
    }
  }
  console.log(`passed ${pass} failed ${fail}`);
  await browser.close();
})();
