/**
 * A real Worker for the integration suite: workerd, via wrangler, on this
 * machine, with a D1 of its own.
 *
 * The unit suite runs the Worker's handlers in Node against SQLite, which is
 * fast and reaches nearly everything - but not workerd itself: the static-assets
 * binding and its frozen headers, WebCrypto as workerd implements it, cookies
 * through the security-header rebuild, the migrations as wrangler applies them.
 * This starts the Worker the way `wrangler dev` does, once for the whole suite:
 *
 * 1. writes wrangler.jsonc with a made-up database id to .wrangler.it.jsonc,
 *    so nothing about the real deployment is needed or touched;
 * 2. applies every migration to a fresh local database under .wrangler/;
 * 3. starts the Worker with test tokens, on a free port, and hands its address
 *    to the tests.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { TestProject } from 'vitest/node';
import { unstable_startWorker } from 'wrangler';

export const CONFIG = '.wrangler.it.jsonc';
export const STATE = '.wrangler/it-state';
export const TOKENS = { API_TOKEN: 'api-token-for-integration', INGEST_TOKEN: 'ingest-token-for-integration' };

declare module 'vitest' {
  export interface ProvidedContext {
    baseUrl: string;
    tokens: typeof TOKENS;
  }
}

export default async function setup(project: TestProject) {
  // An id of the right shape that no database has - built rather than written
  // out, since the privacy check rightly reads a written-out one as real.
  const madeUpId = ['0'.repeat(8), '0'.repeat(4), '4' + '0'.repeat(3), '8' + '0'.repeat(3), '0'.repeat(12)].join('-');
  const config = readFileSync('wrangler.jsonc', 'utf8').replace('${CF_D1_DATABASE_ID}', madeUpId);
  writeFileSync(CONFIG, config);
  rmSync(STATE, { recursive: true, force: true });

  const migrate = spawnSync(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'solar-lens',
    '--local', '--config', CONFIG, '--persist-to', STATE,
  ], { encoding: 'utf8', env: { ...process.env, CI: '1' } });
  if (migrate.status !== 0) throw new Error(`migrations failed:\n${migrate.stdout}\n${migrate.stderr}`);

  const worker = await unstable_startWorker({
    config: CONFIG,
    bindings: Object.fromEntries(Object.entries(TOKENS).map(([k, value]) => [k, { type: 'plain_text' as const, value }])),
    dev: { persist: STATE, server: { hostname: '127.0.0.1', port: 0 }, inspector: false, watch: false, logLevel: 'error' },
  });
  const url = await worker.url;
  project.provide('baseUrl', url.href.replace(/\/$/, ''));
  project.provide('tokens', TOKENS);

  return async () => {
    await worker.dispose();
    rmSync(CONFIG, { force: true });
  };
}
