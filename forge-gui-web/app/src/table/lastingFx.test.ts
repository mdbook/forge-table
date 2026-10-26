import { describe, expect, it } from 'vitest';
import type { Card, GameModel } from '@forge-table/protocol';
import { classifyLasting, dungeonRooms, lastingEffects, lastingText } from './lastingFx';

const card = (id: string, name: string, extra: Partial<Card> = {}, face: Record<string, unknown> = {}): Card =>
  ({ id, zone: 'Command', owner: 'p0', controller: 'p0', state: { name, ...face }, ...extra }) as Card;

const UNDERCITY =
  'You can\'t enter this dungeon unless you "venture into Undercity."\r\n\r\nSecret Entrance — Search your library for a basic land card. (Leads to: Forge, Lost Well)\r\n\r\n' +
  'Forge — Put two +1/+1 counters on target creature. (Leads to: Trap!, Arena)\r\n\r\nLost Well — Scry 2. (Leads to: Arena, Stash)\r\n\r\n' +
  'Trap! — Target player loses 5 life. (Leads to: Archives)\r\n\r\nArena — Goad target creature. (Leads to: Archives, Catacombs)\r\n\r\n' +
  'Stash — Create a Treasure token. (Leads to: Catacombs)\r\n\r\nArchives — Draw a card. (Leads to: Throne of the Dead Three)\r\n\r\n' +
  'Catacombs — Create a 4/1 black Skeleton creature token with menace. (Leads to: Throne of the Dead Three)\r\n\r\n' +
  'Throne of the Dead Three — Reveal the top ten cards of your library.';

describe('classifyLasting', () => {
  it('sorts command-zone cards into markers, dungeons, emblems and effects; a commander is none of them', () => {
    expect(classifyLasting(card('c1', 'The Monarch', { gamePieceType: 'EFFECT' }))).toMatchObject({ kind: 'marker', label: 'The Monarch', glyph: '♛' });
    expect(classifyLasting(card('c2', 'Undercity', { gamePieceType: 'DUNGEON', currentRoom: 'Forge' }))).toMatchObject({
      kind: 'dungeon',
      label: 'Dungeon · In room: Forge',
      room: 'Forge',
    });
    expect(classifyLasting(card('c3', 'Emblem — Ajani', { gamePieceType: 'EFFECT', isEmblem: true }))).toMatchObject({ kind: 'emblem', label: 'Emblem' });
    expect(
      classifyLasting(card('c4', "Spirit Water Revival's Effect", { gamePieceType: 'EFFECT' }, { abilityText: 'You have no maximum hand size for the rest of the game.' })),
    ).toMatchObject({ kind: 'effect', label: 'Effect', text: 'You have no maximum hand size for the rest of the game.' });
    expect(classifyLasting(card('c5', 'Atraxa', { isCommander: true }))).toBeNull();
  });
  it('drops an empty Keyword Effects holder, keeps one that says something', () => {
    expect(classifyLasting(card('k1', 'Keyword Effects', { gamePieceType: 'EFFECT' }))).toBeNull();
    expect(classifyLasting(card('k1', 'Keyword Effects', { gamePieceType: 'EFFECT' }, { abilityText: 'You have hexproof.' }))?.kind).toBe('effect');
  });
});

describe('lastingText', () => {
  it("prefers Forge's ability text, falls back to the oracle text, one line per paragraph", () => {
    expect(lastingText(card('a', 'X', {}, { abilityText: ' A \r\n\r\nB ', oracleText: 'O' }))).toBe('A\nB');
    expect(lastingText(card('a', 'X', {}, { oracleText: 'O' }))).toBe('O');
    expect(lastingText(undefined)).toBe('');
  });
});

describe('lastingEffects', () => {
  it("lists a player's own, markers first, leaving out their commander", () => {
    const m = {
      game: {},
      players: { p0: { id: 'p0', life: 20, zones: { command: ['e1', 'cmd', 'd1', 'm1', 'e2'] }, commander: ['cmd'] } },
      cards: {
        e1: card('e1', 'Emblem — Ajani', { isEmblem: true, gamePieceType: 'EFFECT' }),
        cmd: card('cmd', 'Atraxa'),
        d1: card('d1', 'Undercity', { gamePieceType: 'DUNGEON' }),
        m1: card('m1', 'The Initiative', { gamePieceType: 'EFFECT' }),
        e2: card('e2', "Spirit Water Revival's Effect", { gamePieceType: 'EFFECT' }),
      },
    } as unknown as GameModel;
    expect(lastingEffects(m, 'p0').map((l) => [l.id, l.kind])).toEqual([
      ['m1', 'marker'],
      ['d1', 'dungeon'],
      ['e1', 'emblem'],
      ['e2', 'effect'],
    ]);
    expect(lastingEffects(m, 'p1')).toEqual([]);
  });
});

describe('dungeonRooms', () => {
  it('reads the rooms, where each leads and how deep it is; the entry rule is not a room', () => {
    const rooms = dungeonRooms(UNDERCITY);
    expect(rooms.map((r) => [r.name, r.depth])).toEqual([
      ['Secret Entrance', 0],
      ['Forge', 1],
      ['Lost Well', 1],
      ['Trap!', 2],
      ['Arena', 2],
      ['Stash', 2],
      ['Archives', 3],
      ['Catacombs', 3],
      ['Throne of the Dead Three', 4],
    ]);
    expect(rooms[1]).toMatchObject({ text: 'Put two +1/+1 counters on target creature.', leadsTo: ['Trap!', 'Arena'] });
    expect(rooms[8]!.leadsTo).toEqual([]);
  });
  it('reads the script form with literal \\n too, and nothing from no text', () => {
    expect(dungeonRooms('Cave Entrance — Scry 1. (Leads to: Goblin Lair)\\nGoblin Lair — Create a Goblin.').map((r) => r.depth)).toEqual([0, 1]);
    expect(dungeonRooms(undefined)).toEqual([]);
  });
});
