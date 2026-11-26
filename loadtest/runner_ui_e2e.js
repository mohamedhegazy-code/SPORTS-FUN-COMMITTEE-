// Phone-size UI test of the match runner (Matches & Scores) inside a simulation.
const { chromium } = require("/opt/node-tools/node_modules/playwright");
const BASE = process.env.BASE_URL || "http://localhost:3951";
const ADMIN = { username: "e2eadmin", password: "E2ETest!2026xyz" };
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) pass++; else { fail++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };
const cairo = (n = 0) => new Date(Date.now() + n * 86400000).toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage(); const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  const tok = async () => { const k = (await ctx.cookies()).find((x) => x.name === "csrfToken"); return k ? k.value : ""; };
  await ctx.request.get(BASE + "/");
  ok((await ctx.request.post(BASE + "/api/auth/staff-login", { data: ADMIN, headers: { "X-CSRF-Token": await tok() } })).ok(), "login");
  const stamp = Date.now().toString(36);
  const mk = async (name) => (await (await ctx.request.post(BASE + "/api/events", { multipart: { nameEn: name + stamp, nameAr: name, sport: "Chess", date: cairo(3), maxCapacity: "16" }, headers: { "X-CSRF-Token": await tok() } })).json());
  const evK = await mk("RunnerKO"), evG = await mk("RunnerLG");
  await page.goto(BASE + "/"); await page.waitForTimeout(900);
  await page.click('[data-view="admin"]'); await page.waitForTimeout(600);
  await page.click('[data-admin-tab="tournaments"]'); await page.waitForTimeout(1200);

  async function newSim(eventId, players, form) {
    await page.selectOption("#tourn-event-select", String(eventId)); await page.waitForTimeout(400);
    await page.selectOption("#sim-mode", "dummy"); await page.fill("#sim-players", String(players));
    await page.click("#sim-create-btn"); await page.waitForTimeout(1500);
    await page.selectOption("#tourn-format", form.format);
    if (form.finals) await page.selectOption("#tourn-finals-mode", form.finals).catch(() => {});
    await page.fill("#tourn-courts", "2"); await page.fill("#tourn-match-minutes", "20"); await page.fill("#tourn-start-time", "10:00");
    if (form.groups) { await page.fill("#tourn-num-groups", String(form.groups)); await page.fill("#tourn-advance-per-group", "2"); }
    await page.click('[data-tourn-action="create-tournament"]'); await page.waitForTimeout(1000);
    await page.click('[data-tourn-action="generate-tournament"]'); await page.waitForTimeout(1200);
  }

  // ---------------- knockout, 8 players
  await newSim(evK.id, 8, { format: "knockout" });
  ok(await page.locator("#rn-root").count() === 1, "runner is shown");
  ok(await page.locator(".rn-card.is-now").count() === 2, "2 courts -> 2 'now playing' cards");
  ok(await page.locator(".rn-card").count() === 4, "4 first-round matches listed (now + up next)", await page.locator(".rn-card").count());
  ok((await page.locator(".rn-progress-text").innerText()).includes("0 of 7"), "progress 0 of 7");
  // layout: nothing overflows horizontally on a phone
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  ok(!overflow, "no horizontal page scroll at 390px");
  const btnH = await page.locator(".rn-card.is-now .rn-pick").first().boundingBox();
  ok(btnH && btnH.height >= 48, "winner button is a large touch target", btnH);
  await page.locator("#rn-root").screenshot({ path: "/tmp/regtest/t/runner_phone_play.png" });
  // one-tap winner then confirm
  const firstNow = page.locator(".rn-card.is-now").first();
  const nameA = (await firstNow.locator(".rn-pick").first().innerText()).replace("✓", "").trim();
  ok(await firstNow.locator('[data-rn-act="save-ko"]').isDisabled(), "confirm disabled until a winner is tapped");
  await firstNow.locator(".rn-pick").first().tap(); await page.waitForTimeout(200);
  ok(!(await page.locator(".rn-card.is-now").first().locator('[data-rn-act="save-ko"]').isDisabled()), "confirm enabled after tapping a winner");
  ok((await page.locator(".rn-card.is-now").first().locator('[data-rn-act="save-ko"]').innerText()).includes(nameA.split("\n")[0].slice(0, 6)), "confirm button names the winner");
  await page.locator(".rn-card.is-now").first().locator('[data-rn-act="save-ko"]').tap(); await page.waitForTimeout(1200);
  ok((await page.locator(".rn-progress-text").innerText()).includes("1 of 7"), "progress moves to 1 of 7");
  ok(await page.locator("#rn-toast.show").count() === 1, "toast confirms the save");
  // score with a tie -> must choose winner
  const card2 = page.locator(".rn-card.is-now").first();
  await card2.locator('[data-rn-act="toggle-score"]').tap(); await page.waitForTimeout(150);
  await card2.locator('[data-rn-act="inc"][data-rn-side="a"]').tap(); await card2.locator('[data-rn-act="inc"][data-rn-side="b"]').tap();
  ok(await page.locator(".rn-card.is-now").first().locator('[data-rn-act="save-ko"]').isDisabled(), "level score needs a winner (penalties)");
  await page.locator(".rn-card.is-now").first().locator('.rn-pick').nth(1).tap();
  await page.locator(".rn-card.is-now").first().locator(".rn-note").fill("pens");
  await page.locator(".rn-card.is-now").first().locator('[data-rn-act="save-ko"]').tap(); await page.waitForTimeout(1200);
  ok((await page.locator(".rn-progress-text").innerText()).includes("2 of 7"), "2 of 7 after the penalties match");
  // unequal score decides the winner by itself
  const card3 = page.locator(".rn-card.is-now").first();
  await card3.locator('[data-rn-act="toggle-score"]').tap();
  await card3.locator('[data-rn-act="inc"][data-rn-side="b"]').tap();
  ok(!(await page.locator(".rn-card.is-now").first().locator('[data-rn-act="save-ko"]').isDisabled()), "a higher score picks the winner automatically");
  await page.locator(".rn-card.is-now").first().locator('[data-rn-act="save-ko"]').tap(); await page.waitForTimeout(1200);
  // played tab + edit
  await page.click('[data-rn-view="played"]'); await page.waitForTimeout(300);
  ok(await page.locator(".rn-played").count() === 3, "played tab lists 3 results", await page.locator(".rn-played").count());
  await page.locator('.rn-played [data-rn-act="edit"]').first().tap(); await page.waitForTimeout(300);
  ok(await page.locator(".rn-card .rn-tag.edit").count() === 1, "a played match can be reopened for change");
  await page.locator('.rn-card [data-rn-act="cancel"]').tap(); await page.waitForTimeout(300);
  // search filter
  await page.click('[data-rn-view="play"]'); await page.waitForTimeout(300);
  await page.fill("#rn-search", "SIM Player 00"); await page.waitForTimeout(300);
  ok(await page.locator(".rn-card").count() >= 1, "search keeps matching matches");
  await page.fill("#rn-search", "zzzz-none"); await page.waitForTimeout(300);
  ok(await page.locator(".rn-card").count() === 0, "search with no match hides cards");
  await page.fill("#rn-search", ""); await page.waitForTimeout(300);
  // court filter
  await page.locator('[data-rn-act="court"][data-rn-court="1"]').tap(); await page.waitForTimeout(300);
  const courtTexts = await page.locator(".rn-card .rn-when").allInnerTexts();
  ok(courtTexts.every((x) => /1/.test(x.split("·")[0])), "court filter shows only that court", courtTexts);
  await page.locator('[data-rn-act="court"][data-rn-court="0"]').tap();
  // overview tab
  await page.click('[data-rn-view="bracket"]'); await page.waitForTimeout(300);
  ok(await page.locator(".rn-ov-round").count() === 3, "overview shows 3 rounds");
  await page.locator("#rn-root").screenshot({ path: "/tmp/regtest/t/runner_phone_overview.png" });
  await page.click('[data-rn-view="play"]');
  // finish with auto-play and check champion
  await page.click('[data-sim-auto="end"]'); await page.waitForTimeout(1500);
  ok(await page.locator(".rn-banner.champ").count() === 1, "champion banner when finished");
  ok((await page.locator(".rn-progress-text").innerText()).includes("7 of 7"), "7 of 7");
  await page.locator("#rn-root").screenshot({ path: "/tmp/regtest/t/runner_phone_done.png" });

  // ---------------- league (groups) 6 players, 2 groups
  await page.click("[data-sim-exit]"); await page.waitForTimeout(800);
  await newSim(evG.id, 6, { format: "groups", groups: 2 });
  ok(await page.locator(".rn-card").count() >= 2, "group matches are listed");
  const g1 = page.locator(".rn-card.is-now").first();
  ok(await g1.locator('[data-rn-act="save-group"]').isDisabled(), "group save disabled until a score is set");
  await g1.locator('[data-rn-act="quick"][data-rn-q="a"]').tap(); await page.waitForTimeout(150);
  ok((await page.locator(".rn-card.is-now").first().locator(".rn-step output").first().innerText()) === "1", "quick 'wins' sets 1-0");
  await page.locator(".rn-card.is-now").first().locator('[data-rn-act="inc"][data-rn-side="a"]').tap();
  await page.locator(".rn-card.is-now").first().locator('[data-rn-act="save-group"]').tap(); await page.waitForTimeout(1200);
  ok((await page.locator(".rn-progress-text").innerText()).includes("1 of 6"), "1 of 6 group matches (2-0)");
  await page.click('[data-rn-view="played"]'); await page.waitForTimeout(250);
  ok((await page.locator(".rn-played").first().innerText()).includes("2 - 0"), "result 2 - 0 shown");
  await page.click('[data-rn-view="bracket"]'); await page.waitForTimeout(250);
  ok(await page.locator(".rn-tables .tourn-group").count() === 2, "group tables shown");
  await page.click('[data-rn-view="play"]');
  await page.click('[data-sim-auto="stage"]'); await page.waitForTimeout(1500);
  ok(await page.locator('.rn-banner [data-tourn-action="generate-knockout"]').count() === 1, "banner offers 'draw knockout' once groups are done");
  await page.locator('.rn-banner [data-tourn-action="generate-knockout"]').tap(); await page.waitForTimeout(1200);
  ok(await page.locator(".rn-card").count() >= 1, "knockout matches appear after the draw");
  // Arabic + RTL
  await page.evaluate(() => setLang("ar")); await page.waitForTimeout(700);
  await page.click('[data-admin-tab="tournaments"]'); await page.waitForTimeout(500);
  const arTxt = await page.locator("#rn-root").innerText();
  ok(/للّعب|تم لعبها/.test(arTxt) || arTxt.includes("مباراة"), "Arabic runner text", arTxt.slice(0, 120));
  await page.screenshot({ path: "/tmp/regtest/t/runner_phone_ar.png" });
  ok(errs.length === 0, "no page errors", errs);
  await browser.close();
  console.log(`passed ${pass} failed ${fail}`);
  process.exit(fail ? 1 : 0);
})();
