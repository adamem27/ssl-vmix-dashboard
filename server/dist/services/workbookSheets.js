import path from 'node:path';
import { getSetting, setSetting } from '../db/db.js';
import { listAssets } from './assets.js';
import { badRequest } from './errors.js';
import { getWeather, listPeople, listSchedule } from './general.js';
import { listOutputs, listTemplates, outputRel } from './generator/generator.js';
import { GRAPHIC_KINDS, imagePath, listGraphicSets, tickerMessages, tickerText } from './graphicSets.js';
import { currentGroup, groupLabel, nextRace, tickerAuto } from './groups.js';
import { loadLineup, slotDefs } from './lineups.js';
import { MATCHBOARD_REL } from './matchboard/matchboard.js';
import { overview } from './overview.js';
import { joinVmixPath } from './paths.js';
import { listResults } from './results.js';
import { TEAM_SLOTS } from './slots.js';
import { listTeams } from './teams.js';
/**
 * The vMix workbook: seven sheets, data in rows, every value in one place only.
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
    return { stage, teams: slots.filter((s) => byId.has(s.teamId)).map((s) => ({ t: byId.get(s.teamId), group: groupLabel(s.fleet), place: String(s.position) })) };
}
const letter = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
/**
 * General: a grid of titled blocks, read like a page. Columns are named by their letter (row 1), so a vMix field
 * maps to column + row exactly as the cell in Excel (e.g. B3). Blocks keep their place: Event and Matchboard beside
 * Weather at the top, then each general graphic with its versions in columns, then People, and today's
 * schedule last (it is the only block whose height changes). Announcements and People have sheets of their own. An empty row separates the blocks.
 */
export function generalSheet(ctx, eventId, today) {
    const { db } = ctx;
    const grid = [];
    const styles = {}; // by `row:col`
    const put = (r, c, v) => { while (grid.length <= r)
        grid.push([]); grid[r][c] = v; };
    let row = 0;
    /** A block at (row, col): title, optional header row, then label + values per line. Returns its height. */
    const block = (r, c, title, head, lines) => {
        put(r, c, title);
        for (let i = 0; i <= Math.max(1, head?.length ?? 0); i++)
            styles[`${r}:${c + i}`] = 'title'; // shaded band over the block
        let y = r + 1;
        if (head) {
            head.forEach((h, i) => { put(y, c + 1 + i, h); styles[`${y}:${c + 1 + i}`] = 'head'; });
            y++;
        }
        for (const [label, ...vals] of lines) {
            put(y, c, label);
            vals.forEach((v, i) => put(y, c + 1 + i, v));
            y++;
        }
        return y - r;
    };
    // top band: Event · Matchboard · Weather
    const ev = db.prepare('SELECT name FROM events WHERE id = ?').get(eventId);
    const root = getSetting(db, 'paths.vmixAssetsRoot');
    const w = getWeather(db);
    const weather = [['Forecast', 'forecast'], ['Air temperature', 'air_temp'],
        ['Wind speed', 'wind_speed'], ['Wind direction', 'wind_direction'], ['Wind degrees', 'wind_degrees']];
    const left = block(row, 0, 'EVENT', null, [['Name', ev?.name ?? ''], ['Stage', currentStage(db, eventId)?.name ?? ''], ['Date', today]]) + 1;
    const h = Math.max(left + block(row + left, 0, 'MATCHBOARD', null, [['Image', root ? joinVmixPath(root, MATCHBOARD_REL) : path.join(ctx.assetsDir, ...MATCHBOARD_REL.split('/'))]]), block(row, 3, 'WEATHER', null, weather.map(([label, k]) => [label, w[k] ?? ''])));
    row += h + 1;
    // general graphics: one block per kind, versions side by side
    const sets = listGraphicSets(db, eventId);
    const ev2 = db.prepare('SELECT id, timezone FROM events WHERE id = ?').get(eventId);
    const auto = ev2 ? tickerAuto(db, ev2) : {};
    for (const k of GRAPHIC_KINDS) {
        if (k.kind === 'announcement')
            continue; // own sheet: adding one shifts nothing here
        const vs = sets.filter((x) => x.kind === k.kind);
        // tickers: the same rows for free and fixed versions (a fixed one's messages are its sentence)
        const fields = k.kind === 'ticker' ? k.fields.filter((f) => f.key === 'position' || f.key === 'separator' || f.key === 'items') : k.fields.filter((f) => !f.hidden);
        const lines = fields.map((f) => [f.label, ...vs.map((s) => {
                if (k.kind === 'ticker' && f.key === 'items')
                    return tickerMessages(s.data, auto).join(' | ');
                const v = s.data[f.key] ?? '';
                return f.type === 'list' ? v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join(' | ') : v;
            })]);
        if (k.kind === 'ticker')
            lines.push(['Ticker text', ...vs.map((s) => tickerText(s.data, auto))]);
        row += block(row, 0, k.label.toUpperCase(), vs.map((s) => s.name), lines) + 1;
    }
    // people: one column per person
    // today's schedule last: one race per row
    block(row, 0, "TODAY'S SCHEDULE", ['Time', 'Race', 'Group'], listSchedule(db, eventId, today).map((s, i) => [`Race ${i + 1}`, s.time, s.race, groupLabel(s.fleet)]));
    const width = Math.max(...grid.map((r) => r.length), 2);
    const cols = Array.from({ length: width }, (_, i) => letter(i));
    // row 1 of the sheet names the columns by letter; data starts on row 2
    const out = grid.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ''])));
    out.styles = styles;
    out.widths = cols.map((_, i) => (i === 0 ? 20 : 30));
    return out;
}
// ---------- Announcements and People: their own sheets, one row each, so adding one moves nothing else ----------
export function announcementsSheet(ctx, eventId) {
    const k = GRAPHIC_KINDS.find((x) => x.kind === 'announcement');
    return listGraphicSets(ctx.db, eventId).filter((s) => s.kind === 'announcement')
        .map((s) => ({ Version: s.name, ...Object.fromEntries(k.fields.map((f) => [f.label, f.type === 'image' ? imagePath(ctx.db, ctx.assetsDir, s.data[f.key]) : s.data[f.key] ?? ''])) }));
}
export function peopleSheet(ctx, eventId) {
    return listPeople(ctx, eventId).map((p) => ({ Role: p.role, Language: p.language, Name: p.name, Surname: p.surname, Title: p.title, Photo: img(p.photo) }));
}
// ---------- Line-up ----------
/**
 * Line-up: one row per team of the stage (a vMix title shows one row). Team graphics first, then the places in the
 * order set in the Line-up panel: “1 Place”, “1 Name”, “1 Surname”, … for the first place, “2 …” for the second.
 */
export function lineupSheet(ctx, eventId) {
    const { db } = ctx;
    const { stage, teams } = stageTeams(ctx, eventId);
    const lineups = teams.map(({ t }) => loadLineup(db, eventId, t.id));
    const places = Math.max(9, ...lineups.map((l) => l.data.rows.length));
    return teams.map(({ t, group }, i) => {
        const lu = lineups[i];
        const defs = slotDefs(lu.data.extra);
        const a = t.assets;
        const row = {};
        if (stage)
            row.Group = group;
        Object.assign(row, {
            Code: t.code, Team: (lu.data.teamName || t.name).toUpperCase(), Title: lu.data.title,
            'Flag big': img(a.flag_big), 'Flag small': img(a.flag_small), 'Emblem light': img(a.emblem_light), 'Emblem dark': img(a.emblem_dark),
            'Line-up background': img(a.background_2),
            'Sponsor 1': img(a.sponsor_1), 'Sponsor 2': img(a.sponsor_2), 'Sponsor 3': img(a.sponsor_3), 'Sponsor 4': img(a.sponsor_4), 'Sponsor 5': img(a.sponsor_5),
        });
        for (let n = 1; n <= places; n++) {
            const r = lu.data.rows[n - 1];
            const filled = !!r && !!(r.firstName || r.lastName);
            row[`${n} Place`] = r ? defs.find((d) => d.key === r.slot)?.label ?? r.slot : '';
            row[`${n} Number`] = filled ? r.number : '';
            row[`${n} Name`] = filled ? r.firstName : '';
            row[`${n} Surname`] = filled ? r.lastName.toUpperCase() : '';
            row[`${n} Position`] = r ? r.position : '';
            row[`${n} Captain`] = filled && r.captain ? 'Yes' : '';
            row[`${n} Photo`] = filled && r.sailorId ? img(listAssets(ctx, 'sailor', r.sailorId).photo) : '';
        }
        return row;
    });
}
// ---------- Teams ----------
export function teamsSheet(ctx, eventId, today) {
    const { db } = ctx;
    const { stage, teams } = stageTeams(ctx, eventId);
    const ov = new Map(overview(ctx, eventId, today, null).teams.map((t) => [t.id, t]));
    const root = getSetting(db, 'paths.vmixAssetsRoot');
    const templates = listTemplates(db).filter((t) => t.enabled && t.scope !== 'neutral');
    const outputs = new Set(listOutputs(db).map((o) => o.rel));
    return teams.map(({ t, group, place }) => {
        const row = {};
        if (stage) {
            row.Group = group;
            row.Place = place;
        }
        Object.assign(row, {
            Code: t.code, Name: t.name, Nickname: t.nickname, Ranking: t.ranking, 'Ranking points': t.rankingPoints,
            'Team weight': ov.get(t.id)?.declaration?.totalWeight ?? '',
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
                placeOf.set(r.sailorId, { label: defs.find((d) => d.key === r.slot)?.label ?? r.slot, order: lu.data.rows.indexOf(r) + 1, row: r }); });
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
                const order = lu.data.rows.indexOf(r) + 1;
                list.push({ order, name: `${r.lastName} ${r.firstName}`, row: {
                        'Team code': t.code, Team: t.name, Captain: yes(r.captain), 'Line-up place': defs.find((d) => d.key === r.slot)?.label ?? r.slot, 'Line-up no.': String(order),
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
            Object.assign(row, { Group: groupLabel(g.fleetName), Title: g.title, Subtitle: g.subtitle, Rank: String(i + 1), Code: t?.code ?? '', Team: t?.name ?? '', Ranking: t?.ranking ?? '', Flag: img(t?.assets.flag_small) });
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
            Object.assign(row, { Group: groupLabel(g.fleetName), Title: g.title, Subtitle: g.subtitle, Rank: '', Code: '', Team: ph[pos - 1] ?? '', Ranking: '', Flag: '' });
            for (let j = 0; j < races; j++)
                row[`R${j + 1}`] = '';
            row.Points = '';
            rows.push(row);
        }
    }
    return rows;
}
// ---------- Racing now ----------
/**
 * Racing now: ONE row about the group picked at the top of the dashboard, with columns named as the fields of the
 * titles (Team comparison: T1Name, T1Nick, T1Rank, T1Weight, T1Captain, T1Flag …; standings: POS 1, TEAM 1, POINTS 1 …).
 * A vMix title bound to this row shows whichever group is racing: change the group in the dashboard, the title follows.
 */
export function nowSheet(ctx, eventId, today) {
    const { db } = ctx;
    const g = currentGroup(db);
    const ev = db.prepare('SELECT name, timezone FROM events WHERE id = ?').get(eventId);
    const stage = g ? db.prepare('SELECT name FROM fleet_sets WHERE id = ?').get(g.setId) : undefined;
    const row = {
        Stage: stage?.name ?? '', Group: g?.label ?? '', 'Group letter': g?.letter ?? '', 'Next race': g ? nextRace(db, eventId, ev?.timezone ?? 'UTC') : '',
        TITLE: (ev?.name ?? '').toUpperCase(), SUBTITLE: g?.label ?? '',
    };
    const teams = new Map(listTeams(ctx).map((t) => [t.id, t]));
    const ov = new Map(overview(ctx, eventId, today, null).teams.map((t) => [t.id, t]));
    const slots = g ? db.prepare('SELECT team_id AS teamId, position FROM fleet_slots WHERE fleet_id = ? ORDER BY position').all(g.id) : [];
    for (let n = 1; n <= 4; n++) {
        const t = teams.get(slots.find((x) => x.position === n)?.teamId ?? '');
        const captain = t ? loadLineup(db, eventId, t.id).data.rows.find((r) => r.captain) : undefined;
        Object.assign(row, {
            [`T${n}Code`]: t?.code ?? '', [`T${n}Name`]: (t?.name ?? '').toUpperCase(), [`T${n}Nick`]: t?.nickname ?? '', [`T${n}Rank`]: t?.ranking ?? '',
            [`T${n}Weight`]: t ? ov.get(t.id)?.declaration?.totalWeight ?? '' : '', [`T${n}Captain`]: captain ? `${captain.firstName} ${captain.lastName}`.trim() : '',
            [`T${n}Flag`]: img(t?.assets.flag_small),
        });
    }
    const res = g ? listResults(db, g.setId).find((x) => x.fleetId === g.id) : undefined;
    for (let n = 1; n <= 4; n++) {
        const r = res?.rows[n - 1];
        const t = r ? teams.get(r.teamId) : undefined;
        row[`POS ${n}`] = r ? String(n) : '';
        row[`TEAM ${n}`] = t?.code ?? '';
        row[`POINTS ${n}`] = r?.total ?? '';
        for (let j = 1; j <= 6; j++)
            row[`R${j} ${n}`] = r && res && j <= res.races ? r.races[j - 1] ?? '' : '';
    }
    return [row];
}
export const SHEETS = [
    { name: 'General', key: 'general' },
    { name: 'Teams', key: 'teams' },
    { name: 'Sailors', key: 'sailors' },
    { name: 'Line-up', key: 'lineup' },
    { name: 'Results', key: 'results' },
    { name: 'Announcements', key: 'announcements' },
    { name: 'People', key: 'people' },
    { name: 'Racing now', key: 'now' },
];
export function sheetRows(ctx, eventId, today, key) {
    if (key === 'general')
        return generalSheet(ctx, eventId, today);
    if (key === 'teams')
        return teamsSheet(ctx, eventId, today);
    if (key === 'sailors')
        return sailorsSheet(ctx, eventId, today);
    if (key === 'lineup')
        return lineupSheet(ctx, eventId);
    if (key === 'results')
        return resultsSheet(ctx, eventId);
    if (key === 'announcements')
        return announcementsSheet(ctx, eventId);
    if (key === 'people')
        return peopleSheet(ctx, eventId);
    if (key === 'now')
        return nowSheet(ctx, eventId, today);
    throw badRequest(`Unknown sheet: ${key}`);
}
