import fs from 'node:fs';
import path from 'node:path';

const WIN_DRIVE = /^[a-zA-Z]:[\\/]/;
const UNC = /^\\\\[^\\/]+[\\/][^\\/]+/;

export function isWindowsPath(p: string) { return WIN_DRIVE.test(p) || UNC.test(p); }
export function isUncPath(p: string) { return UNC.test(p); }

/** Paths the operator may type: Windows drive, UNC, or absolute POSIX. */
export function validateEnteredPath(p: string): string | null {
  const v = p.trim();
  if (!v) return 'Ścieżka jest pusta.';
  if (/^(https?|file):/i.test(v)) return 'Podaj ścieżkę pliku (np. D:\\SSL\\flag.png lub \\\\SERWER\\udzial\\flag.png), a nie adres URL.';
  if (!isWindowsPath(v) && !v.startsWith('/')) return 'Ścieżka musi być bezwzględna: litera dysku (D:\\...), UNC (\\\\SERWER\\udzial\\...) lub /...';
  return null;
}

function normSep(p: string) { return p.replace(/\//g, '\\').replace(/\\+$/, ''); }

/** Join a vMix-side root (Windows or UNC, sometimes POSIX) with a relative path using the root's separator. */
export function joinVmixPath(root: string, rel: string): string {
  if (isWindowsPath(root)) return normSep(root) + '\\' + rel.replace(/\//g, '\\');
  return root.replace(/\/+$/, '') + '/' + rel.replace(/\\/g, '/');
}

/**
 * Where the dashboard server could read an operator-entered path, if anywhere.
 * 1) paths under the configured vMix assets root map back into the local assets dir;
 * 2) paths native to the server's OS are tried as-is.
 */
export function localCandidate(entered: string, vmixRoot: string, assetsDir: string): string | null {
  const v = entered.trim();
  if (vmixRoot) {
    const a = normSep(v).toLowerCase();
    const r = normSep(vmixRoot).toLowerCase();
    if (a.startsWith(r + '\\')) {
      const rest = normSep(v).slice(r.length + 1).split('\\');
      const resolved = path.resolve(assetsDir, ...rest);
      if (resolved.startsWith(path.resolve(assetsDir) + path.sep)) return resolved;
      return null;
    }
  }
  if (process.platform === 'win32' ? isWindowsPath(v) : v.startsWith('/')) return v;
  return null;
}

export function readIfExists(p: string): Buffer | null {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    return fs.readFileSync(p);
  } catch { return null; }
}
