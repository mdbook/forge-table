import { describe, expect, it } from 'vitest';
import { PHASE_GROUPS, groupOf, groupStop, groupToggles, isExpanded } from './phaseGroups';

const group = (key: string) => PHASE_GROUPS.find((g) => g.key === key)!;

describe('PHASE_GROUPS', () => {
  it('covers the twelve steps with a stop once each, in turn order', () => {
    expect(PHASE_GROUPS.flatMap((g) => g.steps)).toEqual([
      'UPKEEP', 'DRAW', 'MAIN1', 'COMBAT_BEGIN', 'COMBAT_DECLARE_ATTACKERS', 'COMBAT_DECLARE_BLOCKERS',
      'COMBAT_FIRST_STRIKE_DAMAGE', 'COMBAT_DAMAGE', 'COMBAT_END', 'MAIN2', 'END_OF_TURN', 'CLEANUP',
    ]);
  });
});

describe('groupOf', () => {
  it('finds the part a step is in; untap is the beginning', () => {
    expect(groupOf('UNTAP')).toBe('beginning');
    expect(groupOf('DRAW')).toBe('beginning');
    expect(groupOf('COMBAT_DECLARE_BLOCKERS')).toBe('combat');
    expect(groupOf('MAIN2')).toBe('main2');
    expect(groupOf('CLEANUP')).toBe('end');
    expect(groupOf(null)).toBeNull();
  });
});

describe('isExpanded', () => {
  it('opens the part the turn is in, and any hovered or tapped-open one; a one-step part never opens', () => {
    const none = new Set<never>();
    expect(isExpanded(group('combat'), 'combat', none)).toBe(true);
    expect(isExpanded(group('beginning'), 'combat', none)).toBe(false);
    expect(isExpanded(group('beginning'), 'combat', new Set(['beginning'] as const))).toBe(true);
    expect(isExpanded(group('main1'), 'main1', new Set(['main1'] as const))).toBe(false);
  });
});

describe('groupStop / groupToggles', () => {
  it("a closed part's pip is on for all its steps, some for a few, off for none", () => {
    expect(groupStop(group('combat'), [])).toBe('off');
    expect(groupStop(group('combat'), ['COMBAT_DECLARE_ATTACKERS', 'MAIN1'])).toBe('some');
    expect(groupStop(group('end'), ['END_OF_TURN', 'CLEANUP'])).toBe('on');
  });
  it('flipping it sets every step that is off, or clears all when all are on', () => {
    expect(groupToggles(group('end'), ['END_OF_TURN'])).toEqual(['CLEANUP']);
    expect(groupToggles(group('end'), [])).toEqual(['END_OF_TURN', 'CLEANUP']);
    expect(groupToggles(group('end'), ['END_OF_TURN', 'CLEANUP'])).toEqual(['END_OF_TURN', 'CLEANUP']);
  });
});
