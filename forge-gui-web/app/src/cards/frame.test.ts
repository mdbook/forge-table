import { describe, expect, it } from 'vitest';
import type { CardFace } from '@forge-table/protocol';
import { drawCover, faceKey, paintCardFace, type Ctx2D } from './face';

/** A canvas context that records its calls: every method is a no-op, text measures 5 px a character. */
function fakeCtx() {
  const calls: Array<[string, unknown[]]> = [];
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get: (t, name: string) => {
      if (name === 'measureText') return (text: string) => ({ width: text.length * 5 });
      if (name === 'createLinearGradient') return () => ({ addColorStop: () => undefined });
      if (name in t) return t[name];
      return (...args: unknown[]) => void calls.push([name, args]);
    },
    set: (t, name: string, v) => ((t[name] = v), true),
  }) as unknown as Ctx2D;
  return { ctx, calls };
}

const bitmap = (width: number, height: number) => ({ width, height }) as ImageBitmap;
const face = { name: 'Lightning Bolt', manaCost: '{R}', colors: 'R', setCode: 'M10', rarity: 'Common', oracleText: 'Deal 3.', type: { super: [], core: ['Instant'], sub: [] } } as unknown as CardFace;

describe('cover-fit art crop', () => {
  it('scales a wide crop to the box height and trims the sides evenly', () => {
    const { ctx, calls } = fakeCtx();
    drawCover(ctx, bitmap(626, 457), 17, 49, 218, 140);
    const [, args] = calls.find(([n]) => n === 'drawImage')!;
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = args as [unknown, number, number, number, number, number, number, number, number];
    expect([dx, dy, dw, dh]).toEqual([17, 49, 218, 140]);
    // The source rectangle has the box's aspect, is centred, and never leaves the bitmap.
    expect(sw / sh).toBeCloseTo(218 / 140, 6);
    expect(sx + sw / 2).toBeCloseTo(313, 6);
    expect(sy + sh / 2).toBeCloseTo(228.5, 6);
    expect(sx).toBeGreaterThanOrEqual(0);
    expect(sy).toBeGreaterThanOrEqual(0);
    expect(sx + sw).toBeLessThanOrEqual(626 + 1e-9);
    expect(sy + sh).toBeLessThanOrEqual(457 + 1e-9);
  });

  it('trims the top and bottom of a tall crop instead', () => {
    const { ctx, calls } = fakeCtx();
    drawCover(ctx, bitmap(200, 400), 0, 0, 100, 100);
    const [, sx, sy, sw, sh] = calls.find(([n]) => n === 'drawImage')![1] as [unknown, number, number, number, number];
    expect([sx, sy, sw, sh]).toEqual([0, 100, 200, 200]);
  });

  it('draws nothing for an empty bitmap', () => {
    const { ctx, calls } = fakeCtx();
    drawCover(ctx, bitmap(0, 0), 0, 0, 10, 10);
    expect(calls.some(([n]) => n === 'drawImage')).toBe(false);
  });
});

describe('the procedural face with a crop', () => {
  const texts = (calls: Array<[string, unknown[]]>) => calls.filter(([n]) => n === 'fillText').map(([, a]) => a[0] as string);

  it('without a crop paints exactly as before: no image, no credit', () => {
    const { ctx, calls } = fakeCtx();
    paintCardFace(ctx, 252, 352, { face });
    expect(calls.some(([n]) => n === 'drawImage')).toBe(false);
    expect(texts(calls).some((t) => t.includes('Illus.'))).toBe(false);
    expect(texts(calls)).toContain('M10 · Common');
  });

  it('draws the crop into the art box and credits the artist in the footer', () => {
    const { ctx, calls } = fakeCtx();
    paintCardFace(ctx, 252, 352, { face, crop: { bitmap: bitmap(626, 457), artist: 'Christopher Moeller' } });
    const draws = calls.filter(([n]) => n === 'drawImage');
    expect(draws).toHaveLength(1);
    // the art box at 252 px wide: x 17, y 49 (under the name bar), 218 × 140
    expect((draws[0]![1] as number[]).slice(5, 9)).toEqual([17, 49, 218, 140]);
    expect(texts(calls)).toContain('M10 · Common · Illus. Christopher Moeller');
  });

  it('draws the crop without a credit line when the artist is unknown', () => {
    const { ctx, calls } = fakeCtx();
    paintCardFace(ctx, 252, 352, { face, crop: { bitmap: bitmap(626, 457), artist: null } });
    expect(calls.filter(([n]) => n === 'drawImage')).toHaveLength(1);
    expect(texts(calls)).toContain('M10 · Common');
  });

  it('shortens a long credit to the room beside the P/T box', () => {
    const { ctx, calls } = fakeCtx();
    const creature = { ...face, power: 2, toughness: 2, type: { super: [], core: ['Creature'], sub: [] } } as unknown as CardFace;
    paintCardFace(ctx, 252, 352, { face: creature, crop: { bitmap: bitmap(626, 457), artist: 'A Very Long Name Indeed Of An Artist With Many Parts' } });
    const line = texts(calls).find((t) => t.includes('Illus.'))!;
    expect(line.length * 5).toBeLessThanOrEqual(252 - 16 - 78); // 5 px/char at the smallest size's measure
    expect(line.endsWith('…')).toBe(true);
  });

  it('caches framed and plain faces apart', () => {
    expect(faceKey(face, undefined, 'c:Lightning Bolt|M10|1')).not.toBe(faceKey(face));
    expect(faceKey(face, undefined, undefined)).toBe(faceKey(face));
  });
});
