import { createContext, Fragment, PointerEvent as RPointerEvent, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { MatchboardTab } from './Matchboard';
import { TeamProfileLink } from '../components/TeamProfileLink';
import { api } from '../api';
import { Button, cx, ErrorBox, Loading, useConfirm, useToast } from '../components/ui';
import { ElementSpec, Gradient, GradientStop, NEUTRAL_CODE, NEUTRAL_ID, NeutralSettings, neutralGradients, neutralSpec, parseHex, renderElement, toHex } from '../../../server/src/services/generator/render';
import { useStageTeams } from '../components/StagePicker';

type Scope = 'teams' | 'neutral' | 'both';
const forScope = (t: { scope: Scope }, neutral: boolean) => t.scope === 'both' || t.scope === (neutral ? 'neutral' : 'teams');
interface Template extends ElementSpec { id: string; sort: number; name: string; fileName: string; variant: number; enabled: boolean; scope: Scope }
type From = NonNullable<ElementSpec['gradientFrom']>;
const fromOf = (t: ElementSpec): From => t.gradientFrom ?? (t.flip ? 'right' : 'left');
interface TeamGradients { teamId: string; code: string; name: string; gradients: Record<number, Gradient | null> }
interface GenStatus { autoExport: boolean; folder: string; pending: number; files: number; lastWriteAt: string | null; error: string | null }
interface Output { rel: string; teamId: string; templateId: string; updatedAt: string }
type CustomGraphic = Omit<Template, 'sort' | 'variant' | 'scope'> & { gradient: Gradient };
interface GenState { templates: Template[]; teams: TeamGradients[]; status: GenStatus; outputs: Output[]; vmixAssetsRoot: string; strokeGradient: Gradient; neutral: NeutralSettings; custom: CustomGraphic[] }

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

type GenTab = 'elements' | 'custom' | 'matchboard';
const TABS: [GenTab, string, string][] = [
  ['elements', 'Team elements', 'Shapes made once for every team in its colours (V1–V3) and in the neutral set. Change a shape here and every team’s PNG follows.'],
  ['custom', 'Custom graphics', 'One-off PNGs that belong to no team or group: your own size, shape and colours. They never change the team elements, and the team elements never change them.'],
  ['matchboard', 'Matchboard', 'The bracket graphic with teams, texts and highlights.'],
];

export function GeneratorPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find(([k]) => k === params.get('tab'))?.[0] ?? 'elements') as GenTab;
  const q = useQuery({ queryKey: ['generator'], queryFn: () => api.get<GenState>('/api/generator'), refetchOnWindowFocus: false });
  const hint = TABS.find(([k]) => k === tab)![2];
  return (
    <div className="space-y-3">
      <nav className="flex flex-wrap gap-1 border-b border-ink-800" aria-label="PNG generator sections">
        {TABS.map(([k, label, h]) => (
          <button key={k} title={h} onClick={() => setParams(k === 'elements' ? {} : { tab: k }, { replace: true })}
            className={cx('-mb-px border-b-2 px-4 py-2 text-sm font-semibold', tab === k ? 'border-accent-400 text-ink-50' : 'border-transparent text-ink-400 hover:text-ink-100')}>
            {label}{k === 'custom' && q.data?.custom.length ? <span className="ml-1.5 rounded bg-ink-800 px-1.5 text-[10px] text-ink-300">{q.data.custom.length}</span> : null}
          </button>
        ))}
      </nav>
      <p className="text-sm text-ink-400">{hint}</p>
      {tab === 'matchboard' ? <MatchboardTab />
        : q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : (
          <>
            <ExportBar state={q.data!} />
            {tab === 'custom' ? <CustomTab state={q.data!} /> : <Generator state={q.data!} />}
          </>
        )}
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
    const [v1, v2, v3] = neutralGradients(neutral.color, neutral.opacity);
    return { teamId: NEUTRAL_ID, code: NEUTRAL_CODE, name: 'Neutral', gradients: { 1: v1, 2: v2, 3: v3 } };
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
      <ElementsPanel templates={templates} patch={patchTemplate} onReload={refresh} newScope={isNeutral ? 'neutral' : 'teams'} preview={(t) => (
        <ElementPreview template={t} team={t.scope === 'neutral' || (t.scope === 'both' && isNeutral) ? neutralTeam : isNeutral ? null : team} teams={shown} neutral={t.scope === 'neutral' || (t.scope === 'both' && isNeutral) ? neutral : undefined} bg={bg} setBg={setBg}
          onPick={(id) => setTeamId(id)} />
      )} />
      <div className="flex items-baseline gap-2 px-1 pt-1">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink-200">2 · Team colours</h2>
        <span className="text-xs text-ink-500">pick a team (or NEUTRAL) on the left and set its gradients V1–V3; the preview shows its PNGs</span>
      </div>
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
              {templates.filter((t) => t.scope !== 'neutral').map((t) => <option key={t.id} value={t.id}>{t.name}: all teams</option>)}
            </select>
            <BgToggle bg={bg} setBg={setBg} />
          </>}>
            {view === 'team'
              ? <TeamPreview team={team} templates={templates.filter((t) => forScope(t, isNeutral))} bg={bg} variant={variant} neutral={isNeutral ? neutral : undefined} />
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
      <h1 className="text-sm font-bold uppercase tracking-wide text-ink-200">Export</h1>
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
        As in finals-broadcast_ssl26_v2.ai: neutral elements (“For: Neutral” in the table above) are filled with this colour at this opacity (#1a1a1a at 80%, so the picture shows through), with the orange → yellow stroke at full strength. Their version works as for teams: V1 flat, V2 fading in, V3 fading in and out, from the side set in “Gradient from”. The stroke uses the stroke gradient below; elements that already have a stroke keep its width, the others get the width above.
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

/**
 * A horizontal scrollbar for another element, kept in step with it both ways. Placed above an open preview so the
 * wide elements table can be scrolled without going down past the preview.
 */
function ScrollProxy({ target }: { target: React.RefObject<HTMLDivElement | null> }) {
  const track = useRef<HTMLDivElement>(null);
  const [m, setM] = useState({ left: 0, scroll: 1, client: 1 });
  useEffect(() => {
    const t = target.current;
    if (!t) return;
    const read = () => setM({ left: t.scrollLeft, scroll: t.scrollWidth, client: t.clientWidth });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(t);
    if (t.firstElementChild) ro.observe(t.firstElementChild);
    t.addEventListener('scroll', read);
    return () => { ro.disconnect(); t.removeEventListener('scroll', read); };
  }, [target]);
  const max = Math.max(1, m.scroll - m.client);
  const thumb = Math.max(8, (m.client / m.scroll) * 100); // % of the track
  const pos = (m.left / max) * (100 - thumb);
  const go = (clientX: number, grab: number) => {
    const tr = track.current?.getBoundingClientRect(), t = target.current;
    if (!tr || !t) return;
    const f = (clientX - tr.left - grab) / (tr.width * (1 - thumb / 100));
    t.scrollLeft = Math.max(0, Math.min(1, f)) * max;
  };
  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    const tr = track.current!.getBoundingClientRect();
    const thumbLeft = tr.left + (pos / 100) * tr.width, thumbW = (thumb / 100) * tr.width;
    const grab = e.clientX >= thumbLeft && e.clientX <= thumbLeft + thumbW ? e.clientX - thumbLeft : thumbW / 2;
    go(e.clientX, grab);
    const move = (ev: PointerEvent) => go(ev.clientX, grab);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  };
  return (
    <div ref={track} onPointerDown={onDown} role="scrollbar" aria-orientation="horizontal" aria-valuenow={Math.round((m.left / max) * 100)}
      aria-label="Scroll the elements table" title="Scroll the elements table"
      className="relative mb-2 h-2.5 cursor-pointer select-none rounded-full bg-ink-950/70 ring-1 ring-ink-800">
      <div className="absolute inset-y-0 rounded-full bg-ink-600 hover:bg-ink-500" style={{ left: `${pos}%`, width: `${thumb}%` }} />
    </div>
  );
}

// ---------- previews ----------
/** The expanded row of the elements table: the element for the selected team, large, then for every team. */
function ElementPreview({ template: t, team, teams, neutral, bg, setBg, onPick }: {
  template: Template; team: TeamGradients | null; teams: TeamGradients[]; neutral?: NeutralSettings; bg: Bg; setBg: (b: Bg) => void; onPick: (teamId: string) => void;
}) {
  const g = team?.gradients[t.variant] ?? null;
  const teamsOnly = t.scope !== 'neutral';
  return (
    <div className="space-y-3 pt-1">
      <div className="flex flex-wrap items-start gap-4">
        <figure className="min-w-0">
          <div className={cx('grid min-h-[60px] place-items-center rounded p-3 ring-1 ring-ink-700', bgClass(bg))}>
            {g ? <Canvas spec={neutral ? neutralSpec(specOf(t), neutral) : specOf(t)} gradient={g} maxW={960} maxH={340} />
              : <span className="px-3 py-2 text-xs text-ink-500">{team ? `${team.code}: V${t.variant} not set` : 'Pick a team on the left to see it large'}</span>}
          </div>
          <figcaption className="mt-1 flex items-center gap-2 text-xs">
            <span className="font-mono font-bold text-ink-200">{team?.code}</span>
            <span className="text-ink-500">{t.width}×{t.height} · V{t.variant} · {t.fileName}.png</span>
            {g && team && <a className="ml-auto text-ink-400 hover:text-accent-300" href={`/api/generator/png?team=${team.teamId}&template=${t.id}`}>↓ Download</a>}
          </figcaption>
        </figure>
        <div className="ml-auto"><BgToggle bg={bg} setBg={setBg} /></div>
      </div>
      {teamsOnly ? <TemplateAcrossTeams template={t} teams={teams} bg={bg} onPick={onPick} />
        : <p className="text-xs text-ink-500">A neutral element: made only in the neutral colours, never for the teams. Choose “Both” in For to make it for the teams too.</p>}
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
  if (!templates.length) return <p className="text-sm text-ink-400">{neutral ? 'No neutral elements yet: set “For” to Neutral in the elements table, or add one with NEUTRAL selected.' : 'No team elements yet: add one in the elements table.'}</p>;
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
function ElementsPanel({ templates, patch, onReload, preview, newScope }: { templates: Template[]; patch: (id: string, p: Partial<Template>) => void; onReload: () => void; preview: (t: Template) => ReactNode; newScope: Scope }) {
  const toast = useToast();
  const strokeGradient = useContext(StrokeGradientCtx);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOpen = templates.length > 0 && templates.every((t) => open.has(t.id));
  // the preview row spans the whole (scrollable) table; keep its content as wide as the visible part
  const scroller = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(0);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { setViewW(el.clientWidth); setOverflows(el.scrollWidth > el.clientWidth + 1); });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);
  const { ask, dialog } = useConfirm();
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); onReload(); } catch (e) { toast.error(e); } };
  const add = () => act(() => {
    const names = new Set(templates.map((t) => t.fileName));
    let n = templates.length + 1;
    while (names.has(`element_${n}`)) n++;
    return api.post('/api/generator/templates', {
      scope: newScope, name: `Element ${n}`, fileName: `element_${n}`, variant: 1, width: 600, height: 80, radius: 0, corner: 'round', cutX: 0, cutY: 0, cutSides: 'both', opacity: 100, flip: false, angleOffset: 0,
      strokeWidth: 1, strokeColor: '#9a9a9a', strokeOpacity: 100, strokeGradient: true, strokeAngle: -45, pattern: true, patternOpacity: 10, patternScale: 100, enabled: true,
    });
  });
  const th = 'px-1.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-ink-500';
  const num = (t: Template, k: keyof Template, w = 'w-16', min = 0, max = 4096) => (
    <NumInput className={w} min={min} max={max} value={t[k] as number} label={String(k)} onChange={(n) => patch(t.id, { [k]: n })} />
  );
  return (
    <Panel title="1 · Shapes" titleExtra={<span className="text-xs text-ink-500">one row per PNG made for every team · ▸ opens a preview</span>} right={<>
      <Button size="sm" variant="ghost" onClick={() => setOpen(allOpen ? new Set() : new Set(templates.map((t) => t.id)))}>{allOpen ? 'Collapse all' : 'Expand all'}</Button>
      <Button size="sm" onClick={add} title={newScope === 'neutral' ? 'New neutral element (NEUTRAL is selected)' : 'New team element'}>+ {newScope === 'neutral' ? 'Neutral element' : 'Element'}</Button>
    </>}>
      {dialog}
      <div ref={scroller} className={cx('overflow-x-auto', open.size > 0 && overflows && '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden')}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-800">
              <th className={th} /><th className={th}>On</th><th className={th}>For</th><th className={th}>Name</th><th className={th}>File</th><th className={th}>Ver.</th>
              <th className={th}>W</th><th className={th}>H</th><th className={th}>Corners</th><th className={th}>Opacity %</th>
              <th className={th}>Gradient from</th><th className={th}>Angle +</th><th className={th}>Stroke px</th><th className={th}>Stroke</th><th className={th}>Gradient</th><th className={th}>Stroke ∠</th>
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
                <td className="px-1.5">
                  <select className={cx('input w-auto px-1.5 py-1', t.scope === 'neutral' && 'text-amber-300', t.scope === 'both' && 'text-sky-300')} value={t.scope} onChange={(e) => patch(t.id, { scope: e.target.value as Scope })} aria-label="Made for" title="Teams: one PNG per team in its colours. Neutral: one PNG in the neutral colours only. Both: the team PNGs and the neutral one.">
                    <option value="teams">Teams</option>
                    <option value="neutral">Neutral</option>
                    <option value="both">Both</option>
                  </select>
                </td>
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
                <td className="px-1.5">
                  <select className="input w-auto px-1.5 py-1" value={fromOf(t)} onChange={(e) => { const v = e.target.value as From; patch(t.id, { gradientFrom: v, flip: v === 'right' }); }} aria-label="Gradient from" title="Where the gradient (and its fade) starts">
                    <option value="left">→ Left</option>
                    <option value="right">← Right</option>
                    <option value="top">↓ Top</option>
                    <option value="bottom">↑ Bottom</option>
                  </select>
                </td>
                <td className="px-1.5">{num(t, 'angleOffset', 'w-16', -360, 360)}</td>
                <td className="px-1.5">{num(t, 'strokeWidth', 'w-16', 0, 200)}</td>
                <td className="px-1.5">
                  <div className="flex items-center gap-1">
                    {t.strokeGradient
                      ? <span className="checker block h-7 w-8 overflow-hidden rounded border border-ink-700" title="Painted with the stroke gradient (orange → yellow, below)"><span className="block h-full" style={{ background: cssGradient(strokeGradient, 90 - t.strokeAngle) }} /></span>
                      : <input type="color" value={t.strokeColor} onChange={(e) => patch(t.id, { strokeColor: e.target.value })} className="h-7 w-8 cursor-pointer rounded border border-ink-700 bg-transparent" aria-label="Stroke colour" title="Solid stroke colour; tick Gradient for the orange → yellow stroke" />}
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
                <tr className="border-b border-ink-850 bg-ink-900/60"><td colSpan={20} className="pb-3"><div className="sticky left-0 px-3" style={viewW ? { width: viewW } : undefined}>
                  {overflows && <ScrollProxy target={scroller} />}
                  {preview(t)}
                </div></td></tr>
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

// ---------- custom graphics ----------
const BLANK_GRADIENT: Gradient = { angle: 0, stops: [{ pos: 0, color: '#e30820', opacity: 100 }, { pos: 100, color: '#f6a010', opacity: 100 }] };

/** One-off PNGs with their own size, shape and gradient; stored apart from the team elements. */
function CustomTab({ state }: { state: GenState }) {
  const qc = useQueryClient();
  const toast = useToast();
  const debounce = useDebouncer(350);
  const { ask, dialog } = useConfirm();
  const [list, setList] = useState(state.custom);
  useEffect(() => setList(state.custom), [state.custom]);
  const listRef = useRef(list);
  listRef.current = list;
  const [selId, setSelId] = useState(() => state.custom[0]?.id ?? '');
  const [bg, setBg] = useState<Bg>('checker');
  const [stopSel, setStopSel] = useState(0);
  const refresh = () => qc.invalidateQueries({ queryKey: ['generator'] });
  const sel = list.find((c) => c.id === selId) ?? list[0] ?? null;

  const patch = (id: string, p: Partial<CustomGraphic>) => {
    setList((l) => l.map((c) => (c.id === id ? { ...c, ...p } : c)));
    debounce(`c:${id}`, () => {
      const cur = listRef.current.find((c) => c.id === id);
      if (!cur) return;
      const { id: _i, ...body } = cur;
      api.patch(`/api/generator/custom/${id}`, body).catch((e) => { toast.error(e); refresh(); });
    });
  };
  const create = async (body: Omit<CustomGraphic, 'id'>) => {
    try { const c = await api.post<CustomGraphic>('/api/generator/custom', body); setSelId(c.id); setStopSel(0); refresh(); } catch (e) { toast.error(e); }
  };
  const freeNumber = (base: string) => {
    const names = new Set(list.map((c) => c.fileName.toLowerCase()));
    let n = list.length + 1;
    while (names.has(`${base}_${n}`.toLowerCase())) n++;
    return n;
  };
  const addBlank = () => {
    const n = freeNumber('custom');
    void create({
      name: `Custom ${n}`, fileName: `custom_${n}`, width: 800, height: 100, radius: 0, corner: 'round', cutX: 0, cutY: 0, cutSides: 'both', opacity: 100, flip: false, angleOffset: 0,
      strokeWidth: 1, strokeColor: '#9a9a9a', strokeOpacity: 100, strokeGradient: true, strokeAngle: -45, pattern: true, patternOpacity: 10, patternScale: 100, enabled: true, gradient: BLANK_GRADIENT,
    });
  };
  /** a copy of a team element's shape (and the first team colour it has), to change freely */
  const addFromElement = (tid: string) => {
    const t = state.templates.find((x) => x.id === tid);
    if (!t) return;
    const { id: _i, sort: _s, variant, scope: _sc, ...shape } = t;
    const g = state.teams.find((x) => x.gradients[variant])?.gradients[variant] ?? BLANK_GRADIENT;
    const n = freeNumber(t.fileName);
    void create({ ...shape, name: `${t.name} (custom)`, fileName: `${t.fileName}_${n}`, enabled: true, gradient: structuredClone(g) });
  };
  const sources = useMemo(() => {
    const out: { key: string; label: string; g: Gradient }[] = [];
    neutralGradients(state.neutral.color, state.neutral.opacity).forEach((g, i) => out.push({ key: `n${i}`, label: `${NEUTRAL_CODE} · V${i + 1}`, g }));
    for (const t of state.teams) for (const v of VARIANTS) { const g = t.gradients[v]; if (g) out.push({ key: `${t.teamId}:${v}`, label: `${t.code} · V${v}`, g }); }
    return out;
  }, [state.teams, state.neutral]);

  const num = (c: CustomGraphic, k: keyof CustomGraphic, label: string, min = 0, max = 4096, w = 'w-20') => (
    <Labeled label={label}><NumInput className={w} min={min} max={max} value={c[k] as number} label={label} onChange={(n) => patch(c.id, { [k]: n } as Partial<CustomGraphic>)} /></Labeled>
  );

  return (
    <StrokeGradientCtx.Provider value={state.strokeGradient}>
      {dialog}
      <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
        <section className="card flex max-h-[calc(100vh-150px)] flex-col lg:sticky lg:top-[72px]">
          <div className="space-y-2 border-b border-ink-800 p-2">
            <Button size="sm" variant="primary" className="w-full" onClick={addBlank}>+ New custom graphic</Button>
            <select className="input py-1 text-xs" value="" onChange={(e) => addFromElement(e.target.value)} aria-label="Start from a team element">
              <option value="">Copy the shape of a team element…</option>
              {state.templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.width}×{t.height})</option>)}
            </select>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto p-1">
            {list.map((c) => (
              <li key={c.id}>
                <button onClick={() => { setSelId(c.id); setStopSel(0); }} className={cx('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm', c.id === sel?.id ? 'bg-ink-800 text-ink-50' : 'text-ink-300 hover:bg-ink-850', !c.enabled && 'opacity-50')}>
                  <span className="checker block h-5 w-12 shrink-0 overflow-hidden rounded-sm"><span className="block h-full" style={{ background: cssGradient(c.gradient) }} /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium">{c.name}</span><span className="block truncate font-mono text-[10px] text-ink-500">{c.fileName}.png · {c.width}×{c.height}</span></span>
                </button>
              </li>
            ))}
            {!list.length && <li className="px-2 py-4 text-xs text-ink-500">No custom graphics yet. Start a blank one, or copy the shape of a team element and change it.</li>}
          </ul>
        </section>

        {sel ? (
          <div className="min-w-0 space-y-3">
            <Panel title={sel.name} right={<>
              <BgToggle bg={bg} setBg={setBg} />
              <a className="inline-flex items-center rounded-md border border-ink-700 bg-ink-800 px-2.5 py-1 text-xs font-medium text-ink-100 hover:bg-ink-700" href={`/api/generator/custom/${sel.id}/png`}>↓ Download PNG</a>
              <Button size="sm" variant="ghost" onClick={async () => { try { const d = await api.post<CustomGraphic>(`/api/generator/custom/${sel.id}/duplicate`); setSelId(d.id); refresh(); } catch (e) { toast.error(e); } }}>⧉ Duplicate</Button>
              <Button size="sm" variant="ghost" onClick={async () => {
                if (!(await ask(`Delete “${sel.name}”?`, 'Its PNG file is removed too. Team elements are not affected.', 'Delete'))) return;
                try { await api.del(`/api/generator/custom/${sel.id}`); setSelId(''); refresh(); } catch (e) { toast.error(e); }
              }}>✕ Delete</Button>
            </>}>
              <div className={cx('grid min-h-[120px] place-items-center rounded p-4 ring-1 ring-ink-700', bgClass(bg))}>
                <Canvas spec={sel} gradient={sel.gradient} maxW={1100} maxH={420} />
              </div>
              <p className="mt-2 text-xs text-ink-500">Exported as <span className="font-mono">PNG generator/Custom/{sel.fileName}.png</span>{sel.enabled ? '' : ' (export is off)'} · listed in /json/custom-graphics.</p>
            </Panel>

            <Panel title="File">
              <div className="flex flex-wrap items-end gap-3 text-sm">
                <Labeled label="Name"><TextInput className="w-56" value={sel.name} label="Name" onChange={(name) => name.trim() && patch(sel.id, { name })} /></Labeled>
                <Labeled label="File name (.png)"><TextInput className="w-56 font-mono" value={sel.fileName} label="File name" onChange={(fileName) => /^[\w.-]+$/.test(fileName) && patch(sel.id, { fileName })} /></Labeled>
                <label className="mb-1.5 flex items-center gap-2"><input type="checkbox" checked={sel.enabled} onChange={(e) => patch(sel.id, { enabled: e.target.checked })} className="h-4 w-4 accent-sky-500" />Export with the others</label>
              </div>
            </Panel>

            <Panel title="Shape">
              <div className="flex flex-wrap items-end gap-3 text-sm">
                {num(sel, 'width', 'Width px', 1)}
                {num(sel, 'height', 'Height px', 1)}
                <Labeled label="Corners">
                  <select className="input w-auto px-1.5 py-1" value={sel.corner ?? 'round'} aria-label="Corner shape"
                    onChange={(e) => patch(sel.id, e.target.value === 'cut' && !sel.cutX && !sel.cutY ? { corner: 'cut', cutX: Math.round(sel.height / 3), cutY: Math.round(sel.height / 3) } : { corner: e.target.value as 'round' | 'cut' })}>
                    <option value="round">◜ Round</option><option value="cut">◸ Cut</option>
                  </select>
                </Labeled>
                {num(sel, 'radius', sel.corner === 'cut' ? 'Vertex rounding' : 'Radius')}
                {sel.corner === 'cut' && <>
                  {num(sel, 'cutX', 'Cut ↔')}
                  {num(sel, 'cutY', 'Cut ↕')}
                  <Labeled label="Cut ends">
                    <select className="input w-auto px-1.5 py-1" value={sel.cutSides ?? 'both'} onChange={(e) => patch(sel.id, { cutSides: e.target.value as 'both' | 'left' | 'right' })} aria-label="Cut ends">
                      <option value="both">Both</option><option value="left">Left</option><option value="right">Right</option>
                    </select>
                  </Labeled>
                </>}
                {num(sel, 'opacity', 'Opacity %', 0, 100)}
              </div>
            </Panel>

            <Panel title="Colour" right={
              <select className="input w-auto py-1 text-xs" value="" aria-label="Copy a gradient"
                onChange={(e) => { const src = sources.find((x) => x.key === e.target.value); if (src) { patch(sel.id, { gradient: structuredClone(src.g) }); setStopSel(0); } }}>
                <option value="">Copy a gradient from…</option>
                {sources.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
              </select>
            }>
              <GradientEditor g={sel.gradient} sel={stopSel} setSel={setStopSel} onChange={(gradient) => patch(sel.id, { gradient })} />
              <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
                <Labeled label="Gradient from">
                  <select className="input w-auto px-1.5 py-1" value={fromOf(sel)} onChange={(e) => { const v = e.target.value as From; patch(sel.id, { gradientFrom: v, flip: v === 'right' }); }} aria-label="Gradient from">
                    <option value="left">→ Left</option><option value="right">← Right</option><option value="top">↓ Top</option><option value="bottom">↑ Bottom</option>
                  </select>
                </Labeled>
                {num(sel, 'angleOffset', 'Angle +', -360, 360)}
              </div>
            </Panel>

            <Panel title="Stroke and waves">
              <div className="flex flex-wrap items-end gap-3 text-sm">
                {num(sel, 'strokeWidth', 'Stroke px', 0, 200)}
                <Labeled label="Stroke">
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1 text-xs text-ink-300" title="Paint the stroke with the shared orange → yellow stroke gradient">
                      <input type="checkbox" checked={sel.strokeGradient} onChange={(e) => patch(sel.id, { strokeGradient: e.target.checked, ...(e.target.checked && !sel.strokeWidth ? { strokeWidth: 1 } : {}) })} className="h-4 w-4 accent-sky-500" />Gradient
                    </label>
                    {!sel.strokeGradient && <input type="color" value={sel.strokeColor} onChange={(e) => patch(sel.id, { strokeColor: e.target.value })} className="h-7 w-9 cursor-pointer rounded border border-ink-700 bg-transparent" aria-label="Stroke colour" />}
                  </div>
                </Labeled>
                {sel.strokeGradient && num(sel, 'strokeAngle', 'Stroke ∠', -360, 360)}
                {num(sel, 'strokeOpacity', 'Stroke %', 0, 100)}
                <label className="mb-1.5 flex items-center gap-2"><input type="checkbox" checked={sel.pattern} onChange={(e) => patch(sel.id, { pattern: e.target.checked })} className="h-4 w-4 accent-sky-500" />Waves</label>
                {sel.pattern && <>{num(sel, 'patternOpacity', 'Waves %', 0, 100)}{num(sel, 'patternScale', 'Waves size %', 5, 1000)}</>}
              </div>
            </Panel>
          </div>
        ) : <section className="card p-6 text-sm text-ink-400">Make a graphic that belongs to no team or group: start a blank one on the left, or copy the shape of a team element and change it freely.</section>}
      </div>
    </StrokeGradientCtx.Provider>
  );
}
