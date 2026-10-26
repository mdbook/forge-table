/**
 * Generated texture for the frame: a seamless, deterministic value-noise tile (no image assets), used as a soft overlay
 * for the mottled outer border, the plates and the text box's paper.
 */
import type { Ctx2D } from '../face';

export type Tile = HTMLCanvasElement | OffscreenCanvas;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A `size`² tile of grey noise in [0, 1], summed from octaves of wrapped value noise (smoothstep-interpolated), so it
 * tiles with no seam. `cell` is the first octave's lattice period in px.
 */
export function noiseField(size: number, cell: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(size * size);
  const rand = rng(seed);
  let amp = 1;
  let total = 0;
  let period = cell;
  for (let o = 0; o < octaves; o++) {
    const n = Math.max(2, Math.round(size / period));
    const lat = new Float32Array(n * n);
    for (let i = 0; i < lat.length; i++) lat[i] = rand();
    const step = n / size;
    for (let y = 0; y < size; y++) {
      const fy = y * step;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const ya = (y0 % n) * n;
      const yb = ((y0 + 1) % n) * n;
      for (let x = 0; x < size; x++) {
        const fx = x * step;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const xa = x0 % n;
        const xb = (x0 + 1) % n;
        const top = lat[ya + xa]! + (lat[ya + xb]! - lat[ya + xa]!) * sx;
        const bot = lat[yb + xa]! + (lat[yb + xb]! - lat[yb + xa]!) * sx;
        out[y * size + x]! += (top + (bot - top) * sy) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
    period /= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / total;
  return out;
}

const cache = new Map<string, Tile>();

function makeCanvas(size: number): Tile | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size, size);
  if (typeof document !== 'undefined') return Object.assign(document.createElement('canvas'), { width: size, height: size });
  return null;
}

/**
 * A tile of black and white speckle: where the noise is above 0.5 white (alpha rising with it), below it black, so
 * drawn at a low alpha it mottles a flat fill both lighter and darker. `contrast` scales the alpha.
 */
export function mottleTile(kind: 'strip' | 'paper' | 'plate'): Tile | null {
  const hit = cache.get(kind);
  if (hit) return hit;
  const size = 256;
  const c = makeCanvas(size);
  if (!c) return null;
  const ctx = c.getContext('2d') as Ctx2D | null;
  if (!ctx) return null;
  const params = { strip: { cell: 14, oct: 3, seed: 11, k: 2.4 }, paper: { cell: 64, oct: 3, seed: 5, k: 0.9 }, plate: { cell: 48, oct: 3, seed: 9, k: 1.1 } }[kind];
  const f = noiseField(size, params.cell, params.oct, params.seed);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < f.length; i++) {
    const v = (f[i]! - 0.5) * 2 * params.k;
    const white = v > 0;
    const a = Math.min(1, Math.abs(v));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = white ? 255 : 0;
    img.data[i * 4 + 3] = Math.round(a * 255);
  }
  ctx.putImageData(img, 0, 0);
  cache.set(kind, c);
  return c;
}
