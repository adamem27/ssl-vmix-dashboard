import fs from 'node:fs';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { COMPARE_DIR } from './compareImages.js';
import { AssetCtx } from './assets.js';
import { badRequest } from './errors.js';
import { companionFiles, setShowConfig, Show, showConfigSchema } from './show.js';
import { vmixUrl } from './vmixResults.js';
import { getSetting } from '../db/db.js';
import { listSets, getSetDetail } from './fleets.js';
import { activeEvent } from '../db/db.js';
import { listGraphicSets } from './graphicSets.js';
import { compareTab, setCompareOverride } from './showData.js';
import { getLtConfig } from './lowerthirds.js';
import { todayIn } from './dates.js';

/** Show control: one GET per Stream Deck key (/api/show/do?a=…), the tab's view and the Companion page files. */
export function registerShowRoutes(app: FastifyInstance, ctx: AssetCtx, show: Show) {
  const { db } = ctx;
  // a change anywhere in the dashboard (teams, groups, line-ups, General graphics…) shows on the keys at once
  app.addHook('onResponse', async (req) => { if (req.method !== 'GET') show.invalidate(); });
  app.get('/api/show', async () => {
    const ev = activeEvent(db).id;
    const fleets = (listSets(db, ev) as { id: string; name: string }[]).flatMap((s) => getSetDetail(db, s.id).fleets.map((f) => ({ id: f.id, name: `${s.name} · ${f.name}`, size: f.filled })));
    return { ...(await show.view()), fleets, tickers: listGraphicSets(db, ev, 'ticker').map((t) => ({ id: t.id, name: t.name })), breakGroups: show.breakStageFleets(), breakShown: show.breakFleets(), companionUrl: JSON.parse(getSetting(db, 'lt.config') || '{}').companionUrl ?? '' };
  });
  app.put('/api/show/config', async (req) => {
    const c = setShowConfig(db, showConfigSchema.partial().parse(req.body));
    void show.pushLabels(true);
    return c;
  });
  const act = async (req: any) => {
    const a = String(req.query?.a ?? (req.body as Record<string, unknown> | null)?.a ?? '').trim();
    if (!a) throw badRequest('Add ?a=<action>, e.g. ?a=show:welcome');
    return show.run(a);
  };
  // General graphics → Team comparison: the current stage's groups, what each shows by itself and what is typed over it
  app.get('/api/compare', async () => {
    const ev = activeEvent(db);
    return compareTab(ctx, ev.id, todayIn(ev.timezone), { emblemSlot: getLtConfig(db).emblemSlot });
  });
  app.put('/api/compare/:fleetId', async (req: any) => {
    const b = (req.body ?? {}) as { n?: number; field?: string; value?: string };
    const n = Number(b.n ?? 0);
    if (!Number.isInteger(n) || n < 0 || n > 4 || !b.field) throw badRequest('Send { n: 0–4, field, value }.');
    try { setCompareOverride(db, String(req.params.fleetId), n, b.field, String(b.value ?? '')); } catch (e) { throw badRequest((e as Error).message); }
    void show.syncData().catch(() => undefined);
    return { ok: true };
  });
  // a picture typed over a team's comparison value (captain photo, flag, emblem, panel): PNG or JPG, kept in the assets folder
  app.post('/api/compare/upload', async (req: any) => {
    const file = await req.file();
    if (!file) throw badRequest('No file was uploaded.');
    const buf: Buffer = await file.toBuffer();
    const ext = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47 ? 'png' : buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : '';
    if (!ext) throw badRequest('The picture must be a PNG or JPG.');
    const base = path.basename(String(file.filename || 'picture')).replace(/\.[^.]+$/, '').replace(/[^\w() -]+/g, '_').slice(0, 80) || 'picture';
    const rel = `${COMPARE_DIR}/uploads/${base}.${ext}`;
    fs.mkdirSync(path.join(ctx.assetsDir, COMPARE_DIR, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(ctx.assetsDir, ...rel.split('/')), buf);
    return { path: rel };
  });
  app.get('/api/show/do', act);
  app.post('/api/show/do', act);
  app.post('/api/show/labels', async () => show.pushLabels(true));
  app.post('/api/show/placeholders', async () => show.addPlaceholders());
  // ?base= is the dashboard address Companion should call, ?vmix= the vMix address for the fallback page
  // the whole preset: every page of both decks, a page per team, the fallback page (Companion: Import → full config)
  app.get('/api/show/preset.companionconfig', async (req: any, reply) => {
    const cfg = show.config;
    const base = String(req.query?.base ?? '') || `${req.protocol}://${req.headers.host}`;
    const vmix = String(req.query?.vmix ?? '') || cfg.vmixForCompanion || vmixUrl(db);
    const file = await show.companionPreset(base, vmix);
    reply.header('Content-Disposition', 'attachment; filename="ssl-show-preset.companionconfig"');
    reply.type('application/json');
    return JSON.stringify(file, null, 2);
  });
  app.get('/api/show/companion/:name', async (req: any, reply) => {
    const cfg = show.config;
    const base = String(req.query?.base ?? '') || `${req.protocol}://${req.headers.host}`;
    const vmix = String(req.query?.vmix ?? '') || cfg.vmixForCompanion || vmixUrl(db);
    const files = companionFiles(cfg, base, vmix, show.graphics());
    const f = files.find((x) => x.name === String(req.params.name).replace(/\.companionconfig$/, ''));
    if (!f) throw badRequest(`Files: ${files.map((x) => x.name).join(', ')}`);
    reply.header('Content-Disposition', `attachment; filename="ssl-page${f.page}-${f.name}.companionconfig"`);
    reply.type('application/json');
    return JSON.stringify(f.file, null, 2);
  });
  app.get('/api/show/companion', async () => companionFiles(show.config, '', '', show.graphics()).map((f) => ({ name: f.name, page: f.page })));
}
