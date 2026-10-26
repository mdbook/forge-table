/**
 * Forge Table protocol v1 messages, matching forge-gui-bridge as implemented.
 * Every message is `{t: '<type>', …}`; state-changing server messages carry a strictly increasing `seq`.
 */
import type { CardFace, CardId, Game, Patch, Phase, Player, PlayerId, ZoneRef, Card } from './model';

export const PROTOCOL_VERSION = 1;

// ------------------------------------------------------------------------------------------ C → S

export interface ClientInfo {
  /** Motion speed multiplier (0.5, 1, 1.5, 2). 0 = Instant: the server never paces. */
  speed: number;
  reducedMotion: boolean;
  /** Wall time each beat kind takes at 1x, in ms. The Pacer divides by `speed`. */
  beatCosts: Record<string, number>;
  /** Auto-skip: pass every priority where nothing but mana abilities can be used. Absent means on. */
  autoSkip?: boolean;
}

export interface HelloMsg {
  t: 'hello';
  proto: number;
  token: string;
  client: ClientInfo;
  /** Stamped by the router on every hello (a game between two people: 0 or 1); a client never sends it. */
  seat?: number;
  /** Stamped by the router: the member's display name; a client never sends it. */
  name?: string;
}

export interface RpcMsg {
  t: 'rpc';
  id: string;
  method: RpcMethod;
  params?: Record<string, unknown>;
}

export type RpcMethod = 'decks.list' | 'decks.problems' | 'ai.profiles' | 'match.start' | 'match.leave' | 'decks.import';

/**
 * A game's format: `'brawl'` is MTG Arena's Competitive Brawl (100 cards with the commander, Arena's pool and bans,
 * 25 life, the first mulligan free). `'standard'` is Constructed with the deck checked against Standard's sets and
 * bans (60 cards, four copies). No format = Constructed, as before.
 */
export type GameFormat = 'brawl' | 'standard';

/**
 * `decks.list {format}` lists the decks for that format (Brawl adds the shared Brawl decks); `decks.problems {format}`
 * answers {@link DeckProblems}. Behind the router, or in pvp, the game's own format wins over the one asked for.
 */
export interface DecksParams {
  format?: GameFormat;
}

/** `decks.problems`: deck name → why it can't be played in the format. Decks that can are absent. */
export type DeckProblems = Record<string, string>;

export interface MatchStartParams {
  deck?: string;
  /** Brawl: none = a legal shared Brawl deck at random. */
  oppDeck?: string;
  /** `deck` was picked as "Random deck": on Rematch the bridge re-rolls it instead of replaying it. */
  deckRandom?: boolean;
  /** Same as {@link deckRandom}, for `oppDeck`. */
  oppDeckRandom?: boolean;
  ai?: string;
  /** Only a local sidecar takes it; a router-hosted game plays the format it was created with. */
  format?: GameFormat;
}

/** A pvp seat's `match.start` answers `{deck}` only (no AI, the opponent is the other seat). */
export interface MatchStartResult {
  deck: string;
  oppDeck?: string;
  ai?: string;
  format?: GameFormat;
}

/**
 * `decks.import`: a pasted list (Arena / MTGO / Moxfield exports, `.dck` content) in `text`, or a deck link
 * (Moxfield, Archidekt, TappedOut, MTGGoldfish) in `url` that the server fetches. `dryRun` parses without
 * saving. A failure arrives as an rpc error with a human-readable message.
 */
export interface DeckImportParams {
  text?: string;
  url?: string;
  name?: string;
  dryRun?: boolean;
}

export interface DeckImportResult {
  /** The deck's name (made unique server-side); after a save, `decks.list` includes it. */
  name: string;
  saved: boolean;
  /** Card counts in the main deck and sideboard. */
  main: number;
  side: number;
  /** Commander-zone cards, when the list has any. */
  commander?: number;
  /** Cards recognized in total. */
  recognized: number;
  /** Input lines that matched no card. */
  unknown: string[];
  warnings: string[];
  /** Every recognized card, for the live preview. */
  cards?: ImportedCard[];
  /** Unknown line → the nearest real card name, for a one-click "did you mean". */
  fixes?: Record<string, string>;
  /** The commander's colour identity, WUBRG order ("" for colourless); only with a commander. */
  identity?: string;
  /** Why the list isn't a legal Brawl deck (Forge's own text); absent when it is, or has no commander. */
  brawlProblem?: string;
}

export interface ImportedCard {
  n: number;
  name: string;
  section: 'main' | 'side' | 'commander';
  /** The preview group: Creature, Planeswalker, Battle, Instant, Sorcery, Land, Artifact, Enchantment or Other. */
  type: string;
  cmc: number;
}

export interface ReplyMsg {
  t: 'reply';
  id: string;
  value: unknown;
}

/** Input-scoped acts: must carry the pid of the prompt on screen (dropped with `notice{stale}` otherwise). */
export type InputAct =
  | { t: 'act'; pid: number; kind: 'ok' }
  | { t: 'act'; pid: number; kind: 'cancel' }
  | { t: 'act'; pid: number; kind: 'card'; card: CardId }
  | { t: 'act'; pid: number; kind: 'player'; player: PlayerId }
  | { t: 'act'; pid: number; kind: 'mana'; color: string }
  | { t: 'act'; pid: number; kind: 'alphaStrike' }
  /** declareBlockers: `blocker` blocks `attacker` (one step on the server; Forge still validates). */
  | { t: 'act'; pid: number; kind: 'block'; blocker: CardId; attacker: CardId }
  /** declareBlockers: `blocker` stops blocking (whatever it blocks). */
  | { t: 'act'; pid: number; kind: 'unblock'; blocker: CardId }
  /** declareAttackers: `attacker` attacks `defender` (a player, planeswalker or battle), declaring or moving it. */
  | { t: 'act'; pid: number; kind: 'attack'; attacker: CardId; defender: CardId | PlayerId }
  | { t: 'act'; pid: number; kind: 'undo' };

export type NextGameDecision = 'NEW' | 'CONTINUE' | 'QUIT';

/** Session-scoped acts (no pid). */
export type SessionAct =
  | { t: 'act'; kind: 'concede' }
  | { t: 'act'; kind: 'nextGame'; decision: NextGameDecision }
  | { t: 'act'; kind: 'skipAnim' }
  | { t: 'act'; kind: 'speed'; value: number }
  | { t: 'act'; kind: 'phaseStop'; player: PlayerId; phase: Phase; stop: boolean }
  | { t: 'act'; kind: 'autoSkip'; on: boolean }
  | { t: 'act'; kind: 'snooze'; card: CardId; on: boolean }
  /** Auto-resolve: pass priority whenever the top of the stack is mine (my spell, or my ability or trigger). */
  | { t: 'act'; kind: 'autoResolve'; on: boolean }
  /** Answer this optional trigger (a prompt's `triggerKey`, or an `AutoPassState.answers` key) the same way from now on; `ask` stops. */
  | { t: 'act'; kind: 'triggerAnswer'; key: string; decision: TriggerDecision | 'ask' }
  /**
   * Loop shortcut: `record` remembers what I do from now on; `done` stops and repeats it `times` more times (1-999),
   * `repeat` repeats the last recording again; `cancel` drops a recording, an offer or a loop that's playing. Against
   * a person the repeat is offered to them first (`AutoPassState.opponentLoop` on their side).
   */
  | { t: 'act'; kind: 'loop'; op: 'record' | 'done' | 'repeat' | 'cancel'; times?: number }
  /**
   * Answer the opponent's offered loop (`offerId` from their `LoopState`, so a late click can't answer a newer offer):
   * accept it, or only the first `stopAfter` repeats; `accept: false` to respond instead.
   */
  | { t: 'act'; kind: 'loopAnswer'; offerId: number; accept: boolean; stopAfter?: number }
  /** A game between two people: the opponent has been away for 2 minutes; they concede (refused with a toast before). */
  | { t: 'act'; kind: 'claimWin' }
  /** Pass priority until end of turn (Forge's End Turn yield), or `clear` to stop any yield. */
  | { t: 'act'; kind: 'yield'; until: 'endOfTurn' | 'stackEmpty' }
  | { t: 'act'; kind: 'yield'; clear: true };

export type ActMsg = InputAct | SessionAct;

export interface AckMsg {
  t: 'ack';
  playedSeq: number;
  backlogMs: number;
  hidden: boolean;
}

export type ClientMessage = HelloMsg | RpcMsg | ReplyMsg | ActMsg | AckMsg;

// ------------------------------------------------------------------------------------------ S → C

export interface WelcomeMsg {
  t: 'welcome';
  proto: number;
  session: string;
  forgeVersion: string;
  features: string[];
  /** A match is already running (the snapshot follows). */
  match: boolean;
  /** The running match's AI profile ("Neural", "Default"), as `match.start` answered it. Absent between people. */
  ai?: string;
  /** `ai` is "Neural" when the Neural seat can run (see `neural`), else "Default". */
  defaults: { deck?: string; oppDeck?: string; ai: string };
  /** The game's format when it was set for this sidecar (`--format`, the lobby's choice); absent = Constructed. */
  format?: GameFormat;
  /** Whether the Neural AI can run in this sidecar. Absent in replay fixtures recorded before it existed. */
  neural?: NeuralStatus;
  /** A packaged build: its fork commit (8 hex) and when it was built (ISO). Absent in a dev run. */
  build?: { sha: string; builtAt: string };
  /** Present only in a game between two people: this socket's seat and the start-screen lobby state. */
  pvp?: PvpWelcome;
}

/** A game between two people, as `welcome.pvp`. `opponent` is null until the other seat has connected once. */
export interface PvpWelcome {
  seat: 0 | 1;
  you: string;
  opponent: string | null;
  oppReady: boolean;
  youReady: boolean;
  /** After a game: a rematch is being set up (both pick a deck again, as for the first game). */
  rematch?: boolean;
  /** After a game: the opponent asked for (or said yes to) a rematch. */
  oppRematch?: boolean;
  /** After a game: the opponent pressed Leave, so there is no rematch. */
  oppLeft?: boolean;
  /** A saved game picked up after a restart: it goes on by itself once both are here (no deck to pick). */
  resuming?: boolean;
}

/**
 * Start screen of a game between two people: sent to each seat on every change until the match starts, and after a
 * game while a rematch is asked for, set up, or turned down (Leave).
 */
export interface PvpLobbyMsg {
  t: 'pvp';
  kind: 'lobby';
  you: string;
  opponent: string | null;
  oppReady: boolean;
  youReady: boolean;
  rematch?: boolean;
  oppRematch?: boolean;
  oppLeft?: boolean;
  resuming?: boolean;
}

/**
 * Whether the other seat is connected, since when (epoch ms of the change), and, while it is away during a match, when
 * Claim win unlocks (epoch ms).
 */
export interface PvpPresence {
  opponentConnected: boolean;
  since: number;
  claimableAt?: number;
}

/** Sent to a seat whenever either seat connects or leaves. */
export interface PvpPresenceMsg extends PvpPresence {
  t: 'pvp';
  kind: 'presence';
}

export type PvpMsg = PvpLobbyMsg | PvpPresenceMsg;

export interface NeuralStatus {
  ok: boolean;
  /** What the UI calls the Neural AI (the server's FT_NEURAL_LABEL, default "Neural"). Absent from older sidecars. */
  label?: string;
  /** True when the server has a picture of the Neural AI (FT_NEURAL_AVATAR), served at `img/avatar/neural`. */
  avatar?: boolean;
  /** Why it is unavailable (when `ok` is false). */
  reason?: string;
  /** False when no Neural AI plugin is installed at all: the UI doesn't offer Neural. Absent: installed. */
  plugin?: false;
  /** The decks the model was trained to pilot, strongest first; only ones in this sidecar's deck list. */
  decks?: string[];
  /** The model's version, and its release date (ISO) when the release says. */
  version?: number;
  releasedAt?: string;
}

export interface RpcResultMsg {
  t: 'rpcResult';
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Phase stops per player: `{p0: ['MAIN1', …]}`. */
export type StopTable = Record<PlayerId, Phase[]>;

/**
 * The phase strip's auto-pass chips, as the bridge applies them. `autoSkip` is the viewer's toggle;
 * `untilEndOfTurn` is on while priority is being passed to the end of the turn. Forge turns it off at cleanup,
 * and earlier when an opponent casts a spell or attacks you (its YIELD_INTERRUPT_* preferences).
 */
export interface AutoPassState {
  autoSkip: boolean;
  untilEndOfTurn: boolean;
  /** Cards the viewer snoozed (act snooze): auto-skip doesn't count them as something to do. */
  snoozed?: CardId[];
  /** Auto-resolve (act autoResolve): priority passes while the top of the stack is the viewer's own. Off until turned on. */
  autoResolve?: boolean;
  /** Optional triggers answered without asking (act triggerAnswer), by key. Kept for the match. */
  answers?: TriggerAnswer[];
  /** My loop shortcut (act loop), absent when there's none going. */
  loop?: LoopState;
  /** A game between two people: the opponent's loop, while it's offered to me or playing after I accepted it. */
  opponentLoop?: LoopState;
}

/**
 * A loop shortcut. `recording`: `steps` actions so far. `offered`: waiting on the opponent to accept `times` more
 * repeats of `steps` actions, `offerId` naming this offer. `playing`: repeat `iteration` of `of`.
 */
export interface LoopState {
  state: 'recording' | 'offered' | 'playing';
  steps?: number;
  times?: number;
  offerId?: number;
  iteration?: number;
  of?: number;
}

export type TriggerDecision = 'accept' | 'decline';

/**
 * An optional trigger always answered the same way. `key` is Forge's: the trigger's text, prefixed with
 * "Card Name (id=N): " when the answer is for that one card only.
 */
export interface TriggerAnswer {
  key: string;
  decision: TriggerDecision;
}

export interface SnapshotMsg {
  t: 'snapshot';
  seq: number;
  viewer: PlayerId;
  game: Game;
  players: Record<PlayerId, Player>;
  cards: Record<CardId, Card>;
  /** The prompt bar on screen, without `t`/`seq`. */
  prompt?: PromptBody;
  /** Outstanding blocking prompts, bottom to top. */
  asks: AskMsg[];
  stops: StopTable;
  /** Absent in replay fixtures recorded before it existed. */
  autoPass?: AutoPassState;
  gameOver?: GameOverMsg;
  /** A game between two people: the other seat's presence. */
  presence?: PvpPresence;
}

/**
 * One engine event. Event fields are the engine record's components with view refs replaced: cards by
 * client ids, players by `p<id>`, zones by `{player, zone}`. Zone-change beats add `fromId`.
 */
export interface BeatMsg {
  t: 'beat';
  seq: number;
  kind: BeatKind;
  patch?: Patch;
  card?: CardId;
  fromId?: CardId;
  from?: ZoneRef;
  to?: ZoneRef;
  [field: string]: unknown;
}

/** Known beat kinds; anything else just applies its patch. */
export type BeatKind =
  | 'draw' | 'toStack' | 'etb' | 'token' | 'dies' | 'discard' | 'mill' | 'toGraveyard' | 'exile'
  | 'bounce' | 'toHand' | 'toLibrary' | 'move' | 'tap' | 'untap' | 'cast' | 'activate' | 'resolve'
  | 'fizzle' | 'removeFromStack' | 'life' | 'damage' | 'turn' | 'phase' | 'priority' | 'attack'
  | 'block' | 'combatChanged' | 'combatEnded' | 'shuffle' | 'counters' | 'attach' | 'stats' | 'log'
  | 'gameOver' | 'gameFinished' | 'gameStarted' | 'landPlayed' | 'manaPool' | 'zone' | 'flipCoin'
  | 'mulligan' | 'playerControl' | 'turnEnded' | 'cardSacrificed' | 'poison'
  | (string & {});

export interface SettleMsg {
  t: 'settle';
  seq: number;
  patch: Patch;
}

export type PromptKind =
  | 'priority' | 'mulligan' | 'mulliganTuck' | 'confirm' | 'declareAttackers' | 'declareBlockers'
  | 'chooseTargets' | 'payMana' | 'convoke' | 'selectEntities' | 'startingHand' | 'waiting' | 'generic'
  | (string & {});

export interface ButtonState {
  label: string;
  enabled: boolean;
}

/** The prompt bar (an Input on screen). */
export interface PromptBody {
  pid: number;
  kind: PromptKind;
  seat?: PlayerId;
  message: string;
  card?: CardId;
  ok: ButtonState;
  cancel: ButtonState;
  focusOk: boolean;
  selectable: CardId[];
  selMin?: number;
  selMax?: number;
  highlighted: string[];
  weak: Record<CardId, number>;
  /** Spells in my hand that cost other than printed right now (cost reducers, taxes): card → cost, e.g. "{2}{U}". */
  costs?: Record<CardId, string>;
  canUndo?: boolean;
  /** declareBlockers: each creature I can block with → the attackers it can legally block right now. */
  blockable?: Record<CardId, CardId[]>;
  /** declareAttackers: the defenders (players, planeswalkers, battles) an attack can go to. */
  defenders?: (CardId | PlayerId)[];
  /**
   * payMana: exactly one set of my mana sources can pay what's left (one tap, one mana each; no floating mana, X,
   * Phyrexian, snow, Treasure-style or painland choices), so Auto (`ok`) can only tap those. The client may press
   * Auto for the player (settings: auto-pay when there's only one way). Absent = there's a choice, or an old bridge.
   */
  unambiguous?: boolean;
  /**
   * confirm: the question is whether to use an optional triggered ability, and this is its key. Act
   * `triggerAnswer` with it answers that trigger the same way from now on (Always yes / Always no).
   */
  triggerKey?: string;
}

export interface PromptMsg extends PromptBody {
  t: 'prompt' | 'promptUpdate';
  seq: number;
}

export interface PromptClearMsg {
  t: 'promptClear';
  seq: number;
  pid: number;
}

export interface AskItem {
  idx: number;
  label: string;
  card?: CardId;
  /** A card outside every zone (e.g. a card-name choice), sent inline. */
  cardData?: { state?: CardFace };
  /** A card-name choice (name a card): the name's type line. */
  sub?: string;
  player?: PlayerId;
  enabled?: boolean;
}

interface AskBase {
  t: 'ask';
  seq: number;
  id: string;
  /** The Input pid that spawned it (absent when raised off the GUI thread). */
  pid?: number;
  /** Set on a re-ask after an invalid reply. */
  error?: string;
  title?: string;
  message?: string;
}

export interface ChooseAsk extends AskBase {
  kind: 'choose' | 'ability';
  items: AskItem[];
  min: number;
  max: number;
  reveal?: boolean;
  selected?: number[];
  card?: CardId;
}

export interface OrderAsk extends AskBase {
  kind: 'order';
  items: AskItem[];
  min: number;
  max: number;
  ordered: true;
  selected?: number[];
  remember?: boolean;
  card?: CardId;
}

/**
 * Scry: each item goes to the top or the bottom of the library (only the lanes allowed). Reply
 * `{top: idx[], bottom: idx[]}`, every item exactly once, each lane listed from the top of the library down.
 * Surveil (`graveyard`): the lanes are top and graveyard instead; reply `{top: idx[], graveyard: idx[]}`.
 */
export interface ArrangeAsk extends AskBase {
  kind: 'arrange';
  items: AskItem[];
  top: boolean;
  bottom: boolean;
  graveyard?: boolean;
}

/**
 * Combat damage assignment or an amount split: divide `amount` among the items, a whole number each. Reply `number[]`, one per
 * item in item order, adding up to `amount`; or `null` to skip (assign another attacker first) when `skip`.
 * - `rule`: `inOrder` (an item takes damage only once every earlier one has its `lethal`), `lethalFirst` (the
 *   defender, the last item when `defender`, only once every blocker has lethal) or `free`.
 * - `lethal` (combat only): the damage each item needs to be destroyed, or the defender to lose.
 * - `min` / `max` per item; absent means 0 / no limit.
 */
export interface SplitAsk extends AskBase {
  kind: 'split';
  items: AskItem[];
  amount: number;
  label: string;
  rule: 'inOrder' | 'lethalFirst' | 'free';
  lethal?: number[];
  min?: number[];
  max?: number[];
  defender?: boolean;
  skip?: boolean;
  card?: CardId;
}

export interface ConfirmAsk extends AskBase {
  kind: 'confirm' | 'options';
  options: string[];
  default: number;
  card?: CardId;
  /** The card's face when the client has no card for it (a library card in scry 1 / surveil 1). */
  cardData?: { state?: CardFace };
}

export interface TextAsk extends AskBase {
  kind: 'text';
  initial?: string;
  options?: string[];
  numeric: boolean;
}

export type AskMsg = ChooseAsk | OrderAsk | ArrangeAsk | SplitAsk | ConfirmAsk | TextAsk;

export interface AskClearMsg {
  t: 'askClear';
  seq: number;
  id: string;
}

export interface GameOverMsg {
  t: 'gameOver';
  seq: number;
  winner?: string;
  matchOver: boolean;
  gamesPlayed: number;
  gamesInMatch: number;
  won: boolean;
}

export type NoticeMsg =
  | { t: 'notice'; kind: 'toast'; level: 'info' | 'error'; title?: string; message: string }
  | { t: 'notice'; kind: 'stale'; act: unknown; reason: string }
  | { t: 'notice'; kind: 'zones'; show?: ZoneRef[]; hide?: boolean }
  | { t: 'notice'; kind: 'stops'; stops: StopTable }
  | ({ t: 'notice'; kind: 'autoPass' } & AutoPassState)
  | { t: 'notice'; kind: 'flash' }
  | { t: 'notice'; kind: 'alert' }
  | { t: 'notice'; kind: 'clipboard'; text?: string }
  | { t: 'notice'; kind: 'openUrl'; url?: string }
  /** From the multi-game router: the server restarts (and this game ends) in `seconds`. */
  | { t: 'notice'; kind: 'restart'; seconds: number; message?: string }
  | { t: 'notice'; kind: string & {}; [field: string]: unknown };

/** Messages that take a place in the seq order (and so pass through the Director's queue). */
export type SequencedMessage =
  | BeatMsg
  | SettleMsg
  | PromptMsg
  | PromptClearMsg
  | AskMsg
  | AskClearMsg
  | GameOverMsg;

export type ServerMessage =
  | WelcomeMsg
  | RpcResultMsg
  | SnapshotMsg
  | NoticeMsg
  | PvpMsg
  | SequencedMessage;

/** Narrow a decoded message to the ones that carry a seq and so go through the Director. */
export function isSequenced(m: ServerMessage): m is SequencedMessage {
  return (
    m.t === 'beat' || m.t === 'settle' || m.t === 'prompt' || m.t === 'promptUpdate' ||
    m.t === 'promptClear' || m.t === 'ask' || m.t === 'askClear' || m.t === 'gameOver'
  );
}

export type { Card, CardFace, Game, Patch, Player };
