// Gender + scorers & awards E2E: gender on members/family, gender-restricted events (Red Rose Cup),
// goal scorers per match, top scorer, best goalkeeper / best player / fair play awards.
// Usage: BASE_URL=http://localhost:3946 node awards_e2e.js   (fresh data folder, e2e admin below)
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
  const signupG = async (num, name, birthDate, gender) => {
    const jar = await prime(newJar());
    const r = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: num, name, password: "abc12345", phone: "0107" + num.replace(/\D/g, "").padStart(7, "0"), agreeTerms: true, memberType: "main", birthDate, gender } });
    if (![200, 201].includes(r.status)) throw new Error("signup failed " + JSON.stringify(r.json));
    return { jar, num, name, member: r.json.member };
  };

  section("A. Gender on members and family");
  const girl = await signupG("GN1", "GN Girl", yearsAgoDate(2008), "female");
  ok(girl.member.gender === "female", "gender stored at sign-up", girl.member.gender);
  const boy = await signupG("GN2", "GN Boy", yearsAgoDate(2008), "male");
  const nog = await signupG("GN3", "GN No Gender", yearsAgoDate(2008));
  ok(!nog.member.gender, "gender is optional at sign-up", nog.member.gender);
  const junk = await signupG("GN4", "GN Junk", yearsAgoDate(2008), "banana");
  ok(!junk.member.gender, "an unknown gender value is ignored at sign-up", junk.member.gender);
  let r = await api("/api/me/profile", { method: "PATCH", jar: nog.jar, body: { gender: "female" } });
  ok(r.status === 200 && r.json.member.gender === "female", "member sets gender on the profile", r.json);
  r = await api("/api/me/profile", { method: "PATCH", jar: nog.jar, body: { gender: "other" } });
  ok(r.status === 400, "invalid gender refused", r.json);
  r = await api("/api/me/profile", { method: "PATCH", jar: nog.jar, body: { gender: "" } });
  ok(r.status === 400, "gender cannot be blanked", r.json);
  // family
  r = await api("/api/me/dependents", { method: "POST", jar: girl.jar, body: { name: "GN Daughter", relationship: "Daughter", birthDate: yearsAgoDate(2011), gender: "female" } });
  ok(r.status === 201 && r.json.dependents[0].gender === "female", "family member added with gender", r.json);
  const daughterId = r.json.dependents[0].id;
  r = await api("/api/me/dependents", { method: "POST", jar: girl.jar, body: { name: "GN Son", relationship: "Son", birthDate: yearsAgoDate(2011) } });
  ok(r.status === 201, "family member without gender is allowed", r.json);
  const sonId = r.json.dependents.find((d) => d.name === "GN Son").id;
  r = await api(`/api/me/dependents/${sonId}`, { method: "PUT", jar: girl.jar, body: { gender: "male" } });
  ok(r.status === 200 && r.json.dependents.find((d) => d.id === sonId).gender === "male", "family member gender updated", r.json);
  r = await api(`/api/me/dependents/${sonId}`, { method: "PUT", jar: girl.jar, body: { gender: "x" } });
  ok(r.status === 400, "invalid family gender refused");

  section("B. Girls-only event (Red Rose Cup)");
  const cup = await mkEvent("GN Red Rose 13-20", addDays(40), { birthYearFrom: "2006", birthYearTo: "2013", genderRestriction: "female" });
  ok(cup.status === 201 && cup.json.genderRestriction === "female", "event created girls-only", cup.json);
  const listed = await evOf(cup.json.id);
  ok(listed && listed.genderRestriction === "female", "restriction is in the public event list", listed);
  r = await reg(girl, cup.json.id);
  ok([200, 201].includes(r.status), "a girl in the age range registers", r.json);
  r = await reg(boy, cup.json.id);
  ok(r.status === 403 && r.json.code === "not_eligible_gender", "a boy is refused", [r.status, r.json]);
  const noG = await signupG("GN5", "GN Unset", yearsAgoDate(2008));
  r = await reg(noG, cup.json.id);
  ok(r.status === 400 && r.json.code === "gender_required", "no gender on file: asked to add it first", [r.status, r.json]);
  const oldGirl = await signupG("GN6", "GN Old Girl", yearsAgoDate(1990), "female");
  r = await reg(oldGirl, cup.json.id);
  ok(r.status === 403 && r.json.code === "not_eligible", "a woman outside the birth years is refused by age", [r.status, r.json]);
  r = await api("/api/register", { method: "POST", jar: girl.jar, body: { eventId: cup.json.id, dependentId: daughterId } });
  ok([200, 201].includes(r.status), "a daughter (female, in range) registers under the parent", r.json);
  r = await api("/api/register", { method: "POST", jar: girl.jar, body: { eventId: cup.json.id, dependentId: sonId } });
  ok(r.status === 403 && r.json.code === "not_eligible_gender", "a son is refused", [r.status, r.json]);
  // mothers v daughters exhibition: women of any age
  const mv = await mkEvent("GN Mothers v Daughters", addDays(41), { genderRestriction: "female" });
  r = await reg(oldGirl, mv.json.id);
  ok([200, 201].includes(r.status), "a mother registers for the women-only exhibition", r.json);
  r = await reg(boy, mv.json.id);
  ok(r.status === 403, "a man is refused for the women-only exhibition");
  // boys-only and validation
  const bo = await mkEvent("GN Boys Cup", addDays(42), { genderRestriction: "male" });
  r = await reg(boy, bo.json.id);
  ok([200, 201].includes(r.status), "boys-only: a boy registers");
  r = await reg(girl, bo.json.id);
  ok(r.status === 403 && r.json.code === "not_eligible_gender", "boys-only: a girl is refused");
  const badGr = await mkEvent("GN Bad", addDays(43), { genderRestriction: "robots" });
  ok(badGr.status === 400, "unknown restriction refused", badGr.json);
  // edit: clear
  const f = new FormData();
  f.set("nameEn", "GN Boys Cup"); f.set("date", addDays(42)); f.set("genderRestriction", "");
  const ed = await api(`/api/events/${bo.json.id}`, { method: "PUT", jar: admin, body: f, isForm: true });
  ok(ed.status === 200 && ed.json.genderRestriction === "", "restriction cleared by an edit", ed.json);
  r = await reg(nog, bo.json.id);
  ok([200, 201].includes(r.status), "everyone can register once cleared", r.json);
  const f2 = new FormData();
  f2.set("nameEn", "GN Boys Cup"); f2.set("date", addDays(42));
  const ed2 = await api(`/api/events/${bo.json.id}`, { method: "PUT", jar: admin, body: f2, isForm: true });
  ok(ed2.status === 200 && ed2.json.genderRestriction === "", "edit without the field keeps it", ed2.json);
  // admin sets gender
  r = await A("/api/admin/members/GN5/gender", "PUT", { gender: "female" });
  ok(r.status === 200 && r.json.gender === "female", "admin sets a member's gender", r.json);
  r = await reg(noG, cup.json.id);
  ok([200, 201].includes(r.status), "after the admin sets gender the member can register", r.json);
  r = await A("/api/admin/members/GN5/gender", "PUT", { gender: "" });
  ok(r.status === 400, "admin cannot blank gender");
  r = await A("/api/admin/members/GN1/gender", "PUT", { gender: "male", dependentId: daughterId });
  ok(r.status === 200, "admin sets a family member's gender", r.json);
  r = await A("/api/admin/members/NOPE/gender", "PUT", { gender: "male" });
  ok(r.status === 404, "unknown member -> 404");
  const dir = await A("/api/admin/directory");
  const dm = (dir.json || []).find((m) => m.membershipNumber === "GN1");
  ok(dm && dm.gender === "female" && dm.dependents.find((d) => d.id === daughterId).gender === "male", "directory shows gender for member and family", dm && [dm.gender, dm.dependents]);
  const memberTry = await api("/api/admin/members/GN2/gender", { method: "PUT", jar: boy.jar, body: { gender: "female" } });
  ok([401, 403].includes(memberTry.status), "a member cannot use the admin endpoint", memberTry.status);

  section("C. Scorers and awards - individual league");
  const lgEv = await mkEvent("SC League", addDays(50));
  const lid = lgEv.json.id;
  const pl = [];
  for (let i = 1; i <= 4; i++) {
    const m = await signupG("SC" + i, "SC Player " + i, yearsAgoDate(2000), i % 2 ? "male" : "female");
    pl.push(m);
    const rr = await reg(m, lid);
    ok([200, 201].includes(rr.status), "player " + i + " registered", rr.json);
  }
  const mk = await A(`/api/admin/tournaments/${lid}`, "POST", { mode: "individual", format: "groups", finalsMode: "table" });
  ok(mk.status === 201, "league created", mk.json);
  let T = (await A(`/api/admin/tournaments/${lid}/generate`, "POST", {})).json.tournament;
  ok(T.awards && T.awards.topScorers.length === 0 && T.awards.bestPlayer === null && T.awards.fairPlay === null, "awards start empty", T.awards);
  const ms = T.groups[0].matches;
  const idOf = {};
  for (const m of ms) { idOf[m.aLabel] = m.a; idOf[m.bLabel] = m.b; }
  const P = (i) => idOf[Object.keys(idOf).find((k) => k.includes("SC Player " + i))];
  const matchOf = (x, y) => ms.find((m) => (m.a === P(x) && m.b === P(y)) || (m.a === P(y) && m.b === P(x)));
  const regs = (await A(`/api/admin/tournaments/${lid}`)).json.registrations;
  const att = (await A(`/api/admin/tournaments/${lid}`)).json.tournament.attendance;
  const regId = (i) => att.find((a) => a.name.includes("SC Player " + i)).registrationId;
  // before any score: scorers refused
  const m12 = matchOf(1, 2);
  r = await A(`/api/admin/tournaments/${lid}/match-scorers`, "PUT", { matchId: m12.id, scorers: [{ registrationId: regId(1), goals: 1 }] });
  ok(r.status === 400 && r.json.code === "score_first", "scorers need a score first", r.json);
  const setRes = (x, y, sx, sy) => { const m = matchOf(x, y); const [sa, sb] = m.a === P(x) ? [sx, sy] : [sy, sx]; return A(`/api/admin/tournaments/${lid}/group-result`, "PUT", { matchId: m.id, scoreA: sa, scoreB: sb }); };
  ok((await setRes(1, 2, 3, 1)).status === 200, "result 1 v 2 = 3-1");
  ok((await setRes(1, 3, 2, 0)).status === 200, "result 1 v 3 = 2-0");
  ok((await setRes(2, 3, 1, 1)).status === 200, "result 2 v 3 = 1-1");
  // record scorers: in individual mode each entrant is the single player
  r = await A(`/api/admin/tournaments/${lid}/match-scorers`, "PUT", { matchId: m12.id, scorers: [{ registrationId: regId(1), goals: 3 }, { registrationId: regId(2), goals: 1 }] });
  ok(r.status === 200, "scorers saved for 1 v 2", r.json);
  const mm = r.json.tournament.groups[0].matches.find((m) => m.id === m12.id);
  ok(mm.scorers.length === 2 && mm.scorers.find((s) => s.name.includes("Player 1")).goals === 3, "match shows its scorers", mm.scorers);
  r = await A(`/api/admin/tournaments/${lid}/match-scorers`, "PUT", { matchId: matchOf(1, 3).id, scorers: [{ registrationId: regId(1), goals: 2 }] });
  ok(r.status === 200, "scorers saved for 1 v 3");
  r = await A(`/api/admin/tournaments/${lid}/match-scorers`, "PUT", { matchId: matchOf(2, 3).id, scorers: [{ registrationId: regId(2), goals: 1 }, { registrationId: regId(3), goals: 1 }] });
  ok(r.status === 200, "scorers saved for 2 v 3");
  T = r.json.tournament;
  ok(T.awards.topScorers[0].name.includes("Player 1") && T.awards.topScorers[0].goals === 5, "top scorer = player 1 with 5 goals", T.awards.topScorers);
  ok(T.awards.topScorers[1].name.includes("Player 2") && T.awards.topScorers[1].goals === 2, "second scorer = player 2 with 2 goals", T.awards.topScorers);
  ok(T.awards.topScorer.length === 1 && T.awards.topScorer[0].goals === 5, "topScorer lists the leader", T.awards.topScorer);
  // validation
  r = await A(`/api/admin/tournaments/${lid}/match-scorers`, "PUT", { matchId: m12.id, scorers: [{ registrationId: regId(1), goals: 4 }] });
  ok(r.status === 400 && r.json.code === "scorers_exceed_score", "more goals than the score refused", r.json);
  r = await A(`/api/admin/tournaments/${lid}/match-scorers`, "PUT", { matchId: m12.id, scorers: [{ registrationId: regId(4), goals: 1 }] });
  ok(r.status === 400 && r.json.code === "scorer_not_in_match", "a scorer from another match refused", r.json);
  r = await A(`/api/admin/tournaments/${lid}/match-scorers`, "PUT", { matchId: m12.id, scorers: [{ registrationId: regId(1), goals: -1 }] });
  ok(r.status === 400, "negative goals refused");
  r = await A(`/api/admin/tournaments/${lid}/match-scorers`, "PUT", { matchId: m12.id, scorers: [{ registrationId: regId(1), goals: 1.5 }] });
  ok(r.status === 400, "fractional goals refused");
  r = await A(`/api/admin/tournaments/${lid}/match-scorers`, "PUT", { matchId: 99999, scorers: [] });
  ok(r.status === 404, "unknown match -> 404");
  r = await A(`/api/admin/tournaments/${lid}/match-scorers`, "PUT", { matchId: m12.id });
  ok(r.status === 400, "scorers list required");
  // a score correction below the credited goals is refused; above is fine
  r = await setRes(1, 2, 2, 1);
  ok(r.status === 409 && r.json.code === "scorers_exceed_score", "score can't drop below the credited goals", r.json);
  r = await setRes(1, 2, 4, 1);
  ok(r.status === 200, "score can go up", r.json);
  // fewer goals credited than scored is fine (own goals); clearing removes
  r = await A(`/api/admin/tournaments/${lid}/match-scorers`, "PUT", { matchId: matchOf(2, 3).id, scorers: [{ registrationId: regId(2), goals: 1 }] });
  ok(r.status === 200 && r.json.tournament.awards.topScorers.find((s) => s.name.includes("Player 3")) === undefined, "an uncredited goal (own goal) is allowed and player 3 drops off", r.json.tournament.awards.topScorers);
  r = await A(`/api/admin/tournaments/${lid}/match-scorers`, "PUT", { matchId: matchOf(2, 3).id, scorers: [] });
  ok(r.status === 200, "an empty list clears the match's scorers");
  r = await A(`/api/admin/tournaments/${lid}/match-scorers`, "PUT", { matchId: matchOf(2, 3).id, scorers: [{ registrationId: regId(2), goals: 1 }, { registrationId: regId(3), goals: 1 }] });
  // raising the score allows crediting more goals
  r = await A(`/api/admin/tournaments/${lid}/match-scorers`, "PUT", { matchId: m12.id, scorers: [{ registrationId: regId(1), goals: 4 }, { registrationId: regId(2), goals: 1 }] });
  ok(r.status === 200, "after raising the score, 4 goals can be credited", r.json);
  ok(r.json.tournament.awards.topScorers[0].goals === 6, "top scorer total follows the edit (4 + 2)", r.json.tournament.awards.topScorers);
  T = r.json.tournament;

  section("D. Awards");
  r = await A(`/api/admin/tournaments/${lid}/awards`, "PUT", { bestGoalkeeper: regId(3), bestPlayer: regId(1), fairPlay: P(4) });
  ok(r.status === 200, "awards saved", r.json);
  T = r.json.tournament;
  ok(T.awards.bestGoalkeeper.name.includes("Player 3") && T.awards.bestPlayer.name.includes("Player 1") && T.awards.fairPlay.label.includes("Player 4"), "awards returned with names", T.awards);
  r = await A(`/api/admin/tournaments/${lid}/awards`, "PUT", { bestPlayer: null });
  ok(r.status === 200 && r.json.tournament.awards.bestPlayer === null && r.json.tournament.awards.bestGoalkeeper, "clearing one award leaves the others", r.json.tournament.awards);
  r = await A(`/api/admin/tournaments/${lid}/awards`, "PUT", { bestGoalkeeper: 987654 });
  ok(r.status === 400, "a player outside the tournament refused", r.json);
  r = await A(`/api/admin/tournaments/${lid}/awards`, "PUT", { fairPlay: "reg987654" });
  ok(r.status === 400, "a team outside the tournament refused", r.json);
  // public view and season page
  const pub = await api(`/api/tournaments/${lid}`, { jar: newJar() });
  ok(pub.status === 200 && pub.json.tournament.awards.bestGoalkeeper && pub.json.tournament.awards.topScorers.length >= 2, "public tournament shows awards", pub.json.tournament && pub.json.tournament.awards);
  const season = await api(`/api/season/${lid}`, { jar: newJar() });
  ok(season.status === 200 && season.json.categories[0].awards && season.json.categories[0].awards.topScorers.length >= 2, "season calendar carries awards", season.json.categories && season.json.categories[0].awards);
  // permissions
  const memberTry2 = await api(`/api/admin/tournaments/${lid}/awards`, { method: "PUT", jar: pl[0].jar, body: { bestPlayer: regId(1) } });
  ok([401, 403].includes(memberTry2.status), "a member cannot set awards", memberTry2.status);
  const anonTry = await api(`/api/admin/tournaments/${lid}/match-scorers`, { method: "PUT", jar: newJar(), body: { matchId: m12.id, scorers: [] } });
  ok([401, 403].includes(anonTry.status), "anonymous cannot record scorers", anonTry.status);

  section("E. Scorers and awards - team league (finals included)");
  const teamEv = await mkEvent("SC Team League", addDays(60));
  const tid = teamEv.json.id;
  const tp = [];
  for (let i = 1; i <= 8; i++) {
    const m = await signupG("ST" + i, "ST Player " + i, yearsAgoDate(1995), "male");
    tp.push(m);
    const rr = await reg(m, tid);
    ok([200, 201].includes(rr.status), "team player " + i + " registered");
  }
  const tmk = await A(`/api/admin/tournaments/${tid}`, "POST", { mode: "team", format: "groups", finalsMode: "table" });
  ok(tmk.status === 201, "team league created", tmk.json);
  const tregs = (await A(`/api/admin/tournaments/${tid}`)).json.registrations;
  const trid = (i) => tregs.find((x) => JSON.stringify(x).includes("ST Player " + i + "\"") || JSON.stringify(x).includes("ST Player " + i + ",") || JSON.stringify(x).includes("ST Player " + i + " ")).id;
  const teamsBody = [1, 2, 3, 4].map((k) => ({ name: "Team " + k, memberIds: [trid(2 * k - 1), trid(2 * k)] }));
  r = await A(`/api/admin/tournaments/${tid}/teams`, "PUT", { teams: teamsBody });
  ok(r.status === 200, "four teams of two saved", r.json);
  const tg = await A(`/api/admin/tournaments/${tid}/generate`, "POST", {});
  ok(tg.status === 200, "team league generated", tg.json);
  let TT = tg.json.tournament;
  const tms = TT.groups[0].matches;
  const tEnt = TT.entrants;
  const teamByName = (n) => tEnt.find((e) => e.label === n);
  const tMatch = (x, y) => tms.find((m) => (m.a === teamByName("Team " + x).id && m.b === teamByName("Team " + y).id) || (m.b === teamByName("Team " + x).id && m.a === teamByName("Team " + y).id));
  const tSet = (x, y, sx, sy) => { const m = tMatch(x, y); const [sa, sb] = m.a === teamByName("Team " + x).id ? [sx, sy] : [sy, sx]; return A(`/api/admin/tournaments/${tid}/group-result`, "PUT", { matchId: m.id, scoreA: sa, scoreB: sb }); };
  for (const [x, y, sx, sy] of [[1, 2, 2, 0], [1, 3, 1, 0], [1, 4, 3, 0], [2, 3, 1, 0], [2, 4, 2, 0], [3, 4, 1, 0]]) {
    ok((await tSet(x, y, sx, sy)).status === 200, `team result ${x} v ${y}`);
  }
  const m = tMatch(1, 2);
  const tatt = (await A(`/api/admin/tournaments/${tid}`)).json.tournament.attendance;
  const tReg = (i) => tatt.find((a) => a.name.includes("ST Player " + i)).registrationId;
  r = await A(`/api/admin/tournaments/${tid}/match-scorers`, "PUT", { matchId: m.id, scorers: [{ registrationId: tReg(1), goals: 1 }, { registrationId: tReg(2), goals: 1 }] });
  ok(r.status === 200, "team match: two teammates credited", r.json);
  r = await A(`/api/admin/tournaments/${tid}/match-scorers`, "PUT", { matchId: m.id, scorers: [{ registrationId: tReg(1), goals: 3 }] });
  ok(r.status === 400 && r.json.code === "scorers_exceed_score", "team match: two goals for team 1, three refused", r.json);
  r = await A(`/api/admin/tournaments/${tid}/match-scorers`, "PUT", { matchId: m.id, scorers: [{ registrationId: tReg(5), goals: 1 }] });
  ok(r.status === 400 && r.json.code === "scorer_not_in_match", "team match: a player from a team not playing refused", r.json);
  r = await A(`/api/admin/tournaments/${tid}/match-scorers`, "PUT", { matchId: m.id, scorers: [{ registrationId: tReg(1), goals: 1 }, { registrationId: tReg(2), goals: 1 }] });
  ok(r.status === 200 && r.json.tournament.awards.topScorers.length === 2, "team goals roll up per player", r.json.tournament.awards.topScorers);
  ok(r.json.tournament.awards.topScorers[0].entrantLabel === "Team 1", "scorer carries the team name", r.json.tournament.awards.topScorers[0]);
  const fin = await A(`/api/admin/tournaments/${tid}/generate-knockout`, "POST", {});
  ok(fin.status === 200, "finals drawn", fin.json);
  const finalM = fin.json.tournament.knockout.rounds[0].find((x) => x.place === 1);
  const fr = await A(`/api/admin/tournaments/${tid}/knockout-result`, "PUT", { roundIndex: 0, matchId: finalM.id, scoreA: 2, scoreB: 1 });
  ok(fr.status === 200, "final scored 2-1", fr.json);
  const finalAfter = fr.json.tournament.knockout.rounds[0].find((x) => x.place === 1);
  const aSide = finalAfter.aLabel === "Team 1" ? "Team 1" : finalAfter.aLabel;
  const firstA = tatt.find((a) => a.entrantLabel === finalAfter.aLabel);
  r = await A(`/api/admin/tournaments/${tid}/match-scorers`, "PUT", { matchId: finalM.id, scorers: [{ registrationId: firstA.registrationId, goals: 2 }] });
  ok(r.status === 200, "scorers recorded on the Final", r.json);
  const kr = await A(`/api/admin/tournaments/${tid}/knockout-result`, "PUT", { roundIndex: 0, matchId: finalM.id, scoreA: 1, scoreB: 0 });
  ok(kr.status === 409 && kr.json.code === "scorers_exceed_score", "Final score can't drop below the credited goals", kr.json);
  r = await A(`/api/admin/tournaments/${tid}/awards`, "PUT", { bestGoalkeeper: tReg(8), fairPlay: teamByName("Team 3").id });
  ok(r.status === 200 && r.json.tournament.awards.fairPlay.label === "Team 3", "fair-play team award on a team league", r.json.tournament.awards);
  const tPub = await api(`/api/tournaments/${tid}`, { jar: newJar() });
  ok(tPub.json.tournament.knockout.rounds[0].some((x) => (x.scorers || []).length), "public bracket shows the Final's scorers");

  section("F. Static pages");
  for (const p of ["/awards.js", "/season.html", "/season.js"]) {
    const rr = await api(p, { jar: newJar(), raw: true });
    ok(rr.status === 200, p + " is served", rr.status);
  }
  ok(serverErrors.length === 0, "no server 5xx", serverErrors);
  console.log(`\nAwards E2E: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log("FATAL", e); process.exit(1); });
