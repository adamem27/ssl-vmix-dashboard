import { getSetting, newId, nowIso, setSetting } from '../db/db.js';
import { badRequest, notFound } from './errors.js';
export const GRAPHIC_KINDS = [
    {
        kind: 'welcome', label: 'Welcome', sheet: 'Welcome',
        description: 'Opening board: event name, place and dates.',
        fields: [
            { key: 'event', label: 'Event', default: 'SSL GOLD CUP 2026' },
            { key: 'stage', label: 'Stage', placeholder: 'FINAL SERIES' },
            { key: 'location', label: 'Location', default: 'RIO DE JANEIRO, BRAZIL' },
            { key: 'dates', label: 'Dates', placeholder: '19 NOV - 13 DEC 2026' },
            { key: 'day', label: 'Day', placeholder: 'DAY 1' },
            { key: 'subtitle', label: 'Subtitle', wide: true },
        ],
        defaults: [{ name: 'Welcome', data: {} }],
    },
    {
        kind: 'announcement', label: 'Announcements', sheet: 'Announcements',
        description: 'Short bars such as FALSE START or ANNOUNCEMENT.',
        fields: [
            { key: 'text', label: 'Text', wide: true, default: 'ANNOUNCEMENT' },
        ],
        defaults: [{ name: 'Announcement', data: {} }, { name: 'False start', data: { text: 'FALSE START' } }],
    },
    {
        kind: 'ticker', label: 'Tickers', sheet: 'Tickers',
        description: 'Scrolling bars. One message per line; the separator is put between them and after the last, so the text loops.',
        fields: [
            { key: 'position', label: 'Position', type: 'select', options: ['Top', 'Bottom'], default: 'Bottom' },
            { key: 'label', label: 'Label', placeholder: 'LIVE' },
            { key: 'separator', label: 'Separator', default: ' I ' },
            { key: 'items', label: 'Messages', type: 'list', wide: true, hint: 'One message per line' },
        ],
        defaults: [
            { name: 'Top ticker', data: { position: 'Top', items: 'SSL GOLD CUP 2026\nRIO DE JANEIRO, BRAZIL' } },
            { name: 'Bottom ticker', data: { position: 'Bottom', items: 'RACE 2 WILL START SOON' } },
        ],
    },
    {
        kind: 'officials', label: 'Race officials', sheet: 'Race officials',
        description: 'Principal race officer, regatta director and jury.',
        fields: [
            { key: 'heading', label: 'Heading', default: 'RACE OFFICIALS' },
            { key: 'pro_title', label: 'PRO title', default: 'PRINCIPAL RACE OFFICER' },
            { key: 'pro_name', label: 'PRO name' },
            { key: 'director_title', label: 'Director title', default: 'REGATTA DIRECTOR' },
            { key: 'director_name', label: 'Director name' },
            { key: 'jury_title', label: 'Jury title', default: 'JURY' },
            { key: 'jury_1', label: 'Jury 1' },
            { key: 'jury_2', label: 'Jury 2' },
            { key: 'jury_3', label: 'Jury 3' },
            { key: 'jury_4', label: 'Jury 4' },
            { key: 'jury_5', label: 'Jury 5' },
        ],
        defaults: [{ name: 'Race officials', data: {} }],
    },
    {
        kind: 'socials', label: 'Follow us', sheet: 'Follow us',
        description: 'Social media bar and side panel.',
        fields: [
            { key: 'website', label: 'Website', default: 'WWW.WORLDOFSAILORS.COM' },
            { key: 'facebook', label: 'Facebook', default: '@SSLGOLDCUP' },
            { key: 'youtube', label: 'YouTube', default: '@STARSAILORS' },
            { key: 'instagram', label: 'Instagram', default: '@SSLGOLDCUP' },
            { key: 'tiktok', label: 'TikTok' },
            { key: 'x', label: 'X' },
            { key: 'hashtag', label: 'Hashtag', placeholder: '#SSLGOLDCUP' },
        ],
        defaults: [{ name: 'Follow us', data: {} }],
    },
];
const kindOf = (kind) => {
    const k = GRAPHIC_KINDS.find((x) => x.kind === kind);
    if (!k)
        throw badRequest(`Unknown graphic: ${kind}`);
    return k;
};
function clean(k, data, base) {
    const out = { ...base };
    for (const f of k.fields)
        if (data[f.key] !== undefined)
            out[f.key] = String(data[f.key] ?? '').slice(0, f.type === 'list' ? 4000 : 500);
    return out;
}
const fromRow = (r) => {
    let data = {};
    try {
        data = JSON.parse(r.data);
    }
    catch { /* empty */ }
    // announcements had a separate heading: an announcement with only a heading keeps it as its text
    if (r.kind === 'announcement' && data.heading && !data.text)
        data = { ...data, text: data.heading };
    return { id: r.id, kind: r.kind, name: r.name, data, sort: r.sort, updatedAt: r.updated_at };
};
/** Adds the default versions once per event (deleting them later is respected). */
export function seedGraphicSets(db, eventId) {
    const flag = `graphicSets.seeded.${eventId}`;
    if (getSetting(db, flag))
        return;
    for (const k of GRAPHIC_KINDS) {
        if (db.prepare('SELECT 1 FROM graphic_sets WHERE event_id = ? AND kind = ?').get(eventId, k.kind))
            continue;
        for (const d of k.defaults)
            createGraphicSet(db, eventId, k.kind, d.name, d.data);
    }
    setSetting(db, flag, '1');
}
export function listGraphicSets(db, eventId, kind) {
    const rows = db.prepare(`SELECT * FROM graphic_sets WHERE event_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY kind, sort, created_at`).all(...(kind ? [eventId, kind] : [eventId]));
    return rows.map(fromRow);
}
export function createGraphicSet(db, eventId, kind, name, data = {}, copyFrom) {
    const k = kindOf(kind);
    let base = Object.fromEntries(k.fields.map((f) => [f.key, f.default ?? '']));
    if (copyFrom) {
        const src = db.prepare('SELECT * FROM graphic_sets WHERE id = ? AND kind = ?').get(copyFrom, kind);
        if (!src)
            throw notFound('Graphic version');
        base = { ...base, ...fromRow(src).data };
    }
    const id = newId();
    const t = nowIso();
    const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM graphic_sets WHERE event_id = ? AND kind = ?').get(eventId, kind).n;
    db.prepare('INSERT INTO graphic_sets (id, event_id, kind, name, data, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, eventId, kind, name.trim().slice(0, 80) || k.label, JSON.stringify(clean(k, data, base)), sort, t, t);
    return id;
}
export function updateGraphicSet(db, id, patch) {
    const r = db.prepare('SELECT * FROM graphic_sets WHERE id = ?').get(id);
    if (!r)
        throw notFound('Graphic version');
    const cur = fromRow(r);
    const k = kindOf(cur.kind);
    const name = patch.name !== undefined ? patch.name.trim().slice(0, 80) || cur.name : cur.name;
    const data = patch.data ? clean(k, patch.data, cur.data) : cur.data;
    db.prepare('UPDATE graphic_sets SET name = ?, data = ?, updated_at = ? WHERE id = ?').run(name, JSON.stringify(data), nowIso(), id);
    return fromRow(db.prepare('SELECT * FROM graphic_sets WHERE id = ?').get(id));
}
export function deleteGraphicSet(db, id) {
    if (!db.prepare('DELETE FROM graphic_sets WHERE id = ?').run(id).changes)
        throw notFound('Graphic version');
}
/** Moves a version up or down among the versions of its graphic (row order in the sheet). */
export function moveGraphicSet(db, id, dir) {
    const r = db.prepare('SELECT * FROM graphic_sets WHERE id = ?').get(id);
    if (!r)
        throw notFound('Graphic version');
    const list = db.prepare('SELECT id FROM graphic_sets WHERE event_id = ? AND kind = ? ORDER BY sort, created_at').all(r.event_id, r.kind);
    const i = list.findIndex((x) => x.id === id), j = i + dir;
    if (j < 0 || j >= list.length)
        return;
    [list[i], list[j]] = [list[j], list[i]];
    const upd = db.prepare('UPDATE graphic_sets SET sort = ? WHERE id = ?');
    db.transaction(() => list.forEach((x, n) => upd.run(n + 1, x.id)))();
}
/** Ticker text: messages joined with the separator, which also closes the text so a scrolling ticker loops cleanly. */
export function tickerText(data) {
    const items = (data.items ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!items.length)
        return '';
    const sep = data.separator || ' I ';
    return items.join(sep) + sep;
}
/** Sheet rows for one graphic: one per version, `set` first, then every field (tickers also get `text`). */
export function graphicSheetRows(db, eventId, kind) {
    const k = kindOf(kind);
    return listGraphicSets(db, eventId, kind).map((s) => {
        const row = { set: s.name };
        for (const f of k.fields)
            row[f.key] = f.type === 'list' ? (s.data[f.key] ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join(' | ') : s.data[f.key] ?? '';
        if (kind === 'ticker')
            row.text = tickerText(s.data);
        return row;
    });
}
