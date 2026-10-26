/**
 * Keyword moments ("a bunch of little things": flying, trample, deathtouch…). Pure reads of what the client
 * already has: the card model's keyword titles (`state.keywords[].title`, Forge's Keyword enum names), the combat
 * bands and the damage beat's own fields (`card` / `target`, `source`, `amount`, `combat` on a player hit). No rules
 * text is parsed. The choreographer turns them into tracks; the scene draws them (table/keywordFx.ts).
 */
import type { BeatMsg, CardFace, CardId, GameModel, PlayerId } from '@forge-table/protocol';
import { hasKeyword } from '../store/model';

/** Keyword titles as Forge sends them (forge-game Keyword.java). */
export const KW = {
  flying: 'Flying',
  trample: 'Trample',
  deathtouch: 'Deathtouch',
  lifelink: 'Lifelink',
  firstStrike: 'First Strike',
  doubleStrike: 'Double Strike',
  indestructible: 'Indestructible',
  haste: 'Haste',
  vigilance: 'Vigilance',
} as const;

const amountOf = (beat: BeatMsg) => (typeof beat.amount === 'number' ? beat.amount : 0);
const sourceOf = (beat: BeatMsg, before: GameModel | undefined) => (typeof beat.source === 'string' ? before?.cards[beat.source] : undefined);

/**
 * Trample over: a combat hit on a player from an attacker that has trample and was blocked. The wire already
 * splits the damage (Forge sends the excess as its own player hit, before the blockers' hits), so the excess is
 * this beat's amount; what is needed is which blockers it went through (still on the battlefield), for the streak
 * that runs from them to the player. Null for anything else (unblocked, no trample, a planeswalker, non-combat).
 */
export function trampleOver(beat: BeatMsg, before: GameModel | undefined): { attacker: CardId; through: CardId[]; player: PlayerId } | null {
  if (beat.kind !== 'damage' || beat.combat !== true || typeof beat.target !== 'string' || amountOf(beat) <= 0 || !before) return null;
  const src = sourceOf(beat, before);
  if (!src || !before.players[beat.target] || !hasKeyword(src, KW.trample)) return null;
  const band = before.game.combat?.find((b) => b.attacker === src.id);
  const through = (band?.blockers ?? []).filter((id) => before.cards[id]?.zone === 'Battlefield');
  return through.length > 0 ? { attacker: src.id, through, player: beat.target } : null;
}

/** Lifelink: the player whose life the hit feeds (the source's controller), or null. */
export function lifelinkTo(beat: BeatMsg, before: GameModel | undefined): PlayerId | null {
  if (beat.kind !== 'damage' || amountOf(beat) <= 0 || beat.infect === true) return null;
  const src = sourceOf(beat, before);
  return src && hasKeyword(src, KW.lifelink) && typeof src.controller === 'string' ? src.controller : null;
}

/** A deathtouch hit on a creature that can die of it (not indestructible): the hit card, or null. */
export function deathtouchHit(beat: BeatMsg, before: GameModel | undefined): CardId | null {
  if (beat.kind !== 'damage' || amountOf(beat) <= 0 || typeof beat.card !== 'string') return null;
  const hit = before?.cards[beat.card];
  const src = sourceOf(beat, before);
  if (!hit || hit.zone !== 'Battlefield' || !src || !hasKeyword(src, KW.deathtouch) || hasKeyword(hit, KW.indestructible)) return null;
  return beat.card;
}

/**
 * A first-strike hit: damage dealt in the first-strike damage step (first strike, or double strike's first blow), so
 * the two damage steps read apart. Judged on the phase the model is in, not on keywords: a double striker's second
 * blow lands in the regular step and plays plain.
 */
export function firstStrikeHit(beat: BeatMsg, before: GameModel | undefined): boolean {
  if (beat.kind !== 'damage' || amountOf(beat) <= 0 || before?.game.phase !== 'COMBAT_FIRST_STRIKE_DAMAGE') return false;
  return sourceOf(beat, before)?.zone === 'Battlefield';
}

/** An indestructible creature taking what would otherwise kill it (marked damage reaching its toughness, or deathtouch). */
export function shrugsOff(beat: BeatMsg, before: GameModel | undefined): CardId | null {
  if (beat.kind !== 'damage' || typeof beat.card !== 'string') return null;
  const amount = amountOf(beat);
  const c = before?.cards[beat.card];
  const t = c?.state?.toughness;
  if (amount <= 0 || !c || c.zone !== 'Battlefield' || !hasKeyword(c, KW.indestructible) || typeof t !== 'number') return null;
  const src = sourceOf(beat, before);
  return (c.damage ?? 0) + amount >= t || (!!src && hasKeyword(src, KW.deathtouch)) ? beat.card : null;
}

/**
 * Keywords with an ability symbol that the frame can show as an icon (Mana font `ability-<key>`). Hexproof and ward are
 * left out (their sigils already say it, table/protectionFx.ts), flash too (nothing to say on the battlefield).
 */
export const ICON_KEYWORDS = [
  'flying',
  'deathtouch',
  'lifelink',
  'trample',
  'menace',
  'vigilance',
  'reach',
  'first-strike',
  'double-strike',
  'haste',
  'indestructible',
  'defender',
  'toxic',
  'undying',
] as const;
export type IconKeyword = (typeof ICON_KEYWORDS)[number];

/**
 * Keywords a card has that its own printed text doesn't give it (an aura, an anthem, a pump spell),
 * as icon keys in ICON_KEYWORDS order. "Printed" is a whole-word match of the keyword's name in the
 * face's oracle text, so a card whose text grants itself the keyword ("gains flying until end of turn") or names it at
 * all (a lord's "creatures you control have flying") shows no icon for it.
 * A vanilla face (oracle text '') has printed nothing, so everything it has is gained; a face whose oracle text isn't
 * on the wire at all shows none (its text box is built from its current keywords).
 */
export function gainedKeywords(face: CardFace | undefined): IconKeyword[] {
  const oracle = face?.oracleText;
  if (oracle === undefined) return [];
  const have = new Set<string>();
  for (const k of face?.keywords ?? []) {
    const key = k.title.trim().toLowerCase().replace(/\s+\d+$/, '').replace(/\s+/g, '-');
    if (!(ICON_KEYWORDS as readonly string[]).includes(key)) continue;
    const name = key.replace(/-/g, ' ');
    if (!new RegExp(`\\b${name}\\b`, 'i').test(oracle)) have.add(key);
  }
  return ICON_KEYWORDS.filter((k) => have.has(k));
}

/**
 * The untap ripple (my permanents light up left to right as they untap). Forge untaps in its own order, so each
 * card's sweep is placed by where it sits instead: `x` across [left, right] maps onto [0, spread] ms after the
 * ripple began. Clamped, so a card outside the range plays at an end.
 */
export function rippleDelay(x: number, left: number, right: number, spread: number): number {
  if (!(right > left)) return 0;
  return Math.round(Math.min(1, Math.max(0, (x - left) / (right - left))) * spread);
}

/** A stable phase in [0, 1) per card id, so flyers don't all bob in step. */
export function phaseOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 997) / 997;
}
