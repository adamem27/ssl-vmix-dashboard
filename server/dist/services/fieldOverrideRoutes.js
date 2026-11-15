import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getSetting } from '../db/db.js';
import { badRequest } from './errors.js';
import { beforeOf, clearOverrides, getOverrides, inputKey, isTitleInput, OVERRIDES_DIR, saveOverrideImage, setOverride } from './fieldOverrides.js';
import { getLtConfig } from './lowerthirds.js';
import { localCandidate } from './paths.js';
import { compareInput, resultsInput } from './show.js';
import { TEAM_SLOTS } from './slots.js';
import { listTeams } from './teams.js';
const TEAM_PICS = ['flag_small', 'flag_big', 'emblem_dark', 'emblem_light', 'background_1', 'background_2'];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const loose = (v) => v.toLowerCase().replace(/\.gtzip$/, '').replace(/[^a-z0-9]+/g, '').replace(/\d+$/, '');
/**
 * Graphics editor: every vMix title input with its fields, what vMix shows in each now and what the producer typed
 * over it; set or clear an edit, upload a picture for a field, list the pictures already in the assets folder.
 */
export function registerFieldOverrideRoutes(app, ctx, show) {
    const { db } = ctx;
    const assets = path.resolve(ctx.assetsDir);
    /** A picture path as a path in the assets folder (for a thumbnail), or '' when it is elsewhere. */
    const assetRel = (v) => {
        const s = (v ?? '').trim();
        if (!s)
            return '';
        if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(s))
            return s.replace(/\\/g, '/');
        const l = localCandidate(s, getSetting(db, 'paths.vmixAssetsRoot') ?? '', ctx.assetsDir);
        const full = l ? path.resolve(l) : '';
        return full.startsWith(assets + path.sep) ? path.relative(assets, full).split(path.sep).join('/') : '';
    };
    /** The graphic of the registry a title belongs to (by its input names, {n} / {crew} any number, per-group inputs). */
    const graphicOf = (graphics, title) => {
        const b = inputKey(title);
        const lt = getLtConfig(db);
        if ([lt.photoInput, lt.noPhotoInput].some((x) => x && inputKey(x) === b))
            return { id: 'lt', label: 'Lower thirds' };
        for (const g of graphics) {
            const hit = g.inputs.some((raw) => new RegExp(`^${esc(raw.toLowerCase()).replace(/\\\{(n|crew)\\\}/g, '\\d+')}$`).test(b))
                || (g.aliases ?? []).some((a) => loose(a) === loose(title))
                || (g.id === 'compare' && b.startsWith(compareInput('').toLowerCase()))
                || (g.id === 'results' && b.startsWith(resultsInput('').toLowerCase()));
            if (hit)
                return { id: g.id, label: g.label };
        }
        return null;
    };
    app.get('/api/vmix/editor', async () => {
        let inputs = [];
        let error = '';
        try {
            inputs = (await show.snapshot()).inputs;
        }
        catch (e) {
            error = e.message;
        }
        const graphics = show.graphics();
        const order = new Map([...graphics.map((g, i) => [g.id, i]), ['lt', graphics.length]]);
        const over = getOverrides(db);
        const seen = new Set();
        const row = (title, number, fields, values, inVmix) => {
            const ov = over[inputKey(title)] ?? {};
            return {
                title, number, inVmix, graphic: graphicOf(graphics, title),
                edited: Object.keys(ov).length,
                fields: [...new Set([...fields, ...Object.keys(ov)])].map((name) => {
                    const image = name.endsWith('.Source');
                    const current = values[name] ?? '';
                    const o = ov[name];
                    return { name, image, current, override: o ?? null, preview: image ? assetRel(o ?? current) : '' };
                }),
            };
        };
        const rows = [];
        for (const i of inputs) {
            if (!isTitleInput(i) || !i.fields.length)
                continue;
            const k = inputKey(i.title);
            if (seen.has(k))
                continue; // the same title loaded twice: one row (the edits go to both)
            seen.add(k);
            rows.push(row(i.title, i.number, i.fields, i.values ?? {}, true));
        }
        // edits of inputs vMix has not loaded now: listed so they can be seen and reset
        for (const k of Object.keys(over))
            if (!seen.has(k))
                rows.push(row(k, '', [], {}, false));
        rows.sort((a, b) => (order.get(a.graphic?.id ?? '') ?? 999) - (order.get(b.graphic?.id ?? '') ?? 999) || Number(a.number || 9999) - Number(b.number || 9999));
        return { inputs: rows, error };
    });
    const push = async (title, fields) => {
        try {
            const sent = await show.editFields(title, fields);
            void show.syncData().catch(() => undefined);
            return { sent };
        }
        catch (e) {
            return { sent: 0, warning: e.message };
        }
    };
    app.put('/api/vmix/editor/field', async (req) => {
        const b = z.object({ input: z.string().min(1).max(200), field: z.string().min(1).max(200), value: z.string().max(4000).nullable() }).parse(req.body);
        let current;
        try {
            current = (await show.snapshot()).inputs.find((i) => isTitleInput(i) && inputKey(i.title) === inputKey(b.input))?.values?.[b.field];
        }
        catch { /* vMix not reachable */ }
        const prev = beforeOf(db, b.input)[b.field];
        setOverride(db, b.input, b.field, b.value, current);
        // a cleared field gets back what the title showed before the edit (the data sync then puts the dashboard's value)
        return { ok: true, ...(await push(b.input, b.value === null && prev !== undefined ? new Map([[b.field, prev]]) : new Map())) };
    });
    app.delete('/api/vmix/editor/input', async (req) => {
        const title = String(req.query.input ?? '');
        if (!title.trim())
            throw badRequest('Add ?input=<vMix input title>.');
        const back = clearOverrides(db, title);
        return { ok: true, ...(await push(title, new Map(Object.entries(back)))) };
    });
    app.post('/api/vmix/editor/upload', async (req) => {
        const file = await req.file();
        if (!file)
            throw badRequest('No file was uploaded.');
        return { path: saveOverrideImage(ctx, await file.toBuffer(), file.filename) };
    });
    // pictures to pick from: uploaded for the editor, race flags, icons, and the teams' flags, emblems and backgrounds
    app.get('/api/vmix/editor/images', async () => {
        const out = [];
        for (const [d, group] of [[OVERRIDES_DIR, 'Uploaded'], ['race-flags', 'Race flags'], ['icons', 'Icons']]) {
            try {
                for (const f of fs.readdirSync(path.join(ctx.assetsDir, d)).sort())
                    if (/\.(png|jpe?g)$/i.test(f))
                        out.push({ value: `${d}/${f}`, label: f, group });
            }
            catch { /* none yet */ }
        }
        const label = new Map(TEAM_SLOTS.map((s) => [s.key, s.label]));
        for (const t of listTeams(ctx)) {
            for (const slot of TEAM_PICS) {
                const a = t.assets[slot];
                const rel = a?.storedPath ? assetRel(a.storedPath) || path.relative(assets, path.resolve(a.storedPath)).split(path.sep).join('/') : '';
                if (rel && !rel.startsWith('..'))
                    out.push({ value: rel, label: `${t.code} · ${label.get(slot) ?? slot}`, group: 'Teams' });
            }
        }
        return out;
    });
}
