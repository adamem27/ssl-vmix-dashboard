import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { officialsLines, officialsPanelPng, OFFICIAL_LINES } from '../src/services/showData.js';
import { OFFICIAL_ROLES } from '../src/services/graphicSets.js';

const full = OFFICIAL_ROLES.map((r) => ({ role: r.role, names: r.names.map((n) => n.name) }));
const at = (lines: ReturnType<typeof officialsLines>['lines']) => lines.map((l, i) => (l ? `${i + 1}${l.kind === 'role' ? 'R' : 'N'}` : '')).filter(Boolean);

describe('race officials as lines (no gaps)', () => {
  it('the full list: the spacing of the panel, all 44 lines', () => {
    const { lines, panel } = officialsLines(full);
    expect(at(lines).slice(0, 7)).toEqual(['1R', '3N', '6R', '8N', '11R', '13N', '15N']);
    expect(lines[OFFICIAL_LINES - 1]).toEqual({ kind: 'name', text: 'Johanna Poksi (EST)' });
    expect(panel).toBe(578);
  });

  it('a name or a role left out: the rest closes up, the panel gets shorter', () => {
    const fewer = full.map((g, i) => (i === 2 ? { ...g, names: ['', g.names[1]] } : i === 4 ? { role: '', names: [''] } : g));
    const { lines, panel } = officialsLines(fewer);
    expect(at(lines).slice(0, 7)).toEqual(['1R', '3N', '6R', '8N', '11R', '13N', '16R']);
    expect(lines[12]).toEqual({ kind: 'name', text: 'Alejandro Martin (ESP)' });
    expect(lines.filter(Boolean).map((l) => l!.text)).not.toContain('CHIEF UMPIRE');
    expect(panel).toBe(497);
    const p = PNG.sync.read(officialsPanelPng(panel));
    // the size of the PANEL box, so vMix does not scale it; clear under the panel, the panel from the top
    expect([p.width, p.height]).toEqual([292, 588]);
    const alpha = (x: number, y: number) => p.data[(y * p.width + x) * 4 + 3];
    expect(alpha(146, 2)).toBeGreaterThan(150);
    expect(alpha(146, panel - 3)).toBeGreaterThan(150);
    expect(alpha(146, panel + 3)).toBe(0);
  });

  it('nobody: only the title on a short panel', () => {
    expect(officialsLines(full.map(() => ({ role: '', names: [] })))).toEqual({ lines: [], panel: 43 });
  });
});
