import { describe, expect, it } from 'vitest';
import { buildXlsx, sheetNames } from '../src/services/xlsx.js';

describe('xlsx', () => {
  it('makes valid, unique sheet names', () => {
    expect(sheetNames(['1/32 Finals', 'Teams', 'teams', 'A'.repeat(40)])).toEqual(['1-32 Finals', 'Teams', 'teams 2', 'A'.repeat(31)]);
  });
  it('writes a zip with one worksheet per sheet', () => {
    const buf = buildXlsx([{ name: 'Teams', rows: [{ code: 'POL', name: 'Poland & <Co>' }] }, { name: 'Weather', rows: [] }]);
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    const text = buf.toString('utf8');
    expect(text).toContain('xl/worksheets/sheet2.xml');
    expect(text).toContain('Poland &amp; &lt;Co&gt;');
  });
});
