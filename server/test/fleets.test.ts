import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { createTeam } from '../src/services/teams.js';
import * as fleets from '../src/services/fleets.js';
import { HttpError } from '../src/services/errors.js';

function world() {
  const s = setup();
  const teams = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'].map((c) => createTeam(s.db, { name: c, code: c }));
  const setId = fleets.createSet(s.db, s.eventId, 'Runda 1');
  const f1 = fleets.createFleet(s.db, setId, 'Fleet 1');
  const f2 = fleets.createFleet(s.db, setId, 'Fleet 2');
  return { ...s, teams, setId, f1, f2 };
}

describe('fleets', () => {
  it('holds at most four teams', () => {
    const { db, teams, setId, f1 } = world();
    teams.slice(0, 4).forEach((t, i) => fleets.placeTeam(db, setId, { teamId: t, fleetId: f1, position: i + 1 }));
    expect(fleets.firstFreePosition(db, f1)).toBeNull();
    expect(() => fleets.placeTeam(db, setId, { teamId: teams[4], fleetId: f1, position: 5 })).toThrow(HttpError);
    const detail = fleets.getSetDetail(db, setId);
    expect(detail.fleets[0].filled).toBe(4);
    expect(detail.fleets[0].complete).toBe(true);
    // DB constraint as a second line of defence
    expect(() => db.prepare('INSERT INTO fleet_slots (fleet_id, fleet_set_id, position, team_id) VALUES (?, ?, 17, ?)').run(f1, setId, teams[4])).toThrow();
  });

  it('fleet size can be changed per fleet; shrinking needs the extra places empty', () => {
    const { db, teams, setId, f1, f2 } = world();
    fleets.setFleetSize(db, f1, 6);
    teams.forEach((t, i) => fleets.placeTeam(db, setId, { teamId: t, fleetId: f1, position: i + 1 }));
    let d = fleets.getSetDetail(db, setId);
    expect(d.fleets[0]).toMatchObject({ size: 6, filled: 6, complete: true });
    expect(d.fleets[1]).toMatchObject({ size: 4, filled: 0 });
    expect(() => fleets.setFleetSize(db, f1, 4)).toThrow(/Places 5, 6/);
    fleets.unassignTeam(db, setId, teams[4]);
    fleets.unassignTeam(db, setId, teams[5]);
    fleets.setFleetSize(db, f1, 4);
    expect(() => fleets.placeTeam(db, setId, { teamId: teams[4], fleetId: f1, position: 5 })).toThrow(HttpError);
    fleets.setFleetSize(db, f2, 2);
    d = fleets.getSetDetail(db, setId);
    expect(d.fleets[1].positions).toHaveLength(2);
    expect(() => fleets.setFleetSize(db, f2, 0)).toThrow(HttpError);
    expect(() => fleets.setFleetSize(db, f2, 17)).toThrow(HttpError);
  });

  it('never contains the same team twice', () => {
    const { db, teams, setId, f1, f2 } = world();
    fleets.placeTeam(db, setId, { teamId: teams[0], fleetId: f1, position: 1 });
    // Placing again elsewhere moves it, it does not duplicate.
    fleets.placeTeam(db, setId, { teamId: teams[0], fleetId: f1, position: 3 });
    fleets.placeTeam(db, setId, { teamId: teams[0], fleetId: f2, position: 2 });
    const d = fleets.getSetDetail(db, setId);
    expect(d.assignedTeamIds).toEqual([teams[0]]);
    expect(d.fleets[0].positions).toEqual([null, null, null, null]);
    expect(d.fleets[1].positions).toEqual([null, teams[0], null, null]);
    expect(() => db.prepare('INSERT INTO fleet_slots (fleet_id, fleet_set_id, position, team_id) VALUES (?, ?, 4, ?)').run(f2, setId, teams[0])).toThrow();
  });

  it('refuses to overwrite an occupied place unless a swap is requested', () => {
    const { db, teams, setId, f1, f2 } = world();
    fleets.placeTeam(db, setId, { teamId: teams[0], fleetId: f1, position: 1 });
    fleets.placeTeam(db, setId, { teamId: teams[1], fleetId: f2, position: 1 });
    try {
      fleets.placeTeam(db, setId, { teamId: teams[1], fleetId: f1, position: 1 });
      throw new Error('expected conflict');
    } catch (e: any) {
      expect(e).toBeInstanceOf(HttpError);
      expect(e.status).toBe(409);
      expect(e.details.occupantTeamId).toBe(teams[0]);
      expect(e.details.freePositions).toEqual([2, 3, 4]);
    }
    const r = fleets.placeTeam(db, setId, { teamId: teams[1], fleetId: f1, position: 1, onOccupied: 'swap' });
    expect(r.displaced).toEqual({ teamId: teams[0], to: 'previous' });
    const d = fleets.getSetDetail(db, setId);
    expect(d.fleets[0].positions[0]).toBe(teams[1]);
    expect(d.fleets[1].positions[0]).toBe(teams[0]);
  });

  it('incomplete fleets can be saved and are flagged; removal keeps the team in the database', () => {
    const { db, teams, setId, f1 } = world();
    fleets.placeTeam(db, setId, { teamId: teams[0], fleetId: f1, position: 2 });
    expect(fleets.getSetDetail(db, setId).fleets[0]).toMatchObject({ filled: 1, complete: false });
    fleets.unassignTeam(db, setId, teams[0]);
    expect(db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teams[0])).toBeTruthy();
    expect(fleets.getSetDetail(db, setId).assignedTeamIds).toEqual([]);
  });

  it('assignments are per fleet set, so other rounds can split the same teams differently', () => {
    const { db, eventId, teams, setId, f1 } = world();
    const set2 = fleets.createSet(db, eventId, 'Runda 2');
    const g1 = fleets.createFleet(db, set2, 'Fleet 1');
    fleets.placeTeam(db, setId, { teamId: teams[0], fleetId: f1, position: 1 });
    fleets.placeTeam(db, set2, { teamId: teams[0], fleetId: g1, position: 4 });
    expect(fleets.getSetDetail(db, setId).fleets[0].positions[0]).toBe(teams[0]);
    expect(fleets.getSetDetail(db, set2).fleets[0].positions[3]).toBe(teams[0]);
    expect(() => fleets.placeTeam(db, set2, { teamId: teams[1], fleetId: f1, position: 2 })).toThrow(/different stage/);
  });
});
