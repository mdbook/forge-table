import { describe, expect, it } from 'vitest';
import { keyAction, type KeyContext, type KeyPress } from './keys';

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});
const playing: KeyContext = { inMatch: true, passing: false, inputLive: true };

describe('keyAction', () => {
  it('keeps Space/Enter on primary and Esc/Backspace on secondary', () => {
    expect(keyAction(press(' '), playing)).toBe('primary');
    expect(keyAction(press('Enter'), playing)).toBe('primary');
    expect(keyAction(press('Escape'), playing)).toBe('secondary');
    expect(keyAction(press('Backspace'), playing)).toBe('secondary');
  });

  it('E and Shift+Space toggle passing until end of turn', () => {
    expect(keyAction(press('e'), playing)).toBe('passTurn');
    expect(keyAction(press('E', { shiftKey: true }), playing)).toBe('passTurn');
    expect(keyAction(press(' ', { shiftKey: true }), playing)).toBe('passTurn');
    expect(keyAction(press('e'), { ...playing, passing: true })).toBe('passTurn');
  });

  it('S toggles auto-skip', () => {
    expect(keyAction(press('s'), playing)).toBe('autoSkip');
    expect(keyAction(press('S', { shiftKey: true }), playing)).toBe('autoSkip');
  });

  it('R resolves all, only in a match and without modifiers', () => {
    expect(keyAction(press('r'), playing)).toBe('resolveAll');
    expect(keyAction(press('R', { shiftKey: true }), playing)).toBe('resolveAll');
    expect(keyAction(press('r', { ctrlKey: true }), playing)).toBeNull();
    expect(keyAction(press('r'), { ...playing, inMatch: false })).toBeNull();
  });

  it('Esc stops passing when no prompt waits for an answer, and stays secondary when one does', () => {
    expect(keyAction(press('Escape'), { ...playing, passing: true, inputLive: false })).toBe('stopPassing');
    expect(keyAction(press('Backspace'), { ...playing, passing: true, inputLive: false })).toBe('stopPassing');
    expect(keyAction(press('Escape'), { ...playing, passing: true, inputLive: true })).toBe('secondary');
  });

  it('ignores letters with Ctrl, Alt or Meta, and outside a match', () => {
    expect(keyAction(press('s', { ctrlKey: true }), playing)).toBeNull();
    expect(keyAction(press('e', { metaKey: true }), playing)).toBeNull();
    expect(keyAction(press('e', { altKey: true }), playing)).toBeNull();
    expect(keyAction(press('e'), { ...playing, inMatch: false })).toBeNull();
    expect(keyAction(press(' ', { shiftKey: true }), { ...playing, inMatch: false })).toBe('primary');
  });

  it('leaves the reserved keys alone (A attack all, F full control, Z undo)', () => {
    for (const k of ['a', 'f', 'z', '1', 'Tab']) expect(keyAction(press(k), playing)).toBeNull();
  });
});
