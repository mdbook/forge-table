import { describe, expect, it } from 'vitest';
import { canOpen, GuestApi, LobbyApi, LobbyError, openCount, openingStep, TOKEN_HEADER, type MatchInfo, type MatchList } from './api';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(status: number, body: string, calls: Call[] = []) {
  return async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status });
  };
}

const LIST: MatchList = {
  user: 'alice',
  maxPerUser: 3,
  maxMatches: 8,
  matches: [
    { id: 'a1', status: 'playing', created: 1 },
    { id: 'b2', status: 'crashed', created: 2, error: 'the game process exited (code 1)' },
  ],
};

describe('LobbyApi', () => {
  it('lists with the local token as a header', async () => {
    const calls: Call[] = [];
    const api = new LobbyApi('tok', fakeFetch(200, JSON.stringify(LIST), calls));
    await expect(api.list()).resolves.toEqual(LIST);
    expect(calls[0]!.url).toBe('/api/matches');
    expect(calls[0]!.init?.method).toBe('GET');
    expect((calls[0]!.init?.headers as Record<string, string>)[TOKEN_HEADER]).toBe('tok');
  });

  it('sends no token header behind a proxy login', async () => {
    const calls: Call[] = [];
    await new LobbyApi(null, fakeFetch(200, JSON.stringify(LIST), calls)).list();
    expect(calls[0]!.init?.headers).toEqual({});
  });

  it('creates with a JSON body', async () => {
    const calls: Call[] = [];
    const api = new LobbyApi(null, fakeFetch(201, '{"id":"c3","status":"starting","created":3}', calls));
    await expect(api.create({ ai: 'Neural' })).resolves.toEqual({ id: 'c3', status: 'starting', created: 3 });
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.body).toBe('{"ai":"Neural"}');
    expect((calls[0]!.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('surfaces the server message at the caps', async () => {
    const api = new LobbyApi(null, fakeFetch(429, '{"error":"You already have 3 games open (the limit is 3). End one to start another."}'));
    const err = await api.create().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LobbyError);
    expect((err as LobbyError).status).toBe(429);
    expect((err as LobbyError).message).toMatch(/limit is 3/);
    const full = await new LobbyApi(null, fakeFetch(503, '{"error":"The server is full (8 games running)."}')).create().catch((e: unknown) => e);
    expect((full as LobbyError).message).toMatch(/server is full/);
  });

  it('turns plain-text auth failures into readable messages', async () => {
    const e401 = await new LobbyApi(null, fakeFetch(401, 'not signed in')).list().catch((e: unknown) => e);
    expect((e401 as LobbyError).message).toMatch(/not signed in/i);
    const e403 = await new LobbyApi(null, fakeFetch(403, 'not your game')).end('x').catch((e: unknown) => e);
    expect((e403 as LobbyError).message).toMatch(/access/);
    const down = await new LobbyApi(null, () => Promise.reject(new TypeError('fetch failed'))).list().catch((e: unknown) => e);
    expect((down as LobbyError).status).toBe(0);
  });

  it('toggles upload with a PUT', async () => {
    const calls: Call[] = [];
    const l = await new LobbyApi(null, fakeFetch(200, JSON.stringify({ ...LIST, upload: { on: true } }), calls)).setUpload(true);
    expect(calls[0]!.url).toBe('/api/upload');
    expect(calls[0]!.init?.method).toBe('PUT');
    expect(calls[0]!.init?.body).toBe('{"on":true}');
    expect(l.upload).toEqual({ on: true });
  });

  it('ends a game by id', async () => {
    const calls: Call[] = [];
    await new LobbyApi(null, fakeFetch(200, JSON.stringify({ ...LIST, matches: [] }), calls)).end('a1');
    expect(calls[0]!.url).toBe('/api/matches/a1');
    expect(calls[0]!.init?.method).toBe('DELETE');
  });

  it('links to a game under /m/<id>/, with the local token in the fragment only', () => {
    expect(new LobbyApi('tok').matchUrl('a1')).toBe('/m/a1/#t=tok');
    expect(new LobbyApi(null).matchUrl('a1')).toBe('/m/a1/');
  });

  it('passes the drain flag on', async () => {
    const l = await new LobbyApi(null, fakeFetch(200, JSON.stringify({ ...LIST, draining: true }))).list();
    expect(l.draining).toBe(true);
    const full = await new LobbyApi(null, fakeFetch(503, '{"error":"Server is updating, new games are paused."}')).create().catch((e: unknown) => e);
    expect((full as LobbyError).message).toBe('Server is updating, new games are paused.');
  });

  it('counts open games and knows which can be opened', () => {
    expect(openCount(LIST)).toBe(2);
    expect(canOpen({ id: 'x', status: 'starting', created: 0 })).toBe(false);
    expect(canOpen({ id: 'x', status: 'over', created: 0 })).toBe(true);
    expect(canOpen({ id: 'x', status: 'crashed', created: 0 })).toBe(false);
  });
});

describe('opening a new game', () => {
  const s = (status: MatchInfo['status'], error?: string): MatchInfo => ({ id: 'n1', status, created: 1, ...(error ? { error } : {}) });

  it('waits while it starts and opens it once it is up', () => {
    expect(openingStep([s('starting')], 'n1', false)).toEqual({ kind: 'wait' });
    expect(openingStep([s('ready')], 'n1', true)).toEqual({ kind: 'open' });
  });

  it('keeps waiting on a stale list from before the game existed', () => {
    expect(openingStep([], 'n1', false)).toEqual({ kind: 'gone', ended: false });
  });

  it('gives up once a listed game is gone, and reports a crash', () => {
    expect(openingStep([], 'n1', true)).toEqual({ kind: 'gone', ended: true });
    expect(openingStep([s('crashed', 'boom')], 'n1', true)).toEqual({ kind: 'crashed', error: 'boom' });
  });
});

describe('pvp calls', () => {
  const game: MatchInfo = { id: 'g1', status: 'ready', created: 1, mode: 'pvp', seat: 0, waiting: true, players: [{ seat: 0, name: 'kai' }] };

  it('creates a pvp game with its deck and listing', async () => {
    const calls: Call[] = [];
    await new LobbyApi(null, fakeFetch(200, JSON.stringify(game), calls)).create({ mode: 'pvp', deck: 'Mono Red', listed: false });
    expect(calls[0]!.url).toBe('/api/matches');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ mode: 'pvp', deck: 'Mono Red', listed: false });
  });

  it('joins by link or by listed id with a deck, and surfaces the server’s words on failure', async () => {
    const calls: Call[] = [];
    await new LobbyApi(null, fakeFetch(200, JSON.stringify(game), calls)).join({ code: 'abc', deck: 'D' });
    expect(calls[0]!.url).toBe('/api/join');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ code: 'abc', deck: 'D' });
    const gone = await new LobbyApi(null, fakeFetch(404, '{"error":"That invite has expired or was already used."}')).join({ code: 'x', deck: 'D' }).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(LobbyError);
    expect((gone as LobbyError).message).toBe('That invite has expired or was already used.');
    expect((gone as LobbyError).status).toBe(404);
  });

  it('asks for a new link on the game', async () => {
    const calls: Call[] = [];
    await new LobbyApi(null, fakeFetch(200, JSON.stringify(game), calls)).newInvite('g/1');
    expect(calls[0]!.url).toBe('/api/matches/g%2F1/invite');
    expect(calls[0]!.init?.method).toBe('POST');
  });

  it('invites someone online by their handle, and declines an invite by game', async () => {
    const calls: Call[] = [];
    const api = new LobbyApi(null, fakeFetch(200, JSON.stringify(LIST), calls));
    await api.create({ mode: 'pvp', deck: 'Burn', listed: true, invite: 'k3y' });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ mode: 'pvp', deck: 'Burn', listed: true, invite: 'k3y' });
    await api.decline('g/1');
    expect(calls[1]!.url).toBe('/api/matches/g%2F1/decline');
    expect(calls[1]!.init?.method).toBe('POST');
    expect(calls[1]!.init?.body).toBe('{}');
    const stale = await new LobbyApi(null, fakeFetch(400, '{"error":"They\'re not online any more."}')).create({ mode: 'pvp', deck: 'B', invite: 'x' }).catch((e: unknown) => e);
    expect((stale as LobbyError).message).toBe('They\'re not online any more.');
  });

  it('lists my decks, or says null when the server has no deck list (type the name)', async () => {
    await expect(new LobbyApi(null, fakeFetch(200, '{"decks":["A","B",3]}')).decks()).resolves.toEqual(['A', 'B']);
    await expect(new LobbyApi(null, fakeFetch(404, 'Not found')).decks()).resolves.toBeNull();
    await expect(new LobbyApi(null, fakeFetch(200, '{}')).decks()).resolves.toBeNull();
    await expect(new LobbyApi(null, fakeFetch(401, '')).decks()).rejects.toBeInstanceOf(LobbyError);
    const calls: Call[] = [];
    await expect(new LobbyApi(null, fakeFetch(200, '{"decks":["Krenko"]}', calls)).decks('brawl')).resolves.toEqual(['Krenko']);
    expect(calls[0]!.url).toBe('/api/decks?format=brawl');
  });

  it("says whether the server has the Neural AI's picture, and where it is", async () => {
    const list = await new LobbyApi(null, fakeFetch(200, '{"decks":["A"],"neuralLabel":"Ada","neuralAvatar":true}')).deckList();
    expect(list).toMatchObject({ neuralLabel: 'Ada', neuralAvatar: true });
    expect(await new LobbyApi(null, fakeFetch(200, '{"decks":["A"],"neuralAvatar":"yes"}')).deckList()).not.toHaveProperty('neuralAvatar');
    expect(await new LobbyApi(null, fakeFetch(200, '{"decks":["A"]}')).deckList()).not.toHaveProperty('neuralAvatar');
    expect(new LobbyApi(null).neuralAvatarUrl()).toBe('/api/neural/avatar');
    expect(new LobbyApi('a b').neuralAvatarUrl()).toBe('/api/neural/avatar?t=a%20b');
  });
});

describe('guest calls', () => {
  it('sends "Allow guests" in the create body', async () => {
    const calls: Call[] = [];
    await new LobbyApi(null, fakeFetch(201, '{"id":"g1","status":"ready","created":1}', calls)).create({ mode: 'pvp', deck: 'Burn', listed: false, guests: true });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ mode: 'pvp', deck: 'Burn', listed: false, guests: true });
  });

  it('only ever calls /g/api/*, with no token, and the table at /g/<id>/', async () => {
    const calls: Call[] = [];
    const api = new GuestApi(fakeFetch(200, '{"decks":["shared-deck",3],"details":{"shared-deck":{"cards":60,"colors":"R","key":"Lightning Bolt"},"bad":{}}}', calls));
    await expect(api.decks('c0de/x')).resolves.toEqual({ names: ['shared-deck'], details: { 'shared-deck': { cards: 60, colors: 'R', key: 'Lightning Bolt' } } });
    expect(calls[0]!.url).toBe('/g/api/decks?code=c0de%2Fx');
    expect(calls[0]!.init?.headers).toEqual({});
    await api.join({ code: 'c0de', name: 'Gus', deck: 'shared-deck' });
    expect(calls[1]!.url).toBe('/g/api/join');
    expect(calls[1]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ code: 'c0de', name: 'Gus', deck: 'shared-deck' });
    expect((calls[1]!.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(api.tableUrl('ab12')).toBe('/g/ab12/');
    expect(api.cropUrl('c0de/x', 'Fire // Ice')).toBe('/g/api/art/crop/Fire%20%2F%2F%20Ice?code=c0de%2Fx');
  });

  it('surfaces the server’s words for a dead link, and the table is up only on a 2xx', async () => {
    const dead = await new GuestApi(fakeFetch(404, '{"error":"That invite has expired or was already used."}')).decks('x').catch((e: unknown) => e);
    expect((dead as LobbyError).message).toBe('That invite has expired or was already used.');
    const calls: Call[] = [];
    await expect(new GuestApi(fakeFetch(503, 'starting', calls)).tableUp('ab12')).resolves.toBe(false);
    expect(calls[0]!.init?.method).toBe('HEAD');
    await expect(new GuestApi(fakeFetch(200, '')).tableUp('ab12')).resolves.toBe(true);
  });
});
