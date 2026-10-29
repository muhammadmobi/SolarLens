/**
 * Settings' Connected apps, and the way back to an app's approval page.
 *
 * The Worker is stubbed as everywhere in this suite; tests/unit/oauth.test.ts
 * and mcp.test.ts hold the OAuth flow and the MCP server, and the approval page
 * itself, which the Worker draws. These hold the dashboard's part: the MCP
 * address to give an app, each connected app and disconnecting it, and - when
 * the approval page sent a signed-out owner to sign in - going back to exactly
 * that page afterwards, and to nowhere else a link might name.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { NOW, devices, deviceHistory, inverters, series } from '../fixtures/dashboard-api';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const APPROVAL = '/oauth/authorize?response_type=code&client_id=made-up-client&state=s';
/** A text matched as itself inside a RegExp: every character a pattern gives a meaning to, escaped. */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface World { signedIn: 'owner' | null; apps: Record<string, unknown>[]; deleted: string[] }

async function stub(page: Page, over: Partial<World> = {}): Promise<World> {
  const world: World = {
    signedIn: 'owner', deleted: [],
    apps: [{ id: 'g1', name: 'Made-up Assistant', redirect_to: 'app.example.org', connected_at: NOW - 86400 * 3, last_used_at: NOW - 600 }],
    ...over,
  };
  await page.route('**/api/latest', (r) => r.fulfill(json({ now: NOW, inverters: inverters() })));
  await page.route('**/api/series**', (r) => r.fulfill(json({ from: 0, to: NOW, points: series() })));
  await page.route('**/api/devices', (r) => r.fulfill(json({ now: NOW, devices: devices() })));
  await page.route('**/api/devices/history**', (r) => r.fulfill(json(deviceHistory())));
  for (const path of ['**/api/history**', '**/api/alarms**', '**/api/periods', '**/api/health', '**/api/expected', '**/api/locations']) {
    await page.route(path, (r) => r.fulfill(json({ now: NOW, rows: [], alarms: [], periods: [], polls: [], feeds: [], relays: [], systems: [], locations: [] })));
  }
  await page.route('**/api/settings/apps**', (r: Route) => {
    if (r.request().method() === 'DELETE') {
      world.deleted.push(new URL(r.request().url()).pathname);
      world.apps = [];
      return r.fulfill(json({ ok: true }));
    }
    return r.fulfill(world.signedIn ? json({ apps: world.apps, mcp: 'https://solarlens.example.com/mcp' }) : json({ error: 'owner only' }, 401));
  });
  await page.route('**/api/settings/channels', (r) => r.fulfill(json({ channels: [], max: 5, ready: true })));
  await page.route('**/api/settings/**', (r) => r.fallback());
  await page.route('**/auth/status', (r) => r.fulfill(json({ configured: true, password: true, passkeys: 0, required: false, role: world.signedIn, device: world.signedIn ? 'dev-this' : null })));
  await page.route('**/auth/settings', (r) => r.fulfill(json({
    password: true, required: false, passkeys: [], shares: [],
    devices: [{ id: 'dev-this', role: 'owner', label: 'Chrome on Windows', created_at: NOW - 86400, last_seen_at: NOW - 60, expires_at: NOW + 86400 * 300, shared: false, this: true }],
  })));
  await page.route('**/auth/login', (r) => { world.signedIn = 'owner'; return r.fulfill(json({ ok: true })); });
  // What the Worker would draw at the approval page: here, just somewhere to land.
  await page.route('**/oauth/authorize**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Approval</title><h1>The approval page</h1>' }));
  return world;
}

const card = (page: Page) => page.locator('section.card', { has: page.locator('h2', { hasText: 'Connected apps' }) });

test.describe('connected apps', () => {
  test('gives the MCP address to copy, lists each app, and disconnects one', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const world = await stub(page);
    await page.goto('/#/settings');
    await expect(card(page)).toBeVisible();
    await expect(page.locator('#mcp-url')).toHaveValue('https://solarlens.example.com/mcp');
    await page.locator('#mcp-copy').click();
    await expect(page.locator('#mcp-copy')).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://solarlens.example.com/mcp');
    const app = card(page).locator('.authlist li');
    await expect(app).toContainText('Made-up Assistant');
    await expect(app).toContainText('answers to app.example.org');
    await expect(app).toContainText('last used 10 min ago');
    await app.getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByRole('status')).toHaveText('Disconnected. It can no longer read anything here.');
    expect(world.deleted).toEqual(['/api/settings/apps/g1']);
    await expect(card(page)).toContainText('No app connected.');
  });

  test('is not shown to anyone but the owner', async ({ page }) => {
    await stub(page, { signedIn: null });
    await page.goto('/#/settings');
    await expect(page.locator('#signin-box')).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });
});

test.describe("going back to an app's approval page", () => {
  test('happens once the owner has signed in', async ({ page }) => {
    await stub(page, { signedIn: null });
    await page.goto(`/?next=${encodeURIComponent(APPROVAL)}#/settings`);
    await page.locator('#pw').fill('correct horse battery');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(APPROVAL)}$`));
    await expect(page.getByRole('heading', { name: 'The approval page' })).toBeVisible();
  });

  test('never goes anywhere else a link names', async ({ page }) => {
    const world = await stub(page, { signedIn: null });
    for (const next of ['https://evil.example.net/oauth/authorize?x', '//evil.example.net/oauth/authorize?x', '/elsewhere']) {
      world.signedIn = null;
      await page.goto(`/?next=${encodeURIComponent(next)}#/settings`);
      await page.locator('#pw').fill('correct horse battery');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      // Signed in, and still on the dashboard: the link's address was not followed.
      await expect(page.locator('.settings')).toBeVisible();
      expect(new URL(page.url()).origin + new URL(page.url()).pathname).toBe(new URL('/', page.url()).href);
    }
  });

  test('is offered to an owner who is already signed in', async ({ page }) => {
    await stub(page);
    await page.goto(`/?next=${encodeURIComponent(APPROVAL)}#/settings`);
    const back = page.getByRole('link', { name: 'Go back to connecting the app' });
    await expect(back).toHaveAttribute('href', APPROVAL);
  });
});

test('the guide says where to connect an AI app', async ({ page }) => {
  await stub(page);
  await page.goto('/#/guide');
  await expect(page.getByText('Ask SolarLens from Claude or another AI app')).toBeVisible();
});
