import { config } from './config.js';
import { openDb } from './db/db.js';
import { buildApp } from './app.js';
import { SyncService } from './services/sync.js';

const db = openDb(config.dbPath);
const sync = new SyncService(db);
const app = await buildApp({ db, assetsDir: config.assetsDir, sync, webDist: config.webDist, dbPath: config.dbPath, maxUploadBytes: config.maxUploadBytes });

sync.start();
await app.listen({ host: config.host, port: config.port });
app.log.info(`Database: ${config.dbPath}`);
app.log.info(`Assets folder: ${config.assetsDir}`);
app.log.info(`Dashboard: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);

const shutdown = async () => {
  sync.stop();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
