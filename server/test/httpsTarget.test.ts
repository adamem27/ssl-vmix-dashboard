import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpsTarget, uploadPhp } from '../src/services/httpsTarget.js';

const hasPhp = (() => { try { execFileSync('php', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe('HTTPS upload (upload.php)', () => {
  it('keeps only a fingerprint of the key in upload.php', () => {
    const php = uploadPhp('secret-key-123');
    expect(php).not.toContain('secret-key-123');
    expect(php).toMatch(/KEY_SHA256 = '[0-9a-f]{64}'/);
  });

  it('reports a missing upload.php and a wrong key in plain words', async () => {
    const answer = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
    const files = [{ rel: 'status.json', data: '{}' }];
    await expect(new HttpsTarget('https://x/upload.php', 'k', 'komentator-abc123', answer(404, '')).put(files, () => undefined)).rejects.toThrow(/upload upload\.php/);
    await expect(new HttpsTarget('https://x/upload.php', 'k', 'komentator-abc123', answer(403, '')).put(files, () => undefined)).rejects.toThrow(/refused the key/);
    const done: string[] = [];
    await new HttpsTarget('https://x/upload.php', 'k', 'komentator-abc123', answer(200, '{"ok":true}')).put(files, (r) => done.push(r));
    expect(done).toEqual(['status.json']);
  });

  it.skipIf(!hasPhp)('upload.php writes the page files and refuses anything else', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sslphp-'));
    fs.writeFileSync(path.join(dir, 'upload.php'), uploadPhp('k3y'));
    const port = 18000 + Math.floor(Math.random() * 1000);
    const srv = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', dir], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 600));
      const url = `http://127.0.0.1:${port}/upload.php`;
      const ok: string[] = [];
      await new HttpsTarget(url, 'k3y', 'komentator-abc123', fetch).put([{ rel: 'data.json', data: '{"a":1}' }, { rel: 'img/' + 'a'.repeat(40) + '.png', data: Buffer.from([1, 2]) }], (r) => ok.push(r));
      expect(ok.length).toBe(2);
      expect(fs.readFileSync(path.join(dir, 'komentator-abc123', 'data.json'), 'utf8')).toBe('{"a":1}');
      await expect(new HttpsTarget(url, 'wrong', 'komentator-abc123', fetch).put([{ rel: 'data.json', data: 'x' }], () => undefined)).rejects.toThrow(/refused the key/);
      for (const bad of ['evil.php', 'assets/x.php.js', '../upload.php']) {
        await expect(new HttpsTarget(url, 'k3y', 'komentator-abc123', fetch).put([{ rel: bad, data: 'x' }], () => undefined)).rejects.toThrow(/HTTP 400/);
      }
    } finally { srv.kill(); }
  });
});
