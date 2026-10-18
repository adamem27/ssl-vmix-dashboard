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
      <h1 className="text-2xl font-bold">Settings</h1>
      <nav className="flex flex-wrap gap-2 text-xs">
        {[['event', 'Event'], ['presets', 'Matchboard'], ['sync', 'Declaration sync'], ['paths', 'Files & vMix paths'], ['demo', 'Demo data'], ['backup', 'Backup']].map(([id, l]) => (
          <a key={id} href={`#${id}`} className="rounded-md border border-ink-700 px-2.5 py-1 text-ink-300 hover:bg-ink-800">{l}</a>
        ))}
      </nav>
      <EventSection event={q.data!.event} />
      <PresetSection />
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
    try { await api.put('/api/settings/event', { name: f.name, timezone: f.timezone, year: Number(f.year) }); toast.ok('Event settings saved'); qc.invalidateQueries({ queryKey: ['meta'] }); qc.invalidateQueries({ queryKey: ['settings'] }); }
    catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <Section id="event" title="Event">
      <form onSubmit={save} className="grid gap-3 md:grid-cols-[1fr_240px_120px_auto] md:items-end">
        <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        <Field label="Event time zone">
          <input className="input" list="tz-list" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} required />
          <datalist id="tz-list">{TIMEZONES.map((t) => <option key={t} value={t} />)}</datalist>
        </Field>
        <Field label="Year"><input className="input tabular-nums" type="number" min={2000} max={2100} value={f.year} onChange={(e) => setF({ ...f, year: Number(e.target.value) })} required /></Field>
        <Button type="submit" variant="primary" busy={busy}>Save</Button>
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
    if (r.outcome.status === 'success') toast.ok('Import finished. Details in the history below.');
    else if (r.outcome.status === 'already_running') toast.info('A sync is already running.');
    else toast.error(r.outcome.error ?? 'Sync failed');
    if (r.status.lastRun) setShown(r.status.lastRun);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault(); if (!f) return; setBusy('save');
    try { const st = await api.put<SyncStatus>('/api/sync/config', f); qc.setQueryData(['sync-status'], st); toast.ok('Sync settings saved'); }
    catch (err) { toast.error(err); } finally { setBusy(null); }
  };
  const run = async () => { setBusy('run'); try { afterRun(await api.post('/api/sync/run')); } catch (e) { toast.error(e); } finally { setBusy(null); } };
  const upload = async (file: File) => { setBusy('upload'); try { afterRun(await api.upload('/api/sync/upload', file)); } catch (e) { toast.error(e); } finally { setBusy(null); } };

  if (s.isLoading || !f) return <Section id="sync" title="Declaration sync"><Loading /></Section>;
  if (s.error) return <Section id="sync" title="Declaration sync"><ErrorBox error={s.error} /></Section>;
  const st = s.data!;
  const imp = st.importers.find((i) => i.id === f.importer);
  const dirty = f.url !== st.url || f.enabled !== st.enabled || f.intervalMinutes !== st.intervalMinutes || f.importer !== st.importer;

  return (
    <Section id="sync" title="Declaration sync">
      <div className="grid gap-5 xl:grid-cols-2">
        <form onSubmit={save} className="space-y-3">
          <Field label="Source URL"><input className="input font-mono text-xs" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://…" /></Field>
          <Field label="Importer">
            <select className="input" value={f.importer} onChange={(e) => setF({ ...f, importer: e.target.value })}>
              {st.importers.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
            </select>
          </Field>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-sky-500" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
              Automatic sync
            </label>
            <Field label="Interval (min)"><input className="input w-28 tabular-nums" type="number" min={5} max={1440} value={f.intervalMinutes} onChange={(e) => setF({ ...f, intervalMinutes: Number(e.target.value) })} /></Field>
            <Button type="submit" variant="primary" busy={busy === 'save'} disabled={!dirty}>Save settings</Button>
          </div>
        </form>

        <div className="rounded-lg border border-ink-800 bg-ink-950/50 p-4">
          <dl className="grid grid-cols-[180px_1fr] gap-y-1.5 text-sm">
            <dt className="text-ink-400">Status</dt>
            <dd>{st.running ? <Badge tone="info">Fetching…</Badge> : !st.lastRun ? <Badge>Never fetched</Badge>
              : st.lastRun.status === 'success' ? <Badge tone="ok">OK</Badge> : st.lastRun.status === 'error' ? <Badge tone="error">Error</Badge> : <Badge>{st.lastRun.status}</Badge>}
              {' '}{st.enabled ? <Badge tone="ok">Auto: on</Badge> : <Badge>Auto: off</Badge>}</dd>
            <dt className="text-ink-400">Last attempt</dt><dd>{fmtDateTime(st.lastAttemptAt, tz)}</dd>
            <dt className="text-ink-400">Last successful fetch</dt><dd>{fmtDateTime(st.lastSuccessAt, tz)}</dd>
            <dt className="text-ink-400">Next attempt</dt><dd>{st.nextRunAt ? fmtDateTime(st.nextRunAt, tz) : 'not scheduled (sync is off)'}</dd>
          </dl>
          {st.lastRun?.status === 'error' && <div role="alert" className="mt-3 rounded-md border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200"><b>Error:</b> {st.lastRun.error}<br /><span className="text-xs text-red-300/80">The last good data was left unchanged.</span></div>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" busy={busy === 'run' || st.running} onClick={run}>Fetch now</Button>
            <Button busy={busy === 'upload'} onClick={() => fileRef.current?.click()} title="If the server cannot reach the page: save it in your browser (Ctrl+S / Cmd+S) and import the file.">Import saved HTML file</Button>
            <input ref={fileRef} type="file" accept=".html,.htm,text/html" className="hidden" onChange={(e) => { const x = e.target.files?.[0]; e.target.value = ''; if (x) void upload(x); }} />
          </div>
        </div>
      </div>


      <h3 className="mb-2 mt-5 text-sm font-semibold uppercase tracking-wide text-ink-400">Sync history</h3>
      {!runs.data?.length ? <p className="text-sm text-ink-500">No entries.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs uppercase text-ink-500"><tr><th className="py-1">Start</th><th>Mode</th><th>Status</th><th>Result</th><th /></tr></thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id} className="border-t border-ink-800">
                  <td className="py-1.5 tabular-nums">{fmtDateTime(r.startedAt, tz)}</td>
                  <td>{r.trigger === 'auto' ? 'automatic' : r.trigger === 'manual' ? 'manual' : 'file'}</td>
                  <td>{r.status === 'success' ? <Badge tone="ok">OK</Badge> : r.status === 'error' ? <Badge tone="error">Error</Badge> : <Badge tone="info">Running</Badge>}</td>
                  <td className="max-w-[420px] truncate text-ink-400" title={r.error ?? ''}>
                    {r.summary ? `+${r.summary.declarationsAdded} decl., ${r.summary.declarationsUpdated} changed, +${r.summary.membersAdded}/~${r.summary.membersChanged}/−${r.summary.membersRemoved} people, ${r.summary.conflicts.length} conflicts, ${r.summary.warnings.length} warnings` : r.error}
                  </td>
                  <td className="text-right"><Button size="sm" variant="ghost" onClick={() => setShown(r)}>Details</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={!!shown} onClose={() => setShown(null)} title="Sync details" wide>
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
        {stat('declarations in source', s.declarationsInSource)}
        {stat('new declarations', s.declarationsAdded, 'text-emerald-300')}
        {stat('changed declarations', s.declarationsUpdated, 'text-sky-300')}
        {stat('unchanged', s.declarationsUnchanged)}
        {stat('people added', s.membersAdded, 'text-emerald-300')}
        {stat('people changed', s.membersChanged, 'text-sky-300')}
        {stat('people removed', s.membersRemoved)}
        {stat('people unmatched', s.membersUnmatched, s.membersUnmatched ? 'text-amber-300' : undefined)}
      </div>
      {!!s.conflicts.length && (
        <div>
          <h4 className="mb-1 font-semibold text-sky-300">Conflicts: manual correction kept ({s.conflicts.length})</h4>
          <ul className="space-y-0.5 text-ink-300">
            {s.conflicts.map((c, i) => <li key={i}>{c.team} {c.date} · {c.name}: {c.field} manual “{c.manual}”, source “{c.source}”</li>)}
          </ul>
        </div>
      )}
      {!!s.warnings.length && (
        <div>
          <h4 className="mb-1 font-semibold text-amber-300">Warnings ({s.warnings.length})</h4>
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
    try { await api.put('/api/settings/paths', { vmixAssetsRoot: root }); toast.ok('Path mapping saved'); qc.invalidateQueries(); }
    catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const Row = ({ label, value }: { label: string; value: string | null }) => (
    <div className="grid grid-cols-[200px_1fr] gap-2 py-1"><span className="text-ink-400">{label}</span><code className="break-all text-ink-200">{value ?? '—'}</code></div>
  );
  return (
    <Section id="paths" title="Files & vMix paths">
      <div className="text-sm">
        <Row label="Database (SQLite)" value={info.paths.dbPath} />
        <Row label="Uploaded files folder" value={info.paths.assetsDir} />
      </div>
      <form onSubmit={save} className="mt-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
        <Field label="vMix assets folder">
          <input className="input font-mono text-xs" value={root} onChange={(e) => setRoot(e.target.value)} placeholder="\\DASHBOARD-PC\ssl-assets" />
        </Field>
        <Button type="submit" variant="primary" busy={busy} disabled={root === info.paths.vmixAssetsRoot}>Save</Button>
      </form>
    </Section>
  );
}

function PresetSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ teamsCreated: number; teamsExisting: number; setsCreated: number; setsSkipped: string[] } | null>(null);
  const load = async () => {
    setBusy(true);
    try {
      const r = await api.post<NonNullable<typeof result>>('/api/presets/ssl-gold-cup-2026');
      setResult(r); qc.invalidateQueries();
      toast.ok(`Matchboard loaded: ${r.teamsCreated} teams and ${r.setsCreated} fleet sets added`);
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Section id="presets" title="Matchboard">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" busy={busy} onClick={load}>Load SSL Gold Cup 2026 matchboard</Button>
      </div>
      {result && (
        <p className="mt-2 text-sm text-ink-300">
          {result.teamsCreated} teams added, {result.teamsExisting} already existed. {result.setsCreated} fleet sets added
          {result.setsSkipped.length ? `, skipped because they exist: ${result.setsSkipped.join(', ')}` : ''}.
        </p>
      )}
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
    <Section id="demo" title="Demo data">
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" busy={busy === 'seed'} disabled={hasDemo} onClick={() => call('seed', '/api/demo/seed', 'DEMO data added')}>Load demo data</Button>
        <Button busy={busy === 'imp'} disabled={!hasDemo} onClick={() => call('imp', '/api/sync/demo-import', 'Test declaration page imported (DEMO)')}>Import test declaration page (DEMO)</Button>
        <Button variant="danger" busy={busy === 'rm'} disabled={!hasDemo} onClick={async () => {
          if (await ask('Remove demo data?', 'All teams and sailors labelled DEMO, their graphics, declarations and the demo fleet set will be deleted. Your own data is not touched.', 'Remove demo data')) await call('rm', '/api/demo/remove', 'DEMO data removed');
        }}>Remove demo data</Button>
      </div>
      {dialog}
    </Section>
  );
}

function BackupSection({ info }: { info: SettingsInfo }) {
  return (
    <Section id="backup" title="Backup">
      <div className="space-y-2 text-sm text-ink-300">
        <p><b>Create a backup</b> (works while the server runs):</p>
        <pre className="overflow-x-auto rounded-md bg-ink-950 p-3 text-xs text-ink-200">npm run backup{'\n'}npm run backup -- D:\Backups\SSL</pre>
        <p><b>Restore</b> (stop the server first):</p>
        <pre className="overflow-x-auto rounded-md bg-ink-950 p-3 text-xs text-ink-200">npm run restore -- backups\2026-06-11-08-30-00</pre>
      </div>
    </Section>
  );
}
