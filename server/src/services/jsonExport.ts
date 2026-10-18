import { DB } from '../db/db.js';
import { AssetCtx, listAssets } from './assets.js';
import { getWeather, listPeople, listSchedule } from './general.js';
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

function captainFields(ctx: AssetCtx, teamId: string) {
  const c = ctx.db.prepare('SELECT * FROM sailors WHERE team_id = ? AND is_captain = 1').get(teamId) as any;
  return {
    captain_name: c ? `${c.first_name} ${c.last_name}`.trim() : '',
    captain_first_name: c?.first_name ?? '', captain_last_name: c?.last_name ?? '',
    captain_number: c?.default_number ?? '', captain_position: c?.default_position ?? '',
    captain_best_result_1: c?.best_result_1 ?? '', captain_best_result_2: c?.best_result_2 ?? '',
    captain_photo: c ? img(listAssets(ctx, 'sailor', c.id).photo) : '',
  };
}

export function jsonTeams(ctx: AssetCtx) {
  return listTeams(ctx).map((t) => ({ ...teamFields(t), ...captainFields(ctx, t.id) }));
}

/** One row per team with its captain, for comparison graphics. */
export function jsonCaptains(ctx: AssetCtx) {
  return listTeams(ctx).map((t) => ({ code: t.code, name: t.name, flag_small: img(t.assets.flag_small), flag_big: img(t.assets.flag_big), ...captainFields(ctx, t.id) }));
}

export function jsonWeather(db: DB) {
  return [getWeather(db)];
}

export function jsonSchedule(db: DB, eventId: string, date: string) {
  return listSchedule(db, eventId, date).map(({ id: _id, ...r }) => r);
}

export function jsonPeople(ctx: AssetCtx, eventId: string, role?: string, language?: string) {
  return listPeople(ctx, eventId)
    .filter((p) => (!role || p.role.toLowerCase() === role.toLowerCase()) && (!language || p.language.toLowerCase() === language.toLowerCase()))
    .map((p) => ({ name: p.name, role: p.role, language: p.language, title: p.title, photo: img(p.photo) }));
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
        captain: s.isCaptain ? '1' : '',
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
    { name: 'Captains', path: '/json/captains' },
    { name: 'Weather', path: '/json/weather' },
    { name: 'Schedule (today)', path: '/json/schedule' },
    { name: 'People (lowerthirds)', path: '/json/people' },
    ...sets.map((s) => ({ name: `Fleets · ${s.name}`, path: `/json/fleets/${s.id}` })),
  ];
}
