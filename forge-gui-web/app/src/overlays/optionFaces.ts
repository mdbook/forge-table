/**
 * Options that come from one card (an ability menu, a spell's modes, the ways to cast it, any choice among one card's
 * abilities) are drawn as cards: each is the source card with only that option in its text box (OptionCards.tsx).
 * Pure: which asks qualify, what each option's card says, and how big the cards can be.
 */
import type { CardFace, ChooseAsk, GameModel } from '@forge-table/protocol';
import { costOptions } from './costOptions';

/**
 * The card every option of the ask comes from, or null when the ask is not "pick among one card's options": the
 * items all name the same card (an item's own card, else the ask's) and that card's face is known. Several items
 * on one card can only be its abilities or modes (a card is never listed twice as itself); a single item counts only
 * in an ability menu or a "Choose a mode" (else it is a plain choice of that card, the carousel's).
 */
export function optionHost(ask: ChooseAsk, model: GameModel): string | null {
  if (ask.reveal || ask.items.length === 0) return null;
  if (ask.items.some((it) => it.player || it.cardData)) return null;
  const ids = new Set(ask.items.map((it) => it.card ?? ask.card));
  if (ids.size !== 1) return null;
  const id = [...ids][0];
  if (!id || !model.cards[id]?.state) return null;
  if (ask.items.length > 1 || ask.kind === 'ability' || isModeTitle(ask)) return id;
  return null;
}

/** Forge's "<player> activated <card> - Choose a mode" (PlayerControllerHuman.chooseModeForAbility). */
export function isModeTitle(ask: ChooseAsk): boolean {
  return /choose a mode/i.test(`${ask.title ?? ''} ${ask.message ?? ''}`);
}

export interface OptionFace {
  idx: number;
  enabled: boolean;
  /** The text box: only this option's text. */
  text: string;
  /** The cost plate when it is not the printed cost: an alternative cost's mana ('' = no mana at all). */
  cost?: string;
  /** Under the card when the options are ways to cast it: "Cast", "Flashback", "Alternative cost". */
  caption?: string;
}

/**
 * An alternative cost Forge adds to a spell's description in parentheses (StaticAbilityAlternativeCost): "(If you have
 * no land cards in hand, you may reveal your hand rather than pay this spell's mana cost.)" or "(by paying {2}{U}
 * instead of its mana cost)".
 */
const ALT_NOTE = /\s*\(([^()]*\b(?:rather than pay|instead of (?:paying )?its mana cost)[^()]*)\)\s*$/i;
const MANA = /(?:\{[^}]+\})+/;

function sentence(s: string): string {
  const t = s.trim();
  const up = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(up) ? up : `${up}.`;
}

/**
 * What each option's card says. An alternative cost leads its text box (out of its parentheses, so it reads as rules,
 * not reminder text) and its cost plate shows its mana, or nothing when it costs no mana (reveal your hand, sacrifice
 * two Mountains); a keyword cost (Flashback {2}{R}) puts its mana on the plate. The options then get captions.
 */
export function optionFaces(ask: ChooseAsk, face: CardFace): OptionFace[] {
  const keyed = costOptions(ask);
  let ways = !!keyed;
  const out = ask.items.map((it): OptionFace => {
    const enabled = it.enabled !== false;
    const label = it.label.trim();
    const alt = ALT_NOTE.exec(label);
    if (alt) {
      ways = true;
      const rest = label.slice(0, alt.index).trim();
      const by = /^by paying\b/i.test(alt[1]!.trim());
      const note = by ? `You may cast this spell ${alt[1]!.trim()}` : alt[1]!;
      return { idx: it.idx, enabled, text: rest ? `${sentence(note)}\n${rest}` : sentence(note), cost: MANA.exec(alt[1]!)?.[0] ?? '', caption: 'Alternative cost' };
    }
    const k = keyed?.find((o) => o.idx === it.idx);
    if (k && k.mode !== 'Cast' && k.mode !== 'Ability') return { idx: it.idx, enabled, text: label, cost: k.cost ?? face.manaCost ?? '', caption: k.mode };
    return { idx: it.idx, enabled, text: label };
  });
  if (!ways) return out;
  // Ways to cast one card: the plain cast says so too, so the captions read as a set.
  return out.map((o) => (o.caption ? o : { ...o, caption: 'Cast' }));
}

/**
 * The option cards' height (px) and columns: as large as fits `w`×`h` (cards `aspect` wide per unit of height, `gap`
 * apart, each row `extra` taller for its caption, key flag and lift), up to `max`; more rows only when that makes them
 * clearly larger. When even that leaves them under `min` (a phone), they stay readable instead: as many columns of at
 * least `min` as the width takes, at most 80% of the height so the next row peeks out, and the rows scroll.
 */
export function optionCardFit(n: number, w: number, h: number, aspect: number, gap: number, max: number, min = 0, extra = 0): { height: number; cols: number } {
  let best = { height: 0, cols: Math.max(1, n) };
  for (let rows = 1; rows <= Math.max(1, n); rows++) {
    const cols = Math.ceil(n / rows);
    const byW = (w - (cols - 1) * gap) / (cols * aspect);
    const byH = (h - (rows - 1) * gap) / rows - extra;
    const height = Math.floor(Math.min(max, byW, byH));
    // Another row has to buy clearly bigger cards (a row reads better than a grid).
    if (height > best.height * (rows === 1 ? 1 : 1.1)) best = { height, cols };
  }
  if (best.height >= min) return best;
  const cols = Math.max(1, Math.min(n, Math.floor((w + gap) / (min * aspect + gap))));
  return { height: Math.floor(Math.min(max, (w - (cols - 1) * gap) / (cols * aspect), h * 0.8)), cols };
}
