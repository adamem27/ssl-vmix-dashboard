/**
 * Groups as the broadcast names them. The dashboard keeps the matchboard's short names (QS H, R1 A, EF B …) because
 * the bracket refers to places by them (R1 C1 = winner of R1 C); every graphic shows “Group H” instead.
 */
const SHORT = /^(?:QS|Q|R\d+|EF|QF|SF|GR|GROUP|FLEET|G)\s*[-_.]?\s*([A-Z]{1,2}\d?)$/i;
/** “QS H” → “Group H”; names that are not a lettered group (Final, Petit Final) stay as they are, in capitals. */
export function groupLabel(name) {
    const n = (name ?? '').trim();
    if (!n)
        return '';
    const m = SHORT.exec(n);
    return m ? `Group ${m[1].toUpperCase()}` : n.toUpperCase();
}
/** The letter of a group (“QS H” → “H”), or its label when it has none. */
export function groupLetter(name) {
    const m = SHORT.exec((name ?? '').trim());
    return m ? m[1].toUpperCase() : groupLabel(name);
}
/** A title typed or saved as the matchboard's short name (QS H) is shown as the group (Group H); other titles stay. */
export function groupTitle(title) {
    return SHORT.test(title.trim()) ? groupLabel(title) : title;
}
