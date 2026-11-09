import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { badRequest } from './errors.js';

/**
 * Sponsor logos arrive in every shape and size. Each one is redrawn onto the same transparent canvas so
 * they read as the same size side by side in vMix: trimmed to its visible edges, scaled so the trimmed box
 * has the same area for every logo (wide logos get wider, tall ones taller), capped by the canvas margins, centred.
 */
export const LOGO_CANVAS = { width: 800, height: 400 };
/** Side of the square with the same area as every trimmed logo (300 px → a square logo is 300×300). */
const LOGO_SIDE = 300;
const MAX_W = 760;
const MAX_H = 360;

interface Rgba { width: number; height: number; data: Uint8Array }

export function decode(buf: Buffer): Rgba {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
    const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    return { width: j.width, height: j.height, data: j.data };
  }
  throw badRequest('Images must be PNG or JPG.');
}

const px = (img: Rgba, x: number, y: number) => (y * img.width + x) * 4;

/**
 * Logos without transparency (JPG, or a PNG on a solid colour): the colour around the edge is the
 * background. It is cut away where it touches the edge, so letters with the same colour inside stay.
 */
function clearSolidBackground(img: Rgba) {
  const { width: w, height: h, data: d } = img;
  const corners = [px(img, 0, 0), px(img, w - 1, 0), px(img, 0, h - 1), px(img, w - 1, h - 1)];
  if (corners.some((o) => d[o + 3] < 250)) return; // already transparent around the edge
  const bg = [0, 1, 2].map((c) => corners.map((o) => d[o + c]).sort((a, b) => a - b)[1]);
  const near = (o: number) => Math.abs(d[o] - bg[0]) + Math.abs(d[o + 1] - bg[1]) + Math.abs(d[o + 2] - bg[2]);
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => { const i = y * w + x; if (!seen[i]) { seen[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const i = stack.pop()!;
    const o = i * 4;
    const dist = near(o);
    if (dist > 60) continue;
    // soft edge: pixels part-way to the logo colour keep part of their alpha
    d[o + 3] = dist <= 24 ? 0 : Math.round((d[o + 3] * (dist - 24)) / 36);
    if (dist > 24) continue;
    const x = i % w, y = (i - x) / w;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
}

function trimBox(img: Rgba) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[px(img, x, y) + 3] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0) throw badRequest('This logo is empty (fully transparent or a single colour).');
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Area-averaging resample of a box of the source (premultiplied alpha, so edges don't get dark fringes). */
function resample(src: Rgba, box: { x0: number; y0: number; w: number; h: number }, ow: number, oh: number): Float32Array {
  const out = new Float32Array(ow * oh * 4);
  const sx = box.w / ow, sy = box.h / oh;
  for (let oy = 0; oy < oh; oy++) {
    const fy0 = box.y0 + oy * sy, fy1 = fy0 + sy;
    for (let ox = 0; ox < ow; ox++) {
      const fx0 = box.x0 + ox * sx, fx1 = fx0 + sx;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      if (sx < 1 && sy < 1) {
        // enlarging: bilinear
        const cx = Math.min(Math.max((fx0 + fx1) / 2 - 0.5, box.x0), box.x0 + box.w - 1), cy = Math.min(Math.max((fy0 + fy1) / 2 - 0.5, box.y0), box.y0 + box.h - 1);
        const xa = Math.floor(cx), ya = Math.floor(cy), xb = Math.min(xa + 1, box.x0 + box.w - 1), yb = Math.min(ya + 1, box.y0 + box.h - 1);
        const tx = cx - xa, ty = cy - ya;
        for (const [x, y, wt] of [[xa, ya, (1 - tx) * (1 - ty)], [xb, ya, tx * (1 - ty)], [xa, yb, (1 - tx) * ty], [xb, yb, tx * ty]] as const) {
          const o = px(src, x, y), al = src.data[o + 3] / 255;
          r += src.data[o] * al * wt; g += src.data[o + 1] * al * wt; b += src.data[o + 2] * al * wt; a += al * wt; wsum += wt;
        }
      } else {
        for (let y = Math.floor(fy0); y < Math.ceil(fy1); y++) {
          const wy = Math.min(fy1, y + 1) - Math.max(fy0, y);
          if (wy <= 0 || y >= box.y0 + box.h) continue;
          for (let x = Math.floor(fx0); x < Math.ceil(fx1); x++) {
            const wx = Math.min(fx1, x + 1) - Math.max(fx0, x);
            if (wx <= 0 || x >= box.x0 + box.w) continue;
            const wt = wx * wy, o = px(src, x, y), al = src.data[o + 3] / 255;
            r += src.data[o] * al * wt; g += src.data[o + 1] * al * wt; b += src.data[o + 2] * al * wt; a += al * wt; wsum += wt;
          }
        }
      }
      const i = (oy * ow + ox) * 4;
      if (wsum > 0 && a > 0) { out[i] = r / a; out[i + 1] = g / a; out[i + 2] = b / a; out[i + 3] = (a / wsum) * 255; }
    }
  }
  return out;
}

/** Any PNG/JPG logo → an 800×400 transparent PNG with the logo trimmed, evened out in size and centred. */
export function normalizeLogo(buf: Buffer): Buffer {
  const img = decode(buf);
  if (img.width * img.height > 40_000_000) throw badRequest('This logo is too large (over 40 megapixels).');
  clearSolidBackground(img);
  const box = trimBox(img);
  const s = Math.min(LOGO_SIDE / Math.sqrt(box.w * box.h), MAX_W / box.w, MAX_H / box.h);
  const ow = Math.max(1, Math.round(box.w * s)), oh = Math.max(1, Math.round(box.h * s));
  const pix = resample(img, box, ow, oh);
  const out = new PNG({ width: LOGO_CANVAS.width, height: LOGO_CANVAS.height });
  out.data.fill(0);
  const ox = Math.floor((LOGO_CANVAS.width - ow) / 2), oy = Math.floor((LOGO_CANVAS.height - oh) / 2);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const i = (y * ow + x) * 4, o = ((y + oy) * LOGO_CANVAS.width + x + ox) * 4;
      for (let c = 0; c < 4; c++) out.data[o + c] = Math.max(0, Math.min(255, Math.round(pix[i + c])));
    }
  }
  return PNG.sync.write(out, { colorType: 6 });
}
