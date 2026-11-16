/**
 * Rounds of the bracket, shared by the server and the browser (pure TypeScript, no Node).
 * A box or group is placed in its round by its short name (QS H, R1 A, R2 B, EF C, QF D, SF A, FINAL); a stage by its
 * groups, or by its name (“1/32 Finals …”) when its groups have other names.
 */
import { MbLayout, MbState, resolveTeams } from './draw.js';

export const ROUND = { QS: 0, EF: 10, QF: 11, SF: 12, FINAL: 13 } as const;

/** The round of a box or group by its short name; null when the name says none (“Group A”, “Last Chance Race”). */
export function roundOf(name: string | null | undefined): number | null {
  const n = (name ?? '').trim().toUpperCase();
  if (!n) return null;
  if (/^EF\b/.test(n)) return ROUND.EF;
  if (/^QF\b/.test(n)) return ROUND.QF;
  if (/^SF\b/.test(n)) return ROUND.SF;
  if (/^QS\b|^QS?\s*[-_.]?\s*[A-Z]\d?$/.test(n)) return ROUND.QS;
  const r = /^R\s*(\d+)\b/.exec(n);
  if (r) return Number(r[1]);
  if (/^(FINAL|PETIT)/.test(n)) return ROUND.FINAL;
  return null;
}

/** The round of a stage: from its groups' short names, else from its name (Qualifying Series, 1/32 Finals, Quarterfinals…). */
export function stageRound(stageName: string | null | undefined, groupNames: string[] = []): number | null {
  for (const g of groupNames) { const r = roundOf(g); if (r !== null) return r; }
  const n = (stageName ?? '').toLowerCase();
  if (/qualif/.test(n)) return ROUND.QS;
  if (/1\s*\/\s*32/.test(n)) return 1;
  if (/1\s*\/\s*16/.test(n)) return 2;
  if (/1\s*\/\s*8\b/.test(n)) return ROUND.EF;
  if (/quarter/.test(n)) return ROUND.QF;
  if (/semi/.test(n)) return ROUND.SF;
  if (/final/.test(n)) return ROUND.FINAL;
  return null;
}

export interface Starred { teamId: string; box: string; place: number; round: number | null }

/** Every starred (highlighted) row of the matchboard that holds a team: the teams through to a later stage. */
export function starredTeams(layout: MbLayout, state: MbState): Starred[] {
  const resolved = resolveTeams(layout, state);
  const out: Starred[] = [];
  for (const g of layout.groups) {
    const box = (state.texts[g.labelId] ?? layout.texts.find((t) => t.id === g.labelId)?.text ?? '').trim();
    g.slots.forEach((sid, i) => {
      const team = resolved.get(sid);
      if (state.slots[sid]?.highlight && team) out.push({ teamId: team.teamId, box, place: i + 1, round: roundOf(box) });
    });
  }
  return out;
}

/**
 * The starred teams a stage of this round takes from earlier ones, each team once (where it was starred last),
 * the latest round first. A round not known (null) takes every starred team.
 */
export function starredBefore(all: Starred[], round: number | null): Starred[] {
  const byTeam = new Map<string, Starred>();
  for (const s of all) {
    if (round !== null && (s.round === null || s.round >= round)) continue;
    const cur = byTeam.get(s.teamId);
    if (!cur || (s.round ?? -1) > (cur.round ?? -1)) byTeam.set(s.teamId, s);
  }
  return [...byTeam.values()].sort((a, b) => (b.round ?? -1) - (a.round ?? -1) || a.box.localeCompare(b.box) || a.place - b.place);
}

/** “QS H 1” — where a starred team finished. */
export const starredWhere = (s: Starred) => `${s.box} ${s.place}`.trim();
