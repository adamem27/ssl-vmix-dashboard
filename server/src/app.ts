import Fastify, { FastifyInstance, FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import { z, ZodError } from 'zod';
import { activeEvent, DB, getSetting, nowIso, setSetting } from './db/db.js';
import { AssetCtx, listAssets, previewFile, recheckAsset, removeAsset, saveUpload, savePath } from './services/assets.js';
import { HttpError, badRequest, notFound } from './services/errors.js';
import { OwnerType, SAILOR_SLOTS, TEAM_SLOTS } from './services/slots.js';
import { createTeam, deleteTeam, getTeam, listTeams, updateTeam } from './services/teams.js';
import { createSailor, deleteSailor, getSailor, listSailors, updateSailor } from './services/sailors.js';
import * as fleets from './services/fleets.js';
import * as decl from './services/declarations.js';
import { SyncService } from './services/sync.js';
import { demoSourceHtml, hasDemo, removeDemo, seedDemo } from './services/demo.js';
import { overview } from './services/overview.js';
import { applyGoldCup2026, PRESETS } from './services/presets.js';
import { isWindowsPath, validateEnteredPath } from './services/paths.js';

export interface AppDeps { db: DB; assetsDir: string; sync: SyncService; webDist?: string; dbPath?: string; maxUploadBytes?: number }

const str = (max = 500) => z.string().max(max);
const id = z.string().min(1).max(64);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { db, sync } = deps;
  const ctx: AssetCtx = { db, assetsDir: deps.assetsDir };
  fs.mkdirSync(deps.assetsDir, { recursive: true });

  const app = Fastify({ logger: process.env.NODE_ENV === 'test' ? false : { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 5 * 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: deps.maxUploadBytes ?? 40 * 1024 * 1024, files: 1 } });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, details: err.details });
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'Invalid data: ' + err.issues.map((i) => `${i.path.join('.') || 'field'} – ${i.message}`).join('; ') });
    }
    if (err?.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ error: 'The file is too large.' });
    if (typeof err?.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
      return reply.status(409).send({ error: 'The operation would break data consistency (e.g. a duplicate or a taken place).' });
    }
    app.log.error(err);
    return reply.status(err.statusCode ?? 500).send({ error: err.statusCode && err.statusCode < 500 ? err.message : 'Internal server error.' });
  });

  const ev = () => activeEvent(db);

  // ---------- meta ----------
  app.get('/api/health', async () => ({ ok: true, time: nowIso() }));
  app.get('/api/meta', async () => ({
    event: ev(),
    teamSlots: TEAM_SLOTS,
    sailorSlots: SAILOR_SLOTS,
    hasDemo: hasDemo(ctx),
  }));

  // ---------- teams ----------
  const teamBody = z.object({ name: str(120).min(1, 'Name is required'), code: str(20).min(1, 'Code is required'), aliases: z.array(str(120)).max(50).optional(), notes: str(2000).optional() });
  app.get('/api/teams', async () => listTeams(ctx));
  app.post('/api/teams', async (req) => getTeam(ctx, createTeam(db, teamBody.parse(req.body))));
  app.get<{ Params: { id: string } }>('/api/teams/:id', async (req) => getTeam(ctx, req.params.id));
  app.patch<{ Params: { id: string } }>('/api/teams/:id', async (req) => {
    updateTeam(db, req.params.id, teamBody.partial().parse(req.body));
    return getTeam(ctx, req.params.id);
  });
  app.delete<{ Params: { id: string } }>('/api/teams/:id', async (req) => { deleteTeam(ctx, req.params.id); return { ok: true }; });
  app.get<{ Params: { id: string } }>('/api/teams/:id/sailors', async (req) => { getTeam(ctx, req.params.id); return listSailors(ctx, req.params.id); });

  // ---------- assets (team slots and sailor photo share one API) ----------
  const ownerOf = (kind: string): OwnerType => {
    if (kind === 'teams') return 'team';
    if (kind === 'sailors') return 'sailor';
    throw notFound('Asset');
  };
  app.post<{ Params: { kind: string; id: string; slot: string } }>('/api/:kind/:id/assets/:slot/upload', async (req) => {
    const owner = ownerOf(req.params.kind);
    const file = await req.file();
    if (!file) throw badRequest('No file was uploaded.');
    const buf = await file.toBuffer();
    return saveUpload(ctx, owner, req.params.id, req.params.slot, buf, file.filename);
  });
  app.put<{ Params: { kind: string; id: string; slot: string } }>('/api/:kind/:id/assets/:slot/path', async (req) => {
    const { path } = z.object({ path: str(1000) }).parse(req.body);
    return savePath(ctx, ownerOf(req.params.kind), req.params.id, req.params.slot, path);
  });
  app.delete<{ Params: { kind: string; id: string; slot: string } }>('/api/:kind/:id/assets/:slot', async (req) => {
    removeAsset(ctx, ownerOf(req.params.kind), req.params.id, req.params.slot);
    return { ok: true };
  });
  app.get<{ Params: { kind: string; id: string } }>('/api/:kind/:id/assets', async (req) => listAssets(ctx, ownerOf(req.params.kind), req.params.id));
  app.post<{ Params: { id: string } }>('/api/assets/:id/recheck', async (req) => recheckAsset(ctx, req.params.id));
  app.get<{ Params: { id: string } }>('/api/assets/:id/file', async (req, reply: FastifyReply) => {
    const f = previewFile(ctx, req.params.id);
    if (!f) return reply.status(404).send({ error: 'Preview unavailable.' });
    reply.header('Content-Type', f.mime).header('Cache-Control', 'private, max-age=60');
    return reply.send(fs.createReadStream(f.path));
  });

  // ---------- sailors ----------
  const sailorBody = z.object({
    firstName: str(80), lastName: str(80), defaultPosition: str(80), defaultNumber: str(10),
    bestResult1: str(500), bestResult2: str(500), sourceRef: str(200).nullable(),
  }).partial();
  app.post<{ Params: { id: string } }>('/api/teams/:id/sailors', async (req) => {
    const body = sailorBody.parse(req.body);
    if (!body.firstName?.trim() && !body.lastName?.trim()) throw badRequest('Enter a first or last name.');
    return getSailor(ctx, createSailor(db, req.params.id, body));
  });
  app.get<{ Params: { id: string } }>('/api/sailors/:id', async (req) => getSailor(ctx, req.params.id));
  app.patch<{ Params: { id: string } }>('/api/sailors/:id', async (req) => {
    updateSailor(db, req.params.id, sailorBody.parse(req.body));
    return getSailor(ctx, req.params.id);
  });
  app.delete<{ Params: { id: string } }>('/api/sailors/:id', async (req) => { deleteSailor(ctx, req.params.id); return { ok: true }; });

  // ---------- fleets ----------
  app.get('/api/fleet-sets', async () => fleets.listSets(db, ev().id));
  app.post('/api/fleet-sets', async (req) => {
    const b = z.object({ name: str(120).min(1, 'Name is required'), fleetCount: z.number().int().min(0).max(30).optional() }).parse(req.body);
    return fleets.getSetDetail(db, fleets.createSet(db, ev().id, b.name.trim(), b.fleetCount ?? 0));
  });
  app.get<{ Params: { id: string } }>('/api/fleet-sets/:id', async (req) => fleets.getSetDetail(db, req.params.id));
  app.patch<{ Params: { id: string } }>('/api/fleet-sets/:id', async (req) => {
    fleets.renameSet(db, req.params.id, z.object({ name: str(120).min(1) }).parse(req.body).name.trim());
    return fleets.getSetDetail(db, req.params.id);
  });
  app.delete<{ Params: { id: string } }>('/api/fleet-sets/:id', async (req) => { fleets.deleteSet(db, req.params.id); return { ok: true }; });
  app.post<{ Params: { id: string } }>('/api/fleet-sets/:id/fleets', async (req) => {
    const { name } = z.object({ name: str(120).min(1, 'Name is required') }).parse(req.body);
    fleets.createFleet(db, req.params.id, name.trim());
    return fleets.getSetDetail(db, req.params.id);
  });
  app.patch<{ Params: { id: string } }>('/api/fleets/:id', async (req) => {
    const { name } = z.object({ name: str(120).min(1) }).parse(req.body);
    fleets.renameFleet(db, req.params.id, name.trim());
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/fleets/:id/move', async (req) => {
    fleets.moveFleet(db, req.params.id, z.object({ direction: z.union([z.literal(-1), z.literal(1)]) }).parse(req.body).direction);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/fleets/:id', async (req) => { fleets.deleteFleet(db, req.params.id); return { ok: true }; });
  app.post<{ Params: { id: string } }>('/api/fleet-sets/:id/place', async (req) => {
    const b = z.object({ teamId: id, fleetId: id, position: z.number().int().optional(), onOccupied: z.enum(['reject', 'swap']).optional() }).parse(req.body);
    let position = b.position;
    if (position === undefined) {
      const free = fleets.firstFreePosition(db, b.fleetId);
      if (free === null) throw badRequest('This fleet already has four teams. Choose a specific place to swap.');
      position = free;
    }
    const result = fleets.placeTeam(db, req.params.id, { teamId: b.teamId, fleetId: b.fleetId, position, onOccupied: b.onOccupied });
    return { ...fleets.getSetDetail(db, req.params.id), result };
  });
  app.post<{ Params: { id: string } }>('/api/fleet-sets/:id/unassign', async (req) => {
    fleets.unassignTeam(db, req.params.id, z.object({ teamId: id }).parse(req.body).teamId);
    return fleets.getSetDetail(db, req.params.id);
  });

  // ---------- declarations ----------
  app.get<{ Querystring: { date?: string; set?: string } }>('/api/overview', async (req) =>
    overview(ctx, ev().id, String(req.query.date ?? ''), req.query.set ? String(req.query.set) : null));
  app.get('/api/declarations/dates', async () => decl.listDates(db, ev().id));
  app.get<{ Querystring: { date: string } }>('/api/declarations/overview', async (req) => decl.dateOverview(db, ev().id, String(req.query.date ?? '')));
  app.get('/api/declarations/unmatched', async () => decl.unmatchedMembers(db, ev().id));
  app.get<{ Querystring: { teamId: string; date: string } }>('/api/declarations', async (req) =>
    ({ declaration: decl.getDeclaration(ctx, ev().id, String(req.query.teamId ?? ''), String(req.query.date ?? '')) }));
  app.post('/api/declarations', async (req) => {
    const b = z.object({ teamId: id, date: str(10), prefill: z.enum(['empty', 'previous', 'roster']).default('empty') }).parse(req.body);
    return decl.createManualDeclaration(ctx, ev().id, b.teamId, b.date, b.prefill);
  });
  app.get<{ Params: { id: string } }>('/api/declarations/:id', async (req) => decl.getDeclarationById(ctx, req.params.id));
  app.patch<{ Params: { id: string } }>('/api/declarations/:id', async (req) => {
    decl.updateDeclarationNotes(db, req.params.id, z.object({ notes: str(2000) }).parse(req.body).notes);
    return decl.getDeclarationById(ctx, req.params.id);
  });
  app.delete<{ Params: { id: string } }>('/api/declarations/:id', async (req) => { decl.deleteDeclaration(db, req.params.id); return { ok: true }; });
  app.post<{ Params: { id: string } }>('/api/declarations/:id/members', async (req) => {
    decl.addMember(ctx, req.params.id, z.object({ sailorId: id, position: str(80).optional(), number: str(10).optional() }).parse(req.body));
    return decl.getDeclarationById(ctx, req.params.id);
  });
  const memberDecl = (memberId: string) => {
    const r = db.prepare('SELECT declaration_id FROM declaration_members WHERE id = ?').get(memberId) as { declaration_id: string } | undefined;
    if (!r) throw notFound('Crew member');
    return r.declaration_id;
  };
  app.patch<{ Params: { id: string } }>('/api/declaration-members/:id', async (req) => {
    const d = memberDecl(req.params.id);
    decl.setOverride(db, req.params.id, z.object({ position: str(80).optional(), number: str(10).optional() }).parse(req.body));
    return decl.getDeclarationById(ctx, d);
  });
  app.post<{ Params: { id: string } }>('/api/declaration-members/:id/reset', async (req) => {
    const d = memberDecl(req.params.id);
    decl.clearOverride(db, req.params.id, z.object({ field: z.enum(['position', 'number', 'all']) }).parse(req.body).field);
    return decl.getDeclarationById(ctx, d);
  });
  app.post<{ Params: { id: string } }>('/api/declaration-members/:id/assign', async (req) => {
    const d = memberDecl(req.params.id);
    const b = z.object({ sailorId: id.nullable(), remember: z.boolean().default(true) }).parse(req.body);
    decl.assignSailor(db, req.params.id, b.sailorId, b.remember);
    return decl.getDeclarationById(ctx, d);
  });
  app.post<{ Params: { id: string } }>('/api/declaration-members/:id/create-sailor', async (req) => {
    const d = memberDecl(req.params.id);
    decl.createSailorFromMember(db, req.params.id);
    return decl.getDeclarationById(ctx, d);
  });
  app.post<{ Params: { id: string } }>('/api/declaration-members/:id/move', async (req) => {
    const d = memberDecl(req.params.id);
    decl.moveMember(db, req.params.id, z.object({ direction: z.union([z.literal(-1), z.literal(1)]) }).parse(req.body).direction);
    return decl.getDeclarationById(ctx, d);
  });
  app.delete<{ Params: { id: string } }>('/api/declaration-members/:id', async (req) => {
    const d = memberDecl(req.params.id);
    decl.removeMember(db, req.params.id);
    return decl.getDeclarationById(ctx, d);
  });

  // ---------- sync ----------
  app.get('/api/sync/status', async () => sync.status());
  app.get('/api/sync/runs', async () => sync.history(30));
  app.put('/api/sync/config', async (req) => {
    const b = z.object({
      url: str(1000).optional(), enabled: z.boolean().optional(), intervalMinutes: z.number().int().min(5, 'The minimum interval is 5 minutes').max(1440).optional(),
      importer: str(60).optional(),
    }).parse(req.body);
    if (b.url !== undefined && b.url.trim() && !/^https?:\/\/[^\s]+$/i.test(b.url.trim())) throw badRequest('The source URL must start with http:// or https://.');
    if (b.url !== undefined) setSetting(db, 'sync.url', b.url.trim());
    if (b.enabled !== undefined) setSetting(db, 'sync.enabled', String(b.enabled));
    if (b.intervalMinutes !== undefined) setSetting(db, 'sync.intervalMinutes', String(b.intervalMinutes));
    if (b.importer !== undefined) setSetting(db, 'sync.importer', b.importer);
    return sync.status();
  });
  app.post('/api/sync/run', async () => ({ outcome: await sync.runNow('manual'), status: sync.status() }));
  app.post('/api/sync/upload', async (req) => {
    const file = await req.file();
    if (!file) throw badRequest('No file was uploaded.');
    const body = (await file.toBuffer()).toString('utf8');
    return { outcome: await sync.runNow('upload', { body, filename: file.filename }), status: sync.status() };
  });
  app.post('/api/sync/demo-import', async () => {
    if (!hasDemo(ctx)) throw badRequest('Load the demo data first.');
    return { outcome: await sync.runNow('upload', { body: demoSourceHtml(), filename: 'DEMO demo-crew-list.html', baseUrl: null }), status: sync.status() };
  });

  // ---------- settings ----------
  app.get('/api/settings', async () => ({
    event: ev(),
    paths: {
      dataDir: deps.dbPath ? deps.dbPath.replace(/[\\/][^\\/]+$/, '') : null,
      dbPath: deps.dbPath ?? null,
      assetsDir: deps.assetsDir,
      vmixAssetsRoot: getSetting(db, 'paths.vmixAssetsRoot'),
    },
    hasDemo: hasDemo(ctx),
  }));
  app.put('/api/settings/event', async (req) => {
    const b = z.object({ name: str(200).min(1), timezone: str(64), year: z.number().int().min(2000).max(2100) }).parse(req.body);
    try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); } catch { throw badRequest(`Nieznana strefa czasowa: ${b.timezone}`); }
    db.prepare('UPDATE events SET name = ?, timezone = ?, year = ?, updated_at = ? WHERE id = ?').run(b.name.trim(), b.timezone, b.year, nowIso(), ev().id);
    return ev();
  });
  app.put('/api/settings/paths', async (req) => {
    const { vmixAssetsRoot } = z.object({ vmixAssetsRoot: str(500) }).parse(req.body);
    const v = vmixAssetsRoot.trim();
    if (v) {
      const err = validateEnteredPath(v);
      if (err) throw badRequest(err.replace('The path', 'The vMix folder'));
    }
    setSetting(db, 'paths.vmixAssetsRoot', v);
    return { vmixAssetsRoot: v, windows: v ? isWindowsPath(v) : null };
  });
  app.post('/api/demo/seed', async () => seedDemo(ctx));
  app.post('/api/demo/remove', async () => removeDemo(ctx));
  app.get('/api/presets', async () => PRESETS);
  app.post('/api/presets/ssl-gold-cup-2026', async () => applyGoldCup2026(db));

  // ---------- web UI ----------
  if (deps.webDist && fs.existsSync(deps.webDist)) {
    await app.register(fastifyStatic, { root: deps.webDist, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found.' });
      return reply.type('text/html').send(fs.createReadStream(deps.webDist + '/index.html'));
    });
  }
  return app;
}
