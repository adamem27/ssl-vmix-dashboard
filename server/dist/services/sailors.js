import { newId, nowIso } from '../db/db.js';
import { listAssets, removeAllForOwner } from './assets.js';
import { notFound } from './errors.js';
import { nameKey } from './normalize.js';
import { activeEvent } from '../db/db.js';
import { todayIn } from './dates.js';
import { ageOn } from './sailorDetails.js';
export function createSailor(db, teamId, input, isDemo = false) {
    if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId))
        throw notFound('Team');
    const id = newId();
    const t = nowIso();
    const first = (input.firstName ?? '').trim();
    const last = (input.lastName ?? '').trim();
    db.prepare(`INSERT INTO sailors (id, team_id, first_name, last_name, name_key, default_position, default_number, best_result_1, best_result_2, best_result_3, source_ref, is_demo, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, teamId, first, last, nameKey(`${first} ${last}`), (input.defaultPosition ?? '').trim(), (input.defaultNumber ?? '').trim(), input.bestResult1 ?? '', input.bestResult2 ?? '', input.bestResult3 ?? '', input.sourceRef ?? null, isDemo ? 1 : 0, t, t);
    return id;
}
export function updateSailor(db, id, input) {
    const s = db.prepare('SELECT * FROM sailors WHERE id = ?').get(id);
    if (!s)
        throw notFound('Sailor');
    const first = input.firstName !== undefined ? input.firstName.trim() : s.first_name;
    const last = input.lastName !== undefined ? input.lastName.trim() : s.last_name;
    db.prepare(`UPDATE sailors SET first_name = ?, last_name = ?, name_key = ?, default_position = ?, default_number = ?, best_result_1 = ?, best_result_2 = ?, best_result_3 = ?, source_ref = ?, updated_at = ? WHERE id = ?`)
        .run(first, last, nameKey(`${first} ${last}`), input.defaultPosition !== undefined ? input.defaultPosition.trim() : s.default_position, input.defaultNumber !== undefined ? input.defaultNumber.trim() : s.default_number, input.bestResult1 ?? s.best_result_1, input.bestResult2 ?? s.best_result_2, input.bestResult3 ?? s.best_result_3, input.sourceRef !== undefined ? input.sourceRef : s.source_ref, nowIso(), id);
    if (input.birthDate !== undefined || input.heightCm !== undefined) {
        db.prepare('UPDATE sailors SET birth_date = ?, height_cm = ? WHERE id = ?')
            .run(input.birthDate !== undefined ? input.birthDate : s.birth_date, input.heightCm !== undefined ? input.heightCm : s.height_cm, id);
    }
}
/** One captain per team: marking a sailor clears the mark on teammates. */
export function setCaptain(db, id, value) {
    const s = db.prepare('SELECT team_id FROM sailors WHERE id = ?').get(id);
    if (!s)
        throw notFound('Sailor');
    db.transaction(() => {
        if (value)
            db.prepare('UPDATE sailors SET is_captain = 0 WHERE team_id = ? AND id <> ?').run(s.team_id, id);
        db.prepare('UPDATE sailors SET is_captain = ?, updated_at = ? WHERE id = ?').run(value ? 1 : 0, nowIso(), id);
    })();
}
export function deleteSailor(ctx, id) {
    const r = ctx.db.prepare('DELETE FROM sailors WHERE id = ?').run(id);
    if (!r.changes)
        throw notFound('Sailor');
    removeAllForOwner(ctx, 'sailor', id);
}
/** Today at the event (for the sailors' age), read once a minute. */
let today = { at: 0, day: '' };
function eventToday(db) {
    if (Date.now() - today.at > 60_000) {
        let tz = 'UTC';
        try {
            tz = activeEvent(db)?.timezone || 'UTC';
        }
        catch { /* no event */ }
        today = { at: Date.now(), day: todayIn(tz) };
    }
    return today.day;
}
export function sailorDto(ctx, s) {
    return {
        // the age only (never the date of birth: it goes to the commentators' pages) and the height, from the squad sheets
        age: s.birth_date ? ageOn(s.birth_date, eventToday(ctx.db)) : null, heightCm: s.height_cm ?? null,
        id: s.id, teamId: s.team_id, firstName: s.first_name, lastName: s.last_name, defaultPosition: s.default_position, defaultNumber: s.default_number,
        bestResult1: s.best_result_1, bestResult2: s.best_result_2, bestResult3: s.best_result_3 ?? '', sourceRef: s.source_ref, isDemo: !!s.is_demo, isCaptain: !!s.is_captain, updatedAt: s.updated_at,
        photo: listAssets(ctx, 'sailor', s.id).photo ?? null,
    };
}
export function listSailors(ctx, teamId) {
    const rows = ctx.db.prepare(`SELECT * FROM sailors WHERE team_id = ? ORDER BY is_captain DESC,
    CASE WHEN default_number GLOB '[0-9]*' THEN CAST(default_number AS INTEGER) ELSE 100000 END, last_name COLLATE NOCASE, first_name COLLATE NOCASE`).all(teamId);
    return rows.map((s) => sailorDto(ctx, s));
}
export function getSailor(ctx, id) {
    const s = ctx.db.prepare('SELECT * FROM sailors WHERE id = ?').get(id);
    if (!s)
        throw notFound('Sailor');
    const history = ctx.db.prepare(`SELECT d.declaration_date AS date, d.team_id AS teamId, m.id AS memberId,
      COALESCE(m.ovr_position, m.src_position, '') AS position, COALESCE(m.ovr_number, m.src_number, '') AS number,
      (m.ovr_position IS NOT NULL OR m.ovr_number IS NOT NULL) AS hasOverride, d.origin
    FROM declaration_members m JOIN declarations d ON d.id = m.declaration_id WHERE m.sailor_id = ? ORDER BY d.declaration_date DESC`).all(id);
    const aliases = ctx.db.prepare('SELECT name_key AS nameKey FROM sailor_source_aliases WHERE sailor_id = ?').all(id);
    // the date of birth only on the sailor's own page (editing); lists and the commentators get the age
    return { ...sailorDto(ctx, s), birthDate: s.birth_date ?? '', history, sourceAliases: aliases };
}
