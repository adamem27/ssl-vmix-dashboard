import { randomBytes } from 'node:crypto';
import { DB, getSetting, nowIso, setSetting } from '../db/db.js';
import { notFound } from './errors.js';

/**
 * Notes for the commentators, typed at the venue and shown on the commentator screen (also the static page online).
 * A note is about the whole event (a message for the commentators), one group's results, or one team in a group.
 */
export interface CommentatorMessage {
  id: string;
  text: string;
  /** '' = a message for the commentators, not tied to a group */
  fleetId: string;
  /** '' = the whole group */
  teamId: string;
  /** shown first and highlighted */
  important: boolean;
  at: string;
}

const key = (eventId: string) => `commentator.messages.${eventId}`;

export function listMessages(db: DB, eventId: string): CommentatorMessage[] {
  try {
    const v = JSON.parse(getSetting(db, key(eventId)) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

const save = (db: DB, eventId: string, list: CommentatorMessage[]) => setSetting(db, key(eventId), JSON.stringify(list));

export function addMessage(db: DB, eventId: string, m: Pick<CommentatorMessage, 'text'> & Partial<Pick<CommentatorMessage, 'fleetId' | 'teamId' | 'important'>>): CommentatorMessage {
  const msg: CommentatorMessage = { id: randomBytes(8).toString('hex'), text: m.text.trim(), fleetId: m.fleetId ?? '', teamId: m.fleetId ? m.teamId ?? '' : '', important: !!m.important, at: nowIso() };
  save(db, eventId, [...listMessages(db, eventId), msg]);
  return msg;
}

export function updateMessage(db: DB, eventId: string, id: string, patch: Partial<Pick<CommentatorMessage, 'text' | 'fleetId' | 'teamId' | 'important'>>): CommentatorMessage {
  const list = listMessages(db, eventId);
  const at = list.findIndex((m) => m.id === id);
  if (at < 0) throw notFound('Note');
  const m = { ...list[at], ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), at: nowIso() } as CommentatorMessage;
  m.text = m.text.trim();
  if (!m.fleetId) m.teamId = '';
  list[at] = m;
  save(db, eventId, list);
  return m;
}

export function deleteMessage(db: DB, eventId: string, id: string) {
  save(db, eventId, listMessages(db, eventId).filter((m) => m.id !== id));
}
