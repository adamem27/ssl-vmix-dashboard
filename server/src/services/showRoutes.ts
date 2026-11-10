import { FastifyInstance } from 'fastify';
import { AssetCtx } from './assets.js';
import { badRequest } from './errors.js';
import { companionFiles, setShowConfig, Show, showConfigSchema } from './show.js';
import { vmixUrl } from './vmixResults.js';
import { getSetting } from '../db/db.js';
import { listSets, getSetDetail } from './fleets.js';
import { activeEvent } from '../db/db.js';
import { listGraphicSets } from './graphicSets.js';

/** Show control: one GET per Stream Deck key (/api/show/do?a=…), the tab's view and the Companion page files. */
export function registerShowRoutes(app: FastifyInstance, ctx: AssetCtx, show: Show) {
  const { db } = ctx;
  // a change anywhere in the dashboard (teams, groups, line-ups, General graphics…) shows on the keys at once
  app.addHook('onResponse', async (req) => { if (req.method !== 'GET') show.invalidate(); });
  app.get('/api/show', async () => {
    const ev = activeEvent(db).id;
    const fleets = (listSets(db, ev) as { id: string; name: string }[]).flatMap((s) => getSetDetail(db, s.id).fleets.map((f) => ({ id: f.id, name: `${s.name} · ${f.name}`, size: f.filled })));
    return { ...(await show.view()), fleets, tickers: listGraphicSets(db, ev, 'ticker').map((t) => ({ id: t.id, name: t.name })), companionUrl: JSON.parse(getSetting(db, 'lt.config') || '{}').companionUrl ?? '' };
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
