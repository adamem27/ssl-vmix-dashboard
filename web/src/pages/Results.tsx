import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, FleetSetSummary, Team } from '../api';
import { Button, cx, Empty, ErrorBox, fmtDateTime, Loading, useConfirm, useToast } from '../components/ui';
import { SaveInput } from '../components/fields';
import { TeamProfileLink } from '../components/TeamProfileLink';
import { useStage } from '../components/StagePicker';

interface RRow { teamId: string; races: string[]; points: string; autoPoints: string; total: string }
interface Group { fleetId: string; fleetName: string; setId: string; setName: string; title: string; subtitle: string; vmixInput: string; races: number; rows: RRow[]; updatedAt: string | null }
const MAX_RACES = 12;

/** Overall results of every group (fleet) of a fleet set, for the results table graphic. */
export function ResultsPage() {
  const [params, setParams] = useSearchParams();
  const sets = useQuery({ queryKey: ['fleet-sets'], queryFn: () => api.get<FleetSetSummary[]>('/api/fleet-sets') });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api.get<Team[]>('/api/teams') });
  const stage = useStage();
  // with a stage picked the tab opens on its groups and the other sets' tabs are hidden
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
            {sets.data.filter((s) => !stage.data?.current || s.id === stage.data.current.id || s.id === params.get('set')).map((s) => (
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
  const [sending, setSending] = useState(false);
  const send = async () => {
    setSending(true);
    try {
      const r = await api.post<{ input: string; number: string; sent: number; teams: number; rowsInTitle: number; tooMany: boolean; cols: number; racesHidden: number }>(`/api/results/${g.fleetId}/vmix`);
      if (r.tooMany) toast.error(`${r.teams} teams but the title “${r.input}” has ${r.rowsInTitle} rows: the last ones are not shown.`);
      else if (r.racesHidden) toast.error(`The title has ${r.cols} race columns: only the last ${r.cols} races are shown.`);
      else toast.ok(`Sent to vMix input ${r.number} “${r.input}” (${r.sent} fields)`);
    } catch (e) { toast.error(e); } finally { setSending(false); }
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
        <div className="flex items-end gap-1 border-l border-ink-800 pl-2">
          <label className="w-48"><span className="label">vMix input</span>
            <SaveInput value={g.vmixInput} onSave={(vmixInput) => put({ vmixInput })} label="vMix input" placeholder="name or number in vMix" maxLength={120} className="text-xs" /></label>
          <Button size="sm" variant="primary" busy={sending} disabled={!g.vmixInput.trim()} onClick={send}
            title="Fills the vMix title with this table: subtitle, race headers, places, flags, teams, races and points">Send to vMix</Button>
        </div>
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
      {g.rows.length > 0 && <RaceRunPanel g={g} teamById={teamById} />}
      <footer className="border-t border-ink-800 px-3 py-1.5 text-[11px] text-ink-500">
        Empty Points = sum of the races (shown greyed); a typed value (blue) wins. {g.updatedAt ? `Saved ${fmtDateTime(g.updatedAt)}.` : 'Nothing entered yet.'}
      </footer>
      {dialog}
    </section>
  );
}

interface RunRow { teamId: string; times: string[]; points: string; finish: string; gap: string; autoPoints: string; total: string }
interface Run { fleetId: string; race: number; marks: string[]; rows: RunRow[]; updatedAt: string | null }

/** One race of the group: times at the marks for the Race results board. Rows follow the finish times; points go into R{race} above. */
function RaceRunPanel({ g, teamById }: { g: Group; teamById: Map<string, Team> }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const [race, setRace] = useState(1);
  const key = ['race-run', g.fleetId, race];
  const run = useQuery({ queryKey: key, queryFn: () => api.get<Run>(`/api/races/${g.fleetId}/${race}`) });
  const done = (r: Run) => { qc.setQueryData(key, r); void qc.invalidateQueries({ queryKey: ['results', g.setId] }); };
  const put = async (body: object) => { try { done(await api.put<Run>(`/api/races/${g.fleetId}/${race}`, body)); } catch (e) { toast.error(e); } };
  const clear = async () => { if (await ask(`Clear race ${race} of ${g.fleetName}?`, 'Times and points of this race go back to empty.', 'Clear')) { try { done(await api.del<Run>(`/api/races/${g.fleetId}/${race}`)); } catch (e) { toast.error(e); } } };
  const r = run.data;
  const setTime = (row: RunRow, i: number, v: string) => { const times = [...row.times]; times[i] = v.trim(); void put({ rows: [{ teamId: row.teamId, times }] }); };

  return (
    <div className="border-t border-ink-800">
      <div className="flex flex-wrap items-end gap-2 px-3 py-2">
        <span className="mr-1 text-sm font-semibold text-ink-200">Race results · times at marks</span>
        <div className="flex flex-wrap gap-0.5" role="tablist" aria-label="Race">
          {Array.from({ length: Math.min(MAX_RACES, g.races + 1) }, (_, i) => i + 1).map((n) => (
            <button key={n} role="tab" aria-selected={n === race} onClick={() => setRace(n)}
              className={cx('rounded border px-2 py-0.5 text-xs tabular-nums', n === race ? 'border-accent-500 bg-accent-500/15 text-accent-300' : 'border-ink-700 text-ink-400 hover:bg-ink-800')}>R{n}</button>
          ))}
        </div>
        <label className="ml-auto w-72"><span className="label">Marks (comma separated, finish last)</span>
          <SaveInput value={r?.marks.join(', ') ?? ''} onSave={(v) => put({ marks: v.split(',').map((x) => x.trim()).filter(Boolean) })} label="Marks" maxLength={140} className="text-xs" /></label>
        <Button size="sm" variant="ghost" onClick={clear}>Clear race</Button>
      </div>
      {run.isLoading ? <Loading /> : run.error ? <ErrorBox error={run.error} onRetry={() => run.refetch()} /> : r && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wide text-ink-500">
              <tr>
                <th className="w-8 px-1 py-1 text-center">#</th><th className="px-1 py-1 text-left">Team</th>
                {r.marks.map((m, i) => <th key={i} className="w-20 px-0.5 py-1 text-center">{m}</th>)}
                <th className="w-14 px-1 py-1 text-center">Gap</th><th className="w-14 px-1 py-1 text-center">Points</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((row, i) => {
                const t = teamById.get(row.teamId);
                return (
                  <tr key={row.teamId} className={cx('border-t border-ink-800/60', i === 0 && row.finish && 'bg-amber-500/5')}>
                    <td className="px-1 text-center font-semibold tabular-nums text-ink-300">{row.finish ? i + 1 : '–'}</td>
                    <td className="px-1 py-1"><span className="font-mono text-xs font-bold text-ink-100">{t?.code ?? '?'}</span> <span className="text-ink-400">{t?.name}</span></td>
                    {row.times.map((v, j) => (
                      <td key={j} className="px-0.5 py-0.5"><SaveInput value={v} onSave={(x) => setTime(row, j, x)} label={`${t?.code} ${r.marks[j]}`} placeholder={j === row.times.length - 1 ? '1:15:00' : '15:00'} maxLength={12} className="px-1 text-center tabular-nums" /></td>
                    ))}
                    <td className="px-1 text-center text-xs tabular-nums text-ink-400">{row.gap}</td>
                    <td className="px-1 py-0.5">
                      <SaveInput value={row.points} onSave={(points) => put({ rows: [{ teamId: row.teamId, points: points.trim() }] })} label={`${t?.code} race points`} placeholder={row.autoPoints || '0'} maxLength={12}
                        className={cx('px-1 text-center font-bold tabular-nums', row.points ? 'text-sky-300' : 'text-ink-50')} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-3 pb-2 pt-1 text-[11px] text-ink-500">
        Times as m:ss or h:mm:ss. Rows sort by the finish; points are boats − place + 1 unless typed, and land in R{race} of the table above. Typing a race of the group on air makes it the one the RACE RESULTS key shows.
      </p>
      {dialog}
    </div>
  );
}
