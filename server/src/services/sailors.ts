import { DB, newId, nowIso } from '../db/db.js';
import { AssetCtx, listAssets, removeAllForOwner } from './assets.js';
import { notFound } from './errors.js';
import { nameKey } from './normalize.js';

export interface SailorInput {
  firstName?: string; lastName?: string; defaultPosition?: string; defaultNumber?: string;
  bestResult1?: string; bestResult2?: string; sourceRef?: string | null;
}

export function createSailor(db: DB, teamId: string, input: SailorInput, isDemo = false): string {
  if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) throw notFound('Team');
  const id = newId();
  const t = nowIso();
  const first = (input.firstName ?? '').trim();
  const last = (input.lastName ?? '').trim();
  db.prepare(`INSERT INTO sailors (id, team_id, first_name, last_name, name_key, default_position, default_number, best_result_1, best_result_2, source_ref, is_demo, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, teamId, first, last, nameKey(`${first} ${last}`), (input.defaultPosition ?? '').trim(), (input.defaultNumber ?? '').trim(),
      input.bestResult1 ?? '', input.bestResult2 ?? '', input.sourceRef ?? null, isDemo ? 1 : 0, t, t);
  return id;
}

export function updateSailor(db: DB, id: string, input: SailorInput) {
  const s = db.prepare('SELECT * FROM sailors WHERE id = ?').get(id) as any;
  if (!s) throw notFound('Sailor');
  const first = input.firstName !== undefined ? input.firstName.trim() : s.first_name;
  const last = input.lastName !== undefined ? input.lastName.trim() : s.last_name;
  db.prepare(`UPDATE sailors SET first_name = ?, last_name = ?, name_key = ?, default_position = ?, default_number = ?, best_result_1 = ?, best_result_2 = ?, source_ref = ?, updated_at = ? WHERE id = ?`)
    .run(first, last, nameKey(`${first} ${last}`),
      input.defaultPosition !== undefined ? input.defaultPosition.trim() : s.default_position,
      input.defaultNumber !== undefined ? input.defaultNumber.trim() : s.default_number,
      input.bestResult1 ?? s.best_result_1, input.bestResult2 ?? s.best_result_2,
      input.sourceRef !== undefined ? input.sourceRef : s.source_ref, nowIso(), id);
}

export function deleteSailor(ctx: AssetCtx, id: string) {
  const r = ctx.db.prepare('DELETE FROM sailors WHERE id = ?').run(id);
  if (!r.changes) throw notFound('Sailor');
  removeAllForOwner(ctx, 'sailor', id);
}

export function sailorDto(ctx: AssetCtx, s: any) {
  return {
    id: s.id, teamId: s.team_id, firstName: s.first_name, lastName: s.last_name, defaultPosition: s.default_position, defaultNumber: s.default_number,
    bestResult1: s.best_result_1, bestResult2: s.best_result_2, sourceRef: s.source_ref, isDemo: !!s.is_demo, updatedAt: s.updated_at,
    photo: listAssets(ctx, 'sailor', s.id).photo ?? null,
  };
}

export function listSailors(ctx: AssetCtx, teamId: string) {
  const rows = ctx.db.prepare(`SELECT * FROM sailors WHERE team_id = ? ORDER BY
    CASE WHEN default_number GLOB '[0-9]*' THEN CAST(default_number AS INTEGER) ELSE 100000 END, last_name COLLATE NOCASE, first_name COLLATE NOCASE`).all(teamId);
  return rows.map((s) => sailorDto(ctx, s));
}

export function getSailor(ctx: AssetCtx, id: string) {
  const s = ctx.db.prepare('SELECT * FROM sailors WHERE id = ?').get(id);
  if (!s) throw notFound('Sailor');
  const history = ctx.db.prepare(`SELECT d.declaration_date AS date, d.team_id AS teamId, m.id AS memberId,
      COALESCE(m.ovr_position, m.src_position, '') AS position, COALESCE(m.ovr_number, m.src_number, '') AS number,
      (m.ovr_position IS NOT NULL OR m.ovr_number IS NOT NULL) AS hasOverride, d.origin
    FROM declaration_members m JOIN declarations d ON d.id = m.declaration_id WHERE m.sailor_id = ? ORDER BY d.declaration_date DESC`).all(id);
  const aliases = ctx.db.prepare('SELECT name_key AS nameKey FROM sailor_source_aliases WHERE sailor_id = ?').all(id);
  return { ...sailorDto(ctx, s), history, sourceAliases: aliases };
}
