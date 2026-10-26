import { describe, expect, it } from 'vitest';
import type { Card } from '@forge-table/protocol';
import { handFacts, mullInfo, seatOf } from './mulligan';

const card = (core: string, manaCost?: string): Card => ({
  id: core + (manaCost ?? ''),
  controller: 'p0',
  zone: 'Hand',
  state: { face: 'Original', name: core, type: { super: [], core: [core], sub: [] }, ...(manaCost ? { manaCost } : {}) },
});

describe('mulligan banner (B5)', () => {
  it('reads who goes first from the engine message', () => {
    expect(seatOf('Player, you are going first!\n\nDo you want to keep your hand?')).toBe('play');
    expect(seatOf('Mono-Blue Faeries is going first.\nPlayer, you are going 2nd.\n\nDo you want to keep your hand?')).toBe('draw');
    expect(seatOf('Return 1 card(s) to the bottom of your library')).toBeNull();
  });

  it('counts lands, spells and the top mana value', () => {
    expect(handFacts([card('Land'), card('Land'), card('Instant', '{R}'), card('Creature', '{2}{G}{G}'), undefined])).toEqual({ lands: 2, spells: 2, top: 4 });
    expect(handFacts([card('Land')])).toEqual({ lands: 1, spells: 0, top: null });
  });

  it('keep: 7 then 6 after one mulligan; Brawl\'s first is free', () => {
    const p = { kind: 'mulligan', message: 'Player, you are going first!', highlighted: [] };
    expect(mullInfo(p, 7, { count: 0, seat: null }, 0)).toMatchObject({ seat: 'play', keep: 7, next: 6, sub: 'Opening hand · no mulligans yet' });
    expect(mullInfo(p, 7, { count: 1, seat: null }, 0)).toMatchObject({ keep: 6, next: 5 });
    expect(mullInfo(p, 7, { count: 0, seat: null }, 1)).toMatchObject({ keep: 7, next: 7 });
    expect(mullInfo(p, 7, { count: 1, seat: null }, 1)).toMatchObject({ keep: 7, next: 6 });
  });

  it('tuck: the count comes from the engine (what is left + what is chosen), the seat from the keep prompt', () => {
    const t = mullInfo({ kind: 'mulliganTuck', message: 'Return 1 card(s) to the bottom of your library', highlighted: ['x'] }, 7, { count: 2, seat: 'draw' }, 0);
    expect(t).toMatchObject({ kind: 'tuck', seat: 'draw', title: 'Put 2 cards on the bottom', keep: 5, tuck: { n: 2, chosen: 1 } });
    expect(mullInfo({ kind: 'priority', message: '', highlighted: [] }, 7, { count: 0, seat: null }, 0)).toBeNull();
  });
});

describe('starting hand (Leyline, Gemstone Caverns)', () => {
  it('is a banner with how many go in play', () => {
    const p = { kind: 'startingHand', message: 'Put any number of cards onto the battlefield', highlighted: ['c1'] };
    expect(mullInfo(p, 7, { count: 0, seat: null }, 0)).toMatchObject({ kind: 'start', keep: 1, title: 'Start with any of these on the battlefield?' });
    expect(mullInfo({ ...p, kind: 'priority' }, 7, { count: 0, seat: null }, 0)).toBeNull();
  });
});
