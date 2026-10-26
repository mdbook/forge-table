/**
 * The deck gallery, wherever a deck is picked in the lobby: New game's own deck, the AI's deck, and my deck for a
 * friend's game (invite, open table). Tiles of key-card art with the deck's colours, name and size; search and colour
 * chips; a Random tile; a "Cards" peek on every deck; decks the format refuses greyed out with the reason.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ManaText } from '../hud/ManaText';
import { loadManaFont } from '../theme/manaFont';
import { Art, colorWash } from './Art';
import type { DeckCard, DeckCards, DeckDetail, LobbyFormat } from './api';
import { colorSplit, costColors, deckSums, groupCards, manaCurve } from './deckPeek';
import { deckMeta, filterDecks, pipText } from './newGame';
import { dayText, recordText } from './home';
import { CheckBadge } from './people';
import { Sheet } from './Sheet';

const COLORS = ['W', 'U', 'B', 'R', 'G'] as const;
const COLOR_NAME: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

type CropUrl = (c: string) => string;

const detailOf = (details: Record<string, DeckDetail>, n: string) => (Object.hasOwn(details, n) ? details[n] : undefined);

/** The deck's own tile, plus its "Cards" peek (a sibling: a button can't hold a button). `off` greys it out with why. */
export function DeckTile({ name, d, sel, onPick, cropUrl, onCards, off }: { name: string; d?: DeckDetail; sel: boolean; onPick: () => void; cropUrl: CropUrl; onCards?: () => void; off?: string }) {
  return (
    <span className={`ng-cell${off ? ' off' : ''}`}>
      <button className={`ng-deck${sel ? ' sel' : ''}`} aria-pressed={sel} disabled={!!off} data-testid="ng-deck" data-deck={name} onClick={onPick}>
        <span className="ng-art-wrap">
          <Art card={d?.key} colors={d?.colors ?? ''} cropUrl={cropUrl} className="ng-art" />
          {d && d.colors && (
            <span className="ng-pips">
              <ManaText text={pipText(d.colors)} />
            </span>
          )}
        </span>
        <span className="ng-deck-meta">
          <span className="ng-deck-name" title={name}>
            {name}
          </span>
          <span className="ng-deck-sub" title={off}>
            {off ?? d?.commander ?? deckMeta(d)}
            {!off && d?.record && d.record.w + d.record.l > 0 && <span className="ng-record"> · {recordText(d.record)}</span>}
          </span>
        </span>
        {sel && <CheckBadge />}
      </button>
      {onCards && (
        <button className="ng-peek" aria-label={`Cards in ${name}`} title="See the cards" data-testid="ng-peek" onClick={onCards}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <rect x="2.5" y="3.5" width="8" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M6 2.5h6a1.5 1.5 0 0 1 1.5 1.5v8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <span>Cards</span>
        </button>
      )}
    </span>
  );
}

/** Up to four decks' art, for the Random tile's mosaic. */
export function mosaicKeys(names: string[], details: Record<string, DeckDetail>, n = 4): string[] {
  const keys: string[] = [];
  for (const name of names) {
    const k = detailOf(details, name)?.key;
    if (k && !keys.includes(k)) keys.push(k);
    if (keys.length === n) break;
  }
  return keys;
}

/** "Random deck": a peek at the decks it draws from under a die, and how many. A new draw every game (and every rematch). */
export function RandomTile({ keys, count, sel, onPick, cropUrl, title = 'Random deck', sub }: { keys: string[]; count: number; sel: boolean; onPick: () => void; cropUrl: CropUrl; title?: string; sub?: string }) {
  return (
    <span className="ng-cell">
      <button className={`ng-deck random${sel ? ' sel' : ''}`} aria-pressed={sel} data-testid="ng-deck-random" onClick={onPick}>
        <span className="ng-art-wrap">
          <span className={`ng-art ng-mosaic n${keys.length}`} aria-hidden="true">
            {keys.map((k) => (
              <img key={k} src={cropUrl(k)} alt="" loading="lazy" decoding="async" />
            ))}
            <span className="ng-die">
              <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="8" cy="8" r="1.6" fill="currentColor" />
                <circle cx="16" cy="8" r="1.6" fill="currentColor" />
                <circle cx="12" cy="12" r="1.6" fill="currentColor" />
                <circle cx="8" cy="16" r="1.6" fill="currentColor" />
                <circle cx="16" cy="16" r="1.6" fill="currentColor" />
              </svg>
            </span>
          </span>
        </span>
        <span className="ng-deck-meta">
          <span className="ng-deck-name">{title}</span>
          <span className="ng-deck-sub">{sub ?? `One of ${count}, new each game`}</span>
        </span>
      </button>
    </span>
  );
}

export interface DeckGalleryProps {
  /** The decks to offer (already narrowed to the format). */
  names: string[];
  details: Record<string, DeckDetail>;
  /** The picked deck's name, RANDOM_DECK, or another lead tile's value. */
  selected?: string;
  onPick: (name: string) => void;
  cropUrl: CropUrl;
  /** The "Cards" peek; absent where the server can't list a deck's cards. */
  onCards?: (name: string) => void;
  /** Tiles before Random (the AI's "Their pick"). */
  lead?: ReactNode;
  /** Offer Random (its value is the caller's `random.value`). */
  random?: { value: string; sub?: string };
  /** Decks shown greyed out after the rest, each with why (Standard's off-format decks). */
  off?: { names: string[]; why: (name: string) => string; title: string };
  /** At the right of the toolbar (New game's Import). */
  tools?: ReactNode;
  label: string;
  /** Under the toolbar while nothing can be listed. */
  empty?: ReactNode;
  autoFocus?: boolean;
}

/** Search + colour chips over a grid of deck tiles that scrolls on its own; the count says how many match. */
export function DeckGallery(p: DeckGalleryProps) {
  const [query, setQuery] = useState('');
  const [colors, setColors] = useState<ReadonlySet<string>>(new Set());
  const shown = useMemo(() => filterDecks(p.names, p.details, query, colors), [p.names, p.details, query, colors]);
  const offShown = useMemo(() => (p.off ? filterDecks(p.off.names, p.details, query, colors) : []), [p.off, p.details, query, colors]);
  const keys = useMemo(() => mosaicKeys(p.names, p.details), [p.names, p.details]);
  const filtering = query.trim() !== '' || colors.size > 0;
  // The colour pips use the Mana font, which only the table loads otherwise.
  useEffect(() => void loadManaFont(), []);
  return (
    <div className="ng-gallery">
      <div className="ng-head">
        <h3 className="ng-label">{p.label}</h3>
        <span className="ng-count" data-testid="ng-count">
          {shown.length === p.names.length ? `${p.names.length} decks` : `${shown.length} of ${p.names.length} decks`}
        </span>
        <span className="ng-spacer" />
        <span className="ng-search-wrap">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M10.5 10.5l3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            className="field ng-search"
            type="search"
            placeholder="Search decks or cards"
            aria-label="Search decks"
            value={query}
            autoFocus={p.autoFocus}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="ng-search"
          />
        </span>
        <span className="ng-colors" role="group" aria-label="Colours">
          {COLORS.map((c) => {
            const on = colors.has(c);
            return (
              <button
                key={c}
                className={`ng-color${on ? ' on' : ''}`}
                aria-pressed={on}
                aria-label={COLOR_NAME[c]}
                onClick={() => {
                  const next = new Set(colors);
                  if (on) next.delete(c);
                  else next.add(c);
                  setColors(next);
                }}
              >
                <ManaText text={`{${c}}`} />
              </button>
            );
          })}
        </span>
        {p.tools}
      </div>
      {p.empty}
      {(p.names.length > 0 || (p.off?.names.length ?? 0) > 0) && (
        <div className="ng-grid" data-testid="ng-grid">
          {!filtering && p.lead}
          {!filtering && p.random && p.names.length > 1 && (
            <RandomTile keys={keys} count={p.names.length} sel={p.selected === p.random.value} cropUrl={p.cropUrl} onPick={() => p.onPick(p.random!.value)} {...(p.random.sub ? { sub: p.random.sub } : {})} />
          )}
          {shown.map((n) => (
            <DeckTile key={n} name={n} d={detailOf(p.details, n)} sel={p.selected === n} cropUrl={p.cropUrl} onPick={() => p.onPick(n)} {...(p.onCards ? { onCards: () => p.onCards!(n) } : {})} />
          ))}
          {shown.length === 0 && filtering && <span className="hint ng-none">No deck matches.</span>}
          {offShown.length > 0 && (
            <>
              <span className="ng-off-head" data-testid="ng-off-head">
                {p.off!.title} · {offShown.length}
              </span>
              {offShown.map((n) => (
                <DeckTile key={n} name={n} d={detailOf(p.details, n)} sel={false} cropUrl={p.cropUrl} onPick={() => undefined} off={p.off!.why(n)} {...(p.onCards ? { onCards: () => p.onCards!(n) } : {})} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The gallery in a dialog (a sheet on a phone): pick, and it closes. */
export function DeckPickerSheet({ title, onClose, ...g }: DeckGalleryProps & { title: string; onClose: () => void }) {
  return (
    <Sheet title={title} className="deck-sheet" onClose={onClose}>
      <DeckGallery
        {...g}
        autoFocus={!window.matchMedia?.('(pointer: coarse)').matches}
        onPick={(n) => {
          g.onPick(n);
          onClose();
        }}
      />
    </Sheet>
  );
}

/** A section the peek shows above the main list (Brawl's commander). */
const COMMANDER = /^commander$/i;
const CURVE_LABELS = ['0', '1', '2', '3', '4', '5', '6', '7+'];
/** A group this short stays in one column; a longer one may flow on into the next. */
const KEEP_WHOLE = 12;

/** The full card scan of `card`, else its art crop (the router has no scan, or this server can't send one). */
function CardImage({ card, colors, cropUrl, cardUrl }: { card?: string; colors: string; cropUrl: CropUrl; cardUrl?: CropUrl }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!card || !cardUrl || failed === card) return <Art card={card} colors={colors} cropUrl={cropUrl} className="dc-art-img" />;
  return (
    <span className="dc-card-img" style={{ background: colorWash(colors) }}>
      <img key={card} src={cardUrl(card)} alt={card} decoding="async" onError={() => setFailed(card)} />
    </span>
  );
}

/** The main deck's curve as bars (non-land cards by mana value), with its sums. */
function CurveChart({ cards }: { cards: DeckCard[] }) {
  const curve = manaCurve(cards);
  const max = Math.max(1, ...curve);
  const label = `Mana curve: ${curve.map((n, i) => `${n} at ${CURVE_LABELS[i]}`).join(', ')}`;
  return (
    <div className="dc-curve" role="img" aria-label={label} data-testid="dc-curve">
      {curve.map((n, i) => (
        <span key={i} className="dc-bar">
          <span className="dc-bar-col">
            <span className="dc-bar-n">{n || ''}</span>
            <span className="dc-bar-fill" style={{ height: `calc(${n / max} * (100% - 14px))` }} />
          </span>
          <span className="dc-bar-x">{CURVE_LABELS[i]}</span>
        </span>
      ))}
    </div>
  );
}

/** One card line: count, name, cost; hovering or focusing it shows the card. */
function CardRow({ c, on, onFocus }: { c: DeckCard; on: boolean; onFocus: (name: string) => void }) {
  return (
    <li>
      <button className={on ? 'on' : ''} onMouseEnter={() => onFocus(c.name)} onFocus={() => onFocus(c.name)} onClick={() => onFocus(c.name)}>
        <span className="dc-n">{c.n}</span>
        <span className="dc-name">{c.name}</span>
        {c.cost && (
          <span className="dc-cost">
            <ManaText text={c.cost} />
          </span>
        )}
      </button>
    </li>
  );
}

/** The format, legality, record and last-played chips over the list. */
function PeekChips({ d, format, colors }: { d?: DeckDetail; format?: LobbyFormat; colors: string }) {
  const played = d?.record && d.record.w + d.record.l > 0;
  return (
    <div className="dc-chips" data-testid="dc-chips">
      {colors && (
        <span className="chip-tag dc-colors">
          <ManaText text={pipText(colors)} />
        </span>
      )}
      {format === 'brawl' ? (
        <span className="chip-tag">Brawl</span>
      ) : format === 'standard' ? (
        d?.standard ? (
          <span className="chip-tag dc-warn" title={d.standard}>
            Not Standard · {d.standard}
          </span>
        ) : (
          <span className="chip-tag dc-ok">Standard-legal</span>
        )
      ) : (
        <span className="chip-tag">Constructed</span>
      )}
      {format === 'brawl' && d?.dupes?.length ? (
        <span className="chip-tag dc-warn" title={d.dupes.join(', ')}>
          More than one: {d.dupes.join(', ')}
        </span>
      ) : null}
      {played && <span className="chip-tag">Record {recordText(d.record!)}</span>}
      {d?.last !== undefined && <span className="chip-tag">Last played {dayText(d.last, Date.now())}</span>}
    </div>
  );
}

/**
 * A deck's cards: the commander, then the main deck by type (each group by mana value, with its cost), the sideboard
 * compact under it. Beside the list, the hovered (or focused) card's full scan, the curve and the colour split.
 */
export function DeckCardsSheet({ name, d, load, onClose, cropUrl, cardUrl, format }: { name: string; d?: DeckDetail; load: (name: string) => Promise<DeckCards | null>; onClose: () => void; cropUrl: CropUrl; cardUrl?: CropUrl; format?: LobbyFormat }) {
  const [cards, setCards] = useState<DeckCards | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | undefined>(d?.commander ?? d?.key);
  useEffect(() => void loadManaFont(), []);
  useEffect(() => {
    let live = true;
    load(name).then(
      (c) => live && setCards(c),
      (e: unknown) => live && setErr((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [name, load]);
  const sections = cards?.sections ?? [];
  const commander = sections.filter((s) => COMMANDER.test(s.name)).flatMap((s) => s.cards);
  const main = sections.find((s) => /^main$/i.test(s.name))?.cards ?? [];
  const extra = sections.filter((s) => !COMMANDER.test(s.name) && !/^main$/i.test(s.name));
  const colors = costColors([...commander, ...main]) || (d?.colors ?? '');
  const sums = deckSums(main);
  const split = colorSplit([...commander, ...main]);
  const typed = main.some((c) => c.type);
  return (
    <Sheet title={name} className="deck-sheet cards-sheet" onClose={onClose}>
      <PeekChips {...(d ? { d } : {})} {...(format ? { format } : {})} colors={colors} />
      <div className="dc-body" data-testid="deck-cards">
        <aside className="dc-art">
          <CardImage card={focus} colors={colors} cropUrl={cropUrl} {...(cardUrl ? { cardUrl } : {})} />
          <span className="dc-art-name">{focus ?? ''}</span>
          {main.length > 0 && (
            <div className="dc-stats">
              <span className="dc-sums">
                {sums.cards + commander.reduce((t, c) => t + c.n, 0)} cards · {sums.lands} lands{sums.avg !== undefined ? ` · avg MV ${sums.avg}` : ''}
              </span>
              {typed && <CurveChart cards={main} />}
              {typed && (
                <span className="dc-split" aria-label="Coloured mana symbols in the costs">
                  {(['W', 'U', 'B', 'R', 'G'] as const)
                    .filter((k) => split[k] > 0)
                    .map((k) => (
                      <span key={k} className="dc-split-k">
                        <ManaText text={`{${k}}`} /> {split[k]}
                      </span>
                    ))}
                </span>
              )}
            </div>
          )}
        </aside>
        <div className="dc-list">
          {cards === undefined && !err && <span className="hint">Loading the list…</span>}
          {err && <span className="hint warn">{err}</span>}
          {cards === null && <span className="hint">This server can’t show a deck’s cards.</span>}
          {commander.length > 0 && (
            <section className="dc-section dc-cmd">
              <h4>Commander</h4>
              <ul>
                {commander.map((c) => (
                  <CardRow key={c.name} c={c} on={focus === c.name} onFocus={setFocus} />
                ))}
              </ul>
            </section>
          )}
          {main.length > 0 && (
            <div className="dc-main">
              {groupCards(main).map((g) => (
                <section key={g.type} className={`dc-section${g.cards.length <= KEEP_WHOLE ? ' dc-keep' : ''}`} data-testid="dc-group">
                  <h4>
                    {g.label || 'Main'} <span>{g.count}</span>
                  </h4>
                  <ul>
                    {g.cards.map((c) => (
                      <CardRow key={c.name} c={c} on={focus === c.name} onFocus={setFocus} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
          {extra.map((s) => (
            <section key={s.name} className="dc-section dc-extra">
              <h4>
                {s.name} <span>{s.cards.reduce((t, c) => t + c.n, 0)}</span>
              </h4>
              <ul>
                {groupCards(s.cards)
                  .flatMap((g) => g.cards)
                  .map((c) => (
                    <CardRow key={c.name} c={c} on={focus === c.name} onFocus={setFocus} />
                  ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </Sheet>
  );
}
