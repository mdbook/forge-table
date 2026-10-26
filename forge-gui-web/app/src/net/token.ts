/**
 * Session token handling: the token arrives in the URL fragment (`#t=…`), is moved to
 * a SameSite cookie (card images at /img need it) and sessionStorage (reloads), and the fragment is
 * stripped from the address bar so it never lands in history or screenshots.
 */

const STORAGE_KEY = 'forge-table.token';

/**
 * The path the page is served under: `/` from a plain sidecar, `/m/<id>/` for a game behind the multi-game
 * router, `/g/<id>/` for a guest's seat (no login). The socket, card
 * images and the image cookie all live under it, so games sharing an origin never see each other's cookie.
 */
export function basePath(loc: Pick<Location, 'pathname'> = window.location): string {
  const m = /^\/[mg]\/[0-9a-f]+\//.exec(loc.pathname);
  return m ? m[0] : '/';
}

/** True on a guest's table (`/g/<id>/`): there is no lobby to go back to, only `/g/bye`. */
export function guestTable(loc: Pick<Location, 'pathname'> = window.location): boolean {
  return /^\/g\/[0-9a-f]+\//.test(loc.pathname);
}

/** True when the page is a game behind the router (it may then have no token: the proxy login identifies the player). */
export function underRouter(loc: Pick<Location, 'pathname'> = window.location): boolean {
  return basePath(loc) !== '/';
}

function readStorage(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStorage(token: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Private mode / storage disabled: the cookie and this page's memory still hold it.
  }
}

/**
 * Extract the token from `#t=…` (or `?t=…` for `vite dev`), persist it, and clean the URL. `cookie: false` (the
 * router's lobby, which sends the token as a header) sets no cookie, so the only `ft` cookies behind the router
 * are the per-game ones under `/m/<id>/`.
 */
export function takeToken(loc: Location = window.location, hist: History = window.history, cookie = true): string | null {
  const frag = new URLSearchParams(loc.hash.replace(/^#/, ''));
  const query = new URLSearchParams(loc.search);
  const fromUrl = frag.get('t') ?? query.get('t');
  const path = basePath(loc);
  if (fromUrl) {
    writeStorage(fromUrl);
    if (cookie) document.cookie = `ft=${encodeURIComponent(fromUrl)}; path=${path}; SameSite=Strict`;
    if (frag.has('t')) {
      frag.delete('t');
      const rest = frag.toString();
      hist.replaceState(hist.state, '', `${loc.pathname}${loc.search}${rest ? `#${rest}` : ''}`);
    }
    return fromUrl;
  }
  const stored = readStorage();
  if (stored && cookie) document.cookie = `ft=${encodeURIComponent(stored)}; path=${path}; SameSite=Strict`;
  return stored;
}

/**
 * The WebSocket URL: the page's own host (`/ws`, or `/m/<id>/ws` behind the router), or `VITE_BRIDGE=host:port` / `?bridge=host:port` when
 * the page is served by `vite dev` (the sidecar must trust that origin via -Dforge.bridge.devOrigin).
 */
export function wsUrl(loc: Location = window.location): string {
  const query = new URLSearchParams(loc.search);
  const env = (import.meta.env?.VITE_BRIDGE as string | undefined) || undefined;
  const bridge = query.get('bridge') ?? env;
  const host = bridge && bridge.length > 0 ? bridge : loc.host;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${host}${bridge && bridge.length > 0 ? '/' : basePath(loc)}ws`;
}

/**
 * The URL of a card image: same-origin `/img/card/<key>` (the `ft` cookie authenticates it), or the bridge's
 * own origin with `?t=` when the page comes from `vite dev` (`?bridge=` / VITE_BRIDGE), where the cookie
 * would not be sent. `kind` `crop`: `/img/crop/<key>`, the illustration alone (with the artist in a header);
 * `avatar`: `/img/avatar/neural`, the Neural AI's picture.
 */
export function imageUrl(key: string, token: string | null, loc: Location = window.location, kind: 'card' | 'crop' | 'avatar' = 'card'): string {
  const query = new URLSearchParams(loc.search);
  const env = (import.meta.env?.VITE_BRIDGE as string | undefined) || undefined;
  const bridge = query.get('bridge') ?? env;
  const path = `${basePath(loc)}img/${kind}/${encodeURIComponent(key)}`;
  if (!bridge || bridge === loc.host) return path;
  const t = token ? `?t=${encodeURIComponent(token)}` : '';
  return `${loc.protocol === 'https:' ? 'https:' : 'http:'}//${bridge}${path}${t}`;
}
