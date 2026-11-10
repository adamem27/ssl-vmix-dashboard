import { ReactNode, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Button, cx, ErrorBox, Loading, useToast } from '../components/ui';

interface Config {
  inputs: Record<string, string>; fleetId: string; race: number; breakFleets: string[]; breakLayer: number; rotateSeconds: number; tickerNext: string; tickerEnd: string;
  deck1Page: number; deck2Page: number; fallbackPage: number; vmixForCompanion: string; labels: boolean; lineup5: string[];
  keys: Record<string, KeyEdit>; kindColours: Record<string, string>;
}
interface KeyEdit { action?: string; text?: string; bg?: string; fg?: string }
interface KeyDef { action: string; text: string; kind: string }
interface KeyLook { action: string; text: string; kind: string; bg: string; fg: string; custom?: string; onAir: boolean; active: boolean; empty: boolean }
interface Page { deck: number; name: string; page: number; keys: (KeyLook | null)[][] }
interface Graphic { id: string; label: string; kind: string; overlay: number; inputs: string[]; input: string | null; onAir: boolean; fields: number }
interface ShowData {
  config: Config;
  state: { tickerMode: 'next' | 'end'; boat: number; photo: string; rotating: boolean; undoDepth: number; last: { at: string; action: string; error: string | null } | null };
  vmix: { ok: boolean; overlays: Record<string, string> };
  graphics: Graphic[]; boats: { id: string; code: string; name: string }[];
  sailors: { slot: string; number: string; name: string; position: string; photo: boolean }[];
  pages: Page[]; actions: KeyDef[]; kindColours: Record<string, string>; fleets: { id: string; name: string; size: number }[]; tickers: { id: string; name: string }[]; companionUrl: string;
}

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

const OVERLAY = ['', 'OV1 boards', 'OV2 lower thirds', 'OV3 bugs', 'OV4 scene / PiP'];

export function ShowControlPage() {
  const q = useQuery({ queryKey: ['show'], queryFn: () => api.get<ShowData>('/api/show'), refetchInterval: 2000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  return <Show data={q.data!} />;
}

function Show({ data }: { data: ShowData }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [deck, setDeck] = useState<Record<number, number>>({ 1: 0, 2: 0 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['show'] });
  const [edit, setEdit] = useState(false);
  const [pick, setPick] = useState<string | null>(null); // "<page index>/<row>/<col>" of the key being edited
  const [keys, setKeys] = useState(data.config.keys);
  const [kindColours, setKindColours] = useState(data.config.kindColours);
  const saving = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);
  useEffect(() => { if (!pending.current) { setKeys(data.config.keys); setKindColours(data.config.kindColours); } }, [JSON.stringify(data.config.keys), JSON.stringify(data.config.kindColours)]);
  const persist = (patch: Partial<Config>, delay = 0) => {
    pending.current = true;
    if (saving.current) clearTimeout(saving.current);
    saving.current = setTimeout(async () => {
      try { await api.put('/api/show/config', patch); } catch (e) { toast.error(e); } finally { pending.current = false; refresh(); }
    }, delay);
  };
  const setKeyEdits = (next: Record<string, KeyEdit>, delay = 0) => { setKeys(next); persist({ keys: next }, delay); };
  const editKey = (id: string, patch: KeyEdit, delay = 0) => {
    const o = { ...keys[id], ...patch };
    for (const k of Object.keys(o) as (keyof KeyEdit)[]) if (o[k] === undefined) delete o[k];
    const next = { ...keys };
    if (Object.keys(o).length) next[id] = o; else delete next[id];
    setKeyEdits(next, delay);
  };
  const keyAt = (id: string) => { const [pi, r, c] = id.split('/').map(Number); return data.pages[pi]?.keys[r]?.[c] ?? null; };
  /** drag one key onto another: they swap places (Alt: the dragged one is copied) */
  const moveKey = (from: string, to: string, copy: boolean) => {
    if (from === to) return;
    const def = (id: string): KeyEdit => { const k = keyAt(id); const o = keys[id] ?? {}; return { action: k?.action ?? '', text: o.text, bg: o.bg, fg: o.fg }; };
    const clean = (o: KeyEdit) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as KeyEdit;
    const next = { ...keys, [to]: clean(def(from)) };
    if (!copy) next[from] = clean(def(to));
    setKeyEdits(next);
    setPick(to);
  };
  const drag = useRef<string | null>(null);
  const run = async (a: string) => {
    if (a.startsWith('nav:')) {
      const target = Number(a.slice(4));
      const p = data.pages.findIndex((x) => x.page === target);
      if (p >= 0) setDeck((d) => ({ ...d, [data.pages[p].deck]: data.pages.filter((x) => x.deck === data.pages[p].deck).indexOf(data.pages[p]) }));
      return;
    }
    setBusy(a);
    try { await api.post(`/api/show/do?a=${encodeURIComponent(a)}`); } catch (e) { toast.error(e); } finally { setBusy(''); refresh(); }
  };
  const last = data.state.last;
  return (
    <div className="space-y-3">
      <Panel title="Show control" right={<>
        <span className={cx('rounded px-2 py-1 text-xs font-bold', data.vmix.ok ? 'bg-emerald-800 text-emerald-100' : 'bg-red-800 text-red-100')}>{data.vmix.ok ? 'vMix connected' : 'vMix not answering'}</span>
        {[1, 2, 3, 4].map((n) => <span key={n} className={cx('rounded px-2 py-1 text-xs', data.vmix.overlays[n] ? 'bg-red-700 text-white' : 'bg-ink-800 text-ink-400')}>{OVERLAY[n]}{data.vmix.overlays[n] ? ` · ${data.graphics.find((g) => g.input && g.overlay === n && g.onAir)?.label ?? `input ${data.vmix.overlays[n]}`}` : ''}</span>)}
      </>}>
        {last && (
          <div className={cx('mb-3 rounded px-3 py-2 text-sm', last.error ? 'bg-red-950/60 text-red-200' : 'bg-ink-900 text-ink-400')}>
            Last key ({new Date(last.at).toLocaleTimeString()}, {last.action}): {last.error ?? 'OK'}
          </div>
        )}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant={edit ? 'primary' : 'secondary'} onClick={() => { setEdit(!edit); setPick(null); }}>{edit ? '✓ Done editing' : '✎ Edit keys'}</Button>
          {edit ? <span className="text-xs text-ink-400">Click a key to change its text, colour or action · drag a key onto another to swap them (Alt+drag copies) · saved at once and sent to Companion.</span>
            : <span className="text-xs text-ink-500">Right-click a key to edit it.</span>}
          {edit && <>
            <span className="ml-auto text-xs text-ink-400">Colours by kind:</span>
            {Object.entries(data.kindColours).map(([kind, def]) => (
              <label key={kind} className="flex items-center gap-1 text-[11px] uppercase text-ink-300" title={`Every ${kind} key without its own colour`}>
                <input type="color" className="h-5 w-6 cursor-pointer rounded border-0 bg-transparent p-0" value={kindColours[kind] ?? def}
                  onChange={(e) => { const n = { ...kindColours, [kind]: e.target.value }; setKindColours(n); persist({ kindColours: n }, 300); }} />{kind}
              </label>
            ))}
            {(Object.keys(keys).length > 0 || Object.keys(kindColours).length > 0) && <Button size="sm" variant="ghost" onClick={() => { setKindColours({}); setKeys({}); setPick(null); persist({ keys: {}, kindColours: {} }); }} title="Every key back to the built-in layout and colours">Reset all</Button>}
          </>}
        </div>
        <p className="mb-3 text-sm text-ink-400">
          Both Stream Decks as Companion shows them. Deck 1 runs the programme (before, after, break, end), deck 2 the race (teams of the group, sailors by shirt number, announcements, extras).
          A key brings its graphic in and a second press takes it out. Red = on air (read from vMix), orange = selected. The bottom row is the same on every page.
        </p>
        <div className="grid gap-4 xl:grid-cols-2">
          {[1, 2].map((d) => {
            const pages = data.pages.filter((p) => p.deck === d);
            const p = pages[deck[d] ?? 0] ?? pages[0];
            return (
              <div key={d}>
                <div className="mb-1 flex items-center gap-2 text-xs text-ink-400">
                  <b className="text-ink-200">Deck {d}</b>
                  {pages.map((x, i) => <button key={x.page} onClick={() => setDeck({ ...deck, [d]: i })} className={cx('rounded px-2 py-0.5', x === p ? 'bg-ink-700 text-ink-50' : 'hover:bg-ink-800')}>p{x.page} {x.name}</button>)}
                </div>
                <div className="grid grid-cols-8 gap-1.5">
                  {p.keys.flatMap((row, r) => row.map((k, c) => {
                    const id = `${data.pages.indexOf(p)}/${r}/${c}`;
                    const dnd = {
                      draggable: edit,
                      onDragStart: (e: React.DragEvent) => { drag.current = id; e.dataTransfer.effectAllowed = 'copyMove'; },
                      onDragOver: (e: React.DragEvent) => { if (edit && drag.current) e.preventDefault(); },
                      onDrop: (e: React.DragEvent) => { e.preventDefault(); if (drag.current) moveKey(drag.current, id, e.altKey); drag.current = null; },
                      onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); setEdit(true); setPick(id); },
                    };
                    const picked = edit && pick === id;
                    return k ? (
                      <button key={id} {...dnd} onClick={() => (edit ? setPick(id) : run(k.action))} disabled={!edit && (!!busy || k.empty)} title={k.action}
                        style={{ background: k.bg, color: k.fg }}
                        className={cx('aspect-square whitespace-pre-line rounded-lg px-0.5 text-center text-[10px] font-bold leading-tight shadow transition hover:brightness-125 disabled:opacity-60', k.onAir && 'ring-2 ring-red-300', busy === k.action && 'animate-pulse', edit && 'cursor-grab', picked && 'outline outline-2 outline-offset-2 outline-sky-400')}>
                        {k.text.replace(/\\n/g, '\n')}
                      </button>
                    ) : <div key={id} {...dnd} onClick={() => edit && setPick(id)} className={cx('aspect-square rounded-lg border border-dashed border-ink-800', edit && 'cursor-pointer hover:border-ink-500', picked && 'outline outline-2 outline-offset-2 outline-sky-400')} />;
                  }))}
                </div>
                {edit && pick && Number(pick.split('/')[0]) === data.pages.indexOf(p) && (
                  <KeyEditor key={pick} look={keyAt(pick)} edit={keys[pick] ?? {}} actions={data.actions} onChange={(patch, delay) => editKey(pick, patch, delay)} onClose={() => setPick(null)} />
                )}
              </div>
            );
          })}
        </div>
      </Panel>
      <Race data={data} onSaved={refresh} />
      <Registry data={data} onSaved={refresh} />
      <CompanionSetup data={data} onSaved={refresh} />
    </div>
  );
}

const SWATCHES = ['#18181b', '#3f3f46', '#71717a', '#ffffff', '#991b1b', '#dc2626', '#c2410c', '#ea580c', '#d97706', '#a16207', '#ca8a04', '#4d7c0f', '#166534', '#16a34a', '#0f766e', '#0e7490', '#0369a1', '#1e3a8a', '#2563eb', '#4c1d95', '#7c3aed', '#6b21a8', '#be185d', '#db2777'];

/** The edit bar under a deck: text, colour, text colour and action of one key, saved as you type. */
function KeyEditor({ look, edit, actions, onChange, onClose }: { look: KeyLook | null; edit: KeyEdit; actions: KeyDef[]; onChange: (p: KeyEdit, delay?: number) => void; onClose: () => void }) {
  const [text, setText] = useState((edit.text ?? '').replace(/\\n/g, '\n'));
  const def = look ? actions.find((a) => a.action === look.action) : undefined;
  const sw = (c: string, on: boolean, set: () => void) => (
    <button key={c} onClick={set} title={c} className={cx('h-6 w-6 rounded border', on ? 'border-white ring-2 ring-sky-400' : 'border-ink-700 hover:scale-110')} style={{ background: c }} />
  );
  const groups = [['show:', 'Graphics'], ['nav:', 'Pages'], ['', 'Other']] as const;
  const inGroup = (a: string, g: string) => (g ? a.startsWith(g) : !a.startsWith('show:') && !a.startsWith('nav:'));
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-ink-700 bg-ink-900 p-2" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="flex flex-wrap items-start gap-2">
        <label className="text-xs text-ink-400">Text <span className="text-ink-600">(empty = automatic, {'{auto}'} = the live text)</span>
          <textarea autoFocus rows={3} className="input mt-1 block w-56 resize-none py-1 font-mono text-xs" placeholder={(def?.text ?? look?.text ?? '').replace(/\\n/g, '\n')} value={text}
            onChange={(e) => { setText(e.target.value); onChange({ text: e.target.value ? e.target.value.replace(/\n/g, '\\n') : undefined }, 400); }} />
        </label>
        <label className="text-xs text-ink-400">Action
          <select className="input mt-1 block w-56 py-1 text-xs" value={look?.action ?? ''} onChange={(e) => onChange({ action: e.target.value })}>
            <option value="">— empty key —</option>
            {groups.map(([g, name]) => <optgroup key={name} label={name}>{actions.filter((a) => inGroup(a.action, g)).map((a) => <option key={a.action} value={a.action}>{a.text.replace(/\\n/g, ' ')} · {a.action}</option>)}</optgroup>)}
          </select>
        </label>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => { setText(''); onChange({ action: undefined, text: undefined, bg: undefined, fg: undefined }); }} title="This key back to the built-in one">Reset key</Button>
          <Button size="sm" variant="ghost" onClick={onClose}>✕</Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="w-16 text-xs text-ink-400">Key</span>
        {SWATCHES.map((c) => sw(c, edit.bg === c, () => onChange({ bg: c })))}
        <input type="color" className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent p-0" value={edit.bg ?? '#3f3f46'} onChange={(e) => onChange({ bg: e.target.value }, 300)} title="Any colour" />
        {edit.bg && <button className="text-xs text-ink-400 hover:text-ink-100" onClick={() => onChange({ bg: undefined })}>by kind</button>}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="w-16 text-xs text-ink-400">Text</span>
        {['#ffffff', '#000000', '#fde047', '#fca5a5', '#86efac', '#7dd3fc'].map((c) => sw(c, (edit.fg ?? '#ffffff') === c, () => onChange({ fg: c === '#ffffff' ? undefined : c })))}
        <input type="color" className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent p-0" value={edit.fg ?? '#ffffff'} onChange={(e) => onChange({ fg: e.target.value }, 300)} />
        <span className="ml-2 text-[11px] text-ink-500">Red (on air) and orange (selected) still show over your colour.</span>
      </div>
    </div>
  );
}

function useConfig(data: ShowData, onSaved: () => void) {
  const toast = useToast();
  const [c, setC] = useState(data.config);
  useEffect(() => setC(data.config), [JSON.stringify(data.config)]);
  const dirty = JSON.stringify(c) !== JSON.stringify(data.config);
  const save = async () => { try { const { keys: _k, kindColours: _c, ...rest } = c; await api.put('/api/show/config', rest); toast.ok('Saved'); onSaved(); } catch (e) { toast.error(e); } };
  return { c, setC, dirty, save };
}

function Race({ data, onSaved }: { data: ShowData; onSaved: () => void }) {
  const { c, setC, dirty, save } = useConfig(data, onSaved);
  const sel = (label: string, value: string, set: (v: string) => void, opts: { id: string; name: string }[], none = '—') => (
    <label className="block text-xs text-ink-400">{label}
      <select className="input mt-1 w-72 py-1 text-sm" value={value} onChange={(e) => set(e.target.value)}>
        <option value="">{none}</option>{opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </label>
  );
  return (
    <Panel title="Race now" right={<Button size="sm" variant="primary" disabled={!dirty} onClick={save}>Save</Button>}>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-2">
          {sel('Group racing now (its teams go on the team keys)', c.fleetId, (v) => setC({ ...c, fleetId: v }), data.fleets)}
          <label className="block text-xs text-ink-400">Race on the RACE RESULTS key (times at marks on the Results tab)
            <input type="number" min={1} max={12} className="input mt-1 w-20 py-1 text-sm" value={c.race} onChange={(e) => setC({ ...c, race: Math.min(12, Math.max(1, Number(e.target.value) || 1)) })} />
          </label>
          <div className="flex flex-wrap gap-1">{data.boats.map((b, i) => <span key={b.id} className={cx('rounded px-2 py-1 text-xs font-bold', data.state.boat === i + 1 ? 'bg-amber-600 text-white' : 'bg-ink-800 text-ink-200')}>{b.code} · {b.name}</span>)}</div>
          <label className="block text-xs text-ink-400">Lineup LT (5 sailors): places in order
            <input className="input mt-1 w-72 py-1 text-sm" value={c.lineup5.join(', ')} onChange={(e) => setC({ ...c, lineup5: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
          </label>
        </div>
        <div className="space-y-2">
          {sel('Ticker before the next race (D)', c.tickerNext, (v) => setC({ ...c, tickerNext: v }), data.tickers, 'first ticker')}
          {sel('Ticker at the end of the day (E)', c.tickerEnd, (v) => setC({ ...c, tickerEnd: v }), data.tickers, 'second ticker')}
          <p className="text-xs text-ink-500">Ticker texts are edited under General graphics → Tickers. Now: {data.state.tickerMode === 'end' ? 'end of day (E)' : 'next race (D)'}.</p>
        </div>
        <div className="space-y-2">
          <label className="block text-xs text-ink-400">Break scene: board layer<input type="number" min={1} max={10} className="input mt-1 w-20 py-1 text-sm" value={c.breakLayer} onChange={(e) => setC({ ...c, breakLayer: Number(e.target.value) || 3 })} /></label>
          <label className="block text-xs text-ink-400">Rotation every (s)<input type="number" min={4} max={120} className="input mt-1 w-20 py-1 text-sm" value={c.rotateSeconds} onChange={(e) => setC({ ...c, rotateSeconds: Number(e.target.value) || 12 })} /></label>
          <p className="text-xs text-ink-500">The break scene rotates the day schedule and the results of every group of the race's fleet set.</p>
        </div>
      </div>
      {data.sailors.length > 0 && (
        <table className="mt-3 w-full text-sm">
          <thead><tr className="text-left text-xs text-ink-500"><th>Key</th><th>Shirt</th><th>Sailor</th><th>Position</th><th>Photo</th></tr></thead>
          <tbody>{data.sailors.map((s, i) => <tr key={s.slot} className="border-t border-ink-800"><td className="py-1 text-ink-500">{i + 1}</td><td className="font-bold text-ink-50">#{s.number || '?'}</td><td>{s.name}</td><td className="text-ink-300">{s.position}</td><td>{s.photo ? <span className="text-emerald-400">yes</span> : <span className="text-ink-500">no</span>}</td></tr>)}</tbody>
        </table>
      )}
    </Panel>
  );
}

function Registry({ data, onSaved }: { data: ShowData; onSaved: () => void }) {
  const toast = useToast();
  const { c, setC, dirty, save } = useConfig(data, onSaved);
  const missing = data.graphics.filter((g) => !g.input).length;
  const placeholders = async () => {
    try { const r = await api.post<{ added: string[] }>('/api/show/placeholders'); toast.ok(r.added.length ? `Added ${r.added.length} placeholders` : 'Nothing missing'); onSaved(); } catch (e) { toast.error(e); }
  };
  return (
    <Panel title="Graphics and vMix inputs" right={<>
      {data.vmix.ok && missing > 0 && <Button size="sm" variant="ghost" onClick={placeholders}>Add {missing} placeholder{missing > 1 ? 's' : ''} in vMix</Button>}
      <Button size="sm" variant="primary" disabled={!dirty} onClick={save}>Save</Button>
    </>}>
      <p className="mb-2 text-sm text-ink-400">
        Keys find their inputs by name. The first name that exists in vMix is used; {'{n}'} is the number of boats and {'{crew}'} the crew size (the nearest bigger lineup title is taken).
        A placeholder is an empty input with the right name: replace it with the GTZIP later and give the title the same name, nothing else changes.
      </p>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-ink-500"><th>Graphic</th><th>Channel</th><th>vMix input names</th><th>In vMix</th></tr></thead>
        <tbody>
          {data.graphics.map((g) => (
            <tr key={g.id} className="border-t border-ink-800">
              <td className="py-1 text-ink-100">{g.label}</td>
              <td className="text-xs text-ink-400">{OVERLAY[g.overlay]}</td>
              <td><input className="input w-full py-0.5 text-xs" value={c.inputs[g.id] ?? g.inputs.join(', ')} onChange={(e) => setC({ ...c, inputs: { ...c.inputs, [g.id]: e.target.value } })} /></td>
              <td className="text-xs">{g.input ? <span className={g.onAir ? 'font-bold text-red-400' : 'text-emerald-400'}>{g.input}{g.fields ? ` (${g.fields} fields)` : ' (placeholder)'}{g.onAir ? ' · ON AIR' : ''}</span> : <span className="text-amber-400">missing</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-ink-500">Lower thirds of sailors and teams use the inputs and overlay set on the Lower thirds tab (overlay 2 recommended).</p>
    </Panel>
  );
}

function CompanionSetup({ data, onSaved }: { data: ShowData; onSaved: () => void }) {
  const toast = useToast();
  const { c, setC, dirty, save } = useConfig(data, onSaved);
  const origin = window.location.origin;
  const files = [...data.pages.map((p) => ({ name: `deck${p.deck}-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, page: p.page, label: `Deck ${p.deck} · ${p.name}` })), { name: 'fallback', page: c.fallbackPage, label: 'Fallback (straight to vMix)' }];
  const labels = async () => { try { const r = await api.post<{ sent: number }>('/api/show/labels'); toast.ok(`Companion: ${r.sent} keys updated`); } catch (e) { toast.error(e); } };
  const num = (label: string, value: number, set: (v: number) => void) => (
    <label className="block text-xs text-ink-400">{label}<input type="number" min={1} max={99} className="input mt-1 w-20 py-1 text-sm" value={value} onChange={(e) => set(Number(e.target.value) || 1)} /></label>
  );
  return (
    <Panel title="Companion" right={<>
      {data.companionUrl && <Button size="sm" variant="ghost" onClick={labels}>Send key labels now</Button>}
      <Button size="sm" variant="primary" disabled={!dirty} onClick={save}>Save</Button>
    </>}>
      <div className="flex flex-wrap gap-4">
        {num('Deck 1 first page', c.deck1Page, (v) => setC({ ...c, deck1Page: v }))}
        {num('Deck 2 first page', c.deck2Page, (v) => setC({ ...c, deck2Page: v }))}
        {num('Fallback page', c.fallbackPage, (v) => setC({ ...c, fallbackPage: v }))}
        <label className="block text-xs text-ink-400">vMix address as Companion reaches it (fallback page)
          <input className="input mt-1 w-72 py-1 text-sm" placeholder="same as Settings → vMix" value={c.vmixForCompanion} onChange={(e) => setC({ ...c, vmixForCompanion: e.target.value })} />
        </label>
        <label className="mt-5 flex items-center gap-2 text-xs text-ink-300"><input type="checkbox" checked={c.labels} onChange={(e) => setC({ ...c, labels: e.target.checked })} /> Write key texts and colours into Companion</label>
      </div>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-ink-300">
        <li>Download the five pages (from the dashboard opened at the address Companion will call) and import each in Companion: <b>Import / Export → Import</b>, onto the page shown. On the second and later files, map the connection to the one already made.
          <div className="mt-2 flex flex-wrap gap-2">
            {files.map((f) => (
              <a key={f.name} className="rounded bg-ink-800 px-3 py-1.5 text-xs font-semibold text-ink-100 hover:bg-ink-700" href={`/api/show/companion/${f.name}?base=${encodeURIComponent(origin)}`} download>p{f.page} · {f.label}</a>
            ))}
          </div>
        </li>
        <li>In Companion → Surfaces, put each Stream Deck XL in its own group, with deck 1 starting on page {c.deck1Page} and deck 2 on page {c.deck2Page}.</li>
        <li>In Companion Settings → Protocols turn on <b>HTTP remote control</b> and type Companion's address on the Lower thirds tab. The dashboard then writes the boats, sailors (shirt number, position, name, ● = photo), announcements and the red ON AIR colour into the keys.</li>
        <li>PANIC cuts everything only on a second press within 3 seconds. The fallback page works without the dashboard: it toggles the graphics straight in vMix with the data they last had.</li>
      </ol>
    </Panel>
  );
}
