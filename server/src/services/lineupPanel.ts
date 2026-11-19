import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getSetting, setSetting } from '../db/db.js';
import { AssetCtx } from './assets.js';
import { listOutputs } from './generator/generator.js';
import { NEUTRAL_ID } from './generator/render.js';
import { decode, trimBox } from './logo.js';
import { uploadedSansFiles } from './matchboard/matchboard.js';
import { joinVmixPath, localCandidate, readIfExists } from './paths.js';

/**
 * The big panel behind the team line-up (the BG picture of Team_lineup_8/9, 1731×861 at 95,53). For a team with
 * sponsor logos the panel gets a “TEAM PARTNERS” strip under the boat (as on page 43 of finals-broadcast_ssl26_v2):
 * the same title input, only another picture in its BG field, written as <CODE>_lineup_sponsors.png. A team without
 * sponsors gets the plain panel back, so the next team never keeps someone else’s partners.
 */
export const PANEL = { width: 1731, height: 861 };
export const PANEL_DIR = 'Line-up panels';
const VERSION = 'partners-2';
const SPONSOR_SLOTS = ['sponsor_1', 'sponsor_2', 'sponsor_3', 'sponsor_4', 'sponsor_5'];

/**
 * The strip, in panel pixels (the panel sits at 95,53), between the lowest sailor card and the panel's edge. The cards
 * of Team_lineup_8 / team_lineup (9) end at 774 on screen, so the strip is 120 px with the label above the logos;
 * those of Team_lineup_10 end at 828, so there it is one 66 px row with the label on its left.
 * side: every logo gets the same visible area (a square logo is side×side), capped by maxH and its slot.
 */
export const STRIPS = {
  9: { x: 125, y: 733, w: 1481, h: 118, radius: 22, compact: false, side: 80, maxH: 58 },
  10: { x: 125, y: 787, w: 1481, h: 66, radius: 18, compact: true, side: 60, maxH: 40 },
} as const;
export type StripKind = keyof typeof STRIPS;
export const STRIP = STRIPS[9];
/** Which strip a line-up title takes: 10 places or more → the low one. */
export const stripFor = (places: number): StripKind => (places >= 10 ? 10 : 9);
const MAX_W = 300;

type Asset = { storedPath: string | null; enteredPath: string | null } | null | undefined;
type Canvas = typeof import('@napi-rs/canvas');
let canvasMod: Canvas | null | undefined;
let fontKey = '';
function canvas(assetsDir: string): Canvas | null {
  if (canvasMod === undefined) { try { canvasMod = createRequire(import.meta.url)('@napi-rs/canvas') as Canvas; } catch { canvasMod = null; } }
  if (canvasMod) {
    const files = uploadedSansFiles(assetsDir);
    const key = files.map((f) => f.file).join('|');
    if (key && key !== fontKey) { for (const f of files) canvasMod.GlobalFonts.registerFromPath(f.file, 'General Sans'); fontKey = key; }
  }
  return canvasMod;
}

function readAsset(ctx: AssetCtx, a: Asset): { file: string; buf: Buffer } | null {
  if (!a) return null;
  const root = getSetting(ctx.db, 'paths.vmixAssetsRoot');
  for (const p of [a.storedPath, a.enteredPath ? localCandidate(a.enteredPath, root, ctx.assetsDir) : null]) {
    if (!p) continue;
    const buf = readIfExists(p);
    if (buf) return { file: p, buf };
  }
  return null;
}

/** The team’s sponsor logos that can be read here, in slot order. */
export function sponsorLogos(ctx: AssetCtx, assets: Record<string, Asset>) {
  return SPONSOR_SLOTS.map((s) => readAsset(ctx, assets[s])).filter((x): x is { file: string; buf: Buffer } => !!x);
}

export const hasSponsorLogos = (ctx: AssetCtx, team: { assets: Record<string, Asset> }) => sponsorLogos(ctx, team.assets).length > 0;

/** The neutral “Lineup” panel from the PNG generator (NEUTRAL_Lineup.png), when there is one. */
function generatedPanel(ctx: AssetCtx): string | null {
  const o = listOutputs(ctx.db).find((x) => x.teamId === NEUTRAL_ID && /lineup\.png$/i.test(x.rel) && !/photo/i.test(x.rel));
  const p = o ? path.join(ctx.assetsDir, ...o.rel.split('/')) : null;
  return p && fs.existsSync(p) ? p : null;
}

/** Mean brightness (0–1) of a logo's visible pixels. */
export function brightness(d: { data: Uint8Array }) {
  let sum = 0, n = 0;
  for (let i = 0; i < d.data.length; i += 4) {
    const a = d.data[i + 3];
    if (a < 128) continue;
    sum += (0.2126 * d.data[i] + 0.7152 * d.data[i + 1] + 0.0722 * d.data[i + 2]) / 255; n++;
  }
  return n ? sum / n : 0.5;
}

/** A logo that would vanish on its background (black on the dark strip, white on the light tab) drawn in one colour. */
function silhouette(c: Canvas, src: import('@napi-rs/canvas').Canvas, colour: string) {
  const t = c.createCanvas(src.width, src.height);
  const g = t.getContext('2d');
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = colour; g.fillRect(0, 0, src.width, src.height);
  return t;
}

const stamp = (f: string) => { try { const s = fs.statSync(f); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return f; } };

/** Logo boxes of one size by area: wide logos wider, tall ones taller, none larger than its slot. */
export function logoSizes(boxes: { w: number; h: number }[], slotW: number, kind: StripKind = 9) {
  const { side, maxH } = STRIPS[kind];
  return boxes.map(({ w, h }) => {
    let s = side / Math.sqrt(w * h);
    s = Math.min(s, maxH / h, Math.min(MAX_W, slotW - 36) / w);
    return { w: Math.round(w * s), h: Math.round(h * s) };
  });
}

function draw(ctx: AssetCtx, c: Canvas, base: string | null, logos: Buffer[], kind: StripKind): Buffer {
  const cv = c.createCanvas(PANEL.width, PANEL.height);
  const g = cv.getContext('2d');
  // decoded here (pngjs / jpeg-js) and drawn from a canvas: an Image fed a buffer decodes later, after the draw
  const pic = (buf: Buffer) => {
    const d = decode(buf);
    const t = c.createCanvas(d.width, d.height);
    t.getContext('2d').putImageData(new c.ImageData(new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.length), d.width, d.height), 0, 0);
    // dark logos turn white on the dark strip (as on the design), every other logo keeps its colours
    return { im: brightness(d) < 0.3 ? silhouette(c, t, '#ffffff') : t, box: trimBox(d) };
  };
  const rr = (x: number, y: number, w: number, h: number, r: number) => { g.beginPath(); g.roundRect(x, y, w, h, r); };
  if (base) {
    g.drawImage(pic(fs.readFileSync(base)).im, 0, 0, PANEL.width, PANEL.height);
  } else {
    // the generator has no neutral Lineup panel: the plain one of the title (#464646, 35 px corners, orange→yellow ring)
    rr(0.5, 0.5, PANEL.width - 1, PANEL.height - 1, 35);
    g.fillStyle = '#464646'; g.fill();
    const ring = g.createLinearGradient(0, 0, PANEL.width, PANEL.height);
    ring.addColorStop(0, '#f08a00'); ring.addColorStop(1, '#ffd200');
    g.strokeStyle = ring; g.lineWidth = 1; g.stroke();
  }
  if (!logos.length) return cv.toBuffer('image/png');
  const s = STRIPS[kind];
  rr(s.x, s.y, s.w, s.h, s.radius);
  g.fillStyle = 'rgba(0,0,0,0.30)'; g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1; g.stroke();
  g.fillStyle = '#ffffff';
  g.font = `600 17px "General Sans", "Segoe UI", Arial, sans-serif`;
  g.textBaseline = 'middle';
  // the label above the logos, or (low strip) on the left with the logos beside it
  const labelW = s.compact ? 190 : 0;
  if (s.compact) { g.textAlign = 'left'; g.fillText('TEAM PARTNERS', s.x + 34, s.y + s.h / 2); } else { g.textAlign = 'center'; g.fillText('TEAM PARTNERS', s.x + s.w / 2, s.y + 24); }
  const imgs = logos.flatMap((b) => { try { return [pic(b)]; } catch { return []; } }); // an empty logo is left out
  if (!imgs.length) return cv.toBuffer('image/png');
  // up to 360 px a logo, the row centred: two partners sit together, five fill the strip
  const rowX = s.x + labelW, rowW = s.w - labelW;
  const slotW = Math.min((rowW - 80) / imgs.length, 360);
  const x0 = rowX + (rowW - slotW * imgs.length) / 2;
  const sizes = logoSizes(imgs.map((x) => x.box), slotW, kind);
  const cy = s.compact ? s.y + s.h / 2 : s.y + 38 + (s.h - 38) / 2;
  imgs.forEach(({ im, box }, i) => {
    const { w, h } = sizes[i];
    const cx = x0 + slotW * (i + 0.5);
    g.drawImage(im, box.x0, box.y0, box.w, box.h, Math.round(cx - w / 2), Math.round(cy - h / 2), w, h);
  });
  return cv.toBuffer('image/png');
}

/**
 * The picture for the line-up’s BG field: <CODE>_lineup_sponsors.png for a team with sponsor logos, otherwise the plain
 * panel. Written again only when the logos or the panel change. Null when nothing can be drawn here.
 */
export function lineupPanelFor(ctx: AssetCtx, team: { code: string; assets: Record<string, Asset> }, kind: StripKind = 9): string | null {
  const c = canvas(ctx.assetsDir);
  if (!c) return null;
  const logos = sponsorLogos(ctx, team.assets);
  const base = generatedPanel(ctx);
  const name = logos.length ? `${team.code.replace(/[^\w.-]+/g, '_')}_lineup_sponsors${kind === 10 ? '_10' : ''}.png` : 'lineup_plain.png';
  const rel = `${PANEL_DIR}/${name}`;
  const file = path.join(ctx.assetsDir, PANEL_DIR, name);
  const hash = createHash('sha1').update(JSON.stringify([VERSION, base && stamp(base), logos.map((l) => stamp(l.file))])).digest('hex');
  const key = `lineupPanel.${name}`;
  if (getSetting(ctx.db, key) !== hash || !fs.existsSync(file)) {
    try {
      const buf = draw(ctx, c, base, logos.map((l) => l.buf), kind);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, buf);
      fs.renameSync(`${file}.tmp`, file);
      setSetting(ctx.db, key, hash);
    } catch { if (!fs.existsSync(file)) return null; } // locked by vMix: the last one stays
  }
  const root = getSetting(ctx.db, 'paths.vmixAssetsRoot');
  return root ? joinVmixPath(root, rel) : file;
}

// ---------- the sailor lower third: a tab with the team’s first sponsor above the bar ----------
/** The tab, drawn at twice its size in the title (260×58): page 20 of finals-broadcast_ssl26_v2. */
export const TAG = { width: 520, height: 116 };
const TAG_SIDE = 120;
const TAG_MAX = { w: 380, h: 76 };

function drawTag(c: Canvas, logo: Buffer | null): Buffer {
  const { width: w, height: h } = TAG;
  const cv = c.createCanvas(w, h);
  if (!logo) return cv.toBuffer('image/png');
  const g = cv.getContext('2d');
  // the sides lean out towards the bar, the top corners rounded
  g.beginPath();
  g.moveTo(0, h); g.lineTo(26, 18); g.quadraticCurveTo(32, 0, 52, 0);
  g.lineTo(w - 52, 0); g.quadraticCurveTo(w - 32, 0, w - 26, 18); g.lineTo(w, h); g.closePath();
  g.fillStyle = '#dfe5ef'; g.fill();
  const d = decode(logo);
  const t = c.createCanvas(d.width, d.height);
  t.getContext('2d').putImageData(new c.ImageData(new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.length), d.width, d.height), 0, 0);
  const box = trimBox(d);
  const pic = brightness(d) > 0.8 ? silhouette(c, t, '#1a1a1a') : t; // a white logo would vanish on the light tab
  let s = TAG_SIDE / Math.sqrt(box.w * box.h);
  s = Math.min(s, TAG_MAX.w / box.w, TAG_MAX.h / box.h);
  const lw = Math.round(box.w * s), lh = Math.round(box.h * s);
  g.drawImage(pic, box.x0, box.y0, box.w, box.h, Math.round((w - lw) / 2), Math.round((h - lh) / 2 + 4), lw, lh);
  return cv.toBuffer('image/png');
}

/**
 * The picture for the Sponsor field of the sailor lower third: the team’s Sponsor logo 1 on the tab
 * (<CODE>_lt_sponsor.png), or an empty picture for a team without one (and for the team lower third).
 */
export function ltSponsorFor(ctx: AssetCtx, team: { code: string; assets: Record<string, Asset> } | null): string | null {
  const c = canvas(ctx.assetsDir);
  if (!c) return null;
  const logo = team ? readAsset(ctx, team.assets.sponsor_1) : null;
  const name = logo && team ? `${team.code.replace(/[^\w.-]+/g, '_')}_lt_sponsor.png` : 'lt_sponsor_none.png';
  const file = path.join(ctx.assetsDir, PANEL_DIR, name);
  const hash = createHash('sha1').update(JSON.stringify([VERSION, logo && stamp(logo.file)])).digest('hex');
  const key = `ltSponsor.${name}`;
  if (getSetting(ctx.db, key) !== hash || !fs.existsSync(file)) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, drawTag(c, logo?.buf ?? null));
      fs.renameSync(`${file}.tmp`, file);
      setSetting(ctx.db, key, hash);
    } catch { if (!fs.existsSync(file)) return null; }
  }
  const root = getSetting(ctx.db, 'paths.vmixAssetsRoot');
  return root ? joinVmixPath(root, `${PANEL_DIR}/${name}`) : file;
}
