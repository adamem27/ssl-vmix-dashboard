import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setStaticSource, watchStaticData } from '../api';
import { CommentatorPage } from '../pages/Commentator';
import { ToastProvider } from '../components/ui';
import '../index.css';

/**
 * The commentator screen as a static web page: index.html, data.json and pictures in one folder on any web host.
 * The venue PC overwrites data.json every few seconds; nothing runs on the host but the web server itself.
 */
setStaticSource('');
const qc = new QueryClient({ defaultOptions: { queries: { retry: 2, refetchOnWindowFocus: true, staleTime: 3_000 } } });
// New data from the venue shows within a few seconds: ?refresh=<seconds> in the address sets how often to look (2–60, default 3).
const every = Math.min(60, Math.max(2, Number(new URLSearchParams(window.location.search).get('refresh')) || 3)) * 1000;
watchStaticData(every, () => void qc.invalidateQueries());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <div className="min-h-screen"><CommentatorPage live /></div>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
