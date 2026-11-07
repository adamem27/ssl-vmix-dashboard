import { newId, nowIso } from '../db/db.js';
import { badRequest, conflict, notFound } from './errors.js';
export const FLEET_SIZE = 4;
export function listSets(db, eventId) {
    return db.prepare(`
    SELECT s.id, s.name, s.sort, s.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM fleets f WHERE f.fleet_set_id = s.id) AS fleetCount,
      (SELECT COUNT(*) FROM fleet_slots x WHERE x.fleet_set_id = s.id) AS assignedCount
    FROM fleet_sets s WHERE s.event_id = ? ORDER BY s.sort, s.created_at`).all(eventId);
}
export function createSet(db, eventId, name, fleetCount = 0) {
    const t = nowIso();
    const id = newId();
    db.transaction(() => {
        const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM fleet_sets WHERE event_id = ?').get(eventId).n;
        db.prepare('INSERT INTO fleet_sets (id, event_id, name, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, eventId, name, sort, t, t);
        for (let i = 1; i <= fleetCount; i++)
            createFleet(db, id, `Fleet ${i}`);
    })();
    return id;
}
export function renameSet(db, setId, name) {
    const r = db.prepare('UPDATE fleet_sets SET name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), setId);
    if (!r.changes)
        throw notFound('Fleet set');
}
export function deleteSet(db, setId) {
    const r = db.prepare('DELETE FROM fleet_sets WHERE id = ?').run(setId);
    if (!r.changes)
        throw notFound('Fleet set');
}
function touchSet(db, setId) {
    db.prepare('UPDATE fleet_sets SET updated_at = ? WHERE id = ?').run(nowIso(), setId);
}
export function createFleet(db, setId, name) {
    if (!db.prepare('SELECT 1 FROM fleet_sets WHERE id = ?').get(setId))
        throw notFound('Fleet set');
    const t = nowIso();
    const id = newId();
    const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM fleets WHERE fleet_set_id = ?').get(setId).n;
    db.prepare('INSERT INTO fleets (id, fleet_set_id, name, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, setId, name, sort, t, t);
    touchSet(db, setId);
    return id;
}
export function setPlaceholders(db, fleetId, labels) {
    db.prepare('UPDATE fleets SET placeholders = ? WHERE id = ?').run(JSON.stringify(labels.slice(0, FLEET_SIZE).map((l) => l ?? '')), fleetId);
}
export function renameFleet(db, fleetId, name) {
    const f = getFleet(db, fleetId);
    db.prepare('UPDATE fleets SET name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), fleetId);
    touchSet(db, f.fleet_set_id);
}
/** Deleting a fleet frees its teams; they stay in the team database. */
export function deleteFleet(db, fleetId) {
    const f = getFleet(db, fleetId);
    db.prepare('DELETE FROM fleets WHERE id = ?').run(fleetId);
    touchSet(db, f.fleet_set_id);
}
export function moveFleet(db, fleetId, direction) {
    const f = getFleet(db, fleetId);
    const list = db.prepare('SELECT * FROM fleets WHERE fleet_set_id = ? ORDER BY sort, created_at').all(f.fleet_set_id);
    const i = list.findIndex((x) => x.id === fleetId);
    const j = i + direction;
    if (j < 0 || j >= list.length)
        return;
    [list[i], list[j]] = [list[j], list[i]];
    db.transaction(() => list.forEach((x, k) => db.prepare('UPDATE fleets SET sort = ? WHERE id = ?').run(k + 1, x.id)))();
}
function getFleet(db, fleetId) {
    const f = db.prepare('SELECT * FROM fleets WHERE id = ?').get(fleetId);
    if (!f)
        throw notFound('Fleet');
    return f;
}
export function getSetDetail(db, setId) {
    const set = db.prepare('SELECT id, name, event_id AS eventId, updated_at AS updatedAt FROM fleet_sets WHERE id = ?').get(setId);
    if (!set)
        throw notFound('Fleet set');
    const fleets = db.prepare('SELECT * FROM fleets WHERE fleet_set_id = ? ORDER BY sort, created_at').all(setId);
    const slots = db.prepare('SELECT * FROM fleet_slots WHERE fleet_set_id = ?').all(setId);
    return {
        set,
        fleets: fleets.map((f) => {
            const positions = Array.from({ length: FLEET_SIZE }, (_, i) => slots.find((s) => s.fleet_id === f.id && s.position === i + 1)?.team_id ?? null);
            const filled = positions.filter(Boolean).length;
            const ph = JSON.parse(f.placeholders || '[]');
            const placeholders = Array.from({ length: FLEET_SIZE }, (_, i) => ph[i] || null);
            return { id: f.id, name: f.name, positions, placeholders, filled, complete: filled === FLEET_SIZE };
        }),
        assignedTeamIds: slots.map((s) => s.team_id),
    };
}
/**
 * Put a team into fleet/position within one fleet set.
 * Occupied target: 'reject' (default) answers 409 with the occupant and free positions;
 * 'swap' moves the occupant to the dragged team's previous place, or back to the unassigned list
 * when the team came from there. Nothing is replaced silently.
 */
export function placeTeam(db, setId, input) {
    const { teamId, fleetId, position } = input;
    if (!Number.isInteger(position) || position < 1 || position > FLEET_SIZE)
        throw badRequest(`Fleet position must be between 1 and ${FLEET_SIZE}.`);
    const fleet = getFleet(db, fleetId);
    if (fleet.fleet_set_id !== setId)
        throw badRequest('This fleet belongs to a different fleet set.');
    if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId))
        throw notFound('Team');
    return db.transaction(() => {
        const current = db.prepare('SELECT * FROM fleet_slots WHERE fleet_set_id = ? AND team_id = ?').get(setId, teamId);
        const occupant = db.prepare('SELECT * FROM fleet_slots WHERE fleet_id = ? AND position = ?').get(fleetId, position);
        if (occupant?.team_id === teamId)
            return { changed: false, displaced: null };
        if (occupant) {
            if ((input.onOccupied ?? 'reject') !== 'swap') {
                const used = db.prepare('SELECT position FROM fleet_slots WHERE fleet_id = ?').all(fleetId).map((r) => r.position);
                const free = Array.from({ length: FLEET_SIZE }, (_, i) => i + 1).filter((p) => !used.includes(p) || (current?.fleet_id === fleetId && p === current.position));
                throw conflict('This place is taken. Choose a swap or a free place.', { occupantTeamId: occupant.team_id, freePositions: free });
            }
            db.prepare('DELETE FROM fleet_slots WHERE fleet_id = ? AND position = ?').run(fleetId, position);
        }
        if (current)
            db.prepare('DELETE FROM fleet_slots WHERE fleet_id = ? AND position = ?').run(current.fleet_id, current.position);
        db.prepare('INSERT INTO fleet_slots (fleet_id, fleet_set_id, position, team_id) VALUES (?, ?, ?, ?)').run(fleetId, setId, position, teamId);
        let displaced = null;
        if (occupant) {
            if (current) {
                db.prepare('INSERT INTO fleet_slots (fleet_id, fleet_set_id, position, team_id) VALUES (?, ?, ?, ?)').run(current.fleet_id, setId, current.position, occupant.team_id);
                displaced = { teamId: occupant.team_id, to: 'previous' };
            }
            else
                displaced = { teamId: occupant.team_id, to: 'unassigned' };
        }
        touchSet(db, setId);
        return { changed: true, displaced };
    })();
}
/** First free position of a fleet, or null when it already has four teams. */
export function firstFreePosition(db, fleetId) {
    const used = db.prepare('SELECT position FROM fleet_slots WHERE fleet_id = ?').all(fleetId).map((r) => r.position);
    for (let p = 1; p <= FLEET_SIZE; p++)
        if (!used.includes(p))
            return p;
    return null;
}
export function unassignTeam(db, setId, teamId) {
    db.prepare('DELETE FROM fleet_slots WHERE fleet_set_id = ? AND team_id = ?').run(setId, teamId);
    touchSet(db, setId);
}
