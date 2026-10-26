/**
 * Cards I can cast or play from somewhere other than my hand ("better next-to-hand views of cards we can
 * cast from exile and other places"), MTGA style: they sit in a strip beside the hand, glowing in their zone's colour
 * with the alternate cost in their cost slot. Where each one waits (Graveyard · Flashback, Exile · Foretold…) is a quiet
 * grey line on its preview (hover, or a touch pin; hud/Panels.tsx), never a chip on the table.
 *
 * Pure functions, no wire change: the prompt's `weak` set lists every card I can play or activate right now (any
 * zone); the zone comes from the player's zone lists; the alternate cost is read off the card's own keywords
 * (`Flashback {2}{R}`, `Foretell {R}`, `Plot {1}{R}`…). Playing one sends the same `card` act a hand card does.
 */
import type { Card, CardFace, CardId, GameModel, Phase, PlayerId, PromptBody } from '@forge-table/protocol';
import { knownFace } from '../store/model';
import { commanderCost } from './commander';

/** Which family a card belongs to (its glow's colour, TONE_COLOR). */
export type AltTone = 'graveyard' | 'exile' | 'command' | 'library' | 'foretold' | 'plotted' | 'adventure' | 'warped' | 'suspended' | 'ninja';

export interface AltCard {
  id: CardId;
  /** Where it waits and how it is cast from there ("Graveyard · Flashback"): the grey line on its preview. */
  label: string;
  tone: AltTone;
  /** The alternate cost as Forge mana text ("{2}{R}", "{0}" for free) when the card says it; else the printed one shows. */
  cost?: string;
  /** Waits here but can't be cast now (my Brawl commander in the command zone): dimmed, no glow, its cost still shows. */
  idle?: true;
  /**
   * I snoozed it (autoPass.snoozed): Forge leaves it out of `weak`, so it would drop out of the strip, and that strip card
   * was the only thing to right-click to wake it ("can't unsnooze flashback card"). It stays, frosted, unglowing.
   */
  snoozed?: true;
}

/** The zones a castable card can wait in, in the order the strip lists them. */
const ZONES = ['command', 'graveyard', 'exile', 'library'] as const;
type AltZone = (typeof ZONES)[number];

const ZONE_LABEL: Record<AltZone, string> = { command: 'Command zone', graveyard: 'Graveyard', exile: 'Exile', library: 'Top of library' };
const OPP_ZONE_LABEL: Record<AltZone, string> = { command: "Opponent's command zone", graveyard: "Opponent's graveyard", exile: "Opponent's exile", library: "Top of opponent's library" };

/** The halo's colour per family, for a castable card outside the hand (and the violet of a ninjutsu swap). */
export const TONE_COLOR: Record<AltTone, number> = {
  graveyard: 0xa89be0,
  exile: 0x7ec3ee,
  command: 0xe6b84f,
  library: 0x7fd69a,
  foretold: 0x7ec3ee,
  plotted: 0xf09a6a,
  adventure: 0xeaa05c,
  warped: 0x62e0cf,
  suspended: 0xcf9be8,
  ninja: 0xb06cff,
};

/** The cost that follows a keyword name: `Flashback {2}{R}`, `Escape—{R}{R}, Exile two other cards…`; none for non-mana costs. */
export function keywordCost(face: CardFace | undefined, names: readonly string[]): string | undefined {
  for (const k of face?.keywords ?? []) {
    for (const name of names) {
      const t = k.title;
      if (t.length < name.length || t.slice(0, name.length).toLowerCase() !== name.toLowerCase()) continue;
      const m = /^\s*[—–-]?\s*((?:\{[^}]+\})+)/.exec(t.slice(name.length));
      if (m) return m[1];
    }
  }
  return undefined;
}

/**
 * The cost after a keyword's name as printed when it isn't mana ("Flashback—Sacrifice a Mountain" → "Sacrifice a
 * Mountain"); undefined for a mana cost (see {@link keywordCost}) or none.
 */
export function keywordCostText(face: CardFace | undefined, name: string): string | undefined {
  for (const k of face?.keywords ?? []) {
    const t = k.title;
    if (t.length <= name.length || t.slice(0, name.length).toLowerCase() !== name.toLowerCase()) continue;
    const rest = t.slice(name.length).replace(/^\s*[—–-]?\s*/, '').trim();
    if (rest && !/^\{/.test(rest)) return rest;
  }
  return undefined;
}

/** Whether the face has a keyword by that name (any cost). */
export function hasKeywordNamed(face: CardFace | undefined, name: string): boolean {
  const n = name.toLowerCase();
  return !!face?.keywords?.some((k) => k.title.toLowerCase() === n || k.title.toLowerCase().startsWith(`${n} `) || k.title.toLowerCase().startsWith(`${n}—`));
}

/** Graveyard mechanics whose cost replaces the mana cost, in the order the label names them. */
const GRAVEYARD_HOW = ['Flashback', 'Escape', 'Disturb', 'Retrace', 'Jump-start', 'Unearth', 'Embalm', 'Eternalize', 'Encore', 'Scavenge'] as const;

/** Which zone a card is in, from the player zone lists (the cards' own `zone` is the fallback). */
function zoneIndex(model: GameModel): Map<CardId, { zone: AltZone; owner: PlayerId }> {
  const out = new Map<CardId, { zone: AltZone; owner: PlayerId }>();
  for (const [pid, p] of Object.entries(model.players)) {
    for (const zone of ZONES) for (const id of p.zones?.[zone] ?? []) out.set(id, { zone, owner: pid });
  }
  return out;
}

/** Where a card waiting in `zone` is cast from (its label) and its alternate cost. */
export function describeAlt(id: CardId, card: Card | undefined, zone: AltZone, mine: boolean): AltCard {
  const face = knownFace(card);
  const plain: AltCard = { id, label: (mine ? ZONE_LABEL : OPP_ZONE_LABEL)[zone], tone: zone };
  if (zone === 'graveyard') {
    const how = GRAVEYARD_HOW.find((h) => hasKeywordNamed(face, h));
    if (!how) return plain;
    const cost = keywordCost(face, [how]);
    return { ...plain, label: `${plain.label} · ${how}`, ...(cost ? { cost } : {}) };
  }
  if (zone !== 'exile') return plain;
  const exiled = (how: string) => `${plain.label} · ${how}`;
  // A face-down card in exile that I can look at is a foretold one (Forge's `foretold` flag, or the face-down tell).
  if (card?.foretold === true || (card?.state?.face === 'FaceDown' && face !== card?.state)) {
    const cost = keywordCost(face, ['Foretell']);
    return { id, label: exiled('Foretold'), tone: 'foretold', ...(cost ? { cost } : {}) };
  }
  if (hasKeywordNamed(face, 'Plot')) return { id, label: exiled('Plotted'), tone: 'plotted', cost: '{0}' };
  if (hasKeywordNamed(face, 'Suspend')) {
    const left = card?.counters?.TIME ?? card?.counters?.Time;
    return { id, label: exiled(left ? `Suspended, ${left} time ${left === 1 ? 'counter' : 'counters'}` : 'Suspended'), tone: 'suspended', cost: '{0}' };
  }
  if (hasKeywordNamed(face, 'Warp')) return { id, label: exiled('Warped'), tone: 'warped' };
  if (card?.alt?.type?.sub?.includes('Adventure') && face?.face !== 'FaceDown') return { id, label: exiled('On an adventure'), tone: 'adventure' };
  return plain;
}

/**
 * Every card the prompt marks playable that waits outside my hand, battlefield and the stack: in order (command,
 * graveyard, exile, library; each in its zone's order). Only a priority prompt lists them (a payment or a target
 * prompt's `weak` marks mana sources instead). My snoozed cards in my graveyard or exile that have a way to be cast
 * from there (flashback, plot…) are listed too, flagged `snoozed`, so they can be woken where they were snoozed.
 */
export function altCastables(model: GameModel, viewer: PlayerId, prompt: PromptBody | null, snoozed: readonly CardId[] = []): AltCard[] {
  if (prompt?.kind !== 'priority') return [];
  const weak = prompt.weak ?? {};
  const where = zoneIndex(model);
  const found: Array<{ rank: number; at: number; alt: AltCard }> = [];
  const add = (id: CardId, z: { zone: AltZone; owner: PlayerId }, alt: AltCard) =>
    found.push({ rank: ZONES.indexOf(z.zone), at: (model.players[z.owner]?.zones?.[z.zone] ?? []).indexOf(id), alt });
  for (const id of Object.keys(weak)) {
    if ((weak[id] ?? 0) <= 0 || id.startsWith('x')) continue;
    const z = where.get(id);
    if (!z) continue;
    const alt = describeAlt(id, model.cards[id], z.zone, z.owner === viewer);
    // A commander's cost includes its tax (Brawl: {2} more per earlier cast from the command zone).
    const taxed = z.zone === 'command' ? commanderCost(model, id, knownFace(model.cards[id])?.manaCost) : undefined;
    if (taxed) alt.cost = taxed;
    add(id, z, alt);
  }
  for (const id of snoozed) {
    const z = where.get(id);
    if (!z || z.owner !== viewer || (z.zone !== 'graveyard' && z.zone !== 'exile') || (weak[id] ?? 0) > 0) continue;
    const alt = describeAlt(id, model.cards[id], z.zone, true);
    // A plain dead card (snoozed off the top of the pile) has no way back from there: it stays in its pile.
    if (alt.tone === z.zone && !alt.label.includes(' · ')) continue;
    add(id, z, { ...alt, snoozed: true });
  }
  found.sort((a, b) => a.rank - b.rank || a.at - b.at);
  return found.map((f) => f.alt);
}

/**
 * Brawl ("like flashback or cards casting to exile", never in the hand): my commander waiting in the command
 * zone always sits in the strip, first, with its taxed cost; `alt` (what I can cast now) decides whether it glows or
 * waits dimmed (`idle`). Without a commander waiting, `alt` as is.
 */
export function withMyCommanders(alt: readonly AltCard[], model: GameModel, viewer: PlayerId): readonly AltCard[] {
  const me = model.players[viewer];
  const waiting = (me?.zones?.command ?? []).filter((id) => me?.commander?.includes(id));
  if (waiting.length === 0) return alt;
  const strip = waiting.map((id): AltCard => {
    const castable = alt.find((a) => a.id === id);
    if (castable) return castable;
    const cost = commanderCost(model, id, knownFace(model.cards[id])?.manaCost);
    return { ...describeAlt(id, model.cards[id], 'command', true), ...(cost ? { cost } : {}), idle: true };
  });
  return [...strip, ...alt.filter((a) => !waiting.includes(a.id))];
}

/**
 * While a prompt other than priority is up (paying, choosing targets), the strip keeps what it had, minus the cards that
 * have left their zone (the one being cast is on the stack now), so it doesn't flicker out and back mid-cast.
 */
export function altHeld(prev: readonly AltCard[], model: GameModel): AltCard[] {
  const where = zoneIndex(model);
  return prev.filter((a) => where.has(a.id));
}

// ------------------------------------------------------------------------------------------ ninjutsu / sneak

/** The combat steps where an unblocked attacker can be swapped (ninjutsu: after blockers are declared, until end of combat). */
const SWAP_PHASES: readonly Phase[] = ['COMBAT_DECLARE_BLOCKERS', 'COMBAT_FIRST_STRIKE_DAMAGE', 'COMBAT_DAMAGE', 'COMBAT_END'];

const SWAP_KEYWORDS = [
  { name: 'Commander ninjutsu', label: 'Ninjutsu' },
  { name: 'Ninjutsu', label: 'Ninjutsu' },
  { name: 'Sneak', label: 'Sneak' },
] as const;

export interface SwapCue {
  /** "Ninjutsu" or "Sneak". */
  label: string;
  /** The ninjutsu / sneak cost as Forge mana text. */
  cost?: string;
}

/**
 * A card in my hand that can swap with an unblocked attacker right now (MTGA shows its ninjutsu VFX only when the
 * ability is usable): my turn, the blockers are declared, the prompt marks the card playable and it has Ninjutsu / Sneak.
 */
export function swapCue(model: GameModel, viewer: PlayerId, prompt: PromptBody | null, id: CardId): SwapCue | null {
  if (prompt?.kind !== 'priority' || (prompt.weak?.[id] ?? 0) <= 0) return null;
  if (model.game.playerTurn !== viewer || !model.game.phase || !SWAP_PHASES.includes(model.game.phase)) return null;
  if (!model.players[viewer]?.zones?.hand?.includes(id)) return null;
  const face = model.cards[id]?.state;
  for (const k of SWAP_KEYWORDS) {
    if (!hasKeywordNamed(face, k.name)) continue;
    const cost = keywordCost(face, [k.name]);
    return { label: k.label, ...(cost ? { cost } : {}) };
  }
  return null;
}
