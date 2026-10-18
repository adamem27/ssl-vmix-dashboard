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
    expect(qs.fleets).toHaveLength(10);
    expect(qs.fleets[1].filled).toBe(3);
    const r1 = getSetDetail(db, sets[1].id);
    expect(r1.fleets[0].placeholders).toEqual([null, 'DRAW 1', 'DRAW 2', 'DRAW 3']);
    const again = applyGoldCup2026(db);
    expect(again).toMatchObject({ teamsCreated: 0, teamsExisting: 61, setsCreated: 0 });
    expect(again.setsSkipped).toHaveLength(7);
  });
});
