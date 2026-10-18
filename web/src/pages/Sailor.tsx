import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, SailorDetail, Team } from '../api';
import { AssetSlot } from '../components/AssetSlot';
import { SailorFields, sailorToForm } from '../components/SailorForm';
import { Badge, Button, ErrorBox, fmtDate, Loading, useConfirm, useToast } from '../components/ui';

export function SailorPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const { ask, dialog } = useConfirm();
  const q = useQuery({ queryKey: ['sailor', id], queryFn: () => api.get<SailorDetail>(`/api/sailors/${id}`) });
  const team = useQuery({ queryKey: ['team', q.data?.teamId], queryFn: () => api.get<Team>(`/api/teams/${q.data!.teamId}`), enabled: !!q.data });
  const [form, setForm] = useState(sailorToForm(null));
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) setForm(sailorToForm(q.data)); }, [q.data]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data!;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['sailor', id] }); qc.invalidateQueries({ queryKey: ['sailors', s.teamId] }); };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { await api.patch(`/api/sailors/${id}`, form); toast.ok('Sailor profile saved'); refresh(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!(await ask('Delete sailor?', <>The profile of <b>{s.firstName} {s.lastName}</b> and the photo will be deleted. Entries in past declarations remain but lose the link to the profile.</>, 'Delete sailor'))) return;
    try { await api.del(`/api/sailors/${id}`); toast.ok('Sailor deleted'); qc.invalidateQueries(); nav(`/vmix/teams/${s.teamId}`); } catch (err) { toast.error(err); }
  };

  return (
    <div className="space-y-6">
      <div>
        <Link to={`/vmix/teams/${s.teamId}`} className="text-xs text-ink-400 hover:text-ink-100">← {team.data?.name ?? 'Team'}</Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{s.firstName} <span className="uppercase">{s.lastName}</span></h1>
          {team.data && <span className="rounded bg-ink-800 px-2 py-0.5 font-mono text-sm">{team.data.code}</span>}
          {s.isDemo && <Badge tone="demo">Demo</Badge>}
          <Button variant="danger" className="ml-auto" onClick={del}>Delete sailor</Button>
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        <AssetSlot ownerKind="sailors" ownerId={s.id} slot={{ key: 'photo', label: 'Photo' }} asset={s.photo} bg="dark" accept="png+jpg" aspect="aspect-[4/5]" onChanged={refresh} />
        <form onSubmit={save} className="card space-y-4 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-400">Profile</h2>
          <SailorFields value={form} onChange={setForm} />
          <p className="text-xs text-ink-500">Position and number in the profile are defaults. Values for a specific day are stored in that day's declaration, so changing them never alters history.</p>
          <div className="flex justify-end"><Button type="submit" variant="primary" busy={busy}>Save profile</Button></div>
        </form>
      </div>
      <section className="card overflow-hidden">
        <h2 className="border-b border-ink-800 px-4 py-3 text-sm font-semibold uppercase tracking-wide text-ink-400">Crew history</h2>
        {!s.history.length ? <p className="p-4 text-sm text-ink-500">This sailor is not in any declaration yet.</p> : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-ink-500"><tr><th className="px-4 py-2">Day</th><th>Position</th><th>Number</th><th>Origin</th><th /></tr></thead>
            <tbody>
              {s.history.map((h) => (
                <tr key={h.memberId} className="border-t border-ink-800">
                  <td className="px-4 py-2">{fmtDate(h.date)}</td>
                  <td>{h.position || '—'}</td>
                  <td className="tabular-nums">{h.number || '—'}</td>
                  <td>{h.hasOverride ? <Badge tone="info">Manual correction</Badge> : <Badge>{h.origin === 'import' ? 'Import' : 'Manual'}</Badge>}</td>
                  <td className="pr-4 text-right"><Link className="text-xs text-accent-300 hover:underline" to={`/vmix/declarations?date=${h.date}&team=${h.teamId}`}>Open declaration →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {dialog}
    </div>
  );
}
