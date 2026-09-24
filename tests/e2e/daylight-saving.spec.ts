import { expect, test, type Page } from '@playwright/test';

/**
 * The morning the clocks went back.
 *
 * Where these panels stand, 25 October 2026 was twenty-five hours long: the
 * clocks went back at 02:00 and the day began an hour earlier, in UTC terms,
 * than the offset now in force would suggest. The dashboard used to cut "today"
 * with the plant's current offset, so on that one morning the first hour of the
 * day - already recorded, already generating once the sun was up - fell outside
 * the window and off the chart, and a time drawn beside a sample was an hour
 * out. Readings now carry the offset they were taken under, and the page reads
 * it.
 */

const NOON = Date.UTC(2026, 9, 25, 9, 0, 0);          // 09:00, clocks already back
const EARLY = Math.floor(Date.UTC(2026, 9, 24, 23, 30, 0) / 1000);  // 00:30 local, still on summer time
const LATER = Math.floor(Date.UTC(2026, 9, 25, 8, 30, 0) / 1000);   // 08:30 local, winter time
const NOW = Math.floor(NOON / 1000);

/** One plant, placed where the clocks change, with two samples either side of the switch. */
async function stubApi(page: Page) {
  const json = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  await page.route('**/api/latest', (r) => r.fulfill(json({
    now: NOW,
    inverters: [{
      id: 's1', name: 'On-grid Array', provider: 'soliscloud', serial: '••••1234', plant_name: 'On-grid Array',
      capacity_w: 12_000, ts: LATER, ac_power_w: 2000, dc_power_w: 2100, today_kwh: 9.4, total_kwh: 48_000,
      battery_soc: null, battery_power_w: null, grid_power_w: -2000, load_power_w: null, temp_c: 14,
      status: 'online', source: 'soliscloud-relay', metrics: null,
      // The offset in force now, which is not the one the first sample was read under.
      tz_offset_sec: 0,
    }],
  })));
  await page.route('**/api/series**', (r) => r.fulfill(json({
    from: EARLY - 3600, to: NOW,
    points: [
      { inverter_id: 's1', ts: EARLY, ac_power_w: 5000, today_kwh: 1, battery_soc: null, grid_power_w: null, tz_offset_sec: 3600 },
      { inverter_id: 's1', ts: LATER, ac_power_w: 2000, today_kwh: 9.4, battery_soc: null, grid_power_w: null, tz_offset_sec: 0 },
    ],
  })));
  for (const [path, b] of [
    ['**/api/devices', { now: NOW, devices: [] }],
    ['**/api/history**', { now: NOW, days: 30, rows: [] }],
    ['**/api/alarms**', { now: NOW, days: 730, alarms: [] }],
    ['**/api/periods', { now: NOW, periods: [] }],
    ['**/api/health', { now: NOW, polls: [], feeds: [], relays: [] }],
  ] as const) await page.route(path, (r) => r.fulfill(json(b)));
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOON));
  await stubApi(page);
});

test('a sample read before the clocks went back is still part of that day', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#view')).not.toBeEmpty();

  // 00:30 is the day's peak, and it only counts as today's peak if the hour
  // before the switch is inside the day. Cut with the current offset instead,
  // that sample belongs to yesterday and the peak reads 08:30.
  await expect(page.getByText(/peak .* at 00:30/)).toBeVisible();
});

test('the chart opens at the day it actually had, not at a fixed 24 hours', async ({ page }) => {
  await page.goto('/#/power');
  await expect(page.locator('#view')).not.toBeEmpty();

  // Both samples are drawn, the earlier one at the left-hand edge: a 25-hour
  // day scaled as 24 would push it off the axis entirely.
  const marks = page.locator('svg.combined circle');
  await expect(marks.first()).toBeVisible();
  const xs = await marks.evaluateAll((els) => els.map((e) => Number(e.getAttribute('cx'))));
  expect(Math.min(...xs)).toBeGreaterThanOrEqual(62);   // the axis starts at 62
  expect(Math.min(...xs)).toBeLessThan(120);            // and the sample sits on it
});
