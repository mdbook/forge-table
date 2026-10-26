/**
 * The multi-game lobby: start a game, and resume or end your games. New game picks the format,
 * decks and AI here and the game page starts the match with them as soon as it is up; deck import is still
 * the game's start screen's.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AdminSection } from './Admin';
import { Art } from './Art';
import { DeckGallery, DeckPickerSheet } from './DeckGallery';
import { aiName, avatarHue, bootSteps } from './home';
import { AiPhoto, Avatar, FormatGlyph } from './people';
import { InfoTip } from './InfoTip';
import { bootView, canOpen, openCount, openingStep, peopleOf, signInAgain, STATUS_LABEL, type AdminList, type Me, type DeckList, type DirectInvite, type LobbyApi, type LobbyFormat, type MatchInfo, type MatchList, type NewMatch, type OpenGame, type Person } from './api';
import { NewGame, type FriendHow } from './NewGame';
import { Sheet } from './Sheet';
export { Sheet };
import { loadPicks, peekHandoff, playable, rememberHandoff, savePicks, type Handoff, type Picks } from './newGame';
import { ART_PREF, loadArtMode, loadPref, savePref, type ArtMode } from '../config';
import { FAN_CONTENT } from '../hud/start';
import { ageText, countdown, defaultDeck, endAsk, friendArrived, friendMatch, hasLiveInvite, opponentName, pvpRow, rememberDeck, rememberedDeck } from './pvp';

const POLL_MS = 3000;
/** While a game starts or closes: often enough for its progress bar to move smoothly. */
export const POLL_STARTING_MS = 500;
/** While a join link is out: a friend joining shows up within a couple of seconds. */
export const POLL_INVITE_MS = 1500;
const DECK_PREF = 'lobbyDeck';
/** The format New game and Play a friend make: 'brawl', 'standard', or Constructed when unset. */
const FORMAT_PREF = 'lobbyFormat';

/** " · Brawl" / " · Standard" after a row's text in a format game; nothing for Constructed. */
function formatTag(format: LobbyFormat | undefined): string {
  return format ? ` · ${formatName(format)}` : '';
}

/** The one-column (phone, portrait tablet) layout: the same width as styles.css's `max-width: 859px` rules. */
const PHONE_QUERY = '(max-width: 859px)';

/** Whether a media query matches, kept current (a phone turned on its side, a window resized). False where there is no matchMedia. */
function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const change = () => setOn(mq.matches);
    change();
    mq.addEventListener('change', change);
    return () => mq.removeEventListener('change', change);
  }, [query]);
  return on;
}

/** The full clock time, for the hover title of a relative age. */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * A starting game, all in one place (the stage, a bar, the seconds and a separate hint read as three signals):
 * the stage with its percent at the right, the bar, then what happens next (`hint`, only where this tab will open the
 * game itself) and the seconds so far.
 */
export function Boot({ match, hint }: { match: MatchInfo; hint?: string }) {
  const v = bootView(match);
  return (
    <span className="boot" data-testid="boot">
      <span className="boot-text">
        <span className="boot-label">{v.label}</span>
        {match.progress && <span className="boot-pct">{v.pct}%</span>}
      </span>
      <span
        className="boot-bar"
        role="progressbar"
        aria-label="Starting the game"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={v.pct}
        aria-valuetext={v.text}
      >
        <span className="boot-fill" style={{ width: `${v.pct}%` }} />
      </span>
      {(hint || v.elapsed) && (
        <span className="boot-meta">
          {hint && <span className="boot-hint">{hint}</span>}
          {v.elapsed && <span className="boot-elapsed">{v.elapsed}</span>}
        </span>
      )}
    </span>
  );
}

/** Copy to the clipboard; where that is blocked (plain http, old browsers) select the field and ask the browser to copy. */
async function copyText(text: string, field: HTMLInputElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fall through to the selection route
  }
  if (!field) return false;
  field.focus();
  field.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

/** A deck picker: a list when the server can give one, a typed name when it can't, a hint when there are none. */
function DeckField({ decks, value, onChange, label }: { decks: string[] | null | undefined; value: string; onChange: (d: string) => void; label: string }) {
  if (decks === undefined) return <span className="hint">Loading your decks…</span>;
  if (decks === null) {
    return <input className="field" value={value} placeholder="Deck name" aria-label={label} data-testid="deck-field" onChange={(e) => onChange(e.target.value)} />;
  }
  if (decks.length === 0) return <span className="hint warn">You have no decks yet. Start a game against the AI to import one.</span>;
  return (
    <select value={value} aria-label={label} data-testid="deck-field" onChange={(e) => onChange(e.target.value)}>
      {decks.map((n) => (
        <option key={n}>{n}</option>
      ))}
    </select>
  );
}

/**
 * A waiting pvp game's invite (the link, Copy, New link and Cancel read as a ragged pile): the link as a share
 * field with one ember Copy (it says Copied for two seconds), then the link's facts as small chips (how long it
 * lives, whether it is on the open list, guests) and the quiet actions, New link and the row's own Cancel, together.
 */
function InviteBox({ match, now, onNew, onError, decks, cropUrl }: { match: MatchInfo; now: number; onNew: () => void; onError: (e: string) => void; decks: DeckList | null | undefined; cropUrl: (c: string) => string }) {
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  /** My deck for it, still mine to change while the friend hasn't come: the game page readies with whatever is here then. */
  const [deck, setDeck] = useState(() => rememberedDeck(match.id) ?? '');
  const row = pvpRow(match, now);
  if (!row || row.phase !== 'waiting') return null;
  const live = row.invite.kind === 'live';
  const copy = async () => {
    if (!match.invite) return;
    if (await copyText(match.invite.url, field.current)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } else onError('Couldn’t copy. Select the link and copy it by hand.');
  };
  return (
    <div className="invite full" data-testid="invite">
      {deck && (
        <div className="invite-deck" data-testid="invite-deck">
          <span className="hint">You play</span>
          <DeckChip
            list={decks}
            value={deck}
            cropUrl={cropUrl}
            onChange={(d) => {
              setDeck(d);
              rememberDeck(match.id, d);
            }}
          />
        </div>
      )}
      {match.invite && live && (
        <div className="invite-link">
          <input ref={field} className="field" readOnly value={match.invite.url} aria-label="Join link" data-testid="invite-url" onFocus={(e) => e.currentTarget.select()} />
          <button className={`btn primary cta compact invite-copy${copied ? ' copied' : ''}`} data-testid="invite-copy" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      <div className="invite-meta">
        <span className="invite-chips">
          <span className={`chip-tag${live ? ' live' : ' warn'}`} data-testid="invite-expiry">
            {row.invite.kind === 'live' ? `Link expires in ${countdown(row.invite.left)}` : row.invite.kind === 'expired' ? 'This link has expired.' : 'No link yet.'}
          </span>
          <span className="chip-tag" data-testid="invite-listed">
            {row.listed ? 'Shown in open games' : 'Link only'}
          </span>
          {match.invite?.guests && (
            <span className="chip-tag" data-testid="invite-guests">
              Guests allowed
            </span>
          )}
          {match.status === 'starting' && <span className="chip-tag">Setting up the table</span>}
        </span>
        <span className="invite-actions">
          <button className="btn ghost" data-testid="invite-new" onClick={onNew}>
            New link
          </button>
        </span>
      </div>
    </div>
  );
}

/**
 * My deck for a game someone else made: my last deck as a chip (its art and name), so Accept and Join are one
 * tap; tapping the chip opens the deck gallery. Without a list (loading, a server that can't say, no decks) it is
 * the plain deck field.
 */
export function DeckChip({ list, value, onChange, cropUrl }: { list: DeckList | null | undefined; value: string; onChange: (d: string) => void; cropUrl: (c: string) => string }) {
  const [open, setOpen] = useState(false);
  if (!list || list.names.length === 0) {
    return <DeckField decks={list === undefined ? undefined : list ? list.names : null} value={value} onChange={onChange} label="Your deck" />;
  }
  const known = !!value && list.names.includes(value);
  const d = known && Object.hasOwn(list.details, value) ? list.details[value] : undefined;
  return (
    <>
      <button className="deck-chip" aria-label={known ? `Your deck: ${value}. Change` : 'Pick your deck'} data-testid="deck-chip" onClick={() => setOpen(true)}>
        <Art card={d?.key} colors={d?.colors ?? ''} cropUrl={cropUrl} className="deck-chip-art" />
        <span className="deck-chip-name">{known ? value : 'Pick a deck'}</span>
        <span className="deck-chip-chev" aria-hidden="true" />
      </button>
      {open && <DeckPickerSheet title="Your deck" label="Your deck" names={list.names} details={list.details} selected={value} onPick={onChange} cropUrl={cropUrl} onClose={() => setOpen(false)} />}
    </>
  );
}

/** "Brawl · …" / "Standard · …" / "Constructed · …", under who an invite or open table is from. */
function formatName(format: LobbyFormat | undefined): string {
  return format === 'brawl' ? 'Brawl' : format === 'standard' ? 'Standard' : 'Constructed';
}

/** Someone in Waiting for you: their avatar, with their presence when the server says it. */
function Who({ name, people }: { name: string; people: Person[] }) {
  return <Avatar name={name} state={people.find((p) => p.name === name)?.state ?? 'online'} />;
}

/**
 * "{from} invited you": a game someone made for me from their "Online now". Accept joins it with my last deck (a chip,
 * tap to change); Decline tells the server (their game goes on waiting for its link).
 */
export function InviteCard(props: {
  invite: DirectInvite;
  decks: DeckList | null | undefined;
  now: number;
  disabled: boolean;
  cropUrl: (c: string) => string;
  people?: Person[];
  onAccept: (deck: string) => Promise<void>;
  onDecline: () => Promise<void>;
}) {
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const deck = picked ?? defaultDeck(props.decks?.names, loadPref(DECK_PREF));
  const act = (f: () => Promise<void>) => {
    setBusy(true);
    void f().finally(() => setBusy(false));
  };
  return (
    <div className="invite-card" role="group" aria-label={`Invite from ${props.invite.from}`} data-testid="invite-card">
      <div className="waiting-head">
        <Who name={props.invite.from} people={props.people ?? []} />
        <span className="waiting-who">
          <span className="invite-from">
            <strong>{props.invite.from}</strong> invited you
          </span>
          <span className="hint">
            <FormatGlyph format={props.invite.format} size={13} />
            {formatName(props.invite.format)} · expires in {countdown(props.invite.expires - props.now)}
          </span>
        </span>
      </div>
      <div className="waiting-go">
        <DeckChip list={props.decks} value={deck} onChange={setPicked} cropUrl={props.cropUrl} />
        <button className="btn ghost" disabled={busy} data-testid="invite-decline" onClick={() => act(props.onDecline)}>
          Decline
        </button>
        <button className="btn primary cta compact" disabled={busy || props.disabled || !deck} data-testid="invite-accept" onClick={() => act(() => props.onAccept(deck))}>
          {busy ? 'Joining…' : 'Accept'}
        </button>
      </div>
    </div>
  );
}

/**
 * Waiting for you: invites to me first, then other players' open tables, one list. An open table's Join is one
 * tap with my last deck; "with {deck}" under it opens the deck gallery to change it first.
 */
export function Waiting({
  invites,
  games,
  decksFor,
  cropUrl,
  now,
  people = [],
  disabled,
  onAccept,
  onDecline,
  onJoin,
}: {
  invites: DirectInvite[];
  games: OpenGame[];
  /** My decks for a game in that format. */
  decksFor: (format: LobbyFormat | undefined) => DeckList | null | undefined;
  cropUrl: (c: string) => string;
  now: number;
  /** Who is around, for the presence dots. */
  people?: Person[];
  /** Accept can't be pressed (opening a game, at the cap, server updating). */
  disabled: boolean;
  onAccept: (inv: DirectInvite, deck: string) => Promise<void>;
  onDecline: (inv: DirectInvite) => Promise<void>;
  onJoin: (g: OpenGame, deck: string) => Promise<void>;
}) {
  /** A deck picked for a table (by its id) before joining it, and the table whose deck gallery is open. */
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const deckFor = (g: OpenGame) => picked[g.id] ?? defaultDeck(decksFor(g.format)?.names, loadPref(DECK_PREF));
  const count = invites.length + games.length;
  const pickingGame = games.find((g) => g.id === picking);
  const pickingList = pickingGame ? decksFor(pickingGame.format) : undefined;
  return (
    <section className="lobby-section waiting-section" aria-label="Waiting for you">
      <div className="home-h">
        <h2>Waiting for you</h2>
        {count > 0 && <span className="home-sub">{count}</span>}
      </div>
      {count === 0 && <div className="hint">Nothing waiting. A friend’s invite or open table shows up here.</div>}
      {count > 0 && (
        <ul className="waiting-list" data-testid="waiting">
          {invites.map((inv) => (
            <li key={inv.game}>
              <InviteCard
                invite={inv}
                decks={decksFor(inv.format)}
                now={now}
                disabled={disabled}
                cropUrl={cropUrl}
                people={people}
                onAccept={(dk) => onAccept(inv, dk)}
                onDecline={() => onDecline(inv)}
              />
            </li>
          ))}
          {games.map((g) => {
            const d = deckFor(g);
            return (
              <li key={g.id} className="open-game" data-testid={`open-${g.id}`}>
                <div className="waiting-head">
                  <Who name={g.host} people={people} />
                  <span className="waiting-who">
                    <span>
                      <strong>{g.host}</strong>’s open table
                    </span>
                    <span className="hint" title={clock(g.created)}>
                      <FormatGlyph format={g.format} size={13} />
                      {formatName(g.format)} · {ageText(g.created, now)}
                    </span>
                    {d && (
                      <button className="link-btn open-deck" data-testid="open-deck" aria-label={`Your deck: ${d}. Change`} onClick={() => setPicking(g.id)}>
                        with {d}
                      </button>
                    )}
                  </span>
                  <button
                    className="btn secondary"
                    data-testid="open-join"
                    disabled={!!busy || disabled || !d}
                    onClick={() => {
                      setBusy(g.id);
                      void onJoin(g, d).finally(() => setBusy(null));
                    }}
                  >
                    {busy === g.id ? 'Joining…' : 'Join'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {games.length > 0 && <span className="hint">Open tables are games friends listed for anyone signed in. Invites are only for you.</span>}
      {pickingGame && pickingList && (
        <DeckPickerSheet
          title={`Your deck for ${pickingGame.host}’s table`}
          label="Your deck"
          names={pickingList.names}
          details={pickingList.details}
          selected={deckFor(pickingGame)}
          cropUrl={cropUrl}
          onPick={(n) => setPicked({ ...picked, [pickingGame.id]: n })}
          onClose={() => setPicking(null)}
        />
      )}
    </section>
  );
}

export function Lobby({ api, joinCode = null }: { api: LobbyApi; joinCode?: string | null }) {
  const [list, setList] = useState<MatchList | null>(null);
  const [adminList, setAdminList] = useState<AdminList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** The game just created or joined: the lobby opens it as soon as it is up. */
  const [opening, setOpening] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // An unanswered "Concede?" goes back to the × after a few seconds.
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), CONCEDE_MS);
    return () => clearTimeout(t);
  }, [confirming]);
  /** My deck names for pvp: undefined while loading, null when the server can't list them. */
  const [deckList, setDeckList] = useState<DeckList | null | undefined>(undefined);
  /** The same with the shared Brawl decks, for Brawl games. */
  const [brawlList, setBrawlList] = useState<DeckList | null | undefined>(undefined);
  const listFor = (f: LobbyFormat | undefined) => (f === 'brawl' ? brawlList : deckList);
  const [format, setFormat] = useState<LobbyFormat | undefined>(() => {
    const f = loadPref(FORMAT_PREF);
    return f === 'brawl' || f === 'standard' ? f : undefined;
  });
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef(0);
  /** How this server signs people in and how I sign out; null until known (or from an older server). */
  const [me, setMe] = useState<Me | null>(null);
  const meRef = useRef<Me | null>(null);

  useEffect(() => {
    let alive = true;
    api.me().then(
      (m) => {
        if (!alive) return;
        meRef.current = m;
        setMe(m);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const refresh = useCallback(async () => {
    try {
      const l = await api.list();
      setList(l);
      if (l.admin) setAdminList(await api.adminList());
      setError((e) => (e === 'Can’t reach the Forge Table server.' ? null : e));
      return l;
    } catch (e) {
      const again = signInAgain(meRef.current, e, window.location);
      if (again) window.location.replace(again);
      setError((e as Error).message);
      return null;
    }
  }, [api]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const l = await refresh();
      if (!alive) return;
      const starting = l?.matches.some((m) => m.status === 'starting' || m.status === 'stopping');
      const invited = !!l && hasLiveInvite(l.matches, Date.now());
      timer.current = window.setTimeout(() => void tick(), starting ? POLL_STARTING_MS : invited ? POLL_INVITE_MS : POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer.current);
    };
  }, [refresh]);

  // Countdowns and ages move once a second.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    api.deckList().then(
      (d) => alive && setDeckList(d),
      () => alive && setDeckList(null),
    );
    api.deckList('brawl').then(
      (d) => alive && setBrawlList(d),
      () => alive && setBrawlList(null),
    );
    return () => {
      alive = false;
    };
  }, [api]);

  /** The game being opened has been listed (until then a list without it may be a poll sent before it existed). */
  const seen = useRef(false);

  // Open the new game once its process is ready; report it if it died while starting.
  useEffect(() => {
    if (!opening || !list) return;
    const step = openingStep(list.matches, opening, seen.current);
    if (step.kind !== 'gone') seen.current = true;
    if (step.kind === 'open') window.location.assign(api.matchUrl(opening));
    else if (step.kind === 'gone' && step.ended) setOpening(null);
    else if (step.kind === 'crashed') {
      setOpening(null);
      setError(`The game couldn’t start: ${step.error}.`);
    }
  }, [opening, list, api]);

  // My waiting pvp games: when the friend joins one, follow them into it.
  const watching = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!list) return;
    const step = friendArrived(watching.current, list.matches);
    watching.current = step.watching;
    if (step.open) window.location.assign(api.matchUrl(step.open));
  }, [list, api]);

  /** New game: open on this format's last picks; Play a friend opens it on its "A friend" tab. */
  const [picks, setPicks] = useState<Picks | null>(null);
  const picksFor = (f: LobbyFormat | undefined): Picks => {
    const l = f === 'brawl' ? brawlList : deckList;
    return loadPicks(f, l ? playable(l.names, l.details, f) : [], loadPref, loadPref(DECK_PREF), l?.neural !== false);
  };
  /** A deck's cards for New game's peek (stable, so the card list doesn't reload every poll). */
  const cardsOf = useCallback((name: string, f?: LobbyFormat) => api.deckCards(name, f), [api]);
  const openNew = () => {
    setError(null);
    setPicks(picksFor(format));
  };
  // The deck lists arrived after New game opened: pick again from them.
  useEffect(() => {
    setPicks((p) => (p && !p.deck ? picksFor(p.format) : p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckList, brawlList]);

  /** Make the game, and leave the game page what to do first (start with the picks, or open deck import). */
  const create = async (body: NewMatch | undefined, handoff: Handoff) => {
    setCreating(true);
    setError(null);
    try {
      const m = await api.create(body);
      rememberHandoff(m.id, handoff);
      seen.current = false;
      setPicks(null);
      setOpening(m.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const pickFormat = (f: LobbyFormat | undefined) => {
    setFormat(f);
    savePref(FORMAT_PREF, f ?? 'constructed');
  };
  /** A friend game (New game's "A friend"): held for `how.invite` (an "Online now" key), else waiting for its link; its row then shows the link. */
  const createFriend = async (deck: string, how: FriendHow) => {
    setCreating(true);
    setError(null);
    try {
      const m = await api.create(friendMatch(deck, how.listed, how.guests, !!list?.guests, how.invite, picks?.format));
      savePref(DECK_PREF, deck);
      rememberDeck(m.id, deck);
      setPicks(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const newLink = async (m: MatchInfo) => {
    try {
      await api.newInvite(m.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Join from the open list or a link: remember the deck for the game page, then open the game when it is up. */
  const join = async (target: { id: string } | { code: string }, joinDeck: string) => {
    setError(null);
    try {
      const m = await api.join({ ...target, deck: joinDeck });
      savePref(DECK_PREF, joinDeck);
      rememberDeck(m.id, joinDeck);
      seen.current = false;
      setOpening(m.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const decline = async (id: string) => {
    try {
      setList(await api.decline(id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const [savingUpload, setSavingUpload] = useState(false);
  const toggleUpload = async () => {
    if (!list?.upload || savingUpload) return;
    setSavingUpload(true);
    try {
      setList(await api.setUpload(!list.upload.on));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingUpload(false);
    }
  };

  /** One click ends a game; only conceding a live game against a person asks once more (the × turns into "Concede?"). */
  /** A paused game: start it again from its save, then open it once it's up (as a new game opens). */
  const resumeGame = async (m: MatchInfo) => {
    setError(null);
    try {
      await api.resume(m.id);
      seen.current = false;
      setOpening(m.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const end = async (m: MatchInfo) => {
    if (endAsk(m) && confirming !== m.id) {
      setConfirming(m.id);
      return;
    }
    setConfirming(null);
    try {
      setList(await api.end(m.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const atCap = !!list && openCount(list) >= list.maxPerUser;
  const paused = !!list?.draining;

  /** One column: the action bar is pinned to the bottom, Play a friend and Admin open as bottom sheets. */
  const phone = useMedia(PHONE_QUERY);

  if (joinCode) {
    return <JoinPage mine={deckList} brawl={brawlList} cropUrl={(c) => api.cropUrl(c)} list={list} opening={opening} error={error} paused={paused} atCap={atCap} onJoin={(d) => join({ code: joinCode }, d)} />;
  }

  const canStart = !!list && !creating && !opening && !atCap && !paused;

  if (picks && !opening) {
    return (
      <div className="start-screen lobby ng-page" data-testid="lobby">
        <NewGame
          decks={{ constructed: deckList, brawl: brawlList }}
          picks={picks}
          onPicks={setPicks}
          onFormat={(f) => {
            pickFormat(f);
            setPicks(picksFor(f));
          }}
          phone={phone}
          cropUrl={(c) => api.cropUrl(c)}
          cardUrl={(c) => api.cardUrl(c)}
          neuralAvatar={deckList?.neuralAvatar ? api.neuralAvatarUrl() : undefined}
          blocked={paused ? 'Server is updating' : atCap ? 'End a game to start another' : !list ? 'Connecting…' : null}
          creating={creating}
          friends={list?.open !== undefined ? { people: peopleOf(list), guests: !!list.guests } : undefined}
          cardsOf={cardsOf}
          onStart={(plan, line) => {
            savePicks(picks, savePref);
            if (plan.create.deck) savePref(DECK_PREF, plan.create.deck);
            void create(plan.create, { start: plan.start, line });
          }}
          onImport={() => void create(picks.format ? { format: picks.format } : undefined, { import: true })}
          onFriend={(deck, how) => {
            savePicks(picks, savePref);
            void createFriend(deck, how);
          }}
          onBack={() => setPicks(null)}
        />
        {error && (
          <div className="error ng-error" role="alert">
            {error}
          </div>
        )}
      </div>
    );
  }
  /** Why New game can't be pressed, said on the button itself (a title never reaches touch or screen readers). */
  const blocked = paused ? 'Server is updating' : atCap ? 'End a game to start another' : null;
  const neuralLabel = deckList?.neuralLabel;
  const neuralAvatar = deckList?.neuralAvatar ? api.neuralAvatarUrl() : undefined;

  /** A deck's gallery details (its key card and colours) by name, from the format's list. */
  const deckArt = (f: LobbyFormat | undefined, name: string | null | undefined) => (name ? listFor(f)?.details[name] : undefined);
  /**
   * One of my games as a card: its deck's art as a banner with the title, who it is against and the life totals;
   * under it the turn and age with Resume, and a × in the top-right corner that ends it. A starting game keeps its
   * place, art greyed, with its stage checklist; a friend game waiting for its friend spans the row with its link.
   * `featured` = the game this tab is opening.
   */
  const gameCard = (m: MatchInfo, featured = false) => {
    const pvp = pvpRow(m, now);
    const waiting = pvp?.phase === 'waiting';
    const ask = confirming === m.id ? endAsk(m) : null;
    const t = m.status === 'playing' || m.status === 'paused' ? m.table : undefined;
    const hand = peekHandoff(m.id);
    const deck = t?.deck ?? hand?.start?.deck ?? rememberedDeck(m.id);
    const title = deck ?? (pvp ? 'Friend game' : 'New game');
    const oppDeck = t?.oppDeck ?? hand?.start?.oppDeck;
    // Before the deal (starting, waiting) the router sends no table: the deck list's key card stands in.
    const mineArt = deckArt(m.format, deck);
    const art = t?.key ?? mineArt?.key;
    const oppArt = t?.oppKey ?? (pvp ? undefined : deckArt(m.format, oppDeck)?.key);
    const vs =
      pvp?.phase === 'joined'
        ? `vs ${pvp.vs}`
        : waiting
          ? `Waiting for ${pvp.invited ?? 'a friend'}…`
          : `vs ${aiName(m.ai ?? hand?.start?.ai, neuralLabel)}${oppDeck ? ` · ${oppDeck}` : ''}`;
    const vsNeural = !pvp && (m.ai ?? hand?.start?.ai) === 'Neural';
    const state =
      m.status === 'paused'
      ? `Paused${t ? ` on turn ${t.turn}` : ''} · started ${ageText(m.created, now)}`
      : t
      ? `Turn ${t.turn} · started ${ageText(m.created, now)}`
      : `${STATUS_LABEL[m.status]}${m.status === 'crashed' && m.error ? `: ${m.error}` : ''} · ${ageText(m.created, now)}`;
    const booting = m.status === 'starting' && !waiting;
    // The × in the card's top-right corner: one click ends the game (removes it, cancels the invite); a live game
    // against a person turns it into "Concede?" first.
    const asking = !!ask;
    const endLabel = m.status === 'crashed' || m.status === 'over' ? 'Remove' : waiting ? 'Cancel game' : endAsk(m) ? 'Concede' : 'End game';
    const endButton = m.status !== 'stopping' && (
      <button
        className={`gc-x${asking ? ' ask' : ''}`}
        aria-label={asking ? 'Concede? Click again to concede' : endLabel}
        title={asking ? undefined : endLabel}
        data-testid="end"
        onClick={() => void end(m)}
        onBlur={() => setConfirming(null)}
        onKeyDown={(e) => e.key === 'Escape' && setConfirming(null)}
      >
        {asking ? (
          'Concede?'
        ) : (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        )}
      </button>
    );
    // No deck picked yet (or no art for it): a compact card, the opponent's avatar instead of an empty banner.
    const bare = !art && !oppArt && !waiting;
    const oppName = pvp?.phase === 'joined' ? pvp.vs : aiName(m.ai ?? hand?.start?.ai, neuralLabel);
    return (
      <li
        key={m.id}
        className={`game-card ${m.status}${pvp ? ' pvp' : ''}${waiting ? ' waiting' : ''}${booting ? ' booting' : ''}${t?.mine ? ' mine' : ''}${featured ? ' featured' : ''}${bare ? ' no-art' : ''}${asking ? ' asking' : ''}`}
        data-testid={`game-${m.id}`}
      >
        {endButton}
        <div className="gc-banner">
          {bare ? <Avatar name={oppName} size="lg" /> : <Art card={art} colors={mineArt?.colors ?? ''} cropUrl={(c) => api.cropUrl(c)} className="gc-art" />}
          {oppArt && <Art card={oppArt} colors="" cropUrl={(c) => api.cropUrl(c)} className="gc-opp-art" />}
          {t?.mine && (
            <span className="gc-turn" data-testid="your-turn">
              Your turn
            </span>
          )}
          <div className="gc-head">
            <span className="gc-names" title={`${title} ${vs}${formatTag(m.format)}`} data-testid={pvp ? 'pvp-status' : undefined}>
              <span className="gc-title">{title}</span>
              <span className="gc-vs">
                {vsNeural && <AiPhoto src={neuralAvatar} alt={aiName('Neural', neuralLabel)} className="vs-photo" fallback={null} />}
                {vs}
                {formatTag(m.format)}
              </span>
            </span>
            {t && (
              <span className="gc-life" aria-label={`Life: you ${t.life[0]}, ${pvp?.phase === 'joined' ? pvp.vs : 'them'} ${t.life[1]}`} data-testid="game-life">
                {t.life[0]}
                <span className="gc-dash"> – </span>
                <span className="gc-them">{t.life[1]}</span>
              </span>
            )}
          </div>
        </div>
        <div className="gc-foot">
          {booting ? (
            <>
              <Boot match={m} hint={featured ? 'It opens by itself when it’s ready.' : undefined} />
              <span className="gc-steps" aria-hidden="true">
                {bootSteps(m).map((st) => (
                  <span key={st.label} className={st.state}>
                    {st.state === 'done' ? '✓' : st.state === 'now' ? '●' : '○'} {st.label}
                  </span>
                ))}
              </span>
            </>
          ) : waiting ? (
            <InviteBox match={m} now={now} onNew={() => void newLink(m)} onError={setError} decks={listFor(m.format)} cropUrl={(c) => api.cropUrl(c)} />
          ) : (
            <>
              <span className="gc-state" title={state}>
                {state}
              </span>
              <span className="ng-spacer" />
              {m.status === 'paused' && (
                <button className="btn primary cta compact" data-testid="resume-paused" disabled={paused} onClick={() => void resumeGame(m)}>
                  Resume
                </button>
              )}
              {canOpen(m) && (
                <a className={`btn ${m.status === 'over' ? 'secondary' : 'primary cta compact'}`} href={api.matchUrl(m.id)} data-testid="resume">
                  {m.status === 'ready' ? 'Open' : m.status === 'over' ? 'View' : 'Resume'}
                </a>
              )}
            </>
          )}
          {ask && (
            <span className="hint warn full" role="status" data-testid="end-ask">
              {ask}
            </span>
          )}
          {pvp?.phase === 'joined' && opponentName(m) === null && <span className="hint full">Waiting for your opponent’s name…</span>}
        </div>
      </li>
    );
  };

  /** The games: the one this tab is opening first (a card for it before the server lists it), then friend games waiting with their link. */
  const rank = (m: MatchInfo) => (m.id === opening ? 0 : m.waiting ? 1 : 2);
  const games = list ? [...list.matches].sort((x, y) => rank(x) - rank(y)) : [];
  const openingListed = !!opening && games.some((m) => m.id === opening);
  const openingStart = opening ? peekHandoff(opening)?.start : undefined;
  // Not listed yet, so its format is unknown: look in both deck lists.
  const openingArt = deckArt(undefined, openingStart?.deck) ?? deckArt('brawl', openingStart?.deck);
  const people = peopleOf(list);
  const onlineCount = people.filter((p) => p.state !== 'away').length;
  const admin = list?.admin && (
    <AdminButton restarting={adminList?.restartIn !== undefined}>
      <AdminSection isAdmin me={list.user} now={now} list={adminList} api={api} neuralLabel={neuralLabel} neuralAvatar={neuralAvatar} onList={setAdminList} onError={setError} />
    </AdminButton>
  );
  const fanContent = <div className="hint fan-content">{FAN_CONTENT}</div>;
  const waitingSection = (list?.open !== undefined || !!list?.invites?.length) && (
    <Waiting
      invites={list?.invites?.filter((inv) => inv.expires > now) ?? []}
      games={paused ? [] : (list?.open ?? [])}
      decksFor={listFor}
      cropUrl={(c) => api.cropUrl(c)}
      now={now}
      people={people}
      disabled={!!opening || atCap || paused}
      onAccept={(inv, d) => join({ id: inv.game }, d)}
      onDecline={(inv) => decline(inv.game)}
      onJoin={(g, d) => join({ id: g.id }, d)}
    />
  );
  const user = list?.user ?? '?';

  return (
    <div className="start-screen lobby home" data-testid="lobby">
      <header className="home-head">
        <div className="brand">
          <img src="./favicon.svg" width={38} height={38} alt="" />
          <h1 className="name">Forge Table</h1>
        </div>
        <span className="ng-spacer" />
        {list && onlineCount > 0 && (
          <span className="home-online" data-testid="online-count">
            <span className="pdot online" aria-hidden="true" />
            {onlineCount} {onlineCount === 1 ? 'friend' : 'friends'} online
          </span>
        )}
        {admin}
        <LobbySettings phone={phone} />
        <span className="avatar" style={{ background: avatarHue(user) }} title={list ? `Signed in as ${user}` : 'Connecting…'} aria-label={list ? `Signed in as ${user}` : 'Connecting'} role="img">
          {(user.trim()[0] ?? '?').toUpperCase()}
        </span>
        <SignOut me={me} api={api} onError={setError} />
      </header>
      <div className={`home-cols${waitingSection ? '' : ' solo'}`}>
        <div className="home-main">
          <section className="home-continue" aria-label="Continue">
            <div className="home-h">
              <h2>Continue</h2>
              {list && (
                <span className={`home-sub${atCap ? ' warn' : ''}`} data-testid="game-count">
                  {openCount(list)} of {list.maxPerUser} game slots used{atCap ? ' · End one to start another' : ''}
                </span>
              )}
            </div>
            {!list && !error && <div className="hint">Connecting…</div>}
            {list && games.length === 0 && !opening && <div className="hint home-empty">No games yet. Start one below.</div>}
            {(games.length > 0 || !!opening) && (
              <ul className="game-cards" data-testid="lobby-games">
                {opening && !openingListed && (
                  <li className="game-card starting booting featured">
                    <div className="gc-banner">
                      <Art card={openingArt?.key} colors={openingArt?.colors ?? ''} cropUrl={(c) => api.cropUrl(c)} className="gc-art" />
                      <div className="gc-head">
                        <span className="gc-names">
                          <span className="gc-title">{openingStart?.deck ?? 'Your new game'}</span>
                        </span>
                      </div>
                    </div>
                    <div className="gc-foot">
                      <Boot match={{ id: opening, status: 'starting', created: now }} hint="It opens by itself when it’s ready." />
                    </div>
                  </li>
                )}
                {games.map((m) => gameCard(m, m.id === opening))}
              </ul>
            )}
          </section>
          <div className="home-cta">
            <button className="btn primary cta hub-new" disabled={!canStart} title={blocked ?? undefined} data-testid="new-game" onClick={() => openNew()}>
              <span>{creating ? 'Starting…' : 'New game'}</span>
              <span className="sub">{blocked ?? (list?.open !== undefined ? 'Against the AI or a friend' : 'Pick a format, deck and opponent')}</span>
            </button>
          </div>
          {paused && (
            <div className="hint warn" data-testid="draining" role="status">
              Server is updating, new games are paused. Games already running carry on.
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {list?.upload && (
            <div className="upload-toggle" data-testid="upload-toggle">
              <label>
                <input type="checkbox" role="switch" className="switch" checked={list.upload.on} disabled={savingUpload} onChange={() => void toggleUpload()} />
                <span>Send my games to train {neuralLabel ?? 'the AI'}</span>
              </label>
              <InfoTip label="What is sent?" testId="upload-info">
                {neuralLabel ?? 'The AI'} learns from how you play: your casts, lands, abilities, keeps and mulligans, attacks, blocks and other choices, plus the result. No names or other personal data. Turning this off stops uploads of games not yet sent.
              </InfoTip>
            </div>
          )}
        </div>
        {waitingSection && <aside className="home-side">{waitingSection}</aside>}
      </div>
      {fanContent}
    </div>
  );
}

/** How long an unanswered "Concede?" waits before it goes back to the ×. */
const CONCEDE_MS = 5000;

const ART_MODES: { id: ArtMode; name: string; blurb: string }[] = [
  { id: 'scryfall', name: 'Scans', blurb: 'The printed cards, from Scryfall' },
  { id: 'frame', name: 'Framed', blurb: 'Our own frame around the card’s art' },
  { id: 'procedural', name: 'Drawn', blurb: 'Drawn here, no images' },
];

/**
 * The lobby's gear: how cards look in every game (a per-viewer preference the game pages read when they open). A
 * popover on a wide screen, a sheet on a phone.
 */
function LobbySettings({ phone }: { phone: boolean }) {
  const [open, setOpen] = useState(false);
  const [art, setArt] = useState<ArtMode>(() => loadArtMode());
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || phone) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open, phone]);
  const body = (
    <div className="home-settings">
      <span className="home-settings-k" id="card-faces">
        Card faces
      </span>
      <div className="home-seg" role="radiogroup" aria-labelledby="card-faces">
        {ART_MODES.map((a) => (
          <button
            key={a.id}
            role="radio"
            aria-checked={art === a.id}
            className={art === a.id ? 'on' : ''}
            data-testid={`art-${a.id}`}
            onClick={() => {
              setArt(a.id);
              savePref(ART_PREF, a.id);
            }}
          >
            <b>{a.name}</b>
            <span>{a.blurb}</span>
          </button>
        ))}
      </div>
      <span className="hint">Games you open from now on look like this. The gear in a game changes it too.</span>
    </div>
  );
  return (
    <div className={`home-gear${open ? ' open' : ''}`} ref={box}>
      <button className="btn ghost icon-btn" aria-label="Settings" aria-expanded={open} aria-haspopup={phone ? 'dialog' : 'true'} data-testid="settings" onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
          <path
            d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Zm7.4-2.2.1-1-.1-1 2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4L10.7 6a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6-.1 1 .1 1-2 1.6 2 3.4 2.4-1c.5.4 1.1.7 1.7 1l.3 2.5h4l.3-2.5c.6-.3 1.2-.6 1.7-1l2.4 1 2-3.4-2-1.6Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && !phone && (
        <div className="home-pop" role="group" aria-label="Settings">
          {body}
        </div>
      )}
      {open && phone && (
        <Sheet title="Settings" onClose={() => setOpen(false)}>
          {body}
        </Sheet>
      )}
    </div>
  );
}

/**
 * Sign out, when there is a way to: native sign-in ends the session here; behind a login proxy it is a link to the
 * proxy's own sign-out (`--logout-url`), only when the operator set one. Nothing in token mode.
 */
function SignOut({ me, api, onError }: { me: Me | null; api: LobbyApi; onError: (e: string) => void }) {
  const [busy, setBusy] = useState(false);
  if (me?.signOut) {
    return (
      <button
        className="btn ghost"
        disabled={busy}
        data-testid="sign-out"
        onClick={() => {
          setBusy(true);
          api.signOut().then(
            (next) => window.location.replace(next),
            (e: Error) => {
              onError(e.message);
              setBusy(false);
            },
          );
        }}
      >
        Sign out
      </button>
    );
  }
  if (me?.logoutUrl) {
    return (
      <a className="btn ghost" href={me.logoutUrl} data-testid="sign-out">
        Sign out
      </a>
    );
  }
  return null;
}

/**
 * Admin, out of the way: a button beside the settings gear, the same height, that opens the Admin sheet (a centred
 * panel on a wide screen, a bottom sheet on a phone) over the page, never pushing it about. A brass dot on the button
 * while Update now is counting down.
 */
function AdminButton({ restarting, children }: { restarting: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={`btn ghost admin-toggle${open ? ' open' : ''}`} aria-expanded={open} aria-haspopup="dialog" data-testid="admin-toggle" onClick={() => setOpen(true)}>
        Admin{restarting && <span className="admin-dot" aria-hidden="true" />}
      </button>
      {open && (
        <Sheet title="Admin" className="admin-sheet" onClose={() => setOpen(false)}>
          {children}
        </Sheet>
      )}
    </>
  );
}

/**
 * `/join/<code>`: someone sent you a link. Pick a deck from the gallery and join. Who invited you is not shown: the
 * server only reveals a game to people who joined it (an unknown or used link is only reported when you try), so the
 * format isn't either: the shared Brawl decks are listed after my own for a Brawl link.
 */
function JoinPage({
  mine,
  brawl,
  cropUrl,
  list,
  opening,
  error,
  paused,
  atCap,
  onJoin,
}: {
  mine: DeckList | null | undefined;
  /** My decks plus the shared Brawl decks. */
  brawl: DeckList | null | undefined;
  cropUrl: (c: string) => string;
  list: MatchList | null;
  opening: string | null;
  error: string | null;
  paused: boolean;
  atCap: boolean;
  onJoin: (deck: string) => Promise<void>;
}) {
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const names = mine ? [...mine.names, ...(brawl?.names.filter((n) => !mine.names.includes(n)) ?? [])] : (mine ?? undefined);
  const details = { ...(brawl?.details ?? {}), ...(mine?.details ?? {}) };
  const deck = picked ?? defaultDeck(names, loadPref(DECK_PREF));
  const shared = !!mine && !!brawl && brawl.names.some((n) => !mine.names.includes(n));
  return (
    <div className="start-screen lobby home join-page" data-testid="join-page">
      <header className="home-head">
        <div className="brand">
          <img src="./favicon.svg" width={38} height={38} alt="" />
          <h1 className="name">Forge Table</h1>
        </div>
      </header>
      <div className="join-body">
        <div className="home-h">
          <h2>You’re invited</h2>
          <span className="home-sub">{list ? `Signed in as ${list.user}. A friend wants to play Magic with you.` : 'Connecting…'}</span>
        </div>
        {names === undefined && <span className="hint">Loading your decks…</span>}
        {names === null && <DeckField decks={null} value={deck} onChange={setPicked} label="Your deck" />}
        {names && names.length === 0 && <span className="hint warn">You have no decks yet. Start a game against the AI to import one.</span>}
        {names && names.length > 0 && <DeckGallery label="Your deck" names={names} details={details} selected={deck} onPick={setPicked} cropUrl={cropUrl} />}
        {shared && <span className="hint">Your decks first, then the shared Brawl decks. A Brawl game needs a deck with a commander.</span>}
        {paused && <div className="hint warn">Server is updating, new games are paused.</div>}
        {atCap && <div className="hint warn">You’re at your game limit. End one in the lobby first.</div>}
        {error && (
          <div className="error" role="alert" data-testid="join-error">
            {error}
          </div>
        )}
        {opening && <div className="hint" role="status">You’re in. The game opens by itself when it’s ready.</div>}
        <div className="join-actions">
          <a className="btn ghost" href="/" data-testid="to-lobby">
            Lobby
          </a>
          <span className="ng-spacer" />
          <button
            className="btn primary cta"
            disabled={!list || busy || !!opening || !deck || paused || atCap}
            data-testid="join-go"
            onClick={() => {
              setBusy(true);
              void onJoin(deck).finally(() => setBusy(false));
            }}
          >
            <span>{opening ? 'Joined…' : busy ? 'Joining…' : 'Join game'}</span>
            {deck && !opening && !busy && <span className="sub">with {deck}</span>}
          </button>
        </div>
      </div>
    </div>
  );
}
