/**
 * What each view looks like, compared with the last picture of it.
 *
 * Taken of the demo, whose data is made up in the browser from the time: the
 * clock is fixed, so the same moment - and so the same curves, figures and
 * history - is drawn every run. See playwright.visual.config.ts for where the
 * pictures live and why they are recorded on Linux.
 */
import { expect, test, type Page } from '@playwright/test';

// A fixed afternoon. The demo places its plants where it is early afternoon,
// so any fixed instant draws a full day's curve.
const MOMENT = new Date('2026-06-15T09:00:00Z');

async function open(page: Page, hash: string, ready: string, opts: { dark?: boolean; width?: number; height?: number } = {}) {
  await page.clock.install({ time: MOMENT });
  await page.emulateMedia({ colorScheme: opts.dark ? 'dark' : 'light', reducedMotion: 'reduce' });
  if (opts.width) await page.setViewportSize({ width: opts.width, height: opts.height ?? 900 });
  await page.goto(`/demo/${hash}`);
  await expect(page.locator(ready).first()).toBeVisible();
  // Webfonts decide line breaks; compare only once they are in.
  await page.evaluate(() => document.fonts.ready);
  // "3 min ago" and the clock change with every run, and are not what this compares.
  await page.addStyleTag({ content: '#updated, .ovwhen span:last-child, #tvclock, #tvago { visibility: hidden !important; }' });
}

const VIEWS: [string, string, string, { dark?: boolean; width?: number; height?: number }?][] = [
  ['overview', '#/', '.ovsys'],
  ['overview-dark', '#/', '.ovsys', { dark: true }],
  ['power', '#/power', '#legend .legitem'],
  ['analysis', '#/analysis', '#anchart'],
  ['compare', '#/compare', 'table.cmp'],
  ['history', '#/history', '#view table'],
  ['alerts', '#/alerts', 'details.syssec'],
  ['devices', '#/devices', '.loggers section.logger'],
  ['settings', '#/settings', '.settings'],
  ['system', '#/system/s2', '.blocks'],
  ['phone', '#/', '.ovsys', { width: 390, height: 844 }],
];

for (const [name, hash, ready, opts] of VIEWS) {
  test(`${name} looks as it did`, async ({ page }) => {
    await open(page, hash, ready, opts);
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
  });
}
