import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The DRAW stage screen, 1536×1024 (the LED wall): the header picture on top, the draw pool on the left, groups A–D on the right
 * (strips as wide as the L-bar's), the centre animating each step: the team drawn as a big waving flag with its name,
 * then the flag flying into its place (the group with the fewest teams, chosen by the server). All groups: the strips
 * fade out and the groups spread over the whole width. Styled as the matchboard: its background, boxes, flags with codes, General Sans and the teams'
 * gradients. A vMix Browser input opens /draw/output; it reads /api/draw/output a few times a second.
 */
interface OutTeam { id: string; code: string; name: string; flag: string | null; gradient: string }
interface Pick { teamId: string; group: string; place: number }
interface Out {
  seq: number; fonts: number[]; caption: string; flightDelay: number; stripWidth?: number; board: { letter: string; slots: { teamId: string | null; text: string; draw: boolean }[] }[]; pool: string[];
  teams: OutTeam[]; picks: Pick[]; current: { teamId: string; group: string | null } | null; overview: boolean; next?: string | null;
}

// the LED wall at Marina da Glória: 6 × 4 m, 1536×1024 px; strips as wide as the L-bar's (272 of 1920 → 218 of 1536)
// the strips run the full height; the header picture sits between them, its height following the picture (at most HEADER_MAX)
const W = 1536, H = 1024, HEADER_MAX = 260;
const FLIGHT_MS = 950;

export function DrawOutputPage() {
  const [data, setData] = useState<Out | null>(null);
  const [scale, setScale] = useState(1);
  /** the place a team is flying to: shown empty until it lands */
  const [flying, setFlying] = useState<string | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  /** the team shown in the centre (a waving flag) until its flag flies off; leaving: the flag is on its way */
  const [shown, setShown] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
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
    const p = data.picks[data.picks.length - 1];
    const was = before?.picks[before.picks.length - 1];
    if (!before || data.picks.length < before.picks.length || (before.current && !data.current)) { stopAll(); setShown(null); return; }
    if (data.picks.length === before.picks.length) {
      // a correction (the team just drawn moved to another group): it goes there without a second flight
      if (p && was && p.teamId === was.teamId && (p.group !== was.group || p.place !== was.place)) setFlying((f) => (f ? `${p.group}${p.place}` : f));
      return;
    }
    const key = `${p.group}${p.place}`;
    stopAll();
    setFlying(key); setLanded(null); setShown(p.teamId); setLeaving(false);
    timers.current.push(window.setTimeout(() => fly(p.teamId), Math.max(data.flightDelay, 1.2) * 1000));
  }, [data]);

  const stopAll = () => { timers.current.forEach(clearTimeout); timers.current = []; stage.current?.querySelectorAll('.dr-ghost').forEach((g) => g.remove()); setFlying(null); setLanded(null); setLeaving(false); };

  const fly = (teamId: string) => {
    // the place may have changed since (a correction): read it now
    const d = prev.current, p = d?.picks.find((x) => x.teamId === teamId);
    const key = p ? `${p.group}${p.place}` : '';
    const st = stage.current, from = centreFlag.current, to = slots.current.get(key)?.querySelector('.dr-row-flag') as HTMLElement | null;
    const land = () => {
      setFlying(null); setLanded(key); setShown(null); setLeaving(false);
      timers.current.push(window.setTimeout(() => setLanded(null), 1400));
    };
    if (!st || !from || !to || !p) { land(); return; }
    setFlying(key);
    const s = st.getBoundingClientRect(), k = s.width / W;
    const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
    const team = d!.teams.find((t) => t.id === teamId);
    const ghost = document.createElement('div');
    ghost.className = 'dr-ghost';
    ghost.innerHTML = team?.flag ? `<img class="dr-flag" src="${team.flag}" alt="" />` : `<span class="dr-flag dr-flag-none">${team?.code ?? ''}</span>`;
    setLeaving(true);
    Object.assign(ghost.style, { left: `${(a.left - s.left) / k}px`, top: `${(a.top - s.top) / k}px`, width: `${a.width / k}px`, height: `${a.height / k}px` });
    st.appendChild(ghost);
    const dx = (b.left - a.left) / k, dy = (b.top - a.top) / k, sx = b.width / a.width, sy = b.height / a.height;
    const anim = ghost.animate([
      { transform: 'translate(0,0) scale(1,1)', opacity: 1 },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 140}px) scale(${(1 + sx) / 2.4}, ${(1 + sy) / 2.4})`, opacity: 1, offset: 0.5 },
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 1 },
    ], { duration: FLIGHT_MS, easing: 'cubic-bezier(.6,0,.3,1)', fill: 'forwards' });
    anim.onfinish = () => { ghost.remove(); land(); };
  };


  if (!data) return <div style={{ width: '100vw', height: '100vh', background: '#0b5ea8' }} />;

  const teams = new Map(data.teams.map((t) => [t.id, t]));
  const picked = new Map(data.picks.map((p) => [p.teamId, p]));
  const inGroup = (g: string) => data.picks.filter((p) => p.group === g);
  const cur = shown ? teams.get(shown) ?? null : null;
  const pool = data.pool.map((id) => teams.get(id)).filter((t): t is OutTeam => !!t);
  const done = pool.length > 0 && data.picks.length >= pool.length;
  const mode: 'overview' | 'reveal' | 'idle' = data.overview || (done && !cur) ? 'overview' : cur ? 'reveal' : 'idle';
  // the list stays in the upper part of the left strip: the host stands in front of its lower part
  const rowH = Math.min(50, Math.floor((H - 24 - 46 - 40) / Math.max(pool.length, 1) - 6));
  // the uploaded General Sans weights (Graphics → matchboard fonts); a General Sans installed on the vMix PC comes first
  const fontCss = data.fonts.map((w) => `@font-face { font-family: 'DrawGS'; font-weight: ${w}; font-display: block; src: url('/api/matchboard/fonts/general-sans-${w}'); }`).join('\n');

  return (
    <div className="dr-root">
      <style>{fontCss + css(data.stripWidth ?? 300)}</style>
      <div ref={stage} className={`dr-stage${mode === 'overview' ? ' is-overview' : ''}`} style={{ transform: `scale(${scale})` }}>
        <div className="dr-bg" />

        {/* left: the pool */}
        <aside className="dr-strip dr-left">
          <div className="dr-pill">Teams</div>
          <div className="dr-panel">
            <div className="dr-box dr-pool">
              {pool.map((t) => {
                const p = picked.get(t.id);
                const isCur = shown === t.id;
                return (
                  <div key={t.id} className={`dr-row dr-pool-row${p ? ' is-done' : ''}${isCur ? ' is-current' : ''}`} style={{ height: rowH, ...(isCur ? { background: t.gradient } : {}) }}>
                    <Flag team={t} className="dr-row-flag" />
                    <span className="dr-row-code">{t.code}</span>
                    {p && <span className="dr-tag">{p.group}</span>}
                  </div>
                );
              })}
              {pool.length === 0 && <div className="dr-empty-note">Add the teams to the draw pool in the dashboard (DRAW).</div>}
            </div>
          </div>
        </aside>

        {/* right: the groups */}
        <aside className="dr-strip dr-right">
          <div className="dr-pill">Groups</div>
          <div className="dr-panel dr-groups">
            {data.board.map(({ letter: g, slots: rows }) => (
              <div key={g} className={`dr-box dr-group${cur && data.current?.teamId === cur.id && data.current.group === g ? ' is-target' : ''}`}>
                <div className="dr-box-label">GROUP {g}</div>
                {rows.map((row, i) => {
                  const key = `${g}${i + 1}`;
                  const p = inGroup(g).find((x) => x.place === i + 1);
                  const t = row.teamId ? teams.get(row.teamId) : p && flying !== key ? teams.get(p.teamId) : undefined;
                  const fresh = !!t && data.current?.teamId === t.id && data.current.group === g;
                  return (
                    <div key={key} ref={(el) => { if (el) slots.current.set(key, el); }} className={`dr-row dr-slot${t ? ' is-filled' : ''}${landed === key ? ' is-landed' : ''}`}
                      style={fresh ? { background: t!.gradient } : undefined}>
                      {t ? <><Flag team={t} className="dr-row-flag" /><span className="dr-row-code">{t.code}</span></>
                        : <><span className="dr-row-flag dr-flag-slot" /><span className="dr-slot-place">{row.text}</span></>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </aside>

        {/* centre */}
        <div className="dr-mid">
        <img className="dr-header" src={`/api/draw/output/header.png?v=${data.seq}`} alt="" />
        <main className="dr-centre">
          {mode === 'idle' && (
            <div key={`idle${data.seq}`} className="dr-idle">
              <div className="dr-pill dr-pill-big">{data.caption}</div>
              <div className="dr-idle-big">{data.picks.length === 0 ? 'The Draw' : 'Next team'}</div>
              <div className="dr-idle-count"><b>{data.picks.length}</b> / {pool.length} teams drawn</div>
            </div>
          )}
          {mode === 'reveal' && cur && (
            <div key={`t${cur.id}`} className={`dr-reveal${leaving ? ' is-leaving' : ''}`}>
              <div ref={centreFlag} className="dr-wave-box">
                {cur.flag ? <WavingFlag src={cur.flag} /> : <Flag team={cur} className="dr-wave-none" />}
              </div>
              <div className="dr-reveal-name">{cur.name}</div>
            </div>
          )}
          {mode === 'overview' && (
            <div key={`o${data.seq}`} className="dr-overview">
              {data.board.map(({ letter: g, slots: rows }, gi) => (
                <div key={g} className="dr-box dr-ov-col" style={{ animationDelay: `${gi * 120}ms` }}>
                  <div className="dr-box-label">GROUP {g}</div>
                  {rows.map((row, i) => {
                    const p = inGroup(g).find((x) => x.place === i + 1);
                    const t = row.teamId ? teams.get(row.teamId) : p ? teams.get(p.teamId) : undefined;
                    return (
                      <div key={i} className={`dr-row dr-ov-row${t ? '' : ' is-empty'}`}>
                        {t ? <><Flag team={t} className="dr-row-flag" /><span className="dr-row-code">{t.code}</span><span className="dr-ov-name">{t.name}</span></>
                          : <span className="dr-slot-place">{row.text}</span>}
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
    </div>
  );
}

/** A flag waving in the wind: thin vertical slices of the picture, each rising and falling a little after the one before. */
const WAVE_W = 640, WAVE_H = 427, SLICES = 80;
function WavingFlag({ src }: { src: string }) {
  const sw = WAVE_W / SLICES;
  return (
    <div className="dr-wave" style={{ width: WAVE_W, height: WAVE_H }}>
      {Array.from({ length: SLICES }, (_, i) => (
        <div key={i} className="dr-wave-slice" style={{
          left: i * sw, width: sw + 1.2, backgroundImage: `url(${src})`, backgroundSize: `${WAVE_W}px ${WAVE_H}px`, backgroundPosition: `${-i * sw}px 0`,
          animationDelay: `${(-i * 0.033).toFixed(3)}s`, ['--a' as string]: `${(3 + (18 * i) / SLICES).toFixed(1)}px`,
        }} />
      ))}
    </div>
  );
}

function Flag({ team, className = '' }: { team: OutTeam; className?: string }) {
  return team.flag
    ? <img className={`dr-flag ${className}`} src={team.flag} alt="" />
    : <span className={`dr-flag dr-flag-none ${className}`}>{team.code}</span>;
}

const PANEL_TOP = 12;
/** The page's styles for side strips this wide (DRAW → Screen texts and layout). */
const css = (STRIP_W: number) => `
@font-face { font-family: 'DrawGrotesk'; font-weight: 700; src: url('/api/matchboard/fonts/space-grotesk'); }
html, body, #root { margin: 0; height: 100%; background: #0b5ea8; overflow: hidden; }
.dr-root { width: 100vw; height: 100vh; overflow: hidden; background: #0b5ea8; }
.dr-stage { position: relative; width: ${W}px; height: ${H}px; transform-origin: 0 0; overflow: hidden; color: #fff;
  font-family: 'General Sans', 'DrawGS', 'DrawGrotesk', 'Segoe UI', system-ui, sans-serif; font-weight: 600; }
/* the matchboard's background: deep blue bottom left, cyan, green, lime top right */
.dr-bg { position: absolute; inset: 0; background:
  linear-gradient(115deg, transparent 0 55%, rgba(255,255,255,.05) 55% 61%, transparent 61% 100%),
  linear-gradient(28deg, #2c3e93 0%, #1867bb 20%, #0aa9df 42%, #0bbde6 52%, #3cc39a 70%, #86c540 86%, #c6d500 100%); }
.dr-mid { position: absolute; left: ${STRIP_W}px; top: 0; width: ${W - 2 * STRIP_W}px; height: ${H}px; display: flex; flex-direction: column; }
.dr-header { display: block; width: ${W - 2 * STRIP_W}px; align-self: center; height: auto; max-height: ${HEADER_MAX}px; object-fit: cover; flex: none; position: relative; z-index: 5; box-shadow: 0 6px 24px rgba(0,0,0,.3); }

/* the matchboard's white title bars with cut ends */
.dr-pill { height: 40px; display: flex; align-items: center; justify-content: center; color: #475569; font-size: 24px; font-weight: 600;
  background: linear-gradient(90deg, #d3deed 0%, #f4f8fc 40%, #ffffff 50%, #f4f8fc 60%, #d3deed 100%);
  clip-path: polygon(10px 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 10px 100%, 0 50%); box-shadow: 0 2px 6px rgba(0,0,0,.15); }
.dr-panel { border: 1.5px solid rgba(255,255,255,.75); border-radius: 22px; padding: 8px 6px; }
.dr-box { background: linear-gradient(180deg, rgba(9,70,150,.42), rgba(9,70,150,.28)); border-radius: 12px; box-shadow: 0 6px 18px rgba(0,30,80,.18); }
.dr-box-label { height: 34px; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 600; letter-spacing: .02em; position: relative; }
.dr-box-label::after { content: ''; position: absolute; left: 12%; right: 12%; bottom: 2px; height: 1.5px; background: linear-gradient(90deg, transparent, rgba(255,255,255,.85), transparent); }
.dr-row { display: flex; align-items: center; gap: 10px; padding: 0 8px; border-radius: 7px; position: relative; }
.dr-row-flag { width: 54px; height: 36px; flex: none; }
.dr-row-code { font-size: 42px; font-weight: 600; letter-spacing: .01em; line-height: 1; }
.dr-flag { display: block; object-fit: cover; border-radius: 3px; box-shadow: 0 0 0 .6px rgba(216,225,239,.9); }
.dr-flag-none { display: grid; place-items: center; background: #33415f; color: #fff; font-weight: 700; font-size: 10px; }
.dr-flag-slot { position: absolute; left: 12px; visibility: hidden; }
/* an empty place reads as on the matchboard: its text (DRAW 1…) centred */
.dr-slot-place { flex: 1; text-align: center; font-size: 30px; font-weight: 500; color: #fff; }
/* the 1ST / 2ND tags of the matchboard, here the group a team went to */
.dr-tag { margin-left: auto; flex: none; height: 34px; min-width: 36px; padding: 0 10px 0 6px; display: grid; place-items: center; background: #0d4ea8; color: #fff; font-size: 24px; font-weight: 600;
  clip-path: polygon(0 0, calc(100% - 7px) 0, 100% 50%, calc(100% - 7px) 100%, 0 100%); }

.dr-strip { position: absolute; top: ${PANEL_TOP}px; width: ${STRIP_W - 20}px; height: ${H - PANEL_TOP - 12}px; z-index: 3; display: flex; flex-direction: column; gap: 10px; }
.dr-left { left: 10px; }
.dr-right { right: 10px; }
.dr-strip .dr-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dr-pool { flex: none; padding: 8px 2px; display: flex; flex-direction: column; gap: 6px; }
.dr-pool-row { transition: opacity .6s; gap: 14px; padding: 0 12px; }
.dr-pool-row .dr-row-flag { width: 54px; height: 36px; }
.dr-pool-row.is-done { opacity: .42; }
.dr-pool-row.is-current { box-shadow: 0 0 0 2px rgba(255,255,255,.9), 0 6px 18px rgba(0,0,0,.3); animation: dr-pulse 1.4s ease-in-out infinite; }
.dr-empty-note { padding: 18px 8px; font-size: 15px; font-weight: 500; }

.dr-groups { justify-content: space-between; gap: 10px; }
.dr-group { flex: 1; display: flex; flex-direction: column; justify-content: space-evenly; padding: 2px 4px 6px; transition: box-shadow .4s; }
.dr-group.is-target { box-shadow: 0 0 0 2px rgba(255,255,255,.95), 0 0 24px rgba(255,255,255,.35); }
.dr-slot { height: 46px; gap: 14px; padding: 0 14px; }
.dr-slot .dr-row-flag { width: 54px; height: 36px; }
.dr-slot .dr-row-code { font-size: 42px; }
.dr-slot.is-landed { animation: dr-land 1.3s ease-out; }

.dr-centre { position: relative; flex: 1; min-height: 0; overflow: hidden; display: grid; place-items: center; }

.dr-idle { text-align: center; animation: dr-fade-up .8s ease-out both; display: flex; flex-direction: column; align-items: center; }
.dr-pill-big { height: 46px; font-size: 24px; padding: 0 46px; }
.dr-idle-big { font-size: 132px; font-weight: 600; line-height: 1; margin: 26px 0 18px; text-shadow: 0 8px 30px rgba(0,30,80,.35); }
.dr-idle-count { font-size: 28px; font-weight: 500; }
.dr-idle-count b { font-size: 38px; font-weight: 600; }

.dr-reveal { display: flex; flex-direction: column; align-items: center; animation: dr-pop .9s cubic-bezier(.3,1.25,.5,1) both; }
.dr-wave-box { width: ${640}px; height: ${427}px; filter: drop-shadow(0 18px 30px rgba(0,20,60,.45)); transition: opacity .15s; }
.dr-wave { position: relative; }
.dr-wave-slice { position: absolute; top: 0; height: 100%; background-repeat: no-repeat; animation: dr-wave 2.2s ease-in-out infinite; }
.dr-wave-slice:first-child { border-radius: 8px 0 0 8px; }
.dr-wave-slice:last-child { border-radius: 0 8px 8px 0; }
.dr-wave-none { width: 100%; height: 100%; font-size: 120px; border-radius: 10px; }
.dr-reveal-name { margin-top: 40px; font-size: 96px; font-weight: 600; line-height: 1; text-align: center; letter-spacing: .01em; text-shadow: 0 6px 26px rgba(0,30,80,.45); animation: dr-fade-up .7s ease-out both .5s; max-width: 100%; }
.dr-reveal.is-leaving .dr-wave-box { opacity: 0; }
.dr-reveal.is-leaving .dr-reveal-name { opacity: 0; transform: translateY(20px); transition: opacity .6s .3s, transform .6s .3s; animation: none; }

.dr-overview { display: grid; grid-template-columns: repeat(4, 1fr); gap: 28px; width: calc(100% - 96px); }
.dr-ov-col { padding: 10px 14px 18px; animation: dr-fade-up .6s ease-out both .25s; }
.dr-ov-col .dr-box-label { height: 64px; font-size: 32px; margin-bottom: 10px; }
.dr-ov-row { height: 112px; flex-wrap: wrap; align-content: center; column-gap: 16px; row-gap: 4px; padding: 0 14px; }
.dr-ov-row .dr-row-flag { width: 72px; height: 48px; }
.dr-ov-row .dr-row-code { font-size: 54px; }
.dr-ov-row .dr-slot-place { font-size: 40px; }
.dr-ov-name { width: 100%; font-size: 22px; font-weight: 500; opacity: .9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* all groups: the strips fade away, the centre takes the whole width (the header stays as it is) */
.dr-strip { transition: opacity .7s ease; }
.dr-stage.is-overview .dr-strip { opacity: 0; }
.dr-mid { transition: left .7s cubic-bezier(.5,0,.2,1), width .7s cubic-bezier(.5,0,.2,1); }
.dr-stage.is-overview .dr-mid { left: 0; width: ${W}px; }

.dr-ghost { position: absolute; z-index: 10; transform-origin: 0 0; pointer-events: none; }
.dr-ghost .dr-flag { width: 100%; height: 100%; border-radius: 8px; box-shadow: none; }

@keyframes dr-wave { 0%, 100% { transform: translateY(calc(var(--a) * -1)); filter: brightness(1.08); } 50% { transform: translateY(var(--a)); filter: brightness(.88); } }
@keyframes dr-fade-up { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: none; } }
@keyframes dr-flip { from { opacity: 0; transform: rotateY(90deg) scale(.6); } to { opacity: 1; transform: none; } }
@keyframes dr-pop { from { opacity: 0; transform: scale(.4); } to { opacity: 1; transform: none; } }
@keyframes dr-slide-in { from { opacity: 0; transform: translateX(-30px); } to { opacity: 1; transform: none; } }
@keyframes dr-blink { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }
@keyframes dr-pulse { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.18); } }
@keyframes dr-land { 0% { transform: scale(1.1); box-shadow: 0 0 0 3px #fff, 0 0 30px rgba(255,255,255,.8); } 100% { transform: none; box-shadow: none; } }
`;
