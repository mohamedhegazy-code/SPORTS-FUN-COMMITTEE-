"use strict";
// Full-platform backup and restore.
//
// A backup is ONE .zip file holding everything the platform needs to come back exactly as it was:
//   manifest.json   what is inside (counts, sizes, SHA-256 of every file, who/when, QR key fingerprint)
//   db.json         the whole database (members, events, registrations, tournaments, settings, ...)
//   uploads/...     every uploaded photo / video / logo / QR image (data/uploads/*)
//   readable/*.csv  members, events, registrations, tournaments, staff as plain tables (open in Excel)
//   README.txt      how to restore it (Arabic + English)
// The zip is written and read by the small, dependency-free implementation below (no extra npm
// packages to install on the server).
//
// Restore is deliberately cautious: the file is verified first (every checksum, the database shape,
// at least one admin account), a safety copy of the CURRENT data is written to data/backups/ before
// anything is touched, and the swap is done with atomic renames so a failure rolls back.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const FORMAT = "ahlawy-backup";
const FORMAT_VERSION = 1;
const MAX_ENTRIES = 20000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB uncompressed, a sanity limit against zip bombs
const MEDIA_EXT = /\.(jpe?g|png|gif|webp|mp4|webm|m4v|mov|mp3|m4a|ogg|zip)$/i; // already compressed -> store

// ------------------------------------------------------------------------------ zip basics
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

// Writes a zip straight to disk, one file at a time (so memory use is one file, not the whole backup).
function zipWriter(outPath) {
  const fd = fs.openSync(outPath, "w");
  const entries = [];
  let offset = 0;
  const write = (buf) => {
    fs.writeSync(fd, buf, 0, buf.length);
    offset += buf.length;
  };
  const { time, date } = dosDateTime(new Date());
  return {
    add(name, data, { store = false } = {}) {
      if (entries.length >= MAX_ENTRIES) throw new Error("Too many files for one backup");
      const nameBuf = Buffer.from(name, "utf8");
      const crc = crc32(data);
      let method = 0, body = data;
      if (!store && data.length > 64) {
        const def = zlib.deflateRawSync(data, { level: 6 });
        if (def.length < data.length) { method = 8; body = def; }
      }
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0800, 6); // UTF-8 names
      header.writeUInt16LE(method, 8);
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(date, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(body.length, 18);
      header.writeUInt32LE(data.length, 22);
      header.writeUInt16LE(nameBuf.length, 26);
      header.writeUInt16LE(0, 28);
      const localOffset = offset;
      write(header); write(nameBuf); write(body);
      entries.push({ nameBuf, method, crc, csize: body.length, usize: data.length, localOffset });
    },
    finish() {
      const cdStart = offset;
      for (const e of entries) {
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE((3 << 8) | 20, 4); // made by: unix, 2.0
        c.writeUInt16LE(20, 6);
        c.writeUInt16LE(0x0800, 8);
        c.writeUInt16LE(e.method, 10);
        c.writeUInt16LE(time, 12);
        c.writeUInt16LE(date, 14);
        c.writeUInt32LE(e.crc, 16);
        c.writeUInt32LE(e.csize, 20);
        c.writeUInt32LE(e.usize, 24);
        c.writeUInt16LE(e.nameBuf.length, 28);
        c.writeUInt32LE(((0o100644 << 16) >>> 0), 38);
        c.writeUInt32LE(e.localOffset, 42);
        write(c); write(e.nameBuf);
      }
      const cdSize = offset - cdStart;
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(entries.length, 8);
      end.writeUInt16LE(entries.length, 10);
      end.writeUInt32LE(cdSize, 12);
      end.writeUInt32LE(cdStart, 16);
      write(end);
      fs.closeSync(fd);
      return entries.length;
    },
    abort() { try { fs.closeSync(fd); } catch (e) { /* already closed */ } },
  };
}

// Reads a zip's file list, then any single entry on demand.
function zipReader(filePath) {
  const fd = fs.openSync(filePath, "r");
  const size = fs.fstatSync(fd).size;
  const close = () => { try { fs.closeSync(fd); } catch (e) { /* closed */ } };
  try {
    if (size < 22) throw new Error("This is not a backup file (too small)");
    const tailLen = Math.min(size, 22 + 65535);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("This is not a valid .zip backup file");
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("Zip64 files are not supported");
    if (count > MAX_ENTRIES) throw new Error("The backup holds too many files");
    if (cdOffset + cdSize > size) throw new Error("The backup file is damaged (bad directory)");
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const list = [];
    let p = 0, total = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("The backup file is damaged (bad entry)");
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nl = cd.readUInt16LE(p + 28), el = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.slice(p + 46, p + 46 + nl).toString("utf8");
      p += 46 + nl + el + cl;
      if (flags & 1) throw new Error("Encrypted zip files are not supported");
      total += usize;
      if (total > MAX_TOTAL_BYTES) throw new Error("The backup is larger than the allowed size");
      list.push({ name, method, crc, csize, usize, localOffset });
    }
    const read = (e) => {
      const h = Buffer.alloc(30);
      fs.readSync(fd, h, 0, 30, e.localOffset);
      if (h.readUInt32LE(0) !== 0x04034b50) throw new Error(`The backup file is damaged (${e.name})`);
      const start = e.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
      const raw = Buffer.alloc(e.csize);
      fs.readSync(fd, raw, 0, e.csize, start);
      let data;
      if (e.method === 0) data = raw;
      else if (e.method === 8) {
        try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, e.usize) }); }
        catch (err) { throw new Error(`The backup file is damaged (${e.name} could not be unpacked)`); }
      }
      else throw new Error(`Unsupported compression in ${e.name}`);
      if (data.length !== e.usize || crc32(data) !== e.crc) throw new Error(`The backup file is damaged (${e.name} failed its checksum)`);
      return data;
    };
    return { list, read, close };
  } catch (err) {
    close();
    throw err;
  }
}

// ------------------------------------------------------------------------------ helpers
function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, base, out);
    else if (ent.isFile()) out.push({ full, rel: path.relative(base, full).split(path.sep).join("/") });
  }
  return out;
}
const SAFE_UPLOAD = /^uploads\/(?:[A-Za-z0-9_-]{1,40}\/){0,3}[A-Za-z0-9_][A-Za-z0-9_. @()+-]{0,200}$/;
const safeUploadPath = (name) => SAFE_UPLOAD.test(name) && !name.split("/").some((s) => s === ".." || s === ".");

function csvCell(v) {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheet formulas inert
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(cols, rows) {
  return "﻿" + [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";
}

function countsOf(db) {
  const arr = (x) => (Array.isArray(x) ? x.length : 0);
  const members = Object.values(db.members || {});
  const regs = Array.isArray(db.registrations) ? db.registrations : [];
  return {
    members: members.length,
    dependents: members.reduce((a, m) => a + (Array.isArray(m.dependents) ? m.dependents.length : 0), 0),
    staffAccounts: Object.keys(db.staffAccounts || {}).length,
    events: arr(db.events),
    registrations: regs.filter((r) => !r.waitlisted).length,
    waitlisted: regs.filter((r) => r.waitlisted).length,
    checkedIn: regs.filter((r) => r.checkedIn).length,
    tournaments: arr(db.tournaments),
    teams: arr(db.eventTeams),
    redemptions: arr(db.redemptions),
    pointAdjustments: arr(db.pointAdjustments),
    newsPosts: arr(db.newsPosts),
    spotlights: arr(db.spotlights),
    committee: arr(db.committee),
    savedReports: arr(db.savedReports),
    inquiries: arr(db.publicInquiries),
    activityLog: arr(db.activityLog),
    simulations: arr(db.simulations),
  };
}
function uploadsSummary(files) {
  const byFolder = {};
  let bytes = 0;
  for (const f of files) {
    const folder = f.rel.split("/")[0] || "";
    const sz = f.size != null ? f.size : fs.statSync(f.full).size;
    bytes += sz;
    byFolder[folder] = byFolder[folder] || { files: 0, bytes: 0 };
    byFolder[folder].files++;
    byFolder[folder].bytes += sz;
  }
  return { files: files.length, bytes, byFolder };
}

function readableTables(db) {
  const evName = Object.fromEntries((db.events || []).map((e) => [e.id, e.nameEn || e.nameAr || ""]));
  const members = Object.values(db.members || {});
  const memberByNo = Object.fromEntries(members.map((m) => [m.membershipNumber, m]));
  const tables = {};
  tables["members.csv"] = toCsv(
    ["membershipNumber", "name", "memberType", "phone", "email", "birthDate", "gender", "ageGroup", "dependents", "createdAt"],
    members.map((m) => ({ ...m, dependents: Array.isArray(m.dependents) ? m.dependents.length : 0 }))
  );
  tables["events.csv"] = toCsv(
    ["id", "nameEn", "nameAr", "sport", "date", "endDate", "startTime", "endTime", "maxCapacity", "registrationStatus", "createdAt"],
    db.events || []
  );
  tables["registrations.csv"] = toCsv(
    ["id", "eventId", "eventName", "membershipNumber", "memberName", "dependentName", "waitlisted", "checkedIn", "checkInAt", "registeredAt", "position"],
    (db.registrations || []).map((r) => ({ ...r, eventName: evName[r.eventId] || "", memberName: (memberByNo[r.membershipNumber] || {}).name || "" }))
  );
  tables["tournaments.csv"] = toCsv(
    ["id", "eventId", "eventName", "mode", "format", "status", "courts", "matchMinutes", "startTime", "matches", "played"],
    (db.tournaments || []).map((t) => {
      const ms = [];
      (t.groups || []).forEach((g) => (g.matches || []).forEach((m) => ms.push(!!m.result)));
      ((t.knockout && t.knockout.rounds) || []).forEach((r) => r.forEach((m) => { if (!m.bye) ms.push(!!m.winnerId); }));
      return { ...t, eventName: evName[t.eventId] || "", matches: ms.length, played: ms.filter(Boolean).length };
    })
  );
  tables["staff_accounts.csv"] = toCsv(["username", "name", "role"], Object.values(db.staffAccounts || {}));
  return tables;
}

const README = (m) => `MyAhlawy full backup / نسخة احتياطية كاملة لمنصة ماي أهلاوي
=================================================================
Created / تاريخ الإنشاء : ${m.createdAt}
Created by / بواسطة     : ${m.createdBy || "-"}

WHAT IS INSIDE / المحتويات
  manifest.json  - list of everything with sizes and SHA-256 checksums / قائمة بكل الملفات وبصماتها
  db.json        - the whole database (members, events, registrations, tournaments, settings...) / قاعدة البيانات كاملة
  uploads/       - all uploaded photos, videos, logos and QR images / كل الصور والفيديوهات المرفوعة
  readable/      - members, events, registrations, tournaments, staff as .csv tables for Excel / جداول يمكن فتحها في إكسل

HOW TO RESTORE / طريقة الاسترجاع
  1. Sign in as admin on the platform. / سجّل الدخول كمدير.
  2. Admin > Backup > "Restore from a backup", choose this .zip file, press "Check backup". / اختر الملف واضغط «فحص النسخة».
  3. Read the summary, type RESTORE and press "Restore now". / اكتب RESTORE ثم «استرجاع الآن».
  The platform saves a safety copy of the current data first, so a restore can itself be undone.
  Do NOT unzip and edit db.json by hand - the checksums would no longer match.

IMPORTANT / مهم
  * Keep this file private: db.json holds phone numbers and password hashes. / احفظ الملف في مكان آمن فهو يحتوي بيانات الأعضاء.
  * The QR codes members already hold stay valid only while the server's QR_SECRET setting is unchanged.
    QR key fingerprint of this backup: ${m.qrSecretFingerprint}
`;

// ------------------------------------------------------------------------------ build
function buildBackup({ dbPath, uploadsDir, outPath, createdBy, qrSecretFingerprint, appVersion }) {
  const dbRaw = fs.readFileSync(dbPath);
  const db = JSON.parse(dbRaw.toString("utf8"));
  const files = walk(uploadsDir).map((f) => ({ ...f, size: fs.statSync(f.full).size }));
  const manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    app: "MyAhlawy",
    appVersion: appVersion || "",
    createdAt: new Date().toISOString(),
    createdBy: createdBy || "",
    qrSecretFingerprint: qrSecretFingerprint || "",
    dbKeys: Object.keys(db).sort(),
    counts: countsOf(db),
    uploads: uploadsSummary(files),
    files: [],
  };
  const w = zipWriter(outPath);
  try {
    manifest.files.push({ path: "db.json", bytes: dbRaw.length, sha256: sha256(dbRaw) });
    for (const f of files) {
      const buf = fs.readFileSync(f.full); // one file in memory at a time
      manifest.files.push({ path: "uploads/" + f.rel, bytes: buf.length, sha256: sha256(buf) });
      w.add("uploads/" + f.rel, buf, { store: MEDIA_EXT.test(f.rel) });
    }
    w.add("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)));
    w.add("README.txt", Buffer.from(README(manifest), "utf8"));
    w.add("db.json", dbRaw);
    const tables = readableTables(db);
    for (const [name, text] of Object.entries(tables)) w.add("readable/" + name, Buffer.from(text, "utf8"));
    w.finish();
  } catch (e) {
    w.abort();
    try { fs.unlinkSync(outPath); } catch (x) { /* none */ }
    throw e;
  }
  return manifest;
}

// ------------------------------------------------------------------------------ inspect
function validateDb(db) {
  const problems = [];
  if (!db || typeof db !== "object" || Array.isArray(db)) return ["db.json is not a database object"];
  if (!db.members || typeof db.members !== "object" || Array.isArray(db.members)) problems.push("members is missing or has the wrong type");
  if (!Array.isArray(db.events)) problems.push("events is missing or has the wrong type");
  if (!Array.isArray(db.registrations)) problems.push("registrations is missing or has the wrong type");
  if (!db.staffAccounts || typeof db.staffAccounts !== "object") problems.push("staffAccounts is missing");
  else if (!Object.values(db.staffAccounts).some((s) => s && s.role === "admin" && s.passwordHash)) problems.push("the backup has no admin account - restoring it would lock everyone out");
  if (!db.nextIds || typeof db.nextIds !== "object") problems.push("nextIds is missing");
  return problems;
}

// Checks a backup (.zip full backup, or a bare db.json snapshot) without changing anything.
function inspectBackup(filePath, { knownDbKeys = [], currentQrFingerprint = "" } = {}) {
  const problems = [], warnings = [];
  const head = Buffer.alloc(4);
  const fd = fs.openSync(filePath, "r");
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  // ---- bare database snapshot (data/backups/db-*.json)
  if (head[0] === 0x7b || head[0] === 0x5b || head[0] === 0xef) {
    let db;
    try { db = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^﻿/, "")); } catch (e) { return { ok: false, kind: "json", problems: ["This file is not valid JSON"], warnings, manifest: null }; }
    problems.push(...validateDb(db));
    warnings.push("This is a database-only snapshot: uploaded photos and videos are NOT touched.");
    return { ok: !problems.length, kind: "json", problems, warnings, manifest: { createdAt: null, counts: countsOf(db), uploads: null }, db };
  }
  // ---- full backup zip
  let zr;
  try { zr = zipReader(filePath); } catch (e) { return { ok: false, kind: "zip", problems: [e.message], warnings, manifest: null }; }
  try {
    const byName = new Map();
    for (const e of zr.list) {
      if (byName.has(e.name)) problems.push(`duplicate entry ${e.name}`);
      byName.set(e.name, e);
    }
    const mEntry = byName.get("manifest.json"), dEntry = byName.get("db.json");
    if (!mEntry || !dEntry) return { ok: false, kind: "zip", problems: ["This is not a MyAhlawy backup (manifest.json or db.json is missing)"], warnings, manifest: null };
    let manifest;
    try { manifest = JSON.parse(zr.read(mEntry).toString("utf8")); } catch (e) { return { ok: false, kind: "zip", problems: ["manifest.json is damaged: " + e.message], warnings, manifest: null }; }
    if (manifest.format !== FORMAT) return { ok: false, kind: "zip", problems: ["This is not a MyAhlawy backup"], warnings, manifest: null };
    if (manifest.formatVersion > FORMAT_VERSION) warnings.push("This backup was made by a newer version of the platform; some data may not be understood.");
    // every file named in the manifest must exist and match its checksum; nothing else may hide in the zip
    const listed = new Set();
    for (const f of manifest.files || []) {
      listed.add(f.path);
      const e = byName.get(f.path);
      if (!e) { problems.push(`missing file ${f.path}`); continue; }
      if (f.path !== "db.json" && !safeUploadPath(f.path)) { problems.push(`unexpected file path ${f.path}`); continue; }
      let data;
      try { data = zr.read(e); } catch (err) { problems.push(err.message); continue; }
      if (sha256(data) !== f.sha256) problems.push(`${f.path} does not match its checksum - the file was changed or damaged`);
    }
    for (const e of zr.list) {
      if (e.name.endsWith("/")) continue;
      if (listed.has(e.name) || e.name === "manifest.json" || e.name === "README.txt" || e.name.startsWith("readable/")) continue;
      problems.push(`unlisted file ${e.name}`);
    }
    let db = null;
    try { db = JSON.parse(zr.read(dEntry).toString("utf8")); } catch (e) { problems.push("db.json is not valid JSON"); }
    if (db) {
      problems.push(...validateDb(db));
      const unknown = Object.keys(db).filter((k) => knownDbKeys.length && !knownDbKeys.includes(k));
      if (unknown.length) warnings.push("The backup contains data this version does not know: " + unknown.join(", "));
    }
    if (manifest.qrSecretFingerprint && currentQrFingerprint && manifest.qrSecretFingerprint !== currentQrFingerprint)
      warnings.push("This server's QR key (QR_SECRET) is different from the one used for this backup: QR codes already issued to members will not scan until the same QR_SECRET is set.");
    return { ok: !problems.length, kind: "zip", problems, warnings, manifest, db };
  } finally {
    zr.close();
  }
}

// ------------------------------------------------------------------------------ restore
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* best effort */ } }

// Replaces the platform's data with a verified backup. `inspected` is the result of inspectBackup.
// Returns { safetyCopy, uploadsRestored, ... }. Throws (after rolling back) if anything fails.
function restoreBackup({ filePath, inspected, dataDir, dbPath, uploadsDir, backupsDir, ensureDirs = [], createdBy, qrSecretFingerprint, appVersion }) {
  if (!inspected || !inspected.ok) throw new Error("The backup did not pass the check");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(backupsDir, { recursive: true });
  const isZip = inspected.kind === "zip";
  const dbText = JSON.stringify(inspected.db, null, 2);

  // 1. enough room?
  try {
    const st = fs.statfsSync(dataDir);
    const free = st.bavail * st.bsize;
    const current = walk(uploadsDir).reduce((a, f) => a + fs.statSync(f.full).size, 0) + (fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0);
    const need = (isZip ? inspected.manifest.uploads.bytes : 0) + current + dbText.length * 2 + 5 * 1024 * 1024;
    if (free < need) throw new Error(`Not enough free disk space to restore safely (need about ${Math.ceil(need / 1048576)} MB, free ${Math.floor(free / 1048576)} MB)`);
  } catch (e) {
    if (/Not enough free/.test(e.message)) throw e; // statfs unsupported -> skip the check
  }

  // 2. safety copy of the current data (kept in data/backups, last 3)
  const safetyPath = path.join(backupsDir, `pre-restore-${stamp}.zip`);
  buildBackup({ dbPath, uploadsDir, outPath: safetyPath, createdBy, qrSecretFingerprint, appVersion });
  const old = fs.readdirSync(backupsDir).filter((f) => /^pre-restore-.*\.zip$/.test(f)).sort();
  for (let i = 0; i < old.length - 3; i++) rmrf(path.join(backupsDir, old[i]));

  // 3. stage everything next to the real data, so the swap is just renames
  const stagingUploads = path.join(dataDir, `uploads.restore-${stamp}`);
  const stagingDb = `${dbPath}.restore-${stamp}.tmp`;
  const oldUploads = path.join(dataDir, `uploads.old-${stamp}`);
  let swappedUploads = false;
  try {
    let restored = 0;
    if (isZip) {
      fs.mkdirSync(stagingUploads, { recursive: true });
      const zr = zipReader(filePath);
      try {
        for (const e of zr.list) {
          if (!e.name.startsWith("uploads/") || e.name.endsWith("/")) continue;
          if (!safeUploadPath(e.name)) throw new Error("Unsafe file path in backup: " + e.name);
          const dest = path.join(stagingUploads, e.name.slice("uploads/".length));
          if (!path.resolve(dest).startsWith(path.resolve(stagingUploads) + path.sep)) throw new Error("Unsafe file path in backup: " + e.name);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, zr.read(e));
          restored++;
        }
      } finally { zr.close(); }
      for (const d of ensureDirs) fs.mkdirSync(path.join(stagingUploads, path.relative(uploadsDir, d)), { recursive: true });
    }
    fs.writeFileSync(stagingDb, dbText);
    JSON.parse(fs.readFileSync(stagingDb, "utf8")); // read-back check

    // 4. swap with atomic renames
    if (isZip) {
      if (fs.existsSync(uploadsDir)) fs.renameSync(uploadsDir, oldUploads);
      fs.renameSync(stagingUploads, uploadsDir);
      swappedUploads = true;
    }
    fs.renameSync(stagingDb, dbPath);
    if (isZip) rmrf(oldUploads);
    return { safetyCopy: path.basename(safetyPath), uploadsRestored: restored };
  } catch (err) {
    // roll back whatever was swapped
    try {
      if (swappedUploads) {
        rmrf(uploadsDir);
        if (fs.existsSync(oldUploads)) fs.renameSync(oldUploads, uploadsDir);
      }
    } catch (e) { /* keep the original error */ }
    rmrf(stagingUploads);
    try { fs.unlinkSync(stagingDb); } catch (e) { /* none */ }
    throw err;
  }
}


// ------------------------------------------------------------------------------ S3 / Cloudflare R2 storage
// A tiny S3-compatible client (AWS Signature V4, path-style URLs) - enough for off-server backups on
// Cloudflare R2, Backblaze B2, Amazon S3, MinIO... No extra npm package needed.
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
const hex = (buf) => buf.toString("hex");
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

// Builds the Authorization header value. `headers` is a lower-case-name -> value map of EVERY header to sign.
function signV4({ method, canonicalUri, query = {}, headers, payloadHash, amzDate, region, service = "s3", accessKeyId, secretAccessKey }) {
  const date = amzDate.slice(0, 8);
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n] !== undefined ? headers[n] : headers[Object.keys(headers).find((k) => k.toLowerCase() === n)]).trim().replace(/\s+/g, " ")}\n`).join("");
  const canonicalQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(String(query[k]))}`).join("&");
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, names.join(";"), payloadHash].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(Buffer.from(canonicalRequest))].join("\n");
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + secretAccessKey, date), region), service), "aws4_request");
  const signature = hex(hmac(kSigning, toSign));
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
}

function s3Client({ endpoint, region = "auto", accessKeyId, secretAccessKey, bucket, prefix = "" }) {
  const base = new URL(endpoint);
  const host = base.host;
  const objectPath = (key) => `/${enc(bucket)}/${key.split("/").map(enc).join("/")}`;
  async function call(method, key, { query = {}, body = null, size = 0, extraHeaders = {} } = {}) {
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const canonicalUri = key === null ? `/${enc(bucket)}` : objectPath(key);
    const payloadHash = body ? "UNSIGNED-PAYLOAD" : sha256(Buffer.alloc(0));
    const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...extraHeaders };
    const auth = signV4({ method, canonicalUri, query, headers, payloadHash, amzDate, region, accessKeyId, secretAccessKey });
    const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(String(query[k]))}`).join("&");
    const sendHeaders = { ...headers, Authorization: auth };
    delete sendHeaders.host;
    const init = { method, headers: sendHeaders };
    if (body) { init.body = body; init.duplex = "half"; sendHeaders["content-length"] = String(size); }
    return fetch(`${base.protocol}//${host}${canonicalUri}${qs ? "?" + qs : ""}`, init);
  }
  const fail = async (res, what) => {
    const text = await res.text().catch(() => "");
    const code = (/<Code>([^<]+)<\/Code>/.exec(text) || [])[1] || "";
    const err = new Error(`${what} failed (HTTP ${res.status}${code ? " " + code : ""})`);
    err.status = res.status; err.code = code;
    throw err;
  };
  return {
    prefix,
    async put(key, filePath) {
      const size = fs.statSync(filePath).size;
      const res = await call("PUT", key, { body: Readable.toWeb(fs.createReadStream(filePath)), size, extraHeaders: { "content-type": "application/zip" } });
      if (!res.ok) await fail(res, "Upload");
      await res.arrayBuffer();
      return size;
    },
    async putBuffer(key, buf) {
      const tmp = path.join(require("os").tmpdir(), `s3put-${crypto.randomBytes(6).toString("hex")}`);
      fs.writeFileSync(tmp, buf);
      try { return await this.put(key, tmp); } finally { try { fs.unlinkSync(tmp); } catch (e) { /* gone */ } }
    },
    async head(key) {
      const res = await call("HEAD", key);
      if (res.status === 404) return null;
      if (!res.ok) await fail(res, "Check");
      return { size: Number(res.headers.get("content-length") || 0) };
    },
    async getToFile(key, destPath) {
      const res = await call("GET", key);
      if (!res.ok) await fail(res, "Download");
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
      return fs.statSync(destPath).size;
    },
    async getBuffer(key) {
      const res = await call("GET", key);
      if (!res.ok) await fail(res, "Download");
      return Buffer.from(await res.arrayBuffer());
    },
    async stream(key) {
      const res = await call("GET", key);
      if (!res.ok) await fail(res, "Download");
      return { body: Readable.fromWeb(res.body), size: Number(res.headers.get("content-length") || 0) };
    },
    async delete(key) {
      const res = await call("DELETE", key);
      if (!res.ok && res.status !== 404) await fail(res, "Delete");
      await res.arrayBuffer();
    },
    async list(pfx) {
      const out = [];
      let token = null;
      for (let page = 0; page < 20; page++) {
        const query = { "list-type": "2", prefix: pfx };
        if (token) query["continuation-token"] = token;
        const res = await call("GET", null, { query });
        if (!res.ok) await fail(res, "Listing");
        const xml = await res.text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const g = (tag) => ((new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(m[1]) || [])[1] || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
          out.push({ key: g("Key"), size: Number(g("Size")), at: g("LastModified") });
        }
        const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
        if (/<IsTruncated>true<\/IsTruncated>/.test(xml) && next) token = next[1].replace(/&amp;/g, "&"); else break;
      }
      return out;
    },
  };
}

module.exports = { signV4, s3Client, buildBackup, inspectBackup, restoreBackup, countsOf, uploadsSummary, walk, zipWriter, zipReader, crc32, sha256, FORMAT_VERSION };
