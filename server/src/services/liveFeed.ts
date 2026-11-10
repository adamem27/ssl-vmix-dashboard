import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { activeEvent, DB, getSetting, nowIso, setSetting } from '../db/db.js';
import { AssetCtx, previewFile } from './assets.js';
import { todayIn } from './dates.js';

/**
 * Commentator screen online, read-only.
 *
 * The PC at the venue (the dashboard with the real data) pushes a snapshot of everything the commentator screen reads
 * to the online dashboard every few seconds: the JSON answers of a handful of GET routes plus the pictures they point at.
 * The online dashboard serves that snapshot to anyone holding the commentator link (/c/<token>), and nothing else:
 * viewers cannot write and cannot read the rest of the API. The venue PC is never reachable from the internet.
 */

// ---------- shared: which requests a commentator may make ----------

/** Routes the commentator screen reads. Anything else is refused for a viewer. */
const VIEWER_ROUTES: RegExp[] = [
  /^\/api\/meta$/, /^\/api\/stage$/, /^\/api\/fleet-sets$/, /^\/api\/fleet-sets\/[\w-]+$/,
  /^\/api\/overview$/, /^\/api\/commentator$/, /^\/api\/assets\/[\w-]+\/file$/, /^\/api\/live\/status$/, /^\/api\/version$/,
];
/** Lets the venue dashboard read its own routes for the snapshot even when it has a password. */
export const INTERNAL_KEY = randomBytes(24).toString('hex');

export const viewerMayRead = (pathname: string) => VIEWER_ROUTES.some((r) => r.test(pathname));

/** Snapshot key of an API request: the path, plus the fleet set when the route takes one (the day is the venue's today). */
export function feedKey(pathname: string, query: URLSearchParams): string {
  const set = query.get('set');
  return set && (pathname === '/api/overview' || pathname === '/api/commentator') ? `${pathname}?set=${set}` : pathname;
}

const IMAGE_URL = /\/api\/assets\/[\w-]+\/file(?:\?v=[^"\\]*)?/g;

/** Content type of a gzipped full snapshot. */
export const FEED_TYPE = 'application/x-ssl-feed+gzip';

export interface Feed {
  version: 1;
  /** When the venue PC built it. */
  pushedAt: string;
  day: string;
  routes: Record<string, unknown>;
  /** Picture URL as the JSON has it → stored file. */
  blobs: Record<string, { hash: string; mime: string }>;
}

// ---------- receiving side (online dashboard) ----------

const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export class LiveFeedStore {
  feed: Feed | null = null;
  hash = '';
  receivedAt: string | null = null;
  from = '';
  private blobsDir: string;

  constructor(private db: DB, private dir: string) {
    this.blobsDir = path.join(dir, 'blobs');
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'feed.json'), 'utf8'));
      if (saved?.feed?.version === 1) Object.assign(this, { feed: saved.feed, hash: saved.hash, receivedAt: saved.receivedAt, from: saved.from ?? '' });
    } catch { /* nothing pushed yet */ }
  }

  /** The secret in the commentator link; made on first use, replaced by rotate(). */
  token(): string {
    let t = getSetting(this.db, 'live.viewerToken');
    if (!t) { t = randomBytes(18).toString('base64url'); setSetting(this.db, 'live.viewerToken', t); }
    return t;
  }
  rotate(): string { setSetting(this.db, 'live.viewerToken', ''); return this.token(); }
  viewerPath() { return `/c/${this.token()}`; }
  tokenOk(given: string) { return !!given && safeEqual(given, this.token()); }
  /** Viewer cookie value: derived from the token, so a new token shuts out every old link and cookie. */
  cookieValue() { return createHmac('sha256', this.token()).update('ssl-vmix commentator').digest('hex'); }
  cookieOk(header: string | undefined) {
    const m = /(?:^|;\s*)ssl_view=([0-9a-f]+)/.exec(header ?? '');
    return !!m && safeEqual(m[1], this.cookieValue());
  }

  hasBlob(hash: string) { return /^[0-9a-f]{40}$/.test(hash) && fs.existsSync(path.join(this.blobsDir, hash)); }
  blobPath(hash: string) { return path.join(this.blobsDir, hash); }
  saveBlob(hash: string, buf: Buffer): boolean {
    if (!/^[0-9a-f]{40}$/.test(hash) || createHash('sha1').update(buf).digest('hex') !== hash) return false;
    fs.mkdirSync(this.blobsDir, { recursive: true });
    const tmp = path.join(this.blobsDir, `${hash}.tmp`);
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, path.join(this.blobsDir, hash));
    return true;
  }

  /** Stores a full snapshot; returns the pictures still to upload. */
  accept(feed: Feed, from: string): string[] {
    this.feed = feed;
    this.hash = feedHash(feed);
    this.touch(from, feed.pushedAt);
    const used = new Set(Object.values(feed.blobs).map((b) => b.hash));
    this.prune(used);
    return [...used].filter((h) => !this.hasBlob(h));
  }
  /** Same data as before: only the time moves on, so the commentator sees the link is alive. */
  touch(from: string, pushedAt: string) {
    if (!this.feed) return;
    this.feed.pushedAt = pushedAt;
    this.receivedAt = nowIso();
    this.from = from.slice(0, 100);
    this.save();
  }
  private save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = path.join(this.dir, 'feed.json.tmp');
      fs.writeFileSync(tmp, JSON.stringify({ feed: this.feed, hash: this.hash, receivedAt: this.receivedAt, from: this.from }));
      fs.renameSync(tmp, path.join(this.dir, 'feed.json'));
    } catch { /* kept in memory */ }
  }
  /** Old pictures go once no snapshot uses them. */
  private prune(used: Set<string>) {
    let names: string[] = [];
    try { names = fs.readdirSync(this.blobsDir); } catch { return; }
    for (const n of names) if (!used.has(n)) { try { fs.unlinkSync(path.join(this.blobsDir, n)); } catch { /* in use */ } }
  }
  clear() {
    this.feed = null; this.hash = ''; this.receivedAt = null; this.from = '';
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* gone */ }
  }
  status() {
    return { feed: this.feed ? { pushedAt: this.feed.pushedAt, receivedAt: this.receivedAt, from: this.from, day: this.feed.day } : null, now: nowIso() };
  }
}

export const feedHash = (feed: Pick<Feed, 'routes' | 'blobs' | 'day'>) =>
  createHash('sha1').update(JSON.stringify({ day: feed.day, routes: feed.routes, blobs: feed.blobs })).digest('hex');

// ---------- sending side (dashboard at the venue) ----------

export interface PushStatus {
  lastAttemptAt: string | null; lastOkAt: string | null; lastChangeAt: string | null; error: string;
  viewerUrl: string; bytes: number; pictures: number;
}

type Fetch = typeof fetch;

export class LiveFeedPusher {
  status: PushStatus = { lastAttemptAt: null, lastOkAt: null, lastChangeAt: null, error: '', viewerUrl: '', bytes: 0, pictures: 0 };
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private sentHash = '';
  private sentTarget = '';
  private hashes = new Map<string, string>(); // picture URL → sha1 (URLs carry the file's version)

  constructor(private app: FastifyInstance, private ctx: AssetCtx, private doFetch: Fetch = fetch, private everyMs = 5000) {}

  settings() {
    return {
      target: getSetting(this.ctx.db, 'live.target'),
      enabled: getSetting(this.ctx.db, 'live.enabled') === '1',
      hasPassword: !!getSetting(this.ctx.db, 'live.password'),
    };
  }
  save(s: { target?: string; password?: string; enabled?: boolean }) {
    if (s.target !== undefined) setSetting(this.ctx.db, 'live.target', s.target.trim().replace(/\/+$/, ''));
    if (s.password !== undefined) setSetting(this.ctx.db, 'live.password', s.password);
    if (s.enabled !== undefined) setSetting(this.ctx.db, 'live.enabled', s.enabled ? '1' : '');
    this.sentHash = '';
    if (!this.settings().enabled) this.status.error = '';
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { if (this.settings().enabled) void this.pushNow().catch(() => undefined); }, this.everyMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** The snapshot, built from the same routes the commentator screen calls. */
  async build(): Promise<{ feed: Feed; files: Map<string, string> }> {
    const ev = activeEvent(this.ctx.db);
    const day = todayIn(ev.timezone);
    const get = async (url: string) => {
      const r = await this.app.inject({ method: 'GET', url, headers: { 'x-ssl-internal': INTERNAL_KEY } });
      if (r.statusCode !== 200) throw new Error(`${url}: HTTP ${r.statusCode}`);
      return r.json();
    };
    const routes: Record<string, unknown> = {};
    routes['/api/meta'] = await get('/api/meta');
    routes['/api/stage'] = await get('/api/stage');
    const sets = (await get('/api/fleet-sets')) as { id: string }[];
    routes['/api/fleet-sets'] = sets;
    for (const s of sets) {
      routes[`/api/fleet-sets/${s.id}`] = await get(`/api/fleet-sets/${s.id}`);
      routes[`/api/overview?set=${s.id}`] = await get(`/api/overview?date=${day}&set=${s.id}`);
      routes[`/api/commentator?set=${s.id}`] = await get(`/api/commentator?set=${s.id}&date=${day}`);
    }
    const blobs: Feed['blobs'] = {};
    const files = new Map<string, string>(); // hash → local file
    for (const url of new Set(JSON.stringify(routes).match(IMAGE_URL) ?? [])) {
      const id = /\/api\/assets\/([\w-]+)\/file/.exec(url)![1];
      const f = previewFile(this.ctx, id);
      if (!f) continue;
      let hash = this.hashes.get(url);
      if (!hash) {
        try { hash = createHash('sha1').update(fs.readFileSync(f.path)).digest('hex'); } catch { continue; }
        this.hashes.set(url, hash);
      }
      blobs[url] = { hash, mime: f.mime };
      files.set(hash, f.path);
    }
    return { feed: { version: 1, pushedAt: nowIso(), day, routes, blobs }, files };
  }

  /** One round: the full snapshot when something changed, otherwise a short "still here". */
  async pushNow(): Promise<PushStatus> {
    if (this.running) return this.status;
    this.running = true;
    const { target } = this.settings();
    const password = getSetting(this.ctx.db, 'live.password');
    this.status.lastAttemptAt = nowIso();
    try {
      if (!/^https?:\/\/[^/]+/i.test(target)) throw new Error('Enter the online dashboard address, e.g. https://sslgfx.em27code.com');
      const headers = { authorization: 'Basic ' + Buffer.from(`push:${password}`).toString('base64') };
      const call = async (url: string, init: RequestInit) => {
        let res: Response;
        try { res = await this.doFetch(target + url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) }, signal: AbortSignal.timeout(20_000) }); }
        catch (e: any) { throw new Error(`Cannot reach ${target}: ${e?.cause?.code ?? e?.message ?? e}`); }
        const text = await res.text();
        let body: any = null;
        try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        if (res.status === 401) throw new Error('The online dashboard refused the password.');
        return { status: res.status, body };
      };
      const { feed, files } = await this.build();
      const hash = feedHash(feed);
      let r = hash === this.sentHash && target === this.sentTarget
        ? await call('/api/live-feed/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash, pushedAt: feed.pushedAt }) })
        : null;
      if (!r || r.status === 409) {
        // gzip: the JSON shrinks about tenfold, which matters on a venue connection
        const body = gzipSync(JSON.stringify(feed));
        r = await call('/api/live-feed/push', { method: 'POST', headers: { 'content-type': FEED_TYPE }, body });
        this.status.bytes = body.length;
        this.status.lastChangeAt = feed.pushedAt;
      }
      if (r.status !== 200) throw new Error(r.body?.error ?? `The online dashboard answered HTTP ${r.status}.`);
      for (const h of (r.body?.missing ?? []) as string[]) {
        const file = files.get(h);
        if (!file) continue;
        const up = await call(`/api/live-feed/blob/${h}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: fs.readFileSync(file) });
        if (up.status !== 200) throw new Error(up.body?.error ?? `Picture upload failed (HTTP ${up.status}).`);
      }
      this.sentHash = hash;
      this.sentTarget = target;
      this.status.pictures = Object.keys(feed.blobs).length;
      this.status.viewerUrl = r.body?.viewerPath ? target + r.body.viewerPath : '';
      this.status.lastOkAt = nowIso();
      this.status.error = '';
    } catch (e: any) {
      this.status.error = String(e?.message ?? e).slice(0, 300);
      this.sentHash = '';
    } finally {
      this.running = false;
    }
    return this.status;
  }
}
