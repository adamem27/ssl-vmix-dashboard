import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { createTeam, updateTeam } from '../src/services/teams.js';
import { encodePng } from '../src/services/png.js';
import { inspectImage } from '../src/services/images.js';
import { DEFAULT_STROKE_GRADIENT, ElementSpec, neutralGradient, renderElement } from '../src/services/generator/render.js';
import {
  createTemplate, GeneratorExporter, getStrokeGradient, setStrokeGradient, listTemplates, upgradeStarterTemplates, jsonGraphics, listGradients, listOutputs, seedGenerator, setGradient, TEAM_GRADIENTS_SSL26, setGradientsFromColors, STARTER_TEMPLATES, updateTemplate, setNeutral, getNeutral, splitNeutralElements, deleteTemplate,
} from '../src/services/generator/generator.js';

const el = (p: Partial<ElementSpec> = {}): ElementSpec => ({
  width: 40, height: 20, radius: 0, opacity: 100, flip: false, angleOffset: 0, strokeWidth: 0, strokeColor: '#000000', strokeOpacity: 100, strokeGradient: false, strokeAngle: -45,
  pattern: false, patternOpacity: 0, patternScale: 100, ...p,
});
const px = (r: { width: number; data: Uint8ClampedArray }, x: number, y: number) => Array.from(r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4));
const redBlue = { angle: 0, stops: [{ pos: 0, color: '#ff0000', opacity: 100 }, { pos: 100, color: '#0000ff', opacity: 100 }] };

/** Team-only tests switch the neutral set off; it has its own test. */
function gen(neutral = false) {
  const s = setup();
  if (!neutral) setNeutral(s.db, { enabled: false });
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

  it('cuts corners straight across when the corner shape is cut', () => {
    const red = { angle: 0, stops: [{ pos: 0, color: '#ff0000', opacity: 100 }, { pos: 100, color: '#ff0000', opacity: 100 }] };
    const round = renderElement(el({ width: 40, height: 40, radius: 10 }), red);
    const cut = renderElement(el({ width: 40, height: 40, corner: 'cut', cutX: 10, cutY: 10 }), red);
    expect(px(cut, 0, 0)[3]).toBe(0);
    expect(px(cut, 4, 4)[3]).toBe(0); // beyond the 45° cut
    expect(px(round, 4, 4)[3]).toBeGreaterThan(0); // inside the rounded corner
    expect(px(cut, 6, 6)[3]).toBe(255);
    expect(px(cut, 10, 0)[3]).toBeGreaterThan(0); // the cut ends 10 px along the edge
    expect(px(cut, 20, 20)[3]).toBe(255);
  });

  it('makes a pointed end with rounded vertices (cut the full height on one side)', () => {
    const red = { angle: 0, stops: [{ pos: 0, color: '#ff0000', opacity: 100 }, { pos: 100, color: '#ff0000', opacity: 100 }] };
    const sharp = renderElement(el({ width: 100, height: 60, corner: 'cut', cutX: 30, cutY: 30, cutSides: 'right' }), red);
    const soft = renderElement(el({ width: 100, height: 60, corner: 'cut', cutX: 30, cutY: 30, cutSides: 'right', radius: 8 }), red);
    expect(px(sharp, 0, 0)[3]).toBe(255); // left end is not cut
    expect(px(soft, 0, 0)[3]).toBe(0); // …but its corner is rounded
    expect(px(sharp, 99, 30)[3]).toBeGreaterThan(100); // the point reaches the edge
    expect(px(soft, 99, 30)[3]).toBe(0); // rounded point stops short
    expect(px(soft, 90, 30)[3]).toBe(255);
    expect(px(sharp, 95, 5)[3]).toBe(0); // outside the slope
    expect(px(sharp, 60, 5)[3]).toBe(255);
  });

  it('paints the stroke with the stroke gradient along its own angle', () => {
    const greenBlue = { angle: 0, stops: [{ pos: 0, color: '#00ff00', opacity: 100 }, { pos: 100, color: '#0000ff', opacity: 100 }] };
    const spec = el({ width: 100, height: 20, strokeWidth: 2, strokeColor: '#ffffff', strokeGradient: true, strokeAngle: 0 });
    const r = renderElement(spec, redBlue, 1, greenBlue);
    expect(px(r, 1, 10)[1]).toBeGreaterThan(240);
    expect(px(r, 98, 10)[2]).toBeGreaterThan(240);
    expect(px(r, 50, 10)[0]).toBeGreaterThan(100); // the fill inside is untouched
    const turned = renderElement({ ...spec, strokeAngle: 180 }, redBlue, 1, greenBlue);
    expect(px(turned, 1, 10)[2]).toBeGreaterThan(240);
    // without the checkbox the plain stroke colour is used
    expect(px(renderElement({ ...spec, strokeGradient: false }, redBlue, 1, greenBlue), 1, 10)).toEqual([255, 255, 255, 255]);
    // stop opacity fades the stroke
    const fade = { angle: 0, stops: [{ pos: 0, color: '#00ff00', opacity: 0 }, { pos: 100, color: '#00ff00', opacity: 100 }] };
    const clear = { angle: 0, stops: [{ pos: 0, color: '#ff0000', opacity: 0 }, { pos: 100, color: '#ff0000', opacity: 0 }] };
    const f = renderElement(spec, clear, 1, fade);
    expect(px(f, 0, 10)[3]).toBeLessThan(10);
    expect(px(f, 99, 10)[3]).toBeGreaterThan(240);
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
    const file = path.join(ctx.assetsDir, 'PNG generator', 'POL', 'POL_bar.png');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(ctx.assetsDir, 'PNG generator', 'POL', 'POL_panel_left.png'))).toBe(true);
    expect(fs.existsSync(path.join(ctx.assetsDir, 'PNG generator', 'XXX'))).toBe(false);
    expect(inspectImage(fs.readFileSync(file))?.width).toBe(50);
    expect(listOutputs(db)).toHaveLength(2);

    const before = fs.statSync(file).mtimeMs;
    const panelFile = path.join(ctx.assetsDir, 'PNG generator', 'POL', 'POL_panel_left.png');
    const panelBefore = fs.readFileSync(panelFile);
    updateTemplate(db, panel.id, { radius: 6 });
    exporter.flush();
    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(fs.readFileSync(panelFile).equals(panelBefore)).toBe(false);

    updateTemplate(db, bar.id, { fileName: 'strip' });
    updateTeam(db, pol, { code: 'PL' });
    exporter.flush();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(ctx.assetsDir, 'PNG generator', 'POL'))).toBe(false);
    expect(fs.existsSync(path.join(ctx.assetsDir, 'PNG generator', 'PL', 'PL_strip.png'))).toBe(true);
  });

  it('renders the neutral set: every element black with the orange → yellow stroke, and lists it in /json/graphics', () => {
    const { db, ctx, exporter } = gen(true);
    expect(getNeutral(db)).toEqual({ enabled: true, color: '#1a1a1a', opacity: 80, strokeWidth: 1 });
    const pol = createTeam(db, { name: 'Poland', code: 'POL' });
    setGradient(db, pol, 1, redBlue);
    createTemplate(db, { ...STARTER_TEMPLATES[0], width: 40, height: 20, pattern: false, scope: 'neutral' });
    createTemplate(db, { ...STARTER_TEMPLATES[0], fileName: 'team_bar', width: 40, height: 20, pattern: false });
    exporter.flush();
    // each element is made only in its own colours
    expect(listOutputs(db).map((o) => o.rel).sort()).toEqual(['PNG generator/NEUTRAL/NEUTRAL_bar.png', 'PNG generator/POL/POL_team_bar.png']);
    const both = createTemplate(db, { ...STARTER_TEMPLATES[0], fileName: 'both_bar', width: 40, height: 20, pattern: false, scope: 'both' });
    exporter.flush();
    expect(listOutputs(db).map((o) => o.rel).filter((r) => r.includes('both_bar')).sort()).toEqual(['PNG generator/NEUTRAL/NEUTRAL_both_bar.png', 'PNG generator/POL/POL_both_bar.png']);
    deleteTemplate(db, both.id);
    db.prepare("DELETE FROM teams").run();
    exporter.flush();
    const file = path.join(ctx.assetsDir, 'PNG generator', 'NEUTRAL', 'NEUTRAL_bar.png');
    expect(fs.existsSync(file)).toBe(true);
    expect(listOutputs(db).map((o) => o.teamId)).toEqual(['neutral']);
    expect(jsonGraphics(db, ctx.assetsDir).map((r) => r.code)).toEqual(['NEUTRAL']);
    expect(jsonGraphics(db, ctx.assetsDir)[0].team_bar).toBe('');
    // the job draws black inside and the gradient stroke at the corner
    const job = listOutputs(db)[0];
    expect(job.rel).toBe('PNG generator/NEUTRAL/NEUTRAL_bar.png');
    const r = renderElement({ ...el({ width: 40, height: 20 }), strokeWidth: 1, strokeGradient: true }, { angle: 0, stops: [{ pos: 0, color: '#000000', opacity: 100 }, { pos: 100, color: '#000000', opacity: 100 }] }, 1, DEFAULT_STROKE_GRADIENT);
    expect(px(r, 20, 10)).toEqual([0, 0, 0, 255]);
    const see = renderElement(el({ width: 40, height: 20 }), neutralGradient('#1a1a1a', 80));
    expect(px(see, 20, 10)).toEqual([26, 26, 26, 204]);
    expect(Math.max(...[[0, 0], [39, 0], [0, 19], [39, 19]].map(([x, y]) => px(r, x, y)[0]))).toBeGreaterThan(200);
    setNeutral(db, { enabled: false });
    exporter.flush();
    expect(fs.existsSync(file)).toBe(false);
    expect(jsonGraphics(db, ctx.assetsDir)).toEqual([]);
  });

  it('makes elements named neutral neutral-only, once', () => {
    const { db } = gen(true);
    createTemplate(db, { ...STARTER_TEMPLATES[0] });
    const n = createTemplate(db, { ...STARTER_TEMPLATES[0], name: 'Bar neutral', fileName: 'bar_n' });
    splitNeutralElements(db);
    expect(listTemplates(db).map((t) => [t.fileName, t.scope])).toEqual([['bar', 'teams'], ['bar_n', 'neutral']]);
    updateTemplate(db, n.id, { scope: 'teams' });
    splitNeutralElements(db);
    expect(listTemplates(db).find((t) => t.id === n.id)?.scope).toBe('teams');
  });

  it('starts the gradient on any side: left, right, top or bottom', () => {
    const square = (gradientFrom: ElementSpec['gradientFrom']) => renderElement(el({ width: 20, height: 20, gradientFrom }), redBlue);
    const red = (r: { width: number; data: Uint8ClampedArray }, x: number, y: number) => px(r, x, y)[0];
    expect(red(square('left'), 0, 10)).toBeGreaterThan(200);
    expect(red(square('right'), 19, 10)).toBeGreaterThan(200);
    expect(red(square('top'), 10, 0)).toBeGreaterThan(200);
    expect(red(square('top'), 10, 19)).toBeLessThan(50);
    expect(red(square('bottom'), 10, 19)).toBeGreaterThan(200);
    // flip without a side still means right
    expect(red(renderElement(el({ width: 20, height: 20, flip: true }), redBlue), 19, 10)).toBeGreaterThan(200);
  });

  it('skips elements whose gradient version the team has not set', () => {
    const { db, exporter } = gen();
    const t = createTeam(db, { name: 'Poland', code: 'POL' });
    createTemplate(db, { ...STARTER_TEMPLATES[0], width: 10, height: 10 });
    createTemplate(db, { ...STARTER_TEMPLATES[3], width: 10, height: 10 });
    setGradient(db, t, 1, redBlue);
    exporter.flush();
    expect(listOutputs(db).map((o) => o.rel)).toEqual(['PNG generator/POL/POL_bar.png']);
  });

  it('lists vMix paths per team in the Graphics sheet', () => {
    const { db, ctx, exporter } = gen();
    const t = createTeam(db, { name: 'Poland', code: 'POL' });
    createTemplate(db, { ...STARTER_TEMPLATES[0], width: 10, height: 10 });
    setGradient(db, t, 1, redBlue);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('paths.vmixAssetsRoot', 'C:\\SSL-vMix')").run();
    expect(jsonGraphics(db, ctx.assetsDir)[0].bar).toBe('');
    exporter.flush();
    expect(jsonGraphics(db, ctx.assetsDir)).toEqual([{ code: 'POL', name: 'Poland', bar: 'C:\\SSL-vMix\\PNG generator\\POL\\POL_bar.png' }]);
  });

  it('colours the Panam teams once, also when they are added later', async () => {
    const { applyPanamColours, TEAM_GRADIENTS_PANAM } = await import('../src/services/generator/generator.js');
    const { db } = gen();
    const cub = createTeam(db, { name: 'Cuba', code: 'CUB' });
    setGradient(db, cub, 1, redBlue);
    expect(applyPanamColours(db)).toBe(1);
    const g = listGradients(db).find((x) => x.teamId === cub)!.gradients;
    expect(g[1]).toEqual({ angle: -20, stops: TEAM_GRADIENTS_PANAM.CUB.map(([pos, color]) => ({ pos, color, opacity: 100 })) });
    expect(g[2]).not.toBeNull(); expect(g[3]).not.toBeNull();
    setGradient(db, cub, 1, redBlue); // an edit afterwards stays
    const ant = createTeam(db, { name: 'Antigua and Barbuda', code: 'ANT' });
    expect(applyPanamColours(db)).toBe(1);
    expect(listGradients(db).find((x) => x.teamId === cub)!.gradients[1]).toEqual(redBlue);
    expect(listGradients(db).find((x) => x.teamId === ant)!.gradients[1]!.stops.map((s) => s.color)).toEqual(['#001f57', '#e4332a', '#f8b400']);
  });

  it('fills empty team graphic places from the generated PNGs and leaves choices of the operator alone', async () => {
    const { fillTeamSlotsFromGenerator } = await import('../src/services/generatedSlots.js');
    const { listAssets, removeAsset, saveUpload } = await import('../src/services/assets.js');
    const { PNG } = await import('pngjs');
    const { db, ctx, exporter } = gen();
    const t = createTeam(db, { name: 'Poland', code: 'POL' });
    const u = createTeam(db, { name: 'Chile', code: 'CHI' });
    for (const f of ['panel_left', 'square']) createTemplate(db, { ...STARTER_TEMPLATES.find((x) => x.fileName === f)!, width: 10, height: 10, variant: 1 });
    setGradient(db, t, 1, redBlue); setGradient(db, u, 1, redBlue);
    saveUpload(ctx, 'team', u, 'background_2', PNG.sync.write(new PNG({ width: 2, height: 2 })), 'own.png');
    exporter.flush();
    expect(fillTeamSlotsFromGenerator(ctx)).toBe(3);
    const a = listAssets(ctx, 'team', t);
    expect(a.background_1.enteredPath).toBe(path.join(ctx.assetsDir, 'PNG generator', 'POL', 'POL_panel_left.png'));
    expect(a.background_1.checkStatus).toBe('reachable');
    expect(listAssets(ctx, 'team', u).background_2.storageKind).toBe('upload'); // the operator's own file stays
    expect(fillTeamSlotsFromGenerator(ctx)).toBe(0);
    // a vMix folder set later moves the filled paths to it
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('paths.vmixAssetsRoot', 'C:\\SSL-vMix')").run();
    expect(fillTeamSlotsFromGenerator(ctx)).toBe(3);
    expect(listAssets(ctx, 'team', t).background_1.vmixPath).toBe('C:\\SSL-vMix\\PNG generator\\POL\\POL_panel_left.png');
    // a place the operator cleared stays empty
    removeAsset(ctx, 'team', t, 'background_1');
    expect(fillTeamSlotsFromGenerator(ctx)).toBe(0);
    expect(listAssets(ctx, 'team', t).background_1).toBeUndefined();
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

  it('gives the starter panels the gradient stroke once, and re-renders when the stroke gradient changes', () => {
    const { db, ctx, exporter } = gen();
    const pol = createTeam(db, { name: 'Poland', code: 'POL' });
    setGradientsFromColors(db, pol, ['#ff0000', '#ffffff']);
    const panel = createTemplate(db, { ...STARTER_TEMPLATES[1], strokeWidth: 0, strokeGradient: false, width: 40, height: 20 });
    createTemplate(db, { ...STARTER_TEMPLATES[0], width: 10, height: 10 });
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('generator.templatesFromAi', 'true')").run();
    upgradeStarterTemplates(db);
    const by = Object.fromEntries(listTemplates(db).map((t) => [t.fileName, t]));
    expect(by.panel_left).toMatchObject({ strokeWidth: 1, strokeGradient: true, strokeAngle: -45 });
    expect(by.bar).toMatchObject({ strokeWidth: 0, strokeGradient: false });
    updateTemplate(db, panel.id, { strokeWidth: 0 });
    upgradeStarterTemplates(db);
    expect(listTemplates(db).find((t) => t.id === panel.id)!.strokeWidth).toBe(0);

    updateTemplate(db, panel.id, { strokeWidth: 2 });
    exporter.flush();
    const file = path.join(ctx.assetsDir, 'PNG generator', 'POL', 'POL_panel_left.png');
    const bar = path.join(ctx.assetsDir, 'PNG generator', 'POL', 'POL_bar.png');
    const [before, barBefore] = [fs.readFileSync(file), fs.statSync(bar).mtimeMs];
    expect(getStrokeGradient(db)).toEqual(DEFAULT_STROKE_GRADIENT);
    setStrokeGradient(db, { angle: 0, stops: [{ pos: 0, color: '#ff00ff', opacity: 100 }, { pos: 100, color: '#ff00ff', opacity: 100 }] });
    exporter.flush();
    expect(fs.readFileSync(file).equals(before)).toBe(false);
    expect(fs.statSync(bar).mtimeMs).toBe(barBefore);
    setStrokeGradient(db, null);
    expect(getStrokeGradient(db)).toEqual(DEFAULT_STROKE_GRADIENT);
  });

  it('applies the SSL26 team colours and orange stroke once, replacing the old green stroke', () => {
    const { db } = gen();
    const pol = createTeam(db, { name: 'Poland', code: 'POL' });
    const mar = createTeam(db, { name: 'Morocco', code: 'MAR' });
    setGradient(db, pol, 1, redBlue);
    setStrokeGradient(db, { angle: -45, stops: [{ pos: 0, color: '#00b15e', opacity: 100 }, { pos: 100, color: '#0085e6', opacity: 100 }] });
    seedGenerator(db);
    const g = listGradients(db).find((x) => x.teamId === pol)!.gradients;
    expect(g[1]).toEqual({ angle: -20, stops: TEAM_GRADIENTS_SSL26.POL.map(([pos, color]) => ({ pos, color, opacity: 100 })) });
    expect(g[2]!.stops[0]).toEqual({ pos: 0, color: '#dbdbdb', opacity: 0 });
    expect(g[3]!.stops.at(-1)).toEqual({ pos: 100, color: '#da153d', opacity: 0 });
    expect(listGradients(db).find((x) => x.teamId === mar)!.gradients[1]).not.toBeNull(); // board starter colours still apply
    expect(getStrokeGradient(db)).toEqual(DEFAULT_STROKE_GRADIENT);

    // later edits are kept on the next start
    setGradient(db, pol, 1, redBlue);
    seedGenerator(db);
    expect(listGradients(db).find((x) => x.teamId === pol)!.gradients[1]).toEqual(redBlue);
  });
});
