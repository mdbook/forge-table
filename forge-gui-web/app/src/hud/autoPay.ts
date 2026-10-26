/**
 * Auto-pay when there's only one way ("where there's no other possible way to do the mana, auto-pay autocompletes
 * so it never asks you to auto pay once you cast"). The bridge decides (OnlyWay.java: it knows every source's real
 * options) and marks the payMana prompt `unambiguous`; the client presses the same Auto (`ok`) the player would, once
 * per prompt, and keeps the prompt bar off screen meanwhile so it doesn't flash up. Forge's Auto then taps the lands
 * through the usual tap + mana beats, so each land that paid throws its mana sparks (choreography `manaPool`).
 *
 * Always on (no toggle); Shift while casting pays by hand instead. The decision lives here, not on the bridge: the
 * act is the existing `ok`, and an old bridge simply never sends the hint.
 */
import type { PromptBody } from '@forge-table/protocol';

/** How long the pressed prompt stays hidden once the table stops changing (Auto failed): then the player sees it. */
export const AUTO_PAY_HIDE_MS = 1500;

/** Whether to press Auto for the player on this prompt: not paying by hand (`on`) and the bridge says there's only one way. */
export function shouldAutoPay(prompt: PromptBody | null, on: boolean, live: boolean, pressedPid: number | null): boolean {
  return on && live && !!prompt && prompt.kind === 'payMana' && prompt.unambiguous === true && prompt.ok.enabled && prompt.pid !== pressedPid;
}

/** Remembers the payMana prompt Auto was pressed for, so it's pressed once and not drawn while Forge pays. */
export class AutoPay {
  private pid: number | null = null;
  private at = -Infinity;

  constructor(private readonly deps: { enabled: () => boolean; now: () => number; press: () => void }) {}

  /**
   * Each HUD update (the table changed): press Auto when the prompt at the playhead can only be paid one way. While
   * the pressed prompt is still up, a change is Forge paying (taps, mana), which keeps it hidden a while longer.
   */
  update(prompt: PromptBody | null, live: boolean): void {
    if (prompt && prompt.pid === this.pid) this.at = this.deps.now();
    if (!shouldAutoPay(prompt, this.deps.enabled(), live, this.pid)) return;
    this.pid = prompt!.pid;
    this.at = this.deps.now();
    this.deps.press();
  }

  /** The pressed prompt is kept off the HUD (shown as waiting) until the engine moves on, or the table goes still. */
  hides(prompt: PromptBody | null): boolean {
    return !!prompt && prompt.kind === 'payMana' && prompt.pid === this.pid && this.deps.now() - this.at < AUTO_PAY_HIDE_MS;
  }
}

/** The prompt as the HUD shows it while Forge pays: a bare waiting bar (no Auto Pay button, cost tracker or glows). */
export function paying(prompt: PromptBody): PromptBody {
  return { ...prompt, kind: 'waiting', message: '', selectable: [], highlighted: [], weak: {}, ok: { label: '', enabled: false }, cancel: { label: '', enabled: false } };
}
