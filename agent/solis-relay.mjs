#!/usr/bin/env node
/**
 * SolarLens - SolisCloud relay agent
 *
 * Why this exists: the SolisCloud web portal signs every API call with a secret
 * embedded in its own JavaScript, so a copied session token alone cannot be
 * replayed from the cloud (unlike SolarMan). Instead of reverse-engineering
 * that, this agent lets the *real* portal do the talking: it opens your
 * logged-in SolisCloud session in Chrome, reads the plant snapshot the page
 * itself fetches, and pushes it to your SolarLens Worker's /api/ingest/station,
 * where the same normaliser the cloud poller uses turns it into a reading.
 *
 * Use it until your official SolisCloud API key arrives; it keeps working across
 * portal releases because it never touches the signing logic. It only runs
 * while this machine and Chrome are up - that is the honest cost of a no-key route.
 *
 * First run: a Chrome window opens on the SolisCloud login page. Sign in once;
 * the session is kept in ./.relay-profile (gitignored) for later runs.
 *
 *   SOLARLENS_URL=https://solar-lens.<you>.workers.dev INGEST_TOKEN=... node agent/solis-relay.mjs
 *
 * Env:
 *   SOLARLENS_URL       (required) your Worker origin
 *   INGEST_TOKEN        (required) the Worker's INGEST_TOKEN secret
 *   SOLIS_PLANT_IDS     comma-separated plant ids to push; unset = every plant on the account
 *   RELAY_INTERVAL_MIN  minutes between pushes (default 5; Solis updates ~5 min)
 *   RELAY_HEADLESS      "1" to run without a window (only after the session exists)
 *   RELAY_PROFILE       Chrome profile dir (default ./.relay-profile)
 *   CHROME_PATH         explicit Chrome binary; default uses the installed Google Chrome
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`missing env ${k}`); process.exit(2); } return v; };
const SOLARLENS_URL = need('SOLARLENS_URL').replace(/\/+$/, '');
const INGEST_TOKEN = need('INGEST_TOKEN');
const PLANTS = (process.env.SOLIS_PLANT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const INTERVAL_MS = Math.max(1, Number(process.env.RELAY_INTERVAL_MIN ?? 5)) * 60_000;
const HEADLESS = process.env.RELAY_HEADLESS === '1';
const PROFILE = resolve(process.env.RELAY_PROFILE ?? '.relay-profile');
const PORTAL = 'https://www.soliscloud.com';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(PROFILE, { recursive: true });
const firstRun = !existsSync(resolve(PROFILE, 'Default'));
if (HEADLESS && firstRun) {
  console.error('No saved session yet - run once without RELAY_HEADLESS=1 and log in, then go headless.');
  process.exit(2);
}

/** Plants seen on the portal's own plant list: id -> { name, capacityW }. */
const known = new Map();

let ctx = null;
let page = null;

/** Launch Chrome, or relaunch it if the window was closed since the last cycle. */
async function ensureBrowser() {
  if (page && !page.isClosed()) return;
  if (ctx) { await ctx.close().catch(() => {}); log('browser was closed - relaunching'); }
  ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 800 },
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('response', onResponse);
}

async function push(plantId, raw) {
  const meta = known.get(plantId) ?? {};
  const body = { provider: 'soliscloud', plantId, name: meta.name ?? raw.stationName ?? '', capacityW: meta.capacityW ?? null, source: 'soliscloud-relay', raw };
  const res = await fetch(`${SOLARLENS_URL}/api/ingest/station`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${INGEST_TOKEN}` },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`ingest -> HTTP ${res.status} ${JSON.stringify(j)}`);
  if (j.skipped) { log(`skipped ${body.name || plantId}: ${j.skipped}`); return; }
  log(`pushed ${body.name || plantId}: ${j.acPowerW ?? '?'} W (${j.stored ? 'new sample' : 'already had this sample'})`);
}

// The portal's own responses are the source of truth: nothing here is guessed.
async function onResponse(res) {
  const url = res.url();
  if (!url.startsWith(PORTAL + '/api/')) return;
  try {
    if (url.endsWith('/api/station/list')) {
      const j = await res.json();
      for (const r of j?.data?.page?.records ?? []) {
        const unit = String(r.capacityStr ?? 'kWp').toLowerCase();
        const cap = Number(r.capacity);
        known.set(String(r.id), { name: r.stationName, capacityW: Number.isFinite(cap) ? cap * (unit.startsWith('k') ? 1000 : unit.startsWith('m') ? 1e6 : 1) : null });
      }
    }
  } catch { /* non-JSON or partial - ignore */ }
}

async function ensureLoggedIn() {
  await page.goto(`${PORTAL}/overview/plantStation`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(3000);
  if (!/login/i.test(page.url()) && !(await page.locator('input[type=password]').count())) return;
  if (HEADLESS) throw new Error('session expired - run headed once to log in again');
  log('Please log in to SolisCloud in the Chrome window. Waiting…');
  const until = Date.now() + 15 * 60_000;
  while (Date.now() < until) {
    await sleep(5000);
    if (!/login/i.test(page.url()) && !(await page.locator('input[type=password]').count())) { log('logged in - session saved'); return; }
  }
  throw new Error('gave up waiting for login');
}

async function snapshot(plantId) {
  // Navigating to the plant page makes the portal fetch detailMix with a
  // correctly signed request; we simply wait for that response.
  const wait = page.waitForResponse((r) => r.url().endsWith('/api/station/detailMix') && r.request().method() === 'POST', { timeout: 30_000 });
  await page.goto(`${PORTAL}/station/stationDetails/generalSituation/${plantId}`, { waitUntil: 'domcontentloaded' });
  const res = await wait;
  const j = await res.json();
  if (!j?.data) throw new Error(`detailMix for ${plantId}: ${j?.msg ?? 'no data'}`);
  return j.data;
}

/**
 * The Device tab lists the inverter and the datalogger stick. Both come from
 * ordinary portal calls, so opening the page is enough to collect them —
 * including per-string DC power (`pow1`…`pow32`) and the logger's RSSI, which
 * the official monitoring API does not expose at all.
 */
async function devices(plantId) {
  const grab = (suffix) =>
    page
      .waitForResponse((r) => r.url().endsWith(suffix) && r.request().method() === 'POST', { timeout: 30_000 })
      .then((r) => r.json())
      .then((j) => j?.data?.page?.records ?? [])
      .catch(() => []);

  // The page opens on the Inverter tab, so only inverter/listV2 fires; the
  // datalogger list is fetched lazily when its tab is selected - hence the click.
  const inverters = grab('/api/inverter/listV2');
  await page.goto(`${PORTAL}/overview/plantStation/details/device/${plantId}`, { waitUntil: 'domcontentloaded' });
  const inv = await inverters;

  let collectors = [];
  try {
    const wait = grab('/api/collector/listV2');
    await page.getByRole('tab', { name: /datalogger/i }).first().click({ timeout: 15_000 });
    collectors = await wait;
  } catch { /* tab missing or renamed - the inverter data still counts */ }
  return { inverters: inv, collectors };
}

async function pushDevices(plantId, { inverters, collectors }) {
  if (!inverters.length && !collectors.length) return;
  const res = await fetch(`${SOLARLENS_URL}/api/ingest/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${INGEST_TOKEN}` },
    body: JSON.stringify({ provider: 'soliscloud', plantId, inverters, collectors }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`devices -> HTTP ${res.status} ${JSON.stringify(j)}`);
  if (j.skipped) return;
  const rssi = collectors[0]?.rssi;
  const strings = (inverters[0] ? Object.keys(inverters[0]).filter((k) => /^pow\d+$/.test(k) && inverters[0][k] > 0).length : 0);
  log(`devices ${plantId}: ${j.stored} stored${rssi != null ? `, logger RSSI ${rssi} dBm` : ''}${strings ? `, ${strings} PV string(s) producing` : ''}`);
}

/** With no configured ids, make sure the portal's plant list has been seen at least once. */
async function discoverPlants() {
  if (PLANTS.length || known.size) return;
  const wait = page.waitForResponse((r) => r.url().endsWith('/api/station/list'), { timeout: 20_000 }).catch(() => null);
  await page.goto(`${PORTAL}/overview/plantStation`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await wait;
  await sleep(1000); // let the response listener finish parsing
}

async function cycle() {
  await ensureBrowser();
  await ensureLoggedIn();
  await discoverPlants();
  const ids = PLANTS.length ? PLANTS : [...known.keys()];
  if (!ids.length) { log('no plants discovered yet (set SOLIS_PLANT_IDS or wait for the plant list to load)'); return; }
  log(`plants: ${ids.map((id) => known.get(id)?.name ?? id).join(', ')}`);
  for (const id of ids) {
    try { await push(id, await snapshot(id)); }
    catch (e) { log(`plant ${id}: ${e.message}`); }
    await sleep(2500); // stay well under Solis's 3 calls / 5 s
    try { await pushDevices(id, await devices(id)); }
    catch (e) { log(`devices ${id}: ${e.message}`); }
    await sleep(2500);
  }
}

process.on('SIGINT', async () => { log('stopping'); if (ctx) await ctx.close().catch(() => {}); process.exit(0); });

log(`relay -> ${SOLARLENS_URL}  every ${INTERVAL_MS / 60000} min  plants=${PLANTS.length ? PLANTS.join(',') : 'auto'}  profile=${PROFILE}`);
for (;;) {
  try { await cycle(); } catch (e) { log(`cycle failed: ${e.message}`); }
  await sleep(INTERVAL_MS);
}
