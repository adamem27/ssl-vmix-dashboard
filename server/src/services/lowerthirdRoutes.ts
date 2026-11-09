import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AssetCtx } from './assets.js';
import { badRequest } from './errors.js';
import { companionPageExport, crewOf, getLtConfig, getLtState, ltConfigSchema, ltTeams, LowerThirds, setLtConfig } from './lowerthirds.js';
import { TEAM_SLOTS } from './slots.js';

/**
 * Lower thirds for Companion / Stream Deck. Every action answers GET and POST, so a Companion
 * "Generic HTTP" GET works: one key with …/api/lt/key/$(this:page)/$(this:row)/$(this:column) copied to every key.
 */
export function registerLowerThirdRoutes(app: FastifyInstance, ctx: AssetCtx, lt: LowerThirds) {
  const { db } = ctx;
  // the last key press and what came of it, so the dashboard can show why a Stream Deck key did nothing
  let last: { at: string; what: string; error: string | null } | null = null;
  const both = (url: string, handler: (req: any) => Promise<unknown>) => {
    const h = async (req: any) => {
      const what = String(req.url ?? url).replace(/^\/api\/lt\//, '');
      try { const r = await handler(req); last = { at: new Date().toISOString(), what, error: null }; return r; }
      catch (e: any) { last = { at: new Date().toISOString(), what, error: String(e?.message ?? e) }; throw e; }
    };
    app.get(url, h); app.post(url, h);
  };
  const q = (req: any, k: string) => String(req.query?.[k] ?? (req.body as Record<string, unknown> | null)?.[k] ?? '').trim();

  app.get('/api/lt', async () => {
    const state = getLtState(db);
    return {
      config: getLtConfig(db), state, teams: ltTeams(ctx), keys: lt.layout(),
      crew: state.teamId ? crewOf(ctx, state.teamId) : [],
      teamSlots: TEAM_SLOTS, last,
    };
  });
  app.put('/api/lt/config', async (req) => {
    const c = setLtConfig(db, ltConfigSchema.partial().parse(req.body));
    void lt.pushLabels(true);
    return c;
  });
  both('/api/lt/key/:page/:row/:col', async (req) => lt.press(Number(req.params.page), Number(req.params.row), Number(req.params.col)));
  both('/api/lt/pick', async (req) => { const t = q(req, 'team'); if (!t) throw badRequest('Add ?team=CODE'); return lt.pickTeam(t); });
  both('/api/lt/team', async (req) => { const t = q(req, 'team'); if (!t) throw badRequest('Add ?team=CODE'); return lt.showTeam(t); });
  both('/api/lt/sailor', async (req) => { const p = q(req, 'place'); if (!p) throw badRequest('Add ?place=Pit (and &team=CODE)'); return lt.showSailor(q(req, 'team') || null, p); });
  both('/api/lt/showteam', async () => lt.run('showteam'));
  // ?base= is the dashboard address Companion should call (default: the address this request came to)
  app.get('/api/lt/companion/:n', async (req: any, reply) => {
    const pages = lt.layout();
    const n = Number(String(req.params.n).replace(/\D+/g, '')) || 1;
    if (n < 1 || n > pages.length) throw badRequest(`There are ${pages.length} Companion pages.`);
    const base = q(req, 'base') || `${req.protocol}://${req.headers.host}`;
    const cfg = getLtConfig(db);
    reply.header('Content-Disposition', `attachment; filename="lowerthirds-page${cfg.companionPage + n - 1}.companionconfig"`);
    reply.type('application/json');
    return JSON.stringify(companionPageExport(pages[n - 1], base, cfg, n - 1), null, 2);
  });
  both('/api/lt/next', async () => lt.nextLine());
  both('/api/lt/out', async () => lt.out());
  app.post('/api/lt/labels', async () => lt.pushLabels(true));
}
