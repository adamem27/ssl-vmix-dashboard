import { groupLabel } from './groups.js';
import { groupTitle } from './groupNames.js';
import { DB, nowIso } from '../db/db.js';
import { AssetCtx } from './assets.js';
import { notFound } from './errors.js';
import { listTeams } from './teams.js';

/**
 * Overall results of each group (a fleet of a fleet set), as on the SSL26 board “SSL GOLD CUP RIO 2026 Group A”:
 * rank, team, a score per race (R1…Rn) and points. Points are the sum of the race scores unless typed by hand.
 * The row order is the standing; it can be sorted by points or moved by hand.
 */
export interface ResultRow { teamId: string; races: string[]; points: string }
export interface ResultData { title: string; subtitle: string; races: number; rows: ResultRow[]; vmixInput: string }
export const MAX_RACES = 12;

const num = (v: string) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
export const autoPoints = (races: string[]) => {
  const vals = races.filter((r) => r.trim() !== '');
  if (!vals.length) return '';
  const s = vals.reduce((a, r) => a + num(r), 0);
  return String(Math.round(s * 100) / 100);
};
export const pointsOf = (r: ResultRow) => (r.points.trim() !== '' ? r.points : autoPoints(r.races));

function fleetInfo(db: DB, fleetId: string) {
  const f = db.prepare('SELECT f.id, f.name, f.size, f.fleet_set_id AS setId, s.name AS setName FROM fleets f JOIN fleet_sets s ON s.id = f.fleet_set_id WHERE f.id = ?').get(fleetId) as any;
  if (!f) throw notFound('Group');
  const teamIds = (db.prepare('SELECT team_id FROM fleet_slots WHERE fleet_id = ? ORDER BY position').all(fleetId) as { team_id: string }[]).map((r) => r.team_id);
  return { ...f, teamIds } as { id: string; name: string; size: number; setId: string; setName: string; teamIds: string[] };
}

function load(db: DB, fleetId: string): { data: ResultData; updatedAt: string | null } {
  const f = fleetInfo(db, fleetId);
  const r = db.prepare('SELECT * FROM results WHERE fleet_id = ?').get(fleetId) as any;
  let raw: Partial<ResultData> = {};
  try { raw = r ? JSON.parse(r.data) : {}; } catch { /* reset */ }
  const races = Math.max(1, Math.min(MAX_RACES, Number(raw.races) || 6));
  // keep the stored order for teams still in the group, then add new teams in fleet order
  const stored = (raw.rows ?? []).filter((x) => f.teamIds.includes(x.teamId));
  const seen = new Set(stored.map((x) => x.teamId));
  const rows = [...stored, ...f.teamIds.filter((id) => !seen.has(id)).map((teamId) => ({ teamId, races: [], points: '' }))]
    .map((x) => ({ teamId: x.teamId, races: Array.from({ length: races }, (_, i) => String(x.races?.[i] ?? '')), points: String(x.points ?? '') }));
  return { data: { title: raw.title != null ? groupTitle(String(raw.title)) : groupLabel(f.name), subtitle: raw.subtitle ?? '', races, rows, vmixInput: String(raw.vmixInput ?? '') }, updatedAt: r?.updated_at ?? null };
}

export function getResults(db: DB, fleetId: string) {
  const f = fleetInfo(db, fleetId);
  const { data, updatedAt } = load(db, fleetId);
  return { fleetId, fleetName: f.name, setId: f.setId, setName: f.setName, ...data, rows: data.rows.map((r) => ({ ...r, autoPoints: autoPoints(r.races), total: pointsOf(r) })), updatedAt };
}

export function listResults(db: DB, setId: string) {
  const fleets = db.prepare('SELECT id FROM fleets WHERE fleet_set_id = ? ORDER BY sort, created_at').all(setId) as { id: string }[];
  return fleets.map((f) => getResults(db, f.id));
}

export function saveResults(db: DB, fleetId: string, patch: { title?: string; subtitle?: string; vmixInput?: string; races?: number; rows?: { teamId: string; races?: string[]; points?: string }[]; order?: string[] }) {
  const { data } = load(db, fleetId);
  if (patch.title !== undefined) data.title = patch.title.slice(0, 120);
  if (patch.subtitle !== undefined) data.subtitle = patch.subtitle.slice(0, 120);
  if (patch.vmixInput !== undefined) data.vmixInput = patch.vmixInput.trim().slice(0, 120);
  if (patch.races !== undefined) data.races = Math.max(1, Math.min(MAX_RACES, Math.round(patch.races)));
  for (const p of patch.rows ?? []) {
    const r = data.rows.find((x) => x.teamId === p.teamId);
    if (!r) continue;
    if (p.races) p.races.forEach((v, i) => { if (i < MAX_RACES) r.races[i] = String(v).slice(0, 12); });
    if (p.points !== undefined) r.points = String(p.points).slice(0, 12);
  }
  if (patch.order) {
    const pos = new Map(patch.order.map((id, i) => [id, i]));
    data.rows.sort((a, b) => (pos.get(a.teamId) ?? 99) - (pos.get(b.teamId) ?? 99));
  }
  data.rows = data.rows.map((r) => ({ ...r, races: Array.from({ length: data.races }, (_, i) => r.races[i] ?? '') }));
  db.prepare('INSERT INTO results (fleet_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (fleet_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(fleetId, JSON.stringify(data), nowIso());
  return getResults(db, fleetId);
}

/** Sorts the standing by points (highest first); ties keep their order. */
export function sortResults(db: DB, fleetId: string) {
  const { data } = load(db, fleetId);
  const order = data.rows.map((r, i) => ({ id: r.teamId, p: num(pointsOf(r)), has: pointsOf(r) !== '', i }))
    .sort((a, b) => Number(b.has) - Number(a.has) || b.p - a.p || a.i - b.i).map((x) => x.id);
  return saveResults(db, fleetId, { order });
}

export function clearResults(db: DB, fleetId: string) {
  const { vmixInput } = load(db, fleetId).data;
  db.prepare('DELETE FROM results WHERE fleet_id = ?').run(fleetId);
  // the vMix input belongs to the graphic, not to the scores: it survives a clear
  return vmixInput ? saveResults(db, fleetId, { vmixInput }) : getResults(db, fleetId);
}

type Asset = { vmixPath: string | null; storedPath: string | null; enteredPath: string | null } | undefined | null;
const img = (a: Asset) => (a ? a.vmixPath ?? a.storedPath ?? a.enteredPath ?? '' : '');

/**
 * Results sheet: one row per group so one title shows a whole table. Per team n (in standing order):
 * T{n}Rank, T{n}Code, T{n}Name, T{n}Ranking, T{n}Flag, T{n}R1…, T{n}Points.
 */
export function resultSheetRows(ctx: AssetCtx, eventId: string): Record<string, string>[] {
  const { db } = ctx;
  const teams = new Map(listTeams(ctx).map((t) => [t.id, t]));
  const sets = db.prepare('SELECT id FROM fleet_sets WHERE event_id = ? ORDER BY sort, created_at').all(eventId) as { id: string }[];
  const out: Record<string, string>[] = [];
  for (const s of sets) {
    for (const g of listResults(db, s.id)) {
      const row: Record<string, string> = { set: g.setName, group: groupLabel(g.fleetName), Title: g.title, Subtitle: g.subtitle, Races: String(g.races) };
      for (let i = 1; i <= g.races; i++) row[`R${i}Label`] = `R${i}`;
      g.rows.forEach((r, i) => {
        const t = teams.get(r.teamId);
        const p = `T${i + 1}`;
        row[`${p}Rank`] = String(i + 1);
        row[`${p}Code`] = t?.code ?? '';
        row[`${p}Name`] = t?.name ?? '';
        row[`${p}Ranking`] = t?.ranking ? `[${t.ranking}]` : '';
        row[`${p}Flag`] = img(t?.assets.flag_small);
        r.races.forEach((v, j) => { row[`${p}R${j + 1}`] = v; });
        row[`${p}Points`] = r.total;
      });
      out.push(row);
    }
  }
  return out;
}
