/**
 * Life-total juice on the plates (MTGA feel), as pure functions: the floating chip a change throws off the
 * shield, and when a total counts as low (the shield's slow pulse).
 */

/** At or below this (and still alive) the shield pulses, slowly. */
export const LOW_LIFE = 5;

/** The chip for a life change: "−3" (a loss, red) or "+2" (a gain, green); null when nothing changed. */
export function lifeChip(from: number, to: number): { text: string; tone: 'loss' | 'gain' } | null {
  const d = to - from;
  if (!Number.isFinite(d) || d === 0) return null;
  return d < 0 ? { text: `−${-d}`, tone: 'loss' } : { text: `+${d}`, tone: 'gain' };
}

export function lowLife(life: number | undefined): boolean {
  return typeof life === 'number' && life > 0 && life <= LOW_LIFE;
}
