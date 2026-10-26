/**
 * The phase strip's groups (MTGA-style: icons, with substeps hidden until needed): the turn's five parts as icons, Beginning · Main 1 · Combat · Main 2 · End. A part with
 * more than one step opens into its steps while the turn is in it (and while hovered, focused or tapped open, to set a
 * step's stop); closed, its stop pips stand for all of its steps. Pure: the strip (PhaseLadder.tsx) draws it.
 */
import type { Phase } from '@forge-table/protocol';

export type PhaseGroupKey = 'beginning' | 'main1' | 'combat' | 'main2' | 'end';

export interface PhaseGroup {
  key: PhaseGroupKey;
  /** The part's name (its icon's title). */
  label: string;
  steps: readonly Phase[];
}

/** The twelve steps with a stop (untap has none), in turn order, by part. */
export const PHASE_GROUPS: readonly PhaseGroup[] = [
  { key: 'beginning', label: 'Beginning phase', steps: ['UPKEEP', 'DRAW'] },
  { key: 'main1', label: 'Main phase 1', steps: ['MAIN1'] },
  {
    key: 'combat',
    label: 'Combat',
    steps: ['COMBAT_BEGIN', 'COMBAT_DECLARE_ATTACKERS', 'COMBAT_DECLARE_BLOCKERS', 'COMBAT_FIRST_STRIKE_DAMAGE', 'COMBAT_DAMAGE', 'COMBAT_END'],
  },
  { key: 'main2', label: 'Main phase 2', steps: ['MAIN2'] },
  { key: 'end', label: 'Ending phase', steps: ['END_OF_TURN', 'CLEANUP'] },
];

/** The part a step belongs to (untap counts as the beginning), or null for none (no game yet). */
export function groupOf(phase: Phase | null | undefined): PhaseGroupKey | null {
  if (!phase) return null;
  if (phase === 'UNTAP') return 'beginning';
  return PHASE_GROUPS.find((g) => g.steps.includes(phase))?.key ?? null;
}

/** Whether a part shows its steps: it has several and the turn is in it, or it is hovered / tapped open. */
export function isExpanded(group: PhaseGroup, current: PhaseGroupKey | null, open: ReadonlySet<PhaseGroupKey>): boolean {
  return group.steps.length > 1 && (group.key === current || open.has(group.key));
}

/** A closed part's stop pip: on when all its steps stop, `some` when only a few do. */
export type GroupStop = 'on' | 'some' | 'off';

export function groupStop(group: PhaseGroup, stops: readonly Phase[]): GroupStop {
  const n = group.steps.filter((p) => stops.includes(p)).length;
  return n === 0 ? 'off' : n === group.steps.length ? 'on' : 'some';
}

/** The steps to toggle so a closed part's pip flips: all on when any is off, all off when all are on. */
export function groupToggles(group: PhaseGroup, stops: readonly Phase[]): Phase[] {
  const all = groupStop(group, stops) === 'on';
  return group.steps.filter((p) => stops.includes(p) === all);
}
