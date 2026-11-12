/**
 * Quick parameters of a GT title: repeated parts (rows, teams, sailors…) found in the template, whose number can be
 * changed by typing it. Adding copies a part with the offset the template's own parts follow (also a two-column grid:
 * the 4th team goes where the 2nd one sits one row lower), renumbers the names (BAR 4 → BAR 5, FLAG 13…16 → 17…20,
 * T2Name → T4Name, Pit → Pit1), copies its animations and can move what comes after the parts (e.g. a sponsor bar
 * under the rows) and stretch the background behind them. Removing drops the last part the same way.
 */
import {
  clone, duplicate, elements, ElementInfo, GtNode, innerComposition, isElement, isVisible, nodeAt, Path, pathKey, remove,
  renameElement, setVec, size, storyboards, animationsOf, vec,
} from './model.js';

export interface RepeatMember {
  label: string; paths: Path[]; num: number | null; prefix: string | null;
  /** A code that names the part inside its element names (OMA in “RANK OMA”, “CountryOMA”). */
  token?: string | null;
  hidden: boolean;
}
export interface RepeatGroup {
  id: string;
  /** What the parts are, e.g. “BAR 1–4” or “Helm, Grinder, Trimmer…”. */
  label: string;
  compPath: Path;
  members: RepeatMember[];
  count: number;
  /** Hidden parts at the end, kept in the template as spares (BAR 3, BAR 4 hidden for a 2-race day). Not counted. */
  spares: number;
  /** The parts follow a straight line with this step (px): rows or columns. null when they are placed freely. */
  step: [number, number] | null;
}
export interface CountOpts {
  /** Move elements that come after the parts (below rows / right of columns) by the change. */
  shiftAfter?: boolean;
  /** Resize backgrounds that span the parts by the change. */
  stretch?: boolean;
  /** Keep a centred title centred: when the graphic sat in the middle of the screen, everything moves back by half of the change. */
  center?: boolean;
}

type Box = [number, number, number, number]; // x0, y0, x1, y1

/**
 * A picture that was stretched along with the parts. Its bitmap has to change the same way, or it would be squashed:
 * the band from…to (fractions of the picture along the axis) is repeated after itself (insert) or cut out (remove).
 */
export interface ImageBand { name: string; axis: 0 | 1; from: number; to: number; op: 'insert' | 'remove' }

const camelSplit = (name: string): [string, string] | null => {
  for (let i = 1; i < name.length; i++) {
    const c = name[i], p = name[i - 1];
    if (c >= 'A' && c <= 'Z' && ((p >= 'a' && p <= 'z') || (p >= '0' && p <= '9'))) return [name.slice(0, i), name.slice(i)];
  }
  return null;
};
const suffixKey = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '').slice(0, 6);

function compositions(root: GtNode): { comp: GtNode; path: Path }[] {
  const out = [{ comp: root, path: [] as Path }];
  for (const e of elements(root)) {
    if (e.node.tag !== 'Layer') continue;
    const hi = e.node.children.findIndex((x) => x.tag === 'Layer.Composition');
    if (hi < 0) continue;
    const ci = e.node.children[hi].children.findIndex((x) => x.tag === 'Composition');
    if (ci >= 0) out.push({ comp: e.node.children[hi].children[ci], path: [...e.path, hi, ci] });
  }
  return out;
}

/** Boxes of the visible, non-layer elements in absolute title coordinates. */
export function boxIndex(root: GtNode) {
  const els = elements(root);
  const W = Number(root.attrs.Width ?? 1920), H = Number(root.attrs.Height ?? 1080);
  const byKey = new Map(els.map((e) => [pathKey(e.path), e]));
  const visibleChain = (e: ElementInfo): boolean => isVisible(e.node) && (!e.parentPath || visibleChain(byKey.get(pathKey(e.parentPath))!));
  const box = (e: ElementInfo): Box => {
    const [x, y] = vec(e.node.attrs.Location);
    let fb: [number, number] = [W, H];
    if (e.parentPath) { const p = byKey.get(pathKey(e.parentPath)); if (p) fb = size(p.node, fb); }
    const [w, h] = size(e.node, fb);
    const b: Box = [e.origin[0] + x, e.origin[1] + y, e.origin[0] + x + w, e.origin[1] + y + h];
    // a layer clips what is inside it (a photo larger than its card)
    const parent = e.parentPath ? byKey.get(pathKey(e.parentPath)) : null;
    if (!parent) return b;
    const pb = box(parent);
    return [Math.max(b[0], pb[0]), Math.max(b[1], pb[1]), Math.max(Math.max(b[0], pb[0]), Math.min(b[2], pb[2])), Math.max(Math.max(b[1], pb[1]), Math.min(b[3], pb[3]))];
  };
  /** Union of the boxes of everything drawn under these paths. */
  const of = (paths: Path[]): Box | null => {
    let b: Box | null = null;
    const keys = paths.map(pathKey);
    for (const e of els) {
      const k = pathKey(e.path);
      if (!keys.some((p) => k === p || k.startsWith(p + '/'))) continue;
      if (e.node.tag === 'Layer') continue;
      const bb = box(e);
      // hidden full-frame pictures (previews) say nothing about where a part is
      if (!visibleChain(e) && bb[2] - bb[0] >= 0.9 * W && bb[3] - bb[1] >= 0.9 * H) continue;
      b = b ? [Math.min(b[0], bb[0]), Math.min(b[1], bb[1]), Math.max(b[2], bb[2]), Math.max(b[3], bb[3])] : bb;
    }
    return b;
  };
  return { els, of };
}

/** Repeated parts of a title. */
export function repeatGroups(root: GtNode): RepeatGroup[] {
  const groups: RepeatGroup[] = [];
  const { of } = boxIndex(root);
  for (const { comp, path } of compositions(root)) {
    const kids = comp.children.map((c, i) => ({ c, i })).filter(({ c }) => isElement(c) && c.attrs.Name);
    const used = new Set<number>();
    // A: numbered layers (BAR 1…4, ROW 1…3, T1…T4 + T1PhotoLayer…)
    const byPattern = new Map<string, Map<number, number>>();
    for (const { c, i } of kids) {
      if (c.tag !== 'Layer') continue;
      const name = c.attrs.Name;
      for (const m of name.matchAll(/\d+/g)) {
        const pat = name.slice(0, m.index) + '#' + name.slice(m.index! + m[0].length);
        if (!byPattern.has(pat)) byPattern.set(pat, new Map());
        byPattern.get(pat)!.set(Number(m[0]), i);
      }
    }
    // alike = the same elements inside, in any order (a row whose flags sit above its race text is still a row)
    const tagsOf = (i: number) => { const inner = innerComposition(comp.children[i]); return inner ? inner.children.filter(isElement).map((x) => x.tag).sort().join(',') : ''; };
    // a pattern counts when its layers are alike inside (Layer1, Layer2… of unrelated content are not parts)
    const pats = [...byPattern.entries()].filter(([, m]) => m.size >= 2 && new Set([...m.values()].map(tagsOf)).size === 1);
    const bySet = new Map<string, string[]>();
    for (const [pat, m] of pats) {
      const k = pat.slice(0, pat.indexOf('#')) + '|' + [...m.keys()].sort((a, b) => a - b).join(',');
      bySet.set(k, [...(bySet.get(k) ?? []), pat]);
    }
    for (const [k, ps] of [...bySet.entries()].sort((a, b) => b[0].split(',').length - a[0].split(',').length)) {
      const nums = k.split('|')[1].split(',').map(Number);
      const members = nums.map((n) => ({ num: n, idx: ps.map((p) => byPattern.get(p)!.get(n)!).filter((x) => !used.has(x)) }));
      if (members.some((m) => m.idx.length !== ps.length)) continue;
      members.forEach((m) => m.idx.forEach((x) => used.add(x)));
      const main = ps.slice().sort((a, b) => a.length - b.length)[0];
      groups.push({
        id: `${pathKey(path)}|A|${ps.join('&')}`, compPath: path,
        label: `${main.replace('#', String(nums[0]))} – ${main.replace('#', String(nums[nums.length - 1]))}`,
        members: members.map((m) => ({ label: main.replace('#', String(m.num)), paths: m.idx.map((x) => [...path, x]), num: m.num, prefix: null, hidden: false })),
        count: members.length, spares: 0, step: null,
      });
    }
    // D: layers named by a code that their elements carry too (OMA: “OMA BG”, “RANK OMA”, “CountryOMA”), plus the
    // other layers whose elements all carry that code (a photo layer with “PHOTO OMA”)
    const innerNames = (c: GtNode) => { const inner = innerComposition(c); return inner ? namedIn(inner).map((x) => x.attrs.Name) : []; };
    const coded = kids.filter(({ c, i }) => {
      if (used.has(i) || c.tag !== 'Layer') return false;
      const t = c.attrs.Name.trim();
      const ns = innerNames(c);
      return /^[A-Z]{2,5}$/.test(t) && ns.length >= 3 && ns.filter((n) => n.includes(t)).length >= ns.length / 2;
    });
    if (coded.length >= 2) {
      const members: RepeatMember[] = coded.map(({ c, i }) => ({ label: c.attrs.Name.trim(), paths: [[...path, i]], num: null, prefix: null, token: c.attrs.Name.trim(), hidden: false }));
      coded.forEach(({ i }) => used.add(i));
      for (const { c, i } of kids) {
        if (used.has(i) || c.tag !== 'Layer') continue;
        const ns = innerNames(c);
        const m = ns.length ? members.find((mm) => ns.every((n) => n.includes(mm.token!))) : null;
        if (m) { m.paths.push([...path, i]); used.add(i); }
      }
      groups.push({ id: `${pathKey(path)}|D`, compPath: path, label: members.map((m) => m.label).join(', '), members, count: members.length, spares: 0, step: null });
    }
    // B: unnumbered layers with the same inside (sailor cards: Helm, Grinder, …)
    const sig = (c: GtNode) => {
      const inner = innerComposition(c);
      if (!inner) return null;
      const tags = inner.children.filter(isElement).map((x) => x.tag).sort();
      return tags.length >= 3 ? tags.join(',') : null;
    };
    const bySig = new Map<string, { c: GtNode; i: number }[]>();
    for (const k2 of kids) if (k2.c.tag === 'Layer' && !used.has(k2.i)) { const s = sig(k2.c); if (s) bySig.set(s, [...(bySig.get(s) ?? []), k2]); }
    for (const [s, list] of bySig) {
      if (list.length < 2) continue;
      list.forEach((x) => used.add(x.i));
      groups.push({
        id: `${pathKey(path)}|B|${s}`, compPath: path, label: list.slice(0, 3).map((x) => x.c.attrs.Name).join(', ') + (list.length > 3 ? ', …' : ''),
        members: list.map((x) => ({ label: x.c.attrs.Name, paths: [[...path, x.i]], num: null, prefix: x.c.attrs.Name, hidden: false })),
        count: list.length, spares: 0, step: null,
      });
    }
    // C: loose elements named <part><what> (BowBG, BowNAME, MidbowBG, …)
    const parts = new Map<string, { i: number; suf: string }[]>();
    for (const { c, i } of kids) {
      if (used.has(i) || c.tag === 'Layer') continue;
      const sp = camelSplit(c.attrs.Name);
      if (sp) parts.set(sp[0], [...(parts.get(sp[0]) ?? []), { i, suf: suffixKey(sp[1]) }]);
    }
    const sufSet = (l: { suf: string }[]) => [...new Set(l.map((x) => x.suf))].sort().join(',');
    const bySuf = new Map<string, string[]>();
    for (const [p, l] of parts) if (new Set(l.map((x) => x.suf)).size >= 3) { const k2 = sufSet(l); bySuf.set(k2, [...(bySuf.get(k2) ?? []), p]); }
    for (const [k2, prefixes] of bySuf) {
      if (prefixes.length < 2) continue;
      const members = prefixes.map((p) => ({ label: p, paths: parts.get(p)!.map((x) => [...path, x.i]), num: null, prefix: p, hidden: false }))
        .sort((a, b) => a.paths[0][a.paths[0].length - 1] - b.paths[0][b.paths[0].length - 1]);
      members.forEach((m) => m.paths.forEach((p) => used.add(p[p.length - 1])));
      groups.push({ id: `${pathKey(path)}|C|${k2}`, compPath: path, label: prefixes.slice(0, 3).join(', ') + (prefixes.length > 3 ? ', …' : ''), members, count: members.length, spares: 0, step: null });
    }
  }
  // a photo layer of a named part (layer TACTICIAN with TacticianPHOTO and TacticianMASK, anywhere in the title) goes with it
  const taken = new Set(groups.flatMap((g) => g.members.flatMap((m) => m.paths)).map(pathKey));
  const isTaken = (k: string) => [...taken].some((t) => k === t || k.startsWith(t + '/') || t.startsWith(k + '/'));
  for (const e of elements(root)) {
    if (e.node.tag !== 'Layer' || isTaken(pathKey(e.path))) continue;
    const nm = e.node.attrs.Name?.toLowerCase() ?? '';
    const inner = innerComposition(e.node);
    const ns = inner ? namedIn(inner).map((x) => x.attrs.Name.toLowerCase()) : [];
    for (const g of groups) {
      const ms = g.members.filter((m) => m.prefix);
      const m = ms.find((mm) => mm.prefix!.toLowerCase() === nm)
        ?? ms.filter((mm) => ns.length && ns.every((n) => n.startsWith(mm.prefix!.toLowerCase()))).sort((x, y) => y.prefix!.length - x.prefix!.length)[0];
      if (m) { m.paths.push(e.path); taken.add(pathKey(e.path)); break; }
    }
  }
  for (const g of groups) {
    for (const m of g.members) m.hidden = m.paths.every((p) => !isVisible(nodeAt(root, p)!));
    let sp = 0;
    while (sp < g.members.length - 1 && g.members[g.members.length - 1 - sp].hidden) sp++;
    g.spares = sp;
    g.count = g.members.length - sp;
    g.step = linearStep(g.members.slice(0, g.count).map((m) => of(m.token ? m.paths.slice(0, 1) : m.paths)));
  }
  return groups;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 3;

/** The step most neighbouring parts follow (at least half of them: one misplaced row does not spoil it). */
function linearStep(boxes: (Box | null)[]): [number, number] | null {
  if (boxes.length < 2 || boxes.some((b) => !b)) return null;
  const ds: [number, number][] = [];
  for (let i = 1; i < boxes.length; i++) ds.push([boxes[i]![0] - boxes[i - 1]![0], boxes[i]![1] - boxes[i - 1]![1]]);
  let best: [number, number] | null = null, bestN = 0;
  for (const s of ds) {
    const n = ds.filter((t) => near(t[0], s[0]) && near(t[1], s[1])).length;
    if (n > bestN) { best = s; bestN = n; }
  }
  if (!best || bestN < ds.length / 2) return null;
  // a step must go one way: rows (x the same) or columns (y the same)
  if (!near(best[0], 0) && !near(best[1], 0)) return null;
  // and every part goes on that way (a grid of 2×2 teams is not a row)
  const ax = near(best[0], 0) ? 1 : 0;
  if (ds.some((t) => !near(t[1 - ax], 0) || Math.sign(t[ax]) !== Math.sign(best![ax]))) return null;
  return best[0] || best[1] ? best : null;
}

/** Where the next part goes. A grid with one empty cell (three teams in a 2×2 layout) fills that cell, copying the part
 * above/below or beside it. Otherwise the smallest period P for which part i = part i−P + D holds; the copy is made
 * from part N−P. */
function nextPlacement(boxes: Box[], frame: Box, obstacles: Box[] = []): { src: number; d: [number, number]; cell?: boolean } {
  const N = boxes.length;
  const cluster = (vs: number[]) => { const out: number[] = []; for (const v of vs) if (!out.some((o) => Math.abs(o - v) <= 12)) out.push(v); return out; };
  const xs = cluster(boxes.map((b) => b[0])), ys = cluster(boxes.map((b) => b[1]));
  if (xs.length >= 2 && ys.length >= 2 && xs.length * ys.length === N + 1) {
    const has = (x: number, y: number) => boxes.some((b) => Math.abs(b[0] - x) <= 12 && Math.abs(b[1] - y) <= 12);
    const cells = ys.slice().sort((a, b) => a - b).flatMap((y) => xs.slice().sort((a, b) => a - b).map((x) => [x, y] as const));
    const free = cells.find(([x, y]) => !has(x, y));
    if (free) {
      // same column first (keeps the side a photo sits on), else same row
      let src = boxes.findIndex((b) => Math.abs(b[0] - free[0]) <= 12);
      if (src < 0) src = boxes.findIndex((b) => Math.abs(b[1] - free[1]) <= 12);
      if (src >= 0) return { src, d: [free[0] - boxes[src][0], free[1] - boxes[src][1]], cell: true };
    }
  }
  for (let P = 1; P <= Math.min(3, N - 1); P++) {
    const D: [number, number] = [boxes[P][0] - boxes[0][0], boxes[P][1] - boxes[0][1]];
    let ok = D[0] !== 0 || D[1] !== 0;
    for (let i = P; ok && i < N; i++) ok = near(boxes[i][0] - boxes[i - P][0], D[0]) && near(boxes[i][1] - boxes[i - P][1], D[1]);
    if (ok) return { src: N - P, d: D };
  }
  // placed freely (sailor cards around a boat): next to the last part, where it overlaps no other part and stays on
  // the screen; right, left, below or above
  const last = boxes[N - 1];
  const w = last[2] - last[0], h = last[3] - last[1], gap = 16;
  const overlap = (b: Box) => [...boxes, ...obstacles].reduce((t, o) => t + Math.max(0, Math.min(b[2], o[2]) - Math.max(b[0], o[0])) * Math.max(0, Math.min(b[3], o[3]) - Math.max(b[1], o[1])), 0);
  const inside = (b: Box) => b[0] >= frame[0] && b[1] >= frame[1] && b[2] <= frame[2] && b[3] <= frame[3];
  // the free spot next to the latest part; when there is none, the spot on the panel that covers the least
  let best: { src: number; d: [number, number]; cost: number } | null = null;
  for (let k = N - 1; k >= 0; k--) {
    const b = boxes[k];
    for (const dd of [[w + gap, 0], [-(w + gap), 0], [0, h + gap], [0, -(h + gap)]] as [number, number][]) {
      const nb: Box = [b[0] + dd[0], b[1] + dd[1], b[2] + dd[0], b[3] + dd[1]];
      const cost = overlap(nb) + (inside(nb) ? 0 : 1e9);
      if (cost <= 4 * w) return { src: k, d: dd };
      if (!best || cost < best.cost) best = { src: k, d: dd, cost };
    }
  }
  return best ?? { src: N - 1, d: [w + gap, 0] };
}

function firstDelay(root: GtNode, names: Set<string>): number | null {
  const sb = storyboards(root).find((s) => !s.node.attrs.Type);
  if (!sb) return null;
  const ds = animationsOf(sb.node).filter((a) => names.has(a.attrs.Object)).map((a) => Number(a.attrs.Delay ?? 0));
  return ds.length ? Math.min(...ds) : null;
}

function namedIn(n: GtNode, out: GtNode[] = []): GtNode[] {
  if (isElement(n) && n.attrs.Name) out.push(n);
  for (const c of n.children) namedIn(c, out);
  return out;
}

/**
 * Moves the top-level elements of a composition that come after the parts, stretches the backgrounds that span them,
 * and/or re-centres everything, after a part was added (sign 1) or removed (−1). lo…hi is where the parts were along
 * the step's axis before the change.
 */
function adjust(root: GtNode, compPath: Path, exclude: Set<string>, lo: number, hi: number, d: [number, number], sign: number, o: CountOpts, bands: ImageBand[]) {
  const axis = Math.abs(d[1]) >= Math.abs(d[0]) ? 1 : 0;
  const fwd = d[axis] > 0;
  const delta = Math.abs(d[axis]) * sign; // growth of the parts' extent
  if (!delta) return;
  const comp = compPath.length ? nodeAt(root, compPath)! : root;
  const { of, els } = boxIndex(root);
  // “keep centred” keeps a graphic in the middle of the screen when it was there: the drawn things of the composition
  // (not full-screen pictures) are centred on the frame along the step's axis
  const frameLen = Number(axis === 0 ? root.attrs.Width ?? 1920 : root.attrs.Height ?? 1080);
  const full = (b: Box) => b[axis + 2] - b[axis] >= 0.98 * frameLen;
  let centre = false;
  if (o.center) {
    const ck = pathKey(compPath);
    let a = Infinity, z = -Infinity;
    for (const e of els) {
      const k = pathKey(e.path);
      if (e.node.tag === 'Layer' || (ck && !k.startsWith(ck + '/')) || !isVisible(e.node)) continue;
      const b = of([e.path]);
      if (!b || full(b)) continue;
      a = Math.min(a, b[axis]); z = Math.max(z, b[axis + 2]);
    }
    centre = Number.isFinite(a) && Math.abs((a + z) / 2 - frameLen / 2) <= 0.04 * frameLen;
  }
  const start = (b: Box) => (fwd ? b[axis] : -b[axis + 2]);
  const end = (b: Box) => (fwd ? b[axis + 2] : -b[axis]);
  const L = fwd ? lo : -hi, Hh = fwd ? hi : -lo;
  const move = (n: GtNode, by: number) => { const [x, y] = vec(n.attrs.Location); setVec(n, 'Location', axis === 0 ? x + by : x, axis === 1 ? y + by : y); };
  // what comes after the parts moves; what spans them stretches; a layer spanning them (a full-frame layer with the
  // background, the sponsor bar and a footnote) is looked into
  const walk = (cmp: GtNode, cpath: Path) => cmp.children.forEach((c, i) => {
    const p = [...cpath, i];
    const key = pathKey(p);
    if (!isElement(c) || exclude.has(key)) return;
    const b = of([p]);
    if (!b) return;
    if (o.shiftAfter && start(b) >= Hh - 2) { move(c, fwd ? delta : -delta); return; }
    if (!(start(b) < L - 2 && end(b) >= Hh - 2)) return;
    if (c.tag === 'Layer') {
      const hi2 = c.children.findIndex((x) => x.tag === 'Layer.Composition');
      const ci = hi2 >= 0 ? c.children[hi2].children.findIndex((x) => x.tag === 'Composition') : -1;
      if (ci >= 0) walk(c.children[hi2].children[ci], [...p, hi2, ci]);
      return;
    }
    if (!o.stretch) return;
    const [w, h] = size(c, [b[2] - b[0], b[3] - b[1]]);
    setVec(c, 'Dimensions', axis === 0 ? w + delta : w, axis === 1 ? h + delta : h);
    if (!fwd) move(c, -delta);
    if (c.tag === 'Image') {
      // the band of the picture under the last part (first part when the parts grow up/left) repeats or goes
      const len = axis === 0 ? w : h, s0 = b[axis], step = Math.abs(d[axis]);
      const b0 = fwd ? hi - step : lo, b1 = fwd ? hi : lo + step;
      bands.push({ name: c.attrs.Name, axis: axis as 0 | 1, from: Math.max(0, (b0 - s0) / len), to: Math.min(1, (b1 - s0) / len), op: sign > 0 ? 'insert' : 'remove' });
    }
  });
  walk(comp, compPath);
  if (centre) comp.children.forEach((c, i) => {
    if (!isElement(c)) return;
    const b = c.tag === 'Layer' ? null : of([[...compPath, i]]);
    if (b && full(b)) return; // a full-screen picture stays where it is
    move(c, -(fwd ? delta : -delta) / 2);
  });
}

function addOne(root: GtNode, g: RepeatGroup, o: CountOpts, bands: ImageBand[]): GtNode {
  const { of } = boxIndex(root);
  // a team's own layer tells where the team is (its photo layer may stick out to either side)
  const boxes = g.members.map((m) => of(m.token ? m.paths.slice(0, 1) : m.paths) ?? [0, 0, 0, 0] as Box);
  const frame: [number, number] = [Number(root.attrs.Width ?? 1920), Number(root.attrs.Height ?? 1080)];
  // other things on the screen a freely placed part should not cover (not the big backgrounds)
  const comp0 = g.compPath.length ? nodeAt(root, g.compPath)! : root;
  const mine = new Set(g.members.flatMap((m) => m.paths).map(pathKey));
  // the panel all the parts sit on: a new part stays on it
  const all = boxes.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] as Box);
  const { els: allEls } = boxIndex(root);
  const inMine = (k: string) => [...mine].some((m) => k === m || k.startsWith(m + '/'));
  let panel: Box = [0, 0, frame[0], frame[1]];
  for (const e of allEls) {
    if (e.node.tag === 'Layer' || !isVisible(e.node) || inMine(pathKey(e.path))) continue;
    const b = of([e.path]);
    if (b && b[0] <= all[0] && b[1] <= all[1] && b[2] >= all[2] && b[3] >= all[3] && (b[2] - b[0]) * (b[3] - b[1]) < (panel[2] - panel[0]) * (panel[3] - panel[1])) panel = b;
  }
  const obstacles = allEls.filter((e) => e.node.tag !== 'Layer' && isVisible(e.node) && !inMine(pathKey(e.path))).map((e) => of([e.path]))
    .filter((b): b is Box => !!b && (b[2] - b[0]) * (b[3] - b[1]) < 0.3 * frame[0] * frame[1]);
  const { src, d, cell } = nextPlacement(boxes, panel, obstacles);
  const s = g.members[src];
  const lastM = g.members[g.members.length - 1];
  const namesOf = (m: RepeatMember) => new Set(m.paths.flatMap((p) => namedIn(nodeAt(root, p)!).map((n) => n.attrs.Name)));
  // stagger: the gap between the first In animation of the last two parts
  let delayStep = 0;
  if (g.members.length >= 2) {
    const a = firstDelay(root, namesOf(g.members[g.members.length - 2]));
    const b = firstDelay(root, namesOf(lastM));
    if (a != null && b != null) delayStep = (b - a) * (cell ? 1 : g.members.length - src);
  }
  const srcNames = s.paths.map((p) => namedIn(nodeAt(root, p)!).map((n) => n.attrs.Name));
  const r = duplicate(root, s.paths, { count: 1, dx: d[0], dy: d[1], delayStep });
  let out = r.root;
  // nicer names than the generic renumbering: BAR 4 → BAR 5, T2Name → T4Name, Pit → Pit1, RANK OMA → RANK TEAMD
  const nums = g.members.map((m) => m.num).filter((n): n is number => n != null);
  const newNum = nums.length ? Math.max(...nums) + 1 : null;
  const prefixes = new Set(g.members.map((m) => m.prefix?.toLowerCase()));
  let newPrefix: string | null = null;
  if (s.prefix) {
    const base = s.prefix.replace(/\d+$/, '');
    let k = 1;
    while (prefixes.has(`${base}${k}`.toLowerCase())) k++;
    newPrefix = `${base}${k}`;
  }
  let newToken: string | null = null;
  if (s.token) {
    const tokens = new Set(g.members.map((m) => m.token));
    for (let k = g.members.length; k < 26 && !newToken; k++) if (!tokens.has(`TEAM${String.fromCharCode(65 + k)}`)) newToken = `TEAM${String.fromCharCode(65 + k)}`;
  }
  const added = r.added.filter((p) => !r.added.some((q) => q !== p && pathKey(p).startsWith(pathKey(q) + '/')));
  added.forEach((p, i) => {
    const copies = namedIn(nodeAt(out, p)!).map((n) => n.attrs.Name);
    copies.forEach((cur, j) => {
      const orig = srcNames[i]?.[j];
      if (!orig) return;
      let want: string | null = null;
      if (newNum != null && s.num != null) {
        const re = new RegExp(`(^|\\D)${s.num}(?!\\d)`);
        if (re.test(orig)) want = orig.replace(re, (_m, pre) => `${pre}${newNum}`);
      } else if (newPrefix && s.prefix && orig.toLowerCase().startsWith(s.prefix.toLowerCase())) {
        want = newPrefix + orig.slice(s.prefix.length);
      } else if (newToken && s.token && orig.includes(s.token)) {
        want = orig.split(s.token).join(newToken);
      }
      if (want && want !== cur) { try { renameElement(out, cur, want); } catch { /* name taken: keep the generic one */ } }
    });
    // a text that shows the part's number (POSITION 4 = "4") follows it
    // (also “RACE 4” in the field RACE 4 → “RACE 5”)
    if (newNum != null && s.num != null) {
      const re = new RegExp(`(^|\\D)${s.num}(?!\\d)`);
      namedIn(nodeAt(out, p)!).forEach((n, j) => {
        if (n.tag !== 'TextBlock' || n.attrs.Text == null) return;
        if (n.attrs.Text === String(s.num)) n.attrs.Text = String(newNum);
        else if (re.test(srcNames[i]?.[j] ?? '') && re.test(n.attrs.Text)) n.attrs.Text = n.attrs.Text.replace(re, (_m, pre) => `${pre}${newNum}`);
      });
    }
  });
  if (cell) {
    // a placeholder picture drawn over the empty cell (an “empty slot” graphic) is hidden
    const idx = boxIndex(out);
    const nb = idx.of(added.slice(0, 1));
    const comp = g.compPath.length ? nodeAt(out, g.compPath)! : out;
    const skip = new Set([...g.members.flatMap((m) => m.paths), ...added].map(pathKey));
    if (nb) comp.children.forEach((c, i) => {
      if (!isElement(c) || skip.has(pathKey([...g.compPath, i])) || !isVisible(c)) return;
      const b = idx.of([[...g.compPath, i]]);
      if (!b) return;
      const ix = Math.max(0, Math.min(b[2], nb[2]) - Math.max(b[0], nb[0])) * Math.max(0, Math.min(b[3], nb[3]) - Math.max(b[1], nb[1]));
      const area = (q: Box) => (q[2] - q[0]) * (q[3] - q[1]);
      if (ix > 0.8 * area(b) && ix > 0.5 * area(nb)) c.attrs.Visible = 'False';
    });
  } else if (g.step && (o.shiftAfter || o.stretch || o.center)) {
    const axis = Math.abs(g.step[1]) >= Math.abs(g.step[0]) ? 1 : 0;
    const all = g.members.map((m) => of(m.paths)).filter((x): x is Box => !!x);
    const lo = Math.min(...all.map((x) => x[axis])), hi = Math.max(...all.map((x) => x[axis + 2]));
    const exclude = new Set([...g.members.flatMap((m) => m.paths), ...added].map(pathKey));
    out = clone(out);
    adjust(out, g.compPath, exclude, lo, hi, g.step, 1, o, bands);
  }
  return out;
}

function removeLast(root: GtNode, g: RepeatGroup, o: CountOpts, bands: ImageBand[]): GtNode {
  const { of } = boxIndex(root);
  const last = g.members[g.members.length - 1];
  const b = of(last.paths);
  let out = remove(root, last.paths);
  if (g.step && b && (o.shiftAfter || o.stretch || o.center)) {
    const axis = Math.abs(g.step[1]) >= Math.abs(g.step[0]) ? 1 : 0;
    const boxes = g.members.map((m) => of(m.paths)).filter((x): x is Box => !!x);
    const lo = Math.min(...boxes.map((x) => x[axis])), hi = Math.max(...boxes.map((x) => x[axis + 2]));
    // paths of the parts that stay are unchanged: the removed part is the last one, its own children went with it
    const exclude = new Set(g.members.slice(0, -1).flatMap((m) => m.paths).map(pathKey));
    adjust(out, g.compPath, exclude, lo, hi, g.step, -1, o, bands);
  }
  return out;
}

/**
 * Sets the number of parts of the group with this id (1–40). Hidden spare parts at the end are dropped first. Returns
 * the new document and the pictures whose bitmap has to follow a stretch (see ImageBand), in the order they happened.
 */
export function setCount(root0: GtNode, groupId: string, n: number, o: CountOpts = {}): { root: GtNode; bands: ImageBand[] } {
  let root = root0;
  const bands: ImageBand[] = [];
  const target = Math.max(1, Math.min(40, Math.floor(n)));
  const step0 = repeatGroups(root0).find((x) => x.id === groupId)?.step ?? null;
  for (let guard = 0; guard < 100; guard++) {
    const g = repeatGroups(root).find((x) => x.id === groupId);
    if (!g) throw new Error('This part of the title is not found any more.');
    if (g.spares) { root = remove(root, g.members[g.members.length - 1].paths); continue; }
    if (g.count === target) { if (root !== root0) retime(root0, root, groupId); return { root, bands }; }
    // keep the step of the original parts while adding/removing (it is lost when only one part is left)
    if (!g.step) g.step = step0;
    root = g.count < target ? addOne(root, g, o, bands) : removeLast(root, g, o, bands);
    // every step must change the count, or the parts are not recognised the same way any more
    if (repeatGroups(root).find((x) => x.id === groupId)?.count === g.count) throw new Error('The number of parts cannot be changed in this title.');
  }
  return { root, bands };
}

/**
 * Fits the animations to the new number of parts, so the title still plays as one piece: in every storyboard the
 * parts keep their cascade (each part one step after the previous; a cascade that runs backwards, as in an Out, ends on
 * the last part), what played after the parts moves along with the end of the cascade, and a background that grew or
 * shrank with the parts reveals at the same speed (its Reveal/Expand/Wipe takes longer or shorter).
 */
function retime(root0: GtNode, root: GtNode, groupId: string) {
  const g0 = repeatGroups(root0).find((x) => x.id === groupId);
  const g1 = repeatGroups(root).find((x) => x.id === groupId);
  if (!g0 || !g1) return;
  const namesIn = (r: GtNode, m: RepeatMember) => m.paths.flatMap((p) => { const n = nodeAt(r, p); return n ? namedIn(n).map((x) => x.attrs.Name) : []; });
  const m0 = g0.members.filter((m) => !m.hidden).map((m) => namesIn(root0, m));
  const m1 = g1.members.filter((m) => !m.hidden).map((m) => namesIn(root, m));
  const sb0 = storyboards(root0), sb1 = storyboards(root);
  const r3 = (x: number) => Math.round(Math.max(0, x) * 1000) / 1000;
  const setDelay = (a: GtNode, d: number) => { if (d <= 0) delete a.attrs.Delay; else a.attrs.Delay = String(r3(d)); };
  sb1.forEach((sb, si) => {
    const old = sb0.find((x) => (x.node.attrs.Type ?? '') === (sb.node.attrs.Type ?? '') && (x.node.attrs.DataName ?? '') === (sb.node.attrs.DataName ?? ''));
    if (!old) return;
    const anim0 = animationsOf(old.node), anim1 = animationsOf(sb.node);
    // which part an animation belongs to, and which of its elements (by position) it moves
    const slot = (names: string[][], obj: string) => { for (let k = 0; k < names.length; k++) { const j = names[k].indexOf(obj); if (j >= 0) return { k, j }; } return null; };
    const series = new Map<string, { k: number; d: number }[]>();
    let oldMax = -Infinity;
    for (const a of anim0) {
      const s0 = slot(m0, a.attrs.Object ?? '');
      if (!s0) continue;
      const key = `${a.tag}|${s0.j}`, d = Number(a.attrs.Delay ?? 0);
      if (!series.has(key)) series.set(key, []);
      series.get(key)!.push({ k: s0.k, d });
      oldMax = Math.max(oldMax, d);
    }
    if (!series.size) return;
    let newMax = -Infinity;
    for (const a of anim1) {
      const s1 = slot(m1, a.attrs.Object ?? '');
      if (!s1) continue;
      const pts = series.get(`${a.tag}|${s1.j}`);
      if (!pts?.length) continue;
      pts.sort((x, y) => x.k - y.k);
      const first = pts[0], last = pts[pts.length - 1];
      const step = pts.length > 1 ? (last.d - first.d) / (last.k - first.k) : 0;
      // forward cascades start where they started; backward ones end on the last part where they ended
      const d = step >= 0 ? first.d + (s1.k - first.k) * step : last.d + (m1.length - 1 - s1.k) * -step - (m0.length - 1 - last.k) * -step;
      setDelay(a, d);
      newMax = Math.max(newMax, r3(d));
    }
    if (!Number.isFinite(newMax)) return;
    const shift = newMax - oldMax;
    if (Math.abs(shift) > 1e-6) for (const a of anim1) {
      if (slot(m1, a.attrs.Object ?? '')) continue;
      const d = Number(a.attrs.Delay ?? 0);
      if (d >= oldMax - 1e-6) setDelay(a, d + shift);
    }
    void si;
  });
  // backgrounds that grew/shrank with the parts: same reveal speed
  const axis = g0.step && Math.abs(g0.step[0]) > Math.abs(g0.step[1]) ? 0 : 1;
  const ix0 = boxIndex(root0), ix1 = boxIndex(root);
  const pathOf = (ix: ReturnType<typeof boxIndex>, name: string) => ix.els.find((e) => e.node.attrs.Name === name)?.path;
  for (const sb of sb1) for (const a of animationsOf(sb.node)) {
    if (!['Reveal', 'Expand', 'Wipe'].includes(a.tag) || slot2(m1, a.attrs.Object)) continue;
    const p0 = pathOf(ix0, a.attrs.Object ?? ''), p1 = pathOf(ix1, a.attrs.Object ?? '');
    const b0 = p0 && ix0.of([p0]), b1 = p1 && ix1.of([p1]);
    if (!b0 || !b1) continue;
    const l0 = b0[axis + 2] - b0[axis], l1 = b1[axis + 2] - b1[axis];
    if (l0 <= 0 || Math.abs(l1 / l0 - 1) < 0.02) continue;
    const dur = Number(a.attrs.Duration ?? 1) * (l1 / l0);
    a.attrs.Duration = String(r3(Math.min(3, Math.max(0.2, dur))));
  }
}
const slot2 = (names: string[][], obj: string | undefined) => !!obj && names.some((n) => n.includes(obj));
