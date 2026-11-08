import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { page, seedTeam, setup } from './helpers.js';
import * as decl from '../src/services/declarations.js';
import { createSailor, getSailor, updateSailor } from '../src/services/sailors.js';
import { createTeam, getTeam, updateTeam } from '../src/services/teams.js';
import { listAssets, saveUpload } from '../src/services/assets.js';
import { normalizeLogo, LOGO_CANVAS } from '../src/services/logo.js';
import { applyRanking, parseNationRanking } from '../src/services/ranking.js';
import { jsonSailors, jsonTeams } from '../src/services/jsonExport.js';

function box(png: PNG) {
  let x0 = png.width, y0 = png.height, x1 = -1, y1 = -1;
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) if (png.data[(y * png.width + x) * 4 + 3] > 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}
function pngOf(w: number, h: number, draw: (x: number, y: number) => [number, number, number, number]) {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = draw(x, y); p.data.set(c, (y * w + x) * 4); }
  return PNG.sync.write(p);
}

describe('third personal best', () => {
  it('is stored, edited and exported', () => {
    const { db, ctx, eventId } = setup();
    const team = createTeam(db, { name: 'Poland', code: 'POL' });
    const id = createSailor(db, team, { firstName: 'Anna', lastName: 'K', bestResult3: 'Olympic gold' });
    expect(getSailor(ctx, id).bestResult3).toBe('Olympic gold');
    updateSailor(db, id, { bestResult3: '1st Worlds' });
    expect(getSailor(ctx, id).bestResult3).toBe('1st Worlds');
    expect(jsonSailors(ctx, eventId, '2026-06-11')[0].best_result_3).toBe('1st Worlds');
  });
});

describe('declared weights', () => {
  it('imports each weight, sums the crew, and keeps manual corrections', async () => {
    const body = page([{ code: 'POL', date: '11-06', crew: [['Anna Kowalska', '1', 'Helm'], ['Jan Nowak', '7', 'Trimmer']] }]);
    const { db, ctx, eventId, sync } = setup(async () => body);
    const { teamId } = seedTeam(db, 'POL', ['Anna Kowalska', 'Jan Nowak']);
    await sync.runNow('manual');
    let d = decl.getDeclaration(ctx, eventId, teamId, '2026-06-11')!;
    expect(d.members.map((m) => m.weight.value)).toEqual(['70.00', '70.00']);
    expect(d.totalWeight).toBe('140');
    expect(d.sourceTotalWeight).toBe('700.00');
    decl.setOverride(db, d.members[0].id, { weight: '72,5 kg' });
    await sync.runNow('manual');
    d = decl.getDeclaration(ctx, eventId, teamId, '2026-06-11')!;
    expect(d.members[0].weight).toMatchObject({ value: '72.5', manual: '72.5', source: '70.00' });
    expect(d.totalWeight).toBe('142.5');
    expect(() => decl.setOverride(db, d.members[0].id, { weight: 'heavy' })).toThrow(/kilograms/);
    const rows = jsonSailors(ctx, eventId, '2026-06-11');
    expect(rows.map((r) => [r.weight, r.team_total_weight])).toEqual([['72.5', '142.5'], ['70.00', '142.5']]);
    decl.clearOverride(db, d.members[0].id, 'weight');
    expect(decl.getDeclaration(ctx, eventId, teamId, '2026-06-11')!.totalWeight).toBe('140');
  });
});

describe('sponsor logos', () => {
  it('evens out logos of different shapes onto one transparent canvas', () => {
    const wide = normalizeLogo(pngOf(600, 300, (x, y) => (x > 50 && x < 350 && y > 100 && y < 200 ? [255, 0, 0, 255] : [0, 0, 0, 0]))); // 3:1
    const square = normalizeLogo(pngOf(64, 64, (x, y) => (x > 7 && x < 56 && y > 7 && y < 56 ? [0, 0, 255, 255] : [0, 0, 0, 0])));
    const a = PNG.sync.read(wide), b = PNG.sync.read(square);
    expect([a.width, a.height]).toEqual([LOGO_CANVAS.width, LOGO_CANVAS.height]);
    expect([b.width, b.height]).toEqual([LOGO_CANVAS.width, LOGO_CANVAS.height]);
    const ba = box(a), bb = box(b);
    expect(Math.abs(ba.w * ba.h - bb.w * bb.h) / (bb.w * bb.h)).toBeLessThan(0.05); // same visible area
    expect(Math.abs(ba.cx - 400)).toBeLessThan(2);
    expect(Math.abs(bb.cy - 200)).toBeLessThan(2);
  });

  it('cuts the solid background of a JPG logo and stores a PNG in sponsor slots 1–5', () => {
    const { db, ctx } = setup();
    const team = createTeam(db, { name: 'Poland', code: 'POL' });
    const w = 300, h = 200, data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const ink = x > 50 && x < 250 && y > 60 && y < 140;
      data.set(ink ? [20, 40, 200, 255] : [255, 255, 255, 255], (y * w + x) * 4);
    }
    const jpg = jpeg.encode({ width: w, height: h, data }, 95).data;
    const a = saveUpload(ctx, 'team', team, 'sponsor_5', Buffer.from(jpg), 'logo.jpg');
    expect(a.mime).toBe('image/png');
    expect([a.width, a.height]).toEqual([800, 400]);
    expect(Object.keys(listAssets(ctx, 'team', team))).toContain('sponsor_5');
    const png = PNG.sync.read(require('node:fs').readFileSync(a.storedPath!));
    expect(png.data[3]).toBe(0); // corner is transparent now
    expect(box(png).w / box(png).h).toBeGreaterThan(2.2);
  });
});

describe('nation ranking', () => {
  it('reads a ranking table by its headers and matches teams by name or known ranking name', () => {
    const html = `<table><tr><th>N°</th><th>Global rank</th><th>Name country</th><th>SSL pts</th></tr>
      <tr><td>01</td><td>01</td><td>GREAT BRITAIN</td><td>53</td></tr>
      <tr><td>02</td><td>02</td><td>KOREA, REPUBLIC OF</td><td>11 704</td></tr>
      <tr><td>03</td><td>03</td><td>POLAND</td><td>606</td></tr></table>`;
    const rows = parseNationRanking(html);
    expect(rows).toEqual([{ position: 1, nation: 'GREAT BRITAIN', points: 53 }, { position: 2, nation: 'KOREA, REPUBLIC OF', points: 11704 }, { position: 3, nation: 'POLAND', points: 606 }]);
    const { db, ctx } = setup();
    const gbr = createTeam(db, { name: 'Great Britain', code: 'GBR' });
    const kor = createTeam(db, { name: 'South Korea', code: 'KOR' });
    createTeam(db, { name: 'Nowhere', code: 'XYZ' });
    const r = applyRanking(db, rows, 'live');
    expect(r.matched).toBe(2);
    expect(r.teamsWithoutRanking).toEqual(['XYZ']);
    expect(getTeam(ctx, kor)).toMatchObject({ ranking: '2', rankingPoints: '11704', rankingManual: false });
    updateTeam(db, gbr, { ranking: '1 (tied)' });
    applyRanking(db, rows, 'live');
    expect(getTeam(ctx, gbr)).toMatchObject({ ranking: '1 (tied)', rankingSource: '1', rankingManual: true });
    updateTeam(db, gbr, { ranking: '' });
    expect(getTeam(ctx, gbr)).toMatchObject({ ranking: '1', rankingManual: false });
    expect(jsonTeams(ctx).find((t) => t.code === 'KOR')).toMatchObject({ ranking: '2', ranking_points: '11704' });
  });

  it('falls back to the text layout "NN NN NATION POINTS"', () => {
    const rows = parseNationRanking('<div>N° GLOBAL RANK NAME COUNTRY SSL PTS</div><div>01 01 GREAT BRITAIN 53</div><div>02 02 UNITED STATES 172</div><div>03 03 1 ITALY 241</div>');
    expect(rows.map((r) => [r.position, r.nation, r.points])).toEqual([[1, 'GREAT BRITAIN', 53], [2, 'UNITED STATES', 172], [3, 'ITALY', 241]]);
  });
});
