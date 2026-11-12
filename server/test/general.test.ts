import { describe, expect, it } from 'vitest';
import { activeEvent, openDb } from '../src/db/db.js';
import * as gen from '../src/services/general.js';
import { createTeam } from '../src/services/teams.js';
import { createSailor, setCaptain } from '../src/services/sailors.js';

describe('general graphics and captains', () => {
  it('keeps one captain per team', () => {
    const db = openDb(':memory:');
    const t = createTeam(db, { name: 'Team', code: 'TST' });
    const a = createSailor(db, t, { lastName: 'A' });
    const b = createSailor(db, t, { lastName: 'B' });
    setCaptain(db, a, true);
    setCaptain(db, b, true);
    const caps = db.prepare('SELECT id FROM sailors WHERE is_captain = 1').all() as { id: string }[];
    expect(caps.map((c) => c.id)).toEqual([b]);
  });

  it('stores weather, schedule and commentator sets', () => {
    const db = openDb(':memory:');
    const ev = activeEvent(db).id;
    gen.setWeather(db, { wind_speed: '12', wind_direction: 'NW' });
    expect(gen.getWeather(db)).toMatchObject({ wind_speed: '12', wind_direction: 'NW' });
    gen.setWeather(db, { wind_degrees: '050', forecast: 'Sunny', location: 'gone', note: 'gone' });
    const w = gen.getWeather(db) as unknown as Record<string, string>;
    expect(w).toMatchObject({ wind_degrees: '050', forecast: 'Sunny' });
    expect(w.location).toBeUndefined();
    expect(w.note).toBeUndefined();
    // a value saved as conditions before the rename shows as the forecast
    db.prepare("UPDATE settings SET value = ? WHERE key = 'weather'").run(JSON.stringify({ conditions: 'Rain' }));
    expect(gen.getWeather(db).forecast).toBe('Rain');
    gen.createScheduleItem(db, ev, { date: '2026-11-19', time: '14:00', race: 'Race 2' });
    gen.createScheduleItem(db, ev, { date: '2026-11-19', time: '13:00', race: 'Race 1' });
    expect(gen.listSchedule(db, ev, '2026-11-19').map((r) => r.race)).toEqual(['Race 1', 'Race 2']);
    expect(gen.addCommentatorSet(db, ev, 'English').added).toBe(3);
    expect(gen.addCommentatorSet(db, ev, 'English').added).toBe(0);
  });
});
