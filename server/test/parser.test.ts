import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseCrewCell, parseSslFabrikCrewList } from '../src/importers/sslFabrikCrewList.js';
import { ParseError } from '../src/importers/types.js';

describe('SSL Fabrik crew list parser', () => {
  it('splits members joined without separators (as the archive page renders)', () => {
    const w: string[] = [];
    const m = parseCrewCell('Christian Binder (W:67.00) (J-23) -->Mainsail trimmerDavid Hussl (W:81.00) (J-3) -->PitKeanu Prettner (W:75.00) (J-7) -->Bow', w);
    expect(m).toEqual([
      { sourceName: 'Christian Binder', number: '23', position: 'Mainsail trimmer', sourceId: null },
      { sourceName: 'David Hussl', number: '3', position: 'Pit', sourceId: null },
      { sourceName: 'Keanu Prettner', number: '7', position: 'Bow', sourceId: null },
    ]);
    expect(w).toEqual([]);
  });

  it('handles line breaks and unknown roles', () => {
    const m = parseCrewCell('Anna Kowalska (W:55.0) (J-1) -->Helm\nJan Nowak (W:80.0) (J-12) -->Spinnaker guy\nOla Ząb (W:60.0) (J-4) -->Bow', []);
    expect(m.map((x) => [x.sourceName, x.number, x.position])).toEqual([
      ['Anna Kowalska', '1', 'Helm'], ['Jan Nowak', '12', 'Spinnaker guy'], ['Ola Ząb', '4', 'Bow'],
    ]);
  });

  it('finds the table by headers, skips group rows, ignores weights, completes the year', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'demo-crew-list.html'), 'utf8');
    const r = parseSslFabrikCrewList(html, { year: 2026, baseUrl: 'https://example.org/list' });
    expect(r.declarations).toHaveLength(6);
    const dma = r.declarations.find((d) => d.teamRef === 'DMA' && d.date === '2026-06-11')!;
    expect(dma.members).toHaveLength(10);
    expect(dma.postedRaw).toBe('10-06 16:38');
    expect(dma.sourceRef).toBe('https://example.org/qualify3/index.php/en/daily-weight-declaration/details/67/101');
    expect(parseSslFabrikCrewList(html, { year: 2026, baseUrl: '' }).declarations[0].sourceRef).toBeNull();
    expect(JSON.stringify(r.declarations)).not.toContain('70.00');
  });

  it('throws a readable error when the expected table is missing', () => {
    expect(() => parseSslFabrikCrewList('<html><body><p>Maintenance</p></body></html>', { year: 2026, baseUrl: 'https://x' })).toThrow(ParseError);
  });
});
