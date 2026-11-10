/**
 * "Standard animation": one click gives a title the SSL house animations, worked out from the finals GTZIPs.
 *
 * The pattern in those titles:
 *  - every easing is CubicEasingInOut, durations 0.4–0.75 s, a whole In under ~1.3 s;
 *  - boards: the background Reveals from the Top (0.75), the header Flies in and Fades (0.65 / 0.5),
 *    rows follow one after another 0.05 s apart, sponsors Fade in last; Out runs backwards and faster;
 *  - lower thirds: the plate Reveals from the Left (0.6), the photo Flies up from the Bottom, the texts Fade in;
 *    Out: texts and photo Fade (0.3), then the plate Reveals away;
 *  - bugs (small, top of the screen): Fly from the Top (0.75) in and out;
 *  - bars at the bottom (socials, tickers): the bar Reveals from the Bottom, the text Fades in.
 */
import { elements, innerComposition, isElement, isVisible, size, vec } from './model.js';
export const SCENARIOS = {
    board: 'Full-screen board', lowerthird: 'Lower third', bug: 'Bug (top corner)', bar: 'Bar at the bottom', lbar: 'L-bar',
};
const EASE = 'CubicEasingInOut';
const area = (b) => Math.max(0, b[2]) * Math.max(0, b[3]);
/** Where an element is drawn; a layer without a size is as big as what is in it. */
function boxOf(n, origin, parent) {
    const [x, y] = vec(n.attrs.Location);
    const [dw, dh] = size(n, parent);
    // a layer is measured by what is in it, cut to the layer (GT habit: layers the size of the frame, or nearly)
    if (n.tag === 'Layer') {
        const inner = innerComposition(n);
        const kids = inner?.children.filter((c) => isElement(c) && isVisible(c)) ?? [];
        if (kids.length) {
            const lx = origin[0] + x, ly = origin[1] + y;
            const bs = kids.map((c) => boxOf(c, [lx, ly], [dw, dh]));
            const x0 = Math.max(lx, Math.min(...bs.map((b) => b[0]))), y0 = Math.max(ly, Math.min(...bs.map((b) => b[1])));
            const x1 = Math.min(lx + dw, Math.max(...bs.map((b) => b[0] + b[2]))), y1 = Math.min(ly + dh, Math.max(...bs.map((b) => b[1] + b[3])));
            if (x1 > x0 && y1 > y0)
                return [x0, y0, x1 - x0, y1 - y0];
        }
    }
    return [origin[0] + x, origin[1] + y, dw, dh];
}
/** The parts that move: the named, visible elements at the top; a lone layer is opened up. */
function units(root) {
    const frame = [Number(root.attrs.Width ?? 1920), Number(root.attrs.Height ?? 1080)];
    let comp = root, origin = [0, 0], parent = frame;
    for (let guard = 0; guard < 6; guard++) {
        const els = comp.children.filter((c) => isElement(c) && isVisible(c));
        const named = els.filter((c) => c.attrs.Name);
        if (named.length === 1 && named[0].tag === 'Layer' && els.length === 1) {
            const inner = innerComposition(named[0]);
            const kids = inner?.children.filter((c) => isElement(c) && isVisible(c) && c.attrs.Name) ?? [];
            if (inner && kids.length > 1) {
                const [x, y] = vec(named[0].attrs.Location);
                origin = [origin[0] + x, origin[1] + y];
                parent = size(named[0], parent);
                comp = inner;
                continue;
            }
        }
        return { frame, list: named.map((n) => ({ node: n, name: n.attrs.Name, box: boxOf(n, origin, parent) })) };
    }
    return { frame, list: [] };
}
/** Which kind of graphic this is, from where its parts sit on the frame. */
export function detectScenario(root) {
    const { list, frame: [W, H] } = units(root);
    if (!list.length)
        return 'board';
    const names = list.map((u) => u.name).join(' ');
    const x0 = Math.min(...list.map((u) => u.box[0])), y0 = Math.min(...list.map((u) => u.box[1]));
    const x1 = Math.max(...list.map((u) => u.box[0] + u.box[2])), y1 = Math.max(...list.map((u) => u.box[1] + u.box[3]));
    const w = Math.min(W, x1) - Math.max(0, x0), h = Math.min(H, y1) - Math.max(0, y0);
    if (/(^|[\s_-])L([\s_-]|layer|bar)/i.test(names) && w > W * 0.8 && h > H * 0.8)
        return 'lbar';
    if (/ticker/i.test(names) || list.some((u) => u.node.tag === 'Ticker'))
        return 'bar';
    if (w > W * 0.55 && h < H * 0.22 && y0 > H * 0.6)
        return 'bar';
    if ((w * h) / (W * H) > 0.3)
        return 'board';
    if (y1 < H * 0.45 && (w * h) / (W * H) < 0.15)
        return 'bug';
    if (y0 > H * 0.45)
        return 'lowerthird';
    return 'board';
}
function roleOf(u, sc, biggest, namedBg) {
    const n = u.name;
    if (u.node.tag === 'Ticker' || /ticker/i.test(n))
        return 'ticker';
    if (/^(bg|back|background|plate|panel|base|box|main ?bar|l ?layer|l$|board)/i.test(n) || /\b(bg|background|plate)\b/i.test(n))
        return 'background';
    if (/head|title|top ?text|caption/i.test(n))
        return 'header';
    if (/sponsor|partner|logo|footer|powered/i.test(n))
        return 'footer';
    if (/person|photo|portrait|picture|face|headshot/i.test(n))
        return 'photo';
    if (/qualif|badge|tag|flag|status/i.test(n))
        return 'badge';
    if (!namedBg && area(u.box) >= biggest * 0.98 && area(u.box) > 0)
        return 'background';
    if (sc === 'lowerthird' || sc === 'bar' || sc === 'bug')
        return 'text';
    return 'item';
}
const anim = (tag, object, delay, duration, direction) => ({
    tag,
    attrs: {
        Object: object,
        ...(delay > 0 ? { Delay: String(Math.round(delay * 1000) / 1000) } : {}),
        Duration: String(Math.round(duration * 1000) / 1000),
        ...(direction ? { Direction: direction } : {}),
        Interpolation: EASE,
    },
    children: [],
});
/** In and Out animations for the units by the house pattern. */
function plan(sc, list) {
    const inA = [], outA = [];
    const by = (r) => list.filter((u) => u.role === r);
    const order = (us) => {
        // rows top to bottom, or cards left to right when they sit side by side
        const xs = us.map((u) => u.box[0]), ys = us.map((u) => u.box[1]);
        const horizontal = Math.max(...xs) - Math.min(...xs) > Math.max(...ys) - Math.min(...ys);
        return { sorted: [...us].sort((a, b) => (horizontal ? a.box[0] - b.box[0] || a.box[1] - b.box[1] : a.box[1] - b.box[1] || a.box[0] - b.box[0])), horizontal };
    };
    const bg = by('background'), header = by('header'), footer = by('footer'), photo = by('photo'), badge = by('badge'), ticker = by('ticker');
    const rest = [...by('item'), ...by('text')];
    if (sc === 'board' || sc === 'lbar') {
        const reveal = sc === 'lbar' ? 'Left' : 'Top';
        const fly = sc === 'lbar' ? 'Left' : 'Left';
        bg.forEach((u) => { inA.push(anim('Reveal', u.name, 0, 0.75, reveal)); outA.push(anim('Reveal', u.name, 0.3, 0.75, reveal)); });
        const t0 = bg.length ? 0.05 : 0;
        header.forEach((u) => { inA.push(anim('Fly', u.name, t0, 0.65, fly), anim('Fade', u.name, t0 + 0.3, 0.5)); outA.push(anim('Fade', u.name, 0.15, 0.4)); });
        const { sorted, horizontal } = order([...rest, ...photo, ...badge]);
        // a list never takes longer than half a second to build up, however many rows
        const step = Math.min(horizontal ? 0.08 : 0.05, sorted.length > 1 ? 0.45 / (sorted.length - 1) : 1);
        const start = bg.length || header.length ? 0.15 : 0;
        let end = 0;
        sorted.forEach((u, i) => {
            const d = start + i * step + (horizontal ? 0.15 : 0);
            if (horizontal)
                inA.push(anim('Fly', u.name, d, 0.5, 'Bottom'), anim('Fade', u.name, d, 0.4));
            else
                inA.push(anim('Fly', u.name, d, 0.65, fly), anim('Fade', u.name, d + 0.3, 0.5));
            end = Math.max(end, d + (horizontal ? 0.5 : 0.8));
            outA.push(anim('Fade', u.name, (sorted.length - 1 - i) * 0.03, 0.4));
        });
        ticker.forEach((u) => { inA.push(anim('Reveal', u.name, 0.5, 1, 'Left')); outA.push(anim('Fade', u.name, 0, 0.4)); });
        footer.forEach((u) => { inA.push(anim('Fade', u.name, Math.max(0.75, end - 0.2), 0.6)); outA.push(anim('Fade', u.name, 0, 0.4)); });
    }
    else if (sc === 'lowerthird') {
        bg.forEach((u) => { inA.push(anim('Reveal', u.name, 0, 0.6, 'Left')); outA.push(anim('Reveal', u.name, 0.15, 0.5, 'Left')); });
        const t = bg.length ? 1 : 0;
        // the photo rises a moment after the bar is in, and goes down first on the way out
        photo.forEach((u) => { inA.push(anim('Fly', u.name, 0.4 * t, 0.55, 'Bottom')); outA.push(anim('Fly', u.name, 0, 0.4, 'Bottom')); });
        const { sorted } = order([...rest, ...header, ...ticker]);
        sorted.forEach((u, i) => { inA.push(anim('Fade', u.name, 0.45 * t + i * 0.05, 0.4)); outA.push(anim('Fade', u.name, 0, 0.3)); });
        badge.forEach((u) => { inA.push(anim('Reveal', u.name, 0.6 * t, 0.5, 'Bottom')); outA.push(anim('Reveal', u.name, 0, 0.4, 'Bottom')); });
        footer.forEach((u) => { inA.push(anim('Fade', u.name, 0.6 * t, 0.4)); outA.push(anim('Fade', u.name, 0, 0.3)); });
    }
    else if (sc === 'bug') {
        const main = bg.length ? bg : list.slice().sort((a, b) => area(b.box) - area(a.box)).slice(0, 1);
        main.forEach((u) => { inA.push(anim('Fly', u.name, 0, 0.75, 'Top')); outA.push(anim('Fly', u.name, 0, 0.75, 'Top')); });
        list.filter((u) => !main.includes(u)).forEach((u, i) => { inA.push(anim('Fade', u.name, 0.35 + i * 0.05, 0.4)); outA.push(anim('Fade', u.name, 0, 0.3)); });
    }
    else {
        // bar at the bottom: the bar Reveals up, text Fades in, a logo Flies up, a ticker opens from the Left
        const main = bg.length ? bg : list.filter((u) => u.role !== 'ticker' && u.role !== 'footer').sort((a, b) => area(b.box) - area(a.box)).slice(0, 1);
        main.forEach((u) => { inA.push(anim('Reveal', u.name, 0, 0.75, 'Bottom')); outA.push(anim('Reveal', u.name, 0.25, 0.75, 'Bottom')); });
        footer.forEach((u) => { inA.push(anim('Fly', u.name, 0, 0.75, 'Bottom')); outA.push(anim('Fly', u.name, 0.25, 0.75, 'Bottom')); });
        ticker.forEach((u) => { inA.push(anim('Reveal', u.name, 0.4, 1, 'Left')); outA.push(anim('Fade', u.name, 0, 0.4)); });
        list.filter((u) => !main.includes(u) && u.role !== 'footer' && u.role !== 'ticker').forEach((u, i) => { inA.push(anim('Fade', u.name, 0.25 + i * 0.05, 0.5)); outA.push(anim('Fade', u.name, 0, 0.4)); });
    }
    return { inA, outA };
}
const total = (as) => Math.max(0, ...as.map((a) => Number(a.attrs.Delay ?? 0) + Number(a.attrs.Duration ?? 1)));
/** The named picture with a mask inside a layer (PHOTO masked by Rectangle1), if there is one. */
function maskedImage(layer) {
    const inner = innerComposition(layer);
    for (const c of inner?.children ?? []) {
        if (!isElement(c) || !c.attrs.Name)
            continue;
        if (c.children.some((h) => h.tag === `${c.tag}.Mask`))
            return c.attrs.Name;
        if (c.tag === 'Layer') {
            const m = maskedImage(c);
            if (m)
                return m;
        }
    }
    return null;
}
/** Text fields of the title (TextBlocks with a name), for the data-change fades. */
function textNames(root) {
    const out = [];
    const walk = (n) => {
        for (const c of n.children) {
            if (c.tag === 'TextBlock' && c.attrs.Name)
                out.push(c.attrs.Name);
            if (c.tag === 'Layer') {
                const i = innerComposition(c);
                if (i)
                    walk(i);
            }
        }
    };
    walk(root);
    return out;
}
/**
 * Replaces the title's In and Out with the house animations (in place). Data-change storyboards the title already
 * has stay; with `dataChange` every text field gets a quick fade out and in when vMix changes it.
 */
export function applyStandardAnimation(root, o = {}) {
    const sc = !o.scenario || o.scenario === 'auto' ? detectScenario(root) : o.scenario;
    const { list } = units(root);
    const biggest = Math.max(0, ...list.map((u) => area(u.box)));
    const namedBg = list.some((u) => /^(bg|back|background|plate|panel|base|box|main ?bar|l ?layer|l$|board)/i.test(u.name) || /\b(bg|background|plate)\b/i.test(u.name));
    const withRoles = list.map((u) => ({ ...u, role: roleOf(u, sc, biggest, namedBg) }));
    // one background is enough; extra big ones become ordinary parts
    let seenBg = false;
    for (const u of withRoles.sort((a, b) => area(b.box) - area(a.box))) {
        if (u.role !== 'background')
            continue;
        if (seenBg && !/^(bg|background|plate)/i.test(u.name))
            u.role = sc === 'board' || sc === 'lbar' ? 'item' : 'text';
        seenBg = true;
    }
    // a photo in a layer with its mask: the photo itself moves and the mask stays, so it rises from behind its frame
    // (moving the whole layer moves the mask too, and vMix shows little more than a fade)
    for (const u of withRoles) {
        if (u.role !== 'photo' || u.node.tag !== 'Layer')
            continue;
        const masked = maskedImage(u.node);
        if (masked)
            u.name = masked;
    }
    const ordered = list.map((u) => withRoles.find((w) => w.node === u.node));
    const { inA, outA } = plan(sc, ordered);
    const tempo = o.tempo && o.tempo > 0 ? o.tempo : 1;
    if (tempo !== 1)
        for (const a of [...inA, ...outA]) {
            if (a.attrs.Delay)
                a.attrs.Delay = String(Math.round((Number(a.attrs.Delay) / tempo) * 1000) / 1000);
            a.attrs.Duration = String(Math.round((Number(a.attrs.Duration) / tempo) * 1000) / 1000);
        }
    const keep = root.children.filter((c) => c.tag === 'Storyboard' && /^DataChange/.test(c.attrs.Type ?? ''));
    const dataNames = new Set(keep.map((c) => `${c.attrs.Type}|${c.attrs.DataName}`));
    const sbs = [
        { tag: 'Storyboard', attrs: {}, children: [{ tag: 'Storyboard.Animations', attrs: {}, children: inA }] },
        { tag: 'Storyboard', attrs: { Type: 'TransitionOut' }, children: [{ tag: 'Storyboard.Animations', attrs: {}, children: outA }] },
        ...keep,
    ];
    if (o.dataChange) {
        for (const name of textNames(root)) {
            for (const type of ['DataChangeOut', 'DataChangeIn']) {
                if (dataNames.has(`${type}|${name}.Text`))
                    continue;
                sbs.push({ tag: 'Storyboard', attrs: { Type: type, DataName: `${name}.Text` }, children: [{ tag: 'Storyboard.Animations', attrs: {}, children: [anim('Fade', name, 0, 0.3 / tempo)] }] });
            }
        }
    }
    // vMix plays a photo's DataChange but not a Fly on it in Transition In: the dashboard brings the title in without the
    // photo and sets it right after, so the photo rises a moment after the bar (lowerthirds.ts). Each photo gets one.
    for (const u of ordered) {
        if (u.role !== 'photo' || !u.name)
            continue;
        const img = elements(root).find((e) => e.node.attrs.Name === u.name)?.node;
        if (img?.tag !== 'Image')
            continue;
        for (const [type, d] of [['DataChangeOut', 0.35], ['DataChangeIn', 0.5]]) {
            if (dataNames.has(`${type}|${u.name}.Source`))
                continue;
            sbs.push({ tag: 'Storyboard', attrs: { Type: type, DataName: `${u.name}.Source` }, children: [{ tag: 'Storyboard.Animations', attrs: {}, children: [anim('Fly', u.name, 0, d / tempo, 'Bottom')] }] });
        }
    }
    const first = root.children.findIndex((c) => c.tag === 'Storyboard');
    const rest = root.children.filter((c) => c.tag !== 'Storyboard');
    const at = first >= 0 ? root.children.slice(0, first).filter((c) => c.tag !== 'Storyboard').length : rest.length;
    root.children = [...rest.slice(0, at), ...sbs, ...rest.slice(at)];
    return { scenario: sc, roles: ordered.map((u) => ({ name: u.name, role: u.role })), inLength: total(inA), outLength: total(outA) };
}
