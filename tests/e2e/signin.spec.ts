/**
 * Signing in, and Settings, as the owner and a visitor see them.
 *
 * The Worker is stubbed here as everywhere in this suite; what the sign-in
 * routes decide is held by tests/unit/auth.test.ts. These hold the page to its
 * half: a private dashboard shows a sign-in rather than an error, signing in
 * brings the dashboard back without a reload, Settings says what each switch
 * does, and a passkey made in the browser is one the Worker accepts - checked
 * with the Worker's own verifier, against Chrome's virtual authenticator.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { NOW, deviceHistory, devices, inverters, series } from '../fixtures/dashboard-api';
import { verifyAssertion, verifyRegistration, type StoredKey } from '../../src/auth/webauthn';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

interface World {
  signedIn: 'owner' | 'viewer' | null;
  required: boolean;
  password: boolean;
  passkeys: { id: string; name: string; created_at: number; last_used_at: number | null }[];
  posts: { path: string; body: Record<string, unknown> }[];
}

/**
 * A pretend Worker: the dashboard's data behind a sign-in when `required`, and
 * the /auth routes answering from `world`, which each test arranges and reads.
 */
async function stub(page: Page, over: Partial<World> = {}): Promise<World> {
  const world: World = { signedIn: null, required: true, password: true, passkeys: [], posts: [], ...over };
  const data = (body: unknown) => (r: Route) => r.fulfill(world.required && !world.signedIn ? json({ error: 'signin' }, 401) : json(body));
  await page.route('**/api/latest', data({ now: NOW, inverters: inverters() }));
  await page.route('**/api/series**', data({ from: 0, to: NOW, points: series() }));
  await page.route('**/api/devices', data({ now: NOW, devices: devices() }));
  await page.route('**/api/devices/history**', data(deviceHistory()));
  await page.route('**/api/history**', data({ now: NOW, days: 30, rows: [] }));
  await page.route('**/api/alarms**', data({ now: NOW, days: 3650, alarms: [] }));
  await page.route('**/api/periods', data({ now: NOW, periods: [] }));
  await page.route('**/api/health', data({ now: NOW, polls: [], feeds: [], relays: [] }));
  await page.route('**/auth/status', (r) => r.fulfill(json({
    configured: true, password: world.password, passkeys: world.passkeys.length, required: world.required,
    role: world.signedIn, device: world.signedIn ? 'dev-this' : null,
  })));
  await page.route('**/auth/settings', (r) => r.fulfill(json({
    password: world.password, required: world.required, passkeys: world.passkeys,
    devices: [
      { id: 'dev-this', role: 'owner', label: 'Chrome on Windows', created_at: NOW - 86400 * 30, last_seen_at: NOW - 60, expires_at: NOW + 86400 * 300, shared: false, this: true },
      { id: 'dev-tv', role: 'owner', label: 'Chrome on Android', created_at: NOW - 86400 * 90, last_seen_at: NOW - 3600, expires_at: NOW + 86400 * 200, shared: false, this: false },
      { id: 'dev-gran', role: 'viewer', label: 'Safari on iPad', created_at: NOW - 86400 * 7, last_seen_at: NOW - 86400, expires_at: NOW + 86400 * 23, shared: true, this: false },
    ],
    shares: [{ id: 'sh1', name: 'Family', created_at: NOW - 86400 * 7, expires_at: NOW + 86400 * 23, revoked_at: null, devices: 1 }],
  })));
  // Every POST under /auth: noted, and answered by what it asks for.
  await page.route('**/auth/**', async (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    const path = new URL(r.request().url()).pathname;
    const body = (r.request().postDataJSON() ?? {}) as Record<string, unknown>;
    world.posts.push({ path, body });
    if (path === '/auth/login') {
      if (body.password !== 'correct horse battery') return r.fulfill(json({ error: 'That password is not right.' }, 401));
      world.signedIn = 'owner';
      return r.fulfill(json({ ok: true }));
    }
    if (path === '/auth/settings/required') { world.required = !!body.on; return r.fulfill(json({ ok: true, required: world.required })); }
    if (path === '/auth/settings/shares') return r.fulfill(json({ ok: true, id: 'sh2', url: 'https://dashboard.example/s/sh2.secret' }));
    if (path === '/auth/settings/devices/revoke') return r.fulfill(json({ ok: true, signedOut: 2 }));
    if (path === '/auth/logout') { world.signedIn = null; return r.fulfill(json({ ok: true })); }
    return r.fulfill(json({ ok: true }));
  });
  return world;
}

test.describe('a private dashboard', () => {
  test('asks a stranger to sign in, instead of showing an error', async ({ page }) => {
    await stub(page);
    await page.goto('/');
    const card = page.locator('.authcard');
    await expect(card.locator('h2')).toHaveText('Sign in');
    await expect(card).toContainText('This dashboard is private');
    await expect(page.locator('#updated')).toContainText('sign in');
    await expect(page.locator('#pw')).toBeVisible();
  });

  test('comes back once the owner signs in, without a reload', async ({ page }) => {
    const world = await stub(page);
    await page.goto('/');
    await page.locator('#pw').fill('correct horse battery');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('.ovgrid, .ovsys').first()).toBeVisible();
    expect(world.posts.map((p) => p.path)).toEqual(['/auth/login']);
  });

  test('says what went wrong with a wrong password', async ({ page }) => {
    await stub(page);
    await page.goto('/');
    await page.locator('#pw').fill('not it at all');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('#auth-err')).toHaveText('That password is not right.');
  });

  test('says a share link has run out, when that is how the visitor got here', async ({ page }) => {
    await stub(page);
    await page.goto('/?link=expired');
    await expect(page.locator('.authcard')).toContainText('That share link has run out');
  });

  test('offers setup with the setup code when nothing is set up yet', async ({ page }) => {
    const world = await stub(page, { password: false });
    await page.goto('/');
    await expect(page.locator('.authmore')).toHaveAttribute('open', '');
    await expect(page.locator('#pw')).toHaveCount(0);
    await page.locator('#setup-code').fill('the-api-token');
    await page.getByRole('button', { name: 'Set up' }).click();
    await expect.poll(() => world.posts.map((p) => p.path)).toContain('/auth/setup');
    expect(world.posts.find((p) => p.path === '/auth/setup')?.body).toEqual({ code: 'the-api-token', password: null });
  });

  test('still opens the guide, which needs no data', async ({ page }) => {
    await stub(page);
    await page.goto('/#/guide');
    await expect(page.locator('.guide h2').first()).toContainText('Guide');
  });
});

test.describe('Settings, for the owner', () => {
  test('is one tap from anywhere, behind the gear', async ({ page }) => {
    await stub(page, { signedIn: 'owner', required: false });
    await page.goto('/');
    await expect(page.locator('#settingsbtn')).toHaveAccessibleName(/Settings/);
    await page.locator('#settingsbtn').click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.locator('#settingsbtn')).toHaveClass(/\bon\b/);
    await expect(page.locator('.settings h2').first()).toHaveText('Who can see this dashboard');
  });

  test('turns "require sign-in to view" on, and says what that means', async ({ page }) => {
    const world = await stub(page, { signedIn: 'owner', required: false });
    await page.goto('/#/settings');
    const box = page.locator('#req');
    await expect(box).not.toBeChecked();
    await expect(page.locator('.switchrow')).toContainText('Off: anyone with the address');
    await box.check();
    await expect(page.locator('.authnote')).toHaveText('The dashboard is private now.');
    expect(world.required).toBe(true);
    await expect(page.locator('.switchrow')).toContainText('On: only you');
  });

  test('will not lock the owner out before there is a way to sign in', async ({ page }) => {
    await stub(page, { signedIn: 'owner', required: false, password: false });
    await page.goto('/#/settings');
    await expect(page.locator('#req')).toBeDisabled();
    await expect(page.locator('.switchrow')).toContainText('Add a passkey or set a password first');
  });

  test('lists every signed-in device, and signs one out', async ({ page }) => {
    const world = await stub(page, { signedIn: 'owner' });
    await page.goto('/#/settings');
    const rows = page.locator('.settings table.devices tbody tr');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('this device');
    await expect(rows.nth(2)).toContainText('shared, view only');
    await rows.nth(1).getByRole('button', { name: 'Sign out' }).click();
    await expect(page.locator('.authnote')).toHaveText('Signed out.');
    expect(world.posts.find((p) => p.path === '/auth/settings/devices/revoke')?.body).toEqual({ id: 'dev-tv' });
  });

  test('signs every other device out at once', async ({ page }) => {
    await stub(page, { signedIn: 'owner' });
    await page.goto('/#/settings');
    await page.getByRole('button', { name: 'Sign out every other device' }).click();
    await expect(page.locator('.authnote')).toHaveText('Signed out 2 devices.');
  });

  test('makes a view-only link, and shows it once to copy', async ({ page }) => {
    const world = await stub(page, { signedIn: 'owner' });
    await page.goto('/#/settings');
    await page.locator('#share-name').fill('Grandparents');
    await page.locator('#share-days').selectOption('7');
    await page.getByRole('button', { name: 'Make a link' }).click();
    await expect(page.locator('#share-url')).toHaveValue('https://dashboard.example/s/sh2.secret');
    expect(world.posts.find((p) => p.path === '/auth/settings/shares')?.body).toEqual({ name: 'Grandparents', days: 7 });
  });

  test('takes a link back', async ({ page }) => {
    const world = await stub(page, { signedIn: 'owner' });
    await page.goto('/#/settings');
    await page.getByRole('button', { name: 'Take back' }).click();
    await expect(page.locator('.authnote')).toHaveText('Link taken back.');
    expect(world.posts.find((p) => p.path === '/auth/settings/shares/revoke')?.body).toEqual({ id: 'sh1' });
  });

  test('changes the password, asking for the current one', async ({ page }) => {
    const world = await stub(page, { signedIn: 'owner' });
    await page.goto('/#/settings');
    await page.locator('#pw-cur').fill('correct horse battery');
    await page.locator('#pw-new').fill('an even longer new password');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.locator('.authnote')).toHaveText('Password saved.');
    expect(world.posts.find((p) => p.path === '/auth/settings/password')?.body).toEqual({ current: 'correct horse battery', next: 'an even longer new password' });
  });

  test('signs this device out', async ({ page }) => {
    const world = await stub(page, { signedIn: 'owner' });
    await page.goto('/#/settings');
    await page.getByRole('button', { name: 'Sign out of this device' }).click();
    await expect.poll(() => world.posts.map((p) => p.path)).toContain('/auth/logout');
  });
});

test.describe('Settings, for someone else', () => {
  test('tells a visitor the dashboard was shared with them', async ({ page }) => {
    await stub(page, { signedIn: 'viewer' });
    await page.goto('/#/settings');
    await expect(page.locator('.authcard')).toContainText('shared with you to view');
    await expect(page.locator('#req')).toHaveCount(0);
  });

  test('asks a stranger to sign in first', async ({ page }) => {
    await stub(page, { required: false });
    await page.goto('/#/settings');
    await expect(page.locator('.authcard')).toContainText('Settings are for the owner');
    await expect(page.locator('#pw')).toBeVisible();
  });
});

/**
 * A real passkey, end to end on the page's side: Chrome's virtual
 * authenticator makes and uses the key, the page encodes what it sends, and
 * the Worker's own verifier checks it. WebAuthn will not run on a bare IP
 * address, so this one test opens the page as localhost.
 */
test('a passkey made on the page is one the Worker accepts, and signs in with', async ({ page, browserName }, info) => {
  test.skip(info.project.name !== 'chrome' || browserName !== 'chromium', 'one virtual authenticator, on desktop Chrome');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  const base = new URL(info.project.use.baseURL ?? 'http://127.0.0.1:4173');
  const origin = `http://localhost:${base.port}`;
  const rp = { id: 'localhost', origin };
  const world = await stub(page, { signedIn: 'owner', required: false });
  let challenge = 'c'.repeat(43);
  // A holder rather than a let: the routes below fill it in, after the checker has looked.
  const kept: { passkey?: { id: string; key: StoredKey } } = {};
  let signedWith = '';

  await page.route('**/auth/passkey/**', async (r) => {
    const path = new URL(r.request().url()).pathname;
    const body = r.request().postDataJSON() as { purpose?: string; id?: string; name?: string; response: never };
    if (path === '/auth/passkey/options') {
      challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
      if (body.purpose === 'register') {
        return r.fulfill(json({
          challenge, rp: { id: 'localhost', name: 'SolarLens' },
          user: { id: Buffer.from('solarlens-owner').toString('base64url'), name: 'owner', displayName: 'SolarLens owner' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
          excludeCredentials: [], attestation: 'none', timeout: 60_000,
        }));
      }
      return r.fulfill(json({ challenge, rpId: 'localhost', userVerification: 'preferred', timeout: 60_000 }));
    }
    if (path === '/auth/passkey/register') {
      const made = await verifyRegistration(body.response, challenge, rp);
      kept.passkey = { id: made.id, key: made.key };
      world.passkeys.push({ id: made.id, name: String(body.name || 'Passkey'), created_at: NOW, last_used_at: null });
      return r.fulfill(json({ ok: true, id: made.id }));
    }
    if (path === '/auth/passkey/login') {
      expect(body.id).toBe(kept.passkey?.id);
      await verifyAssertion(body.response, challenge, rp, kept.passkey!.key, 0);
      signedWith = String(body.id);
      world.signedIn = 'owner';
      return r.fulfill(json({ ok: true }));
    }
    return r.fallback();
  });

  await page.goto(`${origin}/#/settings`);
  await page.locator('#pk-name').fill('Test key');
  await page.getByRole('button', { name: 'Add a passkey on this device' }).click();
  await expect(page.locator('.authnote')).toHaveText('Passkey added.');
  await expect(page.locator('.authlist').first()).toContainText('Test key');

  // Now as a signed-out browser on the private dashboard.
  world.signedIn = null;
  world.required = true;
  await page.goto(`${origin}/`);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.locator('.ovgrid, .ovsys').first()).toBeVisible();
  expect(signedWith).toBe(kept.passkey!.id);
});
