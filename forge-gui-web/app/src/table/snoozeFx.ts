/**
 * The snooze look ("make snooze look way better but also distinct from summoning sickness"). Snoozed =
 * "stop asking me about this card" (client-side auto-skip), so it reads as asleep-for-now: the card sinks a little and
 * goes a cool muted blue, a frost veil with a row of icicles settles over it and a crescent moon rises in the middle.
 * Summoning sickness keeps the drifting italic z's in the corner and a warm dim; nothing here is a letter z, a pill or a
 * pause sign. Un-snoozing wakes it: the veil melts, the moon lifts away and a ring of light leaves the card edge.
 * All in card units for a card `baseH` tall (origin at its centre).
 */
import { Container, Graphics, Text } from 'pixi.js';
import { cardWidth } from '../layout/geometry';
import { fonts } from '../theme/tokens';
import { clamp01, enter, exit, standard } from '../util/easing';

/** Settling in and waking up. */
export const SNOOZE_IN_MS = 300;
export const SNOOZE_OUT_MS = 480;
/** How far (tu) a fully snoozed card sinks. */
export const SNOOZE_SINK = 3.5;

const ICE = 0xe4eeff;
/** The moon's centre and radius, in card heights (the night disc is DISC times the radius). */
const MOON_Y = -0.17;
const MOON_R = 0.085;
const DISC = 1.4;
/** The "Snoozed" pill, in card units (u = baseH / 150): its height, and its gap below the night disc. */
const LABEL_H = 11;
const LABEL_GAP = 2.5;

/**
 * Where the "Snoozed" pill sits for a card `baseH` tall (centre y, half height; origin at the card's centre): just under
 * the night disc, clear of its drift, and above the type line at every card size (snoozeFx.test.ts).
 */
export function snoozeLabelY(baseH: number, font = 7.5 * (baseH / 150)): { y: number; half: number } {
  const u = baseH / 150;
  const half = (LABEL_H / 15) * font;
  return { y: baseH * (MOON_Y + MOON_R * DISC) + LABEL_GAP * u + half, half };
}

/** "Snoozed" in Inter 600 with its tracking, in ems (a measured estimate; pure so the clamp below is testable). */
const LABEL_EM = 4.4;

/**
 * The label's font size: 7.5 card units, raised to `minFont` (the scene's smallest legible size, in the card's units)
 * on small cards, a resting phone hand card most of all, but never so far that the pill overflows the card.
 */
export function snoozeLabelFont(baseH: number, minFont = 0): number {
  const u = baseH / 150;
  const fit = (cardWidth(baseH) * 0.92 - 12 * u) / LABEL_EM;
  return Math.max(7.5 * u, Math.min(minFont, fit));
}
const MOON = 0xf1e9c8;
const NIGHT = 0x16203a;
const GLINT = 0xbcd2ff;

/** A deterministic 0..1 per index, so the icicles are not a regular comb. */
const jag = (i: number) => {
  const f = Math.sin(i * 12.9898 + 4.1) * 43758.5453;
  return f - Math.floor(f);
};

/** A four-point sparkle centred on (x, y), `s` from the centre to a tip. */
function sparkle(g: Graphics, x: number, y: number, s: number): Graphics {
  return g
    .moveTo(x, y - s)
    .quadraticCurveTo(x, y, x + s, y)
    .quadraticCurveTo(x, y, x, y + s)
    .quadraticCurveTo(x, y, x - s, y)
    .quadraticCurveTo(x, y, x, y - s)
    .closePath();
}

/**
 * A crescent opening to the right: a disc of radius R at (cx, cy) less a disc of 0.85 R at 0.55 R to its right (two arcs,
 * no masking). It starts its own path at the first arc's start: Pixi carries the last shape's end point over to the next
 * path (after a circle, the origin), and an arc joins it with a line, so the moon grew a tail to the card's centre.
 */
function crescent(g: Graphics, cx: number, cy: number, R: number, alpha: number): void {
  const d = R * 0.55;
  const r = R * 0.85;
  const x = (d * d + R * R - r * r) / (2 * d);
  const y = Math.sqrt(Math.max(0, R * R - x * x));
  const a0 = Math.atan2(y, x);
  const b0 = Math.atan2(y, x - d);
  g.beginPath()
    .moveTo(cx + R * Math.cos(a0), cy + R * Math.sin(a0))
    .arc(cx, cy, R, a0, 2 * Math.PI - a0)
    .arc(cx + d, cy, r, 2 * Math.PI - b0, b0, true)
    .closePath()
    .fill({ color: MOON, alpha });
}

/**
 * Draws the snoozed look into `g` for settle amount `a` (0 awake .. 1 snoozed) and wake progress `w` (0 when not
 * waking). `phase` (0..1, per card) and `now` drive the slow twinkle and the moon's drift; `calm` stills both.
 */
export function drawSnooze(g: Graphics, baseH: number, a: number, w: number, now: number, phase: number, calm: boolean): void {
  g.clear();
  if (a <= 0) return;
  const cw = cardWidth(baseH);
  const u = baseH / 150;
  const rad = cw * 0.06;
  const t = calm ? 0.25 : (now / 3200 + phase) % 1;
  // The veil: a pale cool wash, a brighter frosted edge and a row of icicles hanging from the top edge.
  g.roundRect(-cw / 2, -baseH / 2, cw, baseH, rad).fill({ color: ICE, alpha: 0.2 * a });
  g.roundRect(-cw / 2 + 1.5 * u, -baseH / 2 + 1.5 * u, cw - 3 * u, baseH - 3 * u, rad).stroke({ color: ICE, width: 4 * u, alpha: 0.55 * a });
  const n = 9;
  const step = (cw - 2 * rad) / n;
  g.moveTo(-cw / 2 + rad, -baseH / 2 + 1 * u);
  for (let i = 0; i < n; i++) {
    const x0 = -cw / 2 + rad + i * step;
    g.lineTo(x0 + step * 0.35, -baseH / 2 + 1 * u).lineTo(x0 + step * 0.5, -baseH / 2 + (4 + 9 * jag(i)) * u * a).lineTo(x0 + step * 0.65, -baseH / 2 + 1 * u);
  }
  g.lineTo(cw / 2 - rad, -baseH / 2 + 1 * u).closePath().fill({ color: ICE, alpha: 0.5 * a });
  // Frost flakes in the art's lower corners and over its top right: six-spoked, hairline.
  for (const [fx, fy, fs] of [[-0.36, 0.0, 4.5], [0.37, -0.02, 3.5], [0.3, -0.3, 3]] as const) {
    const x = cw * fx;
    const y = baseH * fy;
    for (let k = 0; k < 3; k++) {
      const ang = (k * Math.PI) / 3 + 0.2;
      g.moveTo(x - Math.cos(ang) * fs * u, y - Math.sin(ang) * fs * u).lineTo(x + Math.cos(ang) * fs * u, y + Math.sin(ang) * fs * u);
    }
    g.stroke({ color: ICE, width: 1.1 * u, alpha: 0.7 * a, cap: 'round' });
  }
  // The moon: a night-blue disc with a crescent, a soft glow behind. It settles in with a small overshoot, drifts a
  // hair while asleep, and lifts away fading as the card wakes. Small and in the art, so the name and rules stay readable.
  const q = clamp01(a);
  const pop = calm ? 1 : 0.6 + 0.4 * (1 + 2.4 * (q - 1) ** 3 + 1.4 * (q - 1) ** 2);
  const lift = w * 10 * u;
  const cy = baseH * MOON_Y - lift + (calm ? 0 : Math.sin(t * Math.PI * 2) * 1.2 * u);
  const R = baseH * MOON_R * pop * (1 + 0.15 * w);
  const alpha = a * (1 - exit(w));
  g.circle(0, cy, R * 2).fill({ color: GLINT, alpha: 0.1 * alpha });
  g.circle(0, cy, R * DISC).fill({ color: NIGHT, alpha: 0.88 * alpha }).stroke({ color: GLINT, width: 1.4 * u, alpha: 0.7 * alpha });
  crescent(g, -R * 0.12, cy, R, alpha);
  // Two stars that twinkle out of step.
  const tw = (k: number) => (calm ? 0.8 : 0.45 + 0.55 * (0.5 + 0.5 * Math.sin((t + k) * Math.PI * 2)));
  sparkle(g, R * 1.15, cy - R * 0.2, 3 * u).fill({ color: MOON, alpha: 0.9 * alpha * tw(0) });
  sparkle(g, R * 0.7, cy - R * 0.95, 2 * u).fill({ color: MOON, alpha: 0.9 * alpha * tw(0.5) });
  // The wake: a ring of light leaves the card edge as the veil melts.
  if (w > 0 && !calm) {
    const o = enter(w);
    const grow = 2 * u + 14 * u * o;
    g.roundRect(-cw / 2 - grow, -baseH / 2 - grow, cw + 2 * grow, baseH + 2 * grow, rad + grow).stroke({ color: 0xdfe8ff, width: 4 * u * (1 - o) + 1 * u, alpha: 0.8 * (1 - o) });
  }
}

/** The snooze overlay on one card: eases a settle amount toward the card's state and redraws. */
export class SnoozeView {
  readonly view = new Container();
  private readonly g = new Graphics();
  private label: Text | null = null;
  /** 0 awake .. 1 snoozed, eased. */
  amt = 0;
  private on = false;
  private t0 = 0;
  private from = 0;
  /** Wake progress while melting (0 = not waking). */
  private wake = 0;

  constructor() {
    this.view.addChild(this.g);
    this.view.eventMode = 'none';
    this.view.visible = false;
  }

  /** Snoozed now? A change starts the settle (in) or the wake (out) at `now`; `calm` jumps straight there. */
  set(on: boolean, now: number, calm: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.t0 = now;
    this.from = this.amt;
    this.wake = 0;
    if (calm) {
      this.amt = on ? 1 : 0;
      this.from = this.amt;
    }
  }

  /** Whether the overlay has anything to show (the card sprite hides it otherwise). */
  get active(): boolean {
    return this.on || this.amt > 0;
  }

  /** Advance to `now` and redraw. */
  frame(now: number, baseH: number, calm: boolean, phase: number, minFont = 0): void {
    const dt = Math.max(0, now - this.t0);
    if (this.on) {
      this.amt = this.from + (1 - this.from) * enter(clamp01(dt / SNOOZE_IN_MS));
    } else if (this.amt > 0) {
      const p = clamp01(dt / SNOOZE_OUT_MS);
      this.amt = this.from * (1 - standard(p));
      this.wake = calm ? 0 : p;
      if (p >= 1) this.amt = 0;
    }
    this.view.visible = this.amt > 0;
    if (!this.view.visible) {
      this.g.clear();
      this.wake = 0;
      return;
    }
    drawSnooze(this.g, baseH, this.amt, this.wake, now, phase, calm);
    // The word under the moon: quiet title case in Inter, a little tracked, on a night pill with a frost hairline, so
    // it reads over any art and sits with the moon instead of shouting over the type line ("make the css better").
    const u = baseH / 150;
    if (!this.label) {
      this.label = new Text({ text: 'Snoozed', style: { fontFamily: fonts.ui, fontWeight: '600', fontSize: 7.5, fill: 0xdce6fa, letterSpacing: 0.4 }, resolution: 2 });
      this.label.anchor.set(0.5);
      this.view.addChild(this.label);
    }
    const font = snoozeLabelFont(baseH, minFont);
    if (this.label.style.fontSize !== font) {
      this.label.style.fontSize = font;
      this.label.style.letterSpacing = (0.4 / 7.5) * font;
    }
    const { y, half } = snoozeLabelY(baseH, font);
    const ly = y - this.wake * 10 * u;
    const fade = this.amt * (1 - this.wake);
    this.label.position.set(0, ly + 0.2 * u);
    this.label.alpha = 0.95 * fade;
    const pw = this.label.width + 12 * u;
    this.g.roundRect(-pw / 2, ly - half, pw, 2 * half, half).fill({ color: NIGHT, alpha: 0.8 * fade }).stroke({ color: GLINT, width: 0.8 * u, alpha: 0.42 * fade });
  }
}
