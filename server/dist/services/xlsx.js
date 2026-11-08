// cell styles: 0 normal, 1 block title (bold, larger, shaded), 2 header (bold), 3 column names in row 1 (grey)
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="12"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><sz val="9"/><color rgb="FF888888"/><name val="Calibri"/></font></fonts>`
    + `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill></fills>`
    + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
    + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
    + `<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>`
    + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // XML 1.0 forbids most control characters
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
function colName(i) {
    let s = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
        s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
}
/** Excel sheet names: max 31 chars, no []:*?/\ , unique (case-insensitive). */
export function sheetNames(names) {
    const used = new Set();
    return names.map((n) => {
        const base = (n.replace(/[/\\]/g, '-').replace(/[[\]:*?]/g, ' ').replace(/\s+/g, ' ').trim() || 'Sheet').slice(0, 31);
        let name = base;
        for (let i = 2; used.has(name.toLowerCase()); i++)
            name = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
        used.add(name.toLowerCase());
        return name;
    });
}
function sheetXml(sheet) {
    const rows = sheet;
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const styleOf = (i, c) => { const t = rows.styles?.[`${i}:${c}`]; return t === 'title' ? 1 : t === 'head' ? 2 : 0; };
    // a laid-out sheet (styles given) leaves empty cells out so the blocks stand apart; plain tables write every cell
    const line = (r, vals, st) => `<row r="${r}">${vals.map((v, c) => (v === '' && rows.styles && !st(c) ? '' : `<c r="${colName(c)}${r}"${st(c) ? ` s="${st(c)}"` : ''} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`)).join('')}</row>`;
    const body = [line(1, cols, () => (rows.styles ? 3 : 0)), ...rows.map((row, i) => line(i + 2, cols.map((c) => String(row[c] ?? '')), (c) => styleOf(i, c)))].join('');
    const colsXml = rows.widths?.length ? `<cols>${rows.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${colsXml}<sheetData>${body}</sheetData></worksheet>`;
}
export function buildXlsx(sheets) {
    const names = sheetNames(sheets.map((s) => s.name));
    const files = [
        ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
        ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
        ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
        ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
        ['xl/styles.xml', STYLES],
        ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)]),
    ];
    return zipStore(files.map(([n, c]) => [n, Buffer.from(c, 'utf8')]));
}
// ---------- zip (store only) ----------
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(b) {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++)
        c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
export function zipStore(entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const [name, data] of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt32LE(0, 10);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        parts.push(local, nameBuf, data);
        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0);
        cen.writeUInt16LE(20, 4);
        cen.writeUInt16LE(20, 6);
        cen.writeUInt16LE(0x0800, 8);
        cen.writeUInt16LE(0, 10);
        cen.writeUInt32LE(0, 12);
        cen.writeUInt32LE(crc, 16);
        cen.writeUInt32LE(data.length, 20);
        cen.writeUInt32LE(data.length, 24);
        cen.writeUInt16LE(nameBuf.length, 28);
        cen.writeUInt32LE(offset, 42);
        central.push(cen, nameBuf);
        offset += 30 + nameBuf.length + data.length;
    }
    const cenBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cenBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, cenBuf, end]);
}
