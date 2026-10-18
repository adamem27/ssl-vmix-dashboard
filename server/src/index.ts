import { config } from './config.js';
import { openDb } from './db/db.js';
import { buildApp } from './app.js';
import { SyncService } from './services/sync.js';
import { WorkbookWriter } from './services/workbook.js';
import { applyGoldCupOnStart } from './services/presets.js';

const db = openDb(config.dbPath);
const sync = new SyncService(db);
const workbook = new WorkbookWriter({ db, assetsDir: config.assetsDir }, config.workbookFile, (m) => app.log.warn(m));
const app = await buildApp({ db, assetsDir: config.assetsDir, sync, workbook, webDist: config.webDist, dbPath: config.dbPath, maxUploadBytes: config.maxUploadBytes });

const preset = applyGoldCupOnStart({ db, assetsDir: config.assetsDir });
if (preset) app.log.info(`SSL Gold Cup data applied: ${JSON.stringify(preset)}`);
sync.start();
workbook.start();
await app.listen({ host: config.host, port: config.port });
app.log.info(`Database: ${config.dbPath}`);
app.log.info(`Assets folder: ${config.assetsDir}`);
app.log.info(`Workbook for vMix: ${config.workbookFile}`);
app.log.info(`Dashboard: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);

const shutdown = async () => {
  sync.stop();
  workbook.stop();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
