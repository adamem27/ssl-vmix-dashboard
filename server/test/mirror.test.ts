import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setup } from './helpers.js';

const auth = (pw: string) => ({ authorization: 'Basic ' + Buffer.from(`x:${pw}`).toString('base64') });

describe('online mode', () => {
  it('asks for the password when one is set', async () => {
    const { db, ctx, sync } = setup();
    const app = await buildApp({ db, assetsDir: ctx.assetsDir, sync, password: 'regatta' });
    expect((await app.inject({ url: '/api/teams' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/teams', headers: auth('wrong') })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/teams', headers: auth('regatta') })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/teams' })).headers['www-authenticate']).toBeUndefined();
  });

  it('logs browsers in with a form and a cookie', async () => {
    const { db, ctx, sync } = setup();
    const app = await buildApp({ db, assetsDir: ctx.assetsDir, sync, password: 'regatta' });
    expect((await app.inject({ url: '/vmix/overview' })).headers.location).toBe('/login');
    const bad = await app.inject({ method: 'POST', url: '/login', payload: 'password=nope', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(bad.body).toContain('Wrong password');
    const ok = await app.inject({ method: 'POST', url: '/login', payload: 'password=regatta', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const cookie = String(ok.headers['set-cookie']).split(';')[0];
    expect(ok.headers.location).toBe('/');
    expect((await app.inject({ url: '/api/teams', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/teams', headers: { cookie: 'ssl_auth=abc' } })).statusCode).toBe(401);
  });

  it('lists and serves the assets folder for the vMix sync', async () => {
    const { db, ctx, sync } = setup();
    const app = await buildApp({ db, assetsDir: ctx.assetsDir, sync });
    fs.mkdirSync(path.join(ctx.assetsDir, 'teams', 'BRA'), { recursive: true });
    fs.writeFileSync(path.join(ctx.assetsDir, 'teams', 'BRA', 'flag.png'), 'png');
    fs.writeFileSync(path.join(ctx.assetsDir, 'ssl-vmix.xlsx.tmp'), 'partial');
    const m = (await app.inject({ url: '/api/mirror/manifest' })).json();
    // the race flags that come with the app are synced to the vMix PC too
    expect(m.files.map((f: any) => f.path).filter((p: string) => !p.startsWith('race-flags/'))).toEqual(['teams/BRA/flag.png']);
    expect(m.files.some((f: any) => f.path === 'race-flags/AP_postponed.png')).toBe(true);
    expect((await app.inject({ url: '/api/mirror/file?path=teams/BRA/flag.png' })).body).toBe('png');
    expect((await app.inject({ url: '/api/mirror/file?path=../test.sqlite' })).statusCode).toBe(404);
  });
});
