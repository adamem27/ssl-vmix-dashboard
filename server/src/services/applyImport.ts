import { DB, newId, nowIso } from '../db/db.js';
import type { ParsedDeclaration, ParsedMember } from '../importers/types.js';
import { codeKey, nameKey } from './normalize.js';

export interface ImportSummary {
  declarationsInSource: number;
  declarationsAdded: number;
  declarationsUpdated: number;
  declarationsUnchanged: number;
  membersAdded: number;
  membersChanged: number;
  membersRemoved: number;
  membersUnmatched: number;
  conflicts: { team: string; date: string; name: string; field: 'position' | 'number'; manual: string; source: string }[];
  warnings: string[];
  unmatchedTeams: string[];
}

export const emptySummary = (): ImportSummary => ({
  declarationsInSource: 0, declarationsAdded: 0, declarationsUpdated: 0, declarationsUnchanged: 0,
  membersAdded: 0, membersChanged: 0, membersRemoved: 0, membersUnmatched: 0, conflicts: [], warnings: [], unmatchedTeams: [],
});

interface TeamLite { id: string; name: string; code: string; aliases: string }
interface MemberRow {
  id: string; origin: 'manual' | 'import'; source_key: string | null; source_name: string | null; src_position: string | null; src_number: string | null; src_weight: string | null;
  in_source: number; sailor_id: string | null; sailor_locked: number; match_status: string; ovr_position: string | null; ovr_number: string | null; ovr_weight: string | null; sort: number;
}

function buildTeamIndex(db: DB) {
  const teams = db.prepare('SELECT id, name, code, aliases FROM teams').all() as TeamLite[];
  const idx = new Map<string, TeamLite>();
  for (const t of teams) idx.set(codeKey(t.code), t);
  for (const t of teams) {
    for (const a of [t.name, ...safeAliases(t.aliases)]) {
      const k = codeKey(a);
      if (k && !idx.has(k)) idx.set(k, t);
    }
  }
  return idx;
}

function safeAliases(json: string): string[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

export type MatchResult = { status: 'matched'; sailorId: string } | { status: 'ambiguous' | 'unmatched'; sailorId: null };

/**
 * Match a published name to a sailor of the same team. Uses a source id when present,
 * otherwise operator-confirmed aliases, then the normalized name (also in reversed order).
 * Number and position are never used for identity. Several candidates → ambiguous, never merged.
 */
export function matchSailor(db: DB, teamId: string, m: Pick<ParsedMember, 'sourceName' | 'sourceId'>): MatchResult {
  if (m.sourceId) {
    const r = db.prepare('SELECT id FROM sailors WHERE team_id = ? AND source_ref = ?').get(teamId, m.sourceId) as { id: string } | undefined;
    if (r) return { status: 'matched', sailorId: r.id };
  }
  const key = nameKey(m.sourceName);
  const alias = db.prepare('SELECT sailor_id FROM sailor_source_aliases WHERE team_id = ? AND name_key = ?').get(teamId, key) as { sailor_id: string } | undefined;
  if (alias) return { status: 'matched', sailorId: alias.sailor_id };
  const tryKey = (k: string) => db.prepare('SELECT id FROM sailors WHERE team_id = ? AND name_key = ?').all(teamId, k) as { id: string }[];
  let hits = tryKey(key);
  if (!hits.length) {
    const parts = key.split(' ');
    if (parts.length >= 2) hits = tryKey([parts[parts.length - 1], ...parts.slice(0, -1)].join(' '));
  }
  if (hits.length === 1) return { status: 'matched', sailorId: hits[0].id };
  return { status: hits.length > 1 ? 'ambiguous' : 'unmatched', sailorId: null };
}

/**
 * Write parsed declarations. Must be called inside a transaction (see runImport).
 * Rules: importer writes only src_* columns and source metadata; ovr_* (manual) values are never
 * touched; sailor profiles are never modified; declarations absent from the source are left alone.
 */
export function applyParsed(db: DB, eventId: string, parsed: ParsedDeclaration[], fetchedAt: string): ImportSummary {
  const s = emptySummary();
  s.declarationsInSource = parsed.length;
  const teams = buildTeamIndex(db);
  const t = nowIso();

  for (const p of parsed) {
    const team = teams.get(codeKey(p.teamRef));
    if (!team) {
      if (!s.unmatchedTeams.includes(p.teamRef)) s.unmatchedTeams.push(p.teamRef);
      continue;
    }
    let decl = db.prepare('SELECT id FROM declarations WHERE event_id = ? AND team_id = ? AND declaration_date = ?').get(eventId, team.id, p.date) as { id: string } | undefined;
    let created = false;
    if (!decl) {
      decl = { id: newId() };
      db.prepare(`INSERT INTO declarations (id, event_id, team_id, declaration_date, origin, source_ref, source_posted_raw, source_fetched_at, src_total_weight, created_at, updated_at)
                  VALUES (?, ?, ?, ?, 'import', ?, ?, ?, ?, ?, ?)`).run(decl.id, eventId, team.id, p.date, p.sourceRef, p.postedRaw, fetchedAt, p.totalWeight ?? null, t, t);
      created = true;
      s.declarationsAdded++;
    } else {
      db.prepare('UPDATE declarations SET source_ref = COALESCE(?, source_ref), source_posted_raw = COALESCE(?, source_posted_raw), source_fetched_at = ?, src_total_weight = COALESCE(?, src_total_weight) WHERE id = ?')
        .run(p.sourceRef, p.postedRaw, fetchedAt, p.totalWeight ?? null, decl.id);
    }

    const rows = db.prepare('SELECT * FROM declaration_members WHERE declaration_id = ?').all(decl.id) as MemberRow[];
    const bySource = new Map(rows.filter((r) => r.source_key).map((r) => [r.source_key!, r]));
    const seen = new Set<string>();
    let changedHere = false;

    p.members.forEach((m, i) => {
      const key = nameKey(m.sourceName);
      if (!key || seen.has(key)) { if (key) s.warnings.push(`${p.teamRef} ${p.dateRaw}: duplicate entry “${m.sourceName}”, skipped.`); return; }
      seen.add(key);
      let row = bySource.get(key);
      const match = row?.sailor_locked ? null : matchSailor(db, team.id, m);

      // A manual row for the same sailor (no source link yet) absorbs the source data instead of duplicating.
      if (!row && match?.status === 'matched') {
        const manual = rows.find((r) => r.sailor_id === match.sailorId && !r.source_key);
        if (manual) {
          db.prepare('UPDATE declaration_members SET source_key = ?, source_name = ?, src_position = ?, src_number = ?, src_weight = ?, in_source = 1, updated_at = ? WHERE id = ?')
            .run(key, m.sourceName, m.position, m.number, m.weight ?? null, t, manual.id);
          row = { ...manual, source_key: key };
          bySource.set(key, row);
          changedHere = true;
          s.membersChanged++;
          noteConflicts(s, team, p, m, manual);
          return;
        }
      }

      if (!row) {
        db.prepare(`INSERT INTO declaration_members (id, declaration_id, origin, sort, source_name, source_key, src_position, src_number, src_weight, in_source, sailor_id, sailor_locked, match_status, created_at, updated_at)
                    VALUES (?, ?, 'import', ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?)`)
          .run(newId(), decl!.id, i, m.sourceName, key, m.position, m.number, m.weight ?? null, match!.sailorId, match!.status, t, t);
        s.membersAdded++;
        if (match!.status !== 'matched') s.membersUnmatched++;
        changedHere = true;
        return;
      }

      const srcChanged = row.src_position !== m.position || row.src_number !== m.number || row.src_weight !== (m.weight ?? null) || row.source_name !== m.sourceName || !row.in_source;
      const sailorId = row.sailor_locked ? row.sailor_id : match!.sailorId;
      const status = row.sailor_locked ? row.match_status : match!.status;
      const matchChanged = sailorId !== row.sailor_id || status !== row.match_status;
      if (srcChanged || matchChanged || (row.origin === 'import' && row.sort !== i)) {
        db.prepare(`UPDATE declaration_members SET source_name = ?, src_position = ?, src_number = ?, src_weight = ?, in_source = 1, sailor_id = ?, match_status = ?,
                    sort = CASE WHEN origin = 'import' THEN ? ELSE sort END, updated_at = ? WHERE id = ?`)
          .run(m.sourceName, m.position, m.number, m.weight ?? null, sailorId, status, i, t, row.id);
      }
      if (srcChanged || matchChanged) { s.membersChanged++; changedHere = true; }
      if (status !== 'matched' && !sailorId) s.membersUnmatched++;
      noteConflicts(s, team, p, m, row);
    });

    // Rows the source no longer lists: drop untouched imported rows, keep (and flag) anything an operator edited.
    for (const r of rows) {
      if (!r.source_key || seen.has(r.source_key) || !r.in_source) continue;
      const operatorTouched = r.origin === 'manual' || r.ovr_position !== null || r.ovr_number !== null || r.ovr_weight !== null || r.sailor_locked;
      if (operatorTouched) {
        db.prepare('UPDATE declaration_members SET in_source = 0, updated_at = ? WHERE id = ?').run(t, r.id);
        s.warnings.push(`${p.teamRef} ${p.dateRaw}: “${r.source_name}” is no longer in the source; entry kept because it has manual changes.`);
      } else {
        db.prepare('DELETE FROM declaration_members WHERE id = ?').run(r.id);
        s.membersRemoved++;
      }
      changedHere = true;
    }

    if (changedHere) db.prepare('UPDATE declarations SET updated_at = ? WHERE id = ?').run(t, decl.id);
    if (!created) changedHere ? s.declarationsUpdated++ : s.declarationsUnchanged++;
  }
  if (s.unmatchedTeams.length) {
    s.warnings.push(`Unrecognised teams: ${s.unmatchedTeams.join(', ')}. Add a team with that code or alias, then fetch again.`);
  }
  return s;
}

function noteConflicts(s: ImportSummary, team: TeamLite, p: ParsedDeclaration, m: ParsedMember, row: Pick<MemberRow, 'ovr_position' | 'ovr_number'>) {
  if (row.ovr_position !== null && row.ovr_position !== (m.position ?? '')) {
    s.conflicts.push({ team: team.code, date: p.date, name: m.sourceName, field: 'position', manual: row.ovr_position, source: m.position ?? '' });
  }
  if (row.ovr_number !== null && row.ovr_number !== (m.number ?? '')) {
    s.conflicts.push({ team: team.code, date: p.date, name: m.sourceName, field: 'number', manual: row.ovr_number, source: m.number ?? '' });
  }
}
