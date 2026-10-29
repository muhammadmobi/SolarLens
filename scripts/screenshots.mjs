/**
 * Retake the README's screenshots: docs/screenshots/*.png, of the demo.
 *
 * A script rather than an npm one-liner so that setting SCREENSHOTS works the
 * same in PowerShell, cmd and a POSIX shell. The spec is
 * tests/e2e/screenshots.spec.ts; it is skipped in an ordinary test run.
 *
 * Usage: npm run screenshots
 */
import { spawnSync } from 'node:child_process';

const res = spawnSync('npx', ['playwright', 'test', 'tests/e2e/screenshots.spec.ts', '--project=chrome', '--retries=0'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, SCREENSHOTS: '1' },
});
process.exit(res.status ?? 1);
