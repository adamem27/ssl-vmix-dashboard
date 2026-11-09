import { describe, expect, it } from 'vitest';
import { setup, seedTeam } from './helpers.js';
import { activeEvent } from '../src/db/db.js';
import { createSet, getSetDetail, placeTeam } from '../src/services/fleets.js';
import { getResults } from '../src/services/results.js';
import { gapText, getRaceRun, raceRunFields, saveRaceRun, toSeconds } from '../src/services/raceRuns.js';

function group() {
  const s = setup();
  const ev = activeEvent(s.db).id;
  const teams = ['IND', 'NED', 'BRN', 'MYA'].map((c) => seedTeam(s.db, c, []).teamId);
  const setId = createSet(s.db, ev, 'Group stage', 1, 4);
  const [f] = getSetDetail(s.db, setId).fleets;
  teams.forEach((t, i) => placeTeam(s.db, setId, { teamId: t, fleetId: f.id, position: i + 1 }));
  return { s, teams, fleetId: f.id };
}

describe('race results with times at marks', () => {
  it('reads times and gaps', () => {
    expect(toSeconds('1:15:53')).toBe(4553);
    expect(toSeconds('15:33')).toBe(933);
    expect(toSeconds('DNF')).toBeNull();
    expect(gapText(53)).toBe('+0:53');
    expect(gapText(3723)).toBe('+1:02:03');
  });

  it('sorts by finish, gives points, fills the title and the overall results', () => {
    const { s, teams, fleetId } = group();
    const [ind, ned, brn, mya] = teams;
    expect(getRaceRun(s.db, fleetId, 2).marks).toEqual(['START', 'MARK 1', 'GATE 2', 'MARK 3', 'FINISH']);
    const run = saveRaceRun(s.db, fleetId, 2, { rows: [
      { teamId: ind, times: ['00:01', '15:33', '29:46', '59:27', '1:15:53'] },
      { teamId: ned, times: ['00:02', '16:55', '30:05', '1:01:11', '1:16:26'] },
      { teamId: brn, times: ['00:00', '15:00', '30:00', '1:00:00', '1:15:00'] },
      { teamId: mya, times: ['00:03', '16:59', '31:17', '1:01:02', ''] },
    ] });
    expect(run.rows.map((r) => r.teamId)).toEqual([brn, ind, ned, mya]);
    expect(run.rows.map((r) => r.gap)).toEqual(['', '+0:53', '+1:26', '']);
    expect(run.rows.map((r) => r.total)).toEqual(['4', '3', '2', '']);
    const overall = getResults(s.db, fleetId);
    expect(overall.races).toBeGreaterThanOrEqual(2);
    expect(overall.rows.find((r) => r.teamId === brn)!.races[1]).toBe('4');

    const f = raceRunFields(s.ctx, fleetId, 2, 4);
    expect(f.get('RACE.Text')).toBe('Race 2');
    expect(f.get('H4.Text')).toBe('MARK 3');
    expect(f.get('M2 1.Text')).toBe('15:00');
    expect(f.get('GAP 1.Text')).toBe('1:15:00');
    expect(f.get('GAP 2.Text')).toBe('+0:53');
    expect(f.get('POINTS 1.Text')).toBe('4');
  });

  it('keeps times when marks are renamed or added', () => {
    const { s, teams, fleetId } = group();
    saveRaceRun(s.db, fleetId, 1, { rows: [{ teamId: teams[0], times: ['00:00', '10:00', '', '', '40:00'] }] });
    const run = saveRaceRun(s.db, fleetId, 1, { marks: ['START', 'MARK 1', 'MARK 2', 'FINISH'] });
    expect(run.rows[0].times).toEqual(['00:00', '10:00', '', '40:00']);
  });
});
