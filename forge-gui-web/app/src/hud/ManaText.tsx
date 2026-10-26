/**
 * Text with Forge's mana and tap symbols ({R}, {2/W}, {T}…) shown as Mana-font pips, like the card faces (use
 * the Mana font wherever it helps). Anything the font has no symbol for stays as written.
 */
import { Fragment, type CSSProperties } from 'react';
import { parseSymbol, type ManaSymbol } from '../cards/mana';
import { msGlyph } from '../theme/manaFont';
import { pip } from '../theme/tokens';

type PipStyle = { fill: string; glyph: string };
const style = (c: string): PipStyle => (pip as Record<string, PipStyle>)[c] ?? pip.generic;

/** A pip's glyphs and colours, or null when the font has no symbol for it. */
export function pipView(sym: ManaSymbol): { glyphs: string; css: CSSProperties } | null {
  const one = (name: string, s: PipStyle) => {
    const g = msGlyph(name);
    return g ? { glyphs: g, css: { background: s.fill, color: s.glyph } } : null;
  };
  switch (sym.kind) {
    case 'color':
      return one(sym.color, style(sym.color));
    case 'generic':
    case 'variable':
      return one(sym.value, pip.generic);
    case 'colorless':
      return one('c', pip.C);
    case 'snow':
      return one('s', pip.snow);
    case 'tap':
    case 'untap':
      return one(sym.kind, pip.tap);
    case 'energy':
      return one('e', pip.tap);
    case 'phyrexian':
      return one('p', style(sym.colors[0] ?? 'C'));
    case 'hybrid':
    case 'monoHybrid': {
      const [a, b] = sym.kind === 'hybrid' ? sym.colors : [sym.generic, sym.color];
      const ga = msGlyph(a);
      const gb = msGlyph(b);
      if (!ga || !gb) return null;
      const fa = sym.kind === 'hybrid' ? style(a).fill : pip.generic.fill;
      return { glyphs: ga + gb, css: { background: `linear-gradient(135deg, ${fa} 50%, ${style(b).fill} 50%)`, color: '#1b1b1b' } };
    }
    default:
      return null;
  }
}

export function ManaText({ text }: { text: string }) {
  const parts = text.split(/(\{[^{}]{1,9}\})/);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{p}</Fragment>;
        const sym = parseSymbol(p.slice(1, -1));
        const v = pipView(sym);
        if (!v) return <Fragment key={i}>{p}</Fragment>;
        // Two-digit generics ({12}) are one wide glyph: shrink it inside the circle so it keeps some padding.
        const wide = (sym.kind === 'generic' || sym.kind === 'variable') && sym.value.length > 1;
        return (
          <span key={i} className={`ms-pip${v.glyphs.length > 1 ? ' split' : ''}`} style={v.css} role="img" aria-label={p}>
            {wide ? <span className="ms-pip-wide">{v.glyphs}</span> : v.glyphs}
          </span>
        );
      })}
    </>
  );
}
