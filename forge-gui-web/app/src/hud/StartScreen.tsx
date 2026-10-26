/**
 * The start screen (tiny lobby): decks, the AI opponent (Neural by default when the sidecar can run it),
 * the card-art preference, and deck import (a button, or a deck file dropped anywhere on the screen). A Brawl game
 * lists only the decks that can be played in it, and the AI plays a random one unless one is picked.
 * Either deck can be "Random deck": one of the decks its picker lists, drawn when Start is pressed.
 */
import { useCallback, useEffect, useState, type DragEvent } from 'react';
import type { MatchStartParams } from '@forge-table/protocol';
import { guestTable, underRouter } from '../net/token';
import { runtime } from '../runtime';
import { useUi } from '../store/uiStore';
import { DeckPickerSheet } from '../lobby/DeckGallery';
import { LobbyApi, type DeckDetail } from '../lobby/api';
import { ImportPanel } from './ImportPanel';
import { AnvilMark } from './Panels';
import { pvpStartView, readyButton } from './pvp';
import {
  FAN_CONTENT,
  NEURAL,
  RANDOM_DECK,
  aiLabel,
  aiOptions,
  deckFileProblem,
  deckGroups,
  defaultOppDeck,
  formatLabel,
  importError,
  neuralNote,
  oppDeckGroups,
  pickerArt,
  pickerArtSource,
  readFileText,
  resolveDeck,
  versionLine,
} from './start';

interface ImportSeed {
  /** Remounts the panel for each drop. */
  n: number;
  file: { name: string; text: string } | null;
  error: string | null;
}

/** A deck pick as words: Random deck, the name, or a prompt while there is none. */
function deckWord(v: string | undefined): string {
  return v === RANDOM_DECK ? 'Random deck' : (v ?? 'Pick a deck');
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

export function StartScreen() {
  const start = useUi((s) => s.start);
  const welcome = useUi((s) => s.welcome);
  const lobby = useUi((s) => s.pvp?.lobby ?? null);
  const status = useUi((s) => s.status);
  const artMode = useUi((s) => s.artMode);
  const artAllowed = useUi((s) => s.artAllowed);
  const [deck, setDeck] = useState<string | undefined>(undefined);
  const [opp, setOpp] = useState<string | undefined>(undefined);
  const [ai, setAi] = useState<string | undefined>(undefined);
  const [importing, setImporting] = useState<ImportSeed | null>(null);
  /** The deck gallery open for my deck or the opponent's. */
  const [picker, setPicker] = useState<'mine' | 'theirs' | null>(null);
  const [dragging, setDragging] = useState(false);
  // Behind the router the picker's art comes from the lobby's api, for the deck list it was loaded with.
  const [artSource] = useState(() => pickerArtSource(underRouter(), guestTable()));
  const [api] = useState(() => new LobbyApi(null));
  const [lobbyArt, setLobbyArt] = useState<{ decks: string[]; details: Record<string, DeckDetail> } | null>(null);
  const d = deck ?? start.deck;
  const a = ai ?? start.ai;
  const format = welcome?.format;
  const groups = oppDeckGroups(start.decks, welcome?.neural);
  const byFormat = deckGroups(start.decks, start.problems);
  // What the pickers list (and Random draws from): in a format game only the decks that can be played there.
  const pool = format ? byFormat.legal : start.decks;
  // A deck that can't be played isn't listed, but can still be the one picked (just imported): say why.
  const illegal = byFormat.illegal.find((x) => x.name === d);
  // Until the user picks one, the opponent deck follows the AI: Neural gets a deck it was trained on. A format game: random.
  const o = opp ?? (format ? (start.oppDeck ?? RANDOM_DECK) : defaultOppDeck(a, groups.trained, start.oppDeck));
  const live = status === 'open' && !!welcome;
  const ready = live && !start.starting && pool.length > 0 && !!d && !illegal;
  const pv = lobby ? pvpStartView(lobby) : null;
  const rb = lobby ? readyButton(lobby.youReady, deck, start.sent, start.starting) : null;
  // PvP after a game (a rematch being set up, or the opponent left): Leave tells the other player, then goes to the lobby.
  const afterGame = !!lobby && (!!lobby.rematch || !!lobby.oppLeft);
  const options = aiOptions(start.ais.length ? start.ais : a ? [a] : [], welcome?.neural);
  const note = neuralNote(welcome?.neural);
  const art = pickerArt(artSource, lobbyArt?.decks === start.decks ? lobbyArt.details : null, (c) => api.cropUrl(c));

  const closeImport = useCallback(() => setImporting(null), []);
  const openImport = (file: ImportSeed['file'] = null, error: string | null = null) =>
    setImporting((cur) => ({ n: (cur?.n ?? 0) + 1, file, error }));

  // The lobby's Import: straight into deck import once the game is up.
  useEffect(() => {
    if (!start.importFirst || !live) return;
    useUi.setState((s) => ({ start: { ...s.start, importFirst: false } }));
    openImport();
  }, [start.importFirst, live]);

  // The deck art, fetched when a picker opens (again once an import changes the decks). No login: names only.
  useEffect(() => {
    if (!picker || artSource !== 'lobby' || lobbyArt?.decks === start.decks) return;
    const decks = start.decks;
    let gone = false;
    api.deckList(format).then(
      (l) => !gone && setLobbyArt({ decks, details: l?.details ?? {} }),
      () => !gone && setLobbyArt({ decks, details: {} }),
    );
    return () => {
      gone = true;
    };
  }, [picker, artSource, api, lobbyArt, start.decks, format]);

  // Started with the lobby's picks: a loader, not the pickers (they come back if the game refuses the picks).
  if (start.auto && start.starting) {
    return (
      <div className="start-screen" data-testid="start-screen">
        <div className="panel shuffling" data-testid="start-auto" role="status">
          <AnvilMark size={44} />
          <span className="shuffling-kicker">Shuffling up</span>
          <span className="shuffling-line">{start.auto}</span>
          <span className="shuffling-bar" aria-hidden="true">
            <span />
          </span>
        </div>
      </div>
    );
  }

  // A saved game between two people: it goes on by itself once both are back, there's no deck to pick.
  if (lobby?.resuming) {
    return (
      <div className="start-screen" data-testid="start-screen">
        <div className="panel shuffling" data-testid="start-resuming" role="status">
          <AnvilMark size={44} />
          <span className="shuffling-kicker">Picking up where you left off</span>
          <span className="shuffling-line">Waiting for {lobby.opponent ?? 'your opponent'}…</span>
        </div>
      </div>
    );
  }

  const onDrop = async (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (!f || !live) return;
    const problem = deckFileProblem(f);
    if (problem) {
      openImport(null, problem);
      return;
    }
    try {
      openImport({ name: f.name, text: await readFileText(f) });
    } catch (err) {
      openImport(null, importError(err));
    }
  };

  return (
    <div
      className={`start-screen${dragging ? ' dragging' : ''}`}
      data-testid="start-screen"
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = live ? 'copy' : 'none';
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="panel">
        <div className="brand">
          <AnvilMark size={44} />
          <span className="name">Forge Table</span>
        </div>
        <div className="sub">
          {welcome ? `${formatLabel(format)} · 1v1 ${lobby ? (lobby.opponent ? `vs ${lobby.opponent}` : 'vs a friend') : 'vs AI'} · Forge ${welcome.forgeVersion}` : 'Connecting to the server…'}
        </div>
        {pv && (
          <div className={`pvp-status${pv.starting ? ' starting' : ''}`} data-testid="pvp-status" role="status">
            <span className="pvp-headline">{pv.headline}</span>
            {pv.detail && <span className="hint">{pv.detail}</span>}
            {pv.ticks.length > 0 && (
              <span className="pvp-ticks">
                {pv.ticks.map((t) => (
                  <span key={t.name} className={t.ready ? 'on' : ''} data-testid="pvp-tick">
                    {t.ready ? '✓' : '…'} {t.name}
                  </span>
                ))}
              </span>
            )}
          </div>
        )}
        <div className="ss-picks">
          <div className="ss-field">
            <span className="pf-field-label">Your deck</span>
            <button className="deck-chip ss-chip" disabled={pool.length === 0} aria-label={`Your deck: ${deckWord(d)}. Change`} data-testid="deck-select" onClick={() => setPicker('mine')}>
              <span className="deck-chip-name">{deckWord(d)}</span>
              <span className="deck-chip-chev" aria-hidden="true" />
            </button>
            {illegal && (
              <span className="hint warn" data-testid="deck-problem">
                {illegal.name} {illegal.why}
              </span>
            )}
            {format && byFormat.legal.length === 0 && start.decks.length > 0 && (
              <span className="hint warn" data-testid="deck-none-legal">
                None of your decks can be played in {formatLabel(format)}. Import a {format === 'brawl' ? '100-card Brawl' : 'Standard'} deck.
              </span>
            )}
          </div>
          {!lobby && (
            <div className="ss-field">
              <span className="pf-field-label">Opponent deck</span>
              <button className="deck-chip ss-chip" disabled={pool.length === 0} aria-label={`Opponent deck: ${deckWord(o)}. Change`} data-testid="opp-deck-select" onClick={() => setPicker('theirs')}>
                <span className="deck-chip-name">{deckWord(o)}</span>
                {!format && o && groups.trained.includes(o) && <span className="ss-tag">{aiLabel(NEURAL)}-trained</span>}
                <span className="deck-chip-chev" aria-hidden="true" />
              </button>
            </div>
          )}
          {!lobby && (
            <div className="ss-field">
              <span className="pf-field-label">AI opponent</span>
              <div className="pf-tabs" role="radiogroup" aria-label="AI opponent" data-testid="ai-select">
                {options.map((op) => (
                  <button key={op.name} role="radio" aria-checked={a === op.name} className={a === op.name ? 'on' : ''} disabled={op.disabled} data-testid={`ai-${op.name}`} onClick={() => setAi(op.name)}>
                    {op.label}
                  </button>
                ))}
              </div>
              {note && (
                <span className="hint warn" data-testid="neural-note">
                  {note}
                </span>
              )}
            </div>
          )}
          <div className="ss-field">
            <span className="pf-field-label">Card art</span>
            <div className="pf-tabs" role="group" aria-label="Card art" data-testid="art-toggle">
              <button
                className={artAllowed && artMode === 'scryfall' ? 'on' : ''}
                disabled={!artAllowed}
                aria-pressed={artAllowed && artMode === 'scryfall'}
                data-testid="art-scryfall"
                onClick={() => runtime().setArtMode('scryfall')}
              >
                Scryfall
              </button>
              <button
                className={artAllowed && artMode === 'frame' ? 'on' : ''}
                disabled={!artAllowed}
                aria-pressed={artAllowed && artMode === 'frame'}
                data-testid="art-frame"
                onClick={() => runtime().setArtMode('frame')}
              >
                Framed
              </button>
              <button
                className={!artAllowed || artMode === 'procedural' ? 'on' : ''}
                disabled={!artAllowed}
                aria-pressed={!artAllowed || artMode === 'procedural'}
                data-testid="art-procedural"
                onClick={() => runtime().setArtMode('procedural')}
              >
                Procedural
              </button>
            </div>
            {!artAllowed && <span className="hint">set by the page address</span>}
          </div>
        </div>
        {picker && (
          <div className="lobby deck-pick-host">
            <DeckPickerSheet
              title={picker === 'mine' ? 'Your deck' : 'Opponent deck'}
              label={picker === 'mine' ? 'Your deck' : 'Their deck'}
              names={picker === 'theirs' && !format ? [...groups.trained, ...pool.filter((n) => !groups.trained.includes(n))] : pool}
              details={art.details}
              selected={(picker === 'mine' ? d : o) ?? ''}
              onPick={(n) => (picker === 'mine' ? setDeck(n) : setOpp(n))}
              cropUrl={art.cropUrl}
              random={{ value: RANDOM_DECK, sub: `One of ${pool.length}, new each game` }}
              onClose={() => setPicker(null)}
            />
          </div>
        )}
        {start.error && <div className="error">{start.error}</div>}
        <div className="row">
          {afterGame ? (
            <button className={`btn ${pv?.left ? 'primary' : 'ghost'}`} data-testid="pvp-leave" onClick={() => runtime().nextGame('QUIT')}>
              Leave
            </button>
          ) : (
            underRouter() &&
            !guestTable() && (
              <a className="btn ghost" href="/" data-testid="to-lobby">
                Lobby
              </a>
            )
          )}
          <button className="btn secondary" disabled={!live} data-testid="import-open" onClick={() => openImport()}>
            Import deck
          </button>
          <span className="spacer" />
          <button
            className="btn primary"
            style={{ minHeight: 56, minWidth: 180, fontSize: 20 }}
            disabled={!ready || (rb !== null && !rb.enabled) || !!pv?.left}
            data-testid="start-match"
            onClick={() => {
              const params: MatchStartParams = {};
              const mine = resolveDeck(d, pool);
              if (mine) params.deck = mine;
              // PvP: a random pick shows as the deck it drew (Ready ✓ until a different deck is picked). Against the AI
              // the picker stays on Random for the next game.
              if (lobby && mine !== d) setDeck(mine);
              // Against the AI only (a PvP rematch comes back here to pick again): tell the bridge which picks were "Random deck" so
              // it can re-roll them for Rematch instead of replaying the same resolved deck.
              if (!lobby && d === RANDOM_DECK) params.deckRandom = true;
              // PvP: only my deck goes; the opponent is a person, and marks themselves ready the same way.
              const theirs = resolveDeck(o, pool);
              if (!lobby && theirs) params.oppDeck = theirs;
              if (!lobby && o === RANDOM_DECK) params.oppDeckRandom = true;
              if (!lobby && a) params.ai = a;
              void runtime().startMatch(params);
            }}
          >
            {rb ? rb.label : start.starting ? 'Starting…' : 'Start'}
          </button>
        </div>
        {welcome && (
          <div className="hint versions" data-testid="versions">
            {versionLine(welcome)}
          </div>
        )}
        <div className="hint fan-content" data-testid="fan-content">
          {FAN_CONTENT}
        </div>
      </div>
      {dragging && !importing && <div className="drop-hint">Drop a deck file to import it</div>}
      {importing && (
        <ImportPanel
          key={importing.n}
          initialFile={importing.file}
          initialError={importing.error}
          onClose={closeImport}
          onImported={(name) => setDeck(name)}
        />
      )}
    </div>
  );
}

