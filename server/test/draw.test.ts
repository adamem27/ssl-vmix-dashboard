import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { createTeam } from '../src/services/teams.js';
import { Draw } from '../src/services/draw.js';
import { buildApp } from '../src/app.js';

function withPool(n = 16) {
  const s = setup();
  const codes = Array.from({ length: n }, (_, i) => `T${String(i + 1).padStart(2, '0')}`);
  const ids = codes.map((c) => createTeam(s.db, { name: `Team ${c}`, code: c }));
  const draw = new Draw(s.ctx);
  draw.setConfig({ pool: ids });
  return { ...s, ids, codes, draw };
}

describe('DRAW', () => {
  it('draws a team, then its group, and places teams in order', () => {
    const { draw, ids } = withPool();
    expect(() => draw.run('group:A')).toThrow(/Draw a team first/);
    draw.run('team:3');
    expect(draw.state.current).toEqual({ teamId: ids[2], group: null });
    draw.run('group:b');
    expect(draw.state.picks).toEqual([{ teamId: ids[2], group: 'B', place: 1 }]);
    expect(draw.state.current).toEqual({ teamId: ids[2], group: 'B' });
    expect(() => draw.run('team:3')).toThrow(/already has its group/);
    draw.run('team:T05');
    draw.run('group:B');
    expect(draw.state.picks[1]).toEqual({ teamId: ids[4], group: 'B', place: 2 });
  });

  it('refuses a full group and undoes step by step', () => {
    const { draw } = withPool();
    for (let i = 1; i <= 4; i++) { draw.run(`team:${i}`); draw.run('group:A'); }
    draw.run('team:5');
    expect(() => draw.run('group:A')).toThrow(/full/);
    draw.run('undo'); // the drawn team goes back
    expect(draw.state.current).toBeNull();
    draw.run('undo'); // the last pick: its team is drawn again, without a group
    expect(draw.state.picks).toHaveLength(3);
    expect(draw.state.current?.group).toBeNull();
    const seq = draw.state.seq;
    draw.run('overview');
    expect(draw.state.overview).toBe(true);
    expect(draw.state.seq).toBe(seq + 1);
    draw.run('reset');
    expect(draw.state.picks).toEqual([]);
  });

  it('takes a team out of the groups when it leaves the pool', () => {
    const { draw, ids } = withPool(6);
    draw.run('team:1'); draw.run('group:C');
    draw.run('team:2'); draw.run('group:C');
    draw.setConfig({ pool: ids.slice(1) });
    expect(draw.state.picks).toEqual([{ teamId: ids[1], group: 'C', place: 1 }]);
  });

  it('builds a Companion page with 16 team keys, groups and undo', () => {
    const { draw } = withPool(10);
    draw.run('team:2'); draw.run('group:D');
    const f = draw.companionPage('http://10.0.0.5:4310/');
    expect(f.type).toBe('page');
    expect(f.oldPageNumber).toBe(30);
    const url = (r: number, c: number) => (f.page.controls as any)[r][c].steps[0].action_sets.down[0].options.url.value;
    expect(url(0, 0)).toBe('http://10.0.0.5:4310/api/draw/do?a=team%3A1');
    expect(url(1, 7)).toBe('http://10.0.0.5:4310/api/draw/do?a=team%3A16');
    expect(url(2, 3)).toBe('http://10.0.0.5:4310/api/draw/do?a=group%3AD');
    expect(url(2, 7)).toBe('http://10.0.0.5:4310/api/draw/do?a=undo');
    const keys = draw.keys();
    expect(keys[0][1]!.text).toBe('T02\\n→ D');
    expect(keys[2][3]!.text).toBe('GROUP D\\n1/4');
  });

  it('takes the groups from the matchboard: fixed teams stay, the drawn ones fill DRAW 1–11 in order', () => {
    const s = setup();
    const fixed = Object.fromEntries(['COL', 'KOR', 'GRE', 'MAS', 'SGP'].map((c) => [c, createTeam(s.db, { name: `Team ${c}`, code: c })]));
    const drawn = ['MYA', 'OMA', 'TAH', 'SEY', 'EST', 'LTU', 'UKR', 'POR', 'URU', 'ANT', 'CUB'].map((c) => createTeam(s.db, { name: `Team ${c}`, code: c }));
    const draw = new Draw(s.ctx);
    draw.setConfig({ pool: drawn });
    const board = draw.board();
    expect(board.map((g) => g.slots.filter((x) => x.draw).length)).toEqual([3, 2, 3, 3]);
    expect(board[0].slots[0]).toEqual({ teamId: fixed.COL, text: '', draw: false });
    expect(board[2].slots.map((x) => x.text)).toEqual(['DRAW', 'DRAW', 'DRAW', '']);
    draw.run('team:1'); draw.run('group:B');
    draw.run('team:2'); draw.run('group:B');
    expect(draw.state.picks.map((p) => p.place)).toEqual([3, 4]);
    draw.run('team:3');
    expect(() => draw.run('group:B')).toThrow(/full/);
    draw.run('group:C');
    expect(draw.state.picks[2].place).toBe(1);
    expect(draw.output().teams.map((t) => t.code)).toContain('MAS');
  });

  it('serves the output page and its data without a login, the rest still needs one', async () => {
    const { db, ctx, sync, draw } = withPool(4);
    draw.run('team:1');
    const app = await buildApp({ db, assetsDir: ctx.assetsDir, sync, password: 'regatta' });
    const out = await app.inject({ method: 'GET', url: '/api/draw/output' });
    expect(out.statusCode).toBe(200);
    expect(out.json().teams).toHaveLength(4);
    expect(out.json().current.group).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/draw/output/header.png' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/draw' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/draw/do?a=group:A' })).statusCode).toBe(401);
  });
});
