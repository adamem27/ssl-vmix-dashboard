/**
 * General graphics data for the Show control keys: when a key brings a board, bug or scene in, its fields are set
 * straight in the vMix title first (SetText / SetImage), so what is on air is what General graphics says now, not only
 * what the workbook had at its last write. Field names follow the SSL titles (finals .gtzip: TITLE, ROLE 1, NAME 1,
 * VALUE 1, RACE 1, TIME 1, GROUP 1, FLAG 1…); a title field named like a version's field (EVENT, MARK…) gets it too.
 * Only fields the title has are set (Show.set), so one map serves every variant of a title.
 */
import { AssetCtx, listAssets } from './assets.js';
import { getSetDetail } from './fleets.js';
import { getWeather, listSchedule } from './general.js';
import { GRAPHIC_KINDS, imagePath, listGraphicSets, TickerAuto } from './graphicSets.js';
import { groupLabel } from './groupNames.js';
import { loadLineup } from './lineups.js';
import { crewOf } from './lowerthirds.js';
import { overview } from './overview.js';
import { listTeams } from './teams.js';
import { currentStage } from './workbookSheets.js';

type Asset = { vmixPath: string | null; storedPath: string | null; enteredPath: string | null } | undefined | null;
const img = (a: Asset) => (a ? a.vmixPath ?? a.storedPath ?? a.enteredPath ?? '' : '');
const up = (s: string | undefined) => (s ?? '').trim().toUpperCase();

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

/** Today's schedule rows with the flags of each group's teams (current stage). */
function scheduleRows(ctx: AssetCtx, eventId: string, today: string) {
  const stage = currentStage(ctx.db, eventId);
  const fleets = stage ? getSetDetail(ctx.db, stage.id).fleets : [];
  const flagOf = (teamId: string) => { const a = listAssets(ctx, 'team', teamId) as Record<string, Asset>; return img(a.flag_small) || img(a.flag_big); };
  return listSchedule(ctx.db, eventId, today).map((s) => {
    const label = groupLabel(s.fleet);
    const f = fleets.find((x) => groupLabel(x.name) === label || x.name.toUpperCase() === (s.fleet ?? '').trim().toUpperCase());
    const race = (s.race ?? '').trim();
    return { time: s.time ?? '', race: /^\d+$/.test(race) ? `RACE ${race}` : up(race), group: label, flags: f ? f.positions.filter((x): x is string => !!x).map(flagOf) : [] };
  });
}

/** What a graphic's title gets when its key brings it in; null when General graphics has nothing for it. */
export function showDataFields(ctx: AssetCtx, graphicId: string, o: ShowDataOpts): Map<string, string> | null {
  const f = new Map<string, string>();
  const { eventId, today } = o;
  const welcome = first(ctx, eventId, 'welcome');
  const socials = first(ctx, eventId, 'socials');
  const sched = () => {
    const rows = scheduleRows(ctx, eventId, today);
    for (let i = 0; i < Math.max(rows.length, 6); i++) {
      const r = rows[i];
      f.set(`POSITION ${i + 1}.Text`, r ? String(i + 1) : '');
      f.set(`RACE ${i + 1}.Text`, r?.race ?? '');
      f.set(`TIME ${i + 1}.Text`, r?.time ?? '');
      f.set(`GROUP ${i + 1}.Text`, r?.group ?? '');
      for (let j = 0; j < 4; j++) f.set(`FLAG ${i * 4 + j + 1}.Source`, r?.flags[j] ?? '');
    }
  };
  switch (graphicId) {
    case 'welcome':
      versionFields(ctx, 'welcome', welcome, f);
      f.set('DATE.Text', welcome.dates ?? '');
      return f;
    case 'schedule':
      f.set('DayText.Text', up(welcome.day));
      f.set('DateText.Text', dotted(today));
      f.set('EVENT.Text', up(welcome.stage) || up(welcome.event));
      f.set('LOCATION.Text', up(welcome.location));
      sched();
      return f;
    case 'lbar': case 'break':
      f.set('TITLE.Text', 'TODAY');
      f.set('SUBTITLE.Text', dotted(today));
      f.set('WEBSITE.Text', up(socials.website));
      // the L-bar's side panel: the handles of Follow us, in order (SOCIAL 1–3)
      [socials.facebook, socials.youtube, socials.instagram, socials.tiktok, socials.x].map((v) => (v ?? '').trim()).filter(Boolean)
        .concat('', '', '').slice(0, 3).forEach((v, i) => f.set(`SOCIAL ${i + 1}.Text`, v.toUpperCase()));
      sched();
      if (o.tickerText !== undefined) f.set('Ticker1.Text', o.tickerText);
      return f;
    case 'course': {
      const c = first(ctx, eventId, 'course');
      versionFields(ctx, 'course', c, f);
      return f;
    }
    case 'officials': {
      const x = first(ctx, eventId, 'officials');
      versionFields(ctx, 'officials', x, f);
      f.set('TITLE.Text', up(x.heading));
      [x.pro_title, x.director_title, x.jury_title].forEach((v, i) => f.set(`ROLE ${i + 1}.Text`, up(v)));
      [x.pro_name, x.director_name, x.jury_1, x.jury_2, x.jury_3, x.jury_4, x.jury_5].forEach((v, i) => f.set(`NAME ${i + 1}.Text`, (v ?? '').trim()));
      return f;
    }
    case 'weather': {
      const w = getWeather(ctx.db);
      const deg = (v: string) => (v && /^\d+(\.\d+)?$/.test(v.trim()) ? `${v.trim()}°C` : v);
      const values = [w.wind_speed ? `${w.wind_speed} ${w.wind_unit}`.trim() : '', w.wind_direction || w.wind_degrees, w.forecast, deg(w.air_temp)];
      values.forEach((v, i) => f.set(`VALUE ${i + 1}.Text`, v ?? ''));
      for (const [k, v] of Object.entries(w)) if (k !== 'updated_at') f.set(`${k}.Text`, v);
      return f;
    }
    case 'socials':
      versionFields(ctx, 'socials', socials, f);
      f.set('WEB.Text', up(socials.website));
      return f;
    case 'replay': {
      const r = listGraphicSets(ctx.db, eventId, 'announcement').find((a) => a.name.toLowerCase() === 'replay');
      if (!r) return null;
      f.set('TEXT.Text', up(r.data.text) || 'REPLAY');
      if (r.data.icon) { const p = imagePath(ctx.db, ctx.assetsDir, r.data.icon); for (const n of ['ICON', 'STAR']) f.set(`${n}.Source`, p); }
      return f;
    }
    default:
      return null;
  }
}

/**
 * Team comparison of a group (its teams in group order, 1–4): name, nickname, SSL ranking, team weight, captain and
 * the captain's photo, flag. Each value goes under the names of both kinds of title: 1 COUNTRY, 1 NICKNAME,
 * RANK 1 / RANK NUM 1, 1 WEIGHT NUM, 1 CPT NAME, 1 CPT SURNAME, 1 FLAG, 1 PHOTO / PHOTO 1, and T1Name, T1Nick, T1Rank…
 */
export function compareFields(ctx: AssetCtx, eventId: string, fleetId: string, today: string): Map<string, string> {
  const f = new Map<string, string>();
  const fleet = ctx.db.prepare('SELECT name, fleet_set_id AS setId FROM fleets WHERE id = ?').get(fleetId) as { name: string; setId: string } | undefined;
  const welcome = first(ctx, eventId, 'welcome');
  f.set('Group.Text', groupLabel(fleet?.name));
  f.set('SUBTITLE.Text', groupLabel(fleet?.name));
  f.set('TITLE.Text', up(welcome.stage) || up(welcome.event));
  const ids = fleet ? getSetDetail(ctx.db, fleet.setId).fleets.find((x) => x.id === fleetId)?.positions ?? [] : [];
  const teams = new Map(listTeams(ctx).map((t) => [t.id, t]));
  const weights = new Map(overview(ctx, eventId, today, null).teams.map((t) => [t.id, t.declaration?.totalWeight ?? '']));
  for (let n = 1; n <= 4; n++) {
    const t = teams.get(ids[n - 1] ?? '');
    const a = (t?.assets ?? {}) as Record<string, Asset>;
    const cpt = t ? loadLineup(ctx.db, eventId, t.id).data.rows.find((r) => r.captain) : undefined;
    const photo = t && cpt ? crewOf(ctx, t.id).find((c) => c.slot === cpt.slot)?.photo ?? '' : '';
    const w = t ? String(weights.get(t.id) ?? '') : '';
    const name = (t?.name ?? '').toUpperCase(), nick = t?.nickname ?? '', rank = t?.ranking ?? '';
    const flag = img(a.flag_big) || img(a.flag_small);
    for (const [k, v] of [
      [`${n} COUNTRY.Text`, name], [`T${n}Name.Text`, name], [`${n} NICKNAME.Text`, nick], [`T${n}Nick.Text`, nick],
      [`RANK ${n}.Text`, rank], [`RANK NUM ${n}.Text`, rank], [`T${n}Rank.Text`, rank],
      [`${n} WEIGHT NUM.Text`, w ? `${w} kg` : ''], [`T${n}Weight.Text`, w],
      [`${n} CPT NAME.Text`, cpt?.firstName ?? ''], [`${n} CPT SURNAME.Text`, (cpt?.lastName ?? '').toUpperCase()],
      [`T${n}Captain.Text`, cpt ? `${cpt.firstName} ${cpt.lastName}`.trim() : ''],
      [`${n} FLAG.Source`, flag], [`T${n}Flag.Source`, flag], [`${n} PHOTO.Source`, photo], [`PHOTO ${n}.Source`, photo], [`T${n}Photo.Source`, photo],
    ] as const) f.set(k, v);
  }
  return f;
}
