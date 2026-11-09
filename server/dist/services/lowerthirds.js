import { z } from 'zod';
import { activeEvent, getSetting, setSetting } from '../db/db.js';
import { badRequest, notFound } from './errors.js';
import { LINEUP_SLOTS, loadLineup } from './lineups.js';
import { listSailors } from './sailors.js';
import { TEAM_SLOTS } from './slots.js';
import { listTeams } from './teams.js';
import { findInput, parseVmixXml, vmixUrl } from './vmixResults.js';
import { stageTeamIds } from './workbookSheets.js';
/**
 * Lower thirds driven from a Stream Deck (Bitfocus Companion) or the dashboard's own keys.
 *
 * One GT title (lowerthird_photo.gtzip / lowerthird_no_photo.gtzip) serves teams and sailors:
 *  - team:   Top text = country, Bottom text = nickname
 *  - sailor: Top text = first + LAST name, Bottom text = number and position, then the best results in turn
 * Bar, Flag, Emblem and PHOTO are images. The dashboard sets the fields through the vMix Web API.
 * When the title is already on air it only changes the fields that differ, so the title's DataChange
 * animations play and the graphic stays up; otherwise it fills the title and brings it in on the overlay.
 */
export const ltConfigSchema = z.object({
    /** vMix input (name or number) of the lower third with a photo */
    photoInput: z.string().max(120),
    /** vMix input of the lower third without a photo: teams, and sailors without a photo */
    noPhotoInput: z.string().max(120),
    overlay: z.number().int().min(1).max(4),
    /** team graphic place used for the Bar field */
    barSlot: z.string().max(40),
    flagSlot: z.string().max(40),
    emblemSlot: z.string().max(40),
    /** a country key also puts that team's lower third on air (otherwise it only picks the team) */
    countryShowsTeam: z.boolean(),
    /** Companion address for the key labels, e.g. http://127.0.0.1:8000 ('' = do not send labels) */
    companionUrl: z.string().max(200),
    companionPage: z.number().int().min(1).max(99),
    rows: z.number().int().min(1).max(8),
    cols: z.number().int().min(1).max(8),
    fields: z.object({ top: z.string().max(60), bottom: z.string().max(60), photo: z.string().max(60), flag: z.string().max(60), emblem: z.string().max(60), bar: z.string().max(60) }),
});
export const DEFAULT_LT = {
    photoInput: 'lowerthird_photo', noPhotoInput: 'lowerthird_no_photo', overlay: 1,
    barSlot: 'lowerthird_photo', flagSlot: 'flag_big', emblemSlot: 'emblem_light', countryShowsTeam: false,
    companionUrl: '', companionPage: 1, rows: 4, cols: 8,
    fields: { top: 'Top text', bottom: 'Bottom text', photo: 'PHOTO', flag: 'Flag', emblem: 'Emblem', bar: 'Bar' },
};
const CONFIG_KEY = 'lt.config';
export function getLtConfig(db) {
    try {
        const saved = JSON.parse(getSetting(db, CONFIG_KEY) || '{}');
        return ltConfigSchema.parse({ ...DEFAULT_LT, ...saved, fields: { ...DEFAULT_LT.fields, ...(saved.fields ?? {}) } });
    }
    catch {
        return DEFAULT_LT;
    }
}
export function setLtConfig(db, patch) {
    const cur = getLtConfig(db);
    const next = ltConfigSchema.parse({ ...cur, ...patch, fields: { ...cur.fields, ...(patch.fields ?? {}) } });
    if (!TEAM_SLOTS.some((s) => s.key === next.barSlot))
        throw badRequest('Unknown team graphic for the bar.');
    next.companionUrl = next.companionUrl.trim().replace(/\/+$/, '');
    if (next.companionUrl && !/^https?:\/\/[^\s/]+(:\d+)?$/i.test(next.companionUrl))
        throw badRequest('Companion address must look like http://127.0.0.1:8000');
    setSetting(db, CONFIG_KEY, JSON.stringify(next));
    return next;
}
const img = (a) => (a ? a.vmixPath ?? a.storedPath ?? a.enteredPath ?? '' : '');
/** Teams with keys: the current stage's teams in stage order, else every team by code. */
export function ltTeams(ctx) {
    const all = listTeams(ctx);
    const ids = stageTeamIds(ctx.db, activeEvent(ctx.db).id);
    const list = ids ? ids.map((id) => all.find((t) => t.id === id)).filter((t) => !!t)
        : [...all].sort((a, b) => a.code.localeCompare(b.code));
    return list.map((t) => ({ id: t.id, code: t.code, name: t.name }));
}
/** Who sails on each place of the team's line-up today, with photo and best results. */
export function crewOf(ctx, teamId) {
    const lineup = loadLineup(ctx.db, activeEvent(ctx.db).id, teamId).data;
    const sailors = new Map(listSailors(ctx, teamId).map((s) => [s.id, s]));
    return LINEUP_SLOTS.map((d) => {
        const r = lineup.rows.find((x) => x.slot === d.key);
        const s = r?.sailorId ? sailors.get(r.sailorId) : undefined;
        return {
            slot: d.key, label: d.label, sailorId: r?.sailorId ?? null,
            firstName: r?.firstName || s?.firstName || '', lastName: r?.lastName || s?.lastName || '',
            number: r?.number || s?.defaultNumber || '', position: r?.position || d.position,
            photo: img(s?.photo), best: [s?.bestResult1, s?.bestResult2, s?.bestResult3].map((b) => (b ?? '').trim()).filter(Boolean),
        };
    });
}
const fullName = (s) => [s.firstName.trim(), s.lastName.trim().toUpperCase()].filter(Boolean).join(' ');
/** The lines Bottom text cycles through for a sailor: number and position first, then each best result. */
export const sailorLines = (s) => [[s.number, s.position.toUpperCase()].filter(Boolean).join('  I  '), ...s.best].filter(Boolean);
const STATE_KEY = 'lt.state';
export function getLtState(db) {
    try {
        return { kind: null, teamId: null, slot: null, line: 0, onAir: false, input: '', ...JSON.parse(getSetting(db, STATE_KEY) || '{}') };
    }
    catch {
        return { kind: null, teamId: null, slot: null, line: 0, onAir: false, input: '' };
    }
}
const saveState = (db, s) => setSetting(db, STATE_KEY, JSON.stringify(s));
/** Field values for a team or a sailor, keyed by the title's field names (`Top text.Text`, `PHOTO.Source`…). */
export function ltFields(ctx, cfg, teamId, sailor, line = 0) {
    const team = listTeams(ctx).find((t) => t.id === teamId);
    if (!team)
        throw notFound('Team');
    const a = team.assets;
    const f = new Map();
    f.set(`${cfg.fields.bar}.Source`, img(a[cfg.barSlot]));
    f.set(`${cfg.fields.flag}.Source`, img(a[cfg.flagSlot]));
    f.set(`${cfg.fields.emblem}.Source`, img(a[cfg.emblemSlot]));
    if (sailor) {
        const lines = sailorLines(sailor);
        f.set(`${cfg.fields.top}.Text`, fullName(sailor));
        f.set(`${cfg.fields.bottom}.Text`, lines.length ? lines[line % lines.length] : '');
        f.set(`${cfg.fields.photo}.Source`, sailor.photo);
    }
    else {
        f.set(`${cfg.fields.top}.Text`, team.name.toUpperCase());
        f.set(`${cfg.fields.bottom}.Text`, (team.nickname || '').toUpperCase());
    }
    return f;
}
/** What was last sent to each input, so on air only the changed fields are set (each change animates). */
const sent = new Map();
export class LowerThirds {
    ctx;
    fetcher;
    log;
    labels = new Map();
    timer = null;
    constructor(ctx, fetcher = fetch, log = () => { }) {
        this.ctx = ctx;
        this.fetcher = fetcher;
        this.log = log;
    }
    get config() { return getLtConfig(this.ctx.db); }
    get state() { return getLtState(this.ctx.db); }
    async vmix(q) {
        const base = vmixUrl(this.ctx.db);
        let res;
        try {
            res = await this.fetcher(`${base}/api/${q}`, { signal: AbortSignal.timeout(4000) });
        }
        catch {
            throw badRequest(`vMix does not answer at ${base}. Turn on Settings → Web Controller in vMix and check the address in Settings here.`);
        }
        if (!res.ok)
            throw badRequest(`vMix answered ${res.status} for ${decodeURIComponent(q).slice(0, 80)}`);
        return res.text();
    }
    /** The input that is on the overlay channel now (vMix XML <overlay number="1">5</overlay>). */
    static onOverlay(xml, overlay) {
        return xml.match(new RegExp(`<overlay number="${overlay}"[^>]*>(\\d+)</overlay>`))?.[1] ?? '';
    }
    async show(inputName, fields, next) {
        const cfg = this.config;
        if (!inputName.trim())
            throw badRequest('Set the vMix inputs of the lower thirds on the Lower thirds tab.');
        const xml = await this.vmix('');
        const input = findInput(parseVmixXml(xml), inputName);
        if (!input)
            throw badRequest(`vMix has no input “${inputName}”. Add the lower third GTZIP to vMix or fix the name on the Lower thirds tab.`);
        const onAir = LowerThirds.onOverlay(xml, cfg.overlay) === input.number;
        const has = new Set(input.fields);
        const id = input.key || input.number;
        const last = sent.get(id) ?? new Map();
        let changed = 0;
        for (const [name, value] of fields) {
            if (!has.has(name))
                continue;
            if (onAir && last.get(name) === value)
                continue; // unchanged: no animation
            await this.vmix(`?Function=${name.endsWith('.Source') ? 'SetImage' : 'SetText'}&Input=${encodeURIComponent(id)}&SelectedName=${encodeURIComponent(name)}&Value=${encodeURIComponent(value)}`);
            last.set(name, value);
            changed++;
        }
        sent.set(id, last);
        if (!onAir)
            await this.vmix(`?Function=OverlayInput${cfg.overlay}In&Input=${encodeURIComponent(id)}`);
        const state = { ...next, onAir: true, input: input.title };
        saveState(this.ctx.db, state);
        void this.pushLabels();
        return { ...state, changed, cameIn: !onAir };
    }
    teamByCode(code) {
        const t = listTeams(this.ctx).find((x) => x.code.toLowerCase() === code.trim().toLowerCase() || x.id === code);
        if (!t)
            throw notFound(`Team ${code}`);
        return t;
    }
    /** Pick a team (country key). Puts its lower third on air when the settings say so. */
    async pickTeam(code) {
        const t = this.teamByCode(code);
        const cfg = this.config;
        if (cfg.countryShowsTeam)
            return this.showTeam(t.code);
        saveState(this.ctx.db, { ...this.state, teamId: t.id });
        void this.pushLabels();
        return this.state;
    }
    async showTeam(code) {
        const t = this.teamByCode(code);
        const cfg = this.config;
        return this.show(cfg.noPhotoInput || cfg.photoInput, ltFields(this.ctx, cfg, t.id, null), { kind: 'team', teamId: t.id, slot: null, line: 0 });
    }
    /** The sailor on a place of the line-up (`Pit`, `Trimmer1`…, or the place's label/position, any case). */
    async showSailor(code, place) {
        const teamId = code ? this.teamByCode(code).id : this.state.teamId;
        if (!teamId)
            throw badRequest('Pick a country first.');
        const p = place.trim().toLowerCase().replace(/\s+/g, '');
        const crew = crewOf(this.ctx, teamId);
        const s = crew.find((x) => x.slot.toLowerCase() === p || x.label.toLowerCase().replace(/\s+/g, '') === p) ?? crew[Number(p) - 1];
        if (!s)
            throw notFound(`Place ${place}`);
        if (!s.firstName && !s.lastName)
            throw badRequest(`Nobody on ${s.label} in this team's line-up.`);
        const cfg = this.config;
        const input = s.photo && cfg.photoInput ? cfg.photoInput : cfg.noPhotoInput || cfg.photoInput;
        return this.show(input, ltFields(this.ctx, cfg, teamId, s, 0), { kind: 'sailor', teamId, slot: s.slot, line: 0 });
    }
    /** Next line under the sailor's name: position → best result 1 → 2 → 3 → position, only that field changes. */
    async nextLine() {
        const st = this.state;
        if (st.kind !== 'sailor' || !st.teamId || !st.slot)
            throw badRequest('Show a sailor first.');
        const s = crewOf(this.ctx, st.teamId).find((x) => x.slot === st.slot);
        if (!s)
            throw badRequest('Show a sailor first.');
        const lines = sailorLines(s);
        const line = lines.length ? (st.line + 1) % lines.length : 0;
        const cfg = this.config;
        const input = s.photo && cfg.photoInput ? cfg.photoInput : cfg.noPhotoInput || cfg.photoInput;
        return this.show(input, ltFields(this.ctx, cfg, st.teamId, s, line), { kind: 'sailor', teamId: st.teamId, slot: s.slot, line });
    }
    async out() {
        const cfg = this.config;
        await this.vmix(`?Function=OverlayInput${cfg.overlay}Out`);
        const st = { ...this.state, onAir: false };
        saveState(this.ctx.db, st);
        void this.pushLabels();
        return st;
    }
    // ---------- keys ----------
    /** The key layout: countries, then the line-up places, then TEAM / NEXT / OUT; a new group starts on a new row. */
    layout() {
        const cfg = this.config;
        const st = this.state;
        const teams = ltTeams(this.ctx);
        const team = teams.find((t) => t.id === st.teamId) ?? null;
        const crew = team ? crewOf(this.ctx, team.id) : [];
        const groups = [
            teams.map((t) => ({ action: `team:${t.code}`, text: t.code, active: t.id === st.teamId, onAir: st.onAir && st.kind === 'team' && st.teamId === t.id })),
            LINEUP_SLOTS.map((d) => {
                const s = crew.find((x) => x.slot === d.key);
                return { action: `place:${d.key}`, text: `${d.label.toUpperCase()}\\n${s?.lastName.toUpperCase() || '—'}`, active: false, onAir: st.onAir && st.kind === 'sailor' && st.slot === d.key };
            }),
            [
                { action: 'showteam', text: team ? `TEAM\\n${team.code}` : 'TEAM', active: false, onAir: false },
                { action: 'next', text: 'NEXT\\nRESULT', active: false, onAir: false },
                { action: 'out', text: 'OUT', active: false, onAir: st.onAir },
            ],
        ];
        // lay the groups out on pages of rows × cols
        const pages = [];
        let page = [], row = 0, col = 0;
        const flushPage = () => { pages.push(page); page = []; row = 0; col = 0; };
        for (const g of groups) {
            if (col > 0) {
                row++;
                col = 0;
            }
            if (row >= cfg.rows)
                flushPage();
            for (const k of g) {
                if (col >= cfg.cols) {
                    row++;
                    col = 0;
                }
                if (row >= cfg.rows)
                    flushPage();
                page.push({ ...k, page: cfg.companionPage + pages.length, row, col });
                col++;
            }
        }
        if (page.length)
            pages.push(page);
        return pages;
    }
    async press(page, row, col) {
        const key = this.layout().flat().find((k) => k.page === page && k.row === row && k.col === col);
        if (!key)
            return { ok: true, nothing: true };
        return this.run(key.action);
    }
    async run(action) {
        const [kind, arg] = action.split(':');
        if (kind === 'team')
            return this.pickTeam(arg);
        if (kind === 'place')
            return this.showSailor(null, arg);
        if (kind === 'showteam') {
            const id = this.state.teamId;
            if (!id)
                throw badRequest('Pick a country first.');
            return this.showTeam(listTeams(this.ctx).find((t) => t.id === id).code);
        }
        if (kind === 'next')
            return this.nextLine();
        if (kind === 'out')
            return this.out();
        throw badRequest(`Unknown key action ${action}`);
    }
    /**
     * Writes the key texts and colours into Companion (HTTP remote control: POST /api/location/page/row/col/style),
     * only for keys that changed since the last time.
     */
    async pushLabels(force = false) {
        const cfg = this.config;
        if (!cfg.companionUrl)
            return { sent: 0 };
        if (force)
            this.labels.clear();
        let n = 0;
        try {
            for (const k of this.layout().flat()) {
                const bg = k.onAir ? '#b91c1c' : k.active ? '#d97706' : k.action.startsWith('team:') ? '#1e3a5f' : k.action.startsWith('place:') ? '#27303f' : '#3f3f46';
                const q = `text=${encodeURIComponent(k.text)}&bgcolor=${encodeURIComponent(bg)}&color=${encodeURIComponent('#ffffff')}&size=auto`;
                const id = `${k.page}/${k.row}/${k.col}`;
                if (this.labels.get(id) === q)
                    continue;
                const res = await this.fetcher(`${cfg.companionUrl}/api/location/${id}/style?${q}`, { method: 'POST', signal: AbortSignal.timeout(3000) });
                if (res.ok) {
                    this.labels.set(id, q);
                    n++;
                }
            }
        }
        catch (e) {
            this.log(`Companion labels: ${e?.message ?? e}`);
        }
        return { sent: n };
    }
    /** Keeps the labels in step with line-up changes made elsewhere. */
    start(ms = 15000) { this.timer = setInterval(() => { void this.pushLabels(); }, ms); this.timer.unref?.(); }
    stop() { if (this.timer)
        clearInterval(this.timer); }
}
