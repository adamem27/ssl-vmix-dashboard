import { describe, expect, it } from 'vitest';
import { applyStandardAnimation, detectScenario } from '../src/services/gtzip/standardAnim.js';
import { animationsOf, parseXml, storyboards } from '../src/services/gtzip/model.js';

const layer = (name: string, inner: string) => `<Layer Name="${name}" Dimensions="1920,1080,0"><Layer.Composition><Composition Width="1920" Height="1080">${inner}</Composition></Layer.Composition></Layer>`;
const img = (name: string, x: number, y: number, w: number, h: number) => `<Image Name="${name}" Location="${x},${y},0" Dimensions="${w},${h},0"/>`;
const doc = (inner: string) => parseXml(`<?xml version="1.0"?><Composition Width="1920" Height="1080">${inner}<Storyboard Type="DataChangeIn" DataName="Role.Text"><Storyboard.Animations><Fade Object="Role"/></Storyboard.Animations></Storyboard></Composition>`).root;

describe('standard animation', () => {
  it('animates a board: background from the top, header, rows one after another, sponsor last', () => {
    const root = doc(layer('BG', img('bg', 300, 100, 1320, 880)) + layer('HEADER', img('h', 340, 120, 1240, 100)) +
      [1, 2, 3].map((i) => layer(`ROW ${i}`, img(`r${i}`, 340, 200 + i * 120, 1240, 100))).join('') + layer('SPONSOR', img('s', 800, 900, 320, 60)));
    expect(detectScenario(root)).toBe('board');
    const r = applyStandardAnimation(root);
    expect(r.roles.map((x) => x.role)).toEqual(['background', 'header', 'item', 'item', 'item', 'footer']);
    const [inSb, outSb] = storyboards(root);
    const inA = animationsOf(inSb.node);
    expect(inA[0].attrs).toMatchObject({ Object: 'BG', Direction: 'Top', Duration: '0.75', Interpolation: 'CubicEasingInOut' });
    const rowDelays = inA.filter((a) => a.tag === 'Fly' && /ROW/.test(a.attrs.Object)).map((a) => Number(a.attrs.Delay));
    expect(rowDelays).toEqual([0.15, 0.2, 0.25]);
    expect(outSb.type).toBe('TransitionOut');
    expect(animationsOf(outSb.node).find((a) => a.attrs.Object === 'BG')!.attrs.Delay).toBe('0.3');
    // the data change the title had stays
    expect(storyboards(root).some((s) => s.type === 'DataChangeIn')).toBe(true);
  });

  it('animates a lower third: plate from the left, photo up, texts fade; quick out', () => {
    const root = doc(layer('Plate', img('Bar', 572, 898, 802, 102)) + layer('Person', img('Photo', 572, 820, 205, 179)) + layer('Info', `<TextBlock Name="Role" Location="650,954,0" Dimensions="600,31,0" Text="x"/>`));
    const r = applyStandardAnimation(root, { dataChange: true });
    expect(r.scenario).toBe('lowerthird');
    const inA = animationsOf(storyboards(root)[0].node);
    expect(inA.map((a) => `${a.tag} ${a.attrs.Object} ${a.attrs.Direction ?? ''}`.trim())).toEqual(['Reveal Plate Left', 'Fly Person Bottom', 'Fade Info']);
    expect(r.outLength).toBeLessThan(0.7);
    // DataChangeOut added for Role (DataChangeIn was already there)
    expect(storyboards(root).filter((s) => s.node.attrs.DataName === 'Role.Text').map((s) => s.type).sort()).toEqual(['DataChangeIn', 'DataChangeOut']);
  });

  it('flies a small top bug in and out from the top; tempo makes it faster', () => {
    const root = doc(layer('BAR layer', img('BAR', 719, 54, 562, 66)));
    const r = applyStandardAnimation(root, { tempo: 1.25 });
    expect(r.scenario).toBe('bug');
    expect(animationsOf(storyboards(root)[0].node)[0].attrs).toMatchObject({ Object: 'BAR layer', Direction: 'Top', Duration: '0.6' });
  });
});
