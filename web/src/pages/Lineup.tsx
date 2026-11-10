import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Sailor, Team } from '../api';
import { Button, cx, ErrorBox, fmtDate, fmtDateTime, Loading, useConfirm, useToast } from '../components/ui';
import { SaveInput } from '../components/fields';

interface Row { slot: string; sailorId: string | null; firstName: string; lastName: string; number: string; position: string; captain: boolean }
interface Lineup {
  teamId: string; exists: boolean; syncedAt: string | null; syncedDate: string | null; updatedAt: string | null;
  data: { title: string; teamName: string; photoSide?: 'left' | 'right'; extra: number; rows: Row[]; order?: string[] };
  slots: { key: string; label: string; position: string }[];
}
const MAX_EXTRA = 6;

/** Line-up graphic of one team (fields as in Team_line-up_9.gtzip), filled by hand or from the day's declaration. */
export function LineupPanel({ teamId, date, tz }: { teamId: string; date: string; tz: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const key = ['lineup', teamId];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Lineup>(`/api/lineups/${teamId}`) });
  const team = useQuery({ queryKey: ['team', teamId], queryFn: () => api.get<Team>(`/api/teams/${teamId}`) });
  const sailors = useQuery({ queryKey: ['sailors', teamId], queryFn: () => api.get<Sailor[]>(`/api/teams/${teamId}/sailors`) });
  const decl = useQuery({ queryKey: ['decl', teamId, date], queryFn: () => api.get<{ declaration: { members: unknown[] } | null }>(`/api/declarations?teamId=${teamId}&date=${date}`) });
  const [busy, setBusy] = useState('');
  // two kinds of drag: a whole place (its handle) changes the order of places; a sailor (the name) swaps sailors
  const [drag, setDrag] = useState<{ kind: 'place' | 'sailor'; slot: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const done = (l: Lineup) => { qc.setQueryData(key, l); qc.invalidateQueries({ queryKey: ['lineups'] }); };
  const put = async (body: object) => { try { done(await api.put<Lineup>(`/api/lineups/${teamId}`, body)); } catch (e) { toast.error(e); } };
  const setRow = (slot: string, patch: Partial<Row>) => put({ rows: [{ slot, ...patch }] });

  const sync = async () => {
    const l = q.data!;
    const filled = l.data.rows.some((r) => r.firstName || r.lastName);
    if (filled && !(await ask('Replace the line-up?', <>The sailors in the line-up are replaced with the declaration of {fmtDate(date)}. The title and team name stay.</>, 'Sync'))) return;
    setBusy('sync');
    try {
      const r = await api.post<{ synced: boolean; reason?: string; sailors?: number; lineup: Lineup }>(`/api/lineups/${teamId}/sync`, { date });
      done(r.lineup);
      r.synced ? toast.ok(`Line-up filled from the declaration (${r.sailors} sailors)`) : toast.error(r.reason ?? 'Nothing to sync');
    } catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const clear = async () => {
    if (!(await ask('Clear the line-up?', 'Every place is emptied; the sailors lose their line-up place in the Sailors sheet.', 'Clear'))) return;
    try { done(await api.del<Lineup>(`/api/lineups/${teamId}`)); } catch (e) { toast.error(e); }
  };
  // drag a sailor onto another place: the two places swap sailors (place names stay)
  const swap = (a: string, b: string) => {
    const rows = q.data!.data.rows;
    const ra = rows.find((r) => r.slot === a)!, rb = rows.find((r) => r.slot === b)!;
    const who = (r: Row) => ({ sailorId: r.sailorId, firstName: r.firstName, lastName: r.lastName, number: r.number, captain: r.captain });
    void put({ rows: [{ slot: a, ...who(rb) }, { slot: b, ...who(ra) }] });
  };
  // drag a place onto another: it takes that place's spot in the order
  const reorder = (from: string, to: string) => {
    const keys = q.data!.data.rows.map((r) => r.slot);
    const next = keys.filter((k) => k !== from);
    next.splice(keys.indexOf(to), 0, from);
    void put({ order: next });
  };
  const drop = (target: string) => {
    if (drag && drag.slot !== target) (drag.kind === 'place' ? reorder : swap)(drag.slot, target);
    setDrag(null); setOver(null);
  };

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const l = q.data!;
  const sailorList = [...(sailors.data ?? [])].sort((a, b) => a.lastName.localeCompare(b.lastName));
  const byId = new Map(sailorList.map((s) => [s.id, s]));
  const hasDecl = !!decl.data?.declaration;

  return (
    <section className="card mt-4" aria-label="Line-up">
      <header className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-3 py-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink-200">Line-up</h2>
        <span className="text-xs text-ink-500">
          {l.syncedAt ? <>Filled from the declaration of {fmtDate(l.syncedDate!)} at {fmtDateTime(l.syncedAt, tz)}{l.updatedAt && l.updatedAt > l.syncedAt ? ', edited since' : ''}.</> : l.exists ? 'Entered by hand.' : 'Empty so far.'}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="primary" busy={busy === 'sync'} disabled={!hasDecl} onClick={sync} title={hasDecl ? `Copy the crew declared for ${fmtDate(date)} into the line-up` : `No declaration on ${fmtDate(date)}`}>
            Sync from declaration
          </Button>
          {l.exists && <Button size="sm" variant="ghost" onClick={clear}>Clear</Button>}
        </div>
      </header>
      <div className="flex flex-wrap items-end gap-3 border-b border-ink-800 px-3 py-2">
        <label className="w-40"><span className="label">Title</span>
          <SaveInput value={l.data.title} onSave={(title) => put({ title })} label="Title" maxLength={60} /></label>
        <label className="w-64"><span className="label">Team name</span>
          <SaveInput value={l.data.teamName} onSave={(teamName) => put({ teamName })} label="Team name" placeholder={team.data?.name} maxLength={80} /></label>
        <label className="w-40"><span className="label">Photo boxes</span>
          <select className="input py-1 text-sm" value={l.data.photoSide ?? 'left'} onChange={(e) => put({ photoSide: e.target.value as 'left' | 'right' })} aria-label="Photo boxes side" title="Which PNG from the generator goes behind each photo: Lineup photo left (colour on the left) or right (mirrored)">
            <option value="left">◧ Colour left</option>
            <option value="right">◨ Colour right</option>
          </select></label>
        <p className="mb-1 text-xs text-ink-500">In Excel: title and team name in “Teams”, places in “Sailors” (Line-up place). Surnames go in capitals. Drag a place by ⠿ to change the order; drag a sailor’s name onto another place to swap sailors.</p>
      </div>
      <div className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
        {l.data.rows.map((r) => {
          const def = l.slots.find((s) => s.key === r.slot);
          const photo = r.sailorId ? byId.get(r.sailorId)?.photo?.previewUrl : null;
          return (
            <div key={r.slot}
              onDragOver={(e) => { if (drag && drag.slot !== r.slot) { e.preventDefault(); setOver(r.slot); } }} onDragLeave={() => setOver(null)}
              onDrop={(e) => { e.preventDefault(); drop(r.slot); }}
              className={cx('rounded-lg border bg-ink-950/40 p-2', r.captain ? 'border-amber-700/70' : 'border-ink-800', drag?.slot === r.slot && 'opacity-40',
                over === r.slot && (drag?.kind === 'place' ? 'ring-2 ring-sky-400' : 'ring-2 ring-accent-400'))}>
              <div className="mb-1.5 flex items-center gap-1.5">
                <span draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.slot); setDrag({ kind: 'place', slot: r.slot }); }}
                  onDragEnd={() => { setDrag(null); setOver(null); }} title="Drag to move this place"
                  className="flex cursor-grab select-none items-center gap-1 rounded px-1 py-0.5 hover:bg-ink-850">
                  <span className="text-ink-500" aria-hidden>⠿</span>
                  <span className="text-xs font-bold uppercase tracking-wide text-ink-200">{def?.label ?? r.slot}</span>
                </span>
                <span className="flex-1" />
                <button onClick={() => setRow(r.slot, { captain: !r.captain })} aria-pressed={r.captain} title={r.captain ? 'Captain (click to remove)' : 'Make captain'}
                  className={cx('h-7 rounded px-1.5 text-xs font-bold', r.captain ? 'bg-amber-500/25 text-amber-300' : 'text-ink-500 hover:bg-ink-800 hover:text-ink-100')}>C</button>
              </div>
              <div draggable={!!(r.firstName || r.lastName)}
                onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.slot); setDrag({ kind: 'sailor', slot: r.slot }); }}
                onDragEnd={() => { setDrag(null); setOver(null); }} title={r.firstName || r.lastName ? 'Drag onto another place to swap sailors' : undefined}
                className={cx('mb-1.5 flex items-center gap-2 rounded', (r.firstName || r.lastName) && 'cursor-grab hover:bg-ink-850')}>
                <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded bg-ink-900 text-[10px] text-ink-600">{photo ? <img src={photo} alt="" className="h-full w-full object-cover" /> : 'photo'}</span>
                <span className="min-w-0 truncate text-sm">{r.firstName || r.lastName ? <><b className="uppercase">{r.lastName}</b> {r.firstName}</> : <span className="text-ink-600">empty</span>}</span>
              </div>
              <select className="input mb-1 py-1 text-sm" value={r.sailorId ?? ''} aria-label={`${def?.label} sailor`}
                onChange={(e) => {
                  const s = byId.get(e.target.value);
                  setRow(r.slot, s ? { sailorId: s.id, firstName: s.firstName, lastName: s.lastName, number: r.number || s.defaultNumber, captain: s.isCaptain || r.captain }
                    : { sailorId: null, firstName: '', lastName: '', number: '', captain: false });
                }}>
                <option value="">— sailor —</option>
                {sailorList.map((s) => <option key={s.id} value={s.id}>{s.lastName.toUpperCase()} {s.firstName}{s.defaultPosition ? ` · ${s.defaultPosition}` : ''}</option>)}
              </select>
              <div className="grid grid-cols-[3.5rem_1fr_1fr] gap-1">
                <SaveInput value={r.number} onSave={(number) => setRow(r.slot, { number })} label="Number" placeholder="No." maxLength={10} className="text-center tabular-nums" />
                <SaveInput value={r.firstName} onSave={(firstName) => setRow(r.slot, { firstName })} label="Name" placeholder="Name" maxLength={80} />
                <SaveInput value={r.lastName} onSave={(lastName) => setRow(r.slot, { lastName })} label="Surname" placeholder="SURNAME" maxLength={80} className="uppercase" />
              </div>
              <SaveInput value={r.position} onSave={(position) => setRow(r.slot, { position })} label="Position shown" placeholder={def?.position || 'POSITION'} maxLength={40} className="mt-1 text-xs uppercase text-ink-300" />
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-ink-800 px-3 py-2 text-xs text-ink-500">
        <span>{l.data.rows.length} places ({9} in the template{l.data.extra ? `, ${l.data.extra} extra named Sailor10…` : ''}).</span>
        <Button size="sm" variant="ghost" disabled={l.data.extra >= MAX_EXTRA} onClick={() => put({ extra: l.data.extra + 1 })}>+ Place</Button>
        <Button size="sm" variant="ghost" disabled={!l.data.extra} onClick={() => put({ extra: l.data.extra - 1 })}>− Place</Button>
      </div>
      {dialog}
    </section>
  );
}
