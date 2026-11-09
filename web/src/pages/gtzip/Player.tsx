import { useEffect, useMemo, useRef, useState } from 'react';
import { animAt, previewStoryboards, Segment, segmentEnd, timelineLength } from '../../../../server/src/services/gtzip/anim';
import { animationsOf, GtNode } from '../../../../server/src/services/gtzip/model';
import { cx } from '../../components/ui';

export interface Frame {
  anim: ReturnType<typeof animAt>;
  text?: (n: GtNode) => string | undefined;
}
type Mode = 'in' | 'out' | 'cycle' | 'data';
const HOLD = 1.5; // seconds on screen between In and Out in the full cycle

/**
 * Plays the title's animations on the canvas: In, Out, the full cycle (In, hold, Out) and a data change of one field
 * (Out of the old value, new value, In). A timeline shows every animation as a bar; drag on it to scrub.
 */
export function Player({ doc, onFrame, compact }: { doc: GtNode; onFrame: (f: Frame | null) => void; compact?: boolean }) {
  const W = Number(doc.attrs.Width ?? 1920), H = Number(doc.attrs.Height ?? 1080);
  const sb = useMemo(() => previewStoryboards(doc), [doc]);
  const [mode, setMode] = useState<Mode>('cycle');
  const [field, setField] = useState('');
  const [newText, setNewText] = useState('NEW VALUE');
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [active, setActive] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);
  const fieldNow = field || sb.fields[0] || '';

  const segs: Segment[] = useMemo(() => {
    if (mode === 'in') return sb.in ? [{ sb: sb.in, phase: 'in', start: 0 }] : [];
    if (mode === 'out') return sb.out ? [{ sb: sb.out, phase: 'out', start: 0 }] : [];
    if (mode === 'cycle') {
      const out: Segment[] = [];
      if (sb.in) out.push({ sb: sb.in, phase: 'in', start: 0 });
      const s2 = out.length ? segmentEnd(out[0]) + HOLD : 0;
      if (sb.out) out.push({ sb: sb.out, phase: 'out', start: s2 });
      return out;
    }
    const dc = sb.dataChange(fieldNow);
    const out: Segment[] = [];
    if (dc.out) out.push({ sb: dc.out, phase: 'out', start: 0 });
    if (dc.in) out.push({ sb: dc.in, phase: 'in', start: out.length ? segmentEnd(out[0]) : 0 });
    return out;
  }, [mode, sb, fieldNow]);
  const len = Math.max(timelineLength(segs), mode === 'cycle' && sb.in && !sb.out ? timelineLength(segs) + HOLD : 0);
  const swapAt = mode === 'data' ? (segs.find((s) => s.phase === 'in')?.start ?? 0) : Infinity;
  const fieldEl = fieldNow.replace(/\.(Text|Source)$/, '');

  // the frame the canvas draws
  useEffect(() => {
    if (!active || !segs.length) { onFrame(null); return; }
    const anim = animAt(segs, t, [W, H]);
    const text = mode === 'data' && fieldNow.endsWith('.Text') && t >= swapAt ? (n: GtNode) => (n.attrs.Name === fieldEl ? newText : undefined) : undefined;
    onFrame({ anim, text });
  }, [active, segs, t, W, H, mode, fieldNow, fieldEl, newText, swapAt, onFrame]);
  useEffect(() => () => onFrame(null), [onFrame]);

  // playback
  const raf = useRef(0);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = ((now - last) / 1000) * speed; last = now;
      setT((cur) => {
        const n = cur + dt;
        if (n >= len) {
          if (loop) return 0;
          setPlaying(false);
          return len;
        }
        return n;
      });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed, len, loop]);

  const play = (m: Mode) => { setMode(m); setActive(true); setT(0); setPlaying(true); };
  const stop = () => { setPlaying(false); setActive(false); setT(0); };
  const has = { in: !!sb.in, out: !!sb.out, data: sb.fields.length > 0 };

  // timeline bars
  const lanes = useMemo(() => segs.flatMap((s) => animationsOf(s.sb).map((a) => ({
    name: a.attrs.Object ?? '?', type: a.tag, phase: s.phase,
    from: s.start + Number(a.attrs.Delay ?? 0), to: s.start + Number(a.attrs.Delay ?? 0) + Number(a.attrs.Duration ?? 1),
  }))), [segs]);
  const bar = useRef<HTMLDivElement>(null);
  const scrub = (clientX: number) => {
    const r = bar.current?.getBoundingClientRect();
    if (!r || !len) return;
    setActive(true); setPlaying(false);
    setT(Math.max(0, Math.min(len, ((clientX - r.left) / r.width) * len)));
  };

  const btn = (on: boolean) => cx('rounded px-2 py-1 text-xs font-semibold disabled:opacity-30', on ? 'bg-accent-600 text-white' : 'bg-ink-800 text-ink-200 hover:bg-ink-700');
  return (
    <div className={cx(compact ? 'rounded-md bg-black/70 p-2 text-white' : 'card p-2')} onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cx('mr-1 text-[11px] font-semibold uppercase tracking-wide', compact ? 'text-white/70' : 'text-ink-400')}>Animation</span>
        <button className={btn(active && mode === 'in')} disabled={!has.in} onClick={() => play('in')} title="Play TransitionIn">▶ In</button>
        <button className={btn(active && mode === 'out')} disabled={!has.out} onClick={() => play('out')} title="Play TransitionOut">▶ Out</button>
        <button className={btn(active && mode === 'cycle')} disabled={!has.in && !has.out} onClick={() => play('cycle')} title={`In, ${HOLD} s on screen, Out`}>▶ In → Out</button>
        {has.data && <>
          <span className={cx('ml-2 text-xs', compact ? 'text-white/70' : 'text-ink-400')}>Data change</span>
          <select className="rounded bg-ink-900 px-1 py-1 text-xs text-ink-100" value={fieldNow} onChange={(e) => setField(e.target.value)}>
            {sb.fields.map((f) => <option key={f}>{f}</option>)}
          </select>
          {fieldNow.endsWith('.Text') && <input className="w-28 rounded bg-ink-900 px-1.5 py-1 text-xs text-ink-100 outline-none ring-1 ring-ink-700" value={newText} onChange={(e) => setNewText(e.target.value)} title="New value shown after the change" />}
          <button className={btn(active && mode === 'data')} onClick={() => play('data')}>▶ Change</button>
        </>}
        {!has.in && !has.out && !has.data && <span className="text-xs text-ink-500">This title has no animations yet (add them on the Animations tab).</span>}
        <span className="ml-auto" />
        {active && <>
          <button className={btn(false)} onClick={() => { if (t >= len) setT(0); setPlaying(!playing); }} title="Play / pause">{playing ? '❚❚' : '▶'}</button>
          <select className="rounded bg-ink-900 px-1 py-1 text-xs text-ink-100" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Speed">
            {[0.1, 0.25, 0.5, 1, 2].map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
          <label className={cx('flex items-center gap-1 text-xs', compact ? 'text-white/80' : 'text-ink-300')}><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />Loop</label>
          <span className="w-28 whitespace-nowrap text-right font-mono text-xs tabular-nums">{t.toFixed(2)} / {len.toFixed(2)}s</span>
          <button className={btn(false)} onClick={stop} title="Back to the design">■ Stop</button>
        </>}
      </div>
      {active && len > 0 && (
        <div className="mt-2 select-none">
          <div ref={bar} className="relative cursor-ew-resize rounded bg-ink-950/60" style={{ height: compact ? 14 : Math.min(160, 10 + lanes.length * 8) }}
            onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); scrub(e.clientX); }}
            onPointerMove={(e) => { if (e.buttons) scrub(e.clientX); }}>
            {!compact && lanes.map((l, i) => (
              <div key={i} title={`${l.name} · ${l.type} ${l.from.toFixed(2)}–${l.to.toFixed(2)} s`}
                className={cx('absolute h-1.5 rounded-sm', l.phase === 'in' ? 'bg-emerald-400/80' : 'bg-rose-400/80')}
                style={{ left: `${(l.from / len) * 100}%`, width: `${Math.max(0.5, ((l.to - l.from) / len) * 100)}%`, top: 5 + i * 8 * Math.min(1, 150 / (lanes.length * 8)) }} />
            ))}
            {mode === 'cycle' && segs.length === 2 && <div className="absolute inset-y-0 bg-white/5" style={{ left: `${(segmentEnd(segs[0]) / len) * 100}%`, width: `${(HOLD / len) * 100}%` }} title="On screen" />}
            {Number.isFinite(swapAt) && <div className="absolute inset-y-0 w-px bg-amber-300" style={{ left: `${(swapAt / len) * 100}%` }} title="The new value comes in here" />}
            <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-pink-400" style={{ left: `${(t / len) * 100}%` }} />
          </div>
          {!compact && <div className="mt-1 flex gap-3 text-[10px] text-ink-500"><span><i className="mr-1 inline-block h-1.5 w-3 rounded-sm bg-emerald-400/80" />In</span><span><i className="mr-1 inline-block h-1.5 w-3 rounded-sm bg-rose-400/80" />Out</span><span>Drag on the bars to scrub · hover a bar for its element</span></div>}
        </div>
      )}
    </div>
  );
}
