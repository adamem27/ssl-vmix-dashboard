import { describe, expect, it } from 'vitest';
import { seedTeam, setup } from './helpers.js';
import * as gs from '../src/services/graphicSets.js';
import * as lu from '../src/services/lineups.js';
import * as rs from '../src/services/results.js';
import { createManualDeclaration, addMember, getDeclaration } from '../src/services/declarations.js';
import { createSet, createFleet } from '../src/services/fleets.js';
import { allSheets } from '../src/services/workbook.js';

describe('general graphics versions', () => {
  it('seeds defaults once, copies, moves and exports one row per version', () => {
    const { db, ctx, eventId } = setup();
    gs.seedGraphicSets(db, eventId);
    const tickers = gs.listGraphicSets(db, eventId, 'ticker');
    expect(tickers.map((t) => t.name)).toEqual(['Top ticker', 'Bottom ticker']);
    gs.updateGraphicSet(db, tickers[1].id, { data: { items: 'RACE 2 WILL START SOON\n\nGROUP A NEXT' } });
    expect(gs.graphicSheetRows(db, eventId, 'ticker')[1].text).toBe('RACE 2 WILL START SOON I GROUP A NEXT I ');
    const copy = gs.createGraphicSet(db, eventId, 'socials', 'Spanish', {}, gs.listGraphicSets(db, eventId, 'socials')[0].id);
    gs.moveGraphicSet(db, copy, -1);
    const socials = gs.graphicSheetRows(db, eventId, 'socials');
    expect(socials.map((r) => r.set)).toEqual(['Spanish', 'Follow us']);
    expect(socials[0].facebook).toBe('@SSLGOLDCUP');
    for (const s of gs.listGraphicSets(db, eventId, 'welcome')) gs.deleteGraphicSet(db, s.id);
    gs.seedGraphicSets(db, eventId);
    expect(gs.listGraphicSets(db, eventId, 'welcome')).toHaveLength(0); // deleting is respected
    const names = allSheets(ctx).map((s) => s.name);
    expect(names).toEqual(['General', 'Teams', 'Sailors', 'Results']);
  });
});

describe('line-ups', () => {
  it('fills places from the declaration by position, keeps edits apart from sailors', () => {
    const { db, ctx, eventId } = setup();
    const { teamId, sailorIds } = seedTeam(db, 'ESP', ['Roberto Bermudez', 'Alfredo Gonzalez', 'Nano Negrin', 'Alex Muscat', 'Pedro Mas', 'Ana Plaza', 'Jon Trim', 'Eli Floater']);
    const date = '2026-11-19';
    const d = createManualDeclaration(ctx, eventId, teamId, date, 'empty');
    const pos = ['Helm', 'Tactician', 'Main Trimmer', 'Pit', 'Mid-Bow', 'Trimmer', 'Trimmer', 'Floater'];
    sailorIds.forEach((id, i) => addMember(ctx, d.id, { sailorId: id, position: pos[i], number: String(i + 1) }));
    expect(getDeclaration(ctx, eventId, teamId, date)!.members).toHaveLength(8);
    lu.saveLineup(ctx, eventId, teamId, { title: 'Lineup', teamName: 'Spain' });
    const r = lu.syncLineupFromDeclaration(ctx, eventId, teamId, date);
    expect(r).toMatchObject({ synced: true, sailors: 8 });
    const l = lu.getLineup(ctx, eventId, teamId);
    const at = (k: string) => l.data.rows.find((x) => x.slot === k)!;
    expect(at('Helm').lastName).toBe('Bermudez');
    expect(at('Main').position).toBe('MAIN TRIMMER');
    expect([at('Trimmer').firstName, at('Trimmer1').firstName]).toEqual(['Ana', 'Jon']);
    expect(at('Bow').firstName).toBe('Eli'); // floater fills the first free place (bow comes first)
    expect(l.data.rows.map((x) => x.slot)).toEqual(['Bow', 'Midbow', 'Pit', 'Grinder', 'Trimmer', 'Trimmer1', 'Main', 'Tactician', 'Helm']);
    // the team's own order of places: kept on save and on the next sync
    lu.saveLineup(ctx, eventId, teamId, { order: ['Helm', 'Tactician'] });
    expect(lu.getLineup(ctx, eventId, teamId).data.rows.slice(0, 3).map((x) => x.slot)).toEqual(['Helm', 'Tactician', 'Bow']);
    lu.syncLineupFromDeclaration(ctx, eventId, teamId, date);
    expect(lu.getLineup(ctx, eventId, teamId).data.rows[0].slot).toBe('Helm');
    expect(l.data.teamName).toBe('Spain');
    lu.saveLineup(ctx, eventId, teamId, { rows: [{ slot: 'Pit', captain: true }] });
    lu.saveLineup(ctx, eventId, teamId, { rows: [{ slot: 'Helm', captain: true }] });
    const row = lu.lineupSheetRows(ctx, eventId)[0];
    expect(row).toMatchObject({ TeamName: 'SPAIN', HelmSURNAME: 'BERMUDEZ', HelmNUMBER: '1', TacticianSURNAM: 'GONZALEZ', Trimmer1POSITIO: 'TRIMMER', CaptainSlot: 'Helm', PitCAPTAIN: '' });
    expect(lu.syncLineupFromDeclaration(ctx, eventId, teamId, '2026-11-20')).toMatchObject({ synced: false });
  });

  it('maps declared positions to boat places', () => {
    expect(['Helm', 'Mainsail trimmer', 'Main Trimmer', 'Trimmer', 'Mid-Bow', 'Bow', 'Pit', 'Grinder', 'Floater', 'Spare', ''].map(lu.slotForPosition))
      .toEqual(['Helm', 'Main', 'Main', 'Trimmer', 'Midbow', 'Bow', 'Pit', 'Grinder', null, null, null]);
  });
});

describe('results', () => {
  it('adds up race points, sorts the standing and exports one row per group', () => {
    const { db, ctx, eventId } = setup();
    const teams = ['BRN', 'IND', 'NED', 'MYA'].map((c) => seedTeam(db, c, []).teamId);
    const setId = createSet(db, eventId, 'Qualifying', 0);
    const fleetId = createFleet(db, setId, 'Group A');
    teams.forEach((t, i) => db.prepare('INSERT INTO fleet_slots (fleet_id, fleet_set_id, position, team_id) VALUES (?, ?, ?, ?)').run(fleetId, setId, i + 1, t));
    let g = rs.getResults(db, fleetId);
    expect(g.rows.map((r) => r.teamId)).toEqual(teams);
    expect(g.races).toBe(6);
    rs.saveResults(db, fleetId, { rows: [
      { teamId: teams[0], races: ['4', '3', '3', '4', '2', '4'] },
      { teamId: teams[1], races: ['3', '4', '2', '2', '4', '3'] },
      { teamId: teams[2], races: ['2', '1', '4', '1', '1', '2'] },
      { teamId: teams[3], races: ['1', '2', '1', '3', '3', '1'], points: '12' },
    ] });
    g = rs.sortResults(db, fleetId);
    expect(g.rows.map((r) => r.total)).toEqual(['20', '18', '12', '11']);
    const row = rs.resultSheetRows(ctx, eventId)[0];
    expect(row).toMatchObject({ group: 'Group A', T1Code: 'BRN', T1Points: '20', T1R6: '4', T3Code: 'MYA', T3Rank: '3', R6Label: 'R6' });
  });
});
