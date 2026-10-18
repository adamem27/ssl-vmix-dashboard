import { DragEvent, useEffect, useRef, useState } from 'react';
import { api, Asset } from '../api';
import { cx, useToast } from './ui';

// ---------- inline editing ----------
export function Cell({ value, onSave, className, required, label, suggestions, placeholder }: { value: string; onSave: (v: string) => Promise<void>; className?: string; required?: boolean; label: string; suggestions?: string[]; placeholder?: string }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!editing) setV(value); }, [value, editing]);
  const commit = async () => {
    const next = v.trim();
    if (next === value || (required && !next)) { setEditing(false); setV(value); return; }
    setBusy(true);
    try { await onSave(next); setEditing(false); } catch { /* toast shown by caller; keep editing */ } finally { setBusy(false); }
  };
  if (editing) {
    const listId = suggestions ? `dl-${label.replace(/\W+/g, '-')}` : undefined;
    return (
      <>
        <input autoFocus className={cx('input py-1 text-sm', className)} value={v} disabled={busy} aria-label={label} list={listId} placeholder={placeholder}
          onChange={(e) => setV(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') { setV(value); setEditing(false); } }} />
        {suggestions && <datalist id={listId}>{suggestions.map((o) => <option key={o} value={o} />)}</datalist>}
      </>
    );
  }
  return (
    <button onClick={() => setEditing(true)} title={`Edit ${label.toLowerCase()}`} aria-label={`${label}: ${value || 'empty'}`}
      className={cx('block min-h-[30px] w-full truncate rounded border border-transparent px-1 py-1 text-left hover:border-ink-700', className)}>
      {value || <span className="text-ink-600">{placeholder ?? '—'}</span>}
    </button>
  );
}

/** Dropdown that saves on change. Values not in the list stay selectable. */
export function SelectCell({ value, options, onSave, label, className }: { value: string; options: string[]; onSave: (v: string) => Promise<void> | void; label: string; className?: string }) {
  const opts = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <select aria-label={label} value={value} onChange={(e) => void onSave(e.target.value)}
      className={cx('w-full rounded border border-transparent bg-transparent px-1 py-1 text-sm text-ink-100 hover:border-ink-700 focus:border-accent-400 focus:outline-none', className)}>
      <option value="">—</option>
      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

export function ImgCell({ kind, ownerId, slot, label, asset, onChanged, accept = 'png' }: { kind: 'teams' | 'sailors' | 'people'; ownerId: string; slot: string; label: string; asset: Asset | null | undefined; onChanged: () => void; accept?: 'png' | 'png+jpg' }) {
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const base = `/api/${kind}/${ownerId}/assets/${slot}`;
  const upload = async (file: File) => {
    setBusy(true);
    try { await api.upload(`${base}/upload`, file); onChanged(); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) void upload(f);
  };
  const remove = async () => {
    try { await api.del(base); onChanged(); } catch (e) { toast.error(e); }
  };
  const bad = asset && asset.checkStatus !== 'stored' && asset.checkStatus !== 'reachable';
  const tip = asset ? `${label}\n${asset.originalFilename}${asset.width ? ` · ${asset.width}×${asset.height}` : ''}\n${asset.vmixPath ?? asset.storedPath ?? asset.enteredPath ?? ''}` : `${label}\nDrop a file or click`;
  return (
    <div className="group/img relative mx-auto h-8 w-11"
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <button title={tip} aria-label={asset ? `${label}: replace` : `${label}: add`} onClick={() => ref.current?.click()}
        className={cx('flex h-full w-full items-center justify-center overflow-hidden rounded border',
          asset ? 'checker border-ink-700' : 'border-dashed border-ink-700 text-ink-600 hover:border-ink-500 hover:text-ink-300',
          bad && 'border-amber-500', over && 'border-accent-400 ring-2 ring-accent-400', busy && 'opacity-40')}>
        {asset?.previewUrl ? <img src={asset.previewUrl} alt="" className="max-h-full max-w-full object-contain" /> : asset ? <span className="text-[10px] text-amber-300">?</span> : <span className="text-xs">+</span>}
      </button>
      {asset && (
        <button onClick={remove} aria-label={`${label}: remove`}
          className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-ink-700 text-[9px] text-ink-100 hover:bg-red-700 group-hover/img:flex">✕</button>
      )}
      <input ref={ref} type="file" className="hidden" accept={accept === 'png' ? 'image/png,.png' : 'image/png,image/jpeg,.png,.jpg,.jpeg'}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
    </div>
  );
}
