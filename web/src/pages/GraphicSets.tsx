import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Button, cx, ErrorBox, Loading, useConfirm, useToast } from '../components/ui';
import { SaveInput, SaveTextArea } from '../components/fields';

interface GField { key: string; label: string; type?: 'text' | 'select' | 'list'; options?: string[]; placeholder?: string; default?: string; wide?: boolean; hint?: string }
interface GKind { kind: string; label: string; sheet: string; description: string; fields: GField[] }
interface GSet { id: string; kind: string; name: string; data: Record<string, string>; sort: number; updatedAt: string }

export const useGraphicSets = () => useQuery({ queryKey: ['graphic-sets'], queryFn: () => api.get<{ kinds: GKind[]; sets: GSet[] }>('/api/graphic-sets') });

/** Ticker text as it goes to vMix: messages joined by the separator, which also closes the loop. */
const tickerText = (d: Record<string, string>) => {
  const items = (d.items ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const sep = d.separator || ' I ';
  return items.length ? items.join(sep) + sep : '';
};

/** One panel per graphic (Welcome, Follow us, Tickers, …); each version is a card and a row in its sheet. */
export function GraphicSetsSections() {
  const q = useGraphicSets();
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  return <>{q.data!.kinds.map((k) => <KindPanel key={k.kind} k={k} sets={q.data!.sets.filter((s) => s.kind === k.kind)} />)}</>;
}

function KindPanel({ k, sets }: { k: GKind; sets: GSet[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const refresh = () => qc.invalidateQueries({ queryKey: ['graphic-sets'] });
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); await refresh(); } catch (e) { toast.error(e); } };
  const add = () => run(() => api.post('/api/graphic-sets', { kind: k.kind, name: `${k.label === 'Tickers' ? 'Ticker' : k.label} ${sets.length + 1}` }));
  const dup = (s: GSet) => run(() => api.post('/api/graphic-sets', { kind: k.kind, name: `${s.name} copy`, copyFrom: s.id }));
  const move = (s: GSet, dir: -1 | 1) => run(() => api.post(`/api/graphic-sets/${s.id}/move`, { dir }));
  const remove = async (s: GSet) => { if (await ask(`Delete “${s.name}”?`, <>This version of {k.label} and its row in the “{k.sheet}” sheet are removed.</>, 'Delete')) await run(() => api.del(`/api/graphic-sets/${s.id}`)); };
  const save = async (s: GSet, patch: { name?: string; data?: Record<string, string> }) => {
    try {
      const r = await api.patch<GSet>(`/api/graphic-sets/${s.id}`, patch);
      qc.setQueryData(['graphic-sets'], (d: { kinds: GKind[]; sets: GSet[] } | undefined) => d && { ...d, sets: d.sets.map((x) => (x.id === r.id ? r : x)) });
    } catch (e) { toast.error(e); }
  };

  return (
    <section id={`g-${k.kind}`} className="card scroll-mt-28">
      <header className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-3 py-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink-200">{k.label}</h2>
        <span className="text-xs text-ink-500">{k.description} Sheet “{k.sheet}”, one row per version.</span>
        <Button size="sm" className="ml-auto" onClick={add}>+ New version</Button>
      </header>
      <div className="grid gap-3 p-3 md:grid-cols-2 2xl:grid-cols-3">
        {sets.map((s, i) => (
          <div key={s.id} className="rounded-lg border border-ink-800 bg-ink-950/40">
            <div className="flex items-center gap-1 border-b border-ink-800 px-2 py-1.5">
              <span className="w-5 text-center text-[11px] font-semibold tabular-nums text-ink-500" title="Row in the sheet">{i + 1}</span>
              <SaveInput value={s.name} onSave={(name) => save(s, { name })} label="Version name" className="max-w-[16rem] border-transparent bg-transparent font-semibold" maxLength={80} />
              <div className="ml-auto flex items-center">
                <button disabled={i === 0} onClick={() => move(s, -1)} className="h-7 w-6 text-xs text-ink-500 hover:text-ink-100 disabled:opacity-20" aria-label="Move up">▲</button>
                <button disabled={i === sets.length - 1} onClick={() => move(s, 1)} className="h-7 w-6 text-xs text-ink-500 hover:text-ink-100 disabled:opacity-20" aria-label="Move down">▼</button>
                <button onClick={() => dup(s)} className="h-7 rounded px-2 text-xs text-ink-400 hover:bg-ink-800 hover:text-ink-100" title="Duplicate this version">Duplicate</button>
                <button onClick={() => remove(s)} className="h-7 w-7 rounded text-ink-500 hover:bg-ink-800 hover:text-red-300" aria-label={`Delete ${s.name}`}>✕</button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 p-2">
              {k.fields.map((f) => (
                <label key={f.key} className={cx('block min-w-0', (f.wide || f.type === 'list') && 'col-span-2')}>
                  <span className="flex items-baseline gap-2 px-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-500">
                    {f.label}<span className="font-mono normal-case tracking-normal text-ink-600">{f.key}</span>{f.hint && <span className="normal-case tracking-normal text-ink-500">· {f.hint}</span>}
                  </span>
                  {f.type === 'select' ? (
                    <select className="input py-1 text-sm" value={s.data[f.key] ?? ''} onChange={(e) => save(s, { data: { [f.key]: e.target.value } })} aria-label={f.label}>
                      {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : f.type === 'list' ? (
                    <SaveTextArea value={s.data[f.key] ?? ''} onSave={(v) => save(s, { data: { [f.key]: v } })} label={f.label} rows={4} placeholder="One message per line" />
                  ) : (
                    <SaveInput value={s.data[f.key] ?? ''} onSave={(v) => save(s, { data: { [f.key]: v } })} label={f.label} placeholder={f.placeholder ?? f.default} />
                  )}
                </label>
              ))}
              {k.kind === 'ticker' && (
                <div className="col-span-2 min-w-0">
                  <span className="px-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-500">Ticker text <span className="font-mono normal-case tracking-normal text-ink-600">text</span></span>
                  <div className="truncate rounded border border-ink-800 bg-ink-900 px-2 py-1 font-mono text-xs text-ink-300" title={tickerText(s.data)}>{tickerText(s.data) || '—'}</div>
                </div>
              )}
            </div>
          </div>
        ))}
        {!sets.length && <p className="px-1 py-4 text-sm text-ink-500">No versions yet. Add one to fill the “{k.sheet}” sheet.</p>}
      </div>
      {dialog}
    </section>
  );
}
