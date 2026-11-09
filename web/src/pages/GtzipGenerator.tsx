import { PointerEvent as RPointerEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Button, cx, Empty, ErrorBox, fmtBytes, fmtDateTime, Loading, Modal, useConfirm, useToast } from '../components/ui';
import {
  ANIMATION_TYPES, animationsOf, bitmap, brush, clone, DIRECTIONS, duplicate, elements, ElementInfo, fields, fmtNum, GtNode,
  INTERPOLATIONS, isVisible, nodeAt, pathKey, remove, renameElement, reorder, setBitmapSource, setSolid, setVec, size,
  sourceName, storyboardLength, storyboards, vec,
} from '../../../server/src/services/gtzip/model';
import { drawTitle, Img } from '../../../server/src/services/gtzip/draw';
import { RepeatGroup, repeatGroups } from '../../../server/src/services/gtzip/params';

interface TemplateMeta { id: string; name: string; originalFilename: string; uploadedAt: string; size: number; width: number; height: number; elements: number; fields: number; storyboards: number; scene?: string | null; variant?: string | null }
interface OutputInfo { name: string; file: string; size: number; createdAt: string; vmixPath: string | null; templateId: string | null }
interface SceneDef { id: string; name: string; group: string; variants: { id: string; label: string }[] }
interface GtzipState { templates: TemplateMeta[]; outputs: OutputInfo[]; outputsDir: string; scenes: SceneDef[] }

function sceneLabel(scenes: SceneDef[], t: { scene?: string | null; variant?: string | null }): string | null {
  const s = scenes.find((x) => x.id === t.scene);
  if (!s) return null;
  const v = s.variants.find((x) => x.id === t.variant);
  return v && s.variants.length > 1 ? `${s.name} · ${v.label}` : s.name;
}
interface TemplateDoc { meta: TemplateMeta; doc: GtNode; images: Record<string, { embedded: boolean; name: string }> }

const small = 'input px-2 py-1 text-xs';
const tiny = 'input px-1 py-1 text-xs';
const TAG_ICON: Record<string, string> = { Layer: '▣', TextBlock: 'T', Image: '🖼', Rectangle: '▭', Ellipse: '◯', Ticker: '⇢' };
const WEIGHTS = ['Normal', 'Medium', 'Bold'];

export function GtzipGeneratorPage() {
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ['gtzip'], queryFn: () => api.get<GtzipState>('/api/gtzip'), refetchOnWindowFocus: false });
  const selected = params.get('t');
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const st = q.data!;
  const tpl = st.templates.find((t) => t.id === selected) ?? null;
  return (
    <div className="flex flex-col gap-4 xl:flex-row">
      <aside className="w-full shrink-0 space-y-4 xl:w-64">
        <Templates state={st} selected={tpl?.id ?? null} onSelect={(id) => setParams(id ? { t: id } : {}, { replace: true })} />
        <Outputs state={st} onOpenTemplate={(id) => setParams({ t: id }, { replace: true })} />
      </aside>
      <section className="min-w-0 flex-1">
        {tpl ? <EditorLoader key={tpl.id} meta={tpl} scenes={st.scenes} onOpen={(id) => setParams({ t: id }, { replace: true })} />
          : <ScenesOverview state={st} onOpen={(id) => setParams({ t: id }, { replace: true })} />}
      </section>
    </div>
  );
}

// ---------- templates & outputs ----------
function Templates({ state, selected, onSelect }: { state: GtzipState; selected: string | null; onSelect: (id: string | null) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      let last: TemplateMeta | null = null, n = 0;
      const skipped: string[] = [];
      for (const f of Array.from(files)) {
        if (/\.zip$/i.test(f.name)) {
          const r = await api.upload<{ added: TemplateMeta[]; skipped: string[] }>('/api/gtzip/templates/pack', f);
          n += r.added.length; skipped.push(...r.skipped);
          if (r.added.length) last = r.added[r.added.length - 1];
        } else { last = await api.upload<TemplateMeta>('/api/gtzip/templates', f); n++; }
      }
      await qc.invalidateQueries({ queryKey: ['gtzip'] });
      if (last && n === 1) onSelect(last.id);
      toast.ok(`${n === 1 ? 'Template added' : `${n} templates added`}${skipped.length ? ` (not GT titles: ${skipped.join(', ')})` : ''}.`);
    } catch (e) { toast.error(e); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  const del = async (t: TemplateMeta) => {
    if (!(await ask('Remove template?', <>“{t.name}” is removed from the list. Files generated from it stay where they are.</>, 'Remove'))) return;
    try { await api.del(`/api/gtzip/templates/${t.id}`); if (selected === t.id) onSelect(null); qc.invalidateQueries({ queryKey: ['gtzip'] }); } catch (e) { toast.error(e); }
  };
  const rename = async (t: TemplateMeta) => {
    const name = window.prompt('Template name', t.name);
    if (!name || name === t.name) return;
    try { await api.patch(`/api/gtzip/templates/${t.id}`, { name }); qc.invalidateQueries({ queryKey: ['gtzip'] }); } catch (e) { toast.error(e); }
  };
  return (
    <div className="card p-3">
      {dialog}
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Templates {selected && <button className="ml-1 text-[11px] font-normal text-accent-300 hover:underline" onClick={() => onSelect(null)}>all scenes</button>}</h2>
        <Button size="sm" busy={busy} onClick={() => input.current?.click()} title="One or more .gtzip files, or a .zip with a whole set">+ Upload .gtzip / .zip</Button>
        <input ref={input} type="file" accept=".gtzip,.zip" multiple hidden onChange={(e) => upload(e.target.files)} />
      </div>
      {!state.templates.length && <p className="text-xs text-ink-500">No templates yet. Upload the .gtzip of a vMix scene, or a .zip with a whole set.</p>}
      <ul className="space-y-1">
        {state.templates.map((t) => (
          <li key={t.id} className={cx('group rounded-md border p-1.5', selected === t.id ? 'border-accent-500 bg-ink-800' : 'border-transparent hover:bg-ink-800/60')}>
            <button className="flex w-full items-center gap-2 text-left" onClick={() => onSelect(t.id)}>
              <img src={`/api/gtzip/templates/${t.id}/thumbnail`} alt="" className="h-9 w-16 shrink-0 rounded bg-ink-950 object-contain" onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-ink-100">{t.name}</span>
                <span className="block truncate text-[11px] text-ink-500">{sceneLabel(state.scenes, t) ?? 'no scene'} · {t.fields} fields</span>
              </span>
            </button>
            <div className="mt-1 hidden gap-1 group-hover:flex">
              <Button size="sm" variant="ghost" onClick={() => rename(t)}>Rename</Button>
              <a className="rounded-md px-2.5 py-1 text-xs text-ink-300 hover:bg-ink-800" href={`/api/gtzip/templates/${t.id}/file`}>Original</a>
              <Button size="sm" variant="ghost" onClick={() => del(t)}>Remove</Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Outputs({ state, onOpenTemplate }: { state: GtzipState; onOpenTemplate: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const asTemplate = async (o: OutputInfo) => {
    try {
      const t = await api.post<TemplateMeta>(`/api/gtzip/outputs/${encodeURIComponent(o.name)}/to-template`);
      await qc.invalidateQueries({ queryKey: ['gtzip'] });
      onOpenTemplate(t.id);
      toast.ok(`“${o.name}” is now also a template.`);
    } catch (e) { toast.error(e); }
  };
  return (
    <div className="card p-3">
      <h2 className="text-sm font-semibold">Generated files</h2>
      <p className="mb-2 break-all text-[11px] text-ink-500">{state.outputs[0]?.vmixPath ? state.outputs[0].vmixPath.replace(/[^\\/]+$/, '') : state.outputsDir}</p>
      {!state.outputs.length && <p className="text-xs text-ink-500">Nothing generated yet.</p>}
      <ul className="max-h-96 space-y-1 overflow-auto">
        {state.outputs.map((o) => (
          <li key={o.file} className="group rounded-md p-1.5 hover:bg-ink-800/60">
            <div className="truncate text-xs font-medium text-ink-100" title={o.vmixPath ?? o.file}>{o.file}</div>
            <div className="text-[11px] text-ink-500">{fmtDateTime(o.createdAt)} · {fmtBytes(o.size)}</div>
            <div className="mt-1 hidden flex-wrap gap-1 group-hover:flex">
              <a className="rounded-md px-2.5 py-1 text-xs text-ink-300 hover:bg-ink-800" href={`/api/gtzip/outputs/${encodeURIComponent(o.name)}`}>Download</a>
              {o.vmixPath && <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard?.writeText(o.vmixPath!); toast.ok('vMix path copied.'); }}>Copy path</Button>}
              <Button size="sm" variant="ghost" onClick={() => asTemplate(o)} title="Edit this file further (it stays as it is)">Use as template</Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- editor ----------
function EditorLoader({ meta, scenes, onOpen }: { meta: TemplateMeta; scenes: SceneDef[]; onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ['gtzip-template', meta.id], queryFn: () => api.get<TemplateDoc>(`/api/gtzip/templates/${meta.id}`), refetchOnWindowFocus: false, staleTime: Infinity });
  if (q.isLoading) return <Loading label="Opening the title…" />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  return <Editor tpl={{ ...q.data!, meta }} scenes={scenes} onOpen={onOpen} />;
}

const draftKey = (id: string) => `gtzip-draft:${id}`;
function readDraft(id: string): GtNode | null {
  try { const s = localStorage.getItem(draftKey(id)); return s ? JSON.parse(s) : null; } catch { return null; }
}

/** Undo/redo history; edits with the same key in a row (typing, dragging) are one step. */
function useHistory(initial: GtNode) {
  const [doc, setDoc] = useState(initial);
  const past = useRef<GtNode[]>([]);
  const future = useRef<GtNode[]>([]);
  const last = useRef<{ key: string; at: number } | null>(null);
  const [, bump] = useState(0);
  const commit = useCallback((next: GtNode, key?: string) => {
    setDoc((cur) => {
      const now = Date.now();
      const merge = key && last.current?.key === key && now - last.current.at < 1500;
      if (!merge) { past.current = [...past.current.slice(-99), cur]; future.current = []; }
      last.current = key ? { key, at: now } : null;
      return next;
    });
    bump((n) => n + 1);
  }, []);
  const undo = useCallback(() => setDoc((cur) => {
    const p = past.current.pop();
    if (!p) return cur;
    future.current.push(cur); last.current = null; return p;
  }), []);
  const redo = useCallback(() => setDoc((cur) => {
    const f = future.current.pop();
    if (!f) return cur;
    past.current.push(cur); last.current = null; return f;
  }), []);
  return { doc, commit, undo, redo, canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
}

function useTitleFonts() {
  const [ready, setReady] = useState(0);
  useEffect(() => {
    const faces = [new FontFace('Space Grotesk', 'url(/api/matchboard/fonts/space-grotesk)', { weight: '700' }),
      ...[400, 500, 600, 700].map((w) => new FontFace('General Sans', `url(/api/matchboard/fonts/general-sans-${w})`, { weight: String(w) }))];
    let live = true;
    Promise.allSettled(faces.map((f) => f.load().then((ff) => document.fonts.add(ff)))).then(() => { if (live) setReady((n) => n + 1); });
    return () => { live = false; };
  }, []);
  return ready;
}

/** Pictures for the preview, loaded once per Bitmap Source. */
function useImages(templateId: string) {
  const cache = useRef(new Map<string, Img | 'loading' | 'missing'>());
  const [version, setVersion] = useState(0);
  const get = useCallback((src: string): Img | null => {
    const c = cache.current.get(src);
    if (c === 'loading' || c === 'missing') return null;
    if (c) return c;
    cache.current.set(src, 'loading');
    const im = new Image();
    im.onload = () => { cache.current.set(src, { img: im, width: im.naturalWidth, height: im.naturalHeight }); setVersion((v) => v + 1); };
    im.onerror = () => { cache.current.set(src, 'missing'); setVersion((v) => v + 1); };
    im.src = imageUrl(templateId, src);
    return null;
  }, [templateId]);
  return { get, version };
}
const imageUrl = (templateId: string, src: string) => `/api/gtzip/image?template=${encodeURIComponent(templateId)}&src=${encodeURIComponent(src)}`;

type SideTab = 'layers' | 'animations' | 'fields';
type Mode = 'quick' | 'advanced';
const MODE_KEY = 'gtzip-mode';

function Editor({ tpl, scenes, onOpen }: { tpl: TemplateDoc; scenes: SceneDef[]; onOpen: (id: string) => void }) {
  const id = tpl.meta.id;
  const draft = useMemo(() => readDraft(id), [id]);
  const h = useHistory(draft ?? tpl.doc);
  const { doc, commit } = h;
  const [sel, setSel] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [bg, setBg] = useState<'checker' | 'dark' | 'light'>('dark');
  const [side, setSide] = useState<SideTab>('layers');
  const [dupOpen, setDupOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [mode, setModeState] = useState<Mode>(() => { try { return localStorage.getItem(MODE_KEY) === 'advanced' ? 'advanced' : 'quick'; } catch { return 'quick'; } });
  const setMode = (m: Mode) => { setModeState(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* storage unavailable */ } };
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const images = useImages(id);
  const fontsReady = useTitleFonts();

  // keep the working copy across reloads (this browser only)
  useEffect(() => {
    try {
      if (doc === tpl.doc) localStorage.removeItem(draftKey(id));
      else localStorage.setItem(draftKey(id), JSON.stringify(doc));
    } catch { /* storage unavailable */ }
  }, [doc, id, tpl.doc]);

  const els = useMemo(() => elements(doc), [doc]);
  const selInfos = useMemo(() => els.filter((e) => sel.includes(pathKey(e.path))), [els, sel]);
  const one = selInfos.length === 1 ? selInfos[0] : null;

  /** Applies a change to a copy of the document. */
  const mutate = (fn: (root: GtNode) => void, key?: string) => { const r = clone(doc); fn(r); commit(r, key); };
  const mutateSel = (fn: (n: GtNode, e: ElementInfo) => void, key?: string) =>
    mutate((r) => { for (const e of selInfos) { const n = nodeAt(r, e.path); if (n) fn(n, e); } }, key);

  // ---------- layers as PNG ----------
  const base = tpl.meta.name.replace(/\.gtzip$/i, '');
  // cropped to what is drawn by default; the full frame keeps the position on the 1920×1080 title
  const png = async (infos: ElementInfo[], crop = true) => {
    if (!infos.length) return;
    const label = infos.length === 1 ? (infos[0].node.attrs.Name || infos[0].node.tag) : `${infos.length} elements`;
    try { await savePng(doc, infos.map((e) => e.node), images.get, `${base} - ${label}${crop ? '' : ' (full frame)'}`, crop); }
    catch (e) { toast.error(e); }
  };
  const pngAll = async () => {
    const top = els.filter((e) => !e.parentPath);
    let saved = 0;
    for (const e of top) {
      try { await savePng(doc, [e.node], images.get, `${base} - ${e.node.attrs.Name || e.node.tag}`, true); saved++; } catch (err) { toast.error(err); }
      await new Promise((r) => setTimeout(r, 250)); // browsers drop downloads fired all at once
    }
    toast.ok(`${saved} PNG file${saved === 1 ? '' : 's'} saved (one per top-level layer, cropped).`);
  };

  const onDelete = async () => {
    if (!selInfos.length) return;
    const names = selInfos.map((e) => e.node.attrs.Name || e.node.tag).join(', ');
    if (!(await ask('Delete elements?', <>Deletes {names} with everything inside and their animations. Undo brings them back.</>, 'Delete'))) return;
    commit(remove(doc, selInfos.map((e) => e.path)));
    setSel([]);
  };
  const onReorder = (delta: number) => {
    if (!one) return;
    const r = reorder(doc, one.path, delta);
    commit(r.root);
    setSel([pathKey(r.path)]);
  };

  // keyboard: undo/redo, delete, nudge
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,select,[contenteditable]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) h.redo(); else h.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); h.redo(); return; }
      if (!selInfos.length) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onDelete(); return; }
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d) { e.preventDefault(); mutateSel((n) => { const [x, y] = vec(n.attrs.Location); setVec(n, 'Location', x + d[0], y + d[1]); }, 'nudge'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const reset = async () => {
    if (!(await ask('Back to the template?', 'All changes made here are dropped. Generated files are not affected.', 'Reset'))) return;
    commit(tpl.doc); setSel([]);
  };

  return (
    <div className="space-y-3">
      {dialog}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="truncate text-lg font-semibold">{tpl.meta.name}</h1>
        <SceneSelect scenes={scenes} meta={tpl.meta} />
        <span className="mr-auto" />
        <span className="flex rounded-md border border-ink-700 p-0.5 text-xs">
          {([['quick', 'Quick form'], ['advanced', 'Advanced editor']] as [Mode, string][]).map(([k, l]) => (
            <button key={k} onClick={() => setMode(k)} className={cx('rounded px-2 py-1', mode === k ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-100')}>{l}</button>
          ))}
        </span>
        <Button size="sm" onClick={() => setSaveOpen(true)} title="Keep this state as a template of its own, e.g. one variant of the scene">Save as template…</Button>
        <Button size="sm" onClick={h.undo} disabled={!h.canUndo} title="Ctrl+Z">↶ Undo</Button>
        <Button size="sm" onClick={h.redo} disabled={!h.canRedo} title="Ctrl+Shift+Z">↷ Redo</Button>
        <Button size="sm" variant="ghost" onClick={reset} disabled={doc === tpl.doc}>Reset to template</Button>
      </div>
      <GenerateBar tpl={tpl} doc={doc} />
      <div className="flex flex-col gap-3 2xl:flex-row">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-3 text-xs text-ink-400">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show hidden elements</label>
            <span className="flex items-center gap-1">Background
              {(['dark', 'checker', 'light'] as const).map((b) => <button key={b} onClick={() => setBg(b)} className={cx('rounded px-1.5 py-0.5', bg === b ? 'bg-ink-700 text-ink-50' : 'hover:bg-ink-800')}>{b}</button>)}
            </span>
            <span className="ml-auto">Click to select · Shift/Ctrl+click adds · drag moves · arrows nudge (Shift ×10)</span>
          </div>
          <Preview doc={doc} els={els} sel={sel} setSel={setSel} showHidden={showHidden} bg={bg} images={images.get} redraw={images.version + fontsReady}
            onMove={(dx, dy) => mutateSel((n) => { const [x, y] = vec(n.attrs.Location); setVec(n, 'Location', x + dx, y + dy); }, 'drag')} />
          <p className="text-[11px] text-ink-500">Preview is approximate (fonts, effects and text fitting may differ slightly in vMix). Dashed boxes are picture fields filled by vMix.</p>
        </div>
        {mode === 'quick' ? <div className="w-full shrink-0 2xl:w-[28rem]">
          <QuickForm tpl={tpl} doc={doc} commit={commit} images={images.get} sel={sel} setSel={setSel} />
        </div> : <div className="w-full shrink-0 space-y-3 2xl:w-[28rem]">
          <nav className="flex gap-1 border-b border-ink-800">
            {([['layers', 'Layers'], ['animations', 'Animations'], ['fields', 'vMix fields']] as [SideTab, string][]).map(([k, l]) => (
              <button key={k} onClick={() => setSide(k)} className={cx('-mb-px border-b-2 px-3 py-1.5 text-sm font-semibold', side === k ? 'border-accent-400 text-ink-50' : 'border-transparent text-ink-400 hover:text-ink-100')}>{l}</button>
            ))}
          </nav>
          {side === 'layers' && <>
            <div className="flex flex-wrap gap-1">
              <Button size="sm" disabled={!selInfos.length} onClick={() => setDupOpen(true)} title="Copies with renumbered names, offset and animations – e.g. one more sailor, race or bar">⧉ Duplicate…</Button>
              <Button size="sm" disabled={!selInfos.length} onClick={onDelete}>🗑 Delete</Button>
              <Button size="sm" disabled={!one} onClick={() => onReorder(-1)} title="Draw earlier (further back)">↓ Back</Button>
              <Button size="sm" disabled={!one} onClick={() => onReorder(1)} title="Draw later (more in front)">↑ Front</Button>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-ink-400">PNG:</span>
              <Button size="sm" disabled={!selInfos.length} onClick={() => png(selInfos)} title="The selected elements, cropped to what is drawn">⤓ Selected</Button>
              <Button size="sm" onClick={pngAll} title="Every top-level layer as its own PNG, cropped to what is drawn">⤓ Every layer</Button>
              <Button size="sm" variant="ghost" disabled={!selInfos.length} onClick={() => png(selInfos, false)} title="The selected elements on a transparent full-size frame (e.g. 1920×1080), in place, to lay over the title">⤓ Selected, full frame</Button>
            </div>
            <LayerTree els={els} sel={sel} setSel={setSel} onPng={(e) => png([e])} onToggle={(e) => mutate((r) => { const n = nodeAt(r, e.path)!; if (isVisible(n)) n.attrs.Visible = 'False'; else delete n.attrs.Visible; })} />
            {one ? <Properties key={pathKey(one.path)} info={one} doc={doc} tpl={tpl} images={images.get} mutate={mutate} commit={commit} />
              : selInfos.length > 1 ? <MultiProperties infos={selInfos} mutateSel={mutateSel} /> : null}
          </>}
          {side === 'animations' && <Animations doc={doc} mutate={mutate} selNames={selInfos.map((e) => e.node.attrs.Name).filter(Boolean)} />}
          {side === 'fields' && <Fields doc={doc} />}
        </div>}
      </div>
      {saveOpen && <SaveTemplateDialog scenes={scenes} tpl={tpl} doc={doc} onClose={() => setSaveOpen(false)} onSaved={(m) => { setSaveOpen(false); onOpen(m.id); }} />}
      {dupOpen && <DuplicateDialog infos={selInfos} els={els} doc={doc} onClose={() => setDupOpen(false)} onApply={(o) => {
        try {
          const r = duplicate(doc, selInfos.map((e) => e.path), o);
          commit(r.root);
          setSel(r.added.map(pathKey));
          setDupOpen(false);
          toast.ok(`${r.added.length} element${r.added.length === 1 ? '' : 's'} added.`);
        } catch (e) { toast.error(e); }
      }} />}
    </div>
  );
}

function GenerateBar({ tpl, doc }: { tpl: TemplateDoc; doc: GtNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggest, setSuggest] = useState<string | null>(null);
  // the template's name with the new count when the number of rows/teams/sailors changed (Day_schedule_4_races → …_3_races)
  const baseName = useMemo(() => {
    const before = repeatGroups(tpl.doc), after = repeatGroups(doc);
    let n = tpl.meta.name;
    for (const g of before) {
      const a = after.find((x) => x.id === g.id);
      if (!a || a.count === g.count) continue;
      const re = new RegExp(`(^|\\D)${g.count}(?!\\d)`);
      if (re.test(n)) n = n.replace(re, (_m, pre) => `${pre}${a.count}`);
    }
    return n;
  }, [tpl.doc, tpl.meta.name, doc]);
  useEffect(() => { api.get<{ name: string }>(`/api/gtzip/free-name?name=${encodeURIComponent(baseName)}`).then((r) => setName(r.name)).catch(() => setName(baseName)); }, [baseName]);
  const generate = async () => {
    setBusy(true); setSuggest(null);
    try {
      const out = await api.post<OutputInfo>('/api/gtzip/generate', { templateId: tpl.meta.id, fileName: name, doc });
      toast.ok(`Generated ${out.file}${out.vmixPath ? ` → ${out.vmixPath}` : ''}`);
      qc.invalidateQueries({ queryKey: ['gtzip'] });
      const next = await api.get<{ name: string }>(`/api/gtzip/free-name?name=${encodeURIComponent(name)}`).catch(() => null);
      if (next) setName(next.name);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setSuggest(e.details?.suggestion ?? null);
      toast.error(e);
    } finally { setBusy(false); }
  };
  return (
    <div className="card flex flex-wrap items-end gap-2 p-3">
      <label className="min-w-[16rem] flex-1">
        <span className="label">New file name</span>
        <div className="flex items-center gap-1">
          <input className="input" value={name} onChange={(e) => { setName(e.target.value); setSuggest(null); }} onKeyDown={(e) => { if (e.key === 'Enter') generate(); }} />
          <span className="text-sm text-ink-400">.gtzip</span>
        </div>
      </label>
      <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={generate}>Generate .gtzip</Button>
      {suggest && <p className="w-full text-xs text-amber-300">This name is taken. <button className="underline" onClick={() => { setName(suggest); setSuggest(null); }}>Use “{suggest}”</button></p>}
      <p className="w-full text-[11px] text-ink-500">Each click writes one new file. An existing file is never replaced, and the template stays unchanged.</p>
    </div>
  );
}

// ---------- quick form ----------
interface CountOptions { shiftAfter: boolean; stretch: boolean; center: boolean }
const COUNT_OPTS_KEY = 'gtzip-count-options-v2';
const textOf = (n: GtNode) => {
  if (n.tag !== 'Ticker' || n.attrs.Text != null) return n.attrs.Text ?? '';
  return n.children.find((c) => c.tag === 'Ticker.Template')?.children.find((c) => c.tag === 'TextBlock')?.attrs.Text ?? '';
};
function setTextOf(n: GtNode, v: string) {
  const t = n.tag === 'Ticker' && n.attrs.Text == null ? n.children.find((c) => c.tag === 'Ticker.Template')?.children.find((c) => c.tag === 'TextBlock') : n;
  if (t) t.attrs.Text = v.replace(/\r?\n/g, '\r\n');
}
/** What a person fills in: texts and pictures shown in the title (hidden previews and spares left out). */
function fillable(els: ElementInfo[], doc: GtNode) {
  const W = Number(doc.attrs.Width ?? 1920), H = Number(doc.attrs.Height ?? 1080);
  const byKey = new Map(els.map((e) => [pathKey(e.path), e]));
  const shown = (e: ElementInfo): boolean => isVisible(e.node) && (!e.parentPath || shown(byKey.get(pathKey(e.parentPath))!));
  return els.filter((e) => {
    if (!e.node.attrs.Name || !shown(e)) return false;
    if (e.node.tag === 'TextBlock' || e.node.tag === 'Ticker' || e.node.tag === 'Text3D') return true;
    if (e.node.tag !== 'Image') return false;
    const [w, h] = vec(e.node.attrs.Dimensions);
    return !(w >= 0.9 * W && h >= 0.9 * H); // a full-frame picture is the background or a preview
  });
}

/**
 * The simple way to make a new file from a template: how many rows / teams / sailors (the title's repeated parts,
 * found automatically), then the texts and pictures, part by part. The layer editor is the advanced mode.
 */
function QuickForm({ tpl, doc, commit, images, sel, setSel }: {
  tpl: TemplateDoc; doc: GtNode; commit: (r: GtNode, key?: string) => void; images: (src: string) => Img | null; sel: string[]; setSel: (s: string[]) => void;
}) {
  const toast = useToast();
  const groups = useMemo(() => repeatGroups(doc), [doc]);
  const els = useMemo(() => elements(doc), [doc]);
  const items = useMemo(() => fillable(els, doc), [els, doc]);
  const [opts, setOptsState] = useState<CountOptions>(() => {
    try { return { shiftAfter: true, stretch: true, center: true, ...JSON.parse(localStorage.getItem(COUNT_OPTS_KEY) ?? '{}') }; } catch { return { shiftAfter: true, stretch: true, center: true }; }
  });
  const setOpts = (o: CountOptions) => { setOptsState(o); try { localStorage.setItem(COUNT_OPTS_KEY, JSON.stringify(o)); } catch { /* storage unavailable */ } };
  const [busy, setBusy] = useState<string | null>(null);
  const [pick, setPick] = useState<ElementInfo | null>(null);

  const setCount = async (g: RepeatGroup, n: number) => {
    if (!Number.isFinite(n) || n < 1 || n === g.count || busy) return;
    setBusy(g.id);
    try {
      const r = await api.post<{ doc: GtNode }>('/api/gtzip/part-count', { template: tpl.meta.id, doc, group: g.id, count: Math.min(40, Math.floor(n)), options: opts });
      commit(r.doc);
      if (!g.step && n > g.count) toast.ok('Added. If it should sit somewhere else, move it in the advanced editor.');
    } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const edit = (e: ElementInfo, fn: (n: GtNode) => void, key: string) => { const r = clone(doc); fn(nodeAt(r, e.path)!); commit(r, key); };

  // the texts and pictures of each part, then the rest
  const owner = (e: ElementInfo) => {
    const k = pathKey(e.path);
    for (const g of groups) for (const m of g.members) if (m.paths.some((p) => k === pathKey(p) || k.startsWith(pathKey(p) + '/'))) return { g, m };
    return null;
  };
  const general = items.filter((e) => !owner(e));
  const selected = new Set(sel);

  const field = (e: ElementInfo) => {
    const k = pathKey(e.path);
    const n = e.node;
    const active = selected.has(k);
    if (n.tag === 'Image') {
      const src = bitmap(n)?.attrs.Source ?? '';
      return (
        <div key={k} className={cx('flex items-center gap-2 rounded px-1 py-0.5', active && 'bg-accent-500/15')} onClick={() => setSel([k])}>
          <span className="w-32 shrink-0 truncate text-[11px] text-ink-400" title={n.attrs.Name}>{n.attrs.Name}</span>
          <div className="checker flex h-8 w-14 shrink-0 items-center justify-center overflow-hidden rounded">
            {src && images(src) ? <img src={imageUrl(tpl.meta.id, src)} alt="" className="max-h-full max-w-full" /> : <span className="text-[9px] text-ink-700">vMix</span>}
          </div>
          <Button size="sm" variant="ghost" onClick={() => setPick(e)}>Replace…</Button>
        </div>
      );
    }
    return (
      <label key={k} className={cx('flex items-center gap-2 rounded px-1 py-0.5', active && 'bg-accent-500/15')} onFocus={() => setSel([k])}>
        <span className="w-32 shrink-0 truncate text-[11px] text-ink-400" title={n.attrs.Name}>{n.attrs.Name}</span>
        <input className={small} value={textOf(n).replace(/\r\n/g, ' ⏎ ')} onChange={(ev) => edit(e, (x) => setTextOf(x, ev.target.value.replace(/ ⏎ /g, '\n')), `${k}:text`)} />
      </label>
    );
  };

  return (
    <div className="space-y-3">
      <div className="card space-y-2 p-3">
        <h2 className="text-sm font-semibold">How many</h2>
        {!groups.length && <p className="text-xs text-ink-500">No repeated parts (rows, teams, sailors…) found in this title.</p>}
        {groups.map((g) => (
          <div key={g.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-ink-200" title={g.members.map((m) => m.label).join(', ')}>{g.label}</span>
            <Button size="sm" variant="ghost" disabled={!!busy || g.count <= 1} onClick={() => setCount(g, g.count - 1)}>−</Button>
            <CountInput value={g.count} disabled={!!busy} onCommit={(n) => setCount(g, n)} />
            <Button size="sm" variant="ghost" disabled={!!busy || g.count >= 40} onClick={() => setCount(g, g.count + 1)}>+</Button>
            {busy === g.id && <span className="text-[11px] text-ink-500">…</span>}
          </div>
        ))}
        {groups.length > 0 && <div className="flex flex-wrap gap-3 border-t border-ink-800 pt-2 text-[11px] text-ink-400">
          <label className="flex items-center gap-1.5" title="E.g. the sponsor bar under the rows goes down when a row is added"><input type="checkbox" checked={opts.shiftAfter} onChange={(e) => setOpts({ ...opts, shiftAfter: e.target.checked })} /> Move what comes after</label>
          <label className="flex items-center gap-1.5" title="The panel behind the rows grows or shrinks with them"><input type="checkbox" checked={opts.stretch} onChange={(e) => setOpts({ ...opts, stretch: e.target.checked })} /> Resize the background</label>
          <label className="flex items-center gap-1.5" title="When the graphic sits in the middle of the screen, everything moves by half the change, so it stays centred"><input type="checkbox" checked={opts.center} onChange={(e) => setOpts({ ...opts, center: e.target.checked })} /> Keep centred</label>
        </div>}
      </div>

      <AddFieldCard tpl={tpl} doc={doc} groups={groups} commit={commit} />

      <div className="card space-y-1 p-3">
        <h2 className="text-sm font-semibold">Texts and pictures</h2>
        {general.map(field)}
        {groups.map((g) => g.members.slice(0, g.count).map((m) => {
          const mine = items.filter((e) => owner(e)?.m === m);
          if (!mine.length) return null;
          const open = mine.some((e) => selected.has(pathKey(e.path)));
          return (
            <details key={`${g.id}:${m.label}`} open={open || undefined} className="rounded border border-ink-800 px-1.5 py-1">
              <summary className="cursor-pointer text-xs font-semibold text-ink-300">{m.label}</summary>
              <div className="mt-1 space-y-1">{mine.map(field)}</div>
            </details>
          );
        }))}
        {!items.length && <p className="text-xs text-ink-500">No texts or pictures to fill in.</p>}
      </div>
      {pick && <PicturePicker onClose={() => setPick(null)} onPick={(s) => { edit(pick, (x) => setBitmapSource(x, s), 'pic'); setPick(null); }} />}
    </div>
  );
}

/** A field the template lacks (a race status in each row…), added in the style of the graphic. */
function AddFieldCard({ tpl, doc, groups, commit }: { tpl: TemplateDoc; doc: GtNode; groups: RepeatGroup[]; commit: (r: GtNode, key?: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [sample, setSample] = useState('');
  const [where, setWhere] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const target = where === '' ? (groups[0]?.id ?? '-') : where;
  const add = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ doc: GtNode; added: string[] }>('/api/gtzip/add-field', { template: tpl.meta.id, doc, name: name.trim(), sample, group: target === '-' ? null : target });
      commit(r.doc);
      toast.ok(`Added ${r.added.length > 1 ? `${r.added[0]} … ${r.added[r.added.length - 1]}` : r.added[0]}`);
      setName(''); setSample('');
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <div className="card space-y-2 p-3">
      <h2 className="text-sm font-semibold">Add a data field</h2>
      <p className="text-[11px] text-ink-500">For data the template has no place for, e.g. a status in each schedule row. It takes the look of the texts next to it; when there is no free space the graphic grows to make room.</p>
      <div className="flex flex-wrap items-center gap-2">
        <input className={cx(small, 'w-28')} placeholder="Name, e.g. STATUS" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={cx(small, 'w-36')} placeholder="Sample text, e.g. LIVE" value={sample} onChange={(e) => setSample(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <select className={small} value={target} onChange={(e) => setWhere(e.target.value)}>
          {groups.map((g) => <option key={g.id} value={g.id}>In each of {g.label}</option>)}
          <option value="-">Once on the graphic</option>
        </select>
        <Button size="sm" disabled={!name.trim() || busy} onClick={add}>{busy ? 'Adding…' : 'Add'}</Button>
      </div>
    </div>
  );
}

function CountInput({ value, disabled, onCommit }: { value: number; disabled: boolean; onCommit: (n: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const done = () => { const n = Number(v); if (n !== value) onCommit(n); };
  return <input className={cx(small, 'w-14 text-center')} type="number" min={1} max={40} value={v} disabled={disabled}
    onChange={(e) => setV(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === 'Enter') done(); }} />;
}

// ---------- preview ----------
function absBox(e: ElementInfo, doc: GtNode, els: ElementInfo[]): [number, number, number, number] {
  const [x, y] = vec(e.node.attrs.Location);
  let fallback: [number, number] = [Number(doc.attrs.Width ?? 1920), Number(doc.attrs.Height ?? 1080)];
  if (e.parentPath) { const p = els.find((x) => pathKey(x.path) === pathKey(e.parentPath!)); if (p) fallback = size(p.node, fallback); }
  const [w, h] = size(e.node, fallback);
  return [e.origin[0] + x, e.origin[1] + y, w, h];
}

function Preview({ doc, els, sel, setSel, showHidden, bg, images, redraw, onMove }: {
  doc: GtNode; els: ElementInfo[]; sel: string[]; setSel: (s: string[]) => void; showHidden: boolean; bg: string;
  images: (src: string) => Img | null; redraw: number; onMove: (dx: number, dy: number) => void;
}) {
  const W = Number(doc.attrs.Width ?? 1920), H = Number(doc.attrs.Height ?? 1080);
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [cw, setCw] = useState(960);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setCw(Math.max(320, Math.floor(e.contentRect.width))));
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  const scale = cw / W;
  const hiddenUnder = useCallback((e: ElementInfo) => {
    if (!isVisible(e.node)) return true;
    let p = e.parentPath;
    while (p) { const pk = pathKey(p); const pe = els.find((x) => pathKey(x.path) === pk); if (!pe) break; if (!isVisible(pe.node)) return true; p = pe.parentPath; }
    return false;
  }, [els]);
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(cw * dpr); c.height = Math.round(H * scale * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawTitle(ctx, doc, { image: images, showHidden, placeholders: true, fallbackFont: 'Space Grotesk' });
    ctx.lineWidth = 2 / scale;
    for (const e of els) {
      if (!sel.includes(pathKey(e.path))) continue;
      const [x, y, w, h] = absBox(e, doc, els);
      ctx.strokeStyle = '#38bdf8'; ctx.setLineDash([]);
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = 'rgba(56,189,248,0.08)'; ctx.fillRect(x, y, w, h);
    }
  }, [doc, els, sel, showHidden, cw, scale, H, W, images, redraw]);

  const pick = (ev: RPointerEvent<HTMLCanvasElement>): ElementInfo | null => {
    const r = cv.current!.getBoundingClientRect();
    const px = (ev.clientX - r.left) / scale, py = (ev.clientY - r.top) / scale;
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.node.tag === 'Layer' && !ev.altKey) continue; // Alt+click picks layers
      if (!showHidden && hiddenUnder(e)) continue;
      const [x, y, w, h] = absBox(e, doc, els);
      if (px >= x && px <= x + w && py >= y && py <= y + h) return e;
    }
    return null;
  };
  return (
    <div ref={wrap} className={cx('overflow-hidden rounded-lg border border-ink-800', bg === 'checker' ? 'checker' : bg === 'light' ? 'bg-preview-light' : 'bg-preview-dark')}>
      <canvas ref={cv} style={{ width: cw, height: H * scale, display: 'block', cursor: 'default', touchAction: 'none' }}
        onPointerDown={(ev) => {
          const e = pick(ev);
          const k = e ? pathKey(e.path) : null;
          if (ev.shiftKey || ev.ctrlKey || ev.metaKey) { if (k) setSel(sel.includes(k) ? sel.filter((x) => x !== k) : [...sel, k]); return; }
          if (!k) { setSel([]); return; }
          if (!sel.includes(k)) setSel([k]);
          drag.current = { x: ev.clientX, y: ev.clientY, moved: false };
          (ev.target as HTMLCanvasElement).setPointerCapture(ev.pointerId);
        }}
        onPointerMove={(ev) => {
          const d = drag.current;
          if (!d) return;
          const dx = Math.round((ev.clientX - d.x) / scale), dy = Math.round((ev.clientY - d.y) / scale);
          if (!dx && !dy) return;
          if (!d.moved && Math.abs(ev.clientX - d.x) + Math.abs(ev.clientY - d.y) < 4) return;
          d.moved = true;
          onMove(dx, dy);
          d.x += dx * scale; d.y += dy * scale;
        }}
        onPointerUp={() => { drag.current = null; }} />
    </div>
  );
}

// ---------- layer tree ----------
/**
 * Saves elements as a transparent PNG cropped to what is drawn (default), or on the whole 1920×1080 frame
 * (keeps the position, ready to lay over the title).
 */
async function savePng(doc: GtNode, nodes: GtNode[], images: (src: string) => Img | null, fileName: string, crop: boolean) {
  const W = Number(doc.attrs.Width ?? 1920), H = Number(doc.attrs.Height ?? 1080);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  drawTitle(ctx, doc, { image: images, only: nodes, fallbackFont: 'Space Grotesk' });
  let out = c;
  if (crop) {
    const d = ctx.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) throw new Error('Nothing is drawn in this layer (an empty picture field or only data-source text).');
    out = document.createElement('canvas');
    out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext('2d')!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  }
  const blob = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/png'));
  if (!blob) throw new Error('The browser could not make the PNG.');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${fileName.replace(/[\\/:*?"<>|]+/g, '_')}.png`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function LayerTree({ els, sel, setSel, onToggle, onPng }: { els: ElementInfo[]; sel: string[]; setSel: (s: string[]) => void; onToggle: (e: ElementInfo) => void; onPng: (e: ElementInfo) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const lastClick = useRef<string | null>(null);
  // GT lists the top-most element first
  const rows = useMemo(() => {
    const out: ElementInfo[] = [];
    const kids = (parent: string | null) => els.filter((e) => (e.parentPath ? pathKey(e.parentPath) : null) === parent).reverse();
    const walk = (parent: string | null, hiddenParent: boolean) => {
      for (const e of kids(parent)) {
        if (!hiddenParent) out.push(e);
        walk(pathKey(e.path), hiddenParent || collapsed.has(e.node.attrs.Name ?? pathKey(e.path)));
      }
    };
    walk(null, false);
    const f = filter.trim().toLowerCase();
    return f ? els.filter((e) => (e.node.attrs.Name ?? '').toLowerCase().includes(f)) : out;
  }, [els, collapsed, filter]);
  const click = (ev: React.MouseEvent, k: string) => {
    if (ev.shiftKey && lastClick.current) {
      const a = rows.findIndex((r) => pathKey(r.path) === lastClick.current), b = rows.findIndex((r) => pathKey(r.path) === k);
      if (a >= 0 && b >= 0) { const range = rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => pathKey(r.path)); setSel([...new Set([...sel, ...range])]); return; }
    }
    if (ev.ctrlKey || ev.metaKey) setSel(sel.includes(k) ? sel.filter((x) => x !== k) : [...sel, k]);
    else setSel([k]);
    lastClick.current = k;
  };
  return (
    <div className="card overflow-hidden">
      <input className="w-full border-b border-ink-800 bg-transparent px-3 py-1.5 text-xs outline-none placeholder:text-ink-500" placeholder="Filter by name…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ul className="max-h-[22rem] overflow-auto py-1 text-xs">
        {rows.map((e) => {
          const k = pathKey(e.path), name = e.node.attrs.Name ?? `(${e.node.tag})`, key = e.node.attrs.Name ?? k;
          const isLayer = e.node.tag === 'Layer';
          return (
            <li key={k} className={cx('flex items-center gap-1 pr-2', sel.includes(k) ? 'bg-accent-600/30 text-ink-50' : 'hover:bg-ink-800')} style={{ paddingLeft: 6 + (filter ? 0 : e.depth * 14) }}>
              <button className="w-4 text-ink-500" onClick={() => isLayer && setCollapsed((c) => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n; })}>
                {isLayer ? (collapsed.has(key) ? '▸' : '▾') : ''}
              </button>
              <span className="w-4 text-center text-ink-400">{TAG_ICON[e.node.tag] ?? '•'}</span>
              <button className={cx('min-w-0 flex-1 truncate py-1 text-left', !isVisible(e.node) && 'text-ink-500 line-through decoration-ink-600')} onClick={(ev) => click(ev, k)}>{name}</button>
              <button className="px-1 text-ink-500 hover:text-ink-100" title="Download as PNG (transparent, cropped to what is drawn)" onClick={() => onPng(e)}>⤓</button>
              <button className={cx('px-1', isVisible(e.node) ? 'text-ink-300' : 'text-ink-600')} title={isVisible(e.node) ? 'Visible – click to hide' : 'Hidden – click to show'} onClick={() => onToggle(e)}>{isVisible(e.node) ? '👁' : '◌'}</button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------- properties ----------
function Num({ label, value, onChange, step = 1, k }: { label: string; value: number; onChange: (v: number, key: string) => void; step?: number; k: string }) {
  const [v, setV] = useState(fmtNum(value));
  useEffect(() => setV(fmtNum(value)), [value]);
  return (
    <label className="block">
      <span className="text-[11px] text-ink-500">{label}</span>
      <input className={small} type="number" step={step} value={v} onChange={(e) => { setV(e.target.value); const n = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(n)) onChange(n, k); }} />
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <div className="space-y-2 border-t border-ink-800 pt-2"><div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">{title}</div>{children}</div>;
}

function colorParts(c: string | undefined): { hex: string; alpha: number } {
  const h = (c ?? '#FFFFFFFF').replace('#', '');
  if (h.length === 8) return { hex: '#' + h.slice(2), alpha: parseInt(h.slice(0, 2), 16) / 255 };
  return { hex: '#' + h.slice(0, 6), alpha: 1 };
}

function ColorRow({ label, node, part, mutateNode }: { label: string; node: GtNode; part: 'Fill' | 'Stroke'; mutateNode: (fn: (n: GtNode) => void, key?: string) => void }) {
  const b = brush(node, part);
  if (b?.attrs.Type) return <p className="text-[11px] text-ink-500">{label}: gradient (edit in GT Title Designer or replace with a solid colour) <button className="underline" onClick={() => mutateNode((n) => setSolid(n, part, '#FFFFFF'))}>make solid</button></p>;
  const { hex, alpha } = colorParts(b?.attrs.Color);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-12 text-ink-400">{label}</span>
      <input type="color" value={hex.slice(0, 7)} onChange={(e) => mutateNode((n) => setSolid(n, part, e.target.value, alpha), `${part}-color`)} className="h-7 w-10 rounded border border-ink-700 bg-ink-900" />
      <input className={cx(small, 'w-24')} value={hex.toUpperCase()} onChange={(e) => /^#[0-9a-fA-F]{6}$/.test(e.target.value) && mutateNode((n) => setSolid(n, part, e.target.value, alpha), `${part}-hex`)} />
      <span className="text-ink-500">opacity</span>
      <input className={cx(small, 'w-16')} type="number" min={0} max={100} value={Math.round(alpha * 100)} onChange={(e) => mutateNode((n) => setSolid(n, part, hex, Number(e.target.value) / 100), `${part}-alpha`)} />
    </div>
  );
}

function Properties({ info, doc, tpl, images, mutate, commit }: {
  info: ElementInfo; doc: GtNode; tpl: TemplateDoc; images: (src: string) => Img | null;
  mutate: (fn: (r: GtNode) => void, key?: string) => void; commit: (r: GtNode, key?: string) => void;
}) {
  const n = info.node;
  const toast = useToast();
  const [name, setName] = useState(n.attrs.Name ?? '');
  const [pick, setPick] = useState(false);
  const mutateNode = (fn: (x: GtNode) => void, key?: string) => mutate((r) => fn(nodeAt(r, info.path)!), key && `${pathKey(info.path)}:${key}`);
  const setAttr = (k: string, v: string | null, key?: string) => mutateNode((x) => { if (v == null || v === '') delete x.attrs[k]; else x.attrs[k] = v; }, key ?? k);
  const [x, y] = vec(n.attrs.Location);
  const [w, h] = vec(n.attrs.Dimensions);
  const rename = () => {
    if (!name || name === n.attrs.Name) return;
    try { const r = clone(doc); renameElement(r, n.attrs.Name!, name); commit(r); } catch (e) { toast.error(e); setName(n.attrs.Name ?? ''); }
  };
  const bmp = bitmap(n);
  const src = bmp?.attrs.Source ?? '';
  const isText = n.tag === 'TextBlock' || n.tag === 'Ticker' || n.tag === 'Text3D';
  return (
    <div className="card space-y-2 p-3">
      <div className="flex items-center gap-2">
        <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[11px] text-ink-400">{n.tag}</span>
        {n.attrs.Name != null
          ? <input className={small} value={name} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => { if (e.key === 'Enter') rename(); }} title="Name = vMix field name; animations follow a rename" />
          : <span className="text-xs text-ink-500">no name</span>}
      </div>
      <div className="grid grid-cols-4 gap-2">
        <Num label="X" value={x} k="x" onChange={(v, k) => mutateNode((nn) => setVec(nn, 'Location', v, vec(nn.attrs.Location)[1]), k)} />
        <Num label="Y" value={y} k="y" onChange={(v, k) => mutateNode((nn) => setVec(nn, 'Location', vec(nn.attrs.Location)[0], v), k)} />
        <Num label="Width" value={w} k="w" onChange={(v, k) => mutateNode((nn) => setVec(nn, 'Dimensions', v, vec(nn.attrs.Dimensions)[1]), k)} />
        <Num label="Height" value={h} k="h" onChange={(v, k) => mutateNode((nn) => setVec(nn, 'Dimensions', vec(nn.attrs.Dimensions)[0], v), k)} />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={isVisible(n)} onChange={(e) => setAttr('Visible', e.target.checked ? null : 'False')} /> Visible</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={n.attrs.Locked === 'True'} onChange={(e) => setAttr('Locked', e.target.checked ? 'True' : null)} /> Locked in GT</label>
        <label className="flex items-center gap-1.5">Opacity
          <input className={cx(small, 'w-16')} type="number" min={0} max={100} value={Math.round(Number(n.attrs.Opacity ?? 1) * 100)}
            onChange={(e) => setAttr('Opacity', Number(e.target.value) >= 100 ? null : fmtNum(Number(e.target.value) / 100))} />%
        </label>
      </div>

      {isText && <Section title="Text">
        <textarea className={cx(small, 'min-h-[3.5rem]')} value={(n.attrs.Text ?? '').replace(/\r\n/g, '\n')} onChange={(e) => setAttr('Text', e.target.value.replace(/\r?\n/g, '\r\n') || null, 'Text')} />
        <div className="grid grid-cols-3 gap-2">
          <label><span className="text-[11px] text-ink-500">Font</span><input className={small} value={n.attrs.FontFamily ?? ''} onChange={(e) => setAttr('FontFamily', e.target.value, 'FontFamily')} /></label>
          <Num label="Size" value={Number(n.attrs.FontSize ?? 24)} k="FontSize" onChange={(v) => setAttr('FontSize', fmtNum(v), 'FontSize')} />
          <label><span className="text-[11px] text-ink-500">Weight</span>
            <select className={small} value={n.attrs.FontWeight ?? 'Normal'} onChange={(e) => setAttr('FontWeight', e.target.value === 'Normal' ? null : e.target.value)}>
              {[...new Set([...WEIGHTS, n.attrs.FontWeight ?? 'Normal'])].map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          <label><span className="text-[11px] text-ink-500">Align</span>
            <select className={small} value={n.attrs.TextAlign ?? 'Left'} onChange={(e) => setAttr('TextAlign', e.target.value === 'Left' ? null : e.target.value)}>
              {['Left', 'Center', 'Right'].map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          <label><span className="text-[11px] text-ink-500">Vertical</span>
            <select className={small} value={n.attrs.VerticalAlign ?? 'Top'} onChange={(e) => setAttr('VerticalAlign', e.target.value === 'Top' ? null : e.target.value)}>
              {['Top', 'Center', 'Bottom'].map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
        </div>
        <ColorRow label="Colour" node={n} part="Fill" mutateNode={mutateNode} />
      </Section>}

      {n.tag === 'Image' && <Section title="Picture">
        <div className="flex items-center gap-2">
          <div className="checker flex h-14 w-24 shrink-0 items-center justify-center overflow-hidden rounded">
            {src && images(src) ? <img src={imageUrl(tpl.meta.id, src)} alt="" className="max-h-full max-w-full" /> : <span className="text-[10px] text-ink-700">vMix field</span>}
          </div>
          <div className="min-w-0 text-xs">
            <div className="truncate text-ink-200" title={src}>{src ? sourceName(src.replace(/^(upload|asset):/, '')) : '—'}</div>
            <div className="text-[11px] text-ink-500">{src.startsWith('upload:') || src.startsWith('asset:') ? 'new picture, embedded on Generate' : tpl.images[src]?.embedded ? 'embedded in the template' : 'not embedded (filled by vMix)'}</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" onClick={() => setPick(true)}>Replace picture…</Button>
          <select className={cx(small, 'w-auto')} value={n.attrs.SizeMode ?? 'Uniform'} onChange={(e) => setAttr('SizeMode', e.target.value === 'Uniform' ? null : e.target.value)} title="How the picture fills the box">
            {['Uniform', 'Stretch', 'UniformToFill', 'None'].map((x) => <option key={x}>{x}</option>)}
          </select>
        </div>
        {pick && <PicturePicker onClose={() => setPick(false)} onPick={(s) => { mutateNode((x) => setBitmapSource(x, s)); setPick(false); }} />}
      </Section>}

      {(n.tag === 'Rectangle' || n.tag === 'Ellipse') && <Section title="Shape">
        <ColorRow label="Fill" node={n} part="Fill" mutateNode={mutateNode} />
        <div className="grid grid-cols-3 gap-2">
          <Num label="Radius" value={vec(n.attrs.Radius)[0]} k="Radius" onChange={(v) => setAttr('Radius', `${fmtNum(v)},${fmtNum(v)}`, 'Radius')} />
          <Num label="Stroke" value={Number(n.attrs.StrokeThickness ?? 0)} k="StrokeThickness" onChange={(v) => setAttr('StrokeThickness', v ? fmtNum(v) : null, 'StrokeThickness')} />
        </div>
        {Number(n.attrs.StrokeThickness ?? 0) > 0 && <ColorRow label="Stroke" node={n} part="Stroke" mutateNode={mutateNode} />}
      </Section>}

      <details className="border-t border-ink-800 pt-2">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-ink-500">All attributes</summary>
        <AttrTable node={n} setAttr={setAttr} />
      </details>
    </div>
  );
}

function AttrTable({ node, setAttr }: { node: GtNode; setAttr: (k: string, v: string | null, key?: string) => void }) {
  const [nk, setNk] = useState(''); const [nv, setNv] = useState('');
  return (
    <div className="mt-2 space-y-1">
      {Object.entries(node.attrs).filter(([k]) => k !== 'Name').map(([k, v]) => (
        <div key={k} className="flex items-center gap-1">
          <span className="w-28 shrink-0 truncate text-[11px] text-ink-400" title={k}>{k}</span>
          <input className={small} value={v} onChange={(e) => setAttr(k, e.target.value, `attr-${k}`)} />
          <button className="px-1 text-ink-500 hover:text-red-300" title="Remove attribute" onClick={() => setAttr(k, null)}>✕</button>
        </div>
      ))}
      <div className="flex items-center gap-1 pt-1">
        <input className={cx(small, 'w-28')} placeholder="Attribute" value={nk} onChange={(e) => setNk(e.target.value)} />
        <input className={small} placeholder="Value" value={nv} onChange={(e) => setNv(e.target.value)} />
        <Button size="sm" disabled={!/^[A-Za-z][\w.]*$/.test(nk)} onClick={() => { setAttr(nk, nv); setNk(''); setNv(''); }}>Add</Button>
      </div>
    </div>
  );
}

function MultiProperties({ infos, mutateSel }: { infos: ElementInfo[]; mutateSel: (fn: (n: GtNode, e: ElementInfo) => void, key?: string) => void }) {
  const [dx, setDx] = useState('0'); const [dy, setDy] = useState('0');
  const [w, setW] = useState(''); const [h, setH] = useState('');
  return (
    <div className="card space-y-2 p-3 text-xs">
      <div className="font-semibold text-ink-200">{infos.length} elements selected</div>
      <div className="flex items-end gap-2">
        <label>Move X<input className={small} type="number" value={dx} onChange={(e) => setDx(e.target.value)} /></label>
        <label>Move Y<input className={small} type="number" value={dy} onChange={(e) => setDy(e.target.value)} /></label>
        <Button size="sm" onClick={() => mutateSel((n) => { const [x, y] = vec(n.attrs.Location); setVec(n, 'Location', x + Number(dx || 0), y + Number(dy || 0)); })}>Move</Button>
      </div>
      <div className="flex items-end gap-2">
        <label>Width<input className={small} type="number" placeholder="keep" value={w} onChange={(e) => setW(e.target.value)} /></label>
        <label>Height<input className={small} type="number" placeholder="keep" value={h} onChange={(e) => setH(e.target.value)} /></label>
        <Button size="sm" disabled={!w && !h} onClick={() => mutateSel((n) => { const [cw, ch] = vec(n.attrs.Dimensions); setVec(n, 'Dimensions', w ? Number(w) : cw, h ? Number(h) : ch); })}>Set size</Button>
      </div>
      <div className="flex gap-1">
        <Button size="sm" onClick={() => mutateSel((n) => { delete n.attrs.Visible; })}>Show all</Button>
        <Button size="sm" onClick={() => mutateSel((n) => { n.attrs.Visible = 'False'; })}>Hide all</Button>
      </div>
    </div>
  );
}

function PicturePicker({ onClose, onPick }: { onClose: () => void; onPick: (source: string) => void }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ['gtzip-assets'], queryFn: () => api.get<{ source: string; rel: string; size: number }[]>('/api/gtzip/asset-images') });
  const [f, setF] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = (q.data ?? []).filter((a) => a.rel.toLowerCase().includes(f.toLowerCase())).slice(0, 300);
  return (
    <Modal open onClose={onClose} title="Replace picture" wide>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button busy={busy} onClick={() => input.current?.click()}>Upload PNG / JPG…</Button>
          <input ref={input} type="file" accept="image/png,image/jpeg" hidden onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true);
            try { onPick((await api.upload<{ source: string }>('/api/gtzip/images', file)).source); } catch (err) { toast.error(err); } finally { setBusy(false); }
          }} />
          <span className="text-xs text-ink-500">or pick a file from the dashboard (PNG generator, team graphics…)</span>
          <input className={cx(small, 'ml-auto w-56')} placeholder="Search, e.g. POL or PNG generator/" value={f} onChange={(e) => setF(e.target.value)} />
        </div>
        {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
          <div className="grid max-h-[60vh] grid-cols-2 gap-2 overflow-auto sm:grid-cols-4">
            {list.map((a) => (
              <button key={a.rel} onClick={() => onPick(a.source)} className="rounded-md border border-ink-800 p-1 text-left hover:border-accent-500" title={a.rel}>
                <div className="checker flex h-20 items-center justify-center overflow-hidden rounded"><img loading="lazy" src={imageUrl('', a.source)} alt="" className="max-h-full max-w-full" /></div>
                <div className="mt-1 truncate text-[11px] text-ink-300">{a.rel}</div>
              </button>
            ))}
            {!list.length && <p className="col-span-full text-xs text-ink-500">No pictures found.</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------- duplicate ----------
interface DupOpts { count: number; dx: number; dy: number; delayStep: number; find: string; replace: string; start: number }
function DuplicateDialog({ infos, els, doc, onClose, onApply }: { infos: ElementInfo[]; els: ElementInfo[]; doc: GtNode; onClose: () => void; onApply: (o: DupOpts) => void }) {
  // default offset: the step from the previous numbered sibling (BAR 1 → BAR 2), else the height of the selection's content
  const guess = useMemo(() => {
    for (const e of infos) {
      const m = /^(.*?)(\d+)$/.exec(e.node.attrs.Name ?? '');
      if (!m) continue;
      const prev = els.find((x) => x.node.attrs.Name === m[1] + (Number(m[2]) - 1) && pathKey(x.parentPath ?? []) === pathKey(e.parentPath ?? []));
      if (prev) {
        const [ax, ay] = vec(prev.node.attrs.Location), [bx, by] = vec(e.node.attrs.Location);
        if (ax !== bx || ay !== by) return { dx: Math.round((bx - ax) * 100) / 100, dy: Math.round((by - ay) * 100) / 100 };
      }
    }
    const keys = infos.map((e) => pathKey(e.path));
    const boxes = els.filter((x) => x.node.tag !== 'Layer' && keys.some((k) => pathKey(x.path) === k || pathKey(x.path).startsWith(k + '/'))).map((x) => absBox(x, doc, els));
    if (!boxes.length) return { dx: 0, dy: 0 };
    const top = Math.min(...boxes.map((b) => b[1])), bottom = Math.max(...boxes.map((b) => b[1] + b[3]));
    return { dx: 0, dy: Math.round(bottom - top + 10) };
  }, [infos, els, doc]);
  const [o, setO] = useState<DupOpts>({ count: 1, dx: guess.dx, dy: guess.dy, delayStep: 0, find: '', replace: '', start: 1 });
  const set = (k: keyof DupOpts) => (e: React.ChangeEvent<HTMLInputElement>) => setO({ ...o, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.value });
  const names = infos.map((e) => e.node.attrs.Name).filter(Boolean);
  return (
    <Modal open onClose={onClose} title="Duplicate" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onApply(o)}>Add copies</Button></>}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-ink-400">Copies {names.join(', ')} with everything inside. Names are renumbered (BAR 4 → BAR 5, FLAG 13–16 → FLAG 17–20) and the animations, masks and DataChange storyboards of the copies are added too.</p>
        <div className="grid grid-cols-4 gap-2">
          <label><span className="label">Copies</span><input className="input" type="number" min={1} max={50} value={o.count} onChange={set('count')} /></label>
          <label><span className="label">Offset X</span><input className="input" type="number" value={o.dx} onChange={set('dx')} /></label>
          <label><span className="label">Offset Y</span><input className="input" type="number" value={o.dy} onChange={set('dy')} /></label>
          <label><span className="label">Delay +s</span><input className="input" type="number" step={0.05} value={o.delayStep} onChange={set('delayStep')} title="Added to the copied animations' delay for each copy (staggered entry)" /></label>
        </div>
        <details>
          <summary className="cursor-pointer text-xs text-ink-400">Rename instead of renumbering (e.g. Helm → Sailor{'{n}'})</summary>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <label><span className="label">Find</span><input className="input" value={o.find} onChange={set('find')} placeholder="Helm" /></label>
            <label><span className="label">Replace with</span><input className="input" value={o.replace} onChange={set('replace')} placeholder="Sailor{n}" /></label>
            <label><span className="label">{'{n}'} starts at</span><input className="input" type="number" value={o.start} onChange={set('start')} /></label>
          </div>
          <p className="mt-1 text-[11px] text-ink-500">Applies to every copied name containing the text, e.g. HelmBG → Sailor10BG, HELM stays unless you also match it.</p>
        </details>
      </div>
    </Modal>
  );
}

// ---------- animations ----------
function Animations({ doc, mutate, selNames }: { doc: GtNode; mutate: (fn: (r: GtNode) => void, key?: string) => void; selNames: string[] }) {
  const sbs = storyboards(doc);
  const [onlySel, setOnlySel] = useState(false);
  const names = [...new Set(elements(doc).map((e) => e.node.attrs.Name).filter(Boolean))].sort();
  const [shift, setShift] = useState('0.1');
  const editAnim = (sbIndex: number, ai: number, fn: (a: GtNode, list: GtNode[]) => void, key?: string) =>
    mutate((r) => { const list = animationsOf(r.children[sbIndex]); fn(list[ai], list); }, key && `anim-${sbIndex}-${ai}-${key}`);
  const addSb = (type: string) => mutate((r) => {
    const sb: GtNode = { tag: 'Storyboard', attrs: type === 'TransitionIn' ? {} : { Type: type }, children: [{ tag: 'Storyboard.Animations', attrs: {}, children: [] }] };
    const lastSb = r.children.map((c) => c.tag).lastIndexOf('Storyboard');
    r.children.splice(lastSb >= 0 ? lastSb + 1 : r.children.length, 0, sb);
  });
  const has = (t: string) => sbs.some((s) => s.type === t);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={onlySel} onChange={(e) => setOnlySel(e.target.checked)} /> Only selected elements</label>
        {!has('TransitionIn') && <Button size="sm" onClick={() => addSb('TransitionIn')}>+ In</Button>}
        {!has('TransitionOut') && <Button size="sm" onClick={() => addSb('TransitionOut')}>+ Out</Button>}
      </div>
      {!sbs.length && <p className="text-xs text-ink-500">This title has no animations.</p>}
      {sbs.map((sb) => {
        const list = sb.animations.map((a, i) => ({ a, i })).filter(({ a }) => !onlySel || selNames.includes(a.attrs.Object));
        const len = storyboardLength(sb.node);
        return (
          <div key={sb.index} className="card p-2">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-sm font-semibold">{sb.label}</span>
              <span className="text-[11px] text-ink-500">{sb.animations.length} animations · {fmtNum(len)} s</span>
              <span className="ml-auto flex items-center gap-1 text-[11px] text-ink-400" title="Moves the shown animations later (or earlier with a minus)">
                shift <input className={cx(small, 'w-14')} type="number" step={0.05} value={shift} onChange={(e) => setShift(e.target.value)} />s
                <Button size="sm" variant="ghost" onClick={() => mutate((r) => {
                  const all = animationsOf(r.children[sb.index]);
                  for (const { i } of list) { const a = all[i]; const d = Math.max(0, Number(a.attrs.Delay ?? 0) + Number(shift || 0)); if (d) a.attrs.Delay = fmtNum(d); else delete a.attrs.Delay; }
                })}>Apply</Button>
              </span>
            </div>
            <div className="space-y-1">
              <div className="grid grid-cols-[minmax(0,1fr)_4.25rem_3.75rem_3.75rem_4.25rem_1rem] gap-1 text-[10px] uppercase text-ink-500">
                <span>Element</span><span>Type</span><span>Delay</span><span>Dur.</span><span>Direction</span><span />
              </div>
              {list.map(({ a, i }) => (
                <div key={i} className="grid grid-cols-[minmax(0,1fr)_4.25rem_3.75rem_3.75rem_4.25rem_1rem] items-center gap-1" title={`Easing: ${a.attrs.Interpolation ?? 'default'}`}>
                  <select className={small} value={a.attrs.Object ?? ''} onChange={(e) => editAnim(sb.index, i, (x) => { x.attrs.Object = e.target.value; })}>
                    {[...new Set([a.attrs.Object ?? '', ...names])].map((nm) => <option key={nm} value={nm}>{nm}</option>)}
                  </select>
                  <select className={small} value={a.tag} onChange={(e) => editAnim(sb.index, i, (x) => { x.tag = e.target.value; })}>
                    {[...new Set([a.tag, ...ANIMATION_TYPES])].map((t) => <option key={t}>{t}</option>)}
                  </select>
                  <input className={tiny} type="number" step={0.05} min={0} value={a.attrs.Delay ?? 0} onChange={(e) => editAnim(sb.index, i, (x) => { if (Number(e.target.value)) x.attrs.Delay = e.target.value; else delete x.attrs.Delay; }, 'delay')} />
                  <input className={tiny} type="number" step={0.05} min={0} value={a.attrs.Duration ?? 1} onChange={(e) => editAnim(sb.index, i, (x) => { if (Number(e.target.value) !== 1) x.attrs.Duration = e.target.value; else delete x.attrs.Duration; }, 'dur')} />
                  <select className={small} value={a.attrs.Direction ?? ''} onChange={(e) => editAnim(sb.index, i, (x) => { if (e.target.value) x.attrs.Direction = e.target.value; else delete x.attrs.Direction; })}>
                    <option value="">–</option>{DIRECTIONS.map((d) => <option key={d}>{d}</option>)}
                  </select>
                  <button className="text-ink-500 hover:text-red-300" title="Remove" onClick={() => editAnim(sb.index, i, (_x, l) => { l.splice(i, 1); })}>✕</button>
                </div>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => mutate((r) => {
                const objs = selNames.length ? selNames : [names[0]];
                animationsOf(r.children[sb.index]).push(...objs.map((o) => ({ tag: 'Fade', attrs: { Object: o, Duration: '0.5', Interpolation: 'CubicEasingInOut' }, children: [] })));
              })}>+ Animation{selNames.length > 1 ? `s for ${selNames.length} selected` : selNames.length ? ` for ${selNames[0]}` : ''}</Button>
              <label className="ml-auto flex items-center gap-1 text-[11px] text-ink-400">Easing for all shown
                <select className={cx(small, 'w-auto')} value="" onChange={(e) => e.target.value && mutate((r) => { const all = animationsOf(r.children[sb.index]); for (const { i } of list) all[i].attrs.Interpolation = e.target.value; })}>
                  <option value="">choose…</option>{INTERPOLATIONS.map((x) => <option key={x}>{x}</option>)}
                </select>
              </label>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Fields({ doc }: { doc: GtNode }) {
  const toast = useToast();
  const list = fields(doc);
  const csv = list.map((f) => f.name).join('\t');
  return (
    <div className="card space-y-2 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-ink-400">{list.length} fields vMix will show for this title (name = column for Data Source “Auto”).</span>
        <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard?.writeText(csv); toast.ok('Copied as a header row.'); }}>Copy</Button>
      </div>
      <ul className="max-h-[28rem] overflow-auto text-xs">
        {list.map((f) => <li key={f.name} className="flex justify-between border-b border-ink-800/60 py-1"><span>{f.name}</span><span className="text-ink-500">{f.kind === 'Text' ? 'text' : 'image'}</span></li>)}
      </ul>
    </div>
  );
}

// ---------- scenes ----------
function ScenesOverview({ state, onOpen }: { state: GtzipState; onOpen: (id: string) => void }) {
  const groups = [...new Set(state.scenes.map((s) => s.group))];
  const total = state.scenes.reduce((n, s) => n + s.variants.length, 0);
  const done = state.scenes.reduce((n, s) => n + s.variants.filter((v) => state.templates.some((t) => t.scene === s.id && t.variant === v.id)).length, 0);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Scenes</h1>
        <p className="text-sm text-ink-400">
          {done} of {total} scene variants have a template. Upload a .gtzip (the scene is recognised from the file name, or set it in the editor), change it and
          use “Save as template…” for each variant, then Generate the files for vMix. Templates are never modified and generating never replaces a file.
        </p>
      </div>
      {groups.map((g) => (
        <div key={g} className="card p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">{g}</h2>
          <table className="w-full text-sm">
            <tbody>
              {state.scenes.filter((s) => s.group === g).map((s) => s.variants.map((v, i) => {
                const ts = state.templates.filter((t) => t.scene === s.id && t.variant === v.id);
                return (
                  <tr key={s.id + v.id} className="border-t border-ink-800/60 first:border-0">
                    <td className="w-1/3 py-1.5 pr-2 align-top">{i === 0 ? <span className="font-medium text-ink-100">{s.name}</span> : null}</td>
                    <td className="w-1/4 py-1.5 pr-2 align-top text-ink-400">{s.variants.length > 1 ? v.label : ''}</td>
                    <td className="py-1.5 align-top">
                      {ts.length ? <div className="flex flex-wrap gap-1">{ts.map((t) => (
                        <button key={t.id} onClick={() => onOpen(t.id)} className="rounded bg-emerald-950/60 px-2 py-0.5 text-xs text-emerald-200 hover:bg-emerald-900/70">✓ {t.name}</button>
                      ))}</div> : <span className="text-xs text-ink-600">no template yet</span>}
                    </td>
                  </tr>
                );
              }))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function SceneSelect({ scenes, meta }: { scenes: SceneDef[]; meta: TemplateMeta }) {
  const qc = useQueryClient();
  const toast = useToast();
  const sc = scenes.find((s) => s.id === meta.scene);
  const save = async (scene: string | null, variant: string | null) => {
    try { await api.patch(`/api/gtzip/templates/${meta.id}`, { scene, variant }); qc.invalidateQueries({ queryKey: ['gtzip'] }); } catch (e) { toast.error(e); }
  };
  return (
    <span className="flex items-center gap-1 text-xs">
      <select className={cx(small, 'w-auto')} value={meta.scene ?? ''} onChange={(e) => save(e.target.value || null, null)} title="Which scene of the broadcast this template is">
        <option value="">scene…</option>
        {scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      {sc && sc.variants.length > 1 && (
        <select className={cx(small, 'w-auto')} value={meta.variant ?? ''} onChange={(e) => save(sc.id, e.target.value)}>
          {sc.variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
      )}
    </span>
  );
}

function SaveTemplateDialog({ scenes, tpl, doc, onClose, onSaved }: { scenes: SceneDef[]; tpl: TemplateDoc; doc: GtNode; onClose: () => void; onSaved: (m: TemplateMeta) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [scene, setScene] = useState(tpl.meta.scene ?? '');
  const sc = scenes.find((s) => s.id === scene);
  const [variant, setVariant] = useState(tpl.meta.variant ?? '');
  const vv = sc?.variants.find((v) => v.id === variant) ?? sc?.variants[0];
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const shownName = name || (sc ? `${sc.name}${vv && sc.variants.length > 1 ? ` – ${vv.label}` : ''}` : `${tpl.meta.name} (edited)`);
  const save = async () => {
    setBusy(true);
    try {
      const m = await api.post<TemplateMeta>('/api/gtzip/templates/from-doc', { templateId: tpl.meta.id, name: shownName, doc, scene: sc?.id ?? null, variant: vv?.id ?? null });
      await qc.invalidateQueries({ queryKey: ['gtzip'] });
      toast.ok(`Template “${m.name}” saved.`);
      onSaved(m);
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Save as template" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>Save template</Button></>}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-ink-400">Keeps the current state as a new template. “{tpl.meta.name}” stays as it is.</p>
        <div className="grid grid-cols-2 gap-2">
          <label><span className="label">Scene</span>
            <select className="input" value={scene} onChange={(e) => { setScene(e.target.value); setVariant(''); }}>
              <option value="">none</option>{scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label><span className="label">Variant</span>
            <select className="input" value={vv?.id ?? ''} disabled={!sc || sc.variants.length < 2} onChange={(e) => setVariant(e.target.value)}>
              {(sc?.variants ?? []).map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </label>
        </div>
        <label className="block"><span className="label">Template name</span><input className="input" value={name} placeholder={shownName} onChange={(e) => setName(e.target.value)} /></label>
      </div>
    </Modal>
  );
}
