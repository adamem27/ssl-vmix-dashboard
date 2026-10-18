import { DB } from '../db/db.js';
import { AssetCtx } from './assets.js';
import { notFound } from './errors.js';
import { overview } from './overview.js';
import { SAILOR_SLOTS, TEAM_SLOTS } from './slots.js';
import { listTeams } from './teams.js';

/**
 * Flat JSON for vMix Data Sources: one object per row, every value a string.
 * Image fields hold the path vMix should load (the vMix mapping when set, otherwise the local file path).
 */
type Asset = { vmixPath: string | null; storedPath: string | null; enteredPath: string | null } | undefined | null;
const img = (a: Asset) => (a ? a.vmixPath ?? a.storedPath ?? a.enteredPath ?? '' : '');

function teamFields(t: ReturnType<typeof listTeams>[number]) {
  const o: Record<string, string> = { code: t.code, name: t.name };
  for (const s of TEAM_SLOTS) o[s.key] = img(t.assets[s.key]);
  return o;
}

export function jsonTeams(ctx: AssetCtx) {
  return listTeams(ctx).map(teamFields);
}

export function jsonSailors(ctx: AssetCtx, eventId: string, date: string, teamCode?: string) {
  const ov = overview(ctx, eventId, date, null);
  const rows: Record<string, string>[] = [];
  for (const t of ov.teams) {
    if (teamCode && t.code.toLowerCase() !== teamCode.toLowerCase()) continue;
    const sailors = t.declaration ? t.sailors.filter((s) => s.declared).sort((a, b) => a.declared!.sort - b.declared!.sort) : t.sailors;
    for (const s of sailors) {
      rows.push({
        team_code: t.code, team_name: t.name,
        first_name: s.firstName, last_name: s.lastName, full_name: `${s.firstName} ${s.lastName}`.trim(),
        number: s.declared?.number || s.defaultNumber, position: s.declared?.position || s.defaultPosition,
        best_result_1: s.bestResult1, best_result_2: s.bestResult2,
        [SAILOR_SLOTS[0].key]: img(s.photo),
      });
    }
  }
  return rows;
}

export function jsonFleetSet(ctx: AssetCtx, setId: string) {
  const { db } = ctx;
  if (!db.prepare('SELECT 1 FROM fleet_sets WHERE id = ?').get(setId)) throw notFound('Fleet set');
  const teams = new Map(listTeams(ctx).map((t) => [t.id, t]));
  const fleets = db.prepare('SELECT id, name, placeholders FROM fleets WHERE fleet_set_id = ? ORDER BY sort, created_at').all(setId) as any[];
  const slots = db.prepare('SELECT fleet_id, position, team_id FROM fleet_slots WHERE fleet_set_id = ?').all(setId) as any[];
  const rows: Record<string, string>[] = [];
  for (const f of fleets) {
    const ph = JSON.parse(f.placeholders || '[]') as string[];
    for (let p = 1; p <= 4; p++) {
      const t = teams.get(slots.find((s) => s.fleet_id === f.id && s.position === p)?.team_id);
      const empty: Record<string, string> = Object.fromEntries(TEAM_SLOTS.map((s) => [s.key, '']));
      rows.push({ fleet: f.name, place: String(p), ...(t ? teamFields(t) : { code: ph[p - 1] || '', name: ph[p - 1] || '', ...empty }) });
    }
  }
  return rows;
}

export function jsonIndex(db: DB, eventId: string) {
  const sets = db.prepare('SELECT id, name FROM fleet_sets WHERE event_id = ? ORDER BY sort, created_at').all(eventId) as { id: string; name: string }[];
  return [
    { name: 'Teams', path: '/json/teams' },
    { name: 'Sailors (today’s crews)', path: '/json/sailors' },
    ...sets.map((s) => ({ name: `Fleets · ${s.name}`, path: `/json/fleets/${s.id}` })),
  ];
}
