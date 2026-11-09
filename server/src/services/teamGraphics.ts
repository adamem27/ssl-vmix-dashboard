import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, setSetting } from '../db/db.js';
import { AssetCtx, saveUpload } from './assets.js';

/** Bump when the bundled flags or emblems change so they are uploaded again on the next start. */
export const TEAM_GRAPHICS_VERSION = 'ssl26-flags-emblems-1';

export function graphicsDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, '..', '..', 'fixtures', 'graphics'), path.join(here, '..', 'fixtures', 'graphics')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Bundled file for each slot: flags from the per-country PDFs, emblems (coat of arms) evened out on 512×512. */
function filesFor(dir: string, code: string): Record<string, string> {
  const f = (sub: string, name: string) => path.join(dir, sub, name);
  const dark = f('emblems', `${code}_dark.png`);
  const light = fs.existsSync(f('emblems', `${code}_light.png`)) ? f('emblems', `${code}_light.png`) : dark;
  return {
    flag_big: f('flags', `${code}_big.png`),
    flag_small: f('flags', `${code}_small.png`),
    emblem_dark: dark,
    emblem_light: light,
  };
}

export interface TeamGraphicsResult { teams: number; files: number; withoutFlag: string[]; withoutEmblem: string[] }

/** Uploads the bundled flags and emblems into every team that has them, replacing what those slots held. */
export function applyTeamGraphics(ctx: AssetCtx, dir = graphicsDir()): TeamGraphicsResult {
  const res: TeamGraphicsResult = { teams: 0, files: 0, withoutFlag: [], withoutEmblem: [] };
  if (!dir) return res;
  const teams = ctx.db.prepare("SELECT id, code FROM teams WHERE code <> '' ORDER BY code").all() as { id: string; code: string }[];
  for (const t of teams) {
    const code = t.code.trim().toUpperCase();
    let any = false;
    for (const [slot, file] of Object.entries(filesFor(dir, code))) {
      if (!fs.existsSync(file)) continue;
      // the bundled flags are stored with rounded corners already
      saveUpload(ctx, 'team', t.id, slot, fs.readFileSync(file), `${code}_${slot}.png`, { flagRounded: true });
      res.files++; any = true;
    }
    if (!fs.existsSync(path.join(dir, 'flags', `${code}_big.png`))) res.withoutFlag.push(code);
    if (!fs.existsSync(path.join(dir, 'emblems', `${code}_dark.png`))) res.withoutEmblem.push(code);
    if (any) res.teams++;
  }
  return res;
}

/** Runs applyTeamGraphics once per TEAM_GRAPHICS_VERSION (needs the teams to exist first). */
export function applyTeamGraphicsOnStart(ctx: AssetCtx): TeamGraphicsResult | null {
  if (getSetting(ctx.db, 'graphics.version') === TEAM_GRAPHICS_VERSION) return null;
  if (!ctx.db.prepare('SELECT 1 FROM teams LIMIT 1').get()) return null;
  const res = applyTeamGraphics(ctx);
  setSetting(ctx.db, 'graphics.version', TEAM_GRAPHICS_VERSION);
  return res;
}
