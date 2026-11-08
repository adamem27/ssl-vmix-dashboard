/**
 * A data field the template lacks (e.g. a race status in each schedule row), added so it fits the design: a text in the
 * style of a neighbouring text, in the free space of each part (or of the panel), inside the same layer so it plays with
 * the part's animations. When a part has no free space, the widest text that has room to spare gives some of it up.
 * When even that is not enough, the graphic grows to make room, the way it grows for a new row: the backgrounds of the
 * parts (and the panel behind them) get wider or taller with a band of their own picture, what comes after moves on, the
 * texts and pictures above or below stay centred over it, and a centred graphic stays centred.
 * Each part gets its own name the way the template names its parts (STATUS 1, STATUS 2… for BAR 1, BAR 2…).
 */
import { clone, elements, ElementInfo, fmtNum, GtNode, nodeAt, Path, pathKey, storyboards, animationsOf, vec } from './model.js';
import { boxIndex, ImageBand, repeatGroups, RepeatMember } from './params.js';

type Box = [number, number, number, number];
export interface AddFieldOpts {
  /** Field name as the user typed it: STATUS. */
  name: string;
  /** Text shown in the template (and used to size the field). */
  sample: string;
  /** Repeated part group to add it to (one field per part), or null for one field on the graphic. */
  group: string | null;
}

const PAD = 8;
const textW = (s: string, fs: number, bold: boolean) => Math.max(1, s.length) * fs * (bold ? 0.62 : 0.56);
const fontSize = (n: GtNode) => Number(n.attrs.FontSize ?? 25);
const isBold = (n: GtNode) => /bold|black|heavy|semi/i.test(n.attrs.FontWeight ?? '');
const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);
const within = (k: string, roots: string[]) => roots.some((r) => k === r || k.startsWith(r + '/'));

/** Free stretches of [lo, hi] not covered by the intervals. */
function gaps(lo: number, hi: number, taken: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let at = lo;
  for (const [a, b] of [...taken].sort((x, y) => x[0] - y[0])) {
    if (a > at) out.push([at, Math.min(a, hi)]);
    at = Math.max(at, b);
    if (at >= hi) break;
  }
  if (at < hi) out.push([at, hi]);
  return out.filter(([a, b]) => b > a);
}

function fieldName(base: string, m: RepeatMember | null, idx: number): string {
  const up = base.trim().replace(/\s+/g, ' ');
  if (!m) return up;
  if (m.num != null) return `${up} ${m.num}`;
  if (m.token) return `${up} ${m.token}`;
  if (m.prefix) return `${m.prefix}${up.slice(0, 1).toUpperCase()}${up.slice(1).toLowerCase().replace(/\s+(\w)/g, (_x, c: string) => c.toUpperCase())}`;
  return `${up} ${idx + 1}`;
}

const shift = (n: GtNode, axis: 0 | 1, by: number) => {
  const [x, y, z] = vec(n.attrs.Location);
  n.attrs.Location = `${fmtNum(axis === 0 ? x + by : x)},${fmtNum(axis === 1 ? y + by : y)},${fmtNum(z)}`;
};

/** A line under the others: lined up with the text it copies (its left edge for left-aligned text, the panel's middle for centred). */
function stackedBox(src: Box, c: Box, y: number, h: number): Box {
  return [Math.max(c[0] + PAD, Math.min(src[0], c[2] - 4 * PAD)), y, Math.max(src[2], c[2] - 2 * PAD), y + h];
}

interface Spot { source: ElementInfo; box: Box; align: string; shrink?: { el: ElementInfo; box: Box } }

/** Where a new text goes among these elements (absolute boxes), laid out along `axis` (0: side by side, 1: stacked). */
function findSpot(root: GtNode, scope: ElementInfo[], container: Box, axis: 0 | 1, sample: string, extra: Box[]): Spot | null {
  const { of } = boxIndex(root);
  const box = (e: ElementInfo) => of([e.path]);
  const texts = scope.filter((e) => e.node.tag === 'TextBlock' && box(e));
  if (!texts.length) return null;
  const others = scope.filter((e) => box(e) && area(box(e)!) < 0.6 * area(container));
  if (axis === 0) {
    // side by side (a row): the new text sits on the line of the row's texts, in the widest free stretch
    const sizes = texts.map((e) => fontSize(e.node)).sort((a, b) => a - b);
    const typical = sizes[Math.floor((sizes.length - 1) / 2)];
    const source = texts.filter((e) => fontSize(e.node) === typical).sort((a, b) => box(b)![2] - box(a)![2])[0];
    const sb = box(source)!;
    const fs = fontSize(source.node), need = Math.max(textW(sample, fs, isBold(source.node)), 2.5 * fs);
    const taken = [...others.map((e) => box(e)!), ...extra].filter((b) => b[3] > sb[1] && b[1] < sb[3]).map((b) => [b[0] - PAD, b[2] + PAD] as [number, number]);
    const free = gaps(container[0] + PAD, container[2] - PAD, taken).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
    if (free.length && free[0][1] - free[0][0] >= need) {
      const [a, b] = free[0];
      const w = Math.min(b - a, need * 1.5), x = a + (b - a - w) / 2;
      return { source, box: [x, sb[1], x + w, sb[3]], align: 'Center' };
    }
    // no room: the widest text on the line with room to spare gives some up
    const roomy = texts.map((e) => ({ e, b: box(e)! })).filter(({ b }) => b[3] > sb[1] && b[1] < sb[3])
      .map((t) => ({ ...t, spare: (t.b[2] - t.b[0]) - textW((t.e.node.attrs.Text ?? '').split(/\r?\n/)[0], fontSize(t.e.node), isBold(t.e.node)) * 1.1 }))
      .filter((t) => t.spare >= need + PAD).sort((a, b) => b.spare - a.spare)[0];
    if (!roomy) return null;
    const d = need + PAD, b = roomy.b;
    if ((roomy.e.node.attrs.TextAlign ?? 'Left') === 'Right') {
      return { source, box: [b[0], sb[1], b[0] + need, sb[3]], align: 'Center', shrink: { el: roomy.e, box: [b[0] + d, b[1], b[2], b[3]] } };
    }
    return { source, box: [b[2] - need, sb[1], b[2], sb[3]], align: 'Center', shrink: { el: roomy.e, box: [b[0], b[1], b[2] - d, b[3]] } };
  }
  // stacked (a card, a panel): the widest free band across the container
  const taken = [...others.map((e) => box(e)!), ...extra].filter((b) => b[2] > container[0] && b[0] < container[2]).map((b) => [b[1] - PAD / 2, b[3] + PAD / 2] as [number, number]);
  const free = gaps(container[1] + PAD, container[3] - PAD, taken).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
  const near = (y: number) => [...texts].sort((a, b) => Math.abs((box(a)![1] + box(a)![3]) / 2 - y) - Math.abs((box(b)![1] + box(b)![3]) / 2 - y))[0];
  for (const [a, b] of free) {
    const source = near((a + b) / 2);
    const h = Math.max(box(source)![3] - box(source)![1], fontSize(source.node) * 1.3);
    if (b - a < h) continue;
    const y = a + (b - a - h) / 2;
    return { source, box: stackedBox(of([source.path])!, container, y, h), align: source.node.attrs.TextAlign ?? 'Left' };
  }
  return null;
}

/** Adds the field; returns the new document and the names given. Throws with a readable message when it does not fit. */
export function addField(root0: GtNode, o: AddFieldOpts): { root: GtNode; added: string[]; bands: ImageBand[] } {
  if (!o.name.trim()) throw new Error('Give the new field a name.');
  const root = clone(root0);
  const els = elements(root);
  const { of } = boxIndex(root);
  const W = Number(root.attrs.Width ?? 1920), H = Number(root.attrs.Height ?? 1080);
  const taken = new Set(els.map((e) => (e.node.attrs.Name ?? '').toLowerCase()));
  const targets: { m: RepeatMember | null; scope: ElementInfo[]; container: Box; axis: 0 | 1 }[] = [];
  const visibleLeaf = (e: ElementInfo) => e.node.tag !== 'Layer' && e.node.attrs.Visible !== 'False';
  const groups = repeatGroups(root);
  if (o.group) {
    const g = groups.find((x) => x.id === o.group);
    if (!g) throw new Error('This part of the title is not found any more.');
    const axis: 0 | 1 = g.step && Math.abs(g.step[1]) >= Math.abs(g.step[0]) ? 0 : 1;
    for (const m of g.members.filter((x) => !x.hidden)) {
      const roots = m.paths.map(pathKey);
      const scope = els.filter((e) => within(pathKey(e.path), roots) && visibleLeaf(e));
      const mb = of(m.paths);
      if (!mb) continue;
      // the part's own background (the biggest picture or shape in it) bounds the free space
      const bgs = scope.filter((e) => e.node.tag !== 'TextBlock').map((e) => of([e.path])!).filter((b) => b && area(b) >= 0.5 * area(mb)).sort((a, b) => area(b) - area(a));
      targets.push({ m, scope, container: bgs[0] ?? mb, axis });
    }
  } else {
    const inGroup = groups.flatMap((g) => g.members.flatMap((m) => m.paths.map(pathKey)));
    const scope = els.filter((e) => visibleLeaf(e) && !within(pathKey(e.path), inGroup));
    const panel = scope.filter((e) => e.node.tag !== 'TextBlock').map((e) => of([e.path])).filter((b): b is Box => !!b && area(b) < 0.9 * W * H)
      .sort((a, b) => area(b) - area(a))[0] ?? [0, 0, W, H];
    targets.push({ m: null, scope: els.filter((e) => visibleLeaf(e)), container: panel, axis: 1 });
  }
  if (!targets.length) throw new Error('No place found for the field.');
  // first every place (on the untouched layout), then the changes
  // what else is drawn over each place (another part, a photo sticking out) is in the way too
  const leaves = els.filter((e) => visibleLeaf(e)).map((e) => ({ k: pathKey(e.path), b: of([e.path]) })).filter((x): x is { k: string; b: Box } => !!x.b);
  const inTheWay = (t: (typeof targets)[number]) => {
    const mine = new Set(t.scope.map((e) => pathKey(e.path)));
    const c = t.container;
    return leaves.filter((x) => !mine.has(x.k) && x.b[2] > c[0] && x.b[0] < c[2] && x.b[3] > c[1] && x.b[1] < c[3]
      && !(x.b[0] <= c[0] && x.b[1] <= c[1] && x.b[2] >= c[2] && x.b[3] >= c[3])).map((x) => x.b);
  };
  let spots = targets.map((t) => findSpot(root, t.scope, t.container, t.axis, o.sample || o.name, inTheWay(t)));
  const bands: ImageBand[] = [];
  let centreBy: { axis: 0 | 1; by: number } | null = null;
  if (spots.some((x) => !x)) {
    const grown = makeRoom(root, targets, o.sample || o.name, bands);
    if (!grown) throw new Error(`No room for “${o.name}” in this title. Make room in the advanced editor first.`);
    spots = grown.spots;
    centreBy = grown.centre;
  }
  const plans = targets.map((t, i) => {
    const spot = spots[i]!;
    let name = fieldName(o.name, t.m, i);
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${fieldName(o.name, t.m, i)} (${k})`;
    taken.add(name.toLowerCase());
    return { spot, name, parent: nodeAt(root, spot.source.path.slice(0, -1) as Path)! };
  });
  const added: string[] = [];
  for (const { spot, name, parent } of plans) {
    if (spot.shrink) {
      const n = spot.shrink.el.node, [ox, oy] = spot.shrink.el.origin, b = spot.shrink.box;
      n.attrs.Location = `${fmtNum(b[0] - ox)},${fmtNum(b[1] - oy)},${fmtNum(vec(n.attrs.Location)[2])}`;
      n.attrs.Dimensions = `${fmtNum(b[2] - b[0])},${fmtNum(b[3] - b[1])},${fmtNum(vec(n.attrs.Dimensions)[2])}`;
    }
    const src = spot.source;
    const copy = clone(src.node);
    copy.attrs.Name = name;
    copy.attrs.Text = o.sample || o.name;
    copy.attrs.TextAlign = spot.align;
    delete copy.attrs.Visible;
    const [ox, oy] = src.origin, b = spot.box;
    copy.attrs.Location = `${fmtNum(b[0] - ox)},${fmtNum(b[1] - oy)},0`;
    copy.attrs.Dimensions = `${fmtNum(b[2] - b[0])},${fmtNum(b[3] - b[1])},0`;
    parent.children.splice(parent.children.indexOf(src.node) + 1, 0, copy);
    // its own animations follow the text it was styled on (the layer's animations already carry it)
    for (const sb of storyboards(root)) {
      if (sb.node.attrs.DataName) continue;
      const h = sb.node.children.find((c) => c.tag === 'Storyboard.Animations');
      if (!h) continue;
      for (const a of animationsOf(sb.node).filter((x) => x.attrs.Object === src.node.attrs.Name)) h.children.push({ ...clone(a), attrs: { ...a.attrs, Object: name } });
    }
    added.push(name);
  }
  if (centreBy) {
    const cb = centreBy;
    const len = cb.axis === 0 ? W : H;
    const { of: of2 } = boxIndex(root);
    for (const e of elements(root)) {
      if (e.node.tag === 'Layer') continue;
      const bb = of2([e.path]);
      if (bb && bb[cb.axis + 2] - bb[cb.axis] >= 0.98 * len) continue;
      shift(e.node, cb.axis, cb.by);
    }
  }
  return { root, added, bands };
}

/**
 * Grows the graphic along the parts' layout axis so the field fits after their content: everything after moves on,
 * backgrounds across the parts stretch (pictures with a band of themselves, see ImageBand), other things spanning the
 * place stay centred over it. Returns where each part's field goes and, for a centred graphic, the shift that keeps it
 * centred (applied after the fields are in).
 */
function makeRoom(root: GtNode, targets: { m: RepeatMember | null; scope: ElementInfo[]; container: Box; axis: 0 | 1 }[], sample: string, bands: ImageBand[]):
  { spots: Spot[]; centre: { axis: 0 | 1; by: number } | null } | null {
  const axis = targets[0].axis, across = axis === 0 ? 1 : 0;
  // parts in a grid cannot all grow at one place
  if (targets.some((t) => Math.abs(t.container[axis] - targets[0].container[axis]) > 2)) return null;
  const { of } = boxIndex(root);
  const W = Number(root.attrs.Width ?? 1920), H = Number(root.attrs.Height ?? 1080), len = axis === 0 ? W : H;
  const parts = targets.map((t) => {
    const texts = t.scope.filter((e) => e.node.tag === 'TextBlock' && of([e.path]));
    if (!texts.length) return null;
    // what sits in the part's own background (not a sponsor bar that only touches it)
    const c = t.container;
    const content = t.scope.map((e) => of([e.path])).filter((b): b is Box => !!b && area(b) < 0.6 * area(c)
      && (b[0] + b[2]) / 2 > c[0] && (b[0] + b[2]) / 2 < c[2] && (b[1] + b[3]) / 2 > c[1] && (b[1] + b[3]) / 2 < c[3]);
    if (!content.length) return null;
    const end = Math.max(...content.map((b) => b[axis + 2]));
    // the field takes the style of the last text along the axis
    const source = [...texts].sort((a, b) => of([b.path])![axis + 2] - of([a.path])![axis + 2])[0];
    return { t, source, end };
  });
  if (parts.some((x) => !x)) return null;
  const ps = parts as NonNullable<(typeof parts)[number]>[];
  // inside the backgrounds, so they grow (a text that ends at the very edge of a plate)
  const at = Math.min(Math.max(...ps.map((x) => x.end)) + PAD, Math.min(...targets.map((t) => t.container[axis + 2])) - 1);
  const amount = axis === 0
    ? Math.max(...ps.map((x) => Math.max(textW(sample, fontSize(x.source.node), isBold(x.source.node)), 2.5 * fontSize(x.source.node)))) + 2 * PAD
    : Math.max(...ps.map((x) => Math.max(of([x.source.path])![3] - of([x.source.path])![1], fontSize(x.source.node) * 1.3))) + PAD;
  // centred before?
  const all = elements(root).filter((e) => e.node.tag !== 'Layer' && e.node.attrs.Visible !== 'False').map((e) => of([e.path]))
    .filter((b): b is Box => !!b && b[axis + 2] - b[axis] < 0.98 * len);
  const mid = all.length ? (Math.min(...all.map((b) => b[axis])) + Math.max(...all.map((b) => b[axis + 2]))) / 2 : len / 2;
  const centred = Math.abs(mid - len / 2) <= 0.04 * len;
  for (const e of elements(root)) {
    if (e.node.tag === 'Layer') continue;
    const b = of([e.path]);
    if (!b || b[axis + 2] - b[axis] >= 0.98 * len) continue;
    if (b[axis] >= at - 0.5) { shift(e.node, axis, amount); continue; }
    if (b[axis + 2] <= at + 0.5) continue;
    // a background across the parts grows; a smaller picture (an emblem, a photo) stays centred on the grown place
    const background = targets.some(({ container: c }) => b[across + 2] > c[across] && b[across] < c[across + 2] && b[across + 2] - b[across] >= 0.5 * (c[across + 2] - c[across]));
    if (background || e.node.tag === 'TextBlock') {
      const [w, h, z] = vec(e.node.attrs.Dimensions);
      const cw = w || b[2] - b[0], ch = h || b[3] - b[1];
      e.node.attrs.Dimensions = `${fmtNum(axis === 0 ? cw + amount : cw)},${fmtNum(axis === 1 ? ch + amount : ch)},${fmtNum(z)}`;
      if (e.node.tag === 'Image' && e.node.attrs.Name) {
        const l = b[axis + 2] - b[axis], s0 = b[axis];
        bands.push({ name: e.node.attrs.Name, axis, from: Math.max(0, (at - amount - s0) / l), to: Math.min(1, (at - s0) / l), op: 'insert' });
      }
    } else shift(e.node, axis, amount / 2);
  }
  const spots: Spot[] = ps.map(({ t, source }) => {
    const sb = of([source.path])!;
    const box: Box = axis === 0
      ? [at + PAD, sb[1], at + amount - PAD, sb[3]]
      : stackedBox(sb, t.container, at + PAD / 2, amount - PAD);
    return { source, box, align: axis === 0 ? 'Center' : source.node.attrs.TextAlign ?? 'Left' };
  });
  return { spots, centre: centred ? { axis, by: -amount / 2 } : null };
}
