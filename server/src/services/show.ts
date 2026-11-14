import fs from 'node:fs';
import { KEPT_PEOPLE_PAGE } from './companionKept.js';
import path from 'node:path';
import { z } from 'zod';
import { activeEvent, getSetting, setSetting } from '../db/db.js';
import { AssetCtx } from './assets.js';
import { badRequest, notFound } from './errors.js';
import { getSetDetail, listSets } from './fleets.js';
import { listPeople, personName } from './general.js';
import { imagePath, isOften, listGraphicSets, tickerText } from './graphicSets.js';
import { tickerAuto } from './groups.js';
import { BOARD_BOW_TO_STERN, BOW_TO_STERN, loadLineup, slotDefs } from './lineups.js';
import { crewOf, getLtConfig, getLtState, LowerThirds, LtSailor, ltFields, ltTeams } from './lowerthirds.js';
import { ltRoles, teamPictureFor } from './ltTitle.js';
import { teamKeyColours, teamKeyLook } from './nationColours.js';
import { listTeams } from './teams.js';
import { encodePng } from './png.js';
import { joinVmixPath, localCandidate } from './paths.js';
import { compareFields, showDataFields } from './showData.js';
import { todayIn } from './dates.js';
import { groupLabel, groupLetter } from './groupNames.js';
import { currentStage } from './workbookSheets.js';
import { findInput, parseVmixXml, pushResults, resultFieldsFor, titleFieldMatcher, VmixInput, vmixUrl } from './vmixResults.js';

/**
 * Show control: every graphic of the broadcast as one entry of a registry (vMix input names, overlay channel),
 * driven from two Stream Decks through Companion. Each key calls /api/show/do?a=<action>; the dashboard fills the
 * title through the vMix Web API, brings it in on its overlay channel and keeps the rules:
 *  - every graphic on OV1 (one replaces the other), only the break scene on OV4
 *  - a board coming in takes the break scene off; the break scene takes OV1 off
 *  - UNDO puts every overlay back as it was before the last action; ALL OUT takes everything out with its
 *    animation; PANIC (pressed twice) cuts everything at once
 * State (what is on air) is always read from vMix, never remembered from key presses.
 */

/** The bottom line of the qualified team lower third. */
/** The lineup lower third's order: from the bow to the stern. */
export const LINEUP_LT_ORDER = BOW_TO_STERN;

export const QUALIFIED_TEXT = 'Qualified for the SSL Gold Cup finals';

export type Kind = 'board' | 'lt' | 'bug' | 'scene';
export interface Graphic { id: string; label: string; kind: Kind; overlay: number; inputs: string[]; aliases?: string[] }

/** Default registry. `inputs` are tried in order; `{n}` is the number of teams of the race (3/4), `{crew}` the crew size. */
export const DEFAULT_GRAPHICS: Graphic[] = [
  { id: 'welcome', label: 'Welcome', kind: 'board', overlay: 1, inputs: ['ssl_welcome'] },
  { id: 'schedule', label: 'Day schedule', kind: 'board', overlay: 1, inputs: ['ssl_schedule'] },
  { id: 'matchboard', label: 'Matchboard', kind: 'board', overlay: 1, inputs: ['ssl_matchboard'] },
  { id: 'results', label: 'Group results', kind: 'board', overlay: 1, inputs: ['ssl_results_group_{n}', 'ssl_results_group'] },
  { id: 'compare', label: 'Team comparison', kind: 'board', overlay: 1, inputs: ['ssl_compare_{n}', 'ssl_compare'] },
  { id: 'lineup', label: 'Team lineup', kind: 'board', overlay: 1, inputs: ['ssl_lineup_{crew}', 'ssl_lineup'] },
  { id: 'course', label: 'Race course', kind: 'board', overlay: 1, inputs: ['ssl_course'] },
  { id: 'officials', label: 'Race officials', kind: 'board', overlay: 1, inputs: ['ssl_officials'] },
  { id: 'weather', label: 'Weather', kind: 'board', overlay: 1, inputs: ['ssl_weather'] },
  { id: 'teamq', label: 'Team LT qualified', kind: 'lt', overlay: 1, inputs: ['ssl_lt_team_q'] },
  { id: 'comm', label: 'Commentator LT', kind: 'lt', overlay: 1, inputs: ['ssl_lt_comm_photo', 'ssl_lt_comm_nophoto'] },
  { id: 'lineup5', label: 'Lineup LT (9 sailors, 5 + 4)', kind: 'lt', overlay: 1, inputs: ['ssl_lt_lineup5'] },
  { id: 'bug', label: 'Announcement bug', kind: 'bug', overlay: 1, inputs: ['ssl_bug'], aliases: ['Announcement_bug', 'Announcement_bug_flag'] },
  { id: 'ticker', label: 'Ticker', kind: 'bug', overlay: 1, inputs: ['ssl_ticker'] },
  { id: 'socials', label: 'Socials', kind: 'bug', overlay: 1, inputs: ['ssl_socials'] },
  { id: 'sponsors', label: 'Event sponsors bar', kind: 'bug', overlay: 1, inputs: ['ssl_sponsors'] },
  // no input of its own: the L-bar, the ticker and the boards each on an overlay channel of their own (2, 3, 4)
  { id: 'break', label: 'Break scene (L-bar + ticker + boards)', kind: 'scene', overlay: 4, inputs: [] },
  { id: 'lbar', label: 'L-bar', kind: 'scene', overlay: 1, inputs: ['ssl_lbar'], aliases: ['L-bars', 'L-bar', 'Lbar'] },
  // the second L-bar (ranking): a key of its own, never part of the break scene
  { id: 'lbar2', label: 'L-bar ranking', kind: 'scene', overlay: 1, inputs: ['ssl_bar_2'] },
  // a ready graphic in vMix (Image or Title input) explaining how the Last Chance group works; nothing is filled in
  { id: 'lcrinfo', label: 'Last Chance explained', kind: 'board', overlay: 1, inputs: ['ssl_lcr_info'] },
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
  /** the day schedule is one of the boards of the break scene (off: it starts with the first group's results) */
  breakSchedule: z.boolean().default(true),
  /** the break scene's overlay channels: L-bar, ticker, and the board that switches (day schedule / group results) */
  breakLbarLayer: z.number().int().min(2).max(4).default(2),
  breakTickerLayer: z.number().int().min(2).max(4).default(3),
  breakBoardLayer: z.number().int().min(2).max(4).default(4),
  /** the board in the break scene switches by itself (day schedule, then each group's results) */
  breakAuto: z.boolean().default(true),
  rotateSeconds: z.number().int().min(4).max(120).default(30),
  /** ms the board's out animation takes before the next board goes in on the break scene */
  breakOutMs: z.number().int().min(0).max(5000).default(1500),
  /** ms the comparison's flag fade-out takes (FLAG ⇄ EMBLEM on air): the other flags change after it */
  flagChangeMs: z.number().int().min(0).max(3000).default(500),
  /** 2: the switch time went from 12 to 30 s (an old 12 becomes 30 once) */
  cfgVersion: z.number().int().default(4),
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
  /** Stream Deck key edits by place ("<page name>/<row>/<col>"): another action ('' = empty key), own text ({auto} = the live text), key and text colour */
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
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!r.cfgVersion && r.rotateSeconds === 12) r.rotateSeconds = 30;
  // 3: the break scene uses overlay channels 2, 3, 4 (no ssl_break input): layer numbers saved before become those
  if (Number(r.cfgVersion ?? 0) < 3) { r.breakLbarLayer = 2; r.breakTickerLayer = 3; r.breakBoardLayer = 4; }
  // 4: the results' out animation takes up to 1.2 s, so the next board waits 1.5 s (an old 1000 ms becomes 1500)
  if (Number(r.cfgVersion ?? 0) < 4 && (r.breakOutMs === undefined || r.breakOutMs === 1000)) r.breakOutMs = 1500;
  return showConfigSchema.parse(r);
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
  lineupPart: number; // 0 = off, 1 = the first five, 2 = the other four
  lineupTeam: string; // the team on the lineup lower third
  compareMark: 'flag' | 'emblem'; // what Team comparison shows by each team
}
const EMPTY_STATE: ShowState = { tickerMode: 'next', boat: 1, photo: 'auto', rotating: false, slide: 0, armedPanic: 0, undo: [], last: null, bug: '', bugId: '', tickerId: '', lineupPart: 0, lineupTeam: '', compareMark: 'flag' };
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
/** vMix calls sent at once when a title takes many fields. */
const SET_BATCH = 8;
export const PRESET_PAGES = { deck1: 1, deck2: 3, fallback: 8, teams: 9 } as const;

/** A team page: the team and its places (slot, place label, the name on the key). */
export interface PresetTeam { code: string; name: string; crew: { slot: string; label: string; name: string; number?: string }[] }

/** A group of the stage with a Team comparison of its own: key A, B… (FINAL…), its input ssl_compare_<key>. */
export interface PresetGroup { fleetId: string; key: string; label: string }
/** A group's key for its own inputs and keys: H, I…; the Last Chance Race is LCR (ssl_results_LCR, ssl_compare_LCR). */
export const compareKey = (name: string) => (/last\s*chance|\blcr\b/i.test(name) ? 'LCR' : groupLetter(name).replace(/[^A-Za-z0-9]+/g, '').toUpperCase());
export const compareInput = (key: string) => `ssl_compare_${key}`;
/** A group's own Group results input (ssl_results_H…); without one, the shared results title takes the group's data. */
export const resultsInput = (key: string) => `ssl_results_${key}`;

export function deckPages(cfg: ShowConfig, teams: PresetTeam[] = [], groups: PresetGroup[] = [], resultGroups: PresetGroup[] = groups): DeckPage[] {
  return applyKeyEdits(cfg, defaultDeckPages(cfg, teams, groups, resultGroups).map((p) => (p.name === 'PEOPLE' ? keptPeople(p) : p)));
}
/**
 * The PEOPLE page as the producer set it up in Companion: its own keys win (dashboard keys show here as they are,
 * vMix / ATEM keys only in Companion), the person keys it took away stay away; new keys only in its free places.
 */
function keptPeople(p: DeckPage): DeckPage {
  return { ...p, keys: p.keys.map((row, r) => row.map((key, c) => {
    if (KEPT_PEOPLE_PLACES.has(`${r}/${c}`)) {
      const a = keptPeopleAction(r, c);
      if (key?.action.startsWith('nav:')) return key;
      if (!a || a === 'undo') return null;
      return key?.action === a ? key : (a.startsWith('person:') ? k(a, '—', 'bug') : { action: a, text: a.toUpperCase(), kind: 'mode' as const });
    }
    return key && /^person:/.test(key.action) ? null : key;
  })) };
}

function defaultDeckPages(cfg0: ShowConfig, teams: PresetTeam[] = [], groups: PresetGroup[] = [], resultGroups: PresetGroup[] = groups): DeckPage[] {
  const comparePage = PRESET_PAGES.teams + teams.length;
  const cfg = { ...cfg0, deck1Page: PRESET_PAGES.deck1, deck2Page: PRESET_PAGES.deck2, fallbackPage: PRESET_PAGES.fallback };
  const p1 = cfg.deck1Page, p2 = cfg.deck2Page;
  // TEAMS: 8 teams a page (the team's page key, its team lower third under it); more teams go on TEAMS 2… after COMPARE
  const teamsPages = Math.max(1, Math.ceil(teams.length / TEAMS_PER_PAGE));
  const teamsPage = (n: number) => (n === 0 ? p2 : comparePage + n);
  const peoplePage = comparePage + teamsPages;
  const nav = (home: number, prev: number, prevName: string, next: number, nextName: string) => navRow(
    k(`nav:${home}`, 'HOME', 'nav'), k(`nav:${prev}`, `◀\\n${prevName}`, 'nav'), k(`nav:${next}`, `▶\\n${nextName}`, 'nav'), k(`nav:${cfg.fallbackPage}`, 'FALL-\\nBACK', 'nav'));
  const teamsName = (n: number) => (n ? `TEAMS ${n + 1}` : 'TEAMS');
  const teamsPageOf = (n: number): DeckPage => ({
    deck: 2, name: teamsName(n), page: teamsPage(n), keys: [
      row8(...Array.from({ length: 8 }, (_, c) => {
        const i = n * TEAMS_PER_PAGE + c, t = teams[i];
        return t ? { ...k(`nav:${PRESET_PAGES.teams + i}`, `${t.code}\\n${t.name.toUpperCase().slice(0, 12)}`, 'team'), team: t.code } : null;
      })),
      // a row between the team keys and their TEAM LT, so a press does not hit the wrong one
      row8(),
      row8(...Array.from({ length: 8 }, (_, c) => {
        const t = teams[n * TEAMS_PER_PAGE + c];
        return t ? { ...k(`teamlt:${t.code}`, `TEAM LT\\n${t.code}`, 'lt'), team: t.code } : null;
      })),
      nav(p2, n ? teamsPage(n - 1) : peoplePage, n ? teamsName(n - 1) : 'PEOPLE', n + 1 < teamsPages ? teamsPage(n + 1) : p2 + 1, n + 1 < teamsPages ? teamsName(n + 1) : 'BUGS OFTEN'),
    ],
  });
  const lastTeams = teamsPages - 1;
  return [
    {
      // before the race: boards and the studio lower thirds (each graphic once; OUT, UNDO… on the bottom row of every page)
      deck: 1, name: 'A BEFORE', page: p1, keys: [
        row8(k('show:welcome', 'WELCOME', 'board'), k('show:matchboard', 'MATCH-\\nBOARD', 'board'), k('show:schedule', 'DAY\\nSCHEDULE', 'board'), k('show:course', 'RACE\\nCOURSE', 'board'),
          k('show:officials', 'OFFICIALS', 'board'), k('show:weather', 'WEATHER', 'board'), k('show:socials', 'SOCIALS', 'bug'), k(`nav:${comparePage}`, 'TEAM\\nCOMPARE', 'nav')),
        // REFRESH PNG: every picture from the dashboard into vMix again (a PNG remade in the PNG generator)
        row8(k('show:lcrinfo', 'LAST\\nCHANCE\\nEXPLAINED', 'board')),
        row8(k('refreshpng', 'REFRESH\\nPNG', 'mode')),
        nav(p1, p1 + 1, 'AFTER', p1 + 1, 'AFTER'),
      ],
    },
    {
      deck: 1, name: 'C-E AFTER / BREAK', page: p1 + 1, keys: [
        row8(k('show:socials', 'SOCIALS', 'bug'), k('show:lbar', 'L-BAR', 'scene'), k('show:lbar2', 'L-BAR\\nRANKING', 'scene'), k('show:sponsors', 'SPONSORS\\nBAR', 'bug'),
          // a key per group: its own results input (ssl_results_<KEY>)
          ...resultGroups.slice(0, 4).map((g) => k(`results:${g.key}`, `RESULTS\\n${g.label.toUpperCase().slice(0, 12)}`, 'board'))),
        row8(k('show:break', 'BREAK\\nSCENE', 'scene'), k('breakout', 'BREAK\\nOUT', 'scene'), k('rotate', 'AUTO\\nSWITCH', 'scene'), k('nextslide', 'NEXT\\nSLIDE', 'scene')),
        // a key per ticker (Tickers in General graphics, by position): the ticker of the break scene; a new ticker is on the next key at once
        row8(...Array.from({ length: 8 }, (_, n) => k(`breakticker:${n + 1}`, '—', 'scene'))),
        nav(p1, p1, 'BEFORE', p1, 'BEFORE'),
      ],
    },
    teamsPageOf(0),
    // every announcement and every ticker on a key of its own, by position: a version added in General graphics is
    // on the next free key at once (Companion keys too, they call the position)
    slotPage(p2 + 1, 'BUGS OFTEN', (n) => `bug:o${n}`, 3, nav(p2, teamsPage(lastTeams), teamsName(lastTeams), p2 + 2, 'BUGS RARE')),
    slotPage(p2 + 2, 'BUGS RARE', (n) => `bug:r${n}`, 3, nav(p2, p2 + 1, 'BUGS OFTEN', p2 + 3, 'TICKERS')),
    // the ticker input: its versions, the automatic one (next race / end of day) and that mode
    slotPage(p2 + 3, 'TICKERS', (n) => `ticker:${n}`, 2, nav(p2, p2 + 2, 'BUGS RARE', peoplePage, 'PEOPLE')),
    ...teams.map((t, i) => teamPage(t, i, teams, teamsPage(Math.floor(i / TEAMS_PER_PAGE)))),
    // Team comparison of each group of the stage, each in its own vMix input (after the team pages)
    {
      deck: 1, name: 'COMPARE', page: comparePage, keys: [
        ...[0, 1].map((r) => row8(...Array.from({ length: 8 }, (_, c) => {
          const g = groups[r * 8 + c];
          return g ? k(`compare:${g.key}`, `COMPARE\\n${g.label}`, 'board') : null;
        }))),
        row8(k('show:compare', 'COMPARE\\nPICKED', 'board'), k('comparemark', 'COMPARE:\\nFLAG ⇄ EMBLEM', 'mode')),
        nav(p1, p1, 'BEFORE', p1 + 1, 'AFTER'),
      ],
    },
    ...Array.from({ length: teamsPages - 1 }, (_, n) => teamsPageOf(n + 1)),
    // everyone in People (General graphics) on a key of their own, by position: a person added is on the next free key
    slotPage(peoplePage, 'PEOPLE', (n) => `person:${n}`, 3, withPhoto(nav(p2, p2 + 3, 'TICKERS', p2, 'TEAMS'))),
  ];
}

const TEAMS_PER_PAGE = 8;
/** The bottom row of every page: its way around, then OUT (OV1), UNDO, ALL OUT and PANIC. */
// no UNDO key (the producer's ask); its place takes the ATEM downstream key in Companion where 2/7 is taken
const navRow = (...keys: DeckKey[]) => row8(...keys.slice(0, 4), keys[4] ?? null, null, k('allout', 'ALL\\nOUT', 'safety'), k('panic', 'PANIC\\n(press 2×)', 'safety'));
/** The nav row with PHOTO AUTO / ON / OFF in its free place (team pages, PEOPLE). */
const withPhoto = (row: (DeckKey | null)[]) => row.map((x, i) => (i === 4 ? k('photo', 'PHOTO\\nMODE', 'mode') : x));

/** A team's page on deck 2: its qualified and line-up graphics, its places (sailor's name on the key), ◀ ▶ to the next team. */
function teamPage(t: PresetTeam, i: number, teams: PresetTeam[], teamsPage: number): DeckPage {
  const page = PRESET_PAGES.teams + i;
  const other = (d: number) => teams[(i + d + teams.length) % teams.length];
  const tk = (action: string, text: string, kind: DeckKey['kind']): DeckKey => ({ ...k(action, text, kind), team: t.code });
  const places = t.crew.slice(0, 16).map((c) => tk(`sailorof:${t.code}/${c.slot}`, `${c.label.toUpperCase()}\\n${c.name ? `${c.number ? `#${c.number} ` : ''}${c.name.toUpperCase()}`.slice(0, 14) : '—'}`, 'sailor'));
  return {
    deck: 2, name: t.code, page, keys: [
      row8(tk(`qualified:${t.code}`, `QUALIFIED\\n${t.code}`, 'lt'), tk(`lineup:${t.code}`, `LINEUP\\n${t.code}`, 'board'),
        tk(`lult:${t.code}`, `LINEUP LT\\n${t.code}`, 'lt'), k('lultswap', 'LINEUP LT\\n5 ⇄ 4', 'lt'), null, null, null, k('next', 'NEXT\\nRESULT', 'lt')),
      row8(...places.slice(0, 8)),
      row8(...places.slice(8, 16)),
      withPhoto(navRow(k(`nav:${teamsPage}`, 'TEAMS', 'nav'), k(`nav:${PRESET_PAGES.teams + teams.indexOf(other(-1))}`, `◀\\n${other(-1).code}`, 'nav'),
        k(`nav:${PRESET_PAGES.teams + teams.indexOf(other(1))}`, `▶\\n${other(1).code}`, 'nav'), k(`nav:${PRESET_PAGES.deck2 + 1}`, 'BUGS\\nOFTEN', 'nav'))),
    ],
  };
}

/** Keys of a page of versions (announcements, tickers, people): `rows` rows of 8, action of the nth; `extra` fills the rest. */
function slotPage(page: number, name: string, action: (n: number) => string, rows: number, navRow: (DeckKey | null)[], ...extra: (DeckKey | null)[][]): DeckPage {
  const slots = Array.from({ length: rows }, (_, r) => row8(...Array.from({ length: 8 }, (_, c) => k(action(r * 8 + c + 1), '—', 'bug'))));
  const rest = [...extra, row8(), row8(), row8()].slice(0, 3 - rows);
  return { deck: 2, name, page, keys: [...slots, ...rest, navRow] };
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
  return pages.map((p) => ({
    ...p,
    keys: p.keys.map((row, r) => row.map((key, c) => {
      const o = cfg.keys[`${p.name}/${r}/${c}`];
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
  /** a board of the break scene is switching (its data must not be overwritten meanwhile) */
  private switching = false;
  private labels = new Map<string, string>();
  /** vMix's inputs as last read (the COMPARE keys follow the Team comparison inputs there). */
  private lastInputs: VmixInput[] = [];
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
      crew: crewOf(this.ctx, t.id).map((c) => ({ slot: c.slot, label: c.label, name: c.lastName || c.firstName, number: c.number })),
    })));
  }
  /** The pages of both decks with a page per team. */
  pages() {
    const teams = this.presetTeams(), groups = this.deckCompareGroups();
    this.keyEditsByName(teams, groups);
    return deckPages(this.config, teams, groups, this.compareGroups());
  }

  /**
   * Key edits were kept by page position ("12/0/2"): a page added before (BUGS OFTEN/RARE, another stage with more
   * teams) moved them onto other pages. Now they are kept by page name ("PUR/0/2"); the old ones move once, where
   * they show now, except onto the LINEUP LT keys (new in 1.0.140, so an edit there is one that slid onto them).
   */
  private keyEditsByName(teams: PresetTeam[], groups: PresetGroup[]) {
    const cfg = this.config;
    const old = Object.keys(cfg.keys).filter((id) => /^\d+\/\d+\/\d+$/.test(id));
    if (!old.length) return;
    const pages = defaultDeckPages(cfg, teams, groups);
    const keys = { ...cfg.keys };
    for (const id of old) {
      const [pi, r, c] = id.split('/').map(Number);
      const o = keys[id];
      delete keys[id];
      const p = pages[pi];
      const key = p?.keys[r]?.[c];
      if (!p || (key && /^lult/.test(key.action))) continue;
      const name = `${p.name}/${r}/${c}`;
      if (!keys[name]) keys[name] = o;
    }
    setShowConfig(this.ctx.db, { keys });
  }

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

  /** The groups of the stage of the group racing now (the ones the break scene can show). */
  breakStageFleets(): { id: string; name: string }[] {
    const cfg = this.config;
    const ev = activeEvent(this.ctx.db).id;
    for (const st of listSets(this.ctx.db, ev) as { id: string }[]) {
      const fleets = getSetDetail(this.ctx.db, st.id).fleets;
      if (fleets.some((f) => f.id === cfg.fleetId)) return fleets.map((f) => ({ id: f.id, name: f.name }));
    }
    return [];
  }
  /** Fleets that rotate in the break scene. */
  breakFleets(): string[] {
    const cfg = this.config;
    const stage = this.breakStageFleets();
    // picked on Show control (in the stage's order); none picked: every group but the Last Chance Race
    const picked = stage.filter((f) => cfg.breakFleets.includes(f.id));
    if (picked.length) return picked.map((f) => f.id);
    return stage.filter((f) => !/last\s*chance|\blcr\b/i.test(f.name)).map((f) => f.id);
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
    this.lastInputs = inputs;
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
    const names = g.inputs.flatMap((raw) => (raw.includes('{crew}') ? crews.map((c) => raw.replace('{crew}', String(c))) : [raw.replace('{n}', String(vars.n ?? n))]));
    const exact = (i: VmixInput, name: string) => i.title.toLowerCase() === name.toLowerCase() || i.title.toLowerCase().replace(/\.gtzip$/, '') === name.toLowerCase();
    // a GTZIP loaded under its own file name (Announcement_bug 2.gtzip) is found by that name too
    const loose = (v: string) => v.toLowerCase().replace(/\.gtzip$/, '').replace(/[^a-z0-9]+/g, '').replace(/\d+$/, '');
    const alias = (i: VmixInput) => (g.aliases ?? []).some((a) => loose(i.title) === loose(a));
    // a real title (with fields) before a placeholder image of the same name
    for (const titled of [true, false]) {
      const ok = (i: VmixInput) => !titled || i.fields.length > 0;
      for (const name of names) { const hit = inputs.find((i) => ok(i) && exact(i, name)); if (hit) return hit; }
      const hit = inputs.find((i) => ok(i) && alias(i));
      if (hit) return hit;
    }
    return undefined;
  }
  private need(g: Graphic, inputs: VmixInput[], vars?: Record<string, string | number>) {
    const i = this.resolve(g, inputs, vars);
    if (!i) throw badRequest(`vMix has no input ${g.inputs.join(' / ')} for ${g.label}. Add it (or its placeholder) on the Show control tab.`);
    return i;
  }

  /** Fields into the title, by its own field names (any case, GT's names cut at 15 characters too); one call each. */
  /**
   * The fields into the title. Only what differs from what vMix shows now goes (the data sync keeps the titles
   * current, so a key press mostly sends nothing and the graphic comes in at once); a picture also goes when its file
   * changed only with the REFRESH PNG key (refreshPictures). The calls go a few at a time. Returns how many fields were set.
   */
  private async set(input: VmixInput, fields: Map<string, string>) {
    const match = titleFieldMatcher(input.fields);
    const done = new Set<string>();
    const todo: [string, string][] = [];
    for (const [name, value] of fields) {
      const real = match(name);
      if (!real || done.has(real)) continue;
      done.add(real);
      const same = input.values !== undefined && (input.values[real] ?? '') === value;
      if (same) continue;
      todo.push([real, value]);
    }
    const id = encodeURIComponent(input.key || input.number);
    for (let i = 0; i < todo.length; i += SET_BATCH) {
      await Promise.all(todo.slice(i, i + SET_BATCH).map(([real, value]) =>
        this.vmix(`?Function=${real.endsWith('.Source') ? 'SetImage' : 'SetText'}&Input=${id}&SelectedName=${encodeURIComponent(real)}&Value=${encodeURIComponent(value)}`)));
    }
    // what vMix holds now, for the next set() before the next read of vMix
    for (const [real, value] of todo) {
      if (input.values) input.values[real] = value;
    }
    return todo.length;
  }
  /** set(), but a title that takes none of the fields (a placeholder image, an old GTZIP) is an error naming what it has. */
  private async setOrExplain(input: VmixInput, g: Graphic, fields: Map<string, string>, blind?: () => Map<string, string>) {
    if (await this.set(input, fields)) return;
    const { inputs } = await this.snapshot();
    const same = inputs.filter((i) => i.title.toLowerCase().replace(/\.gtzip$/, '') === input.title.toLowerCase().replace(/\.gtzip$/, ''));
    // a title whose fields vMix did not list: the data goes in by the GTZIP's own field names all the same
    const title = (i: VmixInput) => /^(gt|xaml|title)/i.test(i.type ?? '');
    const gt = same.find(title) ?? (title(input) ? input : undefined);
    if (gt && blind) {
      for (const [name, value] of blind()) await this.vmix(`?Function=${name.endsWith('.Source') ? 'SetImage' : 'SetText'}&Input=${encodeURIComponent(gt.key || gt.number)}&SelectedName=${encodeURIComponent(name)}&Value=${encodeURIComponent(value)}`);
      return gt;
    }
    const list = same.map((i) => `input ${i.number} (${i.type || 'unknown type'}, ${i.fields.length ? `fields ${i.fields.join(', ')}` : 'no title fields'})`).join('; ');
    const twice = same.length > 1 ? ` vMix has ${same.length} inputs named "${input.title}": delete the placeholder image and keep the GTZIP title.` : '';
    throw badRequest(`vMix input "${input.title}" (${g.label}) takes none of the data: ${list || `input ${input.number}, no title fields`}.${twice} Load the ${g.label} GTZIP title in vMix and name it ${g.inputs[0]}.`);
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
    if (overlays[n]) this.ltLeft(overlays[n]);
    return true;
  }
  private async overlayOut(n: number, overlays: Record<string, string>) {
    if (!overlays[n]) return false;
    await this.vmix(`?Function=OverlayInput${n}Out`);
    this.ltLeft(overlays[n]);
    return true;
  }

  /** A lower third title that left the screen some other way than its OUT: its photo is emptied off air, so the next sailor comes in at once. */
  private ltLeft(number: string) {
    const input = this.lastInputs.find((i) => i.number === number);
    if (input && this.isLtTitle(input)) this.lt.clearPhotoOffAir(input);
  }

  /** Bring a graphic in on its overlay, after its data is in; takes off what it must not sit on. */
  private async bringIn(g: Graphic, input: VmixInput, snap: { overlays: Record<string, string> }) {
    this.pushUndo(snap.overlays);
    const lt = getLtConfig(this.ctx.db).overlay;
    // what must go first; a graphic on the same channel simply replaces what is there
    const off = new Set<number>(g.kind === 'board' ? [lt] : g.kind === 'scene' ? [1, lt] : []);
    off.delete(g.overlay);
    // the break scene's own layers (L-bar, ticker, boards) leave another overlay at once: their out animation would
    // leave the title out, so hidden inside the scene
    for (const n of off) await this.overlayOut(n, snap.overlays);
    if (g.kind === 'board' && this.breakOnAir({ inputs: this.lastInputs, overlays: snap.overlays })) await this.sceneOut(snap.overlays);
    if (g.kind === 'scene' && g.id !== 'break') this.stopRotation();
    await this.overlayIn(g.overlay, input, snap.overlays);
  }

  /** The break scene off: its overlay channels (L-bar, ticker, board) go out with their animations. */
  private async sceneOut(overlays: Record<string, string>) {
    this.stopRotation();
    const cfg = this.config;
    for (const n of [cfg.breakBoardLayer, cfg.breakTickerLayer, cfg.breakLbarLayer]) await this.overlayOut(n, overlays);
  }
  /** On air: the L-bar on its channel, or a board (day schedule / group results) on the board channel. */
  breakOnAir(snap: { inputs: VmixInput[]; overlays: Record<string, string> }) {
    const cfg = this.config;
    const on = (id: string, n: number) => { const i = this.resolve(this.graphic(id), snap.inputs); return !!i && snap.overlays[n] === i.number; };
    const board = snap.overlays[cfg.breakBoardLayer];
    return on('lbar', cfg.breakLbarLayer) || on('schedule', cfg.breakBoardLayer) || (!!board && this.resultsTargets(snap.inputs).some((t) => t.input.number === board));
  }
  /** A group's own results input (ssl_results_H), if vMix has it. */
  private ownResults(fleetId: string, inputs: VmixInput[]) {
    const g = this.allCompareGroups().find((x) => x.fleetId === fleetId);
    return g ? inputs.find((x) => x.title.toLowerCase().replace(/\.gtzip$/, '') === resultsInput(g.key).toLowerCase()) : undefined;
  }
  /** The results input of a group: its own (ssl_results_H), else the shared one. */
  private resultsFor(fleetId: string, inputs: VmixInput[]) {
    return this.ownResults(fleetId, inputs) ?? this.need(this.graphic('results'), inputs);
  }
  /** Every group's own results input, and the shared one. */
  private resultsTargets(inputs: VmixInput[]) {
    const out: { input: VmixInput; fleetId: string | null }[] = [];
    for (const g of this.allCompareGroups()) { const i = this.ownResults(g.fleetId, inputs); if (i) out.push({ input: i, fleetId: g.fleetId }); }
    const shared = this.resolve(this.graphic('results'), inputs);
    if (shared && !out.some((x) => x.input.number === shared.number)) out.push({ input: shared, fleetId: null });
    return out;
  }
  /** GROUP RESULTS of one group (RESULTS H…): its data into its own input (else the shared one), then in; again = out. */
  async resultsGroup(arg: string) {
    const grp = [...this.compareGroups(), ...this.allCompareGroups()].find((x) => x.key === compareKey(arg) || x.fleetId === arg);
    if (!grp) throw notFound(`Group ${arg} in this stage`);
    const g = this.graphic('results');
    const snap = await this.snapshot();
    const input = this.resultsFor(grp.fleetId, snap.inputs);
    if (snap.overlays[g.overlay] === input.number) {
      this.pushUndo(snap.overlays);
      await this.overlayOut(g.overlay, snap.overlays);
      return { out: 'results', group: grp.label };
    }
    await this.set(input, resultFieldsFor(this.ctx, grp.fleetId, input).fields);
    await this.bringIn(g, input, snap);
    return { in: 'results', group: grp.label, input: input.title };
  }

  /** The data of a graphic, set right before it comes in. */
  private async fill(g: Graphic, input: VmixInput) {
    const ev = activeEvent(this.ctx.db).id;
    if (g.id === 'results') {
      if (!this.config.fleetId) throw badRequest('Pick the race (group) on the Show control tab.');
      await this.set(input, resultFieldsFor(this.ctx, this.config.fleetId, input).fields);
    } else if (g.id === 'compare') {
      if (!this.config.fleetId) throw badRequest('Pick the race (group) on the Show control tab.');
      await this.set(input, this.compareData());
    } else if (g.id === 'ticker') {
      await this.set(input, new Map([[this.textField(input, /ticker|text/i) ?? '', this.tickerText()]]));
    } else if (g.id === 'lineup5') {
      const b = this.boats()[this.state.boat - 1];
      if (b) { await this.set(input, this.lineupLtFields(b.id, 1)); this.patchState({ lineupPart: 1, lineupTeam: b.id }); }
    } else if (g.id === 'bug') {
      // BUG key without a version: the announcement shown last, else the first one
      const a = (this.state.bugId && this.announcement(this.state.bugId)) || this.announcements()[0];
      if (a) { await this.setOrExplain(input, g, this.bugFields(input, a.data), () => this.bugBlind(a.data)); this.patchState({ bug: (a.data.text || a.name), bugId: a.id }); }
    } else {
      // General graphics straight into the title, so a change made a moment ago is on air without waiting for Excel
      const e = activeEvent(this.ctx.db);
      const f = showDataFields(this.ctx, g.id, { eventId: ev, today: todayIn(e.timezone), auto: tickerAuto(this.ctx.db, e), tickerText: this.tickerText() });
      if (f) await this.set(input, f);
    }
  }

  /** Team comparison of a group (default: the one picked at the top), with the flag or the emblem by each team (COMPARE key). */
  private compareData(fleetId = this.config.fleetId) {
    const ev = activeEvent(this.ctx.db);
    return compareFields(this.ctx, ev.id, fleetId, todayIn(ev.timezone), { mark: this.state.compareMark, emblemSlot: getLtConfig(this.ctx.db).emblemSlot });
  }

  /** The groups of the stage picked at the top (every stage when none is), each with its key: A, B… or FINAL. */
  compareGroups(): PresetGroup[] {
    return this.cached('compareGroups', () => {
      const ev = activeEvent(this.ctx.db).id;
      const stage = currentStage(this.ctx.db, ev);
      return this.groupsOf(stage ? [stage.id] : (listSets(this.ctx.db, ev) as { id: string }[]).map((x) => x.id));
    });
  }
  /** Groups of these stages, a key each (the first stage wins a key two stages share). */
  private groupsOf(sets: string[]): PresetGroup[] {
    const seen = new Set<string>();
    return sets.flatMap((id) => getSetDetail(this.ctx.db, id).fleets).map((f) => ({ fleetId: f.id, key: compareKey(f.name), label: compareKey(f.name) === 'LCR' ? 'Last Chance' : groupLabel(f.name) }))
      .filter((g) => g.key && !seen.has(g.key) && !!seen.add(g.key));
  }
  /** Every group of the event, the stage picked at the top first. */
  private allCompareGroups(): PresetGroup[] {
    return this.cached('allCompareGroups', () => {
      const ev = activeEvent(this.ctx.db).id;
      const stage = currentStage(this.ctx.db, ev);
      const all = (listSets(this.ctx.db, ev) as { id: string }[]).map((x) => x.id);
      return this.groupsOf(stage ? [stage.id, ...all.filter((x) => x !== stage.id)] : all);
    });
  }
  /** The COMPARE keys: one per Team comparison input vMix has (ssl_compare_A…), else one per group of the stage; the stage's Last Chance Race always. */
  deckCompareGroups(): PresetGroup[] {
    const has = (g: PresetGroup) => this.lastInputs.some((i) => i.title.toLowerCase().replace(/\.gtzip$/, '') === compareInput(g.key).toLowerCase());
    const inVmix = this.allCompareGroups().filter(has);
    if (!inVmix.length) return this.compareGroups();
    // the stage's Last Chance Race has its key from the start (its input ssl_compare_LCR)
    const lcr = this.compareGroups().filter((g) => g.key === 'LCR' && !inVmix.some((x) => x.key === 'LCR'));
    return [...inVmix, ...lcr];
  }

  /** Each group's own Team comparison input (ssl_compare_A…); the shared one (ssl_compare) for the group picked at the top. */
  private compareTargets(inputs: VmixInput[]) {
    const out: { input: VmixInput; fleetId: string }[] = [];
    for (const g of this.allCompareGroups()) {
      const i = inputs.find((x) => x.title.toLowerCase().replace(/\.gtzip$/, '') === compareInput(g.key).toLowerCase());
      if (i) out.push({ input: i, fleetId: g.fleetId });
    }
    const shared = this.resolve(this.graphic('compare'), inputs);
    if (shared && this.config.fleetId && !out.some((x) => x.input.key === shared.key)) out.push({ input: shared, fleetId: this.config.fleetId });
    return out;
  }

  /** A group's Team comparison (COMPARE A…): its data into its own input, then in on the boards overlay; again = out. */
  async compareGroup(arg: string) {
    const groups = [...this.compareGroups(), ...this.allCompareGroups()];
    const grp = groups.find((x) => x.key === compareKey(arg) || x.fleetId === arg);
    if (!grp) throw notFound(`Group ${arg} in this stage`);
    const g = this.graphic('compare');
    const snap = await this.snapshot();
    const own = snap.inputs.find((x) => x.title.toLowerCase().replace(/\.gtzip$/, '') === compareInput(grp.key).toLowerCase());
    const input = own ?? this.need(g, snap.inputs);
    if (snap.overlays[g.overlay] === input.number) {
      this.pushUndo(snap.overlays);
      await this.overlayOut(g.overlay, snap.overlays);
      return { out: 'compare', group: grp.label };
    }
    await this.set(input, this.compareData(grp.fleetId));
    await this.bringIn(g, input, snap);
    return { in: 'compare', group: grp.label, input: input.title };
  }

  /** Flag ⇄ emblem on Team comparison; every group's title shows the change at once (on air too, as a data change). */
  async compareMark() {
    const mark = this.state.compareMark === 'emblem' ? 'flag' : 'emblem';
    this.patchState({ compareMark: mark });
    const { inputs, overlays } = await this.snapshot();
    // the title's flag change animation (DataChangeOut / In) is started by the last flag (4 FLAG): that one goes first,
    // the others once the flags have faded out, so every flag changes inside the animation instead of before it
    const num = (k: string) => Number(k.match(/(\d+)/)?.[1] ?? 0);
    for (const t of this.compareTargets(inputs)) {
      const flags = [...this.compareData(t.fleetId)].filter(([k]) => /flag\.source$/i.test(k)).sort((a, b) => num(b[0]) - num(a[0]));
      const onAir = Object.values(overlays).includes(t.input.number);
      const top = num(flags[0]?.[0] ?? '');
      const first = flags.filter(([k]) => num(k) === top), rest = flags.filter(([k]) => num(k) !== top);
      const sent = await this.set(t.input, new Map(first));
      if (onAir && sent) await this.wait(this.config.flagChangeMs);
      await this.set(t.input, new Map(rest));
    }
    return { compareMark: mark };
  }

  /** The lineup lower third: the team's line-up from the bow to the stern (8–10 sailors, Floater too), on two screens. */
  lineupLtParts(teamId: string): LtSailor[][] {
    const crew = this.crewBowToStern(teamId).slice(0, 10);
    // two screens of at most five, as even as can be: 10 = 5 + 5, 9 = 5 + 4, 8 = 4 + 4
    const first = crew.length > 5 ? Math.ceil(crew.length / 2) : crew.length;
    return [crew.slice(0, first), crew.slice(first)].filter((p) => p.length);
  }
  /** The team's sailors (with a name) from the bow to the stern, Floater between Pit and Grinder, extra places last. */
  crewBowToStern(teamId: string, order: string[] = BOW_TO_STERN): LtSailor[] {
    const all = crewOf(this.ctx, teamId).filter((s) => s.lastName || s.firstName);
    const rank = (slot: string) => { const i = order.indexOf(slot); return i < 0 ? order.length : i; };
    return all.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s.slot) - rank(b.s.slot) || a.i - b.i).map((x) => x.s);
  }
  /**
   * Lineup_lowerthird_9.gtzip: places 1–5 show five sailors, places 6–9 four (centred); a screen of five goes on 1–5,
   * a screen of four on 6–9, and the other places are emptied. NAME n = surname, POSITION n, PHOTO n; the bar is the team's lt_lineup_bar PNG.
   */
  lineupLtFields(teamId: string, part: number) {
    const parts = this.lineupLtParts(teamId);
    const crew = parts[part - 1] ?? [];
    const f = new Map<string, string>();
    const five = crew.length >= 5;
    for (let i = 1; i <= 9; i++) {
      const s = five ? (i <= 5 ? crew[i - 1] : undefined) : (i > 5 ? crew[i - 6] : undefined);
      // I. SLADDER and 5 | MIDBOW
      f.set(`NAME ${i}.Text`, s ? [s.firstName.trim() ? `${s.firstName.trim()[0].toUpperCase()}.` : '', s.lastName].filter(Boolean).join(' ') : '');
      f.set(`POSITION ${i}.Text`, s ? [s.number, s.position].filter(Boolean).join(' | ') : '');
      f.set(`PHOTO ${i}.Source`, s?.photo ?? '');
    }
    const t = listTeams(this.ctx).find((x) => x.id === teamId);
    const bar = t && teamPictureFor(this.ctx, t, { w: 1280, h: 140, key: 'ltlineupbar', like: /lineupbar/, exact: true });
    if (bar) f.set('Bar.Source', bar);
    return f;
  }
  /** LINEUP LT <team>: the team's first five come in (from another team: a data change); the same key again: out. */
  async lineupLt(code?: string) {
    const b = code ? this.teamRef(code) : this.boat(this.state.boat);
    const g = this.graphic('lineup5');
    const snap = await this.snapshot();
    const input = this.need(g, snap.inputs);
    const on = snap.overlays[g.overlay] === input.number;
    if (on && this.state.lineupTeam === b.id) {
      this.pushUndo(snap.overlays);
      await this.overlayOut(g.overlay, snap.overlays);
      this.patchState({ lineupPart: 0, lineupTeam: '' });
      return { out: 'lineup5' };
    }
    if (!this.lineupLtParts(b.id).length) throw badRequest(`No sailors in the ${b.code} line-up.`);
    await this.set(input, this.lineupLtFields(b.id, 1));
    if (!on) await this.bringIn(g, input, snap);
    this.patchState({ lineupPart: 1, lineupTeam: b.id });
    return { in: 'lineup5', team: b.code, part: 1 };
  }
  /** LINEUP LT 5 ⇄ 4: the lineup lower third on air swaps between its five and its four (a data change). */
  async lineupLtSwap() {
    const g = this.graphic('lineup5');
    const snap = await this.snapshot();
    const input = this.need(g, snap.inputs);
    const teamId = this.state.lineupTeam;
    if (snap.overlays[g.overlay] !== input.number || !teamId) throw badRequest('Bring a team’s LINEUP LT in first.');
    const parts = this.lineupLtParts(teamId).length;
    const part = this.state.lineupPart === 1 && parts > 1 ? 2 : 1;
    await this.set(input, this.lineupLtFields(teamId, part));
    this.patchState({ lineupPart: part });
    return { in: 'lineup5', part };
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
    // the bar of every other lower third (lowerthird PNG), not one guessed from this title
    const barField = ltRoles(lt.fields, input.fields).bar;
    const bar = this.lt.standardBar(b.id);
    if (barField && bar) out.set(barField, bar);
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
    if (id === 'break') return this.toggleBreak();
    if (id === 'results' && this.config.fleetId) {
      const { inputs } = await this.snapshot();
      if (this.ownResults(this.config.fleetId, inputs)) return this.resultsGroup(this.config.fleetId);
    }
    const g = this.graphic(id);
    const snap = await this.snapshot();
    const input = this.need(g, snap.inputs);
    if (snap.overlays[g.overlay] === input.number) {
      this.pushUndo(snap.overlays);
      await this.overlayOut(g.overlay, snap.overlays);
      return { out: g.id };
    }
    await this.fill(g, input);
    if (g.id === 'ticker') this.patchState({ tickerId: '' });
    await this.bringIn(g, input, snap);
    return { in: g.id, input: input.title };
  }

  async commentator(role: string) {
    const roles: Record<string, string[]> = { host: ['host commentator'], guest: ['guest commentator', 'guest'], water: ['on-water commentator'], studio: ['host commentator'] };
    const want = roles[role] ?? [role.toLowerCase()];
    const ev = activeEvent(this.ctx.db).id;
    const people = listPeople(this.ctx, ev).filter((p) => want.includes((p.role || '').toLowerCase()) && (p.name || p.surname));
    if (!people.length) throw badRequest(`Nobody with the role ${want[0]} in People (General graphics).`);
    return this.personLt(people[0]);
  }

  /** People in General graphics with a name, in their order (PEOPLE page: a key each). */
  people() { return this.cached('people', () => listPeople(this.ctx, activeEvent(this.ctx.db).id).filter((p) => p.name || p.surname)); }

  /** A person's lower third (PEOPLE key by position): their name and title, the photo title when they have a photo. */
  async person(n: string) {
    const p = this.people()[Number(n) - 1];
    if (!p) throw badRequest(`No person ${n} in People (General graphics).`);
    return this.personLt(p);
  }

  private async personLt(p: ReturnType<typeof listPeople>[number]) {
    const g = this.graphic('comm');
    const snap = await this.snapshot();
    const photo = p.photo ? img(p.photo as unknown as Asset) : '';
    const withPhoto = photo ? this.resolve({ ...g, inputs: g.inputs.slice(0, 1) }, snap.inputs) : undefined;
    const input = withPhoto ?? this.resolve({ ...g, inputs: g.inputs.slice(1) }, snap.inputs) ?? this.need(g, snap.inputs);
    const lf = getLtConfig(this.ctx.db).fields;
    const f = this.lt.fitToTitle(input, new Map<string, string>([[`${lf.top}.Text`, personName(p)], [`${lf.bottom}.Text`, p.role || ''], [`${lf.photo}.Source`, photo]]), null);
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
      ['TeamName.Text', lu.teamName || team.name], ['LineupText.Text', lu.title]]);
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
      f.set(`${fl.name}.Text`, r?.firstName ?? '');
      f.set(`${fl.surname}.Text`, r?.lastName ?? '');
      f.set(`${fl.number}.Text`, r?.number ?? '');
      f.set(`${fl.position}.Text`, r?.position ?? '');
      f.set(`${fl.photo}.Source`, s?.photo ?? '');
    }
    // boards with numbered places (Team_lineup_8/9/10: S1 = bow … S10 = stern): the crew from the bow, whoever sails
    if (input.fields.some((x) => /^S1NAME\.Text$/i.test(x))) {
      const rows = new Map(lu.rows.map((r) => [r.slot, r]));
      const crewList = this.crewBowToStern(b.id, BOARD_BOW_TO_STERN);
      for (let n = 1; n <= 12; n++) {
        const s = crewList[n - 1];
        const r = s ? rows.get(s.slot) : undefined;
        f.set(`S${n}NAME.Text`, s?.firstName ?? '');
        f.set(`S${n}SURNAME.Text`, s?.lastName ?? '');
        f.set(`S${n}NUMBER.Text`, s?.number ?? '');
        f.set(`S${n}POSITION.Text`, (r?.position || s?.position) ?? '');
        f.set(`S${n}PHOTO.Source`, s?.photo ?? '');
      }
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
    // by position on BUGS OFTEN (o3) or BUGS RARE (r3)
    const m = which.match(/^([or])(\d+)$/i);
    if (m) return list.filter((x) => isOften(x) === (m[1].toLowerCase() === 'o'))[Number(m[2]) - 1];
    return list.find((x) => x.id === which) ?? (/^\d+$/.test(which) ? list[Number(which) - 1] : undefined);
  }

  /** The bug's text and icon, by the title's field names (TEXT; Race flag, ICON, FLAG, STAR… but not icon_background). */
  private bugFields(input: VmixInput, data: Record<string, string>) {
    const f = new Map<string, string>();
    const text = this.textField(input, /text/i);
    if (text) f.set(text, data.text ?? '');
    const pics = input.fields.filter((x) => x.endsWith('.Source') && !/background|\bbg\b|_bg|bar/i.test(x));
    const icon = [/race ?flag/i, /^icon\./i, /flag/i, /icon/i, /star/i, /logo/i].map((re) => pics.find((x) => re.test(x))).find(Boolean);
    if (icon) f.set(icon, imagePath(this.ctx.db, this.ctx.assetsDir, data.icon));
    return f;
  }

  /** The bug's data by the Announcement bug GTZIP's own field names (TEXT; the flag as Race flag or icon). */
  private bugBlind(data: Record<string, string>) {
    const icon = imagePath(this.ctx.db, this.ctx.assetsDir, data.icon);
    return new Map([['TEXT.Text', data.text ?? ''], ['Race flag.Source', icon], ['icon.Source', icon]]);
  }

  /** Announcement bug: its text and icon go into the title, then it comes in; the same key again takes it out. */
  async bug(which: string) {
    if (which === 'thanks') return this.ticker('thanks');
    const a = this.announcement(which);
    if (!a) throw badRequest(`No announcement ${which}. Add it under General graphics → Announcements.`);
    const g = this.graphic('bug');
    const snap = await this.snapshot();
    const input = this.need(g, snap.inputs);
    const on = snap.overlays[g.overlay] === input.number;
    if (on && this.state.bugId === a.id) {
      this.pushUndo(snap.overlays);
      await this.overlayOut(g.overlay, snap.overlays);
      this.patchState({ bugId: '' });
      return { out: 'bug' };
    }
    const used = (await this.setOrExplain(input, g, this.bugFields(input, a.data), () => this.bugBlind(a.data))) ?? input;
    const text = a.data.text || a.name;
    this.patchState({ bug: text, bugId: a.id });
    await this.bringIn(g, used, snap);
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
    // the break scene on air: the ticker on its channel goes out, takes the text and comes back in
    if (this.breakOnAir(snap)) {
      const text = await this.swapTicker(t, input, snap.overlays);
      return { in: 'ticker', text, scene: true };
    }
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
    const snap = await this.snapshot();
    await this.clearForSailor(snap);
    // photo mode: the lower thirds pick the photo title when the sailor has a photo; OFF forces the other one
    if (mode === 'off' && s.photo) return this.lt.showSailor(b.code, s.slot, { forceNoPhoto: true });
    return this.lt.showSailor(b.code, s.slot);
  }

  /** A place of a team's line-up (its page's keys): the sailor on it now, with the photo mode of the tab. */
  async sailorOf(code: string, slot: string) {
    const t = this.teamRef(code);
    const snap = await this.snapshot();
    await this.clearForSailor(snap);
    return this.lt.showSailor(t.code, slot, { forceNoPhoto: this.state.photo === 'off' });
  }

  /** Is this vMix input one of the lower third titles (photo / no photo)? */
  private isLtTitle(input?: VmixInput) {
    const cfg = getLtConfig(this.ctx.db);
    const name = (input?.title ?? '').toLowerCase().replace(/\.gtzip$/, '');
    return !!name && [cfg.photoInput, cfg.noPhotoInput].some((x) => x && x.toLowerCase() === name);
  }

  /**
   * Before a sailor's lower third: a board on OV1 goes out; a lower third stays on, so the next sailor is only a data
   * change (taking it out first left its photo in the title, and the next one waited ~3 s for that photo to fly away).
   */
  private async clearForSailor(snap: { inputs: VmixInput[]; overlays: Record<string, string> }) {
    const on = snap.overlays[1];
    if (!on) return;
    this.pushUndo(snap.overlays);
    const input = snap.inputs.find((i) => i.number === on);
    if (getLtConfig(this.ctx.db).overlay === 1 && this.isLtTitle(input)) return;
    await this.overlayOut(1, snap.overlays);
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

  /** OUT: whatever is on OV1 goes out with its animation (a lower third through its own out, so its photo flies down first). */
  async layerOut() {
    const s = await this.snapshot();
    const on = s.overlays[1];
    if (!on) return { out: '' };
    this.pushUndo(s.overlays);
    const cfg = getLtConfig(this.ctx.db);
    const input = s.inputs.find((i) => i.number === on);
    const name = (input?.title ?? '').toLowerCase().replace(/\.gtzip$/, '');
    if (cfg.overlay === 1 && [cfg.photoInput, cfg.noPhotoInput].some((x) => x && x.toLowerCase() === name)) await this.lt.out();
    else await this.overlayOut(1, s.overlays);
    return { out: name };
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
  slides(): { kind: 'schedule' | 'results'; fleetId?: string }[] {
    const out: { kind: 'schedule' | 'results'; fleetId?: string }[] = this.config.breakSchedule ? [{ kind: 'schedule' }] : [];
    for (const f of this.breakFleets()) out.push({ kind: 'results', fleetId: f });
    return out.length ? out : [{ kind: 'schedule' as const }];
  }
  private wait(ms: number) { return ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve(); }
  /**
   * BREAK SCENE: three inputs on three overlay channels, each with its own in and out animation: the L-bar (channel 2),
   * the ticker (3: the ticker picked last, else the automatic one) and the day schedule (4), which then switches with
   * the group results. Again: all three go out.
   */
  private async toggleBreak() {
    const snap = await this.snapshot();
    const cfg = this.config;
    if (this.breakOnAir(snap)) {
      this.pushUndo(snap.overlays);
      await this.sceneOut(snap.overlays);
      return { out: 'break' };
    }
    this.pushUndo(snap.overlays);
    const lbar = this.resolve(this.graphic('lbar'), snap.inputs);
    const tk = this.resolve(this.graphic('ticker'), snap.inputs);
    const board = this.slideInput(this.slides()[0], snap.inputs);
    // what sits on channel 1 or on the lower third channel goes; an input of the scene leaves at once (no out animation),
    // so it comes in on its own channel with its in animation
    const mine = new Set([lbar, tk, board].filter(Boolean).map((i) => i!.number));
    for (const n of new Set([1, getLtConfig(this.ctx.db).overlay])) {
      if (!snap.overlays[n] || [cfg.breakLbarLayer, cfg.breakTickerLayer, cfg.breakBoardLayer].includes(n)) continue;
      if (mine.has(snap.overlays[n])) await this.vmix(`?Function=OverlayInput${n}Off`);
      else await this.overlayOut(n, snap.overlays);
    }
    if (lbar) { await this.fill(this.graphic('lbar'), lbar); await this.overlayIn(cfg.breakLbarLayer, lbar, snap.overlays); }
    else this.log('Break scene: no L-bar input in vMix (ssl_lbar).');
    if (tk) {
      const t = this.state.tickerId ? this.tickerVersion(this.state.tickerId) : undefined;
      const text = t ? tickerText(t.data, tickerAuto(this.ctx.db, activeEvent(this.ctx.db))) : this.tickerText();
      await this.set(tk, new Map([[this.textField(tk, /ticker|text/i) ?? '', text]]));
      await this.overlayIn(cfg.breakTickerLayer, tk, snap.overlays);
    }
    await this.fillSlide(this.slides()[0], board);
    await this.overlayIn(cfg.breakBoardLayer, board, snap.overlays);
    this.patchState({ slide: 0 });
    if (cfg.breakAuto) this.startRotation();
    return { in: 'break', lbar: lbar?.title ?? null, ticker: tk?.title ?? null, board: board.title };
  }
  private slideInput(s: { kind: 'schedule' | 'results'; fleetId?: string }, inputs: VmixInput[]) {
    if (s.kind === 'results' && s.fleetId) return this.resultsFor(s.fleetId, inputs);
    return this.need(this.graphic(s.kind === 'schedule' ? 'schedule' : 'results'), inputs);
  }
  private async fillSlide(s: { kind: 'schedule' | 'results'; fleetId?: string }, input: VmixInput) {
    if (s.kind === 'results' && s.fleetId) await this.set(input, resultFieldsFor(this.ctx, s.fleetId, input).fields);
    else await this.fill(this.graphic('schedule'), input);
  }
  /**
   * The next board on the board channel. On air the board there goes out (its out animation), the next one gets its
   * data and comes in (its in animation); off air only the data and the place in the order change.
   */
  private async showSlide(i: number) {
    const slides = this.slides();
    const s = slides[i];
    const snap = await this.snapshot();
    const n = this.config.breakBoardLayer;
    const input = this.slideInput(s, snap.inputs);
    const onAir = this.breakOnAir(snap);
    // the same title for two groups (group H, then group I): out first, the new group's data only once it is off
    // air, then in; meanwhile the data sync leaves the title alone
    this.switching = true;
    try {
      if (onAir && snap.overlays[n]) {
        await this.vmix(`?Function=OverlayInput${n}Out`);
        await this.wait(this.config.breakOutMs);
      }
      this.patchState({ slide: i });
      await this.fillSlide(s, input);
      if (onAir) await this.vmix(`?Function=OverlayInput${n}In&Input=${encodeURIComponent(input.key || input.number)}`);
    } finally { this.switching = false; }
    return { slide: i, of: slides.length, showing: s };
  }
  /** A ticker version on the ticker on air (break channel or channel 1): out, the new text, in. */
  private async swapTicker(t: { id: string; data: Record<string, string> }, input: VmixInput, overlays: Record<string, string>) {
    const text = tickerText(t.data, tickerAuto(this.ctx.db, activeEvent(this.ctx.db)));
    const field = this.textField(input, /ticker|text/i) ?? '';
    const n = [this.config.breakTickerLayer, this.graphic('ticker').overlay].find((x) => overlays[x] === input.number);
    if (n) {
      await this.vmix(`?Function=OverlayInput${n}Out`);
      await this.wait(this.config.breakOutMs);
      await this.set(input, new Map([[field, text]]));
      await this.vmix(`?Function=OverlayInput${n}In&Input=${encodeURIComponent(input.key || input.number)}`);
    } else await this.set(input, new Map([[field, text]]));
    this.patchState({ tickerId: t.id });
    return text;
  }
  /** A ticker key of the break scene: on air the ticker goes out and comes back with it; off air it is the one the next break shows. */
  async breakTicker(which: string) {
    const t = this.tickerVersion(which);
    if (!t) throw badRequest(`No ticker ${which}. Add it under General graphics → Tickers.`);
    const snap = await this.snapshot();
    const input = this.need(this.graphic('ticker'), snap.inputs);
    const text = await this.swapTicker(t, input, snap.overlays);
    return { ticker: t.name, text, onAir: this.breakOnAir(snap) };
  }
  /** NEXT TICKER: the next version of Tickers (General graphics); on air it goes out and comes back in with the new text. */
  async nextTicker() {
    const list = this.tickers();
    if (!list.length) throw badRequest('No tickers. Add them under General graphics → Tickers.');
    const at = list.findIndex((x) => x.id === this.state.tickerId);
    const t = list[(at + 1) % list.length];
    const snap = await this.snapshot();
    const input = this.need(this.graphic('ticker'), snap.inputs);
    const text = await this.swapTicker(t, input, snap.overlays);
    return { ticker: t.name, text };
  }
  async nextSlide() {
    return this.showSlide((this.state.slide + 1) % this.slides().length);
  }
  startRotation() {
    this.stopRotation();
    this.patchState({ rotating: true });
    this.rotation = setInterval(() => { if (!this.config.breakAuto) { this.stopRotation(); return; } this.nextSlide().catch((e) => this.log(`Break rotation: ${e?.message ?? e}`)); }, this.config.rotateSeconds * 1000);
    this.rotation.unref?.();
  }
  stopRotation() {
    if (this.rotation) clearInterval(this.rotation);
    this.rotation = null;
    if (this.state.rotating) this.patchState({ rotating: false });
  }
  /** AUTO SWITCH on or off: kept for the next break too; on air it starts or stops at once. */
  async toggleRotation() {
    const on = !this.config.breakAuto;
    setShowConfig(this.ctx.db, { breakAuto: on });
    const snap = await this.snapshot().catch(() => null);
    if (on && snap && this.breakOnAir(snap)) this.startRotation();
    if (!on) this.stopRotation();
    return { rotating: !!this.rotation, auto: on };
  }

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
      case 'lult': return this.lineupLt(arg);
      case 'lultswap': return this.lineupLtSwap();
      case 'show': return arg === 'lineup5' ? this.lineupLt() : arg === 'compare' && this.config.fleetId && this.compareGroups().some((g) => g.fleetId === this.config.fleetId) ? this.compareGroup(this.config.fleetId) : this.toggle(arg);
      case 'compare': return this.compareGroup(arg);
      case 'results': return this.resultsGroup(arg);
      case 'qualified': return this.qualified(arg);
      case 'comm': return this.commentator(arg);
      case 'refreshpng': return this.refreshPictures();
      case 'person': return this.person(arg);
      case 'anthem': return this.lt.showTeam(this.teamRef(arg).code);
      case 'lineup': return this.lineup(arg);
      case 'sailorof': { const [code, slot = ''] = arg.split('/'); return this.sailorOf(code, slot); }
      case 'boat': { const n = Number(arg); this.boat(n); this.patchState({ boat: n }); return { boat: n }; }
      case 'sailor': return this.sailor(Number(arg));
      case 'shirt': return this.sailor(null, arg);
      case 'photo': { const m = ({ auto: 'on', on: 'off', off: 'auto' } as const)[this.state.photo]; this.patchState({ photo: m }); return { photo: m }; }
      case 'next': return this.lt.nextLine();
      case 'teamlt': return this.lt.showTeam(arg ? this.teamRef(arg).code : this.boat(this.state.boat).code);
      case 'out': case 'ltout': case 'boardout': return this.layerOut();
      case 'bug': return this.bug(arg);
      case 'ticker': return this.ticker(arg);
      case 'bugout': { const s = await this.snapshot(); this.pushUndo(s.overlays); await this.overlayOut(this.graphic('bug').overlay, s.overlays); return { out: 'bug' }; }
      case 'breakout': { const s = await this.snapshot(); this.pushUndo(s.overlays); await this.sceneOut(s.overlays); return { out: 'scene' }; }
      case 'rotate': return this.toggleRotation();
      case 'nextslide': return this.nextSlide();
      case 'nextticker': return this.nextTicker();
      case 'breakticker': return this.breakTicker(arg);
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
    } else if (kind === 'breakticker') {
      const t = this.tickerVersion(arg);
      text = t ? `TICKER\\n${t.name.toUpperCase().slice(0, 24)}` : '';
      empty = !t;
      if (t) { active = st.tickerId === t.id; onAir = active && !!ctxt && this.breakOnAir({ inputs: ctxt.inputs, overlays: ov }); }
    } else if (kind === 'person') {
      const p = this.people()[Number(arg) - 1];
      text = p ? [p.name, p.surname].map((x) => x.trim().toUpperCase().slice(0, 20)).filter(Boolean).join('\\n') : '';
      empty = !p;
    } else if (kind === 'photo') text = `PHOTO\\n${st.photo.toUpperCase()}`;
    else if (kind === 'comparemark') text = `COMPARE:\\n${st.compareMark === 'emblem' ? 'EMBLEM' : 'FLAG'}`;
    else if (kind === 'nextticker') { const t = st.tickerId ? this.tickers().find((x) => x.id === st.tickerId) : undefined; text = `NEXT TICKER\\n${(t?.name ?? 'AUTO').toUpperCase().slice(0, 14)}`; }
    else if (kind === 'tickermode') text = st.tickerMode === 'end' ? 'TICKER:\\nEND OF DAY' : 'TICKER:\\nNEXT RACE';
    else if (kind === 'rotate') { text = this.config.breakAuto ? 'AUTO SWITCH\\nON' : 'AUTO SWITCH\\nOFF'; active = this.config.breakAuto; }
    else if (kind === 'panic' && Date.now() - st.armedPanic < 3000) { text = 'PANIC?\\nPRESS AGAIN'; onAir = true; }
    if (kind === 'show') onAir = isOn(arg);
    if (kind === 'results' && ctxt) { const grp = this.allCompareGroups().find((x) => x.key === compareKey(arg)); const i = grp && this.ownResults(grp.fleetId, ctxt.inputs); onAir = !!i && ov[1] === i.number; }
    if (kind === 'compare' && ctxt) { const i = ctxt.inputs.find((x) => x.title.toLowerCase().replace(/\.gtzip$/, '') === compareInput(compareKey(arg)).toLowerCase()); onAir = !!i && ov[1] === i.number; }
    if (kind === 'break') onAir = !!ctxt && this.breakOnAir({ inputs: ctxt.inputs, overlays: ov });
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

  /**
   * The keys of the version pages (bugs, tickers, people) get their names in Companion as soon as a version is added
   * or renamed (POST /api/location/<page>/<row>/<col>/style). Only texts and fixed colours: no on-air feedback.
   */
  async pushLabels(force = false) {
    const cfg = this.config;
    const lt = getLtConfig(this.ctx.db);
    if (!cfg.labels || !lt.companionUrl) return { sent: 0 };
    if (force) this.labels.clear();
    let n = 0;
    try {
      for (const p of this.pages()) {
        for (const [r, row] of p.keys.entries()) {
          for (const [c, key] of row.entries()) {
            if (!key || !/^(bug|ticker|person):/.test(key.action)) continue;
            const l = await this.keyLook(key, undefined, true);
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
    await this.snapshot().catch(() => null);
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
      const { inputs, overlays } = await this.snapshot();
      const fleetId = this.config.fleetId;
      const jobs: { input: VmixInput; f: () => Map<string, string> | null }[] = [];
      // the Welcome bar follows the Welcome tab (and today's date) without a key
      const wel = this.resolve(this.graphic('welcome'), inputs);
      if (wel) jobs.push({ input: wel, f: () => showDataFields(this.ctx, 'welcome', { eventId: ev.id, today, auto: tickerAuto(this.ctx.db, ev), tickerText: this.tickerText() }) });
      const sched = this.resolve(this.graphic('schedule'), inputs);
      if (sched) jobs.push({ input: sched, f: () => showDataFields(this.ctx, 'schedule', { eventId: ev.id, today, auto: tickerAuto(this.ctx.db, ev), tickerText: this.tickerText() }) });
      // General graphics whose data is only on their tab: Weather, Race officials, Follow us
      for (const id of ['weather', 'officials', 'socials']) {
        const g = this.graphics().find((x) => x.id === id);
        const input = g && this.resolve(g, inputs);
        if (input) jobs.push({ input, f: () => showDataFields(this.ctx, id, { eventId: ev.id, today, auto: tickerAuto(this.ctx.db, ev), tickerText: this.tickerText() }) });
      }
      // the results title shows the group of the break scene's board while the scene is on air (one input, the
      // groups in turn), else the group picked at the top; not touched while the board is switching
      const slide = this.slides()[this.state.slide];
      const resFleet = this.breakOnAir({ inputs, overlays }) && slide?.kind === 'results' && slide.fleetId ? slide.fleetId : fleetId;
      const res = resFleet && !this.switching ? this.resolve(this.graphic('results'), inputs) : undefined;
      if (res && !this.resultsTargets(inputs).some((t) => t.fleetId && t.input.number === res.number)) jobs.push({ input: res, f: () => resultFieldsFor(this.ctx, resFleet, res).fields });
      // each group's own results input (ssl_results_H…) keeps its group's data
      if (!this.switching) for (const t of this.resultsTargets(inputs)) if (t.fleetId) { const fid = t.fleetId; jobs.push({ input: t.input, f: () => resultFieldsFor(this.ctx, fid, t.input).fields }); }
      // Team comparison: every group's own input, and the shared one for the group picked at the top
      for (const t of this.compareTargets(inputs)) jobs.push({ input: t.input, f: () => this.compareData(t.fleetId) });
      for (const { input, f: make } of jobs) {
        const f = make();
        if (!f) continue;
        // only what differs from the title goes; a picture also when its file changed (set())
        sent += await this.set(input, f);
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
  /**
   * REFRESH PNG key: every picture of every vMix input that comes from the dashboard's files goes in again (same path),
   * so vMix reads the file again: a PNG remade in the PNG generator shows everywhere. Only on this key.
   */
  async refreshPictures() {
    this.invalidate();
    const { inputs } = await this.snapshot();
    const root = getSetting(this.ctx.db, 'paths.vmixAssetsRoot') ?? '';
    const assets = path.resolve(this.ctx.assetsDir).toLowerCase();
    let n = 0;
    for (const input of inputs) {
      const mine = (v: string) => { const l = localCandidate(v, root, this.ctx.assetsDir); return !!l && path.resolve(l).toLowerCase().startsWith(assets); };
      const todo = Object.entries(input.values ?? {}).filter(([f, v]) => f.endsWith('.Source') && v && mine(v));
      const id = encodeURIComponent(input.key || input.number);
      for (let i = 0; i < todo.length; i += SET_BATCH) {
        await Promise.all(todo.slice(i, i + SET_BATCH).map(([f, v]) => this.vmix(`?Function=SetImage&Input=${id}&SelectedName=${encodeURIComponent(f)}&Value=${encodeURIComponent(v)}`)));
      }
      n += todo.length;
    }
    return { refreshed: n };
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
    const want = this.graphics().flatMap((g) => {
      if (g.id === 'compare') return this.compareGroups().map((x) => compareInput(x.key)); // a Team comparison per group
      if (this.resolve(g, inputs)) return [];
      const name = g.inputs.map((x) => x.replace('{n}', String(this.boats().length || 4)).replace('{crew}', '9')).find((x) => !x.includes('{'));
      return name ? [name] : [];
    });
    for (const name of want) {
      if (inputs.some((i) => i.title.toLowerCase().replace(/\.gtzip$/, '') === name.toLowerCase())) continue;
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

/** Companion 5.1's export format (12): what Companion 5.1 exports itself, imported as it is. */
const FILE_VERSION = 12;
const BUILD = '5.1.2';
type Controls = Record<number, Record<number, unknown>>;

/** The keys of a deck page as Companion buttons; on the PEOPLE page the producer's own keys stay as they are. */
function pageControls(cfg: ShowConfig, p: Pick<DeckPage, 'page' | 'name'>, keys: ({ key: DeckKey; text: string; bg: string; fg: string } | null)[][], b: string, taken = new Set<string>()): Controls {
  const controls: Controls = {};
  keys.forEach((row, r) => row.forEach((x, c) => {
    if (!x) return;
    const id = `p${p.page}r${r}c${c}`;
    const act = x.key.action.startsWith('nav:') ? setPage(id, Number(x.key.action.split(':')[1])) : http(id, `${b}/api/show/do?a=${encodeURIComponent(x.key.action)}`);
    (controls[r] ??= {})[c] = control(x.text, hex(x.bg), [act], hex(x.fg));
  }));
  // the producer's PEOPLE page: each of its keys as it is (its dashboard calls to this dashboard's address)
  if (p.name === 'PEOPLE') for (const [r, row] of Object.entries(keptControls(b))) for (const [c, ctl] of Object.entries(row)) (controls[Number(r)] ??= {})[Number(c)] = ctl;
  else addDsk(controls, p.page, (r, c) => !!keys[r]?.[c] || taken.has(`${r}/${c}`));
  return controls;
}
/**
 * The ATEM key of the PEOPLE page (DOWNSTREAM KEY: run auto transmission) on every page: in its place there (row 3,
 * last key) or, where a key is there, in the first free place of the bottom rows (UNDO's old place first).
 */
function addDsk(controls: Controls, page: number, used: (r: number, c: number) => boolean) {
  const dsk = KEPT_PEOPLE_PAGE.controls[DSK_AT[0]]?.[DSK_AT[1]];
  if (!dsk) return;
  const free = (r: number, c: number) => !used(r, c) && !controls[r]?.[c];
  const order: [number, number][] = [DSK_AT, [3, 5], [3, 4], ...[2, 1, 0].flatMap((r) => [7, 6, 5, 4, 3, 2, 1, 0].map((c) => [r, c] as [number, number]))];
  const at = order.find(([r, c]) => free(r, c));
  if (!at) return;
  const ctl = JSON.parse(JSON.stringify(dsk).replace(/"id":"([A-Za-z0-9_-]{21})"/g, `"id":"$1p${page}"`));
  (controls[at[0]] ??= {})[at[1]] = ctl;
}
/** Where the downstream key is on the producer's PEOPLE page (row 2, last column). */
const DSK_AT: [number, number] = [2, 7];
/** The kept page's keys without UNDO (no UNDO key on any page). */
function keptControls(b: string): Controls {
  const json = JSON.stringify(KEPT_PEOPLE_PAGE.controls).split(`"${KEPT_HTTP}"`).join(`"${CONN}"`).replace(/https?:\/\/[^"/]+\/api\/show\/do/g, `${b}/api/show/do`);
  const out: Controls = JSON.parse(json);
  for (const row of Object.values(out)) for (const [c, ctl] of Object.entries(row)) if (/api\/show\/do\?a=undo"/.test(JSON.stringify(ctl))) delete row[Number(c)];
  return out;
}
/** The places of the producer's PEOPLE page that have a key ("row/col"). */
export const KEPT_PEOPLE_PLACES = new Set(Object.entries(KEPT_PEOPLE_PAGE.controls).flatMap(([r, row]) => Object.keys(row).map((c) => `${r}/${c}`)));
/** The dashboard action of a key of the producer's PEOPLE page, if it calls this dashboard. */
export function keptPeopleAction(r: number, c: number): string | null {
  const url: string = KEPT_PEOPLE_PAGE.controls[r]?.[c]?.steps?.[0]?.action_sets?.down?.find((a: any) => a.definitionId === 'get')?.options?.url?.value ?? '';
  const m = url.match(/\/api\/show\/do\?a=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** The producer's own connection to the dashboard on that page: the preset's one instead. */
const KEPT_HTTP = Object.entries(KEPT_PEOPLE_PAGE.connections).find(([, x]) => x.moduleId === 'generic-http')?.[0] ?? '';
const connections = () => ({ ...Object.fromEntries(Object.entries(KEPT_PEOPLE_PAGE.connections).filter(([id]) => id !== KEPT_HTTP)), [CONN]: CONN_DEF });

/** Companion's full export: all pages, the dashboard's HTTP connection (and the producer's vMix / ATEM ones, matched by name). */
export function companionPresetFile(cfg: ShowConfig, pages: (Omit<DeckPage, 'keys'> & { keys: ({ key: DeckKey; look: KeyLook } | null)[][] })[], base: string, vmixBase: string, graphics: Graphic[]) {
  const b = base.replace(/\/+$/, '');
  const out: Record<number, { name: string; controls: Controls; gridSize: unknown }> = {};
  for (const p of pages) {
    const keys = p.keys.map((row) => row.map((x) => (!x || (x.look.empty && x.key.kind !== 'nav') ? null : { key: x.key, text: x.look.text, bg: x.look.bg, fg: x.look.fg })));
    // a key with no text now (a free version place) keeps its place: its name comes when the version is added
    const taken = new Set(p.keys.flatMap((row, r) => row.flatMap((x, c) => (x ? [`${r}/${c}`] : []))));
    out[p.page] = { name: `SSL ${p.name}`, controls: pageControls(cfg, p, keys, b, taken), gridSize: GRID };
  }
  const fb = fallbackControls(cfg, vmixBase, graphics);
  addDsk(fb, PRESET_PAGES.fallback, () => false);
  out[PRESET_PAGES.fallback] = { name: 'SSL FALLBACK', controls: fb, gridSize: GRID };
  return {
    version: FILE_VERSION, type: 'full', companionBuild: BUILD,
    pages: out,
    triggers: {},
    custom_variables: {},
    instances: connections(),
    connectionCollections: [],
  };
}
const GRID = { minColumn: 0, maxColumn: 7, minRow: 0, maxRow: 3 };
const COLOURS = (kind: string) => ({ board: 0x1e3a8a, lt: 0x166534, bug: 0xa16207, scene: 0x0f766e, team: 0x1e3a5f, sailor: 0x27303f, nav: 0x3f3f46, safety: 0x7c2d12, mode: 0x4c1d95 } as Record<string, number>)[kind] ?? 0x3f3f46;

const hex = (c: string) => parseInt(c.replace('#', ''), 16) || 0;
const v = <T>(value: T) => ({ value, isExpression: false });
/** A button as Companion 5.1 has it: a background box and a text layer. */
const control = (text: string, bg: number, down: unknown[], fg = 0xffffff) => ({
  type: 'button-layered',
  style: { layers: [
    { id: 'canvas', name: 'Canvas', usage: 'auto', type: 'canvas', decoration: v('default'), showStatusIcons: v('default') },
    { id: 'box0', name: 'Background', usage: 'auto', type: 'box', pinnedProperties: ['color'], enabled: v(true), opacity: v(100), x: v(0), y: v(0), width: v(100), height: v(100), rotation: v(0), color: v(bg), cornerRadius: v(0), borderWidth: v(0), borderColor: v(0), borderPosition: v('inside') },
    { id: 'text0', name: 'Text', usage: 'auto', type: 'text', pinnedProperties: ['text', 'fontsize', 'fontsizeAllowShrink', 'color', 'halign', 'valign'], enabled: v(true), opacity: v(100), x: v(0), y: v(0), width: v(100), height: v(100), rotation: v(0), text: v(text), color: v(fg), halign: v('center'), valign: v('center'), fontsize: v(100), fontsizeAllowShrink: v(true), font: v('companion-sans'), weight: v('normal'), styles: v([]), outlineColor: v(4278190080) },
  ] },
  options: { stepProgression: 'auto', stepExpression: '', rotaryActions: false, canModifyStyleInApis: true, notes: '' },
  feedbacks: [],
  steps: { 0: { action_sets: { down, up: [] }, options: { runWhileHeld: [] } } },
  localVariables: [],
});
const CONN = 'ssl_dashboard_show';
const http = (id: string, url: string) => ({ type: 'action', id, definitionId: 'get', connectionId: CONN, options: { url: v(url), header: v('') }, upgradeIndex: 3 });
const setPage = (id: string, page: number) => ({ type: 'action', id, definitionId: 'set_page', connectionId: 'internal', options: { page: v(page), surfaceId: v('self') }, children: {} });

const CONN_DEF = { moduleInstanceType: 'connection', moduleId: 'generic-http', moduleVersionId: '3.2.0', sortOrder: 0, label: 'ssl_dashboard_show', isFirstInit: false, config: { prefix: '', proxyAddress: '', rejectUnauthorized: true, insecureHTTPParser: false, authType: 'none' }, secrets: {}, lastUpgradeIndex: 3, enabled: true };
function pageFile(name: string, page: number, controls: Controls) {
  return {
    version: FILE_VERSION, type: 'page', companionBuild: BUILD,
    page: { name, controls, gridSize: GRID },
    instances: connections(),
    connectionCollections: [],
    oldPageNumber: page,
  };
}

/** One Companion page export per deck page, plus the fallback page. */
export function companionFiles(cfg: ShowConfig, base: string, vmixBase: string, graphics: Graphic[]) {
  const b = base.replace(/\/+$/, '');
  const files: { name: string; page: number; file: ReturnType<typeof pageFile> }[] = [];
  for (const p of deckPages(cfg)) {
    const keys = p.keys.map((row) => row.map((key) => (key ? { key, text: key.custom ? key.custom.replace(/\{auto\}/g, key.text) : key.text, bg: keyBg(cfg, key), fg: key.fg || '#ffffff' } : null)));
    files.push({ name: `deck${p.deck}-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, page: p.page, file: pageFile(`SSL ${p.name}`, p.page, pageControls(cfg, p, keys, b)) });
  }
  const fb = fallbackControls(cfg, vmixBase, graphics);
  addDsk(fb, PRESET_PAGES.fallback, () => false);
  files.push({ name: 'fallback', page: PRESET_PAGES.fallback, file: pageFile('SSL FALLBACK', cfg.fallbackPage, fb) });
  return files;
}

/** The fallback page: straight to vMix, no dashboard needed; the data stays as it was last set. */
function fallbackControls(cfg: ShowConfig, vmixBase: string, graphics: Graphic[]) {
  const v = vmixBase.replace(/\/+$/, '');
  const fb: Controls = {};
  const first = (g: Graphic) => g.inputs.map((x) => x.replace('{n}', '4').replace('{crew}', '9')).find((x) => !x.includes('{'))!;
  const pick = ['welcome', 'schedule', 'matchboard', 'results', 'compare', 'course', 'officials', 'weather', 'comm', 'bug', 'ticker', 'socials', 'sponsors', 'lbar'];
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
