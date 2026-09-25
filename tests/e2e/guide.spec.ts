/**
 * The guide, behind the Guide button - an open book - at the top of every page.
 *
 * What is held here is what makes a guide worth having: it is one tap from
 * anywhere, it opens even when there is no data yet, it names the systems it is
 * describing, and every place it sends you to is a real page.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const NOW = Math.floor(Date.UTC(2026, 8, 8, 9, 0, 0) / 1000);
const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
// One API answer: a 200 with a JSON body, for page.route to fulfil.
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/** Two systems, one with a battery, so the guide has something to name. */
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

test('opens from the Guide button at the top of any page, and marks itself as the page you are on', async ({ page }) => {
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

test('shows a book and the word Guide, and only the book on a phone', async ({ page }, testInfo) => {
  await stubApi(page);
  await page.goto('/');
  const button = page.locator('#guidebtn');
  await expect(button.locator('svg.guideicon')).toBeVisible();
  // The icon is decoration; the button's name is what a screen reader says.
  await expect(button.locator('svg.guideicon')).toHaveAttribute('aria-hidden', 'true');
  const label = button.locator('.guidelabel');
  if (testInfo.project.name === 'mobile') await expect(label).toBeHidden();
  else await expect(label).toHaveText('Guide');
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

test('still opens when the server refuses a request', async ({ page }) => {
  await page.route('**/api/**', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' }));
  await page.goto('/#/guide');
  await expect(page.locator('.guide')).toContainText('SolarLens puts your solar systems on one page');
  await expect(page.locator('#view')).not.toContainText('The server refused this request');
});

test('calls a system with a battery one, even while its charge figure is missing', async ({ page }) => {
  await page.route('**/api/latest', (r) => r.fulfill(json({ now: NOW, inverters: [
    { id: 's2', name: 'Hybrid', provider: 'solarman', capacity_w: 3500, ts: NOW - 120, ac_power_w: 1200,
      battery_soc: null, status: 'normal', source: 'solarman', metrics: JSON.stringify({ batteryStatus: 'STATIC', battChargeTotalKwh: 1100 }) },
  ] })));
  for (const path of ['**/api/series**', '**/api/devices', '**/api/alarms**', '**/api/periods', '**/api/health', '**/api/history**']) {
    await page.route(path, (r) => r.fulfill(json({ now: NOW, points: [], devices: [], alarms: [], periods: [], polls: [], feeds: [], relays: [], rows: [] })));
  }
  await page.goto('/#/guide');
  await expect(page.locator('.guide .systems span')).toHaveText('Hybrid · SolarMan · 3.5 kW · with a battery');
});

test('sends you only to pages that exist', async ({ page }) => {
  await stubApi(page);
  await page.goto('/#/guide');
  const hrefs = await page.locator('.guide a[href^="#/"]').evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute('href')))]);
  expect(hrefs.sort()).toEqual(['#/', '#/alerts', '#/devices', '#/history', '#/power', '#/settings', '#/tv']);

  // Follow one from the table the way a person would.
  await page.locator('table.find a[href="#/history"]').first().click();
  await expect(page).toHaveURL(/#\/history$/);
  await expect(page.locator('#view h2').first()).toContainText('Historical Data');
});
