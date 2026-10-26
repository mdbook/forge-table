/**
 * The M15 (2015-frame) card face, drawn with Canvas 2D from card data, an art crop and two fonts (title and body, fonts.ts):
 * black border, the coloured frame with its mottled outer border and legendary crown, name / type / P/T plates, the art
 * window, a text box with fitted rules and flavor text, planeswalker loyalty rows, and the bottom info line. The whole
 * frame is vector shapes, gradients and generated noise (no frame images). Layers (a P/T that's been buffed, a changed
 * cost, counters…) are meant to be drawn on top by the caller; {@link layoutFor} says where things are. What differs between
 * frames (planeswalker vs the standard one…) lives in the layout specs (`layouts.ts`), which the painters here read.
 */
import { MANA_FONT, manaReady, msGlyph } from '../../theme/manaFont';
import { fonts } from '../../theme/tokens';
import { COST_TONE, drawPip, type Ctx2D } from '../face';
import { parseSymbol, type ManaSymbol } from '../mana';
import { TITLE_FONT, BODY_FONT } from './fonts';
import { frameStyle, type FrameStyle, type RGB } from './frameStyle';
import { CROWN_SIDES, CROWN_TOP, coverRect, M15_H, M15_W, type M15Geometry, type Rect } from './geometry';
import { costPatchBox, costSlotOf, layoutFor, pipCentre, ptPlate, ptText, type M15LayoutSpec, type Radii } from './layouts';
import { landWatermark, parseTypes, printedRules, rarityLetter, type M15Card, type M15Rarity } from './model';
import { mottleTile } from './noise';
import { fitBlock, layoutPw, loyaltyKind, parsePwAbilities, parseRuns, type Measure, type Run } from './textLayout';

export interface M15Options {
  /** Canvas size in px the card is drawn at (the design grid scales to it). */
  width: number;
  height: number;
  /** The art crop (Scryfall's art_crop); a quiet placeholder panel when absent. */
  art?: CanvasImageSource | null;
  /** The art's pixel size (a bitmap/canvas/img knows it; pass it for other sources). */
  artSize?: { w: number; h: number };
  /** Draw the foil stamp on rares and mythics (default true). */
  stamp?: boolean;
  /** Overrides of the rules text fit (RULES_FIT): an ability card sets its text bigger. */
  rulesFit?: Partial<typeof RULES_FIT>;
  /** Set the rules text from the top of the box instead of centring it (an ability card's few lines). */
  rulesTop?: boolean;
}

// ------------------------------------------------------------------------------------------ colour helpers

const css = (c: RGB, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
const mixc = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const BLACK: RGB = [10, 8, 8];

function hgrad(ctx: Ctx2D, r: Rect, left: RGB, right: RGB, from = 0.42, to = 0.58): CanvasGradient | string {
  if (left[0] === right[0] && left[1] === right[1] && left[2] === right[2]) return css(left);
  const g = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
  g.addColorStop(0, css(left));
  g.addColorStop(from, css(left));
  g.addColorStop(to, css(right));
  g.addColorStop(1, css(right));
  return g;
}

function rrect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number | [number, number, number, number]) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function mottle(ctx: Ctx2D, kind: 'strip' | 'paper' | 'plate', area: Rect, alpha: number, scale = 1) {
  const tile = mottleTile(kind);
  if (!tile) return;
  const pat = ctx.createPattern(tile, 'repeat');
  if (!pat) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.w, area.h);
  ctx.clip();
  ctx.globalAlpha = alpha;
  ctx.scale(scale, scale);
  ctx.fillStyle = pat;
  ctx.fillRect(area.x / scale, area.y / scale, area.w / scale, area.h / scale);
  ctx.restore();
}

// ------------------------------------------------------------------------------------------ shapes

/** A plate's outline: a rectangle whose short ends bulge outward in an arc (`bulge` px), with small square-ish corners. */
function platePath(ctx: Ctx2D, x: number, y: number, w: number, h: number, bulge: number) {
  ctx.beginPath();
  ctx.moveTo(x + bulge, y);
  ctx.lineTo(x + w - bulge, y);
  ctx.quadraticCurveTo(x + w + bulge, y + h / 2, x + w - bulge, y + h);
  ctx.lineTo(x + bulge, y + h);
  ctx.quadraticCurveTo(x - bulge, y + h / 2, x + bulge, y);
  ctx.closePath();
}

/** A name/type/P/T plate: black keyline, light bevelled body (highlight on top, a grey shadow lip below). */
function plate(ctx: Ctx2D, r: Rect, fill: RGB, bulge: number) {
  platePath(ctx, r.x, r.y, r.w, r.h, bulge);
  ctx.fillStyle = css(BLACK);
  ctx.fill();
  const k = 2;
  const ix = r.x + k;
  const iy = r.y + k;
  const iw = r.w - 2 * k;
  const ih = r.h - 2 * k;
  platePath(ctx, ix, iy, iw, ih, bulge - 1);
  const g = ctx.createLinearGradient(0, iy, 0, iy + ih);
  g.addColorStop(0, css(mixc(fill, [255, 255, 255], 0.42)));
  g.addColorStop(0.18, css(mixc(fill, [255, 255, 255], 0.04)));
  g.addColorStop(0.7, css(fill));
  g.addColorStop(1, css(mixc(fill, [0, 0, 0], 0.08)));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  ctx.clip();
  mottle(ctx, 'plate', { x: ix, y: iy, w: iw, h: ih }, 0.16);
  // The bevel: a grey lip along the bottom and shaded ends.
  ctx.fillStyle = css(mixc(fill, [40, 34, 32], 0.55), 0.85);
  ctx.fillRect(ix - bulge, iy + ih - 9, iw + 2 * bulge, 9);
  ctx.fillStyle = css(mixc(fill, [255, 255, 255], 0.4), 0.9);
  ctx.fillRect(ix - bulge, iy + ih - 9, iw + 2 * bulge, 1.5);
  // The ends' shading (not the top edge, which is a plain keyline).
  ctx.beginPath();
  ctx.rect(ix - bulge - 4, iy + 5, iw + 2 * bulge + 8, ih);
  ctx.clip();
  ctx.lineWidth = 7;
  ctx.strokeStyle = 'rgba(40,34,32,0.34)';
  platePath(ctx, ix, iy, iw, ih, bulge - 1);
  ctx.stroke();
  ctx.restore();
}

/** The frame colour that wraps a plate's bulging ends (the plate pushes out into the border there). */
function plateRing(ctx: Ctx2D, r: Rect, s: FrameStyle, bulge: number) {
  platePath(ctx, r.x - 6, r.y - 1.5, r.w + 12, r.h + 3, bulge + 6);
  ctx.fillStyle = hgrad(ctx, { x: 44, y: 0, w: 584, h: 1 }, s.pin[0], s.pin[1], 0.45, 0.55);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(8,6,6,0.85)';
  ctx.stroke();
}

// ------------------------------------------------------------------------------------------ mana pips

/** The flat disc colours of the printed symbols (sampled off the scans; mana-font's own CSS is a shade darker). */
const DISC: Record<string, string> = {
  W: '#fbf8dd',
  U: '#c0e5fb',
  B: '#c5bcb9',
  R: '#f1b8a6',
  G: '#b6d8c1',
  C: '#d3cfce',
  generic: '#d3cfce',
  tap: '#c9c4bd',
  snow: '#d3cfce',
};
const GLYPH_INK = '#0d0c0a';

/** Draw one Mana-font glyph optically centred (by its own ink box) on (cx, cy) at font size `size`. */
function glyphAt(ctx: Ctx2D, g: string, cx: number, cy: number, size: number, color: string, stroke = 0) {
  ctx.save();
  ctx.font = `${size}px ${MANA_FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText(g);
  const x = cx - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
  const y = cy + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  ctx.fillStyle = color;
  if (stroke > 0) {
    ctx.strokeStyle = color;
    ctx.lineWidth = stroke;
    ctx.lineJoin = 'round';
    ctx.strokeText(g, x, y);
  }
  ctx.fillText(g, x, y);
  ctx.restore();
}

/** The hard-edged drop shadow of a printed symbol: a black disc nudged down and left, plus one straight below. */
function pipShadow(ctx: Ctx2D, cx: number, cy: number, d: number) {
  const r = d / 2;
  ctx.fillStyle = '#0d0b0b';
  ctx.beginPath();
  ctx.arc(cx - d * 0.05, cy + d * 0.07, r, 0, Math.PI * 2);
  ctx.arc(cx, cy + d * 0.06, r, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * A mana / tap symbol as printed: a flat coloured disc with a black Mana-font glyph and a hard drop shadow. Hybrids split
 * the disc on the diagonal with a small glyph in each half; Phyrexian ones are the colour's disc with the phi glyph. `d`
 * = disc diameter. Until the Mana font has loaded (or for a symbol it lacks) the shared pip painter stands in.
 */
export function drawM15Pip(ctx: Ctx2D, raw: string, cx: number, cy: number, d: number, shadow = true): void {
  const sym: ManaSymbol = parseSymbol(raw);
  const gl = (n: string) => (manaReady() ? msGlyph(n) : null);
  const r = d / 2;
  const disc = (fill: string | [string, string]) => {
    if (shadow) pipShadow(ctx, cx, cy, d);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (typeof fill === 'string') {
      ctx.fillStyle = fill;
      ctx.fill();
    } else {
      ctx.clip();
      ctx.fillStyle = fill[0];
      ctx.fillRect(cx - r, cy - r, d, d);
      // The split runs from bottom-left to top-right: the second colour fills the lower-right half.
      ctx.fillStyle = fill[1];
      ctx.beginPath();
      ctx.moveTo(cx + r, cy - r);
      ctx.lineTo(cx + r, cy + r);
      ctx.lineTo(cx - r, cy + r);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  };
  const big = (n: string, color = GLYPH_INK, k = 0.74) => {
    const g = gl(n);
    if (g) glyphAt(ctx, g, cx, cy, d * k, color);
  };
  const pair = (a: string, b: string) => {
    const ga = gl(a);
    const gb = gl(b);
    if (ga) glyphAt(ctx, ga, cx - d * 0.2, cy - d * 0.2, d * 0.42, GLYPH_INK);
    if (gb) glyphAt(ctx, gb, cx + d * 0.2, cy + d * 0.2, d * 0.42, GLYPH_INK);
  };
  const need = (...names: string[]) => names.every((n) => gl(n) !== null);
  switch (sym.kind) {
    case 'color':
      if (!need(sym.color.toLowerCase())) break;
      disc(DISC[sym.color]!);
      big(sym.color.toLowerCase(), GLYPH_INK, sym.color === 'W' ? 0.82 : 0.78);
      return;
    case 'colorless':
      if (!need('c')) break;
      disc(DISC.C!);
      big('c');
      return;
    case 'generic':
    case 'variable':
      if (!need(sym.value.toLowerCase())) break;
      disc(DISC.generic!);
      big(sym.value.toLowerCase(), GLYPH_INK, 0.8);
      return;
    case 'tap':
      if (!need('tap')) break;
      disc(DISC.tap!);
      big('tap', GLYPH_INK, 0.82);
      return;
    case 'untap':
      if (!need('untap')) break;
      disc('#0d0b0b');
      big('untap', '#f4f2ee', 0.7);
      return;
    case 'snow':
      if (!need('s')) break;
      disc(DISC.snow!);
      {
        const g = gl('s')!;
        glyphAt(ctx, g, cx, cy, d * 0.84, '#2c2a2a');
        glyphAt(ctx, g, cx, cy, d * 0.6, '#ffffff', d * 0.05);
      }
      return;
    case 'energy':
      if (!need('e')) break;
      glyphAt(ctx, gl('e')!, cx, cy, d * 0.9, GLYPH_INK);
      return;
    case 'hybrid': {
      const [a, b] = sym.colors;
      const na = a.toLowerCase();
      const nb = b.toLowerCase();
      if (!need(na, nb)) break;
      disc([DISC[a]!, DISC[b]!]);
      pair(na, nb);
      return;
    }
    case 'monoHybrid': {
      const n = sym.generic.toLowerCase();
      const c = sym.color.toLowerCase();
      if (!need(n, c)) break;
      disc([DISC.generic!, DISC[sym.color]!]);
      pair(n, c);
      return;
    }
    case 'phyrexian': {
      if (!need('p')) break;
      if (sym.colors.length === 2) {
        disc([DISC[sym.colors[0]!]!, DISC[sym.colors[1]!]!]);
        pair('p', 'p');
      } else {
        disc(sym.colors.length === 1 ? DISC[sym.colors[0]!]! : DISC.generic!);
        big('p', GLYPH_INK, 0.82);
      }
      return;
    }
    default:
  }
  // Half mana, unknown symbols, and everything before the Mana font has loaded.
  drawPip(ctx, sym, cx, cy, d / 2);
}

// ------------------------------------------------------------------------------------------ text

const INK = '#0b0a09';

function fit(ctx: Ctx2D, text: string, font: (size: number) => string, size: number, min: number, maxW: number): number {
  let s = size;
  ctx.font = font(s);
  while (ctx.measureText(text).width > maxW && s > min) {
    s -= 0.5;
    ctx.font = font(s);
  }
  return s;
}

/**
 * MPlantin Italic is ~7% narrower than the roman the browser slants for us (measured off the scans' flavor text), so
 * italic runs are set at this horizontal scale (kept for the bundled Splentinex, whose roman is slanted the same way).
 */
const ITALIC_W = 0.93;

function canvasMeasure(ctx: Ctx2D): Measure {
  return {
    text(text, italic, size) {
      ctx.font = `${italic ? 'italic ' : ''}${size}px "${BODY_FONT}", Georgia, serif`;
      return ctx.measureText(text).width * (italic ? ITALIC_W : 1);
    },
    sym(_raw, size) {
      return size * 0.86;
    },
  };
}

/** Paint laid-out lines of runs with their pips, left edge `x`, line box top `y`. */
function paintLines(ctx: Ctx2D, lines: ReadonlyArray<{ items: ReadonlyArray<{ run: Run; x: number; w: number }>; y: number; size?: number; h?: number }>, x: number, y: number, baseSize: number, lineH: number) {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (const l of lines) {
    const size = l.size ?? baseSize;
    const base = y + l.y + (l.h ?? lineH) / 2 + size * 0.3;
    for (const it of l.items) {
      if (it.run.kind === 'sym') {
        const d = size * 0.74;
        drawM15Pip(ctx, it.run.raw, x + it.x + it.w / 2, base - size * 0.3, d, true);
      } else {
        ctx.fillStyle = INK;
        ctx.font = `${it.run.italic ? 'italic ' : ''}${size}px "${BODY_FONT}", Georgia, serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        if (it.run.italic) {
          ctx.save();
          ctx.translate(x + it.x, base);
          ctx.scale(ITALIC_W, 1);
          ctx.fillText(it.run.text, 0, 0);
          ctx.restore();
        } else ctx.fillText(it.run.text, x + it.x, base);
      }
    }
  }
}

// ------------------------------------------------------------------------------------------ face

/**
 * Rules-text sizing, as printed: one size for rules and flavor together, the largest (33.5 px at the 672-wide scan, stepping
 * down by half a pixel) at which they fit the box; line pitch 18.2 px + 0.45 em (33.3 px at 33.5), a fixed ~10.5 px
 * gap between abilities and a ~28 px one before the flavor text (all measured off the scans). Retuned against the real
 * MPlantin (r29: a full "Lightning Bolt deals 3 damage to any" line is 544 px on the scan = 16.26 em, so 33.5 px; the
 * earlier constants had been fitted with the fallback serif); the bundled Splentinex sets about 2% narrower, so text that
 * fit still fits. (Flavor text at the rules' size: scaling it down fixed Lightning Bolt's flavor and broke Llanowar
 * Elves', whose scan sets its flavor larger.)
 */
export const RULES_FIT = { max: 33.5, min: 14, step: 0.5, lineBase: 18.2, lineRatio: 0.45, paraGap: 10.5, flavorGap: 28 };

/** Text room kept clear in the box, top and bottom together (the scans' fitted blocks all land within ~245 of 276 px). */
const RULES_FIT_MARGIN = 31;

/** Paint the card face filling a `width`×`height` canvas (the corners left transparent). */
export function paintM15Face(ctx: Ctx2D, card: M15Card, opts: M15Options): void {
  const style = frameStyle(card);
  const types = parseTypes(card.typeLine);
  const layout = layoutFor(card);
  const { geo } = layout;
  const crown = types.legendary && layout.frame.crown;
  ctx.save();
  ctx.clearRect(0, 0, opts.width, opts.height);
  ctx.scale(opts.width / M15_W, opts.height / M15_H);

  // The card: a black border with rounded corners.
  rrect(ctx, 0, 0, M15_W, M15_H, 34);
  ctx.fillStyle = '#120c0c';
  ctx.fill();

  paintFrame(ctx, style, layout, crown);
  paintArt(ctx, geo.art, style, opts, layout.artRadii);

  const rarity = card.rarity;
  // Plates, each ringed in the frame colour where its rounded ends push into the border.
  if (!crown) plateRing(ctx, geo.name, style, 8);
  plateRing(ctx, geo.type, style, 8);
  plate(ctx, geo.name, style.plate, 8);
  plate(ctx, geo.type, style.plate, 8);

  if (showsBox(card, layout)) paintBox(ctx, card, style, layout, opts);
  paintNameLine(ctx, card, geo, rarity, layout.nameDy);
  STATS[layout.stats](ctx, card, style, geo);
  paintInfoLine(ctx, card);
  if ((rarity === 'rare' || rarity === 'mythic') && opts.stamp !== false) paintStamp(ctx, layout.stampY);
  ctx.restore();
}

function paintFrame(ctx: Ctx2D, s: FrameStyle, layout: M15LayoutSpec, crown: boolean) {
  const { border, borderTint, inner: inn } = layout.frame;
  const left = s.pin[0];
  const right = s.pin[1];
  const whole: Rect = { x: 0, y: 0, w: M15_W, h: M15_H };
  // The mottled outer border.
  const stripTop = crown ? 116 : 27;
  const stripFill = borderTint ? mixc(s.strip, borderTint.to, borderTint.t) : s.strip;
  ctx.beginPath();
  ctx.moveTo(27, stripTop);
  if (!crown) {
    ctx.lineTo(27, 41);
    ctx.quadraticCurveTo(27, 27, 41, 27);
    ctx.lineTo(631, 27);
    ctx.quadraticCurveTo(645, 27, 645, 41);
  } else ctx.lineTo(645, stripTop);
  for (const [op, ...p] of border) {
    if (op === 'L') ctx.lineTo(p[0]!, p[1]!);
    else ctx.quadraticCurveTo(p[0]!, p[1]!, p[2]!, p[3]!);
  }
  ctx.closePath();
  ctx.save();
  ctx.fillStyle = css(stripFill);
  ctx.fill();
  ctx.clip();
  const lum = (stripFill[0] + stripFill[1] + stripFill[2]) / 765;
  mottle(ctx, 'strip', whole, 0.06 + 0.12 * (1 - lum));
  const sh = ctx.createLinearGradient(0, 27, 0, 868);
  sh.addColorStop(0, 'rgba(255,255,255,0.1)');
  sh.addColorStop(0.5, 'rgba(0,0,0,0)');
  sh.addColorStop(1, 'rgba(0,0,0,0.16)');
  ctx.fillStyle = sh;
  ctx.fillRect(0, 0, M15_W, M15_H);
  ctx.restore();

  // The inner frame: the saturated colour around the art and plates.
  const iy = crown ? inn.crownTop : inn.top;
  const inner: Rect = { x: inn.x, y: iy, w: inn.w, h: inn.bottom - iy };
  ctx.save();
  // The inner frame stands proud of the border: a soft dark shadow falls on the strip beside it.
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 6;
  rrect(ctx, inner.x, inner.y, inner.w, inner.h, inn.radii);
  ctx.fillStyle = hgrad(ctx, inner, left, right, 0.45, 0.55);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = 'rgba(8,6,6,0.9)';
  ctx.stroke();
  ctx.restore();

  if (crown) {
    ctx.save();
    ctx.beginPath();
    CROWN_TOP.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    for (const [x, y] of CROWN_SIDES.right) ctx.lineTo(x, y);
    for (const [x, y] of CROWN_SIDES.left) ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fillStyle = hgrad(ctx, { x: 20, y: 0, w: 632, h: 1 }, left, right, 0.45, 0.55);
    ctx.fill();
    ctx.clip();
    mottle(ctx, 'paper', whole, 0.22);
    ctx.restore();
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.beginPath();
    CROWN_TOP.forEach(([x, y], i) => (i ? ctx.lineTo(x, y + 1) : ctx.moveTo(x, y + 1)));
    ctx.stroke();
    ctx.restore();
  }
}

function paintArt(ctx: Ctx2D, art: Rect, s: FrameStyle, opts: M15Options, rad: Radii) {
  // The keyline around the art window.
  rrect(ctx, art.x - 3, art.y - 3, art.w + 6, art.h + 6, rad.map((r) => r + 3) as Radii);
  ctx.fillStyle = css(BLACK);
  ctx.fill();
  ctx.save();
  rrect(ctx, art.x, art.y, art.w, art.h, rad);
  ctx.clip();
  const src = opts.art;
  const sz = opts.artSize ?? (src && 'width' in src ? { w: Number(src.width), h: Number(src.height) } : null);
  if (src && sz && sz.w > 0 && sz.h > 0) {
    const c = coverRect(sz.w, sz.h, art.w, art.h);
    ctx.drawImage(src, c.x, c.y, c.w, c.h, art.x, art.y, art.w, art.h);
  } else {
    const g = ctx.createLinearGradient(art.x, art.y, art.x + art.w, art.y + art.h);
    g.addColorStop(0, css(mixc(s.pin[0], [30, 30, 34], 0.6)));
    g.addColorStop(1, css(mixc(s.pin[1], [14, 14, 16], 0.78)));
    ctx.fillStyle = g;
    ctx.fillRect(art.x, art.y, art.w, art.h);
  }
  ctx.restore();
}

/** The symbols of a cost text: "{2}{U/B}" is ["2", "U/B"]. */
export function costPips(cost: string | undefined): string[] {
  return [...(cost ?? '').matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!);
}

/** A blank canvas of `w`×`h` px for a layer painted aside (null where there are no canvases at all: a node test). */
function scratchCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas | null {
  const [cw, ch] = [Math.max(1, w), Math.max(1, h)];
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(cw, ch);
  if (typeof document !== 'undefined') return Object.assign(document.createElement('canvas'), { width: cw, height: ch });
  return null;
}

/** What a changed cost is painted over (see {@link paintM15CostPatch}). */
export interface M15CostPatch {
  /** The cost now ("{2}{U}"). */
  cost: string;
  /** The tone: down (cheaper, green), up (dearer, red), same (as much mana in other symbols, amber). */
  tone: keyof typeof COST_TONE;
}

/**
 * A card's changed mana cost on the name plate, in design units (the caller scales and translates the canvas): `plate`
 * redraws the name plate inside the cost's box (so the printed pips vanish into it, its left edge feathered away), `pips`
 * the new cost over a halo and a ring in the tone's colour. `both` paints the two. `card.manaCost` is the printed cost
 * on the face under the patch, which covers the longer of the two.
 */
export function paintM15CostPatch(ctx: Ctx2D, card: M15Card, patch: M15CostPatch, layer: 'plate' | 'pips' | 'both' = 'both'): void {
  const layout = layoutFor(card);
  const style = frameStyle(card);
  const slot = costSlotOf(layout);
  const pips = costPips(patch.cost);
  ctx.save();
  if (layer !== 'pips') {
    const b = costPatchBox(layout, costPips(card.manaCost).length, pips.length);
    // The plate is painted on a layer of its own and faded there: fading it in place would fade the face under it too
    // (the preview paints the patch straight onto the face's canvas).
    const k = ctx.getTransform();
    const layer = scratchCanvas(Math.ceil(b.w * k.a), Math.ceil(b.h * k.d));
    const lctx = layer?.getContext('2d') as Ctx2D | null | undefined;
    if (layer && lctx) {
      lctx.scale(k.a, k.d);
      lctx.translate(-b.x, -b.y);
      plate(lctx, layout.geo.name, style.plate, 8);
      // Fade the left end out (a longer cost slides over the name softly).
      const g = lctx.createLinearGradient(b.x, 0, b.x + b.feather, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,1)');
      lctx.globalCompositeOperation = 'destination-in';
      lctx.fillStyle = g;
      lctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.drawImage(layer, b.x, b.y, b.w, b.h);
    }
  }
  if (layer !== 'plate') {
    const tone = COST_TONE[patch.tone];
    const r = slot.d / 2;
    pips.forEach((_, i) => {
      const { x } = pipCentre(slot, i, pips.length);
      const halo = ctx.createRadialGradient(x, slot.cy, r, x, slot.cy, r * 1.8);
      halo.addColorStop(0, css(tone, 0.7));
      halo.addColorStop(1, css(tone, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, slot.cy, r * 1.8, 0, Math.PI * 2);
      ctx.fill();
    });
    pips.forEach((_, i) => {
      const { x } = pipCentre(slot, i, pips.length);
      ctx.beginPath();
      ctx.arc(x, slot.cy, r * 1.1, 0, Math.PI * 2);
      ctx.lineWidth = r * 0.42;
      ctx.strokeStyle = 'rgba(10,12,16,0.6)';
      ctx.stroke();
      ctx.lineWidth = r * 0.22;
      ctx.strokeStyle = css(tone);
      ctx.stroke();
    });
    pips.forEach((p, i) => drawM15Pip(ctx, p, pipCentre(slot, i, pips.length).x, slot.cy, slot.d));
  }
  ctx.restore();
}

function paintNameLine(ctx: Ctx2D, card: M15Card, geo: M15Geometry, rarity: M15Rarity, dy: number) {
  const { name, type } = geo;
  // Cost, right-aligned inside the name plate.
  const pips = costPips(card.manaCost);
  const slot = costSlotOf({ geo, nameDy: dy });
  pips.forEach((p, i) => drawM15Pip(ctx, p, pipCentre(slot, i, pips.length).x, slot.cy, slot.d));
  const costW = pips.length ? pips.length * slot.pitch : 0;
  const nameFont = (s: number) => `${s}px "${TITLE_FONT}", "Palatino Linotype", serif`;
  const maxW = name.w - 36 - costW - 12;
  const ns = fit(ctx, card.name, nameFont, 35.2, 18, maxW);
  ctx.font = nameFont(ns);
  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(card.name, name.x + 18, name.y + name.h / 2 + ns * 0.33 + dy);

  // Set symbol: a placeholder in the rarity's colour.
  const sx = type.x + type.w - 30;
  const sy = type.y + type.h / 2;
  const typeFont = (s: number) => `${s}px "${TITLE_FONT}", "Palatino Linotype", serif`;
  const ts = fit(ctx, card.typeLine, typeFont, 30, 16, sx - 20 - (type.x + 18));
  ctx.font = typeFont(ts);
  ctx.fillStyle = INK;
  ctx.fillText(card.typeLine, type.x + 18, type.y + type.h / 2 + ts * 0.33 - 2.5);
  setSymbol(ctx, sx, sy, 31, rarity);
}

/** Set-symbol fills by rarity, top to bottom (common is plain black). */
const RARITY_COLOR: Record<string, [RGB, RGB, RGB]> = {
  common: [[16, 14, 14], [16, 14, 14], [16, 14, 14]],
  uncommon: [[240, 246, 249], [168, 184, 194], [120, 138, 150]],
  rare: [[252, 238, 160], [214, 170, 62], [150, 104, 24]],
  mythic: [[255, 190, 120], [236, 96, 44], [176, 40, 16]],
  special: [[226, 196, 252], [150, 96, 210], [88, 44, 150]],
  bonus: [[255, 190, 120], [236, 96, 44], [176, 40, 16]],
  '': [[16, 14, 14], [16, 14, 14], [16, 14, 14]],
};

/**
 * Forge's own mark (the hammer over an anvil of its app icon, redrawn as a vector silhouette in the icon's 1600-unit
 * grid, bounding box x 570–1095, y 540–1052) stands in for the set symbol.
 */
const FORGE_MARK =
  'M570 588h8v50h-8z M590 588h8v50h-8z M612 588h8v50h-8z M638 590h250v44H638z ' +
  'M905 540h80l10 22v50l-10 22v48H905z ' +
  'M500 750L655 752L690 703H1090V745L1058 758C1005 818 925 890 928 955C931 992 960 1010 1003 1012L1007 1052H613L616 1016L862 1000C800 996 730 996 690 994C728 962 740 925 735 903L716 898C640 886 535 840 500 750Z';
let forgeMark: Path2D | null = null;

/** The set symbol: the Forge mark, centred on (cx, cy) about `size` px across, tinted by rarity as set symbols are. */
function setSymbol(ctx: Ctx2D, cx: number, cy: number, size: number, rarity: M15Rarity) {
  forgeMark ??= new Path2D(FORGE_MARK);
  const [hi, mid, lo] = RARITY_COLOR[rarity]!;
  const k = size / 525;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(k, k);
  ctx.translate(-832, -796);
  ctx.lineJoin = 'round';
  const plain = rarity === 'common' || rarity === '';
  // Printed symbols are outlined: a light halo round the black common one, a dark keyline round the tinted ones.
  ctx.strokeStyle = plain ? 'rgba(250,248,244,0.92)' : 'rgba(10,8,8,0.95)';
  ctx.lineWidth = (plain ? 3.2 : 2.6) / k;
  ctx.stroke(forgeMark);
  const g = ctx.createLinearGradient(0, 540, 0, 1052);
  g.addColorStop(0, css(hi));
  g.addColorStop(0.5, css(mid));
  g.addColorStop(1, css(lo));
  ctx.fillStyle = g;
  ctx.fill(forgeMark);
  ctx.restore();
}

/** What a text-box painter lays out for a card: what goes on the paper beneath the top shading, and the text over it. */
interface BoxPiece {
  underlay(): void;
  text(): void;
}

/** The text-box painters a layout can name (`box`). */
const BOX: Record<M15LayoutSpec['box'], (ctx: Ctx2D, card: M15Card, b: Rect, opts: M15Options, m: Measure) => BoxPiece> = {
  rules: rulesBox,
  loyalty: loyaltyBox,
};

/**
 * Whether {@link paintM15Face} paints the box at all: always, unless the layout marks it optional (a token's)
 * and the card has neither rules nor flavor text to put in it. A vanilla token's art runs clear through there instead.
 */
export function showsBox(card: Pick<M15Card, 'rules' | 'typeLine' | 'flavor'>, layout: Pick<M15LayoutSpec, 'boxOptional'>): boolean {
  return !layout.boxOptional || parseRuns(printedRules(card)).length > 0 || parseRuns(card.flavor, true).length > 0;
}

function paintBox(ctx: Ctx2D, card: M15Card, s: FrameStyle, layout: M15LayoutSpec, opts: M15Options) {
  const b = layout.geo.box;
  // The keyline and the paper.
  const brad = layout.boxRadii;
  rrect(ctx, b.x - 1.5, b.y - 1.5, b.w + 3, b.h + 3, brad.map((r) => r + 1.5) as Radii);
  ctx.fillStyle = css(BLACK);
  ctx.fill();
  ctx.save();
  rrect(ctx, b.x, b.y, b.w, b.h, brad);
  ctx.clip();
  ctx.fillStyle = hgrad(ctx, b, s.tbox[0], s.tbox[1], 0.36, 0.66);
  ctx.fillRect(b.x, b.y, b.w, b.h);
  mottle(ctx, 'paper', b, 0.07);
  const piece = BOX[layout.box](ctx, card, b, opts, canvasMeasure(ctx));
  piece.underlay();
  const top = ctx.createLinearGradient(0, b.y, 0, b.y + 8);
  top.addColorStop(0, 'rgba(60,50,45,0.45)');
  top.addColorStop(1, 'rgba(60,50,45,0)');
  ctx.fillStyle = top;
  ctx.fillRect(b.x, b.y, b.w, 8);
  ctx.restore();
  piece.text();
}

/** The standard box: a basic land's watermark under the fitted rules and flavor text. */
function rulesBox(ctx: Ctx2D, card: M15Card, b: Rect, opts: M15Options, m: Measure): BoxPiece {
  return {
    underlay: () => paintLandWatermark(ctx, card, b),
    text() {
      const rules = parseRuns(printedRules(card));
      const flavor = parseRuns(card.flavor, true);
      if (rules.length === 0 && flavor.length === 0) return;
      const padX = 10;
      const width = b.w - 2 * padX;
      const block = fitBlock(rules, flavor, m, width, b.h - RULES_FIT_MARGIN, opts.rulesFit ? { ...RULES_FIT, ...opts.rulesFit } : RULES_FIT);
      // Top-set = where a box-filling block would start.
      const top0 = b.y + (opts.rulesTop ? RULES_FIT_MARGIN / 2 : (b.h - block.height) / 2) - 4.5;
      paintLines(ctx, block.lines, b.x + padX, top0, block.size, block.lineH);
      if (block.divider !== null) {
        const y = top0 + block.divider;
        const g = ctx.createLinearGradient(b.x + padX, 0, b.x + b.w - padX, 0);
        g.addColorStop(0, 'rgba(60,50,45,0)');
        g.addColorStop(0.15, 'rgba(60,50,45,0.35)');
        g.addColorStop(0.85, 'rgba(60,50,45,0.35)');
        g.addColorStop(1, 'rgba(60,50,45,0)');
        ctx.fillStyle = g;
        ctx.fillRect(b.x + padX, y - 0.75, width, 1.5);
      }
    },
  };
}

/** The planeswalker box: the art carried on behind one panel per loyalty ability, each with its badge. */
function loyaltyBox(ctx: Ctx2D, card: M15Card, b: Rect, opts: M15Options, m: Measure): BoxPiece {
  const blk = pwBlock(card, b, m);
  return { underlay: () => paintPwBackdrop(ctx, b, opts, blk.rows), text: () => paintPwRows(ctx, b, blk) };
}

type PwBlock = ReturnType<typeof layoutPw>;

const PW_TEXT_X = 123;

function pwBlock(card: M15Card, b: Rect, m: Measure): PwBlock {
  const width = b.x + b.w - 8 - PW_TEXT_X;
  return layoutPw(parsePwAbilities(card.rules), m, width, b.h, { max: 27, min: 14, minRow: 72, rowPad: 4, lineRatio: 0.91, spareToLast: true });
}

/** The ragged (torn-paper) y of the seam between panel k-1 and k at x: the same function both panels use, so they tile. */
function seamY(y: number, k: number, x: number): number {
  return y + 2.2 * (0.6 * Math.sin(x * 0.085 + k * 1.7) + 0.4 * Math.sin(x * 0.27 + k * 4.1));
}

/**
 * A planeswalker's box: the art carries on behind the abilities (the bottom of the art window, lightly softened), under
 * one semi-transparent light panel per ability, alternating a milky shade (1st, 3rd…) with a thin one (2nd, 4th…) that lets
 * the art show; the seams between panels are ragged.
 */
function paintPwBackdrop(ctx: Ctx2D, b: Rect, opts: M15Options, rows: PwBlock['rows']) {
  const src = opts.art;
  const sz = opts.artSize ?? (src && 'width' in src ? { w: Number(src.width), h: Number(src.height) } : null);
  if (src && sz && sz.w > 0 && sz.h > 0) {
    // The art's lower 45%, stretched over the box.
    const sh = sz.h * 0.45;
    const cw = Math.min(sz.w, (sh * b.w) / b.h);
    ctx.save();
    if ('filter' in ctx) (ctx as CanvasRenderingContext2D).filter = 'blur(3px) saturate(0.6) brightness(1.2)';
    ctx.globalAlpha = 0.5;
    ctx.drawImage(src, (sz.w - cw) / 2, sz.h - sh, cw, sh, b.x - 4, b.y - 4, b.w + 8, b.h + 8);
    ctx.restore();
  }
  const n = rows.length;
  rows.forEach((row, i) => {
    const top = b.y + row.y;
    const bot = top + row.h;
    ctx.beginPath();
    for (let x = b.x; x <= b.x + b.w + 6; x += 6) {
      const y = i === 0 ? top : seamY(top, i, x);
      if (x === b.x) ctx.moveTo(x, y);
      else ctx.lineTo(Math.min(x, b.x + b.w), y);
    }
    for (let x = b.x + b.w + 6; x >= b.x; x -= 6) ctx.lineTo(Math.min(x, b.x + b.w), i === n - 1 ? b.y + b.h : seamY(bot, i + 1, x));
    ctx.closePath();
    ctx.fillStyle = i % 2 === 0 ? 'rgba(240,236,242,0.64)' : 'rgba(246,240,240,0.34)';
    ctx.fill();
  });
  // Any box left below the last row stays a milky film.
  const last = rows[n - 1];
  if (last && last.y + last.h < b.h - 1) {
    ctx.fillStyle = 'rgba(250,244,242,0.66)';
    ctx.fillRect(b.x, b.y + last.y + last.h, b.w, b.h - last.y - last.h);
  }
}

function paintPwRows(ctx: Ctx2D, b: Rect, blk: PwBlock) {
  const textX = PW_TEXT_X;
  blk.rows.forEach((row) => {
    const textH = row.lines.length * blk.lineH;
    const ty = b.y + row.y + (row.h - textH) / 2;
    const lines = row.lines.map((l, k) => ({ ...l, y: k * blk.lineH }));
    paintLines(ctx, lines, textX, ty, blk.size, blk.lineH);
    if (row.ability.cost) {
      const dotsY = loyaltyShield(ctx, 70, ty + blk.lineH / 2, row.ability.cost, row.lines.length);
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.arc(113, dotsY - 6.3, 2.3, 0, Math.PI * 2);
      ctx.moveTo(115.3, dotsY + 6.3);
      ctx.arc(113, dotsY + 6.3, 2.3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

/** An ability badge's outline numbers (local px, origin = the middle of the whole −N badge, y down): see `badgePath`. */
interface BadgeShape {
  /** Half-widths at the top corners, at the waist (narrowest) and at the shoulders above the chevron. */
  tw: number;
  mw: number;
  bw: number;
  /** y of the flat top edge, of the waist, of the shoulders, and of the chevron's tip. */
  top: number;
  waist: number;
  shoulder: number;
  tip: number;
}
// Measured off the 672-wide scan (Chandra, refs/07): the rim is ~5 px at the waist, ~4 px top, ~8 px in the corner points.
const BADGE_RIM: BadgeShape = { tw: 36.7, mw: 30.8, bw: 33.5, top: -24.7, waist: -8, shoulder: 8, tip: 24.7 };
const BADGE_BODY: BadgeShape = { tw: 28.5, mw: 25.8, bw: 27, top: -19.6, waist: -7, shoulder: 5.5, tip: 14 };

/**
 * The −N badge's outline: a flat top with the corners drawn out into points, concave sides, shoulders flaring out again
 * above a chevron that drops to a tip. The +N badge is this same path flipped vertically (the caller mirrors the canvas),
 * and the 0 badge is the body alone with a flat foot.
 */
function badgePath(ctx: Ctx2D, s: BadgeShape, flatFoot: boolean) {
  const foot = s.shoulder;
  ctx.beginPath();
  ctx.moveTo(-s.tw, s.top);
  ctx.lineTo(s.tw, s.top);
  ctx.quadraticCurveTo(2 * s.mw - (s.tw + s.bw) / 2, (s.top + foot) / 2, s.bw, foot);
  if (!flatFoot) ctx.lineTo(0, s.tip);
  ctx.lineTo(-s.bw, foot);
  ctx.quadraticCurveTo(-(2 * s.mw - (s.tw + s.bw) / 2), (s.top + foot) / 2, -s.tw, s.top);
  ctx.closePath();
}

/** The starting-loyalty shield's outline in local units (origin = centre of the number, 100 wide): a notched top, concave sides, a pointed foot. */
function startShieldPath(ctx: Ctx2D) {
  ctx.beginPath();
  ctx.moveTo(-50, -19);
  ctx.lineTo(-16, -27);
  ctx.quadraticCurveTo(0, -15, 16, -27);
  ctx.lineTo(50, -19);
  ctx.quadraticCurveTo(36, -2, 41, 16);
  ctx.lineTo(0, 30);
  ctx.lineTo(-41, 16);
  ctx.quadraticCurveTo(-36, -2, -50, -19);
  ctx.closePath();
}

/**
 * A black loyalty badge with a light, bevelled silver rim: the rim is the outline, the black body the same outline pulled
 * in `sx`/`sy` (so the rim is ~6 px at the sides and ~4 px at the top and foot).
 */
function bevelBadge(ctx: Ctx2D, path: (c: Ctx2D) => void, cx: number, cy: number, sx: number, sy: number, top: number, bottom: number) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 2.5;
  path(ctx);
  const g = ctx.createLinearGradient(0, top, 0, bottom);
  g.addColorStop(0, '#fbfcfc');
  g.addColorStop(0.5, '#e0e2e3');
  g.addColorStop(0.8, '#b9bcbd');
  g.addColorStop(1, '#e9ebeb');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 0.9;
  ctx.strokeStyle = 'rgba(30,30,32,0.75)';
  ctx.stroke();
  ctx.scale(sx, sy);
  path(ctx);
  ctx.fillStyle = '#020202';
  ctx.fill();
  ctx.restore();
}

/**
 * A loyalty-ability badge (+N up, −N down, 0 flat): a black badge with a silver bevel and the cost in white title font.
 * The +N badge is the −N outline mirrored vertically; the number stays upright, centred in the body (not the chevron).
 */
function loyaltyShield(ctx: Ctx2D, cx: number, cy0: number, text: string, nLines: number): number {
  const kind = loyaltyKind(text);
  const flip = kind === 'up' ? -1 : 1;
  const flat = kind === 'zero';
  const rim: BadgeShape = flat ? { ...BADGE_RIM, top: -19, waist: 0, shoulder: 19 } : BADGE_RIM;
  const body: BadgeShape = flat ? { ...BADGE_BODY, top: -14.8, waist: 0, shoulder: 14.8 } : BADGE_BODY;
  // As printed the badge hangs off the row's first line, not its middle: ~20 px below it (a one-liner's sits level with it).
  // ponytail: fitted to Chandra's four rows (1, 3, 2 and 3 lines); the real rule may be per-ability spacing.
  const cy = cy0 + (nLines > 1 ? 20 : -3);
  // Local origin = middle of the whole badge; the body's centre is `bodyOff` (±8, in the flipped frame) off it, 0 for a flat one.
  const bodyOff = flat ? 0 : (rim.top + rim.shoulder) / 2;
  const bodyY = cy + bodyOff * flip;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, flip);
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 2.5;
  badgePath(ctx, rim, flat);
  // The silver is lit from above whichever way the badge points: the gradient runs over the screen's top-to-foot.
  const g = ctx.createLinearGradient(0, flip * rim.top, 0, flip * (flat ? rim.shoulder : rim.tip));
  g.addColorStop(0, '#f1f3f3');
  g.addColorStop(0.5, '#cfd2d3');
  g.addColorStop(0.8, '#a6a9aa');
  g.addColorStop(1, '#d9dbdc');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 0.9;
  ctx.strokeStyle = 'rgba(30,30,32,0.75)';
  ctx.stroke();
  badgePath(ctx, body, flat);
  ctx.fillStyle = '#020202';
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#f6f5f2';
  ctx.strokeStyle = '#f6f5f2';
  ctx.lineWidth = 0.5;
  ctx.lineJoin = 'round';
  ctx.font = `27.5px "${TITLE_FONT}", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  // Measured: the printed digits sit ~6 px lower than body-centred in a −N badge (toward the chevron) and ~3.5 px higher in a +N one (toward the peak).
  const numY = bodyY + 9 + (kind === 'down' ? 6 : kind === 'up' ? -3.5 : 0);
  ctx.strokeText(text, cx, numY);
  ctx.fillText(text, cx, numY);
  ctx.textAlign = 'left';
  // The ": " after the badge is centred on it (a touch below a +N badge's middle, above a −N one's), not on the text's first line.
  return cy + (kind === 'up' ? 4.5 : kind === 'down' ? -2 : 0);
}

/** The big mana symbol of a basic land, as printed faintly behind its text: a dark tint of its colour. */
const WATERMARK_TINT: Record<string, string> = {
  W: '98,84,40',
  U: '18,52,92',
  B: '34,26,30',
  R: '104,30,18',
  G: '14,64,36',
  C: '70,70,72',
};

/** Paint a basic land's watermark: the colour's Mana-font symbol, ~180 px, centred in the text box under the text. */
function paintLandWatermark(ctx: Ctx2D, card: M15Card, b: Rect) {
  const colour = landWatermark(card);
  if (!colour || !manaReady()) return;
  const g = msGlyph(colour.toLowerCase());
  if (!g) return;
  ctx.save();
  ctx.font = `100px ${MANA_FONT}`;
  const m = ctx.measureText(g);
  const ink = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  // The printed symbol is ~183 px tall in a 276 px box.
  const size = ink > 0 ? (100 * Math.min(183, b.h * 0.66)) / ink : 180;
  glyphAt(ctx, g, b.x + b.w / 2 + 2, b.y + b.h / 2, size, `rgba(${WATERMARK_TINT[colour]},0.22)`);
  ctx.restore();
}

/** The stats-area painters a layout can name (`stats`). */
const STATS: Record<M15LayoutSpec['stats'], (ctx: Ctx2D, card: M15Card, s: FrameStyle, geo: M15Geometry) => void> = {
  pt: paintPt,
  loyalty: paintLoyalty,
};

/** A planeswalker's starting loyalty, in its shield. */
function paintLoyalty(ctx: Ctx2D, card: M15Card, _s: FrameStyle, geo: M15Geometry) {
  if (!card.loyalty) return;
  const r = geo.pt;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2 + 1;
  bevelBadge(ctx, startShieldPath, cx, cy, 0.87, 0.8, -27, 30);
  ctx.fillStyle = '#f6f5f2';
  ctx.font = `37px "${TITLE_FONT}", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(card.loyalty, cx - 1, cy + 13);
  ctx.textAlign = 'left';
}

/** Power/toughness (a battle's defense) on its plate. */
function paintPt(ctx: Ctx2D, card: M15Card, s: FrameStyle) {
  const text = ptText(card);
  if (!text) return;
  const r = ptPlate(card, text);
  plate(ctx, r, s.plate, 10);
  ctx.font = `42px "${TITLE_FONT}", serif`;
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, r.x + r.w / 2, r.y + r.h / 2 + 14);
  ctx.textAlign = 'left';
}

function paintStamp(ctx: Ctx2D, cy: number) {
  const cx = 336;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, 31, 15, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#0a0808';
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx, cy, 28, 12.5, 0, 0, Math.PI * 2);
  const g = ctx.createLinearGradient(cx - 28, cy - 12, cx + 28, cy + 12);
  g.addColorStop(0, '#a6a99f');
  g.addColorStop(0.35, '#e0e2da');
  g.addColorStop(0.6, '#8f9490');
  g.addColorStop(1, '#c9ccc4');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.clip();
  ctx.strokeStyle = 'rgba(60,64,60,0.35)';
  ctx.lineWidth = 1;
  for (let x = cx - 40; x < cx + 40; x += 7) {
    ctx.beginPath();
    ctx.moveTo(x, cy - 14);
    ctx.lineTo(x + 7, cy + 14);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 7, cy - 14);
    ctx.lineTo(x, cy + 14);
    ctx.stroke();
  }
  ctx.restore();
}

/** The bottom line: collector number, rarity, set, language, artist; the copyright on the right. */
function paintInfoLine(ctx: Ctx2D, card: M15Card) {
  const sans = `${fonts.ui}`;
  ctx.save();
  ctx.fillStyle = '#f2f0ec';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const track = (ctx as unknown as { letterSpacing: string });
  const num = card.collectorNumber ? card.collectorNumber.padStart(4, '0') : '';
  const row1 = [rarityLetter(card.rarity), num].filter(Boolean).join(' ');
  ctx.font = `600 16px ${sans}`;
  if ('letterSpacing' in ctx) track.letterSpacing = '1.4px';
  ctx.fillText(row1.toUpperCase(), 44, 889);
  const row2 = `${card.set.toUpperCase()} • EN`;
  ctx.fillText(row2, 44, 906);
  const w2 = ctx.measureText(row2).width;
  if ('letterSpacing' in ctx) track.letterSpacing = '0px';
  // The artist's brush and name in small caps.
  const bx = 44 + w2 + 10;
  brush(ctx, bx, 899);
  let x = bx + 30;
  for (const w of card.artist.split(/\s+/)) {
    if (!w) continue;
    ctx.font = `bold 17px "${BODY_FONT}", serif`;
    const first = w.charAt(0).toUpperCase();
    ctx.fillText(first, x, 905);
    x += ctx.measureText(first).width + 0.5;
    ctx.font = `bold 13.4px "${BODY_FONT}", serif`;
    const rest = w.slice(1).toUpperCase();
    ctx.fillText(rest, x, 905);
    x += ctx.measureText(rest).width + 6;
  }
  // The copyright, right-aligned.
  ctx.textAlign = 'right';
  ctx.font = `15.5px "${BODY_FONT}", serif`;
  const right = 627;
  ctx.fillText(`™ & © ${card.year} Wizards of the Coast`, right, 905);
  if (card.licensor) ctx.fillText(card.licensor, right, 887);
  ctx.restore();
}

function brush(ctx: Ctx2D, x: number, y: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, 5);
  ctx.quadraticCurveTo(4, -2, 11, -3);
  ctx.quadraticCurveTo(19, -5, 22, -1);
  ctx.quadraticCurveTo(16, 5, 8, 4);
  ctx.quadraticCurveTo(5, 8, 0, 5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ------------------------------------------------------------------------------------------ marks (counters, damage, ×N)

/** A counter on the frame: its icon (a Mana-font glyph, else the kind's initial) and how many. */
export interface M15Counter {
  glyph: string | null;
  letter: string;
  count: number;
  /** +1/+1 (green icon), -1/-1 (red icon) or any other kind. */
  tone: 'plus' | 'minus' | 'plain';
}

/** What the table lays over a battlefield card's frame. */
export interface M15Marks {
  /** Counter coins, left to right (those that don't fit left of the P/T plate fold into a "+N" coin). */
  counters: M15Counter[];
  /** Marked damage: the P/T plate shows the toughness left, in red (MTGA's way; no damage marker). */
  damage: number;
  /** Identical permanents in one slot: the "×N" tab on the top-right corner (≤ 1: none). */
  group: number;
  /** Gained keywords' ability symbols (director/keywords.ts gainedKeywords), down the art's left edge. */
  keywords?: string[];
}

/**
 * The coins' size (design units; a battlefield card is ~150 px tall, so ~16 px) and the count bubble's. Every coin sits
 * on one baseline: its bottom level with the P/T plate's, clear of the bottom info line.
 */
export const COIN_D = 100;
const COIN_GAP = 10;
const BUBBLE_D = 46;
/** At most this many coins in the row (fewer when a grown P/T plate takes the room); past it, the last becomes "+N". */
export const MAX_COINS = 4;
const COIN_FACE: RGB = [26, 23, 20];
const COIN_RIM = '#c9a86a';
const COIN_INK = '#f2ede4';
const TONE_INK = { plus: '#8fe3a0', minus: '#ff8f80', plain: COIN_INK } as const;
const DAMAGE_INK = '#b3201a';
/** Gained-keyword icons: a little smaller than a counter coin, a silver rim (not a counter's brass), a white symbol. */
export const KW_D = 84;
const KW_GAP = 10;
const KW_PAD = 14;
const KW_RIM = '#d4dbe6';

/** One coin centred on (cx, cy): black keyline, a brass rim, a domed dark face. */
function coin(ctx: Ctx2D, cx: number, cy: number, d: number, face: RGB, rim: string) {
  const r = d / 2;
  ctx.beginPath();
  ctx.arc(cx, cy + 2, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = css(BLACK);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r - 3, 0, Math.PI * 2);
  ctx.fillStyle = rim;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r - 8, 0, Math.PI * 2);
  const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
  g.addColorStop(0, css(mixc(face, [255, 255, 255], 0.16)));
  g.addColorStop(1, css(face));
  ctx.fillStyle = g;
  ctx.fill();
}

/** Text centred on (cx, cy) by its ink box. */
function centredText(ctx: Ctx2D, text: string, cx: number, cy: number, font: string, ink: string) {
  ctx.font = font;
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText(text);
  ctx.fillText(text, cx, cy + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
}

/** The count bubble on a coin's top-right: a light disc with the number. */
function bubble(ctx: Ctx2D, cx: number, cy: number, n: number) {
  const r = BUBBLE_D / 2;
  const text = `${n}`;
  ctx.font = `36px "${TITLE_FONT}", serif`;
  const w = Math.max(BUBBLE_D, ctx.measureText(text).width + 22);
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, cy - r, w, BUBBLE_D, r);
  ctx.fillStyle = css(BLACK);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(cx - w / 2 + 3, cy - r + 3, w - 6, BUBBLE_D - 6, r - 3);
  ctx.fillStyle = '#f4f2ec';
  ctx.fill();
  centredText(ctx, text, cx, cy, ctx.font, INK);
}

/**
 * Counters, damage and the ×N tab as frame elements, in the M15 design grid (the caller scales the context to its
 * canvas): counter coins along the bottom-left, the P/T plate repainted with the toughness left in red, the ×N tab over
 * the top-right corner.
 */
export function paintM15Marks(ctx: Ctx2D, card: M15Card, marks: M15Marks): void {
  const s = frameStyle(card);
  const toughLeft = damagedToughness(card, marks.damage);
  ctx.save();
  ctx.font = `48px "${TITLE_FONT}", serif`;
  const boxes = markBoxes(card, {
    coins: marks.counters.length,
    group: marks.group > 1 ? ctx.measureText(`×${marks.group}`).width + 36 : 0,
  });
  marks.counters.slice(0, boxes.coins.length - (boxes.more ? 1 : 0)).forEach((c, i) => {
    const b = boxes.coins[i]!;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    coin(ctx, cx, cy, COIN_D, COIN_FACE, COIN_RIM);
    if (c.glyph) glyphAt(ctx, c.glyph, cx, cy, COIN_D * 0.56, TONE_INK[c.tone]);
    else centredText(ctx, c.letter, cx, cy, `${COIN_D * 0.5}px "${TITLE_FONT}", serif`, COIN_INK);
    if (c.count > 1) bubble(ctx, b.x + b.w - BUBBLE_D * 0.3, b.y + BUBBLE_D * 0.3, c.count);
  });
  if (boxes.more) {
    const b = boxes.coins.at(-1)!;
    coin(ctx, b.x + b.w / 2, b.y + b.h / 2, COIN_D, COIN_FACE, COIN_RIM);
    centredText(ctx, `+${boxes.more}`, b.x + b.w / 2, b.y + b.h / 2, `${COIN_D * 0.4}px "${TITLE_FONT}", serif`, COIN_INK);
  }
  if (toughLeft !== null) {
    const pt = ptPlate(card, ptText(card));
    plate(ctx, pt, s.plate, 10);
    ctx.font = `42px "${TITLE_FONT}", serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const head = `${card.power}/`;
    const hw = ctx.measureText(head).width;
    const x = pt.x + (pt.w - hw - ctx.measureText(toughLeft).width) / 2;
    const y = pt.y + pt.h / 2 + 14;
    ctx.fillStyle = INK;
    ctx.fillText(head, x, y);
    ctx.fillStyle = DAMAGE_INK;
    ctx.fillText(toughLeft, x + hw, y);
  }
  const icons = marks.keywords ?? [];
  const kb = keywordBoxes(card, icons.length);
  kb.icons.forEach((b, i) => {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    coin(ctx, cx, cy, KW_D, COIN_FACE, KW_RIM);
    const last = i === kb.icons.length - 1 && kb.more;
    if (last) centredText(ctx, `+${kb.more}`, cx, cy, `${KW_D * 0.42}px "${TITLE_FONT}", serif`, COIN_INK);
    else glyphAt(ctx, icons[i]!, cx, cy, KW_D * 0.58, '#ffffff');
  });
  if (boxes.group) {
    const b = boxes.group;
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, b.w, b.h, b.h / 2);
    ctx.fillStyle = css(BLACK);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(b.x + 3, b.y + 3, b.w - 6, b.h - 6, b.h / 2 - 3);
    ctx.fillStyle = COIN_RIM;
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(b.x + 8, b.y + 8, b.w - 16, b.h - 16, b.h / 2 - 8);
    ctx.fillStyle = css(COIN_FACE);
    ctx.fill();
    centredText(ctx, `×${marks.group}`, b.x + b.w / 2, b.y + b.h / 2, `48px "${TITLE_FONT}", serif`, COIN_INK);
  }
  ctx.restore();
}

/** The toughness a damaged creature has left, as printed on its P/T plate; null when there's no damage or no numeric toughness. */
export function damagedToughness(card: Pick<M15Card, 'power' | 'toughness'>, damage: number): string | null {
  const t = Number(card.toughness);
  return damage > 0 && card.power !== '' && card.toughness !== '' && Number.isFinite(t) ? `${t - damage}` : null;
}

/**
 * Where the marks go (design units): coins for `coins` counter kinds left to right from the frame's bottom-left
 * (mirroring the P/T plate), bottoms level with the P/T plate's, as many as fit left of the (maybe grown) plate, up to
 * MAX_COINS; when they don't all fit the last slot is a "+N" coin for the `more` kinds left over. The ×N tab (`group`
 * wide, 0 = none) goes on the top-right corner.
 */
export function markBoxes(card: Pick<M15Card, 'typeLine' | 'power' | 'toughness' | 'defense'>, m: { coins: number; group: number }): { coins: Rect[]; more: number; group: Rect | null } {
  const geo = layoutFor(card).geo.pt;
  const plateX = ptPlate(card, ptText(card)).x;
  const y = geo.y + geo.h - COIN_D;
  const x0 = M15_W - geo.x - geo.w;
  const fit = Math.max(1, Math.min(MAX_COINS, Math.floor((plateX - x0) / (COIN_D + COIN_GAP))));
  const slots = Math.min(m.coins, fit);
  const more = m.coins > fit ? m.coins - (fit - 1) : 0;
  return {
    coins: Array.from({ length: slots }, (_, i) => ({ x: x0 + i * (COIN_D + COIN_GAP), y, w: COIN_D, h: COIN_D })),
    more,
    group: m.group ? { x: M15_W - 16 - m.group, y: 12, w: m.group, h: 70 } : null,
  };
}

/**
 * Where `n` gained-keyword icons go (design units): a column down the art's left edge from its top (the right edge is
 * the protection sigils', the bottom-left the counter coins'), as many as fit in the art; when they don't all fit the
 * last slot is a "+N" icon for the `more` left over.
 */
export function keywordBoxes(card: Pick<M15Card, 'typeLine'>, n: number): { icons: Rect[]; more: number } {
  const art = layoutFor(card).geo.art;
  const fit = Math.max(1, Math.floor((art.h - 2 * KW_PAD + KW_GAP) / (KW_D + KW_GAP)));
  const slots = Math.min(n, fit);
  const more = n > fit ? n - (fit - 1) : 0;
  return { icons: Array.from({ length: slots }, (_, i) => ({ x: art.x + KW_PAD, y: art.y + KW_PAD + i * (KW_D + KW_GAP), w: KW_D, h: KW_D })), more };
}
