import { DB, newId, nowIso } from '../db/db.js';
import { badRequest, conflict, notFound } from './errors.js';

/** Default teams per fleet; each fleet can be set from MIN_FLEET_SIZE to MAX_FLEET_SIZE. */
export const FLEET_SIZE = 4;
export const MIN_FLEET_SIZE = 1;
export const MAX_FLEET_SIZE = 16;

interface FleetRow { id: string; fleet_set_id: string; name: string; sort: number; placeholders: string; size: number }
interface SlotRow { fleet_id: string; position: number; team_id: string }

export function listSets(db: DB, eventId: string) {
  return db.prepare(`
    SELECT s.id, s.name, s.sort, s.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM fleets f WHERE f.fleet_set_id = s.id) AS fleetCount,
      (SELECT COUNT(*) FROM fleet_slots x WHERE x.fleet_set_id = s.id) AS assignedCount
    FROM fleet_sets s WHERE s.event_id = ? ORDER BY s.sort, s.created_at`).all(eventId);
}

export function createSet(db: DB, eventId: string, name: string, fleetCount = 0, fleetSize = FLEET_SIZE) {
  const t = nowIso();
  const id = newId();
  db.transaction(() => {
    const sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM fleet_sets WHERE event_id = ?').get(eventId) as { n: number }).n;
    db.prepare('INSERT INTO fleet_sets (id, event_id, name, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, eventId, name, sort, t, t);
    for (let i = 1; i <= fleetCount; i++) createFleet(db, id, `Fleet ${i}`, fleetSize);
  })();
  return id;
}

export function renameSet(db: DB, setId: string, name: string) {
  const r = db.prepare('UPDATE fleet_sets SET name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), setId);
  if (!r.changes) throw notFound('Stage');
}

export function deleteSet(db: DB, setId: string) {
  const r = db.prepare('DELETE FROM fleet_sets WHERE id = ?').run(setId);
  if (!r.changes) throw notFound('Stage');
}

function touchSet(db: DB, setId: string) {
  db.prepare('UPDATE fleet_sets SET updated_at = ? WHERE id = ?').run(nowIso(), setId);
}

function assertSize(size: number) {
  if (!Number.isInteger(size) || size < MIN_FLEET_SIZE || size > MAX_FLEET_SIZE) throw badRequest(`Teams per group must be between ${MIN_FLEET_SIZE} and ${MAX_FLEET_SIZE}.`);
}

export function createFleet(db: DB, setId: string, name: string, size = FLEET_SIZE) {
  if (!db.prepare('SELECT 1 FROM fleet_sets WHERE id = ?').get(setId)) throw notFound('Stage');
  assertSize(size);
  const t = nowIso();
  const id = newId();
  const sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM fleets WHERE fleet_set_id = ?').get(setId) as { n: number }).n;
  db.prepare('INSERT INTO fleets (id, fleet_set_id, name, sort, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, setId, name, sort, size, t, t);
  touchSet(db, setId);
  return id;
}

export function setPlaceholders(db: DB, fleetId: string, labels: (string | null)[]) {
  db.prepare('UPDATE fleets SET placeholders = ? WHERE id = ?').run(JSON.stringify(labels.slice(0, MAX_FLEET_SIZE).map((l) => l ?? '')), fleetId);
}

/**
 * Change how many teams a fleet holds. Shrinking is refused while a team sits in a place that would
 * disappear, so nobody drops out of a fleet without the operator moving them.
 */
export function setFleetSize(db: DB, fleetId: string, size: number) {
  assertSize(size);
  const f = getFleet(db, fleetId);
  const over = db.prepare('SELECT position FROM fleet_slots WHERE fleet_id = ? AND position > ? ORDER BY position').all(fleetId, size) as { position: number }[];
  if (over.length) throw conflict(`Places ${over.map((o) => o.position).join(', ')} still have teams. Move them out first, then make the group smaller.`);
  db.prepare('UPDATE fleets SET size = ?, updated_at = ? WHERE id = ?').run(size, nowIso(), fleetId);
  touchSet(db, f.fleet_set_id);
}

/** Set every fleet of a set to the same size (same rule as setFleetSize, all or nothing). */
export function setSetFleetSize(db: DB, setId: string, size: number) {
  const ids = (db.prepare('SELECT id FROM fleets WHERE fleet_set_id = ?').all(setId) as { id: string }[]).map((r) => r.id);
  db.transaction(() => ids.forEach((id) => setFleetSize(db, id, size)))();
}

export function renameFleet(db: DB, fleetId: string, name: string) {
  const f = getFleet(db, fleetId);
  db.prepare('UPDATE fleets SET name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), fleetId);
  touchSet(db, f.fleet_set_id);
}

/** Deleting a fleet frees its teams; they stay in the team database. */
export function deleteFleet(db: DB, fleetId: string) {
  const f = getFleet(db, fleetId);
  db.prepare('DELETE FROM fleets WHERE id = ?').run(fleetId);
  touchSet(db, f.fleet_set_id);
}

export function moveFleet(db: DB, fleetId: string, direction: -1 | 1) {
  const f = getFleet(db, fleetId);
  const list = db.prepare('SELECT * FROM fleets WHERE fleet_set_id = ? ORDER BY sort, created_at').all(f.fleet_set_id) as FleetRow[];
  const i = list.findIndex((x) => x.id === fleetId);
  const j = i + direction;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  db.transaction(() => list.forEach((x, k) => db.prepare('UPDATE fleets SET sort = ? WHERE id = ?').run(k + 1, x.id)))();
}

function getFleet(db: DB, fleetId: string) {
  const f = db.prepare('SELECT * FROM fleets WHERE id = ?').get(fleetId) as FleetRow | undefined;
  if (!f) throw notFound('Group');
  return f;
}

export function getSetDetail(db: DB, setId: string) {
  const set = db.prepare('SELECT id, name, event_id AS eventId, updated_at AS updatedAt FROM fleet_sets WHERE id = ?').get(setId);
  if (!set) throw notFound('Stage');
  const fleets = db.prepare('SELECT * FROM fleets WHERE fleet_set_id = ? ORDER BY sort, created_at').all(setId) as FleetRow[];
  const slots = db.prepare('SELECT * FROM fleet_slots WHERE fleet_set_id = ?').all(setId) as SlotRow[];
  return {
    set,
    fleets: fleets.map((f) => {
      const size = f.size || FLEET_SIZE;
      const positions = Array.from({ length: size }, (_, i) => slots.find((s) => s.fleet_id === f.id && s.position === i + 1)?.team_id ?? null);
      const filled = positions.filter(Boolean).length;
      const ph = JSON.parse(f.placeholders || '[]') as string[];
      const placeholders = Array.from({ length: size }, (_, i) => ph[i] || null);
      return { id: f.id, name: f.name, size, positions, placeholders, filled, complete: filled === size };
    }),
    assignedTeamIds: slots.map((s) => s.team_id),
  };
}

export interface PlaceInput { teamId: string; fleetId: string; position: number; onOccupied?: 'reject' | 'swap' }

/**
 * Put a team into fleet/position within one fleet set.
 * Occupied target: 'reject' (default) answers 409 with the occupant and free positions;
 * 'swap' moves the occupant to the dragged team's previous place, or back to the unassigned list
 * when the team came from there. Nothing is replaced silently.
 */
export function placeTeam(db: DB, setId: string, input: PlaceInput) {
  const { teamId, fleetId, position } = input;
  const fleet = getFleet(db, fleetId);
  if (!Number.isInteger(position) || position < 1 || position > fleet.size) throw badRequest(`Group place must be between 1 and ${fleet.size}.`);
  if (fleet.fleet_set_id !== setId) throw badRequest('This group belongs to a different stage.');
  if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) throw notFound('Team');

  return db.transaction(() => {
    const current = db.prepare('SELECT * FROM fleet_slots WHERE fleet_set_id = ? AND team_id = ?').get(setId, teamId) as SlotRow | undefined;
    const occupant = db.prepare('SELECT * FROM fleet_slots WHERE fleet_id = ? AND position = ?').get(fleetId, position) as SlotRow | undefined;
    if (occupant?.team_id === teamId) return { changed: false, displaced: null as null | { teamId: string; to: 'previous' | 'unassigned' } };

    if (occupant) {
      if ((input.onOccupied ?? 'reject') !== 'swap') {
        const used = (db.prepare('SELECT position FROM fleet_slots WHERE fleet_id = ?').all(fleetId) as { position: number }[]).map((r) => r.position);
        const free = Array.from({ length: fleet.size }, (_, i) => i + 1).filter((p) => !used.includes(p) || (current?.fleet_id === fleetId && p === current.position));
        throw conflict('This place is taken. Choose a swap or a free place.', { occupantTeamId: occupant.team_id, freePositions: free });
      }
      db.prepare('DELETE FROM fleet_slots WHERE fleet_id = ? AND position = ?').run(fleetId, position);
    }
    if (current) db.prepare('DELETE FROM fleet_slots WHERE fleet_id = ? AND position = ?').run(current.fleet_id, current.position);
    db.prepare('INSERT INTO fleet_slots (fleet_id, fleet_set_id, position, team_id) VALUES (?, ?, ?, ?)').run(fleetId, setId, position, teamId);
    let displaced: null | { teamId: string; to: 'previous' | 'unassigned' } = null;
    if (occupant) {
      if (current) {
        db.prepare('INSERT INTO fleet_slots (fleet_id, fleet_set_id, position, team_id) VALUES (?, ?, ?, ?)').run(current.fleet_id, setId, current.position, occupant.team_id);
        displaced = { teamId: occupant.team_id, to: 'previous' };
      } else displaced = { teamId: occupant.team_id, to: 'unassigned' };
    }
    touchSet(db, setId);
    return { changed: true, displaced };
  })();
}

/** First free position of a fleet, or null when it is full. */
export function firstFreePosition(db: DB, fleetId: string): number | null {
  const size = getFleet(db, fleetId).size;
  const used = (db.prepare('SELECT position FROM fleet_slots WHERE fleet_id = ?').all(fleetId) as { position: number }[]).map((r) => r.position);
  for (let p = 1; p <= size; p++) if (!used.includes(p)) return p;
  return null;
}

export function unassignTeam(db: DB, setId: string, teamId: string) {
  db.prepare('DELETE FROM fleet_slots WHERE fleet_set_id = ? AND team_id = ?').run(setId, teamId);
  touchSet(db, setId);
}
