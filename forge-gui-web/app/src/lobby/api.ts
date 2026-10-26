/**
 * The multi-game router's lobby API: list, start and end your own games. With a proxy
 * login the router knows who you are; in local mode every call carries the router's token.
 */

/** A game's format: `'brawl'` is Competitive Brawl, `'standard'` Standard; absent = Constructed. */
export type LobbyFormat = 'brawl' | 'standard';

export type MatchStatus = 'starting' | 'ready' | 'playing' | 'over' | 'crashed' | 'stopping' | 'paused';

/** How far a starting game has got. The label is the router's own (never text from the game process). */
export interface BootProgress {
  /** java, cards, ai or table. */
  stage: string;
  label: string;
  /** The whole boot, 0–100; never goes back. */
  pct: number;
  /** Seconds since the game was created, by the server's clock. */
  elapsed: number;
}

/** A human-vs-human game's join link (seat 0 only, while the game waits for a friend). */
export interface Invite {
  /** Absolute https://…/join/<code>, or https://…/g/join/<code> when it lets guests in. */
  url: string;
  /** Epoch milliseconds. */
  expires: number;
  /** The link also works for someone without a login (a guest). */
  guests?: boolean;
}

export interface MatchPlayer {
  seat: 0 | 1;
  name: string;
}

export interface MatchInfo {
  id: string;
  status: MatchStatus;
  /** Epoch milliseconds. */
  created: number;
  /** Why a game crashed or failed to start. */
  error?: string;
  /** While starting (older servers send none). */
  progress?: BootProgress;
  /** `pvp` = a human opponent; absent (older servers) means `ai`. */
  mode?: 'ai' | 'pvp';
  format?: LobbyFormat;
  /** My seat in a pvp game: 0 made it, 1 joined it. */
  seat?: 0 | 1;
  /** Names only. A pvp game has one entry until a friend joins. */
  players?: MatchPlayer[];
  /** pvp: seat 1 is still empty (the process may already be up). */
  waiting?: true;
  /** pvp, seat 0 only: shown in everyone's open-games list. */
  listed?: boolean;
  invite?: Invite;
  /** pvp, seat 0 only: the user online I invited directly, while that invite lasts (they see an invite card). */
  invited?: { name: string; expires: number };
  /** A game being played: the table as the router last saw it (absent before the deal, on older servers). */
  table?: MatchTable;
  /** An AI game: the AI asked for at create (`Neural` or `Default`); absent = the game's default or an older server. */
  ai?: string;
}

/** A game card's table, from my side: the turn, whether it is mine, life `[mine, theirs]`, decks and their key cards. */
export interface MatchTable {
  turn: number;
  mine: boolean;
  life: [number, number];
  deck?: string;
  key?: string;
  /** The AI's deck; never a person's. */
  oppDeck?: string;
  oppKey?: string;
}

/** Someone signed in and on the server right now ("Online now"): their shown name and an opaque handle to invite them by. */
export interface OnlineUser {
  key: string;
  name: string;
}

/** A win–loss record: mine against someone, or a deck's. */
export interface WinLoss {
  w: number;
  l: number;
}

/**
 * Someone I can play: online now, in a game (they see an invite after it), or away (played with me before, not
 * here now). With the results store: my record against them and when we last played.
 */
export interface Person {
  key: string;
  name: string;
  state: 'online' | 'playing' | 'away';
  /** Away: when they were last here (epoch ms). */
  seen?: number;
  record?: WinLoss;
  /** Our last game together (epoch ms). */
  last?: number;
}

/** The friend tiles: the server's `people` when it sends them (else everyone online), well-formed entries only. */
export function peopleOf(list: Pick<MatchList, 'people' | 'online'> | null | undefined): Person[] {
  const raw: unknown = list?.people;
  if (!Array.isArray(raw)) return (list?.online ?? []).map((u) => ({ key: u.key, name: u.name, state: 'online' as const }));
  const out: Person[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const p = v as { [k: string]: unknown };
    if (typeof p.key !== 'string' || typeof p.name !== 'string') continue;
    const state = p.state === 'playing' || p.state === 'away' ? p.state : 'online';
    const rec = record(p.record);
    out.push({
      key: p.key,
      name: p.name,
      state,
      ...(typeof p.seen === 'number' ? { seen: p.seen } : {}),
      ...(rec ? { record: rec } : {}),
      ...(typeof p.last === 'number' ? { last: p.last } : {}),
    });
  }
  return out;
}

/** A well-formed `{w, l}` (whole, not negative), else undefined. */
export function record(v: unknown): WinLoss | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const { w, l } = v as { w?: unknown; l?: unknown };
  return Number.isInteger(w) && Number.isInteger(l) && (w as number) >= 0 && (l as number) >= 0 ? { w: w as number, l: l as number } : undefined;
}

/** "{from} wants to play": a pvp game held for me; Accept joins it by id with one of my decks. */
export interface DirectInvite {
  game: string;
  from: string;
  /** Epoch milliseconds. */
  expires: number;
  format?: LobbyFormat;
}

/** Somebody else's pvp game waiting for an opponent (nothing but who made it and when). */
export interface OpenGame {
  id: string;
  host: string;
  /** Epoch milliseconds. */
  created: number;
  format?: LobbyFormat;
}

export interface MatchList {
  user: string;
  maxPerUser: number;
  maxMatches: number;
  matches: MatchInfo[];
  /** Listed pvp games waiting for an opponent that I am not in (absent on servers without pvp). */
  open?: OpenGame[];
  /** Other signed-in users on the server right now, by name (absent on older servers). */
  online?: OnlineUser[];
  /** With the results store: everyone I can play, with presence and our record (see {@link peopleOf}); supersedes `online` for the friend tiles. */
  people?: Person[];
  /** Games someone made for me from their "Online now" list. */
  invites?: DirectInvite[];
  /** The server is about to be updated: running games go on, new ones are paused. */
  draining?: boolean;
  /** The user is an admin (the lobby shows the Admin section). */
  admin?: boolean;
  /** Present only when this server offers "send my games to train the AI"; absent hides the toggle entirely. */
  upload?: { on: boolean };
  /** This server lets a link allow guests (no login): the "Allow guests" toggle is shown. */
  guests?: boolean;
}

/** One game in the admin view: anybody's. */
/** A player on the Admin sheet: seat 0 made the game; a guest's name already ends in "(guest)". */
export interface AdminPlayer {
  seat: 0 | 1;
  name: string;
  guest?: true;
  /** A browser has this seat open right now. */
  connected: boolean;
}

/** A dealt game's table as an admin sees it: both seats, decks too (unlike a player's own MatchTable). */
export interface AdminTable {
  turn: number;
  /** Whose turn: a seat, -1 for nobody's. */
  active: number;
  seats: { life: number; deck?: string; key?: string }[];
}

export interface AdminMatch {
  id: string;
  owner: string;
  created: number;
  status: MatchStatus;
  /** A browser has it open. */
  connected: boolean;
  /** Older servers send none of the fields below. */
  mode?: 'ai' | 'pvp';
  /** An AI game: the AI asked for at create (`Neural` or `Default`). */
  ai?: string;
  format?: LobbyFormat;
  error?: string;
  progress?: { label: string; pct: number };
  players?: AdminPlayer[];
  /** pvp: nobody has joined yet. */
  waiting?: true;
  /** pvp: its link lets guests in. */
  guests?: true;
  table?: AdminTable;
  /** Epoch ms when a browser last had it open; only while nobody does. */
  lastSeen?: number;
}

/** The server strip on the Admin sheet. */
export interface AdminServer {
  /** The Forge commit (short sha), or "dev". */
  build: string;
  builtAt?: string;
  /** Epoch ms the server started. */
  started: number;
  /** Games open now, against the server's cap; and each person's. */
  games: number;
  maxMatches: number;
  maxPerUser: number;
  /** Signed-in people online now. */
  online: number;
  /** Whether friend links may allow guests. */
  guests: boolean;
}

export interface AdminList {
  matches: AdminMatch[];
  draining?: boolean;
  /** "Update now" is counting down: seconds until every game ends. */
  restartIn?: number;
  /** Older servers send none. */
  server?: AdminServer;
}

/** Optional preselections for the game's start screen. */
export interface NewMatch {
  deck?: string;
  oppDeck?: string;
  ai?: 'Neural' | 'Default';
  /** `pvp` needs `deck`; `oppDeck` and `ai` are ignored. */
  mode?: 'ai' | 'pvp';
  /** pvp: show the game in everyone's open-games list (the server defaults to true). */
  listed?: boolean;
  /** pvp: the link also works without a login (off unless set; ignored by a server without guests). */
  guests?: boolean;
  /** pvp: an `OnlineUser.key`: seat 1 is held for them and they get an invite card (the link works as well). */
  invite?: string;
  /** Absent = Constructed. */
  format?: LobbyFormat;
}

/** Join a pvp game from a link (`code`) or from the open list (`id`), with one of my own decks. */
export interface JoinParams {
  code?: string;
  id?: string;
  deck: string;
}

export class LobbyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const TOKEN_HEADER = 'X-Forge-Table-Token';

/** `GET /api/me`: how this server signs people in, who I am, and how I sign out (if I can). */
export interface Me {
  /** `token`: the one local user; `header`: a login proxy in front; `users`: Forge Table's own sign-in (accounts, OIDC). */
  auth: 'token' | 'header' | 'users';
  login: string;
  name: string;
  admin: boolean;
  /** Native sign-in: POST here to sign out. */
  signOut?: string;
  /** Behind a login proxy: the proxy's sign-out address, when the operator set one. */
  logoutUrl?: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class LobbyApi {
  constructor(
    private readonly token: string | null,
    private readonly doFetch: Fetch = (url, init) => fetch(url, init),
  ) {}

  /** Who I am; null from a server older than /api/me. */
  async me(): Promise<Me | null> {
    try {
      return await this.call<Me>('GET', '/api/me');
    } catch (e) {
      if (e instanceof LobbyError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Native sign-in: end this browser's session; answers with where to go next: the sign-in page, or the OIDC
   * provider's sign-out page when the server is set to sign out there too.
   */
  async signOut(): Promise<string> {
    const r = await this.call<{ next?: unknown; endSession?: unknown } | null>('POST', '/auth/logout');
    if (typeof r?.endSession === 'string' && /^https?:\/\//.test(r.endSession)) return r.endSession;
    const next = localPath(r?.next);
    return next === '/' ? '/auth/login' : next;
  }

  list(): Promise<MatchList> {
    return this.call<MatchList>('GET', '/api/matches');
  }

  create(params: NewMatch = {}): Promise<MatchInfo> {
    return this.call<MatchInfo>('POST', '/api/matches', params);
  }

  /** Join someone's pvp game; answers with the game (the client then opens `/m/<id>/`). */
  join(params: JoinParams): Promise<MatchInfo> {
    return this.call<MatchInfo>('POST', '/api/join', params);
  }

  /** Make a fresh join link for my waiting game; the old one stops working. */
  newInvite(id: string): Promise<MatchInfo> {
    return this.call<MatchInfo>('POST', `/api/matches/${encodeURIComponent(id)}/invite`, {});
  }

  /** Turn down a direct invite; answers with my list (the inviter's game goes on waiting for its link). */
  decline(id: string): Promise<MatchList> {
    return this.call<MatchList>('POST', `/api/matches/${encodeURIComponent(id)}/decline`, {});
  }

  /**
   * My deck names, for picking one before the game exists; a format adds its shared decks (Brawl). Null when this
   * server can't list them (type the name).
   */
  async decks(format?: LobbyFormat): Promise<string[] | null> {
    return (await this.deckList(format))?.names ?? null;
  }

  /** {@link decks} with what the server read from each deck file (for the New game gallery) and the Neural AI's name. */
  async deckList(format?: LobbyFormat): Promise<DeckList | null> {
    try {
      const r = await this.call<{ decks?: unknown; details?: unknown; neuralLabel?: unknown; neuralAvatar?: unknown; neural?: unknown } | null>('GET', format ? `/api/decks?format=${format}` : '/api/decks');
      if (!Array.isArray(r?.decks)) return null;
      const names = r.decks.filter((d): d is string => typeof d === 'string');
      const label = typeof r.neuralLabel === 'string' && r.neuralLabel.trim() ? r.neuralLabel.trim() : undefined;
      return {
        names,
        details: deckDetails(r.details),
        ...(label ? { neuralLabel: label } : {}),
        ...(r.neuralAvatar === true ? { neuralAvatar: true as const } : {}),
        ...(r.neural === false ? { neural: false as const } : {}),
      };
    } catch (e) {
      if (e instanceof LobbyError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403) return null;
      throw e;
    }
  }

  /** A deck's cards (my own or a shared one), for the preview; null when the server can't say (an older one: 404). */
  async deckCards(name: string, format?: LobbyFormat): Promise<DeckCards | null> {
    try {
      const q = `name=${encodeURIComponent(name)}${format ? `&format=${encodeURIComponent(format)}` : ''}`;
      return deckCards(await this.call<unknown>('GET', `/api/decks/cards?${q}`));
    } catch (e) {
      if (e instanceof LobbyError && e.status === 404) return null;
      throw e;
    }
  }

  /** A card's art crop as the router has it cached (204, no image, when it hasn't). The local token rides in the query. */
  cropUrl(card: string): string {
    return `/api/art/crop/${encodeURIComponent(card)}${this.token ? `?t=${encodeURIComponent(this.token)}` : ''}`;
  }

  /** The Neural AI's picture (404 when the server has none: ask only when the deck list says `neuralAvatar`). */
  neuralAvatarUrl(): string {
    return `/api/neural/avatar${this.token ? `?t=${encodeURIComponent(this.token)}` : ''}`;
  }

  /** A card's full scan as the router has it (204, no image, when it can't get one), for the deck peek. */
  cardUrl(card: string): string {
    return `/api/art/card/${encodeURIComponent(card)}${this.token ? `?t=${encodeURIComponent(this.token)}` : ''}`;
  }

  /** Start a paused game again from its save; answers with the game (starting). */
  resume(id: string): Promise<MatchInfo> {
    return this.call<MatchInfo>('POST', `/api/matches/${encodeURIComponent(id)}/resume`);
  }

  /** End (or, for a crashed game, dismiss) a game; answers with the remaining list. */
  end(id: string): Promise<MatchList> {
    return this.call<MatchList>('DELETE', `/api/matches/${encodeURIComponent(id)}`);
  }

  /** "Send my games to train the AI": the user's own choice, persisted server-side. */
  setUpload(on: boolean): Promise<MatchList> {
    return this.call<MatchList>('PUT', '/api/upload', { on });
  }

  /** Admins: every game on the server. */
  adminList(): Promise<AdminList> {
    return this.call<AdminList>('GET', '/api/admin/matches');
  }

  /** Admins: end anybody's game. */
  adminEnd(id: string): Promise<AdminList> {
    return this.call<AdminList>('DELETE', `/api/admin/matches/${encodeURIComponent(id)}`);
  }

  /** Admins: warn every open game, end them all after the countdown, then restart the server. */
  updateNow(): Promise<AdminList> {
    return this.call<AdminList>('POST', '/api/admin/update', {});
  }

  /** Where a game is played. The local token rides along in the fragment, which never reaches the server. */
  matchUrl(id: string): string {
    return `/m/${encodeURIComponent(id)}/${this.token ? `#t=${encodeURIComponent(this.token)}` : ''}`;
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return callJson<T>(this.doFetch, this.token, method, path, body);
  }
}

/** What the router read from a deck file: card count, colours (from its basic lands, WUBRG order), key card, commander. */
export interface DeckDetail {
  cards: number;
  colors: string;
  key?: string;
  commander?: string;
  /** For a deck with a commander: non-basic cards with more than one copy (Brawl is singleton). */
  dupes?: string[];
  /** Why the deck isn't Standard-legal (sets, bans, copies), as the server judged it; absent when it is, or wasn't judged. */
  standard?: string;
  /** With the results store: this deck's games, and its last (epoch ms). */
  record?: WinLoss;
  last?: number;
}

/** A deck's cards by section (Commander, Main, Sideboard), for the New game preview. */
export interface DeckCards {
  sections: { name: string; cards: DeckCard[] }[];
}

/** The type groups the peek sorts a deck into, as the server names a card's (the first it has, Creature first). */
export const CARD_TYPES = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Other'] as const;
export type CardType = (typeof CARD_TYPES)[number];

/** One line of a deck; type, mana value and cost only from a server that could read the card's script. */
export interface DeckCard {
  n: number;
  name: string;
  type?: CardType;
  cmc?: number;
  /** In braces, `{2}{R}{R}`; empty for no cost (a land); a split card's halves joined by ` // `. */
  cost?: string;
}

/** The server's deck card list, keeping only well-formed sections and lines. */
export function deckCards(raw: unknown): DeckCards {
  const sections: DeckCards['sections'] = [];
  const list = raw && typeof raw === 'object' ? (raw as { sections?: unknown }).sections : undefined;
  if (!Array.isArray(list)) return { sections };
  for (const sec of list) {
    if (!sec || typeof sec !== 'object') continue;
    const { name, cards } = sec as { name?: unknown; cards?: unknown };
    if (typeof name !== 'string' || !Array.isArray(cards)) continue;
    const ok = cards.filter((c): c is DeckCard => !!c && typeof c === 'object' && typeof (c as { n?: unknown }).n === 'number' && typeof (c as { name?: unknown }).name === 'string');
    if (ok.length) sections.push({ name, cards: ok.map(deckCard) });
  }
  return { sections };
}

function deckCard(c: DeckCard): DeckCard {
  const out: DeckCard = { n: c.n, name: c.name };
  if ((CARD_TYPES as readonly unknown[]).includes(c.type)) out.type = c.type!;
  if (typeof c.cmc === 'number' && Number.isFinite(c.cmc) && c.cmc >= 0) out.cmc = c.cmc;
  if (typeof c.cost === 'string' && c.cost.length <= 200) out.cost = c.cost;
  return out;
}

export interface DeckList {
  names: string[];
  /** By deck name; a deck the server couldn't read has none. */
  details: Record<string, DeckDetail>;
  /** The server's name for the Neural AI (FT_NEURAL_LABEL). */
  neuralLabel?: string;
  /** The server has a picture of the Neural AI ({@link LobbyApi.neuralAvatarUrl}). */
  neuralAvatar?: true;
  /** False: no Neural AI plugin is installed, so the lobby doesn't offer Neural. */
  neural?: false;
}

/** The server's `details`, keeping only well-formed entries (an older server sends none). */
export function deckDetails(raw: unknown): Record<string, DeckDetail> {
  const out: Record<string, DeckDetail> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const d = v as Record<string, unknown>;
    if (typeof d.cards !== 'number') continue;
    out[name] = {
      cards: d.cards,
      colors: typeof d.colors === 'string' ? d.colors.replace(/[^WUBRG]/g, '') : '',
      ...(typeof d.key === 'string' && d.key ? { key: d.key } : {}),
      ...(typeof d.commander === 'string' && d.commander ? { commander: d.commander } : {}),
      ...(Array.isArray(d.dupes) && d.dupes.length ? { dupes: d.dupes.filter((x): x is string => typeof x === 'string') } : {}),
      ...(typeof d.standard === 'string' && d.standard ? { standard: d.standard } : {}),
      ...(record(d.record) ? { record: record(d.record)! } : {}),
      ...(typeof d.last === 'number' ? { last: d.last } : {}),
    };
  }
  return out;
}

/** A guest's join (no login): the invite code, the name to show, and one of the server's shared decks. */
export interface GuestJoinParams {
  code: string;
  name: string;
  deck: string;
}

/**
 * The guest join page's API (`/g/api/*`, the only API a browser without a login can reach). It never calls `/api/*`;
 * the guest's cookie, set by `join`, only works at the game's own `/g/<id>/`.
 */
export class GuestApi {
  constructor(private readonly doFetch: Fetch = (url, init) => fetch(url, init)) {}

  /** The shared decks a guest can pick, with what the gallery shows of each, for a live guest link (404 otherwise: expired, used, or not for guests). */
  async decks(code: string): Promise<DeckList> {
    const r = await callJson<{ decks?: unknown; details?: unknown } | null>(this.doFetch, null, 'GET', `/g/api/decks?code=${encodeURIComponent(code)}`);
    return { names: Array.isArray(r?.decks) ? r.decks.filter((d): d is string => typeof d === 'string') : [], details: deckDetails(r?.details) };
  }

  /** A card's art crop for the join page's gallery: the guest route, good while the link is (204, no image, when the router has none). */
  cropUrl(code: string, card: string): string {
    return `/g/api/art/crop/${encodeURIComponent(card)}?code=${encodeURIComponent(code)}`;
  }

  join(params: GuestJoinParams): Promise<MatchInfo> {
    return callJson<MatchInfo>(this.doFetch, null, 'POST', '/g/api/join', params);
  }

  /** Whether the guest's table answers yet (a game that is still starting answers 503). */
  async tableUp(id: string): Promise<boolean> {
    try {
      return (await this.doFetch(this.tableUrl(id), { method: 'HEAD', credentials: 'same-origin' })).ok;
    } catch {
      return false;
    }
  }

  tableUrl(id: string): string {
    return `/g/${encodeURIComponent(id)}/`;
  }
}

/** A path on this site to go to, else `/`: never another site (`//host`, a scheme, a backslash). */
export function localPath(p: unknown): string {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.includes('\\') ? p : '/';
}

/**
 * With native sign-in, where to send the page when a call says I'm signed out (the session ran out or was ended
 * elsewhere): the sign-in page, then back here. Null in every other case (the error is just shown).
 */
export function signInAgain(me: Me | null, e: unknown, here: { pathname: string; search: string }): string | null {
  if (me?.auth !== 'users' || !(e instanceof LobbyError) || e.status !== 401) return null;
  const back = here.pathname + here.search;
  return back === '/' ? '/auth/login' : `/auth/login?next=${encodeURIComponent(back)}`;
}

/** `GET /auth/methods`: what the sign-in page offers. */
export interface SignInMethods {
  /** A username and password form (`--auth users`). */
  password: boolean;
  /** A button off to the OIDC provider (`--auth oidc`). */
  oidc?: { label: string; start: string };
}

/** The sign-in page's calls (native sign-in, `--auth users`, `oidc`). */
export class SignInApi {
  constructor(private readonly doFetch: Fetch = (url, init) => fetch(url, init)) {}

  /** What this server's sign-in page offers; the password form alone if it can't say. */
  async methods(): Promise<SignInMethods> {
    try {
      const m = await callJson<Partial<SignInMethods> | null>(this.doFetch, null, 'GET', '/auth/methods');
      const o = m?.oidc;
      const oidc = o && typeof o.label === 'string' && localPath(o.start) === o.start ? { label: o.label, start: o.start } : undefined;
      return { password: m?.password !== false, oidc };
    } catch {
      return { password: true };
    }
  }

  /** Sign in; answers with where to go next (the server checks `next` too). Wrong details throw the server's words. */
  async signIn(login: string, password: string, next: string | null): Promise<string> {
    const r = await callJson<{ next?: unknown } | null>(this.doFetch, null, 'POST', '/auth/login', { login, password, next });
    return localPath(r?.next);
  }
}

async function callJson<T>(doFetch: Fetch, token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers[TOKEN_HEADER] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await doFetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new LobbyError('Can’t reach the Forge Table server.', 0);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // plain-text errors (401/403/404 from the router)
  }
  if (!res.ok) throw new LobbyError(errorText(res.status, json, text), res.status);
  return json as T;
}

function errorText(status: number, json: unknown, text: string): string {
  const fromServer = json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string' ? (json as { error: string }).error : '';
  if (fromServer) return fromServer;
  if (status === 401) return 'You’re not signed in. Open Forge Table from its link again.';
  if (status === 403) return 'You don’t have access to that.';
  return text.trim() || `The server answered ${status}.`;
}

/** A game can be opened once its process is up (a finished game still shows its result). */
export function canOpen(m: MatchInfo): boolean {
  return m.status === 'ready' || m.status === 'playing' || m.status === 'over';
}

export const STATUS_LABEL: Record<MatchStatus, string> = {
  starting: 'Starting…',
  ready: 'Pick decks',
  playing: 'In progress',
  over: 'Finished',
  crashed: 'Crashed',
  stopping: 'Closing…',
  paused: 'Paused',
};

/**
 * Where the game just created in this tab stands: open it (ready), keep waiting (starting), report it (crashed),
 * or `gone` from this list, which only means it ended once it had been listed before (`seen`): a poll sent before
 * the game existed can answer after it was created.
 */
export function openingStep(
  matches: MatchInfo[],
  id: string,
  seen: boolean,
): { kind: 'open' } | { kind: 'wait' } | { kind: 'crashed'; error: string } | { kind: 'gone'; ended: boolean } {
  const m = matches.find((x) => x.id === id);
  if (!m) return { kind: 'gone', ended: seen };
  if (canOpen(m)) return { kind: 'open' };
  if (m.status === 'crashed') return { kind: 'crashed', error: m.error ?? 'unknown error' };
  return { kind: 'wait' };
}

/**
 * What a starting row shows: the stage with its percent (`text`, the bar's spoken value), the stage alone (`label`,
 * shown beside a separate percent), and how long it has been going.
 */
export function bootView(m: MatchInfo): { text: string; label: string; pct: number; elapsed: string | null } {
  const p = m.progress;
  if (!p) return { text: STATUS_LABEL.starting, label: STATUS_LABEL.starting, pct: 0, elapsed: null };
  const pct = Math.max(0, Math.min(100, Math.round(p.pct)));
  return { text: `${p.label}… ${pct}%`, label: `${p.label}…`, pct, elapsed: `${Math.max(0, Math.floor(p.elapsed))} s` };
}

/** Games counting against your limit: all listed ones, crashed and closing included (both leave by themselves). */
export function openCount(list: MatchList): number {
  return list.matches.length;
}
