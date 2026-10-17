import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Sailor, Team } from '../api';
import { useMeta } from '../App';
import { AssetSlot, BgToggle, PreviewBg } from '../components/AssetSlot';
import { TeamFormModal } from '../components/TeamForm';
import { SailorFormModal } from '../components/SailorForm';
import { Badge, Button, Empty, ErrorBox, Loading, useConfirm, useToast } from '../components/ui';

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
    if (!(await ask('Usunąć drużynę?', <>Drużyna <b>{t.name}</b> zostanie usunięta razem z {t.sailorCount} zawodnikami, przypisanymi grafikami, deklaracjami i miejscami we flotach. Tej operacji nie można cofnąć (poza przywróceniem kopii zapasowej).</>, 'Usuń drużynę'))) return;
    try { await api.del(`/api/teams/${t.id}`); toast.ok(`Usunięto drużynę ${t.name}`); qc.invalidateQueries(); nav('/vmix/teams'); } catch (e) { toast.error(e); }
  };

  return (
    <div className="space-y-6">
      <div>
        <Link to="/vmix/teams" className="text-xs text-ink-400 hover:text-ink-100">← Drużyny</Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{t.name}</h1>
          <span className="rounded bg-ink-800 px-2 py-0.5 font-mono text-sm text-ink-200">{t.code}</span>
          {t.isDemo && <Badge tone="demo">Demo</Badge>}
          <Badge tone={t.assetsFilled === t.assetsTotal ? 'ok' : 'warn'}>Zasoby {t.assetsFilled}/{t.assetsTotal}</Badge>
          <div className="ml-auto flex gap-2">
            <Button onClick={() => setEditing(true)}>Edytuj dane</Button>
            <Button variant="danger" onClick={del}>Usuń</Button>
          </div>
        </div>
        <p className="mt-1 text-sm text-ink-400">
          Aliasy: {t.aliases.length ? t.aliases.map((a) => <span key={a} className="mr-1 rounded bg-ink-850 px-1.5 py-0.5 text-ink-300">{a}</span>) : <span className="text-ink-500">brak</span>}
          {t.notes && <span className="ml-3 text-ink-500">· {t.notes}</span>}
        </p>
      </div>

      <section aria-labelledby="assets-h">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 id="assets-h" className="text-lg font-semibold">Zasoby graficzne</h2>
          <span className="text-xs text-ink-500">PNG · przeciągnij plik na slot, wybierz plik lub wpisz ścieżkę</span>
          <div className="ml-auto"><BgToggle value={bg} onChange={setBg} /></div>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          {(meta.data?.teamSlots ?? []).map((s) => (
            <AssetSlot key={s.key} ownerKind="teams" ownerId={t.id} slot={s} asset={t.assets[s.key]} bg={bg} onChanged={refresh} />
          ))}
        </div>
      </section>

      <section aria-labelledby="sailors-h">
        <div className="mb-3 flex items-center gap-3">
          <h2 id="sailors-h" className="text-lg font-semibold">Zawodnicy</h2>
          <span className="text-xs text-ink-500">{sailors.data?.length ?? 0} w bazie (oczekiwana liczebność ok. 11)</span>
          <Button className="ml-auto" variant="primary" onClick={() => setSailorModal({ open: true, sailor: null })}>+ Dodaj zawodnika</Button>
        </div>
        {sailors.isLoading ? <Loading /> : sailors.error ? <ErrorBox error={sailors.error} /> : !sailors.data!.length ? (
          <Empty title="Brak zawodników">Dodaj zawodników ręcznie albo utwórz ich z nierozpoznanych wpisów deklaracji.</Empty>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
            {sailors.data!.map((s) => (
              <li key={s.id} className="card group overflow-hidden">
                <button className="block w-full text-left" onClick={() => setSailorModal({ open: true, sailor: s })} aria-label={`Edytuj ${s.firstName} ${s.lastName}`}>
                  <div className="relative aspect-[4/5] bg-ink-950">
                    {s.photo?.previewUrl ? <img src={s.photo.previewUrl} alt="" className="h-full w-full object-cover" />
                      : <div className="flex h-full items-center justify-center text-xs text-ink-500">{s.photo ? 'Podgląd niedostępny' : 'Brak zdjęcia'}</div>}
                    {s.defaultNumber && <span className="absolute left-2 top-2 rounded bg-black/70 px-2 py-0.5 text-lg font-bold tabular-nums text-white">{s.defaultNumber}</span>}
                    {s.isDemo && <span className="absolute right-2 top-2"><Badge tone="demo">Demo</Badge></span>}
                  </div>
                  <div className="p-2.5">
                    <p className="truncate text-sm text-ink-300">{s.firstName}</p>
                    <p className="truncate font-semibold uppercase text-ink-50">{s.lastName || '—'}</p>
                    <p className="truncate text-xs text-ink-400">{s.defaultPosition || <span className="text-amber-400">brak pozycji</span>}</p>
                  </div>
                </button>
                <div className="border-t border-ink-800 px-2.5 py-1.5 text-right">
                  <Link to={`/vmix/sailors/${s.id}`} className="text-xs text-accent-300 hover:underline">Profil i historia →</Link>
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
