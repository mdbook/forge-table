/**
 * Real card art shows the *printed* power/toughness. When a permanent's current P/T differs, the table puts
 * a chip with the current P/T over the card's printed P/T box (cardSprite). The chip always shows
 * the current values, never a difference (a 1/3 under a -5/-0 aura reads -4/3).
 *
 * A face's `power`/`toughness` are the current (net) values. The printed P/T comes from, in order:
 * 1. `face.printedPower` / `face.printedToughness`: the bridge sends them from the card rules (not for `*`
 *    or for faces without rules, e.g. most tokens). A face with `printedPtVaries` (`*`, `1+*`…) skips 2 and 3:
 *    its chip always shows the current P/T, in the neutral `set` tone;
 * 2. the P/T the same face showed while it was off the battlefield (hand, stack, graveyard…), where
 *    continuous effects rarely apply (`PrintedPtMemo.observe` records it);
 * 3. the current P/T minus its +1/+1 and −1/−1 counters.
 * Otherwise it is unknown and no chip is shown.
 */
import type { Card, CardFace } from '@forge-table/protocol';

export interface PT {
  power: number;
  toughness: number;
}

/** `set`: the printed P/T is a rule (`*`), so there is no up or down to judge; the chip is neutral. */
export type PtTone = 'up' | 'down' | 'mixed' | 'set';

export interface PtChip {
  text: string;
  tone: PtTone;
}

/**
 * Net +1/+1 minus −1/−1 counters. The wire keys counters by Forge's CounterType name ("+1/+1", "-1/-1");
 * the enum-style keys ("P1P1", "M1M1") are accepted too.
 */
export function netPtCounters(counters: Record<string, number> | undefined): number {
  const c = counters ?? {};
  return (c['+1/+1'] ?? c.P1P1 ?? 0) - (c['-1/-1'] ?? c.M1M1 ?? 0);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function currentPt(face: CardFace | undefined): PT | null {
  const p = num(face?.power);
  const t = num(face?.toughness);
  const creature = !!face?.type?.core?.includes('Creature');
  if (p === null && t === null && !creature) return null;
  return { power: p ?? 0, toughness: t ?? 0 };
}

export class PrintedPtMemo {
  private readonly byName = new Map<string, PT>();

  /** Remember the P/T a face shows off the battlefield. */
  observe(card: Card | undefined): void {
    const face = card?.state;
    if (!card || !face?.name || card.zone === 'Battlefield' || card.facedown) return;
    const pt = currentPt(face);
    if (pt) this.byName.set(face.name, pt);
  }

  /** The printed P/T of a card's face, or null when it cannot be told. */
  printed(card: Card | undefined): PT | null {
    const face = card?.state;
    if (!face) return null;
    const pp = num(face.printedPower);
    const pt = num(face.printedToughness);
    if (pp !== null && pt !== null) return { power: pp, toughness: pt };
    const seen = face.name ? this.byName.get(face.name) : undefined;
    if (seen) return seen;
    const cur = currentPt(face);
    const net = netPtCounters(card?.counters);
    if (cur && net !== 0) return { power: cur.power - net, toughness: cur.toughness - net };
    return null;
  }

  clear(): void {
    this.byName.clear();
  }
}

/** The chip for a battlefield card whose current P/T differs from its printed P/T, else null. */
export function ptChip(card: Card | undefined, memo: PrintedPtMemo): PtChip | null {
  if (!card || card.zone !== 'Battlefield' || card.facedown) return null;
  const cur = currentPt(card.state);
  if (!cur) return null;
  // `*`, `1+*`…: the scan shows no number, so the current P/T is always news; the memo would only echo it back.
  if (card.state?.printedPtVaries) return { text: `${cur.power}/${cur.toughness}`, tone: 'set' };
  const printed = memo.printed(card);
  if (!printed || (printed.power === cur.power && printed.toughness === cur.toughness)) return null;
  const dp = cur.power - printed.power;
  const dt = cur.toughness - printed.toughness;
  const tone: PtTone = dp >= 0 && dt >= 0 ? 'up' : dp <= 0 && dt <= 0 ? 'down' : 'mixed';
  return { text: `${cur.power}/${cur.toughness}`, tone };
}

/** The page's memo, fed by the table as cards pass through visible zones. */
export const printedPt = new PrintedPtMemo();
