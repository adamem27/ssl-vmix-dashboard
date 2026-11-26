import { ReactNode, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { FoldTitle, useFold } from '../components/fold';
import { groupLabel } from '../../../server/src/services/groupNames';
import { Button, cx, ErrorBox, Loading, useToast } from '../components/ui';
import { TickerLangsPanel } from './TickerLangs';

interface Config {
  inputs: Record<string, string>; fleetId: string; race: number; breakFleets: string[]; breakLbarLayer: number; breakTickerLayer: number; breakBoardLayer: number; tickerTopLayer: number; breakAuto: boolean; breakSchedule: boolean; rotateSeconds: number; breakOutMs: number; flagChangeMs: number; lbarSwapSeconds: number; breakMix?: number; mixBoardLayer?: number; mixLbarLayer?: number; mixZeroBased?: boolean; mixLoopOn?: boolean; mixSchedule?: boolean; mixFleets?: string[]; tickerNext: string; tickerEnd: string; championsTeam?: string; championsText?: string;
  deck1Page: number; deck2Page: number; fallbackPage: number; vmixForCompanion: string; labels: boolean; lineup5: string[];
  keys: Record<string, KeyEdit>; kindColours: Record<string, string>;
}
interface KeyEdit { action?: string; text?: string; bg?: string; fg?: string }
interface KeyDef { action: string; text: string; kind: string }
interface KeyLook { action: string; text: string; kind: string; bg: string; fg: string; custom?: string; onAir: boolean; active: boolean; empty: boolean }
/** dsk: where the ATEM downstream key sits on this page in Companion (not a dashboard key) */
interface Page { deck: number; name: string; page: number; keys: (KeyLook | null)[][]; dsk?: [number, number] | null }
interface Graphic { id: string; label: string; kind: string; overlay: number; inputs: string[]; input: string | null; onAir: boolean; fields: number }
interface ShowData {
  config: Config;
  state: { tickerMode: 'next' | 'end'; boat: number; photo: string; rotating: boolean; undoDepth: number; last: { at: string; action: string; error: string | null } | null };
  vmix: { ok: boolean; overlays: Record<string, string> };
  graphics: Graphic[]; boats: { id: string; code: string; name: string }[];
  sailors: { slot: string; number: string; name: string; position: string; photo: boolean }[];
  pages: Page[]; actions: KeyDef[]; kindColours: Record<string, string>; fleets: { id: string; name: string; size: number }[]; tickers: { id: string; name: string }[]; companionUrl: string; companion?: CompanionStatus; breakGroups: { id: string; name: string }[]; breakShown: string[];
  lbarSwap?: { title: string; onAir: boolean; look: 'first' | 'second'; field: string; changedAt: string | null; error: string }[];
  mixStatus?: { board: string; lbar: string; missing: string[]; error: string };
  lbarLooks?: { look1: boolean; look2: boolean; ready: boolean; size: string; changed: number };
}

function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useFold(`show:${title}`);
  return (
    <section className="card">
      <header className={cx('flex flex-wrap items-center gap-2 px-3 py-2', open && 'border-b border-ink-800')}>
        <FoldTitle open={open} onToggle={() => setOpen(!open)}>{title}</FoldTitle>
        {open && <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>}
      </header>
      {open && <div className="p-3">{children}</div>}
    </section>
  );
}

const OVERLAY = ['', 'OV1', 'OV2', 'OV3', 'OV4'];

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
  const [pick, setPick] = useState<string | null>(null); // "<page name>/<row>/<col>" of the key being edited
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
  const keyAt = (id: string) => { const m = id.match(/^(.*)\/(\d+)\/(\d+)$/); return m ? data.pages.find((p) => p.name === m[1])?.keys[Number(m[2])]?.[Number(m[3])] ?? null : null; };
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
        <Champions config={data.config} onSave={(patch) => persist(patch)} />
        {last && (
          <div className={cx('mb-3 rounded px-3 py-2 text-sm', last.error ? 'bg-red-950/60 text-red-200' : 'bg-ink-900 text-ink-400')}>
            Last key ({new Date(last.at).toLocaleTimeString()}, {last.action}): {last.error ?? 'OK'}
          </div>
        )}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant={edit ? 'primary' : 'secondary'} onClick={() => { setEdit(!edit); setPick(null); }}>{edit ? '✓ Done editing' : '✎ Edit keys'}</Button>
          {edit ? <span className="text-xs text-ink-400">Click a key to change its text, colour or action · drag a key onto another to swap them (Alt+drag copies) · saved at once (download the Companion preset again to put it on the decks).</span>
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
          Both Stream Decks as the Companion preset has them, for testing and preview: the show runs from the decks. Deck 1 runs the programme (before, after, break, end; TICKER ON / OFF on channel 1 and TOP TICKER ON / OFF on the AFTER / BREAK page; RESULTS/COMPARE holds each group's Team comparison with its RESULTS, Provisional overall, under it, for the stage picked at the top); deck 2 has TEAMS (16 keys in group order, A1–A4, B1–B4…; each opens the team's page with its lower thirds TEAM LT, QUALIFIED and LINEUP LT and its places with the sailors' names and shirt numbers, PHOTO mode; a place with no team yet shows its name, A1…, until a team is put there), every announcement (BUGS OFTEN, BUGS RARE), every ticker and top ticker (TICKERS) and everyone in People (PEOPLE) on a key of its own, a new one at once. Pressing a key sends its General graphics data straight into the vMix title before it comes in.
          A key brings its graphic in and a second press takes it out. Team and sailor keys are in the team's national colours; on air (●) and selected (▶) show in the team's colours too. Other keys: red = on air (read from vMix), amber = selected. The bottom row is the same on every page.
        </p>
        <div className="grid gap-4 xl:grid-cols-2">
          {[1, 2].map((d) => {
            const pages = data.pages.filter((p) => p.deck === d);
            const p = pages[deck[d] ?? 0] ?? pages[0];
            return (
              <div key={d} className="min-w-0">
                <div className="mb-1 flex min-w-0 items-center gap-1 text-xs text-ink-400">
                  <b className="mr-1 shrink-0 text-ink-200">Deck {d}</b>
                  {/* the deck's pages scroll sideways (16 team pages and more); ◀ ▶ step through them */}
                  <button type="button" className="shrink-0 rounded px-1.5 py-0.5 hover:bg-ink-800 disabled:opacity-30" disabled={pages.indexOf(p) <= 0} onClick={() => setDeck({ ...deck, [d]: Math.max(0, pages.indexOf(p) - 1) })} title="Previous page">◀</button>
                  <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto whitespace-nowrap pb-1 [scrollbar-width:thin]">
                    {pages.map((x, i) => <button key={x.page} ref={x === p ? keepInView : undefined} onClick={() => setDeck({ ...deck, [d]: i })} className={cx('shrink-0 rounded px-2 py-0.5', x === p ? 'bg-ink-700 text-ink-50' : 'hover:bg-ink-800')}>p{x.page} {x.name}</button>)}
                  </div>
                  <button type="button" className="shrink-0 rounded px-1.5 py-0.5 hover:bg-ink-800 disabled:opacity-30" disabled={pages.indexOf(p) >= pages.length - 1} onClick={() => setDeck({ ...deck, [d]: Math.min(pages.length - 1, pages.indexOf(p) + 1) })} title="Next page">▶</button>
                </div>
                <div className="grid grid-cols-8 gap-1.5">
                  {p.keys.flatMap((row, r) => row.map((k, c) => {
                    const id = `${p.name}/${r}/${c}`;
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
                        className={cx('aspect-square whitespace-pre-line rounded-lg px-0.5 text-center text-[10px] font-bold leading-tight shadow transition hover:brightness-125 disabled:opacity-60', k.onAir && 'ring-2 ring-red-300', k.active && !k.onAir && 'ring-2 ring-white/70', busy === k.action && 'animate-pulse', edit && 'cursor-grab', picked && 'outline outline-2 outline-offset-2 outline-sky-400')}>
                        {k.text.replace(/\\n/g, '\n')}
                      </button>
                    ) : p.dsk && p.dsk[0] === r && p.dsk[1] === c ? (
                      // the ATEM downstream key: it runs in Companion only (auto on / off, red while on air)
                      <div key={id} {...dnd} onClick={() => edit && setPick(id)} title="ATEM downstream key (DSK): runs in Companion, red there while on air"
                        className={cx('flex aspect-square items-center justify-center rounded-lg border border-ink-600 bg-black text-[10px] font-bold text-white', edit && 'cursor-pointer hover:border-ink-400', picked && 'outline outline-2 outline-offset-2 outline-sky-400')}>DSK</div>
                    ) : <div key={id} {...dnd} onClick={() => edit && setPick(id)} className={cx('aspect-square rounded-lg border border-dashed border-ink-800', edit && 'cursor-pointer hover:border-ink-500', picked && 'outline outline-2 outline-offset-2 outline-sky-400')} />;
                  }))}
                </div>
                {edit && pick && pick.startsWith(`${p.name}/`) && /^\d+\/\d+$/.test(pick.slice(p.name.length + 1)) && (
                  <KeyEditor key={pick} look={keyAt(pick)} edit={keys[pick] ?? {}} actions={data.actions} onChange={(patch, delay) => editKey(pick, patch, delay)} onClose={() => setPick(null)} />
                )}
              </div>
            );
          })}
        </div>
      </Panel>
      <BreakScene data={data} onSaved={refresh} />
      <TickerLangsPanel />
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

/** The defending champions: their CHAMPIONS key (on their team page) shows the team lower third with this line. */
function Champions({ config, onSave }: { config: Config; onSave: (patch: Partial<Config>) => void }) {
  const [team, setTeam] = useState(config.championsTeam ?? 'HUN');
  const [text, setText] = useState(config.championsText ?? '');
  useEffect(() => { setTeam(config.championsTeam ?? 'HUN'); setText(config.championsText ?? ''); }, [config.championsTeam, config.championsText]);
  const save = () => { if (team.trim().toUpperCase() !== (config.championsTeam ?? '') || text !== (config.championsText ?? '')) onSave({ championsTeam: team.trim().toUpperCase(), championsText: text }); };
  return (
    <div className="mb-3 flex flex-wrap items-end gap-2 text-xs text-ink-400" title="The CHAMPIONS key on this team's page (Companion and the keys below) shows its team lower third (no photo) with this bottom line, exactly as typed.">
      <label className="block">Defending champions<input className="input mt-1 w-20 py-1 text-sm uppercase" value={team} onChange={(e) => setTeam(e.target.value)} onBlur={save} /></label>
      <label className="block flex-1">CHAMPIONS lower third: bottom line<input className="input mt-1 w-full max-w-xl py-1 text-sm" value={text} onChange={(e) => setText(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} /></label>
    </div>
  );
}

function useConfig(data: ShowData, onSaved: () => void) {
  const toast = useToast();
  const [c, setC] = useState(data.config);
  useEffect(() => setC(data.config), [JSON.stringify(data.config)]);
  const dirty = JSON.stringify(c) !== JSON.stringify(data.config);
  const qcc = useQueryClient();
  const save = async () => { try { const { keys: _k, kindColours: _c, ...rest } = c; await api.put('/api/show/config', rest); qcc.invalidateQueries({ queryKey: ['stage'] }); toast.ok('Saved'); onSaved(); } catch (e) { toast.error(e); } };
  return { c, setC, dirty, save };
}

/** L-bar switch: the two looks of the L-bar, uploaded here; the dashboard makes the pictures for vMix from them. */
function LbarLooks({ looks }: { looks?: ShowData['lbarLooks'] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const up = async (n: 1 | 2, f?: File) => {
    if (!f) return;
    try { await api.upload(`/api/show/lbar-look/${n}`, f); toast.ok(`Look ${n} saved`); qc.invalidateQueries({ queryKey: ['show'] }); }
    catch (e) { toast.error(e); }
  };
  return (
    <div className="flex flex-wrap gap-3 text-xs text-ink-400">
      {([1, 2] as const).map((n) => (
        <label key={n} className="block cursor-pointer">
          <span>L-bar look {n} (whole-frame PNG){n === 1 ? ': shown first' : ': only what differs fades in'}</span>
          <div className="mt-1 flex h-[72px] w-[128px] items-center justify-center rounded border border-ink-700 bg-ink-950 [background-image:repeating-conic-gradient(#222_0_25%,#333_0_50%)] [background-size:12px_12px]">
            {looks?.[n === 1 ? 'look1' : 'look2'] ? <img src={`/api/show/lbar-look/${n}?v=${looks.changed}`} className="max-h-full max-w-full" alt="" /> : <span>Upload</span>}
          </div>
          <input type="file" accept="image/png" className="hidden" onChange={(e) => { void up(n, e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      ))}
      <span className="self-end">{looks?.ready ? `Ready (${looks.size})` : 'Upload both looks'}</span>
    </div>
  );
}

function BreakScene({ data, onSaved }: { data: ShowData; onSaved: () => void }) {
  const { c, setC, dirty, save } = useConfig(data, onSaved);
  return (
    <Panel title="Break scene" right={<Button size="sm" variant="primary" disabled={!dirty} onClick={save}>Save</Button>}>
      <div className="max-w-3xl">
        <div className="space-y-2">
          <div className="text-xs font-semibold text-ink-300">Overlay channels</div>
          <div className="flex gap-2">
            {([['L-bar', 'breakLbarLayer', 2, 2], ['Ticker', 'breakTickerLayer', 3, 2], ['Schedule / results', 'breakBoardLayer', 4, 2], ['Top ticker', 'tickerTopLayer', 2, 1]] as const).map(([label, k, d, min]) => (
              <label key={k} className="block text-xs text-ink-400">{label}<input type="number" min={min} max={4} className="input mt-1 w-16 py-1 text-sm" value={c[k] ?? d} onChange={(e) => setC({ ...c, [k]: Number(e.target.value) || d })} /></label>
            ))}
          </div>
          {data.breakGroups.length > 0 && (
            <div className="text-xs text-ink-400">Group results shown
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {data.breakGroups.map((g) => {
                  const shown = c.breakFleets.length ? c.breakFleets.filter((id) => data.breakGroups.some((x) => x.id === id)) : data.breakShown;
                  const on = shown.includes(g.id);
                  return (
                    <label key={g.id} className="flex items-center gap-1 text-ink-200">
                      <input type="checkbox" checked={on} onChange={() => setC({ ...c, breakFleets: data.breakGroups.map((x) => x.id).filter((id) => (id === g.id ? !on : shown.includes(id))) })} /> {groupLabel(g.name)}
                    </label>
                  );
                })}
              </div>
              <span className="text-ink-500">None ticked: every group but the Last Chance Race.</span>
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-ink-300"><input type="checkbox" checked={c.breakSchedule !== false} onChange={(e) => setC({ ...c, breakSchedule: e.target.checked })} /> Day schedule in the switching (off: the scene starts on the first group results)</label>
          <label className="flex items-center gap-2 text-xs text-ink-300"><input type="checkbox" checked={c.breakAuto} onChange={(e) => setC({ ...c, breakAuto: e.target.checked })} /> Switch day schedule / group results by itself</label>
          <label className="block text-xs text-ink-400">Switch every (s)<input type="number" min={4} max={120} className="input mt-1 w-20 py-1 text-sm" value={c.rotateSeconds} onChange={(e) => setC({ ...c, rotateSeconds: Number(e.target.value) || 30 })} /></label>
          <label className="block text-xs text-ink-400">Out animation before the next board (ms)<input type="number" min={0} max={5000} step={100} className="input mt-1 w-24 py-1 text-sm" value={c.breakOutMs} onChange={(e) => setC({ ...c, breakOutMs: Math.max(0, Number(e.target.value) || 0) })} /></label>
          <label className="block text-xs text-ink-400">Team comparison: wait for the flags' out animation (ms)<input type="number" min={0} max={3000} step={100} className="input mt-1 w-24 py-1 text-sm" value={c.flagChangeMs ?? 500} onChange={(e) => setC({ ...c, flagChangeMs: Math.max(0, Number(e.target.value) || 0) })} /></label>
          <label className="block text-xs text-ink-400" title="All the time (on air or not), for the ATEM: the copies of the day schedule and of each group's results named with 2 (ssl_schedule 2, ssl_results_H 2…) come in and go out in turn on the board channel of this vMix Mix, with their own animations, every board switch time; the L-bar's copy (ssl_lbar 2) stays in on the L-bar channel and changes look with the L-bar. No ticker. UNDO and ALL OUT leave these channels alone. 0 = off.">Clean break (no ticker) on Mix (0 = off)<input type="number" min={0} max={16} step={1} className="input mt-1 w-24 py-1 text-sm" value={c.breakMix ?? 0} onChange={(e) => setC({ ...c, breakMix: Math.max(0, Math.min(16, Number(e.target.value) || 0)) })} /></label>
          {(c.breakMix ?? 0) >= 2 && <div className="flex gap-3">
            <label className="block text-xs text-ink-400">Mix: boards channel<input type="number" min={5} max={8} step={1} className="input mt-1 w-20 py-1 text-sm" value={c.mixBoardLayer ?? 6} onChange={(e) => setC({ ...c, mixBoardLayer: Math.max(5, Math.min(8, Number(e.target.value) || 6)) })} /></label>
            <label className="block text-xs text-ink-400">Mix: L-bar channel (0 = none)<input type="number" min={0} max={8} step={1} className="input mt-1 w-20 py-1 text-sm" value={c.mixLbarLayer ?? 5} onChange={(e) => setC({ ...c, mixLbarLayer: Math.max(0, Math.min(8, Number(e.target.value) || 0)) })} /></label>
            <label className="flex items-center gap-2 self-end text-xs text-ink-400" title="Off (default): the Mix number is sent as in vMix (Mix=2 for Mix 2, 1 is the main output). On: counted from 0 (Mix=1 for Mix 2), for a vMix that takes it so."><input type="checkbox" checked={!!c.mixZeroBased} onChange={(e) => setC({ ...c, mixZeroBased: e.target.checked })} /> Mix counted from 0</label>
          </div>}
          {(c.breakMix ?? 0) >= 2 && <div className="space-y-1 rounded border border-ink-800 p-2 text-xs text-ink-400">
            <label className="flex items-center gap-2 text-ink-200" title="Off: the boards stop switching; the board and the L-bar stay on the Mix (MIX NEXT still changes the board). Also the MIX LOOP key on AFTER / BREAK."><input type="checkbox" checked={c.mixLoopOn !== false} onChange={(e) => setC({ ...c, mixLoopOn: e.target.checked })} /> Loop on the Mix on</label>
            <label className="flex items-center gap-2 text-ink-300"><input type="checkbox" checked={c.mixSchedule !== false} onChange={(e) => setC({ ...c, mixSchedule: e.target.checked })} /> Day schedule in the Mix loop</label>
            {data.breakGroups.length > 0 && <div>Group results in the Mix loop
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {data.breakGroups.map((g) => {
                  const mine = (c.mixFleets ?? []).filter((id) => data.breakGroups.some((x) => x.id === id));
                  const shown = mine.length ? mine : data.breakShown;
                  const on = shown.includes(g.id);
                  return (
                    <label key={g.id} className="flex items-center gap-1 text-ink-200">
                      <input type="checkbox" checked={on} onChange={() => setC({ ...c, mixFleets: data.breakGroups.map((x) => x.id).filter((id) => (id === g.id ? !on : shown.includes(id))) })} /> {groupLabel(g.name)}
                    </label>
                  );
                })}
              </div>
              <span className="text-ink-500">None ticked: the groups of the break scene.</span>
            </div>}
          </div>}
          {(c.breakMix ?? 0) >= 2 && data.mixStatus && <div className="text-xs text-ink-400">
            Mix {c.breakMix}: {data.mixStatus.board || 'no board yet'}{data.mixStatus.lbar ? ` + ${data.mixStatus.lbar}` : ''}
            {data.mixStatus.missing.length > 0 && <div className="text-amber-400">Missing in vMix: {data.mixStatus.missing.join(', ')}</div>}
            {data.mixStatus.error && <div className="text-red-400">{data.mixStatus.error}</div>}
          </div>}
          <label className="block text-xs text-ink-400" title="An L-bar title with a Swap picture (L-bar_switch.gtzip) changes look while it is on air: only the parts that differ cross-fade. 0 = off.">L-bar switch: change look every (s, 0 = off)<input type="number" min={0} max={300} step={1} className="input mt-1 w-24 py-1 text-sm" value={c.lbarSwapSeconds ?? 8} onChange={(e) => setC({ ...c, lbarSwapSeconds: Math.max(0, Math.min(300, Number(e.target.value) || 0)) })} /></label>
          <div className="text-xs text-ink-400">
            {!data.lbarSwap?.length ? <span>L-bar switch: no title with a Swap picture in vMix (load L-bar_switch.gtzip).</span>
              : data.lbarSwap.map((x, i) => (
                <div key={i} className={x.error ? 'text-red-300' : ''}>
                  {x.title ? <>L-bar switch: <b>{x.title}</b> · {x.onAir ? 'on air' : 'not on air'} · showing the {x.look} look{x.changedAt ? ` · last change ${new Date(x.changedAt).toLocaleTimeString()}` : ''}</> : 'L-bar switch:'}
                  {x.error ? ` · ${x.error}` : ''}
                  {x.field ? <div className="truncate text-ink-500" title={x.field}>Swap now: {x.field}</div> : null}
                </div>
              ))}
          </div>
          <LbarLooks looks={data.lbarLooks} />
          <p className="text-xs text-ink-500">BREAK SCENE brings in three inputs, each on its own overlay channel with its own animations: the L-bar (ssl_lbar), the ticker (ssl_ticker: the one picked last, else the automatic one) and the day schedule (if ticked), which then switches with the results of the groups picked. Each group can have its own results input, ssl_results_H, ssl_results_I…, with its own RESULTS key on the AFTER / BREAK page. NEXT SLIDE switches the board by hand, a TICKER key (one per ticker, on the AFTER / BREAK page) puts that ticker on; AUTO SWITCH turns the timed switching on or off. TICKER ON / OFF puts the ticker (ssl_ticker) on its channel alone, without the scene, so it stays on under boards and lower thirds; TOP TICKER ON / OFF does the same for the top ticker (ssl_ticker_top, its versions in General graphics → Top ticker) on its own channel. The break scene's L-bar or board takes the place of the top ticker when they share a channel.</p>
        </div>
      </div>
    </Panel>
  );
}

type CompanionStatus = { enabled: boolean; labels: boolean; companionUrl: string; at?: string | null; sent?: number; unchanged?: number; missing?: number; error?: string | null };

/** The picked page's tab kept in view in its sideways-scrolling row (only that row scrolls, never the page). */
function keepInView(el: HTMLElement | null) {
  const row = el?.parentElement;
  if (!el || !row) return;
  const l = el.offsetLeft - row.offsetLeft, r = l + el.offsetWidth;
  if (l < row.scrollLeft) row.scrollLeft = l - 8;
  else if (r > row.scrollLeft + row.clientWidth) row.scrollLeft = r - row.clientWidth + 8;
}

function CompanionSetup({ data, onSaved }: { data: ShowData; onSaved: () => void }) {
  const { c, setC, dirty, save } = useConfig(data, onSaved);
  const toast = useToast();
  const origin = window.location.origin;
  const teams = data.pages.filter((p) => p.page >= 9 && p.name !== 'COMPARE' && p.name !== 'RESULTS/COMPARE' && p.name !== 'PEOPLE' && !/^TEAMS/.test(p.name));
  const [url, setUrl] = useState(data.companionUrl || '');
  const [pushing, setPushing] = useState(false);
  const st = data.companion;
  const saveAll = async () => {
    try { if (url !== (data.companionUrl || '')) await api.put('/api/lt/config', { companionUrl: url.trim() }); } catch (e) { toast.error(e); return; }
    await save();
  };
  const push = async () => {
    setPushing(true);
    try {
      const r = await api.post<CompanionStatus>('/api/show/labels');
      if (r.error) toast.error(r.error); else toast.ok(`Sent ${r.sent ?? 0} keys${r.missing ? `, ${r.missing} places missing in Companion` : ''}`);
    } catch (e) { toast.error(e); } finally { setPushing(false); onSaved(); }
  };
  return (
    <Panel title="Companion" right={<>
      <Button size="sm" disabled={pushing || !st?.enabled} onClick={push}>{pushing ? 'Pushing…' : 'Push to Companion now'}</Button>
      <Button size="sm" variant="primary" disabled={!dirty && url === (data.companionUrl || '')} onClick={saveAll}>Save</Button>
    </>}>
      <div className="flex flex-wrap items-end gap-4">
        <label className="block text-xs text-ink-400">Companion address
          <input className="input mt-1 w-64 py-1 text-sm" placeholder="http://127.0.0.1:8000" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="block text-xs text-ink-400">vMix address as Companion reaches it (fallback page)
          <input className="input mt-1 w-72 py-1 text-sm" placeholder="same as Settings → vMix" value={c.vmixForCompanion} onChange={(e) => setC({ ...c, vmixForCompanion: e.target.value })} />
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-ink-300">
          <input type="checkbox" checked={c.labels !== false} onChange={(e) => setC({ ...c, labels: e.target.checked })} />
          Send key texts and colours to Companion live
        </label>
      </div>
      <p className={cx('mt-2 text-xs', st?.error ? 'text-red-400' : 'text-ink-400')}>
        {!st?.enabled ? 'Live keys are off: turn them on and give the Companion address.'
          : st.error ? `Last push failed: ${st.error}`
          : st.at ? `Last push ${new Date(st.at).toLocaleTimeString()}: ${st.sent ?? 0} keys sent${st.missing ? `, ${st.missing} places Companion has no button for (import the preset again)` : ''}.`
          : 'Nothing pushed yet.'}
      </p>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-ink-300">
        <li>Download the preset (from the dashboard opened at the address Companion will call). It holds every page in one file: deck 1 on pages 1–2, deck 2 on pages 3–6 (TEAMS, BUGS OFTEN, BUGS RARE, TICKERS), the fallback on page 8, a page per place of the stage's groups on pages 9–24 in group order (A1–A4, B1…; a place with no team yet is named by the place), then COMPARE (25) and PEOPLE (26) ({teams.length} places: {teams.map((p) => p.name).join(', ') || 'none yet'}).
          <div className="mt-2"><a className="rounded bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-600" href={`/api/show/preset.companionconfig?base=${encodeURIComponent(origin)}`} download>Download Companion preset</a></div>
        </li>
        <li>In Companion: <b>Import / Export → Import</b>, pick the file and import it as a full configuration (buttons and connections). It replaces the pages that were there. Then press <b>Push to Companion now</b> once.</li>
        <li>In Companion → Surfaces, put each Stream Deck XL in its own group, with deck 1 starting on page 1 and deck 2 on page 3.</li>
        <li>After that import, changes in the key editor, teams, line-ups, announcements and tickers reach the decks by themselves: each key runs whatever is at its place now, and its text and colour are sent live. Putting a team into a group's place needs no new import: its page and its TEAMS key take the team at once. Download and import again only when the page-switching keys change or the stage's groups change (more places, another stage).</li>
        <li>The last key of the bottom row is the ATEM downstream key (DSK) on every page. TITLES (AFTER / BREAK) puts Rolling_Titles on overlay channel 8 at once, held on its first frame, plays the video 3 seconds later, and takes it off on a second press. The fallback page works without the dashboard: it toggles the graphics straight in vMix with the data they last had.</li>
      </ol>
    </Panel>
  );
}
