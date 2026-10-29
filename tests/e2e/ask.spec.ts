/**
 * The Ask tab - the assistant's conversation - and "Why?" on Historical Data.
 *
 * The Worker is stubbed as everywhere in this suite; tests/unit/assistant.test.ts
 * and its neighbours hold the understanding, the tools and the agents. These
 * hold the page: a message sent with the conversation before it, and its answer
 * shown with its evidence - the figures, a chart where one helps, a report's
 * parts, the period, how fresh the data was and who worded it; the examples; a
 * new conversation, and one that survives a reload; a report downloaded as a
 * page of its own; what each kind of reader is told about the model; the
 * weekly report and each system's health; "Why?" beside a low day; and a
 * model's words kept as text, never markup.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { HYBRID, NOW, devices, deviceHistory, inverters, series } from '../fixtures/dashboard-api';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

const energyResult = {
  tool: 'energy', title: 'Energy per day', period: { from: '2026-09-21', to: '2026-09-27', label: 'last week (21 – 27 Sep 2026)' },
  columns: ['Day', 'Made (kWh)', 'Sold (kWh)'],
  rows: [['Mon 21 Sep 2026', 13.2, 5], ['Tue 22 Sep 2026', 1234.5, 5], ['Wed 23 Sep 2026', 12, 5]],
  facts: { total_made_kwh: 1259.7 }, notes: ['Demo Solis Plant does not report what was sold.'],
  summary: 'Your systems made 1260 kWh last week (21 – 27 Sep 2026).',
  freshness: { newest: NOW - 120, offline: ['Demo Solis Plant'] },
};

/** What the Worker answers a message with, in the shape src/assistant.ts gives it. */
function reply(over: Record<string, unknown> = {}) {
  return {
    answer: 'Your systems made 1260 kWh last week, 21 – 27 Sep 2026.', worded: 'model', understood: 'model', kind: 'figures',
    calls: [{ tool: 'energy', args: { range: 'last_week' } }], results: [energyResult], errors: [],
    used: 3, limit: 100, model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', provider: 'workers-ai', ...over,
  };
}

const reportReply = () => reply({
  kind: 'report', answer: 'Last week in short: 1260 kWh made.\nThe Hybrid led per kWp.\n- No faults were recorded.',
  calls: [{ tool: 'report', args: { range: 'last_week' } }],
  results: [{
    tool: 'report', title: 'Report', period: energyResult.period, columns: ['', 'Figure'],
    rows: [['Made (kWh)', 1259.7], ['Faults', '0']], facts: {}, notes: [], summary: 'The report in a sentence.', freshness: energyResult.freshness,
    sections: [energyResult, { ...energyResult, tool: 'faults', title: 'Faults', rows: [], columns: [], summary: 'No faults were recorded last week.' }],
  }],
});

interface World {
  status: Record<string, unknown>;
  agents: unknown;
  sent: { path: string; body: any }[];
  replies: { status: number; body: unknown }[];
}

async function stub(page: Page, over: Partial<World> = {}): Promise<World> {
  const world: World = {
    status: { available: true, model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', provider: 'workers-ai', used: 2, limit: 100, can_ask: true },
    agents: {
      weekly: { kind: 'weekly', week_of: '2026-09-28', title: 'Week of 21 Sep 2026', body: 'A steady week: 224 kWh, about the same as the week before.', worded: 'model', flagged: false, created_at: NOW - 3600 },
      health: [
        { kind: 'health', system: 's1', name: 'Demo Solis Plant', week_of: '2026-09-28', title: 't', body: 'Demo Solis Plant: steady.', worded: 'solarlens', flagged: false, created_at: NOW - 3600, data: { verdict: 'steady', weekly: [0.8, 0.81, 0.79, 0.8] } },
        { kind: 'health', system: HYBRID, name: 'Demo Hybrid', week_of: '2026-09-28', title: 't', body: 'Demo Hybrid: for its sunlight it is making 20% less.', worded: 'solarlens', flagged: true, created_at: NOW - 3600, data: { verdict: 'declining', weekly: [0.8, 0.8, 0.64, 0.64] } },
      ],
    },
    sent: [], replies: [],
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
  for (const path of ['**/api/chat', '**/api/ask']) {
    await page.route(path, (r: Route) => {
      world.sent.push({ path: new URL(r.request().url()).pathname, body: r.request().postDataJSON() });
      const next = world.replies.shift() ?? { status: 200, body: reply() };
      return r.fulfill(json(next.body, next.status));
    });
  }
  return world;
}

async function ready(page: Page) {
  await expect(page.locator('#fleet-today')).not.toHaveText('—');
  await expect(page.locator('#askq')).toBeVisible();
}
const ask = async (page: Page, text: string) => {
  await page.locator('#askq').fill(text);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
};
const lastBot = (page: Page) => page.locator('.chatlog .msg.bot').last();

test.describe('the conversation', () => {
  test('sends the message, and shows the answer with its figures, a chart, the period, how fresh, and who worded it', async ({ page }) => {
    const world = await stub(page);
    await page.goto('/#/ask');
    await ready(page);
    await expect(page.getByText('98 of 100 model calls left today')).toBeVisible();
    await ask(page, 'How much did I make last week?');
    await expect(page.locator('.chatlog .msg.me')).toHaveText(['How much did I make last week?']);
    const bot = lastBot(page);
    await expect(bot.locator('.said')).toHaveText('Your systems made 1260 kWh last week, 21 – 27 Sep 2026.');
    await expect(bot.locator('.by')).toContainText('Worded by the model from the figures below, which SolarLens worked out.');
    await expect(bot.locator('.by')).toContainText('not reporting now: Demo Solis Plant');
    await expect(bot.locator('details.evidence summary')).toHaveText(['Energy per day · last week (21 – 27 Sep 2026)']);
    await expect(bot.locator('details.evidence tbody tr')).toHaveCount(3);
    await expect(bot.locator('.minichart svg rect')).toHaveCount(3);
    // The first and last labels are text beneath the drawing, oldest on the left.
    await expect(bot.locator('.minichart figcaption span')).toHaveText(['Mon 21 Sep 2026', 'Wed 23 Sep 2026']);
    await expect(bot.locator('.asknotes li')).toHaveText(['Demo Solis Plant does not report what was sold.']);
    await expect(page.getByText('97 of 100 model calls left today')).toBeVisible();
    expect(world.sent).toEqual([{ path: '/api/chat', body: { messages: [{ role: 'user', content: 'How much did I make last week?' }] } }]);
  });

  test('carries the conversation with a follow-up, and keeps it across a reload until a new one begins', async ({ page }) => {
    const world = await stub(page);
    await page.goto('/#/ask');
    await ready(page);
    await ask(page, 'How much did I make last week?');
    await expect(lastBot(page).locator('.said')).toContainText('1260 kWh');
    world.replies.push({ status: 200, body: reply({ answer: 'The week before, 1100 kWh.', calls: [{ tool: 'energy', args: { from: '2026-09-14', to: '2026-09-20' } }] }) });
    await expect(page.locator('#askq')).toHaveAttribute('placeholder', 'Ask a follow-up…');
    await ask(page, 'And the week before?');
    await expect(page.locator('.chatlog .msg.bot')).toHaveCount(2);
    expect(world.sent[1].body.messages).toEqual([
      { role: 'user', content: 'How much did I make last week?' },
      { role: 'assistant', content: 'Your systems made 1260 kWh last week, 21 – 27 Sep 2026.', calls: [{ tool: 'energy', args: { range: 'last_week' } }] },
      { role: 'user', content: 'And the week before?' },
    ]);
    await page.reload();
    await ready(page);
    await expect(page.locator('.chatlog .msg.me')).toHaveText(['How much did I make last week?', 'And the week before?']);
    await page.getByRole('button', { name: 'New conversation' }).click();
    await expect(page.locator('.chatlog .msg')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'A report on last month' })).toBeVisible();
  });

  test('asks an example with one tap', async ({ page }) => {
    const world = await stub(page);
    await page.goto('/#/ask');
    await ready(page);
    await page.getByRole('button', { name: 'How do I get alerts on Telegram?' }).click();
    await expect(page.locator('.chatlog .msg.bot')).toHaveCount(1);
    expect(world.sent[0].body.messages).toEqual([{ role: 'user', content: 'How do I get alerts on Telegram?' }]);
  });

  test('shows a report with its parts, and downloads it as a page of its own', async ({ page }) => {
    const world = await stub(page);
    world.replies.push({ status: 200, body: reportReply() });
    await page.goto('/#/ask');
    await ready(page);
    await ask(page, 'A report on last week');
    const bot = lastBot(page);
    await expect(bot.locator('.said p')).toHaveText(['Last week in short: 1260 kWh made.', 'The Hybrid led per kWp.']);
    await expect(bot.locator('.said li')).toHaveText(['No faults were recorded.']);
    await expect(bot.locator('details.evidence summary')).toHaveText(['Report · last week (21 – 27 Sep 2026)', 'Energy per day · last week (21 – 27 Sep 2026)', 'Faults · last week (21 – 27 Sep 2026)']);
    const [download] = await Promise.all([page.waitForEvent('download'), bot.getByRole('button', { name: 'Download report' }).click()]);
    expect(download.suggestedFilename()).toBe('SolarLens report - last week 21  27 Sep 2026.html');
    const html = readFileSync((await download.path())!, 'utf8');
    expect(html).toContain('<h1>SolarLens report: last week (21 – 27 Sep 2026)</h1>');
    expect(html).toContain('<p>Last week in short: 1260 kWh made.</p>');
    expect(html).toContain('<h3>Energy per day <small>last week (21 – 27 Sep 2026)</small></h3>');
    expect(html).toContain('<td>1,234.5</td>');
    expect(html).toContain('the words by @cf/meta/llama-3.3-70b-instruct-fp8-fast');
    expect(html).not.toContain('<script');
  });

  test('keeps an answer as text, never markup, in the page and in a download', async ({ page }) => {
    const world = await stub(page);
    world.replies.push({ status: 200, body: reply({ answer: '<img src=x onerror="window.pwned=1">Made 1260 kWh.' }) });
    await page.goto('/#/ask');
    await ready(page);
    await ask(page, 'How much?');
    await expect(lastBot(page).locator('.said')).toHaveText('<img src=x onerror="window.pwned=1">Made 1260 kWh.');
    await expect(page.locator('.chatlog img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
    const [download] = await Promise.all([page.waitForEvent('download'), lastBot(page).getByRole('button', { name: 'Download' }).click()]);
    expect(readFileSync((await download.path())!, 'utf8')).toContain('&lt;img src=x onerror=&quot;window.pwned=1&quot;&gt;');
  });

  test("links an answer about the app to the page it is about, and shows the Worker's refusals in its words", async ({ page }) => {
    const world = await stub(page);
    world.replies.push(
      { status: 200, body: reply({ kind: 'help', answer: 'Settings → Alerts elsewhere.', calls: [{ tool: 'app_help', args: {} }], results: [{
        tool: 'app_help', title: 'In SolarLens', period: null, columns: ['Topic', 'How', 'Where'], rows: [['Alerts', 'Settings → Alerts elsewhere', '#/settings']],
        facts: {}, notes: [], summary: 's', freshness: { newest: null, offline: [] } }] }) },
      { status: 400, body: { error: 'A message is at most 500 characters.' } },
      { status: 401, body: { error: 'signin' } },
    );
    await page.goto('/#/ask');
    await ready(page);
    await ask(page, 'How do I get alerts?');
    await expect(lastBot(page).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '#/settings');
    await ask(page, 'x'.repeat(20));
    await expect(lastBot(page).locator('.autherr')).toHaveText('A message is at most 500 characters.');
    await ask(page, 'And now?');
    await expect(lastBot(page).locator('.autherr')).toHaveText('This dashboard is private: sign in to ask.');
  });
});

test.describe('who words the answers', () => {
  for (const [label, status, text] of [
    ['someone not signed in', { available: true, model: 'm', provider: 'workers-ai', used: 0, limit: 100, can_ask: false }, "Answered in SolarLens's own words, from the figures. Sign in for the model's."],
    ['a server with no model', { available: false, model: null, provider: null, used: 0, limit: 100, can_ask: true }, 'No model is set up here: SolarLens reads each question itself, and answers from the figures.'],
    ['a day with no calls left', { available: true, model: 'm', provider: 'workers-ai', used: 100, limit: 100, can_ask: true }, "Today's model calls are used up: until midnight UTC, SolarLens reads each question itself."],
    ["a server of the owner's own", { available: true, model: 'made-up-model', provider: 'openai-compatible', used: 1, limit: 100, can_ask: true }, 'Worded by made-up-model; SolarLens works out every figure. 99 of 100 model calls left today.'],
  ] as const) {
    test(`is said, for ${label}`, async ({ page }) => {
      await stub(page, { status: { ...status } });
      await page.goto('/#/ask');
      await ready(page);
      await expect(page.getByText(text)).toBeVisible();
      await expect(page.locator('#askq')).toBeEnabled();
    });
  }

  test('and an answer SolarLens read and worded itself says so', async ({ page }) => {
    const world = await stub(page);
    world.replies.push({ status: 200, body: reply({ worded: 'solarlens', understood: 'solarlens' }) });
    await page.goto('/#/ask');
    await ready(page);
    await ask(page, 'How much last week?');
    await expect(lastBot(page).locator('.by')).toContainText("In SolarLens's own words, from the figures below. SolarLens read the question itself.");
  });
});

test.describe('the report and the health check', () => {
  test("show the week's report, and each system's health with its weeks", async ({ page }) => {
    await stub(page);
    await page.goto('/#/ask');
    await ready(page);
    const report = page.locator('section.card', { has: page.locator('h2', { hasText: "This week's report" }) });
    await expect(report.locator('.said')).toHaveText('A steady week: 224 kWh, about the same as the week before.');
    const rows = page.locator('.healthrow');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1).locator('.pill')).toHaveText('declining');
    await expect(rows.nth(1).locator('.pill')).toHaveClass(/warn/);
    await expect(rows.nth(1).locator('svg.ratiospark path')).toHaveCount(1);
  });

  test('say when nothing has been written yet', async ({ page }) => {
    await stub(page, { agents: { weekly: null, health: [] } });
    await page.goto('/#/ask');
    await ready(page);
    await expect(page.getByText('The first report is written on Monday morning.')).toBeVisible();
    await expect(page.getByText('The first check runs on Monday morning.')).toBeVisible();
  });
});

test('"Why?" beside a low day on Historical Data asks for that day, and the answer joins the conversation', async ({ page }) => {
  const world = await stub(page);
  world.replies.push({ status: 200, body: { ...reply({ answer: 'Demo Hybrid made 3 kWh: less sun.' }), question: null, tool: 'day_report', args: {}, result: energyResult } });
  await page.goto('/#/history');
  await expect(page.locator('#fleet-today')).not.toHaveText('—');
  const buttons = page.getByRole('button', { name: 'Why?' });
  await expect(buttons).toHaveCount(1);
  await buttons.click();
  await expect(page).toHaveURL(/#\/ask$/);
  await expect(page.locator('.chatlog .msg.me')).toHaveText([`Why was ${day(2)} low for Demo Hybrid?`]);
  await expect(lastBot(page).locator('.said')).toHaveText('Demo Hybrid made 3 kWh: less sun.');
  expect(world.sent).toEqual([{ path: '/api/ask', body: { tool: 'day_report', args: { date: day(2), system: 'Demo Hybrid' } } }]);
});

test('the guide says where to ask', async ({ page }) => {
  await stub(page);
  await page.goto('/#/guide');
  await expect(page.getByText('Ask anything in words, with follow-ups')).toBeVisible();
  await expect(page.getByText('Why was a day low?')).toBeVisible();
});
