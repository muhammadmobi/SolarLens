/**
 * How long one vendor call may take before it is abandoned.
 *
 * Every call waits in the queue below for the one before it, so a call that
 * never answered held up every call after it - and the queue is shared by the
 * whole isolate, so possibly the next cron run's too. A vendor that has not
 * answered in twenty seconds is down for this run; the poll log says so, and
 * the next run tries again.
 */
export const CALL_TIMEOUT_MS = 20_000;

/**
 * Serialised call queue with a minimum gap between calls.
 *
 * SolisCloud limits every IP to 3 calls per 5 seconds, and a Worker cron run
 * fans out into several calls (stations -> inverters -> detail). Rather than
 * sprinkle sleeps through the adapters, every outbound vendor call passes
 * through here and the spacing is enforced in one place.
 */
export class CallQueue {
  private chain: Promise<void> = Promise.resolve();
  private lastStart = 0;

  /**
   * Public and mutable so a test can set it to 0.
   *
   * The spacing is right in production and absurd in a unit test: the client
   * tests make about thirty calls, which at 1.5-2s apart would take a minute
   * to assert things that have nothing to do with rate limiting. Faking timers
   * instead does not work - this queue is a module-level singleton, so a timer
   * left pending when one test ends stalls the chain for every test after it.
   */
  constructor(public minGapMs: number) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      const wait = this.lastStart + this.minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastStart = Date.now();
      return fn();
    });
    // Keep the chain alive even when a call fails so later calls still run.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
