/**
 * Print the version id the Worker is serving right now - or, with --commit, the
 * commit that version was deployed from.
 *
 * Taken before a deploy, the version id is what a rollback needs: the version to
 * put back if the new one fails its smoke test. The commit is what the relay
 * note compares with, to say whether the relay laptops need updating: the
 * deploy records it on each version it makes (`wrangler deploy --message`), so
 * it is read from whatever is actually serving - right after a rollback or a
 * re-run of an older deploy, which a list of past workflow runs would not be.
 * A version deployed before that was recorded has none, and says so.
 *
 * Wrangler prints a banner of its own alongside the JSON, so the JSON is cut out
 * of the output rather than assumed to be the whole of it.
 *
 * Usage: node scripts/ci/worker-version.mjs [--commit]
 */
import { execFileSync } from 'node:child_process';

/** The message the deploy puts on each version, and how the commit is read back out of it. */
export const messageFor = (sha) => `From commit ${sha}`;

/** The JSON in wrangler's output, without its banner. */
export function jsonIn(raw, open = '[', close = ']') {
  const start = raw.indexOf(open);
  const end = raw.lastIndexOf(close);
  if (start === -1 || end === -1) throw new Error('No JSON in wrangler output.');
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * The version serving all traffic, from `wrangler deployments list --json`.
 * Oldest first, so the live deployment is last. A deployment can split traffic
 * between versions; the one at 100% is the whole of it, and is what rolling
 * back means.
 */
export function liveVersion(deployments) {
  const current = deployments.at(-1);
  const version = current?.versions?.find((v) => v.percentage === 100) ?? current?.versions?.[0];
  return version?.version_id ?? null;
}

/** The commit a version records, from `wrangler versions view --json`, or null when it records none. */
export function commitOf(view) {
  const message = view?.annotations?.['workers/message'];
  return typeof message === 'string' ? (/\b[0-9a-f]{40}\b/.exec(message)?.[0] ?? null) : null;
}

const wrangler = (...args) => execFileSync(process.execPath, ['scripts/wrangler.mjs', ...args], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});

function main() {
  let version;
  try {
    version = liveVersion(jsonIn(wrangler('deployments', 'list', '--json')));
  } catch (e) {
    console.error(`Could not read the deployments: ${e.message}`);
    process.exit(1);
  }
  if (!version) {
    console.error('The newest deployment names no version.');
    process.exit(1);
  }
  if (!process.argv.includes('--commit')) {
    console.log(version);
    return;
  }
  let commit;
  try {
    commit = commitOf(jsonIn(wrangler('versions', 'view', version, '--json'), '{', '}'));
  } catch (e) {
    console.error(`Could not read version ${version}: ${e.message}`);
    process.exit(1);
  }
  if (!commit) {
    console.error(`Version ${version} records no commit: it was deployed before deploys recorded one.`);
    process.exit(1);
  }
  console.log(commit);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) main();
