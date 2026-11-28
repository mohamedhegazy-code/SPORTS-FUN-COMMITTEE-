// UI: Users & access tab, share-access dialog, invite page, per-module tab hiding, 2-step login (set-up + sign-in), Security centre.
const { chromium } = require("/opt/node-tools/node_modules/playwright");
const Sec = require("../security");
const BASE = process.env.BASE_URL || "http://localhost:3951";
const SHOTS = process.env.SHOTS || "";
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) pass++; else { fail++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };
(async () => {
  const browser = await chromium.launch();
  const st = Date.now().toString(36).slice(-5);
  const cm = "ui" + st;
  const mk = async (lang) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { "X-Forwarded-For": "10.30.0." + (lang === "ar" ? 2 : 1) } });
    const page = await ctx.newPage(); const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    page.on("dialog", (d) => d.accept());
    return { ctx, page, errs };
  };
  const signInAdmin = async (page, user, pw) => {
    await page.goto(BASE + "/"); await page.waitForTimeout(500);
    await page.click('[data-view="admin"]');
    await page.fill("#admin-username-input", user); await page.fill("#admin-password-input", pw);
    await page.click("#admin-unlock"); await page.waitForTimeout(1500);
  };

  // ---------------------------------------------------------------- admin builds a user
  const A = await mk("en");
  await signInAdmin(A.page, "e2eadmin", "E2ETest!2026xyz");
  const p = A.page;
  ok(await p.locator('.admin-tab[data-admin-tab="users"]').isVisible(), "Users tab visible to the full admin");
  ok(await p.locator('.admin-tab[data-admin-tab="security"]').isVisible(), "Security tab visible to the full admin");
  await p.click('.admin-tab[data-admin-tab="users"]'); await p.waitForTimeout(900);
  ok(await p.locator("#us-list .us-user").count() >= 1, "user cards render", await p.locator("#us-list .us-user").count());
  await p.click("#us-add-btn"); await p.waitForTimeout(300);
  ok(await p.locator("#us-edit-modal").isVisible(), "editor opens");
  await p.fill("#us-f-name", "Hala Events " + st); await p.fill("#us-f-username", cm); await p.fill("#us-f-title", "Events officer"); await p.fill("#us-f-phone", "01011112222");
  ok(await p.locator("#us-mod-grid input[data-mod]").count() === 15, "15 module switches");
  ok(await p.locator('#us-mod-grid input[data-mod="users"]').isEnabled(), "full admin may hand out every module");
  await p.click('[data-us-preset="usPresetEvents"]'); await p.waitForTimeout(150);
  ok(await p.locator('#us-mod-grid input[data-mod="events"]').isChecked() && !(await p.locator('#us-mod-grid input[data-mod="members"]').isChecked()), "preset ticks events team only");
  if (SHOTS) await p.screenshot({ path: SHOTS + "/users_editor_en.png" });
  await p.click("#us-edit-save"); await p.waitForTimeout(1200);
  ok(await p.locator("#us-share-modal").isVisible(), "share dialog shows after creating");
  const link = await p.locator("#us-share-body input").first().inputValue();
  ok(link.includes("/invite.html?t="), "invite link shown", link);
  ok(await p.locator("#us-share-wa").isVisible() && (await p.locator("#us-share-wa").getAttribute("href")).startsWith("https://wa.me/20101111"), "WhatsApp button prefilled for the phone");
  const waHref = decodeURIComponent(await p.locator("#us-share-wa").getAttribute("href"));
  ok(waHref.includes(link), "WhatsApp message carries the link");
  if (SHOTS) await p.screenshot({ path: SHOTS + "/users_share_en.png" });
  await p.click("#us-share-done"); await p.waitForTimeout(300);
  const card = p.locator(`#us-list [data-u="${cm}"]`);
  ok(await card.count() === 1 && /Invite sent/.test(await card.innerText()), "card shows Invite sent");
  ok(/custom access/.test(await card.innerText()), "card shows custom access");
  if (SHOTS) { await p.evaluate(() => window.scrollTo(0, 0)); await p.screenshot({ path: SHOTS + "/users_list_en.png" }); }

  // ---------------------------------------------------------------- invitee redeems the link
  const I = await mk("en");
  await I.page.goto(link + "&lang=en"); await I.page.waitForTimeout(900);
  ok(await I.page.locator("#iv-form").isVisible(), "invite form visible");
  ok((await I.page.locator("#iv-intro").innerText()).includes("Hala Events"), "greets by name", await I.page.locator("#iv-intro").innerText());
  ok(await I.page.locator("#iv-user").inputValue() === cm, "username shown");
  await I.page.fill("#iv-pw", "weakpass"); await I.page.fill("#iv-pw2", "weakpass");
  if (SHOTS) await I.page.screenshot({ path: SHOTS + "/invite_en.png" });
  await I.page.click("#iv-go"); await I.page.waitForTimeout(700);
  ok(/Password needs/.test(await I.page.locator("#iv-msg").innerText()), "weak password refused with the rules", await I.page.locator("#iv-msg").innerText());
  await I.page.fill("#iv-pw", "Hala!Events2026"); await I.page.fill("#iv-pw2", "Hala!Events2026");
  await I.page.click("#iv-go"); await I.page.waitForTimeout(2000);
  ok(I.page.url().replace(BASE, "") === "/", "redirected to the platform", I.page.url());
  await I.page.click('[data-view="admin"]'); await I.page.waitForTimeout(1200);
  const visibleTabs = await I.page.locator(".admin-tab:not(.hidden)").evaluateAll((els) => els.map((e) => e.dataset.adminTab));
  ok(visibleTabs.includes("events") && visibleTabs.includes("tournaments") && visibleTabs.includes("reports"), "sees the modules she was given", visibleTabs);
  ok(!visibleTabs.includes("members") && !visibleTabs.includes("users") && !visibleTabs.includes("security") && !visibleTabs.includes("backup") && !visibleTabs.includes("settings") && !visibleTabs.includes("points"), "does not see the others", visibleTabs);
  ok(await I.page.locator("#session-badge, #session-text").first().isVisible().catch(() => true), "session badge fine");
  if (SHOTS) await I.page.screenshot({ path: SHOTS + "/limited_admin_tabs_en.png" });
  ok(I.errs.length === 0, "no page errors (invitee)", I.errs);
  await I.ctx.close();

  // ---------------------------------------------------------------- 2-step login set-up in the browser
  const tf = "tf" + st;
  const apiCtx = A.ctx.request;
  const csrf = async () => (await A.ctx.cookies()).find((c) => c.name === "csrfToken").value;
  const cr = await apiCtx.post(BASE + "/api/admin/users", { data: { username: tf, name: "Two Step " + st, role: "admin", fullAdmin: true, share: "temp" }, headers: { "X-CSRF-Token": await csrf() } });
  const crj = await cr.json();
  ok(cr.status() === 201 && crj.tempPassword, "second admin created for the 2FA flow", crj);
  const T = await mk("en");
  await signInAdmin(T.page, tf, crj.tempPassword);
  ok(await T.page.locator("#must-change-password-modal").isVisible(), "temporary password forces a change");
  ok(await T.page.locator("#mcp-staff-rule").isVisible(), "password rule is shown to staff");
  await T.page.fill("#mcp-old", crj.tempPassword); await T.page.fill("#mcp-new", "weak1");
  await T.page.click("#mcp-submit"); await T.page.waitForTimeout(500);
  await T.page.fill("#mcp-new", "Tw0Step!Pass99");
  await T.page.click("#mcp-submit"); await T.page.waitForTimeout(1500);
  ok(!(await T.page.locator("#must-change-password-modal").isVisible()), "password changed, gate closed");
  await T.page.click('.admin-tab[data-admin-tab="security"]'); await T.page.waitForTimeout(1500);
  ok(await T.page.locator(".sc-score").isVisible(), "security score shown");
  ok(await T.page.locator(".sc-check").count() >= 8, "checks listed");
  if (SHOTS) { await T.page.evaluate(() => window.scrollTo(0, 0)); await T.page.screenshot({ path: SHOTS + "/security_overview_en.png", fullPage: false }); }
  await T.page.click("#sc-2fa-on"); await T.page.waitForTimeout(300);
  ok(await T.page.locator("#tf-setup-modal").isVisible(), "2FA set-up opens");
  await T.page.fill("#tf-setup-pass", "wrong-password"); await T.page.click("#tf-setup-start"); await T.page.waitForTimeout(500);
  ok(/incorrect/i.test(await T.page.locator("#tf-setup-msg").innerText()), "wrong password refused");
  await T.page.fill("#tf-setup-pass", "Tw0Step!Pass99"); await T.page.click("#tf-setup-start"); await T.page.waitForTimeout(700);
  ok(await T.page.locator("#tf-qr").isVisible() && (await T.page.locator("#tf-qr").getAttribute("src")).startsWith("data:image/png"), "QR shown");
  const secret = (await T.page.locator("#tf-secret").innerText()).replace(/\s+/g, "");
  ok(/^[A-Z2-7]{32}$/.test(secret), "secret key shown", secret);
  if (SHOTS) await T.page.screenshot({ path: SHOTS + "/twofactor_setup_en.png" });
  await T.page.fill("#tf-setup-code", "000000"); await T.page.click("#tf-setup-activate"); await T.page.waitForTimeout(500);
  ok(/not correct/i.test(await T.page.locator("#tf-setup-msg").innerText()), "wrong code refused");
  await T.page.fill("#tf-setup-code", Sec.totpAt(secret)); await T.page.click("#tf-setup-activate"); await T.page.waitForTimeout(800);
  ok(await T.page.locator("#tf-step-codes").isVisible() && await T.page.locator("#tf-codes span").count() === 8, "8 backup codes shown");
  const codes = await T.page.locator("#tf-codes span").allInnerTexts();
  await T.page.click("#tf-codes-done"); await T.page.waitForTimeout(1500);
  ok(/^on$/i.test((await T.page.locator("#sc-my2fa .us-pill").innerText()).trim()), "status now On");
  ok(T.errs.length === 0, "no page errors (2fa user)", T.errs);
  await T.ctx.close();

  // sign in again: password then code
  const S = await mk("en");
  await S.page.goto(BASE + "/"); await S.page.waitForTimeout(500);
  await S.page.click('[data-view="admin"]');
  await S.page.fill("#admin-username-input", tf); await S.page.fill("#admin-password-input", "Tw0Step!Pass99");
  await S.page.click("#admin-unlock"); await S.page.waitForTimeout(1000);
  ok(await S.page.locator("#tf-login-modal").isVisible(), "code prompt appears after the password");
  ok(!(await S.page.locator("#admin-panel").isVisible()), "panel stays locked until the code");
  if (SHOTS) await S.page.screenshot({ path: SHOTS + "/twofactor_login_en.png" });
  await S.page.fill("#tf-login-code", "111111"); await S.page.click("#tf-login-go"); await S.page.waitForTimeout(700);
  ok(/not correct/i.test(await S.page.locator("#tf-login-msg").innerText()), "wrong code refused in the prompt");
  await S.page.fill("#tf-login-code", codes[0]); await S.page.click("#tf-login-go"); await S.page.waitForTimeout(1500);
  ok(await S.page.locator("#admin-panel").isVisible(), "backup code signs in");
  ok(S.errs.length === 0, "no page errors (2fa login)", S.errs);
  await S.ctx.close();

  // ---------------------------------------------------------------- gate staff can protect their own account too
  const gs = "gs" + st;
  const gr = await (await apiCtx.post(BASE + "/api/admin/users", { data: { username: gs, name: "Gate " + st, role: "staff", share: "temp" }, headers: { "X-CSRF-Token": await csrf() } })).json();
  const G = await mk("en");
  await G.page.goto(BASE + "/"); await G.page.waitForTimeout(400);
  await G.page.click('[data-view="scan"]');
  await G.page.fill("#staff-username-input", gs); await G.page.fill("#staff-password-input", gr.tempPassword);
  await G.page.click("#scan-unlock"); await G.page.waitForTimeout(1200);
  await G.page.fill("#mcp-old", gr.tempPassword); await G.page.fill("#mcp-new", "Gate!Staff2026x");
  await G.page.click("#mcp-submit"); await G.page.waitForTimeout(1500);
  ok(await G.page.locator("#us-mini2fa").isVisible(), "gate staff see the 2-step card on the scan screen");
  ok(!(await G.page.locator('.admin-tab[data-admin-tab="users"]').isVisible()), "gate staff have no Users tab");
  await G.page.click('#us-mini2fa [data-mini="on"]'); await G.page.waitForTimeout(300);
  ok(await G.page.locator("#tf-setup-modal").isVisible(), "gate staff can start the set-up");
  ok(G.errs.length === 0, "no page errors (gate staff)", G.errs);
  await G.ctx.close();
  await apiCtx.delete(BASE + "/api/staff/accounts/" + gs, { headers: { "X-CSRF-Token": await csrf() } });

  // ---------------------------------------------------------------- Arabic
  const R = await mk("ar");
  await R.page.goto(BASE + "/"); await R.page.waitForTimeout(400);
  await R.page.click("#lang-ar"); await R.page.waitForTimeout(300);
  await R.page.click('[data-view="admin"]');
  await R.page.fill("#admin-username-input", "e2eadmin"); await R.page.fill("#admin-password-input", "E2ETest!2026xyz");
  await R.page.click("#admin-unlock"); await R.page.waitForTimeout(1500);
  await R.page.click('.admin-tab[data-admin-tab="users"]'); await R.page.waitForTimeout(900);
  ok(/المستخدمون/.test(await R.page.locator('[data-admin-panel="users"] h2').first().innerText()), "Arabic title");
  ok(await R.page.locator("#us-list .us-user").count() >= 3, "Arabic list renders");
  if (SHOTS) await R.page.screenshot({ path: SHOTS + "/users_list_ar.png" });
  await R.page.click(`#us-list [data-u="${cm}"] [data-us-act="edit"]`); await R.page.waitForTimeout(300);
  ok(await R.page.locator("#us-edit-modal").isVisible() && /تعديل/.test(await R.page.locator("#us-edit-title").innerText()), "Arabic editor");
  if (SHOTS) await R.page.screenshot({ path: SHOTS + "/users_editor_ar.png" });
  await R.page.click("#us-edit-cancel");
  await R.page.click('.admin-tab[data-admin-tab="security"]'); await R.page.waitForTimeout(1500);
  ok(/الأمان/.test(await R.page.locator('[data-admin-panel="security"] h2').first().innerText()), "Arabic security title");
  ok(await R.page.locator("#sc-log tbody tr").count() > 3, "security log rows");
  ok(await R.page.locator("#sc-audit tbody tr").count() > 3, "audit rows");
  await R.page.click("#sc-verify"); await R.page.waitForTimeout(800);
  ok(/سليمة/.test(await R.page.locator("#sc-verify-msg").innerText()), "integrity check says intact (AR)", await R.page.locator("#sc-verify-msg").innerText());
  await R.page.evaluate(() => document.querySelector("#sc-sessions-card").scrollIntoView());
  if (SHOTS) await R.page.screenshot({ path: SHOTS + "/security_ar.png" });
  ok(R.errs.length === 0, "no page errors (arabic)", R.errs);

  // clean up the users we made
  for (const u of [cm, tf]) await apiCtx.delete(BASE + "/api/staff/accounts/" + u, { headers: { "X-CSRF-Token": await csrf() } });
  ok(A.errs.length === 0, "no page errors (admin)", A.errs);
  await browser.close();
  console.log(`Users & security UI E2E: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
