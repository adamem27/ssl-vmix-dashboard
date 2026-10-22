import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { createTeam, updateTeam } from '../src/services/teams.js';
import { encodePng } from '../src/services/png.js';
import { inspectImage } from '../src/services/images.js';
import { ElementSpec, renderElement } from '../src/services/generator/render.js';
import {
  createTemplate, GeneratorExporter, listTemplates, upgradeStarterTemplates, jsonGraphics, listGradients, listOutputs, seedGenerator, setGradient, setGradientsFromColors, STARTER_TEMPLATES, updateTemplate,
} from '../src/services/generator/generator.js';

const el = (p: Partial<ElementSpec> = {}): ElementSpec => ({
  width: 40, height: 20, radius: 0, opacity: 100, flip: false, angleOffset: 0, strokeWidth: 0, strokeColor: '#000000', strokeOpacity: 100,
  pattern: false, patternOpacity: 0, patternScale: 100, ...p,
});
const px = (r: { width: number; data: Uint8ClampedArray }, x: number, y: number) => Array.from(r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4));
const redBlue = { angle: 0, stops: [{ pos: 0, color: '#ff0000', opacity: 100 }, { pos: 100, color: '#0000ff', opacity: 100 }] };

function gen() {
  const s = setup();
  const exporter = new GeneratorExporter({ db: s.db, assetsDir: s.ctx.assetsDir });
  return { ...s, exporter };
}

describe('PNG renderer', () => {
  it('draws the gradient left to right, mirrored with flip', () => {
    const r = renderElement(el(), redBlue);
    expect(px(r, 0, 10)[0]).toBeGreaterThan(240);
    expect(px(r, 39, 10)[2]).toBeGreaterThan(240);
    const f = renderElement(el({ flip: true }), redBlue);
    expect(px(f, 0, 10)[2]).toBeGreaterThan(240);
  });

  it('applies stop opacity and element opacity', () => {
    const g = { angle: 0, stops: [{ pos: 0, color: '#ff0000', opacity: 0 }, { pos: 100, color: '#ff0000', opacity: 100 }] };
    const r = renderElement(el({ opacity: 50 }), g);
    expect(px(r, 0, 10)[3]).toBeLessThan(10);
    expect(px(r, 39, 10)[3]).toBeGreaterThan(115);
    expect(px(r, 39, 10)[3]).toBeLessThan(130);
  });

  it('cuts rounded corners and draws an inside stroke', () => {
    const r = renderElement(el({ radius: 8, strokeWidth: 2, strokeColor: '#00ff00' }), redBlue);
    expect(px(r, 0, 0)[3]).toBe(0);
    expect(px(r, 20, 0)).toEqual([0, 255, 0, 255]);
    expect(px(r, 20, 10)[1]).toBeLessThan(50);
  });

  it('darkens half the area with the Illustrator waves, repeating every 81.111 × 60.833 px', () => {
    const white = { angle: 0, stops: [{ pos: 0, color: '#ffffff', opacity: 100 }, { pos: 100, color: '#ffffff', opacity: 100 }] };
    const r = renderElement(el({ width: 812, height: 487, pattern: true, patternOpacity: 100 }), white);
    let dark = 0;
    for (let i = 0; i < r.data.length; i += 4) dark += 1 - r.data[i] / 255;
    expect(dark / (812 * 487)).toBeCloseTo(0.5, 2);
    // same pixel one wave length to the right and one row down (within anti-aliasing)
    for (const [x, y] of [[10, 10], [40, 25], [70, 50], [100, 7]]) {
      expect(Math.abs(px(r, x, y)[0] - px(r, Math.round(x + 81.111 * 3), Math.round(y + 60.8332 * 2))[0])).toBeLessThan(60);
    }
    const half = renderElement(el({ width: 200, height: 100, pattern: true, patternOpacity: 10 }), white);
    expect(Math.min(...Array.from({ length: 200 }, (_, x) => px(half, x, 50)[0]))).toBeGreaterThanOrEqual(228);
  });
});

describe('PNG generator export', () => {
  it('writes one file per team and element, re-renders only what changed, and removes stale files', () => {
    const { db, ctx, exporter } = gen();
    const pol = createTeam(db, { name: 'Poland', code: 'POL' });
    createTeam(db, { name: 'No gradient', code: 'XXX' });
    const bar = createTemplate(db, { ...STARTER_TEMPLATES[0], width: 50, height: 10 });
    const panel = createTemplate(db, { ...STARTER_TEMPLATES[1], width: 60, height: 30 });
    setGradientsFromColors(db, pol, ['#ff0000', '#ffffff']);

    exporter.flush();
    const file = path.join(ctx.assetsDir, 'generated', 'POL', 'POL_bar.png');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(ctx.assetsDir, 'generated', 'POL', 'POL_panel_left.png'))).toBe(true);
    expect(fs.existsSync(path.join(ctx.assetsDir, 'generated', 'XXX'))).toBe(false);
    expect(inspectImage(fs.readFileSync(file))?.width).toBe(50);
    expect(listOutputs(db)).toHaveLength(2);

    const before = fs.statSync(file).mtimeMs;
    const panelFile = path.join(ctx.assetsDir, 'generated', 'POL', 'POL_panel_left.png');
    const panelBefore = fs.readFileSync(panelFile);
    updateTemplate(db, panel.id, { radius: 6 });
    exporter.flush();
    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(fs.readFileSync(panelFile).equals(panelBefore)).toBe(false);

    updateTemplate(db, bar.id, { fileName: 'strip' });
    updateTeam(db, pol, { code: 'PL' });
    exporter.flush();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(ctx.assetsDir, 'generated', 'POL'))).toBe(false);
    expect(fs.existsSync(path.join(ctx.assetsDir, 'generated', 'PL', 'PL_strip.png'))).toBe(true);
  });

  it('skips elements whose gradient version the team has not set', () => {
    const { db, exporter } = gen();
    const t = createTeam(db, { name: 'Poland', code: 'POL' });
    createTemplate(db, { ...STARTER_TEMPLATES[0], width: 10, height: 10 });
    createTemplate(db, { ...STARTER_TEMPLATES[3], width: 10, height: 10 });
    setGradient(db, t, 1, redBlue);
    exporter.flush();
    expect(listOutputs(db).map((o) => o.rel)).toEqual(['generated/POL/POL_bar.png']);
  });

  it('lists vMix paths per team in the Graphics sheet', () => {
    const { db, ctx, exporter } = gen();
    const t = createTeam(db, { name: 'Poland', code: 'POL' });
    createTemplate(db, { ...STARTER_TEMPLATES[0], width: 10, height: 10 });
    setGradient(db, t, 1, redBlue);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('paths.vmixAssetsRoot', 'C:\\SSL-vMix')").run();
    expect(jsonGraphics(db, ctx.assetsDir)[0].bar).toBe('');
    exporter.flush();
    expect(jsonGraphics(db, ctx.assetsDir)).toEqual([{ code: 'POL', name: 'Poland', bar: 'C:\\SSL-vMix\\generated\\POL\\POL_bar.png' }]);
  });

  it('seeds starter elements and board gradients once, without touching existing gradients', () => {
    const { db } = gen();
    const mar = createTeam(db, { name: 'Morocco', code: 'MAR' });
    const nor = createTeam(db, { name: 'Norway', code: 'NOR' });
    setGradient(db, nor, 1, redBlue);
    seedGenerator(db);
    seedGenerator(db);
    const g = listGradients(db);
    expect(g.find((x) => x.teamId === mar)!.gradients[3]).not.toBeNull();
    expect(g.find((x) => x.teamId === nor)!.gradients[1]).toEqual(redBlue);
    expect(g.find((x) => x.teamId === nor)!.gradients[2]).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM gen_templates').get()).toEqual({ n: STARTER_TEMPLATES.length });
  });

  it('moves first-guess starter elements to the Illustrator sizes once, leaving edited ones alone', () => {
    const { db } = gen();
    const old = (fileName: string, width: number, height: number, extra = {}) =>
      createTemplate(db, { ...STARTER_TEMPLATES[0], name: fileName, fileName, width, height, pattern: false, patternOpacity: 22, ...extra });
    old('panel_left', 944, 432, { pattern: true });
    old('bar_small', 320, 40);
    old('bar', 1000, 72);
    upgradeStarterTemplates(db);
    const by = Object.fromEntries(listTemplates(db).map((t) => [t.fileName, t]));
    expect(by.panel_left).toMatchObject({ width: 851, height: 390, radius: 35, pattern: true, patternOpacity: 10 });
    expect(by.bar_small).toMatchObject({ width: 289, height: 40, pattern: true, patternScale: 53.3 });
    expect(by.bar).toMatchObject({ width: 1000, height: 72 });
    updateTemplate(db, by.panel_left.id, { width: 900 });
    upgradeStarterTemplates(db);
    expect(listTemplates(db).find((t) => t.fileName === 'panel_left')!.width).toBe(900);
  });
});
