import { config } from '../config.js';
import { openDb } from '../db/db.js';
import { removeDemo, seedDemo } from '../services/demo.js';

const db = openDb(config.dbPath);
const ctx = { db, assetsDir: config.assetsDir };
if (process.argv.includes('--remove')) console.log('Removed DEMO data:', removeDemo(ctx));
else console.log(seedDemo(ctx).created ? 'Added DEMO data.' : 'DEMO data already exists.');
db.close();
