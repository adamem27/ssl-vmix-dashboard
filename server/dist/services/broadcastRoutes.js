import { z } from 'zod';
import { activeEvent } from '../db/db.js';
import * as gs from './graphicSets.js';
import * as lu from './lineups.js';
import * as rs from './results.js';
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
    app.put('/api/lineups/:teamId', async (req) => lu.saveLineup(ctx, ev().id, req.params.teamId, z.object({ title: s(60), teamName: s(80), extra: z.number().int().min(0).max(lu.MAX_EXTRA), rows: z.array(row).max(20) }).partial().parse(req.body)));
    app.delete('/api/lineups/:teamId', async (req) => lu.clearLineup(ctx, ev().id, req.params.teamId));
    const date = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
    app.post('/api/lineups/:teamId/sync', async (req) => {
        const r = lu.syncLineupFromDeclaration(ctx, ev().id, req.params.teamId, date.parse(req.body).date);
        return { ...r, lineup: lu.getLineup(ctx, ev().id, req.params.teamId) };
    });
    app.post('/api/lineups/sync-all', async (req) => lu.syncAllLineups(ctx, ev().id, date.parse(req.body).date));
    // ---------- results ----------
    app.get('/api/results/set/:setId', async (req) => rs.listResults(db, req.params.setId));
    app.put('/api/results/:fleetId', async (req) => rs.saveResults(db, req.params.fleetId, z.object({
        title: s(120), subtitle: s(120), races: z.number().int().min(1).max(rs.MAX_RACES),
        rows: z.array(z.object({ teamId: s(64), races: z.array(s(12)).max(rs.MAX_RACES).optional(), points: s(12).optional() })).max(32),
        order: z.array(s(64)).max(32),
    }).partial().parse(req.body)));
    app.post('/api/results/:fleetId/sort', async (req) => rs.sortResults(db, req.params.fleetId));
    app.delete('/api/results/:fleetId', async (req) => rs.clearResults(db, req.params.fleetId));
    // ---------- JSON for vMix ----------
    app.get('/json/graphics-sets/:kind', async (req) => gs.graphicSheetRows(db, ev().id, req.params.kind));
    app.get('/json/lineups', async () => lu.lineupSheetRows(ctx, ev().id));
    app.get('/json/results', async () => rs.resultSheetRows(ctx, ev().id));
}
