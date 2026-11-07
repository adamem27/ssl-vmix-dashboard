import { Navigate, NavLink, Outlet, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, Meta } from './api';
import { cx } from './components/ui';
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
        <div className="ml-auto truncate text-xs text-ink-400" title="Active event">
          {meta.data && <>Event: <span className="font-medium text-ink-200">{meta.data.event.name}</span> · {meta.data.event.timezone}</>}
        </div>
        <VmixPcBadge />
      </div>
    </header>
  );
}

function VmixLayout() {
  const item = ({ isActive }: { isActive: boolean }) =>
    cx('block rounded-md px-3 py-2 text-sm font-medium', isActive ? 'bg-ink-800 text-ink-50' : 'text-ink-400 hover:bg-ink-900 hover:text-ink-100');
  return (
    <div className="mx-auto flex max-w-[1800px] flex-col gap-4 px-4 py-4 md:flex-row lg:px-6">
      <nav aria-label="vMix graphics" className="md:sticky md:top-[64px] md:h-fit md:w-48 md:shrink-0">
        <ul className="flex gap-1 overflow-x-auto md:flex-col">
          <li><NavLink to="/vmix/overview" className={item}>Teams & crews</NavLink></li>
          <li><NavLink to="/vmix/fleets" className={item}>Fleets</NavLink></li>
          <li><NavLink to="/vmix/declarations" className={item}>Declarations</NavLink></li>
          <li><NavLink to="/vmix/general" className={item}>General graphics</NavLink></li>
          <li><NavLink to="/vmix/generator" className={item}>PNG generator</NavLink></li>
          <li><NavLink to="/vmix/json" className={item}>JSON</NavLink></li>
          <li><NavLink to="/vmix/settings" className={item}>Settings</NavLink></li>
        </ul>
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
          <Route path="json" element={<JsonPage />} />
          <Route path="generator" element={<GeneratorPage />} />
        </Route>
        <Route path="/commentator" element={<CommentatorPage />} />
        <Route path="*" element={<div className="p-10 text-center text-ink-400">Page not found.</div>} />
      </Routes>
    </div>
  );
}
