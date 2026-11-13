import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { api, EventInfo, ImportSummary, RunOutcome, SettingsInfo, SyncRun, SyncStatus } from '../api';
import { Badge, Button, cx, ErrorBox, Field, fmtDateTime, Loading, Modal, useConfirm, useToast } from '../components/ui';

const COMMON_TIMEZONES = ['Europe/Warsaw', 'America/Sao_Paulo', 'Europe/London', 'Europe/Lisbon', 'Europe/Madrid', 'Europe/Paris', 'Europe/Berlin', 'Europe/Rome', 'Europe/Athens', 'Atlantic/Canary', 'UTC'];
const ALL_TIMEZONES: string[] = (() => { try { return (Intl as any).supportedValuesOf('timeZone'); } catch { return COMMON_TIMEZONES; } })();
const CITY_HINT: Record<string, string> = { 'America/Sao_Paulo': 'Rio de Janeiro, São Paulo', 'Europe/Warsaw': 'Poland', 'Atlantic/Canary': 'Canary Islands' };
const tzLabel = (t: string) => `${t.replace(/_/g, ' ')}${CITY_HINT[t] ? ` (${CITY_HINT[t]})` : ''}`;

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
        {[['event', 'Event'], ['commentator-online', 'Commentator online'], ['presets', 'Matchboard'], ['sync', 'Declaration sync'], ['paths', 'Files & vMix paths'], ['demo', 'Demo data'], ['backup', 'Backup']].map(([id, l]) => (
          <a key={id} href={`#${id}`} className="rounded-md border border-ink-700 px-2.5 py-1 text-ink-300 hover:bg-ink-800">{l}</a>
        ))}
      </nav>
      <EventSection event={q.data!.event} />
      <StaticPageSection />
      <CommentatorOnlineSection />
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
          <select className="input" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} required>
            <optgroup label="Common">{COMMON_TIMEZONES.map((t) => <option key={t} value={t}>{tzLabel(t)}</option>)}</optgroup>
            <optgroup label="All">{ALL_TIMEZONES.filter((t) => !COMMON_TIMEZONES.includes(t)).map((t) => <option key={t} value={t}>{tzLabel(t)}</option>)}</optgroup>
          </select>
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
      <VmixAddress />
    </Section>
  );
}

/** Where the dashboard reaches the vMix Web API (Results → Send to vMix). */
function VmixAddress() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['vmix-url'], queryFn: () => api.get<{ apiUrl: string; default: string }>('/api/settings/vmix') });
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = url ?? q.data?.apiUrl ?? '';
  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { const r = await api.put<{ apiUrl: string }>('/api/settings/vmix', { apiUrl: value }); setUrl(r.apiUrl); q.refetch(); toast.ok('vMix address saved'); }
    catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={save} className="mt-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
      <Field label="vMix Web API address (vMix: Settings → Web Controller)">
        <input className="input font-mono text-xs" value={value} onChange={(e) => setUrl(e.target.value)} placeholder={q.data?.default ?? 'http://127.0.0.1:8088'} />
      </Field>
      <Button type="submit" variant="primary" busy={busy} disabled={!q.data || value === q.data.apiUrl}>Save</Button>
    </form>
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
      toast.ok(`Matchboard loaded: ${r.teamsCreated} teams and ${r.setsCreated} stages added`);
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Section id="presets" title="Matchboard">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" busy={busy} onClick={load}>Load SSL Gold Cup 2026 data</Button>
      </div>
      {result && (
        <p className="mt-2 text-sm text-ink-300">
          {result.teamsCreated} teams added, {result.teamsExisting} already existed. {result.setsCreated} stages added
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
          if (await ask('Remove demo data?', 'All teams and sailors labelled DEMO, their graphics, declarations and the demo stage will be deleted. Your own data is not touched.', 'Remove demo data')) await call('rm', '/api/demo/remove', 'DEMO data removed');
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

// ---------- commentator screen online ----------
interface PushInfo {
  target: string; enabled: boolean; hasPassword: boolean;
  status: { lastAttemptAt: string | null; lastOkAt: string | null; lastChangeAt: string | null; error: string; viewerUrl: string; bytes: number; pictures: number };
}
interface ViewerInfo { path: string; passwordSet: boolean; feed: { pushedAt: string; receivedAt: string | null; from: string; day: string } | null; now: string }

function CopyLink({ url }: { url: string }) {
  const toast = useToast();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="break-all rounded bg-ink-950 px-2 py-1 text-xs text-accent-200">{url}</code>
      <Button size="sm" onClick={async () => { try { await navigator.clipboard.writeText(url); toast.ok('Link copied'); } catch { toast.info(url); } }}>Copy</Button>
    </div>
  );
}

/**
 * Two halves of one feature. On the PC at the venue: send the commentator data to the online dashboard.
 * On the online dashboard: the read-only link for commentators, and what arrived from the venue.
 */
function CommentatorOnlineSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const push = useQuery({ queryKey: ['live-push'], queryFn: () => api.get<PushInfo>('/api/live/push'), refetchInterval: 5000 });
  const viewer = useQuery({ queryKey: ['live-viewer'], queryFn: () => api.get<ViewerInfo>('/api/live/viewer'), refetchInterval: 10000 });
  const [target, setTarget] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const p = push.data;
  const st = p?.status;
  const save = async (body: Partial<{ target: string; password: string; enabled: boolean }>, msg: string) => {
    setBusy('save');
    try {
      qc.setQueryData(['live-push'], await api.put<PushInfo>('/api/live/push', body));
      if (body.enabled !== false && (body.enabled || p?.enabled)) qc.setQueryData(['live-push'], await api.post<PushInfo>('/api/live/push/now'));
      setTarget(null); setPassword(''); toast.ok(msg);
    } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const onSubmit = (e: FormEvent) => { e.preventDefault(); void save({ target: target ?? p?.target ?? '', ...(password ? { password } : {}) }, 'Saved'); };
  const v = viewer.data;
  const link = v ? window.location.origin + v.path : '';
  const ago = (iso: string | null | undefined) => iso ? fmtDateTime(iso) : '—';
  return (
    <Section id="commentator-push" title="Commentator via the online dashboard (alternative)"
      desc={<>Instead of the static page above: the PC at the venue sends the data every 5 s to the online dashboard (for example <code>https://sslgfx.em27code.com</code>); commentators open a link that shows only the commentator screen and cannot change anything. The venue PC is not reachable from the internet.</>}>
      <h3 className="text-sm font-semibold text-ink-200">1. On the PC at the venue: send the data</h3>
      {push.isLoading ? <Loading /> : push.error ? <ErrorBox error={push.error} /> : p && (
        <>
          <form onSubmit={onSubmit} className="mt-2 grid gap-3 md:grid-cols-[2fr_1fr_auto] md:items-end">
            <Field label="Online dashboard address">
              <input className="input font-mono text-xs" value={target ?? p.target} onChange={(e) => setTarget(e.target.value)} placeholder="https://sslgfx.em27code.com" />
            </Field>
            <Field label={p.hasPassword ? 'Its password (saved; type to change)' : 'Its password (DASHBOARD_PASSWORD)'}>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={p.hasPassword ? '••••••••' : ''} autoComplete="new-password" />
            </Field>
            <Button type="submit" variant="primary" busy={busy === 'save'} disabled={(target === null || target === p.target) && !password}>Save</Button>
          </form>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-sky-500" checked={p.enabled} disabled={!p.target || busy === 'save'}
                onChange={(e) => save({ enabled: e.target.checked }, e.target.checked ? 'Sending switched on' : 'Sending switched off')} />
              Send every 5 seconds
            </label>
            <Button size="sm" busy={busy === 'now'} disabled={!p.target} onClick={async () => {
              setBusy('now');
              try { const r = await api.post<PushInfo>('/api/live/push/now'); qc.setQueryData(['live-push'], r); if (r.status.error) toast.error(r.status.error); else toast.ok('Sent'); }
              catch (e) { toast.error(e); } finally { setBusy(null); }
            }}>Send now</Button>
            {st && (st.error ? <Badge tone="error" title={st.error}>Error</Badge> : st.lastOkAt ? <Badge tone="ok">Sent {ago(st.lastOkAt)}</Badge> : p.enabled ? <Badge>Waiting</Badge> : <Badge>Off</Badge>)}
          </div>
          {st?.error && <p className="mt-2 text-sm text-red-300">{st.error}</p>}
          {st?.lastOkAt && <p className="mt-2 text-xs text-ink-400">Last change sent {ago(st.lastChangeAt)} · {Math.round(st.bytes / 1024)} KB of data · {st.pictures} pictures</p>}
          {st?.viewerUrl && <div className="mt-3"><p className="mb-1 text-xs text-ink-400">Link for commentators (open in any browser; read-only):</p><CopyLink url={st.viewerUrl} /></div>}
        </>
      )}

      <h3 className="mt-6 text-sm font-semibold text-ink-200">2. On the online dashboard: the commentator link</h3>
      {viewer.isLoading ? <Loading /> : viewer.error ? <ErrorBox error={viewer.error} /> : v && (
        <div className="mt-2 space-y-2 text-sm">
          {!v.passwordSet ? <p className="text-ink-400">This is a local dashboard (no DASHBOARD_PASSWORD), so it does not receive data: the link for commentators is the one in part 1, or in these settings on the online dashboard.</p> : <>
          <CopyLink url={link} />
          <p className="text-xs text-ink-400">
            {v.feed ? <>Data from the venue: received {ago(v.feed.receivedAt)}{v.feed.from ? ` from ${v.feed.from}` : ''}, day {v.feed.day}. </> : <>Nothing received from the venue yet: the link shows this dashboard&apos;s own data. </>}
            Preview: <a className="text-accent-300 underline" href="/live" target="_blank" rel="noreferrer">/live</a>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="danger" busy={busy === 'rotate'} onClick={async () => {
              if (!(await ask('Make a new commentator link?', 'The current link and everyone who opened it stop working at once. Send the new link to the commentators.', 'Make a new link'))) return;
              setBusy('rotate');
              try { await api.post('/api/live/viewer/rotate'); qc.invalidateQueries({ queryKey: ['live-viewer'] }); qc.invalidateQueries({ queryKey: ['live-push'] }); toast.ok('New link ready'); }
              catch (e) { toast.error(e); } finally { setBusy(null); }
            }}>New link (old one stops working)</Button>
            {v.feed && <Button size="sm" busy={busy === 'clear'} onClick={async () => {
              if (!(await ask('Forget the data from the venue?', 'The link then shows this dashboard\'s own data until the venue PC sends again.', 'Forget'))) return;
              setBusy('clear');
              try { await api.del('/api/live-feed'); qc.invalidateQueries({ queryKey: ['live-viewer'] }); toast.ok('Data from the venue removed'); }
              catch (e) { toast.error(e); } finally { setBusy(null); }
            }}>Forget data from the venue</Button>}
          </div>
          </>}
        </div>
      )}
      {dialog}
    </Section>
  );
}

// ---------- commentator screen as a static page ----------
interface StaticSiteInfo {
  mode: 'folder' | 'ftp' | 'https' | 's3'; localDir: string; publicUrl: string; ftpHost: string; ftpPort: number; ftpUser: string; ftpDir: string; ftpSecure: boolean; hasFtpPassword: boolean;
  s3Endpoint: string; s3Bucket: string; s3AccessKey: string; s3Region: string; hasS3Secret: boolean;
  enabled: boolean; url: string; folderName: string;
  status: { lastAttemptAt: string | null; lastOkAt: string | null; lastChangeAt: string | null; error: string; uploadedFiles: number; dataBytes: number; pictures: number; target: string };
}
type SiteForm = Omit<StaticSiteInfo, 'enabled' | 'url' | 'folderName' | 'status' | 'hasFtpPassword' | 'hasS3Secret'> & { ftpPassword: string; s3Secret: string };

/** The PC at the venue writes the commentator screen as a static web page and uploads it (FTP) or saves it to a folder. */
function StaticPageSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const q = useQuery({ queryKey: ['static-site'], queryFn: () => api.get<StaticSiteInfo>('/api/static-site'), refetchInterval: 5000 });
  const [f, setF] = useState<SiteForm | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const d = q.data;
  useEffect(() => { if (d && !f) setF({ mode: d.mode, localDir: d.localDir, publicUrl: d.publicUrl, ftpHost: d.ftpHost, ftpPort: d.ftpPort, ftpUser: d.ftpUser, ftpDir: d.ftpDir, ftpSecure: d.ftpSecure, ftpPassword: '', s3Endpoint: d.s3Endpoint, s3Bucket: d.s3Bucket, s3AccessKey: d.s3AccessKey, s3Region: d.s3Region, s3Secret: '' }); }, [d, f]);
  if (q.isLoading || !f) return <Section id="commentator-online" title="Commentator online"><Loading /></Section>;
  if (q.error || !d) return <Section id="commentator-online" title="Commentator online"><ErrorBox error={q.error} /></Section>;
  const set = <K extends keyof SiteForm>(k: K, v: SiteForm[K]) => setF({ ...f, [k]: v });
  const run = async (key: string, call: () => Promise<StaticSiteInfo>, msg?: string) => {
    setBusy(key);
    try { const r = await call(); qc.setQueryData(['static-site'], r); qc.invalidateQueries({ queryKey: ['commentator-link'] }); if (r.status.error && key !== 'save') toast.error(r.status.error); else if (msg) toast.ok(msg); }
    catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const { ftpPassword, s3Secret, ...rest } = f;
    void run('save', async () => { await api.put('/api/static-site', { ...rest, ftpPort: Number(rest.ftpPort) || 21, ...(ftpPassword ? { ftpPassword } : {}), ...(s3Secret ? { s3Secret } : {}) }); setF({ ...f, ftpPassword: '', s3Secret: '' }); return d.enabled ? api.post<StaticSiteInfo>('/api/static-site/publish') : api.get<StaticSiteInfo>('/api/static-site'); }, 'Saved');
  };
  const st = d.status;
  const when = (iso: string | null) => (iso ? fmtDateTime(iso) : '—');
  return (
    <Section id="commentator-online" title="Commentator online"
      desc={<>The commentator screen as a <b>static web page</b>: every 5 s this PC writes <code>index.html</code>, <code>data.json</code> and the pictures, and uploads only what changed. On the web host nothing runs but the web server, so there is nothing to crash. The random folder name in the address is the key; the page is read-only.</>}>
      <form onSubmit={save} className="space-y-3">
        <div className="flex flex-wrap gap-4 text-sm">
          {(['s3', 'https', 'ftp', 'folder'] as const).map((m) => (
            <label key={m} className="flex items-center gap-2"><input type="radio" checked={f.mode === m} onChange={() => set('mode', m)} />{{ s3: 'Cloudflare R2 / S3 (recommended)', https: 'HTTPS to upload.php', ftp: 'FTP', folder: 'Only a folder on this PC' }[m]}</label>
          ))}
        </div>
        {f.mode === 's3' ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-400">Cloudflare R2: R2 → Create bucket → Settings → Public access (r2.dev) on; R2 → Manage API tokens → Object Read &amp; Write for this bucket. Paste the S3 endpoint, the bucket name and the token's Access Key ID and Secret here; the web address below is the bucket's public <code>https://pub-….r2.dev</code>.</p>
            <div className="grid gap-3 md:grid-cols-[2fr_1fr_100px]">
              <Field label="S3 endpoint"><input className="input font-mono text-xs" value={f.s3Endpoint} onChange={(e) => set('s3Endpoint', e.target.value)} placeholder="https://<account-id>.r2.cloudflarestorage.com" /></Field>
              <Field label="Bucket"><input className="input font-mono text-xs" value={f.s3Bucket} onChange={(e) => set('s3Bucket', e.target.value)} placeholder="ssl-commentary" /></Field>
              <Field label="Region"><input className="input font-mono text-xs" value={f.s3Region} onChange={(e) => set('s3Region', e.target.value)} placeholder="auto" /></Field>
              <Field label="Access Key ID"><input className="input font-mono text-xs" value={f.s3AccessKey} onChange={(e) => set('s3AccessKey', e.target.value)} autoComplete="off" /></Field>
              <Field label={d.hasS3Secret ? 'Secret Access Key (saved; type to change)' : 'Secret Access Key'} className="md:col-span-2"><input className="input" type="password" value={f.s3Secret} onChange={(e) => set('s3Secret', e.target.value)} placeholder={d.hasS3Secret ? '••••••••' : ''} autoComplete="new-password" /></Field>
            </div>
          </div>
        ) : f.mode === 'https' ? (
          <div className="rounded-md border border-ink-800 bg-ink-950/40 p-3 text-sm text-ink-300">
            Works on any network (port 443, like a web page). Once: download <b>upload.php</b> and put it in the web folder of the address below
            (e.g. <code>public_html/commentary</code>) with the hosting's file manager. It holds only a fingerprint of this PC's key and accepts nothing but the commentator page files.
            <div className="mt-2"><a className="btn btn-secondary inline-flex items-center rounded-md border border-ink-700 px-3 py-1.5 text-sm hover:bg-ink-800" href="/api/static-site/upload.php" download>Download upload.php</a></div>
          </div>
        ) : f.mode === 'ftp' ? (
          <div className="grid gap-3 md:grid-cols-[2fr_100px_1fr_1fr]">
            <Field label="FTP server"><input className="input font-mono text-xs" value={f.ftpHost} onChange={(e) => set('ftpHost', e.target.value)} placeholder="h55.seohost.pl" /></Field>
            <Field label="Port"><input className="input font-mono text-xs" inputMode="numeric" value={f.ftpPort} onChange={(e) => set('ftpPort', Number(e.target.value.replace(/\D/g, '')) || 0)} /></Field>
            <Field label="FTP user"><input className="input font-mono text-xs" value={f.ftpUser} onChange={(e) => set('ftpUser', e.target.value)} autoComplete="off" /></Field>
            <Field label={d.hasFtpPassword ? 'Password (saved; type to change)' : 'Password'}><input className="input" type="password" value={f.ftpPassword} onChange={(e) => set('ftpPassword', e.target.value)} placeholder={d.hasFtpPassword ? '••••••••' : ''} autoComplete="new-password" /></Field>
            <Field label="Folder on the server (empty = the FTP account's own folder)" className="md:col-span-2"><input className="input font-mono text-xs" value={f.ftpDir} onChange={(e) => set('ftpDir', e.target.value)} placeholder="" /></Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm md:col-span-2"><input type="checkbox" className="h-4 w-4 accent-sky-500" checked={f.ftpSecure} onChange={(e) => set('ftpSecure', e.target.checked)} />Encrypted (FTPS); switch off only if the host does not offer it</label>
          </div>
        ) : (
          <Field label="Folder on this PC"><input className="input font-mono text-xs" value={f.localDir} onChange={(e) => set('localDir', e.target.value)} /></Field>
        )}
        <Field label="Web address of that folder (what commentators open, without the random part)">
          <input className="input font-mono text-xs" value={f.publicUrl} onChange={(e) => set('publicUrl', e.target.value)} placeholder={f.mode === 's3' ? 'https://pub-xxxxxxxx.r2.dev' : 'https://commentary.em27code.com'} />
        </Field>
        <Button type="submit" variant="primary" busy={busy === 'save'}>Save</Button>
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-sky-500" checked={d.enabled} disabled={busy !== null}
            onChange={(e) => run('toggle', async () => { await api.put('/api/static-site', { enabled: e.target.checked }); return e.target.checked ? api.post<StaticSiteInfo>('/api/static-site/publish') : api.get<StaticSiteInfo>('/api/static-site'); }, e.target.checked ? 'Publishing switched on' : 'Publishing switched off')} />
          Publish every 5 seconds
        </label>
        <Button size="sm" busy={busy === 'now'} onClick={() => run('now', () => api.post<StaticSiteInfo>('/api/static-site/publish'), 'Published')}>Publish now</Button>
        {st.error ? <Badge tone="error" title={st.error}>Error</Badge> : st.lastOkAt ? <Badge tone="ok">Published {when(st.lastOkAt)}</Badge> : <Badge>{d.enabled ? 'Waiting' : 'Off'}</Badge>}
      </div>
      {st.error && <p className="mt-2 text-sm text-red-300">{st.error}</p>}
      {st.lastOkAt && <p className="mt-2 text-xs text-ink-400">Data last changed {when(st.lastChangeAt)} · data.json {Math.round(st.dataBytes / 1024)} KB · {st.pictures} pictures · last round sent {st.uploadedFiles} file{st.uploadedFiles === 1 ? '' : 's'} · {st.target}</p>}
      <div className="mt-3">
        <p className="mb-1 text-xs text-ink-400">Link for commentators (any network, any browser; read-only):</p>
        {d.url ? <CopyLink url={d.url} /> : <p className="text-sm text-ink-400">Fill in the web address above. Folder name: <code>{d.folderName}</code></p>}
      </div>
      <Button className="mt-3" size="sm" variant="danger" busy={busy === 'addr'} onClick={async () => {
        if (!(await ask('Move the page to a new address?', 'The page is published under a new random folder name, so the old link stops getting new data. Delete the old folder on the host by hand (FTP) so it disappears completely.', 'New address'))) return;
        void run('addr', async () => { await api.post('/api/static-site/new-address'); return d.enabled ? api.post<StaticSiteInfo>('/api/static-site/publish') : api.get<StaticSiteInfo>('/api/static-site'); }, 'New address ready');
      }}>New address (old link stops updating)</Button>
      {dialog}
    </Section>
  );
}
