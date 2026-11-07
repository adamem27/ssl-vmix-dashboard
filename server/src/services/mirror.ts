import fs from 'node:fs';
import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';

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

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Login cookie value: derived from the password, so changing the password logs everyone out. */
export const authToken = (password: string) => createHmac('sha256', password).update('ssl-vmix-dashboard login').digest('hex');

export function cookieOk(header: string | undefined, password: string): boolean {
  const m = /(?:^|;\s*)ssl_auth=([0-9a-f]+)/.exec(header ?? '');
  return !!m && safeEqual(m[1], authToken(password));
}

export const loginPage = (failed: boolean) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SSL vMix – login</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f17;color:#e6e9ef;font:15px system-ui,sans-serif}form{display:flex;flex-direction:column;gap:12px;width:280px}
b{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:4px;background:#2563eb;color:#fff;font-size:12px;margin-right:8px}input,button{font:inherit;padding:10px 12px;border-radius:6px;border:1px solid #2a3242;background:#131925;color:inherit}button{background:#2563eb;border-color:#2563eb;font-weight:600;cursor:pointer}p{margin:0;color:#f87171;font-size:13px}</style></head>
<body><form method="post" action="/login"><div><b>SSL</b>Regatta · broadcast</div><input type="password" name="password" placeholder="Password" autofocus required>${failed ? '<p>Wrong password.</p>' : ''}<button>Log in</button></form></body></html>`;
