/**
 * The M15 frame's geometry in design units: the 672×936 grid of Scryfall's "large" scan (63×88 mm, so 1 mm ≈ 10.67
 * units); the painter scales it to any canvas. Measured off reference scans; every box is the plate/box outline
 * including its black keyline.
 */
export const M15_W = 672;
export const M15_H = 936;
/** Design units per mm. */
export const MM = M15_W / 63;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface M15Geometry {
  /** The art image's rectangle (inside its keyline). */
  art: Rect;
  name: Rect;
  type: Rect;
  /** The text box's paper. */
  box: Rect;
  /** The P/T plate. */
  pt: Rect;
}

export const STD: M15Geometry = {
  art: { x: 52, y: 106, w: 568, h: 414 },
  name: { x: 40, y: 44, w: 592, h: 55 },
  type: { x: 40, y: 527, w: 592, h: 54 },
  box: { x: 49, y: 589, w: 573, h: 276 },
  pt: { x: 522, y: 833, w: 111, h: 54 },
};

/** Planeswalkers: a shorter name plate, taller art, and the ability box between the shields. */
export const PW: M15Geometry = {
  art: { x: 52, y: 98, w: 568, h: 358 },
  name: { x: 38, y: 34, w: 596, h: 54 },
  type: { x: 38, y: 462, w: 596, h: 52 },
  box: { x: 80, y: 523, w: 541, h: 335 },
  pt: { x: 540, y: 826, w: 100, h: 62 },
};

/**
 * Tokens: most prints carry full-bleed art where a card would have its type line and rules box, so the art
 * window runs almost to the border and the type line sits low, over the art's bottom edge. That's also where
 * Scryfall's art_crop for these runs into the print's own baked type/collector line (the crop is cut at STD's art
 * coordinates, too short for art this tall), so the opaque type plate covers it. The box sits just above the type
 * line, over the art too; `paintM15Face` only paints it for a token that actually prints rules text; a vanilla one
 * shows clear art the whole way down.
 */
export const TOKEN: M15Geometry = {
  art: { x: 52, y: 106, w: 568, h: 754 },
  name: { x: 40, y: 44, w: 592, h: 55 },
  type: { x: 40, y: 806, w: 592, h: 54 },
  box: { x: 49, y: 702, w: 573, h: 96 },
  pt: { x: 522, y: 833, w: 111, h: 54 },
};

/** The legendary crown's top edge, left to right (the frame's border rises into it), then its right side's descent. */
export const CROWN_TOP: ReadonlyArray<readonly [number, number]> = [
  [21, 82], [23, 48], [38, 27], [56, 36], [74, 40], [106, 41], [121, 24], [162, 38], [209, 40], [267, 26], [279, 31],
  [296, 24], [323, 19], [363, 21], [392, 31], [401, 25], [440, 36], [466, 40], [511, 38], [529, 33], [547, 24], [565, 41],
  [597, 40], [614, 36], [633, 27], [648, 49], [651, 82],
];
/** Right flank from the top-right point down to where the crown meets the border (y ≈ 116), then the left flank up. */
export const CROWN_SIDES = {
  right: [[651, 93], [645, 108], [645, 116]] as ReadonlyArray<readonly [number, number]>,
  left: [[27, 116], [28, 109], [23, 99], [20, 87]] as ReadonlyArray<readonly [number, number]>,
};

/** Fit an image of `sw`×`sh` over a `dw`×`dh` box (CSS object-fit: cover): the source rectangle to draw. */
export function coverRect(sw: number, sh: number, dw: number, dh: number): Rect {
  const s = Math.max(dw / sw, dh / sh);
  const w = dw / s;
  const h = dh / s;
  return { x: (sw - w) / 2, y: (sh - h) / 2, w, h };
}
