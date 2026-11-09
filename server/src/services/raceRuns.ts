import { DB, nowIso } from '../db/db.js';
import { AssetCtx } from './assets.js';
import { badRequest, notFound } from './errors.js';
import { getResults, MAX_RACES, saveResults } from './results.js';
import { listTeams } from './teams.js';

/**
 * One race of a group, as on the SSL26 board “GROUP A Race 2”: each team's times at the marks
 * (START, MARK 1, GATE 2, MARK 3, FINISH), in finish order, with the gap to the winner and the race points.
 * Rows sort themselves by the last mark (finish); a team without a finish time goes below the others.
 * Points are boats − place + 1 unless typed; they are copied into the group's overall results as R{race}.
 */
export const DEFAULT_MARKS = ['START', 'MARK 1', 'GATE 2', 'MARK 3', 'FINISH'];
export const MAX_MARKS = 8;
export interface RunRow { teamId: string; times: string[]; points: string }
export interface RunData { marks: string[]; rows: RunRow[] }

/** "1:15:53", "15:33", "00:01" or "75:53" → seconds; anything else (DNF, empty) → null. */
export function toSeconds(v: string): number | null {
  const m = String(v).trim().match(/^(\d+)(?::(\d{1,2}))?(?::(\d{1,2}))?$/);
  if (!m || m[2] === undefined) return null;
  const parts = [m[1], m[2], m[3]].filter((x) => x !== undefined).map(Number);
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}
/** Seconds → "+0:53", "+10:00", "+1:02:03". */
export function gapText(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
  return h ? `+${h}:${String(m).padStart(2, '0')}:${x}` : `+${m}:${x}`;
}

function teamIdsOf(db: DB, fleetId: string) {
  if (!db.prepare('SELECT 1 FROM fleets WHERE id = ?').get(fleetId)) throw notFound('Group');
  return (db.prepare('SELECT team_id FROM fleet_slots WHERE fleet_id = ? ORDER BY position').all(fleetId) as { team_id: string }[]).map((r) => r.team_id);
}

function load(db: DB, fleetId: string, race: number): { data: RunData; updatedAt: string | null } {
  if (!Number.isInteger(race) || race < 1 || race > MAX_RACES) throw badRequest(`Race must be 1–${MAX_RACES}.`);
  const ids = teamIdsOf(db, fleetId);
  const r = db.prepare('SELECT * FROM race_runs WHERE fleet_id = ? AND race = ?').get(fleetId, race) as any;
  let raw: Partial<RunData> = {};
  try { raw = r ? JSON.parse(r.data) : {}; } catch { /* reset */ }
  const marks = (raw.marks?.length ? raw.marks : DEFAULT_MARKS).slice(0, MAX_MARKS).map(String);
  const stored = (raw.rows ?? []).filter((x) => ids.includes(x.teamId));
  const seen = new Set(stored.map((x) => x.teamId));
  const rows = [...stored, ...ids.filter((id) => !seen.has(id)).map((teamId) => ({ teamId, times: [], points: '' }))]
    .map((x) => ({ teamId: x.teamId, times: marks.map((_, i) => String(x.times?.[i] ?? '')), points: String(x.points ?? '') }));
  return { data: { marks, rows }, updatedAt: r?.updated_at ?? null };
}

/** Finish order: by the last mark's time, then teams without one in their present order. */
function sortRows(rows: RunRow[]) {
  const fin = (r: RunRow) => toSeconds(r.times[r.times.length - 1] ?? '');
  return rows.map((r, i) => ({ r, i, f: fin(r) }))
    .sort((a, b) => (a.f === null ? 1 : 0) - (b.f === null ? 1 : 0) || (a.f ?? 0) - (b.f ?? 0) || a.i - b.i).map((x) => x.r);
}

export function getRaceRun(db: DB, fleetId: string, race: number) {
  const { data, updatedAt } = load(db, fleetId, race);
  const n = data.rows.length;
  const finishes = data.rows.map((r) => toSeconds(r.times[r.times.length - 1] ?? ''));
  const lead = finishes.find((f) => f !== null) ?? null;
  const rows = data.rows.map((r, i) => {
    const f = finishes[i];
    const autoPoints = f !== null ? String(n - i) : '';
    return { ...r, finish: r.times[r.times.length - 1] ?? '', gap: f !== null && lead !== null && i > 0 ? gapText(f - lead) : '', autoPoints, total: r.points.trim() || autoPoints };
  });
  const g = getResults(db, fleetId);
  return { fleetId, race, races: g.races, title: g.title, subtitle: g.subtitle, marks: data.marks, rows, updatedAt };
}

export function saveRaceRun(db: DB, fleetId: string, race: number, patch: { marks?: string[]; rows?: { teamId: string; times?: string[]; points?: string }[] }) {
  const { data } = load(db, fleetId, race);
  if (patch.marks) {
    const marks = patch.marks.map((m) => m.trim().toUpperCase().slice(0, 16)).filter(Boolean).slice(0, MAX_MARKS);
    if (marks.length < 1) throw badRequest('Keep at least the finish.');
    // a mark keeps its times when it keeps its name; the finish stays the last column
    data.rows = data.rows.map((r) => ({ ...r, times: marks.map((m) => { const k = data.marks.indexOf(m); return k >= 0 ? r.times[k] : ''; }) }));
    data.marks = marks;
  }
  for (const p of patch.rows ?? []) {
    const r = data.rows.find((x) => x.teamId === p.teamId);
    if (!r) continue;
    if (p.times) p.times.forEach((v, i) => { if (i < data.marks.length) r.times[i] = String(v).trim().slice(0, 12); });
    if (p.points !== undefined) r.points = String(p.points).trim().slice(0, 12);
  }
  data.rows = sortRows(data.rows);
  db.prepare('INSERT INTO race_runs (fleet_id, race, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (fleet_id, race) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(fleetId, race, JSON.stringify(data), nowIso());
  const run = getRaceRun(db, fleetId, race);
  // the race points go into the overall results as R{race}
  const overall = getResults(db, fleetId);
  saveResults(db, fleetId, {
    races: Math.max(overall.races, race),
    rows: run.rows.map((r) => { const races = [...overall.rows.find((x) => x.teamId === r.teamId)?.races ?? []]; races[race - 1] = r.total; return { teamId: r.teamId, races }; }),
  });
  return getRaceRun(db, fleetId, race);
}

export function clearRaceRun(db: DB, fleetId: string, race: number) {
  const { marks } = load(db, fleetId, race).data;
  db.prepare('DELETE FROM race_runs WHERE fleet_id = ? AND race = ?').run(fleetId, race);
  return saveRaceRun(db, fleetId, race, { marks });
}

type Asset = { vmixPath: string | null; storedPath: string | null; enteredPath: string | null } | undefined | null;
const img = (a: Asset) => (a ? a.vmixPath ?? a.storedPath ?? a.enteredPath ?? '' : '');

/**
 * Fields of the race results title: TITLE (group), RACE ("Race 2"), SUBTITLE; H1… mark names;
 * per row n: POS n, FLAG n, TEAM n, RANKING n ("[24]"), M1 n… times at the marks,
 * TIME n (finish), GAP n (+0:53), POINTS n. Rows past the group are emptied.
 */
export function raceRunFields(ctx: AssetCtx, fleetId: string, race: number, rowsInTitle = 6): Map<string, string> {
  const run = getRaceRun(ctx.db, fleetId, race);
  const teams = new Map(listTeams(ctx).map((t) => [t.id, t]));
  const f = new Map<string, string>();
  f.set('TITLE.Text', run.title.toUpperCase());
  f.set('RACE.Text', `Race ${race}`);
  f.set('SUBTITLE.Text', run.subtitle);
  for (let j = 1; j <= MAX_MARKS; j++) f.set(`H${j}.Text`, run.marks[j - 1] ?? '');
  for (let n = 1; n <= Math.max(rowsInTitle, run.rows.length); n++) {
    const r = run.rows[n - 1];
    const t = r ? teams.get(r.teamId) : undefined;
    f.set(`POS ${n}.Text`, r ? String(n) : '');
    f.set(`TEAM ${n}.Text`, (t?.name ?? '').toUpperCase());
    f.set(`RANKING ${n}.Text`, t?.ranking ? `[${t.ranking}]` : '');
    f.set(`FLAG ${n}.Source`, img(t?.assets.flag_small));
    for (let j = 1; j <= MAX_MARKS; j++) f.set(`M${j} ${n}.Text`, r?.times[j - 1] ?? '');
    f.set(`TIME ${n}.Text`, r?.finish ?? '');
    f.set(`GAP ${n}.Text`, r ? (n === 1 ? r.finish : r.gap) : '');
    f.set(`POINTS ${n}.Text`, r?.total ?? '');
  }
  return f;
}
