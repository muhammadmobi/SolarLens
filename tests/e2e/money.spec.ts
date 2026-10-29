/**
 * Money saved and carbon avoided, from the tariff the owner sets.
 *
 * The Worker is stubbed as everywhere in this suite; tests/unit/settings.test.ts
 * holds the routes. These hold the page's sums and its honesty: no tariff, no
 * money anywhere; a kWh used at home is worth one bought, a kWh exported earns
 * the export price or, with net metering, the import price; a period whose
 * export is unknown is marked as an upper bound; and the owner's form sends
 * exactly what was typed.
 *
 * Prices are invented, in euros so the figures format the same on any machine
 * the suite runs on (en-US: "€3.00").
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { HYBRID, NOW, devices, deviceHistory, historyRows, inverters, series } from '../fixtures/dashboard-api';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

type Tariff = { currency: string; importPrice: number; exportPrice: number; netMetering: boolean; co2KgPerKwh: number };
const TARIFF: Tariff = { currency: 'EUR', importPrice: 0.3, exportPrice: 0.1, netMetering: false, co2KgPerKwh: 0.4 };

/** The dashboard, signed in as the owner, with `tariff` stored; every write to it is noted. */
async function stub(page: Page, tariff: Tariff | null) {
  const world = { tariff, writes: [] as { method: string; body: unknown }[] };
  await page.route('**/api/latest', (r) => r.fulfill(json({ now: NOW, inverters: inverters() })));
  await page.route('**/api/series**', (r) => r.fulfill(json({ from: 0, to: NOW, points: series() })));
  await page.route('**/api/devices', (r) => r.fulfill(json({ now: NOW, devices: devices() })));
  await page.route('**/api/devices/history**', (r) => r.fulfill(json(deviceHistory())));
  await page.route('**/api/history**', (r) => r.fulfill(json({ now: NOW, days: 30, rows: historyRows() })));
  for (const path of ['**/api/alarms**', '**/api/periods', '**/api/health', '**/api/expected', '**/api/locations']) {
    await page.route(path, (r) => r.fulfill(json({ now: NOW, alarms: [], periods: [], polls: [], feeds: [], relays: [], systems: [], locations: [] })));
  }
  await page.route('**/api/settings/tariff', async (r: Route) => {
    const method = r.request().method();
    if (method === 'GET') return r.fulfill(json({ tariff: world.tariff }));
    const body = method === 'PUT' ? r.request().postDataJSON() : undefined;
    world.writes.push({ method, body });
    world.tariff = method === 'PUT' ? body : null;
    return r.fulfill(json({ tariff: world.tariff }));
  });
  await page.route('**/auth/status', (r) => r.fulfill(json({ configured: true, password: true, passkeys: 0, required: false, role: 'owner', device: 'dev-this' })));
  await page.route('**/auth/settings', (r) => r.fulfill(json({
    password: true, required: false, passkeys: [], shares: [],
    devices: [{ id: 'dev-this', role: 'owner', label: 'Chrome on Windows', created_at: NOW - 86400, last_seen_at: NOW - 60, expires_at: NOW + 86400 * 300, shared: false, this: true }],
  })));
  return world;
}

/**
 * The first refresh redraws whatever view is open once its data lands; a test
 * waits for that before typing, or the redraw would take what it typed.
 */
async function ready(page: Page) {
  await expect(page.locator('#fleet-today')).not.toHaveText('—');
}

test.describe('money and carbon', () => {
  test('shows no money anywhere until a tariff is set, and says where to set one', async ({ page }) => {
    await stub(page, null);
    await page.goto(`/#/system/${HYBRID}`);
    await ready(page);
    await expect(page.locator('section.card', { hasText: 'Money and carbon' })).toHaveCount(0);
    await page.goto('/#/history');
    await expect(page.getByText('once the owner sets the tariff under Settings')).toBeVisible();
    await expect(page.locator('th', { hasText: 'Saved' })).toHaveCount(0);
  });

  test("values a system's day: what it used at the import price, what it sold at the export price", async ({ page }) => {
    await stub(page, TARIFF);
    await page.goto(`/#/system/${HYBRID}`);
    const card = page.locator('section.card', { hasText: 'Money and carbon' });
    // Today: 13.7 kWh made, 10.7 of it sold. 3.0 × 0.30 + 10.7 × 0.10 = 1.97; CO₂ 13.7 × 0.4 = 5.48 kg.
    await expect(card.locator('dt', { hasText: 'Today' }).locator('+ dd')).toContainText('€1.97');
    await expect(card.locator('dt', { hasText: 'Today' }).locator('+ dd')).toContainText('5.5 kg CO₂ avoided');
    // Lifetime: 7450.8 made, 4686.7 sold. 2764.1 × 0.30 + 4686.7 × 0.10 = 1297.9, shown whole.
    await expect(card.locator('dt', { hasText: 'Lifetime' }).locator('+ dd')).toContainText('€1,298');
    await expect(card.locator('dt', { hasText: 'Lifetime' }).locator('+ dd')).toContainText('2.98 t CO₂');
    // The month's export is not known: counted at the import price, and marked.
    await expect(card.locator('dt', { hasText: 'This month' }).locator('+ dd')).toContainText('€21.27*');
    await expect(card).toContainText('an upper bound');
    await expect(card).toContainText('€0.30 for a kWh bought and €0.10 for one sold');
  });

  test('with net metering, every kWh is worth one bought, and nothing is an upper bound', async ({ page }) => {
    await stub(page, { ...TARIFF, netMetering: true });
    await page.goto(`/#/system/${HYBRID}`);
    const card = page.locator('section.card', { hasText: 'Money and carbon' });
    // 13.7 × 0.30 = 4.11.
    await expect(card.locator('dt', { hasText: 'Today' }).locator('+ dd')).toContainText('€4.11');
    await expect(card).not.toContainText('upper bound');
    await expect(card).toContainText('(net metering)');
  });

  test('adds a Saved and a CO₂ column to the history, and totals them', async ({ page }) => {
    await stub(page, TARIFF);
    await page.goto('/#/history');
    const hybrid = page.locator('details.syssec', { hasText: 'Demo Hybrid' });
    await expect(hybrid.locator('th', { hasText: 'Saved' })).toBeVisible();
    // Today's row: 13.2 made, 9.4 sold. 3.8 × 0.30 + 9.4 × 0.10 = 2.08.
    await expect(hybrid.locator('tbody tr').first()).toContainText('€2.08');
    await expect(hybrid.locator('tbody tr').first()).toContainText('5.3 kg CO₂');
    // Four days: 13.2 + 12.2 + 11.2 + 10.2 = 46.8 made, 37.6 sold → 9.2 × 0.3 + 3.76 = 6.52.
    await expect(hybrid.locator('dt', { hasText: 'Saved' }).locator('+ dd')).toHaveText('€6.52');
    // The on-grid plant reports no export: each day is marked as an upper bound.
    const solis = page.locator('details.syssec', { hasText: 'Demo Solis Plant' });
    await expect(solis.locator('tbody tr').first()).toContainText('€13.41*');
    await expect(solis).toContainText('an upper bound');
  });

  test('the owner sets the tariff from Settings, and can clear it', async ({ page }) => {
    const world = await stub(page, null);
    await page.goto('/#/settings');
    await ready(page);
    const form = page.locator('#tariff-form');
    await form.getByLabel('Currency').fill('eur');
    await form.getByLabel('A kWh bought from the grid costs').fill('0.3');
    await form.getByLabel('A kWh sold to the grid earns').fill('0.1');
    await form.getByLabel('CO₂ per kWh from the grid').fill('0.4');
    await form.getByRole('button', { name: 'Save the tariff' }).click();
    await expect(page.getByRole('status')).toContainText('Tariff saved');
    expect(world.writes).toEqual([{ method: 'PUT', body: TARIFF }]);

    // Net metering hides the export price, and sends the import price for it.
    await page.locator('#t-net').check();
    await expect(page.locator('#t-exp-row')).toBeHidden();
    await page.getByRole('button', { name: 'Save the tariff' }).click();
    await expect(page.getByRole('status')).toContainText('Tariff saved');
    expect(world.writes[1]).toEqual({ method: 'PUT', body: { ...TARIFF, netMetering: true, exportPrice: 0.3 } });

    await page.getByRole('button', { name: 'Clear it, and show no money' }).click();
    await expect(page.getByRole('status')).toContainText('Tariff cleared');
    expect(world.writes[2]).toEqual({ method: 'DELETE', body: undefined });
    await expect(page.locator('#t-cur')).toHaveValue('');
  });

  test('shows what the server refused, in its words', async ({ page }) => {
    await stub(page, TARIFF);
    await page.route('**/api/settings/tariff', (r) => r.request().method() === 'PUT'
      ? r.fulfill(json({ error: 'The price of a kWh bought is a number from 0 to 1000.' }, 400)) : r.fallback());
    await page.goto('/#/settings');
    await ready(page);
    await expect(page.locator('#t-cur')).toHaveValue('EUR');
    await page.getByRole('button', { name: 'Save the tariff' }).click();
    await expect(page.locator('#auth-err')).toHaveText('The price of a kWh bought is a number from 0 to 1000.');
  });
});

test('the same sums in the guide: it says where money saved is', async ({ page }) => {
  await stub(page, null);
  await page.goto('/#/guide');
  await expect(page.getByText('What the sun has saved, and the CO₂ it has avoided')).toBeVisible();
});
