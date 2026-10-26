/**
 * Human-vs-human, table side: what the start screen says while both players pick a
 * deck, the "opponent disconnected" banner with its Claim win countdown, and when to show "Waiting for {name}…".
 * No React here; the server's messages are in protocol `PvpLobbyMsg` / `PvpPresenceMsg`.
 */
import type { Phase, PlayerId, PromptKind, PvpPresence, PvpWelcome } from '@forge-table/protocol';

/** What the HUD keeps of the `pvp` messages. Null in a game against the AI. */
export interface PvpState {
  lobby: PvpWelcome;
  /** The latest presence message (null until the server sends one). */
  presence: PvpPresence | null;
}

/** The server unlocks Claim win this long after the opponent left (contract: 120 s). */
export const CLAIM_AFTER_MS = 120_000;

// ------------------------------------------------------------------------------------------ start screen

export interface PvpStartView {
  headline: string;
  detail: string | null;
  /** Both players have chosen: the match is about to start. */
  starting: boolean;
  /** Who has chosen a deck, once both are here. */
  ticks: Array<{ name: string; ready: boolean }>;
  /** The opponent left after the game: no rematch, Ready is off and Leave is the way out. */
  left?: boolean;
}

/** The start screen's status block for a PvP game: who is here, who has chosen a deck, and a rematch's answer. */
export function pvpStartView(l: PvpWelcome): PvpStartView {
  if (l.opponent === null) {
    return { headline: 'Waiting for your opponent…', detail: 'They show up here once they open the game.', starting: false, ticks: [] };
  }
  if (l.oppLeft) return { headline: `${l.opponent} left`, detail: 'No rematch this time. Leave goes back to the lobby.', starting: false, ticks: [], left: true };
  const ticks = [{ name: 'You', ready: l.youReady }, { name: l.opponent, ready: l.oppReady }];
  if (l.youReady && l.oppReady) return { headline: 'Starting the match…', detail: null, starting: true, ticks };
  if (l.rematch && !l.oppRematch) {
    return {
      ticks,
      headline: `Rematch: waiting for ${l.opponent}…`,
      detail: l.youReady ? `${l.opponent} hasn't said yes yet. You can still change your deck.` : `${l.opponent} hasn't said yes yet. Keep your deck or pick another, then Ready.`,
      starting: false,
    };
  }
  if (l.rematch && !l.youReady) {
    return {
      ticks,
      headline: `${l.opponent} is up for a rematch`,
      detail: l.oppReady ? `${l.opponent} is ready. Keep your deck or pick another, then Ready.` : 'Keep your deck or pick another, then Ready.',
      starting: false,
    };
  }
  if (l.youReady) return { headline: `Waiting for ${l.opponent}…`, detail: `${l.opponent} is choosing a deck.`, starting: false, ticks };
  return {
    ticks,
    headline: `${l.opponent} has joined`,
    detail: l.oppReady ? `${l.opponent} is ready. Choose your deck.` : 'Choose your deck.',
    starting: false,
  };
}

/** The Ready button's face: "Ready", "Ready ✓" once sent (disabled), "Change deck" when the pick differs from what was sent. */
export function readyButton(youReady: boolean, picked: string | undefined, sent: string | undefined, starting: boolean): { label: string; enabled: boolean } {
  if (!youReady) return { label: starting ? 'Starting…' : 'Ready', enabled: !starting };
  const changed = picked !== undefined && picked !== sent;
  return changed ? { label: starting ? 'Starting…' : 'Change deck', enabled: !starting } : { label: 'Ready ✓', enabled: false };
}

// ------------------------------------------------------------------------------------------ game over

/** The PvP game-over panel's line about a rematch (null: nothing to say yet) and whether Rematch is offered. */
export function rematchView(l: PvpWelcome | null): { note: string | null; offer: boolean } {
  const name = l?.opponent ?? 'Your opponent';
  if (l?.oppLeft) return { note: `${name} left. No rematch this time.`, offer: false };
  if (l?.oppRematch) return { note: `${name} wants a rematch.`, offer: true };
  return { note: null, offer: true };
}

// ------------------------------------------------------------------------------------------ disconnects

export interface AwayView {
  text: string;
  /** "Claim win unlocks in 1:23", or null once it is claimable. */
  countdown: string | null;
  claimable: boolean;
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The disconnect banner, or null while the opponent is here (or the game is over). `now` is the browser's clock
 * against the server's `claimableAt`; the server decides anyway (an early claim is ignored with a toast). No
 * `claimableAt` = the game isn't dealt yet (coin toss): there is no win to claim, Leave ends the game.
 */
export function awayView(pvp: Pick<PvpState, 'presence'> | null, opponent: string, now: number): AwayView | null {
  const p = pvp?.presence;
  if (!p || p.opponentConnected) return null;
  if (p.claimableAt === undefined) return { text: `${opponent} disconnected, waiting`, countdown: 'Leave ends the game until the cards are dealt', claimable: false };
  const left = p.claimableAt - now;
  return {
    text: `${opponent} disconnected, waiting`,
    countdown: left > 0 ? `Claim win unlocks in ${mmss(left)}` : null,
    claimable: left <= 0,
  };
}

// ------------------------------------------------------------------------------------------ waiting indicator

export interface WaitInput {
  pvp: boolean;
  /** Turn number (0 before the game starts: mulligans). */
  turn: number;
  phase?: Phase | undefined;
  playerTurn?: PlayerId | undefined;
  priority?: PlayerId | undefined;
  viewer: PlayerId;
  promptKind: PromptKind | null;
  /** Blocking asks on screen for me. */
  asks: number;
  gameOver: boolean;
  /** The opponent is disconnected (the banner says so instead). */
  away: boolean;
}

/**
 * "Waiting for {opponent}…": a PvP game where I have nothing to do (no prompt, or the bare waiting bar) and the
 * opponent is the one deciding: they hold priority, are declaring attackers or blockers, or are still on the
 * mulligan. Derived from the state already on the wire; no message of its own.
 */
export function waitingOnOpponent(w: WaitInput): boolean {
  if (!w.pvp || w.gameOver || w.away || w.asks > 0) return false;
  if (w.promptKind !== null && w.promptKind !== 'waiting') return false;
  if (w.turn === 0) return w.promptKind === 'waiting';
  if (w.priority !== undefined) return w.priority !== w.viewer;
  const theirTurn = w.playerTurn !== undefined && w.playerTurn !== w.viewer;
  if (w.phase === 'COMBAT_DECLARE_ATTACKERS') return theirTurn;
  if (w.phase === 'COMBAT_DECLARE_BLOCKERS') return !theirTurn && w.playerTurn !== undefined;
  return false;
}
