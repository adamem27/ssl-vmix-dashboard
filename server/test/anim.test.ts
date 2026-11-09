import { describe, expect, it } from 'vitest';
import { animAt, previewStoryboards } from '../src/services/gtzip/anim.js';
import { parseXml } from '../src/services/gtzip/model.js';

const xml = `<?xml version="1.0"?><Composition Width="1920" Height="1080">
<TextBlock Name="Top" Text="A" Location="100,100,0" Dimensions="200,50,0"/>
<Storyboard><Storyboard.Animations><Fade Object="Top" Duration="1"/></Storyboard.Animations></Storyboard>
<Storyboard Type="TransitionOut"><Storyboard.Animations><Fly Object="Top" Duration="0.5" Direction="Left" Interpolation="Linear"/></Storyboard.Animations></Storyboard>
<Storyboard Type="DataChangeIn" DataName="Top.Text"><Storyboard.Animations><Fade Object="Top"/></Storyboard.Animations></Storyboard>
</Composition>`;

describe('animation preview', () => {
  const { root } = parseXml(xml);
  const top = root.children.find((c) => c.attrs.Name === 'Top')!;
  const sb = previewStoryboards(root);
  it('finds the storyboards by kind', () => {
    expect(sb.in && sb.out).toBeTruthy();
    expect(sb.fields).toEqual(['Top.Text']);
    expect(sb.dataChange('Top.Text').in).toBeTruthy();
  });
  it('fades in and flies out', () => {
    const segs = [{ sb: sb.in!, phase: 'in' as const, start: 0 }, { sb: sb.out!, phase: 'out' as const, start: 2 }];
    expect(animAt(segs, 0, [1920, 1080])(top, 100, 100, 200, 50)!.alpha).toBe(0);
    expect(animAt(segs, 1, [1920, 1080])(top, 100, 100, 200, 50)!.alpha).toBe(1);
    expect(animAt(segs, 2.25, [1920, 1080])(top, 100, 100, 200, 50)!.dx).toBeCloseTo(-150);
    expect(animAt(segs, 2.5, [1920, 1080])(top, 100, 100, 200, 50)!.dx).toBeCloseTo(-300);
  });
});
