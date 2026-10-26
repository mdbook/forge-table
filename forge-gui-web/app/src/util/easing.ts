/** Easing curves for the Kiln motion tokens. All map [0,1] → [0,1]-ish. */

export type Easing = (t: number) => number;

/** A CSS-style cubic-bezier(x1, y1, x2, y2), solved by Newton iterations with a bisection fallback. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-5) return sampleY(t);
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 24; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-5) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

export const linear: Easing = (t) => t;
/** standard cubic-bezier(.2,0,0,1) */
export const standard = cubicBezier(0.2, 0, 0, 1);
/** enter cubic-bezier(0,0,.2,1) */
export const enter = cubicBezier(0, 0, 0.2, 1);
/** exit cubic-bezier(.4,0,1,1) */
export const exit = cubicBezier(0.4, 0, 1, 1);
export const easeInOut = cubicBezier(0.45, 0, 0.55, 1);

/**
 * Closed-form damped spring step response for a unit move, evaluated at `t` seconds. Used for the
 * snappy settle (stiffness 520, damping 36) and soft (260, 26) tokens; mass 1.
 */
export function spring(stiffness: number, damping: number): (seconds: number) => number {
  const w0 = Math.sqrt(stiffness);
  const zeta = damping / (2 * Math.sqrt(stiffness));
  return (s: number) => {
    if (s <= 0) return 0;
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      return 1 - Math.exp(-zeta * w0 * s) * (Math.cos(wd * s) + ((zeta * w0) / wd) * Math.sin(wd * s));
    }
    return 1 - Math.exp(-w0 * s) * (1 + w0 * s);
  };
}

export const snappy = spring(520, 36);
export const soft = spring(260, 26);

/** Ease-out with a small overshoot (back-out), used for the 2° tap overshoot. */
export function backOut(overshoot = 1.2): Easing {
  return (t) => {
    const u = t - 1;
    return u * u * ((overshoot + 1) * u + overshoot) + 1;
  };
}

export const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
