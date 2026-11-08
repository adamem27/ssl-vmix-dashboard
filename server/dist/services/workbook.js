import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { activeEvent } from '../db/db.js';
import { organizeAssets } from './assets.js';
import { todayIn } from './dates.js';
import { buildXlsx } from './xlsx.js';
import { seedGraphicSets } from './graphicSets.js';
import { fillTeamSlotsFromGenerator } from './generatedSlots.js';
import { applyPanamColours } from './generator/generator.js';
import { SHEETS, sheetRows } from './workbookSheets.js';
/** Bump when the file's look changes without its data, so the next tick rewrites it. */
const LAYOUT_VERSION = 2;
/** The six sheets of the vMix workbook (see workbookSheets.ts). */
export function allSheets(ctx) {
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
    ctx;
    file;
    log;
    intervalMs;
    timer = null;
    lastHash = '';
    updatedAt = null;
    lastError = null;
    constructor(ctx, file, log = () => { }, intervalMs = 3000) {
        this.ctx = ctx;
        this.file = file;
        this.log = log;
        this.intervalMs = intervalMs;
    }
    start() {
        this.tick();
        this.timer = setInterval(() => this.tick(), this.intervalMs);
        this.timer.unref?.();
    }
    stop() { if (this.timer)
        clearInterval(this.timer); }
    tick() {
        try {
            organizeAssets(this.ctx); // a renamed team or sailor moves its files before the paths are written
            applyPanamColours(this.ctx.db); // Panam teams added after the start get their colours too
            fillTeamSlotsFromGenerator(this.ctx); // empty backgrounds and lower thirds take the generated PNGs
            const sheets = allSheets(this.ctx);
            const hash = createHash('sha1').update(JSON.stringify(sheets.map((s) => [s.name, s.rows, s.rows.styles ?? null, LAYOUT_VERSION]))).digest('hex');
            if (hash === this.lastHash && fs.existsSync(this.file))
                return;
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, buildXlsx(sheets));
            try {
                fs.renameSync(tmp, this.file);
            }
            catch (e) {
                // Windows refuses to replace a file another program (vMix) holds open; overwriting in place may still work.
                try {
                    fs.copyFileSync(tmp, this.file);
                }
                catch {
                    throw e;
                }
                finally {
                    fs.rmSync(tmp, { force: true });
                }
            }
            this.lastHash = hash;
            this.updatedAt = new Date().toISOString();
            if (this.lastError)
                this.log('Workbook written again after an error');
            this.lastError = null;
        }
        catch (e) {
            const msg = e?.message ?? String(e);
            if (msg !== this.lastError)
                this.log(`Workbook not written: ${msg}`);
            this.lastError = msg;
        }
    }
}
