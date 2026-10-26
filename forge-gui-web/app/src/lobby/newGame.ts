/**
 * New game: everything picked in the lobby before the game boots (format, my deck, the AI and its deck),
 * then handed to the game page, which starts the match with those picks as soon as it is up. No React here.
 */
import type { MatchStartParams } from '@forge-table/protocol';
import { RANDOM_DECK, resolveDeck } from '../hud/start';
import type { DeckDetail, LobbyFormat, NewMatch } from './api';

export { RANDOM_DECK };

// ------------------------------------------------------------------------------------------ opponents

export interface Opponent {
  /** The AI profile's wire name (`match.start` `ai`). */
  ai: string;
  name: string;
  blurb: string;
  style: string;
}

/**
 * The AI profiles as opponent cards, Neural first under the server's name for it (left out when the server has no
 * Neural AI plugin). Forge's own profiles are fixed (its res/ai/*.ai); a game that lacks one says so when the match
 * starts and the start screen opens instead.
 */
export function opponents(neuralLabel = 'Neural', neural = true): Opponent[] {
  const all: Opponent[] = [
    { ai: 'Neural', name: neuralLabel, blurb: 'Neural opponent trained on Forge games. Plays her own trained decks best.', style: 'Strongest' },
    { ai: 'Default', name: 'Forge AI', blurb: 'Forge’s classic rules AI. Solid and predictable.', style: 'Balanced' },
    { ai: 'Cautious', name: 'Cautious', blurb: 'Holds back blockers and avoids risky trades.', style: 'Defensive' },
    { ai: 'Reckless', name: 'Reckless', blurb: 'Attacks early and often, even into bad blocks.', style: 'Aggressive' },
    { ai: 'Experimental', name: 'Experimental', blurb: 'Forge’s newest heuristics. May misplay.', style: 'Unpredictable' },
  ];
  return neural ? all : all.filter((o) => o.ai !== 'Neural');
}

/** The recommended AI: Neural in Constructed; in Brawl or Standard (Neural plays them untrained) or with no Neural, Forge AI. */
export function recommendedAi(format: LobbyFormat | undefined, neural = true): string {
  return format || !neural ? 'Default' : 'Neural';
}

// ------------------------------------------------------------------------------------------ decks

/** The fewest cards a Standard deck has. */
export const STANDARD_MIN = 60;

/**
 * The decks the gallery offers: in Brawl only those with a commander (a deck without one can't be played there), in
 * Standard only those of 60 cards or more with none that the server didn't find off Standard's sets or banlist (its
 * `standard` reason; see {@link offStandard}). A deck the server couldn't read stays, and the game itself judges it too.
 */
export function playable(names: string[], details: Record<string, DeckDetail>, format: LobbyFormat | undefined): string[] {
  if (!format) return names;
  return names.filter((n) => {
    if (!Object.hasOwn(details, n)) return true;
    const d = details[n]!;
    return format === 'brawl' ? !!d.commander : !d.commander && d.cards >= STANDARD_MIN && !d.standard;
  });
}

/**
 * Standard's greyed-out decks: 60 cards or more and no commander, but the server found them not Standard-legal
 * (`standard` says why). Shown under the gallery, not picked.
 */
export function offStandard(names: string[], details: Record<string, DeckDetail>): string[] {
  return names.filter((n) => Object.hasOwn(details, n) && !details[n]!.commander && details[n]!.cards >= STANDARD_MIN && !!details[n]!.standard);
}

/** Search (deck name, key card or commander) and colour chips (a deck with any picked colour). */
export function filterDecks(names: string[], details: Record<string, DeckDetail>, query: string, colors: ReadonlySet<string>): string[] {
  const q = query.trim().toLowerCase();
  return names.filter((n) => {
    const d = Object.hasOwn(details, n) ? details[n] : undefined;
    if (q && ![n, d?.key, d?.commander].some((s) => s?.toLowerCase().includes(q))) return false;
    if (colors.size > 0 && ![...colors].some((c) => d?.colors.includes(c))) return false;
    return true;
  });
}

/** "{R}{W}" for ManaText, from a deck's WUBRG colours. */
export function pipText(colors: string): string {
  return [...colors].map((c) => `{${c}}`).join('');
}

/** Cards in a Brawl deck, commander included. */
export const BRAWL_SIZE = 100;

export interface Check {
  ok: boolean;
  text: string;
}

/**
 * What the lobby can tell about a Brawl deck from its file: a commander, the size, singleton. Colour identity
 * and card legality need the card database, so the game checks those when it starts.
 */
export function brawlChecks(d: DeckDetail): Check[] {
  const dupes = d.dupes ?? [];
  const shown = dupes.slice(0, 4).join(', ') + (dupes.length > 4 ? ` and ${dupes.length - 4} more` : '');
  return [
    d.commander ? { ok: true, text: `Led by ${d.commander}` } : { ok: false, text: 'No commander' },
    d.cards === BRAWL_SIZE
      ? { ok: true, text: `${BRAWL_SIZE} cards, commander included` }
      : { ok: false, text: `${d.cards} cards: Brawl needs ${BRAWL_SIZE}, commander included` },
    dupes.length === 0
      ? { ok: true, text: 'One copy of each, basics aside' }
      : { ok: false, text: `More than one copy: ${shown}` },
  ];
}

/** "60 cards · commander" under a deck's name. */
export function deckMeta(d: DeckDetail | undefined): string {
  if (!d) return '';
  return `${d.cards} cards${d.commander ? ' · commander' : ''}`;
}

// ------------------------------------------------------------------------------------------ the picks

export interface Picks {
  format?: LobbyFormat;
  /** A deck name or {@link RANDOM_DECK}. */
  deck?: string;
  ai: string;
  /** Unset: the AI picks (Neural its strongest trained deck, Brawl a random shared deck). Else a name or random. */
  oppDeck?: string;
}

const pickKey = (format: LobbyFormat | undefined) => `newGame.${format ?? 'constructed'}`;

/** Last game's picks for a format, kept to what still exists (so a rematch with a deck swap is one click). */
export function loadPicks(
  format: LobbyFormat | undefined,
  pool: string[],
  load: (key: string) => string | null,
  fallbackDeck?: string | null,
  neural = true,
): Picks {
  let saved: Partial<Picks> = {};
  try {
    const raw = load(pickKey(format));
    if (raw) saved = JSON.parse(raw) as Partial<Picks>;
  } catch {
    // a broken entry: start over
  }
  const known = (d: unknown): d is string => typeof d === 'string' && (d === RANDOM_DECK || pool.includes(d));
  const ais = opponents(undefined, neural).map((o) => o.ai);
  const deck = known(saved.deck) ? saved.deck : known(fallbackDeck) ? fallbackDeck : pool[0];
  return {
    ...(format ? { format } : {}),
    ...(deck ? { deck } : {}),
    ai: typeof saved.ai === 'string' && ais.includes(saved.ai) ? saved.ai : recommendedAi(format, neural),
    ...(known(saved.oppDeck) ? { oppDeck: saved.oppDeck } : {}),
  };
}

export function savePicks(p: Picks, save: (key: string, value: string) => void): void {
  save(pickKey(p.format), JSON.stringify({ deck: p.deck, ai: p.ai, oppDeck: p.oppDeck }));
}

/**
 * What Start sends: the game's create body (decks resolved; the router only takes the Neural/Default AIs, the rest
 * ride in `start`) and the game page's `match.start`, with Random picks flagged so Rematch re-rolls them.
 */
export function startPlan(p: Picks, pool: string[], rand: () => number = Math.random): { create: NewMatch; start: MatchStartParams } | null {
  const deck = resolveDeck(p.deck, pool, rand);
  if (!deck) return null;
  const oppDeck = p.oppDeck === undefined ? undefined : resolveDeck(p.oppDeck, pool, rand);
  const create: NewMatch = { deck, ...(p.format ? { format: p.format } : {}), ...(oppDeck ? { oppDeck } : {}) };
  if (p.ai === 'Neural' || p.ai === 'Default') create.ai = p.ai;
  const start: MatchStartParams = { deck, ai: p.ai };
  if (p.deck === RANDOM_DECK) start.deckRandom = true;
  if (oppDeck) start.oppDeck = oppDeck;
  if (p.oppDeck === RANDOM_DECK) start.oppDeckRandom = true;
  return { create, start };
}

/** "Mono Red Aggro vs Lyra", the line the summary and the game page's loader show. */
export function versusLine(deck: string, opponent: string): string {
  return `${deck} vs ${opponent}`;
}

// ------------------------------------------------------------------------------------------ handoff to the game page

export interface Handoff {
  /** `match.start` as soon as the page is up. */
  start?: MatchStartParams;
  /** What the loader says meanwhile. */
  line?: string;
  /** Open the start screen's deck import instead of starting. */
  import?: true;
}

const handoffKey = (gameId: string) => `forge-table.newGame.${gameId}`;

/** Remember what the game page should do first (this tab only). */
export function rememberHandoff(gameId: string, h: Handoff, store: Pick<Storage, 'setItem'> = sessionStorage): void {
  try {
    store.setItem(handoffKey(gameId), JSON.stringify(h));
  } catch {
    // Storage off: the start screen asks again.
  }
}

/** The handoff for a game this tab made, left in place (the lobby's card for a starting game shows its picks). */
export function peekHandoff(gameId: string, store: Pick<Storage, 'getItem'> = sessionStorage): Handoff | null {
  try {
    const raw = store.getItem(handoffKey(gameId));
    const h = raw === null ? null : (JSON.parse(raw) as Handoff);
    return h && typeof h === 'object' ? h : null;
  } catch {
    return null;
  }
}

/** The game page's handoff, once: read and forgotten, so a reload after a failed start shows the start screen. */
export function takeHandoff(gameId: string, store: Pick<Storage, 'getItem' | 'removeItem'> = sessionStorage): Handoff | null {
  try {
    const raw = store.getItem(handoffKey(gameId));
    if (raw === null) return null;
    store.removeItem(handoffKey(gameId));
    const h = JSON.parse(raw) as Handoff;
    return h && typeof h === 'object' ? h : null;
  } catch {
    return null;
  }
}
