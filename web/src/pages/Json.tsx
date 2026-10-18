import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Button, cx, ErrorBox, Loading, useToast } from '../components/ui';

type Row = Record<string, unknown>;

export function JsonPage() {
  const toast = useToast();
  const idx = useQuery({ queryKey: ['json-index'], queryFn: () => api.get<{ name: string; path: string }[]>('/api/json-index') });
  const [path, setPath] = useState<string | null>(null);
  const current = path ?? idx.data?.[0]?.path ?? null;
  const data = useQuery({ queryKey: ['json', current], queryFn: () => api.get<Row[]>(current!), enabled: !!current, refetchInterval: 5000 });
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const url = current ? window.location.origin + current : '';
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast.info('Copied'), () => {});

  const rows = data.data ?? [];
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const selField = sel ? cols[sel.c - 1] : null;
  const selValue = sel && selField ? String(rows[sel.r - 1]?.[selField] ?? '') : '';

  return (
    <div className="flex flex-col gap-3 lg:flex-row">
      <aside className="card h-fit shrink-0 p-1 lg:w-64">
        {idx.isLoading ? <Loading /> : (idx.data ?? []).map((j) => (
          <button key={j.path} onClick={() => { setPath(j.path); setSel(null); }}
            className={cx('block w-full truncate rounded px-3 py-1.5 text-left text-sm', j.path === current ? 'bg-ink-800 text-ink-50' : 'text-ink-300 hover:bg-ink-850')}>{j.name}</button>
        ))}
      </aside>
      <section className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-ink-900 px-2 py-1.5 text-xs text-ink-200">{url}</code>
          <Button size="sm" onClick={() => copy(url)}>Copy URL</Button>
          <a href={current ?? '#'} target="_blank" rel="noreferrer"><Button size="sm" variant="ghost">Raw</Button></a>
          <span className="ml-auto text-xs tabular-nums text-ink-400">{rows.length} rows · {cols.length} columns</span>
        </div>
        <div className="flex min-h-[34px] items-center gap-3 rounded border border-ink-800 bg-ink-900 px-3 py-1 text-sm">
          {sel && selField ? (
            <>
              <span className="font-mono text-accent-300">R{sel.r} · C{sel.c}</span>
              <span className="font-mono text-ink-300">{selField}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-ink-50" title={selValue}>{selValue || '—'}</span>
              <Button size="sm" variant="ghost" onClick={() => copy(selField)}>Copy field</Button>
              <Button size="sm" variant="ghost" onClick={() => copy(selValue)}>Copy value</Button>
            </>
          ) : <span className="text-ink-500">—</span>}
        </div>
        {data.error ? <ErrorBox error={data.error} /> : data.isLoading ? <Loading /> : (
          <div className="card max-h-[calc(100vh-220px)] overflow-auto">
            <table className="border-collapse font-mono text-xs">
              <thead className="sticky top-0 z-10">
                <tr className="bg-ink-850 text-ink-400">
                  <th className="sticky left-0 z-20 w-10 border border-ink-800 bg-ink-850 px-2 py-1" />
                  {cols.map((c, i) => <th key={c} className={cx('border border-ink-800 px-2 py-1 text-center font-semibold', sel?.c === i + 1 && 'bg-accent-500/30 text-ink-50')}>{i + 1}</th>)}
                </tr>
                <tr className="bg-ink-900 text-ink-200">
                  <th className="sticky left-0 z-20 border border-ink-800 bg-ink-900 px-2 py-1" />
                  {cols.map((c) => <th key={c} className="whitespace-nowrap border border-ink-800 px-2 py-1 text-left font-medium">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri}>
                    <th className={cx('sticky left-0 border border-ink-800 bg-ink-850 px-2 py-1 text-right font-semibold text-ink-400', sel?.r === ri + 1 && 'bg-accent-500/30 text-ink-50')}>{ri + 1}</th>
                    {cols.map((c, ci) => {
                      const v = String(r[c] ?? '');
                      const on = sel?.r === ri + 1 && sel?.c === ci + 1;
                      return (
                        <td key={c} onClick={() => setSel({ r: ri + 1, c: ci + 1 })} title={v}
                          className={cx('max-w-[260px] cursor-cell truncate whitespace-nowrap border border-ink-800 px-2 py-1 text-ink-200', on ? 'bg-accent-500/25 outline outline-2 -outline-offset-2 outline-accent-400' : 'hover:bg-ink-850')}>
                          {v}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <p className="p-6 text-center text-sm text-ink-500">Empty</p>}
          </div>
        )}
      </section>
    </div>
  );
}
