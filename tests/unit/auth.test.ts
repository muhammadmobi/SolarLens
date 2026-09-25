/**
 * The owner login, end to end through the Worker.
 *
 * What these hold the login to is what the owner was promised: sign in once
 * per device and never again; a copied token is caught; signing a device out
 * takes effect at once; nothing locks until the owner turns it on; the relays,
 * phone notifications and a monitor keep working; and a stranger guessing gets
 * five tries, then waits.
 *
 * Cookies are carried between requests by a small jar, as a browser would, and
 * the clock is moved with fake timers to cross the session's hour and the
 * refresh token's grace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, hashToken, verifyPassword } from '../../src/auth/crypto';
import { GRACE_S, SESSION_S, deviceLabel, makeSession, readSession } from '../../src/auth/sessions';
import { bearer, createHarness, type Harness } from '../helpers/worker';
import { authenticator } from '../helpers/passkey';

const CODE = 'api-token-for-tests';          // the harness's API_TOKEN, which is the setup code
const PASSWORD = 'correct horse battery';
const T0 = Date.UTC(2026, 8, 1, 12) ;

/** A browser: its cookies, and requests that carry them. */
function browser(h: Harness, ip = '198.51.100.7') {
  const jar = new Map<string, string>();
  const take = (res: Response) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
      const gone = attrs.some((a) => /max-age=0\b/i.test(a.trim())) || value === '';
      if (gone) jar.delete(name); else jar.set(name, value);
    }
    return res;
  };
  const headers = (extra: Record<string, string> = {}) => ({
    'cf-connecting-ip': ip,
    'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36',
    ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
    ...extra,
  });
  return {
    jar,
    get: async (path: string) => take(await h.fetch(path, { headers: headers() })),
    post: async (path: string, body: unknown = {}) => take(await h.fetch(path, {
      method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify(body),
    })),
    /** Send these exact cookies, without taking any back: a copy of a browser at one moment. */
    withCookies: async (path: string, cookies: Map<string, string>) => h.fetch(path, {
      headers: { ...headers(), cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    }),
  };
}

let h: Harness;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  h = createHarness();
});
afterEach(() => {
  h.close();
  vi.useRealTimers();
});

const at = (s: number) => vi.setSystemTime(T0 + s * 1000);
const status = async (b: ReturnType<typeof browser>) => (await (await b.get('/auth/status')).json()) as Record<string, unknown>;
const requireSignIn = async (owner: ReturnType<typeof browser>, on = true) => owner.post('/auth/settings/required', { on });

/** An owner set up with a password, signed in on one browser. */
async function ownerSignedIn() {
  const b = browser(h);
  const res = await b.post('/auth/setup', { code: CODE, password: PASSWORD });
  expect(res.status).toBe(200);
  return b;
}

// ---------------------------------------------------------------- the pieces

describe('the password', () => {
  it('verifies, and only with the same pepper', async () => {
    const stored = await hashPassword(PASSWORD, 'pepper', 1000);
    expect(stored).toMatch(/^pbkdf2\$1000\$/);
    expect(await verifyPassword(PASSWORD, stored, 'pepper')).toBe(true);
    expect(await verifyPassword('wrong', stored, 'pepper')).toBe(false);
    // A copy of the database, without the Worker's secret, checks nothing.
    expect(await verifyPassword(PASSWORD, stored, 'another')).toBe(false);
  });
  it('refuses a stored form it does not recognise', async () => {
    for (const bad of ['', 'md5$1$a$b', 'pbkdf2$x$a$b', 'pbkdf2$0$a$b', 'pbkdf2$10']) expect(await verifyPassword(PASSWORD, bad, 'p')).toBe(false);
  });
});

describe('the session cookie', () => {
  it('names its device and role until its hour is up', async () => {
    const s = await makeSession('k', 'dev1', 'owner', 1000);
    expect(await readSession('k', s, 1000 + SESSION_S - 1)).toEqual({ deviceId: 'dev1', role: 'owner' });
    expect(await readSession('k', s, 1000 + SESSION_S)).toBeNull();
  });
  it('cannot be forged, stretched or promoted', async () => {
    const s = await makeSession('k', 'dev1', 'viewer', 1000);
    const [v, d, , ends, sig] = s.split('.');
    expect(await readSession('k', [v, d, 'owner', ends, sig].join('.'), 1000)).toBeNull();
    expect(await readSession('k', [v, d, 'viewer', String(Number(ends) + 9999), sig].join('.'), 1000)).toBeNull();
    expect(await readSession('another key', s, 1000)).toBeNull();
    expect(await readSession('k', 'v2.a.owner.9.x', 1000)).toBeNull();
    expect(await readSession('k', 'v1.a.admin.9999999999.x', 1000)).toBeNull();
    expect(await readSession('k', undefined, 1000)).toBeNull();
  });
});

describe('a device\'s name in Settings', () => {
  it('is the browser and the system, nothing more', () => {
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36')).toBe('Chrome on Android');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1')).toBe('Safari on iPhone');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Edge on Windows');
    expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Firefox/131.0')).toBe('Firefox on Linux');
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1')).toBe('Safari on Mac');
    expect(deviceLabel(undefined)).toBe('A browser');
  });
});

// ---------------------------------------------------------------- setting up

describe('setting up sign-in', () => {
  it('starts with nothing set up and nothing locked', async () => {
    const b = browser(h);
    expect(await status(b)).toMatchObject({ configured: true, password: false, passkeys: 0, required: false, role: null });
    expect((await b.get('/api/latest')).status).toBe(200);
  });

  it('takes the setup code and a password, and signs this browser in as the owner', async () => {
    const b = await ownerSignedIn();
    expect(b.jar.has('sl_session')).toBe(true);
    expect(b.jar.has('sl_refresh')).toBe(true);
    expect(await status(b)).toMatchObject({ password: true, role: 'owner' });
  });

  it('keeps its cookies away from scripts and from other sites', async () => {
    const res = await browser(h).post('/auth/setup', { code: CODE, password: PASSWORD });
    for (const line of res.headers.getSetCookie()) {
      expect(line).toMatch(/HttpOnly/i);
      expect(line).toMatch(/Secure/i);
      expect(line).toMatch(/SameSite=Strict/i);
    }
  });

  it('refuses a wrong code, and a password shorter than twelve', async () => {
    const b = browser(h);
    expect((await b.post('/auth/setup', { code: 'nope', password: PASSWORD })).status).toBe(401);
    expect((await b.post('/auth/setup', { code: CODE, password: 'short' })).status).toBe(400);
    expect(b.jar.size).toBe(0);
  });

  it('can be done with no password, for an owner who will use passkeys', async () => {
    const b = browser(h);
    expect((await b.post('/auth/setup', { code: CODE, password: null })).status).toBe(200);
    expect(await status(b)).toMatchObject({ password: false, role: 'owner' });
  });

  it('resets a forgotten password, and signs every other device out', async () => {
    const phone = await ownerSignedIn();
    const laptop = browser(h, '203.0.113.9');
    expect((await laptop.post('/auth/setup', { code: CODE, password: 'a brand new password' })).status).toBe(200);
    expect((await status(phone)).role).toBeNull();
    expect((await laptop.post('/auth/login', { password: PASSWORD })).status).toBe(401);
    expect((await laptop.post('/auth/login', { password: 'a brand new password' })).status).toBe(200);
  });

  it('is unavailable where the server has no API_TOKEN', async () => {
    h.close();
    h = createHarness({ API_TOKEN: undefined });
    const b = browser(h);
    expect(await status(b)).toMatchObject({ configured: false });
    expect((await b.post('/auth/setup', { code: 'x', password: PASSWORD })).status).toBe(503);
    expect((await b.post('/auth/login', { password: PASSWORD })).status).toBe(503);
  });
});

// ---------------------------------------------------------------- signing in

describe('signing in with the password', () => {
  it('works with the right one and not the wrong one', async () => {
    await ownerSignedIn();
    const b = browser(h, '203.0.113.20');
    expect((await b.post('/auth/login', { password: 'wrong wrong wrong' })).status).toBe(401);
    expect((await b.post('/auth/login', { password: PASSWORD })).status).toBe(200);
    expect((await status(b)).role).toBe('owner');
  });

  it('says so when no password is set', async () => {
    await browser(h).post('/auth/setup', { code: CODE, password: null });
    const res = await browser(h, '203.0.113.21').post('/auth/login', { password: PASSWORD });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(/No password is set/);
  });

  it('locks one caller out after five wrong tries, for a quarter of an hour', async () => {
    await ownerSignedIn();
    const b = browser(h, '203.0.113.30');
    for (let i = 0; i < 5; i++) expect((await b.post('/auth/login', { password: 'nope nope nope' })).status).toBe(401);
    const res = await b.post('/auth/login', { password: PASSWORD });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { until: number }).until).toBe(Math.floor(T0 / 1000) + 900);
    // Someone else is not locked out by it.
    expect((await browser(h, '203.0.113.31').post('/auth/login', { password: PASSWORD })).status).toBe(200);
    at(901);
    expect((await b.post('/auth/login', { password: PASSWORD })).status).toBe(200);
  });

  it('counts wrong setup codes the same way', async () => {
    const b = browser(h, '203.0.113.32');
    for (let i = 0; i < 5; i++) await b.post('/auth/setup', { code: 'guess', password: PASSWORD });
    expect((await b.post('/auth/setup', { code: CODE, password: PASSWORD })).status).toBe(429);
  });

  it('pauses password sign-in for everyone after thirty wrong tries in an hour', async () => {
    await ownerSignedIn();
    for (let i = 0; i < 30; i++) await browser(h, `192.0.2.${i}`).post('/auth/login', { password: 'nope nope nope' });
    expect((await browser(h, '192.0.2.200').post('/auth/login', { password: PASSWORD })).status).toBe(429);
  });

  it('forgives a caller its earlier mistakes once it gets in', async () => {
    await ownerSignedIn();
    const b = browser(h, '203.0.113.33');
    for (let i = 0; i < 4; i++) await b.post('/auth/login', { password: 'nope nope nope' });
    expect((await b.post('/auth/login', { password: PASSWORD })).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await b.post('/auth/login', { password: 'nope nope nope' })).status).toBe(401);
  });
});

// ---------------------------------------------------------------- never asked again

describe('staying signed in', () => {
  it('renews the session silently once its hour is up, and moves the refresh token on', async () => {
    const b = await ownerSignedIn();
    const firstRefresh = b.jar.get('sl_refresh');
    at(SESSION_S + 5);
    const res = await b.get('/api/latest');
    expect(res.status).toBe(200);
    expect(b.jar.get('sl_refresh')).not.toBe(firstRefresh);
    expect((await status(b)).role).toBe('owner');
  });

  it('stays signed in across a year of opening it now and then', async () => {
    const b = await ownerSignedIn();
    for (let month = 1; month <= 14; month++) {
      at(month * 30 * 86400);
      expect((await status(b)).role, `month ${month}`).toBe('owner');
    }
  });

  it('runs out after a year of not being opened at all', async () => {
    const b = await ownerSignedIn();
    at(366 * 86400);
    expect((await status(b)).role).toBeNull();
    expect(b.jar.size).toBe(0);
  });

  it('lets two tabs renew at the same moment without signing either out', async () => {
    const b = await ownerSignedIn();
    at(SESSION_S + 5);
    const snapshot = new Map(b.jar);
    const [one, two] = await Promise.all([b.withCookies('/auth/status', snapshot), b.withCookies('/auth/status', snapshot)]);
    const roles = [(await one.json() as { role: string }).role, (await two.json() as { role: string }).role];
    expect(roles).toEqual(['owner', 'owner']);
    // Exactly one of them hands out a new refresh token; the other only a session.
    const refreshes = [one, two].filter((r) => r.headers.getSetCookie().some((l) => l.startsWith('sl_refresh=') && !/max-age=0/i.test(l)));
    expect(refreshes).toHaveLength(1);
  });

  it('accepts the token just replaced for two minutes, without renewing again', async () => {
    const b = await ownerSignedIn();
    const old = new Map(b.jar);
    at(SESSION_S + 5);
    await b.get('/auth/status');                 // the real browser renews
    old.delete('sl_session');
    const late = await b.withCookies('/auth/status', old);
    expect(((await late.json()) as { role: string }).role).toBe('owner');
    expect(late.headers.getSetCookie().some((l) => l.startsWith('sl_refresh='))).toBe(false);
  });

  it('signs the device out when a replaced token comes back later: it was copied', async () => {
    const b = await ownerSignedIn();
    const copy = new Map(b.jar);
    copy.delete('sl_session');
    at(SESSION_S + 5);
    await b.get('/auth/status');                 // the real browser renews
    at(SESSION_S + 5 + GRACE_S + 60);
    const thief = await b.withCookies('/auth/status', copy);
    expect(((await thief.json()) as { role: string | null }).role).toBeNull();
    // And the real browser is signed out too, since nobody can tell which is which.
    at(2 * SESSION_S + GRACE_S + 60);
    expect((await status(b)).role).toBeNull();
  });

  it('refuses a refresh token that is neither the current one nor the one before', async () => {
    const b = await ownerSignedIn();
    const id = String(b.jar.get('sl_refresh')).split('.')[0];
    const res = await b.withCookies('/auth/status', new Map([['sl_refresh', `${id}.not-the-token`]]));
    expect(((await res.json()) as { role: string | null }).role).toBeNull();
  });

  it('keeps only hashes of tokens', async () => {
    const b = await ownerSignedIn();
    const token = String(b.jar.get('sl_refresh')).split('.')[1];
    const rows = JSON.stringify(h.d1.raw.prepare('SELECT * FROM auth_devices').all());
    expect(rows).not.toContain(token);
    expect(rows).toContain(await hashToken(token));
  });
});

// ---------------------------------------------------------------- signing out

describe('signing out', () => {
  it('this browser, at once', async () => {
    const b = await ownerSignedIn();
    const copy = new Map(b.jar);
    expect((await b.post('/auth/logout')).status).toBe(200);
    expect(b.jar.size).toBe(0);
    // Even a copy of its cookies, session still in its hour, is refused now.
    expect(((await (await b.withCookies('/auth/status', copy)).json()) as { role: string | null }).role).toBeNull();
  });

  it('another device, from Settings, at once', async () => {
    const phone = await ownerSignedIn();
    const tv = browser(h, '203.0.113.40');
    await tv.post('/auth/login', { password: PASSWORD });
    const list = (await (await phone.get('/auth/settings')).json()) as { devices: { id: string; this: boolean }[] };
    expect(list.devices).toHaveLength(2);
    const other = list.devices.find((d) => !d.this)!;
    expect((await phone.post('/auth/settings/devices/revoke', { id: other.id })).status).toBe(200);
    expect((await status(tv)).role).toBeNull();
    expect((await status(phone)).role).toBe('owner');
  });

  it('every other device at once', async () => {
    const phone = await ownerSignedIn();
    const others = [browser(h, '203.0.113.41'), browser(h, '203.0.113.42')];
    for (const o of others) await o.post('/auth/login', { password: PASSWORD });
    const res = await phone.post('/auth/settings/devices/revoke', { others: true });
    expect(((await res.json()) as { signedOut: number }).signedOut).toBe(2);
    for (const o of others) expect((await status(o)).role).toBeNull();
    expect((await status(phone)).role).toBe('owner');
  });
});

// ---------------------------------------------------------------- the switch

describe('"require sign-in to view"', () => {
  it('cannot be turned on before there is a way to sign in', async () => {
    const b = browser(h);
    await b.post('/auth/setup', { code: CODE, password: null });
    const res = await requireSignIn(b);
    expect(res.status).toBe(409);
  });

  it('closes the reads to a stranger, and leaves them open to the owner', async () => {
    const owner = await ownerSignedIn();
    expect((await requireSignIn(owner)).status).toBe(200);
    const stranger = browser(h, '203.0.113.50');
    const res = await stranger.get('/api/latest');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'signin' });
    for (const path of ['/api/latest', '/api/devices', '/api/health', '/api/history', '/api/alarms']) {
      expect((await owner.get(path)).status, path).toBe(200);
    }
  });

  it('leaves the monitor, the push key and the notification reader open', async () => {
    const owner = await ownerSignedIn();
    await requireSignIn(owner);
    const stranger = browser(h, '203.0.113.51');
    const res = await stranger.get('/api/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { feeds: Record<string, unknown>[] };
    for (const f of body.feeds) expect(Object.keys(f).sort()).toEqual(['ok', 'provider', 'ts']);
    // Not signed up for notifications: refused as such, not for want of a sign-in.
    expect((await stranger.get('/api/push/recent?for=abc')).status).toBe(404);
  });

  it('leaves the relays alone: they carry their own token', async () => {
    const owner = await ownerSignedIn();
    await requireSignIn(owner);
    const res = await h.fetch('/api/ingest/relay', {
      method: 'POST', headers: { 'content-type': 'application/json', ...bearer('ingest-token-for-tests') },
      body: JSON.stringify({ id: 'relay-1', state: 'ok' }),
    });
    expect(res.status).not.toBe(401);
  });

  it('can be turned off again', async () => {
    const owner = await ownerSignedIn();
    await requireSignIn(owner);
    await requireSignIn(owner, false);
    expect((await browser(h, '203.0.113.52').get('/api/latest')).status).toBe(200);
  });

  it('is the owner\'s alone to change', async () => {
    const owner = await ownerSignedIn();
    const res = await browser(h, '203.0.113.53').post('/auth/settings/required', { on: false });
    expect(res.status).toBe(401);
    expect((await status(owner)).required).toBe(false);
  });
});

describe('writes', () => {
  it('need the owner - signed in, or the API token as a header', async () => {
    const owner = await ownerSignedIn();
    const stranger = browser(h, '203.0.113.60');
    expect((await stranger.post('/api/push/test', { endpoint: 'x' })).status).toBe(401);
    expect((await owner.post('/api/push/test', { endpoint: 'x' })).status).not.toBe(401);
    const res = await h.fetch('/api/push/test', { method: 'POST', headers: { 'content-type': 'application/json', ...bearer(CODE) }, body: '{"endpoint":"x"}' });
    expect(res.status).not.toBe(401);
  });

  it('no longer accept the cookie 2.x left, which is the token itself, and clear it', async () => {
    // That cookie could not be signed out short of replacing the token, so a
    // browser holding it is asked to sign in like any other.
    const res = await h.fetch('/api/push/test', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `sl_token=${CODE}` }, body: '{"endpoint":"x"}' });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().some((l) => /^sl_token=;/.test(l) && /max-age=0/i.test(l))).toBe(true);
  });

  it('clear the 2.x cookie on sign-out too', async () => {
    const b = await ownerSignedIn();
    b.jar.set('sl_token', CODE);
    await b.post('/auth/logout');
    expect(b.jar.has('sl_token')).toBe(false);
  });
});

describe('/auth?t=, the 2.x back door', () => {
  it('signs the browser in with a proper session, not the token in a cookie', async () => {
    const res = await h.fetch(`/auth?t=${CODE}`);
    expect(res.status).toBe(302);
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((l) => l.startsWith('sl_refresh='))).toBe(true);
    expect(cookies.join('\n')).not.toContain(CODE);
  });
});

// ---------------------------------------------------------------- share links

describe('a view-only link', () => {
  async function share(owner: ReturnType<typeof browser>, days: number | null = null) {
    const res = await owner.post('/auth/settings/shares', { name: 'Family', days });
    return ((await res.json()) as { url: string; id: string });
  }

  it('lets its holder read, and never write or open Settings', async () => {
    const owner = await ownerSignedIn();
    await requireSignIn(owner);
    const { url } = await share(owner);
    expect(url).toMatch(/^https:\/\/dashboard\.test\/s\//);
    const friend = browser(h, '203.0.113.70');
    const open = await friend.get(new URL(url).pathname);
    expect(open.status).toBe(302);
    expect(open.headers.get('location')).toBe('/');
    expect((await status(friend)).role).toBe('viewer');
    expect((await friend.get('/api/latest')).status).toBe(200);
    expect((await friend.post('/api/push/test', { endpoint: 'x' })).status).toBe(401);
    expect((await friend.get('/auth/settings')).status).toBe(401);
  });

  it('is revoked, and everyone who came through it is signed out', async () => {
    const owner = await ownerSignedIn();
    const { url, id } = await share(owner);
    const friend = browser(h, '203.0.113.71');
    await friend.get(new URL(url).pathname);
    await owner.post('/auth/settings/shares/revoke', { id });
    expect((await status(friend)).role).toBeNull();
    const again = await browser(h, '203.0.113.72').get(new URL(url).pathname);
    expect(again.headers.get('location')).toBe('/?link=expired');
  });

  it('runs out when it was made to, and takes its viewers with it', async () => {
    const owner = await ownerSignedIn();
    const { url } = await share(owner, 7);
    const friend = browser(h, '203.0.113.73');
    await friend.get(new URL(url).pathname);
    at(6 * 86400);
    expect((await status(friend)).role).toBe('viewer');
    at(8 * 86400);
    expect((await status(friend)).role).toBeNull();
    expect((await browser(h, '203.0.113.74').get(new URL(url).pathname)).headers.get('location')).toBe('/?link=expired');
  });

  it('is refused when tampered with', async () => {
    const owner = await ownerSignedIn();
    const { url } = await share(owner);
    const bad = new URL(url).pathname.slice(0, -3) + 'xyz';
    expect((await browser(h, '203.0.113.75').get(bad)).headers.get('location')).toBe('/?link=expired');
    expect((await browser(h, '203.0.113.76').get('/s/nodot')).headers.get('location')).toBe('/?link=expired');
  });

  it('is listed in Settings until revoked', async () => {
    const owner = await ownerSignedIn();
    const { id } = await share(owner);
    const list = async () => ((await (await owner.get('/auth/settings')).json()) as { shares: { id: string }[] }).shares.map((s) => s.id);
    expect(await list()).toEqual([id]);
    await owner.post('/auth/settings/shares/revoke', { id });
    expect(await list()).toEqual([]);
  });
});

// ---------------------------------------------------------------- the password in Settings

describe('changing the password', () => {
  it('needs the current one', async () => {
    const owner = await ownerSignedIn();
    expect((await owner.post('/auth/settings/password', { current: 'wrong', next: 'another long password' })).status).toBe(401);
    expect((await owner.post('/auth/settings/password', { current: PASSWORD, next: 'short' })).status).toBe(400);
    expect((await owner.post('/auth/settings/password', { current: PASSWORD, next: 'another long password' })).status).toBe(200);
    expect((await browser(h, '203.0.113.80').post('/auth/login', { password: 'another long password' })).status).toBe(200);
  });

  it('can be removed only while a passkey remains', async () => {
    const owner = await ownerSignedIn();
    expect((await owner.post('/auth/settings/password', { current: PASSWORD, next: null })).status).toBe(409);
  });

  it('can be set for the first time without a current one', async () => {
    const owner = browser(h);
    await owner.post('/auth/setup', { code: CODE, password: null });
    expect((await owner.post('/auth/settings/password', { next: 'a first long password' })).status).toBe(200);
  });
});

// ---------------------------------------------------------------- passkeys through the routes

describe('passkeys', () => {
  const origin = 'https://dashboard.test';
  const rpId = 'dashboard.test';

  async function addPasskey(owner: ReturnType<typeof browser>) {
    const a = await authenticator();
    const opts = (await (await owner.post('/auth/passkey/options', { purpose: 'register' })).json()) as { challenge: string; rp: { id: string } };
    expect(opts.rp.id).toBe(rpId);
    const res = await owner.post('/auth/passkey/register', { response: await a.register(opts.challenge, origin, rpId), name: 'My phone' });
    expect(res.status).toBe(200);
    return { a, id: ((await res.json()) as { id: string }).id };
  }

  async function signInWith(a: Awaited<ReturnType<typeof authenticator>>, id: string, b = browser(h, '203.0.113.90')) {
    const opts = (await (await b.post('/auth/passkey/options', { purpose: 'login' })).json()) as { challenge: string };
    return { b, res: await b.post('/auth/passkey/login', { id, response: await a.sign(opts.challenge, origin, rpId) }) };
  }

  it('are added by the owner, and then sign in on a new device', async () => {
    const owner = await ownerSignedIn();
    const { a, id } = await addPasskey(owner);
    const { b, res } = await signInWith(a, id);
    expect(res.status).toBe(200);
    expect((await status(b)).role).toBe('owner');
    const settings = (await (await owner.get('/auth/settings')).json()) as { passkeys: { name: string; last_used_at: number }[] };
    expect(settings.passkeys[0].name).toBe('My phone');
    expect(settings.passkeys[0].last_used_at).toBeGreaterThan(0);
  });

  it('cannot be added by a stranger', async () => {
    const stranger = browser(h);
    expect((await stranger.post('/auth/passkey/options', { purpose: 'register' })).status).toBe(401);
    expect((await stranger.post('/auth/passkey/register', { response: {} })).status).toBe(401);
  });

  it('are not locked out by a password lockout', async () => {
    const owner = await ownerSignedIn();
    const { a, id } = await addPasskey(owner);
    const b = browser(h, '203.0.113.91');
    for (let i = 0; i < 6; i++) await b.post('/auth/login', { password: 'nope nope nope' });
    expect((await signInWith(a, id, b)).res.status).toBe(200);
  });

  it('refuse a challenge used twice, or one that ran out', async () => {
    const owner = await ownerSignedIn();
    const { a, id } = await addPasskey(owner);
    const b = browser(h, '203.0.113.92');
    const opts = (await (await b.post('/auth/passkey/options', { purpose: 'login' })).json()) as { challenge: string };
    const signed = await a.sign(opts.challenge, origin, rpId);
    expect((await b.post('/auth/passkey/login', { id, response: signed })).status).toBe(200);
    expect((await b.post('/auth/passkey/login', { id, response: await a.sign(opts.challenge, origin, rpId) })).status).toBe(400);
    const late = (await (await b.post('/auth/passkey/options', { purpose: 'login' })).json()) as { challenge: string };
    at(301);
    expect((await b.post('/auth/passkey/login', { id, response: await a.sign(late.challenge, origin, rpId) })).status).toBe(400);
  });

  it('refuse a passkey this dashboard does not know, or one that does not verify', async () => {
    const owner = await ownerSignedIn();
    const { id } = await addPasskey(owner);
    const stranger = await authenticator();
    expect((await signInWith(stranger, 'unknown-id')).res.status).toBe(401);
    expect((await signInWith(stranger, id)).res.status).toBe(401);
  });

  it('refuse a registration made on another site', async () => {
    const owner = await ownerSignedIn();
    const a = await authenticator();
    const opts = (await (await owner.post('/auth/passkey/options', { purpose: 'register' })).json()) as { challenge: string };
    const res = await owner.post('/auth/passkey/register', { response: await a.register(opts.challenge, 'https://elsewhere.test', rpId) });
    expect(res.status).toBe(400);
  });

  it('keep the last way in while sign-in is required', async () => {
    const owner = browser(h);
    await owner.post('/auth/setup', { code: CODE, password: null });
    const { id } = await addPasskey(owner);
    await requireSignIn(owner);
    expect((await owner.post('/auth/settings/passkeys/remove', { id })).status).toBe(409);
    await requireSignIn(owner, false);
    expect(((await (await owner.post('/auth/settings/passkeys/remove', { id })).json()) as { ok: boolean }).ok).toBe(true);
  });

  it('let the password be removed once one exists', async () => {
    const owner = await ownerSignedIn();
    await addPasskey(owner);
    expect((await owner.post('/auth/settings/password', { current: PASSWORD, next: null })).status).toBe(200);
    expect((await status(owner)).password).toBe(false);
  });
});

// ---------------------------------------------------------------- what the owner sees that nobody else does

describe("a datalogger's network handles", () => {
  it('are served to the owner, and to nobody else', async () => {
    const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...bearer('ingest-token-for-tests') }, body: JSON.stringify(body) });
    await h.fetch('/api/ingest/devices', post({ provider: 'soliscloud', plantId: 'p1', collectors: [{ sn: 'LOG1SERIAL', machine: 'S3-4G', state: 1, lac: 'AREA9', ci: 'CELL9' }] }));
    const owner = await ownerSignedIn();
    const ownerView = await (await owner.get('/api/devices')).text();
    expect(ownerView).toContain('CELL9');
    const stranger = await (await browser(h, '203.0.113.99').get('/api/devices')).text();
    expect(stranger).not.toContain('CELL9');
    expect(stranger).not.toContain('AREA9');
  });
});

describe('caching', () => {
  it('keeps every answer out of every cache, so a sign-out cannot be undone by one', async () => {
    const b = browser(h);
    for (const path of ['/api/latest', '/api/devices', '/api/health', '/api/series', '/api/history', '/api/alarms', '/api/periods', '/api/devices/history', '/auth/status']) {
      expect((await b.get(path)).headers.get('cache-control'), path).toBe('no-store');
    }
  });
});
