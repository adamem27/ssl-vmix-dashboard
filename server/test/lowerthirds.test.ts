import { describe, expect, it } from 'vitest';
import { setup, seedTeam } from './helpers.js';
import { saveLineup } from '../src/services/lineups.js';
import { activeEvent } from '../src/db/db.js';
import { updateSailor } from '../src/services/sailors.js';
import { updateTeam } from '../src/services/teams.js';
import { companionPageExport, getLtConfig, LowerThirds, setLtConfig } from '../src/services/lowerthirds.js';

const fields = ['Bar.Source', 'PHOTO.Source', 'Bottom text.Text', 'Top text.Text', 'Flag.Source', 'Emblem.Source'];
const input = (n: number, title: string, f: string[]) =>
  `<input key="k${n}" number="${n}" type="GT" title="${title}">${f.map((x) => x.endsWith('.Source') ? `<image index="0" name="${x}"></image>` : `<text index="0" name="${x}">x</text>`).join('')}</input>`;

function fakeVmix() {
  const calls: string[] = [];
  let overlay = '';
  const fetcher = async (url: string) => {
    const q = decodeURIComponent(url.split('/api/')[1] ?? '');
    if (q === '') {
      const xml = `<vmix><inputs>${input(1, 'lowerthird_photo', fields)}${input(2, 'lowerthird_no_photo', fields.filter((f) => f !== 'PHOTO.Source'))}</inputs><overlays><overlay number="1">${overlay}</overlay></overlays></vmix>`;
      return { ok: true, status: 200, text: async () => xml };
    }
    calls.push(q);
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

  it('sends the key labels to Companion, only the ones that changed', async () => {
    const s = setup();
    seedTeam(s.db, 'BRA', []);
    setLtConfig(s.db, { companionUrl: 'http://127.0.0.1:8000/', rows: 4, cols: 8 });
    const urls: string[] = [];
    const lt = new LowerThirds(s.ctx, async (u: string) => { urls.push(u); return { ok: true, status: 200, text: async () => '' }; });
    await lt.pushLabels();
    expect(urls.length).toBe(1 + 9 + 3);
    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:8000\/api\/location\/1\/0\/0\/style\?text=BRA&bgcolor=/);
    urls.length = 0;
    await lt.pushLabels();
    expect(urls).toEqual([]);
  });
});
