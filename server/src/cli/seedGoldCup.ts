import { config } from '../config.js';
import { openDb } from '../db/db.js';
import { applyGoldCupAll } from '../services/presets.js';

const db = openDb(config.dbPath);
console.log('SSL Gold Cup 2026 matchboard:', applyGoldCupAll({ db, assetsDir: config.assetsDir }));
db.close();
