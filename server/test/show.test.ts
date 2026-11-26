import fs from 'node:fs';
import path from 'node:path';
import { encodePng } from '../src/services/png.js';
import { PNG } from 'pngjs';
import { comparisonFlag } from '../src/services/compareImages.js';
import { describe, expect, it } from 'vitest';
import { setup, seedTeam } from './helpers.js';
import { activeEvent, setSetting } from '../src/db/db.js';
import { createFleet, createSet, getSetDetail, placeTeam, renameFleet } from '../src/services/fleets.js';
import { saveLineup } from '../src/services/lineups.js';
import { removeAsset, saveUpload } from '../src/services/assets.js';
import { saveResults } from '../src/services/results.js';
import { createGraphicSet, listGraphicSets, repeatLoop, seedGraphicSets, updateGraphicSet } from '../src/services/graphicSets.js';
import { LowerThirds } from '../src/services/lowerthirds.js';
import { companionFiles, copiesOf, deckPages, getShowConfig, setShowConfig, Show } from '../src/services/show.js';
import { nationColours, teamKeyColours, textOn } from '../src/services/nationColours.js';
import { setCurrentStage } from '../src/services/workbookSheets.js';
import { compareTab, scheduleRows, setCompareOverride } from '../src/services/showData.js';
import { createPerson, createScheduleItem, personName, setWeather } from '../src/services/general.js';
import { groupLabel, groupLetter } from '../src/services/groupNames.js';
import { buildApp } from '../src/app.js';
import { lbarFiles, saveLook, status as lbarStatus } from '../src/services/lbarSwap.js';

/** A fake vMix with named inputs and four overlay channels. */
function fakeVmix(titles: Record<string, string[]>) {
  const calls: string[] = [];
  const raw: string[] = [];
  const names = Object.keys(titles);
  const overlays: Record<number, string> = {};
  const num = (k: string) => String(names.indexOf(k) + 1);
  const vals = new Map<string, string>();
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fetcher = async (url: string) => {
    const q = decodeURIComponent(url.split('/api/')[1] ?? '');
    if (q === '') {
      const inputs = names.map((n, i) => `<input key="k${i + 1}" number="${i + 1}" type="${titles[n][0] === '#Image' ? 'Image' : 'GT'}" title="${n}">${titles[n].filter((f) => !f.startsWith('#')).map((f) => (f.endsWith('.Source') ? `<image index="0" name="${f}">${esc(vals.get(`${i + 1}|${f}`) ?? '')}</image>` : `<text index="0" name="${f}">${esc(vals.get(`${i + 1}|${f}`) ?? 'x')}</text>`)).join('')}</input>`).join('');
      const ov = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<overlay number="${n}">${overlays[n] ?? ''}</overlay>`).join('');
      return { ok: true, status: 200, text: async () => `<vmix><inputs>${inputs}</inputs><overlays>${ov}</overlays></vmix>` };
    }
    calls.push(q);
    raw.push(url.split('/api/')[1] ?? '');
    // vMix keeps what was set: the next XML shows it
    const sv = q.match(/^\?Function=Set(?:Text|Image)&Input=k?(\d+)&SelectedName=(.+?)&Value=(.*)$/s);
    if (sv) vals.set(`${sv[1]}|${sv[2]}`, sv[3]);
    const m = q.match(/Function=OverlayInput(\d)In&Input=k?(\d+)/);
    if (m) overlays[Number(m[1])] = m[2];
    const o = q.match(/Function=OverlayInput(\d)(Out|Off)(?:&Mix=\d+)?$/);
    if (o) overlays[Number(o[1])] = '';
    return { ok: true, status: 200, text: async () => '' };
  };
  return { calls, raw, fetcher, overlays, num, vals };
}

const TITLES = {
  ssl_welcome: ['Title.Text'],
  ssl_schedule: ['DayText.Text'],
  ssl_results_group_4: ['SUBTITLE.Text', 'TEAM 1.Text'],
  ssl_bug: ['TEXT.Text'],
  ssl_break: [],
  ssl_lineup_9: ['PitNAME.Text', 'PitSURNAME.Text', 'PitNUMBER.Text', 'Flag.Source'],
  lowerthird_photo: ['Top text.Text', 'Bottom text.Text', 'PHOTO.Source', 'Bar.Source', 'Flag.Source', 'Emblem.Source'],
  lowerthird_no_photo: ['Top text.Text', 'Bottom text.Text', 'Bar.Source', 'Flag.Source', 'Emblem.Source'],
  ssl_lt_lineup5: [...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`NAME ${n}.Text`, `POSITION ${n}.Text`, `PHOTO ${n}.Source`]), 'Bar.Source'],
  ssl_lt_team_q: ['Top text.Text', 'Bottom text.Text', 'Bar.Source', 'Sponsor.Source'],
};

function race() {
  const s = setup();
  const ev = activeEvent(s.db).id;
  const teams = ['ESP', 'BRA', 'GBR', 'ITA'].map((c) => seedTeam(s.db, c, []).teamId);
  const setId = createSet(s.db, ev, 'Group stage', 2, 4);
  const [f1, f2] = getSetDetail(s.db, setId).fleets;
  teams.forEach((t, i) => placeTeam(s.db, setId, { teamId: t, fleetId: f1.id, position: i + 1 }));
  setShowConfig(s.db, { fleetId: f1.id });
  saveLineup(s.ctx, ev, teams[0], { rows: [
    { slot: 'Pit', firstName: 'Ana', lastName: 'Ruiz', number: '12' },
    { slot: 'Helm', firstName: 'Jordi', lastName: 'Xammar', number: '3' },
    { slot: 'Bow', firstName: 'Nil', lastName: 'Pons', number: '' },
  ] });
  return { s, ev, teams, f1, f2 };
}

describe('show control', () => {
  it('makes the comparison flag on the emblems\' square canvas and leaves the team\'s flag file alone', () => {
    const { s } = race();
    const src = path.join(s.ctx.assetsDir, 'flag_src.png');
    const orig = encodePng(300, 200, () => [200, 0, 0, 255]);
    fs.mkdirSync(s.ctx.assetsDir, { recursive: true });
    fs.writeFileSync(src, orig);
    const out = comparisonFlag(s.ctx, 'ESP', src);
    expect(out).toMatch(/team-comparison[\\/]ESP_flag_comparison\.png$/);
    const png = PNG.sync.read(fs.readFileSync(out));
    expect([png.width, png.height]).toEqual([401, 401]);
    const a = (x: number, y: number) => png.data[(y * 401 + x) * 4 + 3];
    expect(a(200, 200)).toBe(255);
    expect(a(200, 80)).toBe(0); // above the flag: 214 px tall, centred
    expect(a(30, 200)).toBe(0); // left of it: 321 px wide
    expect(fs.readFileSync(src).equals(orig)).toBe(true);
  });

  it('schedule rows find their group and its flags with no stage picked, and in another stage than the picked one', () => {
    const { s, ev, f1 } = race();
    setSetting(s.db, 'paths.vmixAssetsRoot', 'D:\\SSL');
    createScheduleItem(s.db, ev, { date: '2026-01-01', time: '12:00', race: '1', fleet: groupLabel(f1.name) });
    const flags = () => scheduleRows(s.ctx, ev, '2026-01-01')[0].flags.length;
    setCurrentStage(s.db, ev, null);
    expect(flags()).toBe(4);
    const other = createSet(s.db, ev, 'Finals', 1, 4);
    setCurrentStage(s.db, ev, other);
    expect(scheduleRows(s.ctx, ev, '2026-01-01')[0].group).toBe(groupLabel(f1.name));
    expect(flags()).toBe(4);
  });

  it('toggles a board on overlay 1, where it replaces a lower third; OUT takes either out', async () => {
    const { s } = race();
    const v = fakeVmix(TITLES);
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    await show.run('teamlt:1'); // team lower third of team 1, on overlay 1 like every graphic but the break scene
    expect(v.calls.at(-1)).toMatch(/^\?Function=OverlayInput1In&Input=k8$/);
    v.calls.length = 0;
    await show.run('show:welcome');
    expect(v.calls).toEqual(['?Function=OverlayInput1In&Input=k1']);
    await show.run('out');
    expect(v.overlays[1]).toBe('');
    await show.run('show:welcome');
    v.calls.length = 0;
    v.calls.length = 0;
    await show.run('show:welcome');
    expect(v.calls).toEqual(['?Function=OverlayInput1Out']);
  });

  it('picks the variant by the number of boats, fills results and undoes', async () => {
    const { s } = race();
    const v = fakeVmix(TITLES);
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    await show.run('show:results');
    expect(v.calls).toContain('?Function=SetText&Input=k3&SelectedName=TEAM 1.Text&Value=TEAM ESP');
    expect(v.calls.at(-1)).toBe('?Function=OverlayInput1In&Input=k3');
    await show.run('show:welcome');
    expect(v.overlays[1]).toBe('1');
    await show.run('undo');
    expect(v.overlays[1]).toBe('3');
  });

  it('shows announcements on the bug, sorts sailors by shirt number and fills a lineup', async () => {
    const { s, ev } = race();
    createGraphicSet(s.db, ev, 'announcement', 'General recall', { text: 'GENERAL RECALL' });
    const v = fakeVmix(TITLES);
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    const n = show.announcements().findIndex((a) => a.data.text === 'GENERAL RECALL') + 1;
    await show.run(`bug:${n}`);
    expect(v.calls).toContain('?Function=SetText&Input=k4&SelectedName=TEXT.Text&Value=GENERAL RECALL');
    expect(v.overlays[1]).toBe('4');

    expect(show.sailors().map((x) => x.number)).toEqual(['3', '12', '']);
    v.calls.length = 0;
    await show.run('sailor:2');
    expect(v.calls).toContain('?Function=SetText&Input=k8&SelectedName=Top text.Text&Value=Ana RUIZ');
    await show.run('shirt:3');
    expect(v.calls).toContain('?Function=SetText&Input=k8&SelectedName=Top text.Text&Value=Jordi XAMMAR');

    v.calls.length = 0;
    await show.run('lineup:1');
    expect(v.calls).toContain('?Function=SetText&Input=k6&SelectedName=PitSURNAME.Text&Value=RUIZ');
    expect(v.calls).toContain('?Function=SetText&Input=k6&SelectedName=PitNUMBER.Text&Value=12');
  });

  it('finds the bug title under its GTZIP name, before a placeholder image, and says so when only the placeholder is there', async () => {
    const { s, ev } = race();
    seedGraphicSets(s.db, ev);
    const v = fakeVmix({ ...TITLES, ssl_bug: ['#Image'], 'Announcement_bug 2.gtzip': ['bar.Source', 'TEXT.Text', 'icon_background.Source', 'Race flag.Source'] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    await show.run('bug:1');
    const n = v.num('Announcement_bug 2.gtzip');
    expect(v.calls).toContain(`?Function=SetText&Input=k${n}&SelectedName=TEXT.Text&Value=INDIVIDUAL RECALL`);
    expect(v.calls.some((c) => c.startsWith(`?Function=SetImage&Input=k${n}&SelectedName=Race flag.Source&Value=`) && c.endsWith('X_individual_recall.png'))).toBe(true);
    expect(v.overlays[1]).toBe(n);
    const only = fakeVmix({ ...TITLES, ssl_bug: ['#Image'] });
    const show2 = new Show(s.ctx, new LowerThirds(s.ctx, only.fetcher), only.fetcher);
    await expect(show2.run('bug:1')).rejects.toThrow(/Image, no title fields/);
    // a GTZIP title whose fields vMix does not list gets the data by the GTZIP's own names, and comes in
    const blind = fakeVmix({ ...TITLES, ssl_bug: [] });
    const show3 = new Show(s.ctx, new LowerThirds(s.ctx, blind.fetcher), blind.fetcher);
    await show3.run('bug:1');
    const b = blind.num('ssl_bug');
    expect(blind.calls).toContain(`?Function=SetText&Input=k${b}&SelectedName=TEXT.Text&Value=INDIVIDUAL RECALL`);
    expect(blind.calls.some((c) => c.startsWith(`?Function=SetImage&Input=k${b}&SelectedName=icon.Source`))).toBe(true);
    expect(blind.overlays[1]).toBe(b);
  });

  it('bugs carry text and icon and toggle; every bug and ticker has a key, new ones too; General graphics go in at the press', async () => {
    const { s, ev } = race();
    seedGraphicSets(s.db, ev);
    setSetting(s.db, 'paths.vmixAssetsRoot', 'D:\\SSL\\assets');
    const v = fakeVmix({ ...TITLES, ssl_bug: ['bar.Source', 'TEXT.Text', 'icon_background.Source', 'Race flag.Source'], ssl_ticker: ['Ticker1.Text'], ssl_welcome: ['stage.Text', 'SSL Gold Cup.Text', 'Brazil 2026.Text', 'Day.Text', 'Date.Text', 'City.Text', 'Country.Text'], ssl_officials: ['TITLE.Text', 'ROLE 1.Text', 'ROLE 8.Text', 'NAME 1.Text', 'NAME 11.Text'] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    const pages = (await show.view()).pages;
    // the announcements used most on BUGS OFTEN, the rest on BUGS RARE, each in its order
    const often = pages.find((p) => p.name === 'BUGS OFTEN')!;
    expect(often.keys[0].slice(0, 3).map((k) => k?.text)).toEqual(['X – INDIVIDUAL RECALL', 'FIRST SUBSTITUTE – GENERAL R', 'AP – POSTPONED']);
    expect(often.keys.flat().filter((k) => k && !k.empty && k.action.startsWith('bug:')).length).toBe(14);
    const rare = pages.find((p) => p.name === 'BUGS RARE')!;
    expect(rare.keys[0][0]).toMatchObject({ action: 'bug:r1', text: 'AP OVER H – POSTPONED, SIGNA', empty: false });
    await show.run('bug:o1');
    expect(v.calls).toContain('?Function=SetText&Input=k4&SelectedName=TEXT.Text&Value=INDIVIDUAL RECALL');
    await show.run('bug:o1');
    v.calls.length = 0;
    // the announcement on its key: one line of text and the flag's PNG from the vMix assets folder
    await show.run('bug:1');
    expect(v.calls).toContain('?Function=SetText&Input=k4&SelectedName=TEXT.Text&Value=INDIVIDUAL RECALL');
    expect(v.calls).toContain('?Function=SetImage&Input=k4&SelectedName=Race flag.Source&Value=D:\\SSL\\assets\\race-flags\\X_individual_recall.png');
    expect(v.calls.some((c) => /icon_background|bar\.Source/.test(c))).toBe(false);
    expect(v.overlays[1]).toBe('4');
    await show.run('bug:1');
    expect(v.overlays[1]).toBe('');

    // a new ticker made during the show is on the next free ticker key at once
    const before = (await show.view()).pages.find((p) => p.name === 'TICKERS')!.keys.flat().filter((k) => k && k.action.startsWith('ticker:') && !k.empty).length;
    createGraphicSet(s.db, ev, 'ticker', 'Breaking', { items: 'BOAT CAPSIZED - ALL CREW SAFE' });
    show.invalidate(); // what any change through the dashboard's API does (showRoutes)
    const tk = (await show.view()).pages.find((p) => p.name === 'TICKERS')!.keys.flat().filter((k) => k && k.action.startsWith('ticker:') && !k.empty);
    expect(tk.length).toBe(before + 1);
    v.calls.length = 0;
    await show.run(tk.at(-1)!.action);
    expect(v.calls).toContain(`?Function=SetText&Input=k11&SelectedName=Ticker1.Text&Value=${repeatLoop('BOAT CAPSIZED - ALL CREW SAFE I ')}`);
    // THANKS FOR WATCHING is the fixed ticker
    await show.run('ticker:thanks');
    expect(v.calls.some((c) => c.includes('Ticker1.Text&Value=THANKS FOR WATCHING'))).toBe(true);

    // a board gets General graphics at the press
    const w = listGraphicSets(s.db, ev, 'welcome')[0];
    updateGraphicSet(s.db, w.id, { data: { stage: 'Pan-American Qualifiers', day: 'Day 1' } });
    v.calls.length = 0;
    await show.run('show:welcome');
    // the Welcome bar (Welcome 2.gtzip): the stage, the day and the date (empty = today); its fixed texts stay
    expect(v.calls).toContain('?Function=SetText&Input=k1&SelectedName=stage.Text&Value=Pan-American Qualifiers');
    expect(v.calls).toContain('?Function=SetText&Input=k1&SelectedName=Day.Text&Value=Day 1');
    expect(v.calls.some((c) => /SelectedName=Date\.Text&Value=\d\d\.\d\d\.\d{4}$/.test(c))).toBe(true);
    expect(v.calls.some((c) => /SSL Gold Cup|Brazil 2026/.test(c))).toBe(false);
    expect(v.calls.some((c) => c.includes('SelectedName=City.Text&Value=RIO DE JANEIRO'))).toBe(true);
    expect(v.calls.some((c) => c.includes('SelectedName=Country.Text&Value=BRAZIL'))).toBe(true);
    updateGraphicSet(s.db, w.id, { data: { date: '02.12.2026' } });
    await show.run('show:welcome');
    await show.run('show:welcome');
    expect(v.calls).toContain('?Function=SetText&Input=k1&SelectedName=Date.Text&Value=02.12.2026');
    // Race officials: the panel's roles and names, filled from the officials list until changed on the tab
    const o = listGraphicSets(s.db, ev, 'officials')[0];
    updateGraphicSet(s.db, o.id, { data: { name_11: 'Jan Kowalski (POL)' } });
    await show.run('show:officials');
    expect(v.calls).toContain('?Function=SetText&Input=k12&SelectedName=ROLE 1.Text&Value=REGATTA DIRECTOR'.replace('k12', `k${v.num('ssl_officials')}`));
    expect(v.calls.some((c) => c.includes('SelectedName=ROLE 8.Text&Value=JURY (REMOTE)'))).toBe(true);
    expect(v.calls.some((c) => c.includes('SelectedName=NAME 1.Text&Value=Paul Hutton-Ashkenny (GBR)'))).toBe(true);
    expect(v.calls.some((c) => c.includes('SelectedName=NAME 11.Text&Value=Jan Kowalski (POL)'))).toBe(true);
  });

  it('splits the lineup lower third into the first five and the rest, then goes out; shows a qualified team', async () => {
    const { s, ev, teams } = race();
    saveLineup(s.ctx, ev, teams[0], { rows: [
      { slot: 'Tactician', firstName: 'A', lastName: 'Tac', number: '1' }, { slot: 'Helm', firstName: 'B', lastName: 'Hel', number: '2' },
      { slot: 'Main', firstName: 'C', lastName: 'Mai', number: '3' }, { slot: 'Trimmer1', firstName: 'D', lastName: 'Tr2', number: '4' },
      { slot: 'Trimmer', firstName: 'E', lastName: 'Tr1', number: '5' }, { slot: 'Grinder', firstName: 'F', lastName: 'Gri', number: '6' },
      { slot: 'Bow', firstName: 'G', lastName: 'Bow', number: '7' },
    ] });
    const v = fakeVmix(TITLES);
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    await show.run('show:lineup5');
    // eight sailors: 4 + 4, bow first, each four on the centred places 6-9 (1-5 empty)
    const name = (n: number, val: string) => `?Function=SetText&Input=k9&SelectedName=NAME ${n}.Text&Value=${val}`;
    expect(v.calls).toContain(name(6, 'G. BOW'));
    expect(v.calls).toContain(name(8, 'F. GRI'));
    expect(v.calls).toContain(name(9, 'E. TR1'));
    expect(v.calls).toContain(name(1, ''));
    expect(v.calls).toContain('?Function=SetText&Input=k9&SelectedName=POSITION 6.Text&Value=7 | BOW');
    expect(v.overlays[1]).toBe('9');
    v.calls.length = 0;
    await show.run('lultswap');
    // the four toward the stern on 6-9, no overlay change
    expect(v.calls).toContain(name(6, 'D. TR2'));
    expect(v.calls).toContain(name(7, 'C. MAI'));
    expect(v.calls).toContain(name(8, 'B. HEL'));
    expect(v.calls).toContain(name(9, 'A. TAC'));
    expect(v.calls.some((c) => c.includes('Overlay'))).toBe(false);
    v.calls.length = 0;
    await show.run('lultswap');
    expect(v.calls).toContain(name(6, 'G. BOW'));
    await show.run(`lult:${show.boat(show.state.boat).code}`);
    expect(v.overlays[1]).toBe('');
    await expect(show.run('lultswap')).rejects.toThrow(/LINEUP LT/);

    // the bar: the team's lowerthird PNG, as on every other lower third
    const code = show.boat(2).code;
    const dir = path.join(s.ctx.assetsDir, 'PNG generator', code);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${code}_lowerthird.png`), encodePng(4, 1, () => [0, 0, 0, 255]));
    fs.writeFileSync(path.join(dir, `${code}_qualified_bar.png`), encodePng(4, 1, () => [0, 0, 0, 255]));
    await show.run('qualified:2');
    expect(v.calls).toContain('?Function=SetText&Input=k10&SelectedName=Bottom text.Text&Value=QUALIFIED FOR THE FINAL SERIES');
    expect(v.calls.find((c) => c.includes('SelectedName=Bar.Source'))).toMatch(new RegExp(`${code}_lowerthird\\.png$`));
    // the sponsor tab, as on the team lower third with no photo
    expect(v.calls.find((c) => c.includes('Input=k10&SelectedName=Sponsor.Source'))).toMatch(/lt_sponsor\w*\.png$/);
    expect(v.overlays[1]).toBe('10');
  });

  it('clean break on a vMix Mix: started in vMix with its first board, only channel 6 of Mix 2 (Mix=1) switches; UNDO and ALL OUT leave it', async () => {
    const { s } = race();
    setShowConfig(s.db, { breakMix: 2, rotateSeconds: 30, breakOutMs: 0 });
    const v = fakeVmix({ ...TITLES, ssl_lbar: ['TITLE.Text', 'Ticker1.Text'], 'ssl_schedule 2': [], 'ssl_lbar 2': [], 'ssl_results_group_4 2': [] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    const ov = () => v.calls.filter((c) => c.startsWith('?Function=OverlayInput'));
    // the Companion key put ssl_lbar 2 and ssl_schedule 2 in: nothing is sent, the L-bar channel is never touched
    await show.mixLoop(100_000);
    await show.mixLoop(110_000);
    expect(ov()).toEqual([]);
    expect(show.mixStatus.board).toBe('ssl_schedule 2');
    // every switch time: out with its animation, the next copy in (counted from 0: Mix=1 is Mix 2)
    await show.mixLoop(131_000);
    expect(ov()).toEqual(['?Function=OverlayInput6Out&Mix=1', `?Function=OverlayInput6In&Input=k${v.num('ssl_results_group_4 2')}&Mix=1`]);
    await show.mixLoop(162_000);
    expect(ov().at(-1)).toBe(`?Function=OverlayInput6In&Input=k${v.num('ssl_schedule 2')}&Mix=1`);
    expect(v.calls.some((c) => c.includes(`Input=k${v.num('ssl_ticker')}&`) || /OverlayInput5/.test(c))).toBe(false);
    // UNDO and ALL OUT leave the Mix channels alone
    v.calls.length = 0;
    await show.allOut();
    expect(v.calls.some((c) => /OverlayInput[56]/.test(c))).toBe(false);
    // Mix 1 would be the program: off
    setShowConfig(s.db, { breakMix: 1 });
    v.calls.length = 0;
    await show.mixLoop(300_000);
    expect(ov()).toEqual([]);
  });

  it('clean break on a vMix Mix: a board with no copy named 2 is left out and listed; counted from 1 when unticked', async () => {
    const { s } = race();
    setShowConfig(s.db, { breakMix: 2, rotateSeconds: 30, breakOutMs: 0, mixZeroBased: false });
    const v = fakeVmix({ ...TITLES, 'ssl_schedule 2': [], 'ssl_results_group_4 2': [] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    await show.mixNext();
    expect(v.calls.filter((c) => c.startsWith('?Function=OverlayInput')).at(-1)).toBe(`?Function=OverlayInput6In&Input=k${v.num('ssl_results_group_4 2')}&Mix=2`);
    const w = fakeVmix({ ...TITLES, 'ssl_schedule 2': [] });
    const show2 = new Show(s.ctx, new LowerThirds(s.ctx, w.fetcher), w.fetcher);
    await show2.mixLoop(100_000);
    expect(show2.mixStatus.missing).toContain('ssl_results_group_4 2');
  });

  it('the bottom ticker source for the translated tickers: the messages of the version on air, else one loop of the text typed in vMix', async () => {
    const { s } = race();
    seedGraphicSets(s.db, activeEvent(s.db).id);
    const v = fakeVmix({ ...TITLES, ssl_ticker: ['Ticker1.Text'] });
    v.vals.set(`${v.num('ssl_ticker')}|Ticker1.Text`, repeatLoop('TYPED IN VMIX I '));
    expect(await new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher).tickerSource()).toEqual({ messages: ['TYPED IN VMIX I'], sep: ' ' });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    await show.run('ticker:thanks');
    show.invalidate();
    const src = await show.tickerSource();
    expect(src?.messages).toHaveLength(1);
    expect(src?.messages[0]).toMatch(/^THANKS FOR WATCHING/);
    expect(src?.sep).toBe(' I ');
  });

  it('the Mix loop: MIX LOOP off only stops the switching; on again it switches at once; MIX NEXT by hand at any time', async () => {
    const { s } = race();
    setShowConfig(s.db, { breakMix: 2, rotateSeconds: 30, breakOutMs: 0 });
    const v = fakeVmix({ ...TITLES, ssl_lbar: ['TITLE.Text'], 'ssl_lbar 2': [], 'ssl_schedule 2': [], 'ssl_results_group_4 2': [] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    const ov = () => v.calls.filter((c) => c.startsWith('?Function=OverlayInput'));
    const out = '?Function=OverlayInput6Out&Mix=1';
    const sched = `?Function=OverlayInput6In&Input=k${v.num('ssl_schedule 2')}&Mix=1`;
    const res = `?Function=OverlayInput6In&Input=k${v.num('ssl_results_group_4 2')}&Mix=1`;
    await show.mixLoop(100_000);
    // off: nothing goes out, nothing switches
    expect(await show.run('mixloop')).toEqual({ mixLoop: false });
    await show.mixLoop(200_000);
    await show.mixLoop(300_000);
    expect(ov()).toEqual([]);
    expect(show.keyAt(2, 1, 4)?.action).toBe('mixloop');
    expect(show.keyAt(2, 0, 7)?.action).toBe('show:tickertop');
    // MIX NEXT by hand while it is off, again and again
    await show.run('mixnext');
    expect(ov()).toEqual([out, res]);
    await show.run('mixnext');
    expect(ov()).toEqual([out, res, out, sched]);
    await show.mixLoop(400_000);
    expect(ov()).toHaveLength(4);
    // on again (the key, or many times): the next board at once, then every switch time
    v.calls.length = 0;
    expect(await show.run('mixloop')).toEqual({ mixLoop: true });
    await show.mixLoop(600_000);
    expect(ov()).toEqual([out, res]);
    await show.mixLoop(610_000);
    expect(ov()).toHaveLength(2);
    await show.mixLoop(631_000);
    expect(ov().at(-1)).toBe(sched);
    expect(await show.run('mixloop')).toEqual({ mixLoop: false });
    expect(await show.run('mixloop')).toEqual({ mixLoop: true });
    v.calls.length = 0;
    await show.mixLoop(632_000);
    expect(ov()).toEqual([out, res]);
    // without the day schedule: the group results only
    setShowConfig(s.db, { mixSchedule: false });
    v.calls.length = 0;
    await show.mixNext();
    await show.mixNext();
    expect(ov().every((c) => c === out || c === res)).toBe(true);
  });

  it('the Mix loop never sticks: a vMix that refuses the out on a Mix still gets the next board, and an error keeps the board on the channel', async () => {
    const { s } = race();
    setShowConfig(s.db, { breakMix: 2, rotateSeconds: 30, breakOutMs: 0 });
    const v = fakeVmix({ ...TITLES, 'ssl_schedule 2': [], 'ssl_results_group_4 2': [] });
    let refuse = true; let down = false;
    const fetcher = async (url: string, init?: any) => {
      if (down && url.includes('Function=')) throw new Error('timeout');
      if (refuse && /OverlayInput6Out/.test(url)) { v.calls.push(decodeURIComponent(url.split('/api/')[1])); return { ok: false, status: 500, text: async () => 'Error' }; }
      return v.fetcher(url);
    };
    const show = new Show(s.ctx, new LowerThirds(s.ctx, fetcher as any), fetcher as any);
    const ins = () => v.calls.filter((c) => /OverlayInput6In/.test(c));
    await show.mixLoop(100_000);
    await show.mixLoop(131_000);
    await show.mixLoop(162_000);
    expect(ins().map((c) => c.match(/Input=k(\d+)/)?.[1])).toEqual([v.num('ssl_results_group_4 2'), v.num('ssl_schedule 2')]);
    expect(show.mixStatus.error).toMatch(/out was not taken/);
    expect(show.mixStatus.log?.[0].q).toMatch(/OverlayInput6In/);
    // vMix gone for a round: the board on the channel is kept, the same next board comes the round after
    down = true; refuse = false;
    await show.mixLoop(193_000);
    down = false;
    await show.mixLoop(224_000);
    expect(ins().at(-1)).toContain(`Input=k${v.num('ssl_results_group_4 2')}`);
    // one board only: said why nothing switches
    const w = fakeVmix({ ...TITLES, 'ssl_schedule 2': [] });
    const one = new Show(s.ctx, new LowerThirds(s.ctx, w.fetcher), w.fetcher);
    await one.mixNext();
    expect(one.mixStatus.error).toMatch(/Only one board/);
  });

  it('the Mix loop with no group racing picked: the current stage groups, else every results copy named 2 in vMix', async () => {
    const { s } = race();
    setShowConfig(s.db, { breakMix: 2, rotateSeconds: 30, breakOutMs: 0, fleetId: '' });
    const v = fakeVmix({ ...TITLES, 'ssl_schedule 2': [], 'ssl_results_B 2': [], 'ssl_results_A 2': [] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    await show.mixLoop(100_000);
    expect(show.mixStatus.boards).toEqual(['ssl_schedule 2', 'ssl_results_A 2', 'ssl_results_B 2']);
    expect(show.mixStatus.error).toBe('');
    await show.mixNext();
    expect(v.calls.at(-1)).toBe(`?Function=OverlayInput6In&Input=k${v.num('ssl_results_A 2')}&Mix=1`);
  });

  it('CB VELA: the film from its start on channel 7, again = out', async () => {
    const { s } = race();
    const v = fakeVmix({ ...TITLES, CBVela: [] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    expect(show.keyAt(1, 1, 0)?.action).toBe('show:cbvela');
    await show.run('show:cbvela');
    const n = v.num('CBVela');
    expect(v.calls).toEqual(expect.arrayContaining([`?Function=Restart&Input=k${n}`, `?Function=OverlayInput7In&Input=k${n}`, `?Function=Play&Input=k${n}`]));
    expect(v.overlays[7]).toBe(n);
    show.invalidate();
    await show.run('show:cbvela');
    expect(v.overlays[7]).toBe('');
  });

  it('saving one setting of Show control leaves every other one as it was', async () => {
    const { s } = race();
    setShowConfig(s.db, { breakMix: 2, rotateSeconds: 45, mixLoopOn: true });
    const lt = new LowerThirds(s.ctx);
    const app = await buildApp({ db: s.db, assetsDir: s.ctx.assetsDir, lowerThirds: lt, show: new Show(s.ctx, lt) } as any);
    await app.inject({ method: 'PUT', url: '/api/show/config', payload: { championsText: 'x' } });
    const c = getShowConfig(s.db);
    expect([c.breakMix, c.rotateSeconds, c.mixLoopOn, c.championsText]).toEqual([2, 45, true, 'x']);
    await app.close();
  });

  it('cuts everything only on the second PANIC press and rotates the break scene', async () => {
    const { s } = race();
    const v = fakeVmix(TITLES);
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    await show.run('show:welcome');
    expect(await show.run('panic')).toEqual({ armed: true });
    expect(v.overlays[1]).toBe('1');
    await show.run('panic');
    expect(v.overlays[1]).toBe('');

    await show.run('show:break');
    // the day schedule on channel 4 (no input of the scene's own)
    expect(v.overlays[4]).toBe('2');
    show.stopRotation();
    v.calls.length = 0;
    setShowConfig(s.db, { breakOutMs: 0 });
    // an old saved 12 s switch time becomes 30 s
    expect(getShowConfig(s.db).rotateSeconds).toBe(30);
    await show.run('nextslide');
    // on air: the schedule goes out on channel 4 (its out animation), the results get their data and come in
    expect(v.calls[0]).toBe('?Function=OverlayInput4Out');
    expect(v.calls.at(-1)).toBe('?Function=OverlayInput4In&Input=k3');
    expect(v.overlays[4]).toBe('3');
    // the next group's results on the same title: the data sync follows the group on the board, not the one picked at the top
    await show.syncData();
    const groupA = v.vals.get('3|TEAM 1.Text') ?? '';
    await show.run('nextslide');
    expect(show.state.slide).toBe(2);
    await show.syncData();
    const groupB = v.vals.get('3|TEAM 1.Text') ?? '';
    expect(groupA).toContain('ESP');
    expect(groupB).not.toContain('ESP');
    await show.run('tickermode');
    expect(show.state.tickerMode).toBe('end');
  });

  it('break scene: L-bar on channel 2, the ticker on 3, schedule / results on 4; tickers and boards switch with their animations; auto switch on and off', async () => {
    const { s } = race();
    seedGraphicSets(s.db, activeEvent(s.db).id);
    // the L-bar loaded under its file name (L-bars.gtzip) is found too
    const v = fakeVmix({ ...TITLES, 'L-bars.gtzip': ['TITLE.Text', 'Ticker1.Text'], ssl_ticker: ['Ticker1.Text'] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    const k = (n: string) => `k${v.num(n)}`;
    // an old saved layer 1 for the L-bar becomes channel 2
    setSetting(s.db, 'show.config', JSON.stringify({ ...JSON.parse(JSON.stringify(getShowConfig(s.db))), breakLbarLayer: 1, cfgVersion: 2 }));
    expect(getShowConfig(s.db).breakLbarLayer).toBe(2);
    // the L-bar on air on its own first: it leaves channel 1 at once, then comes in on channel 2 with its in animation
    await show.run('show:lbar');
    expect(v.overlays[1]).toBe(v.num('L-bars.gtzip'));
    await show.run('show:break');
    expect(v.calls).toContain('?Function=OverlayInput1Off');
    expect(v.overlays[1] ?? '').toBe('');
    expect(v.overlays[2]).toBe(v.num('L-bars.gtzip'));
    expect(v.overlays[3]).toBe(v.num('ssl_ticker'));
    expect(v.overlays[4]).toBe(v.num('ssl_schedule'));
    expect(v.calls.some((c) => c.includes('SetMultiViewOverlay'))).toBe(false);
    expect(show.state.rotating).toBe(true);
    // a ticker key while the scene is on air: the ticker goes out on channel 3, takes the text and comes back
    setShowConfig(s.db, { breakOutMs: 0 });
    v.calls.length = 0;
    const r = await show.run('ticker:5'); // Top ticker (the four fixed ones first)
    expect(r).toMatchObject({ in: 'ticker', scene: true });
    expect(v.calls[0]).toBe('?Function=OverlayInput3Out');
    expect(v.calls.some((c) => c.startsWith(`?Function=SetText&Input=${k('ssl_ticker')}`))).toBe(true);
    expect(v.calls.at(-1)).toBe(`?Function=OverlayInput3In&Input=${k('ssl_ticker')}`);
    expect(v.overlays[1] ?? '').toBe('');
    // the AFTER / BREAK page: a key per ticker; the second ticker's key puts it on the scene the same way
    const page = show.pages().find((p) => p.name === 'C-E AFTER / BREAK')!;
    expect(page.keys[2].map((x) => x?.action)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `breakticker:${n}`));
    v.calls.length = 0;
    const second = show.tickers()[1];
    const nt = await show.run('breakticker:2');
    expect(show.state.tickerId).toBe(second.id);
    expect(nt).toMatchObject({ ticker: second.name, onAir: true });
    expect(v.calls[0]).toBe('?Function=OverlayInput3Out');
    expect(v.calls.at(-1)).toBe(`?Function=OverlayInput3In&Input=${k('ssl_ticker')}`);
    // AUTO SWITCH off: stops now and stays off for the next break
    expect(await show.run('rotate')).toMatchObject({ auto: false, rotating: false });
    await show.run('breakout');
    expect([v.overlays[2], v.overlays[3], v.overlays[4]].map((x) => x ?? '')).toEqual(['', '', '']);
    await show.run('show:break');
    expect(show.state.rotating).toBe(false);
    expect(await show.run('rotate')).toMatchObject({ auto: true, rotating: true });
    // BREAK SCENE again: all three go out
    expect(await show.run('show:break')).toMatchObject({ out: 'break' });
    expect(show.state.rotating).toBe(false);
  });

  it('the break scene shows the groups picked on Show control, else every group but the Last Chance Race', () => {
    const { s, f1, f2 } = race();
    const show = new Show(s.ctx, new LowerThirds(s.ctx));
    expect(show.breakFleets()).toEqual([f1.id, f2.id]);
    renameFleet(s.db, f2.id, 'Last Chance Race');
    expect(show.breakFleets()).toEqual([f1.id]);
    expect(show.slides().map((x) => x.kind)).toEqual(['schedule', 'results']);
    // groups picked on Show control: only those (the Last Chance Race too, when picked)
    setShowConfig(s.db, { breakFleets: [f2.id] });
    expect(show.breakFleets()).toEqual([f2.id]);
    expect(show.breakStageFleets().map((f) => f.id)).toEqual([f1.id, f2.id]);
  });

  it('builds one Companion preset: every page, a page per team with its sailors, the fallback straight to vMix', async () => {
    const { s } = race();
    const show = new Show(s.ctx, new LowerThirds(s.ctx));
    const f: any = await show.companionPreset('http://10.0.0.5:4310', 'http://10.0.0.5:8088');
    expect(f).toMatchObject({ version: 12, type: 'full' });
    // deck 1: 1–2, deck 2: 3–6, fallback 8, teams (by code) 9–12; 16 team pages kept, so COMPARE 25 and PEOPLE 26
    expect(Object.keys(f.pages).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 25, 26]);
    const url = (c: any) => c.steps[0].action_sets.down[0].options.url.value;
    const text = (c: any) => c.style.layers.find((l: any) => l.type === 'text').text.value;
    const page = (c: any) => c.steps[0].action_sets.down[0].options.page.value;
    // every key but navigation calls its place: the dashboard runs what the key has there now
    expect(url(f.pages[1].controls[0][0])).toBe('http://10.0.0.5:4310/api/show/key/1/0/0');
    expect(f.pages[1].controls[3][0].steps[0].action_sets.down[0]).toMatchObject({ definitionId: 'set_page', connectionId: 'internal', options: { surfaceId: { value: 'self' }, page: { value: 2 } } });
    // TEAMS: a key per team opens its page; ESP is the second by code
    expect(f.pages[3].name).toBe('SSL TEAMS');
    expect(text(f.pages[3].controls[0][1])).toBe('ESP\\nTEAM ESP');
    expect(page(f.pages[3].controls[0][1])).toBe(10);
    // ESP's page: its places with the names fixed on the keys, each calling that place of that team
    const esp = f.pages[10];
    expect(esp.name).toBe('SSL ESP');
    expect(text(esp.controls[1][0])).toBe('BOW\\nPONS');
    expect(text(esp.controls[1][2])).toBe('PIT\\n#12 RUIZ');
    expect(url(esp.controls[1][2])).toBe('http://10.0.0.5:4310/api/show/key/10/1/2');
    expect(show.keyAt(10, 1, 2)?.action).toBe('sailorof:ESP/Pit');
    expect(show.keyAt(10, 0, 0)?.action).toBe('qualified:ESP');
    // TEAMS holds 16 teams on its top two rows; free places are blank keys calling their place (for a team later)
    expect(Object.values(f.pages[3].controls[1]).map(text)).toEqual(Array(8).fill(''));
    expect(url(f.pages[3].controls[1][3])).toBe('http://10.0.0.5:4310/api/show/key/3/1/3');
    // the team lower thirds sit on the team's own page, none on TEAMS
    expect(show.pages().find((p) => p.name === 'TEAMS')!.keys.flat().some((k) => /teamlt/.test(k?.action ?? ''))).toBe(false);
    expect(show.keyAt(10, 0, 4)?.action).toBe('teamlt:ESP');
    expect(text(esp.controls[0][4])).toBe('TEAM LT\\nESP');
    // a team page goes HOME, then straight to the other teams of its group
    expect([0, 1, 2, 3].map((c) => page(esp.controls[3][c]))).toEqual([3, 9, 11, 12]);
    expect([0, 1, 2, 3].map((c) => page(f.pages[12].controls[3][c]))).toEqual([3, 9, 10, 11]);
    // the other pages go straight to each other page of their deck, FALLBACK last
    const go = (c: any) => c?.steps?.[0]?.action_sets?.down?.[0]?.options?.page?.value ?? null;
    expect([0, 1, 2].map((c) => go(f.pages[1].controls[3][c]))).toEqual([2, 25, null]);
    expect([0, 1, 2].map((c) => go(f.pages[2].controls[3][c]))).toEqual([1, 25, null]);
    expect([0, 1, 2, 3, 4].map((c) => go(f.pages[3].controls[3][c]))).toEqual([4, 5, 6, 26, null]);
    expect([0, 1, 2, 3, 4].map((c) => go(f.pages[5].controls[3][c]))).toEqual([3, 4, 6, 26, null]);
    expect(page(f.pages[1].controls[3][5])).toBe(8);
    expect(url(f.pages[8].controls[0][0])).toBe('http://10.0.0.5:8088/api/?Function=OverlayInput1&Input=ssl_welcome');
    // every page keeps the safety row in the same place
    for (const p of show.pages()) expect(p.keys[3].slice(6).map((k) => k?.action ?? null)).toEqual(['allout', null]);
    // no PANIC key: the downstream key in its place on every page
    expect(JSON.stringify(f)).not.toMatch(/a=panic|PANIC/);
    for (const pg of Object.values(f.pages) as any[]) expect(JSON.stringify(pg.controls[3]?.[7] ?? {})).toMatch(/"definitionId":"dsk/);
    // TITLES on AFTER / BREAK: Rolling_Titles on overlay channel 8
    expect(show.pages().find((p) => /AFTER/.test(p.name))!.keys.flat().some((k) => k?.action === 'show:titles')).toBe(true);
    // no UNDO key anywhere; the ATEM downstream key (from the PEOPLE page) on every page, in a free place
    const all = Object.values(f.pages).map((pg: any) => Object.values(pg.controls).flatMap((r: any) => Object.values(r)));
    expect(all.flat().some((c: any) => /a=undo/.test(JSON.stringify(c)))).toBe(false);
    for (const cs of all) expect(cs.filter((c: any) => c.steps?.[0]?.action_sets?.down?.[0]?.definitionId === 'dskAuto')).toHaveLength(1);
    expect(f.pages[1].controls[3][7].steps[0].action_sets.down[0].definitionId).toBe('dskAuto');
    expect(f.pages[8].controls[3][7].steps[0].action_sets.down[0].definitionId).toBe('dskAuto');
    // every downstream key reads DSK, and Show control knows where it is on each page
    const dskText = (c: any) => c.style.layers.find((l: any) => l.type === 'text').text.value;
    for (const cs of all) expect(cs.filter((c: any) => c.steps?.[0]?.action_sets?.down?.[0]?.definitionId === 'dskAuto').map(dskText)).toEqual(['DSK']);
    const view = await show.view();
    for (const p of view.pages) { expect(p.dsk).toBeTruthy(); expect(f.pages[p.page].controls[p.dsk![0]][p.dsk![1]].steps[0].action_sets.down[0].definitionId).toBe('dskAuto'); }
    expect(view.pages.find((p) => p.page === 1)?.dsk).toEqual([3, 7]);
    // no OUT key; PHOTO mode on every team page and on PEOPLE, SOCIALS on BEFORE and AFTER
    expect(show.pages().some((p) => p.keys.flat().some((k) => k?.action === 'out'))).toBe(false);
    expect(show.pages().filter((p) => p.keys[3][4]?.action === 'photo').map((p) => p.name)).toEqual(['BRA', 'ESP', 'GBR', 'ITA', 'PEOPLE']);
    expect(show.pages().filter((p) => p.keys.flat().some((k) => k?.action === 'show:socials')).map((p) => p.name)).toEqual(['A BEFORE', 'C-E AFTER / BREAK']);
    expect(show.pages().some((p) => p.name === 'EXTRAS')).toBe(false);
    // each action on one key only (navigation and the bottom row aside), no anthem keys
    const acts = show.pages().flatMap((p) => p.keys.slice(0, 3).flat()).filter((k) => k && !k.action.startsWith('nav:') && k.action !== 'next' && k.action !== 'lultswap' && k.action !== 'show:socials').map((k) => k!.action);
    expect(acts.filter((a, i) => acts.indexOf(a) !== i)).toEqual([]);
    expect(acts.some((a) => a.startsWith('anthem'))).toBe(false);
  });

  it('L-BAR RANKING: its own key for ssl_bar_2, never in the break scene; team keys in the shirt colours', async () => {
    const { s } = race();
    seedGraphicSets(s.db, activeEvent(s.db).id);
    const v = fakeVmix({ ...TITLES, ssl_lbar: ['TITLE.Text'], ssl_bar_2: ['TITLE.Text'], ssl_ticker: ['Ticker1.Text'] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    const page = show.pages().find((p) => p.name === 'C-E AFTER / BREAK')!;
    expect(page.keys[0].slice(0, 4).map((x) => x?.action)).toEqual(['show:socials', 'show:lbar', 'show:lbar2', 'show:sponsors']);
    expect(page.keys.flat().some((x) => x?.action === 'show:results')).toBe(false);
    await show.run('show:lbar2');
    expect(v.overlays[1]).toBe(v.num('ssl_bar_2'));
    await show.run('show:lbar2');
    setShowConfig(s.db, { breakOutMs: 0 });
    await show.run('show:break');
    expect(Object.values(v.overlays)).not.toContain(v.num('ssl_bar_2'));
    expect(v.overlays[2]).toBe(v.num('ssl_lbar'));
    await show.run('show:break');
    expect(teamKeyColours(null, 'URU')!.normal).toEqual({ bg: '#4aa8e0', fg: '#ffffff' });
    expect(teamKeyColours(null, 'COL')!.normal).toEqual({ bg: '#2c4a9a', fg: '#fdd116' });
    expect(teamKeyColours(null, 'KOR')!.normal).toEqual({ bg: '#ffffff', fg: '#cd2e3a' });
    expect(teamKeyColours(null, 'PUR')!.normal).toEqual({ bg: '#ffffff', fg: '#1d4fa3' });
    // the second 1/32 Finals squads after their shirts
    expect(teamKeyColours(null, 'ECU')!.normal).toEqual({ bg: '#ffd100', fg: '#0b2a5b' });
    expect(teamKeyColours(null, 'HUN')!.normal).toEqual({ bg: '#ffffff', fg: '#ce2939' });
    expect(teamKeyColours(null, 'PER')!.normal).toEqual({ bg: '#ffffff', fg: '#d91023' });
    expect(teamKeyColours(null, 'CZE')!.normal).toEqual({ bg: '#d7141a', fg: '#ffffff' });
    expect(teamKeyColours(null, 'ANT')!.normal).toEqual({ bg: '#000000', fg: '#ffe95c' });
    expect(teamKeyColours(null, 'CUB')!.normal).toEqual({ bg: '#e03a3e', fg: '#0a2a8c' });
  });

  it('no LAST CHANCE EXPLAINED key any more; a config that had one still loads', async () => {
    const { s } = race();
    setSetting(s.db, 'show.config', JSON.stringify({ ...getShowConfig(s.db), inputs: { lcrinfo: 'ssl_lcr_info' }, keys: { 'A BEFORE/1/0': { action: 'show:lcrinfo', text: 'LCR' }, 'C-E AFTER / BREAK/0/0': { action: 'show:lcrinfo' } } }));
    const show = new Show(s.ctx, new LowerThirds(s.ctx));
    expect(show.graphics().some((g) => g.id === 'lcrinfo')).toBe(false);
    const all = show.pages().flatMap((p) => p.keys.flat());
    expect(all.some((x) => x?.action === 'show:lcrinfo')).toBe(false);
    expect(show.keyAt(1, 1, 0)?.action).toBe('show:cbvela'); // the built-in key of that place (CB VELA)
    expect(show.keyAt(2, 0, 0)?.action).toBe('show:socials');
  });

  it('TICKER ON / OFF and TOP TICKER ON / OFF: each ticker on its own channel, without the break scene', async () => {
    const { s, ev } = race();
    seedGraphicSets(s.db, ev);
    const v = fakeVmix({ ...TITLES, ssl_ticker: ['Ticker1.Text'], ssl_ticker_top: ['Ticker1.Text'] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    const after = show.pages().find((p) => p.name === 'C-E AFTER / BREAK')!;
    expect(after.keys[0].slice(6, 8).map((x) => x?.action)).toEqual(['show:ticker', 'show:tickertop']); // top right of AFTER / BREAK
    // the bottom ticker on its own on channel 1 (channels 3 and 4 serve only with the L-bar)
    await show.run('show:ticker');
    expect(v.overlays[1]).toBe(v.num('ssl_ticker'));
    expect(v.overlays[3] ?? '').toBe('');
    // the top ticker: its first version (General graphics → Top ticker) on channel 2
    await show.run('show:tickertop');
    expect(v.overlays[2]).toBe(v.num('ssl_ticker_top'));
    expect(v.calls).toContain(`?Function=SetText&Input=k${v.num('ssl_ticker_top')}&SelectedName=Ticker1.Text&Value=${repeatLoop('SSL GOLD CUP 2026 I ')}`);
    expect(v.overlays[1]).toBe(v.num('ssl_ticker'));
    // a top ticker version on its key (TICKERS, bottom row): a new one is on the next key at once
    createGraphicSet(s.db, ev, 'tickertop', 'Breaking', { items: 'Live now' });
    show.invalidate();
    const tickers = (await show.view()).pages.find((p) => p.name === 'TICKERS')!;
    expect(tickers.keys[2].slice(0, 2).map((x) => x?.text)).toEqual(['● TOP TICKER\\nTOP TICKER', 'TOP TICKER\\nBREAKING']);
    v.calls.length = 0;
    await show.run('tickertop:2');
    expect(v.calls).toContain(`?Function=SetText&Input=k${v.num('ssl_ticker_top')}&SelectedName=Ticker1.Text&Value=${repeatLoop('LIVE NOW I ')}`);
    expect(v.overlays[2]).toBe(v.num('ssl_ticker_top'));
    await show.run('tickertop:2');
    expect(v.overlays[2] ?? '').toBe('');
    await show.run('show:ticker');
    expect(v.overlays[1] ?? '').toBe('');
    // the top ticker's channel is set on Show control
    setShowConfig(s.db, { tickerTopLayer: 4 });
    await show.run('show:tickertop');
    expect(v.overlays[4]).toBe(v.num('ssl_ticker_top'));
  });

  it("keeps the producer's PEOPLE page from Companion as it is in every preset", async () => {
    const { s } = race();
    const show = new Show(s.ctx, new LowerThirds(s.ctx));
    const people = show.pages().find((p) => p.name === 'PEOPLE')!;
    // the dashboard keys of that page show on Show control; the person keys it took away stay away
    expect(people.keys[0].slice(0, 3).map((x) => x?.action)).toEqual(['person:1', 'person:2', 'person:3']);
    expect(people.keys[0][3]).toBeNull();
    expect(people.keys[1].every((x) => x === null)).toBe(true);
    const f: any = await show.companionPreset('http://10.0.0.5:4310', 'http://10.0.0.5:8088');
    const pg = f.pages[people.page];
    expect(pg.name).toBe('SSL PEOPLE');
    const act = (r: number, c: number) => pg.controls[r][c].steps[0].action_sets.down[0];
    expect(act(0, 0)).toMatchObject({ definitionId: 'get', connectionId: 'ssl_dashboard_show', options: { url: { value: `http://10.0.0.5:4310/api/show/key/${people.page}/0/0` } } });
    expect(show.keyAt(people.page, 0, 0)?.action).toBe('person:1');
    // the vMix and ATEM keys exactly as they were, with their connections in the file (matched by name on import)
    expect(act(1, 0)).toMatchObject({ definitionId: 'overlayFunctions', options: { input: { value: '15' } } });
    expect(act(3, 7)).toMatchObject({ definitionId: 'dskAuto' });
    expect(f.instances[act(1, 0).connectionId]).toMatchObject({ moduleId: 'studiocoast-vmix', label: 'vmix_stream1' });
    expect(f.instances[act(3, 7).connectionId]).toMatchObject({ moduleId: 'bmd-atem', label: 'atem' });
    expect(Object.values(f.instances).filter((x: any) => x.moduleId === 'generic-http')).toHaveLength(1);
    // a free place: a blank key calling its place
    expect(pg.controls[0][3].style.layers.find((l: any) => l.type === 'text').text.value).toBe('');
    expect(act(0, 3).options.url.value).toBe(`http://10.0.0.5:4310/api/show/key/${people.page}/0/3`);
  });

  it('the preset has pages only for the teams of the stage picked at the top, in group order', () => {
    const { s, ev } = race();
    seedTeam(s.db, 'USA', []); // not in the stage
    const show = new Show(s.ctx, new LowerThirds(s.ctx));
    expect(show.presetTeams().map((t) => t.code)).toEqual(['BRA', 'ESP', 'GBR', 'ITA', 'USA']); // no stage picked: every team
    const stage = s.db.prepare('SELECT id FROM fleet_sets LIMIT 1').get() as { id: string };
    setCurrentStage(s.db, ev, stage.id);
    show.invalidate();
    expect(show.presetTeams().map((t) => t.code)).toEqual(['ESP', 'BRA', 'GBR', 'ITA', '', '', '', '']);
    expect(show.pages().filter((p) => p.page >= 9).map((p) => p.name)).toEqual(['ESP', 'BRA', 'GBR', 'ITA', 'FLEET2 1', 'FLEET2 2', 'FLEET2 3', 'FLEET2 4', 'RESULTS/COMPARE', 'PEOPLE']);
  });

  it('the next stages: 4 groups of 4 places in group order, empty places keep their pages and become the team once filled', async () => {
    const { s, ev } = race();
    const extra = ['POL', 'GER', 'FRA'].map((c) => seedTeam(s.db, c, []).teamId);
    const stage = createSet(s.db, ev, '1/32', 0);
    const groups = ['A', 'B', 'C', 'D'].map((l) => createFleet(s.db, stage, `Group ${l}`, 4));
    setCurrentStage(s.db, ev, stage);
    placeTeam(s.db, stage, { teamId: extra[0], fleetId: groups[0], position: 2 });
    placeTeam(s.db, stage, { teamId: extra[1], fleetId: groups[2], position: 1 });
    const show = new Show(s.ctx, new LowerThirds(s.ctx));
    const pages = show.pages();
    const teamPages = pages.filter((p) => p.page >= 9 && p.page <= 24);
    expect(teamPages.map((p) => p.name)).toEqual(['A1', 'POL', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4', 'GER', 'C2', 'C3', 'C4', 'D1', 'D2', 'D3', 'D4']);
    expect(teamPages.map((p) => p.page)).toEqual(Array.from({ length: 16 }, (_, i) => 9 + i));
    expect(pages.find((p) => p.name === 'RESULTS/COMPARE')!.page).toBe(25);
    expect(pages.find((p) => p.name === 'PEOPLE')!.page).toBe(26);
    // TEAMS: A and B on the top row, C and D below, each key opening its place's page
    const teams = pages.find((p) => p.name === 'TEAMS')!;
    expect(teams.keys[0].map((x) => x?.text.split('\\n')[0])).toEqual(['A1', 'POL', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4']);
    expect(teams.keys[2].map((x) => x?.action)).toEqual([17, 18, 19, 20, 21, 22, 23, 24].map((n) => `nav:${n}`));
    expect(teams.keys[1].every((x) => x === null)).toBe(true);
    // an empty place: its keys are there, dark, and a press says the place has no team yet
    expect(show.keyAt(9, 0, 4)?.action).toBe('teamlt:@A1');
    expect((await show.keyLook(show.keyAt(9, 0, 4)!)).empty).toBe(true);
    await expect(show.run('teamlt:@A1')).rejects.toThrow(/No team on place A1/);
    expect(show.keyAt(10, 0, 4)?.action).toBe('teamlt:POL');
    // the team put there: the same page and keys, now the team's (texts reach Companion live, no new import)
    placeTeam(s.db, stage, { teamId: extra[2], fleetId: groups[0], position: 1 });
    show.invalidate();
    expect(show.keyAt(9, 0, 4)?.action).toBe('teamlt:FRA');
    expect(show.pages().find((p) => p.page === 9)!.name).toBe('FRA');
    expect(show.pages().find((p) => p.name === 'RESULTS/COMPARE')!.page).toBe(25);
  });

  it('everyone in People has a key; the COMPARE keys follow the Team comparison inputs vMix has', async () => {
    const { s, ev, f1, f2 } = race();
    createPerson(s.db, ev, { name: 'Ana Costa', role: 'Host commentator', title: 'Host' });
    createPerson(s.db, ev, { name: 'BEN', surname: 'lee', role: 'Guest', title: 'Olympic champion' });
    const [k1, k2] = [f1, f2].map((f) => groupLetter(f.name).replace(/[^A-Za-z0-9]+/g, '').toUpperCase());
    const v = fakeVmix({ ...TITLES, ssl_lt_comm_nophoto: ['Top text.Text', 'Bottom text.Text'], [`ssl_compare_${k2}`]: ['1 COUNTRY.Text'] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    const people = (await show.view()).pages.find((p) => p.name === 'PEOPLE')!;
    expect(people.keys[0].slice(0, 3).map((k) => k?.text)).toEqual(['ANA COSTA', 'BEN\\nLEE', '']);
    await show.run('person:2');
    expect(v.calls).toContain(`?Function=SetText&Input=k${v.num('ssl_lt_comm_nophoto')}&SelectedName=Top text.Text&Value=Ben LEE`);
    // every group of the stage has a COMPARE key, and a RESULTS key under it, before its input is in vMix
    const compare = show.pages().find((p) => p.name === 'RESULTS/COMPARE')!;
    expect(compare.keys[0].filter(Boolean).map((k) => k!.action)).toEqual([`compare:${k1}`, `compare:${k2}`]);
    expect(compare.keys[1].filter(Boolean).map((k) => k!.action)).toEqual([`results:${k1}`, `results:${k2}`]);
  });

  it('every group of the stage has its own Team comparison input and key', async () => {
    const { s, ev, f1, f2 } = race();
    const stage = s.db.prepare('SELECT id FROM fleet_sets LIMIT 1').get() as { id: string };
    setCurrentStage(s.db, ev, stage.id);
    const [k1, k2] = [f1, f2].map((f) => groupLetter(f.name).replace(/[^A-Za-z0-9]+/g, '').toUpperCase());
    const v = fakeVmix({ ...TITLES, [`ssl_compare_${k1}`]: ['1 COUNTRY.Text', '1 FLAG.Source'], [`ssl_compare_${k2}`]: ['1 COUNTRY.Text'] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    const page = show.pages().find((p) => p.name === 'RESULTS/COMPARE')!;
    expect(page.keys[0].slice(0, 2).map((x) => x?.action)).toEqual([`compare:${k1}`, `compare:${k2}`]);
    expect(show.pages()[0].keys[3][1]?.action).toBe(`nav:${page.page}`);
    // the group's data into its own input, then in; the same key again takes it out
    const n1 = v.num(`ssl_compare_${k1}`);
    expect(await show.run(`compare:${k1}`)).toMatchObject({ in: 'compare' });
    expect(v.calls).toContain(`?Function=SetText&Input=k${n1}&SelectedName=1 COUNTRY.Text&Value=TEAM ESP`);
    expect(v.overlays[1]).toBe(n1);
    await show.run(`compare:${k1}`);
    expect(v.overlays[1]).toBe('');
    // the data stays in step in every group's input without a key
    v.calls.length = 0;
    await show.syncData();
    expect(v.calls.some((c) => c.includes(`Input=k${v.num(`ssl_compare_${k2}`)}&SelectedName=1 COUNTRY.Text`))).toBe(true);
  });

  it('a virtual input or a second input of the same name gets the same data as the title', async () => {
    const { s } = race();
    const sched = ['DateText.Text', 'Day.Text', 'RACE 1.Text', 'POSITION 1.Text'];
    const v = fakeVmix({ ...TITLES, ssl_schedule: sched, 'ssl_schedule - Virtual': [], 'ssl_results_group_4 (2)': ['SUBTITLE.Text', 'TEAM 1.Text'], ssl_schedule_old: sched });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    await show.syncData();
    const got = (name: string, f: string) => v.vals.get(`${v.num(name)}|${f}`);
    // the virtual input lists no fields of its own: the title's go to it
    expect(got('ssl_schedule - Virtual', 'RACE 1.Text')).toBe(got('ssl_schedule', 'RACE 1.Text'));
    expect(got('ssl_schedule - Virtual', 'DateText.Text')).toMatch(/\d/);
    expect(got('ssl_results_group_4 (2)', 'TEAM 1.Text')).toBe(got('ssl_results_group_4', 'TEAM 1.Text'));
    // another name is another title
    expect(got('ssl_schedule_old', 'RACE 1.Text')).toBeUndefined();
    const mk = (title: string, number: string) => ({ key: number, number, title, fields: [] });
    const all = ['ssl_schedule', 'ssl_schedule.gtzip', 'Virtual - ssl_schedule', 'ssl_schedule 2', 'ssl_schedule (copy)', 'ssl_schedule_2', 'ssl_schedules'].map((t, i) => mk(t, String(i + 1)));
    expect(copiesOf(all[0], all).map((i) => i.title)).toEqual(['ssl_schedule.gtzip', 'Virtual - ssl_schedule', 'ssl_schedule 2', 'ssl_schedule (copy)']);
  });

  it('a key press sends only what the title does not show yet, so the graphic comes in at once', async () => {
    const { s } = race();
    const v = fakeVmix({ ...TITLES, ssl_schedule: ['DateText.Text', 'Day.Text', 'RACE 1.Text', 'RACE 2.Text', 'POSITION 1.Text'] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    await show.run('show:schedule');
    expect(v.calls.filter((c) => c.startsWith('?Function=SetText')).length).toBeGreaterThan(0);
    await show.run('show:schedule');
    v.calls.length = 0;
    await show.run('show:schedule');
    expect(v.calls).toEqual([`?Function=OverlayInput1In&Input=k${v.num('ssl_schedule')}`]);
  });

  it('TITLES brings the rolling titles in at once, held on their first frame, and plays them 3 seconds later', async () => {
    const s = setup();
    const v = fakeVmix({ Rolling_Titles: ['#Image'] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    show.titlesDelayMs = 50;
    expect(await show.toggle('titles')).toMatchObject({ in: 'titles', playInMs: 50 });
    expect(v.calls).toEqual(['?Function=Pause&Input=k1', '?Function=Restart&Input=k1', '?Function=OverlayInput8In&Input=k1', '?Function=Pause&Input=k1']);
    await new Promise((r) => setTimeout(r, 80));
    expect(v.calls.at(-1)).toBe('?Function=Play&Input=k1');
    show.invalidate();
    expect(await show.toggle('titles')).toEqual({ out: 'titles' });
    expect(v.calls.at(-1)).toBe('?Function=OverlayInput8Out');
  });

  it('a new Matchboard PNG goes again into the titles showing it (ssl_matchboard\'s image field, any field holding matchboard.png)', async () => {
    const s = setup();
    const v = fakeVmix({ ssl_matchboard: ['Board.Source'], other: ['Pic.Source', 'Logo.Source'], img: ['#Image'] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    v.vals.set('2|Pic.Source', 'D:\\SSL\\Matchboard\\matchboard.png');
    v.vals.set('2|Logo.Source', 'D:\\SSL\\logo.png');
    expect(await show.reloadMatchboard(false)).toBe(2);
    const sets = v.calls.filter((c) => c.startsWith('?Function=SetImage'));
    expect(sets.map((c) => c.split('&SelectedName=')[1].split('&')[0])).toEqual(['Board.Source', 'Pic.Source']);
    expect(sets.every((c) => /matchboard\.png$/i.test(c))).toBe(true);
  });

  it('the Last Chance Race: teams of other groups, its own results and comparison inputs (ssl_results_LCR, ssl_compare_LCR) and keys', async () => {
    const { s, ev, teams } = race();
    const stage = s.db.prepare('SELECT id FROM fleet_sets LIMIT 1').get() as { id: string };
    setCurrentStage(s.db, ev, stage.id);
    const lcr = createFleet(s.db, stage.id, 'Last Chance Race');
    placeTeam(s.db, stage.id, { teamId: teams[1], fleetId: lcr, position: 1 });
    placeTeam(s.db, stage.id, { teamId: teams[0], fleetId: lcr, position: 2 });
    const v = fakeVmix({ ...TITLES, ssl_results_LCR: ['COUNTRY1.Text', 'COUNTRY2.Text'], ssl_compare_LCR: ['1 COUNTRY.Text', '2 COUNTRY.Text'] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    await show.snapshot();
    const after = show.pages().find((p) => p.name === 'RESULTS/COMPARE')!;
    expect(after.keys[1].map((x) => x?.action)).toContain('results:LCR');
    expect(show.pages().find((p) => p.name === 'RESULTS/COMPARE')!.keys[0].map((x) => x?.action)).toContain('compare:LCR');
    await show.run('results:LCR');
    expect(v.overlays[1]).toBe(v.num('ssl_results_LCR'));
    expect(v.vals.get(`${v.num('ssl_results_LCR')}|COUNTRY1.Text`)).toBe('TEAM BRA');
    await show.run('results:LCR');
    await show.run('compare:LCR');
    expect(v.overlays[1]).toBe(v.num('ssl_compare_LCR'));
    expect(v.vals.get(`${v.num('ssl_compare_LCR')}|2 COUNTRY.Text`)).toBe('TEAM ESP');
    // ESP stays in its own group
    expect(getSetDetail(s.db, stage.id).fleets[0].positions[0]).toBe(teams[0]);
  });

  it('REFRESH PNG: every picture from the dashboard goes into vMix again (results H and I alike); the data sync does not', async () => {
    const { s, ev, f1, f2 } = race();
    const stage = s.db.prepare('SELECT id FROM fleet_sets LIMIT 1').get() as { id: string };
    setCurrentStage(s.db, ev, stage.id);
    const [k1, k2] = [f1, f2].map((f) => groupLetter(f.name).replace(/[^A-Za-z0-9]+/g, '').toUpperCase());
    const fields = ['COUNTRY1.Text', 'COUNTRY2.Text', 'bar1.Source', 'bar2.Source'];
    const v = fakeVmix({ ...TITLES, [`ssl_results_${k1}`]: fields, [`ssl_results_${k2}`]: fields });
    const dir = path.join(s.ctx.assetsDir, 'PNG generator', 'ESP');
    fs.mkdirSync(dir, { recursive: true });
    const png = path.join(dir, 'ESP_bar_results.png');
    fs.writeFileSync(png, encodePng(1129, 76, () => [0, 0, 0, 255]));
    // a picture from elsewhere stays alone
    v.vals.set(`${v.num(`ssl_results_${k2}`)}|bar2.Source`, 'C:/elsewhere/x.png');
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    await show.syncData();
    const bars = () => v.calls.filter((c) => c.startsWith('?Function=SetImage') && /SelectedName=bar\d\.Source/.test(c));
    // the PNG remade (same path): the data sync leaves it (the title already has that path)
    fs.writeFileSync(png, encodePng(1129, 76, () => [255, 0, 0, 255]));
    v.calls.length = 0;
    setSetting(s.db, 'touch', '1');
    (show as any).memo.clear();
    await show.syncData();
    expect(bars()).toEqual([]);
    // the key: every dashboard picture again, in every input that shows one
    expect(show.pages()[0].keys[2][0]?.action).toBe('refreshpng');
    v.calls.length = 0;
    const r: any = await show.run('refreshpng');
    expect(r.refreshed).toBeGreaterThan(0);
    expect(bars().some((c) => c.includes(`Input=k${v.num(`ssl_results_${k1}`)}`) && /ESP_bar_results/.test(c))).toBe(true);
    expect(bars().some((c) => c.includes('elsewhere'))).toBe(false);
  });

  it('each group has its own results input and key; the day schedule can stay out of the break scene; flag 4 changes first', async () => {
    const { s, ev, f1, f2 } = race();
    const stage = s.db.prepare('SELECT id FROM fleet_sets LIMIT 1').get() as { id: string };
    setCurrentStage(s.db, ev, stage.id);
    seedGraphicSets(s.db, activeEvent(s.db).id);
    const [k1, k2] = [f1, f2].map((f) => groupLetter(f.name).replace(/[^A-Za-z0-9]+/g, '').toUpperCase());
    const v = fakeVmix({ ...TITLES, 'L-bars.gtzip': ['TITLE.Text'], ssl_ticker: ['Ticker1.Text'],
      [`ssl_results_${k1}`]: ['COUNTRY1.Text'], [`ssl_results_${k2}`]: ['COUNTRY1.Text'],
      [`ssl_compare_${k1}`]: ['1 FLAG.Source', '2 FLAG.Source', '3 FLAG.Source', '4 FLAG.Source'] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    await show.snapshot();
    // a RESULTS key per group on the COMPARE page, under its comparison, each with its own input
    const page = show.pages().find((p) => p.name === 'RESULTS/COMPARE')!;
    expect(page.keys[1].slice(0, 2).map((x) => x?.action)).toEqual([`results:${k1}`, `results:${k2}`]);
    expect(await show.run(`results:${k2}`)).toMatchObject({ in: 'results' });
    expect(v.overlays[1]).toBe(v.num(`ssl_results_${k2}`));
    await show.run(`results:${k2}`);
    expect(v.overlays[1] ?? '').toBe('');
    // the day schedule off: the break scene starts on the first group's own results input
    setShowConfig(s.db, { breakSchedule: false, breakOutMs: 0 });
    expect(show.slides().map((x) => x.kind)).toEqual(['results', 'results']);
    await show.run('show:break');
    expect(v.overlays[4]).toBe(v.num(`ssl_results_${k1}`));
    await show.run('nextslide');
    expect(v.overlays[4]).toBe(v.num(`ssl_results_${k2}`));
    await show.run('breakout');
    // flag / emblem: 4 FLAG (the one that starts the title's change animation) goes first
    setShowConfig(s.db, { flagChangeMs: 0 });
    // the title shows other pictures now (the flags), so the marks go in
    for (const n of [1, 2, 3, 4]) v.vals.set(`${v.num(`ssl_compare_${k1}`)}|${n} FLAG.Source`, 'old.png');
    (show as any).memo.clear();
    v.calls.length = 0;
    await show.run('comparemark');
    const flags = v.calls.filter((c) => c.includes(`Input=k${v.num(`ssl_compare_${k1}`)}`) && /FLAG\.Source/.test(c));
    expect(flags[0]).toContain('4 FLAG.Source');
    expect(flags.at(-1)).not.toContain('4 FLAG.Source');
    // no commentator lower third keys on the BEFORE page
    expect(show.pages()[0].keys.flat().some((x) => x?.action.startsWith('comm:'))).toBe(false);
  });

  it("fills the producer's own titles (overall_results, team_comparison, team_lineup) and keeps them in step without a key", async () => {
    const { s, teams } = race();
    saveLineup(s.ctx, activeEvent(s.db).id, teams[0], { rows: [
      { slot: 'Trimmer', firstName: 'Joan', lastName: 'Cardona', number: '7' },
      { slot: 'Trimmer1', firstName: 'Iker', lastName: 'Martinez', number: '8' },
      { slot: 'Tactician', firstName: 'Florian', lastName: 'Trittel', number: '2', captain: true },
    ] });
    const v = fakeVmix({
      ssl_results_group: ['LOCALIZATION.Text', 'COUNTRY1.Text', 'COUNTRY2.Text', 'position 1.Text', 'flag 1.Source', 'bar1.Source', 'R1 points1.Text', 'R2 points1.Text', 'Total1.Text', 'R1.Text', 'Group A.Text'],
      ssl_compare: ['Group.Text', '1 COUNTRY.Text', '1 NICKNAME.Text', 'RANK 1.Text', 'RANK NUM 3.Text', '1 CPT NAME.Text', '1 CPT SURNAME.Text', '1 FLAG.Source', '1 BG.Source', '1 PHOTO.Source', 'PHOTO 2.Source'],
      ssl_lineup: ['BG.Source', 'HelmBG.Source', 'Trimmer1BG.Source', 'TeamName.Text', 'Trimmer1NAME.Text', 'Trimmer1Positio.Text', 'Trimmer2SURNAME.Text', 'TacticianSURNAM.Text', 'BowPosition.Text', 'PitPOSITION.Text'],
      ssl_schedule: ['DateText.Text'],
    });
    // the team's PNGs from the generator: its long bar (results) and its left panel (comparison)
    const dir = path.join(s.ctx.assetsDir, 'PNG generator', 'ESP');
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, w, h] of [['ESP_bar_long.png', 1130, 75], ['ESP_bar_results.png', 1129, 76], ['ESP_panel_left.png', 851, 390], ['ESP_panel_right.png', 851, 390], ['ESP_square.png', 210, 134], ['ESP_lineup_photo_left.png', 211, 135], ['ESP_lineup_photo_right.png', 211, 135]] as const) fs.writeFileSync(path.join(dir, f), encodePng(w, h, () => [0, 0, 0, 255]));
    // the Results tab's subtitle is the place on the board (not Welcome's location)
    saveResults(s.db, getShowConfig(s.db).fleetId, { subtitle: 'Rio de Janeiro, Brazil' });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    // picking the group (top of the dashboard) is enough: results and comparison follow it
    const r = await show.syncData();
    expect(r.sent).toBeGreaterThan(5);
    expect(v.calls).toContain('?Function=SetText&Input=k1&SelectedName=COUNTRY1.Text&Value=TEAM ESP');
    expect(v.calls).toContain('?Function=SetText&Input=k1&SelectedName=Group A.Text&Value=FLEET 1');
    expect(v.calls).toContain('?Function=SetText&Input=k1&SelectedName=LOCALIZATION.Text&Value=RIO DE JANEIRO, BRAZIL');
    expect(v.calls).toContain('?Function=SetText&Input=k2&SelectedName=1 COUNTRY.Text&Value=TEAM ESP');
    expect(v.calls).toContain('?Function=SetText&Input=k2&SelectedName=1 CPT SURNAME.Text&Value=TRITTEL');
    expect(v.calls.some((c) => c.includes('SelectedName=DateText.Text'))).toBe(true);
    expect(v.calls.find((c) => c.includes('SelectedName=bar1.Source'))).toMatch(/ESP_bar_results\.png$/);
    expect(v.calls.find((c) => c.includes('SelectedName=1 BG.Source'))).toMatch(/ESP_panel_left\.png$/);
    // nothing changed: nothing sent again
    v.calls.length = 0;
    expect((await show.syncData()).sent).toBe(0);
    // COMPARE key: the emblem instead of the flag, straight into the title
    v.calls.length = 0;
    v.vals.set('2|1 FLAG.Source', 'old.png');
    (show as any).memo.clear();
    expect(await show.run('comparemark')).toEqual({ compareMark: 'emblem' });
    expect(v.calls.map((c) => c.split('&Value')[0])).toEqual(['?Function=SetImage&Input=k2&SelectedName=1 FLAG.Source']);
    v.calls.length = 0;
    // the lineup: GT's cut names and the trimmers numbered 1 and 2
    await show.run('lineup:ESP');
    expect(v.calls).toContain('?Function=SetText&Input=k3&SelectedName=Trimmer1NAME.Text&Value=JOAN');
    expect(v.calls).toContain('?Function=SetText&Input=k3&SelectedName=Trimmer2SURNAME.Text&Value=MARTINEZ');
    expect(v.calls).toContain('?Function=SetText&Input=k3&SelectedName=TacticianSURNAM.Text&Value=TRITTEL');
    expect(v.calls).toContain('?Function=SetText&Input=k3&SelectedName=TeamName.Text&Value=TEAM ESP');
    // the box behind each photo in the team's square; the big background stays
    expect(v.calls.find((c) => c.includes('SelectedName=HelmBG.Source'))).toMatch(/ESP_lineup_photo_left\.png$/);
    expect(v.calls.find((c) => c.includes('SelectedName=Trimmer1BG.Source'))).toMatch(/ESP_lineup_photo_left\.png$/);
    expect(v.calls.some((c) => c.includes('SelectedName=BG.Source'))).toBe(false);
    // the team set to the right side gets the mirrored box
    saveLineup(s.ctx, activeEvent(s.ctx.db).id, show.teamRef('ESP').id, { photoSide: 'right' });
    v.calls.length = 0;
    await show.run('lineup:ESP');
    expect(v.calls.find((c) => c.includes('SelectedName=HelmBG.Source'))).toMatch(/ESP_lineup_photo_right\.png$/);
    // a team with sponsor logos: the big panel with its TEAM PARTNERS strip; without them again, the plain panel back
    const espId = show.teamRef('ESP').id;
    v.vals.set('3|BG.Source', 'C:\\titles\\NEUTRAL_Lineup.png');
    saveUpload(s.ctx, 'team', espId, 'sponsor_1', encodePng(80, 40, (x, y) => (x > 10 && x < 70 && y > 10 && y < 30 ? [255, 255, 255, 255] : [0, 0, 0, 0])), 'sp.png');
    (show as any).memo.clear();
    v.calls.length = 0;
    await show.run('lineup:ESP');
    expect(v.calls.find((c) => c.includes('SelectedName=BG.Source'))).toMatch(/ESP_lineup_sponsors\.png$/);
    removeAsset(s.ctx, 'team', espId, 'sponsor_1');
    (show as any).memo.clear();
    v.calls.length = 0;
    await show.run('lineup:ESP');
    expect(v.calls.find((c) => c.includes('SelectedName=BG.Source'))).toMatch(/NEUTRAL_Lineup\.png$/);
    // the title's own BG as a bare name from inside its GTZIP (vMix cannot load it again: 500): the plain panel
    v.vals.set('3|BG.Source', 'BG.png');
    saveUpload(s.ctx, 'team', espId, 'sponsor_1', encodePng(80, 40, (x, y) => (x > 10 && x < 70 && y > 10 && y < 30 ? [255, 255, 255, 255] : [0, 0, 0, 0])), 'sp.png');
    (show as any).memo.clear();
    await show.run('lineup:ESP');
    removeAsset(s.ctx, 'team', espId, 'sponsor_1');
    (show as any).memo.clear();
    v.calls.length = 0;
    await show.run('lineup:ESP');
    expect(v.calls.find((c) => c.includes('SelectedName=BG.Source'))).toMatch(/lineup_plain\.png$/);
    // General graphics → Team comparison: what is typed there wins
    const fleetId = show.config.fleetId;
    setCompareOverride(s.ctx.db, fleetId, 1, 'nick', 'The Bulls');
    setCompareOverride(s.ctx.db, fleetId, 0, 'group', 'GROUP X');
    const tab = compareTab(s.ctx, activeEvent(s.ctx.db).id, '2026-01-01');
    expect(tab.groups.find((g) => g.fleetId === fleetId)?.over.teams?.['1']?.nick).toBe('The Bulls');
    v.calls.length = 0;
    await show.syncData();
    expect(v.calls).toContain('?Function=SetText&Input=k2&SelectedName=1 NICKNAME.Text&Value=The Bulls');
    expect(v.calls).toContain('?Function=SetText&Input=k2&SelectedName=Group.Text&Value=GROUP X');
  });

  it('the defending champions: a CHAMPIONS key on their team page only, the team lower third with the line typed in Show control', async () => {
    const { s } = race();
    setShowConfig(s.db, { championsTeam: 'ESP' });
    const v = fakeVmix(TITLES);
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    const pages = (await show.view()).pages;
    const keyOf = (code: string) => pages.flatMap((p) => p.keys.flat()).filter((k) => k && k.action.startsWith(`champions:`) && k.action.includes(code));
    expect(pages.flatMap((p) => p.keys.flat()).filter((k) => k?.action.startsWith('champions:'))).toHaveLength(1);
    expect(keyOf('ESP')).toHaveLength(1);
    await show.run(keyOf('ESP')[0]!.action);
    expect(v.calls.some((c) => c.includes('Bottom text.Text&Value=DEFENDING CHAMPIONS - SSL GOLD CUP 2023'))).toBe(true);
    setShowConfig(s.db, { championsText: 'Gold Cup 2023 champions' });
    v.calls.length = 0;
    await show.run('champions:ESP');
    expect(v.calls.some((c) => c.includes('Bottom text.Text&Value=Gold Cup 2023 champions'))).toBe(true);
  });

  it('a team page key shows that place of that team, whatever team is picked', async () => {
    const { s } = race();
    const v = fakeVmix(TITLES);
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    await show.run('boat:2');
    await show.run('sailorof:ESP/Pit');
    expect(v.calls.some((c) => c.includes('Value=Ana RUIZ'))).toBe(true);
    await show.run('teamlt:ESP');
    expect(v.calls.some((c) => c.includes('Value=TEAM ESP') || c.includes('Value=ESP'))).toBe(true);
    // a lower third on air: the next sailor is a data change, it is not taken out first (that made the next one wait)
    v.calls.length = 0;
    await show.run('sailorof:ESP/Pit');
    expect(v.calls.some((c) => c.includes('OverlayInput1Out'))).toBe(false);
    expect(v.calls.some((c) => c.includes('Value=Ana RUIZ'))).toBe(true);
  });

  it('fills the Weather layers named as the fields of the Weather tab, also when the data changes', async () => {
    const { s } = race();
    setWeather(s.db, { forecast: 'Sunny', air_temp: '24°C', wind_speed: '12', wind_direction: 'NW', wind_degrees: '315°' });
    const v = fakeVmix({ ...TITLES, ssl_weather: ['Forecast.Text', 'Air C.Text', 'Wind.Text', 'Direction.Text', 'Direction in degrees.Text'] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    await show.run('show:weather');
    const w = (f: string, val: string) => `?Function=SetText&Input=k${v.num('ssl_weather')}&SelectedName=${f}&Value=${val}`;
    for (const c of [w('Forecast.Text', 'Sunny'), w('Air C.Text', '24°C'), w('Wind.Text', '12'), w('Direction.Text', '315° NW'), w('Direction in degrees.Text', '315°')]) expect(v.calls).toContain(c);
    v.calls.length = 0;
    setWeather(s.db, { wind_speed: '15' });
    await show.syncData();
    expect(v.calls).toContain(w('Wind.Text', '15'));
    expect(personName({ name: 'jAN-erik', surname: 'van Dijk' })).toBe('Jan-Erik VAN DIJK');
  });

  it('a crew of ten with a floater: Lineup LT 5 + 5 from the bow, the numbered board for ten', async () => {
    const { s, ev, teams } = race();
    const slots = ['Bow', 'Midbow', 'Pit', 'Floater', 'Grinder', 'Trimmer', 'Trimmer1', 'Main', 'Helm', 'Tactician'];
    saveLineup(s.ctx, ev, teams[0], { rows: [...slots].reverse().map((slot, i) => ({ slot, firstName: `F${slot}`, lastName: slot, number: String(i + 1) })) });
    const board = (n: number) => Object.fromEntries([[`ssl_lineup_${n}`, Array.from({ length: n }, (_, i) => ['NAME', 'SURNAME', 'NUMBER', 'POSITION'].map((k) => `S${i + 1}${k}.Text`).concat(`S${i + 1}PHOTO.Source`)).flat()]]);
    // Adam's board for ten (Team_line-up_10.gtzip): a card per place, named by the place
    const ten = ['LineupText.Text', 'TeamName.Text', 'team partners.Text', 'BowSURNAME.Text', 'BowNAME.Text', 'BowNUMBER.Text', 'BowPosition.Text', 'MidbowSURNAME.Text', 'MidbowNAME.Text', 'MidbowNUMBER.Text', 'MidbowPosition.Text', 'TrimmerSURNAME.Text', 'TrimmerNAME.Text', 'TrimmerNUMBER.Text', 'TrimmerPosition.Text', 'Trimmer1SURNAME.Text', 'Trimmer1NAME.Text', 'Trimmer1NUMBER.Text', 'Trimmer1POSITIO.Text', 'PitSURNAME.Text', 'PitNAME.Text', 'PitNUMBER.Text', 'PitPOSITION.Text', 'GrinderPOSITION.Text', 'GrinderNUMBER.Text', 'GrinderNAME.Text', 'GrinderSURNAME.Text', 'MainPOSITION.Text', 'MainNUMBER.Text', 'MainNAME.Text', 'MainSURNAME.Text', 'TacticianPOSITI.Text', 'TacticianNUMBER.Text', 'TacticianNAME.Text', 'TacticianSURNAM.Text', 'HelmPOSITION.Text', 'HelmNUMBER.Text', 'HelmNAME.Text', 'HelmSURNAME.Text', 'FloaterSURNAME.Text', 'FloaterNUMBER.Text', 'FloaterNAME.Text', 'FloaterPOSITION.Text', 'BG.Source', 'Flag.Source', 'Emblem.Source', 'partner1.Source', 'partner2.Source', 'partner3.Source', 'Boat.Source', 'BowBG.Source', 'BowBAR.Source', 'MidbowBG.Source', 'MidbowBAR.Source', 'TrimmerBG.Source', 'TrimmerBAR.Source', 'Trimmer1BG.Source', 'Trimmer1BAR.Source', 'PitBG.Source', 'PitBAR.Source', 'GrinderBG.Source', 'GrinderBAR.Source', 'MainBG.Source', 'MainBAR.Source', 'TacticianBG.Source', 'TacticianBAR.Source', 'HelmBG.Source', 'HelmBAR.Source', 'FloaterBG.Source', 'FloaterBAR.Source', 'BowPHOTO.Source', 'MidbowPHOTO.Source', 'PitPHOTO.Source', 'TrimmerPHOTO.Source', 'TrimmerPHOTO1.Source', 'GrinderPHOTO.Source', 'MainPHOTO.Source', 'HelmPHOTO.Source', 'TacticianPHOTO.Source', 'FloaterPHOTO.Source'];
    const v = fakeVmix({ ...TITLES, ssl_lineup_10: ten, ...board(8) });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    const code = show.boat(show.state.boat).code;
    await show.run(`lult:${code}`);
    const lt = (n: number, val: string) => `?Function=SetText&Input=k9&SelectedName=NAME ${n}.Text&Value=${val}`;
    expect(v.calls).toContain(lt(1, 'F. BOW'));
    expect(v.calls).toContain(lt(4, 'F. FLOATER'));
    expect(v.calls).toContain(lt(5, 'F. GRINDER'));
    v.calls.length = 0;
    await show.run('lultswap');
    expect(v.calls).toContain(lt(1, 'F. TRIMMER'));
    expect(v.calls).toContain(lt(5, 'F. TACTICIAN'));
    v.calls.length = 0;
    await show.run(`lineup:${code}`);
    const k = v.num('ssl_lineup_10');
    const set = (input: string, f: string, val: string) => `?Function=${f.endsWith('.Source') ? 'SetImage' : 'SetText'}&Input=k${input}&SelectedName=${f}&Value=${val}`;
    for (const [f, val] of [['BowSURNAME.Text', 'BOW'], ['BowPosition.Text', 'BOW'], ['FloaterSURNAME.Text', 'FLOATER'], ['FloaterPOSITION.Text', 'FLOATER'], ['TrimmerSURNAME.Text', 'TRIMMER'],
      ['Trimmer1SURNAME.Text', 'TRIMMER1'], ['Trimmer1POSITIO.Text', 'TRIMMER'], ['TacticianSURNAM.Text', 'TACTICIAN'], ['TacticianNAME.Text', 'FTACTICIAN'], ['HelmNUMBER.Text', '2']]) expect(v.calls).toContain(set(k, f, val));
    // the title's own label over the logos: nothing without sponsors, TEAM PARTNER for one, TEAM PARTNERS for more
    expect(v.calls).toContain(set(k, 'team partners.Text', ''));
    const sp = encodePng(80, 40, (x, y) => (x > 10 && x < 70 && y > 10 && y < 30 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    saveUpload(s.ctx, 'team', teams[0], 'sponsor_1', sp, 'sp.png');
    (show as any).memo.clear(); show.invalidate();
    v.calls.length = 0;
    await show.run(`lineup:${code}`);
    expect(v.calls).toContain(set(k, 'team partners.Text', 'TEAM PARTNER'));
    saveUpload(s.ctx, 'team', teams[0], 'sponsor_2', sp, 'sp2.png');
    (show as any).memo.clear(); show.invalidate();
    v.calls.length = 0;
    await show.run(`lineup:${code}`);
    expect(v.calls).toContain(set(k, 'team partners.Text', 'TEAM PARTNERS'));
    removeAsset(s.ctx, 'team', teams[0], 'sponsor_1'); removeAsset(s.ctx, 'team', teams[0], 'sponsor_2');
    (show as any).memo.clear(); show.invalidate();
    // eight (no Midbow, no Floater) on the numbered board: the two trimmers side by side, the grinder behind them
    saveLineup(s.ctx, ev, teams[0], { rows: [{ slot: 'Midbow', firstName: '', lastName: '', number: '' }, { slot: 'Floater', firstName: '', lastName: '', number: '' }] });
    v.calls.length = 0;
    await show.run(`lineup:${code}`);
    const k8 = v.num('ssl_lineup_8');
    for (const [n, val] of [[1, 'BOW'], [2, 'PIT'], [3, 'TRIMMER'], [4, 'TRIMMER1'], [5, 'GRINDER'], [6, 'MAIN'], [7, 'HELM'], [8, 'TACTICIAN']] as const) expect(v.calls).toContain(set(k8, `S${n}SURNAME.Text`, val));
  });

  it('keeps key edits by page name; old ones by position move once, never onto the LINEUP LT keys', async () => {
    const { s } = race();
    const show = new Show(s.ctx, new LowerThirds(s.ctx));
    const pages = show.pages();
    const esp = pages.findIndex((p) => p.name === 'ESP');
    setShowConfig(s.db, { keys: { [`${esp}/0/2`]: { action: 'show:weather' }, [`${esp}/0/4`]: { text: 'MINE' } } });
    const after = show.pages();
    expect(Object.keys(show.config.keys)).toEqual(['ESP/0/4']);
    const p = after.find((x) => x.name === 'ESP')!;
    expect(p.keys[0][2]).toMatchObject({ action: 'lult:ESP' });
    expect(p.keys[0][3]).toMatchObject({ action: 'lultswap' });
  });

  it('lets keys be edited like a Stream Deck: text, colours, another action, an empty place', async () => {
    const { s } = race();
    setShowConfig(s.ctx.db, { keys: { 'A BEFORE/0/0': { text: 'HELLO\\n{auto}', bg: '#16a34a', fg: '#000000' }, 'A BEFORE/0/1': { action: 'show:weather' }, 'A BEFORE/0/2': { action: '' } }, kindColours: { board: '#7c3aed' } });
    const show = new Show(s.ctx, new LowerThirds(s.ctx));
    const p = deckPages(show.config)[0];
    expect(p.keys[0][1]).toMatchObject({ action: 'show:weather', text: 'WEATHER', kind: 'board' });
    expect(p.keys[0][2]).toBeNull();
    const look = await show.keyLook(p.keys[0][0]!);
    expect(look).toMatchObject({ text: 'HELLO\\nWELCOME', bg: '#16a34a', fg: '#000000' });
    expect((await show.keyLook(p.keys[0][3]!)).bg).toBe('#7c3aed');
    const f: any = companionFiles(show.config, 'http://x', 'http://v', show.graphics())[0].file;
    const ls = f.page.controls[0][0].style.layers;
    expect(ls.find((l: any) => l.type === 'text')).toMatchObject({ text: { value: 'HELLO\\nWELCOME' }, color: { value: 0 } });
    expect(ls.find((l: any) => l.type === 'box').color.value).toBe(0x16a34a);
    // the emptied place: a blank key calling its place
    expect(f.page.controls[0][2].style.layers.find((l: any) => l.type === 'text').text.value).toBe('');
    expect(f.page.controls[0][2].steps[0].action_sets.down[0].options.url.value).toBe('http://x/api/show/key/1/0/2');
  });

  it('a Companion key calls its place: an edit in the key editor changes what it does with no new import', async () => {
    const { s } = race();
    const v = fakeVmix(TITLES);
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    await show.runKey(1, 0, 0); // A BEFORE 0/0: WELCOME
    expect(v.overlays[1]).toBe(v.num('ssl_welcome'));
    await show.run('show:welcome');
    setShowConfig(s.ctx.db, { keys: { 'A BEFORE/0/0': { action: 'show:schedule' } } });
    v.calls.length = 0;
    await show.runKey(1, 0, 0);
    expect(v.overlays[1]).toBe(v.num('ssl_schedule'));
    expect(v.calls.at(-1)).toBe(`?Function=OverlayInput1In&Input=k${v.num('ssl_schedule')}`);
    // an emptied place, a free one and a page key do nothing here (pages change in Companion)
    setShowConfig(s.ctx.db, { keys: { 'A BEFORE/0/0': { action: '' } } });
    expect(await show.runKey(1, 0, 0)).toEqual({ empty: true });
    expect(await show.runKey(1, 1, 7)).toEqual({ empty: true });
    expect(await show.runKey(1, 3, 0)).toEqual({ nav: 2 });
    // older presets keep calling the action itself
    v.calls.length = 0;
    await show.run('show:welcome');
    expect(v.overlays[1]).toBe(v.num('ssl_welcome'));
  });

  it('serves the key routes: by place, the push status', async () => {
    const { s } = race();
    const app = await buildApp({ db: s.db, assetsDir: s.ctx.assetsDir });
    const nav = await app.inject({ url: '/api/show/key/1/3/0' });
    expect(nav.json()).toEqual({ nav: 2 });
    expect((await app.inject({ method: 'POST', url: '/api/show/key/1/1/7' })).json()).toEqual({ empty: true });
    expect((await app.inject({ url: '/api/show/key/x/0/0' })).statusCode).toBe(400);
    const st = (await app.inject({ url: '/api/show/labels' })).json();
    expect(st).toMatchObject({ enabled: false, labels: true, companionUrl: '', at: null, sent: 0, error: null });
    await app.close();
  });

  it('writes every key\'s text and colours into Companion, then only what changed', async () => {
    const { s, ev } = race();
    const posts: string[] = [];
    let missing = false;
    const fetcher = async (url: string) => {
      if (url.startsWith('http://companion:8000/')) { posts.push(url.slice('http://companion:8000'.length)); return { ok: true, status: missing ? 204 : 200, text: async () => 'ok' }; }
      return { ok: false, status: 500, text: async () => '' };
    };
    setSetting(s.db, 'lt.config', JSON.stringify({ companionUrl: 'http://companion:8000' }));
    const show = new Show(s.ctx, new LowerThirds(s.ctx), fetcher as any);
    const st = await show.pushLabels();
    const all = show.pages().flatMap((p) => p.keys.flatMap((row, r) => row.flatMap((k, c) => (k ? [`${p.page}/${r}/${c}`] : []))));
    // every dashboard key (boards, safety, navigation, teams…), the producer's vMix / ATEM keys on PEOPLE aside
    expect(posts.length).toBeGreaterThan(100);
    const at = (id: string) => posts.find((x) => x.startsWith(`/api/location/${id}/style?`));
    expect(at('1/0/0')).toBe(`/api/location/1/0/0/style?text=WELCOME&bgcolor=${encodeURIComponent('#1e3a8a')}&color=${encodeURIComponent('#ffffff')}&size=auto`);
    expect(at('1/3/7')).toBe('/api/location/1/3/7/style?text=DSK');
    expect(at('10/1/2')).toMatch(/text=PIT%5Cn%2312%20RUIZ/);
    const people = show.pages().find((p) => p.name === 'PEOPLE')!.page;
    expect(at(`${people}/1/0`)).toBeUndefined(); // the producer's vMix key keeps its look
    // …and the label DSK on the ATEM downstream key of each page (text only: Companion keeps its colours and on-air red)
    const dsk = posts.filter((x) => /\/style\?text=DSK$/.test(x));
    expect(dsk).toHaveLength(show.pages().length);
    expect(at(`${people}/3/7`)).toBe(`/api/location/${people}/3/7/style?text=DSK`);
    expect(posts.length - dsk.length).toBe(all.filter((id) => !/^\d+\/(1\/[0-2]|2\/0|2\/7|3\/[0-3])$/.test(id) || !id.startsWith(`${people}/`)).length);
    expect(st).toMatchObject({ enabled: true, sent: posts.length, error: null });
    expect(st.at).toBeTruthy();
    // nothing changed: nothing goes out
    posts.length = 0;
    expect((await show.pushLabels()).sent).toBe(0);
    expect(posts).toEqual([]);
    // a key edited (text, colours, another action) and a ticker added: only those keys go out
    setShowConfig(s.ctx.db, { keys: { 'A BEFORE/0/0': { text: 'HELLO', bg: '#16a34a', fg: '#000000' }, 'A BEFORE/0/1': { action: '' } } });
    createGraphicSet(s.db, ev, 'ticker', 'Wind delay');
    show.invalidate();
    const st2 = await show.pushLabels();
    expect(posts).toContain(`/api/location/1/0/0/style?text=HELLO&bgcolor=${encodeURIComponent('#16a34a')}&color=${encodeURIComponent('#000000')}&size=auto`);
    expect(posts).toContain(`/api/location/1/0/1/style?text=&bgcolor=${encodeURIComponent('#000000')}&color=${encodeURIComponent('#ffffff')}&size=auto`); // taken away: dark
    expect(posts.some((x) => /text=TICKER%5CnWIND%20DELAY/.test(x))).toBe(true);
    expect(posts.length).toBe(4); // the edited key, the emptied one, the new ticker on TICKERS and on the break scene ticker keys
    expect(st2.sent).toBe(4);
    // force: every key again; Companion without a button there answers 204
    posts.length = 0;
    missing = true;
    const st3 = await show.pushLabels(true);
    expect(posts.length).toBeGreaterThan(100);
    expect(st3).toMatchObject({ sent: 0, missing: posts.length });
    // off: nothing goes out
    setShowConfig(s.ctx.db, { labels: false });
    posts.length = 0;
    expect((await show.pushLabels(true)).enabled).toBe(false);
    expect(posts).toEqual([]);
  });

  it('colours team and sailor keys in national colours, with matching selected / on-air feedback', async () => {
    const { s } = race();
    expect(nationColours(null, 'BRA')).toEqual(['#049240', '#fdc900']);
    expect(nationColours(null, 'ITA').length).toBe(2); // from the flag table
    expect(nationColours(null, 'XYZ')).toEqual([]);
    const bra = teamKeyColours(null, 'BRA')!;
    expect(bra.onAir.bg).toBe('#fdc900');
    expect(bra.onAir.fg).toBe(textOn('#fdc900'));
    const show = new Show(s.ctx, new LowerThirds(s.ctx));
    const pages = show.pages();
    const espKey = await show.keyLook(pages[2].keys[0][1]!); // TEAMS: ESP
    const esp = teamKeyColours(s.db, 'ESP')!;
    expect(espKey).toMatchObject({ bg: esp.normal.bg, fg: esp.normal.fg });
    const espPage = pages.find((p) => p.name === 'ESP')!;
    const sailor = await show.keyLook(espPage.keys[1][2]!);
    expect(sailor).toMatchObject({ text: 'PIT\\n#12 RUIZ', bg: esp.normal.bg });
    expect((await show.keyLook(pages[2].keys[0][0]!)).bg).toBe(teamKeyColours(s.db, 'BRA')!.normal.bg);
    // a colour set on the key in the key editor still wins
    setShowConfig(s.db, { keys: { '2/0/1': { bg: '#123456' } } });
    expect((await show.keyLook(show.pages()[2].keys[0][1]!)).bg).toBe('#123456');
    // lower thirds: country keys in their colours
    const keys = new LowerThirds(s.ctx).layout().flat();
    expect(keys.find((k) => k.action === 'team:BRA')!.bg).toBe(teamKeyColours(s.db, 'BRA')!.normal.bg);
  });

  it('L-bar switch: the dashboard pictures; on air the Swap flips between the second look parts and an empty one', async () => {
    const s = setup();
    const v = fakeVmix({ ssl_lbar: ['L-bar.Source', 'Swap.Source'] });
    v.vals.set('1|Swap.Source', 'C:\\gt\\Swap.png');
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    setShowConfig(s.ctx.db, { ...getShowConfig(s.ctx.db), lbarSwapSeconds: 4 });
    const realNow = Date.now; let now = 1_000_000; Date.now = () => now;
    const tick = async (ms: number) => { now += ms; (show as any).memo.clear(); await show.lbarSwap(); };
    try {
      await tick(0);
      expect(show.swapStatus[0].error).toMatch(/upload both/);
      // look 2 differs from look 1 only in its left half
      saveLook(s.ctx, 1, encodePng(8, 4, () => [10, 20, 30, 255]));
      expect(lbarStatus(s.ctx).ready).toBe(false);
      saveLook(s.ctx, 2, encodePng(8, 4, (x) => (x < 2 ? [200, 0, 0, 255] : [10, 20, 30, 255])));
      const f = lbarFiles(s.ctx)!;
      const swap = PNG.sync.read(fs.readFileSync(path.join(s.ctx.assetsDir, 'L-bar switch', path.basename(f.swap))));
      expect([...swap.data.subarray(0, 4)]).toEqual([200, 0, 0, 255]);
      expect(swap.data[7 * 4 + 3]).toBe(0); // the same part stays transparent
      const sets = () => v.calls.filter((c) => c.includes('SelectedName=Swap.Source'));
      await tick(0);
      expect(v.calls.some((c) => c.includes('SelectedName=L-bar.Source') && c.includes('lbar_look1_'))).toBe(true);
      expect(sets().at(-1)).toMatch(/lbar_swap_empty\.png$/);
      await tick(10_000);
      expect(sets()).toHaveLength(1); // off air: nothing changes
      v.overlays[1] = '1';
      await tick(0); await tick(2_000);
      expect(sets()).toHaveLength(1);
      await tick(3_000);
      expect(sets().at(-1)).toMatch(/lbar_swap_[0-9a-f]{8}\.png$/);
      expect(show.swapStatus[0].error).toBe('');
      await tick(5_000);
      expect(show.swapStatus[0].look).toBe('second');
      await tick(0);
      expect(sets().at(-1)).toMatch(/lbar_swap_empty\.png$/);
      setShowConfig(s.ctx.db, { ...getShowConfig(s.ctx.db), lbarSwapSeconds: 0 });
      const n = sets().length;
      await tick(50_000);
      expect(sets()).toHaveLength(n);
    } finally { Date.now = realNow; }
  });
});

