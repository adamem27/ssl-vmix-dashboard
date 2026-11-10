import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setStaticSource } from '../api';
import { CommentatorPage } from '../pages/Commentator';
import { ToastProvider } from '../components/ui';
import '../index.css';

/**
 * The commentator screen as a static web page: index.html, data.json and pictures in one folder on any web host.
 * The venue PC overwrites data.json every few seconds; nothing runs on the host but the web server itself.
 */
setStaticSource('');
const qc = new QueryClient({ defaultOptions: { queries: { retry: 2, refetchOnWindowFocus: true, staleTime: 3_000 } } });

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
