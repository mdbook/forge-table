/**
 * Procedural card faces and the original Kiln card back, painted with Canvas 2D.
 *
 * The same painter feeds Pixi textures (table) and DOM canvases (overlays, preview), so a card reads the
 * same everywhere. Everything here is original: the frame layout is a generic one ported in spirit from
 * FCardImageRenderer's model, mana pips are coloured discs with letter glyphs, and the back is a graphite
 * panel with a brass hairline and an abstract anvil mark. State chrome (glows, rings, badges) is never painted
 * here: the table draws it around and over the card (cardSprite).
 */
import type { Card, CardFace } from '@forge-table/protocol';
import { frame, fonts, luminance, mix, pip, rgbCss, type RGB } from '../theme/tokens';
import { MANA_FONT, manaReady, msGlyph } from '../theme/manaFont';
import { manaValue, tokenizeMana, tokenizeRules, type ManaSymbol, type ManaToken, type RichPart } from './mana';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Reference width the layout constants are written for; everything scales by w / 252. */
const REF_W = 252;

// ------------------------------------------------------------------------------------------ colours

export function frameColor(face: CardFace | undefined): RGB {
  const core = face?.type?.core ?? [];
  const colors = face?.colors ?? '';
  if (core.includes('Land') && !core.includes('Creature')) return frame.land;
  if (colors.length >= 2) return frame.multi;
  if (colors.length === 1) {
    const c = colors as keyof typeof frame;
    return (frame[c] as RGB | undefined) ?? frame.colorless;
  }
  return frame.colorless;
}

/** The name and type bars' fill: the frame colour, lightened. */
export function nameBarFill(face: CardFace | undefined): RGB {
  const fill = frameColor(face);
  return mix(fill, [255, 255, 255], luminance(fill) > 0.5 ? 0.35 : 0.22);
}

function textOn(fill: RGB): string {
  return luminance(fill) > 0.35 ? '#17181A' : '#F4F2EC';
}

// ------------------------------------------------------------------------------------------ pips

function pipStyle(c: string) {
  return (pip as Record<string, { fill: string; glyph: string; rim: string }>)[c] ?? pip.generic;
}

function disc(ctx: Ctx2D, x: number, y: number, r: number, fill: string, rim: string) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.strokeStyle = rim;
  ctx.stroke();
  // Soft top highlight: a matte enamel feel, not a glossy gem.
  const g = ctx.createLinearGradient(x, y - r, x, y + r);
  g.addColorStop(0, 'rgba(255,255,255,0.22)');
  g.addColorStop(0.55, 'rgba(255,255,255,0)');
  ctx.beginPath();
  ctx.arc(x, y, r * 0.92, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
}

/** The Mana font's symbol for `name` (`w`, `12`, `tap`…) when the font is loaded, else null (letters then). */
function sym_(name: string): string | null {
  return manaReady() ? msGlyph(name) : null;
}

/** A Mana-font symbol if there is one, else the fallback text in our numeral font. */
function glyph(ctx: Ctx2D, text: string, x: number, y: number, size: number, color: string, ms: string | null = null) {
  if (ms) {
    ctx.fillStyle = color;
    ctx.font = `${size * 0.82}px ${MANA_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ms, x, y + size * 0.02);
    return;
  }
  ctx.fillStyle = color;
  ctx.font = `600 ${size}px ${fonts.numeral}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + size * 0.04);
}

function halfDisc(ctx: Ctx2D, x: number, y: number, r: number, fill: string, upperLeft: boolean) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.beginPath();
  if (upperLeft) {
    ctx.moveTo(x - r, y - r);
    ctx.lineTo(x + r, y - r);
    ctx.lineTo(x - r, y + r);
  } else {
    ctx.moveTo(x + r, y - r);
    ctx.lineTo(x + r, y + r);
    ctx.lineTo(x - r, y + r);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

/** Tap arrow: an original curved-arrow glyph. `reverse` draws the untap form. */
function tapGlyph(ctx: Ctx2D, x: number, y: number, r: number, color: string, reverse: boolean) {
  ctx.save();
  ctx.translate(x, y);
  if (reverse) ctx.scale(-1, 1);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = r * 0.22;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0, r * 0.08, r * 0.48, Math.PI * 1.05, Math.PI * 1.85);
  ctx.stroke();
  const ax = Math.cos(Math.PI * 1.85) * r * 0.48;
  const ay = Math.sin(Math.PI * 1.85) * r * 0.48 + r * 0.08;
  ctx.beginPath();
  ctx.moveTo(ax + r * 0.28, ay + r * 0.05);
  ctx.lineTo(ax - r * 0.12, ay - r * 0.22);
  ctx.lineTo(ax - r * 0.02, ay + r * 0.28);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Draw one mana pip centred at (x, y) with radius r. */
export function drawPip(ctx: Ctx2D, sym: ManaSymbol, x: number, y: number, r: number): void {
  const fs = r * 1.45;
  switch (sym.kind) {
    case 'color': {
      const s = pipStyle(sym.color);
      disc(ctx, x, y, r, s.fill, s.rim);
      glyph(ctx, sym.color, x, y, fs, s.glyph, sym_(sym.color));
      return;
    }
    case 'generic':
    case 'variable': {
      const s = pip.generic;
      disc(ctx, x, y, r, s.fill, s.rim);
      const g = sym_(sym.value);
      glyph(ctx, sym.value, x, y, sym.value.length > 1 && !g ? fs * 0.8 : fs, s.glyph, g);
      return;
    }
    case 'colorless': {
      const s = pip.C;
      disc(ctx, x, y, r, s.fill, s.rim);
      const g = sym_('c');
      if (g) {
        glyph(ctx, 'C', x, y, fs, s.glyph, g);
        return;
      }
      // An original hollow-diamond glyph for colourless.
      ctx.save();
      ctx.strokeStyle = s.glyph;
      ctx.lineWidth = r * 0.16;
      ctx.beginPath();
      ctx.moveTo(x, y - r * 0.5);
      ctx.lineTo(x + r * 0.42, y);
      ctx.lineTo(x, y + r * 0.5);
      ctx.lineTo(x - r * 0.42, y);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
      return;
    }
    case 'snow': {
      const s = pip.snow;
      disc(ctx, x, y, r, s.fill, s.rim);
      glyph(ctx, 'S', x, y, fs, s.glyph, sym_('s'));
      return;
    }
    case 'hybrid': {
      const a = pipStyle(sym.colors[0]);
      const b = pipStyle(sym.colors[1]);
      disc(ctx, x, y, r, a.fill, a.rim);
      halfDisc(ctx, x, y, r * 0.94, b.fill, false);
      glyph(ctx, sym.colors[0], x - r * 0.34, y - r * 0.3, fs * 0.58, a.glyph, sym_(sym.colors[0]));
      glyph(ctx, sym.colors[1], x + r * 0.34, y + r * 0.3, fs * 0.58, b.glyph, sym_(sym.colors[1]));
      return;
    }
    case 'monoHybrid': {
      const g = pip.generic;
      const c = pipStyle(sym.color);
      disc(ctx, x, y, r, g.fill, g.rim);
      halfDisc(ctx, x, y, r * 0.94, c.fill, false);
      glyph(ctx, sym.generic, x - r * 0.34, y - r * 0.3, fs * 0.58, g.glyph, sym_(sym.generic));
      glyph(ctx, sym.color, x + r * 0.34, y + r * 0.3, fs * 0.58, c.glyph, sym_(sym.color));
      return;
    }
    case 'phyrexian': {
      const cols = sym.colors.length > 0 ? sym.colors : (['C'] as const);
      const a = pipStyle(cols[0]!);
      disc(ctx, x, y, r, a.fill, a.rim);
      if (cols.length > 1) halfDisc(ctx, x, y, r * 0.94, pipStyle(cols[1]!).fill, false);
      const p = sym_('p');
      if (p) {
        glyph(ctx, 'P', x, y, fs, a.glyph, p);
        return;
      }
      // Original phyrexian mark: an inner ring with a vertical stroke.
      ctx.save();
      ctx.strokeStyle = a.glyph;
      ctx.lineWidth = r * 0.13;
      ctx.beginPath();
      ctx.arc(x, y, r * 0.38, 0, Math.PI * 2);
      ctx.moveTo(x, y - r * 0.62);
      ctx.lineTo(x, y + r * 0.62);
      ctx.stroke();
      ctx.restore();
      return;
    }
    case 'tap':
    case 'untap': {
      const s = pip.tap;
      disc(ctx, x, y, r, s.fill, s.rim);
      const t = sym_(sym.kind);
      if (t) glyph(ctx, '', x, y, fs, s.glyph, t);
      else tapGlyph(ctx, x, y, r, s.glyph, sym.kind === 'untap');
      return;
    }
    case 'energy': {
      const s = pip.tap;
      disc(ctx, x, y, r, s.fill, s.rim);
      glyph(ctx, 'E', x, y, fs, '#FFB067', sym_('e'));
      return;
    }
    case 'half': {
      const s = pipStyle(sym.color ?? 'generic');
      disc(ctx, x, y, r * 0.75, s.fill, s.rim);
      glyph(ctx, '½', x, y, fs * 0.7, s.glyph);
      return;
    }
    case 'unknown': {
      const s = pip.generic;
      disc(ctx, x, y, r, s.fill, s.rim);
      glyph(ctx, sym.raw.slice(0, 2), x, y, fs * 0.7, s.glyph);
      return;
    }
  }
}

/** A planeswalker ability's cost: the Mana font's up/down/zero shield with the number on it, else "+1:" in bold. */
export function drawLoyalty(ctx: Ctx2D, cost: string, x: number, y: number, fs: number, w: number): void {
  const shield = sym_(cost.startsWith('+') ? 'loyalty-up' : cost.startsWith('−') ? 'loyalty-down' : 'loyalty-zero');
  ctx.textBaseline = 'middle';
  if (!shield) {
    ctx.font = `700 ${fs}px ${fonts.ui}`;
    ctx.fillStyle = '#1B1C1E';
    ctx.textAlign = 'left';
    ctx.fillText(`${cost}:`, x, y);
    return;
  }
  const cx = x + (w - fs * 0.3) / 2;
  ctx.font = `${fs * 1.75}px ${MANA_FONT}`;
  ctx.fillStyle = '#1B1C1E';
  ctx.textAlign = 'center';
  ctx.fillText(shield, cx, y);
  ctx.font = `700 ${fs * 0.78}px ${fonts.numeral}`;
  ctx.fillStyle = '#F4F2EC';
  ctx.fillText(cost, cx, y + fs * 0.04);
}

/** Draw a mana cost right-aligned so it ends at `right`; returns its width. */
export function drawCost(ctx: Ctx2D, tokens: ManaToken[], right: number, y: number, r: number, gap: number): number {
  const width = tokens.length * 2 * r + Math.max(0, tokens.length - 1) * gap;
  let x = right - width + r;
  for (const t of tokens) {
    drawPip(ctx, t.sym, x, y, r);
    x += 2 * r + gap;
  }
  return width;
}

// ------------------------------------------------------------------------------------------ helpers

function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Fit `text` into `maxW` by shrinking the font, then ellipsising. Returns the font size used. */
function fitText(ctx: Ctx2D, text: string, maxW: number, size: number, minSize: number, weight: number, family: string): [string, number] {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (ctx.measureText(text).width > maxW && s > minSize) {
    s -= 0.5;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  if (ctx.measureText(text).width <= maxW) return [text, s];
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return [`${t}…`, s];
}

/** The Mana-font card-type symbol for a face: the most telling of its types (an artifact creature is a creature). */
export function typeIcon(face: CardFace | undefined, card?: Pick<Card, 'token'>): string {
  const core = face?.type?.core ?? [];
  const sub = face?.type?.sub ?? [];
  if (sub.includes('Saga')) return 'saga';
  for (const t of ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land']) {
    if (core.includes(t)) return t.toLowerCase();
  }
  return card?.token ? 'token' : '';
}

export function typeLine(face: CardFace | undefined, card?: Pick<Card, 'token'>): string {
  const t = face?.type;
  if (!t) return '';
  const left = [...(t.super ?? []), ...(t.core ?? [])].join(' ');
  const sub = (t.sub ?? []).join(' ');
  const base = sub ? `${left} — ${sub}` : left;
  return card?.token ? `Token ${base}` : base;
}

interface RichLayoutLine {
  parts: Array<{ kind: 'text'; text: string; w: number } | { kind: 'sym'; token: ManaToken; w: number } | { kind: 'loyalty'; cost: string; w: number }>;
  gapAfter: number;
}

/** Wrap rules text with inline symbols into lines no wider than `maxW` at font size `fs`. */
export function wrapRich(ctx: Ctx2D, parts: RichPart[], maxW: number, fs: number): RichLayoutLine[] {
  ctx.font = `400 ${fs}px ${fonts.ui}`;
  const symW = fs * 1.02;
  const lines: RichLayoutLine[] = [];
  let line: RichLayoutLine = { parts: [], gapAfter: 0 };
  let x = 0;
  const space = ctx.measureText(' ').width;
  const pushLine = (gap: number) => {
    line.gapAfter = gap;
    lines.push(line);
    line = { parts: [], gapAfter: 0 };
    x = 0;
  };
  for (const p of parts) {
    if (p.type === 'break') {
      pushLine(fs * 0.45);
      continue;
    }
    if (p.type === 'loyalty') {
      // Shield plus a little air; always the first thing on its line.
      const w = manaReady() ? fs * 2.3 : ctx.measureText(`${p.cost}: `).width;
      line.parts.push({ kind: 'loyalty', cost: p.cost, w });
      x += w;
      continue;
    }
    if (p.type === 'sym') {
      if (x + symW > maxW && x > 0) pushLine(0);
      line.parts.push({ kind: 'sym', token: p.token, w: symW });
      x += symW;
      continue;
    }
    // Words, keeping leading/trailing spaces as separators.
    const words = p.text.split(/(\s+)/);
    for (const word of words) {
      if (word === '') continue;
      if (/^\s+$/.test(word)) {
        if (x > 0) {
          line.parts.push({ kind: 'text', text: ' ', w: space });
          x += space;
        }
        continue;
      }
      const w = ctx.measureText(word).width;
      if (x + w > maxW && x > 0) {
        // Drop a trailing space before wrapping.
        const last = line.parts[line.parts.length - 1];
        if (last && last.kind === 'text' && last.text === ' ') line.parts.pop();
        pushLine(0);
      }
      line.parts.push({ kind: 'text', text: word, w });
      x += w;
    }
  }
  if (line.parts.length > 0) pushLine(0);
  return lines;
}

export function rulesHeight(lines: RichLayoutLine[], fs: number): number {
  return lines.reduce((h, l) => h + fs * 1.22 + l.gapAfter, 0);
}

// ------------------------------------------------------------------------------------------ face

/** The illustration for the art box (Scryfall's art crop) and who painted it: Scryfall's terms ask for the credit. */
export interface FaceCrop {
  bitmap: ImageBitmap;
  artist: string | null;
}

export interface FaceInput {
  face: CardFace;
  card?: Pick<Card, 'token' | 'counters' | 'damage'>;
  /** The art crop, once loaded ('frame' art mode): drawn cover-fit over the art panel, the artist credited in the footer. */
  crop?: FaceCrop | undefined;
}

/** Draw `img` filling the box (x, y, w, h) without distortion: scaled up to cover it, the overflow cropped evenly. */
export function drawCover(ctx: Ctx2D, img: ImageBitmap, x: number, y: number, w: number, h: number): void {
  if (img.width === 0 || img.height === 0) return;
  const k = Math.max(w / img.width, h / img.height);
  const sw = w / k;
  const sh = h / k;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

/** Paint a card face filling a w×h canvas. */
export function paintCardFace(ctx: Ctx2D, w: number, h: number, input: FaceInput): void {
  const { face, card } = input;
  const u = w / REF_W;
  const fill = frameColor(face);
  const ink = textOn(fill);
  const radius = w * 0.045;

  ctx.save();
  ctx.clearRect(0, 0, w, h);
  // Border.
  roundRect(ctx, 0, 0, w, h, radius);
  ctx.fillStyle = '#111316';
  ctx.fill();
  // Frame.
  const inset = 7 * u;
  roundRect(ctx, inset, inset, w - 2 * inset, h - 2 * inset, radius * 0.6);
  const fg = ctx.createLinearGradient(0, inset, 0, h - inset);
  fg.addColorStop(0, rgbCss(mix(fill, [255, 255, 255], 0.08)));
  fg.addColorStop(1, rgbCss(mix(fill, [0, 0, 0], 0.18)));
  ctx.fillStyle = fg;
  ctx.fill();

  // Name bar.
  const barFill = nameBarFill(face);
  const barInk = textOn(barFill);
  const barX = 13 * u;
  const barW = w - 26 * u;
  const nameY = 13 * u;
  const nameH = 30 * u;
  roundRect(ctx, barX, nameY, barW, nameH, 5 * u);
  ctx.fillStyle = rgbCss(barFill);
  ctx.fill();
  ctx.lineWidth = Math.max(1, u);
  ctx.strokeStyle = 'rgba(176,141,87,0.55)'; // brass hairline
  ctx.stroke();
  const cost = tokenizeMana(face.manaCost);
  const pipR = 8.2 * u;
  const costW = cost.length > 0 ? drawCost(ctx, cost, barX + barW - 7 * u, nameY + nameH / 2, pipR, 2 * u) : 0;
  const nameMax = barW - 16 * u - costW - (costW > 0 ? 6 * u : 0);
  const [name, nameSize] = fitText(ctx, face.name ?? '', nameMax, 15 * u, 9 * u, 600, fonts.ui);
  ctx.font = `600 ${nameSize}px ${fonts.ui}`;
  ctx.fillStyle = barInk;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, barX + 8 * u, nameY + nameH / 2 + u);

  // Art panel: an abstract, quiet panel with the card's type symbol; the art crop covers it once it has loaded.
  const artX = 17 * u;
  const artY = nameY + nameH + 6 * u;
  const artW = w - 34 * u;
  const artH = 140 * u;
  roundRect(ctx, artX, artY, artW, artH, 3 * u);
  const ag = ctx.createLinearGradient(artX, artY, artX + artW, artY + artH);
  ag.addColorStop(0, rgbCss(mix(fill, [20, 22, 26], 0.45)));
  ag.addColorStop(1, rgbCss(mix(fill, [10, 11, 13], 0.72)));
  ctx.fillStyle = ag;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = Math.max(1, u);
  for (let i = -artH; i < artW; i += 14 * u) {
    ctx.beginPath();
    ctx.moveTo(artX + i, artY + artH);
    ctx.lineTo(artX + i + artH, artY);
    ctx.stroke();
  }
  // The card type's symbol (Mana font), else the name's initial.
  const typeSym = sym_(typeIcon(face, input.card));
  const initial = typeSym ?? (face.name ?? '?').replace(/^the\s+/i, '').charAt(0).toUpperCase();
  ctx.font = typeSym ? `${82 * u}px ${MANA_FONT}` : `600 ${110 * u}px ${fonts.numeral}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = typeSym ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.10)';
  ctx.fillText(initial, artX + artW / 2, artY + artH / 2 + (typeSym ? 2 : 6) * u);
  if (input.crop) drawCover(ctx, input.crop.bitmap, artX, artY, artW, artH);
  ctx.restore();
  ctx.lineWidth = Math.max(1, u);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  roundRect(ctx, artX, artY, artW, artH, 3 * u);
  ctx.stroke();

  // Type line.
  const typeY = artY + artH + 5 * u;
  const typeH = 24 * u;
  roundRect(ctx, barX, typeY, barW, typeH, 5 * u);
  ctx.fillStyle = rgbCss(barFill);
  ctx.fill();
  ctx.strokeStyle = 'rgba(176,141,87,0.55)';
  ctx.stroke();
  const [tl, tlSize] = fitText(ctx, typeLine(face, card), barW - 16 * u, 11.5 * u, 7 * u, 600, fonts.ui);
  ctx.font = `600 ${tlSize}px ${fonts.ui}`;
  ctx.fillStyle = barInk;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(tl, barX + 8 * u, typeY + typeH / 2 + u);

  // Rules box.
  const boxX = 17 * u;
  const boxY = typeY + typeH + 5 * u;
  const boxW = w - 34 * u;
  const boxH = h - boxY - 22 * u;
  roundRect(ctx, boxX, boxY, boxW, boxH, 3 * u);
  ctx.fillStyle = rgbCss(mix(mix(fill, [246, 242, 232], 0.84), [255, 255, 255], 0.2));
  ctx.fill();

  const core = face.type?.core ?? [];
  const isBasic = (face.type?.super ?? []).includes('Basic') && core.includes('Land');
  const produced = typeof face.origProduceMana === 'string' ? face.origProduceMana : '';
  if (isBasic && /^[WUBRGC]$/.test(produced)) {
    // A basic land reads best as one large pip.
    const sym: ManaSymbol = produced === 'C' ? { kind: 'colorless' } : { kind: 'color', color: produced as 'W' };
    drawPip(ctx, sym, boxX + boxW / 2, boxY + boxH / 2, Math.min(boxH, boxW) * 0.28);
  } else {
    const text = face.oracleText || (face.keywords ?? []).map((k) => k.title).join(', ');
    const parts = tokenizeRules(text);
    const padX = 8 * u;
    const padY = 7 * u;
    let fs = 12 * u;
    let lines = wrapRich(ctx, parts, boxW - 2 * padX, fs);
    while (rulesHeight(lines, fs) > boxH - 2 * padY && fs > 6.5 * u) {
      fs -= 0.5 * u;
      lines = wrapRich(ctx, parts, boxW - 2 * padX, fs);
    }
    ctx.save();
    roundRect(ctx, boxX, boxY, boxW, boxH, 3 * u);
    ctx.clip();
    let y = boxY + padY + fs * 0.6;
    ctx.fillStyle = '#1B1C1E';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const line of lines) {
      let x = boxX + padX;
      for (const part of line.parts) {
        if (part.kind === 'text') {
          // drawPip changes font and alignment; restore both for every run.
          ctx.font = `400 ${fs}px ${fonts.ui}`;
          ctx.fillStyle = '#1B1C1E';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(part.text, x, y);
        } else if (part.kind === 'loyalty') {
          drawLoyalty(ctx, part.cost, x, y, fs, part.w);
        } else {
          drawPip(ctx, part.token.sym, x + part.w / 2, y, fs * 0.46);
        }
        x += part.w;
      }
      y += fs * 1.22 + line.gapAfter;
    }
    ctx.restore();
  }

  // Footer: set and rarity, small, on the frame.
  ctx.font = `600 ${8 * u}px ${fonts.ui}`;
  ctx.fillStyle = ink === '#17181A' ? 'rgba(20,20,20,0.6)' : 'rgba(240,240,240,0.55)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const footer = [face.setCode, face.rarity && face.rarity !== 'BasicLand' ? face.rarity : ''].filter(Boolean).join(' · ');
  const artist = input.crop?.artist;
  if (artist) {
    // The art's credit rides on the same line, shrunk to the room the P/T box leaves.
    const room = w - 16 * u - (statText(face) ? 58 * u + 20 * u : 16 * u);
    const [line, size] = fitText(ctx, [footer, `Illus. ${artist}`].filter(Boolean).join(' · '), room, 8 * u, 5.5 * u, 600, fonts.ui);
    ctx.font = `600 ${size}px ${fonts.ui}`;
    ctx.fillText(line, 16 * u, h - 13 * u);
  } else {
    ctx.fillText(footer, 16 * u, h - 13 * u);
  }

  // P/T (or loyalty / defense) box.
  const pt = statText(face);
  if (pt) {
    const bw = 58 * u;
    const bh = 26 * u;
    const bx = w - 14 * u - bw;
    const by = h - 10 * u - bh;
    roundRect(ctx, bx, by, bw, bh, 6 * u);
    ctx.fillStyle = rgbCss(barFill);
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1.2 * u);
    ctx.strokeStyle = 'rgba(176,141,87,0.8)';
    ctx.stroke();
    ctx.font = `600 ${20 * u}px ${fonts.numeral}`;
    ctx.fillStyle = barInk;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pt, bx + bw / 2, by + bh / 2 + u);
  }
  ctx.restore();
}

export function statText(face: CardFace): string {
  if (typeof face.power === 'number' || typeof face.toughness === 'number') {
    return `${face.power ?? 0}/${face.toughness ?? 0}`;
  }
  const core = face.type?.core ?? [];
  if (core.includes('Planeswalker') && face.loyalty && face.loyalty !== '0') return face.loyalty;
  if (core.includes('Battle') && face.defense && face.defense !== '0') return face.defense;
  if (core.includes('Creature')) return `${face.power ?? 0}/${face.toughness ?? 0}`;
  return '';
}

// ------------------------------------------------------------------------------------------ adjusted cost

/**
 * Where a face's printed mana cost sits on a card `w` px wide (origin at its top-left): the right edge of the last pip,
 * the pips' centre line, their radius and gap, and the name bar they sit in. `art`: a Scryfall scan, measured on the
 * modern (M15) frame of the 488×680 "normal" scan, ELD through EOE (costPlate.test.ts SCANS: the pips are 20 px
 * across, 26 px apart, centred 50.5 px down, the last one ending at 448; the bar's inside runs 35–66). A planeswalker's
 * scan (`pw`) has the same pips and bar 9.5 px higher (costPlate.test.ts PW_SCANS: ~300 planeswalkers' curated scans,
 * KTK through 2026). Pre-2014 planeswalker frames print smaller pips a little lower; the plate still covers most of them.
 * Else the procedural face (paintCardFace's name bar).
 */
export interface CostSlot {
  right: number;
  cy: number;
  r: number;
  gap: number;
  barTop: number;
  barBottom: number;
}

export function costSlot(w: number, art: boolean, pw = false): CostSlot {
  if (art) {
    const s = w / 488;
    const up = pw ? 9.5 : 0;
    return { right: 448 * s, cy: (50.5 - up) * s, r: 10 * s, gap: 6 * s, barTop: (35 - up) * s, barBottom: (66 - up) * s };
  }
  const u = w / REF_W;
  return { right: w - 20 * u, cy: 28 * u, r: 8.2 * u, gap: 2 * u, barTop: 13 * u, barBottom: 43 * u };
}

/** Whether a face prints a planeswalker's frame (its scan's cost sits elsewhere: {@link costSlot}). */
export function isPwFrame(face: Pick<CardFace, 'type'> | undefined): boolean {
  return !!face?.type?.core?.includes('Planeswalker');
}

/** A hand card's cost right now, painted in its cost slot over the printed one (MTGA). */
export interface CostPlate {
  /** The cost now ("{2}{U}"). */
  cost: string;
  /** The printed cost: the plate covers its pips. */
  printed: string | undefined;
  /** down: cheaper (green), up: dearer (red), same: as much mana in other symbols (amber). */
  tone: 'down' | 'up' | 'same';
  art: boolean;
  /** A planeswalker's scan: its own cost slot ({@link costSlot}). */
  pw?: boolean;
  /** The name bar's colour around the pips (a scan's is sampled: {@link sampleCostBar}). */
  bar: RGB;
}

/** An adjusted cost's tone: down (less mana than printed), up (more), same (as much, in other symbols). */
export function costTone(adjusted: string, printed: string | undefined): CostPlate['tone'] {
  const now = manaValue(adjusted);
  const was = manaValue(printed);
  return now < was ? 'down' : now > was ? 'up' : 'same';
}

/** The tone halo's colour: MTGA's green glow on a reduced cost, red on a taxed one. */
export const COST_TONE: Record<CostPlate['tone'], RGB> = { down: [60, 224, 143], up: [255, 84, 72], same: [251, 191, 36] };

/**
 * The box the plate covers (card px from the top-left): the printed pips and the new ones, whichever run is longer,
 * with air around them; its left `feather` px fade into the bar, so a longer cost slides over the name softly.
 */
export function costPlateBox(w: number, p: Pick<CostPlate, 'cost' | 'printed' | 'art' | 'pw'>): { x: number; y: number; w: number; h: number; feather: number } {
  const s = costSlot(w, p.art, p.pw);
  const n = Math.max(1, tokenizeMana(p.cost).length, tokenizeMana(p.printed).length);
  const span = n * 2 * s.r + (n - 1) * s.gap;
  const pad = s.r * 0.5;
  const feather = s.r * 1.1;
  const x = s.right - span - pad - feather;
  return { x, y: s.cy - s.r - pad, w: s.right + pad - x, h: 2 * (s.r + pad), feather };
}

/**
 * Paint an adjusted cost in a card's cost slot (card px, origin at the card's top-left; the canvas may be translated).
 * `plate` is the bar-coloured backing that hides the printed pips, `pips` the new ones (same size and style as the
 * printed pips) over a halo and a thin ring in the tone colour; `both` paints the two.
 */
export function paintCostPlate(ctx: Ctx2D, w: number, p: CostPlate, layer: 'plate' | 'pips' | 'both' = 'both'): void {
  const s = costSlot(w, p.art, p.pw);
  ctx.save();
  if (layer !== 'pips') {
    const b = costPlateBox(w, p);
    const g = ctx.createLinearGradient(b.x, 0, b.x + b.feather, 0);
    g.addColorStop(0, rgbCss(p.bar, 0));
    g.addColorStop(1, rgbCss(p.bar));
    roundRect(ctx, b.x, b.y, b.w, b.h, b.h * 0.3);
    ctx.fillStyle = g;
    ctx.fill();
  }
  if (layer !== 'plate') {
    const tokens = tokenizeMana(p.cost);
    const tone = COST_TONE[p.tone];
    const step = 2 * s.r + s.gap;
    const x0 = s.right - tokens.length * step + s.gap + s.r;
    // The tone under every pip first, so a neighbour's halo never lies over a pip: a soft halo, a dark keyline (the
    // tone still reads on a frame of its own hue: red on a red card) and the ring.
    tokens.forEach((_, i) => {
      const x = x0 + i * step;
      const halo = ctx.createRadialGradient(x, s.cy, s.r, x, s.cy, s.r * 1.8);
      halo.addColorStop(0, rgbCss(tone, 0.7));
      halo.addColorStop(1, rgbCss(tone, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, s.cy, s.r * 1.8, 0, Math.PI * 2);
      ctx.fill();
    });
    tokens.forEach((_, i) => {
      const x = x0 + i * step;
      ctx.beginPath();
      ctx.arc(x, s.cy, s.r * 1.1, 0, Math.PI * 2);
      ctx.lineWidth = s.r * 0.42;
      ctx.strokeStyle = 'rgba(10,12,16,0.6)';
      ctx.stroke();
      ctx.lineWidth = s.r * 0.22;
      ctx.strokeStyle = rgbCss(tone);
      ctx.stroke();
    });
    tokens.forEach((t, i) => drawPip(ctx, t.sym, x0 + i * step, s.cy, s.r));
  }
  ctx.restore();
}

/**
 * The printed cost, small and struck through, on a dark tab just under the name bar's right end (the big preview only:
 * "it was {4}{U}").
 */
export function paintStruckCost(ctx: Ctx2D, w: number, p: Pick<CostPlate, 'printed' | 'art' | 'pw'> & { slot?: CostSlot }): void {
  const tokens = tokenizeMana(p.printed);
  if (tokens.length === 0) return;
  // `slot`: where another frame (the M15 face) keeps its cost, in the canvas's px.
  const s = p.slot ?? costSlot(w, p.art, p.pw);
  const r = s.r * 0.58;
  const gap = r * 0.25;
  const span = tokens.length * 2 * r + (tokens.length - 1) * gap;
  const cy = s.barBottom + r + s.r * 0.45;
  const padX = r * 0.7;
  ctx.save();
  roundRect(ctx, s.right - span - padX, cy - r - r * 0.35, span + 2 * padX, 2 * r + r * 0.7, r * 0.6);
  ctx.fillStyle = 'rgba(13,15,19,0.84)';
  ctx.fill();
  ctx.globalAlpha = 0.75;
  drawCost(ctx, tokens, s.right, cy, r, gap);
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.moveTo(s.right - span - padX * 0.4, cy + r * 0.25);
  ctx.lineTo(s.right + padX * 0.4, cy - r * 0.25);
  ctx.lineWidth = Math.max(1, r * 0.2);
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#E8EAEE';
  ctx.stroke();
  ctx.restore();
}

/** A scan's name-bar colour when its pixels can't be read: a neutral parchment. */
export const SCAN_BAR: RGB = [214, 206, 192];

/**
 * A scan's name-bar colour by its cost: the per-channel median of the strip right of the last pip and the band above
 * the pips (bar texture, never the pips or the name).
 */
export function sampleCostBar(img: CanvasImageSource, w: number, h: number, pw = false): RGB {
  try {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = c.getContext('2d') as Ctx2D | null;
    if (!ctx) return SCAN_BAR;
    ctx.drawImage(img, 0, 0, w, h);
    const s = costSlot(w, true, pw);
    const px: number[][] = [[], [], []];
    const take = (x: number, y: number, rw: number, rh: number) => {
      const d = ctx.getImageData(Math.round(x), Math.round(y), Math.max(1, Math.round(rw)), Math.max(1, Math.round(rh))).data;
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) px[k]!.push(d[i + k]!);
    };
    take(s.right + s.r * 0.25, s.cy - s.r * 0.7, s.r * 0.45, s.r * 1.4);
    // A thin band just inside the bar's top edge, above the pips (their rays reach up to ~3 px under it).
    take(s.right - 4 * s.r, s.barTop + s.r * 0.05, 4 * s.r, s.r * 0.2);
    const med = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1] ?? 0;
    return [med(px[0]!), med(px[1]!), med(px[2]!)];
  } catch {
    return SCAN_BAR;
  }
}

// ------------------------------------------------------------------------------------------ back

/** The original Kiln card back: graphite, a brass hairline and an abstract anvil mark. */
export function paintCardBack(ctx: Ctx2D, w: number, h: number): void {
  const u = w / REF_W;
  const radius = w * 0.045;
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  roundRect(ctx, 0, 0, w, h, radius);
  ctx.fillStyle = '#101215';
  ctx.fill();
  const inset = 7 * u;
  roundRect(ctx, inset, inset, w - 2 * inset, h - 2 * inset, radius * 0.6);
  const g = ctx.createRadialGradient(w / 2, h * 0.45, 4 * u, w / 2, h * 0.5, h * 0.62);
  g.addColorStop(0, '#2A2F37');
  g.addColorStop(1, '#16191E');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  ctx.clip();
  // Fine cross-hatch, like a machined plate.
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = Math.max(1, u);
  for (let i = -h; i < w + h; i += 9 * u) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + h, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i, h);
    ctx.lineTo(i + h, 0);
    ctx.stroke();
  }
  ctx.restore();
  // Brass hairlines.
  ctx.strokeStyle = 'rgba(176,141,87,0.9)';
  ctx.lineWidth = Math.max(1, 1.4 * u);
  roundRect(ctx, 15 * u, 15 * u, w - 30 * u, h - 30 * u, 6 * u);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(176,141,87,0.35)';
  ctx.lineWidth = Math.max(1, 0.8 * u);
  roundRect(ctx, 21 * u, 21 * u, w - 42 * u, h - 42 * u, 4 * u);
  ctx.stroke();
  // Anvil mark.
  paintAnvil(ctx, w / 2, h * 0.5, 120 * u);
  ctx.restore();
}

/** An abstract anvil (Forge heritage), centred at (cx, cy), `size` wide. */
export function paintAnvil(ctx: Ctx2D, cx: number, cy: number, size: number, color = 'rgba(176,141,87,0.95)'): void {
  const s = size / 120;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.beginPath();
  // Face and horn.
  ctx.moveTo(-58, -22);
  ctx.quadraticCurveTo(-30, -20, -24, -10);
  ctx.lineTo(-18, -10);
  ctx.lineTo(-18, -26);
  ctx.lineTo(52, -26);
  ctx.lineTo(52, -12);
  ctx.quadraticCurveTo(30, -10, 22, 2);
  // Waist.
  ctx.lineTo(18, 14);
  ctx.lineTo(30, 26);
  ctx.lineTo(-30, 26);
  ctx.lineTo(-18, 14);
  ctx.lineTo(-22, 2);
  ctx.quadraticCurveTo(-32, -8, -58, -22);
  ctx.closePath();
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.stroke();
  // Base plate.
  ctx.beginPath();
  ctx.moveTo(-40, 34);
  ctx.lineTo(40, 34);
  ctx.stroke();
  // A spark above the face.
  ctx.beginPath();
  ctx.arc(16, -40, 3, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/** A stable cache key for a face's painted content. `crop`: the image key of the art crop drawn in it, if any. */
export function faceKey(face: CardFace, card?: Pick<Card, 'token'>, crop?: string): string {
  return [
    face.name,
    face.manaCost,
    face.colors,
    typeLine(face, card),
    face.oracleText,
    statText(face),
    face.setCode,
    face.rarity,
    face.origProduceMana,
    ...(crop ? [`crop:${crop}`] : []),
  ].join('\u0001');
}
