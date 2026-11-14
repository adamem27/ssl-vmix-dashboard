import { describe, expect, it } from 'vitest';
import { COMPARE_FIT, fitCompareHeader, fitCompareTeam } from '../src/services/showData.js';
import { NBSP, textWidth } from '../src/services/textFit.js';
import { compareKey } from '../src/services/show.js';

const { size, gap } = COMPARE_FIT;
const nb = textWidth(NBSP, size, 'regular');
const lead = (s: string) => s.length - s.replace(/^ +/, '').length;
// where a padded text starts, in pixels from its box's left edge
const startOf = (s: string) => lead(s) * nb;

describe('Team comparison whose texts fit themselves (Qualification Race)', () => {
  it('puts the nickname right after the country on cards 2 and 4', () => {
    const f = fitCompareTeam(2, 'MEXICO', 'Las Catrinas', 'GENTRY', 'Yanic');
    expect(f['2 NICKNAME FIT.Text'].replace(/^ +/, '')).toBe('Las Catrinas');
    expect(Math.abs(startOf(f['2 NICKNAME FIT.Text']) - (textWidth('MEXICO', size, 'bold') + gap))).toBeLessThanOrEqual(nb / 2 + 0.01);
    expect(Math.abs(startOf(f['2 CPT NAME FIT.Text']) - (textWidth('GENTRY', size, 'bold') + gap))).toBeLessThanOrEqual(nb / 2 + 0.01);
    expect(f['2 NICKNAME FIT 2.Text']).toBe('');
  });

  it('ends the nickname just before the country on cards 1 and 3 (right-aligned)', () => {
    const f = fitCompareTeam(3, 'CUBA', 'Los Caciques', 'MANSO', 'Nelido');
    const end = COMPARE_FIT.left.l + startOf(f['3 NICKNAME FIT.Text']) + textWidth('Los Caciques', size, 'regular');
    const want = COMPARE_FIT.left.r - textWidth('CUBA', size, 'bold') - gap;
    expect(Math.abs(end - want)).toBeLessThanOrEqual(nb / 2 + 0.01);
  });

  it('puts a nickname too long for the room beside the country on two lines, nothing lost', () => {
    const f = fitCompareTeam(4, 'ANTIGUA & BARBUDA', 'Pirates of the Caribbean', 'FALCONE', 'Shannon');
    const a = f['4 NICKNAME FIT.Text'].replace(/^ +/, ''), b = f['4 NICKNAME FIT 2.Text'].replace(/^ +/, '');
    expect(a && b).toBeTruthy();
    expect(`${a} ${b}`).toBe('Pirates of the Caribbean');
    const room = COMPARE_FIT.right.r - COMPARE_FIT.right.l;
    // the second line stays inside the box
    expect(startOf(f['4 NICKNAME FIT 2.Text']) + textWidth(b, size, 'regular')).toBeLessThanOrEqual(room + nb / 2);
    // one that fits stays on one line
    expect(fitCompareTeam(4, 'CUBA', 'Pirates of the Caribbean', 'X', 'Y')['4 NICKNAME FIT 2.Text']).toBe('');
  });

  it('leaves the fields empty for a team not known yet', () => {
    const f = fitCompareTeam(1, '', '', '', '');
    expect(Object.values(f)).toEqual(['', '', '']);
  });

  it('centres the title and the group as one line', () => {
    const f = fitCompareHeader('PAN-AMERICAN QUALIFIERS', 'Qualification Race');
    const h = COMPARE_FIT.header;
    const tw = textWidth('PAN-AMERICAN QUALIFIERS', h.size, 'bold'), gw = textWidth('Qualification Race', h.size, 'regular');
    const nbB = textWidth(NBSP, h.size, 'bold'), nbR = textWidth(NBSP, h.size, 'regular');
    const start = h.l + lead(f['TITLE FIT.Text']) * nbB;
    expect(Math.abs(start + (tw + h.gap + gw) / 2 - h.centre)).toBeLessThanOrEqual(nbB / 2 + 0.01);
    expect(Math.abs(h.l + lead(f['Group FIT.Text']) * nbR - (start + tw + h.gap))).toBeLessThanOrEqual(nbB / 2 + nbR / 2 + 0.01);
  });

  it('gives the Qualification Race the input ssl_compare_QR', () => {
    expect(compareKey('Qualification Race')).toBe('QR');
    expect(compareKey('QR')).toBe('QR');
    expect(compareKey('Group H')).toBe('H');
  });
});
