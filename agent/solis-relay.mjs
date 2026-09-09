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
 *   RELAY_CDP           attach to a Chrome you already have open instead of
 *                       launching one, e.g. http://127.0.0.1:9222 - see below
 *
 * Using your own Chrome instead of a second one
 * ---------------------------------------------
 * Chrome refuses to let two processes share one profile directory, so this
 * agent cannot simply open the profile your everyday browser is using: the
 * launch fails with "Opening in existing browser session". The way round it is
 * not to launch a browser at all, but to attach to the one already running.
 *
 * Start your Chrome with a debugging port once:
 *
 *   chrome.exe --remote-debugging-port=9222
 *
 * then run the agent with RELAY_CDP=http://127.0.0.1:9222. It will use that
 * browser, with your own logins, and open one tab of its own to work in.
 *
 * Two things to weigh before choosing this. A debugging port lets any program
 * on this machine drive your browser - every tab, every logged-in session - so
 * it is not something to leave on casually. And the agent's navigation happens
 * in your window: a tab appears and moves around every few minutes, and closing
 * Chrome stops the relay. The default separate profile has neither problem, and
 * RELAY_HEADLESS=1 hides its window entirely once you have logged in once.
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The Worker's own secrets already live in .dev.vars, and the agent needs two
 * of them. Reading that file means the documented `npm run relay:solis` works
 * on its own instead of failing on a missing variable; a real environment
 * variable still wins, so CI and one-off overrides behave as before.
 */
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
loadDevVars();

const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`missing env ${k} - set it, or add it to .dev.vars`);
    process.exit(2);
  }
  return v;
};
const SOLARLENS_URL = need('SOLARLENS_URL').replace(/\/+$/, '');
const INGEST_TOKEN = need('INGEST_TOKEN');
const PLANTS = (process.env.SOLIS_PLANT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const INTERVAL_MS = Math.max(1, Number(process.env.RELAY_INTERVAL_MIN ?? 5)) * 60_000;
const HEADLESS = process.env.RELAY_HEADLESS === '1';
const PROFILE = resolve(process.env.RELAY_PROFILE ?? '.relay-profile');
const CDP = process.env.RELAY_CDP ?? '';
let attached = null;
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
/**
 * Kill any Chrome still holding this agent's own profile directory.
 *
 * A crashed or force-quit run leaves a Chrome process attached to
 * .relay-profile, and the next launch fails with "Opening in existing browser
 * session" - which then repeats every cycle until somebody goes hunting in Task
 * Manager. The agent can do that hunting itself.
 *
 * Matched strictly on `--user-data-dir=<this profile>`, so it can only ever
 * touch a browser this agent started. Your ordinary Chrome windows use a
 * different profile and are never candidates.
 */
async function killStaleProfileHolders() {
  const { execFile } = await import('node:child_process');
  const run = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1 << 24 }, (err, out) => resolve(err ? '' : String(out)));
  });

  if (process.platform === 'win32') {
    // PowerShell reads the full command line; tasklist alone cannot.
    const script =
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*--user-data-dir=${PROFILE}*' } | ` +
      `ForEach-Object { $_.ProcessId }`;
    const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const pids = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l));
    for (const pid of pids) await run('taskkill', ['/PID', pid, '/F']);
    return pids.length;
  }

  const out = await run('pgrep', ['-f', `--user-data-dir=${PROFILE}`]);
  const pids = out.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const pid of pids) await run('kill', ['-9', pid]);
  return pids.length;
}

async function launchContext() {
  // Attach to a browser that is already running, rather than starting one.
  // Its profile - and so its logins - are whatever that browser already has.
  if (CDP) {
    const browser = await chromium.connectOverCDP(CDP);
    const existing = browser.contexts()[0];
    if (!existing) throw new Error(`${CDP}: connected, but that browser has no context to use`);
    attached = browser;
    return existing;
  }
  return chromium.launchPersistentContext(PROFILE, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 800 },
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
}

/**
 * Remove the single-instance markers Chrome leaves behind when it dies without
 * shutting down - which is what a machine restart does to a headless browser.
 *
 * Only ever called once nothing is holding the profile. A live Chrome owns
 * these files, and deleting them under it would be the bug this prevents.
 */
async function clearStaleSingletonFiles() {
  const { unlink } = await import('node:fs/promises');
  const { join } = await import('node:path');
  let cleared = 0;
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { await unlink(join(PROFILE, name)); cleared++; } catch { /* absent is the normal case */ }
  }
  return cleared;
}

async function ensureBrowser() {
  if (page && !page.isClosed()) return;
  if (ctx) { await ctx.close().catch(() => {}); log('browser was closed - relaunching'); }

  if (CDP) {
    try {
      ctx = await launchContext();
    } catch (e) {
      throw new Error(
        `${CDP}: could not attach - ${e.message}\n` +
        `Start Chrome with --remote-debugging-port=${new URL(CDP).port}, or unset RELAY_CDP ` +
        `to let the agent run its own browser.`,
      );
    }
  } else {
    // Retry on any launch failure, not on a recognised message.
    //
    // The first version matched /already in use/, on the assumption that a
    // profile still held by a previous run was the only thing that could go
    // wrong. The first real machine restart disproved it: Chrome launched,
    // exited 0 before Playwright could speak to it, and the error read "Target
    // page, context or browser has been closed" - no retry, and five minutes of
    // Solis data lost while the agent waited for its next cycle.
    //
    // A launch is cheap and this process has nothing else to do, so the useful
    // question is not "which failure is this" but "has it stopped failing".
    const delays = [2000, 8000];
    for (let attempt = 0; ; attempt++) {
      try {
        ctx = await launchContext();
        if (attempt) log(`browser started on attempt ${attempt + 1}`);
        break;
      } catch (e) {
        if (attempt >= delays.length) throw e;
        const killed = await killStaleProfileHolders();
        const files = killed ? 0 : await clearStaleSingletonFiles();
        log(
          `browser did not start (${e.message.split('\n')[0]}) - ` +
          (killed ? `killed ${killed} process holding the profile` :
           files ? `cleared ${files} stale lock file${files === 1 ? '' : 's'}` : 'nothing was holding the profile') +
          `, retrying in ${delays[attempt] / 1000}s`,
        );
        await sleep(delays[attempt]);
      }
    }
  }
  // When we launched the browser, its one blank tab is ours to use. When we
  // attached to somebody's browser, every open tab belongs to them - so take a
  // new one rather than navigating away from what they are reading.
  page = CDP ? await ctx.newPage() : (ctx.pages()[0] ?? (await ctx.newPage()));
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
  // The same page draws today's curve, so the chart call arrives alongside it.
  // Catching it costs nothing and fills in the hours this agent was not
  // running: the energy was generated either way, we simply were not watching.
  // Never fatal - a missing chart must not cost us the snapshot.
  const chart = page
    .waitForResponse((r) => r.url().includes('/api/chart/station/day'), { timeout: 25_000 })
    .then((r) => r.json())
    .catch(() => null);
  await page.goto(`${PORTAL}/station/stationDetails/generalSituation/${plantId}`, { waitUntil: 'domcontentloaded' });
  const res = await wait;
  const j = await res.json();
  if (!j?.data) throw new Error(`detailMix for ${plantId}: ${j?.msg ?? 'no data'}`);
  return { detail: j.data, chart };
}

/** Push today's curve, so the graph covers the whole day and not just uptime. */
async function pushHistory(plantId, chartJson) {
  if (!chartJson) return;
  const res = await fetch(`${SOLARLENS_URL}/api/ingest/history`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${INGEST_TOKEN}` },
    body: JSON.stringify({ provider: 'soliscloud', plantId, raw: chartJson }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { log(`history ${plantId}: HTTP ${res.status}${j.detail ? ` - ${j.detail}` : ""}`); return; }
  log(`history ${plantId}: ${j.stored ?? 0} new of ${j.points ?? 0} points`
    + (j.sawKeys ? ` (payload keys: ${j.sawKeys.join(', ')})` : ''));
}

/**
 * The Device tab lists the inverter and the datalogger stick. Both come from
 * ordinary portal calls, so opening the page is enough to collect them —
 * including per-string DC power (`pow1`…`pow32`) and the logger's RSSI, which
 * the official monitoring API does not expose at all.
 */
async function devices(plantId) {
  const grab2 = (suffix) =>
    page
      .waitForResponse((r) => r.url().endsWith(suffix) && r.request().method() === 'POST', { timeout: 30_000 })
      .then((r) => r.json())
      .then((j) => j?.data ?? null)
      .catch(() => null);

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

  // The inverter's own page is the only source of per-string voltage and
  // current, per-phase AC and heatsink temperature - none of which appear in
  // the plant snapshot or the documented monitoring API. One extra navigation
  // per inverter, paced like every other call.
  const details = [];
  for (const rec of inv) {
    if (!rec?.id || !rec?.sn) continue;
    try {
      const wait = grab2('/api/inverter/detail');
      await page.goto(`${PORTAL}/overview/device/details/inverter?id=${rec.id}&sn=${rec.sn}`, { waitUntil: 'domcontentloaded' });
      const data = await wait;
      if (data) details.push(data);
    } catch { /* detail is a bonus; the list already carries the essentials */ }
    await sleep(2500);
  }

  return { inverters: inv, collectors, details };
}

async function pushDevices(plantId, { inverters, collectors, details }) {
  if (!inverters.length && !collectors.length) return;
  const res = await fetch(`${SOLARLENS_URL}/api/ingest/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${INGEST_TOKEN}` },
    body: JSON.stringify({ provider: 'soliscloud', plantId, inverters, collectors, details }),
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
    try {
      const { detail, chart } = await snapshot(id);
      await push(id, detail);
      // Backfill after the snapshot, so a chart problem can never cost us the
      // live reading - which is the one thing this agent exists to deliver.
      try { await pushHistory(id, await chart); }
      catch (e) { log(`history ${id}: ${e.message}`); }
    }
    catch (e) { log(`plant ${id}: ${e.message}`); }
    await sleep(2500); // stay well under Solis's 3 calls / 5 s
    try { await pushDevices(id, await devices(id)); }
    catch (e) { log(`devices ${id}: ${e.message}`); }
    await sleep(2500);
  }
}

async function shutdown(code) {
  // A browser we attached to belongs to whoever opened it; close only our tab.
  if (attached) await page?.close().catch(() => {});
  else if (ctx) await ctx.close().catch(() => {});
  process.exit(code);
}

process.on('SIGINT', async () => { log('stopping'); await shutdown(0); });

/**
 * RELAY_ONCE runs a single cycle and exits, which is what the installer wants.
 *
 * Setup used to start the ordinary endless relay and tell the operator to press
 * Ctrl+C once it printed "pushed". That is a poor instruction - it asks someone
 * to interrupt a program that looks like it is working - and on Windows it is
 * worse than untidy: Ctrl+C inside a batch file raises "Terminate batch job
 * (Y/N)?", so the installer stopped half-finished with a console sitting open
 * waiting for an answer nobody expected to give.
 *
 * One cycle, an exit code that says whether it worked, and no keystroke.
 */
const ONCE = process.env.RELAY_ONCE === '1';

log(`relay -> ${SOLARLENS_URL}  ${ONCE ? 'one cycle' : `every ${INTERVAL_MS / 60000} min`}  plants=${PLANTS.length ? PLANTS.join(',') : 'auto'}  ${CDP ? `attached to ${CDP}` : `profile=${PROFILE}`}`);

if (ONCE) {
  try {
    await cycle();
    log('first reading pushed - setup can continue');
    await shutdown(0);
  } catch (e) {
    log(`cycle failed: ${e.message}`);
    await shutdown(1);
  }
}

for (;;) {
  try { await cycle(); } catch (e) { log(`cycle failed: ${e.message}`); }
  await sleep(INTERVAL_MS);
}
