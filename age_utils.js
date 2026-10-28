"use strict";
// Date-of-birth helpers shared by server.js and the tests: strict date
// parsing, age / age-group maths (all relative to an "as of" day, so reports
// can use the event's start date) and the name matcher behind the admin
// "match birthdates file" tool. Pure functions - no I/O.

// ------------------------------------------------------------- dates ----
function todayCairoISO() {
  // en-CA formats as YYYY-MM-DD. Cairo time so the age flips at midnight Cairo.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function toLatinDigits(s) {
  return String(s == null ? "" : s)
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
}

function isRealDate(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const pad2 = (n) => String(n).padStart(2, "0");

// Strict: only a real calendar date YYYY-MM-DD, year >= 1900, not in the
// future. Returns the normalised string or "" when invalid.
function parseBirthDate(raw, today) {
  const s = toLatinDigits(raw).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return "";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || !isRealDate(y, mo, d)) return "";
  if (s > (today || todayCairoISO())) return "";
  return s;
}

// Lenient parser used on uploaded sheets. Accepts a JS Date, an Excel serial
// number (already converted by the caller via `serialToYMD` if desired),
// ISO text (2016-04-14), day-first text (14/04/2016, 14-4-2016, 14.4.2016) and
// Arabic-Indic digits. Returns { iso, problem }. `problem` is "" when ok,
// otherwise a short code: "empty" | "format" | "year" | "future".
function parseSheetDate(raw, today) {
  today = today || todayCairoISO();
  if (raw == null || raw === "") return { iso: "", problem: "empty" };
  let y;
  let mo;
  let d;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { iso: "", problem: "format" };
    y = raw.getUTCFullYear();
    mo = raw.getUTCMonth() + 1;
    d = raw.getUTCDate();
  } else if (typeof raw === "object" && raw && "y" in raw) {
    y = raw.y; mo = raw.m; d = raw.d;
  } else {
    const s = toLatinDigits(raw).trim();
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
    if (m) {
      y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
    } else {
      m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
      if (!m) return { iso: "", problem: "format" };
      d = Number(m[1]); mo = Number(m[2]); y = Number(m[3]);
    }
  }
  if (!isRealDate(y, mo, d)) return { iso: "", problem: "format" };
  const iso = `${String(y).padStart(4, "0")}-${pad2(mo)}-${pad2(d)}`;
  if (y < 1900) return { iso, problem: "year" };
  if (iso > today) return { iso, problem: "future" };
  return { iso, problem: "" };
}

// Completed years on the `asOf` day (YYYY-MM-DD). Never negative.
function ageOn(birthISO, asOfISO) {
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthISO || "");
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOfISO || "");
  if (!b || !a) return null;
  let age = Number(a[1]) - Number(b[1]);
  if (Number(a[2]) < Number(b[2]) || (Number(a[2]) === Number(b[2]) && Number(a[3]) < Number(b[3]))) age--;
  return age < 0 ? 0 : age;
}

// Same four bands the platform has always used.
function ageGroupForAge(age) {
  if (age == null) return "";
  if (age < 12) return "under12";
  if (age < 18) return "12to17";
  if (age < 46) return "18to45";
  return "46plus";
}

// { birthDate, birthYear, age, ageGroup, auto } for a member / dependent.
// With a valid birth date everything is derived as of `asOf` (default: today,
// Cairo). Without one we fall back to the self-reported ageGroup, age unknown.
function ageInfo(person, asOf) {
  const today = todayCairoISO();
  const birth = parseBirthDate(person && person.birthDate, today);
  if (!birth) {
    return { birthDate: "", birthYear: null, age: null, ageGroup: (person && person.ageGroup) || "", auto: false };
  }
  const on = /^\d{4}-\d{2}-\d{2}$/.test(asOf || "") ? asOf : today;
  const age = ageOn(birth, on);
  return { birthDate: birth, birthYear: Number(birth.slice(0, 4)), age, ageGroup: ageGroupForAge(age), auto: true };
}

// --------------------------------------------------------- name matching --
function normName(s) {
  return String(s == null ? "" : s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "") // harakat + tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^a-z0-9؀-ۿ]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
const sim = (a, b) => (a === b ? 1 : 1 - lev(a, b) / Math.max(a.length, b.length, 1));

// 0..1 similarity between two NORMALISED names. Order-insensitive; a shorter
// name whose words all appear in a longer one scores high (first + last name
// vs. the full registered name).
function nameScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = a.split(" ");
  const tb = b.split(" ");
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const used = new Set();
  let total = 0;
  let strong = 0;
  for (const t of short) {
    let best = 0;
    let bestIdx = -1;
    long.forEach((u, i) => {
      if (used.has(i)) return;
      const s = sim(t, u);
      if (s > best) { best = s; bestIdx = i; }
    });
    if (bestIdx >= 0) used.add(bestIdx);
    total += best;
    if (best >= 0.75) strong++;
  }
  // A single shared word is not a match: most of the words must line up.
  if (strong < Math.ceil(short.length * 0.6)) return Math.min(sim(a, b), 0.5);
  const tokenAvg = total / short.length;
  const coverage = short.length / long.length;
  const tokenScore = tokenAvg * (0.7 + 0.3 * coverage);
  return Math.max(tokenScore, sim(a, b));
}

// people: [{ membershipNumber, dependentId (number|null), name, kind
//            ("member"|"dependent"), parentName, archived, birthDate }]
// rows:   [{ rowNum, name, iso, problem, membershipNumber? }]
// Returns one result per row (same order):
//   status: "exact"     one person with exactly the same (normalised) name,
//                       no date on file yet -> safe to apply automatically
//           "already"   exact match that already has this very date
//           "conflict"  exact match that already has a DIFFERENT date
//           "ambiguous" several people share this exact name
//           "linked"    no exact name, but one close name already holds this
//                       very date (linked earlier) - settled
//           "near"      no exact match; best guesses in `candidates`
//           "none"      nobody even close
//           "invalid"   the date in the file is unusable (see `problem`)
//           "dup-file"  same name+date twice in the file (second copy)
//           "dup-diff"  same name twice with different dates
function analyzeBirthRows(rows, people, opts) {
  const minScore = (opts && opts.minScore) || 0.6;
  const norm = people.map((p) => ({ p, n: normName(p.name) }));
  const byNorm = new Map();
  for (const x of norm) {
    if (!x.n) continue;
    if (!byNorm.has(x.n)) byNorm.set(x.n, []);
    byNorm.get(x.n).push(x.p);
  }
  const byKey = new Map(people.map((p) => [`${p.membershipNumber}#${p.dependentId == null ? "" : p.dependentId}`, p]));

  const seen = new Map(); // normalised file name -> first iso
  const out = [];
  for (const row of rows) {
    const n = normName(row.name);
    const res = { rowNum: row.rowNum, name: row.name, iso: row.iso || "", problem: row.problem || "", status: "none", target: null, candidates: [] };
    if (row.problem) {
      // Unusable date: nothing is saved, but still say who this name looks
      // like so the admin can type the right date and link it in one step.
      res.status = "invalid";
      const nn = normName(row.name);
      if (nn) {
        const ex = byNorm.get(nn) || [];
        res.candidates = (ex.length
          ? ex.map((p) => ({ p, score: 1 }))
          : norm.map((x) => ({ p: x.p, score: nameScore(nn, x.n) })).filter((x) => x.score >= minScore).sort((a, b) => b.score - a.score).slice(0, 5));
      }
      out.push(res);
      continue;
    }
    if (seen.has(n)) {
      res.status = seen.get(n) === row.iso ? "dup-file" : "dup-diff";
      out.push(res);
      continue;
    }
    seen.set(n, row.iso);

    // A membership number in the file pins the person exactly.
    if (row.membershipNumber) {
      const hits = people.filter((p) => String(p.membershipNumber) === String(row.membershipNumber) && p.dependentId == null);
      if (hits.length === 1) {
        res.target = hits[0];
        res.status = !hits[0].birthDate ? "exact" : hits[0].birthDate === row.iso ? "already" : "conflict";
        out.push(res);
        continue;
      }
    }

    const exact = byNorm.get(n) || [];
    if (exact.length === 1) {
      const t = exact[0];
      res.target = t;
      res.status = !t.birthDate ? "exact" : t.birthDate === row.iso ? "already" : "conflict";
    } else if (exact.length > 1) {
      res.status = "ambiguous";
      res.candidates = exact.map((p) => ({ p, score: 1 }));
    } else {
      const scored = norm
        .map((x) => ({ p: x.p, score: nameScore(n, x.n) }))
        .filter((x) => x.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      res.candidates = scored;
      res.status = scored.length ? "near" : "none";
      // A close name that already carries exactly this date was linked by an
      // admin earlier (or by a previous run of this tool): treat as settled.
      const sameDate = scored.filter((x) => x.score >= 0.75 && x.p.birthDate === row.iso);
      if (sameDate.length === 1) {
        res.status = "linked";
        res.target = sameDate[0].p;
      }
    }
    out.push(res);
  }
  // keep `byKey` referenced for callers that want quick lookup
  out.byKey = byKey;
  return out;
}

module.exports = {
  todayCairoISO, parseBirthDate, parseSheetDate, ageOn, ageGroupForAge, ageInfo,
  normName, nameScore, analyzeBirthRows, toLatinDigits,
};
