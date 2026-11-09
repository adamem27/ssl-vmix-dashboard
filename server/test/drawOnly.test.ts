import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { parseXml } from '../src/services/gtzip/model.js';
import { drawTitle } from '../src/services/gtzip/draw.js';

const XML = `<?xml version="1.0"?><Composition Width="100" Height="50">
  <Rectangle Name="BG" Dimensions="100,50,0" Location="0,0,0"><Rectangle.Fill><Brush Color="#FF0000FF" /></Rectangle.Fill></Rectangle>
  <Layer Name="Row" Dimensions="60,20,0" Location="20,10,0" Visible="False"><Layer.Composition><Composition>
    <Rectangle Name="BAR" Dimensions="10,10,0" Location="5,5,0"><Rectangle.Fill><Brush Color="#FFFF0000" /></Rectangle.Fill></Rectangle>
    <Rectangle Name="DOT" Dimensions="5,5,0" Location="40,5,0"><Rectangle.Fill><Brush Color="#FF00FF00" /></Rectangle.Fill></Rectangle>
  </Composition></Layer.Composition></Layer>
</Composition>`;

const draw = (only: string[]) => {
  const { root } = parseXml(XML);
  const find = (n: typeof root, name: string): typeof root | null => n.attrs.Name === name ? n : n.children.map((c) => find(c, name)).find(Boolean) ?? null;
  const c = createCanvas(100, 50); const ctx = c.getContext('2d');
  drawTitle(ctx, root, { image: () => null, only: only.map((n) => find(root, n)!) });
  const px = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
  return px;
};

describe('drawing only some elements (layer as PNG)', () => {
  it('draws the chosen element in place, nothing else, even inside a hidden layer', () => {
    const px = draw(['BAR']);
    expect(px(30, 20)).toEqual([255, 0, 0, 255]); // BAR at 20+5+5 = 30, 10+5+5 = 20
    expect(px(2, 2)[3]).toBe(0); // background left out
    expect(px(62, 17)[3]).toBe(0); // DOT left out
  });
  it('draws a whole layer with what is inside', () => {
    const px = draw(['Row']);
    expect(px(30, 20)).toEqual([255, 0, 0, 255]);
    expect(px(62, 17)).toEqual([0, 255, 0, 255]);
    expect(px(2, 2)[3]).toBe(0);
  });
});
