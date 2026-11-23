import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { setup } from './helpers.js';
import { createSet } from '../src/services/fleets.js';

describe('notes for the commentators', () => {
  it('adds, edits and deletes notes, and the commentator screen gets them', async () => {
    const t = setup();
    const setId = createSet(t.db, t.eventId, 'Group stage', 2);
    const app = await buildApp({ db: t.db, assetsDir: t.ctx.assetsDir, sync: t.sync });
    const screen = async () => (await app.inject({ url: `/api/commentator?set=${setId}` })).json();
    const fleetId = (await screen()).results[0]?.fleetId as string | undefined;
    expect(fleetId).toBeTruthy();

    const general = (await app.inject({ method: 'POST', url: '/api/commentator/messages', payload: { text: '  Race 4 postponed 15 min ', important: true } })).json();
    expect(general).toMatchObject({ text: 'Race 4 postponed 15 min', fleetId: '', teamId: '', important: true });
    // a team id without a group is dropped: a note on a team belongs to its group
    expect((await app.inject({ method: 'POST', url: '/api/commentator/messages', payload: { text: 'x', teamId: 'abc' } })).json().teamId).toBe('');
    expect((await app.inject({ method: 'POST', url: '/api/commentator/messages', payload: { text: '   ' } })).statusCode).toBe(400);
    if (fleetId) await app.inject({ method: 'POST', url: '/api/commentator/messages', payload: { text: 'Protest pending', fleetId } });
    // a note on a group of another stage stays out of this stage's screen
    await app.inject({ method: 'POST', url: '/api/commentator/messages', payload: { text: 'elsewhere', fleetId: 'other-stage-group' } });

    const shown = (await screen()).messages.map((m: { text: string }) => m.text);
    expect(shown).toEqual(['Race 4 postponed 15 min', 'x', ...(fleetId ? ['Protest pending'] : [])]);

    const edited = (await app.inject({ method: 'PATCH', url: `/api/commentator/messages/${general.id}`, payload: { text: 'Race 4 at 15:30', important: false } })).json();
    expect(edited).toMatchObject({ text: 'Race 4 at 15:30', important: false });
    expect((await app.inject({ method: 'PATCH', url: '/api/commentator/messages/nope', payload: { text: 'a' } })).statusCode).toBe(404);
    await app.inject({ method: 'DELETE', url: `/api/commentator/messages/${general.id}` });
    expect((await screen()).messages.map((m: { text: string }) => m.text)).not.toContain('Race 4 at 15:30');
  });
});
