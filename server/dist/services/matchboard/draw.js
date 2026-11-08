/**
 * Matchboard drawing shared by the server (PNG export, @napi-rs/canvas) and the browser (live preview, <canvas>).
 * Pure TypeScript: the caller hands in a 2D context and ready images, so both sides draw the same picture.
 *
 * The board is the artwork from MATCHBOARD-BROADCAST (text, flags and highlights removed: fixtures/matchboard/background.png)
 * with every text field, team row and highlight drawn on top from fixtures/matchboard/layout.json.
 */
import { renderElement } from '../generator/render.js';
/** Geometry of a team row, from the artwork: flag 16.3 × 10.9 at +12.8, code at +34.3 (13 pt rows; scaled for bigger rows). */
export function teamRowGeometry(s) {
    const k = s.size / 13;
    return { flag: { x: s.x + 12.8 * k, y: s.cy + 0.25 - 5.45 * k, w: 16.3 * k, h: 10.9 * k, r: 1.4 * k }, codeX: s.x + 34.3 * k };
}
export function defaultSlotState(s, teamIdByCode) {
    const teamId = s.team ? teamIdByCode.get(s.team.toUpperCase()) ?? null : null;
    return { teamId, text: s.team && !teamId ? s.team : s.text, highlight: false };
}
function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}
/** Weights read off the artwork (text widths against General Sans): team codes and headings semibold, placeholders and region dates medium. */
export const WEIGHT_TEAM = 600;
export const WEIGHT_PLACEHOLDER = 500;
const font = (weight, size, family) => `${weight} ${size}px ${family}`;
/** Draws text in runs: “/” in the grotesk face (as the artwork's “1/32”), everything else in the sans face. */
function drawText(ctx, text, x, baseline, size, weight, align, fonts) {
    const runs = [];
    for (const ch of text) {
        const f = ch === '/' ? font(700, size * 1.027, `${fonts.grotesk}, ${fonts.sans}`) : font(weight, size, `${fonts.sans}, ${fonts.grotesk}`);
        const last = runs[runs.length - 1];
        if (last && last.f === f)
            last.t += ch;
        else
            runs.push({ t: ch, f });
    }
    const widths = runs.map((r) => { ctx.font = r.f; return ctx.measureText(r.t).width; });
    const total = widths.reduce((a, b) => a + b, 0);
    let cx = align === 'left' ? x : align === 'right' ? x - total : x - total / 2;
    runs.forEach((r, i) => { ctx.font = r.f; ctx.fillText(r.t, cx, baseline); cx += widths[i]; });
}
export function drawMatchboard(ctx, input) {
    const { layout, state, teams } = input;
    const fonts = input.fonts ?? { sans: '"General Sans"', grotesk: '"Space Grotesk"' };
    const pr = input.pixelRatio ?? 1;
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    if (input.background)
        ctx.drawImage(input.background, 0, 0, layout.width, layout.height);
    for (const s of layout.slots) {
        const st = state.slots[s.id] ?? { teamId: null, text: s.text, highlight: false };
        const team = st.teamId ? teams.get(st.teamId) ?? null : null;
        if (team && st.highlight && team.gradient && input.highlight) {
            const { variant: _v, ...spec } = input.highlight;
            const w = Math.max(1, Math.round(s.w * pr)), h = Math.max(1, Math.round(s.h * pr));
            const key = `${team.id}|${w}x${h}|${JSON.stringify(spec)}|${JSON.stringify(team.gradient)}|${JSON.stringify(input.strokeGradient)}`;
            let img = input.cache?.get(key);
            if (!img) {
                // the element's own look (radius, waves, stroke) at the row's size
                const k = w / spec.width;
                img = input.toImage(renderElement({ ...spec, width: w, height: h, radius: spec.radius * k, strokeWidth: spec.strokeWidth * k, patternScale: spec.patternScale * k }, team.gradient, 1, spec.strokeGradient ? input.strokeGradient : null));
                input.cache?.set(key, img);
            }
            ctx.drawImage(img, s.x, s.y, s.w, s.h);
        }
        ctx.fillStyle = '#ffffff';
        if (team) {
            const g = teamRowGeometry(s);
            if (team.flag) {
                ctx.save();
                roundRect(ctx, g.flag.x, g.flag.y, g.flag.w, g.flag.h, g.flag.r);
                ctx.clip();
                ctx.drawImage(team.flag, g.flag.x, g.flag.y, g.flag.w, g.flag.h);
                ctx.restore();
                roundRect(ctx, g.flag.x, g.flag.y, g.flag.w, g.flag.h, g.flag.r);
                ctx.strokeStyle = 'rgba(216,225,239,0.9)';
                ctx.lineWidth = 0.3;
                ctx.stroke();
            }
            drawText(ctx, team.code, g.codeX, s.baseline, s.size, WEIGHT_TEAM, 'left', fonts);
        }
        else if (st.text) {
            drawText(ctx, st.text, s.x + s.w / 2, s.baseline, s.size, WEIGHT_PLACEHOLDER, 'center', fonts);
        }
    }
    for (const t of layout.texts) {
        const text = state.texts[t.id] ?? t.text;
        if (!text)
            continue;
        ctx.fillStyle = t.color;
        drawText(ctx, text, t.x, t.baseline, t.size, t.weight ?? WEIGHT_TEAM, t.align, fonts);
    }
    ctx.restore();
}
