#!/usr/bin/env node
/**
 * Runs wrangler against a config whose account-specific ids come from the
 * environment rather than from the repository.
 *
 * `wrangler.jsonc` is committed with `${CF_D1_DATABASE_ID}` where the real D1
 * database id would go. Wrangler does not substitute environment variables in
 * its own config, so this fills them in first, writes the result to
 * `.wrangler.local.jsonc` (gitignored) and hands wrangler that instead.
 *
 * The generated file is derived, never edited: change `wrangler.jsonc` and the
 * next run picks it up. Values come from the environment, falling back to
 * `.dev.vars`, which is where the project's other local secrets already live.
 *
 *   npm run deploy            -> node scripts/wrangler.mjs deploy
 *   npm run dev -- --remote   -> node scripts/wrangler.mjs dev --remote
 *
 * Anything not needing a substituted id can still call `npx wrangler` directly;
 * it will simply fail with the unresolved placeholder in the message, which is
 * a clearer error than a silently wrong database.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLocalConfig } from './wrangler-config.mjs';

/**
 * wrangler's own command-line entry, run by this same Node.
 *
 * Until 3.0 this spawned `npx wrangler` with `shell: true`, so that npx's .cmd
 * shim would be found on Windows. A shell joins the arguments with spaces and
 * quotes none of them, so an argument with a space in it arrived as several:
 * the deploy's rollback, `--message "Smoke test failed for <commit>"`, reached
 * wrangler as `--message Smoke` and four stray words, which wrangler's strict
 * parser refuses - the one command that has to work when a deploy has failed.
 * Running wrangler's JavaScript entry with Node needs no shell and no shim, on
 * any system, and every argument arrives exactly as it was given.
 */
export const WRANGLER_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/** What Node is started with: wrangler's entry, the caller's arguments whole, then the generated config. */
export const wranglerArgs = (args, config) => [WRANGLER_CLI, ...args, '--config', config];

/** Fill in the config, run wrangler with it, and exit with wrangler's own status. */
function main() {
  const res = spawnSync(process.execPath, wranglerArgs(process.argv.slice(2), writeLocalConfig()), { stdio: 'inherit' });
  if (res.error) console.error(`Could not start wrangler (${res.error.message}). Run "npm ci" first.`);
  process.exit(res.status ?? 1);
}

// Run only when started as a script, so a test can import the argument builder without running wrangler.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) main();
