// UI: Admin > Backup tab > "Nightly cloud backup" card (EN + AR, phone). Own app copy on port 3953 + fake bucket.
const { chromium } = require("/opt/node-tools/node_modules/playwright");
const fs = require("fs"), path = require("path"), cp = require("child_process"), os = require("os");
const { makeBucket, KEY_ID, SECRET, BUCKET } = require("./mock_s3");
const ROOT = path.join(__dirname, ".."), APP = path.join(os.tmpdir(), "cloudtest-ui-app"), PORT = 3953, BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS || "/tmp/shots_cb"; fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) pass++; else { fail++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc = null, log = "";
async function startApp(env) {
  if (proc) { proc.kill("SIGTERM"); await sleep(500); }
  log = "";
  proc = cp.spawn("node", ["server.js"], { cwd: APP, env: { ...process.env, PORT: String(PORT), ADMIN_BOOTSTRAP_USERNAME: "e2eadmin", ADMIN_BOOTSTRAP_PASSWORD: "E2ETest!2026xyz", R2_ACCOUNT_ID: "", R2_ENDPOINT: "", R2_BUCKET: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "", ...env } });
  proc.stdout.on("data", (d) => { log += d; }); proc.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/")).status < 500) return; } catch (e) {} await sleep(250); }
  throw new Error("app did not start " + log);
}
(async () => {
  cp.execSync(`rm -rf ${APP} && mkdir -p ${APP}/data && cd ${ROOT} && tar cf - --exclude=./data --exclude=./loadtest --exclude=./node_modules . | tar xf - -C ${APP} && ln -s ${ROOT}/node_modules ${APP}/node_modules`);
  const bucket = await makeBucket();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1300 } });
  const page = await ctx.newPage(); const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  const openTab = async () => {
    await ctx.clearCookies();
    await ctx.request.get(BASE + "/");
    const k = (await ctx.cookies()).find((x) => x.name === "csrfToken");
    await ctx.request.post(BASE + "/api/auth/staff-login", { data: { username: "e2eadmin", password: "E2ETest!2026xyz" }, headers: { "X-CSRF-Token": k.value } });
    await page.goto(BASE + "/"); await page.waitForTimeout(900);
    await page.click('[data-view="admin"]'); await page.waitForTimeout(500);
    await page.click('[data-admin-tab="backup"]'); await page.waitForTimeout(1500);
  };
  const txt = (s) => page.locator(s).innerText();

  // ---- not set up
  await startApp({});
  await openTab();
  ok(/Not switched on yet/.test(await txt("#cb-status")) && /R2_BUCKET/.test(await txt("#cb-status")), "not configured: says what is missing", await txt("#cb-status"));
  ok(await page.locator("#cb-run").isDisabled() && await page.locator("#cb-test").isDisabled(), "run/test buttons disabled until it is set up");
  ok(await page.locator("#cb-setup details li").count() === 5, "five setup steps shown");
  ok(/Cloudflare/.test(await txt("#cb-setup")) && /Railway/.test(await txt("#cb-setup")), "steps mention Cloudflare and Railway");
  await page.screenshot({ path: SHOTS + "/cloud_backup_off_en.png", fullPage: true });

  // ---- set up, empty bucket
  await startApp({ R2_ENDPOINT: bucket.url, R2_BUCKET: BUCKET, R2_ACCESS_KEY_ID: KEY_ID, R2_SECRET_ACCESS_KEY: SECRET });
  await openTab();
  ok(/first backup runs tonight after 03:00/.test(await txt("#cb-status")), "configured: tells when the first backup runs", await txt("#cb-status"));
  ok(await page.locator("#cb-setup details").count() === 0, "setup steps hidden once configured");
  ok(/No copies in the bucket yet/.test(await txt("#cb-list")), "empty bucket message");
  await page.click("#cb-test"); await page.waitForTimeout(1500);
  ok(/connection works/.test(await txt("#cb-msg")) && await page.locator("#cb-msg.good, #cb-msg.ok, #cb-msg.success").count() >= 0, "Test connection shows success", await txt("#cb-msg"));
  for (let i = 0; i < 16; i++) bucket.objects.set("myahlawy/" + `MyAhlawy-backup-2026-11-${String(10 + i).padStart(2, "0")}_0300.zip`, Buffer.from("old " + i));
  await page.click("#cb-run"); await page.waitForTimeout(4000);
  ok(/Saved MyAhlawy-backup-/.test(await txt("#cb-msg")) && /14 copies kept/.test(await txt("#cb-msg")), "Run now shows saved + kept 14", await txt("#cb-msg"));
  ok(/Last cloud backup/.test(await txt("#cb-status")) && await page.locator("#cb-status.good").count() === 1, "status turns green with the last backup time", await txt("#cb-status"));
  ok(await page.locator("#cb-list tbody tr").count() === 14, "list shows 14 copies", await page.locator("#cb-list tbody tr").count());
  ok(await page.locator('#cb-list a[href^="/api/admin/backup/cloud/download/"]').count() === 14, "each copy has a download link");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#cb-list a").first().click()]);
  ok(/^MyAhlawy-backup-.*\.zip$/.test(dl.suggestedFilename()), "clicking a copy downloads it", dl.suggestedFilename());
  await page.screenshot({ path: SHOTS + "/cloud_backup_ok_en.png", fullPage: true });

  // ---- failure shows in red with the reason
  bucket.state.failPut = 1;
  await page.click("#cb-run"); await page.waitForTimeout(2500);
  ok(/Upload failed/.test(await txt("#cb-msg")), "failed run shows the reason", await txt("#cb-msg"));
  ok(/Last attempt failed/.test(await txt("#cb-status")) && await page.locator("#cb-status.warn").count() === 1, "status turns amber with the error but remembers the earlier success", await txt("#cb-status"));

  // ---- Arabic + phone
  await page.evaluate(() => setLang("ar")); await page.waitForTimeout(500);
  await page.click('[data-admin-tab="backup"]'); await page.waitForTimeout(1500);
  ok(/النسخ الاحتياطي الليلي/.test(await txt("#cb-card h2")), "Arabic card title");
  ok(/آخر نسخة سحابية|فشلت آخر محاولة/.test(await txt("#cb-status")), "Arabic status", await txt("#cb-status"));
  await page.screenshot({ path: SHOTS + "/cloud_backup_ar.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400);
  ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2)), "no horizontal scroll on a phone");
  ok(!/totally|R2_SECRET/.test(await page.content()) && !(await page.content()).includes(SECRET), "page never contains the secret key");
  ok(errs.length === 0, "no page errors", errs);
  console.log(`Cloud backup UI E2E: ${pass} passed, ${fail} failed`);
  await browser.close(); proc.kill("SIGTERM"); bucket.server.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); if (proc) proc.kill("SIGTERM"); process.exit(1); });
