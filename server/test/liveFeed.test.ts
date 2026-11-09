import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { setup } from './helpers.js';
import { createTeam } from '../src/services/teams.js';
import { saveUpload } from '../src/services/assets.js';
import { createSet } from '../src/services/fleets.js';
import { encodePng } from '../src/services/png.js';
import type { LiveFeedPusher } from '../src/services/liveFeed.js';

const png = encodePng(10, 6, () => [255, 0, 0, 255]);
const auth = { authorization: 'Basic ' + Buffer.from('x:regatta').toString('base64') };

/** fetch() that lands on another in-process app. */
const fetchInto = (app: FastifyInstance, calls: string[]) => (async (url: string, init: RequestInit = {}) => {
  const u = new URL(url);
  calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
  const r = await app.inject({ method: (init.method ?? 'GET') as any, url: u.pathname + u.search, headers: init.headers as Record<string, string>, payload: init.body as any });
  return new Response(r.body, { status: r.statusCode, headers: { 'content-type': String(r.headers['content-type'] ?? 'application/json') } });
}) as unknown as typeof fetch;

async function pair() {
  const venue = setup();
  const teamId = createTeam(venue.db, { name: 'Brazil', code: 'BRA' });
  const flag = saveUpload(venue.ctx, 'team', teamId, 'flag_small', png, 'flag.png');
  createSet(venue.db, venue.eventId, 'Group stage', 2);
  const cloud = setup();
  const online = await buildApp({ db: cloud.db, assetsDir: cloud.ctx.assetsDir, sync: cloud.sync, password: 'regatta', liveDir: path.join(cloud.dir, 'live-feed') });
  const calls: string[] = [];
  const local = await buildApp({ db: venue.db, assetsDir: venue.ctx.assetsDir, sync: venue.sync, liveFetch: fetchInto(online, calls) });
  const pusher = (local as any).liveFeed as LiveFeedPusher;
  pusher.save({ target: 'https://ssl.example.com/', password: 'regatta', enabled: true });
  return { venue, cloud, online, local, pusher, calls, flag };
}

const viewerCookie = async (online: FastifyInstance) => {
  const path = (await online.inject({ url: '/api/live/viewer', headers: auth })).json().path as string;
  const r = await online.inject({ url: path });
  expect(r.statusCode).toBe(302);
  expect(r.headers.location).toBe('/live');
  return String(r.headers['set-cookie']).split(';')[0];
};

describe('commentator screen online', () => {
  it('pushes the commentator data and its pictures, then only a heartbeat', async () => {
    const { online, local, pusher, calls, flag } = await pair();
    const s = await pusher.pushNow();
    expect(s.error).toBe('');
    expect(s.viewerUrl).toMatch(/^https:\/\/ssl\.example\.com\/c\/[\w-]+$/);
    expect(s.pictures).toBe(1);
    expect(calls).toEqual(['POST /api/live-feed/push', 'PUT /api/live-feed/blob/' + calls[1].split('/').pop()]);

    const cookie = await viewerCookie(online);
    const sets = (await online.inject({ url: '/api/fleet-sets', headers: { cookie } })).json();
    expect(sets.map((x: any) => x.name)).toEqual(['Group stage']);
    const overview = (await online.inject({ url: `/api/overview?date=2026-01-01&set=${sets[0].id}`, headers: { cookie } })).json();
    const url = overview.teams[0].assets.flag_small.previewUrl as string;
    expect(url).toContain(flag.id);
    const pic = await online.inject({ url, headers: { cookie } });
    expect(pic.statusCode).toBe(200);
    const original = await local.inject({ url });
    expect(pic.rawPayload.equals(original.rawPayload)).toBe(true);

    calls.length = 0;
    await pusher.pushNow();
    expect(calls).toEqual(['POST /api/live-feed/push']);
    expect((await online.inject({ url: '/api/live/status', headers: { cookie } })).json().feed.pushedAt).toMatch(/^\d{4}-/);
  });

  it('lets the commentator link read only the commentator screen', async () => {
    const { online, pusher } = await pair();
    await pusher.pushNow();
    const cookie = await viewerCookie(online);
    expect((await online.inject({ url: '/api/teams', headers: { cookie } })).statusCode).toBe(403);
    expect((await online.inject({ url: '/api/settings', headers: { cookie } })).statusCode).toBe(403);
    expect((await online.inject({ method: 'PUT', url: '/api/stage', headers: { cookie }, payload: { setId: null } })).statusCode).toBe(403);
    expect((await online.inject({ method: 'POST', url: '/api/live/viewer/rotate', headers: { cookie } })).statusCode).toBe(403);
    expect((await online.inject({ url: '/vmix/overview', headers: { cookie } })).headers.location).toBe('/live');
    expect((await online.inject({ url: '/api/meta', headers: { cookie } })).statusCode).toBe(200);
    // nobody without the link or the password
    expect((await online.inject({ url: '/api/meta' })).statusCode).toBe(401);
    expect((await online.inject({ url: '/c/wrong-token' })).statusCode).toBe(404);
    // a new link shuts the old one out
    await online.inject({ method: 'POST', url: '/api/live/viewer/rotate', headers: auth });
    expect((await online.inject({ url: '/api/meta', headers: { cookie } })).statusCode).toBe(401);
  });

  it('refuses pushes without the password, and on a server without one', async () => {
    const { online } = await pair();
    expect((await online.inject({ method: 'POST', url: '/api/live-feed/push', payload: { hash: 'x' } })).statusCode).toBe(401);
    const open = setup();
    const app = await buildApp({ db: open.db, assetsDir: open.ctx.assetsDir, sync: open.sync });
    expect((await app.inject({ method: 'POST', url: '/api/live-feed/push', payload: { hash: 'x' } })).statusCode).toBe(403);
    const bad = await online.inject({ method: 'POST', url: '/api/live-feed/push', headers: auth, payload: { version: 1, pushedAt: '', day: '', routes: { '/api/teams': [] }, blobs: {} } });
    expect(bad.statusCode).toBe(400);
  });

  it('reports a wrong password and keeps the snapshot after a restart', async () => {
    const { cloud, pusher } = await pair();
    pusher.save({ password: 'nope' });
    expect((await pusher.pushNow()).error).toContain('refused the password');
    pusher.save({ password: 'regatta' });
    expect((await pusher.pushNow()).error).toBe('');
    expect(fs.existsSync(path.join(cloud.dir, 'live-feed', 'feed.json'))).toBe(true);
    const again = await buildApp({ db: cloud.db, assetsDir: cloud.ctx.assetsDir, sync: cloud.sync, password: 'regatta', liveDir: path.join(cloud.dir, 'live-feed') });
    expect((await again.inject({ url: '/api/live/status', headers: auth })).json().feed).not.toBeNull();
    // the admin's own commentator screen at /live shows the snapshot too
    const sets = (await again.inject({ url: '/api/fleet-sets', headers: { ...auth, 'x-ssl-live': '1' } })).json();
    expect(sets[0].name).toBe('Group stage');
  });
});
