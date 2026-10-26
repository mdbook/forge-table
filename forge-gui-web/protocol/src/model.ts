/**
 * Forge Table protocol v1: the projected game model.
 *
 * Hand-written from forge-gui-bridge's ViewProjector / ViewCodec. A generated, exhaustive list of
 * TrackableProperty keys will land in `generated/props.ts`; until then every object also admits unknown
 * extra keys, because the codec sends every encodable property it finds.
 *
 * Conventions:
 * - Defaults (false / 0 / '') are omitted on the wire, so every flag is optional.
 * - Card ids: `c<id>` a visible card; `f<hiddenId>` a face-down card the viewer may not identify;
 *   `x…` an opaque slot in a hidden zone (only ever inside zone lists; there's no card object).
 * - Player ids: `p<id>` (the viewer is usually `p0`, but never assume it; use `snapshot.viewer`).
 */

export type CardId = string;
export type PlayerId = string;

/** Engine `PhaseType` names. */
export type Phase =
  | 'UNTAP'
  | 'UPKEEP'
  | 'DRAW'
  | 'MAIN1'
  | 'COMBAT_BEGIN'
  | 'COMBAT_DECLARE_ATTACKERS'
  | 'COMBAT_DECLARE_BLOCKERS'
  | 'COMBAT_FIRST_STRIKE_DAMAGE'
  | 'COMBAT_DAMAGE'
  | 'COMBAT_END'
  | 'MAIN2'
  | 'END_OF_TURN'
  | 'CLEANUP';

/** Engine `ZoneType` names as they appear in beats (`from` / `to`) and on `Card.zone`. */
export type ZoneName =
  | 'Library'
  | 'Hand'
  | 'Battlefield'
  | 'Graveyard'
  | 'Exile'
  | 'Stack'
  | 'Command'
  | 'Sideboard'
  | 'Ante'
  | 'Flashback'
  | 'PlanarDeck'
  | 'SchemeDeck'
  | 'AttractionDeck'
  | 'ContraptionDeck'
  | 'Junkyard'
  | 'None'
  | (string & {});

/** Keys of `Player.zones` (lowerCamelCase of the TrackableProperty). */
export type PlayerZoneKey =
  | 'hand'
  | 'library'
  | 'graveyard'
  | 'battlefield'
  | 'exile'
  | 'command'
  | 'sideboard'
  | 'ante'
  | 'flashback'
  | 'planarDeck'
  | 'schemeDeck'
  | 'attractionDeck'
  | 'contraptionDeck'
  | 'junkyard';

export interface CardType {
  super: string[];
  core: string[];
  sub: string[];
}

export interface Keyword {
  title: string;
  reminder?: string;
}

/** One face of a card (`CardStateView`). */
export interface CardFace {
  /** `CardStateName`: Original, Transformed, Flipped, LeftSplit, … */
  face: string;
  name?: string;
  /** Forge mana-cost text, e.g. `{1}{R}` or `{B/G/P}`. Omitted for no cost. */
  manaCost?: string;
  type?: CardType;
  oracleText?: string;
  rulesText?: string;
  abilityText?: string;
  power?: number;
  toughness?: number;
  /** Printed P/T from the card's rules; omitted for `*` and for faces with no rules (most tokens). */
  printedPower?: number;
  printedToughness?: number;
  /**
   * True when the face's printed power or toughness is not a plain integer (`*`, `1+*`, `*+1`, `X`…; a characteristic-
   * defining P/T). The art shows no number then, so the client always shows the current P/T chip. Omitted otherwise.
   */
  printedPtVaries?: boolean;
  /** Loyalty and defense arrive as strings ("0" when not applicable). */
  loyalty?: string;
  defense?: string;
  /** Colors as WUBRG letters, '' (omitted) for colorless. */
  colors?: string;
  imageKey?: string;
  setCode?: string;
  rarity?: string;
  keywords?: Keyword[];
  [extra: string]: unknown;
}

export interface Card {
  id: CardId;
  zone?: ZoneName;
  controller?: PlayerId;
  owner?: PlayerId;
  tapped?: boolean;
  sickness?: boolean;
  attacking?: boolean;
  blocking?: boolean;
  facedown?: boolean;
  token?: boolean;
  damage?: number;
  counters?: Record<string, number>;
  attachedCards?: CardId[];
  entityAttachedTo?: CardId | PlayerId;
  phasedOut?: boolean;
  /** A commander (Brawl). */
  isCommander?: boolean;
  /** This viewer's own hand card has been shown to an opponent (e.g. Duress) and hasn't left hand since. */
  revealedToOpponent?: boolean;
  /** What kind of game piece: `EFFECT` (an effect or emblem in the command zone), `DUNGEON`, `TOKEN`, `CARD`… */
  gamePieceType?: string;
  /** An effect card that is a planeswalker emblem. */
  isEmblem?: boolean;
  /** A dungeon: the room its owner is in. */
  currentRoom?: string;
  state?: CardFace;
  alt?: CardFace;
  left?: CardFace;
  right?: CardFace;
  [extra: string]: unknown;
}

export type PlayerZones = Partial<Record<PlayerZoneKey, CardId[]>> & Record<string, CardId[] | undefined>;

export interface Player {
  id: PlayerId;
  name?: string;
  lobbyPlayerName?: string;
  life: number;
  isAI?: boolean;
  hasPriority?: boolean;
  hasLost?: boolean;
  counters?: Record<string, number>;
  /** Floating mana by color letter (W U B R G C). */
  mana?: Record<string, number>;
  maxHandSize?: number;
  zones: PlayerZones;
  /** Brawl: the player's commander(s), wherever they are now (the command zone is `zones.command`). */
  commander?: CardId[];
  /**
   * Brawl: how often each commander has been cast from the command zone, keyed by the bare engine id (`"123"` for
   * card `c123`). Commander tax is 2 per cast.
   */
  commanderCast?: Record<string, number>;
  [extra: string]: unknown;
}

export interface StackItem {
  id: string;
  text: string;
  source?: CardId;
  activator?: PlayerId;
  ability: boolean;
  trigger: boolean;
  optionalTrigger?: boolean;
  targets: string[];
}

export interface CombatBand {
  attacker: CardId;
  defender?: CardId | PlayerId;
  blockers: CardId[];
  planned?: CardId[];
}

export interface Game {
  turn?: number;
  phase?: Phase;
  playerTurn?: PlayerId;
  priority?: PlayerId;
  gameOver?: boolean;
  matchOver?: boolean;
  winningPlayerName?: string;
  mulligan?: boolean;
  stack: StackItem[];
  combat?: CombatBand[];
  [extra: string]: unknown;
}

/** Object-level replacement patch. `cards[id] = null` removes the card. */
export interface Patch {
  game?: Game;
  players?: Record<PlayerId, Player>;
  cards?: Record<CardId, Card | null>;
}

/** A full model as held by a client store. */
export interface GameModel {
  game: Game;
  players: Record<PlayerId, Player>;
  cards: Record<CardId, Card>;
}

/** A zone reference inside beats: `{player, zone}` (player omitted for the shared stack). */
export interface ZoneRef {
  player?: PlayerId;
  zone?: ZoneName;
}

/** Whether a client id is an opaque hidden-zone slot (no card object, render a card back). */
export function isHiddenSlot(id: string): boolean {
  return id.startsWith('x');
}
