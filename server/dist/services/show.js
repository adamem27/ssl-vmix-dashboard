import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { activeEvent, getSetting, setSetting } from '../db/db.js';
import { badRequest, notFound } from './errors.js';
import { getSetDetail, listSets } from './fleets.js';
import { listPeople, personName } from './general.js';
import { imagePath, isOften, listGraphicSets, tickerText } from './graphicSets.js';
import { tickerAuto } from './groups.js';
import { loadLineup, slotDefs } from './lineups.js';
import { crewOf, getLtConfig, getLtState, ltFields, ltTeams } from './lowerthirds.js';
import { ltRoles, teamPictureFor } from './ltTitle.js';
import { teamKeyColours, teamKeyLook } from './nationColours.js';
import { listTeams } from './teams.js';
import { encodePng } from './png.js';
import { joinVmixPath } from './paths.js';
import { compareFields, showDataFields } from './showData.js';
import { todayIn } from './dates.js';
import { groupLabel, groupLetter } from './groupNames.js';
import { currentStage } from './workbookSheets.js';
import { parseVmixXml, pushResults, resultFieldsFor, titleFieldMatcher, vmixUrl } from './vmixResults.js';
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
export const LINEUP_LT_ORDER = ['Bow', 'Midbow', 'Pit', 'Grinder', 'Trimmer', 'Trimmer1', 'Main', 'Helm', 'Tactician'];
export const QUALIFIED_TEXT = 'Qualified for the SSL Gold Cup finals';
/** Default registry. `inputs` are tried in order; `{n}` is the number of teams of the race (3/4), `{crew}` the crew size. */
export const DEFAULT_GRAPHICS = [
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
    { id: 'break', label: 'Break scene (L-bar + ticker + boards)', kind: 'scene', overlay: 4, inputs: ['ssl_break'] },
    { id: 'lbar', label: 'L-bar', kind: 'scene', overlay: 1, inputs: ['ssl_lbar'] },
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
    /** places on the lineup lower third, in this order: the first 5, then the rest on the second press */
    /** Stream Deck key edits by place ("<page name>/<row>/<col>"): another action ('' = empty key), own text ({auto} = the live text), key and text colour */
    keys: z.record(z.string(), z.object({ action: z.string().optional(), text: z.string().optional(), bg: z.string().optional(), fg: z.string().optional() })).default({}),
    /** key colour per kind of key (board, lt, bug, …), overriding the built-in palette */
    kindColours: z.record(z.string(), z.string()).default({}),
    lineup5: z.array(z.string()).default(['Tactician', 'Helm', 'Main', 'Trimmer1', 'Trimmer', 'Grinder', 'Pit', 'Midbow', 'Bow']),
});
const CFG = 'show.config';
const STATE = 'show.state';
export function getShowConfig(db) {
    let raw = {};
    try {
        raw = JSON.parse(getSetting(db, CFG) || '{}');
    }
    catch { /* defaults */ }
    return showConfigSchema.parse(raw);
}
export function setShowConfig(db, patch) {
    const next = showConfigSchema.parse({ ...getShowConfig(db), ...patch });
    setSetting(db, CFG, JSON.stringify(next));
    return next;
}
const EMPTY_STATE = { tickerMode: 'next', boat: 1, photo: 'auto', rotating: false, slide: 0, armedPanic: 0, undo: [], last: null, bug: '', bugId: '', tickerId: '', lineupPart: 0, lineupTeam: '', compareMark: 'flag' };
export function getShowState(db) {
    try {
        return { ...EMPTY_STATE, ...JSON.parse(getSetting(db, STATE) || '{}') };
    }
    catch {
        return { ...EMPTY_STATE };
    }
}
const saveShowState = (db, s) => setSetting(db, STATE, JSON.stringify(s));
const img = (a) => (a ? a.vmixPath ?? a.storedPath ?? a.enteredPath ?? '' : '');
export const overlayOf = (xml, n) => xml.match(new RegExp(`<overlay number="${n}"[^>]*>(\\d+)</overlay>`))?.[1] ?? '';
const k = (action, text, kind) => ({ action, text, kind });
const row8 = (...keys) => Array.from({ length: 8 }, (_, i) => keys[i] ?? null);
/**
 * Page numbers of the Companion preset (one file with every page): deck 1 starts on page 1, deck 2 on page 3, the
 * fallback page is 8 and every team has a page of its own from 9 on, its places with the sailors' names on the keys.
 */
export const PRESET_PAGES = { deck1: 1, deck2: 3, fallback: 8, teams: 9 };
export const compareKey = (name) => groupLetter(name).replace(/[^A-Za-z0-9]+/g, '').toUpperCase();
export const compareInput = (key) => `ssl_compare_${key}`;
export function deckPages(cfg, teams = [], groups = []) {
    return applyKeyEdits(cfg, defaultDeckPages(cfg, teams, groups));
}
function defaultDeckPages(cfg0, teams = [], groups = []) {
    const comparePage = PRESET_PAGES.teams + teams.length;
    const cfg = { ...cfg0, deck1Page: PRESET_PAGES.deck1, deck2Page: PRESET_PAGES.deck2, fallbackPage: PRESET_PAGES.fallback };
    const p1 = cfg.deck1Page, p2 = cfg.deck2Page;
    // TEAMS: 8 teams a page (the team's page key, its team lower third under it); more teams go on TEAMS 2… after COMPARE
    const teamsPages = Math.max(1, Math.ceil(teams.length / TEAMS_PER_PAGE));
    const teamsPage = (n) => (n === 0 ? p2 : comparePage + n);
    const peoplePage = comparePage + teamsPages;
    const nav = (home, prev, prevName, next, nextName) => navRow(k(`nav:${home}`, 'HOME', 'nav'), k(`nav:${prev}`, `◀\\n${prevName}`, 'nav'), k(`nav:${next}`, `▶\\n${nextName}`, 'nav'), k(`nav:${cfg.fallbackPage}`, 'FALL-\\nBACK', 'nav'));
    const teamsName = (n) => (n ? `TEAMS ${n + 1}` : 'TEAMS');
    const teamsPageOf = (n) => ({
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
                row8(k('show:welcome', 'WELCOME', 'board'), k('show:matchboard', 'MATCH-\\nBOARD', 'board'), k('show:schedule', 'DAY\\nSCHEDULE', 'board'), k('show:course', 'RACE\\nCOURSE', 'board'), k('show:officials', 'OFFICIALS', 'board'), k('show:weather', 'WEATHER', 'board'), k('show:socials', 'SOCIALS', 'bug'), k(`nav:${comparePage}`, 'TEAM\\nCOMPARE', 'nav')),
                row8(k('comm:host', 'HOST\\nLT', 'lt'), k('comm:guest', 'GUEST\\nLT', 'lt'), k('comm:water', 'ON-WATER\\nLT', 'lt'), k('comm:studio', 'STUDIO\\n+WATER LT', 'lt')),
                row8(),
                nav(p1, p1 + 1, 'AFTER', p1 + 1, 'AFTER'),
            ],
        },
        {
            deck: 1, name: 'C-E AFTER / BREAK', page: p1 + 1, keys: [
                row8(k('show:results', 'GROUP\\nRESULTS', 'board'), k('show:socials', 'SOCIALS', 'bug')),
                row8(k('show:break', 'BREAK\\nSCENE', 'scene'), k('breakout', 'BREAK\\nOUT', 'scene'), k('rotate', 'ROTATION\\n⏯', 'scene'), k('nextslide', 'NEXT\\nSLIDE', 'scene')),
                row8(k('show:lbar', 'L-BAR', 'scene'), k('show:sponsors', 'SPONSORS\\nBAR', 'bug')),
                nav(p1, p1, 'BEFORE', p1, 'BEFORE'),
            ],
        },
        teamsPageOf(0),
        // every announcement and every ticker on a key of its own, by position: a version added in General graphics is
        // on the next free key at once (Companion keys too, they call the position)
        slotPage(p2 + 1, 'BUGS OFTEN', (n) => `bug:o${n}`, 3, nav(p2, teamsPage(lastTeams), teamsName(lastTeams), p2 + 2, 'BUGS RARE')),
        slotPage(p2 + 2, 'BUGS RARE', (n) => `bug:r${n}`, 3, nav(p2, p2 + 1, 'BUGS OFTEN', p2 + 3, 'TICKERS')),
        // the ticker input: its versions, the automatic one (next race / end of day) and that mode
        slotPage(p2 + 3, 'TICKERS', (n) => `ticker:${n}`, 2, nav(p2, p2 + 2, 'BUGS RARE', peoplePage, 'PEOPLE'), row8(k('show:ticker', 'TICKER\\nAUTO', 'bug'), k('tickermode', 'TICKER:\\nNEXT RACE', 'mode'))),
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
const navRow = (...keys) => row8(...keys.slice(0, 4), keys[4] ?? null, k('undo', 'UNDO', 'safety'), k('allout', 'ALL\\nOUT', 'safety'), k('panic', 'PANIC\\n(press 2×)', 'safety'));
/** The nav row with PHOTO AUTO / ON / OFF in its free place (team pages, PEOPLE). */
const withPhoto = (row) => row.map((x, i) => (i === 4 ? k('photo', 'PHOTO\\nMODE', 'mode') : x));
/** A team's page on deck 2: its qualified and line-up graphics, its places (sailor's name on the key), ◀ ▶ to the next team. */
function teamPage(t, i, teams, teamsPage) {
    const page = PRESET_PAGES.teams + i;
    const other = (d) => teams[(i + d + teams.length) % teams.length];
    const tk = (action, text, kind) => ({ ...k(action, text, kind), team: t.code });
    const places = t.crew.slice(0, 16).map((c) => tk(`sailorof:${t.code}/${c.slot}`, `${c.label.toUpperCase()}\\n${c.name ? `${c.number ? `#${c.number} ` : ''}${c.name.toUpperCase()}`.slice(0, 14) : '—'}`, 'sailor'));
    return {
        deck: 2, name: t.code, page, keys: [
            row8(tk(`qualified:${t.code}`, `QUALIFIED\\n${t.code}`, 'lt'), tk(`lineup:${t.code}`, `LINEUP\\n${t.code}`, 'board'), tk(`lult:${t.code}`, `LINEUP LT\\n${t.code}`, 'lt'), k('lultswap', 'LINEUP LT\\n5 ⇄ 4', 'lt'), null, null, null, k('next', 'NEXT\\nRESULT', 'lt')),
            row8(...places.slice(0, 8)),
            row8(...places.slice(8, 16)),
            withPhoto(navRow(k(`nav:${teamsPage}`, 'TEAMS', 'nav'), k(`nav:${PRESET_PAGES.teams + teams.indexOf(other(-1))}`, `◀\\n${other(-1).code}`, 'nav'), k(`nav:${PRESET_PAGES.teams + teams.indexOf(other(1))}`, `▶\\n${other(1).code}`, 'nav'), k(`nav:${PRESET_PAGES.deck2 + 1}`, 'BUGS\\nOFTEN', 'nav'))),
        ],
    };
}
/** Keys of a page of versions (announcements, tickers, people): `rows` rows of 8, action of the nth; `extra` fills the rest. */
function slotPage(page, name, action, rows, navRow, ...extra) {
    const slots = Array.from({ length: rows }, (_, r) => row8(...Array.from({ length: 8 }, (_, c) => k(action(r * 8 + c + 1), '—', 'bug'))));
    const rest = [...extra, row8(), row8(), row8()].slice(0, 3 - rows);
    return { deck: 2, name, page, keys: [...slots, ...rest, navRow] };
}
export const KEY_COLOURS = { board: '#1e3a8a', lt: '#166534', bug: '#a16207', scene: '#0f766e', team: '#1e3a5f', sailor: '#27303f', nav: '#3f3f46', safety: '#7c2d12', mode: '#4c1d95' };
const SPECIAL_BG = { undo: '#6b21a8', allout: '#c2410c', panic: '#991b1b' };
/** The colour a key has when nothing is on air: its own, else its kind's. */
export const keyBg = (cfg, key) => key.bg || cfg.kindColours[key.kind] || SPECIAL_BG[key.action] || KEY_COLOURS[key.kind] || '#3f3f46';
/** Every action a key can have, with the text and kind a key with that action gets by default. */
export function keyActions(cfg) {
    const out = new Map();
    for (const p of defaultDeckPages(cfg))
        for (const row of p.keys)
            for (const key of row)
                if (key && !out.has(key.action))
                    out.set(key.action, { action: key.action, text: key.text, kind: key.kind });
    for (const g of DEFAULT_GRAPHICS)
        if (!out.has(`show:${g.id}`))
            out.set(`show:${g.id}`, { action: `show:${g.id}`, text: g.label.toUpperCase(), kind: g.kind });
    return [...out.values()];
}
function applyKeyEdits(cfg, pages) {
    if (!Object.keys(cfg.keys).length)
        return pages;
    const actions = new Map(keyActions(cfg).map((a) => [a.action, a]));
    return pages.map((p) => ({
        ...p,
        keys: p.keys.map((row, r) => row.map((key, c) => {
            const o = cfg.keys[`${p.name}/${r}/${c}`];
            if (!o)
                return key;
            let next = key;
            if (o.action !== undefined) {
                if (!o.action)
                    return null;
                const a = actions.get(o.action);
                next = a ? { ...a } : { action: o.action, text: o.action.toUpperCase(), kind: 'mode' };
            }
            if (!next)
                return null;
            return { ...next, ...(o.text ? { custom: o.text } : {}), ...(o.bg ? { bg: o.bg } : {}), ...(o.fg ? { fg: o.fg } : {}) };
        })),
    }));
}
export class Show {
    ctx;
    lt;
    fetcher;
    log;
    timer = null;
    rotation = null;
    labels = new Map();
    /** vMix's inputs as last read (the COMPARE keys follow the Team comparison inputs there). */
    lastInputs = [];
    /**
     * Data the keys read, kept for a second: one view or Companion refresh looks at 200 keys, and each team / sailor /
     * announcement key would read the group, the teams and their pictures again (seconds of a busy server on a big
     * event). A key press or any change made in the dashboard clears it (invalidate).
     */
    memo = new Map();
    cached(key, fn) {
        const m = this.memo.get(key);
        if (m && Date.now() - m.at < 1000)
            return m.v;
        const v = fn();
        this.memo.set(key, { at: Date.now(), v });
        return v;
    }
    invalidate() { this.memo.clear(); }
    constructor(ctx, lt, fetcher = fetch, log = () => { }) {
        this.ctx = ctx;
        this.lt = lt;
        this.fetcher = fetcher;
        this.log = log;
    }
    // the config and state are read by every key of a view (hundreds): parsed again only when the stored text changes
    cfgCache = { raw: '\u0000', v: null };
    stCache = { raw: '\u0000', v: null };
    get config() {
        const raw = getSetting(this.ctx.db, CFG) || '';
        if (raw !== this.cfgCache.raw)
            this.cfgCache = { raw, v: getShowConfig(this.ctx.db) };
        return this.cfgCache.v;
    }
    get state() {
        const raw = getSetting(this.ctx.db, STATE) || '';
        if (raw !== this.stCache.raw)
            this.stCache = { raw, v: getShowState(this.ctx.db) };
        return { ...this.stCache.v };
    }
    /** The event's teams (read once per view) and a team's key colours. */
    teams() { return this.cached('teams', () => listTeams(this.ctx)); }
    nation(code) { return this.cached(`nation:${code}`, () => teamKeyColours(this.ctx.db, code)); }
    patchState(p) { const s = { ...this.state, ...p }; saveShowState(this.ctx.db, s); return s; }
    async vmix(q) {
        const base = vmixUrl(this.ctx.db);
        let res;
        try {
            res = await this.fetcher(`${base}/api/${q}`, { signal: AbortSignal.timeout(4000) });
        }
        catch {
            throw badRequest(`vMix does not answer at ${base}. Turn on Settings → Web Controller in vMix and check the address in Settings here.`);
        }
        if (!res.ok)
            throw badRequest(`vMix answered ${res.status} for ${decodeURIComponent(q).slice(0, 80)}`);
        return res.text();
    }
    // ---------- data the keys need ----------
    graphics() {
        const over = this.config.inputs;
        return DEFAULT_GRAPHICS.map((g) => (over[g.id]?.trim() ? { ...g, inputs: over[g.id].split(',').map((s) => s.trim()).filter(Boolean) } : g));
    }
    graphic(id) { const g = this.graphics().find((x) => x.id === id); if (!g)
        throw notFound(`Graphic ${id}`); return g; }
    /** The teams of the race now, in fleet order (team keys 1–4). */
    boats() {
        return this.cached(`boats:${this.config.fleetId}`, () => this.loadBoats());
    }
    loadBoats() {
        const cfg = this.config;
        if (!cfg.fleetId)
            return [];
        const ev = activeEvent(this.ctx.db).id;
        const teams = new Map(listTeams(this.ctx).map((t) => [t.id, t]));
        for (const s of listSets(this.ctx.db, ev)) {
            const f = getSetDetail(this.ctx.db, s.id).fleets.find((x) => x.id === cfg.fleetId);
            if (f)
                return f.positions.filter((x) => !!x).map((id) => teams.get(id)).filter(Boolean).map((t) => ({ id: t.id, code: t.code, name: t.name }));
        }
        return [];
    }
    /**
     * The teams of the stage picked at the top of the dashboard (group by group, in fleet order), each with its places,
     * for its page; every team only when no stage is picked.
     */
    presetTeams() {
        return this.cached('presetTeams', () => ltTeams(this.ctx).filter((t) => t.code).map((t) => ({
            code: t.code, name: t.name,
            crew: crewOf(this.ctx, t.id).map((c) => ({ slot: c.slot, label: c.label, name: c.lastName || c.firstName, number: c.number })),
        })));
    }
    /** The pages of both decks with a page per team. */
    pages() {
        const teams = this.presetTeams(), groups = this.deckCompareGroups();
        this.keyEditsByName(teams, groups);
        return deckPages(this.config, teams, groups);
    }
    /**
     * Key edits were kept by page position ("12/0/2"): a page added before (BUGS OFTEN/RARE, another stage with more
     * teams) moved them onto other pages. Now they are kept by page name ("PUR/0/2"); the old ones move once, where
     * they show now, except onto the LINEUP LT keys (new in 1.0.140, so an edit there is one that slid onto them).
     */
    keyEditsByName(teams, groups) {
        const cfg = this.config;
        const old = Object.keys(cfg.keys).filter((id) => /^\d+\/\d+\/\d+$/.test(id));
        if (!old.length)
            return;
        const pages = defaultDeckPages(cfg, teams, groups);
        const keys = { ...cfg.keys };
        for (const id of old) {
            const [pi, r, c] = id.split('/').map(Number);
            const o = keys[id];
            delete keys[id];
            const p = pages[pi];
            const key = p?.keys[r]?.[c];
            if (!p || (key && /^lult/.test(key.action)))
                continue;
            const name = `${p.name}/${r}/${c}`;
            if (!keys[name])
                keys[name] = o;
        }
        setShowConfig(this.ctx.db, { keys });
    }
    /** A team by key: its position in the group racing now (1–4) or its code. */
    teamRef(arg) {
        if (/^\d+$/.test(arg))
            return this.boat(Number(arg));
        const t = this.teams().find((x) => x.code.toLowerCase() === arg.toLowerCase());
        if (!t)
            throw notFound(`Team ${arg}`);
        return { id: t.id, code: t.code, name: t.name };
    }
    boat(n) { const b = this.boats()[n - 1]; if (!b)
        throw badRequest(`The group has no team ${n}. Pick the race (group) on the Show control tab.`); return b; }
    /** Sailors of the selected boat with a name, by shirt number. */
    sailors() {
        const b = this.boats()[this.state.boat - 1];
        if (!b)
            return [];
        return this.cached(`sailors:${b.id}`, () => this.loadSailors(b));
    }
    loadSailors(b) {
        const num = (s) => (Number.isFinite(Number(s.number)) && s.number !== '' ? Number(s.number) : 999);
        return crewOf(this.ctx, b.id).filter((s) => s.firstName || s.lastName).sort((a, c) => num(a) - num(c));
    }
    announcements() { return this.cached('announcements', () => listGraphicSets(this.ctx.db, activeEvent(this.ctx.db).id, 'announcement')); }
    /** Fleets that rotate in the break scene. */
    breakFleets() {
        const cfg = this.config;
        if (cfg.breakFleets.length)
            return cfg.breakFleets;
        const ev = activeEvent(this.ctx.db).id;
        for (const s of listSets(this.ctx.db, ev)) {
            const d = getSetDetail(this.ctx.db, s.id);
            if (d.fleets.some((f) => f.id === cfg.fleetId))
                return d.fleets.map((f) => f.id);
        }
        return cfg.fleetId ? [cfg.fleetId] : [];
    }
    // ---------- vMix state ----------
    /** vMix's state; the tab and the Companion refresh share one read for half a second. */
    async snapshot() {
        const m = this.memo.get('snapshot');
        if (m && Date.now() - m.at < 500)
            return m.v;
        const p = this.readSnapshot();
        this.memo.set('snapshot', { at: Date.now(), v: p });
        p.catch(() => this.memo.delete('snapshot'));
        return p;
    }
    async readSnapshot() {
        const xml = await this.vmix('');
        const inputs = parseVmixXml(xml);
        this.lastInputs = inputs;
        const overlays = {};
        for (let n = 1; n <= 4; n++)
            overlays[n] = overlayOf(xml, n);
        return { xml, inputs, overlays };
    }
    /** The first of a graphic's input names that exists in vMix ({n} = teams in the race, {crew} = crew size). */
    resolve(g, inputs, vars = {}) {
        const n = this.boats().length || 4;
        const crew = Number(vars.crew) || 9;
        // a crew without its own title takes the nearest bigger one (empty places stay blank), then smaller ones
        const crews = [...Array.from({ length: 13 - crew }, (_, i) => crew + i), ...Array.from({ length: crew - 1 }, (_, i) => crew - 1 - i)];
        const names = g.inputs.flatMap((raw) => (raw.includes('{crew}') ? crews.map((c) => raw.replace('{crew}', String(c))) : [raw.replace('{n}', String(vars.n ?? n))]));
        const exact = (i, name) => i.title.toLowerCase() === name.toLowerCase() || i.title.toLowerCase().replace(/\.gtzip$/, '') === name.toLowerCase();
        // a GTZIP loaded under its own file name (Announcement_bug 2.gtzip) is found by that name too
        const loose = (v) => v.toLowerCase().replace(/\.gtzip$/, '').replace(/[^a-z0-9]+/g, '').replace(/\d+$/, '');
        const alias = (i) => (g.aliases ?? []).some((a) => loose(i.title) === loose(a));
        // a real title (with fields) before a placeholder image of the same name
        for (const titled of [true, false]) {
            const ok = (i) => !titled || i.fields.length > 0;
            for (const name of names) {
                const hit = inputs.find((i) => ok(i) && exact(i, name));
                if (hit)
                    return hit;
            }
            const hit = inputs.find((i) => ok(i) && alias(i));
            if (hit)
                return hit;
        }
        return undefined;
    }
    need(g, inputs, vars) {
        const i = this.resolve(g, inputs, vars);
        if (!i)
            throw badRequest(`vMix has no input ${g.inputs.join(' / ')} for ${g.label}. Add it (or its placeholder) on the Show control tab.`);
        return i;
    }
    /** Fields into the title, by its own field names (any case, GT's names cut at 15 characters too); one call each. */
    async set(input, fields) {
        const match = titleFieldMatcher(input.fields);
        const done = new Set();
        let n = 0;
        for (const [name, value] of fields) {
            const real = match(name);
            if (!real || done.has(real))
                continue;
            done.add(real);
            await this.vmix(`?Function=${real.endsWith('.Source') ? 'SetImage' : 'SetText'}&Input=${encodeURIComponent(input.key || input.number)}&SelectedName=${encodeURIComponent(real)}&Value=${encodeURIComponent(value)}`);
            n++;
        }
        return n;
    }
    /** set(), but a title that takes none of the fields (a placeholder image, an old GTZIP) is an error naming what it has. */
    async setOrExplain(input, g, fields, blind) {
        if (await this.set(input, fields))
            return;
        const { inputs } = await this.snapshot();
        const same = inputs.filter((i) => i.title.toLowerCase().replace(/\.gtzip$/, '') === input.title.toLowerCase().replace(/\.gtzip$/, ''));
        // a title whose fields vMix did not list: the data goes in by the GTZIP's own field names all the same
        const title = (i) => /^(gt|xaml|title)/i.test(i.type ?? '');
        const gt = same.find(title) ?? (title(input) ? input : undefined);
        if (gt && blind) {
            for (const [name, value] of blind())
                await this.vmix(`?Function=${name.endsWith('.Source') ? 'SetImage' : 'SetText'}&Input=${encodeURIComponent(gt.key || gt.number)}&SelectedName=${encodeURIComponent(name)}&Value=${encodeURIComponent(value)}`);
            return gt;
        }
        const list = same.map((i) => `input ${i.number} (${i.type || 'unknown type'}, ${i.fields.length ? `fields ${i.fields.join(', ')}` : 'no title fields'})`).join('; ');
        const twice = same.length > 1 ? ` vMix has ${same.length} inputs named "${input.title}": delete the placeholder image and keep the GTZIP title.` : '';
        throw badRequest(`vMix input "${input.title}" (${g.label}) takes none of the data: ${list || `input ${input.number}, no title fields`}.${twice} Load the ${g.label} GTZIP title in vMix and name it ${g.inputs[0]}.`);
    }
    /** The first text field of a title whose name matches, else its first text field. */
    textField(input, re) {
        const texts = input.fields.filter((f) => f.endsWith('.Text'));
        return texts.find((f) => re.test(f)) ?? texts[0];
    }
    pushUndo(overlays) {
        const undo = [...this.state.undo, overlays].slice(-20);
        this.patchState({ undo });
    }
    async overlayIn(n, input, overlays) {
        if (overlays[n] === input.number)
            return false;
        await this.vmix(`?Function=OverlayInput${n}In&Input=${encodeURIComponent(input.key || input.number)}`);
        if (overlays[n])
            this.ltLeft(overlays[n]);
        return true;
    }
    async overlayOut(n, overlays) {
        if (!overlays[n])
            return false;
        await this.vmix(`?Function=OverlayInput${n}Out`);
        this.ltLeft(overlays[n]);
        return true;
    }
    /** A lower third title that left the screen some other way than its OUT: its photo is emptied off air, so the next sailor comes in at once. */
    ltLeft(number) {
        const input = this.lastInputs.find((i) => i.number === number);
        if (input && this.isLtTitle(input))
            this.lt.clearPhotoOffAir(input);
    }
    /** Bring a graphic in on its overlay, after its data is in; takes off what it must not sit on. */
    async bringIn(g, input, snap) {
        this.pushUndo(snap.overlays);
        const lt = getLtConfig(this.ctx.db).overlay;
        // what must go first; a graphic on the same channel simply replaces what is there
        const off = new Set(g.kind === 'board' ? [lt] : g.kind === 'scene' ? [1, lt] : []);
        off.delete(g.overlay);
        for (const n of off)
            await this.overlayOut(n, snap.overlays);
        if (g.kind === 'board' && g.overlay !== 4 && snap.overlays[4])
            await this.sceneOut(snap.overlays);
        if (g.kind === 'scene' && g.id !== 'break')
            this.stopRotation();
        await this.overlayIn(g.overlay, input, snap.overlays);
    }
    async sceneOut(overlays) {
        this.stopRotation();
        await this.overlayOut(4, overlays);
    }
    /** The data of a graphic, set right before it comes in. */
    async fill(g, input) {
        const ev = activeEvent(this.ctx.db).id;
        if (g.id === 'results') {
            if (!this.config.fleetId)
                throw badRequest('Pick the race (group) on the Show control tab.');
            await pushResults(this.ctx, this.config.fleetId, input.key || input.number, this.fetcher);
        }
        else if (g.id === 'compare') {
            if (!this.config.fleetId)
                throw badRequest('Pick the race (group) on the Show control tab.');
            await this.set(input, this.compareData());
        }
        else if (g.id === 'ticker') {
            await this.set(input, new Map([[this.textField(input, /ticker|text/i) ?? '', this.tickerText()]]));
        }
        else if (g.id === 'lineup5') {
            const b = this.boats()[this.state.boat - 1];
            if (b) {
                await this.set(input, this.lineupLtFields(b.id, 1));
                this.patchState({ lineupPart: 1, lineupTeam: b.id });
            }
        }
        else if (g.id === 'bug') {
            // BUG key without a version: the announcement shown last, else the first one
            const a = (this.state.bugId && this.announcement(this.state.bugId)) || this.announcements()[0];
            if (a) {
                await this.setOrExplain(input, g, this.bugFields(input, a.data), () => this.bugBlind(a.data));
                this.patchState({ bug: (a.data.text || a.name).toUpperCase(), bugId: a.id });
            }
        }
        else {
            // General graphics straight into the title, so a change made a moment ago is on air without waiting for Excel
            const e = activeEvent(this.ctx.db);
            const f = showDataFields(this.ctx, g.id, { eventId: ev, today: todayIn(e.timezone), auto: tickerAuto(this.ctx.db, e), tickerText: this.tickerText() });
            if (f)
                await this.set(input, f);
        }
    }
    /** Team comparison of a group (default: the one picked at the top), with the flag or the emblem by each team (COMPARE key). */
    compareData(fleetId = this.config.fleetId) {
        const ev = activeEvent(this.ctx.db);
        return compareFields(this.ctx, ev.id, fleetId, todayIn(ev.timezone), { mark: this.state.compareMark, emblemSlot: getLtConfig(this.ctx.db).emblemSlot });
    }
    /** The groups of the stage picked at the top (every stage when none is), each with its key: A, B… or FINAL. */
    compareGroups() {
        return this.cached('compareGroups', () => {
            const ev = activeEvent(this.ctx.db).id;
            const stage = currentStage(this.ctx.db, ev);
            return this.groupsOf(stage ? [stage.id] : listSets(this.ctx.db, ev).map((x) => x.id));
        });
    }
    /** Groups of these stages, a key each (the first stage wins a key two stages share). */
    groupsOf(sets) {
        const seen = new Set();
        return sets.flatMap((id) => getSetDetail(this.ctx.db, id).fleets).map((f) => ({ fleetId: f.id, key: compareKey(f.name), label: groupLabel(f.name) }))
            .filter((g) => g.key && !seen.has(g.key) && !!seen.add(g.key));
    }
    /** Every group of the event, the stage picked at the top first. */
    allCompareGroups() {
        return this.cached('allCompareGroups', () => {
            const ev = activeEvent(this.ctx.db).id;
            const stage = currentStage(this.ctx.db, ev);
            const all = listSets(this.ctx.db, ev).map((x) => x.id);
            return this.groupsOf(stage ? [stage.id, ...all.filter((x) => x !== stage.id)] : all);
        });
    }
    /** The COMPARE keys: one per Team comparison input vMix has (ssl_compare_A…), else one per group of the stage. */
    deckCompareGroups() {
        const has = (g) => this.lastInputs.some((i) => i.title.toLowerCase().replace(/\.gtzip$/, '') === compareInput(g.key).toLowerCase());
        const inVmix = this.allCompareGroups().filter(has);
        return inVmix.length ? inVmix : this.compareGroups();
    }
    /** Each group's own Team comparison input (ssl_compare_A…); the shared one (ssl_compare) for the group picked at the top. */
    compareTargets(inputs) {
        const out = [];
        for (const g of this.allCompareGroups()) {
            const i = inputs.find((x) => x.title.toLowerCase().replace(/\.gtzip$/, '') === compareInput(g.key).toLowerCase());
            if (i)
                out.push({ input: i, fleetId: g.fleetId });
        }
        const shared = this.resolve(this.graphic('compare'), inputs);
        if (shared && this.config.fleetId && !out.some((x) => x.input.key === shared.key))
            out.push({ input: shared, fleetId: this.config.fleetId });
        return out;
    }
    /** A group's Team comparison (COMPARE A…): its data into its own input, then in on the boards overlay; again = out. */
    async compareGroup(arg) {
        const groups = [...this.compareGroups(), ...this.allCompareGroups()];
        const grp = groups.find((x) => x.key === compareKey(arg) || x.fleetId === arg);
        if (!grp)
            throw notFound(`Group ${arg} in this stage`);
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
        const { inputs } = await this.snapshot();
        for (const t of this.compareTargets(inputs))
            await this.set(t.input, new Map([...this.compareData(t.fleetId)].filter(([k]) => /flag\.source$/i.test(k))));
        return { compareMark: mark };
    }
    /** The lineup lower third: the team's line-up from the bow to the stern (the 9 places on board), five then four. */
    lineupLtParts(teamId) {
        const all = crewOf(this.ctx, teamId).filter((s) => s.lastName || s.firstName);
        const crew = LINEUP_LT_ORDER.map((k) => all.find((s) => s.slot === k)).filter((s) => !!s);
        return [crew.slice(0, 5), crew.slice(5, 9)].filter((p) => p.length);
    }
    /**
     * Lineup_lowerthird_9.gtzip: places 1–5 show five sailors, places 6–9 four (centred); the part on screen is filled,
     * the other emptied. NAME n = surname, POSITION n, PHOTO n; the bar is the team's lt_lineup_bar PNG.
     */
    lineupLtFields(teamId, part) {
        const parts = this.lineupLtParts(teamId);
        const crew = parts[part - 1] ?? [];
        const f = new Map();
        for (let i = 1; i <= 9; i++) {
            const s = part === 1 ? (i <= 5 ? crew[i - 1] : undefined) : (i > 5 ? crew[i - 6] : undefined);
            // I. SLADDER and 5 | MIDBOW
            f.set(`NAME ${i}.Text`, s ? [s.firstName.trim() ? `${s.firstName.trim()[0].toUpperCase()}.` : '', s.lastName.toUpperCase()].filter(Boolean).join(' ') : '');
            f.set(`POSITION ${i}.Text`, s ? [s.number, s.position.toUpperCase()].filter(Boolean).join(' | ') : '');
            f.set(`PHOTO ${i}.Source`, s?.photo ?? '');
        }
        const t = listTeams(this.ctx).find((x) => x.id === teamId);
        const bar = t && teamPictureFor(this.ctx, t, { w: 1280, h: 140, key: 'ltlineupbar', like: /lineupbar/, exact: true });
        if (bar)
            f.set('Bar.Source', bar);
        return f;
    }
    /** LINEUP LT <team>: the team's first five come in (from another team: a data change); the same key again: out. */
    async lineupLt(code) {
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
        if (!this.lineupLtParts(b.id).length)
            throw badRequest(`No sailors in the ${b.code} line-up.`);
        await this.set(input, this.lineupLtFields(b.id, 1));
        if (!on)
            await this.bringIn(g, input, snap);
        this.patchState({ lineupPart: 1, lineupTeam: b.id });
        return { in: 'lineup5', team: b.code, part: 1 };
    }
    /** LINEUP LT 5 ⇄ 4: the lineup lower third on air swaps between its five and its four (a data change). */
    async lineupLtSwap() {
        const g = this.graphic('lineup5');
        const snap = await this.snapshot();
        const input = this.need(g, snap.inputs);
        const teamId = this.state.lineupTeam;
        if (snap.overlays[g.overlay] !== input.number || !teamId)
            throw badRequest('Bring a team’s LINEUP LT in first.');
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
    async qualified(boat) {
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
        if (barField && bar)
            out.set(barField, bar);
        // titles with a field of their own for the line (QualifiedText, Qualified…) get it too
        for (const x of input.fields)
            if (/qualif/i.test(x) && x.endsWith('.Text') && !out.has(x))
                out.set(x, QUALIFIED_TEXT);
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
    async toggle(id) {
        const g = this.graphic(id);
        const snap = await this.snapshot();
        const input = this.need(g, snap.inputs);
        if (snap.overlays[g.overlay] === input.number) {
            this.pushUndo(snap.overlays);
            if (g.id === 'break')
                await this.sceneOut(snap.overlays);
            else
                await this.overlayOut(g.overlay, snap.overlays);
            return { out: g.id };
        }
        await this.fill(g, input);
        if (g.id === 'ticker')
            this.patchState({ tickerId: '' });
        await this.bringIn(g, input, snap);
        if (g.id === 'break')
            this.startRotation();
        return { in: g.id, input: input.title };
    }
    async commentator(role) {
        const roles = { host: ['host commentator'], guest: ['guest commentator', 'guest'], water: ['on-water commentator'], studio: ['host commentator'] };
        const want = roles[role] ?? [role.toLowerCase()];
        const ev = activeEvent(this.ctx.db).id;
        const people = listPeople(this.ctx, ev).filter((p) => want.includes((p.role || '').toLowerCase()) && (p.name || p.surname));
        if (!people.length)
            throw badRequest(`Nobody with the role ${want[0]} in People (General graphics).`);
        return this.personLt(people[0]);
    }
    /** People in General graphics with a name, in their order (PEOPLE page: a key each). */
    people() { return this.cached('people', () => listPeople(this.ctx, activeEvent(this.ctx.db).id).filter((p) => p.name || p.surname)); }
    /** A person's lower third (PEOPLE key by position): their name and title, the photo title when they have a photo. */
    async person(n) {
        const p = this.people()[Number(n) - 1];
        if (!p)
            throw badRequest(`No person ${n} in People (General graphics).`);
        return this.personLt(p);
    }
    async personLt(p) {
        const g = this.graphic('comm');
        const snap = await this.snapshot();
        const photo = p.photo ? img(p.photo) : '';
        const withPhoto = photo ? this.resolve({ ...g, inputs: g.inputs.slice(0, 1) }, snap.inputs) : undefined;
        const input = withPhoto ?? this.resolve({ ...g, inputs: g.inputs.slice(1) }, snap.inputs) ?? this.need(g, snap.inputs);
        const lf = getLtConfig(this.ctx.db).fields;
        const f = this.lt.fitToTitle(input, new Map([[`${lf.top}.Text`, personName(p)], [`${lf.bottom}.Text`, (p.title || p.role).toUpperCase()], [`${lf.photo}.Source`, photo]]), null);
        // on-air swap of the same title animates; a different title comes in on the overlay
        await this.set(input, f);
        await this.bringIn({ ...g }, input, snap);
        return { in: 'comm', input: input.title, person: p.name };
    }
    async lineup(boat) {
        const b = this.teamRef(String(boat));
        const g = this.graphic('lineup');
        const snap = await this.snapshot();
        const lu = loadLineup(this.ctx.db, activeEvent(this.ctx.db).id, b.id).data;
        const input = this.need(g, snap.inputs, { crew: lu.rows.filter((r) => r.firstName || r.lastName).length });
        const team = listTeams(this.ctx).find((t) => t.id === b.id);
        const a = team.assets;
        const crew = new Map(crewOf(this.ctx, b.id).map((s) => [s.slot, s]));
        const f = new Map([['Flag.Source', img(a.flag_big)], ['Emblem.Source', img(a.emblem_light)],
            ['TeamName.Text', (lu.teamName || team.name).toUpperCase()], ['LineupText.Text', lu.title]]);
        // titles that number the trimmers 1 and 2 (Trimmer1NAME = Trimmer 1, Trimmer2NAME = Trimmer 2, TrimmerPHOTO1/2)
        const twoTrimmers = input.fields.some((x) => /^Trimmer2/i.test(x));
        const names = (d) => {
            if (!twoTrimmers || (d.key !== 'Trimmer' && d.key !== 'Trimmer1'))
                return d.fields;
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
        if (square)
            for (const x of input.fields)
                if (/^\w+BG\.Source$/i.test(x) && !/^BG\.Source$/i.test(x))
                    f.set(x, square);
        await this.set(input, f);
        await this.bringIn(g, input, snap);
        return { in: 'lineup', team: b.code, input: input.title };
    }
    tickers() { return this.cached('tickers', () => listGraphicSets(this.ctx.db, activeEvent(this.ctx.db).id, 'ticker')); }
    /** An announcement by key: its position (bug:3), its version id, or THANKS (old keys: the Thanks ticker). */
    announcement(which) {
        const list = this.announcements();
        // by position on BUGS OFTEN (o3) or BUGS RARE (r3)
        const m = which.match(/^([or])(\d+)$/i);
        if (m)
            return list.filter((x) => isOften(x) === (m[1].toLowerCase() === 'o'))[Number(m[2]) - 1];
        return list.find((x) => x.id === which) ?? (/^\d+$/.test(which) ? list[Number(which) - 1] : undefined);
    }
    /** The bug's text and icon, by the title's field names (TEXT; Race flag, ICON, FLAG, STAR… but not icon_background). */
    bugFields(input, data) {
        const f = new Map();
        const text = this.textField(input, /text/i);
        if (text)
            f.set(text, (data.text ?? '').toUpperCase());
        const pics = input.fields.filter((x) => x.endsWith('.Source') && !/background|\bbg\b|_bg|bar/i.test(x));
        const icon = [/race ?flag/i, /^icon\./i, /flag/i, /icon/i, /star/i, /logo/i].map((re) => pics.find((x) => re.test(x))).find(Boolean);
        if (icon)
            f.set(icon, imagePath(this.ctx.db, this.ctx.assetsDir, data.icon));
        return f;
    }
    /** The bug's data by the Announcement bug GTZIP's own field names (TEXT; the flag as Race flag or icon). */
    bugBlind(data) {
        const icon = imagePath(this.ctx.db, this.ctx.assetsDir, data.icon);
        return new Map([['TEXT.Text', (data.text ?? '').toUpperCase()], ['Race flag.Source', icon], ['icon.Source', icon]]);
    }
    /** Announcement bug: its text and icon go into the title, then it comes in; the same key again takes it out. */
    async bug(which) {
        if (which === 'thanks')
            return this.ticker('thanks');
        const a = this.announcement(which);
        if (!a)
            throw badRequest(`No announcement ${which}. Add it under General graphics → Announcements.`);
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
        const text = (a.data.text || a.name).toUpperCase();
        this.patchState({ bug: text, bugId: a.id });
        await this.bringIn(g, used, snap);
        return { in: 'bug', text };
    }
    /** A ticker version by key: position (ticker:2), version id or fixed ticker (thanks, warning, delay, custom). */
    tickerVersion(which) {
        const list = this.tickers();
        return list.find((x) => x.id === which) ?? list.find((x) => x.data.preset === which) ?? (/^\d+$/.test(which) ? list[Number(which) - 1] : undefined);
    }
    /** Ticker of one version (Tickers in General graphics): its text goes in, then it comes in; again = out. */
    async ticker(which) {
        const t = this.tickerVersion(which);
        if (!t)
            throw badRequest(`No ticker ${which}. Add it under General graphics → Tickers.`);
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
        if (!on)
            await this.bringIn(g, input, snap);
        return { in: 'ticker', text };
    }
    /** Lower thirds of a sailor on the selected boat, by key index (1–16, sorted by shirt number) or by shirt number. */
    async sailor(index, shirt) {
        const list = this.sailors();
        const s = shirt ? list.find((x) => x.number === shirt) : list[(index ?? 0) - 1];
        if (!s)
            throw badRequest(shirt ? `No sailor with number ${shirt} in ${this.boats()[this.state.boat - 1]?.code ?? 'this team'}.` : 'No sailor on this key.');
        const b = this.boat(this.state.boat);
        const mode = this.state.photo;
        const snap = await this.snapshot();
        await this.clearForSailor(snap);
        // photo mode: the lower thirds pick the photo title when the sailor has a photo; OFF forces the other one
        if (mode === 'off' && s.photo)
            return this.lt.showSailor(b.code, s.slot, { forceNoPhoto: true });
        return this.lt.showSailor(b.code, s.slot);
    }
    /** A place of a team's line-up (its page's keys): the sailor on it now, with the photo mode of the tab. */
    async sailorOf(code, slot) {
        const t = this.teamRef(code);
        const snap = await this.snapshot();
        await this.clearForSailor(snap);
        return this.lt.showSailor(t.code, slot, { forceNoPhoto: this.state.photo === 'off' });
    }
    /** Is this vMix input one of the lower third titles (photo / no photo)? */
    isLtTitle(input) {
        const cfg = getLtConfig(this.ctx.db);
        const name = (input?.title ?? '').toLowerCase().replace(/\.gtzip$/, '');
        return !!name && [cfg.photoInput, cfg.noPhotoInput].some((x) => x && x.toLowerCase() === name);
    }
    /**
     * Before a sailor's lower third: a board on OV1 goes out; a lower third stays on, so the next sailor is only a data
     * change (taking it out first left its photo in the title, and the next one waited ~3 s for that photo to fly away).
     */
    async clearForSailor(snap) {
        const on = snap.overlays[1];
        if (!on)
            return;
        this.pushUndo(snap.overlays);
        const input = snap.inputs.find((i) => i.number === on);
        if (getLtConfig(this.ctx.db).overlay === 1 && this.isLtTitle(input))
            return;
        await this.overlayOut(1, snap.overlays);
    }
    async undo() {
        const st = this.state;
        const prev = st.undo.at(-1);
        if (!prev)
            throw badRequest('Nothing to undo.');
        const snap = await this.snapshot();
        for (let n = 1; n <= 4; n++) {
            const want = prev[n] ?? '';
            if (want === (snap.overlays[n] ?? ''))
                continue;
            if (!want)
                await this.vmix(`?Function=OverlayInput${n}Out`);
            else
                await this.vmix(`?Function=OverlayInput${n}In&Input=${want}`);
        }
        this.patchState({ undo: st.undo.slice(0, -1) });
        return { restored: prev };
    }
    /** OUT: whatever is on OV1 goes out with its animation (a lower third through its own out, so its photo flies down first). */
    async layerOut() {
        const s = await this.snapshot();
        const on = s.overlays[1];
        if (!on)
            return { out: '' };
        this.pushUndo(s.overlays);
        const cfg = getLtConfig(this.ctx.db);
        const input = s.inputs.find((i) => i.number === on);
        const name = (input?.title ?? '').toLowerCase().replace(/\.gtzip$/, '');
        if (cfg.overlay === 1 && [cfg.photoInput, cfg.noPhotoInput].some((x) => x && x.toLowerCase() === name))
            await this.lt.out();
        else
            await this.overlayOut(1, s.overlays);
        return { out: name };
    }
    async allOut() {
        this.stopRotation();
        const snap = await this.snapshot();
        this.pushUndo(snap.overlays);
        for (let n = 1; n <= 4; n++)
            await this.overlayOut(n, snap.overlays);
        return { allOut: true };
    }
    /** First press arms, a second within 3 s cuts every overlay at once (no animation). */
    async panic() {
        const now = Date.now();
        const st = this.state;
        if (now - st.armedPanic > 3000) {
            this.patchState({ armedPanic: now });
            void this.pushLabels();
            return { armed: true };
        }
        this.stopRotation();
        this.patchState({ armedPanic: 0 });
        for (let n = 1; n <= 4; n++)
            await this.vmix(`?Function=OverlayInput${n}Off`);
        return { panic: true };
    }
    // ---------- break scene ----------
    slides() {
        const out = [{ kind: 'schedule' }];
        for (const f of this.breakFleets())
            out.push({ kind: 'results', fleetId: f });
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
        if (s.kind === 'results' && s.fleetId)
            await pushResults(this.ctx, s.fleetId, input.key || input.number, this.fetcher);
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
        if (this.rotation)
            clearInterval(this.rotation);
        this.rotation = null;
        if (this.state.rotating)
            this.patchState({ rotating: false });
    }
    async toggleRotation() { if (this.rotation)
        this.stopRotation();
    else
        this.startRotation(); return { rotating: !!this.rotation }; }
    async tickerMode() {
        const mode = this.state.tickerMode === 'next' ? 'end' : 'next';
        this.patchState({ tickerMode: mode });
        // the ticker on air changes its text in place (DataChange), the scene stays
        const { inputs } = await this.snapshot().catch(() => ({ inputs: [] }));
        const t = this.resolve(this.graphic('ticker'), inputs);
        if (t)
            await this.set(t, new Map([[this.textField(t, /ticker|text/i) ?? '', this.tickerText()]]));
        return { tickerMode: mode };
    }
    // ---------- the key router ----------
    async run(action) {
        this.invalidate();
        const [kind, arg = ''] = action.split(':');
        try {
            const r = await this.dispatch(kind, arg).finally(() => this.invalidate()); // what the press changed shows at once
            this.patchState({ last: { at: new Date().toISOString(), action, error: null } });
            void this.pushLabels();
            return r;
        }
        catch (e) {
            this.patchState({ last: { at: new Date().toISOString(), action, error: String(e?.message ?? e) } });
            throw e;
        }
    }
    async dispatch(kind, arg) {
        switch (kind) {
            case 'lult': return this.lineupLt(arg);
            case 'lultswap': return this.lineupLtSwap();
            case 'show': return arg === 'lineup5' ? this.lineupLt() : arg === 'compare' && this.config.fleetId && this.compareGroups().some((g) => g.fleetId === this.config.fleetId) ? this.compareGroup(this.config.fleetId) : this.toggle(arg);
            case 'compare': return this.compareGroup(arg);
            case 'qualified': return this.qualified(arg);
            case 'comm': return this.commentator(arg);
            case 'person': return this.person(arg);
            case 'anthem': return this.lt.showTeam(this.teamRef(arg).code);
            case 'lineup': return this.lineup(arg);
            case 'sailorof': {
                const [code, slot = ''] = arg.split('/');
                return this.sailorOf(code, slot);
            }
            case 'boat': {
                const n = Number(arg);
                this.boat(n);
                this.patchState({ boat: n });
                return { boat: n };
            }
            case 'sailor': return this.sailor(Number(arg));
            case 'shirt': return this.sailor(null, arg);
            case 'photo': {
                const m = { auto: 'on', on: 'off', off: 'auto' }[this.state.photo];
                this.patchState({ photo: m });
                return { photo: m };
            }
            case 'next': return this.lt.nextLine();
            case 'teamlt': return this.lt.showTeam(arg ? this.teamRef(arg).code : this.boat(this.state.boat).code);
            case 'out':
            case 'ltout':
            case 'boardout': return this.layerOut();
            case 'bug': return this.bug(arg);
            case 'ticker': return this.ticker(arg);
            case 'bugout': {
                const s = await this.snapshot();
                this.pushUndo(s.overlays);
                await this.overlayOut(this.graphic('bug').overlay, s.overlays);
                return { out: 'bug' };
            }
            case 'breakout': {
                const s = await this.snapshot();
                this.pushUndo(s.overlays);
                await this.sceneOut(s.overlays);
                return { out: 'scene' };
            }
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
    async keyLook(key, ctxt, neutral = false) {
        const [kind, arg = ''] = key.action.split(':');
        const st = this.state;
        let text = key.text;
        let onAir = false, active = false, empty = false;
        const boats = this.boats();
        const ov = ctxt?.overlays ?? {};
        const isOn = (id) => { if (!ctxt)
            return false; const g = this.graphics().find((x) => x.id === id); const i = g && this.resolve(g, ctxt.inputs); return !!(g && i && ov[g.overlay] === i.number); };
        const lt = getLtState(this.ctx.db);
        let team; // the team whose national colours the key takes
        if (key.team) {
            // a key of a team's page (or the TEAMS page): its text is fixed, the team gives the colours
            const t = this.teams().find((x) => x.code === key.team);
            team = t;
            if (t && kind === 'sailorof')
                onAir = lt.onAir && lt.kind === 'sailor' && lt.teamId === t.id && lt.slot === arg.split('/')[1];
            if (t && (kind === 'teamlt' || kind === 'anthem'))
                onAir = lt.onAir && lt.kind === 'team' && lt.teamId === t.id;
        }
        else if (kind === 'anthem' || kind === 'lineup' || kind === 'boat' || kind === 'qualified') {
            const b = boats[Number(arg) - 1];
            team = b;
            if (b && kind === 'anthem')
                onAir = lt.onAir && lt.kind === 'team' && lt.teamId === b.id;
            text = b ? (kind === 'boat' ? `${b.code}\\n${b.name.toUpperCase().slice(0, 12)}` : `${{ anthem: 'ANTHEM', lineup: 'LINEUP', qualified: 'QUALIFIED' }[kind]}\\n${b.code}`) : `${key.text}\\n—`;
            empty = !b;
            if (kind === 'boat')
                active = st.boat === Number(arg);
        }
        else if (kind === 'sailor') {
            const s = this.sailors()[Number(arg) - 1];
            const b = boats[st.boat - 1];
            team = b;
            if (s && b)
                onAir = lt.onAir && lt.kind === 'sailor' && lt.teamId === b.id && lt.slot === s.slot;
            text = s ? `#${s.number || '?'}${s.photo ? ' ●' : ''}\\n${s.position.toUpperCase()}\\n${s.lastName.toUpperCase().slice(0, 10)}${b ? ` ${b.code}` : ''}` : '';
            empty = !s;
        }
        else if (kind === 'teamlt') {
            team = boats[st.boat - 1];
            if (team) {
                text = `TEAM LT\\n${team.code}`;
                onAir = lt.onAir && lt.kind === 'team' && lt.teamId === team.id;
            }
        }
        else if (kind === 'bug' && arg !== 'thanks') {
            const a = this.announcement(arg);
            text = a ? a.name.toUpperCase().slice(0, 28) : '';
            empty = !a;
            if (a)
                onAir = isOn('bug') && st.bugId === a.id;
        }
        else if (kind === 'ticker' || (kind === 'bug' && arg === 'thanks')) {
            const t = this.tickerVersion(kind === 'bug' ? 'thanks' : arg);
            text = t ? `TICKER\\n${t.name.toUpperCase().slice(0, 24)}` : '';
            empty = !t;
            if (t)
                onAir = isOn('ticker') && st.tickerId === t.id;
        }
        else if (kind === 'person') {
            const p = this.people()[Number(arg) - 1];
            text = p ? `${[p.name, p.surname].filter(Boolean).join(' ').toUpperCase().slice(0, 20)}\\n${(p.role || p.title || '').toUpperCase().slice(0, 20)}` : '';
            empty = !p;
        }
        else if (kind === 'photo')
            text = `PHOTO\\n${st.photo.toUpperCase()}`;
        else if (kind === 'comparemark')
            text = `COMPARE:\\n${st.compareMark === 'emblem' ? 'EMBLEM' : 'FLAG'}`;
        else if (kind === 'tickermode')
            text = st.tickerMode === 'end' ? 'TICKER:\\nEND OF DAY' : 'TICKER:\\nNEXT RACE';
        else if (kind === 'rotate') {
            text = st.rotating ? 'ROTATION\\n⏸ STOP' : 'ROTATION\\n▶ START';
            active = st.rotating;
        }
        else if (kind === 'panic' && Date.now() - st.armedPanic < 3000) {
            text = 'PANIC?\\nPRESS AGAIN';
            onAir = true;
        }
        if (kind === 'show')
            onAir = isOn(arg);
        if (kind === 'compare' && ctxt) {
            const i = ctxt.inputs.find((x) => x.title.toLowerCase().replace(/\.gtzip$/, '') === compareInput(compareKey(arg)).toLowerCase());
            onAir = !!i && ov[1] === i.number;
        }
        if (kind === 'break')
            onAir = isOn('break');
        if (neutral) {
            onAir = false;
            active = false;
            if (key.kind === 'mode')
                text = key.text;
        } // a fixed key: its name, not today's mode
        if (key.custom)
            text = key.custom.replace(/\{auto\}/g, text);
        // team and sailor keys in the team's national colours, the feedback (selected / on air) in its colours too;
        // a colour set on the key or on its kind in the key editor still wins
        const nation = team && !empty && !key.bg && !this.config.kindColours[key.kind] ? this.nation(team.code) : null;
        if (nation) {
            const l = teamKeyLook(nation, text, { active, onAir });
            return { text: l.text, bg: l.bg, fg: key.fg || l.fg, onAir, active, empty };
        }
        let bg = keyBg(this.config, key);
        let fg = key.fg || '#ffffff';
        if (active) {
            bg = '#f59e0b';
            fg = '#000000';
            text = `▶ ${text}`;
        }
        if (onAir) {
            bg = '#dc2626';
            fg = '#ffffff';
            text = `● ${text}`;
        }
        if (empty) {
            bg = '#18181b';
            fg = key.fg || '#ffffff';
        }
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
                return { ...g, input: i?.title ?? null, onAir: !!(i && snap.overlays[g.overlay] === i.number), fields: i?.fields.length ?? 0 };
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
        if (!cfg.labels || !lt.companionUrl)
            return { sent: 0 };
        if (force)
            this.labels.clear();
        let n = 0;
        try {
            for (const p of this.pages()) {
                for (const [r, row] of p.keys.entries()) {
                    for (const [c, key] of row.entries()) {
                        if (!key || !/^(bug|ticker|person):/.test(key.action))
                            continue;
                        const l = await this.keyLook(key, undefined, true);
                        const q = `text=${encodeURIComponent(l.text)}&bgcolor=${encodeURIComponent(l.bg)}&color=${encodeURIComponent(l.fg)}&size=auto`;
                        const id = `${p.page}/${r}/${c}`;
                        if (this.labels.get(id) === q)
                            continue;
                        const res = await this.fetcher(`${lt.companionUrl}/api/location/${id}/style?${q}`, { method: 'POST', signal: AbortSignal.timeout(3000) });
                        if (res.ok) {
                            this.labels.set(id, q);
                            n++;
                        }
                    }
                }
            }
        }
        catch (e) {
            this.log(`Companion labels: ${e?.message ?? e}`);
        }
        return { sent: n };
    }
    /**
     * The whole Companion preset in one file (every page of both decks, a page per team, the fallback page): each key
     * has its text and colours fixed in it, as they are now (no live labels).
     */
    async companionPreset(base, vmixBase) {
        await this.snapshot().catch(() => null);
        const pages = this.pages();
        const looks = await Promise.all(pages.map(async (p) => ({ ...p, keys: await Promise.all(p.keys.map((r) => Promise.all(r.map(async (key) => (key ? { key, look: await this.keyLook(key, undefined, true) } : null))))) })));
        return companionPresetFile(this.config, looks, base, vmixBase, this.graphics());
    }
    /** Keeps the keys in step with vMix and line-up changes made elsewhere. */
    start(ms = 2000) { this.timer = setInterval(() => { void this.pushLabels(); void this.syncData(); }, ms); this.timer.unref?.(); }
    syncSig = '';
    syncing = false;
    syncError = '';
    /**
     * Keeps the data titles in step with the dashboard without a key press: Day schedule (Schedule tab), Group results
     * and Team comparison of the group picked at the top. After any change in the dashboard (or a new day), only the
     * fields whose value differs from what vMix shows in the title are set.
     */
    async syncData() {
        if (this.syncing)
            return { sent: 0 };
        const ev = activeEvent(this.ctx.db);
        const today = todayIn(ev.timezone);
        const sig = `${this.ctx.db.prepare('SELECT total_changes() AS n').get().n}|${today}`;
        if (sig === this.syncSig)
            return { sent: 0 };
        this.syncing = true;
        let sent = 0;
        try {
            const { inputs } = await this.snapshot();
            const fleetId = this.config.fleetId;
            const jobs = [];
            // the Welcome bar follows the Welcome tab (and today's date) without a key
            const wel = this.resolve(this.graphic('welcome'), inputs);
            if (wel)
                jobs.push({ input: wel, f: () => showDataFields(this.ctx, 'welcome', { eventId: ev.id, today, auto: tickerAuto(this.ctx.db, ev), tickerText: this.tickerText() }) });
            const sched = this.resolve(this.graphic('schedule'), inputs);
            if (sched)
                jobs.push({ input: sched, f: () => showDataFields(this.ctx, 'schedule', { eventId: ev.id, today, auto: tickerAuto(this.ctx.db, ev), tickerText: this.tickerText() }) });
            // General graphics whose data is only on their tab: Weather, Race officials, Follow us
            for (const id of ['weather', 'officials', 'socials']) {
                const g = this.graphics().find((x) => x.id === id);
                const input = g && this.resolve(g, inputs);
                if (input)
                    jobs.push({ input, f: () => showDataFields(this.ctx, id, { eventId: ev.id, today, auto: tickerAuto(this.ctx.db, ev), tickerText: this.tickerText() }) });
            }
            const res = fleetId ? this.resolve(this.graphic('results'), inputs) : undefined;
            if (res)
                jobs.push({ input: res, f: () => resultFieldsFor(this.ctx, fleetId, res).fields });
            // Team comparison: every group's own input, and the shared one for the group picked at the top
            for (const t of this.compareTargets(inputs))
                jobs.push({ input: t.input, f: () => this.compareData(t.fleetId) });
            for (const { input, f: make } of jobs) {
                const f = make();
                if (!f)
                    continue;
                const match = titleFieldMatcher(input.fields);
                // the first name for a field wins, as in set()
                const seen = new Set();
                const changed = new Map([...f].filter(([k, v]) => { const r = match(k); if (r === undefined || seen.has(r))
                    return false; seen.add(r); return (input.values?.[r] ?? '') !== v; }));
                if (changed.size)
                    sent += await this.set(input, changed);
            }
            this.syncSig = sig;
            this.syncError = '';
        }
        catch (e) {
            const msg = String(e?.message ?? e);
            if (msg !== this.syncError)
                this.log(`vMix data: ${msg}`);
            this.syncError = msg;
        }
        finally {
            this.syncing = false;
        }
        return { sent };
    }
    stop() { if (this.timer)
        clearInterval(this.timer); this.stopRotation(); }
    /**
     * Placeholders: every registry input missing in vMix gets an Image input with that name: a transparent 1920×1080 PNG
     * with a small orange corner mark. Only inputs are added; nothing else in vMix changes. Replace it later with the
     * GTZIP title and give the title the same name.
     */
    async addPlaceholders() {
        const { inputs } = await this.snapshot();
        const added = [];
        const dir = path.join(this.ctx.assetsDir, 'placeholders');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'placeholder.png');
        if (!fs.existsSync(file))
            fs.writeFileSync(file, encodePng(1920, 1080, (x, y) => (x < 24 && y < 24 ? [245, 158, 11, 255] : [0, 0, 0, 0])));
        const root = getSetting(this.ctx.db, 'paths.vmixAssetsRoot');
        const vmixPath = root ? joinVmixPath(root, 'placeholders/placeholder.png') : file;
        const want = this.graphics().flatMap((g) => {
            if (g.id === 'compare')
                return this.compareGroups().map((x) => compareInput(x.key)); // a Team comparison per group
            if (this.resolve(g, inputs))
                return [];
            const name = g.inputs.map((x) => x.replace('{n}', String(this.boats().length || 4)).replace('{crew}', '9')).find((x) => !x.includes('{'));
            return name ? [name] : [];
        });
        for (const name of want) {
            if (inputs.some((i) => i.title.toLowerCase().replace(/\.gtzip$/, '') === name.toLowerCase()))
                continue;
            await this.vmix(`?Function=AddInput&Value=${encodeURIComponent(`Image|${vmixPath}`)}`);
            const after = parseVmixXml(await this.vmix(''));
            const fresh = after.find((i) => !inputs.some((o) => o.key === i.key));
            if (!fresh)
                throw badRequest(`vMix did not add the placeholder image (${vmixPath}). Check the vMix assets folder in Settings → Files and paths.`);
            await this.vmix(`?Function=SetInputName&Input=${encodeURIComponent(fresh.key || fresh.number)}&Value=${encodeURIComponent(name)}`);
            inputs.push({ ...fresh, title: name });
            added.push(name);
        }
        return { added, image: vmixPath };
    }
}
/** Companion's full export (format 4, which every later Companion upgrades on import): all pages, one HTTP connection. */
export function companionPresetFile(cfg, pages, base, vmixBase, graphics) {
    const b = base.replace(/\/+$/, '');
    const out = {};
    for (const p of pages) {
        const controls = {};
        p.keys.forEach((row, r) => row.forEach((x, c) => {
            if (!x || (x.look.empty && x.key.kind !== 'nav'))
                return;
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
const COLOURS = (kind) => ({ board: 0x1e3a8a, lt: 0x166534, bug: 0xa16207, scene: 0x0f766e, team: 0x1e3a5f, sailor: 0x27303f, nav: 0x3f3f46, safety: 0x7c2d12, mode: 0x4c1d95 }[kind] ?? 0x3f3f46);
const hex = (c) => parseInt(c.replace('#', ''), 16) || 0;
const control = (text, bg, down, fg = 0xffffff) => ({
    type: 'button',
    style: { text, size: 'auto', png64: null, alignment: 'center:center', pngalignment: 'center:center', color: fg, bgcolor: bg, show_topbar: 'default' },
    options: { relativeDelay: false, rotaryActions: false, stepAutoProgress: true },
    feedbacks: [],
    steps: { 0: { action_sets: { down, up: [] }, options: { runWhileHeld: [] } } },
});
const CONN = 'ssl_dashboard_show';
const http = (id, url) => ({ id, action: 'get', instance: CONN, options: { url, header: '' }, delay: 0 });
const setPage = (id, page) => ({ id, action: 'set_page', instance: 'internal', options: { controller: 'self', controller_from_variable: false, controller_variable: '', page, page_from_variable: false, page_variable: '' }, delay: 0 });
const CONN_DEF = { instance_type: 'generic-http', label: 'ssl_dashboard_show', enabled: true, isFirstInit: false, lastUpgradeIndex: -1, sortOrder: 0, config: { prefix: '', proxyAddress: '', rejectUnauthorized: true } };
function pageFile(name, page, controls) {
    return {
        version: 4, type: 'page',
        page: { name, controls, gridSize: { minColumn: 0, maxColumn: 7, minRow: 0, maxRow: 3 } },
        instances: { [CONN]: CONN_DEF },
        oldPageNumber: page,
    };
}
/** One Companion page export (format 4, upgraded by every later Companion on import) per deck page, plus the fallback page. */
export function companionFiles(cfg, base, vmixBase, graphics) {
    const b = base.replace(/\/+$/, '');
    const files = [];
    for (const p of deckPages(cfg)) {
        const controls = {};
        p.keys.forEach((row, r) => row.forEach((key, c) => {
            if (!key)
                return;
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
function fallbackControls(cfg, vmixBase, graphics) {
    const v = vmixBase.replace(/\/+$/, '');
    const fb = {};
    const first = (g) => g.inputs.map((x) => x.replace('{n}', '4').replace('{crew}', '9')).find((x) => !x.includes('{'));
    const pick = ['welcome', 'schedule', 'matchboard', 'results', 'compare', 'course', 'officials', 'weather', 'comm', 'bug', 'ticker', 'socials', 'sponsors', 'break', 'lbar'];
    const fbKeys = pick.map((id) => graphics.find((g) => g.id === id)).filter((g) => !!g);
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
