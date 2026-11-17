import fs from 'node:fs';
import path from 'node:path';
import { getSetting, setSetting } from '../db/db.js';
import { badRequest } from './errors.js';
import { imagePath } from './graphicSets.js';
import { titleFieldMatcher } from './vmixResults.js';
/**
 * Graphics editor: what the producer typed over a vMix title's own fields (texts and pictures). Kept per input
 * (its title in lower case, without .gtzip) and per field (the title's own name, e.g. "TITLE.Text", "BG.Source").
 * Wherever the dashboard writes a title (show keys, lower thirds, results, the data sync) an edited field wins over
 * the dashboard's value, and an edited field the dashboard never fills is sent too. Only title inputs (GT / Xaml)
 * take them, and only through SetText / SetImage.
 *
 * Pictures are kept as a path in the assets folder (overrides/…, race-flags/…, Teams/…), turned into the vMix path
 * with imagePath() when sent; a full path typed by hand goes as it is.
 */
export const OVERRIDES_KEY = 'inputs.overrides';
/** What the title showed before its first edit, so Reset puts the template's own value back. */
export const BEFORE_KEY = 'inputs.overrides.before';
export const OVERRIDES_DIR = 'overrides';
export const inputKey = (title) => title.trim().toLowerCase().replace(/\.gtzip$/, '');
export const isTitleInput = (i) => /^(gt|xaml|title)/i.test(i.type ?? '');
function read(db, key) {
    try {
        const v = JSON.parse(getSetting(db, key) || '{}');
        return v && typeof v === 'object' ? v : {};
    }
    catch {
        return {};
    }
}
function write(db, key, v) {
    for (const k of Object.keys(v))
        if (!Object.keys(v[k]).length)
            delete v[k];
    setSetting(db, key, JSON.stringify(v));
}
export function getOverrides(db) { return read(db, OVERRIDES_KEY); }
export function overridesOf(db, title) { return getOverrides(db)[inputKey(title)] ?? {}; }
export function beforeOf(db, title) { return read(db, BEFORE_KEY)[inputKey(title)] ?? {}; }
/** Sets one field's override (null clears it). `current` is what vMix shows now, kept as the value Reset puts back. */
export function setOverride(db, title, field, value, current) {
    const k = inputKey(title);
    if (!k)
        throw badRequest('Name the vMix input.');
    if (!/\.(Text|Source)$/.test(field) || field.length > 200)
        throw badRequest('A field ends in .Text or .Source.');
    if (value !== null && value.length > 4000)
        throw badRequest('The text is too long.');
    const all = getOverrides(db);
    const before = read(db, BEFORE_KEY);
    if (value === null) {
        if (all[k])
            delete all[k][field];
        // an input with no edit left is not kept (the Graphics editor listed it as "Not in vMix" with nothing to reset)
        if (all[k] && !Object.keys(all[k]).length)
            delete all[k];
    }
    else {
        if (!(all[k] && field in all[k]) && current !== undefined)
            before[k] = { ...(before[k] ?? {}), [field]: current };
        all[k] = { ...(all[k] ?? {}), [field]: value };
    }
    write(db, OVERRIDES_KEY, all);
    if (value === null && before[k])
        delete before[k][field];
    write(db, BEFORE_KEY, before);
}
/** Clears every override of an input; returns the edited fields whose value before the edit is known, with that value. */
export function clearOverrides(db, title) {
    const k = inputKey(title);
    const all = getOverrides(db);
    const before = read(db, BEFORE_KEY);
    const out = Object.fromEntries(Object.keys(all[k] ?? {}).filter((f) => before[k]?.[f] !== undefined).map((f) => [f, before[k][f]]));
    delete all[k];
    delete before[k];
    write(db, OVERRIDES_KEY, all);
    write(db, BEFORE_KEY, before);
    return out;
}
/** The value vMix gets for an override: a picture in the assets folder becomes its vMix path. */
export function overrideValue(ctx, field, value) {
    return field.endsWith('.Source') ? imagePath(ctx.db, ctx.assetsDir, value) : value;
}
/**
 * The fields to send to a title with its overrides: an edited field takes the override (by the title's own field
 * name), the dashboard's value for it is dropped, and edited fields the dashboard does not fill are added.
 * A non-title input or one with no edits gets the fields unchanged.
 */
export function withOverrides(ctx, input, fields) {
    if (!isTitleInput(input))
        return fields;
    const ov = overridesOf(ctx.db, input.title);
    const edited = Object.keys(ov).filter((f) => input.fields.includes(f));
    if (!edited.length)
        return fields;
    const out = new Map();
    for (const f of edited)
        out.set(f, overrideValue(ctx, f, ov[f]));
    const match = titleFieldMatcher(input.fields);
    for (const [name, value] of fields) {
        const real = match(name) ?? name;
        if (out.has(real))
            continue;
        out.set(name, value);
    }
    return out;
}
/** Saves an uploaded PNG / JPG under overrides/ in the assets folder; returns its path there. */
export function saveOverrideImage(ctx, buf, filename) {
    const ext = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47 ? 'png' : buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : '';
    if (!ext)
        throw badRequest('The picture must be a PNG or JPG.');
    const base = path.basename(String(filename || 'picture')).replace(/\.[^.]+$/, '').replace(/[^\w() -]+/g, '_').slice(0, 80) || 'picture';
    const rel = `${OVERRIDES_DIR}/${base}.${ext}`;
    fs.mkdirSync(path.join(ctx.assetsDir, OVERRIDES_DIR), { recursive: true });
    fs.writeFileSync(path.join(ctx.assetsDir, ...rel.split('/')), buf);
    return rel;
}
/** Inputs of the Pan-American stage that vMix no longer has: their edits go once (1.0.230). */
const RETIRED_INPUTS = ['ssl_results_h', 'ssl_results_i'];
export function dropRetiredInputsOnStart(db) {
    if (getSetting(db, 'inputs.overrides.retired') === '1')
        return 0;
    const all = getOverrides(db), before = read(db, BEFORE_KEY);
    let n = 0;
    for (const k of RETIRED_INPUTS) {
        if (all[k])
            n++;
        delete all[k];
        delete before[k];
    }
    write(db, OVERRIDES_KEY, all);
    write(db, BEFORE_KEY, before);
    setSetting(db, 'inputs.overrides.retired', '1');
    return n;
}
