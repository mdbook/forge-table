import { describe, expect, it } from 'vitest';
import type { ChooseAsk } from '@forge-table/protocol';
import { costOptions } from './costOptions';

const ask = (labels: string[], extra: Partial<ChooseAsk> = {}, cards: Array<string | undefined> = []): ChooseAsk => ({
  t: 'ask', seq: 1, id: 'q', kind: 'ability', min: 0, max: 1, card: 'c1',
  items: labels.map((label, idx) => ({ idx, label, card: cards[idx] ?? 'c1', enabled: true })),
  ...extra,
});

describe('costOptions (side-by-side ways to cast one card)', () => {
  it('reads heading, cost and detail off the labels', () => {
    const o = costOptions(ask(['Cast Lava Dart', 'Flashback {2}{R} (You may cast this card from your graveyard)']))!;
    expect(o).toHaveLength(2);
    expect(o[0]).toMatchObject({ idx: 0, mode: 'Cast', detail: 'Cast Lava Dart' });
    expect(o[1]).toMatchObject({ idx: 1, mode: 'Flashback', cost: '{2}{R}' });
    expect(o[1]!.detail).toContain('graveyard');
  });

  it('keeps the list for one ability, several cards, no alt-cost keyword or a multi pick', () => {
    expect(costOptions(ask(['Flashback {2}{R}']))).toBeNull();
    expect(costOptions(ask(['Flashback {2}{R}', 'Cast'], {}, ['c1', 'c2']))).toBeNull();
    expect(costOptions(ask(['{T}: Add {R}.', '{T}: Add {G}.']))).toBeNull();
    expect(costOptions(ask(['Bestow {3}{W}', 'Cast'], { max: 2 }))).toBeNull();
    expect(costOptions({ ...ask(['Bestow {3}{W}', 'Cast']), kind: 'choose' })).toBeNull();
  });

  it('marks disabled options', () => {
    const a = ask(['Cast', 'Bestow {3}{W}']);
    a.items[1]!.enabled = false;
    expect(costOptions(a)!.map((o) => o.enabled)).toEqual([true, false]);
  });
});
