// Nightly cloud backup (Cloudflare R2 / S3): starts its OWN copy of the platform and its OWN fake S3 bucket
// that checks every request's AWS signature with independent code. No real cloud account needed.
// Usage: node cloud_backup_e2e.js        (port 3952 for the app, random port for the fake bucket)
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process"), os = require("os"), http = require("http"), crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const lib = require(path.join(ROOT, "backup.js"));
const cloud = require(path.join(ROOT, "cloud_backup.js"));
const PORT = 3952, BASE = `http://localhost:${PORT}`;
const ADMIN_USER = "e2eadmin", ADMIN_PASS = "E2ETest!2026xyz";
const { makeBucket, KEY_ID, SECRET, BUCKET } = require("./mock_s3");
let passed = 0, failed = 0;
const ok = (c, l, x) => { if (c) passed++; else { failed++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 400)); } };
const section = (s) => console.log("\n=== " + s + " ===");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- app copy + process control
const APP = path.join(os.tmpdir(), "cloudtest-app");
function prepareApp() {
  cp.execSync(`rm -rf ${APP} && mkdir -p ${APP} && cd ${ROOT} && tar cf - --exclude=./data --exclude=./loadtest --exclude=./node_modules . | tar xf - -C ${APP} && ln -s ${ROOT}/node_modules ${APP}/node_modules && mkdir -p ${APP}/data`);
}
let proc = null, procLog = "";
async function startApp(env) {
  await stopApp();
  procLog = "";
  proc = cp.spawn("node", ["server.js"], { cwd: APP, env: { ...process.env, PORT: String(PORT), ADMIN_BOOTSTRAP_USERNAME: ADMIN_USER, ADMIN_BOOTSTRAP_PASSWORD: ADMIN_PASS, R2_ACCOUNT_ID: "", R2_ENDPOINT: "", R2_BUCKET: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "", R2_PREFIX: "", BACKUP_KEEP: "", BACKUP_HOUR: "", AUTO_BACKUP_DISABLED: "", ...env } });
  proc.stdout.on("data", (d) => { procLog += d; }); proc.stderr.on("data", (d) => { procLog += d; });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + "/"); if (r.status < 500) return; } catch (e) { /* not yet */ } await sleep(250); }
  throw new Error("app did not start: " + procLog);
}
async function stopApp() { if (!proc) return; const p = proc; proc = null; p.kill("SIGTERM"); await new Promise((r) => { p.on("exit", r); setTimeout(r, 3000); }); }

const applySetCookies = (jar, res) => { for (const raw of res.headers.getSetCookie()) { const [pair] = raw.split(";"); const eq = pair.indexOf("="); if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); } };
async function api(p, { method = "GET", body, jar = {}, raw } = {}) {
  const headers = {};
  if (Object.keys(jar).length) headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (!["GET", "HEAD"].includes(method) && jar.csrfToken) headers["X-CSRF-Token"] = jar.csrfToken;
  let fb; if (body !== undefined) { headers["Content-Type"] = "application/json"; fb = JSON.stringify(body); }
  const res = await fetch(BASE + p, { method, headers, body: fb, redirect: "manual" });
  applySetCookies(jar, res);
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  let json = null, text = ""; try { text = await res.text(); json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text };
}
async function login(user = ADMIN_USER, pass = ADMIN_PASS) { const jar = {}; await api("/", { jar }); const r = await api("/api/auth/staff-login", { method: "POST", jar, body: { username: user, password: pass } }); return r.status === 200 ? jar : null; }
const oldName = (i) => `MyAhlawy-backup-2026-11-${String(10 + i).padStart(2, "0")}_0300.zip`;

(async () => {
  const bucket = await makeBucket();
  prepareApp();
  const envOk = { R2_ENDPOINT: bucket.url, R2_BUCKET: BUCKET, R2_ACCESS_KEY_ID: KEY_ID, R2_SECRET_ACCESS_KEY: SECRET };

  section("Pure logic: config, schedule, status");
  const c0 = cloud.readConfig({});
  ok(!c0.configured && c0.missing.length === 4, "empty env = not configured, 4 things missing", c0.missing);
  const c1 = cloud.readConfig({ R2_ACCOUNT_ID: "abc123", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s" });
  ok(c1.configured && c1.endpoint === "https://abc123.r2.cloudflarestorage.com" && c1.keep === 14 && c1.hour === 3 && c1.prefix === "myahlawy/", "account id builds the R2 endpoint; defaults keep 14, 3 AM, myahlawy/", c1);
  ok(cloud.readConfig({ ...{ R2_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s" }, BACKUP_KEEP: "7", BACKUP_HOUR: "23", R2_PREFIX: "/club//" }).keep === 7, "BACKUP_KEEP respected");
  ok(cloud.readConfig({ R2_ACCOUNT_ID: "a", BACKUP_KEEP: "0" }).keep === 14 && cloud.readConfig({ R2_ACCOUNT_ID: "a", BACKUP_KEEP: "9999" }).keep === 365, "keep is clamped to a sane range");
  ok(cloud.readConfig({ R2_ACCOUNT_ID: "a", BACKUP_HOUR: "99" }).hour === 3, "invalid hour falls back to 3");
  ok(!JSON.stringify(cloud.publicConfig(c1)).includes('"s"') && !("secretAccessKey" in cloud.publicConfig(c1)) && !("accessKeyId" in cloud.publicConfig(c1)), "public config never carries keys");
  const cfgOn = { ...c1, configured: true, disabled: false, hour: 3 };
  const at = (iso) => new Date(iso);
  // Cairo is UTC+2 in winter (Nov 27, 2026): 00:30Z = 02:30 Cairo, 01:30Z = 03:30 Cairo
  ok(cloud.cairoParts(at("2026-11-27T01:30:00Z")).hour === 3 && cloud.cairoParts(at("2026-11-27T22:30:00Z")).day === "2026-11-28", "Cairo clock conversion (winter UTC+2, day rolls at 22:00Z)");
  ok(!cloud.isDue({}, cfgOn, at("2026-11-27T00:30:00Z")), "not due at 02:30 Cairo");
  ok(cloud.isDue({}, cfgOn, at("2026-11-27T01:30:00Z")), "due at 03:30 Cairo");
  ok(!cloud.isDue({ lastSuccessDay: "2026-11-27" }, cfgOn, at("2026-11-27T10:00:00Z")), "not due again once today's backup succeeded");
  ok(cloud.isDue({ lastSuccessDay: "2026-11-26" }, cfgOn, at("2026-11-27T01:30:00Z")), "due again the next day");
  ok(!cloud.isDue({ attemptDay: "2026-11-27", attemptsToday: 1, lastAttemptAt: "2026-11-27T01:30:00Z" }, cfgOn, at("2026-11-27T01:45:00Z")), "after a failure wait 30 minutes before retrying");
  ok(cloud.isDue({ attemptDay: "2026-11-27", attemptsToday: 1, lastAttemptAt: "2026-11-27T01:30:00Z" }, cfgOn, at("2026-11-27T02:05:00Z")), "retries after 30 minutes");
  ok(!cloud.isDue({ attemptDay: "2026-11-27", attemptsToday: 3, lastAttemptAt: "2026-11-27T01:00:00Z" }, cfgOn, at("2026-11-27T09:00:00Z")), "gives up after 3 failed tries in one day");
  ok(!cloud.isDue({}, { ...cfgOn, disabled: true }, at("2026-11-27T05:00:00Z")) && !cloud.isDue({}, { ...cfgOn, configured: false }, at("2026-11-27T05:00:00Z")), "never due when switched off or not configured");
  const st1 = cloud.applyResult({}, { ok: false, error: "boom", trigger: "auto" }, at("2026-11-27T01:30:00Z"));
  const st2 = cloud.applyResult(st1, { ok: true, key: "k", bytes: 5, files: 2, prune: { pruned: 1, kept: 14 }, trigger: "auto" }, at("2026-11-27T02:05:00Z"));
  ok(st1.lastError === "boom" && st1.attemptsToday === 1 && st2.lastError === "" && st2.lastSuccessDay === "2026-11-27" && st2.attemptsToday === 2, "status records failure then success", [st1, st2]);

  section("Not configured: the platform says so plainly and does nothing");
  await startApp({});
  let admin = await login();
  ok(!!admin, "admin login");
  let r = await api("/api/admin/backup/cloud", { jar: admin });
  ok(r.status === 200 && r.json.config.configured === false && r.json.config.missing.length === 4 && r.json.status === null, "status: not configured, nothing recorded", r.json);
  r = await api("/api/admin/backup/cloud/run", { method: "POST", jar: admin, body: {} });
  ok(r.status === 400 && /not set up/i.test(r.json.error), "Run now refuses with a clear message", r.json);
  r = await api("/api/admin/backup/cloud/test", { method: "POST", jar: admin, body: {} });
  ok(r.json.ok === false && /missing/i.test(r.json.error), "Test connection explains what is missing", r.json);
  r = await api("/api/admin/backup/cloud/list", { jar: admin });
  ok(r.json.ok === false && r.json.items.length === 0, "list is empty, no crash");
  ok(/Nightly cloud backup is OFF/.test(procLog), "server log says nightly backup is OFF");
  // roles
  const anon = {}; await api("/", { jar: anon });
  ok([401, 403].includes((await api("/api/admin/backup/cloud", { jar: anon })).status), "signed-out visitor is refused");
  ok((await api("/api/staff/accounts", { method: "POST", jar: admin, body: { username: "cbtm", name: "CB TM", password: "Temp#12345pw", role: "tournament" } })).status < 300, "create a tournament-manager account");
  const tm = await login("cbtm", "Temp#12345pw");
  const tmRes = tm ? await Promise.all([api("/api/admin/backup/cloud", { jar: tm }), api("/api/admin/backup/cloud/run", { method: "POST", jar: tm, body: {} }), api("/api/admin/backup/cloud/test", { method: "POST", jar: tm, body: {} }), api("/api/admin/backup/cloud/list", { jar: tm }), api("/api/admin/backup/cloud/download/" + oldName(1), { jar: tm })]) : [];
  ok(tmRes.length === 5 && tmRes.every((x) => x.status === 403), "non-admin staff cannot see, run, test, list or download cloud backups", tmRes.map((x) => x.status));

  section("Configured: connection test");
  await startApp(envOk);
  admin = await login();
  ok(/Nightly cloud backup is ON/.test(procLog), "server log says nightly backup is ON");
  r = await api("/api/admin/backup/cloud", { jar: admin });
  ok(r.json.config.configured && r.json.config.bucket === BUCKET && r.json.config.keep === 14 && r.json.config.hour === 3, "status shows bucket, keep 14, 3 AM", r.json.config);
  ok(!r.text.includes(SECRET) && !r.text.includes(KEY_ID), "keys are never sent to the browser");
  r = await api("/api/admin/backup/cloud/test", { method: "POST", jar: admin, body: {} });
  ok(r.json.ok === true, "test connection passes", r.json);
  ok(bucket.state.sigBad === 0 && bucket.state.sigOk >= 4, `every request carried a valid AWS signature (${bucket.state.sigOk} ok, ${bucket.state.sigBad} bad)`);
  ok(bucket.objects.size === 0, "the test file was removed again");

  section("Run now: build, upload, verify, keep only 14");
  for (let i = 0; i < 18; i++) bucket.objects.set("myahlawy/" + oldName(i), Buffer.from("old " + i));
  bucket.objects.set("myahlawy/notes.txt", Buffer.from("not ours"));
  bucket.objects.set("other/MyAhlawy-backup-2026-01-01_0300.zip", Buffer.from("another folder"));
  bucket.objects.set("myahlawy/MyAhlawy-backup-2026-11-30_0300.zip.bak", Buffer.from("lookalike"));
  r = await api("/api/admin/backup/cloud/run", { method: "POST", jar: admin, body: {} });
  ok(r.status === 200 && r.json.ok === true && /^myahlawy\/MyAhlawy-backup-\d{4}-\d\d-\d\d_\d{4}\.zip$/.test(r.json.key), "Run now succeeds and names the file with the Cairo date/time", r.json);
  const newKey = r.json.key;
  const mine = [...bucket.objects.keys()].filter((k) => /^myahlawy\/MyAhlawy-backup-\d{4}-\d\d-\d\d_\d{4}\.zip$/.test(k));
  ok(mine.length === 14, "exactly 14 backups remain in the folder", mine.length);
  ok(mine.includes(newKey) && !mine.includes("myahlawy/" + oldName(0)) && !mine.includes("myahlawy/" + oldName(4)) && mine.includes("myahlawy/" + oldName(5)), "the oldest copies were removed, newest kept");
  ok(bucket.objects.has("myahlawy/notes.txt") && bucket.objects.has("other/MyAhlawy-backup-2026-01-01_0300.zip") && bucket.objects.has("myahlawy/MyAhlawy-backup-2026-11-30_0300.zip.bak"), "files that are not our backups are never touched");
  ok(r.json.prune.pruned === 5 && r.json.prune.kept === 14, "reports 5 removed / 14 kept", r.json.prune);
  ok(bucket.state.sigBad === 0, "all signatures valid, including list and delete");
  // the uploaded file is a real, restorable backup
  const uploaded = bucket.objects.get(newKey);
  const tmpZip = path.join(os.tmpdir(), "cb-uploaded.zip"); fs.writeFileSync(tmpZip, uploaded);
  const insp = lib.inspectBackup(tmpZip, { knownDbKeys: Object.keys(JSON.parse(fs.readFileSync(path.join(APP, "data", "db.json"), "utf8"))), currentQrFingerprint: null });
  ok(insp.ok && insp.kind === "zip" && /Automatic|Admin|CB|e2e/i.test(insp.manifest.createdBy || "Admin") && (insp.manifest.files || []).length >= 1, "the uploaded file passes the full backup check (checksums, structure)", insp.problems);
  ok(r.json.bytes === uploaded.length, "size recorded = size in the bucket");
  // keys are not inside the backup
  let leaked = "no";
  try { leaked = cp.execSync(`cd ${os.tmpdir()} && unzip -p cb-uploaded.zip db.json | grep -c -F -e '${SECRET}' -e '${KEY_ID}' || true`).toString().trim(); } catch (e) { leaked = "err"; }
  ok(leaked === "0", "no key or secret inside the backup file", leaked);
  r = await api("/api/admin/backup/cloud", { jar: admin });
  ok(r.json.status && r.json.status.lastSuccessAt && r.json.status.lastError === "" && r.json.status.lastKey === newKey && r.json.status.lastBytes === uploaded.length && r.json.status.lastKept === 14, "status saved: last success, key, bytes, kept", r.json.status);
  let dbf = JSON.parse(fs.readFileSync(path.join(APP, "data", "db.json"), "utf8"));
  ok(dbf.activityLog.some((a) => a.action === "cloud_backup"), "activity log has a cloud_backup entry");
  ok(!JSON.stringify(dbf).includes(SECRET) && !JSON.stringify(dbf).includes(KEY_ID), "database file never contains the keys");
  r = await api("/api/admin/backup/cloud/list", { jar: admin });
  ok(r.json.ok && r.json.items.length === 14 && r.json.items[0].name === newKey.replace("myahlawy/", "") && r.json.items.every((i) => /^MyAhlawy-backup-/.test(i.name)), "list shows the 14 copies, newest first", r.json.items && r.json.items.slice(0, 2));
  // download from the bucket through the platform
  let d = await api("/api/admin/backup/cloud/download/" + encodeURIComponent(newKey.replace("myahlawy/", "")), { jar: admin, raw: true });
  ok(d.status === 200 && d.buf.equals(uploaded) && /attachment/.test(d.headers.get("content-disposition") || ""), "download streams the exact file from the bucket");
  d = await api("/api/admin/backup/cloud/download/..%2F..%2Fetc%2Fpasswd", { jar: admin, raw: true });
  ok(d.status === 400 || d.status === 404, "path tricks are refused", d.status);
  d = await api("/api/admin/backup/cloud/download/" + oldName(30), { jar: admin, raw: true });
  ok(d.status === 404, "a copy that does not exist gives 404", d.status);

  section("Failure handling: the platform never breaks, old copies are never pruned on failure");
  const before = [...bucket.objects.keys()].sort().join("|");
  bucket.state.failPut = 1;
  r = await api("/api/admin/backup/cloud/run", { method: "POST", jar: admin, body: {} });
  ok(r.status === 200 && r.json.ok === false && /Upload failed \(HTTP 500/.test(r.json.error), "storage error reported clearly", r.json);
  ok([...bucket.objects.keys()].sort().join("|") === before, "nothing was deleted after a failed upload");
  r = await api("/api/admin/backup/cloud", { jar: admin });
  ok(r.json.status.lastError && /500/.test(r.json.status.lastError) && r.json.status.lastSuccessAt, "status keeps the error AND the earlier success time", r.json.status);
  dbf = JSON.parse(fs.readFileSync(path.join(APP, "data", "db.json"), "utf8"));
  ok(dbf.activityLog.some((a) => a.action === "cloud_backup_failed"), "activity log has a cloud_backup_failed entry");
  ok((await api("/api/admin/backup/info", { jar: admin })).status === 200, "platform still healthy after the failure");
  bucket.state.truncate = true;
  r = await api("/api/admin/backup/cloud/run", { method: "POST", jar: admin, body: {} });
  ok(r.json.ok === false && /Upload check failed/.test(r.json.error), "a partial upload is detected by the size check", r.json);
  bucket.state.truncate = false;
  r = await api("/api/admin/backup/cloud/run", { method: "POST", jar: admin, body: {} });
  ok(r.json.ok === true, "the next run succeeds and clears the error");
  r = await api("/api/admin/backup/cloud", { jar: admin });
  ok(r.json.status.lastError === "", "error cleared after success");
  // busy lock
  bucket.state.putDelay = 900;
  const [a, b] = await Promise.all([api("/api/admin/backup/cloud/run", { method: "POST", jar: admin, body: {} }), (async () => { await sleep(250); return api("/api/admin/backup/cloud/run", { method: "POST", jar: admin, body: {} }); })()]);
  ok((a.status === 200 && b.status === 409) || (a.status === 409 && b.status === 200), "two runs at once: one goes, the other is told to wait", [a.status, b.status]);
  const dl = await api("/api/admin/backup/download", { jar: admin, raw: true });
  ok(dl.status === 200 && dl.buf.length > 500, "the normal manual download still works afterwards");
  bucket.state.putDelay = 0;

  section("Wrong key and missing bucket");
  await startApp({ ...envOk, R2_SECRET_ACCESS_KEY: "totally-wrong-secret-value" });
  admin = await login();
  r = await api("/api/admin/backup/cloud/test", { method: "POST", jar: admin, body: {} });
  ok(r.json.ok === false && /refused|403/i.test(r.json.error) && !r.text.includes("totally-wrong-secret-value") && !r.text.includes(SECRET), "wrong secret: friendly 'key was refused' message, secret not echoed", r.json);
  r = await api("/api/admin/backup/cloud/run", { method: "POST", jar: admin, body: {} });
  ok(r.json.ok === false && /refused/i.test(r.json.error), "Run now reports the same");
  await startApp({ ...envOk, R2_BUCKET: "no-such-bucket" });
  admin = await login();
  r = await api("/api/admin/backup/cloud/test", { method: "POST", jar: admin, body: {} });
  ok(r.json.ok === false && /bucket not found|404/i.test(r.json.error), "wrong bucket name: tells you to check R2_BUCKET", r.json);
  await startApp({ ...envOk, R2_ENDPOINT: "http://127.0.0.1:9" });
  admin = await login();
  r = await api("/api/admin/backup/cloud/test", { method: "POST", jar: admin, body: {} });
  ok(r.json.ok === false && /reach|storage service/i.test(r.json.error), "unreachable service: clear message", r.json);

  section("Automatic nightly run (no button pressed)");
  bucket.objects.clear(); bucket.state.requests.length = 0;
  await stopApp(); cp.execSync(`rm -rf ${APP}/data && mkdir -p ${APP}/data`); // a fresh platform: no backup recorded yet
  await startApp({ ...envOk, BACKUP_HOUR: "0", BACKUP_KEEP: "3" });
  for (let i = 0; i < 6; i++) bucket.objects.set("myahlawy/" + oldName(i), Buffer.from("old " + i));
  admin = await login();
  let auto = null;
  for (let i = 0; i < 50 && !auto; i++) { await sleep(1000); const s = (await api("/api/admin/backup/cloud", { jar: admin })).json.status; if (s && s.lastSuccessAt) auto = s; }
  ok(!!auto && auto.lastTrigger === "auto" && auto.attemptsToday === 1, "the scheduler made a backup by itself shortly after start", auto);
  const mine2 = [...bucket.objects.keys()].filter((k) => cloud.NAME_RE.test(k.replace("myahlawy/", "")));
  ok(mine2.length === 3, "BACKUP_KEEP=3 honoured by the automatic run", mine2);
  dbf = JSON.parse(fs.readFileSync(path.join(APP, "data", "db.json"), "utf8"));
  ok(dbf.activityLog.some((x) => x.action === "cloud_backup" && x.actorType === "system"), "logged as an automatic backup");
  const putsBefore = bucket.state.requests.filter((x) => x.startsWith("PUT")).length;
  await sleep(65 * 1000);
  ok(bucket.state.requests.filter((x) => x.startsWith("PUT")).length === putsBefore, "no second backup the same day");
  await startApp({ ...envOk, BACKUP_HOUR: "0", AUTO_BACKUP_DISABLED: "1" });
  admin = await login();
  r = await api("/api/admin/backup/cloud", { jar: admin });
  ok(r.json.config.disabled === true, "AUTO_BACKUP_DISABLED switches the scheduler off");

  await stopApp(); bucket.server.close();
  ok(!/UnhandledPromiseRejection|TypeError|ReferenceError/.test(procLog), "no crashes in the server log");
  console.log(`\nCloud backup E2E: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error("TEST CRASHED:", e); await stopApp(); process.exit(1); });
