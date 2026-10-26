import { describe, expect, it } from 'vitest';
import { Graphics } from 'pixi.js';
import { drawSnooze, snoozeLabelFont, snoozeLabelY } from './snoozeFx';
import { cardWidth } from '../layout/geometry';

/** Each drawn shape's bounds, in draw order, with its instruction's action. */
function shapes(g: Graphics): Array<{ action: string; type: string; x0: number; y0: number; x1: number; y1: number }> {
  const out: Array<{ action: string; type: string; x0: number; y0: number; x1: number; y1: number }> = [];
  for (const ins of g.context.instructions as Array<{ action: string; data: { path?: { shapePath: { shapePrimitives: Array<{ shape: { type: string; getBounds(): { x: number; y: number; width: number; height: number } } }> } } } }>) {
    for (const p of ins.data.path?.shapePath.shapePrimitives ?? []) {
      const b = p.shape.getBounds();
      out.push({ action: ins.action, type: p.shape.type, x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height });
    }
  }
  return out;
}

describe('drawSnooze: the moon', () => {
  // Battlefield, hand, hovered hand and preview-sized cards (a teardrop on a hand card).
  for (const h of [150, 210, 320, 400, 520]) {
    it(`stays a round moon at ${h} tu: the crescent and the stars inside the night disc, no tail`, () => {
      const g = new Graphics();
      drawSnooze(g, h, 1, 0, 0, 0, true);
      const all = shapes(g);
      // The night disc: the second circle (the glow is the first).
      const circles = all.filter((s) => s.type === 'circle');
      const disc = circles[circles.length - 1]!;
      const after = all.slice(all.lastIndexOf(disc) + 1).filter((s) => s.type === 'polygon');
      expect(after.length).toBeGreaterThanOrEqual(3); // the crescent and two stars
      for (const s of after) {
        expect(s.x0).toBeGreaterThanOrEqual(disc.x0 - 1e-6);
        expect(s.x1).toBeLessThanOrEqual(disc.x1 + 1e-6);
        expect(s.y0).toBeGreaterThanOrEqual(disc.y0 - 1e-6);
        expect(s.y1).toBeLessThanOrEqual(disc.y1 + 1e-6);
      }
      // Nothing reaches the card's centre.
      expect(disc.y1).toBeLessThan(0);
    });
  }
});

describe('snoozeLabelY: the "Snoozed" pill', () => {
  for (const h of [150, 210, 320, 400, 520]) {
    it(`sits under the night disc, clear of its drift, and above the type line at ${h} tu`, () => {
      const g = new Graphics();
      drawSnooze(g, h, 1, 0, 0, 0, true);
      const circles = shapes(g).filter((s) => s.type === 'circle');
      const disc = circles[circles.length - 1]!;
      const { y, half } = snoozeLabelY(h);
      const u = h / 150;
      // The moon bobs 1.2 u while asleep: the pill's top stays below the disc's lowest point.
      expect(y - half).toBeGreaterThan(disc.y1 + 1.2 * u);
      // The type line starts about 0.05 card heights below the centre (cardSprite frame).
      expect(y + half).toBeLessThan(0.05 * h);
    });
  }
});

describe('snoozeLabelFont: legible on small cards, never wider than the card', () => {
  it('keeps 7.5 card units when that is already big enough', () => {
    expect(snoozeLabelFont(300, 0)).toBeCloseTo(15);
    expect(snoozeLabelFont(300, 10)).toBeCloseTo(15);
  });
  it('rises to the minimum on a small card, capped so the pill fits the card', () => {
    for (const h of [60, 90, 120, 150]) {
      const f = snoozeLabelFont(h, 18);
      expect(f, `${h}`).toBeGreaterThanOrEqual(7.5 * (h / 150));
      expect(f * 4.4 + 12 * (h / 150), `${h}`).toBeLessThanOrEqual(cardWidth(h) * 0.92 + 1e-9);
    }
    expect(snoozeLabelFont(150, 9)).toBeCloseTo(9);
  });
  it('the pill grows with the font', () => {
    expect(snoozeLabelY(150, 15).half).toBeCloseTo(2 * snoozeLabelY(150).half);
  });
});
