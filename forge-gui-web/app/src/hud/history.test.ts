import type { LogEntry } from '@forge-table/protocol';
import { describe, expect, it } from 'vitest';
import { appendLog, category, groupByTurn, historyText, matches, splitCard, turnTitle } from './history';

const e = (turn: number, phase: LogEntry['phase'], kind: string, text: string, extra: Partial<LogEntry> = {}): LogEntry => ({
  turn,
  ...(phase ? { phase } : {}),
  ...(turn ? { active: turn % 2 ? 'p0' : 'p1' } : {}),
  kind,
  text,
  ...extra,
});

const LOG: LogEntry[] = [
  e(0, undefined, 'mulligan', 'Alphu has kept a hand of 7 cards', { player: 'p0' }),
  e(1, 'MAIN1', 'land', 'Alphu played Urza’s Tower', { player: 'p0', card: 'Urza’s Tower' }),
  e(1, 'MAIN1', 'stackAdd', 'Alphu cast Candy Trail', { player: 'p0', card: 'Candy Trail' }),
  e(2, 'COMBAT_DECLARE_ATTACKERS', 'combat', 'Blue Terror assigned Delver of Secrets to attack Alphu.', { player: 'p1' }),
  e(2, 'COMBAT_DAMAGE', 'damage', 'Delver of Secrets deals 1 combat damage to Alphu.', { player: 'p1', card: 'Delver of Secrets' }),
  e(3, 'MAIN1', 'zoneChange', 'Candy Trail was put into Graveyard from Battlefield.', { player: 'p0', card: 'Candy Trail' }),
];
const names = (p: string) => (p === 'p0' ? 'Alphu' : 'Blue Terror');

describe('game history', () => {
  it('starts over on a new game or from 0, and goes on from `from` otherwise', () => {
    const a = appendLog(null, { t: 'log', game: 1, from: 0, entries: LOG.slice(0, 2) });
    const b = appendLog(a, { t: 'log', game: 1, from: 2, entries: LOG.slice(2, 3) });
    expect(b.entries).toHaveLength(3);
    // A resend that overlaps (from 1) replaces the tail instead of doubling it.
    expect(appendLog(b, { t: 'log', game: 1, from: 1, entries: LOG.slice(1, 4) }).entries).toEqual(LOG.slice(0, 4));
    expect(appendLog(b, { t: 'log', game: 1, from: 0, entries: LOG.slice(0, 1) }).entries).toHaveLength(1);
    expect(appendLog(b, { t: 'log', game: 2, from: 5, entries: LOG.slice(0, 1) })).toEqual({ game: 2, entries: LOG.slice(0, 1) });
  });

  it('groups by turn, then by step, keeping each line’s place in the whole log', () => {
    const turns = groupByTurn(LOG, () => true);
    expect(turns.map((t) => t.turn)).toEqual([0, 1, 2, 3]);
    expect(turns[2]!.steps.map((s) => s.phase)).toEqual(['COMBAT_DECLARE_ATTACKERS', 'COMBAT_DAMAGE']);
    expect(turns[3]!.steps[0]!.lines[0]!.index).toBe(5);
    expect(turnTitle(turns[0]!, 'p0', names)).toBe('Before the game');
    expect(turnTitle(turns[1]!, 'p0', names)).toBe('Your turn');
    expect(turnTitle(turns[2]!, 'p0', names)).toBe('Blue Terror’s turn');
  });

  it('filters by player, by kind and by search text', () => {
    const pick = (f: Parameters<typeof matches>[1], q = '') => LOG.filter((x) => matches(x, f, q, 'p0')).map((x) => LOG.indexOf(x));
    expect(pick('all')).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pick('mine')).toEqual([0, 1, 2, 5]);
    expect(pick('opp')).toEqual([3, 4]);
    expect(pick('zone')).toEqual([5]);
    expect(pick('combat')).toEqual([3]);
    expect(pick('life')).toEqual([4]);
    expect(pick('all', '  candy ')).toEqual([2, 5]);
    expect(pick('mine', 'delver')).toEqual([]);
    expect(category('somethingNew')).toBe('info');
  });

  it('writes the game as plain text for Copy and Download', () => {
    const text = historyText(LOG.slice(0, 2), names);
    expect(text).toBe('Before the game: Alphu has kept a hand of 7 cards\nTurn 1 (Alphu), Main 1: Alphu played Urza’s Tower\n');
    expect(historyText([], names)).toBe('');
  });

  it('splits a line around each mention of its card', () => {
    expect(splitCard(LOG[2]!)).toEqual([{ text: 'Alphu cast ', card: false }, { text: 'Candy Trail', card: true }]);
    expect(splitCard(LOG[5]!)[0]).toEqual({ text: 'Candy Trail', card: true });
    expect(splitCard(LOG[0]!)).toEqual([{ text: LOG[0]!.text, card: false }]);
  });
});
