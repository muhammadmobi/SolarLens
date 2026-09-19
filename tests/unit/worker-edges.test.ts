/**
 * The paths that only show up when something is unusual: the generic ingest
 * route, a Worker deployed without its token, the token store the SolarMan
 * clients keep their session in, and the vendor calls that fetch hardware
 * detail. Each one is a place where a mistake is quiet rather than loud.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bearer, createHarness, testInverter } from '../helpers/worker';
import { createTestD1 } from '../helpers/d1';
import { latestPerProvider, logPoll, nowSec, recentPolls, tokenStore } from '../../src/db';
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
});

describe('a Worker deployed without API_TOKEN', () => {
  it('lets a write through, and says so in the log rather than silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = createHarness({ API_TOKEN: undefined });
    const res = await h.fetch('/api/poll', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('API_TOKEN is not set'));
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
