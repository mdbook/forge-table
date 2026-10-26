import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeckImportResult } from '@forge-table/protocol';
import {
  MAX_UNKNOWN_SHOWN,
  aiCopy,
  aiLabel,
  aiOptions,
  applyFix,
  groupLabel,
  importLabel,
  manaCurve,
  previewGroups,
  deckFileProblem,
  deckGroups,
  deckNameFromFile,
  defaultAi,
  defaultOppDeck,
  formatLabel,
  importError,
  legalDeck,
  importParams,
  importSummary,
  setNeuralLabel,
  showsNeuralPhoto,
  isDeckFileName,
  looksLikeUrl,
  neuralNote,
  RANDOM_DECK,
  resolveDeck,
  versionLine,
  oppDeckGroups,
  NO_PICKER_ART,
  pickerArt,
  pickerArtSource,
  unknownHeading,
  unknownLines,
  type ImportInput,
} from './start';

const AIS = ['Default', 'Cautious', 'Reckless', 'Neural'];
const DECKS = ['elves', 'grixis-affinity', 'mono-red-madness', 'tron'];

describe('opponent deck picker', () => {
  it('groups the Neural-trained decks first, strongest first, then the rest', () => {
    const neural = { ok: true, decks: ['mono-red-madness', 'grixis-affinity', 'not-here', 'mono-red-madness'] };
    expect(oppDeckGroups(DECKS, neural)).toEqual({ trained: ['mono-red-madness', 'grixis-affinity'], other: ['elves', 'tron'] });
  });

  it('has no trained group when the server lists none (older sidecars, replays)', () => {
    expect(oppDeckGroups(DECKS, { ok: true })).toEqual({ trained: [], other: DECKS });
    expect(oppDeckGroups(DECKS, undefined)).toEqual({ trained: [], other: DECKS });
  });

  it('defaults to the strongest trained deck against Neural only', () => {
    const trained = ['mono-red-madness', 'grixis-affinity'];
    expect(defaultOppDeck('Neural', trained, 'elves')).toBe('mono-red-madness');
    expect(defaultOppDeck('Default', trained, 'elves')).toBe('elves');
    expect(defaultOppDeck('Neural', [], 'elves')).toBe('elves');
    expect(defaultOppDeck(undefined, trained, undefined)).toBeUndefined();
  });
});

describe('AI picker', () => {
  beforeEach(() => setNeuralLabel('Lyra'));
  afterEach(() => setNeuralLabel(undefined));

  it('calls Neural by its own name when the server sends no label', () => {
    setNeuralLabel(undefined);
    expect(aiLabel('Neural')).toBe('Neural');
    expect(aiCopy('Neural opponent unavailable')).toBe('Neural opponent unavailable');
    setNeuralLabel('  ');
    expect(neuralNote({ ok: false })).toBe('Neural unavailable');
  });

  it("shows Neural by the server's label (Lyra) and Default as Forge AI (labels only: the names on the wire stay)", () => {
    expect(aiOptions(AIS, { ok: true }).map((o) => [o.name, o.label])).toEqual([
      ['Default', 'Forge AI'],
      ['Cautious', 'Cautious'],
      ['Reckless', 'Reckless'],
      ['Neural', 'Lyra'],
    ]);
    expect(aiLabel('Neural')).toBe('Lyra');
    expect(aiLabel('Default')).toBe('Forge AI');
    expect(aiLabel('Reckless')).toBe('Reckless');
    // The bridge's toast when the Neural seat can't start.
    expect(aiCopy('Neural opponent unavailable')).toBe('Lyra opponent unavailable');
    expect(aiCopy('model missing. This game uses the Default Forge AI.')).toBe('model missing. This game uses the Forge AI.');
    expect(aiCopy('Deck not found')).toBe('Deck not found');
  });

  it('lists Neural normally when it can run, and preselects the server default', () => {
    const opts = aiOptions(AIS, { ok: true });
    expect(opts.find((o) => o.name === 'Neural')).toEqual({ name: 'Neural', label: 'Lyra', disabled: false });
    expect(defaultAi(AIS, 'Neural', { ok: true })).toBe('Neural');
    expect(neuralNote({ ok: true })).toBeNull();
  });

  it('leaves Neural out, silently, when no Neural AI plugin is installed', () => {
    const neural = { ok: false, plugin: false as const, reason: 'no Neural AI plugin is installed with this Forge Table' };
    expect(aiOptions(AIS, neural).map((o) => o.name)).toEqual(['Default', 'Cautious', 'Reckless']);
    expect(defaultAi(AIS, 'Neural', neural)).toBe('Default');
    expect(neuralNote(neural)).toBeNull();
  });

  it('keeps Neural listed but disabled when it cannot run, with the reason', () => {
    const neural = { ok: false, reason: 'model file not found' };
    expect(aiOptions(AIS, neural).find((o) => o.name === 'Neural')).toEqual({ name: 'Neural', label: 'Lyra (unavailable)', disabled: true });
    expect(defaultAi(AIS, 'Default', neural)).toBe('Default');
    // Even if a stale default names it, a disabled profile is never preselected.
    expect(defaultAi(AIS, 'Neural', neural)).toBe('Default');
    expect(neuralNote(neural)).toBe('Lyra unavailable: model file not found');
    expect(neuralNote({ ok: false })).toBe('Lyra unavailable');
  });

  it('treats a missing neural field (old sidecars, replays) as unknown, not unavailable', () => {
    expect(aiOptions(AIS, undefined).every((o) => !o.disabled)).toBe(true);
    expect(defaultAi(AIS, 'Default', undefined)).toBe('Default');
    expect(neuralNote(undefined)).toBeNull();
    expect(defaultAi([], 'Default', undefined)).toBe('Default');
  });
});

describe('deck import panel', () => {
  const input = (over: Partial<ImportInput>): ImportInput => ({ mode: 'paste', text: '', url: '', file: null, name: '', ...over });

  it('builds paste params, with an optional trimmed name and dry run', () => {
    expect(importParams(input({ text: '4 Lightning Bolt\n20 Mountain' }), true)).toEqual({
      params: { text: '4 Lightning Bolt\n20 Mountain', dryRun: true },
    });
    expect(importParams(input({ text: '4 Lightning Bolt', name: '  Burn  ' }), false)).toEqual({ params: { text: '4 Lightning Bolt', name: 'Burn' } });
    expect(importParams(input({ text: '   \n' }), true)).toEqual({ error: 'Paste a deck list first.' });
  });

  it('builds link params and rejects things that are not links', () => {
    expect(importParams(input({ mode: 'link', url: ' https://www.moxfield.com/decks/abc123 ' }), false)).toEqual({
      params: { url: 'https://www.moxfield.com/decks/abc123' },
    });
    expect(importParams(input({ mode: 'link', url: 'moxfield deck' }), false)).toHaveProperty('error');
    expect(importParams(input({ mode: 'link' }), false)).toEqual({ error: 'Paste a deck link first.' });
    expect(looksLikeUrl('http://tappedout.net/mtg-decks/x/')).toBe(true);
    expect(looksLikeUrl('ftp://x.y')).toBe(false);
  });

  it('sends a file as text, named after the file unless it is a .dck or a name was typed', () => {
    const file = { name: 'Mono Red.txt', text: '20 Mountain' };
    expect(importParams(input({ mode: 'file', file }), true)).toEqual({ params: { text: '20 Mountain', name: 'Mono Red', dryRun: true } });
    expect(importParams(input({ mode: 'file', file, name: 'Sligh' }), false)).toEqual({ params: { text: '20 Mountain', name: 'Sligh' } });
    expect(importParams(input({ mode: 'file', file: { name: 'deck.dck', text: '[metadata]\nName=Burn' } }), false)).toEqual({
      params: { text: '[metadata]\nName=Burn' },
    });
    expect(importParams(input({ mode: 'file' }), false)).toHaveProperty('error');
    expect(importParams(input({ mode: 'file', file: { name: 'a.txt', text: '' } }), false)).toEqual({ error: 'a.txt is empty.' });
  });

  it('formats the check result', () => {
    const r: DeckImportResult = { name: 'Burn', saved: false, main: 24, side: 4, recognized: 28, unknown: ['4 Not A Real Card'], warnings: [] };
    expect(importSummary(r)).toBe('28 cards recognized (main 24 · side 4)');
    expect(importSummary({ recognized: 1, main: 1, side: 0 })).toBe('1 card recognized (main 1 · side 0)');
    expect(importSummary({ recognized: 0, main: 0, side: 0 })).toBe('0 cards recognized (main 0 · side 0)');
    expect(importSummary({ recognized: 100, main: 99, side: 0, commander: 1 })).toBe('100 cards recognized (main 99 · side 0 · commander 1)');
    expect(unknownHeading(r)).toBe('1 line not recognized');
    expect(unknownHeading({ unknown: ['a', 'b'] })).toBe('2 lines not recognized');
    expect(unknownHeading({ unknown: [] })).toBeNull();
    const many = Array.from({ length: MAX_UNKNOWN_SHOWN + 3 }, (_, i) => `1 Card ${i}`);
    expect(unknownLines({ unknown: many })).toEqual({ shown: many.slice(0, MAX_UNKNOWN_SHOWN), more: 3 });
  });

  it('turns rpc failures into readable text', () => {
    expect(importError(new Error('Moxfield returned 404 for that deck'))).toBe('Moxfield returned 404 for that deck');
    expect(importError(new Error('rpc failed'))).toBe('The deck could not be imported.');
    expect(importError(new Error('connection closed'))).toMatch(/connection/);
    expect(importError(undefined)).toBe('The deck could not be imported.');
  });

  it('accepts only deck-sized .txt/.dck/.dec files', () => {
    expect(isDeckFileName('Burn.DCK')).toBe(true);
    expect(isDeckFileName('list.dec')).toBe(true);
    expect(isDeckFileName('deck.json')).toBe(false);
    expect(deckFileProblem({ name: 'a.txt', size: 300 })).toBeNull();
    expect(deckFileProblem({ name: 'a.png', size: 300 })).toMatch(/isn’t a deck file/);
    expect(deckFileProblem({ name: 'a.txt', size: 5 * 1024 * 1024 })).toMatch(/too large/);
    expect(deckNameFromFile('Mono Red Madness.dec')).toBe('Mono Red Madness');
  });
});

describe("the Neural AI's picture on a plate", () => {
  const w = { neural: { ok: true, avatar: true } };
  it("shows on the AI's seat of a match against Neural, when the server has one", () => {
    expect(showsNeuralPhoto(w, 'Neural', true)).toBe(true);
  });

  it('never elsewhere: a person, Forge AI, a server without a picture, an unknown match, no welcome', () => {
    expect(showsNeuralPhoto(w, 'Neural', false)).toBe(false);
    expect(showsNeuralPhoto(w, 'Neural', undefined)).toBe(false);
    expect(showsNeuralPhoto(w, 'Default', true)).toBe(false);
    expect(showsNeuralPhoto({ neural: { ok: true } }, 'Neural', true)).toBe(false);
    expect(showsNeuralPhoto({}, 'Neural', true)).toBe(false);
    expect(showsNeuralPhoto(w, null, true)).toBe(false);
    expect(showsNeuralPhoto(null, 'Neural', true)).toBe(false);
  });
});

describe('versionLine (show what is running)', () => {
  it('names the build and the model (by its label), with dates when known', () => {
    setNeuralLabel('Lyra');
    expect(
      versionLine({
        forgeVersion: '2.0.15',
        build: { sha: '23fd3994', builtAt: '2026-10-05T00:18:32Z' },
        neural: { ok: true, version: 9681, releasedAt: '2026-10-04T23:16:00Z' },
      }),
    ).toBe('Forge Table 23fd3994 (built 2026-10-05) · Lyra v9681 (released 2026-10-04)');
    expect(versionLine({ forgeVersion: '2.0.15', neural: { ok: true, version: 9681 } })).toBe('Forge Table dev (Forge 2.0.15) · Lyra v9681');
    expect(versionLine({ forgeVersion: '2.0.15' })).toBe('Forge Table dev (Forge 2.0.15)');
    setNeuralLabel(undefined);
    expect(versionLine({ forgeVersion: '2.0.15', neural: { ok: true, version: 9681 } })).toBe('Forge Table dev (Forge 2.0.15) · Neural v9681');
  });
});

describe('format', () => {
  const decks = ['Krenko', 'Burn', 'Nadu'];
  const problems = { Burn: 'Burn has 60 cards, a Brawl deck has 100', Nadu: 'Nadu has a banned commander: Nadu, Winged Wisdom' };

  it('labels the format', () => {
    expect(formatLabel('brawl')).toBe('Competitive Brawl');
    expect(formatLabel(undefined)).toBe('Constructed');
  });

  it('splits the decks into legal and illegal with why, without the deck name', () => {
    expect(deckGroups(decks, problems)).toEqual({
      legal: ['Krenko'],
      illegal: [
        { name: 'Burn', why: 'has 60 cards, a Brawl deck has 100' },
        { name: 'Nadu', why: 'has a banned commander: Nadu, Winged Wisdom' },
      ],
    });
    expect(deckGroups(decks, undefined)).toEqual({ legal: decks, illegal: [] });
    expect(deckGroups(['X'], { X: 'cannot be read' }).illegal[0]?.why).toBe('cannot be read');
    expect(deckGroups(['constructor', 'toString'], {})).toEqual({ legal: ['constructor', 'toString'], illegal: [] });
  });

  it('preselects the wanted deck only if it is legal', () => {
    expect(legalDeck('Krenko', decks, problems)).toBe('Krenko');
    expect(legalDeck('Burn', decks, problems)).toBe('Krenko');
    expect(legalDeck(undefined, decks, problems)).toBe('Krenko');
    expect(legalDeck('Burn', ['Burn'], problems)).toBeUndefined();
  });

  it('draws a Random deck from the listed decks, and leaves a picked deck alone', () => {
    const pool = ['A', 'B', 'C'];
    expect(resolveDeck(RANDOM_DECK, pool, () => 0)).toBe('A');
    expect(resolveDeck(RANDOM_DECK, pool, () => 0.5)).toBe('B');
    expect(resolveDeck(RANDOM_DECK, pool, () => 0.9999)).toBe('C');
    expect(resolveDeck(RANDOM_DECK, pool, () => 1)).toBe('C');
    expect(resolveDeck(RANDOM_DECK, [], () => 0)).toBeUndefined();
    expect(resolveDeck('B', pool, () => 0)).toBe('B');
    expect(resolveDeck(undefined, pool, () => 0)).toBeUndefined();
    expect(pool).toContain(resolveDeck(RANDOM_DECK, pool));
  });
});

describe('deck picker art', () => {
  const crop = (c: string) => `/api/art/crop/${c}`;
  const details = { Burn: { cards: 60, colors: 'R', key: 'Lightning Bolt' } };

  it('asks the lobby only for a player behind the router', () => {
    expect(pickerArtSource(true, false)).toBe('lobby');
    expect(pickerArtSource(true, true)).toBe('none');
    expect(pickerArtSource(false, false)).toBe('none');
  });

  it("uses the lobby's details and crops once loaded", () => {
    const art = pickerArt('lobby', details, crop);
    expect(art.details).toBe(details);
    expect(art.cropUrl('Lightning Bolt')).toBe('/api/art/crop/Lightning Bolt');
  });

  it('shows names only until loaded, on a guest table and on a plain sidecar', () => {
    expect(pickerArt('lobby', null, crop)).toBe(NO_PICKER_ART);
    expect(pickerArt('none', details, crop)).toBe(NO_PICKER_ART);
    expect(NO_PICKER_ART.details).toEqual({});
    expect(NO_PICKER_ART.cropUrl('Lightning Bolt')).toBe('');
  });
});

describe('import preview', () => {
  const c = (n: number, name: string, type: string, cmc: number, section: 'main' | 'side' | 'commander' = 'main') => ({ n, name, type, cmc, section });
  const cards = [
    c(1, 'Niv-Mizzet, Parun', 'Creature', 6, 'commander'),
    c(4, 'Spirebluff Canal', 'Land', 0),
    c(1, 'Opt', 'Instant', 1),
    c(1, 'Crackling Drake', 'Creature', 4),
    c(1, 'Brazen Borrower', 'Creature', 3),
    c(2, 'Abrade', 'Instant', 2, 'side'),
    c(1, 'Ral, Storm Conduit', 'Planeswalker', 4),
    c(1, 'Big Thing', 'Creature', 9),
  ];

  it('groups main-deck cards by type in list order, by mana value inside', () => {
    const g = previewGroups(cards);
    expect(g.map((x) => x.type)).toEqual(['Creature', 'Planeswalker', 'Instant', 'Land']);
    expect(g[0]!.cards.map((x) => x.name)).toEqual(['Brazen Borrower', 'Crackling Drake', 'Big Thing']);
    expect(g[3]!.count).toBe(4);
    expect(groupLabel('Sorcery')).toBe('Sorceries');
    expect(groupLabel('Creature')).toBe('Creatures');
  });

  it('counts the curve over nonland main cards, 6+ in the last bucket', () => {
    expect(manaCurve(cards)).toEqual([0, 1, 0, 1, 2, 0, 1]);
  });

  it('fixes an unknown line in place, keeping its quantity', () => {
    expect(applyFix('Deck\n1 Opt\n  2x Lighting Bolt \n4 Island', '2x Lighting Bolt', 'Lightning Bolt')).toBe('Deck\n1 Opt\n  2x Lightning Bolt\n4 Island');
    expect(applyFix('Lighting Bolt', 'Lighting Bolt', 'Lightning Bolt')).toBe('Lightning Bolt');
    expect(applyFix('1 Opt', 'nope', 'X')).toBe('1 Opt');
  });

  it('names the count on the import button once checked', () => {
    expect(importLabel(null)).toBe('Import');
    expect(importLabel({ recognized: 0 })).toBe('Import');
    expect(importLabel({ recognized: 60 })).toBe('Import 60 cards');
  });
});
