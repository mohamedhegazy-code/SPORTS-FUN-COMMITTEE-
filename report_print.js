"use strict";
// Printable A4 event reports for the Admin > Reports tab: the registrations
// list, the check-in / attendance sheet (with a signature column for the
// gate) and the points sheet. Generated server-side from the staff session,
// styled like the Swiss tournament sheets (Al Ahly red / gold on cream).
// Pure HTML + CSS - the Print button is wired by /print.js (inline scripts
// are blocked by the CSP).

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function dateText(iso, lang) {
  const d = new Date(String(iso || "") + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return String(iso || "");
  try {
    return d.toLocaleDateString(lang === "ar" ? "ar-EG-u-nu-latn" : "en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  } catch (e) {
    return String(iso);
  }
}
const AGE_LABELS = {
  under12: ["أطفال (أقل من 12)", "Kids (under 12)"],
  "12to17": ["شباب (12–17)", "Youth (12–17)"],
  "18to45": ["بالغون (18–45)", "Adults (18–45)"],
  "46plus": ["ماسترز (+46)", "Masters (46+)"],
};
const AGE_ORDER = ["under12", "12to17", "18to45", "46plus"];
function ageLabel(code, ar) {
  const l = AGE_LABELS[code];
  return l ? l[ar ? 0 : 1] : "";
}
function shortDate(isoDateTime) {
  return String(isoDateTime || "").slice(0, 10);
}

const CSS = `
  :root { --red:#8B0000; --red-dark:#650000; --gold:#C9A227; --bg:#ffffff; --text:#1c1c1c; --muted:#6b6b6b; --border:#e4dfd8; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; background: #e9e5df; color: var(--text); font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: 13px; }
  .toolbar { position: sticky; top: 0; z-index: 5; display: flex; gap: 10px; align-items: center; justify-content: center; padding: 10px; background: var(--red-dark); color: #fff; }
  .toolbar button { background: #fff; color: var(--red); border: 0; border-radius: 6px; padding: 8px 16px; font-weight: 700; font-size: 0.9rem; cursor: pointer; font-family: inherit; }
  .toolbar .hint { font-size: 0.8rem; opacity: 0.85; }
  .sheet { width: 210mm; min-height: 297mm; margin: 14px auto; background: var(--bg); box-shadow: 0 6px 30px rgba(0,0,0,0.25); padding: 8mm 10mm; }
  .head { display: flex; align-items: center; gap: 5mm; padding: 4mm; color: #fff; background: linear-gradient(135deg, var(--red), var(--red-dark)); border-bottom: 1.2mm solid var(--gold); }
  .head img { height: 22mm; width: auto; background: none; padding: 0; flex: none; }
  .head .t { flex: 1; }
  .head .org { font-size: 9pt; font-weight: 700; color: #f3dfa0; letter-spacing: 0.02em; margin-bottom: 1.5mm; opacity: 0.95; }
  .head h1 { margin: 0; font-size: 16pt; line-height: 1.2; }
  .head p { margin: 1mm 0 0; font-size: 10.5pt; color: #f3dfa0; font-weight: 700; }
  .strip { display: grid; grid-template-columns: repeat(4, 1fr); background: #f3ecd2; text-align: center; border-bottom: 0.4mm solid var(--border); }
  .strip > div { padding: 2mm; border-inline-start: 0.4mm solid #fff; }
  .strip > div:first-child { border-inline-start: 0; }
  .strip .k { font-size: 8.5pt; color: #5b5b5b; }
  .strip .v { font-size: 13pt; font-weight: 800; color: var(--red); }
  .agebar { display: flex; flex-wrap: wrap; gap: 1mm 5mm; align-items: baseline; padding: 2mm 3mm; font-size: 9pt; background: #faf6e6; border-bottom: 0.4mm solid var(--border); }
  .agebar b { color: var(--red); }
  table.grid { width: 100%; border-collapse: collapse; margin-top: 4mm; font-size: 10.5pt; }
  table.grid th { background: #111; color: var(--gold); font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; padding: 2mm; text-align: start; }
  table.grid thead { display: table-header-group; }
  table.grid tr { page-break-inside: avoid; }
  table.grid td { padding: 2mm; border-bottom: 0.3mm solid var(--border); vertical-align: middle; }
  table.grid tr:nth-child(even) td { background: #faf8f5; }
  table.grid td.c, table.grid th.c { text-align: center; }
  table.grid td.num { direction: ltr; unicode-bidi: isolate; text-align: center; }
  table.grid td.name { font-weight: 700; }
  table.grid td.sig { width: 30mm; border: 0.4mm solid #999; background: #fff !important; }
  table.grid tr.wait td { color: var(--muted); font-style: italic; }
  table.grid tr.total td { background: #fff6d6 !important; font-weight: 800; border-top: 0.5mm solid var(--gold); }
  .tag { display: inline-block; font-size: 7.5pt; font-weight: 800; padding: 0.3mm 1.8mm; border-radius: 99px; background: #e6e2da; color: #444; }
  .tag.ok { background: #d9efdc; color: #1d5b2a; }
  .tag.wait { background: #fbe9c8; color: #7a5200; }
  .empty { text-align: center; color: var(--muted); padding: 12mm 0; }
  .sign { display: flex; gap: 10mm; margin-top: 12mm; }
  .sign div { flex: 1; border-top: 0.4mm solid #444; padding-top: 1.5mm; text-align: center; font-size: 9.5pt; color: var(--muted); }
  .foot { margin-top: 5mm; font-size: 8.5pt; color: var(--muted); text-align: center; }
  @page { size: A4; margin: 8mm; }
  @media print {
    body { background: #fff; }
    .toolbar { display: none !important; }
    .sheet { margin: 0; box-shadow: none; width: auto; min-height: 0; padding: 0; }
  }
  @media (max-width: 800px) { .sheet { width: auto; margin: 8px; } }
`;

// rows: [{ name, membershipNumber, phone, registeredAt, waitlisted, checkedIn,
//          earlyRegistration, position, points }]
function renderEventSheet({ event, rows, view, lang, generatedAt, showPhone = true }) {
  const ar = lang === "ar";
  const dir = ar ? "rtl" : "ltr";
  const L = (a, e) => (ar ? a : e);
  const title = ar ? event.nameAr || event.nameEn : event.nameEn || event.nameAr;
  const confirmed = rows.filter((r) => !r.waitlisted);
  const waitlisted = rows.filter((r) => r.waitlisted);
  const checkedIn = confirmed.filter((r) => r.checkedIn);
  const collator = new Intl.Collator(ar ? "ar" : "en", { sensitivity: "base", numeric: true });
  const byName = (a, b) => collator.compare(a.name, b.name);

  const subtitleMap = {
    registrations: L("قائمة المسجّلين", "Registrations list"),
    attendance: L("كشف الحضور", "Attendance / check-in sheet"),
    points: L("كشف النقاط", "Points sheet"),
  };
  const subtitle = subtitleMap[view] || subtitleMap.registrations;
  const eventDate = `${dateText(event.date, lang)}${event.endDate && event.endDate !== event.date ? " — " + dateText(event.endDate, lang) : ""}`;

  const strip = `<div class="strip">
    <div><div class="k">${esc(L("مسجّلون", "Registered"))}</div><div class="v">${confirmed.length}</div></div>
    <div><div class="k">${esc(L("قائمة الانتظار", "Waiting list"))}</div><div class="v">${waitlisted.length}</div></div>
    <div><div class="k">${esc(L("حضروا", "Checked in"))}</div><div class="v">${checkedIn.length}</div></div>
    <div><div class="k">${esc(L("السعة", "Capacity"))}</div><div class="v">${event.maxCapacity ? esc(event.maxCapacity) : "—"}</div></div>
  </div>`;

  // Age-group breakdown of the confirmed players (blank = not set / a
  // dependent's registration, which carries no age group of its own).
  const ageCounts = AGE_ORDER.map((code) => ({ code, n: confirmed.filter((r) => r.ageGroup === code).length }));
  const ageUnset = confirmed.filter((r) => !AGE_LABELS[r.ageGroup]).length;
  const ageBar = `<div class="agebar"><b>${esc(L("الفئات العمرية", "Age groups"))}:</b> ${ageCounts
    .map((a) => `<span>${esc(ageLabel(a.code, ar))} <b>${a.n}</b></span>`)
    .join("")}<span>${esc(L("غير محدد", "Not set"))} <b>${ageUnset}</b></span></div>`;

  let table;
  if (view === "attendance") {
    const list = confirmed.slice().sort(byName);
    table = list.length
      ? `<table class="grid"><thead><tr>
          <th class="c">#</th><th>${esc(L("الاسم", "Name"))}</th><th class="c">${esc(L("رقم العضوية", "Membership no."))}</th>
          ${showPhone ? `<th class="c">${esc(L("الهاتف", "Phone"))}</th>` : ""}<th class="c">${esc(L("الفئة العمرية", "Age group"))}</th><th class="c">${esc(L("الحضور", "Present"))}</th><th>${esc(L("التوقيع", "Signature"))}</th></tr></thead><tbody>
          ${list
            .map(
              (r, i) => `<tr><td class="c">${i + 1}</td><td class="name"><bdi>${esc(r.name)}</bdi></td><td class="num">${esc(r.membershipNumber)}</td>
              ${showPhone ? `<td class="num">${esc(r.phone || "")}</td>` : ""}<td class="c">${esc(ageLabel(r.ageGroup, ar) || "—")}</td><td class="c">${r.checkedIn ? "✓" : ""}</td><td class="sig"></td></tr>`
            )
            .join("")}</tbody></table>`
      : `<p class="empty">${esc(L("لا يوجد مسجّلون بعد.", "No registrations yet."))}</p>`;
  } else if (view === "points") {
    const list = checkedIn.slice().sort((a, b) => b.points - a.points || byName(a, b));
    const total = list.reduce((s, r) => s + r.points, 0);
    table = list.length
      ? `<table class="grid"><thead><tr>
          <th class="c">#</th><th>${esc(L("الاسم", "Name"))}</th><th class="c">${esc(L("رقم العضوية", "Membership no."))}</th>
          <th class="c">${esc(L("الفئة العمرية", "Age group"))}</th><th class="c">${esc(L("تسجيل مبكر", "Early"))}</th><th class="c">${esc(L("المركز", "Position"))}</th><th class="c">${esc(L("النقاط", "Points"))}</th></tr></thead><tbody>
          ${list
            .map(
              (r, i) => `<tr><td class="c">${i + 1}</td><td class="name"><bdi>${esc(r.name)}</bdi></td><td class="num">${esc(r.membershipNumber)}</td>
              <td class="c">${esc(ageLabel(r.ageGroup, ar) || "—")}</td><td class="c">${r.earlyRegistration ? "✓" : ""}</td><td class="c">${r.position ? esc(r.position) : ""}</td><td class="num"><b>${esc(r.points)}</b></td></tr>`
            )
            .join("")}
          <tr class="total"><td colspan="6">${esc(L("إجمالي النقاط الممنوحة", "Total points awarded"))}</td><td class="num">${esc(total)}</td></tr></tbody></table>`
      : `<p class="empty">${esc(L("لم يتم تسجيل حضور أحد بعد، فلا توجد نقاط.", "Nobody has been checked in yet, so there are no points to show."))}</p>`;
  } else {
    const list = confirmed.slice().sort(byName).concat(waitlisted.slice().sort(byName));
    table = list.length
      ? `<table class="grid"><thead><tr>
          <th class="c">#</th><th>${esc(L("الاسم", "Name"))}</th><th class="c">${esc(L("رقم العضوية", "Membership no."))}</th>
          ${showPhone ? `<th class="c">${esc(L("الهاتف", "Phone"))}</th>` : ""}<th class="c">${esc(L("الفئة العمرية", "Age group"))}</th><th class="c">${esc(L("تاريخ التسجيل", "Registered"))}</th><th class="c">${esc(L("الحالة", "Status"))}</th></tr></thead><tbody>
          ${list
            .map((r, i) => {
              const status = r.waitlisted
                ? `<span class="tag wait">${esc(L("انتظار", "Waitlist"))}</span>`
                : r.checkedIn
                ? `<span class="tag ok">${esc(L("حضر", "Checked in"))}</span>`
                : `<span class="tag">${esc(L("مؤكد", "Confirmed"))}</span>`;
              return `<tr class="${r.waitlisted ? "wait" : ""}"><td class="c">${i + 1}</td><td class="name"><bdi>${esc(r.name)}</bdi></td><td class="num">${esc(r.membershipNumber)}</td>
              ${showPhone ? `<td class="num">${esc(r.phone || "")}</td>` : ""}<td class="c">${esc(ageLabel(r.ageGroup, ar) || "—")}</td><td class="num">${esc(shortDate(r.registeredAt))}</td><td class="c">${status}</td></tr>`;
            })
            .join("")}</tbody></table>`
      : `<p class="empty">${esc(L("لا يوجد مسجّلون بعد.", "No registrations yet."))}</p>`;
  }

  const body = `<section class="sheet" dir="${dir}">
    <div class="head"><img src="/ahly-crest-logo.png" alt="" /><div class="t"><div class="org">${esc(L("النادي الأهلي · لجنة الرياضة الترفيهية – التجمع الخامس، القاهرة الجديدة","Al Ahly Club · Recreational Sports Committee — Fifth Settlement, New Cairo"))}</div><h1>${esc(title)}</h1><p>${esc(subtitle)} — ${esc(eventDate)}</p></div></div>
    ${strip}
    ${ageBar}
    ${table}
    <div class="sign"><div>${esc(L("المسؤول", "Prepared by"))}</div><div>${esc(L("ختم اللجنة", "Committee stamp"))}</div></div>
    <p class="foot">${esc(L("أُنشئ في", "Generated"))} <bdi dir="ltr">${esc(generatedAt)}</bdi></p>
  </section>`;

  const toolbar = `<div class="toolbar"><button id="print-btn" type="button">${esc(L("طباعة / حفظ PDF", "Print / Save as PDF"))}</button><span class="hint">${esc(L("اختر «حفظ كـ PDF» من نافذة الطباعة لحفظ نسخة", "Choose “Save as PDF” in the print dialog to keep a copy"))}</span></div>`;
  return `<!doctype html>
<html lang="${lang}" dir="${dir}"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} — ${esc(subtitle)}</title>
<style>${CSS}</style></head>
<body>${toolbar}${body}<script src="/print.js"></script></body></html>`;
}

// ------------------------------------------------------------ age-group report
// Cross-event report: how many members / family members registered and
// attended, split by age group, for any selection of events. rows: one entry
// per CONFIRMED registration { eventId, personKey, name, membershipNumber,
// phone, ageKey ("under12" | "12to17" | "18to45" | "46plus" | "none"),
// checkedIn }.
const AGE_KEYS = ["under12", "12to17", "18to45", "46plus", "none"];
function aggregateAgeReport(events, rows, ageKeys) {
  const keys = AGE_KEYS.filter((k) => ageKeys.includes(k));
  const mk = () => ({ reg: 0, att: 0, people: new Set(), attPeople: new Set() });
  const byAge = new Map(keys.map((k) => [k, mk()]));
  const matrix = new Map(events.map((ev) => [ev.id, new Map(keys.map((k) => [k, { reg: 0, att: 0 }]))]));
  const persons = new Map(keys.map((k) => [k, new Map()]));
  const total = mk();
  for (const r of rows) {
    if (!byAge.has(r.ageKey) || !matrix.has(r.eventId)) continue;
    const a = byAge.get(r.ageKey);
    a.reg++; a.people.add(r.personKey); total.reg++; total.people.add(r.personKey);
    const cell = matrix.get(r.eventId).get(r.ageKey);
    cell.reg++;
    const pm = persons.get(r.ageKey);
    if (!pm.has(r.personKey)) pm.set(r.personKey, { name: r.name, membershipNumber: r.membershipNumber, phone: r.phone || "", reg: 0, att: 0 });
    const p = pm.get(r.personKey);
    p.reg++;
    if (r.checkedIn) {
      a.att++; a.attPeople.add(r.personKey); total.att++; total.attPeople.add(r.personKey);
      cell.att++; p.att++;
    }
  }
  return { keys, byAge, matrix, persons, total };
}
const pct = (a, b) => (b ? (Math.round((a / b) * 1000) / 10).toFixed(1) + "%" : "—");

// opts: { events (selected, sorted by date), rows, ages, detail
//         ("summary" | "events" | "names"), lang, from, to, allEvents,
//         generatedAt, showPhone }
function renderAgeReport({ events, rows, ages, detail, lang, from, to, allEvents, generatedAt, showPhone }) {
  const ar = lang === "ar";
  const dir = ar ? "rtl" : "ltr";
  const L = (a, e) => (ar ? a : e);
  const agg = aggregateAgeReport(events, rows, ages);
  const label = (k) => (k === "none" ? L("غير محدد", "Not set") : ageLabel(k, ar));
  const collator = new Intl.Collator(ar ? "ar" : "en", { sensitivity: "base", numeric: true });
  const title = L("تقرير الفئات العمرية", "Age group report");
  const evName = (ev) => (ar ? ev.nameAr || ev.nameEn : ev.nameEn || ev.nameAr);

  const scopeBits = [];
  scopeBits.push(allEvents ? L("كل الفعاليات", "All events") : L(`${events.length} فعالية محددة`, `${events.length} selected event(s)`));
  if (from || to) scopeBits.push(`${from || "…"} → ${to || "…"}`);
  scopeBits.push(L(`${events.length} فعالية`, `${events.length} event(s)`));
  const subtitle = scopeBits.join(" · ");

  const T = agg.total;
  const strip = `<div class="strip">
    <div><div class="k">${esc(L("أشخاص مختلفون", "Unique people"))}</div><div class="v">${T.people.size}</div></div>
    <div><div class="k">${esc(L("تسجيلات", "Registrations"))}</div><div class="v">${T.reg}</div></div>
    <div><div class="k">${esc(L("حضور", "Check-ins"))}</div><div class="v">${T.att}</div></div>
    <div><div class="k">${esc(L("نسبة الحضور", "Attendance rate"))}</div><div class="v">${esc(pct(T.att, T.reg))}</div></div>
  </div>`;
  const filterBar = `<div class="agebar"><b>${esc(L("الفئات المشمولة", "Age groups included"))}:</b> ${agg.keys.map((k) => `<span>${esc(label(k))}</span>`).join("")}<span>${esc(L("يُحتسب المؤكَّدون فقط (دون قائمة الانتظار)", "Confirmed registrations only (no waiting list)"))}</span></div>`;

  // 1. summary by age group
  const sumRows = agg.keys
    .map((k) => {
      const a = agg.byAge.get(k);
      return `<tr><td class="name nw">${esc(label(k))}</td><td class="num">${a.people.size}</td><td class="num">${a.reg}</td><td class="num">${a.attPeople.size}</td><td class="num">${a.att}</td><td class="num">${esc(pct(a.att, a.reg))}</td><td class="num">${esc(pct(a.reg, T.reg))}</td></tr>`;
    })
    .join("");
  const summary = `<h2 class="sec">${esc(L("حسب الفئة العمرية", "By age group"))}</h2>
  <table class="grid"><thead><tr><th>${esc(L("الفئة العمرية", "Age group"))}</th><th class="c">${esc(L("أشخاص مختلفون", "Unique people"))}</th><th class="c">${esc(L("تسجيلات", "Registrations"))}</th><th class="c">${esc(L("حضروا مرة على الأقل", "Attended at least once"))}</th><th class="c">${esc(L("مرات الحضور", "Check-ins"))}</th><th class="c">${esc(L("نسبة الحضور", "Attendance rate"))}</th><th class="c">${esc(L("حصة من التسجيلات", "Share of registrations"))}</th></tr></thead><tbody>${sumRows}
  <tr class="total"><td>${esc(L("الإجمالي", "Total"))}</td><td class="num">${T.people.size}</td><td class="num">${T.reg}</td><td class="num">${T.attPeople.size}</td><td class="num">${T.att}</td><td class="num">${esc(pct(T.att, T.reg))}</td><td class="num">${T.reg ? "100.0%" : "—"}</td></tr></tbody></table>`;

  // 2. event x age-group matrix
  let matrix = "";
  if (detail !== "summary" && events.length) {
    const head = agg.keys.map((k) => `<th class="c">${esc(label(k))}</th>`).join("");
    const active = events.filter((ev) => [...agg.matrix.get(ev.id).values()].some((c) => c.reg > 0));
    const body = active
      .map((ev) => {
        const m = agg.matrix.get(ev.id);
        let evReg = 0, evAtt = 0;
        const cells = agg.keys
          .map((k) => {
            const c = m.get(k);
            evReg += c.reg; evAtt += c.att;
            return `<td class="num">${c.reg} / ${c.att}</td>`;
          })
          .join("");
        return `<tr><td class="name"><bdi>${esc(evName(ev))}</bdi><br><span class="muted">${esc(ev.date)}</span></td>${cells}<td class="num"><b>${evReg} / ${evAtt}</b></td></tr>`;
      })
      .join("");
    matrix = !active.length ? "" : `<h2 class="sec">${esc(L("حسب الفعالية", "By event"))}</h2>
    <p class="note">${esc(L("كل خلية: المسجَّلون / الحاضرون. الفعاليات التي لا مسجّلين فيها لا تظهر.", "Each cell: registered / checked in. Events with no registrations are not listed."))}</p>
    <table class="grid"><thead><tr><th>${esc(L("الفعالية", "Event"))}</th>${head}<th class="c">${esc(L("المجموع", "Total"))}</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  // 3. names per age group
  let names = "";
  if (detail === "names") {
    names = agg.keys
      .map((k) => {
        const list = [...agg.persons.get(k).values()].sort((a, b) => b.att - a.att || collator.compare(a.name, b.name));
        const head = `<h2 class="sec">${esc(label(k))} <span class="muted">(${list.length})</span></h2>`;
        if (!list.length) return head + `<p class="empty">${esc(L("لا يوجد أشخاص في هذه الفئة.", "Nobody in this age group."))}</p>`;
        return (
          head +
          `<table class="grid"><thead><tr><th class="c">#</th><th>${esc(L("الاسم", "Name"))}</th><th class="c">${esc(L("رقم العضوية", "Membership no."))}</th>${showPhone ? `<th class="c">${esc(L("الهاتف", "Phone"))}</th>` : ""}<th class="c">${esc(L("سجّل في", "Registered for"))}</th><th class="c">${esc(L("حضر", "Attended"))}</th><th class="c">${esc(L("النسبة", "Rate"))}</th></tr></thead><tbody>${list
            .map((p, i) => `<tr><td class="c">${i + 1}</td><td class="name"><bdi>${esc(p.name)}</bdi></td><td class="num">${esc(p.membershipNumber)}</td>${showPhone ? `<td class="num">${esc(p.phone)}</td>` : ""}<td class="num">${p.reg}</td><td class="num">${p.att}</td><td class="num">${esc(pct(p.att, p.reg))}</td></tr>`)
            .join("")}</tbody></table>`
        );
      })
      .join("");
  }

  const empty = !events.length ? `<p class="empty">${esc(L("لا توجد فعاليات مطابقة للاختيار.", "No events match this selection."))}</p>` : "";
  const body = `<section class="sheet" dir="${dir}">
    <div class="head"><img src="/ahly-crest-logo.png" alt="" /><div class="t"><div class="org">${esc(L("النادي الأهلي · لجنة الرياضة الترفيهية – التجمع الخامس، القاهرة الجديدة","Al Ahly Club · Recreational Sports Committee — Fifth Settlement, New Cairo"))}</div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div></div>
    ${strip}${filterBar}${empty}${events.length ? summary + matrix + names : ""}
    <div class="sign"><div>${esc(L("المسؤول", "Prepared by"))}</div><div>${esc(L("ختم اللجنة", "Committee stamp"))}</div></div>
    <p class="foot">${esc(L("أُنشئ في", "Generated"))} <bdi dir="ltr">${esc(generatedAt)}</bdi></p>
  </section>`;
  const toolbar = `<div class="toolbar"><button id="print-btn" type="button">${esc(L("طباعة / حفظ PDF", "Print / Save as PDF"))}</button><span class="hint">${esc(L("اختر «حفظ كـ PDF» من نافذة الطباعة لحفظ نسخة", "Choose “Save as PDF” in the print dialog to keep a copy"))}</span></div>`;
  return `<!doctype html>
<html lang="${lang}" dir="${dir}"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>${CSS}
  h2.sec { margin: 6mm 0 1mm; font-size: 12pt; color: var(--red); border-bottom: 0.5mm solid var(--gold); padding-bottom: 1mm; }
  .muted { color: var(--muted); font-size: 8.5pt; font-weight: 400; }
  p.note { margin: 1mm 0 0; font-size: 8.5pt; color: var(--muted); }
  td.nw { white-space: nowrap; }
</style></head>
<body>${toolbar}${body}<script src="/print.js"></script></body></html>`;
}

module.exports = { renderEventSheet, renderAgeReport, aggregateAgeReport, AGE_KEYS };
