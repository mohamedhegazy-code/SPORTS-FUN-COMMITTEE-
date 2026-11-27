// UI: Admin > Backup tab - download, check, restore (EN + AR), phone width.
const { chromium } = require("/opt/node-tools/node_modules/playwright");
const fs = require("fs");
const BASE = process.env.BASE_URL || "http://localhost:3951";
const SHOTS = process.env.SHOTS || "/tmp/shots_bk"; fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) pass++; else { fail++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1200 }, acceptDownloads: true });
  const page = await ctx.newPage(); const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  const tok = async () => { const k = (await ctx.cookies()).find((x) => x.name === "csrfToken"); return k ? k.value : ""; };
  await ctx.request.get(BASE + "/");
  ok((await ctx.request.post(BASE + "/api/auth/staff-login", { data: { username: "e2eadmin", password: "E2ETest!2026xyz" }, headers: { "X-CSRF-Token": await tok() } })).ok(), "login");
  await page.goto(BASE + "/"); await page.waitForTimeout(900);
  await page.click('[data-view="admin"]'); await page.waitForTimeout(600);
  await page.click('[data-admin-tab="backup"]'); await page.waitForTimeout(1200);
  ok(await page.locator("#bk-counts .bk-tile").count() >= 9, "live counts tiles shown", await page.locator("#bk-counts .bk-tile").count());
  ok(/No full backup|لم يتم/.test(await page.locator("#bk-status").innerText()), "warns that no backup has been taken yet");
  await page.screenshot({ path: SHOTS + "/backup_tab_en.png", fullPage: true });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#bk-download")]);
  const file = SHOTS + "/" + dl.suggestedFilename(); await dl.saveAs(file);
  ok(/^MyAhlawy-backup-\d{4}-\d\d-\d\d_\d{4}\.zip$/.test(dl.suggestedFilename()) && fs.statSync(file).size > 1000, "button downloads a dated zip", dl.suggestedFilename());
  await page.waitForTimeout(800);
  ok(/Last full backup/.test(await page.locator("#bk-status").innerText()) && await page.locator("#bk-status.good").count() === 1, "status turns green: last backup recorded");
  // restore flow
  await page.setInputFiles("#bk-file", file);
  await page.click("#bk-check"); await page.waitForTimeout(1200);
  ok(await page.locator("#bk-preview .bk-alert.good").count() === 1, "backup verified message");
  ok(await page.locator("#bk-preview .bk-table tbody tr").count() >= 9, "comparison table backup vs now");
  ok(!(await page.locator("#bk-confirm").evaluate((e) => e.classList.contains("hidden"))), "confirm box appears");
  ok(await page.locator("#bk-restore").isDisabled(), "restore button disabled until RESTORE is typed");
  await page.fill("#bk-confirm-input", "restore"); ok(await page.locator("#bk-restore").isDisabled(), "still disabled for a wrong word");
  await page.fill("#bk-confirm-input", "RESTORE"); ok(!(await page.locator("#bk-restore").isDisabled()), "enabled after typing RESTORE");
  await page.screenshot({ path: SHOTS + "/backup_restore_preview_en.png", fullPage: true });
  await page.click("#bk-restore"); await page.waitForTimeout(2500);
  ok(/Restored/.test(await page.locator("#bk-msg").innerText()), "success message", await page.locator("#bk-msg").innerText());
  ok(await page.locator("#bk-snaps .bk-table tbody tr").count() >= 1, "safety copy appears in the list");
  // a bad file
  fs.writeFileSync(SHOTS + "/notabackup.zip", "nope");
  await page.setInputFiles("#bk-file", SHOTS + "/notabackup.zip"); await page.click("#bk-check"); await page.waitForTimeout(800);
  ok(/damaged|not a|valid/i.test(await page.locator("#bk-preview").innerText() + await page.locator("#bk-msg").innerText()), "a bad file shows a clear problem");
  ok(await page.locator("#bk-confirm.hidden").count() === 1, "no confirm box for a bad file");
  // Arabic
  await page.evaluate(() => setLang("ar")); await page.waitForTimeout(600);
  await page.click('[data-admin-tab="backup"]'); await page.waitForTimeout(900);
  ok(/النسخ الاحتياطي/.test(await page.locator('[data-admin-panel="backup"] h2').first().innerText()), "Arabic title");
  await page.screenshot({ path: SHOTS + "/backup_tab_ar.png", fullPage: true });
  // phone
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400);
  ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2)), "no horizontal scroll on a phone");
  ok(errs.length === 0, "no page errors", errs);
  console.log(`Backup UI E2E: ${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
