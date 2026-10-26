/**
 * Smaller table HUD pieces: pile counts, the status line, the stack list, toasts and the stale flash.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { CardId, GameModel, PlayerId } from '@forge-table/protocol';
import { STACK_CASCADE, cardWidth, stackLevel } from '../layout/geometry';
import { runtime } from '../runtime';
import { PHASE_LABEL, opponentOf } from '../store/model';
import { useUi } from '../store/uiStore';
import { playableCount } from '../overlays/zoneView';
import { at, atR, useGeo } from './pos';
import { ManaText } from './ManaText';
import { hasCommanders } from '../table/commander';

const ZONE_LABEL = { library: 'Library', graveyard: 'Graveyard', exile: 'Exile' } as const;

/**
 * The piles' counts: a small number badge on each pile's outer edge (the zone's name is for screen readers and
 * the tooltip). Graveyard and exile badges open the zone viewer; exile's shows only while it holds something.
 */
export function PileCounts() {
  const viewer = useUi((s) => s.viewer);
  const shown = useUi((s) => s.shown);
  const prompt = useUi((s) => s.prompt);
  const blocked = useUi((s) => s.asks.length > 0);
  const { PILES, PILES_X, SIZE } = useGeo();
  const opp = opponentOf(shown, viewer);
  const out: React.ReactNode[] = [];
  for (const [player, mine] of [
    [viewer, true],
    [opp, false],
  ] as Array<[PlayerId | undefined, boolean]>) {
    if (!player) continue;
    const zones = shown.players[player]?.zones ?? {};
    const ys = mine ? PILES.mine : PILES.opp;
    for (const z of ['library', 'graveyard', 'exile'] as const) {
      const ids = zones[z] ?? [];
      const n = ids.length;
      if (z === 'exile' && n === 0) continue;
      const h = z === 'exile' ? SIZE.pile * 0.8 : SIZE.pile;
      // A badge centred on the pile's outer edge (mine: the bottom one; the opponent's, mirrored: the top one).
      const y = Math.round(mine ? ys[z] + h / 2 - 2 : ys[z] - h / 2 + 2);
      const testid = `pile-${mine ? 'me' : 'opp'}-${z}`;
      if (z === 'library') {
        out.push(
          <div key={`${player}-${z}`} className="pile-count" style={atR(PILES_X[z], y)} data-testid={testid} title={ZONE_LABEL[z]}>
            <span className="pile-label">{ZONE_LABEL[z]}</span>
            <b>{n}</b>
          </div>,
        );
        continue;
      }
      // Graveyard and exile chips open the zone viewer; a playable card inside gets a small glow badge.
      const playable = playableCount(ids, prompt, blocked);
      out.push(
        <button
          key={`${player}-${z}`}
          className={`pile-count open${playable > 0 ? ' playable' : ''}`}
          style={atR(PILES_X[z], y)}
          data-testid={testid}
          title={`${ZONE_LABEL[z]}: view ${mine ? 'your' : 'the opponent’s'} ${z}`}
          onClick={() => runtime().openZone(player, z)}
        >
          <span className="pile-label">{ZONE_LABEL[z]}</span>
          <b>{n}</b>
          {playable > 0 && (
            <span className="pile-glow num" data-testid={`${testid}-playable`} aria-label={`${playable} playable`}>
              {playable}
            </span>
          )}
        </button>,
      );
    }
  }
  return <>{out}</>;
}

function cardName(model: GameModel, id: CardId | undefined): string | undefined {
  return id ? model.cards[id]?.state?.name : undefined;
}

/**
 * A banner sweeps across the table when a turn begins (overhaul; MTGA): "Your Turn", or the opponent's name.
 * It never takes input (styles.css: no pointer events) and any click, tap or key sweeps it away at once; it is gone
 * when its sweep ends (850 ms).
 */
export function TurnBanner() {
  const turn = useUi((s) => s.shown.game.turn);
  const mine = useUi((s) => s.shown.game.playerTurn === s.viewer);
  const name = useUi((s) => {
    const p = s.shown.players[s.shown.game.playerTurn ?? ''];
    return p?.lobbyPlayerName ?? p?.name ?? 'Opponent';
  });
  if (!turn) return null;
  // Keyed by turn: a new turn remounts it and the CSS sweep plays once.
  return <Banner key={turn} turn={turn} mine={mine} name={name} />;
}

function Banner({ turn, mine, name }: { turn: number; mine: boolean; name: string }) {
  const [state, setState] = useState<'on' | 'skip' | 'done'>('on');
  useEffect(() => {
    if (state !== 'on') return;
    const skip = () => setState('skip');
    window.addEventListener('pointerdown', skip, true);
    window.addEventListener('keydown', skip, true);
    return () => {
      window.removeEventListener('pointerdown', skip, true);
      window.removeEventListener('keydown', skip, true);
    };
  }, [state]);
  if (state === 'done') return null;
  return (
    <div className={`turn-banner${mine ? ' mine' : ''}${state === 'skip' ? ' skip' : ''}`} aria-hidden="true" onAnimationEnd={() => setState('done')}>
      <span className="turn-banner-kicker">Turn {turn}</span>
      <span className="turn-banner-title">{mine ? 'Your Turn' : name}</span>
    </div>
  );
}

/** The status line, top left: whose turn, which step, who has priority; a Brawl or Standard game says so first. */
export function StatusLine() {
  const shown = useUi((s) => s.shown);
  const viewer = useUi((s) => s.viewer);
  const prompt = useUi((s) => s.prompt);
  // The sidecar's format, or the commanders on the table (a replay has no welcome).
  const tag = useUi((s) => (s.welcome?.format === 'brawl' || hasCommanders(s.shown) ? 'Brawl' : s.welcome?.format === 'standard' ? 'Standard' : null));
  const { X, ROW_Y, hudPortrait } = useGeo();
  const g = shown.game;
  if (!g.turn) return null;
  const mine = g.playerTurn === viewer;
  const phase = g.phase ? PHASE_LABEL[g.phase] : '';
  const priority = g.priority === viewer ? 'you have priority' : g.priority ? 'opponent has priority' : '';
  const top = g.stack[0];
  const stackNote = top ? ` · ${top.activator === viewer ? 'You' : 'Opponent'}: ${cardName(shown, top.source) ?? top.text}` : '';
  return (
    // Landscape: the top-left corner (styles.css). Portrait: on the centre line's left end, above the phase strip.
    <div className="status-line" style={hudPortrait ? at(X.ladderX, ROW_Y.centre) : undefined} data-testid="status-line">
      {tag && (
        <>
          <span className="format-tag" data-testid="format-tag">{tag}</span>
          {' · '}
        </>
      )}
      <b className={mine ? 'mine' : 'opp'}>{mine ? 'Your turn' : "Opponent's turn"}</b> · Turn {g.turn} · {phase}
      {priority && prompt?.kind !== 'waiting' ? ` · ${priority}` : ''}
      {stackNote}
    </div>
  );
}

/**
 * The stack's accessible mirror: the table's stack zone shows the cards; this is the
 * `Stack · N` pill under it (portrait: above it), and a click opens the items as a readable list beside the cascade
 * (portrait: above the pill). Closed, the list is still there for screen readers (visually hidden). Items cascade in (MTGA juice):
 * each new one slides in from the right, several at once a beat apart, oldest first; a resolved item lifts out and
 * the rest close up. Reduced motion: plain fades. Hovering an item lights it on the table (its arrows, its card).
 */
export function StackList() {
  const shown = useUi((s) => s.shown);
  const viewer = useUi((s) => s.viewer);
  const calm = useUi((s) => s.reducedMotion || s.effects === 'off');
  const { X, SIZE, hudPortrait, portrait } = useGeo();
  const [open, setOpen] = useState(false);
  // Items already on screen: only the new ones cascade (the stagger counts among them, from the bottom).
  const seen = useRef(new Set<string>());
  const stack = shown.game.stack;
  const items = stack.slice(0, 6);
  const fresh = items.filter((si) => !seen.current.has(si.id)).map((si) => si.id);
  useEffect(() => {
    seen.current = new Set(stack.map((si) => si.id));
  });
  useEffect(() => {
    if (stack.length === 0) setOpen(false);
  }, [stack.length]);
  // Right-aligned to the stack zone's right edge. Landscape: just under the front card (batch 11: with the bigger front
  // card a deep cascade reaches the opponent's piles, so the pill can't ride on top of it); portrait: just above the
  // cascade's deepest card drawn (layout/stack.ts).
  const depth = Math.min(stack.length, (portrait ? STACK_CASCADE.portrait : STACK_CASCADE.landscape).depth);
  const top = portrait ? X.stackBottom - SIZE.stackTop + stackLevel(Math.max(0, depth - 1), SIZE.stackTop, portrait).top - 8 : X.stackBottom + 8;
  const right = X.stackX + cardWidth(SIZE.stackTop) / 2;
  // The open list hangs left of the cascade (styles.css .stack-items): the zone's width in tu.
  const style = { ...(hudPortrait ? at(right, top) : atR(right, top)), '--stack-w': right - X.stackLeft } as React.CSSProperties;
  return (
    <AnimatePresence>
      {stack.length > 0 && (
        // The last item resolving takes the pill with it: it fades as a whole.
        <motion.div key="stack" className={`stack-list${open ? ' open' : ''}${portrait ? '' : ' below'}`} style={style} data-testid="stack-list" exit={{ opacity: 0, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } }}>
          <button type="button" className="stack-head" aria-expanded={open} aria-controls="stack-items" onClick={() => setOpen(!open)} data-testid="stack-head">
            Stack<span className="sep"> · </span><span className="n">{stack.length}</span>
          </button>
          <div className="stack-items" id="stack-items" role="list" aria-label="The stack, top first">
            <AnimatePresence initial={false} mode="popLayout">
              {items.map((si, i) => {
                const k = fresh.length - 1 - fresh.indexOf(si.id);
                return (
                  <motion.div
                    key={si.id}
                    role="listitem"
                    layout={!calm}
                    className={`stack-item${si.activator === viewer ? ' mine' : ''}${i === 0 ? ' top' : ''}`}
                    initial={calm ? { opacity: 0 } : { opacity: 0, x: 28, scale: 0.96 }}
                    animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
                    exit={calm ? { opacity: 0, transition: { duration: 0.12 } } : { opacity: 0, y: -22, scale: 0.94, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } }}
                    transition={{ duration: calm ? 0.15 : 0.22, ease: [0.05, 0.7, 0.1, 1], delay: fresh.includes(si.id) && !calm ? k * 0.05 : 0 }}
                    // Hovering an item draws arrows to its targets (the top item's are always drawn).
                    onPointerEnter={() => runtime().hoverStack(si.id)}
                    onPointerLeave={() => runtime().hoverStack(null)}
                  >
                    <span><ManaText text={si.text.replace(/\s*\[Zone Changer:[^\]]*\]/g, '').replace(/\(Targeting: \[\[(.*?)\]\]\)/, '→ $1')} /></span>
                  </motion.div>
                );
              })}
            </AnimatePresence>
            {stack.length > items.length && <div className="stack-item more">+{stack.length - items.length} more</div>}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The countdown banner's text, or null when no restart is coming. */
export function restartText(restartAt: number | null, now: number): string | null {
  if (restartAt === null) return null;
  const s = Math.max(0, Math.ceil((restartAt - now) / 1000));
  return s > 0 ? `Server restarting in ${s} s; your game will end.` : 'Server restarting now; your game is ending.';
}

/** The router's "update now" warning: a banner counting down to the restart. */
export function RestartBanner() {
  const restartAt = useUi((s) => s.restartAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (restartAt === null) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [restartAt]);
  const text = restartText(restartAt, now);
  if (!text) return null;
  return (
    <div className="restart-banner" role="alert" data-testid="restart-banner">
      {text}
    </div>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className="toasts" data-testid="toasts">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            className={`toast ${t.level}`}
            initial={{ opacity: 0, y: -10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, transition: { duration: 0.16 } }}
            transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
            onClick={() => runtime().dismissToast(t.id)}
          >
            {t.title && <div className="title">{t.title}</div>}
            <div className="msg"><ManaText text={t.message} /></div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** A brief edge flash for stale acts and flashIncorrectAction (never a dialog). */
export function Flash() {
  const flash = useUi((s) => s.flash);
  if (flash === 0) return null;
  return <div key={flash} className="flash" />;
}

export function ConnectionBadge() {
  const status = useUi((s) => s.status);
  if (status === 'open' || status === 'replay') return null;
  return <div className="conn">{status === 'connecting' ? 'Connecting to the server…' : 'Disconnected, retrying…'}</div>;
}
