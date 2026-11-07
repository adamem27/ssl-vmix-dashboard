import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeEvent, getSetting, nowIso, setSetting } from '../db/db.js';
import { removeDemo } from './demo.js';
import { nameKey, splitName } from './normalize.js';
import { createSailor, deleteSailor, setCaptain } from './sailors.js';
import { createTeam } from './teams.js';
import { createFleet, createSet, deleteFleet, setPlaceholders, FLEET_SIZE } from './fleets.js';
/**
 * SSL Gold Cup 2026 matchboard. Fleet places hold a team code, or a placeholder label
 * for a place decided later (a draw or a result of an earlier round).
 */
const TEAMS = [
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
const STAGES = [
    ['Qualifying Series', [
            ['QS A', ['PHI', 'MYA', 'KOR', 'VIE']], ['QS B', ['OMA', 'UAE', 'KAZ']], ['QS C', ['TAH', 'SEY', 'MAR', 'MOZ']],
            ['QS D', ['EST', 'AUT', 'SLO']], ['QS E', ['LTU', 'NOR', 'BEL', 'SRB']], ['QS F', ['UKR', 'FIN', 'GRE']],
            ['QS G', ['POR', 'TUR', 'BUL']], ['QS H', ['URU', 'PUR', 'VEN', 'ANT']], ['QS I', ['BER', 'MEX', 'CUB', 'ESA']],
        ]],
    ['1/32 Finals (19–22 Nov)', [
            ['R1 A', ['COL', 'DRAW 1', 'DRAW 2', 'DRAW 3']], ['R1 B', ['KOR', 'GRE', 'DRAW 5', 'DRAW 6']],
            ['R1 C', ['DRAW 7', 'DRAW 8', 'DRAW 9', 'MAS']], ['R1 D', ['DRAW 10', 'DRAW 11', 'DRAW 12', 'SGP']],
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
/**
 * Sets the fleets and places of a fleet set to the matchboard definition: fleets matched by name,
 * missing ones created, ones no longer on the matchboard removed, all places replaced.
 */
function fillSet(db, setId, fleets, idByCode) {
    const current = db.prepare('SELECT id, name FROM fleets WHERE fleet_set_id = ?').all(setId);
    for (const f of current)
        if (!fleets.some(([name]) => name === f.name))
            deleteFleet(db, f.id);
    db.prepare('DELETE FROM fleet_slots WHERE fleet_set_id = ?').run(setId);
    for (const [fleetName, places] of fleets) {
        const fleetId = current.find((f) => f.name === fleetName)?.id ?? createFleet(db, setId, fleetName);
        const labels = [];
        for (let i = 0; i < FLEET_SIZE; i++) {
            const p = places[i];
            const teamId = p ? idByCode.get(p) : undefined;
            if (teamId) {
                db.prepare('INSERT INTO fleet_slots (fleet_set_id, fleet_id, position, team_id) VALUES (?, ?, ?, ?)').run(setId, fleetId, i + 1, teamId);
                labels.push(null);
            }
            else
                labels.push(p ?? null);
        }
        setPlaceholders(db, fleetId, labels);
    }
}
/**
 * Idempotent: teams are matched by code, fleet sets by name. Existing sets are left untouched
 * unless named in `resync`, which resets them to the matchboard (used when the matchboard changes).
 */
export function applyGoldCup2026(db, resync = []) {
    const r = { teamsCreated: 0, teamsExisting: 0, setsCreated: 0, setsUpdated: [], setsSkipped: [] };
    db.transaction(() => {
        const ev = activeEvent(db);
        if (ev.name === 'Event' || ev.name === 'Wydarzenie') {
            db.prepare('UPDATE events SET name = ?, updated_at = ? WHERE id = ?').run('SSL Gold Cup 2026', nowIso(), ev.id);
        }
        const idByCode = new Map();
        for (const [code, name] of TEAMS) {
            const cur = db.prepare('SELECT id FROM teams WHERE code = ? COLLATE NOCASE').get(code);
            if (cur) {
                idByCode.set(code, cur.id);
                r.teamsExisting++;
                continue;
            }
            idByCode.set(code, createTeam(db, { name, code, aliases: [name], notes: 'From the SSL Gold Cup 2026 matchboard.' }));
            r.teamsCreated++;
        }
        for (const [setName, fleets] of STAGES) {
            const existing = db.prepare('SELECT id FROM fleet_sets WHERE event_id = ? AND name = ?').get(ev.id, setName);
            if (existing && !resync.includes(setName)) {
                r.setsSkipped.push(setName);
                continue;
            }
            const setId = existing?.id ?? createSet(db, ev.id, setName);
            fillSet(db, setId, fleets, idByCode);
            if (existing)
                r.setsUpdated.push(setName);
            else
                r.setsCreated++;
        }
    })();
    return r;
}
export function loadTeamPages() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const p of [path.join(here, '..', '..', 'fixtures', 'goldcup-team-pages.json'), path.join(here, '..', 'fixtures', 'goldcup-team-pages.json')]) {
        if (fs.existsSync(p))
            return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    return [];
}
/**
 * Applies data read from the team pages without overwriting operator edits:
 * a nickname is set only when empty, sailors are added only when no sailor of that team has the same name,
 * and the captain is marked only when the team has none yet.
 * The crew is the "Potential Team Position" list plus confirmed athletes that list leaves out.
 */
export function applyTeamPages(db, pages = loadTeamPages(), skipCrew = new Set()) {
    const r = { teams: 0, nicknames: 0, sailorsCreated: 0, captains: 0, missingTeams: [] };
    db.transaction(() => {
        for (const pg of pages) {
            const team = db.prepare('SELECT id, nickname FROM teams WHERE code = ? COLLATE NOCASE').get(pg.code);
            if (!team) {
                r.missingTeams.push(pg.code);
                continue;
            }
            r.teams++;
            if (pg.nickname && !team.nickname) {
                db.prepare('UPDATE teams SET nickname = ?, updated_at = ? WHERE id = ?').run(pg.nickname, nowIso(), team.id);
                r.nicknames++;
            }
            // Crews of teams on the official rooming list come from that list only.
            if (skipCrew.has(pg.code.toUpperCase()))
                continue;
            for (const m of pg.crew) {
                if (db.prepare('SELECT 1 FROM sailors WHERE team_id = ? AND name_key = ?').get(team.id, nameKey(m.name)))
                    continue;
                const { first, last } = splitName(m.name);
                createSailor(db, team.id, { firstName: first, lastName: last, defaultPosition: m.position, defaultNumber: m.number });
                r.sailorsCreated++;
            }
            if (pg.captain && !db.prepare('SELECT 1 FROM sailors WHERE team_id = ? AND is_captain = 1').get(team.id)) {
                const cap = db.prepare('SELECT id FROM sailors WHERE team_id = ? AND name_key = ?').get(team.id, nameKey(pg.captain));
                if (cap) {
                    setCaptain(db, cap.id, true);
                    r.captains++;
                }
            }
        }
    })();
    return r;
}
export function loadRooming() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const p of [path.join(here, '..', '..', 'fixtures', 'goldcup-rooming.json'), path.join(here, '..', 'fixtures', 'goldcup-rooming.json')]) {
        if (fs.existsSync(p))
            return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    return [];
}
/**
 * Makes each listed team's roster match the rooming list: matching sailors stay (an empty position or
 * number is filled in), missing ones are added, the rest are removed unless they carry operator work
 * (a photo or best results), which is reported instead. A captain marked on the list replaces the current one.
 */
export function applyRooming(ctx, teams = loadRooming()) {
    const { db } = ctx;
    const r = { teams: 0, added: 0, updated: 0, removed: 0, kept: [], captains: 0, missingTeams: [] };
    db.transaction(() => {
        for (const t of teams) {
            const team = db.prepare('SELECT id FROM teams WHERE code = ? COLLATE NOCASE').get(t.code);
            if (!team) {
                r.missingTeams.push(t.code);
                continue;
            }
            r.teams++;
            const current = db.prepare('SELECT * FROM sailors WHERE team_id = ?').all(team.id);
            const used = new Set();
            const lastKey = (s) => nameKey(s).split(' ').filter(Boolean);
            for (const m of t.crew) {
                const full = nameKey(`${m.firstName} ${m.lastName}`);
                const last = nameKey(m.lastName), first = nameKey(m.firstName).split(' ')[0];
                const free = current.filter((c) => !used.has(c.id));
                let hit = free.find((c) => c.name_key === full)
                    ?? free.find((c) => last && nameKey(c.last_name) === last && nameKey(c.first_name).split(' ')[0] === first);
                if (!hit && last) {
                    const byLast = free.filter((c) => lastKey(c.last_name).join(' ') === last || lastKey(`${c.first_name} ${c.last_name}`).includes(last));
                    if (byLast.length === 1 && nameKey(byLast[0].first_name)[0] === first[0])
                        hit = byLast[0];
                }
                let id;
                if (hit) {
                    id = hit.id;
                    const pos = hit.default_position || m.position, num = hit.default_number || m.number;
                    if (pos !== hit.default_position || num !== hit.default_number) {
                        db.prepare('UPDATE sailors SET default_position = ?, default_number = ?, updated_at = ? WHERE id = ?').run(pos, num, nowIso(), id);
                        r.updated++;
                    }
                }
                else {
                    id = createSailor(db, team.id, { firstName: m.firstName, lastName: m.lastName, defaultPosition: m.position, defaultNumber: m.number });
                    r.added++;
                }
                used.add(id);
                if (m.captain) {
                    setCaptain(db, id, true);
                    r.captains++;
                }
            }
            for (const c of current) {
                if (used.has(c.id))
                    continue;
                const hasPhoto = db.prepare("SELECT 1 FROM assets WHERE owner_type = 'sailor' AND owner_id = ?").get(c.id);
                if (hasPhoto || c.best_result_1 || c.best_result_2) {
                    r.kept.push(`${t.code} ${c.first_name} ${c.last_name}`);
                    continue;
                }
                deleteSailor(ctx, c.id);
                r.removed++;
            }
        }
    })();
    return r;
}
/** Bump when the bundled matchboard or team-page data changes, so existing installs pick it up on next start. */
export const GOLDCUP_DATA_VERSION = '2026-11-07.2';
/** Fleet sets the matchboard changed in each data version; reset to the matchboard when upgrading past it. */
const MATCHBOARD_CHANGES = [
    ['2026-11-07', ['Qualifying Series', '1/32 Finals (19–22 Nov)']],
];
/** Full Gold Cup setup: DEMO data out, matchboard teams and fleets, then team-page crews. Safe to repeat. */
export function applyGoldCupAll(ctx) {
    const removed = removeDemo(ctx);
    const from = getSetting(ctx.db, 'preset.goldcup.version') ?? '';
    const resync = MATCHBOARD_CHANGES.filter(([v]) => from && from < v).flatMap(([, sets]) => sets);
    const matchboard = applyGoldCup2026(ctx.db, resync);
    const roomingTeams = loadRooming();
    const teamPages = applyTeamPages(ctx.db, loadTeamPages(), new Set(roomingTeams.map((t) => t.code.toUpperCase())));
    // The rooming list is applied once per data version, so later roster edits in the panel are not undone.
    const rooming = from < GOLDCUP_DATA_VERSION || !from ? applyRooming(ctx, roomingTeams) : null;
    setSetting(ctx.db, 'preset.goldcup.version', GOLDCUP_DATA_VERSION);
    return { removedDemoTeams: removed.removedTeams, ...matchboard, teamPages, rooming };
}
/** Runs once per data version at server start. */
export function applyGoldCupOnStart(ctx) {
    if (getSetting(ctx.db, 'preset.goldcup.version') === GOLDCUP_DATA_VERSION)
        return null;
    return applyGoldCupAll(ctx);
}
