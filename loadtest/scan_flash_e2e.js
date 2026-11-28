"use strict";
// Gate scanner: the PASS / TRY AGAIN / FAILED word over the camera, beep + vibrate (and the sound switch),
// and the faster loop (no fixed wait between different members, the same QR is not sent twice).
// A fake camera draws real member QR codes, so the whole path (frame -> decode -> /api/checkin -> overlay) runs.
// Usage (fresh server, empty data dir): BASE_URL=http://localhost:3951 node loadtest/scan_flash_e2e.js
const { chromium } = require("/opt/node-tools/node_modules/playwright");
const QRCode = require("qrcode");
const BASE = process.env.BASE_URL || "http://localhost:3951";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) pass++; else { fail++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };
const section = (s) => console.log("\n=== " + s + " ===");

function applySetCookies(jar, res) {
  const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const raw of sc) { const [pair] = raw.split(";"); const i = pair.indexOf("="); if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
}
async function api(path, { method = "GET", body, jar = {}, form } = {}) {
  const headers = {};
  const ck = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (ck) headers.Cookie = ck;
  if (method !== "GET" && jar.csrfToken) headers["X-CSRF-Token"] = jar.csrfToken;
  let b;
  if (form) b = form; else if (body !== undefined) { headers["Content-Type"] = "application/json"; b = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: b, redirect: "manual" });
  applySetCookies(jar, res);
  let json = null; try { json = await res.json(); } catch (e) { /* none */ }
  return { status: res.status, json };
}
const prime = async (jar) => { await api("/", { jar }); return jar; };
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
const stamp = Date.now().toString(36);

// Runs in the page before anything else: a fake camera (a canvas stream) that shows whatever QR we hand it,
// plus counters for vibrate() and oscillators so the sound/vibration can be checked.
const FAKE_CAMERA = () => {
  window.__img = null; window.__vib = []; window.__osc = 0;
  window.__showQr = (url) => { if (!url) { window.__img = null; return; } const i = new Image(); i.onload = () => { window.__img = i; }; i.src = url; };
  const cv = document.createElement("canvas"); cv.width = 1280; cv.height = 720;
  const c2 = cv.getContext("2d");
  setInterval(() => {
    c2.fillStyle = "#fff"; c2.fillRect(0, 0, 1280, 720);
    if (window.__img) c2.drawImage(window.__img, 440, 160, 400, 400);
  }, 33);
  const stream = cv.captureStream(30);
  navigator.mediaDevices.getUserMedia = async () => stream;
  navigator.vibrate = (p) => { window.__vib.push(p); return true; };
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) { const orig = AC.prototype.createOscillator; AC.prototype.createOscillator = function () { window.__osc++; return orig.call(this); }; }
};
// Emulates the phone's own barcode reader using jsQR, to exercise the BarcodeDetector code path.
const FAKE_DETECTOR = () => {
  window.BarcodeDetector = class {
    constructor() {}
    async detect(video) {
      const c = document.createElement("canvas"); c.width = video.videoWidth; c.height = video.videoHeight;
      const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(video, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height);
      const r = jsQR(d.data, d.width, d.height);
      return r ? [{ rawValue: r.data }] : [];
    }
  };
};

(async () => {
  const admin = await prime({});
  ok((await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } })).status === 200, "admin login");
  const f = new FormData(); f.set("nameEn", "Scan Flash " + stamp); f.set("nameAr", "scan"); f.set("sport", "Chess"); f.set("date", today);
  const evR = await api("/api/events", { method: "POST", jar: admin, form: f });
  const eventId = evR.json.id;
  ok(!!eventId, "event created");
  const names = ["Scan Aly", "Scan Basma", "Scan Chris", "Scan Dina"];
  for (let i = 0; i < 4; i++) {
    const jar = await prime({});
    await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: `SF${stamp}${i}`, name: names[i], password: "abc12345", phone: `0100${String(i + 1).padStart(7, "0")}`, agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
    const r = await api("/api/register", { method: "POST", jar, body: { eventId } });
    ok(r.status === 200 || r.status === 201, "register " + names[i], r.json);
  }
  const roster = (await api(`/api/staff/events/${eventId}/roster`, { jar: admin })).json;
  const qr = (name) => roster.find((r) => r.attendeeName === name).qrDataUrl;
  const bad = (txt) => QRCode.toDataURL(txt, { margin: 1, width: 300 });

  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  async function openScanner(extraInit) {
    const ctx = await browser.newContext({ viewport: { width: 700, height: 1000 } });
    await ctx.addInitScript(FAKE_CAMERA);
    if (extraInit) await ctx.addInitScript(extraInit);
    const page = await ctx.newPage(); const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error" && !/ERR_TUNNEL|Failed to load resource/.test(m.text())) errs.push(m.text()); });
    await page.goto(BASE + "/"); await page.waitForTimeout(500);
    await page.click('[data-view="scan"]');
    const inputs = await page.locator("#scan-lock input").all();
    await inputs[0].fill(ADMIN_USER); await inputs[1].fill(ADMIN_PASS);
    await page.click("#scan-unlock"); await page.waitForTimeout(1200);
    await page.selectOption("#checkin-event-select", String(eventId)); await page.waitForTimeout(600);
    await page.click("#scan-start"); await page.waitForTimeout(500);
    return { ctx, page, errs };
  }
  // Shows a QR to the camera and waits for the overlay; returns {ms, kind, word, name, detail}.
  async function present(page, dataUrl, timeout = 4000) {
    await page.evaluate(() => { document.getElementById("scan-flash").classList.add("hidden"); document.getElementById("scan-flash").dataset.kind = ""; });
    const t0 = Date.now();
    await page.evaluate((u) => window.__showQr(u), dataUrl);
    try { await page.waitForFunction(() => { const b = document.getElementById("scan-flash"); return !b.classList.contains("hidden") && b.dataset.kind; }, null, { timeout }); } catch (e) { return { ms: -1 }; }
    const ms = Date.now() - t0;
    return page.evaluate((m) => ({ ms: m, kind: document.getElementById("scan-flash").dataset.kind, word: document.getElementById("scan-flash-word").textContent, name: document.getElementById("scan-flash-name").textContent, detail: document.getElementById("scan-flash-detail").textContent }), ms);
  }

  section("Software decoder (jsQR) path");
  {
    const { ctx, page, errs } = await openScanner();
    ok(await page.evaluate(() => SCAN_DETECTOR === null), "no native detector here, jsQR is used");
    let r = await present(page, qr("Scan Aly"));
    ok(r.kind === "pass" && r.word === "PASS" && r.name === "Scan Aly", "PASS with the member's name", r);
    ok(/points awarded/.test(r.detail), "points shown under the name", r.detail);
    ok(r.ms > 0 && r.ms < 2500, "first scan is quick", r.ms);
    ok((await page.evaluate(() => window.__vib)).length >= 1, "phone vibrates on PASS");
    ok((await page.evaluate(() => window.__osc)) >= 2, "two beep notes on PASS");
    await page.screenshot({ path: "/tmp/scan_pass.png" });
    // a different member straight away: there is no fixed waiting time any more
    r = await present(page, qr("Scan Basma"));
    ok(r.kind === "pass" && r.name === "Scan Basma", "next member scans immediately", r);
    ok(r.ms > 0 && r.ms < 1500, "no 2.5 second lock between different members", r.ms);
    // the same QR again: refused as already checked in
    r = await present(page, qr("Scan Aly"), 7000);
    ok(r.kind === "fail" && r.word === "FAILED" && /Already checked in/.test(r.detail) && r.name === "Scan Aly", "already used -> FAILED with the reason", r);
    await page.screenshot({ path: "/tmp/scan_fail.png" });
    const osc0 = await page.evaluate(() => window.__osc);
    // a QR that is not ours
    r = await present(page, await bad("not-a-member-code"));
    ok(r.kind === "fail" && r.word === "FAILED" && r.detail.length > 3, "unknown code -> FAILED with the error", r);
    ok((await page.evaluate(() => window.__osc)) > osc0, "buzz on FAILED");
    // network drop -> TRY AGAIN, then the same QR passes once the network is back
    let abort = true;
    await page.route("**/api/checkin", (route) => (abort ? route.abort() : route.continue()));
    r = await present(page, qr("Scan Chris"));
    ok(r.kind === "retry" && r.word === "TRY AGAIN", "network problem -> TRY AGAIN", r);
    await page.screenshot({ path: "/tmp/scan_retry.png" });
    abort = false;
    await page.waitForTimeout(2000);
    await page.evaluate(() => { document.getElementById("scan-flash").dataset.kind = ""; });
    await page.waitForFunction(() => document.getElementById("scan-flash").dataset.kind === "pass", null, { timeout: 5000 }).catch(() => {});
    ok(await page.evaluate(() => document.getElementById("scan-flash-name").textContent) === "Scan Chris", "same QR passes after the retry");
    // waiting list answer
    await page.route("**/api/checkin", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "This registration is on the waiting list, not a confirmed spot", attendeeName: "Wait Lister" }) }));
    r = await present(page, await bad("waitlist-sample"));
    ok(r.kind === "fail" && r.name === "Wait Lister" && /waiting list/i.test(r.detail), "waiting list -> FAILED with the reason", r);
    // server busy (500) -> TRY AGAIN
    await page.route("**/api/checkin", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
    r = await present(page, await bad("busy-sample"));
    ok(r.kind === "retry", "server busy -> TRY AGAIN", r);
    await page.unroute("**/api/checkin");
    // sound switch
    await page.evaluate(() => { window.__vib.length = 0; window.__osc = 0; });
    await page.locator("#scan-sound").uncheck();
    r = await present(page, await bad("silent-sample"));
    ok(r.kind === "fail", "overlay still shows with sound off");
    ok((await page.evaluate(() => window.__vib.length)) === 0 && (await page.evaluate(() => window.__osc)) === 0, "no sound or vibration with the switch off");
    ok(await page.evaluate(() => localStorage.getItem("scanSound")) === "0", "choice remembered");
    await page.locator("#scan-sound").check();
    // Arabic
    await page.evaluate(() => setLang("ar")); await page.waitForTimeout(400);
    r = await present(page, await bad("arabic-sample"));
    ok(r.word === "مرفوض", "FAILED word in Arabic", r);
    await page.screenshot({ path: "/tmp/scan_fail_ar.png" });
    // the overlay fades by itself
    await page.waitForTimeout(2600);
    ok(await page.evaluate(() => document.getElementById("scan-flash").classList.contains("hidden")), "overlay clears by itself");
    // stop camera hides it
    await page.click("#scan-stop");
    ok(errs.length === 0, "no page errors (jsQR path)", errs);
    await ctx.close();
  }
  const after = (await api(`/api/staff/events/${eventId}/roster`, { jar: admin })).json;
  ok(["Scan Aly", "Scan Basma", "Scan Chris"].every((n) => after.find((r) => r.attendeeName === n).checkedIn), "the three scanned members are checked in on the server");
  ok(!after.find((r) => r.attendeeName === "Scan Dina").checkedIn, "the fourth is not");

  section("Phone's own barcode reader path");
  {
    const { ctx, page, errs } = await openScanner(FAKE_DETECTOR);
    ok(await page.evaluate(() => SCAN_DETECTOR !== null), "native detector is picked up");
    const r = await present(page, qr("Scan Dina"));
    ok(r.kind === "pass" && r.name === "Scan Dina", "PASS through the native detector", r);
    ok(errs.length === 0, "no page errors (native path)", errs);
    await ctx.close();
  }
  await browser.close();
  console.log(`\npassed ${pass} failed ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
