import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrations } from './migrations.js';
export const newId = () => randomUUID();
export const nowIso = () => new Date().toISOString();
export function openDb(file) {
    if (file !== ':memory:')
        fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db);
    ensureDefaults(db);
    return db;
}
function migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
    for (const m of migrations) {
        if (applied.has(m.version))
            continue;
        db.transaction(() => {
            db.exec(m.sql);
            db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, nowIso());
        })();
    }
}
export const DEFAULT_SETTINGS = {
    'sync.url': 'https://onb.sslgoldcup.com/qualify3/index.php/en/daily-weight-declaration',
    'sync.enabled': 'false',
    'sync.intervalMinutes': '30',
    'sync.importer': 'ssl-fabrik-crew-list',
    'sync.lastAttemptAt': '',
    'sync.lastSuccessAt': '',
    'paths.vmixAssetsRoot': '',
};
function ensureDefaults(db) {
    const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS))
        ins.run(k, v);
    const ev = db.prepare('SELECT id FROM events WHERE is_active = 1').get();
    if (!ev) {
        const any = db.prepare('SELECT id FROM events ORDER BY created_at LIMIT 1').get();
        if (any)
            db.prepare('UPDATE events SET is_active = 1 WHERE id = ?').run(any.id);
        else {
            const t = nowIso();
            db.prepare('INSERT INTO events (id, name, timezone, year, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
                .run(newId(), 'Event', 'Europe/Warsaw', new Date().getFullYear(), t, t);
        }
    }
}
export function getSetting(db, key) {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return r?.value ?? DEFAULT_SETTINGS[key] ?? '';
}
export function setSetting(db, key, value) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
export function activeEvent(db) {
    return db.prepare('SELECT * FROM events WHERE is_active = 1 LIMIT 1').get();
}
