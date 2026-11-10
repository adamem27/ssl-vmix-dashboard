import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/services/png.js';
import { zipStore } from '../src/services/xlsx.js';
import { setup, seedTeam } from './helpers.js';
import { LINEUP_SLOTS, saveLineup } from '../src/services/lineups.js';
import { activeEvent } from '../src/db/db.js';
import { updateSailor } from '../src/services/sailors.js';
import { updateTeam } from '../src/services/teams.js';
import { setSetting } from '../src/db/db.js';
import { companionPageExport, getLtConfig, LowerThirds, setLtConfig } from '../src/services/lowerthirds.js';

const fields = ['Bar.Source', 'PHOTO.Source', 'Bottom text.Text', 'Top text.Text', 'Flag.Source', 'Emblem.Source'];
const held = new Map<string, string>(); // what the fake vMix titles hold, by `k<n>/<field>`
const input = (n: number, title: string, f: string[]) =>
  `<input key="k${n}" number="${n}" type="GT" title="${title}">${f.map((x) => x.endsWith('.Source') ? `<image index="0" name="${x}">${held.get(`k${n}/${x}`) ?? ''}</image>` : `<text index="0" name="${x}">${held.get(`k${n}/${x}`) ?? 'x'}</text>`).join('')}</input>`;

function fakeVmix() {
  held.clear();
  const calls: string[] = [];
  let overlay = '';
  const fetcher = async (url: string) => {
    const q = decodeURIComponent(url.split('/api/')[1] ?? '');
    if (q === '') {
      const xml = `<vmix><inputs>${input(1, 'lowerthird_photo', fields)}${input(2, 'lowerthird_no_photo', fields.filter((f) => f !== 'PHOTO.Source'))}</inputs><overlays><overlay number="1">${overlay}</overlay></overlays></vmix>`;
      return { ok: true, status: 200, text: async () => xml };
    }
    calls.push(q);
    const set = q.match(/Function=Set(?:Text|Image)&Input=(k\d)&SelectedName=(.+?)&Value=(.*)$/);
    if (set) held.set(`${set[1]}/${set[2]}`, set[3]);
    const m = q.match(/Function=OverlayInput1In&Input=k(\d)/);
    if (m) overlay = m[1];
    if (q.includes('OverlayInput1Out')) overlay = '';
    return { ok: true, status: 200, text: async () => '' };
  };
  return { calls, fetcher };
}

describe('lower thirds', () => {
  it('brings a sailor in, swaps only changed fields on air, cycles best results and goes out', async () => {
    const s = setup();
    const { teamId, sailorIds } = seedTeam(s.db, 'BRA', ['Martine Grael', 'Kahena Kunze']);
    updateTeam(s.db, teamId, { nickname: 'The Canaries' });
    updateSailor(s.db, sailorIds[0], { bestResult1: 'Olympic gold 2016', bestResult2: 'Olympic gold 2021' });
    saveLineup(s.ctx, activeEvent(s.db).id, teamId, { rows: [
      { slot: 'Pit', sailorId: sailorIds[0], firstName: 'Martine', lastName: 'Grael', number: '9' },
      { slot: 'Helm', sailorId: sailorIds[1], firstName: 'Kahena', lastName: 'Kunze', number: '1' },
    ] });
    const v = fakeVmix();
    const lt = new LowerThirds(s.ctx, v.fetcher);

    await lt.pickTeam('bra');
    expect(v.calls).toEqual([]); // a country key only picks the team by default

    // no photo → the no-photo title, filled and brought in
    const r = await lt.showSailor(null, 'pit');
    expect(r).toMatchObject({ kind: 'sailor', slot: 'Pit', cameIn: true, input: 'lowerthird_no_photo' });
    expect(v.calls).toContain('?Function=SetText&Input=k2&SelectedName=Top text.Text&Value=Martine GRAEL');
    expect(v.calls).toContain('?Function=SetText&Input=k2&SelectedName=Bottom text.Text&Value=9  I  PIT');
    expect(v.calls.at(-1)).toBe('?Function=OverlayInput1In&Input=k2');

    // best results: only Bottom text changes, no transition
    v.calls.length = 0;
    await lt.nextLine();
    expect(v.calls).toEqual(['?Function=SetText&Input=k2&SelectedName=Bottom text.Text&Value=Olympic gold 2016']);
    v.calls.length = 0;
    await lt.nextLine(); await lt.nextLine();
    expect(v.calls.at(-1)).toBe('?Function=SetText&Input=k2&SelectedName=Bottom text.Text&Value=9  I  PIT');

    // another sailor of the same team on air: only names change (data change animations), no transition
    v.calls.length = 0;
    await lt.showSailor('BRA', 'Helm');
    expect(v.calls.every((c) => c.includes('Text.Text') || c.includes('text.Text'))).toBe(true);
    expect(v.calls.some((c) => c.includes('Overlay'))).toBe(false);

    // the team: country and nickname
    v.calls.length = 0;
    await lt.showTeam('BRA');
    expect(v.calls).toContain('?Function=SetText&Input=k2&SelectedName=Top text.Text&Value=TEAM BRA');
    expect(v.calls).toContain('?Function=SetText&Input=k2&SelectedName=Bottom text.Text&Value=THE CANARIES');

    await lt.out();
    expect(v.calls.at(-1)).toBe('?Function=OverlayInput1Out');
    expect(lt.state.onAir).toBe(false);
  });

  it('fills a title with its own field names and puts in the team bar made like the title\'s (no squeezed bar)', async () => {
    const s = setup();
    const { teamId } = seedTeam(s.db, 'BRA', ['Martine Grael']);
    seedTeam(s.db, 'ANT', []);
    updateTeam(s.db, teamId, { nickname: 'The Canaries' });
    // the title as the GTZIP generator made it: Name, position/pb, PHOTO, Flag and a bar ANT_lowerthird.png 802×105
    const bar = 'aaaaaaaa-0000-0000-0000-000000000001\\ANT_lowerthird.png';
    const doc = `<?xml version="1.0" encoding="utf-16"?><Composition Width="1920" Height="1080"><Image Name="Bar" Dimensions="802,105,0" Location="559,920,0"><Image.Bitmap><Bitmap Source="${bar}" /></Image.Bitmap></Image><TextBlock Name="Name" Text="x" /><TextBlock Name="position/pb" Text="x" /><Image Name="PHOTO" Dimensions="425,425,0" /><Image Name="Flag" Dimensions="124,79,0" /><Storyboard Type="DataChangeOut" DataName="PHOTO.Source"><Storyboard.Animations><Fly Object="PHOTO" Duration="0.3" Direction="Bottom" /></Storyboard.Animations></Storyboard><Storyboard Type="DataChangeIn" DataName="PHOTO.Source"><Storyboard.Animations><Fly Object="PHOTO" Duration="0.5" Direction="Bottom" /></Storyboard.Animations></Storyboard></Composition>`;
    const one = encodePng(1, 1, () => [0, 0, 0, 0]);
    const ct = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="text/xml" /></Types>';
    fs.mkdirSync(path.join(s.ctx.assetsDir, 'gtzip'), { recursive: true });
    fs.writeFileSync(path.join(s.ctx.assetsDir, 'gtzip', 'lowerthird_photo 2.gtzip'), zipStore([['document.xml', Buffer.from(doc)], ['resources.xml', Buffer.from('<resources />')], ['thumbnail.png', one], ['[Content_Types].xml', Buffer.from(ct)]]));
    // the team's generated pictures: one named like the title's bar, one of another shape
    const dir = path.join(s.ctx.assetsDir, 'PNG generator', 'BRA');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'BRA_bar_waves.png'), encodePng(10, 2, () => [0, 0, 0, 255]));
    fs.writeFileSync(path.join(dir, 'BRA_lowerthird.png'), encodePng(802, 105, () => [0, 0, 0, 255]));
    const titleFields = ['Bar.Source', 'Name.Text', 'position/pb.Text', 'PHOTO.Source', 'Flag.Source'];
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      const q = decodeURIComponent(url.split('/api/')[1] ?? '');
      if (q === '') return { ok: true, status: 200, text: async () => `<vmix><inputs>${input(1, 'lowerthird_photo 2 1.gtzip', titleFields)}</inputs><overlays><overlay number="1">${overlay}</overlay></overlays></vmix>` };
      calls.push(q);
      const set = q.match(/Function=Set(?:Text|Image)&Input=(k\d)&SelectedName=(.+?)&Value=(.*)$/);
      if (set) held.set(`${set[1]}/${set[2]}`, set[3]);
      if (q.includes('OverlayInput1In')) overlay = '1';
      if (q.includes('OverlayInput1Out')) overlay = '';
      times.push(Date.now());
      return { ok: true, status: 200, text: async () => '' };
    };
    const times: number[] = [];
    let overlay = '';
    held.clear();
    setLtConfig(s.db, { photoInput: 'lowerthird_photo 2 1.gtzip', noPhotoInput: 'lowerthird_photo 2 1.gtzip' });
    const lt = new LowerThirds(s.ctx, fetcher);
    await lt.showTeam('BRA');
    expect(calls).toContain('?Function=SetText&Input=k1&SelectedName=Name.Text&Value=TEAM BRA');
    expect(calls).toContain('?Function=SetText&Input=k1&SelectedName=position/pb.Text&Value=THE CANARIES');
    const barCall = calls.find((c) => c.includes('SelectedName=Bar.Source'));
    expect(barCall).toMatch(/BRA_lowerthird\.png$/);
    expect(calls.at(-1)).toBe('?Function=OverlayInput1In&Input=k1');
    await lt.out();

    // vMix plays the photo's DataChange, not a Fly in Transition In: the title comes in with no photo, the photo after
    calls.length = 0; times.length = 0;
    await (lt as any).show('lowerthird_photo 2 1.gtzip', new Map([['PHOTO.Source', 'C:\\p.png']]), { kind: 'sailor', teamId, slot: 'Pit', line: 0 });
    const inAt = calls.indexOf('?Function=OverlayInput1In&Input=k1');
    expect(inAt).toBeGreaterThanOrEqual(0);
    expect(calls.slice(inAt + 1)).toEqual(['?Function=SetImage&Input=k1&SelectedName=PHOTO.Source&Value=C:\\p.png']);
    // out: the photo flies down (DataChange Out 0.3 s), then the title goes out; the key does not wait for it
    calls.length = 0; times.length = 0;
    const t0 = Date.now();
    await lt.out();
    expect(Date.now() - t0).toBeLessThan(250);
    expect(calls).toEqual(['?Function=SetImage&Input=k1&SelectedName=PHOTO.Source&Value=']);
    await new Promise((r) => setTimeout(r, 400));
    expect(calls.at(-1)).toBe('?Function=OverlayInput1Out');
    expect(times.at(-1)! - t0).toBeGreaterThanOrEqual(290);
  });

  it('every place key shows the sailor on that place (Trimmer 2 is not Trimmer 1)', async () => {
    const s = setup();
    const names = LINEUP_SLOTS.map((d) => `First ${d.key}`);
    const { teamId } = seedTeam(s.db, 'BRA', names);
    saveLineup(s.ctx, activeEvent(s.db).id, teamId, { rows: LINEUP_SLOTS.map((d) => ({ slot: d.key, sailorId: null, firstName: 'X', lastName: d.key, number: '' })) });
    const v = fakeVmix();
    const lt = new LowerThirds(s.ctx, v.fetcher);
    await lt.pickTeam('BRA');
    for (const d of LINEUP_SLOTS) {
      const r = await lt.run(`place:${d.key}`);
      expect(r).toMatchObject({ slot: d.key });
      expect(v.calls).toContain(`?Function=SetText&Input=k2&SelectedName=Top text.Text&Value=X ${d.key.toUpperCase()}`);
    }
    // by label and by number too
    expect(await lt.showSailor(null, 'Trimmer 2')).toMatchObject({ slot: 'Trimmer1' });
    expect(await lt.showSailor(null, 'trimmer 1')).toMatchObject({ slot: 'Trimmer' });
    expect(await lt.showSailor(null, '6')).toMatchObject({ slot: 'Trimmer1' });
  });

  it('lays out keys: countries, places, then TEAM / NEXT / OUT, and presses them by position', async () => {
    const s = setup();
    seedTeam(s.db, 'BRA', []); seedTeam(s.db, 'ARG', []);
    setLtConfig(s.db, { rows: 4, cols: 8 });
    const v = fakeVmix();
    const lt = new LowerThirds(s.ctx, v.fetcher);
    const [page] = lt.layout();
    expect(page.filter((k) => k.row === 0).map((k) => k.text)).toEqual(['ARG', 'BRA']);
    expect(page.filter((k) => k.row === 1).length).toBe(8);
    expect(page.find((k) => k.row === 2 && k.col === 0)?.action).toBe('place:Helm');
    expect(page.filter((k) => k.row === 3).map((k) => k.action)).toEqual(['showteam', 'next', 'out']);
    await lt.press(1, 0, 1);
    expect(lt.state.teamId).toBeTruthy();
    expect(lt.layout()[0][1].active).toBe(true);
  });

  it('builds a Companion page file whose keys call their own actions', () => {
    const s = setup();
    seedTeam(s.db, 'BRA', []);
    setLtConfig(s.db, { rows: 4, cols: 8, companionPage: 3 });
    const lt = new LowerThirds(s.ctx, fakeVmix().fetcher);
    const f: any = companionPageExport(lt.layout()[0], 'http://10.0.0.5:4000/', getLtConfig(s.db), 0);
    expect(f).toMatchObject({ version: 4, type: 'page', oldPageNumber: 3, page: { gridSize: { maxColumn: 7, maxRow: 3 } } });
    expect(f.instances.ssl_dashboard_lt.instance_type).toBe('generic-http');
    const url = (r: number, c: number) => f.page.controls[r][c].steps[0].action_sets.down[0].options.url;
    expect(url(0, 0)).toBe('http://10.0.0.5:4000/api/lt/pick?team=BRA');
    expect(url(1, 0)).toMatch(/\/api\/lt\/sailor\?place=/);
    expect(url(3, 2)).toBe('http://10.0.0.5:4000/api/lt/out');
    expect(f.page.controls[0][0].style.text).toBe('BRA');
  });

  it('sends nothing to Companion: the keys show no on-air feedback', async () => {
    const s = setup();
    seedTeam(s.db, 'BRA', []);
    setLtConfig(s.db, { companionUrl: 'http://127.0.0.1:8000/', rows: 4, cols: 8 });
    setSetting(s.db, 'show.config', JSON.stringify({ labels: false }));
    const urls: string[] = [];
    const lt = new LowerThirds(s.ctx, async (u: string) => { urls.push(u); return { ok: true, status: 200, text: async () => '' }; });
    await lt.pushLabels(true);
    expect(urls).toEqual([]);
  });
});
