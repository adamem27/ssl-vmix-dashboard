import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getSetting, setSetting } from '../db/db.js';
import { AssetCtx } from './assets.js';
import { listOutputs, listTemplates } from './generator/generator.js';
import { NEUTRAL_ID } from './generator/render.js';
import { clearSolidBackground, decode, trimBox } from './logo.js';
import { uploadedSansFiles } from './matchboard/matchboard.js';
import { joinVmixPath, localCandidate, readIfExists } from './paths.js';

/**
 * The big panel behind the team line-up (the BG picture of Team_lineup_8/9, 1731×861 at 95,53). For a team with
 * sponsor logos the panel gets a “TEAM PARTNERS” strip under the boat (as on page 43 of finals-broadcast_ssl26_v2):
 * the same title input, only another picture in its BG field, written as <CODE>_lineup_sponsors.png. A team without
 * sponsors gets the plain panel back, so the next team never keeps someone else’s partners.
 */
/**
 * The BG field of the line-up titles (Team_lineup_8, team_lineup, Team_lineup_10) is 1731×972 at 95,53: down to 1025 on
 * screen, as on page 43. The plain panel (861 high, the generator's “Lineup”) sits at its top with nothing below, so a
 * team without sponsors looks as before; a team with sponsors gets the generator's taller “Lineup sponsor” panel with
 * the partners' logos in the room under the sailor cards.
 */
export const PANEL = { width: 1731, height: 972 };
export const PLAIN_HEIGHT = 861;
export const PANEL_DIR = 'Line-up panels';
const VERSION = 'partners-9';
/** The label over the logos: one partner or several. */
export const partnersLabel = (n: number) => (n === 1 ? 'TEAM PARTNER' : 'TEAM PARTNERS');
const SPONSOR_SLOTS = ['sponsor_1', 'sponsor_2', 'sponsor_3', 'sponsor_4', 'sponsor_5'];

/**
 * Where the lowest sailor card ends, in panel pixels (screen − 53): 774 on Team_lineup_8 and team_lineup (9),
 * 828 on Team_lineup_10. The strip takes the room from there to the bottom of the sponsor panel.
 */
export const CARDS_END = { 9: 721, 10: 775 } as const;
export type StripKind = keyof typeof CARDS_END;
/** Which line-up a title is: 10 places or more → the one whose cards reach lowest. */
export const stripFor = (places: number): StripKind => (places >= 10 ? 10 : 9);
/** The strip for a sponsor panel of this height (panel pixels): the label above the logos when there is room. */
export function stripRect(kind: StripKind, panelH: number) {
  const y = CARDS_END[kind] + 18;
  const h = Math.max(56, panelH - 20 - y);
  const compact = h < 104;
  // label row on top (smaller on a low strip), the logos in the rest
  const label = compact ? 22 : 44;
  return { x: 125, y, w: 1481, h, radius: compact ? 18 : 22, compact, label, maxH: Math.max(26, Math.min(100, h - label - 14)) };
}
const MAX_W = 300;
/** Between the ink edges of two logos (the row is centred), and from the label to the logos. */
const MIN_GAP = 60;
const MAX_GAP = 150;
const LABEL_GAP = 18;

/** A logo as it shows: the solid colour around a JPG / flat PNG cleared, like an upload is. */
function visible(buf: Buffer) {
  const d = decode(buf);
  clearSolidBackground(d);
  return d;
}
/** Where the logo's ink is: faint glow, shadows and stray pixels around it do not count. */
const inkBox = (d: ReturnType<typeof decode>) => { try { return trimBox(d, 64); } catch { return trimBox(d); } };
/**
 * What the eye sees of a logo in its ink box: how much of the box it covers (alpha-weighted, 0–1: a solid block 1, a
 * thin wordmark much less) and its visual centre (its weight's middle, 0–1 across and down the box).
 */
export function inkStats(d: { width: number; data: Uint8Array }, box: { x0: number; y0: number; w: number; h: number }) {
  let a = 0, sx = 0, sy = 0;
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const al = d.data[((box.y0 + y) * d.width + box.x0 + x) * 4 + 3] / 255;
      a += al; sx += al * (x + 0.5); sy += al * (y + 0.5);
    }
  }
  if (!a) return { fill: 1, cx: 0.5, cy: 0.5 };
  return { fill: Math.max(0.12, Math.min(1, a / (box.w * box.h))), cx: sx / a / box.w, cy: sy / a / box.h };
}
/** The scale that gives a logo this visual area (covered pixels), within its own largest size. */
const areaScale = (box: { w: number; h: number }, fill: number, area: number, maxW: number, maxH: number) =>
  Math.min(maxW / box.w, maxH / box.h, Math.sqrt(area / (fill * box.w * box.h)));

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

/** The neutral element of the PNG generator named “Lineup” (plain) or “Lineup sponsor”, when its file exists. */
export function generatedPanel(ctx: AssetCtx, which: 'plain' | 'sponsor'): string | null {
  const want = which === 'sponsor' ? /^lineup[\s_-]*sponsors?$/i : /^lineup$/i;
  const ids = new Set(listTemplates(ctx.db).filter((t) => want.test(t.name.trim()) || want.test(t.fileName)).map((t) => t.id));
  for (const o of listOutputs(ctx.db)) {
    if (o.teamId !== NEUTRAL_ID || !ids.has(o.templateId)) continue;
    const p = path.join(ctx.assetsDir, ...o.rel.split('/'));
    if (fs.existsSync(p)) return p;
  }
  return null;
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

/**
 * Logos that read as one size: each scaled so that what it covers (its visual area: the ink, not the file or its box)
 * is the same for all, within its slot and the row's height. The common area is the one most logos can reach (the
 * middle one); a logo that cannot reach it at its largest stays at its largest.
 */
export function logoSizes(boxes: { w: number; h: number; fill?: number }[], slotW: number, strip: { maxH: number } = stripRect(9, 952)) {
  const { maxH } = strip;
  const room = Math.min(MAX_W, slotW - 36);
  const fill = (b: { fill?: number }) => b.fill ?? 1;
  const largest = boxes.map((b) => { const s = Math.min(room / b.w, maxH / b.h); return fill(b) * b.w * b.h * s * s; }).sort((x, y) => x - y);
  const area = largest[Math.floor((largest.length - 1) / 2)];
  return boxes.map((b) => { const s = areaScale(b, fill(b), area, room, maxH); return { w: Math.round(b.w * s), h: Math.round(b.h * s) }; });
}

function draw(ctx: AssetCtx, c: Canvas, base: string | null, logos: Buffer[], kind: StripKind): Buffer {
  const cv = c.createCanvas(PANEL.width, PANEL.height);
  const g = cv.getContext('2d');
  // decoded here (pngjs / jpeg-js) and drawn from a canvas: an Image fed a buffer decodes later, after the draw
  const pic = (buf: Buffer) => {
    const d = visible(buf);
    const t = c.createCanvas(d.width, d.height);
    t.getContext('2d').putImageData(new c.ImageData(new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.length), d.width, d.height), 0, 0);
    // dark logos turn white on the dark strip (as on the design), every other logo keeps its colours
    const box = inkBox(d);
    return { im: brightness(d) < 0.3 ? silhouette(c, t, '#ffffff') : t, box, ...inkStats(d, box) };
  };
  const rr = (x: number, y: number, w: number, h: number, r: number) => { g.beginPath(); g.roundRect(x, y, w, h, r); };
  const sponsors = logos.length > 0;
  // the panel: the generator's file across the full width from the top (at most the field's height), or one drawn
  // like the title's own (#464646, 35 px corners, orange→yellow ring): 861 high, or the full field for sponsors
  let panelH = sponsors ? PANEL.height : PLAIN_HEIGHT;
  if (base) {
    const d = decode(fs.readFileSync(base));
    const t = c.createCanvas(d.width, d.height);
    t.getContext('2d').putImageData(new c.ImageData(new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.length), d.width, d.height), 0, 0);
    const sc = Math.min(PANEL.width / d.width, PANEL.height / d.height);
    const w = d.width * sc;
    panelH = d.height * sc;
    g.drawImage(t, (PANEL.width - w) / 2, 0, w, panelH);
  } else {
    rr(0.5, 0.5, PANEL.width - 1, panelH - 1, 35);
    g.fillStyle = '#464646'; g.fill();
    const ring = g.createLinearGradient(0, 0, PANEL.width, panelH);
    ring.addColorStop(0, '#f08a00'); ring.addColorStop(1, '#ffd200');
    g.strokeStyle = ring; g.lineWidth = 1; g.stroke();
  }
  if (!sponsors) return cv.toBuffer('image/png');
  const s = stripRect(kind, panelH);
  const imgs = logos.flatMap((b) => { try { return [pic(b)]; } catch { return []; } }); // an empty logo is left out
  if (!imgs.length) return cv.toBuffer('image/png');
  // sizes from what each logo really shows (its ink, not its picture), then equal gaps between the ink edges
  const n = imgs.length;
  const sizes = logoSizes(imgs.map((x) => ({ ...x.box, fill: x.fill })), Math.min((s.w - 80 - MIN_GAP * (n - 1)) / n + 36, MAX_W + 36), s);
  const sum = sizes.reduce((t, x) => t + x.w, 0);
  const gap = n > 1 ? Math.max(MIN_GAP, Math.min(MAX_GAP, (s.w - 80 - sum) / (n - 1))) : 0;
  const rowH = Math.max(...sizes.map((x) => x.h));
  // the label sits just above the row and belongs to it: label + 18 px + logos, the block centred in the room
  const labelSize = s.compact ? 14 : 17;
  const block = labelSize + LABEL_GAP + rowH;
  const top = s.y + (s.h - block) / 2;
  g.fillStyle = '#ffffff';
  g.font = `600 ${labelSize}px "General Sans", "Segoe UI", Arial, sans-serif`;
  g.textBaseline = 'middle'; g.textAlign = 'center';
  g.fillText(partnersLabel(n), s.x + s.w / 2, top + labelSize / 2);
  const cy = top + labelSize + LABEL_GAP + rowH / 2;
  let x = s.x + (s.w - sum - gap * (n - 1)) / 2;
  // each logo's visual centre on the row's middle line (a logo with a heavy top or a tagline below sits as the eye
  // expects), kept inside the row
  const rowTop = cy - rowH / 2;
  imgs.forEach(({ im, box, cy: vc }, i) => {
    const { w, h } = sizes[i];
    const y = Math.max(rowTop, Math.min(rowTop + rowH - h, cy - h * vc));
    g.drawImage(im, box.x0, box.y0, box.w, box.h, Math.round(x), Math.round(y), w, h);
    x += w + gap;
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
  const base = generatedPanel(ctx, logos.length ? 'sponsor' : 'plain');
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
/**
 * The logo as big as the tab allows, a margin kept all round for it to read: 90 of the 116 px high (16 above, 10 to
 * the bar), at most 420 of the 520 wide (the sides lean in at the top).
 */
const TAG_MAX = { w: 420, h: 90 };
/**
 * The visual area every team's logo takes on the tab (covered pixels at the tab's double size): a solid square logo
 * reaches about this at the full 90 px, a wordmark is wider and lower, so all teams' logos look one size.
 */
const TAG_AREA = 9000;
const TAG_DOWN = 3;

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
  const d = visible(logo);
  const t = c.createCanvas(d.width, d.height);
  t.getContext('2d').putImageData(new c.ImageData(new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.length), d.width, d.height), 0, 0);
  const box = inkBox(d);
  const pic = brightness(d) > 0.8 ? silhouette(c, t, '#1a1a1a') : t; // a white logo would vanish on the light tab
  const st = inkStats(d, box);
  const s = areaScale(box, st.fill, TAG_AREA, TAG_MAX.w, TAG_MAX.h);
  const lw = Math.round(box.w * s), lh = Math.round(box.h * s);
  // its visual centre on the tab's middle (as the box's middle was), inside the margins
  const top = (h - TAG_MAX.h) / 2 + TAG_DOWN;
  const y = Math.max(top, Math.min(top + TAG_MAX.h - lh, h / 2 + TAG_DOWN - lh * st.cy));
  const x = Math.max((w - TAG_MAX.w) / 2, Math.min((w + TAG_MAX.w) / 2 - lw, w / 2 - lw * st.cx));
  g.drawImage(pic, box.x0, box.y0, box.w, box.h, Math.round(x), Math.round(y), lw, lh);
  return cv.toBuffer('image/png');
}

/** Which of the team's sponsor logos the sailor lower third shows: sponsor_1 … sponsor_5, or none. */
export const LT_SPONSOR_CHOICES = [...SPONSOR_SLOTS, 'none'] as const;
export type LtSponsorChoice = (typeof LT_SPONSOR_CHOICES)[number];
const ltSponsorKey = (teamId: string) => `lt.sponsorSlot.${teamId}`;
export function getLtSponsorSlot(ctx: AssetCtx, teamId: string): LtSponsorChoice {
  const v = getSetting(ctx.db, ltSponsorKey(teamId));
  return (LT_SPONSOR_CHOICES as readonly string[]).includes(v) ? (v as LtSponsorChoice) : 'sponsor_1';
}
export function setLtSponsorSlot(ctx: AssetCtx, teamId: string, slot: LtSponsorChoice) { setSetting(ctx.db, ltSponsorKey(teamId), slot); }

/**
 * The picture for the Sponsor field of the sailor lower third: the team’s Sponsor logo 1 on the tab
 * (<CODE>_lt_sponsor.png), or an empty picture for a team without one (and for the team lower third).
 */
export function ltSponsorFor(ctx: AssetCtx, team: { id?: string; code: string; assets: Record<string, Asset> } | null): string | null {
  const c = canvas(ctx.assetsDir);
  if (!c) return null;
  const pick = team?.id ? getLtSponsorSlot(ctx, team.id) : 'sponsor_1';
  // the chosen logo; when its place is empty, Sponsor logo 1, then the first one there is
  const logo = !team || pick === 'none' ? null
    : readAsset(ctx, team.assets[pick]) ?? readAsset(ctx, team.assets.sponsor_1) ?? SPONSOR_SLOTS.map((x) => readAsset(ctx, team.assets[x])).find(Boolean) ?? null;
  // the logo's own name in the file: vMix reloads a picture only when its path changes
  const n = logo && team ? (SPONSOR_SLOTS.find((x) => readAsset(ctx, team.assets[x])?.file === logo.file) ?? 'sponsor_1').replace('sponsor_', '') : '';
  const name = logo && team ? `${team.code.replace(/[^\w.-]+/g, '_')}_lt_sponsor${n === '1' ? '' : `_${n}`}.png` : 'lt_sponsor_none.png';
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
