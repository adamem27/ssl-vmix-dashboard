import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { setup } from './helpers.js';
import { createTeam, listTeams } from '../src/services/teams.js';
import { saveUpload } from '../src/services/assets.js';
import { encodePng } from '../src/services/png.js';
import { decode } from '../src/services/logo.js';
import { lineupLogos, lineupPanelFor, logoSizes, ltSponsorFor, setLtSponsorSlot, PANEL, stripRect, TAG } from '../src/services/lineupPanel.js';

// a logo: a solid block w×h on a transparent canvas
const logo = (w: number, h: number) => encodePng(w + 40, h + 40, (x, y) => (x >= 20 && x < w + 20 && y >= 20 && y < h + 20 ? [255, 255, 255, 255] : [0, 0, 0, 0]));

describe('line-up panel with team partners', () => {
  it('sizes the logos alike: wider ones lower, all within the row and their slots', () => {
    const [sq, wide, tall] = logoSizes([{ w: 100, h: 100 }, { w: 400, h: 100 }, { w: 50, h: 200 }], 400, { maxH: 80 });
    expect(sq.h).toBe(70);
    expect(wide.h).toBeLessThan(sq.h);
    expect(wide.w).toBeGreaterThan(sq.w);
    expect(wide.w / wide.h).toBeCloseTo(4, 0);
    expect(tall.h).toBeLessThanOrEqual(80);
    // one logo too wide for its slot: all shrink together first
    const [a, b] = logoSizes([{ w: 100, h: 100 }, { w: 1000, h: 100 }], 300, { maxH: 80 });
    expect(b.w).toBeLessThanOrEqual(264);
    expect(a.h).toBeLessThan(70);
  });

  it('keeps the TEAM PARTNERS label clear of the logos: the logos fit under it with the gap on every line-up', () => {
    for (const kind of [9, 10] as const) {
      const st = stripRect(kind, PANEL.height);
      expect(st.maxH).toBeGreaterThan(100);
      expect(17 + 28 + st.maxH).toBeLessThanOrEqual(st.h);
    }
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
    const STRIP = stripRect(9, PANEL.height);
    const whiteIn = (im: ReturnType<typeof decode>) => {
      let n = 0;
      for (let y = STRIP.y + 40; y < STRIP.y + STRIP.h - 5; y++) for (let x = STRIP.x; x < STRIP.x + STRIP.w; x++) {
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

  it('the logo on the lower third tab as big as the tab allows, a margin kept above, below and at the sides', () => {
    const { db, ctx } = setup();
    const a = createTeam(db, { name: 'Alpha', code: 'AAA' });
    const box = (file: string) => {
      const im = decode(fs.readFileSync(file));
      let x0 = im.width, y0 = im.height, x1 = -1, y1 = -1;
      for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
        const i = (y * im.width + x) * 4;
        // the logo: dark (a white logo goes dark on the light tab)
        if (im.data[i + 3] === 255 && im.data[i] < 100) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      }
      return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    };
    // square: from 16 px under the top to 10 px above the bar
    saveUpload(ctx, 'team', a, 'sponsor_1', logo(200, 200), 's1.png');
    const sq = box(ltSponsorFor(ctx, listTeams(ctx)[0] as never)!);
    expect(sq.h).toBeGreaterThanOrEqual(88);
    expect(sq.y0).toBeGreaterThanOrEqual(14);
    expect(TAG.height - (sq.y0 + sq.h)).toBeGreaterThanOrEqual(8);
    // a wide one: the same visual area as the square (not as wide as the tab), margins left at the sides
    saveUpload(ctx, 'team', a, 'sponsor_1', logo(600, 60), 's2.png');
    const wide = box(ltSponsorFor(ctx, listTeams(ctx)[0] as never)!);
    expect((wide.w * wide.h) / (sq.w * sq.h)).toBeGreaterThan(0.85);
    expect((wide.w * wide.h) / (sq.w * sq.h)).toBeLessThan(1.25);
    expect(wide.x0).toBeGreaterThanOrEqual(48);
    // a thin outline wordmark of the same box covers less: drawn bigger, up to the tab's width
    const outline = encodePng(640, 100, (x, y) => (x >= 20 && x < 620 && y >= 20 && y < 80 && (x < 26 || x > 613 || y < 26 || y > 73) ? [0, 0, 0, 255] : [0, 0, 0, 0]));
    saveUpload(ctx, 'team', a, 'sponsor_1', outline, 's3.png');
    const thin = box(ltSponsorFor(ctx, listTeams(ctx)[0] as never)!);
    expect(thin.w).toBeGreaterThan(wide.w);
    expect(thin.w).toBeLessThanOrEqual(422);
  });

  it('shows the sponsor picked for the lower third, logo 1 when that place is empty, nothing for none', () => {
    const { db, ctx } = setup();
    const a = createTeam(db, { name: 'Alpha', code: 'AAA' });
    saveUpload(ctx, 'team', a, 'sponsor_1', logo(300, 60), 's1.png');
    saveUpload(ctx, 'team', a, 'sponsor_3', logo(200, 200), 's3.png');
    const t = () => listTeams(ctx)[0] as never;
    expect(ltSponsorFor(ctx, t())).toMatch(/AAA_lt_sponsor\.png$/);
    setLtSponsorSlot(ctx, a, 'sponsor_3');
    expect(ltSponsorFor(ctx, t())).toMatch(/AAA_lt_sponsor_3\.png$/);
    setLtSponsorSlot(ctx, a, 'sponsor_2');
    expect(ltSponsorFor(ctx, t())).toMatch(/AAA_lt_sponsor\.png$/);
    setLtSponsorSlot(ctx, a, 'none');
    expect(ltSponsorFor(ctx, t())).toMatch(/lt_sponsor_none\.png$/);
  });

  it('RSA: the line-up only Sponsor logo 1, the lower third Sponsor logo 2, both with their colours and background as they are', () => {
    const { db, ctx } = setup();
    const r = createTeam(db, { name: 'South Africa', code: 'RSA' });
    // black on a solid white background: any other team gets the background cleared and the logo turned white / kept
    const boxed = (w: number, h: number, ink: number[]) => encodePng(w, h, (x, y) => (x > w / 4 && x < (3 * w) / 4 && y > h / 4 && y < (3 * h) / 4 ? ink : [255, 255, 255, 255]));
    saveUpload(ctx, 'team', r, 'sponsor_1', boxed(200, 100, [0, 0, 0, 255]), 'a.png');
    saveUpload(ctx, 'team', r, 'sponsor_2', boxed(120, 120, [0, 0, 0, 255]), 'b.png');
    saveUpload(ctx, 'team', r, 'sponsor_3', boxed(120, 120, [255, 0, 0, 255]), 'c.png');
    const t = listTeams(ctx)[0] as never;
    expect(lineupLogos(ctx, t)).toHaveLength(1);
    const img = decode(fs.readFileSync(lineupPanelFor(ctx, t)!));
    const STRIP = stripRect(9, PANEL.height);
    let white = 0, black = 0, red = 0;
    for (let y = STRIP.y; y < STRIP.y + STRIP.h; y++) for (let x = STRIP.x; x < STRIP.x + STRIP.w; x++) {
      const o = (y * img.width + x) * 4;
      if (img.data[o] > 245 && img.data[o + 1] > 245 && img.data[o + 2] > 245) white++;
      if (img.data[o] < 10 && img.data[o + 1] < 10 && img.data[o + 2] < 10) black++;
      if (img.data[o] > 200 && img.data[o + 1] < 50) red++;
    }
    // its white background stays and its black ink stays black (not turned white); sponsor 3 is not there
    expect(white).toBeGreaterThan(2000);
    expect(black).toBeGreaterThan(500);
    expect(red).toBe(0);
    // the lower third: Sponsor logo 2, its white background kept on the tab
    const tab = ltSponsorFor(ctx, t)!;
    expect(tab).toMatch(/RSA_lt_sponsor_2\.png$/);
    const ti = decode(fs.readFileSync(tab));
    const mid = ((TAG.height / 2) * ti.width + TAG.width / 2 - 40) * 4;
    expect([ti.data[mid], ti.data[mid + 1], ti.data[mid + 2]]).toEqual([255, 255, 255]);
  });
});
