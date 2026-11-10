/**
 * Stream Deck key colours in a team's national colours, for the Show control and Lower thirds keys.
 * The team's own gradient from the PNG generator (version 1) comes first, then the SSL26 / Panam team colours,
 * then a small table of flag colours. Every colour pair gets a readable text colour (black or white).
 */
import { DB } from '../db/db.js';
import { TEAM_GRADIENTS_PANAM, TEAM_GRADIENTS_SSL26 } from './generator/generator.js';

/** Flag colours for nations that have no team gradient: [main, second]. */
const FLAGS: Record<string, [string, string]> = {
  USA: ['#1f3a93', '#c8102e'], GER: ['#1d1d1b', '#dd0000'], ITA: ['#008c45', '#cd212a'], IRL: ['#169b62', '#ff883e'],
  FIN: ['#003580', '#e6e6e6'], AUT: ['#c8102e', '#e6e6e6'], BEL: ['#1d1d1b', '#fdda24'], CRO: ['#171796', '#ff0000'],
  GRE: ['#0d5eaf', '#e6e6e6'], TUR: ['#e30a17', '#e6e6e6'], ISR: ['#0038b8', '#e6e6e6'], KOR: ['#0047a0', '#cd2e3a'],
  CHN: ['#de2910', '#ffde00'], HKG: ['#de2910', '#e6e6e6'], UAE: ['#00732f', '#ff0000'], QAT: ['#8a1538', '#e6e6e6'],
  KSA: ['#006c35', '#e6e6e6'], EGY: ['#ce1126', '#1d1d1b'], MAR: ['#c1272d', '#006233'], NGR: ['#008751', '#e6e6e6'],
  KEN: ['#006600', '#bb0000'], TUN: ['#e70013', '#e6e6e6'], SLO: ['#005da4', '#ed1c24'], SVK: ['#0b4ea2', '#ee1c25'],
  BUL: ['#00966e', '#d62612'], ROU: ['#002b7f', '#fcd116'], LAT: ['#9e3039', '#e6e6e6'], ISL: ['#02529c', '#dc1e35'],
  MLT: ['#cf142b', '#e6e6e6'], CYP: ['#d57800', '#4e5b31'], MON: ['#ce1126', '#e6e6e6'], PAR: ['#d52b1e', '#0038a8'],
  BOL: ['#d52b1e', '#007934'], GUA: ['#4997d0', '#e6e6e6'], PAN: ['#005293', '#d21034'], CRC: ['#002b7f', '#ce1126'],
  DOM: ['#002d62', '#ce1126'], BAH: ['#00abc9', '#fae042'], BAR: ['#00267f', '#ffc726'], ISV: ['#002868', '#ffd100'],
  IVB: ['#002868', '#cf142b'], CAY: ['#012169', '#c8102e'], TTO: ['#ce1126', '#1d1d1b'], JAM: ['#009b3a', '#fed100'],
  HAI: ['#00209f', '#d21034'], NCA: ['#0067c6', '#e6e6e6'], HON: ['#00bce4', '#e6e6e6'], PHI: ['#0038a8', '#ce1126'],
  INA: ['#ce1126', '#e6e6e6'], VIE: ['#da251d', '#ffcd00'], FIJ: ['#62b5e5', '#002868'], SAM: ['#ce1126', '#002b7f'],
};

type Rgb = [number, number, number];
const parse = (h: string): Rgb => { const s = h.replace('#', ''); const v = s.length === 3 ? s.split('').map((c) => c + c).join('') : s.padEnd(6, '0'); return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) || 0) as Rgb; };
const hex = (c: Rgb) => '#' + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
const lum = (h: string) => { const [r, g, b] = parse(h).map((x) => { const c = x / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const sat = (h: string) => { const c = parse(h); const mx = Math.max(...c), mn = Math.min(...c); return mx ? (mx - mn) / mx : 0; };
const mix = (a: string, b: string, t: number) => { const x = parse(a), y = parse(b); return hex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb); };
const dist = (a: string, b: string) => { const x = parse(a), y = parse(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
/** Black or white, whichever reads better on the colour. */
export const textOn = (bg: string) => (lum(bg) > 0.4 ? '#000000' : '#ffffff');

/** The national colours of a team in the order of its gradient (at most 3, near-duplicates dropped). */
export function nationColours(db: DB | null, code: string): string[] {
  const c = code.toUpperCase();
  let stops: string[] = [];
  if (db) {
    try {
      const row = db.prepare('SELECT g.spec FROM gen_gradients g JOIN teams t ON t.id = g.team_id WHERE upper(t.code) = ? AND g.variant = 1').get(c) as { spec: string } | undefined;
      if (row) stops = (JSON.parse(row.spec)?.stops ?? []).map((s: { color: string }) => s.color);
    } catch { /* no generator tables */ }
  }
  if (!stops.length) stops = (TEAM_GRADIENTS_SSL26[c] ?? TEAM_GRADIENTS_PANAM[c] ?? []).map(([, col]) => col);
  if (!stops.length && FLAGS[c]) stops = [...FLAGS[c]];
  const out: string[] = [];
  for (const s of stops.filter((x) => /^#[0-9a-f]{6}$/i.test(x))) if (out.every((o) => dist(o, s) > 60)) out.push(s);
  return out.slice(0, 3);
}

export interface KeyLook { bg: string; fg: string }
export interface TeamKeyColours { normal: KeyLook; active: KeyLook; onAir: KeyLook }

/**
 * Key colours for a team: its main colour (darkened so it reads as a key), selected = the same colour much lighter,
 * on air = its second colour (or a bright version of the first) – feedback that still looks like the nation.
 */
export function teamKeyColours(db: DB | null, code: string): TeamKeyColours | null {
  const cols = nationColours(db, code);
  if (!cols.length) return null;
  // the main colour: the strongest one that is not near white
  const main = cols.find((x) => lum(x) < 0.45 && sat(x) > 0.25) ?? cols.find((x) => lum(x) < 0.6) ?? cols[0];
  const second = cols.find((x) => x !== main && dist(x, main) > 90) ?? null;
  const base = lum(main) > 0.25 ? mix(main, '#000000', 0.3) : main;
  const active = mix(main, '#ffffff', 0.45);
  const onAir = second ? (lum(second) < 0.08 ? mix(second, '#ffffff', 0.35) : second) : mix(main, '#ffffff', 0.7);
  return { normal: { bg: base, fg: textOn(base) }, active: { bg: active, fg: textOn(active) }, onAir: { bg: onAir, fg: textOn(onAir) } };
}

/** The look of a key in the team's colours, with a marker in the text when it is selected (▶) or on air (●). */
export function teamKeyLook(c: TeamKeyColours, text: string, state: { active?: boolean; onAir?: boolean }): KeyLook & { text: string } {
  if (state.onAir) return { ...c.onAir, text: `● ${text}` };
  if (state.active) return { ...c.active, text: `▶ ${text}` };
  return { ...c.normal, text };
}
