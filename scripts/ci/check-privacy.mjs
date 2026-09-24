/**
 * Refuse a change that carries an identifier into the repository.
 *
 * SolarLens is public, and the dashboard it serves is public too: what keeps
 * that safe is that no plant id, station id, coordinate, account email or
 * database id is ever written down here. That rule was broken twice before it
 * was noticed, and the repair - rewriting history and asking GitHub Support to
 * garbage-collect the old objects - is expensive and never quite complete,
 * because a pull request's own ref keeps its commits forever. A check that
 * refuses the push is worth a great deal more than a good intention.
 *
 * It looks in three places, because the leak has come from each of them:
 *
 *   - every file in the working tree,
 *   - every commit in the pull request, patch and message, not only the final
 *     tree: an identifier added in one commit and removed in the next still
 *     lives in the pull request's ref for good,
 *   - the pull request's own description.
 *
 * The real values never appear here. They come from the PRIVACY_VALUES secret,
 * one per line, which GitHub masks in logs; the shapes below catch anything
 * nobody thought to list. A failure names the file and line and the rule it
 * broke, never what it matched.
 *
 * Usage:
 *   node scripts/ci/check-privacy.mjs [--range <base>..<head>] [--no-worktree]
 *   PRIVACY_VALUES  optional, newline-separated exact values to refuse
 *   PR_BODY         optional, the pull request description to scan
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const ALLOW_FILE = '.github/privacy-allow.txt';
const SKIP_FILES = /^(package-lock\.json|\.github\/privacy-allow\.txt|scripts\/ci\/check-privacy\.mjs)$/;
const SKIP_EXT = /\.(png|ico|svg|webp|jpg|jpeg|gif|woff2?|zip)$/i;

/**
 * Domains that may appear in an address: GitHub's own, the vendors' support
 * desks, and addresses that are plainly not real.
 *
 * GitHub's is here because Dependabot signs every commit it makes
 * `Signed-off-by: dependabot[bot] <support@github.com>`, and refusing that
 * refuses every dependency update it opens.
 */
const EMAIL_OK = /@(example\.(com|org|net|invalid)|([\w-]+\.)*github\.com|solarmanpv\.com|soliscloud\.com)$/i;

/** A ten or thirteen digit number in this range is a timestamp, not an id. */
const isEpoch = (s) =>
  (s.length === 10 && +s >= 1_600_000_000 && +s <= 2_100_000_000) ||
  (s.length === 13 && +s >= 1_600_000_000_000 && +s <= 2_100_000_000_000);

const allow = new Set(
  (existsSync(ALLOW_FILE) ? readFileSync(ALLOW_FILE, 'utf8') : '')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean),
);

const secrets = (process.env.PRIVACY_VALUES ?? '')
  .split(/[\r\n,]+/)
  .map((s) => s.trim())
  .filter((s) => s.length >= 4);

// Run git and return what it printed.
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Every rule returns the reason it refused a line, or null. */
const rules = [
  {
    name: 'the deployment address',
    test: (line) => /\b[a-z0-9][a-z0-9-]{0,62}\.workers\.dev\b/i.test(line),
  },
  {
    name: 'an email address',
    // A top-level domain of at least two letters: "a@b.c" in a test is not an address.
    test: (line) => (line.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi) ?? []).some((m) => !EMAIL_OK.test(m)),
  },
  {
    name: 'a database id',
    test: (line) => /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(line),
  },
  {
    name: 'a coordinate',
    test: (line) =>
      /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/.test(line) ||
      /\b(lat|lng|latitude|longitude)\b\s*["']?\s*[:=]\s*"?-?\d{1,3}\.\d{4,}/i.test(line),
  },
  {
    name: 'a long number that could be a plant or station id',
    // A run of digits on its own, not part of a longer word: the digits inside
    // a pinned commit hash are not an id, and reading them as one made this
    // check fail on its own workflow file.
    test: (line) =>
      (line.match(/(?<![\w.])\d{8,}(?![\w.])/g) ?? []).some((n) => !isEpoch(n) && !allow.has(n)),
  },
  {
    name: 'a value listed in the PRIVACY_VALUES secret',
    test: (line) => secrets.some((v) => line.toLowerCase().includes(v.toLowerCase())),
  },
];

const findings = [];
/** Check every line of `text` against every rule, recording each refusal against `where`. */
const scan = (where, text) => {
  text.split(/\r?\n/).forEach((line, i) => {
    for (const rule of rules) {
      let hit = false;
      try { hit = rule.test(line); } catch { hit = false; }
      if (hit) findings.push(`${where}:${i + 1} - ${rule.name}`);
    }
  });
};

// 1. the working tree
if (!process.argv.includes('--no-worktree')) {
  for (const file of git('ls-files').split('\n').filter(Boolean)) {
    if (SKIP_FILES.test(file) || SKIP_EXT.test(file)) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    scan(file, text);
  }
}

// 2. every commit of the pull request, patch and message
const rangeArg = process.argv.indexOf('--range');
if (rangeArg !== -1 && process.argv[rangeArg + 1]) {
  const range = process.argv[rangeArg + 1];
  const shas = git('rev-list', range).split('\n').filter(Boolean);
  for (const sha of shas) {
    const short = sha.slice(0, 8);
    scan(`commit ${short} message`, git('log', '-1', '--format=%B', sha));
    // Only added lines matter: a line the commit removes was already in history.
    const patch = git('show', '--format=', '--unified=0', '--no-color', sha);
    const added = patch
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .filter((l) => !/^\+\s*"(version|resolved|integrity)":/.test(l))
      .join('\n');
    scan(`commit ${short} patch`, added);
  }
}

// 3. the pull request's description
if (process.env.PR_BODY) scan('pull request description', process.env.PR_BODY);

if (findings.length) {
  console.error(`Privacy check failed: ${findings.length} place(s) look like an identifier.\n`);
  for (const f of findings) console.error(`  ${f}`);
  console.error(`\nThe matched text is deliberately not printed. Open each place and look.`);
  console.error(`A number that is genuinely made up belongs in ${ALLOW_FILE}, with a note saying so.`);
  process.exit(1);
}
console.log('Privacy check passed: no identifiers in the files, the commits or the description.');
