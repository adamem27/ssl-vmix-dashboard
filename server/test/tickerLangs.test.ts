import { describe, expect, it } from 'vitest';
import { setup, seedTeam } from './helpers.js';
import { deepl, getTickerLangsConfig, protect, setDeeplKey, setManualTranslation, setTickerLangsConfig, storedTranslation, TickerLangs, unprotect } from '../src/services/tickerLangs.js';
import { repeatLoop } from '../src/services/graphicSets.js';

/** A streaming vMix: one ticker title, keeping what was set. */
function streaming(titles: Record<string, string[]> = { 'Ticker PT': ['Headline.Text', 'Ticker.Text'] }, first = 30) {
  const names = Object.keys(titles);
  const vals = new Map<string, string>();
  const calls: string[] = [];
  let down = false;
  const fetcher = async (url: string) => {
    if (down) throw new Error('connect ECONNREFUSED');
    const q = url.split('/api/')[1] ?? '';
    if (q === '') {
      const inputs = names.map((n, i) => `<input key="s${i}" number="${first + i}" type="GT" title="${n}">${titles[n].map((f) => `<text index="0" name="${f}">${vals.get(`s${i}|${f}`) ?? ''}</text>`).join('')}</input>`).join('');
      return { ok: true, status: 200, text: async () => `<vmix><inputs>${inputs}</inputs></vmix>` };
    }
    const d = decodeURIComponent(q);
    calls.push(d);
    const m = d.match(/^\?Function=SetText&Input=(\w+)&SelectedName=(.+?)&Value=(.*)$/s);
    if (m) vals.set(`${m[1]}|${m[2]}`, m[3]);
    return { ok: true, status: 200, text: async () => '' };
  };
  return { fetcher, calls, vals, setDown: (x: boolean) => { down = x; } };
}

const PT: Record<string, string> = { 'RACE 3 OF GROUP B WARNING SIGNAL AT 14:30': 'REGATA 3 DO GRUPO B SINAL DE ATENÇÃO ÀS 14:30', 'Follow us': 'Siga-nos' };

function rig(messages = ['RACE 3 OF GROUP B WARNING SIGNAL AT 14:30']) {
  const s = setup();
  const v = streaming();
  const asked: string[][] = [];
  let fail = '';
  const translate = async (texts: string[], lang: string) => {
    asked.push([lang, ...texts]);
    if (fail) throw new Error(fail);
    return texts.map((t) => PT[t] ?? `${lang}:${t}`);
  };
  const src = { messages, sep: ' I ' };
  const tl = new TickerLangs(s.db, async () => src, v.fetcher, translate);
  setTickerLangsConfig(s.db, { enabled: true });
  return { s, v, tl, asked, src, setFail: (x: string) => { fail = x; } };
}

describe('ticker languages', () => {
  it('defaults: off, five slots, Portuguese (Brazil) on input 30 of Streaming 01', () => {
    const s = setup();
    const c = getTickerLangsConfig(s.db);
    expect(c.enabled).toBe(false);
    expect(c.slots).toHaveLength(5);
    expect(c.slots[0]).toEqual({ on: true, lang: 'PT-BR', host: 'http://192.168.110.217:8088', input: '30', field: '' });
    expect(c.slots.map((x) => x.input)).toEqual(['30', '31', '34', '35', '36']);
    expect(() => setTickerLangsConfig(s.db, { slots: [{ lang: 'XX' }] })).toThrow(/DeepL/);
    expect(setTickerLangsConfig(s.db, { slots: [{}, { host: '192.168.110.105' }] }).slots[1].host).toBe('http://192.168.110.105:8088');
  });

  it('off: nothing is translated or sent', async () => {
    const r = rig();
    setTickerLangsConfig(r.s.db, { enabled: false });
    await r.tl.tick(0);
    expect(r.asked).toEqual([]);
    expect(r.v.calls).toEqual([]);
  });

  it('translates once, writes the ticker field of the streaming input in capitals and repeated, only when it differs', async () => {
    const r = rig();
    await r.tl.tick(0);
    const want = repeatLoop('REGATA 3 DO GRUPO B SINAL DE ATENÇÃO ÀS 14:30 I ');
    expect(r.v.calls).toEqual([`?Function=SetText&Input=s0&SelectedName=Ticker.Text&Value=${want}`]);
    expect(r.tl.status[0]).toMatchObject({ lang: 'PT-BR', field: 'Ticker.Text', text: want, error: '' });
    // the next rounds: from the store, nothing sent while it is the same
    await r.tl.tick(2000);
    await r.tl.tick(4000);
    expect(r.asked).toHaveLength(1);
    expect(r.v.calls).toHaveLength(1);
    // the streaming vMix restarted (empty field): written again at the next check
    r.v.vals.clear();
    await r.tl.tick(4000 + r.tl.checkMs);
    expect(r.v.calls).toHaveLength(2);
    // the English ticker changes: only the new message is translated
    r.src.messages = ['RACE 3 OF GROUP B WARNING SIGNAL AT 14:30', 'Follow us'];
    await r.tl.tick(40_000);
    expect(r.asked.at(-1)).toEqual(['PT-BR', 'Follow us']);
    expect(r.v.calls.at(-1)).toContain(`Value=${repeatLoop('REGATA 3 DO GRUPO B SINAL DE ATENÇÃO ÀS 14:30 I SIGA-NOS I ')}`);
  });

  it('a correction by hand wins over the machine translation and is sent at once', async () => {
    const r = rig();
    await r.tl.tick(0);
    setManualTranslation(r.s.db, 'RACE 3 OF GROUP B WARNING SIGNAL AT 14:30', 'PT-BR', 'Regata 3 do grupo B: sinal às 14:30');
    r.tl.resend();
    await r.tl.tick(2000);
    expect(r.v.calls.at(-1)).toContain('Value=REGATA 3 DO GRUPO B: SINAL ÀS 14:30 I ');
    expect(storedTranslation(r.s.db, 'RACE 3 OF GROUP B WARNING SIGNAL AT 14:30', 'PT-BR')).toEqual({ text: 'Regata 3 do grupo B: sinal às 14:30', manual: 1 });
    // cleared: back to the machine translation
    setManualTranslation(r.s.db, 'RACE 3 OF GROUP B WARNING SIGNAL AT 14:30', 'PT-BR', '');
    await r.tl.tick(4000);
    expect(r.asked).toHaveLength(2);
  });

  it('DeepL or the streaming PC failing: the old text stays, the slot shows why, the round goes on', async () => {
    const r = rig();
    setTickerLangsConfig(r.s.db, { slots: [{}, { on: true, lang: 'ES', input: 'Ticker PT' }] });
    r.setFail('DeepL did not answer (no internet?).');
    await r.tl.tick(0);
    expect(r.v.calls).toEqual([]);
    expect(r.tl.status[0].error).toMatch(/DeepL did not answer/);
    // not asked again at every round
    await r.tl.tick(2000);
    expect(r.asked).toHaveLength(2);
    r.setFail('');
    await r.tl.tick(2000 + r.tl.retryMs);
    expect(r.v.calls).toHaveLength(2);
    r.v.setDown(true);
    r.src.messages = ['Follow us'];
    await r.tl.tick(100_000);
    expect(r.tl.status[0].error).toMatch(/Cannot reach vMix at http:\/\/192\.168\.110\.217:8088/);
    expect(r.tl.status[0].text).toContain('SINAL');
  });

  it('a missing input or a field given by name', async () => {
    const r = rig();
    setTickerLangsConfig(r.s.db, { slots: [{ input: '99' }] });
    await r.tl.tick(0);
    expect(r.tl.status[0].error).toMatch(/No input "99"/);
    setTickerLangsConfig(r.s.db, { slots: [{ input: '30', field: 'headline' }] });
    r.tl.resend();
    await r.tl.tick(2000);
    expect(r.v.calls.at(-1)).toMatch(/SelectedName=Headline\.Text&/);
  });

  it('keeps team codes and sailor names out of the translation, escapes the rest', () => {
    const kept = ['ESP', 'Jordi Xammar', 'Xammar'];
    expect(protect('ESP leads & Jordi Xammar wins <3', kept)).toBe('<x>ESP</x> leads &amp; <x>Jordi Xammar</x> wins &lt;3');
    expect(protect('ESPANA', kept)).toBe('ESPANA');
    expect(unprotect('<x>ESP</x> lidera &amp; <x>Jordi Xammar</x>')).toBe('ESP lidera & Jordi Xammar');
  });

  it('asks DeepL free with the key, XML tags kept', async () => {
    const s = setup();
    seedTeam(s.db, 'ESP', ['Jordi Xammar']);
    setDeeplKey(s.db, 'abc:fx');
    const seen: { url: string; init: any }[] = [];
    const t = deepl(s.db, async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, text: async () => JSON.stringify({ translations: [{ text: '<x>ESP</x> lidera' }] }) }; });
    expect(await t(['ESP leads'], 'PT-BR')).toEqual(['ESP lidera']);
    expect(seen[0].url).toBe('https://api-free.deepl.com/v2/translate');
    expect(seen[0].init.headers.Authorization).toBe('DeepL-Auth-Key abc:fx');
    expect(JSON.parse(seen[0].init.body)).toMatchObject({ text: ['<x>ESP</x> leads'], target_lang: 'PT-BR', source_lang: 'EN', tag_handling: 'xml', ignore_tags: ['x'] });
    const refused = deepl(s.db, async () => ({ ok: false, status: 403, text: async () => '' }));
    await expect(refused(['x'], 'DE')).rejects.toThrow(/refused the key/);
  });
});
