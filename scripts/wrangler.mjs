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
import { writeLocalConfig } from './wrangler-config.mjs';

const GENERATED = writeLocalConfig();

// shell:true so this works the same from cmd, PowerShell and a POSIX shell -
// npx resolves through a .cmd shim on Windows that spawnSync will not find on
// its own.
const res = spawnSync(
  'npx',
  ['wrangler', ...process.argv.slice(2), '--config', GENERATED],
  { stdio: 'inherit', shell: true },
);
process.exit(res.status ?? 1);
