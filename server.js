// MyAhlawy Online Registration & Points System
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
const helmet = require("helmet");
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  AlignmentType,
  BorderStyle,
} = require("docx");

const DB_PATH = path.join(__dirname, "data", "db.json");
// Used to sign each registration's QR code so it can't be forged or edited.
// Change this (set QR_SECRET env var) before any real event.
const QR_SECRET = process.env.QR_SECRET || "ahlawy-qr-secret-change-me";
if (!process.env.QR_SECRET) {
  // Loud, impossible-to-miss warning rather than a silent insecure default -
  // this fallback value is public (it's right here in the source), so any
  // QR code issued while it's in effect could be forged. This deliberately
  // does NOT crash the process: QR_SECRET is read on every check-in, and a
  // hard failure here would take the whole app down if this ever ran
  // somewhere the env var genuinely isn't set yet (e.g. mid-setup), which is
  // worse than a visible warning for a value that's easy to fix in place.
  console.error("!".repeat(70));
  console.error("WARNING: QR_SECRET environment variable is not set.");
  console.error("Using a public, insecure fallback value - QR codes issued while");
  console.error("this is in effect can be forged. Set QR_SECRET before real use.");
  console.error("!".repeat(70));
}
// Only used once, the very first time the app runs, to create the first
// admin account (see bootstrapAdmin below). Change these before first run
// in any real deployment, or just change the password immediately after
// logging in for the first time.
const BOOTSTRAP_ADMIN_USERNAME = process.env.ADMIN_BOOTSTRAP_USERNAME || "admin";
const BOOTSTRAP_ADMIN_PASSWORD = process.env.ADMIN_BOOTSTRAP_PASSWORD || "change-me-now";
const SESSION_COOKIE = "ahlawy_sid";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PORT = process.env.PORT || 3000;

// Slows down brute-force password guessing against the login endpoints.
// Keyed by IP (the real visitor's, not Railway's - see "trust proxy"
// below). 15 attempts per 10 minutes is generous enough that a real person
// mistyping their password a few times in a row never notices it, while
// still shutting down a scripted guessing attempt.
//
// This is a custom Map-based counter (same shape as the recovery-PIN
// lockout further down), not express-rate-limit's `skipSuccessfulRequests`
// option - that option increments its counter the instant a request
// ARRIVES and only backs it out once the response is known to have
// succeeded. Under a genuine burst of concurrent logins (many members
// signing in at once, e.g. right as gates open, or several sharing one
// venue WiFi's public IP), a pile of legitimate, still-in-flight requests
// can exceed `max` before any of them have had a chance to succeed and
// decrement - confirmed directly under load-test conditions, where 300
// concurrent logins from one IP tripped 429s almost immediately and
// blocked real logins, not attackers. Counting explicitly, only on a
// confirmed wrong-password/PIN response, makes that impossible regardless
// of how many correct logins are in flight at once.
const loginFailuresByIp = new Map();
const LOGIN_LOCKOUT_MAX_ATTEMPTS = 15;
const LOGIN_LOCKOUT_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCKOUT_MESSAGE = { error: "Too many login attempts. Please wait a few minutes and try again." };
function checkLoginLockout(ip) {
  const rec = loginFailuresByIp.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > LOGIN_LOCKOUT_WINDOW_MS) {
    loginFailuresByIp.delete(ip);
    return false;
  }
  return rec.count >= LOGIN_LOCKOUT_MAX_ATTEMPTS;
}
function recordLoginFailure(ip) {
  const rec = loginFailuresByIp.get(ip);
  if (!rec || Date.now() - rec.first > LOGIN_LOCKOUT_WINDOW_MS) {
    loginFailuresByIp.set(ip, { count: 1, first: Date.now() });
  } else {
    rec.count++;
  }
}
// Called as the first line of each guarded endpoint below (login,
// staff-login, forgot-password, staff-forgot-password) rather than wired
// in as Express middleware, since it needs no request-body parsing and
// this keeps the 429 response identical to what express-rate-limit sent
// before. Returns true (having already sent the 429) if this IP is
// currently locked out.
function loginRateLimitCheck(req, res) {
  if (checkLoginLockout(req.ip)) {
    res.status(429).json(LOGIN_LOCKOUT_MESSAGE);
    return true;
  }
  return false;
}

const app = express();
// Railway (and most hosts) put the app behind a reverse proxy that
// terminates HTTPS and forwards plain HTTP internally, setting
// X-Forwarded-* headers. Trusting the first proxy hop makes req.ip reflect
// the real visitor (not the proxy) - needed for the login rate limiter
// below to actually apply per-visitor - and makes req.secure correctly
// report "true" for a visitor on HTTPS, which is what the session cookie's
// secure flag relies on. Safe here because there is exactly one proxy
// layer in front of this app (Railway's), never more.
app.set("trust proxy", 1);
// Sets standard security-related response headers (clickjacking, MIME-
// sniffing, etc.). The default Content-Security-Policy is replaced with one
// that still fits this app: inline style="..." attributes are used
// throughout the existing HTML/JS (style-src unsafe-inline), and QR codes
// render as data: URI images (img-src data:) - the stock strict defaults
// would silently break both. fonts.googleapis.com/fonts.gstatic.com are
// allowed narrowly (nothing else third-party) for the hero banner's
// display typeface - the CSS file itself comes from googleapis, the actual
// font file it points to from gstatic.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
      },
    },
  })
);
app.use(express.json());
app.use(cookieParser());

// -------------------------------------------------------------- CSRF -----
// Double-submit-cookie CSRF protection, layered on top of (not instead of)
// the session cookie's existing sameSite:"lax" mitigation. Every response
// makes sure a random, non-httpOnly "csrfToken" cookie is set - readable by
// this site's own JS (unlike the httpOnly session cookie), but NOT readable
// by a different-origin page's JS. Every state-changing request must echo
// that same value back in an X-CSRF-Token header (see api() in app.js). A
// malicious cross-site page can make the browser send the session cookie
// automatically, but it cannot read the csrfToken cookie to also set the
// matching header, so a forged cross-site POST/PUT/DELETE fails this check
// even though the session cookie rode along. No native <form> submissions
// exist anywhere in this app (confirmed by grep) - every mutation already
// goes through fetch, so there is nothing else that needs to carry this
// header.
const CSRF_COOKIE = "csrfToken";
const CSRF_HEADER = "x-csrf-token";
const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
app.use((req, res, next) => {
  let token = req.cookies[CSRF_COOKIE];
  if (!token) {
    token = crypto.randomBytes(24).toString("hex");
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false,
      sameSite: "lax",
      secure: req.secure,
      maxAge: SESSION_TTL_MS,
    });
  }
  req.csrfToken = token;
  next();
});
app.use((req, res, next) => {
  if (CSRF_SAFE_METHODS.has(req.method)) return next();
  const headerToken = req.get(CSRF_HEADER);
  if (!headerToken || headerToken !== req.csrfToken) {
    return res.status(403).json({ error: "Your session could not be verified. Please refresh the page and try again." });
  }
  next();
});

// no-store (not just no-cache) so a redeployed app.js/index.html/etc. is
// never served stale from the browser's disk cache after an update -
// Express's default static headers (ETag only, no explicit Cache-Control)
// leave browsers free to use heuristic caching, which has caused "I
// updated the app but my browser is still running the old version"
// confusion after past updates. no-cache alone still permits the browser
// to reuse a cached copy after revalidating with the server (normally via
// a conditional If-None-Match/ETag request) - fine in theory, but a stray
// proxy, an aggressive mobile browser, or a revalidation request that
// never actually reaches this server can all still serve the old file
// under "no-cache". no-store forbids caching the response at all, so
// there's nothing left to revalidate or serve stale.
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
  })
);
// Uploaded photos (event covers/recaps/gallery, branding logo) live on the
// persistent data/ volume, not under public/ - see the comment above
// EVENT_UPLOADS_DIR below for why. This mount keeps their public URLs at
// the same "/uploads/..." prefix clients already have stored, just backed
// by data/uploads/ instead of public/uploads/.
app.use(
  "/uploads",
  express.static(path.join(__dirname, "data", "uploads"), {
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  })
);

// ------------------------------------------------------ event photo uploads --
// Event cover photos, after-event recap photos, and gallery photos are
// stored as plain files on disk (not base64 in db.json, to keep the JSON
// store small).
//
// IMPORTANT: these live under data/uploads/, NOT public/uploads/, and are
// served via the dedicated /uploads static route below instead of the
// public/ static mount. That's deliberate: data/ is the directory Railway's
// persistent volume is mounted at (same place db.json and its backups live
// - see DB_PATH/DB_BACKUP_DIR above/below), which survives redeploys.
// public/ is rebuilt from git on every deploy and does NOT survive - files
// written there (as this used to do) get silently wiped the next time the
// app redeploys, leaving old photo URLs 404ing. The URL path handed out to
// clients is still "/uploads/events/..." / "/uploads/branding/..." (see the
// static mount below), so nothing elsewhere in the app or in already-stored
// URLs needed to change - only where the bytes physically live.
const EVENT_UPLOADS_DIR = path.join(__dirname, "data", "uploads", "events");
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

// ---------------------------------------------------- hero banner video ---
// The hero banner can optionally have a background video alongside its
// existing photo - two different file fields ("photo" and "video") in one
// multipart form, so this needs its own multer instance whose fileFilter
// branches on which field a given file arrived in; uploadEventPhoto above
// can't be reused since it only ever expects a single image field. Lives
// under data/uploads/ (the persistent-volume directory - see the comment
// above EVENT_UPLOADS_DIR) via its own "hero" subfolder, same reasoning.
const HERO_VIDEO_UPLOADS_DIR = path.join(__dirname, "data", "uploads", "hero");
fs.mkdirSync(HERO_VIDEO_UPLOADS_DIR, { recursive: true });
const heroMediaStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, file.fieldname === "video" ? HERO_VIDEO_UPLOADS_DIR : EVENT_UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (file.fieldname === "video") {
      const safeExt = [".mp4", ".webm", ".mov"].includes(ext) ? ext : ".mp4";
      return cb(null, `hero-video-${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt}`);
    }
    const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt}`);
  },
});
const uploadHeroMedia = multer({
  storage: heroMediaStorage,
  // 60MB covers a short, reasonably-compressed hero clip without letting a
  // single upload eat a large slice of the 500MB persistent volume - the
  // handler below also deletes the previous video file whenever it's
  // replaced or removed, so re-uploads don't pile up as orphaned files the
  // way small photo replacements elsewhere in this app harmlessly do.
  limits: { fileSize: 60 * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "video") {
      if (!/^video\//.test(file.mimetype)) return cb(new Error("Only video files (MP4, WebM, or MOV) are allowed"));
      return cb(null, true);
    }
    if (!/^image\//.test(file.mimetype)) return cb(new Error("Only image files are allowed"));
    cb(null, true);
  },
});

// -------------------------------------------------- event cover/recap video --
// Same idea as the hero banner's video above: an event's cover (shown while
// it's upcoming) and its after-event recap can each optionally carry a short
// video alongside their existing photo(s). These reuse EVENT_UPLOADS_DIR
// rather than a separate folder - cover/recap photos already share that one
// persistent-volume directory, and the video files here are just
// differently-prefixed random filenames living alongside them.
const eventMediaStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, EVENT_UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (file.fieldname === "coverVideo" || file.fieldname === "recapVideo") {
      const safeExt = [".mp4", ".webm", ".mov"].includes(ext) ? ext : ".mp4";
      return cb(null, `event-video-${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt}`);
    }
    const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt}`);
  },
});
const eventMediaFileFilter = (req, file, cb) => {
  if (file.fieldname === "coverVideo" || file.fieldname === "recapVideo") {
    if (!/^video\//.test(file.mimetype)) return cb(new Error("Only video files (MP4, WebM, or MOV) are allowed"));
    return cb(null, true);
  }
  if (!/^image\//.test(file.mimetype)) return cb(new Error("Only image files are allowed"));
  cb(null, true);
};
// Cover: one photo + one video per request. Recap: up to 10 photos + one
// video. Same 60MB/file ceiling as the hero video, for the same reason (see
// uploadHeroMedia above) - the handlers below also delete the previous video
// on disk whenever a new one replaces it, so re-uploads don't pile up.
const uploadEventCoverMedia = multer({
  storage: eventMediaStorage,
  limits: { fileSize: 60 * 1024 * 1024, files: 2 },
  fileFilter: eventMediaFileFilter,
});
const uploadEventRecapMedia = multer({
  storage: eventMediaStorage,
  limits: { fileSize: 60 * 1024 * 1024, files: 11 },
  fileFilter: eventMediaFileFilter,
});

// ------------------------------------------------------------- branding ---
// Admin-set logo, stored on disk the same way event photos are - see the
// data/ vs public/ note above the event-uploads block.
const BRANDING_UPLOADS_DIR = path.join(__dirname, "data", "uploads", "branding");
fs.mkdirSync(BRANDING_UPLOADS_DIR, { recursive: true });
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// ---------------------------------------------------------- landing page ---
// Every section the Events landing page can show, all reorderable and
// toggleable the same way (see PUT /api/admin/landing/sections below). This
// used to force "events" permanently on - members still have the Register
// tab's own card grid (see startRegisterFlow()/renderRegisterEventsGrid()
// in app.js) as an always-available way to sign up even with this section
// hidden from the landing page, so there's no dead end if an admin does.
const LANDING_SECTION_KEYS = ["hero", "events", "annual", "about", "news", "community", "spotlight", "gallery", "sponsors"];

const brandingLogoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, BRANDING_UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    // Deliberately no .svg here: an SVG can carry an embedded <script>/event
    // handler, and this file is served back same-origin at /uploads/... - a
    // raster-only allowlist means there's nothing in the file format itself
    // that could execute, on top of (not instead of) the CSP already in
    // place. Anything not on this list is coerced to .png rather than
    // rejected outright, matching the pre-existing image/* mimetype check
    // below (a non-image with a spoofed image/* Content-Type still can't
    // end up with a script-capable extension).
    const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) ? ext : ".png";
    cb(null, `logo-${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt}`);
  },
});
const uploadLogo = multer({
  storage: brandingLogoStorage,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB is plenty for a logo
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype) || file.mimetype === "image/svg+xml") {
      return cb(new Error("Only JPG, PNG, WEBP, or GIF image files are allowed"));
    }
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
    sessions: {},
  };
  fs.writeFileSync(DB_PATH, JSON.stringify(starterDb, null, 2));
  console.log(`No data file found at ${DB_PATH} - created a fresh starter database.`);
}
ensureDbFile();

// Default Terms & Conditions text (bilingual) - see the termsAndConditions
// block inside readDb() below. Editable afterward by an admin from
// Settings -> Terms & Conditions (PUT /api/admin/terms); this is only the
// starting text for a deploy that has never touched it. Drafted to cover
// the two things the committee asked for: the member is responsible for
// the accuracy of their own data, and agrees it may be shared with the
// committee (the platform's admins/staff) for running the club's
// activities - not a substitute for the committee's own legal review.
const DEFAULT_TERMS_AR = `الشروط والأحكام - منصة ماي أهلاوي

مرحبًا بك في منصة "ماي أهلاوي"، المنصة الإلكترونية للتسجيل في فعاليات لجنة الرياضة الترفيهية بالنادي الأهلي - التجمع الخامس. باستخدامك لهذه المنصة أو إنشائك لحساب عضوية عليها، فإنك توافق على الشروط والأحكام التالية:

1. دقة البيانات ومسؤولية العضو
يلتزم العضو بإدخال بيانات صحيحة ودقيقة ومحدّثة عند التسجيل (رقم العضوية، الاسم، رقم الهاتف، البريد الإلكتروني، وأي بيانات أخرى يُطلب إدخالها)، ويتحمل وحده كامل المسؤولية عن أي معلومات غير صحيحة أو غير مكتملة أو قديمة يقوم بإدخالها أو الإبقاء عليها، بما في ذلك أي أثر يترتب على ذلك في التسجيل بالفعاليات أو احتساب النقاط أو التواصل معه.

2. مشاركة البيانات مع اللجنة
يوافق العضو على أن بيانات حسابه (بياناته الشخصية، سجل تسجيله وحضوره في الفعاليات، رصيد ومسيرة نقاطه، وأي بيانات أخرى ذات صلة) قد تُعرض وتُشارَك مع أعضاء لجنة الرياضة الترفيهية (الإداريين والمشرفين المخوَّلين على المنصة) وذلك حصرًا للأغراض الإدارية والتنظيمية المرتبطة بتشغيل الفعاليات والبطولات وإدارة نظام النقاط والتواصل مع الأعضاء، ولن تُستخدم بياناته لأي غرض تجاري أو تُشارَك مع أي جهة خارج نطاق عمل اللجنة.

3. حماية بيانات الدخول
يلتزم العضو بالحفاظ على سرية كلمة المرور الخاصة بحسابه وعدم مشاركتها مع أي شخص آخر، ويتحمل مسؤولية أي نشاط يتم من خلال حسابه.

4. استخدام المنصة
يلتزم العضو باستخدام المنصة للأغراض المخصصة لها فقط، وعدم إدخال بيانات لأشخاص آخرين دون علمهم أو موافقتهم (باستثناء أفراد الأسرة الذين يقوم بتسجيلهم كتابعين على حسابه الخاص).

5. تحديث الشروط والأحكام
يجوز للجنة تحديث هذه الشروط والأحكام من وقت لآخر بما يتناسب مع تطوّر المنصة وخدماتها. عند إجراء أي تحديث جوهري، سيُطلب من جميع الأعضاء - الحاليين والجدد - مراجعة النص المُحدَّث والموافقة عليه مجددًا قبل متابعة استخدام المنصة.

6. الإقرار بالموافقة
بإنشاء حساب على المنصة، أو بالضغط على "أوافق" عند ظهور نص مُحدَّث، يُقر العضو بأنه قرأ هذه الشروط والأحكام وفهمها ووافق عليها بالكامل.`;

const DEFAULT_TERMS_EN = `Terms & Conditions - MyAhlawy Platform

Welcome to MyAhlawy, the online registration platform for the Sports Entertainment Committee at Al Ahly Club - Fifth Settlement. By using this platform or creating a membership account on it, you agree to the following terms:

1. Data accuracy and member responsibility
The member is responsible for entering accurate, correct, and up-to-date information when registering (membership number, name, phone number, email, and any other requested details), and bears sole responsibility for any incorrect, incomplete, or outdated information they enter or leave on file, including any effect this has on event registration, points calculation, or being contacted.

2. Sharing data with the committee
The member agrees that their account data (personal details, event registration and attendance history, points balance and history, and any other related data) may be viewed and shared with members of the Sports Entertainment Committee (the platform's authorized admins and staff), strictly for administrative purposes related to running events and tournaments, managing the points system, and communicating with members. This data will not be used for any commercial purpose or shared with any party outside the committee's work.

3. Protecting login details
The member must keep their account password confidential and must not share it with anyone else, and is responsible for any activity carried out through their account.

4. Using the platform
The member agrees to use the platform only for its intended purposes, and not to enter data for other people without their knowledge or consent (except for family members they register as dependents on their own account).

5. Updating these terms
The committee may update these Terms & Conditions from time to time as the platform and its services evolve. Following any material update, every member - existing and new - will be asked to review and re-accept the updated text before continuing to use the platform.

6. Acknowledgment of agreement
By creating an account on the platform, or by clicking "I Agree" when an updated version is shown, the member acknowledges that they have read, understood, and fully agree to these Terms & Conditions.`;

function readDb() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  db.staffAccounts = db.staffAccounts || {};
  // Backward-compatible defaults for events created before photos/descriptions/
  // recap existed, so older data never crashes the newer frontend.
  db.events = (db.events || []).map((ev) => ({
    descriptionEn: "",
    descriptionAr: "",
    coverPhoto: "",
    coverVideo: "",
    minCapacity: null,
    maxCapacity: null,
    startTime: null,
    endTime: null,
    endDate: null,
    // Sub-activities: an event day (e.g. "Sports Entertainment Day - New
    // Cairo") can have any number of activities nested under it
    // (parentEventId points at the parent). allowMultipleActivities is set
    // on the PARENT and controls whether one person can register for more
    // than one of its sibling activities.
    parentEventId: null,
    allowMultipleActivities: false,
    ...ev,
    recap: { descriptionEn: "", descriptionAr: "", photos: [], video: "", ...(ev.recap || {}) },
  }));
  // Backward-compatible default for registrations created before the
  // waiting-list feature existed - they were all "confirmed" spots.
  db.registrations = (db.registrations || []).map((r) => ({ waitlisted: false, ...r }));
  // Backward-compatible defaults for members created before family members
  // (dependents) existed.
  for (const key of Object.keys(db.members || {})) {
    if (!Array.isArray(db.members[key].dependents)) db.members[key].dependents = [];
    // Backward-compatible default for dependents created before the
    // "identify the family member" relationship label existed.
    for (const dep of db.members[key].dependents) {
      if (typeof dep.relationship !== "string") dep.relationship = "";
      // Backward-compatible defaults for dependents created before their own
      // optional phone/email existed - a plain contact record (shown to
      // staff/admin, e.g. on the Member Directory) rather than a login of
      // their own; there's no notification system in this app yet (for
      // members OR dependents) that sends to either, so for now these are
      // just stored for reference.
      if (typeof dep.phone !== "string") dep.phone = "";
      if (typeof dep.email !== "string") dep.email = "";
    }
    // Terms & Conditions acceptance: a member who signed up before this
    // feature existed has never accepted anything, so they default to
    // version 0 - always behind the real db.termsAndConditions.version
    // (which starts at 1), so the login gate below correctly asks them to
    // review and accept once, the same as any existing member would after
    // the committee updates the text.
    if (typeof db.members[key].termsAcceptedVersion !== "number") db.members[key].termsAcceptedVersion = 0;
    // Nickname: optional, unique-across-the-platform display name a member
    // can set for themselves (see POST/DELETE /api/me/nickname below) -
    // shown instead of their real name on public-facing surfaces only
    // (community leaderboard, public tournament pages/big-screen/live-
    // matches); admin-facing views always show the real name. Defaults to
    // unset for every member created before this feature existed.
    if (typeof db.members[key].nickname !== "string") db.members[key].nickname = "";
    // Club ID: the number printed on the physical membership card, which the
    // club issues ONE OF PER FAMILY (not per person) - so it's distinct from
    // membershipNumber, which is this app's unique per-ACCOUNT key. Defaults
    // to the member's own membershipNumber for every account created before
    // this existed, which is exactly correct: they were (and remain) the
    // only account under that card number, so nothing changes for them. See
    // POST /api/auth/signup below for how a second family member gets their
    // own account under the same clubId, and poolingKey() for how accounts
    // sharing a clubId automatically pool points with no extra setup.
    if (typeof db.members[key].clubId !== "string" || !db.members[key].clubId.trim()) {
      db.members[key].clubId = key;
    }
  }
  db.nextIds = db.nextIds || {};
  db.nextIds.dependent = db.nextIds.dependent || 1;
  db.nextIds.chatMessage = db.nextIds.chatMessage || 1;
  db.chatMessages = db.chatMessages || [];
  db.nextIds.newsPost = db.nextIds.newsPost || 1;
  db.newsPosts = db.newsPosts || [];
  db.nextIds.spotlight = db.nextIds.spotlight || 1;
  db.spotlights = db.spotlights || [];
  // Tournaments: at most one per event, generates a group stage and/or
  // knockout bracket from that event's confirmed registrations (or from
  // teams the admin groups them into). See the "TOURNAMENTS" section below
  // for the full data model and bracket-math helpers.
  db.nextIds.tournament = db.nextIds.tournament || 1;
  db.tournaments = db.tournaments || [];
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
  // Landing page customization: an editable hero banner, an optional About
  // block, a sponsors/partners strip, a photo gallery, and the order/
  // visibility of every section on the Events landing page. Defaults here
  // reproduce the page exactly as it looked before this existed (hero,
  // events, news, community, spotlight all on; about/gallery/sponsors off
  // until the admin fills them in and switches them on), so a deploy that's
  // never touched this setting looks identical to before.
  db.landingPage = db.landingPage || {};
  db.landingPage.hero = db.landingPage.hero || {};
  if (typeof db.landingPage.hero.headlineEn !== "string") db.landingPage.hero.headlineEn = "Welcome to MyAhlawy";
  if (typeof db.landingPage.hero.headlineAr !== "string") db.landingPage.hero.headlineAr = "أهلاً بكم في ماي أهلاوي";
  if (typeof db.landingPage.hero.taglineEn !== "string") {
    db.landingPage.hero.taglineEn = "Register for club sports activities, earn points, and stay connected with the community.";
  }
  if (typeof db.landingPage.hero.taglineAr !== "string") {
    db.landingPage.hero.taglineAr = "سجّل في الأنشطة الرياضية بالنادي، اجمع النقاط، وابقَ على تواصل مع المجتمع.";
  }
  // Optional full-bleed background photo behind the hero banner text - off
  // (empty string) by default, same "self-healing" pattern as every other
  // optional landing-page photo field, so an existing deploy that's never
  // set one just keeps showing the plain color gradient it already had.
  if (typeof db.landingPage.hero.photo !== "string") db.landingPage.hero.photo = "";
  // Optional background video, same on/off-by-empty-string pattern as the
  // photo above. When both are set, the video takes priority and the photo
  // is used as its <video poster> (shown while the video loads, and as the
  // fallback for a browser that can't play it) - see applyHeroMedia() in
  // app.js and the public landing-page rendering there.
  if (typeof db.landingPage.hero.video !== "string") db.landingPage.hero.video = "";
  db.landingPage.about = db.landingPage.about || {};
  if (typeof db.landingPage.about.titleEn !== "string") db.landingPage.about.titleEn = "About us";
  if (typeof db.landingPage.about.titleAr !== "string") db.landingPage.about.titleAr = "من نحن";
  if (typeof db.landingPage.about.bodyEn !== "string") db.landingPage.about.bodyEn = "";
  if (typeof db.landingPage.about.bodyAr !== "string") db.landingPage.about.bodyAr = "";
  if (typeof db.landingPage.about.photo !== "string") db.landingPage.about.photo = "";
  db.landingPage.gallery = db.landingPage.gallery || [];
  db.landingPage.sponsors = db.landingPage.sponsors || [];
  db.nextIds.galleryPhoto = db.nextIds.galleryPhoto || 1;
  db.nextIds.sponsor = db.nextIds.sponsor || 1;
  // Section order/visibility - stored as an array, so array order IS render
  // order. Repairs itself if a key is missing (new deploy picking up a
  // section that didn't exist yet) or unknown (stale data) rather than
  // trusting old data blindly.
  const defaultLandingSections = [
    { key: "hero", enabled: true },
    { key: "events", enabled: true },
    // A preview (most recent few) of the same past-events data the Annual
    // Activities tab shows in full - see /api/events and isPastEvent() -
    // not admin-curated content, so it's on by default like news/community/
    // spotlight rather than off like about/gallery/sponsors.
    { key: "annual", enabled: true },
    { key: "about", enabled: false },
    { key: "news", enabled: true },
    { key: "community", enabled: true },
    { key: "spotlight", enabled: true },
    { key: "gallery", enabled: false },
    { key: "sponsors", enabled: false },
  ];
  if (!Array.isArray(db.landingPage.sections)) {
    db.landingPage.sections = defaultLandingSections;
  } else {
    const known = db.landingPage.sections.filter((s) => s && LANDING_SECTION_KEYS.includes(s.key));
    const seenKeys = new Set(known.map((s) => s.key));
    for (const def of defaultLandingSections) {
      if (!seenKeys.has(def.key)) known.push(def);
    }
    db.landingPage.sections = known.map((s) => ({ key: s.key, enabled: !!s.enabled }));
  }
  db.sessions = db.sessions || {};
  // Terms & Conditions: bilingual text every member must accept - once at
  // sign-up, and again whenever the committee edits it (see PUT
  // /api/admin/terms, which bumps `version`). A member's own
  // termsAcceptedVersion (see above) is compared against this version to
  // decide whether the app should show them a blocking re-accept gate.
  // Starts at version 1 with sensible default text covering data accuracy
  // and sharing with the committee, so a deploy that's never touched this
  // still has real, effective terms rather than a blank version 0.
  db.termsAndConditions = db.termsAndConditions || {};
  if (typeof db.termsAndConditions.version !== "number") db.termsAndConditions.version = 1;
  if (typeof db.termsAndConditions.textEn !== "string") {
    db.termsAndConditions.textEn = DEFAULT_TERMS_EN;
  }
  if (typeof db.termsAndConditions.textAr !== "string") {
    db.termsAndConditions.textAr = DEFAULT_TERMS_AR;
  }
  if (typeof db.termsAndConditions.updatedAt !== "string") {
    db.termsAndConditions.updatedAt = new Date().toISOString();
  }
  db.activityLog = db.activityLog || [];
  return db;
}
// Platform-wide activity log, admin-only report (see GET /api/admin/activity-log
// below) - every entry is {id, at, actorType, actorId, actorName, action, details}.
// actorType is "member" | "staff"; actorId is the membership number or staff
// username; actorName is a display name captured at log time (so the report
// still reads sensibly even if that member/staff account is later renamed or
// removed). action is a short machine-readable tag (e.g. "member_login",
// "event_created"); details is a short human-readable string with the
// specifics (event name, redemption tier, etc.) - kept intentionally light
// (no full before/after diffs) since this is an activity feed, not a formal
// audit trail. Capped to the most recent ACTIVITY_LOG_MAX entries so
// db.json can't grow unbounded on a long-lived deploy - oldest entries drop
// off silently, same tradeoff already accepted for the rolling db.json
// backups above. Call sites pass the already-open `db` object and do NOT
// call writeDb() themselves - logActivity() only mutates db.activityLog in
// memory, so every call site's own writeDb() (already happening right after
// the action it's logging) persists the new entry as part of that same
// write, with no extra disk I/O per log line.
const ACTIVITY_LOG_MAX = 5000;
function logActivity(db, { actorType, actorId, actorName, action, details }) {
  try {
    db.activityLog.push({
      id: db.activityLog.length ? db.activityLog[db.activityLog.length - 1].id + 1 : 1,
      at: new Date().toISOString(),
      actorType,
      actorId: actorId || "",
      actorName: actorName || "",
      action,
      details: details || "",
    });
    if (db.activityLog.length > ACTIVITY_LOG_MAX) {
      db.activityLog.splice(0, db.activityLog.length - ACTIVITY_LOG_MAX);
    }
  } catch (e) {
    // Never let logging itself break the real action it's attached to.
    console.error("logActivity failed:", e.message);
  }
}
// Where rolling safety-net snapshots of db.json are kept - see backupDbFile()
// below. Same volume as db.json itself (data/), so it survives redeploys.
const DB_BACKUP_DIR = path.join(__dirname, "data", "backups");
// Snapshots are spaced out by time rather than taken on every single write,
// so the kept history actually spans real hours rather than being 40
// near-identical copies from one busy five-minute stretch of check-ins.
const DB_BACKUP_MIN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DB_BACKUP_KEEP = 48; // ~24 hours of rolling history at that spacing
let lastDbBackupAt = 0;

// Copies the CURRENT on-disk db.json into data/backups/ before it gets
// overwritten, throttled to once per DB_BACKUP_MIN_INTERVAL_MS. This is a
// separate safety net from the atomic write below: the atomic write only
// protects against a truncated/corrupt file from a crash mid-write, not
// against a write that completes fine but contains wrong data (a bug, a
// mistaken admin action) - a rolling backup lets that be rolled back to a
// recent known-good snapshot instead. Best-effort: a failure here is logged
// but never blocks the real write, since the backup is a nice-to-have, not
// the source of truth.
function backupDbFile() {
  try {
    if (!fs.existsSync(DB_PATH)) return; // nothing on disk yet to snapshot
    const now = Date.now();
    if (now - lastDbBackupAt < DB_BACKUP_MIN_INTERVAL_MS) return;
    fs.mkdirSync(DB_BACKUP_DIR, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(DB_PATH, path.join(DB_BACKUP_DIR, `db-${stamp}.json`));
    lastDbBackupAt = now;
    const files = fs
      .readdirSync(DB_BACKUP_DIR)
      .filter((f) => f.startsWith("db-") && f.endsWith(".json"))
      .sort(); // ISO timestamps in the filename sort chronologically
    for (let i = 0; i < files.length - DB_BACKUP_KEEP; i++) {
      fs.unlinkSync(path.join(DB_BACKUP_DIR, files[i]));
    }
  } catch (err) {
    console.error("Failed to back up data/db.json before write:", err.message);
  }
}

// Writes db.json atomically: write the new content to a temp file in the
// same directory, then rename it over the real file. A rename on the same
// filesystem is atomic, so a process kill/crash/OOM mid-write (a redeploy,
// a Railway resource limit, anything) can never leave db.json truncated or
// invalid - the file on disk is always either the old complete version or
// the new complete version, never a half-written one. Previously this was
// a plain writeFileSync straight to db.json, which had no such guarantee.
function writeDb(db) {
  const json = JSON.stringify(db, null, 2);
  backupDbFile();
  const tmpPath = `${DB_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, json);
  fs.renameSync(tmpPath, DB_PATH);
}
// Never send a password hash back to a client.
function publicMember(m) {
  if (!m) return m;
  const { passwordHash, recoveryPinHash, ...rest } = m;
  return { ...rest, hasRecoveryPin: !!recoveryPinHash };
}
function publicStaff(s) {
  if (!s) return s;
  const { passwordHash, recoveryPinHash, ...rest } = s;
  return { ...rest, hasRecoveryPin: !!recoveryPinHash };
}

// ------------------------------------------------------------- sessions ---
// Kept in memory for fast per-request lookups, and mirrored into db.json
// (db.sessions) so a server restart - which happens on every deploy - does
// not silently sign everyone out mid-task. Loaded back into memory once at
// startup (below); persisted again on every login/logout (rare events, so a
// full db read+write each time is cheap). Expired sessions are pruned from
// memory on the next request that touches them, same as before; a stale
// expired entry left behind in db.json is harmless since the startup loader
// filters by expiresAt.
const sessions = new Map(); // token -> { type: 'member'|'staff', id, role, expiresAt }

function persistSessions() {
  try {
    const db = readDb();
    db.sessions = {};
    for (const [token, session] of sessions.entries()) {
      db.sessions[token] = session;
    }
    writeDb(db);
  } catch (e) {
    console.error("Failed to persist sessions:", e);
  }
}
(function loadPersistedSessions() {
  try {
    const db = readDb();
    const now = Date.now();
    let restored = 0;
    for (const [token, session] of Object.entries(db.sessions || {})) {
      if (session && session.expiresAt > now) {
        sessions.set(token, session);
        restored++;
      }
    }
    if (restored) console.log(`Restored ${restored} session(s) from the last run.`);
  } catch (e) {
    console.error("Failed to load persisted sessions:", e);
  }
})();

function createSession(type, id, role) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { type, id, role, expiresAt: Date.now() + SESSION_TTL_MS });
  persistSessions();
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
// secure: req.secure (rather than a hardcoded true) means the cookie is
// HTTPS-only on the real deployment - where every request is HTTPS and
// req.secure is correctly reported via the trusted proxy's
// X-Forwarded-Proto header - while still working over plain http://
// during local development, where req.secure is false and a hardcoded
// `secure: true` would silently stop the browser from ever sending the
// cookie back, breaking login.
function setSessionCookie(req, res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
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
// Attaches req.staff (the logged-in staff/admin record). Two call shapes:
//   requireStaffRole("admin") - only role='admin' passes (unchanged from before).
//   requireStaffRole("staff") - any staff-type session passes, whatever its
//     role (unchanged from before - this was always "any staff account",
//     not literally role==='staff', which is how the original two-role
//     "staff OR admin" behavior worked without ever checking session.role).
//   requireStaffRole([...roles]) - a granular role (e.g. "tournament") named
//     in the array passes; 'admin' always passes every gate regardless of
//     what's listed, since admin can do everything every other role can.
// This lets a narrower role (tournament-only management, say) be opted into
// per-endpoint without touching the two original roles' behavior at all.
function requireStaffRole(role) {
  const allowList = Array.isArray(role) ? role : null;
  return (req, res, next) => {
    const session = getSession(req);
    if (!session || session.type !== "staff") return res.status(401).json({ error: "Please sign in" });
    if (session.role !== "admin") {
      if (allowList) {
        if (!allowList.includes(session.role)) return res.status(403).json({ error: "Admin access required" });
      } else if (role === "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
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
  // If no real password was configured via ADMIN_BOOTSTRAP_PASSWORD, don't
  // fall back to the well-known "change-me-now" default (a public string
  // sitting right in this source file, guessable by anyone) - generate a
  // random one-time password instead and print it once. An operator-
  // provided password (env var set) is never printed at all, so a real
  // secret never ends up sitting in log history.
  const usingGeneratedPassword = !process.env.ADMIN_BOOTSTRAP_PASSWORD;
  const password = usingGeneratedPassword ? crypto.randomBytes(12).toString("base64url") : BOOTSTRAP_ADMIN_PASSWORD;
  db.staffAccounts[BOOTSTRAP_ADMIN_USERNAME] = {
    username: BOOTSTRAP_ADMIN_USERNAME,
    name: "Committee Admin",
    role: "admin",
    passwordHash: bcrypt.hashSync(password, 10),
  };
  writeDb(db);
  console.log("No staff accounts existed yet - created a first admin account:");
  console.log(`  username: ${BOOTSTRAP_ADMIN_USERNAME}`);
  if (usingGeneratedPassword) {
    console.log("  ADMIN_BOOTSTRAP_PASSWORD was not set, so a random one-time password was generated:");
    console.log(`  password: ${password}`);
    console.log("  Copy this now - it will not be shown again.");
  } else {
    console.log("  password: (set via ADMIN_BOOTSTRAP_PASSWORD env var - not shown in logs)");
  }
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

// A member's own chosen nickname (see POST /api/me/nickname), falling back
// to their real name when they haven't set one. Only ever used on
// public-facing surfaces (community leaderboard, public tournament pages,
// the big-screen display, the live matches board) - admin/staff-facing code
// always reads member.name directly instead, so staff can always identify
// who someone actually is.
function publicDisplayName(db, membershipNumber) {
  const m = db.members[membershipNumber];
  if (!m) return "Member";
  return (m.nickname && m.nickname.trim()) || m.name;
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

// Pooling key: an explicit familyGroup (set by a member linking accounts
// themselves, or by admin - see linkFamilyGroups() below) always wins, since
// that's a deliberate choice to merge two otherwise-unrelated club IDs. Short
// of that, accounts pool automatically by clubId - the club issues one
// membership card per FAMILY, not per person, so every account created under
// that same card number (see POST /api/auth/signup) shares one points pool
// with zero extra setup. A member with no other account on their clubId
// simply pools with themselves, which is exactly today's behavior - this is
// what lets both pooling schemes activate with zero migration for existing
// single-account members (their clubId defaults to their own
// membershipNumber - see readDb() above).
function poolingKey(db, membershipNumber) {
  const m = db.members[membershipNumber];
  if (!m) return membershipNumber;
  if (m.familyGroup && m.familyGroup.trim()) return `FAM:${m.familyGroup.trim()}`;
  return `CLUB:${(m.clubId && m.clubId.trim()) || membershipNumber}`;
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
  const poolMembers = membersInPool(db, key);
  return {
    membershipNumber,
    member: publicMember(member),
    poolingKey: key,
    // Pooled with someone else - whether via an explicit family-group link
    // or automatically via a shared clubId - rather than pooling alone.
    familyPooled: poolMembers.length > 1,
    poolMembers: poolMembers.map((m) => ({ membershipNumber: m.membershipNumber, name: m.name })),
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
//
// IMPORTANT - lost-update race: readDb()/writeDb() are synchronous
// (whole-file JSON read/replace, no per-record locking), so a handler is
// only safe from concurrent writes for the code that runs between its
// readDb() and writeDb() with NO `await` in between - Node's single
// threaded event loop can never interleave two requests' synchronous code,
// but an `await` (e.g. bcrypt, which is deliberately async so hashing
// doesn't block the event loop) hands control back to the loop, and a
// second concurrent request can run its own full read-modify-write cycle
// in that window. Whichever writeDb() lands last wins, silently discarding
// the other request's change. This was confirmed empirically under load
// (concurrent signups losing ~90% of new accounts) and is fixed throughout
// this file the same way: do any `await` (bcrypt hashing/comparing) BEFORE
// the readDb() that starts the real critical section, so the final
// read -> mutate -> write always runs as one synchronous, uninterruptible
// block. Endpoints that need to read something first (e.g. login needs the
// account to bcrypt.compare against) instead re-read fresh, synchronously,
// immediately before their final write - see the comment in
// POST /api/auth/login below.
// Finds the next free account id for a second (third, fourth, ...) family
// member signing up under the same clubId - see POST /api/auth/signup below.
// clubId-2, clubId-3, ... - first gap wins, so a family that signs up,
// unlinks, and re-signs-up doesn't accumulate ever-growing suffixes.
function nextFamilyAccountId(db, clubId) {
  for (let i = 2; ; i++) {
    const candidate = `${clubId}-${i}`;
    if (!db.members[candidate]) return candidate;
  }
}

app.post("/api/auth/signup", async (req, res) => {
  const { membershipNumber, name, password, familyGroup, phone, email, agreeTerms } = req.body;
  if (!membershipNumber || !name || !password) {
    return res.status(400).json({ error: "membershipNumber, name, and password are required" });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  // Mirrors the required checkbox on the sign-up form - re-checked here too
  // so a direct API call can't skip agreeing to the Terms & Conditions.
  if (agreeTerms !== true) {
    return res.status(400).json({ error: "You must agree to the Terms & Conditions to create an account" });
  }
  // Optional - only a light shape check (not full RFC validation) so a
  // genuine typo like "ahmed@gmail" is caught without rejecting anything
  // unusual that's still a real address.
  const trimmedEmail = (email || "").trim();
  if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return res.status(400).json({ error: "That doesn't look like a valid email address" });
  }
  // Hashing first (before reading db) means it doesn't depend on db state,
  // so the read -> mutate -> write below has no await in it at all - see
  // the comment above this handler.
  const passwordHash = await bcrypt.hash(password, 10);
  const db = readDb();
  // What the member typed here is the CLUB ID printed on the family's
  // membership card - the club issues one per household, not one per
  // person, so more than one person may legitimately "sign up with" the
  // same number. `existing` is whoever (if anyone) already holds the plain,
  // un-suffixed account for that card.
  const clubId = String(membershipNumber).trim();
  const existing = db.members[clubId];
  let accountId = clubId;
  let joiningExistingFamily = false;
  if (existing && existing.passwordHash) {
    // Someone else in the family already claimed the bare clubId as their
    // login - rather than rejecting outright, give this person their own
    // account under the same card number (clubId-2, clubId-3, ...), which
    // poolingKey()/membersInPool() then pools with the rest of the family
    // automatically, with no admin step and no waiting for anyone else to
    // register first, in either order. See the accountId/clubId note in the
    // response below - the frontend surfaces this new id prominently since
    // it (not the club card number) is what this person logs in with.
    accountId = nextFamilyAccountId(db, clubId);
    joiningExistingFamily = true;
  }
  // `existing` with no passwordHash (only possible when accountId === clubId
  // above) means an admin imported this member ahead of time (see
  // /api/admin/members/import) - this is them claiming that profile rather
  // than starting from scratch, so keep whatever was already on file (family
  // group, phone, email, dependents) unless they're explicitly overriding it
  // here.
  const claiming = accountId === clubId ? existing : null;
  db.members[accountId] = {
    membershipNumber: accountId,
    clubId,
    name,
    familyGroup: familyGroup || (claiming ? claiming.familyGroup : "") || "",
    phone: phone || (claiming ? claiming.phone : "") || "",
    email: trimmedEmail || (claiming ? claiming.email : "") || "",
    passwordHash,
    dependents: (claiming && claiming.dependents) || [],
    nickname: (claiming && claiming.nickname) || "",
    createdAt: (claiming && claiming.createdAt) || new Date().toISOString(),
    // This call is always the actual account-creation moment (a pre-existing
    // passwordHash on this exact accountId would have been impossible to
    // reach above), whether it's a brand-new member, someone claiming a
    // profile the committee pre-loaded for them, or a second family member
    // joining an already-registered clubId.
    accountCreatedAt: new Date().toISOString(),
    // Agreeing to the required checkbox above (validated) counts as
    // accepting whichever Terms & Conditions version is current right now.
    termsAcceptedVersion: db.termsAndConditions.version,
    termsAcceptedAt: new Date().toISOString(),
  };
  logActivity(db, {
    actorType: "member",
    actorId: accountId,
    actorName: name,
    action: "member_signup",
    details: joiningExistingFamily
      ? `Joined family club ID ${clubId} as an additional member`
      : claiming
      ? "Claimed an admin-created profile"
      : "Created a new account",
  });
  writeDb(db);

  const token = createSession("member", accountId);
  setSessionCookie(req, res, token);
  res.status(201).json({
    member: publicMember(db.members[accountId]),
    // Only present when this account's login id differs from the club card
    // number the person typed in, i.e. they're joining a family that
    // already has an account - the frontend uses this to make sure they
    // save/see their own id before continuing, since that (not the shared
    // clubId) is what they'll log in with from now on.
    assignedLoginId: joiningExistingFamily ? accountId : null,
  });
});

app.post("/api/auth/login", async (req, res) => {
  if (loginRateLimitCheck(req, res)) return;
  const { membershipNumber, password } = req.body;
  const db = readDb();
  const member = db.members[membershipNumber];
  const passwordOk = member && member.passwordHash && (await bcrypt.compare(password || "", member.passwordHash));
  if (!passwordOk) {
    recordLoginFailure(req.ip);
    return res.status(401).json({ error: "Incorrect membership number or password" });
  }
  // Re-read right before the write: nothing above this line has mutated
  // anything, so re-reading here - synchronously, with no further await
  // before writeDb() - picks up whatever any other request wrote to
  // db.json while this one was waiting on bcrypt.compare() above, instead
  // of the stale copy from before the await silently overwriting it. See
  // the longer comment above POST /api/auth/signup for the full race.
  const freshDb = readDb();
  const freshMember = freshDb.members[membershipNumber];
  if (!freshMember) {
    recordLoginFailure(req.ip);
    return res.status(401).json({ error: "Incorrect membership number or password" });
  }
  logActivity(freshDb, { actorType: "member", actorId: membershipNumber, actorName: freshMember.name, action: "member_login" });
  writeDb(freshDb);
  const token = createSession("member", membershipNumber);
  setSessionCookie(req, res, token);
  res.json({ member: publicMember(freshMember) });
});

app.post("/api/auth/staff-login", async (req, res) => {
  if (loginRateLimitCheck(req, res)) return;
  const { username, password } = req.body;
  const db = readDb();
  const staff = db.staffAccounts[username];
  const passwordOk = staff && staff.passwordHash && (await bcrypt.compare(password || "", staff.passwordHash));
  if (!passwordOk) {
    recordLoginFailure(req.ip);
    return res.status(401).json({ error: "Incorrect username or password" });
  }
  // Re-read right before the write - see the comment in POST /api/auth/login.
  const freshDb = readDb();
  const freshStaff = freshDb.staffAccounts[username];
  if (!freshStaff) {
    recordLoginFailure(req.ip);
    return res.status(401).json({ error: "Incorrect username or password" });
  }
  logActivity(freshDb, { actorType: "staff", actorId: username, actorName: freshStaff.name, action: "staff_login", details: freshStaff.role });
  writeDb(freshDb);
  const token = createSession("staff", username, freshStaff.role);
  setSessionCookie(req, res, token);
  res.json({ staff: publicStaff(freshStaff) });
});

app.post("/api/auth/logout", (req, res) => {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  const session = token ? sessions.get(token) : null;
  if (token && sessions.delete(token)) persistSessions();
  if (session) {
    const db = readDb();
    const actorName =
      session.type === "member"
        ? (db.members[session.id] || {}).name
        : (db.staffAccounts[session.id] || {}).name;
    logActivity(db, {
      actorType: session.type,
      actorId: session.id,
      actorName,
      action: session.type === "member" ? "member_logout" : "staff_logout",
    });
    writeDb(db);
  }
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
  const newPasswordHash = await bcrypt.hash(newPassword, 10);
  // Re-read right before the write - see the comment in POST /api/auth/login.
  const freshDb = readDb();
  const freshAccount = session.type === "member" ? freshDb.members[session.id] : freshDb.staffAccounts[session.id];
  if (!freshAccount) return res.status(401).json({ error: "Please sign in" });
  freshAccount.passwordHash = newPasswordHash;
  // A staff account created with a committee-chosen starting password (see
  // POST /api/staff/accounts) is required to set its own before it can do
  // anything else - this is the moment that requirement is satisfied.
  if (session.type === "staff") freshAccount.mustChangePassword = false;
  writeDb(freshDb);
  res.json({ ok: true, staff: session.type === "staff" ? publicStaff(freshAccount) : undefined });
});

// Admin-only: onboard more staff/admin accounts (replaces the old shared-key model).
// The admin picks this account's initial password themselves (there's no
// email/SMS to send a generated one through), so it's shared with the new
// staff member directly - mustChangePassword flags it as a stand-in they
// need to replace with one only they know. The frontend enforces this as a
// non-dismissible gate right after that account's first login (see
// applyMaybeShowMustChangePasswordGate() in app.js); it's cleared below the
// moment /api/auth/change-password succeeds for that account.
app.post("/api/staff/accounts", requireStaffRole("admin"), async (req, res) => {
  const { username, password, name, role } = req.body;
  if (!username || !password || !name || !["admin", "staff", "tournament", "management"].includes(role)) {
    return res.status(400).json({ error: "username, password, name, and a valid role are required" });
  }
  if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  // Hash before reading db - see the comment above POST /api/auth/signup.
  const passwordHash = await bcrypt.hash(password, 10);
  const db = readDb();
  if (db.staffAccounts[username]) return res.status(409).json({ error: "That username is already taken" });
  db.staffAccounts[username] = {
    username,
    name,
    role,
    passwordHash,
    mustChangePassword: true,
  };
  logActivity(db, {
    actorType: "staff",
    actorId: req.staff.username,
    actorName: req.staff.name,
    action: "staff_account_created",
    details: `${username} (${role})`,
  });
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
  const removedRole = db.staffAccounts[username].role;
  delete db.staffAccounts[username];
  logActivity(db, {
    actorType: "staff",
    actorId: req.staff.username,
    actorName: req.staff.name,
    action: "staff_account_removed",
    details: `${username} (${removedRole})`,
  });
  writeDb(db);
  res.json({ ok: true });
});

// "Forgot password" for members, without any email/SMS infrastructure: the
// member contacts the committee directly, and an admin resets their
// password here from the Admin tab, then tells them the new one in person
// or by phone/WhatsApp. No token or identity check beyond "you're a logged
// in admin" - same trust model as an admin creating staff accounts above.
app.post("/api/staff/members/:membershipNumber/reset-password", requireStaffRole("admin"), async (req, res) => {
  const { membershipNumber } = req.params;
  const { newPassword } = req.body;
  if (!req.db.members[membershipNumber]) {
    return res.status(404).json({ error: "No member found with that membership number" });
  }
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters" });
  }
  // Hash before re-reading db - see the comment above POST /api/auth/signup.
  const passwordHash = await bcrypt.hash(newPassword, 10);
  // Re-read right before the write - see the comment in POST /api/auth/login.
  const db = readDb();
  const member = db.members[membershipNumber];
  if (!member) return res.status(404).json({ error: "No member found with that membership number" });
  member.passwordHash = passwordHash;
  writeDb(db);
  res.json({ ok: true, member: publicMember(member) });
});

// -------------------------------------------------------------------------
// SELF-SERVICE PASSWORD RECOVERY (recovery PIN, no email/SMS infra needed)
// -------------------------------------------------------------------------
// A member or staff/admin account can optionally set a short "recovery PIN"
// for itself while logged in (below). Anyone who later forgets their
// password can reset it themselves at /api/auth/forgot-password (member) or
// /api/auth/staff-forgot-password (staff/admin) by proving they know both
// the account id AND that PIN - no admin involved. An account that never
// set a PIN still falls back to the existing admin-mediated reset above.
const MIN_PIN_LENGTH = 6;
// Per-account lockout for recovery-PIN guessing, on top of the existing
// per-IP loginRateLimitCheck() above - an attacker rotating IPs could
// otherwise still grind through a short PIN's keyspace against one
// specific known membership number/username.
// Keyed by "member:<id>"/"staff:<username>" so both share one Map safely.
// In-memory only, matching the login-failure Map above - a restart clears
// lockouts, an acceptable tradeoff for a club-scale app with no other
// datastore.
const pinAttempts = new Map();
const PIN_LOCKOUT_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
function checkPinLockout(key) {
  const rec = pinAttempts.get(key);
  if (!rec) return null;
  if (Date.now() - rec.first > PIN_LOCKOUT_WINDOW_MS) {
    pinAttempts.delete(key);
    return null;
  }
  if (rec.count >= PIN_LOCKOUT_MAX_ATTEMPTS) {
    return Math.ceil((PIN_LOCKOUT_WINDOW_MS - (Date.now() - rec.first)) / 60000);
  }
  return null;
}
function recordPinFailure(key) {
  const rec = pinAttempts.get(key);
  if (!rec || Date.now() - rec.first > PIN_LOCKOUT_WINDOW_MS) {
    pinAttempts.set(key, { count: 1, first: Date.now() });
  } else {
    rec.count++;
  }
}
function clearPinFailures(key) {
  pinAttempts.delete(key);
}

app.post("/api/me/recovery-pin", requireMember, async (req, res) => {
  const { password, pin } = req.body;
  if (!(await bcrypt.compare(password || "", req.member.passwordHash))) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }
  const trimmedPin = String(pin || "").trim();
  let recoveryPinHash = null;
  if (trimmedPin) {
    if (trimmedPin.length < MIN_PIN_LENGTH) {
      return res.status(400).json({ error: `Recovery PIN must be at least ${MIN_PIN_LENGTH} characters` });
    }
    recoveryPinHash = await bcrypt.hash(trimmedPin, 10);
  }
  // Re-read right before the write - see the comment in POST /api/auth/login.
  const db = readDb();
  const member = db.members[req.member.membershipNumber];
  if (!member) return res.status(401).json({ error: "Please log in" });
  member.recoveryPinHash = recoveryPinHash;
  writeDb(db);
  res.json({ ok: true, hasRecoveryPin: !!member.recoveryPinHash });
});

// Records the logged-in member's acceptance of whatever Terms & Conditions
// version is current right now - called both right after sign-up (the
// required checkbox there already implies this, see /api/auth/signup) and
// from the blocking "Terms have been updated" gate an existing member sees
// when their own termsAcceptedVersion is behind db.termsAndConditions.version
// (e.g. after an admin edits the text - see PUT /api/admin/terms below).
app.post("/api/me/accept-terms", requireMember, (req, res) => {
  const db = req.db;
  const member = req.member;
  member.termsAcceptedVersion = db.termsAndConditions.version;
  member.termsAcceptedAt = new Date().toISOString();
  writeDb(db);
  res.json({ member: publicMember(member) });
});

// Any staff role (not just admin) can protect their own account this way.
app.post("/api/staff/recovery-pin", requireStaffRole("staff"), async (req, res) => {
  const { password, pin } = req.body;
  if (!(await bcrypt.compare(password || "", req.staff.passwordHash))) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }
  const trimmedPin = String(pin || "").trim();
  let recoveryPinHash = null;
  if (trimmedPin) {
    if (trimmedPin.length < MIN_PIN_LENGTH) {
      return res.status(400).json({ error: `Recovery PIN must be at least ${MIN_PIN_LENGTH} characters` });
    }
    recoveryPinHash = await bcrypt.hash(trimmedPin, 10);
  }
  // Re-read right before the write - see the comment in POST /api/auth/login.
  const db = readDb();
  const staff = db.staffAccounts[req.staff.username];
  if (!staff) return res.status(401).json({ error: "Please sign in" });
  staff.recoveryPinHash = recoveryPinHash;
  writeDb(db);
  res.json({ ok: true, hasRecoveryPin: !!staff.recoveryPinHash });
});

// Public (logged-out) recovery endpoints. Shares the same rate limiter as
// login - a wrong PIN counts against the same per-IP throttle as a wrong
// password, so brute-forcing a short PIN this way is no easier than
// brute-forcing a password.
app.post("/api/auth/forgot-password", async (req, res) => {
  if (loginRateLimitCheck(req, res)) return;
  const db = readDb();
  const { membershipNumber, pin, newPassword } = req.body;
  const lockKey = `member:${membershipNumber}`;
  const lockedForMinutes = checkPinLockout(lockKey);
  if (lockedForMinutes) {
    return res.status(429).json({
      error: `Too many incorrect PIN attempts for this account. Please try again in about ${lockedForMinutes} minute(s), or contact the committee.`,
    });
  }
  const member = db.members[membershipNumber];
  if (!member || !member.recoveryPinHash) {
    return res.status(400).json({
      error: "No recovery PIN is set for this membership number. Please contact the committee to reset your password.",
    });
  }
  if (!(await bcrypt.compare(pin || "", member.recoveryPinHash))) {
    recordPinFailure(lockKey);
    recordLoginFailure(req.ip);
    return res.status(401).json({ error: "Incorrect club member ID or recovery PIN" });
  }
  clearPinFailures(lockKey);
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters" });
  }
  const newPasswordHash = await bcrypt.hash(newPassword, 10);
  // Re-read right before the write - see the comment in POST /api/auth/login.
  const freshDb = readDb();
  const freshMember = freshDb.members[membershipNumber];
  if (!freshMember) {
    return res.status(400).json({
      error: "No recovery PIN is set for this membership number. Please contact the committee to reset your password.",
    });
  }
  freshMember.passwordHash = newPasswordHash;
  writeDb(freshDb);
  const token = createSession("member", membershipNumber);
  setSessionCookie(req, res, token);
  res.json({ ok: true, member: publicMember(freshMember) });
});

app.post("/api/auth/staff-forgot-password", async (req, res) => {
  if (loginRateLimitCheck(req, res)) return;
  const db = readDb();
  const { username, pin, newPassword } = req.body;
  const lockKey = `staff:${username}`;
  const lockedForMinutes = checkPinLockout(lockKey);
  if (lockedForMinutes) {
    return res.status(429).json({
      error: `Too many incorrect PIN attempts for this account. Please try again in about ${lockedForMinutes} minute(s), or ask an admin to reset your password.`,
    });
  }
  const staff = db.staffAccounts[username];
  if (!staff || !staff.recoveryPinHash) {
    return res.status(400).json({
      error: "No recovery PIN is set for this account. Please ask an admin to reset your password.",
    });
  }
  if (!(await bcrypt.compare(pin || "", staff.recoveryPinHash))) {
    recordPinFailure(lockKey);
    recordLoginFailure(req.ip);
    return res.status(401).json({ error: "Incorrect username or recovery PIN" });
  }
  clearPinFailures(lockKey);
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters" });
  }
  const newPasswordHash = await bcrypt.hash(newPassword, 10);
  // Re-read right before the write - see the comment in POST /api/auth/login.
  const freshDb = readDb();
  const freshStaff = freshDb.staffAccounts[username];
  if (!freshStaff) {
    return res.status(400).json({
      error: "No recovery PIN is set for this account. Please ask an admin to reset your password.",
    });
  }
  freshStaff.passwordHash = newPasswordHash;
  writeDb(freshDb);
  const token = createSession("staff", username, freshStaff.role);
  setSessionCookie(req, res, token);
  res.json({ ok: true, staff: publicStaff(freshStaff) });
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
// Parses a time-of-day field (from an <input type="time">, start or end) -
// "" / undefined -> null (no time set), otherwise a "HH:MM" 24-hour string.
// Returns undefined on a genuinely invalid value so the caller can reject
// the request.
const TIME_FIELD_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
function parseTimeField(value) {
  if (value === undefined || value === null || value === "") return null;
  return TIME_FIELD_RE.test(value) ? value : undefined;
}
// Parses an "end date" field (from an <input type="date">) - "" / undefined
// -> null (single-day event, same as the start date), otherwise a
// "YYYY-MM-DD" string that must be on or after the start date. Returns
// undefined on a genuinely invalid value so the caller can reject the request.
const DATE_FIELD_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseEndDate(value, startDate) {
  if (value === undefined || value === null || value === "") return null;
  if (!DATE_FIELD_RE.test(value)) return undefined;
  if (startDate && value < startDate) return undefined;
  return value;
}
// The date an event is actually over - a multi-day event (endDate set)
// isn't done until its end date passes, not its start date. Used for the
// upcoming/past bucketing and the edit-lock check.
function eventEndDate(ev) {
  return ev.endDate || ev.date;
}
// Does this event currently have any "sub-activities" nested under it? A
// parent event day (e.g. "Sports Entertainment Day - New Cairo") is just a
// poster/wrapper once it has children - members register for one of the
// individual activities instead, never for the parent itself.
function eventHasChildren(db, eventId) {
  return db.events.some((e) => e.parentEventId === eventId);
}
// Validates a "parentEventId" field submitted from the Add/Edit event forms.
// Keeps the hierarchy exactly 2 levels deep: a child activity can't itself
// become a parent, and an event that already has activities under it can't
// be turned into someone else's child. Returns { ok, parentEventId } or
// { ok: false, error }.
function validateParentEventId(db, existingEvent, parentEventIdRaw) {
  if (parentEventIdRaw === undefined || parentEventIdRaw === null || parentEventIdRaw === "") {
    return { ok: true, parentEventId: null };
  }
  const parentEventId = Number(parentEventIdRaw);
  if (!Number.isFinite(parentEventId)) return { ok: false, error: "Invalid parent event" };
  if (existingEvent && parentEventId === existingEvent.id) {
    return { ok: false, error: "An event can't be its own parent" };
  }
  const parent = db.events.find((e) => e.id === parentEventId);
  if (!parent) return { ok: false, error: "Parent event not found" };
  if (parent.parentEventId) {
    return {
      ok: false,
      error: "That event is itself an activity under another event and can't be used as a parent",
    };
  }
  if (existingEvent && eventHasChildren(db, existingEvent.id)) {
    return {
      ok: false,
      error: "This event already has activities under it, so it can't itself be made an activity of another event",
    };
  }
  return { ok: true, parentEventId };
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
  requireStaffRole(["tournament"]),
  uploadEventCoverMedia.fields([
    { name: "coverPhoto", maxCount: 1 },
    { name: "coverVideo", maxCount: 1 },
  ]),
  (req, res) => {
    const db = req.db;
    const {
      nameEn,
      nameAr,
      sport,
      date,
      endDate,
      startTime,
      endTime,
      earlyDeadline,
      descriptionEn,
      descriptionAr,
      minCapacity,
      maxCapacity,
      parentEventId,
      allowMultipleActivities,
    } = req.body;
    if (!nameEn || !date) return res.status(400).json({ error: "nameEn and date are required" });
    const min = parseCapacity(minCapacity);
    const max = parseCapacity(maxCapacity);
    if (min === undefined || max === undefined) {
      return res.status(400).json({ error: "Min and max capacity must be empty or a non-negative number" });
    }
    if (min !== null && max !== null && min > max) {
      return res.status(400).json({ error: "Minimum capacity can't be greater than maximum capacity" });
    }
    const parsedStartTime = parseTimeField(startTime);
    const parsedEndTime = parseTimeField(endTime);
    if (parsedStartTime === undefined || parsedEndTime === undefined) {
      return res.status(400).json({ error: "Start/end time must be empty or a valid HH:MM time" });
    }
    const parsedEndDate = parseEndDate(endDate, date);
    if (parsedEndDate === undefined) {
      return res.status(400).json({ error: "End date must be empty or on/after the event date" });
    }
    const parentCheck = validateParentEventId(db, null, parentEventId);
    if (!parentCheck.ok) return res.status(400).json({ error: parentCheck.error });
    const coverPhotoFile = req.files && req.files.coverPhoto && req.files.coverPhoto[0];
    const coverVideoFile = req.files && req.files.coverVideo && req.files.coverVideo[0];
    const event = {
      id: db.nextIds.event++,
      nameEn,
      nameAr: nameAr || "",
      sport: sport || "",
      date,
      endDate: parsedEndDate,
      startTime: parsedStartTime,
      endTime: parsedEndTime,
      earlyDeadline: earlyDeadline || null,
      descriptionEn: descriptionEn || "",
      descriptionAr: descriptionAr || "",
      minCapacity: min,
      maxCapacity: max,
      parentEventId: parentCheck.parentEventId,
      allowMultipleActivities: String(allowMultipleActivities) === "true",
      coverPhoto: coverPhotoFile ? `/uploads/events/${coverPhotoFile.filename}` : "",
      coverVideo: coverVideoFile ? `/uploads/events/${coverVideoFile.filename}` : "",
      recap: { descriptionEn: "", descriptionAr: "", photos: [], video: "" },
    };
    db.events.push(event);
    logActivity(db, {
      actorType: "staff",
      actorId: req.staff.username,
      actorName: req.staff.name,
      action: "event_created",
      details: `${nameEn} (${date})`,
    });
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
  requireStaffRole(["tournament"]),
  uploadEventCoverMedia.fields([
    { name: "coverPhoto", maxCount: 1 },
    { name: "coverVideo", maxCount: 1 },
  ]),
  (req, res) => {
    const db = req.db;
    const eventId = Number(req.params.eventId);
    const event = db.events.find((e) => e.id === eventId);
    if (!event) return res.status(404).json({ error: "No such event" });
    if (eventEndDate(event) < todayStr()) {
      return res.status(400).json({ error: "This event has already finished and can no longer be edited" });
    }
    const {
      nameEn,
      nameAr,
      sport,
      date,
      endDate,
      startTime,
      endTime,
      earlyDeadline,
      descriptionEn,
      descriptionAr,
      minCapacity,
      maxCapacity,
      parentEventId,
      allowMultipleActivities,
    } = req.body;
    if (!nameEn || !date) return res.status(400).json({ error: "nameEn and date are required" });
    const min = parseCapacity(minCapacity);
    const max = parseCapacity(maxCapacity);
    if (min === undefined || max === undefined) {
      return res.status(400).json({ error: "Min and max capacity must be empty or a non-negative number" });
    }
    if (min !== null && max !== null && min > max) {
      return res.status(400).json({ error: "Minimum capacity can't be greater than maximum capacity" });
    }
    const parsedStartTime = parseTimeField(startTime);
    const parsedEndTime = parseTimeField(endTime);
    if (parsedStartTime === undefined || parsedEndTime === undefined) {
      return res.status(400).json({ error: "Start/end time must be empty or a valid HH:MM time" });
    }
    const parsedEndDate = parseEndDate(endDate, date);
    if (parsedEndDate === undefined) {
      return res.status(400).json({ error: "End date must be empty or on/after the event date" });
    }
    const parentCheck = validateParentEventId(db, event, parentEventId);
    if (!parentCheck.ok) return res.status(400).json({ error: parentCheck.error });
    event.nameEn = nameEn;
    event.nameAr = nameAr || "";
    event.sport = sport || "";
    event.date = date;
    event.endDate = parsedEndDate;
    event.startTime = parsedStartTime;
    event.endTime = parsedEndTime;
    event.earlyDeadline = earlyDeadline || null;
    event.descriptionEn = descriptionEn || "";
    event.descriptionAr = descriptionAr || "";
    event.minCapacity = min;
    event.maxCapacity = max;
    event.parentEventId = parentCheck.parentEventId;
    event.allowMultipleActivities = String(allowMultipleActivities) === "true";
    const coverPhotoFile = req.files && req.files.coverPhoto && req.files.coverPhoto[0];
    const coverVideoFile = req.files && req.files.coverVideo && req.files.coverVideo[0];
    if (coverPhotoFile) event.coverPhoto = `/uploads/events/${coverPhotoFile.filename}`;
    if (coverVideoFile) {
      // A video is much bigger than any photo this app handles - delete the
      // previous one on disk when it's replaced, so re-uploads (an admin
      // trying a different clip) don't silently pile up on the persistent
      // volume (same reasoning as the hero banner's video, see above).
      const oldVideo = event.coverVideo;
      event.coverVideo = `/uploads/events/${coverVideoFile.filename}`;
      if (oldVideo) fs.unlink(path.join(EVENT_UPLOADS_DIR, path.basename(oldVideo)), () => {});
    }
    logActivity(db, {
      actorType: "staff",
      actorId: req.staff.username,
      actorName: req.staff.name,
      action: "event_edited",
      details: `${nameEn} (${date})`,
    });
    writeDb(db);
    res.json({
      ...event,
      confirmedCount: confirmedRegistrationCount(db, event.id),
      waitlistCount: waitlistedRegistrationCount(db, event.id),
    });
  }
);

// Deletes an event outright - unlike editing, this is allowed for both
// upcoming AND already-finished events (an admin cleaning up a mistaken or
// duplicate entry shouldn't be blocked just because its date has passed).
// A parent event with activities still nested under it can't be deleted
// directly - the activities would be left pointing at a parent that no
// longer exists, so they (or their own reassignment) need to be handled
// first. Deleting an event also removes every registration tied to it
// (cascade) - keeping an orphaned registration around that points at a
// deleted event would break the dashboard, directory, and My Registrations
// for whoever was signed up. The response reports how many registrations
// were removed so the admin UI can show what actually happened.
app.delete("/api/events/:eventId", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const eventId = Number(req.params.eventId);
  const event = db.events.find((e) => e.id === eventId);
  if (!event) return res.status(404).json({ error: "No such event" });
  if (eventHasChildren(db, eventId)) {
    return res.status(400).json({
      error: "This event has activities nested under it - delete those first (or reassign them) before deleting it.",
    });
  }
  const removedRegistrations = db.registrations.filter((r) => r.eventId === eventId).length;
  db.registrations = db.registrations.filter((r) => r.eventId !== eventId);
  db.events = db.events.filter((e) => e.id !== eventId);
  logActivity(db, {
    actorType: "staff",
    actorId: req.staff.username,
    actorName: req.staff.name,
    action: "event_deleted",
    details: `${event.nameEn} (${removedRegistrations} registration(s) removed)`,
  });
  writeDb(db);
  res.json({ ok: true, eventId, removedRegistrations });
});

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
  const eventsHeld = db.events.filter((e) => eventEndDate(e) < todayStr()).length;
  const topEarners = Object.keys(db.members)
    .map((membershipNumber) => {
      const snap = balanceSnapshot(db, membershipNumber);
      return { name: publicDisplayName(db, membershipNumber), balance: snap ? snap.balance : 0 };
    })
    .filter((m) => m.balance > 0)
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 5);
  res.json({ totalMembers, eventsHeld, topEarners });
});

// -------------------------------------------------------------------------
// TERMS & CONDITIONS
// -------------------------------------------------------------------------
// Bilingual text a member must accept - at sign-up, and again whenever the
// committee changes it (this endpoint always bumps `version`, so every
// existing member's own termsAcceptedVersion falls behind and the frontend's
// blocking re-accept gate shows the next time they sign in - see
// applyMaybeShowTermsGate() in app.js). Read side is folded into
// GET /api/settings, same pattern as landing-page content below.
app.put("/api/admin/terms", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const { textEn, textAr } = req.body;
  if (!textEn || !textEn.trim() || !textAr || !textAr.trim()) {
    return res.status(400).json({ error: "Both the English and Arabic terms text are required" });
  }
  db.termsAndConditions = {
    textEn: textEn.trim(),
    textAr: textAr.trim(),
    version: db.termsAndConditions.version + 1,
    updatedAt: new Date().toISOString(),
  };
  writeDb(db);
  res.json({ termsAndConditions: db.termsAndConditions });
});

// -------------------------------------------------------------------------
// LANDING PAGE CUSTOMIZATION
// -------------------------------------------------------------------------
// Hero banner text, About block, sponsors/partners, photo gallery, and the
// order/visibility of every section on the Events landing page. Read side
// is folded into GET /api/settings (see below) since the public landing
// page already fetches that once at load; these are just the admin write
// endpoints. All reuse uploadEventPhoto for photos/logos, same as news and
// spotlights above - except the hero banner, which also optionally takes a
// background video (see uploadHeroMedia above).
app.put(
  "/api/admin/landing/hero",
  requireStaffRole("admin"),
  uploadHeroMedia.fields([
    { name: "photo", maxCount: 1 },
    { name: "video", maxCount: 1 },
  ]),
  (req, res) => {
    const db = req.db;
    const { headlineEn, headlineAr, taglineEn, taglineAr, removePhoto, removeVideo } = req.body;
    if (!headlineEn || !headlineEn.trim()) return res.status(400).json({ error: "An English headline is required" });
    const newPhotoFile = req.files && req.files.photo && req.files.photo[0];
    const newVideoFile = req.files && req.files.video && req.files.video[0];
    const oldVideo = db.landingPage.hero.video;
    // A video is a much bigger file than any photo this app handles, and
    // the persistent volume is capped at 500MB total - unlike small photo
    // replacements elsewhere in this file, delete the previous one on disk
    // whenever it's being replaced or explicitly removed, so re-uploads
    // (an admin trying a few different clips) don't silently pile up.
    if (oldVideo && (newVideoFile || removeVideo === "true")) {
      fs.unlink(path.join(HERO_VIDEO_UPLOADS_DIR, path.basename(oldVideo)), () => {});
    }
    db.landingPage.hero = {
      headlineEn: headlineEn.trim(),
      headlineAr: (headlineAr || "").trim(),
      taglineEn: (taglineEn || "").trim(),
      taglineAr: (taglineAr || "").trim(),
      photo: newPhotoFile ? `/uploads/events/${newPhotoFile.filename}` : removePhoto === "true" ? "" : db.landingPage.hero.photo,
      video: newVideoFile ? `/uploads/hero/${newVideoFile.filename}` : removeVideo === "true" ? "" : db.landingPage.hero.video,
    };
    writeDb(db);
    res.json({ hero: db.landingPage.hero });
  }
);

app.put("/api/admin/landing/about", requireStaffRole("admin"), uploadEventPhoto.single("photo"), (req, res) => {
  const db = req.db;
  const { titleEn, titleAr, bodyEn, bodyAr, removePhoto } = req.body;
  db.landingPage.about = {
    titleEn: (titleEn || "").trim() || db.landingPage.about.titleEn,
    titleAr: (titleAr || "").trim(),
    bodyEn: (bodyEn || "").trim(),
    bodyAr: (bodyAr || "").trim(),
    photo: req.file ? `/uploads/events/${req.file.filename}` : removePhoto === "true" ? "" : db.landingPage.about.photo,
  };
  writeDb(db);
  res.json({ about: db.landingPage.about });
});

app.post("/api/admin/landing/gallery", requireStaffRole("admin"), uploadEventPhoto.single("photo"), (req, res) => {
  const db = req.db;
  if (!req.file) return res.status(400).json({ error: "A photo is required" });
  const item = {
    id: db.nextIds.galleryPhoto++,
    photo: `/uploads/events/${req.file.filename}`,
    captionEn: (req.body.captionEn || "").trim(),
    captionAr: (req.body.captionAr || "").trim(),
    createdAt: new Date().toISOString(),
  };
  db.landingPage.gallery.push(item);
  writeDb(db);
  res.status(201).json(item);
});

app.delete("/api/admin/landing/gallery/:id", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  const before = db.landingPage.gallery.length;
  db.landingPage.gallery = db.landingPage.gallery.filter((g) => g.id !== id);
  if (db.landingPage.gallery.length === before) return res.status(404).json({ error: "No such gallery photo" });
  writeDb(db);
  res.json({ ok: true });
});

app.post("/api/admin/landing/sponsors", requireStaffRole("admin"), uploadEventPhoto.single("logo"), (req, res) => {
  const db = req.db;
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Sponsor name is required" });
  const sponsor = {
    id: db.nextIds.sponsor++,
    name,
    url: (req.body.url || "").trim(),
    logo: req.file ? `/uploads/events/${req.file.filename}` : "",
    createdAt: new Date().toISOString(),
  };
  db.landingPage.sponsors.push(sponsor);
  writeDb(db);
  res.status(201).json(sponsor);
});

app.delete("/api/admin/landing/sponsors/:id", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);
  const before = db.landingPage.sponsors.length;
  db.landingPage.sponsors = db.landingPage.sponsors.filter((s) => s.id !== id);
  if (db.landingPage.sponsors.length === before) return res.status(404).json({ error: "No such sponsor" });
  writeDb(db);
  res.json({ ok: true });
});

// Replaces the whole section order/visibility list in one call - simplest
// contract for a reorder-by-arrows admin UI that always has the full list
// in hand anyway. "events" is forced back to enabled regardless of what's
// posted: turning off the actual event listing would make the site
// pointless, so that's not a mistake this endpoint will let happen.
app.put("/api/admin/landing/sections", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const sections = req.body.sections;
  const keys = Array.isArray(sections) ? sections.map((s) => s && s.key) : [];
  const keySet = new Set(keys);
  const valid =
    Array.isArray(sections) &&
    sections.length === LANDING_SECTION_KEYS.length &&
    keySet.size === LANDING_SECTION_KEYS.length &&
    LANDING_SECTION_KEYS.every((k) => keySet.has(k));
  if (!valid) return res.status(400).json({ error: "sections must include every landing page section exactly once" });
  db.landingPage.sections = sections.map((s) => ({ key: s.key, enabled: !!s.enabled }));
  writeDb(db);
  res.json({ sections: db.landingPage.sections });
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
  // Optional relationship label (e.g. "Son", "Daughter", "Spouse", "Parent")
  // so the primary member can identify who each family member actually is
  // on the My Family card and on admin/attendance rosters. The client offers
  // a dropdown of the common relations plus "Other" (free text), but this
  // stays an unvalidated string here - not a fixed enum - since "Other" and
  // the PUT below (retagging an existing dependent) can both still send any
  // wording, including Arabic terms.
  const relationship = (req.body.relationship || "").trim();
  // Optional contact details for the family member themselves - a plain
  // stored record (visible to staff/admin, e.g. as an emergency contact on
  // the Member Directory), not a login of their own and not, today, wired
  // into any notification-sending (this app doesn't send SMS/email to
  // anyone yet, including the primary member). Same "trim and store, no
  // format validation" handling as the member's own phone/email above.
  const phone = (req.body.phone || "").trim();
  const email = (req.body.email || "").trim();
  const member = db.members[req.member.membershipNumber];
  member.dependents = member.dependents || [];
  const dependent = { id: db.nextIds.dependent++, name, relationship, phone, email };
  member.dependents.push(dependent);
  writeDb(db);
  res.status(201).json({ dependents: member.dependents });
});

// Lets a member update a dependent added earlier (before this feature
// existed, or just to fix a typo) without deleting and re-adding them -
// re-adding would mint a new dependent id and disconnect them from any
// registrations already made in their name.
app.put("/api/me/dependents/:id", requireMember, (req, res) => {
  const db = req.db;
  const member = db.members[req.member.membershipNumber];
  const id = Number(req.params.id);
  const dependent = (member.dependents || []).find((d) => d.id === id);
  if (!dependent) return res.status(404).json({ error: "No such family member" });
  if (typeof req.body.name === "string" && req.body.name.trim()) dependent.name = req.body.name.trim();
  if (typeof req.body.relationship === "string") dependent.relationship = req.body.relationship.trim();
  if (typeof req.body.phone === "string") dependent.phone = req.body.phone.trim();
  if (typeof req.body.email === "string") dependent.email = req.body.email.trim();
  writeDb(db);
  res.json({ dependents: member.dependents });
});

app.delete("/api/me/dependents/:id", requireMember, (req, res) => {
  const db = req.db;
  const member = db.members[req.member.membershipNumber];
  const id = Number(req.params.id);
  member.dependents = (member.dependents || []).filter((d) => d.id !== id);
  writeDb(db);
  res.json({ dependents: member.dependents });
});

// A member-chosen display name, unique across every member on the whole
// platform (case-insensitive), shown instead of their real name on
// public-facing surfaces only (community leaderboard, public tournament
// pages, the big-screen display, the live matches board) - every
// admin/staff-facing view (Member directory, rosters, check-in, the
// Management Dashboard) always shows the real name regardless, so staff can
// always tell who someone actually is.
app.post("/api/me/nickname", requireMember, (req, res) => {
  const db = req.db;
  const nickname = (req.body.nickname || "").trim();
  if (!nickname) return res.status(400).json({ error: "Nickname is required" });
  if (nickname.length > 24) return res.status(400).json({ error: "Nickname must be 24 characters or fewer" });
  const me = req.member.membershipNumber;
  const nicknameKey = nickname.toLowerCase();
  const taken = Object.keys(db.members).some(
    (num) => num !== me && (db.members[num].nickname || "").trim().toLowerCase() === nicknameKey
  );
  if (taken) return res.status(409).json({ error: "This nickname has already been taken. Please choose another." });
  db.members[me].nickname = nickname;
  writeDb(db);
  res.json({ nickname });
});

app.delete("/api/me/nickname", requireMember, (req, res) => {
  const db = req.db;
  db.members[req.member.membershipNumber].nickname = "";
  writeDb(db);
  res.json({ ok: true });
});

// Linking family members by club ID is different from dependents above: it
// connects two EXISTING club member accounts (e.g. a spouse or adult child
// who already has their own membership number, and possibly their own
// login) into the same familyGroup, so poolingKey() pools their points
// together automatically - no separate "merge points" logic needed. Each
// member keeps registering for events under their own account; only the
// points balance is shared.
//
// Shared by both the member self-service endpoints right below AND their
// admin equivalents further down (POST /api/admin/members/:id/family/link
// and .../unlink) - an admin doing this on a member's behalf, e.g. to link a
// child's own new account to a parent's, without either of them needing to
// be logged in or to already know each other's membership number.
function linkFamilyGroups(db, memberA, memberB) {
  if (memberA.membershipNumber === memberB.membershipNumber) {
    return { ok: false, status: 400, error: "A member can't be linked to themselves" };
  }
  const groupA = memberA.familyGroup && memberA.familyGroup.trim() ? memberA.familyGroup.trim() : null;
  const groupB = memberB.familyGroup && memberB.familyGroup.trim() ? memberB.familyGroup.trim() : null;
  if (groupA && groupB && groupA !== groupB) {
    // Both are already pooled with someone else under different groups -
    // silently merging those two existing families together is more likely
    // to be a typo than what was actually intended, so this asks for it to
    // be sorted out explicitly (unlink one first) rather than guessing.
    return { ok: false, status: 400, conflict: true };
  }
  // Whichever of the two already has a group wins (so linking a third or
  // fourth member later keeps joining the same established group); if
  // neither has one yet, mint a new one from memberA's own ID.
  const sharedGroup = groupA || groupB || `FAM-${memberA.membershipNumber}`;
  memberA.familyGroup = sharedGroup;
  memberB.familyGroup = sharedGroup;
  return { ok: true, sharedGroup };
}

// Undoes a link: only removes the TARGET member from the shared group (their
// own familyGroup field is cleared), leaving everyone else in the pool
// untouched. If that was the last other member in the group, there's no
// pool left to be part of - `me`'s own familyGroup is cleared too instead of
// leaving them "pooled" with nobody.
function unlinkFamilyMember(db, me, target) {
  const myKey = poolingKey(db, me.membershipNumber);
  if (poolingKey(db, target.membershipNumber) !== myKey || target.membershipNumber === me.membershipNumber) {
    return { ok: false, status: 400, error: "That member isn't linked to this family group" };
  }
  target.familyGroup = "";
  const remaining = membersInPool(db, myKey).filter((m) => m.membershipNumber !== target.membershipNumber);
  if (remaining.length <= 1) me.familyGroup = "";
  return { ok: true };
}

app.post("/api/me/family/link", requireMember, (req, res) => {
  const db = req.db;
  const me = db.members[req.member.membershipNumber];
  const otherId = String(req.body.membershipNumber || "").trim();
  if (!otherId) return res.status(400).json({ error: "Club member ID is required" });
  const other = db.members[otherId];
  if (!other) return res.status(404).json({ error: "No club member found with that ID" });
  const result = linkFamilyGroups(db, me, other);
  if (!result.ok) {
    return res.status(result.status).json({
      error: result.conflict
        ? "That member is already linked to a different family group. Contact the committee to merge them."
        : result.error,
    });
  }
  writeDb(db);
  res.json({
    familyGroup: result.sharedGroup,
    poolMembers: membersInPool(db, poolingKey(db, me.membershipNumber)).map((m) => ({
      membershipNumber: m.membershipNumber,
      name: m.name,
    })),
  });
});

// Either side of a link can undo it - there's no separate "owner" of a
// family group once two members are joined.
app.post("/api/me/family/unlink", requireMember, (req, res) => {
  const db = req.db;
  const me = db.members[req.member.membershipNumber];
  const targetId = String(req.body.membershipNumber || "").trim();
  if (!targetId) return res.status(400).json({ error: "Club member ID is required" });
  const target = db.members[targetId];
  if (!target) return res.status(404).json({ error: "No club member found with that ID" });
  const result = unlinkFamilyMember(db, me, target);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  writeDb(db);
  res.json({
    poolMembers: membersInPool(db, poolingKey(db, me.membershipNumber)).map((m) => ({
      membershipNumber: m.membershipNumber,
      name: m.name,
    })),
  });
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

  // A parent "event day" that has activities nested under it is just a
  // poster/wrapper - members must register for one of the individual
  // activities instead, never for the parent event itself.
  if (eventHasChildren(db, event.id)) {
    return res.status(400).json({
      error: "This is a multi-activity event day - please register for one of its individual activities instead.",
    });
  }

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

  // Sub-activity restriction: unless the parent event day has explicitly
  // opted into "allow multiple activities," a member (or a specific
  // dependent) can only be registered for one sibling activity under the
  // same parent at a time.
  if (event.parentEventId) {
    const parent = db.events.find((e) => e.id === event.parentEventId);
    if (parent && !parent.allowMultipleActivities) {
      const siblingIds = db.events.filter((e) => e.parentEventId === event.parentEventId).map((e) => e.id);
      const siblingRegistration = db.registrations.find(
        (r) =>
          r.membershipNumber === membershipNumber &&
          siblingIds.includes(r.eventId) &&
          (r.dependentId || null) === normalizedDependentId
      );
      if (siblingRegistration) {
        const siblingEvent = db.events.find((e) => e.id === siblingRegistration.eventId);
        return res.status(409).json({
          error: `${dependentName ? dependentName + " is" : "You're"} already registered for ${
            siblingEvent ? siblingEvent.nameEn : "another activity"
          } under this event day. Only one activity per person is allowed here.`,
        });
      }
    }
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
  logActivity(db, {
    actorType: "member",
    actorId: membershipNumber,
    actorName: req.member.name,
    action: isWaitlisted ? "event_waitlisted" : "event_registered",
    details: `${event.nameEn}${dependentName ? ` (for ${dependentName})` : ""}`,
  });
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
// Shared by both check-in paths (QR scan and the manual roster button) so
// "already checked in" / waitlisted / points-awarded logic can't drift
// between them. Mutates reg and persists on success; the caller just maps
// the returned {status, body} onto the HTTP response.
function performCheckIn(db, reg, staffActor) {
  const event = db.events.find((e) => e.id === reg.eventId);
  const member = publicMember(db.members[reg.membershipNumber]);
  // The person actually walking through the gate might be a family member
  // (dependent) registered under this member's account, not the member
  // themselves - show whoever it really is.
  const attendeeName = reg.dependentName || member.name;

  if (reg.checkedIn) {
    return {
      status: 409,
      body: { error: "Already checked in", checkedInAt: reg.checkInAt, member, attendeeName, event },
    };
  }
  if (reg.waitlisted) {
    return {
      status: 409,
      body: {
        error: "This registration is on the waiting list, not a confirmed spot - promote it from the Admin dashboard first if there's room",
        member,
        attendeeName,
        event,
      },
    };
  }

  reg.checkedIn = true;
  reg.checkInAt = new Date().toISOString();
  if (staffActor) {
    logActivity(db, {
      actorType: "staff",
      actorId: staffActor.username,
      actorName: staffActor.name,
      action: "checkin",
      details: `${attendeeName} — ${event ? event.nameEn : "unknown event"}`,
    });
  }
  writeDb(db);

  return {
    status: 200,
    body: {
      success: true,
      member,
      attendeeName,
      event,
      checkedInAt: reg.checkInAt,
      pointsAwarded: registrationPoints(db, reg),
      earlyRegistration: reg.earlyRegistration,
    },
  };
}

// Staff-only: scan a member's QR code at the event entrance. This is what
// actually awards their points (participation + early bonus + position
// bonus once results are in) - registering alone earns nothing.
app.post("/api/checkin", requireStaffRole("staff"), async (req, res) => {
  const db = req.db;
  const { code } = req.body;
  const { reg, error } = parseAndVerify(db, code);
  if (error) return res.status(400).json({ error });
  const result = performCheckIn(db, reg, req.staff);
  res.status(result.status).json(result.body);
});

// Staff-only: the roster behind the "missed the QR code" manual check-in
// list next to the scanner. Includes waitlisted registrations too (shown,
// not checkable - performCheckIn rejects those the same way the QR path
// does) so staff see the full picture at the gate, not just who's eligible.
app.get("/api/staff/events/:eventId/roster", requireStaffRole("staff"), async (req, res) => {
  const db = req.db;
  const eventId = Number(req.params.eventId);
  const event = db.events.find((e) => e.id === eventId);
  // A registration's QR is only worth showing while it could still actually
  // be used: not already checked in, not waitlisted (no QR was ever issued
  // for those), and the event itself hasn't closed. Lets staff/admin pull up
  // and resend a code to someone who missed it at the gate, without also
  // showing a stale code for someone already checked in or an event that's
  // over. Mirrors the exact same rule the member's own "My Registrations"
  // view already uses (see loadMyRegistrations() in app.js).
  const eventOver = !event || eventEndDate(event) < todayStr();
  const roster = await Promise.all(
    db.registrations
      .filter((r) => r.eventId === eventId)
      .map(async (r) => {
        const member = db.members[r.membershipNumber];
        const canShowQr = !r.checkedIn && !r.waitlisted && !eventOver;
        return {
          registrationId: r.id,
          attendeeName: r.dependentName || (member ? member.name : r.membershipNumber),
          membershipNumber: r.membershipNumber,
          checkedIn: !!r.checkedIn,
          checkInAt: r.checkInAt,
          waitlisted: !!r.waitlisted,
          qrDataUrl: canShowQr ? await qrDataUrl(r) : null,
        };
      })
  );
  roster.sort((a, b) => a.attendeeName.localeCompare(b.attendeeName));
  res.json(roster);
});

// Staff-only: manual check-in by picking a row on that roster, for a member
// who couldn't show their QR code (lost phone, dead battery, screenshot
// didn't save, etc). Same rules and same points-award path as the QR scan -
// only the lookup (registrationId instead of a signed QR payload) differs.
app.post("/api/checkin/manual", requireStaffRole("staff"), (req, res) => {
  const db = req.db;
  const registrationId = Number(req.body.registrationId);
  const reg = db.registrations.find((r) => r.id === registrationId);
  if (!reg) return res.status(404).json({ error: "Registration not found" });
  const result = performCheckIn(db, reg, req.staff);
  res.status(result.status).json(result.body);
});

// admin: enter finishing positions after an event, and optionally attach the
// after-event recap (a short write-up + extra photos) at the same time -
// this is what makes the event show up with full details on the Annual
// Activities page once it's moved there (automatically, based on its date).
app.post(
  "/api/events/:eventId/results",
  requireStaffRole("admin"),
  uploadEventRecapMedia.fields([
    { name: "recapPhotos", maxCount: 10 },
    { name: "recapVideo", maxCount: 1 },
  ]),
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
    event.recap = event.recap || { descriptionEn: "", descriptionAr: "", photos: [], video: "" };
    if (typeof req.body.recapDescriptionEn === "string") event.recap.descriptionEn = req.body.recapDescriptionEn;
    if (typeof req.body.recapDescriptionAr === "string") event.recap.descriptionAr = req.body.recapDescriptionAr;
    const recapPhotoFiles = (req.files && req.files.recapPhotos) || [];
    const recapVideoFile = req.files && req.files.recapVideo && req.files.recapVideo[0];
    if (recapPhotoFiles.length) {
      event.recap.photos.push(...recapPhotoFiles.map((f) => `/uploads/events/${f.filename}`));
    }
    if (recapVideoFile) {
      // Same disk-cleanup reasoning as the cover video above - delete the
      // previous recap video whenever a new one replaces it.
      const oldVideo = event.recap.video;
      event.recap.video = `/uploads/events/${recapVideoFile.filename}`;
      if (oldVideo) fs.unlink(path.join(EVENT_UPLOADS_DIR, path.basename(oldVideo)), () => {});
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
  // A member can only request a reward their current balance actually
  // covers - the ladder's own tier-1 minimum (1500 by default, admin-
  // editable) is the floor for any redemption at all, and every tier above
  // that follows the same rule (a tier-2 request needs the tier-2 points,
  // not just "more than tier 1"). Previously this was only a client-side
  // warning shown after the fact - the request still went through and sat
  // in the admin's Pending queue regardless of balance, which is what this
  // fix closes.
  if (snapshot.balance < tierDef.pointsRequired) {
    return res.status(400).json({
      error: `You need at least ${tierDef.pointsRequired} points for this reward — your current balance is ${snapshot.balance}.`,
    });
  }
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
  logActivity(db, {
    actorType: "member",
    actorId: membershipNumber,
    actorName: req.member.name,
    action: "redemption_requested",
    details: `${tierDef.rewardEn || "Tier " + tierDef.tier} (${tierDef.pointsRequired} pts)`,
  });
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
  logActivity(db, {
    actorType: "staff",
    actorId: req.staff.username,
    actorName: req.staff.name,
    action: "redemption_status_changed",
    details: `Redemption #${id} → ${status} (${redemption.membershipNumber})`,
  });
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

// -------------------------------------------------------------------------
// ACTIVITY LOG (admin-only report - see logActivity() near readDb() above)
// -------------------------------------------------------------------------
// Shared by both the in-app report and the .xlsx export below, so the two
// can never show different rows for the same filters. Returns newest-first.
function filterActivityLog(db, query) {
  let rows = db.activityLog.slice().reverse();
  const { actorType, q, action, from, to } = query;
  if (actorType) rows = rows.filter((r) => r.actorType === actorType);
  if (action) rows = rows.filter((r) => r.action === action);
  if (q) {
    const needle = String(q).trim().toLowerCase();
    if (needle) {
      rows = rows.filter(
        (r) =>
          (r.actorId || "").toLowerCase().includes(needle) ||
          (r.actorName || "").toLowerCase().includes(needle)
      );
    }
  }
  // `at` is a full ISO timestamp; from/to are plain "YYYY-MM-DD" dates from a
  // date-picker, so string comparison against just the date portion is
  // enough - no timezone-aware parsing needed for a same-day boundary check.
  if (from) rows = rows.filter((r) => r.at.slice(0, 10) >= from);
  if (to) rows = rows.filter((r) => r.at.slice(0, 10) <= to);
  return rows;
}
app.get("/api/admin/activity-log", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const rows = filterActivityLog(db, req.query);
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  // The distinct action tags seen across the WHOLE log (not just the current
  // filtered page) - the frontend uses this to populate the "Action" filter
  // dropdown with only tags that have ever actually occurred.
  const actions = Array.from(new Set(db.activityLog.map((r) => r.action))).sort();
  res.json({ entries: rows.slice(offset, offset + limit), total: rows.length, actions });
});

// Same filters as the report above, exported as a real .xlsx download (the
// SheetJS package this app already depends on for member import/export) -
// capped at ACTIVITY_LOG_MAX rows since that's the most the log ever holds.
app.get("/api/admin/activity-log/export.xlsx", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const rows = filterActivityLog(db, req.query).map((r) => ({
    Time: r.at,
    "User type": r.actorType === "member" ? "Member" : "Staff/Admin",
    "User ID": r.actorId,
    "User name": r.actorName,
    Action: r.action,
    Details: r.details,
  }));
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Activity Log");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="ahlawy-activity-log.xlsx"');
  res.send(buffer);
});

// Per-event registration/attendance breakdown for the admin dashboard - one
// row per event, newest first, with confirmed/waitlist/checked-in counts and
// the capacity the admin set (if any). Min is informational only (shown so
// the committee can see at a glance whether an event is under its target),
// it never blocks a registration.
app.get("/api/admin/dashboard", requireStaffRole(["tournament"]), (req, res) => {
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

// Attendance rollup for a parent "event day": its own confirmed/checked-in
// counts (usually zero - eventHasChildren's own comment above notes members
// register for a specific sub-activity, not the poster event itself, once
// it has children) combined with every child activity's own counts, plus
// each child's individual numbers so the admin hub can show both the
// whole-day combined total and where it came from. The hierarchy is always
// exactly 2 levels deep (validateParentEventId forbids a child from itself
// becoming a parent), so this never needs to recurse.
app.get("/api/admin/events/:eventId/attendance-rollup", requireStaffRole(["tournament"]), (req, res) => {
  const db = req.db;
  const eventId = Number(req.params.eventId);
  const event = db.events.find((e) => e.id === eventId);
  if (!event) return res.status(404).json({ error: "Event not found" });

  function countsFor(id) {
    const regs = db.registrations.filter((r) => r.eventId === id);
    const confirmed = regs.filter((r) => !r.waitlisted);
    const checkedIn = confirmed.filter((r) => r.checkedIn);
    return { confirmedCount: confirmed.length, checkedInCount: checkedIn.length };
  }

  const own = countsFor(eventId);
  const children = db.events
    .filter((e) => e.parentEventId === eventId)
    .map((e) => ({ eventId: e.id, nameEn: e.nameEn, nameAr: e.nameAr, ...countsFor(e.id) }));
  const combined = children.reduce(
    (acc, c) => ({
      confirmedCount: acc.confirmedCount + c.confirmedCount,
      checkedInCount: acc.checkedInCount + c.checkedInCount,
    }),
    { ...own }
  );

  res.json({ own, children, combined });
});

// Lists everyone on an event's waiting list, in join order, so the admin can
// decide who to promote first if a confirmed spot opens up.
app.get("/api/admin/events/:eventId/waitlist", requireStaffRole(["tournament"]), (req, res) => {
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
app.post("/api/admin/registrations/:id/promote", requireStaffRole(["tournament"]), (req, res) => {
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

// Adds a single new member directly - for the common "just one or two
// people" case where building/uploading an .xlsx via the import endpoint
// above would be overkill. Deliberately rejects an already-used membership
// number (409) rather than upserting like import does: this is an explicit
// "create new" action, so a collision almost certainly means the admin
// meant to search for the existing member (e.g. via the invite table or the
// per-event hub) instead of silently overwriting them.
app.post("/api/admin/members", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const membershipNumber = String(req.body.membershipNumber || "").trim();
  const name = String(req.body.name || "").trim();
  const phone = String(req.body.phone || "").trim();
  const familyGroup = String(req.body.familyGroup || "").trim();
  if (!membershipNumber || !name) {
    return res.status(400).json({ error: "Membership number and name are required" });
  }
  if (db.members[membershipNumber]) {
    return res.status(409).json({ error: "A member with this membership number already exists" });
  }
  db.members[membershipNumber] = {
    membershipNumber,
    name,
    familyGroup,
    phone,
    passwordHash: null,
    dependents: [],
    nickname: "",
    // Used by the management dashboard's club-growth chart. Only tracked
    // going forward (added in the same change as that dashboard) - members
    // created before this field existed simply have no createdAt, and the
    // dashboard buckets those into a "before tracking" baseline instead of
    // guessing a date for them.
    createdAt: new Date().toISOString(),
    accountCreatedAt: null,
  };
  logActivity(db, {
    actorType: "staff",
    actorId: req.staff.username,
    actorName: req.staff.name,
    action: "member_added",
    details: `${name} (#${membershipNumber})`,
  });
  writeDb(db);
  res.status(201).json({
    member: { membershipNumber, name, phone, familyGroup, hasLoggedInAccount: false, dependentsCount: 0 },
  });
});

// Admin equivalent of the member self-service family link/unlink above (see
// linkFamilyGroups()/unlinkFamilyMember() there) - lets staff pool any
// number of EXISTING member accounts into one shared family group directly
// from the Member Directory, without needing either member to be logged in
// or to already know each other's membership number. Typical use: a family
// member gets their own membership number and login (so they can register
// for events themselves) but should still share the family's points - link
// them here once, or call this again with a third/fourth account to grow
// the same group.
app.post("/api/admin/members/:membershipNumber/family/link", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const me = db.members[req.params.membershipNumber];
  if (!me) return res.status(404).json({ error: "No such member" });
  const otherId = String(req.body.membershipNumber || "").trim();
  if (!otherId) return res.status(400).json({ error: "The other member's club ID is required" });
  const other = db.members[otherId];
  if (!other) return res.status(404).json({ error: "No club member found with that ID" });
  const result = linkFamilyGroups(db, me, other);
  if (!result.ok) {
    return res.status(result.status).json({
      error: result.conflict
        ? "Both members are already linked to different family groups - unlink one from its current group first, then relink."
        : result.error,
    });
  }
  logActivity(db, {
    actorType: "staff",
    actorId: req.staff.username,
    actorName: req.staff.name,
    action: "family_linked",
    details: `${me.name} (#${me.membershipNumber}) + ${other.name} (#${other.membershipNumber})`,
  });
  writeDb(db);
  res.json({
    familyGroup: result.sharedGroup,
    poolMembers: membersInPool(db, poolingKey(db, me.membershipNumber)).map((m) => ({
      membershipNumber: m.membershipNumber,
      name: m.name,
    })),
  });
});

app.post("/api/admin/members/:membershipNumber/family/unlink", requireStaffRole("admin"), (req, res) => {
  const db = req.db;
  const me = db.members[req.params.membershipNumber];
  if (!me) return res.status(404).json({ error: "No such member" });
  const targetId = String(req.body.membershipNumber || "").trim();
  if (!targetId) return res.status(400).json({ error: "The member's club ID is required" });
  const target = db.members[targetId];
  if (!target) return res.status(404).json({ error: "No club member found with that ID" });
  const result = unlinkFamilyMember(db, me, target);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  logActivity(db, {
    actorType: "staff",
    actorId: req.staff.username,
    actorName: req.staff.name,
    action: "family_unlinked",
    details: `${target.name} (#${target.membershipNumber}) removed from ${me.name}'s (#${me.membershipNumber}) family group`,
  });
  writeDb(db);
  res.json({
    poolMembers: membersInPool(db, poolingKey(db, me.membershipNumber)).map((m) => ({
      membershipNumber: m.membershipNumber,
      name: m.name,
    })),
  });
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
// (optional) - matching the export above. Header cells are also tolerant of
// stray leading/trailing quote characters (straight or curly) - some
// club-exported sheets literally bake a `"Membership Number"` string,
// quotes and all, into the header cell, which would otherwise silently fail
// to match and skip every row with "Missing membership number or name".
//
// Al Ahly's real membership numbers are apparently issued per FAMILY, not
// per person - the same number can legitimately appear on several rows with
// different names. Rather than let later rows silently overwrite earlier
// ones under the same membership number (the previous behavior), rows are
// grouped by membership number first: the first row for a given number
// becomes/updates that primary member's own profile (same as before), and
// any additional rows sharing that number become dependents on that primary
// member's account (matched/deduped by name so re-importing the same file
// doesn't create duplicate dependents). A row whose membership number
// already exists updates that member's name/phone/family group in place;
// their password and existing dependents are never removed by import. A
// brand-new membership number gets a fresh, password-less profile - that
// person (or the admin, on their behalf) turns it into a real login later by
// signing up with that same membership number, which claims the profile
// instead of overwriting it (see /api/auth/signup).
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
        const normalizedKey = key
          .trim()
          .toLowerCase()
          .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
          .trim();
        if (keys.includes(normalizedKey)) return String(row[key]).trim();
      }
      return "";
    };

    const db = req.db;
    const created = [];
    const updated = [];
    const errors = [];
    const dependentsAdded = [];
    const dependentsSkipped = [];

    // Group parsed rows by membership number, preserving file order, before
    // touching the database at all.
    const groups = new Map(); // membershipNumber -> [{ name, phone, familyGroup, rowNum }]
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
      if (!groups.has(membershipNumber)) groups.set(membershipNumber, []);
      groups.get(membershipNumber).push({ name, phone, familyGroup, rowNum });
    });

    groups.forEach((groupRows, membershipNumber) => {
      const [primaryRow, ...dependentRows] = groupRows;
      const existing = db.members[membershipNumber];
      let member;
      if (existing) {
        existing.name = primaryRow.name;
        if (primaryRow.phone) existing.phone = primaryRow.phone;
        if (primaryRow.familyGroup) existing.familyGroup = primaryRow.familyGroup;
        member = existing;
        updated.push({ membershipNumber, name: primaryRow.name });
      } else {
        member = {
          membershipNumber,
          name: primaryRow.name,
          familyGroup: primaryRow.familyGroup || "",
          phone: primaryRow.phone || "",
          passwordHash: null,
          dependents: [],
          nickname: "",
          createdAt: new Date().toISOString(),
          accountCreatedAt: null,
        };
        db.members[membershipNumber] = member;
        created.push({ membershipNumber, name: primaryRow.name });
      }

      member.dependents = member.dependents || [];
      dependentRows.forEach((row) => {
        const nameKey = row.name.trim().toLowerCase();
        if (nameKey === member.name.trim().toLowerCase()) {
          // A repeated row for the primary member themselves (e.g. their row
          // appears twice in the sheet) - not a separate family member, so
          // don't create a duplicate dependent that's just a copy of them.
          dependentsSkipped.push({ membershipNumber, name: row.name, reason: "Matches the primary member's own name" });
          return;
        }
        const alreadyExists = member.dependents.some((d) => d.name.trim().toLowerCase() === nameKey);
        if (alreadyExists) {
          dependentsSkipped.push({ membershipNumber, name: row.name, reason: "Already a dependent on this account" });
          return;
        }
        const dependent = { id: db.nextIds.dependent++, name: row.name, relationship: "" };
        member.dependents.push(dependent);
        dependentsAdded.push({ membershipNumber, name: row.name, primaryName: member.name });
      });
    });

    logActivity(db, {
      actorType: "staff",
      actorId: req.staff.username,
      actorName: req.staff.name,
      action: "members_imported",
      details: `${created.length} created, ${updated.length} updated, ${dependentsAdded.length} dependent(s) added, ${errors.length} error(s)`,
    });
    writeDb(db);
    res.json({ created, updated, errors, dependentsAdded, dependentsSkipped, totalRows: rows.length });
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
  if (eventHasChildren(db, event.id)) {
    return res.status(400).json({
      error: "This is a multi-activity event day - invite people to one of its individual activities instead.",
    });
  }
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
  if (invited.length) {
    logActivity(db, {
      actorType: "staff",
      actorId: req.staff.username,
      actorName: req.staff.name,
      action: "members_invited_to_event",
      details: `${invited.length} member(s) → ${event.nameEn}`,
    });
  }
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
app.get("/api/admin/directory", requireStaffRole("admin"), async (req, res) => {
  const db = req.db;
  const today = todayStr();
  const rows = await Promise.all(
    Object.values(db.members).map(async (m) => {
      const snap = balanceSnapshot(db, m.membershipNumber);
      const registrations = await Promise.all(
        db.registrations
          .filter((r) => r.membershipNumber === m.membershipNumber)
          .map(async (r) => {
            const event = db.events.find((e) => e.id === r.eventId);
            // Same "still usable" rule as the staff roster endpoint above -
            // only show a QR while it hasn't been checked in/waitlisted and
            // the event hasn't closed yet, so admin can resend a real,
            // still-valid code rather than a stale one.
            const eventOver = !event || eventEndDate(event) < today;
            const canShowQr = !r.checkedIn && !r.waitlisted && !eventOver;
            return {
              eventId: r.eventId,
              nameEn: event ? event.nameEn : "",
              nameAr: event ? event.nameAr : "",
              date: event ? event.date : "",
              dependentName: r.dependentName,
              waitlisted: !!r.waitlisted,
              checkedIn: !!r.checkedIn,
              points: registrationPoints(db, r),
              qrDataUrl: canShowQr ? await qrDataUrl(r) : null,
            };
          })
      );
      registrations.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      return {
        membershipNumber: m.membershipNumber,
        name: m.name,
        phone: m.phone || "",
        email: m.email || "",
        familyGroup: m.familyGroup || "",
        hasLoggedInAccount: !!m.passwordHash,
        balance: snap ? snap.balance : 0,
        dependents: (m.dependents || []).map((d) => ({
          id: d.id,
          name: d.name,
          relationship: d.relationship || "",
          phone: d.phone || "",
          email: d.email || "",
        })),
        registrations,
        registeredCount: registrations.filter((r) => !r.waitlisted).length,
        checkedInCount: registrations.filter((r) => r.checkedIn).length,
      };
    })
  );
  rows.sort((a, b) => a.name.localeCompare(b.name));
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
  res.json({
    pointsVisibleToMembers: db.settings.pointsVisibleToMembers,
    theme: themePayload(db),
    landingPage: db.landingPage,
    terms: db.termsAndConditions,
  });
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

// -------------------------------------------------------------------------
// TOURNAMENTS
// -------------------------------------------------------------------------
// At most one tournament per event. It generates either a knockout bracket
// directly, or a round-robin group stage that feeds a knockout bracket,
// from that event's confirmed registrations - either one entrant per
// registration ("individual" mode) or admin-defined teams grouping several
// registrations together ("team" mode, for sports like football where the
// event registers individual members but the tournament is played by
// teams). Data shape:
//
//   { id, eventId, mode: "individual"|"team", format: "knockout"|"groups",
//     numGroups, advancePerGroup,        // only meaningful when format=groups
//     teams: [{ id, name, memberIds: [registrationId,...] }],  // team mode only
//     seedOrder: [entrantId,...],        // admin-controlled order, used to
//                                        // seed groups or the bracket
//     nextMatchId,
//     courts, matchMinutes, startTime, breakMinutes,   // optional court/
//                                        // timing setup - null unless the
//                                        // admin filled all three of
//                                        // courts/matchMinutes/startTime in;
//                                        // when set, every match generated
//                                        // from then on gets a court+time
//                                        // (see scheduleGroupMatches/
//                                        // scheduleKnockoutRounds below)
//     lastGroupSlotEnd,                 // minutes-after-midnight the group
//                                        // stage's last scheduled slot ends
//                                        // - only set when scheduled; lets
//                                        // the knockout stage's schedule
//                                        // start breakMinutes after it
//     attendance: { [registrationId]: "present"|"absent" },  // "not_yet" is
//                                        // just the absence of a key here
//     groups: [{ entrantIds:[...], matches:[{id,a,b,result,court,time}] }] | null,
//                                        // result: {scoreA,scoreB,winnerId}
//     knockout: { rounds: [ [{id,a,b,winnerId,scoreA,scoreB,note,court,time,bye}, ...], ... ] } | null,
//     standings: [{entrantId, rank}] | null,   // set once knockout completes
//     pointsAwardedAt: isoString | null,
//     status: "setup"|"team-setup"|"seeding"|"groups"|"knockout"|"casual"|"completed" }
//   "casual" is a fourth tournament format (alongside "knockout"/"groups")
//   for a no-results "just for fun" session - entrants/teams and attendance
//   work exactly as normal, but there's no seeding, generated bracket,
//   scores or standings. Its status goes team-setup (team mode only) ->
//   "casual" (active) -> "completed" (a manual admin toggle, purely for
//   display - see PUT .../casual-status), skipping "seeding"/"groups"/
//   "knockout" entirely.
//
// An "entrant" is either one registration (individual mode: entrant id is
// "reg" + registrationId) or one team (team mode: entrant id is the team's
// own id). Either way an entrant maps to one or more registrationIds, which
// is what lets the "award points" step reuse the exact same reg.position
// field (and therefore the exact same points math) as the existing manual
// Enter Event Results feature.

function findTournament(db, eventId) {
  return db.tournaments.find((t) => t.eventId === eventId);
}

// Individual-mode entrants are derived live from current registrations
// (not stored) so someone registering or being removed after tournament
// creation is automatically reflected. Team-mode entrants ARE stored (teams
// are a manual grouping the admin defines once).
// `forPublic` (default false) swaps a real member's name for their chosen
// nickname, if set - used only by the public tournament read (and the
// pages that build on it: the public tournament page, the big-screen
// display, the live matches board). A dependent's name is never swapped
// (dependents don't have their own account/nickname); admin reads always
// pass forPublic=false (the default) so staff can always see real names.
function tournamentEntrantName(db, reg, forPublic) {
  if (!reg) return "Member";
  if (reg.dependentName) return reg.dependentName;
  const member = db.members[reg.membershipNumber];
  if (!member) return "Member";
  return forPublic ? publicDisplayName(db, reg.membershipNumber) : member.name;
}
function tournamentEntrants(db, t, forPublic) {
  if (t.mode === "team") {
    return t.teams.map((team) => ({
      id: team.id,
      label: team.name,
      registrationIds: team.memberIds,
      // The names behind this team, in the order they were grouped - lets
      // every place a team's name is shown (seeding, standings, bracket,
      // group matches, the public/big-screen/live-matches pages) also show
      // a numbered player roster without a separate lookup. Individual-mode
      // entrants below leave this null since the entrant already IS the one
      // player - there's no separate roster to show.
      players: team.memberIds.map((regId) => {
        const reg = db.registrations.find((r) => r.id === regId);
        return tournamentEntrantName(db, reg, forPublic);
      }),
    }));
  }
  return db.registrations
    .filter((r) => r.eventId === t.eventId && !r.waitlisted)
    .map((r) => ({
      id: "reg" + r.id,
      label: tournamentEntrantName(db, r, forPublic),
      registrationIds: [r.id],
      players: null,
    }));
}

// Keeps seedOrder in sync with whatever tournamentEntrants() currently
// returns: entrants still present keep their relative order, newly-appeared
// entrants are appended, entrants no longer present are dropped. Mutates
// t.seedOrder and returns the (possibly unchanged) entrant list.
function reconcileSeedOrder(db, t, forPublic) {
  const entrants = tournamentEntrants(db, t, forPublic);
  const ids = new Set(entrants.map((e) => e.id));
  const kept = t.seedOrder.filter((id) => ids.has(id));
  const keptSet = new Set(kept);
  const appended = entrants.map((e) => e.id).filter((id) => !keptSet.has(id));
  t.seedOrder = [...kept, ...appended];
  return entrants;
}

function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

// The standard single-elimination "sports bracket" seeding order: returns
// an array of length `size` holding seed numbers 1..size in bracket-slot
// order, arranged so seed 1 and seed 2 can only meet in the final, seeds
// 1-4 can't meet before the semifinal, and so on.
function bracketSeedSlots(size) {
  let seeds = [1];
  while (seeds.length < size) {
    const n = seeds.length * 2;
    const next = [];
    for (const s of seeds) next.push(s, n + 1 - s);
    seeds = next;
  }
  return seeds;
}

// Writes a decided match's winner into the next round's slot. If this was
// the final round's match, computes and stores final standings instead.
function propagateKnockoutWinner(t, roundIndex, matchIndex, winnerId) {
  const rounds = t.knockout.rounds;
  const match = rounds[roundIndex][matchIndex];
  match.winnerId = winnerId;
  const nextRound = rounds[roundIndex + 1];
  if (!nextRound) {
    computeFinalStandings(t);
    return;
  }
  const nextMatch = nextRound[Math.floor(matchIndex / 2)];
  if (matchIndex % 2 === 0) nextMatch.a = winnerId;
  else nextMatch.b = winnerId;
}

function computeFinalStandings(t) {
  const rounds = t.knockout.rounds;
  const final = rounds[rounds.length - 1][0];
  const standings = [];
  if (final.winnerId) standings.push({ entrantId: final.winnerId, rank: 1 });
  const runnerUp = final.a === final.winnerId ? final.b : final.a;
  if (runnerUp) standings.push({ entrantId: runnerUp, rank: 2 });
  // The round right before the final is always the semifinal round (two
  // matches feeding the final's two slots), whatever the bracket's overall
  // depth - both losers there are conventionally tied for 3rd/4th, since
  // this app doesn't play a separate third-place match.
  if (rounds.length >= 2) {
    for (const m of rounds[rounds.length - 2]) {
      const loser = m.a === m.winnerId ? m.b : m.a;
      if (loser && loser !== final.winnerId && loser !== runnerUp) standings.push({ entrantId: loser, rank: 3 });
    }
  }
  t.standings = standings;
  t.status = "completed";
}

// Builds a fresh knockout bracket from an ordered entrant-id list (index 0
// = the top seed). Entrant counts that aren't a power of two get byes,
// placed per the standard seeding above; byes are resolved immediately.
function buildKnockoutRounds(t, orderedEntrantIds) {
  const n = orderedEntrantIds.length;
  const size = nextPowerOfTwo(n);
  const slots = bracketSeedSlots(size);
  const numRounds = Math.log2(size);
  const round0 = [];
  for (let i = 0; i < size; i += 2) {
    const seedA = slots[i];
    const seedB = slots[i + 1];
    const a = seedA <= n ? orderedEntrantIds[seedA - 1] : null;
    const b = seedB <= n ? orderedEntrantIds[seedB - 1] : null;
    const match = { id: t.nextMatchId++, a, b, winnerId: null, scoreA: null, scoreB: null, note: "", bye: false, court: null, time: null };
    if (a && !b) {
      match.winnerId = a;
      match.bye = true;
    } else if (b && !a) {
      match.winnerId = b;
      match.bye = true;
    }
    round0.push(match);
  }
  const rounds = [round0];
  let prevCount = round0.length;
  for (let r = 1; r < numRounds; r++) {
    const roundMatches = [];
    for (let i = 0; i < prevCount / 2; i++) {
      roundMatches.push({ id: t.nextMatchId++, a: null, b: null, winnerId: null, scoreA: null, scoreB: null, note: "", bye: false, court: null, time: null });
    }
    rounds.push(roundMatches);
    prevCount = roundMatches.length;
  }
  t.knockout = { rounds };
  t.status = "knockout";
  scheduleKnockoutRounds(t);
  // Propagate round-0 byes forward. A later round's match is only ever a
  // bye itself if BOTH its feeders were byes, which the loop below reaches
  // naturally on its next iteration since propagateKnockoutWinner is called
  // for every round-0 bye in slot order.
  round0.forEach((m, i) => {
    if (m.bye) propagateKnockoutWinner(t, 0, i, m.winnerId);
  });
}

// ---- court + time scheduling (optional - only runs when the tournament
// was set up with courts/matchMinutes/startTime) -------------------------
function timeStrToMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}
function minutesToTimeStr(mins) {
  const wrapped = ((Math.round(mins) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}
function hasSchedule(t) {
  return !!(t.courts && t.matchMinutes && t.startTime);
}

// Fills every court in each time slot with a queued match whose two
// entrants aren't already playing elsewhere in that same slot, so nobody
// is double-booked. Matches are pulled from the queue interleaved one
// round per group (group A match 1, group B match 1, ... group A match 2,
// ...) so groups progress roughly together instead of one group finishing
// long before the others start. Leaves t.lastGroupSlotEnd (minutes after
// midnight) so the knockout stage's schedule can continue right after it.
function scheduleGroupMatches(t) {
  if (!hasSchedule(t)) return;
  const maxLen = Math.max(0, ...t.groups.map((g) => g.matches.length));
  const queue = [];
  for (let r = 0; r < maxLen; r++) {
    for (const g of t.groups) if (g.matches[r]) queue.push(g.matches[r]);
  }
  let slotStart = timeStrToMinutes(t.startTime);
  while (queue.length) {
    const busy = new Set();
    let court = 0;
    let placedAny = false;
    while (court < t.courts) {
      const idx = queue.findIndex((m) => !busy.has(m.a) && !busy.has(m.b));
      if (idx === -1) break;
      const m = queue.splice(idx, 1)[0];
      m.court = court + 1;
      m.time = minutesToTimeStr(slotStart);
      busy.add(m.a);
      busy.add(m.b);
      court++;
      placedAny = true;
    }
    slotStart += t.matchMinutes;
    if (!placedAny) break; // safety net - shouldn't happen, avoids an infinite loop
  }
  t.lastGroupSlotEnd = slotStart;
}

// Assigns each knockout round its own consecutive block of time slots
// (a later round can't start until the round before it can actually be
// played), cycling matches across courts within a round. Bye matches don't
// need a real time slot since nothing is actually played. Starts right
// after the group stage's schedule (plus breakMinutes) when this
// tournament had a group stage, otherwise at the tournament's start time.
function scheduleKnockoutRounds(t) {
  if (!hasSchedule(t)) return;
  let slotStart =
    t.format === "groups" && t.lastGroupSlotEnd != null
      ? t.lastGroupSlotEnd + (t.breakMinutes || 0)
      : timeStrToMinutes(t.startTime);
  for (const round of t.knockout.rounds) {
    const real = round.filter((m) => !m.bye);
    let i = 0;
    let localSlot = slotStart;
    while (i < real.length) {
      for (let c = 0; c < t.courts && i < real.length; c++, i++) {
        real[i].court = c + 1;
        real[i].time = minutesToTimeStr(localSlot);
      }
      localSlot += t.matchMinutes;
    }
    slotStart = localSlot;
  }
  t.estimatedFinishMinutes = slotStart;
}

function buildGroups(t, orderedEntrantIds, numGroups) {
  const groups = Array.from({ length: numGroups }, () => ({ entrantIds: [], matches: [] }));
  orderedEntrantIds.forEach((id, i) => groups[i % numGroups].entrantIds.push(id));
  for (const g of groups) {
    for (let i = 0; i < g.entrantIds.length; i++) {
      for (let j = i + 1; j < g.entrantIds.length; j++) {
        g.matches.push({ id: t.nextMatchId++, a: g.entrantIds[i], b: g.entrantIds[j], result: null, court: null, time: null });
      }
    }
  }
  t.groups = groups;
  t.status = "groups";
  scheduleGroupMatches(t);
}

// Points-per-result default to 3 for a win, 1 each for a draw, 0 for a
// loss, but are configurable per tournament (see pointsConfigOf below) so a
// committee running a different sport/scoring convention can match it.
// Ranked by points, then goal difference, then goals scored, then each
// entrant's position in the tournament's seed order (stands in for "lower
// team number" - stable and always available, unlike head-to-head). Matches
// recorded before scores existed in this app (result only has winnerId, no
// scoreA/scoreB) still count fully for points/W-D-L, just contribute 0 to
// GF/GA/GD.
function pointsConfigOf(t) {
  return {
    win: Number.isFinite(t.winPoints) ? t.winPoints : 3,
    draw: Number.isFinite(t.drawPoints) ? t.drawPoints : 1,
    loss: Number.isFinite(t.lossPoints) ? t.lossPoints : 0,
  };
}
function computeGroupStandings(group, seedOrder, points) {
  const pts = points || { win: 3, draw: 1, loss: 0 };
  const stat = {};
  group.entrantIds.forEach((id) => (stat[id] = { played: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, points: 0 }));
  for (const m of group.matches) {
    if (!m.result) continue;
    const sa = Number.isFinite(m.result.scoreA) ? m.result.scoreA : null;
    const sb = Number.isFinite(m.result.scoreB) ? m.result.scoreB : null;
    stat[m.a].played++;
    stat[m.b].played++;
    if (sa !== null && sb !== null) {
      stat[m.a].gf += sa;
      stat[m.a].ga += sb;
      stat[m.b].gf += sb;
      stat[m.b].ga += sa;
    }
    if (m.result.winnerId === null) {
      stat[m.a].draws++;
      stat[m.b].draws++;
      stat[m.a].points += pts.draw;
      stat[m.b].points += pts.draw;
    } else {
      const loserId = m.result.winnerId === m.a ? m.b : m.a;
      stat[m.result.winnerId].wins++;
      stat[loserId].losses++;
      stat[m.result.winnerId].points += pts.win;
      stat[loserId].points += pts.loss;
    }
  }
  return [...group.entrantIds]
    .sort((a, b) => {
      const sa = stat[a], sb = stat[b];
      if (sb.points !== sa.points) return sb.points - sa.points;
      const gda = sa.gf - sa.ga, gdb = sb.gf - sb.ga;
      if (gdb !== gda) return gdb - gda;
      if (sb.gf !== sa.gf) return sb.gf - sa.gf;
      return seedOrder.indexOf(a) - seedOrder.indexOf(b);
    })
    .map((id) => ({ entrantId: id, ...stat[id], gd: stat[id].gf - stat[id].ga }));
}

// Serializes a tournament for the client, resolving entrant ids to display
// labels along the way so the frontend never has to cross-reference.
function serializeTournament(db, t, forPublic) {
  const entrants = reconcileSeedOrder(db, t, forPublic);
  const labelOf = (id) => {
    const e = entrants.find((x) => x.id === id);
    return e ? e.label : t.mode === "team" ? "(removed team)" : "(no longer registered)";
  };
  const groups = t.groups
    ? t.groups.map((g) => ({
        entrantIds: g.entrantIds,
        standings: computeGroupStandings(g, t.seedOrder, pointsConfigOf(t)).map((s) => ({ ...s, label: labelOf(s.entrantId) })),
        matches: g.matches.map((m) => ({ ...m, aLabel: labelOf(m.a), bLabel: labelOf(m.b) })),
      }))
    : null;
  const knockout = t.knockout
    ? {
        rounds: t.knockout.rounds.map((round) =>
          round.map((m) => ({
            ...m,
            aLabel: m.a ? labelOf(m.a) : null,
            bLabel: m.b ? labelOf(m.b) : null,
          }))
        ),
      }
    : null;
  // Attendance is stored keyed by registrationId; resolve it to a small
  // array with each player's name attached so the frontend never has to
  // cross-reference members/registrations itself, same as entrants/labels.
  const attendanceList = entrants.flatMap((e) =>
    e.registrationIds.map((regId) => {
      const reg = db.registrations.find((r) => r.id === regId);
      const name = tournamentEntrantName(db, reg, forPublic);
      return {
        registrationId: regId,
        entrantId: e.id,
        entrantLabel: e.label,
        name,
        status: (t.attendance || {})[regId] || "not_yet",
      };
    })
  );
  return {
    id: t.id,
    eventId: t.eventId,
    mode: t.mode,
    format: t.format,
    numGroups: t.numGroups,
    advancePerGroup: t.advancePerGroup,
    winPoints: pointsConfigOf(t).win,
    drawPoints: pointsConfigOf(t).draw,
    lossPoints: pointsConfigOf(t).loss,
    availableHours: Number.isFinite(t.availableHours) ? t.availableHours : null,
    status: t.status,
    teams: t.teams,
    entrants,
    seedOrder: t.seedOrder,
    groups,
    knockout,
    standings: t.standings ? t.standings.map((s) => ({ ...s, label: labelOf(s.entrantId) })) : null,
    pointsAwardedAt: t.pointsAwardedAt,
    schedule: hasSchedule(t)
      ? {
          courts: t.courts,
          matchMinutes: t.matchMinutes,
          startTime: t.startTime,
          breakMinutes: t.breakMinutes || 0,
          estimatedFinishTime: t.estimatedFinishMinutes != null ? minutesToTimeStr(t.estimatedFinishMinutes) : null,
        }
      : null,
    attendance: attendanceList,
  };
}

// Public: lightweight list of every event that has a tournament, for the
// public Tournaments nav tab. Kept separate from serializeTournament (which
// resolves the full bracket/groups) since the listing page only needs enough
// to render one row per event - the full detail is fetched afterward via
// GET /api/tournaments/:eventId once a member picks one.
app.get("/api/tournaments", (req, res) => {
  const db = readDb();
  const list = (db.tournaments || [])
    .map((t) => {
      const ev = db.events.find((e) => e.id === t.eventId);
      if (!ev) return null;
      return {
        eventId: t.eventId,
        nameEn: ev.nameEn,
        nameAr: ev.nameAr,
        sport: ev.sport,
        date: ev.date,
        mode: t.mode,
        format: t.format,
        status: t.status,
        hasSchedule: hasSchedule(t),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  res.json(list);
});

app.get("/api/tournaments/:eventId", (req, res) => {
  const db = readDb();
  const t = findTournament(db, Number(req.params.eventId));
  if (!t) return res.json({ tournament: null });
  // forPublic=true: this is the one and only tournament read used by the
  // public tournament page, the big-screen display, and the live matches
  // board (see "How to ship future updates" / this feature's summary) -
  // every other serializeTournament() call site is an admin route and
  // deliberately leaves this off (defaults to false/real names).
  res.json({ tournament: serializeTournament(db, t, true) });
});

app.get("/api/admin/tournaments/:eventId", requireStaffRole(["tournament"]), (req, res) => {
  const db = req.db;
  const eventId = Number(req.params.eventId);
  const t = findTournament(db, eventId);
  const registrations = db.registrations
    .filter((r) => r.eventId === eventId && !r.waitlisted)
    .map((r) => {
      const member = db.members[r.membershipNumber];
      return { id: r.id, label: r.dependentName || (member ? member.name : "Member") };
    });
  if (!t) return res.json({ tournament: null, registrations });
  res.json({ tournament: serializeTournament(db, t), registrations });
});

// Validates the optional win/draw/loss point values and available-hours
// field shared by tournament creation and the setup-editing endpoint below.
// Every field is optional - a field left out of the request keeps whatever
// value is passed in as its "current"/default. Returns { error } on a bad
// value, otherwise the three point values (each defaulted if not given) and
// availableHours (null if not given).
function parseSetupFields(body, current) {
  const result = { winPoints: current.winPoints, drawPoints: current.drawPoints, lossPoints: current.lossPoints, availableHours: current.availableHours };
  for (const [key, label] of [["winPoints", "Points for a win"], ["drawPoints", "Points for a draw"], ["lossPoints", "Points for a loss"]]) {
    if (body[key] === undefined || body[key] === "" || body[key] === null) continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < 0) return { error: `${label} must be a number of 0 or more` };
    result[key] = n;
  }
  if (body.availableHours === undefined) {
    // field not sent at all - leave whatever was already there unchanged
  } else if (body.availableHours === "" || body.availableHours === null) {
    result.availableHours = null; // sent but blank - explicit clear
  } else {
    const h = Number(body.availableHours);
    if (!Number.isFinite(h) || h <= 0) return { error: "Available hours must be a number greater than 0" };
    result.availableHours = h;
  }
  return result;
}

app.post("/api/admin/tournaments/:eventId", requireStaffRole(["tournament"]), (req, res) => {
  const db = req.db;
  const eventId = Number(req.params.eventId);
  const event = db.events.find((e) => e.id === eventId);
  if (!event) return res.status(404).json({ error: "No such event" });
  if (findTournament(db, eventId)) {
    return res.status(400).json({ error: "This event already has a tournament - delete it first to start over" });
  }
  const { mode, format } = req.body;
  if (mode !== "individual" && mode !== "team") return res.status(400).json({ error: "mode must be 'individual' or 'team'" });
  if (format !== "knockout" && format !== "groups" && format !== "casual") {
    return res.status(400).json({ error: "format must be 'knockout', 'groups' or 'casual'" });
  }
  let numGroups = null;
  let advancePerGroup = null;
  if (format === "groups") {
    numGroups = Number(req.body.numGroups);
    advancePerGroup = Number(req.body.advancePerGroup);
    if (!Number.isInteger(numGroups) || numGroups < 2) return res.status(400).json({ error: "numGroups must be a whole number of at least 2" });
    if (!Number.isInteger(advancePerGroup) || advancePerGroup < 1) return res.status(400).json({ error: "advancePerGroup must be a whole number of at least 1" });
  }
  // Court/timing setup is entirely optional - fill in all three of
  // courts/matchMinutes/startTime to get an auto-generated schedule, or
  // leave them out for a tournament with no assigned courts or times
  // (matches just get recorded whenever they're actually played).
  let courts = null;
  let matchMinutes = null;
  let startTime = null;
  let breakMinutes = 0;
  const anyScheduleField = req.body.courts !== undefined || req.body.matchMinutes !== undefined || req.body.startTime !== undefined;
  if (anyScheduleField) {
    courts = Number(req.body.courts);
    matchMinutes = Number(req.body.matchMinutes);
    startTime = req.body.startTime;
    if (!Number.isInteger(courts) || courts < 1) return res.status(400).json({ error: "Courts must be a whole number of at least 1" });
    if (!Number.isInteger(matchMinutes) || matchMinutes < 1) return res.status(400).json({ error: "Minutes per match must be a whole number of at least 1" });
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(startTime || ""))) return res.status(400).json({ error: "Start time must be in HH:MM 24-hour format" });
    if (req.body.breakMinutes !== undefined && req.body.breakMinutes !== "") {
      breakMinutes = Number(req.body.breakMinutes);
      if (!Number.isInteger(breakMinutes) || breakMinutes < 0) return res.status(400).json({ error: "Break minutes must be a whole number of 0 or more" });
    }
  }
  const setup = parseSetupFields(req.body, { winPoints: 3, drawPoints: 1, lossPoints: 0, availableHours: null });
  if (setup.error) return res.status(400).json({ error: setup.error });
  const t = {
    id: db.nextIds.tournament++,
    eventId,
    mode,
    format,
    numGroups,
    advancePerGroup,
    winPoints: setup.winPoints,
    drawPoints: setup.drawPoints,
    lossPoints: setup.lossPoints,
    availableHours: setup.availableHours,
    courts,
    matchMinutes,
    startTime,
    breakMinutes,
    teams: [],
    seedOrder: [],
    nextMatchId: 1,
    groups: null,
    knockout: null,
    standings: null,
    pointsAwardedAt: null,
    attendance: {},
    // Casual ("just for fun") tournaments skip seeding entirely - there's no
    // bracket/groups to order entrants for - so an individual-mode one goes
    // straight to "casual" (the active, attendance-only session), and a
    // team-mode one still needs the team-setup step first (see PUT .../teams
    // below for the matching transition once teams are saved).
    status: mode === "team" ? "team-setup" : format === "casual" ? "casual" : "seeding",
  };
  reconcileSeedOrder(db, t);
  db.tournaments.push(t);
  writeDb(db);
  res.status(201).json({ tournament: serializeTournament(db, t) });
});

app.delete("/api/admin/tournaments/:eventId", requireStaffRole(["tournament"]), (req, res) => {
  const db = req.db;
  const eventId = Number(req.params.eventId);
  const before = db.tournaments.length;
  db.tournaments = db.tournaments.filter((t) => t.eventId !== eventId);
  if (db.tournaments.length === before) return res.status(404).json({ error: "No tournament for this event" });
  writeDb(db);
  res.json({ ok: true });
});

// Team mode only: groups this event's registrations into named teams. Any
// registration not included in a team is simply left out of the
// tournament. Replaces the whole team list each call (simplest mental
// model - re-submit the full set to make a change).
app.put("/api/admin/tournaments/:eventId/teams", requireStaffRole(["tournament"]), (req, res) => {
  const db = req.db;
  const eventId = Number(req.params.eventId);
  const t = findTournament(db, eventId);
  if (!t) return res.status(404).json({ error: "No tournament for this event" });
  if (t.mode !== "team") return res.status(400).json({ error: "This tournament is not in team mode" });
  const teamsInput = Array.isArray(req.body.teams) ? req.body.teams : null;
  if (!teamsInput) return res.status(400).json({ error: "teams must be an array" });
  const validRegIds = new Set(
    db.registrations.filter((r) => r.eventId === eventId && !r.waitlisted).map((r) => r.id)
  );
  const seen = new Set();
  const teams = [];
  for (const raw of teamsInput) {
    const name = (raw.name || "").trim();
    const memberIds = Array.isArray(raw.memberIds) ? raw.memberIds.map(Number).filter((id) => validRegIds.has(id)) : [];
    if (!name || !memberIds.length) continue;
    for (const id of memberIds) {
      if (seen.has(id)) return res.status(400).json({ error: `Registration ${id} is assigned to more than one team` });
      seen.add(id);
    }
    // Team ids only need to be unique within this one tournament (not
    // globally), so a plain 1-based index each time the team list is
    // (re)submitted is enough - simple and fully deterministic.
    teams.push({ id: "team" + (teams.length + 1), name, memberIds });
  }
  if (teams.length < 2) return res.status(400).json({ error: "Define at least 2 teams (with at least one member each) before continuing" });
  t.teams = teams;
  t.status = t.format === "casual" ? "casual" : "seeding";
  reconcileSeedOrder(db, t);
  writeDb(db);
  res.json({ tournament: serializeTournament(db, t) });
});

app.put("/api/admin/tournaments/:eventId/seed-order", requireStaffRole(["tournament"]), (req, res) => {
  const db = req.db;
  const t = findTournament(db, Number(req.params.eventId));
  if (!t) return res.status(404).json({ error: "No tournament for this event" });
  const entrants = reconcileSeedOrder(db, t);
  const validIds = new Set(entrants.map((e) => e.id));
  const order = Array.isArray(req.body.seedOrder) ? req.body.seedOrder : null;
  if (!order || order.length !== entrants.length || !order.every((id) => validIds.has(id))) {
    return res.status(400).json({ error: "seedOrder must contain exactly the current entrant ids, each once" });
  }
  t.seedOrder = order;
  writeDb(db);
  res.json({ tournament: serializeTournament(db, t) });
});

// Sets or changes courts/matchMinutes/startTime/breakMinutes, at any point
// in the tournament's life - before anything is generated (same as filling
// them in at creation), or after groups/knockout already exist. In the
// latter case every match's court/time is wiped and recomputed from
// scratch with the same scheduling algorithm used at generation time;
// results and winners already recorded are untouched, only when/where each
// still-to-play match happens moves.
app.put("/api/admin/tournaments/:eventId/schedule", requireStaffRole(["tournament"]), (req, res) => {
  const db = req.db;
  const t = findTournament(db, Number(req.params.eventId));
  if (!t) return res.status(404).json({ error: "No tournament for this event" });
  const courts = Number(req.body.courts);
  const matchMinutes = Number(req.body.matchMinutes);
  const startTime = req.body.startTime;
  if (!Number.isInteger(courts) || courts < 1) return res.status(400).json({ error: "Courts must be a whole number of at least 1" });
  if (!Number.isInteger(matchMinutes) || matchMinutes < 1) return res.status(400).json({ error: "Minutes per match must be a whole number of at least 1" });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(startTime || ""))) return res.status(400).json({ error: "Start time must be in HH:MM 24-hour format" });
  let breakMinutes = 0;
  if (req.body.breakMinutes !== undefined && req.body.breakMinutes !== "" && req.body.breakMinutes !== null) {
    breakMinutes = Number(req.body.breakMinutes);
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0) return res.status(400).json({ error: "Break minutes must be a whole number of 0 or more" });
  }
  const currentPts = pointsConfigOf(t);
  const setup = parseSetupFields(req.body, { winPoints: currentPts.win, drawPoints: currentPts.draw, lossPoints: currentPts.loss, availableHours: t.availableHours });
  if (setup.error) return res.status(400).json({ error: setup.error });
  t.courts = courts;
  t.matchMinutes = matchMinutes;
  t.startTime = startTime;
  t.breakMinutes = breakMinutes;
  t.winPoints = setup.winPoints;
  t.drawPoints = setup.drawPoints;
  t.lossPoints = setup.lossPoints;
  t.availableHours = setup.availableHours;
  if (t.groups) {
    t.groups.forEach((g) => g.matches.forEach((m) => { m.court = null; m.time = null; }));
    scheduleGroupMatches(t);
  }
  if (t.knockout) {
    t.knockout.rounds.forEach((round) => round.forEach((m) => { m.court = null; m.time = null; }));
    scheduleKnockoutRounds(t);
  }
  writeDb(db);
  res.json({ tournament: serializeTournament(db, t) });
});

// Builds the group stage (format=groups) or the knockout bracket directly
// (format=knockout) from the current seed order. One-way door: once
// generated, entrants are locked in for this tournament (delete and
// recreate to change who's playing).
app.post("/api/admin/tournaments/:eventId/generate", requireStaffRole(["tournament"]), (req, res) => {
  const db = req.db;
  const t = findTournament(db, Number(req.params.eventId));
  if (!t) return res.status(404).json({ error: "No tournament for this event" });
  if (t.format === "casual") return res.status(400).json({ error: "Fun sessions don't use a generated bracket - just track attendance" });
  if (t.groups || t.knockout) return res.status(400).json({ error: "Already generated for this tournament" });
  const entrants = reconcileSeedOrder(db, t);
  if (entrants.length < 2) return res.status(400).json({ error: "Need at least 2 entrants to generate a tournament" });
  if (t.format === "groups") {
    if (entrants.length < t.numGroups * 2) {
      return res.status(400).json({ error: `Need at least ${t.numGroups * 2} entrants for ${t.numGroups} groups (2 per group minimum)` });
    }
    buildGroups(t, t.seedOrder, t.numGroups);
  } else {
    buildKnockoutRounds(t, t.seedOrder);
  }
  writeDb(db);
  res.json({ tournament: serializeTournament(db, t) });
});

// Undoes generation and sends the tournament back to the seeding step, so
// the admin can fix a wrong seed order (or reorder further) and regenerate
// through the exact same Generate flow used the first time - deliberately
// NOT a reseed-in-place, since entrant ids are baked into every match once
// generated. Only allowed while nothing has actually been played yet
// (byes don't count - nobody played those, they just auto-advanced), so
// there's nothing at risk of being silently discarded. If any real result
// already exists, the admin needs to delete and recreate the tournament
// instead - same trade-off already made for editing team rosters/seed
// order after generation (see the project notes on that decision).
app.post("/api/admin/tournaments/:eventId/reseed", requireStaffRole(["tournament"]), (req, res) => {
  const db = req.db;
  const t = findTournament(db, Number(req.params.eventId));
  if (!t) return res.status(404).json({ error: "No tournament for this event" });
  if (!t.groups && !t.knockout) {
    return res.status(400).json({ error: "This tournament hasn't been generated yet - just edit the seed order directly" });
  }
  if (t.status === "completed") {
    return res.status(400).json({ error: "This tournament is already completed and can't be reseeded" });
  }
  const playedGroupMatches = (t.groups || []).reduce((sum, g) => sum + g.matches.filter((m) => m.result).length, 0);
  const playedKnockoutMatches = t.knockout
    ? t.knockout.rounds.reduce((sum, round) => sum + round.filter((m) => m.winnerId && !m.bye).length, 0)
    : 0;
  const played = playedGroupMatches + playedKnockoutMatches;
  if (played > 0) {
    return res.status(400).json({
      error: `Can't reseed - ${played} match result${played === 1 ? " has" : "s have"} already been recorded. Delete and recreate the tournament instead if you need to change the seeding now.`,
    });
  }
  t.groups = null;
  t.knockout = null;
  t.standings = null;
  t.pointsAwardedAt = null;
  t.lastGroupSlotEnd = null;
  t.status = "seeding";
  reconcileSeedOrder(db, t);
  writeDb(db);
  res.json({ tournament: serializeTournament(db, t) });
});

// Casual ("just for fun") tournaments only: there's no bracket/groups to
// finish, so "completed" here is purely a manual admin toggle for display
// purposes (the public list badge, the Management Dashboard's completion
// rate) - no standings are computed and no points are auto-awarded, since
// participation points already accrue automatically via the event's normal
// gate check-in regardless of this toggle. Reversible either direction, so
// an admin who ends a session by mistake (or wants to reopen it for a late
// arrival) isn't stuck.
app.put("/api/admin/tournaments/:eventId/casual-status", requireStaffRole(["tournament"]), (req, res) => {
  const db = req.db;
  const t = findTournament(db, Number(req.params.eventId));
  if (!t) return res.status(404).json({ error: "No tournament for this event" });
  if (t.format !== "casual") return res.status(400).json({ error: "This isn't a fun/casual session" });
  const { status } = req.body;
  if (status !== "casual" && status !== "completed") return res.status(400).json({ error: "status must be 'casual' or 'completed'" });
  if (t.status !== "casual" && t.status !== "completed") {
    return res.status(400).json({ error: "Finish setting up teams before ending or reopening this session" });
  }
  t.status = status;
  writeDb(db);
  res.json({ tournament: serializeTournament(db, t) });
});

app.put("/api/admin/tournaments/:eventId/group-result", requireStaffRole(["tournament"]), (req, res) => {
  const db = req.db;
  const t = findTournament(db, Number(req.params.eventId));
  if (!t || !t.groups) return res.status(404).json({ error: "No group stage for this event" });
  const { matchId, scoreA, scoreB } = req.body;
  let match = null;
  for (const g of t.groups) {
    match = g.matches.find((m) => m.id === Number(matchId));
    if (match) break;
  }
  if (!match) return res.status(404).json({ error: "No such match" });
  const sa = Number(scoreA);
  const sb = Number(scoreB);
  if (!Number.isInteger(sa) || sa < 0 || !Number.isInteger(sb) || sb < 0) {
    return res.status(400).json({ error: "scoreA and scoreB must both be whole numbers of 0 or more" });
  }
  const winnerId = sa === sb ? null : sa > sb ? match.a : match.b;
  match.result = { scoreA: sa, scoreB: sb, winnerId };
  writeDb(db);
  res.json({ tournament: serializeTournament(db, t) });
});

// Present/absent check-in for the players actually in this tournament
// (every registrationId behind every entrant - in team mode that's every
// team member, not just the team as a whole). Separate from the event's
// own gate-scanner check-in, which is about arriving at the venue at all
// rather than being ready to play a specific match. "not_yet" is just the
// absence of a key, so clearing it back to not_yet removes the entry.
app.put("/api/admin/tournaments/:eventId/attendance", requireStaffRole(["tournament"]), (req, res) => {
  const db = req.db;
  const t = findTournament(db, Number(req.params.eventId));
  if (!t) return res.status(404).json({ error: "No tournament for this event" });
  const { registrationId, status } = req.body;
  if (!["present", "absent", "not_yet"].includes(status)) {
    return res.status(400).json({ error: "status must be 'present', 'absent' or 'not_yet'" });
  }
  const entrants = tournamentEntrants(db, t);
  const validRegIds = new Set(entrants.flatMap((e) => e.registrationIds));
  const regId = Number(registrationId);
  if (!validRegIds.has(regId)) return res.status(400).json({ error: "That registration isn't part of this tournament" });
  if (!t.attendance) t.attendance = {};
  if (status === "not_yet") delete t.attendance[regId];
  else t.attendance[regId] = status;
  writeDb(db);
  res.json({ tournament: serializeTournament(db, t) });
});

app.post("/api/admin/tournaments/:eventId/generate-knockout", requireStaffRole(["tournament"]), (req, res) => {
  const db = req.db;
  const t = findTournament(db, Number(req.params.eventId));
  if (!t || !t.groups) return res.status(404).json({ error: "No group stage for this event" });
  if (t.knockout) return res.status(400).json({ error: "Knockout stage already generated" });
  const undecided = t.groups.reduce((sum, g) => sum + g.matches.filter((m) => !m.result).length, 0);
  if (undecided > 0) {
    return res.status(400).json({ error: `${undecided} group-stage match(es) still need a result before the knockout stage can be generated` });
  }
  const standingsPerGroup = t.groups.map((g) => computeGroupStandings(g, t.seedOrder, pointsConfigOf(t)));
  const qualifiers = [];
  for (let rank = 0; rank < t.advancePerGroup; rank++) {
    const tierGroups = rank % 2 === 0 ? standingsPerGroup : [...standingsPerGroup].reverse();
    for (const standing of tierGroups) {
      if (standing[rank]) qualifiers.push(standing[rank].entrantId);
    }
  }
  if (qualifiers.length < 2) return res.status(400).json({ error: "Not enough qualifiers to build a knockout stage" });
  buildKnockoutRounds(t, qualifiers);
  writeDb(db);
  res.json({ tournament: serializeTournament(db, t) });
});

app.put("/api/admin/tournaments/:eventId/knockout-result", requireStaffRole(["tournament"]), (req, res) => {
  const db = req.db;
  const t = findTournament(db, Number(req.params.eventId));
  if (!t || !t.knockout) return res.status(404).json({ error: "No knockout bracket for this event" });
  const { roundIndex, matchId, winnerId, scoreA, scoreB, note } = req.body;
  const rIdx = Number(roundIndex);
  const round = t.knockout.rounds[rIdx];
  if (!round) return res.status(404).json({ error: "No such round" });
  const mIdx = round.findIndex((m) => m.id === Number(matchId));
  if (mIdx === -1) return res.status(404).json({ error: "No such match" });
  const match = round[mIdx];
  if (match.bye) return res.status(400).json({ error: "This match was already decided by a bye" });
  if (!match.a || !match.b) return res.status(400).json({ error: "Both entrants aren't set for this match yet" });
  // Scores are optional (an admin can just declare a winner with no score
  // entered), but when both are given and unambiguous they decide the
  // winner themselves - a knockout match can't end in a draw, so a tied
  // score (extra time still level, going to penalties) needs an explicit
  // winnerId from the admin, same as when no score is entered at all.
  let sa = null, sb = null;
  if (scoreA !== undefined && scoreA !== null && scoreA !== "") {
    sa = Number(scoreA);
    if (!Number.isInteger(sa) || sa < 0) return res.status(400).json({ error: "scoreA must be a whole number of 0 or more" });
  }
  if (scoreB !== undefined && scoreB !== null && scoreB !== "") {
    sb = Number(scoreB);
    if (!Number.isInteger(sb) || sb < 0) return res.status(400).json({ error: "scoreB must be a whole number of 0 or more" });
  }
  let finalWinnerId = winnerId;
  if (sa !== null && sb !== null && sa !== sb) finalWinnerId = sa > sb ? match.a : match.b;
  if (finalWinnerId !== match.a && finalWinnerId !== match.b) {
    return res.status(400).json({ error: "winnerId must be one of the match's two entrants" });
  }
  // Correcting a score without changing who won is always safe. Changing
  // who won is only safe if the next round hasn't already been decided off
  // the old winner - otherwise the next match (and anything past it) would
  // be left pointing at a matchup that never happened. Ask the admin to
  // undo/edit that later match first rather than silently cascading.
  if (match.winnerId && finalWinnerId !== match.winnerId) {
    const nextRound = t.knockout.rounds[rIdx + 1];
    if (nextRound) {
      const nextMatch = nextRound[Math.floor(mIdx / 2)];
      if (nextMatch.winnerId) {
        return res.status(400).json({ error: "Can't change the winner - the next round's match already has a result. Edit or undo that match first." });
      }
    }
  }
  match.scoreA = sa;
  match.scoreB = sb;
  match.note = typeof note === "string" ? note.slice(0, 60) : "";
  propagateKnockoutWinner(t, rIdx, mIdx, finalWinnerId);
  writeDb(db);
  res.json({ tournament: serializeTournament(db, t) });
});

// Applies final tournament standings to reg.position on every registration
// belonging to each ranked entrant (every member of a team gets the team's
// finishing rank) - the exact same field the manual Enter Event Results
// admin tool uses, so points calculate identically either way. Safe to
// call more than once (e.g. after fixing a mistake); each call just
// re-applies the current standings.
app.post("/api/admin/tournaments/:eventId/award-points", requireStaffRole(["tournament"]), (req, res) => {
  const db = req.db;
  const eventId = Number(req.params.eventId);
  const t = findTournament(db, eventId);
  if (!t || t.status !== "completed") return res.status(400).json({ error: "This tournament isn't completed yet" });
  if (!t.standings) return res.status(400).json({ error: "No standings to award points from" });
  const entrants = tournamentEntrants(db, t);
  let updated = 0;
  for (const standing of t.standings) {
    const entrant = entrants.find((e) => e.id === standing.entrantId);
    if (!entrant) continue;
    for (const regId of entrant.registrationIds) {
      const reg = db.registrations.find((r) => r.id === regId && r.eventId === eventId);
      if (reg) {
        reg.position = standing.rank;
        updated++;
      }
    }
  }
  t.pointsAwardedAt = new Date().toISOString();
  writeDb(db);
  res.json({ updated, tournament: serializeTournament(db, t) });
});

// ---------------------------------------------- management dashboard/report --
// Cross-event aggregate dashboard and per-event auto-generated reports, for
// the restricted "management" staff role (and, as with every other narrow
// role, Admin too - see requireStaffRole()). Everything here is computed
// live from existing data (members/events/registrations/redemptions/
// tournaments) - nothing new is stored except the member createdAt/
// accountCreatedAt timestamps added above, which only exist going forward.

function monthKeyOf(iso) {
  return iso ? String(iso).slice(0, 7) : null; // "YYYY-MM"
}

function computeClubGrowth(db) {
  const members = Object.values(db.members);
  const totalMembers = members.length;
  const membersWithAccount = members.filter((m) => m.passwordHash).length;
  const registeredMemberNumbers = new Set(db.registrations.map((r) => r.membershipNumber));
  const activeCount = members.filter((m) => registeredMemberNumbers.has(m.membershipNumber)).length;
  const neverRegisteredCount = totalMembers - activeCount;

  // Total-members-over-time: a cumulative line, bucketed by the month each
  // member's record was first created. Members from before this field
  // existed (createdAt missing) are folded into one "before" starting point
  // instead of being dropped or given a fabricated date.
  const withCreatedAt = members.filter((m) => m.createdAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const legacyMemberCount = totalMembers - withCreatedAt.length;
  const memberMonthCounts = new Map();
  for (const m of withCreatedAt) {
    const key = monthKeyOf(m.createdAt);
    memberMonthCounts.set(key, (memberMonthCounts.get(key) || 0) + 1);
  }
  let running = legacyMemberCount;
  const totalMembersOverTime = [{ month: "before", cumulative: running }];
  for (const key of [...memberMonthCounts.keys()].sort()) {
    running += memberMonthCounts.get(key);
    totalMembersOverTime.push({ month: key, cumulative: running });
  }

  // New sign-ups (accounts actually created, not just roster entries) by
  // month - same "before tracking" bucket for accounts created before this
  // field existed.
  const withAccountCreatedAt = members.filter((m) => m.passwordHash && m.accountCreatedAt);
  const legacyAccountCount = membersWithAccount - withAccountCreatedAt.length;
  const signupMonthCounts = new Map();
  for (const m of withAccountCreatedAt) {
    const key = monthKeyOf(m.accountCreatedAt);
    signupMonthCounts.set(key, (signupMonthCounts.get(key) || 0) + 1);
  }
  const newSignupsByMonth = [
    { month: "before", count: legacyAccountCount },
    ...[...signupMonthCounts.keys()].sort().map((key) => ({ month: key, count: signupMonthCounts.get(key) })),
  ];

  return { totalMembers, membersWithAccount, activeCount, neverRegisteredCount, totalMembersOverTime, newSignupsByMonth };
}

function computeEventTrends(db) {
  return db.events
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
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
        confirmedCount: confirmed.length,
        waitlistCount: waitlist.length,
        checkedInCount: checkedIn.length,
        attendanceRate: confirmed.length ? Math.round((checkedIn.length / confirmed.length) * 100) : null,
      };
    });
}

function computePointsActivity(db) {
  const totalPointsAwarded = db.registrations.reduce((sum, r) => sum + registrationPoints(db, r), 0);
  const redemptions = {
    total: db.redemptions.length,
    pending: db.redemptions.filter((r) => r.status === "Pending").length,
    approved: db.redemptions.filter((r) => r.status === "Approved").length,
    fulfilled: db.redemptions.filter((r) => r.status === "Fulfilled").length,
    rejected: db.redemptions.filter((r) => r.status === "Rejected").length,
  };
  const leaderboard = Object.keys(db.members)
    .map((membershipNumber) => balanceSnapshot(db, membershipNumber))
    .filter(Boolean)
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 10)
    .map((s) => ({ membershipNumber: s.membershipNumber, name: s.member.name, balance: s.balance }));
  return { totalPointsAwarded, redemptions, leaderboard };
}

function computeTournamentActivity(db) {
  const tournaments = db.tournaments || [];
  const rows = tournaments
    .map((t) => {
      const ev = db.events.find((e) => e.id === t.eventId);
      if (!ev) return null;
      return {
        eventId: t.eventId,
        nameEn: ev.nameEn,
        nameAr: ev.nameAr,
        date: ev.date,
        mode: t.mode,
        format: t.format,
        status: t.status,
        participantCount: tournamentEntrants(db, t).length,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const completedCount = tournaments.filter((t) => t.status === "completed").length;
  return {
    totalTournaments: tournaments.length,
    completedCount,
    completionRate: tournaments.length ? Math.round((completedCount / tournaments.length) * 100) : null,
    totalParticipants: rows.reduce((sum, r) => sum + r.participantCount, 0),
    rows,
  };
}

app.get("/api/admin/management/dashboard", requireStaffRole(["management"]), (req, res) => {
  const db = req.db;
  res.json({
    clubGrowth: computeClubGrowth(db),
    eventTrends: computeEventTrends(db),
    pointsActivity: computePointsActivity(db),
    tournamentActivity: computeTournamentActivity(db),
  });
});

// Auto-generated per-event report: attendance, registration timing, points
// awarded, and tournament results (if the event had one) - all computed
// live from existing data, nothing stored. Shared by the in-app report view
// and the downloadable .docx below, so both always agree.
function buildEventReport(db, eventId) {
  const event = db.events.find((e) => e.id === eventId);
  if (!event) return null;
  const regs = db.registrations.filter((r) => r.eventId === eventId);
  const confirmed = regs.filter((r) => !r.waitlisted);
  const waitlisted = regs.filter((r) => r.waitlisted);
  const checkedIn = confirmed.filter((r) => r.checkedIn);
  const over = eventEndDate(event) < todayStr();
  const noShow = over ? confirmed.filter((r) => !r.checkedIn) : [];
  const early = confirmed.filter((r) => r.earlyRegistration);

  // Capacity fill timeline: cumulative confirmed registrations by day, in
  // registration order - shows how quickly the event filled up.
  const byDay = new Map();
  confirmed
    .slice()
    .sort((a, b) => a.registeredAt.localeCompare(b.registeredAt))
    .forEach((r) => {
      const day = r.registeredAt.slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);
    });
  let cumulative = 0;
  const fillTimeline = [...byDay.keys()].sort().map((day) => {
    cumulative += byDay.get(day);
    return { date: day, cumulativeConfirmed: cumulative };
  });
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysBefore = confirmed
    .map((r) => (new Date(event.date) - new Date(r.registeredAt.slice(0, 10))) / msPerDay)
    .filter((d) => Number.isFinite(d));
  const avgDaysBeforeEvent = daysBefore.length
    ? Math.round((daysBefore.reduce((a, b) => a + b, 0) / daysBefore.length) * 10) / 10
    : null;

  const participationTotal = checkedIn.length * db.rules.participation;
  const earlyBonusTotal = checkedIn.filter((r) => r.earlyRegistration).reduce((sum) => sum + db.rules.earlyBonus, 0);
  const positionBonusTotal = checkedIn.reduce(
    (sum, r) => sum + (r.position ? db.rules.positionBonus[String(r.position)] || 0 : 0),
    0
  );

  const t = findTournament(db, eventId);
  let tournament = null;
  if (t) {
    const serialized = serializeTournament(db, t);
    tournament = {
      mode: t.mode,
      format: t.format,
      status: t.status,
      participantCount: serialized.entrants.length,
      standings: serialized.standings || null,
      winnerLabel: serialized.standings && serialized.standings.length ? serialized.standings[0].label : null,
    };
  }

  return {
    event: {
      id: event.id,
      nameEn: event.nameEn,
      nameAr: event.nameAr,
      date: event.date,
      endDate: event.endDate || null,
      minCapacity: event.minCapacity,
      maxCapacity: event.maxCapacity,
    },
    attendance: {
      registeredTotal: regs.length,
      confirmed: confirmed.length,
      waitlisted: waitlisted.length,
      checkedIn: checkedIn.length,
      noShow: noShow.length,
      eventOver: over,
      checkedInRate: confirmed.length ? Math.round((checkedIn.length / confirmed.length) * 100) : null,
    },
    timing: {
      earlyRegistrationsCount: early.length,
      earlyRegistrationsRate: confirmed.length ? Math.round((early.length / confirmed.length) * 100) : null,
      fillTimeline,
      avgDaysBeforeEvent,
      maxCapacity: event.maxCapacity,
      filledPercent: event.maxCapacity ? Math.round((confirmed.length / event.maxCapacity) * 100) : null,
    },
    points: {
      totalAwarded: participationTotal + earlyBonusTotal + positionBonusTotal,
      participationTotal,
      earlyBonusTotal,
      positionBonusTotal,
    },
    tournament,
  };
}

app.get("/api/admin/management/events/:eventId/report", requireStaffRole(["management"]), (req, res) => {
  const report = buildEventReport(req.db, Number(req.params.eventId));
  if (!report) return res.status(404).json({ error: "Event not found" });
  res.json(report);
});

// ------------------------------------------- downloadable .docx report ----
function reportDocLabels(lang) {
  const ar = lang === "ar";
  const L = (en, arText) => (ar ? arText : en);
  const statusLabel = (status) => {
    const map = {
      "team-setup": L("Setting up teams", "إعداد الفرق"),
      seeding: L("Seeding", "الترتيب التصنيفي"),
      groups: L("Group stage", "دور المجموعات"),
      knockout: L("Knockout", "خروج المغلوب"),
      casual: L("In progress (fun session)", "جارية (جلسة ترفيهية)"),
      completed: L("Completed", "اكتملت"),
    };
    return map[status] || status;
  };
  return { ar, L, statusLabel };
}

async function buildEventReportDocx(report, lang) {
  const { ar, L, statusLabel } = reportDocLabels(lang);
  const name = ar ? report.event.nameAr || report.event.nameEn : report.event.nameEn || report.event.nameAr;
  const alignment = ar ? AlignmentType.RIGHT : AlignmentType.LEFT;

  const heading = (text) =>
    new Paragraph({ text, heading: HeadingLevel.HEADING_2, bidirectional: ar, alignment, spacing: { before: 240, after: 120 } });
  const para = (text) =>
    new Paragraph({ children: [new TextRun({ text, rightToLeft: ar })], bidirectional: ar, alignment, spacing: { after: 80 } });
  const cellPara = (text, bold) =>
    new Paragraph({ children: [new TextRun({ text: String(text), bold: !!bold, rightToLeft: ar })], bidirectional: ar, alignment });
  const statTable = (rows) =>
    new Table({
      width: { size: 9000, type: WidthType.DXA },
      columnWidths: [4500, 4500],
      rows: rows.map(
        ([label, value]) =>
          new TableRow({
            children: [
              new TableCell({
                width: { size: 4500, type: WidthType.DXA },
                shading: { type: ShadingType.CLEAR, fill: "F2F2F2" },
                children: [cellPara(label, true)],
              }),
              new TableCell({ width: { size: 4500, type: WidthType.DXA }, children: [cellPara(value, false)] }),
            ],
          })
      ),
    });

  const children = [
    new Paragraph({ text: L("Event Report", "تقرير الفعالية"), heading: HeadingLevel.HEADING_1, bidirectional: ar, alignment }),
    para(name || ""),
    para(`${L("Date", "التاريخ")}: ${report.event.date}${report.event.endDate ? " - " + report.event.endDate : ""}`),
    heading(L("Attendance Summary", "ملخص الحضور")),
    statTable([
      [L("Registered (total)", "إجمالي التسجيلات"), report.attendance.registeredTotal],
      [L("Confirmed", "مؤكد"), report.attendance.confirmed],
      [L("Waitlisted", "قائمة الانتظار"), report.attendance.waitlisted],
      [L("Checked in", "تم تسجيل الحضور"), report.attendance.checkedIn],
      [
        L("No-shows", "لم يحضروا"),
        report.attendance.eventOver
          ? report.attendance.noShow
          : L("Not yet determined (event hasn't ended)", "لم يتحدد بعد (الفعالية لم تنتهِ)"),
      ],
      [
        L("Check-in rate", "نسبة الحضور"),
        report.attendance.checkedInRate !== null ? report.attendance.checkedInRate + "%" : L("N/A", "غير متاح"),
      ],
    ]),
    heading(L("Timing Details", "تفاصيل التوقيت")),
    statTable([
      [L("Early-registration sign-ups", "التسجيلات المبكرة"), report.timing.earlyRegistrationsCount],
      [
        L("Early-registration rate", "نسبة التسجيل المبكر"),
        report.timing.earlyRegistrationsRate !== null ? report.timing.earlyRegistrationsRate + "%" : L("N/A", "غير متاح"),
      ],
      [
        L("Average days before event", "متوسط عدد الأيام قبل الفعالية"),
        report.timing.avgDaysBeforeEvent !== null ? report.timing.avgDaysBeforeEvent : L("N/A", "غير متاح"),
      ],
      [
        L("Capacity filled", "نسبة امتلاء السعة"),
        report.timing.filledPercent !== null ? report.timing.filledPercent + "%" : L("No capacity limit set", "لا يوجد حد للسعة"),
      ],
    ]),
  ];
  if (report.timing.fillTimeline.length) {
    children.push(
      para(
        L(
          "Capacity fill timeline (cumulative confirmed registrations by day):",
          "مخطط امتلاء السعة (عدد التسجيلات المؤكدة التراكمي حسب اليوم):"
        )
      )
    );
    children.push(statTable(report.timing.fillTimeline.map((r) => [r.date, r.cumulativeConfirmed])));
  }

  children.push(
    heading(L("Points Awarded", "النقاط الممنوحة")),
    statTable([
      [L("Total points awarded", "إجمالي النقاط الممنوحة"), report.points.totalAwarded],
      [L("Participation points", "نقاط المشاركة"), report.points.participationTotal],
      [L("Early-registration bonus", "مكافأة التسجيل المبكر"), report.points.earlyBonusTotal],
      [L("Position bonus", "مكافأة الترتيب"), report.points.positionBonusTotal],
    ])
  );

  children.push(heading(L("Tournament Results", "نتائج البطولة")));
  if (report.tournament) {
    children.push(
      statTable([
        [L("Mode", "النوع"), report.tournament.mode === "team" ? L("Team", "فرق") : L("Individual", "فردي")],
        [
          L("Format", "النظام"),
          report.tournament.format === "groups"
            ? L("Groups", "مجموعات")
            : report.tournament.format === "casual"
            ? L("Fun session (no results tracked)", "جلسة ترفيهية (بدون نتائج)")
            : L("Knockout", "خروج المغلوب"),
        ],
        [L("Status", "الحالة"), statusLabel(report.tournament.status)],
        [L("Participants", "عدد المشاركين"), report.tournament.participantCount],
        [
          L("Winner", "الفائز"),
          report.tournament.format === "casual"
            ? L("N/A (fun session)", "غير متاح (جلسة ترفيهية)")
            : report.tournament.winnerLabel || L("Not decided yet", "لم يتحدد بعد"),
        ],
      ])
    );
    if (report.tournament.standings && report.tournament.standings.length) {
      children.push(para(L("Final standings:", "الترتيب النهائي:")));
      children.push(statTable(report.tournament.standings.map((s) => [L("Rank", "المركز") + " " + s.rank, s.label])));
    }
  } else {
    children.push(para(L("This event did not run a tournament.", "لم تُقم بطولة في هذه الفعالية.")));
  }

  const doc = new Document({
    sections: [{ properties: { page: { size: { width: 12240, height: 15840 } } }, children }],
  });
  return Packer.toBuffer(doc);
}

app.get("/api/admin/management/events/:eventId/report.docx", requireStaffRole(["management"]), async (req, res) => {
  const report = buildEventReport(req.db, Number(req.params.eventId));
  if (!report) return res.status(404).json({ error: "Event not found" });
  const lang = req.query.lang === "ar" ? "ar" : "en";
  const buffer = await buildEventReportDocx(report, lang);
  const safeName = (report.event.nameEn || "event").replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/(^-|-$)/g, "").slice(0, 60);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName || "event"}-report.docx"`);
  res.send(buffer);
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
  if (err && (/only image files/i.test(err.message || "") || /\.xlsx file/i.test(err.message || "") || /only video files/i.test(err.message || ""))) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

bootstrapAdmin();
app.listen(PORT, () => {
  console.log(`MyAhlawy points system running at http://localhost:${PORT}`);
});
