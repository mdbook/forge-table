import { describe, expect, it } from 'vitest';
import { dropBefore, initialOrder, laneOf, moveTo, nudge, otherLane, type Lanes } from './lanes';

describe('lanes', () => {
  const l: Lanes = [[0, 1, 2], []];

  it('finds the lane of an item', () => {
    expect(laneOf(l, 1)).toBe(0);
    expect(laneOf(l, 7)).toBe(-1);
  });

  it('moves to the end of the other lane and back', () => {
    const a = otherLane(l, 1);
    expect(a).toEqual([[0, 2], [1]]);
    expect(otherLane(otherLane(a, 0), 1)).toEqual([[2, 1], [0]]);
    expect(otherLane([[0, 1]], 0)).toEqual([[0, 1]]); // one lane: nothing to switch to
  });

  it('inserts before an item, or appends', () => {
    expect(moveTo(l, 2, 0, 0)).toEqual([[2, 0, 1], []]);
    expect(moveTo(l, 0, 0, null)).toEqual([[1, 2, 0], []]);
    expect(moveTo([[0], [1, 2]], 0, 1, 2)).toEqual([[], [1, 0, 2]]);
    expect(moveTo(l, 1, 0, 1)).toBe(l); // onto itself
    expect(moveTo(l, 1, 5)).toBe(l); // no such lane
  });

  it('nudges within the lane and stops at the ends', () => {
    expect(nudge(l, 1, -1)).toEqual([[1, 0, 2], []]);
    expect(nudge(l, 1, 1)).toEqual([[0, 2, 1], []]);
    expect(nudge(l, 0, -1)).toBe(l);
    expect(nudge(l, 2, 1)).toBe(l);
  });

  it('drops on the second half of a card land after it', () => {
    expect(dropBefore(l, 1, false)).toBe(1);
    expect(dropBefore(l, 1, true)).toBe(2);
    expect(dropBefore(l, 2, true)).toBeNull();
  });

  it('starts from a complete preselection only', () => {
    expect(initialOrder([0, 1, 2], [2, 0, 1])).toEqual([2, 0, 1]);
    expect(initialOrder([0, 1, 2], [2])).toEqual([0, 1, 2]);
    expect(initialOrder([0, 1, 2], undefined)).toEqual([0, 1, 2]);
  });
});
