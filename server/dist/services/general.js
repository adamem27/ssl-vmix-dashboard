import { getSetting, newId, nowIso, setSetting } from '../db/db.js';
import { listAssets, removeAllForOwner } from './assets.js';
import { assertDate } from './declarations.js';
import { notFound } from './errors.js';
// ---------- weather (one current record) ----------
/** wind_degrees is the direction in degrees as typed (e.g. 050), next to the compass point in wind_direction. */
export const WEATHER_FIELDS = ['forecast', 'air_temp', 'wind_speed', 'wind_direction', 'wind_degrees'];
export function getWeather(db) {
    let v = {};
    try {
        v = JSON.parse(getSetting(db, 'weather') || '{}');
    }
    catch { /* reset below */ }
    const old = v;
    if (v.forecast === undefined && old.conditions)
        v.forecast = old.conditions; // renamed from conditions
    const out = Object.fromEntries(WEATHER_FIELDS.map((k) => [k, String(v[k] ?? '')]));
    out.updated_at = v.updated_at ?? '';
    return out;
}
export function setWeather(db, patch) {
    const cur = getWeather(db);
    for (const k of WEATHER_FIELDS)
        if (patch[k] !== undefined)
            cur[k] = String(patch[k]).trim();
    cur.updated_at = nowIso();
    setSetting(db, 'weather', JSON.stringify(cur));
    return cur;
}
// ---------- day schedule ----------
const SCHEDULE_FIELDS = ['date', 'time', 'race', 'fleet', 'status', 'note'];
export function listSchedule(db, eventId, date) {
    if (date)
        assertDate(date);
    return db.prepare(`SELECT id, date, time, race, fleet, status, note FROM schedule_items WHERE event_id = ? ${date ? 'AND date = ?' : ''} ORDER BY date, time, created_at`)
        .all(...(date ? [eventId, date] : [eventId]));
}
export function listScheduleDates(db, eventId) {
    return db.prepare('SELECT date, COUNT(*) AS items FROM schedule_items WHERE event_id = ? GROUP BY date ORDER BY date').all(eventId);
}
export function createScheduleItem(db, eventId, input) {
    assertDate(input.date ?? '');
    const id = newId();
    const t = nowIso();
    db.prepare('INSERT INTO schedule_items (id, event_id, date, time, race, fleet, status, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, eventId, input.date, (input.time ?? '').trim(), (input.race ?? '').trim(), (input.fleet ?? '').trim(), (input.status ?? '').trim(), (input.note ?? '').trim(), t, t);
    return id;
}
export function updateScheduleItem(db, id, input) {
    const cur = db.prepare('SELECT * FROM schedule_items WHERE id = ?').get(id);
    if (!cur)
        throw notFound('Schedule item');
    if (input.date !== undefined)
        assertDate(input.date);
    const v = Object.fromEntries(SCHEDULE_FIELDS.map((k) => [k, input[k] !== undefined ? String(input[k]).trim() : cur[k]]));
    db.prepare('UPDATE schedule_items SET date = ?, time = ?, race = ?, fleet = ?, status = ?, note = ?, updated_at = ? WHERE id = ?')
        .run(v.date, v.time, v.race, v.fleet, v.status, v.note, nowIso(), id);
}
export function deleteScheduleItem(db, id) {
    if (!db.prepare('DELETE FROM schedule_items WHERE id = ?').run(id).changes)
        throw notFound('Schedule item');
}
// ---------- people (lowerthirds) ----------
export const PERSON_ROLES = ['Host commentator', 'Guest commentator', 'On-water commentator', 'Guest', 'Other'];
const PERSON_FIELDS = ['name', 'role', 'language', 'title'];
export function listPeople(ctx, eventId) {
    const rows = ctx.db.prepare('SELECT * FROM people WHERE event_id = ? ORDER BY sort, created_at').all(eventId);
    return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, language: r.language, title: r.title, photo: listAssets(ctx, 'person', r.id).photo ?? null }));
}
export function createPerson(db, eventId, input) {
    const id = newId();
    const t = nowIso();
    const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM people WHERE event_id = ?').get(eventId).n;
    db.prepare('INSERT INTO people (id, event_id, name, role, language, title, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, eventId, (input.name ?? '').trim(), (input.role ?? '').trim(), (input.language ?? '').trim(), (input.title ?? '').trim(), sort, t, t);
    return id;
}
export function updatePerson(db, id, input) {
    const cur = db.prepare('SELECT * FROM people WHERE id = ?').get(id);
    if (!cur)
        throw notFound('Person');
    const v = Object.fromEntries(PERSON_FIELDS.map((k) => [k, input[k] !== undefined ? String(input[k]).trim() : cur[k]]));
    db.prepare('UPDATE people SET name = ?, role = ?, language = ?, title = ?, updated_at = ? WHERE id = ?').run(v.name, v.role, v.language, v.title, nowIso(), id);
}
export function deletePerson(ctx, id) {
    if (!ctx.db.prepare('DELETE FROM people WHERE id = ?').run(id).changes)
        throw notFound('Person');
    removeAllForOwner(ctx, 'person', id);
}
/** Adds the three commentator roles for one language, skipping roles that already exist for it. */
export function addCommentatorSet(db, eventId, language) {
    const roles = PERSON_ROLES.slice(0, 3);
    let added = 0;
    for (const role of roles) {
        if (db.prepare('SELECT 1 FROM people WHERE event_id = ? AND role = ? AND language = ?').get(eventId, role, language))
            continue;
        createPerson(db, eventId, { role, language });
        added++;
    }
    return { added };
}
