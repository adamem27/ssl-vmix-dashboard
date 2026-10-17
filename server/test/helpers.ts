import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, activeEvent } from '../src/db/db.js';
import { createTeam } from '../src/services/teams.js';
import { createSailor } from '../src/services/sailors.js';
import { SyncService, Fetcher } from '../src/services/sync.js';

export function setup(fetcher?: Fetcher) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sslvmix-'));
  const db = openDb(path.join(dir, 'test.sqlite'));
  const ctx = { db, assetsDir: path.join(dir, 'assets') };
  const ev = activeEvent(db);
  db.prepare('UPDATE events SET year = 2026 WHERE id = ?').run(ev.id);
  const sync = new SyncService(db, fetcher);
  return { dir, db, ctx, eventId: ev.id, sync };
}

export function seedTeam(db: any, code: string, names: string[]) {
  const teamId = createTeam(db, { name: `Team ${code}`, code });
  const ids = names.map((n) => { const [f, ...l] = n.split(' '); return createSailor(db, teamId, { firstName: f, lastName: l.join(' ') }); });
  return { teamId, sailorIds: ids };
}

/** Build a page shaped like the SSL Fabrik crew list. */
export function page(rows: { code: string; date: string; crew: [string, string, string][]; posted?: string; sep?: string }[]) {
  const tr = rows.map((r, i) => `<tr class="fabrik_row"><td>${r.code}</td><td>${r.date}</td><td>${r.crew.map(([n, j, role]) => `${n} (W:70.00) (J-${j}) -->${role}`).join(r.sep ?? '<br />')}</td><td>700.00</td><td>${r.posted ?? '10-06 10:00'}</td><td><a href="/x/details/67/${i + 1}">View</a></td></tr>`).join('\n');
  return `<table><thead><tr><th>Country</th><th>Sailing Date</th><th>Crews</th><th>Total Weight</th><th>Posted</th><th></th></tr></thead>
  <tbody><tr><td colspan="6">11-06(1)</td></tr>${tr}<tr><td colspan="6">No records</td></tr></tbody></table>`;
}
