/** Small lobby pieces shared by the home page and New game: a person's avatar with a presence dot, and format glyphs. */
import { useState, type ReactNode } from 'react';
import type { LobbyFormat, Person } from './api';
import { avatarHue } from './home';

/** A round initial on the name's own colour, with a presence dot (online green, in a game amber, away grey). */
export function Avatar({ name, state, size }: { name: string; state?: Person['state']; size?: 'lg' }) {
  return (
    <span className={`avatar${size ? ` ${size}` : ''}`} style={{ background: avatarHue(name) }} aria-hidden="true">
      {(name.trim()[0] ?? '?').toUpperCase()}
      {state && <span className={`pdot ${state}`} />}
    </span>
  );
}

/** A format's mark: a crown for Brawl, a star for Standard, crossed swords for Constructed. */
export function FormatGlyph({ format, size = 16 }: { format: LobbyFormat | undefined; size?: number }) {
  return (
    <svg className={`fmt-glyph ${format ?? 'constructed'}`} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      {format === 'brawl' ? (
        <path d="M3.5 18.5h17M4.5 16l-1.5-9 5 4 4-6.5 4 6.5 5-4-1.5 9z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
      ) : format === 'standard' ? (
        <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      ) : (
        <path d="M4 4l11 11m-2.5 2.5L15 20l5-5-2.5-2.5M20 4L9 15m2.5 2.5L9 20l-5-5 2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
      )}
    </svg>
  );
}

/**
 * The Neural AI's picture (the server's FT_NEURAL_AVATAR), round and cropped to fill its box (styles.css .ai-photo);
 * `fallback` instead when there is none (`src` undefined) or it fails to load.
 */
export function AiPhoto({ src, alt, className, fallback }: { src: string | null | undefined; alt: string; className?: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return <>{fallback}</>;
  return <img className={`ai-photo${className ? ` ${className}` : ''}`} src={src} alt={alt} draggable={false} data-testid="ai-photo" onError={() => setFailed(src)} />;
}

/** An opponent tile's face: a chip for Forge's AIs, a spark for the neural one. */
export function AiGlyph({ neural }: { neural: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      {neural ? (
        <path d="M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5m7 7L18 18M18 6l-2.5 2.5m-7 7L6 18M12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      ) : (
        <path d="M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm2 4h4v4h-4zM9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      )}
    </svg>
  );
}

/** The cyan tick in the corner of a picked tile. */
export function CheckBadge() {
  return (
    <span className="check-badge" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="12" height="12">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
