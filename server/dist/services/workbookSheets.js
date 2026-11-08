import path from 'node:path';
import { getSetting, setSetting } from '../db/db.js';
import { badRequest } from './errors.js';
import { getWeather, listPeople, listSchedule } from './general.js';
import { listOutputs, listTemplates, outputRel } from './generator/generator.js';
import { GRAPHIC_KINDS, listGraphicSets, tickerText } from './graphicSets.js';
import { loadLineup, slotDefs } from './lineups.js';
import { MATCHBOARD_REL } from './matchboard/matchboard.js';
import { overview } from './overview.js';
import { joinVmixPath } from './paths.js';
import { listResults } from './results.js';
import { TEAM_SLOTS } from './slots.js';
import { listTeams } from './teams.js';
/**
 * The vMix workbook: four sheets, data in rows, every value in one place only.
 *  - General: every general graphic, one row per value (Graphic · Version · Field · Value).
 *  - Teams:   one row per team of the current stage (its group and place, names, ranking, graphics).
 *  - Sailors: one row per sailor of those teams (captain, line-up place, today's declaration, photo).
 *  - Results: one row per team per group of the current stage (rank, races, points).
 * “Current stage” is a fleet set picked in the dashboard header; with none picked every team and group is listed.
 */
// ---------- current stage ----------
const STAGE_KEY = 'stage.current';
export function currentStage(db, eventId) {
    const id = getSetting(db, STAGE_KEY);
    if (!id)
        return null;
    return db.prepare('SELECT id, name FROM fleet_sets WHERE id = ? AND event_id = ?').get(id, eventId) ?? null;
}
export function setCurrentStage(db, eventId, setId) {
    if (setId && !db.prepare('SELECT 1 FROM fleet_sets WHERE id = ? AND event_id = ?').get(setId, eventId))
        throw badRequest('Unknown stage.');
    setSetting(db, STAGE_KEY, setId ?? '');
    return currentStage(db, eventId);
}
/** Ids of the teams placed in the current stage, or null when no stage is picked (then every team counts). */
export function stageTeamIds(db, eventId) {
    const stage = currentStage(db, eventId);
    if (!stage)
        return null;
    return db.prepare(`SELECT x.team_id AS teamId FROM fleet_slots x JOIN fleets f ON f.id = x.fleet_id
    WHERE x.fleet_set_id = ? ORDER BY f.sort, f.created_at, x.position`).all(stage.id).map((r) => r.teamId);
}
const img = (a) => (a ? a.vmixPath ?? a.storedPath ?? a.enteredPath ?? '' : '');
const yes = (b) => (b ? 'Yes' : '');
/** Teams of the stage with their group and place (fleet order), or every team when no stage is picked. */
function stageTeams(ctx, eventId) {
    const stage = currentStage(ctx.db, eventId);
    const teams = listTeams(ctx);
    if (!stage)
        return { stage, teams: [...teams].sort((a, b) => a.code.localeCompare(b.code)).map((t) => ({ t, group: '', place: '' })) };
    const slots = ctx.db.prepare(`SELECT x.team_id AS teamId, x.position, f.name AS fleet FROM fleet_slots x JOIN fleets f ON f.id = x.fleet_id
    WHERE x.fleet_set_id = ? ORDER BY f.sort, f.created_at, x.position`).all(stage.id);
    const byId = new Map(teams.map((t) => [t.id, t]));
    return { stage, teams: slots.filter((s) => byId.has(s.teamId)).map((s) => ({ t: byId.get(s.teamId), group: s.fleet, place: String(s.position) })) };
}
// ---------- General ----------
export function generalSheet(ctx, eventId, today) {
    const { db } = ctx;
    const rows = [];
    const add = (graphic, version, field, value) => rows.push({ Graphic: graphic, Version: version, Field: field, Value: value });
    const ev = db.prepare('SELECT name FROM events WHERE id = ?').get(eventId);
    add('Event', '', 'Name', ev?.name ?? '');
    add('Event', '', 'Stage', currentStage(db, eventId)?.name ?? '');
    add('Event', '', 'Date', today);
    const root = getSetting(db, 'paths.vmixAssetsRoot');
    add('Matchboard', '', 'Image', root ? joinVmixPath(root, MATCHBOARD_REL) : path.join(ctx.assetsDir, ...MATCHBOARD_REL.split('/')));
    const w = getWeather(db);
    const weather = [['Location', 'location'], ['Conditions', 'conditions'], ['Air temperature', 'air_temp'], ['Water temperature', 'water_temp'],
        ['Wind speed', 'wind_speed'], ['Wind gusts', 'wind_gust'], ['Wind direction', 'wind_direction'], ['Wind unit', 'wind_unit'], ['Note', 'note']];
    for (const [label, k] of weather)
        add('Weather', '', label, w[k] ?? '');
    listSchedule(db, eventId, today).forEach((s, i) => {
        const v = `Race ${i + 1}`;
        add('Schedule', v, 'Time', s.time);
        add('Schedule', v, 'Race', s.race);
        add('Schedule', v, 'Group', s.fleet);
        add('Schedule', v, 'Status', s.status);
        add('Schedule', v, 'Note', s.note);
    });
    for (const p of listPeople(ctx, eventId)) {
        const v = [p.role || 'Person', p.language].filter(Boolean).join(' · ');
        add('People', v, 'Name', p.name);
        add('People', v, 'Title', p.title);
        add('People', v, 'Photo', img(p.photo));
    }
    const sets = listGraphicSets(db, eventId);
    for (const k of GRAPHIC_KINDS) {
        for (const s of sets.filter((x) => x.kind === k.kind)) {
            for (const f of k.fields) {
                const v = s.data[f.key] ?? '';
                add(k.label, s.name, f.label, f.type === 'list' ? v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join(' | ') : v);
            }
            if (k.kind === 'ticker')
                add(k.label, s.name, 'Ticker text', tickerText(s.data));
        }
    }
    return rows;
}
// ---------- Teams ----------
export function teamsSheet(ctx, eventId, today) {
    const { db } = ctx;
    const { stage, teams } = stageTeams(ctx, eventId);
    const ov = new Map(overview(ctx, eventId, today, null).teams.map((t) => [t.id, t]));
    const root = getSetting(db, 'paths.vmixAssetsRoot');
    const templates = listTemplates(db).filter((t) => t.enabled);
    const outputs = new Set(listOutputs(db).map((o) => o.rel));
    return teams.map(({ t, group, place }) => {
        const row = {};
        if (stage) {
            row.Group = group;
            row.Place = place;
        }
        const lu = loadLineup(db, eventId, t.id);
        Object.assign(row, {
            Code: t.code, Name: t.name, Nickname: t.nickname, Ranking: t.ranking, 'Ranking points': t.rankingPoints,
            'Team weight': ov.get(t.id)?.declaration?.totalWeight ?? '',
            'Line-up title': lu.exists ? lu.data.title : '', 'Line-up team name': lu.exists ? (lu.data.teamName || t.name).toUpperCase() : '',
        });
        for (const s of TEAM_SLOTS)
            row[s.label] = img(t.assets[s.key]);
        for (const tp of templates) {
            const rel = outputRel(t.code, tp.fileName);
            row[`PNG ${tp.name}`] = outputs.has(rel) ? (root ? joinVmixPath(root, rel) : path.join(ctx.assetsDir, ...rel.split('/'))) : '';
        }
        return row;
    });
}
// ---------- Sailors ----------
export function sailorsSheet(ctx, eventId, today) {
    const { db } = ctx;
    const { teams } = stageTeams(ctx, eventId);
    const ov = new Map(overview(ctx, eventId, today, null).teams.map((t) => [t.id, t]));
    const rows = [];
    for (const { t } of teams) {
        const o = ov.get(t.id);
        const lu = loadLineup(db, eventId, t.id);
        const defs = slotDefs(lu.data.extra);
        const placeOf = new Map();
        if (lu.exists)
            lu.data.rows.forEach((r) => { if (r.sailorId)
                placeOf.set(r.sailorId, { label: defs.find((d) => d.key === r.slot)?.label ?? r.slot, order: defs.findIndex((d) => d.key === r.slot) + 1, row: r }); });
        const list = (o?.sailors ?? []).map((s) => {
            const p = placeOf.get(s.id);
            return {
                order: p?.order ?? 99, name: `${s.lastName} ${s.firstName}`,
                row: {
                    'Team code': t.code, Team: t.name, Captain: yes(p ? p.row.captain : s.isCaptain),
                    'Line-up place': p?.label ?? '', 'Line-up no.': p ? String(p.order) : '',
                    Number: p?.row.number || s.declared?.number || s.defaultNumber,
                    'First name': p?.row.firstName || s.firstName, 'Last name': (p?.row.lastName || s.lastName).toUpperCase(),
                    Position: p?.row.position || s.declared?.position || s.defaultPosition,
                    'Declared today': yes(!!s.declared), Weight: s.declared?.weight ?? '',
                    'Best result 1': s.bestResult1, 'Best result 2': s.bestResult2, 'Best result 3': s.bestResult3,
                    Photo: img(s.photo),
                },
            };
        });
        // line-up places typed by hand without a sailor profile
        if (lu.exists)
            lu.data.rows.forEach((r) => {
                if (r.sailorId || !(r.firstName || r.lastName))
                    return;
                const order = defs.findIndex((d) => d.key === r.slot) + 1;
                list.push({ order, name: `${r.lastName} ${r.firstName}`, row: {
                        'Team code': t.code, Team: t.name, Captain: yes(r.captain), 'Line-up place': defs[order - 1]?.label ?? r.slot, 'Line-up no.': String(order),
                        Number: r.number, 'First name': r.firstName, 'Last name': r.lastName.toUpperCase(), Position: r.position,
                        'Declared today': '', Weight: '', 'Best result 1': '', 'Best result 2': '', 'Best result 3': '', Photo: '',
                    } });
            });
        list.sort((a, b) => a.order - b.order || Number(!!b.row.Captain) - Number(!!a.row.Captain) || a.name.localeCompare(b.name));
        rows.push(...list.map((x) => x.row));
    }
    return rows;
}
// ---------- Results ----------
export function resultsSheet(ctx, eventId) {
    const { db } = ctx;
    const stage = currentStage(db, eventId);
    const sets = stage ? [stage] : db.prepare('SELECT id, name FROM fleet_sets WHERE event_id = ? ORDER BY sort, created_at').all(eventId);
    const teams = new Map(listTeams(ctx).map((t) => [t.id, t]));
    const groups = sets.flatMap((s) => listResults(db, s.id));
    const races = Math.max(0, ...groups.map((g) => g.races));
    const rows = [];
    for (const g of groups) {
        const placeholders = db.prepare('SELECT placeholders, size FROM fleets WHERE id = ?').get(g.fleetId);
        g.rows.forEach((r, i) => {
            const t = teams.get(r.teamId);
            const row = {};
            if (!stage)
                row.Stage = g.setName;
            Object.assign(row, { Group: g.fleetName, Title: g.title, Subtitle: g.subtitle, Rank: String(i + 1), Code: t?.code ?? '', Team: t?.name ?? '', Ranking: t?.ranking ?? '', Flag: img(t?.assets.flag_small) });
            for (let j = 0; j < races; j++)
                row[`R${j + 1}`] = j < g.races ? r.races[j] ?? '' : '';
            row.Points = r.total;
            rows.push(row);
        });
        // empty places of the group show their placeholder (e.g. “DRAW 1”)
        let ph = [];
        try {
            ph = JSON.parse(placeholders?.placeholders || '[]');
        }
        catch { /* none */ }
        const filled = new Set(db.prepare('SELECT position FROM fleet_slots WHERE fleet_id = ?').all(g.fleetId).map((x) => x.position));
        for (let pos = 1; pos <= (placeholders?.size ?? 0); pos++) {
            if (filled.has(pos) || !ph[pos - 1])
                continue;
            const row = {};
            if (!stage)
                row.Stage = g.setName;
            Object.assign(row, { Group: g.fleetName, Title: g.title, Subtitle: g.subtitle, Rank: '', Code: '', Team: ph[pos - 1] ?? '', Ranking: '', Flag: '' });
            for (let j = 0; j < races; j++)
                row[`R${j + 1}`] = '';
            row.Points = '';
            rows.push(row);
        }
    }
    return rows;
}
export const SHEETS = [
    { name: 'General', key: 'general' },
    { name: 'Teams', key: 'teams' },
    { name: 'Sailors', key: 'sailors' },
    { name: 'Results', key: 'results' },
];
export function sheetRows(ctx, eventId, today, key) {
    if (key === 'general')
        return generalSheet(ctx, eventId, today);
    if (key === 'teams')
        return teamsSheet(ctx, eventId, today);
    if (key === 'sailors')
        return sailorsSheet(ctx, eventId, today);
    if (key === 'results')
        return resultsSheet(ctx, eventId);
    throw badRequest(`Unknown sheet: ${key}`);
}
