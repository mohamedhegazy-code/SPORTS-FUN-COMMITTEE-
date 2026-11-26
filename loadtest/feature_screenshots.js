// Walks through every new feature (simulation, match runner, player-reported scores, manager gating) and saves screenshots.
// Usage: BASE_URL=http://localhost:3951 node feature_screenshots.js
"use strict";
const { chromium } = require("/opt/node-tools/node_modules/playwright");
const BASE = process.env.BASE_URL || "http://localhost:3951";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const OUT = process.env.SHOTS || "/tmp/shots";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
let passed = 0, failed = 0;
const serverErrors = [];
const ok = (c, l, x) => { if (c) passed++; else { failed++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 500)); } };
const section = (s) => console.log("\n=== " + s + " ===");
const applySetCookies = (jar, res) => { const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []; for (const raw of sc) { const [pair] = raw.split(";"); const eq = pair.indexOf("="); if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); } };
async function api(path, { method = "GET", body, jar, form } = {}) {
  jar = jar || {};
  const headers = {};
  if (Object.keys(jar).length) headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (!["GET", "HEAD"].includes(method) && jar.csrfToken) headers["X-CSRF-Token"] = jar.csrfToken;
  let fb; if (form) fb = form; else if (body !== undefined) { headers["Content-Type"] = "application/json"; fb = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: fb, redirect: "manual" });
  applySetCookies(jar, res);
  if (res.status >= 500) serverErrors.push(`${method} ${path} -> ${res.status}`);
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, jar };
}
const prime = async (jar) => { await api("/", { jar }); return jar; };
const form = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const cairoToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });

(async () => {
  const stamp = Date.now().toString(36);
  const fs = require("fs"); fs.mkdirSync(OUT, { recursive: true });
  const admin = await prime({});
  ok((await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } })).status === 200, "admin login");
  const browser = await chromium.launch();
  const mkCtx = async (jar, kind) => {
    const opts = kind === "phone" ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5 };
    const ctx = await browser.newContext(opts);
    await ctx.addCookies(Object.entries(jar).map(([name, value]) => ({ name, value, url: BASE })));
    const page = await ctx.newPage(); page.errs = [];
    page.on("pageerror", (e) => page.errs.push(String(e)));
    return page;
  };
  let n = 0;
  const shot = async (target, name, opts = {}) => {
    n++;
    const file = `${OUT}/${String(n).padStart(2, "0")}_${name}.png`;
    if (typeof target.first === "function") await target.first().screenshot({ path: file });
    else await target.screenshot({ path: file, ...opts });
    console.log("  shot", file.split("/").pop());
  };
  const mkEvent = async (name, date, extra) => {
    const r = await api("/api/events", { method: "POST", jar: admin, form: form({ nameEn: name + " " + stamp, nameAr: name + "ع", sport: "Padel", date: date || cairoToday(), ...(extra || {}) }) });
    ok(r.status === 200 || r.status === 201, "event " + name, r.json); return r.json.id;
  };
  const adminTab = async (page, evId, lang) => {
    await page.goto(BASE + "/"); await page.waitForTimeout(900);
    if (lang === "ar") { await page.evaluate(() => setLang("ar")); await page.waitForTimeout(300); }
    await page.click('[data-view="admin"]'); await page.waitForTimeout(700);
    await page.click('[data-admin-tab="tournaments"]'); await page.waitForTimeout(1200);
    await page.selectOption("#tourn-event-select", String(evId)); await page.click("#tourn-load"); await page.waitForTimeout(1500);
  };
  const profile = async (page, lang) => {
    await page.goto(BASE + "/"); await page.waitForTimeout(900);
    if (lang === "ar") { await page.evaluate(() => setLang("ar")); await page.waitForTimeout(300); }
    await page.click('[data-view="mypoints"]'); await page.waitForTimeout(1300);
  };


  // players play a match through the API: one reports, the opponent confirms
  const playByPlayers = async (evId, kind, m, ri, scoreA, scoreB, winner) => {
    const pa = players[m.aLabel], pb = players[m.bLabel];
    const ref = { eventId: evId, kind, matchId: m.id, roundIndex: ri };
    const rr = await api("/api/me/tournament-matches/report", { method: "POST", jar: pa.jar, body: { ...ref, scoreA, scoreB, ...(winner ? { winner } : {}) } });
    const cc = await api("/api/me/tournament-matches/confirm", { method: "POST", jar: pb.jar, body: ref });
    ok(rr.status === 200 && cc.status === 200, `${m.aLabel} vs ${m.bLabel}: reported + confirmed`, [rr.json, cc.json]);
  };
  const adminT = async (ev) => (await api(`/api/admin/tournaments/${ev}`, { jar: admin })).json.tournament;

  // ===================================================================== 1. SIMULATION (admin, desktop)
  section("Simulation");
  const evSim = await mkEvent("ShotSim", cairoToday());
  const pS = await mkCtx(admin, "desktop");
  await adminTab(pS, evSim);
  await shot(pS.locator("#sim-card"), "simulation_practice_card");
  await pS.selectOption("#sim-mode", "dummy"); await pS.fill("#sim-players", "16"); await pS.fill("#sim-name", "Rehearsal - 16 players");
  await pS.click("#sim-create-btn"); await pS.waitForTimeout(1800);
  ok(await pS.locator("#sim-banner").isVisible(), "simulation opens with a banner");
  await shot(pS.locator("#sim-banner"), "simulation_banner");
  await pS.selectOption("#tourn-format", "groups_knockout").catch(async () => { await pS.selectOption("#tourn-format", "groups"); });
  await pS.fill("#tourn-courts", "3"); await pS.fill("#tourn-match-minutes", "20"); await pS.fill("#tourn-start-time", "10:00");
  await pS.fill("#tourn-num-groups", "4").catch(() => {}); await pS.fill("#tourn-advance-per-group", "2").catch(() => {});
  await pS.click('[data-tourn-action="create-tournament"]'); await pS.waitForTimeout(1200);
  await pS.click('[data-sim-auto="draw"]'); await pS.waitForTimeout(1500);
  await shot(pS.locator("#sim-banner"), "simulation_after_draw_with_finish_time");
  await shot(pS.locator("#rn-root"), "simulation_runner_after_draw");
  await pS.click('[data-sim-auto="stage"]'); await pS.waitForTimeout(1800);
  await shot(pS.locator("#rn-root"), "simulation_groups_played_knockout_ready");
  await pS.click('[data-sim-auto="end"]'); await pS.waitForTimeout(2000);
  await shot(pS.locator("#rn-head"), "simulation_champion");
  await pS.click("[data-sim-whatif-toggle]"); await pS.waitForTimeout(500);
  await pS.click("[data-wi-run]"); await pS.waitForTimeout(1200);
  await shot(pS.locator("#sim-banner"), "simulation_what_if_comparison");
  await pS.evaluate(() => setLang("ar")); await pS.waitForTimeout(700);
  await pS.click('[data-admin-tab="tournaments"]'); await pS.waitForTimeout(600);
  await shot(pS.locator("#sim-card"), "simulation_card_arabic");

  // ===================================================================== 2. MATCH RUNNER (phone)
  section("Match runner");
  const evRun = await mkEvent("ShotRun", cairoToday());
  const pR = await mkCtx(admin, "phone");
  await adminTab(pR, evRun);
  await pR.selectOption("#sim-mode", "dummy"); await pR.fill("#sim-players", "12"); await pR.fill("#sim-name", "Phone rehearsal");
  await pR.click("#sim-create-btn"); await pR.waitForTimeout(1800);
  await pR.selectOption("#tourn-format", "knockout");
  await pR.fill("#tourn-courts", "2"); await pR.fill("#tourn-match-minutes", "20"); await pR.fill("#tourn-start-time", "10:00");
  await pR.click('[data-tourn-action="create-tournament"]'); await pR.waitForTimeout(1200);
  await pR.click('[data-tourn-action="generate-tournament"]'); await pR.waitForTimeout(1500);
  ok(await pR.locator("#rn-root").count() === 1, "runner shown");
  await shot(pR.locator("#rn-root"), "runner_phone_to_play");
  const card = pR.locator(".rn-card.is-now").first();
  await card.locator(".rn-pick").first().tap(); await pR.waitForTimeout(250);
  await shot(pR.locator(".rn-card.is-now").first(), "runner_phone_winner_tapped_confirm");
  await pR.locator(".rn-card.is-now").first().locator('[data-rn-act="toggle-score"]').tap(); await pR.waitForTimeout(250);
  await shot(pR.locator(".rn-card.is-now").first(), "runner_phone_add_score");
  await pR.locator(".rn-card.is-now").first().locator('[data-rn-act="save-ko"]').tap(); await pR.waitForTimeout(1300);
  await shot(pR.locator("#rn-root"), "runner_phone_after_first_result");
  await pR.locator('[data-rn-view="played"]').tap(); await pR.waitForTimeout(400);
  await shot(pR.locator("#rn-root"), "runner_phone_played_tab_with_change");
  await pR.locator('[data-rn-view="bracket"]').tap(); await pR.waitForTimeout(400);
  await shot(pR.locator("#rn-root"), "runner_phone_bracket_tab");
  await pR.evaluate(() => setLang("ar")); await pR.waitForTimeout(700);
  await pR.click('[data-admin-tab="tournaments"]'); await pR.waitForTimeout(600);
  await pR.locator('[data-rn-view="play"]').tap().catch(() => {}); await pR.waitForTimeout(400);
  await shot(pR.locator("#rn-root"), "runner_phone_to_play_arabic");

  // ===================================================================== 3. PLAYER-REPORTED SCORES (knockout)
  section("Player-reported scores");
  const evK = await mkEvent("ShotPS", cairoToday());
  const players = {};
  const mkPlayer = async (tag, i) => {
    const jar = await prime({}); const num = `SH${stamp}${tag}${i}`; const name = `Player ${tag}${i}`;
    await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: num, name, password: "abc12345", phone: `0102${String(i + tag.charCodeAt(0)).padStart(7, "0")}`, agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
    return { jar, name };
  };
  const reg = async (p, ev) => { await api("/api/register", { method: "POST", jar: p.jar, body: { eventId: ev } }); };
  const roster = [];
  for (let i = 1; i <= 4; i++) { const p = await mkPlayer("K", i); roster.push(p); await reg(p, evK); players[p.name] = p; }
  // rename labels to readable ones after the fact is not possible; the labels are the member names above.
  let r = await api(`/api/admin/tournaments/${evK}`, { method: "POST", jar: admin, body: { mode: "individual", format: "knockout", courts: 2, matchMinutes: 15, startTime: "18:00" } });
  r = await api(`/api/admin/tournaments/${evK}/generate`, { method: "POST", jar: admin });
  ok(r.status === 200, "knockout generated", r.json);
  const [m0, m1] = r.json.tournament.knockout.rounds[0];
  const A = players[m0.aLabel], B = players[m0.bLabel], C = players[m1.aLabel], D = players[m1.bLabel];

  const pA = await mkCtx(A.jar, "phone");
  await profile(pA);
  await shot(pA.locator("#mp-matches-card"), "player_schedule_score_entry_off");
  const pM = await mkCtx(admin, "phone");
  await adminTab(pM, evK);
  await shot(pM.locator(".ps-switch"), "manager_switch_off");
  await pM.locator('[data-ps-mgr="toggle"]').tap(); await pM.waitForTimeout(1300);
  await shot(pM.locator(".ps-switch"), "manager_switch_on");

  await profile(pA);
  await shot(pA.locator("#mp-matches-card"), "player_my_matches_enter_score");
  let c = pA.locator(".ps-card.ps-to_report").first();
  for (let i = 0; i < 3; i++) await c.locator('[data-ps-act="inc"][data-ps-who="me"]').tap();
  await c.locator('[data-ps-act="inc"][data-ps-who="opp"]').tap(); await pA.waitForTimeout(250);
  await shot(pA.locator(".ps-card.ps-to_report").first(), "player_score_entered_3_1");
  await pA.locator(".ps-card.ps-to_report").first().locator('[data-ps-act="send"]').tap(); await pA.waitForTimeout(1500);
  await shot(pA.locator("#mp-matches-card"), "player_waiting_for_opponent_take_back");

  const pB = await mkCtx(B.jar, "phone");
  await profile(pB);
  await shot(pB.locator("nav.tabs"), "opponent_tab_badge_one_to_confirm");
  await shot(pB.locator(".ps-card.ps-to_confirm").first(), "opponent_confirm_or_dispute");
  await pB.locator('[data-ps-act="dispute"]').tap(); await pB.waitForTimeout(250);
  await pB.locator(".ps-note").fill("I won 3-2, we played to 3 points.");
  await shot(pB.locator(".ps-card.ps-to_confirm").first(), "opponent_dispute_note");
  await pB.locator('[data-ps-act="dispute-send"]').tap(); await pB.waitForTimeout(1500);
  await shot(pB.locator("#mp-matches-card"), "opponent_disputed_waits_for_manager");

  await adminTab(pM, evK);
  await shot(pM.locator("#rn-root"), "manager_needs_attention_disputed_prefilled");
  await pM.locator(".rn-card.has-report").first().locator('[data-rn-act="save-ko"]').tap(); await pM.waitForTimeout(1500);
  await shot(pM.locator("#rn-root"), "manager_after_override_result_saved");
  await profile(pB);
  await shot(pB.locator("#mp-matches-card"), "player_final_result_and_winner");

  // tie -> who won (penalties) + confirm in Arabic
  const pC = await mkCtx(C.jar, "phone"), pD = await mkCtx(D.jar, "phone");
  await profile(pC);
  c = pC.locator(".ps-card.ps-to_report").first();
  await c.locator('[data-ps-act="inc"][data-ps-who="me"]').tap(); await c.locator('[data-ps-act="inc"][data-ps-who="opp"]').tap(); await pC.waitForTimeout(250);
  await shot(pC.locator(".ps-card.ps-to_report").first(), "player_level_score_who_won_penalties");
  await pC.locator('[data-ps-act="winner"][data-ps-who="me"]').tap(); await pC.waitForTimeout(200);
  await pC.locator(".ps-card.ps-to_report").first().locator('[data-ps-act="send"]').tap(); await pC.waitForTimeout(1500);
  await profile(pD, "ar");
  await shot(pD.locator("#mp-matches-card"), "player_confirm_screen_arabic");
  await pD.locator('[data-ps-act="confirm"]').tap(); await pD.waitForTimeout(1500);
  await shot(pD.locator("#mp-matches-card"), "player_confirmed_final_arabic");


  // ---- the final of the 4-player knockout: played by the two winners, up to the champion
  {
    const tk = await adminT(evK);
    const fin = tk.knockout.rounds[tk.knockout.rounds.length - 1][0];
    ok(fin.a && fin.b && !fin.winnerId, "final is ready with both finalists", fin);
    const pF1 = await mkCtx(players[fin.aLabel].jar, "phone");
    await profile(pF1);
    await shot(pF1.locator(".ps-card.ps-to_report").first(), "final_finalist_enters_score");
    await playByPlayers(evK, "ko", fin, tk.knockout.rounds.length - 1, 3, 2);
    const done = await adminT(evK);
    ok(done.status === "completed", "tournament status is completed", done.status);
    ok(done.standings && done.standings[0], "champion exists", done.standings && done.standings[0]);
    const champ = done.standings[0].label;
    await adminTab(pM, evK);
    await shot(pM.locator("#rn-head"), "knockout_completed_champion_banner_manager");
    await shot(pM.locator(".tourn-card-standings", { hasText: /standings|الترتيب/i }), "knockout_final_standings");
    const pChamp = await mkCtx(players[champ].jar, "phone");
    await profile(pChamp);
    await shot(pChamp.locator("#mp-matches-card"), "champion_player_profile_final_won");
    const pPub2 = await mkCtx({}, "phone");
    await pPub2.goto(`${BASE}/matches.html?event=${evK}&lang=en`); await pPub2.waitForTimeout(1500);
    await shot(pPub2, "public_page_knockout_completed", { fullPage: false });
    ok(!(await pPub2.locator("#screen-body").innerText()).toLowerCase().includes("up next"), "public live page: completed knockout has no 'up next'");
  }

  // public page the player is linked to
  const pPub = await mkCtx({}, "phone");
  await pPub.goto(`${BASE}/matches.html?event=${evK}&lang=en`); await pPub.waitForTimeout(1500);
  await shot(pPub, "public_schedule_page_phone_link_from_player_card", { fullPage: false });


  // ===================================================================== 6. FULL TOURNAMENT PLAYED BY PLAYERS: groups -> knockout -> champion
  section("Full tournament: groups + knockout, played by 8 players");
  const evGK = await mkEvent("ShotFull", cairoToday());
  for (let i = 1; i <= 8; i++) { const p = await mkPlayer("F", i); players[p.name] = p; await reg(p, evGK); }
  r = await api(`/api/admin/tournaments/${evGK}`, { method: "POST", jar: admin, body: { mode: "individual", format: "groups", numGroups: 2, advancePerGroup: 2, courts: 2, matchMinutes: 15, startTime: "19:00" } });
  ok(r.status === 201, "groups tournament created", r.json);
  r = await api(`/api/admin/tournaments/${evGK}/generate`, { method: "POST", jar: admin });
  ok(r.status === 200, "groups drawn", r.json);
  await api(`/api/admin/tournaments/${evGK}/player-scores`, { method: "PUT", jar: admin, body: { enabled: true } });
  const pGM = await mkCtx(admin, "phone");
  await adminTab(pGM, evGK);
  await shot(pGM.locator("#rn-root"), "full_groups_drawn_to_play");
  // every group match: reported by one player, confirmed by the other (varied scores, some draws)
  let tg = await adminT(evGK), gi = 0;
  for (const g of tg.groups) for (const m of g.matches) { gi++; await playByPlayers(evGK, "gr", m, undefined, (gi * 3) % 4, (gi * 5) % 3); }
  tg = await adminT(evGK);
  ok(tg.groups.every((g) => g.matches.every((m) => m.result)), "all group matches have official results");
  await adminTab(pGM, evGK);
  await shot(pGM.locator("#rn-head"), "full_groups_finished_generate_knockout_banner");
  const firstGroupPlayer = players[tg.groups[0].matches[0].aLabel];
  const pGP = await mkCtx(firstGroupPlayer.jar, "phone");
  await profile(pGP);
  await shot(pGP.locator("#mp-matches-card"), "full_player_group_results_history");
  await pGM.locator('[data-tourn-action="generate-knockout"]').tap(); await pGM.waitForTimeout(1800);
  await shot(pGM.locator("#rn-root"), "full_knockout_generated_semifinals");
  // knockout: play every ready match until the champion
  for (let guard = 0; guard < 10; guard++) {
    tg = await adminT(evGK);
    if (tg.status === "completed") break;
    let played = 0;
    for (let ri = 0; ri < tg.knockout.rounds.length; ri++) for (const m of tg.knockout.rounds[ri]) {
      if (m.a && m.b && !m.winnerId && !m.bye) { await playByPlayers(evGK, "ko", m, ri, 2 + (m.id % 2), 1); played++; }
    }
    if (!played) break;
  }
  tg = await adminT(evGK);
  ok(tg.status === "completed", "full tournament completed", tg.status);
  const champ2 = tg.standings[0].label;
  console.log("  champion:", champ2);
  await adminTab(pGM, evGK);
  await shot(pGM.locator("#rn-head"), "full_completed_champion_banner");
  await shot(pGM.locator(".tourn-card-standings", { hasText: /standings|الترتيب/i }), "full_final_standings_table");
  const pCh = await mkCtx(players[champ2].jar, "phone");
  await profile(pCh);
  await shot(pCh.locator("#mp-matches-card"), "full_champion_player_all_matches_done");
  await profile(pCh, "ar");
  await shot(pCh.locator("#mp-matches-card"), "full_champion_player_arabic");
  const pPub3 = await mkCtx({}, "phone");
  await pPub3.goto(`${BASE}/matches.html?event=${evGK}&lang=en`); await pPub3.waitForTimeout(1500);
  await shot(pPub3, "full_public_page_champion", { fullPage: false });
  const pubTxt = (await pPub3.locator("#screen-body").innerText()).toLowerCase();
  ok(!pubTxt.includes("up next") && pubTxt.includes(champ2.toLowerCase()), "public live page: finished tournament shows the champion, not 'up next'", pubTxt.slice(0, 120));
  const pBig = await mkCtx({}, "desktop");
  await pBig.goto(`${BASE}/screen.html?event=${evGK}&lang=en`); await pBig.waitForTimeout(2000);
  await shot(pBig, "full_big_screen_page_completed_bracket_and_winner", { fullPage: false });
  const pDesk = await mkCtx(admin, "desktop");
  await adminTab(pDesk, evGK);
  await shot(pDesk.locator(".tourn-hero").first(), "full_manager_summary_completed");

  // ===================================================================== 4. SWISS reports (manager panel)
  section("Swiss");
  const evS = await mkEvent("ShotSwiss", cairoToday());
  const sw = [];
  for (let i = 1; i <= 4; i++) { const p = await mkPlayer("S", i); sw.push(p); players[p.name] = p; await reg(p, evS); }
  await api(`/api/admin/tournaments/${evS}`, { method: "POST", jar: admin, body: { mode: "individual", format: "swiss", swissRounds: 2 } });
  r = await api(`/api/admin/tournaments/${evS}/generate`, { method: "POST", jar: admin });
  ok(r.status === 200, "swiss generated", r.json);
  await api(`/api/admin/tournaments/${evS}/player-scores`, { method: "PUT", jar: admin, body: { enabled: true } });
  const pr = r.json.tournament.swiss.rounds[0].pairings.filter((x) => x.b != null);
  const W = players[pr[0].aLabel], L = players[pr[0].bLabel];
  const pW = await mkCtx(W.jar, "phone");
  await profile(pW);
  await shot(pW.locator(".ps-card.ps-to_report").first(), "player_swiss_i_won_draw_i_lost");
  await pW.locator('[data-ps-act="res"][data-ps-res="win"]').tap(); await pW.waitForTimeout(200);
  await pW.locator(".ps-card.ps-to_report").first().locator('[data-ps-act="send"]').tap(); await pW.waitForTimeout(1500);
  await adminTab(pM, evS);
  await shot(pM.locator(".ps-attn").first(), "manager_swiss_reported_use_this_result");


  // ---- play the Swiss tournament to the end: manager accepts the first report, players do the rest, round 2, champion
  await pM.locator('.ps-attn [data-tourn-action="swiss-result"]').first().tap(); await pM.waitForTimeout(1500);
  const swissPlay = async (roundNumber) => {
    const cur = await adminT(evS);
    for (const p of cur.swiss.rounds[roundNumber - 1].pairings.filter((x) => x.b != null && x.result == null)) {
      const ref = { eventId: evS, kind: "sw", roundNumber, matchId: p.id };
      const a = await api("/api/me/tournament-matches/report", { method: "POST", jar: players[p.aLabel].jar, body: { ...ref, result: roundNumber === 1 ? "1-0" : "1/2-1/2" } });
      const b = await api("/api/me/tournament-matches/confirm", { method: "POST", jar: players[p.bLabel].jar, body: ref });
      ok(a.status === 200 && b.status === 200, `swiss R${roundNumber} ${p.aLabel} v ${p.bLabel}`, [a.json, b.json]);
    }
  };
  await swissPlay(1);
  r = await api(`/api/admin/tournaments/${evS}/swiss/next-round`, { method: "POST", jar: admin });
  ok(r.status === 200, "swiss round 2 drawn", r.json);
  await swissPlay(2);
  const swDone = await adminT(evS);
  ok(swDone.swiss.rounds.every((rd) => rd.complete) && swDone.swiss.standings.length === 4, "swiss: all rounds complete, standings ready", swDone.swiss.standings && swDone.swiss.standings.length);
  console.log("  swiss status:", swDone.status, "| winner:", swDone.swiss.standings[0].label);
  await adminTab(pM, evS);
  await shot(pM.locator(".tourn-card-standings", { hasText: /standings|الترتيب/i }), "swiss_completed_final_standings");

  // ===================================================================== 5. Tournament Manager gating
  section("Tournament manager gating");
  const mgr = "shotmgr" + stamp;
  r = await api("/api/staff/accounts", { method: "POST", jar: admin, body: { username: mgr, password: "Manager#1234", name: "Tournament Manager", role: "tournament" } });
  ok(r.status === 201, "manager account", r.json);
  const evF = await mkEvent("ShotFuture", new Date(Date.now() + 20 * 86400000).toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" }), { managerUsernames: JSON.stringify([mgr]) });
  const mjar = await prime({});
  await api("/api/auth/staff-login", { method: "POST", jar: mjar, body: { username: mgr, password: "Manager#1234" } });
  await api("/api/auth/change-password", { method: "POST", jar: mjar, body: { oldPassword: "Manager#1234", newPassword: "Manager#5678" } });
  const mj2 = await prime({});
  await api("/api/auth/staff-login", { method: "POST", jar: mj2, body: { username: mgr, password: "Manager#5678" } });
  const pT = await mkCtx(mj2, "desktop");
  await pT.goto(BASE + "/"); await pT.waitForTimeout(900);
  await pT.click('[data-view="admin"]'); await pT.waitForTimeout(700);
  await pT.click('[data-admin-tab="tournaments"]'); await pT.waitForTimeout(1500);
  const opts = await pT.$$eval("#tourn-event-select option", (o) => o.map((x) => x.value));
  if (opts.includes(String(evF))) { await pT.selectOption("#tourn-event-select", String(evF)); await pT.click("#tourn-load"); await pT.waitForTimeout(1200); }
  const gated = await pT.locator(".sim-not-open").count();
  ok(gated === 1 || opts.length === 0, "manager sees the not-open message for a future event (or no events)", { opts, gated });
  if (gated) await shot(pT.locator("#tourn-body"), "tournament_manager_event_not_open_yet");
  await shot(pT.locator("#sim-card"), "tournament_manager_can_still_rehearse");

  const errs = [pS, pR, pA, pM, pB, pC, pD, pW, pT, pGM, pGP, pCh, pDesk].flatMap((p) => p.errs);
  ok(errs.length === 0, "no page errors while capturing", errs);
  ok(serverErrors.length === 0, "no 5xx", serverErrors);
  await browser.close();
  console.log(`\nfeature_screenshots: ${n} screenshots, ${passed} checks passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
