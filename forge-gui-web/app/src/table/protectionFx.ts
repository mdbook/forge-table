/**
 * Drawing for hexproof / shroud / protection / ward (director/protection.ts): the
 * sigil chips on a card's right edge, the shimmer aura around a hexproof or shroud card, and the flare when something
 * is turned away or a ward trigger lands. All in card units for a card `baseH` tall (origin at its centre), like the
 * rings and badges; CardSprite owns the Graphics and calls these.
 *
 * MTGA shows "protective sigils" on what is protected (Strixhaven release notes) and, per players, glowing elements for
 * hexproof and an overlay for ward. Ours: a round chip per shield kind (shield with a hexagon = hexproof, slashed eye =
 * shroud, plain shield in the protected-from colour = protection), a rune chip with the cost for ward, and a slow light
 * travelling the edge of a hexproof or shroud card.
 */
import { Container, Graphics, Text } from 'pixi.js';
import { tokenizeMana } from '../cards/mana';
import { cardWidth } from '../layout/geometry';
import { MANA_FONT, manaReady, msGlyph } from '../theme/manaFont';
import { fonts } from '../theme/tokens';
import { clamp01, enter } from '../util/easing';
import type { Protections, Shield, ShieldKind, WardCost } from '../director/protection';

/** Sigil colours: cool cyan for hexproof, pale silver for shroud, gold for protection, violet for ward. */
export const PROT_COLOR = { hexproof: 0x58d8ff, shroud: 0xe3e9f4, protection: 0xffc857, ward: 0xa57bff } as const;
export type FlareTone = keyof typeof PROT_COLOR;

const DISC = 0x0e1520;
const COLOR_FILL: Record<string, number> = { white: 0xf4efd8, blue: 0x5aa9e6, black: 0x6a5a78, red: 0xe5533d, green: 0x4aa86a };

/** The loop of the light travelling a hexproof / shroud card's edge. */
export const AURA_LOOP_MS = 3600;
/** How long a flare plays. */
export const FLARE_MS = { deny: 640, ward: 980 } as const;

/** A heater shield centred on (cx, cy), `s` wide each side. */
function shieldPath(g: Graphics, cx: number, cy: number, s: number): Graphics {
  return g
    .moveTo(cx - s, cy - s * 0.85)
    .lineTo(cx + s, cy - s * 0.85)
    .lineTo(cx + s, cy + s * 0.1)
    .quadraticCurveTo(cx + s, cy + s * 0.78, cx, cy + s * 1.02)
    .quadraticCurveTo(cx - s, cy + s * 0.78, cx - s, cy + s * 0.1)
    .closePath();
}

/** A regular hexagon outline centred on (cx, cy). */
function hexPath(g: Graphics, cx: number, cy: number, r: number): Graphics {
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  return g.closePath();
}

/** The ward rune (an algiz: a staff with two raised arms) centred on (cx, cy), `s` tall each side. */
function runePath(g: Graphics, cx: number, cy: number, s: number): Graphics {
  return g
    .moveTo(cx, cy + s)
    .lineTo(cx, cy - s * 0.2)
    .moveTo(cx - s * 0.7, cy - s * 0.95)
    .lineTo(cx, cy - s * 0.1)
    .lineTo(cx + s * 0.7, cy - s * 0.95);
}

/** The protected-from colour of a protection shield: one colour tints it, anything else is gold. */
export function protectionFill(shields: readonly Shield[]): number {
  const from = new Set(shields.filter((s) => s.kind === 'protection').map((s) => s.from));
  const only = from.size === 1 ? [...from][0] : null;
  return (only && COLOR_FILL[only]) || PROT_COLOR.protection;
}

/** One round chip (radius r) for a shield kind. */
function shieldChip(kind: ShieldKind, r: number, u: number, fill: number): Container {
  const c = new Container();
  const g = new Graphics().circle(0, 0, r + 1.5 * u).fill({ color: 0x050608, alpha: 0.7 }).circle(0, 0, r).fill({ color: DISC, alpha: 0.95 }).stroke({ color: PROT_COLOR[kind], width: 1.6 * u });
  if (kind === 'shroud') {
    // A slashed eye: nothing may look at (or target) it.
    const s = r * 0.62;
    g.moveTo(-s, 0).quadraticCurveTo(0, -s * 0.95, s, 0).quadraticCurveTo(0, s * 0.95, -s, 0).stroke({ color: PROT_COLOR.shroud, width: 1.5 * u, join: 'round' });
    g.circle(0, 0, s * 0.3).fill(PROT_COLOR.shroud);
    g.moveTo(-s * 0.9, s * 0.8).lineTo(s * 0.9, -s * 0.8).stroke({ color: 0x0e1520, width: 3.4 * u, cap: 'round' });
    g.moveTo(-s * 0.9, s * 0.8).lineTo(s * 0.9, -s * 0.8).stroke({ color: 0xff8a7a, width: 1.5 * u, cap: 'round' });
  } else {
    const s = r * 0.5;
    shieldPath(g, 0, -r * 0.04, s).fill({ color: kind === 'hexproof' ? PROT_COLOR.hexproof : fill, alpha: 0.95 }).stroke({ color: 0xffffff, width: 0.9 * u, alpha: 0.7 });
    if (kind === 'hexproof') hexPath(g, 0, -r * 0.1, s * 0.42).stroke({ color: DISC, width: 1.3 * u });
    else g.moveTo(-s, -s * 0.12).lineTo(s, -s * 0.12).stroke({ color: DISC, width: 1.4 * u, alpha: 0.75 });
  }
  c.addChild(g);
  c.label = kind;
  return c;
}

/** A small round "eye" badge: a hand card the opponent has been shown (e.g. Duress). Reuses shieldChip's open-eye glyph (shroud's slashed eye, unslashed) since it's the same shape with the opposite meaning. */
export function revealedEyeBadge(baseH: number): Container {
  const u = baseH / 150;
  const r = 8.5 * u;
  const c = new Container();
  const g = new Graphics().circle(0, 0, r + 1.5 * u).fill({ color: 0x050608, alpha: 0.7 }).circle(0, 0, r).fill({ color: DISC, alpha: 0.95 }).stroke({ color: PROT_COLOR.shroud, width: 1.6 * u });
  const s = r * 0.62;
  g.moveTo(-s, 0).quadraticCurveTo(0, -s * 0.95, s, 0).quadraticCurveTo(0, s * 0.95, -s, 0).stroke({ color: PROT_COLOR.shroud, width: 1.5 * u, join: 'round' });
  g.circle(0, 0, s * 0.3).fill(PROT_COLOR.shroud);
  c.addChild(g);
  c.label = 'revealed';
  return c;
}

/** Ward's cost as drawn content centred on the origin: mana glyphs, a heart and its number, or null. */
function wardCostView(cost: WardCost, font: number, u: number): Container | null {
  const c = new Container();
  if (cost.kind === 'life') {
    const h = 5.2 * u;
    const heart = new Graphics()
      .moveTo(0, h * 0.95)
      .bezierCurveTo(-h * 1.5, -h * 0.1, -h * 0.7, -h * 1.1, 0, -h * 0.35)
      .bezierCurveTo(h * 0.7, -h * 1.1, h * 1.5, -h * 0.1, 0, h * 0.95)
      .fill(0xff6b6b);
    const n = new Text({ text: `${cost.n}`, style: { fontFamily: fonts.numeral, fontWeight: '700', fontSize: font, fill: 0xf4f2ec }, resolution: 2 });
    n.anchor.set(0, 0.5);
    heart.position.set(-n.width / 2 - 1.5 * u, 0);
    n.position.set(heart.x + h * 1.2 + 2 * u, 0);
    c.addChild(heart, n);
    return c;
  }
  if (cost.kind === 'mana') {
    const toks = tokenizeMana(cost.text);
    const glyphs = manaReady() ? toks.map((t) => msGlyph(t.raw.replace('/', '')) ?? null) : [];
    const ok = glyphs.length === toks.length && glyphs.every(Boolean);
    const t = new Text({
      text: ok ? glyphs.join('') : toks.map((k) => k.raw).join(''),
      style: ok ? { fontFamily: MANA_FONT, fontSize: font * 0.95, fill: 0xf4f2ec, letterSpacing: 1.5 * u } : { fontFamily: fonts.numeral, fontWeight: '700', fontSize: font, fill: 0xf4f2ec },
      resolution: 2,
    });
    t.anchor.set(0.5);
    c.addChild(t);
    return c;
  }
  if (cost.kind === 'discard') {
    const g = new Graphics().roundRect(-3 * u, -4.4 * u, 6 * u, 8.8 * u, 1 * u).stroke({ color: 0xf4f2ec, width: 1.3 * u }).moveTo(-5 * u, 4.6 * u).lineTo(5 * u, -4.6 * u).stroke({ color: 0xff8a7a, width: 1.5 * u, cap: 'round' });
    c.addChild(g);
    return c;
  }
  return null;
}

/** The ward chip: a rune disc and, to its right, the cost. Centred on the origin. */
function wardChip(cost: WardCost, u: number): Container {
  const c = new Container();
  const r = 8.5 * u;
  const view = wardCostView(cost, 12 * u, u);
  const vw = view ? view.width : 0;
  const w = view ? 2 * r + vw + 7 * u : 2 * r;
  const g = new Graphics().roundRect(-w / 2 - 1.5 * u, -r - 1.5 * u, w + 3 * u, 2 * r + 3 * u, r + 1.5 * u).fill({ color: 0x050608, alpha: 0.7 });
  g.roundRect(-w / 2, -r, w, 2 * r, r).fill({ color: DISC, alpha: 0.95 }).stroke({ color: PROT_COLOR.ward, width: 1.6 * u });
  const rx = -w / 2 + r;
  g.circle(rx, 0, r * 0.74).fill({ color: PROT_COLOR.ward, alpha: 0.18 }).stroke({ color: PROT_COLOR.ward, width: 1 * u, alpha: 0.7 });
  runePath(g, rx, 0.5 * u, r * 0.46).stroke({ color: 0xd9c8ff, width: 1.7 * u, cap: 'round', join: 'round' });
  c.addChild(g);
  if (view) {
    view.position.set(w / 2 - 4 * u - vw / 2, 0);
    c.addChild(view);
  }
  c.label = 'ward';
  return c;
}

/** Most chips a card carries; the rest of its keywords are on its preview. */
export const MAX_CHIPS = 3;

/**
 * The chips for a card, placed down the right edge of its art (clear of the cost corner above, and of the damage and
 * P/T chips below). One chip per shield kind, then one per ward, at most {@link MAX_CHIPS}.
 */
export function protectionChips(p: Protections, baseH: number): Container[] {
  const u = baseH / 150;
  const r = 8.5 * u;
  const w = cardWidth(baseH);
  const out: Container[] = [];
  const kinds = (['hexproof', 'shroud', 'protection'] as const).filter((k) => p.shields.some((s) => s.kind === k));
  for (const k of kinds) out.push(shieldChip(k, r, u, protectionFill(p.shields)));
  for (const cost of p.wards) out.push(wardChip(cost, u));
  const shown = out.slice(0, MAX_CHIPS);
  // The art spans about -0.34h..+0.05h: three chips fit with a small gap.
  let y = -0.335 * baseH + r + 1 * u;
  for (const c of shown) {
    const half = c.width / 2;
    c.position.set(w / 2 - 4 * u - half, y);
    y += 2 * r + 2.5 * u;
  }
  for (const c of out.slice(MAX_CHIPS)) c.destroy({ children: true });
  return shown;
}

/** The colour of a card's aura: shroud outranks hexproof; null when it has neither. */
export function auraColor(p: Protections | null): number | null {
  if (!p) return null;
  if (p.shields.some((s) => s.kind === 'shroud')) return PROT_COLOR.shroud;
  if (p.shields.some((s) => s.kind === 'hexproof')) return PROT_COLOR.hexproof;
  return null;
}

/** Points of a rounded rect's edge, evenly spread by arc length, clockwise from the top-left end of its top straight. */
export function edgePoints(w: number, h: number, r: number, n: number): Array<{ x: number; y: number }> {
  const hw = w / 2;
  const hh = h / 2;
  const straightX = w - 2 * r;
  const straightY = h - 2 * r;
  const arc = (Math.PI / 2) * r;
  const total = 2 * straightX + 2 * straightY + 4 * arc;
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) out.push(edgeAt((i / n) * total, hw, hh, r, straightX, straightY, arc));
  return out;
}

/** The point at arc length s along the edge starting at the top-left end of the top straight (clockwise). */
function edgeAt(s: number, hw: number, hh: number, r: number, sx: number, sy: number, arc: number): { x: number; y: number } {
  if (s < sx) return { x: -hw + r + s, y: -hh };
  s -= sx;
  if (s < arc) {
    const a = s / r;
    return { x: hw - r + Math.sin(a) * r, y: -hh + r - Math.cos(a) * r };
  }
  s -= arc;
  if (s < sy) return { x: hw, y: -hh + r + s };
  s -= sy;
  if (s < arc) {
    const a = s / r;
    return { x: hw - r + Math.cos(a) * r, y: hh - r + Math.sin(a) * r };
  }
  s -= arc;
  if (s < sx) return { x: hw - r - s, y: hh };
  s -= sx;
  if (s < arc) {
    const a = s / r;
    return { x: -hw + r - Math.sin(a) * r, y: hh - r + Math.cos(a) * r };
  }
  s -= arc;
  if (s < sy) return { x: -hw, y: hh - r - s };
  s -= sy;
  const a = s / r;
  return { x: -hw + r - Math.cos(a) * r, y: -hh + r - Math.sin(a) * r };
}

const edgeCache = new Map<string, Array<{ x: number; y: number }>>();
const AURA_N = 72;

/**
 * The shimmer around a hexproof / shroud card: a faint steady halo on the edge, and a bright comet of light
 * circling it (a fifth of the edge long, fading toward its tail) once per {@link AURA_LOOP_MS}. `calm`
 * (reduced motion): the halo alone, a little brighter, nothing travels. Redrawn per frame into `g`.
 */
export function drawAura(g: Graphics, color: number, baseH: number, phase: number, now: number, calm: boolean): void {
  g.clear();
  const w = cardWidth(baseH);
  const u = baseH / 150;
  const d = 2.5 * u;
  const rr = (grow: number) => g.roundRect(-w / 2 - grow, -baseH / 2 - grow, w + 2 * grow, baseH + 2 * grow, w * 0.06 + grow);
  const breathe = calm ? 0.5 : 0.5 + 0.5 * Math.sin((now / AURA_LOOP_MS + phase) * Math.PI * 4);
  rr(d + 3 * u).stroke({ color, width: 6 * u, alpha: 0.08 + 0.07 * breathe });
  rr(d).stroke({ color, width: 1.6 * u, alpha: calm ? 0.55 : 0.32 + 0.2 * breathe });
  if (calm) return;
  const key = `${Math.round(w)}x${Math.round(baseH)}`;
  let pts = edgeCache.get(key);
  if (!pts) {
    const r = w * 0.06 + d;
    pts = edgePoints(w + 2 * d, baseH + 2 * d, r, AURA_N);
    edgeCache.set(key, pts);
  }
  const head = (((now / AURA_LOOP_MS + phase) % 1) + 1) % 1;
  const len = Math.round(AURA_N * 0.2);
  const h0 = Math.floor(head * AURA_N);
  for (let i = 0; i < len; i++) {
    const a = pts[(h0 - i - 1 + AURA_N * 2) % AURA_N]!;
    const b = pts[(h0 - i + AURA_N * 2) % AURA_N]!;
    const k = 1 - i / len;
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: 0xffffff, width: 3.6 * u * k + 0.6 * u, alpha: 0.18 * k * k, cap: 'round' });
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color, width: 2.4 * u * k + 0.6 * u, alpha: 0.85 * k, cap: 'round' });
  }
}

/**
 * The flare at progress p in [0, 1] (0 at the touch): a ring expanding off the card's edge and a big sigil popping over
 * it that holds a beat and fades. `deny`: a shield (a spell was turned away, or the player is hovering an illegal target);
 * `ward`: the rune. `still` (reduced motion): the sigil fades in place, no pop and no ring.
 */
export function drawFlare(g: Graphics, tone: FlareTone, kind: 'deny' | 'ward', baseH: number, p: number, still: boolean): void {
  g.clear();
  if (p <= 0 || p >= 1) return;
  const color = PROT_COLOR[tone];
  const w = cardWidth(baseH);
  const u = baseH / 150;
  const fade = p < 0.4 ? 1 : 1 - clamp01((p - 0.4) / 0.6);
  if (!still) {
    const out = enter(clamp01(p / 0.8));
    const grow = 3 * u + 16 * u * out;
    g.roundRect(-w / 2 - grow, -baseH / 2 - grow, w + 2 * grow, baseH + 2 * grow, w * 0.06 + grow).stroke({ color, width: 5 * u * (1 - out) + 1 * u, alpha: 0.9 * (1 - out) });
    g.roundRect(-w / 2, -baseH / 2, w, baseH, w * 0.06).fill({ color, alpha: 0.2 * (1 - clamp01(p / 0.5)) });
  }
  // Pop: 0.7 → 1.08 → 1 (small overshoot), the physical-landing feel.
  const q = clamp01(p / 0.3);
  const pop = still ? 1 : 0.7 + 0.38 * enter(q) - (q >= 1 ? 0.08 * clamp01((p - 0.3) / 0.2) : 0);
  const s = baseH * 0.2 * pop;
  const a = fade * (still ? 0.8 : 1);
  g.circle(0, 0, s * 1.35).fill({ color: DISC, alpha: 0.55 * a }).stroke({ color, width: 2.2 * u, alpha: a });
  if (kind === 'ward') {
    runePath(g, 0, s * 0.06, s * 0.82).stroke({ color: 0xe6d9ff, width: 3.4 * u, alpha: a, cap: 'round', join: 'round' });
    return;
  }
  if (tone === 'shroud') {
    const e = s * 0.9;
    g.moveTo(-e, 0).quadraticCurveTo(0, -e * 0.95, e, 0).quadraticCurveTo(0, e * 0.95, -e, 0).stroke({ color, width: 2.6 * u, alpha: a, join: 'round' });
    g.moveTo(-e * 0.9, e * 0.8).lineTo(e * 0.9, -e * 0.8).stroke({ color: 0xff8a7a, width: 3 * u, alpha: a, cap: 'round' });
    return;
  }
  shieldPath(g, 0, -s * 0.04, s * 0.8).fill({ color, alpha: 0.9 * a }).stroke({ color: 0xffffff, width: 1.6 * u, alpha: 0.8 * a });
  if (tone === 'hexproof') hexPath(g, 0, -s * 0.1, s * 0.34).stroke({ color: DISC, width: 2 * u, alpha: a });
  else g.moveTo(-s * 0.8, -s * 0.1).lineTo(s * 0.8, -s * 0.1).stroke({ color: DISC, width: 2.4 * u, alpha: 0.75 * a });
}
