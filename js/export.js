/*
 * RepoTomo 書き出し
 *  - Word（.docx）／Excel（.xlsx）をブラウザの中で作成（JSZip使用）
 *  - カレンダー：.ics ファイル、Googleカレンダー追加リンク
 */
(function () {
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const safeName = (s) => String(s || "report").replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 80);

  let dlPromise = null;
  function downloadsCap() {
    if (!dlPromise) dlPromise = (window.claude && window.claude.use) ? window.claude.use("downloads").catch(() => null) : Promise.resolve(null);
    return dlPromise;
  }

  async function saveFile(filename, blob) {
    const d = await downloadsCap();
    if (d) {
      try { await d.save({ filename, data: blob }); return "saved"; }
      catch (e) {
        if (e && e.code === "declined") return "declined";
        if (e && e.code === "rate_limited") return "busy";
        throw new Error("この形式のファイルはここでは保存できません。");
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    return "saved";
  }

  /* ---------- Word ---------- */
  function run(text, opt) {
    opt = opt || {};
    const rpr = `<w:rPr><w:rFonts w:ascii="Yu Mincho" w:hAnsi="Yu Mincho" w:eastAsia="游明朝"/>${opt.b ? "<w:b/>" : ""}<w:sz w:val="${opt.sz || 21}"/>${opt.color ? `<w:color w:val="${opt.color}"/>` : ""}</w:rPr>`;
    return `<w:r>${rpr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
  }
  function para(text, opt) {
    opt = opt || {};
    const ppr = `<w:pPr>${opt.center ? '<w:jc w:val="center"/>' : ""}${opt.right ? '<w:jc w:val="right"/>' : ""}<w:spacing w:after="${opt.after == null ? 80 : opt.after}" w:line="360" w:lineRule="auto"/>${opt.indent ? '<w:ind w:firstLineChars="100" w:firstLine="210"/>' : ""}</w:pPr>`;
    return `<w:p>${ppr}${run(text, opt)}</w:p>`;
  }

  async function buildDocx(rep, header) {
    const lines = String(rep.body || "").split("\n");
    const meta = [rep.subject, header && header.date].filter(Boolean).join("　");
    let body = para(rep.title || "レポート", { b: true, sz: 30, center: true, after: 120 });
    if (meta) body += para(meta, { right: true, sz: 20, color: "555555", after: 60 });
    body += para("学籍番号：　　　　　　　氏名：", { right: true, sz: 20, after: 240 });
    for (const l of lines) {
      const isHead = /^(\d+[.．、]|[①-⑩]|【|■)/.test(l.trim()) && l.trim().length < 40;
      body += l.trim() === "" ? para("", { after: 0 }) : para(l, { indent: !isHead, b: isHead });
    }
    const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="851" w:footer="992" w:gutter="0"/><w:docGrid w:type="lines" w:linePitch="360"/></w:sectPr></w:body></w:document>`;
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    zip.file("word/document.xml", doc);
    return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  }

  /* ---------- Excel ---------- */
  function colName(i) { let s = ""; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  async function buildXlsx(sheets) {
    const zip = new JSZip();
    const wbSheets = sheets.map((sh, i) => `<sheet name="${esc(sh.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${wbSheets}</sheets></workbook>`);
    zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    zip.file("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Yu Gothic"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Yu Gothic"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2C6E72"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFC9D1DA"/></left><right style="thin"><color rgb="FFC9D1DA"/></right><top style="thin"><color rgb="FFC9D1DA"/></top><bottom style="thin"><color rgb="FFC9D1DA"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf></cellXfs></styleSheet>`);
    sheets.forEach((sh, si) => {
      const cols = (sh.cols || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
      const rows = sh.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
        const ref = colName(ci) + (ri + 1);
        const st = ri === 0 && sh.header ? 2 : 1;
        if (typeof v === "number") return `<c r="${ref}" s="${st}"><v>${v}</v></c>`;
        return `<c r="${ref}" s="${st}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      }).join("")}</row>`).join("");
      zip.file(`xl/worksheets/sheet${si + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sh.header ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : ""}${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${rows}</sheetData></worksheet>`);
    });
    return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  function countChars(s) { return String(s || "").replace(/\s/g, "").length; }

  function reportSheet(rep, folderName) {
    const paras = String(rep.body || "").split("\n").filter((l) => l.trim());
    const rows = [["項目", "内容"], ["タイトル", rep.title || ""], ["科目", rep.subject || ""], ["フォルダ", folderName || ""], ["作成日", (rep.createdAt || "").slice(0, 10)], ["文字数", countChars(rep.body)]];
    paras.forEach((p, i) => rows.push([`段落${i + 1}`, p]));
    return { name: "レポート", header: true, cols: [12, 90], rows };
  }
  function folderSheet(reports, folderName) {
    const rows = [["タイトル", "科目", "作成日", "文字数", "本文"]];
    reports.forEach((r) => rows.push([r.title || "", r.subject || "", (r.createdAt || "").slice(0, 10), countChars(r.body), r.body || ""]));
    return { name: folderName || "フォルダ", header: true, cols: [36, 18, 12, 8, 100], rows };
  }

  /* ---------- Calendar ---------- */
  const pad = (n) => String(n).padStart(2, "0");
  function stamp(date, time, addMin) {
    const [y, m, d] = date.split("-").map(Number);
    const [hh, mm] = (time || "09:00").split(":").map(Number);
    const dt = new Date(y, m - 1, d, hh, mm + (addMin || 0));
    return `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
  }
  function googleLink(ev) {
    const p = new URLSearchParams({ action: "TEMPLATE", text: ev.title, dates: `${stamp(ev.date, ev.time)}/${stamp(ev.date, ev.time, 30)}`, ctz: "Asia/Tokyo", details: `${ev.subject ? "科目：" + ev.subject + "\n" : ""}RepoTomoから追加` });
    return "https://calendar.google.com/calendar/render?" + p.toString();
  }
  function buildIcs(events) {
    const now = new Date();
    const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}00Z`;
    const icsEsc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
    const body = events.map((e) => [
      "BEGIN:VEVENT",
      `UID:${e.id}@repotomo`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;TZID=Asia/Tokyo:${stamp(e.date, e.time)}`,
      `DTEND;TZID=Asia/Tokyo:${stamp(e.date, e.time, 30)}`,
      `SUMMARY:${icsEsc(e.title)}`,
      `DESCRIPTION:${icsEsc(e.subject ? "科目：" + e.subject : "")}`,
      "BEGIN:VALARM", "TRIGGER:-P1D", "ACTION:DISPLAY", `DESCRIPTION:${icsEsc(e.title)}`, "END:VALARM",
      "END:VEVENT"
    ].join("\r\n")).join("\r\n");
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//RepoTomo//JA", "CALSCALE:GREGORIAN",
      "BEGIN:VTIMEZONE", "TZID:Asia/Tokyo", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0900", "TZOFFSETTO:+0900", "TZNAME:JST", "END:STANDARD", "END:VTIMEZONE",
      body, "END:VCALENDAR"].join("\r\n");
  }

  window.RepoExport = { saveFile, buildDocx, buildXlsx, reportSheet, folderSheet, googleLink, buildIcs, safeName, countChars, downloadsCap };
})();
