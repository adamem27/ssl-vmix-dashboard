import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useMeta } from '../App';
import { api, FleetSetDetail, FleetSetSummary, Overview, OverviewSailor, OverviewTeam } from '../api';
import { cx, Empty, ErrorBox, Loading, todayIn } from '../components/ui';

const LS_KEY = 'commentator.v1';
function loadPrefs(): { setId?: string; fleetId?: string } {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}'); } catch { return {}; }
}
function savePrefs(p: ReturnType<typeof loadPrefs>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}
const fullName = (s: { firstName: string; lastName: string }) => `${s.firstName} ${s.lastName}`.trim();

interface Hover { sailor: OverviewSailor; team: OverviewTeam; x: number; y: number; flip: boolean }

export function CommentatorPage() {
  const meta = useMeta();
  const tz = meta.data?.event.timezone ?? 'UTC';
  const day = todayIn(tz);
  const prefs = useMemo(loadPrefs, []);
  const [setId, setSetId] = useState(prefs.setId ?? '');
  const [fleetId, setFleetId] = useState(prefs.fleetId ?? '');
  const [hover, setHover] = useState<Hover | null>(null);

  const sets = useQuery({ queryKey: ['fleet-sets'], queryFn: () => api.get<FleetSetSummary[]>('/api/fleet-sets') });
  const activeSet = sets.data?.find((s) => s.id === setId)?.id ?? sets.data?.find((s) => s.assignedCount > 0)?.id ?? sets.data?.[0]?.id ?? '';
  const detail = useQuery({ queryKey: ['fleet-set', activeSet], queryFn: () => api.get<FleetSetDetail>(`/api/fleet-sets/${activeSet}`), enabled: !!activeSet, refetchInterval: 30_000 });
  const data = useQuery({ queryKey: ['overview', day, activeSet], queryFn: () => api.get<Overview>(`/api/overview?date=${day}&set=${activeSet}`), enabled: !!activeSet && !!meta.data, refetchInterval: 30_000 });
  const fleets = detail.data?.fleets ?? [];
  const fleet = fleets.find((f) => f.id === fleetId) ?? fleets[0];
  useEffect(() => savePrefs({ setId: activeSet, fleetId: fleet?.id }), [activeSet, fleet?.id]);

  // Number keys 1–9 switch fleets.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const n = Number(e.key);
      if (n >= 1 && n <= fleets.length) setFleetId(fleets[n - 1].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fleets]);

  const teamById = new Map((data.data?.teams ?? []).map((t) => [t.id, t]));

  return (
    <div className="mx-auto max-w-[1900px] px-4 py-3 lg:px-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <nav className="flex flex-wrap gap-1" aria-label="Fleets">
          {fleets.map((f, i) => (
            <button key={f.id} onClick={() => setFleetId(f.id)} title={`Key ${i + 1}`}
              className={cx('rounded-md px-4 py-2 text-sm font-bold tracking-wide', f.id === fleet?.id ? 'bg-accent-500 text-white' : 'bg-ink-900 text-ink-300 hover:bg-ink-800 hover:text-ink-50')}>
              {f.name}
            </button>
          ))}
        </nav>
        <select className="input ml-auto w-64 py-1.5 text-sm" value={activeSet} onChange={(e) => { setSetId(e.target.value); setFleetId(''); }} aria-label="Fleet set">
          {(sets.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      {sets.isLoading || detail.isLoading || data.isLoading ? <Loading /> : sets.error || detail.error || data.error ? <ErrorBox error={sets.error ?? detail.error ?? data.error} /> : !fleet ? (
        <Empty title="No fleets" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {fleet.positions.map((tid, i) => {
            const team = tid ? teamById.get(tid) : undefined;
            return team
              ? <TeamCard key={i} place={i + 1} team={team} onHover={setHover} />
              : <EmptyCard key={i} place={i + 1} label={fleet.placeholders?.[i] ?? null} />;
          })}
        </div>
      )}
      {hover && <SailorPopup h={hover} />}
    </div>
  );
}

function TeamCard({ place, team, onHover }: { place: number; team: OverviewTeam; onHover: (h: Hover | null) => void }) {
  const flag = team.assets.flag_small?.previewUrl ?? team.assets.flag_big?.previewUrl ?? team.thumb?.previewUrl ?? null;
  const declared = !!team.declaration;
  const crew = declared
    ? team.sailors.filter((s) => s.declared).sort((a, b) => a.declared!.sort - b.declared!.sort)
    : [...team.sailors].sort((a, b) => Number(b.isCaptain) - Number(a.isCaptain));
  const captain = team.sailors.find((s) => s.isCaptain);
  return (
    <section className="card overflow-hidden">
      <header className="flex items-center gap-3 border-b border-ink-800 bg-ink-900 px-3 py-2.5">
        <span className="text-xs font-bold tabular-nums text-ink-500">{place}</span>
        <div className="flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden rounded bg-ink-950">
          {flag ? <img src={flag} alt="" className="max-h-full max-w-full object-contain" /> : null}
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xl font-black text-ink-50">{team.code}</span>
            <span className="truncate text-sm text-ink-300">{team.name}</span>
          </div>
          {captain && <div className="truncate text-xs text-amber-300">★ {fullName(captain)}</div>}
        </div>
        <span className={cx('ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', declared ? 'bg-emerald-950/70 text-emerald-300' : 'bg-ink-800 text-ink-400')}>{declared ? 'Today' : 'Roster'}</span>
      </header>
      <table className="w-full text-sm">
        <tbody>
          {crew.map((s) => {
            const number = s.declared?.number || s.defaultNumber;
            const position = s.declared?.position || s.defaultPosition;
            return (
              <tr key={s.id} className={cx('cursor-default border-b border-ink-800/60 last:border-0 hover:bg-ink-800', s.isCaptain && 'bg-amber-500/10')}
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  const flip = r.right + 300 > window.innerWidth;
                  onHover({ sailor: s, team, x: flip ? r.left : r.right, y: r.top, flip });
                }}
                onMouseLeave={() => onHover(null)}>
                <td className="w-10 py-1.5 pl-3 font-mono font-bold tabular-nums text-ink-400">{number}</td>
                <td className="py-1.5 font-semibold text-ink-50">
                  {s.isCaptain && <span className="mr-1 text-amber-400">★</span>}
                  {s.firstName} <span className="uppercase">{s.lastName}</span>
                </td>
                <td className="py-1.5 pr-3 text-right text-xs text-ink-400">{position}</td>
              </tr>
            );
          })}
          {team.declaration?.unmatched.map((m, i) => (
            <tr key={`u${i}`} className="border-b border-ink-800/60 last:border-0">
              <td className="w-10 py-1.5 pl-3 font-mono font-bold tabular-nums text-ink-400">{m.number}</td>
              <td className="py-1.5 font-semibold text-ink-200">{m.name}</td>
              <td className="py-1.5 pr-3 text-right text-xs text-ink-400">{m.position}</td>
            </tr>
          ))}
          {!crew.length && !team.declaration?.unmatched.length && <tr><td className="px-3 py-4 text-center text-ink-600">—</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

function EmptyCard({ place, label }: { place: number; label: string | null }) {
  return (
    <section className="card flex min-h-[160px] flex-col items-center justify-center border-dashed text-ink-500">
      <span className="text-xs font-bold tabular-nums">{place}</span>
      <span className="mt-1 font-mono text-lg font-bold text-ink-400">{label ?? '—'}</span>
    </section>
  );
}

function SailorPopup({ h }: { h: Hover }) {
  const s = h.sailor;
  const photo = s.photo?.previewUrl;
  const top = Math.max(8, Math.min(h.y, window.innerHeight - 260));
  const style = h.flip ? { top, right: window.innerWidth - h.x + 8 } : { top, left: h.x + 8 };
  const number = s.declared?.number || s.defaultNumber;
  const position = s.declared?.position || s.defaultPosition;
  return (
    <div role="tooltip" style={style} className="pointer-events-none fixed z-50 w-72 overflow-hidden rounded-lg border border-ink-700 bg-ink-900 shadow-2xl">
      <div className="flex gap-3 p-3">
        <div className="h-24 w-20 shrink-0 overflow-hidden rounded bg-ink-800">
          {photo && <img src={photo} alt="" className="h-full w-full object-cover" />}
        </div>
        <div className="min-w-0">
          <div className="text-sm text-ink-300">{s.firstName}</div>
          <div className="text-lg font-bold uppercase leading-tight text-ink-50">{s.lastName}</div>
          <div className="mt-1 text-sm text-ink-300"><span className="font-mono font-bold text-ink-100">#{number || '—'}</span> · {position || '—'}</div>
          <div className="mt-1 text-xs text-ink-400">{h.team.code} · {h.team.name}</div>
          {s.isCaptain && <div className="mt-1 text-xs font-semibold text-amber-300">★ Captain</div>}
        </div>
      </div>
      {(s.bestResult1 || s.bestResult2) && (
        <ul className="space-y-1 border-t border-ink-800 px-3 py-2 text-sm text-ink-200">
          {s.bestResult1 && <li>🏆 {s.bestResult1}</li>}
          {s.bestResult2 && <li>🏆 {s.bestResult2}</li>}
        </ul>
      )}
    </div>
  );
}
