import { KeyboardEvent, ReactNode, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMeta } from '../App';
import { api, Asset, FleetSetDetail, FleetSetSummary } from '../api';
import { Button, cx, ErrorBox, Loading, todayIn, useToast } from '../components/ui';
import { Cell, ImgCell, SelectCell } from '../components/cells';
import { GraphicSetsSections } from './GraphicSets';
import { ComparePanel } from './CompareTab';
import { useStage } from '../components/StagePicker';
import { groupLabel } from '../../../server/src/services/groupNames';

const CONDITIONS = ['Sunny', 'Mostly sunny', 'Partly cloudy', 'Cloudy', 'Overcast', 'Light rain', 'Rain', 'Showers', 'Thunderstorm', 'Fog', 'Windy'];
const DIRECTIONS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

const SECTIONS: [string, string][] = [['g-welcome', 'Welcome'], ['g-schedule', 'Schedule'], ['g-weather', 'Weather'], ['g-announcement', 'Announcements'], ['g-ticker', 'Tickers'], ['g-officials', 'Race officials'], ['g-socials', 'Follow us'], ['g-people', 'People'], ['g-compare', 'Team comparison']];

const shiftDate = (d: string, days: number) => new Date(Date.parse(d + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

export function GeneralPage() {
  return (
    <div className="space-y-4">
      <nav className="sticky top-[60px] z-10 -mx-1 flex flex-wrap gap-1 rounded-lg border border-ink-800 bg-ink-950/90 px-2 py-1.5 backdrop-blur" aria-label="Sections">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
            className="rounded px-2 py-1 text-xs font-medium text-ink-400 hover:bg-ink-850 hover:text-ink-100">{label}</a>
        ))}
      </nav>
      <GraphicSetsSections kinds={['welcome']} />
      <div id="g-schedule" className="scroll-mt-28"><SchedulePanel /></div>
      <div id="g-weather" className="scroll-mt-28"><WeatherPanel /></div>
      <GraphicSetsSections kinds={['announcement', 'ticker', 'officials', 'socials']} />
      <div id="g-people" className="scroll-mt-28"><PeoplePanel /></div>
      <div id="g-compare" className="scroll-mt-28"><ComparePanel /></div>
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
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
        {select('forecast', 'Forecast', CONDITIONS)}
        {text('air_temp', 'Air °C', '24°C')}
        {text('wind_speed', 'Wind', '12')}
        {field('Direction', (
          <div className="flex items-center gap-1">
            <div className="w-16 shrink-0" title="Direction in degrees, e.g. 050°"><Cell value={d.wind_degrees} onSave={(v) => save('wind_degrees', v)} label="Direction in degrees" placeholder="050°" className="font-mono text-ink-50" /></div>
            <div className="min-w-0 flex-1"><SelectCell value={d.wind_direction} options={DIRECTIONS} onSave={(v) => save('wind_direction', v)} label="Direction" className="text-ink-50" /></div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ---------- schedule ----------
interface Item { id: string; date: string; time: string; race: string; fleet: string }

/** Group names as the graphics show them (GROUP H): the stage's groups first, then every other group. */
function useGroupNames() {
  const stage = useStage();
  const sets = useQuery({ queryKey: ['fleet-sets'], queryFn: () => api.get<FleetSetSummary[]>('/api/fleet-sets') });
  const names = useQuery({
    queryKey: ['fleet-names', sets.data?.map((s) => s.id).join()],
    queryFn: async () => {
      const details = await Promise.all((sets.data ?? []).map((s) => api.get<FleetSetDetail>(`/api/fleet-sets/${s.id}`)));
      return details.flatMap((d) => d.fleets.map((f) => groupLabel(f.name)));
    },
    enabled: !!sets.data,
  });
  return [...new Set([...(stage.data?.groups ?? []).map((g) => g.label), ...(names.data ?? [])])];
}

function SchedulePanel() {
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const tz = meta.data?.event.timezone ?? 'UTC';
  const [date, setDate] = useState<string | null>(null);
  const day = date ?? todayIn(tz);
  const items = useQuery({ queryKey: ['schedule', day], queryFn: () => api.get<Item[]>(`/api/schedule?date=${day}`) });
  const fleetNames = useGroupNames();
  const stage = useStage();
  const refresh = () => qc.invalidateQueries({ queryKey: ['schedule'] });
  const save = async (id: string, patch: Partial<Item>) => {
    try { await api.patch(`/api/schedule/${id}`, patch); refresh(); } catch (e) { toast.error(e); throw e; }
  };
  const remove = async (id: string) => { try { await api.del(`/api/schedule/${id}`); refresh(); } catch (e) { toast.error(e); } };

  const empty = { time: '', race: '', fleet: '' };
  const [f, setF] = useState(empty);
  const add = async () => {
    if (!f.time.trim() && !f.race.trim()) return;
    try { await api.post('/api/schedule', { ...f, fleet: f.fleet.trim() || stage.data?.group?.label || '', date: day }); setF(empty); refresh(); } catch (e) { toast.error(e); }
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') void add(); };

  // the board's options: TIME on or off (the rest of each row is centred then) and the row marked as the next race
  const opts = useQuery({ queryKey: ['schedule-options'], queryFn: () => api.get<{ showTime: boolean; next: Record<string, string> }>('/api/schedule/options') });
  const setOpts = async (body: { showTime?: boolean; date?: string; next?: string | null }) => {
    try { await api.put('/api/schedule/options', body); void qc.invalidateQueries({ queryKey: ['schedule-options'] }); } catch (e) { toast.error(e); }
  };
  const showTime = opts.data?.showTime ?? true;
  const list = items.data ?? [];
  const nextId = opts.data?.next[day];
  const nextAt = list.findIndex((it) => it.id === nextId);

  return (
    <Panel title="Schedule" right={
      <div className="flex items-center gap-3">
      <label className="flex items-center gap-1.5 text-xs text-ink-300" title="Off: the board leaves TIME out and centres the rest of each row">
        <input type="checkbox" checked={showTime} onChange={(e) => void setOpts({ showTime: e.target.checked })} /> Show time
      </label>
      <div className="flex items-center" role="group" aria-label="Schedule day">
        <Button size="sm" variant="ghost" onClick={() => setDate(shiftDate(day, -1))} aria-label="Previous day">‹</Button>
        <input type="date" className="input w-40 py-1 text-sm" value={day} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Schedule day" />
        <Button size="sm" variant="ghost" onClick={() => setDate(shiftDate(day, 1))} aria-label="Next day">›</Button>
      </div>
      </div>
    }>
      {items.error ? <ErrorBox error={items.error} /> : (
        <table className="w-full table-fixed text-sm">
          <thead className="text-left text-[10px] uppercase tracking-wide text-ink-500">
            <tr><th className="w-12 px-1 py-1" title="The next race: highlighted on the board">Next</th><th className={`w-24 px-1 py-1 ${showTime ? '' : 'line-through opacity-50'}`}>Time</th><th className="px-1 py-1">Race</th><th className="w-56 px-1 py-1">Group</th><th className="w-24" /></tr>
          </thead>
          <tbody>
            {list.map((it, i) => (
              <tr key={it.id} className={`group border-t border-ink-800/60 ${i === nextAt ? 'bg-accent-500/10' : nextAt > i ? 'opacity-50' : ''}`}>
                <td className="text-center">
                  <button onClick={() => void setOpts({ date: day, next: i === nextAt ? null : it.id })} aria-pressed={i === nextAt}
                    aria-label={i === nextAt ? 'Clear the next race' : 'Mark as the next race'} title={i === nextAt ? 'Next race (click to clear)' : 'Mark as the next race'}
                    className={`h-3 w-3 rounded-full border ${i === nextAt ? 'border-accent-400 bg-accent-400' : 'border-ink-600 hover:border-ink-300'}`} />
                </td>
                <td><Cell value={it.time} onSave={(v) => save(it.id, { time: v })} label="Time" className="font-mono tabular-nums text-ink-50" /></td>
                <td><Cell value={it.race} onSave={(v) => save(it.id, { race: v })} label="Race" className="text-ink-50" /></td>
                <td><Cell value={groupLabel(it.fleet)} onSave={(v) => save(it.id, { fleet: v })} label="Group" suggestions={fleetNames} /></td>
                <td className="text-center"><button onClick={() => remove(it.id)} className="invisible px-1 text-ink-500 hover:text-red-300 group-hover:visible" aria-label="Delete row">✕</button></td>
              </tr>
            ))}
            <tr className="border-t border-ink-800/60">
              <td />
              <td className="py-1 pr-1"><input className="input py-1 font-mono text-sm" placeholder="14:00" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} onKeyDown={onKey} aria-label="New time" /></td>
              <td className="py-1 pr-1"><input className="input py-1 text-sm" placeholder="Race" value={f.race} onChange={(e) => setF({ ...f, race: e.target.value })} onKeyDown={onKey} aria-label="New race" /></td>
              <td className="py-1 pr-1">
                <input className="input py-1 text-sm" placeholder={stage.data?.group?.label ?? 'GROUP H'} list="dl-new-fleet" value={f.fleet} onChange={(e) => setF({ ...f, fleet: e.target.value })} onKeyDown={onKey} aria-label="New group" />
                <datalist id="dl-new-fleet">{fleetNames.map((n) => <option key={n} value={n} />)}</datalist>
              </td>
              <td className="py-1"><Button size="sm" variant="primary" onClick={add} disabled={!f.time.trim() && !f.race.trim()}>Add</Button></td>
            </tr>
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ---------- people ----------
interface Person { id: string; name: string; surname: string; role: string; language: string; title: string; photo: Asset | null }

function PeoplePanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['people'], queryFn: () => api.get<{ people: Person[]; roles: string[] }>('/api/people') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['people'] });
  const save = async (id: string, patch: Partial<Person>) => {
    try { await api.patch(`/api/people/${id}`, patch); refresh(); } catch (e) { toast.error(e); throw e; }
  };
  const remove = async (p: Person) => {
    if (!confirm(`Delete ${p.name || p.role || 'this person'}?`)) return;
    try { await api.del(`/api/people/${p.id}`); refresh(); } catch (e) { toast.error(e); }
  };
  const addSet = async () => {
    try { await api.post('/api/people/commentator-set', {}); refresh(); } catch (e) { toast.error(e); }
  };
  const empty = { name: '', surname: '', role: '', language: '', title: '' };
  const [f, setF] = useState(empty);
  const add = async () => {
    if (!f.name.trim() && !f.surname.trim() && !f.role) return;
    try { await api.post('/api/people', f); setF(empty); refresh(); } catch (e) { toast.error(e); }
  };

  const people = q.data?.people ?? [];
  const roles = q.data?.roles ?? [];
  const shown = people;

  return (
    <Panel title="People" right={<Button size="sm" onClick={addSet}>+ 3 commentators</Button>}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <table className="w-full table-fixed text-sm">
          <thead className="text-left text-[10px] uppercase tracking-wide text-ink-500">
            <tr><th className="w-14 px-1 py-1">Photo</th><th className="px-1 py-1">Name</th><th className="px-1 py-1">Surname</th><th className="w-52 px-1 py-1">Role</th><th className="w-20" /><th className="w-8" /></tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id} className="group border-t border-ink-800/60">
                <td className="py-0.5"><ImgCell kind="people" ownerId={p.id} slot="photo" label={`${[p.name, p.surname].filter(Boolean).join(' ') || p.role} · Photo`} asset={p.photo} onChanged={refresh} accept="png+jpg" /></td>
                <td><Cell value={p.name} onSave={(v) => save(p.id, { name: v })} label="Name" className="font-medium text-ink-50" /></td>
                <td><Cell value={p.surname} onSave={(v) => save(p.id, { surname: v })} label="Surname" className="font-medium uppercase text-ink-50" /></td>
                <td><SelectCell value={p.role} options={roles} onSave={(v) => save(p.id, { role: v })} label="Role" /></td>
                <td />
                <td className="text-center"><button onClick={() => remove(p)} className="invisible px-1 text-ink-500 hover:text-red-300 group-hover:visible" aria-label={`Delete ${p.name || p.role}`}>✕</button></td>
              </tr>
            ))}
            <tr className="border-t border-ink-800/60">
              <td className="text-center text-ink-500">+</td>
              <td className="py-1 pr-1"><input className="input py-1 text-sm" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void add()} aria-label="New person name" /></td>
              <td className="py-1 pr-1"><input className="input py-1 text-sm" placeholder="Surname" value={f.surname} onChange={(e) => setF({ ...f, surname: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void add()} aria-label="New person surname" /></td>
              <td className="py-1 pr-1">
                <select className="input py-1 text-sm" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} aria-label="New person role">
                  <option value="">Role</option>{roles.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </td>
              <td className="py-1"><Button size="sm" variant="primary" onClick={add} disabled={!f.name.trim() && !f.surname.trim() && !f.role}>Add</Button></td>
              <td />
            </tr>
          </tbody>
        </table>
      )}
    </Panel>
  );
}
