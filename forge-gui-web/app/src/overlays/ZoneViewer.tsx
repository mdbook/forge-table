/**
 * Graveyard / exile viewer: opened by clicking a pile (or its chip), mine or the opponent's. It lays the
 * whole zone out as a scrollable grid of faces beside a large preview of the hovered card (real art when
 * the art loader has it). Face-down cards show the Kiln back (and can still be played when the prompt says
 * so, e.g. a foretold card).
 *
 * It sits over the table, not in a window, and never answers or hides the prompt: Esc, the close button or
 * a click outside closes it and the prompt is still there. Clicking a card the prompt can take (selectable,
 * or playable, e.g. flashback) acts on it exactly like a click on the table, then closes the viewer. A right-click
 * snoozes or wakes one of my cards for auto-skip, as on the table; a snoozed one says so.
 */
import type { CardId } from '@forge-table/protocol';
import { useEffect, useRef, useState } from 'react';
import { ManaText } from '../hud/ManaText';
import { describeAlt, keywordCostText } from '../table/altZone';
import { ALL, cardTypeCount, typeChips, viewEntries, type GridEntry, type GridView } from './cardGrid';
import { CardGridBar } from './CardGridBar';
import { CardFaceView } from '../cards/CardFaceView';
import { runtime } from '../runtime';
import { useUi } from '../store/uiStore';
import { knownFace, peeked } from '../store/model';
import { countLabel, showsBack, viewerAction, zoneCards, zoneTitle } from './zoneView';
import { PickBadge } from './PickBadge';
import { pickBadge, picksOf } from '../table/selection';
import { useBattlefieldPeek } from './BattlefieldPeek';
import { lowerFirst } from './peek';

/** The toolbar shows from this many cards. */
const BAR_MIN = 2;
/** The "Playable now" chip's key in the view's type slot. */
const PLAYABLE = 'playable';

export function ZoneViewer() {
  const ref = useUi((s) => s.zoneView);
  const model = useUi((s) => s.shown);
  const viewer = useUi((s) => s.viewer);
  const prompt = useUi((s) => s.prompt);
  const blocked = useUi((s) => s.asks.length > 0);
  const snoozed = useUi((s) => s.autoPass.snoozed);
  const gameOver = useUi((s) => s.gameOver);
  const [hover, setHover] = useState<CardId | null>(null);
  const [view, setView] = useState<GridView>(ALL);
  const panel = useRef<HTMLDivElement>(null);
  const open = !!ref && !gameOver;

  // Esc closes (and only closes: it must not reach the table's Esc = secondary button). Space / Enter are
  // swallowed too, so a stray key can't pass priority behind the viewer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (runtime().visibleAsks().length > 0) return; // a blocking ask above us owns the keys
      // In the search box every key types (Enter and Space used to be swallowed); Esc clears it, then closes.
      const box = e.target instanceof HTMLInputElement ? e.target : null;
      if (box && e.key !== 'Escape') return;
      if (box?.value && e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setView((v) => ({ ...v, query: '' }));
        return;
      }
      if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === 'Escape' && !e.repeat) runtime().closeZone();
      }
    };
    window.addEventListener('keydown', onKey, true);
    panel.current?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  useEffect(() => {
    setHover(null);
    setView(ALL);
  }, [ref?.player, ref?.zone]);
  const peek = useBattlefieldPeek(open, ref ? lowerFirst(zoneTitle(ref, viewer)) : '', `${ref?.player}:${ref?.zone}`);

  if (!open || !ref) return null;
  const all = zoneCards(model, ref);
  const entries: GridEntry<CardId>[] = all.map((id) => ({ key: id, face: showsBack(id, model.cards[id]) ? undefined : knownFace(model.cards[id]) }));
  const canPlay = (id: CardId) => viewerAction(id, prompt, blocked) === 'play';
  const playable = all.filter(canPlay);
  // What's playable now comes first (flashback, escape…), then the view's order.
  const listed = viewEntries(view.type === PLAYABLE ? entries.filter((e) => canPlay(e.key)) : entries, view.type === PLAYABLE ? { ...view, type: null } : view).map((e) => e.key);
  const ids = [...listed.filter(canPlay), ...listed.filter((id) => !canPlay(id))];
  // How a playable card is played from here (Flashback, Escape, Foretold…) and its cost, as the table's strip says it.
  const alt = (id: CardId) => (ref.zone === 'command' ? null : describeAlt(id, model.cards[id], ref.zone, true));
  const howPlayed = (id: CardId) => alt(id)?.label.split(' · ')[1];
  const playLabel = (id: CardId) => {
    const how = howPlayed(id);
    // A mana cost after the mechanic ("Flashback {R}"), else what it costs in words ("Flashback — Sacrifice a Mountain").
    const cost = alt(id)?.cost ?? (how ? keywordCostText(knownFace(model.cards[id]), how) : undefined);
    return how ? `${how}${cost ? (cost.startsWith('{') ? ` ${cost}` : ` — ${cost}`) : ''}` : 'Play';
  };
  const types = ref.zone === 'graveyard' ? cardTypeCount(entries.map((e) => e.face)) : 0;
  const picks = picksOf(prompt);
  const hs = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hs')) || 1;
  const tileH = Math.round((all.length > 10 ? 168 : 196) * hs);
  const shown = hover && ids.includes(hover) ? hover : ids[0];
  const shownCard = shown ? model.cards[shown] : undefined;
  const shownAction = shown ? viewerAction(shown, prompt, blocked) : null;
  const act = (id: CardId) => {
    runtime().closeZone();
    runtime().clickCard(id);
  };
  const previewH = Math.round(Math.min(window.innerHeight * 0.56, 440 * hs));
  const waiting = prompt && prompt.kind !== 'waiting' && !blocked ? prompt.message.split('\n')[0] : null;

  return (
    <div
      className={`zone-viewer-scrim${peek.className}`}
      inert={peek.inert}
      data-testid="zone-viewer"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) runtime().closeZone();
      }}
    >
      <div className="zone-viewer overlay pf" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="zone-viewer-title">
        <div className="pf-head zv-head">
          <div className="pf-text">
            <h2 id="zone-viewer-title">{zoneTitle(ref, viewer)}</h2>
            <div className="pf-ins">
              <span className="zv-count num" data-testid="zone-viewer-count">
                {countLabel(all.length)}
              </span>
              {types > 0 && (
                <span className="zv-types" data-testid="zone-viewer-types">
                  {' '}
                  · {types} card {types === 1 ? 'type' : 'types'}
                  {types >= 4 && ref.player === viewer && <b className="zv-delirium"> (delirium on)</b>}
                </span>
              )}
            </div>
          </div>
          <button className="btn secondary zv-close" onClick={() => runtime().closeZone()} data-testid="zone-viewer-close" aria-label="Close">
            <kbd>Esc</kbd> back to the table
          </button>
        </div>
        {all.length >= BAR_MIN && (
          <CardGridBar
            testId="zone-viewer-bar"
            view={view}
            onView={setView}
            chips={typeChips(entries.map((e) => e.face))}
            all={all.length}
            extra={playable.length > 0 ? [{ key: PLAYABLE, label: 'Playable now', n: playable.length, tone: 'ember' }] : []}
            given="Newest first"
          />
        )}
        <div className="zv-body">
          <div className="zv-grid" onMouseLeave={() => setHover(null)}>
            {ids.length === 0 && <div className="zv-empty">{all.length === 0 ? 'No cards here.' : 'No cards match.'}</div>}
            {ids.map((id) => {
              const card = model.cards[id];
              const back = showsBack(id, card);
              // A face-down card can still be playable (a foretold card from exile): it keeps its back but glows.
              const action = viewerAction(id, prompt, blocked);
              const glow = !blocked ? (prompt?.weak?.[id] ?? 0) : 0;
              const pick = pickBadge(id, picks);
              const cls = ['zv-card', pick ? 'selected' : action === 'select' ? 'selectable' : '', glow > 0 ? `playable${glow >= 2 ? ' strong' : ''}` : '', action ? 'actionable' : '']
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  key={id}
                  className={cls}
                  data-testid={`zone-viewer-card-${id}`}
                  onMouseEnter={() => setHover(id)}
                  onFocus={() => setHover(id)}
                  onClick={() => action && act(id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (card?.owner === viewer) runtime().toggleSnooze(id);
                  }}
                  aria-label={back ? 'Face-down card' : (card?.state?.name ?? id)}
                >
                  {back ? <CardFaceView height={tileH} /> : <CardFaceView card={card} height={tileH} />}
                  {pick && <PickBadge label={pick} />}
                  {peeked(card) && <span className="zv-facedown">Face down</span>}
                  {snoozed?.includes(id) && <span className="zv-facedown zv-snoozed">Snoozed</span>}
                  {action === 'play' && <span className="zv-how">{howPlayed(id) ?? 'Playable'}</span>}
                </button>
              );
            })}
          </div>
          {shown && (
            <div className="zv-preview" data-testid="zone-viewer-preview">
              {showsBack(shown, shownCard) ? <CardFaceView height={previewH} /> : <CardFaceView card={shownCard} height={previewH} />}
              {shownAction && (
                <button className="btn primary zv-act" onClick={() => act(shown)} data-testid="zone-viewer-act">
                  {shownAction === 'select' ? 'Choose' : <ManaText text={playLabel(shown)} />}
                </button>
              )}
            </div>
          )}
        </div>
        {waiting && (
          <div className="zv-foot">
            <span className="zv-prompt">{waiting}</span>
          </div>
        )}
      </div>
    </div>
  );
}
