import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { activeEvent, getSetting, setSetting } from '../db/db.js';
import { AssetCtx } from './assets.js';
import { badRequest, notFound } from './errors.js';
import { getSetDetail, listSets } from './fleets.js';
import { listPeople } from './general.js';
import { imagePath, listGraphicSets, tickerText } from './graphicSets.js';
import { tickerAuto } from './groups.js';
import { loadLineup, slotDefs } from './lineups.js';
import { crewOf, getLtConfig, getLtState, LowerThirds, LtSailor, ltFields, ltTeams } from './lowerthirds.js';
import { teamPictureFor } from './ltTitle.js';
import { teamKeyColours, teamKeyLook } from './nationColours.js';
import { listTeams } from './teams.js';
import { encodePng } from './png.js';
import { raceRunFields } from './raceRuns.js';
import { joinVmixPath } from './paths.js';
import { compareFields, showDataFields } from './showData.js';
import { todayIn } from './dates.js';
import { findInput, parseVmixXml, pushResults, resultFieldsFor, titleFieldMatcher, VmixInput, vmixUrl } from './vmixResults.js';

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

/** The bottom line of the qualified team lower third. */
export const QUALIFIED_TEXT = 'Qualified for the finals of SSL Gold Cup';

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
  /** the fleet (group) racing now: its teams are teams 1–4 on the keys, in fleet order */
  fleetId: z.string().default(''),
  /** the race of that group whose times at the marks the Race results board shows */
  race: z.number().int().min(1).max(12).default(1),
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
  /** live key texts and on-air colours written into Companion while the show runs: off, the preset carries the texts */
  liveKeys: z.boolean().default(false),
  /** places on the lineup lower third, in this order: the first 5, then the rest on the second press */
  /** Stream Deck key edits by place ("<page index>/<row>/<col>"): another action ('' = empty key), own text ({auto} = the live text), key and text colour */
  keys: z.record(z.string(), z.object({ action: z.string().optional(), text: z.string().optional(), bg: z.string().optional(), fg: z.string().optional() })).default({}),
  /** key colour per kind of key (board, lt, bug, …), overriding the built-in palette */
  kindColours: z.record(z.string(), z.string()).default({}),
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
  bugId: string; // its version (General graphics → Announcements)
  tickerId: string; // the ticker version on air from a ticker key ('' = TICKER key: next race / end of day)
  lineupPart: number; // 0 = off, 1 = first five, 2 = the rest
  compareMark: 'flag' | 'emblem'; // what Team comparison shows by each team
}
const EMPTY_STATE: ShowState = { tickerMode: 'next', boat: 1, photo: 'auto', rotating: false, slide: 0, armedPanic: 0, undo: [], last: null, bug: '', bugId: '', tickerId: '', lineupPart: 0, compareMark: 'flag' };
export function getShowState(db: AssetCtx['db']): ShowState {
  try { return { ...EMPTY_STATE, ...JSON.parse(getSetting(db, STATE) || '{}') }; } catch { return { ...EMPTY_STATE }; }
}
const saveShowState = (db: AssetCtx['db'], s: ShowState) => setSetting(db, STATE, JSON.stringify(s));

type Fetch = (url: string, init?: { signal?: AbortSignal; method?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
type Asset = { vmixPath: string | null; storedPath: string | null; enteredPath: string | null } | undefined | null;
const img = (a: Asset) => (a ? a.vmixPath ?? a.storedPath ?? a.enteredPath ?? '' : '');

export const overlayOf = (xml: string, n: number) => xml.match(new RegExp(`<overlay number="${n}"[^>]*>(\\d+)</overlay>`))?.[1] ?? '';

/** The keys of both decks. Row 4 (index 3) is the same on every page: HOME ◀ ▶ … UNDO ALL OUT PANIC. */
export interface DeckKey { action: string; text: string; kind: Kind | 'team' | 'sailor' | 'nav' | 'safety' | 'mode'; custom?: string; bg?: string; fg?: string; team?: string }
export interface DeckPage { deck: 1 | 2 | 0; name: string; page: number; keys: (DeckKey | null)[][] }

const k = (action: string, text: string, kind: DeckKey['kind']): DeckKey => ({ action, text, kind });
const row8 = (...keys: (DeckKey | null)[]) => Array.from({ length: 8 }, (_, i) => keys[i] ?? null);

/**
 * Page numbers of the Companion preset (one file with every page): deck 1 starts on page 1, deck 2 on page 3, the
 * fallback page is 8 and every team has a page of its own from 9 on, its places with the sailors' names on the keys.
 */
export const PRESET_PAGES = { deck1: 1, deck2: 3, fallback: 8, teams: 9 } as const;

/** A team page: the team and its places (slot, place label, the name on the key). */
export interface PresetTeam { code: string; name: string; crew: { slot: string; label: string; name: string }[] }

export function deckPages(cfg: ShowConfig, teams: PresetTeam[] = []): DeckPage[] {
  return applyKeyEdits(cfg, defaultDeckPages(cfg, teams));
}

function defaultDeckPages(cfg0: ShowConfig, teams: PresetTeam[] = []): DeckPage[] {
  const cfg = { ...cfg0, deck1Page: PRESET_PAGES.deck1, deck2Page: PRESET_PAGES.deck2, fallbackPage: PRESET_PAGES.fallback };
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
        row8(k('anthem:1', 'ANTHEM\\nTEAM 1', 'team'), k('anthem:2', 'ANTHEM\\nTEAM 2', 'team'), k('anthem:3', 'ANTHEM\\nTEAM 3', 'team'), k('anthem:4', 'ANTHEM\\nTEAM 4', 'team'),
          k('lineup:1', 'LINEUP\\nTEAM 1', 'board'), k('lineup:2', 'LINEUP\\nTEAM 2', 'board'), k('lineup:3', 'LINEUP\\nTEAM 3', 'board'), k('lineup:4', 'LINEUP\\nTEAM 4', 'board')),
        row8(k('show:course', 'RACE\\nCOURSE', 'board'), k('show:officials', 'OFFICIALS', 'board'), k('show:weather', 'WEATHER', 'board'), k('comm:water', 'ON-WATER\\nLT', 'lt'),
          k('comm:studio', 'STUDIO\\n+WATER LT', 'lt'), k('ltout', 'LT OUT', 'lt'), k('comparemark', 'COMPARE:\\nFLAG ⇄ EMBLEM', 'mode')),
        nav(p1, p1 + 1, 'AFTER', p1 + 1, 'AFTER'),
      ],
    },
    {
      deck: 1, name: 'C-E AFTER / BREAK', page: p1 + 1, keys: [
        row8(k('show:raceresults', 'RACE\\nRESULTS', 'board'), k('show:results', 'GROUP\\nRESULTS', 'board'), k('boardout', 'BOARD\\nOUT', 'board'),
          k('qualified:1', 'QUALIFIED\\nTEAM 1', 'team'), k('qualified:2', 'QUALIFIED\\nTEAM 2', 'team'), k('qualified:3', 'QUALIFIED\\nTEAM 3', 'team'), k('qualified:4', 'QUALIFIED\\nTEAM 4', 'team'), k('ltout', 'LT OUT', 'lt')),
        row8(k('show:break', 'BREAK\\nSCENE', 'scene'), k('breakout', 'BREAK\\nOUT', 'scene'), k('rotate', 'ROTATION\\n⏯', 'scene'), k('nextslide', 'NEXT\\nSLIDE', 'scene'),
          k('tickermode', 'TICKER:\\nNEXT RACE', 'mode')),
        row8(k('ticker:thanks', 'THANKS FOR\\nWATCHING', 'bug'), k('show:lbar', 'L-BAR', 'scene'), k('show:sponsors', 'SPONSORS\\nBAR', 'bug'), k('show:ticker', 'TICKER', 'bug'), k('bugout', 'BUG OUT', 'bug')),
        nav(p1, p1, 'BEFORE', p1, 'BEFORE'),
      ],
    },
    {
      // every team on a key: it opens the team's own page (its places with the sailors' names)
      deck: 2, name: 'TEAMS', page: p2, keys: [
        ...[0, 1, 2].map((r) => row8(...Array.from({ length: 8 }, (_, c) => {
          const t = teams[r * 8 + c];
          return t ? { ...k(`nav:${PRESET_PAGES.teams + r * 8 + c}`, `${t.code}\\n${t.name.toUpperCase().slice(0, 12)}`, 'team'), team: t.code } : null;
        }))),
        nav(p2, p2 + 4, 'TICKERS', p2 + 1, 'EXTRAS'),
      ],
    },
    {
      deck: 2, name: 'EXTRAS', page: p2 + 1, keys: [
        row8(...Array.from({ length: 8 }, (_, i) => k(`bug:${i + 1}`, '—', 'bug'))),
        row8(k('show:ticker', 'TICKER', 'bug'), k('bugout', 'BUG OUT', 'bug'), k('show:replay', 'REPLAY\\nBUG', 'bug'), k('show:socials', 'SOCIALS', 'bug'),
          k('show:sponsors', 'SPONSORS\\nBAR', 'bug'), k('show:lbar', 'L-BAR', 'scene'), k('show:lineup5', 'LINEUP\\nLT', 'lt')),
        row8(k('show:pip_replay', 'PiP\\nREPLAY+OB', 'scene'), k('show:pip_live', 'PiP\\nOB+LIVE', 'scene'), k('show:pip_4', 'PiP\\n4 ONBOARDS', 'scene'), k('scene4out', 'PiP OUT', 'scene'), null, null, null, k('photo', 'PHOTO\\nMODE', 'mode')),
        nav(p2, p2, 'TEAMS', p2 + 2, 'BUGS 1'),
      ],
    },
    // every announcement and every ticker on a key of its own, by position: a version added in General graphics is
    // on the next free key at once (Companion keys too, they call the position)
    slotPage(p2 + 2, 'BUGS 1', 'bug', 0, nav(p2, p2 + 1, 'EXTRAS', p2 + 3, 'BUGS 2')),
    slotPage(p2 + 3, 'BUGS 2', 'bug', SLOTS_PER_PAGE, nav(p2, p2 + 2, 'BUGS 1', p2 + 4, 'TICKERS')),
    slotPage(p2 + 4, 'TICKERS', 'ticker', 0, nav(p2, p2 + 3, 'BUGS 2', p2, 'TEAMS')),
    ...teams.map((t, i) => teamPage(t, i, teams, p2)),
  ];
}

/** A team's page on deck 2: its lower thirds and boards, its places (sailor's name on the key), ◀ ▶ to the next team. */
function teamPage(t: PresetTeam, i: number, teams: PresetTeam[], teamsPage: number): DeckPage {
  const page = PRESET_PAGES.teams + i;
  const other = (d: number) => teams[(i + d + teams.length) % teams.length];
  const tk = (action: string, text: string, kind: DeckKey['kind']): DeckKey => ({ ...k(action, text, kind), team: t.code });
  const places = t.crew.slice(0, 16).map((c) => tk(`sailorof:${t.code}/${c.slot}`, `${c.label.toUpperCase()}\\n${c.name.toUpperCase().slice(0, 14) || '—'}`, 'sailor'));
  return {
    deck: 2, name: t.code, page, keys: [
      row8(tk(`teamlt:${t.code}`, `TEAM LT\\n${t.code}`, 'lt'), tk(`qualified:${t.code}`, `QUALIFIED\\n${t.code}`, 'lt'), tk(`lineup:${t.code}`, `LINEUP\\n${t.code}`, 'board'),
        k('next', 'NEXT\\nRESULT', 'lt'), null, null, k('boardout', 'BOARD\\nOUT', 'board'), k('ltout', 'LT OUT', 'lt')),
      row8(...places.slice(0, 8)),
      row8(...places.slice(8, 16)),
      row8(k(`nav:${teamsPage}`, 'TEAMS', 'nav'), k(`nav:${PRESET_PAGES.teams + teams.indexOf(other(-1))}`, `◀\\n${other(-1).code}`, 'nav'),
        k(`nav:${PRESET_PAGES.teams + teams.indexOf(other(1))}`, `▶\\n${other(1).code}`, 'nav'), k(`nav:${teamsPage + 1}`, 'EXTRAS', 'nav'), null,
        k('undo', 'UNDO', 'safety'), k('allout', 'ALL\\nOUT', 'safety'), k('panic', 'PANIC\\n(press 2×)', 'safety')),
    ],
  };
}

/** Keys of a page of announcement or ticker versions: 3 rows of 8, numbered from `from` + 1. */
const SLOTS_PER_PAGE = 24;
function slotPage(page: number, name: string, kind: 'bug' | 'ticker', from: number, navRow: (DeckKey | null)[]): DeckPage {
  const rows = [0, 1, 2].map((r) => row8(...Array.from({ length: 8 }, (_, c) => k(`${kind}:${from + r * 8 + c + 1}`, '—', 'bug'))));
  return { deck: 2, name, page, keys: [...rows, navRow] };
}

export const KEY_COLOURS: Record<string, string> = { board: '#1e3a8a', lt: '#166534', bug: '#a16207', scene: '#0f766e', team: '#1e3a5f', sailor: '#27303f', nav: '#3f3f46', safety: '#7c2d12', mode: '#4c1d95' };
const SPECIAL_BG: Record<string, string> = { undo: '#6b21a8', allout: '#c2410c', panic: '#991b1b' };
/** The colour a key has when nothing is on air: its own, else its kind's. */
export const keyBg = (cfg: ShowConfig, key: DeckKey) => key.bg || cfg.kindColours[key.kind] || SPECIAL_BG[key.action] || KEY_COLOURS[key.kind] || '#3f3f46';

/** Every action a key can have, with the text and kind a key with that action gets by default. */
export function keyActions(cfg: ShowConfig): DeckKey[] {
  const out = new Map<string, DeckKey>();
  for (const p of defaultDeckPages(cfg)) for (const row of p.keys) for (const key of row) if (key && !out.has(key.action)) out.set(key.action, { action: key.action, text: key.text, kind: key.kind });
  for (const g of DEFAULT_GRAPHICS) if (!out.has(`show:${g.id}`)) out.set(`show:${g.id}`, { action: `show:${g.id}`, text: g.label.toUpperCase(), kind: g.kind });
  return [...out.values()];
}

function applyKeyEdits(cfg: ShowConfig, pages: DeckPage[]): DeckPage[] {
  if (!Object.keys(cfg.keys).length) return pages;
  const actions = new Map(keyActions(cfg).map((a) => [a.action, a]));
  return pages.map((p, pi) => ({
    ...p,
    keys: p.keys.map((row, r) => row.map((key, c) => {
      const o = cfg.keys[`${pi}/${r}/${c}`];
      if (!o) return key;
      let next: DeckKey | null = key;
      if (o.action !== undefined) {
        if (!o.action) return null;
        const a = actions.get(o.action);
        next = a ? { ...a } : { action: o.action, text: o.action.toUpperCase(), kind: 'mode' };
      }
      if (!next) return null;
      return { ...next, ...(o.text ? { custom: o.text } : {}), ...(o.bg ? { bg: o.bg } : {}), ...(o.fg ? { fg: o.fg } : {}) };
    })),
  }));
}

export class Show {
  private timer: NodeJS.Timeout | null = null;
  private rotation: NodeJS.Timeout | null = null;
  private labels = new Map<string, string>();
  /**
   * Data the keys read, kept for a second: one view or Companion refresh looks at 200 keys, and each team / sailor /
   * announcement key would read the group, the teams and their pictures again (seconds of a busy server on a big
   * event). A key press or any change made in the dashboard clears it (invalidate).
   */
  private memo = new Map<string, { at: number; v: unknown }>();
  private cached<T>(key: string, fn: () => T): T {
    const m = this.memo.get(key);
    if (m && Date.now() - m.at < 1000) return m.v as T;
    const v = fn();
    this.memo.set(key, { at: Date.now(), v });
    return v;
  }
  invalidate() { this.memo.clear(); }
  constructor(readonly ctx: AssetCtx, readonly lt: LowerThirds, private fetcher: Fetch = fetch as unknown as Fetch, private log: (m: string) => void = () => {}) {}

  // the config and state are read by every key of a view (hundreds): parsed again only when the stored text changes
  private cfgCache = { raw: '\u0000', v: null as unknown as ShowConfig };
  private stCache = { raw: '\u0000', v: null as unknown as ShowState };
  get config() {
    const raw = getSetting(this.ctx.db, CFG) || '';
    if (raw !== this.cfgCache.raw) this.cfgCache = { raw, v: getShowConfig(this.ctx.db) };
    return this.cfgCache.v;
  }
  get state() {
    const raw = getSetting(this.ctx.db, STATE) || '';
    if (raw !== this.stCache.raw) this.stCache = { raw, v: getShowState(this.ctx.db) };
    return { ...this.stCache.v };
  }
  /** The event's teams (read once per view) and a team's key colours. */
  private teams() { return this.cached('teams', () => listTeams(this.ctx)); }
  private nation(code: string) { return this.cached(`nation:${code}`, () => teamKeyColours(this.ctx.db, code)); }
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

  /** The teams of the race now, in fleet order (team keys 1–4). */
  boats(): { id: string; code: string; name: string }[] {
    return this.cached(`boats:${this.config.fleetId}`, () => this.loadBoats());
  }
  private loadBoats(): { id: string; code: string; name: string }[] {
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
  /**
   * The teams of the stage picked at the top of the dashboard (group by group, in fleet order), each with its places,
   * for its page; every team only when no stage is picked.
   */
  presetTeams(): PresetTeam[] {
    return this.cached('presetTeams', () => ltTeams(this.ctx).filter((t) => t.code).map((t) => ({
      code: t.code, name: t.name,
      crew: crewOf(this.ctx, t.id).map((c) => ({ slot: c.slot, label: c.label, name: c.lastName || c.firstName })),
    })));
  }
  /** The pages of both decks with a page per team. */
  pages() { return deckPages(this.config, this.presetTeams()); }

  /** A team by key: its position in the group racing now (1–4) or its code. */
  teamRef(arg: string) {
    if (/^\d+$/.test(arg)) return this.boat(Number(arg));
    const t = this.teams().find((x) => x.code.toLowerCase() === arg.toLowerCase());
    if (!t) throw notFound(`Team ${arg}`);
    return { id: t.id, code: t.code, name: t.name };
  }

  boat(n: number) { const b = this.boats()[n - 1]; if (!b) throw badRequest(`The group has no team ${n}. Pick the race (group) on the Show control tab.`); return b; }

  /** Sailors of the selected boat with a name, by shirt number. */
  sailors(): LtSailor[] {
    const b = this.boats()[this.state.boat - 1];
    if (!b) return [];
    return this.cached(`sailors:${b.id}`, () => this.loadSailors(b));
  }
  private loadSailors(b: { id: string }): LtSailor[] {
    const num = (s: LtSailor) => (Number.isFinite(Number(s.number)) && s.number !== '' ? Number(s.number) : 999);
    return crewOf(this.ctx, b.id).filter((s) => s.firstName || s.lastName).sort((a, c) => num(a) - num(c));
  }

  announcements() { return this.cached('announcements', () => listGraphicSets(this.ctx.db, activeEvent(this.ctx.db).id, 'announcement')); }

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
  /** vMix's state; the tab and the Companion refresh share one read for half a second. */
  async snapshot() {
    const m = this.memo.get('snapshot');
    if (m && Date.now() - m.at < 500) return m.v as ReturnType<Show['readSnapshot']>;
    const p = this.readSnapshot();
    this.memo.set('snapshot', { at: Date.now(), v: p });
    p.catch(() => this.memo.delete('snapshot'));
    return p;
  }
  private async readSnapshot() {
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

  /** Fields into the title, by its own field names (any case, GT's names cut at 15 characters too); one call each. */
  private async set(input: VmixInput, fields: Map<string, string>) {
    const match = titleFieldMatcher(input.fields);
    const done = new Set<string>();
    let n = 0;
    for (const [name, value] of fields) {
      const real = match(name);
      if (!real || done.has(real)) continue;
      done.add(real);
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
    if (g.id === 'raceresults') {
      if (!this.config.fleetId) throw badRequest('Pick the race (group) on the Show control tab.');
      const rows = Math.max(0, ...input.fields.map((f) => Number(f.match(/^TEAM (\d+)\.Text$/i)?.[1] ?? 0)));
      await this.set(input, raceRunFields(this.ctx, this.config.fleetId, this.config.race, rows));
    } else if (g.id === 'results') {
      if (!this.config.fleetId) throw badRequest('Pick the race (group) on the Show control tab.');
      await pushResults(this.ctx, this.config.fleetId, input.key || input.number, this.fetcher);
    } else if (g.id === 'compare') {
      if (!this.config.fleetId) throw badRequest('Pick the race (group) on the Show control tab.');
      await this.set(input, this.compareData());
    } else if (g.id === 'ticker') {
      await this.set(input, new Map([[this.textField(input, /ticker|text/i) ?? '', this.tickerText()]]));
    } else if (g.id === 'lineup5') {
      await this.set(input, this.lineupPartFields(1));
    } else if (g.id === 'bug') {
      // BUG key without a version: the announcement shown last, else the first one
      const a = (this.state.bugId && this.announcement(this.state.bugId)) || this.announcements()[0];
      if (a) { await this.set(input, this.bugFields(input, a.data)); this.patchState({ bug: (a.data.text || a.name).toUpperCase(), bugId: a.id }); }
    } else {
      // General graphics straight into the title, so a change made a moment ago is on air without waiting for Excel
      const e = activeEvent(this.ctx.db);
      const f = showDataFields(this.ctx, g.id, { eventId: ev, today: todayIn(e.timezone), auto: tickerAuto(this.ctx.db, e), tickerText: this.tickerText() });
      if (f) await this.set(input, f);
    }
  }

  /** Team comparison of the group picked at the top, with the flag or the emblem by each team (COMPARE key). */
  private compareData() {
    const ev = activeEvent(this.ctx.db);
    return compareFields(this.ctx, ev.id, this.config.fleetId, todayIn(ev.timezone), { mark: this.state.compareMark, emblemSlot: getLtConfig(this.ctx.db).emblemSlot });
  }

  /** Flag ⇄ emblem on Team comparison; the title shows the change at once (on air too, as a data change). */
  async compareMark() {
    const mark = this.state.compareMark === 'emblem' ? 'flag' : 'emblem';
    this.patchState({ compareMark: mark });
    if (this.config.fleetId) {
      const { inputs } = await this.snapshot();
      const input = this.resolve(this.graphic('compare'), inputs);
      if (input) await this.set(input, new Map([...this.compareData()].filter(([k]) => /flag\.source$/i.test(k))));
    }
    return { compareMark: mark };
  }

  /** The lineup lower third: the places in the set order, split into the first five and the rest. */
  lineupParts(): LtSailor[][] {
    const b = this.boats()[this.state.boat - 1];
    if (!b) throw badRequest('Pick a team first.');
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

  /**
   * Team lower third, qualified version: the same data and pictures as the team lower third with no photo (name, flag,
   * emblem, the team's bar) on its own title; only the bottom line reads QUALIFIED_TEXT.
   */
  async qualified(boat: number | string) {
    const b = this.teamRef(String(boat));
    const g = this.graphic('teamq');
    const snap = await this.snapshot();
    const input = this.need(g, snap.inputs);
    const lt = getLtConfig(this.ctx.db);
    const f = ltFields(this.ctx, lt, b.id, null);
    f.set(`${lt.fields.bottom}.Text`, QUALIFIED_TEXT);
    const out = this.lt.fitToTitle(input, f, b.id);
    // titles with a field of their own for the line (QualifiedText, Qualified…) get it too
    for (const x of input.fields) if (/qualif/i.test(x) && x.endsWith('.Text') && !out.has(x)) out.set(x, QUALIFIED_TEXT);
    await this.set(input, out);
    await this.bringIn({ ...g, overlay: lt.overlay }, input, snap);
    return { in: 'teamq', team: b.code };
  }

  tickerText() {
    const cfg = this.config;
    const sets = listGraphicSets(this.ctx.db, activeEvent(this.ctx.db).id, 'ticker');
    const id = this.state.tickerMode === 'end' ? cfg.tickerEnd : cfg.tickerNext;
    // unset: the fixed WARNING SIGNAL ticker before the next race, THANKS FOR WATCHING at the end
    const preset = this.state.tickerMode === 'end' ? 'thanks' : 'warning';
    const s = sets.find((x) => x.id === id) ?? sets.find((x) => x.data.preset === preset) ?? sets[0];
    return s ? tickerText(s.data, tickerAuto(this.ctx.db, activeEvent(this.ctx.db))) : '';
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
    if (g.id === 'ticker') this.patchState({ tickerId: '' });
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
    const lf = getLtConfig(this.ctx.db).fields;
    const f = this.lt.fitToTitle(input, new Map<string, string>([[`${lf.top}.Text`, p.name.toUpperCase()], [`${lf.bottom}.Text`, (p.title || p.role).toUpperCase()], [`${lf.photo}.Source`, photo]]), null);
    // on-air swap of the same title animates; a different title comes in on the overlay
    await this.set(input, f);
    await this.bringIn({ ...g }, input, snap);
    return { in: 'comm', input: input.title, person: p.name };
  }

  async lineup(boat: number | string) {
    const b = this.teamRef(String(boat));
    const g = this.graphic('lineup');
    const snap = await this.snapshot();
    const lu = loadLineup(this.ctx.db, activeEvent(this.ctx.db).id, b.id).data;
    const input = this.need(g, snap.inputs, { crew: lu.rows.filter((r) => r.firstName || r.lastName).length });
    const team = listTeams(this.ctx).find((t) => t.id === b.id)!;
    const a = team.assets as Record<string, Asset>;
    const crew = new Map(crewOf(this.ctx, b.id).map((s) => [s.slot, s]));
    const f = new Map<string, string>([['Flag.Source', img(a.flag_big)], ['Emblem.Source', img(a.emblem_light)],
      ['TeamName.Text', (lu.teamName || team.name).toUpperCase()], ['LineupText.Text', lu.title]]);
    // titles that number the trimmers 1 and 2 (Trimmer1NAME = Trimmer 1, Trimmer2NAME = Trimmer 2, TrimmerPHOTO1/2)
    const twoTrimmers = input.fields.some((x) => /^Trimmer2/i.test(x));
    const names = (d: ReturnType<typeof slotDefs>[number]) => {
      if (!twoTrimmers || (d.key !== 'Trimmer' && d.key !== 'Trimmer1')) return d.fields;
      const n = d.key === 'Trimmer' ? 1 : 2;
      return { name: `Trimmer${n}NAME`, surname: `Trimmer${n}SURNAME`, number: `Trimmer${n}NUMBER`, position: `Trimmer${n}POSITION`, photo: `TrimmerPHOTO${n}` };
    };
    for (const d of slotDefs(lu.extra)) {
      const r = lu.rows.find((x) => x.slot === d.key);
      const s = crew.get(d.key);
      const fl = names(d);
      f.set(`${fl.name}.Text`, (r?.firstName ?? '').toUpperCase());
      f.set(`${fl.surname}.Text`, (r?.lastName ?? '').toUpperCase());
      f.set(`${fl.number}.Text`, r?.number ?? '');
      f.set(`${fl.position}.Text`, (r?.position ?? '').toUpperCase());
      f.set(`${fl.photo}.Source`, s?.photo ?? '');
    }
    // the box behind each photo (HelmBG, Trimmer1BG…): the team's lineup_photo_left/right from the PNG generator, when there is one
    // left: colour on the left (the team's Line-up tab picks the side); the right one mirrors it
    const side = lu.photoSide === 'right' ? 'right' : 'left';
    const square = teamPictureFor(this.ctx, team, { w: 211, h: 135, key: `lineupphoto${side}`, exact: true })
      ?? teamPictureFor(this.ctx, team, { w: 211, h: 135, key: 'lineupphoto', like: /lineup|photobg|square/ });
    if (square) for (const x of input.fields) if (/^\w+BG\.Source$/i.test(x) && !/^BG\.Source$/i.test(x)) f.set(x, square);
    await this.set(input, f);
    await this.bringIn(g, input, snap);
    return { in: 'lineup', team: b.code, input: input.title };
  }

  tickers() { return this.cached('tickers', () => listGraphicSets(this.ctx.db, activeEvent(this.ctx.db).id, 'ticker')); }

  /** An announcement by key: its position (bug:3), its version id, or THANKS (old keys: the Thanks ticker). */
  private announcement(which: string) {
    const list = this.announcements();
    return list.find((x) => x.id === which) ?? (/^\d+$/.test(which) ? list[Number(which) - 1] : undefined);
  }

  /** The bug's text and icon, by the title's field names (TEXT; Race flag, ICON, FLAG, STAR… but not icon_background). */
  private bugFields(input: VmixInput, data: Record<string, string>) {
    const f = new Map<string, string>();
    const text = this.textField(input, /text/i);
    if (text) f.set(text, (data.text ?? '').toUpperCase());
    const pics = input.fields.filter((x) => x.endsWith('.Source') && !/background|\bbg\b|_bg|bar/i.test(x));
    const icon = [/race ?flag/i, /^icon\./i, /flag/i, /icon/i, /star/i, /logo/i].map((re) => pics.find((x) => re.test(x))).find(Boolean);
    if (icon) f.set(icon, imagePath(this.ctx.db, this.ctx.assetsDir, data.icon));
    return f;
  }

  /** Announcement bug: its text and icon go into the title, then it comes in; the same key again takes it out. */
  async bug(which: string) {
    if (which === 'thanks') return this.ticker('thanks');
    const a = this.announcement(which);
    if (!a) throw badRequest(`No announcement ${which}. Add it under General graphics → Announcements.`);
    const g = this.graphic('bug');
    const snap = await this.snapshot();
    // Replay with no icon of its own: the Replay bug title, when vMix has it (the announcement bug would show an empty icon)
    if (!a.data.icon?.trim() && /^replay$/i.test((a.data.text || a.name).trim()) && this.resolve(this.graphic('replay'), snap.inputs)) return this.toggle('replay');
    const input = this.need(g, snap.inputs);
    const on = snap.overlays[g.overlay] === input.number;
    if (on && this.state.bugId === a.id) {
      this.pushUndo(snap.overlays);
      await this.overlayOut(g.overlay, snap.overlays);
      this.patchState({ bugId: '' });
      return { out: 'bug' };
    }
    await this.set(input, this.bugFields(input, a.data));
    const text = (a.data.text || a.name).toUpperCase();
    this.patchState({ bug: text, bugId: a.id });
    await this.bringIn(g, input, snap);
    return { in: 'bug', text };
  }

  /** A ticker version by key: position (ticker:2), version id or fixed ticker (thanks, warning, delay, custom). */
  private tickerVersion(which: string) {
    const list = this.tickers();
    return list.find((x) => x.id === which) ?? list.find((x) => x.data.preset === which) ?? (/^\d+$/.test(which) ? list[Number(which) - 1] : undefined);
  }

  /** Ticker of one version (Tickers in General graphics): its text goes in, then it comes in; again = out. */
  async ticker(which: string) {
    const t = this.tickerVersion(which);
    if (!t) throw badRequest(`No ticker ${which}. Add it under General graphics → Tickers.`);
    const g = this.graphic('ticker');
    const snap = await this.snapshot();
    const input = this.need(g, snap.inputs);
    const on = snap.overlays[g.overlay] === input.number;
    if (on && this.state.tickerId === t.id) {
      this.pushUndo(snap.overlays);
      await this.overlayOut(g.overlay, snap.overlays);
      this.patchState({ tickerId: '' });
      return { out: 'ticker' };
    }
    const text = tickerText(t.data, tickerAuto(this.ctx.db, activeEvent(this.ctx.db)));
    await this.set(input, new Map([[this.textField(input, /ticker|text/i) ?? '', text]]));
    this.patchState({ tickerId: t.id });
    if (!on) await this.bringIn(g, input, snap);
    return { in: 'ticker', text };
  }

  /** Lower thirds of a sailor on the selected boat, by key index (1–16, sorted by shirt number) or by shirt number. */
  async sailor(index: number | null, shirt?: string) {
    const list = this.sailors();
    const s = shirt ? list.find((x) => x.number === shirt) : list[(index ?? 0) - 1];
    if (!s) throw badRequest(shirt ? `No sailor with number ${shirt} in ${this.boats()[this.state.boat - 1]?.code ?? 'this team'}.` : 'No sailor on this key.');
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

  /** A place of a team's line-up (its page's keys): the sailor on it now, with the photo mode of the tab. */
  async sailorOf(code: string, slot: string) {
    const t = this.teamRef(code);
    const snap = await this.snapshot();
    if (snap.overlays[1]) { this.pushUndo(snap.overlays); await this.overlayOut(1, snap.overlays); }
    return this.lt.showSailor(t.code, slot, { forceNoPhoto: this.state.photo === 'off' });
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
    this.invalidate();
    const [kind, arg = ''] = action.split(':');
    try {
      const r = await this.dispatch(kind, arg).finally(() => this.invalidate()); // what the press changed shows at once
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
      case 'qualified': return this.qualified(arg);
      case 'comm': return this.commentator(arg);
      case 'anthem': return this.lt.showTeam(this.teamRef(arg).code);
      case 'lineup': return this.lineup(arg);
      case 'sailorof': { const [code, slot = ''] = arg.split('/'); return this.sailorOf(code, slot); }
      case 'boat': { const n = Number(arg); this.boat(n); this.patchState({ boat: n }); return { boat: n }; }
      case 'sailor': return this.sailor(Number(arg));
      case 'shirt': return this.sailor(null, arg);
      case 'photo': { const m = ({ auto: 'on', on: 'off', off: 'auto' } as const)[this.state.photo]; this.patchState({ photo: m }); return { photo: m }; }
      case 'next': return this.lt.nextLine();
      case 'teamlt': return this.lt.showTeam(arg ? this.teamRef(arg).code : this.boat(this.state.boat).code);
      case 'ltout': return this.lt.out();
      case 'bug': return this.bug(arg);
      case 'ticker': return this.ticker(arg);
      case 'bugout': { const s = await this.snapshot(); this.pushUndo(s.overlays); await this.overlayOut(3, s.overlays); return { out: 'bug' }; }
      case 'boardout': { const s = await this.snapshot(); this.pushUndo(s.overlays); await this.overlayOut(1, s.overlays); return { out: 'board' }; }
      case 'breakout': case 'scene4out': { const s = await this.snapshot(); this.pushUndo(s.overlays); await this.sceneOut(s.overlays); return { out: 'scene' }; }
      case 'rotate': return this.toggleRotation();
      case 'nextslide': return this.nextSlide();
      case 'tickermode': return this.tickerMode();
      case 'comparemark': return this.compareMark();
      case 'undo': return this.undo();
      case 'allout': return this.allOut();
      case 'panic': return this.panic();
      default: throw badRequest(`Unknown action ${kind}`);
    }
  }

  // ---------- keys: texts and colours ----------
  /** What a key says and its colour now. */
  async keyLook(key: DeckKey, ctxt?: { overlays: Record<string, string>; inputs: VmixInput[] }, neutral = false) {
    const [kind, arg = ''] = key.action.split(':');
    const st = this.state;
    let text = key.text;
    let onAir = false, active = false, empty = false;
    const boats = this.boats();
    const ov = ctxt?.overlays ?? {};
    const isOn = (id: string) => { if (!ctxt) return false; const g = this.graphics().find((x) => x.id === id); const i = g && this.resolve(g, ctxt.inputs); return !!(g && i && ov[g.overlay] === i.number); };
    const lt = getLtState(this.ctx.db);
    let team: { id: string; code: string } | undefined; // the team whose national colours the key takes
    if (key.team) {
      // a key of a team's page (or the TEAMS page): its text is fixed, the team gives the colours
      const t = this.teams().find((x) => x.code === key.team);
      team = t;
      if (t && kind === 'sailorof') onAir = lt.onAir && lt.kind === 'sailor' && lt.teamId === t.id && lt.slot === arg.split('/')[1];
      if (t && (kind === 'teamlt' || kind === 'anthem')) onAir = lt.onAir && lt.kind === 'team' && lt.teamId === t.id;
    } else if (kind === 'anthem' || kind === 'lineup' || kind === 'boat' || kind === 'qualified') {
      const b = boats[Number(arg) - 1];
      team = b;
      if (b && kind === 'anthem') onAir = lt.onAir && lt.kind === 'team' && lt.teamId === b.id;
      text = b ? (kind === 'boat' ? `${b.code}\\n${b.name.toUpperCase().slice(0, 12)}` : `${({ anthem: 'ANTHEM', lineup: 'LINEUP', qualified: 'QUALIFIED' } as Record<string, string>)[kind]}\\n${b.code}`) : `${key.text}\\n—`;
      empty = !b;
      if (kind === 'boat') active = st.boat === Number(arg);
    } else if (kind === 'sailor') {
      const s = this.sailors()[Number(arg) - 1];
      const b = boats[st.boat - 1];
      team = b;
      if (s && b) onAir = lt.onAir && lt.kind === 'sailor' && lt.teamId === b.id && lt.slot === s.slot;
      text = s ? `#${s.number || '?'}${s.photo ? ' ●' : ''}\\n${s.position.toUpperCase()}\\n${s.lastName.toUpperCase().slice(0, 10)}${b ? ` ${b.code}` : ''}` : '';
      empty = !s;
    } else if (kind === 'teamlt') {
      team = boats[st.boat - 1];
      if (team) { text = `TEAM LT\\n${team.code}`; onAir = lt.onAir && lt.kind === 'team' && lt.teamId === team.id; }
    } else if (kind === 'bug' && arg !== 'thanks') {
      const a = this.announcement(arg);
      text = a ? a.name.toUpperCase().slice(0, 28) : '';
      empty = !a;
      if (a) onAir = isOn('bug') && st.bugId === a.id;
    } else if (kind === 'ticker' || (kind === 'bug' && arg === 'thanks')) {
      const t = this.tickerVersion(kind === 'bug' ? 'thanks' : arg);
      text = t ? `TICKER\\n${t.name.toUpperCase().slice(0, 24)}` : '';
      empty = !t;
      if (t) onAir = isOn('ticker') && st.tickerId === t.id;
    } else if (kind === 'photo') text = `PHOTO\\n${st.photo.toUpperCase()}`;
    else if (kind === 'comparemark') text = `COMPARE:\\n${st.compareMark === 'emblem' ? 'EMBLEM' : 'FLAG'}`;
    else if (kind === 'tickermode') text = st.tickerMode === 'end' ? 'TICKER:\\nEND OF DAY' : 'TICKER:\\nNEXT RACE';
    else if (kind === 'rotate') { text = st.rotating ? 'ROTATION\\n⏸ STOP' : 'ROTATION\\n▶ START'; active = st.rotating; }
    else if (kind === 'panic' && Date.now() - st.armedPanic < 3000) { text = 'PANIC?\\nPRESS AGAIN'; onAir = true; }
    if (kind === 'show') onAir = isOn(arg);
    if (key.action === 'show:lineup5' && st.lineupPart) text = `LINEUP LT\\n${st.lineupPart === 1 ? '▶ PART 2' : 'OUT'}`;
    if (kind === 'break') onAir = isOn('break');
    if (neutral) { onAir = false; active = false; if (key.kind === 'mode') text = key.text; } // a fixed key: its name, not today's mode
    if (key.custom) text = key.custom.replace(/\{auto\}/g, text);
    // team and sailor keys in the team's national colours, the feedback (selected / on air) in its colours too;
    // a colour set on the key or on its kind in the key editor still wins
    const nation = team && !empty && !key.bg && !this.config.kindColours[key.kind] ? this.nation(team.code) : null;
    if (nation) {
      const l = teamKeyLook(nation, text, { active, onAir });
      return { text: l.text, bg: l.bg, fg: key.fg || l.fg, onAir, active, empty };
    }
    let bg = keyBg(this.config, key);
    let fg = key.fg || '#ffffff';
    if (active) { bg = '#f59e0b'; fg = '#000000'; text = `▶ ${text}`; }
    if (onAir) { bg = '#dc2626'; fg = '#ffffff'; text = `● ${text}`; }
    if (empty) { bg = '#18181b'; fg = key.fg || '#ffffff'; }
    return { text, bg, fg, onAir, active, empty };
  }

  async view() {
    const snap = await this.snapshot().catch(() => null);
    const cfg = this.config;
    const pages = this.pages();
    const looks = await Promise.all(pages.map(async (p) => ({ ...p, keys: await Promise.all(p.keys.map((r) => Promise.all(r.map(async (k) => (k ? { ...k, ...(await this.keyLook(k, snap ?? undefined)) } : null))))) })));
    return {
      config: cfg, state: { ...this.state, undo: undefined, undoDepth: this.state.undo.length },
      vmix: snap ? { ok: true, overlays: snap.overlays } : { ok: false, overlays: {} },
      graphics: this.graphics().map((g) => {
        const i = snap ? this.resolve(g, snap.inputs) : undefined;
        return { ...g, input: i?.title ?? null, onAir: !!(i && snap!.overlays[g.overlay] === i.number), fields: i?.fields.length ?? 0 };
      }),
      boats: this.boats(), sailors: this.sailors().map((s) => ({ slot: s.slot, number: s.number, name: `${s.firstName} ${s.lastName}`.trim(), position: s.position, photo: !!s.photo })),
      pages: looks, actions: keyActions(cfg), kindColours: KEY_COLOURS,
    };
  }

  /** Key texts and colours into Companion (POST /api/location/<page>/<row>/<col>/style), only what changed. */
  async pushLabels(force = false) {
    const cfg = this.config;
    const lt = getLtConfig(this.ctx.db);
    if (!cfg.labels || !cfg.liveKeys || !lt.companionUrl) return { sent: 0 };
    if (force) this.labels.clear();
    let n = 0;
    try {
      const snap = await this.snapshot().catch(() => undefined);
      for (const p of this.pages()) {
        for (const [r, row] of p.keys.entries()) {
          for (const [c, key] of row.entries()) {
            if (!key || key.kind === 'nav') continue;
            const l = await this.keyLook(key, snap);
            const q = `text=${encodeURIComponent(l.text)}&bgcolor=${encodeURIComponent(l.bg)}&color=${encodeURIComponent(l.fg)}&size=auto`;
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

  /**
   * The whole Companion preset in one file (every page of both decks, a page per team, the fallback page): each key
   * has its text and colours fixed in it, as they are now (no live labels).
   */
  async companionPreset(base: string, vmixBase: string) {
    const pages = this.pages();
    const looks = await Promise.all(pages.map(async (p) => ({ ...p, keys: await Promise.all(p.keys.map((r) => Promise.all(r.map(async (key) => (key ? { key, look: await this.keyLook(key, undefined, true) } : null))))) })));
    return companionPresetFile(this.config, looks, base, vmixBase, this.graphics());
  }

  /** Keeps the keys in step with vMix and line-up changes made elsewhere. */
  start(ms = 2000) { this.timer = setInterval(() => { void this.pushLabels(); void this.syncData(); }, ms); this.timer.unref?.(); }

  private syncSig = '';
  private syncing = false;
  private syncError = '';
  /**
   * Keeps the data titles in step with the dashboard without a key press: Day schedule (Schedule tab), Group results
   * and Team comparison of the group picked at the top. After any change in the dashboard (or a new day), only the
   * fields whose value differs from what vMix shows in the title are set.
   */
  async syncData() {
    if (this.syncing) return { sent: 0 };
    const ev = activeEvent(this.ctx.db);
    const today = todayIn(ev.timezone);
    const sig = `${(this.ctx.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n}|${today}`;
    if (sig === this.syncSig) return { sent: 0 };
    this.syncing = true;
    let sent = 0;
    try {
      const { inputs } = await this.snapshot();
      const fleetId = this.config.fleetId;
      for (const id of ['schedule', 'results', 'compare']) {
        if (id !== 'schedule' && !fleetId) continue;
        const input = this.resolve(this.graphic(id), inputs);
        if (!input) continue;
        const f = id === 'schedule' ? showDataFields(this.ctx, 'schedule', { eventId: ev.id, today, auto: tickerAuto(this.ctx.db, ev), tickerText: this.tickerText() })
          : id === 'results' ? resultFieldsFor(this.ctx, fleetId, input).fields : this.compareData();
        if (!f) continue;
        const match = titleFieldMatcher(input.fields);
        const changed = new Map([...f].filter(([k, v]) => { const r = match(k); return r !== undefined && (input.values?.[r] ?? '') !== v; }));
        if (changed.size) sent += await this.set(input, changed);
      }
      this.syncSig = sig;
      this.syncError = '';
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg !== this.syncError) this.log(`vMix data: ${msg}`);
      this.syncError = msg;
    } finally { this.syncing = false; }
    return { sent };
  }
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
type KeyLook = { text: string; bg: string; fg: string; empty: boolean };

/** Companion's full export (format 4, which every later Companion upgrades on import): all pages, one HTTP connection. */
export function companionPresetFile(cfg: ShowConfig, pages: (Omit<DeckPage, 'keys'> & { keys: ({ key: DeckKey; look: KeyLook } | null)[][] })[], base: string, vmixBase: string, graphics: Graphic[]) {
  const b = base.replace(/\/+$/, '');
  const out: Record<number, { name: string; controls: Record<number, Record<number, unknown>>; gridSize: unknown }> = {};
  for (const p of pages) {
    const controls: Record<number, Record<number, unknown>> = {};
    p.keys.forEach((row, r) => row.forEach((x, c) => {
      if (!x || (x.look.empty && x.key.kind !== 'nav')) return;
      const { key, look } = x;
      const id = `p${p.page}r${r}c${c}`;
      const act = key.action.startsWith('nav:') ? setPage(id, Number(key.action.split(':')[1])) : http(id, `${b}/api/show/do?a=${encodeURIComponent(key.action)}`);
      (controls[r] ??= {})[c] = control(look.text, hex(look.bg), [act], hex(look.fg));
    }));
    out[p.page] = { name: `SSL ${p.name}`, controls, gridSize: GRID };
  }
  const fb = fallbackControls(cfg, vmixBase, graphics);
  out[PRESET_PAGES.fallback] = { name: 'SSL FALLBACK', controls: fb, gridSize: GRID };
  return {
    version: 4, type: 'full',
    pages: out,
    triggers: {},
    custom_variables: {},
    instances: { [CONN]: CONN_DEF },
  };
}
const GRID = { minColumn: 0, maxColumn: 7, minRow: 0, maxRow: 3 };
const COLOURS = (kind: string) => ({ board: 0x1e3a8a, lt: 0x166534, bug: 0xa16207, scene: 0x0f766e, team: 0x1e3a5f, sailor: 0x27303f, nav: 0x3f3f46, safety: 0x7c2d12, mode: 0x4c1d95 } as Record<string, number>)[kind] ?? 0x3f3f46;

const hex = (c: string) => parseInt(c.replace('#', ''), 16) || 0;
const control = (text: string, bg: number, down: unknown[], fg = 0xffffff) => ({
  type: 'button',
  style: { text, size: 'auto', png64: null, alignment: 'center:center', pngalignment: 'center:center', color: fg, bgcolor: bg, show_topbar: 'default' },
  options: { relativeDelay: false, rotaryActions: false, stepAutoProgress: true },
  feedbacks: [],
  steps: { 0: { action_sets: { down, up: [] }, options: { runWhileHeld: [] } } },
});
const CONN = 'ssl_dashboard_show';
const http = (id: string, url: string) => ({ id, action: 'get', instance: CONN, options: { url, header: '' }, delay: 0 });
const setPage = (id: string, page: number) => ({ id, action: 'set_page', instance: 'internal', options: { controller: 'self', controller_from_variable: false, controller_variable: '', page, page_from_variable: false, page_variable: '' }, delay: 0 });

const CONN_DEF = { instance_type: 'generic-http', label: 'ssl_dashboard_show', enabled: true, isFirstInit: false, lastUpgradeIndex: -1, sortOrder: 0, config: { prefix: '', proxyAddress: '', rejectUnauthorized: true } };
function pageFile(name: string, page: number, controls: Record<number, Record<number, unknown>>) {
  return {
    version: 4, type: 'page',
    page: { name, controls, gridSize: { minColumn: 0, maxColumn: 7, minRow: 0, maxRow: 3 } },
    instances: { [CONN]: CONN_DEF },
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
      const act = key.action.startsWith('nav:') ? setPage(id, Number(key.action.split(':')[1])) : http(id, `${b}/api/show/do?a=${encodeURIComponent(key.action)}`);
      (controls[r] ??= {})[c] = control(key.custom ? key.custom.replace(/\{auto\}/g, key.text) : key.text, hex(keyBg(cfg, key)), [act], key.fg ? hex(key.fg) : 0xffffff);
    }));
    files.push({ name: `deck${p.deck}-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, page: p.page, file: pageFile(`SSL ${p.name}`, p.page, controls) });
  }
  const fb = fallbackControls(cfg, vmixBase, graphics);
  files.push({ name: 'fallback', page: PRESET_PAGES.fallback, file: pageFile('SSL FALLBACK', cfg.fallbackPage, fb) });
  return files;
}

/** The fallback page: straight to vMix, no dashboard needed; the data stays as it was last set. */
function fallbackControls(cfg: ShowConfig, vmixBase: string, graphics: Graphic[]) {
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
    0: control('DECK 1\\nHOME', 0x3f3f46, [setPage('fbn1', PRESET_PAGES.deck1)]),
    1: control('DECK 2\\nHOME', 0x3f3f46, [setPage('fbn2', PRESET_PAGES.deck2)]),
  };
  return fb;
}
