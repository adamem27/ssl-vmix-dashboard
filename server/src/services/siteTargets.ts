import path from 'node:path';
import { DB, getSetting, setSetting } from '../db/db.js';
import { LocalFolderTarget, SiteTarget } from './staticSite.js';
import { FtpTarget } from './ftpTarget.js';
import { HttpsTarget, newKey } from './httpsTarget.js';
import { S3Target } from './s3Target.js';

/** Where the static commentator page is published, kept in settings (the FTP password is never sent back to the browser). */
export interface SiteSettings {
  mode: 'folder' | 'ftp' | 'https' | 's3'; localDir: string; publicUrl: string;
  ftpHost: string; ftpPort: number; ftpUser: string; ftpDir: string; ftpSecure: boolean; hasFtpPassword: boolean;
  s3Endpoint: string; s3Bucket: string; s3AccessKey: string; s3Region: string; hasS3Secret: boolean;
}

export function siteSettings(db: DB, defaultDir: string): SiteSettings {
  const g = (k: string) => getSetting(db, `static.${k}`);
  return {
    mode: (['ftp', 'https', 's3'] as const).find((m) => m === g('mode')) ?? 'folder',
    s3Endpoint: g('s3Endpoint'), s3Bucket: g('s3Bucket'), s3AccessKey: g('s3AccessKey'), s3Region: g('s3Region') || 'auto', hasS3Secret: !!g('s3Secret'),
    localDir: g('localDir') || defaultDir,
    publicUrl: g('publicUrl'),
    ftpHost: g('ftpHost'), ftpPort: Number(g('ftpPort')) || 21, ftpUser: g('ftpUser'), ftpDir: g('ftpDir'),
    ftpSecure: g('ftpSecure') !== 'off',
    hasFtpPassword: !!g('ftpPassword'),
  };
}

export function saveSiteSettings(db: DB, b: Partial<{ mode: string; localDir: string; publicUrl: string; ftpHost: string; ftpPort: number; ftpUser: string; ftpPassword: string; ftpDir: string; ftpSecure: boolean; s3Endpoint: string; s3Bucket: string; s3AccessKey: string; s3Secret: string; s3Region: string }>) {
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || k === 'enabled') continue;
    if (k === 'ftpSecure') setSetting(db, 'static.ftpSecure', v ? '' : 'off');
    else setSetting(db, `static.${k}`, typeof v === 'string' ? v.trim() : String(v));
  }
}

export function siteTarget(db: DB, folder: string, defaultDir: string): SiteTarget | null {
  const s = siteSettings(db, defaultDir);
  if (s.mode === 's3') {
    const secret = getSetting(db, 'static.s3Secret');
    const missing = [!s.s3Endpoint && 'S3 endpoint', !s.s3Bucket && 'Bucket', !s.s3AccessKey && 'Access Key ID', !secret && 'Secret Access Key'].filter(Boolean);
    if (missing.length) throw new Error(`Missing in Settings → Commentator online (click Save after typing): ${missing.join(', ')}.`);
    return new S3Target({ endpoint: s3Origin(s.s3Endpoint), bucket: s.s3Bucket.replace(/^\/+|\/+$/g, ''), accessKey: s.s3AccessKey, secret, region: s.s3Region || 'auto', folder });
  }
  if (s.mode === 'https') {
    const base = s.publicUrl.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) throw new Error('Fill in the web address of the folder (https://…), then Save.');
    return new HttpsTarget(`${base}/upload.php`, uploadKey(db), folder);
  }
  if (s.mode === 'ftp') {
    if (!s.ftpHost || !s.ftpUser) throw new Error('Fill in the FTP server and user, then Save.');
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

/** Endpoint as pasted from the Cloudflare dashboard: with or without https://, with or without /bucket at the end. */
export function s3Origin(endpoint: string): string {
  const e = endpoint.trim();
  try { return new URL(/^[a-z]+:\/\//i.test(e) ? e : `https://${e}`).origin; }
  catch { throw new Error(`The S3 endpoint "${e}" is not a web address; it looks like https://<account-id>.r2.cloudflarestorage.com`); }
}
