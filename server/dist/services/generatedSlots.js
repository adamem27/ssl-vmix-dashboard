import fs from 'node:fs';
import path from 'node:path';
import { getSetting, setSetting } from '../db/db.js';
import { savePath } from './assets.js';
import { listOutputs, listTemplates } from './generator/generator.js';
import { joinVmixPath } from './paths.js';
/**
 * Team graphic places filled from the PNG generator, matched on the GT titles:
 *  - Background type 1 ← Panel left (851×390): the team box of the Team comparison title (852×391).
 *  - Background type 2 ← Square (210×134): the box behind each sailor in the Team line-up title (211×135).
 *  - Lowerthird photo  ← Bar waves: the lower third with a photo.
 *  - Lowerthird anthem ← Bar long: the plain long bar.
 * A place gets the generated file's path only while it is empty; the operator can upload or type another file at any
 * time. A place filled here follows its file (new vMix folder, renamed code); one the operator changed or cleared is left alone.
 */
export const GENERATED_FOR_SLOT = [
    { slot: 'background_1', fileName: 'panel_left' },
    { slot: 'background_2', fileName: 'square' },
    { slot: 'lowerthird_photo', fileName: 'bar_waves' },
    { slot: 'lowerthird_anthem', fileName: 'bar_long' },
];
const stateKey = (teamId, slot) => `generatedSlot.${teamId}.${slot}`;
/** Returns how many places were filled or updated. */
export function fillTeamSlotsFromGenerator(ctx) {
    const { db } = ctx;
    const templates = new Map(listTemplates(db).map((t) => [t.id, t]));
    const root = getSetting(db, 'paths.vmixAssetsRoot');
    // generated files that exist, by team and element file name
    const outputs = new Map();
    for (const o of listOutputs(db)) {
        const t = templates.get(o.templateId);
        if (t && fs.existsSync(path.join(ctx.assetsDir, ...o.rel.split('/'))))
            outputs.set(`${o.teamId}|${t.fileName}`, o.rel);
    }
    if (!outputs.size)
        return 0;
    const assets = new Map(db.prepare("SELECT owner_id, slot, storage_kind, entered_path FROM assets WHERE owner_type = 'team'").all().map((a) => [`${a.owner_id}|${a.slot}`, a]));
    const teams = db.prepare('SELECT id FROM teams').all();
    let n = 0;
    for (const { id } of teams) {
        for (const m of GENERATED_FOR_SLOT) {
            const rel = outputs.get(`${id}|${m.fileName}`);
            if (!rel)
                continue;
            const want = root ? joinVmixPath(root, rel) : path.join(ctx.assetsDir, ...rel.split('/'));
            const key = stateKey(id, m.slot);
            const ours = getSetting(db, key); // the path this function last put there
            const cur = assets.get(`${id}|${m.slot}`);
            const fill = !cur ? !ours : cur.storage_kind === 'path' && cur.entered_path === ours && ours !== want;
            if (!fill)
                continue;
            try {
                savePath(ctx, 'team', id, m.slot, want);
                setSetting(db, key, want);
                n++;
            }
            catch { /* a bad path stays empty; tried again next time */ }
        }
    }
    return n;
}
