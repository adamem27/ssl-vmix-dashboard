import { DB, nowIso } from '../db/db.js';
import { AssetCtx, listAssets } from './assets.js';
import { assertDate } from './declarations.js';
import { notFound } from './errors.js';
import { overview } from './overview.js';
import { getTeam, listTeams } from './teams.js';

/**
 * Team line-up graphic (Team_line-up_9 .gtzip): nine places on the boat, each with name, surname, number,
 * position and photo. Field names are the ones in the GT title, including GT's truncated names
 * (TacticianSURNAM, Trimmer1POSITIO), so a Data Source on the Lineups sheet maps itself.
 * Extra places (added by duplicating in the GTZIP generator) are named Sailor10, Sailor11, …
 */
export interface LineupSlotDef { key: string; label: string; position: string; fields: { name: string; surname: string; number: string; position: string; photo: string; captain: string } }

const slot = (key: string, label: string, position: string, f: Partial<LineupSlotDef['fields']> = {}): LineupSlotDef => ({
  key, label, position,
  fields: { name: `${key}NAME`, surname: `${key}SURNAME`, number: `${key}NUMBER`, position: `${key}POSITION`, photo: `${key}PHOTO`, captain: `${key}CAPTAIN`, ...f },
});

/** In the default order, bow to helm; each team can reorder its places (LineupData.order). */
export const LINEUP_SLOTS: LineupSlotDef[] = [
  slot('Bow', 'Bow', 'BOW', { position: 'BowPosition' }),
  slot('Midbow', 'Midbow', 'MIDBOW', { position: 'MidbowPosition' }),
  slot('Pit', 'Pit', 'PIT'),
  slot('Grinder', 'Grinder', 'GRINDER'),
  slot('Trimmer', 'Trimmer 1', 'TRIMMER', { position: 'TrimmerPosition' }),
  slot('Trimmer1', 'Trimmer 2', 'TRIMMER', { position: 'Trimmer1POSITIO', photo: 'TrimmerPHOTO1' }),
  slot('Main', 'Main trimmer', 'MAIN TRIMMER'),
  slot('Tactician', 'Tactician', 'TACTICIAN', { surname: 'TacticianSURNAM', position: 'TacticianPOSITI' }),
  slot('Helm', 'Helm', 'HELM'),
  // a crew of ten, or a floater in place of one of the usual places: between Pit and Grinder on the boat
  slot('Floater', 'Floater', 'FLOATER'),
];
/** The places from the bow to the stern (Lineup LT, numbered line-up boards); extra places (Sailor10…) after them. */
export const BOW_TO_STERN = ['Bow', 'Midbow', 'Pit', 'Floater', 'Grinder', 'Trimmer', 'Trimmer1', 'Main', 'Helm', 'Tactician'];
/** The numbered line-up boards (Team_lineup_8/9: S1 = bow): the two trimmers side by side, the grinder behind them, as on the 9-place board. */
export const BOARD_BOW_TO_STERN = ['Bow', 'Midbow', 'Pit', 'Floater', 'Trimmer', 'Trimmer1', 'Grinder', 'Main', 'Helm', 'Tactician'];
export const MAX_EXTRA = 6;
const extraSlot = (n: number) => slot(`Sailor${n}`, `Sailor ${n}`, '');

export interface LineupRow { slot: string; sailorId: string | null; firstName: string; lastName: string; number: string; position: string; captain: boolean }
/** photoSide: which way the team's photo boxes face in the line-up (lineup_photo_left / _right from the PNG generator) */
export interface LineupData { title: string; teamName: string; photoSide?: 'left' | 'right'; extra: number; rows: LineupRow[]; order?: string[] }

export const slotDefs = (extra: number) => [...LINEUP_SLOTS, ...Array.from({ length: Math.max(0, Math.min(MAX_EXTRA, extra)) }, (_, i) => extraSlot(10 + i))];

const emptyRow = (d: LineupSlotDef): LineupRow => ({ slot: d.key, sailorId: null, firstName: '', lastName: '', number: '', position: d.position, captain: false });

function normalize(raw: Partial<LineupData>): LineupData {
  const extra = Math.max(0, Math.min(MAX_EXTRA, Number(raw.extra) || 0));
  const byKey = new Map((raw.rows ?? []).map((r) => [r.slot, r]));
  const defs = slotDefs(extra);
  // the team's own order of places first, then any place it does not name, in the default order
  const order = (raw.order ?? []).filter((k, i, a) => defs.some((d) => d.key === k) && a.indexOf(k) === i);
  const ordered = [...order.map((k) => defs.find((d) => d.key === k)!), ...defs.filter((d) => !order.includes(d.key))];
  return {
    title: raw.title ?? 'Lineup', teamName: raw.teamName ?? '', photoSide: raw.photoSide === 'right' ? 'right' : 'left', extra,
    rows: ordered.map((d) => {
      const r = byKey.get(d.key);
      return r ? { ...emptyRow(d), ...r, slot: d.key, captain: !!r.captain } : emptyRow(d);
    }),
    ...(raw.order?.length ? { order: raw.order.filter((k) => slotDefs(MAX_EXTRA).some((d) => d.key === k)) } : {}),
  };
}

export function loadLineup(db: DB, eventId: string, teamId: string) {
  const r = db.prepare('SELECT * FROM lineups WHERE event_id = ? AND team_id = ?').get(eventId, teamId) as any;
  let data: Partial<LineupData> = {};
  try { data = r ? JSON.parse(r.data) : {}; } catch { /* reset */ }
  return { data: normalize(data), syncedAt: (r?.synced_at as string | null) ?? null, syncedDate: (r?.synced_date as string | null) ?? null, updatedAt: (r?.updated_at as string | null) ?? null, exists: !!r };
}

function store(db: DB, eventId: string, teamId: string, data: LineupData, synced?: string) {
  const t = nowIso();
  db.prepare(`INSERT INTO lineups (event_id, team_id, data, synced_at, synced_date, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (event_id, team_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at,
      synced_at = COALESCE(excluded.synced_at, lineups.synced_at), synced_date = COALESCE(excluded.synced_date, lineups.synced_date)`)
    .run(eventId, teamId, JSON.stringify(data), synced ? t : null, synced ?? null, t);
}

export function getLineup(ctx: AssetCtx, eventId: string, teamId: string) {
  getTeam(ctx, teamId);
  const l = loadLineup(ctx.db, eventId, teamId);
  return { teamId, ...l, slots: slotDefs(l.data.extra).map((d) => ({ key: d.key, label: d.label, position: d.position })) };
}

export function saveLineup(ctx: AssetCtx, eventId: string, teamId: string, patch: { title?: string; teamName?: string; photoSide?: 'left' | 'right'; extra?: number; rows?: Partial<LineupRow>[]; order?: string[] }) {
  getTeam(ctx, teamId);
  const cur = loadLineup(ctx.db, eventId, teamId).data;
  const next: Partial<LineupData> = { ...cur, ...(patch.title !== undefined && { title: patch.title }), ...(patch.teamName !== undefined && { teamName: patch.teamName }), ...(patch.photoSide !== undefined && { photoSide: patch.photoSide }), ...(patch.extra !== undefined && { extra: patch.extra }), ...(patch.order !== undefined && { order: patch.order }) };
  const rows = new Map(cur.rows.map((r) => [r.slot, r]));
  for (const p of patch.rows ?? []) {
    if (!p.slot) continue;
    const r = rows.get(p.slot) ?? emptyRow(slotDefs(MAX_EXTRA).find((d) => d.key === p.slot) ?? extraSlot(10));
    rows.set(p.slot, { ...r, ...p, slot: p.slot } as LineupRow);
  }
  // only one captain per boat
  const newCaptain = (patch.rows ?? []).find((p) => p.captain)?.slot;
  if (newCaptain) for (const r of rows.values()) if (r.slot !== newCaptain) r.captain = false;
  next.rows = [...rows.values()];
  store(ctx.db, eventId, teamId, normalize(next));
  return getLineup(ctx, eventId, teamId);
}

export function clearLineup(ctx: AssetCtx, eventId: string, teamId: string) {
  ctx.db.prepare('DELETE FROM lineups WHERE event_id = ? AND team_id = ?').run(eventId, teamId);
  return getLineup(ctx, eventId, teamId);
}

/** Which boat place a declared position goes to (a floater to Floater); null for spare and anything unknown. */
export function slotForPosition(position: string): string | null {
  const p = position.toLowerCase().replace(/[^a-z]/g, '');
  if (!p) return null;
  if (p.startsWith('helm')) return 'Helm';
  if (p.startsWith('tactic')) return 'Tactician';
  if (p.startsWith('main')) return 'Main';
  if (p.includes('trim')) return 'Trimmer';
  if (p.startsWith('grind')) return 'Grinder';
  if (p === 'pit' || p.startsWith('pitman')) return 'Pit';
  if (p.startsWith('mid')) return 'Midbow';
  if (p.startsWith('bow')) return 'Bow';
  if (p.startsWith('float')) return 'Floater';
  return null;
}

/**
 * Command: fills the line-up from the team's declaration for a day. Declared positions pick the place
 * (a second trimmer goes to Trimmer 2; a second grinder to Main beside the grinder, the main trimmer then to Tactician; a floater the first usual place left empty, else Floater), everyone else fills
 * the free places in order, then extra places.
 * Title, team name and extra places the operator added are kept; the sailors are replaced.
 */
export function syncLineupFromDeclaration(ctx: AssetCtx, eventId: string, teamId: string, date: string) {
  assertDate(date);
  const ov = overview(ctx, eventId, date, null);
  const t = ov.teams.find((x) => x.id === teamId);
  if (!t) throw notFound('Team');
  if (!t.declaration) return { synced: false as const, reason: 'No declaration for this day' };
  const cur = loadLineup(ctx.db, eventId, teamId).data;
  const crew = [
    ...t.sailors.filter((s) => s.declared).sort((a, b) => a.declared!.sort - b.declared!.sort)
      .map((s) => ({ sailorId: s.id, firstName: s.firstName, lastName: s.lastName, number: s.declared!.number || s.defaultNumber, position: s.declared!.position || s.defaultPosition, captain: s.isCaptain })),
    ...t.declaration.unmatched.map((u) => {
      const parts = u.name.trim().split(/\s+/);
      return { sailorId: null, firstName: parts.slice(0, -1).join(' '), lastName: parts.slice(-1)[0] ?? '', number: u.number, position: u.position, captain: false };
    }),
  ];
  const placed = new Map<string, LineupRow>();
  const rest: typeof crew = [];
  const floaters: typeof crew = [];
  for (const c of crew) {
    let key = slotForPosition(c.position);
    if (key === 'Floater') { floaters.push(c); continue; }
    if (key === 'Trimmer' && placed.has('Trimmer')) key = 'Trimmer1';
    if (key && !placed.has(key)) placed.set(key, { slot: key, ...c, position: LINEUP_SLOTS.find((d) => d.key === key)!.position });
    else rest.push(c);
  }
  // a second grinder sits beside the grinder (the Main place, the pair under it on the boards); the main trimmer then
  // moves aft to the Tactician place, when nobody was declared there
  const g2 = rest.findIndex((c) => slotForPosition(c.position) === 'Grinder');
  if (g2 >= 0 && placed.has('Grinder') && !(placed.has('Main') && placed.has('Tactician'))) {
    const [c] = rest.splice(g2, 1);
    const main = placed.get('Main');
    if (main) placed.set('Tactician', { ...main, slot: 'Tactician' });
    placed.set('Main', { slot: 'Main', ...c, position: 'GRINDER' });
  }
  // a floater takes a usual place nobody was declared on (bow, midbow, pit, grinder, trimmers, main, helm, tactician),
  // the first in the team's order of places, with the floater's own data; with every usual place taken, the Floater place
  const emptyUsual = cur.rows.map((r) => r.slot).filter((k) => k !== 'Floater' && LINEUP_SLOTS.some((d) => d.key === k) && !placed.has(k));
  for (const c of floaters) {
    const key = emptyUsual.shift() ?? (placed.has('Floater') ? null : 'Floater');
    if (key) placed.set(key, { slot: key, ...c, position: 'FLOATER' });
    else rest.push(c);
  }
  // free places in the team's own order of places
  const free = cur.rows.map((r) => LINEUP_SLOTS.find((d) => d.key === r.slot)).filter((d): d is LineupSlotDef => !!d && !placed.has(d.key));
  let extra = 0;
  for (const c of rest) {
    const d = free.shift() ?? (extra < MAX_EXTRA ? extraSlot(10 + extra++) : null);
    if (!d) break;
    placed.set(d.key, { slot: d.key, ...c, position: c.position || d.position });
  }
  const data = normalize({ title: cur.title, teamName: cur.teamName, photoSide: cur.photoSide, extra: Math.max(extra, 0), rows: [...placed.values()], order: cur.order });
  store(ctx.db, eventId, teamId, data, date);
  return { synced: true as const, sailors: crew.length };
}

/** Sync for every team with a declaration that day (only the given teams when a list is passed, e.g. the current stage). */
export function syncAllLineups(ctx: AssetCtx, eventId: string, date: string, only: string[] | null = null) {
  const ov = overview(ctx, eventId, date, null);
  const keep = only ? new Set(only) : null;
  let teams = 0;
  for (const t of ov.teams) if ((!keep || keep.has(t.id)) && t.declaration && syncLineupFromDeclaration(ctx, eventId, t.id, date).synced) teams++;
  return { teams };
}

export function lineupStatus(db: DB, eventId: string) {
  return db.prepare('SELECT team_id AS teamId, synced_at AS syncedAt, synced_date AS syncedDate, updated_at AS updatedAt FROM lineups WHERE event_id = ?').all(eventId) as { teamId: string; syncedAt: string | null; syncedDate: string | null; updatedAt: string }[];
}

type Asset = { vmixPath: string | null; storedPath: string | null; enteredPath: string | null } | undefined | null;
const img = (a: Asset) => (a ? a.vmixPath ?? a.storedPath ?? a.enteredPath ?? '' : '');

/** Lineups sheet: one row per team that has a line-up, columns named like the GT title's fields. */
export function lineupSheetRows(ctx: AssetCtx, eventId: string): Record<string, string>[] {
  const saved = new Set(lineupStatus(ctx.db, eventId).map((r) => r.teamId));
  const out: Record<string, string>[] = [];
  for (const t of listTeams(ctx)) {
    if (!saved.has(t.id)) continue;
    const { data } = loadLineup(ctx.db, eventId, t.id);
    const row: Record<string, string> = {
      code: t.code, TeamName: data.teamName || t.name, LineupText: data.title,
      Flag: img(t.assets.flag_big), Emblem: img(t.assets.emblem_light), CaptainSlot: data.rows.find((r) => r.captain)?.slot ?? '',
    };
    for (const d of slotDefs(data.extra)) {
      const r = data.rows.find((x) => x.slot === d.key)!;
      const photo = r.sailorId ? img(listAssets(ctx, 'sailor', r.sailorId).photo) : '';
      row[d.fields.name] = r.firstName;
      row[d.fields.surname] = r.lastName;
      row[d.fields.number] = r.number;
      row[d.fields.position] = r.position;
      row[d.fields.photo] = photo;
      row[d.fields.captain] = r.captain ? '1' : '';
    }
    out.push(row);
  }
  return out;
}
