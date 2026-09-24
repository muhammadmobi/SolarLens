/**
 * Historical Data, every system or one on its own.
 *
 * The tab shows each system one after the other, which is right for comparing
 * them and wrong for looking after one of them. The switch at the top narrows it
 * to one system - its chart, its table, the row count and the CSV all follow -
 * and remembers the choice in this browser.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const NOW = Math.floor(Date.UTC(2026, 8, 8, 9, 0, 0) / 1000);
// One API answer: a 200 with a JSON body, for page.route to fulfil.
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

// One day's row as /api/history returns it.
const day = (inverter_id: string, d: string, yield_kwh: number) => ({
  inverter_id, day: d, yield_kwh, peak_w: 5000, load_kwh: null, import_kwh: null, export_kwh: null,
  batt_charge_kwh: null, batt_discharge_kwh: null, samples: 200, first_ts: NOW - 86_400, last_ts: NOW,
});

/** Two systems and five days of history between them; every other route answers empty. */
async function stubApi(page: Page) {
  await page.route('**/api/latest', (r) => r.fulfill(json({ now: NOW, inverters: [
    { id: 's1', name: 'Solis Ongrid', provider: 'soliscloud', capacity_w: 12_000, ts: NOW - 60, ac_power_w: 8000, status: 'normal', source: 'soliscloud-relay', metrics: null },
    { id: 's2', name: 'Nitrox Hybrid', provider: 'solarman', capacity_w: 3500, ts: NOW - 60, ac_power_w: 1200, battery_soc: 70, status: 'normal', source: 'solarman', metrics: null },
  ] })));
  await page.route('**/api/history**', (r) => r.fulfill(json({ now: NOW, days: 30, rows: [
    day('s1', '2026-09-08', 55.1), day('s1', '2026-09-07', 60.2), day('s1', '2026-09-06', 58.9),
    day('s2', '2026-09-08', 17.4), day('s2', '2026-09-07', 16.8),
  ] })));
  for (const path of ['**/api/series**', '**/api/devices', '**/api/alarms**', '**/api/periods', '**/api/health']) {
    await page.route(path, (r) => r.fulfill(json({ now: NOW, points: [], devices: [], alarms: [], periods: [], polls: [], feeds: [], relays: [] })));
  }
}

// The names of the system sections the tab is showing, in order.
const sections = (page: Page) => page.locator('#view details.syssec .sname');

test('shows every system by default, with a switch to see one on its own', async ({ page }) => {
  await stubApi(page);
  await page.goto('/#/history');

  const pick = page.getByRole('group', { name: 'Which system' });
  await expect(pick.getByRole('button')).toHaveText(['All systems', 'Solis Ongrid', 'Nitrox Hybrid']);
  await expect(pick.getByRole('button', { name: 'All systems' })).toHaveAttribute('aria-pressed', 'true');
  await expect(sections(page)).toHaveText(['Solis Ongrid', 'Nitrox Hybrid']);
  await expect(page.locator('.exportrow small')).toHaveText('5 rows, as shown');
});

test('narrows the charts, the tables and the row count to the system chosen', async ({ page }) => {
  await stubApi(page);
  await page.goto('/#/history');
  await page.getByRole('button', { name: 'Nitrox Hybrid' }).click();

  await expect(sections(page)).toHaveText(['Nitrox Hybrid']);
  await expect(page.getByRole('button', { name: 'Nitrox Hybrid' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.exportrow small')).toHaveText('2 rows, as shown');
  await expect(page.locator('#view table.devices tbody tr')).toHaveCount(2);

  // It carries on through the grouping switch.
  await page.getByRole('button', { name: 'By month' }).click();
  await expect(sections(page)).toHaveText(['Nitrox Hybrid']);

  await page.getByRole('button', { name: 'All systems' }).click();
  await expect(sections(page)).toHaveText(['Solis Ongrid', 'Nitrox Hybrid']);
});

test('downloads only that system, in a file named for it', async ({ page }) => {
  await stubApi(page);
  await page.goto('/#/history');
  await page.getByRole('button', { name: 'Solis Ongrid' }).click();

  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#csv').click()]);
  expect(download.suggestedFilename()).toMatch(/^solarlens-history-solis-ongrid-day-\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = readFileSync(await download.path(), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/);
  expect(lines).toHaveLength(4);                     // the header and three days
  expect(lines.slice(1).every((l) => l.includes('Solis Ongrid'))).toBe(true);
});

test('remembers the choice in this browser, and falls back to every system when it is gone', async ({ page }) => {
  await stubApi(page);
  await page.goto('/#/history');
  await page.getByRole('button', { name: 'Solis Ongrid' }).click();
  await page.reload();
  await page.goto('/#/history');
  await expect(sections(page)).toHaveText(['Solis Ongrid']);

  // A remembered system that no longer exists is not a blank page.
  await page.evaluate(() => localStorage.setItem('solarlens-history-system', 'gone'));
  await page.reload();
  await page.goto('/#/history');
  await expect(sections(page)).toHaveText(['Solis Ongrid', 'Nitrox Hybrid']);
});
