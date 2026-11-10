/**
 * How a lower third title is built, so the dashboard fills it the way it was designed:
 *  - which of its fields is the name, the line under it, the photo, the flag, the emblem and the bar
 *    (the names set on the Lower thirds tab first; else the title's own names: Name, position/pb, PHOTO…);
 *  - which team picture goes into the bar: the team's PNG made like the one in the title (the title has
 *    ANT_lowerthird.png 802×105 → the team's <CODE>_lowerthird.png), else a team PNG of the same shape, else the
 *    team graphic set on the Lower thirds tab. A bar of another size would be squeezed into the title's box.
 * The title is read from the .gtzip the vMix input was loaded from (GTZIP generator outputs and templates).
 */
import fs from 'node:fs';
import path from 'node:path';
import { getSetting } from '../db/db.js';
import { AssetCtx } from './assets.js';
import { GTZIP_DIR, loadPackage } from './gtzip/gtzip.js';
import { bitmap, elements, GtNode, size } from './gtzip/model.js';
import { GENERATED_DIR, listOutputs } from './generator/generator.js';
import { joinVmixPath } from './paths.js';

export type LtRole = 'top' | 'bottom' | 'photo' | 'flag' | 'emblem' | 'bar';
export interface LtImageInfo { w: number; h: number; key: string }
export interface LtTitleInfo { images: Record<string, LtImageInfo> }

const base = (f: string) => f.replace(/\.(Text|Source)$/i, '');
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** The fields of a title (vMix names, Name.Text / PHOTO.Source) for each part of a lower third. */
export function ltRoles(configured: Record<LtRole, string>, fields: string[]): Partial<Record<LtRole, string>> {
  const texts = fields.filter((f) => f.endsWith('.Text'));
  const images = fields.filter((f) => f.endsWith('.Source'));
  const out: Partial<Record<LtRole, string>> = {};
  const used = new Set<string>();
  const take = (role: LtRole, list: string[], res: RegExp[]) => {
    const own = list.find((f) => base(f).toLowerCase() === configured[role].toLowerCase());
    const hit = own ?? res.map((re) => list.find((f) => !used.has(f) && re.test(base(f)))).find(Boolean);
    if (hit) { out[role] = hit; used.add(hit); }
  };
  take('top', texts, [/top/i, /^(full ?)?name$/i, /name|title|sailor|team/i]);
  take('bottom', texts, [/bottom/i, /position|pos\b|subtitle|nick|role|info|second|line ?2/i]);
  // a title with two plain texts: the upper one is the name, the other the line under it
  for (const role of ['top', 'bottom'] as const) if (!out[role]) { const f = texts.find((x) => !used.has(x)); if (f) { out[role] = f; used.add(f); } }
  take('photo', images, [/photo|picture|portrait|^pic|person|face/i]);
  take('flag', images, [/flag/i]);
  take('emblem', images, [/emblem|logo|crest/i]);
  take('bar', images, [/bar|background|^bg|plate|lowerthird|lower ?third/i]);
  if (!out.bar) { const rest = images.filter((x) => !used.has(x)); if (rest.length === 1) out.bar = rest[0]; }
  return out;
}

/** The .gtzip a vMix input was loaded from: a generated title or a template, by the input's name. */
function gtzipFor(assetsDir: string, title: string): string | null {
  const want = norm(title.replace(/\.gtzip$/i, ''));
  if (!want) return null;
  const data = path.dirname(path.resolve(assetsDir));
  const dirs = [path.join(assetsDir, GTZIP_DIR), path.join(data, 'gtzip-templates')];
  let best: { file: string; len: number } | null = null;
  for (const dir of dirs) {
    let list: string[] = [];
    try { list = fs.readdirSync(dir).filter((f) => /\.gtzip$/i.test(f)); } catch { continue; }
    for (const f of list) {
      let name = norm(f.replace(/\.gtzip$/i, ''));
      // a template is kept under an id; its first name is in the .json beside it
      if (dir.endsWith('gtzip-templates')) {
        try { const m = JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.gtzip$/i, '.json')), 'utf8')); name = norm(String(m.originalFilename ?? m.name ?? '').replace(/\.gtzip$/i, '')); } catch { continue; }
      }
      // "lowerthird_photo 2 1.gtzip" in vMix is "lowerthird_photo 2" here (a second download gets " 1")
      if (name && (want === name || want.startsWith(name)) && (!best || name.length > best.len)) best = { file: path.join(dir, f), len: name.length };
    }
    if (best && best.len === want.length) break;
  }
  return best?.file ?? null;
}

const cache = new Map<string, { at: number; info: LtTitleInfo }>();

/** Size and kind of each picture of the title: its box and its file name without the team code (lowerthird). */
export function ltTitleInfo(assetsDir: string, title: string, teamCodes: string[]): LtTitleInfo | null {
  const file = gtzipFor(assetsDir, title);
  if (!file) return null;
  const at = fs.statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.at === at) return hit.info;
  let doc: GtNode;
  try { doc = loadPackage(fs.readFileSync(file)).doc; } catch { return null; }
  const codes = teamCodes.filter(Boolean).map((c) => c.toUpperCase());
  const images: Record<string, LtImageInfo> = {};
  for (const e of elements(doc)) {
    if (e.node.tag !== 'Image' || !e.node.attrs.Name) continue;
    const [w, h] = size(e.node, [0, 0]);
    const src = (bitmap(e.node)?.attrs.Source ?? '').split(/[\\/]/).pop() ?? '';
    images[e.node.attrs.Name.toLowerCase()] = { w, h, key: keyOf(src, codes) };
  }
  const info = { images };
  cache.set(file, { at, info });
  return info;
}

/** ANT_lowerthird.png → lowerthird; "ANT - Flag big v2.png" → flagbigv2: the file name without a team code. */
export function keyOf(file: string, codes: string[]): string {
  let s = file.replace(/\.[a-z0-9]+$/i, '');
  for (const c of codes) {
    const re = new RegExp(`^${c}(?=[\\s_.-])|(?<=[\\s_.-])${c}$`, 'i');
    if (re.test(s)) { s = s.replace(re, ''); break; }
  }
  return norm(s);
}

/** Width and height of a PNG file (its header), or null. */
function pngSize(file: string): [number, number] | null {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(24);
    fs.readSync(fd, b, 0, 24, 0);
    fs.closeSync(fd);
    if (b.readUInt32BE(0) !== 0x89504e47) return null;
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  } catch { return null; }
}

/**
 * The team's PNG for a picture of the title: the one named like the title's (CODE_<key>.png), else the one of the
 * closest shape (within 4 %); null when nothing fits (the caller keeps its own choice).
 */
export function teamPictureFor(ctx: AssetCtx, team: { id: string; code: string }, want: LtImageInfo | undefined): string | null {
  if (!want || !want.w || !want.h) return null;
  const files = listOutputs(ctx.db).filter((o) => o.teamId === team.id).map((o) => o.rel);
  // the team's own folder of generated pictures may hold more than the generator lists (an older run, a copy)
  const folder = `${GENERATED_DIR}/${team.code.replace(/[^\w.-]+/g, '_')}`;
  try { for (const f of fs.readdirSync(path.join(ctx.assetsDir, ...folder.split('/')))) if (/\.png$/i.test(f) && !files.includes(`${folder}/${f}`)) files.push(`${folder}/${f}`); } catch { /* none */ }
  const local = (rel: string) => path.join(ctx.assetsDir, ...rel.split('/'));
  const exists = files.filter((r) => fs.existsSync(local(r)));
  const byKey = want.key ? exists.find((r) => keyOf(path.basename(r), [team.code]) === want.key) : undefined;
  let pick = byKey;
  if (!pick) {
    const ratio = want.w / want.h;
    let best: { rel: string; d: number } | null = null;
    for (const r of exists) {
      const s = pngSize(local(r));
      if (!s) continue;
      const d = Math.abs(s[0] / s[1] - ratio) / ratio;
      if (d <= 0.04 && (!best || d < best.d)) best = { rel: r, d };
    }
    pick = best?.rel;
  }
  if (!pick) return null;
  const root = getSetting(ctx.db, 'paths.vmixAssetsRoot');
  return root ? joinVmixPath(root, pick) : local(pick);
}
