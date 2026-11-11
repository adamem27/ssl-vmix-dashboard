import fs from 'node:fs';
import path from 'node:path';
import { getSetting, newId, nowIso } from '../db/db.js';
import { inspectImage, kindLabel } from './images.js';
import { allowedKinds, isSponsorSlot, slotsFor } from './slots.js';
import { normalizeLogo } from './logo.js';
import { FLAG_SLOTS, roundFlag } from './flagShape.js';
import { joinVmixPath, localCandidate, readIfExists, validateEnteredPath } from './paths.js';
import { badRequest, notFound } from './errors.js';
export function assetDto(ctx, r) {
    const vmixRoot = getSetting(ctx.db, 'paths.vmixAssetsRoot');
    const storedPath = r.stored_rel_path ? path.join(ctx.assetsDir, r.stored_rel_path) : null;
    let vmixPath = null;
    if (r.storage_kind === 'upload' && r.stored_rel_path && vmixRoot)
        vmixPath = joinVmixPath(vmixRoot, r.stored_rel_path);
    if (r.storage_kind === 'path')
        vmixPath = r.entered_path;
    const previewable = r.check_status === 'stored' || r.check_status === 'reachable';
    return {
        id: r.id,
        slot: r.slot,
        storageKind: r.storage_kind,
        originalFilename: r.original_filename,
        mime: r.mime,
        width: r.width,
        height: r.height,
        sizeBytes: r.size_bytes,
        storedPath,
        enteredPath: r.entered_path,
        vmixPath,
        vmixPathNote: vmixPath
            ? 'Path to use on the vMix computer (not verified from this computer).'
            : 'No vMix assets folder mapping (Settings → Files and paths).',
        previewUrl: previewable ? `/api/assets/${r.id}/file?v=${encodeURIComponent(r.updated_at)}` : null,
        checkStatus: r.check_status,
        checkMessage: r.check_message,
        checkedAt: r.checked_at,
        updatedAt: r.updated_at,
    };
}
const OWNER_TABLE = { team: 'teams', sailor: 'sailors', person: 'people' };
/** Top-level folders in assets, one per kind of owner. */
export const OWNER_DIR = { team: 'Teams', sailor: 'Sailors', person: 'People' };
const OWNER_LABEL = { team: 'Team', sailor: 'Sailor', person: 'Person' };
function ownerExists(db, owner, id) {
    const t = OWNER_TABLE[owner];
    return !!db.prepare(`SELECT 1 FROM ${t} WHERE id = ?`).get(id);
}
function assertSlot(owner, slot) {
    if (!slotsFor(owner).some((s) => s.key === slot))
        throw badRequest(`Nieznany slot: ${slot}`);
}
export function listAssets(ctx, owner, ownerId) {
    const rows = ctx.db.prepare('SELECT * FROM assets WHERE owner_type = ? AND owner_id = ?').all(owner, ownerId);
    return Object.fromEntries(rows.map((r) => [r.slot, assetDto(ctx, r)]));
}
function getRow(db, owner, ownerId, slot) {
    return db.prepare('SELECT * FROM assets WHERE owner_type = ? AND owner_id = ? AND slot = ?').get(owner, ownerId, slot);
}
/** A file or folder name that Windows accepts: no \\ / : * ? " < > |, no trailing dot or space. */
export function cleanName(s, fallback = 'x') {
    const v = s.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 80);
    return v || fallback;
}
const slotLabel = (owner, slot) => slotsFor(owner).find((s) => s.key === slot)?.label ?? slot;
const teamFolder = (t) => (t ? cleanName(`${t.code} - ${t.name}`) : 'No team');
/** Readable path without extension: Teams/ARG - Argentina/ARG - Flag big, Sailors/ARG - Argentina/LANGE Santiago - Photo, People/Jane Doe - Photo. */
export function readableBase(db, owner, ownerId, slot) {
    if (owner === 'team') {
        const t = db.prepare('SELECT code, name FROM teams WHERE id = ?').get(ownerId);
        return path.join(OWNER_DIR.team, teamFolder(t), cleanName(`${t?.code ?? 'Team'} - ${slotLabel(owner, slot)}`));
    }
    if (owner === 'sailor') {
        const s = db.prepare('SELECT s.first_name, s.last_name, t.code, t.name FROM sailors s LEFT JOIN teams t ON t.id = s.team_id WHERE s.id = ?').get(ownerId);
        const who = cleanName(`${(s?.last_name ?? '').toUpperCase()} ${s?.first_name ?? ''}`, 'Sailor');
        return path.join(OWNER_DIR.sailor, teamFolder(s?.code ? s : undefined), cleanName(`${who} - ${slotLabel(owner, slot)}`));
    }
    const p = db.prepare('SELECT name, surname, role, language FROM people WHERE id = ?').get(ownerId);
    const who = cleanName([[p?.name, p?.surname].filter(Boolean).join(' ') || p?.role || 'Person', p?.language].filter(Boolean).join(' - '), 'Person');
    return path.join(OWNER_DIR.person, cleanName(`${who} - ${slotLabel(owner, slot)}`));
}
const escapeRe = (v) => v.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
const relKey = (rel) => rel.replace(/\\/g, '/').toLowerCase();
/** First of base.ext, base v2.ext, … that no other asset uses and (when `fresh`) no file occupies. */
function freeName(ctx, base, ext, selfId, fresh) {
    const taken = new Set(ctx.db.prepare("SELECT stored_rel_path FROM assets WHERE storage_kind = 'upload' AND stored_rel_path IS NOT NULL AND id != ?").all(selfId ?? '')
        .map((r) => relKey(r.stored_rel_path)));
    for (let n = 1;; n++) {
        const rel = `${base}${n > 1 ? ` v${n}` : ''}.${ext}`;
        if (taken.has(relKey(rel)))
            continue;
        if (fresh && fs.existsSync(path.join(ctx.assetsDir, rel)))
            continue;
        return rel;
    }
}
function removeEmptyDirs(ctx, relDir) {
    const root = path.resolve(ctx.assetsDir);
    let dir = path.resolve(root, relDir);
    while (dir.startsWith(root + path.sep)) {
        try {
            if (fs.readdirSync(dir).length)
                return;
            fs.rmdirSync(dir);
        }
        catch {
            return;
        }
        dir = path.dirname(dir);
    }
}
/**
 * Keeps uploaded files under readable names: moves a file when its team, sailor or person was renamed
 * (and the files of older versions, stored as teams/<id>/flag_big_1a2b3c4d.png). Cheap when nothing changed.
 */
export function organizeAssets(ctx) {
    const rows = ctx.db.prepare("SELECT * FROM assets WHERE storage_kind = 'upload' AND stored_rel_path IS NOT NULL").all();
    let moved = 0;
    for (const r of rows) {
        const base = readableBase(ctx.db, r.owner_type, r.owner_id, r.slot);
        const ext = path.extname(r.stored_rel_path).slice(1).toLowerCase() || 'png';
        const cur = r.stored_rel_path;
        const ok = new RegExp(`^${escapeRe(relKey(base))}( v\\d+)?\\.${ext}$`).test(relKey(cur));
        if (ok)
            continue;
        const from = path.join(ctx.assetsDir, cur);
        if (!fs.existsSync(from))
            continue;
        const rel = freeName(ctx, base, ext, r.id, true);
        const to = path.join(ctx.assetsDir, rel);
        try {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.renameSync(from, to);
        }
        catch {
            continue;
        } // locked (vMix has it open): try again later
        ctx.db.prepare('UPDATE assets SET stored_rel_path = ?, updated_at = ? WHERE id = ?').run(rel, nowIso(), r.id);
        removeEmptyDirs(ctx, path.dirname(cur));
        moved++;
    }
    return moved;
}
function removeStoredFile(ctx, rel) {
    if (!rel)
        return;
    const p = path.resolve(ctx.assetsDir, rel);
    if (!p.startsWith(path.resolve(ctx.assetsDir) + path.sep))
        return;
    try {
        fs.unlinkSync(p);
    }
    catch { /* already gone */ }
}
export function saveUpload(ctx, owner, ownerId, slot, buf, filename, opts = {}) {
    assertSlot(owner, slot);
    if (!ownerExists(ctx.db, owner, ownerId))
        throw notFound(OWNER_LABEL[owner]);
    if (!buf.length)
        throw badRequest('The file is empty.');
    // Sponsor logos (PNG or JPG) are evened out onto one standard transparent PNG canvas.
    if (isSponsorSlot(owner, slot))
        buf = normalizeLogo(buf);
    // Flags always get rounded corners (never square on air).
    if (owner === 'team' && FLAG_SLOTS.includes(slot) && !opts.flagRounded)
        buf = roundFlag(buf);
    const info = inspectImage(buf);
    const kinds = allowedKinds(owner);
    if (!info || !kinds.includes(info.kind)) {
        throw badRequest(`Unsupported file format “${filename}”. Required format: ${kindLabel(kinds)}.`);
    }
    // Readable name (Teams/ARG - Argentina/ARG - Flag big.png). A replaced file gets the next free name
    // (… v2.png), so the path vMix reads changes and vMix does not keep showing the old picture.
    const ext = info.kind === 'png' ? 'png' : 'jpg';
    const prevRow = getRow(ctx.db, owner, ownerId, slot);
    const rel = freeName(ctx, readableBase(ctx.db, owner, ownerId, slot), ext, prevRow?.id ?? null, true);
    const abs = path.join(ctx.assetsDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + '.part';
    fs.writeFileSync(tmp, buf, { flag: 'wx' });
    fs.renameSync(tmp, abs);
    const prev = getRow(ctx.db, owner, ownerId, slot);
    const t = nowIso();
    try {
        ctx.db.prepare(`
      INSERT INTO assets (id, owner_type, owner_id, slot, storage_kind, stored_rel_path, entered_path, original_filename, mime, width, height, size_bytes, checked_at, check_status, check_message, created_at, updated_at)
      VALUES (@id, @owner_type, @owner_id, @slot, 'upload', @rel, NULL, @fn, @mime, @w, @h, @size, @t, 'stored', '', @t, @t)
      ON CONFLICT(owner_type, owner_id, slot) DO UPDATE SET storage_kind='upload', stored_rel_path=@rel, entered_path=NULL,
        original_filename=@fn, mime=@mime, width=@w, height=@h, size_bytes=@size, checked_at=@t, check_status='stored', check_message='', updated_at=@t
    `).run({ id: newId(), owner_type: owner, owner_id: ownerId, slot, rel, fn: path.basename(filename || 'file'), mime: info.mime, w: info.width, h: info.height, size: buf.length, t });
    }
    catch (e) {
        removeStoredFile(ctx, rel);
        throw e;
    }
    if (prev?.storage_kind === 'upload' && prev.stored_rel_path !== rel)
        removeStoredFile(ctx, prev.stored_rel_path);
    return assetDto(ctx, getRow(ctx.db, owner, ownerId, slot));
}
export function checkEnteredPath(ctx, owner, entered) {
    const kinds = allowedKinds(owner);
    const local = localCandidate(entered, getSetting(ctx.db, 'paths.vmixAssetsRoot'), ctx.assetsDir);
    const buf = local ? readIfExists(local) : null;
    if (!buf) {
        return {
            status: 'unverified',
            message: local
                ? 'The dashboard server found no file at this path. Path saved but unverified.'
                : 'This path is not reachable from the computer running the dashboard. Path saved but unverified.',
            mime: null, width: null, height: null, size: null,
        };
    }
    const info = inspectImage(buf);
    if (!info || !kinds.includes(info.kind)) {
        return { status: 'invalid', message: `The file exists but is not a ${kindLabel(kinds)} file.`, mime: null, width: null, height: null, size: buf.length };
    }
    return { status: 'reachable', message: 'The file is reachable by the dashboard server. Availability on the vMix computer is not checked.', mime: info.mime, width: info.width, height: info.height, size: buf.length };
}
export function savePath(ctx, owner, ownerId, slot, entered) {
    assertSlot(owner, slot);
    if (!ownerExists(ctx.db, owner, ownerId))
        throw notFound(OWNER_LABEL[owner]);
    const v = entered.trim();
    const err = validateEnteredPath(v);
    if (err)
        throw badRequest(err);
    const kinds = allowedKinds(owner);
    const ext = path.extname(v.replace(/\\/g, '/')).toLowerCase();
    const okExt = kinds.includes('png') && ext === '.png' || kinds.includes('jpeg') && (ext === '.jpg' || ext === '.jpeg');
    if (!okExt)
        throw badRequest(`The path must point to a ${kindLabel(kinds)} file (extension ${kinds.includes('jpeg') ? '.png, .jpg' : '.png'}).`);
    const c = checkEnteredPath(ctx, owner, v);
    if (c.status === 'invalid')
        throw badRequest(c.message);
    const prev = getRow(ctx.db, owner, ownerId, slot);
    const t = nowIso();
    const filename = v.split(/[\\/]/).pop() ?? v;
    ctx.db.prepare(`
    INSERT INTO assets (id, owner_type, owner_id, slot, storage_kind, stored_rel_path, entered_path, original_filename, mime, width, height, size_bytes, checked_at, check_status, check_message, created_at, updated_at)
    VALUES (@id, @owner_type, @owner_id, @slot, 'path', NULL, @p, @fn, @mime, @w, @h, @size, @t, @st, @msg, @t, @t)
    ON CONFLICT(owner_type, owner_id, slot) DO UPDATE SET storage_kind='path', stored_rel_path=NULL, entered_path=@p,
      original_filename=@fn, mime=@mime, width=@w, height=@h, size_bytes=@size, checked_at=@t, check_status=@st, check_message=@msg, updated_at=@t
  `).run({ id: newId(), owner_type: owner, owner_id: ownerId, slot, p: v, fn: filename, mime: c.mime, w: c.width, h: c.height, size: c.size, t, st: c.status, msg: c.message });
    if (prev?.storage_kind === 'upload')
        removeStoredFile(ctx, prev.stored_rel_path);
    return assetDto(ctx, getRow(ctx.db, owner, ownerId, slot));
}
export function recheckAsset(ctx, id) {
    const r = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    if (!r)
        throw notFound('Asset');
    const t = nowIso();
    if (r.storage_kind === 'upload') {
        const ok = r.stored_rel_path && fs.existsSync(path.join(ctx.assetsDir, r.stored_rel_path));
        ctx.db.prepare('UPDATE assets SET check_status = ?, check_message = ?, checked_at = ?, updated_at = ? WHERE id = ?')
            .run(ok ? 'stored' : 'invalid', ok ? '' : 'File missing from the app assets folder.', t, t, id);
    }
    else {
        const c = checkEnteredPath(ctx, r.owner_type, r.entered_path ?? '');
        ctx.db.prepare('UPDATE assets SET check_status=?, check_message=?, mime=COALESCE(?, mime), width=COALESCE(?, width), height=COALESCE(?, height), size_bytes=COALESCE(?, size_bytes), checked_at=?, updated_at=? WHERE id=?')
            .run(c.status, c.message, c.mime, c.width, c.height, c.size, t, t, id);
    }
    return assetDto(ctx, ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(id));
}
export function removeAsset(ctx, owner, ownerId, slot) {
    const r = getRow(ctx.db, owner, ownerId, slot);
    if (!r)
        return;
    ctx.db.prepare('DELETE FROM assets WHERE id = ?').run(r.id);
    if (r.storage_kind === 'upload')
        removeStoredFile(ctx, r.stored_rel_path);
}
export function removeAllForOwner(ctx, owner, ownerId) {
    const rows = ctx.db.prepare('SELECT * FROM assets WHERE owner_type = ? AND owner_id = ?').all(owner, ownerId);
    ctx.db.prepare('DELETE FROM assets WHERE owner_type = ? AND owner_id = ?').run(owner, ownerId);
    for (const r of rows)
        if (r.storage_kind === 'upload')
            removeStoredFile(ctx, r.stored_rel_path);
    for (const r of rows)
        if (r.stored_rel_path)
            removeEmptyDirs(ctx, path.dirname(r.stored_rel_path));
}
/** Local file to stream for a preview, or null. */
export function previewFile(ctx, id) {
    const r = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    if (!r)
        return null;
    if (r.storage_kind === 'upload' && r.stored_rel_path) {
        const p = path.join(ctx.assetsDir, r.stored_rel_path);
        return fs.existsSync(p) ? { path: p, mime: r.mime ?? 'application/octet-stream' } : null;
    }
    if (r.storage_kind === 'path' && r.entered_path) {
        const p = localCandidate(r.entered_path, getSetting(ctx.db, 'paths.vmixAssetsRoot'), ctx.assetsDir);
        if (!p)
            return null;
        const buf = readIfExists(p);
        const info = buf ? inspectImage(buf) : null;
        if (!info || !allowedKinds(r.owner_type).includes(info.kind))
            return null;
        return { path: p, mime: info.mime };
    }
    return null;
}
/**
 * One-off at start: files of older versions move to the readable layout (Teams/…, Sailors/…, People/…,
 * PNG generator/…, Matchboard/…) and the emptied old folders (teams/<id>, generated, matchboard) go away.
 */
export function tidyAssetsFolder(ctx) {
    const old = path.join(ctx.assetsDir, 'matchboard', 'matchboard.png'), now = path.join(ctx.assetsDir, 'Matchboard', 'matchboard.png');
    // on Windows both names are the same file: only move when the new one does not exist yet
    try {
        if (fs.existsSync(old) && !fs.existsSync(now)) {
            fs.mkdirSync(path.dirname(now), { recursive: true });
            fs.renameSync(old, now);
        }
    }
    catch { /* in use */ }
    organizeAssets(ctx);
    const prune = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return false;
        }
        let empty = true;
        for (const e of entries) {
            if (e.isDirectory() && prune(path.join(dir, e.name)))
                continue;
            empty = false;
        }
        if (empty) {
            try {
                fs.rmdirSync(dir);
            }
            catch {
                return false;
            }
        }
        return empty;
    };
    for (const d of ['teams', 'sailors', 'people', 'generated', 'matchboard']) {
        const p = path.join(ctx.assetsDir, d);
        // stale PNGs of the old generator folder are rebuilt under “PNG generator”
        if (d === 'generated' && path.resolve(p).toLowerCase() !== path.resolve(ctx.assetsDir, 'PNG generator').toLowerCase()) {
            try {
                for (const t of fs.readdirSync(p))
                    for (const f of fs.readdirSync(path.join(p, t)))
                        if (f.endsWith('.png') || f.endsWith('.tmp'))
                            fs.rmSync(path.join(p, t, f), { force: true });
            }
            catch { /* none */ }
        }
        prune(p);
    }
}
