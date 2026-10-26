/**
 * Human-vs-human, lobby side: reading a join link, what a pvp game's row says, the
 * invite's countdown, and the deck chosen here that the game page sends once it opens. No React here.
 */
import { canOpen, type LobbyFormat, type MatchInfo, type MatchPlayer, type NewMatch } from './api';

// ------------------------------------------------------------------------------------------ join links

/** A code is 26-32 URL-safe characters on the wire; be lenient about length, strict about the alphabet. */
const JOIN_PATH = /^\/join\/([A-Za-z0-9_-]{8,64})\/?$/;

/** The invite code in `/join/<code>`, or null when this isn't a join page. */
export function joinCodeFromPath(pathname: string): string | null {
  return JOIN_PATH.exec(pathname)?.[1] ?? null;
}

const GUEST_JOIN_PATH = /^\/g\/join\/([A-Za-z0-9_-]{8,64})\/?$/;

/** The invite code in `/g/join/<code>` (a link that lets guests in), or null. */
export function guestCodeFromPath(pathname: string): string | null {
  return GUEST_JOIN_PATH.exec(pathname)?.[1] ?? null;
}

/**
 * "Play a friend"'s request: guests only when the server offers them and the box is ticked (off by default); `invite` = the
 * "Online now" handle of the person tapped (a direct invite), absent for "Create link"; `format` absent = Constructed.
 */
export function friendMatch(deck: string, listed: boolean, guests: boolean, offered: boolean, invite?: string, format?: LobbyFormat): NewMatch {
  return { mode: 'pvp', deck, listed, ...(offered ? { guests } : {}), ...(invite ? { invite } : {}), ...(format ? { format } : {}) };
}

/**
 * The creator follows their friend in: given my pvp games this tab has seen waiting, the one to open now (its friend
 * joined and it can be opened), and the games still to watch.
 */
export function friendArrived(watching: ReadonlySet<string>, matches: MatchInfo[]): { open: string | null; watching: Set<string> } {
  const next = new Set<string>();
  let open: string | null = null;
  for (const m of matches) {
    if (m.mode !== 'pvp' || m.seat !== 0) continue;
    if (m.waiting) next.add(m.id);
    else if (watching.has(m.id)) {
      if (canOpen(m)) open ??= m.id;
      else next.add(m.id); // joined, but not up yet: open it when it is
    }
  }
  return { open, watching: next };
}

// ------------------------------------------------------------------------------------------ rows

/** The other player's name in a pvp game, once there is one. */
export function opponentName(m: Pick<MatchInfo, 'seat' | 'players'>): string | null {
  const other = (m.players ?? []).find((p: MatchPlayer) => p.seat !== (m.seat ?? 0));
  return other?.name ?? null;
}

/** An invite's state: no link (yet), a live one with ms left, or one that ran out. */
export type InviteState = { kind: 'none' } | { kind: 'live'; left: number } | { kind: 'expired' };

export function inviteState(m: Pick<MatchInfo, 'invite'>, now: number): InviteState {
  if (!m.invite) return { kind: 'none' };
  const left = m.invite.expires - now;
  return left > 0 ? { kind: 'live', left } : { kind: 'expired' };
}

/**
 * What a pvp game's row shows. `waiting` = nobody has joined (with the link's state), `joined` = "vs {name}".
 * Null for a vs-AI game.
 */
export type PvpRow =
  | { phase: 'waiting'; invite: InviteState; listed: boolean; invited: string | null }
  | { phase: 'joined'; vs: string };

export function pvpRow(m: MatchInfo, now: number): PvpRow | null {
  if (m.mode !== 'pvp') return null;
  if (m.waiting) {
    const invited = m.invited && m.invited.expires > now ? m.invited.name : null;
    return { phase: 'waiting', invite: inviteState(m, now), listed: m.listed !== false, invited };
  }
  return { phase: 'joined', vs: opponentName(m) ?? 'opponent' };
}

/** True while some game of mine is waiting on a live link: the lobby ticks its countdown and polls faster. */
export function hasLiveInvite(matches: MatchInfo[], now: number): boolean {
  return matches.some((m) => m.waiting && inviteState(m, now).kind === 'live');
}

/** "14:32" for the time a link has left. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "just now", "5 min ago", "2 h ago" for the open list. */
export function ageText(created: number, now: number): string {
  const min = Math.floor(Math.max(0, now - created) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}

/** The End button's wording: a playing pvp game concedes, so it says so and asks first. */
export function endAsk(m: Pick<MatchInfo, 'mode' | 'status' | 'waiting'>): string | null {
  if (m.mode === 'pvp' && m.status === 'playing' && !m.waiting) return 'This concedes the game.';
  return null;
}

// ------------------------------------------------------------------------------------------ the deck chosen here

const deckKey = (gameId: string) => `forge-table.pvpDeck.${gameId}`;

/** Remember the deck picked in the lobby for a game, so its page can mark you ready with it. */
export function rememberDeck(gameId: string, deck: string, store: Pick<Storage, 'setItem'> = sessionStorage): void {
  try {
    store.setItem(deckKey(gameId), deck);
  } catch {
    // Storage off: the game's start screen asks again.
  }
}

export function rememberedDeck(gameId: string, store: Pick<Storage, 'getItem'> = sessionStorage): string | null {
  try {
    return store.getItem(deckKey(gameId));
  } catch {
    return null;
  }
}

/** The game id of the page we are on: `/m/<id>/` behind the router, `/g/<id>/` for a guest. */
export function gameIdFromPath(pathname: string): string | null {
  return /^\/[mg]\/([0-9a-f]+)\//.exec(pathname)?.[1] ?? null;
}

/** The deck to preselect: the last one used here if it is still in the list, else the first. */
export function defaultDeck(decks: string[] | null | undefined, saved: string | null): string {
  if (!decks) return saved ?? '';
  return saved && decks.includes(saved) ? saved : (decks[0] ?? '');
}
