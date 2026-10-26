/**
 * "Name a card" (Pithing Needle, Meddling Mage…). Forge asks it as a pick from every card name; the bridge
 * adds each name's type line (`sub`). The layout searches the names, lists the opponent's cards seen this game first
 * (the usual answer), then every match.
 */
import type { AskItem, CardId, ChooseAsk, GameModel, PlayerId, ZoneName } from '@forge-table/protocol';

/** Fewer names than this read fine as a plain option list. */
const MIN_NAMES = 20;

/** A pick from card names with type lines, one name to choose. */
export function isNameAsk(ask: ChooseAsk): boolean {
  if (ask.kind !== 'choose' || ask.max !== 1 || ask.items.length < MIN_NAMES) return false;
  const first = ask.items[0]!;
  return typeof first.sub === 'string' && !first.card && !first.cardData;
}

/** Where a seen card is, best first ("on their battlefield" beats "in their graveyard"). */
const WHERE: [ZoneName, string][] = [
  ['Battlefield', 'on their battlefield'],
  ['Stack', 'on the stack'],
  ['Hand', 'revealed from their hand'],
  ['Graveyard', 'in their graveyard'],
  ['Exile', 'in exile'],
  ['Command', 'in their command zone'],
];

export interface SeenName {
  item: AskItem;
  where: string;
}

/** The opponent's cards this viewer has seen face up, as items of the ask, best place first, each name once. */
export function seenNames(items: AskItem[], model: GameModel | undefined, viewer: PlayerId | null | undefined): SeenName[] {
  if (!model) return [];
  const byName = new Map(items.map((it) => [it.label, it]));
  const best = new Map<string, number>();
  for (const id of Object.keys(model.cards) as CardId[]) {
    const c = model.cards[id]!;
    const name = c.state?.name;
    const who = c.owner ?? c.controller;
    if (!name || c.facedown || c.token || !who || who === viewer || !c.zone) continue;
    const rank = WHERE.findIndex(([z]) => z === c.zone);
    if (rank < 0 || !byName.has(name)) continue;
    if (!best.has(name) || rank < best.get(name)!) best.set(name, rank);
  }
  return [...best.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([name, rank]) => ({ item: byName.get(name)!, where: WHERE[rank]![1] }));
}

/** How well a name matches: 0 starts with the query, 1 a word does, 2 it's inside; -1 no match. */
export function matchRank(name: string, q: string): number {
  if (!q) return 0;
  const n = name.toLowerCase();
  const i = n.indexOf(q);
  if (i < 0) return -1;
  if (i === 0) return 0;
  return /[\s,'-]/.test(n[i - 1]!) || n.includes(` ${q}`) ? 1 : 2;
}

/** Where the query sits in a name, for the highlight: [start, end), or null. */
export function matchSpan(name: string, q: string): [number, number] | null {
  if (!q) return null;
  const i = name.toLowerCase().indexOf(q);
  return i < 0 ? null : [i, i + q.length];
}

export interface NameResults {
  seen: SeenName[];
  /** The other matches, best first (alphabetical within a rank), at most `limit`. */
  all: AskItem[];
  /** Every match, seen ones included. */
  total: number;
}

export function searchNames(items: AskItem[], seen: SeenName[], query: string, limit = 60): NameResults {
  const q = query.trim().toLowerCase();
  const seenHit = seen.filter((s) => matchRank(s.item.label, q) >= 0);
  const skip = new Set(seenHit.map((s) => s.item.idx));
  const ranked: [AskItem, number][] = [];
  for (const it of items) {
    if (skip.has(it.idx)) continue;
    const r = matchRank(it.label, q);
    if (r >= 0) ranked.push([it, r]);
  }
  // Stable: items arrive alphabetical, so ties keep that order.
  ranked.sort((a, b) => a[1] - b[1]);
  return { seen: seenHit, all: ranked.slice(0, limit).map(([it]) => it), total: seenHit.length + ranked.length };
}
