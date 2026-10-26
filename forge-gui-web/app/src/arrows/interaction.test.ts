import { describe, expect, it } from 'vitest';
import type { CombatBand, PromptBody } from '@forge-table/protocol';
import { aimMode, blockClick, dragSource, dropAct, legalAttackers, pastThreshold, snapTargets } from './interaction';

const prompt = (kind: string, extra: Partial<PromptBody> = {}): PromptBody => ({
  pid: 7,
  kind,
  message: '',
  ok: { label: 'OK', enabled: true },
  cancel: { label: '', enabled: false },
  focusOk: false,
  selectable: [],
  highlighted: [],
  weak: {},
  ...extra,
});

// The AI attacks with a1 (flyer) and a2; my b1 has reach (blocks either), b2 can only block a2; b3 already blocks a2.
const combat: CombatBand[] = [
  { attacker: 'a1', defender: 'p0', blockers: [] },
  { attacker: 'a2', defender: 'p0', blockers: [], planned: ['b3'] },
];
const blocks = prompt('declareBlockers', { blockable: { b1: ['a1', 'a2'], b2: ['a2'], b3: ['a2'], b4: [] }, selectable: ['b1', 'b2', 'b3', 'b4'] });

describe('aim modes', () => {
  it('blocker-first only when the server sends blockable', () => {
    expect(aimMode(blocks)).toBe('block');
    expect(aimMode(prompt('declareBlockers'))).toBeNull();
    expect(aimMode(prompt('declareAttackers'))).toBe('attack');
    expect(aimMode(prompt('chooseTargets'))).toBe('target');
    expect(aimMode(prompt('priority'))).toBeNull();
    expect(aimMode(null)).toBeNull();
    expect(legalAttackers(blocks, 'b2')).toEqual(['a2']);
    expect(legalAttackers(blocks, null)).toEqual([]);
  });
});

describe('blocker-first clicks', () => {
  it('selects a blockable creature, then blocks a legal attacker with it', () => {
    expect(blockClick(blocks, combat, null, 'b1')).toEqual({ select: 'b1' });
    expect(blockClick(blocks, combat, 'b1', 'a1')).toEqual({ select: null, act: { kind: 'block', blocker: 'b1', attacker: 'a1' } });
  });

  it('keeps aiming on an attacker it cannot block, and switches to another blocker', () => {
    expect(blockClick(blocks, combat, 'b2', 'a1')).toEqual({});
    expect(blockClick(blocks, combat, 'b2', 'b1')).toEqual({ select: 'b1' });
    expect(blockClick(blocks, combat, 'b2', 'b2')).toEqual({ select: null });
  });

  it('pulls back a creature that is already blocking', () => {
    expect(blockClick(blocks, combat, null, 'b3')).toEqual({ act: { kind: 'unblock', blocker: 'b3' } });
    expect(blockClick(blocks, combat, 'b1', 'b3')).toEqual({ select: null, act: { kind: 'unblock', blocker: 'b3' } });
  });

  it('leaves anything else (and every click on an older server) to the engine', () => {
    expect(blockClick(blocks, combat, null, 'a1')).toEqual({ act: { kind: 'card', card: 'a1' } });
    expect(blockClick(blocks, combat, null, 'b4')).toEqual({ act: { kind: 'card', card: 'b4' } });
    const old = prompt('declareBlockers', { selectable: ['b1'] });
    expect(blockClick(old, combat, null, 'b1')).toEqual({ act: { kind: 'card', card: 'b1' } });
    expect(blockClick(old, combat, 'b1', 'a1')).toEqual({ act: { kind: 'card', card: 'a1' } });
  });
});

describe('drags', () => {
  const attack = prompt('declareAttackers', { selectable: ['m1', 'm2'], defenders: ['p1', 'w1'] });
  const atk: CombatBand[] = [{ attacker: 'm3', defender: 'p1', blockers: [] }];

  it('start from my blockable creatures, or my attackers when there are defenders to drop on', () => {
    expect(dragSource('block', blocks, combat, 'b1', 'p0', 'p0')).toBe(true);
    expect(dragSource('block', blocks, combat, 'b4', 'p0', 'p0')).toBe(false);
    expect(dragSource('block', blocks, combat, 'a1', 'p0', 'p1')).toBe(false);
    expect(dragSource('attack', attack, atk, 'm1', 'p0', 'p0')).toBe(true);
    expect(dragSource('attack', attack, atk, 'm3', 'p0', 'p0')).toBe(true);
    expect(dragSource('attack', attack, atk, 'm9', 'p0', 'p0')).toBe(false);
    expect(dragSource('attack', prompt('declareAttackers', { selectable: ['m1'] }), atk, 'm1', 'p0', 'p0')).toBe(false);
    expect(dragSource('target', prompt('chooseTargets'), [], 'm1', 'p0', 'p0')).toBe(false);
  });

  it('drop onto a legal attacker blocks, onto a defender attacks, anywhere else does nothing', () => {
    expect(dropAct('block', blocks, 'b2', 'a2')).toEqual({ kind: 'block', blocker: 'b2', attacker: 'a2' });
    expect(dropAct('block', blocks, 'b2', 'a1')).toBeNull();
    expect(dropAct('block', blocks, 'b2', null)).toBeNull();
    expect(dropAct('attack', attack, 'm1', 'w1')).toEqual({ kind: 'attack', attacker: 'm1', defender: 'w1' });
    expect(dropAct('attack', attack, 'm1', 'p1')).toEqual({ kind: 'attack', attacker: 'm1', defender: 'p1' });
    expect(dropAct('attack', attack, 'm1', 'p0')).toBeNull();
    expect(dropAct('attack', attack, 'm1', 'm1')).toBeNull();
  });

  it('snaps to the legal ends and starts past a small threshold', () => {
    expect([...snapTargets('block', blocks, 'b1')]).toEqual(['a1', 'a2']);
    expect([...snapTargets('attack', attack, 'm1')]).toEqual(['p1', 'w1']);
    expect([...snapTargets('target', prompt('chooseTargets', { selectable: ['c9'] }), 'c1')]).toEqual(['c9']);
    expect(pastThreshold({ x: 0, y: 0 }, { x: 5, y: 5 })).toBe(false);
    expect(pastThreshold({ x: 0, y: 0 }, { x: 6, y: 6 })).toBe(true);
  });
});
