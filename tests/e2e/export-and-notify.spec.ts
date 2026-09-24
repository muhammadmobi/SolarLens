/**
 * The two things the dashboard learned to do for people rather than for itself:
 * hand the history over as a file, and say something out loud when a new alert
 * appears.
 *
 * Both live entirely in the page - no new route, no database read - so both are
 * tested the way a person meets them: click the button, take the file; turn the
 * switch on, change the data, wait to be told.
 */
import { expect, test, type Page } from '@playwright/test';

const NOW = Math.floor(Date.UTC(2026, 8, 8, 9, 0, 0) / 1000);
// One API answer: a 200 with a JSON body, for page.route to fulfil.
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

// One system as /api/latest returns it; a test overrides what it is about.
const inverter = (over: Record<string, unknown> = {}) => ({
  id: 's1', name: 'On-grid Array', provider: 'soliscloud', serial: '••••1234', plant_name: 'On-grid Array',
  capacity_w: 12_000, ts: NOW - 60, ac_power_w: 8470, dc_power_w: 8900, today_kwh: 34.1, total_kwh: 48_000,
  battery_soc: null, battery_power_w: null, grid_power_w: -3200, load_power_w: 5270, temp_c: 41,
  status: 'normal', source: 'soliscloud-relay', metrics: null,
  ...over,
});

/** The stub, with the parts a test wants to change handed in. */
async function stubApi(page: Page, opts: { inverters?: unknown[]; history?: unknown[] } = {}) {
  const invs = opts.inverters ?? [inverter()];
  await page.route('**/api/latest', (r) => r.fulfill(json({ now: NOW, inverters: invs })));
  await page.route('**/api/series**', (r) => r.fulfill(json({ from: NOW - 3600, to: NOW, points: [] })));
  await page.route('**/api/devices', (r) => r.fulfill(json({ now: NOW, devices: [] })));
  await page.route('**/api/alarms**', (r) => r.fulfill(json({ now: NOW, days: 730, alarms: [] })));
  await page.route('**/api/periods', (r) => r.fulfill(json({ now: NOW, periods: [] })));
  await page.route('**/api/health', (r) => r.fulfill(json({
    now: NOW,
    polls: [{ ts: NOW - 30, provider: 'soliscloud', ok: 1, detail: 'plants=1 inverters=1 new=1' }],
    feeds: [{ ts: NOW - 30, provider: 'soliscloud', ok: 1, detail: 'plants=1 inverters=1 new=1' }],
    relays: [],
  })));
  await page.route('**/api/history**', (r) => r.fulfill(json({
    now: NOW, days: 30,
    rows: opts.history ?? [
      {
        inverter_id: 's1', day: '2026-09-08', yield_kwh: 41.2, peak_w: 9100, load_kwh: null,
        import_kwh: null, export_kwh: null, batt_charge_kwh: null, batt_discharge_kwh: null,
        samples: 244, first_ts: NOW - 86_400, last_ts: NOW,
      },
      {
        inverter_id: 's1', day: '2026-09-07', yield_kwh: 38.9, peak_w: 8800, load_kwh: null,
        import_kwh: null, export_kwh: null, batt_charge_kwh: null, batt_discharge_kwh: null,
        samples: 240, first_ts: NOW - 172_800, last_ts: NOW - 86_400,
      },
    ],
  })));
}

test.describe('history as a file', () => {
  test('downloads the rows on screen, named for the day and the grouping', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/history');
    await expect(page.locator('#csv')).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#csv').click()]);
    expect(download.suggestedFilename()).toMatch(/^solarlens-history-day-\d{4}-\d{2}-\d{2}\.csv$/);

    const text = await (await import('node:fs/promises')).readFile(await download.path(), 'utf8');
    const lines = text.trim().split(/\r?\n/);
    expect(lines[0].replace(/^﻿/, '')).toBe(
      'day,system,generated_kwh,peak_w,consumed_kwh,imported_kwh,exported_kwh,battery_charged_kwh,battery_discharged_kwh,samples,first_reading_utc,last_reading_utc',
    );
    expect(lines).toHaveLength(3);                       // a header and the two days
    expect(lines[1]).toContain('2026-09-08,On-grid Array,41.2,9100');
    // A figure the vendor never reported is empty, not zero.
    expect(lines[1]).toContain(',,,,,');
  });

  test('says how many rows the file will hold', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/history');
    await expect(page.locator('.exportrow')).toContainText('2 rows, as shown');
  });

  test('quotes a system name containing a comma, so the columns survive it', async ({ page }) => {
    await stubApi(page, { inverters: [inverter({ name: 'Roof, west side' })] });
    await page.goto('/#/history');
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#csv').click()]);
    const text = await (await import('node:fs/promises')).readFile(await download.path(), 'utf8');
    expect(text).toContain('"Roof, west side"');
    // Parsed the way a spreadsheet would, the row still has one cell per
    // column - a naive split on commas is exactly what quoting protects against.
    const cells = (line: string) => line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.slice(0, -1).length ?? 0;
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
    expect(cells(lines[1])).toBe(cells(lines[0]));
  });
});

test.describe('being told when something changes', () => {
  test('offers the switch, and turns it on once permission is given', async ({ page, context }) => {
    await context.grantPermissions(['notifications']);
    await stubApi(page);
    await page.goto('/#/alerts');

    const box = page.locator('#notify');
    await expect(box).toBeVisible();
    await expect(box).not.toBeChecked();
    await box.check();
    await expect(box).toBeChecked();
    await expect(page.locator('#notifynote')).toContainText('will raise a notification');

    // The choice is this browser's, and it survives a reload.
    await page.reload();
    await page.goto('/#/alerts');
    await expect(page.locator('#notify')).toBeChecked();
  });

  test('raises one notification for a new alert, and none for what was already wrong', async ({ page, context }) => {
    await context.grantPermissions(['notifications']);

    // Watch what the page asks the browser to show.
    await page.addInitScript(() => {
      (window as unknown as { __notes: { title: string; body: string }[] }).__notes = [];
      class FakeNotification {
        static permission = 'granted';
        static requestPermission = async () => 'granted';
        onclick: (() => void) | null = null;
        constructor(title: string, options: { body?: string } = {}) {
          (window as unknown as { __notes: { title: string; body: string }[] }).__notes.push({ title, body: options.body ?? '' });
        }
        close() {}
      }
      Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true });
    });

    // Start with a system that is already offline: turning the switch on must
    // not announce the backlog.
    const offline = inverter({ ts: NOW - 4000, status: 'offline' });
    await stubApi(page, { inverters: [offline] });
    await page.goto('/#/alerts');
    await page.locator('#notify').check();
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => (window as unknown as { __notes: unknown[] }).__notes.length)).toBe(0);

    // Now a second system appears, in a state worth hearing about.
    await page.route('**/api/latest', (r) => r.fulfill(json({
      now: NOW,
      inverters: [offline, inverter({ id: 's2', name: 'Hybrid', provider: 'solarman', ts: NOW - 9000, status: 'offline' })],
    })));
    // Returning to the tab is what makes the dashboard refetch, and that is the
    // moment a new alert appears. Deliberately no reload: a fresh page primes
    // again and, by design, says nothing about what was already wrong.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(900);

    const notes = await page.evaluate(() => (window as unknown as { __notes: { title: string }[] }).__notes);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.some((n) => n.title.startsWith('Hybrid:'))).toBe(true);
    // And the one that was already wrong when the switch went on stays quiet.
    expect(notes.some((n) => n.title.startsWith('On-grid Array:'))).toBe(false);
  });

  test('explains itself when the browser refuses permission', async ({ page }) => {
    await page.addInitScript(() => {
      class Denied {
        static permission = 'default';
        static requestPermission = async () => 'denied';
        close() {}
      }
      Object.defineProperty(window, 'Notification', { value: Denied, configurable: true, writable: true });
    });
    await stubApi(page);
    await page.goto('/#/alerts');
    // click, not check: the switch deliberately falls back to off when the
    // browser refuses, which check() reads as a failure to set it.
    await page.locator('#notify').click();
    await expect(page.locator('#notify')).not.toBeChecked();
    await expect(page.locator('#notifynote')).toContainText('refused permission');
  });
});
