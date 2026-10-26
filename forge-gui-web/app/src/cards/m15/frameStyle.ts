/**
 * Which M15 frame a card wears and the palette it paints with: coloured frames per colour, gold for multicolour (two
 * colours show as a coloured pinline per side, three or more a plain gold one), artifact silver for colourless cards,
 * and the tan land frame whose pinlines and text box take on the colours the land produces. Pure; no canvas.
 */
import type { M15Card } from './model';
import { parseTypes } from './model';

export type RGB = readonly [number, number, number];

export type FrameKind = 'mono' | 'gold' | 'artifact' | 'land';

export interface FrameStyle {
  kind: FrameKind;
  /** The colours the frame shows, WUBRG order (a land's produced colours; an artifact's none). */
  colors: string;
  /** The mottled outer border's base colour. */
  strip: RGB;
  /** The saturated inner frame (around the art and plates): the left and right colour (equal for one colour). */
  pin: [RGB, RGB];
  /** The name, type and P/T plates' base colour. */
  plate: RGB;
  /** The text box's paper: left and right colour (equal unless the frame is two-coloured). */
  tbox: [RGB, RGB];
}

const PIN: Record<string, RGB> = {
  W: [246, 244, 237],
  U: [28, 116, 178],
  B: [36, 35, 35],
  R: [226, 74, 50],
  G: [14, 112, 70],
  gold: [208, 178, 88],
  silver: [216, 223, 227],
  land: [160, 128, 92],
};

/** Creature/spell frames, by colour: [strip, plate, text box]. */
const MONO: Record<string, [RGB, RGB, RGB]> = {
  W: [[214, 206, 168], [243, 243, 237], [240, 240, 232]],
  U: [[96, 158, 212], [194, 217, 241], [219, 232, 250]],
  B: [[92, 90, 96], [196, 190, 186], [212, 207, 203]],
  R: [[204, 84, 66], [241, 201, 183], [244, 226, 226]],
  G: [[84, 136, 100], [190, 209, 200], [212, 228, 219]],
};

/** A land's text box tint per produced colour (stronger than a spell's: the box is the land's identity). */
const LAND_TBOX: Record<string, RGB> = {
  W: [236, 230, 208],
  U: [172, 205, 234],
  B: [186, 176, 172],
  R: [236, 160, 136],
  G: [180, 214, 194],
  C: [210, 205, 200],
};

const GOLD: [RGB, RGB, RGB] = [[200, 178, 112], [212, 194, 140], [232, 232, 226]];
const ARTIFACT: [RGB, RGB, RGB] = [[162, 192, 203], [208, 216, 220], [205, 218, 223]];
const LAND_NEUTRAL: [RGB, RGB, RGB] = [[179, 147, 121], [206, 200, 195], [214, 204, 190]];

/** A pale tint of a pinline colour for a two-colour gold card's text box (blended towards the gold box's white). */
function tint(c: RGB, k: number): RGB {
  return [Math.round(c[0] + (244 - c[0]) * k), Math.round(c[1] + (244 - c[1]) * k), Math.round(c[2] + (240 - c[2]) * k)];
}

export function frameStyle(card: Pick<M15Card, 'colors' | 'typeLine' | 'produced'>): FrameStyle {
  const t = parseTypes(card.typeLine);
  const colors = card.colors.length > 0 ? card.colors : '';
  if (t.land && !t.creature) {
    const prod = [...new Set(card.produced.split(''))].filter((c) => 'WUBRGC'.includes(c));
    const real = prod.filter((c) => c !== 'C');
    if (t.basic && real.length === 1) {
      const c = real[0]!;
      const strip = LAND_NEUTRAL[0];
      return { kind: 'land', colors: c, strip, pin: [PIN[c]!, PIN[c]!], plate: MONO[c]![1], tbox: [LAND_TBOX[c]!, LAND_TBOX[c]!] };
    }
    if (real.length === 2) {
      const [a, b] = real as [string, string];
      return { kind: 'land', colors: real.join(''), strip: LAND_NEUTRAL[0], pin: [PIN[a]!, PIN[b]!], plate: LAND_NEUTRAL[1], tbox: [LAND_TBOX[a]!, LAND_TBOX[b]!] };
    }
    if (real.length === 1) {
      const c = real[0]!;
      return { kind: 'land', colors: c, strip: LAND_NEUTRAL[0], pin: [PIN[c]!, PIN[c]!], plate: LAND_NEUTRAL[1], tbox: [LAND_TBOX[c]!, LAND_TBOX[c]!] };
    }
    const pin = real.length >= 3 ? PIN.gold! : PIN.land!;
    return { kind: 'land', colors: real.join(''), strip: LAND_NEUTRAL[0], pin: [pin, pin], plate: LAND_NEUTRAL[1], tbox: [LAND_NEUTRAL[2], LAND_NEUTRAL[2]] };
  }
  if (colors.length >= 2) {
    const [strip, plate, tbox] = GOLD;
    if (colors.length === 2) {
      const a = colors[0]!;
      const b = colors[1]!;
      return { kind: 'gold', colors, strip, pin: [PIN[a]!, PIN[b]!], plate, tbox: [tint(PIN[a]!, 0.9), tint(PIN[b]!, 0.9)] };
    }
    return { kind: 'gold', colors, strip, pin: [PIN.gold!, PIN.gold!], plate, tbox: [tbox, tbox] };
  }
  if (colors.length === 1) {
    const c = colors;
    const [strip, plate, tbox] = MONO[c]!;
    return { kind: 'mono', colors: c, strip, pin: [PIN[c]!, PIN[c]!], plate, tbox: [tbox, tbox] };
  }
  const [strip, plate, tbox] = ARTIFACT;
  return { kind: 'artifact', colors: '', strip, pin: [PIN.silver!, PIN.silver!], plate, tbox: [tbox, tbox] };
}
