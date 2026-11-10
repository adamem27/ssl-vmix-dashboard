import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { setup, seedTeam } from './helpers.js';
import { WorkbookWriter } from '../src/services/workbook.js';
import { updateTeam } from '../src/services/teams.js';

it('the workbook is built again only after a change (a tick itself writes nothing to the database)', () => {
  const s = setup();
  const { teamId } = seedTeam(s.db, 'BRA', ['Martine Grael']);
  const file = path.join(s.ctx.assetsDir, 'wb.xlsx');
  const w = new WorkbookWriter(s.ctx, file);
  const changes = () => (s.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  w.tick();
  const first = fs.statSync(file).mtimeMs, n = changes();
  w.tick();
  expect(changes()).toBe(n); // nothing written: the next ticks skip building the sheets
  updateTeam(s.db, teamId, { nickname: 'The Canaries' });
  fs.utimesSync(file, new Date(0), new Date(0));
  w.tick();
  expect(fs.statSync(file).mtimeMs).toBeGreaterThan(first - 1); // rewritten after the change
});
