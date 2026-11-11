import { groupLabel } from './groups.js';
import { listAssets } from './assets.js';
import { getWeather, listPeople, listSchedule, personName } from './general.js';
import { notFound } from './errors.js';
import { overview } from './overview.js';
import { SAILOR_SLOTS, TEAM_SLOTS } from './slots.js';
import { listTeams } from './teams.js';
const img = (a) => (a ? a.vmixPath ?? a.storedPath ?? a.enteredPath ?? '' : '');
function teamFields(t) {
    const o = { code: t.code, name: t.name, nickname: t.nickname, ranking: t.ranking, ranking_points: t.rankingPoints };
    for (const s of TEAM_SLOTS)
        o[s.key] = img(t.assets[s.key]);
    return o;
}
function captainFields(ctx, teamId) {
    const c = ctx.db.prepare('SELECT * FROM sailors WHERE team_id = ? AND is_captain = 1').get(teamId);
    return {
        captain_name: c ? `${c.first_name} ${c.last_name}`.trim() : '',
        captain_first_name: c?.first_name ?? '', captain_last_name: c?.last_name ?? '',
        captain_number: c?.default_number ?? '', captain_position: c?.default_position ?? '',
        captain_best_result_1: c?.best_result_1 ?? '', captain_best_result_2: c?.best_result_2 ?? '', captain_best_result_3: c?.best_result_3 ?? '',
        captain_photo: c ? img(listAssets(ctx, 'sailor', c.id).photo) : '',
    };
}
export function jsonTeams(ctx) {
    return listTeams(ctx).map((t) => ({ ...teamFields(t), ...captainFields(ctx, t.id) }));
}
/** One row per team with its captain, for comparison graphics. */
export function jsonCaptains(ctx) {
    return listTeams(ctx).map((t) => ({ code: t.code, name: t.name, nickname: t.nickname, flag_small: img(t.assets.flag_small), flag_big: img(t.assets.flag_big), ...captainFields(ctx, t.id) }));
}
export function jsonWeather(db) {
    return [getWeather(db)];
}
export function jsonSchedule(db, eventId, date) {
    return listSchedule(db, eventId, date).map(({ id: _id, ...r }) => r);
}
export function jsonPeople(ctx, eventId, role, language) {
    return listPeople(ctx, eventId)
        .filter((p) => (!role || p.role.toLowerCase() === role.toLowerCase()) && (!language || p.language.toLowerCase() === language.toLowerCase()))
        .map((p) => ({ name: p.name, surname: p.surname, full_name: personName(p), role: p.role, language: p.language, title: p.title, photo: img(p.photo) }));
}
export function jsonSailors(ctx, eventId, date, teamCode) {
    const ov = overview(ctx, eventId, date, null);
    const rows = [];
    for (const t of ov.teams) {
        if (teamCode && t.code.toLowerCase() !== teamCode.toLowerCase())
            continue;
        const sailors = t.declaration ? t.sailors.filter((s) => s.declared).sort((a, b) => a.declared.sort - b.declared.sort) : t.sailors;
        for (const s of sailors) {
            rows.push({
                team_code: t.code, team_name: t.name, team_nickname: t.nickname,
                captain: s.isCaptain ? '1' : '',
                first_name: s.firstName, last_name: s.lastName, full_name: `${s.firstName} ${s.lastName}`.trim(),
                number: s.declared?.number || s.defaultNumber, position: s.declared?.position || s.defaultPosition,
                weight: s.declared?.weight ?? '', team_total_weight: t.declaration?.totalWeight ?? '',
                best_result_1: s.bestResult1, best_result_2: s.bestResult2, best_result_3: s.bestResult3,
                [SAILOR_SLOTS[0].key]: img(s.photo),
            });
        }
    }
    return rows;
}
export function jsonFleetSet(ctx, setId) {
    const { db } = ctx;
    if (!db.prepare('SELECT 1 FROM fleet_sets WHERE id = ?').get(setId))
        throw notFound('Stage');
    const teams = new Map(listTeams(ctx).map((t) => [t.id, t]));
    const fleets = db.prepare('SELECT id, name, placeholders, size FROM fleets WHERE fleet_set_id = ? ORDER BY sort, created_at').all(setId);
    const slots = db.prepare('SELECT fleet_id, position, team_id FROM fleet_slots WHERE fleet_set_id = ?').all(setId);
    const rows = [];
    for (const f of fleets) {
        const ph = JSON.parse(f.placeholders || '[]');
        for (let p = 1; p <= (f.size || 4); p++) {
            const t = teams.get(slots.find((s) => s.fleet_id === f.id && s.position === p)?.team_id);
            const empty = Object.fromEntries(TEAM_SLOTS.map((s) => [s.key, '']));
            rows.push({ group: groupLabel(f.name), fleet: f.name, place: String(p), ...(t ? teamFields(t) : { code: ph[p - 1] || '', name: ph[p - 1] || '', nickname: '', ranking: '', ranking_points: '', ...empty }) });
        }
    }
    return rows;
}
export function jsonIndex(_db, _eventId) {
    return [
        { name: 'General', path: '/json/sheet/general' },
        { name: 'Teams', path: '/json/sheet/teams' },
        { name: 'Sailors', path: '/json/sheet/sailors' },
        { name: 'Line-up', path: '/json/sheet/lineup' },
        { name: 'Results', path: '/json/sheet/results' },
        { name: 'Announcements', path: '/json/sheet/announcements' },
        { name: 'People', path: '/json/sheet/people' },
    ];
}
