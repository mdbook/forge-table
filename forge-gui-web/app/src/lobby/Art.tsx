/** Deck art for the lobby: a card's art crop over its deck's colour wash. */
import { useState } from 'react';
import { pip } from '../theme/tokens';

/** A deck's colours as a soft gradient, under art that hasn't loaded (or that the router hasn't cached). */
export function colorWash(colors: string): string {
  const fills = [...colors].map((c) => (pip as Record<string, { fill: string }>)[c]?.fill).filter(Boolean);
  if (fills.length === 0) return 'linear-gradient(135deg, #2a2f38, #171a20)';
  const stops = fills.length === 1 ? [fills[0], fills[0]] : fills;
  return `linear-gradient(135deg, ${stops.map((f) => `color-mix(in srgb, ${f} 45%, #12151a)`).join(', ')})`;
}

/** A card's art crop, or the colour wash when there is none (204) or it fails. */
export function Art({ card, colors, cropUrl, className }: { card?: string; colors: string; cropUrl: (c: string) => string; className: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const show = card && failed !== card;
  return (
    <span className={className} style={{ background: colorWash(colors) }} aria-hidden="true">
      {show && <img src={cropUrl(card)} alt="" loading="lazy" decoding="async" onError={() => setFailed(card)} />}
    </span>
  );
}
