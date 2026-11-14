import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { activeEvent } from '../src/db/db.js';
import { createScheduleItem, getScheduleOptions, setScheduleOptions } from '../src/services/general.js';
import { scheduleHighlightPath, showDataFields, unknownFlagPath } from '../src/services/showData.js';
import { createFleet, createSet, placeTeam } from '../src/services/fleets.js';
import { createTeam } from '../src/services/teams.js';
import { saveUpload } from '../src/services/assets.js';
import { encodePng } from '../src/services/png.js';

const day = '2026-11-11';
function board() {
  const s = setup();
  const ev = activeEvent(s.db).id;
  const ids = [['10:00', '1'], ['10:30', '2'], ['11:00', '3']].map(([time, race]) => createScheduleItem(s.db, ev, { date: day, time, race, fleet: 'QS A' }));
  const fields = () => showDataFields(s.ctx, 'schedule', { eventId: ev, today: day, auto: { enabled: false } as never })!;
  return { s, ids, fields };
}

describe('day schedule board', () => {
  it('fills the rows with TIME by default and leaves the centred copies empty', () => {
    const { fields } = board();
    const f = fields();
    expect(f.get('TIME 1.Text')).toBe('10:00');
    expect(f.get('RACE 2.Text')).toBe('Race 2');
    expect(f.get('POSITION 3.Text')).toBe('3');
    expect(f.get('RACE 2 C.Text')).toBe('');
    expect(f.get('POSITION 1 C.Text')).toBe('');
    expect(f.get('Date.Text')).toBe('11.11.2026');
    expect(f.get('location.Text')).toBe('RIO DE JANEIRO, BRAZIL');
    for (let i = 1; i <= 4; i++) expect(f.get(`HIGHLIGHT ${i}.Source`)).toBe('');
  });

  it('with TIME off fills the centred copies and empties the row fields and TIME', () => {
    const { s, fields } = board();
    setScheduleOptions(s.db, { showTime: false });
    const f = fields();
    expect(f.get('TIME 1.Text')).toBe('');
    expect(f.get('RACE 1.Text')).toBe('');
    expect(f.get('GROUP A.Text')).toBe('');
    expect(f.get('RACE 1 C.Text')).toBe('Race 1');
    expect(f.get('POSITION 2 C.Text')).toBe('2');
    expect(f.get('GROUP 1 C.Text')).not.toBe('');
  });

  it('a group with only some teams known: their flags, the neutral “?” flag in the other places; the name as typed', () => {
    const { s, fields } = board();
    const ev = activeEvent(s.db).id;
    const set = createSet(s.db, ev, 'Final day');
    const qr = createFleet(s.db, set, 'Qualification Race', 4);
    const png = encodePng(4, 4, () => [0, 0, 255, 255]);
    for (const [code, position] of [['BRA', 1], ['CHI', 3]] as const) {
      const teamId = createTeam(s.db, { name: code, code });
      saveUpload(s.ctx, 'team', teamId, 'flag_small', png, `${code}.png`);
      placeTeam(s.db, set, { teamId, fleetId: qr, position });
    }
    createScheduleItem(s.db, ev, { date: day, time: '12:00', race: 'Qualification', fleet: 'Qualification Race' });
    setScheduleOptions(s.db, { showTime: false });
    const f = fields();
    expect(f.get('GROUP 4 C.Text')).toBe('Qualification Race');
    expect(f.get('RACE 4 C.Text')).toBe('Qualification');
    expect(f.get('FLAG 13 C.Source')).toMatch(/BRA/);
    const unknown = unknownFlagPath(s.ctx);
    expect(unknown).toMatch(/flag_unknown\.png$/);
    expect(fs.readFileSync(unknown).readUInt32BE(0)).toBe(0x89504e47);
    expect(f.get('FLAG 14 C.Source')).toBe(unknown); // unknown yet: the “?” flag
    expect(f.get('FLAG 15 C.Source')).toMatch(/CHI/);
    expect(f.get('FLAG 16 C.Source')).toBe(unknown);
    // with TIME on, the same in the row's own flags
    setScheduleOptions(s.db, { showTime: true });
    expect(fields().get('FLAG 14.Source')).toBe(unknown);
    expect(fields().get('FLAG 13.Source')).toMatch(/BRA/);
    setScheduleOptions(s.db, { showTime: false });
    // rows that are not in the schedule are still emptied
    expect(f.get('FLAG 17 C.Source')).toBe('');
  });

  it('highlights the row picked as the next race, only on its day', () => {
    const { s, ids, fields } = board();
    setScheduleOptions(s.db, { date: day, next: ids[1] });
    const f = fields();
    const hl = scheduleHighlightPath(s.ctx);
    expect(f.get('HIGHLIGHT 2.Source')).toBe(hl);
    expect(f.get('HIGHLIGHT 1.Source')).toBe('');
    expect(f.get('HIGHLIGHT 3.Source')).toBe('');
    expect(fs.readFileSync(hl).readUInt32BE(0)).toBe(0x89504e47);
    expect(getScheduleOptions(s.db).next).toEqual({ [day]: ids[1] });
    setScheduleOptions(s.db, { date: day, next: null });
    expect(fields().get('HIGHLIGHT 2.Source')).toBe('');
  });
});

import { weight2 } from '../src/services/showData.js';
describe('team weight in Team comparison', () => {
  it('always has two decimals', () => {
    expect(weight2('702.5')).toBe('702.50');
    expect(weight2('698')).toBe('698.00');
    expect(weight2('701,25 kg')).toBe('701.25 kg');
    expect(weight2('')).toBe('');
  });
});
