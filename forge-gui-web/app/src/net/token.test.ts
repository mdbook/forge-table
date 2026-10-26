import { describe, expect, it } from 'vitest';
import { basePath, guestTable, imageUrl, takeToken, underRouter, wsUrl } from './token';

function loc(href: string): Location {
  const u = new URL(href);
  return { pathname: u.pathname, search: u.search, host: u.host, protocol: u.protocol, hash: u.hash } as Location;
}

describe('page base path', () => {
  it('is / for a plain sidecar and /m/<id>/ behind the router', () => {
    expect(basePath(loc('http://127.0.0.1:5000/'))).toBe('/');
    expect(basePath(loc('http://127.0.0.1:5000/index.html'))).toBe('/');
    expect(basePath(loc('https://forge.example/m/3fa9c2/'))).toBe('/m/3fa9c2/');
    expect(basePath(loc('https://forge.example/m/3fa9c2/index.html?test=1'))).toBe('/m/3fa9c2/');
    expect(underRouter(loc('https://forge.example/m/3fa9c2/'))).toBe(true);
    expect(underRouter(loc('http://127.0.0.1:5000/'))).toBe(false);
  });

  it('puts the socket and images under it', () => {
    expect(wsUrl(loc('http://127.0.0.1:5000/'))).toBe('ws://127.0.0.1:5000/ws');
    expect(wsUrl(loc('https://forge.example/m/3fa9c2/'))).toBe('wss://forge.example/m/3fa9c2/ws');
    expect(imageUrl('a b', 'tok', loc('http://127.0.0.1:5000/'))).toBe('/img/card/a%20b');
    expect(imageUrl('a b', null, loc('https://forge.example/m/3fa9c2/'))).toBe('/m/3fa9c2/img/card/a%20b');
  });

  it('puts art crops under /img/crop/ the same way', () => {
    expect(imageUrl('a b', 'tok', loc('http://127.0.0.1:5000/'), 'crop')).toBe('/img/crop/a%20b');
    expect(imageUrl('a b', null, loc('https://forge.example/m/3fa9c2/'), 'crop')).toBe('/m/3fa9c2/img/crop/a%20b');
    expect(imageUrl('k', 'tok', loc('http://localhost:5173/?bridge=127.0.0.1:5000'), 'crop')).toBe('http://127.0.0.1:5000/img/crop/k?t=tok');
  });

  it("puts the Neural AI's picture under /img/avatar/ the same way", () => {
    expect(imageUrl('neural', 'tok', loc('http://127.0.0.1:5000/'), 'avatar')).toBe('/img/avatar/neural');
    expect(imageUrl('neural', null, loc('https://forge.example/m/3fa9c2/'), 'avatar')).toBe('/m/3fa9c2/img/avatar/neural');
    expect(imageUrl('neural', null, loc('https://forge.example/g/3fa9c2/'), 'avatar')).toBe('/g/3fa9c2/img/avatar/neural');
    expect(imageUrl('neural', 'tok', loc('http://localhost:5173/?bridge=127.0.0.1:5000'), 'avatar')).toBe('http://127.0.0.1:5000/img/avatar/neural?t=tok');
  });

  it('is /g/<id>/ on a guest table, with the socket and images under it too', () => {
    const g = loc('https://forge.example/g/3fa9c2/');
    expect(basePath(g)).toBe('/g/3fa9c2/');
    expect(underRouter(g)).toBe(true);
    expect(guestTable(g)).toBe(true);
    expect(wsUrl(g)).toBe('wss://forge.example/g/3fa9c2/ws');
    expect(imageUrl('a b', null, g)).toBe('/g/3fa9c2/img/card/a%20b');
    expect(guestTable(loc('https://forge.example/m/3fa9c2/'))).toBe(false);
    expect(guestTable(loc('https://forge.example/g/join/abcdef12'))).toBe(false);
    expect(basePath(loc('https://forge.example/g/join/abcdef12'))).toBe('/');
  });

  it('keeps the vite-dev bridge override', () => {
    expect(wsUrl(loc('http://localhost:5173/?bridge=127.0.0.1:5000'))).toBe('ws://127.0.0.1:5000/ws');
    expect(imageUrl('k', 'tok', loc('http://localhost:5173/?bridge=127.0.0.1:5000'))).toBe('http://127.0.0.1:5000/img/card/k?t=tok');
  });
});

describe('the ft cookie', () => {
  function fakeDocument(): string[] {
    const set: string[] = [];
    (globalThis as { document?: unknown }).document = {
      set cookie(v: string) {
        set.push(v);
      },
    };
    return set;
  }
  const hist = { state: null, replaceState: () => {} } as unknown as History;

  it('is scoped to the game path behind the router', () => {
    const set = fakeDocument();
    expect(takeToken(loc('http://127.0.0.1:8790/m/3fa9c2/#t=tok'), hist)).toBe('tok');
    expect(set).toEqual(['ft=tok; path=/m/3fa9c2/; SameSite=Strict']);
  });

  it('is not set by the lobby', () => {
    const set = fakeDocument();
    expect(takeToken(loc('http://127.0.0.1:8790/#t=tok'), hist, false)).toBe('tok');
    expect(set).toEqual([]);
  });
});
