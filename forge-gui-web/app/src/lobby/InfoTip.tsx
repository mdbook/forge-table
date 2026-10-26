/** An ⓘ button whose explanation shows on hover or focus, and stays on a tap until a tap elsewhere or Esc. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export function InfoTip({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <span className={`info-tip${open ? ' open' : ''}`} ref={box}>
      <button type="button" className="info-btn" aria-label={label} aria-expanded={open} aria-describedby={id} data-testid={testId} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
          <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="8" cy="5" r="0.95" fill="currentColor" />
          <path d="M8 7.3v4.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <span role="tooltip" id={id} className="info-pop">
        {children}
      </span>
    </span>
  );
}
