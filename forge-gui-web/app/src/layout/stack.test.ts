import { describe, expect, it } from 'vitest';
import type { Card, GameModel, Player, StackItem } from '@forge-table/protocol';
import { modelOf } from '../store/model';
import { STACK_CASCADE, cardWidth, geometry, worldSize } from './geometry';
import { computeLayout } from './layout';
import { ABILITY_SCALE, abilityFace, abilityId, isAbilityId, itemOfAbility, stackCascade, stackEntries, stackExit, stackItemFor } from './stack';

const card = (id: string, zone: string, controller = 'p0', name = id): Card => ({ id, zone, controller, owner: controller, state: { face: 'Original', name } });
const item = (id: string, source: string | undefined, extra: Partial<StackItem> = {}): StackItem => ({ id, text: `${source} - does a thing`, ...(source ? { source } : {}), activator: 'p0', ability: false, trigger: false, targets: [], ...extra });

function model(stack: StackItem[], cards: Card[]): GameModel {
  return modelOf(
    { turn: 3, phase: 'MAIN1', playerTurn: 'p0', stack },
    { p0: { id: 'p0', life: 20, zones: {} as Player['zones'] }, p1: { id: 'p1', life: 20, zones: {} as Player['zones'] } },
    Object.fromEntries(cards.map((c) => [c.id, c])),
  );
}

describe('stack entries (docs/ui-rework/STACK.md)', () => {
  it('a spell is its card; an ability, a hidden source or a second item from one card is an ability card', () => {
    const m = model(
      [item('s4', 'c1', { ability: true }), item('s3', 'c2'), item('s2', 'c9', { ability: true, trigger: true, activator: 'p1' }), item('s1', 'xhidden', { ability: true })],
      [card('c1', 'Stack'), card('c2', 'Stack'), card('c9', 'Battlefield', 'p1'), card('c5', 'Stack', 'p1')],
    );
    expect(stackEntries(m).map((e) => [e.id, e.ability, e.source, e.controller])).toEqual([
      ['c1', false, 'c1', 'p0'],
      ['c2', false, 'c2', 'p0'],
      [abilityId('s2'), true, 'c9', 'p1'],
      [abilityId('s1'), true, 'xhidden', 'p0'],
      // A card on the stack no item names (a straggler) follows.
      ['c5', false, 'c5', 'p1'],
    ]);
    // A copy (a second item from c1) is an ability card.
    const copy = model([item('s9', 'c1'), item('s4', 'c1')], [card('c1', 'Stack')]);
    expect(stackEntries(copy).map((e) => e.id)).toEqual(['c1', abilityId('s4')]);
  });

  it('maps ability ids to their item, and any stack card or source to its item', () => {
    const m = model([item('s2', 'c9', { ability: true }), item('s1', 'c1')], [card('c1', 'Stack'), card('c9', 'Battlefield')]);
    expect(isAbilityId('ab:s2')).toBe(true);
    expect(isAbilityId('c1')).toBe(false);
    expect(itemOfAbility('ab:s2')).toBe('s2');
    expect(itemOfAbility('c1')).toBeNull();
    expect(stackItemFor(m, 'ab:s2')?.id).toBe('s2');
    expect(stackItemFor(m, 'c1')?.id).toBe('s1');
    expect(stackItemFor(m, 'c9')?.id).toBe('s2');
    expect(stackItemFor(m, 'ab:gone')).toBeUndefined();
  });

  it('an ability card reads the source, the kind and the bare ability text', () => {
    const ninja = abilityFace(item('s8', 'c121', { text: 'Ninja of the Deep Hours (121) - Mono-Blue Faeries puts Ninja of the Deep Hours (121) from their hand onto the battlefield.', ability: true }), 'Ninja of the Deep Hours');
    expect(ninja).toEqual({ name: 'Ninja of the Deep Hours', kind: 'Activated', text: 'Mono-Blue Faeries puts Ninja of the Deep Hours from their hand onto the battlefield.' });
    const kessig = abilityFace(item('st1', 'c7', { text: 'Kessig Flamebreather: Whenever you cast a noncreature spell, Kessig Flamebreather deals 1 damage to each opponent.', ability: true, trigger: true }), undefined);
    expect(kessig).toMatchObject({ name: 'Kessig Flamebreather', kind: 'Triggered', text: 'Whenever you cast a noncreature spell, Kessig Flamebreather deals 1 damage to each opponent.' });
    expect(abilityFace(item('s1', 'x1', { text: 'Draw a card.' }), undefined)).toMatchObject({ name: 'Ability', text: 'Draw a card.' });
  });
});

describe('the cascade', () => {
  const g = geometry();
  it('puts the newest in front, each older one up, left, smaller and darker', () => {
    const { slots, hidden } = stackCascade(3, g);
    expect(hidden).toBe(0);
    expect(slots[0]).toMatchObject({ x: g.X.stackX, h: g.SIZE.stackTop, depth: 0, shade: 1 });
    // The front card's bottom sits on the zone's bottom edge.
    expect(slots[0]!.y + slots[0]!.h / 2).toBeCloseTo(g.X.stackBottom);
    for (let i = 1; i < slots.length; i++) {
      const [a, b] = [slots[i - 1]!, slots[i]!];
      expect(b.x).toBeLessThan(a.x);
      expect(b.h).toBeLessThan(a.h);
      expect(b.shade).toBeLessThan(a.shade);
      // Its name bar peeks above the card in front of it.
      expect(b.y - b.h / 2).toBeLessThan(a.y - a.h / 2 - 0.12 * b.h);
    }
  });

  it('is louder (batch 11): a front card 1.5× the old one, right-centre, the older ones at their old size', () => {
    for (const [w, h] of [[1920, 1080], [1366, 768]] as const) {
      const world = worldSize(w, h);
      const gg = geometry(world.w, 1, 1, world.h);
      const { slots } = stackCascade(5, gg);
      expect(gg.SIZE.stackTop).toBeCloseTo(1.5 * 240);
      expect(slots[1]!.h).toBeCloseTo(0.78 * 240);
      // Centred near the centre line, inset from the right edge.
      expect(Math.abs(slots[0]!.y - gg.ROW_Y.centre)).toBeLessThan(30);
      expect(slots[0]!.x + cardWidth(slots[0]!.h) / 2).toBeLessThan(gg.W - 40);
      // At full depth it stays clear of the opponent's library and graveyard (their badges and click targets).
      for (const s of slots) {
        const left = s.x - cardWidth(s.h) / 2;
        for (const z of ['library', 'graveyard'] as const) {
          const pileBottom = gg.PILES.opp[z] + gg.SIZE.pile / 2;
          const half = cardWidth(gg.SIZE.pile) / 2;
          const overlapsX = left < gg.PILES_X[z] + half && left + cardWidth(s.h) > gg.PILES_X[z] - half;
          if (overlapsX) expect(s.y - s.h / 2).toBeGreaterThan(pileBottom);
        }
      }
    }
    // Portrait: 1.25×, all a phone's centre gap holds; the cascade stays in the centre gap.
    const world = worldSize(390, 844);
    const gp = geometry(world.w, 1, 1, world.h);
    expect(gp.SIZE.stackTop).toBeCloseTo(1.25 * 240);
    for (const s of stackCascade(4, gp).slots) {
      expect(s.y - s.h / 2).toBeGreaterThanOrEqual(gp.BAND.centre[0]);
      expect(s.y + s.h / 2).toBeLessThanOrEqual(gp.BAND.centre[1]);
    }
  });

  it('caps the visible depth and counts the rest; stays inside the zone and the table', () => {
    for (const portrait of [false, true]) {
      const world = portrait ? worldSize(390, 844) : { w: 1920, h: 1080 };
      const gg = geometry(world.w, 1, 1, world.h);
      const cap = portrait ? STACK_CASCADE.portrait.depth : STACK_CASCADE.landscape.depth;
      const { slots, hidden } = stackCascade(12, gg);
      expect(slots).toHaveLength(cap);
      expect(hidden).toBe(12 - cap);
      for (const s of slots) {
        expect(s.x - cardWidth(s.h) / 2).toBeGreaterThanOrEqual(gg.X.stackLeft - 1e-6);
        expect(s.x + cardWidth(s.h) / 2).toBeLessThanOrEqual(gg.W);
        expect(s.y - s.h / 2).toBeGreaterThan(0);
      }
    }
  });

  it('lays out ability cards a little smaller, and a deep stack only to the cascade’s depth', () => {
    const items = Array.from({ length: 10 }, (_, i) => item(`s${i}`, i % 2 ? `c${i}` : 'c99', { ability: i % 2 === 0 }));
    const cards = [...Array.from({ length: 10 }, (_, i) => card(`c${i}`, i % 2 ? 'Stack' : 'Graveyard')), card('c99', 'Battlefield')];
    const l = computeLayout({ model: model(items, cards), viewer: 'p0' });
    const onStack = [...l.cards.values()].filter((p) => p.region === 'stack');
    expect(onStack).toHaveLength(STACK_CASCADE.landscape.depth);
    expect(l.stackTop).toBe('ab:s0');
    expect(l.stackHidden).toBe(10 - STACK_CASCADE.landscape.depth);
    expect(l.stackDeepest).toBe('ab:s4');
    const front = l.cards.get('ab:s0')!;
    expect(front.h).toBeCloseTo(g.SIZE.stackTop * ABILITY_SCALE);
    // It hangs from the same top edge as a card would.
    expect(front.y - front.h / 2).toBeCloseTo(g.X.stackBottom - g.SIZE.stackTop);
    expect(l.cards.get('c1')).toMatchObject({ depth: 1, faceUp: true });
  });
});

describe('stack exits', () => {
  const m = model([item('s2', 'c2'), item('s1', 'c1')], [card('c1', 'Stack'), card('c2', 'Stack')]);
  const gy = { player: 'p0', zone: 'Graveyard' };
  it('routes a card leaving the stack: resolved, countered, to exile, onto the battlefield, back to hand', () => {
    expect(stackExit('c2', { zone: 'Stack' }, gy, m)).toBe('resolve');
    // c1 leaves while c2 (a counterspell) is still above it.
    expect(stackExit('c1', { zone: 'Stack' }, gy, m)).toBe('countered');
    expect(stackExit('c1', { zone: 'Stack' }, { zone: 'Exile' }, m)).toBe('countered');
    expect(stackExit('c2', { zone: 'Stack' }, { zone: 'Exile' }, m)).toBe('exile');
    expect(stackExit('c2', { zone: 'Stack' }, { zone: 'Battlefield' }, m)).toBe('permanent');
    expect(stackExit('c1', { zone: 'Stack' }, { zone: 'Hand' }, m)).toBe('bounce');
    // A card no item names any more resolved.
    expect(stackExit('c7', { zone: 'Stack' }, gy, m)).toBe('resolve');
    // Not from the stack: not a stack exit (the model knows where it was when the beat does not say).
    expect(stackExit('c9', { zone: 'Battlefield' }, gy, m)).toBeNull();
    expect(stackExit('c2', undefined, gy, m)).toBe('resolve');
    expect(stackExit('c2', { zone: 'Hand' }, { zone: 'Stack' }, m)).toBeNull();
  });
});
