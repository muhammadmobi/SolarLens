/**
 * The Ask tab, and "Why?" on Historical Data.
 *
 * The Worker is stubbed as everywhere in this suite; tests/unit/ask.test.ts,
 * tools.test.ts and agents.test.ts hold the model's lead, the tools and the
 * agents. These hold the page: a question sent as typed, and its answer shown
 * with its evidence - the figures, the period, how fresh the data was and who
 * worded it; the examples; what someone who cannot ask is told, and why; the
 * weekly report and each system's health; "Why?" beside a low day, answered
 * from the figures alone for someone not signed in; and a model's words kept
 * as text, never markup.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { HYBRID, NOW, devices, deviceHistory, inverters, series } from '../fixtures/dashboard-api';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

/** What the Worker answers a question with, in the shape src/ask.ts gives it. */
function answer(over: Record<string, unknown> = {}) {
  return {
    question: 'How much did I export last week?', tool: 'energy', args: { range: 'last_week', measure: 'exported' },
    answer: 'Your systems sold 35 kWh to the grid last week, 21 – 27 Sep 2026.', worded: 'model', used: 3, limit: 100, model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    result: {
      tool: 'energy', title: 'Energy per day', period: { from: '2026-09-21', to: '2026-09-27', label: 'last week (21 – 27 Sep 2026)' },
      columns: ['Day', 'Made (kWh)', 'Sold (kWh)'],
      rows: [['Mon 21 Sep 2026', 13.2, 5], ['Tue 22 Sep 2026', 1234.5, 5]],
      facts: { total_exported_kwh: 35 }, notes: ['Demo Solis Plant does not report what was sold.'],
      summary: 'Your systems sold 35 kWh to the grid last week (21 – 27 Sep 2026).',
      freshness: { newest: NOW - 120, offline: ['Demo Solis Plant'] },
    },
    ...over,
  };
}

interface World {
  status: Record<string, unknown>;
  agents: unknown;
  asked: unknown[];
  toolsAsked: string[];
  reply: { status: number; body: unknown };
}

async function stub(page: Page, over: Partial<World> = {}): Promise<World> {
  const world: World = {
    status: { available: true, model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', used: 2, limit: 100, can_ask: true },
    agents: {
      weekly: { kind: 'weekly', week_of: '2026-09-28', title: 'Week of 21 Sep 2026', body: 'A steady week: 224 kWh, about the same as the week before.', worded: 'model', flagged: false, created_at: NOW - 3600 },
      health: [
        { kind: 'health', system: 's1', name: 'Demo Solis Plant', week_of: '2026-09-28', title: 't', body: 'Demo Solis Plant: steady (performance ratio 0.8 over the last 4 weeks, against 0.8 in the 8 before).', worded: 'solarlens', flagged: false, created_at: NOW - 3600, data: { verdict: 'steady', weekly: [0.8, 0.81, 0.79, 0.8, 0.8, 0.82, 0.8, 0.79, 0.8, 0.81, 0.8, 0.8] } },
        { kind: 'health', system: HYBRID, name: 'Demo Hybrid', week_of: '2026-09-28', title: 't', body: 'Demo Hybrid: for its sunlight it is making 20% less - worth a look for dirt, shade or a string down.', worded: 'solarlens', flagged: true, created_at: NOW - 3600, data: { verdict: 'declining', weekly: [0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.64, 0.64, 0.64, 0.64] } },
      ],
    },
    asked: [], toolsAsked: [],
    reply: { status: 200, body: answer() },
    ...over,
  };
  await page.route('**/api/latest', (r) => r.fulfill(json({ now: NOW, inverters: inverters() })));
  await page.route('**/api/series**', (r) => r.fulfill(json({ from: 0, to: NOW, points: series() })));
  await page.route('**/api/devices', (r) => r.fulfill(json({ now: NOW, devices: devices() })));
  await page.route('**/api/devices/history**', (r) => r.fulfill(json(deviceHistory())));
  // Four days of the hybrid, the third of them low.
  await page.route('**/api/history**', (r) => r.fulfill(json({ now: NOW, days: 30, rows: [13.2, 12.2, 3, 10.2].map((kwh, n) => ({
    inverter_id: HYBRID, day: day(n), yield_kwh: kwh, peak_w: 2850, load_kwh: 5.3, import_kwh: 2.2, export_kwh: 1, batt_charge_kwh: null,
    batt_discharge_kwh: null, soc_min: null, soc_max: null, samples: 140, first_ts: NOW - 86400, last_ts: NOW })) })));
  for (const path of ['**/api/alarms**', '**/api/periods', '**/api/health', '**/api/expected', '**/api/locations']) {
    await page.route(path, (r) => r.fulfill(json({ now: NOW, alarms: [], periods: [], polls: [], feeds: [], relays: [], systems: [], locations: [] })));
  }
  await page.route('**/api/ask/status', (r) => r.fulfill(json(world.status)));
  await page.route('**/api/agents', (r) => r.fulfill(json(world.agents)));
  await page.route('**/api/ask', (r: Route) => {
    world.asked.push(r.request().postDataJSON());
    return r.fulfill(json(world.reply.body, world.reply.status));
  });
  await page.route('**/api/tools/**', (r) => {
    world.toolsAsked.push(new URL(r.request().url()).pathname + new URL(r.request().url()).search);
    return r.fulfill(json({ args: {}, result: { ...answer().result, tool: 'day_report', title: 'Explained', summary: 'Demo Hybrid made 3 kWh, 25% of a usual day: less sun.', rows: [] } }));
  });
  return world;
}

async function ready(page: Page) {
  await expect(page.locator('#fleet-today')).not.toHaveText('—');
  await expect(page.locator('#askq')).toBeVisible();
}

test.describe('asking', () => {
  test('sends the question as typed, and shows the answer with its figures, period, freshness, and who worded it', async ({ page }) => {
    const world = await stub(page);
    await page.goto('/#/ask');
    await ready(page);
    await expect(page.getByText('98 of 100 model calls left today')).toBeVisible();
    await page.locator('#askq').fill('How much did I export last week?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    const card = page.locator('section.answer').first();
    await expect(card.locator('.said')).toHaveText('Your systems sold 35 kWh to the grid last week, 21 – 27 Sep 2026.');
    await expect(card.locator('.asked')).toHaveText('How much did I export last week?');
    await expect(card.locator('.by')).toContainText('Worded by the model from the figures below, which SolarLens worked out.');
    await expect(card.locator('.by')).toContainText('Covers last week (21 – 27 Sep 2026).');
    await expect(card.locator('.by')).toContainText('not reporting now: Demo Solis Plant');
    await expect(card.locator('.evidence tbody tr')).toHaveCount(2);
    await expect(card.locator('.evidence tbody tr').nth(1)).toContainText(/1,234\.5|1234\.5/);
    await expect(card.locator('.asknotes li')).toHaveText(['Demo Solis Plant does not report what was sold.']);
    await expect(page.getByText('97 of 100 model calls left today')).toBeVisible();
    expect(world.asked).toEqual([{ question: 'How much did I export last week?' }]);
  });

  test('asks an example with one tap', async ({ page }) => {
    const world = await stub(page);
    await page.goto('/#/ask');
    await ready(page);
    await page.getByRole('button', { name: 'Why was yesterday low?' }).click();
    await expect(page.locator('section.answer')).toHaveCount(1);
    expect(world.asked).toEqual([{ question: 'Why was yesterday low?' }]);
  });

  test("shows the Worker's refusal as it gave it, and keeps the figures' own words when the model's were set aside", async ({ page }) => {
    const world = await stub(page, { reply: { status: 429, body: { error: "Today's 100 model calls are used up; asking starts again at midnight UTC." } } });
    await page.goto('/#/ask');
    await ready(page);
    await page.locator('#askq').fill('And the week before?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.locator('section.answer .autherr')).toHaveText("Today's 100 model calls are used up; asking starts again at midnight UTC.");
    world.reply = { status: 200, body: answer({ worded: 'solarlens', answer: 'Your systems sold 35 kWh to the grid last week (21 – 27 Sep 2026).' }) };
    await page.locator('#askq').fill('How much did I export?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.locator('section.answer').first().locator('.by')).toContainText("In SolarLens's own words, from the figures below.");
  });

  test('keeps a reply as text, never markup', async ({ page }) => {
    await stub(page, { reply: { status: 200, body: answer({ answer: '<img src=x onerror="window.pwned=1">Made 35 kWh.' }) } });
    await page.goto('/#/ask');
    await ready(page);
    await page.locator('#askq').fill('How much?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.locator('section.answer .said')).toHaveText('<img src=x onerror="window.pwned=1">Made 35 kWh.');
    await expect(page.locator('section.answer img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
  });

  test('tells someone not signed in why they cannot ask, and a server with no model what still works', async ({ page }) => {
    const world = await stub(page, { status: { available: true, model: 'm', used: 0, limit: 100, can_ask: false } });
    await page.goto('/#/ask');
    await expect(page.locator('#fleet-today')).not.toHaveText('—');
    await expect(page.locator('#askq')).toBeDisabled();
    await expect(page.getByText(/Sign in to ask: each question spends model calls/)).toBeVisible();
    world.status = { available: false, model: null, used: 0, limit: 100, can_ask: true };
    await page.evaluate(() => { location.hash = '#/'; });
    await page.reload();
    await page.goto('/#/ask');
    await expect(page.getByText(/Questions in words need Workers AI/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Which month produced the most this year?' })).toBeDisabled();
  });
});

test.describe('the report and the health check', () => {
  test("show the week's report, and each system's health with its weeks", async ({ page }) => {
    await stub(page);
    await page.goto('/#/ask');
    await ready(page);
    const report = page.locator('section.card', { has: page.locator('h2', { hasText: "This week's report" }) });
    await expect(report.locator('.said')).toHaveText('A steady week: 224 kWh, about the same as the week before.');
    await expect(report.locator('.by')).toContainText('Written by the model');
    const rows = page.locator('.healthrow');
    await expect(rows).toHaveCount(2);
    await expect(rows.first().locator('.pill')).toHaveText('steady');
    await expect(rows.nth(1).locator('.pill')).toHaveText('declining');
    await expect(rows.nth(1).locator('.pill')).toHaveClass(/warn/);
    await expect(rows.nth(1).locator('svg.ratiospark path')).toHaveCount(1);
    await expect(rows.nth(1)).toContainText('making 20% less');
  });

  test('say when nothing has been written yet', async ({ page }) => {
    await stub(page, { agents: { weekly: null, health: [] } });
    await page.goto('/#/ask');
    await ready(page);
    await expect(page.getByText('The first report is written on Monday morning.')).toBeVisible();
    await expect(page.getByText('The first check runs on Monday morning.')).toBeVisible();
  });
});

test.describe('why was this day low?', () => {
  test('is a button beside a low day on Historical Data, answered on the Ask tab', async ({ page }) => {
    const world = await stub(page, { reply: { status: 200, body: answer({ question: null, tool: 'day_report', worded: 'model', answer: 'Demo Hybrid made 3 kWh: less sun.' }) } });
    await page.goto('/#/history');
    await expect(page.locator('#fleet-today')).not.toHaveText('—');
    const buttons = page.getByRole('button', { name: 'Why?' });
    await expect(buttons).toHaveCount(1);
    await buttons.click();
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(page.locator('section.answer .said')).toHaveText('Demo Hybrid made 3 kWh: less sun.');
    expect(world.asked).toEqual([{ tool: 'day_report', args: { date: day(2), system: 'Demo Hybrid' } }]);
  });

  test("answers someone not signed in from the figures alone, with no model", async ({ page }) => {
    const world = await stub(page, { reply: { status: 401, body: { error: 'signin' } }, status: { available: true, model: 'm', used: 0, limit: 100, can_ask: false } });
    await page.goto('/#/history');
    await expect(page.locator('#fleet-today')).not.toHaveText('—');
    await page.getByRole('button', { name: 'Why?' }).click();
    await expect(page.locator('section.answer .said')).toHaveText('Demo Hybrid made 3 kWh, 25% of a usual day: less sun.');
    await expect(page.locator('section.answer .by')).toContainText("In SolarLens's own words");
    expect(world.toolsAsked).toEqual([`/api/tools/day_report?date=${day(2)}&system=Demo+Hybrid`]);
  });
});

test('the guide says where to ask', async ({ page }) => {
  await stub(page);
  await page.goto('/#/guide');
  await expect(page.getByText('Ask a question in words')).toBeVisible();
  await expect(page.getByText('Why was a day low?')).toBeVisible();
  await expect(page.getByText('Whether a system is slowly making less')).toBeVisible();
});
