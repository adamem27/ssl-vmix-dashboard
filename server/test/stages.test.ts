import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { createTeam } from '../src/services/teams.js';
import * as fleets from '../src/services/fleets.js';
import * as mb from '../src/services/matchboard/matchboard.js';
import { roundOf, stageRound, starredBefore, starredTeams } from '../src/services/matchboard/rounds.js';
import { prepareFinalSeries, starredForSet } from '../src/services/stages.js';
import { applyGoldCup2026 } from '../src/services/presets.js';
import { buildApp } from '../src/app.js';
import { createScheduleItem } from '../src/services/general.js';
import { todayIn } from '../src/services/dates.js';
import { activeEvent } from '../src/db/db.js';

/** A PanAm-like Qualifying Series: groups QS H and QS I with their teams. */
function panAm() {
  const s = setup();
  const codes = ['URU', 'PUR', 'VEN', 'ANT', 'BER', 'MEX', 'CUB', 'ESA'];
  const ids = Object.fromEntries(codes.map((c) => [c, createTeam(s.db, { name: `Team ${c}`, code: c })]));
  const qs = fleets.createSet(s.db, s.eventId, 'Pan-American Qualifiers');
  const h = fleets.createFleet(s.db, qs, 'QS H');
  const i = fleets.createFleet(s.db, qs, 'QS I');
  codes.forEach((c, k) => fleets.placeTeam(s.db, qs, { teamId: ids[c], fleetId: k < 4 ? h : i, position: (k % 4) + 1 }));
  return { ...s, ids, qs };
}
const names = (db: any, eventId: string) => (fleets.listSets(db, eventId) as { name: string }[]).map((x) => x.name);

describe('Final Series stages', () => {
  it('reads the round of boxes, groups and stages', () => {
    expect(['QS H', 'Q I', 'R1 A', 'R2 D', 'EF B', 'QF C', 'SF A', 'FINAL', 'PETIT F.', 'Group A', 'Last Chance Race'].map(roundOf))
      .toEqual([0, 0, 1, 2, 10, 11, 12, 13, 13, null, null]);
    expect(stageRound('1/32 Finals (19 - 22 NOV)')).toBe(1);
    expect(stageRound('1/8 Finals')).toBe(10);
    expect(stageRound('Quarterfinals')).toBe(11);
    expect(stageRound('Pan-American Qualifiers', ['QS H', 'QS I'])).toBe(0);
    expect(stageRound('Anything', ['Last Chance Race', 'R2 A'])).toBe(2);
  });

  it('prepares 1/32 Finals to Quarterfinals with empty groups A–D of four, after the qualifiers, once', () => {
    const { db, eventId, qs, ids } = panAm();
    const r = prepareFinalSeries(db, eventId);
    expect(r.map((x) => x.created)).toEqual([true, true, true, true]);
    expect(names(db, eventId)).toEqual(['Pan-American Qualifiers', '1/32 Finals (19 - 22 NOV)', '1/16 Finals (26 - 29 NOV)', '1/8 Finals (02 - 05 DEC)', 'Quarterfinals (07 - 10 DEC)']);
    const prefixes = ['R1', 'R2', 'EF', 'QF'];
    r.forEach((st, k) => {
      const d = fleets.getSetDetail(db, st.setId);
      expect(d.fleets.map((f) => f.name)).toEqual(['A', 'B', 'C', 'D'].map((l) => `${prefixes[k]} ${l}`));
      expect(d.fleets.every((f) => f.size === 4 && f.filled === 0)).toBe(true);
    });
    // the empty places carry the matchboard's row texts (a team code the database lacks, DRAW n, R1 C1 …)
    expect(fleets.getSetDetail(db, r[0].setId).fleets[0].placeholders).toEqual(['COL', 'DRAW 1', 'DRAW 2', 'DRAW 3']);
    expect(fleets.getSetDetail(db, r[1].setId).fleets[0].placeholders.slice(2)).toEqual(['R1 C1', 'R1 B2']);
    // again: nothing new, the qualifiers untouched
    const again = prepareFinalSeries(db, eventId);
    expect(again.map((x) => [x.created, x.groupsCreated.length])).toEqual([[false, 0], [false, 0], [false, 0], [false, 0]]);
    expect(names(db, eventId)).toHaveLength(5);
    expect(fleets.getSetDetail(db, qs).fleets[0].positions).toEqual([ids.URU, ids.PUR, ids.VEN, ids.ANT]);
  });

  it('keeps the stages and teams already there (Gold Cup preset), adds a missing group, empties places only when asked', () => {
    const { db, eventId } = setup();
    applyGoldCup2026(db);
    const sets = fleets.listSets(db, eventId) as { id: string; name: string }[];
    const r1 = sets.find((x) => x.name.startsWith('1/32'))!;
    const r1d = fleets.getSetDetail(db, r1.id).fleets.find((f) => f.name === 'R1 D')!;
    fleets.deleteFleet(db, r1d.id);
    const r = prepareFinalSeries(db, eventId);
    expect(r.map((x) => x.created)).toEqual([false, false, false, false]);
    expect(r[0]).toMatchObject({ setId: r1.id, groupsCreated: ['R1 D'] });
    expect(fleets.listSets(db, eventId)).toHaveLength(sets.length);
    const d = fleets.getSetDetail(db, r1.id);
    expect(d.fleets.find((f) => f.name === 'R1 A')!.filled).toBe(1); // COL stays
    expect(d.fleets.find((f) => f.name === 'R1 D')!.placeholders).toEqual(['DRAW 9', 'DRAW 10', 'DRAW 11', null]);
    const qsFilled = fleets.getSetDetail(db, sets[0].id).fleets.map((f) => f.filled);
    const cleared = prepareFinalSeries(db, eventId, { clear: true });
    expect(cleared[0].cleared).toBeGreaterThan(0);
    for (const st of cleared) expect(fleets.getSetDetail(db, st.setId).fleets.every((f) => f.filled === 0)).toBe(true);
    expect(fleets.getSetDetail(db, r1.id).fleets[0].placeholders).toEqual([null, 'DRAW 1', 'DRAW 2', 'DRAW 3']);
    expect(fleets.getSetDetail(db, sets[0].id).fleets.map((f) => f.filled)).toEqual(qsFilled); // the Qualifying Series kept
  });

  it('offers the teams starred in earlier stages, latest first, and can take the matchboard teams into the groups', () => {
    const { db, eventId, qs, ids } = panAm();
    const [r1, r2] = prepareFinalSeries(db, eventId);
    // nothing starred yet
    expect(starredForSet(db, r1.setId)).toEqual([]);
    // QS H: URU 1st and PUR 2nd go through; QS I: BER 1st
    const row = (teamId: string, highlight = true) => ({ teamId, text: '', highlight });
    mb.saveState(db, { slots: { 'qs-h-1': row(ids.URU), 'qs-h-2': row(ids.PUR), 'qs-h-3': row(ids.VEN, false), 'qs-i-1': row(ids.BER) } });
    const st = starredForSet(db, r1.setId);
    expect(st.map((x) => [x.teamId, `${x.box} ${x.place}`])).toEqual([[ids.URU, 'QS H 1'], [ids.PUR, 'QS H 2'], [ids.BER, 'QS I 1']]);
    expect(starredForSet(db, qs)).toEqual([]); // the qualifiers take nobody
    // URU placed in R1 A on the matchboard and starred there too: the 1/16 Finals list it from R1 A
    mb.saveState(db, { slots: { 'r1-a-2': row(ids.URU) } });
    const st2 = starredForSet(db, r2.setId);
    expect(st2[0]).toMatchObject({ teamId: ids.URU, box: 'R1 A', place: 2 });
    expect(st2.filter((x) => x.teamId === ids.URU)).toHaveLength(1);
    expect(starredBefore(starredTeams(mb.loadLayout(), mb.getState(db)), null)).toHaveLength(3);
    // the matchboard's R1 A now holds URU in place 2: taken into the empty place, once
    const filled = prepareFinalSeries(db, eventId, { fromMatchboard: true });
    expect(filled[0].placed).toBe(1);
    expect(fleets.getSetDetail(db, r1.setId).fleets[0].positions).toEqual([null, ids.URU, null, null]);
    expect(prepareFinalSeries(db, eventId, { fromMatchboard: true })[0].placed).toBe(0);
  });

  it('API: prepares, lists starred teams, and every graphic works with a stage of empty groups', async () => {
    const s = panAm();
    const a = await buildApp({ db: s.db, assetsDir: s.ctx.assetsDir, sync: s.sync });
    const prep = await a.inject({ method: 'POST', url: '/api/fleet-sets/prepare-final-series', payload: {} });
    expect(prep.statusCode).toBe(200);
    const r1 = prep.json().stages[0].setId as string;
    expect((await a.inject({ method: 'GET', url: `/api/fleet-sets/${r1}/starred` })).json()).toEqual([]);
    // the 1/32 Finals racing, group R1 A on the water, in today's schedule
    expect((await a.inject({ method: 'PUT', url: '/api/stage', payload: { setId: r1 } })).json().group.name).toBe('R1 A');
    const today = todayIn(activeEvent(s.db).timezone);
    createScheduleItem(s.db, s.eventId, { date: today, time: '10:00', race: '1', fleet: 'R1 A' } as any);
    const sched = await import('../src/services/showData.js');
    const rows = sched.scheduleRows(s.ctx, s.eventId, today);
    expect(rows[0]).toMatchObject({ group: 'Group A', flags: [null, null, null, null] });
    const fields = sched.showDataFields(s.ctx, 'schedule', { eventId: s.eventId, today } as any)!;
    expect(fields.get('FLAG 1.Source')).toMatch(/unknown/i);
    const fleetId = (await a.inject({ method: 'GET', url: '/api/stage' })).json().group.id as string;
    const cmp = sched.compareFields(s.ctx, s.eventId, fleetId, today);
    expect(cmp.get('1 COUNTRY.Text')).toBe('');
    expect(cmp.get('Group.Text')).toBe('Group A');
    const { resultFields } = await import('../src/services/vmixResults.js');
    expect(resultFields(s.ctx, fleetId).get('SUBTITLE.Text')).toBeDefined();
    for (const url of ['/api/stage', `/api/overview?set=${r1}&date=${today}`, `/api/commentator?set=${r1}`, '/api/compare', '/api/show', `/api/results/set/${r1}`, '/api/matchboard', '/api/graphic-sets',
      ...['general', 'teams', 'sailors', 'lineup', 'results', 'now'].map((k) => `/json/sheet/${k}`)]) {
      const res = await a.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
    }
    await a.close();
  });
});
