import { useRef, useState, DragEvent, FormEvent } from 'react';
import { api, Asset, SlotDef } from '../api';
import { Badge, Button, cx, fmtBytes, Modal, useConfirm, useToast } from './ui';

export type PreviewBg = 'checker' | 'dark' | 'light';
const bgClass = (bg: PreviewBg) => (bg === 'checker' ? 'checker' : bg === 'dark' ? 'bg-preview-dark' : 'bg-preview-light');

export function BgToggle({ value, onChange }: { value: PreviewBg; onChange: (v: PreviewBg) => void }) {
  const opts: [PreviewBg, string][] = [['checker', 'Checkerboard'], ['dark', 'Dark'], ['light', 'Light']];
  return (
    <div role="radiogroup" aria-label="Preview background" className="inline-flex rounded-md border border-ink-700 bg-ink-900 p-0.5">
      {opts.map(([v, l]) => (
        <button key={v} role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={cx('rounded px-2.5 py-1 text-xs font-medium', value === v ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-100')}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function statusBadge(a: Asset | undefined | null) {
  if (!a) return <Badge tone="warn">Missing</Badge>;
  switch (a.checkStatus) {
    case 'stored': return <Badge tone="ok" title="File stored in the app's asset folder">File stored</Badge>;
    case 'reachable': return <Badge tone="info" title={a.checkMessage}>Path reachable</Badge>;
    case 'unverified': return <Badge tone="warn" title={a.checkMessage}>Path unverified</Badge>;
    default: return <Badge tone="error" title={a.checkMessage}>File error</Badge>;
  }
}

interface Props {
  ownerKind: 'teams' | 'sailors';
  ownerId: string;
  slot: SlotDef;
  asset: Asset | undefined | null;
  bg: PreviewBg;
  onChanged: () => void;
  accept?: 'png' | 'png+jpg';
  aspect?: string;
}

export function AssetSlot({ ownerKind, ownerId, slot, asset, bg, onChanged, accept = 'png', aspect = 'aspect-video' }: Props) {
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pathMode, setPathMode] = useState(false);
  const [pathValue, setPathValue] = useState('');
  const [imgError, setImgError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  const base = `/api/${ownerKind}/${ownerId}/assets/${slot.key}`;
  const acceptAttr = accept === 'png' ? 'image/png,.png' : 'image/png,image/jpeg,.png,.jpg,.jpeg';

  const upload = async (file: File) => {
    const okType = accept === 'png' ? /\.png$/i.test(file.name) || file.type === 'image/png' : /\.(png|jpe?g)$/i.test(file.name) || /image\/(png|jpeg)/.test(file.type);
    if (!okType) { toast.error(`“${file.name}”: unsupported format. Required: ${accept === 'png' ? 'PNG' : 'PNG or JPG'}.`); return; }
    if (asset && !(await ask('Replace graphic?', <>Slot <b>{slot.label}</b> already has <b>{asset.originalFilename}</b>. It will be replaced with <b>{file.name}</b>.</>, 'Replace', false))) return;
    setBusy(true);
    try {
      await api.upload(`${base}/upload`, file);
      setImgError(null);
      toast.ok(`${slot.label}: saved ${file.name}`);
      onChanged();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const files = [...e.dataTransfer.files];
    if (!files.length) { toast.error('Drop a file from your disk (dragging images from web pages is not supported).'); return; }
    if (files.length > 1) toast.info('Several files dropped; using the first one.');
    void upload(files[0]);
  };

  const savePath = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const a = await api.put<Asset>(`${base}/path`, { path: pathValue });
      setPathMode(false);
      setImgError(null);
      if (a.checkStatus === 'unverified') toast.info(`${slot.label}: path saved but unverified.`);
      else toast.ok(`${slot.label}: path saved`);
      onChanged();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!asset || !(await ask('Remove assignment?', <>Slot <b>{slot.label}</b> will be cleared{asset.storageKind === 'upload' ? ' and the uploaded file deleted from the asset folder' : ' (the file at the entered path is not deleted)'}.</>, 'Remove'))) return;
    setBusy(true);
    try { await api.del(base); toast.ok(`${slot.label}: assignment removed`); onChanged(); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };

  const recheck = async () => {
    if (!asset) return;
    setBusy(true);
    try {
      const a = await api.post<Asset>(`/api/assets/${asset.id}/recheck`);
      setImgError(null);
      toast.info(`${slot.label}: ${a.checkStatus === 'reachable' ? 'file reachable by the server' : a.checkStatus === 'stored' ? 'file present' : a.checkMessage}`);
      onChanged();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };

  const shownPath = asset?.storageKind === 'upload' ? asset.storedPath : asset?.enteredPath;
  const canPreview = !!asset?.previewUrl && !imgError;

  return (
    <div className={cx('card flex flex-col overflow-hidden', !asset && 'border-amber-900/50')}>
      <div className="flex items-center justify-between gap-2 border-b border-ink-800 px-3 py-2">
        <h3 className="truncate text-sm font-semibold text-ink-50">{slot.label}</h3>
        {statusBadge(asset)}
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cx('relative', aspect, 'flex items-center justify-center overflow-hidden', canPreview ? bgClass(bg) : 'bg-ink-950', over && 'ring-2 ring-inset ring-accent-400')}
      >
        {canPreview ? (
          <button className="h-full w-full p-2" onClick={() => setZoom(true)} aria-label={`Enlarge: ${slot.label}`}>
            <img src={asset!.previewUrl!} alt={slot.label} className="mx-auto h-full w-full object-contain" onError={() => setImgError('The browser could not display this file.')} />
          </button>
        ) : asset ? (
          <div className="px-4 text-center">
            <p className="text-sm font-semibold text-amber-300">Preview unavailable</p>
            <p className="mt-1 text-xs text-ink-400">{imgError ?? asset.checkMessage ?? 'The server cannot access this file.'}</p>
          </div>
        ) : (
          <button onClick={() => fileRef.current?.click()} className="flex h-full w-full flex-col items-center justify-center gap-1 text-ink-500 hover:text-ink-300">
            <span className="text-2xl">＋</span>
            <span className="text-xs">Drop a {accept === 'png' ? 'PNG' : 'PNG/JPG'} file or click</span>
          </button>
        )}
        {over && <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-accent-500/20 text-sm font-semibold text-white">Drop to {asset ? 'replace' : 'add'}</div>}
        {busy && <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-sm text-white">Saving…</div>}
      </div>

      <div className="space-y-1 px-3 py-2 text-xs">
        {asset ? (
          <>
            <div className="flex justify-between gap-2 text-ink-300">
              <span className="truncate font-medium" title={asset.originalFilename}>{asset.originalFilename}</span>
              <span className="shrink-0 tabular-nums text-ink-400">{asset.width && asset.height ? `${asset.width}×${asset.height}` : '? × ?'} · {fmtBytes(asset.sizeBytes)}</span>
            </div>
            <PathLine label={asset.storageKind === 'upload' ? 'Stored' : 'Path'} value={shownPath} />
            <PathLine label="vMix" value={asset.vmixPath} missing={asset.vmixPathNote} />
          </>
        ) : (
          <p className="text-ink-500">No graphic assigned.</p>
        )}
      </div>

      {pathMode && (
        <form onSubmit={savePath} className="space-y-2 border-t border-ink-800 px-3 py-2">
          <input className="input font-mono text-xs" value={pathValue} onChange={(e) => setPathValue(e.target.value)} autoFocus
            placeholder={'D:\\SSL\\graphics\\flag.png or \\\\VMIX-PC\\graphics\\flag.png'} aria-label={`Path for ${slot.label}`} />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setPathMode(false)}>Cancel</Button>
            <Button type="submit" size="sm" variant="primary" busy={busy} disabled={!pathValue.trim()}>Save path</Button>
          </div>
        </form>
      )}

      <div className="mt-auto flex flex-wrap gap-1 border-t border-ink-800 px-2 py-1.5">
        <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()} disabled={busy}>{asset ? 'Replace file' : 'Choose file'}</Button>
        <Button size="sm" variant="ghost" onClick={() => { setPathValue(asset?.enteredPath ?? ''); setPathMode((v) => !v); }} disabled={busy}>Path…</Button>
        {asset?.storageKind === 'path' && <Button size="sm" variant="ghost" onClick={recheck} disabled={busy}>Check</Button>}
        {asset && <Button size="sm" variant="ghost" className="ml-auto text-red-300 hover:text-red-200" onClick={remove} disabled={busy}>Remove</Button>}
      </div>
      <input ref={fileRef} type="file" accept={acceptAttr} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />

      {zoom && asset?.previewUrl && <Lightbox title={slot.label} asset={asset} onClose={() => setZoom(false)} initialBg={bg} />}
      {dialog}
    </div>
  );
}

function PathLine({ label, value, missing }: { label: string; value: string | null | undefined; missing?: string }) {
  const toast = useToast();
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-ink-500">{label}</span>
      {value ? (
        <button className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-ink-300 hover:text-accent-300" title={`${value}\n(click to copy)`}
          onClick={() => navigator.clipboard?.writeText(value).then(() => toast.info('Path copied'), () => {})}>
          {value}
        </button>
      ) : <span className="truncate text-ink-500" title={missing}>{missing ? 'no mapping' : '—'}</span>}
    </div>
  );
}

export function Lightbox({ title, asset, onClose, initialBg }: { title: string; asset: Asset; onClose: () => void; initialBg: PreviewBg }) {
  const [bg, setBg] = useState<PreviewBg>(initialBg);
  return (
    <Modal open onClose={onClose} title={title} wide>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-400">
        <span>{asset.originalFilename} · {asset.width}×{asset.height} px · {fmtBytes(asset.sizeBytes)}</span>
        <BgToggle value={bg} onChange={setBg} />
      </div>
      <div className={cx('flex max-h-[70vh] items-center justify-center overflow-auto rounded-lg p-4', bgClass(bg))}>
        <img src={asset.previewUrl!} alt={title} className="max-h-[66vh] max-w-full object-contain" />
      </div>
    </Modal>
  );
}
