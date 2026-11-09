import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { cx, Modal } from './ui';

interface VersionInfo {
  version: string;
  commit: string;
  date: string;
  changes: { version: string; commit: string; date: string; text: string }[];
}

const SEEN_KEY = 'ssl.version.seen';
const build = (v: string) => Number(v.split('.')[2]?.replace(/\D.*$/, '')) || 0;
function readSeen() { try { return localStorage.getItem(SEEN_KEY) ?? ''; } catch { return ''; } }
function writeSeen(v: string) { try { localStorage.setItem(SEEN_KEY, v); } catch { /* private window */ } }

/** The app's version in the top bar; a click opens what changed in each version. A dot shows there is something new since last look. */
export function VersionBadge() {
  const q = useQuery({ queryKey: ['version'], queryFn: () => api.get<VersionInfo>('/api/version'), staleTime: 5 * 60_000, refetchInterval: 5 * 60_000 });
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(readSeen);
  const v = q.data;
  if (!v) return null;
  const isNew = (ver: string) => !!seen && build(ver) > build(seen);
  const unseen = seen !== v.version;
  const show = () => { setOpen(true); };
  const close = () => { setOpen(false); writeSeen(v.version); setSeen(v.version); };
  return (
    <>
      <button onClick={show} title={`Version ${v.version} (${v.commit})${v.date ? ` · ${new Date(v.date).toLocaleString()}` : ''}\nClick to see what changed`}
        className="relative shrink-0 rounded px-2 py-1 font-mono text-xs text-ink-400 hover:bg-ink-900 hover:text-ink-100">
        v{v.version}
        {unseen && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent-400" />}
      </button>
      <Modal open={open} onClose={close} title={`What's new · v${v.version}`} wide>
        <p className="mb-4 text-sm text-ink-400">
          The version number is <span className="font-mono">1.0.N</span>: N goes up by one with every change, so the higher number is always the newer app.
          The Windows package and the browser show the same number.
        </p>
        {!v.changes.length && <p className="text-sm text-ink-400">No change list in this build.</p>}
        <ul className="divide-y divide-ink-800">
          {v.changes.map((c) => (
            <li key={c.commit} className={cx('flex gap-3 py-2 text-sm', isNew(c.version) && 'text-ink-50')}>
              <span className={cx('w-16 shrink-0 font-mono text-xs leading-5', c.version === v.version ? 'text-accent-400' : 'text-ink-500')}>{c.version}</span>
              <span className="w-24 shrink-0 text-xs leading-5 text-ink-500">{c.date ? new Date(c.date).toLocaleDateString() : ''}</span>
              <span className="min-w-0 flex-1">{c.text}{isNew(c.version) && <span className="ml-2 rounded bg-accent-500/20 px-1.5 text-[10px] font-bold uppercase text-accent-300">new</span>}</span>
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}
