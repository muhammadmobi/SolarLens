/**
 * Refuse a commit that credits anyone but the repository's owner.
 *
 * Every commit here is authored by one person, and nothing in this repository
 * names an assistant. Tools add that trailer by default, and a single slip
 * cannot be taken back once it is in a pull request's ref, so it is checked
 * rather than remembered.
 *
 * Dependabot's own commits are allowed, because they are plainly a bot's and
 * the alternative is turning its pull requests off.
 *
 * Usage: node scripts/ci/check-attribution.mjs --range <base>..<head>
 */
import { execFileSync } from 'node:child_process';

const ALLOWED_AUTHORS = [
  'muhammadmobi <162428635+muhammadmobi@users.noreply.github.com>',
  'dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>',
];

/** Phrases that must not appear in a commit message. */
const FORBIDDEN = [
  { name: 'a co-author trailer', re: /^\s*co-authored-by:/im },
  { name: 'an assistant named', re: /\b(claude|anthropic|copilot|chatgpt|openai)\b/i },
  { name: 'a generated-with line', re: /generated with|🤖/i },
];

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const rangeArg = process.argv.indexOf('--range');
if (rangeArg === -1 || !process.argv[rangeArg + 1]) {
  console.error('Usage: node scripts/ci/check-attribution.mjs --range <base>..<head>');
  process.exit(2);
}

const shas = git('rev-list', process.argv[rangeArg + 1]).split('\n').filter(Boolean);
const problems = [];

for (const sha of shas) {
  const short = sha.slice(0, 8);
  const author = git('log', '-1', '--format=%an <%ae>', sha).trim();
  const message = git('log', '-1', '--format=%B', sha);

  if (!ALLOWED_AUTHORS.includes(author)) {
    problems.push(`commit ${short}: author is ${author}, which is not the account this repository commits under`);
  }
  for (const { name, re } of FORBIDDEN) {
    if (re.test(message)) problems.push(`commit ${short}: message contains ${name}`);
  }
}

if (problems.length) {
  console.error(`Attribution check failed on ${problems.length} point(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\nFix with an interactive rebase, or re-commit with the right author and message.`);
  process.exit(1);
}
console.log(`Attribution check passed: ${shas.length} commit(s), all authored correctly.`);
