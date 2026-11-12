import path from 'node:path';
import { DB, getSetting, setSetting } from '../db/db.js';
import { LocalFolderTarget, SiteTarget } from './staticSite.js';
import { FtpTarget } from './ftpTarget.js';
import { HttpsTarget, newKey } from './httpsTarget.js';

/** Where the static commentator page is published, kept in settings (the FTP password is never sent back to the browser). */
export interface SiteSettings {
  mode: 'folder' | 'ftp' | 'https'; localDir: string; publicUrl: string;
  ftpHost: string; ftpPort: number; ftpUser: string; ftpDir: string; ftpSecure: boolean; hasFtpPassword: boolean;
}

export function siteSettings(db: DB, defaultDir: string): SiteSettings {
  const g = (k: string) => getSetting(db, `static.${k}`);
  return {
    mode: g('mode') === 'ftp' ? 'ftp' : g('mode') === 'https' ? 'https' : 'folder',
    localDir: g('localDir') || defaultDir,
    publicUrl: g('publicUrl'),
    ftpHost: g('ftpHost'), ftpPort: Number(g('ftpPort')) || 21, ftpUser: g('ftpUser'), ftpDir: g('ftpDir'),
    ftpSecure: g('ftpSecure') !== 'off',
    hasFtpPassword: !!g('ftpPassword'),
  };
}

export function saveSiteSettings(db: DB, b: Partial<{ mode: string; localDir: string; publicUrl: string; ftpHost: string; ftpPort: number; ftpUser: string; ftpPassword: string; ftpDir: string; ftpSecure: boolean }>) {
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || k === 'enabled') continue;
    if (k === 'ftpSecure') setSetting(db, 'static.ftpSecure', v ? '' : 'off');
    else setSetting(db, `static.${k}`, typeof v === 'string' ? v.trim() : String(v));
  }
}

export function siteTarget(db: DB, folder: string, defaultDir: string): SiteTarget | null {
  const s = siteSettings(db, defaultDir);
  if (s.mode === 'https') {
    const base = s.publicUrl.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) return null;
    return new HttpsTarget(`${base}/upload.php`, uploadKey(db), folder);
  }
  if (s.mode === 'ftp') {
    if (!s.ftpHost || !s.ftpUser) return null;
    return new FtpTarget({ host: s.ftpHost, port: s.ftpPort, user: s.ftpUser, password: getSetting(db, 'static.ftpPassword'), secure: s.ftpSecure, dir: [s.ftpDir.replace(/\/+$/, ''), folder].filter(Boolean).join('/') });
  }
  return new LocalFolderTarget(path.join(s.localDir, folder));
}

/** Secret the dashboard sends to upload.php; made on first use. */
export function uploadKey(db: DB): string {
  let k = getSetting(db, 'static.uploadKey');
  if (!k) { k = newKey(); setSetting(db, 'static.uploadKey', k); }
  return k;
}
