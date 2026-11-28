// Security & permissions helpers for MyAhlawy (no server state in here - server.js owns the db).
//   * module / permission model: every staff account has a role (the base) and optional per-module switches
//   * TOTP two-factor codes (RFC 6238, HMAC-SHA1, 30 s, 6 digits) written on node:crypto only
//   * secrets at rest (AES-256-GCM), backup codes, password policy
//   * tamper-evident hash chain used by the audit trail and the security log
"use strict";
const crypto = require("crypto");

// ------------------------------------------------------------- modules ----
// The parts of the platform a committee member can be given or denied. A role is the base
// (what that kind of account may ever do); the per-module switches can only take things away.
const MODULES = [
  { key: "management", sensitive: false },
  { key: "events", sensitive: false },
  { key: "tournaments", sensitive: false },
  { key: "checkin", sensitive: false },
  { key: "members", sensitive: false },
  { key: "points", sensitive: false },
  { key: "reports", sensitive: false },
  { key: "messages", sensitive: false },
  { key: "content", sensitive: false },
  { key: "landing", sensitive: false },
  { key: "links", sensitive: false },
  { key: "backup", sensitive: true },
  { key: "settings", sensitive: true },
  { key: "users", sensitive: true },
  { key: "security", sensitive: true },
];
const MODULE_KEYS = MODULES.map((m) => m.key);
const SENSITIVE = new Set(MODULES.filter((m) => m.sensitive).map((m) => m.key));

const ALL_ON = Object.fromEntries(MODULE_KEYS.map((k) => [k, true]));
// What each role may ever reach (matches the role gates already on the routes).
const ROLE_BASE = {
  admin: ALL_ON,
  tournament: { management: false, events: true, tournaments: true, checkin: true, reports: true, messages: true },
  staff: { checkin: true },
  management: { management: true, reports: true, checkin: true },
  partner: {},
};
const ROLES = Object.keys(ROLE_BASE);

// Effective permissions of one account: the role base AND the per-module switches. Switches are only
// consulted when the account has them (so every older account keeps working exactly as before). For a
// limited account a switch that was never set stays OFF for the sensitive modules.
function effectiveModules(staff) {
  const base = ROLE_BASE[staff && staff.role] || {};
  const sw = staff && staff.modules && typeof staff.modules === "object" ? staff.modules : null;
  const out = {};
  for (const k of MODULE_KEYS) {
    let on = !!base[k];
    if (on && sw) {
      if (sw[k] === false) on = false;
      else if (sw[k] === undefined && SENSITIVE.has(k)) on = false;
    }
    out[k] = on;
  }
  return out;
}
// "Full administrator" = an admin with no restriction at all.
function isFullAdmin(staff) {
  if (!staff || staff.role !== "admin" || staff.disabled) return false;
  const eff = effectiveModules(staff);
  return MODULE_KEYS.every((k) => eff[k]);
}
function cleanModules(input) {
  const out = {};
  for (const k of MODULE_KEYS) out[k] = !!(input && input[k] === true);
  return out;
}

// Which module a request belongs to. Ordered, first match wins. null = not module-gated.
// (For an admin-only route that matches nothing the caller falls back to "settings".)
const ROUTE_MODULES = [
  [/^\/api\/admin\/users(\/|$)/, "users"],
  [/^\/api\/staff\/accounts(\/|$)/, "users"],
  [/^\/api\/admin\/security(\/|$)/, "security"],
  [/^\/api\/admin\/activity-log(\/|$)/, "security"],
  [/^\/api\/admin\/backup(\/|$)/, "backup"],
  [/^\/api\/staff\/members\//, "members"],
  [/^\/api\/staff\/chats(\/|$)/, "messages"],
  [/^\/api\/staff\/inquiries(\/|$)/, "messages"],
  [/^\/api\/staff\/events\/[^/]+\/(member-page-setting|attendance-confirmation-setting)$/, "tournaments"],
  [/^\/api\/staff\/events\/[^/]+\/roster$/, "checkin"],
  [/^\/api\/staff\/registrations\//, "checkin"],
  [/^\/api\/checkin(\/|$)/, "checkin"],
  [/^\/api\/sim(\/|$)/, "tournaments"],
  [/^\/api\/admin\/tournaments(\/|$)/, "tournaments"],
  [/^\/api\/admin\/season-schedule$/, "tournaments"],
  [/^\/api\/admin\/event-teams(\/|$)/, "tournaments"],
  [/^\/api\/admin\/events\/[^/]+\/(waitlist|attendance-rollup|teams)$/, "tournaments"],
  [/^\/api\/admin\/registrations\/[^/]+\/(promote|cancel)$/, "tournaments"],
  [/^\/admin\/print\/tournament\//, "tournaments"],
  [/^\/api\/admin\/events\/[^/]+\/(managers|move-registrations|invite)$/, "events"],
  [/^\/api\/events\/[^/]+(\/registration)?$/, "events"],
  [/^\/api\/registrations$/, "events"],
  [/^\/api\/admin\/management(\/|$)/, "management"],
  [/^\/api\/admin\/(overview|stat-details)$/, "management"],
  [/^\/api\/admin\/dashboard$/, "events"],
  [/^\/api\/admin\/reports(\/|$)/, "reports"],
  [/^\/api\/admin\/(report-builder|saved-reports)(\/|$)/, "reports"],
  [/^\/admin\/print\/(event|age-report|custom-report)(\/|$)/, "reports"],
  [/^\/api\/(news|spotlights)(\/|$)/, "content"],
  [/^\/api\/admin\/(committee|terms)(\/|$)/, "content"],
  [/^\/api\/(rules|ladder)(\/|$)/, "content"],
  [/^\/api\/admin\/landing(\/|$)/, "landing"],
  [/^\/api\/redemptions(\/|$)/, "points"],
  [/^\/api\/admin\/points-start(\/|$)/, "points"],
  [/^\/api\/admin\/members\/[^/]+\/points-adjust$/, "points"],
  [/^\/api\/admin\/(members|directory|birthdays)(\/|$)/, "members"],
  [/^\/api\/admin\/message-links(\/|$)/, "links"],
  [/^\/api\/settings(\/|$)/, "settings"],
];
function moduleForPath(pathname) {
  for (const [re, key] of ROUTE_MODULES) if (re.test(pathname)) return key;
  return null;
}

// ----------------------------------------------------- password policy ----
// Staff accounts: at least 10 characters, at least three of (lower, upper, digit, symbol), not the
// username, not on the short list of passwords everyone tries first.
const COMMON = new Set(["password", "password1", "password123", "qwerty123", "1234567890", "admin12345", "letmein123", "welcome123", "ahlawy123", "alahly123"]);
function checkPasswordPolicy(password, opts = {}) {
  const pw = String(password || "");
  const problems = [];
  if (pw.length < 10) problems.push("length");
  if (pw.length > 200) problems.push("too_long");
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 3) problems.push("classes");
  const low = pw.toLowerCase();
  if (opts.username && String(opts.username).length >= 3 && low.includes(String(opts.username).toLowerCase())) problems.push("username");
  if (COMMON.has(low)) problems.push("common");
  return { ok: problems.length === 0, problems };
}
function policyMessage(problems) {
  const parts = [];
  if (problems.includes("length")) parts.push("at least 10 characters");
  if (problems.includes("classes")) parts.push("at least 3 of: lowercase, UPPERCASE, numbers, symbols");
  if (problems.includes("username")) parts.push("must not contain the username");
  if (problems.includes("common")) parts.push("is too common");
  if (problems.includes("too_long")) parts.push("is too long");
  return "Password needs: " + (parts.join("; ") || "a stronger password");
}
const PW_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PW_LOWER = "abcdefghijkmnpqrstuvwxyz";
const PW_DIGIT = "23456789";
const PW_SYMBOL = "#@$%&*+=?";
function pick(chars) {
  return chars[crypto.randomInt(chars.length)];
}
// A temporary password that always satisfies the policy (shared over WhatsApp, changed at first login).
function generateStrongPassword(len = 12) {
  const all = PW_UPPER + PW_LOWER + PW_DIGIT;
  const chars = [pick(PW_UPPER), pick(PW_LOWER), pick(PW_DIGIT), pick(PW_SYMBOL)];
  while (chars.length < len) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// ---------------------------------------------------------------- TOTP ----
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}
function hotp(secretB32, counter, digits = 6) {
  const key = base32Decode(secretB32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", key).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}
const TOTP_STEP_S = 30;
function totpAt(secretB32, timeMs = Date.now()) {
  return hotp(secretB32, Math.floor(timeMs / 1000 / TOTP_STEP_S));
}
// Returns the time-step the code matched (so the caller can refuse to accept it a second time), or null.
function verifyTotp(secretB32, code, { lastStep = -1, timeMs = Date.now(), window = 1 } = {}) {
  const c = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const now = Math.floor(timeMs / 1000 / TOTP_STEP_S);
  for (let d = -window; d <= window; d++) {
    const step = now + d;
    if (step <= lastStep) continue;
    const expect = hotp(secretB32, step);
    if (crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(c))) return step;
  }
  return null;
}
function otpauthUrl(label, issuer, secretB32) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ------------------------------------------------- secrets and tokens ----
function deriveKey(secret, label) {
  return crypto.createHash("sha256").update(`${label}|${secret}`).digest();
}
function encryptSecret(plain, secret) {
  const key = deriveKey(secret, "totp-at-rest");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
}
function decryptSecret(blob, secret) {
  try {
    const [v, iv, tag, enc] = String(blob || "").split(".");
    if (v !== "v1") return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(secret, "totp-at-rest"), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(enc, "base64url")), decipher.final()]).toString("utf8");
  } catch (e) {
    return null;
  }
}
function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}
const BACKUP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function generateBackupCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    let c = "";
    for (let j = 0; j < 10; j++) c += BACKUP_ALPHABET[crypto.randomInt(BACKUP_ALPHABET.length)];
    codes.push(`${c.slice(0, 5)}-${c.slice(5)}`);
  }
  return codes;
}
function normalizeBackupCode(code) {
  return String(code || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function hashBackupCode(code, secret) {
  return crypto.createHmac("sha256", deriveKey(secret, "backup-code")).update(normalizeBackupCode(code)).digest("hex");
}

// ------------------------------------------------- tamper-evident chain ----
// Each entry stores `seq`, `prev` (hash of the entry before) and `hash` = HMAC(key, prev | the entry's
// own fields). Changing, inserting or removing a row in the middle breaks every hash after it; the
// chain head (seq + hash, itself MACed) also catches rows cut off the end.
const CHAIN_SKIP = new Set(["hash", "prev"]);
function canonical(entry) {
  const o = {};
  for (const k of Object.keys(entry).sort()) if (!CHAIN_SKIP.has(k)) o[k] = entry[k];
  return JSON.stringify(o);
}
function chainHash(key, prev, entry) {
  return crypto.createHmac("sha256", key).update(`${prev}|${canonical(entry)}`).digest("hex");
}
function headMac(key, seq, hash) {
  return crypto.createHmac("sha256", key).update(`head|${seq}|${hash}`).digest("hex");
}
// Appends `entry` (without seq/prev/hash) to `list`, advancing `heads[name]`. Mutates in memory only.
function chainAppend(list, heads, name, key, entry) {
  const head = heads[name] || { seq: 0, hash: "genesis", mac: "" };
  const last = list[list.length - 1];
  const prev = last && last.hash ? last.hash : "genesis";
  const e = { ...entry, seq: (head.seq || 0) + 1 };
  e.prev = prev;
  e.hash = chainHash(key, prev, e);
  list.push(e);
  heads[name] = { seq: e.seq, hash: e.hash, mac: headMac(key, e.seq, e.hash) };
  return e;
}
function chainVerify(list, heads, name, key) {
  let hashed = 0, legacy = 0, broken = null, prevHash = null;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e.hash) {
      legacy++;
      prevHash = null;
      continue;
    }
    hashed++;
    if (prevHash !== null && e.prev !== prevHash) {
      broken = broken || { index: i, id: e.id, reason: "link" };
    }
    if (chainHash(key, e.prev, e) !== e.hash) {
      broken = broken || { index: i, id: e.id, reason: "content" };
    }
    prevHash = e.hash;
  }
  const head = heads && heads[name];
  let headOk = true;
  if (head) {
    const last = list[list.length - 1];
    if (head.mac !== headMac(key, head.seq, head.hash)) headOk = false;
    else if (last && last.hash && (last.seq !== head.seq || last.hash !== head.hash)) headOk = false;
    else if (!last && head.seq > 0) headOk = false;
  } else if (hashed > 0) {
    headOk = false;
  }
  return { ok: !broken && headOk, total: list.length, hashed, legacy, broken, headOk };
}

module.exports = {
  MODULES, MODULE_KEYS, SENSITIVE, ROLE_BASE, ROLES,
  effectiveModules, isFullAdmin, cleanModules, moduleForPath,
  checkPasswordPolicy, policyMessage, generateStrongPassword,
  generateTotpSecret, totpAt, verifyTotp, otpauthUrl, base32Encode, base32Decode,
  encryptSecret, decryptSecret, sha256, randomToken,
  generateBackupCodes, hashBackupCode, normalizeBackupCode,
  chainAppend, chainVerify, chainHash,
};
