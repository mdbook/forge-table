import { describe, expect, it } from 'vitest';
import { manaValue, parseSymbol, tokenizeMana, tokenizeRules } from './mana';

describe('mana tokenizer', () => {
  it('tokenizes generic, coloured, hybrid, phyrexian, variable, colourless and snow symbols', () => {
    const t = tokenizeMana('{2}{U}{R/G}{B/G/P}{X}{C}{S}');
    expect(t.map((x) => x.raw)).toEqual(['2', 'U', 'R/G', 'B/G/P', 'X', 'C', 'S']);
    expect(t.map((x) => x.sym)).toEqual([
      { kind: 'generic', value: '2' },
      { kind: 'color', color: 'U' },
      { kind: 'hybrid', colors: ['R', 'G'] },
      { kind: 'phyrexian', colors: ['B', 'G'] },
      { kind: 'variable', value: 'X' },
      { kind: 'colorless' },
      { kind: 'snow' },
    ]);
  });

  it('handles mono-hybrid, single phyrexian, colourless hybrid, multi-digit generic and tap/untap/energy', () => {
    expect(parseSymbol('2/W')).toEqual({ kind: 'monoHybrid', generic: '2', color: 'W' });
    expect(parseSymbol('W/P')).toEqual({ kind: 'phyrexian', colors: ['W'] });
    expect(parseSymbol('C/G')).toEqual({ kind: 'hybrid', colors: ['C', 'G'] });
    expect(parseSymbol('10')).toEqual({ kind: 'generic', value: '10' });
    expect(parseSymbol('T')).toEqual({ kind: 'tap' });
    expect(parseSymbol('Q')).toEqual({ kind: 'untap' });
    expect(parseSymbol('E')).toEqual({ kind: 'energy' });
    expect(parseSymbol('w')).toEqual({ kind: 'color', color: 'W' });
    expect(parseSymbol('banana')).toEqual({ kind: 'unknown', raw: 'banana' });
  });

  it('ignores text outside braces and empty costs', () => {
    expect(tokenizeMana(undefined)).toEqual([]);
    expect(tokenizeMana('')).toEqual([]);
    expect(tokenizeMana('no cost')).toEqual([]);
  });

  it('computes mana value (X = 0, hybrids = 1, mono-hybrid = its generic)', () => {
    expect(manaValue('{1}{R}')).toBe(2);
    expect(manaValue('{X}{R}{R}')).toBe(2);
    expect(manaValue('{2/W}{2/W}')).toBe(4);
    expect(manaValue('{B/G/P}{U}')).toBe(2);
  });

  it('splits rules text into runs, inline symbols and paragraph breaks', () => {
    const parts = tokenizeRules('({T}: Add {R}.)\r\n\r\nFlash');
    expect(parts.map((p) => p.type)).toEqual(['text', 'sym', 'text', 'sym', 'text', 'break', 'text']);
    expect(parts[1]).toMatchObject({ token: { sym: { kind: 'tap' } } });
    expect(tokenizeRules('<span style="color:gray;">When it enters</span>')).toEqual([{ type: 'text', text: 'When it enters' }]);
  });
});

describe('loyalty costs (Mana font shields)', () => {
  it('a paragraph opening with +1: / −2: / 0: / −X: gets its cost as its own part', () => {
    const parts = tokenizeRules('+1: Draw a card.\n−2: Deal 2 damage.\n0: Untap it.\n-X: Return it. Then +1: not a cost.');
    expect(parts.filter((p) => p.type === 'loyalty').map((p) => (p as { cost: string }).cost)).toEqual(['+1', '−2', '0', '−X']);
    expect(parts[1]).toEqual({ type: 'text', text: 'Draw a card.' });
  });
});
