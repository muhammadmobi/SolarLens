/**
 * Notifications that reach a closed browser.
 *
 * Three things are held here. The signature a push service checks is a real
 * ES256 signature over the right claims, verified with the public half the
 * browser was given. The rules for what is worth waking a phone for say what
 * they mean - above all, that a system going quiet at dusk is not news. And
 * the routes keep signing a device up behind the key, while letting anyone
 * turn their own device off.
 *
 * The push services themselves are a stubbed fetch: nothing here sends a
 * notification anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, createHarness, testInverter, testReading, type Harness } from '../helpers/worker';
import { insertReading, upsertAlarms, upsertInverter } from '../../src/db';
import {
  MAX_SUBSCRIPTIONS, announce, audienceOf, forgetOldMessages, isPushEndpoint, pushEvents, recentMessages,
  subscribe, vapidHeader, vapidKey, vapidPublicKey, wake,
} from '../../src/push';

const API = 'api-token-for-tests';
const FCM = 'https://fcm.googleapis.com/fcm/send/device-one';
const NOW = 1_790_000_000;

async function makeKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
}

const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

/** The push services: every POST is recorded, and answered with `status`. */
function stubPushServices(status = 201) {
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response(null, { status });
  }));
  return sent;
}

afterEach(() => { vi.unstubAllGlobals(); });

// ------------------------------------------------------------------ keys

describe('the signing key', () => {
  it('is read from a private P-256 JWK, and refused in any other shape', async () => {
    expect(vapidKey({ VAPID_KEY: await makeKey() })).not.toBeNull();
    expect(vapidKey({})).toBeNull();
    expect(vapidKey({ VAPID_KEY: 'not json' })).toBeNull();
    expect(vapidKey({ VAPID_KEY: JSON.stringify({ kty: 'EC', crv: 'P-384', x: 'a', y: 'b', d: 'c' }) })).toBeNull();
    expect(vapidKey({ VAPID_KEY: JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }) })).toBeNull();
  });

  it('hands the browser the public half as an uncompressed point', async () => {
    const key = vapidKey({ VAPID_KEY: await makeKey() })!;
    const point = fromB64url(vapidPublicKey(key));
    expect(point).toHaveLength(65);
    expect(point[0]).toBe(4);
  });

  it('signs a token the push service can verify with that public half', async () => {
    const key = vapidKey({ VAPID_KEY: await makeKey() })!;
    const header = await vapidHeader(key, FCM, 'https://dashboard.test', NOW);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(m).not.toBeNull();

    const claims = JSON.parse(new TextDecoder().decode(fromB64url(m[2])));
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: NOW + 12 * 3600, sub: 'https://dashboard.test' });
    expect(JSON.parse(new TextDecoder().decode(fromB64url(m[1])))).toEqual({ typ: 'JWT', alg: 'ES256' });

    const pub = await crypto.subtle.importKey('raw', fromB64url(m[4]), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64url(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`));
    expect(ok).toBe(true);
  });
});

describe('a push endpoint', () => {
  it('is one of the push services browsers use, over https', () => {
    for (const ok of [
      FCM,
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QGx',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) expect(isPushEndpoint(ok)).toBe(true);
  });

  it('is not any other URL - the Worker will POST to it on every alert', () => {
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://example.com/push',
      'not a url',
      42,
      'https://fcm.googleapis.com/' + 'x'.repeat(3000),
    ]) expect(isPushEndpoint(bad)).toBe(false);
  });
});

// ------------------------------------------------------------------ rules

describe('what is worth waking a phone for', () => {
  let h: Harness;
  beforeEach(() => { h = createHarness(); });
  afterEach(() => h.close());

  const plant = (over: Record<string, unknown> = {}) => upsertInverter(h.env.DB, testInverter(over) as never);
  const read = (ts: number, acPowerW: number, over: Record<string, unknown> = {}) =>
    insertReading(h.env.DB, testReading({ ts, acPowerW, ...over }) as never);

  it('a system that stopped reporting while it was producing', async () => {
    await plant();
    await read(NOW - 40 * 60, 2400);
    const [e] = await pushEvents(h.env.DB, NOW);
    expect(e).toMatchObject({ key: `quiet:solarman:station:s-test:${NOW - 40 * 60}`, title: 'Test Plant: stopped reporting' });
    expect(e.body).toMatch(/when it was producing 2\.4 kW/);
  });

  it('not a system that went quiet at dusk, having produced nothing for its last reading', async () => {
    await plant();
    await read(NOW - 3 * 3600, 0);
    expect(await pushEvents(h.env.DB, NOW)).toEqual([]);
  });

  it('not a system that is merely a little late', async () => {
    await plant();
    await read(NOW - 20 * 60, 2400);
    expect(await pushEvents(h.env.DB, NOW)).toEqual([]);
  });

  it('names the relay laptop as the likely cause for a relay-fed system', async () => {
    await plant();
    await read(NOW - 40 * 60, 2400, { source: 'soliscloud-relay' });
    const [e] = await pushEvents(h.env.DB, NOW);
    expect(e.body).toMatch(/relay laptop/);
  });

  it('tells the time in the plant\'s own zone', async () => {
    await plant({ tzOffsetSec: 5 * 3600 });
    const ts = Math.floor(Date.UTC(2026, 8, 1, 9, 0, 0) / 1000);   // 14:00 at +5
    await read(ts, 2400);
    const [e] = await pushEvents(h.env.DB, ts + 40 * 60);
    expect(e.body).toMatch(/Nothing since 14:00/);
  });

  it('a fault first seen within six hours, saying whether it has cleared', async () => {
    await plant();
    await upsertAlarms(h.env.DB, [{
      id: 'solarman:s-test:7:1', inverterId: 'solarman:station:s-test', provider: 'solarman', code: '7',
      message: 'DC volt low fault', severity: 'fault', vendorLevel: 2, advice: 'Check the DC connectors.',
      beginTs: NOW - 3600, endTs: NOW - 3300, state: 'recovered',
    }], NOW - 60);
    const [e] = await pushEvents(h.env.DB, NOW);
    expect(e.title).toBe('Test Plant: DC volt low fault');
    expect(e.body).toMatch(/^Fault\. Began .*, cleared .*\. Check the DC connectors\.$/);
  });

  it('not the history that arrives when a feed is first connected', async () => {
    await plant();
    await upsertAlarms(h.env.DB, [{
      id: 'solarman:s-test:7:old', inverterId: 'solarman:station:s-test', provider: 'solarman', code: '7',
      message: null, severity: null, vendorLevel: null, advice: 'No Action Required',
      beginTs: NOW - 90 * 86400, endTs: null, state: 'unknown',
    }], NOW - 60);
    expect(await pushEvents(h.env.DB, NOW)).toEqual([]);
  });

  it('leaves out advice that says to do nothing', async () => {
    await plant();
    await upsertAlarms(h.env.DB, [{
      id: 'soliscloud:s-test:1015:1', inverterId: 'solarman:station:s-test', provider: 'soliscloud', code: '1015',
      message: 'NO-Grid', severity: 'warning', vendorLevel: 1, advice: 'No Action Required',
      beginTs: NOW - 600, endTs: null, state: 'active',
    }], NOW - 60);
    const [e] = await pushEvents(h.env.DB, NOW);
    expect(e.body).toBe(`Warning. Began ${clockOf(NOW - 600)}, still active.`);
  });

  const clockOf = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 16);

  it('a SolisCloud login two days out, and one that has run out, named as the dashboard names them', async () => {
    const relay = (id: string, name: string | null, state: string, exp: number | null, first: number) =>
      h.env.DB.prepare(`INSERT INTO relays (id, provider, name, state, login_expires_at, first_seen, last_seen)
                        VALUES (?1, 'soliscloud', ?2, ?3, ?4, ?5, ?6)`).bind(id, name, state, exp, first, NOW - 60).run();
    await relay('r-a', null, 'ok', NOW + 30 * 3600, NOW - 10 * 86400);
    await relay('r-b', 'Office laptop', 'login-expired', NOW - 3600, NOW - 9 * 86400);
    await relay('r-c', null, 'ok', NOW + 6 * 86400, NOW - 8 * 86400);

    const events = await pushEvents(h.env.DB, NOW);
    expect(events.map((e) => e.title)).toEqual([
      'SolisCloud login on Relay 1 runs out in 30 h',
      'SolisCloud login expired on Office laptop',
    ]);
    // The relay's own id stays in the key, which is never served.
    expect(events[1].key).toBe(`relay-expired:r-b:${NOW - 3600}`);
    expect(events.map((e) => e.title + e.body).join(' ')).not.toMatch(/r-[abc]/);
  });

  it('a vendor whose last three reads failed across a quarter of an hour, and not one hiccup', async () => {
    const log = (ts: number, provider: string, ok: number, detail: string) =>
      h.env.DB.prepare('INSERT INTO poll_log (ts, provider, ok, detail) VALUES (?1, ?2, ?3, ?4)').bind(ts, provider, ok, detail).run();
    await log(NOW - 20 * 60, 'solarman', 0, 'HTTP 401');
    await log(NOW - 10 * 60, 'solarman', 0, 'HTTP 401');
    await log(NOW - 60, 'solarman', 0, 'solarman-web: refresh refused - token expired');
    await log(NOW - 20 * 60, 'soliscloud', 1, 'ok');
    await log(NOW - 60, 'soliscloud', 0, 'timeout');

    const events = await pushEvents(h.env.DB, NOW);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: `poll:solarman:${NOW - 20 * 60}`, title: 'SolarMan is not answering' });
    expect(events[0].body).toMatch(/refresh refused/);
  });
});

// ------------------------------------------------------------------ sending

describe('announcing', () => {
  let h: Harness;
  beforeEach(async () => { h = createHarness({ VAPID_KEY: await makeKey() }); });
  afterEach(() => h.close());

  async function trouble() {
    await upsertInverter(h.env.DB, testInverter() as never);
    await insertReading(h.env.DB, testReading({ ts: NOW - 40 * 60, acPowerW: 2400 }) as never);
  }

  it('costs nothing when no device is listening', async () => {
    await trouble();
    const sent = stubPushServices();
    expect(await announce(h.env, NOW)).toBe(0);
    expect(sent).toEqual([]);
  });

  it('wakes every device once for something new, and not again for the same thing', async () => {
    await trouble();
    await subscribe(h.env.DB, FCM, 'https://dashboard.test', NOW);
    await subscribe(h.env.DB, 'https://updates.push.services.mozilla.com/wpush/v2/two', 'https://dashboard.test', NOW);
    const sent = stubPushServices();

    expect(await announce(h.env, NOW)).toBe(1);
    expect(sent.map((s) => s.url)).toEqual([FCM, 'https://updates.push.services.mozilla.com/wpush/v2/two']);
    expect(sent[0].headers.authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(sent[0].headers.ttl).toBe(String(24 * 3600));

    const messages = await recentMessages(h.env.DB, '', NOW);
    expect(messages).toEqual([expect.objectContaining({ title: 'Test Plant: stopped reporting' })]);

    expect(await announce(h.env, NOW + 300)).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it('records what is already wrong without telling anyone, when priming', async () => {
    await trouble();
    await subscribe(h.env.DB, FCM, 'https://dashboard.test', NOW);
    const sent = stubPushServices();
    expect(await announce(h.env, NOW, true)).toBe(0);
    expect(await announce(h.env, NOW + 300)).toBe(0);
    expect(sent).toEqual([]);
  });

  it('forgets a device its browser has dropped', async () => {
    await subscribe(h.env.DB, FCM, 'https://dashboard.test', NOW);
    stubPushServices(410);
    expect(await wake(h.env, { endpoint: FCM, origin: 'https://dashboard.test', audience: await audienceOf(FCM) }, NOW)).toBe(false);
    expect(await h.env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first()).toEqual({ n: 0 });
  });

  it('counts other failures, and gives up on a device after fifty in a row', async () => {
    await subscribe(h.env.DB, FCM, 'https://dashboard.test', NOW);
    const sub = { endpoint: FCM, origin: 'https://dashboard.test', audience: await audienceOf(FCM) };
    stubPushServices(500);
    await wake(h.env, sub, NOW);
    expect(await h.env.DB.prepare('SELECT failures FROM push_subscriptions').first()).toEqual({ failures: 1 });
    await h.env.DB.prepare('UPDATE push_subscriptions SET failures = 49').run();
    await wake(h.env, sub, NOW);
    expect(await h.env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first()).toEqual({ n: 0 });
  });

  it('survives a push service that cannot be reached at all', async () => {
    await subscribe(h.env.DB, FCM, 'https://dashboard.test', NOW);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await wake(h.env, { endpoint: FCM, origin: 'https://dashboard.test', audience: 'x' }, NOW)).toBe(false);
  });

  it('keeps messages a week', async () => {
    await h.env.DB.prepare("INSERT INTO push_messages (id, ts, title, body) VALUES ('old', ?1, 't', 'b'), ('new', ?2, 't', 'b')")
      .bind(NOW - 8 * 86400, NOW - 86400).run();
    await forgetOldMessages(h.env.DB, NOW);
    const { results } = await h.env.DB.prepare('SELECT id FROM push_messages').all();
    expect(results).toEqual([{ id: 'new' }]);
  });

  it('is judged after every cron poll', async () => {
    await trouble();
    await subscribe(h.env.DB, FCM, 'https://dashboard.test', Math.floor(Date.now() / 1000));
    await h.env.DB.prepare('UPDATE readings SET ts = ?1').bind(Math.floor(Date.now() / 1000) - 40 * 60).run();
    const sent = stubPushServices();
    await h.cron();
    expect(sent.map((s) => s.url)).toContain(FCM);
  });
});

// ------------------------------------------------------------------ routes

describe('the push routes', () => {
  let h: Harness;
  beforeEach(async () => { h = createHarness({ VAPID_KEY: await makeKey() }); });
  afterEach(() => h.close());

  const post = (path: string, body: unknown, auth = true) => h.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? bearer(API) : {}) },
    body: JSON.stringify(body),
  });

  it('serves the public half of the key, and says plainly when there is none', async () => {
    const res = await h.fetch('/api/push/key');
    expect(res.status).toBe(200);
    expect((await res.json() as { publicKey: string }).publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);

    const bare = createHarness();
    const none = await bare.fetch('/api/push/key');
    expect(none.status).toBe(404);
    expect((await bare.fetch('/api/push/subscribe', { method: 'POST', headers: bearer(API), body: JSON.stringify({ endpoint: FCM }) })).status).toBe(503);
    bare.close();
  });

  it('signs a device up only with the key, and sends it a first message', async () => {
    const sent = stubPushServices();
    expect((await post('/api/push/subscribe', { endpoint: FCM }, false)).status).toBe(401);
    expect((await post('/api/push/subscribe', { endpoint: 'https://example.com/x' })).status).toBe(400);

    const res = await post('/api/push/subscribe', { endpoint: FCM });
    expect(await res.json()).toEqual({ ok: true, state: 'added' });
    expect(await h.env.DB.prepare('SELECT origin FROM push_subscriptions').first()).toEqual({ origin: 'https://dashboard.test' });
    expect(sent.map((s) => s.url)).toEqual([FCM]);

    // The first message is for that device alone.
    const mine = await (await h.fetch(`/api/push/recent?for=${await audienceOf(FCM)}`)).json() as { messages: Array<{ title: string }> };
    expect(mine.messages.map((m) => m.title)).toEqual(['Notifications are on']);
    const others = await (await h.fetch('/api/push/recent?for=someone-else')).json() as { messages: unknown[] };
    expect(others.messages).toEqual([]);

    expect(await (await post('/api/push/subscribe', { endpoint: FCM })).json()).toEqual({ ok: true, state: 'known' });
  });

  it('refuses devices past the limit', async () => {
    stubPushServices();
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) await subscribe(h.env.DB, `${FCM}-${i}`, 'https://dashboard.test', NOW);
    expect((await post('/api/push/subscribe', { endpoint: FCM })).status).toBe(409);
  });

  it('lets any device turn itself off without the key', async () => {
    await subscribe(h.env.DB, FCM, 'https://dashboard.test', NOW);
    const res = await post('/api/push/unsubscribe', { endpoint: FCM }, false);
    expect(await res.json()).toEqual({ ok: true, removed: true });
    expect((await post('/api/push/unsubscribe', {}, false)).status).toBe(400);
  });

  it('sends a test only with the key, and only to a device that is signed up', async () => {
    const sent = stubPushServices();
    await subscribe(h.env.DB, FCM, 'https://dashboard.test', NOW);
    expect((await post('/api/push/test', { endpoint: FCM }, false)).status).toBe(401);
    expect((await post('/api/push/test', { endpoint: FCM })).status).toBe(200);
    expect((await post('/api/push/test', { endpoint: `${FCM}-unknown` })).status).toBe(404);
    expect((await post('/api/push/test', {})).status).toBe(400);
    expect(sent).toHaveLength(1);
  });

  it('never caches what a woken device reads, and never serves an endpoint', async () => {
    stubPushServices();
    await post('/api/push/subscribe', { endpoint: FCM });
    const res = await h.fetch(`/api/push/recent?for=${await audienceOf(FCM)}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).not.toContain('device-one');
  });
});

// ------------------------------------------------------------------ edges

describe('the edges of each rule', () => {
  let h: Harness;
  beforeEach(() => { h = createHarness(); });
  afterEach(() => h.close());

  it('reads a small system in watts, with no stated size or zone', async () => {
    await upsertInverter(h.env.DB, testInverter({ capacityW: null, tzOffsetSec: null }) as never);
    await insertReading(h.env.DB, testReading({ ts: NOW - 40 * 60, acPowerW: 600 }) as never);
    const [e] = await pushEvents(h.env.DB, NOW);
    expect(e.body).toBe(`Nothing since ${new Date((NOW - 40 * 60) * 1000).toISOString().slice(11, 16)}, when it was producing 600 W.`);
  });

  it('treats a reading with no power figure as not producing', async () => {
    await upsertInverter(h.env.DB, testInverter() as never);
    await insertReading(h.env.DB, testReading({ ts: NOW - 40 * 60, acPowerW: null }) as never);
    expect(await pushEvents(h.env.DB, NOW)).toEqual([]);
  });

  it('names a fault by its code when the vendor gave it no words, and says nothing it does not know', async () => {
    await upsertInverter(h.env.DB, testInverter() as never);
    await upsertAlarms(h.env.DB, [{
      id: 'solarman:s-test:9:1', inverterId: 'solarman:station:s-test', provider: 'solarman', code: '9',
      message: null, severity: null, vendorLevel: null, advice: null,
      beginTs: NOW - 600, endTs: null, state: 'unknown',
    }], NOW - 60);
    const [e] = await pushEvents(h.env.DB, NOW);
    expect(e.title).toBe('Test Plant: fault 9');
    expect(e.body).toBe(`Began ${new Date((NOW - 600) * 1000).toISOString().slice(11, 16)}.`);
  });

  it('handles a login reported expired with no date, and one exactly two days out', async () => {
    const relay = (id: string, state: string, exp: number | null, first: number) =>
      h.env.DB.prepare(`INSERT INTO relays (id, provider, name, state, login_expires_at, first_seen, last_seen)
                        VALUES (?1, 'soliscloud', NULL, ?2, ?3, ?4, ?5)`).bind(id, state, exp, first, NOW - 60).run();
    await relay('r-a', 'login-expired', null, NOW - 9 * 86400);
    await relay('r-b', 'ok', NOW + 2 * 86400, NOW - 8 * 86400);
    const events = await pushEvents(h.env.DB, NOW);
    expect(events.map((e) => e.key)).toEqual(['relay-expired:r-a:unknown', `relay-expiring:r-b:${NOW + 2 * 86400}`]);
    expect(events[1].title).toBe('SolisCloud login on Relay 2 runs out in 2 days');
  });

  it('waits a quarter of an hour of failures, and names a vendor it does not know by its own id', async () => {
    const log = (ts: number, provider: string, detail: string | null) =>
      h.env.DB.prepare('INSERT INTO poll_log (ts, provider, ok, detail) VALUES (?1, ?2, 0, ?3)').bind(ts, provider, detail).run();
    await log(NOW - 10 * 60, 'solarman', 'x');
    await log(NOW - 5 * 60, 'solarman', 'x');
    await log(NOW - 60, 'solarman', 'x');
    expect(await pushEvents(h.env.DB, NOW)).toEqual([]);

    await log(NOW - 30 * 60, 'other-cloud', null);
    await log(NOW - 20 * 60, 'other-cloud', null);
    await log(NOW - 10 * 60, 'other-cloud', null);
    await log(NOW - 30 * 60, 'none', 'no provider credentials configured');
    const [e] = await pushEvents(h.env.DB, NOW);
    expect(e.title).toBe('other-cloud is not answering');
    expect(e.body).toBe('The last three reads failed: no detail given');
  });

  it('sends nothing without a key to sign with', async () => {
    const sent = stubPushServices();
    expect(await wake(h.env, { endpoint: FCM, origin: 'https://dashboard.test', audience: 'x' }, NOW)).toBe(false);
    expect(await announce(h.env, NOW)).toBe(0);
    expect(sent).toEqual([]);
  });

  it('reports removing a device that was never there as nothing removed', async () => {
    const res = await h.fetch('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: FCM }) });
    expect(await res.json()).toEqual({ ok: true, removed: false });
  });

  it('never lets a failure to notify cost a reading', async () => {
    const withKey = createHarness({ VAPID_KEY: await makeKey() });
    await withKey.env.DB.prepare('DROP TABLE push_subscriptions').run();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await withKey.cron();
    expect(errors).toHaveBeenCalledWith('push:', expect.stringMatching(/push_subscriptions/));
    errors.mockRestore();
    withKey.close();
  });
});
