/**
 * Number choices ("selecting a value for X: pay X mana, discard X cards, deal X damage"), as the bridge sends
 * them. Forge has no number widget of its own: every number arrives as a list, which the X picker (XPicker.tsx)
 * shows as a dial instead. The shapes (forge-gui AbstractGuiGame / PlayerControllerHuman, forge-gui-bridge
 * BridgeGuiGame.getChoices / TableSession.askText):
 *
 * - `getInteger(message, min, max)`: a `choose` ask, `min` 0 / `max` 1 (oneOrNone: [] cancels), one item per number
 *   labelled "0", "1", … (ascending, or descending when the engine sorts it so), at most 100 of them.
 * - `getInteger(message, min, max, cutoff)` (announce X with no upper bound, "how many counters"…): the numbers
 *   min..cutoff, then an "Other..." item; picking it raises a numeric `text` ask titled with the same message
 *   ("Enter a number between 0 and 15:" / "…greater than or equal to 0:"), reply the digits as a string, null cancels.
 * - `chooseNumber(sa, title, min, max)` (a mandatory cost, "Choose X for …"): `one` over the numbers: `min` 1 /
 *   `max` 1, no way out. `chooseNumber(sa, title, values)`: the same over a list that may skip numbers.
 *
 * No card, player or inline face rides on any of these items. The reply is exactly what the list would send.
 */
import type { AskMsg, CardId, GameModel, PlayerId } from '@forge-table/protocol';
import { tokenizeMana } from '../cards/mana';

export interface NumberSpec {
  /** The numbers the engine listed, ascending (empty for a bare numeric text ask). */
  values: number[];
  /** Number → the item idx that answers it (choose asks). */
  idx: Map<number, number>;
  /** The "Other..." item's idx: any number past the list, typed into the follow-up text ask. */
  other: number | null;
  lo: number;
  /** Infinity when there is no known upper bound. */
  hi: number;
  /** Where the dial starts: the engine's first listed number (its default), else the lower bound. */
  initial: number;
  /** Whether the ask may be declined (Esc / Cancel). */
  cancel: boolean;
}

const INT = /^-?\d+$/;

/** The dial for a number ask, or null when the ask is not a choice of a number. */
export function numberSpec(ask: AskMsg): NumberSpec | null {
  if (ask.kind === 'text') {
    if (!ask.numeric || (ask.options && ask.options.length > 0)) return null;
    const [lo, hi] = textBounds(ask.message ?? '');
    const init = ask.initial && INT.test(ask.initial.trim()) ? Number(ask.initial.trim()) : Math.max(lo, 0);
    return { values: [], idx: new Map(), other: null, lo, hi, initial: clamp(init, lo, hi), cancel: true };
  }
  if (ask.kind !== 'choose' || ask.max !== 1 || ask.reveal || ask.items.length < 2) return null;
  const idx = new Map<number, number>();
  let other: number | null = null;
  for (const [i, it] of ask.items.entries()) {
    if (it.card || it.player || it.cardData) return null;
    const label = it.label.trim();
    if (INT.test(label) && !idx.has(Number(label))) {
      idx.set(Number(label), it.idx);
    } else if (i === ask.items.length - 1 && idx.size > 0 && !INT.test(label)) {
      // Forge's lblOtherInteger ("Other...") ends a cut-off list; anything else is not a number list.
      other = it.idx;
    } else {
      return null;
    }
  }
  if (idx.size < 2 && !(idx.size === 1 && other !== null)) return null;
  const values = [...idx.keys()].sort((a, b) => a - b);
  const first = Number(ask.items[0]!.label.trim());
  return { values, idx, other, lo: values[0]!, hi: other !== null ? Infinity : values[values.length - 1]!, initial: first, cancel: ask.min === 0 };
}

/** Forge's "Enter a number between {0} and {1}:" family (MessageFormat groups thousands: "2,147,483,647"). */
export function textBounds(message: string): [number, number] {
  const n = (s: string) => Number(s.replace(/[,.\s  ]/g, ''));
  const NUM = '(-?\\d[\\d,.\\u00a0\\u202f]*)';
  const between = new RegExp(`between\\s+${NUM}\\s+and\\s+${NUM}`, 'i').exec(message);
  if (between) return [n(between[1]!), n(between[2]!)];
  const atLeast = new RegExp(`greater than or equal to\\s+${NUM}`, 'i').exec(message);
  if (atLeast) return [n(atLeast[1]!), Infinity];
  const atMost = new RegExp(`less than or equal to\\s+${NUM}`, 'i').exec(message);
  if (atMost) return [0, n(atMost[1]!)];
  return [0, Infinity];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Whether `v` is an answer the engine takes. */
export function allowed(s: NumberSpec, v: number): boolean {
  if (!Number.isInteger(v) || v < s.lo || v > s.hi) return false;
  if (s.values.length === 0) return true;
  return s.idx.has(v) || (s.other !== null && v > s.values[s.values.length - 1]!);
}

/** The nearest allowed number to `v` (a typed or dragged value). */
export function nearest(s: NumberSpec, v: number): number {
  const c = clamp(Math.round(v), s.lo, s.hi);
  if (allowed(s, c)) return c;
  let best = s.values[0]!;
  const w = clamp(v, s.lo, s.hi);
  for (const x of s.values) if (Math.abs(x - w) < Math.abs(best - w)) best = x;
  return best;
}

/** `d` steps from `v`: through the listed numbers, then on by one past an "Other..." list. */
export function step(s: NumberSpec, v: number, d: number): number {
  if (s.values.length === 0) return clamp(v + d, s.lo, s.hi);
  const last = s.values[s.values.length - 1]!;
  const i = s.values.indexOf(v);
  if (i >= 0) {
    const j = i + d;
    if (j < 0) return s.values[0]!;
    if (j < s.values.length) return s.values[j]!;
    return s.other !== null ? last + (j - s.values.length + 1) : last;
  }
  // Past the list (an "Other..." number): on by one, back into the list below it.
  const n = v + d;
  return n > last ? clamp(n, s.lo, s.hi) : nearest(s, n);
}

export interface PendingNumber {
  /** The text ask Forge raises after "Other..." is titled with the list's message. */
  title: string;
  value: number;
}

/**
 * The reply for `v`: the item's idx in a list, its digits in a text ask. A number past an "Other..." list is two
 * replies: Other here, then the digits to the text ask that follows (`then`, see takePendingNumber).
 */
export function numberReply(ask: AskMsg, s: NumberSpec, v: number): { value: unknown; then?: PendingNumber } {
  if (ask.kind === 'text') return { value: String(v) };
  const i = s.idx.get(v);
  if (i !== undefined) return { value: [i] };
  return { value: [s.other!], then: { title: ask.message ?? '', value: v } };
}

let pending: PendingNumber | null = null;

export function setPendingNumber(p: PendingNumber | null): void {
  pending = p;
}

/**
 * The digits to send for a text ask that follows an "Other..." pick, if it is that ask and the number fits (pure:
 * the caller clears it with setPendingNumber(null) once sent). Out of range, the ask shows as a dial instead.
 */
export function pendingAnswer(ask: AskMsg): string | null {
  if (!pending || ask.kind !== 'text' || !ask.numeric || ask.error || (ask.title ?? '') !== pending.title) return null;
  const [lo, hi] = textBounds(ask.message ?? '');
  return pending.value >= lo && pending.value <= hi ? String(pending.value) : null;
}

/**
 * What the number is for, from the engine's message: "Choose X for Fireball" (lblChooseAnnounceForCard) names the
 * card whose cost holds the X; "How many times do you want to pay {1}{R} for Card?" (lblHowManyTimesToPay) is a
 * repeated cost. `cost(v)` is the mana the choice comes to, when there is one to show.
 */
export interface NumberContext {
  card: CardId | null;
  /** The variable's name ("X"), when the message names one. */
  name: string | null;
  cost: ((v: number) => string) | null;
}

export function numberContext(message: string | undefined, model: GameModel, viewer: PlayerId): NumberContext {
  const text = (message ?? '').trim();
  const times = /^How many times do you want to pay (.+?) for (.+?)\?$/s.exec(text);
  if (times) {
    const per = times[1]!;
    return { card: findCard(model, viewer, times[2]!), name: null, cost: tokenizeMana(per).length > 0 ? (v) => timesCost(per, v) : null };
  }
  const choose = /^Choose (.+?) for (.+)$/s.exec(text);
  if (!choose) return { card: null, name: null, cost: null };
  const name = choose[1]!;
  const card = findCard(model, viewer, choose[2]!);
  const manaCost = card ? model.cards[card]?.state?.manaCost : undefined;
  const hasX = name === 'X' && !!manaCost && tokenizeMana(manaCost).some((t) => t.raw.toUpperCase() === 'X');
  return { card, name, cost: hasX ? (v) => costWithX(manaCost!, v) : null };
}

/** The card a message names: the one on the stack (being cast), else in my hand, else anywhere. */
function findCard(model: GameModel, viewer: PlayerId, name: string): CardId | null {
  const all = Object.values(model.cards).filter((c) => c.state?.name === name);
  const pick = all.find((c) => c.zone === 'Stack') ?? all.find((c) => c.zone === 'Hand' && c.owner === viewer) ?? all[0];
  return pick?.id ?? null;
}

/** `{X}{X}{G}` with X = 2 → `{4}{G}`: every X becomes generic mana, added to the generic part. */
export function costWithX(cost: string, x: number): string {
  let generic = 0;
  const rest: string[] = [];
  for (const t of tokenizeMana(cost)) {
    if (t.raw.toUpperCase() === 'X') generic += x;
    else if (/^\d+$/.test(t.raw)) generic += Number(t.raw);
    else rest.push(`{${t.raw}}`);
  }
  return (generic > 0 || rest.length === 0 ? `{${generic}}` : '') + rest.join('');
}

/** `{1}{R}` paid 3 times → `{3}{R}{R}{R}`. */
export function timesCost(cost: string, n: number): string {
  let generic = 0;
  const rest: string[] = [];
  for (const t of tokenizeMana(cost)) {
    if (/^\d+$/.test(t.raw)) generic += Number(t.raw) * n;
    else for (let i = 0; i < n; i++) rest.push(`{${t.raw}}`);
  }
  return (generic > 0 || rest.length === 0 ? `{${generic}}` : '') + rest.join('');
}
