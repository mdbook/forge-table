/**
 * The pick badge (selection clarity, table/selection.ts): a cyan disc with a dark check, or the pick's number when
 * more than one can be picked. The same badge marks picked cards on the table (Pixi, cardSprite.ts), picked cards
 * in every chooser, and picked players on their plates.
 */
import { PICK_CHECK } from '../table/selection';

export function PickBadge({ label, testId }: { label: string; testId?: string }) {
  return (
    <span className="pick-badge num" data-testid={testId} aria-label={label === PICK_CHECK ? 'picked' : `pick ${label}`}>
      {label === PICK_CHECK ? (
        <svg viewBox="-10 -10 20 20" aria-hidden="true">
          <path d="M -4.2 0.2 L -1.2 3.2 L 4.4 -3" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        label
      )}
    </span>
  );
}
