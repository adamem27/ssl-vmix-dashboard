import { describe, expect, it } from 'vitest';
import { page, seedTeam, setup } from './helpers.js';
import * as decl from '../src/services/declarations.js';
import { updateSailor } from '../src/services/sailors.js';
import { saveUpload, listAssets } from '../src/services/assets.js';
import { encodePng } from '../src/services/png.js';

const crewV1: [string, string, string][] = [['Anna Kowalska', '1', 'Helm'], ['Jan Nowak', '7', 'Trimmer'], ['Piotr Zieliński', '9', 'Bow']];

function counts(db: any) {
  return {
    declarations: (db.prepare('SELECT COUNT(*) n FROM declarations').get() as any).n,
    members: (db.prepare('SELECT COUNT(*) n FROM declaration_members').get() as any).n,
    sailors: (db.prepare('SELECT COUNT(*) n FROM sailors').get() as any).n,
  };
}

describe('import', () => {
  it('re-importing the same data creates no duplicates', async () => {
    let body = page([{ code: 'POL', date: '11-06', crew: crewV1 }]);
    const { db, ctx, eventId, sync } = setup(async () => body);
    const { teamId } = seedTeam(db, 'POL', ['Anna Kowalska', 'Jan Nowak', 'Piotr Zielinski']);
    const r1 = await sync.runNow('manual');
    expect(r1.status).toBe('success');
    expect(r1.summary!.declarationsAdded).toBe(1);
    expect(r1.summary!.membersAdded).toBe(3);
    const before = counts(db);
    const r2 = await sync.runNow('manual');
    expect(r2.status).toBe('success');
    expect(r2.summary!.declarationsAdded).toBe(0);
    expect(r2.summary!.declarationsUnchanged).toBe(1);
    expect(r2.summary!.membersAdded).toBe(0);
    expect(counts(db)).toEqual(before);
    const d = decl.getDeclaration(ctx, eventId, teamId, '2026-06-11')!;
    // accent-insensitive match: "Zieliński" in source ↔ "Zielinski" in profile
    expect(d.members.every((m) => m.sailor)).toBe(true);
    expect(d.date).toBe('2026-06-11'); // sailing date, not the fetch date
  });

  it('manual corrections survive later syncs and can be reset to the source value', async () => {
    let body = page([{ code: 'POL', date: '11-06', crew: crewV1 }]);
    const { db, ctx, eventId, sync } = setup(async () => body);
    const { teamId } = seedTeam(db, 'POL', ['Anna Kowalska', 'Jan Nowak', 'Piotr Zielinski']);
    await sync.runNow('manual');
    let d = decl.getDeclaration(ctx, eventId, teamId, '2026-06-11')!;
    const jan = d.members.find((m) => m.sourceName === 'Jan Nowak')!;
    decl.setOverride(db, jan.id, { position: 'Tactician', number: '17' });

    // Source changes Jan's number and position: manual values must win, source values update underneath.
    body = page([{ code: 'POL', date: '11-06', crew: [crewV1[0], ['Jan Nowak', '8', 'Pit'], crewV1[2]] }]);
    const r = await sync.runNow('auto');
    expect(r.status).toBe('success');
    d = decl.getDeclaration(ctx, eventId, teamId, '2026-06-11')!;
    const after = d.members.find((m) => m.id === jan.id)!;
    expect(after.position).toMatchObject({ value: 'Tactician', origin: 'manual', source: 'Pit' });
    expect(after.number).toMatchObject({ value: '17', origin: 'manual', source: '8' });
    expect(r.summary!.conflicts.map((c) => c.field).sort()).toEqual(['number', 'position']);

    decl.clearOverride(db, jan.id, 'all');
    d = decl.getDeclaration(ctx, eventId, teamId, '2026-06-11')!;
    expect(d.members.find((m) => m.id === jan.id)!.position).toMatchObject({ value: 'Pit', origin: 'source' });
  });

  it('import never touches profile photos, achievements or other days', async () => {
    let body = page([{ code: 'POL', date: '11-06', crew: crewV1 }]);
    const { db, ctx, eventId, sync } = setup(async () => body);
    const { teamId, sailorIds } = seedTeam(db, 'POL', ['Anna Kowalska', 'Jan Nowak', 'Piotr Zielinski']);
    updateSailor(db, sailorIds[0], { bestResult1: '1st Test Cup', defaultPosition: 'Helm' });
    saveUpload(ctx, 'sailor', sailorIds[0], 'photo', encodePng(4, 4, () => [1, 2, 3, 255]), 'anna.png');
    decl.createManualDeclaration(ctx, eventId, teamId, '2026-06-10', 'roster');
    const hist = JSON.stringify(decl.getDeclaration(ctx, eventId, teamId, '2026-06-10'));
    await sync.runNow('manual');
    body = page([{ code: 'POL', date: '11-06', crew: [['Anna Kowalska', '99', 'Pit']] }]);
    await sync.runNow('manual');
    const s = db.prepare('SELECT * FROM sailors WHERE id = ?').get(sailorIds[0]) as any;
    expect(s.best_result_1).toBe('1st Test Cup');
    expect(s.default_position).toBe('Helm');
    expect(listAssets(ctx, 'sailor', sailorIds[0]).photo?.originalFilename).toBe('anna.png');
    const histAfter = JSON.parse(JSON.stringify(decl.getDeclaration(ctx, eventId, teamId, '2026-06-10')));
    expect(histAfter.members.map((m: any) => [m.position.value, m.number.value])).toEqual(JSON.parse(hist).members.map((m: any) => [m.position.value, m.number.value]));
  });

  it('a failed fetch or parse keeps the last good data', async () => {
    let mode: 'ok' | 'down' | 'garbage' | 'empty-table' = 'ok';
    const { db, ctx, eventId, sync } = setup(async () => {
      if (mode === 'down') throw new Error('ECONNREFUSED');
      if (mode === 'garbage') return '<html><body>Service unavailable</body></html>';
      if (mode === 'empty-table') return page([]);
      return page([{ code: 'POL', date: '11-06', crew: crewV1 }]);
    });
    const { teamId } = seedTeam(db, 'POL', ['Anna Kowalska']);
    await sync.runNow('manual');
    const good = JSON.stringify(decl.getDeclaration(ctx, eventId, teamId, '2026-06-11'));
    const lastSuccess = sync.status().lastSuccessAt;

    mode = 'down';
    expect((await sync.runNow('auto')).status).toBe('error');
    mode = 'garbage';
    const r = await sync.runNow('auto');
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/Crew table not found/);
    mode = 'empty-table';
    expect((await sync.runNow('auto')).status).toBe('success');

    expect(JSON.stringify(decl.getDeclaration(ctx, eventId, teamId, '2026-06-11'))).toBe(good);
    expect(sync.status().lastSuccessAt).not.toBeNull();
    expect(sync.status().lastSuccessAt! >= lastSuccess!).toBe(true);
    expect(sync.history().map((h) => h.status)).toEqual(['success', 'error', 'error', 'success']);
  });

  it('an error inside the write rolls the whole import back', async () => {
    const body = page([
      { code: 'POL', date: '11-06', crew: crewV1 },
      { code: 'POL', date: '12-06', crew: crewV1 },
    ]);
    const { db, sync } = setup(async () => body);
    seedTeam(db, 'POL', ['Anna Kowalska']);
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON declarations WHEN NEW.declaration_date = '2026-06-12' BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    const r = await sync.runNow('manual');
    expect(r.status).toBe('error');
    expect((db.prepare('SELECT COUNT(*) n FROM declarations').get() as any).n).toBe(0);
  });

  it('does not merge ambiguous people and lists unmatched records', async () => {
    const body = page([{ code: 'POL', date: '11-06', crew: [['Jan Nowak', '7', 'Trimmer'], ['Ewa Nowa', '3', 'Bow']] }]);
    const { db, ctx, eventId, sync } = setup(async () => body);
    const { teamId } = seedTeam(db, 'POL', ['Jan Nowak', 'Jan Nowak']);
    const r = await sync.runNow('manual');
    expect(r.summary!.membersUnmatched).toBe(2);
    const d = decl.getDeclaration(ctx, eventId, teamId, '2026-06-11')!;
    expect(d.members.map((m) => m.matchStatus).sort()).toEqual(['ambiguous', 'unmatched']);
    expect(decl.unmatchedMembers(db, eventId)).toHaveLength(2);

    // Operator creates the missing sailor; the spelling is remembered for the next import.
    const ewa = d.members.find((m) => m.sourceName === 'Ewa Nowa')!;
    decl.createSailorFromMember(db, ewa.id);
    await sync.runNow('manual');
    const d2 = decl.getDeclaration(ctx, eventId, teamId, '2026-06-11')!;
    expect(d2.members.find((m) => m.sourceName === 'Ewa Nowa')!.sailor?.lastName).toBe('Nowa');
    expect(counts(db).members).toBe(2);
  });

  it('number and position are not used as identity', async () => {
    let body = page([{ code: 'POL', date: '11-06', crew: [['Anna Kowalska', '1', 'Helm']] }]);
    const { db, sync } = setup(async () => body);
    seedTeam(db, 'POL', ['Anna Kowalska', 'Maria Wiśniewska']);
    await sync.runNow('manual');
    // Same number/position, different person: the old row goes, a new row for Maria appears.
    body = page([{ code: 'POL', date: '11-06', crew: [['Maria Wiśniewska', '1', 'Helm']] }]);
    const r = await sync.runNow('manual');
    expect(r.summary!.membersAdded).toBe(1);
    expect(r.summary!.membersRemoved).toBe(1);
  });

  it('reports teams it cannot match instead of creating them', async () => {
    const body = page([{ code: 'XYZ', date: '11-06', crew: crewV1 }]);
    const { db, sync } = setup(async () => body);
    const r = await sync.runNow('manual');
    expect(r.summary!.unmatchedTeams).toEqual(['XYZ']);
    expect(counts(db).declarations).toBe(0);
  });

  it('never runs two syncs at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const { db, sync } = setup(async () => { await gate; return page([]); });
    seedTeam(db, 'POL', []);
    const first = sync.runNow('manual');
    expect((await sync.runNow('auto')).status).toBe('already_running');
    release();
    expect((await first).status).toBe('success');
  });
});
