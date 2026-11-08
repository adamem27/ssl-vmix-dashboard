import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { createTeam } from '../src/services/teams.js';
import { listAssets } from '../src/services/assets.js';
import { applyTeamGraphicsOnStart } from '../src/services/teamGraphics.js';

describe('bundled team graphics', () => {
  it('uploads flags and emblems once, reporting teams without files', () => {
    const { db, ctx } = setup();
    const pol = createTeam(db, { name: 'Poland', code: 'POL' });
    createTeam(db, { name: 'Nowhere', code: 'XYZ' });
    const r = applyTeamGraphicsOnStart(ctx)!;
    expect(r.teams).toBe(1);
    expect(r.withoutFlag).toEqual(['XYZ']);
    const a = listAssets(ctx, 'team', pol);
    expect(a.flag_big.width).toBe(900);
    expect(a.flag_small.width).toBe(300);
    expect([a.emblem_dark.width, a.emblem_dark.height]).toEqual([512, 512]);
    expect(a.emblem_light).toBeTruthy();
    expect(applyTeamGraphicsOnStart(ctx)).toBeNull();
  });
});
