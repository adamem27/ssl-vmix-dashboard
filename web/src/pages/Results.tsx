import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, FleetSetSummary, Team } from '../api';
import { Button, cx, Empty, ErrorBox, fmtDateTime, Loading, useConfirm, useToast } from '../components/ui';
import { SaveInput } from '../components/fields';
import { TeamProfileLink } from '../components/TeamProfileLink';
import { useStage } from '../components/StagePicker';

interface RRow { teamId: string; races: string[]; points: string; autoPoints: string; total: string }
interface Group { fleetId: string; fleetName: string; setId: string; setName: string; title: string; subtitle: string; races: number; rows: RRow[]; updatedAt: string | null }
const MAX_RACES = 12;

/** Overall results of every group (fleet) of a fleet set, for the results table graphic. */
export function ResultsPage() {
  const [params, setParams] = useSearchParams();
  const sets = useQuery({ queryKey: ['fleet-sets'], queryFn: () => api.get<FleetSetSummary[]>('/api/fleet-sets') });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api.get<Team[]>('/api/teams') });
  const stage = useStage();
  const setId = params.get('set') ?? stage.data?.current?.id ?? sets.data?.[0]?.id ?? null;
  const groups = useQuery({ queryKey: ['results', setId], queryFn: () => api.get<Group[]>(`/api/results/set/${setId}`), enabled: !!setId });

  if (sets.isLoading) return <Loading />;
  if (sets.error) return <ErrorBox error={sets.error} onRetry={() => sets.refetch()} />;
  const teamById = new Map((teams.data ?? []).map((t) => [t.id, t]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-bold">Results</h1>
          <p className="text-sm text-ink-400">Overall results of each group. Rows are the standing (top = 1st). Points add up the race scores unless you type them. Sheet “Results” lists the groups of the stage chosen at the top, one row per team.</p>
        </div>
      </div>
      {!sets.data?.length ? (
        <Empty title="No groups yet" action={<Link to="/vmix/fleets" className="text-accent-300 hover:underline">Create fleets</Link>}>Results follow the fleets: every fleet of a fleet set is a group here.</Empty>
      ) : (
        <>
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Fleet set">
            {sets.data.map((s) => (
              <button key={s.id} role="tab" aria-selected={s.id === setId} onClick={() => setParams({ set: s.id }, { replace: true })}
                className={cx('rounded-md border px-3 py-1.5 text-sm', s.id === setId ? 'border-accent-500 bg-accent-500/15 text-accent-300' : 'border-ink-700 text-ink-300 hover:bg-ink-800')}>{s.name}</button>
            ))}
          </div>
          {groups.isLoading ? <Loading /> : groups.error ? <ErrorBox error={groups.error} onRetry={() => groups.refetch()} /> : (
            <div className="grid gap-4 2xl:grid-cols-2">
              {groups.data!.map((g) => <GroupCard key={g.fleetId} g={g} teamById={teamById} />)}
              {!groups.data!.length && <Empty title="This fleet set has no fleets" />}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GroupCard({ g, teamById }: { g: Group; teamById: Map<string, Team> }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const done = (r: Group) => qc.setQueryData(['results', g.setId], (list: Group[] | undefined) => list?.map((x) => (x.fleetId === r.fleetId ? r : x)));
  const put = async (body: object) => { try { done(await api.put<Group>(`/api/results/${g.fleetId}`, body)); } catch (e) { toast.error(e); } };
  const sort = async () => { try { done(await api.post<Group>(`/api/results/${g.fleetId}/sort`)); } catch (e) { toast.error(e); } };
  const clear = async () => { if (await ask(`Clear ${g.fleetName}?`, 'Race scores, points and the order go back to empty.', 'Clear')) { try { done(await api.del<Group>(`/api/results/${g.fleetId}`)); } catch (e) { toast.error(e); } } };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= g.rows.length || from === to) return;
    const ids = g.rows.map((r) => r.teamId);
    const [x] = ids.splice(from, 1); ids.splice(to, 0, x);
    void put({ order: ids });
  };
  const setRace = (r: RRow, i: number, v: string) => { const races = [...r.races]; races[i] = v.trim(); void put({ rows: [{ teamId: r.teamId, races }] }); };

  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-end gap-2 border-b border-ink-800 px-3 py-2">
        <label className="min-w-0 flex-1"><span className="label">{g.fleetName} · Title</span>
          <SaveInput value={g.title} onSave={(title) => put({ title })} label="Title" maxLength={120} className="font-semibold" /></label>
        <label className="w-44"><span className="label">Subtitle</span>
          <SaveInput value={g.subtitle} onSave={(subtitle) => put({ subtitle })} label="Subtitle" placeholder="RIO DE JANEIRO, BRAZIL" maxLength={120} /></label>
        <div className="flex items-center gap-1" aria-label="Races">
          <span className="text-xs text-ink-400">Races</span>
          <Button size="sm" variant="ghost" disabled={g.races <= 1} onClick={() => put({ races: g.races - 1 })} aria-label="One race less">−</Button>
          <span className="w-5 text-center text-sm tabular-nums">{g.races}</span>
          <Button size="sm" variant="ghost" disabled={g.races >= MAX_RACES} onClick={() => put({ races: g.races + 1 })} aria-label="One race more">+</Button>
        </div>
        <Button size="sm" onClick={sort} title="Order the teams by points, highest first">Sort by points</Button>
        <Button size="sm" variant="ghost" onClick={clear}>Clear</Button>
      </header>
      {!g.rows.length ? <p className="px-4 py-6 text-sm text-ink-500">No teams in this fleet yet. Put teams in it on the Fleets page.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wide text-ink-500">
              <tr>
                <th className="w-8 px-1 py-1 text-center">#</th><th className="w-6" /><th className="px-1 py-1 text-left">Team</th>
                {Array.from({ length: g.races }, (_, i) => <th key={i} className="w-11 px-0.5 py-1 text-center">R{i + 1}</th>)}
                <th className="w-16 px-1 py-1 text-center">Points</th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r, i) => {
                const t = teamById.get(r.teamId);
                const flag = t?.assets.flag_small?.previewUrl;
                return (
                  <tr key={r.teamId} draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.teamId); setDrag(i); }} onDragEnd={() => { setDrag(null); setOver(null); }}
                    onDragOver={(e) => { if (drag !== null) { e.preventDefault(); setOver(i); } }} onDragLeave={() => setOver(null)} onDrop={(e) => { e.preventDefault(); if (drag !== null) move(drag, i); setDrag(null); setOver(null); }}
                    className={cx('border-t border-ink-800/60', i === 0 && 'bg-amber-500/5', drag === i && 'opacity-40', over === i && 'outline outline-2 outline-accent-400')}>
                    <td className="cursor-grab px-1 text-center font-semibold tabular-nums text-ink-300" title="Drag to move">{i + 1}</td>
                    <td className="px-0.5">
                      <div className="flex flex-col">
                        <button disabled={i === 0} onClick={() => move(i, i - 1)} className="h-3.5 text-[9px] leading-none text-ink-500 hover:text-ink-100 disabled:opacity-20" aria-label="Move up">▲</button>
                        <button disabled={i === g.rows.length - 1} onClick={() => move(i, i + 1)} className="h-3.5 text-[9px] leading-none text-ink-500 hover:text-ink-100 disabled:opacity-20" aria-label="Move down">▼</button>
                      </div>
                    </td>
                    <td className="px-1 py-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="grid h-4 w-6 shrink-0 place-items-center overflow-hidden rounded-sm bg-ink-900">{flag && <img src={flag} alt="" className="h-full w-full object-cover" />}</span>
                        <span className="w-8 shrink-0 font-mono text-xs font-bold text-ink-100">{t?.code ?? '?'}</span>
                        {t ? <TeamProfileLink teamId={t.id} name={t.name} /> : <span className="w-5" />}
                        <span className="truncate text-ink-300">{t?.name ?? 'Unknown team'}</span>
                        {t?.ranking && <span className="text-[10px] text-ink-500">[{t.ranking}]</span>}
                      </div>
                    </td>
                    {r.races.map((v, j) => (
                      <td key={j} className="px-0.5 py-0.5"><SaveInput value={v} onSave={(x) => setRace(r, j, x)} label={`${t?.code} R${j + 1}`} maxLength={12} inputMode="numeric" className="px-1 text-center tabular-nums" /></td>
                    ))}
                    <td className="px-1 py-0.5">
                      <SaveInput value={r.points} onSave={(points) => put({ rows: [{ teamId: r.teamId, points: points.trim() }] })} label={`${t?.code} points`} placeholder={r.autoPoints || '0'} maxLength={12}
                        className={cx('px-1 text-center font-bold tabular-nums', r.points ? 'text-sky-300' : 'text-ink-50')} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <footer className="border-t border-ink-800 px-3 py-1.5 text-[11px] text-ink-500">
        Empty Points = sum of the races (shown greyed); a typed value (blue) wins. {g.updatedAt ? `Saved ${fmtDateTime(g.updatedAt)}.` : 'Nothing entered yet.'}
      </footer>
      {dialog}
    </section>
  );
}
