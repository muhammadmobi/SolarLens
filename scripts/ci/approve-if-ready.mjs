/**
 * Approve the owner's own pull request, once - and only once - it is ready.
 *
 * GitHub will not let anyone approve their own pull request, and the ruleset on
 * main wants one approval, so the owner's changes could only go in by the admin
 * bypass. This approves them instead, as the Actions bot, when every condition
 * the owner would check by hand holds:
 *
 * - the pull request is the owner's own, and not a draft;
 * - it does not say "do not merge" in its title or description;
 * - every check on its newest commit has finished, and none failed;
 * - Copilot has reviewed that newest commit, not an older one;
 * - no review thread is still open.
 *
 * Anyone else's pull request is left for the owner to review. Run by
 * .github/workflows/approve.yml after the checks finish and after each review;
 * it needs "Allow GitHub Actions to create and approve pull requests" turned on
 * (Settings -> Actions -> General).
 *
 * Usage: GH_TOKEN=... GITHUB_REPOSITORY=owner/repo PR=<number> node scripts/ci/approve-if-ready.mjs
 * With DRY_RUN=1 it says what it would do and approves nothing.
 */
import { execFileSync } from 'node:child_process';

export const OWNER = 'muhammadmobi';
const COPILOT = /copilot-pull-request-reviewer/i;

/**
 * Whether a pull request is ready, and if not, every reason why. Pure, so the
 * tests can hand it any combination.
 */
export function readiness(pr) {
  const why = [];
  if (pr.author !== OWNER) why.push(`it is ${pr.author}'s, and only the owner's own are approved automatically`);
  if (pr.draft) why.push('it is a draft');
  if (/do not merge/i.test(`${pr.title}\n${pr.body ?? ''}`)) why.push('it says "do not merge"');
  const pending = pr.checks.filter((c) => c.status !== 'completed');
  const failed = pr.checks.filter((c) => c.status === 'completed' && !['success', 'skipped', 'neutral'].includes(c.conclusion));
  if (!pr.checks.length) why.push('no checks have run on its newest commit');
  if (pending.length) why.push(`${pending.length} check(s) still running: ${pending.map((c) => c.name).join(', ')}`);
  if (failed.length) why.push(`${failed.length} check(s) failed: ${failed.map((c) => c.name).join(', ')}`);
  const copilot = pr.reviews.filter((r) => COPILOT.test(r.author));
  if (!copilot.some((r) => r.commit === pr.head)) why.push('Copilot has not reviewed its newest commit');
  if (pr.openThreads > 0) why.push(`${pr.openThreads} review thread(s) still open`);
  if (pr.approvedAtHead) why.push('it is already approved at this commit');
  return { ready: why.length === 0, why };
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

/** Everything readiness() needs, from GitHub. */
function load(repo, number) {
  const [owner, name] = repo.split('/');
  const q = `query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){
    title body isDraft author{login} headRefOid
    reviews(last:50){nodes{author{login} state commit{oid}}}
    reviewThreads(first:100){nodes{isResolved}}}}}`;
  const data = JSON.parse(gh(['api', 'graphql', '-f', `query=${q}`, '-f', `o=${owner}`, '-f', `n=${name}`, '-F', `p=${number}`]));
  const p = data.data.repository.pullRequest;
  const runs = JSON.parse(gh(['api', `repos/${repo}/commits/${p.headRefOid}/check-runs?per_page=100`])).check_runs
    // This job's own run is one of them; it cannot wait for itself.
    .filter((c) => c.name !== 'Approve when ready');
  return {
    author: p.author.login, draft: p.isDraft, title: p.title, body: p.body, head: p.headRefOid,
    checks: runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })),
    reviews: p.reviews.nodes.map((r) => ({ author: r.author?.login ?? '', state: r.state, commit: r.commit?.oid })),
    openThreads: p.reviewThreads.nodes.filter((t) => !t.isResolved).length,
    approvedAtHead: p.reviews.nodes.some((r) => /github-actions/.test(r.author?.login ?? '') && r.state === 'APPROVED' && r.commit?.oid === p.headRefOid),
  };
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const number = Number(process.env.PR);
  if (!repo || !number) { console.log('No pull request to look at.'); return; }
  const verdict = readiness(load(repo, number));
  if (!verdict.ready) {
    console.log(`Not approving #${number}: ${verdict.why.join('; ')}.`);
    return;
  }
  console.log(`#${number} is ready: every check passed, Copilot reviewed the newest commit, no thread is open.`);
  if (process.env.DRY_RUN) return;
  gh(['pr', 'review', String(number), '--repo', repo, '--approve', '--body',
    'Approved automatically: every check passed on the newest commit, Copilot has reviewed it, and no review thread is open.']);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) main();
