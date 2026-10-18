import { activeEvent, DB, getSetting, newId, nowIso, setSetting } from '../db/db.js';
import { importers } from '../importers/index.js';
import { ParseError } from '../importers/types.js';
import { applyParsed, ImportSummary } from './applyImport.js';

export type Fetcher = (url: string) => Promise<string>;

const FETCH_TIMEOUT_MS = 20_000;
const STALE_RUN_MS = 10 * 60_000;

export const defaultFetcher: Fetcher = async (url) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'ssl-vmix-dashboard/0.1 (+local operator tool)', Accept: 'text/html,application/xhtml+xml' } });
    if (!res.ok) throw new SourceError(`The source responded with HTTP error ${res.status} ${res.statusText}.`);
    return await res.text();
  } catch (e: any) {
    if (e instanceof SourceError) throw e;
    if (e?.name === 'AbortError') throw new SourceError(`Timed out waiting for the source (${FETCH_TIMEOUT_MS / 1000} s).`);
    const code = e?.cause?.code ?? e?.code;
    throw new SourceError(`Cannot connect to the source${code ? ` (${code})` : ''}. Check the URL and the internet connection.`);
  } finally {
    clearTimeout(timer);
  }
};

export class SourceError extends Error {}

export interface RunOutcome { status: 'success' | 'error' | 'already_running'; runId?: string; error?: string; summary?: ImportSummary }

export class SyncService {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  readonly startedAt = nowIso();

  constructor(private db: DB, private fetcher: Fetcher = defaultFetcher) {
    // A run left "running" means the process stopped mid-run; nothing was committed for it.
    db.prepare(`UPDATE sync_runs SET status = 'error', finished_at = ?, error_message = 'Interrupted: the server stopped during the fetch.' WHERE status = 'running'`).run(nowIso());
  }

  config() {
    return {
      url: getSetting(this.db, 'sync.url'),
      enabled: getSetting(this.db, 'sync.enabled') === 'true',
      intervalMinutes: Math.max(1, Number(getSetting(this.db, 'sync.intervalMinutes')) || 30),
      importer: getSetting(this.db, 'sync.importer'),
    };
  }

  nextRunAt(): string | null {
    const c = this.config();
    if (!c.enabled) return null;
    const last = getSetting(this.db, 'sync.lastAttemptAt');
    if (!last) return nowIso();
    return new Date(new Date(last).getTime() + c.intervalMinutes * 60_000).toISOString();
  }

  status() {
    const lastRun = this.db.prepare('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1').get() as any;
    return {
      ...this.config(),
      importers: Object.values(importers).map((i) => ({ id: i.id, label: i.label, description: i.description })),
      running: this.running,
      lastAttemptAt: getSetting(this.db, 'sync.lastAttemptAt') || null,
      lastSuccessAt: getSetting(this.db, 'sync.lastSuccessAt') || null,
      nextRunAt: this.nextRunAt(),
      backendStartedAt: this.startedAt,
      lastRun: lastRun ? runDto(lastRun) : null,
    };
  }

  history(limit = 20) {
    return (this.db.prepare('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?').all(limit) as any[]).map(runDto);
  }

  /** Claims the run atomically in the DB so two server processes on the same database never overlap. */
  private claim(trigger: string, url: string, importer: string): string | null {
    return this.db.transaction(() => {
      const busy = this.db.prepare(`SELECT id FROM sync_runs WHERE status = 'running' AND started_at > ?`).get(new Date(Date.now() - STALE_RUN_MS).toISOString());
      if (busy) return null;
      const id = newId();
      const t = nowIso();
      this.db.prepare(`INSERT INTO sync_runs (id, trigger, importer, source_url, started_at, status) VALUES (?, ?, ?, ?, ?, 'running')`).run(id, trigger, importer, url, t);
      if (trigger !== 'upload') setSetting(this.db, 'sync.lastAttemptAt', t);
      return id;
    }).immediate();
  }

  /** `upload` imports an HTML file the operator saved from the source page instead of fetching it. */
  async runNow(trigger: 'auto' | 'manual' | 'upload', upload?: { body: string; filename: string; baseUrl?: string | null }): Promise<RunOutcome> {
    if (this.running) return { status: 'already_running' };
    const c = this.config();
    const sourceLabel = upload ? `file: ${upload.filename}` : c.url;
    const importer = importers[c.importer];
    this.running = true;
    let runId: string | null = null;
    try {
      runId = this.claim(trigger, sourceLabel, c.importer);
      if (!runId) return { status: 'already_running' };
      if (!importer) throw new SourceError(`Unknown importer “${c.importer}”.`);
      if (!upload && !/^https?:\/\//i.test(c.url)) throw new SourceError('The source URL must start with http:// or https://.');
      const body = upload ? upload.body : await this.fetcher(c.url);
      const ev = activeEvent(this.db);
      const baseUrl = upload && upload.baseUrl !== undefined ? upload.baseUrl ?? '' : c.url;
      const parsed = importer.parse(body, { year: ev.year, baseUrl });
      const fetchedAt = nowIso();
      // Parse fully first, then write everything in one transaction: a failure leaves the previous data intact.
      const summary = this.db.transaction(() => applyParsed(this.db, ev.id, parsed.declarations, fetchedAt))();
      summary.warnings.unshift(...parsed.warnings);
      this.db.prepare(`UPDATE sync_runs SET status = 'success', finished_at = ?, summary = ? WHERE id = ?`).run(nowIso(), JSON.stringify(summary), runId);
      if (!upload) setSetting(this.db, 'sync.lastSuccessAt', fetchedAt);
      return { status: 'success', runId, summary };
    } catch (e: any) {
      const msg = e instanceof SourceError || e instanceof ParseError ? e.message : `Import error: ${e?.message ?? String(e)}. Data from the previous fetch was kept unchanged.`;
      if (runId) this.db.prepare(`UPDATE sync_runs SET status = 'error', finished_at = ?, error_message = ? WHERE id = ?`).run(nowIso(), msg, runId);
      return { status: 'error', runId: runId ?? undefined, error: msg };
    } finally {
      this.running = false;
    }
  }

  start(tickMs = 15_000) {
    if (this.timer) return;
    const tick = () => {
      const next = this.nextRunAt();
      if (next && Date.now() >= new Date(next).getTime() && !this.running) void this.runNow('auto');
    };
    this.timer = setInterval(tick, tickMs);
    this.timer.unref?.();
    setTimeout(tick, 2_000).unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

function runDto(r: any) {
  return {
    id: r.id, trigger: r.trigger, importer: r.importer, sourceUrl: r.source_url, startedAt: r.started_at, finishedAt: r.finished_at,
    status: r.status, error: r.error_message, summary: r.summary ? (JSON.parse(r.summary) as ImportSummary) : null,
  };
}
