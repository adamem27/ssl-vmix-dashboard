import { ReactNode, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Button, cx, ErrorBox, Loading, useToast } from '../components/ui';

interface Fields { top: string; bottom: string; photo: string; flag: string; emblem: string; bar: string }
interface Config {
  photoInput: string; noPhotoInput: string; overlay: number; barSlot: string; flagSlot: string; emblemSlot: string; countryShowsTeam: boolean;
  companionUrl: string; companionPage: number; rows: number; cols: number; fields: Fields;
}
interface State { kind: 'team' | 'sailor' | null; teamId: string | null; slot: string | null; line: number; onAir: boolean; input: string }
interface Key { action: string; text: string; active: boolean; onAir: boolean; page: number; row: number; col: number; bg?: string; fg?: string; label?: string }
interface Sailor { slot: string; label: string; sailorId: string | null; firstName: string; lastName: string; number: string; position: string; photo: string; best: string[] }
interface LtData { config: Config; state: State; teams: { id: string; code: string; name: string }[]; keys: Key[][]; crew: Sailor[]; teamSlots: { key: string; label: string }[]; last: { at: string; what: string; error: string | null } | null }

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

const keyBg = (k: Key) => (k.onAir ? 'bg-red-700 text-white ring-2 ring-red-400' : k.active ? 'bg-amber-600 text-white' : k.action.startsWith('team:') ? 'bg-[#1e3a5f] text-ink-50' : k.action.startsWith('place:') ? 'bg-[#27303f] text-ink-50' : 'bg-zinc-700 text-ink-50');

export function LowerThirdsPage() {
  const q = useQuery({ queryKey: ['lt'], queryFn: () => api.get<LtData>('/api/lt'), refetchInterval: 4000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  return <LowerThirds data={q.data!} />;
}

function LowerThirds({ data }: { data: LtData }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['lt'] });
  const press = async (k: Key) => {
    setBusy(`${k.page}/${k.row}/${k.col}`);
    try { await api.post(`/api/lt/key/${k.page}/${k.row}/${k.col}`); } catch (e) { toast.error(e); } finally { setBusy(''); refresh(); }
  };
  const team = data.teams.find((t) => t.id === data.state.teamId);
  const st = data.state;
  const showing = st.kind === 'team' ? `${team?.code ?? ''} team` : st.kind === 'sailor' ? (() => { const s = data.crew.find((x) => x.slot === st.slot); return s ? `${s.firstName} ${s.lastName.toUpperCase()} · ${s.label}` : ''; })() : '';
  return (
    <div className="space-y-3">
      <Panel title="Lower thirds" right={<>
        <span className={cx('rounded px-2 py-1 text-xs font-bold', st.onAir ? 'bg-red-700 text-white' : 'bg-ink-800 text-ink-400')}>{st.onAir ? `ON AIR · ${showing}` : 'Off air'}</span>
        {st.onAir && st.input && <span className="text-xs text-ink-500">{st.input}</span>}
      </>}>
        {data.last && (
          <div className={cx('mb-3 rounded px-3 py-2 text-sm', data.last.error ? 'bg-red-950/60 text-red-200' : 'bg-ink-900 text-ink-400')}>
            Last key press ({new Date(data.last.at).toLocaleTimeString()}, {decodeURIComponent(data.last.what)}): {data.last.error ?? 'OK'}
          </div>
        )}
        <p className="mb-3 text-sm text-ink-400">
          The same keys as on the Stream Deck. A country picks the team, a place shows whoever sails there in today's line-up, NEXT RESULT changes only the line under the name
          (position → best results), OUT takes the graphic off. When the lower third is on air, changes only swap the data, so the title's change animations play.
        </p>
        {data.keys.map((page, i) => (
          <div key={i} className="mb-3">
            {data.keys.length > 1 && <div className="mb-1 text-xs text-ink-500">Companion page {data.config.companionPage + i}</div>}
            <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${data.config.cols}, minmax(0, 6rem))` }}>
              {Array.from({ length: data.config.rows * data.config.cols }, (_, n) => {
                const row = Math.floor(n / data.config.cols), col = n % data.config.cols;
                const k = page.find((x) => x.row === row && x.col === col);
                if (!k) return <div key={n} className="aspect-square rounded-lg border border-dashed border-ink-800" />;
                const id = `${k.page}/${k.row}/${k.col}`;
                return (
                  <button key={n} onClick={() => press(k)} disabled={!!busy} title={k.action}
                    className={cx('aspect-square whitespace-pre-line rounded-lg px-1 text-center text-xs font-bold leading-tight shadow transition hover:brightness-125 disabled:opacity-70', !k.bg && keyBg(k), k.onAir && 'ring-2 ring-white/80', busy === id && 'animate-pulse')} style={k.bg ? { background: k.bg, color: k.fg } : undefined}>
                    {(k.label ?? k.text).replace(/\\n/g, '\n')}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </Panel>

      {team && <Crew team={team} crew={data.crew} />}
      <Settings data={data} onSaved={refresh} />
      <CompanionHelp config={data.config} pages={data.keys.length} />
    </div>
  );
}

function Crew({ team, crew }: { team: { code: string; name: string }; crew: Sailor[] }) {
  return (
    <Panel title={`${team.code} · today's line-up`}>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-500"><th className="py-1">Place</th><th>Top text</th><th>Bottom text, then best results</th><th>Photo</th></tr></thead>
        <tbody>
          {crew.map((s) => (
            <tr key={s.slot} className="border-t border-ink-850">
              <td className="py-1 font-semibold text-ink-300">{s.label}</td>
              <td className="text-ink-50">{[s.firstName, s.lastName.toUpperCase()].filter(Boolean).join(' ') || <span className="text-ink-600">—</span>}</td>
              <td className="text-xs text-ink-300">{[[s.number, s.position.toUpperCase()].filter(Boolean).join('  I  '), ...s.best].filter(Boolean).join('  →  ')}</td>
              <td className="text-xs">{s.photo ? <span className="text-emerald-400">yes</span> : <span className="text-ink-500">no (title without photo)</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function Settings({ data, onSaved }: { data: LtData; onSaved: () => void }) {
  const toast = useToast();
  const [c, setC] = useState(data.config);
  useEffect(() => setC(data.config), [data.config]);
  const dirty = JSON.stringify(c) !== JSON.stringify(data.config);
  const save = async () => { try { await api.put('/api/lt/config', c); toast.ok('Saved'); onSaved(); } catch (e) { toast.error(e); } };
  const labels = async () => { try { const r = await api.post<{ sent: number }>('/api/lt/labels'); toast.ok(`Companion: ${r.sent} keys updated`); } catch (e) { toast.error(e); } };
  const text = (label: string, value: string, set: (v: string) => void, ph = '', w = 'w-48') => (
    <label className="block text-xs text-ink-400">{label}<input className={cx('input mt-1 py-1 text-sm', w)} value={value} placeholder={ph} onChange={(e) => set(e.target.value)} /></label>
  );
  const num = (label: string, value: number, set: (v: number) => void, min: number, max: number) => (
    <label className="block text-xs text-ink-400">{label}<input type="number" className="input mt-1 w-20 py-1 text-sm" value={value} min={min} max={max} onChange={(e) => set(Number(e.target.value) || min)} /></label>
  );
  const slot = (label: string, value: string, set: (v: string) => void) => (
    <label className="block text-xs text-ink-400">{label}
      <select className="input mt-1 w-48 py-1 text-sm" value={value} onChange={(e) => set(e.target.value)}>{data.teamSlots.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
    </label>
  );
  const field = (k: keyof Fields, label: string) => text(label, c.fields[k], (v) => setC({ ...c, fields: { ...c.fields, [k]: v } }), '', 'w-32');
  return (
    <Panel title="Settings" right={<>
      {c.companionUrl && <Button size="sm" variant="ghost" onClick={labels}>Send key labels to Companion</Button>}
      <Button size="sm" variant="primary" disabled={!dirty} onClick={save}>Save</Button>
    </>}>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-2">
          <h3 className="text-xs font-bold uppercase text-ink-300">vMix</h3>
          {text('Lower third with photo (input name or number)', c.photoInput, (v) => setC({ ...c, photoInput: v }), 'lowerthird_photo', 'w-64')}
          {text('Lower third without photo (teams, sailors without photo)', c.noPhotoInput, (v) => setC({ ...c, noPhotoInput: v }), 'lowerthird_no_photo', 'w-64')}
          {num('Overlay channel', c.overlay, (v) => setC({ ...c, overlay: v }), 1, 4)}
          <label className="flex items-center gap-2 text-sm text-ink-300"><input type="checkbox" checked={c.countryShowsTeam} onChange={(e) => setC({ ...c, countryShowsTeam: e.target.checked })} className="h-4 w-4 accent-sky-500" />A country key also shows the team lower third</label>
        </div>
        <div className="space-y-2">
          <h3 className="text-xs font-bold uppercase text-ink-300">Graphics and title fields</h3>
          {slot('Bar', c.barSlot, (v) => setC({ ...c, barSlot: v }))}
          {slot('Flag', c.flagSlot, (v) => setC({ ...c, flagSlot: v }))}
          {slot('Emblem', c.emblemSlot, (v) => setC({ ...c, emblemSlot: v }))}
          <div className="flex flex-wrap gap-2">{field('top', 'Name field')}{field('bottom', 'Line field')}{field('photo', 'Photo field')}{field('flag', 'Flag field')}{field('emblem', 'Emblem field')}{field('bar', 'Bar field')}</div>
        </div>
        <div className="space-y-2">
          <h3 className="text-xs font-bold uppercase text-ink-300">Stream Deck (Companion)</h3>
          {text('Companion address (for key labels)', c.companionUrl, (v) => setC({ ...c, companionUrl: v }), 'http://127.0.0.1:8000', 'w-64')}
          <div className="flex gap-3">{num('First page', c.companionPage, (v) => setC({ ...c, companionPage: v }), 1, 99)}{num('Rows', c.rows, (v) => setC({ ...c, rows: v }), 1, 8)}{num('Columns', c.cols, (v) => setC({ ...c, cols: v }), 1, 8)}</div>
          <p className="text-xs text-ink-500">Stream Deck XL: 4 rows × 8 columns. Stream Deck MK.2: 3 × 5 (the keys then run over several pages).</p>
        </div>
      </div>
    </Panel>
  );
}

function CompanionHelp({ config, pages }: { config: Config; pages: number }) {
  const toast = useToast();
  const origin = window.location.origin;
  const keyUrl = `${origin}/api/lt/key/$(this:page)/$(this:row)/$(this:column)`;
  const copy = (s: string) => { void navigator.clipboard?.writeText(s).then(() => toast.ok('Copied')); };
  const url = (s: string) => (
    <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded bg-ink-950 px-2 py-1 text-xs text-ink-200">{s}</code><Button size="sm" variant="ghost" onClick={() => copy(s)}>Copy</Button></div>
  );
  return (
    <Panel title="Setting up Companion">
      <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-300">
        <li>
          Download the Companion file for each page and import it in Companion (<b>Import / Export → Import</b>, pick the file, choose the page to put it on).
          Each file brings a <b>Generic HTTP</b> connection and every key with its action; on the second file, map that connection to the one you already have.
          <div className="mt-2 flex flex-wrap gap-2">
            {Array.from({ length: pages }, (_, i) => (
              <a key={i} className="rounded bg-ink-800 px-3 py-1.5 text-xs font-semibold text-ink-100 hover:bg-ink-700" href={`/api/lt/companion/${i + 1}?base=${encodeURIComponent(origin)}`} download>
                Page {config.companionPage + i} (.companionconfig)
              </a>
            ))}
          </div>
          <details className="mt-2 text-ink-400">
            <summary className="cursor-pointer">Or set the keys up by hand</summary>
            <p className="mt-1">Add the connection Generic HTTP, make one key with the action <b>GET</b> and this URL, then copy it onto every key of {pages > 1 ? `pages ${config.companionPage}–${config.companionPage + pages - 1}` : 'the page'} (Companion fills in each key's own page, row and column):</p>
            {url(keyUrl)}
          </details>
        </li>
        <li>In Companion Settings → Protocols turn on <b>HTTP remote control</b>, and type Companion's address above. The dashboard then writes each key's text and colour itself: country codes, places with today's names, the selected country in orange and what is on air in red.</li>
        <li>In vMix add the two lower third GTZIPs as inputs (names as above) and turn on Settings → Web Controller.</li>
      </ol>
      <details className="mt-3 text-sm text-ink-400">
        <summary className="cursor-pointer">Direct URLs (for other buttons or tests)</summary>
        <div className="mt-2 space-y-1">
          {url(`${origin}/api/lt/pick?team=BRA`)}{url(`${origin}/api/lt/team?team=BRA`)}{url(`${origin}/api/lt/sailor?team=BRA&place=Pit`)}{url(`${origin}/api/lt/next`)}{url(`${origin}/api/lt/out`)}
        </div>
      </details>
    </Panel>
  );
}
