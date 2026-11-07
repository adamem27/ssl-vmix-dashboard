import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getSetting, newId, nowIso } from '../db/db.js';
import { inspectImage, kindLabel } from './images.js';
import { allowedKinds, slotsFor } from './slots.js';
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
function safeSegment(s) { return s.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'x'; }
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
export function saveUpload(ctx, owner, ownerId, slot, buf, filename) {
    assertSlot(owner, slot);
    if (!ownerExists(ctx.db, owner, ownerId))
        throw notFound(OWNER_LABEL[owner]);
    if (!buf.length)
        throw badRequest('The file is empty.');
    const info = inspectImage(buf);
    const kinds = allowedKinds(owner);
    if (!info || !kinds.includes(info.kind)) {
        throw badRequest(`Unsupported file format “${filename}”. Required format: ${kindLabel(kinds)}.`);
    }
    // Unique name per owner + slot + random suffix: identical source filenames never collide.
    const ext = info.kind === 'png' ? 'png' : 'jpg';
    const rel = path.join(OWNER_TABLE[owner], safeSegment(ownerId), `${safeSegment(slot)}_${randomBytes(4).toString('hex')}.${ext}`);
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
    try {
        fs.rmdirSync(path.join(ctx.assetsDir, OWNER_TABLE[owner], safeSegment(ownerId)));
    }
    catch { /* not empty or absent */ }
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
