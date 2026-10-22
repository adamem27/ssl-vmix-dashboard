/**
 * PNG element renderer shared by the server (export) and the browser (live preview).
 * Pure TypeScript with no Node or DOM APIs, so both sides draw exactly the same pixels.
 *
 * An element is a (rounded) rectangle filled with a team gradient, optionally overlaid with the
 * semi-transparent "Copacabana waves" pattern and an inside stroke, then faded by its own opacity.
 */

export interface GradientStop { pos: number; color: string; opacity: number }
/** angle in degrees like Illustrator: 0 = left → right, 90 = bottom → top. */
export interface Gradient { angle: number; stops: GradientStop[] }

/** Copacabana waves: light bands whose edges follow a sine; sizes in px at scale 1. */
export interface PatternSpec { color: string; wavelength: number; period: number; amplitude: number; band: number; angle: number }

export interface ElementSpec {
  width: number;
  height: number;
  radius: number;
  /** 0–100, applied to the whole element */
  opacity: number;
  /** mirror the gradient left ↔ right */
  flip: boolean;
  /** added to the gradient angle */
  angleOffset: number;
  strokeWidth: number;
  strokeColor: string;
  strokeOpacity: number;
  pattern: boolean;
  patternOpacity: number;
  patternScale: number;
}

/** RGBA tile used instead of the drawn waves when the operator uploads their own pattern. */
export interface Tile { width: number; height: number; data: Uint8Array | Uint8ClampedArray }

export interface Raster { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }

export const DEFAULT_PATTERN: PatternSpec = { color: '#ffffff', wavelength: 48, period: 36, amplitude: 0.28, band: 0.5, angle: 0 };

export function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function toHex([r, g, b]: [number, number, number]) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 256-entry lookup of premultiplied-free RGBA along the gradient, positions 0–100. */
function gradientLut(g: Gradient): Float32Array {
  const lut = new Float32Array(256 * 4);
  const stops = [...g.stops].sort((a, b) => a.pos - b.pos).map((s) => ({ p: clamp01(s.pos / 100), c: parseHex(s.color), a: clamp01(s.opacity / 100) }));
  if (!stops.length) return lut;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r: number, gg: number, b: number, a: number;
    if (t <= stops[0].p) [r, gg, b, a] = [...stops[0].c, stops[0].a];
    else if (t >= stops[stops.length - 1].p) { const s = stops[stops.length - 1]; [r, gg, b, a] = [...s.c, s.a]; }
    else {
      let k = 0;
      while (k < stops.length - 2 && t > stops[k + 1].p) k++;
      const s0 = stops[k], s1 = stops[k + 1];
      const f = s1.p > s0.p ? (t - s0.p) / (s1.p - s0.p) : 0;
      r = s0.c[0] + (s1.c[0] - s0.c[0]) * f;
      gg = s0.c[1] + (s1.c[1] - s0.c[1]) * f;
      b = s0.c[2] + (s1.c[2] - s0.c[2]) * f;
      a = s0.a + (s1.a - s0.a) * f;
    }
    lut[i * 4] = r; lut[i * 4 + 1] = gg; lut[i * 4 + 2] = b; lut[i * 4 + 3] = a;
  }
  return lut;
}

/** Signed distance from (px, py) to a rounded rectangle centred at the origin (negative inside). */
function roundedRectSdf(px: number, py: number, hw: number, hh: number, r: number) {
  const qx = Math.abs(px) - (hw - r);
  const qy = Math.abs(py) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * Draw an element. `scale` shrinks everything (sizes, radius, stroke, pattern) for quick previews;
 * the export always uses scale 1.
 */
export function renderElement(el: ElementSpec, gradient: Gradient, pattern: PatternSpec, tile: Tile | null = null, scale = 1): Raster {
  const W = Math.max(1, Math.round(el.width * scale));
  const H = Math.max(1, Math.round(el.height * scale));
  const data = new Uint8ClampedArray(W * H * 4);
  const hw = W / 2, hh = H / 2;
  const radius = Math.max(0, Math.min(el.radius * scale, hw, hh));
  const strokeW = Math.max(0, el.strokeWidth * scale);
  const [sr, sg, sb] = parseHex(el.strokeColor);
  const strokeA = clamp01(el.strokeOpacity / 100);
  const elA = clamp01(el.opacity / 100);

  // Gradient line through the centre, long enough that 0 and 100 touch opposite corners (as in CSS/Illustrator).
  let ang = ((gradient.angle + el.angleOffset) * Math.PI) / 180;
  let dx = Math.cos(ang), dy = -Math.sin(ang);
  if (el.flip) dx = -dx;
  const len = Math.abs(W * dx) + Math.abs(H * dy) || 1;
  const lut = gradientLut(gradient);

  const usePattern = el.pattern && el.patternOpacity > 0;
  const patA = clamp01(el.patternOpacity / 100);
  const [pr, pg, pb] = parseHex(pattern.color);
  const ps = Math.max(0.05, el.patternScale / 100) * scale;
  const wl = Math.max(1, pattern.wavelength * ps);
  const per = Math.max(1, pattern.period * ps);
  const amp = pattern.amplitude * per;
  const band = clamp01(pattern.band);
  const pAng = (pattern.angle * Math.PI) / 180;
  const pc = Math.cos(pAng), pSin = Math.sin(pAng);
  const k = (2 * Math.PI) / wl;

  for (let y = 0; y < H; y++) {
    const cy = y + 0.5 - hh;
    for (let x = 0; x < W; x++) {
      const cx = x + 0.5 - hw;
      const d = roundedRectSdf(cx, cy, hw, hh, radius);
      const cover = clamp01(0.5 - d);
      if (cover <= 0) continue;

      // gradient
      const t = clamp01((cx * dx + cy * dy) / len + 0.5);
      const li = Math.round(t * 255) * 4;
      let r = lut[li], g = lut[li + 1], b = lut[li + 2], a = lut[li + 3];

      // pattern over the gradient (source-over)
      if (usePattern) {
        let pa = 0, qr = pr, qg = pg, qb = pb;
        const u = cx * pc + cy * pSin + hw, v = -cx * pSin + cy * pc + hh;
        if (tile && tile.width > 0 && tile.height > 0) {
          const tx = ((Math.floor(u / (ps || 1)) % tile.width) + tile.width) % tile.width;
          const ty = ((Math.floor(v / (ps || 1)) % tile.height) + tile.height) % tile.height;
          const ti = (ty * tile.width + tx) * 4;
          qr = tile.data[ti]; qg = tile.data[ti + 1]; qb = tile.data[ti + 2];
          pa = (tile.data[ti + 3] / 255) * patA;
        } else {
          // vertical distance (in px) to the nearest band edge, corrected for the wave slope
          const shifted = v + amp * Math.sin(k * u);
          const f = ((shifted / per) % 1 + 1) % 1;
          const toStart = f * per, toEnd = (band - f) * per, toNext = (1 - f) * per;
          const inside = f < band;
          const dist = inside ? Math.min(toStart, toEnd) : Math.min(-toEnd, toNext);
          const slope = amp * k * Math.cos(k * u);
          const px = dist / Math.sqrt(1 + slope * slope);
          const m = inside ? clamp01(0.5 + px) : clamp01(0.5 - px);
          pa = m * patA;
        }
        if (pa > 0) {
          const oa = pa + a * (1 - pa);
          if (oa > 0) {
            r = (qr * pa + r * a * (1 - pa)) / oa;
            g = (qg * pa + g * a * (1 - pa)) / oa;
            b = (qb * pa + b * a * (1 - pa)) / oa;
          }
          a = oa;
        }
      }

      // inside stroke
      if (strokeW > 0 && strokeA > 0) {
        const inner = clamp01(0.5 - (d + strokeW));
        const sa = clamp01(cover - inner) / (cover || 1) * strokeA;
        if (sa > 0) {
          const oa = sa + a * (1 - sa);
          if (oa > 0) {
            r = (sr * sa + r * a * (1 - sa)) / oa;
            g = (sg * sa + g * a * (1 - sa)) / oa;
            b = (sb * sa + b * a * (1 - sa)) / oa;
          }
          a = oa;
        }
      }

      const o = (y * W + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b;
      data[o + 3] = Math.round(a * cover * elA * 255);
    }
  }
  return { width: W, height: H, data };
}

/** Two or three base colours → the three standard versions seen in the Illustrator files. */
export function gradientVersions(colors: string[], angle = 0): Gradient[] {
  const c = colors.filter(Boolean);
  const even = (cs: string[], from: number, to: number) => cs.map((color, i) => ({ pos: cs.length === 1 ? from : from + ((to - from) * i) / (cs.length - 1), color, opacity: 100 }));
  const solid = even(c, 0, 100);
  return [
    // V1: full colour bar
    { angle, stops: solid },
    // V2: fades in from the left
    { angle, stops: [{ pos: 0, color: c[0], opacity: 0 }, ...even(c, 45, 100)] },
    // V3: fades in and out
    { angle, stops: [{ pos: 0, color: c[0], opacity: 0 }, ...even(c, 30, 70), { pos: 100, color: c[c.length - 1], opacity: 0 }] },
  ];
}
