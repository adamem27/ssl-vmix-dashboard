import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeEvent, DB, getSetting, nowIso, setSetting } from '../db/db.js';
import { AssetCtx } from './assets.js';
import { removeDemo } from './demo.js';
import { nameKey, splitName } from './normalize.js';
import { createSailor, setCaptain } from './sailors.js';
import { createTeam } from './teams.js';
import { createFleet, createSet, setPlaceholders, FLEET_SIZE } from './fleets.js';

/**
 * SSL Gold Cup 2026 matchboard. Fleet places hold a team code, or a placeholder label
 * for a place decided later (a draw or a result of an earlier round).
 */
const TEAMS: [string, string][] = [
  ['PHI', 'Philippines'], ['MYA', 'Myanmar'], ['KOR', 'South Korea'], ['VIE', 'Vietnam'],
  ['OMA', 'Oman'], ['UAE', 'United Arab Emirates'], ['KAZ', 'Kazakhstan'],
  ['TAH', 'Tahiti'], ['SEY', 'Seychelles'], ['MAR', 'Morocco'], ['MOZ', 'Mozambique'],
  ['EST', 'Estonia'], ['AUT', 'Austria'], ['SLO', 'Slovenia'],
  ['LTU', 'Lithuania'], ['NOR', 'Norway'], ['BEL', 'Belgium'], ['SRB', 'Serbia'],
  ['UKR', 'Ukraine'], ['FIN', 'Finland'], ['GRE', 'Greece'],
  ['POR', 'Portugal'], ['TUR', 'Türkiye'], ['BUL', 'Bulgaria'],
  ['URU', 'Uruguay'], ['VEN', 'Venezuela'], ['CUB', 'Cuba'],
  ['BER', 'Bermuda'], ['GUA', 'Guatemala'], ['ANT', 'Antigua and Barbuda'],
  ['MEX', 'Mexico'], ['PUR', 'Puerto Rico'], ['ESA', 'El Salvador'],
  ['COL', 'Colombia'], ['IND', 'India'], ['MAS', 'Malaysia'], ['SGP', 'Singapore'],
  ['HUN', 'Hungary'], ['ECU', 'Ecuador'], ['CHI', 'Chile'], ['RSA', 'South Africa'],
  ['THA', 'Thailand'], ['JPN', 'Japan'], ['PER', 'Peru'], ['CZE', 'Czechia'],
  ['NZL', 'New Zealand'], ['SUI', 'Switzerland'], ['POL', 'Poland'], ['BRA', 'Brazil'],
  ['CAN', 'Canada'], ['SWE', 'Sweden'], ['ARG', 'Argentina'], ['FRA', 'France'],
  ['GBR', 'Great Britain'], ['DEN', 'Denmark'], ['AUS', 'Australia'], ['NED', 'Netherlands'],
  ['ESP', 'Spain'], ['ITA', 'Italy'], ['GER', 'Germany'], ['USA', 'United States'],
];

type FleetDef = [name: string, places: string[]];
const STAGES: [setName: string, fleets: FleetDef[]][] = [
  ['Qualifying Series', [
    ['QS A', ['PHI', 'MYA', 'KOR', 'VIE']], ['QS B', ['OMA', 'UAE', 'KAZ']], ['QS C', ['TAH', 'SEY', 'MAR', 'MOZ']],
    ['QS D', ['EST', 'AUT', 'SLO']], ['QS E', ['LTU', 'NOR', 'BEL', 'SRB']], ['QS F', ['UKR', 'FIN', 'GRE']],
    ['QS G', ['POR', 'TUR', 'BUL']], ['QS H', ['URU', 'VEN', 'CUB']], ['QS I', ['BER', 'GUA', 'ANT']],
    ['QS J', ['MEX', 'PUR', 'ESA']],
  ]],
  ['1/32 Finals (19–22 Nov)', [
    ['R1 A', ['COL', 'DRAW 1', 'DRAW 2', 'DRAW 3']], ['R1 B', ['IND', 'UAE', 'DRAW 4', 'DRAW 5']],
    ['R1 C', ['DRAW 6', 'DRAW 7', 'DRAW 8', 'MAS']], ['R1 D', ['DRAW 9', 'DRAW 10', 'DRAW 11', 'SGP']],
  ]],
  ['1/16 Finals (26–29 Nov)', [
    ['R2 A', ['HUN', 'ECU', 'R1 C1', 'R1 B2']], ['R2 B', ['CHI', 'RSA', 'R1 A1', 'R1 C2']],
    ['R2 C', ['R1 D2', 'R1 B1', 'THA', 'JPN']], ['R2 D', ['R1 A2', 'R1 D1', 'PER', 'CZE']],
  ]],
  ['1/8 Finals (02–05 Dec)', [
    ['EF A', ['NZL', 'SUI', 'R2 B1', 'R2 A2']], ['EF B', ['POL', 'BRA', 'R2 D1', 'R2 B2']],
    ['EF C', ['R2 C2', 'R2 A1', 'CAN', 'SWE']], ['EF D', ['R2 D2', 'R2 C1', 'ARG', 'FRA']],
  ]],
  ['Quarterfinals (07–10 Dec)', [
    ['QF A', ['GBR', 'DEN', 'EF A1', 'EF D2']], ['QF B', ['AUS', 'NED', 'EF C1', 'EF A2']],
    ['QF C', ['EF B2', 'EF D1', 'ESP', 'ITA']], ['QF D', ['EF C2', 'EF B1', 'GER', 'USA']],
  ]],
  ['Semifinals (12 Dec)', [
    ['SF A', ['QF A1', 'QF C1', 'QF B2', 'QF D2']], ['SF B', ['QF C2', 'QF A2', 'QF D1', 'QF B1']],
  ]],
  ['Final (13 Dec)', [
    ['Final', ['SF A1', 'SF A2', 'SF B2', 'SF B1']], ['Petit Final', ['SF A3', 'SF A4', 'SF B4', 'SF B3']],
  ]],
];

export const PRESETS = [{ id: 'ssl-gold-cup-2026', label: 'SSL Gold Cup 2026 matchboard', teams: TEAMS.length, fleetSets: STAGES.length }];

export interface PresetResult { teamsCreated: number; teamsExisting: number; setsCreated: number; setsSkipped: string[] }

/** Idempotent: teams are matched by code, fleet sets by name; existing ones are left untouched. */
export function applyGoldCup2026(db: DB): PresetResult {
  const r: PresetResult = { teamsCreated: 0, teamsExisting: 0, setsCreated: 0, setsSkipped: [] };
  db.transaction(() => {
    const ev = activeEvent(db);
    if (ev.name === 'Event' || ev.name === 'Wydarzenie') {
      db.prepare('UPDATE events SET name = ?, updated_at = ? WHERE id = ?').run('SSL Gold Cup 2026', nowIso(), ev.id);
    }
    const idByCode = new Map<string, string>();
    for (const [code, name] of TEAMS) {
      const cur = db.prepare('SELECT id FROM teams WHERE code = ? COLLATE NOCASE').get(code) as { id: string } | undefined;
      if (cur) { idByCode.set(code, cur.id); r.teamsExisting++; continue; }
      idByCode.set(code, createTeam(db, { name, code, aliases: [name], notes: 'From the SSL Gold Cup 2026 matchboard.' }));
      r.teamsCreated++;
    }
    for (const [setName, fleets] of STAGES) {
      if (db.prepare('SELECT 1 FROM fleet_sets WHERE event_id = ? AND name = ?').get(ev.id, setName)) { r.setsSkipped.push(setName); continue; }
      const setId = createSet(db, ev.id, setName);
      for (const [fleetName, places] of fleets) {
        const fleetId = createFleet(db, setId, fleetName);
        const labels: (string | null)[] = [];
        for (let i = 0; i < FLEET_SIZE; i++) {
          const p = places[i];
          const teamId = p ? idByCode.get(p) : undefined;
          if (teamId) {
            db.prepare('INSERT INTO fleet_slots (fleet_set_id, fleet_id, position, team_id) VALUES (?, ?, ?, ?)').run(setId, fleetId, i + 1, teamId);
            labels.push(null);
          } else labels.push(p ?? null);
        }
        setPlaceholders(db, fleetId, labels);
      }
      r.setsCreated++;
    }
  })();
  return r;
}

// ---------- team pages (<code>.sslgoldcup.com) ----------
/** Crew data read from the team pages ("Potential Team Position"), names normalised, numbers from "Confirmed Athletes". */
export interface TeamPage { code: string; url: string; nickname: string; captain: string; crew: { name: string; position: string; number: string }[] }

export function loadTeamPages(): TeamPage[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, '..', '..', 'fixtures', 'goldcup-team-pages.json'), path.join(here, '..', 'fixtures', 'goldcup-team-pages.json')]) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return [];
}

export interface TeamPagesResult { teams: number; nicknames: number; sailorsCreated: number; captains: number; missingTeams: string[] }

/**
 * Applies data read from the team pages without overwriting operator edits:
 * a nickname is set only when empty, sailors are added only when no sailor of that team has the same name,
 * and the captain is marked only when the team has none yet.
 * The crew is the "Potential Team Position" list plus confirmed athletes that list leaves out.
 */
export function applyTeamPages(db: DB, pages: TeamPage[] = loadTeamPages()): TeamPagesResult {
  const r: TeamPagesResult = { teams: 0, nicknames: 0, sailorsCreated: 0, captains: 0, missingTeams: [] };
  db.transaction(() => {
    for (const pg of pages) {
      const team = db.prepare('SELECT id, nickname FROM teams WHERE code = ? COLLATE NOCASE').get(pg.code) as { id: string; nickname: string } | undefined;
      if (!team) { r.missingTeams.push(pg.code); continue; }
      r.teams++;
      if (pg.nickname && !team.nickname) {
        db.prepare('UPDATE teams SET nickname = ?, updated_at = ? WHERE id = ?').run(pg.nickname, nowIso(), team.id);
        r.nicknames++;
      }
      for (const m of pg.crew) {
        if (db.prepare('SELECT 1 FROM sailors WHERE team_id = ? AND name_key = ?').get(team.id, nameKey(m.name))) continue;
        const { first, last } = splitName(m.name);
        createSailor(db, team.id, { firstName: first, lastName: last, defaultPosition: m.position, defaultNumber: m.number });
        r.sailorsCreated++;
      }
      if (pg.captain && !db.prepare('SELECT 1 FROM sailors WHERE team_id = ? AND is_captain = 1').get(team.id)) {
        const cap = db.prepare('SELECT id FROM sailors WHERE team_id = ? AND name_key = ?').get(team.id, nameKey(pg.captain)) as { id: string } | undefined;
        if (cap) { setCaptain(db, cap.id, true); r.captains++; }
      }
    }
  })();
  return r;
}

/** Bump when the bundled matchboard or team-page data changes, so existing installs pick it up on next start. */
export const GOLDCUP_DATA_VERSION = '2026-10-18';

/** Full Gold Cup setup: DEMO data out, matchboard teams and fleets, then team-page crews. Safe to repeat. */
export function applyGoldCupAll(ctx: AssetCtx) {
  const removed = removeDemo(ctx);
  const matchboard = applyGoldCup2026(ctx.db);
  const teamPages = applyTeamPages(ctx.db);
  setSetting(ctx.db, 'preset.goldcup.version', GOLDCUP_DATA_VERSION);
  return { removedDemoTeams: removed.removedTeams, ...matchboard, teamPages };
}

/** Runs once per data version at server start. */
export function applyGoldCupOnStart(ctx: AssetCtx) {
  if (getSetting(ctx.db, 'preset.goldcup.version') === GOLDCUP_DATA_VERSION) return null;
  return applyGoldCupAll(ctx);
}
