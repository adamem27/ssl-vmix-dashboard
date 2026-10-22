import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DB, getSetting, newId, nowIso, setSetting } from '../../db/db.js';
import { badRequest, notFound } from '../errors.js';
import { encodePng } from '../png.js';
import { joinVmixPath } from '../paths.js';
import { ElementSpec, Gradient, gradientVersions, renderElement } from './render.js';

export const VARIANTS = [1, 2, 3] as const;
/** Generated files live in their own folder inside assets, so vmix-sync mirrors them to the vMix machine. */
export const GENERATED_DIR = 'generated';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be #RRGGBB');
const pct = z.number().min(0).max(100);
export const gradientSchema = z.object({
  angle: z.number().min(-360).max(360),
  stops: z.array(z.object({ pos: pct, color: hex, opacity: pct })).min(2).max(8),
});
export const templateSchema = z.object({
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
  pattern: z.boolean(),
  patternOpacity: pct,
  patternScale: z.number().min(5).max(1000),
  enabled: z.boolean(),
});
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

export function updateTemplate(db: DB, id: string, patch: Partial<z.infer<typeof templateSchema>>) {
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

// ---------- outputs ----------
/** Bump when the waves drawing changes so every file with waves is rendered again. */
const WAVES_VERSION = 'gradienty.ai-1';

export interface Job { rel: string; teamId: string; code: string; templateId: string; spec: ElementSpec; gradient: Gradient; hash: string }

export const outputRel = (code: string, fileName: string) => `${GENERATED_DIR}/${nameKey(code)}/${nameKey(code)}_${fileName}.png`;

/** Every file the current settings should produce, with a hash of everything that affects its pixels. */
export function plannedJobs(ctx: GenCtx): Job[] {
  const templates = listTemplates(ctx.db).filter((t) => t.enabled);
  const jobs: Job[] = [];
  for (const team of listGradients(ctx.db)) {
    if (!team.code.trim()) continue;
    for (const t of templates) {
      const g = team.gradients[t.variant];
      if (!g) continue;
      const { id: _id, sort: _s, name: _n, fileName: _f, enabled: _e, variant: _v, ...spec } = t;
      const hash = createHash('sha1').update(JSON.stringify([spec, g, t.pattern ? WAVES_VERSION : null])).digest('hex');
      jobs.push({ rel: outputRel(team.code, t.fileName), teamId: team.teamId, code: team.code, templateId: t.id, spec, gradient: g, hash });
    }
  }
  return jobs;
}

export function renderJob(ctx: GenCtx, job: Job): Buffer {
  const r = renderElement(job.spec, job.gradient);
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
const ELEMENT_DEFAULTS = { radius: 0, opacity: 100, flip: false, angleOffset: 0, strokeWidth: 0, strokeColor: '#9a9a9a', strokeOpacity: 100, pattern: true, patternOpacity: 10, patternScale: 100, enabled: true };

/** Starting elements: artboard sizes, corner radii and waves (10% black; 53.3% size on the small ones) from gradienty.ai. */
export const STARTER_TEMPLATES: z.infer<typeof templateSchema>[] = [
  { ...ELEMENT_DEFAULTS, name: 'Bar', fileName: 'bar', variant: 1, width: 929, height: 75 },
  { ...ELEMENT_DEFAULTS, name: 'Panel left', fileName: 'panel_left', variant: 2, width: 851, height: 390, radius: 35 },
  { ...ELEMENT_DEFAULTS, name: 'Panel right', fileName: 'panel_right', variant: 2, width: 851, height: 390, radius: 35, flip: true },
  { ...ELEMENT_DEFAULTS, name: 'Bar waves', fileName: 'bar_waves', variant: 3, width: 802, height: 102, radius: 27 },
  { ...ELEMENT_DEFAULTS, name: 'Bar long', fileName: 'bar_long', variant: 1, width: 1130, height: 75 },
  { ...ELEMENT_DEFAULTS, name: 'Bar small', fileName: 'bar_small', variant: 1, width: 289, height: 40, patternScale: 53.3 },
  { ...ELEMENT_DEFAULTS, name: 'Square', fileName: 'square', variant: 2, width: 210, height: 134, radius: 12, flip: true, patternScale: 53.3 },
];

/** Starter sizes before the Illustrator file arrived; elements still at these get the file's values. */
const FIRST_GUESS: Record<string, [number, number]> = {
  bar: [1040, 72], panel_left: [944, 432], panel_right: [944, 432], bar_waves: [888, 104], bar_long: [1264, 80], bar_small: [320, 40], square: [240, 144],
};

/** One-time update of the first-guess starter elements to the sizes and waves of gradienty.ai. */
export function upgradeStarterTemplates(db: DB) {
  if (getSetting(db, 'generator.templatesFromAi') === 'true') return;
  db.transaction(() => {
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
}

/** Gradients read off the Illustrator board (two colours each); applied only to teams without one. */
export const STARTER_GRADIENTS: Record<string, string[]> = {
  MAR: ['#bf3539', '#0d8f27'], MOZ: ['#06cca1', '#ead60b'], SEY: ['#70bae8', '#1b3250'], TAH: ['#e30820', '#f6a010'],
  AUT: ['#821319', '#e46d7b'], EST: ['#00c7fd', '#006aad'], SLO: ['#84d237', '#08469e'], BEL: ['#90cefa', '#c51f3c'],
  LTU: ['#066c43', '#eeb416'], NOR: ['#c41519', '#0b1f57'], SRB: ['#c42a33', '#233c6e'],
};

/** First start of the generator: starter elements, and gradients for teams that match the board. */
export function seedGenerator(db: DB) {
  upgradeStarterTemplates(db);
  if (getSetting(db, 'generator.seeded') === 'true') return;
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
  })();
}
