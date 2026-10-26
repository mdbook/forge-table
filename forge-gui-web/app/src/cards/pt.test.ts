import { describe, expect, it } from 'vitest';
import type { Card } from '@forge-table/protocol';
import { PrintedPtMemo, netPtCounters, ptChip } from './pt';

const creature = (id: string, zone: string, power: number, toughness: number, extra: Partial<Card> = {}, face: Record<string, unknown> = {}): Card => ({
  id,
  zone,
  state: { face: 'Original', name: 'Grizzly Bears', power, toughness, type: { super: [], core: ['Creature'], sub: ['Bear'] }, ...face },
  ...extra,
});

describe('P/T chip for real card art', () => {
  it('shows nothing when the printed P/T cannot be told or matches', () => {
    const memo = new PrintedPtMemo();
    expect(ptChip(creature('c1', 'Battlefield', 3, 3), memo)).toBeNull(); // never seen elsewhere, no counters
    memo.observe(creature('c1', 'Hand', 2, 2));
    expect(ptChip(creature('c1', 'Battlefield', 2, 2), memo)).toBeNull();
  });

  it('compares with the P/T the face showed off the battlefield', () => {
    const memo = new PrintedPtMemo();
    memo.observe(creature('c1', 'Hand', 2, 2));
    // Observing on the battlefield never overwrites the printed value.
    memo.observe(creature('c1', 'Battlefield', 5, 5));
    expect(ptChip(creature('c1', 'Battlefield', 3, 3), memo)).toEqual({ text: '3/3', tone: 'up' });
    expect(ptChip(creature('c1', 'Battlefield', 1, 2), memo)).toEqual({ text: '1/2', tone: 'down' });
    expect(ptChip(creature('c1', 'Battlefield', 4, 1), memo)).toEqual({ text: '4/1', tone: 'mixed' });
  });

  it('falls back to +1/+1 and -1/-1 counters (keyed as the wire sends them)', () => {
    expect(netPtCounters({ '+1/+1': 2, '-1/-1': 1, Charge: 4 })).toBe(1);
    expect(netPtCounters({ P1P1: 1 })).toBe(1);
    expect(netPtCounters(undefined)).toBe(0);
    const memo = new PrintedPtMemo();
    const c = creature('t1', 'Battlefield', 3, 3, { counters: { '+1/+1': 2 } }, { name: 'Soldier Token' });
    expect(memo.printed(c)).toEqual({ power: 1, toughness: 1 });
    expect(ptChip(c, memo)).toEqual({ text: '3/3', tone: 'up' });
    const shrunk = creature('t2', 'Battlefield', 0, 0, { counters: { '-1/-1': 1 } }, { name: 'Elf Token' });
    expect(ptChip(shrunk, memo)).toEqual({ text: '0/0', tone: 'down' });
  });

  it('prefers printed values sent by the server', () => {
    const memo = new PrintedPtMemo();
    memo.observe(creature('c1', 'Hand', 9, 9));
    const c = creature('c1', 'Battlefield', 4, 4, {}, { printedPower: 2, printedToughness: 2 });
    expect(ptChip(c, memo)).toEqual({ text: '4/4', tone: 'up' });
  });

  it('shows the current P/T, never a difference, even below zero', () => {
    // Kessig Flamebreather (printed 1/3) enchanted with Cryoshatter (-5/-0): the bridge sends power -4.
    const c = creature('c1', 'Battlefield', -4, 3, {}, { printedPower: 1, printedToughness: 3 });
    expect(ptChip(c, new PrintedPtMemo())).toEqual({ text: '-4/3', tone: 'down' });
  });

  it('only applies to face-up battlefield creatures', () => {
    const memo = new PrintedPtMemo();
    memo.observe(creature('c1', 'Hand', 2, 2));
    expect(ptChip(creature('c1', 'Graveyard', 3, 3), memo)).toBeNull();
    expect(ptChip(creature('c1', 'Battlefield', 3, 3, { facedown: true }), memo)).toBeNull();
    const land: Card = { id: 'l1', zone: 'Battlefield', state: { face: 'Original', name: 'Mountain', type: { super: ['Basic'], core: ['Land'], sub: [] } } };
    expect(ptChip(land, memo)).toBeNull();
  });
});

describe('counter badge labels', () => {
  it('reads the wire’s counter names', async () => {
    const { counterLabel } = await import('../table/cardSprite');
    expect(counterLabel('+1/+1', 2)).toBe('+1/+1 ×2');
    expect(counterLabel('+1/+1', 1)).toBe('+1/+1');
    expect(counterLabel('-1/-1', 1)).toBe('−1/−1');
    expect(counterLabel('Loyalty', 4)).toBe('4');
    expect(counterLabel('Charge', 3)).toBe('3 Charge');
  });

  it('always shows the current P/T, neutral, for a `*` face (Eluge, Tarmogoyf), even if seen in hand', () => {
    const memo = new PrintedPtMemo();
    const eluge = (zone: string, p: number) => creature('e1', zone, p, p, {}, { name: 'Eluge, the Shoreless Sea', printedPtVaries: true });
    memo.observe(eluge('Hand', 3)); // in hand the characteristic-defining P/T already equals the current one
    expect(ptChip(eluge('Battlefield', 3), memo)).toEqual({ text: '3/3', tone: 'set' });
    expect(ptChip(eluge('Battlefield', 0), memo)).toEqual({ text: '0/0', tone: 'set' });
    expect(ptChip(eluge('Graveyard', 3), memo)).toBeNull();
    expect(ptChip({ ...eluge('Battlefield', 3), facedown: true }, memo)).toBeNull();
  });

  it('leaves numeric faces alone when the flag is absent or false', () => {
    const memo = new PrintedPtMemo();
    memo.observe(creature('c1', 'Hand', 2, 2));
    expect(ptChip(creature('c1', 'Battlefield', 2, 2, {}, { printedPtVaries: false }), memo)).toBeNull();
    expect(ptChip(creature('c1', 'Battlefield', 3, 3), memo)).toEqual({ text: '3/3', tone: 'up' });
  });
});
