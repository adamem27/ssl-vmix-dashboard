import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db.js';
import { applyGoldCup2026 } from '../src/services/presets.js';
import { getSetDetail, listSets } from '../src/services/fleets.js';

describe('SSL Gold Cup 2026 preset', () => {
  it('creates teams and fleet sets once, with placeholders for undecided places', () => {
    const db = openDb(':memory:');
    const r = applyGoldCup2026(db);
    expect(r.teamsCreated).toBe(61);
    expect(r.setsCreated).toBe(7);
    const sets = listSets(db, (db.prepare('SELECT id FROM events').get() as any).id) as any[];
    const qs = getSetDetail(db, sets[0].id);
    expect(qs.fleets).toHaveLength(9);
    expect(qs.fleets[1].filled).toBe(3);
    const r1 = getSetDetail(db, sets[1].id);
    expect(r1.fleets[0].placeholders).toEqual([null, 'DRAW 1', 'DRAW 2', 'DRAW 3']);
    const again = applyGoldCup2026(db);
    expect(again).toMatchObject({ teamsCreated: 0, teamsExisting: 61, setsCreated: 0 });
    expect(again.setsSkipped).toHaveLength(7);
  });

  it('resets only the sets the matchboard changed, keeping their ids', () => {
    const db = openDb(':memory:');
    applyGoldCup2026(db);
    const ev = (db.prepare('SELECT id FROM events').get() as any).id;
    const sets = listSets(db, ev) as any[];
    // Simulate an older install: an extra fleet in QS and a manual change in R1 B.
    db.prepare("INSERT INTO fleets (id, fleet_set_id, name, sort, placeholders, created_at, updated_at) SELECT 'old', fleet_set_id, 'QS J', 99, placeholders, created_at, updated_at FROM fleets WHERE fleet_set_id = ? LIMIT 1").run(sets[0].id);
    const r = applyGoldCup2026(db, ['Qualifying Series', '1/32 Finals (19–22 Nov)']);
    expect(r.setsUpdated).toEqual(['Qualifying Series', '1/32 Finals (19–22 Nov)']);
    expect(r.setsSkipped).toHaveLength(5);
    const qs = getSetDetail(db, sets[0].id);
    expect(qs.fleets.map((f: any) => f.name)).not.toContain('QS J');
    expect(qs.fleets.find((f: any) => f.name === 'QS H').filled).toBe(4);
    const r1b = getSetDetail(db, sets[1].id).fleets.find((f: any) => f.name === 'R1 B');
    expect(r1b.placeholders).toEqual([null, null, 'DRAW 5', 'DRAW 6']);
  });
});

describe('team pages', () => {
  it('adds nicknames, crews and captains once, without duplicates', async () => {
    const { applyTeamPages, loadTeamPages } = await import('../src/services/presets.js');
    const db = openDb(':memory:');
    applyGoldCup2026(db);
    const pages = loadTeamPages();
    expect(pages.length).toBe(61);
    const r = applyTeamPages(db, pages);
    expect(r.missingTeams).toEqual([]);
    expect(r.nicknames).toBe(61);
    expect(r.sailorsCreated).toBeGreaterThan(500);
    expect(r.captains).toBeGreaterThan(55);
    const bra = db.prepare("SELECT nickname, id FROM teams WHERE code = 'BRA'").get() as any;
    expect(bra.nickname).toBe('Brazilian Storm');
    const cap = db.prepare('SELECT first_name, last_name, default_number FROM sailors WHERE team_id = ? AND is_captain = 1').get(bra.id) as any;
    expect(cap).toMatchObject({ first_name: 'Robert', last_name: 'Scheidt', default_number: '10' });
    expect(applyTeamPages(db, pages).sailorsCreated).toBe(0);
  });
});

describe('rooming list', () => {
  it('makes the roster match the list, keeps operator work, fills empty fields', async () => {
    const { applyRooming } = await import('../src/services/presets.js');
    const { createTeam } = await import('../src/services/teams.js');
    const { createSailor, setCaptain } = await import('../src/services/sailors.js');
    const db = openDb(':memory:');
    const ctx = { db, assetsDir: '/tmp/ssl-rooming-test' };
    const team = createTeam(db, { name: 'Brazil', code: 'BRA' });
    const keep = createSailor(db, team, { firstName: 'Martine', lastName: 'Grael', defaultPosition: 'Helm' });
    const gone = createSailor(db, team, { firstName: 'Henry', lastName: 'Boening' });
    const worked = createSailor(db, team, { firstName: 'Kahena', lastName: 'Kunze', bestResult1: 'Olympic gold' });
    setCaptain(db, gone, true);
    const r = applyRooming(ctx, [{ code: 'BRA', crew: [
      { firstName: 'MARTINE', lastName: 'GRAEL', position: 'Trimmer', number: '3', captain: false },
      { firstName: 'Bruna', lastName: 'Di Croce', position: '', number: '', captain: true },
    ] }, { code: 'XXX', crew: [] }]);
    expect(r).toMatchObject({ teams: 1, added: 1, updated: 1, removed: 1, captains: 1, missingTeams: ['XXX'] });
    expect(r.kept).toEqual(['BRA Kahena Kunze']);
    const rows = db.prepare('SELECT * FROM sailors WHERE team_id = ? ORDER BY last_name').all(team) as any[];
    expect(rows.map((s) => s.last_name)).toEqual(['Di Croce', 'Grael', 'Kunze']);
    const grael = rows.find((s) => s.id === keep);
    expect([grael.default_position, grael.default_number]).toEqual(['Helm', '3']);
    expect(rows.find((s) => s.last_name === 'Di Croce').is_captain).toBe(1);
    expect(rows.find((s) => s.id === worked)).toBeTruthy();
  });
});
