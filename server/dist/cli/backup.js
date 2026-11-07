import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config, ROOT_DIR } from '../config.js';
/**
 * Consistent backup while the server runs: SQLite online backup API + copy of the assets dir.
 *   npm run backup                 → backups/<timestamp>/
 *   npm run backup -- D:\Kopie     → D:\Kopie\<timestamp>\
 */
const target = path.resolve(process.argv[2] ?? path.join(ROOT_DIR, 'backups'));
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const dir = path.join(target, stamp);
fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(config.dbPath)) {
    console.error(`Database not found: ${config.dbPath}`);
    process.exit(1);
}
const db = new Database(config.dbPath, { readonly: true });
await db.backup(path.join(dir, 'ssl-vmix.sqlite'));
db.close();
if (fs.existsSync(config.assetsDir))
    fs.cpSync(config.assetsDir, path.join(dir, 'assets'), { recursive: true });
console.log(`Backup: ${dir}`);
