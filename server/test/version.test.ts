import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setup } from './helpers.js';

describe('app version', () => {
  it('reports a numbered version and the list of changes', async () => {
    const s = setup();
    const a = await buildApp({ db: s.db, assetsDir: s.ctx.assetsDir, sync: s.sync });
    const health = (await a.inject({ url: '/api/health' })).json();
    expect(health.version).toMatch(/^\d+\.\d+\.\d+/);
    const v = (await a.inject({ url: '/api/version' })).json();
    expect(v.version).toBe(health.version);
    expect(Array.isArray(v.changes)).toBe(true);
    await a.close();
  });
});
