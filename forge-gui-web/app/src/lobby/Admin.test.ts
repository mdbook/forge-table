import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdminSection, adminMode, adminSides, adminState, spanText, updateConfirmText } from './Admin';
import { LobbyApi, type AdminList, type AdminMatch } from './api';

const LIST: AdminList = {
  matches: [
    { id: 'a1', owner: 'robin', created: 1, status: 'playing', connected: true },
    { id: 'b2', owner: 'liam', created: 2, status: 'over', connected: false },
  ],
};

const render = (isAdmin: boolean, list: AdminList | null = LIST) =>
  renderToStaticMarkup(createElement(AdminSection, { isAdmin, list, api: new LobbyApi(null), onList: () => {}, onError: () => {} }));

describe('lobby admin section', () => {
  it('is hidden for non-admins', () => {
    expect(render(false)).toBe('');
  });

  it('lists every game with its owner and status, and an End per row (an older server: no players or table)', () => {
    const html = render(true);
    expect(html).toContain('data-testid="lobby-admin"');
    expect(html).toContain('robin');
    expect(html).toContain('liam');
    expect(html).toContain('Finished');
    expect(html.match(/data-testid="admin-end"/g)?.length).toBe(2);
    expect(html).toContain('Update now');
    expect(html).toContain('data-testid="admin-danger"');
  });

  it('shows the server strip: state, uptime, games against the cap, online, guests, build', () => {
    const html = renderToStaticMarkup(
      createElement(AdminSection, {
        isAdmin: true,
        now: 3 * 3_600_000 + 5 * 60_000,
        list: { ...LIST, server: { build: 'd8c615f70295', started: 0, games: 2, maxMatches: 6, maxPerUser: 3, online: 4, guests: true } },
        api: new LobbyApi(null),
        onList: () => {},
        onError: () => {},
      }),
    );
    expect(html).toContain('data-testid="admin-server"');
    expect(html).toContain('Running');
    expect(html).toContain('3 h 5 min');
    expect(html).toMatch(/2 <span class="of">\/ 6<\/span>/);
    expect(html).toContain('Allowed');
    expect(html).toContain('<code>d8c615f7</code>');
  });

  it('marks my own games, shows ages instead of clock times, and styles Update now as dangerous', () => {
    const html = renderToStaticMarkup(
      createElement(AdminSection, { isAdmin: true, me: 'robin', now: 1 + 5 * 60_000, list: LIST, api: new LobbyApi(null), onList: () => {}, onError: () => {} }),
    );
    expect(html.match(/ \(you\)/g)?.length).toBe(1);
    expect(html).toContain('5 min ago');
    expect(html).toMatch(/class="btn danger"[^>]*data-testid="admin-update"/);
  });

  it('shows the countdown instead of the button while restarting', () => {
    const html = render(true, { ...LIST, restartIn: 42 });
    expect(html).toContain('games end in 42 s');
    expect(html).not.toContain('data-testid="admin-update"');
  });

  it('says how many games Update now ends', () => {
    expect(updateConfirmText(0)).toBe('Restart the server now? No game is open.');
    expect(updateConfirmText(1)).toBe('Restart the server now? 1 game will end in 60 s (the players are warned).');
    expect(updateConfirmText(3)).toContain('3 games will end');
  });
});

const AI: AdminMatch = {
  id: 'a1', owner: 'alex', created: 0, status: 'playing', connected: true, mode: 'ai', ai: 'Neural',
  players: [{ seat: 0, name: 'alex', connected: true }],
  table: { turn: 5, active: 0, seats: [{ life: 20, deck: 'White Aggro', key: 'Thalia' }, { life: 19, deck: 'Grixis Affinity', key: 'Thoughtcast' }] },
};
const FRIEND: AdminMatch = {
  id: 'b2', owner: 'alex', created: 0, status: 'playing', connected: false, mode: 'pvp', lastSeen: 0,
  players: [{ seat: 0, name: 'alex', connected: false }, { seat: 1, name: 'robin', connected: true }],
};
const GUEST: AdminMatch = {
  id: 'c3', owner: 'liam', created: 0, status: 'starting', connected: false, mode: 'pvp', waiting: true, guests: true,
  players: [{ seat: 0, name: 'liam', connected: false }],
};

describe('admin rows', () => {
  it('names the mode: AI, a friend, or a friend who came in as a guest', () => {
    expect(adminMode(AI)).toBe('ai');
    expect(adminMode(FRIEND)).toBe('friend');
    expect(adminMode(GUEST)).toBe('friend');
    expect(adminMode({ ...FRIEND, players: [FRIEND.players![0]!, { seat: 1, name: 'Gus (guest)', guest: true, connected: true }] })).toBe('guest');
    expect(adminMode({ id: 'x', owner: 'o', created: 0, status: 'ready', connected: false })).toBe('ai');
  });

  it('puts the AI opposite its owner, by its name here, each side with its deck, art and life', () => {
    const [me, ai] = adminSides(AI, 'alex', 'Lyra');
    expect(me).toMatchObject({ name: 'alex', you: true, connected: true, deck: 'White Aggro', card: 'Thalia', life: 20, turn: true });
    expect(ai).toMatchObject({ name: 'Lyra', connected: null, deck: 'Grixis Affinity', life: 19, turn: false });
  });

  it("marks the Neural AI's side, which shows its picture when the server has one", () => {
    expect(adminSides(AI, 'alex', 'Lyra')[1]?.neural).toBe(true);
    expect(adminSides({ ...AI, ai: 'Default' }, 'alex', 'Lyra')[1]?.neural).toBeUndefined();
    const props = { isAdmin: true, me: 'alex', now: 7 * 60_000, neuralLabel: 'Lyra', list: { matches: [AI, FRIEND] }, api: new LobbyApi(null), onList: () => {}, onError: () => {} };
    const html = renderToStaticMarkup(createElement(AdminSection, { ...props, neuralAvatar: '/api/neural/avatar' }));
    expect(html.match(/<img class="ai-photo[^>]*>/g)).toEqual(['<img class="ai-photo vs-photo" src="/api/neural/avatar" alt="Lyra" draggable="false" data-testid="ai-photo"/>']);
    expect(renderToStaticMarkup(createElement(AdminSection, props))).not.toContain('ai-photo');
  });

  it('gives each person their own connection, and an empty seat while waiting', () => {
    const [a, b] = adminSides(FRIEND, undefined, undefined);
    expect([a.connected, b?.connected]).toEqual([false, true]);
    expect(adminSides(GUEST, undefined, undefined)[1]).toBeNull();
  });

  it('says how far along a game is', () => {
    expect(adminState(AI).text).toBe('Turn 5');
    expect(adminState(GUEST)).toEqual({ text: 'Waiting for a friend', sub: 'Guests allowed' });
    expect(adminState({ ...GUEST, waiting: undefined, progress: { label: 'Loading cards', pct: 39.6 } } as AdminMatch).text).toBe('Loading cards · 40%');
    expect(adminState({ ...FRIEND, status: 'crashed', error: 'out of memory' })).toEqual({ text: 'Crashed: out of memory', warn: true });
  });

  it('renders a row per game with its mode badge, players, decks, life and who is not at the table', () => {
    const html = renderToStaticMarkup(
      createElement(AdminSection, { isAdmin: true, me: 'alex', now: 7 * 60_000, neuralLabel: 'Lyra', list: { matches: [AI, FRIEND, GUEST] }, api: new LobbyApi(null), onList: () => {}, onError: () => {} }),
    );
    expect(html.match(/class="ag-mode mode-ai"/g)?.length).toBe(1);
    expect(html.match(/class="ag-mode mode-friend"/g)?.length).toBe(2);
    expect(html).toContain('Lyra');
    expect(html).toContain('White Aggro  ·  Grixis Affinity');
    expect(html).toMatch(/<b class="turn">20<\/b>/);
    expect(html).toContain('nobody yet');
    expect(html).toContain('nobody on · 7 min');
    expect(html).toContain('aria-label="not connected"');
  });

  it('spans: seconds, minutes, hours, days', () => {
    expect(spanText(40_000)).toBe('40 s');
    expect(spanText(12 * 60_000)).toBe('12 min');
    expect(spanText(3 * 3_600_000)).toBe('3 h');
    expect(spanText(50 * 3_600_000)).toBe('2 d 2 h');
  });
});

describe('admin API calls', () => {
  it('uses the admin endpoints, JSON for Update now', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const api = new LobbyApi('tok', async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ matches: [] }), { status: 200 });
    });
    await api.adminList();
    await api.adminEnd('a1');
    await api.updateNow();
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      'GET /api/admin/matches',
      'DELETE /api/admin/matches/a1',
      'POST /api/admin/update',
    ]);
    expect((calls[2]!.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });
});
