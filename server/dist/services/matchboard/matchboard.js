import fs from 'node:fs';
import { resetTextFit } from '../textFit.js';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getSetting, nowIso, setSetting } from '../../db/db.js';
import { badRequest } from '../errors.js';
import { joinVmixPath } from '../paths.js';
import { listAssets } from '../assets.js';
import { getStrokeGradient, listGradients, listTemplates } from '../generator/generator.js';
import { defaultSlotState, drawMatchboard, resolveTeams } from './draw.js';
export { resolveTeams, linkOf } from './draw.js';
/** The exported board lives next to the other assets, so vmix-sync mirrors it to the vMix machine. */
export const MATCHBOARD_REL = 'Matchboard/matchboard.png';
/** Element added to the PNG generator for the highlight, sized like a matchboard row. */
export const HIGHLIGHT_FILE = 'matchboard_team';
/** Rows highlighted in MATCHBOARD-BROADCAST (teams through to the next stage). */
const ARTWORK_HIGHLIGHTS = ['qs-a-2', 'qs-b-1', 'qs-c-1', 'qs-c-2', 'qs-d-1', 'qs-e-1', 'qs-f-1', 'qs-g-1'];
const FONT_SANS = 'General Sans';
const FONT_GROTESK = 'Space Grotesk';
export function fixturesDir() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const p of [path.join(here, '..', '..', '..', 'fixtures'), path.join(here, '..', '..', 'fixtures')])
        if (fs.existsSync(path.join(p, 'matchboard')))
            return p;
    return path.join(here, '..', '..', '..', 'fixtures');
}
let layoutCache = null;
export function loadLayout() {
    layoutCache ??= JSON.parse(fs.readFileSync(path.join(fixturesDir(), 'matchboard', 'layout.json'), 'utf8'));
    return layoutCache;
}
export const backgroundPath = () => path.join(fixturesDir(), 'matchboard', 'background.png');
export const groteskPath = () => path.join(fixturesDir(), 'fonts', 'SpaceGrotesk-Bold.ttf');
// ---------- state ----------
const slotSchema = z.object({ teamId: z.string().max(64).nullable(), text: z.string().max(40), highlight: z.boolean() });
export const statePatchSchema = z.object({
    texts: z.record(z.string(), z.string().max(160)).optional(),
    slots: z.record(z.string(), slotSchema).optional(),
    highlightTemplateId: z.string().max(64).nullable().optional(),
});
function teamIdByCode(db) {
    const rows = db.prepare('SELECT id, code FROM teams').all();
    return new Map(rows.map((r) => [r.code.trim().toUpperCase(), r.id]));
}
/** The board as the artwork has it, with its team codes resolved to the teams in the database. */
export function defaultState(db) {
    const layout = loadLayout();
    const byCode = teamIdByCode(db);
    const slots = Object.fromEntries(layout.slots.map((s) => {
        const st = defaultSlotState(s, byCode);
        return [s.id, { ...st, highlight: !!st.teamId && ARTWORK_HIGHLIGHTS.includes(s.id) }];
    }));
    const tpl = listTemplates(db).find((t) => t.fileName === HIGHLIGHT_FILE);
    return { texts: Object.fromEntries(layout.texts.map((t) => [t.id, t.text])), slots, highlightTemplateId: tpl?.id ?? null };
}
export function getState(db) {
    const def = defaultState(db);
    let saved = {};
    try {
        saved = JSON.parse(getSetting(db, 'matchboard.state') || '{}');
    }
    catch { /* defaults */ }
    const teams = new Set(db.prepare('SELECT id FROM teams').all().map((r) => r.id));
    const slots = { ...def.slots };
    for (const [id, s] of Object.entries(saved.slots ?? {}))
        if (id in slots)
            slots[id] = { ...s, teamId: s.teamId && teams.has(s.teamId) ? s.teamId : null };
    const texts = { ...def.texts };
    for (const [id, t] of Object.entries(saved.texts ?? {}))
        if (id in texts)
            texts[id] = t;
    const templates = new Set(listTemplates(db).map((t) => t.id));
    const tpl = saved.highlightTemplateId !== undefined ? saved.highlightTemplateId : def.highlightTemplateId;
    return { texts, slots, highlightTemplateId: tpl && templates.has(tpl) ? tpl : def.highlightTemplateId };
}
export function saveState(db, patch) {
    const p = statePatchSchema.parse(patch);
    const layout = loadLayout();
    const cur = getState(db);
    for (const [id, t] of Object.entries(p.texts ?? {})) {
        if (!layout.texts.some((x) => x.id === id))
            throw badRequest(`Unknown matchboard text “${id}”.`);
        cur.texts[id] = t;
    }
    for (const [id, s] of Object.entries(p.slots ?? {})) {
        if (!layout.slots.some((x) => x.id === id))
            throw badRequest(`Unknown matchboard row “${id}”.`);
        if (s.teamId && !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(s.teamId))
            throw badRequest('This team no longer exists.');
        cur.slots[id] = s;
    }
    if (p.highlightTemplateId !== undefined)
        cur.highlightTemplateId = p.highlightTemplateId;
    setSetting(db, 'matchboard.state', JSON.stringify(cur));
    return cur;
}
export function resetState(db) {
    db.prepare("DELETE FROM settings WHERE key = 'matchboard.state'").run();
    return getState(db);
}
// ---------- highlight element in the PNG generator ----------
/** Once: the generator gets a “Matchboard team” element the size of a row (79 × 26), with the waves, as in the artwork. */
export function seedHighlightTemplate(db, create) {
    if (getSetting(db, 'matchboard.template') === 'true')
        return;
    if (!listTemplates(db).length)
        return; // generator not seeded yet (no teams)
    if (!listTemplates(db).some((t) => t.fileName === HIGHLIGHT_FILE)) {
        create({ name: 'Matchboard team', fileName: HIGHLIGHT_FILE, variant: 1, width: 79, height: 26, radius: 0, opacity: 100, flip: false, angleOffset: 0,
            strokeWidth: 0, strokeColor: '#9a9a9a', strokeOpacity: 100, strokeGradient: false, strokeAngle: -45, pattern: true, patternOpacity: 10, patternScale: 30, enabled: true });
    }
    setSetting(db, 'matchboard.template', 'true');
}
/** Uploaded fonts stay in the data folder (next to assets, not mirrored and never in the repository: General Sans may not be redistributed). */
export const fontsDir = (assetsDir) => path.join(path.dirname(path.resolve(assetsDir)), 'fonts');
const SANS_FILE = /^GeneralSans-(\d{3})\.(otf|ttf|woff2?)$/;
export function uploadedSansFiles(assetsDir) {
    let names = [];
    try {
        names = fs.readdirSync(fontsDir(assetsDir));
    }
    catch {
        return [];
    }
    return names.map((n) => SANS_FILE.exec(n)).filter((m) => !!m)
        .map((m) => ({ weight: Number(m[1]), file: path.join(fontsDir(assetsDir), m[0]) })).sort((a, b) => a.weight - b.weight);
}
const WEIGHT_NAMES = [[/semi-?bold/i, 600], [/extra-?bold|black/i, 800], [/bold/i, 700], [/medium/i, 500], [/regular|book/i, 400], [/extra-?light/i, 200], [/light/i, 300]];
/** usWeightClass from the OS/2 table of an OTF/TTF; otherwise the weight in the file name. */
function weightOf(data, filename) {
    try {
        const n = data.readUInt16BE(4);
        for (let i = 0; i < n; i++) {
            const rec = 12 + i * 16;
            if (data.toString('latin1', rec, rec + 4) === 'OS/2')
                return data.readUInt16BE(data.readUInt32BE(rec + 8) + 4);
        }
    }
    catch { /* not sfnt */ }
    return WEIGHT_NAMES.find(([re]) => re.test(filename))?.[1] ?? 700;
}
/** OTF/TTF/WOFF/WOFF2 as is; an uncompressed EOT (as Fontshare ships it) is unwrapped to its OpenType data. */
export function fontFromUpload(buf, filename) {
    const tag = buf.subarray(0, 4).toString('latin1');
    const out = (ext) => ({ data: buf, ext, weight: weightOf(buf, filename) });
    if (tag === 'OTTO')
        return out('otf');
    if (tag === 'true' || buf.readUInt32BE(0) === 0x00010000)
        return out('ttf');
    if (tag === 'wOFF')
        return out('woff');
    if (tag === 'wOF2')
        return out('woff2');
    if (/\.eot$/i.test(filename) && buf.length > 16 && buf.readUInt32LE(0) === buf.length) {
        const size = buf.readUInt32LE(4), flags = buf.readUInt32LE(12);
        if (flags & 0x4)
            throw badRequest('This EOT file is compressed. Upload the .otf or .ttf file instead (e.g. GeneralSans-Bold.otf).');
        return fontFromUpload(buf.subarray(buf.length - size), filename.replace(/\.eot$/i, '.otf'));
    }
    throw badRequest('Upload a font file (.otf, .ttf, .woff, .woff2, .eot) or the GeneralSans zip from Fontshare.');
}
/** Files of a zip archive (stored or deflated), enough for a font package. */
export function readZip(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    if (eocd < 0)
        throw badRequest('This zip file cannot be read.');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const out = [];
    for (let i = 0; i < count && buf.readUInt32LE(p) === 0x02014b50; i++) {
        const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        out.push({ name, data: () => {
                const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
                const raw = buf.subarray(start, start + size);
                if (method === 0)
                    return raw;
                if (method === 8)
                    return zlib.inflateRawSync(raw);
                throw badRequest(`“${name}” in the zip uses an unsupported compression.`);
            } });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}
/** The upright static weights of General Sans in an upload (one font file, or the Fontshare zip). */
export function sansFontsFromUpload(buf, filename) {
    if (buf.readUInt32LE(0) !== 0x04034b50)
        return [fontFromUpload(buf, filename)];
    const files = readZip(buf).filter((f) => /GeneralSans-[A-Za-z]+\.(otf|ttf)$/.test(f.name) && !/italic|variable/i.test(f.name));
    // prefer the OTF folder, one file per weight
    files.sort((a, b) => Number(/\.ttf$/.test(a.name)) - Number(/\.ttf$/.test(b.name)));
    const byWeight = new Map();
    for (const f of files) {
        const font = fontFromUpload(f.data(), path.basename(f.name));
        if (!byWeight.has(font.weight))
            byWeight.set(font.weight, font);
    }
    if (!byWeight.size)
        throw badRequest('No General Sans font files (GeneralSans-Medium.otf, -Semibold.otf …) were found in this zip.');
    return [...byWeight.values()];
}
let canvasMod;
let canvasError = '';
async function canvas() {
    if (canvasMod !== undefined)
        return canvasMod;
    try {
        canvasMod = await import('@napi-rs/canvas');
    }
    catch (e) {
        canvasMod = null;
        canvasError = e.message;
    }
    return canvasMod;
}
export class MatchboardExporter {
    ctx;
    log;
    timer = null;
    fontsLoaded = '';
    lastWriteAt = null;
    lastError = null;
    constructor(ctx, log = () => { }) {
        this.ctx = ctx;
        this.log = log;
    }
    get file() { return path.join(this.ctx.assetsDir, ...MATCHBOARD_REL.split('/')); }
    /** Registers the bundled Space Grotesk and the uploaded General Sans weights (system fonts are found by the library itself). */
    async fonts() {
        const c = await canvas();
        const up = uploadedSansFiles(this.ctx.assetsDir);
        if (c) {
            const key = up.map((f) => `${f.file}:${fs.statSync(f.file).mtimeMs}`).join('|');
            if (this.fontsLoaded !== key) {
                c.GlobalFonts.registerFromPath(groteskPath(), FONT_GROTESK);
                for (const f of up)
                    c.GlobalFonts.registerFromPath(f.file, FONT_SANS);
                this.fontsLoaded = key;
            }
        }
        const system = !!c && !up.length && c.GlobalFonts.has(FONT_SANS);
        return { sans: { source: up.length ? 'uploaded' : system ? 'system' : 'missing', weights: up.map((f) => f.weight) }, grotesk: !!c };
    }
    /** Saves the uploaded weights (replacing those weights); a zip brings all of them at once. */
    async saveFonts(buf, filename) {
        const fonts = sansFontsFromUpload(buf, filename);
        const dir = fontsDir(this.ctx.assetsDir);
        fs.mkdirSync(dir, { recursive: true });
        for (const f of fonts) {
            for (const old of uploadedSansFiles(this.ctx.assetsDir))
                if (old.weight === f.weight)
                    fs.rmSync(old.file, { force: true });
            fs.writeFileSync(path.join(dir, `GeneralSans-${f.weight}.${f.ext}`), f.data);
        }
        this.fontsLoaded = ''; // re-register
        resetTextFit(); // the Team comparison measures its texts with them
        const info = await this.fonts();
        this.schedule(0);
        return info;
    }
    status() {
        const root = getSetting(this.ctx.db, 'paths.vmixAssetsRoot');
        return {
            file: this.file, vmixPath: root ? joinVmixPath(root, MATCHBOARD_REL) : null, exists: fs.existsSync(this.file),
            lastWriteAt: this.lastWriteAt, error: this.lastError ?? (canvasMod === null ? `Drawing library unavailable: ${canvasError}` : null),
        };
    }
    /** Export again shortly (several edits in a row produce one file). */
    schedule(ms = 400) {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; void this.render().catch((e) => { this.lastError = e.message; this.log(`Matchboard not exported: ${this.lastError}`); }); }, ms);
        this.timer.unref?.();
    }
    stop() { if (this.timer)
        clearTimeout(this.timer); }
    async renderBuffer() {
        const c = await canvas();
        if (!c)
            throw badRequest(`The matchboard cannot be drawn on this computer: ${canvasError}`);
        await this.fonts();
        const { db } = this.ctx;
        const layout = loadLayout();
        const state = getState(db);
        const tpl = listTemplates(db).find((t) => t.id === state.highlightTemplateId) ?? null;
        const gradients = new Map(listGradients(db).map((g) => [g.teamId, g.gradients]));
        const used = new Set([...resolveTeams(layout, state).values()].map((r) => r.teamId));
        const teams = new Map();
        for (const id of used) {
            const row = db.prepare('SELECT id, code FROM teams WHERE id = ?').get(id);
            if (!row)
                continue;
            const flagAsset = listAssets(this.ctx, 'team', id).flag_small;
            let flag = null;
            if (flagAsset?.storedPath && fs.existsSync(flagAsset.storedPath)) {
                try {
                    flag = await c.loadImage(fs.readFileSync(flagAsset.storedPath));
                }
                catch { /* unreadable flag */ }
            }
            teams.set(id, { id, code: row.code, flag, gradient: tpl ? gradients.get(id)?.[tpl.variant] ?? null : null });
        }
        const cv = c.createCanvas(layout.width, layout.height);
        const g = cv.getContext('2d');
        drawMatchboard(g, {
            layout, state, teams, background: await c.loadImage(fs.readFileSync(backgroundPath())),
            highlight: tpl, strokeGradient: getStrokeGradient(db),
            toImage: (r) => { const o = c.createCanvas(r.width, r.height); const octx = o.getContext('2d'); const id = octx.createImageData(r.width, r.height); id.data.set(r.data); octx.putImageData(id, 0, 0); return o; },
            fonts: { sans: `"${FONT_SANS}"`, grotesk: `"${FONT_GROTESK}"` },
        });
        return cv.toBuffer('image/png');
    }
    async render() {
        const buf = await this.renderBuffer();
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, this.file);
        this.lastWriteAt = nowIso();
        this.lastError = null;
        return this.status();
    }
}
