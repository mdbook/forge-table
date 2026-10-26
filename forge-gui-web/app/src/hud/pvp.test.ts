import { describe, expect, it } from 'vitest';
import type { PvpWelcome } from '@forge-table/protocol';
import { awayView, CLAIM_AFTER_MS, pvpStartView, readyButton, rematchView, waitingOnOpponent, type WaitInput } from './pvp';

const lobby = (o: Partial<PvpWelcome> = {}): PvpWelcome => ({ seat: 0, you: 'kai', opponent: 'sam', oppReady: false, youReady: false, ...o });

describe('pvp start screen', () => {
  it('waits for a friend to join', () => {
    expect(pvpStartView(lobby({ opponent: null })).headline).toBe('Waiting for your opponent…');
  });

  it('asks me to choose a deck, noting when they are ready', () => {
    expect(pvpStartView(lobby())).toMatchObject({ headline: 'sam has joined', detail: 'Choose your deck.' });
    expect(pvpStartView(lobby({ oppReady: true })).detail).toBe('sam is ready. Choose your deck.');
  });

  it('waits for them once I am ready, and starts when both are', () => {
    expect(pvpStartView(lobby({ youReady: true }))).toMatchObject({ headline: 'Waiting for sam…', detail: 'sam is choosing a deck.', starting: false });
    expect(pvpStartView(lobby({ youReady: true, oppReady: true }))).toMatchObject({ headline: 'Starting the match…', starting: true });
    expect(pvpStartView(lobby({ youReady: true })).ticks).toEqual([{ name: 'You', ready: true }, { name: 'sam', ready: false }]);
  });

  it('ready button: Ready, then a disabled Ready ✓, then Change deck if I pick another', () => {
    expect(readyButton(false, undefined, undefined, false)).toEqual({ label: 'Ready', enabled: true });
    expect(readyButton(false, 'A', undefined, true)).toEqual({ label: 'Starting…', enabled: false });
    expect(readyButton(true, undefined, 'A', false)).toEqual({ label: 'Ready ✓', enabled: false });
    expect(readyButton(true, 'A', 'A', false)).toEqual({ label: 'Ready ✓', enabled: false });
    expect(readyButton(true, 'B', 'A', false)).toEqual({ label: 'Change deck', enabled: true });
  });
});

describe('pvp rematch', () => {
  it('start screen: waits for their yes, then for both decks', () => {
    expect(pvpStartView(lobby({ rematch: true }))).toMatchObject({ headline: 'Rematch: waiting for sam…', starting: false });
    expect(pvpStartView(lobby({ rematch: true, youReady: true })).detail).toBe("sam hasn't said yes yet. You can still change your deck.");
    expect(pvpStartView(lobby({ rematch: true, oppRematch: true }))).toMatchObject({ headline: 'sam is up for a rematch', detail: 'Keep your deck or pick another, then Ready.' });
    expect(pvpStartView(lobby({ rematch: true, oppRematch: true, oppReady: true })).detail).toBe('sam is ready. Keep your deck or pick another, then Ready.');
    expect(pvpStartView(lobby({ rematch: true, oppRematch: true, youReady: true })).headline).toBe('Waiting for sam…');
    expect(pvpStartView(lobby({ rematch: true, oppRematch: true, youReady: true, oppReady: true })).starting).toBe(true);
  });

  it('start screen: they left, so no Ready and no ticks', () => {
    expect(pvpStartView(lobby({ rematch: true, oppLeft: true }))).toEqual({ headline: 'sam left', detail: 'No rematch this time. Leave goes back to the lobby.', starting: false, ticks: [], left: true });
  });

  it('game over: says when they asked, hides Rematch once they left', () => {
    expect(rematchView(lobby())).toEqual({ note: null, offer: true });
    expect(rematchView(lobby({ rematch: true, oppRematch: true }))).toEqual({ note: 'sam wants a rematch.', offer: true });
    expect(rematchView(lobby({ oppLeft: true }))).toEqual({ note: 'sam left. No rematch this time.', offer: false });
    expect(rematchView(null)).toEqual({ note: null, offer: true });
  });
});

describe('disconnect banner', () => {
  const away = (since: number, claimableAt?: number) => ({ presence: { opponentConnected: false, since, ...(claimableAt !== undefined ? { claimableAt } : {}) } });

  it('is absent while they are connected, or before any presence message', () => {
    expect(awayView(null, 'sam', 0)).toBeNull();
    expect(awayView({ presence: null }, 'sam', 0)).toBeNull();
    expect(awayView({ presence: { opponentConnected: true, since: 5 } }, 'sam', 10)).toBeNull();
  });

  it('counts down to claimableAt, then enables the claim', () => {
    const p = away(1_000, 121_000);
    expect(awayView(p, 'sam', 1_000)).toEqual({ text: 'sam disconnected, waiting', countdown: 'Claim win unlocks in 2:00', claimable: false });
    expect(awayView(p, 'sam', 61_500)?.countdown).toBe('Claim win unlocks in 1:00');
    expect(awayView(p, 'sam', 120_999)).toMatchObject({ countdown: 'Claim win unlocks in 0:01', claimable: false });
    expect(awayView(p, 'sam', 121_000)).toMatchObject({ countdown: null, claimable: true });
    expect(awayView(p, 'sam', 500_000)?.claimable).toBe(true);
  });

  it('never enables the claim before the game is dealt (the server sends no claimableAt then)', () => {
    expect(awayView(away(10_000), 'sam', 10_000 + CLAIM_AFTER_MS * 5)).toEqual({
      text: 'sam disconnected, waiting', countdown: 'Leave ends the game until the cards are dealt', claimable: false });
  });
});

describe('waiting for the opponent', () => {
  const base: WaitInput = { pvp: true, turn: 3, phase: 'MAIN1', playerTurn: 'p1', priority: 'p1', viewer: 'p0', promptKind: 'waiting', asks: 0, gameOver: false, away: false };

  it('shows while they hold priority and I have nothing to do', () => {
    expect(waitingOnOpponent(base)).toBe(true);
    expect(waitingOnOpponent({ ...base, promptKind: null })).toBe(true);
  });

  it('never against the AI, or when the game is over', () => {
    expect(waitingOnOpponent({ ...base, pvp: false })).toBe(false);
    expect(waitingOnOpponent({ ...base, gameOver: true })).toBe(false);
  });

  it('not when I hold priority, have a prompt, or an ask is up', () => {
    expect(waitingOnOpponent({ ...base, priority: 'p0' })).toBe(false);
    expect(waitingOnOpponent({ ...base, promptKind: 'priority' })).toBe(false);
    expect(waitingOnOpponent({ ...base, asks: 1 })).toBe(false);
  });

  it('not while the disconnect banner speaks for them', () => {
    expect(waitingOnOpponent({ ...base, away: true })).toBe(false);
  });

  it('covers their attack and block declarations, where nobody holds priority', () => {
    const none = { ...base, priority: undefined };
    expect(waitingOnOpponent({ ...none, phase: 'COMBAT_DECLARE_ATTACKERS', playerTurn: 'p1' })).toBe(true);
    expect(waitingOnOpponent({ ...none, phase: 'COMBAT_DECLARE_ATTACKERS', playerTurn: 'p0' })).toBe(false);
    expect(waitingOnOpponent({ ...none, phase: 'COMBAT_DECLARE_BLOCKERS', playerTurn: 'p0' })).toBe(true);
    expect(waitingOnOpponent({ ...none, phase: 'COMBAT_DECLARE_BLOCKERS', playerTurn: 'p1' })).toBe(false);
    expect(waitingOnOpponent({ ...none, phase: 'MAIN1' })).toBe(false);
  });

  it('before turn 1 only a waiting bar counts (the other player is still deciding on the mulligan)', () => {
    expect(waitingOnOpponent({ ...base, turn: 0, priority: undefined })).toBe(true);
    expect(waitingOnOpponent({ ...base, turn: 0, priority: undefined, promptKind: null })).toBe(false);
  });
});
