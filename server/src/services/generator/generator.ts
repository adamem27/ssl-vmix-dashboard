import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DB, getSetting, newId, nowIso, setSetting } from '../../db/db.js';
import { badRequest, notFound } from '../errors.js';
import { encodePng } from '../png.js';
import { joinVmixPath } from '../paths.js';
import { DEFAULT_STROKE_GRADIENT, ElementSpec, Gradient, gradientVersions, gradientVersionsFrom, renderElement } from './render.js';

export const VARIANTS = [1, 2, 3] as const;
/** Generated files live in their own folder inside assets, so vmix-sync mirrors them to the vMix machine. */
export const GENERATED_DIR = 'PNG generator';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be #RRGGBB');
const pct = z.number().min(0).max(100);
export const gradientSchema = z.object({
  angle: z.number().min(-360).max(360),
  stops: z.array(z.object({ pos: pct, color: hex, opacity: pct })).min(2).max(8),
});
const templateFields = {
  name: z.string().trim().min(1).max(80),
  fileName: z.string().trim().min(1).max(80).regex(/^[\w.-]+$/, 'File name: letters, digits, - _ . only'),
  variant: z.number().int().min(1).max(3),
  width: z.number().int().min(1).max(4096),
  height: z.number().int().min(1).max(4096),
  radius: z.number().min(0).max(2048),
  opacity: pct,
  flip: z.boolean(),
  angleOffset: z.number().min(-360).max(360),
  strokeWidth: z.number().min(0).max(200),
  strokeColor: hex,
  strokeOpacity: pct,
  strokeGradient: z.boolean(),
  strokeAngle: z.number().min(-360).max(360),
  pattern: z.boolean(),
  patternOpacity: pct,
  patternScale: z.number().min(5).max(1000),
  enabled: z.boolean(),
};
/** Stored elements from before the gradient stroke get its defaults. */
export const templateSchema = z.object({ ...templateFields, strokeGradient: z.boolean().default(false), strokeAngle: templateFields.strokeAngle.default(-45) });
export const templatePatchSchema = z.object(templateFields).partial();
export type Template = z.infer<typeof templateSchema> & { id: string; sort: number };

export interface GenCtx { db: DB; assetsDir: string }

const nameKey = (s: string) => s.replace(/[^\w.-]+/g, '_');

// ---------- templates ----------
export function listTemplates(db: DB): Template[] {
  return (db.prepare('SELECT id, sort, spec FROM gen_templates ORDER BY sort, created_at').all() as { id: string; sort: number; spec: string }[])
    .map((r) => ({ ...templateSchema.parse(JSON.parse(r.spec)), id: r.id, sort: r.sort }));
}

function getTemplate(db: DB, id: string) {
  const t = listTemplates(db).find((x) => x.id === id);
  if (!t) throw notFound('PNG element');
  return t;
}

function assertFileNameFree(db: DB, fileName: string, exceptId?: string) {
  const clash = listTemplates(db).find((t) => t.fileName.toLowerCase() === fileName.toLowerCase() && t.id !== exceptId);
  if (clash) throw badRequest(`File name “${fileName}” is already used by “${clash.name}”.`);
}

export function createTemplate(db: DB, input: z.infer<typeof templateSchema>) {
  const spec = templateSchema.parse(input);
  assertFileNameFree(db, spec.fileName);
  const id = newId();
  const sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM gen_templates').get() as { s: number }).s;
  const t = nowIso();
  db.prepare('INSERT INTO gen_templates (id, sort, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, sort, JSON.stringify(spec), t, t);
  return getTemplate(db, id);
}

export function updateTemplate(db: DB, id: string, patch: z.infer<typeof templatePatchSchema>) {
  const { id: _i, sort: _s, ...cur } = getTemplate(db, id);
  const spec = templateSchema.parse({ ...cur, ...patch });
  assertFileNameFree(db, spec.fileName, id);
  db.prepare('UPDATE gen_templates SET spec = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(spec), nowIso(), id);
  return getTemplate(db, id);
}

export function duplicateTemplate(db: DB, id: string) {
  const { id: _i, sort: _s, ...cur } = getTemplate(db, id);
  const names = new Set(listTemplates(db).map((t) => t.fileName.toLowerCase()));
  let n = 2;
  while (names.has(`${cur.fileName}_${n}`.toLowerCase())) n++;
  return createTemplate(db, { ...cur, name: `${cur.name} ${n}`, fileName: `${cur.fileName}_${n}` });
}

export function moveTemplate(db: DB, id: string, direction: -1 | 1) {
  const list = listTemplates(db);
  const i = list.findIndex((t) => t.id === id);
  const j = i + direction;
  if (i < 0) throw notFound('PNG element');
  if (j < 0 || j >= list.length) return;
  db.transaction(() => {
    const up = db.prepare('UPDATE gen_templates SET sort = ? WHERE id = ?');
    list.forEach((t, k) => up.run(k === i ? j : k === j ? i : k, t.id));
  })();
}

export function deleteTemplate(db: DB, id: string) {
  getTemplate(db, id);
  db.prepare('DELETE FROM gen_templates WHERE id = ?').run(id);
}

// ---------- team gradients ----------
export interface TeamGradients { teamId: string; code: string; name: string; gradients: Record<number, Gradient | null> }

export function listGradients(db: DB): TeamGradients[] {
  const teams = db.prepare('SELECT id, code, name FROM teams ORDER BY code COLLATE NOCASE').all() as { id: string; code: string; name: string }[];
  const rows = db.prepare('SELECT team_id, variant, spec FROM gen_gradients').all() as { team_id: string; variant: number; spec: string }[];
  const by = new Map<string, Record<number, Gradient | null>>();
  for (const r of rows) {
    const m = by.get(r.team_id) ?? { 1: null, 2: null, 3: null };
    m[r.variant] = JSON.parse(r.spec);
    by.set(r.team_id, m);
  }
  return teams.map((t) => ({ teamId: t.id, code: t.code, name: t.name, gradients: by.get(t.id) ?? { 1: null, 2: null, 3: null } }));
}

export function setGradient(db: DB, teamId: string, variant: number, g: Gradient | null) {
  if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) throw notFound('Team');
  if (!VARIANTS.includes(variant as 1)) throw badRequest('Version must be 1, 2 or 3.');
  if (g === null) { db.prepare('DELETE FROM gen_gradients WHERE team_id = ? AND variant = ?').run(teamId, variant); return; }
  const spec = gradientSchema.parse(g);
  spec.stops.sort((a, b) => a.pos - b.pos);
  db.prepare(`INSERT INTO gen_gradients (team_id, variant, spec, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(team_id, variant) DO UPDATE SET spec = excluded.spec, updated_at = excluded.updated_at`).run(teamId, variant, JSON.stringify(spec), nowIso());
}

/** Fill all three versions from two or three base colours. */
export function setGradientsFromColors(db: DB, teamId: string, colors: string[], angle = 0) {
  const cs = z.array(hex).min(1).max(5).parse(colors);
  db.transaction(() => gradientVersions(cs, angle).forEach((g, i) => setGradient(db, teamId, i + 1, g)))();
}

// ---------- stroke gradient (shared by every element with a gradient stroke) ----------
export function getStrokeGradient(db: DB): Gradient {
  try { return gradientSchema.parse(JSON.parse(getSetting(db, 'generator.strokeGradient'))); } catch { return DEFAULT_STROKE_GRADIENT; }
}
export function setStrokeGradient(db: DB, g: Gradient | null) {
  if (g === null) { db.prepare("DELETE FROM settings WHERE key = 'generator.strokeGradient'").run(); return getStrokeGradient(db); }
  const spec = gradientSchema.parse(g);
  spec.stops.sort((a, b) => a.pos - b.pos);
  setSetting(db, 'generator.strokeGradient', JSON.stringify(spec));
  return spec;
}

// ---------- outputs ----------
/** Bump when the waves drawing changes so every file with waves is rendered again. */
const WAVES_VERSION = 'gradienty.ai-1';

export interface Job { rel: string; teamId: string; code: string; templateId: string; spec: ElementSpec; gradient: Gradient; hash: string }

export const outputRel = (code: string, fileName: string) => `${GENERATED_DIR}/${nameKey(code)}/${nameKey(code)}_${fileName}.png`;

/** Every file the current settings should produce, with a hash of everything that affects its pixels. */
export function plannedJobs(ctx: GenCtx): Job[] {
  const templates = listTemplates(ctx.db).filter((t) => t.enabled);
  const strokeGradient = getStrokeGradient(ctx.db);
  const jobs: Job[] = [];
  for (const team of listGradients(ctx.db)) {
    if (!team.code.trim()) continue;
    for (const t of templates) {
      const g = team.gradients[t.variant];
      if (!g) continue;
      const { id: _id, sort: _s, name: _n, fileName: _f, enabled: _e, variant: _v, ...spec } = t;
      const stroke = t.strokeGradient && t.strokeWidth > 0 ? strokeGradient : null;
      const hash = createHash('sha1').update(JSON.stringify([spec, g, t.pattern ? WAVES_VERSION : null, stroke])).digest('hex');
      jobs.push({ rel: outputRel(team.code, t.fileName), teamId: team.teamId, code: team.code, templateId: t.id, spec, gradient: g, hash });
    }
  }
  return jobs;
}

export function renderJob(ctx: GenCtx, job: Job): Buffer {
  const r = renderElement(job.spec, job.gradient, 1, job.spec.strokeGradient ? getStrokeGradient(ctx.db) : null);
  return encodePng(r.width, r.height, (x, y) => {
    const o = (y * r.width + x) * 4;
    return [r.data[o], r.data[o + 1], r.data[o + 2], r.data[o + 3]];
  });
}

/** Render one element for one team on demand (download / check), without writing it. */
export function renderOne(ctx: GenCtx, teamId: string, templateId: string): { buf: Buffer; fileName: string } {
  const job = plannedJobs(ctx).find((j) => j.teamId === teamId && j.templateId === templateId);
  if (!job) throw notFound('Generated PNG (set this team’s gradient version first)');
  return { buf: renderJob(ctx, job), fileName: path.posix.basename(job.rel) };
}

export interface GeneratedRow { rel: string; teamId: string; templateId: string; updatedAt: string }
export function listOutputs(db: DB): GeneratedRow[] {
  return (db.prepare('SELECT rel_path AS rel, team_id AS teamId, template_id AS templateId, updated_at AS updatedAt FROM gen_outputs ORDER BY rel_path').all() as GeneratedRow[]);
}

/** One row per team with a column per element: the path vMix should load (local file path without a vMix folder). */
export function jsonGraphics(db: DB, assetsDir: string): Record<string, string>[] {
  const root = getSetting(db, 'paths.vmixAssetsRoot');
  const templates = listTemplates(db).filter((t) => t.enabled);
  const outputs = new Set(listOutputs(db).map((o) => o.rel));
  return listGradients(db).filter((t) => t.code.trim() && Object.values(t.gradients).some(Boolean)).map((t) => {
    const row: Record<string, string> = { code: t.code, name: t.name };
    for (const tp of templates) {
      const rel = outputRel(t.code, tp.fileName);
      row[tp.fileName] = outputs.has(rel) ? (root ? joinVmixPath(root, rel) : path.join(assetsDir, ...rel.split('/'))) : '';
    }
    return row;
  });
}

/**
 * Keeps assets/generated in step with the gradients and elements: renders changed files a few at a
 * time (so the API stays responsive), and removes files no element produces any more.
 */
export class GeneratorExporter {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  lastError: string | null = null;
  lastWriteAt: string | null = null;
  pending = 0;

  constructor(readonly ctx: GenCtx, private log: (msg: string) => void = () => {}, private intervalMs = 1500, private budgetMs = 400) {}

  get dir() { return path.join(this.ctx.assetsDir, GENERATED_DIR); }
  get autoExport() { return getSetting(this.ctx.db, 'generator.autoExport') !== 'false'; }

  start() {
    this.timer = setInterval(() => { if (this.autoExport) this.run(this.budgetMs); }, this.intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  status() {
    return { autoExport: this.autoExport, folder: this.dir, pending: this.pending, files: (this.ctx.db.prepare('SELECT COUNT(*) AS n FROM gen_outputs').get() as { n: number }).n, lastWriteAt: this.lastWriteAt, error: this.lastError };
  }

  /** Forget what was written so everything renders again on the next ticks. */
  rerenderAll() { this.ctx.db.prepare('UPDATE gen_outputs SET hash = ?').run(''); }

  /** Render everything that is pending right now ("Export now", tests). */
  flush() { this.run(Infinity); return this.status(); }

  /** Renders changed files until the time budget is used up; returns how many are still pending. */
  run(budgetMs: number): number {
    if (this.busy) return this.pending;
    this.busy = true;
    try {
      const db = this.ctx.db;
      const jobs = plannedJobs(this.ctx);
      const written = new Map((db.prepare('SELECT rel_path, hash FROM gen_outputs').all() as { rel_path: string; hash: string }[]).map((r) => [r.rel_path, r.hash]));
      const todo = jobs.filter((j) => written.get(j.rel) !== j.hash || !fs.existsSync(path.join(this.ctx.assetsDir, ...j.rel.split('/'))));
      const started = Date.now();
      let done = 0;
      const up = db.prepare(`INSERT INTO gen_outputs (rel_path, team_id, template_id, hash, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(rel_path) DO UPDATE SET team_id = excluded.team_id, template_id = excluded.template_id, hash = excluded.hash, updated_at = excluded.updated_at`);
      for (const job of todo) {
        if (done > 0 && Date.now() - started > budgetMs) break;
        const file = path.join(this.ctx.assetsDir, ...job.rel.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, renderJob(this.ctx, job));
        fs.renameSync(tmp, file);
        up.run(job.rel, job.teamId, job.templateId, job.hash, nowIso());
        this.lastWriteAt = nowIso();
        done++;
      }
      this.pending = todo.length - done;

      // Remove files that no element/team produces any more (only inside assets/generated).
      const wanted = new Set(jobs.map((j) => j.rel));
      for (const rel of written.keys()) {
        if (wanted.has(rel)) continue;
        fs.rmSync(path.join(this.ctx.assetsDir, ...rel.split('/')), { force: true });
        db.prepare('DELETE FROM gen_outputs WHERE rel_path = ?').run(rel);
      }
      this.removeStrays(wanted);
      if (this.lastError) this.log('PNG export running again after an error');
      this.lastError = null;
      return this.pending;
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (msg !== this.lastError) this.log(`PNG export failed: ${msg}`);
      this.lastError = msg;
      return 0;
    } finally {
      this.busy = false;
    }
  }

  /** PNGs left in assets/generated by older settings (e.g. a renamed team code) and empty folders. */
  private removeStrays(wanted: Set<string>) {
    let teams: fs.Dirent[];
    try { teams = fs.readdirSync(this.dir, { withFileTypes: true }); } catch { return; }
    for (const d of teams) {
      if (!d.isDirectory()) continue;
      const sub = path.join(this.dir, d.name);
      for (const f of fs.readdirSync(sub)) {
        const rel = `${GENERATED_DIR}/${d.name}/${f}`;
        if ((f.endsWith('.png') || f.endsWith('.tmp')) && !wanted.has(rel)) fs.rmSync(path.join(sub, f), { force: true });
      }
      if (!fs.readdirSync(sub).length) fs.rmdirSync(sub);
    }
  }
}

// ---------- defaults ----------
const ELEMENT_DEFAULTS = { radius: 0, opacity: 100, flip: false, angleOffset: 0, strokeWidth: 0, strokeColor: '#9a9a9a', strokeOpacity: 100, strokeGradient: false, strokeAngle: -45, pattern: true, patternOpacity: 10, patternScale: 100, enabled: true };
/** The 1px gradient ring the panels and the waves bar have (orange→yellow since finals-broadcast_ssl26_v2). */
const AI_STROKE = { strokeWidth: 1, strokeGradient: true };

/** Starting elements: artboard sizes, corner radii and waves (10% black; 53.3% size on the small ones) from gradienty.ai. */
export const STARTER_TEMPLATES: z.infer<typeof templateSchema>[] = [
  { ...ELEMENT_DEFAULTS, name: 'Bar', fileName: 'bar', variant: 1, width: 929, height: 75 },
  { ...ELEMENT_DEFAULTS, name: 'Panel left', fileName: 'panel_left', variant: 2, width: 851, height: 390, radius: 35, ...AI_STROKE },
  { ...ELEMENT_DEFAULTS, name: 'Panel right', fileName: 'panel_right', variant: 2, width: 851, height: 390, radius: 35, flip: true, ...AI_STROKE },
  { ...ELEMENT_DEFAULTS, name: 'Bar waves', fileName: 'bar_waves', variant: 3, width: 802, height: 102, radius: 27, ...AI_STROKE },
  { ...ELEMENT_DEFAULTS, name: 'Bar long', fileName: 'bar_long', variant: 1, width: 1130, height: 75 },
  { ...ELEMENT_DEFAULTS, name: 'Bar small', fileName: 'bar_small', variant: 1, width: 289, height: 40, patternScale: 53.3 },
  { ...ELEMENT_DEFAULTS, name: 'Square', fileName: 'square', variant: 2, width: 210, height: 134, radius: 12, flip: true, patternScale: 53.3 },
];

/** Starter sizes before the Illustrator file arrived; elements still at these get the file's values. */
const FIRST_GUESS: Record<string, [number, number]> = {
  bar: [1040, 72], panel_left: [944, 432], panel_right: [944, 432], bar_waves: [888, 104], bar_long: [1264, 80], bar_small: [320, 40], square: [240, 144],
};

/** One-time updates of the first-guess starter elements to the sizes, waves and stroke of gradienty.ai. */
export function upgradeStarterTemplates(db: DB) {
  if (getSetting(db, 'generator.templatesFromAi') !== 'true') db.transaction(() => {
    for (const t of listTemplates(db)) {
      const guess = FIRST_GUESS[t.fileName];
      const starter = STARTER_TEMPLATES.find((s) => s.fileName === t.fileName);
      if (!guess || !starter || t.width !== guess[0] || t.height !== guess[1]) continue;
      updateTemplate(db, t.id, {
        width: starter.width, height: starter.height, radius: t.radius || starter.radius,
        pattern: starter.pattern, patternScale: starter.patternScale, patternOpacity: t.patternOpacity === 22 ? starter.patternOpacity : t.patternOpacity,
      });
    }
    setSetting(db, 'generator.templatesFromAi', 'true');
  })();
  // the gradient stroke came later: give it to starter elements that still have no stroke
  if (getSetting(db, 'generator.strokeFromAi') !== 'true') db.transaction(() => {
    for (const t of listTemplates(db)) {
      const starter = STARTER_TEMPLATES.find((s) => s.fileName === t.fileName);
      if (starter?.strokeGradient && t.strokeWidth === 0) updateTemplate(db, t.id, { strokeWidth: starter.strokeWidth, strokeGradient: true, strokeAngle: starter.strokeAngle });
    }
    setSetting(db, 'generator.strokeFromAi', 'true');
  })();
}

/** Gradients read off the Illustrator board (two colours each); applied only to teams without one. */
export const STARTER_GRADIENTS: Record<string, string[]> = {
  MAR: ['#bf3539', '#0d8f27'], MOZ: ['#06cca1', '#ead60b'], SEY: ['#70bae8', '#1b3250'], TAH: ['#e30820', '#f6a010'],
  AUT: ['#821319', '#e46d7b'], EST: ['#00c7fd', '#006aad'], SLO: ['#84d237', '#08469e'], BEL: ['#90cefa', '#c51f3c'],
  LTU: ['#066c43', '#eeb416'], NOR: ['#c41519', '#0b1f57'], SRB: ['#c42a33', '#233c6e'],
};

/** Team colours from team-gradients_ssl26.ai: the full bar (version 1) as [position, colour] stops, all at −20°. */
export const TEAM_GRADIENTS_SSL26: Record<string, [number, string][]> = {
  ARG: [[0, '#74aadd'], [100, '#ffcd40']],
  AUS: [[0, '#064f51'], [100, '#f2e632']],
  BRA: [[0, '#049240'], [100, '#fdc900']],
  CAN: [[0, '#d32b1f'], [50, '#1d1d1b'], [100, '#d32b1f']],
  CHI: [[0, '#00329e'], [100, '#d72a1c']],
  COL: [[0, '#fdcb02'], [50, '#c5112f'], [100, '#171933']],
  CZE: [[0, '#0a338e'], [100, '#e20516']],
  DEN: [[0, '#c5112f'], [57.3, '#f8b133'], [100, '#c5112f']],
  ECU: [[0, '#fdcb02'], [100, '#072249']],
  EST: [[0, '#00c9ff'], [100, '#0064a8']],
  FRA: [[0, '#002654'], [5, '#002654'], [50, '#dddddd'], [95, '#cc1226'], [100, '#cc1226']],
  MYA: [[0, '#c82a31'], [100, '#193d72']],
  HUN: [[0, '#c8102e'], [50, '#d3a553'], [100, '#00843d']],
  IND: [[0, '#fd671f'], [49.5, '#bf9432'], [100, '#036a38']],
  JPN: [[0, '#d51217'], [100, '#cccccc']],
  LTU: [[0, '#006a44'], [100, '#fdb913']],
  MAS: [[0, '#fbbc0b'], [10, '#fbbc0b'], [49.5, '#9b6224'], [100, '#1717a0']],
  NED: [[0, '#ff5224'], [100, '#ac1c28']],
  NZL: [[0, '#002877'], [57.3, '#1d1d1b'], [100, '#002877']],
  OMA: [[0, '#c82a31'], [100, '#193d72']],
  PER: [[0, '#d71223'], [50, '#e2a8b1'], [100, '#d71223']],
  POL: [[0, '#dbdbdb'], [100, '#da153d']],
  POR: [[0, '#006600'], [100, '#ff0000']],
  SEY: [[0, '#72bdec'], [100, '#162946']],
  SGP: [[0, '#a5112d'], [100, '#ea495d']],
  RSA: [[0, '#037246'], [100, '#f9b410']],
  ESP: [[0, '#c40c1f'], [50, '#fdc205'], [100, '#c40c1f']],
  SWE: [[0, '#fcc900'], [100, '#0e447d']],
  SUI: [[0, '#d90e16'], [50, '#ea7180'], [100, '#d90f16']],
  TAH: [[0, '#e30520'], [100, '#f7aa0f']],
  THA: [[0, '#a21a32'], [50, '#9e285e'], [100, '#1b1b49']],
  UKR: [[0, '#0057b7'], [100, '#ffd700']],
  GBR: [[0, '#c5112f'], [50, '#dddddd'], [100, '#022169']],
};
export const TEAM_GRADIENTS_VERSION = 'team-gradients_ssl26';

/** Team colours from color_panam.ai (Panam qualifiers), read off its gradients: version 1 as [position, colour] stops. */
export const TEAM_GRADIENTS_PANAM: Record<string, [number, string][]> = {
  CUB: [[0, '#253981'], [100, '#e00c19']],
  ESA: [[0, '#013366'], [100, '#038afd']],
  VEN: [[0, '#5c1b38'], [100, '#e44390']],
  ANT: [[0, '#001f57'], [50, '#e4332a'], [100, '#f8b400']],
  BER: [[0, '#f173b8'], [100, '#009cdb']],
  MEX: [[0, '#118d48'], [100, '#00533c']],
  PUR: [[0, '#1a2340'], [100, '#bc242b']],
};
export const TEAM_GRADIENTS_PANAM_VERSION = 'color_panam-1';

/**
 * Panam colours replace all three versions of each of these teams once (per team, so a team added or renamed
 * later still gets them). Angle −20° like the SSL26 colours. Changes made afterwards in the generator stay.
 * Returns how many teams were coloured.
 */
export function applyPanamColours(db: DB): number {
  let n = 0;
  for (const [code, stops] of Object.entries(TEAM_GRADIENTS_PANAM)) {
    const key = `generator.colours.${code}`;
    if (getSetting(db, key) === TEAM_GRADIENTS_PANAM_VERSION) continue;
    const team = db.prepare('SELECT id FROM teams WHERE code = ? COLLATE NOCASE').get(code) as { id: string } | undefined;
    if (!team) continue;
    const g: Gradient = { angle: -20, stops: stops.map(([pos, color]) => ({ pos, color, opacity: 100 })) };
    db.transaction(() => {
      gradientVersionsFrom(g).forEach((v, i) => setGradient(db, team.id, i + 1, v));
      setSetting(db, key, TEAM_GRADIENTS_PANAM_VERSION);
    })();
    n++;
  }
  return n;
}

/**
 * The SSL26 broadcast design, applied once: team colours from team-gradients_ssl26.ai replace all three
 * versions of the teams in that file, and the old green→blue stroke becomes the orange→yellow one.
 */
export function applySsl26Design(db: DB) {
  if (getSetting(db, 'generator.design') === TEAM_GRADIENTS_VERSION) return;
  if (!db.prepare('SELECT 1 FROM teams LIMIT 1').get()) return;
  db.transaction(() => {
    for (const [code, stops] of Object.entries(TEAM_GRADIENTS_SSL26)) {
      const team = db.prepare('SELECT id FROM teams WHERE code = ? COLLATE NOCASE').get(code) as { id: string } | undefined;
      if (!team) continue;
      const g: Gradient = { angle: -20, stops: stops.map(([pos, color]) => ({ pos, color, opacity: 100 })) };
      gradientVersionsFrom(g).forEach((v, i) => setGradient(db, team.id, i + 1, v));
    }
    // a stroke still in the old SSL green is the old default: let the new default take over
    if (getStrokeGradient(db).stops.some((st) => st.color.toLowerCase() === '#00b15e')) setStrokeGradient(db, null);
    setSetting(db, 'generator.design', TEAM_GRADIENTS_VERSION);
  })();
}

/** First start of the generator: starter elements, and gradients for teams that match the board. */
export function seedGenerator(db: DB) {
  upgradeStarterTemplates(db);
  if (getSetting(db, 'generator.seeded') !== 'true') seedStarters(db);
  applySsl26Design(db);
  applyPanamColours(db);
}

function seedStarters(db: DB) {
  if (!db.prepare('SELECT 1 FROM teams LIMIT 1').get()) return;
  db.transaction(() => {
    if (!listTemplates(db).length) for (const t of STARTER_TEMPLATES) createTemplate(db, t);
    const has = new Set((db.prepare('SELECT DISTINCT team_id FROM gen_gradients').all() as { team_id: string }[]).map((r) => r.team_id));
    for (const [code, colors] of Object.entries(STARTER_GRADIENTS)) {
      const team = db.prepare('SELECT id FROM teams WHERE code = ? COLLATE NOCASE').get(code) as { id: string } | undefined;
      if (team && !has.has(team.id)) setGradientsFromColors(db, team.id, colors);
    }
    setSetting(db, 'generator.seeded', 'true');
    setSetting(db, 'generator.templatesFromAi', 'true');
    setSetting(db, 'generator.strokeFromAi', 'true');
  })();
}
