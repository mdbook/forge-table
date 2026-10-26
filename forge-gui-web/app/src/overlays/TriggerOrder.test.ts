import { describe, expect, it } from 'vitest';
import type { OrderAsk } from '@forge-table/protocol';
import { isTriggerOrder, moveBy, triggerText } from './TriggerOrder';

const ask = (over: Partial<OrderAsk>): OrderAsk =>
  ({ t: 'ask', seq: 1, id: 'o', kind: 'order', items: [{ idx: 0, label: 'a' }, { idx: 1, label: 'b' }], min: 2, max: 2, ...over }) as OrderAsk;

describe('trigger order (B7)', () => {
  it('is Forge\'s simultaneous-abilities order, every item ordered', () => {
    expect(isTriggerOrder(ask({ remember: true }))).toBe(true);
    expect(isTriggerOrder(ask({ title: 'Select order for simultaneous abilities' }))).toBe(true);
    expect(isTriggerOrder(ask({ title: 'Choose order of cards to put into the library' }))).toBe(false);
    expect(isTriggerOrder(ask({ remember: true, min: 1 }))).toBe(false);
  });

  it('moves a row up or down, clamped', () => {
    expect(moveBy([0, 1, 2], 2, -1)).toEqual([0, 2, 1]);
    expect(moveBy([0, 1, 2], 0, -1)).toEqual([0, 1, 2]);
    expect(moveBy([0, 1, 2], 0, 2)).toEqual([1, 2, 0]);
  });

  it('drops the source name the label starts with', () => {
    expect(triggerText('Ninja of the Deep Hours - Whenever this deals combat damage, draw a card.', 'Ninja of the Deep Hours')).toBe('Whenever this deals combat damage, draw a card.');
    expect(triggerText('Draw a card.', 'Ninja of the Deep Hours')).toBe('Draw a card.');
    expect(triggerText('Draw a card.', undefined)).toBe('Draw a card.');
  });
});
