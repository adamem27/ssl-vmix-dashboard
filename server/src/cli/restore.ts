import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/** npm run restore -- <katalog kopii>. Run only with the server stopped. */
const src = process.argv[2];
if (!src) { console.error('Usage: npm run restore -- <backup folder>'); process.exit(1); }
const dir = path.resolve(src);
const dbFile = path.join(dir, 'ssl-vmix.sqlite');
if (!fs.existsSync(dbFile)) { console.error(`No ssl-vmix.sqlite file in ${dir}.`); process.exit(1); }

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
// Keep the current state aside instead of deleting it.
if (fs.existsSync(config.dbPath)) fs.renameSync(config.dbPath, `${config.dbPath}.before-restore-${stamp}`);
for (const ext of ['-wal', '-shm']) if (fs.existsSync(config.dbPath + ext)) fs.rmSync(config.dbPath + ext);
if (fs.existsSync(config.assetsDir)) fs.renameSync(config.assetsDir, `${config.assetsDir}.before-restore-${stamp}`);
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.copyFileSync(dbFile, config.dbPath);
if (fs.existsSync(path.join(dir, 'assets'))) fs.cpSync(path.join(dir, 'assets'), config.assetsDir, { recursive: true });
console.log(`Restored from ${dir}. Previous data kept with suffix .before-restore-${stamp}.`);
