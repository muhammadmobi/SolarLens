/**
 * Turn the changelog into release notes, and refuse if the release is not ready.
 *
 * The changelog is the record that ships with the code; a GitHub release is the
 * announcement, and copying one into the other by hand is how a release ends up
 * dated wrong, or tagged at a version package.json does not carry. Every one of
 * those mistakes has happened here.
 *
 * It refuses unless all of this holds:
 *   - package.json carries exactly the version being released,
 *   - the changelog has a section for it,
 *   - the section has a link reference at the bottom of the file,
 *   - no tag of that name exists yet.
 *
 * Usage: node scripts/ci/release-notes.mjs <version> [--out notes.md]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const version = (process.argv[2] ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node scripts/ci/release-notes.mjs <version, e.g. 2.6.0> [--out notes.md]');
  process.exit(2);
}

const problems = [];

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.version !== version) {
  problems.push(`package.json says ${pkg.version}, not ${version} - set it in the pull request that closes this release`);
}

const changelog = readFileSync('CHANGELOG.md', 'utf8').split(/\r?\n/);
const start = changelog.findIndex((l) => l.startsWith(`## [${version}]`));
if (start === -1) problems.push(`CHANGELOG.md has no "## [${version}]" section`);

let body = '';
if (start !== -1) {
  const after = changelog.slice(start + 1);
  const end = after.findIndex((l) => /^## \[/.test(l));
  body = (end === -1 ? after : after.slice(0, end)).join('\n').trim();
  if (!body) problems.push(`the "## [${version}]" section is empty`);
}

if (!changelog.some((l) => l.startsWith(`[${version}]:`))) {
  problems.push(`CHANGELOG.md has no link reference "[${version}]: ..." at the bottom`);
}

try {
  const existing = execFileSync('git', ['tag', '--list', `v${version}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (existing) problems.push(`the tag v${version} already exists`);
} catch { /* no tags at all is not a problem */ }

if (problems.length) {
  console.error(`Not ready to release ${version}:\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const notes = `${body}\n\n---\n\nThe full entry is in [CHANGELOG.md](https://github.com/muhammadmobi/SolarLens/blob/v${version}/CHANGELOG.md).\n`;

const outArg = process.argv.indexOf('--out');
if (outArg !== -1 && process.argv[outArg + 1]) {
  writeFileSync(process.argv[outArg + 1], notes);
  console.log(`Release notes for ${version} written to ${process.argv[outArg + 1]} (${notes.length} characters).`);
} else {
  process.stdout.write(notes);
}
