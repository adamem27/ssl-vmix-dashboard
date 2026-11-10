/**
 * Approximate drawing of a GT title, shared by the browser (editor preview) and the server (thumbnail.png).
 * It is a preview, not vMix: images, rectangles (solid / linear gradient, radius, stroke), text, layers (clipped),
 * opacity and rectangle masks. Text is shrunk to fit its box, as vMix does by default.
 */
import { argbToCss, bitmap, brush, child, elements, GtNode, innerComposition, isVisible, size, vec } from './model.js';

/** A loaded image the context can draw, with its pixel size. */
export interface Img { img: unknown; width: number; height: number }

export interface DrawOpts {
  /** Image for a Bitmap Source (null while loading or when the title leaves it to the data source). */
  image: (source: string) => Img | null;
  /** Draw elements marked Visible="False" too (dimmed). */
  showHidden?: boolean;
  /** Outline image fields that have no picture (data source placeholders). */
  placeholders?: boolean;
  /** Family used when the title's font is not available. */
  fallbackFont?: string;
  /** Draw only these elements (with what is inside them), e.g. to save one layer as a PNG. Hidden ones are drawn too. */
  only?: GtNode[];
  /** Animation preview: how an element is moved, scaled, faded or clipped now (see anim.ts). */
  anim?: (n: GtNode, x: number, y: number, w: number, h: number) => { alpha: number; dx: number; dy: number; sx: number; sy: number; rot: number; clip: [number, number, number, number] | null } | null;
  /** Text shown instead of an element's own (preview of a data change). */
  text?: (n: GtNode) => string | undefined;
}

const WEIGHT: Record<string, number> = { Thin: 100, ExtraLight: 200, Light: 300, Normal: 400, Regular: 400, Medium: 500, SemiBold: 600, DemiBold: 600, Bold: 700, ExtraBold: 800, Black: 900 };

function brushStyle(ctx: any, b: GtNode | null, x: number, y: number, w: number, h: number): unknown {
  if (!b) return null;
  if (b.attrs.Type === 'LinearGradient') {
    const stops = child(b, 'Brush.Stops')?.children ?? [];
    const [sx, sy] = b.attrs.StartPoint ? b.attrs.StartPoint.split(',').map(Number) : [0, 0];
    const [ex, ey] = b.attrs.EndPoint ? b.attrs.EndPoint.split(',').map(Number) : [1, 1];
    const g = ctx.createLinearGradient(x + sx * w, y + sy * h, x + ex * w, y + ey * h);
    for (const s of stops) g.addColorStop(Math.max(0, Math.min(1, Number(s.attrs.Position ?? 0))), argbToCss(s.attrs.Color) ?? 'transparent');
    return g;
  }
  return argbToCss(b.attrs.Color);
}

function roundRect(ctx: any, x: number, y: number, w: number, h: number, radius: string | undefined) {
  const [rx, ry] = radius ? radius.split(',').map(Number) : [0, 0];
  const r = Math.max(0, Math.min((rx || 0), (ry ?? rx) || 0, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws the composition at 1 unit = 1 px; scale the context beforehand for other sizes. */
export function drawTitle(ctx: any, root: GtNode, o: DrawOpts) {
  const W = Number(root.attrs.Width ?? 1920), H = Number(root.attrs.Height ?? 1080);
  const maskNames = new Set<string>();
  for (const e of elements(root)) for (const h of e.node.children) if (h.tag.endsWith('.Mask')) for (const m of h.children) if (m.attrs.Object) maskNames.add(m.attrs.Object);
  let filter: Filter | null = null;
  if (o.only?.length) {
    // the containers on the way to each chosen element are drawn as frames (position, clip, opacity) only
    const along = new Set<GtNode>();
    const walk = (n: GtNode, trail: GtNode[]) => {
      if (o.only!.includes(n)) for (const t of trail) along.add(t);
      for (const c of n.children) walk(c, [...trail, n]);
    };
    walk(root, []);
    filter = { chosen: new Set(o.only), along };
  }
  drawComposition(ctx, root, 0, 0, W, H, o, maskNames, filter);
}

interface Filter { chosen: Set<GtNode>; along: Set<GtNode> }

function drawComposition(ctx: any, comp: GtNode, ox: number, oy: number, pw: number, ph: number, o: DrawOpts, maskNames: Set<string>, filter: Filter | null = null) {
  const byName = new Map<string, GtNode>();
  for (const c of comp.children) if (c.attrs.Name) byName.set(c.attrs.Name, c);
  for (const n of comp.children) {
    // with a filter: a chosen element is drawn whole (filter off inside it), a container on the way only as a frame
    const chosen = !!filter?.chosen.has(n);
    if (filter && !chosen && !filter.along.has(n)) continue;
    const inner = chosen ? null : filter;
    const hidden = !filter && !isVisible(n);
    if (hidden && !o.showHidden) continue;
    if (n.tag === 'Rectangle' && maskNames.has(n.attrs.Name)) continue;
    const [lx, ly] = vec(n.attrs.Location);
    const [w, h] = size(n, [pw, ph]);
    const x = ox + lx, y = oy + ly;
    const opacity = (n.attrs.Opacity != null ? Number(n.attrs.Opacity) : 1) * (hidden ? 0.35 : 1);
    ctx.save();
    ctx.globalAlpha *= opacity;
    // a mask clips to the masking rectangle (same composition); it stays put while the element flies or zooms in it,
    // as in vMix (a photo rising from behind its frame)
    const maskHolder = n.children.find((c) => c.tag === `${n.tag}.Mask`);
    const mask = maskHolder?.children[0]?.attrs.Object ? byName.get(maskHolder.children[0].attrs.Object) : null;
    if (mask) {
      const [mx, my] = vec(mask.attrs.Location), [mw, mh] = size(mask, [pw, ph]);
      roundRect(ctx, ox + mx, oy + my, mw, mh, mask.attrs.Radius);
      ctx.clip();
    }
    const an = o.anim?.(n, x, y, w, h);
    if (an) {
      if (an.alpha <= 0.001 || (an.clip && (an.clip[2] <= 0.01 || an.clip[3] <= 0.01)) || Math.abs(an.sx) < 0.001 || Math.abs(an.sy) < 0.001) { ctx.restore(); continue; }
      ctx.globalAlpha *= an.alpha;
      if (an.clip) { ctx.beginPath(); ctx.rect(an.clip[0], an.clip[1], an.clip[2], an.clip[3]); ctx.clip(); }
      ctx.translate(an.dx, an.dy);
      if (an.sx !== 1 || an.sy !== 1 || an.rot) { ctx.translate(x + w / 2, y + h / 2); if (an.rot) ctx.rotate(an.rot); ctx.scale(an.sx, an.sy); ctx.translate(-(x + w / 2), -(y + h / 2)); }
    }
    if (n.tag === 'Layer') {
      ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      const sub = innerComposition(n);
      if (sub) drawComposition(ctx, sub, x, y, w, h, o, maskNames, inner);
    } else if (n.tag === 'Image') {
      const b = bitmap(n);
      const im = b?.attrs.Source ? o.image(b.attrs.Source) : null;
      if (im && im.width && im.height) {
        const mode = n.attrs.SizeMode ?? 'Uniform';
        let dw = w, dh = h;
        if (mode === 'Uniform' || mode === 'UniformToFill') {
          const s = mode === 'Uniform' ? Math.min(w / im.width, h / im.height) : Math.max(w / im.width, h / im.height);
          dw = im.width * s; dh = im.height * s;
        } else if (mode === 'None') { dw = im.width; dh = im.height; }
        if (mode !== 'Stretch') { ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); }
        const flip = n.children.some((c) => c.tag === 'Image.Effects' && c.children.some((e) => e.tag === 'FlipX'));
        if (flip) { ctx.translate(x + w / 2, 0); ctx.scale(-1, 1); ctx.translate(-(x + w / 2), 0); }
        ctx.drawImage(im.img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
      } else if (o.placeholders) {
        ctx.strokeStyle = 'rgba(120,160,255,0.8)'; ctx.lineWidth = 2; ctx.setLineDash?.([8, 6]);
        ctx.strokeRect(x, y, w, h); ctx.setLineDash?.([]);
      }
    } else if (n.tag === 'Rectangle' || n.tag === 'Ellipse') {
      if (n.tag === 'Ellipse') { ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); }
      else roundRect(ctx, x, y, w, h, n.attrs.Radius);
      const fill = brushStyle(ctx, brush(n, 'Fill'), x, y, w, h);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      const sw = Number(n.attrs.StrokeThickness ?? 0);
      const stroke = sw > 0 ? brushStyle(ctx, brush(n, 'Stroke'), x, y, w, h) : null;
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = sw; ctx.stroke(); }
    } else if (n.tag === 'TextBlock' || n.tag === 'Ticker' || n.tag === 'Text3D') {
      drawText(ctx, n, x, y, w, h, o);
    }
    ctx.restore();
  }
}

function drawText(ctx: any, n: GtNode, x: number, y: number, w: number, h: number, o: DrawOpts) {
  const text = o.text?.(n) ?? n.attrs.Text ?? '';
  if (!text) return;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const family = n.attrs.FontFamily ?? 'Arial';
  const weight = WEIGHT[n.attrs.FontWeight ?? 'Normal'] ?? 400;
  const italic = n.attrs.FontStyle === 'Italic' ? 'italic ' : '';
  let fs = Number(n.attrs.FontSize ?? 24);
  const font = (s: number) => `${italic}${weight} ${s}px "${family}"${o.fallbackFont ? `, "${o.fallbackFont}"` : ''}, sans-serif`;
  ctx.font = font(fs);
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
  if (w > 0 && widest > w) fs *= w / widest;
  if (h > 0 && lines.length * fs * 1.2 > h * 1.05) fs = Math.min(fs, (h * 1.05) / (lines.length * 1.2));
  ctx.font = font(fs);
  ctx.fillStyle = brushStyle(ctx, brush(n, 'Fill'), x, y, w, h) ?? '#fff';
  ctx.textBaseline = 'middle';
  const align = n.attrs.TextAlign ?? 'Left';
  ctx.textAlign = align === 'Center' ? 'center' : align === 'Right' ? 'right' : 'left';
  const tx = align === 'Center' ? x + w / 2 : align === 'Right' ? x + w : x;
  const lh = fs * 1.2, total = lh * lines.length;
  const va = n.attrs.VerticalAlign ?? 'Top';
  const top = va === 'Center' ? y + (h - total) / 2 : va === 'Bottom' ? y + h - total : y;
  lines.forEach((l, i) => ctx.fillText(l, tx, top + lh * i + lh / 2));
}
