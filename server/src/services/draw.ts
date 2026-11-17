import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getSetting, setSetting } from '../db/db.js';
import { AssetCtx, listAssets } from './assets.js';
import { badRequest } from './errors.js';
import { listTeams } from './teams.js';
import { starredBefore, starredTeams } from './matchboard/rounds.js';
import { getLtConfig } from './lowerthirds.js';
import { getShowConfig } from './show.js';
import { fixturesDir, getState, loadLayout, resolveTeams, uploadedSansFiles } from './matchboard/matchboard.js';
import { listGradients, TEAM_GRADIENTS_SSL26 } from './generator/generator.js';
import { nationColours } from './nationColours.js';

/**
 * DRAW: the stage screen of the official draw (1/32 Finals). Teams are drawn one by one from a pool, then each gets
 * a group (A–D) drawn from the groups' pool. The operator presses what was drawn on stage (dashboard or Stream Deck),
 * the output page (/draw/output, a vMix Browser input) animates it. All state is one settings entry.
 */
export const DRAW_GROUPS = ['A', 'B', 'C', 'D'] as const;
export const DRAW_GROUP_SIZE = 4;
export const DRAW_POOL_MAX = 16;
export const DRAW_INPUT = 'ssl_draw';
export const DRAW_MATCHBOARD_INPUT = 'ssl_draw_matchboard';
export const DRAW_MATCHBOARD_REL = 'Matchboard/matchboard_draw.png';

export const drawConfigSchema = z.object({
  /** a short caption in the centre when nothing is being drawn (the header picture has the event title) */
  caption: z.string().max(80),
  /** team ids in the order of the left strip */
  pool: z.array(z.string()).max(DRAW_POOL_MAX),
  /** Companion page the DRAW keys are on */
  companionPage: z.number().int().min(1).max(99),
  /** seconds the drawn team stays in the centre before it flies to its group */
  flightDelay: z.number().min(0).max(10),
  /** width of each side strip on the 1536 px wide screen */
  stripWidth: z.number().int().min(160).max(420),
  /** how a place still to be drawn looks: soft bars where the flag and code go, three dots, or the word DRAW */
  emptyStyle: z.enum(['bars', 'dots', 'text']),
  /**
   * false (default): every step on the operator's key: the flag stays until FLAG OFF, the group stays in the centre
   * until GROUP BACK. true: the flag goes after flightDelay seconds and the group goes back by itself.
   */
  autoSteps: z.boolean(),
});
export type DrawConfig = z.infer<typeof drawConfigSchema>;

export interface DrawPick { teamId: string; group: string; place: number }
export interface DrawState {
  picks: DrawPick[];
  /** the team just drawn; with a group once its group is drawn too (until the next team) */
  current: { teamId: string; group: string | null } | null;
  /** the centre shows all groups instead of the current step */
  overview: boolean;
  /** the group brought to the centre before its next team is drawn (it goes back by itself once the team is in) */
  focus: string | null;
  /** the flag of the team just drawn covers the centre (manual steps: until FLAG OFF) */
  flag?: boolean;
  /** manual steps: the team is in its group, the group still in the centre (next: GROUP BACK) */
  landed?: boolean;
  /** manual steps: every key works, not only the next step (the dashboard's Unlock) */
  unlocked?: boolean;
  /** goes up with every change: the output page animates what changed */
  seq: number;
}

const CFG = 'draw.config';
const STATE = 'draw.state';
const DEFAULT_CFG: DrawConfig = { caption: '1/32 FINALS · OFFICIAL DRAW', pool: [], companionPage: 30, flightDelay: 3.5, stripWidth: 300, emptyStyle: 'bars', autoSteps: false };
const EMPTY: DrawState = { picks: [], current: null, overview: false, focus: null, flag: false, landed: false, unlocked: false, seq: 0 };

/** The four steps of each team with manual steps, in order. */
export type DrawStep = 'focus' | 'team' | 'reveal' | 'back';
/** The step that comes next with manual steps (1 focus, 2 team, 3 reveal, 4 back); null once every group is full. */
export function nextStep(st: DrawState, next: string | null): DrawStep | null {
  if (st.flag) return 'reveal';
  if (st.focus && st.landed) return 'back';
  if (!next) return st.focus ? 'back' : null;
  if (st.focus === next) return 'team';
  return 'focus';
}

export function getDrawConfig(db: AssetCtx['db']): DrawConfig {
  try { return drawConfigSchema.parse({ ...DEFAULT_CFG, ...JSON.parse(getSetting(db, CFG) || '{}') }); } catch { return DEFAULT_CFG; }
}
export function getDrawState(db: AssetCtx['db']): DrawState {
  try { return { ...EMPTY, ...JSON.parse(getSetting(db, STATE) || '{}') }; } catch { return EMPTY; }
}
function saveState(db: AssetCtx['db'], s: Omit<DrawState, 'seq'>) {
  const next = { ...s, seq: getDrawState(db).seq + 1 };
  setSetting(db, STATE, JSON.stringify(next));
  return next;
}

/** Header picture: one uploaded into the assets folder, else the one that ships with the app. */
export const headerPath = (assetsDir: string) => {
  const own = path.join(assetsDir, 'draw', 'header.png');
  return fs.existsSync(own) ? own : path.join(fixturesDir(), 'draw', 'header.png');
};
export function saveHeader(assetsDir: string, buf: Buffer | null) {
  const own = path.join(assetsDir, 'draw', 'header.png');
  if (!buf) { fs.rmSync(own, { force: true }); return; }
  if (!(buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47)) throw badRequest('The header must be a PNG.');
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, buf);
}

/** Flag animations (one video per team, as the LED wall shows it: 1536×1024): assets/draw/flags/<team id>.<ext>. */
export const FLAG_VIDEO_EXT = ['mp4', 'webm', 'mov'] as const;
const flagsDir = (assetsDir: string) => path.join(assetsDir, 'draw', 'flags');
export function flagVideoPath(assetsDir: string, teamId: string): string | null {
  if (!/^[\w-]+$/.test(teamId)) return null;
  for (const ext of FLAG_VIDEO_EXT) { const f = path.join(flagsDir(assetsDir), `${teamId}.${ext}`); if (fs.existsSync(f)) return f; }
  return null;
}
export async function saveFlagVideo(assetsDir: string, teamId: string, filename: string, stream: NodeJS.ReadableStream) {
  const ext = (path.extname(filename).slice(1).toLowerCase() || 'mp4') as (typeof FLAG_VIDEO_EXT)[number];
  if (!FLAG_VIDEO_EXT.includes(ext)) throw badRequest('Send an MP4, WebM or MOV video.');
  fs.mkdirSync(flagsDir(assetsDir), { recursive: true });
  const target = path.join(flagsDir(assetsDir), `${teamId}.${ext}`);
  const tmp = `${target}.part`;
  await new Promise<void>((resolve, reject) => { const out = fs.createWriteStream(tmp); stream.on('error', reject); out.on('error', reject); out.on('finish', () => resolve()); stream.pipe(out); });
  if ((stream as { truncated?: boolean }).truncated) { fs.rmSync(tmp, { force: true }); throw badRequest('The video is too big (2 GB at most).'); }
  deleteFlagVideo(assetsDir, teamId);
  fs.renameSync(tmp, target);
}
export function deleteFlagVideo(assetsDir: string, teamId: string) {
  for (let f = flagVideoPath(assetsDir, teamId); f; f = flagVideoPath(assetsDir, teamId)) fs.rmSync(f, { force: true });
}

/** A place of a group on the screen: a team already there (fixed on the matchboard) or a place the draw fills. */
export interface BoardSlot { teamId: string | null; text: string; draw: boolean }
/** slotIds: the matchboard rows of the group (empty without the matchboard) */
export interface BoardGroup { letter: string; slots: BoardSlot[]; slotIds?: string[] }

/**
 * The 1/32 Finals groups as the matchboard has them (boxes R1 A–D): a row with a team not in the draw pool stays as it
 * is (COL in R1 A), every other row (DRAW 1, DRAW 2…) is a place the draw fills, top to bottom. Without such boxes:
 * four groups of four draw places.
 */
export function drawBoard(db: AssetCtx['db'], pool: Set<string>): BoardGroup[] {
  let layout, state;
  try { layout = loadLayout(); state = getState(db); } catch { layout = null; }
  const out: BoardGroup[] = [];
  for (const letter of DRAW_GROUPS) {
    const g = layout?.groups.find((x) => /^R\s*1\s*([A-D])$/i.exec(((state!.texts[x.labelId] ?? layout!.texts.find((t) => t.id === x.labelId)?.text) ?? '').trim())?.[1]?.toUpperCase() === letter);
    if (!g || !layout || !state) { out.push({ letter, slots: Array.from({ length: DRAW_GROUP_SIZE }, () => ({ teamId: null, text: 'DRAW', draw: true })), slotIds: [] }); continue; }
    const resolved = resolveTeams(layout, state);
    out.push({ letter, slotIds: [...g.slots], slots: g.slots.map((sid) => {
      const teamId = resolved.get(sid)?.teamId ?? null;
      // an empty place says just DRAW (the matchboard's DRAW 1…11 would read as an order of the draw)
      return teamId && !pool.has(teamId) ? { teamId, text: '', draw: false } : { teamId: null, text: 'DRAW', draw: true };
    }) });
  }
  return out;
}
/** The rows (1-based) of a group the draw fills, in order. */
const drawPlaces = (g: BoardGroup) => g.slots.map((s, i) => (s.draw ? i + 1 : 0)).filter(Boolean);

/**
 * The group the next team drawn goes to: the one with the fewest teams so far (its fixed teams and the ones drawn),
 * the first in A–D order on a tie, so the groups stay as even as they can after every step. Null when all are full.
 */
export function nextDrawGroup(board: BoardGroup[], picks: DrawPick[]): string | null {
  let best: { letter: string; n: number } | null = null;
  for (const g of board) {
    const drawn = picks.filter((p) => p.group === g.letter).length;
    if (drawn >= drawPlaces(g).length) continue;
    const n = g.slots.filter((x) => !x.draw).length + drawn;
    if (!best || n < best.n) best = { letter: g.letter, n };
  }
  return best?.letter ?? null;
}

export interface DrawTeam { id: string; code: string; name: string; flag: string | null; flagAsset: string | null }

export class Draw {
  constructor(readonly ctx: AssetCtx, private fetcher: typeof fetch = fetch, private log: (m: string) => void = () => {}) {}

  get config() { return getDrawConfig(this.ctx.db); }
  get state() { return getDrawState(this.ctx.db); }

  setConfig(patch: Partial<DrawConfig>) {
    const cur = this.config;
    const next = drawConfigSchema.parse({ ...cur, ...patch });
    const known = new Set(listTeams(this.ctx).map((t) => t.id));
    next.pool = [...new Set(next.pool)].filter((id) => known.has(id));
    setSetting(this.ctx.db, CFG, JSON.stringify(next));
    // a team taken out of the pool leaves its group too
    const st = this.state;
    const inPool = new Set(next.pool);
    if (st.picks.some((p) => !inPool.has(p.teamId)) || (st.current && !inPool.has(st.current.teamId))) {
      saveState(this.ctx.db, { ...st, picks: renumber(st.picks.filter((p) => inPool.has(p.teamId)), drawBoard(this.ctx.db, inPool)), current: st.current && inPool.has(st.current.teamId) ? st.current : null });
    } else saveState(this.ctx.db, st); // the output shows the new pool / caption
    void this.pushLabels();
    this.onPicks?.();
    return next;
  }

  /** Every team of the event, with its flag for the pickers. */
  allTeams(): DrawTeam[] {
    return listTeams(this.ctx).filter((t) => t.code).map((t) => {
      const a = t.assets.flag_big ?? t.assets.flag_small ?? null;
      return { id: t.id, code: t.code, name: t.name, flag: a?.previewUrl ?? null, flagAsset: a?.id ?? null };
    });
  }
  poolTeams(): DrawTeam[] {
    const by = new Map(this.allTeams().map((t) => [t.id, t]));
    return this.config.pool.map((id) => by.get(id)).filter((t): t is DrawTeam => !!t);
  }

  /** The teams starred in the Qualifying Series on the matchboard: the ones drawn into the 1/32 Finals, in its order. */
  qualified(): string[] {
    try { return starredBefore(starredTeams(loadLayout(), getState(this.ctx.db)), 1).map((x) => x.teamId); } catch { return []; }
  }


  /** What the output page needs (no ids of assets: the flags come through /api/draw/output/flag/<team id>). */
  output() {
    const cfg = this.config, st = this.state;
    const grads = new Map(listGradients(this.ctx.db).map((g) => [g.teamId, g.gradients[1]]));
    const board = this.board();
    const fixed = new Set(board.flatMap((g) => g.slots.map((x) => x.teamId).filter((x): x is string => !!x)));
    const all = this.allTeams();
    const pool = this.poolTeams();
    const video = (id: string) => { const f = flagVideoPath(this.ctx.assetsDir, id); return f ? `/api/draw/output/video/${id}?v=${Math.round(fs.statSync(f).mtimeMs)}` : null; };
    const teams = [...pool, ...all.filter((t) => fixed.has(t.id))].map((t) => ({ id: t.id, code: t.code, name: t.name, flag: t.flagAsset ? `/api/draw/output/flag/${t.id}` : null, video: video(t.id), gradient: teamGradient(this.ctx.db, t.code, grads.get(t.id) ?? null) }));
    const fonts = uploadedSansFiles(this.ctx.assetsDir).map((f) => f.weight);
    return { seq: st.seq, fonts, caption: cfg.caption, flightDelay: cfg.flightDelay, stripWidth: cfg.stripWidth, board, pool: pool.map((t) => t.id), teams, picks: st.picks, current: st.current, overview: st.overview, headerV: Math.round(fs.statSync(headerPath(this.ctx.assetsDir)).mtimeMs), focus: st.focus ?? null, flag: !!st.flag, autoSteps: cfg.autoSteps, emptyStyle: cfg.emptyStyle, next: nextDrawGroup(board, st.picks) };
  }
  flagFile(teamId: string) {
    const t = this.allTeams().find((x) => x.id === teamId);
    return t?.flagAsset ?? null;
  }

  /** Something the output shows changed outside the steps (header picture): it reloads. */
  touch() { return saveState(this.ctx.db, this.state); }

  board() { return drawBoard(this.ctx.db, new Set(this.config.pool)); }
  view() {
    // the first time: the pool is the teams starred in the Qualifying Series on the matchboard
    if (!getSetting(this.ctx.db, CFG)) { const q = this.qualified(); if (q.length) this.setConfig({ pool: q.slice(0, DRAW_POOL_MAX) }); }
    const videos = Object.fromEntries(this.config.pool.map((id) => { const f = flagVideoPath(this.ctx.assetsDir, id); return [id, f ? { file: path.basename(f), bytes: fs.statSync(f).size } : null]; }));
    return { config: this.config, state: this.state, teams: this.allTeams(), pool: this.poolTeams(), board: this.board(), next: this.nextGroup(), videos, input: DRAW_INPUT, matchboardInput: DRAW_MATCHBOARD_INPUT, step: this.step(), locked: !this.config.autoSteps && !this.state.unlocked };
  }

  /** The matchboard as it stands, with every team drawn so far in its row of R1 A–D (the DRAW rows it fills). */
  matchboardState() {
    const state = getState(this.ctx.db);
    const board = this.board();
    for (const p of this.state.picks) {
      const sid = board.find((g) => g.letter === p.group)?.slotIds?.[p.place - 1];
      if (sid && state.slots[sid]) state.slots[sid] = { ...state.slots[sid], teamId: p.teamId };
    }
    return state;
  }

  /**
   * One step of the draw. team:<n> (1–16, place in the pool) or team:<CODE> draws a team: it goes straight to the next
   * free place of the group with the fewest teams (nextDrawGroup). group:<A–D> moves the team just drawn to another
   * group (a correction). focus brings the group the next team goes to into the centre (focus:<A–D> a given one,
   * focus:off sends it back; show:<A–D> brings that group to the centre on its own, pressed again it goes back). With manual steps the team's flag stays until reveal (FLAG OFF: the team shows in its
   * group) and the group stays in the centre until back. undo, clear, overview (on/off), overview:on|off, reset.
   */
  /** The group the next team drawn goes to. */
  nextGroup() { return nextDrawGroup(this.board(), this.state.picks); }
  /** Called when the teams in the groups change (the draw matchboard is made again). */
  onPicks: (() => void) | null = null;

  /** The next step with manual steps; null once every group is full or every team in the pool is drawn. */
  step() {
    const st = this.state, placed = new Set(st.picks.map((p) => p.teamId));
    const left = this.poolTeams().some((t) => !placed.has(t.id));
    return nextStep(st, left ? nextDrawGroup(this.board(), st.picks) : null);
  }

  /** Whether a key works now: with manual steps and no Unlock only the next step (and ALL GROUPS once the draw is over). */
  allowed(a: string) {
    const st = this.state;
    if (this.config.autoSteps || st.unlocked) return true;
    const [verb, arg = ''] = a.split(':');
    if (verb === 'lock' || verb === 'unlock') return true;
    // showing a group in the centre on its own: whenever no team is between its steps (no flag, no team just landed)
    if (verb === 'show') return !st.flag && !st.landed;
    const nx = nextDrawGroup(this.board(), st.picks);
    const step = this.step();
    if (step === null) return verb === 'overview';
    if (verb !== step) return false;
    if (verb === 'focus') return !arg || arg === 'next' || arg.toUpperCase() === nx;
    return true;
  }

  run(a: string) {
    const [verb, arg = ''] = a.split(':');
    const st = this.state;
    const pool = this.poolTeams();
    const placed = new Set(st.picks.map((p) => p.teamId));
    const groupCount = (g: string) => st.picks.filter((p) => p.group === g).length;
    const board = this.board();
    const places = (g: string) => drawPlaces(board.find((x) => x.letter === g)!);
    // manual steps: only the next step works (a key pressed by mistake does nothing), until Unlock
    if (verb === 'lock' || verb === 'unlock') {
      const saved = saveState(this.ctx.db, { ...st, unlocked: verb === 'unlock' });
      void this.pushLabels();
      return saved;
    }
    if (!this.allowed(a)) throw badRequest(`Locked: the next step is ${STEP_NAME[this.step() ?? 'none']}. Unlock in the DRAW tab for other keys.`);
    let next: Omit<DrawState, 'seq'> = st;
    switch (verb) {
      case 'team': {
        const n = Number(arg);
        const t = Number.isInteger(n) && n >= 1 ? pool[n - 1] : pool.find((x) => x.code.toUpperCase() === arg.toUpperCase());
        if (!t) throw badRequest(`No team ${arg} in the draw pool.`);
        if (placed.has(t.id)) throw badRequest(`${t.code} already has its group.`);
        const g = nextDrawGroup(board, st.picks);
        if (!g) throw badRequest('Every group is full.');
        const pick = { teamId: t.id, group: g, place: places(g)[groupCount(g)] };
        const auto = this.config.autoSteps;
        next = { ...st, picks: [...st.picks, pick], current: { teamId: t.id, group: g }, overview: false, focus: auto ? null : g, flag: !auto, landed: false };
        break;
      }
      case 'group': {
        const g = arg.toUpperCase();
        if (!(DRAW_GROUPS as readonly string[]).includes(g)) throw badRequest(`Group ${arg}? Use A–D.`);
        const last = st.picks[st.picks.length - 1];
        if (!st.current || !last || last.teamId !== st.current.teamId) throw badRequest('Draw a team first.');
        if (last.group === g) break;
        const rest = st.picks.slice(0, -1);
        if (rest.filter((p) => p.group === g).length >= places(g).length) throw badRequest(`Group ${g} is full.`);
        const pick = { teamId: last.teamId, group: g, place: places(g)[rest.filter((p) => p.group === g).length] };
        next = { ...st, picks: [...rest, pick], current: { teamId: last.teamId, group: g }, overview: false };
        break;
      }
      case 'undo': {
        // the last team drawn goes back to the pool
        if (st.picks.length) next = { ...st, picks: st.picks.slice(0, -1), current: null, focus: null, flag: false, landed: false };
        else if (st.current || st.focus) next = { ...st, current: null, focus: null, flag: false, landed: false };
        break;
      }
      case 'focus': {
        const g = !arg || arg === 'next' ? nextDrawGroup(board, st.picks) : arg === 'off' ? null : arg.toUpperCase();
        if (g && !(DRAW_GROUPS as readonly string[]).includes(g)) throw badRequest(`Group ${arg}? Use A–D.`);
        if (!g && arg !== 'off') throw badRequest('Every group is full.');
        next = { ...st, focus: g, overview: false, flag: false, landed: false };
        break;
      }
      case 'show': { // one group to the centre on its own (the strips stay); pressed again, it goes back
        const g = arg.toUpperCase();
        if (!(DRAW_GROUPS as readonly string[]).includes(g)) throw badRequest(`Group ${arg}? Use A–D.`);
        if (st.flag || st.landed) throw badRequest('Finish the team on the screen first (FLAG OFF, GROUP BACK).');
        next = { ...st, focus: st.focus === g ? null : g, overview: false, flag: false, landed: false };
        break;
      }
      case 'reveal': // the flag goes, the team stands in its group
        if (!st.flag) throw badRequest('No flag on the screen.');
        next = { ...st, flag: false, landed: !!st.focus };
        break;
      case 'back': next = { ...st, focus: null, flag: false, landed: false }; break;
      case 'clear': next = { ...st, current: null, focus: null, flag: false, landed: false }; break;
      case 'overview': next = { ...st, overview: arg === 'on' ? true : arg === 'off' ? false : !st.overview, focus: null, flag: false, landed: false }; break;
      case 'reset': next = { ...EMPTY, unlocked: st.unlocked }; break;
      default: throw badRequest(`Unknown draw action ${a}`);
    }
    const saved = saveState(this.ctx.db, next);
    void this.pushLabels();
    if (next.picks !== st.picks) this.onPicks?.();
    return saved;
  }

  // ---------- Companion ----------
  /** The DRAW page's keys: [row][col] → action, text, colours (live look: drawn teams dark, the current one gold). */
  keys(): ({ action: string; text: string; bg: string; fg: string } | null)[][] {
    const st = this.state, pool = this.poolTeams(), board = this.board();
    const done = new Map(st.picks.map((p) => [p.teamId, p]));
    const rows: ({ action: string; text: string; bg: string; fg: string } | null)[][] = [[], [], [], []];
    for (let i = 0; i < DRAW_POOL_MAX; i++) {
      const t = pool[i];
      const p = t && done.get(t.id);
      const cur = t && st.current?.teamId === t.id;
      rows[Math.floor(i / 8)][i % 8] = !t ? { action: `team:${i + 1}`, text: '', bg: '#000000', fg: '#ffffff' }
        : { action: `team:${i + 1}`, text: p ? `${t.code}\\n→ ${p.group}` : t.code, bg: cur ? '#d97706' : p ? '#27272a' : '#1e3a5f', fg: p ? '#71717a' : '#ffffff' };
    }
    DRAW_GROUPS.forEach((g, i) => {
      const n = st.picks.filter((p) => p.group === g).length;
      const cap = drawPlaces(board.find((x) => x.letter === g)!).length;
      const full = n >= cap;
      const just = st.current?.group === g;
      const nxt = !just && g === nextDrawGroup(board, st.picks);
      rows[2][i] = { action: `group:${g}`, text: `GROUP ${g}\\n${n}/${cap}${nxt ? ' NEXT' : ''}`, bg: just ? '#d97706' : full ? '#27272a' : nxt ? '#0f766e' : '#134e4a', fg: full ? '#71717a' : '#ffffff' };
    });
    const nx = nextDrawGroup(board, st.picks);
    rows[2][4] = { action: 'focus', text: nx ? `GROUP ${nx}\\n▶ CENTRE` : 'GROUPS\\nFULL', bg: st.focus && !st.flag && st.focus === nx ? '#d97706' : nx ? '#1d4ed8' : '#27272a', fg: '#ffffff' };
    rows[3][1] = { action: 'reveal', text: 'FLAG OFF\\nTEAM IN', bg: st.flag ? '#d97706' : '#3f3f46', fg: st.flag ? '#ffffff' : '#a1a1aa' };
    DRAW_GROUPS.forEach((g, i) => {
      rows[3][4 + i] = { action: `show:${g}`, text: st.focus === g ? `GROUP ${g}\nSHOWN` : `SHOW\nGROUP ${g}`, bg: st.focus === g ? '#d97706' : '#155e75', fg: '#ffffff' };
    });
    rows[3][2] = { action: 'back', text: st.focus ? `GROUP ${st.focus}\\nBACK` : 'GROUP\\nBACK', bg: st.focus ? '#0f766e' : '#3f3f46', fg: st.focus ? '#ffffff' : '#a1a1aa' };
    rows[2][5] = { action: 'overview', text: st.overview ? 'ALL GROUPS\\nON' : 'ALL GROUPS', bg: st.overview ? '#4c1d95' : '#3f3f46', fg: '#ffffff' };
    rows[2][6] = { action: 'clear', text: 'CLEAR\\nCENTRE', bg: '#3f3f46', fg: '#ffffff' };
    rows[2][7] = { action: 'undo', text: 'UNDO', bg: '#7c2d12', fg: '#ffffff' };
    // manual steps, locked: a key that does nothing now is dark, the next step keeps its colours
    for (const row of rows) for (const [c, k] of row.entries()) {
      if (k && k.text && !this.allowed(k.action)) row[c] = { ...k, bg: '#18181b', fg: '#52525b' };
    }
    return rows;
  }

  private sent = new Map<string, string>();
  private status: { at: string; sent: number; error: string | null } | null = null;
  companionStatus() { return this.status; }
  /** Key texts and colours into Companion (its style API), like Show control does for its pages. */
  async pushLabels(force = false) {
    const url = getLtConfig(this.ctx.db).companionUrl;
    if (!url || !getShowConfig(this.ctx.db).labels) return this.status;
    if (force) this.sent.clear();
    const page = this.config.companionPage;
    let sent = 0, error: string | null = null;
    try {
      for (const [r, row] of this.keys().entries()) for (const [c, k] of row.entries()) {
        if (!k) continue;
        const id = `${page}/${r}/${c}`;
        const q = `text=${encodeURIComponent(k.text)}&bgcolor=${encodeURIComponent(k.bg)}&color=${encodeURIComponent(k.fg)}&size=auto`;
        if (this.sent.get(id) === q) continue;
        const res = await this.fetcher(`${url}/api/location/${id}/style?${q}`, { method: 'POST', signal: AbortSignal.timeout(3000) });
        if (!res.ok) { error = `Companion answered ${res.status} for ${id}`; break; }
        this.sent.set(id, q); sent++;
      }
    } catch (e: any) { error = String(e?.message ?? e); this.log(`Draw keys: ${error}`); }
    this.status = { at: new Date().toISOString(), sent, error };
    return this.status;
  }

  /** The DRAW page as a Companion page export: every key calls /api/draw/do?a=…; HOME goes to deck 1. */
  companionPage(base: string) {
    const b = base.replace(/\/+$/, '');
    const page = this.config.companionPage;
    const controls: Record<number, Record<number, unknown>> = {};
    this.keys().forEach((row, r) => row.forEach((k, c) => {
      if (!k) return;
      (controls[r] ??= {})[c] = control(k.text, hex(k.bg), [http(`d${r}${c}`, `${b}/api/draw/do?a=${encodeURIComponent(k.action)}`)], hex(k.fg));
    }));
    (controls[3] ??= {})[0] = control('DECK 1\\nHOME', 0x3f3f46, [setPage('dhome', 1)]);
    // no RESET key: one press would wipe the draw; it is only in the dashboard (with a confirmation)
    return {
      version: 12, type: 'page', companionBuild: '5.1.2',
      page: { name: 'SSL DRAW', controls, gridSize: { minColumn: 0, maxColumn: 7, minRow: 0, maxRow: 3 } },
      instances: { [CONN]: CONN_DEF },
      connectionCollections: [],
      oldPageNumber: page,
    };
  }
}

/**
 * A team's gradient as CSS (the PNG generator's variant 1, as on the matchboard's highlighted rows): the one set in
 * the generator, else the built-in SSL26 one, else the national colours.
 */
export function teamGradient(db: AssetCtx['db'], code: string, g: { angle: number; stops: { pos: number; color: string; opacity: number }[] } | null): string {
  const rgba = (c: string, o: number) => { const n = parseInt(c.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${o / 100})`; };
  if (g?.stops?.length) return `linear-gradient(${90 + g.angle}deg, ${[...g.stops].sort((a, b) => a.pos - b.pos).map((s) => `${rgba(s.color, s.opacity)} ${s.pos}%`).join(', ')})`;
  const built = TEAM_GRADIENTS_SSL26[code.toUpperCase()];
  if (built) return `linear-gradient(70deg, ${built.map(([pos, c]) => `${c} ${pos}%`).join(', ')})`;
  const cs = nationColours(db, code);
  if (cs.length >= 2) return `linear-gradient(70deg, ${cs.map((c, i) => `${c} ${Math.round((i / (cs.length - 1)) * 100)}%`).join(', ')})`;
  return 'linear-gradient(70deg, #1e3a8a, #0ea5e9)';
}

/** Places in each group counted again after a pick is taken away (A1, A2… stay without gaps). */
function renumber(picks: DrawPick[], board: BoardGroup[]): DrawPick[] {
  const n: Record<string, number> = {};
  return picks.map((p) => { const k = (n[p.group] = (n[p.group] ?? 0) + 1); const g = board.find((x) => x.letter === p.group); return { ...p, place: (g && drawPlaces(g)[k - 1]) || k }; });
}

const STEP_NAME: Record<DrawStep | 'none', string> = { focus: '1 (group to the centre)', team: '2 (the team drawn)', reveal: '3 (FLAG OFF)', back: '4 (group back)', none: 'none: the draw is over' };

// Companion 5.1 button pieces (as in show.ts; kept here so the DRAW page does not depend on the show preset)
const hex = (c: string) => parseInt(c.replace('#', ''), 16) || 0;
const v = <T>(value: T) => ({ value, isExpression: false });
const CONN = 'ssl_dashboard_show';
const CONN_DEF = { moduleInstanceType: 'connection', moduleId: 'generic-http', moduleVersionId: '3.2.0', sortOrder: 0, label: 'ssl_dashboard_show', isFirstInit: false, config: { prefix: '', proxyAddress: '', rejectUnauthorized: true, insecureHTTPParser: false, authType: 'none' }, secrets: {}, lastUpgradeIndex: 3, enabled: true };
const http = (id: string, url: string) => ({ type: 'action', id, definitionId: 'get', connectionId: CONN, options: { url: v(url), header: v('') }, upgradeIndex: 3 });
const setPage = (id: string, page: number) => ({ type: 'action', id, definitionId: 'set_page', connectionId: 'internal', options: { page: v(page), surfaceId: v('self') }, children: {} });
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
