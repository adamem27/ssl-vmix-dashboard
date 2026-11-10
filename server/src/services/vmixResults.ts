import { DB, getSetting, setSetting } from '../db/db.js';
import { AssetCtx } from './assets.js';
import { badRequest } from './errors.js';
import { getResults } from './results.js';
import { listTeams } from './teams.js';

/**
 * Sends a group's overall results straight into a vMix title through the vMix Web API
 * (SetText / SetImage), so the title needs no Data Source mapping. Field names follow the
 * Group_overall_results_* titles: SUBTITLE, LOCATION, H1…, and per row n POS n, FLAG n, TEAM n,
 * R1 n…, POINTS n. Only fields the input really has are set; rows past the group are emptied.
 * Race columns are filled from the right, so fewer races still sit next to Points.
 */
export const DEFAULT_VMIX_URL = 'http://127.0.0.1:8088';
const KEY = 'vmix.apiUrl';

export function vmixUrl(db: DB) { return getSetting(db, KEY) || DEFAULT_VMIX_URL; }
export function setVmixUrl(db: DB, url: string) {
  const v = url.trim().replace(/\/+$/, '').replace(/\/api$/i, '');
  if (v && !/^https?:\/\/[^\s/]+(:\d+)?$/i.test(v)) throw badRequest('vMix address must look like http://192.168.1.20:8088');
  setSetting(db, KEY, v);
  return { apiUrl: vmixUrl(db) };
}

type Asset = { vmixPath: string | null; storedPath: string | null; enteredPath: string | null } | undefined | null;
const img = (a: Asset) => (a ? a.vmixPath ?? a.storedPath ?? a.enteredPath ?? '' : '');

/** The values for every field the results title can have: `NAME.Text` or `NAME.Source` → value. */
export function resultFields(ctx: AssetCtx, fleetId: string, rowsInTitle = 12, cols = 0): Map<string, string> {
  const g = getResults(ctx.db, fleetId);
  const teams = new Map(listTeams(ctx).map((t) => [t.id, t]));
  const f = new Map<string, string>();
  f.set('SUBTITLE.Text', g.title);
  if (g.subtitle.trim()) f.set('LOCATION.Text', g.subtitle);
  // race columns stand at the right, next to Points: with 4 races in a 6-column title,
  // R1…R4 go to columns 3…6 and columns 1–2 stay empty; more races than columns show the last ones
  const c = cols || g.races;
  const shown = Math.min(g.races, c);
  const first = g.races - shown; // index of the first race shown
  const raceAt = (col: number) => { const k = col - (c - shown) - 1; return k >= 0 && k < shown ? first + k : -1; };
  for (let j = 1; j <= 12; j++) { const k = j <= c ? raceAt(j) : -1; f.set(`H${j}.Text`, k >= 0 ? `R${k + 1}` : ''); }
  for (let n = 1; n <= Math.max(rowsInTitle, g.rows.length); n++) {
    const r = g.rows[n - 1];
    const t = r ? teams.get(r.teamId) : undefined;
    f.set(`POS ${n}.Text`, r ? String(n) : '');
    f.set(`TEAM ${n}.Text`, (t?.name ?? '').toUpperCase());
    f.set(`FLAG ${n}.Source`, img(t?.assets.flag_small));
    for (let j = 1; j <= 12; j++) { const k = j <= c ? raceAt(j) : -1; f.set(`R${j} ${n}.Text`, r && k >= 0 ? r.races[k] ?? '' : ''); }
    f.set(`POINTS ${n}.Text`, r ? r.total : '');
  }
  return f;
}

/** values: what each title field holds now (<text name="Name.Text">South Korea</text>, <image …>path</image>). */
export interface VmixInput { key: string; number: string; title: string; fields: string[]; values?: Record<string, string> }

/** Inputs of the running vMix with their title fields, from the XML at /api. */
export function parseVmixXml(xml: string): VmixInput[] {
  const out: VmixInput[] = [];
  const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? '';
  const unxml = (v: string) => v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const inputs = xml.split('<inputs>')[1]?.split('</inputs>')[0] ?? '';
  for (const m of inputs.matchAll(/<input\s[^>]*?(?:\/>|>[\s\S]*?<\/input>)/g)) {
    const open = m[0].match(/^<input\s[^>]*>/)?.[0] ?? m[0];
    const fields = [...m[0].matchAll(/<(?:text|image)\s[^>]*name="([^"]+)"/g)].map((x) => unxml(x[1]));
    const values: Record<string, string> = {};
    for (const x of m[0].matchAll(/<(text|image)\s[^>]*?name="([^"]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/\1>)/g)) values[unxml(x[2])] = unxml(x[3] ?? '');
    out.push({ key: attr(open, 'key'), number: attr(open, 'number'), title: unxml(attr(open, 'title')), fields, values });
  }
  return out;
}

export function findInput(inputs: VmixInput[], wanted: string): VmixInput | undefined {
  const w = wanted.trim().toLowerCase();
  const base = (s: string) => s.toLowerCase().replace(/\.gtzip$/, '');
  return inputs.find((i) => i.number === w || i.key.toLowerCase() === w)
    ?? inputs.find((i) => i.title.toLowerCase() === w)
    ?? inputs.find((i) => base(i.title) === base(w))
    ?? inputs.find((i) => base(i.title).startsWith(base(w)));
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export async function pushResults(ctx: AssetCtx, fleetId: string, inputName: string, fetcher: Fetch = fetch as unknown as Fetch) {
  if (!inputName.trim()) throw badRequest('Type the name or number of the vMix input with the results title.');
  const base = vmixUrl(ctx.db);
  const call = async (q: string) => {
    let res;
    try { res = await fetcher(`${base}/api/${q}`, { signal: AbortSignal.timeout(4000) }); }
    catch { throw badRequest(`vMix does not answer at ${base}. Turn on Settings → Web Controller in vMix and check the address in Settings here.`); }
    if (!res.ok) throw badRequest(`vMix answered ${res.status} for ${decodeURIComponent(q).slice(0, 80)}`);
    return res.text();
  };
  const inputs = parseVmixXml(await call(''));
  const input = findInput(inputs, inputName);
  if (!input) throw badRequest(`vMix has no input “${inputName}”. Use the input's name or number as shown in vMix.`);
  const rowsInTitle = Math.max(0, ...input.fields.map((f) => Number(f.match(/^TEAM (\d+)\.Text$/)?.[1] ?? 0)));
  const cols = Math.max(0, ...input.fields.map((f) => Number(f.match(/^R(\d+) 1\.Text$/)?.[1] ?? 0)));
  const fields = resultFields(ctx, fleetId, rowsInTitle, cols);
  const has = new Set(input.fields);
  let sent = 0;
  for (const [name, value] of fields) {
    if (!has.has(name)) continue;
    const fn = name.endsWith('.Source') ? 'SetImage' : 'SetText';
    await call(`?Function=${fn}&Input=${encodeURIComponent(input.key || input.number)}&SelectedName=${encodeURIComponent(name)}&Value=${encodeURIComponent(value)}`);
    sent++;
  }
  const g = getResults(ctx.db, fleetId);
  return { input: input.title, number: input.number, sent, teams: g.rows.length, rowsInTitle, tooMany: g.rows.length > rowsInTitle, cols, races: g.races, racesHidden: Math.max(0, g.races - cols) };
}
