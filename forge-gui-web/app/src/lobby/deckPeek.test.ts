import { describe, expect, it } from 'vitest';
import { deckCards, LobbyApi, type DeckCard } from './api';
import { colorSplit, costColors, deckSums, groupCards, manaCurve } from './deckPeek';

const tron: DeckCard[] = [
  { n: 4, name: "Urza's Mine", type: 'Land', cmc: 0, cost: '' },
  { n: 2, name: 'Forest', type: 'Land', cmc: 0, cost: '' },
  { n: 4, name: 'Myr Retriever', type: 'Creature', cmc: 2, cost: '{2}' },
  { n: 1, name: 'Ulamog, the Ceaseless Hunger', type: 'Creature', cmc: 10, cost: '{10}' },
  { n: 2, name: 'Myr Kinsmith', type: 'Creature', cmc: 2, cost: '{1}{W/U}' },
  { n: 4, name: "Eviscerator's Insight", type: 'Instant', cmc: 1, cost: '{B}' },
  { n: 1, name: 'Fire // Ice', type: 'Instant', cmc: 4, cost: '{1}{R} // {1}{U}' },
  { n: 3, name: 'Golem Foundry', type: 'Artifact', cmc: 3, cost: '{3}' },
  { n: 1, name: 'Mystery Card' },
];

describe('the deck peek', () => {
  it('groups by type in play order, each by mana value then name, basics last among the lands, unknown cards in Other', () => {
    const g = groupCards(tron);
    expect(g.map((x) => `${x.label} ${x.count}`)).toEqual(['Creatures 7', 'Instants 5', 'Artifacts 3', 'Other 1', 'Lands 6']);
    expect(g[0]!.cards.map((c) => c.name)).toEqual(['Myr Kinsmith', 'Myr Retriever', 'Ulamog, the Ceaseless Hunger']);
    expect(g[4]!.cards.map((c) => c.name)).toEqual(["Urza's Mine", 'Forest']);
  });

  it('an older server (no types) is one list, most-played first, basics last', () => {
    const g = groupCards([{ n: 20, name: 'Mountain' }, { n: 2, name: 'Eidolon' }, { n: 4, name: 'Bolt' }]);
    expect(g).toHaveLength(1);
    expect(g[0]!.cards.map((c) => c.name)).toEqual(['Bolt', 'Eidolon', 'Mountain']);
    expect(groupCards([])).toEqual([]);
  });

  it('counts the curve (non-land, 7+ together), the coloured pips, the colours and the sums', () => {
    expect(manaCurve(tron)).toEqual([0, 4, 6, 3, 1, 0, 0, 1]);
    expect(colorSplit(tron)).toEqual({ W: 2, U: 3, B: 4, R: 1, G: 0 });
    expect(costColors(tron)).toBe('WUBR');
    expect(costColors([{ n: 1, name: 'Wastes', type: 'Land', cmc: 0, cost: '' }])).toBe('');
    expect(deckSums(tron)).toEqual({ cards: 22, lands: 6, avg: 2.6 });
    expect(deckSums([{ n: 20, name: 'Mountain' }])).toEqual({ cards: 20, lands: 20 });
  });

  it('keeps the server’s type, mana value and cost only when well-formed', () => {
    const raw = { sections: [{ name: 'Main', cards: [{ n: 1, name: 'A', type: 'Creature', cmc: 3, cost: '{2}{G}' }, { n: 1, name: 'B', type: 'Wizard', cmc: -1, cost: 7 }] }] };
    expect(deckCards(raw).sections[0]!.cards).toEqual([{ n: 1, name: 'A', type: 'Creature', cmc: 3, cost: '{2}{G}' }, { n: 1, name: 'B' }]);
  });

  it('asks the router for a card’s full scan, with the local token', () => {
    expect(new LobbyApi('tok', fetch).cardUrl('Fire // Ice')).toBe('/api/art/card/Fire%20%2F%2F%20Ice?t=tok');
    expect(new LobbyApi(null, fetch).cardUrl('Bolt')).toBe('/api/art/card/Bolt');
  });
});
