import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { OverviewSailor, OverviewTeam } from '../api';

/**
 * Sailor photos on the commentator screen: a small round photo on every crew row, and a large card with the
 * photo and everything about the sailor. Hovering a row shows the card; a click (or a tap) keeps it open;
 * Esc, a click elsewhere or a click on the same row closes it. One card at a time for the whole page.
 */
export type SailorLine = { key: string; number: string; first: string; last: string; position: string; weight: string; captain: boolean; sailor?: OverviewSailor };

type Shown = { line: SailorLine; team: OverviewTeam; flag: string | null; rect: DOMRect; pinned: boolean; el: HTMLElement };
let shown: Shown | null = null;
const subs = new Set<() => void>();
const set = (v: Shown | null) => { shown = v; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

const photoOf = (l: SailorLine) => l.sailor?.photo?.previewUrl ?? null;
const initials = (l: SailorLine) => `${l.first.trim()[0] ?? ''}${l.last.trim()[0] ?? ''}`.toUpperCase() || '?';

/** The small round photo at the start of a crew row (initials when there is no photo). Sized in em, so it grows with the row. */
export function SailorThumb({ line, size = '1.5em' }: { line: SailorLine; size?: string }) {
  const src = photoOf(line);
  return (
    <span className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-ink-800 ring-1 ring-ink-700" style={{ width: size, height: size }} aria-hidden>
      {src ? <img src={src} alt="" loading="lazy" className="h-full w-full object-cover object-top" />
        : <span className="text-[0.45em] font-bold text-ink-400">{initials(line)}</span>}
    </span>
  );
}

/** Props for a crew row: hover shows the sailor's card, a click keeps it open (and does not open the team). */
export function sailorRow(line: SailorLine, team: OverviewTeam, flag: string | null) {
  return {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      if (shown?.pinned) return;
      set({ line, team, flag, rect: e.currentTarget.getBoundingClientRect(), pinned: false, el: e.currentTarget });
    },
    onMouseLeave: () => { if (shown && !shown.pinned) set(null); },
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      e.stopPropagation();
      if (shown?.pinned && shown.line.key === line.key && shown.team.id === team.id) { set(null); return; }
      set({ line, team, flag, rect: e.currentTarget.getBoundingClientRect(), pinned: true, el: e.currentTarget });
    },
  };
}

/** Render once on the page: the card of the sailor under the mouse (or the one clicked). */
export function SailorPopover() {
  const s = useSyncExternalStore(subscribe, () => shown);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // beside the row: to the right when there is room, else to the left; kept inside the window
  useLayoutEffect(() => {
    if (!s || !box.current) { setPos(null); return; }
    const w = box.current.offsetWidth, h = box.current.offsetHeight, gap = 10, vw = window.innerWidth, vh = window.innerHeight;
    const r = s.rect;
    const clampY = (y: number) => Math.min(Math.max(8, y), vh - h - 8);
    let left: number, top: number;
    if (r.right + gap + w <= vw - 8) { left = r.right + gap; top = clampY(r.top + r.height / 2 - h / 2); }
    else if (r.left - gap - w >= 8) { left = r.left - gap - w; top = clampY(r.top + r.height / 2 - h / 2); }
    else {
      // a wide row (one team on its own): under the row, or above it near the bottom of the screen, so the row stays readable
      left = Math.min(Math.max(8, r.left + 40), vw - w - 8);
      top = r.bottom + gap + h <= vh - 8 ? r.bottom + gap : clampY(r.top - gap - h);
    }
    setPos({ left, top });
  }, [s]);

  useEffect(() => {
    if (!s?.pinned) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); set(null); } };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || s.el.contains(t)) return;
      set(null);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); };
  }, [s]);
  // the page scrolled or resized: the card would point at the wrong row
  useEffect(() => {
    if (!s) return;
    const close = () => set(null);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, [s]);

  if (!s) return null;
  const { line: l, team } = s;
  const p = l.sailor;
  const src = photoOf(l);
  const best = p ? [p.bestResult1, p.bestResult2, p.bestResult3].filter(Boolean) : [];
  const facts: [string, string][] = ([
    ['Number', l.number],
    ['Position', l.position || p?.defaultPosition || ''],
    ['Age', p?.age != null ? `${p.age}` : ''],
    ['Height', p?.heightCm ? `${(p.heightCm / 100).toFixed(2)} m` : ''],
    ['Weight', l.weight ? `${l.weight} kg` : ''],
  ] as [string, string][]).filter(([, v]) => v);
  return createPortal(
    <div ref={box} role="dialog" aria-label={`${l.first} ${l.last}`}
      className="fixed z-50 flex w-[560px] max-w-[calc(100vw-16px)] overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onMouseLeave={() => { if (!s.pinned) set(null); }}>
      <div className="flex w-[220px] shrink-0 items-center justify-center bg-ink-950">
        {src ? <img src={src} alt="" className="h-[280px] w-full object-cover object-top" />
          : <span className="flex h-[280px] w-full items-center justify-center text-6xl font-black text-ink-700">{initials(l)}</span>}
      </div>
      <div className="min-w-0 flex-1 p-4">
        <div className="flex items-center gap-2 text-sm font-bold text-ink-300">
          {s.flag && <img src={s.flag} alt="" className="h-5 w-auto rounded-sm" />}
          <span className="font-mono">{team.code}</span>
          <span className="truncate font-normal text-ink-400">{team.name}</span>
        </div>
        <div className="mt-1 text-3xl font-semibold leading-tight text-ink-50">
          {l.captain && <span className="mr-1 text-amber-400" title="Captain">★</span>}
          {l.first} <span className="font-black uppercase">{l.last}</span>
        </div>
        {l.captain && <div className="text-sm font-bold uppercase tracking-wide text-amber-400">Captain</div>}
        {facts.length > 0 && (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-lg">
            {facts.map(([k, v]) => <React.Fragment key={k}><dt className="text-ink-500">{k}</dt><dd className="font-semibold tabular-nums text-ink-100">{v}</dd></React.Fragment>)}
          </dl>
        )}
        {best.length > 0 && (
          <div className="mt-3">
            <h4 className="text-xs font-bold uppercase tracking-wide text-ink-500">Best results</h4>
            <ul className="mt-1 space-y-0.5 text-base leading-snug text-ink-100">{best.map((b, i) => <li key={i}>🏆 {b}</li>)}</ul>
          </div>
        )}
        {!p && <p className="mt-3 text-sm text-ink-500">Not matched to a sailor in Teams, so there is no photo or profile.</p>}
        <p className="mt-3 text-xs text-ink-600">{s.pinned ? 'Esc or click outside to close' : 'Click to keep open'}</p>
      </div>
    </div>,
    document.body,
  );
}
