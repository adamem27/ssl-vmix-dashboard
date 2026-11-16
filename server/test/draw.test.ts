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
  draw.run('unlock'); // these tests press keys out of order; the lock has its own test
  return { ...s, ids, codes, draw };
}

describe('DRAW', () => {
  it('puts each team drawn into the next place of the group with the fewest teams', () => {
    const { draw, ids } = withPool();
    expect(() => draw.run('group:A')).toThrow(/Draw a team first/);
    draw.run('team:3');
    expect(draw.state.picks).toEqual([{ teamId: ids[2], group: 'A', place: 1 }]);
    expect(draw.state.current).toEqual({ teamId: ids[2], group: 'A' });
    expect(() => draw.run('team:3')).toThrow(/already has its group/);
    for (const n of [5, 6, 7, 8]) draw.run(`team:${n}`);
    expect(draw.state.picks.map((p) => `${p.group}${p.place}`)).toEqual(['A1', 'B1', 'C1', 'D1', 'A2']);
    expect(draw.nextGroup()).toBe('B');
    // a correction: the team just drawn moves to another group
    draw.run('group:C');
    expect(draw.state.picks[4]).toEqual({ teamId: ids[7], group: 'C', place: 2 });
    expect(draw.nextGroup()).toBe('A');
  });

  it('undoes the last team drawn and fills every group', () => {
    const { draw } = withPool();
    draw.run('team:1'); draw.run('team:2');
    draw.run('undo');
    expect(draw.state.picks).toHaveLength(1);
    expect(draw.state.current).toBeNull();
    for (let i = 2; i <= 16; i++) draw.run(`team:${i}`);
    expect(['A', 'B', 'C', 'D'].map((g) => draw.state.picks.filter((p) => p.group === g).length)).toEqual([4, 4, 4, 4]);
    expect(draw.nextGroup()).toBeNull();
    const seq = draw.state.seq;
    draw.run('overview');
    expect(draw.state.overview).toBe(true);
    expect(draw.state.seq).toBe(seq + 1);
    draw.run('reset');
    expect(draw.state.picks).toEqual([]);
  });

  it('brings the next group to the centre and back', () => {
    const { draw } = withPool();
    draw.run('focus');
    expect(draw.state.focus).toBe('A');
    draw.run('team:1'); // manual steps: the flag stays, the group stays in the centre
    expect(draw.state.focus).toBe('A');
    expect(draw.state.flag).toBe(true);
    draw.run('reveal');
    expect(draw.state.flag).toBe(false);
    expect(() => draw.run('reveal')).toThrow(/No flag/);
    draw.run('back');
    expect(draw.state.focus).toBeNull();
    expect(draw.keys()[3][1]!.action).toBe('reveal');
    expect(draw.keys()[3][2]!.action).toBe('back');
    // automatic steps: the output takes the flag off and sends the group back by itself
    draw.setConfig({ autoSteps: true });
    draw.run('focus'); draw.run('team:2');
    expect(draw.state.focus).toBeNull();
    expect(draw.state.flag).toBe(false);
    draw.run('focus:C');
    expect(draw.state.focus).toBe('C');
    draw.run('focus:off');
    expect(draw.state.focus).toBeNull();
    expect(() => draw.run('focus:X')).toThrow(/Use A–D/);
    expect(draw.keys()[2][4]!.action).toBe('focus');
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

  it('with manual steps lets only the next step through (1 focus, 2 team, 3 flag off, 4 back) until Unlock', () => {
    const { draw } = withPool(4);
    draw.run('lock');
    expect(draw.view().locked).toBe(true);
    expect(draw.view().step).toBe('focus');
    expect(() => draw.run('team:1')).toThrow(/Locked/);
    expect(() => draw.run('undo')).toThrow(/Locked/);
    expect(() => draw.run('overview')).toThrow(/Locked/);
    expect(() => draw.run('focus:C')).toThrow(/Locked/);
    expect(draw.keys()[0][0]!.bg).toBe('#18181b');
    draw.run('focus');
    expect(draw.view().step).toBe('team');
    expect(() => draw.run('back')).toThrow(/Locked/);
    draw.run('team:2');
    expect(draw.view().step).toBe('reveal');
    expect(() => draw.run('group:B')).toThrow(/Locked/);
    draw.run('reveal');
    expect(draw.view().step).toBe('back');
    expect(() => draw.run('focus')).toThrow(/Locked/);
    draw.run('back');
    expect(draw.view().step).toBe('focus');
    for (const n of [1, 3, 4]) { draw.run('focus'); draw.run(`team:${n}`); draw.run('reveal'); draw.run('back'); }
    expect(draw.view().step).toBeNull();
    draw.run('overview');
    expect(() => draw.run('reset')).toThrow(/Locked/);
    draw.run('unlock');
    draw.run('undo');
    expect(draw.state.picks).toHaveLength(3);
    draw.setConfig({ autoSteps: true });
    expect(draw.view().locked).toBe(false);
  });

  it('takes the groups from the matchboard: fixed teams stay, the drawn ones fill DRAW 1–11 in order', () => {
    const s = setup();
    const fixed = Object.fromEntries(['COL', 'KOR', 'GRE', 'MAS', 'SGP'].map((c) => [c, createTeam(s.db, { name: `Team ${c}`, code: c })]));
    const drawn = ['MYA', 'OMA', 'TAH', 'SEY', 'EST', 'LTU', 'UKR', 'POR', 'URU', 'ANT', 'CUB'].map((c) => createTeam(s.db, { name: `Team ${c}`, code: c }));
    const draw = new Draw(s.ctx);
    draw.setConfig({ pool: drawn });
    draw.run('unlock');
    const board = draw.board();
    expect(board.map((g) => g.slots.filter((x) => x.draw).length)).toEqual([3, 2, 3, 3]);
    expect(board[0].slots[0]).toEqual({ teamId: fixed.COL, text: '', draw: false });
    expect(board[2].slots.map((x) => x.text)).toEqual(['DRAW', 'DRAW', 'DRAW', '']);
    // fixed: A 1, B 2, C 1, D 1 → A, C, D, then A B C D, then A B (full), C, D
    for (let i = 1; i <= 11; i++) draw.run(`team:${i}`);
    expect(draw.state.picks.map((p) => `${p.group}${p.place}`)).toEqual(['A2', 'C1', 'D1', 'A3', 'B3', 'C2', 'D2', 'A4', 'B4', 'C3', 'D3']);
    expect(draw.nextGroup()).toBeNull();
    expect(draw.output().teams.map((t) => t.code)).toContain('MAS');
    // the matchboard after the draw: every team drawn in its DRAW row of R1 A–D
    const mb = draw.matchboardState();
    const rows = board.map((g) => g.slotIds!.map((id) => mb.slots[id].teamId));
    expect(rows[0]).toEqual([fixed.COL, drawn[0], drawn[3], drawn[7]]);
    expect(rows[1].slice(0, 2)).toEqual([fixed.KOR, fixed.GRE]);
  });

  it('serves the output page and its data without a login, the rest still needs one', async () => {
    const { db, ctx, sync, draw } = withPool(4);
    draw.run('team:1');
    const app = await buildApp({ db, assetsDir: ctx.assetsDir, sync, password: 'regatta' });
    const out = await app.inject({ method: 'GET', url: '/api/draw/output' });
    expect(out.statusCode).toBe(200);
    expect(out.json().teams).toHaveLength(4);
    expect(out.json().current.group).toBe('A');
    expect(out.json().next).toBe('B');
    expect((await app.inject({ method: 'GET', url: '/api/draw/output/header.png' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/draw' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/draw/output/video/${draw.config.pool[0]}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/draw/do?a=group:A' })).statusCode).toBe(401);
  });
});

describe('DRAW flag videos', () => {
  it('stores a video per team and streams it in byte ranges', async () => {
    const { db, ctx, sync, ids } = withPool(2);
    const app = await buildApp({ db, assetsDir: ctx.assetsDir, sync });
    const body = Buffer.concat([
      Buffer.from('--XX\r\nContent-Disposition: form-data; name="file"; filename="flag.webm"\r\nContent-Type: video/webm\r\n\r\n'),
      Buffer.alloc(5000, 7), Buffer.from('\r\n--XX--\r\n'),
    ]);
    const up = await app.inject({ method: 'POST', url: `/api/draw/video/${ids[0]}`, payload: body, headers: { 'content-type': 'multipart/form-data; boundary=XX' } });
    expect(up.statusCode).toBe(200);
    const out = (await app.inject({ method: 'GET', url: '/api/draw/output' })).json();
    expect(out.teams[0].video).toMatch(new RegExp(`^/api/draw/output/video/${ids[0]}\\?v=`));
    expect(out.teams[1].video).toBeNull();
    const part = await app.inject({ method: 'GET', url: `/api/draw/output/video/${ids[0]}`, headers: { range: 'bytes=100-199' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 100-199/5000');
    expect(part.rawPayload.length).toBe(100);
    expect((await app.inject({ method: 'DELETE', url: `/api/draw/video/${ids[0]}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/draw/output/video/${ids[0]}` })).statusCode).toBe(404);
  });
});
