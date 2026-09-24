/**
 * How much of the dashboard's own script the end-to-end suite actually runs.
 *
 * `npm run test:unit:coverage` measures the Worker. Nothing measured the other
 * half of the project: `public/index.html` carries the whole dashboard -
 * routing, five views, the charts, the alert rules - in one inline script, and
 * "266 end-to-end tests pass" said nothing about how much of it they touch.
 *
 * This drives the dashboard the way a person does, with V8's coverage recorder
 * running, and reports the share of that script which executed. The figure is
 * written to coverage/page-coverage.json for the run's artifact, and the test
 * fails if it falls below the floor - the same rule the Worker's thresholds
 * follow: raise it when you add tests, never lower it to go green.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * Set below what the walk-through achieves, with room for the code to grow.
 *
 * Measured at 67.3% when this was written, of 120 kB of script. It had been
 * 69.6% an hour earlier, and the difference was not the machine: this change
 * added the CSV writer and the notification switch, whose branches the
 * walk-through only partly reaches, so the same suite covers a larger page.
 * That is the ordinary way this figure moves, and a floor set flush against
 * the best reading fails the next honest change - which is the one thing a
 * coverage floor must not do.
 *
 * Raise it when the suite covers more; never lower it to make a red run green.
 * What is not covered is the dashboard answering situations this fixture does
 * not create: a vendor error, TV mode's rotation, and the branches behind
 * figures neither system reports.
 */
const FLOOR_PCT = 65;

test.describe.configure({ mode: 'serial' });

test('the end-to-end suite runs most of the dashboard script', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'V8 coverage is a Chromium facility');
  // Both projects are Chromium, and both would write the same file: the number
  // kept would be whichever finished last. The desktop walk is the one the
  // README quotes, so it is the one that measures.
  test.skip(testInfo.project.name !== 'chrome', 'measured once, on the desktop walk-through');

  const NOW = Math.floor(Date.UTC(2026, 8, 8, 9, 0, 0) / 1000);
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  const inverters = [
    {
      id: 's1', name: 'On-grid Array', provider: 'soliscloud', serial: '••••1234', plant_name: 'On-grid Array',
      capacity_w: 12_000, ts: NOW - 60, ac_power_w: 8470, dc_power_w: 8900, today_kwh: 34.1, total_kwh: 48_000,
      battery_soc: null, battery_power_w: null, grid_power_w: -3200, load_power_w: 5270, temp_c: 41,
      status: 'normal', source: 'soliscloud-relay',
      metrics: { genMonthKwh: 800, genYearKwh: 9000, genTotalKwh: 48_000, loadTodayKwh: null, gridImportTodayKwh: null },
    },
    {
      id: 's2', name: 'Hybrid', provider: 'solarman', serial: '••••9876', plant_name: 'Hybrid',
      capacity_w: 3500, ts: NOW - 120, ac_power_w: 1200, dc_power_w: 1300, today_kwh: 6.2, total_kwh: 9000,
      battery_soc: 78, battery_power_w: -220, grid_power_w: 140, load_power_w: 900, temp_c: 33,
      status: 'normal', source: 'solarman',
      metrics: { battChargeTodayKwh: 4.1, battDischargeTodayKwh: 3.2, gridImportTodayKwh: 2.2, gridExportTodayKwh: 5.5, loadTodayKwh: 9.1 },
    },
  ];
  const points = Array.from({ length: 40 }, (_, i) => [
    { inverter_id: 's1', ts: NOW - i * 300, ac_power_w: 8000 - i * 50 },
    { inverter_id: 's2', ts: NOW - i * 300, ac_power_w: 1200 - i * 10 },
  ]).flat();

  await page.route('**/api/latest', (r) => r.fulfill(json({ now: NOW, inverters })));
  await page.route('**/api/series**', (r) => r.fulfill(json({ from: NOW - 12_000, to: NOW, points })));
  await page.route('**/api/devices', (r) => r.fulfill(json({
    now: NOW,
    devices: [
      {
        id: 'd1', provider: 'soliscloud', plant_id: 's1', kind: 'inverter', sn: '••••1234', name: 'Inverter',
        model: 'S5-GR3P10K', firmware: '1.0.78', status: 'online', signal_dbm: null, temp_c: 41,
        strings: [{ index: 1, powerW: 4200, voltageV: 380, currentA: 11 }], ac_phases: [{ index: 1, voltageV: 232, currentA: 12 }],
        frequency_hz: 50, power_factor: 1, last_seen: NOW - 60,
      },
      {
        id: 'd2', provider: 'soliscloud', plant_id: 's1', kind: 'datalogger', sn: '••••7777', name: 'Datalogger',
        model: 'LSW3', firmware: '1.0.2', status: 'online', signal_dbm: -63, last_seen: NOW - 60,
        strings: null, ac_phases: null,
      },
    ],
  })));
  await page.route('**/api/history**', (r) => r.fulfill(json({
    now: NOW, days: 30,
    rows: Array.from({ length: 14 }, (_, i) => ({
      inverter_id: i % 2 ? 's2' : 's1', day: `2026-09-${String(8 - Math.floor(i / 2)).padStart(2, '0')}`,
      yield_kwh: 40 - i, peak_w: 9000, load_kwh: 12, import_kwh: 3, export_kwh: 7,
      batt_charge_kwh: 2, batt_discharge_kwh: 1, samples: 200, first_ts: NOW - 86_400, last_ts: NOW,
    })),
  })));
  await page.route('**/api/alarms**', (r) => r.fulfill(json({
    now: NOW, days: 730,
    alarms: [
      { inverter_id: 's1', provider: 'soliscloud', code: '1015', message: 'NO-Grid', severity: 'warning', advice: 'No Action Required', begin_ts: NOW - 7200, end_ts: NOW - 3600, state: 'recovered' },
      { inverter_id: 's2', provider: 'solarman', code: '7', message: 'DC volt low fault', severity: 'fault', advice: null, begin_ts: NOW - 172_800, end_ts: null, state: 'active' },
    ],
  })));
  await page.route('**/api/periods', (r) => r.fulfill(json({
    now: NOW,
    periods: [
      { inverter_id: 's1', period: 'month', key: '2026-09', yield_kwh: 800, load_kwh: null, import_kwh: null, export_kwh: null, charge_kwh: null, discharge_kwh: null, full_hours: 66, source: 'soliscloud' },
      { inverter_id: 's1', period: 'year', key: '2026', yield_kwh: 9000, load_kwh: null, import_kwh: null, export_kwh: null, charge_kwh: null, discharge_kwh: null, full_hours: 750, source: 'soliscloud' },
    ],
  })));
  await page.route('**/api/health', (r) => r.fulfill(json({
    now: NOW,
    polls: [{ ts: NOW - 30, provider: 'soliscloud', ok: 1, detail: 'plants=1 inverters=1 new=1' }],
    feeds: [
      { ts: NOW - 30, provider: 'soliscloud', ok: 1, detail: 'plants=1 inverters=1 new=1' },
      { ts: NOW - 90, provider: 'solarman', ok: 1, detail: 'plants=1 inverters=1 new=1' },
    ],
    relays: [{ name: 'Relay 1', state: 'ok', login_expires_at: NOW + 5 * 86_400, last_seen: NOW - 60, first_seen: NOW - 86_400, last_ok_at: NOW - 60 }],
  })));

  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.goto('/');
  await expect(page.locator('#view')).not.toBeEmpty();

  // Walk the dashboard the way a person would: every view, both systems, the
  // ranges, a system's own page, its raw telemetry, and the theme switch.
  for (const hash of ['#/power', '#/history', '#/alerts', '#/devices', '#/system/s1', '#/system/s2', '#/tv', '#/']) {
    await page.goto(`/${hash}`);
    await expect(page.locator('#view')).not.toBeEmpty();
    await page.waitForTimeout(120);
  }

  for (const range of ['24h', '7d', '30d']) {
    const button = page.locator(`button.rangebtn:has-text("${range}")`).first();
    if (await button.count()) { await button.click(); await page.waitForTimeout(120); }
  }
  const theme = page.locator('#theme');
  if (await theme.count()) { await theme.click(); await page.waitForTimeout(80); await theme.click(); }

  // The things a person does once they are on a page: turn a system off in the
  // legend, open the panels, search the raw telemetry, switch what the history
  // chart is grouped by.
  await page.goto('/#/power');
  await expect(page.locator('#view')).not.toBeEmpty();
  for (const sel of ['button[data-series]', 'button.groupbtn', 'button.tvbtn']) {
    const all = page.locator(sel);
    for (let i = 0; i < Math.min(await all.count(), 3); i++) {
      await all.nth(i).click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(60);
    }
  }

  await page.goto('/#/system/s2');
  await expect(page.locator('#view')).not.toBeEmpty();
  const panels = page.locator('#view details');
  for (let i = 0; i < Math.min(await panels.count(), 6); i++) {
    await panels.nth(i).locator('summary').click({ timeout: 2000 }).catch(() => {});
  }
  const filter = page.locator('input.rawfilter').first();
  if (await filter.count()) { await filter.fill('power'); await page.waitForTimeout(150); await filter.fill(''); }

  await page.goto('/#/history');
  await expect(page.locator('#view')).not.toBeEmpty();
  const rows = page.locator('#view table tbody tr');
  if (await rows.count()) await rows.first().click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(150);

  const entries = await page.coverage.stopJSCoverage();

  // The dashboard is one inline script inside the document, so its coverage
  // arrives under the page's own URL rather than a .js file.
  const pageEntries = entries.filter((e) => e.url.includes('127.0.0.1') || e.url.endsWith('/') || e.url.endsWith('index.html'));
  let total = 0;
  let covered = 0;
  for (const entry of pageEntries) {
    const source = entry.source ?? '';
    if (source.length < 5000) continue;   // a stub or an empty document, not the dashboard
    // V8 reports nested ranges: a function's whole extent carries its count,
    // and the parts that did not run come back inside it with a count of zero.
    // Applying them in the order given lets the inner ones override the outer,
    // which is the difference between a real figure and a flat 100%.
    const counts = new Int32Array(source.length).fill(-1);   // -1: outside any script
    for (const fn of entry.functions) {
      for (const r of fn.ranges) {
        const end = Math.min(r.endOffset, source.length);
        for (let i = r.startOffset; i < end; i++) counts[i] = r.count;
      }
    }
    for (const c of counts) {
      if (c === -1) continue;   // markup, not script
      total++;
      if (c > 0) covered++;
    }
  }

  expect(total, 'no page script was measured - has the dashboard moved out of index.html?').toBeGreaterThan(5000);
  const pct = (100 * covered) / total;
  const report = {
    measured: 'public/index.html inline script',
    bytes: total,
    coveredBytes: covered,
    percent: Number(pct.toFixed(2)),
    floorPercent: FLOOR_PCT,
    at: new Date().toISOString(),
  };
  mkdirSync('coverage', { recursive: true });
  writeFileSync('coverage/page-coverage.json', JSON.stringify(report, null, 2));
  await testInfo.attach('page-coverage.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  console.log(`dashboard script coverage: ${report.percent}% of ${total} bytes (floor ${FLOOR_PCT}%)`);

  expect(pct, `dashboard script coverage ${pct.toFixed(2)}% is below the ${FLOOR_PCT}% floor`).toBeGreaterThanOrEqual(FLOOR_PCT);
});
