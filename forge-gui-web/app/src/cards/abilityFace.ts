/**
 * An ability card (MTGA-style): an activated or triggered ability on the stack, drawn as a card of
 * its own so it plainly comes from its source. A dark frame tinted by the source's colours, the source's art cropped
 * across the top (the scan when it is loaded, else the procedural art panel), a Triggered / Activated tag, the
 * source's name and the ability's text, large: it is what the card is for.
 */
import type { Card } from '@forge-table/protocol';
import { fonts, mix, rgbCss } from '../theme/tokens';
import { drawLoyalty, drawPip, frameColor, paintCardBack, paintCardFace, rulesHeight, wrapRich, type Ctx2D } from './face';
import { tokenizeRules } from './mana';
import type { AbilityFace } from '../layout/stack';

const REF_W = 252;
/** The art box of a card (real scans and the procedural face alike), as fractions of the card. */
export const ART_CROP = { x: 0.075, y: 0.12, w: 0.85, h: 0.4 } as const;
const TAG = { Triggered: '#FFB067', Activated: '#9CC3FF' } as const;

function rr(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/**
 * Paint an ability card filling a w×h canvas. `art`: the source's scan (a bitmap) or null; `source`: the source card
 * (its face paints the procedural art, and its colours tint the frame; absent for a hidden source).
 */
export function paintAbilityFace(ctx: Ctx2D, w: number, h: number, face: AbilityFace, source: Card | undefined, art: CanvasImageSource | null): void {
  const u = w / REF_W;
  const tone = frameColor(source?.state);
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  rr(ctx, 0, 0, w, h, w * 0.045);
  ctx.fillStyle = '#0e1013';
  ctx.fill();
  const inset = 6 * u;
  rr(ctx, inset, inset, w - 2 * inset, h - 2 * inset, w * 0.03);
  const fg = ctx.createLinearGradient(0, 0, 0, h);
  fg.addColorStop(0, rgbCss(mix(tone, [18, 20, 24], 0.55)));
  fg.addColorStop(1, rgbCss(mix(tone, [10, 11, 13], 0.8)));
  ctx.fillStyle = fg;
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.5 * u);
  ctx.strokeStyle = 'rgba(176,141,87,0.7)'; // brass
  ctx.stroke();

  // The source's art across the top.
  const ax = 13 * u;
  const ay = 13 * u;
  const aw = w - 26 * u;
  const ah = h * 0.36;
  ctx.save();
  rr(ctx, ax, ay, aw, ah, 5 * u);
  ctx.clip();
  const crop = artCrop(source, art, aw / ah);
  if (crop) ctx.drawImage(crop.img, crop.sx, crop.sy, crop.sw, crop.sh, ax, ay, aw, ah);
  else {
    ctx.fillStyle = rgbCss(mix(tone, [20, 22, 26], 0.5));
    ctx.fillRect(ax, ay, aw, ah);
  }
  // Fades into the frame at the bottom, so the tag reads over it.
  const fade = ctx.createLinearGradient(0, ay + ah * 0.55, 0, ay + ah);
  fade.addColorStop(0, 'rgba(10,11,13,0)');
  fade.addColorStop(1, 'rgba(10,11,13,0.75)');
  ctx.fillStyle = fade;
  ctx.fillRect(ax, ay, aw, ah);
  ctx.restore();
  rr(ctx, ax, ay, aw, ah, 5 * u);
  ctx.lineWidth = Math.max(1, u);
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.stroke();

  // Triggered / Activated, on the art's bottom edge.
  const tagH = 22 * u;
  const tagY = ay + ah - tagH * 0.6;
  ctx.font = `700 ${14 * u}px ${fonts.numeral}`;
  const label = face.kind.toUpperCase();
  const tagW = ctx.measureText(label).width * 1.18 + 22 * u;
  rr(ctx, ax + 8 * u, tagY, tagW, tagH, tagH / 2);
  ctx.fillStyle = 'rgba(14,16,19,0.92)';
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.2 * u);
  ctx.strokeStyle = TAG[face.kind];
  ctx.stroke();
  ctx.fillStyle = TAG[face.kind];
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = `${1.5 * u}px`;
  ctx.fillText(label, ax + 19 * u, tagY + tagH / 2 + u);
  ctx.letterSpacing = '0px';

  // The source's name.
  const nameY = tagY + tagH + 8 * u;
  const nameH = 22 * u;
  let fs = 17 * u;
  ctx.font = `650 ${fs}px ${fonts.ui}`;
  while (ctx.measureText(face.name).width > aw - 8 * u && fs > 10 * u) {
    fs -= 0.5 * u;
    ctx.font = `650 ${fs}px ${fonts.ui}`;
  }
  let name = face.name;
  while (name.length > 1 && ctx.measureText(name).width > aw - 8 * u) name = name.slice(0, -2) + '…';
  ctx.fillStyle = '#F4F2EC';
  ctx.fillText(name, ax + 4 * u, nameY + nameH / 2);

  // The ability's text: a parchment box, as large as it fits.
  const bx = ax;
  const by = nameY + nameH + 6 * u;
  const bw = aw;
  const bh = h - by - 13 * u;
  rr(ctx, bx, by, bw, bh, 4 * u);
  ctx.fillStyle = rgbCss(mix(mix(tone, [246, 242, 232], 0.86), [255, 255, 255], 0.2));
  ctx.fill();
  const parts = tokenizeRules(face.text);
  const pad = 9 * u;
  let ts = 19 * u;
  let lines = wrapRich(ctx, parts, bw - 2 * pad, ts);
  while (rulesHeight(lines, ts) > bh - 2 * pad && ts > 8 * u) {
    ts -= 0.5 * u;
    lines = wrapRich(ctx, parts, bw - 2 * pad, ts);
  }
  ctx.save();
  rr(ctx, bx, by, bw, bh, 4 * u);
  ctx.clip();
  let y = by + pad + ts * 0.6;
  for (const line of lines) {
    let x = bx + pad;
    for (const part of line.parts) {
      if (part.kind === 'text') {
        ctx.font = `450 ${ts}px ${fonts.ui}`;
        ctx.fillStyle = '#1B1C1E';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(part.text, x, y);
      } else if (part.kind === 'loyalty') {
        drawLoyalty(ctx, part.cost, x, y, ts, part.w);
      } else {
        drawPip(ctx, part.token.sym, x + part.w / 2, y, ts * 0.46);
      }
      x += part.w;
    }
    y += ts * 1.22 + line.gapAfter;
  }
  ctx.restore();
  ctx.restore();
}

/**
 * Where the art comes from: the scan's art box, else a procedural face's art panel (painted `refW` wide), else a card
 * back's middle.
 */
export function artCrop(source: Card | undefined, art: CanvasImageSource | null, aspect: number, refW = REF_W): { img: CanvasImageSource; sx: number; sy: number; sw: number; sh: number } | null {
  let img: CanvasImageSource | null = art;
  let w = 0;
  let h = 0;
  if (art && 'width' in art) {
    w = Number(art.width);
    h = Number(art.height);
  }
  if (!img || !w || !h) {
    // Painted at the reference size: the procedural art panel (or the back, for a hidden source).
    w = refW;
    h = Math.round(refW / (63 / 88));
    const c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return null;
    c.width = w;
    c.height = h;
    if (source?.state) paintCardFace(ctx, w, h, { face: source.state, card: source });
    else paintCardBack(ctx, w, h);
    img = c;
  }
  // The middle of the art box at the strip's aspect.
  let sw = w * ART_CROP.w;
  let sh = sw / aspect;
  if (sh > h * ART_CROP.h) {
    sh = h * ART_CROP.h;
    sw = sh * aspect;
  }
  return { img, sx: w * (ART_CROP.x + ART_CROP.w / 2) - sw / 2, sy: h * (ART_CROP.y + ART_CROP.h / 2) - sh / 2, sw, sh };
}
