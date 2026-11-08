import { Link } from 'react-router-dom';
import { cx } from './ui';

/** Small icon next to a team's name that opens its Team profile (crew, graphics, history). */
export function TeamProfileLink({ teamId, name, className }: { teamId: string; name?: string; className?: string }) {
  return (
    <Link to={`/vmix/teams/${teamId}`} title={`Team profile${name ? `: ${name}` : ''}`} aria-label={`Team profile${name ? ` of ${name}` : ''}`}
      onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} draggable={false}
      className={cx('inline-grid h-5 w-5 shrink-0 place-items-center rounded text-ink-500 hover:bg-ink-800 hover:text-accent-300', className)}>
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
        <circle cx="5.5" cy="7" r="1.6" />
        <path d="M3.2 11c.4-1.2 1.2-1.8 2.3-1.8s1.9.6 2.3 1.8M9.5 6.5h3M9.5 9h3" strokeLinecap="round" />
      </svg>
    </Link>
  );
}
