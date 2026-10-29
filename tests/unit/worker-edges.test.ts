/**
 * The paths that only show up when something is unusual: the generic ingest
 * route, a Worker deployed without its token, the token store the SolarMan
 * clients keep their session in, and the vendor calls that fetch hardware
 * detail. Each one is a place where a mistake is quiet rather than loud.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bearer, createHarness, testInverter } from '../helpers/worker';
import { createTestD1 } from '../helpers/d1';
import { RAW_KEEP_S, dbBytes, forgetExpiredKv, forgetOldRaw, latestPerProvider, logPoll, nowSec, recentPolls, tokenStore } from '../../src/db';
import { SolarmanWebProvider, queue as webQueue } from '../../src/providers/solarman-web';
import type { TokenStore } from '../../src/providers/solarman';

/** A session already in hand, so a test about devices is not a test about logging in. */
function memoryTokens(): TokenStore {
  const shelf = new Map<string, { accessToken: string; expiresAt: number }>([
    ['solarman-web', { accessToken: 'access', expiresAt: Math.floor(Date.now() / 1000) + 3600 }],
    ['solarman', { accessToken: 'access', expiresAt: Math.floor(Date.now() / 1000) + 3600 }],
  ]);
  return {
    async get(p) { return shelf.get(p) ?? null; },
    async set(p, accessToken, expiresAt) { shelf.set(p, { accessToken, expiresAt }); },
  };
}

const INGEST = 'ingest-token-for-tests';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('POST /api/ingest, the route a local agent uses', () => {
  // A POST to /api/ingest with the relay's token.
  const push = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(INGEST) },
    body: JSON.stringify(body),
  });

  it('stores an inverter and its reading, and fills in the missing fields', async () => {
    const h = createHarness();
    const res = await h.fetch('/api/ingest', push({
      inverter: testInverter({ id: 'local:meter-1', provider: 'solarman' }),
      reading: { ts: 0, source: '', acPowerW: 500, dcPowerW: null, todayKwh: null, totalKwh: null, batterySoc: null, batteryPowerW: null, gridPowerW: null, loadPowerW: null, tempC: null, status: null, metrics: null, raw: null },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stored: true });

    // ts defaulted to now, source defaulted to 'local'.
    const row = h.d1.raw.prepare('SELECT ts, source FROM readings').get() as { ts: number; source: string };
    expect(row.source).toBe('local');
    expect(Math.abs(row.ts - nowSec())).toBeLessThan(5);
    h.close();
  });

  it('refuses a body without an inverter id or a reading', async () => {
    const h = createHarness();
    expect((await h.fetch('/api/ingest', push({ reading: {} }))).status).toBe(400);
    expect((await h.fetch('/api/ingest', push({ inverter: { id: 'x' } }))).status).toBe(400);
    h.close();
  });

  it('checks every field of what it is given, as a normaliser would, and keeps to INCLUDE_PLANTS', async () => {
    const h = createHarness({ INCLUDE_PLANTS: 'only-this-plant' });
    const reading = { ts: 1_790_000_000, source: 'modbus', acPowerW: 500 };
    const refused = async (inverter: Record<string, unknown>, r: Record<string, unknown> = reading) => {
      const res = await h.fetch('/api/ingest', push({ inverter: { ...testInverter({ id: 'local:meter-1', plantId: 'only-this-plant' }), ...inverter }, reading: r }));
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: string }).error;
    };
    expect(await refused({ id: 'has a space' })).toMatch(/inverter.id/);
    expect(await refused({ provider: 'someone-else' })).toMatch(/inverter.provider/);
    expect(await refused({ name: 'x'.repeat(200) })).toMatch(/inverter.name/);
    expect(await refused({ capacityW: 'big' })).toMatch(/capacityW/);
    expect(await refused({}, { ...reading, ts: 'yesterday' })).toMatch(/reading.ts/);
    expect(await refused({}, { ...reading, acPowerW: '500 W' })).toMatch(/reading.acPowerW/);
    expect(await refused({}, { ...reading, metrics: [1, 2] })).toMatch(/reading.metrics/);
    const elsewhere = await h.fetch('/api/ingest', push({ inverter: testInverter({ id: 'local:meter-2', plantId: 'another-plant' }), reading }));
    expect(await elsewhere.json()).toEqual({ stored: false, skipped: 'not in INCLUDE_PLANTS' });
    const ok = await h.fetch('/api/ingest', push({ inverter: testInverter({ id: 'local:meter-1', plantId: 'only-this-plant' }), reading }));
    expect(await ok.json()).toEqual({ stored: true });
    h.close();
  });

  it('answers a body that is not JSON with 400, on every ingest route', async () => {
    const h = createHarness();
    for (const path of ['/api/ingest', '/api/ingest/station', '/api/ingest/devices', '/api/ingest/relay', '/api/ingest/alarms', '/api/ingest/periods', '/api/ingest/history']) {
      const res = await h.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...bearer(INGEST) }, body: '{not json' });
      expect(res.status, path).toBe(400);
    }
    h.close();
  });

  it('refuses a device list longer than any plant has: fifty records at most', async () => {
    const h = createHarness();
    const devices = (n: number) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(INGEST) },
      body: JSON.stringify({ provider: 'soliscloud', plantId: 'p-1', inverters: Array.from({ length: n }, (_, i) => ({ sn: `SN-${i}` })) }),
    });
    const refused = await h.fetch('/api/ingest/devices', devices(51));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'too many devices' });
    expect((await h.fetch('/api/ingest/devices', devices(50))).status).toBe(200);
    h.close();
  });
});

describe('the five-minute cron, when the poll itself fails', () => {
  it('logs the failure, and still judges the alerts after it', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const h = createHarness({ VAPID_KEY: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)) });
    // The poll log refusing every line: with no vendor set up, logging that is all a poll does, so the poll itself fails.
    h.d1.raw.exec("CREATE TRIGGER refuse_log BEFORE INSERT ON poll_log BEGIN SELECT RAISE(ABORT, 'the poll log is refusing'); END");
    // The alerts failing in a way of their own, which shows they were still judged after the poll failed.
    h.d1.raw.exec('DROP TABLE push_subscriptions');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await h.cron();
    expect(errors.mock.calls.map(([where, what]) => [where, /poll log is refusing|push_subscriptions/.exec(String(what))?.[0]])).toEqual([
      ['poll:', 'poll log is refusing'],
      ['push:', 'push_subscriptions'],
    ]);
    h.close();
  });
});

describe('a Worker deployed without API_TOKEN', () => {
  it('refuses every write, and says what to set, while reads stay as open as the dashboard is', async () => {
    const h = createHarness({ API_TOKEN: undefined });
    for (const [method, path] of [['POST', '/api/poll'], ['PUT', '/api/settings/tariff'], ['POST', '/api/push/test'], ['DELETE', '/api/settings/apps/x']]) {
      const res = await h.fetch(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' });
      expect(res.status, path).toBe(503);
      expect(((await res.json()) as { error: string }).error, path).toMatch(/API_TOKEN/);
    }
    expect((await h.fetch('/api/latest')).status).toBe(200);
    h.close();
  });
});

describe('the poll log', () => {
  it('keeps the newest line per provider, whichever logged last', async () => {
    const d1 = createTestD1();
    // Written a minute apart: three writes inside one second would leave
    // "newest" up to insertion order, which is not what this is about.
    const insert = d1.raw.prepare('INSERT INTO poll_log (ts, provider, ok, detail) VALUES (?, ?, ?, ?)');
    insert.run(nowSec() - 120, 'solarman', 1, 'first');
    insert.run(nowSec() - 60, 'soliscloud', 0, 'relay quiet');
    insert.run(nowSec(), 'solarman', 1, 'second');
    const newest = latestPerProvider(await recentPolls(d1.db));
    expect(newest.find((r) => r.provider === 'solarman')).toMatchObject({ detail: 'second' });
    expect(newest.find((r) => r.provider === 'soliscloud')).toMatchObject({ ok: 0, detail: 'relay quiet' });
    d1.close();
  });

  it('shortens a detail too long to be a summary of anything', async () => {
    const d1 = createTestD1();
    await logPoll(d1.db, 'solarman', false, 'x'.repeat(5000));
    const [row] = await recentPolls(d1.db);
    expect(row.detail.length).toBeLessThan(5000);
    d1.close();
  });

  it('drops lines old enough that nobody is looking at them', async () => {
    const d1 = createTestD1();
    vi.spyOn(Math, 'random').mockReturnValue(0); // the prune happens on 2% of writes
    const old = nowSec() - 40 * 86400;
    d1.raw.prepare('INSERT INTO poll_log (ts, provider, ok, detail) VALUES (?, ?, ?, ?)').run(old, 'solarman', 1, 'ancient');
    await logPoll(d1.db, 'solarman', true, 'today');
    const remaining = d1.raw.prepare('SELECT COUNT(*) AS n FROM poll_log WHERE detail = ?').get('ancient') as { n: number };
    expect(remaining.n).toBe(0);
    d1.close();
  });
});

describe('the token store the SolarMan clients share', () => {
  it('returns nothing before a token is stored, then what was stored', async () => {
    const d1 = createTestD1();
    const store = tokenStore(d1.db);
    expect(await store.get('solarman')).toBeNull();

    await store.set('solarman', 'access-1', 1_700_000_000);
    expect(await store.get('solarman')).toEqual({ accessToken: 'access-1', expiresAt: 1_700_000_000 });

    // A refresh replaces the row rather than adding a second one.
    await store.set('solarman', 'access-2', 1_700_003_600);
    expect(await store.get('solarman')).toEqual({ accessToken: 'access-2', expiresAt: 1_700_003_600 });
    expect((d1.raw.prepare('SELECT COUNT(*) AS n FROM tokens').get() as { n: number }).n).toBe(1);
    d1.close();
  });

  it('keeps providers' + "'" + ' tokens apart', async () => {
    const d1 = createTestD1();
    const store = tokenStore(d1.db);
    await store.set('solarman', 'a', 1);
    await store.set('solarman-web', 'b', 2);
    expect((await store.get('solarman'))?.accessToken).toBe('a');
    expect((await store.get('solarman-web'))?.accessToken).toBe('b');
    d1.close();
  });
});

describe('SolarMan web: the hardware behind a station', () => {
  /** A fetch answering from a table of URL fragments. */
  function stubFetch(routes: Array<[string, unknown]>) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const hit = routes.find(([frag]) => url.includes(frag));
      if (!hit) return new Response('{}', { status: 404 });
      const body = typeof hit[1] === 'function' ? (hit[1] as () => unknown)() : hit[1];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    return calls;
  }

  it('asks for the inverter list, the datalogger list and each inverter\'s own page', async () => {
    webQueue.minGapMs = 0;
    const calls = stubFetch([
      ['/account/v1.0/token', { access_token: 'a', expires_in: 3600 }],
      ['deviceType=INVERTER', [{ deviceSn: 'INV1', deviceId: 11, deviceType: 'INVERTER' }]],
      ['deviceType=COLLECTOR', [{ deviceSn: 'LOG1', deviceId: 12, deviceType: 'COLLECTOR' }]],
      ['/device/v3/detail', { deviceSn: 'INV1', deviceId: 11 }],
    ]);
    const p = new SolarmanWebProvider({ refreshToken: 'r', accessToken: 'a' }, memoryTokens());
    const devices = await p.listDevices('62000000');

    expect(devices.map((d) => d.kind)).toContain('inverter');
    expect(devices.map((d) => d.kind)).toContain('datalogger');
    expect(calls.some((u) => u.includes('deviceType=COLLECTOR'))).toBe(true);
    expect(calls.some((u) => u.includes('v3/detail'))).toBe(true);
  });

  it('still returns the devices it has when a list or a detail page fails', async () => {
    webQueue.minGapMs = 0;
    stubFetch([
      ['/account/v1.0/token', { access_token: 'a', expires_in: 3600 }],
      ['deviceType=INVERTER', [{ deviceSn: 'INV1', deviceId: 11, deviceType: 'INVERTER' }]],
      // COLLECTOR and the detail page both 404 through the stub's fallback.
    ]);
    const p = new SolarmanWebProvider({ refreshToken: 'r', accessToken: 'a' }, memoryTokens());
    const devices = await p.listDevices('62000000');
    expect(devices.length).toBeGreaterThan(0);
    expect(devices[0].kind).toBe('inverter');
  });

  it('names a station the portal did not list, rather than failing', async () => {
    webQueue.minGapMs = 0;
    stubFetch([['/account/v1.0/token', { access_token: 'a', expires_in: 3600 }]]);
    const p = new SolarmanWebProvider({ refreshToken: 'r', accessToken: 'a' }, memoryTokens());
    const [inv] = await p.listInverters('62000000');
    expect(inv.plantName || inv.name).toContain('62000000');
  });
});

describe('a number of days that is not a number', () => {
  it('is the default, not NaN in a query', async () => {
    const h = createHarness();
    const alarms = await h.fetch('/api/alarms?days=abc');
    expect(alarms.status).toBe(200);
    expect(await alarms.json()).toMatchObject({ days: 730 });
    const history = await h.fetch('/api/history?days=abc');
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ days: 30 });
    expect(await (await h.fetch('/api/history?days=9999')).json()).toMatchObject({ days: 400 });
    h.close();
  });
});

describe('the database, kept in bounds', () => {
  it('clears the vendor payload from readings past RAW_KEEP_S, a day a run, from where the last run stopped', async () => {
    const d1 = createTestD1();
    const now = 1_790_000_000;
    const put = d1.raw.prepare("INSERT INTO readings (inverter_id, ts, source, ac_power_w, raw) VALUES ('s', ?, 'test', 1, '{\"big\":1}')");
    const oldest = now - RAW_KEEP_S - 3 * 86400;
    for (const ts of [oldest, oldest + 3600, oldest + 86400 + 60, now - RAW_KEEP_S + 60, now - 60]) put.run(ts);
    const withRaw = () => (d1.raw.prepare('SELECT COUNT(*) AS n FROM readings WHERE raw IS NOT NULL').get() as { n: number }).n;
    // The first run starts at the oldest reading and clears a day.
    expect(await forgetOldRaw(d1.db, now)).toBe(2);
    expect(withRaw()).toBe(3);
    // The next picks up where it stopped: the next day, then the day after, which holds nothing.
    expect(await forgetOldRaw(d1.db, now)).toBe(1);
    expect(await forgetOldRaw(d1.db, now)).toBe(0);
    // Readings inside the month keep theirs, however many runs go by.
    for (let i = 0; i < 5; i++) await forgetOldRaw(d1.db, now);
    expect(withRaw()).toBe(2);
    d1.close();
  });

  it("forgets kv entries past their expiry, and keeps the told-state and the weeks' claims", async () => {
    const d1 = createTestD1();
    const now = 1_790_000_000;
    const put = d1.raw.prepare('INSERT INTO kv (k, v, expires_at) VALUES (?, ?, ?)');
    put.run('alarms:solarman:p1', '1', now - 10);
    put.run('ai:calls:2026-01-01', '4', now - 86400);
    put.run('push:told:quiet:s1', '1', now + 100 * 365 * 86400);
    put.run('agents:week', '20724', now + 100 * 365 * 86400);
    await forgetExpiredKv(d1.db, now);
    expect(d1.raw.prepare('SELECT k FROM kv ORDER BY k').all().map((r) => (r as { k: string }).k)).toEqual(['agents:week', 'push:told:quiet:s1']);
    d1.close();
  });

  it("reports its size where D1 says it, and nothing where it does not", async () => {
    const d1 = createTestD1();
    expect(await dbBytes(d1.db)).toBeNull();
    const reporting = { prepare: () => ({ all: async () => ({ results: [], meta: { size_after: 123_456 } }) }) } as unknown as D1Database;
    expect(await dbBytes(reporting)).toBe(123_456);
    d1.close();
    const h = createHarness();
    expect(await (await h.fetch('/api/status')).json()).toMatchObject({ db_bytes: null });
    h.close();
  });

  it('seals a vendor token when SECRET_KEY is set, and reads one stored before as it was', async () => {
    const d1 = createTestD1();
    await tokenStore(d1.db).set('solarman-web', 'plain-token', 99);
    const sealed = tokenStore(d1.db, 'a-secret-key-that-never-travels');
    // Stored before SECRET_KEY: still read.
    expect(await sealed.get('solarman-web')).toEqual({ accessToken: 'plain-token', expiresAt: 99 });
    await sealed.set('solarman-web', 'rotated-token', 100);
    const stored = (d1.raw.prepare("SELECT access_token FROM tokens WHERE provider = 'solarman-web'").get() as { access_token: string }).access_token;
    expect(stored.startsWith('v1.')).toBe(true);
    expect(stored).not.toContain('rotated-token');
    expect(await sealed.get('solarman-web')).toEqual({ accessToken: 'rotated-token', expiresAt: 100 });
    // Under another key, or none, it cannot be read: the provider logs in afresh.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await tokenStore(d1.db, 'another-key').get('solarman-web')).toBeNull();
    expect(await tokenStore(d1.db).get('solarman-web')).toBeNull();
    warn.mockRestore();
    d1.close();
  });
});

describe('callers who are not signed in', () => {
  it('are held to the rate limiting binding when there is one; the owner and the relays never are', async () => {
    const keys: string[] = [];
    const RATE_LIMIT = { async limit({ key }: { key: string }) { keys.push(key); return { success: false }; } };
    const h = createHarness({ RATE_LIMIT });
    const anon = await h.fetch('/api/latest', { headers: { 'cf-connecting-ip': '203.0.113.5' } });
    expect(anon.status).toBe(429);
    expect(anon.headers.get('retry-after')).toBe('60');
    expect(keys).toEqual(['203.0.113.5']);
    expect((await h.fetch('/api/latest', { headers: bearer('api-token-for-tests') })).status).toBe(200);
    expect((await h.fetch('/api/ingest/relay', { method: 'POST', headers: { 'content-type': 'application/json', ...bearer(INGEST) }, body: '{}' })).status).toBe(400);
    expect((await h.fetch('/oauth/register', { method: 'POST', body: '{}' })).status).toBe(429);
    h.close();
  });

  it('are not limited at all without the binding', async () => {
    const h = createHarness();
    for (let i = 0; i < 5; i++) expect((await h.fetch('/api/latest')).status).toBe(200);
    h.close();
  });

  it('may ask a tool for a year of dates at most; the owner, for three', async () => {
    const h = createHarness();
    const span = '?from=2024-01-01&to=2026-09-27';
    const anon = await h.fetch(`/api/tools/energy${span}`);
    expect(anon.status).toBe(400);
    expect(((await anon.json()) as { error: string }).error).toMatch(/at most 366 days long without signing in/);
    expect((await h.fetch(`/api/tools/energy${span}`, { headers: bearer('api-token-for-tests') })).status).toBe(200);
    // A year is fine for anyone.
    expect((await h.fetch('/api/tools/energy?from=2025-10-01&to=2026-09-27')).status).toBe(200);
    // And the same through the assistant's own door.
    const asked = await h.fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'energy', args: { from: '2024-01-01', to: '2026-09-27' } }) });
    expect(asked.status).toBe(400);
    h.close();
  });
});
