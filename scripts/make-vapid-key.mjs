/**
 * Make the signing key for notifications to a closed browser, and give it to
 * the Worker.
 *
 * Web Push needs the sender to sign each wake-up (RFC 8292, "VAPID"), and the
 * browser to know the public half when it subscribes. This makes a P-256 key
 * pair and stores the private half as the Worker secret VAPID_KEY, handing it
 * to wrangler on standard input: it is never printed, never written to a file,
 * and never passes through a shell. The public half is printed, because it is
 * public - the dashboard serves it to every browser that asks.
 *
 *   node scripts/make-vapid-key.mjs              # does nothing if a key is already set
 *   node scripts/make-vapid-key.mjs --replace    # a new key; every device must turn it on again
 *
 * Needs a signed-in wrangler and CF_D1_DATABASE_ID, like every wrangler script
 * here. Setting a secret deploys the Worker's current code with it, which is
 * why this refuses to replace a key it did not make without being told.
 */
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { writeLocalConfig } from './wrangler-config.mjs';

const REPLACE = process.argv.includes('--replace');
const CONFIG = writeLocalConfig();
const WRANGLER = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');
const wrangler = (args, input) =>
  execFileSync(process.execPath, [WRANGLER, ...args, '--config', CONFIG], {
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });

const listed = JSON.parse(wrangler(['secret', 'list', '--format', 'json']));
const exists = listed.some((s) => s.name === 'VAPID_KEY');
if (exists && !REPLACE) {
  console.log('VAPID_KEY is already set, so nothing was changed.');
  console.log('A new key means every device has to turn notifications on again; to do that anyway, add --replace.');
  process.exit(0);
}

const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
const secret = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d });

wrangler(['secret', 'put', 'VAPID_KEY'], secret);

const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
console.log(exists ? 'VAPID_KEY replaced.' : 'VAPID_KEY set.');
console.log('Public key, which /api/push/key now serves:');
console.log('  ' + point.toString('base64url'));
console.log('');
console.log('On each phone or computer: open the dashboard, Alerts tab, "Also when this browser is closed".');
