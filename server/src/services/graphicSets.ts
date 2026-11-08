import { DB, getSetting, newId, nowIso, setSetting } from '../db/db.js';
import { badRequest, notFound } from './errors.js';

/**
 * General graphics that can exist in several versions at once (like People): welcome, follow us, tickers,
 * race officials, announcements. Each version is one row of its sheet in the vMix workbook; the column
 * names are the field keys, so a GT title with fields named the same maps itself (vMix “Auto”).
 * Fields and defaults follow the SSL26 broadcast boards (finals-broadcast_ssl26_v2) and the jury .gtzip.
 */
export type FieldType = 'text' | 'select' | 'list';
export interface GraphicField { key: string; label: string; type?: FieldType; options?: string[]; placeholder?: string; default?: string; wide?: boolean; hint?: string }
export interface GraphicKind { kind: string; label: string; sheet: string; description: string; fields: GraphicField[]; defaults: { name: string; data: Record<string, string> }[] }

export const GRAPHIC_KINDS: GraphicKind[] = [
  {
    kind: 'welcome', label: 'Welcome', sheet: 'Welcome',
    description: 'Opening board: event name, place and dates.',
    fields: [
      { key: 'heading', label: 'Heading', default: 'WELCOME TO' },
      { key: 'event', label: 'Event', default: 'SSL GOLD CUP 2026' },
      { key: 'stage', label: 'Stage', placeholder: 'FINAL SERIES' },
      { key: 'location', label: 'Location', default: 'RIO DE JANEIRO, BRAZIL' },
      { key: 'dates', label: 'Dates', placeholder: '19 NOV - 13 DEC 2026' },
      { key: 'day', label: 'Day', placeholder: 'DAY 1' },
      { key: 'subtitle', label: 'Subtitle', wide: true },
    ],
    defaults: [{ name: 'Welcome', data: {} }],
  },
  {
    kind: 'socials', label: 'Follow us', sheet: 'Follow us',
    description: 'Social media bar and side panel.',
    fields: [
      { key: 'heading', label: 'Heading', default: 'FOLLOW US' },
      { key: 'website', label: 'Website', default: 'WWW.WORLDOFSAILORS.COM' },
      { key: 'facebook', label: 'Facebook', default: '@SSLGOLDCUP' },
      { key: 'youtube', label: 'YouTube', default: '@STARSAILORS' },
      { key: 'instagram', label: 'Instagram', default: '@SSLGOLDCUP' },
      { key: 'tiktok', label: 'TikTok' },
      { key: 'x', label: 'X' },
      { key: 'hashtag', label: 'Hashtag', placeholder: '#SSLGOLDCUP' },
    ],
    defaults: [{ name: 'Follow us', data: {} }],
  },
  {
    kind: 'ticker', label: 'Tickers', sheet: 'Tickers',
    description: 'Scrolling bars. One message per line; the separator is put between them and after the last, so the text loops.',
    fields: [
      { key: 'position', label: 'Position', type: 'select', options: ['Top', 'Bottom'], default: 'Bottom' },
      { key: 'label', label: 'Label', placeholder: 'LIVE' },
      { key: 'separator', label: 'Separator', default: ' I ' },
      { key: 'items', label: 'Messages', type: 'list', wide: true, hint: 'One message per line' },
    ],
    defaults: [
      { name: 'Top ticker', data: { position: 'Top', items: 'SSL GOLD CUP 2026\nRIO DE JANEIRO, BRAZIL' } },
      { name: 'Bottom ticker', data: { position: 'Bottom', items: 'RACE 2 WILL START SOON' } },
    ],
  },
  {
    kind: 'officials', label: 'Race officials', sheet: 'Race officials',
    description: 'Principal race officer, regatta director and jury.',
    fields: [
      { key: 'heading', label: 'Heading', default: 'RACE OFFICIALS' },
      { key: 'pro_title', label: 'PRO title', default: 'PRINCIPAL RACE OFFICER' },
      { key: 'pro_name', label: 'PRO name' },
      { key: 'director_title', label: 'Director title', default: 'REGATTA DIRECTOR' },
      { key: 'director_name', label: 'Director name' },
      { key: 'jury_title', label: 'Jury title', default: 'JURY' },
      { key: 'jury_1', label: 'Jury 1' },
      { key: 'jury_2', label: 'Jury 2' },
      { key: 'jury_3', label: 'Jury 3' },
      { key: 'jury_4', label: 'Jury 4' },
      { key: 'jury_5', label: 'Jury 5' },
    ],
    defaults: [{ name: 'Race officials', data: {} }],
  },
  {
    kind: 'announcement', label: 'Announcements', sheet: 'Announcements',
    description: 'Short bars such as FALSE START or ANNOUNCEMENT.',
    fields: [
      { key: 'heading', label: 'Heading', default: 'ANNOUNCEMENT' },
      { key: 'text', label: 'Text', wide: true },
    ],
    defaults: [{ name: 'Announcement', data: {} }, { name: 'False start', data: { heading: 'FALSE START' } }],
  },
];

const kindOf = (kind: string) => {
  const k = GRAPHIC_KINDS.find((x) => x.kind === kind);
  if (!k) throw badRequest(`Unknown graphic: ${kind}`);
  return k;
};

export interface GraphicSet { id: string; kind: string; name: string; data: Record<string, string>; sort: number; updatedAt: string }

function clean(k: GraphicKind, data: Record<string, unknown>, base: Record<string, string>) {
  const out = { ...base };
  for (const f of k.fields) if (data[f.key] !== undefined) out[f.key] = String(data[f.key] ?? '').slice(0, f.type === 'list' ? 4000 : 500);
  return out;
}

const fromRow = (r: any): GraphicSet => {
  let data: Record<string, string> = {};
  try { data = JSON.parse(r.data); } catch { /* empty */ }
  return { id: r.id, kind: r.kind, name: r.name, data, sort: r.sort, updatedAt: r.updated_at };
};

/** Adds the default versions once per event (deleting them later is respected). */
export function seedGraphicSets(db: DB, eventId: string) {
  const flag = `graphicSets.seeded.${eventId}`;
  if (getSetting(db, flag)) return;
  for (const k of GRAPHIC_KINDS) {
    if (db.prepare('SELECT 1 FROM graphic_sets WHERE event_id = ? AND kind = ?').get(eventId, k.kind)) continue;
    for (const d of k.defaults) createGraphicSet(db, eventId, k.kind, d.name, d.data);
  }
  setSetting(db, flag, '1');
}

export function listGraphicSets(db: DB, eventId: string, kind?: string): GraphicSet[] {
  const rows = db.prepare(`SELECT * FROM graphic_sets WHERE event_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY kind, sort, created_at`).all(...(kind ? [eventId, kind] : [eventId]));
  return rows.map(fromRow);
}

export function createGraphicSet(db: DB, eventId: string, kind: string, name: string, data: Record<string, unknown> = {}, copyFrom?: string) {
  const k = kindOf(kind);
  let base = Object.fromEntries(k.fields.map((f) => [f.key, f.default ?? '']));
  if (copyFrom) {
    const src = db.prepare('SELECT * FROM graphic_sets WHERE id = ? AND kind = ?').get(copyFrom, kind);
    if (!src) throw notFound('Graphic version');
    base = { ...base, ...fromRow(src).data };
  }
  const id = newId(); const t = nowIso();
  const sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM graphic_sets WHERE event_id = ? AND kind = ?').get(eventId, kind) as { n: number }).n;
  db.prepare('INSERT INTO graphic_sets (id, event_id, kind, name, data, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, eventId, kind, name.trim().slice(0, 80) || k.label, JSON.stringify(clean(k, data, base)), sort, t, t);
  return id;
}

export function updateGraphicSet(db: DB, id: string, patch: { name?: string; data?: Record<string, unknown> }) {
  const r = db.prepare('SELECT * FROM graphic_sets WHERE id = ?').get(id);
  if (!r) throw notFound('Graphic version');
  const cur = fromRow(r);
  const k = kindOf(cur.kind);
  const name = patch.name !== undefined ? patch.name.trim().slice(0, 80) || cur.name : cur.name;
  const data = patch.data ? clean(k, patch.data, cur.data) : cur.data;
  db.prepare('UPDATE graphic_sets SET name = ?, data = ?, updated_at = ? WHERE id = ?').run(name, JSON.stringify(data), nowIso(), id);
  return fromRow(db.prepare('SELECT * FROM graphic_sets WHERE id = ?').get(id));
}

export function deleteGraphicSet(db: DB, id: string) {
  if (!db.prepare('DELETE FROM graphic_sets WHERE id = ?').run(id).changes) throw notFound('Graphic version');
}

/** Moves a version up or down among the versions of its graphic (row order in the sheet). */
export function moveGraphicSet(db: DB, id: string, dir: -1 | 1) {
  const r = db.prepare('SELECT * FROM graphic_sets WHERE id = ?').get(id) as any;
  if (!r) throw notFound('Graphic version');
  const list = db.prepare('SELECT id FROM graphic_sets WHERE event_id = ? AND kind = ? ORDER BY sort, created_at').all(r.event_id, r.kind) as { id: string }[];
  const i = list.findIndex((x) => x.id === id), j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  const upd = db.prepare('UPDATE graphic_sets SET sort = ? WHERE id = ?');
  db.transaction(() => list.forEach((x, n) => upd.run(n + 1, x.id)))();
}

/** Ticker text: messages joined with the separator, which also closes the text so a scrolling ticker loops cleanly. */
export function tickerText(data: Record<string, string>) {
  const items = (data.items ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!items.length) return '';
  const sep = data.separator || ' I ';
  return items.join(sep) + sep;
}

/** Sheet rows for one graphic: one per version, `set` first, then every field (tickers also get `text`). */
export function graphicSheetRows(db: DB, eventId: string, kind: string): Record<string, string>[] {
  const k = kindOf(kind);
  return listGraphicSets(db, eventId, kind).map((s) => {
    const row: Record<string, string> = { set: s.name };
    for (const f of k.fields) row[f.key] = f.type === 'list' ? (s.data[f.key] ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join(' | ') : s.data[f.key] ?? '';
    if (kind === 'ticker') row.text = tickerText(s.data);
    return row;
  });
}
