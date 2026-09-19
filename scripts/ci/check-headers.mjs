/**
 * Keep the two copies of the security headers identical.
 *
 * Cloudflare's asset handler serves public/ straight from the edge without
 * running the Worker, so the Worker's header middleware never sees a request
 * for the page itself. The policy therefore exists twice: in src/index.ts for
 * everything the Worker answers, and in public/_headers for the page. Two
 * copies drift - and the copy that would quietly stop protecting the page is
 * the one nobody looks at.
 *
 * Usage: node scripts/ci/check-headers.mjs
 */
import { readFileSync } from 'node:fs';

const worker = readFileSync('src/index.ts', 'utf8');
const headersFile = readFileSync('public/_headers', 'utf8');

/** The Worker's Content-Security-Policy, rebuilt from the array it joins. */
function workerCsp() {
  const block = worker.match(/h\.set\('Content-Security-Policy',\s*\[([\s\S]*?)\]\.join\('; '\)\)/);
  if (!block) return null;
  // Each part is a double-quoted string that itself contains single quotes.
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).join('; ');
}

/** The other headers the Worker sets, as name -> value. */
function workerHeaders() {
  const out = new Map();
  for (const m of worker.matchAll(/h\.set\('([^']+)',\s*'([^']*)'\)/g)) out.set(m[1], m[2]);
  return out;
}

/** The headers public/_headers serves for every page, as name -> value. */
function staticHeaders() {
  const out = new Map();
  const lines = headersFile.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '/*');
  if (start === -1) return out;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next rule's path, unindented
    const m = line.match(/^\s+([A-Za-z-]+):\s*(.+?)\s*$/);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

const problems = [];
const csp = workerCsp();
const fromWorker = workerHeaders();
const fromStatic = staticHeaders();

if (!csp) problems.push('could not find the Content-Security-Policy the Worker builds in src/index.ts');
if (!fromStatic.size) problems.push('could not find the /* block in public/_headers');

if (csp && fromStatic.size) {
  const staticCsp = fromStatic.get('Content-Security-Policy');
  if (!staticCsp) problems.push('public/_headers has no Content-Security-Policy for the page');
  else if (staticCsp !== csp) {
    problems.push('the two Content-Security-Policy values differ:');
    problems.push(`  worker: ${csp}`);
    problems.push(`  page:   ${staticCsp}`);
  }
  for (const name of ['X-Content-Type-Options', 'Referrer-Policy', 'Cross-Origin-Opener-Policy', 'X-Frame-Options']) {
    const a = fromWorker.get(name);
    const b = fromStatic.get(name);
    if (a === undefined) problems.push(`the Worker no longer sets ${name}`);
    else if (b === undefined) problems.push(`public/_headers no longer sets ${name}`);
    else if (a !== b) problems.push(`${name} differs: worker "${a}", page "${b}"`);
  }
}

if (problems.length) {
  console.error('Header check failed:\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nChange both copies, or neither.');
  process.exit(1);
}
console.log('Header check passed: the Worker and the page serve the same security headers.');
