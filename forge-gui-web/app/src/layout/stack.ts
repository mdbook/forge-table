/**
 * The stack zone, MTGA-style, as pure functions: which entries it shows (a spell is its card,
 * an activated or triggered ability an "ability card" with a virtual id), where each sits in the cascade, and how a
 * card leaving the stack goes (resolved, countered, to exile…).
 */
import type { BeatMsg, CardId, GameModel, PlayerId, StackItem, ZoneRef } from '@forge-table/protocol';
import { STACK_CASCADE, stackLevel, type Geometry } from './geometry';

/**
 * Ability cards: a stack item that is not a card on the stack (an activated or triggered ability, or a second item
 * from the same card) is drawn as a card of its own, under this virtual id. Card ids are `c…` / `f…` / `x…`, so the
 * prefix never collides with one.
 */
export const ABILITY_PREFIX = 'ab:';
export const abilityId = (itemId: string): CardId => `${ABILITY_PREFIX}${itemId}`;
export const isAbilityId = (id: string | null | undefined): boolean => !!id && id.startsWith(ABILITY_PREFIX);
/** The stack item an ability card stands for ('ab:s8' → 's8'); null for a real card id. */
export const itemOfAbility = (id: string): string | null => (isAbilityId(id) ? id.slice(ABILITY_PREFIX.length) : null);

/** An ability card is drawn this much smaller than a card at the same depth (it reads as "an ability", not a spell). */
export const ABILITY_SCALE = 0.84;

export interface StackEntry {
  /** The card on the stack, or the ability card's virtual id (abilityId). */
  id: CardId;
  /** The stack item it shows (absent for a straggler: a card in zone Stack that no item names). */
  item?: StackItem;
  ability: boolean;
  /** The card the item comes from (for an ability: the permanent, or a hidden card, that produced it). */
  source?: CardId;
  /** Whose it is (the activator, else the card's controller). */
  controller?: PlayerId;
}

/**
 * Everything on the stack, top first. A stack item whose source is a card in zone Stack is that card (the first such
 * item only: a copy, or a trigger of the spell itself, gets an ability card); every other item is an ability card.
 * Cards in zone Stack that no item names follow, as cards.
 */
export function stackEntries(model: GameModel): StackEntry[] {
  const out: StackEntry[] = [];
  const used = new Set<CardId>();
  for (const si of model.game.stack ?? []) {
    const src = si.source;
    const card = src ? model.cards[src] : undefined;
    const controller = si.activator ?? card?.controller;
    if (src && card?.zone === 'Stack' && !used.has(src)) {
      used.add(src);
      out.push({ id: src, item: si, ability: false, source: src, ...(controller ? { controller } : {}) });
    } else {
      out.push({ id: abilityId(si.id), item: si, ability: true, ...(src ? { source: src } : {}), ...(controller ? { controller } : {}) });
    }
  }
  for (const [id, c] of Object.entries(model.cards)) {
    if (c.zone === 'Stack' && !used.has(id)) {
      used.add(id);
      out.push({ id, ability: false, source: id, ...(c.controller ? { controller: c.controller } : {}) });
    }
  }
  return out;
}

/** The stack item a card or ability card on the table stands for: an ability card's item, else the item a card is the source of. */
export function stackItemFor(model: GameModel, id: string | null | undefined): StackItem | undefined {
  if (!id) return undefined;
  const item = itemOfAbility(id);
  const stack = model.game.stack ?? [];
  return item ? stack.find((si) => si.id === item) : stack.find((si) => si.id === id || si.source === id);
}

/** What arrows start from for a stack item: its ability card, or (a spell) its card. */
export function stackOrigin(model: GameModel, si: StackItem): CardId | undefined {
  const entry = stackEntries(model).find((e) => e.item === si);
  return entry?.id ?? si.source;
}

export interface StackSlot {
  x: number;
  y: number;
  /** Card height for a card at this depth (an ability card is ABILITY_SCALE of it). */
  h: number;
  /** 0 = the front (newest) card. */
  depth: number;
  /** Brightness 0..1 (the scene tints older cards darker). */
  shade: number;
}

export interface Cascade {
  slots: StackSlot[];
  /** Entries beyond the visible depth (not drawn; the deepest visible card shows "+N"). */
  hidden: number;
}

/** Darker by this much a level, down to SHADE_MIN. */
const SHADE_STEP = 0.13;
const SHADE_MIN = 0.45;

/**
 * Slots for the first `n` entries (top first) in the stack zone: the front card's bottom on X.stackBottom at
 * SIZE.stackTop, each older one up and left of it (geometry stackLevel), capped at the cascade's depth.
 */
export function stackCascade(n: number, g: Geometry): Cascade {
  const c = g.portrait ? STACK_CASCADE.portrait : STACK_CASCADE.landscape;
  const shown = Math.min(n, c.depth);
  const topH = g.SIZE.stackTop;
  const frontTop = g.X.stackBottom - topH;
  const slots: StackSlot[] = [];
  for (let depth = 0; depth < shown; depth++) {
    const l = stackLevel(depth, topH, g.portrait);
    slots.push({ x: g.X.stackX + l.dx, y: frontTop + l.top + l.h / 2, h: l.h, depth, shade: Math.max(SHADE_MIN, 1 - SHADE_STEP * depth) });
  }
  return { slots, hidden: Math.max(0, n - shown) };
}

/**
 * How a card leaving the stack goes (MTGA). `permanent`: it resolved onto the battlefield; `resolve` / `exile`:
 * a resolved spell to its graveyard / to exile; `countered`: it left while another item was above it (a counterspell or a
 * countering trigger resolving), so it shatters; `bounce`: back to a hand (a plain flight). Null: not a stack exit.
 * Judged on the model just before the move.
 */
export type StackExit = 'permanent' | 'resolve' | 'exile' | 'countered' | 'bounce';

export function stackExit(card: CardId, from: ZoneRef | undefined, to: ZoneRef | undefined, before: GameModel | undefined): StackExit | null {
  const wasOnStack = from?.zone === 'Stack' || before?.cards[card]?.zone === 'Stack';
  if (!wasOnStack || !to?.zone || to.zone === 'Stack') return null;
  if (to.zone === 'Battlefield') return 'permanent';
  if (to.zone === 'Hand' || to.zone === 'Library') return 'bounce';
  const stack = before?.game.stack ?? [];
  const at = stack.findIndex((si) => si.source === card);
  if (at > 0) return 'countered';
  if (to.zone === 'Graveyard') return 'resolve';
  if (to.zone === 'Exile') return 'exile';
  return null;
}

/** stackExit for a zone beat (its card, from, to; a `fizzle` beat's own dissolve wins over `countered`). */
export function stackExitOf(beat: BeatMsg, before: GameModel | undefined): StackExit | null {
  return typeof beat.card === 'string' ? stackExit(beat.card, beat.from, beat.to, before) : null;
}

/** What an ability card says: the source's name, "Triggered" / "Activated", and the ability's own text. */
export interface AbilityFace {
  name: string;
  kind: 'Triggered' | 'Activated';
  text: string;
}

/**
 * The ability card's text, from Forge's stack text ("Name - text", "Name: text", "Name (121) - text"): the name prefix
 * goes (the card names its source), as do the zone-changer and targeting notes the list used to strip.
 */
export function abilityFace(si: StackItem, sourceName: string | undefined): AbilityFace {
  let text = si.text.replace(/\s*\[Zone Changer:[^\]]*\]/g, '').replace(/\s*\(Targeting: \[\[(.*?)\]\]\)/, ' → $1');
  const m = /^(.+?)(?: \(\d+\))?\s*(?: - |: )(.*)$/s.exec(text);
  let name = sourceName ?? '';
  if (m && (!sourceName || m[1]!.startsWith(sourceName) || sourceName.startsWith(m[1]!))) {
    name ||= m[1]!;
    text = m[2]!;
  }
  // Card ids in parentheses ("Ninja of the Deep Hours (121)") are Forge's, not the player's.
  text = text.replace(/ \(\d+\)/g, '').trim();
  return { name: name.replace(/ \(\d+\)$/, '') || 'Ability', kind: si.trigger ? 'Triggered' : 'Activated', text };
}
