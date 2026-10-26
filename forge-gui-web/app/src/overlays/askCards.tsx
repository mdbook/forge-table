/**
 * Card pieces shared by the choice overlays (hover preview works inside every overlay):
 *
 * - AskPreview: a large card docked beside the choices (the hovered or focused one, else the last one
 *   picked, else the first) so the text is readable without squinting at the tiles.
 * - LaneBoard: card lanes for "put them back in any order" (one lane) and scry (top and bottom
 *   lanes). Click a card to send it to the other lane; drag, ‹ ›, or ←/→ to reorder; ↑/↓ to switch lanes.
 */
import type { AskItem, Card, CardFace, GameModel } from '@forge-table/protocol';
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { CardFaceView } from '../cards/CardFaceView';
import { printedPt, ptChip } from '../cards/pt';
import { useCardArt } from '../cards/useCardArt';
import { dropBefore, laneOf, moveTo, nudge, otherLane, type Lanes } from './lanes';

export interface ItemFace {
  card?: Card | undefined;
  face?: CardFace | undefined;
}

/** The HUD scale (≥ 0.9; 1 outside a page, as in a server render). */
export function hudScale(): number {
  if (typeof document === 'undefined') return 1;
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hs')) || 1;
}

/** The docked preview's height: big, but leaving room for the header and buttons on short screens. */
export function previewHeight(): number {
  return Math.round(Math.min(window.innerHeight * 0.56, 440 * hudScale()));
}

export function itemFace(it: AskItem | undefined, model: GameModel): ItemFace | null {
  if (!it) return null;
  const card = it.card ? model.cards[it.card] : undefined;
  if (card?.state) return { card };
  if (it.cardData?.state) return { face: it.cardData.state };
  return null;
}

/**
 * Whether the items read best as card tiles: some show a face, and no card stands for two items. (An ability
 * menu lists one card's abilities: those read as options beside a preview of the card.)
 */
export function faceTiles(items: AskItem[], model: GameModel): boolean {
  const seen = new Set<string>();
  let faces = 0;
  for (const it of items) {
    if (!itemFace(it, model)) continue;
    faces++;
    if (it.card) {
      if (seen.has(it.card)) return false;
      seen.add(it.card);
    }
  }
  return faces > 0;
}

/**
 * Which card the preview shows: the hovered / focused item's, else `fallback` (an item idx: the last pick, or
 * the first card in a lane), else `fallbackFace` (the ask's own card), else the first item with a face.
 */
export function usePeek(items: AskItem[], model: GameModel, fallback?: number | null, fallbackFace?: ItemFace | null) {
  const [hover, setHover] = useState<number | null>(null);
  const byIdx = (i: number | null | undefined) => (i === null || i === undefined ? undefined : items.find((x) => x.idx === i));
  const peek =
    itemFace(byIdx(hover), model) ??
    itemFace(byIdx(fallback), model) ??
    fallbackFace ??
    items.reduce<ItemFace | null>((f, it) => f ?? itemFace(it, model), null);
  return {
    peek,
    bind: (idx: number) => ({ onMouseEnter: () => setHover(idx), onFocus: () => setHover(idx) }),
    leave: () => setHover(null),
  };
}

export function AskPreview({ peek, height }: { peek: ItemFace | null; height: number }) {
  const art = useCardArt((peek?.face ?? peek?.card?.state)?.imageKey);
  if (!peek) return null;
  // A real scan shows printed P/T: a changed one goes in a chip over the printed P/T box (clear of the bottom strip).
  const chip = art ? ptChip(peek.card, printedPt) : null;
  return (
    <div className="ask-preview" data-testid="ask-preview" aria-hidden="true">
      <CardFaceView card={peek.card} face={peek.face} height={height} />
      {chip && (
        <span className={`pt-chip num ${chip.tone}`} style={{ top: height * 0.92 }} data-testid="ask-preview-pt">
          {chip.text}
        </span>
      )}
    </div>
  );
}

export interface LaneSpec {
  key: string;
  title: string;
  hint?: string;
}

interface Mark {
  lane: number;
  before: number | null;
}

export function LaneBoard({
  items,
  model,
  lanes,
  specs,
  tileH,
  onChange,
  bind,
  leave,
}: {
  items: AskItem[];
  model: GameModel;
  lanes: Lanes;
  specs: LaneSpec[];
  tileH: number;
  onChange: (l: Lanes) => void;
  bind: (idx: number) => { onMouseEnter: () => void; onFocus: () => void };
  leave: () => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const [mark, setMark] = useState<Mark | null>(null);
  const [refocus, setRefocus] = useState<number | null>(null);
  const faces = useRef(new Map<number, HTMLButtonElement>());
  const two = lanes.length === 2;

  // Moving a focused node in the DOM can drop its focus: after a keyboard move, put it back.
  useLayoutEffect(() => {
    if (refocus === null) return;
    faces.current.get(refocus)?.focus();
    setRefocus(null);
  }, [lanes, refocus]);

  const apply = (next: Lanes, focusIdx?: number) => {
    if (next === lanes) return;
    onChange(next);
    if (focusIdx !== undefined) setRefocus(focusIdx);
  };
  const onKey = (e: KeyboardEvent, idx: number) => {
    const li = laneOf(lanes, idx);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      apply(nudge(lanes, idx, e.key === 'ArrowLeft' ? -1 : 1), idx);
    } else if (two && ((e.key === 'ArrowUp' && li === 1) || (e.key === 'ArrowDown' && li === 0))) {
      e.preventDefault();
      apply(otherLane(lanes, idx), idx);
    }
  };
  const endDrag = () => {
    setDrag(null);
    setMark(null);
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    if (drag !== null && mark) apply(moveTo(lanes, drag, mark.lane, mark.before));
    endDrag();
  };
  const label = (it: AskItem | undefined) => it?.label ?? '';

  return (
    <div className="lanes" onMouseLeave={leave}>
      {specs.map((spec, li) => {
        const lane = lanes[li] ?? [];
        const endMark = mark?.lane === li && mark.before === null && drag !== null;
        return (
          <section
            key={spec.key}
            className={`lane${mark?.lane === li && drag !== null ? ' drop' : ''}`}
            data-testid={`lane-${spec.key}`}
            onDragOver={(e) => {
              if (drag === null) return;
              e.preventDefault();
              if (!(e.target as HTMLElement).closest('.lane-card')) setMark({ lane: li, before: null });
            }}
            onDrop={drop}
          >
            <header className="lane-head">
              <span className="lane-title">{spec.title}</span>
              {spec.hint && <span className="lane-hint">{spec.hint}</span>}
            </header>
            <div className={`lane-cards${endMark ? ' insert-end' : ''}`}>
              {lane.length === 0 && (
                // As tall as a card and its buttons, so moving the last card out doesn't resize the panel.
                <div className="lane-empty" style={{ height: `calc(${tileH + 26}px + 6 * var(--u))` }}>
                  {two ? 'Click a card to move it here' : 'Empty'}
                </div>
              )}
              {lane.map((idx, pos) => {
                const it = items.find((x) => x.idx === idx);
                const f = itemFace(it, model);
                const before = mark?.lane === li && mark.before === idx && drag !== null && drag !== idx;
                return (
                  <div
                    key={idx}
                    className={`lane-card${drag === idx ? ' dragging' : ''}${before ? ' insert-before' : ''}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', String(idx));
                      setDrag(idx);
                    }}
                    onDragEnd={endDrag}
                    onDragOver={(e) => {
                      if (drag === null) return;
                      e.preventDefault();
                      const r = e.currentTarget.getBoundingClientRect();
                      setMark({ lane: li, before: dropBefore(lanes, idx, e.clientX > r.left + r.width / 2) });
                    }}
                  >
                    <button
                      ref={(el) => {
                        if (el) faces.current.set(idx, el);
                        else faces.current.delete(idx);
                      }}
                      className="lane-face"
                      data-testid={`ask-item-${idx}`}
                      aria-label={`${label(it)}, ${spec.title}, position ${pos + 1}`}
                      onClick={() => two && apply(otherLane(lanes, idx))}
                      onKeyDown={(e) => onKey(e, idx)}
                      {...bind(idx)}
                    >
                      {f ? <CardFaceView card={f.card} face={f.face} height={tileH} /> : <span className="option">{label(it)}</span>}
                    </button>
                    <div className="lane-nudge">
                      <button
                        className="btn chip ghost"
                        aria-label="Move earlier"
                        disabled={pos === 0}
                        onClick={() => apply(nudge(lanes, idx, -1))}
                        data-testid={`lane-earlier-${idx}`}
                      >
                        ‹
                      </button>
                      {/* The position sits under the card, not on it (it would hide the mana cost). */}
                      <span className="lane-pos num">{pos + 1}</span>
                      {two && (
                        <button className="btn chip ghost" onClick={() => apply(otherLane(lanes, idx))} data-testid={`lane-swap-${idx}`}>
                          {li === 0 ? `To ${specs[1]!.key} ↓` : `To ${specs[0]!.key} ↑`}
                        </button>
                      )}
                      <button
                        className="btn chip ghost"
                        aria-label="Move later"
                        disabled={pos === lane.length - 1}
                        onClick={() => apply(nudge(lanes, idx, 1))}
                        data-testid={`lane-later-${idx}`}
                      >
                        ›
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** An overlay's own keys on the window (repeats and typing in a field ignored). */
export function useHotkeys(handler: (e: globalThis.KeyboardEvent) => void, deps: unknown[]): void {
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => {
      if (e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && t.tagName === 'INPUT') return;
      handler(e);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
