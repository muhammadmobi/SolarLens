/**
 * Nothing is wider than a phone.
 *
 * A page wider than the screen does more than scroll sideways: the browser
 * zooms the whole layout out to fit it, so the tabs are cut off at the edge and
 * anything fixed to the bottom of the screen - the new-version notice - lands
 * below it. The tab bar did this on every page, and the overview's columns on
 * the first. This walks every view at the width of the device each project
 * emulates and holds the page to the width of the screen.
 */
import { expect, test } from '@playwright/test';

const NOW = Math.floor(Date.UTC(2026, 8, 8, 9, 0, 0) / 1000);
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

test('no view is wider than the screen', async ({ page }) => {
  await page.route('**/api/latest', (r) => r.fulfill(json({ now: NOW, inverters: [
    { id: 's1', name: 'Solis Ongrid', provider: 'soliscloud', capacity_w: 12_000, ts: NOW - 60, ac_power_w: 8000, today_kwh: 40, status: 'normal', source: 'soliscloud-relay', metrics: null },
    { id: 's2', name: 'Nitrox Hybrid', provider: 'solarman', capacity_w: 3500, ts: NOW - 60, ac_power_w: 1200, battery_soc: 70, battery_power_w: -200, grid_power_w: 100, load_power_w: 900, status: 'normal', source: 'solarman', metrics: null },
  ] })));
  for (const path of ['**/api/series**', '**/api/devices', '**/api/alarms**', '**/api/periods', '**/api/health', '**/api/history**']) {
    await page.route(path, (r) => r.fulfill(json({ now: NOW, points: [], devices: [], alarms: [], periods: [], polls: [], feeds: [], relays: [], rows: [] })));
  }

  const wide: string[] = [];
  for (const hash of ['#/', '#/power', '#/history', '#/alerts', '#/devices', '#/guide']) {
    await page.goto(`/${hash}`);
    await expect(page.locator('#view')).not.toBeEmpty();
    const { page: w, screen } = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      screen: document.documentElement.clientWidth,
    }));
    if (w > screen) wide.push(`${hash}: ${w}px on a ${screen}px screen`);
  }
  expect(wide).toEqual([]);
});

test('the tabs scroll within their own strip, and the last one can be reached', async ({ page }) => {
  await page.route('**/api/**', (r) => r.fulfill(json({ now: NOW, inverters: [], points: [], devices: [], alarms: [], periods: [], polls: [], feeds: [], relays: [], rows: [] })));
  await page.goto('/#/guide');
  const devices = page.locator('nav#nav a[href="#/devices"]');
  await devices.scrollIntoViewIfNeeded();
  await expect(devices).toBeInViewport();
  await devices.click();
  await expect(page).toHaveURL(/#\/devices$/);
});
