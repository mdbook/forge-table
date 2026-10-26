import { describe, expect, it } from 'vitest';
import { deckDetails, peopleOf, record } from './api';
import { agoText, aiName, bootSteps, dayText, findPeople, personLine } from './home';

const NOW = new Date(2026, 9, 18, 10, 0).getTime();
const DAY = 86_400_000;

describe('the lobby home', () => {
  it('names the AI on a game card', () => {
    expect(aiName('Neural', 'Lyra')).toBe('Lyra');
    expect(aiName('Default', 'Lyra')).toBe('Forge AI');
    expect(aiName('Reckless')).toBe('Reckless');
    expect(aiName(undefined)).toBe('AI');
  });

  it('ticks off a starting game’s stages up to the current one', () => {
    expect(bootSteps({ progress: { stage: 'ai', label: 'x', pct: 60, elapsed: 3 } }).map((s) => s.state)).toEqual(['done', 'done', 'now', 'todo']);
    expect(bootSteps({}).map((s) => `${s.label}:${s.state}`)).toEqual(['Engine:now', 'Cards:todo', 'AI:todo', 'Table:todo']);
  });

  it('says how long ago and which day', () => {
    expect(agoText(NOW - 30_000, NOW)).toBe('just now');
    expect(agoText(NOW - 3 * 3_600_000, NOW)).toBe('3 hours ago');
    expect(agoText(NOW - 2 * DAY, NOW)).toBe('2 days ago');
    expect(dayText(NOW - 3_600_000, NOW)).toBe('today');
    expect(dayText(NOW - DAY, NOW)).toBe('yesterday');
    expect(dayText(NOW - 30 * DAY, NOW)).not.toMatch(/day/);
  });

  it('gives each friend tile its status line', () => {
    expect(personLine({ key: 'a', name: 'Sam', state: 'online', record: { w: 3, l: 2 } }, NOW)).toBe('Online · you’re 3–2');
    expect(personLine({ key: 'a', name: 'Sam', state: 'online', last: NOW - DAY }, NOW)).toBe('Online · last played yesterday');
    expect(personLine({ key: 'a', name: 'Sam', state: 'online' }, NOW)).toBe('Online now');
    expect(personLine({ key: 'a', name: 'Jo', state: 'playing' }, NOW)).toBe('In a game · will see it after');
    expect(personLine({ key: 'a', name: 'Riley', state: 'away', seen: NOW - 2 * DAY }, NOW)).toBe('Away · 2 days ago');
    expect(findPeople([{ key: 'a', name: 'Sam', state: 'online' }, { key: 'b', name: 'Robin', state: 'online' }], ' SAM').map((p) => p.name)).toEqual(['Sam']);
  });
});

describe('people and records from the server', () => {
  it('uses people when sent, else everyone online', () => {
    expect(peopleOf({ online: [{ key: 'k', name: 'Bob' }] })).toEqual([{ key: 'k', name: 'Bob', state: 'online' }]);
    expect(
      peopleOf({
        online: [{ key: 'k', name: 'Bob' }],
        people: [{ key: 'k', name: 'Bob', state: 'away', seen: 5, record: { w: 1, l: 0 }, last: 4 }, { key: 7 }, null, { key: 'j', name: 'Jo', state: 'weird' }] as never,
      }),
    ).toEqual([
      { key: 'k', name: 'Bob', state: 'away', seen: 5, record: { w: 1, l: 0 }, last: 4 },
      { key: 'j', name: 'Jo', state: 'online' },
    ]);
    expect(peopleOf(null)).toEqual([]);
  });

  it('keeps only whole, non-negative records', () => {
    expect(record({ w: 2, l: 0 })).toEqual({ w: 2, l: 0 });
    expect(record({ w: -1, l: 0 })).toBeUndefined();
    expect(record({ w: 1.5, l: 0 })).toBeUndefined();
    expect(deckDetails({ A: { cards: 60, colors: 'R', record: { w: 6, l: 3 }, last: 9 } })).toEqual({ A: { cards: 60, colors: 'R', record: { w: 6, l: 3 }, last: 9 } });
  });
});
