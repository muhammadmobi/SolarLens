/**
 * The demo on GitHub Pages: the real dashboard, on made-up data, with no server.
 *
 * Served here from site/ under /demo/, the way Pages serves it under
 * /<repository>/. What it must do is simple to state and easy to break: every
 * view draws from the sample data, no request leaves for an /api the demo does
 * not have, nothing reaches for a path at the root of someone else's site, and
 * the page says plainly that the data is made up.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Every request the page makes to its own server, by path, so a test can say
 * none went where it should not. The web font comes from Google, and is not
 * this site's to serve.
 */
function watch(page: Page) {
  const urls: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') urls.push(u.pathname);
  });
  return urls;
}

test('says it is a demo with made-up data, and links to the project', async ({ page }) => {
  await page.goto('/demo/');
  const banner = page.locator('#demo-banner');
  await expect(banner).toContainText('made-up data');
  await expect(banner.getByRole('link', { name: 'SolarLens on GitHub' })).toHaveAttribute('href', 'https://github.com/muhammadmobi/SolarLens');
});

test('draws every view from the sample data, and asks no server for any of it', async ({ page }) => {
  const urls = watch(page);
  await page.goto('/demo/');
  await expect(page.locator('.ovsys')).toHaveCount(3);
  await expect(page.locator('nav.ovstrip a')).toHaveCount(3);
  for (const [hash, ready] of [
    ['#/power', '#legend .legitem'], ['#/analysis', '#anchart rect.daybar'], ['#/compare', 'table.cmp tbody tr'], ['#/history', '#view table'],
    ['#/alerts', 'details.syssec'], ['#/devices', '.loggers section.logger'], ['#/settings', '.settings'],
    ['#/guide', '.guide'], ['#/system/s2', '.blocks'], ['#/ask', '.healthrow'],
  ] as const) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await expect(page.locator(ready).first(), hash).toBeVisible();
  }
  expect(urls.filter((u) => u.includes('/api/') || u.includes('/auth/'))).toEqual([]);
});

test('reaches for nothing at the root of the site it is served on', async ({ page }) => {
  const urls = watch(page);
  await page.goto('/demo/');
  await expect(page.locator('.ovsys').first()).toBeVisible();
  expect(urls.filter((u) => !u.startsWith('/demo'))).toEqual([]);
});

test('shows most of a sunny day, whatever time the visitor comes', async ({ page }) => {
  // Three in the morning where the visitor is: the plants are still mid-afternoon.
  const night = new Date();
  night.setHours(3, 0, 0, 0);
  await page.clock.install({ time: night });
  await page.goto('/demo/');
  const card = page.locator('.ovsys').first();
  await expect(card.locator('.ovchart-head')).toContainText(/peak [\d.,]+ ?k?W at 1[0-4]:\d\d/);
  await expect(card.locator('.ovchart svg path').first()).toBeVisible();
});

test('Settings works, and says nothing is saved', async ({ page }) => {
  await page.goto('/demo/#/settings');
  // The first refresh draws Settings again once the data lands; a tick before then would be drawn over.
  await expect(page.locator('#fleet-today')).not.toHaveText('—');
  await expect(page.locator('.settings')).toBeVisible();
  await expect(page.locator('#mcp-url')).toBeVisible();
  await page.locator('#req').check();
  await expect(page.locator('.authnote')).toBeVisible();
  await expect(page.locator('#demo-banner')).toContainText('Nothing you change here is saved');
});

test('has no serious or critical accessibility violations, banner included', async ({ page }) => {
  await page.goto('/demo/');
  await expect(page.locator('.ovsys').first()).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);
  expect(serious).toEqual([]);
});
