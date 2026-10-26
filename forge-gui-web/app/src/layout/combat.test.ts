import { describe, expect, it } from 'vitest';
import type { Card, CombatBand, GameModel, Player } from '@forge-table/protocol';
import { modelOf } from '../store/model';
import { CARD_SCALE, CARD_SIZES, GAP, cardWidth, geometry } from './geometry';
import { blockGroups, computeLayout, packRow, type CardPose } from './layout';

const creature = (id: string, controller: string, extra: Partial<Card> = {}): Card => ({
  id,
  controller,
  zone: 'Battlefield',
  state: { face: 'Original', name: id, type: { super: [], core: ['Creature'], sub: [] } },
  ...extra,
});

function board(mine: string[], theirs: string[], combat: CombatBand[], attacking: string[]): GameModel {
  const cards = [...mine.map((id) => creature(id, 'p0')), ...theirs.map((id) => creature(id, 'p1', { attacking: attacking.includes(id) }))];
  return modelOf(
    { turn: 2, phase: 'COMBAT_DECLARE_BLOCKERS', playerTurn: 'p1', stack: [], combat },
    { p0: { id: 'p0', life: 20, zones: { battlefield: mine } as Player['zones'] }, p1: { id: 'p1', life: 20, zones: { battlefield: theirs } as Player['zones'] } },
    Object.fromEntries(cards.map((c) => [c.id, c])),
  );
}

const overlapX = (a: CardPose, b: CardPose) => Math.abs(a.x - b.x) < (cardWidth(a.h) + cardWidth(b.h)) / 2 - 0.01;

describe('packRow (blockers hold their place, the rest make room)', () => {
  it('keeps items at their desired x when they fit apart', () => {
    expect(packRow([{ w: 100, x: 100, weight: 1 }, { w: 100, x: 400, weight: 1 }], 0, 1000)).toEqual([100, 400]);
  });

  it('pushes light items aside around a heavy one', () => {
    const xs = packRow([{ w: 100, x: 300, weight: 1 }, { w: 100, x: 320, weight: 1000 }], 0, 1000, 10)!;
    expect(xs[1]).toBeCloseTo(320, 0);
    expect(xs[1]! - xs[0]!).toBeCloseTo(110);
  });

  it('stays inside its range and gives up when the items cannot fit', () => {
    const xs = packRow([{ w: 100, x: 10, weight: 1 }, { w: 100, x: 20, weight: 1 }], 0, 1000, 10)!;
    expect(xs[0]).toBeCloseTo(50);
    expect(xs[1]).toBeCloseTo(160);
    expect(packRow([{ w: 600, x: 0, weight: 1 }, { w: 600, x: 0, weight: 1 }], 0, 1000)).toBeNull();
    expect(packRow([], 0, 10)).toEqual([]);
  });
});

describe('blockers in front of their attacker', () => {
  // The AI attacks with o1 and o3; I block o1 with m3 and double-block o3 with m0 and m4 (one planned, one locked).
  const combat: CombatBand[] = [
    { attacker: 'o1', defender: 'p0', blockers: ['m3'] },
    { attacker: 'o3', defender: 'p0', blockers: ['m4'], planned: ['m4', 'm0'] },
  ];
  const m = board(['m0', 'm1', 'm2', 'm3', 'm4'], ['o0', 'o1', 'o2', 'o3'], combat, ['o1', 'o3']);

  it('groups blockers per attacker, locked first', () => {
    expect([...blockGroups(m)]).toEqual([
      ['m3', { attacker: 'o1', index: 0, count: 1 }],
      ['m4', { attacker: 'o3', index: 0, count: 2 }],
      ['m0', { attacker: 'o3', index: 1, count: 2 }],
    ]);
  });

  for (const size of CARD_SIZES) {
    it(`aligns a lone blocker with its attacker, fans a double block across it, keeps the row apart (${size})`, () => {
      const g = geometry(1920, CARD_SCALE[size]);
      const l = computeLayout({ model: m, viewer: 'p0', cardScale: CARD_SCALE[size] });
      const p = (id: string) => l.cards.get(id)!;
      expect(p('m3').x).toBeCloseTo(p('o1').x, 0);
      const w = cardWidth(p('m4').h);
      expect((p('m4').x + p('m0').x) / 2).toBeCloseTo(p('o3').x, 0);
      expect(p('m0').x - p('m4').x).toBeGreaterThanOrEqual(w);
      // Fanned: tilted apart.
      expect(p('m4').rot).toBeLessThan(0);
      expect(p('m0').rot).toBeGreaterThan(0);
      // Blockers stay on my side; nothing in my front row overlaps; the row stays inside its lane.
      const front = ['m0', 'm1', 'm2', 'm3', 'm4'].map(p);
      for (const a of front) {
        expect(a.y).toBeGreaterThan(g.ROW_Y.centre);
        expect(a.x - cardWidth(a.h) / 2).toBeGreaterThanOrEqual(g.X.rowStart - 0.01);
        expect(a.x + cardWidth(a.h) / 2).toBeLessThanOrEqual(g.X.rowEnd + 0.01);
        for (const b of front) if (a !== b) expect(overlapX(a, b), `${a.id} × ${b.id}`).toBe(false);
      }
      // A blocker never overlaps its attacker.
      expect(p('o1').y + p('o1').h / 2).toBeLessThan(p('m3').y - p('m3').h / 2);
    });
  }

  it('does the same for the opponent’s blockers when I attack', () => {
    const mine: CombatBand[] = [{ attacker: 'm1', defender: 'p1', blockers: ['o0', 'o2'] }];
    const cards = [...['m0', 'm1', 'm2'].map((id) => creature(id, 'p0', { attacking: id === 'm1' })), ...['o0', 'o1', 'o2'].map((id) => creature(id, 'p1'))];
    const mm = modelOf(
      { turn: 3, phase: 'COMBAT_DECLARE_BLOCKERS', playerTurn: 'p0', stack: [], combat: mine },
      { p0: { id: 'p0', life: 20, zones: { battlefield: ['m0', 'm1', 'm2'] } as Player['zones'] }, p1: { id: 'p1', life: 20, zones: { battlefield: ['o0', 'o1', 'o2'] } as Player['zones'] } },
      Object.fromEntries(cards.map((c) => [c.id, c])),
    );
    const l = computeLayout({ model: mm, viewer: 'p0' });
    const p = (id: string) => l.cards.get(id)!;
    expect((p('o0').x + p('o2').x) / 2).toBeCloseTo(p('m1').x, 0);
    expect(overlapX(p('o1'), p('o0')) || overlapX(p('o1'), p('o2'))).toBe(false);
    expect(Math.abs(p('o2').x - p('o0').x)).toBeGreaterThanOrEqual(cardWidth(p('o0').h) + GAP / 2);
  });

  it('spreads the attackers so a double block beside a single block lines up exactly (the blocks fixture)', () => {
    const mm = board(
      ['m0', 'm1', 'm2'],
      ['o0', 'o1', 'o2'],
      [
        { attacker: 'o0', defender: 'p0', blockers: ['m0'] },
        { attacker: 'o1', defender: 'p0', blockers: ['m1', 'm2'] },
        { attacker: 'o2', defender: 'p0', blockers: [] },
      ],
      ['o0', 'o1', 'o2'],
    );
    const l = computeLayout({ model: mm, viewer: 'p0' });
    const p = (id: string) => l.cards.get(id)!;
    expect(p('m0').x).toBeCloseTo(p('o0').x, 1);
    expect((p('m1').x + p('m2').x) / 2).toBeCloseTo(p('o1').x, 1);
    for (const row of [['m0', 'm1', 'm2'], ['o0', 'o1', 'o2']]) {
      for (const a of row) for (const b of row) if (a !== b) expect(overlapX(p(a), p(b)), `${a} × ${b}`).toBe(false);
    }
  });

  it('a row too full to make room keeps its cards and lets the blocker overlap', () => {
    const many = Array.from({ length: 14 }, (_, i) => `m${i}`);
    const mm = board(many, ['o0'], [{ attacker: 'o0', defender: 'p0', blockers: ['m13'] }], ['o0']);
    const plain = computeLayout({ model: board(many, ['o0'], [{ attacker: 'o0', defender: 'p0', blockers: [] }], ['o0']), viewer: 'p0' });
    const l = computeLayout({ model: mm, viewer: 'p0' });
    expect(l.cards.get('m13')!.x).toBeCloseTo(l.cards.get('o0')!.x, 0);
    expect(l.cards.get('m0')!.x).toBeCloseTo(plain.cards.get('m0')!.x);
  });

  it('draws a picked-up blocker above its row, in place', () => {
    const quiet = board(['m0', 'm1'], ['o0'], [{ attacker: 'o0', defender: 'p0', blockers: [] }], ['o0']);
    const base = computeLayout({ model: quiet, viewer: 'p0' }).cards.get('m1')!;
    const up = computeLayout({ model: quiet, viewer: 'p0', lifted: 'm1' }).cards.get('m1')!;
    expect(up.y).toBe(base.y);
    expect(up.z).toBeGreaterThan(base.z);
    expect(up.x).toBe(base.x);
  });
});
