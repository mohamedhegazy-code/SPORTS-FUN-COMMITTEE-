"use strict";
// Admin custom report builder: the admin picks a SOURCE (people or event
// registrations), which COLUMNS to show, any mix of FILTERS, a sort order and
// an optional GROUP BY summary. Everything is whitelisted here - a spec that
// arrives from the browser is normalised first, so unknown keys are ignored
// and values are clamped. Pure functions (no I/O); server.js wires the routes.

const AgeUtils = require("./age_utils");

const L = (ar, en) => ({ ar, en });
const AGE_KEYS = ["under12", "12to17", "18to45", "46plus", "none"];
const AGE_LABELS = {
  under12: L("أطفال (أقل من 12)", "Kids (under 12)"),
  "12to17": L("شباب (12–17)", "Youth (12–17)"),
  "18to45": L("بالغون (18–45)", "Adults (18–45)"),
  "46plus": L("ماسترز (+46)", "Masters (46+)"),
  none: L("غير محدد", "Not set"),
};
const MEMBER_TYPES = ["main", "follower", "dependent"];
const MEMBER_TYPE_LABELS = {
  main: L("عضو أساسي", "Main member"),
  follower: L("عضو تابع", "Follower member"),
  dependent: L("فرد عائلة", "Family member"),
};
const KIND_LABELS = { member: L("عضو", "Member"), dependent: L("فرد عائلة", "Family member") };
const REG_STATUS = ["confirmed", "checkedin", "waitlist"];
const REG_STATUS_LABELS = {
  confirmed: L("مؤكد (لم يحضر)", "Confirmed (not checked in)"),
  checkedin: L("حضر", "Checked in"),
  waitlist: L("قائمة انتظار", "Waiting list"),
};
const YES = L("نعم", "Yes");
const NO = L("لا", "No");

// ------------------------------------------------------------- catalogs --
// key, label, default visible, sortable kind ("s" text / "n" number / "d" date)
const PEOPLE_COLUMNS = [
  { key: "name", label: L("الاسم", "Name"), def: true, t: "s" },
  { key: "kind", label: L("النوع", "Type"), def: true, t: "s" },
  { key: "membershipNumber", label: L("رقم العضوية", "Membership no."), def: true, t: "s" },
  { key: "memberType", label: L("فئة العضوية", "Member type"), def: true, t: "s" },
  { key: "parentName", label: L("فرد عائلة لدى", "Family member of"), def: false, t: "s" },
  { key: "relationship", label: L("صلة القرابة", "Relationship"), def: false, t: "s" },
  { key: "phone", label: L("الهاتف", "Phone"), def: true, t: "s" },
  { key: "email", label: L("البريد الإلكتروني", "Email"), def: false, t: "s" },
  { key: "familyGroup", label: L("مجموعة العائلة", "Family group"), def: false, t: "s" },
  { key: "birthDate", label: L("تاريخ الميلاد", "Date of birth"), def: true, t: "d" },
  { key: "birthYear", label: L("سنة الميلاد", "Birth year"), def: false, t: "n" },
  { key: "age", label: L("العمر", "Age"), def: true, t: "n" },
  { key: "ageGroup", label: L("الفئة العمرية", "Age group"), def: true, t: "s" },
  { key: "birthConfirmed", label: L("أكّد تاريخ ميلاده", "Birth date confirmed"), def: false, t: "s" },
  { key: "hasAccount", label: L("لديه حساب دخول", "Has a login"), def: false, t: "s" },
  { key: "status", label: L("حالة العضوية", "Membership status"), def: false, t: "s" },
  { key: "points", label: L("رصيد النقاط", "Points balance"), def: false, t: "n" },
  { key: "registered", label: L("عدد التسجيلات", "Registrations"), def: false, t: "n" },
  { key: "attended", label: L("عدد مرات الحضور", "Check-ins"), def: false, t: "n" },
  { key: "lastEventDate", label: L("تاريخ آخر فعالية", "Last event date"), def: false, t: "d" },
  { key: "joinedAt", label: L("تاريخ الانضمام", "Joined"), def: false, t: "d" },
];
const REG_COLUMNS = [
  { key: "eventName", label: L("الفعالية", "Event"), def: true, t: "s" },
  { key: "eventDate", label: L("تاريخ الفعالية", "Event date"), def: true, t: "d" },
  { key: "sport", label: L("النشاط", "Sport"), def: false, t: "s" },
  { key: "name", label: L("الاسم", "Name"), def: true, t: "s" },
  { key: "kind", label: L("النوع", "Type"), def: false, t: "s" },
  { key: "membershipNumber", label: L("رقم العضوية", "Membership no."), def: true, t: "s" },
  { key: "memberType", label: L("فئة العضوية", "Member type"), def: false, t: "s" },
  { key: "phone", label: L("الهاتف", "Phone"), def: true, t: "s" },
  { key: "birthDate", label: L("تاريخ الميلاد", "Date of birth"), def: true, t: "d" },
  { key: "birthYear", label: L("سنة الميلاد", "Birth year"), def: false, t: "n" },
  { key: "age", label: L("العمر (وقت الفعالية)", "Age (at event)"), def: true, t: "n" },
  { key: "ageGroup", label: L("الفئة العمرية (وقت الفعالية)", "Age group (at event)"), def: true, t: "s" },
  { key: "status", label: L("الحالة", "Status"), def: true, t: "s" },
  { key: "registeredAt", label: L("تاريخ التسجيل", "Registered on"), def: false, t: "d" },
  { key: "checkedInAt", label: L("وقت الحضور", "Checked in at"), def: false, t: "d" },
  { key: "points", label: L("النقاط الممنوحة", "Points awarded"), def: false, t: "n" },
  { key: "early", label: L("تسجيل مبكر", "Early registration"), def: false, t: "s" },
];
const PEOPLE_GROUPS = [
  { key: "ageGroup", label: L("الفئة العمرية", "Age group") },
  { key: "memberType", label: L("فئة العضوية", "Member type") },
  { key: "kind", label: L("النوع (عضو / فرد عائلة)", "Type (member / family member)") },
  { key: "birthYear", label: L("سنة الميلاد", "Birth year") },
  { key: "hasPhone", label: L("وجود رقم هاتف", "Has a phone number") },
  { key: "hasAccount", label: L("وجود حساب دخول", "Has a login") },
  { key: "status", label: L("حالة العضوية", "Membership status") },
];
const REG_GROUPS = [
  { key: "event", label: L("الفعالية", "Event") },
  { key: "ageGroup", label: L("الفئة العمرية", "Age group") },
  { key: "memberType", label: L("فئة العضوية", "Member type") },
  { key: "kind", label: L("النوع (عضو / فرد عائلة)", "Type (member / family member)") },
  { key: "status", label: L("الحالة", "Status") },
  { key: "hasPhone", label: L("وجود رقم هاتف", "Has a phone number") },
];

const SOURCES = {
  people: { columns: PEOPLE_COLUMNS, groups: PEOPLE_GROUPS },
  registrations: { columns: REG_COLUMNS, groups: REG_GROUPS },
};

const pick = (o, lang) => (o ? (lang === "ar" ? o.ar : o.en) : "");
function meta(lang) {
  const out = {};
  for (const [src, def] of Object.entries(SOURCES)) {
    out[src] = {
      columns: def.columns.map((c) => ({ key: c.key, label: pick(c.label, lang), def: c.def })),
      groups: def.groups.map((g) => ({ key: g.key, label: pick(g.label, lang) })),
    };
  }
  out.options = {
    ageGroups: AGE_KEYS.map((k) => ({ key: k, label: pick(AGE_LABELS[k], lang) })),
    memberTypes: MEMBER_TYPES.map((k) => ({ key: k, label: pick(MEMBER_TYPE_LABELS[k], lang) })),
    regStatus: REG_STATUS.map((k) => ({ key: k, label: pick(REG_STATUS_LABELS[k], lang) })),
  };
  return out;
}

// -------------------------------------------------------- spec handling --
const clampStr = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const intOrNull = (v, lo, hi) => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};
const dateOrEmpty = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");
const inList = (v, list, dflt) => (list.includes(v) ? v : dflt);
const subset = (arr, allowed) => (Array.isArray(arr) ? Array.from(new Set(arr.map(String).filter((x) => allowed.includes(x)))) : []);

function normalizeSpec(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  const source = raw.source === "registrations" ? "registrations" : "people";
  const def = SOURCES[source];
  const allCols = def.columns.map((c) => c.key);
  let columns = subset(raw.columns, allCols);
  // keep the catalogue order so the table always reads the same way
  columns = allCols.filter((k) => columns.includes(k));
  if (!columns.length) columns = def.columns.filter((c) => c.def).map((c) => c.key);
  const f = raw.filters && typeof raw.filters === "object" ? raw.filters : {};
  const filters = {
    kinds: subset(f.kinds, ["member", "dependent"]),
    memberTypes: subset(f.memberTypes, MEMBER_TYPES),
    ageGroups: subset(f.ageGroups, AGE_KEYS),
    ageMin: intOrNull(f.ageMin, 0, 120),
    ageMax: intOrNull(f.ageMax, 0, 120),
    birthYearMin: intOrNull(f.birthYearMin, 1900, 2100),
    birthYearMax: intOrNull(f.birthYearMax, 1900, 2100),
    hasBirthDate: inList(f.hasBirthDate, ["yes", "no"], ""),
    birthConfirmed: inList(f.birthConfirmed, ["yes", "no"], ""),
    phone: inList(f.phone, ["has", "none"], ""),
    phoneContains: clampStr(f.phoneContains, 40),
    search: clampStr(f.search, 80),
    familyGroup: clampStr(f.familyGroup, 80),
    account: inList(f.account, ["has", "none"], ""),
    status: inList(f.status, ["active", "archived", "all"], "active"),
    activity: inList(f.activity, ["registered", "never_registered", "attended", "never_attended"], ""),
    pointsMin: intOrNull(f.pointsMin, -1e9, 1e9),
    pointsMax: intOrNull(f.pointsMax, -1e9, 1e9),
    events: Array.isArray(f.events) ? Array.from(new Set(f.events.map(Number).filter((n) => Number.isInteger(n) && n > 0))).slice(0, 2000) : [],
    from: dateOrEmpty(f.from),
    to: dateOrEmpty(f.to),
    regStatus: subset(f.regStatus, REG_STATUS),
  };
  if (source === "registrations" && !filters.regStatus.length) filters.regStatus = ["confirmed", "checkedin"];
  const sortKeys = allCols;
  const sortBy = sortKeys.includes(raw.sortBy) ? raw.sortBy : "";
  const sortDir = raw.sortDir === "desc" ? "desc" : "asc";
  const groupBy = def.groups.some((g) => g.key === raw.groupBy) ? raw.groupBy : "";
  const layout = inList(raw.layout, ["detail", "summary", "both"], "detail");
  return { source, columns, filters, sortBy, sortDir, groupBy, layout: groupBy ? layout : "detail" };
}

// --------------------------------------------------------- data building --
// env: { db, balanceOf(membershipNumber) -> number, pointsOf(reg) -> number }
function buildPeople(env, spec, today) {
  const { db } = env;
  const f = spec.filters;
  const scoped = f.events.length || f.from || f.to;
  const evById = new Map(db.events.map((e) => [e.id, e]));
  const evSet = f.events.length ? new Set(f.events) : null;
  const stats = new Map(); // personKey -> { reg, att, last }
  for (const r of db.registrations) {
    const ev = evById.get(r.eventId);
    if (!ev) continue;
    if (evSet && !evSet.has(r.eventId)) continue;
    if (f.from && String(ev.date) < f.from) continue;
    if (f.to && String(ev.date) > f.to) continue;
    if (r.waitlisted) continue;
    const key = `${r.membershipNumber}#${r.dependentName ? r.dependentId || 0 : ""}`;
    let s = stats.get(key);
    if (!s) stats.set(key, (s = { reg: 0, att: 0, last: "" }));
    s.reg++;
    if (r.checkedIn) s.att++;
    if (String(ev.date) > s.last) s.last = String(ev.date);
  }
  const needPoints = spec.columns.includes("points") || f.pointsMin != null || f.pointsMax != null || spec.sortBy === "points";
  const rows = [];
  for (const m of Object.values(db.members)) {
    const archived = !!m.archivedAt;
    const bal = needPoints ? env.balanceOf(m.membershipNumber) : null;
    const mk = (kind, p, dep) => {
      const ai = AgeUtils.ageInfo(p);
      const s = stats.get(`${m.membershipNumber}#${dep ? dep.id : ""}`) || { reg: 0, att: 0, last: "" };
      return {
        kind,
        name: p.name || "",
        membershipNumber: m.membershipNumber,
        clubId: m.clubId || "",
        memberType: dep ? "dependent" : m.memberType === "follower" ? "follower" : "main",
        parentName: dep ? m.name : "",
        relationship: dep ? dep.relationship || "" : m.memberType === "follower" ? m.relationshipToMain || "" : "",
        phone: (p.phone || (dep ? m.phone : "") || "").trim(),
        email: p.email || (dep ? "" : m.email) || "",
        familyGroup: m.familyGroup || "",
        birthDate: ai.birthDate,
        birthYear: ai.birthYear,
        age: ai.age,
        ageGroup: ai.ageGroup || "none",
        hasAccount: dep ? null : !!m.passwordHash,
        birthConfirmed: dep ? null : !!m.birthConfirmedAt,
        archived,
        points: dep ? null : bal,
        registered: s.reg,
        attended: s.att,
        lastEventDate: s.last,
        joinedAt: String(m.createdAt || "").slice(0, 10),
      };
    };
    rows.push(mk("member", m, null));
    for (const d of m.dependents || []) rows.push(mk("dependent", d, d));
  }
  return { rows, scoped: !!scoped };
}

function buildRegistrations(env, spec) {
  const { db } = env;
  const f = spec.filters;
  const evSet = f.events.length ? new Set(f.events) : null;
  const evById = new Map(db.events.map((e) => [e.id, e]));
  const rows = [];
  for (const r of db.registrations) {
    const ev = evById.get(r.eventId);
    if (!ev) continue;
    if (evSet && !evSet.has(r.eventId)) continue;
    if (f.from && String(ev.date) < f.from) continue;
    if (f.to && String(ev.date) > f.to) continue;
    const status = r.waitlisted ? "waitlist" : r.checkedIn ? "checkedin" : "confirmed";
    if (!f.regStatus.includes(status)) continue;
    const m = db.members[r.membershipNumber];
    const dep = m && r.dependentName ? (m.dependents || []).find((d) => d.id === r.dependentId) || null : null;
    const person = m ? (r.dependentName ? dep || { name: r.dependentName } : m) : { name: r.dependentName || "" };
    const ai = AgeUtils.ageInfo(person, String(ev.date || ""));
    rows.push({
      eventId: ev.id,
      eventNameEn: ev.nameEn || ev.nameAr || "",
      eventNameAr: ev.nameAr || ev.nameEn || "",
      eventDate: String(ev.date || ""),
      sport: ev.sport || "",
      kind: r.dependentName ? "dependent" : "member",
      name: r.dependentName || (m ? m.name : ""),
      membershipNumber: r.membershipNumber,
      memberType: r.dependentName ? "dependent" : m && m.memberType === "follower" ? "follower" : "main",
      phone: ((person && person.phone) || (m ? m.phone : "") || "").trim(),
      email: (person && person.email) || (m && !r.dependentName ? m.email : "") || "",
      familyGroup: m ? m.familyGroup || "" : "",
      birthDate: ai.birthDate,
      birthYear: ai.birthYear,
      age: ai.age,
      ageGroup: ai.ageGroup || "none",
      status,
      registeredAt: String(r.registeredAt || "").slice(0, 10),
      checkedInAt: String(r.checkInAt || "").slice(0, 16).replace("T", " "),
      points: r.checkedIn ? env.pointsOf(r) : 0,
      early: !!r.earlyRegistration,
      archived: !!(m && m.archivedAt),
      hasAccount: m && !r.dependentName ? !!m.passwordHash : null,
    });
  }
  return rows;
}

function passes(spec, row, source) {
  const f = spec.filters;
  if (f.kinds.length && !f.kinds.includes(row.kind)) return false;
  if (f.memberTypes.length && !f.memberTypes.includes(row.memberType)) return false;
  if (f.ageGroups.length && !f.ageGroups.includes(row.ageGroup)) return false;
  if (f.ageMin != null && !(row.age != null && row.age >= f.ageMin)) return false;
  if (f.ageMax != null && !(row.age != null && row.age <= f.ageMax)) return false;
  if (f.birthYearMin != null && !(row.birthYear != null && row.birthYear >= f.birthYearMin)) return false;
  if (f.birthYearMax != null && !(row.birthYear != null && row.birthYear <= f.birthYearMax)) return false;
  if (f.hasBirthDate === "yes" && !row.birthDate) return false;
  if (f.hasBirthDate === "no" && row.birthDate) return false;
  if (f.birthConfirmed === "yes" && row.birthConfirmed !== true) return false;
  if (f.birthConfirmed === "no" && row.birthConfirmed !== false) return false;
  if (f.phone === "has" && !row.phone) return false;
  if (f.phone === "none" && row.phone) return false;
  if (f.phoneContains) {
    const digits = (s) => AgeUtils.toLatinDigits(s).replace(/[\s\-+()]/g, "");
    if (!digits(row.phone).includes(digits(f.phoneContains))) return false;
  }
  if (f.familyGroup && !String(row.familyGroup).toLowerCase().includes(f.familyGroup.toLowerCase())) return false;
  if (f.search) {
    const q = AgeUtils.normName(f.search);
    const blob = AgeUtils.normName(`${row.name} ${row.membershipNumber} ${row.phone} ${row.email} ${row.familyGroup}`);
    if (!blob.includes(q)) return false;
  }
  if (f.account === "has" && row.hasAccount !== true) return false;
  if (f.account === "none" && row.hasAccount === true) return false;
  if (f.status === "active" && row.archived) return false;
  if (f.status === "archived" && !row.archived) return false;
  if (source === "people") {
    if (f.activity === "registered" && !(row.registered > 0)) return false;
    if (f.activity === "never_registered" && row.registered > 0) return false;
    if (f.activity === "attended" && !(row.attended > 0)) return false;
    if (f.activity === "never_attended" && row.attended > 0) return false;
    if (f.pointsMin != null && !(row.points != null && row.points >= f.pointsMin)) return false;
    if (f.pointsMax != null && !(row.points != null && row.points <= f.pointsMax)) return false;
  }
  return true;
}

// ------------------------------------------------------------- formatting --
function cell(row, key, lang) {
  const ar = lang === "ar";
  switch (key) {
    case "kind": return pick(KIND_LABELS[row.kind], lang);
    case "memberType": return pick(MEMBER_TYPE_LABELS[row.memberType], lang);
    case "ageGroup": return pick(AGE_LABELS[row.ageGroup] || AGE_LABELS.none, lang);
    case "hasAccount": return row.hasAccount == null ? "—" : pick(row.hasAccount ? YES : NO, lang);
    case "birthConfirmed": return row.birthConfirmed == null ? "—" : pick(row.birthConfirmed ? YES : NO, lang);
    case "status":
      if (row.eventId !== undefined) return pick(REG_STATUS_LABELS[row.status], lang);
      return pick(row.archived ? L("مؤرشف", "Archived") : L("نشط", "Active"), lang);
    case "early": return pick(row.early ? YES : NO, lang);
    case "eventName": return ar ? row.eventNameAr : row.eventNameEn;
    case "points": return row.points == null ? "" : row.points;
    case "birthYear":
    case "age": return row[key] == null ? "" : row[key];
    case "registered":
    case "attended": return row[key];
    default: return row[key] == null ? "" : row[key];
  }
}

function groupLabel(spec, row, lang) {
  switch (spec.groupBy) {
    case "ageGroup": return pick(AGE_LABELS[row.ageGroup] || AGE_LABELS.none, lang);
    case "memberType": return pick(MEMBER_TYPE_LABELS[row.memberType], lang);
    case "kind": return pick(KIND_LABELS[row.kind], lang);
    case "birthYear": return row.birthYear == null ? pick(L("غير محدد", "Not set"), lang) : String(row.birthYear);
    case "hasPhone": return pick(row.phone ? L("لديه هاتف", "Has a phone") : L("بلا هاتف", "No phone"), lang);
    case "hasAccount": return row.hasAccount == null ? "—" : pick(row.hasAccount ? L("لديه حساب", "Has a login") : L("بلا حساب", "No login yet"), lang);
    case "status":
      if (row.eventId !== undefined) return pick(REG_STATUS_LABELS[row.status], lang);
      return pick(row.archived ? L("مؤرشف", "Archived") : L("نشط", "Active"), lang);
    case "event": return `${lang === "ar" ? row.eventNameAr : row.eventNameEn} (${row.eventDate})`;
    default: return "";
  }
}
function groupOrder(spec, row) {
  switch (spec.groupBy) {
    case "ageGroup": return AGE_KEYS.indexOf(row.ageGroup);
    case "memberType": return MEMBER_TYPES.indexOf(row.memberType);
    case "kind": return row.kind === "member" ? 0 : 1;
    case "birthYear": return row.birthYear == null ? 1e9 : row.birthYear;
    case "hasPhone": return row.phone ? 0 : 1;
    case "hasAccount": return row.hasAccount ? 0 : 1;
    case "status": return row.eventId !== undefined ? REG_STATUS.indexOf(row.status) : row.archived ? 1 : 0;
    case "event": return `${row.eventDate}#${String(row.eventId).padStart(8, "0")}`;
    default: return 0;
  }
}

// Runs a (normalised) spec. Returns everything the screen / Excel / print need.
function runReport(env, rawSpec, lang, opts) {
  const spec = normalizeSpec(rawSpec);
  lang = lang === "ar" ? "ar" : "en";
  const limit = (opts && opts.limit) || 1000;
  const today = AgeUtils.todayCairoISO();
  let rows;
  if (spec.source === "people") rows = buildPeople(env, spec, today).rows;
  else rows = buildRegistrations(env, spec);
  rows = rows.filter((r) => passes(spec, r, spec.source));

  // sort
  const colDef = SOURCES[spec.source].columns.find((c) => c.key === spec.sortBy);
  const collator = new Intl.Collator(lang === "ar" ? "ar" : "en", { sensitivity: "base", numeric: true });
  const sortVal = (r) => {
    if (!colDef) return null;
    if (spec.sortBy === "eventName") return lang === "ar" ? r.eventNameAr : r.eventNameEn;
    if (colDef.t === "s") return String(cell(r, spec.sortBy, lang) || "");
    return r[spec.sortBy];
  };
  const dir = spec.sortDir === "desc" ? -1 : 1;
  rows.sort((a, b) => {
    if (colDef) {
      const va = sortVal(a), vb = sortVal(b);
      const na = va === null || va === undefined || va === "", nb = vb === null || vb === undefined || vb === "";
      if (na !== nb) return na ? 1 : -1; // empties always last
      if (!na) {
        const c = colDef.t === "s" ? collator.compare(va, vb) : va < vb ? -1 : va > vb ? 1 : 0;
        if (c) return c * dir;
      }
    }
    return collator.compare(a.name || "", b.name || "");
  });

  const columns = spec.columns.map((k) => ({ key: k, label: pick(SOURCES[spec.source].columns.find((c) => c.key === k).label, lang) }));
  const total = rows.length;
  const shown = rows.slice(0, limit);
  const out = {
    spec,
    lang,
    columns,
    total,
    truncated: total > shown.length,
    rows: spec.layout === "summary" ? [] : shown.map((r) => spec.columns.map((k) => cell(r, k, lang))),
    summary: null,
    uniquePeople: spec.source === "registrations" ? new Set(rows.map((r) => `${r.membershipNumber}#${r.kind}#${r.name}`)).size : total,
  };
  if (spec.groupBy) {
    const map = new Map();
    for (const r of rows) {
      const label = groupLabel(spec, r, lang);
      const k = label;
      let g = map.get(k);
      if (!g) map.set(k, (g = { label, order: groupOrder(spec, r), count: 0, withPhone: 0, reg: 0, att: 0, points: 0, people: new Set() }));
      g.count++;
      if (r.phone) g.withPhone++;
      if (spec.source === "people") { g.reg += r.registered; g.att += r.attended; }
      else { if (r.status === "checkedin") g.att++; g.points += r.points || 0; g.people.add(`${r.membershipNumber}#${r.kind}#${r.name}`); }
    }
    const groups = Array.from(map.values()).sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : collator.compare(a.label, b.label)));
    const isPeople = spec.source === "people";
    const head = isPeople
      ? [pick(L("المجموعة", "Group"), lang), pick(L("العدد", "People"), lang), pick(L("النسبة", "Share"), lang), pick(L("لديهم هاتف", "With phone"), lang), pick(L("إجمالي التسجيلات", "Total registrations"), lang), pick(L("إجمالي الحضور", "Total check-ins"), lang)]
      : [pick(L("المجموعة", "Group"), lang), pick(L("التسجيلات", "Registrations"), lang), pick(L("النسبة", "Share"), lang), pick(L("أشخاص مختلفون", "Unique people"), lang), pick(L("حضروا", "Checked in"), lang), pick(L("نسبة الحضور", "Attendance rate"), lang)];
    const pct = (a, b) => (b ? (Math.round((a / b) * 1000) / 10).toFixed(1) + "%" : "—");
    const body = groups.map((g) =>
      isPeople
        ? [g.label, g.count, pct(g.count, total), g.withPhone, g.reg, g.att]
        : [g.label, g.count, pct(g.count, total), g.people.size, g.att, pct(g.att, g.count)]
    );
    const sum = (i) => body.reduce((s, r) => s + (Number(r[i]) || 0), 0);
    const totalRow = isPeople
      ? [pick(L("الإجمالي", "Total"), lang), total, total ? "100.0%" : "—", sum(3), sum(4), sum(5)]
      : [pick(L("الإجمالي", "Total"), lang), total, total ? "100.0%" : "—", out.uniquePeople, sum(4), pct(sum(4), total)];
    out.summary = { by: pick(SOURCES[spec.source].groups.find((g) => g.key === spec.groupBy).label, lang), head, rows: body, total: totalRow };
  }
  return out;
}

// Human-readable list of the active filters, for the print header / Excel.
function describeSpec(rawSpec, lang, eventNames) {
  const spec = normalizeSpec(rawSpec);
  lang = lang === "ar" ? "ar" : "en";
  const f = spec.filters;
  const t = (ar, en) => (lang === "ar" ? ar : en);
  const bits = [];
  bits.push(spec.source === "people" ? t("المصدر: الأشخاص (أعضاء وأفراد عائلة)", "Source: people (members and family members)") : t("المصدر: تسجيلات الفعاليات", "Source: event registrations"));
  if (f.kinds.length) bits.push(t("النوع: ", "Type: ") + f.kinds.map((k) => pick(KIND_LABELS[k], lang)).join(" / "));
  if (f.memberTypes.length) bits.push(t("فئة العضوية: ", "Member type: ") + f.memberTypes.map((k) => pick(MEMBER_TYPE_LABELS[k], lang)).join(" / "));
  if (f.ageGroups.length) bits.push(t("الفئة العمرية: ", "Age group: ") + f.ageGroups.map((k) => pick(AGE_LABELS[k], lang)).join(" / "));
  if (f.ageMin != null || f.ageMax != null) bits.push(t("العمر: ", "Age: ") + `${f.ageMin != null ? f.ageMin : "…"} – ${f.ageMax != null ? f.ageMax : "…"}`);
  if (f.birthYearMin != null || f.birthYearMax != null) bits.push(t("سنة الميلاد: ", "Birth year: ") + `${f.birthYearMin != null ? f.birthYearMin : "…"} – ${f.birthYearMax != null ? f.birthYearMax : "…"}`);
  if (f.hasBirthDate) bits.push(f.hasBirthDate === "yes" ? t("لديه تاريخ ميلاد", "Has a date of birth") : t("بلا تاريخ ميلاد", "No date of birth"));
  if (f.birthConfirmed) bits.push(f.birthConfirmed === "yes" ? t("أكّد تاريخ ميلاده", "Birth date confirmed") : t("لم يؤكد تاريخ ميلاده", "Birth date not confirmed"));
  if (f.phone) bits.push(f.phone === "has" ? t("لديه رقم هاتف", "Has a phone number") : t("بلا رقم هاتف", "No phone number"));
  if (f.phoneContains) bits.push(t("الهاتف يحتوي: ", "Phone contains: ") + f.phoneContains);
  if (f.familyGroup) bits.push(t("مجموعة العائلة: ", "Family group: ") + f.familyGroup);
  if (f.search) bits.push(t("بحث: ", "Search: ") + f.search);
  if (f.account) bits.push(f.account === "has" ? t("لديه حساب دخول", "Has a login") : t("بلا حساب دخول", "No login yet"));
  if (f.status !== "active") bits.push(t("حالة العضوية: ", "Membership status: ") + (f.status === "archived" ? t("مؤرشفون", "archived") : t("الكل", "all")));
  if (f.activity) {
    const m = { registered: t("سجّل مرة على الأقل", "Registered at least once"), never_registered: t("لم يسجّل أبدًا", "Never registered"), attended: t("حضر مرة على الأقل", "Attended at least once"), never_attended: t("لم يحضر أبدًا", "Never attended") };
    bits.push(m[f.activity]);
  }
  if (f.pointsMin != null || f.pointsMax != null) bits.push(t("رصيد النقاط: ", "Points balance: ") + `${f.pointsMin != null ? f.pointsMin : "…"} – ${f.pointsMax != null ? f.pointsMax : "…"}`);
  if (f.events.length) {
    const names = f.events.map((id) => (eventNames && eventNames.get(id)) || `#${id}`);
    bits.push(t("الفعاليات: ", "Events: ") + (names.length > 4 ? `${names.slice(0, 4).join("، ")} +${names.length - 4}` : names.join(lang === "ar" ? "، " : ", ")));
  }
  if (f.from || f.to) bits.push(t("الفترة: ", "Period: ") + `${f.from || "…"} → ${f.to || "…"}`);
  if (spec.source === "registrations") bits.push(t("حالات التسجيل: ", "Statuses: ") + f.regStatus.map((k) => pick(REG_STATUS_LABELS[k], lang)).join(" / "));
  if (spec.sortBy) bits.push(t("الترتيب: ", "Sorted by: ") + pick(SOURCES[spec.source].columns.find((c) => c.key === spec.sortBy).label, lang) + (spec.sortDir === "desc" ? " ↓" : " ↑"));
  if (spec.groupBy) bits.push(t("تجميع حسب: ", "Grouped by: ") + pick(SOURCES[spec.source].groups.find((g) => g.key === spec.groupBy).label, lang));
  return bits;
}

module.exports = { meta, normalizeSpec, runReport, describeSpec, SOURCES };
