// Runs on the vMix machine: keeps a local copy of the online dashboard's files
// (images, ssl-vmix.xlsx) plus ssl-vmix.json, so vMix only ever reads local paths.
// No dependencies; needs Node 18+.  Usage: node vmix-sync/vmix-sync.mjs [--once]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(here, 'config.json');
const STATE_NAME = '.vmix-sync-state.json';
const JSON_NAME = 'ssl-vmix.json';
const INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? 2000);
const once = process.argv.includes('--once');

const time = () => new Date().toTimeString().slice(0, 8);
const log = (msg) => console.log(`${time()}  ${msg}`);

async function loadConfig() {
  const env = { server: process.env.SYNC_SERVER, password: process.env.SYNC_PASSWORD, folder: process.env.SYNC_FOLDER };
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* first run */ }
  cfg = { ...cfg, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v)) };
  if (cfg.server && cfg.folder) return cfg;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def || '';
  cfg.server = await ask('Dashboard address (e.g. https://ssl-dashboard.example.com)', cfg.server);
  cfg.password = await ask('Dashboard password (empty if none)', cfg.password);
  const defFolder = process.platform === 'win32' ? 'C:\\SSL-vMix' : path.join(process.env.HOME ?? '.', 'SSL-vMix');
  cfg.folder = await ask('Local folder for vMix', cfg.folder ?? defFolder);
  rl.close();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  log(`Saved settings to ${CONFIG_FILE}`);
  return cfg;
}

const cfg = await loadConfig();
const base = cfg.server.replace(/\/+$/, '');
const folder = path.resolve(cfg.folder);
const headers = cfg.password ? { authorization: 'Basic ' + Buffer.from(`vmix:${cfg.password}`).toString('base64') } : {};
fs.mkdirSync(folder, { recursive: true });

const stateFile = path.join(folder, STATE_NAME);
let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* fresh folder */ }
const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state));

async function get(url) {
  const res = await fetch(base + url, { headers });
  if (res.status === 401) throw new Error('Wrong password (edit or delete vmix-sync/config.json).');
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

/** Write via a temp file; if vMix holds the file open the rename fails and the next round retries. */
function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, buf);
  try { fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

const localPath = (rel) => {
  const full = path.resolve(folder, ...rel.split('/'));
  if (!full.startsWith(folder + path.sep)) throw new Error(`Refusing path outside the folder: ${rel}`);
  return full;
};
const samePath = (a, b) => a.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase() === b.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();

let lastJson = '';
try { lastJson = fs.readFileSync(path.join(folder, JSON_NAME), 'utf8'); } catch { /* not written yet */ }
let failing = false;
let rootChecked = false;

async function round() {
  const manifest = await (await get('/api/mirror/manifest')).json();

  // Image paths in the xlsx/JSON must point at this folder.
  if (!rootChecked) {
    if (!samePath(manifest.vmixAssetsRoot ?? '', folder)) {
      await fetch(base + '/api/settings/paths', { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ vmixAssetsRoot: folder }) })
        .then((r) => { if (!r.ok) throw new Error(`Could not set the vMix folder on the dashboard: HTTP ${r.status}`); });
      log(`Dashboard image paths now point to ${folder}`);
    }
    rootChecked = true;
  }

  let changed = 0, removed = 0, errors = 0;
  const wanted = new Set();
  for (const f of manifest.files) {
    wanted.add(f.path);
    const version = `${f.size}:${f.mtime}`;
    const file = localPath(f.path);
    if (state[f.path] === version && fs.existsSync(file)) continue;
    try {
      writeAtomic(file, Buffer.from(await (await get(`/api/mirror/file?path=${encodeURIComponent(f.path)}`)).arrayBuffer()));
      state[f.path] = version;
      changed++;
      log(`↓ ${f.path}`);
    } catch (e) { errors++; log(`! ${f.path}: ${e.message}`); }
  }
  for (const rel of Object.keys(state)) {
    if (wanted.has(rel)) continue;
    try { fs.rmSync(localPath(rel), { force: true }); } catch { /* already gone */ }
    delete state[rel];
    removed++;
    log(`✕ ${rel}`);
  }
  if (changed || removed) saveState();

  const json = await (await get('/json/all')).text();
  if (json !== lastJson) {
    try { writeAtomic(path.join(folder, JSON_NAME), json); lastJson = json; log(`↓ ${JSON_NAME}`); } catch (e) { errors++; log(`! ${JSON_NAME}: ${e.message}`); }
  }
  return errors;
}

log(`Syncing ${base} → ${folder}`);
for (;;) {
  try {
    await round();
    if (failing) log('Connection back.');
    failing = false;
  } catch (e) {
    if (!failing) log(`! ${e.message}  (vMix keeps the last files; retrying)`);
    failing = true;
    if (/Wrong password/.test(e.message) && once) process.exit(1);
  }
  if (once) break;
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}
