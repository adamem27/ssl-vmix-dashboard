import { AssetCtx } from './assets.js';
import { assertDate } from './declarations.js';
import { listSailors } from './sailors.js';
import { TEAM_SLOTS } from './slots.js';
import { listTeams } from './teams.js';

/**
 * Everything the live overview table needs in one response: teams with their graphics status,
 * place in the chosen fleet set, the day's declaration and their sailors with declared values.
 */
export function overview(ctx: AssetCtx, eventId: string, date: string, fleetSetId: string | null) {
  assertDate(date);
  const { db } = ctx;
  const places = new Map<string, { fleetName: string; position: number }>();
  if (fleetSetId) {
    const rows = db.prepare(`SELECT x.team_id AS teamId, x.position, f.name AS fleetName FROM fleet_slots x JOIN fleets f ON f.id = x.fleet_id WHERE x.fleet_set_id = ?`).all(fleetSetId) as any[];
    for (const r of rows) places.set(r.teamId, { fleetName: r.fleetName, position: r.position });
  }
  const members = db.prepare(`
    SELECT d.team_id AS teamId, d.origin AS declOrigin, m.sailor_id AS sailorId, m.source_name AS sourceName, m.sort, m.in_source AS inSource,
      COALESCE(m.ovr_position, m.src_position, '') AS position, COALESCE(m.ovr_number, m.src_number, '') AS number,
      (m.ovr_position IS NOT NULL OR m.ovr_number IS NOT NULL) AS manual
    FROM declarations d JOIN declaration_members m ON m.declaration_id = d.id
    WHERE d.event_id = ? AND d.declaration_date = ? ORDER BY m.sort`).all(eventId, date) as any[];
  const declared = new Set(db.prepare('SELECT team_id FROM declarations WHERE event_id = ? AND declaration_date = ?').all(eventId, date).map((r: any) => r.team_id));

  const teams = listTeams(ctx).map((t) => {
    const teamMembers = members.filter((m) => m.teamId === t.id);
    const bySailor = new Map(teamMembers.filter((m) => m.sailorId).map((m) => [m.sailorId, m]));
    const sailors = listSailors(ctx, t.id).map((s) => {
      const m = bySailor.get(s.id);
      return { ...s, declared: m ? { position: m.position, number: m.number, manual: !!m.manual, sort: m.sort } : null };
    });
    return {
      id: t.id, code: t.code, name: t.name, nickname: t.nickname, isDemo: t.isDemo, thumb: t.thumb, assets: t.assets,
      slots: TEAM_SLOTS.map((s) => ({ key: s.key, label: s.label, status: t.assets[s.key]?.checkStatus ?? 'missing' })),
      assetsFilled: t.assetsFilled, assetsTotal: t.assetsTotal,
      place: places.get(t.id) ?? null,
      declaration: declared.has(t.id) ? { members: teamMembers.length, unmatched: teamMembers.filter((m) => !m.sailorId).map((m) => ({ name: m.sourceName ?? '', position: m.position, number: m.number })) } : null,
      sailors,
    };
  });
  return { date, fleetSetId, teams };
}
