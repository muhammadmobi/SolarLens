/**
 * The README's screenshots, taken of the demo.
 *
 * Skipped in an ordinary test run: `npm run screenshots` sets SCREENSHOTS=1 and
 * writes docs/screenshots/*.png. Taken of the demo rather than drawn by hand,
 * so they show the dashboard as it is, on data that is made up - no real
 * plant, name or figure can end up in a picture in the repository.
 */
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

test.skip(!process.env.SCREENSHOTS, 'run with npm run screenshots');
test.beforeEach(({}, info) => test.skip(info.project.name !== 'chrome', 'one set, from desktop Chrome'));

const OUT = 'docs/screenshots';

/**
 * Open a view of the demo, wait for it to draw, hide the demo banner, and save it.
 * `act` does something on the page first - asks a question - and waits for its answer.
 */
async function shot(
  page: Page, name: string, hash: string, ready: string,
  opts: { width?: number; height?: number; dark?: boolean; full?: boolean; act?: (page: Page) => Promise<void> } = {},
) {
  await page.setViewportSize({ width: opts.width ?? 1440, height: opts.height ?? 900 });
  await page.emulateMedia({ colorScheme: opts.dark ? 'dark' : 'light' });
  await page.goto(`/demo/${hash}`);
  await expect(page.locator(ready).first()).toBeVisible();
  await page.addStyleTag({ content: '#demo-banner{display:none!important}' });
  if (opts.act) await opts.act(page);
  // Let the charts and fonts settle before the picture.
  await page.waitForTimeout(400);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: !!opts.full });
}

test('overview, light and dark', async ({ page }) => {
  await shot(page, 'overview', '#/', '.ovsys');
  await shot(page, 'overview-dark', '#/', '.ovsys', { dark: true });
});

test('the assistant, answering', async ({ page }) => {
  await shot(page, 'ask', '#/ask', '.healthrow', {
    height: 1000,
    act: async (p) => {
      await p.getByRole('button', { name: 'Analyse the last 30 days: what should I do?' }).click();
      // An answer with its evidence has a Download button; the placeholder while it works has none.
      await expect(p.locator('.chatlog .msg.bot button[data-download]')).toBeVisible();
      // The page brings the newest message into view; the picture wants the question and the answer's start.
      await p.evaluate(() => window.scrollTo(0, 0));
    },
  });
});

test('analysis, a day hour by hour', async ({ page }) => {
  await shot(page, 'analysis', '#/analysis', '#anchart rect.daybar');
});

test('compare', async ({ page }) => {
  await shot(page, 'compare', '#/compare', 'table.cmp');
});

test('a system in full', async ({ page }) => {
  await shot(page, 'system', '#/system/s2', '.blocks', { full: true, height: 1000 });
});

test('devices and the dataloggers', async ({ page }) => {
  await shot(page, 'devices', '#/devices', '.loggers section.logger');
});

test('history', async ({ page }) => {
  await shot(page, 'history', '#/history', '#view table');
});

test('on a phone', async ({ page }) => {
  await shot(page, 'phone', '#/', '.ovsys', { width: 390, height: 844 });
});

test('TV mode', async ({ page }) => {
  await shot(page, 'tv', '#/tv', '.tvsys', { width: 1600, height: 900, dark: true });
});
