import { config } from '../config.js';
import { openDb } from '../db/db.js';
import { applyGoldCup2026 } from '../services/presets.js';

const db = openDb(config.dbPath);
console.log('SSL Gold Cup 2026 matchboard:', applyGoldCup2026(db));
db.close();
