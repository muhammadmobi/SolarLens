import { expect, test, type Page } from '@playwright/test';

/**
 * The dashboard is a static page that talks to /api/*. These tests stub those
 * endpoints so the suite needs no Worker, D1 or vendor credentials, and they
 * assert what a person sees: the overview panels and divider layout, the
 * per-system detail view, the hardware inventory, staleness and the auth gate.
 */

const NOW = Math.floor(Date.now() / 1000);
const SOLIS = 'soliscloud:station:1';
const HYBRID = 'solarman:station:62000000';

const metrics = (o: Record<string, unknown>) => JSON.stringify(o);

function inverters(overrides: Partial<Record<'solis' | 'solarman', Record<string, unknown>>> = {}) {
  return [
    {
      id: SOLIS, provider: 'soliscloud', serial: 'DEMO01', name: 'Demo Solis Plant',
      plant_id: '1', plant_name: 'Demo Solis Plant', capacity_w: 12000, display_order: 0,
      ts: NOW - 120, source: 'soliscloud-relay', ac_power_w: 5080, dc_power_w: null, today_kwh: 49, total_kwh: 48852,
      // An on-grid plant has no battery at all - not a battery sitting at 0%.
      battery_soc: null, battery_power_w: null, grid_power_w: -5080, load_power_w: null, temp_c: null, status: 'online',
      metrics: metrics({ genMonthKwh: 185, genYearKwh: 13677, genTotalKwh: 48852, loadTodayKwh: 49, loadTotalKwh: 48852,
        gridImportTodayKwh: 0, gridExportTodayKwh: 0, gridImportTotalKwh: 0, gridExportTotalKwh: 0,
        battChargeTodayKwh: null, battDischargeTodayKwh: null, battChargeTotalKwh: null, battDischargeTotalKwh: null,
        selfUseTodayKwh: null, fullLoadHours: 4.94, batteryStatus: null, gridStatus: null,
        weatherText: 'Clear', tempMinC: 24, tempMaxC: 31, sunrise: '05:45', sunset: '18:25' }),
      raw: JSON.stringify({ power: 5.08, powerStr: 'kW', state: 1, sno: 'ABC123', fullHour: 4.94 }),
      ...(overrides.solis ?? {}),
    },
    {
      id: HYBRID, provider: 'solarman', serial: null, name: 'Demo Hybrid',
      plant_id: '62000000', plant_name: 'Demo Hybrid', capacity_w: 3500, display_order: 0,
      ts: NOW - 200, source: 'solarman-web', ac_power_w: 278, dc_power_w: null, today_kwh: 13.7, total_kwh: 7450.8,
      battery_soc: 100, battery_power_w: -24, grid_power_w: 91, load_power_w: 307, temp_c: null, status: 'online',
      metrics: metrics({ genMonthKwh: 70.9, genYearKwh: 4002.1, genTotalKwh: 7450.8, loadTodayKwh: 4.8, loadTotalKwh: 6691.7,
        gridImportTodayKwh: 2.4, gridExportTodayKwh: 10.7, gridImportTotalKwh: 4699.2, gridExportTotalKwh: 4686.7,
        battChargeTodayKwh: 0.6, battDischargeTodayKwh: 0, battChargeTotalKwh: 1100.1, battDischargeTotalKwh: 354.3,
        selfUseTodayKwh: 3, batteryStatus: 'STATIC', gridStatus: 'PURCHASE' }),
      raw: JSON.stringify({ generationPower: 278, usePower: 307, batterySoc: 100, networkStatus: 'NORMAL' }),
      ...(overrides.solarman ?? {}),
    },
  ];
}

function devices() {
  return [
    {
      id: 'soliscloud:inverter:DEMO01', provider: 'soliscloud', plant_id: '1', kind: 'inverter',
      sn: 'DEMO01', name: 'Demo Solis Inverter', model: 'S5-GR3P10K', firmware: '87003E',
      rated_power_w: 10000, status: 'online', signal_dbm: null, upload_cycle_s: null,
      commissioned_at: 1709121876, warranty_until: 1866816000, last_seen: NOW - 120,
      strings: JSON.stringify([
        { index: 1, powerW: 33.58, voltageV: 167.9, currentA: 0.2 },
        { index: 2, powerW: 30.94, voltageV: 154.7, currentA: 0.2 },
      ]),
      ac_phases: JSON.stringify([
        { index: 1, voltageV: 228.4, currentA: 0.1 },
        { index: 2, voltageV: 228.3, currentA: 0.1 },
        { index: 3, voltageV: 232, currentA: 0.1 },
      ]),
      frequency_hz: 49.64, power_factor: 0.99, temp_c: 40.6, dc_bus_v: 589.9,
      updated_at: NOW, raw: null,
    },
    {
      id: 'soliscloud:datalogger:LOG01', provider: 'soliscloud', plant_id: '1', kind: 'datalogger',
      sn: 'LOG01', name: 'S3-WIFI-ST', model: 'S3-WIFI-ST', firmware: '10186',
      rated_power_w: null, status: 'online', signal_dbm: -58, upload_cycle_s: 300,
      commissioned_at: null, warranty_until: null, last_seen: NOW - 120,
      strings: null, ac_phases: null, frequency_hz: null, power_factor: null,
      temp_c: null, dc_bus_v: null, updated_at: NOW, raw: null,
    },
    {
      id: 'solarman:inverter:HYB01', provider: 'solarman', plant_id: '62000000', kind: 'inverter',
      sn: 'HYB01', name: 'Demo Hybrid Inverter', model: 'Single phase LV Hybrid', firmware: 'V1.0 / V2.0',
      rated_power_w: 3500, status: 'online', signal_dbm: null, signal_pct: 84, upload_cycle_s: null,
      commissioned_at: null, warranty_until: null, last_seen: NOW - 200,
      strings: JSON.stringify([{ index: 1, powerW: 120, voltageV: 24.2, currentA: 5 }]),
      ac_phases: JSON.stringify([{ index: 1, voltageV: 233.3, currentA: 0.2 }]),
      frequency_hz: 50.01, power_factor: null,
      temp_c: 49.4, dc_bus_v: null,
      battery: JSON.stringify({
        tempC: 32.5, voltageV: 27.29, currentA: -0.93,
        bmsTempC: 32.5, bmsVoltageV: 26.98, bmsCurrentA: 0,
        chargeLimitA: 0, dischargeLimitA: 130,
        ratedCapacityAh: 100, nominalVoltageV: 24, chemistry: 'lithium', status: 'Static',
        bmsSocPct: 100, bmsChargeVoltageV: 28.5, bmsDischargeVoltageV: 0,
      }),
      updated_at: NOW, raw: null,
    },
    {
      id: 'solarman:datalogger:LOG02', provider: 'solarman', plant_id: '62000000', kind: 'datalogger',
      sn: 'LOG02', name: 'Datalogger', model: 'LSW-3', firmware: 'MW3_15U_5406_1.20',
      rated_power_w: null, status: 'online', signal_dbm: null, signal_pct: 84, upload_cycle_s: 300,
      commissioned_at: null, warranty_until: null, last_seen: NOW - 200,
      strings: null, ac_phases: null, frequency_hz: null, power_factor: null,
      temp_c: null, dc_bus_v: null, updated_at: NOW, raw: null,
    },
  ];
}

function series() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const t0 = Math.floor(start.getTime() / 1000);
  const points: unknown[] = [];
  for (let h = 6; h <= 18; h++) {
    const ts = t0 + h * 3600;
    const bell = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));
    points.push({ inverter_id: SOLIS, ts, ac_power_w: Math.round(10_000 * bell), today_kwh: null, battery_soc: null, grid_power_w: null });
    points.push({ inverter_id: HYBRID, ts, ac_power_w: Math.round(3_000 * bell), today_kwh: null, battery_soc: null, grid_power_w: null });
  }
  return points;
}

/** Four days of daily rows: the on-grid plant has no meter, the hybrid has. */
function historyRows() {
  const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
  const rows: unknown[] = [];
  for (let n = 0; n < 4; n++) {
    rows.push({
      inverter_id: SOLIS, day: day(n), yield_kwh: 44.7 - n, peak_w: 9470,
      load_kwh: null, import_kwh: null, export_kwh: null,
      batt_charge_kwh: null, batt_discharge_kwh: null,
      samples: 111, first_ts: NOW - 86400, last_ts: NOW,
    });
    rows.push({
      inverter_id: HYBRID, day: day(n), yield_kwh: 13.2 - n, peak_w: 2850,
      load_kwh: 5.3, import_kwh: 2.2, export_kwh: 9.4,
      batt_charge_kwh: 0.9, batt_discharge_kwh: 0.2,
      samples: 140, first_ts: NOW - 86400, last_ts: NOW,
    });
  }
  return rows;
}

async function stubApi(page: Page, opts: {
  invs?: unknown[]; devs?: unknown[]; status?: number; series?: unknown[];
  poll?: { ts?: number; ok: number; detail: string; provider: string };
  history?: unknown[] | null;
  feeds?: { ts: number; ok: number; detail: string; provider: string }[];
} = {}) {
  const status = opts.status ?? 200;
  const invs = opts.invs ?? inverters();
  const devs = opts.devs ?? devices();
  const ids = new Set((invs as { id: string }[]).map((i) => i.id));
  const points = opts.series ?? series().filter((p) => ids.has((p as { inverter_id: string }).inverter_id));
  const json = (body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/latest', (r) => r.fulfill(json(status === 200 ? { now: NOW, inverters: invs } : { error: 'unauthorized' })));
  await page.route('**/api/series**', (r) => r.fulfill(json(status === 200 ? { from: 0, to: NOW, points } : { error: 'unauthorized' })));
  await page.route('**/api/devices', (r) => r.fulfill(json(status === 200 ? { now: NOW, devices: devs } : { error: 'unauthorized' })));
  await page.route('**/api/history**', (r) => r.fulfill(json({ now: NOW, days: 30, rows: opts.history ?? historyRows() })));
  const polls = [opts.poll ?? { ts: NOW - 30, provider: 'solarman', ok: 1, detail: 'plants=1 inverters=1 new=1' }];
  await page.route('**/api/health', (r) => r.fulfill(json({ now: NOW, polls, feeds: opts.feeds ?? polls })));
}

test.describe('Overview', () => {
  test('shows both inverters side by side with live numbers', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');

    const panels = page.locator('.ovsys');
    await expect(panels).toHaveCount(2);
    await expect(panels.nth(0)).toContainText('SolisCloud');
    await expect(panels.nth(0)).toContainText('Demo Solis Plant');
    // Producing now is drawn in the diagram and nowhere else. It used to be
    // there and repeated as a figure below, which is most of why the old
    // three-band overview came out taller than the window.
    await expect(panels.nth(0).locator('svg.flow')).toContainText('5.08 kW');
    await expect(panels.nth(0).locator('.ovtiles')).not.toContainText('Producing now');

    await expect(panels.nth(1)).toContainText('SolarMan');
    await expect(panels.nth(1).locator('svg.flow')).toContainText('278 W');
    await expect(panels.nth(1)).toContainText('91 W');
    // A few watts of battery drift renders as idle, not as discharging.
    await expect(panels.nth(1)).toContainText('idle');

    await expect(page.locator('#fleet-power')).toHaveText('5.36 kW');
    // The word "today" is now a label above the figure, not part of it.
    await expect(page.locator('#fleet-today')).toHaveText('62.7 kWh');
    // Every headline figure is labelled - a bare "20 W" told you nothing about
    // whether it was one system, both, or something else entirely.
    await expect(page.locator('.flabel')).toHaveText(['Producing now', 'Produced today', 'Consumed today', 'Weather']);
    await expect(page.locator('#fleet-used')).toHaveText('53.8 kWh');
    await expect(page.locator('#fleet-wx')).toContainText('Clear');
    // The footer names each feed rather than reciting one raw log row.
    await expect(page.locator('#poll-status')).toContainText('SolarMan ok');
  });

  test('only the hybrid gets battery tiles; the on-grid plant gets none', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    const tiles = (n: number) => page.locator('.ovsys').nth(n).locator('.ovtiles');
    await expect(tiles(0)).not.toContainText('Battery');
    await expect(tiles(1)).toContainText('Battery power');
    await expect(tiles(1)).toContainText('Charged today');
    await expect(tiles(1)).toContainText('Discharged today');
    // Four across, and trimmed to a multiple of four so the grid never ends in
    // a ragged row: eight for the on-grid inverter, twelve once there is a
    // battery to describe.
    await expect(tiles(0).locator('> div')).toHaveCount(8);
    await expect(tiles(1).locator('> div')).toHaveCount(12);
  });

  test('the whole overview fits one screen, which is the point of the layout', async ({ page }, testInfo) => {
    await stubApi(page);
    await page.goto('/');
    await expect(page.locator('.ovsys')).toHaveCount(2);
    const fits = await page.evaluate(() =>
      document.documentElement.scrollHeight <= window.innerHeight + 2);
    // Two systems side by side need the width for it. A phone stacks and
    // scrolls, and pretending otherwise would mean hiding readings.
    if (testInfo.project.name === 'mobile') expect(fits).toBe(false);
    else expect(fits).toBe(true);
  });

  test('renders the divider layout: side by side on desktop, stacked on narrow screens', async ({ page }, testInfo) => {
    await stubApi(page);
    await page.goto('/');
    const [a, b] = await page.locator('.ovsys').all();
    const ba = await a.boundingBox();
    const bb = await b.boundingBox();
    expect(ba && bb).toBeTruthy();
    if (testInfo.project.name === 'mobile') {
      expect(bb!.y).toBeGreaterThan(ba!.y + ba!.height - 1);   // stacked
    } else {
      expect(Math.abs(bb!.y - ba!.y)).toBeLessThan(2);          // same row
      expect(bb!.x).toBeGreaterThan(ba!.x + ba!.width - 1);
    }
  });

  test('a system whose sample is older than 15 minutes reads offline', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 3600 } }) });
    await page.goto('/');
    const solis = page.locator('.ovsys').nth(0);
    await expect(solis.locator('.flowstale')).toContainText('last update');
    await expect(solis.locator('.pill')).toHaveClass(/warn/);
    await expect(solis.locator('.pill')).toHaveText('offline');
    // Offline output is zero, not the 5.08 kW it managed before it dropped.
    await expect(solis.locator('svg.flow')).toContainText('0 W');
  });

  test('the vendor calling a plant offline is enough on its own', async ({ page }) => {
    // Fresh sample, one minute old - but SolisCloud sets state 2 the moment
    // the datalogger drops, well before our own staleness window runs out.
    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 60, status: 'offline' } }) });
    await page.goto('/');
    const solis = page.locator('.ovsys').nth(0);
    await expect(solis.locator('.pill')).toHaveText('offline');
    await expect(solis.locator('svg.flow')).toContainText('0 W');
  });

  test('an offline system counts as zero in the fleet total and is named', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 3600 } }) });
    await page.goto('/');
    // Only the hybrid's 278 W is real; the Solis plant contributes a zero.
    await expect(page.locator('#fleet-power')).toHaveText('278 W');
    await expect(page.locator('#fleet-quiet')).toBeVisible();
    await expect(page.locator('#fleet-quiet')).toHaveText('Demo Solis Plant offline');
    // Today's energy still counts it - those kWh were genuinely generated.
    await expect(page.locator('#fleet-today')).toHaveText('62.7 kWh');
  });

  test('an offline system zeroes its grid, load and battery too', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solarman: { ts: NOW - 3600 } }) });
    await page.goto('/#/system/' + encodeURIComponent(HYBRID));
    const live = page.locator('.card').filter({ has: page.locator('h3', { hasText: 'Live power' }) });
    await expect(live).toContainText('0 W');
    await expect(live).not.toContainText('307 W');
    // The charge level is a state, not a flow, so it survives: the pack still
    // holds what it held when the link dropped.
    await expect(page.locator('.ring text')).toHaveText('100%');
  });

  test('no flag, and both systems counted, while everything is fresh', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(page.locator('#fleet-power')).toHaveText('5.36 kW');
    await expect(page.locator('#fleet-quiet')).toBeHidden();
  });

  test('surfaces a failed poll in the footer', async ({ page }) => {
    await stubApi(page, { poll: { ts: NOW - 60, provider: 'soliscloud', ok: 0, detail: 'soliscloud: HTTP 401 on /v1/api/userStationList' } });
    await page.goto('/');
    await expect(page.locator('#poll-status')).toContainText('FAILED');
    await expect(page.locator('#poll-status')).toContainText('HTTP 401');
  });

  test('says something useful when the API answers 401', async ({ page }) => {
    // Reads are public now, so this only happens against a deployment older
    // than that change - but a blank page would say nothing about why.
    await stubApi(page, { status: 401 });
    await page.goto('/');
    await expect(page.locator('.empty')).toContainText('refused this request');
    await expect(page.locator('#updated')).toHaveText('unauthorized');
  });

  test('handles an empty fleet without errors', async ({ page }) => {
    await stubApi(page, { invs: [], devs: [] });
    await page.goto('/');
    await expect(page.locator('.empty')).toContainText('No inverters yet');
    // The chart moved to its own page; with no fleet it says so rather than drawing.
    await page.goto('/#/power');
    await expect(page.locator('#combined')).toContainText('No samples yet today');
  });
});

test.describe('Alerts', () => {
  test('one tab, one collapsible section per system', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/alerts');
    const secs = page.locator('details.syssec');
    await expect(secs).toHaveCount(2);
    await expect(secs.nth(0)).toContainText('Demo Solis Plant');
    await expect(secs.nth(1)).toContainText('Demo Hybrid');
    // Collapsing one system's alerts leaves the other's alone.
    await secs.nth(0).locator('> summary').click();
    await expect(secs.nth(0)).not.toHaveAttribute('open', '');
    await expect(secs.nth(1)).toHaveAttribute('open', '');
  });

  test('a clean system says what was checked, not just nothing', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/alerts');
    const clear = page.locator('.allclear').first();
    await expect(clear).toContainText('Nothing reported');
    // An empty box is ambiguous between "all clear" and "nobody looked", so
    // the checks that ran are named.
    await expect(clear).toContainText('feed freshness');
    await expect(clear).toContainText('last poll result');
  });

  test("raises the vendor's own alarm counter, and says which vendor", async ({ page }) => {
    const invs = inverters({
      solis: { raw: JSON.stringify({ power: 5.08, powerStr: 'kW', state: 3, alarmCount: 2, alarmLevel: 2 }) },
    });
    await stubApi(page, { invs });
    await page.goto('/#/alerts');
    const sec = page.locator('details.syssec').nth(0);
    await expect(sec).toContainText('2 active alarms');
    await expect(sec).toContainText('Alarm level 2');
    await expect(sec.locator('.a-src').first()).toHaveText('SolisCloud');
  });

  test("reads SolarMan's NORMAL/abnormal flags", async ({ page }) => {
    const invs = inverters({
      solarman: { raw: JSON.stringify({ generationPower: 278, warningStatus: 'ABNORMAL', networkStatus: 'OFFLINE' }) },
    });
    await stubApi(page, { invs });
    await page.goto('/#/alerts');
    const sec = page.locator('details.syssec').nth(1);
    await expect(sec).toContainText('Inverter warning');
    await expect(sec).toContainText('Datalogger link');
    await expect(sec).toContainText('abnormal');
  });

  test('every alert carries the moment it is describing', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 3600 } }) });
    await page.goto('/#/alerts');
    const stamps = page.locator('details.syssec').nth(0).locator('.a-when time');
    await expect(stamps.first()).toBeVisible();

    // A machine-readable instant, so the markup is not just decoration...
    const dt = await stamps.first().getAttribute('datetime');
    expect(dt).toBeTruthy();
    expect(Number.isNaN(Date.parse(dt as string))).toBe(false);
    // ...matching the hour the alert is actually about.
    expect(Math.abs(Date.parse(dt as string) / 1000 - (NOW - 3600))).toBeLessThan(120);

    // And a human-readable one carrying both a clock time and how long ago.
    const text = (await stamps.first().textContent()) ?? '';
    expect(text).toContain(':');
    expect(text).toContain('ago');
    expect(text).toContain(String(new Date((NOW - 3600) * 1000).getFullYear()));
  });

  test('faults sort above warnings, and newer above older', async ({ page }) => {
    // A plant going down takes its hardware with it, which is the realistic
    // shape of this: one fault and two symptoms.
    const devs = devices().map((d) => d.provider === 'soliscloud'
      ? { ...d, status: 'offline', last_seen: NOW - 3600 } : d);
    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 3600 } }), devs });
    await page.goto('/#/alerts');
    const items = page.locator('details.syssec').nth(0).locator('.alerts li');
    await expect(items).toHaveCount(3);
    await expect(items.first()).toHaveClass(/bad/);
    await expect(items.first()).toContainText('System offline');
    // The two devices that went quiet with it follow, as warnings.
    await expect(items.nth(1)).toHaveClass(/warn/);
    await expect(items.nth(2)).toHaveClass(/warn/);
  });

  test('a device stamp is its own last contact, not the plant\'s newest update', async ({ page }) => {
    const devs = devices().map((d) => d.kind === 'datalogger' && d.provider === 'soliscloud'
      ? { ...d, status: 'offline', last_seen: NOW - 7200 } : d);
    await stubApi(page, { devs });
    await page.goto('/#/alerts');
    const row = page.locator('.alerts li', { hasText: 'Datalogger' }).first();
    const dt = await row.locator('.a-when time').getAttribute('datetime');
    // Two hours, from the datalogger's own record - not the two minutes since
    // the plant's newest sample.
    expect(Math.abs(Date.parse(dt as string) / 1000 - (NOW - 7200))).toBeLessThan(120);
  });

  test('a clean system is stamped with the update it was judged against', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/alerts');
    const clear = page.locator('.allclear').first();
    await expect(clear.locator('.a-when')).toContainText('Against the update of');
    const dt = await clear.locator('time').getAttribute('datetime');
    expect(Number.isNaN(Date.parse(dt as string))).toBe(false);
  });

  test('an offline feed is an alert in its own right', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 3600 } }) });
    await page.goto('/#/alerts');
    await expect(page.locator('details.syssec').nth(0)).toContainText('System offline');
    await expect(page.locator('details.syssec').nth(0)).toContainText('the cutoff is 15 minutes');
    // A relay-fed feed has a second way to go quiet that is nothing to do with
    // the plant, and the fix for it is on this side rather than on the roof.
    await expect(page.locator('details.syssec').nth(0)).toContainText('relay agent');
  });

  test("a failed poll is ours to report, not the vendor's", async ({ page }) => {
    await stubApi(page, { poll: { ts: NOW - 60, provider: 'solarman', ok: 0, detail: 'HTTP 401 on /device/v1.0/currentData?a & b' } });
    await page.goto('/#/alerts');
    const sec = page.locator('details.syssec').nth(1);
    await expect(sec).toContainText('Last poll failed');
    await expect(sec).toContainText('HTTP 401');
    // Escaped once, by the renderer. Escaping in the model as well turned an
    // "&" in a vendor error string into "&amp;" on the page.
    await expect(sec).toContainText('a & b');
    await expect(sec.locator('.a-src').last()).toHaveText('SolarLens');
  });

  test('the tab badge counts what is wrong across the fleet', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(page.locator('#alertbadge')).toBeHidden();

    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 3600 } }) });
    await page.reload();
    await expect(page.locator('#alertbadge')).toBeVisible();
    await expect(page.locator('#alertbadge')).toHaveText('1');
    await expect(page.locator('#alertbadge')).toHaveClass(/bad/);
  });
});

test.describe('Feed status', () => {
  test('names every feed, not just whichever logged most recently', async ({ page }) => {
    // Only SolarMan runs on the cron; SolisCloud arrives through the relay.
    // Showing one newest row meant the footer read "plants=1 inverters=1" and
    // never mentioned the other system at all.
    await stubApi(page, {
      feeds: [
        { ts: NOW - 90, provider: 'solarman', ok: 1, detail: 'plants=1 inverters=1 new=1' },
        { ts: NOW - 20, provider: 'soliscloud', ok: 1, detail: 'soliscloud-relay: Demo Solis Plant 5080 W' },
      ],
    });
    await page.goto('/');
    const feeds = page.locator('#poll-status .feed');
    await expect(feeds).toHaveCount(2);
    await expect(feeds.nth(0)).toContainText('SolarMan');
    await expect(feeds.nth(1)).toContainText('SolisCloud');
    await expect(feeds.nth(1)).toContainText('soliscloud-relay');
  });

  test('a failed feed is marked, and the healthy one still shows', async ({ page }) => {
    await stubApi(page, {
      feeds: [
        { ts: NOW - 60, provider: 'soliscloud', ok: 0, detail: 'HTTP 408 on /v1/api/userStationList' },
        { ts: NOW - 20, provider: 'solarman', ok: 1, detail: 'plants=1 inverters=1 new=1' },
      ],
    });
    await page.goto('/');
    await expect(page.locator('#poll-status .feed.bad')).toHaveCount(1);
    await expect(page.locator('#poll-status .feed.bad')).toContainText('FAILED');
    await expect(page.locator('#poll-status .feed.bad')).toContainText('HTTP 408');
    await expect(page.locator('#poll-status .feed:not(.bad)')).toContainText('SolarMan');
  });

  test('falls back to the newest single line for an older Worker', async ({ page }) => {
    // /api/health gained `feeds` after the page shipped; a deploy where the
    // two are out of step must not blank the footer.
    await page.route('**/api/health', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ now: NOW, polls: [{ ts: NOW - 30, provider: 'solarman', ok: 1, detail: 'plants=1' }] }),
    }));
    await stubApi(page);
    await page.goto('/');
    await expect(page.locator('#poll-status')).toContainText('SolarMan');
  });
});

test.describe('Historical Data', () => {
  test('one section per system, with a day table and a bar per day', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/history');
    const secs = page.locator('details.syssec');
    await expect(secs).toHaveCount(2);
    await expect(secs.nth(0)).toContainText('Demo Solis Plant');
    await expect(secs.nth(0).locator('tbody tr')).toHaveCount(4);
    await expect(secs.nth(0).locator('.daybar')).toHaveCount(4);
  });

  test('shows only the columns that system actually measures', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/history');
    const solis = page.locator('details.syssec').nth(0);
    const hybrid = page.locator('details.syssec').nth(1);
    // The on-grid plant has no meter, so consumption and grid columns would be
    // columns of dashes. The hybrid has both, plus a battery.
    await expect(solis.locator('thead th')).toHaveText(['Day', 'Produced', 'Peak', 'Samples']);
    await expect(hybrid.locator('thead th')).toHaveText(
      ['Day', 'Produced', 'Consumed', 'Imported', 'Exported', 'Charged', 'Discharged', 'Peak', 'Samples']);
  });

  test('says the record starts when SolarLens did, and shows the vendor totals beside it', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/history');
    await expect(page.locator('.cardnote')).toContainText('begins when it started collecting');
    const solis = page.locator('details.syssec').nth(0);
    await expect(solis).toContainText('Recorded here');
    // 48852 kWh lifetime against four days of our own: the two must never be
    // mistaken for each other.
    await expect(solis).toContainText('Vendor · lifetime');
  });

  test('the range picker reloads the page for that many days', async ({ page }) => {
    await stubApi(page);
    const seen: string[] = [];
    // Registered after stubApi: Playwright tries the most recent route first.
    await page.route('**/api/history**', (r) => {
      seen.push(new URL(r.request().url()).searchParams.get('days') ?? '');
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ now: NOW, days: 30, rows: historyRows() }) });
    });
    await page.goto('/#/history');
    await expect(page.locator('.rangebtn.on')).toHaveText('30 days');
    await page.locator('.rangebtn', { hasText: '7 days' }).click();
    await expect(page.locator('.rangebtn.on')).toHaveText('7 days');
    expect(seen).toContain('7');
  });

  test("asks for days in the reader's own timezone, not UTC", async ({ page }) => {
    await stubApi(page);
    let url = '';
    await page.route('**/api/history**', (r) => {
      url = r.request().url();
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ now: NOW, days: 30, rows: [] }) });
    });
    await page.goto('/#/history');
    await expect(page.locator('.rangepick')).toBeVisible();
    // A solar day ends at the array's midnight; grouping by UTC would split
    // every day in the wrong place for most of the world.
    expect(url).toContain('tz=');
  });

  test('a system with no recorded days says so rather than drawing an empty table', async ({ page }) => {
    await stubApi(page, { history: [] });
    await page.goto('/#/history');
    await expect(page.locator('details.syssec').nth(0)).toContainText('No days recorded yet');
  });
});

test.describe('Theme', () => {
  test('the toggle cycles auto - light - dark and the choice survives a reload', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    const btn = page.locator('.themebtn');
    await expect(btn).toHaveCount(1);
    // Nothing stamped on the root means "follow the system".
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /light|dark/);

    await btn.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await btn.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('the stored choice is applied before the page paints', async ({ page }) => {
    await stubApi(page);
    await page.addInitScript(() => localStorage.setItem('sl-theme', 'light'));
    await page.goto('/');
    // If this were applied by the render pass the attribute would arrive late
    // and the page would flash the wrong theme first.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});

test.describe('Battery', () => {
  test('the overview panel says charge level, what the pack is doing, and how warm it is', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    const sys = page.locator('.ovsys').nth(1);
    // Charge level and what the pack is doing are in the diagram; the tiles
    // carry the figures a picture cannot show.
    await expect(sys.locator('svg.flow')).toContainText('100%');
    await expect(sys.locator('svg.flow')).toContainText('idle');
    const tiles = sys.locator('.ovtiles');
    await expect(tiles).toContainText('Battery temp');
    await expect(tiles).toContainText('32.5 °C');
    await expect(tiles).toContainText('Charged today');
    await expect(tiles).toContainText('0.6 kWh');
  });

  test('derives equivalent full cycles and labels them as derived', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(HYBRID));
    const card = page.locator('section.card', { has: page.locator('h3', { hasText: 'Battery' }) });
    await expect(card).toContainText('Rated capacity');
    await expect(card).toContainText('100 Ah @ 24 V · 2.40 kWh');
    // 1100.1 kWh charged over a 2.4 kWh pack.
    await expect(card).toContainText('Equivalent full cycles');
    await expect(card.locator('dd', { hasText: 'derived' })).toContainText('458');
    await expect(card).toContainText('BMS state of charge');
  });

  test('an on-grid plant gets no cycle count, because it has no pack', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    await expect(page.locator('body')).not.toContainText('Equivalent full cycles');
  });
});

test.describe('Power page', () => {
  test('an offline system heads its section with a zero, not a stale figure', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 3600 } }) });
    await page.goto('/#/power');
    const head = page.locator('details.syssec', { hasText: 'Demo Solis Plant' }).locator('> summary');
    await expect(head.locator('.snow')).toHaveText('0 W');
    await expect(head.locator('.pill')).toHaveText('offline');
  });

  test('gives each system its own collapsible section, and the chart one too', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/power');
    const secs = page.locator('details.syssec');
    // The chart is collapsible in its own right, above the two systems.
    await expect(secs).toHaveCount(3);
    await expect(secs.nth(0)).toContainText('Today · AC output · all systems');
    // Open by default: the page is there to be read, not clicked open twice.
    await expect(secs.nth(1)).toHaveAttribute('open', '');
    await secs.nth(1).locator('> summary').click();
    await expect(secs.nth(1)).not.toHaveAttribute('open', '');
    // Collapsing one leaves the others alone.
    await expect(secs.nth(2)).toHaveAttribute('open', '');
    await secs.nth(0).locator('> summary').click();
    await expect(secs.nth(0)).not.toHaveAttribute('open', '');
  });

  test('the legend switches a line out of the chart, and remembers it', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/power');
    const items = page.locator('.legitem');
    await expect(items).toHaveText([/Demo Solis Plant/, /Demo Hybrid/, /Fleet total/]);
    await expect(items.nth(0)).toHaveAttribute('aria-pressed', 'true');

    // Two curves lying on top of each other are two curves you cannot read, so
    // switching one off has to actually remove its line and rescale the axis.
    const before = await page.locator('#combined path').count();
    await items.nth(0).click();
    await expect(items.nth(0)).toHaveAttribute('aria-pressed', 'false');
    await expect(items.nth(0)).toHaveClass(/off/);
    expect(await page.locator('#combined path').count()).toBeLessThan(before);

    // The switch survives a reload, or it has to be flicked again every refresh.
    await page.reload();
    await expect(page.locator('.legitem').nth(0)).toHaveClass(/off/);
    await page.locator('.legitem').nth(0).click();
    await expect(page.locator('.legitem').nth(0)).not.toHaveClass(/off/);
  });

  test('one sample is not the same as none', async ({ page }) => {
    // A curve needs two points. Saying "no samples today" next to a card
    // reading 8.47 kW online is simply wrong, so the two cases differ.
    await stubApi(page, { series: [{ inverter_id: SOLIS, ts: NOW - 300, ac_power_w: 8470, today_kwh: null, battery_soc: null, grid_power_w: null }] });
    await page.goto('/#/power');
    await expect(page.locator('.legitem').nth(0)).toContainText('one sample so far');
    await expect(page.locator('.legitem').nth(1)).toContainText('no samples today');
    await expect(page.locator('svg.combined').nth(1)).toContainText('One sample so far today');
  });

  test('a handful of samples is marked, not drawn as an invisible smudge', async ({ page }) => {
    // Three samples twenty minutes apart on a 24-hour axis is a two-pixel
    // line. Drawn as a bare path, a reader quite reasonably reports it as
    // "the graph is showing nothing".
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const noon = Math.floor(t0.getTime() / 1000) + 12 * 3600;
    const sparse = [0, 300, 600].map((d) => ({
      inverter_id: SOLIS, ts: noon + d, ac_power_w: 8470 + d, today_kwh: null, battery_soc: null, grid_power_w: null,
    }));
    await stubApi(page, { series: sparse });
    await page.goto('/#/power');
    // svg.combined 0 is the fleet chart; 1 and 2 are the per-system ones.
    const chart = page.locator('svg.combined').nth(1);
    // Every sample gets a dot of its own.
    await expect(chart.locator('circle')).toHaveCount(5); // 3 samples + peak + latest
    // And the empty morning is labelled and shaded, so it reads as "nobody
    // recorded this" rather than "the system produced nothing". SolisCloud
    // said the sun came up at 05:45, so six hours of daylight are missing.
    await expect(chart.locator('.axis.gap')).toContainText('recorded from 12:00');
    await expect(chart.locator('.nodata')).toHaveCount(1);
  });

  test('a record that starts at sunrise is not a gap', async ({ page }) => {
    // The fixture's curve begins at 06:00 and sunrise was 05:45. Warning about
    // that every morning would be noise, not information.
    await stubApi(page);
    await page.goto('/#/power');
    await expect(page.locator('svg.combined').nth(1).locator('.axis.gap')).toHaveCount(0);
  });

  test('no sunrise reported means no claim about a gap', async ({ page }) => {
    // The hybrid's fixture carries no weather, so there is nothing to measure
    // a late start against - and a guess would be worse than silence.
    await stubApi(page);
    await page.goto('/#/power');
    await expect(page.locator('svg.combined').nth(2).locator('.axis.gap')).toHaveCount(0);
  });

  test('a full day of samples gets no per-sample dots', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/power');
    const chart = page.locator('svg.combined').nth(2);
    await expect(chart.locator('.nodata')).toHaveCount(0);
    // Only the peak and the latest reading are marked; 13 dots would be clutter.
    await expect(chart.locator('circle')).toHaveCount(2);
  });

  test('switching every line off says so rather than drawing an empty box', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/power');
    for (const i of [0, 1, 2]) await page.locator('.legitem').nth(i).click();
    await expect(page.locator('#combined')).toContainText('Every system is switched off');
    // And the switches are still there to turn back on.
    await expect(page.locator('.legitem')).toHaveCount(3);
  });
});

test.describe('Weather', () => {
  test('shows the site conditions in the header and in the diagnostics', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(page.locator('#wx-item')).toBeVisible();
    await expect(page.locator('#fleet-wx')).toHaveText('Clear (24–31°)');

    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    const diag = page.locator('section.card', { has: page.locator('h3', { hasText: 'Status & diagnostics' }) });
    await expect(diag).toContainText('24–31 °C');
    await expect(diag).toContainText('05:45 – 18:25');
    await expect(page.locator('.card').filter({ has: page.locator('h3', { hasText: 'Energy' }) }))
      .toContainText('Full-load hours');
  });

  test('hides the header slot entirely when no provider reported any', async ({ page }) => {
    const invs = inverters({ solis: { metrics: metrics({ genMonthKwh: 185 }) } });
    (invs[1] as { metrics: string }).metrics = metrics({ genMonthKwh: 70.9 });
    await stubApi(page, { invs });
    await page.goto('/');
    await expect(page.locator('#wx-item')).toBeHidden();
  });
});

test.describe('Energy flow on the overview', () => {
  test('each system is one column: diagram, then figures, then its day curve', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    // The three full-width bands are gone. Each system owns a column, and the
    // order inside it is the order you read: the picture, the numbers, the day.
    await expect(page.locator('h2.band')).toHaveCount(0);
    await expect(page.locator('.ovsys')).toHaveCount(2);
    await expect(page.locator('svg.flow')).toHaveCount(2);
    const order = await page.locator('.ovsys').nth(0).evaluate((el) =>
      [...el.children].map((c) => c.className.split(' ')[0]));
    expect(order).toEqual(['ovhead', 'ovflow', 'ovtiles', 'ovchart']);
  });

  test('an offline system draws a dead diagram and says why', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 3600 } }) });
    await page.goto('/');
    const box = page.locator('.ovsys').nth(0);
    await expect(box.locator('.flowstale')).toContainText('offline');
    await expect(box.locator('.flowstale')).toContainText('last update');
    // Every arm now carries a real zero, so nothing is drawn live and no pip
    // travels: the picture agrees with the figures instead of contradicting them.
    await expect(box.locator('svg.flow .wire.live')).toHaveCount(0);
    await expect(box.locator('svg.flow .pip')).toHaveCount(0);
    await expect(page.locator('.ovsys').nth(1).locator('svg.flow .pip').first()).toBeVisible();
  });

  test('the flow tab is gone and an old #/flow link lands on the overview', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(page.locator('nav a')).toHaveText([/Overview/, /Power/, /Historical Data/, /Alerts/, /Devices/]);
    await page.goto('/#/flow');
    await expect(page.locator('.ovsys')).toHaveCount(2);
  });

  test('both systems draw at the same size, whatever hardware they have', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    const boxes = await page.locator('svg.flow').evaluateAll(
      (svgs) => svgs.map((s) => s.getAttribute('viewBox')));
    // A hybrid hangs a battery below the house and carries a self-powered bar;
    // an on-grid plant has neither. Drawn at different heights, the shorter
    // card just looks cut off beside the taller one.
    expect(new Set(boxes).size).toBe(1);

    // Side by side, the two columns match and so do their charts. The hybrid
    // has more to say - a battery row and a self-powered bar - and that
    // difference is absorbed by the diagram, deliberately, because two charts
    // of different heights are the one thing this layout must not produce.
    const rects = await page.locator('.ovsys').evaluateAll(
      (els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ y: Math.round(r.y), h: Math.round(r.height) })));
    if (Math.abs(rects[0].y - rects[1].y) < 2) {
      expect(Math.abs(rects[0].h - rects[1].h)).toBeLessThanOrEqual(2);
      const charts = await page.locator('.ovchart').evaluateAll(
        (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
      expect(Math.abs(charts[0] - charts[1])).toBeLessThanOrEqual(2);
    } else {
      expect(rects[1].y).toBeGreaterThan(rects[0].y + rects[0].h - 2); // stacked
    }
  });

  test('the solar node says what share of the array is working', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    const labels = page.locator('svg.flow .lbl');
    // 5.08 kW of a 12 kW array; 278 W of a 3.5 kW one. The percentage is what
    // makes those two comparable at a glance, so it rides on the title.
    await expect(labels.nth(0)).toHaveText('Solar · 42%');
    await expect(page.locator('.ovsys').nth(1).locator('.lbl').first()).toHaveText('Solar · 8%');
  });

  test('no percentage where there is no rating to divide by', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { capacity_w: null } }) });
    await page.goto('/');
    await expect(page.locator('.ovsys').nth(0).locator('.lbl').first()).toHaveText('Solar');
  });

  test('each diagram owns its arrow markers, so accents cannot leak', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    const ids = await page.locator('svg.flow marker').evaluateAll((ms) => ms.map((m) => m.id));
    // Marker ids are document-wide. Two diagrams sharing one id means
    // url(#that-id) resolves to whichever came first, and the second diagram
    // silently borrows the first one's colour.
    expect(new Set(ids).size).toBe(ids.length);
    // And every reference points at a marker that exists in its own diagram.
    const dangling = await page.locator('svg.flow').evaluateAll((svgs) =>
      svgs.flatMap((svg) => [...svg.querySelectorAll('.wire')]
        .flatMap((w) => ['marker-start', 'marker-end'].map((a) => w.getAttribute(a)))
        .filter((ref): ref is string => !!ref)
        .map((ref) => ref.slice(5, -1))
        .filter((id) => !svg.querySelector(`marker[id="${id}"]`))));
    expect(dangling).toEqual([]);
  });

  test('a column header opens that system detail', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await page.locator('.ovhead').first().click();
    await expect(page).toHaveURL(/#\/system\//);
    await expect(page.locator('.card h3')).toContainText(['Identity & hardware']);
  });

  test('the day curve links through to the Power tab, where it is full width', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await page.locator('.ovchart').first().click();
    await expect(page).toHaveURL(/#\/power/);
  });
});
test.describe('AC output page', () => {
  test('the overview splits the chart per system instead of merging them', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    // Overlapping curves hide each other, so each system gets its own box.
    await expect(page.locator('svg.combined')).toHaveCount(2);
    await expect(page.locator('#combined')).toHaveCount(0);
    // One curve per column, each inside the system it belongs to.
    const charts = page.locator('.ovchart');
    await expect(charts).toHaveCount(2);
    await expect(page.locator('.ovsys').nth(0)).toContainText('Demo Solis Plant');
    await expect(page.locator('.ovsys').nth(1)).toContainText('Demo Hybrid');
  });

  test('has its own nav entry and draws the combined day chart', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    // The overview's chart boxes link through to the full page.
    await expect(page.locator('a.ovchart[href="#/power"]').first()).toBeVisible();
    await page.locator('nav').getByRole('link', { name: 'Power', exact: true }).click();
    await expect(page).toHaveURL(/#\/power$/);
    await expect(page.locator('#legend .legitem')).toContainText(['Demo Solis Plant', 'Demo Hybrid', 'Fleet total']);
    // Combined chart plus one per system.
    await expect(page.locator('svg.combined')).toHaveCount(3);
    // And each system's full detail set, so Power is not just a picture.
    await expect(page.locator('.card h3')).toContainText([
      'Identity & hardware', 'Datalogger & link', 'Live power', 'Energy counters',
    ]);
  });
});

test.describe('Devices', () => {
  test('lists the inverter and the datalogger with signal strength', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/devices');
    const rows = page.locator('table.devices tbody tr');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('S5-GR3P10K');
    await expect(rows.nth(0)).toContainText('DEMO01');
    await expect(rows.nth(0)).toContainText('10.00 kW');
    await expect(rows.nth(0)).toContainText('2 producing');
    // The datalogger's RSSI is the field that names a silent outage.
    await expect(rows.nth(1)).toContainText('S3-WIFI-ST');
    await expect(rows.nth(1)).toContainText('dBm');
    await expect(rows.nth(1)).toContainText('strong');
    // The two clouds report link quality on different scales - SolisCloud in
    // dBm, SolarMan as a percentage - so each row is labelled in its own units
    // rather than both being flattened onto one invented scale.
    await expect(rows.nth(3)).toContainText('84%');
    await expect(rows.nth(3)).toContainText('strong');
    await expect(rows.nth(3)).not.toContainText('dBm');
  });

  test('says what to run when no hardware has been recorded', async ({ page }) => {
    await stubApi(page, { devs: [] });
    await page.goto('/#/devices');
    await expect(page.locator('.empty')).toContainText('relay:solis');
  });
});

test.describe('System detail', () => {
  test('opens from a panel and keeps a linkable URL', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await page.locator('.ovhead').nth(0).click();
    await expect(page).toHaveURL(/#\/system\//);
    await expect(page.locator('.sys-name')).toContainText('Demo Solis Plant');
    await page.locator('a.back').click();
    await expect(page.locator('.ovsys')).toHaveCount(2);
  });

  test('on-grid system: hardware, datalogger, PV strings, and no battery block', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));

    const blocks = page.locator('.card h3');
    await expect(blocks.filter({ hasText: 'Identity & hardware' })).toBeVisible();
    await expect(blocks.filter({ hasText: 'Datalogger & link' })).toBeVisible();
    await expect(blocks.filter({ hasText: 'PV strings' })).toBeVisible();
    // The whole point of the on-grid case: no battery block at all.
    await expect(blocks.filter({ hasText: 'Battery' })).toHaveCount(0);

    await expect(page.locator('.blocks')).toContainText('S5-GR3P10K');
    await expect(page.locator('.blocks')).toContainText('87003E');
    await expect(page.locator('.blocks')).toContainText('dBm');
    await expect(page.locator('.bar-row')).toHaveCount(2);
    await expect(page.locator('.bar-row').nth(0)).toContainText('34 W');
    await expect(page.locator('.bar-row').nth(0)).toContainText('167.9 V');
    await expect(page.locator('.bar-row').nth(0)).toContainText('0.2 A');
  });

  test('hybrid system: battery block with charge and discharge counters', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(HYBRID));
    const battery = page.locator('.card').filter({ has: page.locator('h3', { hasText: 'Battery' }) });
    await expect(battery).toBeVisible();
    await expect(battery).toContainText('static');
    await expect(battery).toContainText('1100 kWh');
    await expect(battery.locator('.ring text')).toHaveText('100%');
    await expect(page.locator('.blocks')).toContainText('Produced this month');
    await expect(page.locator('.blocks')).toContainText('70.9 kWh');
  });

  test('raw telemetry expands and filters', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(HYBRID));
    const raw = page.locator('details.raw');
    await expect(raw).toBeVisible();
    await raw.locator('summary').click();
    const grid = raw.locator('.rawgrid');
    await expect(grid).toContainText('generationPower');
    await raw.locator('.rawfilter').fill('battery');
    await expect(grid.locator('.rk').filter({ hasText: 'batterySoc' })).toBeVisible();
    await expect(grid.locator('.rk').filter({ hasText: 'generationPower' })).toBeHidden();
  });

  test('on-grid system: per-phase AC, frequency, power factor and DC bus', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    const ac = page.locator('.card').filter({ has: page.locator('h3', { hasText: 'AC output' }) });
    await expect(ac).toBeVisible();
    await expect(ac).toContainText('228.4 V · 0.1 A');
    await expect(ac).toContainText('49.64 Hz');
    await expect(ac).toContainText('589.9 V');
  });

  test('heatsink temperature comes from the device when the reading has none', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    const diag = page.locator('.card').filter({ has: page.locator('h3', { hasText: 'Status' }) });
    await expect(diag).toContainText('40.6 °C');
  });

  test('the single-phase hybrid shows one AC phase, not three', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(HYBRID));
    const ac = page.locator('.card').filter({ has: page.locator('h3', { hasText: 'AC output' }) });
    await expect(ac).toContainText('233.3');
    await expect(ac).not.toContainText('Phase 2');
  });

  test('energy flow: the house is the load, and the arms read off the signs', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(HYBRID));
    const flow = page.locator('svg.flow');
    await expect(flow).toBeVisible();
    // Three arms into one house, not four arms plus a separate house-shaped
    // "Consumption" node standing next to the house it duplicated.
    await expect(flow.locator('.wire')).toHaveCount(3);
    await expect(flow.locator('.lbl')).toHaveText([/Solar/, /Grid/, /Battery/, /House load/]);
    // 278 W production, 91 W import, 307 W load - the load inside the house.
    await expect(flow).toContainText('278 W');
    await expect(flow).toContainText('91 W');
    await expect(flow).toContainText('307 W');
    await expect(flow).toContainText('importing');
    // The pack's SOC rides on its label rather than needing a node of its own.
    await expect(flow.locator('.lbl').nth(2)).toHaveText('Battery · 100%');
  });

  test('energy flow: a battery drifting a few watts is idle here too', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(HYBRID));
    const flow = page.locator('svg.flow');
    // -24 W is drift. Every figure on the page calls that idle, so the arm
    // must not be drawn live with an arrow and a travelling pip.
    await expect(flow).toContainText('idle');
    // Solar and grid are both carrying real power; the battery arm is the one
    // that must stay dead. Arms are drawn in node order: solar, grid, battery.
    await expect(flow.locator('.wire').nth(2)).toHaveClass(/dead/);
    await expect(flow.locator('.wire.live')).toHaveCount(2);
    await expect(flow.locator('.pip')).toHaveCount(2);
  });

  test('energy flow: an on-grid system has no battery arm at all', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    const flow = page.locator('svg.flow');
    await expect(flow.locator('.wire')).toHaveCount(2);
    await expect(flow.locator('.lbl')).toHaveText([/Solar/, /Grid/, /House load/]);
    await expect(flow).not.toContainText('Battery');
    // Exporting 5.08 kW, so the grid arm is labelled as such.
    await expect(flow).toContainText('exporting');
  });

  test('energy flow: wire thickness tracks how much power an arm carries', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    const wires = page.locator('svg.flow .wire');
    // 5.08 kW of production against 0 W of load on a 12 kW array: the solar arm
    // has to be visibly fatter than the idle one, or the picture says nothing
    // the numbers did not already say.
    const solar = Number(await wires.nth(0).getAttribute('stroke-width'));
    const grid = Number(await wires.nth(1).getAttribute('stroke-width'));
    expect(solar).toBeGreaterThan(4);
    expect(solar).toBeCloseTo(grid, 1); // both carry the same 5.08 kW
  });

  test('energy flow: says how much of the load is being self-powered', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(HYBRID));
    // 307 W of load, 91 W of it imported, so 70% is coming from the house's
    // own kit. That is the question the diagram exists to answer.
    const bar = page.locator('.flowbar');
    await expect(bar).toContainText('Self-powered right now');
    await expect(bar.locator('b')).toHaveText('70%');
  });

  test('energy flow: no self-powered claim when the load is unmeasured', async ({ page }) => {
    // An on-grid plant with no CT clamp reports 0 W of household load; there is
    // nothing to take a percentage of, so the bar stays away.
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    await expect(page.locator('.flowbar')).toHaveCount(0);
  });

  test('energy flow: an arm carrying no power is drawn dead, not live', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { ac_power_w: 0, grid_power_w: 0, load_power_w: 0 } }) });
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    // No arm is energised, so no wire is accented and no pip travels.
    await expect(page.locator('svg.flow .wire.live')).toHaveCount(0);
    await expect(page.locator('svg.flow .pip')).toHaveCount(0);
    // Dead arms are dashed as well as grey, so the state survives a screenshot
    // and does not rest on colour alone.
    await expect(page.locator('svg.flow .wire.dead')).toHaveCount(2);
  });

  test('an unknown system id does not break the page', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/nope');
    await expect(page.locator('.empty')).toContainText('Unknown system');
  });
});
