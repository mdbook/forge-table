import { describe, expect, it } from 'vitest';
import type { AskItem, ChooseAsk, GameModel } from '@forge-table/protocol';
import { isNameAsk, matchRank, searchNames, seenNames } from './nameCard';

const NAMES = ['Lightning Bolt', 'Lightning Greaves', 'Lightning Helix', 'Liliana of the Veil', 'Liliana, the Last Hope', "Lion's Eye Diamond", 'Opt', 'Chain Lightning'];
const pad = Array.from({ length: 20 }, (_, i) => `Zz Filler ${String(i).padStart(2, '0')}`);
const items: AskItem[] = [...NAMES, ...pad].sort().map((label, idx) => ({ idx, label, sub: 'Instant' }));
const ask: ChooseAsk = { t: 'ask', seq: 1, id: 'a1', kind: 'choose', items, min: 1, max: 1, message: 'Name a card' };

const model = {
  game: {},
  players: {},
  cards: {
    c1: { id: 'c1', zone: 'Battlefield', owner: 'p1', state: { face: 'Original', name: 'Liliana of the Veil' } },
    c2: { id: 'c2', zone: 'Graveyard', owner: 'p1', state: { face: 'Original', name: 'Lightning Bolt' } },
    c3: { id: 'c3', zone: 'Battlefield', owner: 'p1', state: { face: 'Original', name: 'Lightning Bolt' } },
    c4: { id: 'c4', zone: 'Battlefield', owner: 'p0', state: { face: 'Original', name: 'Opt' } },
    c5: { id: 'c5', zone: 'Library', owner: 'p1', state: { face: 'Original', name: 'Lightning Helix' } },
  },
} as unknown as GameModel;

describe('name a card (B4)', () => {
  it('is a single pick over many names with type lines', () => {
    expect(isNameAsk(ask)).toBe(true);
    expect(isNameAsk({ ...ask, max: 2 })).toBe(false);
    expect(isNameAsk({ ...ask, items: items.map(({ sub: _s, ...it }) => it) })).toBe(false);
    expect(isNameAsk({ ...ask, items: items.slice(0, 5) })).toBe(false);
  });

  it("lists the opponent's seen cards once each, best place first", () => {
    const seen = seenNames(items, model, 'p0');
    expect(seen.map((s) => [s.item.label, s.where])).toEqual([
      ['Lightning Bolt', 'on their battlefield'],
      ['Liliana of the Veil', 'on their battlefield'],
    ]);
  });

  it('ranks prefix, then word start, then inside; seen matches lead and are not repeated', () => {
    expect(matchRank('Lightning Bolt', 'li')).toBe(0);
    expect(matchRank('Chain Lightning', 'li')).toBe(1);
    expect(matchRank('Opt', 'li')).toBe(-1);
    const seen = seenNames(items, model, 'p0');
    const r = searchNames(items, seen, 'Li');
    expect(r.seen.map((s) => s.item.label)).toEqual(['Lightning Bolt', 'Liliana of the Veil']);
    expect(r.all.map((i) => i.label)).toEqual(['Lightning Greaves', 'Lightning Helix', 'Liliana, the Last Hope', "Lion's Eye Diamond", 'Chain Lightning']);
    expect(r.total).toBe(7);
    expect(searchNames(items, seen, 'helix').all.map((i) => i.label)).toEqual(['Lightning Helix']);
    expect(searchNames(items, seen, '', 5).all).toHaveLength(5);
  });
});
