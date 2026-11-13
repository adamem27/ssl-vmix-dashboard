import { describe, expect, it } from 'vitest';
import { S3Target, signPut } from '../src/services/s3Target.js';

describe('S3 / Cloudflare R2 upload', () => {
  it('signs exactly like the AWS SDK (botocore S3SigV4Auth vector)', () => {
    const url = new URL('https://acc123.r2.cloudflarestorage.com/ssl-commentary/komentator-abc123/img/a%20b.png');
    const h = signPut({ accessKey: 'AKID', secret: 'SECRET', region: 'auto' }, url, Buffer.from('hello'),
      { 'content-type': 'image/png', 'cache-control': 'no-cache, max-age=0' }, new Date('2026-11-13T13:09:05Z'));
    expect(h.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKID/20261113/auto/s3/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=5a0784aeed4f1cb26e57e22c7ebbe59f95e347578cf59cda26fc910d3fc44fd1');
  });

  it('puts each file under the folder with its type and caching, and explains refusals', async () => {
    const seen: { url: string; type: string; cache: string }[] = [];
    const ok = (async (u: URL, init: RequestInit) => { const h = init.headers as Record<string, string>; seen.push({ url: String(u), type: h['content-type'], cache: h['cache-control'] }); return new Response('', { status: 200 }); }) as unknown as typeof fetch;
    const t = new S3Target({ endpoint: 'https://acc.r2.cloudflarestorage.com/', bucket: 'b', accessKey: 'k', secret: 's', region: 'auto', folder: 'komentator-abc123' }, ok);
    await t.put([{ rel: 'data.json', data: '{}' }, { rel: 'img/' + 'a'.repeat(40) + '.jpg', data: Buffer.from([1]) }], () => undefined);
    expect(seen[0]).toEqual({ url: 'https://acc.r2.cloudflarestorage.com/b/komentator-abc123/data.json', type: 'application/json', cache: 'no-cache, max-age=0' });
    expect(seen[1].type).toBe('image/jpeg');
    expect(seen[1].cache).toContain('immutable');
    const denied = (async () => new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 })) as unknown as typeof fetch;
    await expect(new S3Target({ endpoint: 'https://x', bucket: 'b', accessKey: 'k', secret: 's', region: 'auto', folder: 'f' }, denied).put([{ rel: 'data.json', data: '{}' }], () => undefined)).rejects.toThrow(/refused the keys/);
  });
});
