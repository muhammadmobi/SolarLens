/**
 * The guide, behind the "?" at the top of every page.
 *
 * What is held here is what makes a guide worth having: it is one tap from
 * anywhere, it opens even when there is no data yet, it names the systems it is
 * describing, and every place it sends you to is a real page.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const NOW = Math.floor(Date.UTC(2026, 8, 8, 9, 0, 0) / 1000);
const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function stubApi(page: Page) {
  await page.route('**/api/latest', (r) => r.fulfill(json({ now: NOW, inverters: [
    { id: 's1', name: 'On-grid Array', provider: 'soliscloud', capacity_w: 12_000, ts: NOW - 60, ac_power_w: 8470,
      battery_soc: null, status: 'normal', source: 'soliscloud-relay', metrics: null },
    { id: 's2', name: 'Hybrid', provider: 'solarman', capacity_w: 3500, ts: NOW - 120, ac_power_w: 1200,
      battery_soc: 78, status: 'normal', source: 'solarman', metrics: null },
  ] })));
  for (const path of ['**/api/series**', '**/api/devices', '**/api/alarms**', '**/api/periods', '**/api/health', '**/api/history**']) {
    await page.route(path, (r) => r.fulfill(json({ now: NOW, points: [], devices: [], alarms: [], periods: [], polls: [], feeds: [], relays: [], rows: [] })));
  }
}

test('opens from the ? at the top of any page, and marks itself as the page you are on', async ({ page }) => {
  await stubApi(page);
  await page.goto('/#/power');
  await expect(page.locator('#view')).not.toBeEmpty();

  const button = page.locator('#guidebtn');
  await expect(button).toBeVisible();
  await expect(button).toHaveAccessibleName(/Guide/);
  await button.click();

  await expect(page).toHaveURL(/#\/guide$/);
  await expect(page.locator('.guide h2').first()).toContainText('Guide');
  await expect(button).toHaveClass(/\bon\b/);
  // It is not one of the everyday tabs, so none of them is marked.
  await expect(page.locator('nav#nav a.on')).toHaveCount(0);
});

test('says which release it describes, and names the systems it is describing', async ({ page }) => {
  await stubApi(page);
  await page.goto('/#/guide');
  await expect(page.locator('.guide .ver')).toHaveText(`SolarLens ${VERSION}`);
  await expect(page.locator('.guide')).toContainText(`What is new in ${VERSION}`);

  const systems = page.locator('.guide .systems span');
  await expect(systems).toHaveCount(2);
  await expect(systems.nth(0)).toHaveText('On-grid Array · SolisCloud · 12 kW');
  await expect(systems.nth(1)).toHaveText('Hybrid · SolarMan · 3.5 kW · with a battery');
});

test('opens even when the data has not arrived', async ({ page }) => {
  // Every read hangs: the rest of the dashboard waits, the guide does not.
  await page.route('**/api/**', () => new Promise(() => {}));
  await page.goto('/#/guide');
  await expect(page.locator('.guide')).toContainText('SolarLens puts your solar systems on one page');
  await expect(page.locator('.guide .systems')).toHaveCount(0);
});

test('sends you only to pages that exist', async ({ page }) => {
  await stubApi(page);
  await page.goto('/#/guide');
  const hrefs = await page.locator('.guide a[href^="#/"]').evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute('href')))]);
  expect(hrefs.sort()).toEqual(['#/', '#/alerts', '#/devices', '#/history', '#/power', '#/tv']);

  // Follow one from the table the way a person would.
  await page.locator('table.find a[href="#/history"]').first().click();
  await expect(page).toHaveURL(/#\/history$/);
  await expect(page.locator('#view h2').first()).toContainText('Historical Data');
});
