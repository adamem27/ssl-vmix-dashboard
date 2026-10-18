import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Button, cx, ErrorBox, Loading, useToast } from '../components/ui';

type Row = Record<string, unknown>;
interface Workbook { file: string | null; vmixPath: string | null; updatedAt: string | null; error: string | null; sheets: { name: string; path: string; rows: number }[] }

export function JsonPage() {
  const toast = useToast();
  const wb = useQuery({ queryKey: ['workbook'], queryFn: () => api.get<Workbook>('/api/workbook'), refetchInterval: 5000 });
  const all = useQuery({ queryKey: ['json-all'], queryFn: () => api.get<Record<string, Row[]>>('/json/all'), refetchInterval: 5000 });
  const [sheet, setSheet] = useState<string | null>(null);
  const sheets = wb.data?.sheets ?? [];
  const current = sheets.find((s) => s.name === sheet) ?? sheets[0];
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const origin = window.location.origin;
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast.info('Copied'), () => {});
  const data = { data: current ? all.data?.[current.name] : undefined, error: all.error ?? wb.error, isLoading: all.isLoading || wb.isLoading };

  const rows = data.data ?? [];
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const selField = sel ? cols[sel.c - 1] : null;
  const selValue = sel && selField ? String(rows[sel.r - 1]?.[selField] ?? '') : '';
  const filePath = wb.data?.vmixPath ?? wb.data?.file ?? '';
  const xpath = `//sheet[@name='${current?.name ?? ''}']/row`;

  return (
    <div className="space-y-2">
      <div className="card grid gap-x-4 gap-y-1.5 px-3 py-2 text-xs md:grid-cols-[auto_1fr_auto]">
        <span className="self-center font-semibold uppercase tracking-wide text-ink-400">Excel</span>
        <code className="self-center truncate text-ink-100" title={filePath}>{filePath}</code>
        <span className="flex gap-1">
          <Button size="sm" onClick={() => copy(filePath)}>Copy path</Button>
          <a href="/workbook.xlsx"><Button size="sm" variant="ghost">Download</Button></a>
        </span>
        <span className="self-center font-semibold uppercase tracking-wide text-ink-400">JSON</span>
        <code className="self-center truncate text-ink-100">{origin}/json/all</code>
        <span className="flex gap-1">
          <Button size="sm" onClick={() => copy(`${origin}/json/all`)}>Copy URL</Button>
          <a href="/json/all" target="_blank" rel="noreferrer"><Button size="sm" variant="ghost">Raw</Button></a>
        </span>
        <span className="self-center font-semibold uppercase tracking-wide text-ink-400">XML</span>
        <code className="self-center truncate text-ink-100">{origin}/xml/all <span className="text-ink-400">XPath</span> {xpath}</code>
        <span className="flex gap-1">
          <Button size="sm" onClick={() => copy(`${origin}/xml/all`)}>Copy URL</Button>
          <Button size="sm" onClick={() => copy(xpath)}>Copy XPath</Button>
        </span>
        {wb.data?.error && <span className="text-amber-300 md:col-span-3">{wb.data.error}</span>}
      </div>
      <div className="flex min-h-[34px] items-center gap-3 rounded border border-ink-800 bg-ink-900 px-3 py-1 text-sm">
        {sel && selField ? (
          <>
            <span className="font-mono text-accent-300">{current?.name} · R{sel.r} · C{sel.c}</span>
            <span className="font-mono text-ink-300">{selField}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-ink-50" title={selValue}>{selValue || '—'}</span>
            <Button size="sm" variant="ghost" onClick={() => copy(selField)}>Copy field</Button>
            <Button size="sm" variant="ghost" onClick={() => copy(selValue)}>Copy value</Button>
          </>
        ) : <span className="text-ink-500">—</span>}
        {current && <span className="ml-auto shrink-0 font-mono text-xs text-ink-500" title="This sheet alone">{current.path}</span>}
      </div>
      <section className="min-w-0">
        {data.error ? <ErrorBox error={data.error} /> : data.isLoading ? <Loading /> : (
          <div className="card max-h-[calc(100vh-260px)] rounded-b-none overflow-auto">
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
      <nav className="-mt-2 flex gap-0.5 overflow-x-auto border-t border-ink-800" aria-label="Sheets">
        {sheets.map((s) => (
          <button key={s.name} onClick={() => { setSheet(s.name); setSel(null); }}
            className={cx('shrink-0 rounded-b border-x border-b px-3 py-1.5 text-xs', s.name === current?.name ? 'border-ink-700 bg-ink-800 font-semibold text-ink-50' : 'border-transparent text-ink-400 hover:bg-ink-900 hover:text-ink-100')}>
            {s.name} <span className="text-ink-500">{s.rows}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
