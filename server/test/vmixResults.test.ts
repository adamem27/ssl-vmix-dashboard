import { describe, expect, it } from 'vitest';
import { seedTeam, setup } from './helpers.js';
import * as rs from '../src/services/results.js';
import { createSet, createFleet } from '../src/services/fleets.js';
import { findInput, parseVmixXml, pushResults, setVmixUrl } from '../src/services/vmixResults.js';

const fields = (rows: number) => ['TITLE', 'SUBTITLE', 'H1', 'H2', 'HPOINTS', ...Array.from({ length: rows }, (_, i) => [`POS ${i + 1}`, `TEAM ${i + 1}`, `R1 ${i + 1}`, `R2 ${i + 1}`, `POINTS ${i + 1}`]).flat()]
  .map((n, i) => `<text index="${i}" name="${n}.Text">x</text>`).join('') + Array.from({ length: rows }, (_, i) => `<image index="${i}" name="FLAG ${i + 1}.Source"></image>`).join('');
const XML = `<vmix><version>27</version><inputs>
  <input key="k-cam" number="1" type="Capture" title="Camera 1" state="Running"></input>
  <input key="k-res" number="2" type="GT" title="Group_overall_results_3_teams_v4.gtzip" state="Paused">${fields(3)}</input>
</inputs><overlays/></vmix>`;

describe('results to vMix', () => {
  it('finds the input and sets only its fields, in standing order, emptying spare rows', async () => {
    const { db, ctx, eventId } = setup();
    const a = seedTeam(db, 'BRN', ['Ali Hassan']);
    const b = seedTeam(db, 'IND', ['Ravi Kumar']);
    const setId = createSet(db, eventId, 'Panam', 0);
    const fleetId = createFleet(db, setId, 'Group A');
    [a, b].forEach((t, i) => db.prepare('INSERT INTO fleet_slots (fleet_id, fleet_set_id, position, team_id) VALUES (?, ?, ?, ?)').run(fleetId, setId, i + 1, t.teamId));
    rs.saveResults(db, fleetId, { races: 2, rows: [{ teamId: a.teamId, races: ['3', '4'] }, { teamId: b.teamId, races: ['4', '4'] }], order: [b.teamId, a.teamId], vmixInput: 'Group_overall_results_3_teams_v4' });
    rs.clearResults(db, fleetId); // the input survives a clear
    expect(rs.getResults(db, fleetId).vmixInput).toBe('Group_overall_results_3_teams_v4');
    rs.saveResults(db, fleetId, { races: 2, rows: [{ teamId: a.teamId, races: ['3', '4'] }, { teamId: b.teamId, races: ['4', '4'] }], order: [b.teamId, a.teamId] });

    expect(parseVmixXml(XML).map((i) => i.number)).toEqual(['1', '2']);
    expect(findInput(parseVmixXml(XML), '2')?.key).toBe('k-res');
    setVmixUrl(db, 'http://10.0.0.5:8088/api/');
    const calls: string[] = [];
    const fake = async (url: string) => { calls.push(url); return { ok: true, status: 200, text: async () => (url.endsWith('/api/') ? XML : '') }; };
    const r = await pushResults(ctx, fleetId, rs.getResults(db, fleetId).vmixInput, fake);
    expect(calls[0]).toBe('http://10.0.0.5:8088/api/');
    const set = new Map(calls.slice(1).map((u) => { const q = new URL(u).searchParams; expect(q.get('Input')).toBe('k-res'); return [q.get('SelectedName')!, q.get('Value')!]; }));
    expect(set.get('SUBTITLE.Text')).toBe('GROUP A');
    expect(set.has('TITLE.Text')).toBe(false); // the event name stays as designed
    expect([set.get('TEAM 1.Text'), set.get('POINTS 1.Text'), set.get('TEAM 2.Text'), set.get('R1 2.Text')]).toEqual(['TEAM IND', '8', 'TEAM BRN', '3']);
    expect([set.get('POS 3.Text'), set.get('TEAM 3.Text'), set.get('POINTS 3.Text')]).toEqual(['', '', '']);
    expect(set.has('FLAG 1.Source')).toBe(true);
    expect(set.get('H2.Text')).toBe('R2');
    expect(r).toMatchObject({ number: '2', rowsInTitle: 3, teams: 2, tooMany: false });
    expect(calls.some((u) => u.includes('Function=SetImage') && u.includes('FLAG%201.Source'))).toBe(true);

    // race columns fill from the right: one race sits in the last column, next to Points
    const again = async () => { calls.length = 0; const res = await pushResults(ctx, fleetId, '2', fake); return { res, m: new Map(calls.slice(1).map((u) => { const q = new URL(u).searchParams; return [q.get('SelectedName')!, q.get('Value')!]; })) }; };
    rs.saveResults(db, fleetId, { races: 1 });
    let x = await again();
    expect([x.m.get('H1.Text'), x.m.get('H2.Text'), x.m.get('R1 1.Text'), x.m.get('R2 1.Text')]).toEqual(['', 'R1', '', '4']);
    // more races than columns: the last ones are shown
    rs.saveResults(db, fleetId, { races: 3, rows: [{ teamId: b.teamId, races: ['4', '4', '1'] }] });
    x = await again();
    expect([x.m.get('H1.Text'), x.m.get('H2.Text'), x.m.get('R1 1.Text'), x.m.get('R2 1.Text')]).toEqual(['R2', 'R3', '4', '1']);
    expect(x.res).toMatchObject({ cols: 2, races: 3, racesHidden: 1 });

    await expect(pushResults(ctx, fleetId, 'Nope', fake)).rejects.toThrow(/no input/);
    await expect(pushResults(ctx, fleetId, '2', async () => { throw new Error('ECONNREFUSED'); })).rejects.toThrow(/Web Controller/);
    expect(() => setVmixUrl(db, 'not a url')).toThrow();
  });
});
