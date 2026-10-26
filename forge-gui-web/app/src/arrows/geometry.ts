/**
 * Arrow geometry (pure, table units): a quadratic Bézier from a source to a target, bowed sideways, ending in
 * a notched arrowhead. Ends are boxes (a card's or a plate's axis-aligned extent) or bare points (the cursor);
 * a box end sits on the ray from the box centre toward the curve, pulled `inset` of the way back to its centre.
 */
import { cardWidth } from '../layout/geometry';

export interface Pt {
  x: number;
  y: number;
}

/** An axis-aligned box: centre and half extents. */
export interface Box extends Pt {
  hw: number;
  hh: number;
}

export type End = Pt | Box;

export interface ArrowOpts {
  /** Sideways bow as a fraction of the distance (signed: positive bows to the left of travel). */
  bow?: number;
  /** The bow never exceeds this many tu. */
  maxBow?: number;
  /** How far a box start sits inside its box (0 = on the edge, 1 = at the centre). */
  fromInset?: number;
  /** How far a box tip sits inside its box. */
  toInset?: number;
  headLen?: number;
  headW?: number;
  /** The head never shrinks below this fraction of its size, however short the arrow. */
  minHead?: number;
}

export interface ArrowGeom {
  p0: Pt;
  c: Pt;
  /** The tip (the curve's end). */
  p1: Pt;
  /** Curve length (approximate). */
  len: number;
  headLen: number;
  headW: number;
}

/** The drawable parts of an arrow at draw-in progress k: the shaft (a quadratic) and the head polygon. */
export interface ArrowShape {
  shaft: { p0: Pt; c: Pt; p1: Pt };
  /** Tip, left barb, notch, right barb. */
  head: [Pt, Pt, Pt, Pt];
}

export const DEFAULT_ARROW: Required<ArrowOpts> = { bow: 0.18, maxBow: 140, fromInset: 0.5, toInset: 0.2, headLen: 34, headW: 34, minHead: 0 };

const isBox = (e: End): e is Box => 'hw' in e;

export function quadAt(p0: Pt, c: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y };
}

/** The (unnormalised) tangent at t. */
export function quadTangent(p0: Pt, c: Pt, p1: Pt, t: number): Pt {
  return { x: 2 * (1 - t) * (c.x - p0.x) + 2 * t * (p1.x - c.x), y: 2 * (1 - t) * (c.y - p0.y) + 2 * t * (p1.y - c.y) };
}

/** The part of a quadratic on [0, t] (de Casteljau). */
export function subQuad(p0: Pt, c: Pt, p1: Pt, t: number): { p0: Pt; c: Pt; p1: Pt } {
  return { p0, c: { x: p0.x + (c.x - p0.x) * t, y: p0.y + (c.y - p0.y) * t }, p1: quadAt(p0, c, p1, t) };
}

export function quadLength(p0: Pt, c: Pt, p1: Pt, steps = 16): number {
  let len = 0;
  let prev = p0;
  for (let i = 1; i <= steps; i++) {
    const p = quadAt(p0, c, p1, i / steps);
    len += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return len;
}

/**
 * The point where the ray from a box's centre toward `toward` leaves the box, pulled `inset` of the way back to
 * the centre. A `toward` inside the box is returned as is (pulled the same way).
 */
export function boxExit(box: Box, toward: Pt, inset = 0): Pt {
  const vx = toward.x - box.x;
  const vy = toward.y - box.y;
  if (vx === 0 && vy === 0) return { x: box.x, y: box.y };
  const tx = vx !== 0 ? box.hw / Math.abs(vx) : Infinity;
  const ty = vy !== 0 ? box.hh / Math.abs(vy) : Infinity;
  const t = Math.min(tx, ty, 1) * (1 - inset);
  return { x: box.x + vx * t, y: box.y + vy * t };
}

/** The axis-aligned extent of a card of height h turned by rot (tapped cards are wider than tall). */
export function cardBox(x: number, y: number, h: number, rot = 0): Box {
  const w = cardWidth(h);
  const c = Math.abs(Math.cos(rot));
  const s = Math.abs(Math.sin(rot));
  return { x, y, hw: (w * c + h * s) / 2, hh: (w * s + h * c) / 2 };
}

/** The arrow from `from` to `to`, or null when the two are (nearly) the same point. */
export function arrowGeometry(from: End, to: End, opts: ArrowOpts = {}): ArrowGeom | null {
  const o = { ...DEFAULT_ARROW, ...opts };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return null;
  // Bow sideways from the midpoint (left of travel for a positive bow), capped.
  const bow = Math.sign(o.bow) * Math.min(Math.abs(o.bow) * dist, o.maxBow);
  const nx = dy / dist;
  const ny = -dx / dist;
  const c0 = { x: (from.x + to.x) / 2 + nx * bow, y: (from.y + to.y) / 2 + ny * bow };
  const p0 = isBox(from) ? boxExit(from, c0, o.fromInset) : { x: from.x, y: from.y };
  const p1 = isBox(to) ? boxExit(to, c0, o.toInset) : { x: to.x, y: to.y };
  // Re-centre the control point between the trimmed ends so the bow stays symmetric.
  const tdx = p1.x - p0.x;
  const tdy = p1.y - p0.y;
  const tdist = Math.hypot(tdx, tdy);
  if (tdist < 1) return null;
  const tbow = Math.sign(o.bow) * Math.min(Math.abs(o.bow) * tdist, o.maxBow);
  const c = { x: (p0.x + p1.x) / 2 + (tdy / tdist) * tbow, y: (p0.y + p1.y) / 2 - (tdx / tdist) * tbow };
  const len = quadLength(p0, c, p1);
  // A short arrow gets a smaller head (at most 40% of its length).
  const k = Math.max(o.minHead, Math.min(1, (len * 0.4) / o.headLen));
  return { p0, c, p1, len, headLen: o.headLen * k, headW: o.headW * k };
}

/**
 * The arrow drawn in up to progress k (0..1): the shaft runs along the curve to the head's notch, the head sits
 * at B(k) pointing along the curve there.
 */
export function arrowShape(g: ArrowGeom, k = 1): ArrowShape {
  const t = Math.max(0.001, Math.min(1, k));
  const tip = quadAt(g.p0, g.c, g.p1, t);
  const tan = quadTangent(g.p0, g.c, g.p1, t);
  const tl = Math.hypot(tan.x, tan.y) || 1;
  const ux = tan.x / tl;
  const uy = tan.y / tl;
  // Shrink the head while the drawn part is still shorter than it.
  const drawn = g.len * t;
  const s = k >= 1 ? 1 : Math.min(1, drawn / (g.headLen * 1.4 || 1));
  const hl = g.headLen * s;
  const hw = g.headW * s;
  const base = { x: tip.x - ux * hl, y: tip.y - uy * hl };
  const notch = { x: tip.x - ux * hl * 0.72, y: tip.y - uy * hl * 0.72 };
  const left = { x: base.x - uy * (hw / 2), y: base.y + ux * (hw / 2) };
  const right = { x: base.x + uy * (hw / 2), y: base.y - ux * (hw / 2) };
  // The shaft ends at the notch: the parameter where the curve is that far from the tip (bisection).
  const want = hl * 0.72;
  let lo = 0;
  let hi = t;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const p = quadAt(g.p0, g.c, g.p1, mid);
    if (Math.hypot(p.x - tip.x, p.y - tip.y) > want) lo = mid;
    else hi = mid;
  }
  return { shaft: subQuad(g.p0, g.c, g.p1, lo), head: [tip, left, notch, right] };
}
