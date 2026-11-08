import { MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Team } from '../api';
import { Button, cx, ErrorBox, fmtDateTime, Loading, useConfirm, useToast } from '../components/ui';
import { drawMatchboard, MbLayout, MbSlot, MbSlotState, MbState, MbTeam, MbText } from '../../../server/src/services/matchboard/draw';
import { Gradient, Raster } from '../../../server/src/services/generator/render';

interface MbStatus { file: string; vmixPath: string | null; exists: boolean; lastWriteAt: string | null; error: string | null }
interface FontInfo { sans: { source: 'uploaded' | 'system' | 'missing'; weights: number[] }; grotesk: boolean }
interface MbData { layout: MbLayout; state: MbState; status: MbStatus; fonts: FontInfo }
interface GenTemplate { id: string; name: string; fileName: string; variant: number; width: number; height: number; [k: string]: unknown }
interface GenData { templates: GenTemplate[]; teams: { teamId: string; gradients: Record<number, Gradient | null> }[]; strokeGradient: Gradient }

type Tab = 'titles' | 'qualifying' | 'final';

export function MatchboardTab() {
  const q = useQuery({ queryKey: ['matchboard'], queryFn: () => api.get<MbData>('/api/matchboard'), refetchOnWindowFocus: false });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api.get<Team[]>('/api/teams') });
  const gen = useQuery({ queryKey: ['generator'], queryFn: () => api.get<GenData>('/api/generator'), refetchOnWindowFocus: false });
  if (q.isLoading || teams.isLoading || gen.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  return <Editor data={q.data!} teams={teams.data ?? []} gen={gen.data ?? null} />;
}

/** Loads the board fonts into the page (General Sans weights uploaded in the panel, Space Grotesk bundled). */
function useBoardFonts(fonts: FontInfo) {
  const [ready, setReady] = useState(0);
  const key = fonts.sans.weights.join(',');
  useEffect(() => {
    const faces = [new FontFace('Space Grotesk', 'url(/api/matchboard/fonts/space-grotesk)', { weight: '700' }),
      ...fonts.sans.weights.map((w) => new FontFace('General Sans', `url(/api/matchboard/fonts/general-sans-${w}?v=${Date.now()})`, { weight: String(w) }))];
    let live = true;
    Promise.allSettled(faces.map((f) => f.load().then((ff) => document.fonts.add(ff)))).then(() => { if (live) setReady((n) => n + 1); });
    return () => { live = false; };
  }, [key]);
  return ready;
}

function useImage(src: string | null | undefined) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) { setImg(null); return; }
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = src;
  }, [src]);
  return img;
}

function Editor({ data, teams, gen }: { data: MbData; teams: Team[]; gen: GenData | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const [state, setState] = useState<MbState>(data.state);
  const [status, setStatus] = useState<MbStatus>(data.status);
  const [tab, setTab] = useState<Tab>(() => { try { return (localStorage.getItem('matchboard.tab') as Tab) || 'qualifying'; } catch { return 'qualifying'; } });
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  useEffect(() => setState(data.state), [data.state]);
  useEffect(() => setStatus(data.status), [data.status]);
  useEffect(() => { try { localStorage.setItem('matchboard.tab', tab); } catch { /* ignore */ } }, [tab]);

  // debounced save of what changed
  const pending = useRef<{ texts: Record<string, string>; slots: Record<string, MbSlotState>; highlightTemplateId?: string | null }>({ texts: {}, slots: {} });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = async () => {
    const body = pending.current;
    pending.current = { texts: {}, slots: {} };
    try { const r = await api.put<{ state: MbState; status: MbStatus }>('/api/matchboard', body); setStatus(r.status); qc.setQueryData(['matchboard'], (d: MbData | undefined) => d && { ...d, state: r.state, status: r.status }); }
    catch (e) { toast.error(e); qc.invalidateQueries({ queryKey: ['matchboard'] }); }
  };
  const queue = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { timer.current = null; void flush(); }, 500); };
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); void flush(); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const setText = (id: string, v: string) => { setState((s) => ({ ...s, texts: { ...s.texts, [id]: v } })); pending.current.texts[id] = v; queue(); };
  const setSlot = (id: string, v: MbSlotState) => { setState((s) => ({ ...s, slots: { ...s.slots, [id]: v } })); pending.current.slots[id] = v; queue(); };
  const setTemplate = (id: string | null) => { setState((s) => ({ ...s, highlightTemplateId: id })); pending.current.highlightTemplateId = id; queue(); };

  // export status follows the server
  useEffect(() => {
    const t = setInterval(() => { api.get<MbData>('/api/matchboard').then((d) => setStatus(d.status)).catch(() => {}); }, 4000);
    return () => clearInterval(t);
  }, []);

  const exportNow = async () => {
    setBusy('export');
    try { if (timer.current) { clearTimeout(timer.current); timer.current = null; await flush(); } setStatus(await api.post<MbStatus>('/api/matchboard/export')); toast.ok('Matchboard exported'); }
    catch (e) { toast.error(e); } finally { setBusy(''); }
  };
  const reset = async () => {
    if (!(await ask('Reset the matchboard?', <>Every text, team and highlight goes back to the MATCHBOARD-BROADCAST artwork.</>, 'Reset'))) return;
    try { const d = await api.post<MbData>('/api/matchboard/reset'); qc.setQueryData(['matchboard'], d); toast.ok('Matchboard reset'); } catch (e) { toast.error(e); }
  };
  const fontInput = useRef<HTMLInputElement>(null);
  const uploadFont = async (f: File) => {
    setBusy('font');
    try { await api.upload<FontInfo>('/api/matchboard/font', f); await qc.invalidateQueries({ queryKey: ['matchboard'] }); toast.ok('General Sans installed'); }
    catch (e) { toast.error(e); } finally { setBusy(''); }
  };

  const sortedTeams = useMemo(() => [...teams].sort((a, b) => a.code.localeCompare(b.code)), [teams]);
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const L = data.layout;
  const texts = new Map(L.texts.map((t) => [t.id, t]));
  const slots = new Map(L.slots.map((s) => [s.id, s]));
  const sections = L.sections.filter((s) => (tab === 'titles' ? s.kind === 'titles' : s.kind === tab));
  const highlightTpl = gen?.templates.find((t) => t.id === state.highlightTemplateId) ?? null;

  const pick = (id: string) => {
    const slot = slots.get(id);
    const text = texts.get(id);
    const section = L.sections.find((s) => s.id === (text?.section ?? L.groups.find((g) => g.slots.includes(slot?.id ?? ''))?.section));
    if (section) setTab(section.kind === 'titles' ? 'titles' : section.kind);
    setFocus(id);
    setTimeout(() => { const el = document.getElementById(`mb-${id}`); el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); el?.querySelector<HTMLElement>('input,select')?.focus(); }, 50);
  };

  return (
    <div className="space-y-3">
      <section className="card flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 text-sm">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink-200">Matchboard</h2>
        <span className="min-w-0 truncate font-mono text-xs text-ink-500" title={status.file}>{status.vmixPath ?? status.file}</span>
        <span className="text-xs text-ink-400">{status.error ? <span className="text-red-300">⚠ {status.error}</span> : status.lastWriteAt ? `Exported ${fmtDateTime(status.lastWriteAt)}` : status.exists ? 'Exported' : 'Not exported yet'}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-ink-400">
            Highlight
            <select className="input w-auto py-1 text-xs" value={state.highlightTemplateId ?? ''} onChange={(e) => setTemplate(e.target.value || null)} aria-label="PNG generator element used as highlight">
              <option value="">— none —</option>
              {(gen?.templates ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.width}×{t.height}, V{t.variant})</option>)}
            </select>
          </label>
          <Button size="sm" variant="ghost" onClick={reset}>Reset</Button>
          <a href="/api/matchboard/png" className="inline-flex items-center rounded-md border border-ink-700 bg-ink-800 px-2.5 py-1 text-xs font-medium text-ink-100 hover:bg-ink-700">Download PNG</a>
          <Button size="sm" variant="primary" busy={busy === 'export'} onClick={exportNow}>Export now</Button>
        </div>
      </section>

      <section className={cx('card flex flex-wrap items-center gap-3 px-3 py-2 text-xs', data.fonts.sans.source === 'missing' ? 'border-amber-800 bg-amber-950/30 text-amber-200' : 'text-ink-400')}>
        {data.fonts.sans.source === 'missing'
          ? <span><b>General Sans is not installed.</b> The board uses Space Grotesk until you upload it: the Fontshare zip (GeneralSans_Complete.zip) or GeneralSans-Medium.otf and -Semibold.otf. It stays on this computer only.</span>
          : data.fonts.sans.source === 'system'
            ? <span>General Sans: installed in the system.</span>
            : <span>General Sans: weights {data.fonts.sans.weights.join(', ')} uploaded.</span>}
        <Button size="sm" className="ml-auto" busy={busy === 'font'} onClick={() => fontInput.current?.click()}>{data.fonts.sans.source === 'uploaded' ? 'Replace font' : 'Upload font'}</Button>
        <input ref={fontInput} type="file" accept=".zip,.otf,.ttf,.woff,.woff2,.eot" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadFont(f); }} />
      </section>

      <Preview layout={L} state={state} teamById={teamById} gen={gen} fonts={data.fonts} onPick={pick} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-ink-700 text-sm">
          {([['titles', 'Titles'], ['qualifying', 'Qualifying Series'], ['final', 'Final Series']] as [Tab, string][]).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={cx('px-3 py-1.5', tab === k ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-100')}>{label}</button>
          ))}
        </div>
        <span className="text-xs text-ink-500">Click any field on the preview to jump to it. {highlightTpl ? `Highlights use “${highlightTpl.name}” from the Elements tab in the team's V${highlightTpl.variant} colours.` : 'Choose a highlight element above to show highlights.'}</span>
      </div>

      {tab === 'titles' ? (
        <section className="card grid gap-3 p-3 sm:grid-cols-3">
          {L.texts.filter((t) => t.section === 'titles').map((t) => <TextField key={t.id} t={t} value={state.texts[t.id] ?? ''} onChange={(v) => setText(t.id, v)} focus={focus === t.id} />)}
        </section>
      ) : sections.map((sec) => {
        const secTexts = L.texts.filter((t) => t.section === sec.id && !t.id.endsWith('-label'));
        const groups = L.groups.filter((g) => g.section === sec.id);
        return (
          <section key={sec.id} className="card p-3">
            <div className="mb-3 grid gap-3 sm:grid-cols-2">
              {secTexts.map((t) => <TextField key={t.id} t={t} value={state.texts[t.id] ?? ''} onChange={(v) => setText(t.id, v)} focus={focus === t.id} />)}
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
              {groups.map((g) => (
                <div key={g.id} className="rounded-lg border border-ink-800 bg-ink-950/40 p-2">
                  <div id={`mb-${g.labelId}`} className={cx('mb-2 rounded', focus === g.labelId && 'ring-2 ring-accent-400')}>
                    <input className="input py-1 text-center text-sm font-semibold" value={state.texts[g.labelId] ?? ''} onChange={(e) => setText(g.labelId, e.target.value)} aria-label="Box label" />
                  </div>
                  <ol className="space-y-1">
                    {g.slots.map((sid) => (
                      <SlotRow key={sid} slot={slots.get(sid)!} value={state.slots[sid]} teams={sortedTeams} teamById={teamById} focus={focus === sid}
                        canHighlight={!!highlightTpl} onChange={(v) => setSlot(sid, v)} />
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </section>
        );
      })}
      {dialog}
    </div>
  );
}

function TextField({ t, value, onChange, focus }: { t: MbText; value: string; onChange: (v: string) => void; focus: boolean }) {
  return (
    <label id={`mb-${t.id}`} className={cx('block rounded', focus && 'ring-2 ring-accent-400')}>
      <span className="label">{t.section === 'titles' ? t.label : t.label}</span>
      <input className="input" value={value} onChange={(e) => onChange(e.target.value)} maxLength={160} placeholder={t.text} />
    </label>
  );
}

function SlotRow({ slot, value, teams, teamById, focus, canHighlight, onChange }: {
  slot: MbSlot; value: MbSlotState | undefined; teams: Team[]; teamById: Map<string, Team>; focus: boolean; canHighlight: boolean; onChange: (v: MbSlotState) => void;
}) {
  const v = value ?? { teamId: null, text: slot.text, highlight: false };
  const team = v.teamId ? teamById.get(v.teamId) : null;
  const flag = team?.assets.flag_small?.previewUrl;
  return (
    <li id={`mb-${slot.id}`} className={cx('flex items-center gap-1 rounded', focus && 'ring-2 ring-accent-400', v.highlight && team && 'bg-accent-500/15')}>
      <span className="grid h-5 w-7 shrink-0 place-items-center overflow-hidden rounded-sm bg-ink-900">{flag ? <img src={flag} alt="" className="h-full w-full object-cover" /> : null}</span>
      <select className="input w-24 shrink-0 px-1 py-1 text-xs" value={v.teamId ?? ''} aria-label="Team or text"
        onChange={(e) => onChange({ ...v, teamId: e.target.value || null, text: e.target.value ? v.text : v.text || slot.text, highlight: e.target.value ? v.highlight : false })}>
        <option value="">Text</option>
        {teams.map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}
      </select>
      {team
        ? <span className="min-w-0 flex-1 truncate px-1 text-xs text-ink-300" title={team.name}>{team.name}</span>
        : <input className="input min-w-0 flex-1 py-1 text-xs" value={v.text} maxLength={40} placeholder="e.g. DRAW 1" onChange={(e) => onChange({ ...v, text: e.target.value })} aria-label="Row text" />}
      <button disabled={!team || !canHighlight} onClick={() => onChange({ ...v, highlight: !v.highlight })} aria-pressed={v.highlight}
        title={!team ? 'Pick a team to highlight it' : v.highlight ? 'Qualified: highlighted (click to turn off)' : 'Highlight as qualified'}
        className={cx('h-7 w-7 shrink-0 rounded text-sm disabled:opacity-25', v.highlight && team ? 'bg-amber-500/25 text-amber-300' : 'text-ink-500 hover:bg-ink-800 hover:text-ink-100')}>★</button>
    </li>
  );
}

function Preview({ layout, state, teamById, gen, fonts, onPick }: {
  layout: MbLayout; state: MbState; teamById: Map<string, Team>; gen: GenData | null; fonts: FontInfo; onPick: (id: string) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const fontsReady = useBoardFonts(fonts);
  const background = useImage('/api/matchboard/background.png');
  const cache = useRef(new Map<string, unknown>());
  const [flags, setFlags] = useState(new Map<string, HTMLImageElement>());

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // flags of the teams on the board
  const used = [...new Set(Object.values(state.slots).map((s) => s.teamId).filter(Boolean) as string[])];
  const flagKey = used.map((id) => teamById.get(id)?.assets.flag_small?.previewUrl ?? '').join('|');
  useEffect(() => {
    let live = true;
    Promise.all(used.map((id) => new Promise<[string, HTMLImageElement | null]>((res) => {
      const src = teamById.get(id)?.assets.flag_small?.previewUrl;
      if (!src) return res([id, null]);
      const i = new Image(); i.onload = () => res([id, i]); i.onerror = () => res([id, null]); i.src = src;
    }))).then((list) => { if (live) setFlags(new Map(list.filter((x): x is [string, HTMLImageElement] => !!x[1]))); });
    return () => { live = false; };
  }, [flagKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !width) return;
    const dpr = window.devicePixelRatio || 1;
    const k = (width * dpr) / layout.width;
    cv.width = Math.round(layout.width * k); cv.height = Math.round(layout.height * k);
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, layout.width, layout.height);
    const tpl = gen?.templates.find((t) => t.id === state.highlightTemplateId) ?? null;
    const grads = new Map((gen?.teams ?? []).map((t) => [t.teamId, t.gradients]));
    const teams = new Map<string, MbTeam>();
    for (const id of used) {
      const t = teamById.get(id);
      if (t) teams.set(id, { id, code: t.code, flag: flags.get(id) ?? null, gradient: tpl ? grads.get(id)?.[tpl.variant] ?? null : null });
    }
    drawMatchboard(ctx as any, {
      layout, state, teams, background, highlight: tpl as any, strokeGradient: gen?.strokeGradient ?? null, pixelRatio: k, cache: cache.current,
      toImage: (r: Raster) => { const o = document.createElement('canvas'); o.width = r.width; o.height = r.height; o.getContext('2d')!.putImageData(new ImageData(r.data, r.width, r.height), 0, 0); return o; },
    });
  });

  const click = (e: MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * layout.width, y = ((e.clientY - r.top) / r.height) * layout.height;
    const slot = layout.slots.find((s) => x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h);
    if (slot) return onPick(slot.id);
    const text = layout.texts.map((t) => {
      const w = (state.texts[t.id] ?? t.text).length * t.size * 0.6;
      const x0 = t.align === 'left' ? t.x : t.align === 'right' ? t.x - w : t.x - w / 2;
      return { t, hit: x >= x0 - 4 && x <= x0 + w + 4 && y >= t.baseline - t.size && y <= t.baseline + 4 };
    }).find((h) => h.hit);
    if (text) onPick(text.t.id);
  };

  return (
    <div ref={wrap} className="checker overflow-hidden rounded-lg border border-ink-800" data-fonts={fontsReady}>
      <canvas ref={canvasRef} onClick={click} className="block w-full cursor-pointer" style={{ aspectRatio: `${layout.width} / ${layout.height}` }} aria-label="Matchboard preview" />
    </div>
  );
}
