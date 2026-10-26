/**
 * The arrow layer (Pixi, above the cards): curved arrows with a notched head, a dark underlay for contrast on
 * bright card art and a soft glow, drawn in along the curve when they appear and faded out when they go. Ends
 * follow the sprites' current transforms, so an arrow stays attached while its cards move.
 */
import { Container, Graphics } from 'pixi.js';
import { table } from '../theme/tokens';
import { clamp01, standard } from '../util/easing';
import { arrowGeometry, arrowShape, type ArrowOpts, type Box, type End } from './geometry';
import type { ArrowEnd, ArrowKind, ArrowSpec } from './specs';

export const ARROW_COLORS: Record<ArrowKind, number> = {
  attack: table.attack,
  block: table.block,
  target: 0xffc93c,
  // A ward trigger tied to the permanent it guards: the ward sigil's violet (table/protectionFx.ts).
  ward: 0xa57bff,
};

/** An aim turned away by hexproof, shroud or protection: the arrow goes this red. */
const DENIED = 0xff6f61;

const DRAW_MS = 280;
/** A tip that changes what it points at (cursor → card, card → card) glides there over this long (no snapping). */
const GLIDE_MS = 140;
const FADE_MS = 160;
/** An arrow of a stack item other than the hovered one. */
const DIM_ALPHA = 0.3;
const SHADOW = 0x0d0f13;
/** The bounce off a protected card: the tip rebounds up to this far (tu), ringing out over this long. */
const BOUNCE = 30;
const BOUNCE_MS = 170;
/** A drawn arrow breathes, a sheen runs down it and a target arrow ripples at its end, once per this long. */
const PULSE_MS = 1100;

/** Per kind: bow direction and how deep the ends sit in their boxes. */
function optsFor(spec: ArrowSpec): ArrowOpts {
  const toPlayer = 'player' in spec.to;
  switch (spec.kind) {
    case 'attack':
      // From inside the attacker (so it plainly starts there) to its defender.
      return { bow: 0.16, fromInset: 0.3, toInset: toPlayer ? 0.12 : 0.3 };
    case 'block':
      // Blocker parked right in front of its attacker: the arrow runs from the blocker's middle well into the
      // attacker, so it reads as a real arrow (MTGA), not a chevron in the gap; the head never shrinks.
      return { bow: 0.12, fromInset: 0.42, toInset: 0.38, headLen: 26, headW: 30, minHead: 1 };
    case 'target':
      // Turned away: the tip stops on the card's edge (the layer rebounds it).
      return { bow: -0.2, fromInset: 0.45, toInset: spec.deflect ? 0 : toPlayer ? 0.12 : 0.35 };
    case 'ward':
      return { bow: 0.2, fromInset: 0.4, toInset: 0.3 };
  }
}

interface Live {
  spec: ArrowSpec;
  born: number;
  goneAt: number | null;
  from: End;
  to: End;
  g: Graphics;
  /** What the tip points at ("card:c1", "player:p0", "point"); a change starts a glide from where it is drawn. */
  endKey: string;
  glide: { from: Box; t0: number } | null;
  /** When the aim began bouncing off a protected card (spec.deflect), else null. */
  deflectAt: number | null;
}

const asBox = (e: End): Box => ('hw' in e ? e : { x: e.x, y: e.y, hw: 0, hh: 0 });
const endKeyOf = (e: ArrowEnd): string => ('card' in e ? `card:${e.card}` : 'player' in e ? `player:${e.player}` : 'point');
const mix = (a: Box, b: Box, t: number): Box => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, hw: a.hw + (b.hw - a.hw) * t, hh: a.hh + (b.hh - a.hh) * t });

function sameEnd(a: ArrowEnd, b: ArrowEnd): boolean {
  return endKeyOf(a) === endKeyOf(b);
}

export type ResolveEnd = (end: ArrowEnd) => End | null;

export class ArrowLayer {
  readonly view = new Container();
  private readonly live = new Map<string, Live>();
  /** Effects lite / off: arrows hold still. */
  calm = false;

  /** Keys of the arrows on screen (tests and diagnostics). */
  get keys(): string[] {
    return [...this.live.values()].filter((l) => l.goneAt === null).map((l) => l.spec.key);
  }

  /** `only`: the arrows this layer draws (the scene splits attack arrows under the cards from the rest above). */
  constructor(private readonly only: (s: ArrowSpec) => boolean = () => true) {
    this.view.eventMode = 'none';
  }

  update(all: ArrowSpec[], resolve: ResolveEnd, now: number, instant = false): void {
    const specs = all.filter(this.only);
    const seen = new Set<string>();
    for (const spec of specs) {
      const from = resolve(spec.from);
      const to = resolve(spec.to);
      if (!from || !to) continue;
      seen.add(spec.key);
      const endKey = endKeyOf(spec.to);
      let l = this.live.get(spec.key);
      if (!l) {
        const g = new Graphics();
        this.view.addChild(g);
        // A target locked in takes over from the arrow being aimed: drawn already, gliding on from its tip.
        const aimed = !spec.pending ? [...this.live.values()].find((o) => o.spec.pending && o.goneAt === null && o.spec.kind === spec.kind && sameEnd(o.spec.from, spec.from)) : undefined;
        l = { spec, born: spec.pending || instant || aimed ? now - DRAW_MS : now, goneAt: null, from, to, g, endKey, glide: aimed ? { from: asBox(aimed.to), t0: now } : null, deflectAt: null };
        if (aimed) aimed.goneAt = now - FADE_MS; // gone this frame: the new arrow is drawn where it was
        this.live.set(spec.key, l);
      } else if (l.goneAt !== null) {
        // Back before it faded out: carry on from where it is.
        l.goneAt = null;
      }
      const moved = endKey !== l.endKey;
      if (moved && !instant && !this.calm) l.glide = { from: asBox(l.to), t0: now };
      l.endKey = endKey;
      l.spec = spec;
      l.from = from;
      const g = l.glide ? clamp01((now - l.glide.t0) / GLIDE_MS) : 1;
      if (g >= 1) l.glide = null;
      l.to = l.glide ? mix(l.glide.from, asBox(to), standard(g)) : to;
      // Turned away: once the tip has glided onto the card it rebounds off the edge a few times, dying out; the
      // card's box grows by the rebound so the tip leaves the edge (reduced motion: it just stops there).
      if (!spec.deflect) l.deflectAt = null;
      else if (l.deflectAt === null || moved) l.deflectAt = now + GLIDE_MS;
      if (spec.deflect && !this.calm && l.deflectAt !== null && now > l.deflectAt) {
        const t = now - l.deflectAt;
        const out = BOUNCE * Math.exp(-t / (BOUNCE_MS * 1.6)) * Math.abs(Math.sin(t / (BOUNCE_MS * 0.55)));
        const b = asBox(l.to);
        l.to = { ...b, hw: b.hw + out, hh: b.hh + out };
      }
    }
    for (const [key, l] of this.live) {
      if (seen.has(key)) continue;
      if (l.goneAt === null) l.goneAt = instant ? now - FADE_MS : now;
      if (now - l.goneAt >= FADE_MS) {
        l.g.destroy();
        this.live.delete(key);
      }
    }
    // Pending arrows draw last (on top).
    const order = [...this.live.values()].sort((a, b) => Number(!!a.spec.pending) - Number(!!b.spec.pending));
    order.forEach((l, i) => {
      l.g.zIndex = i;
      const k = standard(clamp01((now - l.born) / DRAW_MS));
      const alpha = l.goneAt === null ? 1 : 1 - clamp01((now - l.goneAt) / FADE_MS);
      // Another stack item hovered (specs.ts `dim`): this arrow steps back.
      draw(l.g, l, k, alpha * (l.spec.pending ? 0.92 : l.spec.dim ? DIM_ALPHA : 1), now, this.calm);
    });
    this.view.sortableChildren = true;
  }

  clear(): void {
    for (const l of this.live.values()) l.g.destroy();
    this.live.clear();
  }
}

function draw(g: Graphics, l: Live, k: number, alpha: number, now: number, calm: boolean): void {
  g.clear();
  if (alpha <= 0) return;
  const geom = arrowGeometry(l.from, l.to, optsFor(l.spec));
  if (!geom) return;
  const { shaft, head } = arrowShape(geom, k);
  const color = l.spec.deflect ? DENIED : ARROW_COLORS[l.spec.kind];
  const pts = head.flatMap((p) => [p.x, p.y]);
  const trace = () => g.moveTo(shaft.p0.x, shaft.p0.y).quadraticCurveTo(shaft.c.x, shaft.c.y, shaft.p1.x, shaft.p1.y);
  // Once drawn in (and not still being aimed) it is alive: the glow breathes, a sheen runs to the head.
  const alive = k >= 1 && !l.spec.pending && !calm;
  const phase = alive ? (((now - l.born) / PULSE_MS) % 1 + 1) % 1 : 0;
  const breathe = alive ? 0.8 + 0.4 * (0.5 - 0.5 * Math.cos(phase * Math.PI * 2)) : 1;
  // Soft glow: wide, faint strokes of the arrow's colour around shaft and head.
  for (const [w, a] of [
    [28, 0.07],
    [18, 0.14],
    [11, 0.24],
  ] as const) {
    trace().stroke({ width: w, color, alpha: a * alpha * breathe, cap: 'round', join: 'round' });
    g.poly(pts).stroke({ width: w * 0.7, color, alpha: a * alpha * breathe, cap: 'round', join: 'round' });
  }
  if (alive && (l.spec.kind === 'target' || l.spec.kind === 'ward') && 'card' in l.spec.to) {
    // The target ripples.
    const r = 22 + 60 * phase;
    g.circle(shaft.p1.x, shaft.p1.y, r).stroke({ width: 4 * (1 - phase) + 1, color, alpha: 0.6 * (1 - phase) * alpha });
  }
  // Dark underlay, then the core and its bright centre line.
  trace().stroke({ width: 9, color: SHADOW, alpha: 0.5 * alpha, cap: 'round', join: 'round' });
  g.poly(pts).stroke({ width: 3, color: SHADOW, alpha: 0.5 * alpha, join: 'round' });
  trace().stroke({ width: 6, color, alpha, cap: 'round', join: 'round' });
  g.poly(pts).fill({ color, alpha });
  trace().stroke({ width: 1.6, color: 0xffffff, alpha: 0.45 * alpha, cap: 'round' });
  if (alive) {
    const t = phase;
    const x = (1 - t) ** 2 * shaft.p0.x + 2 * (1 - t) * t * shaft.c.x + t * t * shaft.p1.x;
    const y = (1 - t) ** 2 * shaft.p0.y + 2 * (1 - t) * t * shaft.c.y + t * t * shaft.p1.y;
    const a = Math.sin(Math.PI * t) * alpha;
    g.circle(x, y, 9).fill({ color, alpha: 0.35 * a });
    g.circle(x, y, 3.5).fill({ color: 0xffffff, alpha: 0.85 * a });
  }
}
