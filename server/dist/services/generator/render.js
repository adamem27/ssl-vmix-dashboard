/**
 * PNG element renderer shared by the server (export) and the browser (live preview).
 * Pure TypeScript with no Node or DOM APIs, so both sides draw exactly the same pixels.
 *
 * An element is a (rounded) rectangle filled with a team gradient, optionally overlaid with the
 * semi-transparent black "Copacabana waves" from the Illustrator artwork and an inside stroke, then faded by its own opacity.
 */
/**
 * Copacabana waves exactly as in the Illustrator file (gradienty.ai, PATTERN artwork): black bands,
 * 81.111 px wave length, a band every 60.833 px, each band 30.417 px tall. One period of the band's
 * top edge is six cubic Béziers (x grows to the right, y up, as in the file).
 */
const WAVE_LENGTH = 81.111;
const WAVE_ROW = 60.8332;
const WAVE_BAND = 30.417;
/** Where the artwork sits relative to the element's top-left corner (taken from the 851 × 390 panel). */
const WAVE_PHASE_X = 986.3008;
const WAVE_PHASE_Y = 390.399 - 368.1095;
const WAVE_EDGE = [
    [0, 0, 3.24, 4.461, 5.029, 11.117, 5.789, 19.887],
    [5.789, 19.887, 6.925, 31.076, 11.254, 46.502, 26.067, 46.502],
    [26.067, 46.502, 40.885, 46.502, 45.214, 31.076, 46.345, 19.887],
    [46.345, 19.887, 47.105, 11.117, 48.895, 4.461, 52.134, 0],
    [52.134, 0, 55.373, -4.461, 60.063, -6.727, 66.623, -6.727],
    [66.623, -6.727, 73.188, -6.727, 77.872, -4.461, 81.111, 0],
];
/** Height of the band's top edge (y up) over one wave length, sampled every 1/WAVE_LUT of it. */
const WAVE_LUT = 2048;
const waveLut = (() => {
    const pts = [];
    for (const [x0, y0, x1, y1, x2, y2, x3, y3] of WAVE_EDGE) {
        for (let i = 0; i < 400; i++) {
            const t = i / 400, m = 1 - t;
            const a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
            pts.push([a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3]);
        }
    }
    pts.push([WAVE_LENGTH, 0]);
    const lut = new Float64Array(WAVE_LUT + 1);
    let k = 0;
    for (let i = 0; i <= WAVE_LUT; i++) {
        const x = (i / WAVE_LUT) * WAVE_LENGTH;
        while (k < pts.length - 2 && pts[k + 1][0] < x)
            k++;
        const [xa, ya] = pts[k], [xb, yb] = pts[k + 1];
        lut[i] = xb > xa ? ya + ((yb - ya) * (x - xa)) / (xb - xa) : ya;
    }
    return lut;
})();
export function parseHex(hex) {
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
    if (!m)
        return [0, 0, 0];
    const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export function toHex([r, g, b]) {
    return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** 256-entry lookup of premultiplied-free RGBA along the gradient, positions 0–100. */
function gradientLut(g) {
    const lut = new Float32Array(256 * 4);
    const stops = [...g.stops].sort((a, b) => a.pos - b.pos).map((s) => ({ p: clamp01(s.pos / 100), c: parseHex(s.color), a: clamp01(s.opacity / 100) }));
    if (!stops.length)
        return lut;
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let r, gg, b, a;
        if (t <= stops[0].p)
            [r, gg, b, a] = [...stops[0].c, stops[0].a];
        else if (t >= stops[stops.length - 1].p) {
            const s = stops[stops.length - 1];
            [r, gg, b, a] = [...s.c, s.a];
        }
        else {
            let k = 0;
            while (k < stops.length - 2 && t > stops[k + 1].p)
                k++;
            const s0 = stops[k], s1 = stops[k + 1];
            const f = s1.p > s0.p ? (t - s0.p) / (s1.p - s0.p) : 0;
            r = s0.c[0] + (s1.c[0] - s0.c[0]) * f;
            gg = s0.c[1] + (s1.c[1] - s0.c[1]) * f;
            b = s0.c[2] + (s1.c[2] - s0.c[2]) * f;
            a = s0.a + (s1.a - s0.a) * f;
        }
        lut[i * 4] = r;
        lut[i * 4 + 1] = gg;
        lut[i * 4 + 2] = b;
        lut[i * 4 + 3] = a;
    }
    return lut;
}
/** Signed distance from (px, py) to a rounded rectangle centred at the origin (negative inside). */
function roundedRectSdf(px, py, hw, hh, r) {
    const qx = Math.abs(px) - (hw - r);
    const qy = Math.abs(py) - (hh - r);
    const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
    return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}
/**
 * Draw an element. `scale` shrinks everything (sizes, radius, stroke, pattern) for quick previews;
 * the export always uses scale 1.
 */
export function renderElement(el, gradient, scale = 1, strokeGradient = null) {
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
    if (el.flip)
        dx = -dx;
    const len = Math.abs(W * dx) + Math.abs(H * dy) || 1;
    const lut = gradientLut(gradient);
    // Gradient stroke: its own axis and angle, mirrored with the element.
    const sLut = el.strokeGradient && strokeGradient ? gradientLut(strokeGradient) : null;
    const sAng = (el.strokeAngle * Math.PI) / 180;
    const sdx = (el.flip ? -1 : 1) * Math.cos(sAng), sdy = -Math.sin(sAng);
    const sLen = Math.abs(W * sdx) + Math.abs(H * sdy) || 1;
    const usePattern = el.pattern && el.patternOpacity > 0;
    const patA = clamp01(el.patternOpacity / 100);
    const ps = Math.max(0.05, el.patternScale / 100) * scale;
    for (let y = 0; y < H; y++) {
        const cy = y + 0.5 - hh;
        for (let x = 0; x < W; x++) {
            const cx = x + 0.5 - hw;
            const d = roundedRectSdf(cx, cy, hw, hh, radius);
            const cover = clamp01(0.5 - d);
            if (cover <= 0)
                continue;
            // gradient
            const t = clamp01((cx * dx + cy * dy) / len + 0.5);
            const li = Math.round(t * 255) * 4;
            let r = lut[li], g = lut[li + 1], b = lut[li + 2], a = lut[li + 3];
            // pattern over the gradient (source-over)
            if (usePattern) {
                // Position in the artwork's own units; the file draws the edge leftwards from WAVE_PHASE_X.
                const u = (x + 0.5) / ps, v = (y + 0.5) / ps;
                const f = ((WAVE_PHASE_X - u) % WAVE_LENGTH + WAVE_LENGTH) % WAVE_LENGTH;
                const fi = (f / WAVE_LENGTH) * WAVE_LUT;
                const i0 = Math.min(WAVE_LUT - 1, Math.floor(fi));
                const top = waveLut[i0] + (waveLut[i0 + 1] - waveLut[i0]) * (fi - i0);
                const slope = ((waveLut[i0 + 1] - waveLut[i0]) * WAVE_LUT) / WAVE_LENGTH;
                // depth below the band's top edge (image y grows down), folded into one row
                const depth = (((v - (WAVE_PHASE_Y - top)) % WAVE_ROW) + WAVE_ROW) % WAVE_ROW;
                const inside = depth < WAVE_BAND;
                const edge = inside ? Math.min(depth, WAVE_BAND - depth) : Math.min(depth - WAVE_BAND, WAVE_ROW - depth);
                const dist = (edge * ps) / Math.sqrt(1 + slope * slope);
                const pa = (inside ? clamp01(0.5 + dist) : clamp01(0.5 - dist)) * patA;
                if (pa > 0) {
                    const oa = pa + a * (1 - pa);
                    if (oa > 0) {
                        r = (r * a * (1 - pa)) / oa;
                        g = (g * a * (1 - pa)) / oa;
                        b = (b * a * (1 - pa)) / oa;
                    }
                    a = oa;
                }
            }
            // inside stroke
            if (strokeW > 0 && strokeA > 0) {
                const inner = clamp01(0.5 - (d + strokeW));
                let sa = clamp01(cover - inner) / (cover || 1) * strokeA;
                let qr = sr, qg = sg, qb = sb;
                if (sLut && sa > 0) {
                    const si = Math.round(clamp01((cx * sdx + cy * sdy) / sLen + 0.5) * 255) * 4;
                    qr = sLut[si];
                    qg = sLut[si + 1];
                    qb = sLut[si + 2];
                    sa *= sLut[si + 3];
                }
                if (sa > 0) {
                    const oa = sa + a * (1 - sa);
                    if (oa > 0) {
                        r = (qr * sa + r * a * (1 - sa)) / oa;
                        g = (qg * sa + g * a * (1 - sa)) / oa;
                        b = (qb * sa + b * a * (1 - sa)) / oa;
                    }
                    a = oa;
                }
            }
            const o = (y * W + x) * 4;
            data[o] = r;
            data[o + 1] = g;
            data[o + 2] = b;
            data[o + 3] = Math.round(a * cover * elA * 255);
        }
    }
    return { width: W, height: H, data };
}
/** The stroke (obwoluta) gradient from finals-broadcast_ssl26_v2: orange → yellow at −45°, solid at both corners, clear in the middle. */
export const DEFAULT_STROKE_GRADIENT = {
    angle: -45,
    stops: [
        { pos: 0, color: '#f28c06', opacity: 100 },
        { pos: 50, color: '#fece00', opacity: 0 },
        { pos: 100, color: '#fece00', opacity: 100 },
    ],
};
/** A full-colour gradient (version 1) → the three standard versions seen in the Illustrator files. */
export function gradientVersionsFrom(g) {
    const stops = [...g.stops].sort((a, b) => a.pos - b.pos);
    const squeeze = (from, to) => stops.map((s) => ({ ...s, pos: Math.round((from + ((to - from) * s.pos) / 100) * 10) / 10 }));
    const first = stops[0], last = stops[stops.length - 1];
    return [
        // V1: full colour bar
        { angle: g.angle, stops },
        // V2: fades in from the left
        { angle: g.angle, stops: [{ pos: 0, color: first.color, opacity: 0 }, ...squeeze(45, 100)] },
        // V3: fades in and out
        { angle: g.angle, stops: [{ pos: 0, color: first.color, opacity: 0 }, ...squeeze(30, 70), { pos: 100, color: last.color, opacity: 0 }] },
    ];
}
/** Two or three base colours → the three standard versions seen in the Illustrator files. */
export function gradientVersions(colors, angle = 0) {
    const c = colors.filter(Boolean);
    return gradientVersionsFrom({ angle, stops: c.map((color, i) => ({ pos: c.length === 1 ? 0 : (100 * i) / (c.length - 1), color, opacity: 100 })) });
}
export const DEFAULT_NEUTRAL = { enabled: true, color: '#1a1a1a', opacity: 80, strokeWidth: 1 };
export const NEUTRAL_CODE = 'NEUTRAL';
export const NEUTRAL_ID = 'neutral';
export const neutralGradient = (color, opacity = 100) => ({ angle: 0, stops: [{ pos: 0, color, opacity }, { pos: 100, color, opacity }] });
/** An element as drawn in the neutral set: its own stroke width if it has one, else the neutral one, always painted with the stroke gradient. */
export const neutralSpec = (el, n) => ({ ...el, strokeGradient: true, strokeWidth: el.strokeWidth > 0 ? el.strokeWidth : n.strokeWidth });
