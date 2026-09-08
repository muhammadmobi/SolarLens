// Launches a SEPARATE Chrome window (own profile, not your daily one) on the
// SolisCloud and SOLARMAN portals and records every JSON API exchange they make
// into captures/ (gitignored). You log in yourself in that window; nothing here
// types credentials.
//
// Secrets AND personal details are redacted on write - the second half of that
// was missing at first, and captures were coming out with the account holder's
// email, phone, address and the site's coordinates in them. captures/ is
// gitignored either way, but "gitignored" is not the same as "safe to attach
// to a bug report", which is what these files are for.
//
//   node scripts/capture-portals.mjs            # runs until captures/STOP exists or 9 min
//   echo > captures/STOP                        # from another shell, to stop early

import { chromium } from 'playwright-core';
import { appendFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const CAPTURES = join(ROOT, 'captures');
const PROFILE = join(ROOT, '.capture-profile');
const STOP = join(CAPTURES, 'STOP');
const LOG = join(CAPTURES, 'log.jsonl');
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MAX_MS = 9 * 60 * 1000;

const PORTALS = [
  'https://www.soliscloud.com',
  'https://home.solarmanpv.com',
];
// Only record traffic to the vendors' own hosts.
const HOST_RE = /soliscloud\.com|solarmanpv\.com|ginlong\.com|solisinverters\.com/i;
const SECRET_KEY_RE = /pass|pwd|secret|token|cookie|authorization|sign/i;
// Personal details, on the same terms as src/providers/soliscloud.ts strips
// them before storage. Location words only count at the start of a key or on a
// camelCase boundary, because "capacity" contains the letters of "city".
const PII_KEY_RE = new RegExp([
  '[Aa]ddr', '[Ee]mail', '[Mm]obile', '[Pp]hone', '[Ii]ccid', '[Pp]icUrl',
  '[Pp]osition', '[Ll]atitude', '[Ll]ongitude',
  '[Nn]ickName', '[Ll]oginName', '[Uu]ser[Ii]d', '[Uu]ser[Nn]ame',
  'City', 'County', 'Country', 'Region',
  '^(?:city|county|country|region)',
].join('|'));
const sensitive = (k) => SECRET_KEY_RE.test(k) || PII_KEY_RE.test(k);

mkdirSync(CAPTURES, { recursive: true });
if (existsSync(STOP)) unlinkSync(STOP);

// Form-encoded bodies (the SolarMan login sends the password as
// clear_text_pwd=...) must be redacted key-by-key too, not just JSON.
function redactForm(s) {
  if (typeof s !== 'string' || !s.includes('=') || s.trim().startsWith('{')) return s;
  const p = new URLSearchParams(s);
  for (const k of [...p.keys()]) {
    if (sensitive(k)) p.set(k, `<redacted len=${p.get(k).length}>`);
  }
  return p.toString();
}
function redact(obj) {
  if (typeof obj === 'string') return redactForm(obj);
  if (Array.isArray(obj)) return obj.map(redact);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      // No "head=" preview: a few characters of a real key is still a few
      // characters of a real key, and the length alone is enough to debug with.
      out[k] = sensitive(k) && (typeof v === 'string' || typeof v === 'number')
        ? `<redacted len=${String(v).length}>`
        : redact(v);
    }
    return out;
  }
  return obj;
}
function redactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = sensitive(k) ? `<redacted len=${v.length}>` : v;
  }
  return out;
}
function tryJson(s) { try { return JSON.parse(s); } catch { return s; } }
function fileSafe(url) {
  const u = new URL(url);
  return (u.host + u.pathname).replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 120);
}

let n = 0;
const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: false,
  viewport: null,
  args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});

ctx.on('response', async (res) => {
  const req = res.request();
  const url = res.url();
  if (!HOST_RE.test(url)) return;
  const type = req.resourceType();
  if (type !== 'xhr' && type !== 'fetch') return;
  let body;
  try { body = await res.text(); } catch { return; }
  const ct = res.headers()['content-type'] ?? '';
  if (!ct.includes('json') && !body.trim().startsWith('{') && !body.trim().startsWith('[')) return;

  const entry = {
    ts: new Date().toISOString(),
    method: req.method(),
    url,
    status: res.status(),
    requestHeaders: redactHeaders(req.headers()),
    postData: redact(tryJson(req.postData() ?? '')),
    response: redact(tryJson(body)),
  };
  n++;
  appendFileSync(LOG, JSON.stringify(entry) + '\n');
  writeFileSync(join(CAPTURES, `${String(n).padStart(3, '0')}_${fileSafe(url)}.json`), JSON.stringify(entry, null, 2));
  console.log(`[${n}] ${req.method()} ${res.status()} ${url.slice(0, 110)}`);
});

const pages = ctx.pages();
for (let i = 0; i < PORTALS.length; i++) {
  const page = i === 0 && pages[0] ? pages[0] : await ctx.newPage();
  await page.goto(PORTALS[i], { waitUntil: 'domcontentloaded' }).catch((e) => console.log('nav failed', PORTALS[i], e.message));
}
console.log(`Chrome open on ${PORTALS.length} portals. Log in, open your plant/inverter pages, then create captures/STOP (or wait ${MAX_MS / 60000} min).`);

const started = Date.now();
while (!existsSync(STOP) && Date.now() - started < MAX_MS) {
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(`Stopping. ${n} API exchanges saved under captures/`);
await ctx.close();
