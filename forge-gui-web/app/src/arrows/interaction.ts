/**
 * Combat and targeting input as pure decisions (MTGA-style):
 *
 * - declareBlockers with `prompt.blockable` (blocker-first): a click on one of my blockable creatures selects it
 *   (client-side); a click on an attacker it can legally block sends `block`; a click on a creature already
 *   blocking sends `unblock`; a second click on the selected creature drops the selection. Without `blockable`
 *   (an older server) every click is a plain card click, as before.
 * - declareAttackers: a click toggles (a plain card click); a drag from an attacker onto one of
 *   `prompt.defenders` sends `attack`.
 * - chooseTargets: clicks are plain clicks; the pending arrow just follows the cursor from the source.
 */
import type { CardId, CombatBand, PlayerId, PromptBody } from '@forge-table/protocol';
import { blockerMap } from './specs';

export type AimMode = 'block' | 'attack' | 'target';

/** An act to send for the prompt on screen (the runtime adds t / pid). */
export type AimAct =
  | { kind: 'card'; card: CardId }
  | { kind: 'block'; blocker: CardId; attacker: CardId }
  | { kind: 'unblock'; blocker: CardId }
  | { kind: 'attack'; attacker: CardId; defender: CardId | PlayerId };

export interface ClickDecision {
  /** The new client-side selection (undefined = unchanged). */
  select?: CardId | null;
  act?: AimAct;
}

/** The aiming mode a prompt puts the table in, or null. */
export function aimMode(prompt: PromptBody | null): AimMode | null {
  switch (prompt?.kind) {
    case 'declareBlockers':
      return prompt.blockable ? 'block' : null;
    case 'declareAttackers':
      return 'attack';
    case 'chooseTargets':
      return 'target';
    default:
      return null;
  }
}

/** The attackers a creature can legally block right now (empty when it can't block). */
export function legalAttackers(prompt: PromptBody | null, blocker: CardId | null): CardId[] {
  if (!blocker) return [];
  return prompt?.blockable?.[blocker] ?? [];
}

/** A card click during declareBlockers. */
export function blockClick(prompt: PromptBody, combat: CombatBand[] | undefined, selected: CardId | null, clicked: CardId): ClickDecision {
  const blockable = prompt.blockable;
  if (!blockable) return { act: { kind: 'card', card: clicked } };
  const blocking = blockerMap(combat);
  if (selected) {
    if (clicked === selected) return { select: null };
    if (legalAttackers(prompt, selected).includes(clicked)) return { select: null, act: { kind: 'block', blocker: selected, attacker: clicked } };
    if (blocking.has(clicked)) return { select: null, act: { kind: 'unblock', blocker: clicked } };
    if (clicked in blockable) return { select: clicked };
    // Not a legal attacker for it: keep aiming.
    return {};
  }
  if (blocking.has(clicked)) return { act: { kind: 'unblock', blocker: clicked } };
  if ((blockable[clicked]?.length ?? 0) > 0) return { select: clicked };
  // Anything else (an attacker, say) is the engine's business, as before.
  return { act: { kind: 'card', card: clicked } };
}

/** Whether a press on this card can start a drag (and which arrow it draws). */
export function dragSource(mode: AimMode | null, prompt: PromptBody | null, combat: CombatBand[] | undefined, card: CardId, viewer: PlayerId, controller: PlayerId | undefined): boolean {
  if (!prompt || controller !== viewer) return false;
  if (mode === 'block') return (prompt.blockable?.[card]?.length ?? 0) > 0;
  if (mode === 'attack') {
    if (!prompt.defenders || prompt.defenders.length === 0) return false;
    return prompt.selectable.includes(card) || (combat ?? []).some((b) => b.attacker === card);
  }
  return false;
}

/** What dropping a dragged card onto a card or player sends, if anything. */
export function dropAct(mode: AimMode | null, prompt: PromptBody | null, source: CardId, over: string | null): AimAct | null {
  if (!prompt || !over || over === source) return null;
  if (mode === 'block' && legalAttackers(prompt, source).includes(over)) return { kind: 'block', blocker: source, attacker: over };
  if (mode === 'attack' && prompt.defenders?.includes(over)) return { kind: 'attack', attacker: source, defender: over };
  return null;
}

/** Where a pending arrow may snap: the legal ends for the current aim. */
export function snapTargets(mode: AimMode | null, prompt: PromptBody | null, source: CardId | null): Set<string> {
  if (!prompt) return new Set();
  if (mode === 'block') return new Set(legalAttackers(prompt, source));
  if (mode === 'attack') return new Set(prompt.defenders ?? []);
  if (mode === 'target') return new Set(prompt.selectable ?? []);
  return new Set();
}

/** Pixels the pointer must travel with the button down before a press becomes a drag. */
export const DRAG_THRESHOLD_PX = 8;

export function pastThreshold(a: { x: number; y: number }, b: { x: number; y: number }, px = DRAG_THRESHOLD_PX): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) >= px;
}
