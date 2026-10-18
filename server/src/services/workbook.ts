import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { activeEvent } from '../db/db.js';
import { AssetCtx } from './assets.js';
import { todayIn } from './dates.js';
import { jsonCaptains, jsonFleetSet, jsonPeople, jsonSailors, jsonSchedule, jsonTeams, jsonWeather } from './jsonExport.js';
import { buildXlsx, sheetNames } from './xlsx.js';

export interface WorkbookSheet { name: string; path: string; rows: Record<string, string>[] }

/** Every data source as one named sheet, in a fixed order; sheet names are valid Excel names. */
export function allSheets(ctx: AssetCtx): WorkbookSheet[] {
  const ev = activeEvent(ctx.db);
  const today = todayIn(ev.timezone);
  const sets = ctx.db.prepare('SELECT id, name FROM fleet_sets WHERE event_id = ? ORDER BY sort, created_at').all(ev.id) as { id: string; name: string }[];
  const list = [
    { name: 'Teams', path: '/json/teams', rows: jsonTeams(ctx) },
    { name: 'Sailors', path: '/json/sailors', rows: jsonSailors(ctx, ev.id, today) },
    { name: 'Captains', path: '/json/captains', rows: jsonCaptains(ctx) },
    { name: 'Weather', path: '/json/weather', rows: jsonWeather(ctx.db) },
    { name: 'Schedule', path: '/json/schedule', rows: jsonSchedule(ctx.db, ev.id, today) },
    { name: 'People', path: '/json/people', rows: jsonPeople(ctx, ev.id) },
    ...sets.map((s) => ({ name: s.name, path: `/json/fleets/${s.id}`, rows: jsonFleetSet(ctx, s.id) })),
  ];
  const names = sheetNames(list.map((s) => s.name));
  return list.map((s, i) => ({ ...s, name: names[i] }));
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
      const sheets = allSheets(this.ctx);
      const hash = createHash('sha1').update(JSON.stringify(sheets.map((s) => [s.name, s.rows]))).digest('hex');
      if (hash === this.lastHash && fs.existsSync(this.file)) return;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, buildXlsx(sheets));
      fs.renameSync(tmp, this.file);
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
