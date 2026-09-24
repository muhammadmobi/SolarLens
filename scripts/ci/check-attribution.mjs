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

/**
 * Identity is the address, not the display name.
 *
 * The name beside it is whatever the client was configured with: a commit made
 * on github.com carries the account's profile name, a commit made on a laptop
 * carries git's local one, and both are the same person. Checking the name
 * refused a merge commit the "Update branch" button had made - correctly
 * authored, differently labelled.
 */
const ALLOWED_EMAILS = [
  '162428635+muhammadmobi@users.noreply.github.com',
  '49699333+dependabot[bot]@users.noreply.github.com',
];

/**
 * What must not appear in a commit message.
 *
 * The rule is about *credit*, not about vocabulary. Naming a tool is ordinary
 * prose - a commit that configures an automated reviewer has to say which one -
 * and refusing the word outright failed exactly that commit. What is refused is
 * a message that hands authorship to something: a trailer, a "generated with"
 * line, or a sentence crediting an assistant for the work.
 */
const ASSISTANT = String.raw`(claude|anthropic|copilot|chatgpt|openai|gemini|cursor)`;
const FORBIDDEN = [
  { name: 'a co-author trailer', re: /^\s*co-authored-by:/im },
  { name: 'a generated-with line', re: /generated with|🤖/i },
  {
    name: 'credit given to an assistant',
    re: new RegExp(
      // "written by Claude", "authored with Copilot", "created using ChatGPT"
      String.raw`\b(written|authored|generated|created|produced|co-?authored|made)\b[^.\n]{0,20}\b(by|with|using)\b[^.\n]{0,20}\b${ASSISTANT}\b`
      // "Claude wrote this", "Copilot generated the tests"
      + String.raw`|\b${ASSISTANT}\b[^.\n]{0,20}\b(wrote|authored|generated|created|produced|implemented)\b`
      // a sign-off naming one
      + String.raw`|^\s*(signed-off-by|assisted-by|on-behalf-of):[^\n]*\b${ASSISTANT}\b`,
      'im',
    ),
  },
];

// Run git and return what it printed.
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
  const email = git('log', '-1', '--format=%ae', sha).trim().toLowerCase();
  const message = git('log', '-1', '--format=%B', sha);

  if (!ALLOWED_EMAILS.includes(email)) {
    problems.push(`commit ${short}: author is ${author}, whose address is not one this repository commits under`);
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
