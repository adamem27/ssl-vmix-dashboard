import { Readable } from 'node:stream';
import { Client } from 'basic-ftp';
import type { SiteFile, SiteTarget } from './staticSite.js';

export interface FtpOptions { host: string; port: number; user: string; password: string; secure: boolean; dir: string }

/**
 * Uploads the static commentator page over FTP (FTPS by default) into one folder of the web host.
 * Each file goes up under a temporary name and is then renamed, so a viewer never reads half a data.json.
 */
export class FtpTarget implements SiteTarget {
  label: string;
  private client: Client | null = null;
  private madeDirs = new Set<string>();

  constructor(private o: FtpOptions) { this.label = `ftp://${o.user}@${o.host}:${o.port}/${o.dir}`; }

  private async connect() {
    if (this.client && !this.client.closed) return this.client;
    const c = new Client(20_000);
    try {
      await c.access({ host: this.o.host, port: this.o.port, user: this.o.user, password: this.o.password, secure: this.o.secure, secureOptions: { servername: this.o.host } });
    } catch (e: any) {
      c.close();
      const msg = String(e?.message ?? e);
      throw new Error(/530|login|auth/i.test(msg) ? 'FTP refused the user name or password.' : `Cannot connect to FTP ${this.o.host}:${this.o.port}: ${msg}`);
    }
    this.client = c;
    this.madeDirs.clear();
    return c;
  }

  async put(files: SiteFile[], done: (rel: string) => void) {
    if (!files.length) return;
    const c = await this.connect();
    const root = '/' + this.o.dir.replace(/^\/+|\/+$/g, '');
    for (const f of files) {
      const parts = f.rel.split('/');
      const dir = [root, ...parts.slice(0, -1)].join('/').replace(/\/+/g, '/');
      if (!this.madeDirs.has(dir)) { await c.ensureDir(dir); this.madeDirs.add(dir); }
      await c.cd(dir);
      const name = parts[parts.length - 1];
      const body = typeof f.data === 'string' ? Buffer.from(f.data) : f.data;
      await c.uploadFrom(Readable.from(body), `${name}.part`);
      await c.rename(`${name}.part`, name).catch(async () => { await c.remove(name, true); await c.rename(`${name}.part`, name); });
      done(f.rel);
    }
  }

  async close() { this.client?.close(); this.client = null; }
}
