import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { seedTeam, setup } from './helpers.js';
import { listAssets, saveUpload } from '../src/services/assets.js';
import { isRounded, roundFlag } from '../src/services/flagShape.js';
import { roundStoredFlagsOnStart } from '../src/services/flags.js';
import { setSetting } from '../src/db/db.js';

const square = (w: number, h: number) => { const p = new PNG({ width: w, height: h }); p.data.fill(255); return PNG.sync.write(p); };
const alpha = (buf: Buffer, x: number, y: number) => { const p = PNG.sync.read(buf); return p.data[(y * p.width + x) * 4 + 3]; };

describe('rounded flags', () => {
  it('ships every bundled flag rounded', () => {
    const dir = 'fixtures/graphics/flags';
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((f) => !isRounded(fs.readFileSync(`${dir}/${f}`)))).toEqual([]);
  });

  it('cuts the corners at 18 % of the height, smoothly, once', () => {
    const r = roundFlag(square(300, 200)); // radius 36
    expect(isRounded(r)).toBe(true);
    expect([alpha(r, 0, 0), alpha(r, 299, 199), alpha(r, 5, 5)]).toEqual([0, 0, 0]);
    expect([alpha(r, 150, 0), alpha(r, 0, 100), alpha(r, 36, 36), alpha(r, 150, 100)]).toEqual([255, 255, 255, 255]);
    const edge = alpha(r, 10, 10); // on the arc: partly covered
    expect(edge).toBeGreaterThan(0); expect(edge).toBeLessThan(255);
    expect(roundFlag(r)).toBe(r); // already rounded: unchanged
  });

  it('rounds every flag upload and the flags stored before', () => {
    const { db, ctx } = setup();
    const { teamId } = seedTeam(db, 'ANT', []);
    const a = saveUpload(ctx, 'team', teamId, 'flag_small', square(300, 200), 'ANT.png');
    expect(isRounded(fs.readFileSync(a.storedPath!))).toBe(true);
    // a square flag left from an older version
    fs.writeFileSync(a.storedPath!, square(300, 200));
    setSetting(db, 'flags.rounded', '');
    expect(roundStoredFlagsOnStart(ctx)).toBe(1);
    expect(isRounded(fs.readFileSync(listAssets(ctx, 'team', teamId).flag_small!.storedPath!))).toBe(true);
    expect(roundStoredFlagsOnStart(ctx)).toBe(0); // once
    // other slots stay as they are
    const e = saveUpload(ctx, 'team', teamId, 'emblem_dark', square(64, 64), 'e.png');
    expect(isRounded(fs.readFileSync(e.storedPath!))).toBe(false);
  });
});
