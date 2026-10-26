/**
 * Injectable time source for the Director and everything that animates, so tests are deterministic.
 * Production uses the page's monotonic clock; `?test=1` swaps in a VirtualClock that only moves when a
 * test calls `window.__table.advance(ms)`, so screenshots never depend on wall time.
 */
export interface Clock {
  /** Milliseconds, monotonic. */
  now(): number;
  readonly virtual: boolean;
}

export class RealClock implements Clock {
  readonly virtual = false;
  now(): number {
    return performance.now();
  }
}

export class VirtualClock implements Clock {
  readonly virtual = true;
  private t: number;

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    if (!(ms >= 0)) throw new Error(`VirtualClock.advance: bad step ${ms}`);
    this.t += ms;
  }
}
