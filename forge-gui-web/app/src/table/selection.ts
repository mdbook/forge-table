/**
 * Selection clarity (2026-10-03): what the player has already PICKED must never look like what they COULD pick.
 *
 * - selectable (the prompt's `selectable`): the ember ring ("you can click this").
 * - picked (the prompt's `highlighted`, in a selection prompt): the pick treatment, meaning a thick cyan ring, the card
 *   lifted, and a badge: a check, or 1, 2, 3… in pick order when more than one can be picked. A picked card is
 *   usually still selectable (click again to un-pick): picked wins.
 *
 * In combat prompts `highlighted` is the engine's current focus (the attacker being blocked, the defender being
 * attacked, the active band), not a pick: those keep the plain `highlight` ring and get no badge.
 *
 * Pick order comes from the order of `highlighted`: Forge highlights each entity as it is picked, and the bridge
 * keeps them in insertion order (BridgeGuiGame.highlighted is a LinkedHashSet).
 */
import type { PromptBody } from '@forge-table/protocol';
import type { RingKind } from './cardSprite';

/** Prompt kinds whose `highlighted` is the engine's focus, not the player's picks. */
const FOCUS_KINDS = new Set(['declareAttackers', 'declareBlockers']);

export interface Picks {
  /** Picked entity (card or player id) → its 1-based pick position. */
  order: ReadonlyMap<string, number>;
  /** Show 1, 2, 3… rather than a check: more than one can be (or has been) picked. */
  numbered: boolean;
  /** Engine focus in a combat prompt (no pick badge). */
  focus: ReadonlySet<string>;
  /** A word every pick wears instead of a check or number (the mulligan tuck's "Bottom"). */
  tag?: string;
}

export const NO_PICKS: Picks = { order: new Map(), numbered: false, focus: new Set() };

/** The picks a prompt shows (cards and players alike). */
export function picksOf(prompt: Pick<PromptBody, 'kind' | 'highlighted' | 'selMax'> | null | undefined): Picks {
  const hl = prompt?.highlighted ?? [];
  if (!prompt || hl.length === 0) return NO_PICKS;
  if (FOCUS_KINDS.has(prompt.kind)) return { order: new Map(), numbered: false, focus: new Set(hl) };
  const order = new Map<string, number>();
  for (const id of hl) if (!order.has(id)) order.set(id, order.size + 1);
  const picks: Picks = { order, numbered: order.size > 1 || (prompt.selMax ?? 0) > 1, focus: new Set() };
  // The London tuck: what a pick does is go to the bottom, so it says so.
  return prompt.kind === 'mulliganTuck' ? { ...picks, tag: BOTTOM_TAG } : picks;
}

/** The tag a card picked for the mulligan tuck wears. */
export const BOTTOM_TAG = 'Bottom';

/** The pick badge's text for "picked" without a number (drawn as a check mark, never as a font glyph). */
export const PICK_CHECK = '✓';

/** A pick badge's text: the 1-based position when numbered, else a check. */
export function pickLabel(pos: number, numbered: boolean): string {
  return numbered ? String(pos) : PICK_CHECK;
}

/** The badge a picked entity shows, or null when it isn't picked. */
export function pickBadge(id: string, picks: Picks): string | null {
  const pos = picks.order.get(id);
  return pos === undefined ? null : (picks.tag ?? pickLabel(pos, picks.numbered));
}

export interface RingInput {
  id: string;
  /** An ask is up: nothing on the board is clickable. */
  blocked: boolean;
  selectable: ReadonlySet<string>;
  picks: Picks;
  card?: { attacking?: unknown; blocking?: unknown } | undefined;
  stackTop: string | null | undefined;
}

/** Ring priority: picked > selectable > combat focus > attacking > blocking > top of the stack. */
export function ringFor(r: RingInput): RingKind {
  if (r.picks.order.has(r.id)) return 'selected';
  if (!r.blocked && r.selectable.has(r.id)) return 'selectable';
  if (r.picks.focus.has(r.id)) return 'highlight';
  if (r.card?.attacking) return 'attacking';
  if (r.card?.blocking) return 'blocking';
  if (r.id === r.stackTop) return 'stackTop';
  return 'none';
}
