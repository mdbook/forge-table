import { describe, expect, it } from 'vitest';
import { LOW_LIFE, lifeChip, lowLife } from './life';

describe('life chips and the low-life pulse (MTGA juice)', () => {
  it('a loss throws a red minus chip, a gain a green plus chip, no change nothing', () => {
    expect(lifeChip(20, 17)).toEqual({ text: '−3', tone: 'loss' });
    expect(lifeChip(4, 6)).toEqual({ text: '+2', tone: 'gain' });
    expect(lifeChip(3, -2)).toEqual({ text: '−5', tone: 'loss' });
    expect(lifeChip(12, 12)).toBeNull();
    expect(lifeChip(Number.NaN, 3)).toBeNull();
  });

  it('pulses at 5 or less while alive', () => {
    expect(lowLife(LOW_LIFE)).toBe(true);
    expect(lowLife(1)).toBe(true);
    expect(lowLife(6)).toBe(false);
    expect(lowLife(0)).toBe(false);
    expect(lowLife(-3)).toBe(false);
    expect(lowLife(undefined)).toBe(false);
  });
});
