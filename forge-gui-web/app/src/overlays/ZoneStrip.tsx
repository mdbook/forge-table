/**
 * The zone strip, MTGA-style: when the engine temporarily shows zones (the prompt's `zones`), as with the
 * opponent's hand revealed or choosing from a graveyard, exile or a library, their visible cards are dealt out big
 * over a dimmed, slightly blurred table (which also hides any open card preview), under a light title
 * ("Opponent's hand · 5 cards"). Clicking one is the same `act{card}` as clicking it on the table; hovering (or
 * focusing) one lifts and zooms it (its canvas is painted at the zoomed size and shown scaled down, so the zoom
 * stays sharp).
 *
 * "Can we make this look better". The cards come in from their owner's side (the opponent's from the top,
 * mine from below) with a short stagger and a small overshoot, in a gentle fan when they fit one row (revealFit
 * wraps them on a phone). A click away, Esc or the close button puts the strip away (faster than it came) and
 * leaves a chip to bring it back: the prompt is still there, and the action buttons stay above the backdrop.
 * Reduced motion: plain fades.
 */
import type { CardId, Card } from '@forge-table/protocol';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useEffect, useState } from 'react';
import { CardFaceView } from '../cards/CardFaceView';
import { CARD_RADIUS } from '../layout/geometry';
import { runtime } from '../runtime';
import { useUi } from '../store/uiStore';
import { hudScale } from './askCards';
import { PickBadge } from './PickBadge';
import { pickBadge, picksOf } from '../table/selection';
import { countLabel, fanSlot, revealFit, stripOpen, viewerAction } from './zoneView';
import { useBattlefieldPeek } from './BattlefieldPeek';
import { lowerFirst } from './peek';

const ENTER = [0.22, 1.18, 0.36, 1] as const; // decisive ease-out with a small overshoot (a card landing)
const EXIT = [0.4, 0, 1, 1] as const;

interface Group {
  label: string;
  ids: CardId[];
  /** The zone's owner sits at the top (the opponent): its cards come in from above. */
  fromTop: boolean;
}

const dismiss = () => useUi.setState({ zoneStripDismissed: true });

/** Re-render on resize (the fit is in CSS px). */
function useViewport(): { vw: number; vh: number } {
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return { vw: window.innerWidth, vh: window.innerHeight };
}

export function ZoneStrip() {
  const zones = useUi((s) => s.zoneStrip);
  const model = useUi((s) => s.shown);
  const viewer = useUi((s) => s.viewer);
  const prompt = useUi((s) => s.prompt);
  const open = useUi(stripOpen);
  const dismissed = useUi((s) => s.zoneStripDismissed);
  const calm = useUi((s) => s.reducedMotion || s.effects === 'off');

  // Esc puts it away (and only that: it must not reach the table's Esc = secondary button). A blocking ask above owns the keys.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat || runtime().visibleAsks().length > 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      dismiss();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const groups: Group[] = (zones ?? []).map((z) => {
    const key = (z.zone ?? '').charAt(0).toLowerCase() + (z.zone ?? '').slice(1);
    const ids: CardId[] = (z.player ? model.players[z.player]?.zones?.[key] : undefined) ?? [];
    const selectable = new Set(prompt?.selectable ?? []);
    // The cards you can pick come first, otherwise in zone order.
    const shown = ids.filter((id) => model.cards[id]?.state);
    return {
      label: `${z.player === viewer ? 'Your' : 'Opponent’s'} ${(z.zone ?? '').toLowerCase()}`,
      ids: [...shown.filter((id) => selectable.has(id)), ...shown.filter((id) => !selectable.has(id))],
      fromTop: !!z.player && z.player !== viewer,
    };
  });

  const peek = useBattlefieldPeek(open, lowerFirst(groups.map((g) => g.label).join(' and ')));

  return (
    <>
      <AnimatePresence>{open && <Reveal key="reveal" groups={groups} calm={calm} away={peek} />}</AnimatePresence>
      {dismissed && zones && zones.length > 0 && prompt && prompt.kind !== 'waiting' && (
        <button className="btn chip zr-reopen" data-testid="zone-strip-reopen" onClick={() => useUi.setState({ zoneStripDismissed: false })}>
          {groups.map((g) => `${g.label} · ${countLabel(g.ids.length)}`).join('  ·  ')}
        </button>
      )}
    </>
  );
}

function Reveal({ groups, calm, away }: { groups: Group[]; calm: boolean; away: { className: string; inert: boolean | undefined } }) {
  const model = useUi((s) => s.shown);
  const prompt = useUi((s) => s.prompt);
  const blocked = useUi((s) => s.asks.length > 0);
  const present = useIsPresent();
  const [peek, setPeek] = useState<CardId | null>(null);
  const { vw, vh } = useViewport();
  // A strip that changes under the pointer never sees a mouseleave: drop the zoom with it.
  const key = groups.map((g) => g.ids.join(',')).join('|');
  useEffect(() => setPeek(null), [key]);
  const hs = hudScale();
  const portrait = vh > vw;
  const gap = Math.round((portrait ? 10 : 24) * hs);
  // Room for the title over each group (the prompt's text stays in the action panel, above the backdrop).
  const head = Math.round(52 * hs);
  const availW = Math.min(vw * (portrait ? 0.94 : 0.9), 1760 * hs);
  const availH = (vh * (portrait ? 0.62 : 0.64)) / Math.max(1, groups.length) - head;
  const zoomH = Math.min(vh * 0.46, 420 * hs);
  const selectable = new Set(prompt?.selectable ?? []);
  const picks = picksOf(prompt);
  return (
    <motion.div
      className={`zone-reveal-scrim${away.className}`}
      inert={!present || away.inert}
      data-testid="zone-strip"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: calm ? 0.15 : 0.2, ease: [0, 0, 0.2, 1] } }}
      exit={{ opacity: 0, transition: { duration: calm ? 0.1 : 0.14, ease: EXIT } }}
      // A click away (anywhere but a card or a button) puts it away.
      onPointerDown={(e) => {
        if (!(e.target as Element).closest('button')) dismiss();
      }}
    >
      <div className="zr-content">
        {groups.map((g, gi) => {
          const fit = revealFit(g.ids.length, availW, availH, gap, Math.round(340 * hs), zoomH);
          const w = Math.round(fit.h * (63 / 88));
          const H = Math.round(fit.h * fit.zoom);
          const W = Math.round(H * (63 / 88));
          const from = g.fromTop ? -1 : 1;
          return (
            <div className="zr-group" key={g.label}>
              <motion.div
                className="zr-head"
                initial={calm ? { opacity: 0 } : { opacity: 0, y: from * 8 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.05, 0.7, 0.1, 1] } }}
              >
                <span className="zr-title">{g.label}</span>
                <span className="zr-count num">· {countLabel(g.ids.length)}</span>
                {gi === 0 && (
                  <button className="zr-close" data-testid="zone-strip-close" aria-label="Close (Esc)" title="Close (Esc)" onClick={dismiss}>
                    ×
                  </button>
                )}
              </motion.div>
              <div className="zr-cards" style={{ gap, maxWidth: fit.cols * w + (fit.cols - 1) * gap }} onMouseLeave={() => setPeek(null)}>
                {g.ids.length === 0 && <span className="zr-msg">Empty</span>}
                {g.ids.map((id, i) => {
                  const slot = fanSlot(i, g.ids.length, fit.rows, fit.h);
                  const col = i % fit.cols;
                  const row = Math.floor(i / fit.cols);
                  // The zoom grows from the edge a card sits on (it stays on screen), else from its centre; a single
                  // row grows downward, clear of the title above it.
                  const ox = fit.cols === 1 ? 0.5 : col === 0 ? 0 : col === fit.cols - 1 ? 1 : 0.5;
                  const oy = fit.rows === 1 || row === 0 ? 0 : row === fit.rows - 1 ? 1 : 0.5;
                  const pick = pickBadge(id, picks);
                  const delay = calm ? 0 : i * 0.04;
                  return (
                    <motion.div
                      key={id}
                      className={`zr-slot${peek === id ? ' peek' : ''}`}
                      initial={calm ? { opacity: 0 } : { opacity: 0, y: from * vh * 0.4, rotate: slot.rot - from * 6, scale: 0.82 }}
                      animate={{
                        opacity: 1,
                        y: slot.dy,
                        rotate: slot.rot,
                        scale: 1,
                        transition: calm ? { duration: 0.15 } : { duration: 0.28, ease: ENTER, delay, opacity: { duration: 0.12, delay } },
                      }}
                      exit={calm ? { opacity: 0, transition: { duration: 0.1 } } : { opacity: 0, y: slot.dy + from * 28, scale: 0.94, transition: { duration: 0.14, ease: EXIT } }}
                    >
                      <button
                        className={`zr-card${pick ? ' selected' : selectable.has(id) ? ' selectable' : ''}${peek === id ? ' peek' : ''}`}
                        style={{ width: w, height: fit.h }}
                        onClick={() => present && viewerAction(id, prompt, blocked) && runtime().clickCard(id)}
                        onMouseEnter={() => setPeek(id)}
                        onFocus={() => setPeek(id)}
                        onBlur={() => setPeek((p) => (p === id ? null : p))}
                        data-testid={`zone-card-${id}`}
                        aria-label={model.cards[id]?.state?.name ?? id}
                      >
                        <span
                          className="zr-face"
                          style={{
                            width: W,
                            height: H,
                            left: ox * (w - W),
                            top: oy * (fit.h - H),
                            transformOrigin: `${ox * 100}% ${oy * 100}%`,
                            borderRadius: W * CARD_RADIUS,
                            ['--zoom' as string]: fit.zoom,
                          }}
                        >
                          <CardFaceView card={model.cards[id] as Card} height={H} />
                        </span>
                        {pick && <PickBadge label={pick} testId={`zone-pick-${id}`} />}
                      </button>
                    </motion.div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}
