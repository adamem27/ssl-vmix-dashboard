import { KeyboardEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, RankingResult, Sailor, Team } from '../api';
import { useMeta } from '../App';
import { AssetSlot, BgToggle, PreviewBg } from '../components/AssetSlot';
import { TeamFormModal } from '../components/TeamForm';
import { SailorFormModal } from '../components/SailorForm';
import { Badge, Button, cx, Empty, ErrorBox, fmtDateTime, Loading, useConfirm, useToast } from '../components/ui';

export function usePreviewBg(): [PreviewBg, (v: PreviewBg) => void] {
  const [bg, setBg] = useState<PreviewBg>(() => {
    try { return (localStorage.getItem('previewBg') as PreviewBg) || 'checker'; } catch { return 'checker'; }
  });
  return [bg, (v) => { setBg(v); try { localStorage.setItem('previewBg', v); } catch { /* ignore */ } }];
}

export function TeamDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const meta = useMeta();
  const { ask, dialog } = useConfirm();
  const team = useQuery({ queryKey: ['team', id], queryFn: () => api.get<Team>(`/api/teams/${id}`) });
  const sailors = useQuery({ queryKey: ['sailors', id], queryFn: () => api.get<Sailor[]>(`/api/teams/${id}/sailors`) });
  const [bg, setBg] = usePreviewBg();
  const [editing, setEditing] = useState(false);
  const [sailorModal, setSailorModal] = useState<{ open: boolean; sailor?: Sailor | null }>({ open: false });

  if (team.isLoading) return <Loading />;
  if (team.error) return <ErrorBox error={team.error} onRetry={() => team.refetch()} />;
  const t = team.data!;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['team', id] }); qc.invalidateQueries({ queryKey: ['teams'] }); };

  const del = async () => {
    if (!(await ask('Delete team?', <>Team <b>{t.name}</b> will be deleted together with {t.sailorCount} sailors, assigned graphics, declarations and group places. This cannot be undone (except by restoring a backup).</>, 'Delete team'))) return;
    try { await api.del(`/api/teams/${t.id}`); toast.ok(`Team ${t.name} deleted`); qc.invalidateQueries(); nav('/vmix/teams'); } catch (e) { toast.error(e); }
  };

  return (
    <div className="space-y-6">
      <div>
        <Link to="/vmix/overview" className="text-xs text-ink-400 hover:text-ink-100">← Teams & crews</Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{t.name}</h1>
          <span className="rounded bg-ink-800 px-2 py-0.5 font-mono text-sm text-ink-200">{t.code}</span>
          {t.isDemo && <Badge tone="demo">Demo</Badge>}
          <Badge tone={t.assetsFilled === t.assetsTotal ? 'ok' : 'warn'}>Assets {t.assetsFilled}/{t.assetsTotal}</Badge>
          <div className="ml-auto flex gap-2">
            <Button onClick={() => setEditing(true)}>Edit details</Button>
            <Button variant="danger" onClick={del}>Delete</Button>
          </div>
        </div>
        <p className="mt-1 text-sm text-ink-400">
          Aliases: {t.aliases.length ? t.aliases.map((a) => <span key={a} className="mr-1 rounded bg-ink-850 px-1.5 py-0.5 text-ink-300">{a}</span>) : <span className="text-ink-500">none</span>}
          {t.notes && <span className="ml-3 text-ink-500">· {t.notes}</span>}
        </p>
      </div>

      <RankingBox team={t} onChanged={refresh} />

      <section aria-labelledby="assets-h">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 id="assets-h" className="text-lg font-semibold">Graphic assets</h2>
          <div className="ml-auto"><BgToggle value={bg} onChange={setBg} /></div>
        </div>
        <p className="mb-2 text-xs text-ink-500">Sponsor logos 1–5 (PNG or JPG) are standardised on upload: trimmed, evened out to the same visible size and centred on an 800×400 transparent PNG. A plain JPG background is removed.</p>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          {(meta.data?.teamSlots ?? []).map((s) => (
            <AssetSlot key={s.key} ownerKind="teams" ownerId={t.id} slot={s} asset={t.assets[s.key]} bg={bg} onChanged={refresh}
              {...(s.key.startsWith('sponsor_') ? { accept: 'png+jpg' as const, aspect: 'aspect-[2/1]' } : {})} />
          ))}
        </div>
      </section>

      <section aria-labelledby="sailors-h">
        <div className="mb-3 flex items-center gap-3">
          <h2 id="sailors-h" className="text-lg font-semibold">Sailors</h2>
          <span className="text-xs text-ink-500">{sailors.data?.length ?? 0} in database</span>
          <Button className="ml-auto" variant="primary" onClick={() => setSailorModal({ open: true, sailor: null })}>+ Add sailor</Button>
        </div>
        {sailors.isLoading ? <Loading /> : sailors.error ? <ErrorBox error={sailors.error} /> : !sailors.data!.length ? (
          <Empty title="No sailors yet">Add sailors manually or create them from unmatched declaration entries.</Empty>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
            {sailors.data!.map((s) => (
              <li key={s.id} className="card group overflow-hidden">
                <button className="block w-full text-left" onClick={() => setSailorModal({ open: true, sailor: s })} aria-label={`Edit ${s.firstName} ${s.lastName}`}>
                  <div className="relative aspect-[4/5] bg-ink-950">
                    {s.photo?.previewUrl ? <img src={s.photo.previewUrl} alt="" className="h-full w-full object-cover" />
                      : <div className="flex h-full items-center justify-center text-xs text-ink-500">{s.photo ? 'Preview unavailable' : 'No photo'}</div>}
                    {s.defaultNumber && <span className="absolute left-2 top-2 rounded bg-black/70 px-2 py-0.5 text-lg font-bold tabular-nums text-white">{s.defaultNumber}</span>}
                    {s.isDemo && <span className="absolute right-2 top-2"><Badge tone="demo">Demo</Badge></span>}
                  </div>
                  <div className="p-2.5">
                    <p className="truncate text-sm text-ink-300">{s.firstName}</p>
                    <p className="truncate font-semibold uppercase text-ink-50">{s.lastName || '—'}</p>
                    <p className="truncate text-xs text-ink-400">{s.defaultPosition || <span className="text-amber-400">no position</span>}</p>
                  </div>
                </button>
                <div className="border-t border-ink-800 px-2.5 py-1.5 text-right">
                  <Link to={`/vmix/sailors/${s.id}`} className="text-xs text-accent-300 hover:underline">Profile & history →</Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <TeamFormModal open={editing} onClose={() => setEditing(false)} team={t} onSaved={refresh} />
      <SailorFormModal open={sailorModal.open} onClose={() => setSailorModal({ open: false })} teamId={t.id} sailor={sailorModal.sailor} />
      {dialog}
    </div>
  );
}

/** World of Sailors nation ranking: the fetched position, editable by the operator (empty or the fetched value = automatic). */
export function RankingBox({ team, onChanged }: { team: Team; onChanged: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const meta = useMeta();
  const [v, setV] = useState(team.ranking);
  const [busy, setBusy] = useState(false);
  useEffect(() => setV(team.ranking), [team.ranking]);
  const save = async (value: string) => {
    try { await api.patch<Team>(`/api/teams/${team.id}`, { ranking: value }); onChanged(); qc.invalidateQueries({ queryKey: ['overview'] }); toast.ok(value && value !== team.rankingSource ? 'Ranking set by hand' : 'Ranking follows the ranking page'); }
    catch (e) { toast.error(e); setV(team.ranking); }
  };
  const refreshAll = async () => {
    setBusy(true);
    try {
      const r = await api.post<RankingResult>('/api/ranking/refresh');
      qc.invalidateQueries();
      toast.ok(`Ranking updated: ${r.matched} teams${r.teamsWithoutRanking.length ? ` (not in the ranking: ${r.teamsWithoutRanking.join(', ')})` : ''}`);
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    if (e.key === 'Escape') { setV(team.ranking); (e.target as HTMLInputElement).blur(); }
  };
  return (
    <section className="card flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm" aria-label="Nation ranking">
      <span className="font-semibold">Nation ranking</span>
      <label className="flex items-center gap-1">
        <span className="text-ink-400">Position</span>
        <input className={cx('input w-20 py-1 text-center font-bold tabular-nums', team.rankingManual && 'border-sky-700 bg-sky-950/30')} value={v} maxLength={40}
          onChange={(e) => setV(e.target.value)} onBlur={() => { if (v.trim() !== team.ranking) void save(v.trim()); }} onKeyDown={onKey} aria-label="Ranking position" />
      </label>
      {team.rankingManual && (
        <button className="rounded px-1 text-xs text-sky-300 hover:bg-ink-800" onClick={() => save('')} title="Restore the value from the ranking page">
          ↺ from page: {team.rankingSource ?? '—'}
        </button>
      )}
      {team.rankingPoints && <span className="text-ink-400">SSL points: <b className="text-ink-200">{team.rankingPoints}</b></span>}
      <span className="text-xs text-ink-500">
        {team.rankingFetchedAt ? <>From worldofsailors.com · {fmtDateTime(team.rankingFetchedAt, meta.data?.event.timezone)}</> : 'Not found in the ranking (enter it by hand or add the ranking name as an alias)'}
      </span>
      <Button size="sm" className="ml-auto" busy={busy} onClick={refreshAll}>Update ranking now</Button>
    </section>
  );
}
