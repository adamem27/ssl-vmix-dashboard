import { createHash, createHmac } from 'node:crypto';
import type { SiteFile, SiteTarget } from './staticSite.js';

/**
 * Uploads the static commentator page to S3-compatible object storage (Cloudflare R2, Backblaze B2, AWS S3…)
 * over HTTPS with a plain signed PUT per file (AWS Signature V4, no SDK). A cloud store does not block
 * countries or busy addresses the way a shared host's firewall does, and serves the page from a CDN.
 */
export interface S3Options { endpoint: string; bucket: string; accessKey: string; secret: string; region: string; folder: string }

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', json: 'application/json', js: 'text/javascript', css: 'text/css',
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', woff2: 'font/woff2', woff: 'font/woff',
};
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Signed request headers for one PUT (exported for tests). */
export function signPut(o: Pick<S3Options, 'accessKey' | 'secret' | 'region'>, url: URL, body: Buffer, headers: Record<string, string>, now = new Date()) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const all: Record<string, string> = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: url.host, 'x-amz-content-sha256': sha256(body), 'x-amz-date': amzDate };
  const names = Object.keys(all).sort();
  const canonical = ['PUT', url.pathname, '', ...names.map((n) => `${n}:${all[n]}`), '', names.join(';'), all['x-amz-content-sha256']].join('\n');
  const scope = `${day}/${o.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secret}`, day), o.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  delete all.host; // fetch sets it
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

export class S3Target implements SiteTarget {
  label: string;
  constructor(private o: S3Options, private doFetch: typeof fetch = fetch) {
    this.label = `${o.endpoint.replace(/\/+$/, '')}/${o.bucket}/${o.folder}`;
  }

  async put(files: SiteFile[], done: (rel: string) => void) {
    const base = this.o.endpoint.replace(/\/+$/, '');
    for (const f of files) {
      const body = typeof f.data === 'string' ? Buffer.from(f.data) : f.data;
      const ext = f.rel.split('.').pop() ?? '';
      // the screen's data changes; scripts and pictures have their hash in the name and never do
      const fixed = f.rel.startsWith('img/') || f.rel.startsWith('assets/');
      const url = new URL(`${base}/${enc(this.o.bucket)}/${[this.o.folder, ...f.rel.split('/')].map(enc).join('/')}`);
      const headers = signPut(this.o, url, body, { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': fixed ? 'public, max-age=31536000, immutable' : 'no-cache, max-age=0' });
      let res: Response;
      try {
        res = await this.doFetch(url, { method: 'PUT', body: new Uint8Array(body), headers, signal: AbortSignal.timeout(60_000) });
      } catch (e: any) {
        throw new Error(`Cannot reach ${url.host}: ${e?.cause?.code ?? e?.message ?? e}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? '';
        if (res.status === 403 || /SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied/.test(code)) throw new Error(`The storage refused the keys (${code || 'HTTP 403'}): check the access key, secret and that the token may write to bucket "${this.o.bucket}".`);
        if (code === 'NoSuchBucket') throw new Error(`Bucket "${this.o.bucket}" does not exist at ${url.host}.`);
        throw new Error(`Storage answered HTTP ${res.status} ${code}`.trim());
      }
      done(f.rel);
    }
  }
}
