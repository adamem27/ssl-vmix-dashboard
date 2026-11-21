import { DB, newId, nowIso } from '../db/db.js';
import { badRequest, notFound } from './errors.js';
import { readZip } from './matchboard/matchboard.js';
import { codeKey, nameKey } from './normalize.js';

/**
 * Age and height of the sailors, read from the teams' squad sheets (TEAM SQUAD forms, or one sheet with Code /
 * Country, Family name, First name, Date of birth, Height). Only the date of birth and the height are kept; the
 * commentator screens get the age, never the date.
 */

type Grid = string[][];
/** Country names the squad forms use that differ from the teams' names. */
const NAME_CODES: Record<string, string> = {
  republicofkorea: 'KOR', korea: 'KOR', korearepublic: 'KOR', southkorea: 'KOR', turkey: 'TUR', turkiye: 'TUR', czechrepublic: 'CZE',
  unitedstates: 'USA', unitedstatesofamerica: 'USA', unitedkingdom: 'GBR', greatbritain: 'GBR', uae: 'UAE', vietnam: 'VIE', vietnamsocialistrepublic: 'VIE',
};
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');

/** The first sheet of an .xlsx as rows of cell texts (numbers as Excel writes them, so dates as day serials). */
export function readXlsxGrid(buf: Buffer): Grid {
  const files = new Map(readZip(buf).map((f) => [f.name.replace(/^\/+/, ''), f]));
  const text = (n: string) => files.get(n)?.data().toString('utf8') ?? '';
  const wb = text('xl/workbook.xml');
  const rid = wb.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1];
  const rels = text('xl/_rels/workbook.xml.rels');
  let target = rid ? [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${rid}"`))?.match(/Target="([^"]+)"/)?.[1] : undefined;
  target = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target}`) : 'xl/worksheets/sheet1.xml';
  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const sheet = text(target);
  if (!sheet) throw badRequest('This file has no sheet that can be read.');
  const grid: Grid = [];
  for (const row of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(row[0].match(/\br="(\d+)"/)?.[1] ?? grid.length + 1) - 1;
    const cells: string[] = [];
    for (const c of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = c[1].match(/\br="([A-Z]+)\d+"/)?.[1] ?? '';
      const col = ref.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const t = c[1].match(/\bt="([^"]+)"/)?.[1];
      const v = c[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      const val = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? unxml([...(c[2] ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')) : unxml(v ?? '');
      cells[col >= 0 ? col : cells.length] = val;
    }
    grid[r] = Array.from(cells, (x) => x ?? '');
  }
  return Array.from(grid, (x) => x ?? []);
}

function readCsv(text: string): Grid {
  const sep = (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const out: Grid = []; let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); out.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out;
}

/** A date of birth as ISO (yyyy-mm-dd): an Excel day number, 2001-03-07, or 03/07/2001 (month first, as the form asks). */
export function birthDate(v: string): string {
  const s = (v ?? '').trim();
  if (!s) return '';
  const iso = (y: number, m: number, d: number) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && y > 1920 && y < 2020 ? dt.toISOString().slice(0, 10) : '';
  };
  if (/^\d+(\.\d+)?$/.test(s)) { const n = Number(s); if (n > 7000 && n < 45000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000).toISOString().slice(0, 10); return ''; }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    let y = +m[3]; if (y < 100) y += y > 30 ? 1900 : 2000;
    const a = +m[1], b = +m[2];
    return a > 12 ? iso(y, b, a) : iso(y, a, b);
  }
  return '';
}

/** A height in cm from metres (1.85, 1,85) or cm (185, "185 cm"); '' when it is no sailor's height. */
export function heightCm(v: string): number | null {
  const m = (v ?? '').match(/\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(',', '.'));
  const cm = n < 3 ? n * 100 : n;
  return cm >= 120 && cm <= 230 ? Math.round(cm) : null;
}

/** Age on a day (yyyy-mm-dd) of someone born on another. */
export function ageOn(birth: string, day: string): number | null {
  const b = birth.match(/^(\d{4})-(\d{2})-(\d{2})$/), d = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!b || !d) return null;
  let a = +d[1] - +b[1];
  if (+d[2] < +b[2] || (+d[2] === +b[2] && +d[3] < +b[3])) a--;
  return a >= 0 && a < 110 ? a : null;
}

export interface DetailsSummary { rows: number; matched: number; updated: number; teams: string[]; unknownTeams: string[]; unmatched: string[] }

/** Reads one sheet and writes the date of birth and height of every sailor it finds (team, then name). */
export function importSailorDetails(db: DB, buf: Buffer, filename = ''): DetailsSummary {
  const grid = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50 ? readXlsxGrid(buf) : readCsv(buf.toString('utf8').replace(/^﻿/, ''));
  const norm = (s: string) => nameKey(s ?? '');
  // the header row: family name and first name, with a date of birth or a height
  let h = -1;
  for (let r = 0; r < Math.min(grid.length, 25) && h < 0; r++) {
    const row = grid[r].map(norm);
    if (row.some((c) => /family name|last name|surname/.test(c)) && row.some((c) => /first ?name|given name/.test(c)) && row.some((c) => /birth|height/.test(c))) h = r;
  }
  if (h < 0) throw badRequest('No header row with Family name, First name and Date of birth or Height in the first sheet.');
  const head = grid[h].map(norm);
  const col = (re: RegExp, after = -1) => head.findIndex((c, i) => i > after && re.test(c));
  const cLast = col(/family name|last name|surname/), cFirst = col(/first ?name|given name/);
  const cBirth = col(/birth/), cHeight = col(/height/), cCode = col(/^code$|^team code$|^nation$/), cCountry = col(/^country|^team$/);
  // a squad form names its country once above the table: "COUNTRY : MEXICO"
  let formCountry = '';
  for (let r = 0; r < h; r++) for (const c of grid[r]) { const m = (c ?? '').match(/^\s*country\s*:?\s*(.+)$/i); if (m && !formCountry) formCountry = m[1].trim(); }
  if (!formCountry && cCode < 0 && cCountry < 0) {
    const m = filename.match(/\b([A-Z]{3})\b/);
    if (m) formCountry = m[1];
  }

  const teams = db.prepare('SELECT id, code, name, aliases FROM teams').all() as { id: string; code: string; name: string; aliases: string }[];
  const teamIdx = new Map<string, string>();
  for (const t of teams) teamIdx.set(codeKey(t.code), t.id);
  for (const [name, code] of Object.entries(NAME_CODES)) { const id = teamIdx.get(codeKey(code)); if (id) teamIdx.set(name, id); }
  for (const t of teams) for (const a of [t.name, ...(() => { try { return JSON.parse(t.aliases || '[]') as string[]; } catch { return []; } })()]) { const k = codeKey(a); if (k && !teamIdx.has(k)) teamIdx.set(k, t.id); }
  const sailors = db.prepare('SELECT id, team_id, first_name, last_name, name_key, birth_date, height_cm FROM sailors').all() as { id: string; team_id: string; first_name: string; last_name: string; name_key: string; birth_date: string; height_cm: number | null }[];
  const byTeam = new Map<string, typeof sailors>();
  for (const s of sailors) byTeam.set(s.team_id, [...(byTeam.get(s.team_id) ?? []), s]);

  const sum: DetailsSummary = { rows: 0, matched: 0, updated: 0, teams: [], unknownTeams: [], unmatched: [] };
  const upd = db.prepare('UPDATE sailors SET birth_date = ?, height_cm = ?, updated_at = ? WHERE id = ?');
  const rowsByKey = new Map((db.prepare('SELECT * FROM sailor_details_rows').all() as DetailsRow[]).map((r) => [r.row_key, r]));
  const apply = (hit: (typeof sailors)[number], birth: string, height: number | null, code: string) => {
    sum.matched++;
    if (!sum.teams.includes(code)) sum.teams.push(code);
    const nb = birth || hit.birth_date || '', nh = height ?? hit.height_cm ?? null;
    if (nb !== (hit.birth_date || '') || nh !== (hit.height_cm ?? null)) { upd.run(nb, nh, nowIso(), hit.id); sum.updated++; hit.birth_date = nb; hit.height_cm = nh; }
  };
  const keepRow = (key: string, teamId: string, code: string, first: string, last: string, birth: string, height: number | null) => {
    const t = nowIso(), kept = rowsByKey.get(key);
    if (kept) db.prepare('UPDATE sailor_details_rows SET team_id = ?, team_label = ?, first_name = ?, last_name = ?, birth_date = ?, height_cm = ?, updated_at = ? WHERE id = ?').run(teamId, code, first, last, birth, height, t, kept.id);
    else {
      const id = newId();
      db.prepare('INSERT INTO sailor_details_rows (id, team_id, team_label, first_name, last_name, row_key, birth_date, height_cm, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, teamId, code, first, last, key, birth, height, t, t);
      rowsByKey.set(key, { id, team_id: teamId, team_label: code, first_name: first, last_name: last, row_key: key, birth_date: birth, height_cm: height, status: 'open', sailor_id: null });
    }
  };
  db.transaction(() => {
    for (const row of grid.slice(h + 1)) {
      const last = (row[cLast] ?? '').trim(), first = (row[cFirst] ?? '').trim();
      if (!last || !first || /^please/i.test(last)) continue;
      const birth = cBirth >= 0 ? birthDate(row[cBirth] ?? '') : '';
      const height = cHeight >= 0 ? heightCm(row[cHeight] ?? '') : null;
      if (!birth && height == null) continue;
      sum.rows++;
      const where = (cCode >= 0 && row[cCode]) || (cCountry >= 0 && row[cCountry]) || formCountry;
      const teamId = teamIdx.get(codeKey(where)) ?? (cCountry >= 0 ? teamIdx.get(codeKey(row[cCountry] ?? '')) : undefined) ?? teamIdx.get(codeKey(formCountry));
      if (!teamId) { if (where && !sum.unknownTeams.includes(where)) sum.unknownTeams.push(where); continue; }
      const crew = byTeam.get(teamId) ?? [];
      const k = nameKey(`${first} ${last}`), kr = nameKey(`${last} ${first}`);
      const lk = nameKey(last), fk = nameKey(first);
      // full name either way round, then the family name alone (when only one sailor has it), then a first name + part of the family name
      const hit = crew.find((s) => s.name_key === k || s.name_key === kr)
        ?? (() => { const c = crew.filter((s) => nameKey(s.last_name) === lk); return c.length === 1 ? c[0] : c.find((s) => nameKey(s.first_name) === fk); })()
        ?? crew.find((s) => nameKey(s.first_name) === fk && (lk.split(' ').includes(nameKey(s.last_name)) || nameKey(s.last_name).split(' ').includes(lk.split(' ')[0])));
      const code = teams.find((t) => t.id === teamId)!.code;
      const key = rowKey(code, first, last);
      const kept = rowsByKey.get(key);
      // a row matched by hand before: to that sailor again; an ignored one stays ignored
      if (!hit && kept?.status === 'assigned' && kept.sailor_id) {
        const s2 = crew.find((x) => x.id === kept.sailor_id);
        if (s2) { apply(s2, birth, height, code); keepRow(key, teamId, code, first, last, birth, height); continue; }
      }
      if (!hit) { if (kept?.status !== 'ignored') sum.unmatched.push(`${code} ${first} ${last}`); keepRow(key, teamId, code, first, last, birth, height); continue; }
      if (kept && kept.status === 'open') db.prepare('DELETE FROM sailor_details_rows WHERE id = ?').run(kept.id);
      apply(hit, birth, height, code);
    }
  })();
  return sum;
}

interface DetailsRow { id: string; team_id: string | null; team_label: string; first_name: string; last_name: string; row_key: string; birth_date: string; height_cm: number | null; status: 'open' | 'assigned' | 'ignored'; sailor_id: string | null }
const rowKey = (code: string, first: string, last: string) => `${codeKey(code)}|${nameKey(`${first} ${last}`)}`;

/** Rows the import could not match, with their team's sailors to pick from (the age only, never the date). */
export function unmatchedDetails(db: DB, day: string) {
  const rows = db.prepare(`SELECT r.*, t.code AS code, t.name AS team_name FROM sailor_details_rows r LEFT JOIN teams t ON t.id = r.team_id
    WHERE r.status = 'open' ORDER BY r.team_label, r.last_name COLLATE NOCASE`).all() as (DetailsRow & { code: string | null; team_name: string | null })[];
  const crews = new Map<string, { id: string; name: string; hasData: boolean }[]>();
  for (const id of new Set(rows.map((r) => r.team_id).filter(Boolean) as string[])) {
    crews.set(id, (db.prepare(`SELECT id, first_name, last_name, birth_date, height_cm FROM sailors WHERE team_id = ? ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE`).all(id) as any[])
      .map((s) => ({ id: s.id, name: `${s.first_name} ${s.last_name}`.trim(), hasData: !!(s.birth_date || s.height_cm) })));
  }
  return rows.map((r) => ({
    id: r.id, team: r.code ?? r.team_label, teamName: r.team_name ?? '', first: r.first_name, last: r.last_name,
    age: r.birth_date ? ageOn(r.birth_date, day) : null, heightCm: r.height_cm, sailors: r.team_id ? crews.get(r.team_id) ?? [] : [],
  }));
}

/** A row matched by hand: its date of birth and height go to that sailor, and the next import remembers the match. */
export function assignDetails(db: DB, rowId: string, sailorId: string) {
  const r = db.prepare('SELECT * FROM sailor_details_rows WHERE id = ?').get(rowId) as DetailsRow | undefined;
  if (!r) throw notFound('Row');
  const s = db.prepare('SELECT id, team_id, birth_date, height_cm FROM sailors WHERE id = ?').get(sailorId) as { id: string; team_id: string; birth_date: string; height_cm: number | null } | undefined;
  if (!s) throw notFound('Sailor');
  const t = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE sailors SET birth_date = ?, height_cm = ?, updated_at = ? WHERE id = ?').run(r.birth_date || s.birth_date || '', r.height_cm ?? s.height_cm ?? null, t, s.id);
    db.prepare("UPDATE sailor_details_rows SET status = 'assigned', sailor_id = ?, updated_at = ? WHERE id = ?").run(s.id, t, r.id);
  })();
  return { ok: true };
}

/** A row that is no sailor (a coach, the media manager): not shown again, also after the next import. */
export function ignoreDetails(db: DB, rowId: string) {
  const r = db.prepare("UPDATE sailor_details_rows SET status = 'ignored', updated_at = ? WHERE id = ?").run(nowIso(), rowId);
  if (!r.changes) throw notFound('Row');
  return { ok: true };
}
