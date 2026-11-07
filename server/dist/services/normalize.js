/** Normalized key for matching names: case-, accent- and whitespace-insensitive. Display keeps the original. */
export function nameKey(s) {
    return s
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/ß/g, 'ss').replace(/ł/gi, 'l').replace(/ø/gi, 'o').replace(/æ/gi, 'ae').replace(/đ/gi, 'd')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}
export function codeKey(s) {
    return nameKey(s).replace(/ /g, '');
}
/** Split "First Middle Last" into first/last name for a newly created profile. */
export function splitName(full) {
    const parts = full.trim().split(/\s+/);
    if (parts.length <= 1)
        return { first: parts[0] ?? '', last: '' };
    return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}
