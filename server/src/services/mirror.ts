import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

export interface MirrorFile { path: string; size: number; mtime: number }

/** Every file in the assets folder (workbook included), with forward-slash relative paths. */
export function listMirrorFiles(assetsDir: string): MirrorFile[] {
  const out: MirrorFile[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile() && !e.name.endsWith('.tmp')) {
        const st = fs.statSync(full);
        out.push({ path: r, size: st.size, mtime: Math.floor(st.mtimeMs) });
      }
    }
  };
  walk(assetsDir, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Resolves a manifest path inside the assets folder; null when it would escape it. */
export function mirrorFilePath(assetsDir: string, rel: string): string | null {
  const root = path.resolve(assetsDir);
  const full = path.resolve(root, ...rel.split('/'));
  return full.startsWith(root + path.sep) ? full : null;
}

/** Basic auth check; any user name, the password must match. */
export function passwordOk(header: string | undefined, password: string): boolean {
  const m = /^Basic\s+(.+)$/i.exec(header ?? '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const given = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
  const want = Buffer.from(password);
  return given.length === want.length && timingSafeEqual(given, want);
}
