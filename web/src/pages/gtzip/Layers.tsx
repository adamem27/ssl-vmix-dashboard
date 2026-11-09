import { useMemo, useRef, useState } from 'react';
import { ElementInfo, isVisible, Path, pathKey } from '../../../../server/src/services/gtzip/model';
import { cx } from '../../components/ui';

const TAG_ICON: Record<string, string> = { Layer: '▣', TextBlock: 'T', Image: '◩', Rectangle: '▭', Ellipse: '◯', Ticker: '⇢', Triangle: '△' };

export interface DropTarget { layer: Path | null; index?: number }

/**
 * Layers as in a drawing program: the front-most on top, folders for layers, drag to reorder or drop onto a layer
 * to put it inside, double-click to rename, eye and lock per row.
 */
export function Layers({ els, sel, setSel, onToggle, onLock, onRename, onPng, onMove }: {
  els: ElementInfo[]; sel: string[]; setSel: (s: string[]) => void;
  onToggle: (e: ElementInfo) => void; onLock: (e: ElementInfo) => void; onRename: (e: ElementInfo, name: string) => void;
  onPng: (e: ElementInfo) => void; onMove: (paths: Path[], to: DropTarget) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [over, setOver] = useState<{ k: string; where: 'above' | 'below' | 'into' } | null>(null);
  const dragKeys = useRef<string[] | null>(null);
  const lastClick = useRef<string | null>(null);
  const byKey = useMemo(() => new Map(els.map((e) => [pathKey(e.path), e])), [els]);

  const rows = useMemo(() => {
    const out: ElementInfo[] = [];
    const kids = (parent: string | null) => els.filter((e) => (e.parentPath ? pathKey(e.parentPath) : null) === parent).reverse();
    const walk = (parent: string | null, hiddenParent: boolean) => {
      for (const e of kids(parent)) {
        if (!hiddenParent) out.push(e);
        walk(pathKey(e.path), hiddenParent || collapsed.has(e.node.attrs.Name ?? pathKey(e.path)));
      }
    };
    walk(null, false);
    const f = filter.trim().toLowerCase();
    return f ? els.filter((e) => (e.node.attrs.Name ?? '').toLowerCase().includes(f)).reverse() : out;
  }, [els, collapsed, filter]);

  const click = (ev: React.MouseEvent, k: string) => {
    if (ev.shiftKey && lastClick.current) {
      const a = rows.findIndex((r) => pathKey(r.path) === lastClick.current), b = rows.findIndex((r) => pathKey(r.path) === k);
      if (a >= 0 && b >= 0) { setSel([...new Set([...sel, ...rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => pathKey(r.path))])]); return; }
    }
    if (ev.ctrlKey || ev.metaKey) setSel(sel.includes(k) ? sel.filter((x) => x !== k) : [...sel, k]);
    else setSel([k]);
    lastClick.current = k;
  };

  const drop = (target: ElementInfo, where: 'above' | 'below' | 'into') => {
    const keys = dragKeys.current;
    dragKeys.current = null; setOver(null);
    if (!keys?.length) return;
    const paths = keys.map((k) => byKey.get(k)?.path).filter((p): p is Path => !!p);
    if (where === 'into') { onMove(paths, { layer: target.path }); return; }
    const i = target.path[target.path.length - 1];
    // the list shows the front-most first: above = drawn later (after it), below = drawn before it
    onMove(paths, { layer: target.parentPath, index: where === 'above' ? i + 1 : i });
  };

  return (
    <div className="card flex min-h-0 flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-b border-ink-800 px-2 py-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Layers</span>
        <input className="ml-auto w-28 rounded bg-transparent px-1.5 py-0.5 text-xs outline-none ring-1 ring-ink-800 placeholder:text-ink-600 focus:ring-accent-500" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <ul className="min-h-0 flex-1 overflow-auto py-1 text-xs" onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(null); }}>
        {rows.map((e) => {
          const k = pathKey(e.path), name = e.node.attrs.Name ?? `(${e.node.tag})`, ck = e.node.attrs.Name ?? k;
          const isLayer = e.node.tag === 'Layer';
          const locked = e.node.attrs.Locked === 'True';
          const o = over?.k === k ? over.where : null;
          return (
            <li key={k} draggable={editing !== k}
              onDragStart={(ev) => { dragKeys.current = sel.includes(k) ? sel : [k]; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', name); }}
              onDragEnd={() => { dragKeys.current = null; setOver(null); }}
              onDragOver={(ev) => {
                if (!dragKeys.current || dragKeys.current.includes(k)) return;
                ev.preventDefault();
                const r = ev.currentTarget.getBoundingClientRect(), f = (ev.clientY - r.top) / r.height;
                const where = isLayer && f > 0.3 && f < 0.7 ? 'into' : f < 0.5 ? 'above' : 'below';
                if (o !== where) setOver({ k, where });
              }}
              onDrop={(ev) => { ev.preventDefault(); if (o) drop(e, o); }}
              className={cx('group relative flex items-center gap-1 pr-1', sel.includes(k) ? 'bg-accent-600/30 text-ink-50' : 'hover:bg-ink-800',
                o === 'into' && 'outline outline-1 outline-accent-400')}
              style={{ paddingLeft: 4 + (filter ? 0 : e.depth * 12) }}>
              {o === 'above' && <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-accent-400" />}
              {o === 'below' && <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-accent-400" />}
              <button className="w-4 shrink-0 text-ink-500" onClick={() => isLayer && setCollapsed((c) => { const n = new Set(c); if (n.has(ck)) n.delete(ck); else n.add(ck); return n; })}>
                {isLayer ? (collapsed.has(ck) ? '▸' : '▾') : ''}
              </button>
              <span className={cx('w-4 shrink-0 text-center', isLayer ? 'text-amber-300' : e.node.tag === 'TextBlock' ? 'text-sky-300' : e.node.tag === 'Image' ? 'text-emerald-300' : 'text-violet-300')}>{TAG_ICON[e.node.tag] ?? '•'}</span>
              {editing === k ? (
                <input autoFocus defaultValue={e.node.attrs.Name ?? ''} className="min-w-0 flex-1 rounded bg-ink-950 px-1 py-0.5 text-xs outline-none ring-1 ring-accent-500"
                  onBlur={(ev) => { setEditing(null); if (ev.target.value && ev.target.value !== e.node.attrs.Name) onRename(e, ev.target.value); }}
                  onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); if (ev.key === 'Escape') setEditing(null); }} />
              ) : (
                <button className={cx('min-w-0 flex-1 truncate py-1 text-left', !isVisible(e.node) && 'text-ink-500 line-through decoration-ink-600', locked && 'italic')}
                  onClick={(ev) => click(ev, k)} onDoubleClick={() => e.node.attrs.Name != null && setEditing(k)} title="Double-click to rename · drag to reorder, drop on a layer to put it inside">{name}</button>
              )}
              <button className="invisible px-0.5 text-ink-500 hover:text-ink-100 group-hover:visible" title="Download as PNG" onClick={() => onPng(e)}>⤓</button>
              <button className={cx('grid w-4 place-items-center', locked ? 'text-amber-300' : 'invisible text-ink-500 hover:text-ink-200 group-hover:visible')} title={locked ? 'Locked: not picked on the canvas (Alt+click still picks it) – click to unlock' : 'Lock'} onClick={() => onLock(e)}>
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d={locked ? 'M8 11V7a4 4 0 0 1 8 0v4' : 'M8 11V7a4 4 0 0 1 7.5-2'} /></svg>
              </button>
              <button className={cx('w-4 px-0.5', isVisible(e.node) ? 'text-ink-300' : 'text-ink-700')} title={isVisible(e.node) ? 'Visible – click to hide' : 'Hidden – click to show'} onClick={() => onToggle(e)}>{isVisible(e.node) ? '👁' : '◌'}</button>
            </li>
          );
        })}
        {!rows.length && <li className="px-3 py-4 text-ink-500">Nothing here yet. Add text, a shape or a picture from the toolbar.</li>}
      </ul>
    </div>
  );
}
