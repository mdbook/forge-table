/**
 * The search, type chips and sort over a grid of cards, shared by the big card choice (CardCarousel)
 * and the graveyard / exile viewer (ZoneViewer). Pure functions, no React; the toolbar is CardGridBar.tsx.
 *
 * A card with several types counts under each (an artifact creature is in Artifacts and Creatures), as Arena's filters
 * do. A card with no face the viewer may see (face down) has no type and matches no search: it shows under All only.
 */
import type { CardFace } from '@forge-table/protocol';
import { manaValue } from '../cards/mana';

export interface GridEntry<K> {
  key: K;
  face?: CardFace | undefined;
}

/** The types a chip can filter on, in the order ties between equal counts list them. */
const TYPES = ['Creature', 'Land', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Planeswalker', 'Battle'] as const;
const PLURAL: Record<string, string> = {
  Creature: 'Creatures',
  Land: 'Lands',
  Instant: 'Instants',
  Sorcery: 'Sorceries',
  Artifact: 'Artifacts',
  Enchantment: 'Enchantments',
  Planeswalker: 'Planeswalkers',
  Battle: 'Battles',
};
/** Delirium counts card types, Kindred (Tribal) included. */
const CARD_TYPES = new Set<string>([...TYPES, 'Kindred', 'Tribal']);

export interface TypeChip {
  type: string;
  label: string;
  n: number;
}

/** One chip per type present, most cards first. */
export function typeChips(faces: readonly (CardFace | undefined)[]): TypeChip[] {
  const n = new Map<string, number>();
  for (const f of faces) for (const t of f?.type?.core ?? []) if (PLURAL[t]) n.set(t, (n.get(t) ?? 0) + 1);
  return TYPES.filter((t) => n.has(t))
    .map((t) => ({ type: t, label: PLURAL[t]!, n: n.get(t)! }))
    .sort((a, b) => b.n - a.n);
}

/** How many card types the cards share between them (delirium wants four in the graveyard). */
export function cardTypeCount(faces: readonly (CardFace | undefined)[]): number {
  const seen = new Set<string>();
  for (const f of faces) for (const t of f?.type?.core ?? []) if (CARD_TYPES.has(t)) seen.add(t === 'Tribal' ? 'Kindred' : t);
  return seen.size;
}

/** Name, rules text or type line contains the query (any case); an empty query matches everything. */
export function matches(face: CardFace | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (!face) return false;
  const t = face.type;
  const hay = [face.name, face.oracleText, face.rulesText, t && [...t.super, ...t.core, ...t.sub].join(' ')];
  return hay.some((s) => !!s && s.toLowerCase().includes(q));
}

export type GridSort = 'given' | 'mv' | 'name' | 'type';
export const SORTS: readonly GridSort[] = ['given', 'mv', 'name', 'type'];

export function sortLabel(by: GridSort, given: string): string {
  return by === 'mv' ? 'Mana value' : by === 'name' ? 'Name' : by === 'type' ? 'Type' : given;
}

/** The sort after `by` (the button cycles). */
export function nextSort(by: GridSort): GridSort {
  return SORTS[(SORTS.indexOf(by) + 1) % SORTS.length]!;
}

function typeRank(f: CardFace | undefined): number {
  const core = f?.type?.core ?? [];
  const i = TYPES.findIndex((t) => core.includes(t));
  return i < 0 ? TYPES.length : i;
}

/** Stable: equal cards (and every faceless one, which sorts last) keep their given order. */
export function sortEntries<K>(list: readonly GridEntry<K>[], by: GridSort): GridEntry<K>[] {
  const out = list.map((e, i) => ({ e, i }));
  const cmp = (a: GridEntry<K>, b: GridEntry<K>): number => {
    if (!a.face || !b.face) return (a.face ? 0 : 1) - (b.face ? 0 : 1);
    if (by === 'mv') return manaValue(a.face.manaCost) - manaValue(b.face.manaCost);
    if (by === 'name') return (a.face.name ?? '').localeCompare(b.face.name ?? '');
    return typeRank(a.face) - typeRank(b.face);
  };
  if (by !== 'given') out.sort((a, b) => cmp(a.e, b.e) || a.i - b.i);
  return out.map((x) => x.e);
}

export interface GridView {
  query: string;
  /** A type from typeChips, or null for All. */
  type: string | null;
  sort: GridSort;
}

export const ALL: GridView = { query: '', type: null, sort: 'given' };

/** The entries the view shows, in its order. */
export function viewEntries<K>(list: readonly GridEntry<K>[], v: GridView): GridEntry<K>[] {
  const kept = list.filter((e) => matches(e.face, v.query) && (!v.type || !!e.face?.type?.core.includes(v.type)));
  return sortEntries(kept, v.sort);
}
