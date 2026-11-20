import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { getSetting, setSetting } from '../db/db.js';
import { badRequest } from './errors.js';
import { joinVmixPath } from './paths.js';
/**
 * L-BAR SWITCH pictures, kept by the dashboard (vMix does not take back the path of a picture packed in a title):
 * the two looks of the L-bar uploaded on Show control, the first look whole (the title's L-bar picture) and, from
 * the second, only what differs from the first (the Swap picture), so the L-bar stays and only those parts fade.
 */
export const LBAR_DIR = 'L-bar switch';
const KEY = 'lbarSwap.files';
export const SWAP_EMPTY = 'lbar_swap_empty.png';
const dir = (ctx) => path.join(ctx.assetsDir, LBAR_DIR);
const lookFile = (ctx, n) => path.join(dir(ctx), `look${n}.png`);
const vmixPath = (ctx, name) => {
    const root = getSetting(ctx.db, 'paths.vmixAssetsRoot');
    return root ? joinVmixPath(root, `${LBAR_DIR}/${name}`) : path.join(dir(ctx), name);
};
function stored(ctx) {
    try {
        const s = JSON.parse(getSetting(ctx.db, KEY) || 'null');
        return s && s.base && s.swap ? s : null;
    }
    catch {
        return null;
    }
}
/** One of the two looks uploaded (a PNG of the whole frame); the pictures for vMix are made again when both are there. */
export function saveLook(ctx, n, buf) {
    let png;
    try {
        png = PNG.sync.read(buf);
    }
    catch {
        throw badRequest('The L-bar must be a PNG (with its transparent part).');
    }
    fs.mkdirSync(dir(ctx), { recursive: true });
    fs.writeFileSync(lookFile(ctx, n), PNG.sync.write(png, { colorType: 6 }));
    return rebuild(ctx);
}
/** The second look minus the first: its pixels where they differ (and 2 px around), transparent elsewhere. */
export function swapPixels(a, b) {
    const { width: w, height: h } = a;
    const diff = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
        const o = i * 4;
        if (Math.abs(a.data[o] - b.data[o]) > 2 || Math.abs(a.data[o + 1] - b.data[o + 1]) > 2 || Math.abs(a.data[o + 2] - b.data[o + 2]) > 2 || Math.abs(a.data[o + 3] - b.data[o + 3]) > 2)
            diff[i] = 1;
    }
    // grow the mask by 2 px (rows, then columns) so no edge of a changed part is left out
    const R = 2, rows = new Uint8Array(w * h), mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            if (!diff[y * w + x])
                continue;
            for (let d = -R; d <= R; d++) {
                const xx = x + d;
                if (xx >= 0 && xx < w)
                    rows[y * w + xx] = 1;
            }
        }
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            if (!rows[y * w + x])
                continue;
            for (let d = -R; d <= R; d++) {
                const yy = y + d;
                if (yy >= 0 && yy < h)
                    mask[yy * w + x] = 1;
            }
        }
    const out = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++)
        if (mask[i])
            b.data.copy(out, i * 4, i * 4, i * 4 + 4);
    return out;
}
function rebuild(ctx) {
    const f1 = lookFile(ctx, 1), f2 = lookFile(ctx, 2);
    if (!fs.existsSync(f1) || !fs.existsSync(f2))
        return status(ctx);
    const b1 = fs.readFileSync(f1), b2 = fs.readFileSync(f2);
    const a = PNG.sync.read(b1), b = PNG.sync.read(b2);
    if (a.width !== b.width || a.height !== b.height)
        throw badRequest(`The two looks must be the same size (${a.width}×${a.height} and ${b.width}×${b.height}).`);
    // names change with the pictures: vMix reloads a picture only when its path changes
    const h = createHash('sha1').update(b1).update(b2).digest('hex').slice(0, 8);
    const base = `lbar_look1_${h}.png`, swap = `lbar_swap_${h}.png`;
    const old = stored(ctx);
    const out = new PNG({ width: a.width, height: a.height });
    out.data = swapPixels(a, b);
    fs.copyFileSync(f1, path.join(dir(ctx), base));
    fs.writeFileSync(path.join(dir(ctx), swap), PNG.sync.write(out, { colorType: 6 }));
    if (old && old.base !== base)
        for (const x of [old.base, old.swap]) {
            try {
                fs.unlinkSync(path.join(dir(ctx), x));
            }
            catch { /* gone */ }
        }
    setSetting(ctx.db, KEY, JSON.stringify({ base, swap, width: a.width, height: a.height, changed: Date.now() }));
    return status(ctx);
}
/** The pictures as vMix reads them, or null until both looks are uploaded. */
export function lbarFiles(ctx) {
    const s = stored(ctx);
    if (!s || !fs.existsSync(path.join(dir(ctx), s.base)) || !fs.existsSync(path.join(dir(ctx), s.swap)))
        return null;
    const empty = path.join(dir(ctx), SWAP_EMPTY);
    if (!fs.existsSync(empty))
        fs.writeFileSync(empty, PNG.sync.write(new PNG({ width: 8, height: 8 }), { colorType: 6 }));
    return { base: vmixPath(ctx, s.base), swap: vmixPath(ctx, s.swap), empty: vmixPath(ctx, SWAP_EMPTY) };
}
export function status(ctx) {
    const s = stored(ctx);
    return { look1: fs.existsSync(lookFile(ctx, 1)), look2: fs.existsSync(lookFile(ctx, 2)), ready: !!lbarFiles(ctx), size: s ? `${s.width}×${s.height}` : '', changed: s?.changed ?? 0 };
}
/** An uploaded look, for its preview on Show control. */
export function lookPicture(ctx, n) {
    try {
        return fs.readFileSync(lookFile(ctx, n));
    }
    catch {
        return null;
    }
}
/** The same picture whatever the path looks like (vMix may write it back with other slashes or case). */
export const samePicture = (a, b) => {
    const n = (x) => x.replace(/\\/g, '/').split('/').pop().toLowerCase();
    return !!a && !!b && n(a) === n(b);
};
