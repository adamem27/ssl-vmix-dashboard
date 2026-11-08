import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { activeEvent } from '../db/db.js';
import { AssetCtx, organizeAssets } from './assets.js';
import { todayIn } from './dates.js';
import { buildXlsx } from './xlsx.js';
import { seedGraphicSets } from './graphicSets.js';
import { fillTeamSlotsFromGenerator } from './generatedSlots.js';
import { SHEETS, sheetRows } from './workbookSheets.js';

/** Bump when the file's look changes without its data, so the next tick rewrites it. */
const LAYOUT_VERSION = 2;

export interface WorkbookSheet { name: string; path: string; rows: Record<string, string>[] }

/** The four sheets of the vMix workbook (see workbookSheets.ts). */
export function allSheets(ctx: AssetCtx): WorkbookSheet[] {
  const ev = activeEvent(ctx.db);
  const today = todayIn(ev.timezone);
  seedGraphicSets(ctx.db, ev.id);
  return SHEETS.map((s) => ({ name: s.name, path: `/json/sheet/${s.key}`, rows: sheetRows(ctx, ev.id, today, s.key) }));
}

/**
 * Keeps one .xlsx file on disk up to date for vMix (Data Sources → Excel/CSV picks a sheet).
 * Rewrites only when the data changed; a failed write (e.g. file locked) is retried on the next tick.
 */
export class WorkbookWriter {
  private timer: NodeJS.Timeout | null = null;
  private lastHash = '';
  updatedAt: string | null = null;
  lastError: string | null = null;

  constructor(private ctx: AssetCtx, readonly file: string, private log: (msg: string) => void = () => {}, private intervalMs = 3000) {}

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  tick() {
    try {
      organizeAssets(this.ctx); // a renamed team or sailor moves its files before the paths are written
      fillTeamSlotsFromGenerator(this.ctx); // empty backgrounds and lower thirds take the generated PNGs
      const sheets = allSheets(this.ctx);
      const hash = createHash('sha1').update(JSON.stringify(sheets.map((s) => [s.name, s.rows, (s.rows as { styles?: unknown }).styles ?? null, LAYOUT_VERSION]))).digest('hex');
      if (hash === this.lastHash && fs.existsSync(this.file)) return;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, buildXlsx(sheets));
      try {
        fs.renameSync(tmp, this.file);
      } catch (e) {
        // Windows refuses to replace a file another program (vMix) holds open; overwriting in place may still work.
        try { fs.copyFileSync(tmp, this.file); } catch { throw e; } finally { fs.rmSync(tmp, { force: true }); }
      }
      this.lastHash = hash;
      this.updatedAt = new Date().toISOString();
      if (this.lastError) this.log('Workbook written again after an error');
      this.lastError = null;
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (msg !== this.lastError) this.log(`Workbook not written: ${msg}`);
      this.lastError = msg;
    }
  }
}
