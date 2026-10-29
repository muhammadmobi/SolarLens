/**
 * Any number of systems: what changes once there are more than two.
 *
 * The dashboard was drawn for two systems on two different vendors, so two
 * things quietly assumed it: colour came from the vendor, and the overview was
 * fitted to two columns. These hold the page to what it does now - a colour per
 * system, a strip above the cards, a Compare view on a per-kWp scale, TV mode
 * taking turns, and a plant with two inverters showing both.
 */
import { expect, test, type Page } from '@playwright/test';
import { NOW, deviceHistory, devices, inverters, series } from '../fixtures/dashboard-api';

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/**
 * `n` systems: the two fixture systems, then copies of the SolarMan hybrid -
 * same vendor, different size and output - so that colour cannot come from the
 * vendor and still tell them apart.
 */
function fleet(n: number) {
  const [a, b] = inverters();
  const out = [a, b];
  for (let i = 3; i <= n; i++) {
    out.push({ ...b, id: `s${i}`, name: `Roof ${i}`, plant_name: `Roof ${i}`, capacity_w: 2000 * i, ac_power_w: 400 * i, today_kwh: 2 * i });
  }
  return out.slice(0, n);
}

async function stub(page: Page, invs: unknown[], devs: unknown[] = devices()) {
  await page.route('**/api/latest', (r) => r.fulfill(json({ now: NOW, inverters: invs })));
  await page.route('**/api/series**', (r) => r.fulfill(json({ from: 0, to: NOW, points: series() })));
  await page.route('**/api/devices', (r) => r.fulfill(json({ now: NOW, devices: devs })));
  await page.route('**/api/devices/history**', (r) => r.fulfill(json(deviceHistory())));
  for (const path of ['**/api/history**', '**/api/alarms**', '**/api/periods', '**/api/health']) {
    await page.route(path, (r) => r.fulfill(json({ now: NOW, rows: [], alarms: [], periods: [], polls: [], feeds: [], relays: [] })));
  }
}

test.describe('a colour per system', () => {
  test('two systems on the same vendor are two colours', async ({ page }) => {
    await stub(page, fleet(3));
    await page.goto('/');
    const accents = await page.locator('.ovsys').evaluateAll((els) => els.map((e) => (e as HTMLElement).style.getPropertyValue('--accent')));
    expect(accents).toEqual(['var(--sys1)', 'var(--sys2)', 'var(--sys3)']);
    // s2 and s3 are both SolarMan, and still differ.
    expect(accents[1]).not.toBe(accents[2]);
  });

  test('the same colour everywhere the system appears', async ({ page }) => {
    await stub(page, fleet(3));
    await page.goto('/#/power');
    const legend = page.locator('#legend .legitem i').nth(2);
    await expect(legend).toHaveAttribute('style', /var\(--sys3\)/);
  });

  test('comes round again after eight', async ({ page }) => {
    await stub(page, fleet(10));
    await page.goto('/');
    const ninth = await page.locator('.ovsys').nth(8).evaluate((e) => (e as HTMLElement).style.getPropertyValue('--accent'));
    expect(ninth).toBe('var(--sys1)');
  });
});

test.describe('the overview with three or more', () => {
  test('lists every system in a strip above the cards, each a link to it', async ({ page }) => {
    await stub(page, fleet(4));
    await page.goto('/');
    const strip = page.locator('nav.ovstrip a');
    await expect(strip).toHaveCount(4);
    await expect(strip.nth(3)).toContainText('Roof 4');
    await expect(strip.nth(3)).toHaveAttribute('href', '#/system/s4');
  });

  test('scrolls rather than squeezing four systems into one screen', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await stub(page, fleet(4));
    await page.goto('/');
    await expect(page.locator('.ovsys')).toHaveCount(4);
    expect(await page.evaluate(() => document.body.classList.contains('ovfit'))).toBe(false);
  });

  test('keeps two systems fitted to one screen, as before', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await stub(page, fleet(2));
    await page.goto('/');
    await expect(page.locator('.ovsys')).toHaveCount(2);
    expect(await page.evaluate(() => document.body.classList.contains('ovfit'))).toBe(true);
    await expect(page.locator('nav.ovstrip')).toHaveCount(0);
  });

  test('the header adds every system together, however many', async ({ page }) => {
    await stub(page, fleet(4));
    await page.goto('/');
    await expect(page.locator('.fitem').first()).toHaveAttribute('title', /Every system added together/);
  });
});

test.describe('Compare', () => {
  test('appears with the second system, and not before', async ({ page }) => {
    await stub(page, fleet(1));
    await page.goto('/');
    await expect(page.locator('#comparetab')).toBeHidden();
    await page.goto('/#/compare');
    await expect(page.locator('#view')).toContainText('Comparing needs two systems or more');
  });

  test('puts every system side by side, per kWp', async ({ page }) => {
    await stub(page, fleet(3));
    await page.goto('/');
    await page.locator('#comparetab').click();
    await expect(page).toHaveURL(/#\/compare$/);
    const rows = page.locator('table.cmp tbody tr');
    await expect(rows).toHaveCount(3);
    // Roof 3: 6 kW of panels, 6 kWh today - one kWh per kWp.
    await expect(rows.nth(2)).toContainText('Roof 3');
    await expect(rows.nth(2).locator('td').nth(4)).toHaveText('1.00');
    // The on-grid fixture plant: 12 kWp, 49 kWh.
    await expect(rows.nth(0).locator('td').nth(4)).toHaveText((49 / 12).toFixed(2));
  });

  test('draws bars on one scale, the best at full length', async ({ page }) => {
    await stub(page, fleet(3));
    await page.goto('/#/compare');
    const today = page.locator('section.card', { hasText: 'Today, per kWp' });
    const widths = await today.locator('.fill').evaluateAll((els) => els.map((e) => (e as HTMLElement).style.width));
    expect(Math.max(...widths.map(parseFloat))).toBe(100);
    // And drawn at that width, not only asked for: a fill that is still inline draws nothing.
    const drawn = await today.locator('.fill').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    const track = await today.locator('.track').first().evaluate((e) => e.getBoundingClientRect().width);
    expect(Math.max(...drawn)).toBeGreaterThan(track * 0.95);
    await expect(today.locator('.track').first()).toHaveAttribute('aria-label', /kWh per kWp/);
  });

  test('marks an offline system, and does not claim it is producing', async ({ page }) => {
    const invs = fleet(3);
    invs[2] = { ...invs[2], ts: NOW - 9000 };
    await stub(page, invs);
    await page.goto('/#/compare');
    const row = page.locator('table.cmp tbody tr').nth(2);
    await expect(row).toContainText('offline');
    await expect(row.locator('td').nth(2)).toHaveText('—');
  });
});

test.describe('TV mode with more systems than fit', () => {
  test('shows three at a time, takes turns, and keeps the whole fleet in the total', async ({ page }) => {
    // The start of an even twenty-second turn, so the first screenful is showing.
    await page.clock.install({ time: new Date(Math.floor((NOW * 1000) / 40_000) * 40_000 + 1000) });
    await stub(page, fleet(5));
    await page.goto('/#/tv');
    await expect(page.locator('.tvsys')).toHaveCount(3);
    await expect(page.locator('.tvpages i')).toHaveCount(2);
    await expect(page.locator('.tvhead')).toContainText('all 5 systems');
    const first = await page.locator('.tvsys .tvname span').first().textContent();
    await page.clock.runFor(21_000);
    await expect(page.locator('.tvsys')).toHaveCount(2);
    expect(await page.locator('.tvsys .tvname span').first().textContent()).not.toBe(first);
  });

  test('shows two or three systems on one screen, with no turns', async ({ page }) => {
    await stub(page, fleet(3));
    await page.goto('/#/tv');
    await expect(page.locator('.tvsys')).toHaveCount(3);
    await expect(page.locator('.tvpages')).toHaveCount(0);
  });
});

test('a plant with two inverters shows both', async ({ page }) => {
  const devs = devices();
  const second = { ...devs.find((d) => d.id === 's1-inverter-1')!, id: 's1-inverter-2', sn: '••••MO02', model: 'S5-GR3P5K', temp_c: 38.2 };
  await stub(page, fleet(2), [...devs, second]);
  await page.goto('/#/system/s1');
  const head = page.locator('h3.subhead');
  await expect(head).toHaveText('Inverter 2 of 2');
  const block = head.locator('xpath=following-sibling::div[1]');
  await expect(block).toContainText('S5-GR3P5K');
  await expect(block).toContainText('••••MO02');
  await expect(block).toContainText('38.2 °C');
});
