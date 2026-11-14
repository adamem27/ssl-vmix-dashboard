import { describe, expect, it } from 'vitest';
import { seedTeam, setup } from './helpers.js';
import * as gs from '../src/services/graphicSets.js';
import * as lu from '../src/services/lineups.js';
import * as rs from '../src/services/results.js';
import { createManualDeclaration, addMember, getDeclaration } from '../src/services/declarations.js';
import { createSet, createFleet } from '../src/services/fleets.js';
import { allSheets } from '../src/services/workbook.js';
import { groupLabel } from '../src/services/groups.js';
import { groupTitle } from '../src/services/groupNames.js';
import { realTodayIn, setDayOverride, todayIn } from '../src/services/dates.js';

describe('general graphics versions', () => {
  it('seeds defaults once, copies, moves and exports one row per version', () => {
    const { db, ctx, eventId } = setup();
    gs.seedGraphicSets(db, eventId);
    const tickers = gs.listGraphicSets(db, eventId, 'ticker');
    expect(tickers.map((t) => t.name)).toEqual(['Top ticker', 'Bottom ticker', 'Warning signal', 'Thanks for watching', 'Delay', 'Custom text']);
    gs.updateGraphicSet(db, tickers[1].id, { data: { items: 'RACE 2 WILL START SOON\n\nGROUP A NEXT' } });
    expect(gs.graphicSheetRows(db, eventId, 'ticker')[1].text).toBe(gs.repeatLoop('RACE 2 WILL START SOON I GROUP A NEXT I '));
    const copy = gs.createGraphicSet(db, eventId, 'socials', 'Spanish', {}, gs.listGraphicSets(db, eventId, 'socials')[0].id);
    gs.moveGraphicSet(db, copy, -1);
    const socials = gs.graphicSheetRows(db, eventId, 'socials');
    expect(socials.map((r) => r.set)).toEqual(['Spanish', 'Follow us']);
    expect(socials[0].facebook).toBe('@SSLGOLDCUP');
    for (const s of gs.listGraphicSets(db, eventId, 'welcome')) gs.deleteGraphicSet(db, s.id);
    gs.seedGraphicSets(db, eventId);
    expect(gs.listGraphicSets(db, eventId, 'welcome')).toHaveLength(0); // deleting is respected
    const names = allSheets(ctx).map((s) => s.name);
    expect(names).toEqual(['General', 'Teams', 'Sailors', 'Line-up', 'Results', 'Announcements', 'People', 'Racing now']);
  });

  it('has fixed tickers that need only their changing parts, filled from the group racing now', () => {
    const { db, eventId } = setup();
    gs.seedGraphicSets(db, eventId);
    const t = (p: string) => gs.listGraphicSets(db, eventId, 'ticker').find((x) => x.data.preset === p)!;
    gs.updateGraphicSet(db, t('warning').id, { data: { race: '1', group: 'h', time: '10:00' } });
    expect(gs.tickerText(t('warning').data)).toBe(gs.repeatLoop('Race 1 of Group h warning signal at 10:00 (GMT-3) I '));
    // repeated so the ticker runs on: 3× and 600 characters at least
    expect(gs.repeatLoop('A I ')).toBe('A I '.repeat(150));
    expect(gs.repeatLoop('x'.repeat(400))).toBe('x'.repeat(1200));
    expect(gs.tickerMessages(t('thanks').data)).toEqual(['Thanks for watching - join us TOMORROW for the 2ND DAY of the SSL GOLD CUP PAN-AMERICAN QUALIFIERS']);
    expect(gs.tickerMessages(t('delay').data, { group: 'I', race: '2' })).toEqual(['We are back soon - Race 2 of Group I is delayed due to WEATHER CONDITIONS']);
    expect(() => gs.deleteGraphicSet(db, t('custom').id)).toThrow(/fixed/);
    gs.seedGraphicSets(db, eventId);
    expect(gs.listGraphicSets(db, eventId, 'ticker').filter((x) => x.data.preset)).toHaveLength(4); // not doubled
    // announcements: one per race flag (its PNG as the icon) plus Replay
    const ann = gs.listGraphicSets(db, eventId, 'announcement');
    expect(ann.length).toBe(gs.FLAG_ANNOUNCEMENTS.length + 1);
    expect(ann.find((a) => a.name === 'Yellow – Penalty')?.data).toMatchObject({ text: 'PENALTY', icon: 'race-flags/YELLOW_penalty.png' });
    expect(ann.at(-1)).toMatchObject({ name: 'Replay', data: { text: 'REPLAY', icon: '' } });
  });

  it('names groups as the broadcast does', () => {
    expect(['QS H', 'R1 A', 'EF b', 'Group C', 'Final', 'Petit Final'].map(groupLabel)).toEqual(['Group H', 'Group A', 'Group B', 'Group C', 'Final', 'Petit Final']);
    // a results title saved as the short name shows as the group; other titles stay as typed
    expect(['QS H', 'qs i', 'Final day'].map(groupTitle)).toEqual(['Group H', 'Group I', 'Final day']);
  });

  it('every today follows the day picked at the top, until it is set back', () => {
    setDayOverride('2026-11-12');
    expect(todayIn('America/Sao_Paulo')).toBe('2026-11-12');
    setDayOverride('');
    expect(todayIn('America/Sao_Paulo')).toBe(realTodayIn('America/Sao_Paulo'));
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
    // nobody declared on Bow or Grinder: the floater takes the first of them (Bow), with the floater's own data
    expect(at('Bow')).toMatchObject({ firstName: 'Eli', lastName: 'Floater', number: '8', position: 'FLOATER' });
    expect(at('Floater').firstName).toBe('');
    expect(l.data.rows.map((x) => x.slot)).toEqual(['Bow', 'Midbow', 'Pit', 'Grinder', 'Trimmer', 'Trimmer1', 'Main', 'Tactician', 'Helm', 'Floater']);
    // the team's own order of places: kept on save and on the next sync
    lu.saveLineup(ctx, eventId, teamId, { order: ['Helm', 'Tactician'] });
    expect(lu.getLineup(ctx, eventId, teamId).data.rows.slice(0, 3).map((x) => x.slot)).toEqual(['Helm', 'Tactician', 'Bow']);
    lu.syncLineupFromDeclaration(ctx, eventId, teamId, date);
    expect(lu.getLineup(ctx, eventId, teamId).data.rows[0].slot).toBe('Helm');
    expect(l.data.teamName).toBe('Spain');
    lu.saveLineup(ctx, eventId, teamId, { rows: [{ slot: 'Pit', captain: true }] });
    lu.saveLineup(ctx, eventId, teamId, { rows: [{ slot: 'Helm', captain: true }] });
    const row = lu.lineupSheetRows(ctx, eventId)[0];
    expect(row).toMatchObject({ TeamName: 'Spain', HelmSURNAME: 'Bermudez', HelmNUMBER: '1', TacticianSURNAM: 'Gonzalez', Trimmer1POSITIO: 'TRIMMER', CaptainSlot: 'Helm', PitCAPTAIN: '' });
    expect(lu.syncLineupFromDeclaration(ctx, eventId, teamId, '2026-11-20')).toMatchObject({ synced: false });
  });

  it('a floater with every usual place taken goes to the Floater place', () => {
    const { db, ctx, eventId } = setup();
    const names = ['A Bow', 'B Mid', 'C Pit', 'D Gri', 'E Tr', 'F Tr', 'G Main', 'H Tac', 'I Helm', 'J Flo'];
    const { teamId, sailorIds } = seedTeam(db, 'ITA', names);
    const date = '2026-11-19';
    const d = createManualDeclaration(ctx, eventId, teamId, date, 'empty');
    const pos = ['Bow', 'Midbow', 'Pit', 'Grinder', 'Trimmer', 'Trimmer', 'Main trimmer', 'Tactician', 'Helm', 'Floater'];
    sailorIds.forEach((id, i) => addMember(ctx, d.id, { sailorId: id, position: pos[i], number: String(i + 1) }));
    lu.syncLineupFromDeclaration(ctx, eventId, teamId, date);
    const rows = lu.getLineup(ctx, eventId, teamId).data.rows;
    expect(rows.find((x) => x.slot === 'Floater')).toMatchObject({ lastName: 'Flo', position: 'FLOATER' });
    expect(rows.find((x) => x.slot === 'Bow')!.lastName).toBe('Bow');
  });

  it('two grinders sit side by side (Grinder, Main); the main trimmer moves to Tactician, the floater to Trimmer 2', () => {
    const { db, ctx, eventId } = setup();
    const names = ['A Helm', 'B Main', 'C Trim', 'D Gri', 'E Gri', 'F Pit', 'G Mid', 'H Bow', 'I Flo'];
    const { teamId, sailorIds } = seedTeam(db, 'ESA', names);
    const date = '2026-11-19';
    const d = createManualDeclaration(ctx, eventId, teamId, date, 'empty');
    const pos = ['Helm', 'Main trimmer', 'Trimmer', 'Grinder', 'Grinder', 'Pit', 'Midbow', 'Bow', 'Floater'];
    sailorIds.forEach((id, i) => addMember(ctx, d.id, { sailorId: id, position: pos[i], number: String(i + 1) }));
    lu.syncLineupFromDeclaration(ctx, eventId, teamId, date);
    const rows = lu.getLineup(ctx, eventId, teamId).data.rows;
    const at = (k: string) => rows.find((x) => x.slot === k)!;
    expect([at('Grinder').lastName, at('Main').lastName]).toEqual(['Gri', 'Gri']);
    expect(at('Main').position).toBe('GRINDER');
    expect(at('Tactician')).toMatchObject({ firstName: 'B', position: 'MAIN TRIMMER' });
    expect(at('Trimmer1')).toMatchObject({ lastName: 'Flo', position: 'FLOATER' });
    // the 9-place board, bow to stern: … trimmer and floater, the two grinders, then helm and main trimmer
    const order = lu.BOARD_BOW_TO_STERN.map((k) => rows.find((x) => x.slot === k)).filter((x) => x?.lastName).map((x) => x!.firstName);
    expect(order).toEqual(['H', 'G', 'F', 'C', 'I', 'D', 'E', 'A', 'B']);
  });

  it('maps declared positions to boat places', () => {
    expect(['Helm', 'Mainsail trimmer', 'Main Trimmer', 'Trimmer', 'Mid-Bow', 'Bow', 'Pit', 'Grinder', 'Floater', 'Spare', ''].map(lu.slotForPosition))
      .toEqual(['Helm', 'Main', 'Main', 'Trimmer', 'Midbow', 'Bow', 'Pit', 'Grinder', 'Floater', null, null]);
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
