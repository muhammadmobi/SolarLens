/**
 * The Worker's own routes, against a real database.
 *
 * Until these existed, every route, the auth middleware and the security
 * headers were checked by deploying and looking: the end-to-end suite stubs
 * `/api/*` rather than running it. These make the same requests the dashboard
 * and the relay make, and read back the rows that came out the other side -
 * through `tests/helpers/d1.ts`, which is SQLite standing in for D1.
 */
import { describe, expect, it } from 'vitest';
import { bearer, createHarness, testInverter, testReading } from '../helpers/worker';
import { insertReading, upsertInverter } from '../../src/db';

const INGEST = 'ingest-token-for-tests';
const API = 'api-token-for-tests';
// A POST with the relay's token, as the ingest routes expect.
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...bearer(INGEST) },
  body: JSON.stringify(body),
});

/** A SolisCloud plant snapshot, as the relay forwards it untouched. */
const stationPush = (over: Record<string, unknown> = {}) => ({
  provider: 'soliscloud',
  plantId: 'plant-1',
  name: 'Relay Plant',
  capacityW: 12000,
  source: 'soliscloud-relay',
  raw: { id: 'plant-1', stationName: 'Relay Plant', power: 3.2, powerStr: 'kW', dayEnergyStr: 'kWh', dayEnergy: 5, timeZone: 0 },
  ...over,
});

/** A SolisCloud alarm record, with the owner's details present so their removal is proved. */
const alarmRecord = (over: Record<string, unknown> = {}) => ({
  id: '-1', stationId: 'plant-1', alarmLevel: '2', alarmCode: '1015',
  alarmBeginTime: 1_784_359_680_000, alarmEndTime: 1_784_360_280_000,
  advice: 'No Action Required', alarmMsg: 'NO-Grid', state: '2',
  address: '1 Fake Street', mobile: '00000000000', email: 'owner@example.invalid',
  userName: 'demo-owner', cityStr: 'Nowhere',
  ...over,
});

describe('security headers', () => {
  it('sets the whole policy on an API response', async () => {
    const h = createHarness();
    const res = await h.fetch('/api/health');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    h.close();
  });

  it('sets them on the page the assets binding serves, whose own headers are frozen', async () => {
    const h = createHarness();
    const res = await h.fetch('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('dashboard');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    h.close();
  });
});

describe('reads are open, writes are not', () => {
  it('serves every read route without a token', async () => {
    const h = createHarness();
    for (const path of ['/api/latest', '/api/series', '/api/health', '/api/alarms', '/api/periods', '/api/devices', '/api/history']) {
      expect((await h.fetch(path)).status, path).toBe(200);
    }
    h.close();
  });

  it('refuses a write with no token, a wrong token, or the ingest token', async () => {
    const h = createHarness();
    expect((await h.fetch('/api/poll', { method: 'POST' })).status).toBe(401);
    expect((await h.fetch('/api/poll', { method: 'POST', headers: bearer('wrong') })).status).toBe(401);
    // The tokens guard different costs, so one does not open the other's route.
    expect((await h.fetch('/api/poll', { method: 'POST', headers: bearer(INGEST) })).status).toBe(401);
    h.close();
  });

  it('accepts the API token as a bearer header or as the cookie /auth sets', async () => {
    const h = createHarness();
    expect((await h.fetch('/api/poll', { method: 'POST', headers: bearer(API) })).status).toBe(200);

    const auth = await h.fetch(`/auth?t=${API}`);
    expect(auth.status).toBe(302);
    const cookie = (auth.headers.get('set-cookie') ?? '');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    const viaCookie = await h.fetch('/api/poll', { method: 'POST', headers: { cookie: cookie.split(';')[0] } });
    expect(viaCookie.status).toBe(200);
    h.close();
  });

  it('refuses /auth with the wrong token, and sets no cookie', async () => {
    const h = createHarness();
    const res = await h.fetch('/auth?t=not-the-token');
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
    h.close();
  });

  it('refuses every ingest route without its own token', async () => {
    const h = createHarness();
    for (const path of ['/api/ingest', '/api/ingest/station', '/api/ingest/devices', '/api/ingest/relay', '/api/ingest/alarms', '/api/ingest/periods', '/api/ingest/history']) {
      const res = await h.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...bearer(API) }, body: '{}' });
      expect(res.status, path).toBe(401);
    }
    h.close();
  });

  it('says so, rather than letting a write through, when no ingest token is configured', async () => {
    const h = createHarness({ INGEST_TOKEN: undefined });
    const res = await h.fetch('/api/ingest/relay', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
    h.close();
  });
});

describe('/api/latest', () => {
  it('serves a stored reading with every vendor identifier replaced', async () => {
    const h = createHarness();
    await upsertInverter(h.env.DB, testInverter() as never);
    await insertReading(h.env.DB, testReading({ raw: { stationId: 62000000, ownerEmail: 'someone@example.com' } }) as never);

    const res = await h.fetch('/api/latest');
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('s1');
    expect(body).not.toContain('s-test');          // the vendor's plant id
    expect(body).not.toContain('62000000');         // an id inside the raw payload
    expect(body).not.toContain('someone@example');  // an address inside it
    expect(body).not.toContain('SERIAL1234');       // the full serial
    const parsed = JSON.parse(body) as { inverters: { ac_power_w: number; battery_soc: number; serial: string }[] };
    expect(parsed.inverters[0]).toMatchObject({ ac_power_w: 1200, battery_soc: 80 });
    expect(parsed.inverters[0].serial).toContain('1234');
    h.close();
  });

  it('answers with an empty list before anything is stored', async () => {
    const h = createHarness();
    expect(await (await h.fetch('/api/latest')).json()).toMatchObject({ inverters: [] });
    h.close();
  });
});

describe('/api/series', () => {
  it('returns the window asked for, and nothing outside it', async () => {
    const h = createHarness();
    await upsertInverter(h.env.DB, testInverter() as never);
    for (const ts of [1_700_000_000, 1_700_000_600, 1_700_090_000]) {
      await insertReading(h.env.DB, testReading({ ts, acPowerW: 500 }) as never);
    }
    const body = (await (await h.fetch('/api/series?from=1700000000&to=1700001000')).json()) as { points: unknown[]; from: number };
    expect(body.points).toHaveLength(2);
    expect(body.from).toBe(1_700_000_000);
    h.close();
  });

  it('refuses a window that is not numbers, or is longer than a month', async () => {
    const h = createHarness();
    expect((await h.fetch('/api/series?to=not-a-time')).status).toBe(400);
    expect((await h.fetch('/api/series?from=1&to=1700000000')).status).toBe(400);
    expect((await h.fetch('/api/series?tz=9999')).status).toBe(400);
    h.close();
  });

  it('with no window, opens at the earliest plant midnight', async () => {
    const h = createHarness();
    await upsertInverter(h.env.DB, testInverter() as never);
    await insertReading(h.env.DB, testReading() as never);
    const body = (await (await h.fetch('/api/series')).json()) as { from: number; to: number };
    expect(body.to - body.from).toBeGreaterThan(0);
    h.close();
  });
});

describe('/api/history and /api/alarms take a range', () => {
  it('clamps the days asked for instead of refusing', async () => {
    const h = createHarness();
    const history = (await (await h.fetch('/api/history?days=100000')).json()) as { days: number };
    expect(history.days).toBe(400);
    const alarms = (await (await h.fetch('/api/alarms?days=0')).json()) as { days: number };
    expect(alarms.days).toBe(1);
    h.close();
  });

  it('refuses a timezone that is not a real offset', async () => {
    const h = createHarness();
    expect((await h.fetch('/api/history?tz=9999')).status).toBe(400);
    h.close();
  });
});

describe('/api/health', () => {
  it('reports the newest line per feed and the relays, with no relay id', async () => {
    const h = createHarness();
    await h.fetch('/api/ingest/station', post(stationPush()));
    await h.fetch('/api/ingest/relay', post({
      provider: 'soliscloud', id: 'abcdef0123456789', name: 'Office laptop', state: 'ok',
      loginExpiresAt: Math.floor(Date.now() / 1000) + 5 * 86400,
    }));

    const body = (await (await h.fetch('/api/health')).json()) as {
      relays: { name: string }[]; feeds: { provider: string; ok: number }[]; polls: unknown[]; now: number;
    };
    expect(body.relays).toHaveLength(1);
    expect(body.relays[0].name).toBe('Office laptop');
    expect(body.feeds.find((f) => f.provider === 'soliscloud')?.ok).toBe(1);
    expect(JSON.stringify(body)).not.toContain('abcdef0123456789');
    h.close();
  });
});

describe('/api/ingest/station', () => {
  it('stores what the relay pushed, and serves it back aliased', async () => {
    const h = createHarness();
    const res = await h.fetch('/api/ingest/station', post(stationPush()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stored: true, acPowerW: 3200 });

    const latest = (await (await h.fetch('/api/latest')).json()) as { inverters: { ac_power_w: number }[] };
    expect(latest.inverters[0].ac_power_w).toBe(3200);
    h.close();
  });

  it('stores the same sample once, however often it is pushed', async () => {
    const h = createHarness();
    await h.fetch('/api/ingest/station', post(stationPush()));
    expect(await (await h.fetch('/api/ingest/station', post(stationPush()))).json()).toMatchObject({ stored: false });
    h.close();
  });

  it('refuses a body that is not a station push', async () => {
    const h = createHarness();
    expect((await h.fetch('/api/ingest/station', post({ provider: 'soliscloud' }))).status).toBe(400);
    h.close();
  });

  it('ignores a plant INCLUDE_PLANTS does not name', async () => {
    const h = createHarness({ INCLUDE_PLANTS: 'some-other-plant' });
    expect(await (await h.fetch('/api/ingest/station', post(stationPush()))).json())
      .toMatchObject({ skipped: 'not in INCLUDE_PLANTS' });
    expect(await (await h.fetch('/api/latest')).json()).toMatchObject({ inverters: [] });
    h.close();
  });
});

describe('/api/ingest/relay', () => {
  it('refuses a report that is not the narrow shape', async () => {
    const h = createHarness();
    for (const body of [
      {},
      { provider: 'soliscloud', id: 'not-hex', state: 'ok' },
      { provider: 'soliscloud', id: 'abcdef0123456789', state: 'confused' },
      { provider: 'someone-else', id: 'abcdef0123456789', state: 'ok' },
      // A computer name offered as an id: exactly what must never be stored.
      { provider: 'soliscloud', id: 'ACME-LAPTOP-07', state: 'ok' },
    ]) {
      expect((await h.fetch('/api/ingest/relay', post(body))).status, JSON.stringify(body)).toBe(400);
    }
    h.close();
  });

  it('keeps the name and expiry a later report leaves out', async () => {
    const h = createHarness();
    const expiry = Math.floor(Date.now() / 1000) + 3 * 86400;
    await h.fetch('/api/ingest/relay', post({ provider: 'soliscloud', id: 'abcdef0123456789', name: 'Laptop', state: 'ok', loginExpiresAt: expiry }));
    await h.fetch('/api/ingest/relay', post({ provider: 'soliscloud', id: 'abcdef0123456789', state: 'login-expired' }));

    const body = (await (await h.fetch('/api/health')).json()) as { relays: { state: string; login_expires_at: number; name: string }[] };
    expect(body.relays[0]).toMatchObject({ state: 'login-expired', name: 'Laptop', login_expires_at: expiry });
    h.close();
  });
});

describe('/api/ingest/devices and /api/devices', () => {
  it('stores the portal\'s inventory and serves it with serials masked', async () => {
    const h = createHarness();
    const res = await h.fetch('/api/ingest/devices', post({
      provider: 'soliscloud',
      plantId: 'plant-1',
      inverters: [{ id: '3000000000000000003', sn: 'INV0001SERIAL', model: 'S5-GR3P10K', state: 1, pow1: 800, pow2: 0 }],
      collectors: [{ id: '4000000000000000004', sn: 'LOG0001SERIAL', signal: -63, state: 1 }],
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stored: 2 });

    const devices = await (await h.fetch('/api/devices')).text();
    expect(devices).not.toContain('INV0001SERIAL');
    expect(devices).not.toContain('LOG0001SERIAL');
    h.close();
  });

  it('refuses a body without provider and plantId', async () => {
    const h = createHarness();
    expect((await h.fetch('/api/ingest/devices', post({ plantId: 'plant-1' }))).status).toBe(400);
    h.close();
  });
});

describe('/api/ingest/alarms and /api/alarms', () => {
  it('stores an alarm, dropping the owner\'s details, and serves it without the vendor id', async () => {
    const h = createHarness();
    await h.fetch('/api/ingest/station', post(stationPush()));
    const res = await h.fetch('/api/ingest/alarms', post({ provider: 'soliscloud', plantId: 'plant-1', records: [alarmRecord()] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stored: 1, received: 1 });

    const alarms = await (await h.fetch('/api/alarms')).text();
    expect(alarms).toContain('NO-Grid');
    for (const leak of ['Fake Street', 'owner@example', 'demo-owner', 'Nowhere']) {
      expect(alarms, leak).not.toContain(leak);
    }
    h.close();
  });

  it('refuses a body that is not an alarm push, and a list far too long to be one', async () => {
    const h = createHarness();
    expect((await h.fetch('/api/ingest/alarms', post({ provider: 'solarman', plantId: 'plant-1', records: [] }))).status).toBe(400);
    expect((await h.fetch('/api/ingest/alarms', post({ provider: 'soliscloud', plantId: 'plant-1', records: Array(501).fill(alarmRecord()) }))).status).toBe(400);
    h.close();
  });
});

describe('/api/ingest/periods', () => {
  // One point of a SolisCloud month chart, as the relay forwards it.
  const point = (over: Record<string, unknown> = {}) => ({ dateStr: '2026-09-01', energy: 34.1, energyStr: 'kWh', ...over });

  it('stores totals, and serves back the months and years the chart draws', async () => {
    const h = createHarness();
    await h.fetch('/api/ingest/station', post(stationPush()));

    // The portal's Month tab is a row per day, and its Year tab a row per
    // month. /api/periods serves months and years - days are what the history
    // chart already has from the readings themselves.
    const days = await h.fetch('/api/ingest/periods', post({ provider: 'soliscloud', plantId: 'plant-1', which: 'month', points: [point()] }));
    expect(await days.json()).toMatchObject({ stored: 1 });

    const months = await h.fetch('/api/ingest/periods', post({
      provider: 'soliscloud', plantId: 'plant-1', which: 'year', points: [point({ dateStr: '2026-09' })],
    }));
    expect(await months.json()).toMatchObject({ stored: 1 });

    const served = await (await h.fetch('/api/periods')).text();
    expect(served).toContain('2026-09');
    expect(served).not.toContain('2026-09-01');
    h.close();
  });

  it('refuses a total a 12 kW array could not have produced', async () => {
    const h = createHarness();
    await h.fetch('/api/ingest/station', post(stationPush()));
    // 12 kW cannot make 5,000 kWh in a day: that is a unit error, not a record.
    const res = await h.fetch('/api/ingest/periods', post({
      provider: 'soliscloud', plantId: 'plant-1', which: 'month', points: [point({ energy: 5000 })],
    }));
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('exceeds what a 12 kW array');
    h.close();
  });

  it('refuses a body with no "which", and one with far too many points', async () => {
    const h = createHarness();
    expect((await h.fetch('/api/ingest/periods', post({ provider: 'soliscloud', plantId: 'plant-1', points: [] }))).status).toBe(400);
    expect((await h.fetch('/api/ingest/periods', post({ provider: 'soliscloud', plantId: 'plant-1', which: 'month', points: Array(401).fill(point()) }))).status).toBe(400);
    h.close();
  });
});

describe('/api/ingest/history', () => {
  const noon = Date.UTC(2026, 8, 8, 7, 0, 0);
  // A day curve as the relay forwards it: times, and power in the stated unit.
  const chart = (over: Record<string, unknown> = {}) => ({
    time: [noon, noon + 300_000, noon + 600_000],
    power: [8.47, 9.17, 8.9],
    powerStr: 'kW',
    ...over,
  });

  it('backfills the day curve, and stores each point once', async () => {
    const h = createHarness();
    await h.fetch('/api/ingest/station', post(stationPush()));
    const first = await h.fetch('/api/ingest/history', post({ provider: 'soliscloud', plantId: 'plant-1', raw: chart() }));
    expect(await first.json()).toMatchObject({ stored: 3, points: 3 });
    const second = await h.fetch('/api/ingest/history', post({ provider: 'soliscloud', plantId: 'plant-1', raw: chart() }));
    expect(await second.json()).toMatchObject({ stored: 0, points: 3 });
    h.close();
  });

  it('says what the payload did contain when it holds no curve', async () => {
    const h = createHarness();
    const res = await h.fetch('/api/ingest/history', post({ provider: 'soliscloud', plantId: 'plant-1', raw: { somethingElse: 1 } }));
    expect(await res.json()).toMatchObject({ stored: 0, points: 0, sawKeys: ['somethingElse'] });
    h.close();
  });

  it('reads the numbers rather than the unit label the vendor prints', async () => {
    const h = createHarness();
    await h.fetch('/api/ingest/station', post(stationPush()));
    // `powerStr` labels the chart's axis, not its values - taking it as a scale
    // once put a 12 kW array at 9.47 MW. The same curve in watts is accepted
    // as watts, whatever the label says.
    const res = await h.fetch('/api/ingest/history', post({
      provider: 'soliscloud', plantId: 'plant-1', raw: chart({ power: [8470, 9170, 8900] }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stored: 3 });
    h.close();
  });

  it('refuses a curve whose peak the array could not reach', async () => {
    const h = createHarness();
    await h.fetch('/api/ingest/station', post(stationPush()));
    // 80 kW from a 12 kW array is not a reading; half a day of nonsense is far
    // harder to spot in a graph afterwards than a refusal is here.
    const res = await h.fetch('/api/ingest/history', post({
      provider: 'soliscloud', plantId: 'plant-1', raw: chart({ power: [80_000, 90_000, 85_000] }),
    }));
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('implausible curve');
    h.close();
  });

  it('refuses a body with no raw payload', async () => {
    const h = createHarness();
    expect((await h.fetch('/api/ingest/history', post({ provider: 'soliscloud', plantId: 'plant-1' }))).status).toBe(400);
    h.close();
  });
});

describe('the cron entry point', () => {
  it('logs that nothing is configured rather than failing', async () => {
    const h = createHarness();
    await h.cron();
    const health = (await (await h.fetch('/api/health')).json()) as { polls: { provider: string; ok: number; detail: string }[] };
    expect(health.polls[0]).toMatchObject({ provider: 'none', ok: 0 });
    expect(health.polls[0].detail).toContain('no provider credentials');
    h.close();
  });
});
