import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AssetCtx } from './assets.js';
import { badRequest } from './errors.js';
import { crewOf, getLtConfig, getLtState, ltConfigSchema, ltTeams, LowerThirds, setLtConfig } from './lowerthirds.js';
import { TEAM_SLOTS } from './slots.js';

/**
 * Lower thirds for Companion / Stream Deck. Every action answers GET and POST, so a Companion
 * "Generic HTTP" GET works: one key with …/api/lt/key/$(this:page)/$(this:row)/$(this:column) copied to every key.
 */
export function registerLowerThirdRoutes(app: FastifyInstance, ctx: AssetCtx, lt: LowerThirds) {
  const { db } = ctx;
  const both = (url: string, handler: (req: any) => Promise<unknown>) => { app.get(url, handler); app.post(url, handler); };
  const q = (req: any, k: string) => String(req.query?.[k] ?? (req.body as Record<string, unknown> | null)?.[k] ?? '').trim();

  app.get('/api/lt', async () => {
    const state = getLtState(db);
    return {
      config: getLtConfig(db), state, teams: ltTeams(ctx), keys: lt.layout(),
      crew: state.teamId ? crewOf(ctx, state.teamId) : [],
      teamSlots: TEAM_SLOTS,
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
  both('/api/lt/next', async () => lt.nextLine());
  both('/api/lt/out', async () => lt.out());
  app.post('/api/lt/labels', async () => lt.pushLabels(true));
}
