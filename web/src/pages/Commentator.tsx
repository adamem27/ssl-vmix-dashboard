import React, { ReactNode, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useMeta } from '../App';
import { api, FleetSetDetail, FleetSetSummary, Overview, OverviewSailor, OverviewTeam } from '../api';
import { cx, Empty, ErrorBox, fmtDate, Loading, todayIn } from '../components/ui';
import { useStage } from '../components/StagePicker';
import { groupTitle } from '../../../server/src/services/groupNames';
import { COUNTRY_FACTS } from '../countryFacts';

const LS_KEY = 'commentator.v1';
const readLs = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const writeLs = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };
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
interface Weather { forecast: string; air_temp: string; wind_speed: string; wind_direction: string; wind_degrees: string }
interface CommentatorData {
  event: { name: string; timezone: string }; stage: { id: string; name: string } | null; date: string;
  weather: Weather; schedule: { id: string; time: string; race: string; fleet: string; status: string; note: string }[];
  results: Standing[]; colours: Record<string, Gradient | null>; lineups: Record<string, LineupPlace[]>;
  welcome?: { stage: string; day: string }; nextRace?: string | null; notes?: Record<string, string>;
  history?: Record<string, { stage: string; group: string; rank: number; of: number; total: string }[]>;
  officials?: { role: string; names: string[] }[]; people?: { name: string; role: string }[];
  socials?: { website: string; hashtag: string; handles: string[] };
}

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
  const [info, setInfo] = useState(false);
  const [focus, setFocus] = useState<string | null>(null); // a team opened on its own, in very large type
  const [light, setLight] = useState(() => readLs('commentator.light') === '1');
  const [scale, setScale] = useState(() => { const v = Number(readLs('commentator.scale')); return v >= 0.6 && v <= 2 ? v : 1; });
  useEffect(() => { writeLs('commentator.light', light ? '1' : '0'); document.documentElement.classList.toggle('theme-light', light); return () => document.documentElement.classList.remove('theme-light'); }, [light]);
  useEffect(() => writeLs('commentator.scale', String(scale)), [scale]);
  const zoom = (d: number) => setScale((v) => Math.round(Math.min(2, Math.max(0.6, v + d)) * 10) / 10);

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
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'i' || e.key === 'I') { setInfo((v) => !v); return; }
      if (e.key === 'l' || e.key === 'L') { setLight((v) => !v); return; }
      if (e.key === '+' || e.key === '=') { zoom(0.1); return; }
      if (e.key === '-' || e.key === '_') { zoom(-0.1); return; }
      if (e.key === '0') { setScale(1); return; }
      if (e.key === 'Escape') { if (info) setInfo(false); else setFocus(null); return; }
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && focus) {
        const ids = (fleets.find((f) => f.id === fleetId) ?? fleets[0])?.positions.filter((t): t is string => !!t) ?? [];
        const at = ids.indexOf(focus);
        if (at >= 0 && ids.length) setFocus(ids[(at + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length]);
        return;
      }
      const n = Number(e.key);
      if (n >= 1 && n <= fleets.length) { setFleetId(fleets[n - 1].id); setFocus(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fleets, fleetId, focus, info]);

  const teamById = new Map((data.data?.teams ?? []).map((t) => [t.id, t]));
  const x = extra.data;
  const standing = x?.results.find((g) => g.fleetId === fleet?.id);
  const pointsOf = new Map((standing?.rows ?? []).map((r) => [r.teamId, r.total]));
  const hasScores = !!standing?.rows.some((r) => r.total !== '');

  const groupTeams = fleet ? fleet.positions.map((tid) => (tid ? teamById.get(tid) : undefined)).filter((t): t is OverviewTeam => !!t) : [];
  const focused = focus ? groupTeams.find((t) => t.id === focus) : undefined;
  // Sized for a 1920×1080 screen with the browser bars: everything fits the window; a long crew list scrolls inside its card.
  return (
    <div className={cx('mx-auto flex max-w-[1920px] flex-col gap-2 px-3 py-2', live ? 'h-screen' : 'h-[calc(100vh-53px)]')} style={{ ['--cs' as string]: scale }}>
      <div className="flex shrink-0 flex-col gap-2" style={{ zoom: scale }}>
        <TopStrip x={x} tz={tz} teamById={teamById} current={fleet?.name ?? ''} badge={live ? <FreshnessBadge /> : undefined} />
        <div className="flex min-w-0 items-end gap-3 border-b border-ink-800">
          <nav className="flex min-w-0 gap-0.5 overflow-x-auto" aria-label="Groups">
            {fleets.map((f, i) => {
              const on = f.id === fleet?.id;
              return (
                <button key={f.id} onClick={() => { setFleetId(f.id); setFocus(null); }} title={`Key ${i + 1}`} aria-current={on ? 'page' : undefined}
                  className={cx('-mb-px shrink-0 rounded-t-lg border border-b-0 px-4 py-2 text-lg font-black tracking-wide transition-colors',
                    on ? 'border-ink-700 bg-ink-900 text-ink-50 shadow-[inset_0_3px_0_0_rgb(14_165_233)]' : 'border-transparent text-ink-400 hover:text-ink-100')}>
                  {groupTitle(f.name)}
                </button>
              );
            })}
          </nav>
          <div className="mb-1.5 ml-auto flex shrink-0 items-center gap-2 text-sm">
            <select className="input w-auto py-1 text-sm" value={activeSet} onChange={(e) => { setSetId(e.target.value); setFleetId(''); setFocus(null); }} aria-label="Stage" title="Stage">
              {(sets.data ?? []).map((st) => <option key={st.id} value={st.id}>{st.name}{x?.stage?.id === st.id ? ' (current)' : ''}</option>)}
            </select>
            <div className="flex items-center overflow-hidden rounded-md border border-ink-700" role="group" aria-label="Text size">
              <button onClick={() => zoom(-0.1)} title="Smaller text (key −)" className="px-2.5 py-1 font-bold text-ink-200 hover:bg-ink-800">A−</button>
              <button onClick={() => setScale(1)} title="Normal size (key 0)" className="border-x border-ink-700 px-2 py-1 tabular-nums text-ink-400 hover:bg-ink-800">{Math.round(scale * 100)}%</button>
              <button onClick={() => zoom(0.1)} title="Larger text (key +)" className="px-2.5 py-1 text-base font-bold text-ink-200 hover:bg-ink-800">A+</button>
            </div>
            <button onClick={() => setLight((v) => !v)} title="Light or dark screen (key L)" className="rounded-md border border-ink-700 px-2.5 py-1 text-ink-200 hover:bg-ink-800">{light ? '☾ Dark' : '☀ Light'}</button>
            <button onClick={() => setInfo((v) => !v)} title="Officials, commentators, socials, all groups (key I)" className="rounded-md border border-ink-700 px-2.5 py-1 font-semibold text-ink-200 hover:bg-ink-800">Info</button>
          </div>
        </div>
      </div>

      {sets.isLoading || detail.isLoading || data.isLoading ? <Loading /> : sets.error || detail.error || data.error ? <ErrorBox error={sets.error ?? detail.error ?? data.error} /> : !fleet ? (
        <Empty title="No groups in this stage" />
      ) : (
        <>
          {focused ? (
            <TeamFocus team={focused} colour={x?.colours[focused.id]} lineup={x?.lineups[focused.id]} points={hasScores ? pointsOf.get(focused.id) : undefined}
              races={hasScores ? standing?.rows.find((r) => r.teamId === focused.id)?.races.filter((v) => v !== '') : undefined}
              history={x?.history?.[focused.id]} note={x?.notes?.[focused.id]} group={groupTeams} groupName={groupTitle(fleet.name)} onClose={() => setFocus(null)}
              onStep={(d) => { const at = groupTeams.findIndex((t) => t.id === focused.id); setFocus(groupTeams[(at + d + groupTeams.length) % groupTeams.length].id); }} />
          ) : (
          <div className="grid min-h-0 flex-1 grid-cols-4 gap-2">
            {fleet.positions.map((tid, i) => {
              const team = tid ? teamById.get(tid) : undefined;
              return team
                ? <TeamCard key={i} team={team} colour={x?.colours[team.id]} lineup={x?.lineups[team.id]} points={hasScores ? pointsOf.get(team.id) : undefined} onOpen={() => setFocus(team.id)} />
                : <EmptyCard key={i} place={i + 1} label={fleet.placeholders?.[i] ?? null} />;
            })}
          </div>
          )}
        </>
      )}
      {info && x && <InfoPanel x={x} teamById={teamById} onClose={() => setInfo(false)} onGroup={(id) => { setFleetId(id); setInfo(false); }} fleets={fleets} />}
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

function TopStrip({ x, tz, teamById, current, badge }: { x?: CommentatorData; tz: string; teamById: Map<string, OverviewTeam>; current: string; badge?: ReactNode }) {
  const w = x?.weather;
  // units typed in the field (24°C) are not added twice
  const num = (v: string) => /^\s*-?\d+([.,]\d+)?\s*$/.test(v);
  const weather = w ? [
    w.wind_speed && `💨 ${w.wind_speed}${num(w.wind_speed) ? ' kn' : ''}`,
    [w.wind_degrees && `${w.wind_degrees}${num(w.wind_degrees) ? '°' : ''}`, w.wind_direction].filter(Boolean).join(' '),
    w.air_temp && `🌡 ${w.air_temp}${num(w.air_temp) ? '°C' : ''}`,
    w.forecast,
  ].filter(Boolean) : [];
  return (
    <header className="flex items-center gap-x-6 px-1">
      <div className="min-w-0 shrink-0">
        <div className="truncate text-xl font-black uppercase leading-tight tracking-wide text-ink-50">{x?.welcome?.stage || x?.event.name || 'Event'}</div>
        <div className="text-sm text-ink-400">{[x?.welcome?.day, x ? fmtDate(x.date) : ''].filter(Boolean).join(' · ')}</div>
      </div>
      <Clock tz={tz} />
      {badge}
      {x && <NextRace x={x} tz={tz} teamById={teamById} />}
      {x && <Later items={x.schedule} next={x.nextRace ?? null} current={current} />}
      {weather.length > 0 && <div className="ml-auto shrink-0 text-base font-semibold text-ink-200" aria-label="Weather">{weather.join('   ·   ')}</div>}
    </header>
  );
}

// ---------- the races after the next one (the next one is in Next, so it is not repeated) ----------
function Later({ items, next, current }: { items: CommentatorData['schedule']; next: string | null; current: string }) {
  const at = next ? items.findIndex((it) => it.id === next) : -1;
  if (at < 0) return null;
  const later = items.slice(at + 1, at + 4);
  if (!later.length) return null;
  return (
    <div className="flex min-w-0 items-baseline gap-3 overflow-hidden whitespace-nowrap" aria-label="Later races">
      <span className="text-xs font-bold uppercase tracking-wide text-ink-500">Then</span>
      {later.map((it) => {
        const mine = !!current && !!it.fleet && norm(it.fleet).endsWith(norm(current));
        return (
          <span key={it.id} className={cx('text-base', mine ? 'text-ink-50' : 'text-ink-400')} title={it.note || undefined}>
            <span className="font-mono tabular-nums">{it.time || '—'}</span> {/^\d+$/.test(it.race.trim()) ? `Race ${it.race.trim()}` : it.race}{it.fleet ? ` · ${groupTitle(it.fleet)}` : ''}
          </span>
        );
      })}
    </div>
  );
}

// ---------- team ----------
type Line = { key: string; number: string; first: string; last: string; position: string; weight: string; captain: boolean; sailor?: OverviewSailor };
type History = { stage: string; group: string; rank: number; of: number; total: string }[];

/** The crew as the commentators read it: the position on the boat is always the one from today's declaration, never the line-up's place. */
function crewOf(team: OverviewTeam, lineup?: LineupPlace[]): { lines: Line[]; source: 'Line-up' | 'Declared today' | 'Roster' } {
  const declared = !!team.declaration;
  const byId = new Map(team.sailors.map((s) => [s.id, s]));
  const source: 'Line-up' | 'Declared today' | 'Roster' = lineup?.length ? 'Line-up' : declared ? 'Declared today' : 'Roster';
  const lines: Line[] = source === 'Line-up'
    ? lineup!.map((p, i) => { const s = p.sailorId ? byId.get(p.sailorId) : undefined; return { key: `l${i}`, number: p.number, first: p.firstName, last: p.lastName, position: s?.declared?.position ?? '', weight: s?.declared?.weight ?? '', captain: p.captain, sailor: s }; })
    : [
      ...(declared ? team.sailors.filter((s) => s.declared).sort((a, b) => a.declared!.sort - b.declared!.sort) : [...team.sailors].sort((a, b) => Number(b.isCaptain) - Number(a.isCaptain)))
        .map((s) => ({ key: s.id, number: s.declared?.number || s.defaultNumber, first: s.firstName, last: s.lastName, position: s.declared?.position ?? '', weight: s.declared?.weight ?? '', captain: s.isCaptain, sailor: s })),
      ...(team.declaration?.unmatched ?? []).map((m, i) => ({ key: `u${i}`, number: m.number, first: m.name, last: '', position: m.position, weight: m.weight, captain: false })),
    ];
  return { lines, source };
}

function TeamCard({ team, colour, lineup, points, onOpen }: { team: OverviewTeam; colour?: Gradient | null; lineup?: LineupPlace[]; points?: string; onOpen: () => void }) {
  const flag = flagOf(team);
  const { lines } = crewOf(team, lineup);
  const hasPos = lines.some((l) => l.position); // no declaration yet: no empty position column
  const bg = css(colour);
  // the crew fills the card: the font grows with the screen height and shrinks for a long crew
  const rows = Math.max(5, lines.length);
  const font = `calc(clamp(15px, calc((100vh - 250px) / ${rows} * 0.32), 32px) * var(--cs, 1))`;
  return (
    <button type="button" onClick={onOpen} title="Open this team"
      className="card group flex min-h-0 flex-col overflow-hidden text-left transition-shadow hover:ring-2 hover:ring-accent-500">
      <header className="relative w-full shrink-0 px-3 py-2" style={{ background: bg ?? '#1b212a' }}>
        <div className="absolute inset-0 bg-gradient-to-r from-[#0e1217]/80 via-[#0e1217]/55 to-[#0e1217]/20" aria-hidden />
        <div className="relative flex items-center gap-3">
          <div className="flex h-12 w-[72px] shrink-0 items-center justify-center overflow-hidden rounded bg-[#0e1217]/60 shadow">
            {flag ? <img src={flag} alt="" className="max-h-full max-w-full object-contain" /> : null}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-mono text-3xl font-black leading-none text-white drop-shadow">{team.code}</div>
            <div className="truncate text-base font-semibold text-white/85">{team.name}</div>
          </div>
          {points && (
            <div className="shrink-0 rounded-md bg-[#0e1217]/70 px-2.5 py-1 text-center" title="Points in the group">
              <div className="text-2xl font-black leading-tight tabular-nums text-white">{points}</div>
              <div className="text-[11px] uppercase leading-tight text-[#a3afbf]">pts</div>
            </div>
          )}
          <span className="shrink-0 text-2xl leading-none text-white/50 transition-colors group-hover:text-white" aria-hidden>›</span>
        </div>
      </header>
      <ol className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto" style={{ fontSize: font }}>
        {lines.map((l) => {
          const best = l.sailor ? [l.sailor.bestResult1, l.sailor.bestResult2, l.sailor.bestResult3].filter(Boolean) : [];
          return (
            <li key={l.key} className="flex min-h-0 flex-1 items-center gap-[0.4em] border-b border-ink-800/60 px-[0.4em] py-[0.15em] last:border-0">
              {hasPos && <span className="w-[4.2em] shrink-0 text-[0.6em] font-bold uppercase leading-tight text-sky-300">{l.position || '—'}</span>}
              <span className="w-[1.6em] shrink-0 text-right font-mono font-black tabular-nums text-ink-300">{l.number}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold leading-tight text-ink-50" title={`${l.first} ${l.last}`}>
                  {l.captain && <span className="mr-[0.2em] text-amber-400">★</span>}
                  {l.first} <span className="font-black uppercase">{l.last}</span>
                </span>
                {best.length > 0 && <span className="block truncate text-[0.5em] leading-tight text-ink-400" title={best.join('\n')}>🏆 {best.join(' · ')}</span>}
              </span>
            </li>
          );
        })}
        {!lines.length && <li className="px-3 py-4 text-center text-base text-ink-600">No crew yet</li>}
      </ol>
    </button>
  );
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

function Chip({ label, value, title }: { label: string; value: string; title?: string }) {
  return <span className="rounded bg-ink-950/60 px-1.5 py-0.5" title={title}><span className="text-ink-500">{label} </span><b className="text-ink-100">{value}</b></span>;
}

function EmptyCard({ place, label }: { place: number; label: string | null }) {
  return (
    <section className="card flex flex-col items-center justify-center border-dashed text-ink-500">
      <span className="text-sm font-bold tabular-nums">Place {place}</span>
      <span className="mt-1 font-mono text-2xl font-bold text-ink-400">{label ?? 'To be decided'}</span>
    </section>
  );
}

// ---------- one team on its own (click a card): the crew in very large type and everything about the team ----------
const kg = (v: string | undefined | null) => { const n = Number(String(v ?? '').replace(',', '.')); return n > 0 ? n : 0; };

function TeamFocus({ team, colour, lineup, points, races, history, note, group, groupName, onClose, onStep }: {
  team: OverviewTeam; colour?: Gradient | null; lineup?: LineupPlace[]; points?: string; races?: string[]; history?: History; note?: string;
  group: OverviewTeam[]; groupName: string; onClose: () => void; onStep: (d: number) => void;
}) {
  const flag = team.assets.flag_big?.previewUrl ?? flagOf(team);
  const captain = team.sailors.find((s) => s.isCaptain);
  const { lines } = crewOf(team, lineup);
  const hasPos = lines.some((l) => l.position);
  const country = COUNTRY_FACTS[team.code.toUpperCase()];
  const rows = Math.max(6, lines.length);
  const font = `calc(clamp(24px, calc((100vh - 330px) / ${rows} * 0.36), 60px) * var(--cs, 1))`;

  // talking points worked out from the data
  const facts: string[] = [];
  const ranked = group.filter((t) => Number(t.ranking) > 0).sort((a, b) => Number(a.ranking) - Number(b.ranking));
  const rr = ranked.findIndex((t) => t.id === team.id);
  if (rr >= 0 && ranked.length > 1) facts.push(rr === 0 ? `Best ranked team in ${groupName}` : rr === ranked.length - 1 ? `Lowest ranked team in ${groupName}` : `${ordinal(rr + 1)} of ${ranked.length} in ${groupName} by world ranking`);
  const weights = group.map((t) => ({ t, w: kg(t.declaration?.totalWeight) })).filter((x) => x.w > 0);
  const mine = kg(team.declaration?.totalWeight);
  if (mine && weights.length > 1) {
    const avg = weights.reduce((a, x) => a + x.w, 0) / weights.length;
    const sorted = [...weights].sort((a, b) => b.w - a.w);
    const d = Math.round((mine - avg) * 10) / 10;
    facts.push(`${sorted[0].t.id === team.id ? 'Heaviest crew in the group' : sorted[sorted.length - 1].t.id === team.id ? 'Lightest crew in the group' : 'Crew weight'}: ${mine} kg (${d >= 0 ? '+' : ''}${d} kg vs the group average)`);
  }
  const sw = lines.map((l) => ({ l, w: kg(l.weight) })).filter((x) => x.w > 0).sort((a, b) => b.w - a.w);
  if (sw.length > 1) {
    facts.push(`Average sailor: ${Math.round((sw.reduce((a, x) => a + x.w, 0) / sw.length) * 10) / 10} kg`);
    facts.push(`Heaviest: ${sw[0].l.first} ${sw[0].l.last} (${sw[0].w} kg) · lightest: ${sw[sw.length - 1].l.first} ${sw[sw.length - 1].l.last} (${sw[sw.length - 1].w} kg)`);
  }
  const decorated = lines.filter((l) => l.sailor?.bestResult1).length;
  if (decorated) facts.push(`${decorated} of ${lines.length} sailors with notable results`);
  if (races?.length) facts.push(`Results here: ${races.join(' · ')}`);
  for (const h of history ?? []) facts.push(`${h.stage}: ${ordinal(h.rank)} of ${h.of} in ${groupTitle(h.group)}${h.total ? ` (${h.total} pts)` : ''}`);

  const stats: [string, string][] = ([
    ['Points', points ?? ''], ['World rank', team.ranking ? `#${team.ranking}` : ''], ['Ranking pts', team.rankingPoints],
    ['Crew', team.declaration?.totalWeight ? `${team.declaration.totalWeight} kg` : ''], ['Sailors', lines.length ? String(lines.length) : ''],
  ] as [string, string][]).filter(([, v]) => v);
  const at = group.findIndex((t) => t.id === team.id);
  const prev = group[(at - 1 + group.length) % group.length];
  const next = group[(at + 1) % group.length];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
    <nav className="flex shrink-0 items-center gap-2" style={{ zoom: 'var(--cs, 1)' } as React.CSSProperties}>
      <button onClick={onClose} title="Esc" className="rounded-md border border-ink-700 bg-ink-900 px-3 py-1.5 text-base font-semibold text-ink-100 hover:bg-ink-800">← Back to {groupName}</button>
      {group.length > 1 && (
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => onStep(-1)} title="Key ←" className="rounded-md border border-ink-700 bg-ink-900 px-3 py-1.5 text-base font-semibold text-ink-100 hover:bg-ink-800">‹ {prev.code}</button>
          <button onClick={() => onStep(1)} title="Key →" className="rounded-md border border-ink-700 bg-ink-900 px-3 py-1.5 text-base font-semibold text-ink-100 hover:bg-ink-800">{next.code} ›</button>
        </div>
      )}
    </nav>
    <section className="card flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="relative shrink-0 px-4 py-3" style={{ background: css(colour) ?? '#1b212a', zoom: 'var(--cs, 1)' } as React.CSSProperties}>
        <div className="absolute inset-0 bg-gradient-to-r from-[#0e1217]/85 via-[#0e1217]/55 to-[#0e1217]/25" aria-hidden />
        <div className="relative flex items-center gap-5">
          <div className="flex h-24 w-36 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#0e1217]/60 shadow-lg">
            {flag ? <img src={flag} alt="" className="max-h-full max-w-full object-contain" /> : null}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-6xl font-black leading-none text-white drop-shadow">{team.code}</span>
              <span className="truncate text-3xl font-bold text-white/90">{team.name}</span>
            </div>
            <div className="mt-1 truncate text-xl">
              {team.nickname && <span className="font-bold uppercase tracking-wide text-white/85">“{team.nickname}” </span>}
              {captain && <span className="text-[#fde68a]">★ {captain.firstName} {captain.lastName}</span>}
            </div>
          </div>
          <dl className="flex shrink-0 gap-2">
            {stats.map(([k, v]) => (
              <div key={k} className="min-w-[96px] rounded-lg bg-[#0e1217]/70 px-3 py-1.5 text-center">
                <dd className="text-3xl font-black tabular-nums leading-tight text-white">{v}</dd>
                <dt className="text-xs uppercase tracking-wide text-[#a3afbf]">{k}</dt>
              </div>
            ))}
          </dl>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(320px,26%)]">
        <ol className="flex min-h-0 flex-col overflow-y-auto" style={{ fontSize: font }} aria-label="Crew">
          {lines.map((l) => {
            const best = l.sailor ? [l.sailor.bestResult1, l.sailor.bestResult2, l.sailor.bestResult3].filter(Boolean) : [];
            return (
              <li key={l.key} className="flex min-h-0 flex-1 items-center gap-[0.5em] border-b border-ink-800/60 px-[0.5em] py-[0.1em] last:border-0">
                {hasPos && <span className="w-[5em] shrink-0 text-[0.55em] font-bold uppercase leading-tight text-sky-300">{l.position || '—'}</span>}
                <span className="w-[1.6em] shrink-0 text-right font-mono font-black tabular-nums text-ink-300">{l.number}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold leading-tight text-ink-50">
                    {l.captain && <span className="mr-[0.2em] text-amber-400">★</span>}
                    {l.first} <span className="font-black uppercase">{l.last}</span>
                  </span>
                  {best.length > 0 && <span className="block truncate text-[0.42em] leading-snug text-ink-400" title={best.join('\n')}>🏆 {best.join(' · ')}</span>}
                </span>
                {l.weight && <span className="shrink-0 text-[0.45em] tabular-nums text-ink-400">{l.weight} kg</span>}
              </li>
            );
          })}
          {!lines.length && <li className="px-3 py-6 text-center text-2xl text-ink-600">No crew yet</li>}
        </ol>
        <aside className="min-h-0 space-y-4 overflow-y-auto border-l border-ink-800 bg-ink-950/40 p-4" style={{ fontSize: 'calc(17px * var(--cs, 1))' }}>
          {facts.length > 0 && (
            <div>
              <h3 className="mb-1 text-[0.75em] font-bold uppercase tracking-wide text-ink-400">Talking points</h3>
              <ul className="space-y-1.5 text-ink-100">{facts.map((f, i) => <li key={i}>• {f}</li>)}</ul>
            </div>
          )}
          {note && (
            <div>
              <h3 className="mb-1 text-[0.75em] font-bold uppercase tracking-wide text-ink-400">Notes</h3>
              <p className="whitespace-pre-line text-ink-100">{note}</p>
            </div>
          )}
          {country && (
            <div>
              <h3 className="mb-1 text-[0.75em] font-bold uppercase tracking-wide text-ink-400">{team.name}</h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-ink-500">Capital</dt><dd className="text-ink-100">{country.capital}</dd>
                <dt className="text-ink-500">Region</dt><dd className="text-ink-100">{country.region}</dd>
                <dt className="text-ink-500">Population</dt><dd className="text-ink-100">{country.population}</dd>
                <dt className="text-ink-500">Languages</dt><dd className="text-ink-100">{country.languages}</dd>
              </dl>
            </div>
          )}
          {!note && <p className="text-[0.75em] text-ink-500">Your own facts about the team go in Teams → the team's notes; they show here.</p>}
        </aside>
      </div>
    </section>
    </div>
  );
}

// ---------- the next race, with a countdown to its time ----------
function NextRace({ x, tz, teamById }: { x: CommentatorData; tz: string; teamById: Map<string, OverviewTeam> }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  void teamById;
  const items = x.schedule;
  // minutes since midnight at the venue
  let mins = 0;
  try { const [h, m] = new Date(now).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).split(':').map(Number); mins = h * 60 + m; } catch { /* keep 0 */ }
  const at = (t: string) => { const m = t.match(/^(\d{1,2})[:.](\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const it = items.find((i) => i.id === x.nextRace) ?? items.find((i) => statusTone(i.status) === 'next') ?? (x.date === todayIn(tz) ? items.find((i) => (at(i.time) ?? -1) >= mins) : undefined);
  if (!it) return null;
  const t = at(it.time);
  const left = t !== null && x.date === todayIn(tz) ? t - mins : null;
  const race = /^\d+$/.test(it.race.trim()) ? `Race ${it.race.trim()}` : it.race;
  return (
    <div className="flex shrink-0 items-center gap-2 rounded-md border border-sky-700 bg-sky-950/40 px-2 py-1" title="The next race (marked on General → Schedule)">
      <span className="rounded bg-sky-600 px-1 text-[10px] font-bold uppercase text-white">Next</span>
      <b className="text-lg text-ink-50">{race}</b>
      {it.fleet && <span className="text-base text-ink-300">{groupTitle(it.fleet)}</span>}
      {it.time && <span className="font-mono text-sm tabular-nums text-ink-100">{it.time}</span>}
      {left !== null && left > 0 && <span className="text-xs text-sky-300">in {left >= 60 ? `${Math.floor(left / 60)} h ${left % 60} min` : `${left} min`}</span>}
    </div>
  );
}

// ---------- Info (key I): every group's standing, race officials, commentators, socials ----------
function InfoPanel({ x, teamById, fleets, onGroup, onClose }: { x: CommentatorData; teamById: Map<string, OverviewTeam>; fleets: FleetSetDetail['fleets']; onGroup: (id: string) => void; onClose: () => void }) {
  const commentators = (x.people ?? []).filter((p) => /comment|host|present|anchor|analyst|reporter/i.test(p.role) || !p.role);
  const others = (x.people ?? []).filter((p) => !commentators.includes(p));
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-ink-950/70 p-6" onClick={onClose}>
      <div className="card max-h-full w-full max-w-6xl overflow-y-auto p-4" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Info">
        <div className="mb-3 flex items-center">
          <h2 className="text-lg font-black uppercase tracking-wide text-ink-50">Info</h2>
          <span className="ml-3 text-xs text-ink-500">I or Esc closes</span>
          <button onClick={onClose} className="ml-auto rounded px-2 text-ink-400 hover:text-ink-100" aria-label="Close">✕</button>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <section className="col-span-2">
            <h3 className="mb-1 text-xs font-bold uppercase text-ink-400">All groups of the stage</h3>
            <div className="grid grid-cols-2 gap-2">
              {x.results.map((g) => {
                const f = fleets.find((ff) => ff.id === g.fleetId);
                                return (
                  <button key={g.fleetId} onClick={() => f && onGroup(f.id)} className="flex flex-col justify-start rounded-md border border-ink-800 bg-ink-900 p-2 text-left hover:border-ink-600">
                    <div className="mb-1 text-sm font-bold text-ink-100">{groupTitle(g.title || g.fleetName)}</div>
                    <table className="w-full table-fixed text-sm">
                      <tbody>
                        {g.rows.map((r) => {
                          const t = teamById.get(r.teamId);
                          const fl = t && flagOf(t);
                          return (
                            <tr key={r.teamId}>
                                                            <td className="w-6">{fl && <img src={fl} alt="" className="h-3 w-[18px] rounded-[2px] object-cover" />}</td>
                              <td className="w-12 font-mono font-bold text-ink-50">{t?.code ?? '?'}</td>
                              <td className="truncate text-xs text-ink-400">{t?.name}</td>
                              <td className="w-24 text-right font-mono text-xs tabular-nums text-ink-400">{r.races.filter((v) => v !== '').join(' · ')}</td>
                              <td className="w-10 text-right font-bold tabular-nums text-accent-200">{r.total}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </button>
                );
              })}
            </div>
          </section>
          <section className="space-y-3 text-sm">
            {(x.weather.forecast || x.weather.wind_speed) && (
              <div>
                <h3 className="mb-1 text-xs font-bold uppercase text-ink-400">Weather</h3>
                <p className="text-ink-200">{[x.weather.wind_speed && `Wind ${x.weather.wind_speed}`, [x.weather.wind_degrees && `${x.weather.wind_degrees}°`, x.weather.wind_direction].filter(Boolean).join(' '), x.weather.air_temp && `Air ${x.weather.air_temp}`, x.weather.forecast].filter(Boolean).join(' · ')}</p>
              </div>
            )}
            {commentators.length > 0 && <PeopleList title="Commentators" people={commentators} />}
            {others.length > 0 && <PeopleList title="People" people={others} />}
            {x.officials?.length ? (
              <div>
                <h3 className="mb-1 text-xs font-bold uppercase text-ink-400">Race officials</h3>
                <dl className="space-y-1">
                  {x.officials.map((o) => <div key={o.role}><dt className="text-[11px] uppercase text-ink-500">{o.role}</dt><dd className="text-ink-100">{o.names.join(', ')}</dd></div>)}
                </dl>
              </div>
            ) : null}
            {x.socials && (x.socials.hashtag || x.socials.website || x.socials.handles.length > 0) && (
              <div>
                <h3 className="mb-1 text-xs font-bold uppercase text-ink-400">Follow us</h3>
                <p className="text-ink-100">{[x.socials.hashtag, x.socials.website, ...x.socials.handles].filter(Boolean).join(' · ')}</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function PeopleList({ title, people }: { title: string; people: { name: string; role: string }[] }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-bold uppercase text-ink-400">{title}</h3>
      <ul>{people.map((p, i) => <li key={i} className="text-ink-100">{p.name}{p.role && <span className="text-xs text-ink-500"> · {p.role}</span>}</li>)}</ul>
    </div>
  );
}
