import { ButtonHTMLAttributes, createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function cx(...c: (string | false | null | undefined)[]) { return c.filter(Boolean).join(' '); }

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({ variant = 'secondary', size = 'md', className, busy, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean }) {
  return (
    <button
      {...p}
      disabled={p.disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        variant === 'primary' && 'bg-accent-500 text-white hover:bg-accent-600',
        variant === 'secondary' && 'border border-ink-700 bg-ink-800 text-ink-100 hover:bg-ink-700',
        variant === 'ghost' && 'text-ink-300 hover:bg-ink-800 hover:text-ink-50',
        variant === 'danger' && 'border border-red-900/70 bg-red-950/40 text-red-300 hover:bg-red-900/50',
        className,
      )}
    >
      {busy && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return <span role="status" aria-label="Loading" className={cx('inline-block animate-spin rounded-full border-2 border-current border-r-transparent', className)} />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="flex items-center gap-3 p-8 text-ink-400"><Spinner /> {label}</div>;
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="flex items-start justify-between gap-4 rounded-lg border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-200">
      <span>{msg}</span>
      {onRetry && <Button size="sm" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-ink-700 px-6 py-14 text-center">
      <p className="text-base font-semibold text-ink-100">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-ink-400">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

type Tone = 'neutral' | 'ok' | 'warn' | 'error' | 'info' | 'demo';
export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx(
      'inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
      tone === 'neutral' && 'bg-ink-800 text-ink-300',
      tone === 'ok' && 'bg-emerald-950/70 text-emerald-300',
      tone === 'warn' && 'bg-amber-950/70 text-amber-300',
      tone === 'error' && 'bg-red-950/70 text-red-300',
      tone === 'info' && 'bg-sky-950/70 text-sky-300',
      tone === 'demo' && 'border border-fuchsia-700/60 bg-fuchsia-950/60 text-fuchsia-300',
    )}>{children}</span>
  );
}

export function Field({ label, children, hint, className }: { label: string; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-500">{hint}</span>}
    </label>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    setTimeout(() => ref.current?.querySelector<HTMLElement>('input,select,textarea,button[data-autofocus]')?.focus(), 0);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  // Portal to <body>: a parent with backdrop-filter/transform (e.g. the sticky header) would otherwise
  // become the containing block for `fixed`, pushing the dialog off screen.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={cx('card flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden shadow-2xl', wide ? 'max-w-4xl' : 'max-w-lg')}>
        <div className="flex shrink-0 items-center justify-between border-b border-ink-800 px-5 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100" aria-label="Close">✕</button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-5">{children}</div>
        {footer && <div className="flex shrink-0 justify-end gap-2 border-t border-ink-800 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------- toasts ----------
interface ToastItem { id: number; tone: 'ok' | 'error' | 'info'; text: string }
const ToastCtx = createContext<{ push: (tone: ToastItem['tone'], text: string) => void }>({ push: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((tone: ToastItem['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-4), { id, tone, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === 'error' ? 8000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className={cx(
            'pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-xl',
            t.tone === 'ok' && 'border-emerald-800 bg-emerald-950 text-emerald-100',
            t.tone === 'error' && 'border-red-800 bg-red-950 text-red-100',
            t.tone === 'info' && 'border-ink-700 bg-ink-850 text-ink-100',
          )}>
            {t.tone === 'ok' ? '✓ ' : t.tone === 'error' ? '⚠ ' : ''}{t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const { push } = useContext(ToastCtx);
  return {
    ok: (t: string) => push('ok', t),
    error: (e: unknown) => push('error', e instanceof Error ? e.message : String(e)),
    info: (t: string) => push('info', t),
  };
}

// ---------- confirm ----------
export function useConfirm() {
  const [state, setState] = useState<null | { title: string; body: ReactNode; confirm: string; danger?: boolean; resolve: (v: boolean) => void }>(null);
  const ask = (title: string, body: ReactNode, confirm = 'Confirm', danger = true) =>
    new Promise<boolean>((resolve) => setState({ title, body, confirm, danger, resolve }));
  const close = (v: boolean) => { state?.resolve(v); setState(null); };
  const dialog = (
    <Modal open={!!state} onClose={() => close(false)} title={state?.title ?? ''}
      footer={<>
        <Button onClick={() => close(false)}>Cancel</Button>
        <Button data-autofocus variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{state?.confirm}</Button>
      </>}>
      <div className="text-sm text-ink-300">{state?.body}</div>
    </Modal>
  );
  return { ask, dialog };
}

// ---------- formatting ----------
export function fmtDateTime(iso: string | null | undefined, tz?: string) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'medium', timeZone: tz }).format(new Date(iso));
  } catch { return iso; }
}
export function fmtDate(isoDate: string) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(y, m - 1, d));
}
export function fmtBytes(n: number | null) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
/** The day picked at the top of the dashboard ('' = the real today): every tab's "today" follows it. */
let dayOverride = '';
export function setDayOverride(day: string) { dayOverride = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : ''; }
export function todayIn(tz: string) {
  if (dayOverride) return dayOverride;
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}
