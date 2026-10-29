/**
 * Watch the live dashboard, and say so on GitHub when it stops working.
 *
 * Run every half hour by .github/workflows/watch.yml. It asks the deployment's
 * /api/status - open whether or not the dashboard is private, and carrying
 * nothing but how fresh each vendor feed is - and decides:
 *
 * - **down**: the site does not answer, or answers with an error;
 * - **stale**: it answers, but no feed at all has delivered for longer than
 *   STALE_MIN - SolarMan's session lapsed and the relays off, a vendor outage,
 *   a Worker whose cron has stopped;
 * - **filling**: readings arrive, but the database has grown past DB_WARN_MB
 *   (/api/status says its size): on D1's free plan a database stops taking
 *   writes at 500 MB, so this warns at 400. On a paid plan, whose limit is
 *   ten gigabytes, set the repository variable DB_WARN_MB higher;
 * - **ok**: at least one feed is current, and the database has room.
 *
 * One feed quiet while another delivers is not an issue: the SolisCloud relay
 * runs on laptops that are switched off now and then, and the phone
 * notifications already say when its login needs renewing. The quiet feed is
 * still listed, in the log and in any issue open for another reason.
 *
 * Anything but ok opens one GitHub issue, labelled "watcher", or comments on
 * the one already open; ok closes it again with a note. So a problem is one
 * issue with a thread of sightings, not an issue every half hour, and the
 * owner's GitHub notifications carry it to their phone.
 *
 * Nothing identifying is written to the issue: not the address, not a plant.
 * The address comes from SOLARLENS_URL, a secret; the issue says which feed and
 * for how long.
 *
 * Usage (as the workflow runs it):
 *   SOLARLENS_URL=... GH_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/ci/watch.mjs
 * With DRY_RUN=1, it prints what it would do and touches no issue.
 */
import { execFileSync } from 'node:child_process';

export const STALE_MIN = 90;
/** The database size, in MB, past which the watcher warns: 80% of D1's free-plan 500 MB. */
export const DB_WARN_MB = 400;
const LABEL = 'watcher';
const TITLE = 'The live dashboard needs a look';

/** What /api/status says, reduced to one verdict and the lines that explain it. */
export function judge(res, now = Math.floor(Date.now() / 1000), warnMb = DB_WARN_MB) {
  if (!res || res.error) return { state: 'down', lines: [`The site did not answer: ${res?.error ?? 'no response'}.`] };
  if (!res.ok) return { state: 'down', lines: [`The site answered HTTP ${res.status}.`] };
  const feeds = Array.isArray(res.body?.feeds) ? res.body.feeds : [];
  if (!feeds.length) return { state: 'stale', lines: ['No vendor feed has logged anything at all.'] };
  const lines = feeds.map((f) => {
    const age = Math.round((now - (f.ts ?? 0)) / 60);
    return `${f.provider}: last ${f.ok ? 'good' : 'failed'} poll ${age} min ago`;
  });
  const fresh = feeds.some((f) => f.ok && now - (f.ts ?? 0) <= STALE_MIN * 60);
  if (!fresh) return { state: 'stale', lines: [`No feed has delivered for over ${STALE_MIN} minutes.`, ...lines] };
  // Size only when the Worker reports it: one before 3.0, or a test double, says nothing.
  const mb = typeof res.body?.db_bytes === 'number' ? res.body.db_bytes / 1e6 : null;
  if (mb !== null && mb >= warnMb) {
    return {
      state: 'filling',
      lines: [`The database is ${Math.round(mb)} MB, past the ${warnMb} MB this watcher warns at. On the free plan it stops taking readings at 500 MB: see the handoff's "When something is wrong".`, ...lines],
    };
  }
  return { state: 'ok', lines: mb === null ? lines : [...lines, `database: ${Math.round(mb)} MB`] };
}

async function fetchStatus(base) {
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/status`, { signal: AbortSignal.timeout(20_000), headers: { 'cache-control': 'no-cache' } });
    const body = res.ok ? await res.json().catch(() => null) : null;
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'inherit'] });

/** The watcher's open issue, if there is one. */
function openIssue() {
  const out = gh(['issue', 'list', '--label', LABEL, '--state', 'open', '--json', 'number', '--limit', '1']);
  return JSON.parse(out)[0]?.number ?? null;
}

async function main() {
  const base = process.env.SOLARLENS_URL;
  if (!base) {
    console.log('SOLARLENS_URL is not set: nothing to watch. Add it as a repository secret to turn the watcher on.');
    return;
  }
  const verdict = judge(await fetchStatus(base), undefined, Number(process.env.DB_WARN_MB) || DB_WARN_MB);
  const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const text = [`**${verdict.state === 'down' ? 'The site is down' : verdict.state === 'stale' ? 'Readings have stopped' : verdict.state === 'filling' ? 'The database is filling up' : 'Back to normal'}** - ${when}`, '', ...verdict.lines.map((l) => `- ${l}`)].join('\n');
  console.log(text);
  if (process.env.DRY_RUN) return;

  const open = openIssue();
  if (verdict.state === 'ok') {
    if (open) {
      gh(['issue', 'comment', String(open), '--body-file', '-'], `${text}\n\nClosing: every feed is delivering again.`);
      gh(['issue', 'close', String(open)]);
    }
    return;
  }
  if (open) {
    gh(['issue', 'comment', String(open), '--body-file', '-'], text);
    return;
  }
  gh(['label', 'create', LABEL, '--color', 'B60205', '--description', 'Opened by the production watcher', '--force']);
  gh(['issue', 'create', '--title', TITLE, '--label', LABEL, '--body-file', '-'],
    `${text}\n\nOpened by \`.github/workflows/watch.yml\`, which checks the live dashboard every half hour and closes this issue itself once readings are arriving again. The handoff's *When something is wrong* says where to look first.`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
