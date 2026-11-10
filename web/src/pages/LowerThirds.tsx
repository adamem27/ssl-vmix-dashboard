import { ReactNode, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Button, cx, ErrorBox, Loading, useToast } from '../components/ui';

interface Fields { top: string; bottom: string; photo: string; flag: string; emblem: string; bar: string }
interface Config {
  photoInput: string; noPhotoInput: string; overlay: number; barSlot: string; flagSlot: string; emblemSlot: string; countryShowsTeam: boolean;
  companionUrl: string; companionPage: number; rows: number; cols: number; fields: Fields;
}
interface State { kind: 'team' | 'sailor' | null; teamId: string | null; slot: string | null; line: number; onAir: boolean; input: string }
interface Key { action: string; text: string; active: boolean; onAir: boolean; page: number; row: number; col: number; bg?: string; fg?: string; label?: string }
interface Sailor { slot: string; label: string; sailorId: string | null; firstName: string; lastName: string; number: string; position: string; photo: string; best: string[] }
interface LtData { config: Config; state: State; teams: { id: string; code: string; name: string }[]; keys: Key[][]; crew: Sailor[]; teamSlots: { key: string; label: string }[]; last: { at: string; what: string; error: string | null } | null }

function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <header className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-3 py-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink-200">{title}</h2>
        <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

/** The lower thirds' settings, on the Show control tab: the vMix titles, their overlay, the team graphics and fields. */
export function LowerThirdSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['lt'], queryFn: () => api.get<LtData>('/api/lt') });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  return <Settings data={q.data!} onSaved={() => qc.invalidateQueries({ queryKey: ['lt'] })} />;
}

function Settings({ data, onSaved }: { data: LtData; onSaved: () => void }) {
  const toast = useToast();
  const [c, setC] = useState(data.config);
  useEffect(() => setC(data.config), [data.config]);
  const dirty = JSON.stringify(c) !== JSON.stringify(data.config);
  const save = async () => { try { await api.put('/api/lt/config', c); toast.ok('Saved'); onSaved(); } catch (e) { toast.error(e); } };
  const text = (label: string, value: string, set: (v: string) => void, ph = '', w = 'w-48') => (
    <label className="block text-xs text-ink-400">{label}<input className={cx('input mt-1 py-1 text-sm', w)} value={value} placeholder={ph} onChange={(e) => set(e.target.value)} /></label>
  );
  const num = (label: string, value: number, set: (v: number) => void, min: number, max: number) => (
    <label className="block text-xs text-ink-400">{label}<input type="number" className="input mt-1 w-20 py-1 text-sm" value={value} min={min} max={max} onChange={(e) => set(Number(e.target.value) || min)} /></label>
  );
  const slot = (label: string, value: string, set: (v: string) => void) => (
    <label className="block text-xs text-ink-400">{label}
      <select className="input mt-1 w-48 py-1 text-sm" value={value} onChange={(e) => set(e.target.value)}>{data.teamSlots.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
    </label>
  );
  const field = (k: keyof Fields, label: string) => text(label, c.fields[k], (v) => setC({ ...c, fields: { ...c.fields, [k]: v } }), '', 'w-32');
  return (
    <Panel title="Lower thirds" right={<Button size="sm" variant="primary" disabled={!dirty} onClick={save}>Save</Button>}>
      <p className="mb-3 text-sm text-ink-400">Sailors and teams on deck 2 (a page per team): a place key shows whoever sails there in today's line-up, NEXT RESULT changes only the line under the name (position → best results), OUT takes it off. On air, a change only swaps the data, so the title's change animations play.</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-xs font-bold uppercase text-ink-300">vMix</h3>
          {text('Lower third with photo (input name or number)', c.photoInput, (v) => setC({ ...c, photoInput: v }), 'lowerthird_photo', 'w-64')}
          {text('Lower third without photo (teams, sailors without photo)', c.noPhotoInput, (v) => setC({ ...c, noPhotoInput: v }), 'lowerthird_no_photo', 'w-64')}
          {num('Overlay channel', c.overlay, (v) => setC({ ...c, overlay: v }), 1, 4)}
        </div>
        <div className="space-y-2">
          <h3 className="text-xs font-bold uppercase text-ink-300">Graphics and title fields</h3>
          {slot('Bar', c.barSlot, (v) => setC({ ...c, barSlot: v }))}
          {slot('Flag', c.flagSlot, (v) => setC({ ...c, flagSlot: v }))}
          {slot('Emblem', c.emblemSlot, (v) => setC({ ...c, emblemSlot: v }))}
          <div className="flex flex-wrap gap-2">{field('top', 'Name field')}{field('bottom', 'Line field')}{field('photo', 'Photo field')}{field('flag', 'Flag field')}{field('emblem', 'Emblem field')}{field('bar', 'Bar field')}</div>
        </div>
      </div>
    </Panel>
  );
}
