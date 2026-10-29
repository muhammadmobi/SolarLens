/**
 * Settings' "Alerts elsewhere" and "Home Assistant" cards.
 *
 * The Worker is stubbed as everywhere in this suite; tests/unit/channels.test.ts
 * and tests/unit/summary.test.ts hold the routes. These hold the page: each
 * place listed with how its last post went and never its secret; adding one
 * sends exactly the fields of the kind chosen, and says whether the test
 * arrived; what a place takes can be changed, and a refusal undoes the tick;
 * a test, a removal and the weekly summary on request; and the Home Assistant
 * configuration, with this dashboard's address, its systems and - when it is
 * private - a read-only token made on the spot.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { NOW, devices, deviceHistory, inverters, series } from '../fixtures/dashboard-api';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const healthy = {
  id: 'c1', kind: 'ntfy', name: 'Phone', label: 'ntfy.sh · topic …ab', alerts: true, weekly: true,
  created_at: NOW - 86400 * 20, last_ok_at: NOW - 7200, last_error: null, last_error_at: null, failures: 0,
};
const failing = {
  id: 'c2', kind: 'discord', name: null, label: 'Discord webhook …wxyz', alerts: true, weekly: false,
  created_at: NOW - 86400 * 5, last_ok_at: null, last_error: 'HTTP 401: Invalid Webhook Token', last_error_at: NOW - 600, failures: 3,
};

interface World {
  channels: typeof healthy[] | Record<string, unknown>[];
  required: boolean;
  ready: boolean;
  writes: { method: string; path: string; body: unknown }[];
  answer?: { status: number; body: unknown };
}

async function stub(page: Page, over: Partial<World> = {}): Promise<World> {
  const world: World = { channels: [healthy, failing], required: false, ready: true, writes: [], ...over };
  await page.route('**/api/latest', (r) => r.fulfill(json({ now: NOW, inverters: inverters() })));
  await page.route('**/api/series**', (r) => r.fulfill(json({ from: 0, to: NOW, points: series() })));
  await page.route('**/api/devices', (r) => r.fulfill(json({ now: NOW, devices: devices() })));
  await page.route('**/api/devices/history**', (r) => r.fulfill(json(deviceHistory())));
  for (const path of ['**/api/history**', '**/api/alarms**', '**/api/periods', '**/api/health', '**/api/expected', '**/api/locations']) {
    await page.route(path, (r) => r.fulfill(json({ now: NOW, rows: [], alarms: [], periods: [], polls: [], feeds: [], relays: [], systems: [], locations: [] })));
  }
  // Every write under /api/settings, noted and answered as the test arranges.
  await page.route('**/api/settings/**', async (r: Route) => {
    const req = r.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'GET') {
      if (path === '/api/settings/channels') return r.fulfill(json({ channels: world.channels, max: 5, ready: world.ready }));
      return r.fulfill(json({ tariff: null, groups: {} }));
    }
    world.writes.push({ method: req.method(), path, body: req.postDataJSON() });
    if (world.answer) return r.fulfill(json(world.answer.body, world.answer.status));
    if (path === '/api/settings/summary') return r.fulfill(json({ sent: 1, of: 1, title: 'Last week: 191 kWh made', body: '…' }));
    if (path.endsWith('/test')) return r.fulfill(json({ ok: true }));
    return r.fulfill(json({ channel: healthy, test: { ok: true }, ok: true }));
  });
  await page.route('**/auth/status', (r) => r.fulfill(json({ configured: true, password: true, passkeys: 0, required: world.required, role: 'owner', device: 'dev-this' })));
  await page.route('**/auth/settings', (r) => r.fulfill(json({
    password: true, required: world.required, passkeys: [], shares: [],
    devices: [{ id: 'dev-this', role: 'owner', label: 'Chrome on Windows', created_at: NOW - 86400, last_seen_at: NOW - 60, expires_at: NOW + 86400 * 300, shared: false, this: true }],
  })));
  await page.route('**/auth/settings/shares', (r) => {
    world.writes.push({ method: 'POST', path: '/auth/settings/shares', body: r.request().postDataJSON() });
    return r.fulfill(json({ ok: true, id: 'sh9', url: 'https://dashboard.example/s/sh9madeup.secret-made-up-for-tests' }));
  });
  return world;
}

/** The first refresh redraws the open view once its data lands; wait for it before acting. */
async function ready(page: Page) {
  await expect(page.locator('#fleet-today')).not.toHaveText('—');
  await expect(page.locator('#chan-kind, .chan').first()).toBeVisible();
}

const card = (page: Page, name: string) => page.locator('section.card', { has: page.locator('h2', { hasText: name }) });

test.describe('alerts elsewhere', () => {
  test('lists each place with how its last post went, and none of its secret', async ({ page }) => {
    await stub(page);
    await page.goto('/#/settings');
    await ready(page);
    const places = card(page, 'Alerts elsewhere').locator('li.chan');
    await expect(places).toHaveCount(2);
    await expect(places.first()).toContainText('Phone');
    // NOW is fixed when the fixtures load; on a busy machine a minute or two can pass before this runs.
    await expect(places.first()).toContainText(/ntfy · ntfy\.sh · topic …ab · delivered 2 h \d+ min ago/);
    await expect(places.nth(1)).toContainText('Discord');
    await expect(places.nth(1).locator('.chanbad')).toHaveText('failing 3 times in a row: HTTP 401: Invalid Webhook Token');
    await expect(places.nth(1).locator('input[data-what="weekly"]')).not.toBeChecked();
    // A place is added in a folded form once there is one.
    await expect(page.locator('#chan-add')).toBeHidden();
    await expect(page.getByRole('button', { name: "Send last week's summary now" })).toBeVisible();
  });

  test('adds a place with exactly the fields its kind needs, and says whether the test arrived', async ({ page }) => {
    const world = await stub(page, { channels: [] });
    await page.goto('/#/settings');
    await ready(page);
    const form = page.locator('#chan-add');
    await expect(form).toBeVisible();
    await expect(page.locator('[data-kind-note="ntfy"]')).toBeVisible();
    await page.locator('#ntfy-topic').fill('solar-alerts-made-up');
    await form.getByRole('button', { name: 'Add, and send a test' }).click();
    await expect(page.getByRole('status')).toHaveText('Added, and a test is on its way: check it arrived.');
    expect(world.writes).toEqual([{ method: 'POST', path: '/api/settings/channels', body: {
      kind: 'ntfy', name: '', alerts: true, weekly: true, server: 'https://ntfy.sh', topic: 'solar-alerts-made-up', token: '',
    } }]);

    // Telegram: its own fields shown, ntfy's hidden, and only its own sent.
    // Still no place listed (the stub keeps none), so the form is still open.
    await page.locator('#chan-kind').selectOption('telegram');
    await expect(page.locator('fieldset[data-kind="ntfy"]')).toBeHidden();
    await expect(page.locator('[data-kind-note="telegram"]')).toBeVisible();
    await page.locator('#tg-token').fill('4242:AAexampleExampleExample_example-1');
    await page.locator('#tg-chat').fill('-4242');
    await page.locator('#chan-name').fill('Family chat');
    await page.locator('#chan-weekly').uncheck();
    world.answer = { status: 200, body: { channel: healthy, test: { ok: false, error: 'HTTP 400: Bad Request: chat not found' } } };
    await page.getByRole('button', { name: 'Add, and send a test' }).click();
    await expect(page.getByRole('status')).toHaveText('Added, but the test did not arrive: HTTP 400: Bad Request: chat not found.');
    expect(world.writes[1].body).toEqual({ kind: 'telegram', name: 'Family chat', alerts: true, weekly: false, token: '4242:AAexampleExampleExample_example-1', chat: '-4242' });
  });

  test('shows what the server refused, in its words', async ({ page }) => {
    const world = await stub(page, { channels: [] });
    await page.goto('/#/settings');
    await ready(page);
    await page.locator('#chan-kind').selectOption('webhook');
    await page.locator('#wh-url').fill('http://hooks.example.net/x');
    world.answer = { status: 400, body: { error: 'The address must start with https://.' } };
    await page.getByRole('button', { name: 'Add, and send a test' }).click();
    await expect(page.locator('#auth-err')).toHaveText('The address must start with https://.');
    expect(world.writes[0].body).toMatchObject({ kind: 'webhook', url: 'http://hooks.example.net/x' });
  });

  test('changes what a place takes, and undoes the tick when the server refuses', async ({ page }) => {
    const world = await stub(page);
    await page.goto('/#/settings');
    await ready(page);
    const phone = page.locator('li.chan').first();
    await phone.locator('input[data-what="weekly"]').uncheck();
    await expect(page.getByRole('status')).toHaveText('Saved.');
    expect(world.writes[0]).toEqual({ method: 'PATCH', path: '/api/settings/channels/c1', body: { weekly: false } });

    world.answer = { status: 400, body: { error: 'A channel takes alerts, the weekly summary, or both. To stop it altogether, remove it.' } };
    const discord = page.locator('li.chan').nth(1);
    // A click rather than uncheck(): the page puts the tick back, which uncheck() would call a failure.
    await discord.locator('input[data-what="alerts"]').click();
    await expect(page.locator('#auth-err')).toContainText('remove it');
    await expect(discord.locator('input[data-what="alerts"]')).toBeChecked();
  });

  test('sends a test, removes a place, and sends the summary on request', async ({ page }) => {
    const world = await stub(page);
    await page.goto('/#/settings');
    await ready(page);
    await page.locator('li.chan').first().getByRole('button', { name: 'Send a test' }).click();
    await expect(page.getByRole('status')).toHaveText('Test sent: check it arrived.');
    await page.getByRole('button', { name: "Send last week's summary now" }).click();
    await expect(page.getByRole('status')).toHaveText("Last week's summary sent to 1 of 1 place.");
    await page.locator('li.chan').nth(1).getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('status')).toHaveText('Removed.');
    expect(world.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      'POST /api/settings/channels/c1/test', 'POST /api/settings/summary', 'DELETE /api/settings/channels/c2',
    ]);
  });

  test('says a failed test in its words', async ({ page }) => {
    const world = await stub(page);
    await page.goto('/#/settings');
    await ready(page);
    world.answer = { status: 200, body: { ok: false, error: 'HTTP 404, not found: check the address, the topic or the chat' } };
    await page.locator('li.chan').first().getByRole('button', { name: 'Send a test' }).click();
    await expect(page.getByRole('status')).toHaveText('The test did not arrive: HTTP 404, not found: check the address, the topic or the chat.');
  });

  test('stops offering to add a place at the most there can be, and says when the server cannot keep them', async ({ page }) => {
    const five = Array.from({ length: 5 }, (_, i) => ({ ...healthy, id: `c${i}`, name: `Place ${i}` }));
    await stub(page, { channels: five, ready: false });
    await page.goto('/#/settings');
    await ready(page);
    await expect(page.locator('#chan-add')).toHaveCount(0);
    await expect(card(page, 'Alerts elsewhere')).toContainText('That is the most there can be (5)');
    await expect(card(page, 'Alerts elsewhere').locator('.autherr')).toContainText('no API_TOKEN');
  });
});

test.describe('Home Assistant', () => {
  test("writes the configuration for this dashboard's address and systems", async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await stub(page);
    await page.goto('/#/settings');
    await ready(page);
    const yaml = page.locator('#ha-yaml');
    const text = await yaml.textContent();
    expect(text).toContain(`  - resource: ${new URL(page.url()).origin}/api/sensors`);
    expect(text).not.toContain('Authorization');
    expect(text).toContain('value_template: "{{ value_json.power_w }}"');
    expect(text).toContain('- name: "Demo Solis Plant power"');
    expect(text).toContain('value_template: "{{ value_json.systems.s1.power_w }}"');
    // A battery sensor for the system that has one, and only for it.
    expect(text).toContain('value_template: "{{ value_json.systems.s2.battery_soc }}"');
    expect(text).not.toContain('systems.s1.battery_soc');
    await page.getByRole('button', { name: 'Copy the Home Assistant configuration' }).click();
    await expect(page.locator('#ha-copy')).toHaveText('Copied');
    // The system clipboard may write each line break its own way (CR LF on Windows).
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(text);
  });

  test('on a private dashboard, makes a read-only token and puts it in the configuration', async ({ page }) => {
    const world = await stub(page, { required: true });
    await page.goto('/#/settings');
    await ready(page);
    await expect(page.locator('#ha-yaml')).toContainText('Authorization: "Bearer <make a token with the button above>"');
    await page.getByRole('button', { name: 'Make a token for Home Assistant' }).click();
    await expect(page.getByRole('status')).toContainText('Token made');
    await expect(page.locator('#ha-yaml')).toContainText('Authorization: "Bearer sh9madeup.secret-made-up-for-tests"');
    expect(world.writes).toEqual([{ method: 'POST', path: '/auth/settings/shares', body: { name: 'Home Assistant', days: null } }]);
  });
});

test('the guide says where both are', async ({ page }) => {
  await stub(page);
  await page.goto('/#/guide');
  await expect(page.getByText('Get alerts on ntfy, Telegram or Discord, and a summary every Monday')).toBeVisible();
  await expect(page.getByText('Show SolarLens in Home Assistant')).toBeVisible();
});
