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
    try { await api.patch(`/api/sailors/${id}`, form); toast.ok('Zapisano profil zawodnika'); refresh(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!(await ask('Usunąć zawodnika?', <>Profil <b>{s.firstName} {s.lastName}</b> i jego zdjęcie zostaną usunięte. Wpisy w historycznych deklaracjach pozostaną, ale stracą powiązanie z profilem.</>, 'Usuń zawodnika'))) return;
    try { await api.del(`/api/sailors/${id}`); toast.ok('Usunięto zawodnika'); qc.invalidateQueries(); nav(`/vmix/teams/${s.teamId}`); } catch (err) { toast.error(err); }
  };

  return (
    <div className="space-y-6">
      <div>
        <Link to={`/vmix/teams/${s.teamId}`} className="text-xs text-ink-400 hover:text-ink-100">← {team.data?.name ?? 'Drużyna'}</Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{s.firstName} <span className="uppercase">{s.lastName}</span></h1>
          {team.data && <span className="rounded bg-ink-800 px-2 py-0.5 font-mono text-sm">{team.data.code}</span>}
          {s.isDemo && <Badge tone="demo">Demo</Badge>}
          <Button variant="danger" className="ml-auto" onClick={del}>Usuń zawodnika</Button>
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        <AssetSlot ownerKind="sailors" ownerId={s.id} slot={{ key: 'photo', label: 'Photo' }} asset={s.photo} bg="dark" accept="png+jpg" aspect="aspect-[4/5]" onChanged={refresh} />
        <form onSubmit={save} className="card space-y-4 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-400">Profil</h2>
          <SailorFields value={form} onChange={setForm} />
          <p className="text-xs text-ink-500">Pozycja i numer w profilu są wartościami domyślnymi. Wartości z konkretnego dnia zapisuje deklaracja i ich zmiana nie wpływa na historię.</p>
          <div className="flex justify-end"><Button type="submit" variant="primary" busy={busy}>Zapisz profil</Button></div>
        </form>
      </div>
      <section className="card overflow-hidden">
        <h2 className="border-b border-ink-800 px-4 py-3 text-sm font-semibold uppercase tracking-wide text-ink-400">Historia składów</h2>
        {!s.history.length ? <p className="p-4 text-sm text-ink-500">Zawodnik nie występuje jeszcze w żadnej deklaracji.</p> : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-ink-500"><tr><th className="px-4 py-2">Dzień</th><th>Pozycja</th><th>Numer</th><th>Pochodzenie</th><th /></tr></thead>
            <tbody>
              {s.history.map((h) => (
                <tr key={h.memberId} className="border-t border-ink-800">
                  <td className="px-4 py-2">{fmtDate(h.date)}</td>
                  <td>{h.position || '—'}</td>
                  <td className="tabular-nums">{h.number || '—'}</td>
                  <td>{h.hasOverride ? <Badge tone="info">Ręczna korekta</Badge> : <Badge>{h.origin === 'import' ? 'Import' : 'Ręcznie'}</Badge>}</td>
                  <td className="pr-4 text-right"><Link className="text-xs text-accent-300 hover:underline" to={`/vmix/declarations?date=${h.date}&team=${h.teamId}`}>Otwórz deklarację →</Link></td>
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
