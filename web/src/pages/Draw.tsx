import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Badge, Button, cx, ErrorBox, Field, Loading, useConfirm, useToast } from '../components/ui';
import { FoldTitle, useFold } from '../components/fold';

interface DrawTeam { id: string; code: string; name: string; flag: string | null }
interface DrawPick { teamId: string; group: string; place: number }
interface DrawView {
  config: { caption: string; pool: string[]; companionPage: number; flightDelay: number; stripWidth: number };
  state: { picks: DrawPick[]; current: { teamId: string; group: string | null } | null; overview: boolean; seq: number };
  teams: DrawTeam[]; pool: DrawTeam[]; board: { letter: string; slots: { teamId: string | null; text: string; draw: boolean }[] }[]; next: string | null; input: string;
  companion: { at: string; sent: number; error: string | null } | null;
}

/** DRAW: the official draw of the 1/32 Finals on the stage screen (vMix Browser input) and its Stream Deck page. */
export function DrawPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['draw'], queryFn: () => api.get<DrawView>('/api/draw'), refetchInterval: 1500 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['draw'] });
  const run = useMutation({ mutationFn: (a: string) => api.post(`/api/draw/do?a=${encodeURIComponent(a)}`), onSuccess: refresh, onError: toast.error });
  const save = useMutation({ mutationFn: (p: Partial<DrawView['config']>) => api.put('/api/draw/config', p), onSuccess: refresh, onError: toast.error });

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const st = d.state;
  const byId = new Map(d.teams.map((t) => [t.id, t]));
  const picked = new Map(st.picks.map((p) => [p.teamId, p]));
  const cur = st.current ? byId.get(st.current.teamId) : undefined;
  const count = (g: string) => st.picks.filter((p) => p.group === g).length;

  return (
    <div className="mx-auto flex max-w-[1800px] flex-col gap-4 px-4 py-4 lg:px-6">
      {confirm.dialog}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold text-ink-50">Draw</h1>
        <Badge tone="neutral">{st.picks.length} / {d.pool.length} teams drawn</Badge>
        {cur && <Badge tone="warn">{`${cur.code} → Group ${st.current!.group}`}</Badge>}
        {d.next && <Badge tone="neutral">Next team goes to Group {d.next}</Badge>}
        <span className="text-xs text-ink-500">Not tested on a real vMix or Companion yet.</span>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        {/* live control */}
        <section className="flex flex-col gap-4">
          <Preview seq={st.seq} />
          <div className="rounded-lg border border-ink-800 bg-ink-900/60 p-4">
            <div className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">
              {d.next ? `Press the team drawn: it goes to Group ${d.next} (the group with the fewest teams)` : 'Every group is full'}
            </div>
            <div className="grid grid-cols-4 gap-2">
              {d.pool.map((t, i) => {
                const p = picked.get(t.id);
                const isCur = st.current?.teamId === t.id;
                return (
                  <button key={t.id} disabled={!!p || !d.next || run.isPending} onClick={() => run.mutate(`team:${i + 1}`)} title={t.name}
                    className={cx('flex items-center gap-2 rounded-md border px-2 py-2 text-left text-sm font-semibold transition-colors',
                      isCur ? 'border-amber-400 bg-amber-500/25 text-amber-100' : p ? 'border-ink-800 bg-ink-900 text-ink-500' : 'border-ink-700 bg-ink-800 text-ink-100 hover:bg-ink-700')}>
                    {t.flag ? <img src={t.flag} alt="" className="h-5 w-7 shrink-0 rounded-sm object-cover" /> : <span className="h-5 w-7 shrink-0 rounded-sm bg-ink-700" />}
                    <span className="truncate">{t.code}</span>
                    {p && <span className="ml-auto rounded bg-ink-700 px-1.5 text-xs text-ink-300">{p.group}</span>}
                  </button>
                );
              })}
              {d.pool.length === 0 && <div className="col-span-4 text-sm text-ink-400">The pool is empty. Add the teams in “Draw pool” on the right.</div>}
            </div>
            <div className="mt-3 text-xs text-ink-500">Correction only: move {cur ? cur.code : 'the team just drawn'} to another group.</div>
            <div className="mt-1 grid grid-cols-4 gap-2">
              {d.board.map(({ letter: g, slots }) => {
                const n = count(g), cap = slots.filter((x) => x.draw).length;
                const canMove = !!st.current && st.current.group !== g && n < cap;
                return (
                  <button key={g} disabled={!canMove || run.isPending} onClick={() => run.mutate(`group:${g}`)}
                    className={cx('rounded-md border px-3 py-3 text-base font-bold transition-colors disabled:cursor-not-allowed',
                      st.current?.group === g ? 'border-amber-400 bg-amber-500/25 text-amber-100'
                        : canMove ? 'border-teal-600 bg-teal-800/60 text-white hover:bg-teal-700' : 'border-ink-800 bg-ink-900 text-ink-500')}>
                    GROUP {g} <span className="text-xs font-medium opacity-70">{n}/{cap}{d.next === g ? ' · next' : ''}</span>
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => run.mutate('undo')} disabled={!st.current && !st.picks.length}>Undo</Button>
              <Button onClick={() => run.mutate('clear')} disabled={!st.current}>Clear centre</Button>
              <Button onClick={() => run.mutate('overview')} variant={st.overview ? 'primary' : 'secondary'}>All groups in the centre{st.overview ? ' (on)' : ''}</Button>
              <Button variant="danger" className="ml-auto" onClick={async () => { if (await confirm.ask('Reset the draw?', 'Every team leaves its group and the screen starts again. The pool stays.', 'Reset')) run.mutate('reset'); }}>Reset draw</Button>
            </div>
          </div>
          <Groups d={d} byId={byId} />
        </section>

        {/* setup */}
        <section className="flex flex-col gap-4">
          <PoolEditor d={d} save={(pool) => save.mutate({ pool })} busy={save.isPending} />
          <Texts d={d} save={(p) => save.mutate(p)} />
          <HeaderPicture seq={st.seq} stripWidth={d.config.stripWidth} onChange={refresh} />
          <VmixInput input={d.input} />
          <Companion d={d} save={(p) => save.mutate(p)} />
        </section>
      </div>
    </div>
  );
}

/** The output page, scaled into the column. */
function Preview({ seq }: { seq: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth)); ro.observe(el); return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className="relative w-full overflow-hidden rounded-lg border border-ink-800 bg-black" style={{ height: (w * 1024) / 1536 }} data-seq={seq}>
      <iframe src="/draw/output" title="Draw output" style={{ width: 1536, height: 1024, transform: `scale(${w / 1536})`, transformOrigin: '0 0', border: 0 }} />
    </div>
  );
}

function Groups({ d, byId }: { d: DrawView; byId: Map<string, DrawTeam> }) {
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {d.board.map(({ letter: g, slots }) => (
        <div key={g} className="rounded-lg border border-ink-800 bg-ink-900/60 p-3">
          <div className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-400">Group {g} · R1 {g}</div>
          {slots.map((row, i) => {
            const p = d.state.picks.find((x) => x.group === g && x.place === i + 1);
            const t = row.teamId ? byId.get(row.teamId) : p && byId.get(p.teamId);
            return <div key={i} className={cx('py-0.5 text-sm', t ? (row.draw ? 'text-amber-200' : 'text-ink-100') : 'text-ink-600')}>{g}{i + 1} · {t ? `${t.code} ${t.name}` : row.text}{!row.draw && <span className="ml-1 text-xs text-ink-500">(matchboard)</span>}</div>;
          })}
        </div>
      ))}
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  const [open, setOpen] = useFold(`draw:${id}`);
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900/60 p-4">
      <FoldTitle open={open} onToggle={() => setOpen(!open)}>{title}</FoldTitle>
      {open && <div className="mt-3">{children}</div>}
    </div>
  );
}

function PoolEditor({ d, save, busy }: { d: DrawView; save: (pool: string[]) => void; busy: boolean }) {
  const toast = useToast();
  const [add, setAdd] = useState('');
  const pool = d.config.pool;
  const byId = new Map(d.teams.map((t) => [t.id, t]));
  const free = d.teams.filter((t) => !pool.includes(t.id));
  const move = (i: number, dir: -1 | 1) => { const p = [...pool]; const j = i + dir; if (j < 0 || j >= p.length) return; [p[i], p[j]] = [p[j], p[i]]; save(p); };
  const fillQualified = async () => {
    try {
      const { teamIds } = await api.get<{ teamIds: string[] }>('/api/draw/qualified');
      if (!teamIds.length) { toast.info('No starred teams in the Qualifying Series on the matchboard yet.'); return; }
      save(teamIds.slice(0, 16));
    } catch (e) { toast.error(e); }
  };
  return (
    <Section id="pool" title={`Draw pool (${pool.length}/16)`}>
      <p className="mb-2 text-xs text-ink-400">The left strip of the screen, in this order. Key n on the Stream Deck is team n here.</p>
      <ol className="mb-3 flex flex-col gap-1">
        {pool.map((id, i) => {
          const t = byId.get(id);
          return (
            <li key={id} className="flex items-center gap-2 rounded bg-ink-850 px-2 py-1 text-sm">
              <span className="w-5 text-right text-xs text-ink-500">{i + 1}</span>
              {t?.flag ? <img src={t.flag} alt="" className="h-4 w-6 rounded-sm object-cover" /> : <span className="h-4 w-6 rounded-sm bg-ink-700" />}
              <span className="font-semibold text-ink-100">{t?.code}</span>
              <span className="truncate text-ink-400">{t?.name}</span>
              <span className="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0 || busy} aria-label="Up">▲</Button>
                <Button size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === pool.length - 1 || busy} aria-label="Down">▼</Button>
                <Button size="sm" variant="ghost" onClick={() => save(pool.filter((x) => x !== id))} disabled={busy} aria-label="Remove">✕</Button>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <select value={add} onChange={(e) => setAdd(e.target.value)} className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5 text-sm text-ink-100">
          <option value="">Add a team…</option>
          {free.map((t) => <option key={t.id} value={t.id}>{t.code} · {t.name}</option>)}
        </select>
        <Button size="sm" disabled={!add || pool.length >= 16 || busy} onClick={() => { save([...pool, add]); setAdd(''); }}>Add</Button>
        <Button size="sm" onClick={fillQualified} disabled={busy} title="Teams starred in the Qualifying Series on the matchboard">Take ★ from matchboard</Button>
        <Button size="sm" onClick={() => save([...pool].sort((a, b) => (byId.get(a)?.name ?? '').localeCompare(byId.get(b)?.name ?? '')))} disabled={busy}>Sort A–Z</Button>
        <Button size="sm" variant="ghost" onClick={() => save([])} disabled={!pool.length || busy}>Empty</Button>
      </div>
    </Section>
  );
}

function Texts({ d, save }: { d: DrawView; save: (p: Partial<DrawView['config']>) => void }) {
  const [caption, setCaption] = useState(d.config.caption);
  const [delay, setDelay] = useState(String(d.config.flightDelay));
  const [strip, setStrip] = useState(String(d.config.stripWidth));
  return (
    <Section id="texts" title="Screen texts, layout and timing">
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem_10rem]">
        <Field label="Caption in the centre (before a team is drawn)">
          <input value={caption} onChange={(e) => setCaption(e.target.value)} onBlur={() => caption !== d.config.caption && save({ caption })}
            className="w-full rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5 text-sm text-ink-100" />
        </Field>
        <Field label="Seconds the flag waves before it flies to its group">
          <input type="number" min={0} max={10} step={0.1} value={delay} onChange={(e) => setDelay(e.target.value)} onBlur={() => Number(delay) !== d.config.flightDelay && save({ flightDelay: Number(delay) || 0 })}
            className="w-full rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5 text-sm text-ink-100" />
        </Field>
        <Field label="Side strip width (px of 1536)">
          <input type="number" min={160} max={420} step={10} value={strip} onChange={(e) => setStrip(e.target.value)} onBlur={() => Number(strip) !== d.config.stripWidth && save({ stripWidth: Math.min(420, Math.max(160, Math.round(Number(strip)) || 300)) })}
            className="w-full rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5 text-sm text-ink-100" />
        </Field>
      </div>
    </Section>
  );
}

function HeaderPicture({ seq, stripWidth, onChange }: { seq: number; stripWidth: number; onChange: () => void }) {
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const up = async (f: File) => { try { await api.upload('/api/draw/header', f); toast.ok('Header changed.'); onChange(); } catch (e) { toast.error(e); } };
  return (
    <Section id="header" title="Header picture">
      <img src={`/api/draw/output/header.png?v=${seq}`} alt="Header" className="mb-2 w-full rounded border border-ink-800" />
      <p className="mb-2 text-xs text-ink-400">PNG, placed between the two strips: {1536 - 2 * stripWidth} px wide at the current strip width, its height follows the picture (at most 260 px). Best exported at that width.</p>
      <input ref={file} type="file" accept="image/png" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void up(f); e.target.value = ''; }} />
      <div className="flex gap-2">
        <Button size="sm" onClick={() => file.current?.click()}>Upload PNG…</Button>
        <Button size="sm" variant="ghost" onClick={async () => { try { await api.del('/api/draw/header'); onChange(); } catch (e) { toast.error(e); } }}>Back to the default</Button>
      </div>
    </Section>
  );
}

function VmixInput({ input }: { input: string }) {
  const toast = useToast();
  const [url, setUrl] = useState(`${window.location.origin}/draw/output`);
  const add = useMutation({
    mutationFn: () => api.post<{ added: boolean; renamed?: boolean }>('/api/draw/vmix-input', { url }),
    onSuccess: (r) => toast.ok(r.added ? `Added the Browser input ${input} in vMix.` : `${input} already there: it now opens this address.`),
    onError: toast.error,
  });
  return (
    <Section id="vmix" title="vMix input">
      <p className="mb-2 text-xs text-ink-400">
        A <b>Web Browser</b> input named <code>{input}</code>, 1536×1024 (the LED wall), opening the address below. The address must be one the vMix computer can open
        (this dashboard's address on the venue network, or the online one). The page needs no login.
      </p>
      <div className="flex gap-2">
        <input value={url} onChange={(e) => setUrl(e.target.value)} className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5 font-mono text-xs text-ink-100" />
        <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(url); toast.ok('Copied.'); }}>Copy</Button>
        <a className="inline-flex items-center rounded-md px-2.5 py-1 text-xs text-ink-300 hover:bg-ink-800" href="/draw/output" target="_blank" rel="noreferrer">Open</a>
      </div>
      <Button className="mt-2" size="sm" variant="primary" busy={add.isPending} onClick={() => add.mutate()}>Add / update {input} in vMix</Button>
    </Section>
  );
}

function Companion({ d, save }: { d: DrawView; save: (p: Partial<DrawView['config']>) => void }) {
  const toast = useToast();
  const [page, setPage] = useState(String(d.config.companionPage));
  const href = `/api/draw/companion.companionconfig?base=${encodeURIComponent(window.location.origin)}`;
  return (
    <Section id="companion" title="Stream Deck (Companion)">
      <p className="mb-2 text-xs text-ink-400">
        One page, <b>SSL DRAW</b>: the 16 pool teams in rows 1–2 (key n = team n of the pool), GROUP A–D, ALL GROUPS, CLEAR CENTRE and UNDO in row 3,
        DECK 1 HOME in row 4. Import it in Companion as a single page (Import → page) onto the page number below. Reset is only here, not on the deck.
        Key texts follow the draw live when Companion's address is set in Show control.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Companion page"><input type="number" min={1} max={99} value={page} onChange={(e) => setPage(e.target.value)} onBlur={() => Number(page) !== d.config.companionPage && save({ companionPage: Number(page) || 30 })}
          className="w-24 rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5 text-sm text-ink-100" /></Field>
        <a href={href} className="inline-flex items-center rounded-md bg-accent-500 px-3 py-2 text-sm font-medium text-white hover:bg-accent-600">Download the DRAW page</a>
        <Button size="sm" onClick={async () => { try { const r = await api.post<{ sent: number; error: string | null } | null>('/api/draw/labels'); if (!r) toast.info('Set the Companion address in Show control first.'); else if (r.error) toast.error(r.error); else toast.ok(`Sent ${r.sent} keys.`); } catch (e) { toast.error(e); } }}>Push key texts now</Button>
      </div>
      {d.companion?.error && <p className="mt-2 text-xs text-red-300">{d.companion.error}</p>}
    </Section>
  );
}
