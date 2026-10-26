import { describe, expect, it } from 'vitest';
import type { AskMsg } from '@forge-table/protocol';
import { NO_PEEK, askPeekLabel, lowerFirst, peekAdd, peekHidden, peekKey, peekRelabel, peekRemove, peekReturnLabel, peekToggle } from './peek';

const key = (k: string, over: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; repeat: boolean }> = {}) => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  repeat: false,
  ...over,
});

describe('show battlefield: the toggle', () => {
  const scry = peekAdd(NO_PEEK, { id: 'ask:1', label: 'scry' });

  it('puts the overlays away and brings them back; nothing to toggle with no overlay up', () => {
    expect(peekHidden(scry)).toBe(false);
    const away = peekToggle(scry);
    expect(peekHidden(away)).toBe(true);
    expect(peekReturnLabel(away)).toBe('scry');
    expect(peekHidden(peekToggle(away))).toBe(false);
    expect(peekToggle(NO_PEEK)).toBe(NO_PEEK);
    expect(peekHidden({ ...NO_PEEK, shown: true })).toBe(false);
  });

  it('a held Space peeks: away while held, the toggle ends the peek too', () => {
    const held = { ...scry, held: true };
    expect(peekHidden(held)).toBe(true);
    expect(peekHidden({ ...held, held: false })).toBe(false);
    expect(peekToggle(held)).toMatchObject({ shown: false, held: false });
  });

  it('any overlay coming or going brings everything back; a relabel does not', () => {
    const away = peekToggle(scry);
    // A new ask on top (or the next one, under a new id): shown, named by the newest.
    const next = peekAdd(away, { id: 'strip', label: 'opponent’s hand' });
    expect(peekHidden(next)).toBe(false);
    expect(peekReturnLabel(next)).toBe('opponent’s hand');
    // The newest goes: the older one names the pill again, shown.
    const back = peekRemove(peekToggle(next), 'strip');
    expect(peekHidden(back)).toBe(false);
    expect(back.overlays.map((o) => o.id)).toEqual(['ask:1']);
    // Removing what is not there changes nothing.
    expect(peekRemove(away, 'nope')).toBe(away);
    // The same prompt renamed (a count changed) stays away.
    const renamed = peekRelabel(away, 'ask:1', 'surveil');
    expect(peekHidden(renamed)).toBe(true);
    expect(peekReturnLabel(renamed)).toBe('surveil');
    expect(peekRelabel(away, 'ask:1', 'scry')).toBe(away);
    // Re-registering an id moves it to the top without a duplicate.
    expect(peekAdd(next, { id: 'ask:1', label: 'scry' }).overlays.map((o) => o.id)).toEqual(['strip', 'ask:1']);
  });
});

describe('show battlefield: keys', () => {
  it('V toggles, Space holds, Esc brings them back only while away', () => {
    expect(peekKey(key('v'), true, false)).toBe('toggle');
    expect(peekKey(key('V', { shiftKey: true }), true, true)).toBe('toggle');
    expect(peekKey(key(' '), true, false)).toBe('hold');
    expect(peekKey(key(' ', { repeat: true }), true, true)).toBe('swallow');
    expect(peekKey(key('Escape'), true, true)).toBe('back');
    // Esc while the overlay shows is the overlay's own (cancel, close).
    expect(peekKey(key('Escape'), true, false)).toBeNull();
  });

  it('leaves alone: no overlay, Shift+Space (pass the turn), modified keys, Tab; a hidden overlay takes no other key', () => {
    expect(peekKey(key('v'), false, false)).toBeNull();
    expect(peekKey(key(' '), false, false)).toBeNull();
    expect(peekKey(key(' ', { shiftKey: true }), true, false)).toBeNull();
    expect(peekKey(key('v', { ctrlKey: true }), true, false)).toBeNull();
    expect(peekKey(key('Enter'), true, false)).toBeNull();
    expect(peekKey(key('Enter'), true, true)).toBe('swallow');
    expect(peekKey(key('1'), true, true)).toBe('swallow');
    expect(peekKey(key('Tab'), true, true)).toBeNull();
  });
});

describe('show battlefield: the Return pill’s words', () => {
  const base = { t: 'ask' as const, seq: 1, id: 'a1' };
  it('names the kind of prompt', () => {
    expect(askPeekLabel({ ...base, kind: 'arrange', items: [], top: true, bottom: true } as unknown as AskMsg, false)).toBe('scry');
    expect(askPeekLabel({ ...base, kind: 'arrange', items: [], top: true, graveyard: true } as unknown as AskMsg, false)).toBe('surveil');
    expect(askPeekLabel({ ...base, kind: 'split', items: [], amount: 3, label: 'damage', rule: 'free' } as unknown as AskMsg, false)).toBe('damage assignment');
    expect(askPeekLabel({ ...base, kind: 'choose', items: [], min: 1, max: 1, reveal: true } as unknown as AskMsg, false)).toBe('reveal');
    expect(askPeekLabel({ ...base, kind: 'choose', items: [], min: 1, max: 1 } as unknown as AskMsg, true)).toBe('number choice');
    expect(lowerFirst('Your graveyard')).toBe('your graveyard');
  });
});
