import { describe, expect, it } from 'vitest';
import { CallQueue } from '../../src/providers/queue';

/**
 * SolisCloud allows three calls per five seconds per IP, and one cron run fans
 * out into several. The queue is the only thing standing between a poll and a
 * rate-limit ban, so its two promises matter: calls are serialised in order,
 * and one failure does not stop the ones behind it.
 */
describe('CallQueue', () => {
  it('runs calls in the order they were queued', async () => {
    const q = new CallQueue(0);
    const seen: number[] = [];
    await Promise.all([1, 2, 3].map((n) => q.run(async () => { seen.push(n); })));
    expect(seen).toEqual([1, 2, 3]);
  });

  it('leaves at least the minimum gap between the starts of two calls', async () => {
    const q = new CallQueue(40);
    const starts: number[] = [];
    const mark = () => q.run(async () => { starts.push(Date.now()); });
    await Promise.all([mark(), mark(), mark()]);
    // Timers fire no earlier than asked but can fire late, so the assertion is
    // one-sided: the gap is a floor, not a target.
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(35);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(35);
  });

  it('passes the call\'s own result back to its caller', async () => {
    const q = new CallQueue(0);
    await expect(q.run(async () => 'station list')).resolves.toBe('station list');
  });

  it('rejects the call that failed, and only that one', async () => {
    const q = new CallQueue(0);
    const bad = q.run(async () => { throw new Error('HTTP 408'); });
    const after = q.run(async () => 'still running');
    await expect(bad).rejects.toThrow('HTTP 408');
    // A vendor timing out one request must not silently strand the rest of the
    // poll behind a broken chain.
    await expect(after).resolves.toBe('still running');
  });

  it('keeps working after a failure, for calls queued later still', async () => {
    const q = new CallQueue(0);
    await q.run(async () => { throw new Error('boom'); }).catch(() => undefined);
    await expect(q.run(async () => 'fine')).resolves.toBe('fine');
  });
});
