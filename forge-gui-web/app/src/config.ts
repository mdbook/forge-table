/**
 * Page options from the URL:
 * - `?test=1`       virtual clock (`window.__table.advance`), devicePixelRatio 1, no motion in the HUD.
 * - `?replay=<url>` play a recorded JSONL session with no socket and no JVM.
 * - `?autostart=1`  start a match with the sidecar's defaults as soon as it says hello.
 * - `?speed=2`      motion speed (0 = Instant); `?reducedMotion=1` forces the reduced variants.
 * - `?cards=XL`     card size (S, M, L, XL); otherwise the stored preference (M under `?test=1`).
 * - `?perf=1`       record frame times (window.__table.perf()).
 * - `?art=0`        procedural card faces only (no Scryfall art). Art is also off under `?test=1` and
 *                   `?replay=…`, so deterministic runs never fetch images.
 */
import { CARD_SIZES, type CardSize } from './layout/geometry';

export interface AppConfig {
  test: boolean;
  replay: string | null;
  autostart: boolean;
  perf: boolean;
  speed: number | null;
  cards: CardSize | null;
  reducedMotion: boolean | null;
  /** False when the URL forbids real card art (`?art=0`, `?test=1`, `?replay=…`). */
  artAllowed: boolean;
}

export function readConfig(loc: Location = window.location): AppConfig {
  const q = new URLSearchParams(loc.search);
  const flag = (k: string) => q.get(k) === '1' || q.get(k) === 'true';
  const num = (k: string) => {
    const v = q.get(k);
    if (v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    test: flag('test'),
    replay: q.get('replay'),
    autostart: flag('autostart'),
    perf: flag('perf'),
    speed: num('speed'),
    cards: asCardSize(q.get('cards')),
    reducedMotion: q.has('reducedMotion') ? flag('reducedMotion') : null,
    artAllowed: !flag('test') && q.get('replay') === null && q.get('art') !== '0' && q.get('art') !== 'false',
  };
}

export function asCardSize(v: string | null): CardSize | null {
  return CARD_SIZES.includes(v as CardSize) ? (v as CardSize) : null;
}

/** The card-size setting (S / M / L / XL), a per-viewer preference. */
export const CARD_SIZE_PREF = 'cardSize';

/**
 * Card faces: Scryfall scans served by the sidecar, our own frame (the procedural face with Scryfall's art crop in
 * its art box and the artist credited), or the procedural painter alone. A per-viewer preference; Framed by default.
 */
export type ArtMode = 'scryfall' | 'frame' | 'procedural';
export const ART_PREF = 'art';

export function loadArtMode(): ArtMode {
  const v = loadPref(ART_PREF);
  return v === 'procedural' || v === 'scryfall' ? v : 'frame';
}

/** Auto-skip (pass when nothing but mana abilities can be used): on unless the viewer turned it off. */
export const AUTO_SKIP_PREF = 'autoSkip';

export function loadAutoSkip(): boolean {
  return loadPref(AUTO_SKIP_PREF) !== '0';
}

/** Per-viewer conveniences only (speed, card size, card art, auto-skip); every access is guarded because storage can be unavailable. */
export function loadPref(key: string): string | null {
  try {
    return localStorage.getItem(`forge-table.${key}`);
  } catch {
    return null;
  }
}

export function savePref(key: string, value: string): void {
  try {
    localStorage.setItem(`forge-table.${key}`, value);
  } catch {
    // ignore
  }
}
