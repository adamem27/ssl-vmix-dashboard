import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { activeEvent, setSetting } from '../src/db/db.js';
import { createSet, getSetDetail, placeTeam } from '../src/services/fleets.js';
import { encodePng } from '../src/services/png.js';
import { LowerThirds } from '../src/services/lowerthirds.js';
import { setShowConfig, Show } from '../src/services/show.js';
import { clearOverrides, overridesOf, setOverride, withOverrides } from '../src/services/fieldOverrides.js';
import { setup, seedTeam } from './helpers.js';

/** A fake vMix: GT titles with the given fields; what is set shows in the next XML. */
function fakeVmix(titles: Record<string, string[]>) {
  const calls: string[] = [];
  const names = Object.keys(titles);
  const vals = new Map<string, string>();
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fetcher = async (url: string) => {
    const q = decodeURIComponent(url.split('/api/')[1] ?? '');
    if (q === '') {
      const inputs = names.map((n, i) => `<input key="k${i + 1}" number="${i + 1}" type="${titles[n][0] === '#Image' ? 'Image' : 'GT'}" title="${n}">${titles[n].filter((f) => !f.startsWith('#')).map((f) => (f.endsWith('.Source') ? `<image index="0" name="${f}">${esc(vals.get(`${i + 1}|${f}`) ?? '')}</image>` : `<text index="0" name="${f}">${esc(vals.get(`${i + 1}|${f}`) ?? 'x')}</text>`)).join('')}</input>`).join('');
      return { ok: true, status: 200, text: async () => `<vmix><inputs>${inputs}</inputs><overlays>${[1, 2, 3, 4].map((n) => `<overlay number="${n}"></overlay>`).join('')}</overlays></vmix>` };
    }
    calls.push(q);
    const sv = q.match(/^\?Function=Set(?:Text|Image)&Input=k?(\d+)&SelectedName=(.+?)&Value=(.*)$/s);
    if (sv) vals.set(`${sv[1]}|${sv[2]}`, sv[3]);
    return { ok: true, status: 200, text: async () => '' };
  };
  return { calls, fetcher, vals };
}

const TITLES = {
  ssl_welcome: ['Title.Text'],
  ssl_results_group_4: ['SUBTITLE.Text', 'TEAM 1.Text'],
  ssl_course: ['HEADER.Text', 'BG.Source'],
  ssl_picture: ['#Image', 'BG.Source'],
};

function race() {
  const s = setup();
  const ev = activeEvent(s.db).id;
  const teams = ['ESP', 'BRA', 'GBR', 'ITA'].map((c) => seedTeam(s.db, c, []).teamId);
  const setId = createSet(s.db, ev, 'Group stage', 2, 4);
  const [f1] = getSetDetail(s.db, setId).fleets;
  teams.forEach((t, i) => placeTeam(s.db, setId, { teamId: t, fleetId: f1.id, position: i + 1 }));
  setShowConfig(s.db, { fleetId: f1.id });
  return s;
}

describe('graphics editor overrides', () => {
  it('an edited field wins in set(); clearing it lets the dashboard value through again', async () => {
    const s = race();
    const v = fakeVmix(TITLES);
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    setOverride(s.db, 'ssl_results_group_4.gtzip', 'TEAM 1.Text', 'EDITED', 'x');
    await show.run('show:results');
    expect(v.calls).toContain('?Function=SetText&Input=k2&SelectedName=TEAM 1.Text&Value=EDITED');
    expect(v.calls.some((c) => c.includes('Value=TEAM ESP'))).toBe(false);
    setOverride(s.db, 'ssl_results_group_4', 'TEAM 1.Text', null);
    expect(overridesOf(s.db, 'ssl_results_group_4')).toEqual({});
    v.calls.length = 0;
    await show.run('show:results'); // takes it out (it is on air)…
    await show.run('show:results'); // …and in again with the dashboard's value
    expect(v.calls).toContain('?Function=SetText&Input=k2&SelectedName=TEAM 1.Text&Value=TEAM ESP');
  });

  it('the data sync pushes an edit the dashboard never fills, only to title inputs, as the vMix path', async () => {
    const s = race();
    setSetting(s.db, 'paths.vmixAssetsRoot', 'D:\\SSL');
    const v = fakeVmix(TITLES);
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    setOverride(s.db, 'ssl_course', 'BG.Source', 'overrides/bg.png');
    setOverride(s.db, 'ssl_course', 'HEADER.Text', 'RACE AREA');
    setOverride(s.db, 'ssl_picture', 'BG.Source', 'overrides/bg.png');
    await show.syncData();
    expect(v.calls).toContain('?Function=SetImage&Input=k3&SelectedName=BG.Source&Value=D:\\SSL\\overrides\\bg.png');
    expect(v.calls).toContain('?Function=SetText&Input=k3&SelectedName=HEADER.Text&Value=RACE AREA');
    expect(v.calls.some((c) => c.includes('Input=k4'))).toBe(false); // not a title: never touched
    // nothing changed: nothing sent again
    v.calls.length = 0;
    setSetting(s.db, 'x.touch', '1');
    await show.syncData();
    expect(v.calls).toEqual([]);
  });

  it('withOverrides drops the dashboard value of an edited field whatever its case', () => {
    const s = race();
    setOverride(s.db, 'T', 'Title.Text', 'MINE');
    const out = withOverrides(s.ctx, { title: 't.gtzip', type: 'GT', fields: ['Title.Text', 'Sub.Text'] }, new Map([['TITLE.Text', 'DASH'], ['Sub.Text', 'S']]));
    expect([...out]).toEqual([['Title.Text', 'MINE'], ['Sub.Text', 'S']]);
    expect(withOverrides(s.ctx, { title: 't', type: 'Image', fields: ['Title.Text'] }, new Map([['Title.Text', 'DASH']])).get('Title.Text')).toBe('DASH');
  });

  it('API: lists titles with their fields, uploads a picture, saves and resets an edit', async () => {
    const s = race();
    setSetting(s.db, 'paths.vmixAssetsRoot', 'D:\\SSL');
    const v = fakeVmix(TITLES);
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    const a = await buildApp({ db: s.db, assetsDir: s.ctx.assetsDir, sync: s.sync, show });
    const list = (await a.inject({ method: 'GET', url: '/api/vmix/editor' })).json();
    expect(list.inputs.map((i: any) => i.title)).toEqual(['ssl_welcome', 'ssl_results_group_4', 'ssl_course']);
    expect(list.inputs.find((i: any) => i.title === 'ssl_course').graphic.label).toBe('Race course');

    const png = encodePng(4, 4, () => [255, 0, 0, 255]);
    const boundary = '----t' + Math.random().toString(16).slice(2);
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="my bg.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const up = (await a.inject({ method: 'POST', url: '/api/vmix/editor/upload', payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } })).json();
    expect(up.path).toBe('overrides/my bg.png');
    expect(fs.existsSync(path.join(s.ctx.assetsDir, 'overrides', 'my bg.png'))).toBe(true);
    const imgs = (await a.inject({ method: 'GET', url: '/api/vmix/editor/images' })).json();
    expect(imgs.some((i: any) => i.value === 'overrides/my bg.png' && i.group === 'Uploaded')).toBe(true);

    const put = await a.inject({ method: 'PUT', url: '/api/vmix/editor/field', payload: { input: 'ssl_course', field: 'BG.Source', value: up.path } });
    expect(put.json()).toMatchObject({ ok: true, sent: 1 });
    expect(v.calls).toContain('?Function=SetImage&Input=k3&SelectedName=BG.Source&Value=D:\\SSL\\overrides\\my bg.png');
    await a.inject({ method: 'PUT', url: '/api/vmix/editor/field', payload: { input: 'ssl_course', field: 'HEADER.Text', value: 'NEW' } });
    const row = (await a.inject({ method: 'GET', url: '/api/vmix/editor' })).json().inputs.find((i: any) => i.title === 'ssl_course');
    expect(row.edited).toBe(2);
    expect(row.fields.find((f: any) => f.name === 'BG.Source')).toMatchObject({ override: 'overrides/my bg.png', preview: 'overrides/my bg.png' });

    // Reset all: the title gets back what it showed before the edits
    v.calls.length = 0;
    await a.inject({ method: 'DELETE', url: '/api/vmix/editor/input?input=ssl_course' });
    expect(v.calls).toContain('?Function=SetText&Input=k3&SelectedName=HEADER.Text&Value=x');
    expect(v.calls).toContain('?Function=SetImage&Input=k3&SelectedName=BG.Source&Value=');
    expect(clearOverrides(s.db, 'ssl_course')).toEqual({});
    await a.close();
  });
});
