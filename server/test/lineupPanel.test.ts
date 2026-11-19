import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { setup } from './helpers.js';
import { createTeam, listTeams } from '../src/services/teams.js';
import { saveUpload } from '../src/services/assets.js';
import { encodePng } from '../src/services/png.js';
import { decode } from '../src/services/logo.js';
import { lineupPanelFor, logoSizes, ltSponsorFor, PANEL, STRIP, TAG } from '../src/services/lineupPanel.js';

// a logo: a solid block w×h on a transparent canvas
const logo = (w: number, h: number) => encodePng(w + 40, h + 40, (x, y) => (x >= 20 && x < w + 20 && y >= 20 && y < h + 20 ? [255, 255, 255, 255] : [0, 0, 0, 0]));

describe('line-up panel with team partners', () => {
  it('gives every logo the same area, capped by its slot', () => {
    const [sq, wide, tall] = logoSizes([{ w: 300, h: 100 }, { w: 400, h: 100 }, { w: 50, h: 200 }], 400);
    expect(sq.w * sq.h / (wide.w * wide.h)).toBeCloseTo(1, 1);
    expect(wide.w / wide.h).toBeCloseTo(4, 0);
    expect(tall.h).toBeLessThanOrEqual(80);
    for (const s of logoSizes([{ w: 2000, h: 50 }], 200)) expect(s.w).toBeLessThanOrEqual(164);
  });

  it('draws the strip with the logos for a team with sponsors and the plain panel for one without', () => {
    const { db, ctx } = setup();
    const a = createTeam(db, { name: 'Alpha', code: 'AAA' });
    createTeam(db, { name: 'Beta', code: 'BBB' });
    saveUpload(ctx, 'team', a, 'sponsor_1', logo(300, 100), 's1.png');
    saveUpload(ctx, 'team', a, 'sponsor_2', logo(120, 120), 's2.png');
    const [ta, tb] = listTeams(ctx);
    const pa = lineupPanelFor(ctx, ta as never)!;
    const pb = lineupPanelFor(ctx, tb as never)!;
    expect(pa).toMatch(/Line-up panels[\\/]AAA_lineup_sponsors\.png$/);
    expect(pb).toMatch(/Line-up panels[\\/]lineup_plain\.png$/);
    const img = decode(fs.readFileSync(pa));
    expect([img.width, img.height]).toEqual([PANEL.width, PANEL.height]);
    // white logo pixels inside the strip, none in the plain panel there
    const whiteIn = (im: ReturnType<typeof decode>) => {
      let n = 0;
      for (let y = STRIP.y + STRIP.label + 10; y < STRIP.y + STRIP.h - 5; y++) for (let x = STRIP.x; x < STRIP.x + STRIP.w; x++) {
        const o = (y * im.width + x) * 4;
        if (im.data[o] > 240 && im.data[o + 1] > 240 && im.data[o + 2] > 240) n++;
      }
      return n;
    };
    expect(whiteIn(img)).toBeGreaterThan(2000);
    expect(whiteIn(decode(fs.readFileSync(pb)))).toBe(0);
    // unchanged logos: not written again
    const t0 = fs.statSync(pa).mtimeMs;
    lineupPanelFor(ctx, ta as never);
    expect(fs.statSync(pa).mtimeMs).toBe(t0);
  });

  it('puts sponsor 1 on the lower third tab and an empty picture for a team without one', () => {
    const { db, ctx } = setup();
    const a = createTeam(db, { name: 'Alpha', code: 'AAA' });
    createTeam(db, { name: 'Beta', code: 'BBB' });
    saveUpload(ctx, 'team', a, 'sponsor_1', logo(300, 60), 's1.png');
    const [ta, tb] = listTeams(ctx);
    const pa = ltSponsorFor(ctx, ta as never)!;
    expect(pa).toMatch(/AAA_lt_sponsor\.png$/);
    if (process.env.DBG) fs.copyFileSync(pa, process.env.DBG);
    const im = decode(fs.readFileSync(pa));
    expect([im.width, im.height]).toEqual([TAG.width, TAG.height]);
    expect(im.data[((TAG.height - 2) * im.width + TAG.width / 2) * 4 + 3]).toBe(255);
    for (const p of [ltSponsorFor(ctx, tb as never)!, ltSponsorFor(ctx, null)!]) {
      expect(p).toMatch(/lt_sponsor_none\.png$/);
      expect(decode(fs.readFileSync(p)).data.every((v, i) => i % 4 !== 3 || v === 0)).toBe(true);
    }
  });
});
