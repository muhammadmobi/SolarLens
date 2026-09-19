/**
 * Refuse a workflow step that trusts a tag.
 *
 * `uses: someone/action@v4` follows a tag, and a tag is a label its owner can
 * move at any time - including to code written after anyone here read it. A
 * forty-character commit cannot be moved, so every third-party action is named
 * that way, with the version it corresponds to in a comment beside it.
 *
 * GitHub's own actions are held to the same rule: the accounts that publish
 * them are exactly the accounts an attacker would most like to borrow.
 *
 * Usage: node scripts/ci/check-pinned-actions.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = '.github/workflows';
const problems = [];

let files;
try {
  files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
} catch {
  console.error(`No ${DIR} directory - has the workflow layout changed?`);
  process.exit(1);
}
if (!files.length) problems.push(`${DIR} has no workflow files`);

for (const file of files) {
  const path = join(DIR, file);
  readFileSync(path, 'utf8').split(/\r?\n/).forEach((line, i) => {
    const m = line.match(/^\s*(?:-\s+)?uses:\s*(\S+)/);
    if (!m) return;
    const ref = m[1].replace(/^['"]|['"]$/g, '');
    // A local action, or a Docker image, is not a tag on someone's repository.
    if (ref.startsWith('./') || ref.startsWith('docker://')) return;
    const at = ref.lastIndexOf('@');
    const version = at === -1 ? '' : ref.slice(at + 1);
    if (!/^[0-9a-f]{40}$/.test(version)) {
      problems.push(`${path}:${i + 1} - ${ref} is pinned to "${version || 'nothing'}" instead of a commit`);
    }
  });
}

if (problems.length) {
  console.error('Pinned-action check failed:\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nFind the commit a tag points at with:');
  console.error('  gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq .object.sha');
  console.error('and leave the tag beside it as a comment, so the version is still readable.');
  process.exit(1);
}
console.log(`Pinned-action check passed: every action in ${files.length} workflow file(s) names a commit.`);
