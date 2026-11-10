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
import { createScheduleItem } from '../src/services/general.js';
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
      const inputs = names.map((n, i) => `<input key="k${i + 1}" number="${i + 1}" type="GT" title="${n}">${titles[n].map((f) => (f.endsWith('.Source') ? `<image index="0" name="${f}"></image>` : `<text index="0" name="${f}">x</text>`)).join('')}</input>`).join('');
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
  ssl_lt_lineup5: ['NAME 1.Text', 'NAME 2.Text', 'NAME 3.Text', 'NAME 4.Text', 'NAME 5.Text', 'Flag.Source'],
  ssl_lt_team_q: ['Top text.Text', 'Bottom text.Text'],
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

  it('toggles a board on overlay 1 and takes a lower third off when a board comes in', async () => {
    const { s } = race();
    const v = fakeVmix(TITLES);
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    await show.run('anthem:1'); // team lower third of team 1 on the lower-third channel (overlay 2)
    expect(v.calls.at(-1)).toMatch(/^\?Function=OverlayInput2In&Input=k8$/);
    v.calls.length = 0;
    await show.run('show:welcome');
    expect(v.calls).toEqual(['?Function=OverlayInput2Out', '?Function=OverlayInput1In&Input=k1']);
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
    expect(v.overlays[3]).toBe('4');

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

  it('bugs carry text and icon and toggle; every bug and ticker has a key, new ones too; General graphics go in at the press', async () => {
    const { s, ev } = race();
    seedGraphicSets(s.db, ev);
    setSetting(s.db, 'paths.vmixAssetsRoot', 'D:\\SSL\\assets');
    const v = fakeVmix({ ...TITLES, ssl_bug: ['bar.Source', 'TEXT.Text', 'icon_background.Source', 'Race flag.Source'], ssl_ticker: ['Ticker1.Text'], ssl_welcome: ['EVENT.Text', 'LOCATION.Text', 'DATE.Text'], ssl_officials: ['TITLE.Text', 'ROLE 1.Text', 'NAME 1.Text'] });
    const show = new Show(s.ctx, new LowerThirds(s.ctx, v.fetcher), v.fetcher);
    const pages = (await show.view()).pages;
    const bugs1 = pages.find((p) => p.name === 'BUGS 1')!;
    expect(bugs1.keys[0][0]).toMatchObject({ action: 'bug:1', text: 'P – PREPARATORY', empty: false });
    // the announcement on its key: one line of text and the flag's PNG from the vMix assets folder
    await show.run('bug:6');
    expect(v.calls).toContain('?Function=SetText&Input=k4&SelectedName=TEXT.Text&Value=INDIVIDUAL RECALL');
    expect(v.calls).toContain('?Function=SetImage&Input=k4&SelectedName=Race flag.Source&Value=D:\\SSL\\assets\\race-flags\\X_individual_recall.png');
    expect(v.calls.some((c) => /icon_background|bar\.Source/.test(c))).toBe(false);
    expect(v.overlays[3]).toBe('4');
    await show.run('bug:6');
    expect(v.overlays[3]).toBe('');

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
    updateGraphicSet(s.db, w.id, { data: { event: 'SSL GOLD CUP', location: 'RIO', dates: '1-2 DEC' } });
    const o = listGraphicSets(s.db, ev, 'officials')[0];
    updateGraphicSet(s.db, o.id, { data: { pro_name: 'Jan Kowalski' } });
    v.calls.length = 0;
    await show.run('show:welcome');
    expect(v.calls).toContain('?Function=SetText&Input=k1&SelectedName=EVENT.Text&Value=SSL GOLD CUP');
    expect(v.calls).toContain('?Function=SetText&Input=k1&SelectedName=DATE.Text&Value=1-2 DEC');
    await show.run('show:officials');
    expect(v.calls.some((c) => c.includes('SelectedName=ROLE 1.Text&Value=PRINCIPAL RACE OFFICER'))).toBe(true);
    expect(v.calls.some((c) => c.includes('SelectedName=NAME 1.Text&Value=Jan Kowalski'))).toBe(true);
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
    expect(v.calls).toContain('?Function=SetText&Input=k9&SelectedName=NAME 1.Text&Value=TAC');
    expect(v.calls).toContain('?Function=SetText&Input=k9&SelectedName=NAME 5.Text&Value=TR1');
    expect(v.overlays[2]).toBe('9');
    v.calls.length = 0;
    await show.run('show:lineup5');
    expect(v.calls).toContain('?Function=SetText&Input=k9&SelectedName=NAME 1.Text&Value=GRI');
    expect(v.calls).toContain('?Function=SetText&Input=k9&SelectedName=NAME 2.Text&Value=RUIZ');
    expect(v.calls).toContain('?Function=SetText&Input=k9&SelectedName=NAME 3.Text&Value=BOW');
    expect(v.calls).toContain('?Function=SetText&Input=k9&SelectedName=NAME 4.Text&Value=');
    expect(v.calls.some((c) => c.includes('Overlay'))).toBe(false);
    await show.run('show:lineup5');
    expect(v.overlays[2]).toBe('');

    await show.run('qualified:2');
    expect(v.calls).toContain('?Function=SetText&Input=k10&SelectedName=Bottom text.Text&Value=Qualified for the finals of SSL Gold Cup');
    expect(v.overlays[2]).toBe('10');
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
    // deck 1: 1–2, deck 2: 3–7, fallback 8, teams (by code) 9–12
    expect(Object.keys(f.pages).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
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
    expect(esp.controls[1][2].style.text).toBe('PIT\\nRUIZ');
    expect(url(esp.controls[1][2])).toBe('http://10.0.0.5:4310/api/show/do?a=sailorof%3AESP%2FPit');
    expect(url(esp.controls[0][0])).toBe('http://10.0.0.5:4310/api/show/do?a=teamlt%3AESP');
    expect(esp.controls[3][1].steps[0].action_sets.down[0].options.page).toBe(9); // ◀ BRA
    expect(esp.controls[3][2].steps[0].action_sets.down[0].options.page).toBe(11); // ▶ GBR
    expect(f.pages[12].controls[3][2].steps[0].action_sets.down[0].options.page).toBe(9); // after the last team: the first
    expect(url(f.pages[8].controls[0][0])).toBe('http://10.0.0.5:8088/api/?Function=OverlayInput1&Input=ssl_welcome');
    // every page keeps the safety row in the same place
    for (const p of show.pages()) expect(p.keys[3].slice(5).map((k) => k?.action)).toEqual(['undo', 'allout', 'panic']);
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
    expect(show.pages().filter((p) => p.page >= 9).map((p) => p.name)).toEqual(['ESP', 'BRA', 'GBR', 'ITA', 'COMPARE']);
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
    expect(show.pages()[0].keys[2][7]?.action).toBe(`nav:${page.page}`);
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
  });

  it('lets keys be edited like a Stream Deck: text, colours, another action, an empty place', async () => {
    const { s } = race();
    setShowConfig(s.ctx.db, { keys: { '0/0/0': { text: 'HELLO\\n{auto}', bg: '#16a34a', fg: '#000000' }, '0/0/1': { action: 'show:weather' }, '0/0/2': { action: '' } }, kindColours: { board: '#7c3aed' } });
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
    expect(sailor).toMatchObject({ text: 'PIT\\nRUIZ', bg: esp.normal.bg });
    expect((await show.keyLook(pages[2].keys[0][0]!)).bg).toBe(teamKeyColours(s.db, 'BRA')!.normal.bg);
    // a colour set on the key in the key editor still wins
    setShowConfig(s.db, { keys: { '2/0/1': { bg: '#123456' } } });
    expect((await show.keyLook(show.pages()[2].keys[0][1]!)).bg).toBe('#123456');
    // lower thirds: country keys in their colours
    const keys = new LowerThirds(s.ctx).layout().flat();
    expect(keys.find((k) => k.action === 'team:BRA')!.bg).toBe(teamKeyColours(s.db, 'BRA')!.normal.bg);
  });
});
