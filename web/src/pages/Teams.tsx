import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Team } from '../api';
import { Badge, Button, cx, Empty, ErrorBox, Loading } from '../components/ui';
import { TeamFormModal } from '../components/TeamForm';

type Filter = 'all' | 'missing' | 'complete';

export function TeamsPage() {
  const q = useQuery({ queryKey: ['teams'], queryFn: () => api.get<Team[]>('/api/teams') });
  const qc = useQueryClient();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const search = params.get('q') ?? '';
  const filter = (params.get('f') as Filter) ?? 'all';
  const [adding, setAdding] = useState(false);
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); v ? p.set(k, v) : p.delete(k); setParams(p, { replace: true }); };

  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? []).filter((t) => {
      if (s && !t.name.toLowerCase().includes(s) && !t.code.toLowerCase().includes(s) && !t.aliases.some((a) => a.toLowerCase().includes(s))) return false;
      if (filter === 'missing') return t.assetsFilled < t.assetsTotal;
      if (filter === 'complete') return t.assetsFilled === t.assetsTotal;
      return true;
    });
  }, [q.data, search, filter]);
  const missingCount = (q.data ?? []).filter((t) => t.assetsFilled < t.assetsTotal).length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-bold">Teams</h1>
          <p className="text-sm text-ink-400">{q.data ? `${q.data.length} teams · ${missingCount} with missing assets` : ' '}</p>
        </div>
        <input className="input w-64" type="search" placeholder="Search by name or code…" value={search} onChange={(e) => set('q', e.target.value)} aria-label="Search teams" />
        <div role="radiogroup" aria-label="Completeness filter" className="inline-flex rounded-md border border-ink-700 bg-ink-900 p-0.5">
          {([['all', 'All'], ['missing', 'Missing assets'], ['complete', 'Complete']] as [Filter, string][]).map(([v, l]) => (
            <button key={v} role="radio" aria-checked={filter === v} onClick={() => set('f', v === 'all' ? '' : v)}
              className={cx('rounded px-3 py-1.5 text-xs font-medium', filter === v ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-100')}>{l}</button>
          ))}
        </div>
        <Button variant="primary" onClick={() => setAdding(true)}>+ Add team</Button>
      </div>

      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : !q.data!.length ? (
        <Empty title="No teams yet" action={<div className="flex gap-2"><Button variant="primary" onClick={() => setAdding(true)}>Add the first team</Button><Link to="/vmix/settings#demo"><Button>Demo data</Button></Link></div>}>
          Add teams manually or load the labelled demo dataset in Settings.
        </Empty>
      ) : !list.length ? (
        <Empty title="No results">No team matches the search or filter.</Empty>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {list.map((t) => <TeamCard key={t.id} t={t} />)}
        </ul>
      )}

      <TeamFormModal open={adding} onClose={() => setAdding(false)} onSaved={(t) => { qc.invalidateQueries({ queryKey: ['teams'] }); nav(`/vmix/teams/${t.id}`); }} />
    </div>
  );
}

function TeamCard({ t }: { t: Team }) {
  const pct = Math.round((t.assetsFilled / t.assetsTotal) * 100);
  const complete = t.assetsFilled === t.assetsTotal;
  return (
    <li>
      <Link to={`/vmix/teams/${t.id}`} className="card group block overflow-hidden transition-colors hover:border-ink-600">
        <div className="checker flex aspect-[16/9] items-center justify-center">
          {t.thumb?.previewUrl ? <img src={t.thumb.previewUrl} alt="" className="max-h-[80%] max-w-[80%] object-contain" />
            : <span className="rounded bg-ink-950/80 px-2 py-1 text-xs text-ink-300">{t.thumb ? 'Preview unavailable' : 'No flag or emblem'}</span>}
        </div>
        <div className="space-y-2 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-semibold text-ink-50 group-hover:text-accent-300">{t.name}</p>
              <p className="font-mono text-xs text-ink-400">{t.code}</p>
            </div>
            {t.isDemo && <Badge tone="demo">Demo</Badge>}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-ink-800" aria-hidden>
              <div className={cx('h-full', complete ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-500' : 'bg-red-500')} style={{ width: `${pct}%` }} />
            </div>
            <span className={cx('tabular-nums font-semibold', complete ? 'text-emerald-300' : 'text-amber-300')} title="Filled graphic slots">{t.assetsFilled}/{t.assetsTotal}</span>
          </div>
          <p className="text-xs text-ink-500">{t.sailorCount} sailors</p>
        </div>
      </Link>
    </li>
  );
}
