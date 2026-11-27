"use strict";
// Automatic off-server backups (Cloudflare R2 or any S3-compatible bucket).
//
// Everything here is plain functions so it can be tested without the web server: the server passes in
// the pieces that belong to it (paths, the db accessors, the "busy" lock). Nothing in this file ever
// writes a secret anywhere - the access keys only live in environment variables.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const backupLib = require("./backup");

const NAME_RE = /^MyAhlawy-backup-\d{4}-\d{2}-\d{2}_\d{4}\.zip$/;

// Reads the settings from environment variables (called every time, so a change in Railway applies
// after the normal redeploy and tests can set them freely).
function readConfig(env = process.env) {
  const clean = (v) => String(v == null ? "" : v).trim();
  const accountId = clean(env.R2_ACCOUNT_ID);
  let endpoint = clean(env.R2_ENDPOINT) || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");
  endpoint = endpoint.replace(/\/+$/, "");
  const bucket = clean(env.R2_BUCKET);
  const accessKeyId = clean(env.R2_ACCESS_KEY_ID);
  const secretAccessKey = clean(env.R2_SECRET_ACCESS_KEY);
  let prefix = clean(env.R2_PREFIX) || "myahlawy/";
  prefix = prefix.replace(/^\/+/, "");
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  const keep = Math.min(365, Math.max(1, parseInt(env.BACKUP_KEEP, 10) || 14));
  const hourRaw = parseInt(env.BACKUP_HOUR, 10);
  const hour = Number.isInteger(hourRaw) && hourRaw >= 0 && hourRaw <= 23 ? hourRaw : 3;
  const disabled = /^(1|true|yes|off)$/i.test(clean(env.AUTO_BACKUP_DISABLED));
  const missing = [];
  if (!endpoint) missing.push("R2_ACCOUNT_ID");
  if (!bucket) missing.push("R2_BUCKET");
  if (!accessKeyId) missing.push("R2_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");
  let badEndpoint = false;
  if (endpoint) { try { new URL(endpoint); } catch (e) { badEndpoint = true; missing.push("R2_ENDPOINT"); } }
  return { endpoint, bucket, accessKeyId, secretAccessKey, prefix, keep, hour, disabled, missing, configured: missing.length === 0 && !badEndpoint, region: clean(env.R2_REGION) || "auto" };
}

// What the browser may see: never the keys.
function publicConfig(cfg) {
  let host = "";
  try { host = new URL(cfg.endpoint).host; } catch (e) { /* not set */ }
  return { configured: cfg.configured, disabled: cfg.disabled, missing: cfg.missing, bucket: cfg.bucket, prefix: cfg.prefix, keep: cfg.keep, hour: cfg.hour, host };
}

const clientFor = (cfg) => backupLib.s3Client({ endpoint: cfg.endpoint, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, bucket: cfg.bucket, prefix: cfg.prefix });

// Cairo wall-clock helpers (the club works on Cairo time, whatever time zone the server runs in).
function cairoParts(date = new Date()) {
  const s = date.toLocaleString("sv-SE", { timeZone: "Africa/Cairo" }); // 2026-11-27 03:04:05
  return { day: s.slice(0, 10), hour: parseInt(s.slice(11, 13), 10), stamp: s.slice(0, 16).replace(" ", "_").replace(":", "") };
}

// Same wording for every message so the admin screen can show it as-is.
function friendlyError(e) {
  const msg = String((e && e.message) || e || "Unknown error");
  if (e && e.status === 403) return `${msg} - the access key was refused. Check R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY and that the token can write to this bucket.`;
  if (e && (e.status === 404 || e.code === "NoSuchBucket")) return `${msg} - bucket not found. Check R2_BUCKET and R2_ACCOUNT_ID.`;
  if (e && e.cause && (e.cause.code === "ENOTFOUND" || e.cause.code === "ECONNREFUSED")) return `Could not reach ${e.cause.hostname || "the storage service"} (${e.cause.code}). Check R2_ACCOUNT_ID / R2_ENDPOINT.`;
  if (/fetch failed/i.test(msg)) return "Could not reach the storage service. Check R2_ACCOUNT_ID / R2_ENDPOINT and the internet connection.";
  return msg;
}

// Deletes the oldest copies so only `keep` remain. Names carry the date, so sorting the names is
// sorting by age. Only files that look exactly like our backups are ever touched.
async function pruneRemote(client, prefix, keep) {
  const all = (await client.list(prefix)).filter((o) => o.key.startsWith(prefix) && NAME_RE.test(o.key.slice(prefix.length)));
  all.sort((a, b) => b.key.localeCompare(a.key));
  const doomed = all.slice(keep);
  const failed = [];
  for (const o of doomed) {
    try { await client.delete(o.key); } catch (e) { failed.push(o.key); }
  }
  return { kept: Math.min(all.length, keep) + failed.length, pruned: doomed.length - failed.length, failed: failed.length, total: all.length };
}

// Builds a full backup, uploads it, checks it arrived whole, then prunes. Never throws: the outcome is
// returned (and saved by the caller) so a failure can never take the platform down.
async function runCloudBackup(ctx, { trigger = "auto", by = "" } = {}) {
  const cfg = ctx.config ? ctx.config() : readConfig();
  const started = new Date();
  if (!cfg.configured) return { ok: false, error: "Cloud backup is not set up yet (missing: " + cfg.missing.join(", ") + ")", startedAt: started.toISOString(), trigger };
  if (ctx.isBusy()) return { ok: false, busy: true, error: "Another backup or restore is running", startedAt: started.toISOString(), trigger };
  ctx.setBusy(true);
  const out = path.join(os.tmpdir(), `ahlawy-cloud-${crypto.randomBytes(6).toString("hex")}.zip`);
  try {
    const manifest = backupLib.buildBackup({ dbPath: ctx.dbPath, uploadsDir: ctx.uploadsDir, outPath: out, createdBy: by || (trigger === "auto" ? "Automatic nightly backup" : "Admin"), qrSecretFingerprint: ctx.qrFingerprint(), appVersion: "1" });
    const bytes = fs.statSync(out).size;
    const key = cfg.prefix + `MyAhlawy-backup-${cairoParts(started).stamp}.zip`;
    const client = clientFor(cfg);
    await client.put(key, out);
    const head = await client.head(key);
    if (!head || head.size !== bytes) throw new Error(`Upload check failed: the copy in the bucket is ${head ? head.size : 0} bytes instead of ${bytes}`);
    let prune = { kept: 0, pruned: 0, failed: 0, total: 0 };
    let pruneError = "";
    try { prune = await pruneRemote(client, cfg.prefix, cfg.keep); } catch (e) { pruneError = "Backup saved, but clearing old copies failed: " + friendlyError(e); }
    return { ok: true, key, bytes, files: manifest.files.length, counts: manifest.counts, prune, pruneError, startedAt: started.toISOString(), finishedAt: new Date().toISOString(), trigger };
  } catch (e) {
    return { ok: false, error: friendlyError(e), startedAt: started.toISOString(), finishedAt: new Date().toISOString(), trigger };
  } finally {
    try { fs.unlinkSync(out); } catch (e) { /* gone */ }
    ctx.setBusy(false);
  }
}

// Writes a tiny file, reads it back, deletes it: proves the keys, the bucket and the permissions.
async function testConnection(cfg) {
  if (!cfg.configured) return { ok: false, error: "Not set up yet (missing: " + cfg.missing.join(", ") + ")" };
  try {
    const client = clientFor(cfg);
    const key = cfg.prefix + `connection-test-${crypto.randomBytes(4).toString("hex")}.txt`;
    const body = Buffer.from("MyAhlawy backup connection test " + new Date().toISOString());
    await client.putBuffer(key, body);
    const back = await client.getBuffer(key);
    await client.delete(key);
    if (!back.equals(body)) throw new Error("The test file came back different from what was sent");
    const existing = (await client.list(cfg.prefix)).filter((o) => NAME_RE.test(o.key.slice(cfg.prefix.length)));
    return { ok: true, existing: existing.length };
  } catch (e) {
    return { ok: false, error: friendlyError(e) };
  }
}

async function listRemote(cfg) {
  const client = clientFor(cfg);
  const items = (await client.list(cfg.prefix)).filter((o) => o.key.startsWith(cfg.prefix) && NAME_RE.test(o.key.slice(cfg.prefix.length)));
  items.sort((a, b) => b.key.localeCompare(a.key));
  return items.map((o) => ({ name: o.key.slice(cfg.prefix.length), bytes: o.size, at: o.at }));
}

// Decides whether tonight's run is due: after the chosen hour (Cairo time), none yet today, and at most
// 3 tries per day, 30 minutes apart, so a wrong key never hammers the service.
function isDue(status, cfg, now = new Date()) {
  if (!cfg.configured || cfg.disabled) return false;
  const c = cairoParts(now);
  if (c.hour < cfg.hour) return false;
  const st = status || {};
  if (st.lastSuccessDay === c.day) return false;
  if (st.attemptDay === c.day) {
    if ((st.attemptsToday || 0) >= 3) return false;
    if (st.lastAttemptAt && now.getTime() - new Date(st.lastAttemptAt).getTime() < 30 * 60 * 1000) return false;
  }
  return true;
}

// Folds a run's outcome into the saved status object (never contains secrets).
function applyResult(status, result, now = new Date()) {
  const st = { ...(status || {}) };
  const c = cairoParts(now);
  if (st.attemptDay !== c.day) { st.attemptDay = c.day; st.attemptsToday = 0; }
  st.attemptsToday = (st.attemptsToday || 0) + 1;
  st.lastAttemptAt = now.toISOString();
  st.lastTrigger = result.trigger || "auto";
  if (result.ok) {
    st.lastSuccessAt = now.toISOString();
    st.lastSuccessDay = c.day;
    st.lastError = "";
    st.lastKey = result.key;
    st.lastBytes = result.bytes;
    st.lastFiles = result.files;
    st.lastPruned = result.prune ? result.prune.pruned : 0;
    st.lastKept = result.prune ? result.prune.kept : 0;
    st.lastWarning = result.pruneError || "";
  } else {
    st.lastError = result.error || "Failed";
  }
  return st;
}

module.exports = { NAME_RE, readConfig, publicConfig, clientFor, cairoParts, friendlyError, pruneRemote, runCloudBackup, testConnection, listRemote, isDue, applyResult };
