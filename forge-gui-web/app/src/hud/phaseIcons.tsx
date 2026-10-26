/**
 * The phase strip's icons (PhaseLadder.tsx): one per part of the turn and one per step, 16×16 line drawings in
 * currentColor, so a lit step takes the ember / steel of whose turn it is. Inline: no assets to load.
 */
import type { Phase } from '@forge-table/protocol';
import type { ReactNode } from 'react';
import type { PhaseGroupKey } from './phaseGroups';

const svg = (body: ReactNode) => (
  <svg className="phase-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {body}
  </svg>
);

/** The main phases: a mana gem. */
const gem = (
  <>
    <path d="M8 2 13 7 8 14 3 7Z" />
    <path d="M3 7h10M8 2 6.2 7 8 14l1.8-7Z" strokeWidth="1" />
  </>
);

const GROUP: Record<PhaseGroupKey, ReactNode> = {
  // Sunrise: the turn begins.
  beginning: (
    <>
      <path d="M2 12h12" />
      <path d="M4.5 12a3.5 3.5 0 0 1 7 0" />
      <path d="M8 4.5V3M3.6 6.6 2.6 5.6M12.4 6.6l1-1" />
    </>
  ),
  main1: gem,
  // Crossed swords.
  combat: (
    <>
      <path d="M3 3l7.5 7.5M13 3 5.5 10.5" />
      <path d="M9 12l3-3M7 12 4 9M11.5 11.5 13 13M4.5 11.5 3 13" />
    </>
  ),
  main2: gem,
  // A crescent moon: the turn winds down.
  end: <path d="M11.5 10.5A5 5 0 1 1 6.5 3a4 4 0 0 0 5 7.5Z" />,
};

const STEP: Partial<Record<Phase, ReactNode>> = {
  // Upkeep: turning over.
  UPKEEP: (
    <>
      <path d="M12.5 6A4.8 4.8 0 0 0 3.6 6.4M3.5 10a4.8 4.8 0 0 0 8.9-.4" />
      <path d="M12.8 3v3h-3M3.2 13v-3h3" />
    </>
  ),
  // Draw: a card coming off the top.
  DRAW: (
    <>
      <rect x="4" y="5" width="8" height="9.5" rx="1.2" />
      <path d="M8 1.5v5M6 4.5l2 2 2-2" />
    </>
  ),
  MAIN1: gem,
  // Beginning of combat: a sword drawn.
  COMBAT_BEGIN: (
    <>
      <path d="M8 2v9M5.5 11h5M8 11v3" />
    </>
  ),
  // Declare attackers: charging forward.
  COMBAT_DECLARE_ATTACKERS: (
    <>
      <path d="M2.5 8h9M8.5 4.5 12 8l-3.5 3.5" />
      <path d="M13.5 4v8" strokeWidth="1" />
    </>
  ),
  // Declare blockers: a shield.
  COMBAT_DECLARE_BLOCKERS: <path d="M8 2 13 4v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4Z" />,
  // First strike: a bolt.
  COMBAT_FIRST_STRIKE_DAMAGE: <path d="M9.5 1.5 4 9h4l-1.5 5.5L12 7H8Z" />,
  // Combat damage: an impact.
  COMBAT_DAMAGE: <path d="M8 1.5 9.4 5.6 13.6 4 11 7.6 14.5 10 10.2 10.2 10.8 14.5 8 11.2 5.2 14.5 5.8 10.2 1.5 10 5 7.6 2.4 4 6.6 5.6Z" />,
  // End of combat: the sword put away.
  COMBAT_END: (
    <>
      <path d="M3 13 12 4M10 2.5l3.5 3.5" />
      <path d="M2.5 9.5l4 4" strokeWidth="1" />
    </>
  ),
  MAIN2: gem,
  // End step: sunset.
  END_OF_TURN: (
    <>
      <path d="M2 11h12" />
      <path d="M4.5 11a3.5 3.5 0 0 1 7 0" />
      <path d="M8 14V12.5M6.5 13.5 8 15l1.5-1.5" strokeWidth="1" />
    </>
  ),
  // Cleanup: the sand runs out.
  CLEANUP: <path d="M4 2h8M4 14h8M5 2l6 12M11 2 5 14M5 2h6M6.5 12.5h3" />,
};

export function GroupIcon({ group }: { group: PhaseGroupKey }) {
  return svg(GROUP[group]);
}

export function StepIcon({ phase }: { phase: Phase }) {
  return svg(STEP[phase] ?? gem);
}
