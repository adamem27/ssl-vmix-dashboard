import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { api, EventInfo, ImportSummary, RunOutcome, SettingsInfo, SyncRun, SyncStatus } from '../api';
import { Badge, Button, cx, ErrorBox, Field, fmtDateTime, Loading, Modal, useConfirm, useToast } from '../components/ui';

const TIMEZONES = ['Europe/Warsaw', 'Europe/London', 'Europe/Lisbon', 'Europe/Madrid', 'Europe/Paris', 'Europe/Berlin', 'Europe/Rome', 'Europe/Athens', 'Europe/Helsinki', 'Atlantic/Canary', 'UTC'];

function Section({ id, title, children, desc }: { id: string; title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="card scroll-mt-20 p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      {desc && <div className="mt-1 text-sm text-ink-400">{desc}</div>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function SettingsPage() {
  const loc = useLocation();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsInfo>('/api/settings') });
  useEffect(() => {
    if (loc.hash && q.data) setTimeout(() => document.getElementById(loc.hash.slice(1))?.scrollIntoView({ behavior: 'smooth' }), 50);
  }, [loc.hash, q.data]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Ustawienia</h1>
      <nav className="flex flex-wrap gap-2 text-xs">
        {[['event', 'Wydarzenie'], ['sync', 'Synchronizacja deklaracji'], ['paths', 'Pliki i ścieżki vMix'], ['demo', 'Dane demo'], ['backup', 'Kopia zapasowa']].map(([id, l]) => (
          <a key={id} href={`#${id}`} className="rounded-md border border-ink-700 px-2.5 py-1 text-ink-300 hover:bg-ink-800">{l}</a>
        ))}
      </nav>
      <EventSection event={q.data!.event} />
      <SyncSection />
      <PathsSection info={q.data!} />
      <DemoSection hasDemo={q.data!.hasDemo} />
      <BackupSection info={q.data!} />
    </div>
  );
}

function EventSection({ event }: { event: EventInfo }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState(event);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(event), [event]);
  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { await api.put('/api/settings/event', { name: f.name, timezone: f.timezone, year: Number(f.year) }); toast.ok('Zapisano ustawienia wydarzenia'); qc.invalidateQueries({ queryKey: ['meta'] }); qc.invalidateQueries({ queryKey: ['settings'] }); }
    catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <Section id="event" title="Wydarzenie" desc="Jedno aktywne wydarzenie. Rok uzupełnia daty publikowane przez organizatora bez roku (np. „11-06”).">
      <form onSubmit={save} className="grid gap-3 md:grid-cols-[1fr_240px_120px_auto] md:items-end">
        <Field label="Nazwa"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        <Field label="Strefa czasowa wydarzenia">
          <input className="input" list="tz-list" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} required />
          <datalist id="tz-list">{TIMEZONES.map((t) => <option key={t} value={t} />)}</datalist>
        </Field>
        <Field label="Rok"><input className="input tabular-nums" type="number" min={2000} max={2100} value={f.year} onChange={(e) => setF({ ...f, year: Number(e.target.value) })} required /></Field>
        <Button type="submit" variant="primary" busy={busy}>Zapisz</Button>
      </form>
    </Section>
  );
}

function SyncSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const s = useQuery({ queryKey: ['sync-status'], queryFn: () => api.get<SyncStatus>('/api/sync/status'), refetchInterval: 10_000 });
  const runs = useQuery({ queryKey: ['sync-runs'], queryFn: () => api.get<SyncRun[]>('/api/sync/runs'), refetchInterval: 15_000 });
  const tz = useQuery({ queryKey: ['meta'], queryFn: () => api.get<{ event: EventInfo }>('/api/meta') }).data?.event.timezone;
  const [f, setF] = useState<{ url: string; enabled: boolean; intervalMinutes: number; importer: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [shown, setShown] = useState<SyncRun | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (s.data && !f) setF({ url: s.data.url, enabled: s.data.enabled, intervalMinutes: s.data.intervalMinutes, importer: s.data.importer }); }, [s.data, f]);

  const afterRun = (r: { outcome: RunOutcome; status: SyncStatus }) => {
    qc.setQueryData(['sync-status'], r.status);
    qc.invalidateQueries({ queryKey: ['sync-runs'] });
    ['decl-overview', 'decl', 'decl-dates', 'decl-unmatched'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    if (r.outcome.status === 'success') toast.ok('Import zakończony. Szczegóły w historii poniżej.');
    else if (r.outcome.status === 'already_running') toast.info('Synchronizacja już trwa.');
    else toast.error(r.outcome.error ?? 'Błąd synchronizacji');
    if (r.status.lastRun) setShown(r.status.lastRun);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault(); if (!f) return; setBusy('save');
    try { const st = await api.put<SyncStatus>('/api/sync/config', f); qc.setQueryData(['sync-status'], st); toast.ok('Zapisano ustawienia synchronizacji'); }
    catch (err) { toast.error(err); } finally { setBusy(null); }
  };
  const run = async () => { setBusy('run'); try { afterRun(await api.post('/api/sync/run')); } catch (e) { toast.error(e); } finally { setBusy(null); } };
  const upload = async (file: File) => { setBusy('upload'); try { afterRun(await api.upload('/api/sync/upload', file)); } catch (e) { toast.error(e); } finally { setBusy(null); } };

  if (s.isLoading || !f) return <Section id="sync" title="Synchronizacja deklaracji"><Loading /></Section>;
  if (s.error) return <Section id="sync" title="Synchronizacja deklaracji"><ErrorBox error={s.error} /></Section>;
  const st = s.data!;
  const imp = st.importers.find((i) => i.id === f.importer);
  const dirty = f.url !== st.url || f.enabled !== st.enabled || f.intervalMinutes !== st.intervalMinutes || f.importer !== st.importer;

  return (
    <Section id="sync" title="Synchronizacja deklaracji" desc={<>
      Pobieranie działa w backendzie dashboardu, także po zamknięciu karty przeglądarki, ale <b className="text-ink-200">tylko gdy serwer jest uruchomiony</b> (działa od {fmtDateTime(st.backendStartedAt, tz)}). Gdy komputer lub serwer jest wyłączony, nic nie jest pobierane. Zadania nie są uruchamiane równolegle.
    </>}>
      <div className="grid gap-5 xl:grid-cols-2">
        <form onSubmit={save} className="space-y-3">
          <Field label="URL źródła"><input className="input font-mono text-xs" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://…" /></Field>
          <Field label="Importer" hint={imp?.description}>
            <select className="input" value={f.importer} onChange={(e) => setF({ ...f, importer: e.target.value })}>
              {st.importers.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
            </select>
          </Field>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-sky-500" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
              Automatyczna synchronizacja
            </label>
            <Field label="Interwał (min)"><input className="input w-28 tabular-nums" type="number" min={5} max={1440} value={f.intervalMinutes} onChange={(e) => setF({ ...f, intervalMinutes: Number(e.target.value) })} /></Field>
            <Button type="submit" variant="primary" busy={busy === 'save'} disabled={!dirty}>Zapisz ustawienia</Button>
          </div>
        </form>

        <div className="rounded-lg border border-ink-800 bg-ink-950/50 p-4">
          <dl className="grid grid-cols-[180px_1fr] gap-y-1.5 text-sm">
            <dt className="text-ink-400">Status</dt>
            <dd>{st.running ? <Badge tone="info">Pobieranie trwa…</Badge> : !st.lastRun ? <Badge>Jeszcze nie pobierano</Badge>
              : st.lastRun.status === 'success' ? <Badge tone="ok">OK</Badge> : st.lastRun.status === 'error' ? <Badge tone="error">Błąd</Badge> : <Badge>{st.lastRun.status}</Badge>}
              {' '}{st.enabled ? <Badge tone="ok">Auto: włączone</Badge> : <Badge>Auto: wyłączone</Badge>}</dd>
            <dt className="text-ink-400">Ostatnia próba</dt><dd>{fmtDateTime(st.lastAttemptAt, tz)}</dd>
            <dt className="text-ink-400">Ostatnie udane pobranie</dt><dd>{fmtDateTime(st.lastSuccessAt, tz)}</dd>
            <dt className="text-ink-400">Następna próba</dt><dd>{st.nextRunAt ? fmtDateTime(st.nextRunAt, tz) : 'nie zaplanowano (synchronizacja wyłączona)'}</dd>
          </dl>
          {st.lastRun?.status === 'error' && <div role="alert" className="mt-3 rounded-md border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200"><b>Opis błędu:</b> {st.lastRun.error}<br /><span className="text-xs text-red-300/80">Ostatnie poprawne dane pozostały bez zmian.</span></div>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" busy={busy === 'run' || st.running} onClick={run}>Pobierz teraz</Button>
            <Button busy={busy === 'upload'} onClick={() => fileRef.current?.click()} title="Gdy serwer nie ma dostępu do strony: zapisz ją w przeglądarce (Ctrl+S) i zaimportuj plik.">Importuj zapisany plik HTML</Button>
            <input ref={fileRef} type="file" accept=".html,.htm,text/html" className="hidden" onChange={(e) => { const x = e.target.files?.[0]; e.target.value = ''; if (x) void upload(x); }} />
          </div>
        </div>
      </div>

      <details className="mt-4 rounded-lg border border-ink-800 p-3 text-sm text-ink-400">
        <summary className="cursor-pointer text-ink-200">Jak działa importer SSL i czego wymaga</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Źródło sprawdzone (archiwum qualify3, czerwiec 2026): dane są w tabeli HTML (Joomla/Fabrik). Strona nie używa osobnego API ani plików PDF.</li>
          <li>Kolumny rozpoznawane po nagłówkach: <i>Country</i>, <i>Sailing Date</i>, <i>Crews</i>, <i>Posted</i>. Załoga w formacie „Imię Nazwisko (W:waga) (J-numer) --&gt;Pozycja”. Wagi są pomijane.</li>
          <li>Data deklaracji to <i>Sailing Date</i> (dzień regat) uzupełniona o rok wydarzenia, nigdy data pobrania.</li>
          <li>Drużyny dopasowywane po kodzie (np. AUT), nazwie lub aliasach. Nieznane kody trafiają do ostrzeżeń, nie są tworzone automatycznie.</li>
          <li>Jeśli organizator zmieni układ strony lub użyje innego systemu, potrzebny będzie nowy moduł w <code>server/src/importers/</code>.</li>
        </ul>
      </details>

      <h3 className="mb-2 mt-5 text-sm font-semibold uppercase tracking-wide text-ink-400">Historia synchronizacji</h3>
      {!runs.data?.length ? <p className="text-sm text-ink-500">Brak wpisów.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs uppercase text-ink-500"><tr><th className="py-1">Start</th><th>Tryb</th><th>Status</th><th>Wynik</th><th /></tr></thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id} className="border-t border-ink-800">
                  <td className="py-1.5 tabular-nums">{fmtDateTime(r.startedAt, tz)}</td>
                  <td>{r.trigger === 'auto' ? 'automatycznie' : r.trigger === 'manual' ? 'ręcznie' : 'plik'}</td>
                  <td>{r.status === 'success' ? <Badge tone="ok">OK</Badge> : r.status === 'error' ? <Badge tone="error">Błąd</Badge> : <Badge tone="info">Trwa</Badge>}</td>
                  <td className="max-w-[420px] truncate text-ink-400" title={r.error ?? ''}>
                    {r.summary ? `+${r.summary.declarationsAdded} dekl., ${r.summary.declarationsUpdated} zmian., +${r.summary.membersAdded}/~${r.summary.membersChanged}/−${r.summary.membersRemoved} os., ${r.summary.conflicts.length} konfl., ${r.summary.warnings.length} ostrz.` : r.error}
                  </td>
                  <td className="text-right"><Button size="sm" variant="ghost" onClick={() => setShown(r)}>Szczegóły</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={!!shown} onClose={() => setShown(null)} title="Szczegóły synchronizacji" wide>
        {shown && (
          <div className="space-y-3 text-sm">
            <p className="text-ink-400">{fmtDateTime(shown.startedAt, tz)} · {shown.sourceUrl}</p>
            {shown.error && <ErrorBox error={shown.error} />}
            {shown.summary && <SyncSummaryView s={shown.summary} />}
          </div>
        )}
      </Modal>
    </Section>
  );
}

export function SyncSummaryView({ s }: { s: ImportSummary }) {
  const stat = (label: string, n: number, tone?: string) => (
    <div className="rounded-lg border border-ink-800 bg-ink-950/60 p-3">
      <p className={cx('text-2xl font-bold tabular-nums', tone)}>{n}</p>
      <p className="text-xs text-ink-400">{label}</p>
    </div>
  );
  return (
    <div className="space-y-4 text-sm">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {stat('deklaracji w źródle', s.declarationsInSource)}
        {stat('nowych deklaracji', s.declarationsAdded, 'text-emerald-300')}
        {stat('zmienionych deklaracji', s.declarationsUpdated, 'text-sky-300')}
        {stat('bez zmian', s.declarationsUnchanged)}
        {stat('dodanych osób', s.membersAdded, 'text-emerald-300')}
        {stat('zmienionych osób', s.membersChanged, 'text-sky-300')}
        {stat('usuniętych osób', s.membersRemoved)}
        {stat('nierozpoznanych osób', s.membersUnmatched, s.membersUnmatched ? 'text-amber-300' : undefined)}
      </div>
      {!!s.conflicts.length && (
        <div>
          <h4 className="mb-1 font-semibold text-sky-300">Konflikty: ręczna korekta zachowana ({s.conflicts.length})</h4>
          <ul className="space-y-0.5 text-ink-300">
            {s.conflicts.map((c, i) => <li key={i}>{c.team} {c.date} · {c.name}: {c.field === 'position' ? 'pozycja' : 'numer'} ręcznie „{c.manual}”, źródło „{c.source}”</li>)}
          </ul>
        </div>
      )}
      {!!s.warnings.length && (
        <div>
          <h4 className="mb-1 font-semibold text-amber-300">Ostrzeżenia ({s.warnings.length})</h4>
          <ul className="list-disc space-y-0.5 pl-5 text-ink-300">{s.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function PathsSection({ info }: { info: SettingsInfo }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [root, setRoot] = useState(info.paths.vmixAssetsRoot);
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { await api.put('/api/settings/paths', { vmixAssetsRoot: root }); toast.ok('Zapisano mapowanie ścieżek'); qc.invalidateQueries(); }
    catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const Row = ({ label, value }: { label: string; value: string | null }) => (
    <div className="grid grid-cols-[200px_1fr] gap-2 py-1"><span className="text-ink-400">{label}</span><code className="break-all text-ink-200">{value ?? '—'}</code></div>
  );
  return (
    <Section id="paths" title="Pliki i ścieżki vMix" desc="Aplikacja rozróżnia: plik zapisany przez aplikację, adres podglądu w przeglądarce oraz ścieżkę, której użyje komputer z vMix (Windows).">
      <div className="text-sm">
        <Row label="Baza danych (SQLite)" value={info.paths.dbPath} />
        <Row label="Katalog przesłanych plików" value={info.paths.assetsDir} />
        <p className="mt-1 text-xs text-ink-500">Lokalizację zmienisz zmiennymi środowiskowymi <code>DATA_DIR</code>, <code>DB_PATH</code>, <code>ASSETS_DIR</code> przed uruchomieniem serwera (patrz README).</p>
      </div>
      <form onSubmit={save} className="mt-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
        <Field label="Katalog zasobów widziany przez komputer vMix (opcjonalnie)"
          hint={<>Jak komputer z vMix widzi katalog przesłanych plików, np. <code>\\DASHBOARD-PC\ssl-assets</code> (udział sieciowy) albo <code>Z:\ssl-assets</code>. Na tej podstawie dashboard tworzy ścieżki vMix dla przesłanych plików. Dostępność na komputerze vMix nie jest sprawdzana.</>}>
          <input className="input font-mono text-xs" value={root} onChange={(e) => setRoot(e.target.value)} placeholder="\\DASHBOARD-PC\ssl-assets" />
        </Field>
        <Button type="submit" variant="primary" busy={busy} disabled={root === info.paths.vmixAssetsRoot}>Zapisz</Button>
      </form>
      <div className="mt-4 grid gap-2 text-xs text-ink-400 md:grid-cols-3">
        <div className="rounded-md border border-ink-800 p-3"><Badge tone="ok">Plik zapisany</Badge><p className="mt-1">Plik przesłany do aplikacji, przechowywany pod unikalną nazwą w katalogu zasobów.</p></div>
        <div className="rounded-md border border-ink-800 p-3"><Badge tone="info">Ścieżka dostępna</Badge><p className="mt-1">Wpisana ścieżka jest czytelna dla serwera dashboardu (podgląd działa). Nie oznacza weryfikacji na komputerze vMix.</p></div>
        <div className="rounded-md border border-ink-800 p-3"><Badge tone="warn">Ścieżka niezweryfikowana</Badge><p className="mt-1">Ścieżka zapisana, ale serwer dashboardu nie ma do niej dostępu, więc podgląd jest niedostępny.</p></div>
      </div>
    </Section>
  );
}

function DemoSection({ hasDemo }: { hasDemo: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const call = async (key: string, url: string, msg: string) => {
    setBusy(key);
    try { const r = await api.post<any>(url); qc.invalidateQueries(); if (r?.outcome?.status === 'error') toast.error(r.outcome.error); else toast.ok(msg); }
    catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  return (
    <Section id="demo" title="Dane demonstracyjne" desc="Niewielki, wyraźnie oznaczony zestaw DEMO do sprawdzenia układu: 8 drużyn z kodami DMA–DMH, wygenerowane grafiki zastępcze, zawodnicy „Demo …” i jeden zestaw flot. To nie są prawdziwe drużyny, osoby ani wyniki.">
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" busy={busy === 'seed'} disabled={hasDemo} onClick={() => call('seed', '/api/demo/seed', 'Dodano dane DEMO')}>Załaduj dane demo</Button>
        <Button busy={busy === 'imp'} disabled={!hasDemo} onClick={() => call('imp', '/api/sync/demo-import', 'Zaimportowano testową stronę deklaracji (DEMO)')}>Importuj testową stronę deklaracji (DEMO)</Button>
        <Button variant="danger" busy={busy === 'rm'} disabled={!hasDemo} onClick={async () => {
          if (await ask('Usunąć dane demo?', 'Zostaną usunięte wszystkie drużyny i zawodnicy oznaczeni jako DEMO, ich grafiki, deklaracje oraz zestaw flot demo. Twoje dane nie zostaną zmienione.', 'Usuń dane demo')) await call('rm', '/api/demo/remove', 'Usunięto dane DEMO');
        }}>Usuń dane demo</Button>
      </div>
      <p className="mt-2 text-xs text-ink-500">Testowa strona deklaracji ma strukturę strony SSL, ale zawiera wyłącznie drużyny DEMO, jedną nieznaną drużynę i jedną nieznaną osobę, aby pokazać ostrzeżenia i ręczne przypisanie.</p>
      {dialog}
    </Section>
  );
}

function BackupSection({ info }: { info: SettingsInfo }) {
  return (
    <Section id="backup" title="Kopia zapasowa" desc="Dane to jeden plik SQLite i katalog przesłanych plików.">
      <div className="space-y-2 text-sm text-ink-300">
        <p><b>Wykonanie kopii</b> (można przy działającym serwerze):</p>
        <pre className="overflow-x-auto rounded-md bg-ink-950 p-3 text-xs text-ink-200">npm run backup{'\n'}npm run backup -- D:\Kopie\SSL</pre>
        <p><b>Przywrócenie</b> (najpierw zatrzymaj serwer):</p>
        <pre className="overflow-x-auto rounded-md bg-ink-950 p-3 text-xs text-ink-200">npm run restore -- backups\2026-06-11-08-30-00</pre>
        <p className="text-xs text-ink-500">Bieżące dane przed przywróceniem są zachowywane z sufiksem <code>.before-restore-…</code>. Baza: <code>{info.paths.dbPath}</code>, pliki: <code>{info.paths.assetsDir}</code>.</p>
      </div>
    </Section>
  );
}
