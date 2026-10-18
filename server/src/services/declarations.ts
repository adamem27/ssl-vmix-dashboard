import { DB, newId, nowIso } from '../db/db.js';
import { AssetCtx, listAssets } from './assets.js';
import { badRequest, conflict, notFound } from './errors.js';
import { splitName } from './normalize.js';
import { createSailor } from './sailors.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function assertDate(d: string) {
  if (!DATE_RE.test(d) || Number.isNaN(Date.parse(d + 'T00:00:00Z'))) throw badRequest('Date must be in YYYY-MM-DD format.');
}

interface DeclRow {
  id: string; event_id: string; team_id: string; declaration_date: string; origin: 'manual' | 'import'; source_ref: string | null;
  source_posted_raw: string | null; source_fetched_at: string | null; notes: string; created_at: string; updated_at: string;
}
export interface MemberRow {
  id: string; declaration_id: string; origin: 'manual' | 'import'; sort: number; source_name: string | null; source_key: string | null;
  src_position: string | null; src_number: string | null; in_source: number; sailor_id: string | null; sailor_locked: number;
  match_status: 'matched' | 'unmatched' | 'ambiguous' | 'manual'; ovr_position: string | null; ovr_number: string | null; ovr_updated_at: string | null;
}

export function listDates(db: DB, eventId: string) {
  return db.prepare(`SELECT declaration_date AS date, COUNT(*) AS teams,
      SUM(CASE WHEN origin = 'import' THEN 1 ELSE 0 END) AS imported
    FROM declarations WHERE event_id = ? GROUP BY declaration_date ORDER BY declaration_date DESC`).all(eventId);
}

/** Overview of all teams for a date: has a declaration? how many crew, unmatched, overrides. */
export function dateOverview(db: DB, eventId: string, date: string) {
  assertDate(date);
  return db.prepare(`
    SELECT t.id AS teamId, t.name, t.code, t.is_demo AS isDemo, d.id AS declarationId, d.origin, d.source_fetched_at AS sourceFetchedAt,
      (SELECT COUNT(*) FROM declaration_members m WHERE m.declaration_id = d.id) AS members,
      (SELECT COUNT(*) FROM declaration_members m WHERE m.declaration_id = d.id AND m.sailor_id IS NULL) AS unmatched,
      (SELECT COUNT(*) FROM declaration_members m WHERE m.declaration_id = d.id AND (m.ovr_position IS NOT NULL OR m.ovr_number IS NOT NULL)) AS overrides
    FROM teams t LEFT JOIN declarations d ON d.team_id = t.id AND d.event_id = ? AND d.declaration_date = ?
    ORDER BY t.name COLLATE NOCASE`).all(eventId, date);
}

function memberDto(ctx: AssetCtx, r: MemberRow) {
  const s = r.sailor_id ? (ctx.db.prepare('SELECT id, first_name, last_name, default_position, default_number FROM sailors WHERE id = ?').get(r.sailor_id) as any) : null;
  const photo = s ? listAssets(ctx, 'sailor', s.id).photo ?? null : null;
  const field = (ovr: string | null, src: string | null) => ({
    value: ovr ?? src ?? '',
    source: src,
    manual: ovr,
    origin: ovr !== null ? 'manual' : src !== null ? 'source' : 'empty',
  });
  return {
    id: r.id,
    origin: r.origin,
    sort: r.sort,
    sourceName: r.source_name,
    inSource: !!r.in_source,
    hasSource: r.source_key !== null,
    matchStatus: r.match_status,
    sailorLocked: !!r.sailor_locked,
    sailor: s ? { id: s.id, firstName: s.first_name, lastName: s.last_name, defaultPosition: s.default_position, defaultNumber: s.default_number, photo } : null,
    position: field(r.ovr_position, r.src_position),
    number: field(r.ovr_number, r.src_number),
    overrideUpdatedAt: r.ovr_updated_at,
  };
}

function declDto(ctx: AssetCtx, d: DeclRow) {
  const members = ctx.db.prepare('SELECT * FROM declaration_members WHERE declaration_id = ? ORDER BY sort, created_at').all(d.id) as MemberRow[];
  return {
    id: d.id, teamId: d.team_id, date: d.declaration_date, origin: d.origin, sourceRef: d.source_ref, sourcePostedRaw: d.source_posted_raw,
    sourceFetchedAt: d.source_fetched_at, notes: d.notes, createdAt: d.created_at, updatedAt: d.updated_at,
    members: members.map((m) => memberDto(ctx, m)),
  };
}

export function getDeclaration(ctx: AssetCtx, eventId: string, teamId: string, date: string) {
  assertDate(date);
  const d = ctx.db.prepare('SELECT * FROM declarations WHERE event_id = ? AND team_id = ? AND declaration_date = ?').get(eventId, teamId, date) as DeclRow | undefined;
  return d ? declDto(ctx, d) : null;
}

export function getDeclarationById(ctx: AssetCtx, id: string) {
  const d = ctx.db.prepare('SELECT * FROM declarations WHERE id = ?').get(id) as DeclRow | undefined;
  if (!d) throw notFound('Declaration');
  return declDto(ctx, d);
}

/** Manual crew list without an import. prefill: empty | previous (latest earlier declaration) | roster (team's sailors with defaults). */
export function createManualDeclaration(ctx: AssetCtx, eventId: string, teamId: string, date: string, prefill: 'empty' | 'previous' | 'roster') {
  assertDate(date);
  const db = ctx.db;
  if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) throw notFound('Team');
  if (db.prepare('SELECT 1 FROM declarations WHERE event_id = ? AND team_id = ? AND declaration_date = ?').get(eventId, teamId, date)) {
    throw conflict('A declaration for this team on this day already exists.');
  }
  const id = newId();
  const t = nowIso();
  db.transaction(() => {
    db.prepare(`INSERT INTO declarations (id, event_id, team_id, declaration_date, origin, created_at, updated_at) VALUES (?, ?, ?, ?, 'manual', ?, ?)`)
      .run(id, eventId, teamId, date, t, t);
    const ins = db.prepare(`INSERT INTO declaration_members (id, declaration_id, origin, sort, sailor_id, sailor_locked, match_status, ovr_position, ovr_number, ovr_updated_at, created_at, updated_at)
      VALUES (?, ?, 'manual', ?, ?, 1, 'manual', ?, ?, ?, ?, ?)`);
    if (prefill === 'previous') {
      const prev = db.prepare('SELECT id FROM declarations WHERE event_id = ? AND team_id = ? AND declaration_date < ? ORDER BY declaration_date DESC LIMIT 1').get(eventId, teamId, date) as { id: string } | undefined;
      if (prev) {
        const rows = db.prepare('SELECT * FROM declaration_members WHERE declaration_id = ? AND sailor_id IS NOT NULL ORDER BY sort').all(prev.id) as MemberRow[];
        rows.forEach((r, i) => ins.run(newId(), id, i, r.sailor_id, r.ovr_position ?? r.src_position ?? '', r.ovr_number ?? r.src_number ?? '', t, t, t));
      }
    } else if (prefill === 'roster') {
      const rows = db.prepare('SELECT id, default_position, default_number FROM sailors WHERE team_id = ? ORDER BY last_name, first_name').all(teamId) as any[];
      rows.forEach((r, i) => ins.run(newId(), id, i, r.id, r.default_position, r.default_number, t, t, t));
    }
  })();
  return getDeclarationById(ctx, id);
}

function getMember(db: DB, id: string) {
  const m = db.prepare('SELECT * FROM declaration_members WHERE id = ?').get(id) as MemberRow | undefined;
  if (!m) throw notFound('Crew member');
  return m;
}
function declTeam(db: DB, declId: string) {
  return (db.prepare('SELECT team_id FROM declarations WHERE id = ?').get(declId) as { team_id: string }).team_id;
}
function touch(db: DB, declId: string) {
  db.prepare('UPDATE declarations SET updated_at = ? WHERE id = ?').run(nowIso(), declId);
}

export function addMember(ctx: AssetCtx, declId: string, input: { sailorId: string; position?: string; number?: string }) {
  const db = ctx.db;
  const d = db.prepare('SELECT * FROM declarations WHERE id = ?').get(declId) as DeclRow | undefined;
  if (!d) throw notFound('Declaration');
  const s = db.prepare('SELECT * FROM sailors WHERE id = ?').get(input.sailorId) as any;
  if (!s) throw notFound('Sailor');
  if (s.team_id !== d.team_id) throw badRequest('This sailor belongs to another team.');
  if (db.prepare('SELECT 1 FROM declaration_members WHERE declaration_id = ? AND sailor_id = ?').get(declId, s.id)) throw conflict('This sailor is already in the crew.');
  const t = nowIso();
  const sort = (db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM declaration_members WHERE declaration_id = ?').get(declId) as { n: number }).n;
  db.prepare(`INSERT INTO declaration_members (id, declaration_id, origin, sort, sailor_id, sailor_locked, match_status, ovr_position, ovr_number, ovr_updated_at, created_at, updated_at)
    VALUES (?, ?, 'manual', ?, ?, 1, 'manual', ?, ?, ?, ?, ?)`)
    .run(newId(), declId, sort, s.id, input.position ?? s.default_position, input.number ?? s.default_number, t, t, t);
  touch(db, declId);
}

/** Manual correction of daily position/number. Stored as an override; the source value stays underneath. */
export function setOverride(db: DB, memberId: string, patch: { position?: string; number?: string }) {
  const m = getMember(db, memberId);
  const t = nowIso();
  if (patch.position !== undefined) db.prepare('UPDATE declaration_members SET ovr_position = ?, ovr_updated_at = ?, updated_at = ? WHERE id = ?').run(patch.position.trim(), t, t, m.id);
  if (patch.number !== undefined) db.prepare('UPDATE declaration_members SET ovr_number = ?, ovr_updated_at = ?, updated_at = ? WHERE id = ?').run(patch.number.trim(), t, t, m.id);
  touch(db, m.declaration_id);
}

/** Drop the manual value so the field shows the source value again. */
export function clearOverride(db: DB, memberId: string, field: 'position' | 'number' | 'all') {
  const m = getMember(db, memberId);
  if (m.source_key === null) throw badRequest('This entry has no source value to reset to.');
  const t = nowIso();
  if (field === 'position' || field === 'all') db.prepare('UPDATE declaration_members SET ovr_position = NULL, updated_at = ? WHERE id = ?').run(t, m.id);
  if (field === 'number' || field === 'all') db.prepare('UPDATE declaration_members SET ovr_number = NULL, updated_at = ? WHERE id = ?').run(t, m.id);
  touch(db, m.declaration_id);
}

/** Operator links a published name to a sailor. remember=true also maps that spelling for future imports. */
export function assignSailor(db: DB, memberId: string, sailorId: string | null, remember: boolean) {
  const m = getMember(db, memberId);
  const teamId = declTeam(db, m.declaration_id);
  const t = nowIso();
  db.transaction(() => {
    if (sailorId) {
      const s = db.prepare('SELECT team_id FROM sailors WHERE id = ?').get(sailorId) as { team_id: string } | undefined;
      if (!s) throw notFound('Sailor');
      if (s.team_id !== teamId) throw badRequest('This sailor belongs to another team.');
      const dup = db.prepare('SELECT 1 FROM declaration_members WHERE declaration_id = ? AND sailor_id = ? AND id != ?').get(m.declaration_id, sailorId, m.id);
      if (dup) throw conflict('This sailor is already assigned to another entry in this crew.');
      db.prepare(`UPDATE declaration_members SET sailor_id = ?, sailor_locked = 1, match_status = 'matched', updated_at = ? WHERE id = ?`).run(sailorId, t, m.id);
      if (remember && m.source_key) {
        db.prepare('INSERT INTO sailor_source_aliases (team_id, name_key, sailor_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(team_id, name_key) DO UPDATE SET sailor_id = excluded.sailor_id')
          .run(teamId, m.source_key, sailorId, t);
      }
    } else {
      db.prepare(`UPDATE declaration_members SET sailor_id = NULL, sailor_locked = 0, match_status = ?, updated_at = ? WHERE id = ?`)
        .run(m.source_key ? 'unmatched' : 'manual', t, m.id);
      if (m.source_key) db.prepare('DELETE FROM sailor_source_aliases WHERE team_id = ? AND name_key = ?').run(teamId, m.source_key);
    }
    touch(db, m.declaration_id);
  })();
}

export function createSailorFromMember(db: DB, memberId: string) {
  const m = getMember(db, memberId);
  if (!m.source_name) throw badRequest('This entry has no name from the source.');
  const teamId = declTeam(db, m.declaration_id);
  const { first, last } = splitName(m.source_name);
  return db.transaction(() => {
    const id = createSailor(db, teamId, {
      firstName: first, lastName: last,
      defaultPosition: m.ovr_position ?? m.src_position ?? '', defaultNumber: m.ovr_number ?? m.src_number ?? '',
    });
    assignSailor(db, memberId, id, true);
    return id;
  })();
}

/** Manual rows can be removed. Imported rows only once the source no longer lists them (else the next sync restores them). */
export function removeMember(db: DB, memberId: string) {
  const m = getMember(db, memberId);
  if (m.origin === 'import' && m.in_source) throw badRequest('This entry cannot be removed: it comes from the current source data and would return on the next sync. You can correct its position and number.');
  db.prepare('DELETE FROM declaration_members WHERE id = ?').run(m.id);
  touch(db, m.declaration_id);
}

export function moveMember(db: DB, memberId: string, direction: -1 | 1) {
  const m = getMember(db, memberId);
  const list = db.prepare('SELECT id FROM declaration_members WHERE declaration_id = ? ORDER BY sort, created_at').all(m.declaration_id) as { id: string }[];
  const i = list.findIndex((x) => x.id === memberId);
  const j = i + direction;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  db.transaction(() => list.forEach((x, k) => db.prepare('UPDATE declaration_members SET sort = ? WHERE id = ?').run(k, x.id)))();
  touch(db, m.declaration_id);
}

export function deleteDeclaration(db: DB, id: string) {
  const r = db.prepare('DELETE FROM declarations WHERE id = ?').run(id);
  if (!r.changes) throw notFound('Declaration');
}

export function updateDeclarationNotes(db: DB, id: string, notes: string) {
  const r = db.prepare('UPDATE declarations SET notes = ?, updated_at = ? WHERE id = ?').run(notes, nowIso(), id);
  if (!r.changes) throw notFound('Declaration');
}

/** Unmatched or ambiguous imported rows across the event, for the review list. */
export function unmatchedMembers(db: DB, eventId: string) {
  return db.prepare(`SELECT m.id, m.source_name AS sourceName, m.match_status AS matchStatus, d.declaration_date AS date, t.id AS teamId, t.code, t.name
    FROM declaration_members m JOIN declarations d ON d.id = m.declaration_id JOIN teams t ON t.id = d.team_id
    WHERE d.event_id = ? AND m.sailor_id IS NULL AND m.source_key IS NOT NULL ORDER BY d.declaration_date DESC, t.name`).all(eventId);
}

