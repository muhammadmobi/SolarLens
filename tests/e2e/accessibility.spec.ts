/**
 * Accessibility, checked on every view rather than believed.
 *
 * The dashboard is read on a phone in daylight, on a laptop, and on a wall
 * display across a room - the three situations where contrast and labelling
 * stop being a nicety. axe-core runs the WCAG 2 A and AA rules over each view
 * with real data on screen, and the suite fails on anything it rates serious or
 * critical.
 *
 * Deliberately not a blanket "zero violations of any severity": axe's minor
 * advice on a page with no build step and no component library is mostly about
 * landmarks it cannot infer, and treating that as a gate teaches people to
 * disable the gate.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const NOW = Math.floor(Date.UTC(2026, 8, 8, 9, 0, 0) / 1000);

/** The same fixtures the dashboard suite uses, kept small on purpose. */
async function stubApi(page: Page) {
  const inverters = [
    {
      id: 's1', name: 'On-grid Array', provider: 'soliscloud', serial: '••••1234', plant_name: 'On-grid Array',
      capacity_w: 12_000, ts: NOW - 60, ac_power_w: 8470, dc_power_w: 8900, today_kwh: 34.1, total_kwh: 48_000,
      battery_soc: null, battery_power_w: null, grid_power_w: -3200, load_power_w: 5270, temp_c: 41, status: 'normal',
      source: 'soliscloud-relay', metrics: null,
    },
    {
      id: 's2', name: 'Hybrid', provider: 'solarman', serial: '••••9876', plant_name: 'Hybrid',
      capacity_w: 3500, ts: NOW - 120, ac_power_w: 1200, dc_power_w: 1300, today_kwh: 6.2, total_kwh: 9000,
      battery_soc: 78, battery_power_w: -220, grid_power_w: 140, load_power_w: 900, temp_c: 33, status: 'normal',
      source: 'solarman', metrics: null,
    },
  ];
  const points = [0, 1, 2, 3].map((i) => ({ inverter_id: 's1', ts: NOW - i * 300, ac_power_w: 8000 - i * 200 }));
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/api/latest', (r) => r.fulfill(json({ now: NOW, inverters })));
  await page.route('**/api/series**', (r) => r.fulfill(json({ from: NOW - 3600, to: NOW, points })));
  await page.route('**/api/devices', (r) => r.fulfill(json({
    now: NOW,
    devices: [{
      id: 'd1', provider: 'soliscloud', plant_id: 's1', kind: 'inverter', sn: '••••1234', name: 'Inverter',
      model: 'S5-GR3P10K', firmware: '1.0.78', status: 'online', signal_dbm: -63, strings: [{ index: 1, powerW: 4200 }],
      ac_phases: null, temp_c: 41, last_seen: NOW - 60,
    }],
  })));
  await page.route('**/api/history**', (r) => r.fulfill(json({
    now: NOW, days: 30,
    rows: [0, 1, 2].map((i) => ({
      inverter_id: 's1', day: `2026-09-0${8 - i}`, yield_kwh: 40 - i, peak_w: 9000, load_kwh: null,
      import_kwh: null, export_kwh: null, batt_charge_kwh: null, batt_discharge_kwh: null,
      samples: 200, first_ts: NOW - 86_400, last_ts: NOW,
    })),
  })));
  await page.route('**/api/alarms**', (r) => r.fulfill(json({
    now: NOW, days: 730,
    alarms: [{
      inverter_id: 's1', provider: 'soliscloud', code: '1015', message: 'NO-Grid', severity: 'warning',
      advice: 'No Action Required', begin_ts: NOW - 7200, end_ts: NOW - 3600, state: 'recovered',
    }],
  })));
  await page.route('**/api/periods', (r) => r.fulfill(json({ now: NOW, periods: [] })));
  await page.route('**/api/health', (r) => r.fulfill(json({
    now: NOW,
    polls: [{ ts: NOW - 30, provider: 'soliscloud', ok: 1, detail: 'plants=1 inverters=1 new=1' }],
    feeds: [{ ts: NOW - 30, provider: 'soliscloud', ok: 1, detail: 'plants=1 inverters=1 new=1' }],
    relays: [{ name: 'Relay 1', state: 'ok', login_expires_at: NOW + 5 * 86_400, last_seen: NOW - 60, first_seen: NOW - 86_400, last_ok_at: NOW - 60 }],
  })));
}

/** Serious and critical only: see the note at the top of this file. */
async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')} | ${(n.any[0]?.message ?? v.help).slice(0, 150)}`));
}

const views = [
  ['Overview', '#/'],
  ['Power', '#/power'],
  ['Historical Data', '#/history'],
  ['Alerts', '#/alerts'],
  ['Devices', '#/devices'],
  ['TV mode', '#/tv'],
  ['Guide', '#/guide'],
] as const;

for (const [name, hash] of views) {
  test(`${name} has no serious or critical accessibility violations`, async ({ page }) => {
    await stubApi(page);
    await page.goto(`/${hash}`);
    await expect(page.locator('#view')).not.toBeEmpty();
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test('the page can be worked through with a keyboard alone', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await expect(page.locator('#view')).not.toBeEmpty();

  // Tab until the Alerts link has focus, then follow it with the keyboard.
  const alerts = page.locator('nav#nav a[href="#/alerts"]');
  for (let i = 0; i < 25 && !(await alerts.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(alerts).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/alerts$/);
});

/**
 * What the control under focus looks like, asked of the page after each Tab.
 *
 * Tabbed to, not focused by script: `:focus-visible` is what draws the ring,
 * and it deliberately does not apply to a programmatic focus() - which is why
 * an earlier version of this test proved nothing. It marks each control as it
 * passes, so the caller can tell a full lap from a loop.
 */
async function focusedControl(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return null;
    const s = getComputedStyle(el);
    const already = el.dataset.a11yWalked === '1';
    el.dataset.a11yWalked = '1';
    return {
      already,
      what: el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
      shows: (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0)
        || s.boxShadow !== 'none'
        || s.textDecorationLine !== 'none',
    };
  });
}

for (const [name, hash] of views) {
  test(`every control on ${name} shows when it has the keyboard`, async ({ page }) => {
    await stubApi(page);
    await page.goto(`/${hash}`);
    await expect(page.locator('#view')).not.toBeEmpty();

    // A full lap, not a fixed prefix: tab until the order comes back round to a
    // control it has already passed, so a control added at the end of a view is
    // checked rather than silently falling off the end of a count.
    const seen: string[] = [];
    const invisible: string[] = [];
    let laps = 0;
    for (let i = 0; i < 300; i++) {
      await page.keyboard.press('Tab');
      const at = await focusedControl(page);
      if (!at) continue;                    // browser chrome, between laps
      if (at.already) { laps++; break; }
      seen.push(at.what);
      if (!at.shows) invisible.push(at.what);
    }

    expect(laps, `the focus order never came back round on ${name}`).toBe(1);
    // TV mode is a wall display with the chrome taken away: one way back out
    // is the whole of its focus order, and that is the point of it.
    const least = name === 'TV mode' ? 1 : 4;
    expect(seen.length, 'nothing took keyboard focus, so nothing was checked').toBeGreaterThanOrEqual(least);
    expect(invisible, 'these controls show nothing when focused with a keyboard').toEqual([]);
  });
}
