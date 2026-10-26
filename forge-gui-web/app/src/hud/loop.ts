/**
 * The loop shortcut, the way paper players announce one (rule 732.2): show the table the loop once, then say how
 * many more times it goes. Record loop remembers everything I do (Forge's macro recorder); Done asks how many more
 * times and repeats it. Against the AI it runs at once. Against a person they're asked first: accept, accept only
 * the first few repeats (they get priority after that), or respond, and I play it out by hand. While an accepted
 * loop runs, their priority passes; any other choice still asks them.
 */
import type { LoopState } from '@forge-table/protocol';

/** Most repeats one loop asks for (the bridge refuses more). */
export const MAX_LOOP_TIMES = 999;

/** A typed repeat count, or null when it isn't a whole number from 1 to `max`. */
export function repeatCount(text: string, max = MAX_LOOP_TIMES): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= max ? n : null;
}

/** The loop chip's label and whether it's lit, for my own loop (null = idle: "Record loop"). */
export function loopChip(loop: LoopState | undefined): { label: string; on: boolean; title: string } {
  if (!loop) {
    return {
      label: 'Record loop',
      on: false,
      title: 'Record a loop: play it once, then say how many more times it repeats. Against a person they accept it first',
    };
  }
  switch (loop.state) {
    case 'recording': {
      const steps = loop.steps ?? 0;
      return { label: `Recording, ${steps} ${steps === 1 ? 'step' : 'steps'}`, on: true, title: 'Recording what you do. Finish the loop, then press Done' };
    }
    case 'offered':
      return { label: 'Waiting on opponent', on: true, title: `Your opponent is deciding on ${loop.times ?? 0} more repeats. Click to take it back` };
    case 'playing':
      return { label: `Looping ${loop.iteration ?? 0} / ${loop.of ?? 0}`, on: true, title: 'Repeating the loop. Click to stop it here' };
  }
}

/** What the opponent's loop looks like from my side. */
export function opponentLoopText(loop: LoopState): string {
  if (loop.state === 'playing') return `Opponent looping ${loop.iteration ?? 0} / ${loop.of ?? 0}`;
  const times = loop.times ?? 0;
  return `Your opponent wants to repeat a loop ${times} more ${times === 1 ? 'time' : 'times'}.`;
}
