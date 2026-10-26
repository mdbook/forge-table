import { describe, expect, it } from 'vitest';
import { add, auto, fill, initial, left, open, valid } from './split';

describe('split (O7)', () => {
  // A 6/6 trampler double-blocked by two 2/2s, the defending player at 20.
  const trample = { amount: 6, rule: 'lethalFirst' as const, lethal: [2, 2, 20], defender: true };

  it('starts combat at auto: lethal in order, the rest to the player', () => {
    expect(initial(trample, 3)).toEqual([2, 2, 2]);
    expect(valid(trample, [2, 2, 2])).toBe(true);
  });

  it('keeps trample damage off the player until every blocker has lethal', () => {
    expect(open(trample, [1, 2, 0], 2)).toBe(false);
    expect(valid(trample, [1, 2, 3])).toBe(false);
    // Taking damage back off a blocker drops what the player held.
    expect(add(trample, [2, 2, 2], 0, -1)).toEqual([1, 2, 0]);
    expect(add(trample, [1, 2, 0], 2, 1)).toEqual([1, 2, 0]);
  });

  it('never assigns more than there is', () => {
    expect(add(trample, [2, 2, 2], 1, 5)).toEqual([2, 2, 2]);
    expect(left(trample, [1, 2, 0])).toBe(3);
    expect(fill(trample, [1, 2, 0], 0)).toEqual([2, 2, 0]);
    expect(fill(trample, [2, 2, 0], 2)).toEqual([2, 2, 2]);
  });

  it('follows the legacy damage order', () => {
    const ordered = { amount: 3, rule: 'inOrder' as const, lethal: [2, 2] };
    expect(auto(ordered, 2)).toEqual([2, 1]);
    expect(open(ordered, [1, 0], 1)).toBe(false);
    expect(valid(ordered, [0, 3])).toBe(false);
  });

  it('divides a generic amount within each min and max', () => {
    const bolt = { amount: 3, rule: 'free' as const, min: [1, 1], max: [3, 3] };
    expect(initial(bolt, 2)).toEqual([1, 1]);
    expect(valid(bolt, [1, 1])).toBe(false);
    expect(add(bolt, [1, 1], 0, -1)).toEqual([1, 1]);
    expect(fill(bolt, [1, 1], 1)).toEqual([1, 2]);
    expect(auto(bolt, 2)).toEqual([2, 1]);
    const combo = { amount: 2, rule: 'free' as const, max: [1, 1, 1] };
    expect(auto(combo, 3)).toEqual([1, 1, 0]);
  });
});
