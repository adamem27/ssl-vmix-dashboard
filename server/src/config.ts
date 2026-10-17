import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repo root: server/src/config.ts and server/dist/config.js both sit two levels below it. */
export const ROOT_DIR = path.resolve(here, '..', '..');

export const config = {
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(ROOT_DIR, 'data')),
  get dbPath() {
    return process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(this.dataDir, 'ssl-vmix.sqlite');
  },
  get assetsDir() {
    return process.env.ASSETS_DIR ? path.resolve(process.env.ASSETS_DIR) : path.join(this.dataDir, 'assets');
  },
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 4310),
  webDist: path.join(ROOT_DIR, 'web', 'dist'),
  /** Limit uploads to keep accidental huge files out of the store. */
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 40) * 1024 * 1024,
};
