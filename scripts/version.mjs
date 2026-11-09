// Writes server/dist/version.json: the app's version and the list of changes, read from git.
// Version = MAJOR.MINOR from package.json + build number (commits in main up to this one), e.g. 1.0.75.
// Every push to main gets the next number on its own, so parallel work never collides on a version file.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [major = '1', minor = '0'] = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version.split('.');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
let info;
try {
  const count = (rev) => Number(git('rev-list', '--count', rev));
  const head = git('rev-parse', '--short', 'HEAD');
  const log = git('log', '--no-merges', '-n', '80', '--format=%H%x09%h%x09%cI%x09%s');
  const changes = log.split('\n').filter(Boolean).map((l) => {
    const [sha, short, date, subject] = l.split('\t');
    return { version: `${major}.${minor}.${count(sha)}`, commit: short, date, text: subject };
  });
  info = { version: `${major}.${minor}.${count('HEAD')}`, commit: head, date: git('log', '-1', '--format=%cI'), changes };
} catch (e) {
  info = { version: `${major}.${minor}.0-dev`, commit: '', date: new Date().toISOString(), changes: [] };
  console.warn(`version: git unavailable (${e.message.split('\n')[0]}), writing ${info.version}`);
}
const out = path.join(root, 'server', 'dist', 'version.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(info, null, 2));
console.log(`version ${info.version} (${info.commit}) → ${path.relative(root, out)}`);
