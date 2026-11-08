import * as cheerio from 'cheerio';
import type { Importer, ParsedDeclaration, ParsedMember, ParseContext, ParseResult } from './types.js';
import { ParseError } from './types.js';

/**
 * SSL Gold Cup "Daily Crew List Declaration" page (Joomla + Fabrik list), checked against
 * https://onb.sslgoldcup.com/qualify3/index.php/en/daily-weight-declaration (archive, June 2026).
 *
 * What the page actually contains (no API/XHR, no PDF links):
 * - one HTML list table with columns: Country | Sailing Date | Crews | Total Weight | Posted | (View link)
 * - group rows per sailing date such as "11-06(7)" and "No records" rows
 * - Country: organiser code (AUT, BEl, EST, ...); Sailing Date: "DD-MM" without a year
 * - Crews: one cell, each member written as `Name (W:67.00) (J-23) -->Role`
 * - Posted: "DD-MM HH:MM"; View link: .../daily-weight-declaration/details/<list>/<row>
 *
 * Columns are located by header text, never by position or CSS class. Weights (W:) and Total Weight are kept in kg.
 */

const KNOWN_ROLES = [
  'mainsail trimmer', 'main trimmer', 'headsail trimmer', 'jib trimmer', 'trimmer', 'helmsman', 'helmswoman', 'helm',
  'tactician', 'strategist', 'navigator', 'bowman', 'bow', 'mastman', 'mast', 'pitman', 'pit', 'grinder', 'floater',
  'skipper', 'coach', 'reserve', 'substitute',
];

const MARKER = /(?:\(\s*W\s*:\s*([^)]*?)\s*\)\s*)?\(\s*J\s*-?\s*([^)]*?)\s*\)\s*-->\s*/g;

/** "67.00", "67,5 kg" → "67.00" / "67.5"; anything without a number → null. */
export function cleanWeight(raw: string | null | undefined): string | null {
  const m = (raw ?? '').replace(',', '.').match(/\d+(?:\.\d+)?/);
  return m ? m[0] : null;
}

function clean(s: string) { return s.replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim(); }

/** Split the text between two markers into "<role of previous member>" + "<name of next member>". */
function splitRoleAndName(seg: string, warnings: string[]): [string, string] {
  const lines = seg.split('\n').map(clean).filter(Boolean);
  if (lines.length >= 2) return [lines.slice(0, -1).join(' '), lines[lines.length - 1]];
  const s = clean(seg);
  const lower = s.toLowerCase();
  for (const role of [...KNOWN_ROLES].sort((a, b) => b.length - a.length)) {
    if (lower.startsWith(role) && s.length > role.length) {
      const rest = s.slice(role.length);
      // Only accept the split at a word boundary or a lower→upper case join ("trimmerDavid").
      if (/^\s/.test(rest) || /^[A-ZÀ-ÖØ-Þ]/.test(rest)) return [s.slice(0, role.length), clean(rest)];
    }
  }
  const camel = s.search(/[a-zà-ÿ][A-ZÀ-ÖØ-Þ]/);
  if (camel >= 0) return [s.slice(0, camel + 1), clean(s.slice(camel + 1))];
  warnings.push(`Could not separate the position from the name in “${s}”.`);
  return ['', s];
}

export function parseCrewCell(text: string, warnings: string[]): ParsedMember[] {
  const markers = [...text.matchAll(MARKER)];
  if (!markers.length) return [];
  const members: ParsedMember[] = [];
  let name = clean(text.slice(0, markers[0].index));
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    const end = m.index! + m[0].length;
    const nextStart = i + 1 < markers.length ? markers[i + 1].index! : text.length;
    const seg = text.slice(end, nextStart);
    let role: string, nextName = '';
    if (i + 1 < markers.length) [role, nextName] = splitRoleAndName(seg, warnings);
    else role = clean(seg.split('\n').map(clean).filter(Boolean).join(' '));
    const num = clean(m[2] ?? '');
    if (name) members.push({ sourceName: name, number: num || null, position: role || null, weight: cleanWeight(m[1]), sourceId: null });
    else warnings.push('Skipped a crew entry with no name.');
    name = nextName;
  }
  return members;
}

function toIsoDate(raw: string, year: number): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-./](\d{1,2})(?:[-./](\d{2,4}))?$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  let y = m[3] ? Number(m[3]) : year;
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "DD-MM HH:MM" → sortable key, for picking the newest of duplicate postings. */
function postedKey(raw: string | null): string {
  const m = raw?.match(/(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  return m ? `${m[2].padStart(2, '0')}${m[1].padStart(2, '0')}${m[3].padStart(2, '0')}${m[4]}` : '';
}

function cellText($: cheerio.CheerioAPI, el: any): string {
  const html = $(el).html() ?? '';
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr)>/gi, '\n');
  return cheerio.load(`<x>${withBreaks}</x>`)('x').text();
}

export function parseSslFabrikCrewList(html: string, ctx: ParseContext): ParseResult {
  const $ = cheerio.load(html);
  const warnings: string[] = [];
  type Cols = { country: number; date: number; crews: number; posted: number; total: number };
  let found: { table: any; cols: Cols; headerRow: any } | null = null;

  $('table').each((_, table) => {
    if (found) return;
    $(table).find('tr').each((__, tr) => {
      if (found) return false;
      const cells = $(tr).children('th,td').toArray().map((c) => clean($(c).text()).toLowerCase());
      const idx = (re: RegExp) => cells.findIndex((c) => re.test(c));
      const cols = { country: idx(/^(country|team|nation)$/), date: idx(/sailing\s*date|^date$/), crews: idx(/^crews?$/), posted: idx(/^posted$/), total: idx(/total\s*weight/) };
      if (cols.country >= 0 && cols.crews >= 0 && cols.date >= 0) { found = { table, cols, headerRow: tr }; return false; }
      return undefined;
    });
  });
  if (!found) {
    throw new ParseError('Crew table not found (expected columns: Country, Sailing Date, Crews). The page structure may have changed or the URL points to a different page.');
  }
  const { table, cols, headerRow } = found as { table: any; cols: Cols; headerRow: any };
  const byKey = new Map<string, ParsedDeclaration>();
  let rows = 0;

  $(table).find('tr').each((_, tr) => {
    if (tr === headerRow) return;
    const cells = $(tr).children('td').toArray();
    if (cells.length <= Math.max(cols.country, cols.crews, cols.date)) return; // group header / "No records"
    const teamRef = clean($(cells[cols.country]).text());
    const dateRaw = clean($(cells[cols.date]).text());
    if (!teamRef || !dateRaw) return;
    rows++;
    const date = toIsoDate(dateRaw, ctx.year);
    if (!date) { warnings.push(`${teamRef}: unreadable date “${dateRaw}”, row skipped.`); return; }
    const members = parseCrewCell(cellText($, cells[cols.crews]), warnings);
    if (!members.length) warnings.push(`${teamRef} ${dateRaw}: no crew members recognised.`);
    const postedRaw = cols.posted >= 0 && cells[cols.posted] ? clean($(cells[cols.posted]).text()) || null : null;
    const href = $(tr).find('a[href*="details"]').first().attr('href');
    let sourceRef: string | null = null;
    if (href && href !== '#') {
      try { sourceRef = ctx.baseUrl ? new URL(href, ctx.baseUrl).toString() : /^https?:\/\//i.test(href) ? href : null; } catch { sourceRef = null; }
    }
    const totalWeight = cols.total >= 0 && cells[cols.total] ? cleanWeight(clean($(cells[cols.total]).text())) : null;
    const decl: ParsedDeclaration = { teamRef, date, dateRaw, postedRaw, sourceRef, totalWeight, members };
    const key = `${teamRef.toLowerCase()}|${date}`;
    const prev = byKey.get(key);
    if (prev) {
      warnings.push(`${teamRef} ${dateRaw}: the source has several declarations, used the newest.`);
      if (postedKey(prev.postedRaw) > postedKey(postedRaw)) return;
    }
    byKey.set(key, decl);
  });

  if (!rows) warnings.push('The crew table has no declarations yet.');
  return { declarations: [...byKey.values()], warnings };
}

export const sslFabrikCrewList: Importer = {
  id: 'ssl-fabrik-crew-list',
  label: 'SSL Gold Cup – Daily Crew List (tabela HTML)',
  description: 'Fabrik/Joomla list with Country, Sailing Date, Crews, Total Weight, Posted columns.',
  parse: parseSslFabrikCrewList,
};
