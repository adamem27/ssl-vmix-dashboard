import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The DRAW stage screen, 1536×1024 (the LED wall): the header picture on top, the draw pool on the left, groups A–D on the right
 * (strips as wide as the L-bar's), the centre animating each step: a team drawn, then its group, then the team flying
 * into its place. Styled as the matchboard: its background, boxes, flags with codes, General Sans and the teams'
 * gradients. A vMix Browser input opens /draw/output; it reads /api/draw/output a few times a second.
 */
interface OutTeam { id: string; code: string; name: string; flag: string | null; gradient: string }
interface Pick { teamId: string; group: string; place: number }
interface Out {
  seq: number; fonts: number[]; caption: string; flightDelay: number; groups: string[]; groupSize: number;
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
    const st = stage.current, from = centreFlag.current, to = slots.current.get(key)?.querySelector('.dr-row-flag') as HTMLElement | null;
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


  if (!data) return <div style={{ width: '100vw', height: '100vh', background: '#0b5ea8' }} />;

  const teams = new Map(data.teams.map((t) => [t.id, t]));
  const picked = new Map(data.picks.map((p) => [p.teamId, p]));
  const inGroup = (g: string) => data.picks.filter((p) => p.group === g);
  const cur = data.current ? teams.get(data.current.teamId) ?? null : null;
  const done = data.teams.length > 0 && data.picks.length >= data.teams.length;
  const mode: 'overview' | 'team' | 'group' | 'idle' = data.overview || (done && !data.current) ? 'overview' : cur ? (data.current!.group ? 'group' : 'team') : 'idle';
  const rowH = Math.min(44, Math.floor((H - HEADER_H - 16 - 44 - 12 - 24) / Math.max(data.teams.length, 1)));
  // the uploaded General Sans weights (Graphics → matchboard fonts); a General Sans installed on the vMix PC comes first
  const fontCss = data.fonts.map((w) => `@font-face { font-family: 'DrawGS'; font-weight: ${w}; font-display: block; src: url('/api/matchboard/fonts/general-sans-${w}'); }`).join('\n');

  return (
    <div className="dr-root">
      <style>{fontCss + CSS}</style>
      <div ref={stage} className="dr-stage" style={{ transform: `scale(${scale})` }}>
        <div className="dr-bg" />
        <img className="dr-header" src={`/api/draw/output/header.png?v=${data.seq}`} alt="" />

        {/* left: the pool */}
        <aside className="dr-strip dr-left">
          <div className="dr-pill">Teams</div>
          <div className="dr-panel">
            <div className="dr-box dr-pool">
              {data.teams.map((t) => {
                const p = picked.get(t.id);
                const isCur = data.current?.teamId === t.id && !data.current.group;
                return (
                  <div key={t.id} className={`dr-row dr-pool-row${p ? ' is-done' : ''}${isCur ? ' is-current' : ''}`} style={{ height: rowH, ...(isCur ? { background: t.gradient } : {}) }}>
                    <Flag team={t} className="dr-row-flag" />
                    <span className="dr-row-code">{t.code}</span>
                    {p && <span className="dr-tag">{p.group}</span>}
                  </div>
                );
              })}
              {data.teams.length === 0 && <div className="dr-empty-note">Add the teams to the draw pool in the dashboard (DRAW).</div>}
            </div>
          </div>
        </aside>

        {/* right: the groups */}
        <aside className="dr-strip dr-right">
          <div className="dr-pill">Groups</div>
          <div className="dr-panel dr-groups">
            {data.groups.map((g) => (
              <div key={g} className={`dr-box dr-group${data.current?.group === g && mode !== 'overview' ? ' is-target' : ''}`}>
                <div className="dr-box-label">GROUP {g}</div>
                {Array.from({ length: data.groupSize }, (_, i) => {
                  const key = `${g}${i + 1}`;
                  const p = inGroup(g).find((x) => x.place === i + 1);
                  const t = p && flying !== key ? teams.get(p.teamId) : undefined;
                  const fresh = !!t && data.current?.teamId === t.id && data.current.group === g;
                  return (
                    <div key={key} ref={(el) => { if (el) slots.current.set(key, el); }} className={`dr-row dr-slot${t ? ' is-filled' : ''}${landed === key ? ' is-landed' : ''}`}
                      style={fresh ? { background: t!.gradient } : undefined}>
                      {t ? <><Flag team={t} className="dr-row-flag" /><span className="dr-row-code">{t.code}</span></>
                        : <><span className="dr-row-flag dr-flag-slot" /><span className="dr-slot-place">{key}</span></>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </aside>

        {/* centre */}
        <main className="dr-centre">
          {mode === 'idle' && (
            <div key={`idle${data.seq}`} className="dr-idle">
              <div className="dr-pill dr-pill-big">{data.caption}</div>
              <div className="dr-idle-big">{data.picks.length === 0 ? 'The Draw' : 'Next team'}</div>
              <div className="dr-idle-count"><b>{data.picks.length}</b> / {data.teams.length} teams drawn</div>
            </div>
          )}
          {(mode === 'team' || mode === 'group') && cur && (
            <div key={`t${cur.id}`} className={`dr-reveal${mode === 'group' ? ' has-group' : ''}`}>
              <div className="dr-card">
                <div className="dr-pill dr-kicker">Team drawn</div>
                <div className="dr-card-body" style={{ background: cur.gradient }}>
                  <div ref={centreFlag} className="dr-big-flag"><Flag team={cur} /></div>
                  <div className="dr-big-code">{cur.code}</div>
                  <div className="dr-big-name">{cur.name}</div>
                </div>
              </div>
              {mode === 'group' && (
                <div key={`g${data.current!.group}`} className="dr-group-reveal">
                  <div className="dr-arrow">›</div>
                  <div className="dr-box dr-group-badge">
                    <div className="dr-box-label">GROUP</div>
                    <div className="dr-group-badge-l">{data.current!.group}</div>
                  </div>
                </div>
              )}
              {mode === 'team' && <div className="dr-waiting">Drawing the group…</div>}
            </div>
          )}
          {mode === 'overview' && (
            <div key={`o${data.seq}`} className="dr-overview">
              {data.groups.map((g, gi) => (
                <div key={g} className="dr-box dr-ov-col" style={{ animationDelay: `${gi * 120}ms` }}>
                  <div className="dr-box-label">GROUP {g}</div>
                  {Array.from({ length: data.groupSize }, (_, i) => {
                    const p = inGroup(g).find((x) => x.place === i + 1);
                    const t = p ? teams.get(p.teamId) : undefined;
                    return (
                      <div key={i} className={`dr-row dr-ov-row${t ? '' : ' is-empty'}`}>
                        {t ? <><Flag team={t} className="dr-row-flag" /><span className="dr-row-code">{t.code}</span><span className="dr-ov-name">{t.name}</span></>
                          : <span className="dr-slot-place">{g}{i + 1}</span>}
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

const PANEL_TOP = HEADER_H + 14;
const CSS = `
@font-face { font-family: 'DrawGrotesk'; font-weight: 700; src: url('/api/matchboard/fonts/space-grotesk'); }
html, body, #root { margin: 0; height: 100%; background: #0b5ea8; overflow: hidden; }
.dr-root { width: 100vw; height: 100vh; overflow: hidden; background: #0b5ea8; }
.dr-stage { position: relative; width: ${W}px; height: ${H}px; transform-origin: 0 0; overflow: hidden; color: #fff;
  font-family: 'General Sans', 'DrawGS', 'DrawGrotesk', 'Segoe UI', system-ui, sans-serif; font-weight: 600; }
/* the matchboard's background: deep blue bottom left, cyan, green, lime top right */
.dr-bg { position: absolute; inset: 0; background:
  linear-gradient(115deg, transparent 0 55%, rgba(255,255,255,.05) 55% 61%, transparent 61% 100%),
  linear-gradient(28deg, #2c3e93 0%, #1867bb 20%, #0aa9df 42%, #0bbde6 52%, #3cc39a 70%, #86c540 86%, #c6d500 100%); }
.dr-header { position: absolute; left: 0; top: 0; width: ${W}px; height: ${HEADER_H}px; object-fit: cover; z-index: 5; box-shadow: 0 6px 24px rgba(0,0,0,.3); }

/* the matchboard's white title bars with cut ends */
.dr-pill { height: 36px; display: flex; align-items: center; justify-content: center; color: #475569; font-size: 20px; font-weight: 600;
  background: linear-gradient(90deg, #d3deed 0%, #f4f8fc 40%, #ffffff 50%, #f4f8fc 60%, #d3deed 100%);
  clip-path: polygon(10px 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 10px 100%, 0 50%); box-shadow: 0 2px 6px rgba(0,0,0,.15); }
.dr-panel { border: 1.5px solid rgba(255,255,255,.75); border-radius: 22px; padding: 10px 9px; }
.dr-box { background: linear-gradient(180deg, rgba(9,70,150,.42), rgba(9,70,150,.28)); border-radius: 12px; box-shadow: 0 6px 18px rgba(0,30,80,.18); }
.dr-box-label { height: 30px; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 600; letter-spacing: .02em; position: relative; }
.dr-box-label::after { content: ''; position: absolute; left: 12%; right: 12%; bottom: 2px; height: 1.5px; background: linear-gradient(90deg, transparent, rgba(255,255,255,.85), transparent); }
.dr-row { display: flex; align-items: center; gap: 12px; padding: 0 12px; border-radius: 7px; position: relative; }
.dr-row-flag { width: 33px; height: 22px; flex: none; }
.dr-row-code { font-size: 22px; font-weight: 600; letter-spacing: .01em; }
.dr-flag { display: block; object-fit: cover; border-radius: 3px; box-shadow: 0 0 0 .6px rgba(216,225,239,.9); }
.dr-flag-none { display: grid; place-items: center; background: #33415f; color: #fff; font-weight: 700; font-size: 10px; }
.dr-flag-slot { border-radius: 3px; border: 1.3px dashed rgba(255,255,255,.45); }
.dr-slot-place { flex: 1; text-align: center; font-size: 18px; font-weight: 500; color: rgba(255,255,255,.85); margin-left: -45px; }
/* the 1ST / 2ND tags of the matchboard, here the group a team went to */
.dr-tag { margin-left: auto; height: 22px; min-width: 30px; padding: 0 10px 0 7px; display: grid; place-items: center; background: #0d4ea8; color: #fff; font-size: 15px; font-weight: 600;
  clip-path: polygon(0 0, calc(100% - 7px) 0, 100% 50%, calc(100% - 7px) 100%, 0 100%); }

.dr-strip { position: absolute; top: ${PANEL_TOP}px; width: ${STRIP_W - 20}px; height: ${H - PANEL_TOP - 12}px; z-index: 3; display: flex; flex-direction: column; gap: 10px; }
.dr-left { left: 10px; }
.dr-right { right: 10px; }
.dr-strip .dr-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dr-pool { flex: 1; padding: 6px 4px; display: flex; flex-direction: column; justify-content: space-evenly; }
.dr-pool-row { transition: opacity .6s; }
.dr-pool-row.is-done { opacity: .42; }
.dr-pool-row.is-current { box-shadow: 0 0 0 2px rgba(255,255,255,.9), 0 6px 18px rgba(0,0,0,.3); animation: dr-pulse 1.4s ease-in-out infinite; }
.dr-empty-note { padding: 18px 8px; font-size: 15px; font-weight: 500; }

.dr-groups { justify-content: space-between; gap: 6px; }
.dr-group { padding: 1px 4px 5px; transition: box-shadow .4s; }
.dr-group.is-target { box-shadow: 0 0 0 2px rgba(255,255,255,.95), 0 0 24px rgba(255,255,255,.35); }
.dr-slot { height: 31px; }
.dr-slot .dr-row-flag { width: 30px; height: 20px; }
.dr-slot .dr-row-code { font-size: 20px; }
.dr-slot.is-landed { animation: dr-land 1.3s ease-out; }

.dr-centre { position: absolute; left: ${STRIP_W}px; top: ${HEADER_H}px; width: ${W - 2 * STRIP_W}px; height: ${H - HEADER_H}px; overflow: hidden; display: grid; place-items: center; }

.dr-idle { text-align: center; animation: dr-fade-up .8s ease-out both; display: flex; flex-direction: column; align-items: center; }
.dr-pill-big { height: 46px; font-size: 24px; padding: 0 46px; }
.dr-idle-big { font-size: 132px; font-weight: 600; line-height: 1; margin: 26px 0 18px; text-shadow: 0 8px 30px rgba(0,30,80,.35); }
.dr-idle-count { font-size: 28px; font-weight: 500; }
.dr-idle-count b { font-size: 38px; font-weight: 600; }

.dr-reveal { position: relative; display: flex; align-items: center; justify-content: center; gap: 22px; width: 100%; }
.dr-card { display: flex; flex-direction: column; align-items: center; gap: 16px; transition: transform .7s cubic-bezier(.5,0,.2,1); }
.dr-reveal.has-group .dr-card { transform: translateX(-10px) scale(.84); }
.dr-kicker { padding: 0 40px; font-size: 22px; animation: dr-fade-up .5s ease-out both; }
.dr-card-body { width: 520px; padding: 34px 30px 30px; border-radius: 26px; display: flex; flex-direction: column; align-items: center;
  box-shadow: 0 0 0 2px rgba(255,255,255,.85), 0 24px 60px rgba(0,30,80,.45); animation: dr-pop .8s cubic-bezier(.3,1.3,.5,1) both .1s; }
.dr-big-flag { width: 300px; height: 200px; perspective: 900px; animation: dr-flip 1s cubic-bezier(.3,1.4,.5,1) both .35s; }
.dr-big-flag .dr-flag { width: 100%; height: 100%; border-radius: 14px; box-shadow: 0 0 0 3px rgba(255,255,255,.95), 0 14px 34px rgba(0,0,0,.35); }
.dr-big-flag .dr-flag-none { font-size: 70px; }
.dr-big-code { margin-top: 20px; font-size: 104px; font-weight: 600; line-height: 1; text-shadow: 0 4px 18px rgba(0,0,0,.35); animation: dr-fade-up .6s ease-out both .7s; }
.dr-big-name { margin-top: 8px; font-size: 34px; font-weight: 500; text-align: center; text-shadow: 0 2px 10px rgba(0,0,0,.35); animation: dr-fade-up .6s ease-out both .85s; }
.dr-waiting { position: absolute; bottom: -62px; font-size: 22px; font-weight: 500; animation: dr-blink 1.4s ease-in-out infinite 1.2s; opacity: 0; }

.dr-group-reveal { display: flex; align-items: center; gap: 14px; }
.dr-arrow { font-size: 120px; font-weight: 500; line-height: 1; margin-top: -14px; animation: dr-slide-in .5s ease-out both; }
.dr-group-badge { width: 260px; padding: 10px 0 18px; border-radius: 22px; box-shadow: 0 0 0 2px rgba(255,255,255,.85), 0 20px 50px rgba(0,30,80,.4); animation: dr-pop .8s cubic-bezier(.3,1.6,.5,1) both .2s; }
.dr-group-badge .dr-box-label { height: 44px; font-size: 26px; }
.dr-group-badge-l { text-align: center; font-size: 200px; font-weight: 600; line-height: 1; margin-top: 8px; }

.dr-overview { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; width: calc(100% - 44px); }
.dr-ov-col { padding: 6px 6px 10px; animation: dr-fade-up .6s ease-out both; }
.dr-ov-col .dr-box-label { height: 48px; font-size: 22px; margin-bottom: 6px; }
.dr-ov-row { height: 64px; flex-wrap: wrap; align-content: center; column-gap: 10px; row-gap: 0; }
.dr-ov-row .dr-row-flag { width: 36px; height: 24px; }
.dr-ov-row .dr-row-code { font-size: 24px; }
.dr-ov-name { width: 100%; font-size: 14px; font-weight: 500; opacity: .85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dr-ov-row.is-empty .dr-slot-place { margin-left: 0; }

.dr-ghost { position: absolute; z-index: 10; transform-origin: 0 0; pointer-events: none; }
.dr-ghost .dr-flag { width: 100%; height: 100%; border-radius: 14px; }

@keyframes dr-fade-up { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: none; } }
@keyframes dr-flip { from { opacity: 0; transform: rotateY(90deg) scale(.6); } to { opacity: 1; transform: none; } }
@keyframes dr-pop { from { opacity: 0; transform: scale(.4); } to { opacity: 1; transform: none; } }
@keyframes dr-slide-in { from { opacity: 0; transform: translateX(-30px); } to { opacity: 1; transform: none; } }
@keyframes dr-blink { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }
@keyframes dr-pulse { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.18); } }
@keyframes dr-land { 0% { transform: scale(1.1); box-shadow: 0 0 0 3px #fff, 0 0 30px rgba(255,255,255,.8); } 100% { transform: none; box-shadow: none; } }
`;
