/**
 * The deck peek's sums, from the server's card list: type groups sorted by mana value, the curve, the colour split
 * and the deck's colours from its costs. Cards the server couldn't read (no type) land in Other with no cost.
 */
import { tokenizeMana, type ManaColor, type ManaSymbol } from '../cards/mana';
import type { CardType, DeckCard } from './api';

/** The order the groups show in: spells by type, Other, then the lands. */
const ORDER: CardType[] = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Other', 'Land'];
const PLURAL: Record<CardType, string> = {
  Creature: 'Creatures',
  Planeswalker: 'Planeswalkers',
  Battle: 'Battles',
  Instant: 'Instants',
  Sorcery: 'Sorceries',
  Artifact: 'Artifacts',
  Enchantment: 'Enchantments',
  Land: 'Lands',
  Other: 'Other',
};
const WUBRG: ManaColor[] = ['W', 'U', 'B', 'R', 'G'];
/** Basic lands, which sort after the other lands. */
const BASIC = /^(Snow-Covered )?(Plains|Island|Swamp|Mountain|Forest|Wastes)$/;

export interface CardGroup {
  type: CardType;
  label: string;
  /** Copies in the group. */
  count: number;
  cards: DeckCard[];
}

const copies = (cards: DeckCard[]) => cards.reduce((t, c) => t + c.n, 0);

/**
 * A section's cards by type (in {@link ORDER}), each group by mana value then name; lands with the basics last. A
 * list with no types at all (an older server) is one group, most-played first, as it was.
 */
export function groupCards(cards: DeckCard[]): CardGroup[] {
  if (!cards.some((c) => c.type)) {
    const sorted = [...cards].sort((a, b) => Number(BASIC.test(a.name)) - Number(BASIC.test(b.name)) || b.n - a.n);
    return sorted.length ? [{ type: 'Other', label: '', count: copies(sorted), cards: sorted }] : [];
  }
  const by = new Map<CardType, DeckCard[]>();
  for (const c of cards) {
    const t = c.type ?? 'Other';
    by.set(t, [...(by.get(t) ?? []), c]);
  }
  return ORDER.filter((t) => by.has(t)).map((t) => {
    const list = [...by.get(t)!].sort(
      (a, b) => Number(BASIC.test(a.name)) - Number(BASIC.test(b.name)) || (a.cmc ?? 99) - (b.cmc ?? 99) || a.name.localeCompare(b.name),
    );
    return { type: t, label: PLURAL[t], count: copies(list), cards: list };
  });
}

/** The mana curve: copies of non-land cards (with a known mana value) at 0…6 and 7+. */
export function manaCurve(cards: DeckCard[]): number[] {
  const out = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const c of cards) {
    if (c.type && c.type !== 'Land' && c.cmc !== undefined) out[Math.min(7, Math.floor(c.cmc))]! += c.n;
  }
  return out;
}

/** Coloured pips across the costs (hybrid and Phyrexian count for each colour), per copy, WUBRG. */
export function colorSplit(cards: DeckCard[]): Record<ManaColor, number> {
  const out: Record<ManaColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const c of cards) {
    for (const { sym } of tokenizeMana(c.cost)) {
      for (const k of pipColors(sym)) if (k !== 'C') out[k] += c.n;
    }
  }
  return out;
}

function pipColors(sym: ManaSymbol): readonly (ManaColor | 'C')[] {
  switch (sym.kind) {
    case 'color':
    case 'monoHybrid':
      return [sym.color];
    case 'hybrid':
    case 'phyrexian':
      return sym.colors;
    case 'half':
      return sym.color ? [sym.color] : [];
    default:
      return [];
  }
}

/** The deck's colours from its costs, WUBRG; empty when no cost names one. */
export function costColors(cards: DeckCard[]): string {
  const s = colorSplit(cards);
  return WUBRG.filter((k) => s[k] > 0).join('');
}

export interface DeckSums {
  cards: number;
  lands: number;
  /** Mean mana value of the non-land cards with one, to one decimal; undefined when there are none. */
  avg?: number;
}

/** Card count, lands and average mana value of a section. */
export function deckSums(cards: DeckCard[]): DeckSums {
  const lands = copies(cards.filter((c) => c.type === 'Land' || (!c.type && BASIC.test(c.name))));
  const spells = cards.filter((c) => c.type && c.type !== 'Land' && c.cmc !== undefined);
  const n = copies(spells);
  const out: DeckSums = { cards: copies(cards), lands };
  if (n > 0) out.avg = Math.round((spells.reduce((t, c) => t + c.cmc! * c.n, 0) / n) * 10) / 10;
  return out;
}
