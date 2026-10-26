/**
 * Full panels: the game-over panel, the settings gear (speed, card size, effects, concede) and the hover preview. The start
 * screen lives in StartScreen.tsx.
 */
import type { Card } from '@forge-table/protocol';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { CardFaceView } from '../cards/CardFaceView';
import { paintAnvil } from '../cards/face';
import { printedPt, ptChip } from '../cards/pt';
import { useCardArt } from '../cards/useCardArt';
import { CARD_SIZES } from '../layout/geometry';
import { guestTable, underRouter } from '../net/token';
import { runtime, SPEEDS } from '../runtime';
import { isSummoningSick } from '../store/model';
import { useUi } from '../store/uiStore';
import { rematchView } from './pvp';
import type { Effects } from '../director/director';
import { stripOpen } from '../overlays/zoneView';
import { useBattlefieldPeek } from '../overlays/BattlefieldPeek';
import { peekHidden } from '../overlays/peek';
import type { AltCard } from '../table/altZone';
import { commanderCost } from '../table/commander';

export function AnvilMark({ size = 40 }: { size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    paintAnvil(ctx, c.width / 2, c.height / 2 + c.height * 0.04, c.width * 0.9, '#FF7A33');
  }, [size]);
  return <canvas ref={ref} width={size * 2} height={size * 2} style={{ width: size, height: size }} />;
}

export function GameOverPanel() {
  const go = useUi((s) => s.gameOver);
  const pvp = useUi((s) => !!s.pvp);
  const pvpLobby = useUi((s) => s.pvp?.lobby ?? null);
  if (!go) return null;
  const rv = pvp ? rematchView(pvpLobby) : null;
  const title = go.won ? 'Victory' : go.winner ? 'Defeat' : 'Draw';
  const outcome = go.won ? 'won' : go.winner ? 'lost' : 'draw';
  // The title card plays first (overhaul); goldens (test mode) and reduced motion go straight to the panel.
  const ui = useUi.getState();
  const still = !!document.querySelector('.test-mode') || matchMedia('(prefers-reduced-motion: reduce)').matches || ui.reducedMotion || ui.effects !== 'full';
  // The panel punches in (MTGA juice): up from 0.9 with a small overshoot; reduced motion and goldens just fade.
  const calm = ui.reducedMotion || ui.effects === 'off' || !!document.querySelector('.test-mode');
  return (
    <div className={`scrim finale-${outcome}`} data-testid="game-over">
      {!still && (
        <div className={`finale ${outcome}`} aria-hidden="true">
          <span data-t={title}>{title}</span>
        </div>
      )}
      <motion.div
        className="panel"
        initial={calm ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.9 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={calm ? { duration: 0.2, delay: still ? 0 : 1.6 } : { duration: 0.36, ease: [0.34, 1.45, 0.64, 1], opacity: { duration: 0.2, ease: [0.2, 0, 0, 1], delay: still ? 0 : 1.5 }, delay: still ? 0 : 1.5 }}
      >
        <div className="kicker">{go.matchOver ? 'Match over' : `Game ${go.gamesPlayed} of ${go.gamesInMatch}`}</div>
        <h1 className={go.won ? 'won' : ''}>{title}</h1>
        <div className="sub">{go.winner ? `${go.winner} wins.` : 'No winner.'}</div>
        {rv?.note && (
          <div className="sub rematch-note" data-testid="rematch-note" role="status">
            {rv.note}
          </div>
        )}
        <div className="row">
          {underRouter() && !guestTable() && (
            <a className="btn ghost" href="/" data-testid="to-lobby">
              Lobby
            </a>
          )}
          <button className={`btn ${rv && !rv.offer ? 'primary' : 'secondary'}`} style={rv && !rv.offer ? { minHeight: 56 } : undefined} data-testid="leave" onClick={() => runtime().nextGame('QUIT')}>
            Leave
          </button>
          {go.matchOver ? (
            // PvP: Rematch takes both players back to this table's start screen to keep or change decks.
            (!rv || rv.offer) && (
              <button className="btn primary" style={{ minHeight: 56 }} data-testid="rematch" onClick={() => runtime().nextGame('NEW')}>
                Rematch
              </button>
            )
          ) : (
            <button className="btn primary" style={{ minHeight: 56 }} data-testid="next-game" onClick={() => runtime().nextGame('CONTINUE')}>
              Next Game
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}

const FX_LABEL: Record<Effects, string> = { full: 'Full', lite: 'Lite', off: 'Off' };
const FX_NEXT: Record<Effects, Effects> = { full: 'lite', lite: 'off', off: 'full' };

const SPEED_LABEL: Record<number, string> = { 0.5: '½×', 1: '1×', 1.5: '1½×', 2: '2×', 0: 'Instant' };

/**
 * A thin-stroke gear (24-unit viewBox, currentColor), drawn so it reads the same everywhere (the ⚙ character is an
 * emoji or a chunky glyph on some platforms; "settings icon looks weird"): eight square-ish teeth around a ring,
 * and the axle hole.
 */
const GEAR_PATH = (() => {
  const teeth = 8;
  const [rIn, rOut] = [7.1, 9.6];
  const pts: string[] = [];
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    // Each tooth: up the flank at ±half-width (a little narrower at the tip), across, and down.
    for (const [r, d] of [[rIn, -0.24], [rOut, -0.15], [rOut, 0.15], [rIn, 0.24]] as const) {
      pts.push(`${(12 + r * Math.cos(a + d)).toFixed(2)} ${(12 + r * Math.sin(a + d)).toFixed(2)}`);
    }
  }
  return `M${pts.join('L')}Z`;
})();

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" className="gear-icon" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round">
      <path d={GEAR_PATH} />
      <circle cx={12} cy={12} r={3.1} />
    </svg>
  );
}

/**
 * The settings, top right (dev chrome out of the way, but only compress when it must): the animation speed, the
 * card size, the effects level and Concede. With room for them (styles.css, "corner menu") they sit inline as buttons;
 * on a narrow screen they fold behind one gear whose popover holds the same controls. One set of elements either way,
 * so the test ids, aria and the Concede two-click confirm are identical; the widths decide, not script. Esc or a
 * click outside closes the popover.
 */
export function CornerMenu() {
  const speed = useUi((s) => s.speed);
  const cardSize = useUi((s) => s.cardSize);
  const effects = useUi((s) => s.effects);
  const inMatch = useUi((s) => s.inMatch);
  const gameOver = useUi((s) => s.gameOver);
  const still = useUi((s) => s.reducedMotion);
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Esc closes the menu, not whatever the table would do with it.
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) setConfirming(false);
  }, [open]);
  return (
    <div className={`corner${open ? ' open' : ''}`} data-testid="corner" ref={ref}>
      <button className="btn chip ghost menu-toggle" aria-expanded={open} aria-haspopup="true" aria-label="Settings" title="Settings" onClick={() => setOpen(!open)}>
        <GearIcon />
      </button>
      <div className={`corner-menu${still ? ' still' : ''}`} role="group" aria-label="Settings">
        <div className="corner-row">
          <span className="corner-label">Speed</span>
          <div className="seg" role="group" aria-label="Animation speed">
            {SPEEDS.map((v) => (
              <button key={v} className={speed === v ? 'on' : ''} onClick={() => runtime().setSpeed(v)}>
                {SPEED_LABEL[v]}
              </button>
            ))}
          </div>
        </div>
        {inMatch && (
          <div className="corner-row">
            <span className="corner-label">Cards</span>
            <div className="seg" role="group" aria-label="Card size (Ctrl + / Ctrl − / Ctrl 0)" data-testid="card-size">
              {CARD_SIZES.map((v) => (
                <button key={v} className={cardSize === v ? 'on' : ''} title={`${v} cards`} onClick={() => runtime().setCardSize(v)}>
                  {v}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="corner-row">
          <span className="corner-label">Effects</span>
          <button
            className="btn chip ghost"
            data-testid="effects"
            title="Effects: Full, Lite (no particles, shake or flash) or Off (cards crossfade)"
            onClick={() => runtime().setEffects(FX_NEXT[effects])}
          >
            FX {FX_LABEL[effects]}
          </button>
        </div>
        {inMatch && !gameOver && (
          <button
            className={`btn chip ghost concede${confirming ? ' confirming' : ''}`}
            onClick={() => {
              if (confirming) {
                runtime().concede();
                setOpen(false);
              }
              setConfirming(!confirming);
            }}
            onBlur={() => setConfirming(false)}
          >
            {confirming ? 'Concede? Click again' : 'Concede'}
          </button>
        )}
      </div>
    </div>
  );
}

/** Large card preview beside the hovered card (no delay logic beyond CSS). */
export function HoverPreview() {
  const id = useUi((s) => s.preview);
  const card = useUi((s) => (id ? s.shown.cards[id] : undefined));
  // The zone strip's backdrop covers the table and its previews (unless "Show battlefield" put it away).
  const covered = useUi((s) => stripOpen(s) && !peekHidden(s.peek));
  if (!id || !card?.state || covered) return null;
  const pose = runtime().scene.poseOf(id);
  if (!pose) return null;
  const pt = runtime().scene.screenPoint(pose.x, pose.y);
  return <FloatingCard card={card} x0={pt.x - 90} x1={pt.x + 90} cy={pt.y} alt={altOf(id)} />;
}

/** A castable card in the strip beside my hand (table/altZone.ts): its preview says where it waits and shows its alternate cost. */
function altOf(id: string): AltCard | undefined {
  return runtime().scene.altCards.find((a) => a.id === id);
}

/** Touch: the preview a long press pinned, with Snooze (the right-click of a mouse). A touch on the table closes it. */
export function PinnedPreview() {
  const id = useUi((s) => s.pinned);
  const card = useUi((s) => (id ? s.shown.cards[id] : undefined));
  const snoozed = useUi((s) => !!id && (s.autoPass.snoozed ?? []).includes(id));
  const covered = useUi(stripOpen);
  const peek = useBattlefieldPeek(!!id && !!card?.state && !covered, card?.state?.name ?? 'the card', id ?? '');
  if (!id || !card?.state || covered) return null;
  const pose = runtime().scene.poseOf(id);
  const pt = pose ? runtime().scene.screenPoint(pose.x, pose.y) : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  return (
    <FloatingCard card={card} x0={pt.x - 90} x1={pt.x + 90} cy={pt.y} testId="pinned-preview" pinned peek={peek} alt={altOf(id)}>
      <div className="pinned-actions">
        <button className="btn secondary" data-testid="pinned-snooze" onClick={() => runtime().toggleSnooze(id)}>
          {snoozed ? 'Unsnooze' : 'Snooze'}
        </button>
        <button className="btn secondary" onClick={() => useUi.setState({ pinned: null })}>
          Close
        </button>
      </div>
    </FloatingCard>
  );
}

/**
 * A big card floating beside a spot on screen: right of `x1` when it fits, else left of `x0`, centred on `cy`
 * and kept on screen. The table's hover preview and the zone strip's.
 */
export function FloatingCard({
  card,
  x0,
  x1,
  cy,
  testId,
  pinned,
  peek,
  alt,
  children,
}: {
  card: Card;
  x0: number;
  x1: number;
  cy: number;
  testId?: string;
  pinned?: boolean;
  /** A pinned preview covers the table: "Show battlefield" puts it away (overlays/BattlefieldPeek.tsx). */
  peek?: { className: string; inert: boolean | undefined };
  /** A castable card outside my hand: a quiet grey line above the card says where it waits; its cost slot, the alternate cost. */
  alt?: AltCard;
  children?: React.ReactNode;
}) {
  const art = useCardArt(card.state?.imageKey);
  // A hand card's cost now (prompt `costs`); a commander in the command zone's, with its tax (Brawl; table/commander.ts).
  const zoneCost = useUi((s) => (card.zone === 'Hand' ? s.prompt?.costs?.[card.id] : card.zone === 'Command' ? commanderCost(s.shown, card.id, card.state?.manaCost) : undefined));
  const cost = alt?.cost ?? zoneCost;
  // The "where from" line sits above the card: room for it.
  const above = alt ? 22 : 0;
  // Pinned (touch), the card is the point: as tall as the screen allows, leaving room for its buttons.
  const h = pinned ? Math.min(window.innerHeight - 80 - above, 520) : Math.min(window.innerHeight * 0.5, 520 * Math.max(0.6, runtime().scene.tableScale));
  const w = h * (63 / 88);
  const left = x1 + w + 30 < window.innerWidth ? x1 : Math.max(8, x0 - w);
  const top = Math.max(8 + above, Math.min(window.innerHeight - h - (pinned ? 62 : 8), cy - h / 2));
  // A real scan shows printed P/T: the current one goes in a chip over the printed P/T box (its bottom edge at 92%, clear of the bottom strip).
  const chip = art ? ptChip(card, printedPt) : null;
  return (
    <div className={`preview${pinned ? ' pinned' : ''}${peek?.className ?? ''}`} inert={peek?.inert} style={{ left, top }} data-testid={testId}>
      {alt && (
        <span className="preview-from" data-testid="preview-from">
          {alt.label}
        </span>
      )}
      <CardFaceView card={card} height={h} cost={cost} />
      {isSummoningSick(card) && (
        <span className="status-chip" style={{ top: h * 0.13 }} data-testid="preview-sick">
          <i>zZ</i> Summoning sick
        </span>
      )}
      {chip && (
        <span className={`pt-chip num ${chip.tone}`} style={{ top: h * 0.92 }} data-testid="preview-pt">
          {chip.text}
        </span>
      )}
      {children}
    </div>
  );
}
