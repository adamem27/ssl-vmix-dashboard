import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.js';
import { createTeam } from '../src/services/teams.js';
import { saveUpload, savePath, listAssets, previewFile } from '../src/services/assets.js';
import { encodePng } from '../src/services/png.js';
import { setSetting } from '../src/db/db.js';

const png = encodePng(10, 6, () => [255, 0, 0, 128]);

describe('assets', () => {
  it('stores uploads under unique names so identical filenames never overwrite another team', () => {
    const { db, ctx } = setup();
    const a = createTeam(db, { name: 'A', code: 'AAA' });
    const b = createTeam(db, { name: 'B', code: 'BBB' });
    const fa = saveUpload(ctx, 'team', a, 'flag_small', png, 'flag.png');
    const fb = saveUpload(ctx, 'team', b, 'flag_small', png, 'flag.png');
    expect(fa.storedPath).not.toBe(fb.storedPath);
    expect(fs.existsSync(fa.storedPath!)).toBe(true);
    expect(fa).toMatchObject({ width: 10, height: 6, checkStatus: 'stored', originalFilename: 'flag.png' });
    // Replacing removes the old stored file of that slot only.
    const fa2 = saveUpload(ctx, 'team', a, 'flag_small', png, 'flag.png');
    expect(fs.existsSync(fa.storedPath!)).toBe(false);
    expect(fs.existsSync(fa2.storedPath!)).toBe(true);
    expect(fs.existsSync(fb.storedPath!)).toBe(true);
  });

  it('rejects files that are not PNG for team slots', () => {
    const { db, ctx } = setup();
    const a = createTeam(db, { name: 'A', code: 'AAA' });
    expect(() => saveUpload(ctx, 'team', a, 'flag_small', Buffer.from('GIF89a....'), 'x.gif')).toThrow(/PNG/);
    expect(() => saveUpload(ctx, 'team', a, 'nope', png, 'x.png')).toThrow(/slot/);
  });

  it('keeps unreachable Windows/UNC paths as unverified without a preview', () => {
    const { db, ctx } = setup();
    const a = createTeam(db, { name: 'A', code: 'AAA' });
    const r = savePath(ctx, 'team', a, 'flag_big', '\\\\VMIX-PC\\grafiki\\AAA\\flag_big.png');
    expect(r).toMatchObject({ checkStatus: 'unverified', previewUrl: null, vmixPath: '\\\\VMIX-PC\\grafiki\\AAA\\flag_big.png' });
    expect(() => savePath(ctx, 'team', a, 'flag_big', 'flag.png')).toThrow(/absolute/);
    expect(() => savePath(ctx, 'team', a, 'flag_big', 'D:\\SSL\\flag.jpg')).toThrow(/PNG/);
  });

  it('maps the vMix assets root back to the local store for previews and builds vMix paths for uploads', () => {
    const { db, ctx } = setup();
    setSetting(db, 'paths.vmixAssetsRoot', '\\\\DASHBOARD\\ssl-assets');
    const a = createTeam(db, { name: 'A', code: 'AAA' });
    const up = saveUpload(ctx, 'team', a, 'flag_small', png, 'flag.png');
    const rel = path.relative(ctx.assetsDir, up.storedPath!);
    expect(up.vmixPath).toBe('\\\\DASHBOARD\\ssl-assets\\' + rel.split(path.sep).join('\\'));
    const viaPath = savePath(ctx, 'team', a, 'emblem_dark', up.vmixPath!);
    expect(viaPath.checkStatus).toBe('reachable');
    expect(previewFile(ctx, viaPath.id)).not.toBeNull();
    expect(Object.keys(listAssets(ctx, 'team', a)).sort()).toEqual(['emblem_dark', 'flag_small']);
  });
});
