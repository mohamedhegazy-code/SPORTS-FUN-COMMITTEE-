"use strict";
// Printable A4 sheets for a Swiss (chess) tournament, generated server-side
// from the admin session: the regulation poster, a round's pairings sheet,
// and the standings + prizes sheet. Styled with the portal's own palette
// (Al Ahly red / gold on warm cream) and font stack, with a chess-board
// border like the committee's regulation flyer. Pure HTML+CSS - the Print
// button is wired by /print.js (inline scripts are blocked by the CSP).

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function hhmm(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || ""));
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
}
function timeText(str, lang) {
  const t = hhmm(str);
  if (!t) return "";
  const h12 = t.h % 12 === 0 ? 12 : t.h % 12;
  const mm = String(t.m).padStart(2, "0");
  if (lang === "ar") {
    const suffix = t.h < 12 ? "صباحاً" : t.h < 16 ? "ظهراً" : "مساءً";
    return `${h12}:${mm} ${suffix}`;
  }
  return `${h12}:${mm} ${t.h < 12 ? "AM" : "PM"}`;
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
const pts = (n) => {
  const whole = Math.floor(n);
  return n - whole === 0.5 ? (whole ? `${whole}½` : "½") : String(n);
};
const tb = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100).replace(/\.5$/, "½"));
const egp = (n, lang) => `${Number(n).toLocaleString("en-US")} ${lang === "ar" ? "جنيه" : "EGP"}`;

const CSS = `
  :root { --red:#8B0000; --red-dark:#650000; --gold:#C9A227; --bg:#f7f5f2; --text:#1c1c1c; --muted:#6b6b6b; --border:#e4dfd8; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; background: #e9e5df; color: var(--text); font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: 14px; }
  .toolbar { position: sticky; top: 0; z-index: 5; display: flex; gap: 10px; align-items: center; justify-content: center; padding: 10px; background: var(--red-dark); color: #fff; }
  .toolbar button, .toolbar a { background: #fff; color: var(--red); border: 0; border-radius: 6px; padding: 8px 16px; font-weight: 700; font-size: 0.9rem; cursor: pointer; text-decoration: none; font-family: inherit; }
  .toolbar .hint { font-size: 0.8rem; opacity: 0.85; }
  .sheet { width: 210mm; min-height: 297mm; margin: 14px auto; background: var(--bg); box-shadow: 0 6px 30px rgba(0,0,0,0.25); padding: 6mm 9mm 6mm; position: relative; }
  .sheet ~ .sheet { page-break-before: always; }
  .checker { height: 7mm; background: repeating-conic-gradient(#161616 0 25%, #fff 0 50%) 0 0 / 7mm 7mm; border: 0.3mm solid #161616; }
  .hero { display: flex; align-items: stretch; margin: 3mm 0 0; color: #fff; background: linear-gradient(135deg, var(--red), var(--red-dark)); border-bottom: 1.2mm solid var(--gold); }
  .hero .crest { width: 34mm; background: #111; display: flex; align-items: center; justify-content: center; padding: 3mm; flex: none; }
  .hero .crest img { max-width: 100%; max-height: 26mm; object-fit: contain; }
  .hero .titles { flex: 1; text-align: center; padding: 4mm 5mm; display: flex; flex-direction: column; justify-content: center; gap: 1.5mm; }
  .hero h1 { margin: 0; font-size: 24pt; line-height: 1.15; font-weight: 800; }
  .hero h2 { margin: 0; font-size: 13pt; font-weight: 700; color: var(--gold); letter-spacing: 0.04em; font-family: Anton, "Segoe UI", Arial, sans-serif; text-transform: uppercase; }
  .hero .organizer { margin-top: 1.5mm; font-size: 11pt; opacity: 0.95; }
  .strip { display: grid; grid-template-columns: repeat(3, 1fr); background: var(--gold); color: #1c1c1c; text-align: center; }
  .strip > div { padding: 2mm 2mm; border-inline-start: 0.4mm solid rgba(255,255,255,0.7); }
  .strip > div:first-child { border-inline-start: 0; }
  .strip .k { font-size: 8.5pt; opacity: 0.8; }
  .strip .v { font-size: 13pt; font-weight: 800; }
  .ribbon { margin: 2.5mm 0; text-align: center; border: 0.4mm solid var(--red); background: #fbeaea; color: var(--red); font-weight: 800; padding: 2mm; font-size: 10.5pt; }
  .sec-title { background: #111; color: #fff; text-align: center; font-weight: 800; font-size: 13pt; padding: 1.6mm 4mm; border-top: 1mm solid var(--red); margin-top: 3mm; }
  .sec-title small { display: block; font-size: 8.5pt; font-weight: 600; color: var(--gold); letter-spacing: 0.05em; }
  .rules { list-style: none; margin: 0; padding: 2.5mm 4mm; display: grid; grid-template-columns: 1fr 1fr; gap: 1.5mm 8mm; background: #f1ede7; border-bottom: 0.4mm solid var(--border); }
  .rules li { padding-inline-start: 5mm; position: relative; font-size: 11pt; font-weight: 600; }
  .rules li::before { content: "♙"; position: absolute; inset-inline-start: 0; color: var(--red); }
  .prizes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; margin-top: 3mm; align-items: start; }
  .prize-col { border: 0.4mm solid var(--border); background: #fff; }
  .prize-col .head { background: var(--red); color: #fff; text-align: center; padding: 2.5mm 2mm; }
  .prize-col .head b { display: block; font-size: 12.5pt; }
  .prize-col .head span { font-size: 8.5pt; color: var(--gold); font-weight: 700; letter-spacing: 0.05em; }
  .prize-col .sub { display: flex; background: #111; color: var(--gold); font-size: 8.5pt; font-weight: 700; }
  .prize-col .sub span { flex: 1; padding: 1.5mm 2.5mm; }
  .prize-col .row { display: flex; border-top: 0.3mm solid var(--border); font-size: 10.5pt; }
  .prize-col .row span { padding: 1.4mm 2.5mm; }
  .prize-col .row .pr .extra { display: block; font-size: 8pt; color: var(--muted); font-weight: 600; }
  .prize-col .row .pl { width: 30%; border-inline-end: 0.3mm solid var(--border); font-weight: 600; }
  .prize-col .row .pr { flex: 1; font-weight: 800; }
  .prize-col .row.first .pr { color: var(--red); }
  .prize-col .row .who { display: block; font-weight: 700; font-size: 9.5pt; color: var(--text); }
  .prize-col .row .amt { color: var(--red); font-weight: 800; }
  .total { margin-top: 3mm; background: #111; border-top: 1mm solid var(--gold); border-bottom: 1mm solid var(--gold); color: #fff; text-align: center; padding: 2.2mm; font-size: 14pt; font-weight: 800; }
  .total b { color: var(--gold); font-size: 17pt; }
  .note { text-align: center; color: var(--muted); font-size: 9.5pt; margin: 2mm 0 0; }
  .dress { margin-top: 3mm; border-inline-start: 1mm solid var(--red); background: #f1ede7; }
  .dress ul { margin: 0; padding: 2mm 5mm; list-style: none; }
  .dress li { font-size: 10.5pt; font-weight: 600; padding: 0.5mm 0; padding-inline-start: 5mm; position: relative; }
  .dress li::before { content: "♙"; position: absolute; inset-inline-start: 0; color: var(--red); }
  .page-head { display: flex; align-items: center; gap: 5mm; padding: 4mm; color: #fff; background: linear-gradient(135deg, var(--red), var(--red-dark)); border-bottom: 1.2mm solid var(--gold); margin-top: 3mm; }
  .page-head img { height: 18mm; background: #111; padding: 2mm; flex: none; }
  .page-head .t { flex: 1; }
  .page-head h1 { margin: 0; font-size: 17pt; }
  .page-head p { margin: 1mm 0 0; font-size: 10.5pt; color: #f3dfa0; font-weight: 700; }
  table.grid { width: 100%; border-collapse: collapse; margin-top: 4mm; font-size: 10.5pt; background: #fff; }
  table.grid th { background: #111; color: var(--gold); font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; padding: 2mm 2mm; text-align: start; }
  table.grid tr { page-break-inside: avoid; }
  table.grid td { padding: 2.2mm 2mm; border-bottom: 0.3mm solid var(--border); vertical-align: middle; }
  table.grid tr:nth-child(even) td { background: #faf8f5; }
  table.grid td.c, table.grid th.c { text-align: center; }
  table.grid td.c { direction: ltr; unicode-bidi: isolate; }
  table.grid td.name { font-weight: 700; }
  table.grid td.blank { width: 22mm; border: 0.4mm solid #999; background: #fff !important; }
  table.boards td { padding: 3.4mm 2mm; font-size: 11pt; }
  table.grid tr.prize td { background: #fff6d6; font-weight: 700; }
  .tag { display: inline-block; font-size: 7.5pt; font-weight: 800; padding: 0.3mm 1.8mm; border-radius: 99px; margin-inline-start: 1.5mm; vertical-align: middle; }
  .tag.w { background: #f6dce6; color: #8a1c4a; }
  .tag.j { background: #dbe8f6; color: #1c4c73; }
  .sign { display: flex; gap: 10mm; margin-top: 12mm; }
  .sign div { flex: 1; border-top: 0.4mm solid #444; padding-top: 1.5mm; text-align: center; font-size: 9.5pt; color: var(--muted); }
  .foot { margin-top: 4mm; font-size: 8.5pt; color: var(--muted); text-align: center; }
  h3.cap { margin: 5mm 0 0; font-size: 12pt; color: var(--red); }
  @page { size: A4; margin: 0; }
  @media print {
    body { background: #fff; }
    .toolbar { display: none !important; }
    .sheet { margin: 0; box-shadow: none; width: 210mm; min-height: 297mm; }
    .sheet.one-page { height: 295mm; min-height: 0; overflow: hidden; }
  }
  @media (max-width: 800px) { .sheet { width: auto; margin: 8px; } }
`;

function renderSwissPrint({ event, tn, view, roundNumber, lang, labels }) {
  const ar = lang === "ar";
  const dir = ar ? "rtl" : "ltr";
  const L = (a, e) => (ar ? a : e); // main-language text
  const sub = (a, e) => (ar ? e : a); // secondary-language text
  const info = tn.swiss.info || {};
  const sw = tn.swiss;
  const title = ar ? event.nameAr || event.nameEn : event.nameEn || event.nameAr;
  const subtitle = ar ? event.nameEn : event.nameAr;
  const firstTime = sw.rounds && sw.rounds[0] && sw.rounds[0].time ? sw.rounds[0].time : tn.schedule ? tn.schedule.startTime : event.startTime || "";
  const crest = `<img src="/ahly-crest.png" alt="" />`;

  const toolbar = `<div class="toolbar"><button id="print-btn" type="button">${esc(L("طباعة / حفظ PDF", "Print / Save as PDF"))}</button><span class="hint">${esc(L("اختر «حفظ كـ PDF» من نافذة الطباعة لحفظ نسخة", "Choose “Save as PDF” in the print dialog to keep a copy"))}</span></div>`;
  const checker = '<div class="checker"></div>';

  // ---------------------------------------------------------- regulation
  function regulation() {
    const placeName = (n) =>
      ar
        ? ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس"][n - 1] || String(n)
        : ["1st", "2nd", "3rd", "4th", "5th", "6th"][n - 1] || `${n}th`;
    const rankingCol = (head1, head2, prizes) => `
      <div class="prize-col">
        <div class="head"><b>${esc(head1)}</b><span>${esc(head2)}</span></div>
        <div class="sub"><span>${esc(L("المركز", "Place"))}</span><span>${esc(L("الجائزة", "Prize"))}</span></div>
        ${prizes
          .map((amt, i) => `<div class="row ${i === 0 ? "first" : ""}"><span class="pl">${esc(placeName(i + 1))}</span><span class="pr">${esc(egp(amt, lang))}</span></div>`)
          .join("")}
      </div>`;
    const prizeCols = [
      [L("الترتيب العام — المفتوحة", "Overall — Open"), "OPEN CATEGORY", sw.prizes.open],
      [L("فئة السيدات", "Women"), "WOMEN", sw.prizes.women],
      [L("فئة الناشئين", "Juniors (under 14)"), "JUNIORS (UNDER 14)", sw.prizes.junior],
    ].filter((c) => c[2].length);
    const prizeNote = (ar ? info.prizeNoteAr : info.prizeNoteEn) || "";
    const prizeBlock = sw.hasPrizes
      ? `<div class="sec-title">${esc(L("الجوائز", "Prizes"))}<small>${esc(sub("الجوائز", "PRIZES"))}</small></div>
      <div class="prizes" style="grid-template-columns: repeat(${prizeCols.length}, 1fr);">
        ${prizeCols.map((c) => rankingCol(c[0], c[1], c[2])).join("")}
      </div>
      <div class="total">${esc(L("إجمالي جوائز البطولة", "Total prize fund"))} — <b>${esc(egp(sw.prizeTotal, lang))}</b></div>
      ${prizeNote ? `<p class="note">${esc(prizeNote)}</p>` : ""}`
      : "";
    const rules = [
      L("البطولة مفتوحة لجميع اللاعبين", "Open to all players"),
      L(`النظام السويسري — ${sw.totalRounds} ${sw.totalRounds > 10 ? "جولة" : "جولات"}`, `Swiss system — ${sw.totalRounds} rounds`),
      (ar ? info.timeControlAr : info.timeControlEn) || "",
      firstTime ? L(`الجولة الأولى: ${timeText(firstTime, "ar")}`, `First round: ${timeText(firstTime, "en")}`) : "",
      info.ceremonyTime ? L(`حفل الختام وتوزيع الجوائز: ${timeText(info.ceremonyTime, "ar")}`, `Closing ceremony & prizes: ${timeText(info.ceremonyTime, "en")}`) : "",
      L("يُمنع استخدام أي جهاز إلكتروني", "No electronic devices allowed"),
      L("حسم التعادل وفق قوانين FIDE", "Ties are decided by FIDE tie-break rules"),
      sw.hasPrizes ? L("لا تُقسَّم الجائزة بين المتساوين", "Prizes are not shared between tied players") : "",
    ].filter(Boolean);
    const venue = (ar ? info.venueAr : info.venueEn) || "";
    const organizer = (ar ? info.organizerAr : info.organizerEn) || "";
    return `
    <section class="sheet one-page" dir="${dir}">
      ${checker}
      <header class="hero">
        <div class="crest">${crest}</div>
        <div class="titles">
          <h1>${esc(title)}</h1>
          ${subtitle && subtitle !== title ? `<h2>${esc(subtitle)}</h2>` : ""}
          ${organizer ? `<div class="organizer">${esc(organizer)}</div>` : ""}
        </div>
      </header>
      <div class="strip">
        <div><div class="k">${esc(L("التاريخ", "Date"))}</div><div class="v">${esc(dateText(event.date, lang))}</div></div>
        <div><div class="k">${esc(L("بداية البطولة", "First round"))}</div><div class="v">${esc(timeText(firstTime, lang) || "—")}</div></div>
        <div><div class="k">${esc(L("المكان", "Venue"))}</div><div class="v">${esc(venue || "—")}</div></div>
      </div>
      <div class="ribbon">♟ ${esc(L("البطولة ودية وغير مقيمة", "Friendly, unrated tournament"))} — ${esc(sub("البطولة ودية وغير مقيمة", "UNRATED TOURNAMENT"))}</div>
      <div class="sec-title">${esc(L("نظام البطولة", "Tournament format"))}<small>${esc(sub("نظام البطولة", "TOURNAMENT FORMAT"))}</small></div>
      <ul class="rules">${rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      ${prizeBlock}
      <p class="note">${esc(L("شهادة مشاركة لجميع اللاعبين", "Participation certificate for all players"))}${sw.hasPrizes ? " • " + esc(L("الجوائز النقدية تُصرف في حفل الختام", "Cash prizes are handed out at the closing ceremony")) : ""}</p>
      <div class="sec-title">${esc(L("الزي الرسمي", "Dress code"))}<small>${esc(sub("الزي الرسمي", "DRESS CODE"))}</small></div>
      <div class="dress"><ul>
        <li>${esc(L("قميص أو شيرت رياضي خاص بأندية أو أكاديميات رياضية", "Shirt or sports T-shirt of a club or sports academy"))}</li>
        <li>${esc(L("بنطلون وحذاء — يُمنع الحضور بغير الزي المناسب", "Trousers and shoes — entry is refused without proper attire"))}</li>
      </ul></div>
      ${event.descriptionAr || event.descriptionEn ? `<p class="note">${esc(ar ? event.descriptionAr || event.descriptionEn : event.descriptionEn || event.descriptionAr)}</p>` : ""}
      <div style="margin-top:3mm;">${checker}</div>
    </section>`;
  }

  // ------------------------------------------------------------ pairings
  function pairings() {
    const round = sw.rounds.find((r) => r.number === roundNumber) || sw.rounds[sw.rounds.length - 1];
    if (!round) return `<section class="sheet" dir="${dir}"><p>${esc(L("لم يتم سحب أي جولة بعد", "No round has been drawn yet"))}</p></section>`;
    const waves = round.waves > 1;
    const rows = round.pairings
      .filter((p) => p.b != null)
      .map(
        (p) => `<tr>
          <td class="c name">${p.board}</td>
          ${waves ? `<td class="c">${esc(L("طاولة", "Table"))} ${p.table}<br>${esc(timeText(p.time, lang))}</td>` : ""}
          <td class="name">${esc(p.aLabel)}</td>
          <td class="blank"></td>
          <td class="name">${esc(p.bLabel)}</td>
        </tr>`
      )
      .join("");
    const bye = round.pairings.find((p) => p.b == null);
    return `
    <section class="sheet" dir="${dir}">
      ${checker}
      <div class="page-head">${crest}<div class="t"><h1>${esc(title)}</h1>
        <p>${esc(L("مواجهات الجولة", "Round pairings"))} ${round.number} / ${sw.totalRounds}${round.time ? " — " + esc(timeText(round.time, lang)) : ""}</p></div></div>
      <table class="grid boards"><thead><tr>
        <th class="c">${esc(L("اللوحة", "Board"))}</th>${waves ? `<th class="c">${esc(L("الطاولة والوقت", "Table & time"))}</th>` : ""}
        <th>${esc(L("الأبيض", "White"))}</th><th class="c">${esc(L("النتيجة", "Result"))}</th><th>${esc(L("الأسود", "Black"))}</th></tr></thead>
        <tbody>${rows}</tbody></table>
      ${bye ? `<p class="note">${esc(L("راحة (نقطة واحدة): ", "Bye (1 point): "))}<b>${esc(bye.aLabel)}</b></p>` : ""}
      <div class="sign"><div>${esc(L("الحكم الرئيسي", "Chief arbiter"))}</div><div>${esc(L("ختم المنظّم", "Organizer stamp"))}</div></div>
      <div style="margin-top:6mm;">${checker}</div>
    </section>`;
  }

  // ----------------------------------------------------------- standings
  function standings() {
    const prizeCol = (name, list) => `
      <div class="prize-col"><div class="head"><b>${esc(name)}</b></div>
        ${list.length ? list.map((x, i) => `<div class="row ${i === 0 ? "first" : ""}"><span class="pl">${x.place}</span><span class="pr"><span class="who">${esc(x.label)}</span>${x.prize != null ? `<span class="amt">${esc(egp(x.prize, lang))}</span>` : ""}</span></div>`).join("") : `<div class="row"><span class="pr">—</span></div>`}
      </div>`;
    const rows = sw.standings
      .map((r) => {
        const prize = r.rank <= sw.places.open && r.recorded > 0;
        return `<tr class="${prize ? "prize" : ""}">
          <td class="c">${r.rank}</td>
          <td class="name">${esc(r.label)}${r.women ? `<span class="tag w">${esc(L("سيدات", "W"))}</span>` : ""}${r.junior ? `<span class="tag j">${esc(L("ناشئين", "U14"))}</span>` : ""}${r.tiedOnAll ? " ⚠" : ""}</td>
          <td class="c"><b>${pts(r.points)}</b></td><td class="c">${tb(r.buchholzCut1)}</td><td class="c">${tb(r.buchholz)}</td><td class="c">${tb(r.sonnebornBerger)}</td><td class="c">${r.wins}</td>
        </tr>`;
      })
      .join("");
    return `
    <section class="sheet" dir="${dir}">
      ${checker}
      <div class="page-head">${crest}<div class="t"><h1>${esc(title)}</h1>
        <p>${esc(sw.final ? L("النتائج النهائية والجوائز", "Final results & prizes") : L(`الترتيب بعد الجولة ${sw.generatedRounds} من ${sw.totalRounds}`, `Standings after round ${sw.generatedRounds} of ${sw.totalRounds}`))}</p></div></div>
      <div class="sec-title">${esc(sw.hasPrizes ? L("الجوائز", "Prizes") : L("المراكز الأولى", "Top finishers"))}<small>${esc(sw.hasPrizes ? sub("الجوائز", "PRIZES") : sub("المراكز الأولى", "TOP FINISHERS"))}</small></div>
      <div class="prizes">
        ${prizeCol(L("الترتيب العام — المفتوحة", "Overall — Open"), sw.rankings.open)}
        ${prizeCol(L("فئة السيدات", "Women"), sw.rankings.women)}
        ${prizeCol(L("فئة الناشئين (تحت 14)", "Juniors (under 14)"), sw.rankings.junior)}
      </div>
      ${sw.hasPrizes ? `<p class="note">${esc(L("لا تُقسَّم الجائزة بين المتساوين.", "Prizes are not shared between tied players."))} ${esc(L("إجمالي الجوائز", "Total prizes"))}: ${esc(egp(sw.prizeTotal, lang))}</p>` : ""}
      <h3 class="cap">${esc(L("الترتيب العام", "Overall standings"))}</h3>
      <table class="grid"><thead><tr><th class="c">#</th><th>${esc(L("اللاعب", "Player"))}</th><th class="c">${esc(L("نقاط", "Pts"))}</th><th class="c">Bch-1</th><th class="c">Bch</th><th class="c">SB</th><th class="c">${esc(L("فوز", "W"))}</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="note">${esc(L("فض التعادل: المواجهة المباشرة، بوخهولتز-1، بوخهولتز، سونيبورن-بيرجر، عدد الانتصارات (FIDE).", "Tie-breaks: direct encounter, Buchholz cut-1, Buchholz, Sonneborn-Berger, wins (FIDE)."))}</p>
      <div class="sign"><div>${esc(L("الحكم الرئيسي", "Chief arbiter"))}</div><div>${esc(L("ختم المنظّم", "Organizer stamp"))}</div></div>
      <div style="margin-top:6mm;">${checker}</div>
    </section>`;
  }

  const bodyHtml = view === "pairings" ? pairings() : view === "standings" ? standings() : regulation();
  return `<!doctype html>
<html lang="${lang}" dir="${dir}"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" /><link href="https://fonts.googleapis.com/css2?family=Anton&display=swap" rel="stylesheet" />
<style>${CSS}</style></head>
<body>${toolbar}${bodyHtml}<script src="/print.js"></script></body></html>`;
}

module.exports = { renderSwissPrint };
