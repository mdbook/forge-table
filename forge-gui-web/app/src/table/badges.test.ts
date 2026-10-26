import { describe, expect, it } from 'vitest';
import { cardWidth } from '../layout/geometry';
import { badgeLayout, badgeMetrics, costChip, flyOffset, frameCounter, pickSpot, popScale, revealedSpot, showsRevealedBadge, zPose, FLY_BOB, FLY_LIFT, type BadgeKind } from './cardSprite';
import type { Card } from '@forge-table/protocol';

const H = 150;
const W = cardWidth(H);
const m = badgeMetrics(H);

function inside(p: { x: number; y: number; scale: number }, w: number) {
  const half = (w * p.scale) / 2;
  expect(p.x - half).toBeGreaterThanOrEqual(-W / 2);
  expect(p.x + half).toBeLessThanOrEqual(W / 2);
  expect(p.y - m.h / 2).toBeGreaterThanOrEqual(-H / 2);
  // Clear of the bottom strip (artist, copyright): the bottom 8% of the card.
  expect(p.y + m.h / 2).toBeLessThanOrEqual(H * 0.42 + 1e-9);
}

describe('status badges sit on the card', () => {
  it('puts the P/T chip over the printed P/T box, bottom right', () => {
    const [pt] = badgeLayout(H, [{ kind: 'pt', w: 34 }]);
    inside(pt!, 34);
    expect(pt!.x + 17).toBeCloseTo(W / 2 - m.inset);
    expect(pt!.y).toBeGreaterThan(H * 0.3); // bottom eighth of the card, where the P/T box is
  });

  it('keeps the printed P/T box clear without a chip: damage goes above it', () => {
    const [dmg, c1] = badgeLayout(H, [
      { kind: 'damage', w: 26 },
      { kind: 'counter', w: 200 },
    ]);
    const [pt] = badgeLayout(H, [{ kind: 'pt', w: 34 }]);
    expect(dmg!.y).toBeLessThan(pt!.y);
    expect(c1!.x + (200 * c1!.scale) / 2).toBeLessThan(W / 2 - W * 0.24);
  });

  it('stacks damage just above the P/T chip, and counters up from the bottom left', () => {
    const kinds: BadgeKind[] = ['pt', 'damage', 'counter', 'counter'];
    const widths = [34, 26, 46, 40];
    const [pt, dmg, c1, c2] = badgeLayout(H, kinds.map((kind, i) => ({ kind, w: widths[i]! })));
    expect(dmg!.y).toBeLessThan(pt!.y);
    expect(dmg!.x + 13).toBeCloseTo(W / 2 - m.inset);
    expect(c1!.y).toBeCloseTo(pt!.y);
    expect(c2!.y).toBeCloseTo(dmg!.y);
    expect(c1!.x - (46 * c1!.scale) / 2).toBeCloseTo(-W / 2 + m.inset);
    [pt, dmg, c1, c2].forEach((p, i) => inside(p!, widths[i]!));
  });

  it('shrinks a counter that would run into the P/T chip, and never draws anything wider than the card', () => {
    const [pt, wide] = badgeLayout(H, [
      { kind: 'pt', w: 40 },
      { kind: 'counter', w: 90 },
    ]);
    expect(wide!.scale).toBeLessThan(1);
    expect(wide!.x + (90 * wide!.scale) / 2).toBeLessThan(pt!.x - 20);
    const [huge] = badgeLayout(H, [{ kind: 'pt', w: 400 }]);
    inside(huge!, 400);
  });

  it('scales with the card', () => {
    const [small] = badgeLayout(75, [{ kind: 'pt', w: 17 }]);
    const [big] = badgeLayout(150, [{ kind: 'pt', w: 34 }]);
    expect(small!.x * 2).toBeCloseTo(big!.x);
    expect(small!.y * 2).toBeCloseTo(big!.y);
  });

  it("drifts the sickness Z's up off the art's top-left, clear of the ×N badge in the top-right corner", () => {
    for (let i = 0; i < 3; i++) {
      for (let k = 0; k <= 1; k += 0.05) {
        const z = zPose(H, i, k);
        // Left of the card's middle (the ×N pill hangs in the top-right corner), inside its left edge.
        expect(z.x + 9 * z.s).toBeLessThan(0);
        expect(z.x - 9 * z.s).toBeGreaterThan(-W / 2);
        // From the top edge up off the card (never over the name bar or the art); faint throughout.
        expect(z.y + 8 * z.s).toBeLessThan(-H * 0.4);
        expect(z.y).toBeGreaterThan(-H * 0.8);
        expect(z.a).toBeLessThanOrEqual(0.7);
      }
      expect(zPose(H, i, 0).a).toBe(0);
      expect(zPose(H, i, 0.999).a).toBeLessThan(0.01);
      // The loop wraps: phase 1 is phase 0.
      expect(zPose(H, i, 1.3).y).toBeCloseTo(zPose(H, i, 0.3).y);
    }
  });

  it("hovers a flyer FLY_LIFT off the table with a slow bob, and still when calm", () => {
    const ys = Array.from({ length: 40 }, (_, i) => flyOffset('c12', i * 100, false));
    expect(Math.max(...ys)).toBeLessThanOrEqual(FLY_LIFT + FLY_BOB + 1e-9);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(FLY_LIFT - FLY_BOB - 1e-9);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(FLY_BOB);
    expect(flyOffset('c12', 1234, true)).toBe(FLY_LIFT);
    // Two flyers don't bob in step.
    expect(flyOffset('c12', 0, false)).not.toBeCloseTo(flyOffset('c13', 0, false));
  });
});
describe('costChip (show modified costs)', () => {
  it('shows a cost that differs from the printed one, green when cheaper', () => {
    expect(costChip('{2}{U}', '{4}{U}')).toEqual({ text: '2U', cheaper: true });
    expect(costChip('{2}{R}', '{1}{R}')).toEqual({ text: '2R', cheaper: false });
    expect(costChip('{0}', '{3}')).toEqual({ text: '0', cheaper: true });
    expect(costChip('{1}{R}', '{1}{R}')).toBeNull();
    expect(costChip(undefined, '{1}{R}')).toBeNull();
  });
});

describe('popScale (a changed cost pops in)', () => {
  it('starts small and ends at exactly 1', () => {
    expect(popScale(0)).toBeCloseTo(0.6);
    expect(popScale(1)).toBeCloseTo(1);
  });

  it('overshoots 1 on the way, a little, then settles', () => {
    const qs = Array.from({ length: 101 }, (_, i) => i / 100);
    const peak = Math.max(...qs.map(popScale));
    expect(peak).toBeGreaterThan(1.02);
    expect(peak).toBeLessThan(1.2);
    expect(popScale(0.5)).toBeGreaterThan(popScale(0.1)); // rises first
    expect(popScale(0.99)).toBeLessThan(popScale(0.7)); // then settles back from the peak
  });
});

describe('revealed-to-opponent eye badge', () => {
  it('shows only for a hand card flagged revealedToOpponent', () => {
    const card = { id: 'c1', revealedToOpponent: true } as Card;
    expect(showsRevealedBadge(true, card)).toBe(true);
  });

  it('does not show outside the hand, even if flagged', () => {
    const card = { id: 'c1', revealedToOpponent: true } as Card;
    expect(showsRevealedBadge(false, card)).toBe(false);
  });

  it('does not show in hand when not flagged', () => {
    expect(showsRevealedBadge(true, { id: 'c1' } as Card)).toBe(false);
    expect(showsRevealedBadge(true, undefined)).toBe(false);
  });

  it('sits in the art\'s top-left corner: inside the card, off the cost corner and the name line, clear of the pick badge', () => {
    for (const h of [100, 150, 240]) {
      const w = h * (63 / 88);
      const e = revealedSpot(h);
      // Inside the card.
      expect(e.x - e.r).toBeGreaterThan(-w / 2);
      expect(e.y - e.r).toBeGreaterThan(-h / 2);
      // The left half (the mana cost is top-right), below the name line (the art starts 12% down).
      expect(e.x + e.r).toBeLessThan(0);
      expect(e.y - e.r).toBeGreaterThanOrEqual(-h / 2 + h * 0.12);
      // Not under the pick badge straddling the top-left corner.
      const p = pickSpot(h);
      expect(Math.hypot(e.x - p.x, e.y - p.y)).toBeGreaterThan(e.r + p.r);
    }
  });
});

describe('counters on the M15 frame', () => {
  it('tints +1/+1 and -1/-1 under either spelling and keeps the count', () => {
    expect(frameCounter('P1P1', 12)).toMatchObject({ tone: 'plus', count: 12 });
    expect(frameCounter('+1/+1', 1)).toMatchObject({ tone: 'plus', count: 1 });
    expect(frameCounter('M1M1', 6)).toMatchObject({ tone: 'minus', count: 6 });
    expect(frameCounter('-1/-1', 1)).toMatchObject({ tone: 'minus' });
    expect(frameCounter('FIRST_STRIKE', 1)).toMatchObject({ tone: 'plain', letter: 'F' });
  });
});
