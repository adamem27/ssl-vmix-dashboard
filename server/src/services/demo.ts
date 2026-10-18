import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeEvent, getSetting, setSetting } from '../db/db.js';
import { AssetCtx, removeAllForOwner, saveUpload } from './assets.js';
import { encodePng } from './png.js';
import { createSailor } from './sailors.js';
import { createTeam } from './teams.js';
import { createFleet, createSet, placeTeam } from './fleets.js';

/**
 * Optional DEMO dataset for checking the layout. Every team, sailor and file it creates is flagged
 * is_demo and labelled "DEMO"; names are placeholders, not real people or results.
 */
// Deliberately abstract colour pairs and diagonal patterns, so placeholders never resemble a real national flag.
const DEMO_TEAMS = [
  { code: 'DMA', name: 'DEMO Team A', colors: [[20, 140, 150], [245, 150, 40], [30, 40, 60]] },
  { code: 'DMB', name: 'DEMO Team B', colors: [[120, 70, 170], [120, 210, 190], [30, 40, 60]] },
  { code: 'DMC', name: 'DEMO Team C', colors: [[230, 90, 120], [60, 70, 90], [240, 230, 210]] },
  { code: 'DMD', name: 'DEMO Team D', colors: [[90, 160, 60], [40, 50, 120], [240, 240, 240]] },
  { code: 'DME', name: 'DEMO Team E', colors: [[200, 120, 40], [70, 100, 110], [250, 240, 220]] },
  { code: 'DMF', name: 'DEMO Team F', colors: [[60, 120, 200], [230, 200, 80], [40, 40, 50]] },
  { code: 'DMG', name: 'DEMO Team G', colors: [[160, 60, 80], [150, 170, 180], [20, 30, 40]] },
  { code: 'DMH', name: 'DEMO Team H', colors: [[50, 170, 120], [110, 60, 140], [235, 235, 235]] },
] as const;

const POSITIONS = ['Helm', 'Tactician', 'Mainsail trimmer', 'Trimmer', 'Trimmer', 'Pit', 'Bow', 'Grinder', 'Grinder', 'Floater', 'Reserve'];

const stripes = (cols: readonly (readonly number[])[], w: number, h: number) =>
  encodePng(w, h, (x, y) => {
    const t = x / w + y / h; // diagonal: 0..2
    const c = Math.abs(t - 1) < 0.12 ? cols[2] : t < 1 ? cols[0] : cols[1];
    return [c[0], c[1], c[2], 255];
  });

const emblem = (cols: readonly (readonly number[])[], dark: boolean) =>
  encodePng(256, 256, (x, y) => {
    const d = Math.hypot(x - 128, y - 128);
    if (d > 120) return [0, 0, 0, 0];
    if (d > 108) return dark ? [20, 24, 32, 255] : [245, 245, 245, 255];
    const seg = Math.floor(((Math.atan2(y - 128, x - 128) + Math.PI) / (2 * Math.PI)) * 6) % 2;
    const c = d < 40 ? cols[2] : cols[seg];
    return [c[0], c[1], c[2], 255];
  });

const silhouette = (hue: readonly number[]) =>
  encodePng(300, 360, (x, y) => {
    const head = Math.hypot(x - 150, y - 130) < 62;
    const body = y > 210 && Math.hypot((x - 150) / 1.25, y - 360) < 130;
    if (head || body) return [90, 98, 112, 255];
    return [Math.round(hue[0] * 0.25 + 30), Math.round(hue[1] * 0.25 + 34), Math.round(hue[2] * 0.25 + 42), 255];
  });

export function hasDemo(ctx: AssetCtx) {
  return !!ctx.db.prepare('SELECT 1 FROM teams WHERE is_demo = 1 LIMIT 1').get();
}

export function seedDemo(ctx: AssetCtx) {
  if (hasDemo(ctx)) return { created: false };
  const db = ctx.db;
  const teamIds: string[] = [];
  db.transaction(() => {
    DEMO_TEAMS.forEach((t, ti) => {
      if (db.prepare('SELECT 1 FROM teams WHERE code = ? COLLATE NOCASE').get(t.code)) return;
      const id = createTeam(db, { name: t.name, code: t.code, aliases: [`Demo ${t.code}`], notes: 'Demo data (DEMO).' }, true);
      teamIds.push(id);
      // Fill a varying number of slots so completeness indicators have something to show.
      saveUpload(ctx, 'team', id, 'flag_small', stripes(t.colors, 120, 80), `DEMO_${t.code}_flag_small.png`);
      saveUpload(ctx, 'team', id, 'flag_big', stripes(t.colors, 900, 600), `DEMO_${t.code}_flag_big.png`);
      if (ti % 3 !== 2) saveUpload(ctx, 'team', id, 'emblem_dark', emblem(t.colors, true), `DEMO_${t.code}_emblem_dark.png`);
      if (ti % 2 === 0) saveUpload(ctx, 'team', id, 'emblem_light', emblem(t.colors, false), `DEMO_${t.code}_emblem_light.png`);
      if (ti < 3) saveUpload(ctx, 'team', id, 'background_1', stripes(t.colors, 1920, 1080), `DEMO_${t.code}_background_1.png`);
      for (let i = 0; i < 11; i++) {
        const sid = createSailor(db, id, {
          firstName: 'Demo', lastName: `${t.code} ${String(i + 1).padStart(2, '0')}`,
          defaultPosition: POSITIONS[i], defaultNumber: String(i + 1),
          bestResult1: 'DEMO – sample result', bestResult2: '',
        }, true);
        if (i < 6) saveUpload(ctx, 'sailor', sid, 'photo', silhouette(t.colors[0]), `DEMO_${t.code}_${i + 1}.png`);
      }
    });
    const ev = activeEvent(db);
    const setId = createSet(db, ev.id, 'DEMO – Round 1');
    const f1 = createFleet(db, setId, 'Fleet A');
    const f2 = createFleet(db, setId, 'Fleet B');
    teamIds.slice(0, 4).forEach((tid, i) => placeTeam(db, setId, { teamId: tid, fleetId: f1, position: i + 1 }));
    teamIds.slice(4, 7).forEach((tid, i) => placeTeam(db, setId, { teamId: tid, fleetId: f2, position: i + 1 }));
    setSetting(db, 'demo.fleetSetIds', JSON.stringify([setId]));
  })();
  return { created: true, teams: teamIds.length };
}

export function removeDemo(ctx: AssetCtx) {
  const db = ctx.db;
  const teams = db.prepare('SELECT id FROM teams WHERE is_demo = 1').all() as { id: string }[];
  const sailors = db.prepare('SELECT id FROM sailors WHERE is_demo = 1 OR team_id IN (SELECT id FROM teams WHERE is_demo = 1)').all() as { id: string }[];
  let setIds: string[] = [];
  try { setIds = JSON.parse(getSetting(db, 'demo.fleetSetIds') || '[]'); } catch { /* none */ }
  db.transaction(() => {
    for (const id of setIds) db.prepare('DELETE FROM fleet_sets WHERE id = ?').run(id);
    db.prepare('DELETE FROM sailors WHERE is_demo = 1').run();
    db.prepare('DELETE FROM teams WHERE is_demo = 1').run();
    setSetting(db, 'demo.fleetSetIds', '[]');
  })();
  for (const s of sailors) removeAllForOwner(ctx, 'sailor', s.id);
  for (const t of teams) removeAllForOwner(ctx, 'team', t.id);
  return { removedTeams: teams.length };
}

/** Test page shaped like the SSL crew list, with DEMO teams and placeholder names only. */
export function demoSourceHtml(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, '..', '..', 'fixtures', 'demo-crew-list.html'), path.join(here, '..', 'fixtures', 'demo-crew-list.html')]) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  throw new Error('Missing file fixtures/demo-crew-list.html');
}
