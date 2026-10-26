/**
 * Card lanes for "put them back in any order" and scry: each lane is a list of ask item indices,
 * left to right = first to last (for a library: from the top down). Every item is in exactly one lane.
 * Pure functions; the overlay keeps the state.
 */
export type Lanes = number[][];

export function laneOf(l: Lanes, idx: number): number {
  return l.findIndex((lane) => lane.includes(idx));
}

/** Move an item into `lane`, before the item `before` (appended when `before` is null or not in that lane). */
export function moveTo(l: Lanes, idx: number, lane: number, before: number | null = null): Lanes {
  if (lane < 0 || lane >= l.length || idx === before) return l;
  const out = l.map((x) => x.filter((i) => i !== idx));
  const target = out[lane]!;
  const at = before === null ? -1 : target.indexOf(before);
  if (at < 0) target.push(idx);
  else target.splice(at, 0, idx);
  return out;
}

/** Swap an item with its neighbour in its lane (delta −1 = earlier, +1 = later). */
export function nudge(l: Lanes, idx: number, delta: -1 | 1): Lanes {
  const li = laneOf(l, idx);
  if (li < 0) return l;
  const lane = l[li]!;
  const at = lane.indexOf(idx);
  const to = at + delta;
  if (to < 0 || to >= lane.length) return l;
  const next = lane.slice();
  next[at] = lane[to]!;
  next[to] = idx;
  return l.map((x, i) => (i === li ? next : x));
}

/** With two lanes, send an item to the end of the other one. */
export function otherLane(l: Lanes, idx: number): Lanes {
  const li = laneOf(l, idx);
  if (li < 0 || l.length !== 2) return l;
  return moveTo(l, idx, 1 - li);
}

/**
 * Where a drop on an item lands: before it when the pointer is on its first half, else before the item after
 * it (null = the end of the lane).
 */
export function dropBefore(l: Lanes, target: number, secondHalf: boolean): number | null {
  if (!secondHalf) return target;
  const lane = l[laneOf(l, target)] ?? [];
  return lane[lane.indexOf(target) + 1] ?? null;
}

/** The order ask's starting lane: a complete preselection, else the items as dealt. */
export function initialOrder(items: number[], selected: number[] | undefined): number[] {
  if (selected && selected.length === items.length && items.every((i) => selected.includes(i))) return selected.slice();
  return items.slice();
}
