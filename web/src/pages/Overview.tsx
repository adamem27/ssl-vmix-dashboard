import { Fragment, KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMeta } from '../App';
import { api, FleetSetDetail, FleetSetSummary, Overview, OverviewSailor, OverviewTeam } from '../api';
import { Badge, Button, cx, ErrorBox, Loading, todayIn, useToast } from '../components/ui';
import { Cell, ImgCell } from '../components/cells';

const SHORT: Record<string, string> = {
  background_1: 'BG1', background_2: 'BG2', emblem_dark: 'EM D', emblem_light: 'EM L', flag_small: 'FL S', flag_big: 'FL B',
  lowerthird_photo: 'LT P', lowerthird_anthem: 'LT A', sponsor_1: 'SP1', sponsor_2: 'SP2', sponsor_3: 'SP3',
};

const LS_KEY = 'overview.v1';
function loadPrefs(): { setId?: string; open?: string[] } {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}'); } catch { return {}; }
}
function savePrefs(p: ReturnType<typeof loadPrefs>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}
const shiftDate = (d: string, days: number) => new Date(Date.parse(d + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fullName = (s: { firstName: string; lastName: string }) => `${s.firstName} ${s.lastName}`.trim();

export function OverviewPage() {
  const meta = useMeta();
  const qc = useQueryClient();
  const tz = meta.data?.event.timezone ?? 'UTC';
  const prefs = useMemo(loadPrefs, []);
  const [date, setDate] = useState<string | null>(null);
  const [setId, setSetId] = useState<string>(prefs.setId ?? '');
  const [open, setOpen] = useState<Set<string>>(new Set(prefs.open ?? []));
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const day = date ?? todayIn(tz);

  const sets = useQuery({ queryKey: ['fleet-sets'], queryFn: () => api.get<FleetSetSummary[]>('/api/fleet-sets') });
  const validSet = sets.data?.some((s) => s.id === setId) ? setId : '';
  const data = useQuery({
    queryKey: ['overview', day, validSet],
    queryFn: () => api.get<Overview>(`/api/overview?date=${day}${validSet ? `&set=${validSet}` : ''}`),
    enabled: !!meta.data,
    refetchInterval: 30_000,
  });
  const setDetail = useQuery({ queryKey: ['fleet-set', validSet], queryFn: () => api.get<FleetSetDetail>(`/api/fleet-sets/${validSet}`), enabled: !!validSet });
  useEffect(() => savePrefs({ setId: validSet, open: [...open] }), [validSet, open]);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['overview'] }); qc.invalidateQueries({ queryKey: ['teams'] }); };

  const query = norm(q.trim());
  const rows = useMemo(() => {
    const list = (data.data?.teams ?? []).map((t) => {
      if (!query) return { t, hits: null as Set<string> | null };
      const teamHit = norm(`${t.code} ${t.name}`).includes(query);
      const hits = new Set(t.sailors.filter((s) => norm(fullName(s)).includes(query)).map((s) => s.id));
      return teamHit || hits.size ? { t, hits: teamHit ? null : hits } : null;
    }).filter((x): x is { t: OverviewTeam; hits: Set<string> | null } => !!x);
    if (!validSet) return list;
    return [...list].sort((a, b) => {
      const pa = a.t.place, pb = b.t.place;
      if (!pa || !pb) return pa ? -1 : pb ? 1 : a.t.name.localeCompare(b.t.name);
      return pa.fleetName.localeCompare(pb.fleetName, undefined, { numeric: true }) || pa.position - pb.position;
    });
  }, [data.data, query, validSet]);

  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOpen = rows.length > 0 && rows.every((r) => open.has(r.t.id));
  const cols = 8 + (meta.data?.teamSlots.length ?? 11);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-60 py-1.5 text-sm" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search team or sailor" />
        <div className="flex items-center" role="group" aria-label="Day">
          <Button size="sm" variant="ghost" onClick={() => setDate(shiftDate(day, -1))} aria-label="Previous day">‹</Button>
          <input type="date" className="input w-40 py-1.5 text-sm" value={day} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Day" />
          <Button size="sm" variant="ghost" onClick={() => setDate(shiftDate(day, 1))} aria-label="Next day">›</Button>
        </div>
        <select className="input w-60 py-1.5 text-sm" value={validSet} onChange={(e) => setSetId(e.target.value)} aria-label="Fleet set">
          <option value="">Fleet set: none</option>
          {(sets.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div className="ml-auto flex gap-2">
          <Button size="sm" onClick={() => setOpen(allOpen ? new Set() : new Set(rows.map((r) => r.t.id)))}>{allOpen ? 'Collapse all' : 'Expand all'}</Button>
          <Button size="sm" onClick={() => navigate('/vmix/json')}>JSON</Button>
        </div>
      </div>

      {data.isLoading || meta.isLoading ? <Loading /> : data.error ? <ErrorBox error={data.error} onRetry={() => data.refetch()} /> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[1200px] border-collapse text-sm">
            <thead className="bg-ink-900 text-left text-[10px] uppercase tracking-wide text-ink-400">
              <tr className="border-b border-ink-800">
                <th className="w-7 px-1 py-2" />
                <th className="w-20 px-2 py-2">Code</th>
                <th className="px-2 py-2">Team</th>
                <th className="px-2 py-2">Nickname</th>
                <th className="w-40 px-2 py-2">Fleet</th>
                {meta.data!.teamSlots.map((s) => <th key={s.key} className="w-12 px-0.5 py-2 text-center" title={s.label}>{SHORT[s.key] ?? s.label}</th>)}
                <th className="w-14 px-2 py-2 text-right">Crew</th>
                <th className="w-24 px-2 py-2">Declared</th>
                <th className="w-8 px-1 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ t, hits }) => {
                const isOpen = open.has(t.id) || (hits !== null && hits.size > 0);
                return (
                  <Fragment key={t.id}>
                    <TeamRow team={t} isOpen={isOpen} onToggle={() => toggle(t.id)} set={validSet ? setDetail.data : undefined} onChanged={refresh} />
                    {isOpen && (
                      <tr className="border-b border-ink-800 bg-ink-950/70">
                        <td />
                        <td colSpan={cols - 1} className="px-2 pb-2 pt-1"><CrewTable team={t} hits={hits} onChanged={refresh} /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              <NewTeamRow cols={cols} onCreated={refresh} />
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- team row ----------
function TeamRow({ team: t, isOpen, onToggle, set, onChanged }: { team: OverviewTeam; isOpen: boolean; onToggle: () => void; set?: FleetSetDetail; onChanged: () => void }) {
  const toast = useToast();
  const meta = useMeta();
  const captain = t.sailors.find((s) => s.isCaptain);
  const save = async (patch: Record<string, string>) => {
    try { await api.patch(`/api/teams/${t.id}`, patch); onChanged(); } catch (e) { toast.error(e); throw e; }
  };
  const remove = async () => {
    if (!confirm(`Delete ${t.code} – ${t.name} with its sailors and graphics?`)) return;
    try { await api.del(`/api/teams/${t.id}`); onChanged(); } catch (e) { toast.error(e); }
  };
  return (
    <tr className={cx('group border-b border-ink-800/70 hover:bg-ink-850', isOpen && 'bg-ink-900')}>
      <td className="px-1 text-center">
        <button className="h-8 w-6 text-ink-400 hover:text-ink-50" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} crew of ${t.name}`} onClick={onToggle}>{isOpen ? '▾' : '▸'}</button>
      </td>
      <td className="px-1"><Cell value={t.code} onSave={(v) => save({ code: v })} className="font-mono font-bold text-ink-50" required label="Code" /></td>
      <td className="px-1">
        <div className="flex items-center gap-1.5">
          <Cell value={t.name} onSave={(v) => save({ name: v })} className="font-medium text-ink-100" required label="Team name" />
          {t.isDemo && <Badge tone="demo">Demo</Badge>}
          {captain && <span className="shrink-0 truncate text-xs text-amber-300" title="Captain">★ {fullName(captain)}</span>}
        </div>
      </td>
      <td className="px-1"><Cell value={t.nickname} onSave={(v) => save({ nickname: v })} className="text-ink-300" label="Nickname" /></td>
      <td className="px-1">{set ? <FleetPicker team={t} set={set} onChanged={onChanged} /> : <span className="px-1 text-ink-600">—</span>}</td>
      {meta.data!.teamSlots.map((s) => (
        <td key={s.key} className="px-0.5 py-1"><ImgCell kind="teams" ownerId={t.id} slot={s.key} label={`${t.code} · ${s.label}`} asset={t.assets[s.key]} onChanged={onChanged} /></td>
      ))}
      <td className="px-2 text-right tabular-nums text-ink-300">{t.sailors.length}</td>
      <td className="px-2">
        {t.declaration ? (
          <span className="flex gap-1">
            <Badge tone="ok">{t.declaration.members}</Badge>
            {t.declaration.unmatched.length > 0 && <Badge tone="warn" title="Not in roster">{t.declaration.unmatched.length} ?</Badge>}
          </span>
        ) : <span className="text-ink-600">—</span>}
      </td>
      <td className="px-1 text-center">
        <button onClick={remove} className="invisible rounded px-1 text-ink-500 hover:text-red-300 group-hover:visible" aria-label={`Delete ${t.name}`}>✕</button>
      </td>
    </tr>
  );
}

function FleetPicker({ team, set, onChanged }: { team: OverviewTeam; set: FleetSetDetail; onChanged: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const codes = useQuery({ queryKey: ['teams-codes'], queryFn: () => api.get<{ id: string; code: string }[]>('/api/teams'), staleTime: 10_000 });
  const codeOf = (id: string) => codes.data?.find((t) => t.id === id)?.code ?? '?';
  const current = set.fleets.flatMap((f) => f.positions.map((p, i) => (p === team.id ? `${f.id}:${i + 1}` : null))).find(Boolean) ?? '';
  const change = async (v: string) => {
    try {
      if (!v) await api.post(`/api/fleet-sets/${set.set.id}/unassign`, { teamId: team.id });
      else {
        const [fleetId, pos] = v.split(':');
        await api.post(`/api/fleet-sets/${set.set.id}/place`, { teamId: team.id, fleetId, position: Number(pos), onOccupied: 'swap' });
      }
      qc.invalidateQueries({ queryKey: ['fleet-set', set.set.id] });
      qc.invalidateQueries({ queryKey: ['fleet-sets'] });
      onChanged();
    } catch (e) { toast.error(e); }
  };
  return (
    <select className="w-full rounded border border-transparent bg-transparent px-1 py-1 text-sm text-ink-100 hover:border-ink-700 focus:border-accent-400 focus:outline-none" value={current} onChange={(e) => change(e.target.value)} aria-label={`Fleet of ${team.name}`}>
      <option value="">—</option>
      {set.fleets.map((f) => (
        <optgroup key={f.id} label={f.name}>
          {f.positions.map((p, i) => (
            <option key={i} value={`${f.id}:${i + 1}`}>
              {f.name} · {i + 1}{p && p !== team.id ? `  (${codeOf(p)})` : !p && f.placeholders?.[i] ? `  [${f.placeholders[i]}]` : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function NewTeamRow({ cols, onCreated }: { cols: number; onCreated: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const add = async () => {
    if (!code.trim() || !name.trim()) return;
    try { await api.post('/api/teams', { code, name }); setCode(''); setName(''); onCreated(); } catch (e) { toast.error(e); }
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') void add(); };
  return (
    <tr className="bg-ink-950/40">
      <td className="px-1 text-center text-ink-500">+</td>
      <td className="px-1 py-1"><input className="input py-1 font-mono text-sm uppercase" placeholder="CODE" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={onKey} aria-label="New team code" /></td>
      <td className="px-1 py-1"><input className="input py-1 text-sm" placeholder="New team" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onKey} aria-label="New team name" /></td>
      <td />
      <td className="px-1 py-1"><Button size="sm" variant="primary" disabled={!code.trim() || !name.trim()} onClick={add}>Add</Button></td>
      <td colSpan={cols - 5} />
    </tr>
  );
}

// ---------- crew ----------
function CrewTable({ team, hits, onChanged }: { team: OverviewTeam; hits: Set<string> | null; onChanged: () => void }) {
  const hasDecl = !!team.declaration;
  const sailors = [...team.sailors].sort((a, b) => {
    if (a.isCaptain !== b.isCaptain) return a.isCaptain ? -1 : 1;
    if (a.declared && b.declared) return a.declared.sort - b.declared.sort;
    return a.declared ? -1 : b.declared ? 1 : 0;
  });
  return (
    <table className="w-full table-fixed text-sm">
      <thead className="text-left text-[10px] uppercase tracking-wide text-ink-500">
        <tr>
          <th className="w-8 py-1" title="Captain">C</th>
          <th className="w-14 py-1">Photo</th>
          <th className="w-16 py-1">No.</th>
          <th className="w-40 py-1">First name</th>
          <th className="w-48 py-1">Last name</th>
          <th className="w-44 py-1">Position</th>
          <th className="py-1">Best result 1</th>
          <th className="py-1">Best result 2</th>
          <th className="w-20 py-1" title="From the day’s declaration">Day no.</th>
          <th className="w-36 py-1" title="From the day’s declaration">Day position</th>
          <th className="w-8 py-1" />
        </tr>
      </thead>
      <tbody>
        {sailors.map((s) => <SailorRow key={s.id} s={s} hasDecl={hasDecl} highlight={!!hits?.has(s.id)} onChanged={onChanged} />)}
        {team.declaration?.unmatched.map((m, i) => (
          <tr key={`u${i}`} className="border-t border-ink-800/60 text-amber-200">
            <td />
            <td />
            <td className="px-1 tabular-nums">{m.number}</td>
            <td colSpan={5} className="px-1">{m.name} <Link to="/vmix/declarations" className="ml-1"><Badge tone="warn">Not in roster</Badge></Link></td>
            <td className="px-1 tabular-nums">{m.number}</td>
            <td className="px-1">{m.position}</td>
            <td />
          </tr>
        ))}
        <NewSailorRow teamId={team.id} onCreated={onChanged} />
      </tbody>
    </table>
  );
}

function SailorRow({ s, hasDecl, highlight, onChanged }: { s: OverviewSailor; hasDecl: boolean; highlight: boolean; onChanged: () => void }) {
  const toast = useToast();
  const save = async (patch: Record<string, string>) => {
    try { await api.patch(`/api/sailors/${s.id}`, patch); onChanged(); } catch (e) { toast.error(e); throw e; }
  };
  const remove = async () => {
    if (!confirm(`Delete ${fullName(s)}?`)) return;
    try { await api.del(`/api/sailors/${s.id}`); onChanged(); } catch (e) { toast.error(e); }
  };
  const toggleCaptain = async () => {
    try { await api.post(`/api/sailors/${s.id}/captain`, { value: !s.isCaptain }); onChanged(); } catch (e) { toast.error(e); }
  };
  const dim = hasDecl && !s.declared;
  const differs = (a: string | undefined, b: string) => !!a && a !== b;
  return (
    <tr className={cx('group border-t border-ink-800/60', dim && 'opacity-50', highlight && 'bg-accent-500/10', s.isCaptain && 'bg-amber-500/10')}>
      <td className="text-center">
        <button onClick={toggleCaptain} title={s.isCaptain ? 'Captain' : 'Make captain'} aria-label={s.isCaptain ? `${fullName(s)} is captain` : `Make ${fullName(s)} captain`} aria-pressed={s.isCaptain}
          className={cx('text-lg leading-none', s.isCaptain ? 'text-amber-400' : 'text-ink-700 hover:text-amber-300')}>★</button>
      </td>
      <td className="py-0.5"><ImgCell kind="sailors" ownerId={s.id} slot="photo" label={`${fullName(s)} · Photo`} asset={s.photo} onChanged={onChanged} accept="png+jpg" /></td>
      <td><Cell value={s.defaultNumber} onSave={(v) => save({ defaultNumber: v })} className="tabular-nums" label="Number" /></td>
      <td><Cell value={s.firstName} onSave={(v) => save({ firstName: v })} className="text-ink-50" label="First name" /></td>
      <td><Cell value={s.lastName} onSave={(v) => save({ lastName: v })} className="font-medium text-ink-50" label="Last name" /></td>
      <td><Cell value={s.defaultPosition} onSave={(v) => save({ defaultPosition: v })} label="Position" /></td>
      <td><Cell value={s.bestResult1} onSave={(v) => save({ bestResult1: v })} className="text-ink-300" label="Best result 1" /></td>
      <td><Cell value={s.bestResult2} onSave={(v) => save({ bestResult2: v })} className="text-ink-300" label="Best result 2" /></td>
      <td className={cx('px-1 tabular-nums', differs(s.declared?.number, s.defaultNumber) && 'font-semibold text-amber-200')}>{s.declared?.number || <span className="text-ink-600">—</span>}</td>
      <td className={cx('px-1', differs(s.declared?.position, s.defaultPosition) && 'font-semibold text-amber-200')}>{s.declared?.position || <span className="text-ink-600">—</span>}</td>
      <td className="text-center"><button onClick={remove} className="invisible px-1 text-ink-500 hover:text-red-300 group-hover:visible" aria-label={`Delete ${fullName(s)}`}>✕</button></td>
    </tr>
  );
}

function NewSailorRow({ teamId, onCreated }: { teamId: string; onCreated: () => void }) {
  const toast = useToast();
  const empty = { defaultNumber: '', firstName: '', lastName: '', defaultPosition: '' };
  const [f, setF] = useState(empty);
  const ok = !!(f.firstName.trim() || f.lastName.trim());
  const add = async () => {
    if (!ok) return;
    try { await api.post(`/api/teams/${teamId}/sailors`, f); setF(empty); onCreated(); } catch (e) { toast.error(e); }
  };
  const input = (k: keyof typeof empty, ph: string) => (
    <input className="input py-1 text-sm" placeholder={ph} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void add()} aria-label={`New sailor ${ph}`} />
  );
  return (
    <tr className="border-t border-ink-800/60">
      <td />
      <td className="text-center text-ink-500">+</td>
      <td className="py-1 pr-1">{input('defaultNumber', 'No.')}</td>
      <td className="py-1 pr-1">{input('firstName', 'First name')}</td>
      <td className="py-1 pr-1">{input('lastName', 'Last name')}</td>
      <td className="py-1 pr-1">{input('defaultPosition', 'Position')}</td>
      <td className="py-1"><Button size="sm" variant="primary" disabled={!ok} onClick={add}>Add</Button></td>
      <td colSpan={4} />
    </tr>
  );
}
