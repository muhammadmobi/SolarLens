/**
 * "Also when this browser is closed", on the Alerts tab.
 *
 * A real push subscription needs a real push service, which a test run should
 * not touch; so the browser's push machinery is replaced before the page loads
 * with a stand-in that records what the page asks of it, and the server's push
 * routes are stubbed like every other route in this suite. What is asserted is
 * what a person sees and what the page sends: the key only when one was typed,
 * the endpoint and nothing else, and an honest state after every refusal.
 */
import { expect, test, type Page } from '@playwright/test';

const NOW = Math.floor(Date.UTC(2026, 8, 8, 9, 0, 0) / 1000);
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
// A valid uncompressed P-256 point's shape: 65 bytes, the first of them 4.
const PUBLIC_KEY = Buffer.from([4, ...Array(64).fill(7)]).toString('base64url');
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/e2e-device';

async function stubApi(page: Page) {
  await page.route('**/api/latest', (r) => r.fulfill(json({ now: NOW, inverters: [{
    id: 's1', name: 'On-grid Array', provider: 'soliscloud', serial: '••••1234', plant_name: 'On-grid Array',
    capacity_w: 12_000, ts: NOW - 60, ac_power_w: 8470, dc_power_w: 8900, today_kwh: 34.1, total_kwh: 48_000,
    battery_soc: null, battery_power_w: null, grid_power_w: -3200, load_power_w: 5270, temp_c: 41,
    status: 'normal', source: 'soliscloud-relay', metrics: null,
  }] })));
  for (const path of ['**/api/series**', '**/api/devices', '**/api/alarms**', '**/api/periods', '**/api/health', '**/api/history**']) {
    await page.route(path, (r) => r.fulfill(json({ now: NOW, points: [], devices: [], alarms: [], periods: [], polls: [], feeds: [], relays: [], rows: [] })));
  }
}

/**
 * The browser's push machinery, replaced. `mode` says what kind of browser to
 * pretend to be; `window.__push` records what the page did with it.
 */
async function fakePush(page: Page, mode: 'supported' | 'subscribed' | 'unsupported', permission: 'granted' | 'denied' = 'granted') {
  await page.addInitScript(({ mode, endpoint, permission }) => {
    const w = window as unknown as Record<string, unknown>;
    const state = { subscribed: null as null | { endpoint: string; unsubscribe: () => Promise<boolean> }, unsubscribed: 0, keyLength: 0 };
    w.__push = state;
    if (permission === 'denied') {
      Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'default' });
      Notification.requestPermission = async () => 'denied';
    }
    if (mode === 'unsupported') { delete w.PushManager; return; }
    if (!('PushManager' in window)) w.PushManager = function PushManager() {};
    const sub = () => ({ endpoint, unsubscribe: async () => { state.subscribed = null; state.unsubscribed++; return true; } });
    if (mode === 'subscribed') state.subscribed = sub();
    const reg = {
      pushManager: {
        getSubscription: async () => state.subscribed,
        subscribe: async (opts: { applicationServerKey: Uint8Array }) => {
          state.keyLength = opts.applicationServerKey.length;
          state.subscribed = sub();
          return state.subscribed;
        },
      },
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: async () => reg, register: async () => reg, ready: Promise.resolve(reg) },
    });
  }, { mode, endpoint: ENDPOINT, permission });
}

/** The server's push routes, recording each request's body and authorization. */
async function stubPushRoutes(page: Page, opts: { key?: boolean; subscribe?: (auth: string | null) => { status: number; body: unknown } } = {}) {
  const calls: Array<{ path: string; body: unknown; auth: string | null }> = [];
  await page.route('**/api/push/key', (r) => r.fulfill(opts.key === false
    ? json({ error: 'not set up' }, 404)
    : json({ publicKey: PUBLIC_KEY })));
  for (const path of ['subscribe', 'unsubscribe', 'test']) {
    await page.route(`**/api/push/${path}`, (r) => {
      const auth = r.request().headers().authorization ?? null;
      calls.push({ path, body: r.request().postDataJSON(), auth });
      if (path === 'subscribe' && opts.subscribe) {
        const out = opts.subscribe(auth);
        return r.fulfill(json(out.body, out.status));
      }
      return r.fulfill(json({ ok: true }));
    });
  }
  return calls;
}

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['notifications']);
});

test('offers to turn it on, and turns it on for a signed-in device without asking for the key', async ({ page }) => {
  await fakePush(page, 'supported');
  await stubApi(page);
  const calls = await stubPushRoutes(page);
  await page.goto('/#/alerts');

  const row = page.locator('#pushrow');
  await expect(row).toContainText('Also when this browser is closed');
  await page.locator('#pushon').click();

  await expect(row).toContainText('On for this device');
  await expect(row).toContainText('A test notification is on its way');
  expect(calls).toEqual([{ path: 'subscribe', body: { endpoint: ENDPOINT }, auth: null }]);
  // The server's public key reached the browser as the 65 bytes it expects.
  expect(await page.evaluate(() => (window as unknown as { __push: { keyLength: number } }).__push.keyLength)).toBe(65);
});

test('asks for the key on a device that is not signed in, and sends it only with that request', async ({ page }) => {
  await fakePush(page, 'supported');
  await stubApi(page);
  const calls = await stubPushRoutes(page, {
    subscribe: (auth) => (auth === 'Bearer owner-key' ? { status: 200, body: { ok: true } } : { status: 401, body: { error: 'unauthorized' } }),
  });
  await page.goto('/#/alerts');

  await page.locator('#pushon').click();
  const field = page.locator('#pushkey');
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute('type', 'password');
  // Refused by the server, so not left subscribed in the browser either.
  expect(await page.evaluate(() => (window as unknown as { __push: { unsubscribed: number } }).__push.unsubscribed)).toBe(1);

  await field.fill('wrong-key');
  await page.locator('#pushon').click();
  await expect(page.locator('#pushrow')).toContainText('That key was not accepted');

  await page.locator('#pushkey').fill('owner-key');
  await page.locator('#pushon').click();
  await expect(page.locator('#pushrow')).toContainText('On for this device');
  expect(calls.map((c) => c.auth)).toEqual([null, 'Bearer wrong-key', 'Bearer owner-key']);

  // Kept in memory for the test button, never in storage.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain('owner-key');
});

test('sends a test, and turns itself off without the key', async ({ page }) => {
  await fakePush(page, 'subscribed');
  await stubApi(page);
  const calls = await stubPushRoutes(page);
  await page.goto('/#/alerts');

  const row = page.locator('#pushrow');
  await expect(row).toContainText('On for this device');
  await page.locator('#pushtest').click();
  await expect(row).toContainText('Sent. It should arrive within a few seconds.');

  await page.locator('#pushoff').click();
  await expect(row).toContainText('Off. This device will not be told anything');
  await expect(page.locator('#pushon')).toBeVisible();
  expect(calls.map((c) => [c.path, c.body, c.auth])).toEqual([
    ['test', { endpoint: ENDPOINT }, null],
    ['unsubscribe', { endpoint: ENDPOINT }, null],
  ]);
});

test('says why when the server refuses the device', async ({ page }) => {
  await fakePush(page, 'supported');
  await stubApi(page);
  await stubPushRoutes(page, { subscribe: () => ({ status: 409, body: { error: 'the most devices this server will notify are already signed up' } }) });
  await page.goto('/#/alerts');
  await page.locator('#pushon').click();
  await expect(page.locator('#pushrow')).toContainText('The server refused: the most devices this server will notify are already signed up.');
  await expect(page.locator('#pushon')).toBeVisible();
});

test('says so when the browser refuses permission', async ({ page }) => {
  await fakePush(page, 'supported', 'denied');
  await stubApi(page);
  const calls = await stubPushRoutes(page);
  await page.goto('/#/alerts');
  await page.locator('#pushon').click();
  await expect(page.locator('#pushrow')).toContainText('This browser refused permission to notify');
  expect(calls).toEqual([]);
});

test('says plainly when the server has no key', async ({ page }) => {
  await fakePush(page, 'supported');
  await stubApi(page);
  await stubPushRoutes(page, { key: false });
  await page.goto('/#/alerts');
  await expect(page.locator('#pushrow')).toContainText('Not set up on this server yet');
  await expect(page.locator('#pushon')).toHaveCount(0);
});

test('points an iPhone at the home screen, where Safari allows this', async ({ page }) => {
  await fakePush(page, 'unsupported');
  await stubApi(page);
  await stubPushRoutes(page);
  await page.goto('/#/alerts');
  await expect(page.locator('#pushrow')).toContainText('add the dashboard to the home screen first');
});
