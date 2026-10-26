import { describe, expect, it } from 'vitest';
import type { PromptBody } from '@forge-table/protocol';
import { AUTO_PAY_HIDE_MS, AutoPay, paying, shouldAutoPay } from './autoPay';

const pay = (over: Partial<PromptBody> = {}): PromptBody => ({
  pid: 7,
  kind: 'payMana',
  message: 'Pay Mana Cost: {R}',
  ok: { label: 'Auto', enabled: true },
  cancel: { label: 'Cancel', enabled: true },
  focusOk: true,
  selectable: ['c1', 'c2'],
  highlighted: [],
  weak: { c1: 2 },
  unambiguous: true,
  ...over,
});

/** `enabled` is false while the player pays by hand (Shift on the cast). */
function setup(enabled = true) {
  let now = 0;
  const sent: string[] = [];
  const ap = new AutoPay({ enabled: () => enabled, now: () => now, press: () => sent.push('ok') });
  return { ap, sent, tick: (ms: number) => (now += ms) };
}

describe('auto-pay when there is only one way', () => {
  it('presses Auto once for an unambiguous payMana prompt', () => {
    const { ap, sent } = setup();
    ap.update(pay(), true);
    expect(sent).toEqual(['ok']);
    // The same prompt again (a promptUpdate while Forge pays): not pressed twice.
    ap.update(pay({ message: 'Pay Mana Cost: 0' }), true);
    expect(sent).toEqual(['ok']);
    // The next payment is a new prompt.
    ap.update(pay({ pid: 9 }), true);
    expect(sent).toEqual(['ok', 'ok']);
  });

  it('leaves the prompt to the player when there is a choice, the player pays by hand (Shift), or Auto is not offered', () => {
    expect(shouldAutoPay(pay({ unambiguous: undefined }), true, true, null)).toBe(false);
    expect(shouldAutoPay(pay(), false, true, null)).toBe(false);
    expect(shouldAutoPay(pay({ ok: { label: 'Auto', enabled: false } }), true, true, null)).toBe(false);
    expect(shouldAutoPay(pay({ kind: 'priority' }), true, true, null)).toBe(false);
    // An overlay (an ask) is up, or no prompt at all.
    expect(shouldAutoPay(pay(), true, false, null)).toBe(false);
    expect(shouldAutoPay(null, true, true, null)).toBe(false);
    const { ap, sent } = setup(false);
    ap.update(pay(), true);
    expect(sent).toEqual([]);
  });

  it('hides the pressed prompt while Forge pays, and shows it again once the table goes still', () => {
    const { ap, tick } = setup();
    expect(ap.hides(pay())).toBe(false);
    ap.update(pay(), true);
    expect(ap.hides(pay())).toBe(true);
    expect(ap.hides(pay({ pid: 8 }))).toBe(false);
    // Taps and mana keep coming (each a HUD update): still hidden, however long the payment animates.
    tick(AUTO_PAY_HIDE_MS - 1);
    ap.update(pay({ message: 'Pay Mana Cost: 0' }), true);
    tick(AUTO_PAY_HIDE_MS - 1);
    expect(ap.hides(pay())).toBe(true);
    // Nothing for a while (Auto couldn't pay): the player gets the prompt back.
    tick(1);
    expect(ap.hides(pay())).toBe(false);
  });

  it('shows the pressed prompt as a bare waiting bar (no Auto Pay button, cost or glows)', () => {
    const p = paying(pay());
    expect(p).toMatchObject({ pid: 7, kind: 'waiting', message: '', selectable: [], weak: {}, ok: { enabled: false }, cancel: { enabled: false } });
  });
});
