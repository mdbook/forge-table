import { describe, expect, it } from 'vitest';
import { answerLabel, offerAutoResolve, rememberedAnswer } from './autoResponses';

const confirm = { kind: 'confirm' as const, pid: 7, triggerKey: 'Kor Firewalker (id=12): you may gain 1 life.' };

describe('rememberedAnswer', () => {
  it('turns Yes and No into accept and decline when the switch is on for this prompt', () => {
    expect(rememberedAnswer(confirm, 7, 'ok')).toEqual({ key: confirm.triggerKey, decision: 'accept' });
    expect(rememberedAnswer(confirm, 7, 'cancel')).toEqual({ key: confirm.triggerKey, decision: 'decline' });
  });

  it('is an ordinary press otherwise', () => {
    expect(rememberedAnswer(confirm, null, 'ok')).toBeNull();
    expect(rememberedAnswer(confirm, 6, 'ok')).toBeNull();
    expect(rememberedAnswer({ ...confirm, triggerKey: undefined }, 7, 'ok')).toBeNull();
    expect(rememberedAnswer({ ...confirm, kind: 'priority' }, 7, 'ok')).toBeNull();
    expect(rememberedAnswer(confirm, 7, null)).toBeNull();
    expect(rememberedAnswer(null, 7, 'ok')).toBeNull();
  });
});

describe('answerLabel', () => {
  it('drops the card id and keeps the name', () => {
    expect(answerLabel(confirm.triggerKey)).toBe('Kor Firewalker: you may gain 1 life.');
  });

  it('leaves an ability-wide key alone', () => {
    expect(answerLabel('you may gain 1 life.')).toBe('you may gain 1 life.');
  });
});

describe('offerAutoResolve', () => {
  const mine = [{ activator: 'p0' }, { activator: 'p1' }];
  const theirs = [{ activator: 'p1' }, { activator: 'p0' }];

  it('offers it at my priority with my item on top', () => {
    expect(offerAutoResolve('priority', mine, 'p0', false, false)).toBe(true);
  });

  it('stays out of the way otherwise', () => {
    expect(offerAutoResolve('priority', mine, 'p0', true, false)).toBe(false);
    expect(offerAutoResolve('priority', mine, 'p0', false, true)).toBe(false);
    expect(offerAutoResolve('priority', theirs, 'p0', false, false)).toBe(false);
    expect(offerAutoResolve('priority', [], 'p0', false, false)).toBe(false);
    expect(offerAutoResolve('chooseTargets', mine, 'p0', false, false)).toBe(false);
    expect(offerAutoResolve(null, mine, 'p0', false, false)).toBe(false);
  });
});
