import { newId, nowIso } from '../db/db.js';
import { listAssets, removeAllForOwner } from './assets.js';
import { conflict, notFound } from './errors.js';
import { TEAM_SLOTS } from './slots.js';
function cleanAliases(a) {
    return JSON.stringify([...new Set((a ?? []).map((x) => x.trim()).filter(Boolean))]);
}
function assertCodeFree(db, code, exceptId) {
    const r = db.prepare('SELECT id, name FROM teams WHERE code = ? COLLATE NOCASE').get(code);
    if (r && r.id !== exceptId)
        throw conflict(`Code “${code}” is already used by team “${r.name}”.`);
}
export function createTeam(db, input, isDemo = false) {
    const code = input.code.trim();
    assertCodeFree(db, code);
    const id = newId();
    const t = nowIso();
    db.prepare('INSERT INTO teams (id, name, code, nickname, aliases, notes, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, input.name.trim(), code, (input.nickname ?? '').trim(), cleanAliases(input.aliases), input.notes ?? '', isDemo ? 1 : 0, t, t);
    return id;
}
export function updateTeam(db, id, input) {
    const cur = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
    if (!cur)
        throw notFound('Team');
    const code = input.code !== undefined ? input.code.trim() : cur.code;
    if (code !== cur.code)
        assertCodeFree(db, code, id);
    db.prepare('UPDATE teams SET name = ?, code = ?, nickname = ?, aliases = ?, notes = ?, updated_at = ? WHERE id = ?').run(input.name !== undefined ? input.name.trim() : cur.name, code, input.nickname !== undefined ? input.nickname.trim() : cur.nickname, input.aliases !== undefined ? cleanAliases(input.aliases) : cur.aliases, input.notes ?? cur.notes, nowIso(), id);
}
export function deleteTeam(ctx, id) {
    const sailors = ctx.db.prepare('SELECT id FROM sailors WHERE team_id = ?').all(id);
    const r = ctx.db.prepare('DELETE FROM teams WHERE id = ?').run(id);
    if (!r.changes)
        throw notFound('Team');
    removeAllForOwner(ctx, 'team', id);
    for (const s of sailors)
        removeAllForOwner(ctx, 'sailor', s.id);
}
export function teamDto(ctx, t) {
    const assets = listAssets(ctx, 'team', t.id);
    const filled = TEAM_SLOTS.filter((s) => assets[s.key]).length;
    const thumb = ['flag_small', 'flag_big', 'emblem_dark', 'emblem_light'].map((k) => assets[k]).find((a) => a);
    const sailorCount = ctx.db.prepare('SELECT COUNT(*) AS n FROM sailors WHERE team_id = ?').get(t.id).n;
    let aliases = [];
    try {
        aliases = JSON.parse(t.aliases);
    }
    catch { /* keep empty */ }
    return {
        id: t.id, name: t.name, code: t.code, nickname: t.nickname ?? '', aliases, notes: t.notes, isDemo: !!t.is_demo, updatedAt: t.updated_at,
        assets, assetsFilled: filled, assetsTotal: TEAM_SLOTS.length,
        thumb: thumb ? { slot: thumb.slot, previewUrl: thumb.previewUrl, checkStatus: thumb.checkStatus } : null,
        sailorCount,
    };
}
export function listTeams(ctx) {
    return ctx.db.prepare('SELECT * FROM teams ORDER BY name COLLATE NOCASE').all().map((t) => teamDto(ctx, t));
}
export function getTeam(ctx, id) {
    const t = ctx.db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
    if (!t)
        throw notFound('Team');
    return teamDto(ctx, t);
}
