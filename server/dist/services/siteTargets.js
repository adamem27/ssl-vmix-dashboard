import path from 'node:path';
import { getSetting, setSetting } from '../db/db.js';
import { LocalFolderTarget } from './staticSite.js';
import { FtpTarget } from './ftpTarget.js';
export function siteSettings(db, defaultDir) {
    const g = (k) => getSetting(db, `static.${k}`);
    return {
        mode: g('mode') === 'ftp' ? 'ftp' : 'folder',
        localDir: g('localDir') || defaultDir,
        publicUrl: g('publicUrl'),
        ftpHost: g('ftpHost'), ftpPort: Number(g('ftpPort')) || 21, ftpUser: g('ftpUser'), ftpDir: g('ftpDir'),
        ftpSecure: g('ftpSecure') !== 'off',
        hasFtpPassword: !!g('ftpPassword'),
    };
}
export function saveSiteSettings(db, b) {
    for (const [k, v] of Object.entries(b)) {
        if (v === undefined || k === 'enabled')
            continue;
        if (k === 'ftpSecure')
            setSetting(db, 'static.ftpSecure', v ? '' : 'off');
        else
            setSetting(db, `static.${k}`, typeof v === 'string' ? v.trim() : String(v));
    }
}
export function siteTarget(db, folder, defaultDir) {
    const s = siteSettings(db, defaultDir);
    if (s.mode === 'ftp') {
        if (!s.ftpHost || !s.ftpUser)
            return null;
        return new FtpTarget({ host: s.ftpHost, port: s.ftpPort, user: s.ftpUser, password: getSetting(db, 'static.ftpPassword'), secure: s.ftpSecure, dir: [s.ftpDir.replace(/\/+$/, ''), folder].filter(Boolean).join('/') });
    }
    return new LocalFolderTarget(path.join(s.localDir, folder));
}
