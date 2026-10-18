import { Navigate, NavLink, Outlet, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, Meta } from './api';
import { cx } from './components/ui';
import { CommentatorPage } from './pages/Commentator';
import { OverviewPage } from './pages/Overview';
import { TeamDetailPage } from './pages/TeamDetail';
import { SailorPage } from './pages/Sailor';
import { FleetsPage } from './pages/Fleets';
import { DeclarationsPage } from './pages/Declarations';
import { SettingsPage } from './pages/Settings';

export function useMeta() {
  return useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/api/meta'), staleTime: 60_000 });
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
        </Route>
        <Route path="/commentator" element={<CommentatorPage />} />
        <Route path="*" element={<div className="p-10 text-center text-ink-400">Page not found.</div>} />
      </Routes>
    </div>
  );
}
