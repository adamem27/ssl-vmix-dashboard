import fs from 'node:fs';
import path from 'node:path';
import { encodePng } from '../src/services/png.js';
import { PNG } from 'pngjs';
import { comparisonFlag } from '../src/services/compareImages.js';
import { describe, expect, it } from 'vitest';
import { setup, seedTeam } from './helpers.js';
import { activeEvent, setSetting } from '../src/db/db.js';
import { createSet, getSetDetail, placeTeam } from '../src/services/fleets.js';
import { saveLineup } from '../src/services/lineups.js';
import { saveResults } from '../src/services/results.js';
import { createGraphicSet, listGraphicSets, repeatLoop, seedGraphicSets, updateGraphicSet } from '../src/services/graphicSets.js';
import { LowerThirds } from '../src/services/lowerthirds.js';
import { companionFiles, deckPages, getShowConfig, setShowConfig, Show } from '../src/services/show.js';
import { nationColours, teamKeyColours, textOn } from '../src/services/nationColours.js';
import { setCurrentStage } from '../src/services/workbookSheets.js';
import { compareTab, scheduleRows, setCompareOverride } from '../src/services/showData.js';
import { createPerson, createScheduleItem, personName, setWeather } from '../src/services/general.js';
import { groupLabel, groupLetter } from '../src/services/groupNames.js';

/** A fake vMix with named inputs and four overlay channels. */
function fakeVmix(titles: Record<string, string[]>) {
  const calls: string[] = [];
  const names = Object.keys(titles);
  const overlays: Record<number, string> = {};
  const num = (k: string) => String(names.indexOf(k) + 1);
  const fetcher = async (url: string) => {
    const q = decodeURIComponent(url.split('/api/')[1] ?? '');
    if (q === '') {
      const inputs = names.map((n, i) => `<input key="k${i + 1}" number="${i + 1}" type="${titles[n][0] === '#Image' ? 'Image' : 'GT'}" title="${n}">${titles[n].filter((f) => !f.startsWith('#')).map((f) => (f.endsWith('.Source') ? `<image index="0" name="${f}"></image>` : `<text index="0" name="${f}">x</text>`)).join('')}</input>`).join('');
      const ov = [1, 2, 3, 4].map((n) => `<overlay number="${n}">${overlays[n] ?? ''}</overlay>`).join('');
      return { ok: true, status: 200, text: async () => `<vmix><inputs>${inputs}</inputs><overlays>${ov}</overlays></vmix>` };
    }
    calls.push(q);
    const m = q.match(/Function=OverlayInput(\d)In&Input=k?(\d+)/);
    if (m) overlays[Number(m[1])] = m[2];
    const o = q.match(/Function=OverlayInput(\d)(Out|Off)$/);
    if (o) overlays[Number(o[1])] = '';
    return { ok: true, status: 200, text: async () => '' };
  };
  return { calls, fetcher, overlays, num };
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
  ssl_lt_team_q: ['Top text.Text', 'Bottom text.Text', 'Bar.Source'],
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
    await show.run('bug:6');
    const n = v.num('Announcement_bug 2.gtzip');
    expect(v.calls).toContain(`?Function=SetText&Input=k${n}&SelectedName=TEXT.Text&Value=INDIVIDUAL RECALL`);
    expect(v.calls.some((c) => c.startsWith(`?Function=SetImage&Input=k${n}&SelectedName=Race flag.Source&Value=`) && c.endsWith('X_individual_recall.png'))).toBe(true);
    expect(v.overlays[1]).toBe(n);
    const only = fakeVmix({ ...TITLES, ssl_bug: ['#Image'] });
    const show2 = new Show(s.ctx, new LowerThirds(s.ctx, only.fetcher), only.fetcher);
    await expect(show2.run('bug:6')).rejects.toThrow(/Image, no title fields/);
    // a GTZIP title whose fields vMix does not list gets the data by the GTZIP's own names, and comes in
    const blind = fakeVmix({ ...TITLES, ssl_bug: [] });
    const show3 = new Show(s.ctx, new LowerThirds(s.ctx, blind.fetcher), blind.fetcher);
    await show3.run('bug:6');
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
    expect(often.keys.flat().filter((k) => k && !k.empty && k.action.startsWith('bug:')).length).toBe(10);
    const rare = pages.find((p) => p.name === 'BUGS RARE')!;
    expect(rare.keys[0][0]).toMatchObject({ action: 'bug:r1', text: 'P – PREPARATORY', empty: false });
    await show.run('bug:o1');
    expect(v.calls).toContain('?Function=SetText&Input=k4&SelectedName=TEXT.Text&Value=INDIVIDUAL RECALL');
    await show.run('bug:o1');
    v.calls.length = 0;
    // the announcement on its key: one line of text and the flag's PNG from the vMix assets folder
    await show.run('bug:6');
    expect(v.calls).toContain('?Function=SetText&Input=k4&SelectedName=TEXT.Text&Value=INDIVIDUAL RECALL');
    expect(v.calls).toContain('?Function=SetImage&Input=k4&SelectedName=Race flag.Source&Value=D:\\SSL\\assets\\race-flags\\X_individual_recall.png');
    expect(v.calls.some((c) => /icon_background|bar\.Source/.test(c))).toBe(false);
    expect(v.overlays[1]).toBe('4');
    await show.run('bug:6');
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
    expect(v.calls).toContain('?Function=SetText&Input=k10&SelectedName=Bottom text.Text&Value=Qualified for the SSL Gold Cup finals');
    expect(v.calls.find((c) => c.includes('SelectedName=Bar.Source'))).toMatch(new RegExp(`${code}_lowerthird\\.png$`));
    expect(v.overlays[1]).toBe('10');
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
    expect(v.overlays[4]).toBe('5');
    show.stopRotation();
    v.calls.length = 0;
    await show.run('nextslide');
    expect(v.calls.at(-1)).toBe('?Function=SetMultiViewOverlay&Input=k5&Value=3,k3');
    await show.run('tickermode');
    expect(show.state.tickerMode).toBe('end');
  });

  it('builds one Companion preset: every page, a page per team with its sailors, the fallback straight to vMix', async () => {
    const { s } = race();
    const show = new Show(s.ctx, new LowerThirds(s.ctx));
    const f: any = await show.companionPreset('http://10.0.0.5:4310', 'http://10.0.0.5:8088');
    expect(f).toMatchObject({ version: 4, type: 'full' });
    // deck 1: 1–2, deck 2: 3–6, fallback 8, teams (by code) 9–12
    expect(Object.keys(f.pages).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14]);
    const url = (c: any) => c.steps[0].action_sets.down[0].options.url;
    expect(url(f.pages[1].controls[0][0])).toBe('http://10.0.0.5:4310/api/show/do?a=show%3Awelcome');
    expect(f.pages[1].controls[3][2].steps[0].action_sets.down[0]).toMatchObject({ action: 'set_page', instance: 'internal', options: { controller: 'self', page: 2 } });
    // TEAMS: a key per team opens its page; ESP is the second by code
    expect(f.pages[3].name).toBe('SSL TEAMS');
    expect(f.pages[3].controls[0][1].style.text).toBe('ESP\\nTEAM ESP');
    expect(f.pages[3].controls[0][1].steps[0].action_sets.down[0]).toMatchObject({ action: 'set_page', options: { page: 10 } });
    // ESP's page: its places with the names fixed on the keys, each calling that place of that team
    const esp = f.pages[10];
    expect(esp.name).toBe('SSL ESP');
    expect(esp.controls[1][0].style.text).toBe('BOW\\nPONS');
    expect(esp.controls[1][2].style.text).toBe('PIT\\n#12 RUIZ');
    expect(url(esp.controls[1][2])).toBe('http://10.0.0.5:4310/api/show/do?a=sailorof%3AESP%2FPit');
    expect(url(esp.controls[0][0])).toBe('http://10.0.0.5:4310/api/show/do?a=qualified%3AESP');
    // the team lower thirds sit on TEAMS, a row below each team's page key (not on the team's own page)
    expect(f.pages[3].controls[1] ?? {}).toEqual({});
    expect(url(f.pages[3].controls[2][1])).toBe('http://10.0.0.5:4310/api/show/do?a=teamlt%3AESP');
    expect(Object.values(esp.controls).flatMap((r: any) => Object.values(r)).some((c: any) => /teamlt/.test(c?.steps?.[0]?.action_sets?.down?.[0]?.options?.url ?? ''))).toBe(false);
    expect(esp.controls[3][1].steps[0].action_sets.down[0].options.page).toBe(9); // ◀ BRA
    expect(esp.controls[3][2].steps[0].action_sets.down[0].options.page).toBe(11); // ▶ GBR
    expect(f.pages[12].controls[3][2].steps[0].action_sets.down[0].options.page).toBe(9); // after the last team: the first
    expect(url(f.pages[8].controls[0][0])).toBe('http://10.0.0.5:8088/api/?Function=OverlayInput1&Input=ssl_welcome');
    // every page keeps the safety row in the same place
    for (const p of show.pages()) expect(p.keys[3].slice(5).map((k) => k?.action)).toEqual(['undo', 'allout', 'panic']);
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

  it('the preset has pages only for the teams of the stage picked at the top, in group order', () => {
    const { s, ev } = race();
    seedTeam(s.db, 'USA', []); // not in the stage
    const show = new Show(s.ctx, new LowerThirds(s.ctx));
    expect(show.presetTeams().map((t) => t.code)).toEqual(['BRA', 'ESP', 'GBR', 'ITA', 'USA']); // no stage picked: every team
    const stage = s.db.prepare('SELECT id FROM fleet_sets LIMIT 1').get() as { id: string };
    setCurrentStage(s.db, ev, stage.id);
    show.invalidate();
    expect(show.presetTeams().map((t) => t.code)).toEqual(['ESP', 'BRA', 'GBR', 'ITA']);
    expect(show.pages().filter((p) => p.page >= 9).map((p) => p.name)).toEqual(['ESP', 'BRA', 'GBR', 'ITA', 'COMPARE', 'PEOPLE']);
  });

  it('everyone in People has a key; the COMPARE keys follow the Team comparison inputs vMix has', async () => {
    const { s, ev, f1, f2 } = race();
    createPerson(s.db, ev, { name: 'Ana Costa', role: 'Host commentator', title: 'Host' });
    createPerson(s.db, ev, { name: 'BEN', surname: 'lee', role: 'Guest', title: 'Olympic champion' });
    const [, k2] = [f1, f2].map((f) => groupLetter(f.name).replace(/[^A-Za-z0-9]+/g, '').toUpperCase());
    const v = fakeVmix({ ...TITLES, ssl_lt_comm_nophoto: ['Top text.Text', 'Bottom text.Text'], [`ssl_compare_${k2}`]: ['1 COUNTRY.Text'] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    const people = (await show.view()).pages.find((p) => p.name === 'PEOPLE')!;
    expect(people.keys[0].slice(0, 3).map((k) => k?.text)).toEqual(['ANA COSTA', 'BEN\\nLEE', '']);
    await show.run('person:2');
    expect(v.calls).toContain(`?Function=SetText&Input=k${v.num('ssl_lt_comm_nophoto')}&SelectedName=Top text.Text&Value=Ben LEE`);
    // only the group whose input is in vMix gets a COMPARE key
    const compare = show.pages().find((p) => p.name === 'COMPARE')!;
    expect(compare.keys[0].filter(Boolean).map((k) => k!.action)).toEqual([`compare:${k2}`]);
  });

  it('every group of the stage has its own Team comparison input and key', async () => {
    const { s, ev, f1, f2 } = race();
    const stage = s.db.prepare('SELECT id FROM fleet_sets LIMIT 1').get() as { id: string };
    setCurrentStage(s.db, ev, stage.id);
    const [k1, k2] = [f1, f2].map((f) => groupLetter(f.name).replace(/[^A-Za-z0-9]+/g, '').toUpperCase());
    const v = fakeVmix({ ...TITLES, [`ssl_compare_${k1}`]: ['1 COUNTRY.Text', '1 FLAG.Source'], [`ssl_compare_${k2}`]: ['1 COUNTRY.Text'] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    const page = show.pages().find((p) => p.name === 'COMPARE')!;
    expect(page.keys[0].slice(0, 2).map((x) => x?.action)).toEqual([`compare:${k1}`, `compare:${k2}`]);
    expect(show.pages()[0].keys[0][7]?.action).toBe(`nav:${page.page}`);
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
    expect(f.page.controls[0][0].style).toMatchObject({ text: 'HELLO\\nWELCOME', bgcolor: 0x16a34a, color: 0 });
    expect(f.page.controls[0][2]).toBeUndefined();
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
});
