import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { activeEvent, getSetting, setSetting } from '../db/db.js';
import { AssetCtx, listAssets } from './assets.js';
import { badRequest } from './errors.js';
import { listTeams } from './teams.js';
import { listSets } from './fleets.js';
import { starredForSet } from './stages.js';
import { getLtConfig } from './lowerthirds.js';
import { getShowConfig } from './show.js';
import { fixturesDir } from './matchboard/matchboard.js';

/**
 * DRAW: the stage screen of the official draw (1/32 Finals). Teams are drawn one by one from a pool, then each gets
 * a group (A–D) drawn from the groups' pool. The operator presses what was drawn on stage (dashboard or Stream Deck),
 * the output page (/draw/output, a vMix Browser input) animates it. All state is one settings entry.
 */
export const DRAW_GROUPS = ['A', 'B', 'C', 'D'] as const;
export const DRAW_GROUP_SIZE = 4;
export const DRAW_POOL_MAX = 16;
export const DRAW_INPUT = 'ssl_draw';

export const drawConfigSchema = z.object({
  /** a short caption in the centre when nothing is being drawn (the header picture has the event title) */
  caption: z.string().max(80),
  /** team ids in the order of the left strip */
  pool: z.array(z.string()).max(DRAW_POOL_MAX),
  /** Companion page the DRAW keys are on */
  companionPage: z.number().int().min(1).max(99),
  /** seconds the drawn team stays in the centre before it flies to its group */
  flightDelay: z.number().min(0).max(10),
});
export type DrawConfig = z.infer<typeof drawConfigSchema>;

export interface DrawPick { teamId: string; group: string; place: number }
export interface DrawState {
  picks: DrawPick[];
  /** the team just drawn; with a group once its group is drawn too (until the next team) */
  current: { teamId: string; group: string | null } | null;
  /** the centre shows all groups instead of the current step */
  overview: boolean;
  /** goes up with every change: the output page animates what changed */
  seq: number;
}

const CFG = 'draw.config';
const STATE = 'draw.state';
const DEFAULT_CFG: DrawConfig = { caption: '1/32 FINALS · OFFICIAL DRAW', pool: [], companionPage: 30, flightDelay: 1.6 };
const EMPTY: DrawState = { picks: [], current: null, overview: false, seq: 0 };

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
      saveState(this.ctx.db, { ...st, picks: renumber(st.picks.filter((p) => inPool.has(p.teamId))), current: st.current && inPool.has(st.current.teamId) ? st.current : null });
    } else saveState(this.ctx.db, st); // the output shows the new pool / caption
    void this.pushLabels();
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

  /** The teams starred through to the 1/32 Finals on the matchboard (the stage named so, else the latest stage). */
  qualified(): string[] {
    const ev = activeEvent(this.ctx.db).id;
    const sets = listSets(this.ctx.db, ev) as { id: string; name: string }[];
    const set = sets.find((s) => /^1\s*\/\s*32/.test(s.name)) ?? sets[sets.length - 1];
    if (!set) return [];
    return starredForSet(this.ctx.db, set.id).map((s) => s.teamId);
  }

  /** What the output page needs (no ids of assets: the flags come through /api/draw/output/flag/<team id>). */
  output() {
    const cfg = this.config, st = this.state;
    const teams = this.poolTeams().map((t) => ({ id: t.id, code: t.code, name: t.name, flag: t.flagAsset ? `/api/draw/output/flag/${t.id}` : null }));
    return { seq: st.seq, caption: cfg.caption, flightDelay: cfg.flightDelay, groups: DRAW_GROUPS, groupSize: DRAW_GROUP_SIZE, teams, picks: st.picks, current: st.current, overview: st.overview };
  }
  flagFile(teamId: string) {
    const t = this.allTeams().find((x) => x.id === teamId);
    return t?.flagAsset ?? null;
  }

  /** Something the output shows changed outside the steps (header picture): it reloads. */
  touch() { return saveState(this.ctx.db, this.state); }

  view() { return { config: this.config, state: this.state, teams: this.allTeams(), pool: this.poolTeams(), groups: DRAW_GROUPS, groupSize: DRAW_GROUP_SIZE, input: DRAW_INPUT }; }

  /**
   * One step of the draw. team:<n> (1–16, place in the pool) or team:<CODE>, group:<A–D>, undo, clear, overview
   * (on/off), overview:on|off, reset.
   */
  run(a: string) {
    const [verb, arg = ''] = a.split(':');
    const st = this.state;
    const pool = this.poolTeams();
    const placed = new Set(st.picks.map((p) => p.teamId));
    const groupCount = (g: string) => st.picks.filter((p) => p.group === g).length;
    let next: Omit<DrawState, 'seq'> = st;
    switch (verb) {
      case 'team': {
        const n = Number(arg);
        const t = Number.isInteger(n) && n >= 1 ? pool[n - 1] : pool.find((x) => x.code.toUpperCase() === arg.toUpperCase());
        if (!t) throw badRequest(`No team ${arg} in the draw pool.`);
        if (placed.has(t.id)) throw badRequest(`${t.code} already has its group.`);
        next = { ...st, current: { teamId: t.id, group: null }, overview: false };
        break;
      }
      case 'group': {
        const g = arg.toUpperCase();
        if (!(DRAW_GROUPS as readonly string[]).includes(g)) throw badRequest(`Group ${arg}? Use A–D.`);
        if (!st.current || st.current.group) throw badRequest('Draw a team first.');
        if (groupCount(g) >= DRAW_GROUP_SIZE) throw badRequest(`Group ${g} is full.`);
        const pick = { teamId: st.current.teamId, group: g, place: groupCount(g) + 1 };
        next = { ...st, picks: [...st.picks, pick], current: { teamId: st.current.teamId, group: g }, overview: false };
        break;
      }
      case 'undo': {
        if (st.current?.group) next = { ...st, picks: st.picks.slice(0, -1), current: { teamId: st.current.teamId, group: null } };
        else if (st.current) next = { ...st, current: null };
        else if (st.picks.length) { const last = st.picks[st.picks.length - 1]; next = { ...st, picks: st.picks.slice(0, -1), current: { teamId: last.teamId, group: null } }; }
        break;
      }
      case 'clear': next = { ...st, current: null }; break;
      case 'overview': next = { ...st, overview: arg === 'on' ? true : arg === 'off' ? false : !st.overview }; break;
      case 'reset': next = { ...EMPTY }; break;
      default: throw badRequest(`Unknown draw action ${a}`);
    }
    const saved = saveState(this.ctx.db, next);
    void this.pushLabels();
    return saved;
  }

  // ---------- Companion ----------
  /** The DRAW page's keys: [row][col] → action, text, colours (live look: drawn teams dark, the current one gold). */
  keys(): ({ action: string; text: string; bg: string; fg: string } | null)[][] {
    const st = this.state, pool = this.poolTeams();
    const done = new Map(st.picks.map((p) => [p.teamId, p]));
    const rows: ({ action: string; text: string; bg: string; fg: string } | null)[][] = [[], [], [], []];
    for (let i = 0; i < DRAW_POOL_MAX; i++) {
      const t = pool[i];
      const p = t && done.get(t.id);
      const cur = t && st.current?.teamId === t.id && !st.current.group;
      rows[Math.floor(i / 8)][i % 8] = !t ? { action: `team:${i + 1}`, text: '', bg: '#000000', fg: '#ffffff' }
        : { action: `team:${i + 1}`, text: p ? `${t.code}\\n→ ${p.group}` : t.code, bg: cur ? '#d97706' : p ? '#27272a' : '#1e3a5f', fg: p ? '#71717a' : '#ffffff' };
    }
    DRAW_GROUPS.forEach((g, i) => {
      const n = st.picks.filter((p) => p.group === g).length;
      const full = n >= DRAW_GROUP_SIZE;
      const just = st.current?.group === g;
      rows[2][i] = { action: `group:${g}`, text: `GROUP ${g}\\n${n}/${DRAW_GROUP_SIZE}`, bg: just ? '#d97706' : full ? '#27272a' : '#0f766e', fg: full ? '#71717a' : '#ffffff' };
    });
    rows[2][5] = { action: 'overview', text: st.overview ? 'ALL GROUPS\\nON' : 'ALL GROUPS', bg: st.overview ? '#4c1d95' : '#3f3f46', fg: '#ffffff' };
    rows[2][6] = { action: 'clear', text: 'CLEAR\\nCENTRE', bg: '#3f3f46', fg: '#ffffff' };
    rows[2][7] = { action: 'undo', text: 'UNDO', bg: '#7c2d12', fg: '#ffffff' };
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

/** Places in each group counted again after a pick is taken away (A1, A2… stay without gaps). */
function renumber(picks: DrawPick[]): DrawPick[] {
  const n: Record<string, number> = {};
  return picks.map((p) => ({ ...p, place: (n[p.group] = (n[p.group] ?? 0) + 1) }));
}

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
