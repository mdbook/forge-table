/** HUD positioning in table units: the HUD shares the table's transform (CSS vars --s, --ox, --oy, --dx). */
import { useSyncExternalStore, type CSSProperties } from 'react';
import { CARD_SCALE, TABLE_H, TABLE_W, geometry, hudScale, worldSize, type Geometry } from '../layout/geometry';
import { useUi } from '../store/uiStore';
import { hasCommanders } from '../table/commander';

export const tx = (x: number): string => `calc(var(--ox) + ${x} * var(--s) * 1px)`;
export const ty = (y: number): string => `calc(var(--oy) + ${y} * var(--s) * 1px)`;
export const at = (x: number, y: number): CSSProperties => ({ left: tx(x), top: ty(y) });
/**
 * A right-anchored placement: x is its 1920-tu value (geometry(1920).X) and moves with the world's right edge
 * by --dx = worldW − 1920, as geometry(worldW) moves it.
 */
export const atR = (x: number, y: number): CSSProperties => ({ left: `calc(var(--ox) + (${x} + var(--dx)) * var(--s) * 1px)`, top: ty(y) });

/** A centred placement (the opponent's plate): x is its 1920-tu value and moves by half of --dx, staying centred. */
export const atC = (x: number, y: number): CSSProperties => ({ left: `calc(var(--ox) + (${x} + var(--dx) / 2) * var(--s) * 1px)`, top: ty(y) });

/** Table scale and HUD scale for a viewport (the HUD scales by hudScale(s)), and the world's size. */
export function scales(w: number, h: number): { s: number; hs: number; ox: number; oy: number; worldW: number; worldH: number; portrait: boolean } {
  const { w: worldW, h: worldH } = worldSize(w, h);
  const s = Math.min(w / worldW, h / worldH);
  return { s, hs: hudScale(s), ox: (w - worldW * s) / 2, oy: (h - worldH * s) / 2, worldW, worldH, portrait: worldH > worldW };
}

const viewKey = (): string => `${window.innerWidth}x${window.innerHeight}`;
const onResize = (cb: () => void): (() => void) => {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
};

/**
 * The geometry the HUD places itself by: the 1920-tu one in landscape (right-anchored boxes then move by --dx, atR,
 * and centred ones by half of it, atC, so a resize needs no re-render), the real one in portrait (where --dx is 0).
 */
export function useGeo(): Geometry & { hudPortrait: boolean } {
  const key = useSyncExternalStore(onResize, viewKey);
  const cardScale = CARD_SCALE[useUi((s) => s.cardSize)];
  // A Brawl game sizes the portrait piles to fit the command zone (geometry.ts COMMAND).
  const command = useUi((s) => hasCommanders(s.shown));
  const [w, h] = key.split('x').map(Number) as [number, number];
  const v = scales(w, h);
  const g = v.portrait ? geometry(v.worldW, cardScale, v.hs / v.s, v.worldH, command) : geometry(TABLE_W, cardScale, 1, TABLE_H, command);
  return { ...g, hudPortrait: v.portrait };
}
