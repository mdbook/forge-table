import { describe, expect, it } from 'vitest';
import type { CardFace } from '@forge-table/protocol';
import { cardTypeCount, matches, nextSort, sortEntries, typeChips, viewEntries, ALL, type GridEntry } from './cardGrid';

const face = (name: string, core: string[], manaCost?: string, oracleText?: string, sub: string[] = []): CardFace => ({
  face: 'Original',
  name,
  type: { super: [], core, sub },
  ...(manaCost ? { manaCost } : {}),
  ...(oracleText ? { oracleText } : {}),
});

const bolt = face('Lightning Bolt', ['Instant'], '{R}', 'Lightning Bolt deals 3 damage to any target.');
const guide = face('Goblin Guide', ['Creature'], '{R}', 'Haste', ['Goblin', 'Scout']);
const mountain = face('Mountain', ['Land'], undefined, undefined, ['Mountain']);
const arbor = face('Dryad Arbor', ['Land', 'Creature'], undefined, undefined, ['Forest', 'Dryad']);
const looting = face('Faithless Looting', ['Sorcery'], '{R}', 'Draw two cards, then discard two cards. Flashback {2}{R}');
const helix = face('Lightning Helix', ['Instant'], '{R}{W}');

const list: GridEntry<string>[] = [
  { key: 'bolt', face: bolt },
  { key: 'back' },
  { key: 'guide', face: guide },
  { key: 'mountain', face: mountain },
  { key: 'arbor', face: arbor },
  { key: 'looting', face: looting },
  { key: 'helix', face: helix },
];
const keys = (l: GridEntry<string>[]) => l.map((e) => e.key);

describe('cardGrid', () => {
  it('counts each type a card has, most first, ties in type order', () => {
    expect(typeChips(list.map((e) => e.face))).toEqual([
      { type: 'Creature', label: 'Creatures', n: 2 },
      { type: 'Land', label: 'Lands', n: 2 },
      { type: 'Instant', label: 'Instants', n: 2 },
      { type: 'Sorcery', label: 'Sorceries', n: 1 },
    ]);
  });

  it('counts card types for delirium, Tribal as Kindred', () => {
    expect(cardTypeCount(list.map((e) => e.face))).toBe(4);
    expect(cardTypeCount([face('a', ['Tribal', 'Instant']), face('b', ['Kindred', 'Sorcery'])])).toBe(3);
    expect(cardTypeCount([undefined])).toBe(0);
  });

  it('searches name, rules text and type line; a face-down card matches only the empty search', () => {
    expect(matches(bolt, '  ')).toBe(true);
    expect(matches(undefined, '')).toBe(true);
    expect(matches(undefined, 'bolt')).toBe(false);
    expect(matches(looting, 'FLASHBACK')).toBe(true);
    expect(matches(guide, 'scout')).toBe(true);
    expect(matches(mountain, 'forest')).toBe(false);
  });

  it('sorts stably, faceless cards last', () => {
    expect(keys(sortEntries(list, 'given'))).toEqual(keys(list));
    expect(keys(sortEntries(list, 'mv'))).toEqual(['mountain', 'arbor', 'bolt', 'guide', 'looting', 'helix', 'back']);
    expect(keys(sortEntries(list, 'name'))).toEqual(['arbor', 'looting', 'guide', 'bolt', 'helix', 'mountain', 'back']);
    expect(keys(sortEntries(list, 'type'))).toEqual(['guide', 'arbor', 'mountain', 'bolt', 'helix', 'looting', 'back']);
  });

  it('cycles the sorts', () => {
    expect([nextSort('given'), nextSort('mv'), nextSort('name'), nextSort('type')]).toEqual(['mv', 'name', 'type', 'given']);
  });

  it('filters by search and type, then sorts', () => {
    expect(keys(viewEntries(list, ALL))).toEqual(keys(list));
    expect(keys(viewEntries(list, { query: 'lightning', type: null, sort: 'mv' }))).toEqual(['bolt', 'helix']);
    expect(keys(viewEntries(list, { query: '', type: 'Creature', sort: 'name' }))).toEqual(['arbor', 'guide']);
    expect(keys(viewEntries(list, { query: 'haste', type: 'Land', sort: 'given' }))).toEqual([]);
  });
});
