import { describe, expect, it } from 'vitest';
import { costPlateBox, costSlot, costTone, isPwFrame } from './face';

describe('costTone (the halo colour of an adjusted cost)', () => {
  it('is down when the new cost is less mana than printed', () => {
    expect(costTone('{2}{U}', '{4}{U}')).toBe('down');
    expect(costTone('{0}', '{3}')).toBe('down');
    expect(costTone('{U}', '{U}{U}')).toBe('down');
  });

  it('is up when it is more mana than printed', () => {
    expect(costTone('{2}{R}', '{1}{R}')).toBe('up');
    expect(costTone('{3}', undefined)).toBe('up'); // no printed cost counts as 0
  });

  it('is same (amber) for as much mana in other symbols', () => {
    expect(costTone('{1}{R}', '{2}')).toBe('same');
    expect(costTone('{W}{W}', '{1}{W}')).toBe('same');
    expect(costTone('{1}{R}', '{1}{R}')).toBe('same');
  });
});

describe('costPlateBox keeps the plate inside the name bar', () => {
  const W = 252;
  const costs = ['{U}', '{2}{U}', '{4}{G}{G}', '{1}{W}{U}{B}{R}{G}', '{10}{W}{W}{U}{U}{B}{B}'];

  for (const art of [false, true]) {
    it(`${art ? 'scan' : 'procedural'} mode: vertically within the bar, right edge on the card, left edge past the card's left quarter`, () => {
      const s = costSlot(W, art);
      for (const cost of costs) {
        const b = costPlateBox(W, { cost, printed: '{3}', art });
        expect(b.y).toBeGreaterThanOrEqual(s.barTop - 1e-9);
        expect(b.y + b.h).toBeLessThanOrEqual(s.barBottom + 1e-9);
        expect(b.x + b.w).toBeLessThanOrEqual(W);
        expect(b.x).toBeGreaterThan(0);
        expect(b.feather).toBeGreaterThan(0);
        expect(b.feather).toBeLessThan(b.w);
      }
    });

    it(`${art ? 'scan' : 'procedural'} mode: covers the longer of the printed and the new run, and grows leftwards`, () => {
      const short = costPlateBox(W, { cost: '{U}', printed: '{U}', art });
      const longNew = costPlateBox(W, { cost: '{3}{U}{U}', printed: '{U}', art });
      const longPrinted = costPlateBox(W, { cost: '{U}', printed: '{3}{U}{U}', art });
      expect(longNew.w).toBeGreaterThan(short.w);
      expect(longNew.x + longNew.w).toBeCloseTo(short.x + short.w); // right edge fixed
      expect(longPrinted).toEqual(longNew);
    });
  }

  it('scales with the card width', () => {
    const a = costPlateBox(252, { cost: '{2}{U}', printed: '{4}{U}', art: false });
    const b = costPlateBox(504, { cost: '{2}{U}', printed: '{4}{U}', art: false });
    expect(b.x).toBeCloseTo(a.x * 2);
    expect(b.w).toBeCloseTo(a.w * 2);
    expect(b.h).toBeCloseTo(a.h * 2);
  });
});

/**
 * Printed costs measured on Scryfall "normal" scans (488×680; FDN Tolarian Terror, WOE, LCI, OTJ, BLB, DSK, KHM, ZNR,
 * ELD, NEO, ONE, SNC, M21, DMU): each pip's outline box with its drop shadow, and the name bar's inside. The
 * Tolarian Terror ({6}{U} cast for {U}) showed the old slot's plate too high and too narrow: the printed pips peeked
 * out under it and to its left.
 */
const SCANS = {
  /** The last pip's box over the frames: left, top, right, bottom (shadow included). */
  lastPip: { x0: 427, y0: 38, x1: 450, y1: 63 },
  /** Pip to pip, left edge to left edge. */
  step: 26,
  bar: { top: 34, bottom: 68 },
};

describe('costSlot on a real scan (art)', () => {
  for (const w of [488, 286, 150, 69]) {
    const k = w / 488;
    it(`a plate over {6}{U} cast for {U} covers every printed pip at ${w} px, inside the bar`, () => {
      const b = costPlateBox(w, { cost: '{U}', printed: '{6}{U}', art: true });
      // Solid (past its feather) from left of the first pip to right of the last, top to bottom with the shadow.
      expect(b.x + b.feather).toBeLessThanOrEqual((SCANS.lastPip.x0 - SCANS.step) * k + 1e-9);
      expect(b.x + b.w).toBeGreaterThanOrEqual(SCANS.lastPip.x1 * k - 1e-9);
      expect(b.y).toBeLessThanOrEqual(SCANS.lastPip.y0 * k);
      expect(b.y + b.h).toBeGreaterThanOrEqual(SCANS.lastPip.y1 * k - 1e-9);
      expect(b.y).toBeGreaterThanOrEqual(SCANS.bar.top * k);
      expect(b.y + b.h).toBeLessThanOrEqual(SCANS.bar.bottom * k);
    });
  }

  it('paints the new pips where the printed ones are: the same size, spacing and centre line', () => {
    const s = costSlot(488, true);
    const pip = SCANS.lastPip;
    expect(s.right - s.r).toBeCloseTo((pip.x0 + pip.x1) / 2, -0.5);
    expect(s.cy).toBeCloseTo((pip.y0 + pip.y1) / 2, -0.5);
    expect(2 * s.r + s.gap).toBeCloseTo(SCANS.step, 0);
    // The colour sample bands stay inside the bar, off the pips.
    expect(s.barTop).toBeGreaterThanOrEqual(SCANS.bar.top);
    expect(s.barTop + s.r * 0.25).toBeLessThan(pip.y0);
  });
});

/**
 * Planeswalker scans, measured like SCANS on the curated "normal" scan of every planeswalker in the modern frame (~300,
 * KTK through 2026): the mean scan's last pip matches the standard one shifted 9.5 px up (cross-correlation), as does
 * the name bar (its edges at 24 and 58 over 34 and 67). Pips are the standard size and spacing. The old slot sat 6 px
 * low with its pips 20 px apart, so the plate missed the first pips of a long cost and ran past the bar into the art.
 */
const PW_SCANS = {
  lastPip: { x0: 427, y0: 28.5, x1: 450, y1: 53.5 },
  step: 26,
  bar: { top: 25, bottom: 57 },
};

describe('a planeswalker scan has the standard cost line, 9.5 px higher', () => {
  it('is told by the face type', () => {
    expect(isPwFrame({ type: { super: ['Legendary'], core: ['Planeswalker'], sub: ['Karn'] } })).toBe(true);
    expect(isPwFrame({ type: { super: [], core: ['Creature'], sub: [] } })).toBe(false);
    expect(isPwFrame(undefined)).toBe(false);
    expect(costSlot(488, false, true)).toEqual(costSlot(488, false));
  });

  for (const w of [488, 286, 150, 69]) {
    const k = w / 488;
    it(`a plate over {2}{U}{U} cast for {U}{U} covers every printed pip at ${w} px, inside the bar`, () => {
      const b = costPlateBox(w, { cost: '{U}{U}', printed: '{2}{U}{U}', art: true, pw: true });
      expect(b.x + b.feather).toBeLessThanOrEqual((PW_SCANS.lastPip.x0 - 2 * PW_SCANS.step) * k + 1e-9);
      expect(b.x + b.w).toBeGreaterThanOrEqual(PW_SCANS.lastPip.x1 * k - 1e-9);
      expect(b.y).toBeLessThanOrEqual(PW_SCANS.lastPip.y0 * k);
      expect(b.y + b.h).toBeGreaterThanOrEqual(PW_SCANS.lastPip.y1 * k - 1e-9);
      expect(b.y).toBeGreaterThanOrEqual(PW_SCANS.bar.top * k);
      expect(b.y + b.h).toBeLessThanOrEqual(PW_SCANS.bar.bottom * k);
    });
  }

  it('paints the new pips where the printed ones are', () => {
    const s = costSlot(488, true, true);
    const pip = PW_SCANS.lastPip;
    expect(s.right - s.r).toBeCloseTo((pip.x0 + pip.x1) / 2, -0.5);
    expect(s.cy).toBeCloseTo((pip.y0 + pip.y1) / 2, -0.5);
    expect(2 * s.r + s.gap).toBeCloseTo(PW_SCANS.step, 0);
    expect(s.barTop).toBeGreaterThanOrEqual(PW_SCANS.bar.top);
    expect(s.barTop + s.r * 0.25).toBeLessThan(pip.y0);
  });
});
