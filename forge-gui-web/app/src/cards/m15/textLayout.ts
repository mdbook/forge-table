/**
 * Rules-text layout for the M15 face: paragraphs of text runs and inline mana symbols, word-wrapped to a width, with the
 * font size shrunk until the block fits its box. All pure: widths come from a `Measure` (the canvas painter measures
 * with the real fonts; the tests with a fixed-pitch stand-in).
 */

export type Run = { kind: 'text'; text: string; italic: boolean } | { kind: 'sym'; raw: string };

export interface Measure {
  /** Width of `text` set at `size` px (italic or roman). */
  text(text: string, italic: boolean, size: number): number;
  /** Width of one inline mana symbol at `size` px. */
  sym(raw: string, size: number): number;
}

/** Typographic quotes for the straight ones Scryfall/Forge text carries: apostrophes, and opening/closing double quotes. */
export function smartQuotes(s: string): string {
  return s
    .replace(/(^|[\s(\u2014[{])"/gm, '$1\u201c')
    .replace(/"/g, '\u201d')
    .replace(/(^|[\s(\u2014])'/g, '$1\u2018')
    .replace(/'/g, '\u2019');
}

/**
 * Paragraphs of runs from card text: `\n` splits paragraphs, `{X}` is a symbol, and a parenthesised span (reminder text)
 * is italic. `italic` sets the whole text italic (flavor text). `*word*` (the markdown Scryfall's flavor text carries for
 * emphasis) flips italic for the span, as printed cards do (a roman word in italic flavor); the asterisks are never
 * painted, and a lone unmatched one is dropped.
 */
export function parseRuns(text: string, italic = false): Run[][] {
  const paras: Run[][] = [];
  for (const line of smartQuotes(text.replace(/\r/g, '')).split('\n')) {
    if (line.trim() === '') continue;
    const runs: Run[] = [];
    let depth = 0;
    let flip = false;
    let buf = '';
    const flush = () => {
      if (buf) runs.push({ kind: 'text', text: buf, italic: (italic || depth > 0) !== flip });
      buf = '';
    };
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '*') {
        // An opening mark needs a closing one later on the line; a stray one is just dropped.
        if (flip || line.indexOf('*', i + 1) > i) {
          flush();
          flip = !flip;
        }
        continue;
      }
      if (ch === '{') {
        const end = line.indexOf('}', i);
        if (end > i) {
          flush();
          runs.push({ kind: 'sym', raw: line.slice(i + 1, end) });
          i = end;
          continue;
        }
      }
      if (ch === '(') {
        flush();
        depth++;
        buf += ch;
        continue;
      }
      buf += ch;
      if (ch === ')' && depth > 0) {
        flush();
        depth--;
      }
    }
    flush();
    paras.push(runs);
  }
  return paras;
}

export interface LineItem {
  run: Run;
  x: number;
  w: number;
}

export interface Line {
  items: LineItem[];
  /** Index of the paragraph this line belongs to (into the list given to `layoutParas`). */
  para: number;
}

/** A word-wrapped, unbreakable piece: runs with no whitespace between them. */
interface Chunk {
  parts: Array<{ run: Run; w: number }>;
  w: number;
  /** Width of the space after it (0 at the paragraph's end). */
  gap: number;
}

function chunks(para: Run[], m: Measure, size: number): Chunk[] {
  const out: Chunk[] = [];
  let cur: Chunk = { parts: [], w: 0, gap: 0 };
  const push = () => {
    if (cur.parts.length > 0) out.push(cur);
    cur = { parts: [], w: 0, gap: 0 };
  };
  for (const run of para) {
    if (run.kind === 'sym') {
      const w = m.sym(run.raw, size);
      cur.parts.push({ run, w });
      cur.w += w;
      continue;
    }
    for (const piece of run.text.split(/(\s+)/)) {
      if (piece === '') continue;
      if (/^\s+$/.test(piece)) {
        cur.gap = m.text(' ', run.italic, size);
        push();
        continue;
      }
      const w = m.text(piece, run.italic, size);
      cur.parts.push({ run: { kind: 'text', text: piece, italic: run.italic }, w });
      cur.w += w;
    }
  }
  push();
  return out;
}

/** Wrap paragraphs to `width` at `size` px; a chunk wider than the line goes on a line of its own. */
export function layoutParas(paras: Run[][], m: Measure, size: number, width: number, firstPara = 0): Line[] {
  const lines: Line[] = [];
  paras.forEach((para, pi) => {
    let line: Line = { items: [], para: firstPara + pi };
    let x = 0;
    let pendingGap = 0;
    for (const ch of chunks(para, m, size)) {
      if (x > 0 && x + pendingGap + ch.w > width + 0.01) {
        lines.push(line);
        line = { items: [], para: firstPara + pi };
        x = 0;
        pendingGap = 0;
      }
      if (x > 0) x += pendingGap;
      for (const p of ch.parts) {
        line.items.push({ run: p.run, x, w: p.w });
        x += p.w;
      }
      pendingGap = ch.gap;
    }
    if (line.items.length > 0) lines.push(line);
  });
  return lines;
}

export interface FitOptions {
  /** Largest and smallest font size tried, px; it steps down by `step`. */
  max: number;
  min: number;
  step?: number;
  /**
   * Line pitch = `lineBase` px + `lineRatio` × the font size. Printed cards' pitch grows slower than their type (a
   * constant-ratio pitch is too loose on small text and too tight on large), so the pair is fitted to the scans.
   */
  lineRatio?: number;
  lineBase?: number;
  /**
   * Extra air between paragraphs and between the rules and the flavor text, in design px: printed cards keep these gaps
   * constant (~10.5 and ~28 on the 672-wide scan) whatever size the text was fitted to.
   */
  paraGap?: number;
  flavorGap?: number;
  /**
   * Flavor text is set at `flavorScale` of the rules size (printed cards set it a little smaller) with a pitch of
   * `flavorRatio` of its own size; `fitBlock` shrinks it down to `flavorScaleMin` before it shrinks the rules text.
   */
  flavorScale?: number;
  flavorScaleMin?: number;
  flavorRatio?: number;
}

export interface TextBlock {
  size: number;
  lineH: number;
  lines: Array<Line & { y: number; size: number; h: number }>;
  /** y (from the block's top) of the divider between rules and flavor text, or null. */
  divider: number | null;
  height: number;
  /** The block didn't fit even at the smallest size. */
  overflow: boolean;
}

/** Lay out rules and flavor paragraphs at one size. */
export function layoutBlock(rules: Run[][], flavor: Run[][], m: Measure, size: number, width: number, o: Pick<FitOptions, 'lineBase' | 'lineRatio' | 'paraGap' | 'flavorGap' | 'flavorScale' | 'flavorRatio'> = {}): TextBlock {
  const lineH = (o.lineBase ?? 0) + size * (o.lineRatio ?? 1.1);
  const paraGap = o.paraGap ?? 10.5;
  const flavorGap = o.flavorGap ?? 28;
  const rl = layoutParas(rules, m, size, width);
  const fsize = size * (o.flavorScale ?? 1);
  const fl = layoutParas(flavor, m, fsize, width, rules.length);
  const flavorH = (o.lineBase ?? 0) + fsize * (o.flavorRatio ?? o.lineRatio ?? 1.1);
  const lines: Array<Line & { y: number; size: number; h: number }> = [];
  let y = 0;
  let prev = -1;
  let divider: number | null = null;
  for (const l of [...rl, ...fl]) {
    if (prev >= 0 && l.para !== prev) {
      if (l.para === rules.length && rules.length > 0) {
        divider = y + flavorGap / 2;
        y += flavorGap;
      } else y += paraGap;
    }
    const isFlavor = l.para >= rules.length;
    const h = isFlavor ? flavorH : lineH;
    lines.push({ ...l, y, size: isFlavor ? fsize : size, h });
    y += h;
    prev = l.para;
  }
  return { size, lineH, lines, divider, height: y, overflow: false };
}

/** The largest size in [min, max] at which the block fits `height`. */
export function fitBlock(rules: Run[][], flavor: Run[][], m: Measure, width: number, height: number, o: FitOptions): TextBlock {
  const step = o.step ?? 0.5;
  const hi = o.flavorScale ?? 1;
  const lo = Math.min(hi, o.flavorScaleMin ?? hi);
  let size = o.max;
  for (;;) {
    // Shrink the flavor text first (down to its floor), then the whole block.
    for (let f = hi; f >= lo - 1e-6; f -= 0.01) {
      const b = layoutBlock(rules, flavor, m, size, width, { ...o, flavorScale: f });
      if (b.height <= height) return b;
    }
    if (size - step < o.min - 1e-6) return { ...layoutBlock(rules, flavor, m, size, width, { ...o, flavorScale: lo }), overflow: true };
    size -= step;
  }
}

// ------------------------------------------------------------------------------------------ planeswalker

export interface PwAbility {
  /** The loyalty cost as shown on the shield: "+1", "−3", "0", "−X"; null for a static line (no shield). */
  cost: string | null;
  text: string;
}

const COST = /^\s*([+−–-]?\d+|[+−–-]X|0)\s*:\s*/;

/** A planeswalker's rules text as its ability rows: each line opens with `+N:` / `−N:` / `0:` or is a plain line. */
export function parsePwAbilities(rules: string): PwAbility[] {
  const out: PwAbility[] = [];
  for (const line of rules.replace(/\r/g, '').split('\n')) {
    if (line.trim() === '') continue;
    const m = COST.exec(line);
    if (!m) {
      out.push({ cost: null, text: line.trim() });
      continue;
    }
    let cost = m[1]!;
    const sign = cost[0]!;
    if (sign === '-' || sign === '–') cost = `−${cost.slice(1)}`;
    out.push({ cost, text: line.slice(m[0].length).trim() });
  }
  return out;
}

export type LoyaltyKind = 'up' | 'down' | 'zero';

/** Which badge silhouette a loyalty cost wears: a +N one points up, a −N one points down, a 0 one is flat. */
export function loyaltyKind(cost: string): LoyaltyKind {
  const c = cost.trim();
  if (/^[−–-]/.test(c)) return 'down';
  if (/^0+$/.test(c)) return 'zero';
  return 'up';
}

export interface PwRow {
  ability: PwAbility;
  lines: Line[];
  /** The row's top and height inside the box (box coordinates). */
  y: number;
  h: number;
}

export interface PwBlock {
  size: number;
  lineH: number;
  rows: PwRow[];
  overflow: boolean;
}

/**
 * Lay a planeswalker's abilities out in a box `height` tall: each ability wraps to `width` (the room right of its shield),
 * the font shrinks until the rows fit (a row is never shorter than `minRow`, the shield), and the spare height is shared
 * evenly so the rows fill the box as printed ones do.
 */
export function layoutPw(abilities: PwAbility[], m: Measure, width: number, height: number, o: { max: number; min: number; minRow: number; step?: number; lineRatio?: number; rowPad?: number; spareToLast?: boolean }): PwBlock {
  const step = o.step ?? 0.5;
  const lineRatio = o.lineRatio ?? 1.1;
  const pad = o.rowPad ?? 14;
  let size = o.max;
  for (;;) {
    const lineH = size * lineRatio;
    const laid = abilities.map((a) => layoutParas(parseRuns(a.text), m, size, width));
    const natural = laid.map((l) => Math.max(o.minRow, l.length * lineH + pad));
    const total = natural.reduce((s, h) => s + h, 0);
    if (total <= height || size - step < o.min - 1e-6) {
      const left = Math.max(0, height - total);
      const spare = o.spareToLast ? 0 : left / Math.max(1, abilities.length);
      let y = 0;
      const rows = abilities.map((ability, i) => {
        const h = natural[i]! + spare + (o.spareToLast && i === abilities.length - 1 ? left : 0);
        const row = { ability, lines: laid[i]!, y, h };
        y += h;
        return row;
      });
      return { size, lineH, rows, overflow: total > height };
    }
    size -= step;
  }
}
