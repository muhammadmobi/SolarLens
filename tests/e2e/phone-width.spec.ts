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
// One API answer: a 200 with a JSON body, for page.route to fulfil.
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

test('no view is wider than the screen', async ({ page }) => {
  await page.route('**/api/latest', (r) => r.fulfill(json({ now: NOW, inverters: [
    { id: 's1', name: 'Solis Ongrid', provider: 'soliscloud', capacity_w: 12_000, ts: NOW - 60, ac_power_w: 8000, today_kwh: 40, status: 'normal', source: 'soliscloud-relay', metrics: null },
    { id: 's2', name: 'Nitrox Hybrid', provider: 'solarman', capacity_w: 3500, ts: NOW - 60, ac_power_w: 1200, battery_soc: 70, battery_power_w: -200, grid_power_w: 100, load_power_w: 900, status: 'normal', source: 'solarman', metrics: null },
  ] })));
  await page.route('**/api/devices', (r) => r.fulfill(json({ now: NOW, devices: [
    { id: 'd1', provider: 'soliscloud', plant_id: 's1', kind: 'inverter', sn: '••••1234', name: 'Inverter', model: 'S5-GR3P10K',
      firmware: '1.0.78', status: 'online', signal_dbm: -63, strings: null, ac_phases: null, temp_c: 41, last_seen: NOW - 60 },
  ] })));
  await page.route('**/api/history**', (r) => r.fulfill(json({ now: NOW, days: 30, rows: [
    { inverter_id: 's1', day: '2026-09-08', yield_kwh: 55, peak_w: 9000, load_kwh: null, import_kwh: null, export_kwh: null,
      batt_charge_kwh: null, batt_discharge_kwh: null, samples: 200, first_ts: NOW - 86_400, last_ts: NOW },
  ] })));
  for (const path of ['**/api/series**', '**/api/alarms**', '**/api/periods', '**/api/health']) {
    await page.route(path, (r) => r.fulfill(json({ now: NOW, points: [], devices: [], alarms: [], periods: [], polls: [], feeds: [], relays: [], rows: [] })));
  }

  const wide: string[] = [];
  // What each view draws once it has its data. Waiting only for #view to be
  // non-empty would pass on the 'Loading…' placeholder, and measure a page the
  // overview's columns - the very thing this is here to catch - were not in yet.
  const drawn: Record<string, string> = {
    '#/': '.ovgrid .ovsys',
    '#/power': '#view details.syssec',
    '#/history': '#view details.syssec table',
    '#/alerts': '#view #notify',
    '#/devices': '#view table.devices',
    '#/guide': '#view .guide table.find',
  };
  for (const [hash, selector] of Object.entries(drawn)) {
    await page.goto(`/${hash}`);
    await expect(page.locator(selector).first()).toBeVisible();
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
