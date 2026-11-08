import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { setup } from './helpers.js';
import { applyGoldCup2026 } from '../src/services/presets.js';
import { applyTeamGraphics } from '../src/services/teamGraphics.js';
import { seedGenerator, createTemplate, listTemplates } from '../src/services/generator/generator.js';
import * as mb from '../src/services/matchboard/matchboard.js';
import { zipStore } from '../src/services/xlsx.js';

function board() {
  const s = setup();
  applyGoldCup2026(s.db);
  applyTeamGraphics(s.ctx);
  seedGenerator(s.db);
  mb.seedHighlightTemplate(s.db, (t) => createTemplate(s.db, t));
  return s;
}
const px = (png: PNG, x: number, y: number) => { const o = (y * png.width + x) * 4; return [...png.data.subarray(o, o + 4)]; };

describe('matchboard', () => {
  it('starts as the artwork: teams resolved by code, its highlights on, every text', () => {
    const { db } = board();
    const st = mb.getState(db);
    const layout = mb.loadLayout();
    expect(layout.slots).toHaveLength(112);
    const code = (id: string) => (db.prepare('SELECT code FROM teams WHERE id = ?').get(st.slots[id].teamId) as { code: string } | undefined)?.code;
    expect(code('qs-a-2')).toBe('MYA');
    expect(st.slots['qs-a-2'].highlight).toBe(true);
    expect(st.slots['qs-a-1'].highlight).toBe(false);
    expect(st.slots['r1-a-2']).toEqual({ teamId: null, text: 'DRAW 1', highlight: false });
    expect(st.texts['stage-1-32-finals-name']).toBe('1/32 Finals');
    expect(st.highlightTemplateId).toBe(listTemplates(db).find((t) => t.fileName === 'matchboard_team')!.id);
  });

  it('saves edits, rejects unknown rows and keeps defaults for the rest', () => {
    const { db } = board();
    const pol = (db.prepare("SELECT id FROM teams WHERE code = 'POL'").get() as { id: string }).id;
    mb.saveState(db, { slots: { 'r1-a-2': { teamId: pol, text: '', highlight: true } }, texts: { 'region-asia-name': 'Asia 2026' } });
    const st = mb.getState(db);
    expect(st.slots['r1-a-2']).toEqual({ teamId: pol, text: '', highlight: true });
    expect(st.texts['region-asia-name']).toBe('Asia 2026');
    expect(st.texts['region-europe-name']).toBe('Europe');
    expect(() => mb.saveState(db, { slots: { nope: { teamId: null, text: 'x', highlight: false } } })).toThrow(/Unknown/);
    expect(mb.resetState(db).texts['region-asia-name']).toBe('Asia');
  });

  it('draws the 1920×1080 board with flags and team-coloured highlights', async () => {
    const { db, ctx } = board();
    const ex = new mb.MatchboardExporter(ctx);
    const status = await ex.render();
    expect(status.exists).toBe(true);
    const png = PNG.sync.read(fs.readFileSync(ex.file));
    expect([png.width, png.height]).toEqual([1920, 1080]);
    expect(px(png, 10, 10)[3]).toBe(0); // transparent outside the card
    // MYA row is highlighted with its gradient (red → blue), PHI row above is not
    const mya = px(png, 452, 290), phi = px(png, 452, 262);
    expect(mya[0] + mya[2]).toBeGreaterThan(phi[0] + phi[2] - 200);
    expect(Math.abs(mya[0] - phi[0]) + Math.abs(mya[1] - phi[1]) + Math.abs(mya[2] - phi[2])).toBeGreaterThan(60);
    // a flag is drawn in the PHI row (the flag spot is not the plain row colour any more)
    const flag = px(png, 395, 262);
    expect(Math.abs(flag[0] - phi[0]) + Math.abs(flag[1] - phi[1]) + Math.abs(flag[2] - phi[2])).toBeGreaterThan(60);
  });

  it('accepts General Sans as OTF or as Fontshare’s uncompressed EOT', () => {
    const otf = Buffer.concat([Buffer.from('OTTO'), Buffer.alloc(60)]);
    expect(mb.fontFromUpload(otf, 'GeneralSans-Medium.otf')).toMatchObject({ ext: 'otf', weight: 500 });
    const head = Buffer.alloc(16);
    head.writeUInt32LE(16 + otf.length, 0); head.writeUInt32LE(otf.length, 4); head.writeUInt32LE(0x20001, 8); head.writeUInt32LE(0, 12);
    const eot = Buffer.concat([head, otf]);
    expect(mb.fontFromUpload(eot, 'GeneralSans-Bold.eot')).toEqual({ data: otf, ext: 'otf', weight: 700 });
    expect(() => mb.fontFromUpload(Buffer.from('hello world, not a font'), 'x.txt')).toThrow(/font file/);
    // a zip (stored entries) with two weights, an italic and a licence: only the upright weights
    const zip = zipStore([['GeneralSans/OTF/GeneralSans-Medium.otf', otf], ['GeneralSans/OTF/GeneralSans-MediumItalic.otf', otf], ['GeneralSans/OTF/GeneralSans-Semibold.otf', otf], ['License/FFL.txt', Buffer.from('x')]]);
    expect(mb.sansFontsFromUpload(zip, 'GeneralSans.zip').map((f) => f.weight).sort()).toEqual([500, 600]);
  });
});
