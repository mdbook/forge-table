/**
 * Kiln design tokens. The chrome tokens mirror theme/tokens.css (the HUD reads the CSS custom
 * properties; Pixi and the canvas card painter read these numbers).
 */

export const chrome = {
  bg: '#0D0F13',
  surface: '#14171C',
  surface2: '#1A1E24',
  surface3: '#222730',
  border: '#272C35',
  borderStrong: '#363C47',
  text: '#E8EAEE',
  textMuted: '#9BA2AE',
  textFaint: '#666D79',
  danger: '#F87171',
  success: '#34D399',
  warning: '#FBBF24',
  ember: '#FF7A33',
  onEmber: '#1C0D03',
  /** A card or player the player has picked (selection prompts, choosers): never the ember "can pick". */
  pick: '#22D3EE',
  onPick: '#04232A',
} as const;

export const table = {
  table: 0x15181d,
  tableLift: 0x1c2027,
  slate: 0x23272e,
  brass: 0xb08d57,
  opponent: 0x5b8def,
  ember: 0xff7a33,
  targetGlow: 0xffe3b0,
  attack: 0xff5a4e,
  block: 0x6fa8ff,
  heal: 0x34d399,
  stackHalo: 0xffb067,
  damage: 0xff5a4e,
  /** Picked (selection clarity): cyan, far from ember on every colour-vision axis; reads on dark felt. */
  pick: 0x22d3ee,
  onPick: 0x04232a,
} as const;

/** Procedural card-face frame colours from CardDetailUtil. */
export const frame = {
  W: [254, 253, 244],
  U: [90, 146, 202],
  B: [32, 34, 31],
  R: [253, 66, 40],
  G: [22, 115, 69],
  multi: [248, 219, 85],
  colorless: [160, 166, 164],
  land: [190, 153, 112],
} as const satisfies Record<string, readonly [number, number, number]>;

export type RGB = readonly [number, number, number];

/** Spell bolts and bursts per colour letter, bright enough to read on the dark table (C = colourless). */
export const fx = { W: 0xfff1c2, U: 0x5ab0ff, B: 0xa874e8, R: 0xff5a2a, G: 0x4fd47a, C: 0xd8dce4 } as const;

/** Original Kiln pip palette: disc fill and glyph colour per mana colour. */
export const pip = {
  W: { fill: '#F3EAC8', glyph: '#2A2620', rim: '#B9AE86' },
  U: { fill: '#3E80C6', glyph: '#F4F8FC', rim: '#245A92' },
  B: { fill: '#3A3633', glyph: '#E6DFD3', rim: '#161412' },
  R: { fill: '#D9492E', glyph: '#FFF4EE', rim: '#9C2A15' },
  G: { fill: '#2F8B58', glyph: '#F0FAF3', rim: '#1A5C37' },
  C: { fill: '#C4C7C5', glyph: '#2B2E30', rim: '#8D9290' },
  generic: { fill: '#CFC9BD', glyph: '#24221F', rim: '#958E80' },
  tap: { fill: '#2E3238', glyph: '#E8EAEE', rim: '#121417' },
  snow: { fill: '#E8F1F6', glyph: '#28506A', rim: '#9DB7C6' },
} as const;

export const fonts = {
  ui: '"Inter Variable", "Inter", system-ui, sans-serif',
  numeral: '"Barlow Condensed", "Arial Narrow", sans-serif',
} as const;

/** Motion tokens (ms). */
export const motion = { micro: 90, short: 160, base: 240, long: 420, epic: 700 } as const;

export function rgbCss([r, g, b]: RGB, a = 1): string {
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}

/** Mix two colours (t = 0 → a, 1 → b). */
export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round) as unknown as RGB;
}

/** Relative luminance (0..1) for choosing light or dark text on a fill. */
export function luminance([r, g, b]: RGB): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
