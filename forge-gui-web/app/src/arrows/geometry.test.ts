import { describe, expect, it } from 'vitest';
import { cardWidth } from '../layout/geometry';
import { arrowGeometry, arrowShape, boxExit, cardBox, quadAt, quadLength, subQuad, type Box } from './geometry';

const inside = (b: Box, p: { x: number; y: number }, eps = 1e-6) => Math.abs(p.x - b.x) <= b.hw + eps && Math.abs(p.y - b.y) <= b.hh + eps;
const onEdge = (b: Box, p: { x: number; y: number }, eps = 1e-6) =>
  inside(b, p, eps) && (Math.abs(Math.abs(p.x - b.x) - b.hw) < eps || Math.abs(Math.abs(p.y - b.y) - b.hh) < eps);

describe('arrow geometry', () => {
  it('evaluates and splits quadratics (de Casteljau)', () => {
    const p0 = { x: 0, y: 0 };
    const c = { x: 50, y: 100 };
    const p1 = { x: 100, y: 0 };
    expect(quadAt(p0, c, p1, 0)).toEqual(p0);
    expect(quadAt(p0, c, p1, 1)).toEqual(p1);
    expect(quadAt(p0, c, p1, 0.5)).toEqual({ x: 50, y: 50 });
    const half = subQuad(p0, c, p1, 0.5);
    expect(half.p1).toEqual({ x: 50, y: 50 });
    // The sub-curve traces the same points.
    expect(quadAt(half.p0, half.c, half.p1, 0.5).x).toBeCloseTo(quadAt(p0, c, p1, 0.25).x);
    expect(quadAt(half.p0, half.c, half.p1, 0.5).y).toBeCloseTo(quadAt(p0, c, p1, 0.25).y);
    expect(quadLength(p0, { x: 50, y: 0 }, p1)).toBeCloseTo(100);
  });

  it('leaves a box on its edge along the ray, pulled back by the inset', () => {
    const b: Box = { x: 100, y: 100, hw: 50, hh: 20 };
    expect(boxExit(b, { x: 300, y: 100 })).toEqual({ x: 150, y: 100 });
    expect(boxExit(b, { x: 100, y: 0 })).toEqual({ x: 100, y: 80 });
    expect(boxExit(b, { x: 300, y: 100 }, 0.5)).toEqual({ x: 125, y: 100 });
    expect(onEdge(b, boxExit(b, { x: 180, y: 160 }))).toBe(true);
    // A point inside the box stays where it is; the centre maps to itself.
    expect(boxExit(b, { x: 110, y: 105 })).toEqual({ x: 110, y: 105 });
    expect(boxExit(b, { x: 100, y: 100 })).toEqual({ x: 100, y: 100 });
  });

  it('turns a tapped card box sideways', () => {
    const up = cardBox(0, 0, 200);
    const tapped = cardBox(0, 0, 200, Math.PI / 2);
    expect(up).toMatchObject({ hw: cardWidth(200) / 2, hh: 100 });
    expect(tapped.hw).toBeCloseTo(100);
    expect(tapped.hh).toBeCloseTo(cardWidth(200) / 2);
  });

  it('runs from box to box, bowed to the left of travel, its ends on (or inside) the boxes', () => {
    const from = cardBox(400, 800, 210);
    const to = cardBox(400, 300, 210);
    const g = arrowGeometry(from, to, { bow: 0.2, fromInset: 0, toInset: 0 })!;
    expect(onEdge(from, g.p0)).toBe(true);
    expect(onEdge(to, g.p1)).toBe(true);
    // Travelling up the screen, left of travel is −x.
    expect(g.c.x).toBeLessThan(400);
    // A negative bow bows the other way.
    expect(arrowGeometry(from, to, { bow: -0.2 })!.c.x).toBeGreaterThan(400);
    // Insets pull the ends into the boxes.
    const deep = arrowGeometry(from, to, { fromInset: 0.5, toInset: 0.5 })!;
    expect(inside(from, deep.p0) && !onEdge(from, deep.p0)).toBe(true);
    expect(inside(to, deep.p1) && !onEdge(to, deep.p1)).toBe(true);
    // The bow is capped.
    const far = arrowGeometry({ x: 0, y: 0 }, { x: 2000, y: 0 }, { bow: 0.5, maxBow: 100 })!;
    expect(Math.abs(far.c.y)).toBeCloseTo(100);
  });

  it('is null for coincident ends and shrinks the head on short arrows', () => {
    expect(arrowGeometry({ x: 5, y: 5 }, { x: 5.2, y: 5 })).toBeNull();
    const short = arrowGeometry({ x: 0, y: 0 }, { x: 40, y: 0 }, { bow: 0, headLen: 34 })!;
    expect(short.headLen).toBeCloseTo(16);
    const long = arrowGeometry({ x: 0, y: 0 }, { x: 400, y: 0 }, { bow: 0, headLen: 34 })!;
    expect(long.headLen).toBe(34);
  });

  it('draws in along the curve: the head at B(k) pointing along it, the shaft ending at the notch', () => {
    const g = arrowGeometry({ x: 0, y: 0 }, { x: 400, y: 0 }, { bow: 0, headLen: 30, headW: 20 })!;
    const full = arrowShape(g, 1);
    const [tip, left, notch, right] = full.head;
    expect(tip).toEqual({ x: 400, y: 0 });
    expect(left.x).toBeCloseTo(370);
    expect(right.x).toBeCloseTo(370);
    expect(Math.abs(left.y - right.y)).toBeCloseTo(20);
    expect(notch.x).toBeCloseTo(400 - 30 * 0.72);
    expect(full.shaft.p1.x).toBeCloseTo(notch.x, 0);
    const half = arrowShape(g, 0.5);
    expect(half.head[0].x).toBeCloseTo(200);
    expect(half.shaft.p1.x).toBeLessThan(200);
    // At the very start the head is tiny.
    const start = arrowShape(g, 0.01);
    expect(Math.abs(start.head[1].y - start.head[3].y)).toBeLessThan(20);
  });
});
