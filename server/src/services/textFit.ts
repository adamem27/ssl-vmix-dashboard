/**
 * Text widths for titles whose text fields must sit next to each other whatever their lengths (vMix cannot move a
 * GT field, so a field is padded with no-break spaces instead). General Sans is measured when the dashboard has it
 * (uploaded under Matchboard → Fonts, or installed on this computer); otherwise the widths come from a table of
 * Inter's, which runs within a few percent of General Sans.
 */
import { createRequire } from 'node:module';
import { uploadedSansFiles } from './matchboard/matchboard.js';

export type FitWeight = 'regular' | 'bold';
const FONT = 'General Sans';
export const NBSP = ' ';

// Inter's advance widths, characters 32–126, in thousandths of an em
const TABLE: Record<FitWeight, number[]> = {
  regular: [281,288,466,633,642,982,644,300,365,365,501,662,288,460,288,360,631,407,610,618,646,608,620,566,619,620,288,302,662,662,662,511,966,690,654,730,722,601,590,746,743,269,571,672,565,903,753,765,639,765,644,642,646,744,690,985,682,679,629,365,360,365,471,456,323,562,612,571,612,583,370,613,591,242,242,549,242,876,591,600,612,612,376,528,327,591,562,818,546,562,552,426,333,426,662],
  bold: [237,338,552,649,655,1016,672,339,377,377,559,679,334,468,334,388,674,431,630,646,676,639,649,582,651,649,334,343,679,679,679,560,1016,747,662,740,722,607,587,750,747,281,584,719,565,932,762,771,648,777,657,655,667,732,747,1038,738,731,664,377,388,377,487,476,365,581,630,588,630,596,398,632,623,271,271,580,271,913,623,613,630,630,407,560,366,623,600,850,580,602,573,469,372,469,679],
};

function tableWidth(text: string, size: number, weight: FitWeight) {
  let w = 0;
  for (const ch of text.normalize('NFD').replace(/\p{M}/gu, '')) {
    const code = ch === NBSP ? 32 : ch.codePointAt(0)!;
    w += code >= 32 && code < 127 ? TABLE[weight][code - 32] : 620;
  }
  return (w * size) / 1000;
}

type Ctx = { font: string; measureText(t: string): { width: number } };
let measurer: Ctx | null | undefined;
let fontsKey = '';

function canvasCtx(assetsDir?: string): Ctx | null {
  if (measurer === undefined) {
    try {
      const c = createRequire(import.meta.url)('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
      const files = assetsDir ? uploadedSansFiles(assetsDir) : [];
      const key = files.map((f) => f.file).join('|');
      if (key && key !== fontsKey) { for (const f of files) c.GlobalFonts.registerFromPath(f.file, FONT); fontsKey = key; }
      measurer = c.GlobalFonts.has(FONT) ? (c.createCanvas(8, 8).getContext('2d') as unknown as Ctx) : null;
    } catch { measurer = null; }
  }
  return measurer;
}

/** Forget the measuring set-up (fonts uploaded since). */
export function resetTextFit() { measurer = undefined; }

/** Where the widths come from: General Sans itself, or the Inter table. */
export function fitSource(assetsDir?: string): 'general-sans' | 'table' { return canvasCtx(assetsDir) ? 'general-sans' : 'table'; }

/** Width in pixels of the text set in General Sans of that size and weight. */
export function textWidth(text: string, size: number, weight: FitWeight, assetsDir?: string) {
  if (!text) return 0;
  const c = canvasCtx(assetsDir);
  if (!c) return tableWidth(text, size, weight);
  c.font = `${weight === 'bold' ? 'bold ' : ''}${size}px "${FONT}"`;
  return c.measureText(text).width;
}

/** No-break spaces that take up about that many pixels in that text (none for zero or less). */
export function pad(px: number, size: number, weight: FitWeight = 'regular', assetsDir?: string) {
  const one = textWidth(NBSP, size, weight, assetsDir) || size * 0.28;
  return px > 0 ? NBSP.repeat(Math.round(px / one)) : '';
}
