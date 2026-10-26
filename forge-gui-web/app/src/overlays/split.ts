/**
 * Combat damage assignment and amount split rules, mirroring the sidecar's `combatError` / `splitError` (which have the last
 * word): amounts per item, adding up to the ask's `amount`. Pure functions; the overlay keeps the state.
 */
import type { SplitAsk } from '@forge-table/protocol';

type Rules = Pick<SplitAsk, 'amount' | 'rule' | 'lethal' | 'min' | 'max' | 'defender'>;

const lo = (r: Rules, i: number) => r.min?.[i] ?? 0;
const hi = (r: Rules, i: number) => r.max?.[i] ?? r.amount;
const lethalOf = (r: Rules, i: number) => r.lethal?.[i] ?? 0;

export function left(r: Rules, a: number[]): number {
  return r.amount - a.reduce((s, x) => s + x, 0);
}

/** Whether item `i` may be assigned anything yet: the earlier items it waits on all have lethal. */
export function open(r: Rules, a: number[], i: number): boolean {
  const last = !!r.defender && i === a.length - 1;
  const upTo = r.rule === 'inOrder' || (r.rule === 'lethalFirst' && last) ? i : 0;
  for (let j = 0; j < upTo; j++) if (a[j]! < lethalOf(r, j)) return false;
  return true;
}

/** Drop what items no longer open hold (Swing's checkDamageQueue), keeping each minimum. */
function settle(r: Rules, a: number[]): number[] {
  const out = a.slice();
  for (let i = 0; i < out.length; i++) if (!open(r, out, i)) out[i] = lo(r, i);
  return out;
}

/** Add `n` (negative removes) to item `i`, within its bounds, what's left and the rule. */
export function add(r: Rules, a: number[], i: number, n: number): number[] {
  if (n > 0 && !open(r, a, i)) return a;
  const v = Math.max(lo(r, i), Math.min(hi(r, i), a[i]! + Math.min(n, left(r, a))));
  if (v === a[i]) return a;
  const out = a.slice();
  out[i] = v;
  return settle(r, out);
}

/** Shift-click: up to lethal (combat) or the item's maximum; again, everything that's left. */
export function fill(r: Rules, a: number[], i: number): number[] {
  const target = r.lethal ? lethalOf(r, i) : hi(r, i);
  return add(r, a, i, a[i]! < target ? target - a[i]! : left(r, a));
}

export function valid(r: Rules, a: number[]): boolean {
  if (left(r, a) !== 0) return false;
  return a.every((x, i) => x >= lo(r, i) && x <= hi(r, i) && (x === 0 || open(r, a, i)));
}

/** Auto: combat = lethal to each in order, the rest to the last item; otherwise each minimum, then fill in order. */
export function auto(r: Rules, n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => (r.lethal ? 0 : lo(r, i)));
  let rest = left(r, a);
  for (let i = 0; i < n && rest > 0; i++) {
    const give = Math.min(rest, r.lethal ? lethalOf(r, i) : hi(r, i) - a[i]!);
    a[i]! += give;
    rest -= give;
  }
  if (rest > 0 && r.lethal && n > 0) a[n - 1]! += rest;
  return a;
}

/** Where a fresh overlay starts: combat at Auto (adjust from there), a split at each minimum. */
export function initial(r: Rules, n: number): number[] {
  return r.lethal ? auto(r, n) : Array.from({ length: n }, (_, i) => lo(r, i));
}
