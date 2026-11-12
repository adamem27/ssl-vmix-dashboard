/**
 * Pictures made for Team comparison, next to the team's own files (which stay as they are):
 *  - the flag on a 401×401 transparent square, the size of the emblems drawn in the same box (the title's FLAG
 *    element shows a flag or an emblem, so both need the same canvas): team-comparison/<CODE>_flag_comparison.png
 * It is made again only when the flag file is newer. Pictures uploaded on the Team comparison tab go to team-comparison/uploads/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { getSetting } from '../db/db.js';
import { AssetCtx } from './assets.js';
import { decode, resample, trimBox } from './logo.js';
import { joinVmixPath } from './paths.js';

export const COMPARE_DIR = 'team-comparison';
/** Canvas and the flag's largest size on it (emblem boxes in the SSL26 comparison title: 401×401, emblem ≈ 321 wide). */
const SIDE = 401;
const FLAG_W = 321, FLAG_H = 230;

/** The file on this computer for a path the dashboard gives vMix (stored assets: the vMix root swapped for the assets folder). */
export function localOf(ctx: AssetCtx, p: string): string | null {
  if (!p) return null;
  const root = getSetting(ctx.db, 'paths.vmixAssetsRoot');
  if (root && p.toLowerCase().startsWith(root.toLowerCase())) {
    const rest = p.slice(root.length).split(/[\\/]+/).filter(Boolean);
    const f = path.join(ctx.assetsDir, ...rest);
    if (fs.existsSync(f)) return f;
  }
  return fs.existsSync(p) ? p : null;
}

const vmixOf = (ctx: AssetCtx, rel: string) => {
  const root = getSetting(ctx.db, 'paths.vmixAssetsRoot');
  return root ? joinVmixPath(root, rel) : path.join(ctx.assetsDir, ...rel.split('/'));
};

/** Writes `rel` from `src` with `make` unless it is already newer than the source; the path for vMix, or null. */
function made(ctx: AssetCtx, src: string, rel: string, make: (buf: Buffer) => Buffer): string | null {
  const out = path.join(ctx.assetsDir, ...rel.split('/'));
  try {
    const s = fs.statSync(src);
    const o = fs.existsSync(out) ? fs.statSync(out) : null;
    if (!o || o.mtimeMs < s.mtimeMs) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const tmp = `${out}.tmp`;
      fs.writeFileSync(tmp, make(fs.readFileSync(src)));
      fs.renameSync(tmp, out);
    }
    return vmixOf(ctx, rel);
  } catch {
    return null;
  }
}

/** The flag trimmed and centred on the 401×401 square, at most FLAG_W × FLAG_H. */
export function comparisonFlagPng(buf: Buffer): Buffer {
  const img = decode(buf);
  const box = trimBox(img);
  const s = Math.min(FLAG_W / box.w, FLAG_H / box.h);
  const ow = Math.max(1, Math.round(box.w * s)), oh = Math.max(1, Math.round(box.h * s));
  const pix = resample(img, box, ow, oh);
  const out = new PNG({ width: SIDE, height: SIDE });
  out.data.fill(0);
  const ox = Math.floor((SIDE - ow) / 2), oy = Math.floor((SIDE - oh) / 2);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const i = (y * ow + x) * 4, o = ((y + oy) * SIDE + x + ox) * 4;
    for (let c = 0; c < 4; c++) out.data[o + c] = Math.max(0, Math.min(255, Math.round(pix[i + c])));
  }
  return PNG.sync.write(out, { colorType: 6 });
}

/** The team's comparison flag made from its flag file (vMix path); the original path when it cannot be read here. */
export function comparisonFlag(ctx: AssetCtx, code: string, flagPath: string): string {
  const src = localOf(ctx, flagPath);
  if (!src) return flagPath;
  return made(ctx, src, `${COMPARE_DIR}/${code.replace(/[^\w.-]+/g, '_')}_flag_comparison.png`, comparisonFlagPng) ?? flagPath;
}
