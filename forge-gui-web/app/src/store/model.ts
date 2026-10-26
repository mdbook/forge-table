/**
 * The client-side game model and patch application.
 *
 * A patch is an object-level replacement: `game` replaces the whole game object, each `players[id]`
 * replaces that player, each `cards[id]` replaces that card and `null` removes it. Stores are treated as
 * immutable values (`applyPatch` returns a new model that shares untouched objects with the old one), so
 * React selectors and the layout can cheaply detect what changed.
 */
import type { Card, CardId, Game, GameModel, Patch, Phase, Player, PlayerId } from '@forge-table/protocol';

export function emptyModel(): GameModel {
  return { game: { stack: [] }, players: {}, cards: {} };
}

export function applyPatch(model: GameModel, patch: Patch | undefined | null): GameModel {
  if (!patch) return model;
  let { game, players, cards } = model;
  if (patch.game) game = normalizeGame(patch.game);
  if (patch.players) {
    players = { ...players };
    for (const [id, p] of Object.entries(patch.players)) {
      if (p == null) delete players[id];
      else players[id] = p;
    }
  }
  if (patch.cards) {
    cards = { ...cards };
    for (const [id, c] of Object.entries(patch.cards)) {
      if (c == null) delete cards[id];
      else if (!(cards[id] && isStub(c))) cards[id] = c;
    }
  }
  return { game, players, cards };
}

/**
 * A card caught mid-move: Forge's view of a dying creature is `{id, state: {face}}` for a moment (the dies beat), and
 * the full card follows. Keeping what we had keeps its art on the way to the graveyard (it turned generic).
 * Hidden cards are never this bare: they carry zone, owner and facedown.
 */
function isStub(c: Card): boolean {
  const keys = Object.keys(c);
  return keys.every((k) => k === 'id' || k === 'state') && Object.keys(c.state ?? {}).every((k) => k === 'face');
}

/** A model from a snapshot (or any full state). */
export function modelOf(game: Game, players: Record<PlayerId, Player>, cards: Record<CardId, Card>): GameModel {
  return { game: normalizeGame(game), players: { ...players }, cards: { ...cards } };
}

function normalizeGame(g: Game): Game {
  return g.stack ? g : { ...g, stack: [] };
}

// ------------------------------------------------------------------------------------------ queries

export function opponentOf(model: GameModel, viewer: PlayerId): PlayerId | undefined {
  return Object.keys(model.players).find((p) => p !== viewer);
}

export function zone(model: GameModel, player: PlayerId | undefined, key: string): string[] {
  if (!player) return [];
  return model.players[player]?.zones?.[key] ?? [];
}

/**
 * Whether hovering card `id` opens the large preview. Not for a card in my own hand: it
 * already grows in place on hover (the hand's hover lift), so the preview would only repeat it. Holding Alt
 * forces it there, and a raised hand (choosing cards from it) has no hover lift, so it keeps the preview.
 */
export function previewsOnHover(model: GameModel, viewer: PlayerId, id: CardId, opts: { alt: boolean; handRaised: boolean }): boolean {
  if (id.startsWith('x')) return false;
  if (opts.alt || opts.handRaised) return true;
  return !zone(model, viewer, 'hand').includes(id);
}

export function isCreature(c: Card | undefined): boolean {
  return !!c?.state?.type?.core?.includes('Creature');
}

/**
 * The face to draw: a face-down card in exile that I may look at (a foretold card is identified to its owner, `c` id)
 * shows its real face, which the bridge sends as `alt`; everything else shows its current state.
 */
export function knownFace(card: Card | undefined): Card['state'] {
  const s = card?.state;
  if (s?.face === 'FaceDown' && card?.zone === 'Exile' && card.id.startsWith('c') && card.alt) return card.alt;
  return s;
}

/** A face-down card I can see the face of (knownFace shows its real face). */
export function peeked(card: Card | undefined): boolean {
  return !!card && card.state?.face === 'FaceDown' && knownFace(card) !== card.state;
}

export function isLand(c: Card | undefined): boolean {
  return !!c?.state?.type?.core?.includes('Land');
}

export function hasKeyword(c: Card | undefined, title: string): boolean {
  return !!c?.state?.keywords?.some((k) => k.title === title);
}

/**
 * Summoning sick: a creature on the battlefield that hasn't been under its controller's control since their
 * most recent turn began, and has no haste (it can't attack or pay {T}). The wire's `sickness` is Forge's
 * "first turn controlled" flag, so it is also true for hasty creatures and lands (CardView.isSick).
 */
export function isSummoningSick(c: Card | undefined): boolean {
  return !!c?.sickness && c.zone === 'Battlefield' && isCreature(c) && !hasKeyword(c, 'Haste');
}

/** A creature that could be declared as an attacker now: untapped, not summoning sick, a creature. */
export function canAttack(c: Card | undefined): boolean {
  return !!c && isCreature(c) && !c.tapped && !isSummoningSick(c) && !c.phasedOut;
}

export const PHASE_ORDER: Phase[] = [
  'UNTAP',
  'UPKEEP',
  'DRAW',
  'MAIN1',
  'COMBAT_BEGIN',
  'COMBAT_DECLARE_ATTACKERS',
  'COMBAT_DECLARE_BLOCKERS',
  'COMBAT_FIRST_STRIKE_DAMAGE',
  'COMBAT_DAMAGE',
  'COMBAT_END',
  'MAIN2',
  'END_OF_TURN',
  'CLEANUP',
];

export const PHASE_LABEL: Record<Phase, string> = {
  UNTAP: 'Untap',
  UPKEEP: 'Upkeep',
  DRAW: 'Draw',
  MAIN1: 'Main 1',
  COMBAT_BEGIN: 'Begin Combat',
  COMBAT_DECLARE_ATTACKERS: 'Attackers',
  COMBAT_DECLARE_BLOCKERS: 'Blockers',
  COMBAT_FIRST_STRIKE_DAMAGE: 'First Strike',
  COMBAT_DAMAGE: 'Damage',
  COMBAT_END: 'End Combat',
  MAIN2: 'Main 2',
  END_OF_TURN: 'End Step',
  CLEANUP: 'Cleanup',
};
