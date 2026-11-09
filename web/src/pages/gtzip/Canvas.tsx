import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react';
import { ElementInfo, GtNode, isVisible, pathKey, size, vec } from '../../../../server/src/services/gtzip/model';
import { drawTitle, Img } from '../../../../server/src/services/gtzip/draw';

export type Box = [number, number, number, number];
export type CanvasBg = 'grid' | 'gridlight' | 'checker' | 'dark';
export interface Snap { grid: boolean; guides: boolean }
export interface CanvasApi { fit(): void; zoomTo(z: number): void; zoomBy(f: number): void; center(): [number, number]; zoom: number }

/** Absolute box of an element on the artboard. */
export function absBox(e: ElementInfo, doc: GtNode, byKey: Map<string, ElementInfo>): Box {
  const [x, y] = vec(e.node.attrs.Location);
  let fallback: [number, number] = [Number(doc.attrs.Width ?? 1920), Number(doc.attrs.Height ?? 1080)];
  if (e.parentPath) { const p = byKey.get(pathKey(e.parentPath)); if (p) fallback = size(p.node, fallback); }
  const [w, h] = size(e.node, fallback);
  return [e.origin[0] + x, e.origin[1] + y, w, h];
}
export const unionBox = (bs: Box[]): Box => {
  const x0 = Math.min(...bs.map((b) => b[0])), y0 = Math.min(...bs.map((b) => b[1]));
  const x1 = Math.max(...bs.map((b) => b[0] + b[2])), y1 = Math.max(...bs.map((b) => b[1] + b[3]));
  return [x0, y0, x1 - x0, y1 - y0];
};
/** Selected keys without the ones inside another selected element (moving a layer moves what is in it). */
export function topSelected(sel: string[]) {
  return sel.filter((k) => !sel.some((o) => o !== k && k.startsWith(o + '/')));
}

const RULER = 18;
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Handle = typeof HANDLES[number];
const CURSOR: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

type Drag =
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number }
  | { kind: 'move'; wx: number; wy: number; boxes: Map<string, Box>; id: number; moved: boolean }
  | { kind: 'resize'; handle: Handle; key: string; box: Box; wx: number; wy: number; id: number }
  | { kind: 'marquee'; wx: number; wy: number; cx: number; cy: number; add: boolean };

interface Props {
  doc: GtNode; els: ElementInfo[]; sel: string[]; setSel: (s: string[]) => void;
  showHidden: boolean; bg: CanvasBg; snap: Snap; images: (src: string) => Img | null; redraw: number;
  /** New absolute boxes; `resize` also sets the size. `key` merges the steps of one drag into one undo step. */
  onBoxes: (boxes: Map<string, Box>, resize: boolean, key: string) => void;
  onDropFiles?: (files: File[], at: [number, number]) => void;
  onDoubleClick?: (e: ElementInfo) => void;
  onZoom?: (z: number) => void;
  height: number;
}

let dragSeq = 0;

/**
 * The artboard as in a drawing program: zoom (Ctrl+wheel, buttons), pan (wheel, Space+drag, middle button),
 * 10 px grid, rulers, selection with handles, marquee, smart guides and grid snapping.
 */
export const Canvas = forwardRef<CanvasApi, Props>(function Canvas({ doc, els, sel, setSel, showHidden, bg, snap, images, redraw, onBoxes, onDropFiles, onDoubleClick, onZoom, height }, ref) {
  const W = Number(doc.attrs.Width ?? 1920), H = Number(doc.attrs.Height ?? 1080);
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [vw, setVw] = useState(0);
  const [view, setView] = useState({ z: 0.5, x: 40, y: 40 });
  const fitted = useRef(false);
  const drag = useRef<Drag | null>(null);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [hover, setHover] = useState<string | null>(null);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [space, setSpace] = useState(false);
  const [cssCursor, setCssCursor] = useState('default');

  const byKey = useMemo(() => new Map(els.map((e) => [pathKey(e.path), e])), [els]);
  const boxOf = useCallback((e: ElementInfo) => absBox(e, doc, byKey), [doc, byKey]);
  const hiddenUnder = useCallback((e: ElementInfo) => {
    let cur: ElementInfo | undefined = e;
    while (cur) { if (!isVisible(cur.node)) return true; cur = cur.parentPath ? byKey.get(pathKey(cur.parentPath)) : undefined; }
    return false;
  }, [byKey]);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setVw(Math.floor(e.contentRect.width)));
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const fitView = useCallback(() => {
    const aw = vw - RULER - 48, ah = height - RULER - 48;
    const z = Math.max(0.05, Math.min(aw / W, ah / H));
    setView({ z, x: RULER + (vw - RULER - W * z) / 2, y: RULER + (height - RULER - H * z) / 2 });
  }, [vw, height, W, H]);
  useEffect(() => { if (!fitted.current && vw > 0) { fitted.current = true; fitView(); } }, [vw, fitView]);
  const zoomAt = useCallback((nz: number, sx: number, sy: number) => {
    setView((v) => {
      const z = Math.max(0.05, Math.min(8, nz));
      return { z, x: sx - ((sx - v.x) / v.z) * z, y: sy - ((sy - v.y) / v.z) * z };
    });
  }, []);
  useEffect(() => { onZoom?.(view.z); }, [view.z, onZoom]);
  useImperativeHandle(ref, () => ({
    fit: fitView,
    zoomTo: (z) => zoomAt(z, vw / 2, height / 2),
    zoomBy: (f) => zoomAt(view.z * f, vw / 2, height / 2),
    center: () => [Math.round((vw / 2 - view.x) / view.z), Math.round((height / 2 - view.y) / view.z)],
    zoom: view.z,
  }), [fitView, zoomAt, vw, height, view]);

  // Space = hand tool
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && !(e.target as HTMLElement).closest('input,textarea,select,[contenteditable]')) { e.preventDefault(); setSpace(true); } };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpace(false); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  // wheel: pan, Ctrl/⌘ zooms at the cursor (non-passive so the page does not scroll)
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = c.getBoundingClientRect();
      if (ev.ctrlKey || ev.metaKey) zoomAt(view.z * Math.pow(1.0015, -ev.deltaY), ev.clientX - r.left, ev.clientY - r.top);
      else setView((v) => ({ ...v, x: v.x - (ev.shiftKey ? ev.deltaY : ev.deltaX), y: v.y - (ev.shiftKey ? 0 : ev.deltaY) }));
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, [zoomAt, view.z]);

  const toWorld = (sx: number, sy: number): [number, number] => [(sx - view.x) / view.z, (sy - view.y) / view.z];
  const local = (ev: { clientX: number; clientY: number }): [number, number] => { const r = cv.current!.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };

  // ---------- drawing ----------
  useEffect(() => {
    const c = cv.current;
    if (!c || !vw) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(vw * dpr); c.height = Math.round(height * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#14171d'; ctx.fillRect(0, 0, vw, height);
    const { z, x: ox, y: oy } = view;
    const ax = ox, ay = oy, aw = W * z, ah = H * z;
    // artboard
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 16;
    ctx.fillStyle = bg === 'gridlight' ? '#f3f4f6' : bg === 'dark' ? '#0b0d12' : '#2a2f3a';
    ctx.fillRect(ax, ay, aw, ah);
    ctx.restore();
    if (bg === 'checker') {
      const s = Math.max(6, 16 * z);
      ctx.save(); ctx.beginPath(); ctx.rect(ax, ay, aw, ah); ctx.clip();
      ctx.fillStyle = '#3a404c';
      for (let yy = 0; yy * s < ah; yy++) for (let xx = (yy % 2); xx * s < aw; xx += 2) ctx.fillRect(ax + xx * s, ay + yy * s, s, s);
      ctx.restore();
    }
    if (bg === 'grid' || bg === 'gridlight') {
      const light = bg === 'gridlight';
      const minor = 10 * z >= 5 ? 10 : 10 * z * 5 >= 5 ? 50 : 100;
      ctx.save(); ctx.beginPath(); ctx.rect(ax, ay, aw, ah); ctx.clip();
      ctx.lineWidth = 1;
      for (const [step, col] of [[minor, light ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.06)'], [100, light ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.15)']] as [number, string][]) {
        if (step < minor) continue;
        ctx.strokeStyle = col; ctx.beginPath();
        for (let gx = step; gx < W; gx += step) { if (step === minor && gx % 100 === 0) continue; const sx = Math.round(ax + gx * z) + 0.5; ctx.moveTo(sx, ay); ctx.lineTo(sx, ay + ah); }
        for (let gy = step; gy < H; gy += step) { if (step === minor && gy % 100 === 0) continue; const sy = Math.round(ay + gy * z) + 0.5; ctx.moveTo(ax, sy); ctx.lineTo(ax + aw, sy); }
        ctx.stroke();
      }
      // centre cross
      ctx.strokeStyle = light ? 'rgba(14,165,233,0.35)' : 'rgba(56,189,248,0.3)'; ctx.setLineDash([4, 4]); ctx.beginPath();
      ctx.moveTo(Math.round(ax + aw / 2) + 0.5, ay); ctx.lineTo(Math.round(ax + aw / 2) + 0.5, ay + ah);
      ctx.moveTo(ax, Math.round(ay + ah / 2) + 0.5); ctx.lineTo(ax + aw, Math.round(ay + ah / 2) + 0.5); ctx.stroke(); ctx.setLineDash([]);
      ctx.restore();
    }
    // the title
    ctx.save();
    ctx.beginPath(); ctx.rect(ax, ay, aw, ah); ctx.clip();
    ctx.translate(ax, ay); ctx.scale(z, z);
    drawTitle(ctx, doc, { image: images, showHidden, placeholders: true, fallbackFont: 'Space Grotesk' });
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1; ctx.strokeRect(Math.round(ax) + 0.5, Math.round(ay) + 0.5, Math.round(aw), Math.round(ah));

    const scr = (b: Box): Box => [ax + b[0] * z, ay + b[1] * z, b[2] * z, b[3] * z];
    // hover
    const he = hover && !sel.includes(hover) ? byKey.get(hover) : null;
    if (he) { const [x, y, w, h] = scr(boxOf(he)); ctx.strokeStyle = 'rgba(56,189,248,0.7)'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w, h); }
    // selection
    const selEls = sel.map((k) => byKey.get(k)).filter((e): e is ElementInfo => !!e);
    for (const e of selEls) {
      const [x, y, w, h] = scr(boxOf(e));
      ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = 'rgba(56,189,248,0.06)'; ctx.fillRect(x, y, w, h);
    }
    if (selEls.length > 1) {
      const [x, y, w, h] = scr(unionBox(selEls.map(boxOf)));
      ctx.strokeStyle = 'rgba(56,189,248,0.6)'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1; ctx.strokeRect(x - 3, y - 3, w + 6, h + 6); ctx.setLineDash([]);
    }
    if (selEls.length === 1) {
      for (const [hx, hy] of handlePoints(scr(boxOf(selEls[0])))) {
        ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#0284c7'; ctx.lineWidth = 1.5;
        ctx.fillRect(hx - 4, hy - 4, 8, 8); ctx.strokeRect(hx - 4, hy - 4, 8, 8);
      }
    }
    // smart guides
    ctx.strokeStyle = '#f0abfc'; ctx.lineWidth = 1; ctx.beginPath();
    for (const gx of guides.x) { const sx = Math.round(ax + gx * z) + 0.5; ctx.moveTo(sx, RULER); ctx.lineTo(sx, height); }
    for (const gy of guides.y) { const sy = Math.round(ay + gy * z) + 0.5; ctx.moveTo(RULER, sy); ctx.lineTo(vw, sy); }
    ctx.stroke();
    // marquee
    if (marquee) {
      const [x, y, w, h] = scr(marquee);
      ctx.fillStyle = 'rgba(56,189,248,0.1)'; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#38bdf8'; ctx.setLineDash([4, 3]); ctx.strokeRect(x + 0.5, y + 0.5, w, h); ctx.setLineDash([]);
    }
    drawRulers(ctx, vw, height, view, cursor, selEls.length ? unionBox(selEls.map(boxOf)) : null);
  }, [doc, els, sel, showHidden, bg, images, redraw, view, vw, height, W, H, hover, guides, marquee, cursor, byKey, boxOf]);

  // ---------- picking ----------
  const pick = (wx: number, wy: number, alt: boolean): ElementInfo | null => {
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.node.tag === 'Layer' && !alt) continue; // Alt+click picks layers
      if (e.node.attrs.Locked === 'True' && !alt) continue; // locked: only from the layers list (or Alt)
      if (!showHidden && hiddenUnder(e)) continue;
      const [x, y, w, h] = boxOf(e);
      if (wx >= x && wx <= x + w && wy >= y && wy <= y + h) return e;
    }
    return null;
  };
  const handleAt = (sx: number, sy: number): Handle | null => {
    if (sel.length !== 1) return null;
    const e = byKey.get(sel[0]);
    if (!e) return null;
    const b = boxOf(e);
    const pts = handlePoints([view.x + b[0] * view.z, view.y + b[1] * view.z, b[2] * view.z, b[3] * view.z]);
    const i = pts.findIndex(([hx, hy]) => Math.abs(hx - sx) <= 6 && Math.abs(hy - sy) <= 6);
    return i >= 0 ? HANDLES[i] : null;
  };

  // snapping targets: edges and centres of everything not moving, and of the artboard
  const targets = (exclude: Set<string>) => {
    const xs = [0, W / 2, W], ys = [0, H / 2, H];
    if (snap.guides) for (const e of els) {
      const k = pathKey(e.path);
      if (exclude.has(k) || [...exclude].some((x) => k.startsWith(x + '/')) || (!showHidden && hiddenUnder(e))) continue;
      const [x, y, w, h] = boxOf(e);
      if (w >= W && h >= H) continue;
      xs.push(x, x + w / 2, x + w); ys.push(y, y + h / 2, y + h);
    }
    return { xs, ys };
  };
  const snapAxis = (vals: number[], tg: number[], tol: number): { d: number; at: number[] } => {
    let best: { d: number; at: number[] } = { d: 0, at: [] }, bestAbs = tol + 1;
    for (const v of vals) for (const t of tg) { const d = t - v; if (Math.abs(d) < bestAbs - 1e-6) { bestAbs = Math.abs(d); best = { d, at: [t] }; } else if (Math.abs(Math.abs(d) - bestAbs) < 1e-6 && !best.at.includes(t)) best.at.push(t); }
    return bestAbs <= tol ? best : { d: 0, at: [] };
  };

  return (
    <div ref={wrap} className="relative overflow-hidden rounded-lg border border-ink-800" style={{ height }}
      onDragOver={(e) => { if (onDropFiles && e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
      onDrop={(e) => {
        if (!onDropFiles) return;
        const files = Array.from(e.dataTransfer.files).filter((f) => /^image\/(png|jpeg)$/.test(f.type));
        if (!files.length) return;
        e.preventDefault();
        const [sx, sy] = local(e);
        onDropFiles(files, toWorld(sx, sy).map(Math.round) as [number, number]);
      }}>
      <canvas ref={cv} style={{ width: vw, height, display: 'block', cursor: drag.current?.kind === 'pan' ? 'grabbing' : space ? 'grab' : cssCursor, touchAction: 'none' }}
        onDoubleClick={(ev) => { const [sx, sy] = local(ev); const [wx, wy] = toWorld(sx, sy); const e = pick(wx, wy, ev.altKey); if (e) onDoubleClick?.(e); }}
        onPointerDown={(ev) => {
          const [sx, sy] = local(ev);
          (ev.target as HTMLCanvasElement).setPointerCapture(ev.pointerId);
          if (ev.button === 1 || space) { ev.preventDefault(); drag.current = { kind: 'pan', sx, sy, px: view.x, py: view.y }; return; }
          if (ev.button !== 0 || sx < RULER || sy < RULER) return;
          const [wx, wy] = toWorld(sx, sy);
          const hd = handleAt(sx, sy);
          if (hd) { const e = byKey.get(sel[0])!; drag.current = { kind: 'resize', handle: hd, key: sel[0], box: boxOf(e), wx, wy, id: ++dragSeq }; return; }
          const e = pick(wx, wy, ev.altKey);
          const k = e ? pathKey(e.path) : null;
          const add = ev.shiftKey || ev.ctrlKey || ev.metaKey;
          if (!k) { drag.current = { kind: 'marquee', wx, wy, cx: wx, cy: wy, add }; if (!add) setSel([]); return; }
          let next = sel;
          if (add) { next = sel.includes(k) ? sel.filter((x) => x !== k) : [...sel, k]; setSel(next); if (!next.includes(k)) return; }
          else if (!sel.includes(k)) { next = [k]; setSel(next); }
          const boxes = new Map<string, Box>();
          for (const s of topSelected(next)) { const se = byKey.get(s); if (se) boxes.set(s, boxOf(se)); }
          drag.current = { kind: 'move', wx, wy, boxes, id: ++dragSeq, moved: false };
        }}
        onPointerMove={(ev) => {
          const [sx, sy] = local(ev);
          const [wx, wy] = toWorld(sx, sy);
          setCursor([wx, wy]);
          const d = drag.current;
          if (!d) {
            const hd = handleAt(sx, sy);
            setCssCursor(hd ? CURSOR[hd] : 'default');
            const e = sx > RULER && sy > RULER ? pick(wx, wy, ev.altKey) : null;
            setHover(e ? pathKey(e.path) : null);
            return;
          }
          if (d.kind === 'pan') { setView((v) => ({ ...v, x: d.px + sx - d.sx, y: d.py + sy - d.sy })); return; }
          if (d.kind === 'marquee') { d.cx = wx; d.cy = wy; setMarquee([Math.min(d.wx, wx), Math.min(d.wy, wy), Math.abs(wx - d.wx), Math.abs(wy - d.wy)]); return; }
          const tol = 6 / view.z;
          if (d.kind === 'move') {
            let dx = wx - d.wx, dy = wy - d.wy;
            if (!d.moved && Math.hypot(dx, dy) * view.z < 3) return;
            d.moved = true;
            if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; } // straight lines
            const u = unionBox([...d.boxes.values()]);
            let mx = u[0] + dx, my = u[1] + dy;
            const tg = targets(new Set(d.boxes.keys()));
            const gx: number[] = [], gy: number[] = [];
            const s1 = snapAxis([mx, mx + u[2] / 2, mx + u[2]], tg.xs, tol);
            const s2 = snapAxis([my, my + u[3] / 2, my + u[3]], tg.ys, tol);
            if (s1.at.length) { mx += s1.d; gx.push(...s1.at); } else if (snap.grid) mx = Math.round(mx / 10) * 10;
            if (s2.at.length) { my += s2.d; gy.push(...s2.at); } else if (snap.grid) my = Math.round(my / 10) * 10;
            if (!ev.altKey) setGuides({ x: gx, y: gy }); else { mx = u[0] + dx; my = u[1] + dy; setGuides({ x: [], y: [] }); }
            const ddx = Math.round(mx - u[0]), ddy = Math.round(my - u[1]);
            const out = new Map<string, Box>();
            for (const [k, b] of d.boxes) out.set(k, [b[0] + ddx, b[1] + ddy, b[2], b[3]]);
            onBoxes(out, false, `drag-${d.id}`);
            return;
          }
          // resize
          const [bx, by, bw, bh] = d.box;
          let x0 = bx, y0 = by, x1 = bx + bw, y1 = by + bh;
          const h = d.handle;
          const dx = wx - d.wx, dy = wy - d.wy;
          if (h.includes('w')) x0 += dx; if (h.includes('e')) x1 += dx;
          if (h.includes('n')) y0 += dy; if (h.includes('s')) y1 += dy;
          const tg = targets(new Set([d.key]));
          const gx: number[] = [], gy: number[] = [];
          const snapEdge = (v: number, list: number[], g: number[]) => { const s = snapAxis([v], list, tol); if (s.at.length && !ev.altKey) { g.push(...s.at); return v + s.d; } return snap.grid && !ev.altKey ? Math.round(v / 10) * 10 : v; };
          if (h.includes('w')) x0 = snapEdge(x0, tg.xs, gx); if (h.includes('e')) x1 = snapEdge(x1, tg.xs, gx);
          if (h.includes('n')) y0 = snapEdge(y0, tg.ys, gy); if (h.includes('s')) y1 = snapEdge(y1, tg.ys, gy);
          if (ev.shiftKey && bw > 0 && bh > 0) { // keep the proportions
            const r = bw / bh;
            if (h === 'n' || h === 's') { const nw = (y1 - y0) * r; x0 = bx + (bw - nw) / 2; x1 = x0 + nw; }
            else if (h === 'e' || h === 'w') { const nh = (x1 - x0) / r; y0 = by + (bh - nh) / 2; y1 = y0 + nh; }
            else { const nw = x1 - x0, nh = y1 - y0; if (Math.abs(nw / r) > Math.abs(nh)) { const t = nw / r; if (h.includes('n')) y0 = y1 - t; else y1 = y0 + t; } else { const t = nh * r; if (h.includes('w')) x0 = x1 - t; else x1 = x0 + t; } }
          }
          if (x1 - x0 < 1) { if (h.includes('w')) x0 = x1 - 1; else x1 = x0 + 1; }
          if (y1 - y0 < 1) { if (h.includes('n')) y0 = y1 - 1; else y1 = y0 + 1; }
          setGuides({ x: gx, y: gy });
          onBoxes(new Map([[d.key, [Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)]]]), true, `resize-${d.id}`);
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          setGuides({ x: [], y: [] });
          if (d?.kind === 'marquee') {
            setMarquee(null);
            const m: Box = [Math.min(d.wx, d.cx), Math.min(d.wy, d.cy), Math.abs(d.cx - d.wx), Math.abs(d.cy - d.wy)];
            if (m[2] * view.z < 3 && m[3] * view.z < 3) return;
            const hit = els.filter((e) => e.node.tag !== 'Layer' && e.node.attrs.Locked !== 'True' && (showHidden || !hiddenUnder(e)))
              .filter((e) => { const [x, y, w, h] = boxOf(e); return x < m[0] + m[2] && x + w > m[0] && y < m[1] + m[3] && y + h > m[1]; })
              .map((e) => pathKey(e.path));
            setSel(d.add ? [...new Set([...sel, ...hit])] : hit);
          }
        }}
        onPointerLeave={() => { setCursor(null); setHover(null); }} />
    </div>
  );
});

function handlePoints([x, y, w, h]: Box): [number, number][] {
  return [[x, y], [x + w / 2, y], [x + w, y], [x + w, y + h / 2], [x + w, y + h], [x + w / 2, y + h], [x, y + h], [x, y + h / 2]];
}

function drawRulers(ctx: CanvasRenderingContext2D, vw: number, vh: number, v: { z: number; x: number; y: number }, cursor: [number, number] | null, selBox: Box | null) {
  ctx.fillStyle = '#0f1217';
  ctx.fillRect(0, 0, vw, RULER); ctx.fillRect(0, 0, RULER, vh);
  // the selection's extent on the rulers
  if (selBox) {
    ctx.fillStyle = 'rgba(56,189,248,0.25)';
    ctx.fillRect(v.x + selBox[0] * v.z, 0, selBox[2] * v.z, RULER);
    ctx.fillRect(0, v.y + selBox[1] * v.z, RULER, selBox[3] * v.z);
  }
  const step = [10, 20, 50, 100, 200, 500, 1000].find((s) => s * v.z >= 60) ?? 1000;
  const minor = step / (step === 20 || step === 200 ? 4 : 5);
  ctx.strokeStyle = '#4b5563'; ctx.fillStyle = '#9ca3af'; ctx.font = '9px ui-sans-serif, system-ui'; ctx.lineWidth = 1;
  ctx.beginPath();
  const x0 = Math.floor((RULER - v.x) / v.z / minor) * minor, x1 = (vw - v.x) / v.z;
  for (let wx = x0; wx <= x1; wx += minor) {
    const sx = Math.round(v.x + wx * v.z) + 0.5;
    if (sx < RULER) continue;
    const major = Math.abs(wx / step - Math.round(wx / step)) < 1e-6;
    ctx.moveTo(sx, major ? 0 : RULER - 5); ctx.lineTo(sx, RULER);
    if (major) ctx.fillText(String(Math.round(wx)), sx + 2, 9);
  }
  const y0 = Math.floor((RULER - v.y) / v.z / minor) * minor, y1 = (vh - v.y) / v.z;
  for (let wy = y0; wy <= y1; wy += minor) {
    const sy = Math.round(v.y + wy * v.z) + 0.5;
    if (sy < RULER) continue;
    const major = Math.abs(wy / step - Math.round(wy / step)) < 1e-6;
    ctx.moveTo(major ? 0 : RULER - 5, sy); ctx.lineTo(RULER, sy);
    if (major) { ctx.save(); ctx.translate(9, sy + 2); ctx.rotate(-Math.PI / 2); ctx.fillText(String(Math.round(wy)), 0, 0); ctx.restore(); }
  }
  ctx.stroke();
  if (cursor) {
    ctx.strokeStyle = '#f472b6'; ctx.beginPath();
    const cx = Math.round(v.x + cursor[0] * v.z) + 0.5, cy = Math.round(v.y + cursor[1] * v.z) + 0.5;
    ctx.moveTo(cx, 0); ctx.lineTo(cx, RULER); ctx.moveTo(0, cy); ctx.lineTo(RULER, cy); ctx.stroke();
  }
  ctx.fillStyle = '#0f1217'; ctx.fillRect(0, 0, RULER, RULER);
  ctx.strokeStyle = '#1f2937'; ctx.beginPath(); ctx.moveTo(RULER + 0.5, 0); ctx.lineTo(RULER + 0.5, vh); ctx.moveTo(0, RULER + 0.5); ctx.lineTo(vw, RULER + 0.5); ctx.stroke();
}
