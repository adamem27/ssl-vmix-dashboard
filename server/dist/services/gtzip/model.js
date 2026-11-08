/**
 * GT Title (.gtzip) document model shared by the server and the browser (pure TS, no Node APIs).
 *
 * document.xml is kept as a generic element tree so that every attribute GT Title Designer writes survives a round trip.
 * The helpers below understand the parts the GTZIP generator edits: named elements (Layer, TextBlock, Image, …),
 * their Location / Dimensions, brushes, bitmaps and the storyboards (TransitionIn / TransitionOut / DataChange).
 */
// ---------- XML ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescape(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e]);
}
/** The way .NET's XmlWriter (GT Title Designer) escapes attribute values. */
function escAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/\r/g, '&#xD;').replace(/\n/g, '&#xA;').replace(/\t/g, '&#x9;');
}
function escText(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
/** Parses an XML document; returns the declaration (if any) and the root element. */
export function parseXml(src) {
    if (src.charCodeAt(0) === 0xfeff)
        src = src.slice(1);
    let i = 0, decl = '';
    const m = /^\s*(<\?xml[^>]*\?>)/.exec(src);
    if (m) {
        decl = m[1];
        i = m[0].length;
    }
    const stack = [];
    let root = null;
    while (i < src.length) {
        const lt = src.indexOf('<', i);
        if (lt < 0)
            break;
        if (lt > i && stack.length) {
            const t = src.slice(i, lt);
            if (t.trim())
                stack[stack.length - 1].text = (stack[stack.length - 1].text ?? '') + unescape(t);
        }
        if (src.startsWith('<!--', lt)) {
            i = src.indexOf('-->', lt) + 3;
            continue;
        }
        if (src.startsWith('<?', lt)) {
            i = src.indexOf('?>', lt) + 2;
            continue;
        }
        if (src.startsWith('<![CDATA[', lt)) {
            const end = src.indexOf(']]>', lt);
            if (stack.length)
                stack[stack.length - 1].text = (stack[stack.length - 1].text ?? '') + src.slice(lt + 9, end);
            i = end + 3;
            continue;
        }
        if (src[lt + 1] === '/') {
            stack.pop();
            i = src.indexOf('>', lt) + 1;
            continue;
        }
        const re = /^<([^\s/>]+)/y;
        re.lastIndex = 0;
        const tm = re.exec(src.slice(lt, lt + 200));
        if (!tm)
            throw new Error('Invalid XML near position ' + lt);
        const node = { tag: tm[1], attrs: {}, children: [] };
        let p = lt + tm[0].length;
        const attrRe = /\s*([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')|\s*(\/?>)/y;
        let selfClose = false;
        for (;;) {
            attrRe.lastIndex = p;
            const a = attrRe.exec(src);
            if (!a)
                throw new Error('Invalid XML attribute near position ' + p);
            p = attrRe.lastIndex;
            if (a[5]) {
                selfClose = a[5] === '/>';
                break;
            }
            node.attrs[a[1]] = unescape(a[3] ?? a[4] ?? '');
        }
        if (stack.length)
            stack[stack.length - 1].children.push(node);
        else
            root = node;
        if (!selfClose)
            stack.push(node);
        i = p;
    }
    if (!root)
        throw new Error('Empty XML document');
    return { decl, root };
}
/** Serializes like GT Title Designer: 2-space indent and CRLF when `pretty`, otherwise compact; empty elements as `<a />`. */
export function serializeXml(root, pretty) {
    const nl = pretty ? '\r\n' : '';
    const out = [];
    const rec = (n, depth) => {
        const ind = pretty ? '  '.repeat(depth) : '';
        const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
        if (!n.children.length && n.text == null) {
            out.push(`${ind}<${n.tag}${attrs} />`);
            return;
        }
        if (!n.children.length) {
            out.push(`${ind}<${n.tag}${attrs}>${escText(n.text)}</${n.tag}>`);
            return;
        }
        out.push(`${ind}<${n.tag}${attrs}>${n.text ? escText(n.text) : ''}`);
        for (const c of n.children)
            rec(c, depth + 1);
        out.push(`${ind}</${n.tag}>`);
    };
    rec(root, 0);
    return out.join(nl);
}
export const pathKey = (p) => p.join('/');
export const parsePathKey = (k) => (k ? k.split('/').map(Number) : []);
export function clone(v) { return JSON.parse(JSON.stringify(v)); }
export function nodeAt(root, p) {
    let n = root;
    for (const i of p) {
        n = n?.children[i];
        if (!n)
            return null;
    }
    return n ?? null;
}
export const child = (n, tag) => n.children.find((c) => c.tag === tag) ?? null;
/** Visual elements that can live in a Composition. */
export const ELEMENT_TAGS = new Set(['Layer', 'TextBlock', 'Image', 'Rectangle', 'Ellipse', 'Triangle', 'Ticker', 'Text3D', 'Video', 'Shape', 'Line', 'Polygon']);
export const isElement = (n) => ELEMENT_TAGS.has(n.tag);
/** The Composition inside a Layer (or the root composition itself). */
export function innerComposition(n) {
    if (n.tag === 'Composition')
        return n;
    const holder = child(n, `${n.tag}.Composition`);
    return holder ? child(holder, 'Composition') : null;
}
/** All elements in document order (bottom-most first, as GT draws them), with the absolute origin of their parent layer. */
export function elements(root) {
    const out = [];
    const walk = (comp, compPath, depth, parentPath, origin) => {
        comp.children.forEach((c, i) => {
            if (!isElement(c))
                return;
            const p = [...compPath, i];
            out.push({ node: c, path: p, depth, parentPath, origin });
            if (c.tag === 'Layer') {
                const holderIdx = c.children.findIndex((x) => x.tag === 'Layer.Composition');
                const inner = holderIdx >= 0 ? c.children[holderIdx].children.findIndex((x) => x.tag === 'Composition') : -1;
                if (inner >= 0) {
                    const [x, y] = vec(c.attrs.Location);
                    walk(c.children[holderIdx].children[inner], [...p, holderIdx, inner], depth + 1, p, [origin[0] + x, origin[1] + y]);
                }
            }
        });
    };
    walk(root, [], 0, null, [0, 0]);
    return out;
}
export function vec(s) {
    const v = (s ?? '').split(',').map(Number);
    return [v[0] || 0, v[1] || 0, v[2] || 0];
}
export const fmtNum = (n) => String(Math.round(n * 10000) / 10000);
export function setVec(n, attr, x, y) {
    const z = vec(n.attrs[attr])[2];
    n.attrs[attr] = `${fmtNum(x)},${fmtNum(y)},${fmtNum(z)}`;
}
export const isVisible = (n) => n.attrs.Visible !== 'False';
/** Size of an element; a Layer without Dimensions fills its parent composition. */
export function size(n, fallback) {
    if (!n.attrs.Dimensions)
        return fallback;
    const [w, h] = vec(n.attrs.Dimensions);
    return [w, h];
}
// ---------- brushes / bitmaps ----------
export function brush(n, part) {
    const h = child(n, `${n.tag}.${part}`);
    return h ? child(h, 'Brush') : null;
}
/** #AARRGGBB → css rgba(). */
export function argbToCss(c) {
    if (!c)
        return null;
    const h = c.replace('#', '');
    if (h.length === 6)
        return '#' + h;
    if (h.length !== 8)
        return null;
    const a = parseInt(h.slice(0, 2), 16) / 255;
    return `rgba(${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${parseInt(h.slice(6, 8), 16)},${Math.round(a * 1000) / 1000})`;
}
/** Sets a solid brush colour (#RRGGBB + alpha 0–1), dropping a gradient. */
export function setSolid(n, part, rgb, alpha = 1) {
    let h = child(n, `${n.tag}.${part}`);
    if (!h) {
        h = { tag: `${n.tag}.${part}`, attrs: {}, children: [] };
        n.children.push(h);
    }
    let b = child(h, 'Brush');
    if (!b) {
        b = { tag: 'Brush', attrs: {}, children: [] };
        h.children.push(b);
    }
    delete b.attrs.Type;
    delete b.attrs.StartPoint;
    delete b.attrs.EndPoint;
    b.children = b.children.filter((c) => c.tag !== 'Brush.Stops');
    const aa = Math.max(0, Math.min(255, Math.round(alpha * 255))).toString(16).padStart(2, '0');
    b.attrs.Color = `#${aa}${rgb.replace('#', '').slice(0, 6)}`.toUpperCase();
}
export function bitmap(n) {
    const h = child(n, `${n.tag}.Bitmap`);
    return h ? child(h, 'Bitmap') : null;
}
export function setBitmapSource(n, source) {
    let h = child(n, `${n.tag}.Bitmap`);
    if (!h) {
        h = { tag: `${n.tag}.Bitmap`, attrs: {}, children: [] };
        n.children.unshift(h);
    }
    let b = child(h, 'Bitmap');
    if (!b) {
        b = { tag: 'Bitmap', attrs: {}, children: [] };
        h.children.push(b);
    }
    b.attrs.Source = source;
}
/** Display name of a bitmap source ("<guid>\\name.png" → "name.png"). */
export const sourceName = (s) => s.split('\\').pop() ?? s;
/** Names referenced through child holders such as Image.Mask > Mask Object="…". */
function refHolders(n) {
    const out = [];
    for (const h of n.children)
        if (h.tag.startsWith(n.tag + '.'))
            for (const r of h.children)
                if (r.attrs.Object != null)
                    out.push({ holder: h, ref: r });
    return out;
}
// ---------- storyboards ----------
export const ANIMATION_TYPES = ['Fade', 'Fly', 'Reveal', 'Expand', 'Zoom', 'Spin', 'Pulse', 'Wipe', 'Slide'];
export const DIRECTIONS = ['Top', 'Bottom', 'Left', 'Right'];
export const INTERPOLATIONS = ['CubicEasingInOut', 'CubicEasingIn', 'CubicEasingOut', 'Linear', 'QuadraticEasingInOut', 'QuarticEasingInOut', 'QuinticEasingInOut', 'SineEasingInOut', 'BackEasingInOut', 'BounceEasingOut', 'ElasticEasingOut'];
export function storyboards(root) {
    return root.children.map((n, index) => ({ n, index })).filter(({ n }) => n.tag === 'Storyboard').map(({ n, index }) => {
        const type = n.attrs.Type ?? 'TransitionIn';
        const label = type === 'TransitionIn' ? 'In' : type === 'TransitionOut' ? 'Out' : `${type}${n.attrs.DataName ? ` (${n.attrs.DataName})` : ''}`;
        return { node: n, index, type, label, animations: animationsOf(n) };
    });
}
export function animationsOf(sb) {
    let h = child(sb, 'Storyboard.Animations');
    if (!h) {
        h = { tag: 'Storyboard.Animations', attrs: {}, children: [] };
        sb.children.push(h);
    }
    return h.children;
}
/** Total length of a storyboard in seconds (GT's default Duration is 1). */
export const storyboardLength = (sb) => Math.max(0, ...animationsOf(sb).map((a) => Number(a.attrs.Delay ?? 0) + Number(a.attrs.Duration ?? 1)));
// ---------- names ----------
export function allNames(root) {
    const s = new Set();
    for (const e of elements(root))
        if (e.node.attrs.Name)
            s.add(e.node.attrs.Name);
    return s;
}
const splitNum = (name) => { const m = /^(.*?)(\d+)$/.exec(name); return m ? { base: m[1], n: Number(m[2]) } : { base: name, n: null }; };
function namedIn(n, out = []) {
    if (isElement(n) && n.attrs.Name)
        out.push(n);
    for (const c of n.children)
        namedIn(c, out);
    return out;
}
function freeName(base, start, used) {
    let n = start;
    while (used.has(base + n))
        n++;
    return base + n;
}
/** Replaces element names everywhere they are used: Name, animation/mask Object, DataChange DataName. */
function applyNameMap(n, map) {
    if (n.attrs.Name != null && map.has(n.attrs.Name))
        n.attrs.Name = map.get(n.attrs.Name);
    if (n.attrs.Object != null && map.has(n.attrs.Object))
        n.attrs.Object = map.get(n.attrs.Object);
    if (n.attrs.DataName != null) {
        const i = n.attrs.DataName.lastIndexOf('.');
        const base = i >= 0 ? n.attrs.DataName.slice(0, i) : n.attrs.DataName;
        if (map.has(base))
            n.attrs.DataName = map.get(base) + (i >= 0 ? n.attrs.DataName.slice(i) : '');
    }
    for (const c of n.children)
        applyNameMap(c, map);
}
export function renameElement(root, oldName, newName) {
    if (!newName || oldName === newName)
        return;
    if (allNames(root).has(newName))
        throw new Error(`The name “${newName}” is already used.`);
    applyNameMap(root, new Map([[oldName, newName]]));
}
/**
 * Copies elements (with everything inside them) `count` times, each copy moved by (dx, dy) more than the previous one,
 * and inserted right after its source (after the earlier copies). Names are renumbered so that they stay unique:
 * trailing numbers advance by how many elements of that name family are copied (BAR 4 → BAR 5, FLAG 13…16 → FLAG 17…20),
 * names without a number get one (TRIMMER → TRIMMER1). Animations, masks and DataChange storyboards that refer to a
 * copied element are copied too, pointing at the copy. Returns the new tree and the paths of the copies.
 */
export function duplicate(root0, paths, o) {
    const root = clone(root0);
    const count = Math.max(1, Math.min(50, Math.floor(o.count || 1)));
    // keep only top-most selections, in document order
    const keys = paths.map(pathKey);
    const sel = paths.filter((p) => !keys.some((k) => k !== pathKey(p) && pathKey(p).startsWith(k + '/')))
        .sort((a, b) => cmpPath(a, b));
    const sources = sel.map((p) => nodeAt(root, p)).filter(Boolean);
    const names = sources.flatMap((s) => namedIn(s).map((x) => x.attrs.Name));
    const stride = new Map();
    for (const nm of names) {
        const { base, n } = splitNum(nm);
        if (n != null)
            stride.set(base, (stride.get(base) ?? 0) + 1);
    }
    const used = allNames(root);
    const sbs = storyboards(root);
    const copiesBySource = new Map();
    const addedNodes = [];
    for (let k = 1; k <= count; k++) {
        const map = new Map();
        for (const nm of names) {
            let next;
            if (o.find) {
                const rep = (o.replace ?? '').split('{n}').join(String((o.start ?? 1) + k - 1));
                // case-insensitive; an all-caps match gets an all-caps replacement (Helm → Sailor10, HELM → SAILOR10)
                next = nm.replace(new RegExp(o.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => (m === m.toUpperCase() && m !== m.toLowerCase() ? rep.toUpperCase() : rep));
                if (next === nm || used.has(next))
                    next = freeName(next, 1, used);
            }
            else {
                const { base, n } = splitNum(nm);
                if (n != null) {
                    next = base + (n + (stride.get(base) ?? 1) * k);
                    if (used.has(next))
                        next = freeName(base, n + 1, used);
                }
                else
                    next = freeName(base, 1, used);
            }
            used.add(next);
            map.set(nm, next);
        }
        for (const src of sources) {
            const c = clone(src);
            applyNameMap(c, map);
            const [x, y] = vec(c.attrs.Location);
            if (o.dx || o.dy || c.attrs.Location)
                setVec(c, 'Location', x + o.dx * k, y + o.dy * k);
            if (!c.attrs.Location)
                delete c.attrs.Location;
            copiesBySource.set(src, [...(copiesBySource.get(src) ?? []), c]);
            addedNodes.push(c);
        }
        for (const sb of sbs) {
            const anims = animationsOf(sb.node);
            const extra = [];
            for (const a of anims)
                if (a.attrs.Object != null && map.has(a.attrs.Object) && !addedNodes.includes(a)) {
                    const c = clone(a);
                    c.attrs.Object = map.get(a.attrs.Object);
                    if (o.delayStep) {
                        const d = Number(a.attrs.Delay ?? 0) + o.delayStep * k;
                        if (d > 0)
                            c.attrs.Delay = fmtNum(d);
                        else
                            delete c.attrs.Delay;
                    }
                    extra.push(c);
                }
            anims.push(...extra);
            addedNodes.push(...extra);
            const dn = sb.node.attrs.DataName;
            if (dn && map.has(dn.slice(0, dn.lastIndexOf('.') >= 0 ? dn.lastIndexOf('.') : undefined))) {
                const c = clone(sb.node);
                applyNameMap(c, map);
                root.children.push(c);
            }
        }
    }
    // insert copies after their sources (deepest/last first so earlier indices stay valid)
    const order = sel.map((p, i) => ({ p, src: sources[i] })).sort((a, b) => cmpPath(b.p, a.p));
    for (const { p, src } of order) {
        const parent = nodeAt(root, p.slice(0, -1));
        const idx = parent.children.indexOf(src);
        parent.children.splice(idx + 1, 0, ...(copiesBySource.get(src) ?? []));
    }
    const added = elements(root).filter((e) => addedNodes.includes(e.node)).map((e) => e.path);
    return { root, added };
}
/** Removes elements with everything inside, plus the animations, masks and DataChange storyboards that refer to them. */
export function remove(root0, paths) {
    const root = clone(root0);
    const targets = paths.map((p) => nodeAt(root, p)).filter((n) => !!n);
    const gone = new Set(targets.flatMap((t) => namedIn(t).map((x) => x.attrs.Name)));
    const strip = (n) => {
        n.children = n.children.filter((c) => !targets.includes(c));
        for (const { holder, ref } of refHolders(n))
            if (gone.has(ref.attrs.Object))
                n.children = n.children.filter((c) => c !== holder);
        for (const c of n.children)
            strip(c);
    };
    strip(root);
    root.children = root.children.filter((sb) => {
        if (sb.tag !== 'Storyboard')
            return true;
        const dn = sb.attrs.DataName;
        if (dn && gone.has(dn.lastIndexOf('.') >= 0 ? dn.slice(0, dn.lastIndexOf('.')) : dn))
            return false;
        const h = child(sb, 'Storyboard.Animations');
        if (h)
            h.children = h.children.filter((a) => !gone.has(a.attrs.Object));
        return true;
    });
    return root;
}
/** Moves an element one step up/down in drawing order inside its composition. */
export function reorder(root0, p, delta) {
    const root = clone(root0);
    const parent = nodeAt(root, p.slice(0, -1));
    const i = p[p.length - 1];
    let j = i + delta;
    while (j >= 0 && j < parent.children.length && !isElement(parent.children[j]))
        j += Math.sign(delta);
    if (j < 0 || j >= parent.children.length)
        return { root: root0, path: p };
    const [n] = parent.children.splice(i, 1);
    parent.children.splice(j, 0, n);
    return { root, path: [...p.slice(0, -1), j] };
}
function cmpPath(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++)
        if (a[i] !== b[i])
            return a[i] - b[i];
    return a.length - b.length;
}
/** vMix field names a title exposes: text fields (TextBlock/Ticker) and image fields (Image). */
export function fields(root) {
    return elements(root).flatMap((e) => {
        const nm = e.node.attrs.Name;
        if (!nm)
            return [];
        if (e.node.tag === 'TextBlock' || e.node.tag === 'Ticker' || e.node.tag === 'Text3D')
            return [{ name: `${nm}.Text`, kind: 'Text' }];
        if (e.node.tag === 'Image')
            return [{ name: `${nm}.Source`, kind: 'Source' }];
        return [];
    });
}
