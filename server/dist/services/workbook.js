import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { activeEvent } from '../db/db.js';
import { todayIn } from './dates.js';
import { jsonCaptains, jsonFleetSet, jsonPeople, jsonSailors, jsonSchedule, jsonTeams, jsonWeather } from './jsonExport.js';
import { buildXlsx, sheetNames } from './xlsx.js';
import { jsonGraphics } from './generator/generator.js';
import { GRAPHIC_KINDS, graphicSheetRows, seedGraphicSets } from './graphicSets.js';
import { lineupSheetRows } from './lineups.js';
import { resultSheetRows } from './results.js';
/** Every data source as one named sheet, in a fixed order; sheet names are valid Excel names. */
export function allSheets(ctx) {
    const ev = activeEvent(ctx.db);
    const today = todayIn(ev.timezone);
    seedGraphicSets(ctx.db, ev.id);
    const sets = ctx.db.prepare('SELECT id, name FROM fleet_sets WHERE event_id = ? ORDER BY sort, created_at').all(ev.id);
    const list = [
        { name: 'Teams', path: '/json/teams', rows: jsonTeams(ctx) },
        { name: 'Sailors', path: '/json/sailors', rows: jsonSailors(ctx, ev.id, today) },
        { name: 'Captains', path: '/json/captains', rows: jsonCaptains(ctx) },
        { name: 'Weather', path: '/json/weather', rows: jsonWeather(ctx.db) },
        { name: 'Schedule', path: '/json/schedule', rows: jsonSchedule(ctx.db, ev.id, today) },
        { name: 'People', path: '/json/people', rows: jsonPeople(ctx, ev.id) },
        ...GRAPHIC_KINDS.map((k) => ({ name: k.sheet, path: `/json/graphics-sets/${k.kind}`, rows: graphicSheetRows(ctx.db, ev.id, k.kind) })),
        { name: 'Lineups', path: '/json/lineups', rows: lineupSheetRows(ctx, ev.id) },
        { name: 'Results', path: '/json/results', rows: resultSheetRows(ctx, ev.id) },
        { name: 'Graphics', path: '/json/graphics', rows: jsonGraphics(ctx.db, ctx.assetsDir) },
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
            const sheets = allSheets(this.ctx);
            const hash = createHash('sha1').update(JSON.stringify(sheets.map((s) => [s.name, s.rows]))).digest('hex');
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
