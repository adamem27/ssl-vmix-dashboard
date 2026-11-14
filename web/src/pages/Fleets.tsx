import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, DragEndEvent, DragOverlay, DragStartEvent, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors,
} from '@dnd-kit/core';
import { api, ApiError, FleetSetDetail, FleetSetSummary, Team } from '../api';
import { useStageTeams } from '../components/StagePicker';
import { TeamProfileLink } from '../components/TeamProfileLink';
import { Badge, Button, cx, Empty, ErrorBox, Field, Loading, Modal, useConfirm, useToast } from '../components/ui';

type Occupied = { teamId: string; fleetId: string; position: number; occupantId: string; from: { fleetId: string; position: number; fleetName: string } | null; freePositions: number[] };

export function FleetsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const sets = useQuery({ queryKey: ['fleet-sets'], queryFn: () => api.get<FleetSetSummary[]>('/api/fleet-sets') });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api.get<Team[]>('/api/teams') });
  const [setId, setSetId] = useState<string | null>(() => { try { return localStorage.getItem('fleetSet'); } catch { return null; } });
  const [nameModal, setNameModal] = useState<null | { mode: 'newSet' | 'renameSet' | 'newFleet' | 'renameFleet'; id?: string; initial: string }>(null);
  const [occupied, setOccupied] = useState<Occupied | null>(null);
  const [dragTeam, setDragTeam] = useState<string | null>(null);
  const [poolSearch, setPoolSearch] = useState('');
  const stage = useStageTeams();
  const [allTeams, setAllTeams] = useState(false);

  useEffect(() => {
    if (!sets.data) return;
    if (!setId || !sets.data.some((s) => s.id === setId)) setSetId(sets.data[0]?.id ?? null);
  }, [sets.data, setId]);
  useEffect(() => { try { if (setId) localStorage.setItem('fleetSet', setId); } catch { /* ignore */ } }, [setId]);

  const detail = useQuery({ queryKey: ['fleet-set', setId], queryFn: () => api.get<FleetSetDetail>(`/api/fleet-sets/${setId}`), enabled: !!setId });
  const teamById = useMemo(() => new Map((teams.data ?? []).map((t) => [t.id, t])), [teams.data]);
  const d = detail.data;
  const assigned = new Set(d?.assignedTeamIds ?? []);
  // with a stage picked only its teams are offered, unless “all teams” is ticked (needed to build a stage)
  const offered = (teams.data ?? []).filter((t) => allTeams || stage.inStage(t.id) || assigned.has(t.id));
  const pool = offered.filter((t) => !assigned.has(t.id) && (!poolSearch || `${t.name} ${t.code}`.toLowerCase().includes(poolSearch.toLowerCase())));
  // a team also in the Last Chance / Qualification Race: its own group first
  const isLcr = (name: string) => /last\s*chance|\blcr\b|qualification\s*race|\bqr\b/i.test(name);
  const locate = (teamId: string) => {
    const found = (d?.fleets ?? []).flatMap((f) => { const i = f.positions.indexOf(teamId); return i >= 0 ? [{ fleetId: f.id, position: i + 1, fleetName: f.name }] : []; });
    return found.find((x) => !isLcr(x.fleetName)) ?? found[0] ?? null;
  };
  const fleetName = (id: string) => d?.fleets.find((f) => f.id === id)?.name ?? '';
  const tName = (id: string) => teamById.get(id)?.name ?? '?';

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor));

  const refresh = (data?: FleetSetDetail) => {
    if (data) qc.setQueryData(['fleet-set', setId], data);
    else qc.invalidateQueries({ queryKey: ['fleet-set', setId] });
    qc.invalidateQueries({ queryKey: ['fleet-sets'] });
    qc.invalidateQueries({ queryKey: ['stage'] });
  };

  const place = async (teamId: string, fleetId: string, position: number | undefined, onOccupied?: 'swap') => {
    if (!setId) return;
    try {
      const res = await api.post<FleetSetDetail & { result: { changed: boolean; displaced: null | { teamId: string; to: 'previous' | 'unassigned' } } }>(
        `/api/fleet-sets/${setId}/place`, { teamId, fleetId, position, onOccupied });
      refresh(res);
      if (!res.result.changed) return;
      const dsp = res.result.displaced;
      toast.ok(dsp
        ? `Swapped: ${tName(teamId)} ↔ ${tName(dsp.teamId)}${dsp.to === 'unassigned' ? ` (${tName(dsp.teamId)} returned to available teams)` : ''}`
        : `${tName(teamId)} → ${fleetName(fleetId)}, place ${res.fleets.find((f) => f.id === fleetId)?.positions.indexOf(teamId)! + 1}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.details?.occupantTeamId && position) {
        setOccupied({ teamId, fleetId, position, occupantId: e.details.occupantTeamId, from: locate(teamId), freePositions: e.details.freePositions ?? [] });
      } else toast.error(e);
    }
  };

  const unassign = async (teamId: string, fleetId?: string) => {
    if (!setId) return;
    try { refresh(await api.post<FleetSetDetail>(`/api/fleet-sets/${setId}/unassign`, { teamId, fleetId })); toast.ok(`${tName(teamId)} removed from the group (still in the team database)`); }
    catch (e) { toast.error(e); }
  };

  const onDragStart = (e: DragStartEvent) => setDragTeam(String(e.active.data.current?.teamId ?? ''));
  const onDragEnd = (e: DragEndEvent) => {
    setDragTeam(null);
    const teamId = e.active.data.current?.teamId as string | undefined;
    const over = e.over?.data.current as { kind: 'slot'; fleetId: string; position: number } | { kind: 'pool' } | undefined;
    if (!teamId || !over) return;
    if (over.kind === 'pool') { if (assigned.has(teamId)) void unassign(teamId); return; }
    const fleet = d?.fleets.find((f) => f.id === over.fleetId);
    const occupant = fleet?.positions[over.position - 1];
    if (occupant === teamId) return;
    if (occupant) {
      const free = fleet!.positions.map((p, i) => (p ? null : i + 1)).filter((x): x is number => x !== null);
      setOccupied({ teamId, fleetId: over.fleetId, position: over.position, occupantId: occupant, from: locate(teamId), freePositions: free });
      return;
    }
    void place(teamId, over.fleetId, over.position);
  };

  const saveName = async (value: string) => {
    if (!nameModal) return;
    try {
      if (nameModal.mode === 'newSet') {
        const r = await api.post<FleetSetDetail>('/api/fleet-sets', { name: value, fleetCount: 0 });
        qc.invalidateQueries({ queryKey: ['fleet-sets'] }); setSetId(r.set.id); toast.ok(`Stage “${value}” created`);
      } else if (nameModal.mode === 'renameSet') {
        refresh(await api.patch<FleetSetDetail>(`/api/fleet-sets/${setId}`, { name: value })); toast.ok('Stage renamed');
      } else if (nameModal.mode === 'newFleet') {
        const size = d?.fleets[d.fleets.length - 1]?.size ?? 4;
        refresh(await api.post<FleetSetDetail>(`/api/fleet-sets/${setId}/fleets`, { name: value, size })); toast.ok(`Group “${value}” added (${size} teams)`);
      } else {
        await api.patch(`/api/fleets/${nameModal.id}`, { name: value }); refresh(); toast.ok('Group renamed');
      }
      setNameModal(null);
    } catch (e) { toast.error(e); }
  };

  const deleteSet = async () => {
    const s = sets.data?.find((x) => x.id === setId);
    if (!s || !(await ask('Delete stage?', <>Stage <b>{s.name}</b> and all its groups will be deleted. Teams stay in the database.</>, 'Delete stage'))) return;
    try { await api.del(`/api/fleet-sets/${s.id}`); setSetId(null); qc.invalidateQueries({ queryKey: ['fleet-sets'] }); toast.ok('Stage deleted'); } catch (e) { toast.error(e); }
  };
  const deleteFleet = async (f: FleetSetDetail['fleets'][number]) => {
    if (!(await ask('Delete group?', <>Group <b>{f.name}</b> will be deleted{f.filled ? ` and ${f.filled} team(s) will return to available teams` : ''}.</>, 'Delete group'))) return;
    try { await api.del(`/api/fleets/${f.id}`); refresh(); toast.ok('Group deleted'); } catch (e) { toast.error(e); }
  };
  const resize = async (f: FleetSetDetail['fleets'][number] | null, size: number) => {
    try {
      if (f) { await api.patch(`/api/fleets/${f.id}`, { size }); refresh(); toast.ok(`${f.name}: ${size} teams`); }
      else { refresh(await api.patch<FleetSetDetail>(`/api/fleet-sets/${setId}`, { fleetSize: size })); toast.ok(`Every group of this stage: ${size} teams`); }
    } catch (e) { toast.error(e); }
  };
  const moveFleet = async (id: string, direction: -1 | 1) => {
    try { await api.post(`/api/fleets/${id}/move`, { direction }); refresh(); } catch (e) { toast.error(e); }
  };

  if (sets.isLoading || teams.isLoading) return <Loading />;
  if (sets.error) return <ErrorBox error={sets.error} onRetry={() => sets.refetch()} />;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-bold">Groups</h1>
        </div>
        {!!sets.data?.length && (
          <Field label="Stage">
            <select className="input w-64" value={setId ?? ''} onChange={(e) => setSetId(e.target.value)}>
              {sets.data.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.assignedCount} teams)</option>)}
            </select>
          </Field>
        )}
        {setId && <Button onClick={() => setNameModal({ mode: 'renameSet', initial: d?.set.name ?? '' })}>Rename</Button>}
        {setId && <Button variant="danger" onClick={deleteSet}>Delete set</Button>}
        <Button variant="primary" onClick={() => setNameModal({ mode: 'newSet', initial: `Round ${(sets.data?.length ?? 0) + 1}` })}>+ New set</Button>
      </div>

      {!sets.data?.length ? (
        <Empty title="No stages yet" action={<Button variant="primary" onClick={() => setNameModal({ mode: 'newSet', initial: 'Round 1' })}>Create the first stage</Button>}>
          A stage is one split of teams into groups (e.g. the Qualifying Series). Different stages can split the same teams differently.
        </Empty>
      ) : detail.isLoading ? <Loading /> : detail.error ? <ErrorBox error={detail.error} /> : d && (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragTeam(null)}>
          <div className="grid gap-4 xl:grid-cols-[280px_1fr]">
            <Pool>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Available teams</h2>
                <span className="text-xs text-ink-500">{offered.filter((t) => !assigned.has(t.id)).length}</span>
              </div>
              {stage.stage && (
                <label className="mt-1 flex items-center gap-1.5 text-xs text-ink-400" title={`Only the teams of the stage ${stage.stage.name} are listed. Tick to add other teams.`}>
                  <input type="checkbox" checked={allTeams} onChange={(e) => setAllTeams(e.target.checked)} /> Show teams outside stage {stage.stage.name}
                </label>
              )}
              <input className="input mt-2" type="search" placeholder="Filter…" value={poolSearch} onChange={(e) => setPoolSearch(e.target.value)} aria-label="Filter available teams" />
              <ul className="mt-2 max-h-[60vh] space-y-1 overflow-auto pr-1">
                {pool.map((t) => (
                  <li key={t.id}><TeamChip team={t} /></li>
                ))}
                {!pool.length && <li className="py-6 text-center text-xs text-ink-500">{!teams.data?.length ? 'No teams in the database.' : stage.stage && !allTeams ? `All teams of stage ${stage.stage.name} are assigned.` : 'All teams are assigned.'}</li>}
              </ul>
            </Pool>

            <div>
              <div className="mb-2 flex items-center gap-3">
                <span className="text-sm text-ink-400">{d.fleets.length} groups · {d.fleets.filter((f) => !f.complete).length} incomplete</span>
                {!!d.fleets.length && (
                  <label className="flex items-center gap-1.5 text-xs text-ink-400">
                    All groups:
                    <SizeSelect value={d.fleets.every((f) => f.size === d.fleets[0].size) ? d.fleets[0].size : 0} onChange={(n) => resize(null, n)} label="Teams in every group of this stage" />
                  </label>
                )}
                <Button size="sm" className="ml-auto" variant="primary" onClick={() => setNameModal({ mode: 'newFleet', initial: `Group ${String.fromCharCode(65 + d.fleets.length)}` })}>+ Add group</Button>
              </div>
              {!d.fleets.length ? (
                <Empty title="This stage has no groups" action={<Button variant="primary" onClick={() => setNameModal({ mode: 'newFleet', initial: 'Group A' })}>Add group</Button>} />
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3">
                  {d.fleets.map((f, fi) => (
                    <section key={f.id} className={cx('card', !f.complete && 'border-amber-900/60')} aria-label={f.name}>
                      <header className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
                        <h3 className="truncate font-semibold">{f.name}</h3>
                        <Badge tone={f.complete ? 'ok' : 'warn'}>{f.complete ? 'Complete' : `Incomplete ${f.filled}/${f.size}`}</Badge>
                        <SizeSelect value={f.size} onChange={(n) => resize(f, n)} label={`Teams in ${f.name}`} />
                        <div className="ml-auto flex">
                          <IconBtn label="Move group left" disabled={fi === 0} onClick={() => moveFleet(f.id, -1)}>←</IconBtn>
                          <IconBtn label="Move group right" disabled={fi === d.fleets.length - 1} onClick={() => moveFleet(f.id, 1)}>→</IconBtn>
                          <IconBtn label="Rename group" onClick={() => setNameModal({ mode: 'renameFleet', id: f.id, initial: f.name })}>✎</IconBtn>
                          <IconBtn label="Delete group" onClick={() => deleteFleet(f)}>🗑</IconBtn>
                        </div>
                      </header>
                      <ol className="space-y-1.5 p-2">
                        {f.positions.map((tid, i) => (
                          <Slot key={i} fleetId={f.id} position={i + 1}>
                            <span className="w-6 shrink-0 text-center text-sm font-bold tabular-nums text-ink-500">{i + 1}</span>
                            {tid ? (
                              <>
                                <div className="min-w-0 flex-1"><TeamChip team={teamById.get(tid)} compact /></div>
                                <IconBtn label="Move up" disabled={i === 0} onClick={() => place(tid, f.id, i, 'swap')}>↑</IconBtn>
                                <IconBtn label="Move down" disabled={i === f.size - 1} onClick={() => place(tid, f.id, i + 2, 'swap')}>↓</IconBtn>
                                <select className="w-8 cursor-pointer rounded bg-transparent text-xs text-ink-400 hover:bg-ink-800" aria-label={`Move ${tName(tid)} to another group`} value=""
                                  onChange={(e) => { if (e.target.value) void place(tid, e.target.value, undefined); }}>
                                  <option value="">⇄</option>
                                  {d.fleets.filter((o) => o.id !== f.id).map((o) => <option key={o.id} value={o.id} disabled={o.complete}>{o.name}{o.complete ? ' (full)' : ''}</option>)}
                                </select>
                                <IconBtn label={`Remove ${tName(tid)} from the group`} onClick={() => unassign(tid, f.id)}>✕</IconBtn>
                              </>
                            ) : (
                              <select className="input flex-1 border-dashed py-1.5 text-xs text-ink-400" value="" aria-label={`Choose a team for place ${i + 1} in ${f.name}`}
                                onChange={(e) => { if (e.target.value) void place(e.target.value, f.id, i + 1); }}>
                                <option value="">{f.placeholders?.[i] ? `${f.placeholders[i]}` : '—'}</option>
                                <optgroup label="Available">
                                  {offered.filter((t) => !assigned.has(t.id)).map((t) => <option key={t.id} value={t.id}>{t.code} – {t.name}</option>)}
                                </optgroup>
                                <optgroup label={isLcr(f.name) ? 'Also from another group (stays there too)' : 'Move from another group'}>
                                  {(teams.data ?? []).filter((t) => assigned.has(t.id) && !f.positions.includes(t.id)).map((t) => <option key={t.id} value={t.id}>{t.code} – {t.name} ({locate(t.id)?.fleetName})</option>)}
                                </optgroup>
                              </select>
                            )}
                          </Slot>
                        ))}
                      </ol>
                    </section>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DragOverlay dropAnimation={null}>{dragTeam ? <TeamChip team={teamById.get(dragTeam)} overlay /> : null}</DragOverlay>
        </DndContext>
      )}

      <NameModal state={nameModal} onClose={() => setNameModal(null)} onSave={saveName} />
      <Modal open={!!occupied} onClose={() => setOccupied(null)} title="Place is occupied">
        {occupied && (
          <div className="space-y-4 text-sm">
            <p className="text-ink-300">
              Place {occupied.position} in <b>{fleetName(occupied.fleetId)}</b> is taken by <b>{tName(occupied.occupantId)}</b>. Choose what to do with <b>{tName(occupied.teamId)}</b>:
            </p>
            <div className="flex flex-col gap-2">
              <Button variant="primary" data-autofocus onClick={() => { const o = occupied; setOccupied(null); void place(o.teamId, o.fleetId, o.position, 'swap'); }}>
                Swap: {tName(occupied.occupantId)} {occupied.from ? `→ ${occupied.from.fleetName}, place ${occupied.from.position}` : 'returns to available teams'}
              </Button>
              {occupied.freePositions.map((p) => (
                <Button key={p} onClick={() => { const o = occupied; setOccupied(null); void place(o.teamId, o.fleetId, p); }}>Put in free place {p}</Button>
              ))}
              <Button variant="ghost" onClick={() => setOccupied(null)}>Cancel</Button>
            </div>
          </div>
        )}
      </Modal>
      {dialog}
    </div>
  );
}

const SIZES = Array.from({ length: 16 }, (_, i) => i + 1);
function SizeSelect({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <select className="rounded border border-ink-700 bg-ink-900 px-1 py-0.5 text-xs text-ink-300" aria-label={label} title={label} value={value}
      onChange={(e) => { const n = Number(e.target.value); if (n) onChange(n); }}>
      {!value && <option value={0}>mixed</option>}
      {SIZES.map((n) => <option key={n} value={n}>{n} teams</option>)}
    </select>
  );
}

function IconBtn({ label, children, ...p }: { label: string; children: ReactNode; onClick?: () => void; disabled?: boolean }) {
  return <button {...p} aria-label={label} title={label} className="grid h-7 w-7 place-items-center rounded text-xs text-ink-400 hover:bg-ink-800 hover:text-ink-50 disabled:opacity-30">{children}</button>;
}

function Pool({ children }: { children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'pool', data: { kind: 'pool' } });
  return <aside ref={setNodeRef} className={cx('card h-fit p-3 xl:sticky xl:top-[64px]', isOver && 'ring-2 ring-accent-400')}>{children}</aside>;
}

function Slot({ fleetId, position, children }: { fleetId: string; position: number; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `slot:${fleetId}:${position}`, data: { kind: 'slot', fleetId, position } });
  return <li ref={setNodeRef} className={cx('flex items-center gap-1 rounded-lg border border-ink-800 bg-ink-950/50 p-1', isOver && 'border-accent-400 bg-accent-500/10')}>{children}</li>;
}

function TeamChip({ team, compact, overlay }: { team?: Team; compact?: boolean; overlay?: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `team:${team?.id}`, data: { teamId: team?.id }, disabled: !team || overlay });
  if (!team) return <div className="px-2 py-1.5 text-xs text-red-300">Unknown team</div>;
  return (
    <div ref={overlay ? undefined : setNodeRef} {...(overlay ? {} : listeners)} {...(overlay ? {} : attributes)}
      aria-label={overlay ? undefined : `${team.name}, drag (space, arrows, space)`} aria-hidden={overlay || undefined}
      className={cx('flex cursor-grab items-center gap-2 rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5 active:cursor-grabbing',
        isDragging && 'opacity-30', overlay && 'shadow-2xl ring-2 ring-accent-400', compact && 'border-transparent bg-transparent')}>
      <span className="checker grid h-6 w-9 shrink-0 place-items-center overflow-hidden rounded-sm">
        {team.thumb?.previewUrl && <img src={team.thumb.previewUrl} alt="" className="max-h-full max-w-full object-contain" />}
      </span>
      <span className="w-10 shrink-0 font-mono text-xs text-ink-400">{team.code}</span>
      {!overlay && <TeamProfileLink teamId={team.id} name={team.name} className="-ml-1" />}
      <span className="truncate text-sm font-medium">{team.name}</span>
      {team.isDemo && !compact && <Badge tone="demo">Demo</Badge>}
    </div>
  );
}

function NameModal({ state, onClose, onSave }: { state: { mode: string; initial: string } | null; onClose: () => void; onSave: (v: string) => Promise<void> }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (state) setV(state.initial); }, [state]);
  const titles: Record<string, string> = { newSet: 'New stage', renameSet: 'Stage name', newFleet: 'New group', renameFleet: 'Group name' };
  return (
    <Modal open={!!state} onClose={onClose} title={state ? titles[state.mode] : ''}>
      <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); await onSave(v.trim()); setBusy(false); }} className="space-y-4">
        <Field label="Name"><input className="input" value={v} onChange={(e) => setV(e.target.value)} required maxLength={120} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy} disabled={!v.trim()}>Save</Button></div>
      </form>
    </Modal>
  );
}
