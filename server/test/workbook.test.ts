import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { seedTeam, setup } from './helpers.js';
import { listAssets, organizeAssets, saveUpload } from '../src/services/assets.js';
import { updateTeam } from '../src/services/teams.js';
import { setCaptain } from '../src/services/sailors.js';
import { createFleet, createSet } from '../src/services/fleets.js';
import { saveLineup } from '../src/services/lineups.js';
import { nowSheet } from '../src/services/workbookSheets.js';
import { setShowConfig } from '../src/services/show.js';
import { saveResults } from '../src/services/results.js';
import { createGraphicSet, seedGraphicSets } from '../src/services/graphicSets.js';
import { generalSheet, resultsSheet, sailorsSheet, setCurrentStage, teamsSheet } from '../src/services/workbookSheets.js';

const png = () => { const p = new PNG({ width: 4, height: 4 }); return PNG.sync.write(p); };
const rel = (ctx: { assetsDir: string }, abs: string | null) => path.relative(ctx.assetsDir, abs ?? '').split(path.sep).join('/');

describe('assets folder', () => {
  it('stores uploads under readable names and follows renames', () => {
    const { db, ctx } = setup();
    const { teamId, sailorIds } = seedTeam(db, 'ARG', ['Santiago Lange']);
    saveUpload(ctx, 'team', teamId, 'flag_big', png(), 'x.png');
    saveUpload(ctx, 'sailor', sailorIds[0], 'photo', png(), 'y.png');
    expect(rel(ctx, listAssets(ctx, 'team', teamId).flag_big.storedPath)).toBe('Teams/ARG - Team ARG/ARG - Flag big.png');
    expect(rel(ctx, listAssets(ctx, 'sailor', sailorIds[0]).photo.storedPath)).toBe('Sailors/ARG - Team ARG/LANGE Santiago - Photo.png');
    // a new upload gets a new name so vMix reloads it; the old file is gone
    saveUpload(ctx, 'team', teamId, 'flag_big', png(), 'x2.png');
    expect(rel(ctx, listAssets(ctx, 'team', teamId).flag_big.storedPath)).toBe('Teams/ARG - Team ARG/ARG - Flag big v2.png');
    expect(fs.existsSync(path.join(ctx.assetsDir, 'Teams/ARG - Team ARG/ARG - Flag big.png'))).toBe(false);
    // renaming the team moves its folder (and the sailors' folder)
    updateTeam(db, teamId, { name: 'Argentina' });
    expect(organizeAssets(ctx)).toBe(2);
    expect(rel(ctx, listAssets(ctx, 'team', teamId).flag_big.storedPath)).toBe('Teams/ARG - Argentina/ARG - Flag big.png');
    expect(fs.existsSync(path.join(ctx.assetsDir, 'Teams/ARG - Team ARG'))).toBe(false);
    expect(organizeAssets(ctx)).toBe(0);
  });

  it('moves files of the old uuid layout', () => {
    const { db, ctx } = setup();
    const { teamId } = seedTeam(db, 'POL', []);
    const old = path.join('teams', teamId, 'flag_small_1a2b3c4d.png');
    fs.mkdirSync(path.join(ctx.assetsDir, 'teams', teamId), { recursive: true });
    fs.writeFileSync(path.join(ctx.assetsDir, old), png());
    saveUpload(ctx, 'team', teamId, 'flag_small', png(), 'a.png');
    db.prepare('UPDATE assets SET stored_rel_path = ? WHERE owner_id = ?').run(old, teamId);
    fs.rmSync(path.join(ctx.assetsDir, 'Teams'), { recursive: true });
    organizeAssets(ctx);
    expect(rel(ctx, listAssets(ctx, 'team', teamId).flag_small.storedPath)).toBe('Teams/POL - Team POL/POL - Flag small.png');
    expect(fs.existsSync(path.join(ctx.assetsDir, 'teams'))).toBe(false);
  });
});

describe('workbook sheets', () => {
  it('follows the current stage, keeps data in rows and each value in one sheet', async () => {
    const { db, ctx, eventId } = setup();
    const a = seedTeam(db, 'BRN', ['Ali Hassan', 'Omar Said']);
    const b = seedTeam(db, 'IND', ['Raj Kumar']);
    seedTeam(db, 'MYA', ['Aung San']);
    setCaptain(db, a.sailorIds[1], true);
    const setId = createSet(db, eventId, 'Qualifying', 0);
    const fleetId = createFleet(db, setId, 'Group A');
    [a.teamId, b.teamId].forEach((t, i) => db.prepare('INSERT INTO fleet_slots (fleet_id, fleet_set_id, position, team_id) VALUES (?, ?, ?, ?)').run(fleetId, setId, i + 1, t));
    saveLineup(ctx, eventId, a.teamId, { rows: [{ slot: 'Helm', sailorId: a.sailorIds[0], firstName: 'Ali', lastName: 'Hassan', number: '7' }] });
    saveResults(db, fleetId, { races: 2, rows: [{ teamId: a.teamId, races: ['4', '3'] }, { teamId: b.teamId, races: ['3', '4'] }] });
    seedGraphicSets(db, eventId);
    createGraphicSet(db, eventId, 'ticker', 'Extra', { items: 'A\nB' });

    const today = '2026-11-19';
    expect(teamsSheet(ctx, eventId, today).map((r) => r.Code)).toEqual(['BRN', 'IND', 'MYA']); // no stage: every team
    setCurrentStage(db, eventId, setId);
    const teams = teamsSheet(ctx, eventId, today);
    expect(teams.map((r) => [r.Group, r.Place, r.Code])).toEqual([['GROUP A', '1', 'BRN'], ['GROUP A', '2', 'IND']]);
    expect(Object.keys(teams[0]).slice(0, 4)).toEqual(['Group', 'Place', 'Code', 'Name']);

    // Racing now: one row about the group picked at the top
    expect(nowSheet(ctx, eventId, today)[0].Group).toBe('');
    setShowConfig(db, { fleetId });
    const now = nowSheet(ctx, eventId, today)[0];
    expect(now).toMatchObject({ Group: 'GROUP A', 'Group letter': 'A', SUBTITLE: 'GROUP A', T1Code: 'BRN', T2Code: 'IND', T3Code: '', 'POS 1': '1', 'POINTS 1': '7', 'R1 1': '4' });

    const sailors = sailorsSheet(ctx, eventId, today);
    expect(sailors.map((r) => [r['Team code'], r['Last name'], r['Line-up place'], r.Captain])).toEqual([
      ['BRN', 'HASSAN', 'Helm', ''], ['BRN', 'SAID', '', 'Yes'], ['IND', 'KUMAR', '', ''],
    ]);
    expect(sailors[0].Number).toBe('7');

    const results = resultsSheet(ctx, eventId);
    expect(results.map((r) => [r.Rank, r.Code, r.R1, r.R2, r.Points])).toEqual([['1', 'BRN', '4', '3', '7'], ['2', 'IND', '3', '4', '7']]);

    const general = generalSheet(ctx, eventId, today);
    // titled blocks: Event then Matchboard in A/B, Weather in D/E; columns named by letter
    expect(Object.keys(general[0]).slice(0, 3)).toEqual(['A', 'B', 'C']);
    expect([general[0].A, general[0].D, general[5].A]).toEqual(['EVENT', 'WEATHER', 'MATCHBOARD']);
    expect([general[2].A, general[2].B]).toEqual(['Stage', 'Qualifying']);
    expect(general.styles!['0:0']).toBe('title');
    const t = general.findIndex((r) => r.A === 'TICKERS');
    const col = Object.entries(general[t + 1]).find(([, v]) => v === 'Extra')![0];
    expect(general.find((r, i) => i > t && r.A === 'Ticker text')![col]).toBe('A I B I ');
    expect(general[t - 1].A).toBe(''); // an empty row between blocks
    expect(general.some((r) => r.A === 'ANNOUNCEMENTS' || r.A === 'PEOPLE')).toBe(false); // own sheets
    const { announcementsSheet, peopleSheet } = await import('../src/services/workbookSheets.js');
    expect(announcementsSheet(ctx, eventId)[0]).toMatchObject({ Version: 'P – Preparatory', Text: 'PREPARATORY SIGNAL' });
    // the icon as vMix reads it: in the assets folder (no vMix root set here)
    expect(announcementsSheet(ctx, eventId)[0].Icon).toMatch(/race-flags[\\/]P_preparatory\.png$/);
    expect(announcementsSheet(ctx, eventId)[0]).not.toHaveProperty('Second line');
    expect(peopleSheet(ctx, eventId)).toEqual([]);
    const { lineupSheet } = await import('../src/services/workbookSheets.js');
    const lu = lineupSheet(ctx, eventId);
    expect(lu.map((r) => r.Code)).toEqual(['BRN', 'IND']);
    expect(Object.keys(lu[0]).slice(0, 4)).toEqual(['Group', 'Code', 'Team', 'Title']);
    // places in the panel's order: bow first by default, the helm last
    expect([lu[0]['1 Place'], lu[0]['9 Place'], lu[0]['9 Surname'], lu[0]['9 Number']]).toEqual(['Bow', 'Helm', 'HASSAN', '7']);
    expect(lu[0]).toHaveProperty('Line-up background');
  });
});

describe('current stage in the API', () => {
  it('lists the stage teams and limits the JSON feeds to them', async () => {
    const { buildApp } = await import('../src/app.js');
    const s = setup();
    const { db, eventId } = s;
    const a = seedTeam(db, 'BRN', ['Ali Hassan']);
    seedTeam(db, 'MYA', ['Aung San']);
    const setId = createSet(db, eventId, 'Panam Qualifiers', 0);
    const fleetId = createFleet(db, setId, 'Group A');
    db.prepare('INSERT INTO fleet_slots (fleet_id, fleet_set_id, position, team_id) VALUES (?, ?, ?, ?)').run(fleetId, setId, 1, a.teamId);
    const app = await buildApp({ db, assetsDir: s.ctx.assetsDir, sync: s.sync });
    expect((await app.inject({ url: '/json/teams' })).json().map((r: { code: string }) => r.code)).toEqual(['BRN', 'MYA']);
    expect((await app.inject({ method: 'PUT', url: '/api/stage', payload: { setId } })).json().teamIds).toEqual([a.teamId]);
    expect((await app.inject({ url: '/json/teams' })).json().map((r: { code: string }) => r.code)).toEqual(['BRN']);
    expect((await app.inject({ url: '/json/sailors' })).json().map((r: { team_code: string }) => r.team_code)).toEqual(['BRN']);
    // commentator: the stage's groups with their standing and line-ups in one call
    saveLineup(s.ctx, eventId, a.teamId, { rows: [{ slot: 'Helm', firstName: 'Ali', lastName: 'Hassan', number: '7' }] });
    const c = (await app.inject({ url: '/api/commentator' })).json();
    expect(c.setId).toBe(setId);
    expect(c.results.map((g: { fleetName: string }) => g.fleetName)).toEqual(['Group A']);
    expect(c.lineups[a.teamId].map((p: { label: string; lastName: string }) => [p.label, p.lastName])).toEqual([['Helm', 'Hassan']]);
    await app.close();
  });
});
