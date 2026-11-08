import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { getSetting, nowIso, setSetting } from '../db/db.js';
import { badRequest } from './errors.js';
/**
 * SSL nation ranking from worldofsailors.com: one row per nation with its global position and SSL points
 * (points are a sum of athlete ranks, lower is better). Teams keep the source value in ranking_src and
 * an operator value in ranking_ovr; the effective ranking is the operator value when set.
 */
export const RANKING_URL = 'https://worldofsailors.com/ranking/nation';
const key = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
/** Names the ranking uses that differ from our team names (keyed by team code). */
const NATION_ALIASES = {
    USA: ['UNITED STATES', 'UNITED STATES OF AMERICA'],
    GBR: ['GREAT BRITAIN', 'UNITED KINGDOM'],
    KOR: ['KOREA, REPUBLIC OF', 'SOUTH KOREA', 'KOREA'],
    TUR: ['TURKIYE', 'TURKEY'],
    CZE: ['CZECH REPUBLIC', 'CZECHIA'],
    VEN: ['VENEZUELA, BOLIVARIAN REPUBLIC OF', 'VENEZUELA'],
    RUS: ['RUSSIAN FEDERATION', 'RUSSIA'],
    UAE: ['UNITED ARAB EMIRATES'],
    ISV: ['VIRGIN ISLANDS, U.S.'],
    IVB: ['BRITISH VIRGIN ISLANDS'],
    TPE: ['TAIWAN'],
    IRI: ['IRAN, ISLAMIC REPUBLIC OF'],
    MDA: ['MOLDOVA, REPUBLIC OF'],
    TAN: ['TANZANIA, UNITED REPUBLIC OF'],
    BOL: ['BOLIVIA, PLURINATIONAL STATE OF'],
    BRU: ['BRUNEI DARUSSALAM'],
    PRK: ['KOREA, DEMOCRATIC PEOPLE\'S REPUBLIC OF'],
    ANT: ['ANTIGUA AND BARBUDA', 'ANTIGUA'],
    MKD: ['NORTH MACEDONIA'],
};
const num = (s) => { const m = s.replace(/[\s.,](?=\d{3}\b)/g, '').match(/\d+/); return m ? Number(m[0]) : null; };
/**
 * Reads the ranking table. Columns are found by header text (rank / country or name / pts); if the page
 * has no such table, the visible text is read as "NN NN NATION POINTS" lines, the way the page shows them.
 */
export function parseNationRanking(html) {
    const $ = cheerio.load(html);
    const rows = [];
    $('table').each((_, table) => {
        if (rows.length)
            return;
        let cols = null;
        $(table).find('tr').each((__, tr) => {
            const cells = $(tr).children('th,td').toArray().map((c) => $(c).text().replace(/\s+/g, ' ').trim());
            if (!cols) {
                const low = cells.map((c) => c.toLowerCase());
                const nation = low.findIndex((c) => /country|nation/.test(c));
                const pts = low.findIndex((c) => /pts|points/.test(c));
                const pos = low.findIndex((c) => /rank|^n[°º]?$|^#$|pos/.test(c));
                if (nation >= 0 && pts >= 0)
                    cols = { pos: pos >= 0 ? pos : 0, nation, pts };
                return;
            }
            const p = num(cells[cols.pos] ?? ''), n = (cells[cols.nation] ?? '').replace(/^\d+\s+/, '').trim();
            if (p && n && /[A-Za-z]/.test(n))
                rows.push({ position: p, nation: n, points: num(cells[cols.pts] ?? '') });
        });
    });
    if (rows.length)
        return rows;
    // Text fallback: "01 01 GREAT BRITAIN 53" (position twice, optional movement number, nation in capitals, points).
    $('script,style,noscript').remove();
    $('body *').each((_, el) => { $(el).append(' '); }); // elements are separate words, not glued text
    const text = $('body').text().replace(/\s+/g, ' ');
    const re = /(?:^|\s)(\d{1,3})\s+\1\s+(?:\d{1,3}\s+)?([A-Z][A-Z .,'()&-]*[A-Z.)])\s+(\d[\d,.]*)(?=\s|$)/g;
    const seen = new Set();
    for (const m of text.matchAll(re)) {
        const position = Number(m[1]);
        if (seen.has(position))
            continue;
        seen.add(position);
        rows.push({ position, nation: m[2].trim(), points: num(m[3]) });
    }
    return rows;
}
export async function fetchNationRanking(url = RANKING_URL) {
    const res = await fetch(url, { headers: { 'User-Agent': 'ssl-vmix-dashboard', Accept: 'text/html' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok)
        throw badRequest(`The ranking page answered ${res.status} ${res.statusText}.`);
    const rows = parseNationRanking(await res.text());
    if (rows.length < 10)
        throw badRequest('The ranking table was not found on the page (its layout may have changed). Enter rankings by hand meanwhile.');
    return rows;
}
export function loadRankingSnapshot() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const p of [path.join(here, '..', '..', 'fixtures', 'nation-ranking.json'), path.join(here, '..', 'fixtures', 'nation-ranking.json')]) {
        if (fs.existsSync(p))
            return JSON.parse(fs.readFileSync(p, 'utf8')).rows;
    }
    return [];
}
/** Writes source ranking values onto the teams they belong to (matched by name, alias or known ranking name). */
export function applyRanking(db, rows, source, fetchedAt = nowIso()) {
    const byName = new Map(rows.map((r) => [key(r.nation), r]));
    const teams = db.prepare('SELECT id, code, name, aliases FROM teams').all();
    const res = { rows: rows.length, matched: 0, teamsWithoutRanking: [], fetchedAt, source };
    const upd = db.prepare('UPDATE teams SET ranking_src = ?, ranking_points_src = ?, ranking_fetched_at = ? WHERE id = ?');
    db.transaction(() => {
        for (const t of teams) {
            let aliases = [];
            try {
                aliases = JSON.parse(t.aliases);
            }
            catch { /* none */ }
            const names = [t.name, ...aliases, ...(NATION_ALIASES[t.code.toUpperCase()] ?? [])];
            const hit = names.map((n) => byName.get(key(n))).find(Boolean);
            if (!hit) {
                res.teamsWithoutRanking.push(t.code);
                continue;
            }
            upd.run(String(hit.position), hit.points === null ? null : String(hit.points), fetchedAt, t.id);
            res.matched++;
        }
    })();
    setSetting(db, 'ranking.lastResult', JSON.stringify(res));
    return res;
}
export async function refreshRanking(db) {
    return applyRanking(db, await fetchNationRanking(), 'live');
}
/** On start: fill from the bundled snapshot once (works offline), then try the live page in the background. */
export function rankingOnStart(db, log) {
    if (getSetting(db, 'ranking.snapshot') !== 'nation-ranking-2026-11-08' && db.prepare('SELECT 1 FROM teams LIMIT 1').get()) {
        applyRanking(db, loadRankingSnapshot(), 'snapshot');
        setSetting(db, 'ranking.snapshot', 'nation-ranking-2026-11-08');
    }
    const run = () => refreshRanking(db).then((r) => log(`Nation ranking updated: ${r.matched} teams.`)).catch((e) => log(`Nation ranking not updated: ${e.message}`));
    void run();
    const timer = setInterval(run, 6 * 60 * 60 * 1000);
    timer.unref();
    return () => clearInterval(timer);
}
export function lastRankingResult(db) {
    try {
        return JSON.parse(getSetting(db, 'ranking.lastResult'));
    }
    catch {
        return null;
    }
}
