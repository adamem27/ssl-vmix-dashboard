import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DB, getSetting, nowIso, setSetting } from '../db/db.js';
import type { Feed } from './commentatorSnapshot.js';
import { DEFAULT_PUBLIC_URL } from './siteTargets.js';

/**
 * The commentator screen as a static web page.
 *
 * Every minute (Settings → Commentator online) the dashboard builds a folder that any plain web host can serve:
 *   index.html, assets/*.js|css   the screen (built once with the app: web/dist/commentator.html)
 *   data.json                     every answer the screen needs, picture addresses pointing at img/
 *   img/<sha1>.<ext>              flags, emblems and photos
 *   status.json                   { pushedAt, version, every }: tiny, rewritten every round so the screen knows the data is fresh
 * Then it uploads what changed to Cloudflare R2 (commentary.em27code.com). Nothing runs there but the web server,
 * so there is nothing to crash. What is already there is remembered across restarts, so a restart sends only changes.
 */

export interface SiteFile { rel: string; data: Buffer | string }
/** Where the folder goes (R2; a local folder in tests). */
export interface SiteTarget {
  label: string;
  /** Writes the files in order; calls done() after each one, so a broken connection only resends the rest. */
  put(files: SiteFile[], done: (rel: string) => void): Promise<void>;
  close?(): Promise<void>;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
const sha1 = (b: Buffer | string) => createHash('sha1').update(b).digest('hex');

/** A short mark of the built page (changes with every new app version). */
export const buildOf = (html: string) => sha1(html).slice(0, 12);

/** The page and the scripts and styles it loads (relative paths, so it works in any folder). */
export function pageFiles(webDist: string): SiteFile[] {
  const html = fs.readFileSync(path.join(webDist, 'commentator.html'), 'utf8');
  // the build mark: an open screen compares it with status.json and reloads itself when the venue PC runs a newer app
  const build = buildOf(html);
  const page = html.replace(/(src|href)="\/assets\//g, '$1="assets/').replace('<head>', `<head>\n    <meta name="ssl-build" content="${build}" />`);
  const out: SiteFile[] = [{ rel: 'index.html', data: page }];
  const seen = new Set<string>();
  const queue = [...html.matchAll(/\/assets\/([\w.-]+)/g)].map((m) => m[1]);
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const file = path.join(webDist, 'assets', name);
    if (!fs.existsSync(file)) continue;
    const data = fs.readFileSync(file);
    out.push({ rel: `assets/${name}`, data });
    if (name.endsWith('.js') || name.endsWith('.css')) for (const m of data.toString('utf8').matchAll(/["'(]\.?\.?\/?(?:assets\/)?([\w-]+\.(?:js|css|woff2?|png|svg))["')]/g)) queue.push(m[1]);
  }
  return out;
}

/** data.json + pictures from a commentator snapshot; picture addresses become img/<sha1>.<ext>. */
export function dataFiles(feed: Feed, files: Map<string, string>): { data: string; images: { rel: string; file: string }[]; version: string } {
  let json = JSON.stringify({ pushedAt: feed.pushedAt, day: feed.day, routes: feed.routes });
  const images: { rel: string; file: string }[] = [];
  const seen = new Set<string>();
  const relOf = new Map<string, string>(); // the address as it is written inside the JSON → img/…
  for (const [url, b] of Object.entries(feed.blobs)) {
    const rel = `img/${b.hash}.${EXT[b.mime] ?? 'bin'}`;
    relOf.set(JSON.stringify(url).slice(1, -1), rel);
    const file = files.get(b.hash);
    if (file && !seen.has(rel)) { seen.add(rel); images.push({ rel, file }); }
  }
  // one pass over the (megabytes of) JSON instead of one per picture; longest first, so an address never matches inside a longer one
  if (relOf.size) {
    const re = new RegExp([...relOf.keys()].sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|'), 'g');
    json = json.replace(re, (m) => relOf.get(m) ?? m);
  }
  const version = sha1(JSON.stringify({ day: feed.day, routes: feed.routes, blobs: feed.blobs }));
  return { data: json.replace(`"pushedAt":${JSON.stringify(feed.pushedAt)}`, `"pushedAt":${JSON.stringify(feed.pushedAt)},"version":"${version}"`), images, version };
}

/** Writes the folder to disk (tests). */
export class LocalFolderTarget implements SiteTarget {
  label: string;
  constructor(private dir: string) { this.label = dir; }
  async put(files: SiteFile[], done: (rel: string) => void) {
    for (const f of files) {
      const full = path.join(this.dir, ...f.rel.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const tmp = `${full}.tmp`;
      fs.writeFileSync(tmp, f.data);
      fs.renameSync(tmp, full);
      done(f.rel);
    }
  }
}

export interface SiteStatus {
  lastAttemptAt: string | null; lastOkAt: string | null; lastChangeAt: string | null; error: string;
  url: string; uploadedFiles: number; dataBytes: number; pictures: number; target: string;
}

type Build = () => Promise<{ feed: Feed; files: Map<string, string> }>;
type MakeTarget = (db: DB, folderName: string) => SiteTarget | null;
interface SentState { target: string; files: Record<string, string> }

/** Builds the folder each round and sends only what changed. */
export class StaticSitePublisher {
  status: SiteStatus = { lastAttemptAt: null, lastOkAt: null, lastChangeAt: null, error: '', url: '', uploadedFiles: 0, dataBytes: 0, pictures: 0, target: '' };
  private sent = new Map<string, string>(); // rel → sha1 already on the target
  private sentTo = '';
  private current: Promise<SiteStatus> | null = null;
  private queued: Promise<SiteStatus> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private target: SiteTarget | null = null;
  private failures = 0;
  private retryAt = 0; // when the next routine round may start

  /**
   * everyMs: how often the timer looks; publishEveryMs: the time between routine rounds (the setting);
   * stateFile: where the list of files already on the target is kept, so a restart does not send everything again.
   */
  constructor(private db: DB, private build: Build, private webDist: string | undefined, private makeTarget: MakeTarget,
    private publishEveryMs: () => number = () => 60_000, private stateFile?: string, private everyMs = 5000) {
    try {
      const st = stateFile ? (JSON.parse(fs.readFileSync(stateFile, 'utf8')) as SentState) : null;
      if (st?.target) { this.sentTo = st.target; this.sent = new Map(Object.entries(st.files ?? {})); }
    } catch { /* first start, or an unreadable file: send everything once */ }
  }
  private saveSent() {
    if (!this.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(`${this.stateFile}.tmp`, JSON.stringify({ target: this.sentTo, files: Object.fromEntries(this.sent) } satisfies SentState));
      fs.renameSync(`${this.stateFile}.tmp`, this.stateFile);
    } catch { /* only costs a full send after the next restart */ }
  }

  /** The folder on the bucket (random, made once; the address of the page). */
  folderName(): string {
    let f = getSetting(this.db, 'static.folder');
    if (!f) { f = `komentator-${randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '')}`; setSetting(this.db, 'static.folder', f); }
    return f;
  }
  url() {
    const base = (getSetting(this.db, 'static.publicUrl').trim() || DEFAULT_PUBLIC_URL).replace(/\/+$/, '');
    return `${base}/${this.folderName()}/index.html`; // index.html: object stores have no folder index
  }
  enabled() { return getSetting(this.db, 'static.enabled') === '1'; }
  setEnabled(on: boolean) { setSetting(this.db, 'static.enabled', on ? '1' : ''); if (!on) this.status.error = ''; }
  /** Settings changed: a new round at once (files already on the same bucket are not sent again). */
  reset() { this.status.error = ''; this.failures = 0; this.retryAt = 0; void this.target?.close?.(); this.target = null; }

  start() {
    if (this.timer) return;
    // After failures, wait longer between attempts (5 s, 10 s, 20 s … up to 5 min).
    this.timer = setInterval(() => {
      if (!this.enabled() || Date.now() < this.retryAt || this.current) return;
      void this.publishNow();
    }, this.everyMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; void this.target?.close?.(); this.target = null; }

  /** Publish now. A round already under way is finished first and then one more starts, so the newest data always goes out. */
  publishNow(): Promise<SiteStatus> {
    if (this.current) {
      this.queued ??= this.current.then(() => { this.queued = null; return this.publishNow(); });
      return this.queued;
    }
    this.current = this.round().finally(() => { this.current = null; });
    return this.current;
  }

  private async round(): Promise<SiteStatus> {
    this.status.lastAttemptAt = nowIso();
    let target: SiteTarget | null = null;
    try {
      if (!this.webDist || !fs.existsSync(path.join(this.webDist, 'commentator.html'))) throw new Error('The commentator page is not built (npm run build).');
      const fresh = this.makeTarget(this.db, this.folderName());
      if (!fresh) throw new Error('Fill in where to publish the page.');
      if (fresh.label !== this.target?.label) { await this.target?.close?.().catch(() => undefined); this.target = fresh; }
      target = this.target;
      if (target.label !== this.sentTo) { this.sent.clear(); this.sentTo = target.label; this.saveSent(); }
      const { feed, files } = await this.build();
      const { data, images, version } = dataFiles(feed, files);
      const pending: SiteFile[] = [];
      const want = (rel: string, body: Buffer | string, hash = sha1(body)) => { if (this.sent.get(rel) !== hash) pending.push({ rel, data: body }); return hash; };
      const hashes = new Map<string, string>();
      // order matters: pictures and scripts first, then the data that points at them, the heartbeat last
      for (const f of pageFiles(this.webDist)) hashes.set(f.rel, want(f.rel, f.data));
      for (const img of images) {
        const h = img.rel.split('/')[1].split('.')[0];
        if (this.sent.get(img.rel) !== h) pending.push({ rel: img.rel, data: fs.readFileSync(img.file) });
        hashes.set(img.rel, h);
      }
      const dataChanged = this.sent.get('data.json') !== version;
      if (dataChanged) { pending.push({ rel: 'data.json', data }); hashes.set('data.json', version); }
      // auto: the page knows whether to expect a new status every few seconds or only when someone publishes
      const every = Math.round(this.publishEveryMs() / 1000);
      const build = buildOf(fs.readFileSync(path.join(this.webDist, 'commentator.html'), 'utf8'));
      const status = JSON.stringify({ pushedAt: feed.pushedAt, version, auto: this.enabled(), every, build });
      pending.push({ rel: 'status.json', data: status });
      try { await target.put(pending, (rel) => { const h = hashes.get(rel); if (h) this.sent.set(rel, h); }); }
      finally { this.saveSent(); }
      if (dataChanged) { this.status.lastChangeAt = feed.pushedAt; this.status.dataBytes = Buffer.byteLength(data); }
      this.status.uploadedFiles = pending.length;
      this.status.pictures = images.length;
      this.status.lastOkAt = nowIso();
      this.status.error = '';
      this.failures = 0;
      // the next routine round after the chosen time ('Publish now' and a settings change send at once)
      this.retryAt = Date.now() + this.publishEveryMs();
    } catch (e: any) {
      this.failures++;
      const wait = Math.min(300_000, this.everyMs * 2 ** Math.min(this.failures - 1, 10));
      this.retryAt = Date.now() + wait;
      this.status.error = `${String(e?.message ?? e).slice(0, 300)} (next try in ${Math.round(wait / 1000)} s)`;
      // a broken connection: start a new one next round
      try { await this.target?.close?.(); } catch { /* closing */ }
      this.target = null;
    } finally {
      this.status.target = target?.label ?? '';
      this.status.url = this.url();
    }
    return this.status;
  }
}
