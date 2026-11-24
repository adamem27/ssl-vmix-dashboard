import { randomBytes } from 'node:crypto';
import { getSetting, nowIso, setSetting } from '../db/db.js';
import { badRequest, notFound } from './errors.js';
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
// ---------- Tracking tab: a live tracking page (e.g. GeoRacing) shown in a frame on the commentator screen ----------
const TRACKING = 'commentator.trackingUrl';
/**
 * The address of the tracking page, from either the address or a whole <iframe …> code as the tracking provider gives it.
 * Only http(s) addresses; '' switches the tab off.
 */
export function parseTrackingUrl(input) {
    const v = input.trim();
    if (!v)
        return '';
    const src = /<iframe\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(v);
    const raw = (src ? src[2] ?? src[3] ?? src[4] ?? '' : v).trim().replace(/&amp;/g, '&');
    let u;
    try {
        u = new URL(raw);
    }
    catch {
        throw badRequest('Paste the tracking address (https://…) or its whole <iframe> code.');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:')
        throw badRequest('The tracking address must start with https://.');
    return u.toString();
}
export const trackingUrl = (db) => getSetting(db, TRACKING);
export function setTrackingUrl(db, input) {
    const url = parseTrackingUrl(input);
    setSetting(db, TRACKING, url);
    return url;
}
