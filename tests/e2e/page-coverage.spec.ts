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
 * Measured at 69.4% when this was written, of 136 kB of script. It had been
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
  // Every view, both roles and signed out: longer than one test's usual 20 s.
  test.setTimeout(90_000);

  const NOW = Math.floor(Date.UTC(2026, 8, 8, 9, 0, 0) / 1000);
  // One API answer: a 200 with a JSON body, for page.route to fulfil.
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

  // Signed in as the owner for most of the walk; signed out, on a private
  // dashboard, for the last part of it, so the sign-in page is walked too.
  const who = { role: 'owner' as string | null };
  await page.route('**/api/latest', (r) => r.fulfill(who.role ? json({ now: NOW, inverters }) : { status: 401, contentType: 'application/json', body: '{"error":"signin"}' }));
  await page.route('**/auth/status', (r) => r.fulfill(json({ configured: true, password: true, passkeys: 1, required: !who.role, role: who.role, device: who.role ? 'd-this' : null })));
  await page.route('**/auth/settings', (r) => r.fulfill(json({
    password: true, required: false,
    passkeys: [{ id: 'k1', name: 'Phone', created_at: NOW - 86_400, last_used_at: NOW - 60 }],
    devices: [
      { id: 'd-this', role: 'owner', label: 'Chrome on Windows', created_at: NOW - 86_400, last_seen_at: NOW - 60, expires_at: NOW + 86_400, shared: false, this: true },
      { id: 'd-tv', role: 'viewer', label: 'Chrome on Android', created_at: NOW - 86_400, last_seen_at: NOW - 600, expires_at: NOW + 86_400, shared: true, this: false },
    ],
    shares: [{ id: 'sh1', name: 'Family', created_at: NOW - 86_400, expires_at: null, revoked_at: null, devices: 1 }],
  })));
  await page.route('**/auth/**', (r) => (r.request().method() === 'POST'
    ? r.fulfill(json({ ok: true, required: true, signedOut: 1, url: 'https://dashboard.example/s/x.y', id: 'sh2' }))
    : r.fallback()));
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

  // The browser's push machinery, replaced as tests/e2e/push.spec.ts replaces
  // it, so the walk can turn notifications to a closed browser on and off
  // without a push service.
  await page.context().grantPermissions(['notifications']);
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    if (!('PushManager' in window)) w.PushManager = function PushManager() {};
    let sub: null | { endpoint: string; unsubscribe: () => Promise<boolean> } = null;
    const reg = { pushManager: {
      getSubscription: async () => sub,
      subscribe: async () => (sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/walk', unsubscribe: async () => { sub = null; return true; } }),
    } };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: async () => reg, register: async () => reg, ready: Promise.resolve(reg) },
    });
  });
  await page.route('**/api/push/key', (r) => r.fulfill(json({ publicKey: Buffer.from([4, ...Array(64).fill(7)]).toString('base64url') })));
  for (const path of ['subscribe', 'unsubscribe', 'test']) {
    await page.route(`**/api/push/${path}`, (r) => r.fulfill(json({ ok: true })));
  }

  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.goto('/');
  await expect(page.locator('#view')).not.toBeEmpty();

  // Walk the dashboard the way a person would: every view, both systems, the
  // ranges, a system's own page, its raw telemetry, and the theme switch.
  for (const hash of ['#/power', '#/history', '#/alerts', '#/devices', '#/system/s1', '#/system/s2', '#/tv', '#/guide', '#/']) {
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

  // Settings, as the owner: the switch, a link made and taken back, a device
  // signed out, the password changed.
  await page.goto('/#/settings');
  await expect(page.locator('.settings')).toBeVisible();
  await page.locator('#req').check().catch(() => {});
  await page.waitForTimeout(150);
  await page.locator('#share-name').fill('Walk');
  await page.getByRole('button', { name: 'Make a link' }).click().catch(() => {});
  await page.waitForTimeout(150);
  await page.locator('#share-copy').click({ timeout: 2000 }).catch(() => {});
  for (const sel of ['[data-unshare]', '[data-revoke]', '[data-unkey]', '#revoke-others']) {
    await page.locator(sel).first().click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(120);
  }
  await page.locator('#pw-cur').fill('a current password');
  await page.locator('#pw-new').fill('a new long password');
  await page.getByRole('button', { name: 'Change password' }).click().catch(() => {});
  await page.waitForTimeout(150);

  // Notifications: turn them on for this device, send a test, turn them off.
  await page.goto('/#/alerts');
  await expect(page.locator('#view')).not.toBeEmpty();
  for (const id of ['#pushon', '#pushtest', '#pushoff']) {
    await page.locator(id).click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(120);
  }

  // Signed out, on a private dashboard: Settings as a stranger sees it, then
  // the sign-in page. Within the same load, not by reloading: a reload is a
  // new copy of the script, and V8 drops the old copy's counts with it.
  who.role = null;
  await page.evaluate(() => { location.hash = '#/settings'; });
  await expect(page.locator('.authcard')).toBeVisible();
  await page.locator('.authmore summary').click().catch(() => {});
  await page.locator('#setup-code').fill('a code');
  await page.getByRole('button', { name: 'Set a new password' }).click().catch(() => {});
  await page.waitForTimeout(150);
  who.role = null;
  // Coming back to the tab refreshes, and this refresh is refused: sign in.
  await page.evaluate(() => { location.hash = '#/'; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('.authcard h2')).toHaveText('Sign in');
  await page.locator('#pw').fill('a password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click().catch(() => {});
  await page.waitForTimeout(150);

  const entries = await page.coverage.stopJSCoverage();

  // The dashboard is one inline script inside the document, so its coverage
  // arrives under the page's own URL rather than a .js file.
  const pageEntries = entries.filter((e) => e.url.includes('127.0.0.1') || e.url.endsWith('/') || e.url.endsWith('index.html'));
  // Should an entry for the same script arrive more than once - a frame, a
  // second load - the copies are merged: a byte counts as run if any copy ran
  // it, and each byte of script is counted once. (V8 keeps no counts for a
  // copy a reload has replaced, which is why the walk above never reloads.)
  const merged = new Map<string, Int8Array>();   // per source text: -1 markup, 0 not run, 1 run
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
    const into = merged.get(source) ?? new Int8Array(source.length).fill(-1);
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] === -1) continue;
      into[i] = counts[i] > 0 || into[i] === 1 ? 1 : 0;
    }
    merged.set(source, into);
  }
  let total = 0;
  let covered = 0;
  for (const bytes of merged.values()) {
    for (const c of bytes) {
      if (c === -1) continue;   // markup, not script
      total++;
      if (c === 1) covered++;
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
