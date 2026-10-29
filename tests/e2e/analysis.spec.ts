/**
 * The Analysis tab, favourites and groups.
 *
 * The Worker is stubbed as everywhere in this suite; tests/unit/settings.test.ts
 * holds the groups route. These hold the page: a day's energy worked out hour
 * by hour from the power samples, made against used, the peaks, an earlier day
 * fetched when asked for; a star that puts a system first; and the owner's
 * groups laying the Overview out under headings, with a filter for each.
 *
 * The samples are flat on purpose, so every figure can be worked out by hand:
 * the hybrid makes 2 kW and the house uses 0.5 kW from 08:00 to 12:00, then
 * the house uses 1.5 kW from 18:00 to 20:00 with nothing made. Four hours of
 * 2 kWh made, 0.5 kWh used; two of 1.5 kWh used.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { HYBRID, NOW, SOLIS, devices, deviceHistory, historyRows, inverters } from '../fixtures/dashboard-api';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** The flat day described above, `back` days ago, every five minutes, for the hybrid. */
function flatDay(back = 0) {
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - back);
  const t0 = Math.floor(start.getTime() / 1000);
  const points: unknown[] = [];
  const add = (from: number, to: number, ac: number, load: number) => {
    for (let t = t0 + from * 3600; t <= t0 + to * 3600; t += 300) {
      points.push({ inverter_id: HYBRID, ts: t, ac_power_w: ac, today_kwh: null, battery_soc: null, grid_power_w: null, load_power_w: load, tz_offset_sec: null });
    }
  };
  add(8, 12, 2000, 500);
  add(18, 20, 0, 1500);
  return points;
}

async function stub(page: Page, opts: { groups?: Record<string, string>; pastFails?: boolean } = {}) {
  const world = { seriesAsked: [] as string[], groupWrites: [] as unknown[], groups: opts.groups ?? {} };
  await page.route('**/api/latest', (r) => r.fulfill(json({ now: NOW, inverters: inverters() })));
  await page.route('**/api/series**', (r: Route) => {
    const url = new URL(r.request().url());
    world.seriesAsked.push(url.search);
    if (!url.searchParams.has('from')) return r.fulfill(json({ from: 0, to: NOW, points: flatDay(0) }));
    if (opts.pastFails) return r.fulfill(json({ error: 'nope' }, 500));
    return r.fulfill(json({ from: 0, to: NOW, points: flatDay(1).map((p) => ({ ...(p as object), load_power_w: 250 })) }));
  });
  await page.route('**/api/devices', (r) => r.fulfill(json({ now: NOW, devices: devices() })));
  await page.route('**/api/devices/history**', (r) => r.fulfill(json(deviceHistory())));
  await page.route('**/api/history**', (r) => r.fulfill(json({ now: NOW, days: 30, rows: historyRows() })));
  for (const path of ['**/api/alarms**', '**/api/periods', '**/api/health', '**/api/expected', '**/api/locations']) {
    await page.route(path, (r) => r.fulfill(json({ now: NOW, alarms: [], periods: [], polls: [], feeds: [], relays: [], systems: [], locations: [] })));
  }
  await page.route('**/api/settings/groups', (r) => {
    if (r.request().method() === 'PUT') {
      const body = r.request().postDataJSON() as { groups: Record<string, string> };
      world.groupWrites.push(body);
      world.groups = Object.fromEntries(Object.entries(body.groups).filter(([, v]) => v));
    }
    return r.fulfill(json({ groups: world.groups }));
  });
  await page.route('**/auth/status', (r) => r.fulfill(json({ configured: true, password: true, passkeys: 0, required: false, role: 'owner', device: 'dev-this' })));
  await page.route('**/auth/settings', (r) => r.fulfill(json({
    password: true, required: false, passkeys: [], shares: [],
    devices: [{ id: 'dev-this', role: 'owner', label: 'Chrome on Windows', created_at: NOW - 86400, last_seen_at: NOW - 60, expires_at: NOW + 86400 * 300, shared: false, this: true }],
  })));
  return world;
}

/** The first refresh redraws the open view once its data lands; wait for it before acting. */
async function ready(page: Page) {
  await expect(page.locator('#fleet-today')).not.toHaveText('—');
}

const figure = (page: Page, name: string) => page.locator('dl.anfigs dt', { hasText: name }).locator('+ dd');

test.describe('the Analysis tab', () => {
  test("works out one system's day hour by hour: made, used, and the sun's used at home", async ({ page }) => {
    await stub(page);
    await page.goto('/#/analysis');
    await ready(page);
    await page.getByRole('button', { name: 'Demo Hybrid' }).click();
    await expect(page.locator('h2', { hasText: 'Analysis · Demo Hybrid · Today' })).toBeVisible();
    await expect(figure(page, 'Made')).toHaveText('8.00 kWh');
    await expect(figure(page, 'Used by the house')).toHaveText('5.00 kWh');
    // 0.5 kWh an hour of the sun's used at home, for four hours: a quarter of 8.
    await expect(figure(page, "Of the sun's, used at home")).toHaveText('2.00 kWh · 25% of what was made');
    await expect(figure(page, "The house's use, from the sun")).toHaveText('40%');
    await expect(figure(page, 'Best hour')).toHaveText('08:00–09:00 · 2.00 kWh');
    await expect(figure(page, 'Peak output')).toHaveText('2.00 kW at 08:00');
    await expect(figure(page, 'Peak draw')).toHaveText('1.50 kW at 18:00');

    // The table has only the hours something happened in.
    const rows = page.locator('section.card', { hasText: 'Hour by hour' }).locator('tbody tr');
    await expect(rows).toHaveCount(6);
    await expect(rows.first()).toHaveText(/08:00\s*2\.00 kWh\s*0\.50 kWh\s*0\.50 kWh\s*1\.50 kWh\s*0\.00 kWh/);
    await expect(rows.first()).toHaveClass('besthour');
    await expect(rows.last()).toHaveText(/19:00\s*0\.00 kWh\s*1\.50 kWh\s*0\.00 kWh\s*0\.00 kWh\s*1\.50 kWh/);

    // Four bars, and the house's use drawn across them.
    await expect(page.locator('#anchart rect.daybar')).toHaveCount(4);
    await expect(page.locator('#anchart path.usedline')).toHaveCount(1);
    await expect(page.locator('#anchart')).toHaveAttribute('aria-label', /8\.00 kWh made, 5\.00 kWh used, most in the hour from 08:00/);
  });

  test('adds every system up, lists each one\'s peaks, and names one with no house load', async ({ page }) => {
    await stub(page);
    await page.goto('/#/analysis');
    await ready(page);
    await expect(page.locator('h2', { hasText: 'Analysis · All systems · Today' })).toBeVisible();
    await expect(figure(page, 'Made')).toHaveText('8.00 kWh');
    // The on-grid plant made nothing in this stub, and meters no load.
    const peaks = page.locator('section.card', { hasText: 'Peaks, system by system' }).locator('tbody tr');
    await expect(peaks).toHaveCount(2);
    await expect(peaks.filter({ hasText: 'Demo Solis Plant' })).toContainText('not metered');
    await expect(peaks.filter({ hasText: 'Demo Hybrid' })).toContainText('2.00 kW at 08:00');
    await expect(page.locator('.cardnote', { hasText: 'Demo Solis Plant reports no house load' })).toBeVisible();
  });

  test('fetches an earlier day when it is asked for, and only once', async ({ page }) => {
    const world = await stub(page);
    await page.goto('/#/analysis');
    await ready(page);
    await page.getByRole('button', { name: 'Demo Hybrid' }).click();
    await page.getByRole('button', { name: 'Yesterday' }).click();
    await expect(page.locator('h2', { hasText: 'Demo Hybrid · Yesterday' })).toBeVisible();
    // Yesterday's house drew a flat 250 W: 1 kWh in the morning, 0.5 in the evening.
    await expect(figure(page, 'Used by the house')).toHaveText('1.50 kWh');
    const asked = world.seriesAsked.filter((q) => q.includes('from='));
    expect(asked).toHaveLength(1);
    const from = Number(new URLSearchParams(asked[0]).get('from'));
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0); midnight.setDate(midnight.getDate() - 1);
    expect(from).toBe(Math.floor(midnight.getTime() / 1000) - 3600);
    await page.getByRole('button', { name: 'Today' }).click();
    await page.getByRole('button', { name: 'Yesterday' }).click();
    await expect(figure(page, 'Used by the house')).toHaveText('1.50 kWh');
    expect(world.seriesAsked.filter((q) => q.includes('from='))).toHaveLength(1);
  });

  test('says so when an earlier day could not be fetched', async ({ page }) => {
    await stub(page, { pastFails: true });
    await page.goto('/#/analysis');
    await ready(page);
    await page.getByRole('button', { name: 'Yesterday' }).click();
    await expect(page.getByText('Could not load that day')).toBeVisible();
  });
});

test.describe('favourites', () => {
  test('a star on the system page puts that system first on the Overview, in this browser', async ({ page }) => {
    await stub(page);
    await page.goto('/');
    await ready(page);
    await expect(page.locator('.ovsys .ovname').first()).toHaveText('Demo Solis Plant');
    await page.goto(`/#/system/${HYBRID}`);
    await page.getByRole('button', { name: '☆ Add to favourites' }).click();
    await expect(page.locator('#favbtn')).toHaveText('★ A favourite');
    await expect(page.locator('#favbtn')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => localStorage.getItem('sl-favourites'))).toBe('["Demo Hybrid"]');

    await page.goto('/');
    await expect(page.locator('.ovsys .ovname').first()).toHaveText('★ Demo Hybrid');
    // Two systems need no filter to choose between them.
    await expect(page.locator('.ovfilter')).toHaveCount(0);

    await page.goto(`/#/system/${HYBRID}`);
    await page.locator('#favbtn').click();
    await expect(page.locator('#favbtn')).toHaveText('☆ Add to favourites');
    expect(await page.evaluate(() => localStorage.getItem('sl-favourites'))).toBe('[]');
  });
});

test.describe('groups', () => {
  test('lay the Overview out under a heading each, with a filter for each', async ({ page }) => {
    await stub(page, { groups: { [SOLIS]: 'Farm', [HYBRID]: 'Home' } });
    await page.goto('/');
    await ready(page);
    const heads = page.locator('h2.grouphead');
    await expect(heads).toHaveCount(2);
    await expect(heads.first()).toContainText('Farm');
    await expect(heads.first()).toContainText('1 system');
    await expect(heads.nth(1)).toContainText('Home');
    // Headings mean the page scrolls, so it is not fitted to one screen.
    await expect(page.locator('body')).not.toHaveClass(/ovfit/);

    await page.locator('.filterbtn', { hasText: 'Home' }).click();
    await expect(page.locator('.ovsys')).toHaveCount(1);
    await expect(page.locator('.ovsys .ovname')).toHaveText('Demo Hybrid');
    await expect(page.locator('h2.grouphead')).toHaveCount(0);
    await expect(page.locator('.filterbtn.on')).toContainText('Home');
    expect(await page.evaluate(() => localStorage.getItem('sl-ovfilter'))).toBe('g:Home');

    // Remembered across a reload, and back to everything with All systems.
    await page.reload();
    await expect(page.locator('.ovsys')).toHaveCount(1);
    await page.locator('.filterbtn', { hasText: 'All systems' }).click();
    await expect(page.locator('.ovsys')).toHaveCount(2);
  });

  test('a filter for a group that has gone falls back to every system', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('sl-ovfilter', 'g:Gone'));
    await stub(page, { groups: { [SOLIS]: 'Farm' } });
    await page.goto('/');
    await ready(page);
    await expect(page.locator('.ovsys')).toHaveCount(2);
    await expect(page.locator('.filterbtn.on')).toContainText('All systems');
    await expect(page.locator('h2.grouphead')).toHaveText([/Farm/, /Not in a group/]);
  });

  test('are set by the owner in Settings', async ({ page }) => {
    const world = await stub(page, { groups: { [SOLIS]: 'Farm' } });
    await page.goto('/#/settings');
    await ready(page);
    const form = page.locator('#groups-form');
    await expect(form.getByLabel('Demo Solis Plant')).toHaveValue('Farm');
    await form.getByLabel('Demo Hybrid').fill('Home');
    await form.getByLabel('Demo Solis Plant').fill('');
    await form.getByRole('button', { name: 'Save the groups' }).click();
    await expect(page.getByRole('status')).toContainText('Groups saved');
    expect(world.groupWrites).toEqual([{ groups: { [SOLIS]: '', [HYBRID]: 'Home' } }]);
    await page.goto('/');
    await expect(page.locator('h2.grouphead')).toHaveText([/Home/, /Not in a group/]);
  });
});
