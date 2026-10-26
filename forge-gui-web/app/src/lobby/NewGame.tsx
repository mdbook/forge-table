/**
 * New game: format, my deck, the opponent and its deck on one page with a summary rail and Start (Enter);
 * on a phone the same pieces are three steps (Format, Deck, Opponent) over a sticky summary bar, Start always in reach.
 * Decks are a gallery (key-card art, colours, card count) with search, colour chips and a Random tile. The opponent is
 * an AI or, on a server with Play a friend, "A friend": someone online (they get an invite card) or a link.
 * In Brawl the picked deck opens a drawer: its commander's art and colours, and what makes it legal as a
 * checklist.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ManaText } from '../hud/ManaText';
import { loadManaFont } from '../theme/manaFont';
import { Art } from './Art';
import type { MatchStartParams } from '@forge-table/protocol';
import { resolveDeck } from '../hud/start';
import type { DeckCards, DeckList, LobbyFormat, NewMatch, Person } from './api';
import { findPeople, personLine, recordText } from './home';
import { AiGlyph, AiPhoto, Avatar, CheckBadge, FormatGlyph } from './people';
import { DeckCardsSheet, DeckGallery, DeckPickerSheet } from './DeckGallery';
import { brawlChecks, deckMeta, offStandard, opponents, pipText, playable, RANDOM_DECK, recommendedAi, startPlan, versusLine, type Picks } from './newGame';

const FORMATS: { id: LobbyFormat | undefined; name: string; blurb: string }[] = [
  { id: undefined, name: 'Constructed', blurb: 'Any of your decks. 20 life, best of one.' },
  { id: 'standard', name: 'Standard', blurb: 'Cards from the current Standard sets, no bans. 20 life.' },
  { id: 'brawl', name: 'Brawl', blurb: 'A legendary commander leads a singleton deck. 25 life.' },
];

/** What the gallery says when no deck can be listed, and when some are left out (`n` of them). */
const NONE_LISTED: Record<LobbyFormat | 'constructed', { none: string; hidden?: (n: number) => string }> = {
  constructed: { none: 'You have no decks yet. Import one to play.' },
  standard: {
    none: 'None of your decks is a 60-card deck without a commander. Import a Standard deck.',
    hidden: (n) => `${n} of your decks are under 60 cards or have a commander, so they’re not listed for Standard.`,
  },
  brawl: {
    none: 'None of your decks has a commander. Import a 100-card Brawl deck.',
    hidden: (n) => `${n} of your decks have no commander, so they’re not listed for Brawl.`,
  },
};

const STEPS = ['Format', 'Deck', 'Opponent'] as const;

export interface NewGameProps {
  /** By format: undefined while loading, null when the server can't list decks. */
  decks: { constructed: DeckList | null | undefined; brawl: DeckList | null | undefined };
  picks: Picks;
  onPicks: (p: Picks) => void;
  /** Switch format: the lobby brings back that format's last picks. */
  onFormat: (f: LobbyFormat | undefined) => void;
  phone: boolean;
  cropUrl: (card: string) => string;
  /** A card's full scan, for the Cards peek; absent: the peek shows art crops. */
  cardUrl?: (card: string) => string;
  /** The Neural AI's picture, when the server has one: its tile shows it instead of the spark. */
  neuralAvatar?: string;
  /** Why Start can't be pressed (server updating, at the game cap), or null. */
  blocked: string | null;
  creating: boolean;
  /** Play a friend: who I can play (online, in a game, away) and whether a link may let guests in; undefined on a server without it. */
  friends?: { people: Person[]; guests: boolean };
  /** Open on the "A friend" tab. */
  friendFirst?: boolean;
  /** A deck's cards for the "Cards" peek; absent where the server can't list them. */
  cardsOf?: (name: string, format?: LobbyFormat) => Promise<DeckCards | null>;
  onStart: (plan: { create: NewMatch; start: MatchStartParams }, line: string) => void;
  /** Make a friend game with my (resolved) deck: held for `invite` (an online user's key), else waiting for its link. */
  onFriend: (deck: string, how: FriendHow) => void;
  onImport: () => void;
  onBack: () => void;
}

export interface FriendHow {
  invite?: string;
  listed: boolean;
  guests: boolean;
}

export function NewGame(props: NewGameProps) {
  const { picks, onPicks, phone, cropUrl } = props;
  const list = picks.format === 'brawl' ? props.decks.brawl : props.decks.constructed;
  const details = list?.details ?? {};
  const pool = useMemo(() => (list ? playable(list.names, list.details, picks.format) : []), [list, picks.format]);
  const [step, setStep] = useState(0);
  const friends = props.friends;
  const [vsFriend, setVsFriend] = useState(!!props.friendFirst && !!friends);
  /** The deck whose cards are showing, and whether the AI's deck picker is open. */
  const [peek, setPeek] = useState<string | null>(null);
  const [oppPicker, setOppPicker] = useState(false);
  /** The online user picked (their key), or null for a link. */
  const [friend, setFriend] = useState<string | null>(null);
  const [listed, setListed] = useState(true);
  const [guests, setGuests] = useState(false);
  const person = friends?.people.find((u) => u.key === friend && u.state !== 'away');
  const [who, setWho] = useState('');
  const here = friends ? friends.people.filter((p) => p.state !== 'away').length : 0;
  const shownPeople = useMemo(() => findPeople(friends?.people ?? [], who), [friends, who]);
  const off = useMemo(() => (list && picks.format === 'standard' ? offStandard(list.names, list.details) : []), [list, picks.format]);
  const neural = (list ?? props.decks.constructed)?.neural !== false;
  const opps = opponents(list?.neuralLabel ?? props.decks.constructed?.neuralLabel, neural);
  const rec = recommendedAi(picks.format, neural);
  const opp = opps.find((o) => o.ai === picks.ai) ?? opps[0]!;
  const hidden = list ? list.names.length - pool.length - off.length : 0;

  const deckName = picks.deck === RANDOM_DECK ? 'Random deck' : (picks.deck ?? 'Pick a deck');
  const d = picks.deck && picks.deck !== RANDOM_DECK && Object.hasOwn(details, picks.deck) ? details[picks.deck] : undefined;
  /** What the AI plays when its deck is left to it. */
  const usual = picks.ai === 'Neural' && !picks.format ? 'Plays her strongest trained deck' : picks.format === 'brawl' ? 'A random Brawl deck' : 'Their usual deck';
  const theirs =
    picks.oppDeck === undefined
      ? usual
      : picks.oppDeck === RANDOM_DECK
        ? 'A random deck'
        : picks.oppDeck;
  const canStart = !props.blocked && !props.creating && !!picks.deck && pool.length > 0;
  const oppName = vsFriend ? (person?.name ?? 'Whoever has the link') : opp.name;
  const line = versusLine(deckName, oppName);

  // The colour pips use the Mana font, which only the table loads otherwise.
  useEffect(() => void loadManaFont(), []);
  const onCards = props.cardsOf ? (n: string) => setPeek(n) : undefined;
  // Brawl decks sit in a folder the router only looks in when asked for brawl.
  const { cardsOf } = props;
  const loadCards = useCallback((n: string) => cardsOf?.(n, picks.format) ?? Promise.resolve(null), [cardsOf, picks.format]);

  const start = () => {
    if (!canStart) return;
    if (vsFriend) {
      const deck = resolveDeck(picks.deck, pool);
      if (deck) props.onFriend(deck, { ...(person ? { invite: person.key } : {}), listed, guests: guests && !!friends?.guests });
      return;
    }
    const plan = startPlan(picks, pool);
    if (plan) props.onStart(plan, versusLine(plan.create.deck ?? deckName, opp.name));
  };

  // Enter starts, Esc goes back; not while typing in search or with a control focused (Enter presses that instead).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const busy = !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'A');
      // A dialog (deck picker, card list) is up: Esc and Enter are its.
      if (peek !== null || oppPicker) return;
      if (e.key === 'Escape' && !(t?.tagName === 'INPUT' && (t as HTMLInputElement).value)) props.onBack();
      else if (e.key === 'Enter' && !busy) start();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const pickFormat = (f: LobbyFormat | undefined) => {
    if (phone && step === 0) setStep(1);
    if (f === picks.format) return;
    props.onFormat(f);
  };

  const formatPane = (
    <section className="ng-section" aria-label="Format">
      {!phone && <h3 className="ng-label">Format</h3>}
      {phone && <h3 className="ng-label big">What are we playing?</h3>}
      <div className="ng-formats" role="radiogroup" aria-label="Format">
        {FORMATS.map((f) => {
          const on = picks.format === f.id;
          return (
            <button key={f.name} className={`ng-format${on ? ' on' : ''}`} role="radio" aria-checked={on} data-testid={`ng-format-${f.id ?? 'constructed'}`} onClick={() => pickFormat(f.id)}>
              <span className="ng-format-ic" aria-hidden="true">
                <FormatGlyph format={f.id} size={22} />
              </span>
              <b>{f.name}</b>
              <span>{f.blurb}</span>
            </button>
          );
        })}
      </div>
    </section>
  );

  const deckPane = (
    <section className="ng-section ng-decks" aria-label="Your deck">
      <DeckGallery
        key={picks.format ?? 'constructed'}
        label="Your deck"
        names={list ? pool : []}
        details={details}
        selected={picks.deck}
        onPick={(n) => onPicks({ ...picks, deck: n })}
        cropUrl={cropUrl}
        {...(onCards ? { onCards } : {})}
        random={{ value: RANDOM_DECK }}
        {...(off.length ? { off: { names: off, title: 'Not Standard-legal', why: (n: string) => details[n]?.standard ?? '' } } : {})}
        tools={
          <button className="btn secondary ng-import" data-testid="ng-import" disabled={!!props.blocked || props.creating} onClick={props.onImport}>
            Import
          </button>
        }
        empty={
          <>
            {list === undefined && <span className="hint">Loading your decks…</span>}
            {list === null && <span className="hint warn">This server can’t list decks. Use Import, or pick on the game’s start screen.</span>}
            {list && pool.length === 0 && (
              <span className="hint warn" data-testid="ng-no-decks">
                {NONE_LISTED[picks.format ?? 'constructed'].none}
              </span>
            )}
          </>
        }
      />
      {hidden > 0 && picks.format && <span className="hint">{NONE_LISTED[picks.format].hidden?.(hidden)}</span>}
      {picks.format === 'brawl' && d?.commander && (
        <div className="ng-brawl" data-testid="ng-brawl">
          <Art card={d.commander} colors={d.colors} cropUrl={cropUrl} className="ng-brawl-art" />
          <div className="ng-brawl-body">
            <span className="ng-brawl-tag">Commander</span>
            <span className="ng-brawl-name">{d.commander}</span>
            {d.colors && (
              <span className="ng-brawl-colors">
                <ManaText text={pipText(d.colors)} />
              </span>
            )}
            <ul className="ng-checks">
              {brawlChecks(d).map((c) => (
                <li key={c.text} className={c.ok ? 'ok' : 'bad'} data-testid="ng-check">
                  <span aria-hidden="true">{c.ok ? '✓' : '✗'}</span>
                  {c.text}
                </li>
              ))}
            </ul>
            <span className="hint">Colour identity and card legality are checked when the game starts.</span>
          </div>
        </div>
      )}
    </section>
  );

  const aiPane = (
    <div className="ng-opps" data-testid="ng-opps">
      {opps.map((o) => {
        const sel = o.ai === picks.ai;
        return (
          <button key={o.ai} className={`ng-opp${sel ? ' sel' : ''}${o.ai === rec ? ' rec' : ''}`} aria-pressed={sel} data-testid="ng-opp" data-ai={o.ai} onClick={() => onPicks({ ...picks, ai: o.ai })}>
            <span className={`ng-opp-face${o.ai === 'Neural' ? ' neural' : ''}`} aria-hidden="true">
              {o.ai === 'Neural' ? <AiPhoto src={props.neuralAvatar} alt={o.name} fallback={<AiGlyph neural />} /> : <AiGlyph neural={false} />}
            </span>
            <b>
              {o.name}
              {o.ai === rec && <span className="ng-rec">Recommended</span>}
            </b>
            <span className="ng-opp-blurb">{o.blurb}</span>
            <span className="ng-opp-style">{o.style}</span>
          </button>
        );
      })}
    </div>
  );

  /**
   * A friend: who I can play as tiles (online, in a game: they see the invite after it, away: can't be invited),
   * with search; tap again to go back to a link. Then the link card and its two switches.
   */
  const friendPane = friends && (
    <div className="ng-friend-pane">
      {friends.people.length === 0 && <span className="hint">Nobody else is online right now. Send a link instead.</span>}
      {friends.people.length > 0 && (
        <div className="ng-people" role="group" aria-label="People" data-testid="ng-people">
          {shownPeople.map((u) => {
            const sel = u.key === friend;
            const away = u.state === 'away';
            return (
              <button key={u.key} className={`ng-person ${u.state}${sel ? ' sel' : ''}`} aria-pressed={sel} disabled={away} data-testid="ng-person" onClick={() => setFriend(sel ? null : u.key)}>
                <Avatar name={u.name} state={u.state} size="lg" />
                <span className="ng-person-body">
                  <b>{u.name}</b>
                  <span>{personLine(u, Date.now())}</span>
                </span>
                {sel && <CheckBadge />}
              </button>
            );
          })}
          {shownPeople.length === 0 && <span className="hint">Nobody by that name.</span>}
        </div>
      )}
      <div className="ng-link">
        <div className={`ng-link-card${person ? '' : ' on'}`}>
          <b>
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
              <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            {person ? 'They can also join by link' : 'Or send a link'}
          </b>
          <span className="hint">
            {guests && friends.guests
              ? 'Works once, for 15 minutes, signed in or as a guest.'
              : 'Works once, for 15 minutes, for anyone signed in.'}{' '}
            Once the game is made, the link waits on its card in your lobby with a Copy button.
          </span>
        </div>
        <div className="ng-link-opts">
          <label className="switch-row">
            <input type="checkbox" role="switch" className="switch" checked={listed} data-testid="friend-listed" onChange={(e) => setListed(e.target.checked)} />
            <span>List in open tables, so anyone signed in can join</span>
          </label>
          {friends.guests && (
            <label className="switch-row">
              <input type="checkbox" role="switch" className="switch" checked={guests} data-testid="friend-guests" onChange={(e) => setGuests(e.target.checked)} />
              <span>Allow guests (no sign-in, shared decks only)</span>
            </label>
          )}
        </div>
      </div>
    </div>
  );

  const oppPane = (
    <section className="ng-section" aria-label="Opponent">
      <div className="ng-head">
        <h3 className="ng-label">Opponent</h3>
        <span className="ng-who" role="group" aria-label="Play against">
          <button className={vsFriend ? '' : 'on'} aria-pressed={!vsFriend} data-testid="ng-ai" onClick={() => setVsFriend(false)}>
            AI
          </button>
          {friends && (
            <button className={vsFriend ? 'on' : ''} aria-pressed={vsFriend} data-testid="ng-friend" onClick={() => setVsFriend(true)}>
              A friend{here > 0 && <span className="ng-online">{here} online</span>}
            </button>
          )}
        </span>
        {vsFriend && friends && friends.people.length > 4 && (
          <>
            <span className="ng-spacer" />
            <span className="ng-search-wrap">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <path d="M10.5 10.5l3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <input className="field ng-search" type="search" placeholder="Find someone" aria-label="Find someone" value={who} onChange={(e) => setWho(e.target.value)} data-testid="ng-find" />
            </span>
          </>
        )}
      </div>
      {vsFriend ? friendPane : aiPane}
    </section>
  );

  const oppDetail = picks.oppDeck && picks.oppDeck !== RANDOM_DECK && Object.hasOwn(details, picks.oppDeck) ? details[picks.oppDeck] : undefined;
  const theirPick = picks.ai === 'Neural' && !picks.format ? `${opp.name} picks` : 'Their pick';
  const theirDeck = !vsFriend && list && pool.length > 0 && (
    <button className="deck-chip ng-their" aria-label={`Their deck: ${picks.oppDeck === undefined ? theirPick : picks.oppDeck === RANDOM_DECK ? 'Random deck' : picks.oppDeck}. Change`} data-testid="ng-opp-deck" onClick={() => setOppPicker(true)}>
      <Art card={oppDetail?.key} colors={oppDetail?.colors ?? ''} cropUrl={cropUrl} className="deck-chip-art" />
      <span className="deck-chip-body">
        <span className="deck-chip-k">Their deck</span>
        <span className="deck-chip-name">{picks.oppDeck === undefined ? theirPick : picks.oppDeck === RANDOM_DECK ? 'Random deck' : picks.oppDeck}</span>
      </span>
      <span className="deck-chip-chev" aria-hidden="true" />
    </button>
  );
  const pickOpp = (v: string | undefined) => {
    const { oppDeck: _drop, ...rest } = picks;
    onPicks(v === undefined ? rest : { ...rest, oppDeck: v });
  };
  const oppSheet = oppPicker && list && (
    <DeckPickerSheet
      title={`${opp.name}’s deck`}
      label="Their deck"
      onClose={() => setOppPicker(false)}
      names={pool}
      details={details}
      selected={picks.oppDeck ?? ''}
      onPick={(n) => pickOpp(n === '' ? undefined : n)}
      cropUrl={cropUrl}
      {...(onCards ? { onCards } : {})}
      random={{ value: RANDOM_DECK, sub: `One of ${pool.length}, new each game` }}
      lead={
        <span className="ng-cell">
          <button className={`ng-deck lead${picks.oppDeck === undefined ? ' sel' : ''}`} aria-pressed={picks.oppDeck === undefined} data-testid="ng-opp-default" onClick={() => { pickOpp(undefined); setOppPicker(false); }}>
            <span className="ng-art-wrap">
              <span className="ng-art ng-ai-art" aria-hidden="true">
                <span className="game-disc">AI</span>
              </span>
            </span>
            <span className="ng-deck-meta">
              <span className="ng-deck-name">{theirPick}</span>
              <span className="ng-deck-sub">{usual}</span>
            </span>
          </button>
        </span>
      }
    />
  );
  const peekSheet = peek !== null && props.cardsOf && (
    <DeckCardsSheet name={peek} {...(Object.hasOwn(details, peek) ? { d: details[peek] } : {})} load={loadCards} cropUrl={cropUrl} {...(props.cardUrl ? { cardUrl: props.cardUrl } : {})} {...(picks.format ? { format: picks.format } : {})} onClose={() => setPeek(null)} />
  );

  const startButton = (
    <button className="btn primary cta ng-start" disabled={!canStart} data-testid="ng-start" title={props.blocked ?? undefined} onClick={start}>
      <span>{props.creating ? (vsFriend ? 'Creating…' : 'Starting…') : vsFriend ? (person ? `Invite ${person.name}` : 'Create link') : 'Start game'}</span>
      {!phone && <span className="sub">{props.blocked ?? 'Enter'}</span>}
    </button>
  );

  const rail = (
    <aside className="ng-rail" aria-label="Your game" data-testid="ng-rail">
      <h3 className="ng-label">Your game</h3>
      <div className="ng-sum-deck">
        <Art card={d?.key} colors={d?.colors ?? ''} cropUrl={cropUrl} className="ng-sum-art" />
        <span className="ng-sum-body">
          <span className="ng-sum-k">You play</span>
          <span className="ng-sum-name" data-testid="ng-sum-deck">
            {deckName}
          </span>
          <span className="ng-sum-meta">
            {d?.colors && <ManaText text={pipText(d.colors)} />} {picks.deck === RANDOM_DECK ? `drawn from ${pool.length} decks when the game starts` : deckMeta(d)}
            {d?.record && d.record.w + d.record.l > 0 && <span className="ng-record"> · {recordText(d.record)}</span>}
          </span>
          {onCards && d && picks.deck && (
            <button className="link-btn ng-sum-peek" data-testid="ng-sum-peek" onClick={() => onCards(picks.deck!)}>
              See the cards
            </button>
          )}
        </span>
      </div>
      <span className="ng-versus">versus</span>
      <div className="ng-sum-opp">
        <span className="ng-sum-name" data-testid="ng-sum-opp">
          {oppName}
        </span>
        <span className="ng-sum-meta">{vsFriend ? (person ? 'Gets an invite card in their lobby' : 'A join link, for 15 minutes') : theirs}</span>
      </div>
      {theirDeck}
      <span className="ng-spacer" />
      {startButton}
    </aside>
  );

  if (phone) {
    const panes = [formatPane, deckPane, oppPane];
    return (
      <div className="newgame phone" data-testid="new-game-view">
        <header className="ng-top">
          <button className="btn ghost ng-back" aria-label="Back to the lobby" onClick={props.onBack}>
            ‹
          </button>
          <h2>New game</h2>
          <span className="ng-fmt-tag">{FORMATS.find((f) => f.id === picks.format)?.name ?? 'Constructed'}</span>
        </header>
        <nav className="ng-steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <button key={s} className={i === step ? 'on' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined} onClick={() => setStep(i)}>
              <span className="n">{i < step ? '✓' : i + 1}</span>
              {s}
            </button>
          ))}
        </nav>
        <div className="ng-pane">
          {panes[step]}
          {step === 2 && theirDeck}
        </div>
        <div className="ng-bar" data-testid="ng-bar">
          <Art card={d?.key} colors={d?.colors ?? ''} cropUrl={cropUrl} className="ng-bar-art" />
          <span className="ng-bar-line" aria-label={line}>
            <b>{deckName}</b>
            <span>vs {oppName}</span>
          </span>
          <span className="ng-bar-actions">
            {step < 2 && (
              <button className="btn secondary" data-testid="ng-next" onClick={() => setStep(step + 1)}>
                Next<span className="ng-next-step">: {STEPS[step + 1]}</span>
              </button>
            )}
            {startButton}
          </span>
        </div>
        {oppSheet}
        {peekSheet}
      </div>
    );
  }

  return (
    <div className="newgame" data-testid="new-game-view">
      <div className="ng-main">
        <header className="ng-top">
          <button className="btn ghost ng-back" aria-label="Back to the lobby" onClick={props.onBack}>
            ‹
          </button>
          <h2>New game</h2>
          <span className="ng-sub">against the AI{friends ? ' or a friend' : ''}</span>
        </header>
        {formatPane}
        {deckPane}
        {oppPane}
      </div>
      {rail}
      {oppSheet}
      {peekSheet}
    </div>
  );
}
