import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useMeta } from '../App';
import { api, FleetSetDetail, FleetSetSummary, Overview, OverviewSailor, OverviewTeam } from '../api';
import { cx, Empty, ErrorBox, fmtDate, Loading, todayIn } from '../components/ui';
import { useStage } from '../components/StagePicker';

const LS_KEY = 'commentator.v1';
function loadPrefs(): { setId?: string; fleetId?: string } {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}'); } catch { return {}; }
}
function savePrefs(p: ReturnType<typeof loadPrefs>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}

interface Stop { pos: number; color: string; opacity: number }
interface Gradient { angle: number; stops: Stop[] }
interface LineupPlace { label: string; number: string; firstName: string; lastName: string; position: string; captain: boolean; sailorId: string | null }
interface Standing { fleetId: string; fleetName: string; title: string; subtitle: string; races: number; rows: { teamId: string; races: string[]; total: string }[] }
interface Weather { forecast: string; air_temp: string; wind_speed: string; wind_direction: string; wind_degrees: string; wind_unit: string }
interface CommentatorData {
  event: { name: string; timezone: string }; stage: { id: string; name: string } | null; date: string;
  weather: Weather; schedule: { id: string; time: string; race: string; fleet: string; status: string; note: string }[];
  results: Standing[]; colours: Record<string, Gradient | null>; lineups: Record<string, LineupPlace[]>;
}
interface Hover { sailor: OverviewSailor; team: OverviewTeam; place?: LineupPlace; x: number; y: number; flip: boolean }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const hexRgb = (h: string) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const css = (g: Gradient | null | undefined, angle = 100) =>
  g?.stops?.length ? `linear-gradient(${angle}deg, ${[...g.stops].sort((a, b) => a.pos - b.pos).map((s) => { const [r, gg, b] = hexRgb(s.color); return `rgba(${r},${gg},${b},${Math.max(0.35, s.opacity / 100)}) ${s.pos}%`; }).join(', ')})` : undefined;
const flagOf = (t: OverviewTeam) => t.assets.flag_small?.previewUrl ?? t.assets.flag_big?.previewUrl ?? t.thumb?.previewUrl ?? null;
const statusTone = (s: string) => { const v = s.toLowerCase(); return v.includes('live') || v.includes('racing') ? 'live' : v.includes('next') ? 'next' : v.includes('done') || v.includes('finish') || v.includes('complete') ? 'done' : v.includes('postpon') || v.includes('cancel') ? 'off' : ''; };

/** Live screen for commentators: the event at a glance, today's races, the group's standing and every crew. */
export function CommentatorPage({ live = false }: { live?: boolean }) {
  const meta = useMeta();
  const tz = meta.data?.event.timezone ?? 'UTC';
  const day = todayIn(tz);
  const prefs = useMemo(loadPrefs, []);
  const [setId, setSetId] = useState(''); // picked on this page; otherwise the current stage, then the last one used
  const [fleetId, setFleetId] = useState(prefs.fleetId ?? '');
  const [hover, setHover] = useState<Hover | null>(null);

  const sets = useQuery({ queryKey: ['fleet-sets'], queryFn: () => api.get<FleetSetSummary[]>('/api/fleet-sets') });
  const stage = useStage();
  const activeSet = sets.data?.find((s) => s.id === setId)?.id ?? stage.data?.current?.id ?? sets.data?.find((s) => s.id === prefs.setId)?.id ?? sets.data?.find((s) => s.assignedCount > 0)?.id ?? sets.data?.[0]?.id ?? '';
  const detail = useQuery({ queryKey: ['fleet-set', activeSet], queryFn: () => api.get<FleetSetDetail>(`/api/fleet-sets/${activeSet}`), enabled: !!activeSet, refetchInterval: 30_000 });
  const data = useQuery({ queryKey: ['overview', day, activeSet], queryFn: () => api.get<Overview>(`/api/overview?date=${day}&set=${activeSet}`), enabled: !!activeSet && !!meta.data, refetchInterval: 30_000 });
  const extra = useQuery({ queryKey: ['commentator', activeSet, day], queryFn: () => api.get<CommentatorData>(`/api/commentator?set=${activeSet}&date=${day}`), enabled: !!activeSet, refetchInterval: 15_000 });
  const fleets = detail.data?.fleets ?? [];
  const fleet = fleets.find((f) => f.id === fleetId) ?? fleets[0];
  useEffect(() => savePrefs({ setId: activeSet, fleetId: fleet?.id }), [activeSet, fleet?.id]);

  // Number keys 1–9 switch groups.
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
  const x = extra.data;
  const standing = x?.results.find((g) => g.fleetId === fleet?.id);
  const rankOf = new Map((standing?.rows ?? []).map((r, i) => [r.teamId, { rank: i + 1, total: r.total }]));
  const hasScores = !!standing?.rows.some((r) => r.total !== '');
  const pickFleetByName = (name: string) => { const f = fleets.find((ff) => norm(ff.name) === norm(name) || norm(name).endsWith(norm(ff.name))); if (f) setFleetId(f.id); };

  const groupTeams = fleet ? fleet.positions.map((tid) => (tid ? teamById.get(tid) : undefined)).filter((t): t is OverviewTeam => !!t) : [];
  // Sized for a 1920×1080 screen with the browser bars: everything fits the window; a long crew list scrolls inside its card.
  return (
    <div className={cx('mx-auto flex max-w-[1920px] flex-col gap-2 px-3 py-2', live ? 'h-screen' : 'h-[calc(100vh-53px)]')}>
      <TopStrip x={x} tz={tz} sets={sets.data ?? []} activeSet={activeSet} onSet={(id) => { setSetId(id); setFleetId(''); }} badge={live ? <FreshnessBadge /> : undefined} />
      <div className="flex min-w-0 items-center gap-2">
        <nav className="flex shrink-0 gap-1" aria-label="Groups">
          {fleets.map((f, i) => (
            <button key={f.id} onClick={() => setFleetId(f.id)} title={`Key ${i + 1}`}
              className={cx('flex items-center gap-1.5 rounded-md border px-2 py-1 transition-colors', f.id === fleet?.id ? 'border-accent-500 bg-accent-500/15' : 'border-ink-800 bg-ink-900 hover:border-ink-600')}>
              <span className={cx('text-sm font-black tracking-wide', f.id === fleet?.id ? 'text-accent-200' : 'text-ink-200')}>{f.name}</span>
              <span className="flex -space-x-1">
                {f.positions.map((tid, j) => { const t = tid ? teamById.get(tid) : undefined; const fl = t && flagOf(t); return fl ? <img key={j} src={fl} alt={t!.code} title={t!.code} className="h-3 w-[18px] rounded-[2px] object-cover ring-1 ring-ink-950" /> : null; })}
              </span>
            </button>
          ))}
        </nav>
        {x && x.schedule.length > 0 && <ScheduleStrip items={x.schedule} current={fleet?.name ?? ''} onPick={pickFleetByName} />}
      </div>

      {sets.isLoading || detail.isLoading || data.isLoading ? <Loading /> : sets.error || detail.error || data.error ? <ErrorBox error={sets.error ?? detail.error ?? data.error} /> : !fleet ? (
        <Empty title="No groups in this stage" />
      ) : (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
            <StandingLine standing={standing} teamById={teamById} colours={x?.colours ?? {}} hasScores={hasScores} fleetName={fleet.name} />
            <FactsLine teams={groupTeams} />
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-4 gap-2">
            {fleet.positions.map((tid, i) => {
              const team = tid ? teamById.get(tid) : undefined;
              const st = standing?.rows.find((r) => r.teamId === tid);
              return team
                ? <TeamCard key={i} team={team} colour={x?.colours[team.id]} lineup={x?.lineups[team.id]} rank={hasScores ? rankOf.get(team.id) : undefined} races={hasScores ? st?.races.filter((v) => v !== '') : undefined} onHover={setHover} />
                : <EmptyCard key={i} place={i + 1} label={fleet.placeholders?.[i] ?? null} />;
            })}
          </div>
        </>
      )}
      {hover && <SailorPopup h={hover} />}
    </div>
  );
}

// ---------- top: event, stage, clock, weather ----------
function Clock({ tz }: { tz: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  let s = '';
  try { s = now.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { s = now.toLocaleTimeString('en-GB'); }
  return <span className="font-mono text-2xl font-black tabular-nums text-ink-50">{s}</span>;
}

interface LiveStatus { feed: { pushedAt: string; receivedAt: string | null } | null; now: string }

/** Online: how fresh the data from the venue PC is. Green while it keeps coming, red once it stops. */
function FreshnessBadge() {
  const q = useQuery({ queryKey: ['live-status'], queryFn: () => api.get<LiveStatus>('/api/live/status'), refetchInterval: 5000 });
  if (!q.data?.feed) return null;
  const at = q.data.feed.receivedAt ?? q.data.feed.pushedAt;
  const ago = Math.max(0, Math.round((Date.parse(q.data.now) - Date.parse(at)) / 1000));
  const ok = ago < 30;
  const time = new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <span title={ok ? 'Data from the venue arrives every few seconds' : 'The venue PC stopped sending: these are the last data it sent'}
      className={cx('flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs font-semibold', ok ? 'bg-emerald-950/60 text-emerald-300' : 'bg-red-950/70 text-red-300')}>
      <span className={cx('h-2 w-2 rounded-full', ok ? 'bg-emerald-400' : 'animate-pulse bg-red-400')} />
      {ok ? 'Live' : `Data from ${time} (${ago < 120 ? `${ago}s` : `${Math.round(ago / 60)} min`} ago)`}
    </span>
  );
}

function TopStrip({ x, tz, sets, activeSet, onSet, badge }: { x?: CommentatorData; tz: string; sets: FleetSetSummary[]; activeSet: string; onSet: (id: string) => void; badge?: ReactNode }) {
  const w = x?.weather;
  const unit = w?.wind_unit || 'kn';
  const chips: [string, string, string][] = w ? ([
    ['Wind', w.wind_speed ? `${w.wind_speed} ${unit}` : '', '💨'],
    ['Direction', [w.wind_direction, w.wind_degrees && `${w.wind_degrees}°`].filter(Boolean).join(' '), '🧭'],
    ['Air', w.air_temp ? `${w.air_temp}°C` : '', '🌡'],
    ['Forecast', w.forecast, '⛅'],
  ] as [string, string, string][]).filter(([, v]) => v) : [];
  return (
    <header className="card flex items-center gap-x-5 px-3 py-1.5">
      <div className="min-w-0">
        <div className="truncate text-base font-black uppercase leading-tight tracking-wide text-ink-50">{x?.event.name || 'Event'}</div>
        <div className="flex items-center gap-2 text-xs text-ink-400">
          <span>{x ? fmtDate(x.date) : ''}</span>
          <select className="input w-auto py-0.5 text-xs" value={activeSet} onChange={(e) => onSet(e.target.value)} aria-label="Stage">
            {sets.map((s) => <option key={s.id} value={s.id}>{s.name}{x?.stage?.id === s.id ? ' (current)' : ''}</option>)}
          </select>
        </div>
      </div>
      <Clock tz={tz} />
      {badge}
      <ul className="ml-auto flex min-w-0 items-center gap-1.5" aria-label="Weather">
        {chips.map(([label, value, icon]) => (
          <li key={label} className="shrink-0 rounded-md border border-ink-800 bg-ink-950/50 px-2 py-1 text-sm" title={label}>
            <span className="mr-1 text-xs">{icon}</span><b className="text-ink-100">{value}</b>
          </li>
        ))}
      </ul>
    </header>
  );
}

// ---------- today's races ----------
function ScheduleStrip({ items, current, onPick }: { items: CommentatorData['schedule']; current: string; onPick: (fleet: string) => void }) {
  return (
    <ol className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto" aria-label="Today's races">
      {items.map((it) => {
        const tone = statusTone(it.status);
        const mine = !!current && norm(it.fleet).endsWith(norm(current));
        return (
          <li key={it.id} className="shrink-0">
            <button onClick={() => it.fleet && onPick(it.fleet)} title={it.note || undefined}
              className={cx('flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-left text-sm',
                tone === 'live' ? 'border-red-600 bg-red-950/50' : tone === 'next' ? 'border-sky-600 bg-sky-950/40' : tone === 'done' ? 'border-ink-800 bg-ink-950/30 opacity-60' : 'border-ink-800 bg-ink-900',
                mine && 'ring-2 ring-accent-500/60')}>
              <span className="font-mono font-bold tabular-nums text-ink-100">{it.time || '—'}</span>
              {it.status && <span className={cx('rounded px-1 text-[10px] font-bold uppercase', tone === 'live' ? 'animate-pulse bg-red-600 text-white' : tone === 'next' ? 'bg-sky-600 text-white' : 'bg-ink-800 text-ink-300')}>{it.status}</span>}
              <span className="font-semibold text-ink-50">{it.race}</span>
              {it.fleet && <span className="text-xs text-ink-400">{it.fleet}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- standing and talking points, one line each ----------
function StandingLine({ standing, teamById, colours, hasScores, fleetName }: { standing?: Standing; teamById: Map<string, OverviewTeam>; colours: Record<string, Gradient | null>; hasScores: boolean; fleetName: string }) {
  if (!standing || !hasScores) return <span className="text-xs text-ink-500">{standing?.title || fleetName}: no scores yet</span>;
  const raced = Array.from({ length: standing.races }, (_, i) => i).filter((i) => standing.rows.some((r) => (r.races[i] ?? '') !== '')).length;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-xs font-bold uppercase text-ink-400">{standing.title || fleetName} · after {raced} race{raced === 1 ? '' : 's'}</span>
      {standing.rows.filter((r) => r.total !== '').map((r, i) => {
        const t = teamById.get(r.teamId);
        const fl = t && flagOf(t);
        return (
          <span key={r.teamId} className={cx('flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-sm', i === 0 ? 'border-amber-700/70 bg-amber-500/10' : 'border-ink-800 bg-ink-900')}>
            <b className="tabular-nums text-ink-300">{i + 1}</b>
            <span className="h-3.5 w-1 rounded-full" style={{ background: css(colours[r.teamId], 180) ?? '#334155' }} />
            {fl && <img src={fl} alt="" className="h-3 w-[18px] rounded-[2px] object-cover" />}
            <b className="font-mono text-ink-50">{t?.code ?? '?'}</b>
            <b className="tabular-nums text-accent-200">{r.total}</b>
          </span>
        );
      })}
    </div>
  );
}

function FactsLine({ teams }: { teams: OverviewTeam[] }) {
  if (!teams.length) return null;
  const ranked = teams.filter((t) => Number(t.ranking) > 0).sort((a, b) => Number(a.ranking) - Number(b.ranking));
  const weighed = teams.filter((t) => Number(String(t.declaration?.totalWeight ?? '').replace(',', '.')) > 0)
    .map((t) => ({ t, w: Number(String(t.declaration!.totalWeight).replace(',', '.')) })).sort((a, b) => a.w - b.w);
  const facts: [string, string][] = [];
  if (ranked.length) facts.push(['Best ranked', `${ranked[0].code} #${ranked[0].ranking}`]);
  if (ranked.length > 1) facts.push(['Lowest ranked', `${ranked[ranked.length - 1].code} #${ranked[ranked.length - 1].ranking}`]);
  if (weighed.length > 1) { facts.push(['Heaviest', `${weighed[weighed.length - 1].t.code} ${weighed[weighed.length - 1].w} kg`]); facts.push(['Lightest', `${weighed[0].t.code} ${weighed[0].w} kg`]); }
  facts.push(['Declared today', `${teams.filter((t) => t.declaration).length}/${teams.length}`]);
  return (
    <ul className="ml-auto flex flex-wrap items-center gap-1.5 text-xs" aria-label="Talking points">
      {facts.map(([k, v]) => <li key={k} className="rounded-md bg-ink-900 px-1.5 py-0.5"><span className="text-ink-500">{k} </span><b className="text-ink-100">{v}</b></li>)}
    </ul>
  );
}

// ---------- team ----------
function TeamCard({ team, colour, lineup, rank, races, onHover }: { team: OverviewTeam; colour?: Gradient | null; lineup?: LineupPlace[]; rank?: { rank: number; total: string }; races?: string[]; onHover: (h: Hover | null) => void }) {
  const flag = flagOf(team);
  const declared = !!team.declaration;
  const byId = new Map(team.sailors.map((s) => [s.id, s]));
  const captain = team.sailors.find((s) => s.isCaptain);
  type Line = { key: string; label: string; number: string; first: string; last: string; position: string; captain: boolean; sailor?: OverviewSailor; place?: LineupPlace };
  const source: 'Line-up' | 'Declared today' | 'Roster' = lineup?.length ? 'Line-up' : declared ? 'Declared today' : 'Roster';
  const lines: Line[] = source === 'Line-up'
    ? lineup!.map((p, i) => ({ key: `l${i}`, label: p.label, number: p.number, first: p.firstName, last: p.lastName, position: p.position, captain: p.captain, sailor: p.sailorId ? byId.get(p.sailorId) : undefined, place: p }))
    : [
      ...(declared ? team.sailors.filter((s) => s.declared).sort((a, b) => a.declared!.sort - b.declared!.sort) : [...team.sailors].sort((a, b) => Number(b.isCaptain) - Number(a.isCaptain)))
        .map((s) => ({ key: s.id, label: '', number: s.declared?.number || s.defaultNumber, first: s.firstName, last: s.lastName, position: s.declared?.position || s.defaultPosition, captain: s.isCaptain, sailor: s })),
      ...(team.declaration?.unmatched ?? []).map((m, i) => ({ key: `u${i}`, label: '', number: m.number, first: m.name, last: '', position: m.position, captain: false })),
    ];
  const bg = css(colour);
  return (
    <section className="card flex min-h-0 flex-col overflow-hidden">
      <header className="relative shrink-0 px-2.5 py-1.5" style={bg ? { background: bg } : undefined}>
        <div className="absolute inset-0 bg-gradient-to-r from-ink-950/80 via-ink-950/55 to-ink-950/20" aria-hidden />
        <div className="relative flex items-center gap-3">
          <div className="flex h-9 w-[54px] shrink-0 items-center justify-center overflow-hidden rounded bg-ink-950/60 shadow">
            {flag ? <img src={flag} alt="" className="max-h-full max-w-full object-contain" /> : null}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-xl font-black leading-none text-white drop-shadow">{team.code}</span>
              <span className="truncate text-sm font-semibold text-white/90">{team.name}</span>
            </div>
            <div className="truncate text-xs">
              {team.nickname && <span className="font-bold uppercase tracking-wide text-white/80">“{team.nickname}” </span>}
              {captain && <span className="text-amber-200">★ {captain.firstName} {captain.lastName}</span>}
            </div>
          </div>
          {rank && (
            <div className="shrink-0 rounded-md bg-ink-950/70 px-2 py-0.5 text-center" title="Rank in the group">
              <div className="text-lg font-black leading-tight tabular-nums text-white">{rank.rank}</div>
              {rank.total && <div className="text-[10px] leading-tight tabular-nums text-ink-300">{rank.total} pts</div>}
            </div>
          )}
        </div>
      </header>
      <div className="flex shrink-0 flex-wrap gap-1 border-b border-ink-800 bg-ink-900/60 px-2 py-1 text-[11px]">
        {team.ranking && <Chip label="Rank" value={`#${team.ranking}`} />}
        {team.rankingPoints && <Chip label="Pts" value={team.rankingPoints} />}
        {team.declaration?.totalWeight && <Chip label="Crew" value={`${team.declaration.totalWeight} kg`} />}
        {team.place && <Chip label="Seed" value={String(team.place.position)} />}
        {races?.length ? <Chip label="Races" value={races.join(' · ')} /> : null}
        <span className={cx('ml-auto rounded px-1.5 py-0.5 font-semibold uppercase', source === 'Roster' ? 'bg-ink-800 text-ink-400' : 'bg-emerald-950/70 text-emerald-300')}>{source}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
      <table className="w-full text-[13px]">
        <tbody>
          {lines.map((l) => (
            <tr key={l.key} className={cx('cursor-default border-b border-ink-800/60 last:border-0 hover:bg-ink-800', l.captain && 'bg-amber-500/10')}
              onMouseEnter={(e) => {
                if (!l.sailor) return;
                const r = e.currentTarget.getBoundingClientRect();
                const flip = r.right + 300 > window.innerWidth;
                onHover({ sailor: l.sailor, team, place: l.place, x: flip ? r.left : r.right, y: r.top, flip });
              }}
              onMouseLeave={() => onHover(null)}>
              <td className="w-8 py-[3px] pl-2 font-mono font-bold tabular-nums text-ink-400">{l.number}</td>
              <td className="truncate py-[3px] font-semibold text-ink-50">
                {l.captain && <span className="mr-1 text-amber-400">★</span>}
                {l.first} <span className="uppercase">{l.last}</span>
                {l.sailor?.photo?.previewUrl && <span className="ml-1 text-[10px] text-ink-600" title="Photo on hover">●</span>}
              </td>
              <td className="whitespace-nowrap py-[3px] pr-2 text-right text-[11px] uppercase text-ink-400">{l.label && l.label.toUpperCase() !== l.position.toUpperCase() ? <><span className="text-ink-500">{l.label} · </span>{l.position}</> : l.position || l.label}</td>
            </tr>
          ))}
          {!lines.length && <tr><td className="px-3 py-4 text-center text-ink-600">No crew yet</td></tr>}
        </tbody>
      </table>
      </div>
    </section>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return <span className="rounded bg-ink-950/60 px-1.5 py-0.5"><span className="text-ink-500">{label} </span><b className="text-ink-100">{value}</b></span>;
}

function EmptyCard({ place, label }: { place: number; label: string | null }) {
  return (
    <section className="card flex flex-col items-center justify-center border-dashed text-ink-500">
      <span className="text-xs font-bold tabular-nums">Place {place}</span>
      <span className="mt-1 font-mono text-lg font-bold text-ink-400">{label ?? 'To be decided'}</span>
    </section>
  );
}

function SailorPopup({ h }: { h: Hover }) {
  const s = h.sailor;
  const photo = s.photo?.previewUrl;
  const top = Math.max(8, Math.min(h.y, window.innerHeight - 280));
  const style = h.flip ? { top, right: window.innerWidth - h.x + 8 } : { top, left: h.x + 8 };
  const number = h.place?.number || s.declared?.number || s.defaultNumber;
  const position = h.place?.position || s.declared?.position || s.defaultPosition;
  return (
    <div role="tooltip" style={style} className="pointer-events-none fixed z-50 w-80 overflow-hidden rounded-lg border border-ink-700 bg-ink-900 shadow-2xl">
      <div className="flex gap-3 p-3">
        <div className="h-28 w-24 shrink-0 overflow-hidden rounded bg-ink-800">
          {photo && <img src={photo} alt="" className="h-full w-full object-cover" />}
        </div>
        <div className="min-w-0">
          <div className="text-sm text-ink-300">{s.firstName}</div>
          <div className="text-xl font-black uppercase leading-tight text-ink-50">{s.lastName}</div>
          <div className="mt-1 text-sm text-ink-300"><span className="font-mono font-bold text-ink-100">#{number || '—'}</span> · {position || '—'}</div>
          {h.place?.label && <div className="text-xs text-ink-400">Line-up: {h.place.label}</div>}
          <div className="mt-1 text-xs text-ink-400">{h.team.code} · {h.team.name}</div>
          {s.declared?.weight && <div className="text-xs text-ink-400">{s.declared.weight} kg</div>}
          {s.isCaptain && <div className="mt-1 text-xs font-semibold text-amber-300">★ Captain</div>}
        </div>
      </div>
      {(s.bestResult1 || s.bestResult2 || s.bestResult3) && (
        <ul className="space-y-1 border-t border-ink-800 px-3 py-2 text-sm text-ink-200">
          {s.bestResult1 && <li>🏆 {s.bestResult1}</li>}
          {s.bestResult2 && <li>🏆 {s.bestResult2}</li>}
          {s.bestResult3 && <li>🏆 {s.bestResult3}</li>}
        </ul>
      )}
    </div>
  );
}
