// League season E2E: eligibility by birth year, head-to-head tie-break, league finals from the table
// (Final + 3rd-place match), shared-pitch season scheduler, team registration.
// Usage: BASE_URL=http://localhost:3946 node league_e2e.js   (fresh data folder, e2e admin below)
"use strict";
const path = require("path");
const BASE = process.env.BASE_URL || "http://localhost:3945";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
let passed = 0, failed = 0;
const serverErrors = [];
const ok = (c, l, x) => { if (c) passed++; else { failed++; console.log("FAIL:", l, x === undefined ? "" : JSON.stringify(x).slice(0, 400)); } };
const section = (s) => console.log("\n=== " + s + " ===");
const newJar = () => ({});
function applySetCookies(jar, res) {
  const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const raw of sc) { const [pair] = raw.split(";"); const eq = pair.indexOf("="); if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); }
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
async function api(p, { method = "GET", body, jar, isForm = false, raw = false, buf = false } = {}) {
  jar = jar || newJar();
  const headers = {};
  if (Object.keys(jar).length) headers.Cookie = cookieHeader(jar);
  if (!["GET", "HEAD"].includes(method) && jar.csrfToken) headers["X-CSRF-Token"] = jar.csrfToken;
  let fb;
  if (body !== undefined) { if (isForm) fb = body; else { headers["Content-Type"] = "application/json"; fb = JSON.stringify(body); } }
  const res = await fetch(BASE + p, { method, headers, body: fb, redirect: "manual" });
  applySetCookies(jar, res);
  if (res.status >= 500) serverErrors.push(`${method} ${p} -> ${res.status}`);
  const h = { disposition: res.headers.get("content-disposition") || "" };
  if (buf) return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), ...h, jar };
  if (raw) return { status: res.status, text: await res.text(), ...h, jar };
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, jar };
}
const prime = async (jar) => { await api("/", { jar }); return jar; };
const admin = newJar();
const A = (p, m = "GET", b) => api(p, { method: m, jar: admin, body: b });
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (n) => iso(new Date(Date.now() + n * 86400000));
const bd = (years) => iso(new Date(Date.now() - (years * 365.25 + 40) * 86400000));
async function mkEvent(nameEn, date, extra = {}, jar) {
  const f = new FormData();
  f.set("nameEn", nameEn); f.set("nameAr", nameEn + " ع"); f.set("sport", "Chess"); f.set("date", date);
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  const r = await api("/api/events", { method: "POST", jar: jar || admin, body: f, isForm: true });
  return r;
}
async function signup(num, name, birthDate) {
  const jar = await prime(newJar());
  const r = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: num, name, password: "abc12345", phone: "0106" + num.replace(/\D/g, "").padStart(7, "0"), agreeTerms: true, memberType: "main", birthDate } });
  if (![200, 201].includes(r.status)) throw new Error("signup failed " + JSON.stringify(r.json));
  return { jar, num, name };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yearsAgoDate = (y) => `${y}-06-15`;
const evOf = async (id) => { const r = await api("/api/events", { jar: newJar() }); return (r.json || []).find((e) => e.id === id); };
const reg = (m, eventId, extra = {}) => api("/api/register", { method: "POST", jar: m.jar, body: { eventId, ...extra } });

(async () => {
  const lg = await api("/api/auth/staff-login", { method: "POST", jar: await prime(admin), body: { username: ADMIN_USER, password: ADMIN_PASS } });
  ok(lg.status === 200, "admin login", lg.json);

  section("A. Eligibility by birth year");
  const young = await signup("LG1", "LG Young", yearsAgoDate(2015));
  const old = await signup("LG2", "LG Old", yearsAgoDate(2010));
  const edge1 = await signup("LG3", "LG Edge 2014", yearsAgoDate(2014));
  const edge2 = await signup("LG4", "LG Edge 2017", yearsAgoDate(2017));
  const tooNew = await signup("LG5", "LG Too New", yearsAgoDate(2018));
  const cat = await mkEvent("LG Juniors", addDays(20), { birthYearFrom: "2014", birthYearTo: "2017" });
  ok(cat.status === 201 && cat.json.birthYearFrom === 2014 && cat.json.birthYearTo === 2017, "event created with a birth-year range", cat.json);
  const listed = await evOf(cat.json.id);
  ok(listed && listed.birthYearFrom === 2014 && listed.birthYearTo === 2017, "range is in the public list", listed);
  let r = await reg(young, cat.json.id);
  ok([200, 201].includes(r.status), "born 2015 can register", r.json);
  r = await reg(old, cat.json.id);
  ok(r.status === 403 && r.json.code === "not_eligible" && r.json.birthYear === 2010, "born 2010 refused by the server", [r.status, r.json]);
  r = await reg(edge1, cat.json.id);
  ok([200, 201].includes(r.status), "born 2014 (first year) can register", r.json);
  r = await reg(edge2, cat.json.id);
  ok([200, 201].includes(r.status), "born 2017 (last year) can register", r.json);
  r = await reg(tooNew, cat.json.id);
  ok(r.status === 403 && r.json.code === "not_eligible", "born 2018 refused", r.json);
  const mine = await api("/api/me/registrations", { jar: old.jar });
  ok(!(mine.json || []).some((x) => x.eventId === cat.json.id), "no registration created for the refused member");
  const inv = await A(`/api/admin/events/${cat.json.id}/invite`, "POST", { membershipNumbers: ["LG2"] });
  ok(inv.status === 200 && (inv.json.invited || []).length === 1, "admin invite bypasses the range", inv.json);
  // only one end
  const onlyFrom = await mkEvent("LG Masters", addDays(21), { birthYearTo: "1987" });
  ok(onlyFrom.status === 201 && onlyFrom.json.birthYearFrom === null && onlyFrom.json.birthYearTo === 1987, "only a last year", onlyFrom.json);
  r = await reg(young, onlyFrom.json.id);
  ok(r.status === 403, "born 2015 refused for 1987-or-earlier");
  // validation
  const badOrder = await mkEvent("LG Bad order", addDays(22), { birthYearFrom: "2017", birthYearTo: "2014" });
  ok(badOrder.status === 400, "first year after last year refused", badOrder.json);
  const badText = await mkEvent("LG Bad text", addDays(23), { birthYearFrom: "abc" });
  ok(badText.status === 400, "non-numeric year refused", badText.json);
  const badRange = await mkEvent("LG Bad range", addDays(24), { birthYearFrom: "1850" });
  ok(badRange.status === 400, "year before 1900 refused", badRange.json);
  // edit: clear the range
  const f = new FormData();
  f.set("nameEn", "LG Juniors"); f.set("date", addDays(20)); f.set("birthYearFrom", ""); f.set("birthYearTo", "");
  const ed = await api(`/api/events/${cat.json.id}`, { method: "PUT", jar: admin, body: f, isForm: true });
  ok(ed.status === 200 && ed.json.birthYearFrom === null && ed.json.birthYearTo === null, "range cleared by an edit", ed.json);
  r = await reg(tooNew, cat.json.id);
  ok([200, 201].includes(r.status), "anyone can register once the range is cleared", r.json);
  const f2 = new FormData();
  f2.set("nameEn", "LG Juniors"); f2.set("date", addDays(20));
  const ed2 = await api(`/api/events/${cat.json.id}`, { method: "PUT", jar: admin, body: f2, isForm: true });
  ok(ed2.status === 200, "edit without range fields still works", ed2.json);

  section("B. League with finals from the table");
  const lgEv = await mkEvent("LG League Cat", addDays(30));
  const lid = lgEv.json.id;
  const players = [];
  for (let i = 1; i <= 4; i++) {
    const m = await signup("LP" + i, "LP Player " + i, yearsAgoDate(2000));
    players.push(m);
    const rr = await reg(m, lid);
    ok([200, 201].includes(rr.status), "league player " + i + " registered", rr.json);
  }
  const noKind = await A(`/api/admin/tournaments/${lid}`, "POST", { mode: "individual", format: "groups", numGroups: 1, advancePerGroup: 1 });
  ok(noKind.status === 400, "plain groups with 1 group still refused", noKind.json);
  const badFm = await A(`/api/admin/tournaments/${lid}`, "POST", { mode: "individual", format: "knockout", finalsMode: "table" });
  ok(badFm.status === 400, "table finals only for the league format", badFm.json);
  const mkT = await A(`/api/admin/tournaments/${lid}`, "POST", { mode: "individual", format: "groups", finalsMode: "table" });
  ok(mkT.status === 201 && mkT.json.tournament.finalsMode === "table" && mkT.json.tournament.h2hTiebreak === true && mkT.json.tournament.numGroups === 1, "league created", mkT.json);
  const gen = await A(`/api/admin/tournaments/${lid}/generate`, "POST", {});
  ok(gen.status === 200 && gen.json.tournament.groups.length === 1 && gen.json.tournament.groups[0].matches.length === 6, "round-robin generated: 6 matches", gen.json);
  let T = gen.json.tournament;
  const ms = T.groups[0].matches;
  ok(ms.every((m) => Number.isInteger(m.round) && m.round >= 1 && m.round <= 3), "every match has a round number 1-3", ms.map((m) => m.round));
  ok([1, 2, 3].every((rn) => { const inR = ms.filter((m) => m.round === rn); const ids = inR.flatMap((m) => [m.a, m.b]); return inR.length === 2 && new Set(ids).size === 4; }), "each round: 2 matches, every team once");
  const early = await A(`/api/admin/tournaments/${lid}/generate-knockout`, "POST", {});
  ok(early.status === 400, "finals refused until the league is complete", early.json);
  // map labels -> ids
  const idOf = {};
  for (const m of ms) { idOf[m.aLabel] = m.a; idOf[m.bLabel] = m.b; }
  const P = (i) => idOf[Object.keys(idOf).find((k) => k.includes("LP Player " + i))];
  const matchOf = (x, y) => ms.find((m) => (m.a === P(x) && m.b === P(y)) || (m.a === P(y) && m.b === P(x)));
  const setRes = async (x, y, sx, sy) => {
    const m = matchOf(x, y);
    const [sa, sb] = m.a === P(x) ? [sx, sy] : [sy, sx];
    return A(`/api/admin/tournaments/${lid}/group-result`, "PUT", { matchId: m.id, scoreA: sa, scoreB: sb });
  };
  // 1 beat 2 1-0 ; 3 beat 1 1-0 ; 1 beat 4 1-0 ; 2 beat 3 3-0 ; 2 beat 4 4-0 ; 3 v 4 0-0
  for (const [x, y, sx, sy] of [[1, 2, 1, 0], [3, 1, 1, 0], [1, 4, 1, 0], [2, 3, 3, 0], [2, 4, 4, 0], [3, 4, 0, 0]]) {
    const rr = await setRes(x, y, sx, sy);
    ok(rr.status === 200, `result ${x} v ${y}`, rr.json);
  }
  const st = (await A(`/api/admin/tournaments/${lid}`)).json.tournament.groups[0].standings;
  ok(st[0].label.includes("Player 1") && st[1].label.includes("Player 2"), "head-to-head: player 1 above player 2 on equal points despite worse goal difference", st.map((s) => [s.label, s.points, s.gd]));
  ok(st[0].points === 6 && st[1].points === 6 && st[0].gd < st[1].gd, "points level, goal difference favours player 2", st.map((s) => [s.points, s.gd]));
  ok(st[2].label.includes("Player 3") && st[3].label.includes("Player 4"), "3rd and 4th place", st.map((s) => s.label));
  const gk = await A(`/api/admin/tournaments/${lid}/generate-knockout`, "POST", {});
  ok(gk.status === 200, "finals generated", gk.json);
  T = gk.json.tournament;
  const round = T.knockout.rounds[0];
  const fin = round.find((m) => m.place === 1);
  const third = round.find((m) => m.place === 3);
  ok(T.knockout.rounds.length === 1 && round.length === 2 && fin && third, "one round with a Final and a 3rd-place match", round);
  ok([fin.a, fin.b].sort().join() === [P(1), P(2)].sort().join(), "final = 1st v 2nd");
  ok([third.a, third.b].sort().join() === [P(3), P(4)].sort().join(), "3rd-place match = 3rd v 4th");
  ok(fin.a === P(1) && third.a === P(3), "higher-placed team listed first");
  const again = await A(`/api/admin/tournaments/${lid}/generate-knockout`, "POST", {});
  ok(again.status === 400, "finals can't be generated twice");
  // a correction that changes the pairings is refused
  const bad = await setRes(1, 2, 0, 1);
  ok(bad.status === 400, "result correction that changes who plays the final is refused", bad.json);
  const same = await setRes(3, 4, 1, 0);
  ok(same.status === 200 || same.status === 400, "correction in 3rd/4th handled", same.status);
  // play 3rd-place first
  const r3 = await A(`/api/admin/tournaments/${lid}/knockout-result`, "PUT", { roundIndex: 0, matchId: third.id, scoreA: 2, scoreB: 2, winnerId: P(4) });
  ok(r3.status === 200, "3rd-place decided on penalties (level score + chosen winner)", r3.json);
  ok(r3.json.tournament.status === "knockout", "not completed until the final is played too", r3.json.tournament.status);
  const r1 = await A(`/api/admin/tournaments/${lid}/knockout-result`, "PUT", { roundIndex: 0, matchId: fin.id, scoreA: 0, scoreB: 3 });
  ok(r1.status === 200 && r1.json.tournament.status === "completed", "completed once both matches are decided", r1.json.tournament && r1.json.tournament.status);
  const sd = r1.json.tournament.standings;
  ok(sd.length === 4 && sd[0].rank === 1 && sd[0].entrantId === P(2) && sd[1].entrantId === P(1) && sd[2].rank === 3 && sd[2].entrantId === P(4) && sd[3].rank === 4 && sd[3].entrantId === P(3), "final ranking 1-4", sd);
  const aw = await A(`/api/admin/tournaments/${lid}/award-points`, "POST", {});
  ok(aw.status === 200 && aw.json.updated === 4, "points awarded for places 1-4", aw.json);
  const pub = await api(`/api/tournaments/${lid}`, { jar: newJar() });
  ok(pub.status === 200 && pub.json.tournament.finalsMode === "table", "public view carries the league fields");

  // A classic groups tournament is unchanged (no head-to-head)
  const ev2 = await mkEvent("LG Classic", addDays(31));
  const cp = [];
  for (let i = 1; i <= 4; i++) { const m = await signup("LC" + i, "LC Player " + i, yearsAgoDate(1995)); cp.push(m); await reg(m, ev2.json.id); }
  const cg = await A(`/api/admin/tournaments/${ev2.json.id}`, "POST", { mode: "individual", format: "groups", numGroups: 2, advancePerGroup: 1 });
  ok(cg.status === 201 && cg.json.tournament.h2hTiebreak === false && cg.json.tournament.finalsMode === null, "classic groups: no head-to-head, no table finals", cg.json.tournament);


  section("C. Season scheduler: two categories sharing 3 pitches");
  const season = await mkEvent("LG Season", addDays(40));
  const sid = season.json.id;
  const catA = await mkEvent("LG Season Juniors", addDays(40), { parentEventId: String(sid), birthYearFrom: "2000", birthYearTo: "2005" });
  const catB = await mkEvent("LG Season Youth", addDays(40), { parentEventId: String(sid), birthYearFrom: "1980", birthYearTo: "1999" });
  ok(catA.status === 201 && catB.status === 201, "season + two categories created", [catA.json, catB.json]);
  const cats = [catA.json.id, catB.json.id];
  for (let c = 0; c < 2; c++) {
    for (let i = 1; i <= 6; i++) {
      const m = await signup(`SC${c}${i}`, `SC${c} Player ${i}`, yearsAgoDate(c === 0 ? 2002 : 1990));
      const rr = await reg(m, cats[c]);
      ok([200, 201].includes(rr.status), `season player ${c}${i} registered`, rr.json);
    }
    const cr = await A(`/api/admin/tournaments/${cats[c]}`, "POST", { mode: "individual", format: "groups", finalsMode: "table" });
    ok(cr.status === 201, "league " + c + " created", cr.json);
  }
  const d1 = addDays(40), d2 = addDays(47), d3 = addDays(54);
  const cfg = { eventIds: cats, matchMinutes: 30, gapMinutes: 5, maxPerTeamPerDay: 2,
    days: [{ date: d1, pitches: 3, startTime: "10:00", slots: 4 }, { date: d2, pitches: 3, startTime: "10:00", slots: 4 }, { date: d3, pitches: 3, startTime: "10:00", slots: 2 }],
    finals: { date: d3, thirdPlaceTime: "11:20", finalTime: "12:00", pitches: [1, 2] } };
  const notGen = await A("/api/admin/season-schedule", "POST", cfg);
  ok(notGen.status === 400 && /generate/i.test(notGen.json.error), "refused before the leagues are generated", notGen.json);
  for (const id of cats) { const g = await A(`/api/admin/tournaments/${id}/generate`, "POST", {}); ok(g.status === 200 && g.json.tournament.groups[0].matches.length === 15, "league generated: 15 matches", g.json); }
  const dry = await A("/api/admin/season-schedule", "POST", { ...cfg, dryRun: "true" });
  ok(dry.status === 200 && dry.json.dryRun && dry.json.scheduled === 30, "dry run: all 30 matches fit", dry.json);
  const stillNone = (await A(`/api/admin/tournaments/${cats[0]}`)).json.tournament.groups[0].matches;
  ok(stillNone.every((m) => !m.date), "dry run changes nothing");
  // validation
  const tooFew = await A("/api/admin/season-schedule", "POST", { ...cfg, days: cfg.days.slice(0, 2) });
  ok(tooFew.status === 400 && tooFew.json.code === "not_enough_capacity" && tooFew.json.unscheduled === 6, "two days are not enough: 6 matches left over", tooFew.json);
  const dupDay = await A("/api/admin/season-schedule", "POST", { ...cfg, days: [cfg.days[0], cfg.days[0]] });
  ok(dupDay.status === 400, "same date twice refused", dupDay.json);
  const badDate = await A("/api/admin/season-schedule", "POST", { ...cfg, days: [{ date: "2027-02-30", pitches: 3, startTime: "10:00", slots: 4 }] });
  ok(badDate.status === 400, "impossible date refused", badDate.json);
  const zeroSlots = await A("/api/admin/season-schedule", "POST", { ...cfg, days: [{ date: d1, pitches: 3, startTime: "10:00", slots: 0 }] });
  ok(zeroSlots.status === 400, "zero slots refused", zeroSlots.json);
  const noDays = await A("/api/admin/season-schedule", "POST", { ...cfg, days: [] });
  ok(noDays.status === 400, "no days refused");
  const clash = await A("/api/admin/season-schedule", "POST", { ...cfg, finals: { ...cfg.finals, pitches: [1, 1] } });
  ok(clash.status === 400, "two leagues on the same finals pitch refused", clash.json);
  const early3 = await A("/api/admin/season-schedule", "POST", { ...cfg, finals: { ...cfg.finals, thirdPlaceTime: "10:30", finalTime: "12:00" } });
  ok(early3.status === 400, "3rd-place before the last league match ends refused", early3.json);
  const bigPitch = await A("/api/admin/season-schedule", "POST", { ...cfg, finals: { ...cfg.finals, pitches: [1, 4] } });
  ok(bigPitch.status === 400, "finals pitch beyond the day's pitches refused", bigPitch.json);
  const order = await A("/api/admin/season-schedule", "POST", { ...cfg, finals: { ...cfg.finals, thirdPlaceTime: "12:00", finalTime: "11:20" } });
  ok(order.status === 400, "Final before the 3rd-place match refused", order.json);
  const noEvents = await A("/api/admin/season-schedule", "POST", { ...cfg, eventIds: [] });
  ok(noEvents.status === 400, "no leagues chosen refused");
  const anon = await api("/api/admin/season-schedule", { method: "POST", jar: await prime(newJar()), body: cfg });
  ok([401, 403].includes(anon.status), "not logged in refused", anon.status);
  // real run
  const go = await A("/api/admin/season-schedule", "POST", cfg);
  ok(go.status === 200 && go.json.scheduled === 30, "scheduled 30 matches", go.json);
  const all = [];
  for (const id of cats) { const T0 = (await A(`/api/admin/tournaments/${id}`)).json.tournament; for (const m of T0.groups[0].matches) all.push({ ...m, cat: id }); }
  ok(all.length === 30 && all.every((m) => m.date && m.time && m.court), "every match has a date, time and pitch");
  const slotKey = (m) => m.date + " " + m.time;
  const seen = new Set(); let dupPitch = 0;
  for (const m of all) { const k = slotKey(m) + " #" + m.court; if (seen.has(k)) dupPitch++; seen.add(k); }
  ok(dupPitch === 0, "no pitch is used twice at the same time", dupPitch);
  let teamClash = 0, overLimit = 0;
  const bySlot = {}, byDay = {};
  for (const m of all) {
    for (const t of [m.a, m.b]) {
      const sk = slotKey(m) + "|" + m.cat + t;
      if (bySlot[sk]) teamClash++; bySlot[sk] = 1;
      const dk = m.date + "|" + m.cat + t; byDay[dk] = (byDay[dk] || 0) + 1;
      if (byDay[dk] > 2) overLimit++;
    }
  }
  ok(teamClash === 0, "no team plays twice at the same time", teamClash);
  ok(overLimit === 0, "no team plays more than 2 matches in a day", overLimit);
  const perDate = {}; all.forEach((m) => (perDate[m.date] = (perDate[m.date] || 0) + 1));
  ok(perDate[d1] === 12 && perDate[d2] === 12 && perDate[d3] === 6, "12 + 12 + 6 matches per day", perDate);
  const day1Rounds = [...new Set(all.filter((m) => m.date === d1).map((m) => m.round))].sort();
  ok(day1Rounds.join() === "1,2", "day 1 plays rounds 1 and 2", day1Rounds);
  const day3Rounds = [...new Set(all.filter((m) => m.date === d3).map((m) => m.round))];
  ok(day3Rounds.join() === "5", "last day plays round 5", day3Rounds);
  ok(all.filter((m) => m.date === d1).every((m) => ["10:00", "10:35", "11:10", "11:45"].includes(m.time)), "day 1 slots 10:00 / 10:35 / 11:10 / 11:45", [...new Set(all.map((m) => m.time))]);
  ok(all.filter((m) => m.date === d3).every((m) => ["10:00", "10:35"].includes(m.time)), "last day slots 10:00 / 10:35");
  // reserved finals before the draw
  let pubS = await api(`/api/season/${sid}`, { jar: newJar() });
  ok(pubS.status === 200 && pubS.json.categories.length === 2, "public season view: 2 categories", pubS.json.categories);
  const tbd = pubS.json.matches.filter((m) => m.tbd);
  ok(tbd.length === 4 && tbd.every((m) => m.date === d3) && tbd.filter((m) => m.kind === "final").every((m) => m.time === "12:00") && tbd.filter((m) => m.kind === "third").every((m) => m.time === "11:20"), "finals are reserved on the last day (to be decided)", tbd);
  ok(new Set(tbd.map((m) => m.court)).size === 2, "each league has its own finals pitch");
  ok(pubS.json.matches.length === 34, "30 league matches + 4 reserved finals", pubS.json.matches.length);
  const sorted = pubS.json.matches.every((m, i, arr) => i === 0 || (arr[i - 1].date + (arr[i - 1].time || "")) <= (m.date + (m.time || "")));
  ok(sorted, "public list sorted by date then time");
  // play league A, finals appear on the reserved slot
  const TA = (await A(`/api/admin/tournaments/${cats[0]}`)).json.tournament;
  let n = 0;
  for (const m of TA.groups[0].matches) { n++; const rr = await A(`/api/admin/tournaments/${cats[0]}/group-result`, "PUT", { matchId: m.id, scoreA: n % 4, scoreB: (n * 3) % 3 }); ok(rr.status === 200, "result " + n, rr.json); }
  const fk = await A(`/api/admin/tournaments/${cats[0]}/generate-knockout`, "POST", {});
  ok(fk.status === 200, "finals drawn", fk.json);
  const kr = fk.json.tournament.knockout.rounds[0];
  const f1 = kr.find((m) => m.place === 1), f3 = kr.find((m) => m.place === 3);
  ok(f1.date === d3 && f1.time === "12:00" && f1.court === 1 && f3.date === d3 && f3.time === "11:20" && f3.court === 1, "Final and 3rd-place match take the reserved date, time and pitch", [f1, f3]);
  const f1b = null;
  pubS = await api(`/api/season/${sid}`, { jar: newJar() });
  ok(pubS.json.matches.filter((m) => m.tbd).length === 2 && pubS.json.matches.filter((m) => m.kind === "final" && !m.tbd).length === 1, "public view: drawn finals replace their reserved lines");
  // re-run keeps played results' dates
  const playedBefore = (await A(`/api/admin/tournaments/${cats[0]}`)).json.tournament.groups[0].matches.map((m) => [m.id, m.date, m.time, m.court]);
  const rerun = await A("/api/admin/season-schedule", "POST", cfg);
  ok(rerun.status === 200 && rerun.json.scheduled === 15, "re-run schedules only the 15 unplayed matches of league B", rerun.json);
  const playedAfter = (await A(`/api/admin/tournaments/${cats[0]}`)).json.tournament.groups[0].matches.map((m) => [m.id, m.date, m.time, m.court]);
  ok(JSON.stringify(playedBefore) === JSON.stringify(playedAfter), "played matches keep their date, time and pitch");
  const kr2 = (await A(`/api/admin/tournaments/${cats[0]}`)).json.tournament.knockout.rounds[0];
  ok(kr2.find((m) => m.place === 1).time === "12:00", "drawn finals keep the reserved slot after a re-run");
  // the old single-day scheduler is blocked on a season league
  const oldSched = await A(`/api/admin/tournaments/${cats[1]}/schedule`, "PUT", { courts: 2, matchMinutes: 20, startTime: "09:00" });
  ok(oldSched.status === 400, "single-day schedule refused on a season-scheduled league", oldSched.json);
  // manager role
  const mgr = "mgr" + Date.now().toString(36);
  const cm = await A("/api/staff/accounts", "POST", { username: mgr, password: "Manager#1234", name: "Mgr", role: "tournament" });
  ok(cm.status === 201, "tournament manager created", cm.json);
  const mj = await prime(newJar());
  await api("/api/auth/staff-login", { method: "POST", jar: mj, body: { username: mgr, password: "Manager#1234" } });
  const mres = await api("/api/admin/season-schedule", { method: "POST", jar: mj, body: cfg });
  ok(mres.status === 403, "a manager who doesn't manage these leagues is refused", mres.json);


  section("D. Team registration");
  const bad1 = await mkEvent("LG Bad teams 1", addDays(60), { teamRegistration: "true", teamMinPlayers: "9", teamMaxPlayers: "5" });
  ok(bad1.status === 400, "minimum players above maximum refused", bad1.json);
  const bad2 = await mkEvent("LG Bad teams 2", addDays(61), { teamRegistration: "true", teamMaxTeams: "x" });
  ok(bad2.status === 400, "non-numeric team limit refused", bad2.json);
  const bad3 = await mkEvent("LG Bad teams 3", addDays(62), { teamRegistration: "true", teamMinTeams: "6", teamMaxTeams: "4" });
  ok(bad3.status === 400, "minimum teams above maximum refused", bad3.json);
  const tev = await mkEvent("LG Teams", addDays(63), { teamRegistration: "true", teamMinPlayers: "2", teamMaxPlayers: "3", teamMaxTeams: "2", teamMinTeams: "2", maxCapacity: "1" });
  ok(tev.status === 201 && tev.json.teamRegistration && tev.json.teamRegistration.maxPlayers === 3 && tev.json.teamRegistration.maxTeams === 2, "team event created", tev.json);
  const teid = tev.json.id;
  const tm = [];
  for (let i = 1; i <= 10; i++) tm.push(await signup("TM" + i, "TM Player " + i, yearsAgoDate(2000)));
  let r2 = await reg(tm[0], teid);
  ok(r2.status === 400 && r2.json.code === "team_required", "registering without a team refused", r2.json);
  r2 = await reg(tm[0], teid, { newTeamName: "A" });
  ok(r2.status === 400 && r2.json.code === "team_name_invalid", "one-letter team name refused", r2.json);
  r2 = await reg(tm[0], teid, { newTeamName: "Falcons" });
  ok(r2.status === 201 && r2.json.team && r2.json.team.name === "Falcons" && r2.json.registration.teamId === r2.json.team.id && !r2.json.registration.waitlisted, "captain starts team Falcons", r2.json);
  const falcons = r2.json.team.id;
  ok((await reg(tm[1], teid, { teamId: falcons })).status === 201, "second player joins Falcons");
  ok((await reg(tm[2], teid, { teamId: falcons })).status === 201, "third player joins Falcons");
  r2 = await reg(tm[3], teid, { teamId: falcons });
  ok(r2.status === 409 && r2.json.code === "team_full", "a 4th player is refused: team is full", r2.json);
  r2 = await reg(tm[3], teid, { newTeamName: "  falcons " });
  ok(r2.status === 409 && r2.json.code === "team_name_taken", "team name taken (case-insensitive)", r2.json);
  r2 = await reg(tm[3], teid, { teamId: 999999 });
  ok(r2.status === 404 && r2.json.code === "team_not_found", "unknown team refused", r2.json);
  const otherEv = await mkEvent("LG Other teams", addDays(64), { teamRegistration: "true" });
  r2 = await reg(tm[3], otherEv.json.id, { teamId: falcons });
  ok(r2.status === 404, "a team of another event can't be joined", r2.json);
  r2 = await reg(tm[3], teid, { newTeamName: "Eagles" });
  ok(r2.status === 201 && !r2.json.registration.waitlisted, "Eagles started (2nd of 2 teams) - player capacity of 1 ignored", r2.json);
  const eagles = r2.json.team.id;
  ok((await reg(tm[4], teid, { teamId: eagles })).status === 201, "joins Eagles");
  ok((await reg(tm[5], teid, { teamId: eagles })).status === 201, "joins Eagles (3)");
  r2 = await reg(tm[6], teid, { newTeamName: "Hawks" });
  ok(r2.status === 200 && r2.json.needsWaitlistConfirmation === true, "teams full: asks before using the waiting list", r2.json);
  r2 = await reg(tm[6], teid, { newTeamName: "Hawks", joinWaitlist: true });
  ok(r2.status === 201 && r2.json.waitlisted === true && r2.json.registration.waitlisted === true, "Hawks on the waiting list", r2.json);
  const hawks = r2.json.team.id;
  r2 = await reg(tm[7], teid, { teamId: hawks });
  ok(r2.status === 201 && r2.json.registration.waitlisted === true, "joining a waiting-list team is waiting-list too", r2.json);
  let pubT = await api(`/api/events/${teid}/teams`, { jar: newJar() });
  ok(pubT.status === 200 && pubT.json.teams.length === 3 && pubT.json.confirmedTeams === 2 && pubT.json.waitlistedTeams === 1, "public team list: 2 confirmed + 1 waiting", pubT.json);
  ok(pubT.json.teams.find((t) => t.id === falcons).full === true && pubT.json.teams.find((t) => t.id === falcons).playerCount === 3, "Falcons 3/3 full");
  ok(!JSON.stringify(pubT.json).includes("TM Player"), "public list shows no player names");
  const tl = await evOf(teid);
  ok(tl.teamCount === 2 && tl.waitlistTeamCount === 1, "event list carries team counts", [tl.teamCount, tl.waitlistTeamCount]);
  const adm = await A(`/api/admin/events/${teid}/teams`);
  const aF = adm.json.teams.find((t) => t.id === falcons);
  ok(adm.status === 200 && aF.players.length === 3 && aF.players[0].isCaptain === true && aF.players.filter((x) => x.isCaptain).length === 1 && aF.complete && aF.full, "admin team list with captain", aF);
  const regsOfHawks = adm.json.teams.find((t) => t.id === hawks).players;
  const prom = await A(`/api/admin/registrations/${regsOfHawks[0].registrationId}/promote`, "POST", {});
  ok(prom.status === 400 && prom.json.code === "team_event", "single player of a waiting-list team can't be promoted alone", prom.json);
  // captain leaves -> captaincy passes on
  const myRegs = await api("/api/me/registrations", { jar: tm[0].jar });
  const capReg = myRegs.json.find((x) => x.eventId === teid);
  const del = await api(`/api/me/registrations/${capReg.id}`, { method: "DELETE", jar: tm[0].jar });
  ok(del.status === 200, "captain cancels", del.json);
  const adm2 = await A(`/api/admin/events/${teid}/teams`);
  const aF2 = adm2.json.teams.find((t) => t.id === falcons);
  ok(aF2.players.length === 2 && aF2.players.find((x) => x.isCaptain) && aF2.players.find((x) => x.isCaptain).name === "TM Player 2", "captaincy passed to the next player", aF2.players);
  r2 = await reg(tm[8], teid, { teamId: falcons });
  ok(r2.status === 201, "the free seat can be taken by someone else");
  // whole Eagles team leaves -> waiting-list Hawks promoted automatically
  let lastDel;
  for (const idx of [3, 4, 5]) {
    const mr = await api("/api/me/registrations", { jar: tm[idx].jar });
    lastDel = await api(`/api/me/registrations/${mr.json.find((x) => x.eventId === teid).id}`, { method: "DELETE", jar: tm[idx].jar });
    ok(lastDel.status === 200, "Eagles player " + (idx + 1) + " cancels");
  }
  ok(lastDel.json.promotedTeam === "Hawks", "last Eagles player leaves: Hawks promoted from the waiting list", lastDel.json);
  pubT = await api(`/api/events/${teid}/teams`, { jar: newJar() });
  ok(pubT.json.teams.length === 2 && pubT.json.confirmedTeams === 2 && pubT.json.waitlistedTeams === 0, "Eagles gone, Hawks confirmed", pubT.json);
  const adm3 = await A(`/api/admin/events/${teid}/teams`);
  ok(adm3.json.teams.find((t) => t.id === hawks).players.every((p) => p.name), "Hawks players listed");
  const hawkRegs = (await A(`/api/registrations?eventId=${teid}`)).json.filter((x) => x.teamId === hawks);
  ok(hawkRegs.length === 2 && hawkRegs.every((x) => x.waitlisted === false), "Hawks' players are confirmed now", hawkRegs.map((x) => x.waitlisted));
  // new team while full -> waiting list, then admin remove of a confirmed team promotes it
  r2 = await reg(tm[9], teid, { newTeamName: "Owls", joinWaitlist: true });
  ok(r2.status === 201 && r2.json.waitlisted === true, "Owls on the waiting list", r2.json);
  const owls = r2.json.team.id;
  const noReason = await A(`/api/admin/event-teams/${falcons}/remove`, "POST", {});
  ok(noReason.status === 400, "removing a team needs a reason", noReason.json);
  const rn = await A(`/api/admin/event-teams/${hawks}`, "PUT", { name: "Hawks FC" });
  ok(rn.status === 200 && rn.json.team.name === "Hawks FC", "team renamed", rn.json);
  const rnDup = await A(`/api/admin/event-teams/${hawks}`, "PUT", { name: "falcons" });
  ok(rnDup.status === 409, "rename to an existing name refused", rnDup.json);
  const rm = await A(`/api/admin/event-teams/${falcons}/remove`, "POST", { reason: "withdrew" });
  ok(rm.status === 200 && rm.json.removedPlayers === 3 && rm.json.promotedTeam === "Owls", "Falcons removed (3 players), Owls promoted", rm.json);
  const tEmpty = await api(`/api/registrations?eventId=${teid}`, { jar: admin });
  ok(!(tEmpty.json || []).some((x) => x.teamId === falcons), "removed team's registrations are gone");
  const promoteConfirmed = await A(`/api/admin/event-teams/${owls}/promote`, "POST", {});
  ok(promoteConfirmed.status === 400, "promoting a confirmed team refused", promoteConfirmed.json);
  // merge refused
  const mg = await A(`/api/admin/events/${teid}/move-registrations`, "POST", { toEventId: otherEv.json.id, dryRun: true });
  ok(mg.status === 400, "team events can't be merged", mg.json);
  // tournament from teams
  const tt = await A(`/api/admin/tournaments/${teid}`, "POST", { mode: "team", format: "groups", finalsMode: "table" });
  ok(tt.status === 201 && tt.json.tournament.status === "team-setup", "team-mode league created", tt.json);
  const imp1 = await A(`/api/admin/tournaments/${teid}/import-teams`, "POST", {});
  ok(imp1.status === 400 && imp1.json.skipped && imp1.json.skipped.length >= 1, "only complete teams are imported: Owls (1 player) is skipped and reported", imp1.json);
  const imp2 = await A(`/api/admin/tournaments/${teid}/import-teams`, "POST", { includeIncomplete: "true" });
  ok(imp2.status === 200 && imp2.json.tournament.teams.length === 2 && imp2.json.tournament.status === "seeding", "teams imported into the tournament", imp2.json);
  ok(imp2.json.tournament.teams.every((t) => t.memberIds.length >= 1 && t.name), "teams carry names and players");
  // invites into a team event need a team
  const invNo = await A(`/api/admin/events/${teid}/invite`, "POST", { membershipNumbers: ["LP1"] });
  ok(invNo.status === 400 && invNo.json.code === "team_required", "invite without a team refused", invNo.json);
  const invYes = await A(`/api/admin/events/${teid}/invite`, "POST", { membershipNumbers: ["LP1"], teamId: owls });
  ok(invYes.status === 200 && invYes.json.invited.length === 1, "invite into a chosen team works", invYes.json);
  const noTeamMode = await A(`/api/admin/tournaments/${cats[0]}/import-teams`, "POST", {});
  ok(noTeamMode.status === 400, "import refused for an individual-mode tournament", noTeamMode.json);
  // delete event removes its teams
  const delEv = await api(`/api/events/${otherEv.json.id}`, { method: "DELETE", jar: admin });
  ok(delEv.status === 200, "delete event", delEv.json);
  // editing event settings
  const f9 = new FormData(); f9.set("nameEn", "LG Teams"); f9.set("date", addDays(63)); f9.set("teamRegistration", "false");
  const e3 = await api(`/api/events/${teid}`, { method: "PUT", jar: admin, body: f9, isForm: true });
  ok(e3.status === 200 && e3.json.teamRegistration === null, "team registration switched off by an edit", e3.json);


  console.log(`\n${passed} passed, ${failed} failed`);
  if (serverErrors.length) { console.log("SERVER 5xx:", serverErrors); failed++; }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
