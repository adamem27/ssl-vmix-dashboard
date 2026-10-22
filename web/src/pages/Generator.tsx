import { PointerEvent as RPointerEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Button, cx, ErrorBox, Loading, useConfirm, useToast } from '../components/ui';
import {
  DEFAULT_PATTERN, ElementSpec, Gradient, GradientStop, parseHex, PatternSpec, renderElement, Tile, toHex,
} from '../../../server/src/services/generator/render';

interface Template extends ElementSpec { id: string; sort: number; name: string; fileName: string; variant: number; enabled: boolean }
interface TeamGradients { teamId: string; code: string; name: string; gradients: Record<number, Gradient | null> }
interface GenStatus { autoExport: boolean; folder: string; pending: number; files: number; lastWriteAt: string | null; error: string | null }
interface Output { rel: string; teamId: string; templateId: string; updatedAt: string }
interface GenState { templates: Template[]; teams: TeamGradients[]; pattern: PatternSpec; tile: { url: string } | null; status: GenStatus; outputs: Output[]; vmixAssetsRoot: string }

const VARIANTS = [1, 2, 3];
type Bg = 'checker' | 'dark' | 'light';

/** Calls fn after `ms` without further calls for the same key. */
function useDebouncer(ms = 300) {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return (key: string, fn: () => void) => {
    clearTimeout(timers.current.get(key));
    timers.current.set(key, setTimeout(() => { timers.current.delete(key); fn(); }, ms));
  };
}

const rgba = (s: GradientStop) => { const [r, g, b] = parseHex(s.color); return `rgba(${r},${g},${b},${s.opacity / 100})`; };
const cssGradient = (g: Gradient | null, angle = 90) =>
  g ? `linear-gradient(${angle}deg, ${[...g.stops].sort((a, b) => a.pos - b.pos).map((s) => `${rgba(s)} ${s.pos}%`).join(', ')})` : 'none';

function colorAt(g: Gradient, pos: number): GradientStop {
  const s = [...g.stops].sort((a, b) => a.pos - b.pos);
  if (pos <= s[0].pos) return { ...s[0], pos };
  if (pos >= s[s.length - 1].pos) return { ...s[s.length - 1], pos };
  const i = s.findIndex((x) => x.pos >= pos);
  const a = s[i - 1], b = s[i];
  const f = (pos - a.pos) / (b.pos - a.pos || 1);
  const ca = parseHex(a.color), cb = parseHex(b.color);
  return { pos, color: toHex([0, 1, 2].map((k) => ca[k] + (cb[k] - ca[k]) * f) as [number, number, number]), opacity: Math.round(a.opacity + (b.opacity - a.opacity) * f) };
}

function useTile(url: string | undefined) {
  const [tile, setTile] = useState<Tile | null>(null);
  useEffect(() => {
    if (!url) { setTile(null); return; }
    let live = true;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      if (live) setTile({ width: c.width, height: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data });
    };
    img.src = url;
    return () => { live = false; };
  }, [url]);
  return tile;
}

export function GeneratorPage() {
  const q = useQuery({ queryKey: ['generator'], queryFn: () => api.get<GenState>('/api/generator'), refetchOnWindowFocus: false });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  return <Generator state={q.data!} />;
}

function Generator({ state }: { state: GenState }) {
  const qc = useQueryClient();
  const toast = useToast();
  const debounce = useDebouncer(350);
  const [teamId, setTeamId] = useState(() => state.teams.find((t) => t.gradients[1])?.teamId ?? state.teams[0]?.teamId ?? '');
  const [variant, setVariant] = useState(1);
  const [bg, setBg] = useState<Bg>('checker');
  const [view, setView] = useState<'team' | string>('team');

  // Local drafts so sliders redraw instantly; the server gets debounced saves.
  const [teams, setTeams] = useState(state.teams);
  const [templates, setTemplates] = useState(state.templates);
  const [pattern, setPatternDraft] = useState(state.pattern);
  useEffect(() => setTeams(state.teams), [state.teams]);
  useEffect(() => setTemplates(state.templates), [state.templates]);
  useEffect(() => setPatternDraft(state.pattern), [state.pattern]);
  const tile = useTile(state.tile?.url);

  const team = teams.find((t) => t.teamId === teamId) ?? null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['generator'] });

  const setGradient = (tid: string, v: number, g: Gradient | null, immediate = false) => {
    setTeams((ts) => ts.map((t) => (t.teamId === tid ? { ...t, gradients: { ...t.gradients, [v]: g } } : t)));
    const save = () => api.put(`/api/generator/gradients/${tid}/${v}`, { gradient: g }).catch((e) => { toast.error(e); refresh(); });
    if (immediate) void save(); else debounce(`g:${tid}:${v}`, save);
  };
  const patchTemplate = (id: string, patch: Partial<Template>) => {
    setTemplates((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    debounce(`t:${id}`, () => {
      const cur = templatesRef.current.find((t) => t.id === id);
      if (!cur) return;
      const { id: _i, sort: _s, ...spec } = cur;
      api.patch(`/api/generator/templates/${id}`, spec).catch((e) => { toast.error(e); refresh(); });
    });
  };
  const templatesRef = useRef(templates);
  templatesRef.current = templates;
  const setPattern = (patch: Partial<PatternSpec>) => {
    setPatternDraft((p) => ({ ...p, ...patch }));
    debounce('pattern', () => api.put('/api/generator/pattern', patternRef.current).catch((e) => { toast.error(e); refresh(); }));
  };
  const patternRef = useRef(pattern);
  patternRef.current = { ...pattern };

  return (
    <div className="space-y-3">
      <ExportBar state={state} />
      <div className="grid gap-3 lg:grid-cols-[230px_minmax(0,1fr)]">
        <TeamList teams={teams} selected={teamId} onSelect={setTeamId} />
        <div className="min-w-0 space-y-3">
          {team ? (
            <GradientPanel key={team.teamId} team={team} teams={teams} variant={variant} setVariant={setVariant}
              onChange={(g, immediate) => setGradient(team.teamId, variant, g, immediate)} onReload={refresh} />
          ) : <section className="card p-6 text-sm text-ink-400">No teams yet.</section>}
          <Panel title="Preview" right={<>
            <select className="input w-auto py-1 text-xs" value={view} onChange={(e) => setView(e.target.value)} aria-label="Preview">
              <option value="team">{team ? `${team.code}: all elements` : 'All elements'}</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}: all teams</option>)}
            </select>
            <BgToggle bg={bg} setBg={setBg} />
          </>}>
            {view === 'team'
              ? <TeamPreview team={team} templates={templates} pattern={pattern} tile={tile} bg={bg} variant={variant} />
              : <TemplateAcrossTeams template={templates.find((t) => t.id === view)} teams={teams} pattern={pattern} tile={tile} bg={bg} onPick={(id) => { setTeamId(id); setView('team'); }} />}
          </Panel>
          <ElementsPanel templates={templates} patch={patchTemplate} onReload={refresh} />
          <PatternPanel pattern={pattern} setPattern={setPattern} tile={state.tile} onReload={refresh} />
        </div>
      </div>
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
      <div className="p-3">{children}</div>
    </section>
  );
}

function BgToggle({ bg, setBg }: { bg: Bg; setBg: (b: Bg) => void }) {
  return (
    <div className="flex overflow-hidden rounded border border-ink-700 text-xs">
      {(['checker', 'dark', 'light'] as Bg[]).map((b) => (
        <button key={b} onClick={() => setBg(b)} className={cx('px-2 py-1', bg === b ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-100')}>{b === 'checker' ? '▦' : b === 'dark' ? '■' : '□'}</button>
      ))}
    </div>
  );
}
const bgClass = (bg: Bg) => (bg === 'checker' ? 'checker' : bg === 'dark' ? 'bg-preview-dark' : 'bg-preview-light');

// ---------- export status ----------
function ExportBar({ state }: { state: GenState }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const st = useQuery({ queryKey: ['generator-status'], queryFn: () => api.get<{ status: GenStatus }>('/api/generator/status'), refetchInterval: 2000, initialData: { status: state.status } });
  const s = st.data.status;
  const vmixFolder = state.vmixAssetsRoot ? `${state.vmixAssetsRoot.replace(/[\\/]+$/, '')}${/^[a-zA-Z]:|^\\\\/.test(state.vmixAssetsRoot) ? '\\' : '/'}generated` : null;
  const toggle = async () => {
    try { await api.put('/api/generator/settings', { autoExport: !s.autoExport }); await st.refetch(); } catch (e) { toast.error(e); }
  };
  const exportNow = async () => {
    setBusy(true);
    try { await api.post('/api/generator/export', { all: true }); await st.refetch(); qc.invalidateQueries({ queryKey: ['generator'] }); toast.ok('All PNGs exported'); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <section className="card flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 text-sm">
      <h1 className="text-sm font-bold uppercase tracking-wide text-ink-200">PNG generator</h1>
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={s.autoExport} onChange={toggle} className="h-4 w-4 accent-sky-500" />
        <span className="text-ink-200">Auto export</span>
      </label>
      <span className="text-ink-400">{s.files} files{s.pending > 0 && <span className="text-amber-300"> · {s.pending} pending</span>}</span>
      {s.error && <span className="text-red-300">⚠ {s.error}</span>}
      <span className="min-w-0 truncate font-mono text-xs text-ink-500" title={s.folder}>{vmixFolder ?? s.folder}</span>
      <div className="ml-auto flex gap-2">
        <Button size="sm" onClick={exportNow} busy={busy}>Export now</Button>
        <a href="/api/generator/zip" className="inline-flex items-center rounded-md border border-ink-700 bg-ink-800 px-2.5 py-1 text-xs font-medium text-ink-100 hover:bg-ink-700">ZIP</a>
      </div>
    </section>
  );
}

// ---------- teams ----------
function TeamList({ teams, selected, onSelect }: { teams: TeamGradients[]; selected: string; onSelect: (id: string) => void }) {
  const [q, setQ] = useState('');
  const list = teams.filter((t) => !q || `${t.code} ${t.name}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <section className="card flex max-h-[calc(100vh-150px)] flex-col lg:sticky lg:top-[72px]">
      <div className="border-b border-ink-800 p-2"><input className="input py-1 text-sm" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search teams" /></div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1">
        {list.map((t) => (
          <li key={t.teamId}>
            <button onClick={() => onSelect(t.teamId)} className={cx('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm', t.teamId === selected ? 'bg-ink-800 text-ink-50' : 'text-ink-300 hover:bg-ink-850')}>
              <span className="w-10 shrink-0 font-mono text-xs font-bold">{t.code}</span>
              <span className="flex flex-1 flex-col gap-0.5">
                {VARIANTS.map((v) => <span key={v} className={cx('block h-1.5 overflow-hidden rounded-sm', t.gradients[v] ? 'checker' : 'bg-ink-800')}><span className="block h-full" style={{ background: cssGradient(t.gradients[v]) }} /></span>)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- gradient editor ----------
function GradientPanel({ team, teams, variant, setVariant, onChange, onReload }: {
  team: TeamGradients; teams: TeamGradients[]; variant: number; setVariant: (v: number) => void; onChange: (g: Gradient | null, immediate?: boolean) => void; onReload: () => void;
}) {
  const toast = useToast();
  const g = team.gradients[variant];
  const [sel, setSel] = useState(0);
  const [base, setBase] = useState<string[]>(() => {
    const s = team.gradients[1]?.stops.filter((x) => x.opacity > 0) ?? [];
    return s.length ? [s[0].color, s[s.length - 1].color] : ['#e30820', '#f6a010'];
  });
  const stop = g?.stops[sel] ?? g?.stops[0];
  const update = (patch: Partial<Gradient>) => g && onChange({ ...g, ...patch });
  const updateStop = (patch: Partial<GradientStop>) => g && stop && update({ stops: g.stops.map((s, i) => (s === stop ? { ...s, ...patch } : s)) });

  const fromColors = async () => {
    try { await api.post(`/api/generator/gradients/${team.teamId}/from-colors`, { colors: base.filter(Boolean), angle: g?.angle ?? 0 }); onReload(); toast.ok(`${team.code}: V1–V3 set`); } catch (e) { toast.error(e); }
  };
  const copyFrom = (v: number) => { const src = team.gradients[v]; if (src) onChange(structuredClone(src), true); };
  const copyTeam = (tid: string) => { const src = teams.find((t) => t.teamId === tid)?.gradients[variant]; if (src) onChange(structuredClone(src), true); };

  return (
    <Panel title={`${team.code} · ${team.name}`} right={
      <div className="flex overflow-hidden rounded border border-ink-700 text-xs">
        {VARIANTS.map((v) => (
          <button key={v} onClick={() => { setVariant(v); setSel(0); }} className={cx('flex items-center gap-1.5 px-3 py-1', variant === v ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-100')}>
            V{v}<span className={cx('inline-block h-2 w-8 overflow-hidden rounded-sm', team.gradients[v] ? 'checker' : 'bg-ink-800')}><span className="block h-full" style={{ background: cssGradient(team.gradients[v]) }} /></span>
          </button>
        ))}
      </div>
    }>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        {base.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <input type="color" value={c || '#000000'} onChange={(e) => setBase(base.map((x, k) => (k === i ? e.target.value : x)))} className="h-7 w-9 cursor-pointer rounded border border-ink-700 bg-transparent" aria-label={`Colour ${i + 1}`} />
            {i === 2 && <button className="text-ink-500 hover:text-ink-200" onClick={() => setBase(base.slice(0, 2))} aria-label="Remove third colour">✕</button>}
          </span>
        ))}
        {base.length < 3 && <Button size="sm" variant="ghost" onClick={() => setBase([base[0], base[0], base[1]])}>+ colour</Button>}
        <Button size="sm" variant="primary" onClick={fromColors}>→ V1 V2 V3</Button>
        <span className="mx-1 h-5 w-px bg-ink-700" />
        {VARIANTS.filter((v) => v !== variant && team.gradients[v]).map((v) => <Button key={v} size="sm" variant="ghost" onClick={() => copyFrom(v)}>Copy V{v}</Button>)}
        <select className="input w-auto py-1 text-xs" value="" onChange={(e) => copyTeam(e.target.value)} aria-label="Copy from team">
          <option value="">Copy from team…</option>
          {teams.filter((t) => t.teamId !== team.teamId && t.gradients[variant]).map((t) => <option key={t.teamId} value={t.teamId}>{t.code}</option>)}
        </select>
        {g && <Button size="sm" variant="ghost" onClick={() => onChange(null, true)}>Clear V{variant}</Button>}
      </div>

      {!g ? (
        <div className="flex items-center gap-3 rounded-lg border border-dashed border-ink-700 p-4 text-sm text-ink-400">
          V{variant} not set.
          <Button size="sm" onClick={() => onChange({ angle: 0, stops: [{ pos: 0, color: base[0], opacity: 100 }, { pos: 100, color: base[base.length - 1], opacity: 100 }] }, true)}>Create</Button>
        </div>
      ) : (
        <>
          <GradientBar g={g} sel={g.stops.indexOf(stop!)} onSelect={setSel} onChange={(stops) => update({ stops })} />
          <div className="mt-4 grid gap-x-4 gap-y-2 sm:grid-cols-2 xl:grid-cols-[auto_auto_auto_minmax(160px,1fr)_auto_minmax(160px,1fr)]">
            {stop && <>
              <Labeled label="Colour">
                <div className="flex items-center gap-1">
                  <input type="color" value={stop.color} onChange={(e) => updateStop({ color: e.target.value })} className="h-8 w-10 cursor-pointer rounded border border-ink-700 bg-transparent" aria-label="Stop colour" />
                  <HexInput value={stop.color} onChange={(color) => updateStop({ color })} />
                </div>
              </Labeled>
              <Labeled label="R G B">
                <div className="flex gap-1">
                  {[0, 1, 2].map((k) => (
                    <NumInput key={k} className="w-16" min={0} max={255} value={parseHex(stop.color)[k]} label={'RGB'[k]}
                      onChange={(n) => { const c = parseHex(stop.color); c[k] = n; updateStop({ color: toHex(c) }); }} />
                  ))}
                </div>
              </Labeled>
              <Labeled label="Position %"><NumInput className="w-16" min={0} max={100} value={stop.pos} label="Position" onChange={(pos) => updateStop({ pos })} /></Labeled>
              <Labeled label={`Opacity ${stop.opacity}%`}><Slider min={0} max={100} value={stop.opacity} onChange={(opacity) => updateStop({ opacity })} label="Stop opacity" /></Labeled>
              <Labeled label="">
                <Button size="sm" variant="ghost" disabled={g.stops.length <= 2} onClick={() => { update({ stops: g.stops.filter((s) => s !== stop) }); setSel(0); }}>Delete stop</Button>
              </Labeled>
            </>}
            <Labeled label={`Angle ${g.angle}°`}>
              <div className="flex items-center gap-2">
                <Slider min={-180} max={180} value={g.angle} onChange={(angle) => update({ angle })} label="Angle" />
                <button className="text-xs text-ink-400 hover:text-ink-100" title="Reverse" onClick={() => update({ stops: g.stops.map((s) => ({ ...s, pos: 100 - s.pos })).sort((a, b) => a.pos - b.pos) })}>⇄</button>
              </div>
            </Labeled>
          </div>
        </>
      )}
    </Panel>
  );
}

function GradientBar({ g, sel, onSelect, onChange }: { g: Gradient; sel: number; onSelect: (i: number) => void; onChange: (stops: GradientStop[]) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  const posFrom = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)) * 10) / 10;
  };
  const addAt = (e: RPointerEvent) => {
    const pos = posFrom(e.clientX);
    const stops = [...g.stops, colorAt(g, pos)];
    onChange(stops);
    onSelect(stops.length - 1);
  };
  const move = (e: RPointerEvent) => {
    if (drag.current === null) return;
    const pos = posFrom(e.clientX);
    onChange(g.stops.map((s, i) => (i === drag.current ? { ...s, pos } : s)));
  };
  return (
    <div className="select-none px-2">
      <div ref={ref} className="checker relative h-10 cursor-copy rounded-md ring-1 ring-ink-700" onPointerDown={addAt} title="Click to add a stop">
        <div className="absolute inset-0 rounded-md" style={{ background: cssGradient(g) }} />
      </div>
      <div className="relative h-7" onPointerMove={move} onPointerUp={() => { drag.current = null; }}>
        {g.stops.map((s, i) => (
          <button key={i} aria-label={`Stop ${Math.round(s.pos)}%`}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = i; onSelect(i); }}
            onPointerMove={move} onPointerUp={() => { drag.current = null; }}
            onKeyDown={(e) => {
              const d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
              if (d) { e.preventDefault(); onChange(g.stops.map((x, k) => (k === i ? { ...x, pos: Math.max(0, Math.min(100, x.pos + d * (e.shiftKey ? 10 : 1))) } : x))); }
            }}
            className={cx('absolute top-1 h-5 w-4 -translate-x-1/2 cursor-ew-resize rounded-sm border-2 shadow', i === sel ? 'border-accent-400' : 'border-ink-200')}
            style={{ left: `${s.pos}%`, background: s.color, opacity: 0.35 + (s.opacity / 100) * 0.65 }} />
        ))}
      </div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0"><div className="mb-1 h-4 text-[10px] font-semibold uppercase tracking-wide text-ink-500">{label}</div>{children}</div>;
}

function Slider({ min, max, value, onChange, label, step = 1 }: { min: number; max: number; value: number; onChange: (n: number) => void; label: string; step?: number }) {
  return <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} className="h-8 w-full accent-sky-500" />;
}

/** Number field that keeps typing free and reports only valid numbers. */
function NumInput({ value, onChange, min, max, step, className, label }: { value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; className?: string; label: string }) {
  const [v, setV] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setV(String(value)); }, [value]);
  const push = (s: string) => {
    setV(s);
    const n = Number(s);
    if (s.trim() !== '' && Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max)) onChange(n);
  };
  return (
    <input type="number" inputMode="decimal" aria-label={label} value={v} min={min} max={max} step={step}
      onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; setV(String(value)); }}
      onChange={(e) => push(e.target.value)} className={cx('input px-2 py-1 text-sm', className)} />
  );
}

function HexInput({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input className="input w-24 px-2 py-1 font-mono text-sm uppercase" value={v} aria-label="Hex colour" maxLength={7}
      onChange={(e) => { const s = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`; setV(s); if (/^#[0-9a-f]{6}$/i.test(s)) onChange(s.toLowerCase()); }}
      onBlur={() => setV(value)} />
  );
}

// ---------- previews ----------
function Canvas({ spec, gradient, pattern, tile, maxW, maxH }: { spec: ElementSpec; gradient: Gradient; pattern: PatternSpec; tile: Tile | null; maxW: number; maxH: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const scale = Math.min(1, maxW / spec.width, maxH / spec.height);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const r = renderElement(spec, gradient, pattern, spec.pattern ? tile : null, scale);
    c.width = r.width; c.height = r.height;
    c.getContext('2d')!.putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
  }, [spec, gradient, pattern, tile, scale]);
  return <canvas ref={ref} className="block max-w-full" />;
}

const specOf = (t: Template): ElementSpec => t;

function TeamPreview({ team, templates, pattern, tile, bg, variant }: { team: TeamGradients | null; templates: Template[]; pattern: PatternSpec; tile: Tile | null; bg: Bg; variant: number }) {
  if (!team) return null;
  if (!templates.length) return <p className="text-sm text-ink-400">Add an element below.</p>;
  return (
    <div className="flex flex-wrap items-end gap-4">
      {templates.map((t) => {
        const g = team.gradients[t.variant];
        return (
          <figure key={t.id} className={cx('min-w-[120px]', !t.enabled && 'opacity-40')}>
            <div className={cx('grid min-h-[48px] place-items-center rounded p-2 ring-1', bgClass(bg), t.variant === variant ? 'ring-accent-500/70' : 'ring-ink-700')}>
              {g ? <Canvas spec={specOf(t)} gradient={g} pattern={pattern} tile={tile} maxW={420} maxH={220} /> : <span className="px-3 py-2 text-xs text-ink-500">V{t.variant} not set</span>}
            </div>
            <figcaption className="mt-1 flex items-center gap-2 text-xs">
              <span className="font-semibold text-ink-200">{t.name}</span>
              <span className="text-ink-500">{t.width}×{t.height} · V{t.variant}</span>
              {g && <a className="ml-auto text-ink-400 hover:text-accent-300" href={`/api/generator/png?team=${team.teamId}&template=${t.id}`} title="Download PNG">↓</a>}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

function TemplateAcrossTeams({ template, teams, pattern, tile, bg, onPick }: { template: Template | undefined; teams: TeamGradients[]; pattern: PatternSpec; tile: Tile | null; bg: Bg; onPick: (teamId: string) => void }) {
  if (!template) return null;
  const list = teams.filter((t) => t.gradients[template.variant]);
  const missing = teams.length - list.length;
  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
        {list.map((t) => (
          <button key={t.teamId} onClick={() => onPick(t.teamId)} className="text-left">
            <div className={cx('grid h-24 place-items-center rounded p-2 ring-1 ring-ink-700 hover:ring-accent-400', bgClass(bg))}>
              <Canvas spec={specOf(template)} gradient={t.gradients[template.variant]!} pattern={pattern} tile={tile} maxW={164} maxH={80} />
            </div>
            <div className="mt-1 font-mono text-xs font-bold text-ink-300">{t.code}</div>
          </button>
        ))}
      </div>
      {missing > 0 && <p className="mt-3 text-xs text-ink-500">{missing} teams without V{template.variant}</p>}
    </>
  );
}

// ---------- elements ----------
function ElementsPanel({ templates, patch, onReload }: { templates: Template[]; patch: (id: string, p: Partial<Template>) => void; onReload: () => void }) {
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); onReload(); } catch (e) { toast.error(e); } };
  const add = () => act(() => {
    const names = new Set(templates.map((t) => t.fileName));
    let n = templates.length + 1;
    while (names.has(`element_${n}`)) n++;
    return api.post('/api/generator/templates', {
      name: `Element ${n}`, fileName: `element_${n}`, variant: 1, width: 600, height: 80, radius: 0, opacity: 100, flip: false, angleOffset: 0,
      strokeWidth: 0, strokeColor: '#9a9a9a', strokeOpacity: 100, pattern: false, patternOpacity: 22, patternScale: 100, enabled: true,
    });
  });
  const th = 'px-1.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-ink-500';
  const num = (t: Template, k: keyof Template, w = 'w-16', min = 0, max = 4096) => (
    <NumInput className={w} min={min} max={max} value={t[k] as number} label={String(k)} onChange={(n) => patch(t.id, { [k]: n })} />
  );
  return (
    <Panel title="PNG elements" right={<Button size="sm" onClick={add}>+ Element</Button>}>
      {dialog}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-800">
              <th className={th}>On</th><th className={th}>Name</th><th className={th}>File</th><th className={th}>Ver.</th>
              <th className={th}>W</th><th className={th}>H</th><th className={th}>Radius</th><th className={th}>Opacity %</th>
              <th className={th}>Flip</th><th className={th}>Angle +</th><th className={th}>Stroke px</th><th className={th}>Stroke</th>
              <th className={th}>Waves</th><th className={th}>Waves %</th><th className={th}>Waves size %</th><th className={th} />
            </tr>
          </thead>
          <tbody>
            {templates.map((t, i) => (
              <tr key={t.id} className="border-b border-ink-850 align-middle">
                <td className="px-1.5"><input type="checkbox" checked={t.enabled} onChange={(e) => patch(t.id, { enabled: e.target.checked })} className="h-4 w-4 accent-sky-500" aria-label="Enabled" /></td>
                <td className="px-1.5"><TextInput className="w-28" value={t.name} label="Name" onChange={(name) => name.trim() && patch(t.id, { name })} /></td>
                <td className="px-1.5"><TextInput className="w-28 font-mono" value={t.fileName} label="File name" onChange={(fileName) => /^[\w.-]+$/.test(fileName) && patch(t.id, { fileName })} /></td>
                <td className="px-1.5">
                  <select className="input w-auto px-2 py-1" value={t.variant} onChange={(e) => patch(t.id, { variant: Number(e.target.value) })} aria-label="Gradient version">
                    {VARIANTS.map((v) => <option key={v} value={v}>V{v}</option>)}
                  </select>
                </td>
                <td className="px-1.5">{num(t, 'width', 'w-[4.5rem]', 1)}</td>
                <td className="px-1.5">{num(t, 'height', 'w-[4.5rem]', 1)}</td>
                <td className="px-1.5">{num(t, 'radius')}</td>
                <td className="px-1.5">{num(t, 'opacity', 'w-16', 0, 100)}</td>
                <td className="px-1.5"><input type="checkbox" checked={t.flip} onChange={(e) => patch(t.id, { flip: e.target.checked })} className="h-4 w-4 accent-sky-500" aria-label="Flip" /></td>
                <td className="px-1.5">{num(t, 'angleOffset', 'w-16', -360, 360)}</td>
                <td className="px-1.5">{num(t, 'strokeWidth', 'w-16', 0, 200)}</td>
                <td className="px-1.5">
                  <div className="flex items-center gap-1">
                    <input type="color" value={t.strokeColor} onChange={(e) => patch(t.id, { strokeColor: e.target.value })} className="h-7 w-8 cursor-pointer rounded border border-ink-700 bg-transparent" aria-label="Stroke colour" />
                    {num(t, 'strokeOpacity', 'w-16', 0, 100)}
                  </div>
                </td>
                <td className="px-1.5"><input type="checkbox" checked={t.pattern} onChange={(e) => patch(t.id, { pattern: e.target.checked })} className="h-4 w-4 accent-sky-500" aria-label="Waves" /></td>
                <td className="px-1.5">{num(t, 'patternOpacity', 'w-16', 0, 100)}</td>
                <td className="px-1.5">{num(t, 'patternScale', 'w-16', 5, 1000)}</td>
                <td className="whitespace-nowrap px-1.5 text-right">
                  <button className="px-1 text-ink-400 hover:text-ink-100 disabled:opacity-30" disabled={i === 0} onClick={() => act(() => api.post(`/api/generator/templates/${t.id}/move`, { direction: -1 }))} aria-label="Move up">↑</button>
                  <button className="px-1 text-ink-400 hover:text-ink-100 disabled:opacity-30" disabled={i === templates.length - 1} onClick={() => act(() => api.post(`/api/generator/templates/${t.id}/move`, { direction: 1 }))} aria-label="Move down">↓</button>
                  <button className="px-1 text-ink-400 hover:text-ink-100" onClick={() => act(() => api.post(`/api/generator/templates/${t.id}/duplicate`))} title="Duplicate">⧉</button>
                  <button className="px-1 text-ink-400 hover:text-red-300" title="Delete"
                    onClick={async () => { if (await ask(`Delete “${t.name}”?`, 'Its PNG files are removed for every team.', 'Delete')) void act(() => api.del(`/api/generator/templates/${t.id}`)); }}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function TextInput({ value, onChange, className, label }: { value: string; onChange: (s: string) => void; className?: string; label: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input className={cx('input px-2 py-1', className)} value={v} aria-label={label} onChange={(e) => { setV(e.target.value); onChange(e.target.value); }} onBlur={() => setV(value)} />;
}

// ---------- pattern ----------
function PatternPanel({ pattern, setPattern, tile, onReload }: { pattern: PatternSpec; setPattern: (p: Partial<PatternSpec>) => void; tile: { url: string } | null; onReload: () => void }) {
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const upload = async (f: File) => { try { await api.upload('/api/generator/pattern-tile', f); onReload(); toast.ok('Pattern image set'); } catch (e) { toast.error(e); } };
  const remove = async () => { try { await api.del('/api/generator/pattern-tile'); onReload(); } catch (e) { toast.error(e); } };
  const preview = useMemo<ElementSpec>(() => ({ width: 360, height: 90, radius: 6, opacity: 100, flip: false, angleOffset: 0, strokeWidth: 0, strokeColor: '#000000', strokeOpacity: 0, pattern: true, patternOpacity: 60, patternScale: 100 }), []);
  const previewTile = useTile(tile?.url);
  const field = (k: keyof PatternSpec, label: string, min: number, max: number, step = 1) => (
    <Labeled label={`${label} ${pattern[k]}`}><Slider min={min} max={max} step={step} value={pattern[k] as number} onChange={(n) => setPattern({ [k]: n })} label={label} /></Labeled>
  );
  return (
    <Panel title="Copacabana waves" right={<>
      {tile ? <Button size="sm" variant="ghost" onClick={remove}>Use drawn waves</Button> : null}
      <Button size="sm" onClick={() => file.current?.click()}>{tile ? 'Replace pattern PNG' : 'Use own pattern PNG'}</Button>
      <input ref={file} type="file" accept="image/png,.png" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
      <Button size="sm" variant="ghost" onClick={() => setPattern(DEFAULT_PATTERN)}>Reset</Button>
    </>}>
      <div className="grid items-center gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
        <div className="checker w-fit rounded p-1 ring-1 ring-ink-700">
          <Canvas spec={preview} gradient={{ angle: 0, stops: [{ pos: 0, color: '#1b3250', opacity: 100 }, { pos: 100, color: '#70bae8', opacity: 100 }] }} pattern={pattern} tile={previewTile} maxW={360} maxH={90} />
        </div>
        {tile ? (
          <p className="text-sm text-ink-400">Tiled from the uploaded PNG at 100% element waves size. Opacity per element.</p>
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            <Labeled label="Colour"><div className="flex items-center gap-1"><input type="color" value={pattern.color} onChange={(e) => setPattern({ color: e.target.value })} className="h-8 w-10 cursor-pointer rounded border border-ink-700 bg-transparent" aria-label="Waves colour" /><HexInput value={pattern.color} onChange={(color) => setPattern({ color })} /></div></Labeled>
            {field('wavelength', 'Wave length px', 4, 300)}
            {field('period', 'Row height px', 4, 200)}
            {field('amplitude', 'Wave height', 0, 1, 0.01)}
            {field('band', 'Line thickness', 0.05, 0.95, 0.01)}
            {field('angle', 'Angle °', -90, 90)}
          </div>
        )}
      </div>
    </Panel>
  );
}
