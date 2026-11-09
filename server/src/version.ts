import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface VersionInfo {
  version: string;
  commit: string;
  date: string;
  changes: { version: string; commit: string; date: string; text: string }[];
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** The build's version.json (written by scripts/version.mjs); from source it is read straight from git. */
function load(): VersionInfo {
  const file = path.join(here, 'version.json');
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as VersionInfo; } catch { /* fall through */ }
  const repo = path.resolve(here, '..', '..');
  try {
    const [major = '1', minor = '0'] = (JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version as string).split('.');
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const v = `${major}.${minor}.${git('rev-list', '--count', 'HEAD')}-dev`;
    const changes = git('log', '--no-merges', '-n', '30', '--format=%h%x09%cI%x09%s').split('\n').filter(Boolean)
      .map((l) => { const [commit, date, text] = l.split('\t'); return { version: v, commit, date, text }; });
    return { version: v, commit: git('rev-parse', '--short', 'HEAD'), date: git('log', '-1', '--format=%cI'), changes };
  } catch {
    return { version: '1.0.0-dev', commit: '', date: '', changes: [] };
  }
}

let cached: VersionInfo | null = null;
export function versionInfo(): VersionInfo { return (cached ??= load()); }
