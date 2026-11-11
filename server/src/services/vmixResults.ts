import { activeEvent, DB, getSetting, setSetting } from '../db/db.js';
import { listGraphicSets } from './graphicSets.js';
import { groupLabel } from './groupNames.js';
import { AssetCtx } from './assets.js';
import { badRequest } from './errors.js';
import { getResults } from './results.js';
import { listTeams } from './teams.js';
import { teamPictureFor } from './ltTitle.js';

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
  // race columns stand at the right, next to Points: with 4 races in a 6-column title,
  // R1…R4 go to columns 3…6 and columns 1–2 stay empty; more races than columns show the last ones
  const c = cols || g.races;
  const shown = Math.min(g.races, c);
  const first = g.races - shown; // index of the first race shown
  const raceAt = (col: number) => { const k = col - (c - shown) - 1; return k >= 0 && k < shown ? first + k : -1; };
  for (let j = 1; j <= 12; j++) { const k = j <= c ? raceAt(j) : -1; f.set(`H${j}.Text`, k >= 0 ? `R${k + 1}` : ''); f.set(`R${j}.Text`, k >= 0 ? `R${k + 1}` : ''); }
  // titles named the other way (overall_results: STAGE, LOCALIZATION, "Group A", position 1, flag 1, COUNTRY1,
  // R1 points1…, Total1): the stage and place from Welcome (General graphics), the group's name
  const welcome = listGraphicSets(ctx.db, activeEvent(ctx.db).id, 'welcome')[0]?.data ?? {};
  const up = (v: string | undefined) => (v ?? '').trim().toUpperCase();
  // the Results tab gives the group's title (Group A / GROUP) and the subtitle (the place: LOCALIZATION / LOCATION);
  // Welcome only fills in a subtitle left empty, and the stage
  const place = g.subtitle.trim();
  f.set('STAGE.Text', up(welcome.stage));
  f.set('LOCALIZATION.Text', up(place));
  f.set('LOCATION.Text', up(place));
  f.set('Group A.Text', up(g.title) || groupLabel(g.fleetName));
  f.set('GROUP.Text', up(g.title) || groupLabel(g.fleetName));
  for (let n = 1; n <= Math.max(rowsInTitle, g.rows.length); n++) {
    const r = g.rows[n - 1];
    const t = r ? teams.get(r.teamId) : undefined;
    f.set(`POS ${n}.Text`, r ? String(n) : '');
    f.set(`TEAM ${n}.Text`, (t?.name ?? '').toUpperCase());
    f.set(`FLAG ${n}.Source`, img(t?.assets.flag_small));
    for (let j = 1; j <= 12; j++) { const k = j <= c ? raceAt(j) : -1; f.set(`R${j} ${n}.Text`, r && k >= 0 ? r.races[k] ?? '' : ''); }
    f.set(`POINTS ${n}.Text`, r ? r.total : '');
    f.set(`position ${n}.Text`, r ? String(n) : '');
    f.set(`COUNTRY${n}.Text`, (t?.name ?? '').toUpperCase());
    f.set(`flag ${n}.Source`, img(t?.assets.flag_small));
    for (let j = 1; j <= 12; j++) { const k = j <= c ? raceAt(j) : -1; f.set(`R${j} points${n}.Text`, r && k >= 0 ? r.races[k] ?? '' : ''); }
    f.set(`Total${n}.Text`, r ? r.total : '');
    // the row's bar in the team's colours: its results bar from the PNG generator (CODE_bar_results.png / CODE - OVERALL.png)
    // (a team with no generated bar keeps the title's own; a row with no team gets none)
    const bar = t ? teamPictureFor(ctx, t, { w: 1129, h: 76, key: 'barresults', like: /result|overall/, exact: true }) : '';
    if (bar !== null) f.set(`bar${n}.Source`, bar);
  }
  return f;
}

/** values: what each title field holds now (<text name="Name.Text">South Korea</text>, <image …>path</image>). */
/**
 * The title's own name for a field: the same name in any case, or the name GT cut at 15 characters
 * (TacticianSURNAME → TacticianSURNAM.Text), with the same .Text / .Source; undefined when the title has none.
 */
export function titleFieldMatcher(titleFields: string[]) {
  const exact = new Map(titleFields.map((f) => [f.toLowerCase(), f]));
  const split = (f: string) => { const i = f.lastIndexOf('.'); return [f.slice(0, i).toLowerCase(), f.slice(i).toLowerCase()]; };
  const cut = titleFields.map((f) => [...split(f), f] as const).filter(([b]) => b.length >= 15);
  return (name: string) => {
    const e = exact.get(name.toLowerCase());
    if (e) return e;
    const [b, ext] = split(name);
    return cut.find(([cb, cext]) => cext === ext && b.length > cb.length && b.startsWith(cb))?.[2];
  };
}

export interface VmixInput { key: string; number: string; title: string; fields: string[]; values?: Record<string, string>; type?: string }

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
    out.push({ key: attr(open, 'key'), number: attr(open, 'number'), title: unxml(attr(open, 'title')), fields, values, type: attr(open, 'type') });
  }
  return out;
}

/** The results fields for one title: as many rows and race columns as it has. */
export function resultFieldsFor(ctx: AssetCtx, fleetId: string, input: { fields: string[] }) {
  const rowsInTitle = Math.max(0, ...input.fields.map((f) => Number(f.match(/^(?:TEAM |COUNTRY)(\d+)\.Text$/i)?.[1] ?? 0)));
  const cols = Math.max(0, ...input.fields.map((f) => Number(f.match(/^R(\d+) (?:points)?1\.Text$/i)?.[1] ?? 0)));
  return { rowsInTitle, cols, fields: resultFields(ctx, fleetId, rowsInTitle, cols) };
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
  const { rowsInTitle, cols, fields } = resultFieldsFor(ctx, fleetId, input);
  const match = titleFieldMatcher(input.fields);
  const done = new Set<string>();
  let sent = 0;
  for (const [name0, value] of fields) {
    const name = match(name0);
    if (!name || done.has(name)) continue;
    done.add(name);
    const fn = name.endsWith('.Source') ? 'SetImage' : 'SetText';
    await call(`?Function=${fn}&Input=${encodeURIComponent(input.key || input.number)}&SelectedName=${encodeURIComponent(name)}&Value=${encodeURIComponent(value)}`);
    sent++;
  }
  const g = getResults(ctx.db, fleetId);
  return { input: input.title, number: input.number, sent, teams: g.rows.length, rowsInTitle, tooMany: g.rows.length > rowsInTitle, cols, races: g.races, racesHidden: Math.max(0, g.races - cols) };
}
