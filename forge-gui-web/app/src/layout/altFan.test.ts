import { describe, expect, it } from 'vitest';
import type { Card, GameModel, Player } from '@forge-table/protocol';
import { modelOf } from '../store/model';
import { CARD_SCALE, CARD_SIZES, GAP, cardWidth, geometry, worldSize } from './geometry';
import { altFan, altReserve, altStep, computeLayout, handFan } from './layout';

const card = (id: string, zone: string, extra: Partial<Card> = {}): Card => ({ id, zone, controller: 'p0', owner: 'p0', state: { face: 'Original', name: id, type: { super: [], core: ['Instant'], sub: [] } }, ...extra });

function board(hand: string[], graveyard: string[], exile: string[] = []): GameModel {
  const cards = [...hand.map((i) => card(i, 'Hand')), ...graveyard.map((i) => card(i, 'Graveyard')), ...exile.map((i) => card(i, 'Exile'))];
  return modelOf(
    { turn: 3, phase: 'MAIN1', playerTurn: 'p0', stack: [] },
    { p0: { id: 'p0', life: 20, zones: { hand, graveyard, exile } as Player['zones'] }, p1: { id: 'p1', life: 20, zones: {} as Player['zones'] } },
    Object.fromEntries(cards.map((c) => [c.id, c])),
  );
}

const geos = [
  ['1920 M', geometry()],
  ['1920 XL', geometry(1920, CARD_SCALE.XL)],
  ['1366x768 hud', geometry(1920, 1, 1.27)],
  ['1440 S', geometry(1440, CARD_SCALE.S)],
  ['portrait 390x844', (() => { const w = worldSize(390, 844); return geometry(w.w, 1, 1.4, w.h); })()],
] as const;

describe('alt-zone strip beside the hand (docs/ui-rework/ALTCAST-MTGA.md)', () => {
  it('reserves nothing without cards, a card and a gap for one, and never more than its cap', () => {
    const g = geometry();
    expect(altReserve(0, g)).toBe(0);
    // Landscape: plus the room for a prompt's secondary button right of it (ALT.clear).
    expect(altReserve(1, g)).toBeCloseTo(cardWidth(g.ALT.h) + 2 * GAP + g.ALT.clear);
    expect(altReserve(40, g)).toBeCloseTo(g.ALT.maxW + 2 * GAP + g.ALT.clear);
    expect(altReserve(3, g)).toBeGreaterThan(altReserve(2, g));
  });

  for (const [name, g] of geos) {
    for (const n of [1, 2, 4, 12]) {
      it(`${name}: ${n} card(s) sit inside the hand's span, whole on screen, clear of the narrowed hand fan`, () => {
        const strip = altFan(n, -1, g);
        const w = cardWidth(g.ALT.h);
        expect(strip).toHaveLength(n);
        for (const s of strip) {
          expect(s.x - w / 2).toBeGreaterThanOrEqual(g.X.handMax - altReserve(n, g) - 1e-6);
          expect(s.x + w / 2).toBeLessThanOrEqual(g.X.handMax - GAP + 1e-6);
          expect(s.y + s.h / 2).toBeLessThanOrEqual(g.H + 1e-6);
        }
        // Left to right, in order; up to four cards each show at least 45% of themselves (more crowd the cap).
        for (let i = 1; i < n; i++) expect(strip[i]!.x - strip[i - 1]!.x).toBeGreaterThan(n <= 4 ? w * 0.45 : 8);
        // The hand (7 cards) lives left of the strip.
        const hand = handFan(7, -1, 1, g, altReserve(n, g));
        const right = Math.max(...hand.map((s) => s.x)) + cardWidth(g.SIZE.hand) / 2;
        expect(right).toBeLessThanOrEqual(g.X.handMax - altReserve(n, g) + cardWidth(g.SIZE.hand) * 0.25);
      });
    }
  }

  it('neighbours show about nine tenths of a card, less only when many crowd the cap', () => {
    const g = geometry();
    const w = cardWidth(g.ALT.h);
    expect(altStep(1, g)).toBe(0);
    expect(altStep(3, g)).toBeCloseTo(w * g.ALT.step);
    expect(altStep(12, g)).toBeLessThan(w * 0.5);
  });

  it('the hand fan is unchanged with no strip and narrows toward the left with one', () => {
    const g = geometry();
    expect(handFan(7, -1, 1, g, 0)).toEqual(handFan(7, -1, 1, g));
    const wide = handFan(9, -1, 1, g);
    const narrow = handFan(9, -1, 1, g, altReserve(3, g));
    expect(Math.max(...narrow.map((s) => s.x))).toBeLessThan(Math.max(...wide.map((s) => s.x)));
    expect(narrow[0]!.x).toBeGreaterThanOrEqual(g.X.handMin);
  });

  it('hovering a card lifts it fully into view and parts its neighbours', () => {
    const g = geometry();
    const rest = altFan(3, -1, g);
    const hov = altFan(3, 1, g);
    expect(hov[1]!.h).toBeCloseTo(g.ALT.h * g.ALT.hoverScale);
    expect(hov[1]!.y + hov[1]!.h / 2).toBeLessThanOrEqual(g.H);
    expect(hov[0]!.x).toBeLessThan(rest[0]!.x);
    expect(hov[2]!.x).toBeGreaterThan(rest[2]!.x);
  });

  it('computeLayout gives the strip cards the alt region, beside (not under) the hand, and the hand keeps its own', () => {
    const m = board(['h1', 'h2', 'h3'], ['g1', 'g2'], ['e1']);
    const l = computeLayout({ model: m, viewer: 'p0', alt: ['g2', 'e1'] });
    expect(l.cards.get('g2')).toMatchObject({ region: 'alt', owner: 'p0', faceUp: true });
    expect(l.cards.get('e1')!.x).toBeGreaterThan(l.cards.get('g2')!.x);
    expect(l.cards.get('h1')!.region).toBe('hand');
    const handRight = Math.max(...['h1', 'h2', 'h3'].map((id) => l.cards.get(id)!.x));
    expect(l.cards.get('g2')!.x).toBeGreaterThan(handRight);
    // A card the alt list names that is in my hand stays a hand card.
    expect(computeLayout({ model: m, viewer: 'p0', alt: ['h1'] }).cards.get('h1')!.region).toBe('hand');
  });

  it('a card dragged out over the table closes its gap; the hover parts the rest', () => {
    const m = board(['h1'], ['g1', 'g2', 'g3']);
    const rest = computeLayout({ model: m, viewer: 'p0', alt: ['g1', 'g2', 'g3'] });
    const out = computeLayout({ model: m, viewer: 'p0', alt: ['g1', 'g2', 'g3'], dragOut: 'g2' });
    expect(out.cards.get('g2')!.region).toBe('alt');
    // The strip is right-aligned: the cards before the gap close up toward it.
    expect(out.cards.get('g1')!.x).toBeGreaterThan(rest.cards.get('g1')!.x);
    const hovered = computeLayout({ model: m, viewer: 'p0', alt: ['g1', 'g2', 'g3'], hover: 'g2' });
    expect(hovered.cards.get('g2')!.h).toBeGreaterThan(rest.cards.get('g2')!.h);
    expect(hovered.cards.get('g2')!.z).toBeGreaterThan(rest.cards.get('g2')!.z);
  });

  it('the pile shows its newest card that has no pose of its own (a strip card leaves the pile)', () => {
    const m = board([], ['g1', 'g2', 'g3']);
    const plain = computeLayout({ model: m, viewer: 'p0' });
    expect(plain.piles.find((p) => p.player === 'p0' && p.zone === 'graveyard')!.topId).toBe('g3');
    const l = computeLayout({ model: m, viewer: 'p0', alt: ['g3'] });
    expect(l.piles.find((p) => p.player === 'p0' && p.zone === 'graveyard')!.topId).toBe('g2');
    expect(l.cards.get('g3')!.region).toBe('alt');
    expect(l.cards.get('g2')!.region).toBe('graveyard');
  });

  for (const size of CARD_SIZES) {
    it(`size ${size}: the strip fits a full hand beside it at 1920`, () => {
      const g = geometry(1920, CARD_SCALE[size]);
      const n = 5;
      const hand = handFan(10, -1, 1, g, altReserve(n, g));
      const strip = altFan(n, -1, g);
      const handRight = Math.max(...hand.map((s) => s.x)) + cardWidth(g.SIZE.hand) / 2;
      const stripLeft = strip[0]!.x - cardWidth(g.ALT.h) / 2;
      // The fan's edge cards tilt and the resting hand only peeks, so allow the strip a quarter card of overlap.
      expect(handRight - stripLeft).toBeLessThan(cardWidth(g.SIZE.hand) * 0.3);
    });
  }
});
