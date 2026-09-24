/**
 * Ask the live dashboard whether the deploy actually worked.
 *
 * A deploy that returns success and a site that works are different claims.
 * This makes the second one: the page loads, the API answers, readings are
 * arriving, the routes that cost vendor quota or write data still refuse a
 * caller without a token, and - the one this project cares about most - the
 * public responses still carry no vendor identifiers.
 *
 * The address is read from SOLARLENS_URL rather than written down, because the
 * deployment's hostname is not in this repository.
 *
 * Usage: SOLARLENS_URL=https://... node scripts/ci/smoke.mjs
 */
const BASE = (process.env.SOLARLENS_URL ?? '').replace(/\/+$/, '');
if (!BASE) {
  console.error('SOLARLENS_URL is not set.');
  process.exit(2);
}

const FRESH_S = 90 * 60; // one feed this recent means readings are still arriving
const checks = [];
/** Note one check's result, and print it as it happens. */
const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

/** The edge takes a moment to serve a new version, so each request gets a few tries. */
async function get(path, { tries = 4 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}smoke=${Date.now()}`, {
        headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status < 500) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
  }
  throw last ?? new Error('no response');
}

// 1. the page itself
const page = await get('/');
const html = await page.text();
record('the dashboard page loads', page.ok, `HTTP ${page.status}`);
record('the page still carries its security policy', !!page.headers.get('content-security-policy'));

// 2. the health endpoint, and whether readings are arriving
const healthRes = await get('/api/health');
record('/api/health answers', healthRes.ok, `HTTP ${healthRes.status}`);
const health = healthRes.ok ? await healthRes.json() : {};
const feeds = health.feeds ?? [];
const now = Math.floor(Date.now() / 1000);
const freshest = feeds.reduce((best, f) => Math.max(best, f.ts ?? 0), 0);
record(
  'a vendor feed is current',
  freshest > 0 && now - freshest <= FRESH_S,
  freshest ? `newest reading ${Math.round((now - freshest) / 60)} min old` : 'no feed at all',
);

// 3. the readings the dashboard draws
const latestRes = await get('/api/latest');
record('/api/latest answers', latestRes.ok, `HTTP ${latestRes.status}`);
const latestText = latestRes.ok ? await latestRes.text() : '';
let latest = [];
try { latest = JSON.parse(latestText); } catch { /* handled by the check below */ }
const rows = Array.isArray(latest) ? latest : (latest.inverters ?? latest.rows ?? []);
record('at least one inverter is served', rows.length > 0, `${rows.length} row(s)`);

// 4. what the public responses must never contain
// An identifier arrives as a string - "62000000", or a plant_id field - while a
// reading is a bare number. Measurements in watt-hours run to eight digits of
// their own, so only quoted values and id-shaped fields are read as identifiers;
// treating every long number as one would roll a healthy deploy back at dusk.
const bodies = [latestText, healthRes.ok ? JSON.stringify(health) : ''];
const leaks = [];
for (const body of bodies) {
  if (/"raw"\s*:/.test(body)) leaks.push('a raw vendor payload');
  if (/"\d{8,}"/.test(body)) leaks.push('a long number served as a string');
  if (/"(plant_?id|station_?id)"\s*:\s*"?\d{6,}/i.test(body)) leaks.push('a plant or station id');
  if (/-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/.test(body)) leaks.push('a coordinate');
  if (/"(lat|lng|latitude|longitude)"\s*:\s*"?-?\d{1,3}\.\d{4,}/i.test(body)) leaks.push('a coordinate field');
  if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(body)) leaks.push('an email address');
}
record('the public responses carry no identifiers', leaks.length === 0, leaks.join(', '));

// 5. the routes that must still refuse a caller without a token
for (const [path, init] of [
  ['/api/poll', { method: 'POST' }],
  ['/api/ingest/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
]) {
  const res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
  record(`${path} refuses a caller with no token`, res.status === 401, `HTTP ${res.status}`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed.`);
if (failed.length) {
  console.error(`Smoke test failed: ${failed.map((c) => c.name).join('; ')}`);
  process.exit(1);
}
