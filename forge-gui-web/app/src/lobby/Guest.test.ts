import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GuestApi } from './api';
import { GuestJoin, guestReady, openWhenUp } from './Guest';

describe('the guest join page', () => {
  it('offers signing in (the usual /join/<code>) or playing as a guest', () => {
    const html = renderToStaticMarkup(createElement(GuestJoin, { api: new GuestApi(), code: 'abc123def456' }));
    expect(html).toContain('href="/join/abc123def456"');
    expect(html).toContain('Play as guest');
    expect(html).not.toContain('data-testid="guest-name"');
  });

  it('asks a guest for a name and a deck', () => {
    const html = renderToStaticMarkup(createElement(GuestJoin, { api: new GuestApi(), code: 'abc123def456', initial: 'guest' }));
    expect(html).toContain('data-testid="guest-name"');
    expect(html).toContain('maxLength="24"');
    expect(html).toContain('Loading decks…');
    expect(html).toMatch(/data-testid="guest-go"[^>]*disabled|disabled=""[^>]*data-testid="guest-go"/);
  });

  it('needs a name with something in it and a deck', () => {
    expect(guestReady('Gus', 'shared-deck')).toBe(true);
    expect(guestReady('   ', 'shared-deck')).toBe(false);
    expect(guestReady('Gus', '')).toBe(false);
  });

  it('opens the table once it answers, or after the wait anyway', async () => {
    const went: string[] = [];
    let up = 0;
    const api = { tableUp: async () => ++up >= 3, tableUrl: (id: string) => `/g/${id}/` };
    const slept: number[] = [];
    await openWhenUp(api, 'ab12', (u) => went.push(u), async (ms) => void slept.push(ms));
    expect(went).toEqual(['/g/ab12/']);
    expect(slept.length).toBe(2);
    const never = { tableUp: async () => false, tableUrl: (id: string) => `/g/${id}/` };
    await openWhenUp(never, 'cd34', (u) => went.push(u), async () => {}, 3000);
    expect(went).toEqual(['/g/ab12/', '/g/cd34/']);
  });
});
