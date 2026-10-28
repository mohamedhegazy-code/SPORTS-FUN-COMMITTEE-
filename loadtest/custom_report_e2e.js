// Admin custom report builder E2E: guards, spec sanitising, every filter, sort,
// group-by summaries, the registrations source (ages as of the event date),
// Excel export, A4 print page (+ HTML escaping), saved reports CRUD, and the
// first-login date-of-birth confirmation + member phone change that ship with it.
// Usage: BASE_URL=http://localhost:3917 node custom_report_e2e.js
"use strict";
const BASE = process.env.BASE_URL || "http://localhost:3917";
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
async function api(path, { method = "GET", body, jar, isForm = false, raw = false, buf = false } = {}) {
  jar = jar || newJar();
  const headers = {};
  if (Object.keys(jar).length) headers.Cookie = cookieHeader(jar);
  if (!["GET", "HEAD"].includes(method) && jar.csrfToken) headers["X-CSRF-Token"] = jar.csrfToken;
  let fb;
  if (body !== undefined) { if (isForm) fb = body; else { headers["Content-Type"] = "application/json"; fb = JSON.stringify(body); } }
  const res = await fetch(BASE + path, { method, headers, body: fb, redirect: "manual" });
  applySetCookies(jar, res);
  if (res.status >= 500) serverErrors.push(`${method} ${path} -> ${res.status}`);
  if (buf) return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type") || "", jar };
  if (raw) return { status: res.status, text: await res.text(), type: res.headers.get("content-type") || "", jar };
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, jar };
}
const prime = async (jar) => { await api("/", { jar }); return jar; };
const admin = newJar();
const A = (p, m = "GET", b) => api(p, { method: m, jar: admin, body: b });
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (n) => iso(new Date(Date.now() + n * 86400000));
const bd = (years) => iso(new Date(Date.now() - (years * 365.25 + 40) * 86400000));
async function mkEvent(nameEn, nameAr, date) {
  const f = new FormData();
  f.set("nameEn", nameEn); f.set("nameAr", nameAr); f.set("sport", "Chess"); f.set("date", date);
  const r = await api("/api/events", { method: "POST", jar: admin, body: f, isForm: true });
  if (![200, 201].includes(r.status)) throw new Error("event create failed " + JSON.stringify(r.json));
  return r.json.id;
}
async function signup(num, name, birthDate, extra = {}) {
  const jar = await prime(newJar());
  const r = await api("/api/auth/signup", { method: "POST", jar, body: { membershipNumber: num, name, password: "abc12345", phone: extra.phone || "0106" + num.replace(/\D/g, "").padStart(7, "0"), agreeTerms: true, memberType: "main", birthDate, ...extra } });
  if (![200, 201].includes(r.status)) throw new Error("signup failed " + JSON.stringify(r.json));
  return { jar, num, name, signup: r };
}
const run = (spec, lang = "en", jar = admin) => api("/api/admin/report-builder/run", { method: "POST", jar, body: { spec, lang } });
const namesOf = (out, col = "Name") => { const i = out.columns.findIndex((c) => c.label === col); return out.rows.map((r) => r[i]); };
const S = (over = {}, filters = {}) => ({ source: "people", columns: ["name", "kind", "age", "ageGroup", "phone"], filters: { search: "CRX", ...filters }, ...over });
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

(async () => {
  const lg = await api("/api/auth/staff-login", { method: "POST", jar: await prime(admin), body: { username: ADMIN_USER, password: ADMIN_PASS } });
  ok(lg.status === 200, "admin login", lg.json);

  section("Fixtures");
  const evA = await mkEvent("CRX Event A", "فعالية سي آر إكس أ", addDays(30));
  const evB = await mkEvent("CRX Event B", "فعالية سي آر إكس ب", addDays(10));
  const kid = await signup("CRX1", "CRX Kid", bd(8));
  const teen = await signup("CRX2", "CRX Teen", bd(14));
  const adult = await signup("CRX3", "CRX Adult 01099887766", bd(30), { phone: "+20 10 6111 1111" });
  const master = await signup("CRX4", "CRX Master <img src=x onerror=alert(1)>", bd(60));
  // turns 18 exactly on event A's day: 17 (Youth) today, 18 (Adults) at the event
  const ea = new Date(addDays(30) + "T00:00:00Z");
  const edgeBirth = iso(new Date(Date.UTC(ea.getUTCFullYear() - 18, ea.getUTCMonth(), ea.getUTCDate())));
  const edge = await signup("CRX5", "CRX Edge", edgeBirth);
  const fol = await signup("CRX6", "CRX Follower", bd(40), { memberType: "follower", relationshipToMain: "Spouse", familyGroup: "CRXFAM" });
  const np = await A("/api/admin/members", "POST", { membershipNumber: "CRX7", name: "CRX NoPhone" });
  ok([200, 201].includes(np.status), "admin adds member without phone / birthdate", np.json);
  const dep = await api("/api/me/dependents", { method: "POST", jar: adult.jar, body: { name: "CRX Child", relationship: "Son", birthDate: bd(9) } });
  ok([200, 201].includes(dep.status), "add dependent", dep.json);
  const depId = ((dep.json.dependents || []).slice(-1)[0] || dep.json.dependent || {}).id;
  const reg = async (m, ev, extra = {}) => { const r = await api("/api/register", { method: "POST", jar: m.jar, body: { eventId: ev, joinWaitlist: true, ...extra } }); ok([200, 201].includes(r.status), `register ${m.num}`, r.json); return r.json.registration || r.json; };
  const rKidA = await reg(kid, evA); await reg(teen, evA); const rAdultA = await reg(adult, evA);
  await reg(adult, evA, { dependentId: depId }); await reg(edge, evA); await reg(kid, evB);
  for (const rr of [rKidA, rAdultA]) { const c = await A("/api/checkin/manual", "POST", { registrationId: rr.id }); ok(c.status === 200, "check-in", c.json); }
  const tour = await prime(newJar());
  const mk = await A("/api/staff/accounts", "POST", { username: "crx_tour", password: "Role!Pass2026xyz", role: "tournament", name: "t" });
  ok([200, 201].includes(mk.status), "tournament account", mk.json);
  await api("/api/auth/staff-login", { method: "POST", jar: tour, body: { username: "crx_tour", password: "Role!Pass2026xyz" } });

  section("Guards");
  const anon = await prime(newJar());
  for (const [m, p, b] of [["GET", "/api/admin/report-builder/meta"], ["POST", "/api/admin/report-builder/run", { spec: {} }], ["POST", "/api/admin/report-builder/export", { spec: {} }], ["GET", "/api/admin/saved-reports"], ["POST", "/api/admin/saved-reports", { name: "x", spec: {} }]]) {
    const a = await api(p, { method: m, jar: anon, body: b });
    ok(a.status === 401, `anonymous ${m} ${p} -> 401`, a.status);
    const t = await api(p, { method: m, jar: tour, body: b });
    ok(t.status === 403, `tournament ${m} ${p} -> 403`, t.status);
  }
  for (const who of [anon, tour]) {
    const pr = await api(`/admin/print/custom-report?spec=${b64url(S())}`, { jar: who, raw: true });
    ok(pr.status === 401 || pr.status === 403, "print guarded", pr.status);
  }
  const mm = await api("/api/admin/report-builder/meta", { jar: kid.jar });
  ok(mm.status === 401 || mm.status === 403, "member cannot use the builder", mm.status);
  for (const f of ["custom_report.js", "age_utils.js"]) { const s = await api("/" + f, { jar: anon, raw: true }); ok(s.status === 404, `source file /${f} not served`, s.status); }

  section("Meta");
  let r = await A("/api/admin/report-builder/meta?lang=en");
  ok(r.status === 200 && r.json.meta.people.columns.length >= 20 && r.json.meta.registrations.columns.length >= 14, "meta catalogues", r.json && Object.keys(r.json));
  ok(r.json.events.some((e) => e.id === evA) && r.json.meta.options.ageGroups.length === 5 && Array.isArray(r.json.saved), "meta events/options/saved");
  const ar = await A("/api/admin/report-builder/meta?lang=ar");
  ok(ar.json.meta.people.columns[0].label === "الاسم", "arabic labels", ar.json.meta.people.columns[0]);

  section("People source: filters");
  r = await run(S());
  ok(r.status === 200, "run ok", r.json);
  let out = r.json;
  const all = namesOf(out);
  ok(out.total === 8 && all.length === 8, "8 people (7 members + 1 dependent)", { total: out.total, all });
  ok(all.includes("CRX Child") && all.includes("CRX NoPhone"), "dependent + admin-added listed");
  out = (await run(S({}, {}), "en")).json;
  const f = async (filters, over = {}) => (await run(S(over, filters))).json;
  ok(JSON.stringify(namesOf(await f({ ageGroups: ["under12"] })).sort()) === JSON.stringify(["CRX Child", "CRX Kid"]), "age group under12", null);
  ok(JSON.stringify(namesOf(await f({ ageMin: 10, ageMax: 20 }))) === JSON.stringify(["CRX Edge", "CRX Teen"]) || JSON.stringify(namesOf(await f({ ageMin: 10, ageMax: 20 })).sort()) === JSON.stringify(["CRX Edge", "CRX Teen"]), "age range 10-20 (teen + edge aged 17)", namesOf(await f({ ageMin: 10, ageMax: 20 })));
  ok(JSON.stringify(namesOf(await f({ ageGroups: ["none"] }))) === JSON.stringify(["CRX NoPhone"]), "age group none -> member without DOB");
  ok(JSON.stringify(namesOf(await f({ hasBirthDate: "no" }))) === JSON.stringify(["CRX NoPhone"]), "hasBirthDate=no");
  ok((await f({ hasBirthDate: "yes" })).total === 7, "hasBirthDate=yes -> 7");
  ok(JSON.stringify(namesOf(await f({ kinds: ["dependent"] }))) === JSON.stringify(["CRX Child"]), "dependents only");
  ok((await f({ kinds: ["member"] })).total === 7, "members only");
  ok(JSON.stringify(namesOf(await f({ memberTypes: ["follower"] }))) === JSON.stringify(["CRX Follower"]), "follower only");
  ok((await f({ memberTypes: ["main"] })).total === 6, "main members = 6", (await f({ memberTypes: ["main"] })).total);
  ok(JSON.stringify(namesOf(await f({ memberTypes: ["dependent"] }))) === JSON.stringify(["CRX Child"]), "memberType dependent");
  ok(JSON.stringify(namesOf(await f({ phone: "none" }))) === JSON.stringify(["CRX NoPhone"]), "phone none");
  ok((await f({ phone: "has" })).total === 7, "phone has -> 7 (child inherits parent's)");
  ok(namesOf(await f({ phoneContains: "0106 1111-111" })).sort().join() === "CRX Adult 01099887766,CRX Child", "phone contains ignores spaces/+ and dependent inherits parent's phone", namesOf(await f({ phoneContains: "0106 1111-111" })));
  ok(JSON.stringify(namesOf(await f({ familyGroup: "crxfam" }))) === JSON.stringify(["CRX Follower"]), "family group contains (case-insens.)");
  ok(JSON.stringify(namesOf(await f({}, { filters: { search: "CRX Master" } }))) === JSON.stringify(["CRX Master <img src=x onerror=alert(1)>"]), "search by name");
  ok(JSON.stringify(namesOf(await f({ search: "CRX7" }))) === JSON.stringify(["CRX NoPhone"]), "search by membership number");
  ok(JSON.stringify(namesOf(await f({ birthYearMin: new Date().getFullYear() - 10, birthYearMax: new Date().getFullYear() - 8 })).sort()) === JSON.stringify(["CRX Child", "CRX Kid"]), "birth year range");
  ok(namesOf(await f({ account: "none" })).sort().join() === "CRX Child,CRX NoPhone" || namesOf(await f({ account: "none" })).join() === "CRX NoPhone", "account none excludes members with a login", namesOf(await f({ account: "none" })));
  ok((await f({ account: "has" })).total === 6, "account has -> 6 (signed-up members)");
  ok((await f({ activity: "registered" })).total === 5 && (await f({ activity: "never_registered" })).total === 3, "activity registered / never registered", [(await f({ activity: "registered" })).total, (await f({ activity: "never_registered" })).total]);
  ok(JSON.stringify(namesOf(await f({ activity: "attended" })).sort()) === JSON.stringify(["CRX Adult 01099887766", "CRX Kid"]), "activity attended");
  const evOnly = await run(S({}, { events: [evB], activity: "registered" }));
  ok(JSON.stringify(namesOf(evOnly.json)) === JSON.stringify(["CRX Kid"]), "registered in event B only -> Kid", namesOf(evOnly.json));
  const dRange = await run(S({}, { from: addDays(20), activity: "registered" }));
    ok(dRange.json.total === 5, "registered in events from +20 days (Kid, Teen, Adult, Child, Edge)", { total: dRange.json.total, names: namesOf(dRange.json) });
  const stat = await f({ status: "archived" });
  ok(stat.total === 0, "archived only -> 0", stat.total);
  const pts = await run(S({ columns: ["name", "points", "registered", "attended"] }, { pointsMin: 1 }));
  ok(pts.status === 200 && pts.json.columns.length === 4, "points filter runs", pts.json);

  section("Sort, columns, group-by");
  out = (await run(S({ sortBy: "age", sortDir: "desc" }))).json;
  const ages = out.rows.map((r) => r[3]);
  ok(ages[0] === 60 || ages[0] === 59 || ages[0] >= 59, "age desc puts the oldest first", ages);
  ok(ages[ages.length - 1] === "", "empty age sorts last", ages);
  out = (await run(S({ sortBy: "name", sortDir: "asc" }))).json;
  const nm = namesOf(out);
  ok(JSON.stringify(nm) === JSON.stringify(nm.slice().sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true }))), "name asc");
  out = (await run({ source: "people", columns: ["email", "phone", "joinedAt"], filters: { search: "CRX" } })).json;
  ok(out.columns.map((c) => c.key).join() === "phone,email,joinedAt", "columns follow catalogue order and only the chosen ones", out.columns);
  const g = (await run({ source: "people", columns: ["name"], filters: { search: "CRX" }, groupBy: "ageGroup", layout: "both" })).json;
  ok(g.summary && g.summary.head.length === 6 && g.rows.length === 8, "group-by with detail", g.summary);
  const byLabel = Object.fromEntries(g.summary.rows.map((x) => [x[0], x[1]]));
  ok(byLabel["Kids (under 12)"] === 2 && byLabel["Youth (12–17)"] === 2 && byLabel["Adults (18–45)"] === 2 && byLabel["Masters (46+)"] === 1 && byLabel["Not set"] === 1, "age group counts", byLabel);
  ok(g.summary.rows.map((x) => x[0]).join() === ["Kids (under 12)", "Youth (12–17)", "Adults (18–45)", "Masters (46+)", "Not set"].join(), "group order", g.summary.rows.map((x) => x[0]));
  ok(g.summary.total[1] === 8 && g.summary.total[2] === "100.0%", "summary total row", g.summary.total);
  const gs = (await run({ source: "people", columns: ["name"], filters: { search: "CRX" }, groupBy: "memberType", layout: "summary" })).json;
  ok(gs.rows.length === 0 && gs.summary.rows.length === 3, "summary only has no detail rows", gs.summary);
  const gp = (await run({ source: "people", columns: ["name"], filters: { search: "CRX" }, groupBy: "hasPhone", layout: "summary" }, "ar")).json;
  ok(gp.summary.rows.map((x) => x[0]).join() === "لديه هاتف,بلا هاتف", "arabic group labels", gp.summary.rows);

  section("Registrations source (ages as of the event date)");
  const rg = (spec) => run({ source: "registrations", columns: ["eventName", "name", "kind", "age", "ageGroup", "status", "phone"], filters: { search: "CRX", ...spec } });
  out = (await rg({ events: [evA] })).json;
  ok(out.total === 5 && namesOf(out).includes("CRX Child"), "5 registrations in event A (incl. dependent)", namesOf(out));
  const ci = (n) => out.columns.findIndex((c) => c.label === n);
  const edgeRow = out.rows.find((x) => x[ci("Name")] === "CRX Edge");
  ok(edgeRow && edgeRow[ci("Age (at event)")] === 18 && edgeRow[ci("Age group (at event)")] === "Adults (18–45)", "edge member counted as 18 / Adults at the event date", edgeRow);
  const ppl = (await run(S({}, { search: "CRX Edge" }))).json;
  ok(ppl.rows[0][4] === "Youth (12–17)" && ppl.rows[0][3] === 17, "same person is 17 / Youth today in the people list", ppl.rows);
  const childRow = out.rows.find((x) => x[ci("Name")] === "CRX Child");
  ok(childRow[ci("Type")] === "Family member" && childRow[ci("Phone")] === "+20 10 6111 1111", "dependent registration: kind + parent's phone", childRow);
  ok(JSON.stringify(namesOf((await rg({ events: [evA], regStatus: ["checkedin"] })).json).sort()) === JSON.stringify(["CRX Adult 01099887766", "CRX Kid"]), "regStatus checked-in only");
  ok((await rg({ events: [evA], regStatus: ["confirmed"] })).json.total === 3, "regStatus confirmed only", (await rg({ events: [evA], regStatus: ["confirmed"] })).json.total);
  ok((await rg({ ageGroups: ["under12"] })).json.total === 3, "under12 registrations (Kid x2 + Child)", namesOf((await rg({ ageGroups: ["under12"] })).json));
  ok((await rg({ from: addDays(20) })).json.total === 5, "date range keeps only event A", null);
  const gg = (await run({ source: "registrations", columns: ["name"], filters: { search: "CRX" }, groupBy: "event", layout: "summary" })).json;
  ok(gg.summary.rows.length === 2 && gg.summary.rows[0][0].includes("CRX Event B") && gg.summary.total[1] === 6, "group by event (date order)", gg.summary);
  ok(gg.summary.head[5] === "Attendance rate" && gg.summary.rows[1][4] === 2 && gg.summary.rows[1][5] === "40.0%", "attendance rate", gg.summary.rows);
  const gAr = (await run({ source: "registrations", columns: ["eventName"], filters: { search: "CRX" } }, "ar")).json;
  ok(gAr.rows.some((x) => x[0].includes("فعالية سي آر إكس")), "arabic event names");

  section("Spec sanitising");
  const junk = await run({ source: "<script>", columns: ["__proto__", "passwordHash", "constructor"], filters: { ageMin: "abc", ageMax: -5, kinds: ["x"], events: ["a", -1, 3.5], search: "CRX", status: "weird", from: "not-a-date" }, sortBy: "passwordHash", groupBy: "__proto__", layout: "weird" });
  ok(junk.status === 200 && junk.json.spec.source === "people" && junk.json.columns.length > 0 && junk.json.columns.every((c) => ["name", "kind", "membershipNumber", "memberType", "phone", "birthYear", "age", "ageGroup"].includes(c.key)), "junk spec falls back to defaults", junk.json && junk.json.spec);
  ok(junk.json.spec.filters.ageMin === null && junk.json.spec.filters.status === "active" && junk.json.spec.filters.from === "" && junk.json.spec.sortBy === "" && junk.json.spec.groupBy === "" && junk.json.spec.layout === "detail", "junk filters clamped", junk.json.spec.filters);
  const empty = await api("/api/admin/report-builder/run", { method: "POST", jar: admin, body: {} });
  ok(empty.status === 200, "empty body still runs", empty.status);
  const trunc = await run({ source: "people", columns: ["name"], filters: {} });
  ok(trunc.json.rows.length <= 1000, "preview capped at 1000", trunc.json.rows.length);

  section("Excel export");
  const x = await api("/api/admin/report-builder/export", { method: "POST", jar: admin, body: { spec: S({ groupBy: "ageGroup", layout: "both" }), lang: "en" }, buf: true });
  ok(x.status === 200 && /spreadsheetml/.test(x.type), "export is xlsx", x.type);
  const XLSX = require("xlsx");
  const wb = XLSX.read(x.buffer, { type: "buffer" });
  ok(wb.SheetNames.join() === "Report,Summary,Filters", "sheets Report/Summary/Filters", wb.SheetNames);
  const rep = XLSX.utils.sheet_to_json(wb.Sheets.Report, { header: 1 });
  ok(rep[0].join() === "Name,Type,Phone,Age,Age group" && rep.length === 9, "report sheet header + 8 rows", [rep[0], rep.length]);
  const flt = XLSX.utils.sheet_to_json(wb.Sheets.Filters, { header: 1 }).flat().join(" | ");
  ok(/Search: CRX/.test(flt) && /Grouped by: Age group/.test(flt) && /Results: 8/.test(flt), "filters sheet describes the report", flt);
  const inj = await api("/api/admin/report-builder/export", { method: "POST", jar: admin, body: { spec: S({ columns: ["name"] }, { search: "CRX Master" }) }, buf: true });
  const injRows = XLSX.utils.sheet_to_json(XLSX.read(inj.buffer, { type: "buffer" }).Sheets["Report"] || XLSX.read(inj.buffer, { type: "buffer" }).Sheets["التقرير"], { header: 1 });
  ok(injRows.length === 2, "export with arabic-or-english sheet name works", injRows.length);
  const xa = await api("/api/admin/report-builder/export", { method: "POST", jar: admin, body: { spec: S(), lang: "ar" }, buf: true });
  ok(XLSX.read(xa.buffer, { type: "buffer" }).SheetNames[0] === "التقرير", "arabic export sheet names");

  section("Print page");
  let pr = await api(`/admin/print/custom-report?lang=en&spec=${b64url(S({ groupBy: "ageGroup", layout: "both" }))}`, { jar: admin, raw: true });
  ok(pr.status === 200 && /text\/html/.test(pr.type) && pr.text.includes('id="print-btn"') && pr.text.includes("CRX Kid") && pr.text.includes("Summary by"), "print page renders", pr.status);
  ok(!pr.text.includes("@page { size: A4 landscape"), "few columns -> portrait");
  pr = await api(`/admin/print/custom-report?lang=ar&spec=${b64url({ source: "people", columns: ["name", "kind", "membershipNumber", "memberType", "phone", "email", "birthDate", "birthYear", "age", "ageGroup"], filters: { search: "CRX Master" } })}`, { jar: admin, raw: true });
  ok(pr.status === 200 && pr.text.includes('dir="rtl"') && pr.text.includes("A4 landscape"), "many columns -> landscape + rtl", pr.status);
  ok(!pr.text.includes("<img src=x") && pr.text.includes("&lt;img src=x"), "HTML in names is escaped", null);
  pr = await api(`/admin/print/custom-report?spec=${b64url(S({}, { search: "<script>alert(1)</script>" }))}`, { jar: admin, raw: true });
  ok(pr.status === 200 && !pr.text.includes("<script>alert(1)</script>") && pr.text.includes("&lt;script&gt;alert(1)"), "XSS in a filter value is escaped in the header", null);
  pr = await api("/admin/print/custom-report?spec=%%%", { jar: admin, raw: true });
  ok(pr.status === 400, "bad spec -> 400", pr.status);
  pr = await api(`/admin/print/custom-report?spec=${"A".repeat(9000)}`, { jar: admin, raw: true });
  ok(pr.status === 400, "oversized spec -> 400", pr.status);
  pr = await api(`/admin/print/custom-report?spec=${Buffer.from("not json").toString("base64url")}`, { jar: admin, raw: true });
  ok(pr.status === 400, "non-JSON spec -> 400", pr.status);

  section("Saved reports");
  let sv = await A("/api/admin/saved-reports", "POST", { name: "  Kids with phones ", spec: S({ groupBy: "ageGroup", layout: "both" }, { ageGroups: ["under12"], phone: "has" }) });
  ok(sv.status === 201 && sv.json.name === "Kids with phones" && sv.json.spec.filters.ageGroups[0] === "under12", "create", sv.json);
  const id = sv.json.id;
  ok((await A("/api/admin/saved-reports", "POST", { name: "kids WITH phones", spec: {} })).status === 409, "duplicate name (case-insens.) -> 409");
  ok((await A("/api/admin/saved-reports", "POST", { name: "   ", spec: {} })).status === 400, "blank name -> 400");
  sv = await A("/api/admin/saved-reports", "POST", { name: "x".repeat(200), spec: { source: "registrations", columns: ["name"], filters: { ageMin: 5 } } });
  ok(sv.status === 201 && sv.json.name.length === 80 && sv.json.spec.filters.regStatus.join() === "confirmed,checkedin", "long name trimmed + spec normalised", sv.json);
  const id2 = sv.json.id;
  let ls = await A("/api/admin/saved-reports");
  ok(ls.json.length === 2, "list has 2", ls.json.length);
  let mt = await A("/api/admin/report-builder/meta?lang=en");
  ok(mt.json.saved.length === 2 && mt.json.saved[0].spec, "meta carries the saved list");
  let up = await A(`/api/admin/saved-reports/${id}`, "PUT", { name: "Kids (updated)", spec: S({}, { ageGroups: ["12to17"] }) });
  ok(up.status === 200 && up.json.name === "Kids (updated)" && up.json.spec.filters.ageGroups[0] === "12to17", "update", up.json);
  ok((await A(`/api/admin/saved-reports/${id}`, "PUT", { name: "x".repeat(200).slice(0, 80), spec: {} })).status === 409, "rename onto an existing name -> 409");
  ok((await A("/api/admin/saved-reports/99999", "PUT", { name: "z", spec: {} })).status === 404, "update unknown -> 404");
  pr = await api(`/admin/print/custom-report?id=${id}&lang=en`, { jar: admin, raw: true });
  ok(pr.status === 200 && pr.text.includes("Kids (updated)") && pr.text.includes("CRX Teen") && !pr.text.includes("CRX Kid"), "print by saved id uses the saved spec + name", pr.status);
  ok((await api("/admin/print/custom-report?id=99999", { jar: admin, raw: true })).status === 404, "print unknown id -> 404");
  ok((await A(`/api/admin/saved-reports/${id}`, "DELETE")).status === 200 && (await A(`/api/admin/saved-reports/${id2}`, "DELETE")).status === 200, "delete");
  ok((await A(`/api/admin/saved-reports/${id}`, "DELETE")).status === 404, "delete twice -> 404");
  ok((await A("/api/admin/saved-reports")).json.length === 0, "list empty again");
  const log = await A("/api/admin/activity-log");
  const logText = JSON.stringify(log.json);
  ok(/saved_report_create/.test(logText) && /saved_report_update/.test(logText) && /saved_report_delete/.test(logText), "saved-report actions are in the activity log");

  section("First-login birthdate confirmation");
  let me = await api("/api/auth/me", { jar: kid.jar });
  const mem = (me.json && (me.json.member || (me.json.session && me.json.session.member))) || null;
  ok(!!mem && !!mem.birthConfirmedAt, "member who typed their date at sign-up is already confirmed", mem && mem.birthConfirmedAt);
  // a member the committee pre-loaded (date from the club's records) must confirm
  const pre = await A("/api/admin/members", "POST", { membershipNumber: "CRX8", name: "CRX Preloaded", phone: "01055550000", birthDate: bd(25) });
  ok([200, 201].includes(pre.status), "admin pre-loads member with a birth date", pre.json);
  const claimer = await prime(newJar());
  const cl = await api("/api/auth/signup", { method: "POST", jar: claimer, body: { membershipNumber: "CRX8", name: "CRX Preloaded", password: "abc12345", phone: "01055550000", agreeTerms: true, memberType: "main", birthDate: bd(40) } });
  ok([200, 201].includes(cl.status), "claims the pre-loaded profile", cl.json);
  me = await api("/api/auth/me", { jar: claimer });
  const cm = (me.json && (me.json.member || (me.json.session && me.json.session.member))) || {};
  ok(!cm.birthConfirmedAt && cm.birthDate === bd(25), "committee's date wins and is NOT yet confirmed", { c: cm.birthConfirmedAt, d: cm.birthDate });
  ok((await api("/api/me/birth-date/confirm", { method: "POST", jar: claimer, body: { birthDate: "2999-01-01" } })).status === 400, "future date rejected");
  ok((await api("/api/me/birth-date/confirm", { method: "POST", jar: claimer, body: { birthDate: "" } })).status === 400, "blank date rejected");
  ok((await api("/api/me/birth-date/confirm", { method: "POST", jar: claimer, body: { birthDate: "2010-02-31" } })).status === 400, "impossible date rejected");
  const cf = await api("/api/me/birth-date/confirm", { method: "POST", jar: claimer, body: { birthDate: bd(26) } });
  ok(cf.status === 200 && cf.json.member.birthDate === bd(26) && !!cf.json.member.birthConfirmedAt, "confirm with a corrected date", cf.json);
  ok(cf.json.member.ageGroup === "18to45", "age group recalculated", cf.json.member.ageGroup);
  ok((await api("/api/me/birth-date/confirm", { method: "POST", jar: tour, body: { birthDate: bd(26) } })).status !== 200, "staff cannot use the member endpoint");
  ok((await api("/api/me/birth-date/confirm", { method: "POST", jar: anon, body: { birthDate: bd(26) } })).status === 401, "anonymous 401");
  const cfRows = (await run({ source: "people", columns: ["name", "birthConfirmed"], filters: { search: "CRX8", birthConfirmed: "yes" } })).json;
  ok(cfRows.total === 1 && cfRows.rows[0][1] === "Yes", "report column / filter: birth date confirmed", cfRows.rows);
  const nc = (await run({ source: "people", columns: ["name", "birthConfirmed"], filters: { search: "CRX", birthConfirmed: "no" } })).json;
  ok(nc.total === 1 && nc.rows[0][0] === "CRX NoPhone", "filter: not confirmed -> admin-added member only", nc.rows);
  ok(/member_birthdate_changed/.test(JSON.stringify((await A("/api/admin/activity-log")).json)), "date change is in the activity log");

  section("Member changes own / family mobile numbers");
  let pp = await api("/api/me/profile", { method: "PATCH", jar: kid.jar, body: { phone: " 01234567890 " } });
  ok(pp.status === 200 && pp.json.member.phone === "01234567890", "member changes own phone (trimmed)", pp.json);
  ok((await api("/api/me/profile", { method: "PATCH", jar: kid.jar, body: { phone: "   " } })).status === 400, "cannot blank the own phone");
  const pl = (await run({ source: "people", columns: ["name", "phone"], filters: { search: "CRX Kid" } })).json;
  ok(pl.rows[0][1] === "01234567890", "the report shows the new phone");
  ok(/member_phone_changed/.test(JSON.stringify((await A("/api/admin/activity-log")).json)), "phone change logged");
  const dp = await api(`/api/me/dependents/${depId}`, { method: "PUT", jar: adult.jar, body: { phone: "01299999999" } });
  ok(dp.status === 200 && dp.json.dependents.find((d) => d.id === depId).phone === "01299999999", "member changes a family member's phone", dp.json);
  const ch = (await run({ source: "people", columns: ["name", "phone"], filters: { search: "CRX Child" } })).json;
  ok(ch.rows[0][1] === "01299999999", "child's own phone now reported (no parent fallback)", ch.rows);

  ok(serverErrors.length === 0, "no 5xx", serverErrors);
  console.log(`\nCustom report E2E: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
