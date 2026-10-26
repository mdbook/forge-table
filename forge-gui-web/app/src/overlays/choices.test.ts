import { describe, expect, it } from 'vitest';
import type { AskMsg, ChooseAsk, GameModel, PromptBody, TextAsk } from '@forge-table/protocol';
import { colorWord, manaPickForAsk, manaPickForPrompt, paidKeys, parseManaAbility, payCost, pipKeys } from './manaChoice';
import { costWithX, nearest, numberContext, numberReply, numberSpec, pendingAnswer, setPendingNumber, step, textBounds, timesCost } from './numberChoice';

const choose = (labels: string[], o: Partial<ChooseAsk> = {}): ChooseAsk => ({
  t: 'ask',
  seq: 1,
  id: 'q1',
  kind: 'choose',
  items: labels.map((label, idx) => ({ idx, label })),
  min: 0,
  max: 1,
  ...o,
});
const text = (o: Partial<TextAsk> = {}): TextAsk => ({ t: 'ask', seq: 2, id: 'q2', kind: 'text', numeric: true, ...o });

describe('number choices (X picker)', () => {
  it('reads getInteger with a cut-off: 0..9 then "Other..."', () => {
    const ask = choose([...Array.from({ length: 10 }, (_, i) => String(i)), 'Other...'], { message: 'Choose X for Fireball' });
    const s = numberSpec(ask)!;
    expect(s.values).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(s.other).toBe(10);
    expect(s.hi).toBe(Infinity);
    expect(s.cancel).toBe(true);
    expect(s.initial).toBe(0);
    // In the list: its idx; past it: Other, then the digits for the text ask that follows.
    expect(numberReply(ask, s, 4)).toEqual({ value: [4] });
    expect(numberReply(ask, s, 15)).toEqual({ value: [10], then: { title: 'Choose X for Fireball', value: 15 } });
    expect(step(s, 9, 1)).toBe(10);
    expect(step(s, 11, -1)).toBe(10);
    expect(step(s, 10, -1)).toBe(9);
    // ±5 carries on past the listed 0..9 (no cap: "Other..." takes the number) and comes back into the list.
    expect(step(s, 3, 5)).toBe(8);
    expect(step(s, 8, 5)).toBe(13);
    expect(step(s, 9, 5)).toBe(14);
    expect(step(s, 14, -5)).toBe(9);
    expect(step(s, 12, -5)).toBe(7);
    expect(step(s, 2, -5)).toBe(0);
    expect(numberReply(ask, s, 105)).toEqual({ value: [10], then: { title: 'Choose X for Fireball', value: 105 } });
  });

  it('caps ±5 at a real max and at the min', () => {
    const capped = numberSpec(choose(['0', '1', '2', '3', '4', '5', '6', '7']))!;
    expect(capped.hi).toBe(7);
    expect(step(capped, 5, 5)).toBe(7);
    expect(step(capped, 3, -5)).toBe(0);
    const txt = numberSpec(text({ message: 'Enter a number between 2 and 40:' }))!;
    expect(step(txt, 38, 5)).toBe(40);
    expect(step(txt, 4, -5)).toBe(2);
    const open = numberSpec(text({ message: 'Enter a number greater than or equal to 1:' }))!;
    expect(step(open, 1, 5)).toBe(6);
    expect(step(open, 3, -5)).toBe(1);
  });

  it('reads a descending, non-contiguous and mandatory list', () => {
    const desc = numberSpec(choose(['3', '2', '1', '0'], { min: 1 }))!;
    expect(desc.values).toEqual([0, 1, 2, 3]);
    expect(desc.initial).toBe(3);
    expect(desc.cancel).toBe(false);
    expect(numberReply(choose(['3', '2', '1', '0']), desc, 1)).toEqual({ value: [2] });
    const gaps = numberSpec(choose(['1', '3', '5'], { min: 1 }))!;
    expect(step(gaps, 1, 1)).toBe(3);
    expect(step(gaps, 5, 1)).toBe(5);
    expect(step(gaps, 1, -3)).toBe(1);
    expect(nearest(gaps, 4.2)).toBe(5);
    expect(nearest(gaps, 2)).toBe(1);
    expect(nearest(gaps, 99)).toBe(5);
  });

  it('leaves anything that is not a list of numbers alone', () => {
    expect(numberSpec(choose(['WHITE', 'BLUE', 'RED']))).toBeNull();
    expect(numberSpec(choose(['1', 'Other...', '2']))).toBeNull();
    expect(numberSpec(choose(['1', '2'], { max: 2 }))).toBeNull();
    expect(numberSpec({ ...choose(['1', '2']), items: [{ idx: 0, label: '1', card: 'c1' }, { idx: 1, label: '2' }] })).toBeNull();
    expect(numberSpec(text({ numeric: false }))).toBeNull();
  });

  it('reads the bounds of a numeric text ask', () => {
    expect(textBounds('Enter a number between 0 and 15:')).toEqual([0, 15]);
    expect(textBounds('Enter a number greater than or equal to 1:')).toEqual([1, Infinity]);
    expect(textBounds('Enter a number between 1 and 2,147,483,647:')).toEqual([1, 2147483647]);
    expect(textBounds('How much?')).toEqual([0, Infinity]);
    const s = numberSpec(text({ message: 'Enter a number between 2 and 15:' }))!;
    expect([s.lo, s.hi, s.initial]).toEqual([2, 15, 2]);
    expect(numberReply(text(), s, 7)).toEqual({ value: '7' });
  });

  it('answers the text ask after "Other..." once, when the number fits', () => {
    setPendingNumber({ title: 'Choose X for Fireball', value: 15 });
    expect(pendingAnswer(text({ title: 'Something else' }))).toBeNull();
    expect(pendingAnswer(text({ title: 'Choose X for Fireball', message: 'Enter a number greater than or equal to 0:' }))).toBe('15');
    expect(pendingAnswer(text({ title: 'Choose X for Fireball', message: 'Enter a number between 0 and 12:' }))).toBeNull();
    expect(pendingAnswer(text({ title: 'Choose X for Fireball', error: 'Enter a number' }))).toBeNull();
    setPendingNumber(null);
    expect(pendingAnswer(text({ title: 'Choose X for Fireball', message: 'Enter a number greater than or equal to 0:' }))).toBeNull();
  });

  it('turns X into generic mana, and a repeated cost into its total', () => {
    expect(costWithX('{X}{R}', 3)).toBe('{3}{R}');
    expect(costWithX('{X}{X}{G}', 2)).toBe('{4}{G}');
    expect(costWithX('{2}{X}{U}', 0)).toBe('{2}{U}');
    expect(costWithX('{X}', 0)).toBe('{0}');
    expect(timesCost('{1}{R}', 3)).toBe('{3}{R}{R}{R}');
    expect(timesCost('{G}', 0)).toBe('{0}');
  });

  it('finds the card an X is for, preferring the one on the stack', () => {
    const model = {
      game: { stack: [] },
      players: {},
      cards: {
        c1: { id: 'c1', zone: 'Hand', owner: 'p0', state: { face: 'Original', name: 'Fireball', manaCost: '{X}{R}' } },
        c2: { id: 'c2', zone: 'Stack', owner: 'p0', state: { face: 'Original', name: 'Fireball', manaCost: '{X}{R}' } },
        c3: { id: 'c3', zone: 'Hand', owner: 'p0', state: { face: 'Original', name: 'Mind Rot', manaCost: '{2}{B}' } },
      },
    } as unknown as GameModel;
    const x = numberContext('Choose X for Fireball', model, 'p0');
    expect(x.card).toBe('c2');
    expect(x.cost?.(5)).toBe('{5}{R}');
    expect(numberContext('Choose X for Mind Rot', model, 'p0').cost).toBeNull();
    const times = numberContext('How many times do you want to pay {1}{R} for Mind Rot?', model, 'p0');
    expect(times.card).toBe('c3');
    expect(times.cost?.(2)).toBe('{2}{R}{R}');
    expect(numberContext('How many cards?', model, 'p0')).toEqual({ card: null, name: null, cost: null });
  });
});

describe('mana choices (mana picker)', () => {
  it('parses mana abilities, with any cost beyond {T} and side effects as a note', () => {
    expect(parseManaAbility('{T}: Add {W}.')).toEqual({ symbols: ['W'], or: false, note: null });
    expect(parseManaAbility('{T}: Add {W} or {U}.')).toEqual({ symbols: ['W', 'U'], or: true, note: null });
    expect(parseManaAbility('{T}, Pay 1 life: Add {B}.')).toEqual({ symbols: ['B'], or: false, note: 'Pay 1 life' });
    expect(parseManaAbility('{T}: Add {W} or {B}. Caves of Koilos deals 1 damage to you.')).toEqual({ symbols: ['W', 'B'], or: true, note: 'Caves of Koilos deals 1 damage to you.' });
    expect(parseManaAbility('{T}: Add one mana of any color.')).toEqual({ symbols: ['any'], or: false, note: null });
    expect(parseManaAbility('{T}: Add {C}{C}.')).toEqual({ symbols: ['C', 'C'], or: false, note: null });
    expect(parseManaAbility('{1}: Mutavault becomes a 2/2 creature.')).toBeNull();
    expect(parseManaAbility('Add a +1/+1 counter.')).toBeNull();
  });

  it('turns a dual land’s ability menu into pips, hotkeyed by colour', () => {
    const ask: AskMsg = { ...choose(['{T}: Add {R}.', '{T}: Add {G}.'], { min: 1, message: 'Choose a mana ability:' }), items: [{ idx: 0, label: '{T}: Add {R}.', card: 'c9' }, { idx: 1, label: '{T}: Add {G}.', card: 'c9' }] };
    const pick = manaPickForAsk(ask)!;
    expect(pick.card).toBe('c9');
    expect(pick.cancel).toBe(false);
    expect(pick.options.map((o) => [o.symbols, o.hotkey, o.label, o.reply])).toEqual([
      [['R'], 'R', 'Add red mana', { ask: [0] }],
      [['G'], 'G', 'Add green mana', { ask: [1] }],
    ]);
    // At priority the ability menu carries the source on the ask, and may be cancelled.
    const menu = manaPickForAsk({ ...ask, kind: 'ability', min: 0, card: 'c9', items: ask.items.map((it) => ({ ...it, enabled: it.idx === 0 })) })!;
    expect(menu.cancel).toBe(true);
    expect(menu.options.map((o) => o.enabled)).toEqual([true, false]);
  });

  it('keeps menus with a non-mana ability as a list', () => {
    expect(manaPickForAsk(choose(['{T}: Add {C}.', '{1}: Mutavault becomes a 2/2 creature.']))).toBeNull();
    expect(manaPickForAsk(choose(['Draw a card', 'Gain 3 life']))).toBeNull();
  });

  it('reads Forge’s colour enum labels', () => {
    expect(colorWord('GREEN')).toBe('G');
    expect(colorWord('Colorless')).toBe('C');
    const pick = manaPickForAsk(choose(['WHITE', 'BLUE', 'BLACK', 'RED', 'GREEN'], { min: 1, message: 'Select Mana to Produce' }))!;
    expect(pick.options.map((o) => o.hotkey)).toEqual(['W', 'U', 'B', 'R', 'G']);
    expect(pick.title).toBe('Select Mana to Produce');
    expect(pick.options[1]!.label).toBe('Add blue mana');
    // Not for mana (protection from a colour…): just the colour's name.
    expect(manaPickForAsk(choose(['WHITE', 'BLUE', 'RED'], { message: 'Choose a color' }))!.options[2]!.label).toBe('Red');
    expect(manaPickForAsk(choose(['WHITE', 'BLUE'], { max: 2 }))).toBeNull();
  });

  it('turns a two-colour confirm prompt into two pips that press its buttons', () => {
    const prompt = { pid: 4, kind: 'confirm', message: 'Select Mana to Produce', card: 'c3', ok: { label: 'White', enabled: true }, cancel: { label: 'Blue', enabled: true }, focusOk: true, selectable: [], highlighted: [], weak: {} } as PromptBody;
    const pick = manaPickForPrompt(prompt)!;
    expect(pick.card).toBe('c3');
    expect(pick.options.map((o) => [o.symbols[0], o.reply])).toEqual([['W', { act: 'ok' }], ['U', { act: 'cancel' }]]);
    expect(manaPickForPrompt({ ...prompt, ok: { label: 'Yes', enabled: true } })).toBeNull();
  });

  it('parses the cost left to pay and which pips a payment took', () => {
    expect(payCost('Pay Mana Cost: {1}{U}{B}')).toEqual(['1', 'U', 'B']);
    expect(payCost('Fireball - deals 3 damage\n\nPay Mana Cost: {2}{W/U} (Click on your life total…)')).toEqual(['2', 'W/U']);
    expect(payCost('Pay Mana Cost: 0')).toEqual([]);
    expect(payCost('Choose targets')).toBeNull();
    expect(pipKeys(['2', 'U', 'U', 'B'])).toEqual(['generic#0', 'U#0', 'U#1', 'B#0']);
    expect(paidKeys(['2', 'U', 'U', 'B'], ['1', 'U', 'B'])).toEqual(['U#1']);
    expect(paidKeys(['1', 'U'], ['U'])).toEqual(['generic#0']);
  });
});
