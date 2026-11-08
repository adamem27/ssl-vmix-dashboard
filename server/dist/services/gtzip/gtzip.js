/**
 * GTZIP generator: vMix GT Title (.gtzip) templates in, new single .gtzip files out.
 *
 * Templates are stored untouched in <data>/gtzip-templates (never modified, only read).
 * Generated titles go to <assets>/gtzip/<name>.gtzip, so they reach the vMix machine with the assets mirror.
 * Generating never overwrites: an existing name is refused (409).
 *
 * The package format (checked byte for byte against files saved by GT Title Designer):
 * a stored zip with document.xml (UTF-8 bytes, utf-16 declaration, CRLF, 2-space indent), resources.xml
 * (Bitmap Source "<folder guid>\\name.png" → part guid), [Content_Types].xml (BOM, one Override per part),
 * the image parts named by guid and thumbnail.png (640×360).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../errors.js';
import { readZip } from '../matchboard/matchboard.js';
import { zipStore } from '../xlsx.js';
import { joinVmixPath } from '../paths.js';
import { drawTitle } from './draw.js';
import { clone, elements, fields, parseXml, serializeXml, sourceName } from './model.js';
export const GTZIP_DIR = 'gtzip';
const DOC = 'document.xml', RES = 'resources.xml', CT = '[Content_Types].xml', THUMB = 'thumbnail.png';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const DEFAULT_DECL = '<?xml version="1.0" encoding="utf-16"?>';
function decode(b) {
    if (b[0] === 0xff && b[1] === 0xfe)
        return b.subarray(2).toString('utf16le');
    if (b[0] === 0xfe && b[1] === 0xff) {
        const c = Buffer.from(b.subarray(2));
        c.swap16();
        return c.toString('utf16le');
    }
    if (b[0] === 0x3c && b[1] === 0x00)
        return b.toString('utf16le');
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)
        return b.subarray(3).toString('utf8');
    return b.toString('utf8');
}
export function loadPackage(buf) {
    let entries;
    try {
        entries = readZip(buf);
    }
    catch {
        throw badRequest('This is not a .gtzip file (it is not a zip archive).');
    }
    const files = new Map();
    for (const e of entries)
        if (!e.name.endsWith('/'))
            files.set(e.name, e.data());
    if (!files.has(DOC))
        throw badRequest('This is not a GT title: document.xml is missing.');
    try {
        const d = parseXml(decode(files.get(DOC)));
        if (d.root.tag !== 'Composition')
            throw new Error('root is not a Composition');
        const res = files.has(RES) ? parseXml(decode(files.get(RES))).root : { tag: 'resources', attrs: {}, children: [] };
        const c = files.has(CT) ? parseXml(decode(files.get(CT))) : { decl: '<?xml version="1.0" encoding="utf-8"?>', root: emptyCt() };
        return { files, order: entries.map((e) => e.name), decl: d.decl || DEFAULT_DECL, doc: d.root, res, ctDecl: c.decl || '<?xml version="1.0" encoding="utf-8"?>', ct: c.root };
    }
    catch (e) {
        throw badRequest(`The title cannot be read: ${e.message}`);
    }
}
function emptyCt() {
    return { tag: 'Types', attrs: { xmlns: CT_NS }, children: [
            { tag: 'Default', attrs: { Extension: 'xml', ContentType: 'text/xml' }, children: [] },
            { tag: 'Default', attrs: { Extension: 'png', ContentType: 'image/png' }, children: [] }
        ] };
}
export function savePackage(p) {
    const files = new Map(p.files);
    files.set(DOC, Buffer.from(p.decl + '\r\n' + serializeXml(p.doc, true), 'utf8'));
    files.set(RES, Buffer.from(serializeXml(p.res, false), 'utf8'));
    files.set(CT, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(p.ctDecl + serializeXml(p.ct, false), 'utf8')]));
    const tail = [RES, DOC, THUMB, CT];
    const parts = p.order.filter((n) => files.has(n) && !tail.includes(n));
    for (const n of files.keys())
        if (!parts.includes(n) && !tail.includes(n))
            parts.push(n);
    return zipStore([...parts, ...tail.filter((t) => files.has(t))].map((n) => [n, files.get(n)]));
}
/** The image part behind a Bitmap Source, or null when the title leaves it to vMix (placeholder). */
export function resourcePart(p, source) {
    const r = p.res.children.find((x) => x.tag === 'resource' && x.attrs.filename === source);
    if (!r)
        return null;
    const srcs = r.children.filter((s) => s.tag === 'source');
    return (srcs.find((s) => s.text === source && p.files.has(s.attrs.guid)) ?? srcs.find((s) => p.files.has(s.attrs.guid)))?.attrs.guid ?? null;
}
function addImage(p, data, displayName) {
    const folder = crypto.randomUUID(), part = crypto.randomUUID();
    const filename = `${folder}\\${displayName}`;
    p.res.children.push({ tag: 'resource', attrs: { filename }, children: [{ tag: 'source', attrs: { guid: part }, children: [], text: filename }] });
    p.files.set(part, data);
    p.ct.children.push({ tag: 'Override', attrs: { PartName: `/${part}`, ContentType: 'application/octet-stream' }, children: [] });
    return filename;
}
/** Drops images no Bitmap uses any more (removed or replaced elements). */
function pruneResources(p) {
    const used = new Set();
    const walk = (n) => { if (n.tag === 'Bitmap' && n.attrs.Source)
        used.add(n.attrs.Source); n.children.forEach(walk); };
    walk(p.doc);
    const keep = new Set(p.res.children.filter((r) => used.has(r.attrs.filename)).flatMap((r) => r.children.map((s) => s.attrs.guid)));
    p.res.children = p.res.children.filter((r) => {
        if (used.has(r.attrs.filename))
            return true;
        for (const s of r.children) {
            const g = s.attrs.guid;
            if (!g || keep.has(g))
                continue;
            p.files.delete(g);
            p.ct.children = p.ct.children.filter((o) => o.attrs.PartName !== `/${g}`);
        }
        return false;
    });
}
export function sniffMime(b) {
    if (b[0] === 0x89 && b[1] === 0x50)
        return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8)
        return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49)
        return 'image/gif';
    if (b[0] === 0x42 && b[1] === 0x4d)
        return 'image/bmp';
    return 'application/octet-stream';
}
// ---------- document schema (what the editor sends back) ----------
const nodeSchema = z.lazy(() => z.object({
    tag: z.string().min(1).max(100).regex(/^[A-Za-z_][\w.:-]*$/),
    attrs: z.record(z.string().max(100), z.string().max(20000)),
    children: z.array(nodeSchema).max(5000),
    text: z.string().max(20000).optional(),
}));
export const generateSchema = z.object({
    templateId: z.string().min(1).max(100),
    fileName: z.string().min(1).max(120),
    doc: nodeSchema,
    thumbnail: z.boolean().default(true),
});
export function safeFileName(raw) {
    const n = raw.trim().replace(/\.gtzip$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').replace(/[. ]+$/, '');
    if (!n)
        throw badRequest('Enter a file name.');
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n))
        throw badRequest('This file name is reserved on Windows.');
    return n;
}
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'title';
let canvasMod;
async function canvas() {
    if (canvasMod === undefined) {
        try {
            canvasMod = await import('@napi-rs/canvas');
        }
        catch {
            canvasMod = null;
        }
    }
    return canvasMod;
}
export class GtzipService {
    ctx;
    vmixRoot;
    loadFonts;
    templatesDir;
    uploadsDir;
    outputsDir;
    constructor(ctx, vmixRoot = () => null, loadFonts = async () => { }) {
        this.ctx = ctx;
        this.vmixRoot = vmixRoot;
        this.loadFonts = loadFonts;
        const data = path.dirname(path.resolve(ctx.assetsDir));
        this.templatesDir = path.join(data, 'gtzip-templates');
        this.uploadsDir = path.join(data, 'gtzip-uploads');
        this.outputsDir = path.join(ctx.assetsDir, GTZIP_DIR);
    }
    // ----- templates -----
    metaPath(id) { return path.join(this.templatesDir, `${id}.json`); }
    tplPath(id) {
        if (!/^[\w-]{1,100}$/.test(id))
            throw notFound('Template');
        return path.join(this.templatesDir, `${id}.gtzip`);
    }
    listTemplates() {
        if (!fs.existsSync(this.templatesDir))
            return [];
        return fs.readdirSync(this.templatesDir).filter((f) => f.endsWith('.json') && f !== 'outputs.json').map((f) => {
            try {
                return JSON.parse(fs.readFileSync(path.join(this.templatesDir, f), 'utf8'));
            }
            catch {
                return null;
            }
        }).filter((m) => !!m && typeof m.id === 'string' && fs.existsSync(this.tplPath(m.id))).sort((a, b) => a.name.localeCompare(b.name));
    }
    addTemplate(buf, originalFilename, name) {
        const p = loadPackage(buf);
        const base = name?.trim() || originalFilename.replace(/\.gtzip$/i, '');
        fs.mkdirSync(this.templatesDir, { recursive: true });
        const id = `${slug(base)}-${crypto.randomBytes(3).toString('hex')}`;
        fs.writeFileSync(this.tplPath(id), buf);
        const meta = {
            id, name: base.slice(0, 120), originalFilename: originalFilename.slice(0, 200), uploadedAt: new Date().toISOString(), size: buf.length,
            width: Number(p.doc.attrs.Width ?? 1920), height: Number(p.doc.attrs.Height ?? 1080),
            elements: elements(p.doc).length, fields: fields(p.doc).length, storyboards: p.doc.children.filter((c) => c.tag === 'Storyboard').length,
        };
        fs.writeFileSync(this.metaPath(id), JSON.stringify(meta, null, 2));
        return meta;
    }
    meta(id) {
        const f = this.metaPath(id);
        if (!fs.existsSync(this.tplPath(id)) || !fs.existsSync(f))
            throw notFound('Template');
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    }
    renameTemplate(id, name) {
        const m = { ...this.meta(id), name: name.trim().slice(0, 120) || this.meta(id).name };
        fs.writeFileSync(this.metaPath(id), JSON.stringify(m, null, 2));
        return m;
    }
    deleteTemplate(id) {
        this.meta(id);
        fs.rmSync(this.tplPath(id), { force: true });
        fs.rmSync(this.metaPath(id), { force: true });
    }
    pkg(id) { this.meta(id); return loadPackage(fs.readFileSync(this.tplPath(id))); }
    /** The template's document and, for every Bitmap Source, whether the picture is embedded. */
    template(id) {
        const meta = this.meta(id);
        const p = this.pkg(id);
        const images = {};
        const walk = (n) => { if (n.tag === 'Bitmap' && n.attrs.Source)
            images[n.attrs.Source] = { embedded: !!resourcePart(p, n.attrs.Source), name: sourceName(n.attrs.Source) }; n.children.forEach(walk); };
        walk(p.doc);
        return { meta, doc: p.doc, images };
    }
    templateFile(id) { this.meta(id); return this.tplPath(id); }
    /** Bytes of an image: a template resource, an uploaded picture (upload:…) or a file from the assets folder (asset:…). */
    image(templateId, source) {
        if (source.startsWith('upload:')) {
            const f = source.slice(7);
            if (!/^[\w.() -]{1,200}$/.test(f) || f.startsWith('.'))
                throw notFound('Image');
            const full = path.join(this.uploadsDir, f);
            if (!fs.existsSync(full))
                throw notFound('Image');
            return fs.readFileSync(full);
        }
        if (source.startsWith('asset:')) {
            const root = path.resolve(this.ctx.assetsDir);
            const full = path.resolve(root, ...source.slice(6).split('/'));
            if (!full.startsWith(root + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile())
                throw notFound('Image');
            return fs.readFileSync(full);
        }
        if (!templateId)
            throw notFound('Image');
        const p = this.pkg(templateId);
        const part = resourcePart(p, source);
        if (!part)
            throw notFound('Image');
        return p.files.get(part);
    }
    thumbnailOf(templateId) { return this.pkg(templateId).files.get(THUMB) ?? null; }
    saveUpload(buf, filename) {
        const mime = sniffMime(buf);
        if (!mime.startsWith('image/'))
            throw badRequest('Upload a PNG or JPG picture.');
        const ext = mime === 'image/jpeg' ? '.jpg' : '.' + mime.slice(6);
        const base = path.basename(filename).replace(/\.[^.]+$/, '').replace(/[^\w() -]+/g, '_').slice(0, 80) || 'image';
        const stored = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12)}-${base}${ext}`;
        fs.mkdirSync(this.uploadsDir, { recursive: true });
        fs.writeFileSync(path.join(this.uploadsDir, stored), buf);
        return { source: `upload:${stored}`, name: base + ext };
    }
    /** Pictures already in the dashboard's assets folder (PNG generator output, team graphics, …). */
    assetImages() {
        const out = [];
        const walk = (dir, rel) => {
            let list;
            try {
                list = fs.readdirSync(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const e of list) {
                if (out.length >= 5000)
                    return;
                const r = rel ? `${rel}/${e.name}` : e.name;
                if (e.isDirectory()) {
                    if (r !== GTZIP_DIR)
                        walk(path.join(dir, e.name), r);
                }
                else if (/\.(png|jpe?g)$/i.test(e.name))
                    out.push({ source: `asset:${r}`, rel: r, size: fs.statSync(path.join(dir, e.name)).size });
            }
        };
        walk(this.ctx.assetsDir, '');
        return out.sort((a, b) => a.rel.localeCompare(b.rel));
    }
    // ----- generate -----
    outputPath(name) { return path.join(this.outputsDir, `${name}.gtzip`); }
    exists(name) {
        const want = `${name}.gtzip`.toLowerCase();
        return fs.existsSync(this.outputsDir) && fs.readdirSync(this.outputsDir).some((f) => f.toLowerCase() === want);
    }
    /** A free name like “Line-up 10 (2)”. */
    freeName(name) {
        const n = safeFileName(name);
        if (!this.exists(n))
            return n;
        const base = n.replace(/ \(\d+\)$/, '');
        for (let i = 2;; i++)
            if (!this.exists(`${base} (${i})`))
                return `${base} (${i})`;
    }
    async generate(input) {
        const name = safeFileName(input.fileName);
        if (this.exists(name))
            throw conflict(`“${name}.gtzip” already exists. Generating never replaces a file – choose another name.`, { suggestion: this.freeName(name) });
        if (input.doc.tag !== 'Composition')
            throw badRequest('The title must start with a Composition.');
        const p = this.pkg(input.templateId);
        p.doc = input.doc;
        // embed new pictures; the same picture used twice is stored once
        const added = new Map();
        const bitmaps = [];
        const walk = (n) => { if (n.tag === 'Bitmap')
            bitmaps.push(n); n.children.forEach(walk); };
        walk(p.doc);
        for (const b of bitmaps) {
            const s = b.attrs.Source ?? '';
            if (!s.startsWith('upload:') && !s.startsWith('asset:'))
                continue;
            if (!added.has(s))
                added.set(s, addImage(p, this.image(null, s), s.startsWith('upload:') ? s.slice(7).replace(/^[0-9a-f]{12}-/, '') : path.basename(s.slice(6))));
            b.attrs.Source = added.get(s);
        }
        pruneResources(p);
        if (input.thumbnail) {
            const t = await this.renderThumbnail(p).catch(() => null);
            if (t)
                p.files.set(THUMB, t);
        }
        const buf = savePackage(p);
        loadPackage(buf); // sanity check: the file reads back
        fs.mkdirSync(this.outputsDir, { recursive: true });
        const final = this.outputPath(name);
        const tmp = `${final}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, buf);
        try {
            fs.linkSync(tmp, final);
        } // fails if the file appeared meanwhile – never overwrite
        catch {
            throw conflict(`“${name}.gtzip” already exists.`, { suggestion: this.freeName(name) });
        }
        finally {
            fs.rmSync(tmp, { force: true });
        }
        this.recordOrigin(name, input.templateId);
        return this.outputInfo(`${name}.gtzip`);
    }
    originsFile() { return path.join(this.templatesDir, 'outputs.json'); }
    origins() { try {
        return JSON.parse(fs.readFileSync(this.originsFile(), 'utf8'));
    }
    catch {
        return {};
    } }
    recordOrigin(name, templateId) {
        fs.mkdirSync(this.templatesDir, { recursive: true });
        fs.writeFileSync(this.originsFile(), JSON.stringify({ ...this.origins(), [name.toLowerCase()]: templateId }, null, 2));
    }
    outputInfo(file) {
        const full = path.join(this.outputsDir, file);
        if (!fs.existsSync(full))
            return null;
        const st = fs.statSync(full);
        const name = file.replace(/\.gtzip$/i, '');
        const root = this.vmixRoot();
        return { name, file, size: st.size, createdAt: st.mtime.toISOString(), vmixPath: root ? joinVmixPath(root, `${GTZIP_DIR}/${file}`) : null, templateId: this.origins()[name.toLowerCase()] ?? null };
    }
    listOutputs() {
        if (!fs.existsSync(this.outputsDir))
            return [];
        return fs.readdirSync(this.outputsDir).filter((f) => /\.gtzip$/i.test(f)).map((f) => this.outputInfo(f)).filter(Boolean)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    outputFile(name) {
        const n = safeFileName(name);
        const f = fs.existsSync(this.outputsDir) ? fs.readdirSync(this.outputsDir).find((x) => x.toLowerCase() === `${n}.gtzip`.toLowerCase()) : null;
        if (!f)
            throw notFound('File');
        return path.join(this.outputsDir, f);
    }
    /** Makes a generated title a template of its own (the generated file stays as it is). */
    outputToTemplate(name) {
        const f = this.outputFile(name);
        return this.addTemplate(fs.readFileSync(f), path.basename(f));
    }
    async renderThumbnail(p, width = 640) {
        const c = await canvas();
        if (!c)
            return null;
        await this.loadFonts();
        const W = Number(p.doc.attrs.Width ?? 1920), H = Number(p.doc.attrs.Height ?? 1080);
        const s = width / W;
        const cv = c.createCanvas(Math.round(W * s), Math.round(H * s));
        const ctx = cv.getContext('2d');
        const imgs = new Map();
        const walk = (n) => { if (n.tag === 'Bitmap' && n.attrs.Source)
            imgs.set(n.attrs.Source, null); n.children.forEach(walk); };
        walk(p.doc);
        for (const src of imgs.keys()) {
            const part = resourcePart(p, src);
            if (!part)
                continue;
            try {
                const im = await c.loadImage(p.files.get(part));
                imgs.set(src, { img: im, width: im.width, height: im.height });
            }
            catch { /* unreadable picture */ }
        }
        ctx.scale(s, s);
        drawTitle(ctx, p.doc, { image: (src) => imgs.get(src) ?? null, fallbackFont: 'Space Grotesk' });
        return cv.toBuffer('image/png');
    }
    /** Renders any document (editor state) to PNG with the template's pictures, for checks and tests. */
    async renderDoc(templateId, doc, width = 640) {
        const p = this.pkg(templateId);
        p.doc = clone(doc);
        for (const b of collect(p.doc, 'Bitmap')) {
            const s = b.attrs.Source ?? '';
            if (s.startsWith('upload:') || s.startsWith('asset:'))
                b.attrs.Source = addImage(p, this.image(null, s), 'x.png');
        }
        return this.renderThumbnail(p, width);
    }
}
function collect(n, tag, out = []) { if (n.tag === tag)
    out.push(n); n.children.forEach((c) => collect(c, tag, out)); return out; }
