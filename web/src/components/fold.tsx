import { ReactNode, useState } from 'react';

/** Open or folded, remembered per section in this browser (default: open). */
export function useFold(id: string, openByDefault = true): [boolean, (v: boolean) => void] {
  const key = `fold:${id}`;
  const [open, setOpen] = useState(() => {
    try { const v = localStorage.getItem(key); return v === null ? openByDefault : v === '1'; } catch { return openByDefault; }
  });
  const set = (v: boolean) => { setOpen(v); try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* storage unavailable */ } };
  return [open, set];
}

/** The ▾ / ▸ in front of a section title; the whole title folds the section. */
export function FoldTitle({ open, onToggle, children, className = 'text-sm font-bold uppercase tracking-wide text-ink-200' }: { open: boolean; onToggle: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} title={open ? 'Fold this section' : 'Open this section'} className={`flex items-center gap-1.5 text-left hover:text-ink-50 ${className}`}>
      <span className="inline-block w-3 text-[10px] text-ink-500">{open ? '▾' : '▸'}</span>
      {children}
    </button>
  );
}

/**
 * A long list: about `rows` items show at once and the rest scroll; “Show all” opens the whole list.
 * `rowPx` is the height of one item.
 */
export function ScrollList({ count, rows = 10, rowPx, children, className = '' }: { count: number; rows?: number; rowPx: number; children: ReactNode; className?: string }) {
  const [all, setAll] = useState(false);
  const long = count > rows;
  return (
    <div>
      <div className={`${className} ${long && !all ? 'overflow-y-auto pr-1' : ''}`} style={long && !all ? { maxHeight: rows * rowPx } : undefined}>{children}</div>
      {long && (
        <button type="button" onClick={() => setAll(!all)} className="mt-1 text-[11px] text-accent-300 hover:underline">
          {all ? `Show ${rows} at a time` : `Show all ${count}`}
        </button>
      )}
    </div>
  );
}
