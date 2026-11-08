import { KeyboardEvent, useEffect, useRef, useState } from 'react';
import { cx } from './ui';

/** A text input that keeps what you type and saves on blur or Enter (Esc undoes). */
export function SaveInput({ value, onSave, className, placeholder, label, list, maxLength = 500, inputMode }: {
  value: string; onSave: (v: string) => void | Promise<void>; className?: string; placeholder?: string; label: string; list?: string; maxLength?: number; inputMode?: 'numeric' | 'text';
}) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setV(value); }, [value]);
  const commit = () => { if (v !== value) void onSave(v); };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
    if (e.key === 'Escape') { setV(value); setTimeout(() => (e.target as HTMLInputElement).blur()); }
  };
  return (
    <input className={cx('input py-1 text-sm', className)} value={v} placeholder={placeholder} aria-label={label} title={label} list={list} maxLength={maxLength} inputMode={inputMode}
      onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; commit(); }} onChange={(e) => setV(e.target.value)} onKeyDown={key} />
  );
}

/** Multi-line version of SaveInput (saves on blur). */
export function SaveTextArea({ value, onSave, className, placeholder, label, rows = 4 }: { value: string; onSave: (v: string) => void | Promise<void>; className?: string; placeholder?: string; label: string; rows?: number }) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setV(value); }, [value]);
  return (
    <textarea className={cx('input py-1 text-sm', className)} rows={rows} value={v} placeholder={placeholder} aria-label={label}
      onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; if (v !== value) void onSave(v); }} onChange={(e) => setV(e.target.value)} />
  );
}
