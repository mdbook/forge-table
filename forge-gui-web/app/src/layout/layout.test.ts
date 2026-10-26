import { describe, expect, it } from 'vitest';
import type { Card, GameModel, Player } from '@forge-table/protocol';
import { modelOf } from '../store/model';
import { scales } from '../hud/pos';
import { ATTACK_STEP, BAND, CARD_SCALE, CARD_SIZES, GAP, HAND, LAND, PHASE_STRIP, PILES, PLATE, PROMPT_W, ROW_Y, SIZE, STACK_PILL, TABLE_H, TABLE_W, X, cardWidth, geometry, worldWidth, type CardSize } from './geometry';
import { ATTACH_OFFSET, ROW_AXIS, computeLayout, handFan, layoutRow, touchFan, orderHand, type CardPose } from './layout';
/** The default table's back-row tuck (lands shrink by it). */
const TUCK = geometry().TUCK;

const creature = (id: string, controller: string, extra: Partial<Card> = {}): Card => ({
  id,
  controller,
  zone: 'Battlefield',
  state: { face: 'Original', name: id, type: { super: [], core: ['Creature'], sub: [] } },
  ...extra,
});
const land = (id: string, controller: string, extra: Partial<Card> = {}): Card => ({
  id,
  controller,
  zone: 'Battlefield',
  state: { face: 'Original', name: 'Mountain', type: { super: ['Basic'], core: ['Land'], sub: ['Mountain'] } },
  ...extra,
});

function model(p0: Partial<Player['zones']>, p1: Partial<Player['zones']>, cards: Card[], stack: GameModel['game']['stack'] = []): GameModel {
  return modelOf(
    { turn: 1, phase: 'MAIN1', playerTurn: 'p0', stack },
    { p0: { id: 'p0', life: 20, zones: p0 as Player['zones'] }, p1: { id: 'p1', life: 20, zones: p1 as Player['zones'] } },
    Object.fromEntries(cards.map((c) => [c.id, c])),
  );
}

describe('world width (PLAN §5)', () => {
  it('is 1920 at 16:9 and wider, narrows by aspect down to 1440 (4:3) and fits the width below that', () => {
    expect(worldWidth(1920, 1080)).toBe(1920);
    expect(worldWidth(1366, 768)).toBe(1920);
    expect(worldWidth(3440, 1440)).toBe(1920);
    expect(worldWidth(1600, 1000)).toBeCloseTo(1728);
    expect(worldWidth(1440, 1080)).toBeCloseTo(1440);
    expect(worldWidth(1376, 1073)).toBe(1440);
    expect(worldWidth(1024, 1000)).toBe(1440);
    // Between 4:3 and 16:9 the table scales by height; below 4:3 by width, letterboxed.
    expect(scales(1600, 1000).s).toBeCloseTo(1000 / 1080);
    expect(scales(1376, 1073)).toMatchObject({ s: 1376 / 1440, ox: 0 });
    expect(scales(1920, 1080)).toMatchObject({ s: 1, ox: 0, oy: 0, worldW: 1920 });
  });

  it('exports geometry() at 1920 tu, size M, HUD ×1', () => {
    const g = geometry();
    expect(g.X).toEqual(X);
    expect(g.SIZE).toEqual(SIZE);
    expect(g.ROW_Y).toEqual(ROW_Y);
    expect(g.PILES).toEqual(PILES);
    expect(g.HAND).toEqual(HAND);
    expect(SIZE).toMatchObject({ battlefield: 210, hand: 320 });
  });

  for (const size of CARD_SIZES) {
    it(`keeps every right-anchored thing clear of the battlefield rows at 1440 tu (${size})`, () => {
      const g = geometry(1440, CARD_SCALE[size]);
      const n = g.X;
      const pileHalf = cardWidth(g.SIZE.pile) / 2;
      // Piles at the right-hand end of the back rows, library outermost; my lands stop short of them.
      expect(g.PILES_X.library + pileHalf).toBeLessThanOrEqual(1440 - 20 + 1e-9);
      expect(g.PILES_X.exile).toBeLessThan(g.PILES_X.graveyard);
      expect(g.PILES_X.graveyard).toBeLessThan(g.PILES_X.library);
      expect(n.myBackRowEnd).toBeLessThan(g.PILES_X.exile - pileHalf);
      // The opponent's lands end left of their plate, their hand fan starts right of it.
      expect(n.oppBackRowEnd).toBeLessThan(g.PLATES.opp.x);
      expect(n.oppHandX - 90).toBeGreaterThan(g.PLATES.opp.x + g.PLATES.w);
      expect(n.rowEnd).toBeLessThanOrEqual(1440);
      // The front rows end left of the stack zone's cascade at its full depth.
      expect(n.stackLeft).toBeLessThan(n.stackX - cardWidth(g.SIZE.stackTop) / 2);
      expect(n.rowEndWithStack).toBeLessThan(n.stackLeft);
      expect(n.actionsX).toBeLessThan(1440);
      expect(n.ladderX + PHASE_STRIP.w).toBeLessThan(n.frontRowStart);
      expect(n.frontRowStart).toBeLessThan(n.rowEndWithStack);
      // The hand fan stays inside handMin–handMax at its widest spread.
      const fan = handFan(20, -1, 1, g);
      expect(fan[0]!.x - cardWidth(g.SIZE.hand) / 2).toBeGreaterThanOrEqual(n.handMin);
      expect(fan[19]!.x + cardWidth(g.SIZE.hand) / 2).toBeLessThanOrEqual(n.handMax);
    });
  }
});

describe('vertical budget and card sizes (PLAN §5)', () => {
  const all = CARD_SIZES.map((size) => ({ size, g: geometry(TABLE_W, CARD_SCALE[size]) }));

  for (const { size, g } of all) {
    it(`fits four rows and both hands in 1080 tu, the attack step clear of the opposing row (${size})`, () => {
      const { BAND, ROW_Y, SIZE, HAND, TUCK } = g;
      const bf = SIZE.battlefield;
      // Top to bottom: the status strip, opponent back / front, centre gap, my front / back, my hand's peek.
      expect(BAND.oppBack[0]).toBeGreaterThanOrEqual(42 - 1e-9);
      expect(BAND.myFront[1]).toBeLessThanOrEqual(BAND.myBack[0] + TUCK + 1e-9);
      expect(BAND.myBack[1]).toBeLessThan(BAND.hand[0]);
      expect(BAND.hand[1]).toBe(TABLE_H);
      // Back rows tuck behind their front row by at most 40% of a card.
      expect(TUCK).toBeGreaterThanOrEqual(0);
      expect(TUCK).toBeLessThanOrEqual(0.4 * bf + 1e-9);
      expect(BAND.oppFront[0] - BAND.oppBack[1]).toBeCloseTo(BAND.myBack[0] - BAND.myFront[1]);
      // An attacker's step stays on its side of the centre gap.
      expect(ROW_Y.myFront - bf / 2 - bf * ATTACK_STEP).toBeGreaterThan(BAND.oppFront[1]);
      expect(ROW_Y.oppFront + bf / 2 + bf * ATTACK_STEP).toBeLessThan(BAND.myFront[0]);
      // Lands are LAND of a battlefield card. My hand peeks 70% (at most 250 tu); a hovered card lifts fully
      // into view; the opponent's fan peeks in above their front row.
      expect(BAND.myBack[1] - BAND.myBack[0]).toBeCloseTo(LAND * bf);
      expect(TABLE_H - (HAND.y - SIZE.hand / 2)).toBeCloseTo(Math.min(0.7 * SIZE.hand, 250));
      const hoverH = SIZE.hand * SIZE.handHoverScale;
      expect(HAND.hoverY - hoverH / 2).toBeGreaterThan(0);
      expect(HAND.hoverY + hoverH / 2).toBeLessThanOrEqual(TABLE_H);
      expect(ROW_Y.oppHand + SIZE.oppHand / 2).toBeLessThan(BAND.oppFront[0]);
    });
  }

  it('grows the cards with the setting (the battlefield up to the height the rows can take)', () => {
    const [s, m, l, xl] = all.map((a) => a.g.SIZE);
    expect(m).toMatchObject({ battlefield: 210, hand: 320 });
    expect(s!.battlefield).toBeCloseTo(210 * 0.85);
    expect(s!.hand).toBeCloseTo(320 * 0.85);
    expect(l!.hand).toBeCloseTo(320 * 1.15);
    expect(xl!.hand).toBeCloseTo(320 * 1.3);
    expect(l!.battlefield).toBeGreaterThan(m!.battlefield);
    expect(xl!.battlefield).toBeGreaterThanOrEqual(l!.battlefield);
    // With the smaller lands, S and M fit without tucking; L tucks them a little.
    expect(all[0]!.g.TUCK).toBe(0);
    expect(all[1]!.g.TUCK).toBe(0);
    expect(all[2]!.g.TUCK).toBeGreaterThan(0);
  });
});

describe('bands (PLAN §5)', () => {
  it('puts each row in its band, mirrored about the centre line', () => {
    const inBand = (y: number, band: readonly [number, number]) => y >= band[0] && y <= band[1];
    expect(inBand(ROW_Y.myBack, BAND.myBack)).toBe(true);
    expect(inBand(ROW_Y.myFront, BAND.myFront)).toBe(true);
    expect(inBand(ROW_Y.oppFront, BAND.oppFront)).toBe(true);
    expect(inBand(ROW_Y.oppBack, BAND.oppBack)).toBe(true);
    expect(inBand(ROW_Y.centre, BAND.centre)).toBe(true);
    expect(ROW_Y.myFront + ROW_Y.oppFront).toBeCloseTo(2 * ROW_Y.centre);
    expect(ROW_Y.myBack + ROW_Y.oppBack).toBeCloseTo(2 * ROW_Y.centre);
  });

  it('places lands in the back row, creatures in front, the opponent above the centre line', () => {
    const m = model(
      { battlefield: ['c1', 'c2'], hand: ['c5'] },
      { battlefield: ['c3', 'c4'], hand: ['xa', 'xb'] },
      [land('c1', 'p0'), creature('c2', 'p0'), land('c3', 'p1'), creature('c4', 'p1'), { id: 'c5', zone: 'Hand', state: { face: 'Original' } }],
    );
    const l = computeLayout({ model: m, viewer: 'p0' });
    // Lands fit the visible part of their lane: a tucked back row shrinks by the tuck, away from the front row.
    expect(l.cards.get('c1')).toMatchObject({ region: 'myBack', y: ROW_Y.myBack + TUCK / 2, h: SIZE.land - TUCK });
    expect(l.cards.get('c2')).toMatchObject({ region: 'myFront', y: ROW_Y.myFront });
    expect(l.cards.get('c3')).toMatchObject({ region: 'oppBack', y: ROW_Y.oppBack - TUCK / 2, h: SIZE.land - TUCK });
    // Lands pack from the left edge; creatures centre on the table's axis.
    expect(l.cards.get('c1')!.x - cardWidth(SIZE.land - TUCK) / 2).toBeCloseTo(X.rowStart);
    expect(l.cards.get('c2')!.x).toBeCloseTo(ROW_AXIS);
    expect(l.cards.get('c4')).toMatchObject({ region: 'oppFront', y: ROW_Y.oppFront });
    expect(l.cards.get('c5')).toMatchObject({ region: 'hand', faceUp: true, h: SIZE.hand });
    // The opponent's hand is card backs (opaque slots).
    expect(l.cards.get('xa')).toMatchObject({ region: 'oppHand', faceUp: false });
    // Piles exist for both players; an empty exile has none (its slot stays: anchor).
    expect(l.piles.filter((p) => p.zone === 'library')).toHaveLength(2);
    expect(l.piles.filter((p) => p.zone === 'exile')).toHaveLength(0);
    expect(l.anchor({ zone: 'Exile', player: 'p0' }).x).toBeCloseTo(geometry().PILES_X.exile);
  });

  it('lays a known top card of a library face up on its pile; hidden ones stay backs', () => {
    const known = model({ library: ['x1', 'x2'] }, { library: ['c7', 'x3'] }, [{ id: 'c7', zone: 'Library', state: { face: 'Original' } } as Card]);
    const l = computeLayout({ model: known, viewer: 'p0' });
    const g = geometry();
    expect(l.cards.get('c7')).toMatchObject({ region: 'library', faceUp: true, x: g.PILES_X.library, y: g.PILES.opp.library });
    expect(l.piles.find((p) => p.player === 'p1' && p.zone === 'library')).toMatchObject({ topId: 'c7', count: 2 });
    expect(l.piles.find((p) => p.player === 'p0' && p.zone === 'library')?.topId).toBeUndefined();
    expect(l.cards.has('x1')).toBe(false);
    // Known but not on top (something went on it): just backs.
    const buried = computeLayout({ model: model({}, { library: ['x3', 'c7'] }, [{ id: 'c7', zone: 'Library', state: { face: 'Original' } } as Card]), viewer: 'p0' });
    expect(buried.cards.has('c7')).toBe(false);
  });

  it('shows 70% of a hand card, lifts a hovered one fully ×1.25 and parts its neighbours', () => {
    const m = model({ hand: ['c1', 'c2', 'c3'] }, {}, ['c1', 'c2', 'c3'].map((id) => ({ id, zone: 'Hand', state: { face: 'Original' } })));
    const plain = computeLayout({ model: m, viewer: 'p0' });
    const mid = plain.cards.get('c2')!;
    expect(TABLE_H - (mid.y - mid.h / 2)).toBeCloseTo(SIZE.hand * 0.7);
    const hovered = computeLayout({ model: m, viewer: 'p0', hover: 'c2' });
    const h2 = hovered.cards.get('c2')!;
    expect(h2.h).toBeCloseTo(SIZE.hand * SIZE.handHoverScale);
    expect(h2.y + h2.h / 2).toBeLessThanOrEqual(TABLE_H);
    expect(hovered.cards.get('c1')!.x).toBeCloseTo(plain.cards.get('c1')!.x - HAND.neighbourPart);
    expect(hovered.cards.get('c3')!.x).toBeCloseTo(plain.cards.get('c3')!.x + HAND.neighbourPart);
  });

  it('steps attackers toward the centre line', () => {
    const m = model({ battlefield: ['c1'] }, { battlefield: ['c2'] }, [creature('c1', 'p0', { attacking: true }), creature('c2', 'p1', { attacking: true })]);
    const l = computeLayout({ model: m, viewer: 'p0' });
    expect(l.cards.get('c1')!.y).toBeCloseTo(ROW_Y.myFront - SIZE.battlefield * ATTACK_STEP);
    expect(l.cards.get('c2')!.y).toBeCloseTo(ROW_Y.oppFront + SIZE.battlefield * ATTACK_STEP);
  });

  it('rotates tapped permanents 90° and gives them a card-height-wide slot', () => {
    const m = model({ battlefield: ['c1', 'c2'] }, {}, [land('c1', 'p0', { tapped: true }), land('c2', 'p0')]);
    const l = computeLayout({ model: m, viewer: 'p0' });
    expect(l.cards.get('c1')!.rot).toBeCloseTo(Math.PI / 2);
    const dx = l.cards.get('c2')!.x - l.cards.get('c1')!.x;
    const h = SIZE.land - TUCK; // a land
    expect(dx).toBeCloseTo(h / 2 + GAP + cardWidth(h) / 2);
  });

  it('moves the front rows out of the stack fan while the stack is non-empty', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const spell: Card = { id: 's9', zone: 'Stack', controller: 'p1', state: { face: 'Original', name: 'Bolt' } };
    const m = model({ battlefield: ids }, {}, [...ids.map((id) => creature(id, 'p0')), spell], [
      { id: 's1', text: 'Bolt', source: 's9', activator: 'p1', ability: false, trigger: false, targets: [] },
    ]);
    const l = computeLayout({ model: m, viewer: 'p0' });
    expect(l.stackActive).toBe(true);
    expect(l.cards.get('s9')).toMatchObject({ region: 'stack', h: SIZE.stackTop });
    const right = Math.max(...ids.map((id) => l.cards.get(id)!.x + cardWidth(l.cards.get(id)!.h) / 2));
    expect(right).toBeLessThanOrEqual(X.rowEndWithStack + 0.01);
  });
});

describe('row overflow', () => {
  const units = (n: number, tapped = false) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, tapped }));
  const H = SIZE.battlefield;
  const MIN = SIZE.battlefieldMin;

  it('keeps natural size and centres a row that fits', () => {
    const r = layoutRow(units(3), 0, 1000, H, MIN);
    expect(r.h).toBe(H);
    expect(r.overlapped).toBe(false);
    expect((r.xs[0]! + r.xs[2]!) / 2).toBeCloseTo(500);
  });

  it('centres on a given axis, sliding inward only when the row reaches an edge', () => {
    const short = layoutRow(units(2), 0, 600, H, MIN, 800);
    expect(short.xs[1]! + cardWidth(H) / 2).toBeCloseTo(600); // pushed back inside the range
    const fits = layoutRow(units(2), 0, 1200, H, MIN, 800);
    expect((fits.xs[0]! + fits.xs[1]!) / 2).toBeCloseTo(800);
  });

  it('shrinks toward the minimum size first', () => {
    const r = layoutRow(units(12), 0, 1300, H, MIN);
    expect(r.h).toBeLessThan(H);
    expect(r.h).toBeGreaterThanOrEqual(MIN);
    expect(r.overlapped).toBe(false);
    const w = cardWidth(r.h);
    expect(r.xs[11]! + w / 2 - (r.xs[0]! - w / 2)).toBeCloseTo(1300, 0);
  });

  it('then overlaps evenly, staying inside the row', () => {
    const r = layoutRow(units(40), 0, 1200, H, MIN);
    expect(r.h).toBe(MIN);
    expect(r.overlapped).toBe(true);
    const w = cardWidth(MIN);
    expect(r.xs[0]! - w / 2).toBeGreaterThanOrEqual(-0.01);
    expect(r.xs[39]! + w / 2).toBeLessThanOrEqual(1200.01);
    const steps = r.xs.slice(1).map((x, i) => x - r.xs[i]!);
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThan(1e-6);
  });

  it('never breaks on huge boards or empty rows', () => {
    expect(layoutRow([], 0, 100, H, MIN).xs).toEqual([]);
    const r = layoutRow(units(300, true), X.rowStart, X.rowEnd, H, MIN, ROW_AXIS);
    expect(r.xs.every(Number.isFinite)).toBe(true);
  });

  it('spreads a full hand across the free span between my plate and the prompt bar', () => {
    const free = X.handMax - X.handMin - 2 * HAND.fanHalf;
    const slots = handFan(20);
    expect(slots[19]!.x - slots[0]!.x).toBeCloseTo(free);
    expect(handFan(1)[0]!.x).toBe(X.handCentre);
  });

  it('stops spreading once cards sit fully side by side: a small hand stays compact, not stretched to fill the span', () => {
    const w = cardWidth(SIZE.hand);
    const few = handFan(3);
    expect(few[1]!.x - few[0]!.x).toBeCloseTo(w);
    expect(few[2]!.x - few[1]!.x).toBeCloseTo(w);
    // Centred: as far from handCentre on one side as the other.
    expect(few[0]!.x - X.handCentre).toBeCloseTo(-(few[2]!.x - X.handCentre));
  });
});

// ------------------------------------------------------------------------------------------ fit

interface Box {
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type Pt = [number, number];

/** The four corners of a card pose (rotation included), in tu. */
function cornersOf(p: CardPose): Pt[] {
  const hw = cardWidth(p.h) / 2;
  const hh = p.h / 2;
  const c = Math.cos(p.rot);
  const s = Math.sin(p.rot);
  return ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as Pt[]).map(([x, y]) => [p.x + x * c - y * s, p.y + x * s + y * c] as Pt);
}

const boxCorners = (b: Box): Pt[] => [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];

/** Axis-aligned bounds of a card pose (rotation included), in tu. */
function boundsOf(p: CardPose): Box {
  const cs = cornersOf(p);
  const xs = cs.map((c) => c[0]);
  const ys = cs.map((c) => c[1]);
  return { name: p.id, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Whether two convex quads overlap by more than a hair (separating-axis test). */
function quadsOverlap(a: Pt[], b: Pt[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < 4; i++) {
      const [x0, y0] = poly[i]!;
      const [x1, y1] = poly[(i + 1) % 4]!;
      const len = Math.hypot(x1 - x0, y1 - y0);
      const nx = -(y1 - y0) / len;
      const ny = (x1 - x0) / len;
      const proj = (q: Pt[]) => q.map(([x, y]) => x * nx + y * ny);
      const pa = proj(a);
      const pb = proj(b);
      if (Math.max(...pa) <= Math.min(...pb) + 0.01 || Math.max(...pb) <= Math.min(...pa) + 0.01) return false;
    }
  }
  return true;
}

const hit = (a: CardPose, b: CardPose | Box) => quadsOverlap(cornersOf(a), 'name' in b && !('rot' in b) ? boxCorners(b) : cornersOf(b as CardPose));

/**
 * The DOM HUD's boxes in tu for a viewport. The HUD scales by hs = max(s, 0.9), so one CSS unit is hs / s tu:
 * at 1366×768 everything is ~27% wider in tu than at 1080p. Sizes are the CSS ones (styles.css, Actions.tsx).
 */
function hudBoxes(w: number, h: number, size: CardSize = 'M'): Box[] {
  const { s, hs, worldW } = scales(w, h);
  const k = hs / s;
  const g = geometry(worldW, CARD_SCALE[size], k);
  const { X, SIZE, ROW_Y, PILES, PILES_X } = g;
  const primaryH = 72 * k;
  const promptBottom = 1058 - primaryH - 10 * k;
  // The stack pill (TableHud StackList): right-aligned on the stack zone, its top just under the front card.
  const pillRight = X.stackX + cardWidth(SIZE.stackTop) / 2;
  const pillTop = X.stackBottom + 8;
  // Pile badges: 40 × 20 units, centred on each pile's outer edge (TableHud.tsx PileCounts).
  const badges = (['mine', 'opp'] as const).flatMap((side) =>
    (['library', 'graveyard', 'exile'] as const).map((z) => {
      const half = (z === 'exile' ? SIZE.pile * 0.8 : SIZE.pile) / 2;
      const y = side === 'mine' ? PILES[side][z] + half - 2 : PILES[side][z] - half + 2;
      return { name: `${side} ${z} badge`, x0: PILES_X[z] - 20 * k, y0: y - 10 * k, x1: PILES_X[z] + 20 * k, y1: y + 10 * k };
    }),
  );
  return [
    // Mine hangs from (24, 1070); the opponent's from the top centre.
    { name: 'my plate', x0: PLATE.x, y0: TABLE_H - PLATE.bottom - PLATE.h * k, x1: PLATE.x + PLATE.w * k, y1: TABLE_H - PLATE.bottom },
    { name: 'opp plate', x0: worldW / 2 - (PLATE.w * k) / 2, y0: PLATE.top, x1: worldW / 2 + (PLATE.w * k) / 2, y1: PLATE.top + PLATE.h * k },
    { name: 'primary', x0: X.actionsX - 250 * k, y0: 1058 - primaryH, x1: X.actionsX, y1: 1058 },
    // A full-width prompt bar of four lines.
    { name: 'prompt bar', x0: X.actionsX - PROMPT_W * k, y0: promptBottom - 96 * k, x1: X.actionsX, y1: promptBottom },
    ...badges,
    // The phase strip and its chips on the centre line's left end.
    { name: 'phase strip', x0: X.ladderX, y0: ROW_Y.centre - (PHASE_STRIP.h * k) / 2, x1: X.ladderX + PHASE_STRIP.w * k, y1: ROW_Y.centre + (PHASE_STRIP.h * k) / 2 },
    // The status line, top left: a long one (a stack note), its bottom edge at 6 tu + ~26 units.
    { name: 'status line', x0: 16, y0: 0, x1: 16 + 560 * k, y1: 6 + 26 * k },
    // The settings gear, top right.
    { name: 'gear', x0: worldW - 44 * k, y0: 8 * k, x1: worldW - 10 * k, y1: 42 * k },
  ].concat([{ name: 'stack pill', x0: pillRight - STACK_PILL.w * k, y0: pillTop, x1: pillRight, y1: pillTop + STACK_PILL.h * k }]);
}

describe('a full 1v1 board fits the table and clears the HUD', () => {
  // Mine: 8 lands (2 tapped), 6 creatures (one attacking, one wearing an aura), 2 artifacts; 7 cards in hand.
  // Theirs: 7 lands, 5 creatures (one attacking, one wearing an aura).
  const myLands = Array.from({ length: 8 }, (_, i) => land(`ml${i}`, 'p0', { tapped: i < 2 }));
  const myCreatures = Array.from({ length: 6 }, (_, i) => creature(`mc${i}`, 'p0', { attacking: i === 0 }));
  const myAura: Card = { id: 'ma', zone: 'Battlefield', controller: 'p0', entityAttachedTo: 'mc2', state: { face: 'Original', name: 'Aura', type: { super: [], core: ['Enchantment'], sub: ['Aura'] } } };
  const myArtifacts: Card[] = ['mx0', 'mx1'].map((id) => ({ id, zone: 'Battlefield', controller: 'p0', state: { face: 'Original', name: id, type: { super: [], core: ['Artifact'], sub: [] } } }));
  const hand: Card[] = Array.from({ length: 7 }, (_, i) => ({ id: `h${i}`, zone: 'Hand', state: { face: 'Original', name: `h${i}` } }));
  const oppLands = Array.from({ length: 7 }, (_, i) => land(`ol${i}`, 'p1'));
  const oppCreatures = Array.from({ length: 5 }, (_, i) => creature(`oc${i}`, 'p1', { attacking: i === 1 }));
  const oppAura: Card = { ...myAura, id: 'oa', controller: 'p1', entityAttachedTo: 'oc3' };
  const all = [...myLands, ...myCreatures, myAura, ...myArtifacts, ...hand, ...oppLands, ...oppCreatures, oppAura];
  const m = model(
    { battlefield: [...myLands, ...myCreatures, myAura, ...myArtifacts].map((c) => c.id), hand: hand.map((c) => c.id) },
    { battlefield: [...oppLands, ...oppCreatures, oppAura].map((c) => c.id), hand: ['xa', 'xb', 'xc', 'xd', 'xe', 'xf', 'xg'] },
    all,
  );
  const rows = (l: ReturnType<typeof computeLayout>) => [...l.cards.values()].filter((p) => p.region !== 'hand' && p.region !== 'oppHand' && p.region !== 'stack');
  const VIEWPORTS = [
    [1920, 1080],
    [1366, 768],
    [1600, 1000],
    [1376, 1073],
    [1024, 768],
    [1024, 1000],
  ] as const;

  for (const size of CARD_SIZES) {
    for (const worldW of [1920, 1440]) {
      it(`keeps every row inside its lane limits and the rows apart at ${worldW} tu (${size}; attack step and attachments included)`, () => {
        const g = geometry(worldW, CARD_SCALE[size]);
        const l = computeLayout({ model: m, viewer: 'p0', worldW, cardScale: CARD_SCALE[size] });
        const cards = rows(l);
        for (const p of cards) {
          const b = boundsOf(p);
          const front = p.region === 'myFront' || p.region === 'oppFront';
          expect(b.x0, p.id).toBeGreaterThanOrEqual((front ? g.X.frontRowStart : g.X.rowStart) - 0.01);
          expect(b.x1, p.id).toBeLessThanOrEqual((p.region === 'myBack' ? g.X.myBackRowEnd : p.region === 'oppBack' ? g.X.oppBackRowEnd : g.X.rowEnd) + 0.01);
        }
        // Cards in different rows never overlap, except that a back row tucks behind its own front row by
        // TUCK (lands show their lower / upper part). Known exception: mid-combat, an attacker stepping
        // across the centre line can cover the tucked-in part of an attachment on the defending front row.
        const attachments = new Set(['ma', 'oa']);
        const attackers = new Set(['mc0', 'oc1']);
        const tuckPair = (a: string, b: string) => [a, b].sort().join() === 'myBack,myFront' || [a, b].sort().join() === 'oppBack,oppFront';
        for (const a of cards) {
          for (const b of cards) {
            if (a.region >= b.region) continue;
            if ((attachments.has(a.id) && attackers.has(b.id)) || (attachments.has(b.id) && attackers.has(a.id))) continue;
            if (tuckPair(a.region, b.region)) {
              const ba = boundsOf(a);
              const bb = boundsOf(b);
              const overlap = Math.min(ba.y1, bb.y1) - Math.max(ba.y0, bb.y0);
              expect(overlap, `${a.id} (${a.region}) × ${b.id} (${b.region})`).toBeLessThanOrEqual(g.TUCK + 0.01);
              continue;
            }
            expect(hit(a, b), `${a.id} (${a.region}) × ${b.id} (${b.region})`).toBe(false);
          }
        }
        // The attack step and the attachment offset stay on their own side of the opposing front row.
        const attacker = l.cards.get('mc0')!;
        expect(attacker.y).toBeCloseTo(g.ROW_Y.myFront - attacker.h * ATTACK_STEP);
        expect(l.cards.get('ma')!.y).toBeCloseTo(g.ROW_Y.myFront - l.cards.get('mc2')!.h * ATTACH_OFFSET);
        // My hand rests below the rows; the opponent's fan sits right of their plate, clear of their lands and
        // above their front row.
        const lowest = Math.max(...cards.map((p) => boundsOf(p).y1));
        const handTop = Math.min(...hand.map((c) => l.cards.get(c.id)!.y - g.SIZE.hand / 2));
        expect(lowest).toBeLessThan(handTop);
        for (const p of l.cards.values()) {
          if (p.region !== 'oppHand') continue;
          expect(boundsOf(p).x0, p.id).toBeGreaterThan(g.PLATES.opp.x + g.PLATES.w);
          expect(boundsOf(p).y1, p.id).toBeLessThan(g.BAND.oppFront[0]);
        }
      });
    }

    for (const [w, h] of VIEWPORTS) {
      it(`clears the plates, prompt bar, primary cluster, pile badges, phase strip, status line, gear and stack pill at ${w}×${h} (${size})`, () => {
        const hud = hudBoxes(w, h, size);
        const { worldW, s, hs } = scales(w, h);
        const opts = { viewer: 'p0', worldW, cardScale: CARD_SCALE[size], hudK: hs / s };
        const idle = computeLayout({ model: m, ...opts });
        const spell: Card = { id: 's9', zone: 'Stack', controller: 'p1', state: { face: 'Original', name: 'Bolt' } };
        const withStack = computeLayout({
          model: model(
            { battlefield: [...myLands, ...myCreatures, myAura, ...myArtifacts].map((c) => c.id), hand: hand.map((c) => c.id) },
            { battlefield: [...oppLands, ...oppCreatures, oppAura].map((c) => c.id), hand: ['xa'] },
            [...all, spell],
            [{ id: 's1', text: 'Bolt', source: 's9', activator: 'p1', ability: false, trigger: false, targets: [] }],
          ),
          ...opts,
        });
        for (const l of [idle, withStack]) {
          for (const p of l.cards.values()) {
            if (p.region === 'stack' || p.region === 'graveyard' || p.region === 'exile') continue;
            for (const box of hud) {
              if (box.name === 'stack pill' && !l.stackActive) continue;
              expect(hit(p, box), `${p.id} (${p.region}) × ${box.name}`).toBe(false);
            }
          }
        }
      });
    }
  }
});

describe('hand order (reorder cards in hand)', () => {
  it('keeps the dragged order, drops cards no longer in hand, and deals new cards at the end', () => {
    expect(orderHand(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
    expect(orderHand(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
    expect(orderHand(['a', 'c', 'd'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'd']);
  });
});

describe('drag to play: a card dragged out of my hand (table/handDrag.ts)', () => {
  it('the fan closes up without it; it keeps a hand pose to ease back into', () => {
    const m = model({ hand: ['h1', 'h2', 'h3'] }, {}, []);
    const two = computeLayout({ model: model({ hand: ['h1', 'h3'] }, {}, []), viewer: 'p0' });
    const out = computeLayout({ model: m, viewer: 'p0', dragOut: 'h2' });
    for (const id of ['h1', 'h3']) expect(out.cards.get(id)).toEqual(two.cards.get(id));
    expect(out.cards.get('h2')).toMatchObject({ region: 'hand', owner: 'p0' });
    // Not in my hand (already on its way): no effect.
    expect(computeLayout({ model: m, viewer: 'p0', dragOut: 'zz' }).cards).toEqual(computeLayout({ model: m, viewer: 'p0' }).cards);
  });
});

describe('touchFan (touch: the raised hand)', () => {
  it('spreads the hand across the box, bottoms on the line, and brings the focused card forward and bigger', () => {
    for (const n of [1, 4, 8, 12]) {
      const slots = touchFan(n, -1, 16, 864, 1400, 300);
      for (const s of slots) {
        expect(s.x - cardWidth(s.h) / 2).toBeGreaterThanOrEqual(16 - 0.01);
        expect(s.x + cardWidth(s.h) / 2).toBeLessThanOrEqual(864 + 0.01);
        expect(s.y + s.h / 2).toBeLessThanOrEqual(1400 + 0.01);
      }
    }
    const f = touchFan(8, 3, 16, 864, 1400, 300);
    expect(f[3]!.h).toBeGreaterThan(f[2]!.h);
    expect(f[3]!.y).toBeLessThan(f[2]!.y);
    expect(f[3]!.rot).toBe(0);
  });
});

describe('identical permanents group (QA: board flood)', () => {
  const lands = Array.from({ length: 6 }, (_, i) => land(`l${i}`, 'p0', { tapped: i === 5 }));
  const m = model({ battlefield: lands.map((c) => c.id) }, { battlefield: [] }, lands);
  it('stacks identical lands in one slot with a count; a tapped one stands apart', () => {
    const l = computeLayout({ model: m, viewer: 'p0' });
    const top = l.cards.get('l0')!;
    expect(top.count).toBe(5);
    expect(l.cards.get('l4')!.x).toBeGreaterThan(top.x);
    expect(l.cards.get('l4')!.z).toBeLessThan(top.z);
    expect(l.cards.get('l5')!.count).toBeUndefined();
  });
  it('a mark (selectable, picked…) splits a card out', () => {
    const l = computeLayout({ model: m, viewer: 'p0', marks: new Map([['l2', 'p']]) });
    expect(l.cards.get('l0')!.count).toBe(4);
    expect(l.cards.get('l2')!.count).toBeUndefined();
  });
});
