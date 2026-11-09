import Fastify, { FastifyInstance, FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { z, ZodError } from 'zod';
import { activeEvent, DB, getSetting, nowIso, setSetting } from './db/db.js';
import { AssetCtx, listAssets, previewFile, recheckAsset, removeAsset, saveUpload, savePath } from './services/assets.js';
import { HttpError, badRequest, notFound } from './services/errors.js';
import { OwnerType, SAILOR_SLOTS, TEAM_SLOTS } from './services/slots.js';
import { createTeam, deleteTeam, getTeam, listTeams, updateTeam } from './services/teams.js';
import { createSailor, setCaptain, deleteSailor, getSailor, listSailors, updateSailor } from './services/sailors.js';
import * as fleets from './services/fleets.js';
import * as decl from './services/declarations.js';
import * as ranking from './services/ranking.js';
import * as mb from './services/matchboard/matchboard.js';
import { SyncService } from './services/sync.js';
import { allSheets, WorkbookWriter } from './services/workbook.js';
import { stageTeamIds } from './services/workbookSheets.js';
import { buildXlsx, zipStore } from './services/xlsx.js';
import * as pngGen from './services/generator/generator.js';
import { GtzipService } from './services/gtzip/gtzip.js';
import { registerGtzipRoutes } from './services/gtzip/routes.js';
import { registerBroadcastRoutes } from './services/broadcastRoutes.js';
import { demoSourceHtml, hasDemo, removeDemo, seedDemo } from './services/demo.js';
import { overview } from './services/overview.js';
import * as gen from './services/general.js';
import { jsonCaptains, jsonFleetSet, jsonIndex, jsonPeople, jsonSailors, jsonSchedule, jsonTeams, jsonWeather } from './services/jsonExport.js';
import { todayIn } from './services/dates.js';
import { versionInfo } from './version.js';
import { applyGoldCupAll, PRESETS } from './services/presets.js';
import { isWindowsPath, joinVmixPath, validateEnteredPath } from './services/paths.js';
import { authToken, cookieOk, listMirrorFiles, loginPage, mirrorFilePath, passwordOk } from './services/mirror.js';

export interface AppDeps { db: DB; assetsDir: string; sync: SyncService; workbook?: WorkbookWriter; webDist?: string; dbPath?: string; maxUploadBytes?: number; password?: string; generator?: pngGen.GeneratorExporter; matchboard?: mb.MatchboardExporter }

const str = (max = 500) => z.string().max(max);
const id = z.string().min(1).max(64);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { db, sync } = deps;
  const ctx: AssetCtx = { db, assetsDir: deps.assetsDir };
  fs.mkdirSync(deps.assetsDir, { recursive: true });
  const generator = deps.generator ?? new pngGen.GeneratorExporter({ db, assetsDir: deps.assetsDir });
  const matchboard = deps.matchboard ?? new mb.MatchboardExporter({ db, assetsDir: deps.assetsDir });

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

  // Online hosting: one shared password. Browsers log in with a form (cookie); the vMix sync sends HTTP Basic auth.
  // Unauthenticated requests never get a WWW-Authenticate challenge, so no browser popup and no 401 bursts.
  if (deps.password) {
    const password = deps.password;
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));
    app.addHook('onRequest', async (req, reply) => {
      const url = req.url.split('?')[0];
      if (url === '/api/health' || url === '/login') return;
      if (cookieOk(req.headers.cookie, password) || passwordOk(req.headers.authorization, password)) return;
      if (req.method === 'GET' && !url.startsWith('/api/') && !url.startsWith('/json/') && !url.startsWith('/xml/')) return reply.redirect('/login');
      return reply.status(401).send({ error: 'Log in first.' });
    });
    app.get('/login', async (_req, reply) => reply.type('text/html').send(loginPage(false)));
    app.post('/login', async (req, reply) => {
      const given = String((req.body as Record<string, unknown> | null)?.password ?? '');
      if (given !== password) return reply.status(200).type('text/html').send(loginPage(true));
      const secure = req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https' ? '; Secure' : '';
      reply.header('Set-Cookie', `ssl_auth=${authToken(password)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}${secure}`);
      return reply.redirect('/');
    });
  }

  const ev = () => activeEvent(db);

  // ---------- meta ----------
  app.get('/api/health', async () => ({ ok: true, time: nowIso(), version: versionInfo().version }));
  app.get('/api/version', async () => versionInfo());
  app.get('/api/meta', async () => ({
    event: ev(),
    teamSlots: TEAM_SLOTS,
    sailorSlots: SAILOR_SLOTS,
    hasDemo: hasDemo(ctx),
  }));

  // ---------- teams ----------
  const teamBody = z.object({ name: str(120).min(1, 'Name is required'), code: str(20).min(1, 'Code is required'), nickname: str(120).optional(), aliases: z.array(str(120)).max(50).optional(), notes: str(2000).optional(), ranking: str(40).optional() });
  app.get('/api/teams', async () => listTeams(ctx));
  app.post('/api/teams', async (req) => getTeam(ctx, createTeam(db, teamBody.parse(req.body))));
  app.get<{ Params: { id: string } }>('/api/teams/:id', async (req) => getTeam(ctx, req.params.id));
  app.patch<{ Params: { id: string } }>('/api/teams/:id', async (req) => {
    updateTeam(db, req.params.id, teamBody.partial().parse(req.body));
    return getTeam(ctx, req.params.id);
  });
  app.delete<{ Params: { id: string } }>('/api/teams/:id', async (req) => { deleteTeam(ctx, req.params.id); return { ok: true }; });
  app.get('/api/ranking', async () => ({ url: ranking.RANKING_URL, last: ranking.lastRankingResult(db) }));
  app.post('/api/ranking/refresh', async () => ranking.refreshRanking(db));
  app.get<{ Params: { id: string } }>('/api/teams/:id/sailors', async (req) => { getTeam(ctx, req.params.id); return listSailors(ctx, req.params.id); });

  // ---------- assets (team slots and sailor photo share one API) ----------
  const ownerOf = (kind: string): OwnerType => {
    if (kind === 'teams') return 'team';
    if (kind === 'sailors') return 'sailor';
    if (kind === 'people') return 'person';
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
    bestResult1: str(500), bestResult2: str(500), bestResult3: str(500), sourceRef: str(200).nullable(),
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
  app.post<{ Params: { id: string } }>('/api/sailors/:id/captain', async (req) => {
    setCaptain(db, req.params.id, z.object({ value: z.boolean() }).parse(req.body).value);
    return getSailor(ctx, req.params.id);
  });
  app.delete<{ Params: { id: string } }>('/api/sailors/:id', async (req) => { deleteSailor(ctx, req.params.id); return { ok: true }; });

  // ---------- fleets ----------
  const fleetSize = z.number().int().min(fleets.MIN_FLEET_SIZE).max(fleets.MAX_FLEET_SIZE);
  app.get('/api/fleet-sets', async () => fleets.listSets(db, ev().id));
  app.post('/api/fleet-sets', async (req) => {
    const b = z.object({ name: str(120).min(1, 'Name is required'), fleetCount: z.number().int().min(0).max(30).optional(), fleetSize: fleetSize.optional() }).parse(req.body);
    return fleets.getSetDetail(db, fleets.createSet(db, ev().id, b.name.trim(), b.fleetCount ?? 0, b.fleetSize));
  });
  app.get<{ Params: { id: string } }>('/api/fleet-sets/:id', async (req) => fleets.getSetDetail(db, req.params.id));
  app.patch<{ Params: { id: string } }>('/api/fleet-sets/:id', async (req) => {
    const b = z.object({ name: str(120).min(1).optional(), fleetSize: fleetSize.optional() }).parse(req.body);
    if (b.name !== undefined) fleets.renameSet(db, req.params.id, b.name.trim());
    if (b.fleetSize !== undefined) fleets.setSetFleetSize(db, req.params.id, b.fleetSize);
    return fleets.getSetDetail(db, req.params.id);
  });
  app.delete<{ Params: { id: string } }>('/api/fleet-sets/:id', async (req) => { fleets.deleteSet(db, req.params.id); return { ok: true }; });
  app.post<{ Params: { id: string } }>('/api/fleet-sets/:id/fleets', async (req) => {
    const { name, size } = z.object({ name: str(120).min(1, 'Name is required'), size: fleetSize.optional() }).parse(req.body);
    fleets.createFleet(db, req.params.id, name.trim(), size);
    return fleets.getSetDetail(db, req.params.id);
  });
  app.patch<{ Params: { id: string } }>('/api/fleets/:id', async (req) => {
    const { name, size } = z.object({ name: str(120).min(1).optional(), size: fleetSize.optional() }).parse(req.body);
    if (name !== undefined) fleets.renameFleet(db, req.params.id, name.trim());
    if (size !== undefined) fleets.setFleetSize(db, req.params.id, size);
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
      if (free === null) throw badRequest('This fleet is full. Choose a specific place to swap, or add places to the fleet.');
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
    decl.addMember(ctx, req.params.id, z.object({ sailorId: id, position: str(80).optional(), number: str(10).optional(), weight: str(20).optional() }).parse(req.body));
    return decl.getDeclarationById(ctx, req.params.id);
  });
  const memberDecl = (memberId: string) => {
    const r = db.prepare('SELECT declaration_id FROM declaration_members WHERE id = ?').get(memberId) as { declaration_id: string } | undefined;
    if (!r) throw notFound('Crew member');
    return r.declaration_id;
  };
  app.patch<{ Params: { id: string } }>('/api/declaration-members/:id', async (req) => {
    const d = memberDecl(req.params.id);
    decl.setOverride(db, req.params.id, z.object({ position: str(80).optional(), number: str(10).optional(), weight: str(20).optional() }).parse(req.body));
    return decl.getDeclarationById(ctx, d);
  });
  app.post<{ Params: { id: string } }>('/api/declaration-members/:id/reset', async (req) => {
    const d = memberDecl(req.params.id);
    decl.clearOverride(db, req.params.id, z.object({ field: z.enum(['position', 'number', 'weight', 'all']) }).parse(req.body).field);
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
  // ---------- general graphics ----------
  const text = z.string().max(500);
  app.get('/api/weather', async () => gen.getWeather(db));
  app.put('/api/weather', async (req) => gen.setWeather(db, z.record(z.string(), text).parse(req.body)));
  const scheduleBody = z.object({ date: str(10), time: str(20), race: str(200), fleet: str(200), status: str(60), note: str(500) }).partial();
  app.get<{ Querystring: { date?: string } }>('/api/schedule', async (req) => gen.listSchedule(db, ev().id, req.query.date ? String(req.query.date) : undefined));
  app.get('/api/schedule/dates', async () => gen.listScheduleDates(db, ev().id));
  app.post('/api/schedule', async (req) => ({ id: gen.createScheduleItem(db, ev().id, scheduleBody.parse(req.body)) }));
  app.patch<{ Params: { id: string } }>('/api/schedule/:id', async (req) => { gen.updateScheduleItem(db, req.params.id, scheduleBody.parse(req.body)); return { ok: true }; });
  app.delete<{ Params: { id: string } }>('/api/schedule/:id', async (req) => { gen.deleteScheduleItem(db, req.params.id); return { ok: true }; });
  const personBody = z.object({ name: str(120), role: str(80), language: str(40), title: str(200) }).partial();
  app.get('/api/people', async () => ({ people: gen.listPeople(ctx, ev().id), roles: gen.PERSON_ROLES }));
  app.post('/api/people', async (req) => ({ id: gen.createPerson(db, ev().id, personBody.parse(req.body)) }));
  app.post('/api/people/commentator-set', async (req) => gen.addCommentatorSet(db, ev().id, z.object({ language: str(40).min(1) }).parse(req.body).language));
  app.patch<{ Params: { id: string } }>('/api/people/:id', async (req) => { gen.updatePerson(db, req.params.id, personBody.parse(req.body)); return { ok: true }; });
  app.delete<{ Params: { id: string } }>('/api/people/:id', async (req) => { gen.deletePerson(ctx, req.params.id); return { ok: true }; });

  // ---------- JSON for vMix data sources ----------
  app.get('/api/json-index', async () => jsonIndex(db, ev().id));
  app.get('/api/workbook', async () => {
    const root = getSetting(db, 'paths.vmixAssetsRoot');
    const wb = deps.workbook;
    const rel = wb && wb.file.startsWith(deps.assetsDir) ? wb.file.slice(deps.assetsDir.length).replace(/^[\\/]+/, '') : null;
    return {
      file: wb?.file ?? null, vmixPath: root && rel ? joinVmixPath(root, rel) : null, updatedAt: wb?.updatedAt ?? null, error: wb?.lastError ?? null,
      sheets: allSheets(ctx).map((s) => ({ name: s.name, path: s.path, rows: s.rows.length })),
    };
  });
  // XML with every sheet under one address; vMix picks a sheet with XPath, e.g. //sheet[@name='Teams']/row
  app.get('/xml/all', async (_req, reply) => {
    const x = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    const tag = (k: string) => (/^[A-Za-z_][\w.-]*$/.test(k) ? k : `f_${k.replace(/[^\w.-]/g, '_')}`);
    const body = allSheets(ctx).map((s) => `<sheet name="${x(s.name)}">${s.rows.map((r) => `<row>${Object.entries(r).map(([k, v]) => `<${tag(k)}>${x(String(v))}</${tag(k)}>`).join('')}</row>`).join('')}</sheet>`).join('');
    return reply.type('application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="UTF-8"?><data>${body}</data>`);
  });
  app.get('/json/all', async () => Object.fromEntries(allSheets(ctx).map((s) => [s.name, s.rows])));
  app.get('/workbook.xlsx', async (_req, reply) => {
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', 'attachment; filename="ssl-vmix.xlsx"');
    return reply.send(buildXlsx(allSheets(ctx)));
  });
  // the older per-topic JSON follows the current stage like the workbook: only its teams are listed
  const inStage = <T,>(rows: T[], code: (r: T) => string) => {
    const ids = stageTeamIds(db, ev().id);
    if (!ids) return rows;
    const codes = new Set(listTeams(ctx).filter((t) => ids.includes(t.id)).map((t) => t.code.toLowerCase()));
    return rows.filter((r) => codes.has(code(r).toLowerCase()));
  };
  app.get('/json/teams', async () => inStage(jsonTeams(ctx), (r) => String((r as { code?: string }).code ?? '')));
  app.get<{ Querystring: { date?: string; team?: string } }>('/json/sailors', async (req) =>
    inStage(jsonSailors(ctx, ev().id, req.query.date ? String(req.query.date) : todayIn(ev().timezone), req.query.team ? String(req.query.team) : undefined), (r) => r.team_code));
  app.get<{ Params: { id: string } }>('/json/fleets/:id', async (req) => jsonFleetSet(ctx, req.params.id));
  app.get('/json/weather', async () => jsonWeather(db));
  app.get<{ Querystring: { date?: string } }>('/json/schedule', async (req) => jsonSchedule(db, ev().id, req.query.date ? String(req.query.date) : todayIn(ev().timezone)));
  app.get<{ Querystring: { role?: string; language?: string } }>('/json/people', async (req) => jsonPeople(ctx, ev().id, req.query.role, req.query.language));
  app.get('/json/captains', async () => inStage(jsonCaptains(ctx), (r) => r.code));

  // ---------- PNG generator ----------
  const genState = () => ({
    templates: pngGen.listTemplates(db),
    teams: pngGen.listGradients(db),
    status: generator.status(),
    outputs: pngGen.listOutputs(db),
    vmixAssetsRoot: getSetting(db, 'paths.vmixAssetsRoot'),
    strokeGradient: pngGen.getStrokeGradient(db),
    neutral: pngGen.getNeutral(db),
  });
  app.get('/api/generator', async () => genState());
  app.get('/api/generator/status', async () => ({ status: generator.status(), outputs: pngGen.listOutputs(db) }));
  app.post('/api/generator/templates', async (req) => pngGen.createTemplate(db, pngGen.templateSchema.parse(req.body)));
  app.patch<{ Params: { id: string } }>('/api/generator/templates/:id', async (req) => {
    const t = pngGen.updateTemplate(db, req.params.id, pngGen.templatePatchSchema.parse(req.body));
    matchboard.schedule(1500);
    return t;
  });
  app.post<{ Params: { id: string } }>('/api/generator/templates/:id/duplicate', async (req) => pngGen.duplicateTemplate(db, req.params.id));
  app.post<{ Params: { id: string } }>('/api/generator/templates/:id/move', async (req) => {
    pngGen.moveTemplate(db, req.params.id, z.object({ direction: z.union([z.literal(-1), z.literal(1)]) }).parse(req.body).direction);
    return pngGen.listTemplates(db);
  });
  app.delete<{ Params: { id: string } }>('/api/generator/templates/:id', async (req) => { pngGen.deleteTemplate(db, req.params.id); return { ok: true }; });
  app.put<{ Params: { teamId: string; variant: string } }>('/api/generator/gradients/:teamId/:variant', async (req) => {
    const g = z.object({ gradient: pngGen.gradientSchema.nullable() }).parse(req.body).gradient;
    pngGen.setGradient(db, req.params.teamId, Number(req.params.variant), g);
    matchboard.schedule(1500);
    return pngGen.listGradients(db).find((t) => t.teamId === req.params.teamId);
  });
  app.post<{ Params: { teamId: string } }>('/api/generator/gradients/:teamId/from-colors', async (req) => {
    const b = z.object({ colors: z.array(z.string()).min(1).max(5), angle: z.number().min(-360).max(360).default(0) }).parse(req.body);
    pngGen.setGradientsFromColors(db, req.params.teamId, b.colors, b.angle);
    matchboard.schedule(1500);
    return pngGen.listGradients(db).find((t) => t.teamId === req.params.teamId);
  });
  app.put('/api/generator/stroke-gradient', async (req) => ({
    strokeGradient: pngGen.setStrokeGradient(db, z.object({ gradient: pngGen.gradientSchema.nullable() }).parse(req.body).gradient),
  }));
  app.put('/api/generator/neutral', async (req) => ({ neutral: pngGen.setNeutral(db, pngGen.neutralSchema.partial().parse(req.body)) }));
  app.put('/api/generator/settings', async (req) => {
    setSetting(db, 'generator.autoExport', String(z.object({ autoExport: z.boolean() }).parse(req.body).autoExport));
    return generator.status();
  });
  app.post('/api/generator/export', async (req) => {
    if (z.object({ all: z.boolean().default(false) }).parse(req.body ?? {}).all) generator.rerenderAll();
    return generator.flush();
  });
  app.get<{ Querystring: { team?: string; template?: string } }>('/api/generator/png', async (req, reply) => {
    const { buf, fileName } = pngGen.renderOne(generator.ctx, String(req.query.team ?? ''), String(req.query.template ?? ''));
    return reply.type('image/png').header('Content-Disposition', `attachment; filename="${fileName}"`).send(buf);
  });
  app.get('/api/generator/zip', async (_req, reply) => {
    generator.flush();
    const entries = pngGen.listOutputs(db).map((o) => [o.rel.slice(pngGen.GENERATED_DIR.length + 1), fs.readFileSync(path.join(deps.assetsDir, ...o.rel.split('/')))] as [string, Buffer]);
    return reply.type('application/zip').header('Content-Disposition', 'attachment; filename="ssl-generated-png.zip"').send(zipStore(entries));
  });
  app.get('/json/graphics', async () => {
    const rows = pngGen.jsonGraphics(db, deps.assetsDir);
    return [...inStage(rows.filter((r) => r.code !== pngGen.NEUTRAL_CODE), (r) => r.code), ...rows.filter((r) => r.code === pngGen.NEUTRAL_CODE)];
  });

  // ---------- matchboard ----------
  const mbState = async () => ({ layout: mb.loadLayout(), state: mb.getState(db), status: matchboard.status(), fonts: await matchboard.fonts() });
  app.get('/api/matchboard', mbState);
  app.put('/api/matchboard', async (req) => {
    const state = mb.saveState(db, mb.statePatchSchema.parse(req.body));
    matchboard.schedule();
    return { state, status: matchboard.status() };
  });
  app.post('/api/matchboard/reset', async () => { mb.resetState(db); matchboard.schedule(0); return mbState(); });
  app.post('/api/matchboard/export', async () => matchboard.render());
  app.get('/api/matchboard/png', async (_req, reply) =>
    reply.type('image/png').header('Content-Disposition', 'attachment; filename="matchboard.png"').send(await matchboard.renderBuffer()));
  app.get('/api/matchboard/background.png', async (_req, reply) => reply.type('image/png').header('Cache-Control', 'max-age=3600').send(fs.createReadStream(mb.backgroundPath())));
  app.get<{ Params: { name: string } }>('/api/matchboard/fonts/:name', async (req, reply) => {
    const w = /^general-sans-(\d{3})$/.exec(req.params.name);
    const f = req.params.name === 'space-grotesk' ? mb.groteskPath() : w ? mb.uploadedSansFiles(deps.assetsDir).find((x) => x.weight === Number(w[1]))?.file : null;
    if (!f) throw notFound('Font');
    const ext = path.extname(f).slice(1);
    return reply.type(ext === 'otf' ? 'font/otf' : ext === 'ttf' ? 'font/ttf' : `font/${ext}`).header('Cache-Control', 'no-cache').send(fs.createReadStream(f));
  });
  app.post('/api/matchboard/font', async (req) => {
    const file = await req.file();
    if (!file) throw badRequest('No file was uploaded.');
    return matchboard.saveFonts(await file.toBuffer(), file.filename);
  });
  // ---------- GTZIP generator ----------
  registerBroadcastRoutes(app, ctx);
  registerGtzipRoutes(app, new GtzipService(ctx, () => getSetting(db, 'paths.vmixAssetsRoot') || null, () => matchboard.fonts()));

  // ---------- mirror of the assets folder for the vMix machine (vmix-sync) ----------
  // The sync program polls the manifest every few seconds; its last visit is the vMix machine's heartbeat.
  let mirrorSeen: { at: string; host: string; folder: string; error: string } | null = null;
  app.get<{ Querystring: { host?: string; folder?: string; error?: string } }>('/api/mirror/manifest', async (req) => {
    const q = req.query;
    if (q.host || q.folder) mirrorSeen = { at: nowIso(), host: String(q.host ?? '').slice(0, 100), folder: String(q.folder ?? '').slice(0, 500), error: String(q.error ?? '').slice(0, 300) };
    return { vmixAssetsRoot: getSetting(db, 'paths.vmixAssetsRoot'), files: listMirrorFiles(deps.assetsDir) };
  });
  app.get('/api/mirror/status', async () => ({ seen: mirrorSeen, now: nowIso() }));
  app.get<{ Querystring: { path?: string } }>('/api/mirror/file', async (req, reply) => {
    const full = mirrorFilePath(deps.assetsDir, String(req.query.path ?? ''));
    if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) throw notFound('File');
    return reply.type('application/octet-stream').send(fs.createReadStream(full));
  });
  app.get('/api/presets', async () => PRESETS);
  app.post('/api/presets/ssl-gold-cup-2026', async () => applyGoldCupAll(ctx));

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
