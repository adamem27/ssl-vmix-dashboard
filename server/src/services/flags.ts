import fs from 'node:fs';
import { getSetting, setSetting } from '../db/db.js';
import { AssetCtx, listAssets, saveUpload } from './assets.js';
import { FLAG_SLOTS, isRounded } from './flagShape.js';

const ROUNDED_VERSION = 'rounded-1';

/** Once per ROUNDED_VERSION: rounds the flags already uploaded (bundled or the operator's own), keeping the pictures. */
export function roundStoredFlagsOnStart(ctx: AssetCtx): number {
  if (getSetting(ctx.db, 'flags.rounded') === ROUNDED_VERSION) return 0;
  const teams = ctx.db.prepare('SELECT id, code FROM teams').all() as { id: string; code: string }[];
  let n = 0;
  for (const t of teams) {
    const assets = listAssets(ctx, 'team', t.id);
    for (const slot of FLAG_SLOTS) {
      const a = assets[slot];
      if (!a || a.storageKind !== 'upload' || !a.storedPath || !fs.existsSync(a.storedPath)) continue;
      try {
        const buf = fs.readFileSync(a.storedPath);
        if (isRounded(buf)) continue;
        saveUpload(ctx, 'team', t.id, slot, buf, `${t.code}_${slot}.png`); // saveUpload rounds flag slots
        n++;
      } catch { /* unreadable file: left as it is */ }
    }
  }
  setSetting(ctx.db, 'flags.rounded', ROUNDED_VERSION);
  return n;
}
