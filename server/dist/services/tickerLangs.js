import { z } from 'zod';
import { getSetting, nowIso, setSetting } from '../db/db.js';
import { badRequest } from './errors.js';
import { repeatLoop } from './graphicSets.js';
import { findInput, parseVmixXml, titleFieldMatcher } from './vmixResults.js';
/**
 * TICKER LANGUAGES: the bottom ticker's messages translated (DeepL) and written into a ticker title on another vMix
 * (the streaming PC), one slot per language. Only the text: overlays and everything else there stay with its operator.
 * A deliberate, narrow exception to "the dashboard talks to one vMix": its own module, its own 4 s timeouts; a
 * streaming PC or DeepL that does not answer leaves the local ticker and every key as they are (the slot shows it).
 */
/** DeepL's target languages (https://developers.deepl.com/docs/getting-started/supported-languages). */
export const DEEPL_LANGUAGES = [
    ['AR', 'Arabic'], ['BG', 'Bulgarian'], ['CS', 'Czech'], ['DA', 'Danish'], ['DE', 'German'], ['EL', 'Greek'],
    ['EN-GB', 'English (British)'], ['EN-US', 'English (American)'], ['ES', 'Spanish'], ['ES-419', 'Spanish (Latin American)'],
    ['ET', 'Estonian'], ['FI', 'Finnish'], ['FR', 'French'], ['HE', 'Hebrew'], ['HU', 'Hungarian'], ['ID', 'Indonesian'],
    ['IT', 'Italian'], ['JA', 'Japanese'], ['KO', 'Korean'], ['LT', 'Lithuanian'], ['LV', 'Latvian'], ['NB', 'Norwegian'],
    ['NL', 'Dutch'], ['PL', 'Polish'], ['PT-BR', 'Portuguese (Brazilian)'], ['PT-PT', 'Portuguese (European)'],
    ['RO', 'Romanian'], ['RU', 'Russian'], ['SK', 'Slovak'], ['SL', 'Slovenian'], ['SV', 'Swedish'], ['TH', 'Thai'],
    ['TR', 'Turkish'], ['UK', 'Ukrainian'], ['VI', 'Vietnamese'], ['ZH-HANS', 'Chinese (simplified)'], ['ZH-HANT', 'Chinese (traditional)'],
].map(([code, name]) => ({ code, name }));
const LANG_CODES = new Set(DEEPL_LANGUAGES.map((l) => l.code));
const slotSchema = z.object({
    on: z.boolean().default(false),
    lang: z.string().default(''),
    /** the streaming vMix: http://192.168.110.217:8088 */
    host: z.string().default(''),
    /** its ticker input: number, name or key */
    input: z.string().default(''),
    /** the text field ('' = found by itself: the first .Text named ticker/text, else the first .Text) */
    field: z.string().default(''),
});
const configSchema = z.object({ enabled: z.boolean().default(false), slots: z.array(slotSchema).max(5).default([]) });
/** The streaming PCs as given by production: Language 2–6. */
const DEFAULT_SLOTS = [
    { on: true, lang: 'PT-BR', host: 'http://192.168.110.217:8088', input: '30', field: '' },
    { on: false, lang: '', host: 'http://192.168.110.217:8088', input: '31', field: '' },
    { on: false, lang: '', host: 'http://192.168.110.105:8088', input: '34', field: '' },
    { on: false, lang: '', host: 'http://192.168.110.105:8088', input: '35', field: '' },
    { on: false, lang: '', host: 'http://192.168.110.105:8088', input: '36', field: '' },
];
const CFG = 'tickerLangs.config';
const KEY = 'tickerLangs.deeplKey';
export function getTickerLangsConfig(db) {
    let raw = {};
    try {
        raw = JSON.parse(getSetting(db, CFG) || '{}');
    }
    catch { /* a broken value: the defaults */ }
    const c = configSchema.parse(raw ?? {});
    const slots = DEFAULT_SLOTS.map((d, i) => ({ ...d, ...(c.slots[i] ?? {}) }));
    return { enabled: c.enabled, slots };
}
export function setTickerLangsConfig(db, patch) {
    const p = z.object({ enabled: z.boolean().optional(), slots: z.array(z.object({ on: z.boolean(), lang: z.string(), host: z.string(), input: z.string(), field: z.string() }).partial()).max(5).optional() }).parse(patch ?? {});
    const cur = getTickerLangsConfig(db);
    const next = { enabled: p.enabled ?? cur.enabled, slots: p.slots ? cur.slots.map((s, i) => ({ ...s, ...(p.slots[i] ?? {}) })) : cur.slots };
    for (const s of next.slots) {
        s.lang = s.lang.trim().toUpperCase();
        if (s.lang && !LANG_CODES.has(s.lang))
            throw badRequest(`DeepL does not translate into "${s.lang}".`);
        s.host = s.host.trim().replace(/\/+$/, '').replace(/\/api$/i, '');
        if (s.host && !/^https?:\/\//i.test(s.host))
            s.host = `http://${s.host}`;
        if (s.host && !/^https?:\/\/[^\s/]+(:\d+)?$/i.test(s.host))
            throw badRequest('A vMix address must look like http://192.168.110.217:8088');
        if (s.host && !/:\d+$/.test(s.host))
            s.host += ':8088';
        s.input = s.input.trim();
        s.field = s.field.trim();
    }
    setSetting(db, CFG, JSON.stringify(next));
    return next;
}
export const hasDeeplKey = (db) => !!getSetting(db, KEY);
export function setDeeplKey(db, key) { setSetting(db, KEY, key.trim()); }
// ---------- translations: kept per message and language; a correction by hand wins ----------
export function storedTranslation(db, source, lang) {
    return db.prepare('SELECT text, manual FROM ticker_translations WHERE source = ? AND lang = ?').get(source, lang);
}
function storeTranslation(db, source, lang, text, manual) {
    db.prepare(`INSERT INTO ticker_translations (source, lang, text, manual, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source, lang) DO UPDATE SET text = excluded.text, manual = excluded.manual, updated_at = excluded.updated_at
    WHERE ticker_translations.manual = 0 OR excluded.manual = 1`).run(source, lang, text, manual ? 1 : 0, nowIso());
}
/** A correction typed by hand; '' = back to the machine translation (made again on the next round). */
export function setManualTranslation(db, source, lang, text) {
    if (!text.trim()) {
        db.prepare('DELETE FROM ticker_translations WHERE source = ? AND lang = ?').run(source, lang);
        return;
    }
    storeTranslation(db, source, lang, text.trim(), true);
}
/** Team codes and sailors' names stay as they are in every language (numbers and times DeepL leaves alone). */
export function keptWords(db) {
    const codes = db.prepare("SELECT code FROM teams WHERE length(code) >= 2").all().map((r) => r.code);
    const names = db.prepare("SELECT first_name, last_name FROM sailors WHERE is_demo = 0").all()
        .flatMap((r) => [`${r.first_name} ${r.last_name}`.trim(), r.last_name.trim()]).filter((n) => n.length >= 3);
    return [...new Set([...codes, ...names])].sort((a, b) => b.length - a.length);
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
/** The message as DeepL XML: the kept words in <x> (ignore_tags), everything else escaped. */
export function protect(text, kept) {
    const x = esc(text);
    if (!kept.length)
        return x;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(${kept.map((k) => esc(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
    return x.replace(re, '<x>$1</x>');
}
export const unprotect = (xml) => unesc(xml.replace(/<\/?x>/g, ''));
async function timed(ms, f) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
        return await f(ac.signal);
    }
    finally {
        clearTimeout(t);
    }
}
/** DeepL API: a free key ends with :fx and goes to api-free.deepl.com. */
export function deepl(db, fetcher) {
    return async (texts, lang) => {
        const key = getSetting(db, KEY);
        if (!key)
            throw new Error('No DeepL key: enter it under Ticker languages.');
        const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
        const kept = keptWords(db);
        const res = await timed(8000, (signal) => fetcher(`${host}/v2/translate`, {
            method: 'POST', signal,
            headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: texts.map((t) => protect(t, kept)), target_lang: lang, source_lang: 'EN', tag_handling: 'xml', ignore_tags: ['x'] }),
        })).catch((e) => { throw new Error(e?.name === 'AbortError' ? 'DeepL did not answer (no internet?).' : `Cannot reach DeepL: ${e?.message ?? e}`); });
        if (res.status === 403)
            throw new Error('DeepL refused the key.');
        if (res.status === 456)
            throw new Error('The DeepL characters for this month are used up.');
        if (!res.ok)
            throw new Error(`DeepL answered HTTP ${res.status}.`);
        const out = JSON.parse(await res.text());
        if (out.translations?.length !== texts.length)
            throw new Error('DeepL answered without the translations.');
        return out.translations.map((t) => unprotect(t.text));
    };
}
/** The ticker in capitals as on the local one, in the language's own capitals (Turkish İ). */
const upper = (s, lang) => { try {
    return s.toLocaleUpperCase(lang.split('-')[0].toLowerCase());
}
catch {
    return s.toUpperCase();
} };
/** Every round (2 s): the English messages now on the local ticker; each slot's text is written only when it differs. */
export class TickerLangs {
    db;
    source;
    fetcher;
    translate;
    log;
    status = [];
    /** the English messages of the last round, with their translations, for Show control */
    current = { messages: [], sep: '' };
    sent = new Map();
    checkedAt = new Map();
    failedAt = new Map();
    busy = false;
    timer = null;
    /** a streaming vMix is read again this often to bring back the text after a restart */
    checkMs = 15_000;
    retryMs = 30_000;
    constructor(db, source, fetcher = fetch, translate = deepl(db, fetcher), log = () => { }) {
        this.db = db;
        this.source = source;
        this.fetcher = fetcher;
        this.translate = translate;
        this.log = log;
    }
    start(ms = 2000) { this.timer = setInterval(() => { void this.tick(); }, ms); this.timer.unref?.(); }
    stop() { if (this.timer)
        clearInterval(this.timer); }
    /** Send every slot again on the next round (after a change of the slots, or the SEND NOW button). */
    resend() { this.sent.clear(); this.checkedAt.clear(); this.failedAt.clear(); }
    /** Each message in one language: from the store, else translated now (all missing ones in one call). */
    async translated(messages, lang, now) {
        const missing = messages.filter((m) => !storedTranslation(this.db, m, lang));
        if (missing.length) {
            const failed = this.failedAt.get(lang);
            if (failed !== undefined && now - failed < this.retryMs)
                throw new Error(this.lastError.get(lang) ?? 'DeepL failed.');
            try {
                const out = await this.translate([...new Set(missing)], lang);
                [...new Set(missing)].forEach((m, i) => storeTranslation(this.db, m, lang, out[i], false));
                this.failedAt.delete(lang);
            }
            catch (e) {
                this.failedAt.set(lang, now);
                this.lastError.set(lang, String(e?.message ?? e));
                throw e;
            }
        }
        return messages.map((m) => storedTranslation(this.db, m, lang).text);
    }
    lastError = new Map();
    async tick(now = Date.now()) {
        const cfg = getTickerLangsConfig(this.db);
        if (!cfg.enabled || this.busy) {
            if (!cfg.enabled)
                this.status = [];
            return;
        }
        this.busy = true;
        try {
            const src = await this.source().catch(() => null);
            if (src)
                this.current = src;
            const status = [];
            const reads = new Map();
            const read = (host) => {
                if (!reads.has(host))
                    reads.set(host, timed(4000, (signal) => this.fetcher(`${host}/api/`, { signal })).then(async (r) => {
                        if (!r.ok)
                            throw new Error(`vMix at ${host} answered HTTP ${r.status}.`);
                        return parseVmixXml(await r.text());
                    }, (e) => { throw new Error(e?.name === 'AbortError' ? `vMix at ${host} does not answer.` : `Cannot reach vMix at ${host}: ${e?.message ?? e}`); }));
                return reads.get(host);
            };
            for (const [i, s] of cfg.slots.entries()) {
                const prev = this.status.find((x) => x.slot === i + 1);
                const st = { slot: i + 1, lang: s.lang, on: s.on, input: prev?.input ?? '', field: prev?.field ?? '', text: this.sent.get(i) ?? '', sentAt: prev?.sentAt ?? null, error: '' };
                status.push(st);
                if (!s.on || !s.lang || !s.host || !s.input)
                    continue;
                // no ticker text read (local vMix off) or an empty ticker: the streaming PC keeps what it has
                if (!src || !src.messages.length)
                    continue;
                try {
                    const text = upper(repeatLoop((await this.translated(src.messages, s.lang, now)).join(src.sep) + src.sep), s.lang);
                    // diff-only: written when the text changed, and checked against the streaming vMix now and then
                    if (this.sent.get(i) === text && now - (this.checkedAt.get(i) ?? 0) < this.checkMs)
                        continue;
                    const inputs = await read(s.host);
                    const input = findInput(inputs, s.input);
                    if (!input)
                        throw new Error(`No input "${s.input}" in vMix at ${s.host}.`);
                    const texts = input.fields.filter((f) => f.endsWith('.Text'));
                    const field = s.field ? titleFieldMatcher(input.fields)(s.field.endsWith('.Text') ? s.field : `${s.field}.Text`) ?? (s.field.endsWith('.Text') ? s.field : `${s.field}.Text`)
                        : texts.find((f) => /ticker/i.test(f)) ?? texts.find((f) => /text/i.test(f.replace(/\.Text$/, ""))) ?? texts[0];
                    if (!field)
                        throw new Error(`Input "${input.title}" in vMix at ${s.host} has no text field.`);
                    st.input = `${input.number} ${input.title}`;
                    st.field = field;
                    if (input.values?.[field] !== text) {
                        const r = await timed(4000, (signal) => this.fetcher(`${s.host}/api/?Function=SetText&Input=${encodeURIComponent(input.key || input.number)}&SelectedName=${encodeURIComponent(field)}&Value=${encodeURIComponent(text)}`, { signal }))
                            .catch((e) => { throw new Error(e?.name === 'AbortError' ? `vMix at ${s.host} does not answer.` : `Cannot reach vMix at ${s.host}: ${e?.message ?? e}`); });
                        if (!r.ok)
                            throw new Error(`vMix at ${s.host} answered HTTP ${r.status}.`);
                        st.sentAt = nowIso();
                    }
                    this.sent.set(i, text);
                    this.checkedAt.set(i, now);
                    st.text = text;
                }
                catch (e) {
                    st.error = String(e?.message ?? e);
                    if (st.error !== prev?.error)
                        this.log(`Ticker language ${i + 2} (${s.lang}): ${st.error}`);
                    this.checkedAt.delete(i);
                }
            }
            this.status = status;
        }
        finally {
            this.busy = false;
        }
    }
    view() {
        const cfg = getTickerLangsConfig(this.db);
        const langs = [...new Set(cfg.slots.filter((s) => s.lang).map((s) => s.lang))];
        return {
            config: cfg, hasKey: hasDeeplKey(this.db), languages: DEEPL_LANGUAGES, status: this.status,
            messages: this.current.messages.map((m) => ({ source: m, translations: Object.fromEntries(langs.map((l) => { const t = storedTranslation(this.db, m, l); return [l, t ? { text: t.text, manual: !!t.manual } : null]; })) })),
        };
    }
}
