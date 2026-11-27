"use strict";
// Printable A4 match schedule for knockout / group tournaments (the Swiss format has its own
// sheets in swiss_print.js). Two views:
//   courts - one sheet per court: that court's matches in time order, with a box to write the
//            score and a signature line for the referee (hand it to whoever runs the court)
//   time   - one master schedule of every match by time, with the courts x rounds chart on top
// Generated server-side from the admin session (real tournament or a practice run). Plain
// HTML + CSS; the Print button is wired by /print.js (inline scripts are blocked by the CSP).

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function timeText(str, lang) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || ""));
  if (!m) return "";
  const h = Number(m[1]);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mm = m[2];
  if (lang === "ar") return `${h12}:${mm} ${h < 12 ? "صباحاً" : h < 16 ? "ظهراً" : "مساءً"}`;
  return `${h12}:${mm} ${h < 12 ? "AM" : "PM"}`;
}
function dateText(iso, lang) {
  const d = new Date(String(iso || "") + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return String(iso || "");
  try {
    return d.toLocaleDateString(lang === "ar" ? "ar-EG-u-nu-latn" : "en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  } catch (e) {
    return String(iso);
  }
}
const minutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 1e6;
};

const CSS = `
  :root { --red:#8B0000; --red-dark:#650000; --gold:#C9A227; --bg:#f7f5f2; --text:#1c1c1c; --muted:#6b6b6b; --border:#e4dfd8; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; background: #e9e5df; color: var(--text); font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: 14px; }
  .toolbar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: center; padding: 10px; background: var(--red-dark); color: #fff; }
  .toolbar button, .toolbar a { background: #fff; color: var(--red); border: 0; border-radius: 6px; padding: 8px 16px; font-weight: 700; font-size: 0.9rem; cursor: pointer; text-decoration: none; }
  .toolbar .hint { font-size: 0.8rem; opacity: 0.85; }
  .sheet { width: 210mm; min-height: 297mm; margin: 14px auto; background: var(--bg); box-shadow: 0 6px 30px rgba(0,0,0,0.25); padding: 7mm 9mm; position: relative; }
  .sheet ~ .sheet { page-break-before: always; }
  .page-head { display: flex; align-items: center; gap: 5mm; padding: 4mm; color: #fff; background: linear-gradient(135deg, var(--red), var(--red-dark)); border-bottom: 1.2mm solid var(--gold); }
  .page-head img { height: 20mm; width: auto; flex: none; }
  .page-head .t { flex: 1; }
  .page-head .org { font-size: 8.5pt; font-weight: 700; color: #f3dfa0; }
  .page-head h1 { margin: 1mm 0 0; font-size: 17pt; line-height: 1.2; }
  .page-head p { margin: 1mm 0 0; font-size: 10.5pt; color: #f3dfa0; font-weight: 700; }
  .court-badge { flex: none; min-width: 26mm; text-align: center; background: var(--gold); color: #1c1c1c; border-radius: 3mm; padding: 2mm 3mm; }
  .court-badge small { display: block; font-size: 8.5pt; font-weight: 700; }
  .court-badge b { display: block; font-size: 30pt; line-height: 1; }
  table.grid { width: 100%; border-collapse: collapse; margin-top: 4mm; font-size: 10.5pt; background: #fff; }
  table.grid th { background: #111; color: var(--gold); font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; padding: 2mm; text-align: start; }
  table.grid tr { page-break-inside: avoid; }
  table.grid td { padding: 2.6mm 2mm; border-bottom: 0.3mm solid var(--border); vertical-align: middle; }
  table.grid tr:nth-child(even) td { background: #faf8f5; }
  table.grid td.c, table.grid th.c { text-align: center; }
  table.grid td.c { direction: ltr; unicode-bidi: isolate; }
  table.grid td.name { font-weight: 700; }
  table.grid td.vs { text-align: center; color: var(--muted); font-size: 9pt; width: 8mm; }
  table.grid td.blank { width: 28mm; border: 0.4mm solid #999; background: #fff !important; }
  table.grid td.tbd { color: var(--muted); font-weight: 500; font-style: italic; }
  table.grid td.won { color: #0a6b2d; }
  table.grid tr.done td { color: #555; }
  .stage { font-size: 9pt; color: var(--muted); }
  .sign { display: flex; gap: 10mm; margin-top: 10mm; }
  .sign div { flex: 1; border-top: 0.4mm solid #444; padding-top: 1.5mm; text-align: center; font-size: 9.5pt; color: var(--muted); }
  .foot { margin-top: 4mm; font-size: 8.5pt; color: var(--muted); text-align: center; }
  h3.cap { margin: 5mm 0 0; font-size: 12pt; color: var(--red); }
  table.cc { width: 100%; border-collapse: collapse; margin-top: 2mm; font-size: 10pt; text-align: center; background: #fff; }
  table.cc th, table.cc td { border: 0.3mm solid var(--border); padding: 1.6mm 1mm; }
  table.cc thead th { background: #111; color: var(--gold); font-size: 8.5pt; }
  table.cc tbody th, table.cc tfoot th { text-align: start; background: #f1ede7; white-space: nowrap; }
  table.cc td.tot, table.cc tfoot td { font-weight: 800; background: #f1ede7; }
  @page { size: A4; margin: 0; }
  @media print {
    body { background: #fff; }
    .toolbar { display: none !important; }
    .sheet { margin: 0; box-shadow: none; width: 210mm; min-height: 297mm; }
  }
  @media (max-width: 800px) { .sheet { width: auto; margin: 8px; } }
`;

// Every real (non-bye) match of the tournament as one flat, labelled list.
function collectMatches(tn, lang) {
  const ar = lang === "ar";
  const out = [];
  if (Array.isArray(tn.groups)) {
    tn.groups.forEach((g, gi) =>
      g.matches.forEach((m) =>
        out.push({
          stage: (ar ? "المجموعة " : "Group ") + String.fromCharCode(65 + gi),
          stageKey: "g",
          court: m.court || 0,
          time: m.time || "",
          a: m.aLabel,
          b: m.bLabel,
          decided: !!m.result,
          scoreA: m.result ? m.result.scoreA : null,
          scoreB: m.result ? m.result.scoreB : null,
          winnerId: m.result ? m.result.winnerId : null,
          aId: m.a,
          bId: m.b,
          order: out.length,
        })
      )
    );
  }
  const rounds = tn.knockout && Array.isArray(tn.knockout.rounds) ? tn.knockout.rounds : [];
  rounds.forEach((round, ri) => {
    const label =
      tn.finalsMode === "table"
        ? ar ? "النهائيات" : "Finals"
        : ri === rounds.length - 1
        ? ar ? "النهائي" : "Final"
        : ri === rounds.length - 2
        ? ar ? "نصف النهائي" : "Semifinal"
        : (ar ? "الدور " : "Round ") + (ri + 1);
    round.forEach((m) => {
      if (m.bye) return;
      out.push({
        stage: label,
        stageKey: "k" + ri,
        court: m.court || 0,
        time: m.time || "",
        a: m.aLabel,
        b: m.bLabel,
        decided: !!m.winnerId,
        scoreA: m.scoreA,
        scoreB: m.scoreB,
        winnerId: m.winnerId,
        aId: m.a,
        bId: m.b,
        order: out.length,
      });
    });
  });
  return out;
}

function renderSchedulePrint({ event, tn, view, lang, courtFilter }) {
  const ar = lang === "ar";
  const dir = ar ? "rtl" : "ltr";
  const L = (a, e) => (ar ? a : e);
  const title = ar ? event.nameAr || event.nameEn : event.nameEn || event.nameAr;
  const subtitle = ar ? event.nameEn : event.nameAr;
  const all = collectMatches(tn, lang).sort((x, y) => minutes(x.time) - minutes(y.time) || x.court - y.court || x.order - y.order);
  const courtCount = tn.schedule && tn.schedule.courts ? tn.schedule.courts : Math.max(1, ...all.map((m) => m.court));
  const tbd = L("لم يُحدد بعد", "TBD");
  const orgLine = L("النادي الأهلي · لجنة الرياضة الترفيهية – التجمع الخامس، القاهرة الجديدة", "Al Ahly Club · Recreational Sports Committee – Fifth Settlement, New Cairo");
  const crest = `<img src="/ahly-crest-logo.png" alt="" />`;

  const nameCell = (label, won) => (label ? `<td class="name${won ? " won" : ""}">${esc(label)}${won ? " ✓" : ""}</td>` : `<td class="name tbd">${esc(tbd)}</td>`);
  const resultCell = (m) => {
    if (!m.decided) return `<td class="blank"></td>`;
    const hasScore = m.scoreA != null && m.scoreA !== "" && m.scoreB != null && m.scoreB !== "";
    return `<td class="c">${hasScore ? esc(`${m.scoreA} - ${m.scoreB}`) : "✓"}</td>`;
  };
  const won = (m, side) => !!m.winnerId && m.winnerId === (side === "a" ? m.aId : m.bId);

  const head = (badge) => `<header class="page-head">${crest}<div class="t"><div class="org">${esc(orgLine)}</div><h1>${esc(title)}${subtitle && subtitle !== title ? ` <small style="font-size:11pt;opacity:.8">${esc(subtitle)}</small>` : ""}</h1><p>${esc(dateText(event.date, lang))}${tn.schedule && tn.schedule.startTime ? " · " + esc(L("البداية ", "Start ") + timeText(tn.schedule.startTime, lang)) : ""}</p></div>${badge || ""}</header>`;

  // ----------------------------------------------------- one sheet per court
  function courts() {
    const used = [];
    for (let c = 1; c <= courtCount; c++) if (all.some((m) => m.court === c)) used.push(c);
    if (all.some((m) => !m.court || m.court > courtCount)) used.push(0);
    const list = courtFilter ? used.filter((c) => c === courtFilter) : used;
    if (!list.length) return `<section class="sheet" dir="${dir}">${head("")}<p class="foot">${esc(L("لا توجد مباريات مجدولة.", "No scheduled matches."))}</p></section>`;
    return list
      .map((c) => {
        const mine = all.filter((m) => (c === 0 ? !m.court || m.court > courtCount : m.court === c));
        const badge = `<div class="court-badge"><small>${esc(c === 0 ? L("بدون ملعب", "No court") : L("الملعب", "Court"))}</small><b>${c === 0 ? "–" : c}</b></div>`;
        const rows = mine
          .map(
            (m, i) => `<tr class="${m.decided ? "done" : ""}"><td class="c">${i + 1}</td><td class="c"><b>${esc(m.time || "")}</b></td><td class="stage">${esc(m.stage)}</td>${nameCell(m.a, won(m, "a"))}<td class="vs">${esc(L("ضد", "vs"))}</td>${nameCell(m.b, won(m, "b"))}${resultCell(m)}</tr>`
          )
          .join("");
        return `<section class="sheet" dir="${dir}">${head(badge)}
          <table class="grid"><thead><tr><th class="c">#</th><th class="c">${esc(L("الوقت", "Time"))}</th><th>${esc(L("الدور", "Round"))}</th><th>${esc(L("اللاعب الأول", "Player 1"))}</th><th></th><th>${esc(L("اللاعب الثاني", "Player 2"))}</th><th class="c">${esc(L("النتيجة", "Score"))}</th></tr></thead><tbody>${rows}</tbody></table>
          <p class="foot">${esc(L(`${mine.length} مباراة على هذا الملعب — اكتب النتيجة في الخانة وسلّمها لمنظّم البطولة. أسماء الأدوار القادمة تظهر بعد انتهاء الدور السابق.`, `${mine.length} matches on this court — write the score in the box and hand the sheet to the tournament manager. Names for later rounds appear once the earlier round is finished.`))}</p>
          <div class="sign"><div>${esc(L("حكم الملعب", "Court referee"))}</div><div>${esc(L("مدير البطولة", "Tournament manager"))}</div></div>
        </section>`;
      })
      .join("");
  }

  // ----------------------------------------------------- master schedule + chart
  function chart() {
    const cols = [];
    const keys = [];
    all.forEach((m) => { if (!keys.includes(m.stageKey)) { keys.push(m.stageKey); cols.push({ key: m.stageKey, label: m.stage }); } });
    const rows = [];
    for (let c = 1; c <= courtCount; c++) rows.push(c);
    const cell = (c, key) => all.filter((m) => m.stageKey === key && m.court === c).length;
    const body = rows.map((c) => {
      const cells = cols.map((col) => cell(c, col.key));
      return `<tr><th scope="row">${esc(L("ملعب ", "Court "))}${c}</th>${cells.map((n) => `<td>${n || "–"}</td>`).join("")}<td class="tot">${cells.reduce((a, b) => a + b, 0)}</td></tr>`;
    }).join("");
    const colTot = cols.map((col) => all.filter((m) => m.stageKey === col.key && m.court >= 1 && m.court <= courtCount).length);
    return `<h3 class="cap">${esc(L("عدد المباريات على كل ملعب في كل جولة", "Matches per court per round"))}</h3>
      <table class="cc"><thead><tr><th>${esc(L("الملعب", "Court"))}</th>${cols.map((c) => `<th>${esc(c.label)}</th>`).join("")}<th>${esc(L("الإجمالي", "Total"))}</th></tr></thead><tbody>${body}</tbody><tfoot><tr><th scope="row">${esc(L("الإجمالي", "Total"))}</th>${colTot.map((n) => `<td>${n}</td>`).join("")}<td>${colTot.reduce((a, b) => a + b, 0)}</td></tr></tfoot></table>`;
  }
  function timeView() {
    const rows = all
      .map((m) => `<tr class="${m.decided ? "done" : ""}"><td class="c"><b>${esc(m.time || "")}</b></td><td class="c">${m.court ? m.court : "–"}</td><td class="stage">${esc(m.stage)}</td>${nameCell(m.a, won(m, "a"))}<td class="vs">${esc(L("ضد", "vs"))}</td>${nameCell(m.b, won(m, "b"))}${resultCell(m)}</tr>`)
      .join("");
    return `<section class="sheet" dir="${dir}">${head("")}${chart()}
      <h3 class="cap">${esc(L("جدول المباريات بالوقت", "Full schedule by time"))}</h3>
      <table class="grid"><thead><tr><th class="c">${esc(L("الوقت", "Time"))}</th><th class="c">${esc(L("الملعب", "Court"))}</th><th>${esc(L("الدور", "Round"))}</th><th>${esc(L("اللاعب الأول", "Player 1"))}</th><th></th><th>${esc(L("اللاعب الثاني", "Player 2"))}</th><th class="c">${esc(L("النتيجة", "Score"))}</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="foot">${esc(L(`${all.length} مباراة — يمكن أن تتغير الأوقات إذا تأخّرت الجولات.`, `${all.length} matches — times can shift if rounds run late.`))}</p>
    </section>`;
  }

  const toolbar = `<div class="toolbar"><button id="print-btn" type="button">${esc(L("طباعة / حفظ PDF", "Print / Save as PDF"))}</button><span class="hint">${esc(L("اختر «حفظ كـ PDF» من نافذة الطباعة لحفظ نسخة", "Choose “Save as PDF” in the print dialog to keep a copy"))}</span></div>`;
  const bodyHtml = view === "time" ? timeView() : courts();
  return `<!doctype html>
<html lang="${lang}" dir="${dir}"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>${CSS}</style></head>
<body>${toolbar}${bodyHtml}<script src="/print.js"></script></body></html>`;
}

module.exports = { renderSchedulePrint };
