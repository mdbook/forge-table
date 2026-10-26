import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { deckCards, deckDetails, LobbyApi, type DeckDetail, type DeckList } from './api';
import { mosaicKeys } from './DeckGallery';
import { NewGame, type NewGameProps } from './NewGame';
import { brawlChecks, filterDecks, loadPicks, offStandard, opponents, playable, RANDOM_DECK, recommendedAi, rememberHandoff, savePicks, startPlan, takeHandoff } from './newGame';

const details: Record<string, DeckDetail> = {
  'Mono Red': { cards: 60, colors: 'R', key: 'Goblin Guide' },
  'Azorius Control': { cards: 60, colors: 'WU', key: 'Teferi, Hero of Dominaria' },
  'Niv Brawl': { cards: 100, colors: 'UR', key: 'Niv-Mizzet, Parun', commander: 'Niv-Mizzet, Parun' },
};
const names = ['Azorius Control', 'Mono Red', 'Niv Brawl', 'Unreadable'];

function memory(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  };
}

describe('a deck card list from the server', () => {
  it('keeps well-formed sections and lines only', () => {
    expect(deckCards({ sections: [{ name: 'Main', cards: [{ n: 4, name: 'Bolt' }, { n: 'x', name: 'Bad' }, null] }, { name: 'Side', cards: [] }, 'junk'] })).toEqual({ sections: [{ name: 'Main', cards: [{ n: 4, name: 'Bolt' }] }] });
    expect(deckCards(null)).toEqual({ sections: [] });
  });

  it('asks for the deck by name, and says null on a server without the endpoint', async () => {
    const urls: string[] = [];
    const api = new LobbyApi(null, async (u) => {
      urls.push(u);
      return new Response('{"sections":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await api.deckCards('Fire & Ice', 'brawl');
    expect(urls[0]).toBe('/api/decks/cards?name=Fire%20%26%20Ice&format=brawl');
    await expect(new LobbyApi(null, async () => new Response('no', { status: 404 })).deckCards('X')).resolves.toBeNull();
  });
});

describe('deck details from the server', () => {
  it('keeps well-formed entries and only WUBRG colours', () => {
    expect(deckDetails({ A: { cards: 60, colors: 'RxG', key: 'Bolt' }, B: { colors: 'R' }, C: 'junk', D: { cards: 40, key: '' } })).toEqual({
      A: { cards: 60, colors: 'RG', key: 'Bolt' },
      D: { cards: 40, colors: '' },
    });
    expect(deckDetails({ E: { cards: 100, colors: 'R', commander: 'Krenko', dupes: ['Bolt', 3] } })).toEqual({
      E: { cards: 100, colors: 'R', commander: 'Krenko', dupes: ['Bolt'] },
    });
    expect(deckDetails(undefined)).toEqual({});
  });

  it('comes with the deck names and the Neural label; an older server sends names only', async () => {
    const ok = (body: string) => async () => new Response(body, { status: 200 });
    const api = new LobbyApi(null, ok('{"decks":["A"],"details":{"A":{"cards":60,"colors":"R"}},"neuralLabel":" Lyra "}'));
    await expect(api.deckList()).resolves.toEqual({ names: ['A'], details: { A: { cards: 60, colors: 'R' } }, neuralLabel: 'Lyra' });
    await expect(new LobbyApi(null, ok('{"decks":["A"]}')).deckList()).resolves.toEqual({ names: ['A'], details: {} });
  });

  it('art crops carry the local token in the query, the card name encoded', () => {
    expect(new LobbyApi('tok/1', async () => new Response('')).cropUrl('Fire // Ice')).toBe('/api/art/crop/Fire%20%2F%2F%20Ice?t=tok%2F1');
    expect(new LobbyApi(null, async () => new Response('')).cropUrl('Bolt')).toBe('/api/art/crop/Bolt');
  });
});

describe('the deck gallery', () => {
  it('lists only decks with a commander in Brawl (an unreadable one stays for the game to judge)', () => {
    expect(playable(names, details, 'brawl')).toEqual(['Niv Brawl', 'Unreadable']);
    expect(playable(names, details, undefined)).toEqual(names);
  });

  it('lists only 60-card decks without a commander in Standard (sets and bans are the game\'s to judge)', () => {
    const more = { ...details, 'Pauper Elves': { cards: 40, colors: 'G' } };
    expect(playable([...names, 'Pauper Elves'], more, 'standard')).toEqual(['Azorius Control', 'Mono Red', 'Unreadable']);
  });

  it('greys out, rather than lists, a 60-card deck the server found off Standard', () => {
    const more = { ...details, 'Pauper Rats': { cards: 60, colors: 'B', standard: '31 cards aren’t in Standard' } };
    const all = [...names, 'Pauper Rats'];
    expect(playable(all, more, 'standard')).not.toContain('Pauper Rats');
    expect(offStandard(all, more)).toEqual(['Pauper Rats']);
  });

  it('searches deck names, key cards and commanders, and filters by any picked colour', () => {
    expect(filterDecks(names, details, 'teferi', new Set())).toEqual(['Azorius Control']);
    expect(filterDecks(names, details, '  NIV ', new Set())).toEqual(['Niv Brawl']);
    expect(filterDecks(names, details, '', new Set(['R']))).toEqual(['Mono Red', 'Niv Brawl']);
    expect(filterDecks(names, details, '', new Set(['W', 'G']))).toEqual(['Azorius Control']);
    expect(filterDecks(names, details, 'red', new Set(['U']))).toEqual([]);
  });
});

describe('picks', () => {
  it('recommends Neural in Constructed and Forge AI in Brawl (Neural plays Brawl untrained)', () => {
    expect(recommendedAi(undefined)).toBe('Neural');
    expect(recommendedAi('brawl')).toBe('Default');
    expect(recommendedAi('standard')).toBe('Default');
    expect(opponents('Lyra')[0]).toMatchObject({ ai: 'Neural', name: 'Lyra' });
  });

  it('with no Neural AI plugin: no Neural card, Forge AI recommended, a saved Neural pick dropped', () => {
    expect(opponents('Lyra', false).map((o) => o.ai)).toEqual(['Default', 'Cautious', 'Reckless', 'Experimental']);
    expect(recommendedAi(undefined, false)).toBe('Default');
    const store = memory();
    store.setItem('newGame.constructed', JSON.stringify({ deck: 'Mono Red', ai: 'Neural' }));
    expect(loadPicks(undefined, ['Mono Red'], (k) => store.getItem(k), null, false)).toEqual({ deck: 'Mono Red', ai: 'Default' });
  });

  it('comes back as last saved for that format, dropping what no longer exists', () => {
    const store = memory();
    const save = (k: string, v: string) => store.setItem(k, v);
    const load = (k: string) => store.getItem(k);
    savePicks({ deck: 'Mono Red', ai: 'Reckless', oppDeck: RANDOM_DECK }, save);
    savePicks({ format: 'brawl', deck: 'Niv Brawl', ai: 'Neural' }, save);
    expect(loadPicks(undefined, names, load)).toEqual({ deck: 'Mono Red', ai: 'Reckless', oppDeck: RANDOM_DECK });
    expect(loadPicks('brawl', ['Niv Brawl'], load)).toEqual({ format: 'brawl', deck: 'Niv Brawl', ai: 'Neural' });
    // The saved deck is gone: the lobby's last deck, else the first.
    expect(loadPicks(undefined, ['Azorius Control'], load, 'Azorius Control').deck).toBe('Azorius Control');
    expect(loadPicks(undefined, ['Azorius Control', 'X'], load, 'Gone').deck).toBe('Azorius Control');
    store.setItem('newGame.constructed', '{broken');
    expect(loadPicks(undefined, names, load)).toEqual({ deck: 'Azorius Control', ai: 'Neural' });
    store.setItem('newGame.constructed', '{"deck":"Mono Red","ai":"Nonsense"}');
    expect(loadPicks(undefined, names, load).ai).toBe('Neural');
  });

  it('Start resolves Random, flags it for Rematch, and gives the router only the AIs it takes', () => {
    const pool = ['A', 'B', 'C'];
    expect(startPlan({ deck: 'A', ai: 'Neural' }, pool)).toEqual({ create: { deck: 'A', ai: 'Neural' }, start: { deck: 'A', ai: 'Neural' } });
    expect(startPlan({ format: 'brawl', deck: RANDOM_DECK, ai: 'Reckless', oppDeck: RANDOM_DECK }, pool, () => 0.5)).toEqual({
      create: { deck: 'B', format: 'brawl', oppDeck: 'B' },
      start: { deck: 'B', ai: 'Reckless', deckRandom: true, oppDeck: 'B', oppDeckRandom: true },
    });
    expect(startPlan({ deck: 'A', ai: 'Default', oppDeck: 'C' }, pool)?.create).toEqual({ deck: 'A', oppDeck: 'C', ai: 'Default' });
    expect(startPlan({ deck: RANDOM_DECK, ai: 'Neural' }, [])).toBeNull();
    expect(startPlan({ ai: 'Neural' }, pool)).toBeNull();
  });
});

describe('handoff to the game page', () => {
  it('is read once', () => {
    const store = memory();
    rememberHandoff('ab12', { start: { deck: 'A', ai: 'Neural' }, line: 'A vs Lyra' }, store);
    expect(takeHandoff('ab12', store)).toEqual({ start: { deck: 'A', ai: 'Neural' }, line: 'A vs Lyra' });
    expect(takeHandoff('ab12', store)).toBeNull();
    expect(takeHandoff('other', store)).toBeNull();
  });

  it('survives broken storage', () => {
    const store = memory();
    store.setItem('forge-table.newGame.ab12', 'not json');
    expect(takeHandoff('ab12', store)).toBeNull();
    const broken = { getItem: () => { throw new Error('off'); }, removeItem: () => {}, setItem: () => { throw new Error('off'); } };
    expect(() => rememberHandoff('ab12', { import: true }, broken)).not.toThrow();
    expect(takeHandoff('ab12', broken)).toBeNull();
  });
});

describe('New game view', () => {
  const list: DeckList = { names, details, neuralLabel: 'Lyra' };
  const props = (o: Partial<NewGameProps> = {}): NewGameProps => ({
    decks: { constructed: list, brawl: list },
    picks: { deck: 'Mono Red', ai: 'Neural' },
    onPicks: () => {},
    onFormat: () => {},
    phone: false,
    cropUrl: (c) => `/crop/${c}`,
    blocked: null,
    creating: false,
    friends: { people: [{ key: 'k1', name: 'Bob', state: 'online' }, { key: 'k2', name: '<i>Eve</i>', state: 'online' }], guests: false },
    onStart: () => {},
    onImport: () => {},
    onFriend: () => {},
    onBack: () => {},
    ...o,
  });
  const html = (o?: Partial<NewGameProps>) => renderToStaticMarkup(createElement(NewGame, props(o)));

  it('shows the gallery with art, a Random tile, the opponents and the summary', () => {
    const h = html();
    expect(h.match(/data-testid="ng-deck"/g)?.length).toBe(4);
    expect(h).toContain('data-testid="ng-deck-random"');
    expect(h).toContain('src="/crop/Goblin Guide"');
    expect(h).toMatch(/class="ng-deck sel"[^>]*data-deck="Mono Red"/);
    expect(h).toMatch(/data-testid="ng-sum-deck">Mono Red</);
    expect(h).toMatch(/data-testid="ng-sum-opp">Lyra</);
    // Recommended sits in the name line, Lyra first.
    expect(h).toMatch(/data-ai="Neural">.*?<b>Lyra<span class="ng-rec">Recommended<\/span><\/b>/);
    expect(h).toContain('2 online');
    expect(h).not.toMatch(/disabled=""[^>]*data-testid="ng-start"/);
  });

  it('says why Start is off', () => {
    expect(html({ blocked: 'End a game to start another' })).toMatch(/disabled=""[^>]*data-testid="ng-start"/);
    expect(html({ blocked: 'End a game to start another' })).toContain('End a game to start another');
    expect(html({ picks: { ai: 'Neural' } })).toMatch(/disabled=""[^>]*data-testid="ng-start"/);
  });

  it('Brawl: recommends Forge AI, lists commander decks, and says how many it left out', () => {
    const h = html({ picks: { format: 'brawl', deck: 'Niv Brawl', ai: 'Default' } });
    expect(h.match(/data-testid="ng-deck"/g)?.length).toBe(2);
    expect(h).toMatch(/data-ai="Default">.*?<b>Forge AI<span class="ng-rec">/);
    expect(h).toContain('2 of your decks have no commander');
  });

  it('Brawl: the picked deck opens a drawer with its commander and a checklist', () => {
    const h = html({ picks: { format: 'brawl', deck: 'Niv Brawl', ai: 'Default' } });
    expect(h).toContain('data-testid="ng-brawl"');
    expect(h).toContain('src="/crop/Niv-Mizzet, Parun"');
    expect(h.match(/class="ok" data-testid="ng-check"/g)?.length).toBe(3);
    expect(html({ picks: { format: 'brawl', deck: 'Mono Red', ai: 'Default' } })).not.toContain('data-testid="ng-brawl"');
    expect(html()).not.toContain('data-testid="ng-brawl"');
  });

  it('a phone gets steps and a bar with the matchup and Start', () => {
    const h = html({ phone: true });
    expect(h).toContain('class="newgame phone"');
    expect(h).toContain('aria-current="step"');
    expect(h).toMatch(/class="ng-bar-line" aria-label="Mono Red vs Lyra"><b>Mono Red<\/b><span>vs Lyra<\/span>/);
    expect(h).toContain('data-testid="ng-next"');
    expect(h).toContain('data-testid="ng-start"');
  });

  it('A friend (A4): people online as tiles, the link and its switches, and Start says what it makes', () => {
    expect(html()).not.toContain('data-testid="ng-people"');
    const h = html({ friendFirst: true });
    expect(h).toMatch(/aria-pressed="true" data-testid="ng-friend"/);
    expect(h).not.toContain('data-testid="ng-opps"');
    expect(h.match(/data-testid="ng-person"/g)?.length).toBe(2);
    expect(h).toContain('<b>Bob</b>');
    expect(h).not.toContain('<i>');
    expect(h).not.toContain('k1');
    expect(h).toContain('data-testid="friend-listed" checked=""');
    expect(h).not.toContain('friend-guests');
    expect(h).toContain('for anyone signed in');
    expect(h).toMatch(/data-testid="ng-sum-opp">Whoever has the link</);
    expect(h).toMatch(/data-testid="ng-start"><span>Create link</);
    expect(h).not.toContain('data-testid="ng-opp-deck"');
    const g = html({ friendFirst: true, friends: { people: [], guests: true } });
    expect(g).toContain('Nobody else is online right now');
    expect(g).toContain('data-testid="friend-guests"');
    expect(g).toContain('data-testid="friend-guests"/>');
  });

  it('no A friend tab on a server without Play a friend', () => {
    expect(html({ friends: undefined, friendFirst: true })).not.toContain('data-testid="ng-friend"');
    expect(html({ friends: undefined, friendFirst: true })).toContain('data-testid="ng-opps"');
  });

  it('every deck has a Cards peek where the server lists cards, and the AI deck is a chip, not a select', () => {
    expect(html()).not.toContain('data-testid="ng-peek"');
    const h = html({ cardsOf: async () => null });
    expect(h.match(/data-testid="ng-peek"/g)?.length).toBe(4);
    expect(h).toContain('data-testid="ng-sum-peek"');
    expect(h).toMatch(/aria-label="Their deck: Lyra picks. Change" data-testid="ng-opp-deck"/);
    expect(h).not.toContain('<select');
  });

  it('Standard: a deck the server found off-format is greyed out with why, after the rest', () => {
    const off: DeckList = { names: [...names, 'Pauper Rats'], details: { ...details, 'Pauper Rats': { cards: 60, colors: 'B', standard: 'Banned: Rat Colony' } } };
    const h = html({ decks: { constructed: off, brawl: list }, picks: { format: 'standard', deck: 'Mono Red', ai: 'Default' } });
    expect(h).toContain('Not Standard-legal · 1');
    expect(h).toMatch(/disabled=""[^>]*data-deck="Pauper Rats"/);
    expect(h).toContain('Banned: Rat Colony');
  });

  it('the Random tile shows art from the decks it draws from', () => {
    expect(mosaicKeys(names, details)).toEqual(['Teferi, Hero of Dominaria', 'Goblin Guide', 'Niv-Mizzet, Parun']);
    expect(html()).toMatch(/class="ng-art ng-mosaic n3"/);
  });

  it('while decks load, and on a server that cannot list them', () => {
    expect(html({ decks: { constructed: undefined, brawl: undefined } })).toContain('Loading your decks');
    expect(html({ decks: { constructed: null, brawl: null } })).toContain('can’t list decks');
  });
});

describe('Brawl checklist', () => {
  it('names what is wrong', () => {
    const c = brawlChecks({ cards: 99, colors: 'R', commander: 'Krenko', dupes: ['A', 'B', 'C', 'D', 'E', 'F'] });
    expect(c.map((x) => x.ok)).toEqual([true, false, false]);
    expect(c[1]!.text).toBe('99 cards: Brawl needs 100, commander included');
    expect(c[2]!.text).toBe('More than one copy: A, B, C, D and 2 more');
    expect(brawlChecks({ cards: 100, colors: '' }).map((x) => x.ok)).toEqual([false, true, true]);
  });
});
