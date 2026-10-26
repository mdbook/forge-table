import { describe, expect, it } from 'vitest';
import { frameStyle } from './frameStyle';
import { M15_H, M15_W, STD } from './geometry';
import { damagedToughness, keywordBoxes, markBoxes, MAX_COINS, showsBox } from './paint';
import { layoutFor, ptPlate, ptText } from './layouts';
import { landWatermark, printedRules } from './model';
import { fitBlock, layoutBlock, layoutPw, layoutParas, loyaltyKind, parsePwAbilities, parseRuns, smartQuotes, type Measure } from './textLayout';

/** A fixed-pitch stand-in for the canvas: every glyph is 0.5 em wide, a symbol 0.8 em. */
const mono: Measure = { text: (t, _i, size) => t.length * size * 0.5, sym: (_r, size) => size * 0.8 };

describe('textLayout', () => {
  it('turns straight quotes into typographic ones', () => {
    expect(smartQuotes(`"Hi," it didn't say`)).toBe('“Hi,” it didn’t say');
  });

  it('parses symbols, reminder text and paragraphs', () => {
    const paras = parseRuns('{T}: Add {G}. (Reminder.)\nSecond');
    expect(paras).toHaveLength(2);
    expect(paras[0]!.map((r) => r.kind)).toEqual(['sym', 'text', 'sym', 'text', 'text']);
    const last = paras[0]![4]!;
    expect(last.kind === 'text' && last.italic).toBe(true);
  });

  it('wraps to the width and keeps the flavor text apart from the rules', () => {
    const rules = parseRuns('aaaa bbbb cccc dddd');
    const flavor = parseRuns('ee ff', true);
    const b = layoutBlock(rules, flavor, mono, 10, 50, { lineRatio: 1, flavorScale: 0.5, flavorRatio: 1 });
    // 10px glyphs are 5px wide: a 4-letter word is 20px, so two words (45px with the space) fit a 50px line.
    expect(b.lines.filter((l) => l.para === 0)).toHaveLength(2);
    expect(b.divider).not.toBeNull();
    const fl = b.lines.find((l) => l.para === 1)!;
    expect(fl.size).toBe(5);
    expect(fl.h).toBe(5);
  });

  it('shrinks the flavor text before the rules text', () => {
    const rules = parseRuns('aaaa bbbb');
    const flavor = parseRuns('word '.repeat(30), true);
    const free = fitBlock(rules, flavor, mono, 200, 10000, { max: 20, min: 8, flavorScale: 1, flavorScaleMin: 0.5 });
    expect(free.size).toBe(20);
    const tight = fitBlock(rules, flavor, mono, 200, 140, { max: 20, min: 8, flavorScale: 1, flavorScaleMin: 0.5 });
    expect(tight.size).toBe(20);
    expect(tight.lines.find((l) => l.para === 1)!.size).toBeLessThan(20);
    expect(tight.height).toBeLessThanOrEqual(140);
  });

  it('flags text that cannot fit even at the smallest size', () => {
    const b = fitBlock(parseRuns('word '.repeat(200)), [], mono, 100, 20, { max: 20, min: 10 });
    expect(b.overflow).toBe(true);
  });
});

describe('fit-to-box text sizing', () => {
  const rules = parseRuns('word '.repeat(40));
  const opts = { max: 36, min: 14, step: 0.5, lineBase: 17, lineRatio: 0.45, paraGap: 10, flavorGap: 28 };

  it('keeps the largest size when the text is short', () => {
    expect(fitBlock(parseRuns('Flying'), [], mono, 500, 250, opts).size).toBe(36);
  });

  it('picks the largest half-pixel step that fits, and the next one up would not', () => {
    const b = fitBlock(rules, [], mono, 400, 200, opts);
    expect(b.overflow).toBe(false);
    expect(b.height).toBeLessThanOrEqual(200);
    expect(b.size).toBeLessThan(36);
    expect(b.size % 0.5).toBe(0);
    const bigger = layoutBlock(rules, [], mono, b.size + 0.5, 400, opts);
    expect(bigger.height).toBeGreaterThan(200);
  });

  it('shrinks monotonically as the box gets shorter', () => {
    const sizes = [260, 200, 150, 110].map((h) => fitBlock(rules, parseRuns('flavor words here', true), mono, 400, h, opts).size);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(sizes[3]).toBeLessThan(sizes[0]!);
  });

  it('sets rules and flavor at one size, with a constant px pitch and gaps', () => {
    const b = layoutBlock(parseRuns('a\nb'), parseRuns('c', true), mono, 30, 500, opts);
    const pitch = 17 + 0.45 * 30;
    const ys = b.lines.map((l) => l.y);
    expect(b.lines.every((l) => l.size === 30)).toBe(true);
    expect(ys[1]! - ys[0]!).toBeCloseTo(pitch + 10);
    expect(ys[2]! - ys[1]!).toBeCloseTo(pitch + 28);
    expect(b.divider).toBeCloseTo(ys[1]! + pitch + 14);
  });
});

describe('markdown asterisks in card text', () => {
  const texts = (s: string, italic = false) => parseRuns(s, italic)[0]!.map((r) => (r.kind === 'text' ? [r.text, r.italic] : r.raw));

  it('flips italics for *emphasis* and never paints the asterisks', () => {
    expect(texts('do *that*, you', true)).toEqual([['do ', true], ['that', false], [', you', true]]);
    expect(texts('a *b* c')).toEqual([['a ', false], ['b', true], [' c', false]]);
    expect(parseRuns('*x*')[0]!.every((r) => r.kind !== 'text' || !r.text.includes('*'))).toBe(true);
  });

  it('drops a lone unmatched asterisk and lets emphasis span a symbol', () => {
    expect(texts('Ward 1*')).toEqual([['Ward 1', false]]);
    expect(texts('*pay {2}*')).toEqual([['pay ', true], '2']);
  });

  it('keeps emphasised words attached to punctuation as one unbreakable chunk', () => {
    const lines = layoutParas(parseRuns('go *far*, now'), mono, 10, 25);
    expect(lines[0]!.items.map((i) => (i.run.kind === 'text' ? i.run.text : '')).join('')).toBe('go');
    expect(lines[1]!.items.map((i) => (i.run.kind === 'text' ? i.run.text : '')).join('')).toBe('far,');
  });
});

describe('printedRules', () => {
  it('omits a basic land’s mana reminder but keeps other rules text', () => {
    expect(printedRules({ typeLine: 'Basic Land — Forest', rules: '({T}: Add {G}.)' })).toBe('');
    expect(printedRules({ typeLine: 'Land — Island Mountain', rules: '({T}: Add {U} or {R}.)' })).toBe('({T}: Add {U} or {R}.)');
    expect(printedRules({ typeLine: 'Basic Snow Land — Forest', rules: '{T}: Add {G}.' })).toBe('{T}: Add {G}.');
  });
});

describe('loyaltyKind', () => {
  it('picks the badge silhouette from the cost sign', () => {
    expect(['+1', '+X', '3'].map(loyaltyKind)).toEqual(['up', 'up', 'up']);
    expect(['−3', '-2', '–7', '−X'].map(loyaltyKind)).toEqual(['down', 'down', 'down', 'down']);
    expect(['0', '00'].map(loyaltyKind)).toEqual(['zero', 'zero']);
  });
});

describe('landWatermark', () => {
  const lw = (typeLine: string, produced = '') => landWatermark({ typeLine, produced });
  it('uses the basic subtype’s colour', () => {
    expect(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'].map((s) => lw(`Basic Land — ${s}`))).toEqual(['W', 'U', 'B', 'R', 'G']);
    expect(lw('Basic Snow Land — Forest', 'G')).toBe('G');
  });
  it('gives Wastes (no subtype) colourless, or its single produced colour', () => {
    expect(lw('Basic Land', 'C')).toBe('C');
    expect(lw('Basic Land')).toBe('C');
    expect(lw('Basic Land', 'R')).toBe('R');
  });
  it('is absent on non-basic lands and spells', () => {
    expect(lw('Land — Forest Island', 'GU')).toBeNull();
    expect(lw('Creature — Elf')).toBeNull();
  });
});

describe('planeswalker loyalty parsing', () => {
  it('splits ability lines into a cost and text', () => {
    expect(parsePwAbilities('+1: Add {R}{R}.\n−3: Deal 4 damage.\n0: Draw a card.\n−X: Do X things.')).toEqual([
      { cost: '+1', text: 'Add {R}{R}.' },
      { cost: '−3', text: 'Deal 4 damage.' },
      { cost: '0', text: 'Draw a card.' },
      { cost: '−X', text: 'Do X things.' },
    ]);
  });

  it('normalises hyphen and en dash minus signs, and keeps static lines shield-less', () => {
    const a = parsePwAbilities('-2: Foo.\n–5: Bar.\nChandra can’t be countered.');
    expect(a.map((x) => x.cost)).toEqual(['−2', '−5', null]);
    expect(a[2]!.text).toBe('Chandra can’t be countered.');
  });

  it('lays the rows out to fill the box, never shorter than a shield', () => {
    const abilities = parsePwAbilities('+1: Short.\n−3: Short again.');
    const even = layoutPw(abilities, mono, 400, 300, { max: 20, min: 10, minRow: 60, rowPad: 4 });
    expect(even.rows.reduce((s, r) => s + r.h, 0)).toBeCloseTo(300);
    expect(even.rows[0]!.h).toBe(even.rows[1]!.h);
    const last = layoutPw(abilities, mono, 400, 300, { max: 20, min: 10, minRow: 60, rowPad: 4, spareToLast: true });
    expect(last.rows[0]!.h).toBe(60);
    expect(last.rows[1]!.h).toBe(240);
  });
});

describe('frameStyle', () => {
  const base = { produced: '' };
  it('picks a coloured frame per colour', () => {
    const s = frameStyle({ ...base, colors: 'R', typeLine: 'Instant' });
    expect(s.kind).toBe('mono');
    expect(s.colors).toBe('R');
    expect(s.pin[0]).toEqual(s.pin[1]);
  });

  it('gives two colours a pinline each, and three or more a plain gold one', () => {
    const two = frameStyle({ ...base, colors: 'UR', typeLine: 'Legendary Creature — Dragon Wizard' });
    expect(two.kind).toBe('gold');
    expect(two.pin[0]).not.toEqual(two.pin[1]);
    const three = frameStyle({ ...base, colors: 'WUB', typeLine: 'Creature — Human' });
    expect(three.pin[0]).toEqual(three.pin[1]);
  });

  it('frames colourless non-lands as artifacts', () => {
    expect(frameStyle({ ...base, colors: '', typeLine: 'Artifact' }).kind).toBe('artifact');
  });

  it('frames lands by what they produce', () => {
    const forest = frameStyle({ produced: 'G', colors: '', typeLine: 'Basic Land — Forest' });
    expect(forest.kind).toBe('land');
    expect(forest.colors).toBe('G');
    const dual = frameStyle({ produced: 'UR', colors: '', typeLine: 'Land — Island Mountain' });
    expect(dual.colors).toBe('UR');
    expect(dual.pin[0]).not.toEqual(dual.pin[1]);
    expect(dual.tbox[0]).not.toEqual(dual.tbox[1]);
  });
});

describe('layoutFor', () => {
  it('picks the planeswalker layout by type and the standard one otherwise', () => {
    const pw = layoutFor({ typeLine: 'Legendary Planeswalker — Chandra' });
    expect([pw.id, pw.box, pw.stats]).toEqual(['pw', 'loyalty', 'loyalty']);
    expect(pw.frame.crown).toBe(false);
    for (const typeLine of ['Creature — Angel', 'Legendary Creature — Goblin', 'Basic Land — Forest']) {
      const std = layoutFor({ typeLine });
      expect([std.id, std.box, std.stats]).toEqual(['std', 'rules', 'pt']);
    }
  });

  it('picks the token layout for a token card: a taller art window, its box optional', () => {
    const t = layoutFor({ typeLine: 'Creature — Human', token: true });
    expect([t.id, t.box, t.stats, t.boxOptional]).toEqual(['token', 'rules', 'pt', true]);
    expect(t.geo.art.h).toBeGreaterThan(STD.art.h);
    // The type line sits at the art's own bottom edge, so its opaque plate covers the scan's baked text there.
    expect(t.geo.type.y + t.geo.type.h).toBe(t.geo.art.y + t.geo.art.h);
    expect(layoutFor({ typeLine: 'Creature — Human' }).boxOptional).toBe(false);
    // A planeswalker token still gets the loyalty layout, not the token one.
    expect(layoutFor({ typeLine: 'Legendary Planeswalker — Chandra', token: true }).id).toBe('pw');
  });
});

describe('showsBox (a token with no rules or flavor text skips the box, its art showing through)', () => {
  const token = layoutFor({ typeLine: 'Creature — Human', token: true });
  const std = layoutFor({ typeLine: 'Creature — Human' });

  it('skips a token box with nothing to print, but shows one with rules or flavor text', () => {
    expect(showsBox({ typeLine: 'Creature — Human', rules: '', flavor: '' }, token)).toBe(false);
    expect(showsBox({ typeLine: 'Creature — Human', rules: 'Flying', flavor: '' }, token)).toBe(true);
    expect(showsBox({ typeLine: 'Creature — Human', rules: '', flavor: 'A quiet sort.' }, token)).toBe(true);
  });

  it('always shows a standard card\'s box, blank or not', () => {
    expect(showsBox({ typeLine: 'Creature — Human', rules: '', flavor: '' }, std)).toBe(true);
    expect(showsBox({ typeLine: 'Creature — Human', rules: 'Flying', flavor: '' }, std)).toBe(true);
  });
});

describe('counters, damage and ×N as frame elements', () => {
  const creature = { typeLine: 'Creature — Goblin', power: '2', toughness: '2', defense: '' };
  const inCard = (r: { x: number; y: number; w: number; h: number }) => {
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(M15_W);
    expect(r.y + r.h).toBeLessThanOrEqual(M15_H);
  };

  it('shows the toughness left after damage, only for a numeric toughness', () => {
    expect(damagedToughness({ power: '6', toughness: '6' }, 5)).toBe('1');
    expect(damagedToughness({ power: '1', toughness: '1' }, 1)).toBe('0');
    expect(damagedToughness({ power: '6', toughness: '6' }, 0)).toBeNull();
    expect(damagedToughness({ power: '*', toughness: '*' }, 2)).toBeNull();
    expect(damagedToughness({ power: '', toughness: '' }, 2)).toBeNull();
  });

  it('lines counter coins up from the bottom-left, level with the P/T plate, clear of it and inside the card', () => {
    const pt = layoutFor(creature).geo.pt;
    const b = markBoxes(creature, { coins: MAX_COINS, group: 110 });
    expect(b.coins).toHaveLength(MAX_COINS);
    expect(b.coins[0]!.x).toBe(M15_W - pt.x - pt.w);
    for (const c of b.coins) expect(c.y + c.h).toBe(pt.y + pt.h);
    for (let i = 1; i < b.coins.length; i++) expect(b.coins[i]!.x).toBeGreaterThan(b.coins[i - 1]!.x + b.coins[i - 1]!.w);
    // The last coin stops short of the P/T plate.
    expect(b.coins.at(-1)!.x + b.coins.at(-1)!.w).toBeLessThan(pt.x);
    for (const r of [...b.coins, b.group!]) inCard(r);
    expect(b.more).toBe(0);
    expect(markBoxes(creature, { coins: 0, group: 0 })).toEqual({ coins: [], more: 0, group: null });
  });

  it('folds the kinds that don\'t fit into a "+N" coin, with fewer slots beside a grown P/T plate', () => {
    // Five kinds, four slots: three coins and "+2".
    const five = markBoxes(creature, { coins: 5, group: 0 });
    expect(five.coins).toHaveLength(MAX_COINS);
    expect(five.more).toBe(2);
    // 1000/1000 grows the plate left: fewer slots, and the last one still stops short of the plate.
    const huge = { ...creature, power: '1000', toughness: '1000' };
    const plate = ptPlate(huge, ptText(huge));
    const b = markBoxes(huge, { coins: 5, group: 0 });
    expect(b.coins.length).toBeLessThan(MAX_COINS);
    expect(b.more).toBe(5 - (b.coins.length - 1));
    expect(b.coins.at(-1)!.x + b.coins.at(-1)!.w).toBeLessThan(plate.x);
  });
});

describe('gained-keyword icons on the frame', () => {
  const creature = { typeLine: 'Creature — Goblin' };
  const art = layoutFor(creature).geo.art;

  it('stacks them down the art\'s left edge, inside the art, clear of the counter coins', () => {
    const b = keywordBoxes(creature, 3);
    expect(b.more).toBe(0);
    expect(b.icons).toHaveLength(3);
    for (const r of b.icons) {
      expect(r.x).toBeGreaterThanOrEqual(art.x);
      expect(r.x + r.w).toBeLessThan(art.x + art.w / 2);
      expect(r.y).toBeGreaterThanOrEqual(art.y);
      expect(r.y + r.h).toBeLessThanOrEqual(art.y + art.h);
    }
    for (let i = 1; i < 3; i++) expect(b.icons[i]!.y).toBeGreaterThan(b.icons[i - 1]!.y + b.icons[i - 1]!.h);
    expect(keywordBoxes(creature, 0)).toEqual({ icons: [], more: 0 });
  });

  it('folds what doesn\'t fit into a "+N" icon', () => {
    const all = keywordBoxes(creature, 12);
    const fit = all.icons.length;
    expect(fit).toBeLessThan(12);
    expect(all.more).toBe(12 - (fit - 1));
    expect(all.icons.at(-1)!.y + all.icons.at(-1)!.h).toBeLessThanOrEqual(art.y + art.h);
    expect(keywordBoxes(creature, fit)).toMatchObject({ more: 0 });
  });
});
