import { useEffect, useMemo, useState, KeyboardEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, DateOverviewRow, Declaration, FieldValue, Member, RunOutcome, Sailor, SyncStatus, Team } from '../api';
import { useMeta } from '../App';
import { SyncSummaryView } from './Settings';
import { Badge, Button, cx, Empty, ErrorBox, fmtDate, fmtDateTime, Loading, Modal, todayIn, useConfirm, useToast } from '../components/ui';

export function DeclarationsPage() {
  const meta = useMeta();
  const tz = meta.data?.event.timezone ?? 'Europe/Warsaw';
  const [params, setParams] = useSearchParams();
  const dates = useQuery({ queryKey: ['decl-dates'], queryFn: () => api.get<{ date: string; teams: number; imported: number }[]>('/api/declarations/dates') });
  const dateParam = params.get('date');
  const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : dates.data?.[0]?.date ?? todayIn(tz);
  const teamId = params.get('team');
  const setParam = (k: string, v: string | null) => { const p = new URLSearchParams(params); v ? p.set(k, v) : p.delete(k); if (k === 'date' && !p.has('date')) p.set('date', date); setParams(p, { replace: true }); };

  const overview = useQuery({ queryKey: ['decl-overview', date], queryFn: () => api.get<DateOverviewRow[]>(`/api/declarations/overview?date=${date}`), enabled: /^\d{4}-\d{2}-\d{2}$/.test(date) });
  const unmatched = useQuery({ queryKey: ['decl-unmatched'], queryFn: () => api.get<{ id: string; sourceName: string; matchStatus: string; date: string; teamId: string; code: string; name: string }[]>('/api/declarations/unmatched') });
  const [teamFilter, setTeamFilter] = useState('');
  const [showUnmatched, setShowUnmatched] = useState(false);

  useEffect(() => {
    if (!teamId && overview.data?.length) {
      const first = overview.data.find((r) => r.declarationId) ?? overview.data[0];
      const p = new URLSearchParams(params); p.set('team', first.teamId); if (!p.has('date')) p.set('date', date); setParams(p, { replace: true });
    }
  }, [teamId, overview.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = (overview.data ?? []).filter((r) => !teamFilter || `${r.code} ${r.name}`.toLowerCase().includes(teamFilter.toLowerCase()));
  const declaredCount = (overview.data ?? []).filter((r) => r.declarationId).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-bold">Deklaracje załóg</h1>
          <p className="text-sm text-ink-400">Skład każdej drużyny na konkretny dzień regat. Ręczne poprawki mają pierwszeństwo przed synchronizacją.</p>
        </div>
        <SyncMini />
      </div>

      <div className="card flex flex-wrap items-center gap-2 p-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-ink-400">Dzień regat</span>
          <input type="date" className="input w-44" value={date} onChange={(e) => e.target.value && setParam('date', e.target.value)} />
        </label>
        <Button size="sm" variant="ghost" onClick={() => setParam('date', todayIn(tz))}>Dziś ({tz})</Button>
        <div className="flex flex-wrap gap-1" aria-label="Dni z deklaracjami">
          {(dates.data ?? []).slice(0, 14).map((d) => (
            <button key={d.date} onClick={() => setParam('date', d.date)}
              className={cx('rounded-md border px-2 py-1 text-xs', d.date === date ? 'border-accent-500 bg-accent-500/15 text-accent-300' : 'border-ink-700 text-ink-300 hover:bg-ink-800')}>
              {d.date.slice(8, 10)}.{d.date.slice(5, 7)} <span className="text-ink-500">· {d.teams}</span>
            </button>
          ))}
        </div>
        {!!unmatched.data?.length && (
          <button onClick={() => setShowUnmatched(true)} className="ml-auto rounded-md border border-amber-800 bg-amber-950/40 px-3 py-1 text-xs font-semibold text-amber-300 hover:bg-amber-900/40">
            ⚠ {unmatched.data.length} nierozpoznanych wpisów
          </button>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <aside className="card h-fit overflow-hidden">
          <div className="border-b border-ink-800 p-3">
            <p className="text-sm font-semibold">{fmtDate(date)}</p>
            <p className="text-xs text-ink-400">{declaredCount} z {overview.data?.length ?? 0} drużyn ma skład</p>
            <input className="input mt-2" type="search" placeholder="Filtruj drużyny…" value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} aria-label="Filtruj drużyny" />
          </div>
          {overview.isLoading ? <Loading /> : overview.error ? <div className="p-3"><ErrorBox error={overview.error} /></div> : !overview.data?.length ? (
            <p className="p-4 text-sm text-ink-500">Brak drużyn w bazie. <Link className="text-accent-300" to="/vmix/teams">Dodaj drużyny</Link>.</p>
          ) : (
            <ul className="max-h-[65vh] overflow-auto">
              {rows.map((r) => (
                <li key={r.teamId}>
                  <button onClick={() => setParam('team', r.teamId)} aria-current={r.teamId === teamId}
                    className={cx('flex w-full items-center gap-2 border-b border-ink-850 px-3 py-2 text-left text-sm', r.teamId === teamId ? 'bg-ink-800' : 'hover:bg-ink-850')}>
                    <span className="w-10 shrink-0 font-mono text-xs text-ink-400">{r.code}</span>
                    <span className="min-w-0 flex-1 truncate">{r.name}</span>
                    {r.declarationId ? (
                      <>
                        {r.unmatched > 0 && <Badge tone="warn" title="Nierozpoznani zawodnicy">{r.unmatched}?</Badge>}
                        {r.overrides > 0 && <Badge tone="info" title="Ręczne korekty">✎{r.overrides}</Badge>}
                        <span className="tabular-nums text-xs text-ink-400">{r.members}</span>
                      </>
                    ) : <span className="text-xs text-ink-600">brak</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="min-w-0">
          {teamId ? <DeclarationPanel key={`${teamId}|${date}`} teamId={teamId} date={date} tz={tz} /> : <Empty title="Wybierz drużynę">Wybierz drużynę z listy, aby zobaczyć lub utworzyć jej skład na ten dzień.</Empty>}
        </section>
      </div>

      <Modal open={showUnmatched} onClose={() => setShowUnmatched(false)} title="Nierozpoznane wpisy z importu" wide>
        <p className="mb-3 text-sm text-ink-400">Te nazwiska ze źródła nie zostały automatycznie połączone z profilem (brak lub kilka pasujących osób). Otwórz deklarację, aby przypisać zawodnika lub utworzyć nowy profil.</p>
        <ul className="divide-y divide-ink-800 text-sm">
          {(unmatched.data ?? []).map((u) => (
            <li key={u.id} className="flex items-center gap-3 py-2">
              <span className="w-24 text-ink-400">{u.date}</span>
              <span className="w-12 font-mono text-xs">{u.code}</span>
              <span className="flex-1">{u.sourceName}</span>
              <Badge tone="warn">{u.matchStatus === 'ambiguous' ? 'Niejednoznaczny' : 'Nierozpoznany'}</Badge>
              <Button size="sm" onClick={() => { const p = new URLSearchParams(); p.set('date', u.date); p.set('team', u.teamId); setParams(p); setShowUnmatched(false); }}>Otwórz</Button>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}

function SyncMini() {
  const qc = useQueryClient();
  const toast = useToast();
  const meta = useMeta();
  const s = useQuery({ queryKey: ['sync-status'], queryFn: () => api.get<SyncStatus>('/api/sync/status'), refetchInterval: 15_000 });
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<RunOutcome | null>(null);
  const tz = meta.data?.event.timezone;
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ outcome: RunOutcome; status: SyncStatus }>('/api/sync/run');
      qc.setQueryData(['sync-status'], r.status);
      qc.invalidateQueries({ queryKey: ['decl-overview'] }); qc.invalidateQueries({ queryKey: ['decl'] }); qc.invalidateQueries({ queryKey: ['decl-dates'] }); qc.invalidateQueries({ queryKey: ['decl-unmatched'] });
      if (r.outcome.status === 'success') { toast.ok('Pobrano deklaracje'); setSummary(r.outcome); }
      else if (r.outcome.status === 'already_running') toast.info('Synchronizacja już trwa.');
      else toast.error(r.outcome.error ?? 'Błąd synchronizacji');
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  if (!s.data) return null;
  const last = s.data.lastRun;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-ink-800 bg-ink-900 px-3 py-2 text-xs">
      <div>
        <p>
          Synchronizacja: {s.data.enabled ? <span className="font-semibold text-emerald-300">włączona, co {s.data.intervalMinutes} min</span> : <span className="font-semibold text-ink-300">wyłączona</span>}
          {last?.status === 'error' && <span className="ml-2 font-semibold text-red-300" title={last.error ?? ''}>ostatnia próba: błąd</span>}
        </p>
        <p className="text-ink-400">Ostatnio pobrano: {fmtDateTime(s.data.lastSuccessAt, tz)}{s.data.nextRunAt && <> · następna: {fmtDateTime(s.data.nextRunAt, tz)}</>}</p>
      </div>
      <Button size="sm" variant="primary" busy={busy || s.data.running} onClick={run}>Pobierz teraz</Button>
      <Link to="/vmix/settings#sync" className="text-accent-300 hover:underline">Ustawienia</Link>
      <Modal open={!!summary} onClose={() => setSummary(null)} title="Podsumowanie synchronizacji" wide>
        {summary?.summary && <SyncSummaryView s={summary.summary} />}
      </Modal>
    </div>
  );
}

function DeclarationPanel({ teamId, date, tz }: { teamId: string; date: string; tz: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const team = useQuery({ queryKey: ['team', teamId], queryFn: () => api.get<Team>(`/api/teams/${teamId}`) });
  const sailors = useQuery({ queryKey: ['sailors', teamId], queryFn: () => api.get<Sailor[]>(`/api/teams/${teamId}/sailors`) });
  const q = useQuery({ queryKey: ['decl', teamId, date], queryFn: () => api.get<{ declaration: Declaration | null }>(`/api/declarations?teamId=${teamId}&date=${date}`) });
  const [busy, setBusy] = useState<string | null>(null);
  const [addId, setAddId] = useState('');
  const [notes, setNotes] = useState<string | null>(null);
  const decl = q.data?.declaration ?? null;

  const apply = (d: Declaration | null) => {
    qc.setQueryData(['decl', teamId, date], { declaration: d });
    qc.invalidateQueries({ queryKey: ['decl-overview', date] });
    qc.invalidateQueries({ queryKey: ['decl-dates'] });
    qc.invalidateQueries({ queryKey: ['decl-unmatched'] });
  };
  const act = async (key: string, fn: () => Promise<Declaration | null>, okMsg?: string) => {
    setBusy(key);
    try { const d = await fn(); apply(d); if (okMsg) toast.ok(okMsg); return true; } catch (e) { toast.error(e); return false; } finally { setBusy(null); }
  };

  const create = (prefill: 'empty' | 'previous' | 'roster') => act('create', () => api.post<Declaration>('/api/declarations', { teamId, date, prefill }), 'Utworzono deklarację');
  const inCrew = useMemo(() => new Set(decl?.members.map((m) => m.sailor?.id).filter(Boolean)), [decl]);
  const available = (sailors.data ?? []).filter((s) => !inCrew.has(s.id));

  if (q.isLoading || team.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const t = team.data!;

  const header = (
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <h2 className="text-xl font-bold">{t.name}</h2>
      <span className="rounded bg-ink-800 px-2 py-0.5 font-mono text-sm">{t.code}</span>
      {t.isDemo && <Badge tone="demo">Demo</Badge>}
      <span className="text-sm text-ink-400">{fmtDate(date)}</span>
      <Link to={`/vmix/teams/${t.id}`} className="ml-auto text-xs text-accent-300 hover:underline">Profil drużyny →</Link>
    </div>
  );

  if (!decl) {
    return (
      <div>
        {header}
        <Empty title="Brak deklaracji na ten dzień" action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="primary" busy={busy === 'create'} onClick={() => create('previous')}>Skopiuj ostatni skład</Button>
            <Button busy={busy === 'create'} onClick={() => create('roster')}>Wszyscy zawodnicy drużyny</Button>
            <Button busy={busy === 'create'} onClick={() => create('empty')}>Pusty skład</Button>
          </div>
        }>
          Skład może przyjść z synchronizacji albo możesz utworzyć go ręcznie. Ręcznie wpisane pozycje i numery nie zostaną nadpisane przez import.
        </Empty>
      </div>
    );
  }

  const del = async () => {
    if (!(await ask('Usunąć deklarację?', <>Skład <b>{t.name}</b> na {fmtDate(date)} zostanie usunięty wraz z ręcznymi poprawkami.{decl.origin === 'import' || decl.sourceFetchedAt ? ' Kolejna synchronizacja może utworzyć go ponownie z danych źródła.' : ''}</>, 'Usuń'))) return;
    await act('del', async () => { await api.del(`/api/declarations/${decl.id}`); return null; }, 'Usunięto deklarację');
  };

  const unresolved = decl.members.filter((m) => !m.sailor).length;

  return (
    <div>
      {header}
      <div className="card mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 text-xs text-ink-400">
        <span>Utworzono: <Badge tone={decl.origin === 'import' ? 'info' : 'neutral'}>{decl.origin === 'import' ? 'Import' : 'Ręcznie'}</Badge></span>
        <span>Ostatnie potwierdzenie ze źródła: <b className="text-ink-200">{fmtDateTime(decl.sourceFetchedAt, tz)}</b></span>
        {decl.sourcePostedRaw && <span>Opublikowano u organizatora: <b className="text-ink-200">{decl.sourcePostedRaw}</b></span>}
        {decl.sourceRef && <a href={decl.sourceRef} target="_blank" rel="noreferrer" className="text-accent-300 hover:underline">Źródło ↗</a>}
        <span>Zmieniono: {fmtDateTime(decl.updatedAt, tz)}</span>
        <Button size="sm" variant="danger" className="ml-auto" busy={busy === 'del'} onClick={del}>Usuń deklarację</Button>
      </div>
      {unresolved > 0 && (
        <div className="mb-3 rounded-lg border border-amber-900/60 bg-amber-950/30 px-4 py-2 text-sm text-amber-200">
          {unresolved} wpis(y) bez przypisanego profilu zawodnika. Przypisz istniejącego zawodnika albo utwórz nowy profil.
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="border-b border-ink-800 text-left text-xs uppercase tracking-wide text-ink-500">
            <tr><th className="w-14 px-2 py-2" /><th className="w-12" /><th className="w-28">Number</th><th>Zawodnik</th><th className="w-56">Position</th><th className="w-40 pr-3 text-right">Akcje</th></tr>
          </thead>
          <tbody>
            {decl.members.map((m, i) => (
              <MemberRow key={m.id} m={m} first={i === 0} last={i === decl.members.length - 1} sailors={sailors.data ?? []} act={act} />
            ))}
            {!decl.members.length && <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-500">Skład jest pusty. Dodaj zawodników poniżej.</td></tr>}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-2 border-t border-ink-800 p-3">
          <select className="input w-72" value={addId} onChange={(e) => setAddId(e.target.value)} aria-label="Zawodnik do dodania">
            <option value="">Dodaj zawodnika z bazy drużyny…</option>
            {available.map((s) => <option key={s.id} value={s.id}>{s.defaultNumber ? `#${s.defaultNumber} ` : ''}{s.firstName} {s.lastName}{s.defaultPosition ? ` – ${s.defaultPosition}` : ''}</option>)}
          </select>
          <Button disabled={!addId} busy={busy === 'add'} onClick={async () => { if (await act('add', () => api.post<Declaration>(`/api/declarations/${decl.id}/members`, { sailorId: addId }), 'Dodano do składu')) setAddId(''); }}>Dodaj</Button>
          <span className="text-xs text-ink-500">Brakuje kogoś? <Link className="text-accent-300" to={`/vmix/teams/${teamId}`}>Dodaj zawodnika w profilu drużyny</Link>.</span>
        </div>
      </div>

      <div className="mt-3">
        <label className="label" htmlFor="decl-notes">Notatki do deklaracji</label>
        <textarea id="decl-notes" className="input min-h-[60px]" value={notes ?? decl.notes} onChange={(e) => setNotes(e.target.value)}
          onBlur={() => { if (notes !== null && notes !== decl.notes) void act('notes', () => api.patch<Declaration>(`/api/declarations/${decl.id}`, { notes }), 'Zapisano notatki').then(() => setNotes(null)); }} />
      </div>
      {dialog}
    </div>
  );
}

type Act = (key: string, fn: () => Promise<Declaration | null>, okMsg?: string) => Promise<boolean>;

function MemberRow({ m, first, last, sailors, act }: { m: Member; first: boolean; last: boolean; sailors: Sailor[]; act: Act }) {
  const [assigning, setAssigning] = useState(false);
  const save = (field: 'position' | 'number', value: string) =>
    act(`f-${m.id}`, () => api.patch<Declaration>(`/api/declaration-members/${m.id}`, { [field]: value }), `Zapisano ręczną korektę (${field === 'position' ? 'pozycja' : 'numer'})`);
  const reset = (field: 'position' | 'number') =>
    act(`r-${m.id}`, () => api.post<Declaration>(`/api/declaration-members/${m.id}/reset`, { field }), 'Przywrócono wartość ze źródła');
  const name = m.sailor ? `${m.sailor.firstName} ${m.sailor.lastName}`.trim() : m.sourceName ?? '—';
  const nameDiffers = m.sailor && m.sourceName && m.sourceName.toLowerCase() !== name.toLowerCase();
  const canDelete = m.origin === 'manual' || !m.inSource;

  return (
    <tr className={cx('border-b border-ink-850 align-middle', !m.sailor && 'bg-amber-950/10', !m.inSource && 'opacity-70')}>
      <td className="px-2">
        <div className="flex flex-col">
          <button className="text-xs text-ink-500 hover:text-ink-100 disabled:opacity-20" disabled={first} aria-label="Przesuń w górę" onClick={() => act(`m-${m.id}`, () => api.post<Declaration>(`/api/declaration-members/${m.id}/move`, { direction: -1 }))}>▲</button>
          <button className="text-xs text-ink-500 hover:text-ink-100 disabled:opacity-20" disabled={last} aria-label="Przesuń w dół" onClick={() => act(`m-${m.id}`, () => api.post<Declaration>(`/api/declaration-members/${m.id}/move`, { direction: 1 }))}>▼</button>
        </div>
      </td>
      <td className="py-1.5">
        <div className="h-11 w-9 overflow-hidden rounded bg-ink-950">
          {m.sailor?.photo?.previewUrl && <img src={m.sailor.photo.previewUrl} alt="" className="h-full w-full object-cover" />}
        </div>
      </td>
      <td className="pr-2"><EditableField value={m.number} onSave={(v) => save('number', v)} onReset={() => reset('number')} canReset={m.hasSource} narrow label={`Numer: ${name}`} /></td>
      <td className="pr-2">
        <div className="flex flex-wrap items-center gap-2">
          {m.sailor ? <Link to={`/vmix/sailors/${m.sailor.id}`} className="font-semibold text-ink-50 hover:text-accent-300">{m.sailor.firstName} <span className="uppercase">{m.sailor.lastName}</span></Link>
            : <span className="font-semibold text-amber-200">{m.sourceName}</span>}
          {!m.sailor && <Badge tone="warn">{m.matchStatus === 'ambiguous' ? 'Niejednoznaczny' : 'Nierozpoznany'}</Badge>}
          {m.hasSource ? <Badge tone="info" title="Wiersz występuje w danych źródła">Źródło</Badge> : <Badge title="Dodany ręcznie">Ręcznie</Badge>}
          {!m.inSource && <Badge tone="error" title="Ostatni import nie zawierał tego wpisu; zachowano go, bo ma ręczne zmiany">Brak w źródle</Badge>}
        </div>
        {nameDiffers && <p className="text-xs text-ink-500">w źródle: „{m.sourceName}”</p>}
      </td>
      <td className="pr-2"><EditableField value={m.position} onSave={(v) => save('position', v)} onReset={() => reset('position')} canReset={m.hasSource} label={`Pozycja: ${name}`} /></td>
      <td className="pr-3 text-right">
        <div className="flex justify-end gap-1">
          {m.hasSource && <Button size="sm" variant="ghost" onClick={() => setAssigning(true)}>{m.sailor ? 'Zmień osobę' : 'Przypisz'}</Button>}
          {!m.sailor && m.sourceName && <Button size="sm" variant="ghost" onClick={() => act(`c-${m.id}`, () => api.post<Declaration>(`/api/declaration-members/${m.id}/create-sailor`), `Utworzono profil: ${m.sourceName}`)}>Nowy profil</Button>}
          {canDelete && <Button size="sm" variant="ghost" className="text-red-300" onClick={() => act(`d-${m.id}`, () => api.del<Declaration>(`/api/declaration-members/${m.id}`), 'Usunięto ze składu')}>Usuń</Button>}
        </div>
        <AssignModal open={assigning} onClose={() => setAssigning(false)} m={m} sailors={sailors} act={act} />
      </td>
    </tr>
  );
}

function EditableField({ value, onSave, onReset, canReset, narrow, label }: { value: FieldValue; onSave: (v: string) => Promise<boolean>; onReset: () => void; canReset: boolean; narrow?: boolean; label: string }) {
  const [v, setV] = useState(value.value);
  useEffect(() => setV(value.value), [value.value]);
  const commit = () => { if (v.trim() !== value.value) void onSave(v.trim()); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    if (e.key === 'Escape') { setV(value.value); (e.target as HTMLInputElement).blur(); }
  };
  const manual = value.origin === 'manual';
  return (
    <div className="flex items-center gap-1">
      <input value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={onKey} aria-label={label}
        className={cx('input py-1', narrow && 'w-16 text-center font-bold tabular-nums', manual && canReset && 'border-sky-700 bg-sky-950/30', !value.value && 'border-amber-800')} />
      {manual && canReset && (
        <button onClick={onReset} className="shrink-0 rounded px-1 text-xs text-sky-300 hover:bg-ink-800" title={`Ręczna korekta. Źródło: „${value.source ?? '—'}”. Kliknij, aby przywrócić wartość źródłową.`} aria-label="Przywróć wartość ze źródła">↺</button>
      )}
      {manual && canReset && value.source !== null && value.source !== value.value && <span className="hidden text-[11px] text-ink-500 xl:inline" title="Wartość ze źródła">({value.source || '—'})</span>}
    </div>
  );
}

function AssignModal({ open, onClose, m, sailors, act }: { open: boolean; onClose: () => void; m: Member; sailors: Sailor[]; act: Act }) {
  const [sel, setSel] = useState(m.sailor?.id ?? '');
  const [remember, setRemember] = useState(true);
  useEffect(() => { if (open) setSel(m.sailor?.id ?? ''); }, [open, m.sailor?.id]);
  return (
    <Modal open={open} onClose={onClose} title="Przypisz zawodnika">
      <div className="space-y-4 text-left text-sm">
        <p className="text-ink-300">Wpis ze źródła: <b>{m.sourceName}</b>{m.number.source ? ` · #${m.number.source}` : ''}{m.position.source ? ` · ${m.position.source}` : ''}</p>
        <select className="input" value={sel} onChange={(e) => setSel(e.target.value)} aria-label="Zawodnik">
          <option value="">— bez przypisania —</option>
          {sailors.map((s) => <option key={s.id} value={s.id}>{s.firstName} {s.lastName}{s.defaultNumber ? ` (#${s.defaultNumber})` : ''}</option>)}
        </select>
        <label className="flex items-center gap-2 text-ink-300">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Zapamiętaj ten zapis nazwiska dla kolejnych importów
        </label>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Anuluj</Button>
          <Button variant="primary" onClick={async () => { if (await act(`a-${m.id}`, () => api.post<Declaration>(`/api/declaration-members/${m.id}/assign`, { sailorId: sel || null, remember }), sel ? 'Przypisano zawodnika' : 'Usunięto przypisanie')) onClose(); }}>Zapisz</Button>
        </div>
      </div>
    </Modal>
  );
}
