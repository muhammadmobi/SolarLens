/**
 * The account-specific wrangler config, filled in from the environment.
 *
 * `wrangler.jsonc` is committed with `${CF_D1_DATABASE_ID}` where the real D1
 * database id would go. Wrangler does not substitute environment variables in
 * its own config, so this fills them in, writes the result to
 * `.wrangler.local.jsonc` (gitignored) and returns its path.
 *
 * Values come from the environment, falling back to `.dev.vars`, which is where
 * the project's other local secrets already live. Shared by `wrangler.mjs` and
 * by scripts that need to run wrangler without a shell in between.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = resolve('wrangler.jsonc');
const GENERATED = resolve('.wrangler.local.jsonc');

/** Read KEY=value lines from .dev.vars into the environment, without overriding what is set. */
function loadDevVars() {
  const path = resolve('.dev.vars');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (value && process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/** Writes the filled-in config and returns its path, or exits saying what is missing. */
export function writeLocalConfig() {
  loadDevVars();
  const template = readFileSync(SOURCE, 'utf8');
  const missing = [];
  const filled = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const value = process.env[name];
    if (!value) { missing.push(name); return `\${${name}}`; }
    return value;
  });

  if (missing.length) {
    console.error(
      `wrangler.jsonc needs ${[...new Set(missing)].join(', ')}.\n` +
      `Set it in the environment or in .dev.vars. For CF_D1_DATABASE_ID, run\n` +
      `  npx wrangler d1 create solar-lens\n` +
      `and copy the id it prints (or take it from the Cloudflare dashboard).`,
    );
    process.exit(2);
  }

  writeFileSync(GENERATED, filled);
  return GENERATED;
}
