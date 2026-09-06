import { expect, test, type Page } from '@playwright/test';

/**
 * The dashboard is a static page that talks to /api/*. These tests stub those
 * endpoints so the suite needs no Worker, D1 or vendor credentials, and they
 * assert what a person sees: both panels, the divider layout, the numbers,
 * the energy breakdown, staleness and the auth guidance.
 */

const NOW = Math.floor(Date.now() / 1000);

const metrics = (o: Record<string, unknown>) => JSON.stringify(o);

function inverters(overrides: Partial<Record<'solis' | 'solarman', Record<string, unknown>>> = {}) {
  return [
    {
      id: 'soliscloud:station:1', provider: 'soliscloud', serial: 'DEMO01', name: 'Demo Solis Plant',
      plant_name: 'Demo Solis Plant', capacity_w: 12000, display_order: 0,
      ts: NOW - 120, source: 'soliscloud', ac_power_w: 5080, dc_power_w: null, today_kwh: 49, total_kwh: 48852,
      battery_soc: null, battery_power_w: null, grid_power_w: -5080, load_power_w: null, temp_c: null, status: 'online',
      metrics: metrics({ genMonthKwh: 185, genYearKwh: 13677, genTotalKwh: 48852, loadTodayKwh: 49, loadTotalKwh: 48852,
        gridImportTodayKwh: 0, gridExportTodayKwh: 0, gridImportTotalKwh: 0, gridExportTotalKwh: 0,
        battChargeTodayKwh: null, battDischargeTodayKwh: null, battChargeTotalKwh: null, battDischargeTotalKwh: null,
        selfUseTodayKwh: null, batteryStatus: null, gridStatus: null }),
      ...(overrides.solis ?? {}),
    },
    {
      id: 'solarman:station:62000000', provider: 'solarman', serial: null, name: 'Demo Hybrid',
      plant_name: 'Demo Hybrid', capacity_w: 3500, display_order: 0,
      ts: NOW - 200, source: 'solarman-web', ac_power_w: 278, dc_power_w: null, today_kwh: 13.7, total_kwh: 7450.8,
      battery_soc: 100, battery_power_w: -24, grid_power_w: 91, load_power_w: 307, temp_c: null, status: 'online',
      metrics: metrics({ genMonthKwh: 70.9, genYearKwh: 4002.1, genTotalKwh: 7450.8, loadTodayKwh: 4.8, loadTotalKwh: 6691.7,
        gridImportTodayKwh: 2.4, gridExportTodayKwh: 10.7, gridImportTotalKwh: 4699.2, gridExportTotalKwh: 4686.7,
        battChargeTodayKwh: 0.6, battDischargeTodayKwh: 0, battChargeTotalKwh: 1100.1, battDischargeTotalKwh: 354.3,
        selfUseTodayKwh: 3, batteryStatus: 'STATIC', gridStatus: 'PURCHASE' }),
      ...(overrides.solarman ?? {}),
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
    points.push({ inverter_id: 'soliscloud:station:1', ts, ac_power_w: Math.round(10_000 * bell), today_kwh: null, battery_soc: null, grid_power_w: null });
    points.push({ inverter_id: 'solarman:station:62000000', ts, ac_power_w: Math.round(3_000 * bell), today_kwh: null, battery_soc: null, grid_power_w: null });
  }
  return points;
}

async function stubApi(page: Page, opts: { invs?: unknown[]; status?: number; poll?: { ok: number; detail: string; provider: string } } = {}) {
  const status = opts.status ?? 200;
  const invs = opts.invs ?? inverters();
  const ids = new Set((invs as { id: string }[]).map((i) => i.id));
  const points = series().filter((p) => ids.has((p as { inverter_id: string }).inverter_id));
  await page.route('**/api/latest', (r) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? { now: NOW, inverters: invs } : { error: 'unauthorized' }) }));
  await page.route('**/api/series**', (r) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? { from: 0, to: NOW, points } : { error: 'unauthorized' }) }));
  await page.route('**/api/health', (r) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ now: NOW, polls: [opts.poll ?? { ts: NOW - 30, provider: 'solarman', ok: 1, detail: 'plants=1 inverters=1 new=1' }] }) }));
}

test.describe('SolarLens dashboard', () => {
  test('shows both inverters side by side with live numbers', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');

    const panels = page.locator('article.panel');
    await expect(panels).toHaveCount(2);
    await expect(panels.nth(0)).toContainText('SolisCloud');
    await expect(panels.nth(0)).toContainText('Demo Solis Plant');
    await expect(panels.nth(0).locator('.hero .val')).toHaveText('5.08');
    await expect(panels.nth(0).locator('.hero .unit')).toHaveText('kW');
    await expect(panels.nth(0)).toContainText('5.08 kW export');

    await expect(panels.nth(1)).toContainText('SolarMan');
    await expect(panels.nth(1)).toContainText('Demo Hybrid');
    await expect(panels.nth(1).locator('.hero .val')).toHaveText('278');
    await expect(panels.nth(1)).toContainText('91 W import');
    await expect(panels.nth(1)).toContainText('via solarman-web');
    // A few watts of battery drift renders as idle, not as discharging.
    await expect(panels.nth(1)).toContainText('idle');
    await expect(panels.nth(1).locator('.ring text')).toHaveText('100%');

    // Fleet header sums both.
    await expect(page.locator('#fleet-power')).toHaveText('5.36 kW');
    await expect(page.locator('#fleet-today')).toContainText('62.7 kWh today');
    await expect(page.locator('#poll-status')).toContainText('last poll (solarman) ok');
  });

  test('energy breakdown expands with the vendor-app figures', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    const hybrid = page.locator('article.panel').nth(1);
    const more = hybrid.locator('details.more');
    await expect(more).toBeVisible();
    await expect(more.locator('table.energy')).toBeHidden();
    await more.locator('summary').click();
    const table = more.locator('table.energy');
    await expect(table).toBeVisible();
    await expect(table).toContainText('Generation');
    await expect(table).toContainText('Grid import');
    await expect(table).toContainText('Battery charge');
    // Row: Generation -> today / month / year / lifetime
    const gen = table.locator('tbody tr', { hasText: 'Generation' });
    await expect(gen.locator('td').nth(1)).toHaveText('13.7 kWh');
    await expect(gen.locator('td').nth(2)).toHaveText('70.9 kWh');
    await expect(gen.locator('td').nth(3)).toHaveText('4002 kWh');
    await expect(gen.locator('td').nth(4)).toHaveText('7451 kWh');
    await expect(more.locator('.chip', { hasText: 'grid: purchase' })).toBeVisible();
    await expect(more.locator('.chip', { hasText: 'battery: static' })).toBeVisible();
  });

  test('renders the divider layout: side by side on desktop, stacked on narrow screens', async ({ page }, testInfo) => {
    await stubApi(page);
    await page.goto('/');
    const [a, b] = await page.locator('article.panel').all();
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
    const solis = page.locator('article.panel').nth(0);
    await expect(solis.locator('.stale')).toContainText('last sample');
    await expect(solis.locator('.badge')).toHaveClass(/warn/);
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
    await stubApi(page, { invs: [] });
    await page.goto('/');
    await expect(page.locator('.empty')).toContainText('No inverters yet');
    await expect(page.locator('#combined')).toContainText('No samples yet today');
  });
});
