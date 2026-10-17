import { config } from '../config.js';
import { openDb } from '../db/db.js';
import { removeDemo, seedDemo } from '../services/demo.js';

const db = openDb(config.dbPath);
const ctx = { db, assetsDir: config.assetsDir };
if (process.argv.includes('--remove')) console.log('Usunięto dane DEMO:', removeDemo(ctx));
else console.log(seedDemo(ctx).created ? 'Dodano dane DEMO.' : 'Dane DEMO już istnieją.');
db.close();
