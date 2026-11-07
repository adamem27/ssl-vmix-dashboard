// Assembles a prebuilt, workspace-free copy of the app for hosting panels whose npm
// cannot install workspaces (e.g. CloudLinux "Node.js App" in DirectAdmin).
// Usage: npm run build && node scripts/build-deploy.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'deploy'));
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

for (const p of ['server/dist', 'web/dist']) {
  if (!fs.existsSync(path.join(root, p))) { console.error(`${p} is missing: run npm run build first.`); process.exit(1); }
}

// Keep .git and node_modules (a symlink on CloudLinux) when refreshing an existing checkout.
fs.mkdirSync(out, { recursive: true });
for (const name of fs.readdirSync(out)) if (name !== '.git' && name !== 'node_modules') fs.rmSync(path.join(out, name), { recursive: true, force: true });

const copy = (p) => fs.cpSync(path.join(root, p), path.join(out, p), { recursive: true });
['server/dist', 'server/fixtures', 'web/dist', 'app.cjs'].forEach(copy);

// Pin the versions that were built and tested.
const server = read('server/package.json');
const lock = read('package-lock.json');
const dependencies = Object.fromEntries(Object.keys(server.dependencies).map((d) => [d, lock.packages[`node_modules/${d}`]?.version ?? server.dependencies[d]]));
const top = read('package.json');
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: top.name, private: true, version: top.version, engines: top.engines, scripts: { start: 'node app.cjs' }, dependencies }, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'server', 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');
fs.writeFileSync(path.join(out, '.gitignore'), 'node_modules\n');
fs.writeFileSync(path.join(out, 'README.md'), `Prebuilt copy of ssl-vmix-dashboard for hosting (built from main). Do not edit here.\n\nnpm install, then start app.cjs (or npm start).\n`);
console.log(`Deploy copy written to ${out}`);
