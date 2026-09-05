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

  constructor(private readonly minGapMs: number) {}

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
