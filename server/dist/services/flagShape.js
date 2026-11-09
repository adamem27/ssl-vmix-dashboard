import { PNG } from 'pngjs';
import { decode } from './logo.js';
/**
 * Flags are never square on air: every file in a team's flag slot gets rounded, transparent corners, as in the
 * SSL26 designs (corner ≈ 18 % of the flag height: 6 px on the 48×32 results flag, 14 px on the 120×80 lower third).
 */
export const FLAG_SLOTS = ['flag_small', 'flag_big'];
export const FLAG_RADIUS = 0.18;
const alphaAt = (d, w, x, y) => d[(y * w + x) * 4 + 3];
/** True when the corners are already cut (transparent corner, opaque middle of the edges). */
export function isRounded(buf) {
    const { width: w, height: h, data } = decode(buf);
    if (w < 4 || h < 4)
        return false;
    const corners = [alphaAt(data, w, 0, 0), alphaAt(data, w, w - 1, 0), alphaAt(data, w, 0, h - 1), alphaAt(data, w, w - 1, h - 1)];
    return corners.every((a) => a < 16) && alphaAt(data, w, w >> 1, 0) > 200 && alphaAt(data, w, 0, h >> 1) > 200;
}
/** PNG of the flag with rounded, anti-aliased corners. A flag that is already rounded comes back unchanged. */
export function roundFlag(buf, ratio = FLAG_RADIUS) {
    if (isRounded(buf))
        return buf;
    const { width: w, height: h, data } = decode(buf);
    const r = Math.max(1, ratio * h);
    const out = new PNG({ width: w, height: h });
    out.data.set(data.subarray(0, w * h * 4));
    const S = 4; // 4×4 samples per edge pixel
    const cover = (x, y) => {
        // distance test against the nearest corner circle; pixels away from the corners are fully covered
        const cx = x < r ? r : x > w - 1 - r ? w - r : -1;
        const cy = y < r ? r : y > h - 1 - r ? h - r : -1;
        if (cx < 0 || cy < 0)
            return 1;
        let n = 0;
        for (let i = 0; i < S; i++)
            for (let j = 0; j < S; j++) {
                const px = x + (i + 0.5) / S, py = y + (j + 0.5) / S;
                const dx = px - cx, dy = py - cy;
                if ((x < r ? px > cx : px < cx) || (y < r ? py > cy : py < cy) || dx * dx + dy * dy <= r * r)
                    n++;
            }
        return n / (S * S);
    };
    const R = Math.ceil(r) + 1;
    for (let y = 0; y < h; y++) {
        if (y >= R && y < h - R)
            continue;
        for (let x = 0; x < w; x++) {
            if (x >= R && x < w - R)
                continue;
            const c = cover(x, y);
            if (c < 1) {
                const o = (y * w + x) * 4 + 3;
                out.data[o] = Math.round(out.data[o] * c);
            }
        }
    }
    return PNG.sync.write(out, { colorType: 6 });
}
