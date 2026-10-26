/**
 * Brawl's command zone, pure functions: whose commanders are where, and commander tax shown as a modified cost
 * ("{2}{R} cast once shows {4}{R}", no "+2" badge). The wire says each player's commanders (`commander`) and how
 * often each was cast from the command zone (`commanderCast`, keyed by the bare engine id: "123" for card "c123").
 */
import type { CardId, GameModel, Player } from '@forge-table/protocol';
import { tokenizeMana } from '../cards/mana';

/** Whether the game has commanders (a Brawl game): a constructed one never does, so its table is unchanged. */
export function hasCommanders(model: GameModel): boolean {
  return Object.values(model.players).some((p) => (p?.commander?.length ?? 0) > 0);
}

/** How often a commander was cast from the command zone (its tax is 2 per cast). */
export function castsOf(player: Player | undefined, id: CardId): number {
  const n = player?.commanderCast?.[id.replace(/^c/, '')] ?? 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The player whose commander this card is, if any. */
export function commanderOwner(model: GameModel, id: CardId): Player | undefined {
  return Object.values(model.players).find((p) => p?.commander?.includes(id));
}

/**
 * A mana cost with `tax` more generic mana: added to its generic number ({2}{R} + 2 = {4}{R}), else a generic
 * symbol goes in after any X ({X}{R} → {X}{2}{R}; {C}{C} → {2}{C}{C}; hybrid symbols stay as they are). No cost
 * (a card that can't be cast) stays none; no tax returns the cost unchanged.
 */
export function taxedCost(cost: string | undefined, tax: number): string | undefined {
  if (!cost || tax <= 0) return cost;
  const tokens = tokenizeMana(cost);
  if (tokens.length === 0) return cost;
  const generic = tokens.findIndex((t) => t.sym.kind === 'generic' && /^\d+$/.test(t.raw.trim()));
  const syms = tokens.map((t) => `{${t.raw}}`);
  if (generic >= 0) syms[generic] = `{${Number(tokens[generic]!.raw.trim()) + tax}}`;
  else {
    const xs = tokens.findIndex((t) => t.sym.kind !== 'variable');
    syms.splice(xs < 0 ? syms.length : xs, 0, `{${tax}}`);
  }
  return syms.join('');
}

/**
 * A commander's cost to cast from the command zone right now, when its tax makes it differ from the printed cost
 * (else undefined: the printed cost shows). `printed` is the face's mana cost.
 */
export function commanderCost(model: GameModel, id: CardId, printed: string | undefined): string | undefined {
  const casts = castsOf(commanderOwner(model, id), id);
  return casts > 0 ? taxedCost(printed, 2 * casts) : undefined;
}
