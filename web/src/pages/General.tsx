import { KeyboardEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMeta } from '../App';
import { api, Asset, FleetSetDetail, FleetSetSummary } from '../api';
import { Button, cx, ErrorBox, Loading, todayIn, useToast } from '../components/ui';
import { Cell, ImgCell, SelectCell } from '../components/cells';

const CONDITIONS = ['Sunny', 'Mostly sunny', 'Partly cloudy', 'Cloudy', 'Overcast', 'Light rain', 'Rain', 'Showers', 'Thunderstorm', 'Fog', 'Windy'];
const DIRECTIONS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const WIND_UNITS = ['kn', 'm/s', 'km/h', 'mph'];
const STATUSES = ['Scheduled', 'Next', 'Live', 'Finished', 'Postponed', 'Cancelled'];
const LANGUAGES = ['English', 'Polish', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Arabic', 'Chinese', 'Japanese'];

const shiftDate = (d: string, days: number) => new Date(Date.parse(d + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

export function GeneralPage() {
  return (
    <div className="space-y-4">
      <WeatherPanel />
      <SchedulePanel />
      <PeoplePanel />
    </div>
  );
}

function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <header className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-3 py-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink-200">{title}</h2>
        <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>
      </header>
      <div className="p-2">{children}</div>
    </section>
  );
}

// ---------- weather ----------
type Weather = Record<string, string>;

function WeatherPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const w = useQuery({ queryKey: ['weather'], queryFn: () => api.get<Weather>('/api/weather') });
  const save = async (k: string, v: string) => {
    try { qc.setQueryData(['weather'], await api.put<Weather>('/api/weather', { [k]: v })); } catch (e) { toast.error(e); throw e; }
  };
  if (w.isLoading) return <Panel title="Weather"><Loading /></Panel>;
  if (w.error) return <Panel title="Weather"><ErrorBox error={w.error} /></Panel>;
  const d = w.data!;
  const field = (label: string, node: ReactNode) => (
    <div className="min-w-0">
      <div className="px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-500">{label}</div>
      {node}
    </div>
  );
  const text = (k: string, label: string, ph?: string) => field(label, <Cell value={d[k]} onSave={(v) => save(k, v)} label={label} placeholder={ph} className="text-ink-50" />);
  const select = (k: string, label: string, opts: string[]) => field(label, <SelectCell value={d[k]} options={opts} onSave={(v) => save(k, v)} label={label} className="text-ink-50" />);
  return (
    <Panel title="Weather">
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3 lg:grid-cols-9">
        {text('location', 'Location')}
        {select('conditions', 'Conditions', CONDITIONS)}
        {text('air_temp', 'Air °C', '24')}
        {text('water_temp', 'Water °C', '21')}
        {text('wind_speed', 'Wind', '12')}
        {text('wind_gust', 'Gusts', '16')}
        {select('wind_direction', 'Direction', DIRECTIONS)}
        {select('wind_unit', 'Unit', WIND_UNITS)}
        {text('note', 'Note')}
      </div>
    </Panel>
  );
}

// ---------- schedule ----------
interface Item { id: string; date: string; time: string; race: string; fleet: string; status: string; note: string }

function useFleetNames() {
  const sets = useQuery({ queryKey: ['fleet-sets'], queryFn: () => api.get<FleetSetSummary[]>('/api/fleet-sets') });
  const names = useQuery({
    queryKey: ['fleet-names', sets.data?.map((s) => s.id).join()],
    queryFn: async () => {
      const details = await Promise.all((sets.data ?? []).map((s) => api.get<FleetSetDetail>(`/api/fleet-sets/${s.id}`)));
      return [...new Set(details.flatMap((d) => d.fleets.map((f) => f.name)))];
    },
    enabled: !!sets.data,
  });
  return names.data ?? [];
}

function SchedulePanel() {
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const tz = meta.data?.event.timezone ?? 'UTC';
  const [date, setDate] = useState<string | null>(null);
  const day = date ?? todayIn(tz);
  const items = useQuery({ queryKey: ['schedule', day], queryFn: () => api.get<Item[]>(`/api/schedule?date=${day}`) });
  const fleetNames = useFleetNames();
  const refresh = () => qc.invalidateQueries({ queryKey: ['schedule'] });
  const save = async (id: string, patch: Partial<Item>) => {
    try { await api.patch(`/api/schedule/${id}`, patch); refresh(); } catch (e) { toast.error(e); throw e; }
  };
  const remove = async (id: string) => { try { await api.del(`/api/schedule/${id}`); refresh(); } catch (e) { toast.error(e); } };

  const empty = { time: '', race: '', fleet: '' };
  const [f, setF] = useState(empty);
  const add = async () => {
    if (!f.time.trim() && !f.race.trim()) return;
    try { await api.post('/api/schedule', { ...f, date: day, status: 'Scheduled' }); setF(empty); refresh(); } catch (e) { toast.error(e); }
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') void add(); };

  return (
    <Panel title="Schedule" right={
      <div className="flex items-center" role="group" aria-label="Schedule day">
        <Button size="sm" variant="ghost" onClick={() => setDate(shiftDate(day, -1))} aria-label="Previous day">‹</Button>
        <input type="date" className="input w-40 py-1 text-sm" value={day} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Schedule day" />
        <Button size="sm" variant="ghost" onClick={() => setDate(shiftDate(day, 1))} aria-label="Next day">›</Button>
      </div>
    }>
      {items.error ? <ErrorBox error={items.error} /> : (
        <table className="w-full table-fixed text-sm">
          <thead className="text-left text-[10px] uppercase tracking-wide text-ink-500">
            <tr><th className="w-24 px-1 py-1">Time</th><th className="px-1 py-1">Race</th><th className="w-48 px-1 py-1">Fleet</th><th className="w-36 px-1 py-1">Status</th><th className="px-1 py-1">Note</th><th className="w-8" /></tr>
          </thead>
          <tbody>
            {(items.data ?? []).map((it) => (
              <tr key={it.id} className={cx('group border-t border-ink-800/60', it.status === 'Live' && 'bg-red-950/30', it.status === 'Next' && 'bg-sky-950/30')}>
                <td><Cell value={it.time} onSave={(v) => save(it.id, { time: v })} label="Time" className="font-mono tabular-nums text-ink-50" /></td>
                <td><Cell value={it.race} onSave={(v) => save(it.id, { race: v })} label="Race" className="text-ink-50" /></td>
                <td><Cell value={it.fleet} onSave={(v) => save(it.id, { fleet: v })} label="Fleet" suggestions={fleetNames} /></td>
                <td><SelectCell value={it.status} options={STATUSES} onSave={(v) => save(it.id, { status: v })} label="Status" /></td>
                <td><Cell value={it.note} onSave={(v) => save(it.id, { note: v })} label="Note" className="text-ink-300" /></td>
                <td className="text-center"><button onClick={() => remove(it.id)} className="invisible px-1 text-ink-500 hover:text-red-300 group-hover:visible" aria-label="Delete row">✕</button></td>
              </tr>
            ))}
            <tr className="border-t border-ink-800/60">
              <td className="py-1 pr-1"><input className="input py-1 font-mono text-sm" placeholder="14:00" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} onKeyDown={onKey} aria-label="New time" /></td>
              <td className="py-1 pr-1"><input className="input py-1 text-sm" placeholder="Race" value={f.race} onChange={(e) => setF({ ...f, race: e.target.value })} onKeyDown={onKey} aria-label="New race" /></td>
              <td className="py-1 pr-1">
                <input className="input py-1 text-sm" placeholder="Fleet" list="dl-new-fleet" value={f.fleet} onChange={(e) => setF({ ...f, fleet: e.target.value })} onKeyDown={onKey} aria-label="New fleet" />
                <datalist id="dl-new-fleet">{fleetNames.map((n) => <option key={n} value={n} />)}</datalist>
              </td>
              <td className="py-1"><Button size="sm" variant="primary" onClick={add} disabled={!f.time.trim() && !f.race.trim()}>Add</Button></td>
              <td colSpan={2} />
            </tr>
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ---------- people ----------
interface Person { id: string; name: string; role: string; language: string; title: string; photo: Asset | null }

function PeoplePanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['people'], queryFn: () => api.get<{ people: Person[]; roles: string[] }>('/api/people') });
  const [lang, setLang] = useState('');
  const [newLang, setNewLang] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['people'] });
  const save = async (id: string, patch: Partial<Person>) => {
    try { await api.patch(`/api/people/${id}`, patch); refresh(); } catch (e) { toast.error(e); throw e; }
  };
  const remove = async (p: Person) => {
    if (!confirm(`Delete ${p.name || p.role || 'this person'}?`)) return;
    try { await api.del(`/api/people/${p.id}`); refresh(); } catch (e) { toast.error(e); }
  };
  const addSet = async () => {
    if (!newLang.trim()) return;
    try { await api.post('/api/people/commentator-set', { language: newLang.trim() }); setLang(newLang.trim()); setNewLang(''); refresh(); } catch (e) { toast.error(e); }
  };
  const empty = { name: '', role: '', language: '', title: '' };
  const [f, setF] = useState(empty);
  useEffect(() => setF((x) => ({ ...x, language: lang })), [lang]);
  const add = async () => {
    if (!f.name.trim() && !f.role) return;
    try { await api.post('/api/people', f); setF({ ...empty, language: lang }); refresh(); } catch (e) { toast.error(e); }
  };

  const people = q.data?.people ?? [];
  const roles = q.data?.roles ?? [];
  const languages = useMemo(() => [...new Set(people.map((p) => p.language).filter(Boolean))].sort(), [people]);
  const shown = lang ? people.filter((p) => p.language === lang) : people;
  const langSuggestions = [...new Set([...languages, ...LANGUAGES])];

  return (
    <Panel title="People" right={<>
      <div className="flex flex-wrap gap-1">
        {['', ...languages].map((l) => (
          <button key={l || 'all'} onClick={() => setLang(l)} className={cx('rounded px-2 py-1 text-xs font-medium', lang === l ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:bg-ink-850 hover:text-ink-100')}>{l || 'All'}</button>
        ))}
      </div>
      <input className="input w-32 py-1 text-sm" list="dl-set-lang" placeholder="Language" value={newLang} onChange={(e) => setNewLang(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void addSet()} aria-label="Language for commentator set" />
      <datalist id="dl-set-lang">{langSuggestions.map((l) => <option key={l} value={l} />)}</datalist>
      <Button size="sm" onClick={addSet} disabled={!newLang.trim()}>+ 3 commentators</Button>
    </>}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <table className="w-full table-fixed text-sm">
          <thead className="text-left text-[10px] uppercase tracking-wide text-ink-500">
            <tr><th className="w-14 px-1 py-1">Photo</th><th className="px-1 py-1">Name</th><th className="w-52 px-1 py-1">Role</th><th className="w-36 px-1 py-1">Language</th><th className="px-1 py-1">Title</th><th className="w-8" /></tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id} className="group border-t border-ink-800/60">
                <td className="py-0.5"><ImgCell kind="people" ownerId={p.id} slot="photo" label={`${p.name || p.role} · Photo`} asset={p.photo} onChanged={refresh} accept="png+jpg" /></td>
                <td><Cell value={p.name} onSave={(v) => save(p.id, { name: v })} label="Name" className="font-medium text-ink-50" /></td>
                <td><SelectCell value={p.role} options={roles} onSave={(v) => save(p.id, { role: v })} label="Role" /></td>
                <td><Cell value={p.language} onSave={(v) => save(p.id, { language: v })} label="Language" suggestions={langSuggestions} /></td>
                <td><Cell value={p.title} onSave={(v) => save(p.id, { title: v })} label="Title" className="text-ink-300" /></td>
                <td className="text-center"><button onClick={() => remove(p)} className="invisible px-1 text-ink-500 hover:text-red-300 group-hover:visible" aria-label={`Delete ${p.name || p.role}`}>✕</button></td>
              </tr>
            ))}
            <tr className="border-t border-ink-800/60">
              <td className="text-center text-ink-500">+</td>
              <td className="py-1 pr-1"><input className="input py-1 text-sm" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void add()} aria-label="New person name" /></td>
              <td className="py-1 pr-1">
                <select className="input py-1 text-sm" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} aria-label="New person role">
                  <option value="">Role</option>{roles.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </td>
              <td className="py-1 pr-1"><input className="input py-1 text-sm" list="dl-set-lang" placeholder="Language" value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void add()} aria-label="New person language" /></td>
              <td className="py-1"><Button size="sm" variant="primary" onClick={add} disabled={!f.name.trim() && !f.role}>Add</Button></td>
              <td />
            </tr>
          </tbody>
        </table>
      )}
    </Panel>
  );
}
