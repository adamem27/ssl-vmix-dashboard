/**
 * Animation preview of a GT title: what each element looks like at a moment of a storyboard
 * (TransitionIn / TransitionOut / DataChangeOut + DataChangeIn), close to vMix's own effects.
 * An In animation goes from the effect to the element as designed, an Out animation from the element to the effect.
 */
import { animationsOf, GtNode, storyboardLength } from './model.js';

export type Phase = 'in' | 'out';
export interface AnimState { alpha: number; dx: number; dy: number; sx: number; sy: number; rot: number; clip: [number, number, number, number] | null }
/** One storyboard placed on the preview timeline. */
export interface Segment { sb: GtNode; phase: Phase; start: number }

const back = 1.70158;
const bounceOut = (p: number) => {
  const n = 7.5625, d = 2.75;
  if (p < 1 / d) return n * p * p;
  if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75;
  if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375;
  return n * (p -= 2.625 / d) * p + 0.984375;
};
const inOut = (f: (p: number) => number) => (p: number) => (p < 0.5 ? f(p * 2) / 2 : 1 - f((1 - p) * 2) / 2);
const EASE: Record<string, (p: number) => number> = {
  Linear: (p) => p,
  CubicEasingIn: (p) => p ** 3,
  CubicEasingOut: (p) => 1 - (1 - p) ** 3,
  CubicEasingInOut: inOut((p) => p ** 3),
  QuadraticEasingInOut: inOut((p) => p ** 2),
  QuarticEasingInOut: inOut((p) => p ** 4),
  QuinticEasingInOut: inOut((p) => p ** 5),
  SineEasingInOut: (p) => -(Math.cos(Math.PI * p) - 1) / 2,
  BackEasingInOut: inOut((p) => p * p * ((back + 1) * p - back)),
  BounceEasingOut: bounceOut,
  ElasticEasingOut: (p) => (p === 0 || p === 1 ? p : 2 ** (-10 * p) * Math.sin((p * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
};
export const ease = (name: string | undefined, p: number) => (EASE[name ?? 'CubicEasingInOut'] ?? EASE.CubicEasingInOut)(Math.max(0, Math.min(1, p)));

export const segmentEnd = (s: Segment) => s.start + storyboardLength(s.sb);
export const timelineLength = (segs: Segment[]) => Math.max(0, ...segs.map(segmentEnd));

/**
 * The look of every element at time `t` (seconds) of the timeline, for drawTitle's `anim` option.
 * The segment that started last decides; elements it does not animate are drawn as designed,
 * except after an Out: what that Out took away stays away.
 */
export function animAt(segs: Segment[], t: number, frame: [number, number]) {
  const started = segs.filter((s) => s.start <= t + 1e-9).sort((a, b) => a.start - b.start);
  const cur = started[started.length - 1] ?? segs.slice().sort((a, b) => a.start - b.start)[0];
  if (!cur) return () => null;
  const byName = new Map<string, GtNode[]>();
  for (const a of animationsOf(cur.sb)) if (a.attrs.Object) byName.set(a.attrs.Object, [...(byName.get(a.attrs.Object) ?? []), a]);
  const local = t - cur.start;
  const [W, H] = frame;
  return (n: GtNode, x: number, y: number, w: number, h: number): AnimState | null => {
    const list = n.attrs.Name ? byName.get(n.attrs.Name) : undefined;
    if (!list) return null;
    const s: AnimState = { alpha: 1, dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, clip: null };
    for (const a of list) {
      const delay = Number(a.attrs.Delay ?? 0), dur = Math.max(0.0001, Number(a.attrs.Duration ?? 1));
      const p = ease(a.attrs.Interpolation, (local - delay) / dur);
      const e = cur.phase === 'in' ? 1 - p : p; // 1 = the effect at full, 0 = as designed
      const dir = a.attrs.Direction ?? 'Left';
      switch (a.tag) {
        case 'Fade': s.alpha *= 1 - e; break;
        case 'Fly':
          if (dir === 'Left') s.dx += -(x + w) * e; else if (dir === 'Right') s.dx += (W - x) * e;
          else if (dir === 'Top') s.dy += -(y + h) * e; else s.dy += (H - y) * e;
          break;
        case 'Slide':
          s.clip = [x, y, w, h];
          if (dir === 'Left') s.dx += -w * e; else if (dir === 'Right') s.dx += w * e; else if (dir === 'Top') s.dy += -h * e; else s.dy += h * e;
          break;
        case 'Reveal': case 'Wipe': {
          const k = 1 - e;
          s.clip = dir === 'Left' ? [x, y, w * k, h] : dir === 'Right' ? [x + w * e, y, w * k, h] : dir === 'Top' ? [x, y, w, h * k] : [x, y + h * e, w, h * k];
          break;
        }
        case 'Expand': if (dir === 'Top' || dir === 'Bottom') s.sy *= 1 - e; else s.sx *= 1 - e; break;
        case 'Zoom': s.sx *= 1 - e; s.sy *= 1 - e; break;
        case 'Spin': s.rot += e * Math.PI * 2; s.sx *= 1 - e; s.sy *= 1 - e; break;
        case 'Pulse': { const q = Math.max(0, Math.min(1, (local - delay) / dur)); const k = 1 + 0.12 * Math.sin(Math.PI * q); s.sx *= k; s.sy *= k; break; }
        default: break;
      }
    }
    return s;
  };
}

/** Storyboards of a title by kind, for the preview's buttons. */
export function previewStoryboards(root: GtNode) {
  const sbs = root.children.filter((c) => c.tag === 'Storyboard');
  const of = (t: string) => sbs.find((s) => (s.attrs.Type ?? 'TransitionIn') === t) ?? null;
  const fields = [...new Set(sbs.filter((s) => s.attrs.DataName && /^DataChange/.test(s.attrs.Type ?? '')).map((s) => s.attrs.DataName!))];
  const dataChange = (field: string) => ({
    out: sbs.find((s) => s.attrs.Type === 'DataChangeOut' && s.attrs.DataName === field) ?? null,
    in: sbs.find((s) => (s.attrs.Type === 'DataChangeIn' || s.attrs.Type === 'DataChange') && s.attrs.DataName === field) ?? null,
  });
  return { in: of('TransitionIn'), out: of('TransitionOut'), fields, dataChange };
}
