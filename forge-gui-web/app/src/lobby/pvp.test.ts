import { describe, expect, it } from 'vitest';
import type { MatchInfo } from './api';
import { ageText, countdown, defaultDeck, endAsk, friendArrived, friendMatch, gameIdFromPath, guestCodeFromPath, hasLiveInvite, inviteState, joinCodeFromPath, opponentName, pvpRow, rememberDeck, rememberedDeck } from './pvp';

const NOW = 1_000_000;
const url = 'https://mtg.example/join/abcdefghijklmnopqrstuvwxyz';
const game = (o: Partial<MatchInfo> = {}): MatchInfo => ({ id: 'a1', status: 'ready', created: 1, mode: 'pvp', seat: 0, players: [{ seat: 0, name: 'kai' }], waiting: true, listed: true, ...o });

describe('join links', () => {
  it('reads the code from /join/<code>', () => {
    expect(joinCodeFromPath('/join/abcdefghijklmnopqrstuvwxyz')).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(joinCodeFromPath('/join/AbC_d-0123456789/')).toBe('AbC_d-0123456789');
  });

  it('ignores everything else', () => {
    for (const p of ['/', '/join', '/join/', '/join/short', '/join/abc/def12345', '/m/ab12/', '/join/has space12345', '/x/join/abcdefghij', '/join/abcdefgh?x']) {
      expect(joinCodeFromPath(p), p).toBeNull();
    }
  });
});

describe('a pvp game row', () => {
  it('is null for a game against the AI (and for older servers that send no mode)', () => {
    expect(pvpRow(game({ mode: 'ai' }), NOW)).toBeNull();
    expect(pvpRow(game({ mode: undefined }), NOW)).toBeNull();
  });

  it('waits for a friend while seat 1 is empty, with a live link', () => {
    const m = game({ invite: { url, expires: NOW + 90_000 } });
    expect(pvpRow(m, NOW)).toEqual({ phase: 'waiting', invite: { kind: 'live', left: 90_000 }, listed: true, invited: null });
  });

  it('sends the "Online now" handle only for a direct invite', () => {
    expect(friendMatch('Burn', true, false, false, 'k1')).toEqual({ mode: 'pvp', deck: 'Burn', listed: true, invite: 'k1' });
    expect(friendMatch('Burn', true, false, false)).toEqual({ mode: 'pvp', deck: 'Burn', listed: true });
  });

  it('names who I invited from "Online now" while that invite lasts', () => {
    const m = game({ invited: { name: 'Bob', expires: NOW + 1 } });
    expect(pvpRow(m, NOW)).toMatchObject({ phase: 'waiting', invited: 'Bob' });
    expect(pvpRow(m, NOW + 1)).toMatchObject({ phase: 'waiting', invited: null });
  });

  it('shows an expired link once its time is up, so the host can mint a new one', () => {
    const m = game({ invite: { url, expires: NOW } });
    expect(pvpRow(m, NOW)).toMatchObject({ phase: 'waiting', invite: { kind: 'expired' } });
    expect(pvpRow(m, NOW - 1)).toMatchObject({ invite: { kind: 'live', left: 1 } });
  });

  it('waits with no link at all when the server sent none; unlisted shows as link only', () => {
    expect(pvpRow(game({ listed: false }), NOW)).toEqual({ phase: 'waiting', invite: { kind: 'none' }, listed: false, invited: null });
  });

  it('is "vs {name}" once somebody joined, from either seat', () => {
    const joined = { waiting: undefined, players: [{ seat: 0 as const, name: 'kai' }, { seat: 1 as const, name: 'sam' }] };
    expect(pvpRow(game(joined), NOW)).toEqual({ phase: 'joined', vs: 'sam' });
    expect(pvpRow(game({ ...joined, seat: 1 }), NOW)).toEqual({ phase: 'joined', vs: 'kai' });
    expect(opponentName(game({ ...joined, seat: 1 }))).toBe('kai');
    expect(opponentName(game())).toBeNull();
  });

  it('only ticks a countdown while some waiting game has a live link', () => {
    const live = game({ invite: { url, expires: NOW + 5 } });
    const dead = game({ invite: { url, expires: NOW - 5 } });
    expect(hasLiveInvite([dead, game({ mode: 'ai', waiting: undefined })], NOW)).toBe(false);
    expect(hasLiveInvite([dead, live], NOW)).toBe(true);
    expect(inviteState({}, NOW)).toEqual({ kind: 'none' });
  });
});

describe('texts', () => {
  it('counts a link down as m:ss and never below zero', () => {
    expect(countdown(15 * 60_000)).toBe('15:00');
    expect(countdown(61_001)).toBe('1:02');
    expect(countdown(999)).toBe('0:01');
    expect(countdown(-5)).toBe('0:00');
  });

  it('ages open games', () => {
    expect(ageText(NOW - 20_000, NOW)).toBe('just now');
    expect(ageText(NOW - 5 * 60_000, NOW)).toBe('5 min ago');
    expect(ageText(NOW - 125 * 60_000, NOW)).toBe('2 h ago');
    expect(ageText(NOW + 60_000, NOW)).toBe('just now');
  });

  it('asks before ending only a pvp game in play, which concedes it', () => {
    expect(endAsk({ mode: 'pvp', status: 'playing' })).toBe('This concedes the game.');
    expect(endAsk({ mode: 'pvp', status: 'ready', waiting: true })).toBeNull();
    expect(endAsk({ mode: 'ai', status: 'playing' })).toBeNull();
  });
});

describe('the deck picked in the lobby', () => {
  it('is remembered per game and survives a bad store', () => {
    const mem = new Map<string, string>();
    const store = { setItem: (k: string, v: string) => void mem.set(k, v), getItem: (k: string) => mem.get(k) ?? null };
    rememberDeck('a1', 'Mono Red', store);
    expect(rememberedDeck('a1', store)).toBe('Mono Red');
    expect(rememberedDeck('b2', store)).toBeNull();
    const broken = {
      setItem: () => {
        throw new Error('off');
      },
      getItem: () => {
        throw new Error('off');
      },
    };
    expect(() => rememberDeck('a1', 'x', broken)).not.toThrow();
    expect(rememberedDeck('a1', broken)).toBeNull();
  });

  it('finds the game id in /m/<id>/', () => {
    expect(gameIdFromPath('/m/0a1b2c/')).toBe('0a1b2c');
    expect(gameIdFromPath('/m/0a1b2c/ws')).toBe('0a1b2c');
    expect(gameIdFromPath('/')).toBeNull();
  });

  it('preselects the last deck if it is still there, else the first', () => {
    expect(defaultDeck(['A', 'B'], 'B')).toBe('B');
    expect(defaultDeck(['A', 'B'], 'gone')).toBe('A');
    expect(defaultDeck([], 'B')).toBe('');
    expect(defaultDeck(null, 'B')).toBe('B');
    expect(defaultDeck(undefined, null)).toBe('');
  });
});

describe('guests', () => {
  it('reads the code from /g/join/<code> only', () => {
    expect(guestCodeFromPath('/g/join/abcdefghijklmnopqrstuvwxyz')).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(guestCodeFromPath('/g/join/AbC_d-0123456789/')).toBe('AbC_d-0123456789');
    for (const p of ['/', '/join/abcdefghijklmnop', '/g/join/', '/g/join/short', '/g/abc123/', '/x/g/join/abcdefghij']) {
      expect(guestCodeFromPath(p), p).toBeNull();
    }
    expect(joinCodeFromPath('/g/join/abcdefghijklmnopqrstuvwxyz')).toBeNull();
  });

  it('finds the game id on a guest table too', () => {
    expect(gameIdFromPath('/g/0a1b2c/')).toBe('0a1b2c');
    expect(gameIdFromPath('/g/join/abcdefgh')).toBeNull();
  });

  it('asks for guests only when the server offers them, off unless ticked', () => {
    expect(friendMatch('Burn', true, false, false)).toEqual({ mode: 'pvp', deck: 'Burn', listed: true });
    expect(friendMatch('Krenko', true, false, false, undefined, 'brawl')).toEqual({ mode: 'pvp', deck: 'Krenko', listed: true, format: 'brawl' });
    expect(friendMatch('Burn', true, true, false)).toEqual({ mode: 'pvp', deck: 'Burn', listed: true });
    expect(friendMatch('Burn', false, false, true)).toEqual({ mode: 'pvp', deck: 'Burn', listed: false, guests: false });
    expect(friendMatch('Burn', false, true, true)).toEqual({ mode: 'pvp', deck: 'Burn', listed: false, guests: true });
  });
});

describe('the creator follows the friend in', () => {
  it('opens a game of mine that was waiting once the friend has joined', () => {
    const first = friendArrived(new Set(), [game()]);
    expect(first).toEqual({ open: null, watching: new Set(['a1']) });
    const joined = game({ waiting: undefined, players: [{ seat: 0, name: 'kai' }, { seat: 1, name: 'Gus (guest)' }] });
    expect(friendArrived(first.watching, [joined])).toEqual({ open: 'a1', watching: new Set() });
  });

  it('waits for a joined game that is not up yet, and never opens games it did not see waiting', () => {
    const joined = game({ waiting: undefined, status: 'starting' });
    expect(friendArrived(new Set(['a1']), [joined])).toEqual({ open: null, watching: new Set(['a1']) });
    expect(friendArrived(new Set(), [game({ waiting: undefined })]).open).toBeNull();
  });

  it('ignores games I joined and games against the AI', () => {
    expect(friendArrived(new Set(['a1']), [game({ waiting: undefined, seat: 1 })]).open).toBeNull();
    expect(friendArrived(new Set(['a1']), [game({ waiting: undefined, mode: 'ai' })]).open).toBeNull();
  });
});
