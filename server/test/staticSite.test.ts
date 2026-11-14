import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setup } from './helpers.js';
import { createTeam } from '../src/services/teams.js';
import { saveUpload } from '../src/services/assets.js';
import { createSet } from '../src/services/fleets.js';
import { encodePng } from '../src/services/png.js';
import type { StaticSitePublisher } from '../src/services/staticSite.js';

const png = encodePng(10, 6, () => [0, 0, 255, 255]);

/** A built web folder, like web/dist after npm run build. */
function fakeDist(dir: string) {
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'commentator.html'), '<script type="module" src="/assets/commentator-A.js"></script><link rel="stylesheet" href="/assets/src-C.css">');
  fs.writeFileSync(path.join(dir, 'assets', 'commentator-A.js'), 'import{a}from"./src-B.js";');
  fs.writeFileSync(path.join(dir, 'assets', 'src-B.js'), 'export const a=1;');
  fs.writeFileSync(path.join(dir, 'assets', 'src-C.css'), 'body{}');
  fs.writeFileSync(path.join(dir, 'assets', 'index-main.js'), 'the whole dashboard');
  return dir;
}

describe('static commentator page', () => {
  it('writes a self-contained folder, then only the heartbeat while nothing changes', async () => {
    const { db, ctx, sync, eventId, dir } = setup();
    const teamId = createTeam(db, { name: 'Brazil', code: 'BRA' });
    saveUpload(ctx, 'team', teamId, 'flag_small', png, 'flag.png');
    createSet(db, eventId, 'Group stage', 2);
    const out = path.join(dir, 'site');
    const app = await buildApp({ db, assetsDir: ctx.assetsDir, sync, webDist: fakeDist(path.join(dir, 'dist')), siteDir: out });
    const site = (app as any).staticSite as StaticSitePublisher;
    const put = (b: object) => app.inject({ method: 'PUT', url: '/api/static-site', payload: b });
    expect((await put({ publicUrl: 'https://komentator.example.com/', mode: 'folder' })).statusCode).toBe(200);

    const s = await site.publishNow();
    expect(s.error).toBe('');
    const folder = path.join(out, site.folderName());
    expect(site.folderName()).toMatch(/^komentator-[a-z0-9]{8,}$/);
    expect(s.url).toBe(`https://komentator.example.com/${site.folderName()}/index.html`);
    expect(fs.readFileSync(path.join(folder, 'index.html'), 'utf8')).toContain('src="assets/commentator-A.js"');
    expect(fs.readdirSync(path.join(folder, 'assets')).sort()).toEqual(['commentator-A.js', 'src-B.js', 'src-C.css']);
    const data = JSON.parse(fs.readFileSync(path.join(folder, 'data.json'), 'utf8'));
    const sets = data.routes['/api/fleet-sets'];
    expect(sets[0].name).toBe('Group stage');
    const flag = data.routes[`/api/overview?set=${sets[0].id}`].teams[0].assets.flag_small.previewUrl as string;
    expect(flag).toMatch(/^img\/[0-9a-f]{40}\.png$/);
    expect(fs.existsSync(path.join(folder, flag))).toBe(true);
    expect(JSON.stringify(data)).not.toContain('/api/assets/');
    const status = JSON.parse(fs.readFileSync(path.join(folder, 'status.json'), 'utf8'));
    expect(status.version).toBe(data.version);

    expect((await site.publishNow()).uploadedFiles).toBe(1); // status.json only
    createTeam(db, { name: 'Chile', code: 'CHI' });
    expect((await site.publishNow()).uploadedFiles).toBe(2); // data.json + status.json

    // Publish now while a round is under way: that round finishes, then one more sends the newest data
    expect(status.auto).toBe(false); // published by hand: the page does not expect a heartbeat
    const first = site.publishNow();
    createTeam(db, { name: 'Peru', code: 'PER' });
    const second = site.publishNow();
    expect(second).not.toBe(first);
    await first;
    await second;
    expect(fs.readFileSync(path.join(folder, 'data.json'), 'utf8')).toContain('"PER"');
  });

  it('a new address moves the page; settings never return the FTP password', async () => {
    const { db, ctx, sync, dir } = setup();
    const app = await buildApp({ db, assetsDir: ctx.assetsDir, sync, webDist: fakeDist(path.join(dir, 'dist')), siteDir: path.join(dir, 'site') });
    const before = (await app.inject({ url: '/api/static-site' })).json().folderName;
    const after = (await app.inject({ method: 'POST', url: '/api/static-site/new-address' })).json().folderName;
    expect(after).not.toBe(before);
    const r = (await app.inject({ method: 'PUT', url: '/api/static-site', payload: { mode: 'ftp', ftpHost: 'h55.example.pl', ftpUser: 'kom', ftpPassword: 'secret' } })).json();
    expect(r.hasFtpPassword).toBe(true);
    // failures back off instead of hammering the host (its firewall would ban this address)
    await app.inject({ method: 'PUT', url: '/api/static-site', payload: { mode: 'https', publicUrl: '' } });
    const site = (app as any).staticSite as StaticSitePublisher;
    expect((await site.publishNow()).error).toMatch(/next try in 5 s/);
    expect((await site.publishNow()).error).toMatch(/next try in 10 s/);
    expect(JSON.stringify(r)).not.toContain('secret');
  });
});
