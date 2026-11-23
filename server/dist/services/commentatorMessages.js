import { randomBytes } from 'node:crypto';
import { getSetting, nowIso, setSetting } from '../db/db.js';
import { notFound } from './errors.js';
const key = (eventId) => `commentator.messages.${eventId}`;
export function listMessages(db, eventId) {
    try {
        const v = JSON.parse(getSetting(db, key(eventId)) || '[]');
        return Array.isArray(v) ? v : [];
    }
    catch {
        return [];
    }
}
const save = (db, eventId, list) => setSetting(db, key(eventId), JSON.stringify(list));
export function addMessage(db, eventId, m) {
    const msg = { id: randomBytes(8).toString('hex'), text: m.text.trim(), fleetId: m.fleetId ?? '', teamId: m.fleetId ? m.teamId ?? '' : '', important: !!m.important, at: nowIso() };
    save(db, eventId, [...listMessages(db, eventId), msg]);
    return msg;
}
export function updateMessage(db, eventId, id, patch) {
    const list = listMessages(db, eventId);
    const at = list.findIndex((m) => m.id === id);
    if (at < 0)
        throw notFound('Note');
    const m = { ...list[at], ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), at: nowIso() };
    m.text = m.text.trim();
    if (!m.fleetId)
        m.teamId = '';
    list[at] = m;
    save(db, eventId, list);
    return m;
}
export function deleteMessage(db, eventId, id) {
    save(db, eventId, listMessages(db, eventId).filter((m) => m.id !== id));
}
