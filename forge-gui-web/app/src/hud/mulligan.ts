/**
 * What the mulligan banner and buttons say, from the engine's prompt and the hand at the playhead.
 * Forge's London mulligan draws 7 every time and tucks one card per mulligan on Keep (Brawl's first one is free),
 * so "Keep 6" and "Mulligan to 5" are worked out here; the engine's own words only say who goes first.
 */
import type { Card, PromptBody } from '@forge-table/protocol';
import { manaValue } from '../cards/mana';

export interface HandFacts {
  lands: number;
  spells: number;
  /** The highest mana value among the spells (null with no spells). */
  top: number | null;
}

/** Counted by the director from the viewer's mulligan prompts (a new pid = one more mulligan). */
export interface MullCount {
  count: number;
  seat: 'play' | 'draw' | null;
}

export interface MullInfo {
  /** keep / tuck: the mulligan; start: cards that may begin the game on the battlefield (Leyline, Gemstone Caverns). */
  kind: 'keep' | 'tuck' | 'start';
  /** Who goes first, from the engine's message: on the play, on the draw, or not said. */
  seat: 'play' | 'draw' | null;
  title: string;
  sub: string;
  /** Cards kept on Keep (keep), or once the tuck is done (tuck). */
  keep: number;
  /** Keep: the hand size after one more mulligan. */
  next: number;
  /** Tuck: cards to put on the bottom, and how many are chosen. */
  tuck: { n: number; chosen: number } | null;
}

/** Lands, spells and the top mana value of a hand. */
export function handFacts(hand: (Card | undefined)[]): HandFacts {
  let lands = 0;
  let spells = 0;
  let top: number | null = null;
  for (const c of hand) {
    const s = c?.state;
    if (!s) continue;
    if (s.type?.core.includes('Land')) lands++;
    else {
      spells++;
      top = Math.max(top ?? 0, manaValue(s.manaCost));
    }
  }
  return { lands, spells, top };
}

/** "you are going first!" / "you are going 2nd." in Forge's mulligan message. */
export function seatOf(message: string): 'play' | 'draw' | null {
  if (/you are going first/i.test(message)) return 'play';
  if (/you are going \d/i.test(message)) return 'draw';
  return null;
}

/** Forge's London tuck message: "Return 2 card(s) to the bottom of your library" (what's still to choose). */
function tuckLeft(message: string): number | null {
  const m = /Return (\d+) card/i.exec(message);
  return m ? Number(m[1]) : null;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * The banner for a mulligan prompt: null for any other prompt. `mull` is what the director saw this game: how many
 * mulligans the viewer took and who goes first (the tuck's own message doesn't say); `free` how many cost no card
 * (Brawl: 1).
 */
export function mullInfo(
  prompt: Pick<PromptBody, 'kind' | 'message' | 'highlighted'> | null,
  handSize: number,
  mull: MullCount,
  free: number,
): MullInfo | null {
  if (!prompt) return null;
  const seat = seatOf(prompt.message) ?? mull.seat;
  const mulligans = mull.count;
  const cost = (n: number) => Math.max(0, n - free);
  if (prompt.kind === 'mulligan') {
    const keep = Math.max(0, handSize - cost(mulligans));
    const next = Math.max(0, handSize - cost(mulligans + 1));
    const sub = mulligans === 0 ? 'Opening hand · no mulligans yet' : `${plural(mulligans, 'mulligan')} taken · you'd keep ${keep}`;
    return { kind: 'keep', seat, title: 'Keep this hand?', sub, keep, next, tuck: null };
  }
  if (prompt.kind === 'mulliganTuck') {
    const chosen = prompt.highlighted.length;
    const left = tuckLeft(prompt.message);
    const n = left !== null ? left + chosen : cost(mulligans);
    const keep = Math.max(0, handSize - n);
    const taken = Math.max(mulligans, n);
    return {
      kind: 'tuck',
      seat,
      title: `Put ${plural(n, 'card')} on the bottom`,
      sub: `${taken === 1 ? 'Mulligan 1' : `${taken} mulligans`} · you'll keep ${keep}`,
      keep,
      next: keep,
      tuck: { n, chosen },
    };
  }
  if (prompt.kind === 'startingHand') {
    const n = prompt.highlighted.length;
    const said = prompt.message.trim().split('\n')[0] ?? '';
    return {
      kind: 'start',
      seat,
      title: 'Start with any of these on the battlefield?',
      sub: said.length > 0 && said.length <= 120 ? said : 'Tap a card to put it in play, or begin without',
      keep: n,
      next: n,
      tuck: null,
    };
  }
  return null;
}
