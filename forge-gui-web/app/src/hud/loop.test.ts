import { describe, expect, it } from 'vitest';
import { loopChip, opponentLoopText, repeatCount } from './loop';

describe('repeatCount', () => {
  it('takes a whole number from 1 to 999', () => {
    expect(repeatCount('3')).toBe(3);
    expect(repeatCount(' 50 ')).toBe(50);
    expect(repeatCount('999')).toBe(999);
  });

  it('refuses anything else', () => {
    expect(repeatCount('')).toBeNull();
    expect(repeatCount('0')).toBeNull();
    expect(repeatCount('1000')).toBeNull();
    expect(repeatCount('-2')).toBeNull();
    expect(repeatCount('2.5')).toBeNull();
    expect(repeatCount('ten')).toBeNull();
  });

  it('caps at the offer for a stop point', () => {
    expect(repeatCount('5', 4)).toBeNull();
    expect(repeatCount('4', 4)).toBe(4);
  });
});

describe('loopChip', () => {
  it('is Record loop when idle', () => {
    expect(loopChip(undefined)).toMatchObject({ label: 'Record loop', on: false });
  });

  it('counts the steps while recording', () => {
    expect(loopChip({ state: 'recording', steps: 1 }).label).toBe('Recording, 1 step');
    expect(loopChip({ state: 'recording', steps: 7 })).toMatchObject({ label: 'Recording, 7 steps', on: true });
  });

  it('waits on the opponent, then shows progress', () => {
    expect(loopChip({ state: 'offered', steps: 7, times: 10 }).label).toBe('Waiting on opponent');
    expect(loopChip({ state: 'playing', iteration: 3, of: 10 }).label).toBe('Looping 3 / 10');
  });
});

describe('opponentLoopText', () => {
  it('asks about the offer, then shows progress', () => {
    expect(opponentLoopText({ state: 'offered', times: 1 })).toBe('Your opponent wants to repeat a loop 1 more time.');
    expect(opponentLoopText({ state: 'offered', times: 20 })).toBe('Your opponent wants to repeat a loop 20 more times.');
    expect(opponentLoopText({ state: 'playing', iteration: 4, of: 20 })).toBe('Opponent looping 4 / 20');
  });
});
