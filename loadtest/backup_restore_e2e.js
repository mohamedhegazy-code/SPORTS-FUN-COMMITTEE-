// Full backup & restore: build data (members, event + photo, tournament with results, uploads), download a backup,
// wipe/change things, restore, and prove everything is back exactly - plus tamper / bad-file / role checks.
// Usage: BASE_URL=http://localhost:3951 DATA_DIR=/tmp/regtest/data node backup_restore_e2e.js   (server must run on the same machine)
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process"), os = require("os");
const BASE = process.env.BASE_URL || "http://localhost:3951";
const DATA_DIR = process.env.DATA_DIR || "/tmp/regtest/data";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin", ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
const lib = require(process.env.BACKUP_LIB || path.join(__dirname, "..", "backup.js"));
let passed = 0, failed = 0; const serverErrors = [];
const ok = (c, l, x) => { if (c) passed++; else { failed++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 400)); } };
const section = (s) => console.log("\n=== " + s + " ===");
const applySetCookies = (jar, res) => { const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []; for (const raw of sc) { const [pair] = raw.split(";"); const eq = pair.indexOf("="); if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); } };
async function api(p, { method = "GET", body, jar, form, raw } = {}) {
  jar = jar || {};
  const headers = {};
  if (Object.keys(jar).length) headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (!["GET", "HEAD"].includes(method) && jar.csrfToken) headers["X-CSRF-Token"] = jar.csrfToken;
  let fb; if (form) fb = form; else if (body !== undefined) { headers["Content-Type"] = "application/json"; fb = JSON.stringify(body); }
  const res = await fetch(BASE + p, { method, headers, body: fb, redirect: "manual" });
  applySetCookies(jar, res);
  if (res.status >= 500) serverErrors.push(`${method} ${p} -> ${res.status}`);
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, jar };
}
const prime = async (jar) => { await api("/", { jar }); return jar; };
const form = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const cairoToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
const readDbFile = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, "db.json"), "utf8"));
const png = (seed) => Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea75b4d0a0000000049454e44ae426082", "hex"), Buffer.from(seed)]);

(async () => {
  const stamp = Date.now().toString(36);
  const admin = await prime({});
  ok((await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } })).status === 200, "admin login");
  const UP = path.join(DATA_DIR, "uploads");
  for (const d of ["events", "hero", "branding"]) fs.mkdirSync(path.join(UP, d), { recursive: true });

  section("Build a realistic platform: members, event with photo, tournament with results, other uploads");
  const players = [];
  for (let i = 1; i <= 8; i++) {
    const jar = await prime({});
    const name = i === 1 ? "أحمد سمير " + stamp : `Backup Player ${i} ${stamp}`;
    const s = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: `BK${stamp}${i}`, name, password: "abc12345", phone: `0102${String(i).padStart(7, "0")}`, agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
    ok(s.status === 200 || s.status === 201, "signup " + i, s.json);
    players.push({ jar, name, num: `BK${stamp}${i}` });
  }
  const photoBytes = png("cover-" + stamp);
  const f = form({ nameEn: "Backup Cup " + stamp, nameAr: "كأس النسخ الاحتياطي", sport: "PlayStation", date: cairoToday(), maxCapacity: "16" });
  f.set("coverPhoto", new Blob([photoBytes], { type: "image/png" }), "cover.png");
  let r = await api("/api/events", { method: "POST", jar: admin, form: f });
  ok(r.status === 200 || r.status === 201, "create event with cover photo", r.json);
  const ev = r.json.id;
  const evObj = readDbFile().events.find((e) => e.id === ev);
  ok(evObj && /^\/uploads\/events\//.test(evObj.coverPhoto), "cover photo stored under /uploads/events", evObj && evObj.coverPhoto);
  const coverFile = path.join(UP, evObj.coverPhoto.replace(/^\/uploads\//, ""));
  ok(fs.existsSync(coverFile), "cover photo file exists on disk");
  const heroBytes = Buffer.from(Array.from({ length: 50000 }, (_, i) => (i * 31 + 7) % 256));
  fs.writeFileSync(path.join(UP, "hero", `bk-${stamp}.mp4`), heroBytes);
  fs.writeFileSync(path.join(UP, "branding", `bk-${stamp}.png`), png("logo-" + stamp));
  for (const p of players) { const rr = await api("/api/register", { method: "POST", jar: p.jar, body: { eventId: ev } }); ok(rr.status === 200 || rr.status === 201, "register", rr.json); const id = rr.json && ((rr.json.registration && rr.json.registration.id) || rr.json.id); await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: id } }); }
  r = await api(`/api/admin/tournaments/${ev}`, { method: "POST", jar: admin, body: { mode: "individual", format: "knockout", courts: 2, matchMinutes: 15, startTime: "10:00" } });
  r = await api(`/api/admin/tournaments/${ev}/generate`, { method: "POST", jar: admin });
  ok(r.status === 200, "tournament generated", r.json);
  for (const m of r.json.tournament.knockout.rounds[0]) await api(`/api/admin/tournaments/${ev}/knockout-result`, { method: "PUT", jar: admin, body: { roundIndex: 0, matchId: m.id, scoreA: 3, scoreB: 1 } });
  const before = readDbFile();
  const snapshotOf = (d) => JSON.stringify({ members: d.members, events: d.events, registrations: d.registrations, tournaments: d.tournaments, settings: { ...d.settings, lastBackup: undefined }, landingPage: d.landingPage, staffAccounts: d.staffAccounts, nextIds: d.nextIds });
  const beforeSnap = snapshotOf(before);

  section("Download the full backup");
  const info0 = (await api("/api/admin/backup/info", { jar: admin }));
  ok(info0.status === 200 && info0.json.counts.members >= 8 && info0.json.uploads.files >= 3, "info shows the live counts and uploaded files", info0.json);
  ok(info0.json.last === null, "no backup downloaded yet");
  const dl = await api("/api/admin/backup/download", { jar: admin, raw: true });
  ok(dl.status === 200 && /^attachment; filename="MyAhlawy-backup-\d{4}-\d\d-\d\d_\d{4}\.zip"/.test(dl.headers.get("content-disposition") || ""), "download is a dated .zip", dl.headers.get("content-disposition"));
  const zipPath = path.join(os.tmpdir(), `bk-${stamp}.zip`); fs.writeFileSync(zipPath, dl.buf);
  let t = cp.spawnSync("unzip", ["-t", zipPath], { encoding: "utf8" });
  ok(t.status === 0 && /No errors detected/.test(t.stdout), "the standard unzip tool reads the zip with no errors", t.stdout.slice(-200) + t.stderr);
  const listing = cp.spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  ok(["manifest.json", "README.txt", "db.json", "readable/members.csv", "readable/events.csv", "readable/registrations.csv", "readable/tournaments.csv", "readable/staff_accounts.csv"].every((n) => listing.includes(n)), "zip holds manifest, README, db.json and the readable tables", listing);
  ok(listing.includes(evObj.coverPhoto.replace(/^\//, "")) && listing.includes(`uploads/hero/bk-${stamp}.mp4`) && listing.includes(`uploads/branding/bk-${stamp}.png`), "zip holds every uploaded photo / video / logo");
  const mf = JSON.parse(cp.spawnSync("unzip", ["-p", zipPath, "manifest.json"], { encoding: "utf8" }).stdout);
  ok(mf.format === "ahlawy-backup" && mf.counts.members === Object.keys(before.members).length && mf.counts.events === before.events.length && mf.counts.registrations === before.registrations.filter((x) => !x.waitlisted).length && mf.counts.tournaments === 1, "manifest counts match the database", mf.counts);
  ok(mf.files.every((x) => /^[0-9a-f]{64}$/.test(x.sha256)) && mf.files.some((x) => x.path === "db.json"), "manifest lists a SHA-256 for every file");
  const csv = cp.spawnSync("unzip", ["-p", zipPath, "readable/members.csv"], { encoding: "utf8" }).stdout;
  ok(csv.includes("أحمد سمير " + stamp) && csv.includes("membershipNumber") && !/passwordHash|\$2[aby]\$/.test(csv), "members.csv is readable (Arabic names) and holds no password hashes");
  const regCsv = cp.spawnSync("unzip", ["-p", zipPath, "readable/registrations.csv"], { encoding: "utf8" }).stdout;
  ok(regCsv.split("\r\n").filter(Boolean).length === before.registrations.length + 1, "registrations.csv has one row per registration");
  const info1 = await api("/api/admin/backup/info", { jar: admin });
  ok(info1.json.last && info1.json.last.bytes === dl.buf.length && info1.json.last.counts.members === mf.counts.members, "platform remembers when the last backup was taken", info1.json.last);

  section("Change the platform after the backup (delete event, delete files, add a member, change a setting)");
  const lateJar = await prime({});
  const late = await api("/api/auth/signup", { method: "POST", jar: lateJar, body: { membershipNumber: `LATE${stamp}`, name: "Late Member " + stamp, password: "abc12345", phone: "01099999999", agreeTerms: true, memberType: "main", birthDate: "1991-01-01" } });
  ok(late.status === 200 || late.status === 201, "a new member signs up after the backup");
  const del = await api(`/api/events/${ev}`, { method: "DELETE", jar: admin });
  ok(del.status === 200, "event deleted", del.json);
  fs.rmSync(path.join(UP, "hero", `bk-${stamp}.mp4`), { force: true });
  fs.writeFileSync(path.join(UP, "events", `junk-${stamp}.png`), png("junk"));
  const mid = readDbFile();
  fs.rmSync(coverFile, { force: true });
  ok(!mid.events.some((e) => e.id === ev) && mid.members[`LATE${stamp}`] && !fs.existsSync(coverFile), "the changes really happened (event gone, cover photo deleted, new member present)");

  section("Check, then restore");
  const sendFile = async (p, jar, name) => { const fd = new FormData(); fd.append("backup", new Blob([fs.readFileSync(p)]), name || path.basename(p)); return api("/api/admin/backup/inspect", { method: "POST", jar, form: fd }); };
  let ins = await sendFile(zipPath, admin);
  ok(ins.status === 200 && ins.json.ok === true && ins.json.token && ins.json.problems.length === 0, "inspect accepts the backup", ins.json);
  ok(ins.json.manifest.counts.events === before.events.length && ins.json.current.events === mid.events.length, "preview shows backup vs current numbers", [ins.json.manifest.counts.events, ins.json.current.events]);
  let rr = await api("/api/admin/backup/restore", { method: "POST", jar: admin, body: { token: ins.json.token, confirm: "restore it" } });
  ok(rr.status === 400, "restore refused without typing RESTORE", rr.json);
  rr = await api("/api/admin/backup/restore", { method: "POST", jar: admin, body: { token: "nope", confirm: "RESTORE" } });
  ok(rr.status === 400, "restore refused for an unknown/expired check", rr.json);
  const other = await prime({}); await api("/api/auth/staff-login", { method: "POST", jar: other, body: { username: ADMIN_USER, password: ADMIN_PASS } });
  rr = await api("/api/admin/backup/restore", { method: "POST", jar: admin, body: { token: ins.json.token, confirm: "RESTORE" } });
  ok(rr.status === 200 && rr.json.ok && rr.json.uploadsRestored >= 3 && /^pre-restore-.*\.zip$/.test(rr.json.safetyCopy), "restore succeeds and reports the safety copy", rr.json);
  const after = readDbFile();
  ok(snapshotOf(after) === beforeSnap, "members, events, registrations, tournaments, settings, staff and counters are IDENTICAL to the moment of the backup");
  ok(!after.members[`LATE${stamp}`] && after.events.some((e) => e.id === ev), "later changes are gone, the deleted event is back");
  ok(fs.existsSync(coverFile) && Buffer.compare(fs.readFileSync(coverFile), photoBytes) === 0, "cover photo is back, byte for byte");
  ok(Buffer.compare(fs.readFileSync(path.join(UP, "hero", `bk-${stamp}.mp4`)), heroBytes) === 0, "hero video is back, byte for byte");
  ok(!fs.existsSync(path.join(UP, "events", `junk-${stamp}.png`)), "files added after the backup are gone (exact copy of the backup)");
  ok(fs.readdirSync(DATA_DIR).filter((x) => /^uploads\.(old|restore)-/.test(x)).length === 0, "no temporary folders left behind");
  ok((await api("/api/admin/backup/info", { jar: admin })).status === 200, "the admin who restored stays signed in");
  const pub = await api(`/api/tournaments/${ev}`);
  ok(pub.status === 200 && pub.json.tournament && pub.json.tournament.knockout.rounds[0].every((m) => m.winnerId), "public tournament page shows the restored results");
  const photoRes = await fetch(BASE + evObj.coverPhoto);
  ok(photoRes.status === 200 && Buffer.compare(Buffer.from(await photoRes.arrayBuffer()), photoBytes) === 0, "restored cover photo is served by the site");
  const pj = await prime({}); const login = await api("/api/auth/login", { method: "POST", jar: pj, body: { membershipNumber: players[2].num, password: "abc12345" } });
  ok(login.status === 200, "a restored member can sign in with the same password", login.json);
  const ml = await api("/api/me/registrations", { jar: pj });
  ok(ml.status === 200, "…and sees their registrations");
  const lateLogin = await api("/api/auth/login", { method: "POST", jar: await prime({}), body: { membershipNumber: `LATE${stamp}`, password: "abc12345" } });
  ok(lateLogin.status !== 200, "the member created after the backup no longer exists");
  const lg = readDbFile().activityLog.slice(-2).map((x) => x.action);
  ok(lg.includes("backup_restore"), "the restore is written to the activity log", lg);

  section("Undo the restore with the automatic safety copy");
  const info2 = await api("/api/admin/backup/info", { jar: admin });
  const pre = info2.json.snapshots.find((s) => s.kind === "pre-restore");
  ok(pre && pre.name === rr.json.safetyCopy, "the safety copy is listed", info2.json.snapshots.map((s) => s.name));
  const preDl = await api(`/api/admin/backup/snapshot/${pre.name}`, { jar: admin, raw: true });
  ok(preDl.status === 200 && preDl.buf.length === pre.bytes, "the safety copy can be downloaded");
  const prePath = path.join(os.tmpdir(), pre.name); fs.writeFileSync(prePath, preDl.buf);
  ins = await sendFile(prePath, admin);
  ok(ins.json.ok && ins.json.manifest.counts.members === Object.keys(mid.members).length, "the safety copy passes the check and holds the pre-restore data", ins.json.manifest && ins.json.manifest.counts);
  rr = await api("/api/admin/backup/restore", { method: "POST", jar: admin, body: { token: ins.json.token, confirm: "RESTORE" } });
  ok(rr.status === 200, "undo restore works", rr.json);
  const undone = readDbFile();
  ok(undone.members[`LATE${stamp}`] && !undone.events.some((e) => e.id === ev) && fs.existsSync(path.join(UP, "events", `junk-${stamp}.png`)), "everything is back to how it was right before the first restore");

  section("Database-only snapshot (the automatic db-*.json copies)");
  const autos = (await api("/api/admin/backup/info", { jar: admin })).json.snapshots.filter((s) => s.kind === "auto");
  ok(autos.length >= 1, "the platform keeps its own automatic db snapshots", autos.length);
  // the very first automatic snapshot was taken at server start-up, before any admin existed: it must be refused
  const first = autos[autos.length - 1];
  const fdl = await api(`/api/admin/backup/snapshot/${first.name}`, { jar: admin, raw: true });
  const fp = path.join(os.tmpdir(), first.name); fs.writeFileSync(fp, fdl.buf);
  const firstIns = await sendFile(fp, admin);
  ok(firstIns.json && firstIns.json.ok === false && firstIns.json.problems.some((x) => /no admin account/.test(x)), "an old snapshot with no admin account is refused (it would lock everyone out)", firstIns.json && firstIns.json.problems);
  // a normal snapshot: copy the live db into the snapshot folder like the platform does
  const snapName = "db-2026-11-27T10-00-00-000Z.json";
  fs.mkdirSync(path.join(DATA_DIR, "backups"), { recursive: true });
  fs.copyFileSync(path.join(DATA_DIR, "db.json"), path.join(DATA_DIR, "backups", snapName));
  const sdl = await api(`/api/admin/backup/snapshot/${snapName}`, { jar: admin, raw: true });
  const sp = path.join(os.tmpdir(), snapName); fs.writeFileSync(sp, sdl.buf);
  ins = await sendFile(sp, admin);
  ok(ins.json.ok && ins.json.kind === "json" && ins.json.warnings.some((w) => /database-only/.test(w)), "a bare db snapshot is accepted with a clear note", ins.json);
  const upBefore = fs.readdirSync(path.join(UP, "events")).sort().join();
  rr = await api("/api/admin/backup/restore", { method: "POST", jar: admin, body: { token: ins.json.token, confirm: "RESTORE" } });
  ok(rr.status === 200 && fs.readdirSync(path.join(UP, "events")).sort().join() === upBefore, "restoring a db snapshot leaves uploaded files untouched", rr.json);

  section("Bad, tampered and dangerous files are refused (nothing changes)");
  const snapBefore = snapshotOf(readDbFile());
  const bad = async (label, buildFn, expect) => {
    const p = path.join(os.tmpdir(), `bad-${label}-${stamp}`); buildFn(p);
    const res = await sendFile(p, admin, label);
    const refused = res.status === 400 || (res.json && res.json.ok === false);
    ok(refused && !(res.json && res.json.token), `refused: ${label}`, res.json);
    if (expect && res.json && res.json.problems) ok(res.json.problems.some((x) => expect.test(x)), `reason shown for ${label}`, res.json.problems);
  };
  await bad("text-file", (p) => fs.writeFileSync(p, "hello this is not a backup"), null);
  await bad("empty", (p) => fs.writeFileSync(p, ""), null);
  await bad("random-zip-bytes", (p) => fs.writeFileSync(p, Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(200, 7)])), null);
  await bad("json-not-a-db", (p) => fs.writeFileSync(p, JSON.stringify({ hello: "world" })), /members|events|registrations/);
  const tamper = Buffer.from(fs.readFileSync(zipPath)); const dbIdx = tamper.indexOf(Buffer.from("db.json")); tamper[dbIdx + 7 + 60] ^= 0xff;
  await bad("tampered", (p) => fs.writeFileSync(p, tamper), /damaged|checksum/);
  const mkZip = (p, entries) => { const w = lib.zipWriter(p); for (const [n, b] of entries) w.add(n, Buffer.isBuffer(b) ? b : Buffer.from(b)); w.finish(); };
  const goodDb = fs.readFileSync(path.join(DATA_DIR, "db.json"));
  const man = (files, extra) => JSON.stringify({ format: "ahlawy-backup", formatVersion: 1, files, ...extra });
  const dbEntry = { path: "db.json", bytes: goodDb.length, sha256: lib.sha256(goodDb) };
  await bad("no-manifest", (p) => mkZip(p, [["db.json", goodDb]]), /manifest/);
  const noAdmin = JSON.parse(goodDb); noAdmin.staffAccounts = {}; const noAdminBuf = Buffer.from(JSON.stringify(noAdmin));
  await bad("no-admin-account", (p) => mkZip(p, [["manifest.json", man([{ path: "db.json", bytes: noAdminBuf.length, sha256: lib.sha256(noAdminBuf) }])], ["db.json", noAdminBuf]]), /no admin account/);
  await bad("path-traversal", (p) => { const evil = Buffer.from("x"); mkZip(p, [["manifest.json", man([dbEntry, { path: "uploads/../../evil.txt", bytes: 1, sha256: lib.sha256(evil) }])], ["db.json", goodDb], ["uploads/../../evil.txt", evil]]); }, /unexpected file path/);
  await bad("extra-unlisted-file", (p) => mkZip(p, [["manifest.json", man([dbEntry])], ["db.json", goodDb], ["uploads/events/sneaky.png", "x"]]), /unlisted/);
  await bad("checksum-mismatch", (p) => mkZip(p, [["manifest.json", man([{ ...dbEntry, sha256: "0".repeat(64) }])], ["db.json", goodDb]]), /checksum/);
  ok(snapshotOf(readDbFile()) === snapBefore, "after all the refused files the data is untouched");
  ok(!fs.existsSync(path.join(DATA_DIR, "..", "evil.txt")) && !fs.existsSync(path.join(UP, "..", "evil.txt")), "no file was written outside the uploads folder");

  section("Who may use it");
  const anon = await api("/api/admin/backup/info"); ok(anon.status === 401, "not signed in -> 401", anon.status);
  const mem = await api("/api/admin/backup/info", { jar: pj }); ok(mem.status === 401 || mem.status === 403, "a member is refused", mem.status);
  const memDl = await api("/api/admin/backup/download", { jar: pj, raw: true }); ok(memDl.status === 401 || memDl.status === 403, "a member cannot download a backup", memDl.status);
  // a Tournament Manager account must not be able to use it either
  const tm = "bktm" + stamp.slice(-5);
  const cr = await api("/api/staff/accounts", { method: "POST", jar: admin, body: { username: tm, name: "BK TM", password: "Temp#12345pw", role: "tournament" } });
  if (cr.status === 200 || cr.status === 201) {
    const tj = await prime({}); const lgi = await api("/api/auth/staff-login", { method: "POST", jar: tj, body: { username: tm, password: "Temp#12345pw" } });
    const chg = await api("/api/auth/change-password", { method: "POST", jar: tj, body: { currentPassword: "Temp#12345pw", newPassword: "Newer#12345pw" } });
    const tinfo = await api("/api/admin/backup/info", { jar: tj }); const tdl = await api("/api/admin/backup/download", { jar: tj, raw: true });
    ok(tinfo.status === 403 && tdl.status === 403, "a Tournament Manager is refused", [lgi.status, chg.status, tinfo.status, tdl.status]);
  } else console.log("  (skipped tournament-manager check: could not create staff", cr.status, JSON.stringify(cr.json), ")");

  ok(serverErrors.length === 0, "no 5xx anywhere", serverErrors.slice(0, 5));
  console.log(`\nBackup & restore E2E: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
