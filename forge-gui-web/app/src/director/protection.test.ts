import { describe, expect, it } from 'vitest';
import type { Card, GameModel, StackItem } from '@forge-table/protocol';
import { illegalTarget, protectionOf, wardCostOf, wardLabel, wardTrigger } from './protection';

const card = (id: string, controller: string, keywords: string[], extra: Partial<Card> = {}, colors = ''): Card => ({
  id,
  zone: 'Battlefield',
  controller,
  state: { face: 'Original', name: id, colors, type: { super: [], core: ['Creature'], sub: [] }, keywords: keywords.map((title) => ({ title })) },
  ...extra,
});

describe('protectionOf (director/protection.ts)', () => {
  it('reads the keyword titles Forge sends', () => {
    const p = protectionOf(card('c1', 'p1', ['Flying', 'Hexproof', 'Shroud', 'Protection from red', 'Hexproof from blue', 'Ward {2}']))!;
    expect(p.shields).toEqual([
      { kind: 'hexproof', from: null },
      { kind: 'shroud', from: null },
      { kind: 'protection', from: 'red' },
      { kind: 'hexproof', from: 'blue' },
    ]);
    expect(p.wards).toEqual([{ kind: 'mana', text: '{2}' }]);
  });

  it('is null for plain cards, cards off the battlefield and face-down cards', () => {
    expect(protectionOf(card('c1', 'p1', ['Flying']))).toBeNull();
    expect(protectionOf(undefined)).toBeNull();
    expect(protectionOf(card('c1', 'p1', ['Hexproof'], { zone: 'Graveyard' }))).toBeNull();
    expect(protectionOf(card('c1', 'p1', ['Hexproof'], { facedown: true }))).toBeNull();
  });

  it('its key changes with what is drawn', () => {
    const a = protectionOf(card('c1', 'p1', ['Hexproof']))!.key;
    expect(protectionOf(card('c2', 'p1', ['Hexproof']))!.key).toBe(a);
    expect(protectionOf(card('c3', 'p1', ['Hexproof', 'Ward {1}']))!.key).not.toBe(a);
  });

  it('parses ward costs', () => {
    expect(wardCostOf(' {1}{U}')).toEqual({ kind: 'mana', text: '{1}{U}' });
    expect(wardCostOf('—Pay 3 life.')).toEqual({ kind: 'life', n: 3 });
    expect(wardCostOf('—Discard a card.')).toEqual({ kind: 'discard' });
    expect(wardCostOf('—Sacrifice a creature.')).toEqual({ kind: 'sacrifice' });
    expect(wardCostOf('—Collect evidence 4.')).toEqual({ kind: 'other', text: 'Collect evidence 4' });
    expect(wardLabel({ kind: 'life', n: 3 })).toBe('3 life');
  });
});

describe('illegalTarget', () => {
  const bolt = card('s1', 'p0', [], { zone: 'Stack' }, 'R');
  it('hexproof stops the opponent, not the controller', () => {
    const hex = card('c1', 'p1', ['Hexproof']);
    expect(illegalTarget(hex, bolt, 'p0')).toBe('hexproof');
    expect(illegalTarget(hex, bolt, 'p1')).toBeNull();
  });

  it('shroud stops everyone', () => {
    const shroud = card('c1', 'p1', ['Shroud']);
    expect(illegalTarget(shroud, bolt, 'p0')).toBe('shroud');
    expect(illegalTarget(shroud, bolt, 'p1')).toBe('shroud');
  });

  it('protection and "hexproof from" judge the source by colour', () => {
    const pro = card('c1', 'p1', ['Protection from red']);
    expect(illegalTarget(pro, bolt, 'p0')).toBe('protection');
    expect(illegalTarget(pro, card('s2', 'p0', [], {}, 'U'), 'p0')).toBeNull();
    const hexBlue = card('c2', 'p1', ['Hexproof from blue']);
    expect(illegalTarget(hexBlue, card('s2', 'p0', [], {}, 'U'), 'p0')).toBe('hexproof');
    expect(illegalTarget(hexBlue, bolt, 'p0')).toBeNull();
    // An unknown qualifier is never judged (no false deflect).
    expect(illegalTarget(card('c3', 'p1', ['Protection from Elves']), bolt, 'p0')).toBeNull();
    expect(illegalTarget(card('c4', 'p1', ['Protection from everything']), bolt, 'p0')).toBe('protection');
    expect(illegalTarget(card('c5', 'p1', ['Protection from artifacts']), bolt, 'p0')).toBeNull();
  });

  it('ward and plain cards are legal targets', () => {
    expect(illegalTarget(card('c1', 'p1', ['Ward {2}']), bolt, 'p0')).toBeNull();
    expect(illegalTarget(card('c1', 'p1', []), bolt, 'p0')).toBeNull();
  });
});

describe('wardTrigger', () => {
  const model = { game: { stack: [] }, players: {}, cards: { c1: card('c1', 'p1', ['Ward {2}']), c2: card('c2', 'p1', ['Flying']) } } as unknown as GameModel;
  const item = (source: string, text: string, trigger = true): StackItem => ({ id: 's1', text, source, ability: true, trigger, targets: [] });
  it('names the warded permanent for its trigger', () => {
    expect(wardTrigger(model, item('c1', 'Ward {2} (Whenever this creature becomes the target of a spell or ability an opponent controls, counter it unless that player pays {2}.)'))).toBe('c1');
    expect(wardTrigger(model, item('c1', 'Whenever this permanent becomes the target of a spell, counter it unless that player pays {2}'))).toBe('c1');
  });
  it('is null for other items', () => {
    expect(wardTrigger(model, item('c2', 'counter it unless'))).toBeNull();
    expect(wardTrigger(model, item('c1', 'Ward {2}', false))).toBeNull();
    expect(wardTrigger(model, item('c1', 'Draw a card.'))).toBeNull();
  });
});
