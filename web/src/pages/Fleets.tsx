import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, DragEndEvent, DragOverlay, DragStartEvent, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors,
} from '@dnd-kit/core';
import { api, ApiError, FleetSetDetail, FleetSetSummary, Team } from '../api';
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

  useEffect(() => {
    if (!sets.data) return;
    if (!setId || !sets.data.some((s) => s.id === setId)) setSetId(sets.data[0]?.id ?? null);
  }, [sets.data, setId]);
  useEffect(() => { try { if (setId) localStorage.setItem('fleetSet', setId); } catch { /* ignore */ } }, [setId]);

  const detail = useQuery({ queryKey: ['fleet-set', setId], queryFn: () => api.get<FleetSetDetail>(`/api/fleet-sets/${setId}`), enabled: !!setId });
  const teamById = useMemo(() => new Map((teams.data ?? []).map((t) => [t.id, t])), [teams.data]);
  const d = detail.data;
  const assigned = new Set(d?.assignedTeamIds ?? []);
  const pool = (teams.data ?? []).filter((t) => !assigned.has(t.id) && (!poolSearch || `${t.name} ${t.code}`.toLowerCase().includes(poolSearch.toLowerCase())));
  const locate = (teamId: string) => {
    for (const f of d?.fleets ?? []) { const i = f.positions.indexOf(teamId); if (i >= 0) return { fleetId: f.id, position: i + 1, fleetName: f.name }; }
    return null;
  };
  const fleetName = (id: string) => d?.fleets.find((f) => f.id === id)?.name ?? '';
  const tName = (id: string) => teamById.get(id)?.name ?? '?';

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor));

  const refresh = (data?: FleetSetDetail) => {
    if (data) qc.setQueryData(['fleet-set', setId], data);
    else qc.invalidateQueries({ queryKey: ['fleet-set', setId] });
    qc.invalidateQueries({ queryKey: ['fleet-sets'] });
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
        ? `Zamieniono: ${tName(teamId)} ↔ ${tName(dsp.teamId)}${dsp.to === 'unassigned' ? ` (${tName(dsp.teamId)} wróciła do listy dostępnych)` : ''}`
        : `${tName(teamId)} → ${fleetName(fleetId)}, miejsce ${res.fleets.find((f) => f.id === fleetId)?.positions.indexOf(teamId)! + 1}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.details?.occupantTeamId && position) {
        setOccupied({ teamId, fleetId, position, occupantId: e.details.occupantTeamId, from: locate(teamId), freePositions: e.details.freePositions ?? [] });
      } else toast.error(e);
    }
  };

  const unassign = async (teamId: string) => {
    if (!setId) return;
    try { refresh(await api.post<FleetSetDetail>(`/api/fleet-sets/${setId}/unassign`, { teamId })); toast.ok(`${tName(teamId)} usunięta z floty (pozostaje w bazie drużyn)`); }
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
        qc.invalidateQueries({ queryKey: ['fleet-sets'] }); setSetId(r.set.id); toast.ok(`Utworzono zestaw „${value}”`);
      } else if (nameModal.mode === 'renameSet') {
        refresh(await api.patch<FleetSetDetail>(`/api/fleet-sets/${setId}`, { name: value })); toast.ok('Zmieniono nazwę zestawu');
      } else if (nameModal.mode === 'newFleet') {
        refresh(await api.post<FleetSetDetail>(`/api/fleet-sets/${setId}/fleets`, { name: value })); toast.ok(`Dodano flotę „${value}”`);
      } else {
        await api.patch(`/api/fleets/${nameModal.id}`, { name: value }); refresh(); toast.ok('Zmieniono nazwę floty');
      }
      setNameModal(null);
    } catch (e) { toast.error(e); }
  };

  const deleteSet = async () => {
    const s = sets.data?.find((x) => x.id === setId);
    if (!s || !(await ask('Usunąć zestaw flot?', <>Zestaw <b>{s.name}</b> i wszystkie jego floty zostaną usunięte. Drużyny pozostaną w bazie.</>, 'Usuń zestaw'))) return;
    try { await api.del(`/api/fleet-sets/${s.id}`); setSetId(null); qc.invalidateQueries({ queryKey: ['fleet-sets'] }); toast.ok('Usunięto zestaw'); } catch (e) { toast.error(e); }
  };
  const deleteFleet = async (f: FleetSetDetail['fleets'][number]) => {
    if (!(await ask('Usunąć flotę?', <>Flota <b>{f.name}</b> zostanie usunięta{f.filled ? `, a ${f.filled} drużyn(y) wróci do listy dostępnych` : ''}.</>, 'Usuń flotę'))) return;
    try { await api.del(`/api/fleets/${f.id}`); refresh(); toast.ok('Usunięto flotę'); } catch (e) { toast.error(e); }
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
          <h1 className="text-2xl font-bold">Floty</h1>
          <p className="text-sm text-ink-400">Cztery łódki we flocie, po jednej drużynie na łódkę. Przeciągnij drużynę albo użyj list wyboru.</p>
        </div>
        {!!sets.data?.length && (
          <Field label="Zestaw flot / runda">
            <select className="input w-64" value={setId ?? ''} onChange={(e) => setSetId(e.target.value)}>
              {sets.data.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.assignedCount} drużyn)</option>)}
            </select>
          </Field>
        )}
        {setId && <Button onClick={() => setNameModal({ mode: 'renameSet', initial: d?.set.name ?? '' })}>Zmień nazwę</Button>}
        {setId && <Button variant="danger" onClick={deleteSet}>Usuń zestaw</Button>}
        <Button variant="primary" onClick={() => setNameModal({ mode: 'newSet', initial: `Runda ${(sets.data?.length ?? 0) + 1}` })}>+ Nowy zestaw</Button>
      </div>

      {!sets.data?.length ? (
        <Empty title="Brak zestawów flot" action={<Button variant="primary" onClick={() => setNameModal({ mode: 'newSet', initial: 'Runda 1' })}>Utwórz pierwszy zestaw</Button>}>
          Zestaw to jeden podział drużyn na floty (np. runda kwalifikacyjna). Różne zestawy mogą dzielić te same drużyny inaczej.
        </Empty>
      ) : detail.isLoading ? <Loading /> : detail.error ? <ErrorBox error={detail.error} /> : d && (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragTeam(null)}>
          <div className="grid gap-4 xl:grid-cols-[280px_1fr]">
            <Pool>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Dostępne drużyny</h2>
                <span className="text-xs text-ink-500">{(teams.data?.length ?? 0) - assigned.size}</span>
              </div>
              <input className="input mt-2" type="search" placeholder="Filtruj…" value={poolSearch} onChange={(e) => setPoolSearch(e.target.value)} aria-label="Filtruj dostępne drużyny" />
              <ul className="mt-2 max-h-[60vh] space-y-1 overflow-auto pr-1">
                {pool.map((t) => (
                  <li key={t.id}><TeamChip team={t} /></li>
                ))}
                {!pool.length && <li className="py-6 text-center text-xs text-ink-500">{teams.data?.length ? 'Wszystkie drużyny są przypisane.' : 'Brak drużyn w bazie.'}</li>}
              </ul>
              <p className="mt-2 text-[11px] text-ink-500">Upuść tutaj drużynę z floty, aby ją wypisać (pozostaje w bazie).</p>
            </Pool>

            <div>
              <div className="mb-2 flex items-center gap-3">
                <span className="text-sm text-ink-400">{d.fleets.length} flot · {d.fleets.filter((f) => !f.complete).length} niekompletnych</span>
                <Button size="sm" className="ml-auto" variant="primary" onClick={() => setNameModal({ mode: 'newFleet', initial: `Flota ${d.fleets.length + 1}` })}>+ Dodaj flotę</Button>
              </div>
              {!d.fleets.length ? (
                <Empty title="Zestaw nie ma flot" action={<Button variant="primary" onClick={() => setNameModal({ mode: 'newFleet', initial: 'Flota 1' })}>Dodaj flotę</Button>} />
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3">
                  {d.fleets.map((f, fi) => (
                    <section key={f.id} className={cx('card', !f.complete && 'border-amber-900/60')} aria-label={f.name}>
                      <header className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
                        <h3 className="truncate font-semibold">{f.name}</h3>
                        <Badge tone={f.complete ? 'ok' : 'warn'}>{f.complete ? 'Komplet' : `Niekompletna ${f.filled}/4`}</Badge>
                        <div className="ml-auto flex">
                          <IconBtn label="Przesuń flotę w lewo" disabled={fi === 0} onClick={() => moveFleet(f.id, -1)}>←</IconBtn>
                          <IconBtn label="Przesuń flotę w prawo" disabled={fi === d.fleets.length - 1} onClick={() => moveFleet(f.id, 1)}>→</IconBtn>
                          <IconBtn label="Zmień nazwę floty" onClick={() => setNameModal({ mode: 'renameFleet', id: f.id, initial: f.name })}>✎</IconBtn>
                          <IconBtn label="Usuń flotę" onClick={() => deleteFleet(f)}>🗑</IconBtn>
                        </div>
                      </header>
                      <ol className="space-y-1.5 p-2">
                        {f.positions.map((tid, i) => (
                          <Slot key={i} fleetId={f.id} position={i + 1}>
                            <span className="w-6 shrink-0 text-center text-sm font-bold tabular-nums text-ink-500">{i + 1}</span>
                            {tid ? (
                              <>
                                <div className="min-w-0 flex-1"><TeamChip team={teamById.get(tid)} compact /></div>
                                <IconBtn label="W górę" disabled={i === 0} onClick={() => place(tid, f.id, i, 'swap')}>↑</IconBtn>
                                <IconBtn label="W dół" disabled={i === 3} onClick={() => place(tid, f.id, i + 2, 'swap')}>↓</IconBtn>
                                <select className="w-8 cursor-pointer rounded bg-transparent text-xs text-ink-400 hover:bg-ink-800" aria-label={`Przenieś ${tName(tid)} do innej floty`} value=""
                                  onChange={(e) => { if (e.target.value) void place(tid, e.target.value, undefined); }}>
                                  <option value="">⇄</option>
                                  {d.fleets.filter((o) => o.id !== f.id).map((o) => <option key={o.id} value={o.id} disabled={o.complete}>{o.name}{o.complete ? ' (pełna)' : ''}</option>)}
                                </select>
                                <IconBtn label={`Usuń ${tName(tid)} z floty`} onClick={() => unassign(tid)}>✕</IconBtn>
                              </>
                            ) : (
                              <select className="input flex-1 border-dashed py-1.5 text-xs text-ink-400" value="" aria-label={`Wybierz drużynę na miejsce ${i + 1} we flocie ${f.name}`}
                                onChange={(e) => { if (e.target.value) void place(e.target.value, f.id, i + 1); }}>
                                <option value="">Puste miejsce – wybierz lub przeciągnij drużynę</option>
                                <optgroup label="Dostępne">
                                  {(teams.data ?? []).filter((t) => !assigned.has(t.id)).map((t) => <option key={t.id} value={t.id}>{t.code} – {t.name}</option>)}
                                </optgroup>
                                <optgroup label="Przenieś z innej floty">
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
      <Modal open={!!occupied} onClose={() => setOccupied(null)} title="Miejsce jest zajęte">
        {occupied && (
          <div className="space-y-4 text-sm">
            <p className="text-ink-300">
              Miejsce {occupied.position} we flocie <b>{fleetName(occupied.fleetId)}</b> zajmuje <b>{tName(occupied.occupantId)}</b>. Wybierz, co zrobić z <b>{tName(occupied.teamId)}</b>:
            </p>
            <div className="flex flex-col gap-2">
              <Button variant="primary" data-autofocus onClick={() => { const o = occupied; setOccupied(null); void place(o.teamId, o.fleetId, o.position, 'swap'); }}>
                Zamień miejscami: {tName(occupied.occupantId)} {occupied.from ? `→ ${occupied.from.fleetName}, miejsce ${occupied.from.position}` : 'wróci do listy dostępnych'}
              </Button>
              {occupied.freePositions.map((p) => (
                <Button key={p} onClick={() => { const o = occupied; setOccupied(null); void place(o.teamId, o.fleetId, p); }}>Wstaw na wolne miejsce {p}</Button>
              ))}
              <Button variant="ghost" onClick={() => setOccupied(null)}>Anuluj</Button>
            </div>
          </div>
        )}
      </Modal>
      {dialog}
    </div>
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
  if (!team) return <div className="px-2 py-1.5 text-xs text-red-300">Nieznana drużyna</div>;
  return (
    <div ref={overlay ? undefined : setNodeRef} {...(overlay ? {} : listeners)} {...(overlay ? {} : attributes)}
      aria-label={overlay ? undefined : `${team.name}, przeciągnij (spacja, strzałki, spacja)`} aria-hidden={overlay || undefined}
      className={cx('flex cursor-grab items-center gap-2 rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5 active:cursor-grabbing',
        isDragging && 'opacity-30', overlay && 'shadow-2xl ring-2 ring-accent-400', compact && 'border-transparent bg-transparent')}>
      <span className="checker grid h-6 w-9 shrink-0 place-items-center overflow-hidden rounded-sm">
        {team.thumb?.previewUrl && <img src={team.thumb.previewUrl} alt="" className="max-h-full max-w-full object-contain" />}
      </span>
      <span className="w-10 shrink-0 font-mono text-xs text-ink-400">{team.code}</span>
      <span className="truncate text-sm font-medium">{team.name}</span>
      {team.isDemo && !compact && <Badge tone="demo">Demo</Badge>}
    </div>
  );
}

function NameModal({ state, onClose, onSave }: { state: { mode: string; initial: string } | null; onClose: () => void; onSave: (v: string) => Promise<void> }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (state) setV(state.initial); }, [state]);
  const titles: Record<string, string> = { newSet: 'Nowy zestaw flot', renameSet: 'Nazwa zestawu', newFleet: 'Nowa flota', renameFleet: 'Nazwa floty' };
  return (
    <Modal open={!!state} onClose={onClose} title={state ? titles[state.mode] : ''}>
      <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); await onSave(v.trim()); setBusy(false); }} className="space-y-4">
        <Field label="Nazwa"><input className="input" value={v} onChange={(e) => setV(e.target.value)} required maxLength={120} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Anuluj</Button><Button type="submit" variant="primary" busy={busy} disabled={!v.trim()}>Zapisz</Button></div>
      </form>
    </Modal>
  );
}
