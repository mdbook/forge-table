/** The lobby's dialogs: a bottom sheet on a phone, a centred panel on a wide screen (`wide`). */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/** How long a sheet takes to slide away (styles.css `sheet-out`). */
const SHEET_OUT_MS = 180;

/**
 * A bottom sheet (phones only: Play a friend, Admin): it slides up over a dim scrim, full width, with a grab handle,
 * its title and a close X; its body scrolls on its own. Esc, a tap on the scrim or X close it: it slides back down
 * (ease-in) first, or just goes under reduced motion. Focus moves into the sheet when it opens.
 */
export function Sheet({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const [leaving, setLeaving] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  // The latest onClose without re-running the effect below every render (that would steal focus once a second).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = useCallback(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      closeRef.current();
      return;
    }
    setLeaving(true);
    window.setTimeout(() => closeRef.current(), SHEET_OUT_MS);
  }, []);
  useEffect(() => {
    sheet.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [close]);
  return (
    <div className={`sheet-layer ${className}${leaving ? ' leaving' : ''}`}>
      <div className="sheet-scrim" aria-hidden="true" onClick={close} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={sheet}>
        <div className="sheet-grab" aria-hidden="true" />
        <div className="sheet-head">
          <h2 className="sheet-title">{title}</h2>
          <button className="btn ghost sheet-close" aria-label="Close" onClick={close}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
