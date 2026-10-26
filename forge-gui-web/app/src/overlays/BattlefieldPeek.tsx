/**
 * "Show battlefield" (MTGA's View Battlefield; the state is overlays/peek.ts). One mechanism for every
 * overlay that covers the table (the asks, the zone strip, the zone viewer, the mana picker, a pinned preview):
 *
 * - `useBattlefieldPeek` registers the overlay while it is up and gives its root a class (and `inert`): put away, it
 *   slides down a little and fades out (styles.css .peek-hidden) but stays mounted, its selections intact.
 * - `BattlefieldToggle` is the one button over them, top centre: "Show battlefield"; while they are away it becomes
 *   the "Return to <prompt>" pill in the same place (the same element: focus stays on it).
 * - Keys: V toggles, Esc brings them back, holding Space peeks (away while held). A Space tap still reaches the
 *   overlay (or the table) as before: it is passed on when it is released.
 */
import { useEffect, useId } from 'react';
import { useUi } from '../store/uiStore';
import { PEEK_HOLD_MS, peekAdd, peekHidden, peekKey, peekRelabel, peekRemove, peekReturnLabel, peekToggle } from './peek';

/**
 * Register a table-covering overlay while `active`, named `label` on the Return pill; a new `key` (the next ask) counts
 * as a new overlay (everything shows again). Spread the result on the overlay's root element.
 */
export function useBattlefieldPeek(active: boolean, label: string, key = ''): { className: string; inert: boolean | undefined } {
  const base = useId();
  const id = `${base}:${key}`;
  useEffect(() => {
    if (!active) return;
    useUi.setState((s) => ({ peek: peekAdd(s.peek, { id, label }) }));
    return () => useUi.setState((s) => ({ peek: peekRemove(s.peek, id) }));
    // The label is kept current below, without a reshow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, id]);
  useEffect(() => {
    if (active) useUi.setState((s) => ({ peek: peekRelabel(s.peek, id, label) }));
  }, [active, id, label]);
  const hidden = useUi((s) => active && peekHidden(s.peek));
  return { className: hidden ? ' peekable peek-hidden' : ' peekable', inert: hidden || undefined };
}

const toggle = (): void => useUi.setState((s) => ({ peek: peekToggle(s.peek) }));
const setHeld = (held: boolean): void => useUi.setState((s) => (s.peek.held === held ? s : { peek: { ...s.peek, held } }));

/** Space-tap targets that act on a plain (untrusted) Space as the browser would on a real one: buttons and the like. */
function activates(el: Element | null): el is HTMLElement {
  return !!el && (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes((el as HTMLInputElement).type)));
}

/**
 * The peek keys (peek.ts peekKey), on the window in the capture phase so they come before the overlays' own (this
 * mounts with the HUD, before any overlay adds its listener). A Space is held back until it is released: held past
 * PEEK_HOLD_MS it was a peek; sooner, it is passed on as the keydown the overlay (or the table) always got, and a
 * focused button is pressed as the browser would have.
 */
function usePeekKeys(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let tapTarget: EventTarget | null = null;
    const onDown = (e: KeyboardEvent) => {
      // Our own pass-on (untrusted) and typing in a field go straight through.
      if (!e.isTrusted) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      const s = useUi.getState().peek;
      const action = peekKey(e, s.overlays.length > 0, peekHidden(s));
      if (!action) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (action === 'toggle') toggle();
      else if (action === 'back') useUi.setState((st) => ({ peek: { ...st.peek, shown: false, held: false } }));
      else if (action === 'hold' && !timer && !useUi.getState().peek.held) {
        tapTarget = e.target;
        timer = setTimeout(() => {
          timer = null;
          setHeld(true);
        }, PEEK_HOLD_MS);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (!e.isTrusted || e.key !== ' ') return;
      if (timer) {
        // A tap: pass it on as the keydown it was.
        clearTimeout(timer);
        timer = null;
        e.preventDefault();
        const target = (tapTarget as Element | null) ?? document.body;
        tapTarget = null;
        const pass = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
        if (target.dispatchEvent(pass) && activates(target)) target.click();
      } else if (useUi.getState().peek.held) {
        e.preventDefault();
        setHeld(false);
      }
    };
    const onBlur = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      setHeld(false);
    };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
}

/** The eye on the button (struck through on the Return pill: the table is what's showing). */
function Eye({ off }: { off: boolean }) {
  return (
    <svg className="peek-eye" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
      {off && <path d="M4 20 20 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
    </svg>
  );
}

/**
 * The one "Show battlefield" button over every table-covering overlay (top centre), and the "Return to <prompt>" pill
 * it turns into while they are away. Mounted with the HUD (it owns the peek keys); shows only while an overlay is up.
 */
export function BattlefieldToggle() {
  usePeekKeys();
  const active = useUi((s) => s.peek.overlays.length > 0);
  const hidden = useUi((s) => peekHidden(s.peek));
  const held = useUi((s) => s.peek.held && !s.peek.shown);
  const label = useUi((s) => peekReturnLabel(s.peek));
  if (!active) return null;
  return (
    <button
      type="button"
      className={`peek-toggle${hidden ? ' away' : ''}`}
      aria-pressed={hidden}
      data-testid="peek-toggle"
      title={hidden ? 'Bring the prompt back (V or Esc)' : 'Show the battlefield (V; hold Space to peek)'}
      onClick={toggle}
    >
      <Eye off={hidden} />
      <span key={hidden ? 'away' : 'show'} className="peek-label">
        {hidden ? (held ? 'Release Space to return' : `Return to ${label}`) : 'Show battlefield'}
      </span>
      {!hidden && <kbd className="peek-kbd">V</kbd>}
    </button>
  );
}
