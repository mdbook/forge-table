/**
 * "Show battlefield" (MTGA's View Battlefield), as pure state: every overlay that covers the table
 * registers while it is up; a toggle puts them all away (they stay mounted, selections intact) and leaves a
 * "Return to <prompt>" pill; the pill, the toggle again or Esc brings them back. Holding Space peeks: the overlays are
 * away only while it is held. Any overlay coming or going brings them back (a new prompt is never hidden). The hook,
 * the toggle button and the keys are in BattlefieldPeek.tsx; acts are unchanged.
 */
import type { AskMsg } from '@forge-table/protocol';
import type { KeyPress } from '../hud/keys';

export interface PeekOverlay {
  id: string;
  /** What the Return pill names ("Return to scry"). */
  label: string;
}

export interface PeekState {
  /** The overlays up now, oldest first (the newest names the pill). */
  overlays: PeekOverlay[];
  /** Put away with the toggle. */
  shown: boolean;
  /** Space is held (peeking). */
  held: boolean;
}

export const NO_PEEK: PeekState = { overlays: [], shown: false, held: false };

/** The overlays are away: the toggle or a held Space, while there are any. */
export function peekHidden(s: PeekState): boolean {
  return s.overlays.length > 0 && (s.shown || s.held);
}

/** An overlay comes up (or comes back with a new id): it is on top, and everything shows again. */
export function peekAdd(s: PeekState, o: PeekOverlay): PeekState {
  return { overlays: [...s.overlays.filter((x) => x.id !== o.id), o], shown: false, held: false };
}

/** An overlay goes: everything left shows again. */
export function peekRemove(s: PeekState, id: string): PeekState {
  if (!s.overlays.some((x) => x.id === id)) return s;
  return { overlays: s.overlays.filter((x) => x.id !== id), shown: false, held: false };
}

/** An overlay's prompt changed its name (no reshow: the same prompt). */
export function peekRelabel(s: PeekState, id: string, label: string): PeekState {
  const i = s.overlays.findIndex((x) => x.id === id);
  if (i < 0 || s.overlays[i]!.label === label) return s;
  const overlays = s.overlays.slice();
  overlays[i] = { id, label };
  return { ...s, overlays };
}

/** The toggle (button, V): away, or back (back also ends a peek). No overlays, nothing to toggle. */
export function peekToggle(s: PeekState): PeekState {
  if (s.overlays.length === 0) return s;
  return peekHidden(s) ? { ...s, shown: false, held: false } : { ...s, shown: true };
}

/** What the pill says after "Return to": the newest overlay's prompt. */
export function peekReturnLabel(s: PeekState): string {
  return s.overlays[s.overlays.length - 1]?.label ?? 'the prompt';
}

/**
 * A key while overlays are up (`active`): `toggle` (V), `back` (Esc while they are away), `hold` (Space, the start of
 * a peek or a tap: BattlefieldPeek.tsx tells them apart by how long it is held), `swallow` (a repeat of those, or any
 * other plain key while they are away: a hidden overlay takes no keys), or null (not ours: Tab, Shift+Space = pass
 * the turn, Ctrl/Meta/Alt combinations, everything while no overlay is up).
 */
export type PeekKey = 'toggle' | 'back' | 'hold' | 'swallow' | null;

export function peekKey(e: KeyPress & { repeat: boolean }, active: boolean, hidden: boolean): PeekKey {
  if (!active || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'v' || e.key === 'V') return e.repeat ? 'swallow' : 'toggle';
  if (e.key === 'Escape' && hidden) return e.repeat ? 'swallow' : 'back';
  if (e.key === ' ' && !e.shiftKey) return e.repeat ? 'swallow' : 'hold';
  if (hidden && e.key !== 'Tab' && e.key !== 'Shift') return 'swallow';
  return null;
}

/** A Space held this long (ms) is a peek; shorter, a tap, which goes on to the overlay as it always did. */
export const PEEK_HOLD_MS = 200;

/** What an ask's Return pill names: the kind of prompt, in a word or two ("Return to scry"). */
export function askPeekLabel(ask: AskMsg, number: boolean): string {
  if (number) return 'number choice';
  switch (ask.kind) {
    case 'choose':
      return ask.reveal ? 'reveal' : 'choice';
    case 'ability':
      return 'ability choice';
    case 'order':
      return 'ordering';
    case 'arrange':
      return ask.graveyard ? 'surveil' : 'scry';
    case 'split':
      return `${ask.label || 'damage'} assignment`;
    case 'confirm':
      return 'question';
    case 'options':
      return 'choice';
    case 'text':
      return 'answer';
    default:
      return 'the prompt';
  }
}

/** "Your graveyard" → "your graveyard" (the pill reads "Return to your graveyard"). */
export function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
