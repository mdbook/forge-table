/**
 * Table keys as a pure function: Space/Enter = primary, Esc/Backspace = secondary, E or Shift+Space =
 * pass until end of turn (again to stop), S = auto-skip on/off, R = resolve all. While passing with no prompt to
 * answer, Esc stops passing. Letter keys only count without Ctrl/Alt/Meta, and only in a match.
 */
export type KeyAction = 'primary' | 'secondary' | 'passTurn' | 'stopPassing' | 'autoSkip' | 'resolveAll' | null;

export interface KeyPress {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export interface KeyContext {
  inMatch: boolean;
  /** Passing priority until end of turn. */
  passing: boolean;
  /** A real prompt is on screen and no overlay covers it. */
  inputLive: boolean;
}

export function keyAction(e: KeyPress, s: KeyContext): KeyAction {
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  const letter = plain && s.inMatch ? e.key.toLowerCase() : '';
  if ((e.key === ' ' && e.shiftKey && plain && s.inMatch) || letter === 'e') return 'passTurn';
  if (letter === 's') return 'autoSkip';
  if (letter === 'r') return 'resolveAll';
  if (e.key === ' ' || e.key === 'Enter') return 'primary';
  if (e.key === 'Escape' || e.key === 'Backspace') return s.passing && !s.inputLive ? 'stopPassing' : 'secondary';
  return null;
}
