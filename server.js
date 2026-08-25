// Ahlawy Online Registration & Points System
// Al Ahly Club - Sports Entertainment Committee, Fifth Settlement
//
// Simple, self-contained Node/Express app. Data persists to data/db.json
// (a real database can replace this file's read/write functions later,
// per Phase Three of the source document, without changing the API).

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const QRCode = require("qrcode");
const multer = require("multer");
const XLSX = require("xlsx");

const DB_PATH = path.join(__dirname, "data", "db.json");
// Used to sign each registration's QR code so it can't be forged or edited.
// Change this (set QR_SECRET env var) before any real event.
const QR_SECRET = process.env.QR_SECRET || "ahlawy-qr-secret-change-me";
// Only used once, the very first time the app runs, to create the first
// admin account (see bootstrapAdmin below). Change these before first run
// in any real deployment, or just change the password immediately after
// logging in for the first time.
const BOOTSTRAP_ADMIN_USERNAME = process.env.ADMIN_BOOTSTRAP_USERNAME || "admin";
const BOOTSTRAP_ADMIN_PASSWORD = process.env.ADMIN_BOOTSTRAP_PASSWORD || "change-me-now";
const SESSION_COOKIE = "ahlawy_sid";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(cookieParser());
// no-cache so a redeployed app.js/index.html/etc. is never served stale from
// the browser's disk cache after an update - Express's default static
// headers (ETag only, no explicit Cache-Control) leave browsers free to use
// heuristic caching, which has caused "I updated the app but my browser is
// still running the old version" confusion after past updates.
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  })
);

// ------------------------------------------------------ event photo uploads --
// Event cover photos and after-event recap photos are stored as plain files
// on disk (not base64 in db.json, to keep the JSON store small) and served
// back out via the static /public mount above, since they live under
// public/uploads/events/.
const EVENT_UPLOADS_DIR = path.join(__dirname, "public", "uploads", "events");
fs.mkdirSync(EVENT_UPLOADS_DIR, { recursive: true });

const eventPhotoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, EVENT_UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt}`);
  },
});
const uploadEventPhoto = multer({
  storage: eventPhotoStorage,
  limits: { fileSize: 8 * 1024 * 1024, files: 10 }, // 8MB/file, up to 10 files at once
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error("Only image files are allowed"));
    cb(null, true);
  },
});

// ------------------------------------------------------------- branding ---
// Admin-set logo, stored on disk the same way event photos are (served back
// out via the static /public mount).
const BRANDING_UPLOADS_DIR = path.join(__dirname, "public", "uploads", "branding");
fs.mkdirSync(BRANDING_UPLOADS_DIR, { recursive: true });
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const brandingLogoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, BRANDING_UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"].includes(ext) ? ext : ".png";
    cb(null, `logo-${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt}`);
  },
});
const uploadLogo = multer({
  storage: brandingLogoStorage,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB is plenty for a logo
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error("Only image files are allowed"));
    cb(null, true);
  },
});
// Derives the darker shade used for gradients/hover states from a single
// admin-picked primary color, so the admin only ever has to choose one
// "primary" swatch instead of two - mirrors how --red/--red-dark were two
// hand-picked shades of the same color in the original stylesheet.
function darkenHex(hex, factor = 0.72) {
  const m = HEX_COLOR_RE.exec(hex);
  if (!m) return hex;
  const num = parseInt(hex.slice(1), 16);
  const channel = (shift) => Math.round(((num >> shift) & 255) * factor);
  const toHex = (n) => n.toString(16).padStart(2, "0");
  return `#${toHex(channel(16))}${toHex(channel(8))}${toHex(channel(0))}`;
}

// -------------------------------------------------------- member import ---
// Members are imported/exported as .xlsx (not saved to disk - parsed straight
// from memory, since the file itself doesn't need to persist anywhere).
const uploadMembersFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB is plenty for a member roster
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (![".xlsx", ".xls"].includes(ext)) return cb(new Error("Please upload an .xlsx file"));
    cb(null, true);
  },
});

// ---------------------------------------------------------------- storage --
// On a brand-new deploy (e.g. a fresh Railway volume with nothing on it
// yet), data/db.json won't exist at all - readDb() below has no fallback
// and would crash the whole app on boot. This creates a clean starter file
// (same shape as a freshly-reset local install: default points rules and
// redemption ladder, everything else empty) the very first time, and is a
// complete no-op if the file is already there - so it's always safe to run,
// local Mac installs included.
function ensureDbFile() {
  if (fs.existsSync(DB_PATH)) return;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const starterDb = {
    rules: {
      participation: 100,
      earlyBonus: 10,
      positionBonus: { 1: 1000, 2: 750, 3: 500, 4: 350, 5: 250, 6: 150 },
    },
    ladder: [
      {
        tier: 1,
        pointsRequired: 1500,
        rewardEn: "Starter reward",
        rewardAr: "مكافأة بداية بسيطة",
        descEn: "A small product or a match ticket at the stadium",
        descAr: "منتج صغير أو تذكرة حضور مباراة في الاستاد",
        approverEn: "Committee Secretary (direct)",
        approverAr: "مقرر اللجنة (مباشرة)",
      },
      {
        tier: 2,
        pointsRequired: 4000,
        rewardEn: "Club product / discount",
        rewardAr: "منتج نادي أو خصم",
        descEn: "A club product, or a discount from sponsors/restaurants inside the club",
        descAr: "منتج النادي، أو خصم من الرعاة أو المطاعم داخل النادي",
        approverEn: "Committee Secretary (direct)",
        approverAr: "مقرر اللجنة (مباشرة)",
      },
      {
        tier: 3,
        pointsRequired: 7000,
        rewardEn: "Academy discount",
        rewardAr: "خصم أكاديمية",
        descEn: "A discount on the favorite sport's academy program (duration TBD)",
        descAr: "خصم على برنامج أكاديمية الرياضة المفضلة (مدة تُحدَّد لاحقاً)",
        approverEn: "Head of Sports Entertainment Committee",
        approverAr: "رئيس لجنة الرياضة الترفيهية",
      },
      {
        tier: 4,
        pointsRequired: 10000,
        rewardEn: "4-day family match package",
        rewardAr: "باقة 4 أيام حضور مباريات",
        descEn: "4 tickets x 4 official local matches",
        descAr: "4 تذاكر × 4 مباريات محلية رسمية",
        approverEn: "Head of Sports Entertainment Committee",
        approverAr: "رئيس لجنة الرياضة الترفيهية",
      },
      {
        tier: 5,
        pointsRequired: 20000,
        rewardEn: "7-day family match package",
        rewardAr: "باقة 7 أيام حضور مباريات",
        descEn: "4 tickets x 7 matches: 3 local + 4 non-local, box/premium seating",
        descAr: "4 تذاكر × 7 مباريات: 3 محلية و4 غير محلية، مقصورة أو درجة متقدمة",
        approverEn: "Head of Sports Entertainment Committee",
        approverAr: "رئيس لجنة الرياضة الترفيهية",
      },
      {
        tier: 6,
        pointsRequired: 25000,
        rewardEn: "Player meeting or official jersey",
        rewardAr: "لقاء لاعب أو قميص رسمي",
        descEn: "A meeting with a first-team player of the favorite sport, or the official Al Ahly jersey",
        descAr: "لقاء أحد لاعبي الفريق الأول للرياضة المفضلة، أو قميص الأهلي الرسمي",
        approverEn: "First-team management + Committee Head + Higher Committee",
        approverAr: "إدارة الفريق الأول + رئيس اللجنة + اللجنة العليا",
      },
      {
        tier: 7,
        pointsRequired: 40000,
        rewardEn: "Photo session with first team",
        rewardAr: "جلسة تصوير مع الفريق الأول",
        descEn: "A photo session with the first team for the favorite sport",
        descAr: "جلسة تصوير مع الفريق الأول للرياضة المفضلة",
        approverEn: "First-team management + Committee Head + Higher Committee (prior approval)",
        approverAr: "إدارة الفريق الأول + رئيس اللجنة + اللجنة العليا (موافقة مسبقة)",
      },
    ],
    events: [],
    members: {},
    staffAccounts: {},
    registrations: [],
    redemptions: [],
    nextIds: { event: 1, registration: 1, redemption: 1, dependent: 1, chatMessage: 1, newsPost: 1, spotlight: 1 },
    chatMessages: [],
    newsPosts: [],
    spotlights: [],
    settings: { pointsVisibleToMembers: true },
  };
  fs.writeFileSync(DB_PATH, JSON.stringify(starterDb, null, 2));
  console.log(`No data file found at ${DB_PATH} - created a fresh starter database.`);
}
ensureDbFile();

function readDb() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  db.staffAccounts = db.staffAccounts || {};
  // Backward-compatible defaults for events created before photos/descriptions/
  // recap existed, so older data never crashes the newer frontend.
  db.events = (db.events || []).map((ev) => ({
    descriptionEn: "",
    descriptionAr: "",
    coverPhoto: "",
    minCapacity: null,
    maxCapacity: null,
    ...ev,
    recap: { descriptionEn: "", descriptionAr: "", photos: [], ...(ev.recap || {}) },
  }));
  // Backward-compatible default for registrations created before the
  // waiting-list feature existed - they were all "confirmed" spots.
  db.registrations = (db.registrations || []).map((r) => ({ waitlisted: false, ...r }));
  // Backward-compatible defaults for members created before family members
  // (dependents) existed.
  for (const key of Object.keys(db.members || {})) {
    if (!Array.isArray(db.members[key].dependents)) db.members[key].dependents = [];
  }
  db.nextIds = db.nextIds || {};
  db.nextIds.dependent = db.nextIds.dependent || 1;
  db.nextIds.chatMessage = db.nextIds.chatMessage || 1;
  db.chatMessages = db.chatMessages || [];
  db.nextIds.newsPost = db.nextIds.newsPost || 1;
  db.newsPosts = db.newsPosts || [];
  db.nextIds.spotlight = db.nextIds.spotlight || 1;
  db.spotlights = db.spotlights || [];
  // Global feature toggles the admin controls - currently just whether the
  // points system is surfaced to members at all. Points still accumulate
  // server-side either way; this only controls what members see.
  db.settings = db.settings || {};
  if (typeof db.settings.pointsVisibleToMembers !== "boolean") db.settings.pointsVisibleToMembers = true;
  // Branding: admin-set primary/accent colors and an optional logo, applied
  // across every page (they're just CSS custom properties overridden at
  // runtime). Defaults match the original hardcoded styles.css values, so a
  // deploy that's never touched this setting looks identical to before.
  db.settings.theme = db.settings.theme || {};
  if (!HEX_COLOR_RE.test(db.settings.theme.primaryColor || "")) db.settings.theme.primaryColor = "#8B0000";
  if (!HEX_COLOR_RE.test(db.settings.theme.accentColor || "")) db.settings.theme.accentColor = "#C9A227";
  if (typeof db.settings.theme.logoUrl !== "string") db.settings.theme.logoUrl = "";
  return db;
}
function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
// Never send a password hash back to a client.
function publicMember(m) {
  if (!m) return m;
  const { passwordHash, ...rest } = m;
  return rest;
}
function publicStaff(s) {
  if (!s) return s;
  const { passwordHash, ...rest } = s;
  return rest;
}

// ------------------------------------------------------------- sessions ---
// In-memory only (lost on restart, which just means everyone logs back in -
// fine for this prototype's scale). Not persisted to db.json on purpose:
// sessions are ephemeral, unlike the data they authenticate access to.
const sessions = new Map(); // token -> { type: 'member'|'staff', id, role, expiresAt }

function createSession(type, id, role) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { type, id, role, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}
function getSession(req) {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}
function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
  });
}

// Attaches req.member (the logged-in member's full record) or rejects.
function requireMember(req, res, next) {
  const session = getSession(req);
  if (!session || session.type !== "member") return res.status(401).json({ error: "Please log in" });
  const db = readDb();
  const member = db.members[session.id];
  if (!member) return res.status(401).json({ error: "Please log in" });
  req.db = db;
  req.member = member;
  next();
}
// Attaches req.staff (the logged-in staff/admin record). role='admin' means
// only admins pass; role='staff' means staff OR admin pass (admins can do
// everything staff can).
function requireStaffRole(role) {
  return (req, res, next) => {
    const session = getSession(req);
    if (!session || session.type !== "staff") return res.status(401).json({ error: "Please sign in" });
    if (role === "admin" && session.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    const db = readDb();
    const staff = db.staffAccounts[session.id];
    if (!staff) return res.status(401).json({ error: "Please sign in" });
    req.db = db;
    req.staff = staff;
    next();
  };
}

// The very first time the app runs with no staff accounts at all, seed one
// admin account so there's a way in. Prints the credentials to the console;
// change the password immediately after the first login (see the
// change-password endpoint below).
function bootstrapAdmin() {
  const db = readDb();
  if (Object.keys(db.staffAccounts).length > 0) return;
  db.staffAccounts[BOOTSTRAP_ADMIN_USERNAME] = {
    username: BOOTSTRAP_ADMIN_USERNAME,
    name: "Committee Admin",
    role: "admin",
    passwordHash: bcrypt.hashSync(BOOTSTRAP_ADMIN_PASSWORD, 10),
  };
  writeDb(db);
  console.log("No staff accounts existed yet - created a first admin account:");
  console.log(`  username: ${BOOTSTRAP_ADMIN_USERNAME}`);
  console.log(`  password: ${BOOTSTRAP_ADMIN_PASSWORD}`);
  console.log("  Log in on the Admin tab, then change this password right away.");
}

// --------------------------------------------------------- QR check-in ----
// Stateless signed token: no need to store it, it's recomputed from the
// registration's own fields + the server secret, so a copied/altered QR
// image won't verify against a different registration.
function signRegistration(reg) {
  return crypto
    .createHmac("sha256", QR_SECRET)
    .update(`${reg.id}.${reg.membershipNumber}.${reg.eventId}`)
    .digest("hex")
    .slice(0, 16);
}
function qrPayload(reg) {
  return `AHLAWY:${reg.id}:${signRegistration(reg)}`;
}
async function qrDataUrl(reg) {
  return QRCode.toDataURL(qrPayload(reg), { margin: 1, width: 260 });
}
function parseAndVerify(db, code) {
  const parts = String(code || "").trim().split(":");
  if (parts.length !== 3 || parts[0] !== "AHLAWY") return { error: "Not a recognized Ahlawy QR code" };
  const regId = Number(parts[1]);
  const reg = db.registrations.find((r) => r.id === regId);
  if (!reg) return { error: "Registration not found" };
  if (signRegistration(reg) !== parts[2]) return { error: "Invalid or tampered code" };
  return { reg };
}

// -------------------------------------------------------- points helpers --
function ladderTier(db, tier) {
  return db.ladder.find((t) => t.tier === Number(tier));
}

// Every registration's points, computed the same way as the Points Ledger
// sheet in the spreadsheet toolkit: participation + early bonus + position bonus.
// Points only count once the member is actually checked in at the event (QR
// scan) - registering alone does not earn points, so no-shows earn nothing.
function registrationPoints(db, reg) {
  if (!reg.checkedIn) return 0;
  const participation = db.rules.participation;
  const earlyBonus = reg.earlyRegistration ? db.rules.earlyBonus : 0;
  const positionBonus = reg.position ? (db.rules.positionBonus[String(reg.position)] || 0) : 0;
  return participation + earlyBonus + positionBonus;
}
// Points a registration WOULD earn if checked in - used to show a preview
// on the registration confirmation screen ("you'll earn up to X pts").
function potentialPoints(db, reg) {
  return registrationPoints(db, { ...reg, checkedIn: true });
}

// Pooling key mirrors the spreadsheet: family group if set, else the
// membership number itself. This is what lets Phase Two (family pooling)
// activate later with zero migration - the field exists from day one.
function poolingKey(db, membershipNumber) {
  const m = db.members[membershipNumber];
  if (!m) return membershipNumber;
  return m.familyGroup && m.familyGroup.trim() ? `FAM:${m.familyGroup.trim()}` : membershipNumber;
}

function membersInPool(db, key) {
  return Object.values(db.members).filter((m) => poolingKey(db, m.membershipNumber) === key);
}

function totalEarned(db, key) {
  const memberNumbers = new Set(membersInPool(db, key).map((m) => m.membershipNumber));
  return db.registrations
    .filter((r) => memberNumbers.has(r.membershipNumber))
    .reduce((sum, r) => sum + registrationPoints(db, r), 0);
}

function totalRedeemed(db, key) {
  const memberNumbers = new Set(membersInPool(db, key).map((m) => m.membershipNumber));
  return db.redemptions
    .filter((r) => memberNumbers.has(r.membershipNumber) && (r.status === "Approved" || r.status === "Fulfilled"))
    .reduce((sum, r) => {
      const tier = ladderTier(db, r.tier);
      return sum + (tier ? tier.pointsRequired : 0);
    }, 0);
}

function nextReachableTier(db, balance) {
  const reachable = db.ladder.filter((t) => t.pointsRequired <= balance);
  if (!reachable.length) return null;
  return reachable[reachable.length - 1]; // ladder is defined ascending
}

function balanceSnapshot(db, membershipNumber) {
  const member = db.members[membershipNumber];
  if (!member) return null;
  const key = poolingKey(db, membershipNumber);
  const earned = totalEarned(db, key);
  const redeemed = totalRedeemed(db, key);
  const balance = earned - redeemed;
  return {
    membershipNumber,
    member: publicMember(member),
    poolingKey: key,
    familyPooled: key.startsWith("FAM:"),
    poolMembers: membersInPool(db, key).map((m) => ({ membershipNumber: m.membershipNumber, name: m.name })),
    totalEarned: earned,
    totalRedeemed: redeemed,
    balance,
    nextReachableTier: nextReachableTier(db, balance),
  };
}

// -------------------------------------------------------------------------
// AUTH
// -------------------------------------------------------------------------

// Member sign-up: creates the member's account (and profile) in one step.
app.post("/api/auth/signup", async (req, res) => {
  const db = readDb();
  const { membershipNumber, name, password, familyGroup, phone } = req.body;
  if (!membershipNumber || !name || !password) {
    return res.status(400).json({ error: "membershipNumber, name, and password are required" });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  const existing = db.members[membershipNumber];
  if (existing && existing.passwordHash) {
    return res.status(409).json({ error: "An account already exists for this membership number. Please log in." });
  }
  // `existing` with no passwordHash means an admin imported this member
  // ahead of time (see /api/admin/members/import) - this is them claiming
  // that profile rather than starting from scratch, so keep whatever was
  // already on file (family group, phone, dependents) unless they're
  // explicitly overriding it here.
  const passwordHash = await bcrypt.hash(password, 10);
  db.members[membershipNumber] = {
    membershipNumber,
    name,
    familyGroup: familyGroup || (existing ? existing.familyGroup : "") || "",
    phone: phone || (existing ? existing.phone : "") || "",
    passwordHash,
    dependents: (existing && existing.dependents) || [],
  };
  writeDb(db);

  const token = createSession("member", membershipNumber);
  setSessionCookie(res, token);
  res.status(201).json({ member: publicMember(db.members[membershipNumber]) });
});

app.post("/api/auth/login", async (req, res) => {
  const db = readDb();
  const { membershipNumber, password } = req.body;
  const member = db.members[membershipNumber];
  if (!member || !member.passwordHash || !(await bcrypt.compare(password || "", member.passwordHash))) {
    return res.status(401).json({ error: "Incorrect membership number or password" });
  }
  const token = createSession("member", membershipNumber);
  setSessionCookie(res, token);
  res.json({ member: publicMember(member) });
});

app.post("/api/auth/staff-login", async (req, res) => {
  const db = readDb();
  const { username, password } = req.body;
  const staff = db.staffAccounts[username];
  if (!staff || !(await bcrypt.compare(password || "", staff.passwordHash))) {
    return res.status(401).json({ error: "Incorrect username or password" });
  }
  const token = createSession("staff", username, staff.role);
  setSessionCookie(res, token);
  res.json({ staff: publicStaff(staff) });
});

app.post("/api/auth/logout", (req, res) => {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not signed in" });
  const db = readDb();
  if (session.type === "member") {
    const member = db.members[session.id];
    if (!member) return res.status(401).json({ error: "Not signed in" });
    return res.json({ type: "member", member: publicMember(member) });
  }
  const staff = db.staffAccounts[session.id];
  if (!staff) return res.status(401).json({ error: "Not signed in" });
  res.json({ type: "staff", staff: publicStaff(staff) });
});

app.post("/api/auth/change-password", async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Please sign in" });
  const { oldPassword, newPassword } = req.body;
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters" });
  }
  const db = readDb();
  const account = session.type === "member" ? db.members[session.id] : db.staffAccounts[session.id];
  if (!account || !(await bcrypt.compare(oldPassword || "", account.passwordHash))) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }
  account.passwordHash = await bcrypt.hash(newPassword, 10);
  writeDb(db);
  res.json({ ok: true });
});

// Admin-only: onboard more staff/admin accounts (replaces the old shared-key model).
app.post("/api/staff/accounts", requireStaffRole("admin"), async (req, res) => {
  const db = readDb();
  const { username, password, name, role } = req.body;
  if (!username || !password || !name || !["admin", "staff"].includes(role)) {
    return res.status(400).json({ error: "username, password, name, and a valid role are required" });
  }
  if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  if (db.staffAccounts[username]) return res.status(409).json({ error: "That username is already taken" });
  db.staffAccounts[username] = { username, name, role, passwordHash: await bcrypt.hash(password, 10) };
  writeDb(db);
  res.status(201).json({ staff: publicStaff(db.staffAccounts[username]) });
});

app.get("/api/staff/accounts", requireStaffRole("admin"), (req, res) => {
  res.json(Object.values(req.db.staffAccounts).map(publicStaff));
});

app.delete("/api/staff/accounts/:username", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const { username } = req.params;
  if (username === req.staff.username) return res.status(400).json({ error: "You can't remove your own account" });
  if (!db.staffAccounts[username]) return res.status(404).json({ error: "Account not found" });
  delete db.staffAccounts[username];
  writeDb(db);
  res.json({ ok: true });
});

// "Forgot password" for members, without any email/SMS infrastructure: the
// member contacts the committee directly, and an admin resets their
// password here from the Admin tab, then tells them the new one in person
// or by phone/WhatsApp. No token or identity check beyond "you're a logged
// in admin" - same trust model as an admin creating staff accounts above.
app.post("/api/staff/members/:membershipNumber/reset-password", requireStaffRole("admin"), async (req, res) => {
  const db = req.db;
  const { membershipNumber } = req.params;
  const { newPassword } = req.body;
  const member = db.members[membershipNumber];
  if (!member) return res.status(404).json({ error: "No member found with that membership number" });
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters" });
  }
  member.passwordHash = await bcrypt.hash(newPassword, 10);
  writeDb(db);
  res.json({ ok: true, member: publicMember(member) });
});

// -------------------------------------------------------------------------
// SUPPORT CHAT (member <-> committee)
// -------------------------------------------------------------------------
// One private thread per member, with the whole committee (any admin) on
// the other side - not a broadcast/group chat. Plain polling instead of
// websockets, consistent with how the rest of this prototype favors
// "fetch again on a timer" over a persistent connection.
function chatThread(db, membershipNumber) {
  return db.chatMessages
    .filter((m) => m.membershipNumber === membershipNumber)
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
}

app.get("/api/me/chat/messages", requireMember, (req, res) => {
  const db = req.db;
  const membershipNumber = req.member.membershipNumber;
  // Opening the thread counts as having seen whatever the committee sent so far.
  let changed = false;
  db.chatMessages.forEach((m) => {
    if (m.membershipNumber === membershipNumber && m.sender === "staff" && !m.readByMember) {
      m.readByMember = true;
      changed = true;
    }
  });
  if (changed) writeDb(db);
  res.json(chatThread(db, membershipNumber));
});

// Lightweight - does NOT mark messages read, so the unread badge (polled
// from anywhere in the app) stays accurate until the member actually opens
// the chat card.
app.get("/api/me/chat/unread-count", requireMember, (req, res) => {
  const db = req.db;
  const count = db.chatMessages.filter(
    (m) => m.membershipNumber === req.member.membershipNumber && m.sender === "staff" && !m.readByMember
  ).length;
  res.json({ count });
});

app.post("/api/me/chat/messages", requireMember, (req, res) => {
  const db = req.db;
  const { text } = req.body;
  if (!text || !String(text).trim()) return res.status(400).json({ error: "Message can't be empty" });
  const member = db.members[req.member.membershipNumber];
  const message = {
    id: db.nextIds.chatMessage++,
    membershipNumber: req.member.membershipNumber,
    sender: "member",
    senderName: member.name,
    text: String(text).trim().slice(0, 2000),
    sentAt: new Date().toISOString(),
    readByMember: true,
    readByStaff: false,
  };
  db.chatMessages.push(message);
  writeDb(db);
  res.status(201).json(message);
});

// Admin side: an inbox listing every member with an active thread, plus
// per-thread read/reply. Gated to admins (not plain staff) to match the
// existing role split, where "Staff" is scoped to the Gate Scanner only.
app.get("/api/staff/chats", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const latestByMember = new Map();
  for (const m of db.chatMessages) {
    const existing = latestByMember.get(m.membershipNumber);
    if (!existing || existing.sentAt < m.sentAt) latestByMember.set(m.membershipNumber, m);
  }
  const threads = Array.from(latestByMember.entries()).map(([membershipNumber, lastMessage]) => {
    const member = db.members[membershipNumber];
    const unreadCount = db.chatMessages.filter(
      (m) => m.membershipNumber === membershipNumber && m.sender === "member" && !m.readByStaff
    ).length;
    return {
      membershipNumber,
      memberName: member ? member.name : membershipNumber,
      lastMessage: lastMessage.text,
      lastMessageAt: lastMessage.sentAt,
      lastMessageSender: lastMessage.sender,
      unreadCount,
    };
  });
  threads.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  res.json(threads);
});

app.get("/api/staff/chats/unread-count", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const count = db.chatMessages.filter((m) => m.sender === "member" && !m.readByStaff).length;
  res.json({ count });
});

app.get("/api/staff/chats/:membershipNumber", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const { membershipNumber } = req.params;
  if (!db.members[membershipNumber]) {
    return res.status(404).json({ error: "No member found with that membership number" });
  }
  let changed = false;
  db.chatMessages.forEach((m) => {
    if (m.membershipNumber === membershipNumber && m.sender === "member" && !m.readByStaff) {
      m.readByStaff = true;
      changed = true;
    }
  });
  if (changed) writeDb(db);
  res.json(chatThread(db, membershipNumber));
});

app.post("/api/staff/chats/:membershipNumber", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const { membershipNumber } = req.params;
  const { text } = req.body;
  if (!db.members[membershipNumber]) {
    return res.status(404).json({ error: "No member found with that membership number" });
  }
  if (!text || !String(text).trim()) return res.status(400).json({ error: "Message can't be empty" });
  const message = {
    id: db.nextIds.chatMessage++,
    membershipNumber,
    sender: "staff",
    senderName: req.staff.name,
    text: String(text).trim().slice(0, 2000),
    sentAt: new Date().toISOString(),
    readByMember: false,
    readByStaff: true,
  };
  db.chatMessages.push(message);
  writeDb(db);
  res.status(201).json(message);
});

// -------------------------------------------------------------------------
// EVENTS
// -------------------------------------------------------------------------
// Used to gate event edits: an event's details can be changed any time up
// until its date has passed, matching the same "upcoming vs past" cutoff
// the frontend already uses to move a card to Annual Activities.
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// A "confirmed" registration counts against capacity; a waitlisted one
// doesn't - it's a request for a spot, not a spot itself.
function confirmedRegistrationCount(db, eventId) {
  return db.registrations.filter((r) => r.eventId === eventId && !r.waitlisted).length;
}
function waitlistedRegistrationCount(db, eventId) {
  return db.registrations.filter((r) => r.eventId === eventId && r.waitlisted).length;
}
// Parses a capacity field from a form body: "" / undefined -> null (no
// limit set), otherwise a non-negative integer. Returns undefined on a
// genuinely invalid (non-numeric) value so the caller can reject the request.
function parseCapacity(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

app.get("/api/events", (req, res) => {
  const db = readDb();
  const events = db.events.map((ev) => ({
    ...ev,
    confirmedCount: confirmedRegistrationCount(db, ev.id),
    waitlistCount: waitlistedRegistrationCount(db, ev.id),
  }));
  res.json(events);
});

app.post(
  "/api/events",
  requireStaffRole("admin"),
  uploadEventPhoto.single("coverPhoto"),
  (req, res) => {
    const db = req.db;
    const { nameEn, nameAr, sport, date, earlyDeadline, descriptionEn, descriptionAr, minCapacity, maxCapacity } =
      req.body;
    if (!nameEn || !date) return res.status(400).json({ error: "nameEn and date are required" });
    const min = parseCapacity(minCapacity);
    const max = parseCapacity(maxCapacity);
    if (min === undefined || max === undefined) {
      return res.status(400).json({ error: "Min and max capacity must be empty or a non-negative number" });
    }
    if (min !== null && max !== null && min > max) {
      return res.status(400).json({ error: "Minimum capacity can't be greater than maximum capacity" });
    }
    const event = {
      id: db.nextIds.event++,
      nameEn,
      nameAr: nameAr || "",
      sport: sport || "",
      date,
      earlyDeadline: earlyDeadline || null,
      descriptionEn: descriptionEn || "",
      descriptionAr: descriptionAr || "",
      minCapacity: min,
      maxCapacity: max,
      coverPhoto: req.file ? `/uploads/events/${req.file.filename}` : "",
      recap: { descriptionEn: "", descriptionAr: "", photos: [] },
    };
    db.events.push(event);
    writeDb(db);
    res.status(201).json(event);
  }
);

// Editing is only allowed up until the event's date - once it's passed (and
// the card has moved to Annual Activities), the details lock; only the
// after-event recap (see /api/events/:eventId/results below) can still be
// added at that point.
app.put(
  "/api/events/:eventId",
  requireStaffRole("admin"),
  uploadEventPhoto.single("coverPhoto"),
  (req, res) => {
    const db = req.db;
    const eventId = Number(req.params.eventId);
    const event = db.events.find((e) => e.id === eventId);
    if (!event) return res.status(404).json({ error: "No such event" });
    if (event.date < todayStr()) {
      return res.status(400).json({ error: "This event has already finished and can no longer be edited" });
    }
    const { nameEn, nameAr, sport, date, earlyDeadline, descriptionEn, descriptionAr, minCapacity, maxCapacity } =
      req.body;
    if (!nameEn || !date) return res.status(400).json({ error: "nameEn and date are required" });
    const min = parseCapacity(minCapacity);
    const max = parseCapacity(maxCapacity);
    if (min === undefined || max === undefined) {
      return res.status(400).json({ error: "Min and max capacity must be empty or a non-negative number" });
    }
    if (min !== null && max !== null && min > max) {
      return res.status(400).json({ error: "Minimum capacity can't be greater than maximum capacity" });
    }
    event.nameEn = nameEn;
    event.nameAr = nameAr || "";
    event.sport = sport || "";
    event.date = date;
    event.earlyDeadline = earlyDeadline || null;
    event.descriptionEn = descriptionEn || "";
    event.descriptionAr = descriptionAr || "";
    event.minCapacity = min;
    event.maxCapacity = max;
    if (req.file) event.coverPhoto = `/uploads/events/${req.file.filename}`;
    writeDb(db);
    res.json({
      ...event,
      confirmedCount: confirmedRegistrationCount(db, event.id),
      waitlistCount: waitlistedRegistrationCount(db, event.id),
    });
  }
);

// -------------------------------------------------------------------------
// COMMUNITY (committee news + member spotlights on the landing page)
// -------------------------------------------------------------------------
// Both reuse uploadEventPhoto for their optional photo - it's a generic
// image-upload helper despite the name, and there's no reason to duplicate
// the multer setup for what's still just "one image file, stored on disk."
app.get("/api/news", (req, res) => {
  const db = readDb();
  res.json(db.newsPosts.slice().sort((a, b) => b.postedAt.localeCompare(a.postedAt)));
});

app.post("/api/news", requireStaffRole("admin"), uploadEventPhoto.single("photo"), (req, res) => {
  const db = req.db;
  const { titleEn, titleAr, bodyEn, bodyAr } = req.body;
  if (!titleEn || !bodyEn) return res.status(400).json({ error: "titleEn and bodyEn are required" });
  const post = {
    id: db.nextIds.newsPost++,
    titleEn,
    titleAr: titleAr || "",
    bodyEn,
    bodyAr: bodyAr || "",
    photo: req.file ? `/uploads/events/${req.file.filename}` : "",
    postedAt: new Date().toISOString(),
  };
  db.newsPosts.push(post);
  writeDb(db);
  res.status(201).json(post);
});

app.delete("/api/news/:id", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  const before = db.newsPosts.length;
  db.newsPosts = db.newsPosts.filter((p) => p.id !== id);
  if (db.newsPosts.length === before) return res.status(404).json({ error: "No such news post" });
  writeDb(db);
  res.json({ ok: true });
});

app.get("/api/spotlights", (req, res) => {
  const db = readDb();
  res.json(db.spotlights.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.post("/api/spotlights", requireStaffRole("admin"), uploadEventPhoto.single("photo"), (req, res) => {
  const db = req.db;
  const { name, blurbEn, blurbAr } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const spotlight = {
    id: db.nextIds.spotlight++,
    name,
    blurbEn: blurbEn || "",
    blurbAr: blurbAr || "",
    photo: req.file ? `/uploads/events/${req.file.filename}` : "",
    createdAt: new Date().toISOString(),
  };
  db.spotlights.push(spotlight);
  writeDb(db);
  res.status(201).json(spotlight);
});

app.delete("/api/spotlights/:id", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  const before = db.spotlights.length;
  db.spotlights = db.spotlights.filter((s) => s.id !== id);
  if (db.spotlights.length === before) return res.status(404).json({ error: "No such spotlight" });
  writeDb(db);
  res.json({ ok: true });
});

// A no-privacy-risk "the community is alive" strip for the landing page:
// member/event counts plus a top-earners leaderboard (name + balance only -
// nothing else about a member is exposed here).
app.get("/api/community-stats", (req, res) => {
  const db = readDb();
  const totalMembers = Object.keys(db.members).length;
  const eventsHeld = db.events.filter((e) => e.date < todayStr()).length;
  const topEarners = Object.keys(db.members)
    .map((membershipNumber) => {
      const snap = balanceSnapshot(db, membershipNumber);
      return { name: db.members[membershipNumber].name, balance: snap ? snap.balance : 0 };
    })
    .filter((m) => m.balance > 0)
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 5);
  res.json({ totalMembers, eventsHeld, topEarners });
});

// -------------------------------------------------------------------------
// LADDER
// -------------------------------------------------------------------------
app.get("/api/ladder", (req, res) => {
  const db = readDb();
  res.json({ ladder: db.ladder, rules: db.rules });
});

// Admin-only: edit the point values (participation, early bonus, position
// bonus per finishing place). Points are computed live from these values
// whenever a balance is calculated - nothing is frozen at the moment a
// member earns them - so a change here immediately re-values every past
// registration too, not just future ones. The frontend warns about this
// before saving.
app.put("/api/rules", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const { participation, earlyBonus, positionBonus } = req.body;

  const errors = [];
  const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
  if (!isNonNegInt(participation)) errors.push("participation must be a non-negative whole number");
  if (!isNonNegInt(earlyBonus)) errors.push("earlyBonus must be a non-negative whole number");
  const cleanPositionBonus = {};
  if (typeof positionBonus !== "object" || positionBonus === null) {
    errors.push("positionBonus must be an object keyed 1-6");
  } else {
    for (const place of ["1", "2", "3", "4", "5", "6"]) {
      const v = Number(positionBonus[place]);
      if (!isNonNegInt(v)) {
        errors.push(`positionBonus[${place}] must be a non-negative whole number`);
      } else {
        cleanPositionBonus[place] = v;
      }
    }
  }
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });

  db.rules = { participation, earlyBonus, positionBonus: cleanPositionBonus };
  writeDb(db);
  res.json({ rules: db.rules });
});

// Admin-only: edit one tier of the redemption ladder (points required and
// all reward/approver text). Tiers are fixed at 7 (matching the source
// document's ladder) - this edits an existing tier, it doesn't add/remove one.
app.put("/api/ladder/:tier", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const tierNum = Number(req.params.tier);
  const tier = db.ladder.find((t) => t.tier === tierNum);
  if (!tier) return res.status(404).json({ error: "No such ladder tier" });

  const { pointsRequired, rewardEn, rewardAr, descEn, descAr, approverEn, approverAr } = req.body;
  if (!Number.isInteger(pointsRequired) || pointsRequired <= 0) {
    return res.status(400).json({ error: "pointsRequired must be a positive whole number" });
  }
  if (!rewardEn || !approverEn) {
    return res.status(400).json({ error: "rewardEn and approverEn are required" });
  }

  Object.assign(tier, {
    pointsRequired,
    rewardEn,
    rewardAr: rewardAr || "",
    descEn: descEn || "",
    descAr: descAr || "",
    approverEn,
    approverAr: approverAr || "",
  });
  writeDb(db);
  res.json({ tier });
});

// -------------------------------------------------------------------------
// MY ACCOUNT (member-only, tied to the logged-in session)
// -------------------------------------------------------------------------
app.get("/api/me/balance", requireMember, (req, res) => {
  res.json(balanceSnapshot(req.db, req.member.membershipNumber));
});

app.patch("/api/me/profile", requireMember, (req, res) => {
  const db = req.db;
  const { name, familyGroup, phone } = req.body;
  const member = db.members[req.member.membershipNumber];
  if (name) member.name = name;
  if (familyGroup !== undefined) member.familyGroup = familyGroup;
  if (phone !== undefined) member.phone = phone;
  writeDb(db);
  res.json({ member: publicMember(member) });
});

// Family members ("dependents") don't get their own login - they're added
// under the primary member's account, who registers them for events and
// manages their QR codes. Their registrations still count toward the
// primary member's own points balance (same membershipNumber), which is
// also how the existing point-pooling logic already works.
app.post("/api/me/dependents", requireMember, (req, res) => {
  const db = req.db;
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name is required" });
  const member = db.members[req.member.membershipNumber];
  member.dependents = member.dependents || [];
  const dependent = { id: db.nextIds.dependent++, name };
  member.dependents.push(dependent);
  writeDb(db);
  res.status(201).json({ dependents: member.dependents });
});

app.delete("/api/me/dependents/:id", requireMember, (req, res) => {
  const db = req.db;
  const member = db.members[req.member.membershipNumber];
  const id = Number(req.params.id);
  member.dependents = (member.dependents || []).filter((d) => d.id !== id);
  writeDb(db);
  res.json({ dependents: member.dependents });
});

app.get("/api/me/registrations", requireMember, async (req, res) => {
  const db = req.db;
  const regs = db.registrations.filter((r) => r.membershipNumber === req.member.membershipNumber);
  const enriched = await Promise.all(
    regs.map(async (r) => ({
      ...r,
      event: db.events.find((e) => e.id === r.eventId),
      points: registrationPoints(db, r),
      qrDataUrl: r.checkedIn || r.waitlisted ? null : await qrDataUrl(r), // no QR once checked in, or while still just a waitlist request
    }))
  );
  res.json(enriched);
});

// This is the "online registration" endpoint: the logged-in member signs up
// for an event. Early registration is detected automatically from the
// event's deadline.
app.post("/api/register", requireMember, async (req, res) => {
  const db = req.db;
  const { eventId, dependentId, joinWaitlist } = req.body;
  const membershipNumber = req.member.membershipNumber;
  if (!eventId) return res.status(400).json({ error: "eventId is required" });
  const event = db.events.find((e) => e.id === Number(eventId));
  if (!event) return res.status(404).json({ error: "Event not found" });

  // Registering for a family member (dependent) instead of yourself: their
  // registration still lives under the primary member's membershipNumber
  // (so points pool the same way as everything else), but is tagged with
  // who's actually attending.
  let dependentName = null;
  const normalizedDependentId = dependentId ? Number(dependentId) : null;
  if (normalizedDependentId) {
    const dependent = (req.member.dependents || []).find((d) => d.id === normalizedDependentId);
    if (!dependent) return res.status(400).json({ error: "No such family member on your account" });
    dependentName = dependent.name;
  }

  const already = db.registrations.find(
    (r) =>
      r.membershipNumber === membershipNumber &&
      r.eventId === event.id &&
      (r.dependentId || null) === normalizedDependentId
  );
  if (already) {
    // Not just a bare error: if they're not checked in yet and not on the
    // waiting list, their original QR code is still valid, so hand it back
    // here too - otherwise a member who double-taps "register" (or
    // re-registers after navigating away) sees an error message with no way
    // to get back to their QR without digging through My Registrations.
    return res.status(409).json({
      error: `${dependentName ? dependentName + " is" : "You're"} already ${
        already.waitlisted ? "on the waiting list for" : "registered for"
      } this event`,
      alreadyRegistered: true,
      checkedIn: !!already.checkedIn,
      waitlisted: !!already.waitlisted,
      registration: already,
      qrDataUrl: already.checkedIn || already.waitlisted ? null : await qrDataUrl(already),
      potentialPoints: potentialPoints(db, already),
    });
  }

  // Capacity check: a "confirmed" registration counts against maxCapacity;
  // once that's full, new sign-ups need to explicitly opt into the waiting
  // list rather than silently becoming a confirmed spot (or a silent error).
  let isWaitlisted = false;
  if (event.maxCapacity !== null && confirmedRegistrationCount(db, event.id) >= event.maxCapacity) {
    if (!joinWaitlist) {
      return res.status(200).json({
        needsWaitlistConfirmation: true,
        messageEn:
          "Registration for this event has reached its limit. Would you like to be added to the waiting list? A waiting-list spot is not a guaranteed place at the event - the committee will confirm you if a spot opens up.",
        messageAr:
          "اكتمل عدد المسجلين في هذه الفعالية. هل ترغب في الانضمام إلى قائمة الانتظار؟ الانضمام لقائمة الانتظار لا يضمن مكاناً في الفعالية - ستقوم اللجنة بتأكيد مكانك في حال توفر مكان.",
      });
    }
    isWaitlisted = true;
  }

  const registeredAt = new Date().toISOString();
  const earlyRegistration = event.earlyDeadline ? registeredAt <= event.earlyDeadline : false;

  const registration = {
    id: db.nextIds.registration++,
    membershipNumber,
    eventId: event.id,
    dependentId: normalizedDependentId,
    dependentName,
    registeredAt,
    earlyRegistration,
    position: null,
    checkedIn: false,
    checkInAt: null,
    waitlisted: isWaitlisted,
  };
  db.registrations.push(registration);
  writeDb(db);

  const possessive = dependentName ? `${dependentName}'s` : "Your";
  if (isWaitlisted) {
    return res.status(201).json({
      registration,
      qrDataUrl: null,
      waitlisted: true,
      message: `${possessive} spot on the waiting list is confirmed. Check My Registrations for updates - you'll get a QR code here if a spot opens up.`,
    });
  }

  const qr = await qrDataUrl(registration);
  res.status(201).json({
    registration,
    qrDataUrl: qr,
    potentialPoints: potentialPoints(db, registration),
    message: earlyRegistration
      ? `${possessive} slot is booked - early-registration bonus locked in! Show this QR code at the event to earn points.`
      : `${possessive} slot is booked! Show this QR code at the event to earn points.`,
  });
});

app.get("/api/registrations", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  let regs = db.registrations;
  if (req.query.eventId) regs = regs.filter((r) => r.eventId === Number(req.query.eventId));
  const enriched = regs.map((r) => {
    const member = publicMember(db.members[r.membershipNumber]);
    return {
      ...r,
      member,
      attendeeName: r.dependentName || (member ? member.name : ""),
      points: registrationPoints(db, r),
    };
  });
  res.json(enriched);
});

// -------------------------------------------------------------------------
// CHECK-IN (staff/admin only)
// -------------------------------------------------------------------------
// Staff-only: scan a member's QR code at the event entrance. This is what
// actually awards their points (participation + early bonus + position
// bonus once results are in) - registering alone earns nothing.
app.post("/api/checkin", requireStaffRole("staff"), async (req, res) => {
  const db = req.db;
  const { code } = req.body;
  const { reg, error } = parseAndVerify(db, code);
  if (error) return res.status(400).json({ error });

  const event = db.events.find((e) => e.id === reg.eventId);
  const member = publicMember(db.members[reg.membershipNumber]);
  // The person actually walking through the gate might be a family member
  // (dependent) registered under this member's account, not the member
  // themselves - show whoever it really is.
  const attendeeName = reg.dependentName || member.name;

  if (reg.checkedIn) {
    return res.status(409).json({
      error: "Already checked in",
      checkedInAt: reg.checkInAt,
      member,
      attendeeName,
      event,
    });
  }
  if (reg.waitlisted) {
    return res.status(409).json({
      error: "This registration is on the waiting list, not a confirmed spot - promote it from the Admin dashboard first if there's room",
      member,
      attendeeName,
      event,
    });
  }

  reg.checkedIn = true;
  reg.checkInAt = new Date().toISOString();
  writeDb(db);

  res.json({
    success: true,
    member,
    attendeeName,
    event,
    checkedInAt: reg.checkInAt,
    pointsAwarded: registrationPoints(db, reg),
    earlyRegistration: reg.earlyRegistration,
  });
});

// admin: enter finishing positions after an event, and optionally attach the
// after-event recap (a short write-up + extra photos) at the same time -
// this is what makes the event show up with full details on the Annual
// Activities page once it's moved there (automatically, based on its date).
app.post(
  "/api/events/:eventId/results",
  requireStaffRole("admin"),
  uploadEventPhoto.array("recapPhotos", 10),
  (req, res) => {
    const db = req.db;
    const eventId = Number(req.params.eventId);
    let results;
    try {
      results = JSON.parse(req.body.results || "[]");
    } catch (e) {
      return res.status(400).json({ error: "results must be valid JSON" });
    }
    if (!Array.isArray(results)) return res.status(400).json({ error: "results must be an array" });

    // Matched by registration id, not membershipNumber - a member can have
    // more than one registration for the same event now (themselves plus
    // any family members they registered), all sharing one membershipNumber.
    let updated = 0;
    for (const { registrationId, position } of results) {
      const reg = db.registrations.find((r) => r.id === Number(registrationId) && r.eventId === eventId);
      if (reg) {
        reg.position = position ? Number(position) : null;
        updated++;
      }
    }

    const event = db.events.find((e) => e.id === eventId);
    if (!event) return res.status(404).json({ error: "No such event" });
    event.recap = event.recap || { descriptionEn: "", descriptionAr: "", photos: [] };
    if (typeof req.body.recapDescriptionEn === "string") event.recap.descriptionEn = req.body.recapDescriptionEn;
    if (typeof req.body.recapDescriptionAr === "string") event.recap.descriptionAr = req.body.recapDescriptionAr;
    if (req.files && req.files.length) {
      event.recap.photos.push(...req.files.map((f) => `/uploads/events/${f.filename}`));
    }

    writeDb(db);
    res.json({ updated, event });
  }
);

// -------------------------------------------------------------------------
// REDEMPTIONS
// -------------------------------------------------------------------------
app.post("/api/redeem", requireMember, (req, res) => {
  const db = req.db;
  const membershipNumber = req.member.membershipNumber;
  const { tier } = req.body;
  const tierDef = ladderTier(db, tier);
  if (!tierDef) return res.status(400).json({ error: "Invalid tier" });

  const snapshot = balanceSnapshot(db, membershipNumber);
  const redemption = {
    id: db.nextIds.redemption++,
    membershipNumber,
    tier: tierDef.tier,
    pointsCost: tierDef.pointsRequired,
    approvalLevel: tierDef.approverEn,
    requestedAt: new Date().toISOString(),
    status: "Pending",
    approvedBy: null,
    fulfilledAt: null,
    balanceAtRequestTime: snapshot.balance,
  };
  db.redemptions.push(redemption);
  writeDb(db);
  res.status(201).json({
    redemption,
    sufficientBalance: snapshot.balance >= tierDef.pointsRequired,
    currentBalance: snapshot.balance,
  });
});

app.get("/api/redemptions", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  let list = db.redemptions;
  if (req.query.status) list = list.filter((r) => r.status === req.query.status);
  const enriched = list.map((r) => ({
    ...r,
    member: publicMember(db.members[r.membershipNumber]),
    reward: ladderTier(db, r.tier),
    currentBalance: balanceSnapshot(db, r.membershipNumber).balance,
  }));
  res.json(enriched);
});

app.post("/api/redemptions/:id/status", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  const { status } = req.body;
  const valid = ["Pending", "Approved", "Rejected", "Fulfilled"];
  if (!valid.includes(status)) return res.status(400).json({ error: "Invalid status" });
  const redemption = db.redemptions.find((r) => r.id === id);
  if (!redemption) return res.status(404).json({ error: "Redemption not found" });
  redemption.status = status;
  // Recorded automatically from the logged-in admin's own account now,
  // instead of free-typed text - a real audit trail.
  redemption.approvedBy = `${req.staff.name} (${req.staff.username})`;
  if (status === "Fulfilled") redemption.fulfilledAt = new Date().toISOString();
  writeDb(db);
  res.json(redemption);
});

// -------------------------------------------------------------------------
// ADMIN OVERVIEW
// -------------------------------------------------------------------------
app.get("/api/admin/overview", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  res.json({
    totalMembers: Object.keys(db.members).length,
    totalEvents: db.events.length,
    totalRegistrations: db.registrations.length,
    totalCheckedIn: db.registrations.filter((r) => r.checkedIn).length,
    pendingRedemptions: db.redemptions.filter((r) => r.status === "Pending").length,
    totalStaffAccounts: Object.keys(db.staffAccounts).length,
  });
});

// Per-event registration/attendance breakdown for the admin dashboard - one
// row per event, newest first, with confirmed/waitlist/checked-in counts and
// the capacity the admin set (if any). Min is informational only (shown so
// the committee can see at a glance whether an event is under its target),
// it never blocks a registration.
app.get("/api/admin/dashboard", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const rows = db.events
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((ev) => {
      const regs = db.registrations.filter((r) => r.eventId === ev.id);
      const confirmed = regs.filter((r) => !r.waitlisted);
      const waitlist = regs.filter((r) => r.waitlisted);
      const checkedIn = confirmed.filter((r) => r.checkedIn);
      return {
        eventId: ev.id,
        nameEn: ev.nameEn,
        nameAr: ev.nameAr,
        date: ev.date,
        minCapacity: ev.minCapacity,
        maxCapacity: ev.maxCapacity,
        confirmedCount: confirmed.length,
        waitlistCount: waitlist.length,
        checkedInCount: checkedIn.length,
        attendanceRate: confirmed.length ? Math.round((checkedIn.length / confirmed.length) * 100) : null,
      };
    });
  res.json(rows);
});

// Lists everyone on an event's waiting list, in join order, so the admin can
// decide who to promote first if a confirmed spot opens up.
app.get("/api/admin/events/:eventId/waitlist", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const eventId = Number(req.params.eventId);
  const rows = db.registrations
    .filter((r) => r.eventId === eventId && r.waitlisted)
    .sort((a, b) => a.registeredAt.localeCompare(b.registeredAt))
    .map((r) => {
      const member = publicMember(db.members[r.membershipNumber]);
      return { ...r, attendeeName: r.dependentName || (member ? member.name : ""), member };
    });
  res.json(rows);
});

// Moves one waitlisted registration to confirmed. Deliberately does not
// re-check maxCapacity - if the admin is promoting someone, it's because
// they know there's room (a spot freed up, or they raised the cap), and
// this is the manual override for that judgment call.
app.post("/api/admin/registrations/:id/promote", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  const reg = db.registrations.find((r) => r.id === id);
  if (!reg) return res.status(404).json({ error: "No such registration" });
  if (!reg.waitlisted) return res.status(400).json({ error: "This registration isn't on a waiting list" });
  reg.waitlisted = false;
  writeDb(db);
  res.json(reg);
});

// -------------------------------------------------------------------------
// MEMBERS: admin roster, import/export, bulk-invite to an event
// -------------------------------------------------------------------------

// Full member roster for the admin UI - used both to browse/search who's in
// the system and to pick who to invite to an event. Never includes password
// hashes.
app.get("/api/admin/members", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const rows = Object.values(db.members)
    .map((m) => ({
      membershipNumber: m.membershipNumber,
      name: m.name,
      phone: m.phone || "",
      familyGroup: m.familyGroup || "",
      hasLoggedInAccount: !!m.passwordHash,
      dependentsCount: (m.dependents || []).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(rows);
});

// Exports the member roster as an .xlsx file. Re-importing this same file
// (see below) is a safe no-op for anyone unchanged, so this also doubles as
// a simple backup/round-trip format.
app.get("/api/admin/members/export", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const rows = Object.values(db.members).map((m) => ({
    "Membership Number": m.membershipNumber,
    Name: m.name,
    Phone: m.phone || "",
    "Family Group": m.familyGroup || "",
  }));
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Members");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="ahlawy-members.xlsx"');
  res.send(buffer);
});

// Bulk-imports members from an .xlsx file. Expected columns (case-insensitive,
// any order): "Membership Number", "Name", "Phone" (optional), "Family Group"
// (optional) - matching the export above. A row whose membership number
// already exists updates that member's name/phone/family group in place;
// their password and dependents are never touched by import. A brand-new
// membership number gets a fresh, password-less profile - that person (or
// the admin, on their behalf) turns it into a real login later by signing up
// with that same membership number, which claims the profile instead of
// overwriting it (see /api/auth/signup).
app.post(
  "/api/admin/members/import",
  requireStaffRole("admin"),
  uploadMembersFile.single("file"),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    } catch (e) {
      return res.status(400).json({ error: "Couldn't read that file - please upload a valid .xlsx file" });
    }
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return res.status(400).json({ error: "That file has no sheets" });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });

    const pick = (row, keys) => {
      for (const key of Object.keys(row)) {
        if (keys.includes(key.trim().toLowerCase())) return String(row[key]).trim();
      }
      return "";
    };

    const db = req.db;
    const created = [];
    const updated = [];
    const errors = [];
    rows.forEach((row, i) => {
      const membershipNumber = pick(row, ["membership number", "membershipnumber", "membership no", "id"]);
      const name = pick(row, ["name"]);
      const phone = pick(row, ["phone", "phone number"]);
      const familyGroup = pick(row, ["family group", "familygroup"]);
      const rowNum = i + 2; // header row + 1-indexing

      if (!membershipNumber || !name) {
        errors.push({ row: rowNum, reason: "Missing membership number or name" });
        return;
      }
      const existing = db.members[membershipNumber];
      if (existing) {
        existing.name = name;
        if (phone) existing.phone = phone;
        if (familyGroup) existing.familyGroup = familyGroup;
        updated.push({ membershipNumber, name });
      } else {
        db.members[membershipNumber] = {
          membershipNumber,
          name,
          familyGroup: familyGroup || "",
          phone: phone || "",
          passwordHash: null,
          dependents: [],
        };
        created.push({ membershipNumber, name });
      }
    });
    writeDb(db);
    res.json({ created, updated, errors, totalRows: rows.length });
  }
);

// Bulk-registers a list of already-known members directly for an event -
// skips the normal self-service registration flow entirely (no waiting-list
// prompt, no confirmation step from the member). Meant for "invite people
// we already have on file," not everyday sign-ups. Deliberately does not
// enforce maxCapacity - same reasoning as /promote above: the admin is
// making a judgment call with full visibility into the event dashboard, not
// something the system should silently block.
app.post("/api/admin/events/:eventId/invite", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const eventId = Number(req.params.eventId);
  const event = db.events.find((e) => e.id === eventId);
  if (!event) return res.status(404).json({ error: "Event not found" });
  const membershipNumbers = Array.isArray(req.body.membershipNumbers) ? req.body.membershipNumbers : [];
  if (!membershipNumbers.length) return res.status(400).json({ error: "membershipNumbers is required" });

  const invited = [];
  const skipped = [];
  const registeredAt = new Date().toISOString();
  const earlyRegistration = event.earlyDeadline ? registeredAt <= event.earlyDeadline : false;

  membershipNumbers.forEach((membershipNumber) => {
    const member = db.members[membershipNumber];
    if (!member) {
      skipped.push({ membershipNumber, reason: "No such member" });
      return;
    }
    const already = db.registrations.find(
      (r) => r.membershipNumber === membershipNumber && r.eventId === eventId && !r.dependentId
    );
    if (already) {
      skipped.push({
        membershipNumber,
        reason: already.waitlisted ? "Already on the waiting list" : "Already registered",
      });
      return;
    }
    const registration = {
      id: db.nextIds.registration++,
      membershipNumber,
      eventId,
      dependentId: null,
      dependentName: null,
      registeredAt,
      earlyRegistration,
      position: null,
      checkedIn: false,
      checkInAt: null,
      waitlisted: false,
    };
    db.registrations.push(registration);
    invited.push({ membershipNumber, name: member.name, registrationId: registration.id });
  });
  writeDb(db);

  const overCapacity =
    event.maxCapacity !== null
      ? Math.max(0, confirmedRegistrationCount(db, eventId) - event.maxCapacity)
      : 0;

  res.json({ invited, skipped, overCapacity });
});

// Full member directory for the admin UI: everything about every member in
// one place - contact details, current points balance (pooled the same way
// as everywhere else), family members/dependents, and their registration
// history (which events, confirmed or waitlisted, checked in or not, and
// points earned per event). Meant for browsing/printing the whole roster
// with real detail, as opposed to /api/admin/members which is the lighter
// list used for search + bulk-invite.
app.get("/api/admin/directory", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const rows = Object.values(db.members)
    .map((m) => {
      const snap = balanceSnapshot(db, m.membershipNumber);
      const registrations = db.registrations
        .filter((r) => r.membershipNumber === m.membershipNumber)
        .map((r) => {
          const event = db.events.find((e) => e.id === r.eventId);
          return {
            eventId: r.eventId,
            nameEn: event ? event.nameEn : "",
            nameAr: event ? event.nameAr : "",
            date: event ? event.date : "",
            dependentName: r.dependentName,
            waitlisted: !!r.waitlisted,
            checkedIn: !!r.checkedIn,
            points: registrationPoints(db, r),
          };
        })
        .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      return {
        membershipNumber: m.membershipNumber,
        name: m.name,
        phone: m.phone || "",
        familyGroup: m.familyGroup || "",
        hasLoggedInAccount: !!m.passwordHash,
        balance: snap ? snap.balance : 0,
        dependents: (m.dependents || []).map((d) => ({ id: d.id, name: d.name })),
        registrations,
        registeredCount: registrations.filter((r) => !r.waitlisted).length,
        checkedInCount: registrations.filter((r) => r.checkedIn).length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(rows);
});

// -------------------------------------------------------------------------
// SETTINGS (admin-controlled feature toggles)
// -------------------------------------------------------------------------
// Public so the frontend can decide what to render before anyone logs in
// (e.g. whether to show the Redemption Ladder tab at all).
// The dark shade is derived, never stored - one less thing for the admin
// to pick, and it always stays in sync with whatever primary color is set.
function themePayload(db) {
  return {
    primaryColor: db.settings.theme.primaryColor,
    primaryColorDark: darkenHex(db.settings.theme.primaryColor),
    accentColor: db.settings.theme.accentColor,
    logoUrl: db.settings.theme.logoUrl,
  };
}

app.get("/api/settings", (req, res) => {
  const db = readDb();
  res.json({ pointsVisibleToMembers: db.settings.pointsVisibleToMembers, theme: themePayload(db) });
});

app.put("/api/settings", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const { pointsVisibleToMembers } = req.body;
  if (typeof pointsVisibleToMembers !== "boolean") {
    return res.status(400).json({ error: "pointsVisibleToMembers must be true or false" });
  }
  db.settings.pointsVisibleToMembers = pointsVisibleToMembers;
  writeDb(db);
  res.json({ pointsVisibleToMembers: db.settings.pointsVisibleToMembers });
});

// Colors + logo, applied everywhere at once (they're just CSS custom
// properties overridden at runtime on every page - see applyThemeToUI() in
// app.js). Accepts multipart so the logo file and the two color fields can
// be saved together in one request; a request with no file just updates
// the colors and leaves whatever logo is already set alone. removeLogo="true"
// clears the logo back to the plain text header without needing a new file.
app.put("/api/settings/theme", requireStaffRole("admin"), uploadLogo.single("logo"), (req, res) => {
  const db = req.db;
  const { primaryColor, accentColor, removeLogo } = req.body;
  if (primaryColor !== undefined) {
    if (!HEX_COLOR_RE.test(primaryColor)) return res.status(400).json({ error: "Primary color must be a hex color like #8B0000" });
    db.settings.theme.primaryColor = primaryColor;
  }
  if (accentColor !== undefined) {
    if (!HEX_COLOR_RE.test(accentColor)) return res.status(400).json({ error: "Accent color must be a hex color like #C9A227" });
    db.settings.theme.accentColor = accentColor;
  }
  if (req.file) {
    db.settings.theme.logoUrl = `/uploads/branding/${req.file.filename}`;
  } else if (removeLogo === "true") {
    db.settings.theme.logoUrl = "";
  }
  writeDb(db);
  res.json(themePayload(db));
});

// Turns multer upload errors (file too big, wrong type, etc.) into a JSON
// error response instead of an HTML stack trace. Must have 4 args to be
// recognized by Express as an error-handling middleware.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: "File is too large.",
      LIMIT_FILE_COUNT: "Too many files at once.",
      LIMIT_UNEXPECTED_FILE: "Unexpected file field.",
    };
    return res.status(400).json({ error: messages[err.code] || err.message });
  }
  if (err && (/only image files/i.test(err.message || "") || /\.xlsx file/i.test(err.message || ""))) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

bootstrapAdmin();
app.listen(PORT, () => {
  console.log(`Ahlawy points system running at http://localhost:${PORT}`);
});
