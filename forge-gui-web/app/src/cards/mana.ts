/**
 * Mana-symbol tokenizer for the procedural card face. Extends Forge's symbol grammar to
 * three-part hybrids such as `{B/G/P}`. Symbols are drawn as Kiln pips (coloured discs) carrying the Mana font's
 * glyphs (theme/manaFont.ts), with letters until the font has loaded.
 */

export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G';

export type ManaSymbol =
  | { kind: 'generic'; value: string }
  | { kind: 'variable'; value: string }
  | { kind: 'color'; color: ManaColor }
  | { kind: 'colorless' }
  | { kind: 'snow' }
  /** Two colours, `{W/U}` (or a colourless hybrid `{C/W}`: colors `['C','W']`). */
  | { kind: 'hybrid'; colors: [ManaColor | 'C', ManaColor] }
  /** `{2/W}`: pay two generic or one coloured. */
  | { kind: 'monoHybrid'; generic: string; color: ManaColor }
  /** `{W/P}`, or the hybrid phyrexian `{B/G/P}`. */
  | { kind: 'phyrexian'; colors: ManaColor[] }
  | { kind: 'tap' }
  | { kind: 'untap' }
  | { kind: 'energy' }
  | { kind: 'half'; color?: ManaColor }
  | { kind: 'unknown'; raw: string };

export interface ManaToken {
  /** The text between the braces, e.g. `B/G/P`. */
  raw: string;
  sym: ManaSymbol;
}

const COLORS = new Set(['W', 'U', 'B', 'R', 'G']);
const isColor = (s: string): s is ManaColor => COLORS.has(s);

/** Classify the inside of one `{…}`. */
export function parseSymbol(inner: string): ManaSymbol {
  const s = inner.trim().toUpperCase();
  if (/^\d+$/.test(s) || s === '∞' || s === '½') return { kind: 'generic', value: s };
  if (s === 'X' || s === 'Y' || s === 'Z') return { kind: 'variable', value: s };
  if (isColor(s)) return { kind: 'color', color: s };
  switch (s) {
    case 'C':
      return { kind: 'colorless' };
    case 'S':
      return { kind: 'snow' };
    case 'T':
      return { kind: 'tap' };
    case 'Q':
      return { kind: 'untap' };
    case 'E':
      return { kind: 'energy' };
    case 'H':
    case 'P':
      // A lone {P} (generic phyrexian) or half mana with no colour.
      return s === 'H' ? { kind: 'half' } : { kind: 'phyrexian', colors: [] };
  }
  const parts = s.split('/');
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]!;
    if (last === 'P') {
      const cols = parts.slice(0, -1);
      if (cols.every(isColor)) return { kind: 'phyrexian', colors: cols as ManaColor[] };
    }
    if (parts.length === 2) {
      const [a, b] = parts as [string, string];
      if (isColor(a) && isColor(b)) return { kind: 'hybrid', colors: [a, b] };
      if (a === 'C' && isColor(b)) return { kind: 'hybrid', colors: ['C', b] };
      if (/^\d+$/.test(a) && isColor(b)) return { kind: 'monoHybrid', generic: a, color: b };
      if (a === 'H' && isColor(b)) return { kind: 'half', color: b };
    }
  }
  if (s.startsWith('H') && s.length === 2 && isColor(s[1]!)) return { kind: 'half', color: s[1] as ManaColor };
  return { kind: 'unknown', raw: inner };
}

/** Tokenize a mana cost such as `{2}{U}{R/G}{B/G/P}`. Text outside braces is ignored. */
export function tokenizeMana(cost: string | undefined | null): ManaToken[] {
  if (!cost) return [];
  const out: ManaToken[] = [];
  const re = /\{([^{}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cost)) !== null) out.push({ raw: m[1]!, sym: parseSymbol(m[1]!) });
  return out;
}

export type RichPart = { type: 'text'; text: string } | { type: 'sym'; token: ManaToken } | { type: 'break' } | { type: 'loyalty'; cost: string };

/** A planeswalker ability's cost at the start of a paragraph: "+1:", "−2:", "0:", "−X:". */
const LOYALTY_COST = /^\s*([+−–-]?)(\d+|X)\s*:\s*/;

/** Split rules text into text runs, inline symbols and paragraph breaks. */
export function tokenizeRules(text: string | undefined | null): RichPart[] {
  if (!text) return [];
  const out: RichPart[] = [];
  const clean = text.replace(/\r/g, '').replace(/<[^>]+>/g, '');
  const re = /\{([^{}]+)\}|\n/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    if (m.index > last) out.push({ type: 'text', text: clean.slice(last, m.index) });
    if (m[0] === '\n') {
      if (out.length > 0 && out[out.length - 1]!.type !== 'break') out.push({ type: 'break' });
    } else {
      out.push({ type: 'sym', token: { raw: m[1]!, sym: parseSymbol(m[1]!) } });
    }
    last = m.index + m[0].length;
  }
  if (last < clean.length) out.push({ type: 'text', text: clean.slice(last) });
  return loyaltyCosts(out);
}

/** Paragraphs that open with a loyalty cost get it as its own part (drawn as the Mana font's shield). */
function loyaltyCosts(parts: RichPart[]): RichPart[] {
  const out: RichPart[] = [];
  parts.forEach((p, i) => {
    const m = p.type === 'text' && (i === 0 || parts[i - 1]!.type === 'break') ? LOYALTY_COST.exec(p.text) : null;
    if (!m || p.type !== 'text') {
      out.push(p);
      return;
    }
    const sign = m[1] === '+' ? '+' : m[1] ? '−' : '';
    out.push({ type: 'loyalty', cost: `${sign}${m[2]}` });
    const rest = p.text.slice(m[0].length);
    if (rest) out.push({ type: 'text', text: rest });
  });
  return out;
}

/** Mana value of a cost (X counts 0), for sorting and tests. */
export function manaValue(cost: string | undefined | null): number {
  let v = 0;
  for (const { sym } of tokenizeMana(cost)) {
    switch (sym.kind) {
      case 'generic':
        v += Number.parseInt(sym.value, 10) || 0;
        break;
      case 'monoHybrid':
        v += Number.parseInt(sym.generic, 10) || 0;
        break;
      case 'variable':
      case 'tap':
      case 'untap':
      case 'energy':
      case 'unknown':
        break;
      case 'half':
        v += 0.5;
        break;
      default:
        v += 1;
    }
  }
  return v;
}
