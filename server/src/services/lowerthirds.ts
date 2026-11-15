import { teamKeyColours, teamKeyLook } from './nationColours.js';
import { z } from 'zod';
import { activeEvent, getSetting, setSetting } from '../db/db.js';
import { AssetCtx } from './assets.js';
import { badRequest, notFound } from './errors.js';
import { LINEUP_SLOTS, loadLineup, slotDefs } from './lineups.js';
import { listSailors } from './sailors.js';
import { TEAM_SLOTS } from './slots.js';
import { listTeams } from './teams.js';
import { findInput, parseVmixXml, VmixInput, vmixUrl } from './vmixResults.js';
import { keyOf, LtRole, ltRoles, ltTitleInfo, teamPictureFor } from './ltTitle.js';
import { stageTeamIds } from './workbookSheets.js';

/**
 * Lower thirds driven from a Stream Deck (Bitfocus Companion) or the dashboard's own keys.
 *
 * One GT title (lowerthird_photo.gtzip / lowerthird_no_photo.gtzip) serves teams and sailors:
 *  - team:   Top text = country, Bottom text = nickname
 *  - sailor: Top text = first + LAST name, Bottom text = number and position, then the best results in turn
 * Bar, Flag, Emblem and PHOTO are images. The dashboard sets the fields through the vMix Web API.
 * When the title is already on air it only changes the fields that differ, so the title's DataChange
 * animations play and the graphic stays up; otherwise it fills the title and brings it in on the overlay.
 */

export const ltConfigSchema = z.object({
  /** vMix input (name or number) of the lower third with a photo */
  photoInput: z.string().max(120),
  /** vMix input of the lower third without a photo: teams, and sailors without a photo */
  noPhotoInput: z.string().max(120),
  overlay: z.number().int().min(1).max(4),
  /** team graphic place used for the Bar field */
  barSlot: z.string().max(40),
  flagSlot: z.string().max(40),
  emblemSlot: z.string().max(40),
  /** teams whose team lower third and Qualified take the Emblem light PNG whatever the Emblem place is (MEX) */
  emblemLightTeams: z.array(z.string().max(10)).max(40),
  /** a country key also puts that team's lower third on air (otherwise it only picks the team) */
  countryShowsTeam: z.boolean(),
  /** Companion address for the key labels, e.g. http://127.0.0.1:8000 ('' = do not send labels) */
  companionUrl: z.string().max(200),
  companionPage: z.number().int().min(1).max(99),
  rows: z.number().int().min(1).max(8),
  cols: z.number().int().min(1).max(8),
  fields: z.object({ top: z.string().max(60), bottom: z.string().max(60), photo: z.string().max(60), flag: z.string().max(60), emblem: z.string().max(60), bar: z.string().max(60) }),
});
export type LtConfig = z.infer<typeof ltConfigSchema>;

export const DEFAULT_LT: LtConfig = {
  photoInput: 'lowerthird_photo', noPhotoInput: 'lowerthird_no_photo', overlay: 1,
  barSlot: 'lowerthird_photo', flagSlot: 'flag_big', emblemSlot: 'emblem_light', emblemLightTeams: ['MEX'], countryShowsTeam: false,
  companionUrl: '', companionPage: 1, rows: 4, cols: 8,
  fields: { top: 'Top text', bottom: 'Bottom text', photo: 'PHOTO', flag: 'Flag', emblem: 'Emblem', bar: 'Bar' },
};

const CONFIG_KEY = 'lt.config';
const LAYER1_KEY = 'lt.config.layer1';
export function getLtConfig(db: AssetCtx['db']): LtConfig {
  try {
    const saved = JSON.parse(getSetting(db, CONFIG_KEY) || '{}');
    return ltConfigSchema.parse({ ...DEFAULT_LT, ...saved, fields: { ...DEFAULT_LT.fields, ...(saved.fields ?? {}) } });
  } catch { return DEFAULT_LT; }
}
/** Every graphic is on OV1 now (only the break scene keeps OV4): lower thirds saved on another overlay move over, once. */
export function moveLtToLayer1(db: AssetCtx['db']) {
  if (getSetting(db, LAYER1_KEY)) return;
  setSetting(db, LAYER1_KEY, '1');
  try {
    const saved = JSON.parse(getSetting(db, CONFIG_KEY) || '{}');
    if (saved.overlay && saved.overlay !== 1) setSetting(db, CONFIG_KEY, JSON.stringify({ ...saved, overlay: 1 }));
  } catch { /* nothing saved */ }
}
export function setLtConfig(db: AssetCtx['db'], patch: Partial<LtConfig>) {
  const cur = getLtConfig(db);
  const next = ltConfigSchema.parse({ ...cur, ...patch, fields: { ...cur.fields, ...(patch.fields ?? {}) } });
  if (!TEAM_SLOTS.some((s) => s.key === next.barSlot)) throw badRequest('Unknown team graphic for the bar.');
  next.companionUrl = next.companionUrl.trim().replace(/\/+$/, '');
  if (next.companionUrl && !/^https?:\/\/[^\s/]+(:\d+)?$/i.test(next.companionUrl)) throw badRequest('Companion address must look like http://127.0.0.1:8000');
  setSetting(db, CONFIG_KEY, JSON.stringify(next));
  return next;
}

// ---------- what is shown ----------
type Asset = { vmixPath: string | null; storedPath: string | null; enteredPath: string | null } | undefined | null;
const img = (a: Asset) => (a ? a.vmixPath ?? a.storedPath ?? a.enteredPath ?? '' : '');

export interface LtTeam { id: string; code: string; name: string }
/** Teams with keys: the current stage's teams in stage order, else every team by code. */
export function ltTeams(ctx: AssetCtx): LtTeam[] {
  const all = listTeams(ctx);
  const ids = stageTeamIds(ctx.db, activeEvent(ctx.db).id);
  const list = ids ? ids.map((id) => all.find((t) => t.id === id)).filter((t): t is (typeof all)[number] => !!t)
    : [...all].sort((a, b) => a.code.localeCompare(b.code));
  return list.map((t) => ({ id: t.id, code: t.code, name: t.name }));
}

export interface LtSailor { slot: string; label: string; sailorId: string | null; firstName: string; lastName: string; number: string; position: string; photo: string; best: string[] }

/** Who sails on each place of the team's line-up today, with photo and best results. */
export function crewOf(ctx: AssetCtx, teamId: string): LtSailor[] {
  const lineup = loadLineup(ctx.db, activeEvent(ctx.db).id, teamId).data;
  const sailors = new Map(listSailors(ctx, teamId).map((s) => [s.id, s]));
  // every place of the team's line-up, extra places (Sailor10…) included
  return slotDefs(lineup.extra).map((d) => {
    const r = lineup.rows.find((x) => x.slot === d.key);
    const s = r?.sailorId ? sailors.get(r.sailorId) : undefined;
    return {
      slot: d.key, label: d.label, sailorId: r?.sailorId ?? null,
      firstName: r?.firstName || s?.firstName || '', lastName: r?.lastName || s?.lastName || '',
      number: r?.number || s?.defaultNumber || '', position: r?.position || d.position,
      photo: img(s?.photo), best: [s?.bestResult1, s?.bestResult2, s?.bestResult3].map((b) => (b ?? '').trim()).filter(Boolean),
    };
  });
}

const fullName = (s: { firstName: string; lastName: string }) => [s.firstName.trim(), s.lastName.trim().toUpperCase()].filter(Boolean).join(' ');
/** The lines Bottom text cycles through for a sailor: number and position first (9 | MIDBOW, as the best results are typed), then each best result. */
export const sailorLines = (s: LtSailor) => [[s.number, s.position.toUpperCase()].filter(Boolean).join(' | '), ...s.best].filter(Boolean);

export interface LtState { kind: 'team' | 'sailor' | null; teamId: string | null; slot: string | null; line: number; onAir: boolean; input: string }
const STATE_KEY = 'lt.state';
export function getLtState(db: AssetCtx['db']): LtState {
  try { return { kind: null, teamId: null, slot: null, line: 0, onAir: false, input: '', ...JSON.parse(getSetting(db, STATE_KEY) || '{}') }; } catch { return { kind: null, teamId: null, slot: null, line: 0, onAir: false, input: '' }; }
}
const saveState = (db: AssetCtx['db'], s: LtState) => setSetting(db, STATE_KEY, JSON.stringify(s));

/** Field values for a team or a sailor, keyed by the title's field names (`Top text.Text`, `PHOTO.Source`…). */
export function ltFields(ctx: AssetCtx, cfg: LtConfig, teamId: string, sailor: LtSailor | null, line = 0): Map<string, string> {
  const team = listTeams(ctx).find((t) => t.id === teamId);
  if (!team) throw notFound('Team');
  const a = team.assets as Record<string, Asset>;
  const f = new Map<string, string>();
  f.set(`${cfg.fields.bar}.Source`, img(a[cfg.barSlot]));
  f.set(`${cfg.fields.flag}.Source`, img(a[cfg.flagSlot]));
  // a team on the light list (MEX): its team lower third and Qualified take the Emblem light PNG
  const light = !sailor && cfg.emblemLightTeams.some((c) => c.trim().toUpperCase() === team.code.toUpperCase());
  f.set(`${cfg.fields.emblem}.Source`, (light && img(a.emblem_light)) || img(a[cfg.emblemSlot]));
  if (sailor) {
    const lines = sailorLines(sailor);
    f.set(`${cfg.fields.top}.Text`, fullName(sailor));
    f.set(`${cfg.fields.bottom}.Text`, lines.length ? lines[line % lines.length] : '');
    f.set(`${cfg.fields.photo}.Source`, sailor.photo);
  } else {
    f.set(`${cfg.fields.top}.Text`, team.name.toUpperCase());
    f.set(`${cfg.fields.bottom}.Text`, (team.nickname || '').toUpperCase());
  }
  return f;
}

// ---------- vMix ----------
type Fetch = (url: string, init?: { signal?: AbortSignal; method?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** What was last sent to each input, so on air only the changed fields are set (each change animates). */
const sent = new Map<string, Map<string, string>>();

export class LowerThirds {
  private labels = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  constructor(readonly ctx: AssetCtx, private fetcher: Fetch = fetch as unknown as Fetch, private log: (m: string) => void = () => {}) { moveLtToLayer1(ctx.db); }

  get config() { return getLtConfig(this.ctx.db); }
  get state() { return getLtState(this.ctx.db); }

  private async vmix(q: string) {
    const base = vmixUrl(this.ctx.db);
    let res;
    try { res = await this.fetcher(`${base}/api/${q}`, { signal: AbortSignal.timeout(4000) }); }
    catch { throw badRequest(`vMix does not answer at ${base}. Turn on Settings → Web Controller in vMix and check the address in Settings here.`); }
    if (!res.ok) throw badRequest(`vMix answered ${res.status} for ${decodeURIComponent(q).slice(0, 80)}`);
    return res.text();
  }

  /** The input that is on the overlay channel now (vMix XML <overlay number="1">5</overlay>). */
  private static onOverlay(xml: string, overlay: number) {
    return xml.match(new RegExp(`<overlay number="${overlay}"[^>]*>(\\d+)</overlay>`))?.[1] ?? '';
  }

  /** OverlayOut waiting for the photo to fly out (out()); a new show on that title cancels it. */
  private pendingOut: NodeJS.Timeout | null = null;

  /** The title's photo field when the title animates it on a data change (vMix plays that, not a Fly in Transition In). */
  private photoMove(input: VmixInput) {
    const field = ltRoles(this.config.fields, input.fields).photo;
    if (!field) return null;
    const info = ltTitleInfo(this.ctx.assetsDir, input.title, listTeams(this.ctx).map((t) => t.code));
    // a title the dashboard cannot find (loaded in vMix from elsewhere): as the generator makes it (0.35 s out, 0.5 s in)
    const anim = info ? info.changes[field.toLowerCase()] : { out: 0.35, in: 0.5 };
    return anim ? { field, ...anim } : null;
  }

  private set(id: string, name: string, value: string) {
    return this.vmix(`?Function=${name.endsWith('.Source') ? 'SetImage' : 'SetText'}&Input=${encodeURIComponent(id)}&SelectedName=${encodeURIComponent(name)}&Value=${encodeURIComponent(value)}`);
  }

  private async show(inputName: string, fields: Map<string, string>, next: Omit<LtState, 'onAir' | 'input'>) {
    const cfg = this.config;
    if (!inputName.trim()) throw badRequest('Set the vMix inputs of the lower thirds in Show control → Lower thirds.');
    if (this.pendingOut) { clearTimeout(this.pendingOut); this.pendingOut = null; await this.vmix(`?Function=OverlayInput${cfg.overlay}Out`); }
    const xml = await this.vmix('');
    const all = parseVmixXml(xml);
    const input: VmixInput | undefined = findInput(all, inputName);
    if (!input) throw badRequest(`vMix has no input “${inputName}”. Add the lower third GTZIP to vMix or fix the name in Show control → Lower thirds.`);
    const onAir = LowerThirds.onOverlay(xml, cfg.overlay) === input.number;
    fields = this.fitToTitle(input, fields, next.teamId);
    const has = new Set(input.fields);
    const id = input.key || input.number;
    this.cancelClear(id); // its photo is still in: emptied below, before it comes in
    const last = sent.get(id) ?? new Map<string, string>();
    const held = (name: string) => input.values?.[name] ?? last.get(name) ?? '';
    // vMix leaves a Fly on the photo in Transition In out (the photo only fades in with the title), but plays the
    // photo's DataChange: the title comes in with no photo and the photo is set right after, so it rises from the
    // bottom once its DataChange Out (of the empty picture) has run, a moment after the bar
    const move = onAir ? null : this.photoMove(input);
    const late = move && has.has(move.field) ? move.field : null;
    let changed = 0;
    for (const [name, value] of fields) {
      if (!has.has(name) || name === late) continue;
      if (held(name) === value) continue; // unchanged: no animation
      await this.set(id, name, value);
      last.set(name, value);
      changed++;
    }
    if (late && held(late)) {
      // a photo left in the title (another program, an older version): clear it and let its fly-out end off air
      await this.set(id, late, '');
      last.set(late, '');
      await new Promise((r) => setTimeout(r, Math.min(move!.out + move!.in, 3) * 1000 + 100));
    }
    sent.set(id, last);
    if (!onAir) {
      const before = LowerThirds.onOverlay(xml, cfg.overlay);
      await this.vmix(`?Function=OverlayInput${cfg.overlay}In&Input=${encodeURIComponent(id)}`);
      // the other lower third title it replaced (photo ⇄ no photo): its photo goes once it is off air
      const prev = before ? all.find((i) => i.number === before) : undefined;
      if (prev && prev !== input && [cfg.photoInput, cfg.noPhotoInput].some((x) => x && findInput([prev], x))) this.clearPhotoOffAir(prev);
    }
    const photo = late ? fields.get(late) ?? '' : '';
    if (late && photo) { await this.set(id, late, photo); last.set(late, photo); changed++; }
    const state: LtState = { ...next, onAir: true, input: input.title };
    saveState(this.ctx.db, state);
    void this.pushLabels();
    return { ...state, changed, cameIn: !onAir };
  }

  /**
   * The values (keyed by the field names on the Lower thirds tab) moved onto the fields this title really has
   * (Name, position/pb…), and the bar picture swapped for the team's PNG made like the title's own (ltTitle.ts).
   */
  /**
   * The team's bar of the lower thirds: the generator's <CODE>_lowerthird.png, else the bar the team's lower third
   * title (photo / no photo) takes. Other titles with a bar (Team LT qualified) use it too, so every belt looks the same.
   */
  standardBar(teamId: string): string | null {
    const cfg = this.config;
    const teams = listTeams(this.ctx);
    const team = teams.find((t) => t.id === teamId);
    if (!team) return null;
    const own = teamPictureFor(this.ctx, team, { w: 1, h: 1, key: keyOf('lowerthird', []), exact: true });
    if (own) return own;
    for (const title of [cfg.noPhotoInput, cfg.photoInput]) {
      const info = title ? ltTitleInfo(this.ctx.assetsDir, title, teams.map((t) => t.code)) : null;
      const pic = teamPictureFor(this.ctx, team, info?.images[cfg.fields.bar.toLowerCase()]);
      if (pic) return pic;
    }
    return null;
  }

  fitToTitle(input: VmixInput, fields: Map<string, string>, teamId: string | null) {
    const cfg = this.config;
    const roles = ltRoles(cfg.fields, input.fields);
    const out = new Map<string, string>();
    const suffix: Record<LtRole, string> = { top: '.Text', bottom: '.Text', photo: '.Source', flag: '.Source', emblem: '.Source', bar: '.Source' };
    for (const role of Object.keys(suffix) as LtRole[]) {
      const v = fields.get(`${cfg.fields[role]}${suffix[role]}`);
      const f = roles[role];
      if (v !== undefined && f) out.set(f, v);
    }
    const team = teamId ? listTeams(this.ctx).find((t) => t.id === teamId) : undefined;
    if (team && roles.bar) {
      const info = ltTitleInfo(this.ctx.assetsDir, input.title, listTeams(this.ctx).map((t) => t.code));
      const pic = teamPictureFor(this.ctx, team, info?.images[roles.bar.replace(/\.Source$/i, '').toLowerCase()]);
      if (pic) out.set(roles.bar, pic);
    }
    return out;
  }

  private teamByCode(code: string) {
    const t = listTeams(this.ctx).find((x) => x.code.toLowerCase() === code.trim().toLowerCase() || x.id === code);
    if (!t) throw notFound(`Team ${code}`);
    return t;
  }

  /** Pick a team (country key). Puts its lower third on air when the settings say so. */
  async pickTeam(code: string) {
    const t = this.teamByCode(code);
    const cfg = this.config;
    if (cfg.countryShowsTeam) return this.showTeam(t.code);
    saveState(this.ctx.db, { ...this.state, teamId: t.id });
    void this.pushLabels();
    return this.state;
  }

  async showTeam(code: string) {
    const t = this.teamByCode(code);
    const cfg = this.config;
    return this.show(cfg.noPhotoInput || cfg.photoInput, ltFields(this.ctx, cfg, t.id, null), { kind: 'team', teamId: t.id, slot: null, line: 0 });
  }

  /** The sailor on a place of the line-up (`Pit`, `Trimmer1`…, or the place's label/position, any case). */
  async showSailor(code: string | null, place: string, opts: { forceNoPhoto?: boolean } = {}) {
    const teamId = code ? this.teamByCode(code).id : this.state.teamId;
    if (!teamId) throw badRequest('Pick a country first.');
    const raw = place.trim().toLowerCase().replace(/\s+/g, ' ');
    const p = raw.replace(/ /g, '');
    const crew = crewOf(this.ctx, teamId);
    const bare = (x: string) => x.toLowerCase().replace(/\s+/g, '');
    // exact matches first: Trimmer 2 is stored as `Trimmer1`, which is also Trimmer 1's label without spaces
    const s = crew.find((x) => x.slot.toLowerCase() === raw)
      ?? crew.find((x) => x.label.toLowerCase() === raw)
      ?? crew.find((x) => x.slot.toLowerCase() === p)
      ?? crew.find((x) => bare(x.label) === p)
      ?? (/^\d+$/.test(p) ? crew[Number(p) - 1] : undefined);
    if (!s) throw notFound(`Place ${place}`);
    if (!s.firstName && !s.lastName) throw badRequest(`Nobody on ${s.label} in this team's line-up.`);
    const cfg = this.config;
    const input = s.photo && cfg.photoInput && !opts.forceNoPhoto ? cfg.photoInput : cfg.noPhotoInput || cfg.photoInput;
    return this.show(input, ltFields(this.ctx, cfg, teamId, s, 0), { kind: 'sailor', teamId, slot: s.slot, line: 0 });
  }

  /** Next line under the sailor's name: position → best result 1 → 2 → 3 → position, only that field changes. */
  async nextLine() {
    const st = this.state;
    if (st.kind !== 'sailor' || !st.teamId || !st.slot) throw badRequest('Show a sailor first.');
    const s = crewOf(this.ctx, st.teamId).find((x) => x.slot === st.slot);
    if (!s) throw badRequest('Show a sailor first.');
    const lines = sailorLines(s);
    const line = lines.length ? (st.line + 1) % lines.length : 0;
    const cfg = this.config;
    // stay on the title that is on air, so only the line changes
    const input = st.onAir && st.input && [cfg.photoInput, cfg.noPhotoInput].includes(st.input) ? st.input
      : s.photo && cfg.photoInput ? cfg.photoInput : cfg.noPhotoInput || cfg.photoInput;
    return this.show(input, ltFields(this.ctx, cfg, st.teamId, s, line), { kind: 'sailor', teamId: st.teamId, slot: s.slot, line });
  }

  private clears = new Map<string, NodeJS.Timeout>();
  private cancelClear(id: string) {
    const t = this.clears.get(id);
    if (t) { clearTimeout(t); this.clears.delete(id); }
  }

  /**
   * A lower third title that left the screen (another graphic took OV1, OUT of the show, ALL OUT): its photo is
   * emptied once the title is off air, so the next sailor on it comes in at once instead of waiting for that photo
   * to fly away first.
   */
  clearPhotoOffAir(input: VmixInput, afterMs = 1500) {
    const move = this.photoMove(input);
    const id = input.key || input.number;
    if (!move || !(input.values?.[move.field] ?? sent.get(id)?.get(move.field))) return;
    this.cancelClear(id);
    this.clears.set(id, setTimeout(() => {
      this.clears.delete(id);
      this.set(id, move.field, '').then(() => {
        const last = sent.get(id) ?? new Map<string, string>();
        last.set(move.field, '');
        sent.set(id, last);
      }).catch((e) => this.log(`Lower third photo not emptied: ${e?.message ?? e}`));
    }, afterMs));
  }

  async out() {
    const cfg = this.config;
    if (this.pendingOut) { clearTimeout(this.pendingOut); this.pendingOut = null; }
    // the photo flies down first (its DataChange, which vMix plays), then the title goes out; the key does not wait
    const xml = await this.vmix('');
    const onOverlay = LowerThirds.onOverlay(xml, cfg.overlay);
    const input = onOverlay ? parseVmixXml(xml).find((i) => i.number === onOverlay) : undefined;
    const move = input ? this.photoMove(input) : null;
    const id = input ? input.key || input.number : '';
    if (input && move && (input.values?.[move.field] ?? sent.get(id)?.get(move.field))) {
      await this.set(id, move.field, '');
      sent.get(id)?.set(move.field, '');
      this.pendingOut = setTimeout(() => {
        this.pendingOut = null;
        this.vmix(`?Function=OverlayInput${cfg.overlay}Out`).catch((e) => this.log(`Lower third not taken out: ${e?.message ?? e}`));
      }, Math.min(move.out, 2) * 1000);
    } else await this.vmix(`?Function=OverlayInput${cfg.overlay}Out`);
    const st = { ...this.state, onAir: false };
    saveState(this.ctx.db, st);
    void this.pushLabels();
    return st;
  }

  // ---------- keys ----------
  /** The key layout: countries, then the line-up places, then TEAM / NEXT / OUT; a new group starts on a new row. */
  layout(): LtKey[][] {
    const cfg = this.config;
    const st = this.state;
    const teams = ltTeams(this.ctx);
    const team = teams.find((t) => t.id === st.teamId) ?? null;
    const crew = team ? crewOf(this.ctx, team.id) : [];
    const groups: LtKey[][] = [
      teams.map((t) => ({ action: `team:${t.code}`, text: t.code, team: t.code, active: t.id === st.teamId, onAir: st.onAir && st.kind === 'team' && st.teamId === t.id })),
      LINEUP_SLOTS.map((d) => {
        const s = crew.find((x) => x.slot === d.key);
        return { action: `place:${d.key}`, text: `${d.label.toUpperCase()}\\n${s?.lastName ? `${s.number ? `#${s.number} ` : ''}${s.lastName.toUpperCase()}` : '—'}`, team: team?.code, active: false, onAir: st.onAir && st.kind === 'sailor' && st.slot === d.key };
      }),
      [
        { action: 'showteam', text: team ? `TEAM\\n${team.code}` : 'TEAM', team: team?.code, active: false, onAir: !!team && st.onAir && st.kind === 'team' && st.teamId === team.id },
        { action: 'next', text: 'NEXT\\nRESULT', active: false, onAir: false },
        { action: 'out', text: 'OUT', active: false, onAir: st.onAir },
      ],
    ];
    // lay the groups out on pages of rows × cols
    const pages: LtKey[][] = [];
    let page: LtKey[] = [], row = 0, col = 0;
    const flushPage = () => { pages.push(page); page = []; row = 0; col = 0; };
    for (const g of groups) {
      if (col > 0) { row++; col = 0; }
      if (row >= cfg.rows) flushPage();
      for (const k of g) {
        if (col >= cfg.cols) { row++; col = 0; }
        if (row >= cfg.rows) flushPage();
        page.push({ ...k, ...ltKeyStyle(this.ctx.db, k), page: cfg.companionPage + pages.length, row, col });
        col++;
      }
    }
    if (page.length) pages.push(page);
    return pages;
  }

  async press(page: number, row: number, col: number) {
    const key = this.layout().flat().find((k) => k.page === page && k.row === row && k.col === col);
    if (!key) return { ok: true, nothing: true };
    return this.run(key.action);
  }

  async run(action: string) {
    const [kind, arg] = action.split(':');
    if (kind === 'team') return this.pickTeam(arg);
    if (kind === 'place') return this.showSailor(null, arg);
    if (kind === 'showteam') { const id = this.state.teamId; if (!id) throw badRequest('Pick a country first.'); return this.showTeam(listTeams(this.ctx).find((t) => t.id === id)!.code); }
    if (kind === 'next') return this.nextLine();
    if (kind === 'out') return this.out();
    throw badRequest(`Unknown key action ${action}`);
  }

  /**
   * Writes the key texts and colours into Companion (HTTP remote control: POST /api/location/page/row/col/style),
   * only for keys that changed since the last time.
   */
  /** Keys show no on-air feedback: nothing is pushed to Companion. */
  async pushLabels(_force = false) { return { sent: 0 }; }

  /** Keeps the labels in step with line-up changes made elsewhere. */
  start(ms = 15000) { this.timer = setInterval(() => { void this.pushLabels(); }, ms); this.timer.unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); }
}

/**
 * Colours of a key: country and place keys in the team's national colours (selected ▶ and on air ● in its colours too),
 * the others grey with red when on air and amber when selected. `label` is the text with the marker.
 */
export function ltKeyStyle(db: AssetCtx['db'] | null, k: LtKey): { bg: string; fg: string; label: string; baseBg: string; baseFg: string } {
  const nation = k.team ? teamKeyColours(db, k.team) : null;
  if (nation) {
    const l = teamKeyLook(nation, k.text, k);
    return { bg: l.bg, fg: l.fg, label: l.text, baseBg: nation.normal.bg, baseFg: nation.normal.fg };
  }
  const bg = keyColour(k), base = keyColour({ ...k, active: false, onAir: false });
  return { bg, fg: k.active && !k.onAir ? '#000000' : '#ffffff', label: k.onAir ? `● ${k.text}` : k.active ? `▶ ${k.text}` : k.text, baseBg: base, baseFg: '#ffffff' };
}

export const keyColour = (k: LtKey) => k.onAir ? '#dc2626' : k.active ? '#f59e0b' : k.action.startsWith('team:') ? '#1e3a5f' : k.action.startsWith('place:') ? '#27303f' : '#3f3f46';

/** The dashboard URL a key calls; it names the action itself, so the key keeps working wherever it sits in Companion. */
export function keyUrl(base: string, action: string) {
  const [kind, arg] = action.split(':');
  const b = base.replace(/\/+$/, '');
  if (kind === 'team') return `${b}/api/lt/pick?team=${encodeURIComponent(arg)}`;
  if (kind === 'place') return `${b}/api/lt/sailor?place=${encodeURIComponent(arg)}`;
  if (kind === 'showteam') return `${b}/api/lt/showteam`;
  return `${b}/api/lt/${kind}`;
}

/**
 * One Companion page export (.companionconfig, export format 4 from Companion 3.2, which every later
 * Companion upgrades on import): a Generic HTTP connection and every key of that page with its GET.
 */
export function companionPageExport(keys: LtKey[], base: string, cfg: LtConfig, pageIndex: number) {
  const conn = 'ssl_dashboard_lt';
  const controls: Record<number, Record<number, unknown>> = {};
  keys.forEach((k, i) => {
    (controls[k.row!] ??= {})[k.col!] = {
      type: 'button',
      style: {
        text: k.text, size: 'auto', png64: null, alignment: 'center:center', pngalignment: 'center:center',
        color: parseInt((k.baseFg ?? '#ffffff').slice(1), 16), bgcolor: parseInt((k.baseBg ?? keyColour({ ...k, active: false, onAir: false })).slice(1), 16), show_topbar: 'default',
      },
      options: { relativeDelay: false, rotaryActions: false, stepAutoProgress: true },
      feedbacks: [],
      steps: {
        0: {
          action_sets: { down: [{ id: `lt${pageIndex}_${i}`, action: 'get', instance: conn, options: { url: keyUrl(base, k.action), header: '' }, delay: 0 }], up: [] },
          options: { runWhileHeld: [] },
        },
      },
    };
  });
  return {
    version: 4,
    type: 'page',
    page: { name: `Lower thirds ${pageIndex + 1}`, controls, gridSize: { minColumn: 0, maxColumn: cfg.cols - 1, minRow: 0, maxRow: cfg.rows - 1 } },
    instances: {
      [conn]: {
        instance_type: 'generic-http', label: 'ssl_dashboard_lt', enabled: true, isFirstInit: false, lastUpgradeIndex: -1, sortOrder: 0,
        config: { prefix: '', proxyAddress: '', rejectUnauthorized: true },
      },
    },
    oldPageNumber: cfg.companionPage + pageIndex,
  };
}

export interface LtKey { action: string; text: string; active: boolean; onAir: boolean; page?: number; row?: number; col?: number; /** the team whose national colours the key takes */ team?: string; bg?: string; fg?: string; label?: string; baseBg?: string; baseFg?: string }
