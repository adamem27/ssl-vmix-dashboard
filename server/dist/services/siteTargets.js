import { getSetting, setSetting } from '../db/db.js';
import { S3Target } from './s3Target.js';
/**
 * Where the static commentator page goes: a Cloudflare R2 bucket (S3 API), served on our own domain.
 * The secret is never sent back to the browser.
 */
export const DEFAULT_PUBLIC_URL = 'https://commentary.em27code.com';
/** How often the page is sent, in seconds (the choices in Settings). */
export const PUBLISH_EVERY = [15, 30, 60, 120, 300];
export const publishEverySeconds = (db) => {
    const v = Number(getSetting(db, 'static.everySeconds'));
    return PUBLISH_EVERY.includes(v) ? v : 60;
};
export function siteSettings(db) {
    const g = (k) => getSetting(db, `static.${k}`);
    return {
        publicUrl: g('publicUrl') || DEFAULT_PUBLIC_URL, everySeconds: publishEverySeconds(db),
        s3Endpoint: g('s3Endpoint'), s3Bucket: g('s3Bucket'), s3AccessKey: g('s3AccessKey'), hasS3Secret: !!g('s3Secret'),
    };
}
export function saveSiteSettings(db, b) {
    for (const [k, v] of Object.entries(b))
        if (v !== undefined)
            setSetting(db, `static.${k}`, typeof v === 'string' ? v.trim() : String(v));
}
export function siteTarget(db, folder) {
    const s = siteSettings(db);
    const secret = getSetting(db, 'static.s3Secret');
    // Cloudflare shows the endpoint as https://<id>.r2.cloudflarestorage.com/<bucket>: the bucket can come from there
    const bucket = (s.s3Bucket || s3PathBucket(s.s3Endpoint)).replace(/^\/+|\/+$/g, '');
    const missing = [!s.s3Endpoint && 'S3 endpoint', !bucket && 'Bucket', !s.s3AccessKey && 'Access Key ID', !secret && 'Secret Access Key'].filter(Boolean);
    if (missing.length)
        throw new Error(`Missing in Settings → Commentator online (click Save after typing): ${missing.join(', ')}.`);
    return new S3Target({ endpoint: s3Origin(s.s3Endpoint), bucket, accessKey: s.s3AccessKey, secret, region: getSetting(db, 'static.s3Region') || 'auto', folder });
}
/** The first path part of an endpoint pasted with the bucket on the end. */
export function s3PathBucket(endpoint) {
    try {
        const e = endpoint.trim();
        return new URL(/^[a-z]+:\/\//i.test(e) ? e : `https://${e}`).pathname.split('/').filter(Boolean)[0] ?? '';
    }
    catch {
        return '';
    }
}
/** Endpoint as pasted from the Cloudflare dashboard: with or without https://, with or without /bucket at the end. */
export function s3Origin(endpoint) {
    const e = endpoint.trim();
    try {
        return new URL(/^[a-z]+:\/\//i.test(e) ? e : `https://${e}`).origin;
    }
    catch {
        throw new Error(`The S3 endpoint "${e}" is not a web address; it looks like https://<account-id>.r2.cloudflarestorage.com`);
    }
}
