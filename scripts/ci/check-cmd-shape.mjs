/**
 * Keep the double-click .cmd files in the shape that survives their own update.
 *
 * Both of them run a script that pulls new code, which can replace the .cmd
 * while it is still running. cmd.exe reads a batch file a line at a time and
 * carries on from the same byte offset in whatever the file now says: in a
 * test, a file rewritten under a running batch went on to run half a line as a
 * command. A parenthesised block is read whole before any of it runs, which is
 * why everything after `setlocal` lives inside one, and why that is checked
 * rather than remembered.
 *
 * Windows line endings matter for the same reason: .gitattributes gives them
 * CRLF on every machine, and this fails if a file ever arrives without them.
 *
 * Usage: node scripts/ci/check-cmd-shape.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '*.cmd'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const problems = [];

if (!files.length) problems.push('no .cmd files found - has the relay entry point moved?');

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split('\n');

  const bodyLines = lines.filter((l) => l.trim() !== '');
  if (!bodyLines.every((l) => l.endsWith('\r'))) {
    problems.push(`${file}: not every line ends with a Windows line ending`);
  }

  const text = lines.map((l) => l.replace(/\r$/, ''));
  const open = text.findIndex((l) => l.trim() === '(');
  const lastMeaningful = text.map((l) => l.trim()).filter(Boolean).pop();

  if (open === -1) {
    problems.push(`${file}: no "(" line - the body must sit inside one block`);
  } else if (lastMeaningful !== ')') {
    problems.push(`${file}: the last line is "${lastMeaningful}", not ")" - the block must close at the end`);
  }

  text.forEach((line, i) => {
    if (/^\s*powershell\b/i.test(line) && open !== -1 && i < open) {
      problems.push(`${file}:${i + 1}: powershell runs before the block opens`);
    }
  });

  if (/^\s*timeout\b/im.test(text.join('\n'))) {
    problems.push(`${file}: calls "timeout" by name; use "%SystemRoot%\\System32\\timeout.exe" so a timeout.exe from another toolchain on PATH cannot answer instead`);
  }
}

if (problems.length) {
  console.error('Batch file check failed:\n');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`Batch file check passed: ${files.length} file(s), each one block with Windows line endings.`);
