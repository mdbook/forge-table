/**
 * Ambient life for the static keywords (plan point 2), on battlefield cards: indestructible keeps a faint
 * steel sheen on the card at all times (a resting streak and a hairline steel edge), with a brighter pass across it now
 * and then, trample presses the card down into the table with a slow stomp,
 * deathtouch a necrotic violet haze with a flickering green line, lifelink a soft warm-red pulse that rings out off the edge. Subtle on purpose (the board must not turn into a slot machine). `calm` (reduced motion,
 * Effects Off): the edges stand still, the passing sheen doesn't play (the resting one stays).
 */
import type { Graphics } from 'pixi.js';
import type { Card } from '@forge-table/protocol';
import { cardWidth } from '../layout/geometry';
import { hasKeyword } from '../store/model';
import { KW } from '../director/keywords';
import { clamp01, standard } from '../util/easing';

/** Which of the ambient keywords a card has (printed or gained), or null for none. */
export interface AmbientKeywords {
  indestructible: boolean;
  trample: boolean;
  deathtouch: boolean;
  lifelink: boolean;
}

export function ambientKeywords(card: Card | undefined): AmbientKeywords | null {
  if (!card || card.facedown || card.zone !== 'Battlefield') return null;
  const k = {
    indestructible: hasKeyword(card, KW.indestructible),
    trample: hasKeyword(card, KW.trample),
    deathtouch: hasKeyword(card, KW.deathtouch),
    lifelink: hasKeyword(card, KW.lifelink),
  };
  return k.indestructible || k.trample || k.deathtouch || k.lifelink ? k : null;
}

/** Indestructible's sheen: one pass of SHEEN_MS every SHEEN_EVERY_MS, staggered per card by its phase. */
export const SHEEN_EVERY_MS = 8000;
export const SHEEN_MS = 1300;
/** Lifelink's pulse: one ring per PULSE_MS. Trample: one stomp per STOMP_MS. */
export const PULSE_MS = 3400;
export const STOMP_MS = 4200;
/** A pressed card (trample, press 1) sinks PRESS_SINK tu and shrinks by PRESS_SHRINK, its shadow tucked in. */
export const PRESS_SINK = 3;
export const PRESS_SHRINK = 0.05;
/** Where a trampler rests between stomps. */
export const PRESS_REST = 0.6;

const STEEL = { color: 0xe6edff, alpha: 0.42 };
/**
 * Indestructible's resting sheen ("a permanent faint sheen, not the temporary animation"): a frozen streak where
 * the pass would be at STEEL_REST_Q, a faint satin over the whole face and a hairline steel edge. Always on, calm too.
 */
export const STEEL_REST_Q = 0.42;
export const STEEL_REST_ALPHA = 0.14;
const VENOM = 0x7dff52;
const LIFE = 0xff7a62;
const NECRO = 0x7a3aa6;

/** The sheen's progress in [0, 1) at `now` for a card at `phase`, or null between passes. */
export function sheenAt(now: number, phase: number): number | null {
  const t = (((now + phase * SHEEN_EVERY_MS) % SHEEN_EVERY_MS) + SHEEN_EVERY_MS) % SHEEN_EVERY_MS;
  return t < SHEEN_MS ? t / SHEEN_MS : null;
}

/** Clip a convex polygon to the rect |x| <= hx, |y| <= hy (Sutherland-Hodgman). */
export function clipToRect(pts: Array<{ x: number; y: number }>, hx: number, hy: number): Array<{ x: number; y: number }> {
  const edges: Array<(p: { x: number; y: number }) => number> = [(p) => hx - p.x, (p) => p.x + hx, (p) => hy - p.y, (p) => p.y + hy];
  let out = pts;
  for (const inside of edges) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i]!;
      const b = src[(i + 1) % src.length]!;
      const da = inside(a);
      const db = inside(b);
      if (da >= 0) out.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
  }
  return out;
}

/**
 * A soft slanted band of light crossing a card `w`×`h` (origin at its centre) left to right at progress `q`: the
 * waking / untap sweeps (cardSprite.ts) and indestructible's sheen. Thirteen stripes side by side, brightest in the
 * middle, each cut to the card rect so the band runs flush to the edge.
 */
export function drawBand(g: Graphics, w: number, h: number, q: number, color: number, alpha: number): void {
  const slant = 0.35;
  const band = w * 0.22;
  const span = w + slant * h + 2 * band;
  const c = -span / 2 + span * standard(q);
  const fade = q < 0.15 ? q / 0.15 : 1 - Math.max(0, q - 0.7) / 0.3;
  const hw = band / 12;
  // Inset a hair, so the corners' rounding barely shows past the band.
  const hx = w / 2 - 0.4;
  const hy = h / 2 - 0.4;
  for (let i = -6; i <= 6; i++) {
    const x0 = c + (i / 6) * band;
    // The stripe x - slant·y in [x0 - hw, x0 + hw], tall enough to cross the card.
    const strip = [
      { x: x0 - hw - slant * h, y: -h },
      { x: x0 + hw - slant * h, y: -h },
      { x: x0 + hw + slant * h, y: h },
      { x: x0 - hw + slant * h, y: h },
    ];
    const pts = clipToRect(strip, hx, hy);
    if (pts.length < 3) continue;
    const k = 1 - Math.abs(i) / 7;
    g.poly(pts.flatMap((p) => [p.x, p.y])).fill({ color, alpha: alpha * k * k * fade });
  }
}

/**
 * Redraw the ambient touches of `k` for a card `baseH` tall at `now`: the edges into `g` (normal blend: deathtouch's
 * haze is dark), indestructible's sheen into `light` (additive, the sweep's Graphics, which the caller cleared).
 */
export function drawAmbientKeywords(g: Graphics, light: Graphics, k: AmbientKeywords, baseH: number, phase: number, now: number, calm: boolean): void {
  g.clear();
  const w = cardWidth(baseH);
  const u = baseH / 150;
  const rr = (d: number) => g.roundRect(-w / 2 - d, -baseH / 2 - d, w + 2 * d, baseH + 2 * d, Math.max(0, w * 0.05 + d));
  // A feathered ring around offset d, about `width` across: thin strokes side by side, fading out from the middle.
  const soft = (d: number, width: number, color: number, alpha: number) => {
    for (let j = -3; j <= 3; j++) rr(d + (j * width) / 6).stroke({ color, width: width / 6 + 0.3 * u, alpha: alpha * (1 - Math.abs(j) / 4) ** 2 });
  };
  if (k.lifelink) {
    if (calm) soft(1 * u, 3 * u, LIFE, 0.3);
    else {
      // A heartbeat: the ring leaves the edge, grows and fades; the edge itself warms as it goes.
      const q = (((now / PULSE_MS + phase) % 1) + 1) % 1;
      const out = 1 - (1 - q) ** 2;
      soft(1 * u + 5 * u * out, 4 * u * (1 - out) + 2 * u, LIFE, 0.5 * (1 - q) ** 2);
      soft(1 * u, 2.5 * u, LIFE, 0.14 + 0.24 * clamp01(1 - q * 2.5));
    }
  }
  if (k.deathtouch) {
    // Necrotic: a violet haze off the edge, and a thin sickly green line inside it that flickers unevenly.
    const t = now + phase * 10_000;
    const f = calm ? 0.4 : clamp01(0.5 + 0.3 * Math.sin((t / 1700) * Math.PI * 2) + 0.25 * Math.sin((t / 530) * Math.PI * 2));
    rr(4.5 * u).stroke({ color: NECRO, width: 5 * u, alpha: 0.08 });
    rr(2 * u).stroke({ color: NECRO, width: 3 * u, alpha: 0.24 });
    rr(-1.4 * u).stroke({ color: VENOM, width: 1 * u, alpha: 0.08 + 0.3 * f });
  }
  if (k.indestructible) {
    drawSteelRest(light, w, baseH);
    const q = calm ? null : sheenAt(now, phase);
    if (q !== null) drawBand(light, w, baseH, q, STEEL.color, STEEL.alpha);
  }
}

/** Indestructible's resting sheen into `light` (additive) on a card `w`×`h`: see STEEL_REST_Q. */
export function drawSteelRest(light: Graphics, w: number, h: number): void {
  const u = h / 150;
  const r = Math.max(0, w * 0.05);
  light.roundRect(-w / 2, -h / 2, w, h, r).fill({ color: STEEL.color, alpha: STEEL_REST_ALPHA * 0.3 });
  drawBand(light, w, h, STEEL_REST_Q, STEEL.color, STEEL_REST_ALPHA);
  light.roundRect(-w / 2 + 0.8 * u, -h / 2 + 0.8 * u, w - 1.6 * u, h - 1.6 * u, Math.max(0, r - 0.8 * u)).stroke({ color: STEEL.color, width: 1 * u, alpha: STEEL_REST_ALPHA * 1.8 });
}

/**
 * How far a trampler is pressed into the table at `now` (0..1): it rests most of the way down, and every STOMP_MS
 * stomps the rest of the way (a fast hit, a slow rise back). `calm`: it rests, still.
 */
export function pressAt(now: number, phase: number, calm: boolean): number {
  if (calm) return PRESS_REST;
  const q = (((now / STOMP_MS + phase) % 1) + 1) % 1;
  const stomp = q < 0.05 ? q / 0.05 : q < 0.65 ? (1 - (q - 0.05) / 0.6) ** 3 : 0;
  return PRESS_REST + (1 - PRESS_REST) * stomp;
}

/**
 * The dent in the mat around a pressed card (`press` 0..1), drawn behind it: dark walls just outside the card edge,
 * fading out into the mat with no hard rim, deepest along the top (lit from above, the far wall is in shadow).
 */
export function drawDent(g: Graphics, baseH: number, press: number): void {
  g.clear();
  if (press <= 0) return;
  const w = cardWidth(baseH);
  const u = baseH / 150;
  const rr = (d: number) => g.roundRect(-w / 2 - d, -baseH / 2 - d, w + 2 * d, baseH + 2 * d, w * 0.05 + d);
  for (let i = 0; i < 6; i++) rr((1 + i) * u).stroke({ color: 0x000000, width: 1.2 * u, alpha: 0.6 * press * (1 - i / 6) ** 2 });
  const half = w / 2 - w * 0.05;
  g.moveTo(-half, -baseH / 2 - 2.5 * u).lineTo(half, -baseH / 2 - 2.5 * u).stroke({ color: 0x000000, width: 4 * u, alpha: 0.35 * press, cap: 'round' });
}

/** The far wall's shadow falling across the top of a pressed card (over its face, in `chrome`): a soft dark band. */
export function drawPressShade(g: Graphics, baseH: number, press: number): void {
  if (press <= 0) return;
  const w = cardWidth(baseH);
  const u = baseH / 150;
  const r = w * 0.05;
  for (let i = 0; i < 7; i++) {
    const dy = (0.8 + 1.6 * i) * u;
    // Inset where the rounded corners are.
    const inset = dy < r ? r - Math.sqrt(r * r - (r - dy) ** 2) : 0;
    const y = -baseH / 2 + dy;
    const k = (1 - i / 7) ** 2;
    g.moveTo(-w / 2 + inset, y).lineTo(w / 2 - inset, y).stroke({ color: 0x000000, width: 1.7 * u, alpha: 0.32 * press * k });
  }
}
