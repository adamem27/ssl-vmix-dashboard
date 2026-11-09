import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { activeEvent, getSetting, setSetting } from '../db/db.js';
import { AssetCtx } from './assets.js';
import { badRequest, notFound } from './errors.js';
import { getSetDetail, listSets } from './fleets.js';
import { listPeople } from './general.js';
import { listGraphicSets, tickerText } from './graphicSets.js';
import { loadLineup, slotDefs } from './lineups.js';
import { crewOf, getLtConfig, LowerThirds, LtSailor } from './lowerthirds.js';
import { listTeams } from './teams.js';
import { encodePng } from './png.js';
import { joinVmixPath } from './paths.js';
import { findInput, parseVmixXml, pushResults, VmixInput, vmixUrl } from './vmixResults.js';

/**
 * Show control: every graphic of the broadcast as one entry of a registry (vMix input names, overlay channel),
 * driven from two Stream Decks through Companion. Each key calls /api/show/do?a=<action>; the dashboard fills the
 * title through the vMix Web API, brings it in on its overlay channel and keeps the rules:
 *  - OV1 boards, OV2 lower thirds, OV3 bugs and tickers, OV4 the break scene, L-bar and PiP frames
 *  - a board coming in takes the lower third and the break scene off; the break scene takes boards and lower thirds off
 *  - UNDO puts every overlay back as it was before the last action; ALL OUT takes everything out with its
 *    animation; PANIC (pressed twice) cuts everything at once
 * State (what is on air) is always read from vMix, never remembered from key presses.
 */

export type Kind = 'board' | 'lt' | 'bug' | 'scene';
export interface Graphic { id: string; label: string; kind: Kind; overlay: number; inputs: string[] }

/** Default registry. `inputs` are tried in order; `{n}` is the number of teams of the race (3/4), `{crew}` the crew size. */
export const DEFAULT_GRAPHICS: Graphic[] = [
  { id: 'welcome', label: 'Welcome', kind: 'board', overlay: 1, inputs: ['ssl_welcome'] },
  { id: 'schedule', label: 'Day schedule', kind: 'board', overlay: 1, inputs: ['ssl_schedule'] },
  { id: 'matchboard', label: 'Matchboard', kind: 'board', overlay: 1, inputs: ['ssl_matchboard'] },
  { id: 'results', label: 'Group results', kind: 'board', overlay: 1, inputs: ['ssl_results_group_{n}', 'ssl_results_group'] },
  { id: 'raceresults', label: 'Race results', kind: 'board', overlay: 1, inputs: ['ssl_results_race_{n}', 'ssl_results_race'] },
  { id: 'compare', label: 'Team comparison', kind: 'board', overlay: 1, inputs: ['ssl_compare_{n}', 'ssl_compare'] },
  { id: 'lineup', label: 'Team lineup', kind: 'board', overlay: 1, inputs: ['ssl_lineup_{crew}', 'ssl_lineup'] },
  { id: 'course', label: 'Race course', kind: 'board', overlay: 1, inputs: ['ssl_course'] },
  { id: 'officials', label: 'Race officials', kind: 'board', overlay: 1, inputs: ['ssl_officials'] },
  { id: 'weather', label: 'Weather', kind: 'board', overlay: 1, inputs: ['ssl_weather'] },
  { id: 'teamq', label: 'Team LT qualified', kind: 'lt', overlay: 2, inputs: ['ssl_lt_team_q'] },
  { id: 'comm', label: 'Commentator LT', kind: 'lt', overlay: 2, inputs: ['ssl_lt_comm_photo', 'ssl_lt_comm_nophoto'] },
  { id: 'lineup5', label: 'Lineup LT (5 sailors)', kind: 'lt', overlay: 2, inputs: ['ssl_lt_lineup5'] },
  { id: 'bug', label: 'Announcement bug', kind: 'bug', overlay: 3, inputs: ['ssl_bug'] },
  { id: 'ticker', label: 'Ticker', kind: 'bug', overlay: 3, inputs: ['ssl_ticker'] },
  { id: 'replay', label: 'Replay bug', kind: 'bug', overlay: 3, inputs: ['ssl_replay'] },
  { id: 'socials', label: 'Socials', kind: 'bug', overlay: 3, inputs: ['ssl_socials'] },
  { id: 'sponsors', label: 'Event sponsors bar', kind: 'bug', overlay: 3, inputs: ['ssl_sponsors'] },
  { id: 'break', label: 'Break scene (L-bar + ticker + boards)', kind: 'scene', overlay: 4, inputs: ['ssl_break'] },
  { id: 'lbar', label: 'L-bar', kind: 'scene', overlay: 4, inputs: ['ssl_lbar'] },
  { id: 'pip_replay', label: 'PiP replay + onboard', kind: 'scene', overlay: 4, inputs: ['ssl_pip_replay'] },
  { id: 'pip_live', label: 'PiP onboard + live', kind: 'scene', overlay: 4, inputs: ['ssl_pip_live'] },
  { id: 'pip_4', label: 'PiP 4 onboards', kind: 'scene', overlay: 4, inputs: ['ssl_pip_4'] },
];

export const showConfigSchema = z.object({
  /** input names per graphic id (comma separated alternatives), overriding the defaults */
  inputs: z.record(z.string(), z.string()).default({}),
  /** the fleet (group) racing now: its teams are BOAT 1–4 in fleet order */
  fleetId: z.string().default(''),
  /** fleets shown in turn in the break scene (empty: every fleet of the race's set) */
  breakFleets: z.array(z.string()).default([]),
  breakLayer: z.number().int().min(1).max(10).default(3),
  rotateSeconds: z.number().int().min(4).max(120).default(12),
  /** ticker versions (Tickers in General graphics) for the break before the next race (D) and at the end (E) */
  tickerNext: z.string().default(''),
  tickerEnd: z.string().default(''),
  /** Companion pages: deck 1 (program) base, deck 2 (race) base, the shared fallback page */
  deck1Page: z.number().int().min(1).max(99).default(1),
  deck2Page: z.number().int().min(1).max(99).default(11),
  fallbackPage: z.number().int().min(1).max(99).default(20),
  /** vMix address as Companion reaches it, for the fallback page (default: the dashboard's vMix address) */
  vmixForCompanion: z.string().default(''),
  /** write key texts and colours into Companion (HTTP remote control) */
  labels: z.boolean().default(true),
  /** places on the lineup lower third, in this order: the first 5, then the rest on the second press */
  lineup5: z.array(z.string()).default(['Tactician', 'Helm', 'Main', 'Trimmer1', 'Trimmer', 'Grinder', 'Pit', 'Midbow', 'Bow']),
});
export type ShowConfig = z.infer<typeof showConfigSchema>;

const CFG = 'show.config';
const STATE = 'show.state';
export function getShowConfig(db: AssetCtx['db']): ShowConfig {
  let raw: unknown = {};
  try { raw = JSON.parse(getSetting(db, CFG) || '{}'); } catch { /* defaults */ }
  return showConfigSchema.parse(raw);
}
export function setShowConfig(db: AssetCtx['db'], patch: Partial<ShowConfig>) {
  const next = showConfigSchema.parse({ ...getShowConfig(db), ...patch });
  setSetting(db, CFG, JSON.stringify(next));
  return next;
}

export interface ShowState {
  tickerMode: 'next' | 'end';
  boat: number; // 1–4, the boat whose sailors are on the race page
  photo: 'auto' | 'on' | 'off';
  rotating: boolean;
  slide: number;
  armedPanic: number; // time of the first PANIC press
  undo: Record<string, string>[]; // overlay → input key, newest last
  last: { at: string; action: string; error: string | null } | null;
  bug: string; // announcement shown on the bug
  lineupPart: number; // 0 = off, 1 = first five, 2 = the rest
}
const EMPTY_STATE: ShowState = { tickerMode: 'next', boat: 1, photo: 'auto', rotating: false, slide: 0, armedPanic: 0, undo: [], last: null, bug: '', lineupPart: 0 };
export function getShowState(db: AssetCtx['db']): ShowState {
  try { return { ...EMPTY_STATE, ...JSON.parse(getSetting(db, STATE) || '{}') }; } catch { return { ...EMPTY_STATE }; }
}
const saveShowState = (db: AssetCtx['db'], s: ShowState) => setSetting(db, STATE, JSON.stringify(s));

type Fetch = (url: string, init?: { signal?: AbortSignal; method?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
type Asset = { vmixPath: string | null; storedPath: string | null; enteredPath: string | null } | undefined | null;
const img = (a: Asset) => (a ? a.vmixPath ?? a.storedPath ?? a.enteredPath ?? '' : '');

export const overlayOf = (xml: string, n: number) => xml.match(new RegExp(`<overlay number="${n}"[^>]*>(\\d+)</overlay>`))?.[1] ?? '';

/** The keys of both decks. Row 4 (index 3) is the same on every page: HOME ◀ ▶ … UNDO ALL OUT PANIC. */
export interface DeckKey { action: string; text: string; kind: Kind | 'team' | 'sailor' | 'nav' | 'safety' | 'mode' }
export interface DeckPage { deck: 1 | 2 | 0; name: string; page: number; keys: (DeckKey | null)[][] }

const k = (action: string, text: string, kind: DeckKey['kind']): DeckKey => ({ action, text, kind });
const row8 = (...keys: (DeckKey | null)[]) => Array.from({ length: 8 }, (_, i) => keys[i] ?? null);

export function deckPages(cfg: ShowConfig): DeckPage[] {
  const p1 = cfg.deck1Page, p2 = cfg.deck2Page;
  const nav = (home: number, prev: number, prevName: string, next: number, nextName: string) => row8(
    k(`nav:${home}`, 'HOME', 'nav'), k(`nav:${prev}`, `◀\\n${prevName}`, 'nav'), k(`nav:${next}`, `▶\\n${nextName}`, 'nav'),
    k(`nav:${cfg.fallbackPage}`, 'FALL-\\nBACK', 'nav'), null,
    k('undo', 'UNDO', 'safety'), k('allout', 'ALL\\nOUT', 'safety'), k('panic', 'PANIC\\n(press 2×)', 'safety'));
  return [
    {
      deck: 1, name: 'A BEFORE', page: p1, keys: [
        row8(k('show:welcome', 'WELCOME', 'board'), k('comm:host', 'HOST\\nLT', 'lt'), k('comm:guest', 'GUEST\\nLT', 'lt'), k('show:matchboard', 'MATCH-\\nBOARD', 'board'),
          k('show:schedule', 'DAY\\nSCHEDULE', 'board'), k('show:results', 'GROUP\\nRESULTS', 'board'), k('show:compare', 'TEAM\\nCOMPARE', 'board'), k('boardout', 'BOARD\\nOUT', 'board')),
        row8(k('anthem:1', 'ANTHEM\\nBOAT 1', 'team'), k('anthem:2', 'ANTHEM\\nBOAT 2', 'team'), k('anthem:3', 'ANTHEM\\nBOAT 3', 'team'), k('anthem:4', 'ANTHEM\\nBOAT 4', 'team'),
          k('lineup:1', 'LINEUP\\nBOAT 1', 'board'), k('lineup:2', 'LINEUP\\nBOAT 2', 'board'), k('lineup:3', 'LINEUP\\nBOAT 3', 'board'), k('lineup:4', 'LINEUP\\nBOAT 4', 'board')),
        row8(k('show:course', 'RACE\\nCOURSE', 'board'), k('show:officials', 'OFFICIALS', 'board'), k('show:weather', 'WEATHER', 'board'), k('comm:water', 'ON-WATER\\nLT', 'lt'),
          k('comm:studio', 'STUDIO\\n+WATER LT', 'lt'), k('ltout', 'LT OUT', 'lt')),
        nav(p1, p1 + 1, 'AFTER', p1 + 1, 'AFTER'),
      ],
    },
    {
      deck: 1, name: 'C-E AFTER / BREAK', page: p1 + 1, keys: [
        row8(k('show:raceresults', 'RACE\\nRESULTS', 'board'), k('show:results', 'GROUP\\nRESULTS', 'board'), k('boardout', 'BOARD\\nOUT', 'board'),
          k('qualified:1', 'QUALIFIED\\nBOAT 1', 'team'), k('qualified:2', 'QUALIFIED\\nBOAT 2', 'team'), k('qualified:3', 'QUALIFIED\\nBOAT 3', 'team'), k('qualified:4', 'QUALIFIED\\nBOAT 4', 'team'), k('ltout', 'LT OUT', 'lt')),
        row8(k('show:break', 'BREAK\\nSCENE', 'scene'), k('breakout', 'BREAK\\nOUT', 'scene'), k('rotate', 'ROTATION\\n⏯', 'scene'), k('nextslide', 'NEXT\\nSLIDE', 'scene'),
          k('tickermode', 'TICKER:\\nNEXT RACE', 'mode')),
        row8(k('bug:thanks', 'THANKS FOR\\nWATCHING', 'bug'), k('show:lbar', 'L-BAR', 'scene'), k('show:sponsors', 'SPONSORS\\nBAR', 'bug'), k('show:ticker', 'TICKER', 'bug'), k('bugout', 'BUG OUT', 'bug')),
        nav(p1, p1, 'BEFORE', p1, 'BEFORE'),
      ],
    },
    {
      deck: 2, name: 'B RACE', page: p2, keys: [
        row8(k('boat:1', 'BOAT 1', 'team'), k('boat:2', 'BOAT 2', 'team'), k('boat:3', 'BOAT 3', 'team'), k('boat:4', 'BOAT 4', 'team'),
          k('photo', 'PHOTO\\nAUTO', 'mode'), k('next', 'NEXT\\nRESULT', 'lt'), k('teamlt', 'TEAM LT', 'lt'), k('ltout', 'LT OUT', 'lt')),
        row8(...Array.from({ length: 8 }, (_, i) => k(`sailor:${i + 1}`, '—', 'sailor'))),
        row8(...Array.from({ length: 8 }, (_, i) => k(`sailor:${i + 9}`, '—', 'sailor'))),
        nav(p2, p2 + 1, 'EXTRAS', p2 + 1, 'EXTRAS'),
      ],
    },
    {
      deck: 2, name: 'EXTRAS', page: p2 + 1, keys: [
        row8(...Array.from({ length: 8 }, (_, i) => k(`bug:${i + 1}`, '—', 'bug'))),
        row8(k('show:ticker', 'TICKER', 'bug'), k('bugout', 'BUG OUT', 'bug'), k('show:replay', 'REPLAY\\nBUG', 'bug'), k('show:socials', 'SOCIALS', 'bug'),
          k('show:sponsors', 'SPONSORS\\nBAR', 'bug'), k('show:lbar', 'L-BAR', 'scene'), k('show:lineup5', 'LINEUP\\nLT', 'lt')),
        row8(k('show:pip_replay', 'PiP\\nREPLAY+OB', 'scene'), k('show:pip_live', 'PiP\\nOB+LIVE', 'scene'), k('show:pip_4', 'PiP\\n4 ONBOARDS', 'scene'), k('scene4out', 'PiP OUT', 'scene')),
        nav(p2, p2, 'RACE', p2, 'RACE'),
      ],
    },
  ];
}

export class Show {
  private timer: NodeJS.Timeout | null = null;
  private rotation: NodeJS.Timeout | null = null;
  private labels = new Map<string, string>();
  constructor(readonly ctx: AssetCtx, readonly lt: LowerThirds, private fetcher: Fetch = fetch as unknown as Fetch, private log: (m: string) => void = () => {}) {}

  get config() { return getShowConfig(this.ctx.db); }
  get state() { return getShowState(this.ctx.db); }
  private patchState(p: Partial<ShowState>) { const s = { ...this.state, ...p }; saveShowState(this.ctx.db, s); return s; }

  private async vmix(q: string) {
    const base = vmixUrl(this.ctx.db);
    let res;
    try { res = await this.fetcher(`${base}/api/${q}`, { signal: AbortSignal.timeout(4000) }); }
    catch { throw badRequest(`vMix does not answer at ${base}. Turn on Settings → Web Controller in vMix and check the address in Settings here.`); }
    if (!res.ok) throw badRequest(`vMix answered ${res.status} for ${decodeURIComponent(q).slice(0, 80)}`);
    return res.text();
  }

  // ---------- data the keys need ----------
  graphics(): Graphic[] {
    const over = this.config.inputs;
    return DEFAULT_GRAPHICS.map((g) => (over[g.id]?.trim() ? { ...g, inputs: over[g.id].split(',').map((s) => s.trim()).filter(Boolean) } : g));
  }
  graphic(id: string) { const g = this.graphics().find((x) => x.id === id); if (!g) throw notFound(`Graphic ${id}`); return g; }

  /** The teams of the race now, BOAT 1–4 in fleet order. */
  boats(): { id: string; code: string; name: string }[] {
    const cfg = this.config;
    if (!cfg.fleetId) return [];
    const ev = activeEvent(this.ctx.db).id;
    const teams = new Map(listTeams(this.ctx).map((t) => [t.id, t]));
    for (const s of listSets(this.ctx.db, ev) as { id: string }[]) {
      const f = getSetDetail(this.ctx.db, s.id).fleets.find((x) => x.id === cfg.fleetId);
      if (f) return f.positions.filter((x): x is string => !!x).map((id) => teams.get(id)).filter(Boolean).map((t) => ({ id: t!.id, code: t!.code, name: t!.name }));
    }
    return [];
  }
  boat(n: number) { const b = this.boats()[n - 1]; if (!b) throw badRequest(`No team on BOAT ${n}. Pick the race (group) on the Show control tab.`); return b; }

  /** Sailors of the selected boat with a name, by shirt number. */
  sailors(): LtSailor[] {
    const b = this.boats()[this.state.boat - 1];
    if (!b) return [];
    const num = (s: LtSailor) => (Number.isFinite(Number(s.number)) && s.number !== '' ? Number(s.number) : 999);
    return crewOf(this.ctx, b.id).filter((s) => s.firstName || s.lastName).sort((a, c) => num(a) - num(c));
  }

  announcements() { return listGraphicSets(this.ctx.db, activeEvent(this.ctx.db).id, 'announcement'); }

  /** Fleets that rotate in the break scene. */
  breakFleets(): string[] {
    const cfg = this.config;
    if (cfg.breakFleets.length) return cfg.breakFleets;
    const ev = activeEvent(this.ctx.db).id;
    for (const s of listSets(this.ctx.db, ev) as { id: string }[]) {
      const d = getSetDetail(this.ctx.db, s.id);
      if (d.fleets.some((f) => f.id === cfg.fleetId)) return d.fleets.map((f) => f.id);
    }
    return cfg.fleetId ? [cfg.fleetId] : [];
  }

  // ---------- vMix state ----------
  async snapshot() {
    const xml = await this.vmix('');
    const inputs = parseVmixXml(xml);
    const overlays: Record<string, string> = {};
    for (let n = 1; n <= 4; n++) overlays[n] = overlayOf(xml, n);
    return { xml, inputs, overlays };
  }

  /** The first of a graphic's input names that exists in vMix ({n} = teams in the race, {crew} = crew size). */
  resolve(g: Graphic, inputs: VmixInput[], vars: Record<string, string | number> = {}): VmixInput | undefined {
    const n = this.boats().length || 4;
    const crew = Number(vars.crew) || 9;
    // a crew without its own title takes the nearest bigger one (empty places stay blank), then smaller ones
    const crews = [...Array.from({ length: 13 - crew }, (_, i) => crew + i), ...Array.from({ length: crew - 1 }, (_, i) => crew - 1 - i)];
    for (const raw of g.inputs) {
      const names = raw.includes('{crew}') ? crews.map((c) => raw.replace('{crew}', String(c))) : [raw.replace('{n}', String(vars.n ?? n))];
      for (const name of names) {
        const exact = inputs.find((i) => i.title.toLowerCase() === name.toLowerCase() || i.title.toLowerCase().replace(/\.gtzip$/, '') === name.toLowerCase());
        if (exact) return exact;
      }
    }
    return undefined;
  }
  private need(g: Graphic, inputs: VmixInput[], vars?: Record<string, string | number>) {
    const i = this.resolve(g, inputs, vars);
    if (!i) throw badRequest(`vMix has no input ${g.inputs.join(' / ')} for ${g.label}. Add it (or its placeholder) on the Show control tab.`);
    return i;
  }

  private async set(input: VmixInput, fields: Map<string, string>) {
    const has = new Map(input.fields.map((f) => [f.toLowerCase(), f]));
    let n = 0;
    for (const [name, value] of fields) {
      const real = has.get(name.toLowerCase());
      if (!real) continue;
      await this.vmix(`?Function=${real.endsWith('.Source') ? 'SetImage' : 'SetText'}&Input=${encodeURIComponent(input.key || input.number)}&SelectedName=${encodeURIComponent(real)}&Value=${encodeURIComponent(value)}`);
      n++;
    }
    return n;
  }
  /** The first text field of a title whose name matches, else its first text field. */
  private textField(input: VmixInput, re: RegExp) {
    const texts = input.fields.filter((f) => f.endsWith('.Text'));
    return texts.find((f) => re.test(f)) ?? texts[0];
  }

  private pushUndo(overlays: Record<string, string>) {
    const undo = [...this.state.undo, overlays].slice(-20);
    this.patchState({ undo });
  }

  private async overlayIn(n: number, input: VmixInput, overlays: Record<string, string>) {
    if (overlays[n] === input.number) return false;
    await this.vmix(`?Function=OverlayInput${n}In&Input=${encodeURIComponent(input.key || input.number)}`);
    return true;
  }
  private async overlayOut(n: number, overlays: Record<string, string>) {
    if (!overlays[n]) return false;
    await this.vmix(`?Function=OverlayInput${n}Out`);
    return true;
  }

  /** Bring a graphic in on its overlay, after its data is in; takes off what it must not sit on. */
  private async bringIn(g: Graphic, input: VmixInput, snap: { overlays: Record<string, string> }) {
    this.pushUndo(snap.overlays);
    if (g.kind === 'board') { await this.overlayOut(getLtConfig(this.ctx.db).overlay, snap.overlays); if (snap.overlays[4]) await this.sceneOut(snap.overlays); }
    if (g.kind === 'scene') { await this.overlayOut(1, snap.overlays); await this.overlayOut(getLtConfig(this.ctx.db).overlay, snap.overlays); }
    if (g.kind === 'scene' && g.id !== 'break') this.stopRotation();
    await this.overlayIn(g.overlay, input, snap.overlays);
  }

  private async sceneOut(overlays: Record<string, string>) {
    this.stopRotation();
    await this.overlayOut(4, overlays);
  }

  /** The data of a graphic, set right before it comes in. */
  private async fill(g: Graphic, input: VmixInput) {
    const ev = activeEvent(this.ctx.db).id;
    if (g.id === 'results' || g.id === 'raceresults') {
      if (!this.config.fleetId) throw badRequest('Pick the race (group) on the Show control tab.');
      await pushResults(this.ctx, this.config.fleetId, input.key || input.number, this.fetcher);
    } else if (g.id === 'ticker') {
      await this.set(input, new Map([[this.textField(input, /ticker|text/i) ?? '', this.tickerText()]]));
    } else if (g.id === 'lineup5') {
      await this.set(input, this.lineupPartFields(1));
    }
    void ev;
  }

  /** The lineup lower third: the places in the set order, split into the first five and the rest. */
  lineupParts(): LtSailor[][] {
    const b = this.boats()[this.state.boat - 1];
    if (!b) throw badRequest('Pick a boat first.');
    const all = crewOf(this.ctx, b.id).filter((s) => s.lastName || s.firstName);
    const order = this.config.lineup5;
    const crew = [...order.map((k) => all.find((s) => s.slot === k)).filter((s): s is LtSailor => !!s), ...all.filter((s) => !order.includes(s.slot))];
    return [crew.slice(0, 5), crew.slice(5)].filter((p) => p.length);
  }
  lineupPartFields(part: number) {
    const b = this.boats()[this.state.boat - 1];
    const crew = this.lineupParts()[part - 1] ?? [];
    const f = new Map<string, string>();
    for (let i = 0; i < 5; i++) {
      const s = crew[i];
      f.set(`NAME ${i + 1}.Text`, s ? s.lastName.toUpperCase() : '');
      f.set(`FIRSTNAME ${i + 1}.Text`, s ? s.firstName.toUpperCase() : '');
      f.set(`NUMBER ${i + 1}.Text`, s?.number ?? '');
      f.set(`POSITION ${i + 1}.Text`, s ? s.position.toUpperCase() : '');
      f.set(`PHOTO ${i + 1}.Source`, s?.photo ?? '');
    }
    const t = listTeams(this.ctx).find((x) => x.id === b?.id);
    f.set('Flag.Source', img((t?.assets as Record<string, Asset>)?.flag_big));
    return f;
  }
  /** First press: the first five come in; second: the rest swap in (data change); third: out. */
  async lineupLt() {
    const g = this.graphic('lineup5');
    const snap = await this.snapshot();
    const input = this.need(g, snap.inputs);
    const on = snap.overlays[g.overlay] === input.number;
    const parts = this.lineupParts().length;
    const part = on ? this.state.lineupPart + 1 : 1;
    if (on && part > parts) {
      this.pushUndo(snap.overlays);
      await this.overlayOut(g.overlay, snap.overlays);
      this.patchState({ lineupPart: 0 });
      return { out: 'lineup5' };
    }
    await this.set(input, this.lineupPartFields(part));
    if (!on) await this.bringIn(g, input, snap);
    this.patchState({ lineupPart: part });
    return { in: 'lineup5', part, of: parts };
  }

  /** Team lower third, qualified version: its own title, team fields like the team lower third. */
  async qualified(boat: number) {
    const b = this.boat(boat);
    const g = this.graphic('teamq');
    const snap = await this.snapshot();
    const input = this.need(g, snap.inputs);
    const lt = getLtConfig(this.ctx.db);
    const t = listTeams(this.ctx).find((x) => x.id === b.id)!;
    const a = t.assets as Record<string, Asset>;
    await this.set(input, new Map([
      [`${lt.fields.top}.Text`, t.name.toUpperCase()], [`${lt.fields.bottom}.Text`, 'QUALIFIED'],
      [`${lt.fields.flag}.Source`, img(a[lt.flagSlot])], [`${lt.fields.emblem}.Source`, img(a[lt.emblemSlot])], [`${lt.fields.bar}.Source`, img(a[lt.barSlot])],
    ]));
    await this.bringIn({ ...g, overlay: lt.overlay }, input, snap);
    return { in: 'teamq', team: b.code };
  }

  tickerText() {
    const cfg = this.config;
    const sets = listGraphicSets(this.ctx.db, activeEvent(this.ctx.db).id, 'ticker');
    const id = this.state.tickerMode === 'end' ? cfg.tickerEnd : cfg.tickerNext;
    const s = sets.find((x) => x.id === id) ?? sets[this.state.tickerMode === 'end' ? 1 : 0] ?? sets[0];
    return s ? tickerText(s.data) : '';
  }

  // ---------- actions ----------
  async toggle(id: string) {
    const g = this.graphic(id);
    const snap = await this.snapshot();
    const input = this.need(g, snap.inputs);
    if (snap.overlays[g.overlay] === input.number) {
      this.pushUndo(snap.overlays);
      if (g.id === 'break') await this.sceneOut(snap.overlays); else await this.overlayOut(g.overlay, snap.overlays);
      return { out: g.id };
    }
    await this.fill(g, input);
    await this.bringIn(g, input, snap);
    if (g.id === 'break') this.startRotation();
    return { in: g.id, input: input.title };
  }

  async commentator(role: string) {
    const roles: Record<string, string[]> = { host: ['host commentator'], guest: ['guest commentator', 'guest'], water: ['on-water commentator'], studio: ['host commentator'] };
    const want = roles[role] ?? [role.toLowerCase()];
    const ev = activeEvent(this.ctx.db).id;
    const people = listPeople(this.ctx, ev).filter((p) => want.includes((p.role || '').toLowerCase()) && p.name);
    if (!people.length) throw badRequest(`Nobody with the role ${want[0]} in People (General graphics).`);
    const p = people[0];
    const g = this.graphic('comm');
    const snap = await this.snapshot();
    const photo = p.photo ? img(p.photo as unknown as Asset) : '';
    const withPhoto = photo ? this.resolve({ ...g, inputs: g.inputs.slice(0, 1) }, snap.inputs) : undefined;
    const input = withPhoto ?? this.resolve({ ...g, inputs: g.inputs.slice(1) }, snap.inputs) ?? this.need(g, snap.inputs);
    const f = new Map<string, string>([['Top text.Text', p.name.toUpperCase()], ['Bottom text.Text', (p.title || p.role).toUpperCase()], ['PHOTO.Source', photo]]);
    // on-air swap of the same title animates; a different title comes in on the overlay
    await this.set(input, f);
    await this.bringIn({ ...g }, input, snap);
    return { in: 'comm', input: input.title, person: p.name };
  }

  async lineup(boat: number) {
    const b = this.boat(boat);
    const g = this.graphic('lineup');
    const snap = await this.snapshot();
    const lu = loadLineup(this.ctx.db, activeEvent(this.ctx.db).id, b.id).data;
    const input = this.need(g, snap.inputs, { crew: lu.rows.filter((r) => r.firstName || r.lastName).length });
    const team = listTeams(this.ctx).find((t) => t.id === b.id)!;
    const a = team.assets as Record<string, Asset>;
    const crew = new Map(crewOf(this.ctx, b.id).map((s) => [s.slot, s]));
    const f = new Map<string, string>([['Flag.Source', img(a.flag_big)], ['Emblem.Source', img(a.emblem_light)]]);
    for (const d of slotDefs(lu.extra)) {
      const r = lu.rows.find((x) => x.slot === d.key);
      const s = crew.get(d.key);
      f.set(`${d.fields.name}.Text`, (r?.firstName ?? '').toUpperCase());
      f.set(`${d.fields.surname}.Text`, (r?.lastName ?? '').toUpperCase());
      f.set(`${d.fields.number}.Text`, r?.number ?? '');
      f.set(`${d.fields.position}.Text`, (r?.position ?? '').toUpperCase());
      f.set(`${d.fields.photo}.Source`, s?.photo ?? '');
    }
    await this.set(input, f);
    await this.bringIn(g, input, snap);
    return { in: 'lineup', team: b.code, input: input.title };
  }

  async bug(which: string) {
    const list = this.announcements();
    const a = which === 'thanks'
      ? list.find((x) => /thank/i.test(x.data.text || x.name)) ?? { name: 'Thanks', data: { text: 'THANKS FOR WATCHING' } }
      : list[Number(which) - 1];
    if (!a) throw badRequest(`No announcement ${which}. Add it under General graphics → Announcements.`);
    const text = a.data.text || a.name.toUpperCase();
    const g = this.graphic('bug');
    const snap = await this.snapshot();
    const input = this.need(g, snap.inputs);
    await this.set(input, new Map([[this.textField(input, /text/i) ?? '', text]]));
    this.patchState({ bug: text });
    await this.bringIn(g, input, snap);
    return { in: 'bug', text };
  }

  /** Lower thirds of a sailor on the selected boat, by key index (1–16, sorted by shirt number) or by shirt number. */
  async sailor(index: number | null, shirt?: string) {
    const list = this.sailors();
    const s = shirt ? list.find((x) => x.number === shirt) : list[(index ?? 0) - 1];
    if (!s) throw badRequest(shirt ? `No sailor with number ${shirt} on BOAT ${this.state.boat}.` : 'No sailor on this key.');
    const b = this.boat(this.state.boat);
    const mode = this.state.photo;
    const cfg = getLtConfig(this.ctx.db);
    const snap = await this.snapshot();
    if (snap.overlays[1]) { this.pushUndo(snap.overlays); await this.overlayOut(1, snap.overlays); }
    // photo mode: the lower thirds pick the photo title when the sailor has a photo; OFF forces the other one
    if (mode === 'off' && s.photo) return this.lt.showSailor(b.code, s.slot, { forceNoPhoto: true });
    void cfg;
    return this.lt.showSailor(b.code, s.slot);
  }

  async undo() {
    const st = this.state;
    const prev = st.undo.at(-1);
    if (!prev) throw badRequest('Nothing to undo.');
    const snap = await this.snapshot();
    for (let n = 1; n <= 4; n++) {
      const want = prev[n] ?? '';
      if (want === (snap.overlays[n] ?? '')) continue;
      if (!want) await this.vmix(`?Function=OverlayInput${n}Out`);
      else await this.vmix(`?Function=OverlayInput${n}In&Input=${want}`);
    }
    this.patchState({ undo: st.undo.slice(0, -1) });
    return { restored: prev };
  }

  async allOut() {
    this.stopRotation();
    const snap = await this.snapshot();
    this.pushUndo(snap.overlays);
    for (let n = 1; n <= 4; n++) await this.overlayOut(n, snap.overlays);
    return { allOut: true };
  }

  /** First press arms, a second within 3 s cuts every overlay at once (no animation). */
  async panic() {
    const now = Date.now();
    const st = this.state;
    if (now - st.armedPanic > 3000) { this.patchState({ armedPanic: now }); void this.pushLabels(); return { armed: true }; }
    this.stopRotation();
    this.patchState({ armedPanic: 0 });
    for (let n = 1; n <= 4; n++) await this.vmix(`?Function=OverlayInput${n}Off`);
    return { panic: true };
  }

  // ---------- break scene ----------
  slides() {
    const out: { kind: 'schedule' | 'results'; fleetId?: string }[] = [{ kind: 'schedule' }];
    for (const f of this.breakFleets()) out.push({ kind: 'results', fleetId: f });
    return out;
  }
  async nextSlide() {
    const slides = this.slides();
    const st = this.state;
    const i = (st.slide + 1) % slides.length;
    const s = slides[i];
    const { inputs } = await this.snapshot();
    const g = this.graphic(s.kind === 'schedule' ? 'schedule' : 'results');
    const input = this.need(g, inputs);
    if (s.kind === 'results' && s.fleetId) await pushResults(this.ctx, s.fleetId, input.key || input.number, this.fetcher);
    const scene = this.need(this.graphic('break'), inputs);
    await this.vmix(`?Function=SetMultiViewOverlay&Input=${encodeURIComponent(scene.key || scene.number)}&Value=${encodeURIComponent(`${this.config.breakLayer},${input.key || input.number}`)}`);
    this.patchState({ slide: i });
    return { slide: i, of: slides.length, showing: s };
  }
  startRotation() {
    this.stopRotation();
    this.patchState({ rotating: true });
    this.rotation = setInterval(() => { this.nextSlide().catch((e) => this.log(`Break rotation: ${e?.message ?? e}`)); }, this.config.rotateSeconds * 1000);
    this.rotation.unref?.();
  }
  stopRotation() {
    if (this.rotation) clearInterval(this.rotation);
    this.rotation = null;
    if (this.state.rotating) this.patchState({ rotating: false });
  }
  async toggleRotation() { if (this.rotation) this.stopRotation(); else this.startRotation(); return { rotating: !!this.rotation }; }

  async tickerMode() {
    const mode = this.state.tickerMode === 'next' ? 'end' : 'next';
    this.patchState({ tickerMode: mode });
    // the ticker on air changes its text in place (DataChange), the scene stays
    const { inputs } = await this.snapshot().catch(() => ({ inputs: [] as VmixInput[] }));
    const t = this.resolve(this.graphic('ticker'), inputs);
    if (t) await this.set(t, new Map([[this.textField(t, /ticker|text/i) ?? '', this.tickerText()]]));
    return { tickerMode: mode };
  }

  // ---------- the key router ----------
  async run(action: string) {
    const [kind, arg = ''] = action.split(':');
    try {
      const r = await this.dispatch(kind, arg);
      this.patchState({ last: { at: new Date().toISOString(), action, error: null } });
      void this.pushLabels();
      return r;
    } catch (e: any) {
      this.patchState({ last: { at: new Date().toISOString(), action, error: String(e?.message ?? e) } });
      throw e;
    }
  }
  private async dispatch(kind: string, arg: string): Promise<unknown> {
    switch (kind) {
      case 'show': return arg === 'lineup5' ? this.lineupLt() : this.toggle(arg);
      case 'qualified': return this.qualified(Number(arg));
      case 'comm': return this.commentator(arg);
      case 'anthem': return this.lt.showTeam(this.boat(Number(arg)).code);
      case 'lineup': return this.lineup(Number(arg));
      case 'boat': { const n = Number(arg); this.boat(n); this.patchState({ boat: n }); return { boat: n }; }
      case 'sailor': return this.sailor(Number(arg));
      case 'shirt': return this.sailor(null, arg);
      case 'photo': { const m = ({ auto: 'on', on: 'off', off: 'auto' } as const)[this.state.photo]; this.patchState({ photo: m }); return { photo: m }; }
      case 'next': return this.lt.nextLine();
      case 'teamlt': return this.lt.showTeam(this.boat(this.state.boat).code);
      case 'ltout': return this.lt.out();
      case 'bug': return this.bug(arg);
      case 'bugout': { const s = await this.snapshot(); this.pushUndo(s.overlays); await this.overlayOut(3, s.overlays); return { out: 'bug' }; }
      case 'boardout': { const s = await this.snapshot(); this.pushUndo(s.overlays); await this.overlayOut(1, s.overlays); return { out: 'board' }; }
      case 'breakout': case 'scene4out': { const s = await this.snapshot(); this.pushUndo(s.overlays); await this.sceneOut(s.overlays); return { out: 'scene' }; }
      case 'rotate': return this.toggleRotation();
      case 'nextslide': return this.nextSlide();
      case 'tickermode': return this.tickerMode();
      case 'undo': return this.undo();
      case 'allout': return this.allOut();
      case 'panic': return this.panic();
      default: throw badRequest(`Unknown action ${kind}`);
    }
  }

  // ---------- keys: texts and colours ----------
  /** What a key says and its colour now. */
  async keyLook(key: DeckKey, ctxt?: { overlays: Record<string, string>; inputs: VmixInput[] }) {
    const [kind, arg = ''] = key.action.split(':');
    const st = this.state;
    let text = key.text;
    let onAir = false, active = false, empty = false;
    const boats = this.boats();
    const ov = ctxt?.overlays ?? {};
    const isOn = (id: string) => { if (!ctxt) return false; const g = this.graphics().find((x) => x.id === id); const i = g && this.resolve(g, ctxt.inputs); return !!(g && i && ov[g.overlay] === i.number); };
    if (kind === 'anthem' || kind === 'lineup' || kind === 'boat' || kind === 'qualified') {
      const b = boats[Number(arg) - 1];
      text = b ? (kind === 'boat' ? `BOAT ${arg}\\n${b.code}` : `${({ anthem: 'ANTHEM', lineup: 'LINEUP', qualified: 'QUALIFIED' } as Record<string, string>)[kind]}\\n${b.code}`) : `${key.text}\\n—`;
      empty = !b;
      if (kind === 'boat') active = st.boat === Number(arg);
    } else if (kind === 'sailor') {
      const s = this.sailors()[Number(arg) - 1];
      const b = boats[st.boat - 1];
      text = s ? `#${s.number || '?'}${s.photo ? ' ●' : ''}\\n${s.position.toUpperCase()}\\n${s.lastName.toUpperCase().slice(0, 10)}${b ? ` ${b.code}` : ''}` : '';
      empty = !s;
    } else if (kind === 'bug' && /^\d+$/.test(arg)) {
      const a = this.announcements()[Number(arg) - 1];
      text = a ? (a.data.text || a.name).toUpperCase().slice(0, 24) : '';
      empty = !a;
    } else if (kind === 'photo') text = `PHOTO\\n${st.photo.toUpperCase()}`;
    else if (kind === 'tickermode') text = st.tickerMode === 'end' ? 'TICKER:\\nEND OF DAY' : 'TICKER:\\nNEXT RACE';
    else if (kind === 'rotate') { text = st.rotating ? 'ROTATION\\n⏸ STOP' : 'ROTATION\\n▶ START'; active = st.rotating; }
    else if (kind === 'panic' && Date.now() - st.armedPanic < 3000) { text = 'PANIC?\\nPRESS AGAIN'; onAir = true; }
    if (kind === 'show') onAir = isOn(arg);
    if (key.action === 'show:lineup5' && st.lineupPart) text = `LINEUP LT\\n${st.lineupPart === 1 ? '▶ PART 2' : 'OUT'}`;
    if (kind === 'break') onAir = isOn('break');
    const colours: Record<string, string> = { board: '#1e3a8a', lt: '#166534', bug: '#a16207', scene: '#0f766e', team: '#1e3a5f', sailor: '#27303f', nav: '#3f3f46', safety: '#7c2d12', mode: '#4c1d95' };
    let bg = colours[key.kind] ?? '#3f3f46';
    if (key.action === 'undo') bg = '#6b21a8';
    if (key.action === 'allout') bg = '#c2410c';
    if (key.action === 'panic') bg = '#991b1b';
    if (active) bg = '#d97706';
    if (onAir) bg = '#dc2626';
    if (empty) bg = '#18181b';
    return { text, bg, onAir, active, empty };
  }

  async view() {
    const snap = await this.snapshot().catch(() => null);
    const cfg = this.config;
    const pages = deckPages(cfg);
    const looks = await Promise.all(pages.map(async (p) => ({ ...p, keys: await Promise.all(p.keys.map((r) => Promise.all(r.map(async (k) => (k ? { ...k, ...(await this.keyLook(k, snap ?? undefined)) } : null))))) })));
    return {
      config: cfg, state: { ...this.state, undo: undefined, undoDepth: this.state.undo.length },
      vmix: snap ? { ok: true, overlays: snap.overlays } : { ok: false, overlays: {} },
      graphics: this.graphics().map((g) => {
        const i = snap ? this.resolve(g, snap.inputs) : undefined;
        return { ...g, input: i?.title ?? null, onAir: !!(i && snap!.overlays[g.overlay] === i.number), fields: i?.fields.length ?? 0 };
      }),
      boats: this.boats(), sailors: this.sailors().map((s) => ({ slot: s.slot, number: s.number, name: `${s.firstName} ${s.lastName}`.trim(), position: s.position, photo: !!s.photo })),
      pages: looks,
    };
  }

  /** Key texts and colours into Companion (POST /api/location/<page>/<row>/<col>/style), only what changed. */
  async pushLabels(force = false) {
    const cfg = this.config;
    const lt = getLtConfig(this.ctx.db);
    if (!cfg.labels || !lt.companionUrl) return { sent: 0 };
    if (force) this.labels.clear();
    let n = 0;
    try {
      const snap = await this.snapshot().catch(() => undefined);
      for (const p of deckPages(cfg)) {
        for (const [r, row] of p.keys.entries()) {
          for (const [c, key] of row.entries()) {
            if (!key || key.kind === 'nav') continue;
            const l = await this.keyLook(key, snap);
            const q = `text=${encodeURIComponent(l.text)}&bgcolor=${encodeURIComponent(l.bg)}&color=${encodeURIComponent('#ffffff')}&size=auto`;
            const id = `${p.page}/${r}/${c}`;
            if (this.labels.get(id) === q) continue;
            const res = await this.fetcher(`${lt.companionUrl}/api/location/${id}/style?${q}`, { method: 'POST', signal: AbortSignal.timeout(3000) });
            if (res.ok) { this.labels.set(id, q); n++; }
          }
        }
      }
    } catch (e: any) {
      this.log(`Companion labels: ${e?.message ?? e}`);
    }
    return { sent: n };
  }

  /** Keeps the keys in step with vMix and line-up changes made elsewhere. */
  start(ms = 2000) { this.timer = setInterval(() => { void this.pushLabels(); }, ms); this.timer.unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); this.stopRotation(); }

  /**
   * Placeholders: every registry input missing in vMix gets an Image input with that name: a transparent 1920×1080 PNG
   * with a small orange corner mark. Only inputs are added; nothing else in vMix changes. Replace it later with the
   * GTZIP title and give the title the same name.
   */
  async addPlaceholders() {
    const { inputs } = await this.snapshot();
    const added: string[] = [];
    const dir = path.join(this.ctx.assetsDir, 'placeholders');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'placeholder.png');
    if (!fs.existsSync(file)) fs.writeFileSync(file, encodePng(1920, 1080, (x, y) => (x < 24 && y < 24 ? [245, 158, 11, 255] : [0, 0, 0, 0])));
    const root = getSetting(this.ctx.db, 'paths.vmixAssetsRoot');
    const vmixPath = root ? joinVmixPath(root, 'placeholders/placeholder.png') : file;
    for (const g of this.graphics()) {
      if (this.resolve(g, inputs)) continue;
      const name = g.inputs.map((x) => x.replace('{n}', String(this.boats().length || 4)).replace('{crew}', '9')).find((x) => !x.includes('{'));
      if (!name) continue;
      await this.vmix(`?Function=AddInput&Value=${encodeURIComponent(`Image|${vmixPath}`)}`);
      const after = parseVmixXml(await this.vmix(''));
      const fresh = after.find((i) => !inputs.some((o) => o.key === i.key));
      if (!fresh) throw badRequest(`vMix did not add the placeholder image (${vmixPath}). Check the vMix assets folder in Settings → Files and paths.`);
      await this.vmix(`?Function=SetInputName&Input=${encodeURIComponent(fresh.key || fresh.number)}&Value=${encodeURIComponent(name)}`);
      inputs.push({ ...fresh, title: name });
      added.push(name);
    }
    return { added, image: vmixPath };
  }
}

// ---------- Companion page files ----------
const COLOURS = (kind: string) => ({ board: 0x1e3a8a, lt: 0x166534, bug: 0xa16207, scene: 0x0f766e, team: 0x1e3a5f, sailor: 0x27303f, nav: 0x3f3f46, safety: 0x7c2d12, mode: 0x4c1d95 } as Record<string, number>)[kind] ?? 0x3f3f46;

const control = (text: string, bg: number, down: unknown[]) => ({
  type: 'button',
  style: { text, size: 'auto', png64: null, alignment: 'center:center', pngalignment: 'center:center', color: 0xffffff, bgcolor: bg, show_topbar: 'default' },
  options: { relativeDelay: false, rotaryActions: false, stepAutoProgress: true },
  feedbacks: [],
  steps: { 0: { action_sets: { down, up: [] }, options: { runWhileHeld: [] } } },
});
const CONN = 'ssl_dashboard_show';
const http = (id: string, url: string) => ({ id, action: 'get', instance: CONN, options: { url, header: '' }, delay: 0 });
const setPage = (id: string, page: number) => ({ id, action: 'set_page', instance: 'internal', options: { controller: 'self', controller_from_variable: false, controller_variable: '', page, page_from_variable: false, page_variable: '' }, delay: 0 });

function pageFile(name: string, page: number, controls: Record<number, Record<number, unknown>>) {
  return {
    version: 4, type: 'page',
    page: { name, controls, gridSize: { minColumn: 0, maxColumn: 7, minRow: 0, maxRow: 3 } },
    instances: { [CONN]: { instance_type: 'generic-http', label: 'ssl_dashboard_show', enabled: true, isFirstInit: false, lastUpgradeIndex: -1, sortOrder: 0, config: { prefix: '', proxyAddress: '', rejectUnauthorized: true } } },
    oldPageNumber: page,
  };
}

/** One Companion page export (format 4, upgraded by every later Companion on import) per deck page, plus the fallback page. */
export function companionFiles(cfg: ShowConfig, base: string, vmixBase: string, graphics: Graphic[]) {
  const b = base.replace(/\/+$/, '');
  const files: { name: string; page: number; file: ReturnType<typeof pageFile> }[] = [];
  for (const p of deckPages(cfg)) {
    const controls: Record<number, Record<number, unknown>> = {};
    p.keys.forEach((row, r) => row.forEach((key, c) => {
      if (!key) return;
      const id = `p${p.page}r${r}c${c}`;
      const act = key.kind === 'nav' ? setPage(id, Number(key.action.split(':')[1])) : http(id, `${b}/api/show/do?a=${encodeURIComponent(key.action)}`);
      (controls[r] ??= {})[c] = control(key.text, COLOURS(key.kind), [act]);
    }));
    files.push({ name: `deck${p.deck}-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, page: p.page, file: pageFile(`SSL ${p.name}`, p.page, controls) });
  }
  // fallback: straight to vMix, no dashboard needed; the data stays as it was last set
  const v = vmixBase.replace(/\/+$/, '');
  const fb: Record<number, Record<number, unknown>> = {};
  const first = (g: Graphic) => g.inputs.map((x) => x.replace('{n}', '4').replace('{crew}', '9')).find((x) => !x.includes('{'))!;
  const pick = ['welcome', 'schedule', 'matchboard', 'results', 'raceresults', 'compare', 'course', 'officials', 'weather', 'comm', 'bug', 'ticker', 'replay', 'socials', 'sponsors', 'break', 'lbar'];
  const fbKeys = pick.map((id) => graphics.find((g) => g.id === id)).filter((g): g is Graphic => !!g);
  fbKeys.slice(0, 16).forEach((g, i) => {
    const r = Math.floor(i / 8), c = i % 8;
    (fb[r] ??= {})[c] = control(`FB\\n${g.label.toUpperCase().slice(0, 14)}`, COLOURS(g.kind), [http(`fb${i}`, `${v}/api/?Function=OverlayInput${g.overlay}&Input=${encodeURIComponent(first(g))}`)]);
  });
  fb[2] = {
    0: control('FB OUT\\nBOARD', 0x1e3a8a, [http('fbo1', `${v}/api/?Function=OverlayInput1Out`)]),
    1: control('FB OUT\\nLT', 0x166534, [http('fbo2', `${v}/api/?Function=OverlayInput2Out`)]),
    2: control('FB OUT\\nBUG', 0xa16207, [http('fbo3', `${v}/api/?Function=OverlayInput3Out`)]),
    3: control('FB OUT\\nSCENE', 0x0f766e, [http('fbo4', `${v}/api/?Function=OverlayInput4Out`)]),
    7: control('FB CUT\\nALL', 0x991b1b, [1, 2, 3, 4].map((n) => http(`fbx${n}`, `${v}/api/?Function=OverlayInput${n}Off`))),
  };
  fb[3] = {
    0: control('DECK 1\\nHOME', 0x3f3f46, [setPage('fbn1', cfg.deck1Page)]),
    1: control('DECK 2\\nHOME', 0x3f3f46, [setPage('fbn2', cfg.deck2Page)]),
  };
  files.push({ name: 'fallback', page: cfg.fallbackPage, file: pageFile('SSL FALLBACK', cfg.fallbackPage, fb) });
  return files;
}
