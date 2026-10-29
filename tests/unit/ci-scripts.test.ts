/**
 * Two of the CI scripts decide something on the owner's behalf, so what they
 * decide is pinned here: when the production watcher opens an issue, and when
 * the owner's own pull request is approved. So is how the wrangler wrapper
 * hands wrangler its arguments, which the deploy's rollback depends on, and
 * how the deploy reads which commit is serving, which its relay note depends on.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DB_WARN_MB, STALE_MIN, judge } from '../../scripts/ci/watch.mjs';
import { OWNER, type PullRequestState, readiness } from '../../scripts/ci/approve-if-ready.mjs';
import { commitOf, jsonIn, liveVersion, messageFor } from '../../scripts/ci/worker-version.mjs';
import { WRANGLER_CLI, wranglerArgs } from '../../scripts/wrangler.mjs';

describe('the version serving, and the commit it records', () => {
  const SHA = 'a'.repeat(40);

  it('takes the version at 100% of the newest deployment, out of wrangler banner and all', () => {
    const raw = `banner line\n${JSON.stringify([
      { versions: [{ version_id: 'old', percentage: 100 }] },
      { versions: [{ version_id: 'canary', percentage: 10 }, { version_id: 'main', percentage: 100 }] },
    ])}\nanother line`;
    expect(liveVersion(jsonIn(raw) as never)).toBe('main');
    expect(liveVersion([])).toBeNull();
  });

  it('reads back the commit the deploy wrote, and nothing from a version that has none', () => {
    expect(commitOf({ annotations: { 'workers/message': messageFor(SHA) } })).toBe(SHA);
    expect(commitOf({ annotations: { 'workers/triggered_by': 'upload' } })).toBeNull();
    expect(commitOf({ annotations: { 'workers/message': 'Smoke test failed for abc123' } })).toBeNull();
    expect(commitOf(null)).toBeNull();
    expect(commitOf(jsonIn(`x\n{"annotations":{"workers/message":"${messageFor(SHA)}"}}\n`, '{', '}') as never)).toBe(SHA);
  });

  it('is written by the deploy in the very form it is read back in', () => {
    const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
    expect(workflow).toContain(`--message "${messageFor('$SHA')}"`);
  });
});

describe('the wrangler wrapper', () => {
  it('hands wrangler every argument whole: a rollback message keeps its spaces', () => {
    const args = wranglerArgs(['rollback', 'v-1', '--yes', '--message', 'Smoke test failed for abc123'], '.wrangler.local.jsonc');
    expect(args).toEqual([WRANGLER_CLI, 'rollback', 'v-1', '--yes', '--message', 'Smoke test failed for abc123', '--config', '.wrangler.local.jsonc']);
  });

  it("reaches wrangler's own entry with Node alone - no shell, no npx shim", () => {
    expect(existsSync(WRANGLER_CLI)).toBe(true);
    const run = spawnSync(process.execPath, [WRANGLER_CLI, '--version'], { encoding: 'utf8', timeout: 60_000 });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/\d+\.\d+\.\d+/);
  }, 90_000);
});

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

  it('warns when the database is filling up, and says how large it is when it is not', () => {
    const at = (bytes: number) => ({ ok: true, status: 200, body: { feeds: [feed('solarman', 4)], db_bytes: bytes } });
    const full = judge(at((DB_WARN_MB + 20) * 1e6), now);
    expect(full.state).toBe('filling');
    expect(full.lines[0]).toMatch(new RegExp(`^The database is ${DB_WARN_MB + 20} MB`));
    const fine = judge(at(120e6), now);
    expect(fine.state).toBe('ok');
    expect(fine.lines).toContain('database: 120 MB');
    // A paid plan's owner sets the line higher.
    expect(judge(at((DB_WARN_MB + 20) * 1e6), now, 8000).state).toBe('ok');
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

  it('holds back while Copilot asks for changes to the newest commit, whatever became of its threads', () => {
    const asked = { author: 'copilot-pull-request-reviewer', state: 'CHANGES_REQUESTED', commit: HEAD };
    expect(readiness(ready({ reviews: [asked] })).why.join()).toMatch(/asked for changes/);
    // Its last word on the commit is what counts: a later review that asks for nothing lets it through.
    expect(readiness(ready({ reviews: [asked, { ...asked, state: 'COMMENTED' }] })).ready).toBe(true);
    // And one asking for changes to an older commit says nothing about this one.
    expect(readiness(ready({ reviews: [{ ...asked, commit: 'older' }, { ...asked, state: 'COMMENTED' }] })).ready).toBe(true);
  });

  it('waits while a review thread is open, and approves a commit only once', () => {
    expect(readiness(ready({ openThreads: 2 })).why.join()).toMatch(/2 review thread/);
    expect(readiness(ready({ approvedAtHead: true })).why.join()).toMatch(/already approved/);
  });
});
