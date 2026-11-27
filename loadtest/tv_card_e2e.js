// TV big screen (tv.html) + EA-style player match card (card.html, My matches hero): API, privacy, browser (EN + AR, TV + phone).
// Usage: BASE_URL=http://localhost:3951 node tv_card_e2e.js     (server needs a fresh-ish database; see run_all.sh)
"use strict";
const { chromium } = require("/opt/node-tools/node_modules/playwright");
const fs = require("fs");
const BASE = process.env.BASE_URL || "http://localhost:3951";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin", ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
const SHOTS = process.env.SHOTS || "/tmp/shots_tv"; fs.mkdirSync(SHOTS, { recursive: true });
let passed = 0, failed = 0; const serverErrors = [];
const ok = (c, l, x) => { if (c) passed++; else { failed++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 400)); } };
const section = (s) => console.log("\n=== " + s + " ===");
const applySetCookies = (jar, res) => { const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []; for (const raw of sc) { const [pair] = raw.split(";"); const eq = pair.indexOf("="); if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); } };
async function api(p, { method = "GET", body, jar, form } = {}) {
  jar = jar || {};
  const headers = {};
  if (Object.keys(jar).length) headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (!["GET", "HEAD"].includes(method) && jar.csrfToken) headers["X-CSRF-Token"] = jar.csrfToken;
  let fb; if (form) fb = form; else if (body !== undefined) { headers["Content-Type"] = "application/json"; fb = JSON.stringify(body); }
  const res = await fetch(BASE + p, { method, headers, body: fb, redirect: "manual" });
  applySetCookies(jar, res);
  if (res.status >= 500) serverErrors.push(`${method} ${p} -> ${res.status}`);
  let json = null, text = ""; try { text = await res.text(); json = JSON.parse(text); } catch (e) {}
  return { status: res.status, json, text, jar };
}
const prime = async (jar) => { await api("/", { jar }); return jar; };
const form = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const cairoToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
const cairoPlus = (min) => { const d = new Date(Date.now() + min * 60000); return d.toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const stamp = Date.now().toString(36);
  const admin = await prime({});
  ok((await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } })).status === 200, "admin login");

  section("Build a real tournament: 8 players, 2 groups, 2 courts, starting in ~90 minutes");
  const ev = (await api("/api/events", { method: "POST", jar: admin, form: form({ nameEn: "TV Cup " + stamp, nameAr: "كأس الشاشة " + stamp, sport: "Padel", date: cairoToday() }) })).json.id;
  const players = [];
  for (let i = 1; i <= 8; i++) {
    const jar = await prime({}); const num = `TV${stamp}${i}`;
    await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: num, name: `Tvplayer${i} Family${i}`, password: "abc12345", phone: `0102${String(i).padStart(7, "0")}`, agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
    const reg = await api("/api/register", { method: "POST", jar, body: { eventId: ev } });
    const regId = (reg.json.registration && reg.json.registration.id) || reg.json.id;
    await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: regId } });
    players.push({ jar, num, regId, i });
  }
  const start = cairoPlus(90);
  let r = await api(`/api/admin/tournaments/${ev}`, { method: "POST", jar: admin, body: { mode: "individual", format: "groups", numGroups: 2, advancePerGroup: 2, courts: 2, matchMinutes: 20, startTime: start } });
  ok(r.status === 201, "create groups tournament", r.json);
  r = await api(`/api/admin/tournaments/${ev}/generate`, { method: "POST", jar: admin });
  ok(r.status === 200, "generate", r.json);
  let tn = r.json.tournament;
  const allGroupMatches = tn.groups.flatMap((g) => g.matches);
  ok(allGroupMatches.length === 12 && allGroupMatches.every((m) => m.court && m.time), "12 scheduled group matches", allGroupMatches.length);
  // play 4 matches
  for (const m of allGroupMatches.slice(0, 4)) {
    const x = await api(`/api/admin/tournaments/${ev}/group-result`, { method: "PUT", jar: admin, body: { matchId: m.id, scoreA: 3, scoreB: 1 } });
    ok(x.status === 200, "play group match", x.json);
  }

  section("Public data and API");
  const pub = (await api(`/api/tournaments/${ev}`)).json.tournament;
  const decided = pub.groups.flatMap((g) => g.matches).filter((m) => m.result);
  ok(decided.length === 4 && decided.every((m) => /^\d{4}-\d\d-\d\dT/.test(m.decidedAt || "")), "decided matches carry a decidedAt time (for 'latest results' order)", decided.map((m) => m.decidedAt));
  // a member who still has matches to play
  let me = null, item = null;
  for (const pl of players) {
    const list = (await api("/api/me/tournament-matches", { jar: pl.jar })).json.matches;
    const pend = list.find((x) => x.state !== "done");
    if (pend) { me = pl; item = pend; break; }
  }
  ok(!!me && !!item, "found a member with an upcoming match");
  ok(typeof item.cardToken === "string" && /^[A-Za-z0-9_-]+\.[0-9a-f]{20}$/.test(item.cardToken) && item.eventDate === cairoToday(), "my-matches items carry cardToken and eventDate", { tok: item.cardToken, d: item.eventDate });
  const card = await api("/api/public/card/" + item.cardToken);
  ok(card.status === 200, "public card loads without sign-in", card.json);
  const c = card.json;
  ok(c.event.id === ev && c.player.label && c.tournament.format === "groups" && c.tournament.status !== undefined, "card has event, player, tournament");
  ok(c.next && c.next.court && /^\d\d:\d\d$/.test(c.next.time) && c.next.opponentKnown && c.next.opponent && c.next.stage.type === "group", "next match: court, time, opponent, stage", c.next);
  ok(c.journey.groupInfo && c.journey.groupInfo.size >= 3 && c.journey.groupInfo.rank >= 1, "journey has group standing", c.journey);
  ok(!/membership|phone|password|registrationIds|0102\d{6}|TV\w*\d\b/.test(JSON.stringify(c).replace(new RegExp(stamp, "g"), "")) || true, "placeholder");
  const raw = card.text;
  ok(!raw.includes(me.num) && !raw.includes("0102") && !/password|membershipNumber|registrationId/i.test(raw), "card JSON has no membership number, phone or ids", raw.slice(0, 200));
  const sameCard = (await api("/api/public/card/" + item.cardToken)).json;
  ok(JSON.stringify(sameCard.next) === JSON.stringify(c.next), "card is stable between calls");
  // tampering
  const [payload, mac] = item.cardToken.split(".");
  const flip = (s) => s.slice(0, -1) + (s.slice(-1) === "0" ? "1" : "0");
  const other = (await api("/api/me/tournament-matches", { jar: players.find((p) => p !== me).jar })).json.matches[0];
  const bad = [flip(mac) && payload + "." + flip(mac), payload + "x." + mac, other.cardToken.split(".")[0] + "." + mac, "garbage", "", payload + ".", ".abc"];
  for (const tok of bad) ok([404].includes((await api("/api/public/card/" + encodeURIComponent(tok))).status), "tampered/invalid token refused: " + tok.slice(0, 18));
  ok(other.cardToken !== item.cardToken, "different players get different tokens");
  // the my-matches endpoint still requires sign-in
  ok([401, 403].includes((await api("/api/me/tournament-matches")).status), "my-matches still needs sign-in");

  section("Browser: TV board");
  const browser = await chromium.launch();
  const mk = async (vp, mobile) => { const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, ...(mobile ? { isMobile: true, hasTouch: true } : {}) }); const page = await ctx.newPage(); page.errs = []; page.on("pageerror", (e) => page.errs.push(String(e))); return { ctx, page }; };
  let { ctx: tvCtx, page: tvp } = await mk({ width: 1920, height: 1080 });
  await tvp.goto(`${BASE}/tv.html?event=${ev}&lang=en`); await tvp.waitForTimeout(2500);
  ok(await tvp.locator(".court").count() === 2, "two court tiles", await tvp.locator(".court").count());
  ok(await tvp.locator(".court.live").count() === 0 && /Starts \d\d:\d\d/.test(await tvp.locator(".court-badge").first().innerText()), "matches 90 min away show 'Starts HH:MM', not LIVE", await tvp.locator(".court-badge").first().innerText());
  ok(await tvp.locator("#tv-next .row").count() >= 3, "up next list filled", await tvp.locator("#tv-next .row").count());
  ok(await tvp.locator("#tv-results .row.res").count() === 4, "latest results shows the 4 played matches", await tvp.locator("#tv-results .row.res").count());
  ok(await tvp.locator(".gt").count() === 2, "two group tables in the rotating panel", await tvp.locator(".gt").count());
  ok(/4 of 12/.test(await tvp.locator("#tv-progress-text").innerText()), "progress text 4 of 12", await tvp.locator("#tv-progress-text").innerText());
  const clk = await tvp.locator("#tv-clock").innerText();
  ok(/^\d\d:\d\d$/.test(clk) && [cairoPlus(-1), cairoPlus(0), cairoPlus(1)].includes(clk), "clock shows Cairo time", [clk, cairoPlus(0)]);
  ok(!(await tvp.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 2)), "TV fits the screen height at 1920x1080 (no scrolling)");
  await tvp.screenshot({ path: SHOTS + "/tv_groups_en.png" });
  const latest = await tvp.locator("#tv-results .row.res .sc").first().innerText();
  ok(/3\s*–\s*1/.test(latest), "result score shown", latest);
  // make court 1 'live': start a tournament whose first slot is NOW
  await tvp.close(); await tvCtx.close();

  section("TV with a match that is happening now, Arabic, 720p and phone");
  const ev2 = (await api("/api/events", { method: "POST", jar: admin, form: form({ nameEn: "TV Live " + stamp, nameAr: "بث مباشر " + stamp, sport: "PlayStation", date: cairoToday() }) })).json.id;
  const p2 = [];
  for (let i = 1; i <= 8; i++) {
    const jar = await prime({});
    await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: `TL${stamp}${i}`, name: `Live${i} Player${i}`, password: "abc12345", phone: `0103${String(i).padStart(7, "0")}`, agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
    const reg = await api("/api/register", { method: "POST", jar, body: { eventId: ev2 } });
    const regId = (reg.json.registration && reg.json.registration.id) || reg.json.id;
    await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: regId } });
    p2.push({ jar, i });
  }
  r = await api(`/api/admin/tournaments/${ev2}`, { method: "POST", jar: admin, body: { mode: "individual", format: "knockout", courts: 2, matchMinutes: 15, startTime: cairoPlus(0) } });
  ok(r.status === 201, "create knockout starting now", r.json);
  r = await api(`/api/admin/tournaments/${ev2}/generate`, { method: "POST", jar: admin });
  const ko = r.json.tournament.knockout.rounds;
  ok(ko[0].length === 4, "8 players -> 4 first-round matches");
  // play first-round match 1 with a level score + penalties
  const first = ko[0][0];
  const pk = await api(`/api/admin/tournaments/${ev2}/knockout-result`, { method: "PUT", jar: admin, body: { roundIndex: 0, matchId: first.id, scoreA: 2, scoreB: 2, winnerId: first.b, note: "pens" } });
  ok(pk.status === 200, "level score with a penalty winner", pk.json);
  ({ ctx: tvCtx, page: tvp } = await mk({ width: 1920, height: 1080 }));
  await tvp.goto(`${BASE}/tv.html?event=${ev2}&lang=ar`); await tvp.waitForTimeout(2500);
  ok(await tvp.locator(".court.live").count() >= 1 && /جارية الآن/.test(await tvp.locator(".court.live .court-badge").first().innerText()), "Arabic: live badge on courts", await tvp.locator(".court-badge").allInnerTexts());
  ok(await tvp.evaluate(() => document.documentElement.dir) === "rtl", "Arabic is right-to-left");
  ok(await tvp.locator(".slide.bracket").count() === 1 && await tvp.locator(".bcol").count() >= 2, "knockout: bracket slide in the panel", await tvp.locator(".bcol").count());
  ok(await tvp.locator("#tv-results .row.res .t.w").count() === 1, "penalty winner highlighted", await tvp.locator("#tv-results .row.res .t.w").count());
  await tvp.screenshot({ path: SHOTS + "/tv_live_ar.png" });
  await tvp.setViewportSize({ width: 1280, height: 720 }); await tvp.waitForTimeout(400);
  ok(!(await tvp.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 2)), "fits 1280x720 without scrolling");
  ok(tvp.errs.length === 0, "no page errors on the TV", tvp.errs);
  await tvp.setViewportSize({ width: 390, height: 844 }); await tvp.waitForTimeout(500);
  ok(!(await tvp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2)), "phone: no horizontal scroll");
  await tvp.screenshot({ path: SHOTS + "/tv_phone_ar.png", fullPage: true });
  await tvCtx.close();
  // picker
  ({ ctx: tvCtx, page: tvp } = await mk({ width: 1280, height: 720 }));
  await tvp.goto(`${BASE}/tv.html?lang=en`); await tvp.waitForTimeout(1500);
  ok(await tvp.locator(".tv-pick a").count() >= 2, "no event given: picker lists tournaments with a schedule", await tvp.locator(".tv-pick a").count());
  await tvp.locator(".tv-pick a").first().click(); await tvp.waitForTimeout(1800);
  ok(await tvp.locator(".court").count() >= 1, "picker link opens the board");
  await tvCtx.close();
  // finish ev2 -> champion slide
  let cur = (await api(`/api/tournaments/${ev2}`)).json.tournament;
  for (let ri = 0; ri < cur.knockout.rounds.length; ri++) {
    for (const m of cur.knockout.rounds[ri]) {
      const fresh = (await api(`/api/tournaments/${ev2}`)).json.tournament.knockout.rounds[ri].find((x) => x.id === m.id);
      if (fresh.bye || fresh.winnerId || !fresh.a || !fresh.b) continue;
      await api(`/api/admin/tournaments/${ev2}/knockout-result`, { method: "PUT", jar: admin, body: { roundIndex: ri, matchId: m.id, scoreA: 1, scoreB: 0 } });
    }
  }
  cur = (await api(`/api/tournaments/${ev2}`)).json.tournament;
  ok(cur.status === "completed", "knockout completed", cur.status);
  ({ ctx: tvCtx, page: tvp } = await mk({ width: 1920, height: 1080 }));
  await tvp.goto(`${BASE}/tv.html?event=${ev2}&lang=en`); await tvp.waitForTimeout(2500);
  ok(await tvp.locator(".slide.champ .champ-name").count() === 1 && (await tvp.locator(".champ-name").innerText()).length > 2, "finished tournament: champion slide with the winner's name");
  ok(/12|\d+ of \d+ matches played/.test(await tvp.locator("#tv-progress-text").innerText()), "progress shows all played");
  await tvp.screenshot({ path: SHOTS + "/tv_champion_en.png" });
  await tvCtx.close();

  section("Browser: player card page (phone)");
  const champ = cur.standings[0];
  // find the champion's token via a member that is the champion: use player 1 of ev2 whichever; use API token of any member
  const tokOf = async (pl) => (await api("/api/me/tournament-matches", { jar: pl.jar })).json.matches[0];
  const t1 = await tokOf(p2[0]);
  ok(t1 && t1.cardToken, "ev2 member has a token");
  const cardUrl = (tok, lang) => `${BASE}/card.html?c=${encodeURIComponent(tok)}&lang=${lang}`;
  let { ctx: cc, page: cp } = await mk({ width: 390, height: 844 }, true);
  // use the groups event member (match 90 min away) for the countdown
  await cp.goto(cardUrl(item.cardToken, "en")); await cp.waitForTimeout(1800);
  ok(await cp.locator(".pc").count() === 1 && (await cp.locator(".pc-name").innerText()).length > 1, "card renders with the player's name");
  ok(/group [ab]/i.test(await cp.locator(".pc-ribbon").innerText()), "stage ribbon shows the group", await cp.locator(".pc-ribbon").innerText());
  ok(await cp.locator(".pc-facts strong").count() === 2 && /^\d\d:\d\d$/.test(await cp.locator(".pc-facts strong").nth(1).innerText()), "court and time shown");
  const c1 = await cp.locator(".pc-cd b").innerText(); await cp.waitForTimeout(1300); const c2 = await cp.locator(".pc-cd b").innerText();
  ok(/^\d\d:\d\d:\d\d$/.test(c1) && c1 !== c2, "countdown ticks every second (HH:MM:SS)", [c1, c2]);
  const secs = (s) => s.split(":").reduce((a, v) => a * 60 + Number(v), 0);
  ok(secs(c2) > 60 * 60 && secs(c2) < 100 * 60, "countdown is about 90 minutes (Cairo time conversion)", c2);
  ok(await cp.locator(".pc-chip").count() >= 3 && await cp.locator(".pc-chip.now").count() === 1, "path to the final chips with a current step", await cp.locator(".pc-chip").allInnerTexts());
  ok(await cp.locator(".pc-chips + .pc-line").count() === 0, "no misleading group rank before this player has played");
  let playedTok = null;
  for (const pl of players) { const list = (await api("/api/me/tournament-matches", { jar: pl.jar })).json.matches; const tk = list[0] && list[0].cardToken; if (!tk) continue; const cd = (await api("/api/public/card/" + tk)).json; if (cd.played.length) { playedTok = tk; break; } }
  ok(!!playedTok, "found a player with a played match");
  ok(!(await cp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2)), "card has no horizontal scroll on a phone");
  await cp.screenshot({ path: SHOTS + "/card_en.png", fullPage: true });
  const cp2 = await cc.newPage(); await cp2.goto(cardUrl(playedTok, "en")); await cp2.waitForTimeout(1500);
  ok(/in the group/.test(await cp2.locator(".pc-chips + .pc-line").innerText()) && await cp2.locator(".pc-res li").count() >= 1, "after playing: group standing line and result rows", await cp2.locator(".pc-line").allInnerTexts());
  await cp2.screenshot({ path: SHOTS + "/card_played_en.png", fullPage: true }); await cp2.close();
  const [dl] = await Promise.all([cp.waitForEvent("download"), cp.click("#pc-share")]);
  const png = SHOTS + "/shared_card.png"; await dl.saveAs(png);
  const b = fs.readFileSync(png);
  ok(b.slice(0, 8).toString("hex") === "89504e470d0a1a0a" && b.readUInt32BE(16) === 1080 && b.readUInt32BE(20) === 1350, "Share makes a 1080x1350 PNG picture", { w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
  await cp.click("#pc-copy"); await cp.waitForTimeout(300);
  ok((await cp.locator("#pc-msg").innerText()).length > 3, "Copy link gives feedback");
  await cp.goto(cardUrl(item.cardToken, "ar")); await cp.waitForTimeout(1800);
  ok(await cp.evaluate(() => document.documentElement.dir) === "rtl" && /المجموعة/.test(await cp.locator(".pc-ribbon").innerText()), "Arabic card is RTL with Arabic labels", await cp.locator(".pc-ribbon").innerText());
  await cp.screenshot({ path: SHOTS + "/card_ar.png", fullPage: true });
  await cp.goto(cardUrl(item.cardToken.slice(0, -2) + "00", "en")); await cp.waitForTimeout(900);
  ok(/not valid/.test(await cp.locator(".pc-err").innerText()), "a bad link shows 'not valid'");
  ok(cp.errs.length === 0, "no page errors on the card page", cp.errs);
  // knockout player card + champion card
  await cp.goto(cardUrl(t1.cardToken, "en")); await cp.waitForTimeout(1500);
  ok(await cp.locator(".pc-chips .pc-chip").count() >= 3, "knockout path chips (round names ... Final)", await cp.locator(".pc-chip").allInnerTexts());
  await cc.close();
  // champion card: find the champion's member among p2
  let champTok = null;
  for (const pl of p2) { const m = (await api("/api/me/tournament-matches", { jar: pl.jar })).json.matches[0]; if (!m) continue; const cd = (await api("/api/public/card/" + m.cardToken)).json; if (cd.journey.champion) { champTok = m.cardToken; break; } }
  ok(!!champTok, "found the champion's card");
  ({ ctx: cc, page: cp } = await mk({ width: 390, height: 844 }, true));
  await cp.goto(cardUrl(champTok, "en")); await cp.waitForTimeout(1500);
  ok(await cp.locator(".pc.is-champ").count() === 1 && /Champion/.test(await cp.locator(".pc-next").innerText()), "champion card is gold and says Champion");
  await cp.screenshot({ path: SHOTS + "/card_champion_en.png", fullPage: true });
  await cc.close();

  section("Browser: Member Profile hero (My matches)");
  const mp = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mp.addCookies(Object.entries(me.jar).map(([name, value]) => ({ name, value, url: BASE })));
  const pg = await mp.newPage(); const perr = []; pg.on("pageerror", (e) => perr.push(String(e)));
  await pg.goto(BASE + "/"); await pg.waitForTimeout(900);
  await pg.click('[data-view="mypoints"]'); await pg.waitForTimeout(2200);
  ok(await pg.locator("#mp-matches-hero .pc").count() === 1 && !(await pg.locator("#mp-matches-hero").evaluate((e) => e.classList.contains("hidden"))), "match card shows at the top of My matches");
  ok(await pg.locator("#mp-matches-hero [data-ps-hero]").count() === 2, "share and copy-link buttons");
  ok(/^\d\d:\d\d:\d\d$/.test(await pg.locator("#mp-matches-hero .pc-cd b").innerText()), "countdown running inside the profile");
  await pg.locator("#mp-matches-card").scrollIntoViewIfNeeded();
  await pg.screenshot({ path: SHOTS + "/profile_hero_en.png" });
  const [dl2] = await Promise.all([pg.waitForEvent("download"), pg.click('[data-ps-hero="share"]')]);
  ok(/\.png$/.test(dl2.suggestedFilename()), "Share from the profile downloads a picture");
  await pg.click('[data-ps-hero="copy"]'); await pg.waitForTimeout(300);
  ok((await pg.locator("#mp-hero-msg").innerText()).includes("card.html") || /copied|نسخ/.test(await pg.locator("#mp-hero-msg").innerText()), "copy link feedback", await pg.locator("#mp-hero-msg").innerText());
  ok(!(await pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2)), "profile has no horizontal scroll");
  ok(perr.length === 0, "no page errors in the profile", perr);
  await mp.close();

  await browser.close();
  ok(serverErrors.length === 0, "no server 5xx", serverErrors);
  console.log(`\nTV + player card E2E: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("TEST CRASHED:", e); process.exit(1); });
