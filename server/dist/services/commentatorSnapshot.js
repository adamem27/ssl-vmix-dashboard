import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { activeEvent, nowIso } from '../db/db.js';
import { previewFile } from './assets.js';
import { todayIn } from './dates.js';
/**
 * Everything the commentator screen reads, in one snapshot: the JSON answers of a handful of GET routes
 * plus the pictures they point at. The static commentator page (Settings → Commentator online) is built from it.
 */
/** Lets the dashboard read its own routes for the snapshot even when it has a password. */
export const INTERNAL_KEY = randomBytes(24).toString('hex');
const IMAGE_URL = /\/api\/assets\/[\w-]+\/file(?:\?v=[^"\\]*)?/g;
export class CommentatorSnapshot {
    app;
    ctx;
    hashes = new Map(); // picture URL → sha1 (URLs carry the file's version)
    constructor(app, ctx) {
        this.app = app;
        this.ctx = ctx;
    }
    /** The snapshot, built from the same routes the commentator screen calls. */
    async build() {
        const ev = activeEvent(this.ctx.db);
        const day = todayIn(ev.timezone);
        const get = async (url) => {
            const r = await this.app.inject({ method: 'GET', url, headers: { 'x-ssl-internal': INTERNAL_KEY } });
            if (r.statusCode !== 200)
                throw new Error(`${url}: HTTP ${r.statusCode}`);
            return r.json();
        };
        const routes = {};
        routes['/api/meta'] = await get('/api/meta');
        routes['/api/stage'] = await get('/api/stage');
        const sets = (await get('/api/fleet-sets'));
        routes['/api/fleet-sets'] = sets;
        for (const s of sets) {
            routes[`/api/fleet-sets/${s.id}`] = await get(`/api/fleet-sets/${s.id}`);
            routes[`/api/overview?set=${s.id}`] = await get(`/api/overview?date=${day}&set=${s.id}`);
            routes[`/api/commentator?set=${s.id}`] = await get(`/api/commentator?set=${s.id}&date=${day}`);
        }
        const blobs = {};
        const files = new Map(); // hash → local file
        for (const url of new Set(JSON.stringify(routes).match(IMAGE_URL) ?? [])) {
            const id = /\/api\/assets\/([\w-]+)\/file/.exec(url)[1];
            const f = previewFile(this.ctx, id);
            if (!f)
                continue;
            let hash = this.hashes.get(url);
            if (!hash) {
                try {
                    hash = createHash('sha1').update(fs.readFileSync(f.path)).digest('hex');
                }
                catch {
                    continue;
                }
                this.hashes.set(url, hash);
            }
            blobs[url] = { hash, mime: f.mime };
            files.set(hash, f.path);
        }
        return { feed: { version: 1, pushedAt: nowIso(), day, routes, blobs }, files };
    }
}
