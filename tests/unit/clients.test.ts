import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { SolisCloudProvider, queue as solisQueue, signedHeaders } from '../../src/providers/soliscloud';
import { SolarmanProvider, queue as solarmanQueue, type TokenStore } from '../../src/providers/solarman';
import { SolarmanWebProvider, queue as webQueue } from '../../src/providers/solarman-web';

/**
 * The vendor HTTP clients, driven against a stubbed `fetch`.
 *
 * These were the least-tested files in the project and the ones where a
 * mistake is quietest: a wrong signature, a token that is never refreshed, or
 * an error envelope read as success all look like "no data yet" on screen.
 * Nothing here talks to a vendor - every response is a captured shape - so the
 * suite still runs on a laptop with no credentials.
 *
 * The one piece that genuinely cannot be tested here is the signature's
 * agreement with SolisCloud's own implementation; `npm run probe:solis` checks
 * that against the live endpoint. What is tested is that the signature is
 * assembled from the documented parts, which is where the mistakes were.
 */

/**
 * SolisCloud signs with MD5, which WebCrypto does not define - Cloudflare
 * Workers adds it. Node's WebCrypto therefore rejects it, so the algorithm is
 * delegated to node:crypto for the duration of these tests. Deliberately not a
 * reimplementation of the signing itself: the code under test still builds
 * every header.
 */
const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
function installMd5Shim() {
  vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(
    async (algo: AlgorithmIdentifier, data: BufferSource) => {
      const name = typeof algo === 'string' ? algo : algo.name;
      if (name.toUpperCase() !== 'MD5') return realDigest(algo, data);
      const buf = Buffer.from(crypto.createHash('md5').update(Buffer.from(data as ArrayBuffer)).digest());
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },
  );
}

type Route = (url: string, init?: RequestInit) => unknown;

/** A fetch that answers from a table of URL fragments, and records the calls. */
function stubFetch(routes: Array<[string, Route]>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const hit = routes.find(([frag]) => url.includes(frag));
    if (!hit) throw new Error('unstubbed request: ' + url);
    const out = hit[1](url, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const jsonBody = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}'));

function memoryTokens(seed?: { accessToken: string; expiresAt: number }): TokenStore {
  const shelf = new Map<string, { accessToken: string; expiresAt: number }>();
  if (seed) shelf.set('solarman', seed);
  return {
    async get(p) { return shelf.get(p) ?? null; },
    async set(p, accessToken, expiresAt) { shelf.set(p, { accessToken, expiresAt }); },
  };
}

/**
 * Every vendor call passes through a CallQueue that holds 1.5-2s between
 * requests, because SolisCloud allows three calls per five seconds per IP.
 * Correct in production, absurd here: this file makes about thirty calls, which
 * would take a minute to assert things that have nothing to do with rate
 * limiting. Fake timers are the wrong tool - each queue is a module-level
 * singleton, so a timer left pending when one test ends stalls the chain for
 * every test after it, which is exactly what happened when I tried.
 */
beforeEach(() => {
  solisQueue.minGapMs = 0;
  solarmanQueue.minGapMs = 0;
  webQueue.minGapMs = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ===================== SolisCloud =====================

describe('SolisCloud request signing', () => {
  beforeEach(installMd5Shim);

  const creds = { keyId: 'KEYID', keySecret: 'secret' };

  it('signs with every documented part of the request', async () => {
    const h = await signedHeaders(creds, '/v1/api/userStationList', '{"pageNo":1}');
    // The scheme is "API <keyId>:<signature>"; anything else and SolisCloud
    // answers 403 without saying why.
    expect(h.Authorization).toMatch(/^API KEYID:[A-Za-z0-9+/=]+$/);
    expect(h['Content-Type']).toBe('application/json');
    // An RFC 1123 date, because the server rejects a skew over 15 minutes and
    // compares this exact string.
    expect(h.Date).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
    expect(h['Content-MD5']).toBe(
      Buffer.from(crypto.createHash('md5').update('{"pageNo":1}').digest()).toString('base64'),
    );
  });

  it('signs different bodies differently, and the same body the same way', async () => {
    const one = await signedHeaders(creds, '/v1/api/userStationList', '{"pageNo":1}');
    const two = await signedHeaders(creds, '/v1/api/userStationList', '{"pageNo":2}');
    expect(one['Content-MD5']).not.toBe(two['Content-MD5']);
    expect(one.Authorization).not.toBe(two.Authorization);
  });

  it('binds the signature to the path and the clock', async () => {
    // The date is part of the string to sign, so it has to be held still to
    // compare two signatures. signedHeaders reads the clock itself - no
    // injectable date - and these two cases make no queued calls, so freezing
    // here cannot strand a timer in the shared call queue.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
      const list = await signedHeaders(creds, '/v1/api/userStationList', '{}');
      const inverters = await signedHeaders(creds, '/v1/api/inverterList', '{}');
      // Same second, same body: only the path differs, and it must show.
      expect(list.Date).toBe(inverters.Date);
      expect(list.Authorization).not.toBe(inverters.Authorization);

      // Same request a minute later signs differently, which is what stops a
      // captured header being replayed indefinitely.
      vi.setSystemTime(new Date('2026-09-10T12:01:00Z'));
      const later = await signedHeaders(creds, '/v1/api/userStationList', '{}');
      expect(later.Authorization).not.toBe(list.Authorization);

      // And the same request at the same instant is reproducible, or a retry
      // would be rejected.
      vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
      const again = await signedHeaders(creds, '/v1/api/userStationList', '{}');
      expect(again.Authorization).toBe(list.Authorization);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SolisCloudProvider', () => {
  beforeEach(installMd5Shim);
  const creds = { keyId: 'KEYID', keySecret: 'secret' };

  it('lists plants, reading capacity through the unit string', async () => {
    stubFetch([['userStationList', () => ({
      success: true, code: '0',
      // The id arrives as a string, and has to: a 19-digit station id exceeds
      // Number.MAX_SAFE_INTEGER, so sent as a JSON number it would arrive
      // rounded - ...001 becomes ...000 and every later lookup misses.
      data: { page: { records: [
        { id: '1000000000000000001', stationName: 'Demo Plant', capacity: 12, capacityStr: 'kWp', timeZone: 5 },
        { id: 2, name: 'Second', capacity: 500, capacityStr: 'Wp' },
      ] } },
    })]]);

    const plants = await new SolisCloudProvider(creds).listPlants();
    expect(plants).toEqual([
      // SolisCloud reports whole hours; a plant that says nothing keeps null,
      // and the caller's own offset is used for it instead.
      { id: '1000000000000000001', name: 'Demo Plant', capacityW: 12_000, tzOffsetSec: 5 * 3600 },
      { id: '2', name: 'Second', capacityW: 500, tzOffsetSec: null },
    ]);
  });

  it('falls back to the plant id when the vendor sends no name', async () => {
    stubFetch([['userStationList', () => ({
      success: true, data: { page: { records: [{ id: 77, capacity: 1, capacityStr: 'kWp' }] } },
    })]]);
    const [p] = await new SolisCloudProvider(creds).listPlants();
    expect(p.name).toBe('77');
  });

  it('lists inverters under a plant and passes the plant id through', async () => {
    const calls = stubFetch([['inverterList', () => ({
      success: true,
      data: { page: { records: [{ id: 9, sn: 'INV-DEMO', stationId: 55, power: 10, powerStr: 'kW' }] } },
    })]]);

    const invs = await new SolisCloudProvider(creds).listInverters('55');
    expect(invs).toHaveLength(1);
    expect(invs[0].provider).toBe('soliscloud');
    expect(invs[0].vendorId).toBe('9');
    expect(jsonBody(calls[0].init).stationId).toBe('55');
  });

  it('turns a non-zero code into an error naming the endpoint', async () => {
    stubFetch([['userStationList', () => ({ success: false, code: '1004', msg: 'sign error' })]]);
    await expect(new SolisCloudProvider(creds).listPlants())
      .rejects.toThrow(/userStationList.*code=1004.*sign error/);
  });

  it('explains an HTTP 408 as clock skew, which is what it always is', async () => {
    stubFetch([['userStationList', () => new Response('', { status: 408 })]]);
    await expect(new SolisCloudProvider(creds).listPlants()).rejects.toThrow(/clock skew/);
  });

  it('reports any other HTTP failure with its status and path', async () => {
    stubFetch([['userStationList', () => new Response('nope', { status: 503 })]]);
    await expect(new SolisCloudProvider(creds).listPlants())
      .rejects.toThrow(/HTTP 503 on \/v1\/api\/userStationList/);
  });
});

// ===================== SolarMan official =====================

describe('SolarmanProvider', () => {
  const creds = {
    appId: '1234567890', appSecret: 'sekrit',
    email: 'someone@example.com', passwordSha256: 'abc123',
  };
  const future = Math.floor(Date.now() / 1000) + 3600;

  it('fetches a token on first use and sends the password hash, never a password', async () => {
    const calls = stubFetch([
      ['/account/v1.0/token', () => ({ success: true, access_token: 'TOK', expires_in: 5_184_000 })],
      ['/station/v1.0/list', () => ({ success: true, stationList: [{ id: 62000000, name: 'Demo' }] })],
    ]);

    const store = memoryTokens();
    const plants = await new SolarmanProvider(creds, store).listPlants();
    expect(plants[0]).toMatchObject({ id: '62000000', name: 'Demo' });

    const tokenCall = jsonBody(calls[0].init);
    expect(tokenCall.password).toBe('abc123');
    expect(tokenCall).not.toHaveProperty('passwordPlain');
    // The appId travels in the query string, which is why the poll log redacts
    // query strings before storing a failure.
    expect(calls[0].url).toContain('appId=1234567890');
    // Stored a day early, so a cron never trips on expiry.
    const saved = await store.get('solarman');
    expect(saved!.accessToken).toBe('TOK');
    expect(saved!.expiresAt).toBeLessThan(Math.floor(Date.now() / 1000) + 5_184_000);
  });

  it('reuses a cached token rather than asking for another', async () => {
    const calls = stubFetch([
      ['/station/v1.0/list', () => ({ success: true, stationList: [] })],
    ]);
    await new SolarmanProvider(creds, memoryTokens({ accessToken: 'CACHED', expiresAt: future })).listPlants();
    expect(calls).toHaveLength(1);
    expect(String(calls[0].init?.headers ? (calls[0].init!.headers as Record<string, string>).Authorization : ''))
      .toBe('bearer CACHED');
  });

  it('refreshes once and retries when the token has expired mid-poll', async () => {
    let listCalls = 0;
    const calls = stubFetch([
      ['/account/v1.0/token', () => ({ success: true, access_token: 'FRESH', expires_in: 100 })],
      ['/station/v1.0/list', () => {
        listCalls += 1;
        // 2101 is "token expired" in SolarMan's own code table.
        return listCalls === 1
          ? { success: false, code: '2101', msg: 'token expired' }
          : { success: true, stationList: [{ id: 1, name: 'After refresh' }] };
      }],
    ]);

    const plants = await new SolarmanProvider(creds, memoryTokens({ accessToken: 'STALE', expiresAt: future })).listPlants();
    expect(plants[0].name).toBe('After refresh');
    expect(listCalls).toBe(2);
    expect(calls.some((c) => c.url.includes('/account/v1.0/token'))).toBe(true);
  });

  it('refreshes on a bare 401 as well as on the code', async () => {
    let n = 0;
    stubFetch([
      ['/account/v1.0/token', () => ({ success: true, access_token: 'FRESH', expires_in: 100 })],
      ['/station/v1.0/list', () => (++n === 1
        ? new Response('', { status: 401 })
        : { success: true, stationList: [{ id: 2, name: 'Recovered' }] })],
    ]);
    const plants = await new SolarmanProvider(creds, memoryTokens({ accessToken: 'STALE', expiresAt: future })).listPlants();
    expect(plants[0].name).toBe('Recovered');
    expect(n).toBe(2);
  });

  it('does not retry forever: a second failure is reported, not looped', async () => {
    let n = 0;
    stubFetch([
      ['/account/v1.0/token', () => ({ success: true, access_token: 'FRESH', expires_in: 100 })],
      ['/station/v1.0/list', () => { n += 1; return { success: false, code: '2101', msg: 'still expired' }; }],
    ]);
    await expect(new SolarmanProvider(creds, memoryTokens()).listPlants()).rejects.toThrow(/2101|still expired/);
    expect(n).toBe(2);
  });

  it('says so plainly when the credentials are refused', async () => {
    stubFetch([['/account/v1.0/token', () => ({ success: false, msg: 'appSecret invalid' })]]);
    await expect(new SolarmanProvider(creds, memoryTokens()).listPlants())
      .rejects.toThrow(/token refused - appSecret invalid/);
  });

  it('reports a token endpoint that answers with an HTTP error', async () => {
    stubFetch([['/account/v1.0/token', () => new Response('', { status: 500 })]]);
    await expect(new SolarmanProvider(creds, memoryTokens()).listPlants())
      .rejects.toThrow(/token HTTP 500/);
  });

  it('lists devices under a station', async () => {
    const calls = stubFetch([
      ['/station/v1.0/device', () => ({
        success: true,
        deviceListItems: [{ deviceId: 9911, deviceSn: 'SN1', deviceType: 'INVERTER' }],
      })],
    ]);
    const invs = await new SolarmanProvider(creds, memoryTokens({ accessToken: 'T', expiresAt: future }))
      .listInverters('62000000');
    expect(Array.isArray(invs)).toBe(true);
    expect(jsonBody(calls[0].init).stationId).toBe(62000000);
  });
});

// ===================== SolarMan browser session =====================

describe('SolarmanWebProvider', () => {
  const future = Math.floor(Date.now() / 1000) + 3600;

  it('exchanges the refresh token for an access token', async () => {
    const calls = stubFetch([
      ['/oauth2-s/oauth/token', () => ({ access_token: 'WEBTOK', refresh_token: 'NEWREFRESH', expires_in: 86_400 })],
      ['/operating/station/search', () => ({ data: [{ id: 62000000, name: 'Demo' }] })],
    ]);

    const plants = await new SolarmanWebProvider({ refreshToken: 'OLDREFRESH' }, memoryTokens()).listPlants();
    expect(plants[0]).toMatchObject({ id: '62000000' });
    expect(calls[0].url).toContain('/oauth2-s/oauth/token');
    // The station search is authorised with the token just obtained.
    const auth = (calls[1].init!.headers as Record<string, string>).Authorization;
    expect(auth).toContain('WEBTOK');
  });

  it('uses a seeded access token so the first poll needs no refresh', async () => {
    const calls = stubFetch([
      ['/operating/station/search', () => ({ data: [] })],
    ]);
    await new SolarmanWebProvider({ refreshToken: 'R', accessToken: 'SEEDED' }, memoryTokens()).listPlants();
    expect(calls).toHaveLength(1);
    expect((calls[0].init!.headers as Record<string, string>).Authorization).toContain('SEEDED');
  });

  it('says the session is gone rather than retrying forever', async () => {
    stubFetch([
      ['/oauth2-s/oauth/token', () => ({ msg: 'invalid_grant' })],
    ]);
    await expect(new SolarmanWebProvider({ refreshToken: 'DEAD' }, memoryTokens()).listPlants())
      .rejects.toThrow(/refresh refused - invalid_grant/);
  });

  it('reports a refresh endpoint that answers with an HTTP error', async () => {
    stubFetch([['/oauth2-s/oauth/token', () => new Response('', { status: 502 })]]);
    await expect(new SolarmanWebProvider({ refreshToken: 'R' }, memoryTokens()).listPlants())
      .rejects.toThrow(/refresh HTTP 502/);
  });

  it('refreshes and retries once when the portal rejects the access token', async () => {
    let n = 0;
    stubFetch([
      ['/oauth2-s/oauth/token', () => ({ access_token: 'FRESH', expires_in: 86_400 })],
      ['/operating/station/search', () => (++n === 1
        ? new Response('', { status: 401 })
        : { data: [{ id: 3, name: 'Recovered' }] })],
    ]);
    const plants = await new SolarmanWebProvider({ refreshToken: 'R', accessToken: 'STALE' }, memoryTokens()).listPlants();
    expect(plants[0].id).toBe('3');
    expect(n).toBe(2);
  });
});
