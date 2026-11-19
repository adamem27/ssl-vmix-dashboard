import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getSetting, setSetting } from '../db/db.js';
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
const VERSION = 'partners-6';
const SPONSOR_SLOTS = ['sponsor_1', 'sponsor_2', 'sponsor_3', 'sponsor_4', 'sponsor_5'];
/**
 * Where the lowest sailor card ends, in panel pixels (screen − 53): 774 on Team_lineup_8 and team_lineup (9),
 * 828 on Team_lineup_10. The strip takes the room from there to the bottom of the sponsor panel.
 */
export const CARDS_END = { 9: 721, 10: 775 };
/** Which line-up a title is: 10 places or more → the one whose cards reach lowest. */
export const stripFor = (places) => (places >= 10 ? 10 : 9);
/** The strip for a sponsor panel of this height (panel pixels): the label above the logos when there is room. */
export function stripRect(kind, panelH) {
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
function visible(buf) {
    const d = decode(buf);
    clearSolidBackground(d);
    return d;
}
/** Where the logo's ink is: faint glow, shadows and stray pixels around it do not count. */
const inkBox = (d) => { try {
    return trimBox(d, 64);
}
catch {
    return trimBox(d);
} };
let canvasMod;
let fontKey = '';
function canvas(assetsDir) {
    if (canvasMod === undefined) {
        try {
            canvasMod = createRequire(import.meta.url)('@napi-rs/canvas');
        }
        catch {
            canvasMod = null;
        }
    }
    if (canvasMod) {
        const files = uploadedSansFiles(assetsDir);
        const key = files.map((f) => f.file).join('|');
        if (key && key !== fontKey) {
            for (const f of files)
                canvasMod.GlobalFonts.registerFromPath(f.file, 'General Sans');
            fontKey = key;
        }
    }
    return canvasMod;
}
function readAsset(ctx, a) {
    if (!a)
        return null;
    const root = getSetting(ctx.db, 'paths.vmixAssetsRoot');
    for (const p of [a.storedPath, a.enteredPath ? localCandidate(a.enteredPath, root, ctx.assetsDir) : null]) {
        if (!p)
            continue;
        const buf = readIfExists(p);
        if (buf)
            return { file: p, buf };
    }
    return null;
}
/** The team’s sponsor logos that can be read here, in slot order. */
export function sponsorLogos(ctx, assets) {
    return SPONSOR_SLOTS.map((s) => readAsset(ctx, assets[s])).filter((x) => !!x);
}
export const hasSponsorLogos = (ctx, team) => sponsorLogos(ctx, team.assets).length > 0;
/** The neutral element of the PNG generator named “Lineup” (plain) or “Lineup sponsor”, when its file exists. */
export function generatedPanel(ctx, which) {
    const want = which === 'sponsor' ? /^lineup[\s_-]*sponsors?$/i : /^lineup$/i;
    const ids = new Set(listTemplates(ctx.db).filter((t) => want.test(t.name.trim()) || want.test(t.fileName)).map((t) => t.id));
    for (const o of listOutputs(ctx.db)) {
        if (o.teamId !== NEUTRAL_ID || !ids.has(o.templateId))
            continue;
        const p = path.join(ctx.assetsDir, ...o.rel.split('/'));
        if (fs.existsSync(p))
            return p;
    }
    return null;
}
/** Mean brightness (0–1) of a logo's visible pixels. */
export function brightness(d) {
    let sum = 0, n = 0;
    for (let i = 0; i < d.data.length; i += 4) {
        const a = d.data[i + 3];
        if (a < 128)
            continue;
        sum += (0.2126 * d.data[i] + 0.7152 * d.data[i + 1] + 0.0722 * d.data[i + 2]) / 255;
        n++;
    }
    return n ? sum / n : 0.5;
}
/** A logo that would vanish on its background (black on the dark strip, white on the light tab) drawn in one colour. */
function silhouette(c, src, colour) {
    const t = c.createCanvas(src.width, src.height);
    const g = t.getContext('2d');
    g.drawImage(src, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = colour;
    g.fillRect(0, 0, src.width, src.height);
    return t;
}
const stamp = (f) => { try {
    const s = fs.statSync(f);
    return `${f}:${s.size}:${s.mtimeMs}`;
}
catch {
    return f;
} };
/**
 * Logos that read as one size: the height falls with the width-to-height ratio (ratio^-0.35, between one height for all
 * and one area for all), a square logo 80% of the row's height. When a logo is too wide for its slot, all of them
 * shrink together (down to 75%) so they stay alike; only past that is the wide one capped on its own.
 */
export function logoSizes(boxes, slotW, strip = stripRect(9, 952)) {
    const { maxH } = strip;
    const room = Math.min(MAX_W, slotW - 36);
    const want = boxes.map(({ w, h }) => {
        const ratio = w / h;
        const th = Math.min(maxH, maxH * 0.8 * Math.pow(ratio, -0.35));
        return { w: th * ratio, h: th };
    });
    const common = Math.max(0.75, Math.min(1, ...want.map((x) => room / x.w)));
    return want.map((x) => {
        const s = Math.min(common, room / x.w);
        return { w: Math.round(x.w * s), h: Math.round(x.h * s) };
    });
}
function draw(ctx, c, base, logos, kind) {
    const cv = c.createCanvas(PANEL.width, PANEL.height);
    const g = cv.getContext('2d');
    // decoded here (pngjs / jpeg-js) and drawn from a canvas: an Image fed a buffer decodes later, after the draw
    const pic = (buf) => {
        const d = visible(buf);
        const t = c.createCanvas(d.width, d.height);
        t.getContext('2d').putImageData(new c.ImageData(new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.length), d.width, d.height), 0, 0);
        // dark logos turn white on the dark strip (as on the design), every other logo keeps its colours
        return { im: brightness(d) < 0.3 ? silhouette(c, t, '#ffffff') : t, box: inkBox(d) };
    };
    const rr = (x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); };
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
    }
    else {
        rr(0.5, 0.5, PANEL.width - 1, panelH - 1, 35);
        g.fillStyle = '#464646';
        g.fill();
        const ring = g.createLinearGradient(0, 0, PANEL.width, panelH);
        ring.addColorStop(0, '#f08a00');
        ring.addColorStop(1, '#ffd200');
        g.strokeStyle = ring;
        g.lineWidth = 1;
        g.stroke();
    }
    if (!sponsors)
        return cv.toBuffer('image/png');
    const s = stripRect(kind, panelH);
    const imgs = logos.flatMap((b) => { try {
        return [pic(b)];
    }
    catch {
        return [];
    } }); // an empty logo is left out
    if (!imgs.length)
        return cv.toBuffer('image/png');
    // sizes from what each logo really shows (its ink, not its picture), then equal gaps between the ink edges
    const n = imgs.length;
    const sizes = logoSizes(imgs.map((x) => x.box), Math.min((s.w - 80 - MIN_GAP * (n - 1)) / n + 36, MAX_W + 36), s);
    const sum = sizes.reduce((t, x) => t + x.w, 0);
    const gap = n > 1 ? Math.max(MIN_GAP, Math.min(MAX_GAP, (s.w - 80 - sum) / (n - 1))) : 0;
    const rowH = Math.max(...sizes.map((x) => x.h));
    // the label sits just above the row and belongs to it: label + 18 px + logos, the block centred in the room
    const labelSize = s.compact ? 14 : 17;
    const block = labelSize + LABEL_GAP + rowH;
    const top = s.y + (s.h - block) / 2;
    g.fillStyle = '#ffffff';
    g.font = `600 ${labelSize}px "General Sans", "Segoe UI", Arial, sans-serif`;
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    g.fillText('TEAM PARTNERS', s.x + s.w / 2, top + labelSize / 2);
    const cy = top + labelSize + LABEL_GAP + rowH / 2;
    let x = s.x + (s.w - sum - gap * (n - 1)) / 2;
    imgs.forEach(({ im, box }, i) => {
        const { w, h } = sizes[i];
        g.drawImage(im, box.x0, box.y0, box.w, box.h, Math.round(x), Math.round(cy - h / 2), w, h);
        x += w + gap;
    });
    return cv.toBuffer('image/png');
}
/**
 * The picture for the line-up’s BG field: <CODE>_lineup_sponsors.png for a team with sponsor logos, otherwise the plain
 * panel. Written again only when the logos or the panel change. Null when nothing can be drawn here.
 */
export function lineupPanelFor(ctx, team, kind = 9) {
    const c = canvas(ctx.assetsDir);
    if (!c)
        return null;
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
        }
        catch {
            if (!fs.existsSync(file))
                return null;
        } // locked by vMix: the last one stays
    }
    const root = getSetting(ctx.db, 'paths.vmixAssetsRoot');
    return root ? joinVmixPath(root, rel) : file;
}
// ---------- the sailor lower third: a tab with the team’s first sponsor above the bar ----------
/** The tab, drawn at twice its size in the title (260×58): page 20 of finals-broadcast_ssl26_v2. */
export const TAG = { width: 520, height: 116 };
const TAG_SIDE = 120;
const TAG_MAX = { w: 380, h: 76 };
function drawTag(c, logo) {
    const { width: w, height: h } = TAG;
    const cv = c.createCanvas(w, h);
    if (!logo)
        return cv.toBuffer('image/png');
    const g = cv.getContext('2d');
    // the sides lean out towards the bar, the top corners rounded
    g.beginPath();
    g.moveTo(0, h);
    g.lineTo(26, 18);
    g.quadraticCurveTo(32, 0, 52, 0);
    g.lineTo(w - 52, 0);
    g.quadraticCurveTo(w - 32, 0, w - 26, 18);
    g.lineTo(w, h);
    g.closePath();
    g.fillStyle = '#dfe5ef';
    g.fill();
    const d = visible(logo);
    const t = c.createCanvas(d.width, d.height);
    t.getContext('2d').putImageData(new c.ImageData(new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.length), d.width, d.height), 0, 0);
    const box = inkBox(d);
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
export function ltSponsorFor(ctx, team) {
    const c = canvas(ctx.assetsDir);
    if (!c)
        return null;
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
        }
        catch {
            if (!fs.existsSync(file))
                return null;
        }
    }
    const root = getSetting(ctx.db, 'paths.vmixAssetsRoot');
    return root ? joinVmixPath(root, `${PANEL_DIR}/${name}`) : file;
}
