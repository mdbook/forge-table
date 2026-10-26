/**
 * Drawing for the keyword moments (director/keywords.ts, choreography KeywordTrack): each function redraws one
 * Graphics for a progress `p` (0 at the hit, 1 at the track's end; some ring on a little after it), in table units.
 * The scene owns their lifetimes (one Graphics each, cleared per frame, destroyed when done).
 */
import type { Graphics } from 'pixi.js';
import type { Pt } from '../arrows/geometry';
import { cardWidth } from '../layout/geometry';
import { clamp01, enter, lerp } from '../util/easing';

/** How long past its track each moment rings on (a multiple of the track's duration). */
export const TAIL = { trample: 2.2, venom: 1, slash: 1, shield: 1 } as const;

const FORCE = 0xffb347;
const FORCE_HOT = 0xffe2a0;
const VENOM = 0x7dff52;
const SHIELD = 0xffe9a8;
const STEEL = 0xf4f7ff;

/**
 * Trample (the hit visibly punches THROUGH the blocker): a shockwave bursts out of the blocker(s) at the hit,
 * a hot streak tears from the first one to the player's plate and bursts there as the life chip lands. Reduced: a
 * straight line from the blocker to the plate that fades, nothing travels.
 */
export function drawTrample(g: Graphics, through: Pt[], to: Pt, h: number, p: number, still: boolean): void {
  const from = through[0];
  if (!from) return;
  if (still) {
    const a = 1 - clamp01(p);
    g.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ color: FORCE, width: 10, alpha: 0.55 * a });
    g.circle(to.x, to.y, 40).stroke({ color: FORCE, width: 5, alpha: 0.6 * a });
    return;
  }
  const w = cardWidth(h);
  // The punch: a ring and a flattened shock front out of every blocker it went through.
  if (p < 0.9) {
    const q = p / 0.9;
    const out = 1 - (1 - q) ** 3;
    for (const b of through) {
      g.ellipse(b.x, b.y, w * (0.45 + 0.5 * out), h * (0.35 + 0.35 * out)).stroke({ color: FORCE_HOT, width: 10 * (1 - q) + 1, alpha: 0.9 * (1 - q) });
      g.ellipse(b.x, b.y, w * 0.42 * (1 - q * 0.4), h * 0.4 * (1 - q * 0.4)).fill({ color: FORCE_HOT, alpha: 0.16 * (1 - q) * (1 - q) });
    }
  }
  // The streak: its head eases out toward the plate, its tail follows and catches it just after arrival.
  if (p < 1.35) {
    const head = enter(clamp01(p));
    const tail = enter(clamp01((p - 0.3) / 1.05));
    const n = 12;
    for (let i = 0; i < n; i++) {
      const a0 = lerp(tail, head, i / n);
      const a1 = lerp(tail, head, (i + 1) / n);
      const k = (i + 1) / n;
      const x0 = lerp(from.x, to.x, a0);
      const y0 = lerp(from.y, to.y, a0);
      const x1 = lerp(from.x, to.x, a1);
      const y1 = lerp(from.y, to.y, a1);
      g.moveTo(x0, y0).lineTo(x1, y1).stroke({ color: FORCE, width: 6 + 22 * k, alpha: 0.35 + 0.5 * k, cap: 'round' });
      g.moveTo(x0, y0).lineTo(x1, y1).stroke({ color: 0xffffff, width: 2 + 6 * k, alpha: 0.9 * k, cap: 'round' });
    }
    if (p < 1) {
      const hx = lerp(from.x, to.x, head);
      const hy = lerp(from.y, to.y, head);
      g.circle(hx, hy, 34).fill({ color: FORCE, alpha: 0.3 });
      g.circle(hx, hy, 15).fill({ color: 0xffffff, alpha: 0.95 });
    }
  }
  // The burst on the plate.
  if (p >= 1) {
    const q = clamp01((p - 1) / (TAIL.trample - 1));
    const out = 1 - (1 - q) ** 3;
    g.circle(to.x, to.y, 50 * (1 - q)).fill({ color: 0xffffff, alpha: 0.6 * (1 - q) });
    g.circle(to.x, to.y, 30 + 120 * out).stroke({ color: FORCE, width: 14 * (1 - q) + 1, alpha: 0.9 * (1 - q) });
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.2;
      const r1 = 36 + 90 * out;
      const r2 = r1 + 30 * (1 - q);
      g.moveTo(to.x + Math.cos(a) * r1, to.y + Math.sin(a) * r1)
        .lineTo(to.x + Math.cos(a) * r2, to.y + Math.sin(a) * r2)
        .stroke({ color: FORCE_HOT, width: 5 * (1 - q) + 1, alpha: 1 - q });
    }
  }
}

/** Deathtouch: a venom-green flash over the card and a ring of it spreading off its edge. Reduced: the tint only. */
export function drawVenom(g: Graphics, at: Pt, h: number, p: number, still: boolean): void {
  const q = clamp01(p);
  const w = cardWidth(h);
  const fade = (1 - q) * (1 - q);
  g.roundRect(at.x - w / 2, at.y - h / 2, w, h, w * 0.06).fill({ color: VENOM, alpha: (still ? 0.3 : 0.5) * fade });
  if (still) return;
  const out = 1 - (1 - q) ** 3;
  const d = 4 + 26 * out;
  g.roundRect(at.x - w / 2 - d, at.y - h / 2 - d, w + 2 * d, h + 2 * d, w * 0.06 + d).stroke({ color: VENOM, width: 8 * (1 - q) + 1, alpha: 0.85 * (1 - q) });
  // A few drops run down off the bottom edge.
  for (let i = 0; i < 5; i++) {
    const x = at.x + (i - 2) * w * 0.18;
    const y = at.y + h * 0.42 + (18 + (i % 2) * 10) * out;
    g.circle(x, y, 5 * (1 - q) + 1.5).fill({ color: VENOM, alpha: 0.8 * (1 - q) });
  }
}

/**
 * A first-strike blow: a bright slash across the target, drawn out fast (the first 35%) then fading, so the first
 * damage step reads apart from the regular one. Reduced: the whole slash, fading.
 */
export function drawSlash(g: Graphics, at: Pt, h: number, p: number, still: boolean): void {
  const q = clamp01(p);
  const w = cardWidth(h);
  const draw = still ? 1 : enter(clamp01(q / 0.35));
  const fade = q < 0.35 && !still ? 1 : 1 - (q - (still ? 0 : 0.35)) / (still ? 1 : 0.65);
  const x0 = at.x + w * 0.55;
  const y0 = at.y - h * 0.45;
  const x1 = at.x - w * 0.55;
  const y1 = at.y + h * 0.4;
  const xe = lerp(x0, x1, draw);
  const ye = lerp(y0, y1, draw);
  g.moveTo(x0, y0).lineTo(xe, ye).stroke({ color: SHIELD, width: 18, alpha: 0.35 * fade, cap: 'round' });
  g.moveTo(x0, y0).lineTo(xe, ye).stroke({ color: 0xffffff, width: 5, alpha: 0.95 * fade, cap: 'round' });
  // A thinner echo just beside it.
  g.moveTo(x0 + 14, y0 + 10).lineTo(xe + 14, ye + 10).stroke({ color: 0xffffff, width: 2, alpha: 0.6 * fade, cap: 'round' });
}

/**
 * Indestructible shrugging off a would-be kill: a shield outline swells a little off the card and shimmers away,
 * with a shield crest over the art. Reduced: the outline, still, fading.
 */
export function drawShield(g: Graphics, at: Pt, h: number, p: number, still: boolean): void {
  const q = clamp01(p);
  const w = cardWidth(h);
  const out = still ? 0.5 : 1 - (1 - q) ** 3;
  const a = 1 - q;
  const d = 6 + 12 * out;
  g.roundRect(at.x - w / 2 - d, at.y - h / 2 - d, w + 2 * d, h + 2 * d, w * 0.06 + d).stroke({ color: SHIELD, width: 6 * a + 1, alpha: 0.9 * a });
  if (still) return;
  // The crest: a heater shield, popping from 0.8 to 1 as it fades.
  const s = (h * 0.22) * (0.8 + 0.2 * out);
  const cy = at.y - h * 0.05;
  g.moveTo(at.x - s, cy - s)
    .lineTo(at.x + s, cy - s)
    .lineTo(at.x + s, cy)
    .quadraticCurveTo(at.x + s, cy + s * 0.9, at.x, cy + s * 1.35)
    .quadraticCurveTo(at.x - s, cy + s * 0.9, at.x - s, cy)
    .closePath()
    .fill({ color: SHIELD, alpha: 0.22 * a })
    .stroke({ color: STEEL, width: 5, alpha: 0.9 * a });
}

/** Haste: a quick flick of flame up off the card's bottom edge as it lands (full effects only). */
export function drawFlame(g: Graphics, at: Pt, h: number, q: number): void {
  const w = cardWidth(h);
  const cols = [0xff5a2b, 0xff9a3c, 0xffd27a];
  for (let i = 0; i < 9; i++) {
    const k = clamp01(q * 1.5 - (i % 3) * 0.12);
    if (k <= 0 || k >= 1) continue;
    const x = at.x + (i / 8 - 0.5) * w * 0.9 + Math.sin(k * 9 + i) * 4;
    const y = at.y + h * 0.48 - 60 * enter(k) - (i % 2) * 10;
    const r = (10 + (i % 3) * 3) * (1 - k);
    // A tongue: a tall ellipse with a hot core.
    g.ellipse(x, y, r, r * 2.2).fill({ color: cols[i % 3]!, alpha: 0.75 * (1 - k) });
    g.ellipse(x, y + r * 0.6, r * 0.45, r).fill({ color: 0xfff4c8, alpha: 0.8 * (1 - k) });
  }
}

/** Vigilance: a small four-point glint on the card's top-left corner as it is declared (it stays untapped). */
export function drawGlint(g: Graphics, at: Pt, h: number, q: number): void {
  const w = cardWidth(h);
  const x = at.x - w * 0.36;
  const y = at.y - h * 0.4;
  const s = 26 * Math.sin(Math.PI * clamp01(q));
  if (s <= 0.5) return;
  const rot = q * 1.2;
  const pt = (a: number, r: number) => ({ x: x + Math.cos(a + rot) * r, y: y + Math.sin(a + rot) * r });
  const path: Pt[] = [];
  for (let i = 0; i < 8; i++) path.push(pt((i * Math.PI) / 4, i % 2 ? s * 0.22 : s));
  g.poly(path.flatMap((p) => [p.x, p.y])).fill({ color: 0xffffff, alpha: 0.95 });
  g.circle(x, y, s * 0.55).fill({ color: SHIELD, alpha: 0.35 });
}

/** A dying deathtouched creature withers instead of charring: white, sickly green, then a dry grey-brown. */
export function witherTint(q: number): number {
  const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  const [r, g, b] = q < 0.5 ? [mix(255, 150, q * 2), mix(255, 196, q * 2), mix(255, 110, q * 2)] : [mix(150, 78, (q - 0.5) * 2), mix(196, 80, (q - 0.5) * 2), mix(110, 62, (q - 0.5) * 2)];
  return (r << 16) | (g << 8) | b;
}
