/**
 * Lasting effects beside a plate (table/lastingFx.ts; emblems, dungeons, Spirit Water Revival's "for the rest of
 * the game"): a row of small cards, always on show, above my plate and under the opponent's. Hovering (or tapping) one
 * opens a preview beside the row: the card, what it does, and for a dungeon its rooms with the one the player is in
 * lit. More than RAIL_MAX: the last slot is "+N", which opens them all in the zone viewer. A portrait phone has no room
 * for the row: the plate gets a "✦ N" chip instead (LastingChip), which opens the zone viewer.
 */
import type { Card, PlayerId } from '@forge-table/protocol';
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CardFaceView } from '../cards/CardFaceView';
import { runtime } from '../runtime';
import { useUi } from '../store/uiStore';
import { type Lasting, type LastingKind, dungeonRooms, lastingEffects } from '../table/lastingFx';

/** Cards shown before the row folds the rest into "+N". */
export const RAIL_MAX = 5;

const BADGE: Record<LastingKind, string> = { marker: '', dungeon: '⌂', emblem: '★', effect: '∞' };

/** The HUD's scale (styles.css --hs), for sizes given in px at 1080p. */
const hudScale = () => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hs')) || 1;

export function LastingRail({ player, mine }: { player: PlayerId; mine: boolean }) {
  const model = useUi((s) => s.shown);
  const cards = model.cards;
  const items = useMemo(() => lastingEffects(model, player), [model, player]);
  const [hover, setHover] = useState<{ id: string; rect: DOMRect } | null>(null);
  if (items.length === 0) return null;
  const shown = items.length > RAIL_MAX ? items.slice(0, RAIL_MAX - 1) : items;
  const more = items.length - shown.length;
  // The opponent's row tucks under their plate, clear of their front row: a little smaller.
  const h = Math.round((mine ? 46 : 38) * hudScale());
  const open = hover ? items.find((l) => l.id === hover.id) : undefined;
  const hud = document.querySelector('[data-testid="hud"]');
  return (
    <div
      className={`lasting-rail ${mine ? 'mine' : 'opp'}`}
      data-testid={`lasting-${mine ? 'me' : 'opp'}`}
      // The plate under it is a target (act{player}): a click here is not one.
      onClick={(e) => e.stopPropagation()}
    >
      {shown.map((l) => (
        <button
          key={l.id}
          className={`lasting ${l.kind}`}
          data-testid={`lasting-card-${l.id}`}
          aria-label={`${l.name} (${l.label})`}
          onMouseEnter={(e) => setHover({ id: l.id, rect: e.currentTarget.getBoundingClientRect() })}
          onMouseLeave={() => setHover(null)}
          onFocus={(e) => setHover({ id: l.id, rect: e.currentTarget.getBoundingClientRect() })}
          onBlur={() => setHover(null)}
          onClick={(e) => setHover(hover?.id === l.id ? null : { id: l.id, rect: e.currentTarget.getBoundingClientRect() })}
        >
          {l.glyph ? (
            <span className="lasting-glyph" style={{ height: h, width: Math.round(h * (63 / 88)) }}>
              {l.glyph}
            </span>
          ) : (
            <CardFaceView card={cards[l.id]} height={h} />
          )}
          {BADGE[l.kind] && <span className={`lasting-badge ${l.kind}`}>{BADGE[l.kind]}</span>}
        </button>
      ))}
      {more > 0 && (
        <button className="lasting more num" data-testid="lasting-more" style={{ height: h, width: Math.round(h * (63 / 88)) }} onClick={() => runtime().openZone(player, 'command')}>
          +{more}
        </button>
      )}
      {open && hover && cards[open.id] && hud && createPortal(<LastingPreview lasting={open} card={cards[open.id]!} anchor={hover.rect} above={mine} />, hud)}
    </div>
  );
}

/** The preview: the card, and beside it its name, what it is, what it does, and a dungeon's rooms. */
function LastingPreview({ lasting, card, anchor, above }: { lasting: Lasting; card: Card; anchor: DOMRect; above: boolean }) {
  const hs = hudScale();
  const cardH = Math.round(Math.min(window.innerHeight * 0.4, 300 * hs));
  const w = Math.round(cardH * (63 / 88) + 300 * hs);
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, anchor.left));
  const style = above ? { left, bottom: window.innerHeight - anchor.top + 10 } : { left, top: anchor.bottom + 10 };
  const rooms = lasting.kind === 'dungeon' ? dungeonRooms(typeof card.state?.oracleText === 'string' ? card.state.oracleText : undefined) : [];
  const depth = rooms.reduce((n, r) => Math.max(n, r.depth), -1) + 1;
  const here = rooms.find((r) => r.name === lasting.room);
  return (
    <div className="preview lasting-preview" style={style} data-testid="lasting-preview">
      <CardFaceView card={card} height={cardH} />
      <div className="lasting-info">
        <div className="lasting-name">{lasting.name}</div>
        <div className="lasting-label">{lasting.label}</div>
        {rooms.length > 0 ? (
          <>
            <div className="dungeon-map" data-testid="dungeon-map">
              {Array.from({ length: depth }, (_, d) => (
                <div key={d} className="dungeon-row">
                  {rooms
                    .filter((r) => r.depth === d)
                    .map((r) => (
                      <span key={r.name} className={`dungeon-room${r.name === lasting.room ? ' here' : ''}`}>
                        {r.name}
                      </span>
                    ))}
                </div>
              ))}
            </div>
            {here && <p className="lasting-text">{here.text}</p>}
          </>
        ) : (
          lasting.text.split('\n').map((line, i) => (
            <p key={i} className="lasting-text">
              {line}
            </p>
          ))
        )}
      </div>
    </div>
  );
}

/** Portrait: the plate's "✦ N" chip for a player's lasting effects; it opens them in the zone viewer. */
export function LastingChip({ player }: { player: PlayerId }) {
  const model = useUi((s) => s.shown);
  const n = useMemo(() => lastingEffects(model, player).length, [model, player]);
  if (n === 0) return null;
  return (
    <button
      className="lasting-chip"
      data-testid={`lasting-chip-${player}`}
      aria-label={`Lasting effects: ${n}`}
      onClick={(e) => {
        e.stopPropagation();
        runtime().openZone(player, 'command');
      }}
    >
      ✦<b>{n}</b>
    </button>
  );
}
