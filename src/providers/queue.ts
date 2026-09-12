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
