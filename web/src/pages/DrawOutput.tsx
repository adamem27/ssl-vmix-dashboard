import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The DRAW stage screen, 1536×1024 (the LED wall): the header picture on top, the draw pool on the left, groups A–D on the right
 * (strips as wide as the L-bar's), the centre animating each step: a team drawn, then its group, then the team flying
 * into its place. A vMix Browser input opens /draw/output; it reads /api/draw/output a few times a second.
 */
interface OutTeam { id: string; code: string; name: string; flag: string | null }
interface Pick { teamId: string; group: string; place: number }
interface Out {
  seq: number; caption: string; flightDelay: number; groups: string[]; groupSize: number;
  teams: OutTeam[]; picks: Pick[]; current: { teamId: string; group: string | null } | null; overview: boolean;
}

// the LED wall at Marina da Glória: 6 × 4 m, 1536×1024 px; strips as wide as the L-bar's (272 of 1920 → 218 of 1536)
const W = 1536, H = 1024, HEADER_H = 239, STRIP_W = 218;
const FLIGHT_MS = 950;

export function DrawOutputPage() {
  const [data, setData] = useState<Out | null>(null);
  const [scale, setScale] = useState(1);
  /** the place a team is flying to: shown empty until it lands */
  const [flying, setFlying] = useState<string | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const prev = useRef<Out | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const centreFlag = useRef<HTMLDivElement>(null);
  const slots = useRef(new Map<string, HTMLDivElement>());
  const timers = useRef<number[]>([]);

  // poll the state; a new seq is a new step
  useEffect(() => {
    let stop = false, seq = -1;
    const tick = async () => {
      try {
        const r = await fetch(`/api/draw/output?t=${Date.now()}`, { cache: 'no-store' });
        if (r.ok) { const d: Out = await r.json(); if (d.seq !== seq) { seq = d.seq; setData(d); } }
      } catch { /* keep the last picture; retry */ }
      if (!stop) window.setTimeout(tick, 400);
    };
    void tick();
    return () => { stop = true; };
  }, []);

  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / W, window.innerHeight / H));
    fit(); window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // a new pick: wait in the centre, then fly the flag to its place
  useLayoutEffect(() => {
    if (!data) return;
    const before = prev.current;
    prev.current = data;
    if (!before || data.picks.length <= before.picks.length) { if (!before || data.picks.length < before.picks.length) { setFlying(null); setLanded(null); } return; }
    const p = data.picks[data.picks.length - 1];
    const key = `${p.group}${p.place}`;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setFlying(key); setLanded(null);
    timers.current.push(window.setTimeout(() => fly(key), data.flightDelay * 1000));
  }, [data]);

  const fly = (key: string) => {
    const st = stage.current, from = centreFlag.current, to = slots.current.get(key)?.querySelector('.dr-slot-flag') as HTMLElement | null;
    const land = () => { setFlying(null); setLanded(key); timers.current.push(window.setTimeout(() => setLanded(null), 1400)); };
    if (!st || !from || !to) { land(); return; }
    const s = st.getBoundingClientRect(), k = s.width / W;
    const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
    const ghost = from.cloneNode(true) as HTMLElement;
    ghost.className = 'dr-ghost';
    Object.assign(ghost.style, { left: `${(a.left - s.left) / k}px`, top: `${(a.top - s.top) / k}px`, width: `${a.width / k}px`, height: `${a.height / k}px` });
    st.appendChild(ghost);
    const dx = (b.left - a.left) / k, dy = (b.top - a.top) / k, sx = b.width / a.width, sy = b.height / a.height;
    const anim = ghost.animate([
      { transform: 'translate(0,0) scale(1,1)', opacity: 1 },
      { transform: `translate(${dx * 0.55}px, ${dy * 0.55 - 120}px) scale(${(1 + sx) / 2}, ${(1 + sy) / 2})`, opacity: 1, offset: 0.55 },
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 1 },
    ], { duration: FLIGHT_MS, easing: 'cubic-bezier(.6,0,.3,1)', fill: 'forwards' });
    anim.onfinish = () => { ghost.remove(); land(); };
  };

  if (!data) return <div style={{ width: '100vw', height: '100vh', background: '#0a1f4d' }} />;

  const teams = new Map(data.teams.map((t) => [t.id, t]));
  const picked = new Map(data.picks.map((p) => [p.teamId, p]));
  const inGroup = (g: string) => data.picks.filter((p) => p.group === g);
  const cur = data.current ? teams.get(data.current.teamId) ?? null : null;
  const done = data.teams.length > 0 && data.picks.length >= data.teams.length;
  const mode: 'overview' | 'team' | 'group' | 'idle' = data.overview || (done && !data.current) ? 'overview' : cur ? (data.current!.group ? 'group' : 'team') : 'idle';
  const rowH = Math.min(46, Math.floor((H - HEADER_H - 56 - 18) / Math.max(data.teams.length, 1)));

  return (
    <div className="dr-root">
      <style>{CSS}</style>
      <div ref={stage} className="dr-stage" style={{ transform: `scale(${scale})` }}>
        <img className="dr-header" src={`/api/draw/output/header.png?v=${data.seq}`} alt="" />

        {/* left: the pool */}
        <aside className="dr-strip dr-left">
          <div className="dr-strip-title">TEAMS</div>
          <div className="dr-pool">
            {data.teams.map((t) => {
              const p = picked.get(t.id);
              const isCur = data.current?.teamId === t.id && !data.current.group;
              return (
                <div key={t.id} className={`dr-pool-row${p ? ' is-done' : ''}${isCur ? ' is-current' : ''}`} style={{ height: rowH }}>
                  <Flag team={t} className="dr-pool-flag" />
                  <span className="dr-pool-name">{t.name}</span>
                  {p && <span className="dr-pool-group">{p.group}</span>}
                </div>
              );
            })}
            {data.teams.length === 0 && <div className="dr-empty-note">Add the teams to the draw pool in the dashboard (DRAW).</div>}
          </div>
        </aside>

        {/* right: the groups */}
        <aside className="dr-strip dr-right">
          <div className="dr-strip-title">GROUPS</div>
          <div className="dr-groups">
            {data.groups.map((g) => (
              <div key={g} className={`dr-group${data.current?.group === g ? ' is-target' : ''}`}>
                <div className="dr-group-head"><span className="dr-group-letter">{g}</span>GROUP {g}</div>
                {Array.from({ length: data.groupSize }, (_, i) => {
                  const key = `${g}${i + 1}`;
                  const p = inGroup(g).find((x) => x.place === i + 1);
                  const t = p && flying !== key ? teams.get(p.teamId) : undefined;
                  return (
                    <div key={key} ref={(el) => { if (el) slots.current.set(key, el); }} className={`dr-slot${t ? ' is-filled' : ''}${landed === key ? ' is-landed' : ''}`}>
                      <div className="dr-slot-flag">{t ? <Flag team={t} /> : null}</div>
                      <span className="dr-slot-name">{t ? t.name : ''}</span>
                      {!t && <span className="dr-slot-place">{key}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </aside>

        {/* centre */}
        <main className="dr-centre">
          <div className="dr-centre-bg" />
          {mode === 'idle' && (
            <div key={`idle${data.seq}`} className="dr-idle">
              <div className="dr-idle-kicker">{data.caption}</div>
              <div className="dr-idle-big">{data.picks.length === 0 ? 'THE DRAW' : 'NEXT TEAM'}</div>
              <div className="dr-idle-count"><b>{data.picks.length}</b> / {data.teams.length} TEAMS DRAWN</div>
            </div>
          )}
          {(mode === 'team' || mode === 'group') && cur && (
            <div key={`t${cur.id}`} className={`dr-reveal${mode === 'group' ? ' has-group' : ''}`}>
              <div className="dr-card">
                <div className="dr-kicker">TEAM DRAWN</div>
                <div ref={centreFlag} className="dr-big-flag"><Flag team={cur} /></div>
                <div className="dr-big-name">{cur.name}</div>
                <div className="dr-big-code">{cur.code}</div>
              </div>
              {mode === 'group' && (
                <div key={`g${data.current!.group}`} className="dr-group-reveal">
                  <div className="dr-arrow">➜</div>
                  <div className="dr-group-badge">
                    <span className="dr-group-badge-k">GROUP</span>
                    <span className="dr-group-badge-l">{data.current!.group}</span>
                  </div>
                </div>
              )}
              {mode === 'team' && <div className="dr-waiting">DRAWING THE GROUP…</div>}
            </div>
          )}
          {mode === 'overview' && (
            <div key={`o${data.seq}`} className="dr-overview">
              {data.groups.map((g, gi) => (
                <div key={g} className="dr-ov-col" style={{ animationDelay: `${gi * 120}ms` }}>
                  <div className="dr-ov-head">GROUP {g}</div>
                  {Array.from({ length: data.groupSize }, (_, i) => {
                    const p = inGroup(g).find((x) => x.place === i + 1);
                    const t = p ? teams.get(p.teamId) : undefined;
                    return (
                      <div key={i} className={`dr-ov-row${t ? '' : ' is-empty'}`}>
                        {t ? <><Flag team={t} className="dr-ov-flag" /><span>{t.name}</span></> : <span>{g}{i + 1}</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function Flag({ team, className = '' }: { team: OutTeam; className?: string }) {
  return team.flag
    ? <img className={`dr-flag ${className}`} src={team.flag} alt="" />
    : <span className={`dr-flag dr-flag-none ${className}`}>{team.code}</span>;
}

const CSS = `
@font-face { font-family: 'DrawSans'; font-weight: 400 900; font-display: block; src: url('/api/matchboard/fonts/general-sans-700'), url('/api/matchboard/fonts/space-grotesk'); }
html, body, #root { margin: 0; height: 100%; background: #0a1f4d; overflow: hidden; }
.dr-root { width: 100vw; height: 100vh; overflow: hidden; background: #0a1f4d; }
.dr-stage { position: relative; width: ${W}px; height: ${H}px; transform-origin: 0 0; overflow: hidden; font-family: 'DrawSans', 'Montserrat', 'Segoe UI', system-ui, sans-serif; color: #fff; background: #0a1f4d; }
.dr-header { position: absolute; left: 0; top: 0; width: ${W}px; height: ${HEADER_H}px; object-fit: cover; z-index: 5; box-shadow: 0 6px 24px rgba(0,0,0,.35); }

.dr-strip { position: absolute; top: ${HEADER_H}px; width: ${STRIP_W}px; height: ${H - HEADER_H}px; z-index: 3; background: linear-gradient(180deg, #102a6b 0%, #0c2154 100%); display: flex; flex-direction: column; }
.dr-left { left: 0; box-shadow: 6px 0 24px rgba(0,0,0,.3); }
.dr-right { right: 0; box-shadow: -6px 0 24px rgba(0,0,0,.3); }
.dr-strip::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 10px; background: linear-gradient(90deg, #e8792b, #f5b622); }
.dr-strip-title { height: 56px; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 22px; letter-spacing: .14em; color: #f5b622; background: linear-gradient(90deg, rgba(140,198,63,.25), rgba(140,198,63,0)); border-bottom: 3px solid #8cc63f; flex: none; }

.dr-pool { padding: 6px 10px 0; display: flex; flex-direction: column; }
.dr-pool-row { display: flex; align-items: center; gap: 10px; padding: 0 6px; border-radius: 8px; transition: opacity .6s, background .4s; }
.dr-pool-flag { width: 36px; height: 24px; flex: none; }
.dr-pool-name { flex: 1; min-width: 0; font-size: 16px; font-weight: 700; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dr-pool-group { flex: none; width: 24px; height: 24px; border-radius: 6px; background: #f5b622; color: #0c2154; font-weight: 900; font-size: 15px; display: grid; place-items: center; }
.dr-pool-row.is-done { opacity: .38; }
.dr-pool-row.is-done .dr-pool-name { text-decoration: line-through; text-decoration-thickness: 2px; }
.dr-pool-row.is-current { background: linear-gradient(90deg, #f5b622, #e8792b); color: #0c2154; animation: dr-pulse 1.2s ease-in-out infinite; }
.dr-empty-note { padding: 24px 6px; color: #9fb3dd; font-size: 16px; }

.dr-groups { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: space-evenly; padding: 2px 10px 14px; }
.dr-group { display: flex; flex-direction: column; gap: 3px; border-radius: 10px; padding: 3px 4px; transition: background .4s; }
.dr-group.is-target { background: rgba(245,182,34,.18); box-shadow: 0 0 0 2px #f5b622 inset; }
.dr-group-head { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 16px; letter-spacing: .1em; color: #cfe0ff; height: 28px; }
.dr-group-letter { width: 26px; height: 26px; border-radius: 6px; background: #8cc63f; color: #0c2154; display: grid; place-items: center; font-size: 18px; font-weight: 900; }
.dr-slot { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 6px; border-radius: 6px; background: rgba(255,255,255,.06); position: relative; }
.dr-slot-flag { width: 30px; height: 20px; flex: none; border-radius: 4px; border: 1.5px dashed rgba(255,255,255,.25); }
.dr-slot.is-filled .dr-slot-flag { border: 0; }
.dr-slot-flag .dr-flag { width: 100%; height: 100%; }
.dr-slot-name { font-size: 14px; font-weight: 700; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dr-slot-place { position: absolute; right: 8px; font-size: 12px; color: rgba(255,255,255,.3); font-weight: 700; }
.dr-slot.is-landed { animation: dr-land 1.3s ease-out; }

.dr-flag { display: block; object-fit: cover; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,.4); }
.dr-flag-none { display: grid; place-items: center; background: #33415f; color: #fff; font-weight: 800; font-size: 11px; }

.dr-centre { position: absolute; left: ${STRIP_W}px; top: ${HEADER_H}px; width: ${W - 2 * STRIP_W}px; height: ${H - HEADER_H}px; overflow: hidden; display: grid; place-items: center; }
.dr-centre-bg { position: absolute; inset: 0; background:
  linear-gradient(115deg, transparent 0 58%, rgba(255,255,255,.06) 58% 64%, transparent 64% 100%),
  linear-gradient(115deg, transparent 0 70%, rgba(255,255,255,.04) 70% 73%, transparent 73% 100%),
  radial-gradient(ellipse at 50% 45%, #1d63d0 0%, #0f3f99 45%, #0a2564 100%); }

.dr-idle { position: relative; text-align: center; animation: dr-fade-up .8s ease-out both; }
.dr-idle-kicker { font-size: 26px; font-weight: 700; letter-spacing: .2em; color: #f5b622; }
.dr-idle-big { font-size: 128px; font-weight: 900; line-height: 1; margin: 18px 0; letter-spacing: .02em; text-shadow: 0 8px 30px rgba(0,0,0,.35); }
.dr-idle-count { font-size: 26px; letter-spacing: .12em; color: #cfe0ff; }
.dr-idle-count b { color: #fff; font-size: 34px; }

.dr-reveal { position: relative; display: flex; align-items: center; justify-content: center; gap: 24px; width: 100%; }
.dr-card { display: flex; flex-direction: column; align-items: center; transition: transform .7s cubic-bezier(.5,0,.2,1); }
.dr-reveal.has-group .dr-card { transform: translateX(-20px) scale(.82); }
.dr-kicker { font-size: 22px; letter-spacing: .25em; font-weight: 700; color: #f5b622; animation: dr-fade-up .5s ease-out both; }
.dr-big-flag { width: 330px; height: 220px; margin: 18px 0 22px; perspective: 900px; animation: dr-flip 1s cubic-bezier(.3,1.4,.5,1) both .15s; }
.dr-big-flag .dr-flag { width: 100%; height: 100%; border-radius: 14px; box-shadow: 0 18px 50px rgba(0,0,0,.5), 0 0 0 4px rgba(255,255,255,.9); }
.dr-big-flag .dr-flag-none { font-size: 80px; }
.dr-big-name { font-size: 70px; font-weight: 900; line-height: 1; text-transform: uppercase; text-align: center; max-width: 640px; animation: dr-fade-up .6s ease-out both .55s; text-shadow: 0 6px 24px rgba(0,0,0,.35); }
.dr-big-code { margin-top: 8px; font-size: 28px; letter-spacing: .3em; color: #cfe0ff; font-weight: 700; animation: dr-fade-up .6s ease-out both .7s; }
.dr-waiting { position: absolute; bottom: -80px; font-size: 21px; letter-spacing: .2em; color: #cfe0ff; animation: dr-blink 1.4s ease-in-out infinite 1.2s; opacity: 0; }

.dr-group-reveal { display: flex; align-items: center; gap: 22px; }
.dr-arrow { font-size: 70px; color: #f5b622; animation: dr-slide-in .5s ease-out both; }
.dr-group-badge { width: 250px; height: 250px; border-radius: 28px; background: linear-gradient(145deg, #f5b622, #e8792b); color: #0c2154; display: flex; flex-direction: column; align-items: center; justify-content: center; box-shadow: 0 20px 60px rgba(0,0,0,.45); animation: dr-pop .8s cubic-bezier(.3,1.6,.5,1) both .2s; }
.dr-group-badge-k { font-size: 32px; font-weight: 800; letter-spacing: .25em; }
.dr-group-badge-l { font-size: 160px; font-weight: 900; line-height: .9; }

.dr-overview { position: relative; display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; width: calc(100% - 48px); }
.dr-ov-col { background: rgba(8,24,70,.55); border-radius: 14px; padding: 16px 12px; border-top: 6px solid #8cc63f; animation: dr-fade-up .6s ease-out both; }
.dr-ov-head { font-size: 26px; font-weight: 900; letter-spacing: .1em; color: #f5b622; text-align: center; margin-bottom: 14px; }
.dr-ov-row { display: flex; align-items: center; gap: 10px; height: 60px; font-size: 18px; font-weight: 800; text-transform: uppercase; border-top: 1px solid rgba(255,255,255,.12); white-space: nowrap; overflow: hidden; }
.dr-ov-row span { overflow: hidden; text-overflow: ellipsis; }
.dr-ov-row.is-empty { color: rgba(255,255,255,.3); }
.dr-ov-flag { width: 45px; height: 30px; flex: none; }

.dr-ghost { position: absolute; z-index: 10; transform-origin: 0 0; pointer-events: none; }
.dr-ghost .dr-flag { width: 100%; height: 100%; border-radius: 14px; }

@keyframes dr-fade-up { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: none; } }
@keyframes dr-flip { from { opacity: 0; transform: rotateY(90deg) scale(.6); } to { opacity: 1; transform: none; } }
@keyframes dr-pop { from { opacity: 0; transform: scale(.3) rotate(-8deg); } to { opacity: 1; transform: none; } }
@keyframes dr-slide-in { from { opacity: 0; transform: translateX(-40px); } to { opacity: 1; transform: none; } }
@keyframes dr-blink { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
@keyframes dr-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(245,182,34,.0); } 50% { box-shadow: 0 0 18px 2px rgba(245,182,34,.7); } }
@keyframes dr-land { 0% { background: #f5b622; transform: scale(1.08); } 100% { background: rgba(255,255,255,.06); transform: none; } }
`;
