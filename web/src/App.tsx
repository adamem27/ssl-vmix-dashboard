import { Navigate, NavLink, Outlet, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, Meta } from './api';
import { cx } from './components/ui';
import { StagePicker } from './components/StagePicker';
import { VersionBadge } from './components/VersionBadge';
import { CommentatorPage } from './pages/Commentator';
import { OverviewPage } from './pages/Overview';
import { GeneralPage } from './pages/General';
import { JsonPage } from './pages/Json';
import { TeamDetailPage } from './pages/TeamDetail';
import { SailorPage } from './pages/Sailor';
import { FleetsPage } from './pages/Fleets';
import { DeclarationsPage } from './pages/Declarations';
import { SettingsPage } from './pages/Settings';
import { GeneratorPage } from './pages/Generator';
import { GtzipGeneratorPage } from './pages/GtzipGenerator';
import { ResultsPage } from './pages/Results';
import { LowerThirdsPage } from './pages/LowerThirds';
import { ShowControlPage } from './pages/ShowControl';

export function useMeta() {
  return useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/api/meta'), staleTime: 60_000 });
}

interface MirrorStatus { seen: { at: string; host: string; folder: string; error: string } | null; now: string }

/** Whether the vMix PC's sync program is checking in (it polls every 2 s). */
function VmixPcBadge() {
  const q = useQuery({ queryKey: ['mirror-status'], queryFn: () => api.get<MirrorStatus>('/api/mirror/status'), refetchInterval: 5000 });
  const seen = q.data?.seen;
  if (!q.data) return null;
  const ago = seen ? Math.max(0, Math.round((Date.parse(q.data.now) - Date.parse(seen.at)) / 1000)) : null;
  const online = ago !== null && ago < 20;
  const state = !seen ? 'none' : !online ? 'offline' : seen.error ? 'error' : 'ok';
  const label = { none: 'vMix PC: not connected', offline: `vMix PC: offline ${ago! < 120 ? `${ago}s` : `${Math.round(ago! / 60)} min`}`, error: 'vMix PC: sync error', ok: 'vMix PC: synced' }[state];
  const title = seen ? `${seen.host} → ${seen.folder}${seen.error ? `\n${seen.error}` : ''}` : 'Run install-vmix-sync.bat on the vMix PC';
  return (
    <span title={title} className={cx('flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs font-semibold',
      state === 'ok' ? 'bg-emerald-950/60 text-emerald-300' : state === 'none' ? 'bg-ink-900 text-ink-400' : 'bg-red-950/70 text-red-300')}>
      <span className={cx('h-2 w-2 rounded-full', state === 'ok' ? 'bg-emerald-400' : state === 'none' ? 'bg-ink-600' : 'bg-red-400')} />
      {label}
    </span>
  );
}

function TopBar() {
  const meta = useMeta();
  const tab = ({ isActive }: { isActive: boolean }) =>
    cx('relative px-4 py-3 text-sm font-semibold tracking-wide transition-colors',
      isActive ? 'text-ink-50 after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded after:bg-accent-400' : 'text-ink-400 hover:text-ink-100');
  return (
    <header className="sticky top-0 z-40 border-b border-ink-800 bg-ink-950/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1800px] items-center gap-6 px-4 lg:px-6">
        <div className="flex items-center gap-2 py-3">
          <span className="grid h-7 w-7 place-items-center rounded bg-accent-500 text-xs font-black text-white">SSL</span>
          <span className="hidden text-sm font-semibold text-ink-200 sm:inline">Regatta · broadcast</span>
        </div>
        <nav className="flex" aria-label="Modules">
          <NavLink to="/vmix" className={tab}>vMix graphics</NavLink>
          <NavLink to="/commentator" className={tab}>Commentator</NavLink>
        </nav>
        <div className="ml-auto"><StagePicker /></div>
        <div className="truncate text-xs text-ink-400" title="Active event">
          {meta.data && <>Event: <span className="font-medium text-ink-200">{meta.data.event.name}</span> · {meta.data.event.timezone}</>}
        </div>
        <VmixPcBadge />
        <VersionBadge />
      </div>
    </header>
  );
}

/** Simple line icons (24×24, stroke = text colour). */
const ICON: Record<string, string> = {
  live: 'M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4M5 5a10 10 0 0 0 0 14M19 19a10 10 0 0 0 0-14',
  lower: 'M3 5h18v14H3zM5 14h10M5 16.5h6',
  teams: 'M9 7m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M3 20v-1a5 5 0 0 1 10 0v1M16 4.5a3 3 0 0 1 0 5.5M21 20v-1a5 5 0 0 0-3.5-4.8',
  fleets: 'M12 3v13M12 3l7 11h-7M12 5l-6 9h6M3 18h18l-2 3H5z',
  declarations: 'M9 4h6v3H9zM7 5.5H5v15h14v-15h-2M8.5 12l2 2 4-4M8.5 17h7',
  results: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3',
  general: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  png: 'M4 4h16v16H4zM8.5 9.5m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0M20 15l-5-5-11 10',
  gtzip: 'M6 3h9l4 4v14H6zM14 3v5h5M10 10h2M10 13h2M10 16h2',
  json: 'M8 4H7a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h1M16 4h1a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-1',
  settings: 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1',
};
function NavIcon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      <path d={ICON[name]} />
    </svg>
  );
}

/** Tabs grouped by what they are for; each group has its own colour (class names spelled out for Tailwind). */
const NAV_GROUPS = [
  { label: 'On air', tone: { head: 'text-rose-400', icon: 'text-rose-400', active: 'bg-rose-500/15 text-rose-100 border-rose-400' }, items: [
    { to: '/vmix/show', label: 'Show control', icon: 'live' },
    { to: '/vmix/lowerthirds', label: 'Lower thirds', icon: 'lower' },
  ] },
  { label: 'Data', tone: { head: 'text-sky-400', icon: 'text-sky-400', active: 'bg-sky-500/15 text-sky-100 border-sky-400' }, items: [
    { to: '/vmix/overview', label: 'Teams & crews', icon: 'teams' },
    { to: '/vmix/fleets', label: 'Fleets', icon: 'fleets' },
    { to: '/vmix/declarations', label: 'Declarations and line-ups', icon: 'declarations' },
    { to: '/vmix/results', label: 'Results', icon: 'results' },
  ] },
  { label: 'Graphics', tone: { head: 'text-violet-400', icon: 'text-violet-400', active: 'bg-violet-500/15 text-violet-100 border-violet-400' }, items: [
    { to: '/vmix/general', label: 'General graphics', icon: 'general' },
    { to: '/vmix/generator', label: 'PNG generator', icon: 'png' },
    { to: '/vmix/gtzip', label: 'GTZIP generator', icon: 'gtzip' },
  ] },
  { label: 'Output & setup', tone: { head: 'text-emerald-400', icon: 'text-emerald-400', active: 'bg-emerald-500/15 text-emerald-100 border-emerald-400' }, items: [
    { to: '/vmix/json', label: 'JSON', icon: 'json' },
    { to: '/vmix/settings', label: 'Settings', icon: 'settings' },
  ] },
];

function VmixLayout() {
  return (
    <div className="mx-auto flex max-w-[1800px] flex-col gap-4 px-4 py-4 md:flex-row lg:px-6">
      <nav aria-label="vMix graphics" className="md:sticky md:top-[64px] md:h-fit md:w-52 md:shrink-0">
        <div className="flex gap-3 overflow-x-auto md:flex-col md:gap-4">
          {NAV_GROUPS.map((g) => (
            <section key={g.label} className="shrink-0">
              <h2 className={cx('mb-1 px-3 text-[10px] font-bold uppercase tracking-widest', g.tone.head)}>{g.label}</h2>
              <ul className="flex gap-1 md:flex-col">
                {g.items.map((it) => (
                  <li key={it.to}>
                    <NavLink to={it.to} className={({ isActive }) => cx('flex items-center gap-2.5 whitespace-nowrap rounded-md border-l-2 px-3 py-2 text-sm font-medium md:whitespace-normal',
                      isActive ? g.tone.active : 'border-transparent text-ink-300 hover:bg-ink-900 hover:text-ink-50')}>
                      {({ isActive }) => <><span className={isActive ? undefined : g.tone.icon}><NavIcon name={it.icon} /></span><span className="leading-tight">{it.label}</span></>}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </nav>
      <main className="min-w-0 flex-1"><Outlet /></main>
    </div>
  );
}

export function App() {
  return (
    <div className="min-h-screen">
      <TopBar />
      <Routes>
        <Route path="/" element={<Navigate to="/vmix/overview" replace />} />
        <Route path="/vmix" element={<VmixLayout />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="teams" element={<Navigate to="/vmix/overview" replace />} />
          <Route path="teams/:id" element={<TeamDetailPage />} />
          <Route path="sailors/:id" element={<SailorPage />} />
          <Route path="fleets" element={<FleetsPage />} />
          <Route path="declarations" element={<DeclarationsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="general" element={<GeneralPage />} />
          <Route path="results" element={<ResultsPage />} />
          <Route path="show" element={<ShowControlPage />} />
          <Route path="lowerthirds" element={<LowerThirdsPage />} />
          <Route path="json" element={<JsonPage />} />
          <Route path="generator" element={<GeneratorPage />} />
          <Route path="gtzip" element={<GtzipGeneratorPage />} />
        </Route>
        <Route path="/commentator" element={<CommentatorPage />} />
        <Route path="*" element={<div className="p-10 text-center text-ink-400">Page not found.</div>} />
      </Routes>
    </div>
  );
}
