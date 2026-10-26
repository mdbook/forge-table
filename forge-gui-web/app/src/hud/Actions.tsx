/**
 * The prompt bar and the primary cluster: a large PRIMARY at the bottom right, SECONDARY to
 * its left, and chips above (End Turn, Undo, Skip). Labels come from the pure `primaryLabel`; every press
 * sends the engine's OK / Cancel with the pid of the prompt on screen.
 */
import { AnimatePresence, motion } from 'motion/react';
import { useEffect } from 'react';
import type { GameModel, PromptBody } from '@forge-table/protocol';
import { CARD_SIZES, type CardSize } from '../layout/geometry';
import { runtime } from '../runtime';
import { zone } from '../store/model';
import { useUi } from '../store/uiStore';
import { blockPromptText, primaryLabel, type ButtonSpec } from './primaryLabel';
import { blockerMap } from '../arrows/specs';
import { keyAction } from './keys';
import { atR, useGeo } from './pos';
import { ManaText } from './ManaText';
import { CostTracker } from './CostTracker';
import { useMullInfo } from './MulliganBanner';
import { framedConfirm } from './ConfirmPrompt';
import { offerAutoResolve } from './autoResponses';

/** The engine's standard priority text adds nothing the status line doesn't show. */
const ROUTINE_PRIORITY = /^Priority: .*\nTurn: .*\nPhase: .*\nStack: .*$/s;

function promptText(p: PromptBody, model: GameModel): string | null {
  if (p.kind === 'priority' && ROUTINE_PRIORITY.test(p.message.trim())) return null;
  if (p.kind === 'waiting') return p.message || null;
  const text = p.message.trim();
  if (!text) return null;
  const card = p.card ? model.cards[p.card]?.state?.name : undefined;
  return card && !text.includes(card) ? `${card}: ${text}` : text;
}

/**
 * A button whose label morphs (MTGA juice): a new label ("Pass" → "Attack" → "Resolve") slides up into place as
 * the old one slides up and out, both in one grid cell so the button never jumps mid-change. Reduced motion and the
 * goldens (test mode) swap it outright.
 */
function ButtonView({ spec, className, testid, kbd }: { spec: ButtonSpec; className: string; testid: string; kbd?: string }) {
  const morph = useUi((s) => !s.test && !s.reducedMotion && s.effects !== 'off');
  const face = (
    <>
      <span>
        {spec.busy && <span className="spinner" />}
        {spec.label}
      </span>
      {spec.subtitle && <span className="sub">{spec.subtitle}</span>}
    </>
  );
  const badge = kbd && spec.enabled && spec.action ? <kbd className="btn-kbd">{kbd}</kbd> : null;
  return (
    <button
      className={`btn ${className}`}
      disabled={!spec.enabled || !spec.action}
      data-testid={testid}
      onClick={(e) => {
        // Drop focus so Space/Enter go through the global handler only (no double press).
        e.currentTarget.blur();
        runtime().press(spec);
      }}
    >
      <span className="btn-face">
        {morph ? (
          <AnimatePresence initial={false}>
            <motion.span
              key={`${spec.label}|${spec.subtitle ?? ''}`}
              className="btn-label"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }}
              transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            >
              {face}
            </motion.span>
          </AnimatePresence>
        ) : (
          <span className="btn-label">{face}</span>
        )}
      </span>
      {badge}
    </button>
  );
}

export function ActionCluster() {
  const prompt = useUi((s) => s.prompt);
  const shown = useUi((s) => s.shown);
  const viewer = useUi((s) => s.viewer);
  const stops = useUi((s) => s.stops);
  const autoPass = useUi((s) => s.autoPass);
  const asks = useUi((s) => s.asks);
  const gameOver = useUi((s) => s.gameOver);
  const backlog = useUi((s) => s.backlogMs);
  const test = useUi((s) => s.test);
  const picked = useUi((s) => s.aimPicked);
  const mull = useMullInfo();
  // A yes/no prompt sits in its own frame (ConfirmPrompt.tsx), with its answers: no bar, no buttons here.
  const framed = useUi(framedConfirm);
  const { X } = useGeo();
  if (gameOver) return null;
  const blocked = asks.length > 0;
  const buttons = primaryLabel(
    prompt?.kind ?? null,
    prompt ? { ok: prompt.ok, cancel: prompt.cancel, canUndo: !!prompt.canUndo, selectable: prompt.selectable } : null,
    {
      game: shown.game,
      viewer,
      cards: shown.cards,
      myBattlefield: zone(shown, viewer, 'battlefield'),
      myStops: stops[viewer] ?? [],
      mull,
    },
  );
  // Blocker-first blocking has its own instructions (the engine's are attacker-first); the mulligan banner says it all.
  const text = prompt && !mull && !framed ? (blockPromptText(prompt, shown.cards, picked, blockerMap(shown.game.combat).size) ?? promptText(prompt, shown)) : null;
  const disable = (b: ButtonSpec | null): ButtonSpec | null => (b && blocked ? { ...b, enabled: false } : b);
  const primary = disable(buttons.primary)!;
  const secondary = disable(buttons.secondary);
  const endTurn = disable(buttons.endTurn);
  const undo = disable(buttons.undo);
  const showSkip = !test && backlog > 1500;
  // Two or more on the stack and it's my priority: resolve them all in one go (MTGA's Resolve All).
  const resolveAll = !blocked && prompt?.kind === 'priority' && shown.game.stack.length >= 2;
  // My own spell on top and it's my priority: offer to pass on my own stack items from now on.
  const autoResolve = offerAutoResolve(prompt?.kind ?? null, shown.game.stack, viewer, !!autoPass.autoResolve, blocked);
  return (
    <div className="actions" style={{ ...atR(X.actionsX, X.actionsY), flexDirection: 'column', alignItems: 'flex-end' }} data-testid="actions">
      <CostTracker />
      <AnimatePresence initial={false} mode="popLayout">
        {text && (
          <motion.div
            key={`${prompt?.pid}:${text}`}
            className={`prompt-bar${blocked ? ' disabled' : ''}`}
            style={{ position: 'static', transform: 'none' }}
            data-testid="prompt-bar"
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: blocked ? 0.45 : 1, x: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.09 } }}
            transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
          >
            <ManaText text={text} />
          </motion.div>
        )}
      </AnimatePresence>
      {(endTurn || undo || showSkip || resolveAll || autoResolve) && (
        <div style={{ display: 'flex', gap: 8 }}>
          {showSkip && (
            <button className="btn chip ghost" data-testid="skip" onClick={() => runtime().skip()}>
              Skip »
            </button>
          )}
          {undo && <ButtonView spec={undo} className="chip ghost" testid="undo" />}
          {resolveAll && (
            <button className="btn chip ghost" data-testid="resolve-all" title="Resolve all: pass until the stack is empty (R)" onClick={(e) => (e.currentTarget.blur(), runtime().resolveAll())}>
              Resolve all
            </button>
          )}
          {autoResolve && (
            <button
              className="btn chip ghost"
              data-testid="auto-resolve-offer"
              title="Auto-resolve: from now on, pass priority whenever the top of the stack is your own spell or ability. It resolves unless your opponent responds. Turn it off beside Auto-skip."
              onClick={(e) => (e.currentTarget.blur(), runtime().toggleAutoResolve())}
            >
              Auto-resolve mine
            </button>
          )}
          {endTurn && <ButtonView spec={endTurn} className="chip ghost" testid="end-turn" />}
        </div>
      )}
      {!framed && (
      <div className="action-row" style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
        {secondary && <ButtonView spec={secondary} className="secondary" testid="secondary" />}
        <ButtonView spec={primary} className="primary" testid="primary" {...(mull && mull.kind !== 'tuck' ? { kbd: 'Enter' } : {})} />
      </div>
      )}
    </div>
  );
}

/**
 * Ctrl/⌘ + = / − / 0 step the card size (S … XL) and reset it to M. Only while the table is up and focus
 * isn't in a text field: there the keys are the table's, and the browser's page zoom is prevented.
 */
export function cardSizeKey(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey'>, current: CardSize): CardSize | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const i = CARD_SIZES.indexOf(current);
  if (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd') return CARD_SIZES[Math.min(CARD_SIZES.length - 1, i + 1)]!;
  if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') return CARD_SIZES[Math.max(0, i - 1)]!;
  if (e.key === '0' || e.code === 'Numpad0') return 'M';
  return null;
}

/**
 * Keyboard (the map is `keyAction`). Repeats are ignored; keys go to an open overlay first (it handles
 * its own), and never fire while typing in a text field.
 */
export function useKeyboard(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
      const ui = useUi.getState();
      const size = ui.inMatch ? cardSizeKey(e, ui.cardSize) : null;
      if (size) {
        e.preventDefault();
        if (size !== ui.cardSize) runtime().setCardSize(size);
        return;
      }
      if (e.repeat) return;
      const rt = runtime();
      // Overlays (asks, the zone viewer) bind their own keys.
      if (rt.visibleAsks().length > 0 || rt.director.gameOver || ui.zoneView) return;
      // A framed yes/no: Space is "hold to peek at the battlefield" there, never an answer.
      if (e.key === ' ' && framedConfirm(ui)) return;
      const action = keyAction(e, { inMatch: ui.inMatch, passing: ui.autoPass.untilEndOfTurn, inputLive: rt.inputLive });
      if (!action) return;
      e.preventDefault();
      if (action === 'passTurn') rt.togglePassToEndOfTurn();
      else if (action === 'stopPassing') rt.setPassToEndOfTurn(false);
      else if (action === 'autoSkip') rt.toggleAutoSkip();
      else if (action === 'resolveAll') {
        // Only at my priority with something to resolve, as the chip.
        if (rt.inputLive && ui.prompt?.kind === 'priority' && ui.shown.game.stack.length > 0) rt.resolveAll();
      }
      else if (action === 'primary') rt.primary();
      else rt.secondary();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
