import { createHash, randomBytes } from 'node:crypto';
/**
 * Uploads the static commentator page over HTTPS (port 443, works wherever the web works) to upload.php,
 * a small PHP file placed once in the web folder. The script only accepts the page's own file names inside
 * komentator-* folders, checks a secret key, and writes each file under a temporary name before renaming it.
 */
export class HttpsTarget {
    endpoint;
    key;
    folder;
    doFetch;
    label;
    constructor(endpoint, key, folder, doFetch = fetch) {
        this.endpoint = endpoint;
        this.key = key;
        this.folder = folder;
        this.doFetch = doFetch;
        this.label = `${endpoint} → ${folder}`;
    }
    async put(files, done) {
        for (const f of files) {
            const body = typeof f.data === 'string' ? Buffer.from(f.data) : f.data;
            let res;
            try {
                res = await this.doFetch(`${this.endpoint}?path=${encodeURIComponent(`${this.folder}/${f.rel}`)}`, {
                    method: 'POST', body: new Uint8Array(body), headers: { 'content-type': 'application/octet-stream', 'x-ssl-key': this.key }, signal: AbortSignal.timeout(60_000),
                });
            }
            catch (e) {
                throw new Error(`Cannot reach ${this.endpoint}: ${e?.cause?.code ?? e?.message ?? e}`);
            }
            const text = await res.text();
            if (res.status === 404)
                throw new Error(`${this.endpoint} not found: upload upload.php to the web folder (Settings → Commentator online → Download upload.php).`);
            if (res.status === 403)
                throw new Error('upload.php refused the key: download upload.php again and replace the one on the server.');
            if (!res.ok || !text.includes('"ok":true'))
                throw new Error(`upload.php answered HTTP ${res.status}: ${text.slice(0, 160)}`);
            done(f.rel);
        }
    }
}
export const newKey = () => randomBytes(24).toString('base64url');
/** upload.php with the key's SHA-256 inside (the key itself never lands on the server). */
export function uploadPhp(key) {
    const hash = createHash('sha256').update(key).digest('hex');
    return `<?php
// SSL commentator page: receives the static page files from the dashboard at the venue.
// Accepts only the page's own files inside komentator-* folders next to this script.
header('Content-Type: application/json');
header('X-Robots-Tag: noindex');
const KEY_SHA256 = '${hash}';
function fail($code, $msg) { http_response_code($code); echo json_encode(['ok' => false, 'error' => $msg]); exit; }
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'POST only');
$key = $_SERVER['HTTP_X_SSL_KEY'] ?? '';
if (!is_string($key) || !hash_equals(KEY_SHA256, hash('sha256', $key))) fail(403, 'bad key');
$path = $_GET['path'] ?? '';
if (!is_string($path) || !preg_match('~^komentator-[a-z0-9]{6,40}/(index\\.html|data\\.json|status\\.json|assets/[A-Za-z0-9_-]+\\.(js|css|woff2?|png|svg)|img/[0-9a-f]{40}\\.(png|jpg|webp|gif|svg))$~', $path)) fail(400, 'bad path');
$body = file_get_contents('php://input');
if ($body === false) fail(400, 'no body');
$full = __DIR__ . '/' . $path;
$dir = dirname($full);
if (!is_dir($dir) && !mkdir($dir, 0755, true)) fail(500, 'cannot make folder');
$tmp = $full . '.part' . bin2hex(random_bytes(4));
if (file_put_contents($tmp, $body) === false) fail(500, 'cannot write');
if (!rename($tmp, $full)) { @unlink($tmp); fail(500, 'cannot rename'); }
echo json_encode(['ok' => true, 'bytes' => strlen($body)]);
`;
}
