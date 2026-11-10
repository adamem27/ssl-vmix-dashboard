import { DB, getSetting } from '../db/db.js';
import { todayIn } from './dates.js';

import { groupLabel, groupLetter } from './groupNames.js';

export { groupLabel, groupLetter };

export interface CurrentGroup { id: string; name: string; label: string; letter: string; setId: string }

/** The group racing now (picked at the top of the dashboard and on Show control). */
export function currentGroup(db: DB): CurrentGroup | null {
  let fleetId = '';
  try { fleetId = String(JSON.parse(getSetting(db, 'show.config') || '{}').fleetId ?? ''); } catch { /* none */ }
  if (!fleetId) return null;
  const f = db.prepare('SELECT id, name, fleet_set_id AS setId FROM fleets WHERE id = ?').get(fleetId) as { id: string; name: string; setId: string } | undefined;
  return f ? { ...f, label: groupLabel(f.name), letter: groupLetter(f.name) } : null;
}

/** Groups of a stage, in matchboard order, with their broadcast names. */
export function stageGroups(db: DB, setId: string) {
  return (db.prepare('SELECT id, name FROM fleets WHERE fleet_set_id = ? ORDER BY sort, created_at').all(setId) as { id: string; name: string }[])
    .map((f) => ({ ...f, label: groupLabel(f.name), letter: groupLetter(f.name) }));
}

const raceNo = (s: string) => /(\d+)/.exec(s)?.[1] ?? '';
const sameGroup = (a: string, g: CurrentGroup) => { const l = groupLabel(a); return l === g.label || a.trim().toUpperCase() === g.name.toUpperCase(); };

/**
 * The next race of the group racing now, from today's schedule: the first one still to start (or the last one when
 * all have started). Empty when the schedule does not say.
 */
export function nextRace(db: DB, eventId: string, timezone: string, now = new Date()): string {
  const g = currentGroup(db);
  if (!g) return '';
  const day = todayIn(timezone);
  const rows = db.prepare('SELECT time, race, fleet FROM schedule_items WHERE event_id = ? AND date = ? ORDER BY time, created_at').all(eventId, day) as { time: string; race: string; fleet: string }[];
  const mine = rows.filter((r) => sameGroup(r.fleet, g));
  if (!mine.length) return '';
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const next = mine.find((r) => r.time && r.time >= hm) ?? mine[mine.length - 1];
  return raceNo(next.race);
}

/** The automatic parts of the fixed tickers: the letter of the group racing now and its next race. */
export function tickerAuto(db: DB, event: { id: string; timezone: string }) {
  return { group: currentGroup(db)?.letter ?? '', race: nextRace(db, event.id, event.timezone) };
}
