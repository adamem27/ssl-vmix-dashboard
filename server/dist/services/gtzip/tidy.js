const WORDS = {
    bg: 'Background', background: 'Background', sponsor: 'Sponsors', sponsors: 'Sponsors', sponsorbar: 'Sponsors',
    partners: 'Partners', l: 'L-frame', column: 'Side column', bottom: 'Bottom bar', bar: 'Main bar', bar2: 'Second bar',
    board: 'Board', text: 'Text', logo: 'Logo', header: 'Header', course: 'Course map',
};
const GENERIC = /^(layer|group|warstwa)\s*\d*$/i;
const CAPS = /^[A-Z0-9 -]+$/;
/** HEADER → Header, PHOTO OMA → Photo OMA: team codes stay in capitals. */
const sentence = (s, codes = new Set()) => s.split(' ').map((w, i) => (codes.has(w) ? w : i === 0 ? w.slice(0, 1).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(' ');
function walk(n, fn) { fn(n); n.children.forEach((c) => walk(c, fn)); }
function inside(layer) { const out = []; layer.children.forEach((c) => walk(c, (x) => out.push(x))); return out; }
export function tidyName(name, inner, tags, codes = new Set()) {
    let n = name.trim();
    if (GENERIC.test(n)) {
        if (tags.includes('Ticker'))
            return 'Ticker';
        if (inner.length === 1)
            return tidyName(inner[0], [], []);
        return inner.length ? `${tidyName(inner[0], [], [])} group` : 'Graphics';
    }
    n = n.replace(/\s*layer$/i, '').trim() || name;
    if (WORDS[n.toLowerCase()])
        return WORDS[n.toLowerCase()];
    const m = /^([A-Z]{1,3}\d+)([A-Z][a-z]+)$/.exec(n);
    if (m)
        return `${m[1]} ${m[2].toLowerCase()}`;
    if (/^[A-Z]{2,5}$/.test(n) && inner.some((x) => x !== n && x.includes(n)))
        return n; // a team code: the generator renames teams by it
    if (CAPS.test(n) && /[A-Z]{2}/.test(n))
        return sentence(n, codes);
    return n;
}
/** Renames the layers in place; returns old → new. */
export function tidyLayers(root) {
    const fields = new Set();
    walk(root, (x) => { if (x.tag !== 'Layer' && x.attrs.Name)
        fields.add(x.attrs.Name.toLowerCase()); });
    // team codes: layers named OMA whose own elements carry the code (OMA Name, PHOTO OMA…)
    const codes = new Set();
    walk(root, (L) => {
        const nm = L.attrs.Name ?? '';
        if (L.tag === 'Layer' && /^[A-Z]{2,5}$/.test(nm) && inside(L).some((x) => x.tag !== 'Layer' && x.attrs.Name && x.attrs.Name !== nm && x.attrs.Name.includes(nm)))
            codes.add(nm);
    });
    const used = new Set();
    const ren = {};
    walk(root, (L) => {
        if (L.tag !== 'Layer')
            return;
        const old = L.attrs.Name ?? '';
        const all = inside(L);
        let nn = tidyName(old, all.filter((x) => x.tag !== 'Layer' && x.attrs.Name).map((x) => x.attrs.Name), all.map((x) => x.tag), codes);
        if (nn !== old && fields.has(nn.toLowerCase()))
            nn = `${CAPS.test(nn) ? sentence(nn) : nn} group`;
        const base = nn;
        for (let k = 2; used.has(nn.toLowerCase()); k++)
            nn = `${base} ${k}`;
        used.add(nn.toLowerCase());
        if (nn !== old) {
            L.attrs.Name = nn;
            ren[old] = nn;
        }
    });
    walk(root, (x) => { const o = x.attrs.Object; if (o !== undefined && ren[o] !== undefined)
        x.attrs.Object = ren[o]; });
    return ren;
}
