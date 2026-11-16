import { DB, nowIso } from '../db/db.js';
import { notFound } from './errors.js';
import { createFleet, createSet, FLEET_SIZE, setFleetSize, setPlaceholders } from './fleets.js';
import { getState, loadLayout, resolveTeams } from './matchboard/matchboard.js';
import { stageRound, starredBefore, starredTeams, Starred } from './matchboard/rounds.js';

/**
 * The Final Series stages the matchboard holds in its boxes R1 A … QF D: four groups (A–D) of four places each.
 * Their short names are those of the matchboard (as QS H in the Qualifying Series), so every graphic shows “Group A”.
 */
export const FINAL_SERIES_STAGES = [
  { prefix: 'R1', name: '1/32 Finals', textId: 'stage-1-32-finals', match: /^1\s*\/\s*32/ },
  { prefix: 'R2', name: '1/16 Finals', textId: 'stage-1-16-finals', match: /^1\s*\/\s*16/ },
  { prefix: 'EF', name: '1/8 Finals', textId: 'stage-1-8-finals', match: /^1\s*\/\s*8\b/ },
  { prefix: 'QF', name: 'Quarterfinals', textId: 'stage-quarterfinals', match: /^quarter/i },
] as const;
export const STAGE_LETTERS = ['A', 'B', 'C', 'D'] as const;

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export interface PrepareOptions {
  /** Teams the matchboard already shows in a box (picked, or through by a star) go into the empty places of its group. */
  fromMatchboard?: boolean;
  /** Empty the team places of groups A–D of these stages first (the teams stay in the database; placeholders stay). */
  clear?: boolean;
}
export interface PreparedStage { setId: string; name: string; created: boolean; groupsCreated: string[]; placed: number; cleared: number }

/**
 * Makes the 1/32 Finals, 1/16 Finals, 1/8 Finals and Quarterfinals ready to be filled: each stage with groups
 * R1 A–D (R2, EF, QF …) of four places. Idempotent and never destructive unless `clear` is asked: an existing stage
 * (found by its name or by its groups) and its groups are kept as they are, missing ones are added, an empty place
 * gets the matchboard row's text (DRAW 1, R1 C1 …) as its label. Other stages (the Qualifying Series) are not touched.
 */
export function prepareFinalSeries(db: DB, eventId: string, opts: PrepareOptions = {}): PreparedStage[] {
  const layout = loadLayout();
  const state = getState(db);
  const resolved = resolveTeams(layout, state);
  const boxOf = (short: string) => layout.groups.find((g) => norm(state.texts[g.labelId] ?? layout.texts.find((t) => t.id === g.labelId)?.text ?? '') === norm(short));
  const out: PreparedStage[] = [];

  db.transaction(() => {
    for (const def of FINAL_SERIES_STAGES) {
      const sets = db.prepare('SELECT id, name FROM fleet_sets WHERE event_id = ? ORDER BY sort, created_at').all(eventId) as { id: string; name: string }[];
      const fleetsOf = (setId: string) => db.prepare('SELECT id, name, size FROM fleets WHERE fleet_set_id = ? ORDER BY sort, created_at').all(setId) as { id: string; name: string; size: number }[];
      let set = sets.find((s) => def.match.test(s.name.trim()))
        ?? sets.find((s) => fleetsOf(s.id).some((f) => norm(f.name) === `${def.prefix}A`));
      let created = false;
      if (!set) {
        const date = (state.texts[`${def.textId}-date`] ?? '').trim();
        const name = `${def.name}${date ? ` (${date})` : ''}`;
        set = { id: createSet(db, eventId, name), name };
        created = true;
        placeAfterEarlierStages(db, eventId, set.id);
      }
      const r: PreparedStage = { setId: set.id, name: set.name, created, groupsCreated: [], placed: 0, cleared: 0 };
      for (const letter of STAGE_LETTERS) {
        const short = `${def.prefix} ${letter}`;
        let fleet = fleetsOf(set.id).find((f) => norm(f.name) === norm(short));
        if (!fleet) { fleet = { id: createFleet(db, set.id, short, FLEET_SIZE), name: short, size: FLEET_SIZE }; r.groupsCreated.push(short); }
        if (opts.clear) r.cleared += db.prepare('DELETE FROM fleet_slots WHERE fleet_id = ?').run(fleet.id).changes;
        // four places: a smaller group grows; a bigger one shrinks only when its extra places are empty
        if (fleet.size < FLEET_SIZE || (fleet.size > FLEET_SIZE && !db.prepare('SELECT 1 FROM fleet_slots WHERE fleet_id = ? AND position > ?').get(fleet.id, FLEET_SIZE))) {
          setFleetSize(db, fleet.id, FLEET_SIZE);
          fleet.size = FLEET_SIZE;
        }
        const row = db.prepare('SELECT placeholders FROM fleets WHERE id = ?').get(fleet.id) as { placeholders: string };
        const labels = (JSON.parse(row.placeholders || '[]') as string[]).slice(0, fleet.size);
        while (labels.length < fleet.size) labels.push('');
        const box = boxOf(short);
        box?.slots.slice(0, fleet.size).forEach((sid, i) => {
          const taken = db.prepare('SELECT 1 FROM fleet_slots WHERE fleet_id = ? AND position = ?').get(fleet!.id, i + 1);
          const team = resolved.get(sid)?.teamId;
          if (!taken && team && opts.fromMatchboard) {
            // a team has one place among the stage's groups: one already placed elsewhere in the stage stays there
            const inStage = db.prepare("SELECT 1 FROM fleet_slots x JOIN fleets f ON f.id = x.fleet_id WHERE x.fleet_set_id = ? AND x.team_id = ? AND f.name NOT LIKE '%chance%' AND f.name NOT LIKE '%qualification%'").get(set!.id, team);
            if (!inStage) {
              db.prepare('INSERT INTO fleet_slots (fleet_id, fleet_set_id, position, team_id) VALUES (?, ?, ?, ?)').run(fleet!.id, set!.id, i + 1, team);
              r.placed++;
              return;
            }
          }
          const text = (state.slots[sid]?.teamId ? '' : state.slots[sid]?.text ?? layout.slots.find((s) => s.id === sid)?.text ?? '').trim();
          if (!labels[i] && text) labels[i] = text;
        });
        setPlaceholders(db, fleet.id, labels);
      }
      db.prepare('UPDATE fleet_sets SET updated_at = ? WHERE id = ?').run(nowIso(), set.id);
      out.push(r);
    }
  })();
  return out;
}

/** A new stage goes right after the last stage of an earlier round (the Qualifying Series, the 1/32 Finals …). */
function placeAfterEarlierStages(db: DB, eventId: string, setId: string) {
  const sets = (db.prepare('SELECT id, name FROM fleet_sets WHERE event_id = ? ORDER BY sort, created_at').all(eventId) as { id: string; name: string }[])
    .map((s) => ({ ...s, round: stageRound(s.name, (db.prepare('SELECT name FROM fleets WHERE fleet_set_id = ?').all(s.id) as { name: string }[]).map((f) => f.name)) }));
  const i = sets.findIndex((s) => s.id === setId);
  const [me] = sets.splice(i, 1);
  let at = 0;
  sets.forEach((s, k) => { if (s.round !== null && me.round !== null && s.round < me.round) at = k + 1; });
  if (me.round === null) at = sets.length;
  sets.splice(at, 0, me);
  sets.forEach((s, k) => db.prepare('UPDATE fleet_sets SET sort = ? WHERE id = ?').run(k + 1, s.id));
}

/** The teams starred on the matchboard in stages before this one: the teams it takes, the latest round first. */
export function starredForSet(db: DB, setId: string): Starred[] {
  const set = db.prepare('SELECT name FROM fleet_sets WHERE id = ?').get(setId) as { name: string } | undefined;
  if (!set) throw notFound('Stage');
  const names = (db.prepare('SELECT name FROM fleets WHERE fleet_set_id = ? ORDER BY sort').all(setId) as { name: string }[]).map((f) => f.name);
  const teams = new Set((db.prepare('SELECT id FROM teams').all() as { id: string }[]).map((t) => t.id));
  return starredBefore(starredTeams(loadLayout(), getState(db)), stageRound(set.name, names)).filter((s) => teams.has(s.teamId));
}
