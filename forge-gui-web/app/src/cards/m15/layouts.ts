/**
 * The M15 layouts as data. A layout is the geometry plus every option where card frames differ (the border's outline, the
 * inner frame's extent, keyline radii, which text-box and stats painters it uses); the painters in `paint.ts` read the
 * spec and never ask which kind of card they're drawing. A new frame (saga, split, adventure…) is a new entry here, and
 * a new piece painter in `paint.ts` only if its box or stats area looks like nothing that exists.
 */
import type { RGB } from './frameStyle';
import { M15_H, M15_W, PW, STD, TOKEN, type M15Geometry, type Rect } from './geometry';
import { parseTypes, type M15Card } from './model';

/** One step of an outline, as the canvas call it makes: line to (x, y), or quadratic curve via (cx, cy) to (x, y). */
export type PathStep = readonly ['L', number, number] | readonly ['Q', number, number, number, number];

export type Radii = [number, number, number, number];

export interface M15LayoutSpec {
  id: 'std' | 'pw' | 'token';
  geo: M15Geometry;
  frame: {
    /** The mottled outer border's outline from its right edge (645, below the top) round the bottom to its left edge (27). */
    border: ReadonlyArray<PathStep>;
    /** Blend the border's colour toward `to` by `t` (a planeswalker's is a darker one); null leaves it as the style has it. */
    borderTint: { to: RGB; t: number } | null;
    /** Whether a legendary card wears the crown. */
    crown: boolean;
    /** The inner frame's left edge, width, top (plain, and under a crown), bottom and corner radii. */
    inner: { x: number; w: number; top: number; crownTop: number; bottom: number; radii: Radii };
  };
  /** The art window's corner radii (its keyline is 3 px out from them). */
  artRadii: Radii;
  /** The text box's paper corner radii (its keyline is 1.5 px out from them). */
  boxRadii: Radii;
  /** Which painter fills the text box (see `BOX` in `paint.ts`). */
  box: 'rules' | 'loyalty';
  /** Which painter fills the stats area (`STATS`). */
  stats: 'pt' | 'loyalty';
  /** How far the name and cost sit below the name plate's middle. */
  nameDy: number;
  /** The foil stamp's centre y. */
  stampY: number;
  /** Whether {@link paintM15Face} skips the box entirely (art shows through) when the card has no text for it: a token's. */
  boxOptional: boolean;
}

const NO_RADII: Radii = [0, 0, 0, 0];

const STD_SPEC: M15LayoutSpec = {
  id: 'std',
  geo: STD,
  frame: {
    border: [
      ['L', 645, 790], ['Q', 645, 836, 628, 846], ['L', 628, 868], ['L', 44, 868], ['L', 44, 846], ['Q', 27, 836, 27, 790],
    ],
    borderTint: null,
    crown: true,
    inner: { x: 44, w: 584, top: 44, crownTop: 40, bottom: 870, radii: [16, 16, 2, 2] },
  },
  artRadii: NO_RADII,
  boxRadii: NO_RADII,
  box: 'rules',
  stats: 'pt',
  nameDy: 1,
  stampY: 873,
  boxOptional: false,
};

/** Planeswalkers: a rounder, darker, narrower border, a rounded art window and the loyalty rows in the box. */
const PW_SPEC: M15LayoutSpec = {
  id: 'pw',
  geo: PW,
  frame: {
    border: [['L', 645, 800], ['Q', 645, 870, 560, 872], ['L', 112, 872], ['Q', 27, 870, 27, 800]],
    borderTint: { to: [128, 100, 88], t: 0.6 },
    crown: false,
    inner: { x: 36, w: 600, top: 30, crownTop: 40, bottom: 872, radii: [14, 14, 60, 60] },
  },
  artRadii: [38, 38, 22, 22],
  boxRadii: [4, 4, 4, 52],
  box: 'loyalty',
  stats: 'loyalty',
  nameDy: 0,
  stampY: 876,
  boxOptional: false,
};

/**
 * Tokens: the standard border and frame, but a tall art window (most prints carry art where a card would have
 * its type line and box) with the type line low over it and the box optional: {@link paintM15Face} only paints it
 * for a token that prints rules text.
 */
const TOKEN_SPEC: M15LayoutSpec = {
  id: 'token',
  geo: TOKEN,
  frame: STD_SPEC.frame,
  artRadii: NO_RADII,
  boxRadii: NO_RADII,
  box: 'rules',
  stats: 'pt',
  nameDy: 1,
  stampY: 873,
  boxOptional: true,
};

/**
 * Which layout a card uses and its boxes in design units (for callers drawing over the face: buffed P/T, cost
 * plates…). `token` is optional so a plain `{ typeLine }` (most callers, which never mean a token) still type-checks.
 */
export function layoutFor(card: Pick<M15Card, 'typeLine'> & { token?: boolean }): M15LayoutSpec {
  if (parseTypes(card.typeLine).planeswalker) return PW_SPEC;
  return card.token ? TOKEN_SPEC : STD_SPEC;
}

// ------------------------------------------------------------------------------------------ P/T plate

/** What the P/T plate prints: power/toughness, a battle's defense, or nothing. */
export function ptText(card: Pick<M15Card, 'typeLine' | 'power' | 'toughness' | 'defense'>): string {
  if (card.power !== '' && card.toughness !== '') return `${card.power}/${card.toughness}`;
  return parseTypes(card.typeLine).battle && card.defense ? card.defense : '';
}

/**
 * Beleren's advance widths at the P/T size (42 px, design units): digits, the slash, signs; anything else as a digit. The
 * bundled Faustina 700 is a little narrower, so its plate only ever has room to spare.
 */
const PT_ADVANCE: Record<string, number> = { '/': 17, '-': 15, '+': 22, '*': 20, '1': 18 };
const PT_DIGIT = 23;
/** Room either side of the P/T text inside its plate. */
const PT_PAD = 16;

/**
 * The P/T plate for `text`: the frame's plate, grown to the left (its right edge stays) when the numbers outgrow it
 * (99/99 and up). The painter and the table's P/T highlight both use it, so the highlight hugs the plate.
 */
export function ptPlate(card: Pick<M15Card, 'typeLine'>, text: string): Rect {
  const pt = layoutFor(card).geo.pt;
  const w = [...text].reduce((n, ch) => n + (PT_ADVANCE[ch] ?? PT_DIGIT), 0) + 2 * PT_PAD;
  return w <= pt.w ? pt : { ...pt, x: pt.x + pt.w - w, w };
}

// ------------------------------------------------------------------------------------------ cost slot

/** The printed mana cost's slot in the name plate (design units): the last pip's right edge, the centre line, pip size and pitch. */
export interface M15CostSlot {
  right: number;
  cy: number;
  /** A pip's diameter, and the distance between two pips' centres. */
  d: number;
  pitch: number;
}

/** Where a layout prints its mana cost; the face painter and the changed-cost overlay both read this. */
export function costSlotOf(layout: Pick<M15LayoutSpec, 'geo' | 'nameDy'>): M15CostSlot {
  const { name } = layout.geo;
  return { right: name.x + name.w - 11, cy: name.y + name.h / 2 - 0.5 + layout.nameDy, d: 32, pitch: 35.2 };
}

/** The slot on a canvas `w`×`h` px, in the shape the shared cost painters take (pip radius `r`, pip `gap`, the name plate's `barTop`/`barBottom`). */
export function costSlotPx(layout: Pick<M15LayoutSpec, 'geo' | 'nameDy'>, w: number, h: number): { right: number; cy: number; r: number; gap: number; barTop: number; barBottom: number } {
  const s = costSlotOf(layout);
  const { name } = layout.geo;
  const kx = w / M15_W;
  const ky = h / M15_H;
  return { right: s.right * kx, cy: s.cy * ky, r: (s.d / 2) * kx, gap: (s.pitch - s.d) * kx, barTop: name.y * ky, barBottom: (name.y + name.h) * ky };
}

/** The centre of pip `i` of `n` in a cost right-aligned in the slot. */
export function pipCentre(slot: M15CostSlot, i: number, n: number): { x: number; y: number } {
  return { x: slot.right - slot.d / 2 - (n - 1 - i) * slot.pitch, y: slot.cy };
}

/**
 * The patch that replaces a changed cost on the name plate (design units): wide enough for the printed pips and the new
 * ones (whichever run is longer) with the plate's own height inside its keylines. Its left `feather` units fade into the
 * plate, so a longer cost slides over the name softly. Stops short of the plate's bulging right end.
 */
export function costPatchBox(layout: Pick<M15LayoutSpec, 'geo' | 'nameDy'>, nPrinted: number, nNew: number): { x: number; y: number; w: number; h: number; feather: number } {
  const slot = costSlotOf(layout);
  const { name } = layout.geo;
  const n = Math.max(1, nPrinted, nNew);
  const feather = slot.d * 0.5;
  const right = name.x + name.w - 9;
  const x = slot.right - (n - 1) * slot.pitch - slot.d - 4 - feather;
  return { x, y: name.y + 2, w: right - x, h: name.h - 4, feather };
}

/** A rectangle in design units as a rectangle on a card `w`×`h` px, origin at the card's centre (where the table's badges are placed). */
export function toCardRect(r: Rect, w: number, h: number): Rect {
  return { x: (r.x / M15_W - 0.5) * w, y: (r.y / M15_H - 0.5) * h, w: (r.w / M15_W) * w, h: (r.h / M15_H) * h };
}
