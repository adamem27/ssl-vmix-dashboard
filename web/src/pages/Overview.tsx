import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useMeta } from '../App';
import { api, FleetSetSummary, Overview, OverviewSailor, OverviewTeam } from '../api';
import { Badge, Button, cx, Empty, ErrorBox, fmtDate, Loading, todayIn } from '../components/ui';

const LS_KEY = 'overview.v1';
function loadPrefs(): { setId?: string; sort?: 'name' | 'fleet'; open?: string[] } {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}'); } catch { return {}; }
}
function savePrefs(p: ReturnType<typeof loadPrefs>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}
const shiftDate = (d: string, days: number) => new Date(Date.parse(d + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fullName = (s: { firstName: string; lastName: string }) => `${s.firstName} ${s.lastName}`.trim();

export function OverviewPage() {
  const meta = useMeta();
  const tz = meta.data?.event.timezone ?? 'UTC';
  const prefs = useMemo(loadPrefs, []);
  const [date, setDate] = useState<string | null>(null);
  const [setId, setSetId] = useState<string>(prefs.setId ?? '');
  const [sort, setSort] = useState<'name' | 'fleet'>(prefs.sort ?? 'name');
  const [open, setOpen] = useState<Set<string>>(new Set(prefs.open ?? []));
  const [q, setQ] = useState('');
  const day = date ?? todayIn(tz);

  const sets = useQuery({ queryKey: ['fleet-sets'], queryFn: () => api.get<FleetSetSummary[]>('/api/fleet-sets') });
  const validSet = sets.data?.some((s) => s.id === setId) ? setId : '';
  const data = useQuery({
    queryKey: ['overview', day, validSet],
    queryFn: () => api.get<Overview>(`/api/overview?date=${day}${validSet ? `&set=${validSet}` : ''}`),
    enabled: !!meta.data,
    refetchInterval: 30_000,
  });
  useEffect(() => savePrefs({ setId: validSet, sort, open: [...open] }), [validSet, sort, open]);

  const query = norm(q.trim());
  const rows = useMemo(() => {
    let list = (data.data?.teams ?? []).map((t) => {
      if (!query) return { t, hits: null as Set<string> | null };
      const teamHit = norm(`${t.code} ${t.name}`).includes(query);
      const hits = new Set(t.sailors.filter((s) => norm(fullName(s)).includes(query)).map((s) => s.id));
      return teamHit || hits.size ? { t, hits: teamHit ? null : hits } : null;
    }).filter((x): x is { t: OverviewTeam; hits: Set<string> | null } => !!x);
    if (sort === 'fleet' && validSet) {
      list = [...list].sort((a, b) => {
        const pa = a.t.place, pb = b.t.place;
        if (!pa || !pb) return pa ? -1 : pb ? 1 : a.t.name.localeCompare(b.t.name);
        return pa.fleetName.localeCompare(pb.fleetName, undefined, { numeric: true }) || pa.position - pb.position;
      });
    }
    return list;
  }, [data.data, query, sort, validSet]);

  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOpen = rows.length > 0 && rows.every((r) => open.has(r.t.id));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Overview</h1>
          <p className="text-sm text-ink-400">All teams and sailors in one table. Click a team to show its crew.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input className="input w-64" placeholder="Search team or sailor…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search team or sailor" />
          <div className="flex items-center gap-1" role="group" aria-label="Declaration day">
            <Button size="sm" variant="ghost" onClick={() => setDate(shiftDate(day, -1))} aria-label="Previous day">‹</Button>
            <input type="date" className="input w-40 py-1.5 text-sm" value={day} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Declaration day" />
            <Button size="sm" variant="ghost" onClick={() => setDate(shiftDate(day, 1))} aria-label="Next day">›</Button>
            {date && date !== todayIn(tz) && <Button size="sm" variant="ghost" onClick={() => setDate(null)}>Today</Button>}
          </div>
          <select className="input w-56 py-1.5 text-sm" value={validSet} onChange={(e) => setSetId(e.target.value)} aria-label="Fleet set">
            <option value="">No fleet set</option>
            {(sets.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select className="input w-36 py-1.5 text-sm" value={sort} onChange={(e) => setSort(e.target.value as 'name' | 'fleet')} aria-label="Sort" disabled={!validSet}>
            <option value="name">Sort by team</option>
            <option value="fleet">Sort by fleet</option>
          </select>
          <Button size="sm" onClick={() => setOpen(allOpen ? new Set() : new Set(rows.map((r) => r.t.id)))}>{allOpen ? 'Collapse all' : 'Expand all'}</Button>
        </div>
      </div>

      {data.isLoading || meta.isLoading ? <Loading /> : data.error ? <ErrorBox error={data.error} onRetry={() => data.refetch()} /> : !data.data?.teams.length ? (
        <Empty title="No teams yet" action={<Link to="/vmix/settings#presets"><Button variant="primary">Load the matchboard</Button></Link>}>
          Add teams on the Teams page or load the SSL Gold Cup 2026 matchboard in Settings.
        </Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse text-sm">
            <thead className="sticky top-0 bg-ink-900 text-left text-[11px] uppercase tracking-wide text-ink-400">
              <tr className="border-b border-ink-800">
                <th className="w-8 px-2 py-2" />
                <th className="w-14 px-2 py-2">Flag</th>
                <th className="w-16 px-2 py-2">Code</th>
                <th className="px-2 py-2">Team</th>
                {validSet && <th className="px-2 py-2">Fleet</th>}
                <th className="px-2 py-2">Graphics</th>
                <th className="px-2 py-2 text-right">Sailors</th>
                <th className="px-2 py-2">Crew · {fmtDate(day)}</th>
                <th className="w-16 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ t, hits }) => {
                const isOpen = open.has(t.id) || (hits !== null && hits.size > 0);
                return (
                  <Fragment key={t.id}>
                    <tr className={cx('cursor-pointer border-b border-ink-800/70 hover:bg-ink-850', isOpen && 'bg-ink-900')} onClick={() => toggle(t.id)}>
                      <td className="px-2 py-1.5 text-center text-ink-400">
                        <button aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} crew of ${t.name}`} onClick={(e) => { e.stopPropagation(); toggle(t.id); }}>{isOpen ? '▾' : '▸'}</button>
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="checker flex h-7 w-11 items-center justify-center overflow-hidden rounded">
                          {t.thumb?.previewUrl ? <img src={t.thumb.previewUrl} alt="" className="max-h-full max-w-full object-contain" /> : <span className="text-[10px] text-ink-500">—</span>}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 font-mono font-bold text-ink-50">{t.code}</td>
                      <td className="px-2 py-1.5 font-medium text-ink-100">{t.name} {t.isDemo && <Badge tone="demo">Demo</Badge>}</td>
                      {validSet && <td className="px-2 py-1.5 whitespace-nowrap">{t.place ? <><span className="font-semibold text-ink-100">{t.place.fleetName}</span> <span className="text-ink-400">· place {t.place.position}</span></> : <span className="text-ink-500">—</span>}</td>}
                      <td className="px-2 py-1.5"><SlotDots team={t} /></td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-ink-300">{t.sailors.length}</td>
                      <td className="px-2 py-1.5">
                        {t.declaration ? (
                          <span className="flex items-center gap-1.5">
                            <Badge tone="ok">{t.declaration.members} declared</Badge>
                            {t.declaration.unmatched.length > 0 && <Badge tone="warn">{t.declaration.unmatched.length} not in roster</Badge>}
                          </span>
                        ) : <span className="text-xs text-ink-500">No declaration</span>}
                      </td>
                      <td className="px-2 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                        <Link to={`/vmix/teams/${t.id}`} className="text-xs text-accent-300 hover:underline">Edit</Link>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-ink-800 bg-ink-950/60">
                        <td />
                        <td colSpan={validSet ? 8 : 7} className="px-2 pb-3 pt-1">
                          <CrewTable team={t} hits={hits} hasDeclaration={!!t.declaration} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {!rows.length && <p className="p-6 text-center text-sm text-ink-400">Nothing matches “{q}”.</p>}
        </div>
      )}
    </div>
  );
}

function SlotDots({ team }: { team: OverviewTeam }) {
  const color = (s: string) => s === 'stored' ? 'bg-emerald-400' : s === 'reachable' ? 'bg-sky-400' : s === 'missing' ? 'bg-ink-700' : s === 'unverified' ? 'bg-amber-400' : 'bg-red-500';
  return (
    <span className="flex items-center gap-2">
      <span className="flex gap-0.5">
        {team.slots.map((s) => <span key={s.key} title={`${s.label}: ${s.status === 'missing' ? 'missing' : s.status}`} className={cx('h-3 w-1.5 rounded-sm', color(s.status))} />)}
      </span>
      <span className={cx('text-xs tabular-nums', team.assetsFilled === team.assetsTotal ? 'text-emerald-300' : 'text-ink-400')}>{team.assetsFilled}/{team.assetsTotal}</span>
    </span>
  );
}

function CrewTable({ team, hits, hasDeclaration }: { team: OverviewTeam; hits: Set<string> | null; hasDeclaration: boolean }) {
  const sailors = [...team.sailors].sort((a, b) => {
    if (a.declared && b.declared) return a.declared.sort - b.declared.sort;
    return a.declared ? -1 : b.declared ? 1 : 0;
  });
  if (!sailors.length && !team.declaration?.unmatched.length) {
    return <p className="py-2 text-sm text-ink-500">No sailors yet. <Link to={`/vmix/teams/${team.id}`} className="text-accent-300 hover:underline">Add sailors</Link></p>;
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-[11px] uppercase tracking-wide text-ink-500">
        <tr>
          <th className="w-12 py-1.5">Photo</th>
          <th className="py-1.5">Sailor</th>
          <th className="py-1.5">Profile no.</th>
          <th className="py-1.5">Profile position</th>
          {hasDeclaration && <th className="py-1.5">Today no.</th>}
          {hasDeclaration && <th className="py-1.5">Today position</th>}
          <th className="py-1.5">Best result 1</th>
          <th className="py-1.5">Best result 2</th>
          <th className="w-12 py-1.5" />
        </tr>
      </thead>
      <tbody>
        {sailors.map((s) => <SailorRow key={s.id} s={s} hasDeclaration={hasDeclaration} highlight={!!hits?.has(s.id)} />)}
        {team.declaration?.unmatched.map((m, i) => (
          <tr key={`u${i}`} className="border-t border-ink-800/60">
            <td className="py-1.5" />
            <td className="py-1.5 text-amber-200">{m.name || '—'} <Badge tone="warn">Not in roster</Badge></td>
            <td className="py-1.5 text-ink-500">—</td>
            <td className="py-1.5 text-ink-500">—</td>
            <td className="py-1.5 tabular-nums">{m.number || '—'}</td>
            <td className="py-1.5">{m.position || '—'}</td>
            <td colSpan={2} className="py-1.5 text-xs text-ink-500">Assign in Crew declarations</td>
            <td className="py-1.5 text-right"><Link to="/vmix/declarations" className="text-xs text-accent-300 hover:underline">Open</Link></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SailorRow({ s, hasDeclaration, highlight }: { s: OverviewSailor; hasDeclaration: boolean; highlight: boolean }) {
  const dim = hasDeclaration && !s.declared;
  const diff = (a: string, b: string) => a !== '' && a !== b;
  return (
    <tr className={cx('border-t border-ink-800/60', dim && 'text-ink-500', highlight && 'bg-accent-500/10')}>
      <td className="py-1">
        <div className="h-9 w-9 overflow-hidden rounded bg-ink-800">
          {s.photo?.previewUrl ? <img src={s.photo.previewUrl} alt="" className="h-full w-full object-cover" /> : null}
        </div>
      </td>
      <td className={cx('py-1 font-medium', !dim && 'text-ink-50')}>
        {fullName(s) || '—'} {s.isDemo && <Badge tone="demo">Demo</Badge>}
        {dim && <span className="ml-2 text-xs">not declared</span>}
      </td>
      <td className="py-1 tabular-nums">{s.defaultNumber || '—'}</td>
      <td className="py-1">{s.defaultPosition || '—'}</td>
      {hasDeclaration && <td className={cx('py-1 tabular-nums', s.declared && diff(s.declared.number, s.defaultNumber) && 'font-semibold text-amber-200')}>{s.declared?.number || '—'}</td>}
      {hasDeclaration && (
        <td className={cx('py-1', s.declared && diff(s.declared.position, s.defaultPosition) && 'font-semibold text-amber-200')}>
          {s.declared?.position || '—'} {s.declared?.manual && <Badge tone="info">Manual</Badge>}
        </td>
      )}
      <td className="py-1 text-ink-300">{s.bestResult1 || '—'}</td>
      <td className="py-1 text-ink-300">{s.bestResult2 || '—'}</td>
      <td className="py-1 text-right"><Link to={`/vmix/sailors/${s.id}`} className="text-xs text-accent-300 hover:underline">Edit</Link></td>
    </tr>
  );
}
