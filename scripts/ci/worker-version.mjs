/**
 * Print the version id the Worker is serving right now.
 *
 * Taken before a deploy, this is what a rollback needs: the version to put back
 * if the new one fails its smoke test. Wrangler prints a banner of its own
 * alongside the JSON, so the array is cut out of the output rather than assumed
 * to be the whole of it.
 *
 * Usage: node scripts/ci/worker-version.mjs
 */
import { execFileSync } from 'node:child_process';

let raw;
try {
  raw = execFileSync(process.execPath, ['scripts/wrangler.mjs', 'deployments', 'list', '--json'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
} catch (e) {
  console.error(`Could not list deployments: ${e.message}`);
  process.exit(1);
}

const start = raw.indexOf('[');
const end = raw.lastIndexOf(']');
if (start === -1 || end === -1) {
  console.error('No deployment list in wrangler output.');
  process.exit(1);
}

let deployments;
try {
  deployments = JSON.parse(raw.slice(start, end + 1));
} catch (e) {
  console.error(`Could not read the deployment list: ${e.message}`);
  process.exit(1);
}

// Oldest first, so the live one is last. A deployment can split traffic between
// versions; the one at 100% is the whole of it, and is what rolling back means.
const current = deployments.at(-1);
const version = current?.versions?.find((v) => v.percentage === 100) ?? current?.versions?.[0];
if (!version?.version_id) {
  console.error('The newest deployment names no version.');
  process.exit(1);
}
console.log(version.version_id);
