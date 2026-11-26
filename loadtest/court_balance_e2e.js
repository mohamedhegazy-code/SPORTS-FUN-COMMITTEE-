// Court balance E2E: knockout courts are shared evenly, and a re-schedule keeps played matches.
"use strict";

const BASE = process.env.BASE_URL || "http://localhost:3913";
const ADMIN_USER = process.env.ADMIN_USER || "e2eadmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "E2ETest!2026xyz";
const POOL = Number(process.env.POOL || 70);

let pass = 0, fail = 0;
const failures = [];
const serverErrors = [];
const notes = [];
function ok(cond, label, extra) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
    console.log(`  FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : "");
  }
}
function note(s) { notes.push(s); console.log("  NOTE:", s); }
function section(t) { console.log(`\n=== ${t} ===`); }

// deterministic PRNG
let seed = 987654321;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

// ---- http client ---------------------------------------------------------
const newJar = () => ({});
function applySetCookies(jar, res) {
  const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const raw of sc) { const [pair] = raw.split(";"); const eq = pair.indexOf("="); if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); }
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
async function api(path, { method = "GET", body, jar, noCsrf = false, isForm = false, raw = false } = {}) {
  jar = jar || newJar();
  const headers = {};
  if (Object.keys(jar).length) headers.Cookie = cookieHeader(jar);
  if (!["GET", "HEAD"].includes(method) && jar.csrfToken && !noCsrf) headers["X-CSRF-Token"] = jar.csrfToken;
  let fb;
  if (body !== undefined) { if (isForm) fb = body; else { headers["Content-Type"] = "application/json"; fb = JSON.stringify(body); } }
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { res = await fetch(BASE + path, { method, headers, body: fb, redirect: "manual" }); break; }
    catch (e) { if (attempt === 2) return { status: 0, json: { networkError: String(e) }, jar }; await new Promise((r) => setTimeout(r, 80)); }
  }
  applySetCookies(jar, res);
  if (res.status >= 500) serverErrors.push(`${method} ${path} -> ${res.status}`);
  if (raw) { const text = await res.text(); return { status: res.status, text, type: res.headers.get("content-type") || "", jar }; }
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, jar };
}
const prime = async (jar) => { await api("/", { jar }); return jar; };

const admin = newJar();
const T = (eventId, suffix = "") => `/api/admin/tournaments/${eventId}${suffix}`;
const A = (path, method = "GET", body) => api(path, { method, jar: admin, body });

// ---- fixtures ------------------------------------------------------------
const pool = []; // {jar, num, regByEvent: {}}
let eventSeq = 0;
async function ensurePool(n) {
  while (pool.length < n) {
    const i = pool.length + 1;
    const jar = await prime(newJar());
    const r = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: `TM${i}`, name: `Matrix Player ${i}`, password: "abc12345", phone: `0105${String(i).padStart(7, "0")}`, agreeTerms: true, memberType: "main", birthDate: "1990-06-15" } });
    if (r.status !== 200 && r.status !== 201) throw new Error("signup failed " + JSON.stringify(r.json));
    pool.push({ jar, num: i, regByEvent: {} });
  }
}
async function mkEvent(label, sport) {
  const f = new FormData();
  const name = `${label} #${++eventSeq}`;
  f.set("nameEn", name); f.set("nameAr", name); f.set("sport", sport || "Chess"); f.set("date", "2026-12-15");
  const r = await api("/api/events", { method: "POST", jar: admin, body: f, isForm: true });
  if (r.status !== 200 && r.status !== 201) throw new Error("event create failed " + JSON.stringify(r.json));
  return r.json.id;
}

const POOL2 = 64;
const create = (eventId, body) => A(T(eventId), "POST", body);
async function enroll(eventId, n) {
  await ensurePool(n);
  for (let i = 0; i < n; i++) {
    const r = await api("/api/register", { method: "POST", jar: pool[i].jar, body: { eventId } });
    const id = r.json && ((r.json.registration && r.json.registration.id) || r.json.id);
    if (!id) { ok(false, "register " + i, r.json); continue; }
    await api("/api/checkin/manual", { method: "POST", jar: admin, body: { registrationId: id } });
  }
}
const counts = (matches, courts) => { const c = Array(courts + 1).fill(0); matches.forEach((m) => { c[m.court]++; }); return c.slice(1); };
async function main() {
  await prime(admin);
  const lg = await api("/api/auth/staff-login", { method: "POST", jar: admin, body: { username: ADMIN_USER, password: ADMIN_PASS } });
  ok(lg.status === 200, "admin login", lg.json);
  for (const COURTS of [6, 5, 7, 16]) {
    section(`64-player knockout on ${COURTS} courts`);
    const eventId = await mkEvent(`CourtBalance ${COURTS}`, "PlayStation");
    await enroll(eventId, POOL2);
    let r = await create(eventId, { mode: "individual", format: "knockout", courts: COURTS, matchMinutes: 15, startTime: "15:00" });
    ok(r.status === 201, "create", r.json);
    r = await A(T(eventId, "/generate"), "POST");
    ok(r.status === 200, "generate", r.json);
    const t0 = r.json.tournament;
    const all = t0.knockout.rounds.flat().filter((m) => !m.bye);
    ok(all.length === 63, "63 matches", all.length);
    const c = counts(all, COURTS);
    ok(Math.max(...c) - Math.min(...c) <= 1, `every court has the same number of matches (+/-1): ${c.join(",")}`, c);
    ok(new Set(all.map((m) => m.court + "@" + m.time)).size === all.length, "no court double-booked");
    // each round alone is also shared out fairly, never more than 1 apart from the ideal share
    t0.knockout.rounds.forEach((rd, i) => { const cc = counts(rd, COURTS); ok(Math.max(...cc) - Math.min(...cc) <= 1 || rd.length <= COURTS, `round ${i + 1} split ${cc.join(",")}`, cc); });
    if (COURTS === 6) {
      // play round 1 fully and 7 matches of round 2, then re-save the schedule
      let cur = t0;
      const playRound = async (ri, limit) => {
        let n = 0;
        for (const m0 of cur.knockout.rounds[ri]) {
          if (limit != null && n >= limit) break;
          const m = cur.knockout.rounds[ri].find((x) => x.id === m0.id);
          const rr = await A(T(eventId, "/knockout-result"), "PUT", { roundIndex: ri, matchId: m.id, scoreA: 2, scoreB: 1 });
          ok(rr.status === 200, `result r${ri} m${m.id}`, rr.json);
          cur = rr.json.tournament; n++;
        }
      };
      await playRound(0); await playRound(1, 7);
      const before = cur.knockout.rounds.flat().filter((m) => !m.bye && m.winnerId).map((m) => [m.id, m.court, m.time]);
      const s = await A(T(eventId, "/schedule"), "PUT", { courts: 6, matchMinutes: 15, startTime: "15:00" });
      ok(s.status === 200, "re-save schedule", s.json);
      const after = s.json.tournament.knockout.rounds.flat().filter((m) => !m.bye);
      const byId = Object.fromEntries(after.map((m) => [m.id, m]));
      ok(before.every(([id, court, time]) => byId[id].court === court && byId[id].time === time), "played matches keep their court and time after a re-schedule");
      ok(new Set(after.map((m) => m.court + "@" + m.time)).size === after.length, "no double-booking after re-schedule");
      const c2 = counts(after, 6);
      ok(Math.max(...c2) - Math.min(...c2) <= 1, `still balanced after re-schedule: ${c2.join(",")}`, c2);
      // changing the number of courts mid-event still gives a valid plan for what is left
      const s2 = await A(T(eventId, "/schedule"), "PUT", { courts: 4, matchMinutes: 15, startTime: "15:00" });
      ok(s2.status === 200, "re-save with 4 courts", s2.json);
      const after2 = s2.json.tournament.knockout.rounds.flat().filter((m) => !m.bye);
      ok(after2.every((m) => m.court >= 1 && m.time), "every match has a court and time with 4 courts");
      ok(new Set(after2.map((m) => m.court + "@" + m.time)).size === after2.length, "no double-booking with 4 courts");
    }
  }
  ok(serverErrors.length === 0, "no 5xx", serverErrors.slice(0, 5));
  console.log(`\nCourt balance E2E: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log("FAILED:\n  " + [...new Set(failures)].join("\n  "));
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
