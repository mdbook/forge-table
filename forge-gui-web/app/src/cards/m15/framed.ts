/**
 * What the table needs to put the M15 face behind the 'Framed' art mode: the M15 card for a client face, the cache key of
 * its painted texture, and where the P/T highlight goes over it. No canvas, no Pixi.
 */
import type { Card, CardFace } from '@forge-table/protocol';
import { faceKey } from '../face';
import type { PtTone } from '../pt';
import { chrome } from '../../theme/tokens';
import { ptPlate, ptText, toCardRect } from './layouts';
import { blankCard, fromClientFace, type M15Card } from './model';
import type { Rect } from './geometry';
import type { AbilityFace } from '../../layout/stack';

/** The M15 card a client face is drawn as; the artist is the crop's credit (the wire carries none). */
export function framedCard(face: CardFace, card: Pick<Card, 'token'> | undefined, artist: string | null | undefined): M15Card {
  const m = fromClientFace(face, card);
  m.artist = artist ?? '';
  return m;
}

/**
 * The M15 card an ability card on the stack is drawn as (Framed mode): its source's frame, name and art, "Triggered
 * Ability" / "Activated Ability" on the type line and the ability's text in the box. No cost, P/T or loyalty: the card
 * is the ability, not the permanent. A hidden source gives a colourless frame with the ability's own name.
 */
export function framedAbility(face: AbilityFace, source: Pick<Card, 'state' | 'token'> | undefined, artist: string | null | undefined): M15Card {
  const m = source?.state ? fromClientFace(source.state, source) : blankCard();
  // An ability card is never a token's own tall-art frame, even when its source is a token permanent: it is the
  // ability, not the token, and reads normally (a triggered ability off a token looked the same as its card).
  return { ...m, name: face.name, manaCost: '', typeLine: `${face.kind} Ability`, rules: face.text, flavor: '', power: '', toughness: '', loyalty: '', defense: '', produced: '', artist: artist ?? '', token: false };
}

/**
 * The M15 card one option of a choice is drawn as (overlays/optionFaces.ts): its source card as printed (frame, name,
 * cost, type line, P/T), with only the option's text in the box and, for an alternative cost, that cost on the plate.
 */
export function framedOption(face: CardFace, card: Pick<Card, 'token'> | undefined, text: string, cost: string | undefined, artist: string | null | undefined): M15Card {
  return { ...fromClientFace(face, card), rules: text, flavor: '', ...(cost !== undefined ? { manaCost: cost } : {}), artist: artist ?? '' };
}

/** The texture cache key of a framed face (apart from the plain procedural face's); `crop` = the image key of the art drawn in it. */
export function framedKey(face: CardFace, card: Pick<Card, 'token'> | undefined, crop: string | undefined, artist?: string | null): string {
  return ['m15', faceKey(face, card, crop), (face.keywords ?? []).map((k) => k.title).join(','), artist ?? ''].join('\u0001');
}

/**
 * The P/T plate on a card `w`×`h` (origin at the card's centre) and the stroke colour of its highlight for a current P/T
 * that differs from the printed one: the face prints the current numbers itself, the highlight says they changed.
 */
export function ptHighlight(card: Pick<M15Card, 'typeLine' | 'power' | 'toughness' | 'defense'>, tone: PtTone, w: number, h: number): { rect: Rect; color: string } {
  return { rect: toCardRect(ptPlate(card, ptText(card)), w, h), color: PT_TONE[tone] };
}

/** The highlight colours, as the table's P/T chip inks them: success / danger / warning, plain text for a P/T set by a rule. */
export const PT_TONE: Record<PtTone, string> = { up: chrome.success, down: chrome.danger, mixed: chrome.warning, set: chrome.text };
