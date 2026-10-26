/**
 * The X picker ("when you're selecting a value for X: pay X mana, discard X cards, deal X damage"), MTGA-style:
 * a big number between −5 / −1 and +1 / +5 buttons (hold to repeat), quick picks for the ends, and the total cost live
 * when X is mana ({X}{R} with X = 3 → {3}{R}). Replaces the list of numbers the engine sends (numberChoice.ts); the
 * reply is the one the list would send. No slider: you may want more than nine, and a track has a fixed end. A list
 * that ends in "Other..." has no listed cap, so ± carries on past it (the reply is Other, then the digits).
 *
 * Keys: ← ↓ / → ↑ step by 1, PgDn / PgUp by 5, Home / End jump to the min / max (when there is a real max), digits type
 * a number, Backspace takes the last typed digit back, Enter confirms, Esc cancels when the ask allows it.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { AskMsg, GameModel, PlayerId } from '@forge-table/protocol';
import { CardFaceView } from '../cards/CardFaceView';
import { ManaText } from '../hud/ManaText';
import { useUi } from '../store/uiStore';
import { hudScale } from './askCards';
import { PromptFrame } from './PromptFrame';
import { allowed, nearest, numberContext, numberReply, setPendingNumber, step, type NumberSpec } from './numberChoice';

/** Hold-to-repeat: the first repeat after this long, then one per REPEAT_MS. */
const HOLD_MS = 380;
const REPEAT_MS = 70;
/** Typed digits run together while each follows the last within this long. */
const TYPE_MS = 900;

export function XPicker({ ask, spec, model, viewer, onReply }: { ask: AskMsg; spec: NumberSpec; model: GameModel; viewer: PlayerId; onReply: (v: unknown) => void }) {
  const [value, setValue] = useState(spec.initial);
  // The direction of the last change, for the number's roll.
  const [dir, setDir] = useState<'up' | 'down' | null>(null);
  // A text ask that follows "Other..." carries the original message as its title.
  const ctx = useMemo(() => numberContext(ask.kind === 'text' ? (ask.title ?? ask.message) : ask.message, model, viewer), [ask, model, viewer]);
  const reduced = useUi((s) => s.reducedMotion);
  const typed = useRef({ text: '', at: 0 });
  const valueRef = useRef(value);
  valueRef.current = value;

  const set = (v: number) => {
    const cur = valueRef.current;
    if (v === cur) return;
    setDir(v > cur ? 'up' : 'down');
    valueRef.current = v;
    setValue(v);
  };
  const bump = (d: number) => set(step(spec, valueRef.current, d));
  const confirm = () => {
    if (!allowed(spec, valueRef.current)) return;
    const r = numberReply(ask, spec, valueRef.current);
    setPendingNumber(r.then ?? null);
    onReply(r.value);
  };
  const cancel = () => {
    if (spec.cancel) onReply(ask.kind === 'text' ? null : []);
  };

  // A real max: the last listed number, or a text ask's bound (not the engine's "anything up to 2^31" placeholder).
  const maxKnown = Number.isFinite(spec.hi) && spec.hi < 100000;

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      let handled = true;
      if (k === 'ArrowRight' || k === 'ArrowUp') bump(1);
      else if (k === 'ArrowLeft' || k === 'ArrowDown') bump(-1);
      else if (k === 'PageUp') bump(5);
      else if (k === 'PageDown') bump(-5);
      else if (k === 'Home') set(spec.lo);
      else if (k === 'End' && maxKnown) set(spec.hi);
      else if (/^\d$/.test(k)) {
        const now = performance.now();
        const text = ((now - typed.current.at < TYPE_MS ? typed.current.text : '') + k).slice(-6);
        typed.current = { text, at: now };
        set(nearest(spec, Number(text)));
      } else if (k === 'Backspace') {
        const text = typed.current.text.slice(0, -1);
        typed.current = { text, at: performance.now() };
        if (text) set(nearest(spec, Number(text)));
      } else if (k === 'Enter' && !e.repeat) confirm();
      else if (k === 'Escape' && !e.repeat && spec.cancel) cancel();
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask.id]);

  const hs = hudScale();
  const card = ctx.card ? model.cards[ctx.card] : undefined;
  const cost = ctx.cost ? ctx.cost(value) : null;
  const name = ctx.name;
  const atMin = value <= spec.lo;
  const atMax = value >= spec.hi;
  // Past a few digits the number shrinks rather than growing the dial (it is a fixed width, so nothing shifts).
  const digits = String(value).length;
  // A number choice's question is the engine's message (a text ask has its own title and message).
  const framed = ask.kind === 'text' || ask.title ? ask : { ...ask, title: ask.message ?? 'Choose a number', message: undefined };
  return (
    <PromptFrame
      ask={framed}
      model={model}
      testId="ask-number"
      className={`xpick${reduced ? ' rm' : ''}`}
      noSource
      keys={[['← →', '±1'], ['PgUp PgDn', '±5'], ['0 – 9', 'type'], ['Enter', 'confirm'], ...(spec.cancel ? ([['Esc', 'cancel']] as [string, string][]) : [])]}
      secondary={[spec.cancel && { label: 'Cancel', onClick: cancel, testId: 'ask-none' }]}
      primary={{ label: name ? `${name} = ${value}` : `Choose ${value}`, onClick: confirm, disabled: !allowed(spec, value) }}
    >
      <div className="xpick-body">
        {card?.state && (
          <div className="xpick-card">
            <CardFaceView card={card} height={Math.round(250 * hs)} />
          </div>
        )}
        <div className="xpick-dial">
          <div className="xpick-row">
            <Stepper label={`Less${name ? ` ${name}` : ''} by 5`} glyph="−5" small disabled={atMin} onStep={() => bump(-5)} testid="xpick-less5" />
            <Stepper label={`Less${name ? ` ${name}` : ''}`} glyph="−1" disabled={atMin} onStep={() => bump(-1)} testid="xpick-less" />
            <div className="xpick-value" data-testid="xpick-value" aria-live="polite" aria-atomic="true">
              {name && <span className="xpick-name">{name} =</span>}
              <span key={value} className={`xpick-num num${digits > 5 ? ' xl' : digits > 3 ? ' long' : ''}${dir ? ` roll-${dir}` : ''}`}>
                {value}
              </span>
            </div>
            <Stepper label={`More${name ? ` ${name}` : ''}`} glyph="+1" disabled={atMax} onStep={() => bump(1)} testid="xpick-more" />
            <Stepper label={`More${name ? ` ${name}` : ''} by 5`} glyph="+5" small disabled={atMax} onStep={() => bump(5)} testid="xpick-more5" />
          </div>
          <div className="xpick-chips">
            <button className={`btn chip ghost${value === spec.lo ? ' on' : ''}`} data-testid="xpick-min" onClick={() => set(spec.lo)}>
              Min <span className="num">{spec.lo}</span>
            </button>
            {maxKnown && (
              <button className={`btn chip ghost${value === spec.hi ? ' on' : ''}`} data-testid="xpick-max" onClick={() => set(spec.hi)}>
                Max <span className="num">{spec.hi}</span>
              </button>
            )}
          </div>
          {cost && (
            <div className="xpick-cost" data-testid="xpick-cost" aria-label={`Total cost ${cost}`}>
              <span className="xpick-cost-label">Total cost</span>
              <span key={cost} className="xpick-cost-pips">
                <ManaText text={cost} />
              </span>
            </div>
          )}
        </div>
      </div>
    </PromptFrame>
  );
}

/** −5 / −1 / +1 / +5: a press steps once and holding repeats (pointer); Enter / Space step once (keyboard). */
function Stepper({ label, glyph, small, disabled, onStep, testid }: { label: string; glyph: string; small?: boolean; disabled: boolean; onStep: () => void; testid: string }) {
  const timer = useRef<number | null>(null);
  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  // Reaching the end stops a held repeat.
  useEffect(() => {
    if (disabled) stop();
  }, [disabled]);
  const start = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onStep();
    const repeat = (wait: number) => {
      timer.current = window.setTimeout(() => {
        onStep();
        repeat(REPEAT_MS);
      }, wait);
    };
    stop();
    repeat(HOLD_MS);
  };
  return (
    <button
      className={`btn xpick-step${small ? ' small' : ''}`}
      aria-label={label}
      disabled={disabled}
      data-testid={testid}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      // Pointer presses step on pointerdown; only a keyboard "click" (detail 0) steps here.
      onClick={(e) => e.detail === 0 && onStep()}
    >
      {glyph}
    </button>
  );
}
