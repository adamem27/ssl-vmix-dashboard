import { z } from 'zod';
import { activeEvent } from '../db/db.js';
import * as gs from './graphicSets.js';
import * as lu from './lineups.js';
import * as rs from './results.js';
import * as wb from './workbookSheets.js';
import { todayIn } from './dates.js';
import { getWeather, listSchedule } from './general.js';
import { listGradients } from './generator/generator.js';
import * as vx from './vmixResults.js';
/** General graphics versions, team line-ups (Declarations and line-ups) and group results (Results tab). */
export function registerBroadcastRoutes(app, ctx) {
    const { db } = ctx;
    const ev = () => activeEvent(db);
    const s = (max) => z.string().max(max);
    // ---------- general graphics versions ----------
    app.get('/api/graphic-sets', async () => { gs.seedGraphicSets(db, ev().id); return { kinds: gs.GRAPHIC_KINDS, sets: gs.listGraphicSets(db, ev().id) }; });
    app.post('/api/graphic-sets', async (req) => {
        const b = z.object({ kind: s(40), name: s(80).optional(), copyFrom: s(64).optional() }).parse(req.body);
        return { id: gs.createGraphicSet(db, ev().id, b.kind, b.name ?? '', {}, b.copyFrom) };
    });
    app.patch('/api/graphic-sets/:id', async (req) => gs.updateGraphicSet(db, req.params.id, z.object({ name: s(80), data: z.record(z.string(), s(4000)) }).partial().parse(req.body)));
    app.post('/api/graphic-sets/:id/move', async (req) => { gs.moveGraphicSet(db, req.params.id, z.object({ dir: z.union([z.literal(-1), z.literal(1)]) }).parse(req.body).dir); return { ok: true }; });
    app.delete('/api/graphic-sets/:id', async (req) => { gs.deleteGraphicSet(db, req.params.id); return { ok: true }; });
    // ---------- line-ups ----------
    const row = z.object({ slot: s(20), sailorId: s(64).nullable(), firstName: s(80), lastName: s(80), number: s(10), position: s(40), captain: z.boolean() }).partial().required({ slot: true });
    app.get('/api/lineups', async () => lu.lineupStatus(db, ev().id));
    app.get('/api/lineups/:teamId', async (req) => lu.getLineup(ctx, ev().id, req.params.teamId));
    app.put('/api/lineups/:teamId', async (req) => lu.saveLineup(ctx, ev().id, req.params.teamId, z.object({ title: s(60), teamName: s(80), extra: z.number().int().min(0).max(lu.MAX_EXTRA), rows: z.array(row).max(20), order: z.array(s(20)).max(20) }).partial().parse(req.body)));
    app.delete('/api/lineups/:teamId', async (req) => lu.clearLineup(ctx, ev().id, req.params.teamId));
    const date = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
    app.post('/api/lineups/:teamId/sync', async (req) => {
        const r = lu.syncLineupFromDeclaration(ctx, ev().id, req.params.teamId, date.parse(req.body).date);
        return { ...r, lineup: lu.getLineup(ctx, ev().id, req.params.teamId) };
    });
    app.post('/api/lineups/sync-all', async (req) => lu.syncAllLineups(ctx, ev().id, date.parse(req.body).date, wb.stageTeamIds(db, ev().id)));
    // ---------- results ----------
    app.get('/api/results/set/:setId', async (req) => rs.listResults(db, req.params.setId));
    app.put('/api/results/:fleetId', async (req) => rs.saveResults(db, req.params.fleetId, z.object({
        title: s(120), subtitle: s(120), vmixInput: s(120), races: z.number().int().min(1).max(rs.MAX_RACES),
        rows: z.array(z.object({ teamId: s(64), races: z.array(s(12)).max(rs.MAX_RACES).optional(), points: s(12).optional() })).max(32),
        order: z.array(s(64)).max(32),
    }).partial().parse(req.body)));
    app.post('/api/results/:fleetId/sort', async (req) => rs.sortResults(db, req.params.fleetId));
    app.delete('/api/results/:fleetId', async (req) => rs.clearResults(db, req.params.fleetId));
    // straight into the vMix title through the vMix Web API (no Data Source mapping)
    app.post('/api/results/:fleetId/vmix', async (req) => {
        const b = z.object({ input: s(120) }).partial().parse(req.body ?? {});
        if (b.input !== undefined)
            rs.saveResults(db, req.params.fleetId, { vmixInput: b.input });
        return vx.pushResults(ctx, req.params.fleetId, rs.getResults(db, req.params.fleetId).vmixInput);
    });
    app.get('/api/settings/vmix', async () => ({ apiUrl: vx.vmixUrl(db), default: vx.DEFAULT_VMIX_URL }));
    app.put('/api/settings/vmix', async (req) => vx.setVmixUrl(db, z.object({ apiUrl: s(200) }).parse(req.body).apiUrl));
    // ---------- current stage (decides which teams and groups go to the workbook) ----------
    const stageInfo = () => ({ current: wb.currentStage(db, ev().id), teamIds: wb.stageTeamIds(db, ev().id), stages: db.prepare('SELECT id, name FROM fleet_sets WHERE event_id = ? ORDER BY sort, created_at').all(ev().id) });
    app.get('/api/stage', async () => stageInfo());
    app.put('/api/stage', async (req) => { wb.setCurrentStage(db, ev().id, z.object({ setId: z.string().max(64).nullable() }).parse(req.body).setId); return stageInfo(); });
    // ---------- commentator: everything around one fleet set in one call ----------
    app.get('/api/commentator', async (req) => {
        const e = ev();
        const date = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : todayIn(e.timezone);
        const setId = req.query.set ? String(req.query.set) : wb.currentStage(db, e.id)?.id ?? null;
        const results = setId ? rs.listResults(db, setId) : [];
        const teamIds = new Set(results.flatMap((g) => g.rows.map((r) => r.teamId)));
        const colours = {};
        for (const g of listGradients(db))
            if (teamIds.has(g.teamId))
                colours[g.teamId] = g.gradients[1] ?? null;
        const lineups = {};
        for (const id of teamIds) {
            const l = lu.loadLineup(db, e.id, id);
            if (!l.exists)
                continue;
            const defs = lu.slotDefs(l.data.extra);
            lineups[id] = l.data.rows.filter((r) => r.firstName || r.lastName).map((r) => ({
                label: defs.find((d) => d.key === r.slot)?.label ?? r.slot, number: r.number, firstName: r.firstName, lastName: r.lastName,
                position: r.position, captain: r.captain, sailorId: r.sailorId,
            }));
        }
        return {
            event: { name: db.prepare('SELECT name FROM events WHERE id = ?').get(e.id)?.name ?? '', timezone: e.timezone },
            stage: wb.currentStage(db, e.id), setId, date,
            weather: getWeather(db), schedule: listSchedule(db, e.id, date),
            results: results.map((g) => ({ fleetId: g.fleetId, fleetName: g.fleetName, title: g.title, subtitle: g.subtitle, races: g.races, rows: g.rows.map((r) => ({ teamId: r.teamId, races: r.races, total: r.total })) })),
            colours, lineups,
        };
    });
    // ---------- JSON for vMix ----------
    app.get('/json/sheet/:key', async (req) => wb.sheetRows(ctx, ev().id, todayIn(ev().timezone), req.params.key));
    app.get('/json/graphics-sets/:kind', async (req) => gs.graphicSheetRows(db, ev().id, req.params.kind));
    // both follow the current stage like the workbook does
    app.get('/json/lineups', async () => {
        const ids = wb.stageTeamIds(db, ev().id);
        const codes = ids && new Set(ids.map((id) => db.prepare('SELECT code FROM teams WHERE id = ?').get(id)?.code));
        return lu.lineupSheetRows(ctx, ev().id).filter((r) => !codes || codes.has(r.code));
    });
    app.get('/json/results', async () => {
        const stage = wb.currentStage(db, ev().id);
        return rs.resultSheetRows(ctx, ev().id).filter((r) => !stage || r.set === stage.name);
    });
}
