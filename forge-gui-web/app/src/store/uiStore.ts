import type { Effects } from '../director/director';
/**
 * The HUD's view of the world (Zustand). The frame loop copies the Director's playhead state in here only
 * when it changed (`version`), so React re-renders on game changes, never per frame.
 */
import { create } from 'zustand';
import type {
  AskMsg,
  AutoPassState,
  CardId,
  DeckProblems,
  GameModel,
  GameOverMsg,
  PlayerId,
  PromptBody,
  StopTable,
  WelcomeMsg,
  ZoneRef,
} from '@forge-table/protocol';
import type { ArtMode } from '../config';
import type { CardSize } from '../layout/geometry';
import type { PvpState } from '../hud/pvp';
import type { MullCount } from '../hud/mulligan';
import type { ConnectionStatus } from '../net/source';
import type { ZoneViewRef } from '../overlays/zoneView';
import { NO_PEEK, type PeekState } from '../overlays/peek';
import { emptyModel } from './model';

export interface Toast {
  id: number;
  level: 'info' | 'error';
  title?: string;
  message: string;
  /** Clock time it expires at. */
  until: number;
}

export interface StartInfo {
  decks: string[];
  ais: string[];
  deck?: string;
  oppDeck?: string;
  ai?: string;
  starting: boolean;
  error?: string;
  /** PvP: the deck last sent with match.start (marks me ready). */
  sent?: string;
  /** A format game (Brawl, Standard): the decks that can't be played in it, with why (`decks.problems`). */
  problems?: DeckProblems;
  /** Started with the lobby's New game picks: the loader's "Mono Red Aggro vs Lyra" while it starts. */
  auto?: string;
  /** The lobby's Import: open deck import as soon as the start screen is up. */
  importFirst?: boolean;
}

export interface UiState {
  status: ConnectionStatus;
  welcome: WelcomeMsg | null;
  /** Human vs human: the start screen's players and the opponent's presence. Null against the AI. */
  pvp: PvpState | null;
  /** The AI profile the match is played against (`match.start`'s answer, or the welcome's on a reconnect); else null. */
  matchAi: string | null;
  /** A match is bound (a snapshot arrived and the player hasn't left). */
  inMatch: boolean;
  version: number;
  viewer: PlayerId;
  shown: GameModel;
  prompt: PromptBody | null;
  /** The viewer's mulligans this game and who goes first (director.ts countMulligan). */
  mull: MullCount;
  asks: AskMsg[];
  gameOver: GameOverMsg | null;
  stops: StopTable;
  /** The ladder's auto-pass chips: the viewer's auto-skip toggle (saved) and the bridge's end-of-turn yield. */
  autoPass: AutoPassState;
  /** The pid of the optional-trigger confirm whose "Always answer this way" switch is on; any other pid = off. */
  rememberAnswer: number | null;
  toasts: Toast[];
  /** Bumped on stale / flash notices (a brief edge flash). */
  flash: number;
  zoneStrip: ZoneRef[] | null;
  /** The player put the zone strip away (click-away / Esc / its close button) until the engine shows zones anew. */
  zoneStripDismissed: boolean;
  speed: number;
  /** The card-size setting (geometry.ts CARD_SCALE). */
  cardSize: CardSize;
  reducedMotion: boolean;
  /** The effects setting (director.ts Effects). */
  effects: Effects;
  /** Play time behind the playhead (refreshed a few times a second). */
  backlogMs: number;
  preview: CardId | null;
  /** A touch long press pins a card's preview, with its Snooze button, until the next touch on the table. */
  pinned: CardId | null;
  /** Touch: my hand is raised (a tap on the lowered hand), big enough to read; a tap elsewhere lowers it. */
  handUp: boolean;
  /** Touch: the card last tapped in the raised hand, drawn in front to be read; a second tap plays it. */
  handFocus: CardId | null;
  start: StartInfo;
  test: boolean;
  /** The viewer's card-art preference, and whether the URL allows real art at all (not under test/replay/art=0). */
  artMode: ArtMode;
  artAllowed: boolean;
  /** The graveyard / exile viewer, when open. It never touches the prompt: closing it returns to the table. */
  zoneView: ZoneViewRef | null;
  /** The server restarts at this time (epoch ms, the browser's clock): a countdown banner. */
  restartAt: number | null;
  /** Players whose plates a dragged attacker can be dropped on (arrows/controller.ts). */
  dropPlates: PlayerId[];
  /** The creature picked up to block with (blocker-first, client-side), for the prompt bar's text. */
  aimPicked: CardId | null;
  /** My hand's order as I dragged it (client-side; layout.ts orderHand). */
  handOrder: CardId[];
  /** "Show battlefield": the overlays covering the table, and whether they are put away (overlays/peek.ts). */
  peek: PeekState;
}

export const useUi = create<UiState>(() => ({
  status: 'connecting',
  welcome: null,
  pvp: null,
  matchAi: null,
  inMatch: false,
  version: 0,
  viewer: 'p0',
  shown: emptyModel(),
  prompt: null,
  mull: { count: 0, seat: null },
  asks: [],
  gameOver: null,
  stops: {},
  autoPass: { autoSkip: true, untilEndOfTurn: false },
  rememberAnswer: null,
  toasts: [],
  flash: 0,
  zoneStrip: null,
  zoneStripDismissed: false,
  speed: 1,
  cardSize: 'M',
  reducedMotion: false,
  effects: 'full',
  backlogMs: 0,
  preview: null,
  pinned: null,
  handUp: false,
  handFocus: null,
  start: { decks: [], ais: [], starting: false },
  test: false,
  artMode: 'scryfall',
  artAllowed: false,
  restartAt: null,
  zoneView: null,
  dropPlates: [],
  aimPicked: null,
  handOrder: [],
  peek: NO_PEEK,
}));
