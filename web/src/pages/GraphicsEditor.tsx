import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Badge, Button, cx, ErrorBox, Loading, useConfirm, useToast } from '../components/ui';
import { SaveInput } from '../components/fields';

interface EditorField { name: string; image: boolean; current: string; override: string | null; preview: string }
interface EditorInput { title: string; number: string; inVmix: boolean; graphic: { id: string; label: string } | null; edited: number; fields: EditorField[] }
interface EditorView { inputs: EditorInput[]; error: string }
interface PickImage { value: string; label: string; group: string }

const file = (p: string) => p.split(/[\\/]/).pop() ?? p;
const thumb = (rel: string) => `/api/gtzip/image?src=${encodeURIComponent(`asset:${rel}`)}`;
const fieldLabel = (name: string) => name.replace(/\.(Text|Source)$/, '');

/**
 * Graphics editor: every vMix title (GT / Xaml) with its text fields and pictures. Each title is one line; Edit opens
 * its fields: what vMix shows now, and a box to type over it (or a picture to upload or pick). An edit stays until
 * it is reset, whatever the dashboard sends; the dashboard puts it into vMix within seconds. Only SetText / SetImage.
 */
export function GraphicsEditorPage() {
  const q = useQuery({ queryKey: ['vmix-editor'], queryFn: () => api.get<EditorView>('/api/vmix/editor'), refetchInterval: 5000 });
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const s = search.trim().toLowerCase();
  const groups = useMemo(() => {
    const out: { label: string; inputs: EditorInput[] }[] = [];
    for (const i of q.data?.inputs ?? []) {
      const label = i.graphic?.label ?? 'Other titles';
      if (s && ![i.title, label, ...i.fields.map((f) => f.name)].some((x) => x.toLowerCase().includes(s))) continue;
      const g = out.find((x) => x.label === label) ?? (out.push({ label, inputs: [] }), out[out.length - 1]);
      g.inputs.push(i);
    }
    return out;
  }, [q.data, s]);
  const edited = (q.data?.inputs ?? []).filter((i) => i.edited).length;

  return (
    <div className="space-y-2">
      <div className="card flex flex-wrap items-center gap-2 px-3 py-2">
        <h1 className="text-sm font-bold uppercase tracking-wide text-ink-200">Graphics editor</h1>
        <span className="text-xs text-ink-500">Texts and pictures of every vMix title. An edit wins over the dashboard's value until you reset it.{edited ? ` ${edited} title${edited > 1 ? 's' : ''} edited.` : ''}</span>
        <input className="input ml-auto w-56 py-1 text-sm" placeholder="Search title, graphic, field…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.data?.error && <div role="alert" className="rounded border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">{q.data.error}</div>}
      {q.data && !groups.length && <p className="px-1 py-6 text-center text-sm text-ink-500">{s ? 'Nothing matches the search.' : 'vMix has no title inputs (GT / Xaml) loaded.'}</p>}
      {groups.map((g) => (
        <section key={g.label} className="card overflow-hidden">
          <h2 className="border-b border-ink-800 bg-ink-900/60 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-ink-400">{g.label}</h2>
          <ul className="divide-y divide-ink-800">
            {g.inputs.map((i) => (
              <InputRow key={i.title} input={i} open={open === i.title} onToggle={() => setOpen(open === i.title ? null : i.title)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function InputRow({ input, open, onToggle }: { input: EditorInput; open: boolean; onToggle: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const resetAll = async () => {
    if (!(await ask('Reset all edits?', <>Every edited field of <b>{input.title}</b> goes back to the dashboard's value (or the title's own).</>, 'Reset all'))) return;
    try {
      const r = await api.del<{ warning?: string }>(`/api/vmix/editor/input?input=${encodeURIComponent(input.title)}`);
      if (r.warning) toast.error(r.warning);
      await qc.invalidateQueries({ queryKey: ['vmix-editor'] });
    } catch (e) { toast.error(e); }
  };
  return (
    <li>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="min-w-0 truncate text-sm font-medium text-ink-100" title={input.title}>{input.title}</span>
        {input.number && <span className="text-xs text-ink-500">#{input.number}</span>}
        {!input.inVmix && <Badge tone="warn" title="vMix has not loaded this input now; its edits are kept">Not in vMix</Badge>}
        <span className="text-xs text-ink-500">{input.fields.length} field{input.fields.length === 1 ? '' : 's'}</span>
        {input.edited > 0 && <Badge tone="info">{input.edited} edited</Badge>}
        <span className="ml-auto flex gap-1">
          {input.edited > 0 && <Button size="sm" variant="ghost" onClick={resetAll}>Reset all</Button>}
          <Button size="sm" variant={open ? 'primary' : 'secondary'} onClick={onToggle} aria-expanded={open}>{open ? 'Close' : 'Edit'}</Button>
        </span>
      </div>
      {open && <FieldList input={input} />}
      {dialog}
    </li>
  );
}

function FieldList({ input }: { input: EditorInput }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const [onlyEdited, setOnlyEdited] = useState(false);
  const images = useQuery({ queryKey: ['vmix-editor-images'], queryFn: () => api.get<PickImage[]>('/api/vmix/editor/images'), staleTime: 30_000 });
  const save = async (field: string, value: string | null) => {
    try {
      const r = await api.put<{ warning?: string }>('/api/vmix/editor/field', { input: input.title, field, value });
      if (r.warning) toast.error(r.warning);
      await qc.invalidateQueries({ queryKey: ['vmix-editor'] });
    } catch (e) { toast.error(e); }
  };
  const upload = async (field: string, f: File | undefined) => {
    if (!f) return;
    try {
      const r = await api.upload<{ path: string }>('/api/vmix/editor/upload', f);
      await qc.invalidateQueries({ queryKey: ['vmix-editor-images'] });
      await save(field, r.path);
    } catch (e) { toast.error(e); }
  };
  const fl = filter.trim().toLowerCase();
  const fields = input.fields.filter((f) => (!onlyEdited || f.override !== null) && (!fl || f.name.toLowerCase().includes(fl)));
  const byGroup = useMemo(() => {
    const m = new Map<string, PickImage[]>();
    for (const i of images.data ?? []) m.set(i.group, [...(m.get(i.group) ?? []), i]);
    return [...m];
  }, [images.data]);

  return (
    <div className="border-t border-ink-800 bg-ink-950/40 px-3 py-2">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-500">
        {input.fields.length > 8 && <input className="input w-48 py-0.5 text-xs" placeholder="Filter fields…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter fields" />}
        <label className="inline-flex items-center gap-1"><input type="checkbox" checked={onlyEdited} onChange={(e) => setOnlyEdited(e.target.checked)} /> Edited only</label>
        <span>Grey = what vMix shows now. Leave a box empty to keep the dashboard's value; type a space to blank the field on air.</span>
      </div>
      {!fields.length && <p className="py-2 text-xs text-ink-500">No fields.</p>}
      <div className="grid gap-x-4 gap-y-1 lg:grid-cols-2">
        {fields.map((f) => (
          <div key={f.name} className={cx('flex min-w-0 items-center gap-2 rounded px-1 py-0.5', f.override !== null && 'bg-sky-950/30')}>
            <span className="w-32 shrink-0 truncate text-xs font-medium text-ink-300" title={f.name}>{fieldLabel(f.name)}{f.image && <span className="text-ink-500"> (image)</span>}</span>
            {f.image && (
              f.preview
                ? <img src={thumb(f.preview)} alt="" className="checker h-7 w-7 shrink-0 rounded border border-ink-800 object-contain" onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
                : <span className="h-7 w-7 shrink-0 rounded border border-dashed border-ink-800" />
            )}
            <div className="min-w-0 flex-1">
              <SaveInput value={f.override ?? ''} placeholder={(f.image ? file(f.current) : f.current) || '(empty)'} label={f.name} maxLength={4000}
                onSave={(v) => save(f.name, v === '' ? null : v)} />
            </div>
            {f.image && (
              <>
                <select className="input w-28 shrink-0 py-1 text-xs" value="" aria-label={`Pick a picture for ${f.name}`} title="Pick a picture already in the dashboard"
                  onChange={(e) => { if (e.target.value) void save(f.name, e.target.value); }}>
                  <option value="">Pick…</option>
                  {byGroup.map(([g, list]) => (
                    <optgroup key={g} label={g}>{list.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}</optgroup>
                  ))}
                </select>
                <label className="inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded border border-ink-700 bg-ink-800 px-2 py-0.5 text-[11px] text-ink-100 hover:bg-ink-700" title="Upload a PNG or JPG for this field">
                  Upload
                  <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => { void upload(f.name, e.target.files?.[0]); e.target.value = ''; }} />
                </label>
              </>
            )}
            <Button size="sm" variant="ghost" className={cx('shrink-0', f.override === null && 'invisible')} onClick={() => save(f.name, null)} title="Back to the dashboard's value">Reset</Button>
          </div>
        ))}
      </div>
    </div>
  );
}
