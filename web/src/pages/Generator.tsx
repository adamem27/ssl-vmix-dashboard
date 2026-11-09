import { createContext, Fragment, PointerEvent as RPointerEvent, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { MatchboardTab } from './Matchboard';
import { TeamProfileLink } from '../components/TeamProfileLink';
import { api } from '../api';
import { Button, cx, ErrorBox, Loading, useConfirm, useToast } from '../components/ui';
import { ElementSpec, Gradient, GradientStop, NEUTRAL_CODE, NEUTRAL_ID, NeutralSettings, neutralGradient, neutralSpec, parseHex, renderElement, toHex } from '../../../server/src/services/generator/render';
import { useStageTeams } from '../components/StagePicker';

interface Template extends ElementSpec { id: string; sort: number; name: string; fileName: string; variant: number; enabled: boolean }
interface TeamGradients { teamId: string; code: string; name: string; gradients: Record<number, Gradient | null> }
interface GenStatus { autoExport: boolean; folder: string; pending: number; files: number; lastWriteAt: string | null; error: string | null }
interface Output { rel: string; teamId: string; templateId: string; updatedAt: string }
interface GenState { templates: Template[]; teams: TeamGradients[]; status: GenStatus; outputs: Output[]; vmixAssetsRoot: string; strokeGradient: Gradient; neutral: NeutralSettings }

/** The shared gradient that elements with a gradient stroke are painted with. */
const StrokeGradientCtx = createContext<Gradient | null>(null);

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

type GenTab = 'elements' | 'matchboard';
const TABS: [GenTab, string, string][] = [
  ['elements', 'Elements & team colours', 'The exported PNGs and the gradients V1–V3 of each team'],
  ['matchboard', 'Matchboard', 'Bracket graphic with teams, texts and highlights'],
];

export function GeneratorPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find(([k]) => k === params.get('tab'))?.[0] ?? 'elements') as GenTab;
  const q = useQuery({ queryKey: ['generator'], queryFn: () => api.get<GenState>('/api/generator'), refetchOnWindowFocus: false });
  return (
    <div className="space-y-3">
      <nav className="flex flex-wrap gap-1 border-b border-ink-800" aria-label="PNG generator sections">
        {TABS.map(([k, label, hint]) => (
          <button key={k} title={hint} onClick={() => setParams(k === 'elements' ? {} : { tab: k }, { replace: true })}
            className={cx('-mb-px border-b-2 px-4 py-2 text-sm font-semibold', tab === k ? 'border-accent-400 text-ink-50' : 'border-transparent text-ink-400 hover:text-ink-100')}>{label}</button>
        ))}
      </nav>
      {tab === 'matchboard' ? <MatchboardTab />
        : q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : <Generator state={q.data!} />}
    </div>
  );
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
  const [strokeGradient, setStrokeDraft] = useState(state.strokeGradient);
  useEffect(() => setTeams(state.teams), [state.teams]);
  useEffect(() => setTemplates(state.templates), [state.templates]);
  useEffect(() => setStrokeDraft(state.strokeGradient), [state.strokeGradient]);
  const [neutral, setNeutralDraft] = useState(state.neutral);
  useEffect(() => setNeutralDraft(state.neutral), [state.neutral]);
  const neutralRef = useRef(neutral);
  neutralRef.current = neutral;
  const neutralTeam = useMemo<TeamGradients>(() => {
    const g = neutralGradient(neutral.color, neutral.opacity);
    return { teamId: NEUTRAL_ID, code: NEUTRAL_CODE, name: 'Neutral', gradients: { 1: g, 2: g, 3: g } };
  }, [neutral.color, neutral.opacity]);
  const isNeutral = teamId === NEUTRAL_ID;

  const stage = useStageTeams();
  const shown = useMemo(() => teams.filter((t) => stage.inStage(t.teamId)), [teams, stage]);
  useEffect(() => { if (shown.length && teamId !== NEUTRAL_ID && !shown.some((t) => t.teamId === teamId)) setTeamId(shown[0].teamId); }, [shown, teamId]);
  const team = isNeutral ? neutralTeam : shown.find((t) => t.teamId === teamId) ?? null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['generator'] });

  const setGradient = (tid: string, v: number, g: Gradient | null, immediate = false) => {
    setTeams((ts) => ts.map((t) => (t.teamId === tid ? { ...t, gradients: { ...t.gradients, [v]: g } } : t)));
    const save = () => api.put(`/api/generator/gradients/${tid}/${v}`, { gradient: g }).catch((e) => { toast.error(e); refresh(); });
    if (immediate) void save(); else debounce(`g:${tid}:${v}`, save);
  };
  const setStrokeGradient = (g: Gradient | null) => {
    if (g) setStrokeDraft(g);
    const save = () => api.put<{ strokeGradient: Gradient }>('/api/generator/stroke-gradient', { gradient: g })
      .then((r) => { if (!g) setStrokeDraft(r.strokeGradient); }).catch((e) => { toast.error(e); refresh(); });
    if (g) debounce('stroke', save); else void save();
  };
  const setNeutral = (patch: Partial<NeutralSettings>) => {
    neutralRef.current = { ...neutralRef.current, ...patch };
    setNeutralDraft(neutralRef.current);
    debounce('neutral', () => api.put('/api/generator/neutral', neutralRef.current).catch((e) => { toast.error(e); refresh(); }));
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
  return (
    <StrokeGradientCtx.Provider value={strokeGradient}>
    <div className="space-y-3">
      <ExportBar state={state} />
      <ElementsPanel templates={templates} patch={patchTemplate} onReload={refresh} preview={(t) => (
        <ElementPreview template={t} team={team} teams={shown} neutral={isNeutral ? neutral : undefined} bg={bg} setBg={setBg}
          onPick={(id) => setTeamId(id)} />
      )} />
      <div className="grid gap-3 lg:grid-cols-[230px_minmax(0,1fr)]">
        <TeamList teams={shown} selected={teamId} onSelect={setTeamId} neutral={neutral} />
        <div className="min-w-0 space-y-3">
          {isNeutral && <NeutralPanel neutral={neutral} onChange={setNeutral} />}
          {!isNeutral && (team ? (
            <GradientPanel key={team.teamId} team={team} teams={shown} variant={variant} setVariant={setVariant}
              onChange={(g, immediate) => setGradient(team.teamId, variant, g, immediate)} onReload={refresh} />
          ) : <section className="card p-6 text-sm text-ink-400">No teams yet.</section>)}
          <Panel title="Preview" right={<>
            <select className="input w-auto py-1 text-xs" value={view} onChange={(e) => setView(e.target.value)} aria-label="Preview">
              <option value="team">{team ? `${team.code}: all elements` : 'All elements'}</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}: all teams</option>)}
            </select>
            <BgToggle bg={bg} setBg={setBg} />
          </>}>
            {view === 'team'
              ? <TeamPreview team={team} templates={templates} bg={bg} variant={variant} neutral={isNeutral ? neutral : undefined} />
              : <TemplateAcrossTeams template={templates.find((t) => t.id === view)} teams={shown} bg={bg} onPick={(id) => { setTeamId(id); setView('team'); }} />}
          </Panel>
          <StrokeGradientPanel g={strokeGradient} onChange={setStrokeGradient} used={templates.filter((t) => t.strokeGradient && t.strokeWidth > 0).length} />
        </div>
      </div>
    </div>
    </StrokeGradientCtx.Provider>
  );
}

function Panel({ title, right, children, titleExtra }: { title: string; right?: ReactNode; children: ReactNode; titleExtra?: ReactNode }) {
  return (
    <section className="card">
      <header className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-3 py-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink-200">{title}</h2>
        {titleExtra}
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
function TeamList({ teams, selected, onSelect, neutral }: { teams: TeamGradients[]; selected: string; onSelect: (id: string) => void; neutral: NeutralSettings }) {
  const [q, setQ] = useState('');
  const list = teams.filter((t) => !q || `${t.code} ${t.name}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <section className="card flex max-h-[calc(100vh-150px)] flex-col lg:sticky lg:top-[72px]">
      <div className="border-b border-ink-800 p-2"><input className="input py-1 text-sm" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search teams" /></div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1">
        <li className="mb-1 border-b border-ink-800 pb-1">
          <button onClick={() => onSelect(NEUTRAL_ID)} title="Every element in one colour with the orange → yellow stroke"
            className={cx('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm', selected === NEUTRAL_ID ? 'bg-ink-800 text-ink-50' : 'text-ink-300 hover:bg-ink-850')}>
            <span className="w-10 shrink-0 font-mono text-[10px] font-bold">{NEUTRAL_CODE}</span>
            <span className="h-5 flex-1 rounded-sm p-px" style={{ background: 'linear-gradient(135deg, #f28c06, transparent 50%, #fece00)' }}>
              <span className="block h-full rounded-sm" style={{ background: neutral.color, opacity: neutral.opacity / 100 }} />
            </span>
            {!neutral.enabled && <span className="text-[10px] uppercase text-ink-500">off</span>}
          </button>
        </li>
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

/** The neutral set: on/off, its colour and the stroke width of elements that have no stroke of their own. */
function NeutralPanel({ neutral, onChange }: { neutral: NeutralSettings; onChange: (p: Partial<NeutralSettings>) => void }) {
  return (
    <Panel title="Neutral set">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={neutral.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} className="h-4 w-4 accent-sky-500" />
          Generate neutral PNGs
        </label>
        <Labeled label="Colour">
          <div className="flex items-center gap-2">
            <input type="color" value={neutral.color} onChange={(e) => onChange({ color: e.target.value })} className="h-7 w-9 cursor-pointer rounded border border-ink-700 bg-transparent" aria-label="Neutral colour" />
            <HexInput value={neutral.color} onChange={(color) => onChange({ color })} />
          </div>
        </Labeled>
        <Labeled label="Opacity %">
          <NumInput value={neutral.opacity} onChange={(opacity) => onChange({ opacity })} min={0} max={100} step={1} className="w-20" label="Neutral opacity" />
        </Labeled>
        <Labeled label="Stroke width">
          <NumInput value={neutral.strokeWidth} onChange={(strokeWidth) => onChange({ strokeWidth })} min={0} max={200} step={0.5} className="w-20" label="Neutral stroke width" />
        </Labeled>
      </div>
      <p className="mt-3 text-xs text-ink-400">
        As in finals-broadcast_ssl26_v2.ai: every element filled with this colour at this opacity (#1a1a1a at 80%, so the picture shows through), with the orange → yellow stroke at full strength (the stroke gradient on the Elements tab). Elements that already have a stroke keep its width; the others get the width above.
        Files go to <span className="font-mono">PNG generator/{NEUTRAL_CODE}/{NEUTRAL_CODE}_&lt;element&gt;.png</span> and appear in /json/graphics as the {NEUTRAL_CODE} row.
      </p>
    </Panel>
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
  const fromColors = async () => {
    try { await api.post(`/api/generator/gradients/${team.teamId}/from-colors`, { colors: base.filter(Boolean), angle: g?.angle ?? 0 }); onReload(); toast.ok(`${team.code}: V1–V3 set`); } catch (e) { toast.error(e); }
  };
  const copyFrom = (v: number) => { const src = team.gradients[v]; if (src) onChange(structuredClone(src), true); };
  const copyTeam = (tid: string) => { const src = teams.find((t) => t.teamId === tid)?.gradients[variant]; if (src) onChange(structuredClone(src), true); };

  return (
    <Panel title={team.code} titleExtra={<><TeamProfileLink teamId={team.teamId} name={team.name} /><span className="text-sm font-bold uppercase tracking-wide text-ink-200">{team.name}</span></>} right={
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
      ) : <GradientEditor g={g} sel={sel} setSel={setSel} onChange={onChange} />}
    </Panel>
  );
}

/** Stop bar plus the fields of the selected stop; `angle` false hides the angle (the stroke takes it per element). */
function GradientEditor({ g, sel, setSel, onChange, angle = true }: { g: Gradient; sel: number; setSel: (i: number) => void; onChange: (g: Gradient) => void; angle?: boolean }) {
  const stop = g.stops[sel] ?? g.stops[0];
  const update = (patch: Partial<Gradient>) => onChange({ ...g, ...patch });
  const updateStop = (patch: Partial<GradientStop>) => update({ stops: g.stops.map((s) => (s === stop ? { ...s, ...patch } : s)) });
  return (
    <>
      <GradientBar g={g} sel={g.stops.indexOf(stop)} onSelect={setSel} onChange={(stops) => update({ stops })} />
      <div className="mt-4 grid gap-x-4 gap-y-2 sm:grid-cols-2 xl:grid-cols-[auto_auto_auto_minmax(160px,1fr)_auto_minmax(160px,1fr)]">
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
        <Labeled label={angle ? `Angle ${g.angle}°` : ''}>
          <div className="flex items-center gap-2">
            {angle && <Slider min={-180} max={180} value={g.angle} onChange={(a) => update({ angle: a })} label="Angle" />}
            <button className="text-xs text-ink-400 hover:text-ink-100" title="Reverse" onClick={() => update({ stops: g.stops.map((s) => ({ ...s, pos: 100 - s.pos })).sort((a, b) => a.pos - b.pos) })}>⇄</button>
          </div>
        </Labeled>
      </div>
    </>
  );
}

function StrokeGradientPanel({ g, onChange, used }: { g: Gradient; onChange: (g: Gradient | null) => void; used: number }) {
  const [sel, setSel] = useState(0);
  return (
    <Panel title="Stroke gradient" right={<>
      <span className="text-xs text-ink-500">{used ? `${used} element${used === 1 ? '' : 's'} · angle per element` : 'Tick “Gradient” at an element’s stroke to use it'}</span>
      <Button size="sm" variant="ghost" onClick={() => { onChange(null); setSel(0); }}>Reset to gradienty.ai</Button>
    </>}>
      <GradientEditor g={g} sel={sel} setSel={setSel} onChange={onChange} angle={false} />
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
/** The expanded row of the elements table: the element for the selected team, large, then for every team. */
function ElementPreview({ template: t, team, teams, neutral, bg, setBg, onPick }: {
  template: Template; team: TeamGradients | null; teams: TeamGradients[]; neutral?: NeutralSettings; bg: Bg; setBg: (b: Bg) => void; onPick: (teamId: string) => void;
}) {
  const g = team?.gradients[t.variant] ?? null;
  return (
    <div className="space-y-3 pt-1">
      <div className="flex flex-wrap items-start gap-4">
        <figure className="min-w-0">
          <div className={cx('grid min-h-[60px] place-items-center rounded p-3 ring-1 ring-ink-700', bgClass(bg))}>
            {g ? <Canvas spec={neutral ? neutralSpec(specOf(t), neutral) : specOf(t)} gradient={g} maxW={960} maxH={340} />
              : <span className="px-3 py-2 text-xs text-ink-500">{team ? `${team.code}: V${t.variant} not set` : 'No team selected'}</span>}
          </div>
          <figcaption className="mt-1 flex items-center gap-2 text-xs">
            <span className="font-mono font-bold text-ink-200">{team?.code}</span>
            <span className="text-ink-500">{t.width}×{t.height} · V{t.variant} · {t.fileName}.png</span>
            {g && team && <a className="ml-auto text-ink-400 hover:text-accent-300" href={`/api/generator/png?team=${team.teamId}&template=${t.id}`}>↓ Download</a>}
          </figcaption>
        </figure>
        <div className="ml-auto"><BgToggle bg={bg} setBg={setBg} /></div>
      </div>
      <TemplateAcrossTeams template={t} teams={teams} bg={bg} onPick={onPick} />
    </div>
  );
}

function Canvas({ spec, gradient, maxW, maxH }: { spec: ElementSpec; gradient: Gradient; maxW: number; maxH: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const strokeGradient = useContext(StrokeGradientCtx);
  const scale = Math.min(1, maxW / spec.width, maxH / spec.height);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const r = renderElement(spec, gradient, scale, spec.strokeGradient ? strokeGradient : null);
    c.width = r.width; c.height = r.height;
    c.getContext('2d')!.putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
  }, [spec, gradient, scale, spec.strokeGradient && strokeGradient]);
  return <canvas ref={ref} className="block max-w-full" />;
}

const specOf = (t: Template): ElementSpec => t;

function TeamPreview({ team, templates, bg, variant, neutral }: { team: TeamGradients | null; templates: Template[]; bg: Bg; variant: number; neutral?: NeutralSettings }) {
  if (!team) return null;
  if (!templates.length) return <p className="text-sm text-ink-400">Add an element below.</p>;
  return (
    <div className="flex flex-wrap items-end gap-4">
      {templates.map((t) => {
        const g = team.gradients[t.variant];
        return (
          <figure key={t.id} className={cx('min-w-[120px]', !t.enabled && 'opacity-40')}>
            <div className={cx('grid min-h-[48px] place-items-center rounded p-2 ring-1', bgClass(bg), t.variant === variant ? 'ring-accent-500/70' : 'ring-ink-700')}>
              {g ? <Canvas spec={neutral ? neutralSpec(specOf(t), neutral) : specOf(t)} gradient={g} maxW={420} maxH={220} /> : <span className="px-3 py-2 text-xs text-ink-500">V{t.variant} not set</span>}
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

function TemplateAcrossTeams({ template, teams, bg, onPick }: { template: Template | undefined; teams: TeamGradients[]; bg: Bg; onPick: (teamId: string) => void }) {
  if (!template) return null;
  const list = teams.filter((t) => t.gradients[template.variant]);
  const missing = teams.length - list.length;
  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
        {list.map((t) => (
          <button key={t.teamId} onClick={() => onPick(t.teamId)} className="text-left">
            <div className={cx('grid h-24 place-items-center rounded p-2 ring-1 ring-ink-700 hover:ring-accent-400', bgClass(bg))}>
              <Canvas spec={specOf(template)} gradient={t.gradients[template.variant]!} maxW={164} maxH={80} />
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
function ElementsPanel({ templates, patch, onReload, preview }: { templates: Template[]; patch: (id: string, p: Partial<Template>) => void; onReload: () => void; preview: (t: Template) => ReactNode }) {
  const toast = useToast();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOpen = templates.length > 0 && templates.every((t) => open.has(t.id));
  // the preview row spans the whole (scrollable) table; keep its content as wide as the visible part
  const scroller = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { ask, dialog } = useConfirm();
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); onReload(); } catch (e) { toast.error(e); } };
  const add = () => act(() => {
    const names = new Set(templates.map((t) => t.fileName));
    let n = templates.length + 1;
    while (names.has(`element_${n}`)) n++;
    return api.post('/api/generator/templates', {
      name: `Element ${n}`, fileName: `element_${n}`, variant: 1, width: 600, height: 80, radius: 0, corner: 'round', cutX: 0, cutY: 0, cutSides: 'both', opacity: 100, flip: false, angleOffset: 0,
      strokeWidth: 0, strokeColor: '#9a9a9a', strokeOpacity: 100, strokeGradient: false, strokeAngle: -45, pattern: true, patternOpacity: 10, patternScale: 100, enabled: true,
    });
  });
  const th = 'px-1.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-ink-500';
  const num = (t: Template, k: keyof Template, w = 'w-16', min = 0, max = 4096) => (
    <NumInput className={w} min={min} max={max} value={t[k] as number} label={String(k)} onChange={(n) => patch(t.id, { [k]: n })} />
  );
  return (
    <Panel title="PNG elements" right={<>
      <Button size="sm" variant="ghost" onClick={() => setOpen(allOpen ? new Set() : new Set(templates.map((t) => t.id)))}>{allOpen ? 'Collapse all' : 'Expand all'}</Button>
      <Button size="sm" onClick={add}>+ Element</Button>
    </>}>
      {dialog}
      <div ref={scroller} className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-800">
              <th className={th} /><th className={th}>On</th><th className={th}>Name</th><th className={th}>File</th><th className={th}>Ver.</th>
              <th className={th}>W</th><th className={th}>H</th><th className={th}>Corners</th><th className={th}>Opacity %</th>
              <th className={th}>Flip</th><th className={th}>Angle +</th><th className={th}>Stroke px</th><th className={th}>Stroke</th><th className={th}>Gradient</th><th className={th}>Stroke ∠</th>
              <th className={th}>Waves</th><th className={th}>Waves %</th><th className={th}>Waves size %</th><th className={th} />
            </tr>
          </thead>
          <tbody>
            {templates.map((t, i) => (
              <Fragment key={t.id}>
              <tr className={cx('align-middle', open.has(t.id) ? 'bg-ink-900/60' : 'border-b border-ink-850')}>
                <td className="pl-1">
                  <button onClick={() => toggle(t.id)} aria-expanded={open.has(t.id)} title={open.has(t.id) ? 'Hide preview' : 'Show preview'}
                    className={cx('grid h-7 w-7 place-items-center rounded text-ink-400 transition-transform hover:bg-ink-800 hover:text-ink-100', open.has(t.id) && 'rotate-90 text-accent-300')}>▸</button>
                </td>
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
                <td className="px-1.5">
                  <div className="flex items-center gap-1">
                    <select className="input w-auto px-1.5 py-1" value={t.corner ?? 'round'} onChange={(e) => patch(t.id, e.target.value === 'cut' && !t.cutX && !t.cutY ? { corner: 'cut', cutX: Math.round(t.height / 3), cutY: Math.round(t.height / 3) } : { corner: e.target.value as 'round' | 'cut' })} aria-label="Corner shape" title="Rounded or cut corners; the number is the radius or how far the cut reaches along each edge (px)">
                      <option value="round">◜ Round</option>
                      <option value="cut">◸ Cut</option>
                    </select>
                    <span title={t.corner === 'cut' ? 'Rounding of every vertex (px)' : 'Corner radius (px)'}>{num(t, 'radius')}</span>
                    {t.corner === 'cut' && <>
                      <span title="How far the cut reaches along the top and bottom edge (px)" className="flex items-center gap-0.5 text-[10px] text-ink-500">↔{num(t, 'cutX', 'w-16')}</span>
                      <span title="How far the cut reaches along the side edge (px); half the height or more makes a point" className="flex items-center gap-0.5 text-[10px] text-ink-500">↕{num(t, 'cutY', 'w-16')}</span>
                      <select className="input w-auto px-1.5 py-1" value={t.cutSides ?? 'both'} onChange={(e) => patch(t.id, { cutSides: e.target.value as 'both' | 'left' | 'right' })} aria-label="Cut ends" title="Which ends are cut">
                        <option value="both">Both ends</option>
                        <option value="left">Left end</option>
                        <option value="right">Right end</option>
                      </select>
                      <button className="whitespace-nowrap rounded px-1.5 py-1 text-[10px] text-ink-400 hover:bg-ink-800 hover:text-ink-100" title="Cut the full height: the end becomes a point"
                        onClick={() => patch(t.id, { cutY: Math.ceil(t.height / 2) })}>▷ point</button>
                    </>}
                  </div>
                </td>
                <td className="px-1.5">{num(t, 'opacity', 'w-16', 0, 100)}</td>
                <td className="px-1.5"><input type="checkbox" checked={t.flip} onChange={(e) => patch(t.id, { flip: e.target.checked })} className="h-4 w-4 accent-sky-500" aria-label="Flip" /></td>
                <td className="px-1.5">{num(t, 'angleOffset', 'w-16', -360, 360)}</td>
                <td className="px-1.5">{num(t, 'strokeWidth', 'w-16', 0, 200)}</td>
                <td className="px-1.5">
                  <div className="flex items-center gap-1">
                    <input type="color" value={t.strokeColor} disabled={t.strokeGradient} onChange={(e) => patch(t.id, { strokeColor: e.target.value })} className="h-7 w-8 cursor-pointer rounded border border-ink-700 bg-transparent disabled:cursor-default disabled:opacity-30" aria-label="Stroke colour" />
                    {num(t, 'strokeOpacity', 'w-16', 0, 100)}
                  </div>
                </td>
                <td className="px-1.5"><input type="checkbox" checked={t.strokeGradient} onChange={(e) => patch(t.id, { strokeGradient: e.target.checked, ...(e.target.checked && !t.strokeWidth ? { strokeWidth: 1 } : {}) })} className="h-4 w-4 accent-sky-500" aria-label="Gradient stroke" title="Paint the stroke with the stroke gradient (below)" /></td>
                <td className={cx('px-1.5', !t.strokeGradient && 'opacity-40')}>{num(t, 'strokeAngle', 'w-16', -360, 360)}</td>
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
              {open.has(t.id) && (
                <tr className="border-b border-ink-850 bg-ink-900/60"><td colSpan={19} className="pb-3"><div className="sticky left-0 px-3" style={viewW ? { width: viewW } : undefined}>{preview(t)}</div></td></tr>
              )}
              </Fragment>
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
