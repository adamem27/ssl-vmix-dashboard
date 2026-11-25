import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { FoldTitle, useFold } from '../components/fold';
import { Button, cx, useToast } from '../components/ui';

interface Slot { on: boolean; lang: string; host: string; input: string; field: string }
interface SlotStatus { slot: number; lang: string; on: boolean; input: string; field: string; text: string; sentAt: string | null; error: string }
interface LangsData {
  config: { enabled: boolean; slots: Slot[] };
  hasKey: boolean;
  languages: { code: string; name: string }[];
  status: SlotStatus[];
  messages: { source: string; translations: Record<string, { text: string; manual: boolean } | null> }[];
}

/** Show control → Ticker languages: the bottom ticker translated by DeepL onto the streaming PCs' ticker inputs. */
export function TickerLangsPanel() {
  const [open, setOpen] = useFold('show:Ticker languages');
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['ticker-langs'], queryFn: () => api.get<LangsData>('/api/ticker-langs'), refetchInterval: open ? 3000 : false });
  const d = q.data;
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [key, setKey] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  useEffect(() => { if (d && !slots) setSlots(d.config.slots); }, [d, slots]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['ticker-langs'] });
  const dirty = !!d && !!slots && JSON.stringify(slots) !== JSON.stringify(d.config.slots);
  const run = async (f: () => Promise<unknown>, ok?: string) => { try { await f(); if (ok) toast.ok(ok); await refresh(); } catch (e) { toast.error(e); } };
  const saveSlots = () => run(async () => { const c = await api.put<LangsData['config']>('/api/ticker-langs/config', { slots }); setSlots(c.slots); }, 'Saved');
  const langName = (code: string) => d?.languages.find((l) => l.code === code)?.name ?? code;
  const langs = [...new Set((d?.config.slots ?? []).filter((s) => s.lang).map((s) => s.lang))];

  return (
    <section className="card">
      <header className={cx('flex flex-wrap items-center gap-2 px-3 py-2', open && 'border-b border-ink-800')}>
        <FoldTitle open={open} onToggle={() => setOpen(!open)}>Ticker languages</FoldTitle>
        {open && d && <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-ink-300" title="Off: nothing is translated or sent; the local ticker works as always.">
            <input type="checkbox" checked={d.config.enabled} onChange={(e) => run(() => api.put('/api/ticker-langs/config', { enabled: e.target.checked }))} /> On
          </label>
          <Button size="sm" onClick={() => run(() => api.post('/api/ticker-langs/send'), 'Sent again')}>Send now</Button>
          <Button size="sm" variant="primary" disabled={!dirty} onClick={saveSlots}>Save</Button>
        </div>}
      </header>
      {open && d && slots && <div className="space-y-4 p-3 text-sm">
        <p className="max-w-3xl text-xs text-ink-400">The bottom ticker (ssl_ticker) is translated by DeepL and written into a ticker input of another vMix, one language per slot. Only the text: switching that ticker on and off stays with the streaming vMix. Each message is translated once; team codes and sailors' names stay as they are. If DeepL or a streaming PC does not answer, the text there stays as it was and the slot shows why.</p>

        <div className="flex flex-wrap items-end gap-2">
          <label className="block text-xs text-ink-400">DeepL API key {d.hasKey ? <span className="text-emerald-400">(saved)</span> : <span className="text-amber-400">(none)</span>}
            <input type="password" autoComplete="off" className="input mt-1 w-80 py-1 text-sm" placeholder={d.hasKey ? 'Saved: type a new one to replace it' : 'From deepl.com → Account → API keys'} value={key} onChange={(e) => setKey(e.target.value)} />
          </label>
          <Button size="sm" disabled={!key.trim()} onClick={() => run(async () => { await api.put('/api/ticker-langs/key', { key }); setKey(''); }, 'Key saved')}>Save key</Button>
        </div>

        <table className="w-full max-w-5xl text-xs">
          <thead className="text-left text-ink-400"><tr><th className="py-1">Slot</th><th>On</th><th>Language</th><th>vMix address</th><th>Input (number or name)</th><th>Field (empty = by itself)</th><th>Status</th></tr></thead>
          <tbody>
            {slots.map((s, i) => {
              const st = d.status.find((x) => x.slot === i + 1);
              const set = (p: Partial<Slot>) => setSlots(slots.map((x, j) => (j === i ? { ...x, ...p } : x)));
              return (
                <tr key={i} className="border-t border-ink-800 align-top">
                  <td className="py-1 pr-2 text-ink-300">Language {i + 2}</td>
                  <td className="pr-2"><input type="checkbox" checked={s.on} onChange={(e) => set({ on: e.target.checked })} /></td>
                  <td className="pr-2"><select className="input py-1 text-xs" value={s.lang} onChange={(e) => set({ lang: e.target.value })}>
                    <option value="">—</option>
                    {d.languages.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                  </select></td>
                  <td className="pr-2"><input className="input w-48 py-1 text-xs" value={s.host} onChange={(e) => set({ host: e.target.value })} /></td>
                  <td className="pr-2"><input className="input w-28 py-1 text-xs" value={s.input} onChange={(e) => set({ input: e.target.value })} /></td>
                  <td className="pr-2"><input className="input w-32 py-1 text-xs" value={s.field} placeholder={st?.field || ''} onChange={(e) => set({ field: e.target.value })} /></td>
                  <td className="max-w-xs">
                    {!d.config.enabled || !s.on || !s.lang ? <span className="text-ink-500">off</span>
                      : st?.error ? <span className="text-red-400">{st.error}</span>
                      : st?.text ? <span className="text-emerald-400" title={st.text}>{st.input} · {st.field}{st.sentAt ? ` · sent ${new Date(st.sentAt).toLocaleTimeString()}` : ''}</span>
                      : <span className="text-ink-500">waiting for the ticker</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div>
          <div className="mb-1 text-xs font-semibold text-ink-300">On the ticker now</div>
          {!d.messages.length ? <div className="text-xs text-ink-500">No ticker text in vMix yet.</div>
            : <table className="w-full max-w-5xl text-xs">
              <thead className="text-left text-ink-400"><tr><th className="py-1">English</th>{langs.map((l) => <th key={l}>{langName(l)}</th>)}</tr></thead>
              <tbody>
                {d.messages.map((m) => (
                  <tr key={m.source} className="border-t border-ink-800 align-top">
                    <td className="py-1 pr-2 text-ink-300">{m.source}</td>
                    {langs.map((l) => {
                      const t = m.translations[l];
                      const id = `${l}|${m.source}`;
                      const value = edits[id] ?? t?.text ?? '';
                      const save = () => { if (edits[id] === undefined || edits[id] === (t?.text ?? '')) return; void run(async () => { await api.put('/api/ticker-langs/translation', { source: m.source, lang: l, text: edits[id] }); setEdits(({ [id]: _, ...rest }) => rest); }, 'Translation saved'); };
                      return (
                        <td key={l} className="pr-2">
                          <textarea rows={2} className={cx('input w-full py-1 text-xs', t?.manual && 'border-amber-500')} value={value} placeholder={t ? '' : 'not translated yet'}
                            title={t?.manual ? 'Corrected by hand: the machine translation never replaces it. Clear it to translate again.' : 'Machine translation: correct it here; your text wins.'}
                            onChange={(e) => setEdits({ ...edits, [id]: e.target.value })} onBlur={save} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>}
        </div>
      </div>}
    </section>
  );
}
