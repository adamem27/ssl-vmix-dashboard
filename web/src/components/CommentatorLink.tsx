import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Button, cx, useToast } from './ui';

interface SiteInfo { enabled: boolean; url: string; status: { error: string; lastOkAt: string | null } }

/** The read-only link for commentators (the static page on our domain), one click away in the top bar. */
export function useCommentatorLink() {
  const site = useQuery({ queryKey: ['commentator-link', 'static'], queryFn: () => api.get<SiteInfo>('/api/static-site'), refetchInterval: 10_000 });
  const d = site.data;
  return { url: d?.enabled ? d.url : '', sending: d ? { enabled: d.enabled, status: d.status } : null };
}

/** HTML that puts the commentator screen inside another page (the page fills the frame; 16:9 by default). */
export const iframeCode = (url: string) =>
  `<iframe src="${url.replace(/"/g, '&quot;')}" title="Commentator screen" style="width:100%;aspect-ratio:16/9;border:0" allow="fullscreen" allowfullscreen></iframe>`;

export function CommentatorLinkButton() {
  const { url, sending } = useCommentatorLink();
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); toast.ok('Commentator link copied'); }
    catch { window.prompt('Copy the commentator link', url); }
  };
  const copyIframe = async () => {
    const code = iframeCode(url);
    try { await navigator.clipboard.writeText(code); toast.ok('Iframe code copied'); }
    catch { window.prompt('Copy the iframe code', code); }
  };
  const problem = !url ? (sending?.enabled ? (sending.status.error || 'Waiting for the first send…') : 'Publishing of the commentator page is off.') : sending?.status.error || '';
  return (
    <div ref={box} className="relative shrink-0">
      <button onClick={() => (url && !open ? copy().then(() => setOpen(true)) : setOpen(!open))} title={url ? 'Copy the link for commentators' : 'Set up the commentator link'}
        className={cx('flex items-center gap-1.5 rounded px-2 py-1 text-xs font-semibold', url ? 'bg-accent-500/15 text-accent-200 hover:bg-accent-500/25' : 'bg-ink-900 text-ink-400 hover:text-ink-200')}>
        <span aria-hidden>🎙</span> Commentator link
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[360px] rounded-lg border border-ink-700 bg-ink-900 p-3 text-sm shadow-2xl">
          {url ? (
            <>
              <p className="text-xs text-ink-400">Read-only commentator screen. Works from any network; send it to the commentators.</p>
              <code className="mt-2 block break-all rounded bg-ink-950 px-2 py-1 text-xs text-accent-200">{url}</code>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="primary" onClick={copy}>Copy</Button>
                <Button size="sm" onClick={() => window.open(url, "_blank", "noopener")}>Open</Button>
                <Button size="sm" onClick={copyIframe} title="HTML to put the commentator screen inside another web page">Copy iframe</Button>
              </div>
            </>
          ) : null}
          {problem && <p className={cx('text-xs', url ? 'mt-2 text-red-300' : 'text-ink-300')}>{problem}</p>}
          <Link to="/vmix/settings#commentator-online" onClick={() => setOpen(false)} className="mt-2 block text-xs text-accent-300 underline">Settings → Commentator online</Link>
        </div>
      )}
    </div>
  );
}
