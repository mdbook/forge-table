/**
 * Which arrows the table shows (pure): red attacker → defender (unblocked ones) and blue blocker → attacker for
 * every combat band (both players, planned blocks included, from declaration through damage); yellow source → target for the
 * top stack item, a hovered stack item and the targets already chosen in chooseTargets; and the pending arrow
 * that follows the cursor while the player is aiming.
 */
import type { CardId, CombatBand, GameModel, PlayerId, PromptBody, StackItem } from '@forge-table/protocol';
import { wardTrigger } from '../director/protection';
import { abilityId, stackEntries } from '../layout/stack';

/** `ward`: a ward trigger on the stack, linked to the permanent it guards (director/protection.ts wardTrigger). */
export type ArrowKind = 'attack' | 'block' | 'target' | 'ward';

export type ArrowEnd = { card: CardId } | { player: PlayerId } | { point: { x: number; y: number } };

export interface ArrowSpec {
  /** Stable identity across frames (draw-in animates once per key). */
  key: string;
  kind: ArrowKind;
  from: ArrowEnd;
  to: ArrowEnd;
  /** Follows the cursor (drawn without the draw-in, slightly lighter). */
  pending?: boolean;
  /** Another stack item is hovered: this one's arrows step back (arrowLayer draws them faint). */
  dim?: boolean;
  /** Aimed at a card that may not be targeted (hexproof, shroud, protection): the tip bounces off its edge instead. */
  deflect?: boolean;
}

export interface PendingArrow {
  kind: ArrowKind;
  from: CardId;
  to: ArrowEnd;
  /** `to` is a card the aim may not target: the arrow is turned away (ArrowSpec.deflect). */
  deflect?: boolean;
}

export interface ArrowInput {
  model: GameModel;
  viewer: PlayerId;
  prompt: PromptBody | null;
  /** The card has a pose on the table (arrows only join things on screen). */
  visible: (id: CardId) => boolean;
  pending?: PendingArrow | null;
  /**
   * What the pointer is over: a stack item (its id in the stack list), a card or ability card on the stack, a source
   * on the table, or a card some stack item targets (that item lights up).
   */
  hoverStack?: string | null;
}

/** Whether an id names a player of this game (else it is a card id). */
export function isPlayer(model: GameModel, id: string): boolean {
  return !!model.players[id];
}

/** Every creature blocking (or planned to block) → the attacker it blocks. */
export function blockerMap(combat: CombatBand[] | undefined): Map<CardId, CardId> {
  const out = new Map<CardId, CardId>();
  for (const band of combat ?? []) {
    for (const b of [...(band.blockers ?? []), ...(band.planned ?? [])]) if (!out.has(b)) out.set(b, band.attacker);
  }
  return out;
}

/** The blockers of each attacker, in declaration order (locked first, then planned). */
export function blockersOf(band: CombatBand): CardId[] {
  const out: CardId[] = [];
  for (const b of [...(band.blockers ?? []), ...(band.planned ?? [])]) if (!out.includes(b)) out.push(b);
  return out;
}

/** What an attacker attacks: the band's defender, else (1v1) the other player. */
export function defenderOf(model: GameModel, band: CombatBand): string | undefined {
  if (band.defender) return band.defender;
  const ctl = model.cards[band.attacker]?.controller;
  return Object.keys(model.players).find((p) => p !== ctl);
}

/** The source card a targeting arrow starts from: the prompt's card, else the newest stack item's source. */
export function targetSource(model: GameModel, prompt: PromptBody | null): CardId | undefined {
  if (prompt?.card) return prompt.card;
  return model.game.stack[0]?.source;
}

function endOf(model: GameModel, id: string, visible: (id: CardId) => boolean): ArrowEnd | null {
  if (isPlayer(model, id)) return { player: id };
  return visible(id) ? { card: id } : null;
}

/** More unblocked attackers than this at one player draw no arrows (but the hovered one's): a lone one keeps its arrow. */
export const ATTACK_ARROWS_MAX = 1;

export function arrowSpecs(input: ArrowInput): ArrowSpec[] {
  const { model, prompt, visible } = input;
  const out: ArrowSpec[] = [];
  const keys = new Set<string>();
  const push = (s: ArrowSpec) => {
    if (keys.has(s.key)) return;
    keys.add(s.key);
    out.push(s);
  };

  // Combat: attack arrows, then block arrows (drawn over them).
  const bands = model.game.combat ?? [];
  const attacks: ArrowSpec[] = [];
  for (const band of bands) {
    if (!visible(band.attacker)) continue;
    const def = defenderOf(model, band);
    const to = def ? endOf(model, def, visible) : null;
    // Once blocked, the block arrows carry that fight (MTGA): only unblocked attackers point at their defender.
    if (!to || blockersOf(band).some((b) => visible(b))) continue;
    attacks.push({ key: `attack:${band.attacker}`, kind: 'attack', from: { card: band.attacker }, to });
  }
  // A swarm at a player: their step forward and red ring say it; only the hovered one's arrow shows (QA: a dozen
  // arrows crossed the board to the plate). Planeswalkers and battles keep theirs.
  const atPlayers = attacks.filter((a) => 'player' in a.to).length;
  for (const a of attacks) {
    if (atPlayers > ATTACK_ARROWS_MAX && 'player' in a.to && (a.from as { card: CardId }).card !== input.hoverStack) continue;
    push(a);
  }
  for (const band of bands) {
    if (!visible(band.attacker)) continue;
    for (const b of blockersOf(band)) {
      if (visible(b)) push({ key: `block:${b}:${band.attacker}`, kind: 'block', from: { card: b }, to: { card: band.attacker } });
    }
  }

  // The stack: the top item's targets always; a hovered item's too (its list row, its card or ability card, its source),
  // and every item aiming at a hovered card. While one is hovered the others' arrows step back. Arrows start at the
  // stack card (an ability: its ability card; layout/stack.ts), else at the source on the table.
  const stack = model.game.stack ?? [];
  const hover = input.hoverStack;
  const hovered = hover ? stack.filter((si) => si.id === hover || si.source === hover || abilityId(si.id) === hover || (si.targets ?? []).includes(hover)) : [];
  const items: StackItem[] = [];
  if (stack[0]) items.push(stack[0]);
  for (const h of hovered) if (!items.includes(h)) items.push(h);
  const origins = items.length ? new Map(stackEntries(model).map((e) => [e.item, e.id])) : null;
  for (const si of items) {
    const card = origins?.get(si);
    const from = card && visible(card) ? card : si.source && visible(si.source) ? si.source : undefined;
    if (!from) continue;
    const dim = hovered.length > 0 && !hovered.includes(si);
    for (const t of si.targets ?? []) {
      if (t === si.source || t === from) continue;
      const to = endOf(model, t, visible);
      if (to) push({ key: `target:${from}:${t}`, kind: 'target', from: { card: from }, to, ...(dim ? { dim } : {}) });
    }
  }

  // Ward: its trigger on the stack is tied to the permanent it guards, whichever item is on top.
  for (const e of stackEntries(model)) {
    const guarded = e.item ? wardTrigger(model, e.item) : null;
    if (!guarded || !e.ability || !visible(e.id) || !visible(guarded)) continue;
    push({ key: `ward:${e.id}:${guarded}`, kind: 'ward', from: { card: e.id }, to: { card: guarded }, ...(hovered.length > 0 && !hovered.includes(e.item!) ? { dim: true } : {}) });
  }

  // Choosing targets: the ones already chosen are locked in.
  if (prompt?.kind === 'chooseTargets') {
    const src = targetSource(model, prompt);
    if (src && visible(src)) {
      for (const t of prompt.highlighted ?? []) {
        if (t === src) continue;
        const to = endOf(model, t, visible);
        if (to) push({ key: `target:${src}:${t}`, kind: 'target', from: { card: src }, to });
      }
    }
  }

  const p = input.pending;
  if (p && visible(p.from)) {
    const snapped = 'card' in p.to ? (visible(p.to.card) ? p.to : null) : p.to;
    if (snapped) push({ key: `pending:${p.kind}:${p.from}`, kind: p.kind, from: { card: p.from }, to: snapped, pending: true, ...(p.deflect ? { deflect: true } : {}) });
  }
  return out;
}
