import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DB, getSetting, nowIso, setSetting } from '../db/db.js';
import type { Feed } from './liveFeed.js';

/**
 * The commentator screen as a static web page.
 *
 * Every few seconds the venue PC writes a folder that any plain web host can serve:
 *   index.html, assets/*.js|css   the screen (built once with the app: web/dist/commentator.html)
 *   data.json                     every answer the screen needs, picture addresses pointing at img/
 *   img/<sha1>.<ext>              flags, emblems and photos
 *   status.json                   { pushedAt, version }: tiny, rewritten every round so the screen knows the data is fresh
 * Then it uploads what changed. Nothing runs on the host but the web server, so there is nothing there to crash.
 * The folder name has a random part: the address is the key, and the page holds nothing that can be changed.
 */

export interface SiteFile { rel: string; data: Buffer | string }
/** Where the folder goes: a local folder, or a web host. */
export interface SiteTarget {
  label: string;
  /** Writes the files in order; calls done() after each one, so a broken connection only resends the rest. */
  put(files: SiteFile[], done: (rel: string) => void): Promise<void>;
  close?(): Promise<void>;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
const sha1 = (b: Buffer | string) => createHash('sha1').update(b).digest('hex');

/** The page and the scripts and styles it loads (relative paths, so it works in any folder). */
export function pageFiles(webDist: string): SiteFile[] {
  const html = fs.readFileSync(path.join(webDist, 'commentator.html'), 'utf8');
  const out: SiteFile[] = [{ rel: 'index.html', data: html.replace(/(src|href)="\/assets\//g, '$1="assets/') }];
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
  // longest first, so an address never matches inside a longer one
  for (const [url, b] of Object.entries(feed.blobs).sort((a, b2) => b2[0].length - a[0].length)) {
    const rel = `img/${b.hash}.${EXT[b.mime] ?? 'bin'}`;
    json = json.split(JSON.stringify(url).slice(1, -1)).join(rel);
    const file = files.get(b.hash);
    if (file && !images.some((i) => i.rel === rel)) images.push({ rel, file });
  }
  const version = sha1(JSON.stringify({ day: feed.day, routes: feed.routes, blobs: feed.blobs }));
  return { data: json.replace(`"pushedAt":${JSON.stringify(feed.pushedAt)}`, `"pushedAt":${JSON.stringify(feed.pushedAt)},"version":"${version}"`), images, version };
}

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

/** Builds the folder each round and sends only what changed. */
export class StaticSitePublisher {
  status: SiteStatus = { lastAttemptAt: null, lastOkAt: null, lastChangeAt: null, error: '', url: '', uploadedFiles: 0, dataBytes: 0, pictures: 0, target: '' };
  private sent = new Map<string, string>(); // rel → sha1 already on the target
  private sentTo = '';
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private target: SiteTarget | null = null;
  private failures = 0;
  private retryAt = 0; // kept between rounds: one FTP connection, not one every 5 s

  constructor(private db: DB, private build: Build, private webDist: string | undefined, private makeTarget: MakeTarget, private everyMs = 5000) {}

  /** Random part of the address; a new one moves the page (the old address keeps its last data until removed on the host). */
  folderName(): string {
    let f = getSetting(this.db, 'static.folder');
    if (!f) { f = `komentator-${randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '')}`; setSetting(this.db, 'static.folder', f); }
    return f;
  }
  newFolder() { setSetting(this.db, 'static.folder', ''); this.sent.clear(); return this.folderName(); }
  url() {
    const base = getSetting(this.db, 'static.publicUrl').trim().replace(/\/+$/, '');
    return base ? `${base}/${this.folderName()}/index.html` : ''; // index.html: object stores have no folder index
  }
  enabled() { return getSetting(this.db, 'static.enabled') === '1'; }
  setEnabled(on: boolean) { setSetting(this.db, 'static.enabled', on ? '1' : ''); if (!on) this.status.error = ''; }
  /** Settings changed: send everything again on the next round. */
  reset() { this.status.error = ''; this.failures = 0; this.retryAt = 0; this.sent.clear(); this.sentTo = ''; void this.target?.close?.(); this.target = null; }

  start() {
    if (this.timer) return;
    // After failures, wait longer between attempts (5 s, 10 s, 20 s … up to 5 min): a host's firewall bans an
    // address that keeps failing to connect, and a ban blocks the page for everyone on that network.
    this.timer = setInterval(() => {
      if (!this.enabled() || Date.now() < this.retryAt) return;
      void this.publishNow();
    }, this.everyMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; void this.target?.close?.(); this.target = null; }

  async publishNow(): Promise<SiteStatus> {
    if (this.running) return this.status;
    this.running = true;
    this.status.lastAttemptAt = nowIso();
    let target: SiteTarget | null = null;
    try {
      if (!this.webDist || !fs.existsSync(path.join(this.webDist, 'commentator.html'))) throw new Error('The commentator page is not built (npm run build).');
      const fresh = this.makeTarget(this.db, this.folderName());
      if (!fresh) throw new Error('Fill in where to publish the page.');
      if (fresh.label !== this.target?.label) { await this.target?.close?.().catch(() => undefined); this.target = fresh; }
      target = this.target;
      if (target.label !== this.sentTo) { this.sent.clear(); this.sentTo = target.label; }
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
      const status = JSON.stringify({ pushedAt: feed.pushedAt, version });
      pending.push({ rel: 'status.json', data: status });
      await target.put(pending, (rel) => { const h = hashes.get(rel); if (h) this.sent.set(rel, h); });
      if (dataChanged) { this.status.lastChangeAt = feed.pushedAt; this.status.dataBytes = Buffer.byteLength(data); }
      this.status.uploadedFiles = pending.length;
      this.status.pictures = images.length;
      this.status.lastOkAt = nowIso();
      this.status.error = '';
      this.failures = 0;
      this.retryAt = 0;
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
      this.running = false;
    }
    return this.status;
  }
}
