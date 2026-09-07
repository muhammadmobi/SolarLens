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
        weatherText: 'Clear', tempNowC: 29, tempMinC: 24, tempMaxC: 31, sunrise: '05:45', sunset: '18:25' }),
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

async function stubApi(page: Page, opts: {
  invs?: unknown[]; devs?: unknown[]; status?: number;
  poll?: { ok: number; detail: string; provider: string };
} = {}) {
  const status = opts.status ?? 200;
  const invs = opts.invs ?? inverters();
  const devs = opts.devs ?? devices();
  const ids = new Set((invs as { id: string }[]).map((i) => i.id));
  const points = series().filter((p) => ids.has((p as { inverter_id: string }).inverter_id));
  const json = (body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/latest', (r) => r.fulfill(json(status === 200 ? { now: NOW, inverters: invs } : { error: 'unauthorized' })));
  await page.route('**/api/series**', (r) => r.fulfill(json(status === 200 ? { from: 0, to: NOW, points } : { error: 'unauthorized' })));
  await page.route('**/api/devices', (r) => r.fulfill(json(status === 200 ? { now: NOW, devices: devs } : { error: 'unauthorized' })));
  await page.route('**/api/health', (r) => r.fulfill(json({ now: NOW, polls: [opts.poll ?? { ts: NOW - 30, provider: 'solarman', ok: 1, detail: 'plants=1 inverters=1 new=1' }] })));
}

test.describe('Overview', () => {
  test('shows both inverters side by side with live numbers', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');

    const panels = page.locator('a.sys');
    await expect(panels).toHaveCount(2);
    await expect(panels.nth(0)).toContainText('SolisCloud');
    await expect(panels.nth(0)).toContainText('Demo Solis Plant');
    await expect(panels.nth(0).locator('.hero .val')).toHaveText('5.08');
    await expect(panels.nth(0).locator('.hero .unit')).toHaveText('kW');
    await expect(panels.nth(0)).toContainText('5.08 kW');

    await expect(panels.nth(1)).toContainText('SolarMan');
    await expect(panels.nth(1).locator('.hero .val')).toHaveText('278');
    await expect(panels.nth(1)).toContainText('91 W');
    // A few watts of battery drift renders as idle, not as discharging.
    await expect(panels.nth(1)).toContainText('idle');
    await expect(panels.nth(1).locator('.ring text')).toHaveText('100%');

    await expect(page.locator('#fleet-power')).toHaveText('5.36 kW');
    // The word "today" is now a label above the figure, not part of it.
    await expect(page.locator('#fleet-today')).toHaveText('62.7 kWh');
    // Every headline figure is labelled - a bare "20 W" told you nothing about
    // whether it was one system, both, or something else entirely.
    await expect(page.locator('.flabel')).toHaveText(['Producing now', 'Produced today', 'Consumed today', 'Weather']);
    await expect(page.locator('#fleet-used')).toHaveText('53.8 kWh');
    await expect(page.locator('#fleet-wx')).toContainText('Clear');
    await expect(page.locator('#poll-status')).toContainText('last poll (solarman) ok');
  });

  test('only the hybrid shows a battery ring; the on-grid plant has none', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(page.locator('a.sys').nth(0).locator('.batt')).toHaveCount(0);
    await expect(page.locator('a.sys').nth(1).locator('.batt')).toHaveCount(1);
  });

  test('renders the divider layout: side by side on desktop, stacked on narrow screens', async ({ page }, testInfo) => {
    await stubApi(page);
    await page.goto('/');
    const [a, b] = await page.locator('a.sys').all();
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

  test('flags an inverter whose newest sample is older than 15 minutes', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 3600 } }) });
    await page.goto('/');
    const solis = page.locator('a.sys').nth(0);
    await expect(solis.locator('.freshness')).toContainText('last sample');
    await expect(solis.locator('.pill')).toHaveClass(/warn/);
  });

  test('surfaces a failed poll in the footer', async ({ page }) => {
    await stubApi(page, { poll: { ts: NOW - 60, provider: 'soliscloud', ok: 0, detail: 'soliscloud: HTTP 401 on /v1/api/userStationList' } });
    await page.goto('/');
    await expect(page.locator('#poll-status')).toContainText('FAILED');
    await expect(page.locator('#poll-status')).toContainText('HTTP 401');
  });

  test('explains the token gate when the API answers 401', async ({ page }) => {
    await stubApi(page, { status: 401 });
    await page.goto('/');
    await expect(page.locator('.empty')).toContainText('/auth?t=');
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
    const batt = page.locator('a.sys').nth(1).locator('.batt');
    await expect(batt.locator('.ring text')).toHaveText('100%');
    // A pack drifting a few watts is idle, and the heading says so.
    await expect(batt.locator('.k')).toHaveText('Battery · idle');
    await expect(batt).toContainText('Pack temperature');
    await expect(batt).toContainText('32.5 °C');
    await expect(batt).toContainText('Charged today');
    await expect(batt).toContainText('0.6 kWh');
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
  test('gives each system its own collapsible section', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/power');
    const secs = page.locator('details.syssec');
    await expect(secs).toHaveCount(2);
    // Open by default: the page is there to be read, not clicked open twice.
    await expect(secs.nth(0)).toHaveAttribute('open', '');
    await secs.nth(0).locator('> summary').click();
    await expect(secs.nth(0)).not.toHaveAttribute('open', '');
    // Collapsing one leaves the other alone.
    await expect(secs.nth(1)).toHaveAttribute('open', '');
  });
});

test.describe('Weather', () => {
  test('shows the site conditions in the header and in the diagnostics', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(page.locator('#wx-item')).toBeVisible();
    await expect(page.locator('#fleet-wx')).toHaveText('Clear · 29° (24–31°)');

    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    const diag = page.locator('section.card', { has: page.locator('h3', { hasText: 'Status & diagnostics' }) });
    await expect(diag).toContainText('29 °C now');
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
  test('each system gets its own flow box, in its own band, before the figures', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    const bands = page.locator('h2.band');
    await expect(bands).toHaveText(['Energy flow', 'Systems', 'Today · AC output']);
    // One diagram per system, each in its own card rather than sharing one.
    await expect(page.locator('svg.flow')).toHaveCount(2);
  });

  test('the flow tab is gone and an old #/flow link lands on the overview', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(page.locator('nav a')).toHaveText(['Overview', 'Power', 'Devices']);
    await page.goto('/#/flow');
    await expect(page.locator('h2.band').first()).toHaveText('Energy flow');
  });

  test('a flow box opens that system detail', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await page.locator('a.flowlink').first().click();
    await expect(page).toHaveURL(/#\/system\//);
    await expect(page.locator('.card h3')).toContainText(['Identity & hardware']);
  });

  test('clicking a system card still opens its detail', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await page.locator('a.sys').nth(0).click();
    await expect(page).toHaveURL(/#\/system\//);
  });
});
test.describe('AC output page', () => {
  test('the overview splits the chart per system instead of merging them', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    // Overlapping curves hide each other, so each system gets its own box.
    await expect(page.locator('svg.combined')).toHaveCount(2);
    await expect(page.locator('#combined')).toHaveCount(0);
    const charts = page.locator('h2.band').filter({ hasText: 'AC output' })
      .locator('xpath=following-sibling::div[1]').locator('a.flowlink');
    await expect(charts).toHaveCount(2);
    await expect(charts.nth(0)).toContainText('Demo Solis Plant');
    await expect(charts.nth(1)).toContainText('Demo Hybrid');
  });

  test('has its own nav entry and draws the combined day chart', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    // The overview's chart boxes link through to the full page.
    await expect(page.locator('a.flowlink[href="#/power"]').first()).toBeVisible();
    await page.locator('nav').getByRole('link', { name: 'Power', exact: true }).click();
    await expect(page).toHaveURL(/#\/power$/);
    await expect(page.locator('#legend span')).toContainText(['Demo Solis Plant', 'Demo Hybrid', 'Fleet total']);
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
    await page.locator('a.sys').nth(0).click();
    await expect(page).toHaveURL(/#\/system\//);
    await expect(page.locator('.sys-name')).toContainText('Demo Solis Plant');
    await page.locator('a.back').click();
    await expect(page.locator('a.sys')).toHaveCount(2);
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
    await expect(page.locator('.blocks')).toContainText('This month');
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

  test('energy flow: the hybrid draws all four arms, with directions from the signs', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(HYBRID));
    const flow = page.locator('svg.flow');
    await expect(flow).toBeVisible();
    await expect(flow.locator('.lbl')).toHaveText([/Production/, /Grid/, /Battery/, /Consumption/]);
    // 91 W import, 278 W production, 307 W load, battery idle at -24 W.
    await expect(flow).toContainText('278 W');
    await expect(flow).toContainText('91 W');
    await expect(flow).toContainText('307 W');
    await expect(flow.locator('.wire')).toHaveCount(4);
  });

  test('energy flow: an on-grid system has no battery arm at all', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    const flow = page.locator('svg.flow');
    await expect(flow.locator('.wire')).toHaveCount(3);
    await expect(flow.locator('.lbl')).toHaveText([/Production/, /Grid/, /Consumption/]);
    await expect(flow).not.toContainText('Battery');
    // Exporting 5.08 kW, so the grid arm is labelled as such.
    await expect(flow).toContainText('exporting');
  });

  test('energy flow: an arm carrying no power is drawn dead, not live', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { ac_power_w: 0, grid_power_w: 0, load_power_w: 0 } }) });
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    // No arm is energised, so no wire is accented and no pip travels.
    await expect(page.locator('svg.flow .wire.live')).toHaveCount(0);
    await expect(page.locator('svg.flow .pip')).toHaveCount(0);
  });

  test('an unknown system id does not break the page', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/nope');
    await expect(page.locator('.empty')).toContainText('Unknown system');
  });
});
