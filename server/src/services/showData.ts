/**
 * General graphics data for the Show control keys: when a key brings a board, bug or scene in, its fields are set
 * straight in the vMix title first (SetText / SetImage), so what is on air is what General graphics says now, not only
 * what the workbook had at its last write. Field names follow the SSL titles (finals .gtzip: TITLE, ROLE 1, NAME 1,
 * VALUE 1, RACE 1, TIME 1, GROUP 1, FLAG 1…); a title field named like a version's field (EVENT, MARK…) gets it too.
 * Only fields the title has are set (Show.set), so one map serves every variant of a title.
 */
import { AssetCtx, listAssets } from './assets.js';
import { getSetDetail, listSets } from './fleets.js';
import { getScheduleOptions, getWeather, listSchedule } from './general.js';
import fs from 'node:fs';
import path from 'node:path';
import { encodePng } from './png.js';
import { GRAPHIC_KINDS, imagePath, listGraphicSets, TickerAuto, OFFICIAL_NAMES, OFFICIAL_ROLES } from './graphicSets.js';
import { groupLabel } from './groupNames.js';
import { loadLineup } from './lineups.js';
import { crewOf } from './lowerthirds.js';
import { overview } from './overview.js';
import { listTeams } from './teams.js';
import { teamPictureFor } from './ltTitle.js';
import { comparisonFlag } from './compareImages.js';
import { currentStage } from './workbookSheets.js';
import { getSetting, setSetting } from '../db/db.js';

type Asset = { vmixPath: string | null; storedPath: string | null; enteredPath: string | null } | undefined | null;
const img = (a: Asset) => (a ? a.vmixPath ?? a.storedPath ?? a.enteredPath ?? '' : '');
/** As typed (only trimmed): vMix gets the text exactly as it was written in the dashboard. */
const up = (s: string | undefined) => (s ?? '').trim();

/** DD.MM.YYYY, as on the SSL boards. */
const dotted = (iso: string) => { const [y, m, d] = iso.split('-'); return y && m && d ? `${d}.${m}.${y}` : iso; };

export interface ShowDataOpts { eventId: string; today: string; auto: TickerAuto; tickerText?: string }

/** The first version of a graphic in General graphics (its data), or {}. */
function first(ctx: AssetCtx, eventId: string, kind: string): Record<string, string> {
  return listGraphicSets(ctx.db, eventId, kind)[0]?.data ?? {};
}

/** Field values of a version: every field as `<KEY>.Text` (pictures as `.Source`). */
function versionFields(ctx: AssetCtx, kind: string, data: Record<string, string>, f: Map<string, string>) {
  const k = GRAPHIC_KINDS.find((x) => x.kind === kind);
  for (const fd of k?.fields ?? []) {
    if (fd.hidden) continue;
    if (fd.type === 'image') f.set(`${fd.key}.Source`, imagePath(ctx.db, ctx.assetsDir, data[fd.key]));
    else f.set(`${fd.key}.Text`, fd.type === 'list' ? (data[fd.key] ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join(' | ') : data[fd.key] ?? '');
  }
}

/**
 * Groups a schedule row can name: the current stage's first, then every other stage (latest first), so a row typed
 * for a group of another stage, or with no stage picked at the top, still finds its teams.
 */
function scheduleFleets(ctx: AssetCtx, eventId: string) {
  const stage = currentStage(ctx.db, eventId);
  const sets = (listSets(ctx.db, eventId) as { id: string }[]).map((x) => x.id).reverse();
  const order = stage ? [stage.id, ...sets.filter((x) => x !== stage.id)] : sets;
  return order.flatMap((id) => getSetDetail(ctx.db, id).fleets);
}

/** The place of the event: fixed, never typed (Welcome bar City / Country; LOCATION / LOCALIZATION on the boards). */
export const EVENT_CITY = 'RIO DE JANEIRO';
export const EVENT_COUNTRY = 'BRAZIL';
export const EVENT_LOCATION = `${EVENT_CITY}, ${EVENT_COUNTRY}`;
// rows added by the GTZIP generator's quick form copy the last row and count its number on (GROUP B2, B3, …)
const SCHEDULE_GROUP_LAYERS = ['GROUP A', 'GROUP B', 'GROUP A1', 'GROUP B1', ...Array.from({ length: 8 }, (_, i) => `GROUP B${i + 2}`)];

const groupKey = (s: string | null | undefined) => groupLabel(s).replace(/\s+/g, ' ').trim();

/** The band behind the next race on the schedule board (its HIGHLIGHT n layers): soft white, a brighter line at the left. */
export const SCHEDULE_HIGHLIGHT = 'icons/schedule_highlight.png';
function highlightPng() {
  const W = 920, H = 58, R = 10;
  return encodePng(W, H, (x, y) => {
    // rounded ends: outside the corner circles stays clear
    const cx = x < R ? R : x >= W - R ? W - R - 1 : x, cy = y < R ? R : y >= H - R ? H - R - 1 : y;
    if ((x - cx) ** 2 + (y - cy) ** 2 > R * R) return [0, 0, 0, 0];
    if (x < 4 && y >= 6 && y < H - 6) return [255, 255, 255, 200];
    return [255, 255, 255, 30];
  });
}
/** The highlight's path for vMix (written to the assets folder the first time). */
export function scheduleHighlightPath(ctx: AssetCtx) {
  if (ctx.assetsDir) {
    const file = path.join(ctx.assetsDir, ...SCHEDULE_HIGHLIGHT.split('/'));
    try { if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, highlightPng()); } } catch { /* read-only folder: the path is still sent */ }
  }
  return imagePath(ctx.db, ctx.assetsDir, SCHEDULE_HIGHLIGHT);
}

/** Today's schedule rows with the flags of each group's teams (current stage first). */
export function scheduleRows(ctx: AssetCtx, eventId: string, today: string) {
  const fleets = scheduleFleets(ctx, eventId);
  const flagOf = (teamId: string) => { const a = listAssets(ctx, 'team', teamId) as Record<string, Asset>; return img(a.flag_small) || img(a.flag_big); };
  return listSchedule(ctx.db, eventId, today).map((s) => {
    const label = groupLabel(s.fleet);
    const key = groupKey(s.fleet);
    // same name first, then the same label; a group with teams placed before an empty one of the same name
    const same = [...fleets.filter((x) => x.name.trim().toUpperCase() === (s.fleet ?? '').trim().toUpperCase()), ...fleets.filter((x) => groupKey(x.name) === key)];
    const f = same.find((x) => x.filled > 0) ?? same[0];
    const race = (s.race ?? '').trim();
    return { id: s.id, time: s.time ?? '', race: /^\d+$/.test(race) ? `Race ${race}` : up(race), group: label, flags: (f ? f.positions : []).map((x) => (x ? flagOf(x) : null)) };
  });
}

/** What a graphic's title gets when its key brings it in; null when General graphics has nothing for it. */
export function showDataFields(ctx: AssetCtx, graphicId: string, o: ShowDataOpts): Map<string, string> | null {
  const f = new Map<string, string>();
  const { eventId, today } = o;
  const welcome = first(ctx, eventId, 'welcome');
  const socials = first(ctx, eventId, 'socials');
  /**
   * The rows of the schedule. On the day-schedule board (board = true) TIME can be off: the row's own fields are then
   * emptied and its centred copy (POSITION n C, RACE n C, GROUP n C, FLAG k C) filled, so no gap is left; HIGHLIGHT n
   * marks the row picked as the next race.
   */
  const sched = (board = false) => {
    const rows = scheduleRows(ctx, eventId, today);
    const opt = getScheduleOptions(ctx.db);
    const time = !board || opt.showTime;
    const next = board ? rows.findIndex((r) => r.id === opt.next[today]) : -1;
    const hl = next >= 0 ? scheduleHighlightPath(ctx) : '';
    for (let i = 0; i < Math.max(rows.length, 6); i++) { // rows the title lacks are simply not there
      const r = rows[i];
      const on = (v: string) => (time ? v : ''), off = (v: string) => (time ? '' : v);
      f.set(`POSITION ${i + 1}.Text`, on(r ? String(i + 1) : ''));
      f.set(`RACE ${i + 1}.Text`, on(r?.race ?? ''));
      f.set(`TIME ${i + 1}.Text`, on(r?.time ?? ''));
      f.set(`GROUP ${i + 1}.Text`, on(r?.group ?? ''));
      // the schedule board names its rows' group lines GROUP A, GROUP B, GROUP A1, GROUP B1
      if (i < SCHEDULE_GROUP_LAYERS.length) f.set(`${SCHEDULE_GROUP_LAYERS[i]}.Text`, on(r?.group ?? ''));
      // a place of the group with no team yet (null): its flag field is left as it is in the title (a “?” flag)
      const flag = (j: number) => (r ? r.flags[j] ?? null : '');
      for (let j = 0; j < 4; j++) { const v = flag(j); if (v !== null || !time) f.set(`FLAG ${i * 4 + j + 1}.Source`, on(v ?? '')); }
      if (board) {
        f.set(`POSITION ${i + 1} C.Text`, off(r ? String(i + 1) : ''));
        f.set(`RACE ${i + 1} C.Text`, off(r?.race ?? ''));
        f.set(`GROUP ${i + 1} C.Text`, off(r?.group ?? ''));
        for (let j = 0; j < 4; j++) { const v = flag(j); if (v !== null || time) f.set(`FLAG ${i * 4 + j + 1} C.Source`, off(v ?? '')); }
        f.set(`HIGHLIGHT ${i + 1}.Source`, i === next ? hl : '');
      }
    }
  };
  switch (graphicId) {
    case 'welcome': {
      // the SSL26 Welcome bar (Welcome 2.gtzip): the stage on top, the day and the date below; its other texts stay as
      // in the title (older titles named them Top text and Day number)
      const day = (welcome.day ?? '').trim(), date = (welcome.date ?? '').trim() || dotted(today);
      f.set('stage.Text', (welcome.stage ?? '').trim());
      f.set('Top text.Text', (welcome.stage ?? '').trim());
      f.set('Day.Text', day);
      f.set('Day number.Text', day);
      f.set('Date.Text', date);
      f.set('City.Text', EVENT_CITY);
      f.set('Country.Text', EVENT_COUNTRY);
      return f;
    }
    case 'schedule':
      f.set('DayText.Text', (welcome.day ?? '').trim());
      f.set('DateText.Text', (welcome.date ?? '').trim() || dotted(today));
      f.set('EVENT.Text', up(welcome.stage));
      f.set('LOCATION.Text', EVENT_LOCATION);
      f.set('CHONBURI, THA.Text', EVENT_LOCATION); // the place line of the schedule board (its layer kept that name)
      // day_schedule 2: Day, Date and location
      f.set('Day.Text', (welcome.day ?? '').trim());
      f.set('Date.Text', (welcome.date ?? '').trim() || dotted(today));
      f.set('location.Text', EVENT_LOCATION);
      sched(true);
      return f;
    case 'lbar': case 'break':
      f.set('TITLE.Text', 'Today');
      f.set('SUBTITLE.Text', dotted(today));
      f.set('WEBSITE.Text', up(socials.website));
      // the L-bar's side panel: the handles of Follow us, in order (SOCIAL 1–3)
      [socials.facebook, socials.youtube, socials.instagram, socials.tiktok, socials.x].map((v) => (v ?? '').trim()).filter(Boolean)
        .concat('', '', '').slice(0, 3).forEach((v, i) => f.set(`SOCIAL ${i + 1}.Text`, v));
      sched();
      if (o.tickerText !== undefined) f.set('Ticker1.Text', o.tickerText);
      return f;
    case 'course': {
      const c = first(ctx, eventId, 'course');
      versionFields(ctx, 'course', c, f);
      return f;
    }
    case 'officials': {
      // Race officials (Race_officials_PanAm.gtzip): TITLE, ROLE 1–8 and NAME 1–11, as typed on the tab
      const x = first(ctx, eventId, 'officials');
      f.set('TITLE.Text', up(x.title));
      for (let i = 1; i <= OFFICIAL_ROLES.length; i++) f.set(`ROLE ${i}.Text`, up(x[`role_${i}`]));
      for (let i = 1; i <= OFFICIAL_NAMES; i++) f.set(`NAME ${i}.Text`, (x[`name_${i}`] ?? '').trim());
      return f;
    }
    case 'weather': {
      const w = getWeather(ctx.db);
      // every value as typed (units too: 24°C, 12 kn, 315°); the direction in degrees first, then its letters
      const direction = [w.wind_degrees, w.wind_direction].map((x) => x.trim()).filter(Boolean).join(' ');
      const values = [w.wind_speed, direction, w.forecast, w.air_temp];
      values.forEach((v, i) => f.set(`VALUE ${i + 1}.Text`, v ?? ''));
      // the layers named as the fields of the Weather tab (Forecast, Air °C, Wind, Direction…)
      const named: [string[], string][] = [
        [['Forecast', 'Conditions'], w.forecast],
        [['Air °C', 'Air', 'Air temp', 'Air temperature', 'Temperature', 'Temp'], w.air_temp],
        [['Wind', 'Wind speed', 'Speed'], w.wind_speed],
        [['Direction', 'Wind direction'], direction],
        [['Direction in degrees', 'Degrees', 'Wind degrees'], w.wind_degrees],
        [['Direction letters', 'Letters', 'Compass'], w.wind_direction],
      ];
      for (const [names, v] of named) for (const n of names) f.set(`${n}.Text`, v ?? '');
      for (const [k, v] of Object.entries(w)) if (k !== 'updated_at' && !f.has(`${k}.Text`)) f.set(`${k}.Text`, v);
      return f;
    }
    case 'socials':
      versionFields(ctx, 'socials', socials, f);
      f.set('WEB.Text', up(socials.website));
      return f;
    default:
      return null;
  }
}

/** Team comparison overrides (General graphics → Team comparison): per group, the group's own fields and each team's. */
export const COMPARE_KEY = 'compare.overrides';
/** A team weight always with two decimals ("702.5" → "702.50", "698 kg" → "698.00 kg"); other text as it is. */
export function weight2(w: string): string {
  const m = String(w ?? '').trim().match(/^(\d+(?:[.,]\d+)?)\s*(kg)?$/i);
  return m ? `${Number(m[1].replace(',', '.')).toFixed(2)}${m[2] ? ` ${m[2]}` : ''}` : String(w ?? '');
}
export const COMPARE_TEAM_FIELDS = ['name', 'nick', 'rank', 'weight', 'cptName', 'cptSurname', 'flag', 'emblem', 'photo', 'panel'] as const;
export const COMPARE_GROUP_FIELDS = ['title', 'group'] as const;
export type CompareTeamField = (typeof COMPARE_TEAM_FIELDS)[number];
type GroupOver = { title?: string; group?: string; teams?: Record<string, Partial<Record<CompareTeamField, string>>> };
export function compareOverrides(db: AssetCtx['db']): Record<string, GroupOver> {
  try { return JSON.parse(getSetting(db, COMPARE_KEY) || '{}'); } catch { return {}; }
}
/** Sets (or, with an empty value, clears) one override of a group: n = 0 for the group's own fields, 1–4 for a team. */
export function setCompareOverride(db: AssetCtx['db'], fleetId: string, n: number, field: string, value: string) {
  const all = compareOverrides(db);
  const g = (all[fleetId] ??= {});
  const v = value.trim();
  if (n === 0) {
    if (!(COMPARE_GROUP_FIELDS as readonly string[]).includes(field)) throw new Error(`Unknown field ${field}`);
    if (v) (g as Record<string, unknown>)[field] = v; else delete (g as Record<string, unknown>)[field];
  } else {
    if (!(COMPARE_TEAM_FIELDS as readonly string[]).includes(field)) throw new Error(`Unknown field ${field}`);
    const t = ((g.teams ??= {})[String(n)] ??= {});
    if (v) t[field as CompareTeamField] = v; else delete t[field as CompareTeamField];
  }
  setSetting(db, COMPARE_KEY, JSON.stringify(all));
}

/** What the comparison of a group shows by itself (no overrides): the group's title and each team's values, 1–4. */
export function compareAuto(ctx: AssetCtx, eventId: string, fleetId: string, today: string, o: { emblemSlot?: string } = {}) {
  const fleet = ctx.db.prepare('SELECT name, fleet_set_id AS setId FROM fleets WHERE id = ?').get(fleetId) as { name: string; setId: string } | undefined;
  const welcome = first(ctx, eventId, 'welcome');
  const ids = fleet ? getSetDetail(ctx.db, fleet.setId).fleets.find((x) => x.id === fleetId)?.positions ?? [] : [];
  const teams = new Map(listTeams(ctx).map((t) => [t.id, t]));
  const weights = new Map(overview(ctx, eventId, today, null).teams.map((t) => [t.id, t.declaration?.totalWeight ?? '']));
  const rows = [1, 2, 3, 4].map((n) => {
    const t = teams.get(ids[n - 1] ?? '');
    const a = (t?.assets ?? {}) as Record<string, Asset>;
    const cpt = t ? loadLineup(ctx.db, eventId, t.id).data.rows.find((r) => r.captain) : undefined;
    const w = t ? String(weights.get(t.id) ?? '') : '';
    // the team's panel from the PNG generator: left for teams 1 and 3, right for 2 and 4 (851×390); null: none
    const panel = t ? teamPictureFor(ctx, t, { w: 851, h: 390, key: `panel${n % 2 ? 'left' : 'right'}` }) : '';
    const v: Record<CompareTeamField, string> = {
      name: t?.name ?? '', nick: t?.nickname ?? '', rank: t?.ranking ?? '', weight: w,
      cptName: cpt?.firstName ?? '', cptSurname: cpt?.lastName ?? '',
      // the flag on the emblems' square canvas, made from the team's flag (its own files stay as they are)
      flag: t ? comparisonFlag(ctx, t.code, img(a.flag_big) || img(a.flag_small)) : '', emblem: img(a[o.emblemSlot || 'emblem_light']) || img(a.emblem_dark),
      photo: t && cpt ? crewOf(ctx, t.id).find((c) => c.slot === cpt.slot)?.photo ?? '' : '', panel: panel ?? '',
    };
    return { n, team: t ? { id: t.id, code: t.code, name: t.name } : null, values: v, panelFound: panel !== null };
  });
  return { fleetId, name: fleet?.name ?? '', group: groupLabel(fleet?.name), title: up(welcome.stage), teams: rows };
}

/** The groups of the current stage (or every stage when none is picked) with their comparison data and overrides. */
export function compareTab(ctx: AssetCtx, eventId: string, today: string, o: { emblemSlot?: string } = {}) {
  const stage = currentStage(ctx.db, eventId);
  const sets = stage ? [stage.id] : (listSets(ctx.db, eventId) as { id: string }[]).map((x) => x.id);
  const over = compareOverrides(ctx.db);
  return {
    stage: stage?.name ?? '',
    groups: sets.flatMap((id) => getSetDetail(ctx.db, id).fleets).map((f) => ({ ...compareAuto(ctx, eventId, f.id, today, o), over: over[f.id] ?? {} })),
  };
}

/**
 * Team comparison of a group (its teams in group order, 1–4): name, nickname, SSL ranking, team weight, captain and
 * the captain's photo, flag (or emblem), panel. What General graphics → Team comparison overrides wins. Each value
 * goes under the names of both kinds of title: 1 COUNTRY, 1 NICKNAME, RANK 1 / RANK NUM 1, 1 WEIGHT NUM, 1 CPT NAME,
 * 1 CPT SURNAME, 1 FLAG, 1 BG, 1 PHOTO / PHOTO 1, and T1Name, T1Nick, T1Rank…
 */
export function compareFields(ctx: AssetCtx, eventId: string, fleetId: string, today: string, o: { mark?: 'flag' | 'emblem'; emblemSlot?: string } = {}): Map<string, string> {
  const f = new Map<string, string>();
  const auto = compareAuto(ctx, eventId, fleetId, today, o);
  const over = compareOverrides(ctx.db)[fleetId] ?? {};
  const group = over.group || auto.group;
  f.set('Group.Text', group);
  f.set('SUBTITLE.Text', group);
  f.set('TITLE.Text', over.title || auto.title);
  for (const r of auto.teams) {
    const n = r.n;
    const ov = over.teams?.[String(n)] ?? {};
    const pic = (k: CompareTeamField) => (ov[k] ? imagePath(ctx.db, ctx.assetsDir, ov[k]) : r.values[k]);
    const val = (k: CompareTeamField) => ov[k] ?? r.values[k];
    const name = val('name'), nick = val('nick'), rank = val('rank'), w = weight2(val('weight'));
    const cptName = val('cptName'), cptSurname = val('cptSurname');
    const flag = o.mark === 'emblem' ? pic('emblem') : pic('flag');
    const photo = pic('photo');
    const panel = ov.panel || r.panelFound ? pic('panel') : null; // null: the title keeps its own
    for (const [k, v] of [
      [`${n} COUNTRY.Text`, name], [`T${n}Name.Text`, name], [`${n} NICKNAME.Text`, nick], [`T${n}Nick.Text`, nick],
      [`RANK ${n}.Text`, rank], [`RANK NUM ${n}.Text`, rank], [`T${n}Rank.Text`, rank],
      [`${n} WEIGHT NUM.Text`, w ? (/kg/i.test(w) ? w : `${w} kg`) : ''], [`T${n}Weight.Text`, w],
      [`${n} CPT NAME.Text`, cptName], [`${n} CPT SURNAME.Text`, cptSurname], [`T${n}Captain.Text`, `${cptName} ${cptSurname}`.trim()],
      [`${n} FLAG.Source`, flag], [`T${n}Flag.Source`, flag], ...(panel === null ? [] : [[`${n} BG.Source`, panel], [`T${n}Panel.Source`, panel]] as const),
      [`${n} PHOTO.Source`, photo], [`PHOTO ${n}.Source`, photo], [`T${n}Photo.Source`, photo],
    ] as const) f.set(k, v);
  }
  return f;
}
