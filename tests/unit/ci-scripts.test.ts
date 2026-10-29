/**
 * Two of the CI scripts decide something on the owner's behalf, so what they
 * decide is pinned here: when the production watcher opens an issue, and when
 * the owner's own pull request is approved.
 */
import { describe, expect, it } from 'vitest';
import { STALE_MIN, judge } from '../../scripts/ci/watch.mjs';
import { OWNER, type PullRequestState, readiness } from '../../scripts/ci/approve-if-ready.mjs';

describe('the production watcher', () => {
  const now = 1_790_000_000;
  const feed = (provider: string, minsAgo: number, ok = 1) => ({ provider, ok, ts: now - minsAgo * 60 });
  const answer = (feeds: ReturnType<typeof feed>[]) => ({ ok: true, status: 200, body: { feeds } });

  it('is content while any feed is delivering', () => {
    expect(judge(answer([feed('solarman', 4), feed('soliscloud', 3)]), now).state).toBe('ok');
  });

  it('is content with the relay laptops off, while SolarMan still delivers', () => {
    const v = judge(answer([feed('solarman', 4), feed('soliscloud', 600)]), now);
    expect(v.state).toBe('ok');
    // The quiet feed is still named, for anyone reading the log.
    expect(v.lines.join('\n')).toContain('soliscloud: last good poll 600 min ago');
  });

  it('calls it stale once no feed has delivered for the whole window', () => {
    const v = judge(answer([feed('solarman', STALE_MIN + 5), feed('soliscloud', 400)]), now);
    expect(v.state).toBe('stale');
    expect(v.lines[0]).toContain(`over ${STALE_MIN} minutes`);
  });

  it('counts a failing poll as not delivering, however recent', () => {
    expect(judge(answer([feed('solarman', 2, 0)]), now).state).toBe('stale');
  });

  it('calls it stale when nothing has ever logged', () => {
    expect(judge(answer([]), now).state).toBe('stale');
  });

  it('calls it down when the site does not answer, or answers with an error', () => {
    expect(judge({ error: 'fetch failed' }, now)).toMatchObject({ state: 'down' });
    expect(judge(null, now)).toMatchObject({ state: 'down' });
    expect(judge({ ok: false, status: 503, body: null }, now).lines[0]).toContain('HTTP 503');
  });
});

describe("approving the owner's own pull request", () => {
  const HEAD = 'abc123';
  const ready = (over: Partial<PullRequestState> = {}): PullRequestState => ({
    author: OWNER, draft: false, title: 'A change', body: 'What it does.', head: HEAD,
    checks: [{ name: 'Unit tests', status: 'completed', conclusion: 'success' }, { name: 'CodeQL', status: 'completed', conclusion: 'skipped' }],
    reviews: [{ author: 'copilot-pull-request-reviewer', state: 'COMMENTED', commit: HEAD }],
    openThreads: 0, approvedAtHead: false,
    ...over,
  });

  it('approves when everything holds', () => {
    expect(readiness(ready())).toEqual({ ready: true, why: [] });
  });

  it("leaves anyone else's for the owner", () => {
    expect(readiness(ready({ author: 'dependabot[bot]' })).why.join()).toMatch(/only the owner's own/);
  });

  it('waits for a draft to be marked ready, and respects "do not merge"', () => {
    expect(readiness(ready({ draft: true })).ready).toBe(false);
    expect(readiness(ready({ body: '**Do not merge until every phase is ticked.**' })).why.join()).toMatch(/do not merge/);
  });

  it('waits for every check, and refuses on any failure', () => {
    expect(readiness(ready({ checks: [{ name: 'E2E', status: 'in_progress', conclusion: null }] })).why.join()).toMatch(/still running: E2E/);
    expect(readiness(ready({ checks: [{ name: 'E2E', status: 'completed', conclusion: 'failure' }] })).why.join()).toMatch(/failed: E2E/);
    expect(readiness(ready({ checks: [] })).why.join()).toMatch(/no checks/);
  });

  it("wants Copilot's review of the newest commit, not an older one", () => {
    expect(readiness(ready({ reviews: [{ author: 'copilot-pull-request-reviewer', state: 'COMMENTED', commit: 'older' }] })).why.join()).toMatch(/newest commit/);
    expect(readiness(ready({ reviews: [] })).ready).toBe(false);
  });

  it('waits while a review thread is open, and approves a commit only once', () => {
    expect(readiness(ready({ openThreads: 2 })).why.join()).toMatch(/2 review thread/);
    expect(readiness(ready({ approvedAtHead: true })).why.join()).toMatch(/already approved/);
  });
});
