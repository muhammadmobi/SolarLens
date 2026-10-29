/**
 * Output against the weather, the battery's capacity over time, and the site map.
 *
 * The Worker is stubbed as everywhere in this suite; src/expected.ts and
 * src/weather.ts are held by tests/unit/weather.test.ts. These hold the page:
 * the expected line drawn behind the real curve, the card that sets one against
 * the other, the alert when a system makes far less than its sun allowed, the
 * battery's estimated capacity on the History tab, and the owner's map - drawn
 * here by a stand-in for Leaflet, so no test reaches a map server.
 */
import { expect, test, type Page } from '@playwright/test';
import { HYBRID, NOW, SOLIS, deviceHistory, devices, historyRows, inverters, series } from '../fixtures/dashboard-api';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Today's expected output for the SolisCloud fixture plant: a clear-sky bell up to now. */
function expected(expectedKwh = 60, over: Record<string, unknown> = {}) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const t0 = Math.floor(start.getTime() / 1000);
  const hours = Array.from({ length: 12 }, (_, i) => ({ ts: t0 + (7 + i) * 3600, expected_w: Math.round(9000 * Math.sin((Math.PI * (i + 0.5)) / 12)) }))
    .filter((h) => h.ts <= NOW);
  return { now: NOW, systems: [{ inverter_id: SOLIS, ratio: 0.81, learned: true, days: 9, sun_kwh_m2: 6.2, expected_kwh: expectedKwh, hours, ...over }] };
}

async function stub(page: Page, opts: { expected?: unknown; invs?: unknown[]; locations?: unknown; history?: unknown[] } = {}) {
  await page.route('**/api/latest', (r) => r.fulfill(json({ now: NOW, inverters: opts.invs ?? inverters() })));
  await page.route('**/api/series**', (r) => r.fulfill(json({ from: 0, to: NOW, points: series() })));
  await page.route('**/api/devices', (r) => r.fulfill(json({ now: NOW, devices: devices() })));
  await page.route('**/api/devices/history**', (r) => r.fulfill(json(deviceHistory())));
  await page.route('**/api/history**', (r) => r.fulfill(json({ now: NOW, days: 30, rows: opts.history ?? historyRows() })));
  await page.route('**/api/expected', (r) => r.fulfill(json(opts.expected ?? expected())));
  await page.route('**/api/locations', (r) => r.fulfill(opts.locations === undefined ? json({ error: 'owner only' }, 401) : json(opts.locations)));
  for (const path of ['**/api/alarms**', '**/api/periods', '**/api/health']) {
    await page.route(path, (r) => r.fulfill(json({ now: NOW, alarms: [], periods: [], polls: [], feeds: [], relays: [] })));
  }
}

test.describe('against the weather', () => {
  test('draws the expected output dashed, behind the real curve', async ({ page }) => {
    await stub(page);
    await page.goto('/');
    // Only the SolisCloud plant has weather in this stub, so only its card has the line.
    const line = page.locator('.ovsys').first().locator('path.expline');
    await expect(page.locator('.ovsys').nth(1).locator('path.expline')).toHaveCount(0);
    await expect(line).toHaveCount(1);
    await expect(line).toHaveAttribute('stroke-dasharray', '6 5');
    await expect(line.locator('title')).toHaveText('Expected from the sunlight');
  });

  test('sets what was made against what the sun allowed', async ({ page }) => {
    await stub(page, { expected: expected(60) });
    await page.goto(`/#/system/${SOLIS}`);
    const card = page.locator('section.card', { hasText: 'Against the weather' });
    await expect(card).toContainText('6.20 kWh/m²');
    await expect(card).toContainText('60.0 kWh');
    await expect(card).toContainText('49.0 kWh');   // the fixture's today
    await expect(card).toContainText('82%');
    await expect(card).toContainText('0.81 · learned from 9 sunny days');
  });

  test('says when it is going by a typical system', async ({ page }) => {
    await stub(page, { expected: expected(60, { learned: false, ratio: 0.8, days: 1 }) });
    await page.goto(`/#/system/${SOLIS}`);
    await expect(page.locator('section.card', { hasText: 'Against the weather' })).toContainText('a typical one');
  });

  test('raises an alert when a system makes far less than its sun allowed', async ({ page }) => {
    await stub(page, { expected: expected(100) });
    await page.goto('/#/alerts');
    const sec = page.locator('details.syssec').nth(0);
    await expect(sec).toContainText('Making far less than the sunlight allows');
    await expect(sec).toContainText('49.0 kWh so far today, against 100 kWh expected');
  });

  test('stays quiet when the output is near what was expected', async ({ page }) => {
    await stub(page, { expected: expected(55) });
    await page.goto('/#/alerts');
    await expect(page.locator('details.syssec').nth(0)).not.toContainText('far less than the sunlight');
  });

  test('stays quiet about an offline system: that is its own alert', async ({ page }) => {
    await stub(page, { expected: expected(100), invs: inverters({ solis: { ts: NOW - 9000 } }) });
    await page.goto('/#/alerts');
    const sec = page.locator('details.syssec').nth(0);
    await expect(sec).toContainText('System offline');
    await expect(sec).not.toContainText('far less than the sunlight');
  });

  test('shows nothing of it for a system with no weather yet', async ({ page }) => {
    await stub(page, { expected: { now: NOW, systems: [] } });
    await page.goto('/');
    await expect(page.locator('.ovsys').first()).toBeVisible();
    await expect(page.locator('path.expline')).toHaveCount(0);
    await page.goto(`/#/system/${SOLIS}`);
    await expect(page.locator('.blocks').first()).toBeVisible();
    await expect(page.locator('section.card', { hasText: 'Against the weather' })).toHaveCount(0);
  });
});

test.describe("the battery's capacity", () => {
  test('is estimated on the History tab from days with a real swing', async ({ page }) => {
    // Eight days: 6 kWh in, from 40% to 100% - about 10 kWh held.
    const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
    const rows = Array.from({ length: 8 }, (_, n) => ({
      inverter_id: HYBRID, day: day(n), yield_kwh: 12, peak_w: 2800, load_kwh: 5, import_kwh: 2, export_kwh: 9,
      batt_charge_kwh: 6, batt_discharge_kwh: 5.5, soc_min: 40, soc_max: 100, samples: 140, first_ts: NOW - 86400, last_ts: NOW,
    }));
    await stub(page, { history: rows });
    await page.goto('/#/history');
    const card = page.locator('section.card', { hasText: 'Battery, usable capacity' });
    await expect(card).toContainText('10.0 kWh');
    // The fixture pack: 100 Ah at 24 V is 2.4 kWh on its nameplate.
    await expect(card).toContainText('of 2.4 kWh');
    await expect(card).toContainText('8 days with a swing of 30 points or more');
  });

  test('is not guessed from too few days', async ({ page }) => {
    await stub(page, { history: (historyRows() as Record<string, unknown>[]).map((r) => ({ ...r, soc_min: 90, soc_max: 100 })) });
    await page.goto('/#/history');
    await expect(page.locator('#view table').first()).toBeVisible();
    await expect(page.locator('section.card', { hasText: 'Battery, usable capacity' })).toHaveCount(0);
  });
});

test.describe('the site map', () => {
  const places = { now: NOW, locations: [{ id: SOLIS, lat: 10.5, lng: 20.5 }, { id: HYBRID, lat: 10.51, lng: 20.52 }] };

  /** A stand-in for Leaflet that records what it was asked to draw. */
  async function fakeLeaflet(page: Page) {
    await page.addInitScript(() => {
      const calls: string[] = [];
      const chain = { addTo: () => chain, bindTooltip: () => chain };
      (window as unknown as { L: unknown; mapCalls: string[] }).mapCalls = calls;
      (window as unknown as { L: unknown }).L = {
        map: () => ({ setView: () => calls.push('setView'), fitBounds: () => calls.push('fitBounds') }),
        tileLayer: (url: string, o: { referrerPolicy: string }) => { calls.push(`tiles ${url} ${o.referrerPolicy}`); return chain; },
        circleMarker: (at: number[]) => { calls.push(`marker ${at.join(',')}`); return chain; },
      };
    });
  }

  test('is hidden from anyone who is not the owner', async ({ page }) => {
    await stub(page);
    await page.goto('/');
    await expect(page.locator('#maptab')).toBeHidden();
    await page.goto('/#/map');
    await expect(page.locator('#view')).toContainText('The map is for the signed-in owner');
  });

  test('shows the owner every system, on the map and in a list', async ({ page }) => {
    await fakeLeaflet(page);
    await stub(page, { locations: places });
    await page.goto('/');
    await page.locator('#maptab').click();
    await expect(page).toHaveURL(/#\/map$/);
    const list = page.locator('.maplist li');
    await expect(list).toHaveCount(2);
    await expect(list.first()).toContainText('Demo Solis Plant');
    await expect(list.first()).toContainText(/10.50+, 20.50+/);
    await expect(list.first().getByRole('link', { name: 'Open in OpenStreetMap' })).toHaveAttribute('href', /mlat=10.5&mlon=20.5/);
    await expect.poll(() => page.evaluate(() => (window as unknown as { mapCalls: string[] }).mapCalls)).toContain('fitBounds');
    const calls = await page.evaluate(() => (window as unknown as { mapCalls: string[] }).mapCalls);
    expect(calls.filter((c) => c.startsWith('marker'))).toEqual(['marker 10.5,20.5', 'marker 10.51,20.52']);
    // Tiles are asked for with only this site's origin as the referrer.
    expect(calls.find((c) => c.startsWith('tiles'))).toContain('strict-origin-when-cross-origin');
  });

  test('still lists the positions when the map library cannot load', async ({ page }) => {
    await page.route('https://cdnjs.cloudflare.com/**', (r) => r.abort());
    await stub(page, { locations: places });
    await page.goto('/#/map');
    await expect(page.locator('.maplist li')).toHaveCount(2);
    await expect(page.locator('#map-err')).toContainText('The map could not load');
  });
});
