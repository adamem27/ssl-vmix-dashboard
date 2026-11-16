import type { CSSProperties, ReactNode } from 'react';
import { RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The DRAW stage screen, 1536×1024 (the LED wall): the header picture on top, the draw pool on the left, groups A–D on the
 * right, styled as the matchboard (its background, boxes, flags with codes, General Sans and the teams' gradients).
 *
 * One team, step by step:
 *  1. the group the next team goes to slides from the right strip into the centre and grows to fill it
 *     (the operator decides when: “Group X to the centre”; drawing a team does it too if it was not done);
 *  2. the team drawn: its flag animation (a video, or a drawn waving flag) covers the group, the name in its lower part;
 *  3. the flag fades away: the team already stands in its row of the group;
 *  4. the group goes back to its place on the right.
 * All groups: the strips slide off to the sides, the header grows to the whole width, the groups line up in the centre.
 * A vMix Browser input opens /draw/output; it reads /api/draw/output a few times a second.
 */
interface OutTeam { id: string; code: string; name: string; flag: string | null; video?: string | null; gradient: string }
interface Pick { teamId: string; group: string; place: number }
type EmptyStyle = 'bars' | 'dots' | 'text';
interface Out {
  seq: number; fonts: number[]; caption: string; flightDelay: number; stripWidth?: number; emptyStyle?: EmptyStyle;
  board: { letter: string; slots: { teamId: string | null; text: string; draw: boolean }[] }[]; pool: string[];
  teams: OutTeam[]; picks: Pick[]; current: { teamId: string; group: string | null } | null; overview: boolean; focus?: string | null; flag?: boolean; autoSteps?: boolean; headerV?: number; next?: string | null;
}

// the LED wall at Marina da Glória: 6 × 4 m, 1536×1024 px
const W = 1536, H = 1024, HEADER_MAX = 260;
/** group in / out of the centre, flag fade, the team shown in its group before the group goes back (ms) */
const MOVE_MS = 800, FADE_MS = 700, HOLD_MS = 1800;
/** all groups going: they fade first, then the strips come back */
const OV_OUT_MS = 700;
/** the flag in the centre: 3:2, as wide as the centre allows */
const FLAG_RATIO = 2 / 3;
/** corner radius of the flags, as the static flag pictures have it (server: flagShape FLAG_RADIUS, of the height) */
const FLAG_RADIUS = 0.18;
/** the team's full name above the centre flag: its band and largest font size */
const NAME_BAND = 120;
const NAME_PX = 92;

interface Spot { letter: string; on: boolean; x: number; y: number; w: number; h: number; tx: number; ty: number; s: number }
interface FlagShow { teamId: string; out: boolean }

export function DrawOutputPage() {
  const [data, setData] = useState<Out | null>(null);
  const [scale, setScale] = useState(1);
  /** the group in the centre (a copy of its box, moved and enlarged from the strip) */
  const [spot, setSpot] = useState<Spot | null>(null);
  /** the flag covering the centre */
  const [flag, setFlag] = useState<FlagShow | null>(null);
  /** the place the new team goes to: empty until its flag fades */
  const [hidden, setHidden] = useState<string | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const prev = useRef<Out | null>(null);
  /** the all-groups view stays a moment after it is switched off, fading out */
  const [ovLeaving, setOvLeaving] = useState(false);
  const ovWas = useRef(false);
  const stage = useRef<HTMLDivElement>(null);
  const centre = useRef<HTMLElement>(null);
  // all groups: every flag at the same place, the codes and full names starting where the flags start; the widest
  // team (flag + code, or its name) sits in the middle of its row, the others line up with it
  const ovBox = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ovBox.current;
    if (!el) return;
    const fit = () => {
      const cells = [...el.querySelectorAll<HTMLElement>('.dr-ov-row:not(.is-empty) .dr-cell:not(.dr-out)')];
      if (!cells.length) return;
      // widths of the content itself, not of how it lies now: while the groups grow in, a narrow row wraps the code
      // and cuts the name short (…), so the name is measured with the font and the code by its own box
      const ctx = document.createElement('canvas').getContext('2d');
      let widest = 0;
      for (const c of cells) {
        const flag = c.querySelector<HTMLElement>('.dr-row-flag'), code = c.querySelector<HTMLElement>('.dr-row-code'), nm = c.querySelector<HTMLElement>('.dr-ov-name');
        if (flag && code) widest = Math.max(widest, flag.offsetWidth + (parseFloat(getComputedStyle(c).columnGap) || 0) + code.offsetWidth);
        if (nm && ctx) {
          const cs = getComputedStyle(nm);
          ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          const text = (nm.textContent ?? '').toUpperCase();
          widest = Math.max(widest, ctx.measureText(text).width + (parseFloat(cs.letterSpacing) || 0) * text.length);
        }
      }
      // half the widest team: the padding is worked out by CSS from the row's width at every moment, so it stays
      // right while the groups grow into place (the centre widens as the strips go)
      const half = `${Math.ceil(widest / 2)}px`;
      if (el.style.getPropertyValue('--ov-half') !== half) el.style.setProperty('--ov-half', half);
    };
    fit();
    void document.fonts?.ready.then(fit);
  });
  const groupEls = useRef(new Map<string, HTMLDivElement>());
  const timers = useRef<number[]>([]);
  const busy = useRef(false);
  /** manual steps: the flag on the screen until the operator's FLAG OFF */
  const pending = useRef<{ teamId: string; key: string } | null>(null);
  const spotRef = useRef<Spot | null>(null);
  spotRef.current = spot;

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

  const later = (ms: number, f: () => void) => new Promise<void>((resolve) => { timers.current.push(window.setTimeout(() => { f(); resolve(); }, ms)); });
  const stopAll = () => { timers.current.forEach(clearTimeout); timers.current = []; busy.current = false; pending.current = null; fadeFlag(); setHidden(null); setLanded(null); };
  /** the flag never just vanishes: it fades */
  const fadeFlag = () => {
    setFlag((f) => (f && !f.out ? { ...f, out: true } : f));
    timers.current.push(window.setTimeout(() => setFlag((f) => (f && f.out ? null : f)), FADE_MS));
  };

  /** FLAG OFF: the flag fades, the team stands in its row (the group stays where it is). */
  const reveal = () => {
    const pd = pending.current;
    if (!pd) return;
    pending.current = null;
    // once the waving flag is gone: the row's highlight and the team's flag and code fade in together
    setFlag({ teamId: pd.teamId, out: true });
    timers.current.push(window.setTimeout(() => { setFlag((f) => (f && f.out ? null : f)); setHidden((h) => (h === pd.key ? null : h)); setLanded(pd.key); }, FADE_MS));
  };

  /** The centre's box for the group: as big as fits inside the flag's area. */
  const measure = (letter: string): Spot | null => {
    const st = stage.current, el = groupEls.current.get(letter), c = centre.current;
    if (!st || !el || !c) return null;
    const s0 = st.getBoundingClientRect(), k = s0.width / W;
    const a = el.getBoundingClientRect(), b = c.getBoundingClientRect();
    const x = (a.left - s0.left) / k, y = (a.top - s0.top) / k, w = a.width / k, h = a.height / k;
    const cx = (b.left - s0.left) / k, cy = (b.top - s0.top) / k, cw = b.width / k, ch = b.height / k;
    const fw = Math.min(cw - 24, (ch - 24) / FLAG_RATIO), fh = fw * FLAG_RATIO;
    const s = Math.min((fw - 120) / w, (fh - 40) / h);
    return { letter, on: false, x, y, w, h, s, tx: cx + cw / 2 - (x + (w * s) / 2), ty: cy + ch / 2 - (y + (h * s) / 2) };
  };
  const bringIn = (letter: string) => new Promise<void>((resolve) => {
    if (spotRef.current?.letter === letter && spotRef.current.on) { resolve(); return; }
    const m = measure(letter);
    if (!m) { resolve(); return; }
    setSpot(m);
    requestAnimationFrame(() => requestAnimationFrame(() => { setSpot((sp) => (sp && sp.letter === letter ? { ...sp, on: true } : sp)); timers.current.push(window.setTimeout(resolve, MOVE_MS)); }));
  });
  const sendBack = () => new Promise<void>((resolve) => {
    setLanded(null); // the team's highlight fades while its group goes back
    if (!spotRef.current) { resolve(); return; }
    setSpot((sp) => (sp ? { ...sp, on: false } : sp));
    timers.current.push(window.setTimeout(() => { setSpot(null); resolve(); }, MOVE_MS));
  });

  useLayoutEffect(() => {
    if (!data) return;
    const before = prev.current;
    prev.current = data;
    const p = data.picks[data.picks.length - 1];
    const fresh = !!before && data.picks.length > before.picks.length && !!p;
    if (!before) return;
    if (data.overview) { stopAll(); void sendBack(); return; }
    if (data.picks.length < before.picks.length || (before.current && !data.current)) { stopAll(); if (!data.focus) void sendBack(); else void bringIn(data.focus); return; }
    if (fresh) {
      stopAll();
      busy.current = true;
      const key = `${p.group}${p.place}`;
      setHidden(key);
      void (async () => {
        await bringIn(p.group);
        if (!data.autoSteps) {
          // manual: the flag stays until FLAG OFF, the group until GROUP BACK
          busy.current = false;
          pending.current = { teamId: p.teamId, key };
          if (prev.current?.flag) setFlag({ teamId: p.teamId, out: false });
          else { reveal(); if (!prev.current?.focus) void sendBack(); }
          return;
        }
        setFlag({ teamId: p.teamId, out: false });
        await later(Math.max(1, data.flightDelay) * 1000, () => setFlag({ teamId: p.teamId, out: true }));
        await later(FADE_MS, () => { setFlag((f) => (f && f.out ? null : f)); setHidden(null); setLanded(key); });
        await later(HOLD_MS, () => {});
        busy.current = false;
        const now = prev.current;
        if (now?.focus && now.focus !== p.group) { await sendBack(); await bringIn(now.focus); }
        else if (!now?.focus) await sendBack();
        setLanded(null);
      })();
      return;
    }
    if (busy.current) return;
    if (pending.current && !data.flag) reveal();
    // the operator moved a group in or out
    if (data.focus && data.focus !== spotRef.current?.letter) void (async () => { if (spotRef.current) await sendBack(); await bringIn(data.focus!); })();
    else if (!data.focus && spotRef.current) void sendBack();
  }, [data]);

  // the all-groups view: fades out before the idle centre fades in
  const ovNow = !!data && ovWanted(data, data.pool.length > 0 && data.picks.length >= data.pool.length, busy.current, !!spot);
  useEffect(() => {
    if (ovWas.current && !ovNow) { setOvLeaving(true); const t = window.setTimeout(() => setOvLeaving(false), OV_OUT_MS); ovWas.current = ovNow; return () => clearTimeout(t); }
    if (ovNow) setOvLeaving(false);
    ovWas.current = ovNow;
  }, [ovNow]);

  // the render that switches it off already counts as leaving (the effect above sets the state one render later)
  const leaving = !ovNow && (ovLeaving || ovWas.current);

  if (!data) return <div style={{ width: '100vw', height: '100vh', background: '#0b5ea8' }} />;

  // a team just drawn is hidden from its row in this very render (the effect that starts its sequence runs only
  // after it): it never shows in its group before its waving flag has come and gone
  const before = prev.current;
  const last = data.picks[data.picks.length - 1];
  const hide = hidden ?? (before && last && data.picks.length > before.picks.length ? `${last.group}${last.place}` : null);
  const teams = new Map(data.teams.map((t) => [t.id, t]));
  const picked = new Map(data.picks.map((p) => [p.teamId, p]));
  const pool = data.pool.map((id) => teams.get(id)).filter((t): t is OutTeam => !!t);
  const done = pool.length > 0 && data.picks.length >= pool.length;
  const overview = ovWanted(data, done, busy.current, !!spot);
  const flagTeam = flag ? teams.get(flag.teamId) ?? null : null;
  const empty = data.emptyStyle ?? 'bars';
  const S = data.stripWidth ?? 300;
  // the list fills the left strip to the bottom, its teams spread evenly over the height
  const rowH = Math.min(50, Math.floor((H - 24 - 46 - 40) / Math.max(pool.length, 1) - 6));
  // the uploaded General Sans weights (Graphics → matchboard fonts); a General Sans installed on the vMix PC comes first
  const fontCss = data.fonts.map((w) => `@font-face { font-family: 'DrawGS'; font-weight: ${w}; font-display: block; src: url('/api/matchboard/fonts/general-sans-${w}'); }`).join('\n');
  const group = (g: string, rows: Out['board'][number]['slots']) => <GroupRows g={g} rows={rows} data={data} teams={teams} hidden={hide} landed={landed} empty={empty} />;

  return (
    <div className="dr-root">
      <style>{fontCss + css(S)}</style>
      <div ref={stage} className={`dr-stage${overview || leaving ? ' is-overview' : ''}${spot || flag ? ' is-spot' : ''}`} style={{ transform: `scale(${scale})` }}>
        <div className="dr-bg" />

        {/* left: the pool */}
        <aside className="dr-strip dr-left">
          <div className="dr-pill">Teams</div>
          <div className="dr-panel">
            <div className="dr-box dr-pool">
              {pool.map((t) => {
                const pk = picked.get(t.id);
                // not shown as drawn before its flag is on the screen
                const p = pk && hide === `${pk.group}${pk.place}` && flag?.teamId !== t.id && !landed ? undefined : pk;
                const isCur = flag?.teamId === t.id || (!!landed && !!p && `${p.group}${p.place}` === landed);
                return (
                  <Row key={t.id} className={`dr-row dr-pool-row${p && !isCur ? ' is-done' : ''}${isCur ? ' is-current' : ''}`} style={{ height: rowH }}
                    content={t.id} bg={t.gradient} lit={isCur}>
                    <Flag team={t} className="dr-row-flag" />
                    <span className="dr-row-code">{t.code}</span>
                  </Row>
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
              <div key={g} ref={(el) => { if (el) groupEls.current.set(g, el); }} className={`dr-box dr-group${spot?.letter === g ? ' is-away' : ''}`}>
                <div className="dr-box-label">GROUP {g}</div>
                {group(g, rows)}
              </div>
            ))}
          </div>
        </aside>

        {/* centre */}
        <div className="dr-mid">
          <img className="dr-header" src={`/api/draw/output/header.png?v=${data.headerV ?? 0}`} alt="" />
          <main ref={centre} className="dr-centre">
            {!overview && !leaving && (
              <div className="dr-idle-wrap"><div key={`idle${data.picks.length}`} className="dr-idle">
                <div className="dr-pill dr-pill-big">{data.caption}</div>
                <div className={`dr-idle-big${done && data.picks.length ? ' is-long' : ''}`}>{data.picks.length === 0 ? 'The Draw' : done ? 'Draw complete' : 'Next team'}</div>
                <div className="dr-idle-count"><b>{data.picks.length}</b> / {pool.length} teams drawn</div>
              </div></div>
            )}
            {(overview || leaving) && (
              <div key="overview" ref={ovBox} className={`dr-overview${overview ? '' : ' is-out'}`}>
                {data.board.map(({ letter: g, slots: rows }, gi) => (
                  <div key={g} className="dr-box dr-ov-col" style={{ animationDelay: `${250 + gi * 120}ms` }}>
                    <div className="dr-box-label">GROUP {g}</div>
                    {rows.map((row, i) => {
                      const p = data.picks.find((x) => x.group === g && x.place === i + 1);
                      const t = row.teamId ? teams.get(row.teamId) : p ? teams.get(p.teamId) : undefined;
                      return (
                        <Row key={i} className={`dr-row dr-ov-row${t ? '' : ` is-empty${empty === 'bars' ? ' is-bars' : ''}`}`} content={t?.id ?? ''}>
                          {t ? <><Flag team={t} className="dr-row-flag" /><span className="dr-row-code">{t.code}</span><span className="dr-ov-name">{t.name}</span></>
                            : <EmptyPlace style={empty} text={row.text} />}
                        </Row>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </main>
        </div>

        {/* the group brought to the centre: a copy of its box, moved from the strip and enlarged */}
        {spot && (() => {
          const b = data.board.find((x) => x.letter === spot.letter);
          if (!b) return null;
          return (
            <div className={`dr-box dr-group dr-spot${spot.on ? ' is-on' : ''}${flag && !flag.out ? ' is-under' : ''}`}
              style={{ left: spot.x, top: spot.y, width: spot.w, height: spot.h, transform: spot.on ? `translate(${spot.tx}px, ${spot.ty}px) scale(${spot.s})` : 'none' }}>
              <div className="dr-box-label">GROUP {spot.letter}</div>
              {group(spot.letter, b.slots)}
            </div>
          );
        })()}

        {/* the flag of the team drawn, covering the group */}
        {flagTeam && <CentreFlag key={flagTeam.id} team={flagTeam} out={!!flag?.out} centre={centre} stage={stage} />}
      </div>
    </div>
  );
}

function GroupRows({ g, rows, data, teams, hidden, landed, empty }: {
  g: string; rows: Out['board'][number]['slots']; data: Out; teams: Map<string, OutTeam>; hidden: string | null; landed: string | null; empty: EmptyStyle;
}) {
  return <>{rows.map((row, i) => {
    const key = `${g}${i + 1}`;
    const p = data.picks.find((x) => x.group === g && x.place === i + 1);
    const drawn = row.teamId ? teams.get(row.teamId) : p ? teams.get(p.teamId) : undefined;
    // the team drawn last: its row stays empty until the waving flag is gone, then highlight, flag and code fade in together
    const t = hidden === key ? undefined : drawn;
    const fresh = !!drawn && landed === key;
    return (
      <Row key={key} className={`dr-row dr-slot${t ? ' is-filled' : ' is-empty'}${fresh ? ' is-landed' : ''}`} content={t?.id ?? (fresh ? 'lit' : '')} bg={drawn?.gradient} lit={fresh}>
        {t ? <><Flag team={t} className="dr-row-flag" /><span className="dr-row-code">{t.code}</span></> : fresh ? null : <EmptyPlace style={empty} text={row.text} />}
      </Row>
    );
  })}</>;
}

/** Whether the centre shows all groups: only when the operator switches it on (ALL GROUPS), also after the last team. */
function ovWanted(d: Out, _done: boolean, _busy: boolean, _spot: boolean) { return d.overview; }

/**
 * A row whose content cross-fades when it changes (a team arriving, leaving, a group tag), and whose highlight
 * (the team's gradient) fades in and out. The first content shows without a fade.
 */
function Row({ className, style, content, bg, lit = false, instant = false, children }: { className: string; style?: CSSProperties; content: string; bg?: string; lit?: boolean; instant?: boolean; children: ReactNode }) {
  const was = useRef(content);
  const shown = useRef<ReactNode>(children);
  // a change is decided once, when the content changes (a later class change never replays it): the old content
  // fades out while the new one fades in
  const [change, setChange] = useState<{ n: number; fade: boolean; old: ReactNode }>({ n: 0, fade: false, old: null });
  useLayoutEffect(() => {
    if (was.current === content) return;
    was.current = content;
    const old = instant ? null : shown.current;
    setChange((c) => ({ n: c.n + 1, fade: !instant, old }));
    if (old) { const t = window.setTimeout(() => setChange((c) => (c.old === old ? { ...c, old: null } : c)), 650); return () => clearTimeout(t); }
  }, [content]);
  useLayoutEffect(() => { shown.current = children; });
  return (
    <div className={className} style={style}>
      {bg !== undefined && <span className="dr-row-bg" style={{ background: bg, opacity: lit ? 1 : 0 }} />}
      {change.old && <span key={`o${change.n}`} className="dr-cell dr-out">{change.old}</span>}
      <span key={change.n} className={`dr-cell${change.fade ? ' dr-in' : ''}`}>{children}</span>
    </div>
  );
}

/** A place still to be drawn: soft bars where the flag and the code will be, three dots, or its text (DRAW). */
function EmptyPlace({ style, text }: { style: EmptyStyle; text: string }) {
  if (style === 'bars') return <><span className="dr-row-flag dr-skel-flag" /><span className="dr-skel-code" /></>;
  if (style === 'dots') return <span className="dr-slot-place dr-dots"><i /><i /><i /></span>;
  return <span className="dr-slot-place">{text}</span>;
}

/** The team's flag animation over the centre, its full name above it; a drawn waving flag without a video. */
function CentreFlag({ team, out, centre, stage }: { team: OutTeam; out: boolean; centre: RefObject<HTMLElement | null>; stage: RefObject<HTMLDivElement | null> }) {
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number; cx: number; cw: number } | null>(null);
  const name = useRef<HTMLDivElement>(null);
  const [videoOk, setVideoOk] = useState(true);
  const video = useRef<HTMLVideoElement>(null);
  const still = useRef<HTMLCanvasElement>(null);
  // fading out: the video's current picture goes onto a canvas and the video stops, so the fade works whatever
  // the browser does with video layers (some draw a playing video above everything, ignoring the fade)
  useLayoutEffect(() => {
    const v = video.current, c = still.current;
    if (!out || !v || !c || !v.videoWidth) return;
    c.width = v.videoWidth; c.height = v.videoHeight;
    try { c.getContext('2d')?.drawImage(v, 0, 0); c.style.visibility = 'visible'; v.style.visibility = 'hidden'; v.pause(); } catch { /* keep the video */ }
  }, [out]);
  useLayoutEffect(() => {
    const st = stage.current, c = centre.current;
    if (!st || !c) return;
    const s0 = st.getBoundingClientRect(), k = s0.width / W, b = c.getBoundingClientRect();
    const cx = (b.left - s0.left) / k, cy = (b.top - s0.top) / k, cw = b.width / k, ch = b.height / k;
    // the name's band above the flag, then the flag: both together in the middle of the centre
    const w = Math.min(cw - 24, (ch - 24 - NAME_BAND) / FLAG_RATIO), h = w * FLAG_RATIO;
    const place = () => {
      // the letters of the name as far below the header picture as they are above the flag: from the font's own
      // measures (General Sans, capitals at NAME_PX): where the baseline sits in the name's line, how tall a capital is
      const hd = st.querySelector('.dr-header')?.getBoundingClientRect();
      const ctx = document.createElement('canvas').getContext('2d');
      let y = cy + (ch - h - NAME_BAND) / 2 + NAME_BAND;
      if (hd && ctx) {
        ctx.font = `600 ${NAME_PX}px ${getComputedStyle(st).fontFamily}`;
        const m = ctx.measureText('H');
        const base = (NAME_BAND - 12 - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
        const gap = NAME_BAND - base; // baseline of the name → top of the flag
        const top = (hd.bottom - s0.top) / k + gap - base + m.actualBoundingBoxAscent;
        if (Number.isFinite(top) && top + NAME_BAND + h <= cy + ch) y = top + NAME_BAND;
      }
      setBox({ x: cx + (cw - w) / 2, y, w, h, cx, cw });
    };
    place();
    void document.fonts?.ready.then(place);
  }, []);
  // a long name gets smaller until it fits the width of the centre, on one line
  useLayoutEffect(() => {
    const el = name.current;
    if (!el || !box) return;
    el.style.fontSize = '';
    const fit = () => { const full = el.scrollWidth, room = el.clientWidth; if (full > room) el.style.fontSize = `${Math.floor(NAME_PX * room / full)}px`; };
    fit();
    void document.fonts?.ready.then(() => { el.style.fontSize = ''; fit(); });
  }, [box, team.name]);
  if (!box) return null;
  return (<>
    <div ref={name} className={`dr-cflag-name${out ? ' is-out' : ''}`} style={{ left: box.cx + 12, top: box.y - NAME_BAND, width: box.cw - 24, height: NAME_BAND }}>{team.name}</div>
    <div className={`dr-cflag${out ? ' is-out' : ''}`} style={{ left: box.x, top: box.y, width: box.w, height: box.h, borderRadius: FLAG_RADIUS * box.h }}>
      {team.video && videoOk
        ? <><video ref={video} className="dr-cflag-video" src={team.video} autoPlay loop muted playsInline preload="auto" onError={() => setVideoOk(false)} />
          <canvas ref={still} className="dr-cflag-video" style={{ visibility: 'hidden' }} /></>
        : team.flag ? <WavingFlag src={team.flag} w={box.w} h={box.h} /> : <span className="dr-flag dr-flag-none dr-cflag-none">{team.code}</span>}
    </div>
  </>);
}

/** A flag waving in the wind: thin vertical slices of the picture, each rising and falling a little after the one before. */
const SLICES = 90;
function WavingFlag({ src, w, h }: { src: string; w: number; h: number }) {
  const sw = w / SLICES;
  return (
    <div className="dr-wave" style={{ width: w, height: h }}>
      {Array.from({ length: SLICES }, (_, i) => (
        <div key={i} className="dr-wave-slice" style={{
          left: i * sw, width: sw + 1.2, backgroundImage: `url(${src})`, backgroundSize: `${w}px ${h}px`, backgroundPosition: `${-i * sw}px 0`,
          animationDelay: `${(-i * 0.03).toFixed(3)}s`, ['--a' as string]: `${(3 + (22 * i) / SLICES).toFixed(1)}px`,
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
const EASE = 'cubic-bezier(.55,0,.2,1)';
/** The page's styles for side strips this wide (DRAW → Screen texts and layout). */
const css = (STRIP_W: number) => `
@font-face { font-family: 'DrawGrotesk'; font-weight: 700; src: url('/api/matchboard/fonts/space-grotesk'); }
html, body, #root { margin: 0; height: 100%; background: #0b5ea8; overflow: hidden; }
.dr-root { width: 100vw; height: 100vh; overflow: hidden; background: #0b5ea8; }
.dr-stage { position: relative; width: ${W}px; height: ${H}px; transform-origin: 0 0; overflow: hidden; color: #fff; text-transform: uppercase; /* every text on the screen in capitals */
  font-family: 'General Sans', 'DrawGS', 'DrawGrotesk', 'Segoe UI', system-ui, sans-serif; font-weight: 600; }
/* the matchboard's background: deep blue bottom left, cyan, green, lime top right */
.dr-bg { position: absolute; inset: 0; background:
  linear-gradient(115deg, transparent 0 55%, rgba(255,255,255,.05) 55% 61%, transparent 61% 100%),
  linear-gradient(28deg, #2c3e93 0%, #1867bb 20%, #0aa9df 42%, #0bbde6 52%, #3cc39a 70%, #86c540 86%, #c6d500 100%); }
.dr-mid { position: absolute; left: ${STRIP_W}px; top: 0; width: ${W - 2 * STRIP_W}px; height: ${H}px; display: flex; flex-direction: column; align-items: center;
  transition: left .8s ${EASE}, width .8s ${EASE}; }
.dr-header { display: block; width: ${W - 2 * STRIP_W}px; height: auto; max-height: ${HEADER_MAX}px; object-fit: cover; flex: none; position: relative; z-index: 5;
  box-shadow: 0 6px 24px rgba(0,0,0,.3); transition: width .8s ${EASE}, max-height .8s ${EASE}; }

/* the matchboard's white title bars with cut ends */
.dr-pill { height: 40px; display: flex; align-items: center; justify-content: center; color: #475569; font-size: 24px; font-weight: 600;
  background: linear-gradient(90deg, #d3deed 0%, #f4f8fc 40%, #ffffff 50%, #f4f8fc 60%, #d3deed 100%);
  clip-path: polygon(10px 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 10px 100%, 0 50%); box-shadow: 0 2px 6px rgba(0,0,0,.15); }
.dr-panel { padding: 0; }
.dr-box { background: linear-gradient(180deg, rgba(9,70,150,.42), rgba(9,70,150,.28)); border-radius: 12px; box-shadow: 0 6px 18px rgba(0,30,80,.18); }
.dr-box-label { height: 34px; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 600; letter-spacing: .02em; position: relative; }
.dr-box-label::after { content: ''; position: absolute; left: 12%; right: 12%; bottom: 2px; height: 1.5px; background: linear-gradient(90deg, transparent, rgba(255,255,255,.55), transparent); }
.dr-row { display: flex; align-items: center; gap: 10px; padding: 0 8px; border-radius: 7px; position: relative; }
.dr-row-flag { width: 54px; height: 36px; flex: none; }
.dr-row-code { font-size: 42px; font-weight: 600; letter-spacing: .01em; line-height: 1; }
.dr-flag { display: block; object-fit: cover; border-radius: 3px; }
.dr-flag-none { display: grid; place-items: center; background: #33415f; color: #fff; font-weight: 700; font-size: 10px; }
/* a place still to be drawn */
.dr-slot-place { flex: 1; text-align: center; font-size: 30px; font-weight: 500; color: rgba(255,255,255,.75); }
.dr-skel-flag { border-radius: 4px; background: rgba(255,255,255,.14); }
.dr-skel-code { height: 12px; width: 92px; border-radius: 6px; background: rgba(255,255,255,.14); }
.dr-dots { display: flex; justify-content: center; gap: 12px; }
.dr-dots i { width: 9px; height: 9px; border-radius: 50%; background: rgba(255,255,255,.4); }

.dr-strip { position: absolute; top: ${PANEL_TOP}px; width: ${STRIP_W - 20}px; height: ${H - PANEL_TOP - 12}px; z-index: 3; display: flex; flex-direction: column; gap: 10px;
  transition: transform .8s ${EASE}, opacity .8s ease; }
.dr-left { left: 10px; }
.dr-right { right: 10px; }
.dr-stage.is-overview .dr-left { transform: translateX(-${STRIP_W + 40}px); opacity: 0; }
.dr-stage.is-overview .dr-right { transform: translateX(${STRIP_W + 40}px); opacity: 0; }
.dr-stage.is-overview .dr-mid { left: 0; width: ${W}px; }
.dr-stage.is-overview .dr-header { width: ${W}px; max-height: 420px; }
.dr-strip .dr-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dr-pool { flex: 1; min-height: 0; padding: 8px 2px; display: flex; flex-direction: column; justify-content: space-evenly; }
.dr-pool-row { flex: none; }
.dr-pool-row { transition: opacity ${MOVE_MS}ms ${EASE}; gap: 14px; padding: 0 12px; }
.dr-pool-row .dr-row-flag { width: 54px; height: 36px; }
.dr-pool-row.is-done { opacity: .42; }

.dr-row-bg { position: absolute; inset: 0; border-radius: inherit; transition: opacity ${MOVE_MS}ms ${EASE}; pointer-events: none; }
.dr-pool-row.is-current .dr-row-bg { box-shadow: 0 6px 18px rgba(0,0,0,.3); }
.dr-cell { position: relative; display: flex; align-items: center; gap: inherit; flex: 1; min-width: 0; height: 100%; }
.dr-in { animation: dr-fade-in .6s ease both; }
.dr-cell.dr-out { position: absolute; inset: 0; padding: inherit; animation: dr-fade-out .6s ease both; pointer-events: none; }
/* the strips: every flag at the same place, so that a flag with a 3-letter code sits in the middle of the row;
   the codes end where their letters end */
.dr-pool-row .dr-cell, .dr-slot .dr-cell { justify-content: flex-start; padding-left: calc(50% - 84px); }
.dr-ov-row .dr-cell { flex-wrap: wrap; align-content: center; column-gap: 16px; row-gap: 4px; }
/* the soft bars of an empty place line up with the flags and codes */
.dr-ov-row:not(.is-empty) .dr-cell, .dr-ov-row.is-bars .dr-cell { justify-content: flex-start; padding-left: max(0px, calc(50% - var(--ov-half, 110px))); }
.dr-ov-row .dr-cell.dr-out { justify-content: flex-start; padding-left: max(0px, calc(50% - var(--ov-half, 110px))); }
.dr-overview.is-out { animation: dr-fade-out ${OV_OUT_MS}ms ease both; }
.dr-overview.is-out .dr-ov-col { animation: none; }
.dr-empty-note { padding: 18px 8px; font-size: 15px; font-weight: 500; }

.dr-groups { justify-content: space-between; gap: 10px; }
.dr-group { flex: 1; display: flex; flex-direction: column; justify-content: space-evenly; padding: 2px 4px 6px; }
.dr-group.is-away { visibility: hidden; }
.dr-slot { height: 46px; gap: 14px; padding: 0 14px; }
.dr-slot .dr-row-flag { width: 54px; height: 36px; }
.dr-slot .dr-row-code { font-size: 42px; }
/* the team in its group as the flag fades: there at once, no animation of its own (its highlight fades only when the group goes back) */
.dr-slot.is-landed .dr-row-bg { transition: opacity .6s ease; }

/* the group in the centre */
.dr-spot { position: absolute; z-index: 7; margin: 0; transform-origin: 0 0; transition: transform ${MOVE_MS}ms ${EASE}, box-shadow ${MOVE_MS}ms, opacity ${FADE_MS}ms ease; }
/* under the waving flag (and its name above it) the group fades away, and comes back as the flag fades */
.dr-spot.is-under { opacity: 0; }
.dr-spot.is-on { box-shadow: 0 10px 30px rgba(0,30,80,.35); }

.dr-centre { position: relative; flex: 1; min-height: 0; width: 100%; overflow: hidden; display: grid; place-items: center; }

.dr-idle { text-align: center; animation: dr-fade-up .8s ease-out both; display: flex; flex-direction: column; align-items: center; transition: opacity .4s; }
.dr-idle-wrap { transition: opacity .4s; }
.dr-stage.is-spot .dr-idle-wrap { opacity: 0; }
.dr-pill-big { height: 46px; font-size: 24px; padding: 0 46px; }
.dr-idle-big { font-size: 132px; font-weight: 600; line-height: 1; margin: 26px 0 18px; text-shadow: 0 8px 30px rgba(0,30,80,.35); }
/* in capitals DRAW COMPLETE is wider: one line across the centre */
.dr-idle-big.is-long { font-size: 106px; white-space: nowrap; }
.dr-idle-count { font-size: 28px; font-weight: 500; }
.dr-idle-count b { font-size: 38px; font-weight: 600; }

/* the flag of the team drawn */
.dr-cflag { position: absolute; z-index: 9; border-radius: 14px; overflow: hidden; box-shadow: 0 24px 60px rgba(0,20,60,.45);
  animation: dr-flag-in .6s ${EASE} both; transition: opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease; }
.dr-cflag.is-out { animation: dr-flag-out ${FADE_MS}ms ease both; }
.dr-cflag-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.dr-cflag-none { position: absolute; inset: 0; font-size: 140px; }
.dr-cflag-name { position: absolute; z-index: 9; text-align: center; white-space: nowrap; overflow: hidden;
  font-size: ${NAME_PX}px; font-weight: 600; text-transform: uppercase; line-height: ${NAME_BAND - 12}px; text-shadow: 0 4px 20px rgba(0,20,60,.45); animation: dr-fade-up .7s ease-out both .3s; }
.dr-cflag-name.is-out { animation: dr-fade-out ${FADE_MS}ms ease both; }
.dr-wave { position: absolute; inset: 0; overflow: hidden; }
.dr-wave-slice { position: absolute; top: 0; height: 100%; background-repeat: no-repeat; animation: dr-wave 2.2s ease-in-out infinite; }

.dr-overview { display: grid; grid-template-columns: repeat(4, 1fr); gap: 28px; width: calc(100% - 96px); }
.dr-ov-col { padding: 10px 14px 18px; animation: dr-fade-up .6s ease-out both; }
.dr-ov-col .dr-box-label { height: 64px; font-size: 32px; margin-bottom: 10px; }
.dr-ov-row { height: 112px; flex-wrap: wrap; align-content: center; column-gap: 16px; row-gap: 4px; padding: 0 14px; }
.dr-ov-row .dr-row-flag { width: 72px; height: 48px; }
.dr-ov-row .dr-row-code { font-size: 54px; }
.dr-ov-row .dr-slot-place { font-size: 40px; }
.dr-ov-row .dr-skel-code { width: 120px; height: 16px; }
.dr-ov-name { width: 100%; font-size: 22px; font-weight: 500; text-transform: uppercase; letter-spacing: .02em; opacity: .9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

@keyframes dr-wave { 0%, 100% { transform: translateY(calc(var(--a) * -1)); filter: brightness(1.08); } 50% { transform: translateY(var(--a)); filter: brightness(.88); } }
@keyframes dr-fade-up { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: none; } }
@keyframes dr-flag-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: scale(1.03); } }
@keyframes dr-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes dr-fade-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes dr-flag-in { from { opacity: 0; transform: scale(.9); } to { opacity: 1; transform: none; } }
@keyframes dr-pulse { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.18); } }
@keyframes dr-land { 0% { filter: brightness(1.6); transform: scale(1.06); } 100% { filter: none; transform: none; } }
`;
