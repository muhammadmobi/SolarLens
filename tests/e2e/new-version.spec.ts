/**
 * "A new version of SolarLens is available."
 *
 * A tab left open across a release keeps running the old page. The page asks
 * for its own address, headers only, and compares the ETag with the one it
 * loaded with. Here the server's answer to that HEAD request is what the test
 * controls; everything else is the real page.
 */
import { expect, test, type Page } from '@playwright/test';

const NOW = Math.floor(Date.UTC(2026, 8, 8, 9, 0, 0) / 1000);
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function stubApi(page: Page) {
  await page.route('**/api/latest', (r) => r.fulfill(json({ now: NOW, inverters: [
    { id: 's1', name: 'Solis Ongrid', provider: 'soliscloud', capacity_w: 12_000, ts: NOW - 60, ac_power_w: 8000, status: 'normal', source: 'soliscloud-relay', metrics: null },
  ] })));
  for (const path of ['**/api/series**', '**/api/devices', '**/api/alarms**', '**/api/periods', '**/api/health', '**/api/history**']) {
    await page.route(path, (r) => r.fulfill(json({ now: NOW, points: [], devices: [], alarms: [], periods: [], polls: [], feeds: [], relays: [], rows: [] })));
  }
}

/** The page's own address, answered with whatever ETag the test says the server has now. */
async function server(page: Page) {
  const state = { etag: '"release-a"', heads: 0 };
  await page.route((url) => url.pathname === '/', (route) => {
    if (route.request().method() !== 'HEAD') return route.continue();
    state.heads++;
    return route.fulfill({ status: 200, headers: { etag: state.etag }, body: '' });
  });
  return state;
}

/** Coming back to the tab, which is one of the moments the page checks. */
const comeBack = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

test('says nothing while the page on screen is the page on the server', async ({ page }) => {
  await stubApi(page);
  const srv = await server(page);
  await page.goto('/');
  await expect.poll(() => srv.heads).toBeGreaterThan(0);
  await comeBack(page);
  await expect.poll(() => srv.heads).toBeGreaterThan(1);
  await expect(page.locator('#newversion')).toHaveCount(0);
});

test('offers a reload once a new version is out, and reloads when asked', async ({ page }) => {
  await stubApi(page);
  const srv = await server(page);
  await page.goto('/#/power');
  await expect.poll(() => srv.heads).toBeGreaterThan(0);

  srv.etag = '"release-b"';
  await comeBack(page);
  const notice = page.getByRole('status').filter({ hasText: 'A new version of SolarLens is available.' });
  await expect(notice).toBeVisible();

  await page.evaluate(() => { (window as unknown as { beforeReload: boolean }).beforeReload = true; });
  await Promise.all([page.waitForEvent('load'), notice.getByRole('button', { name: 'Reload' }).click()]);
  expect(await page.evaluate(() => (window as unknown as { beforeReload?: boolean }).beforeReload)).toBeUndefined();
  await expect(page).toHaveURL(/#\/power$/);
});

test('takes "Later" at its word for the rest of the visit', async ({ page }) => {
  await stubApi(page);
  const srv = await server(page);
  await page.goto('/');
  await expect.poll(() => srv.heads).toBeGreaterThan(0);

  srv.etag = '"release-b"';
  await comeBack(page);
  await page.getByRole('button', { name: 'Later' }).click();
  await expect(page.locator('#newversion')).toHaveCount(0);

  srv.etag = '"release-c"';
  await comeBack(page);
  await page.waitForTimeout(300);
  await expect(page.locator('#newversion')).toHaveCount(0);
});

test('reloads a wall display by itself, since nobody is there to press anything', async ({ page }) => {
  await stubApi(page);
  const srv = await server(page);
  await page.goto('/#/tv');
  await expect.poll(() => srv.heads).toBeGreaterThan(0);
  await page.evaluate(() => { (window as unknown as { beforeReload: boolean }).beforeReload = true; });

  srv.etag = '"release-b"';
  await Promise.all([page.waitForEvent('load'), comeBack(page)]);
  expect(await page.evaluate(() => (window as unknown as { beforeReload?: boolean }).beforeReload)).toBeUndefined();
  await expect(page).toHaveURL(/#\/tv$/);
});
