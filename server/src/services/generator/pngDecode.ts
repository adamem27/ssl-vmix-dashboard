import zlib from 'node:zlib';
import { Tile } from './render.js';

/**
 * Minimal PNG decoder for the pattern tile: 8-bit grey, grey+alpha, RGB, RGBA and palette images,
 * non-interlaced (what Illustrator and Photoshop export by default). Returns RGBA.
 */
export function decodePng(buf: Buffer): Tile {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error('Not a PNG file.');
  let o = 8;
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  let palette: Buffer | null = null, trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const kind = buf.toString('ascii', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    o += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error('Use an 8-bit, non-interlaced PNG for the pattern.');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels || (type === 3 && !palette)) throw new Error('Unsupported PNG colour type.');
  if (width * height > 4096 * 4096) throw new Error('The pattern image is too large.');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 0xff;
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels, d = i * 4;
    if (type === 6) { out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = px[s + 3]; }
    else if (type === 2) { out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = 255; }
    else if (type === 4) { out[d] = out[d + 1] = out[d + 2] = px[s]; out[d + 3] = px[s + 1]; }
    else if (type === 0) { out[d] = out[d + 1] = out[d + 2] = px[s]; out[d + 3] = 255; }
    else { const p = px[s]; out[d] = palette![p * 3]; out[d + 1] = palette![p * 3 + 1]; out[d + 2] = palette![p * 3 + 2]; out[d + 3] = trns && p < trns.length ? trns[p] : 255; }
  }
  return { width, height, data: out };
}
