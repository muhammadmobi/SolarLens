/**
 * The end-to-end fixtures, held to what the real Worker sends.
 *
 * The end-to-end suite serves the dashboard canned API answers
 * (tests/fixtures/dashboard-api.ts) instead of running the Worker. That is what
 * makes it fast and credential-free, and it is also how gap 5 went unnoticed:
 * the canned rows carried the vendor's raw payload, the Worker never sent it,
 * and every test passed while three things never appeared on the live site.
 *
 * So this runs the real Worker - its routes, its SQL, its public view - on the
 * real vendor fixtures, and compares field names, row by row: a canned row may
 * not carry a field the Worker does not send, and may not lack one it does.
 * Values are free to differ; they are chosen to make each test's point.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createHarness, testReading, type Harness } from '../helpers/worker';
import { insertReading } from '../../src/db';
import { storeWeather, upsertLocation } from '../../src/weather';
import { parseTariff } from '../../src/settings';
import { deviceHistory, devices, inverters } from '../fixtures/dashboard-api';

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...bearer('ingest-token-for-tests') },
  body: JSON.stringify(body),
});
const fixture = (name: string) => JSON.parse(readFileSync(`tests/fixtures/${name}`, 'utf8'));

/** Field names, sorted, so a failure lists exactly what is missing or extra. */
const fields = (row: object) => Object.keys(row).sort();

let h: Harness;
let served: { inverters: Record<string, unknown>[]; devices: Record<string, unknown>[]; history: Record<string, unknown> & { samples: Record<string, unknown>[] } };

beforeAll(async () => {
  h = createHarness();
  // One system from each vendor, through the same ingest routes the relay and
  // the cron use, then read back through the routes the page reads.
  await h.fetch('/api/ingest/station', post({
    provider: 'soliscloud', plantId: 'p1', name: 'On-grid', capacityW: 12000,
    source: 'soliscloud-relay', raw: fixture('solis-station.json'),
  }));
  await h.fetch('/api/ingest/station', post({
    provider: 'solarman', plantId: 'p2', name: 'Hybrid', capacityW: 3500,
    source: 'solarman-web', raw: fixture('solarman-station.json'),
  }));
  await h.fetch('/api/ingest/devices', post({
    provider: 'soliscloud', plantId: 'p1',
    inverters: [{ id: '3', sn: 'INV0001SERIAL', model: 'S5-GR3P10K', state: 1, pow1: 800 }],
    collectors: [{ id: '4', sn: 'LOG0001SERIAL', signal: -63, state: 1 }],
  }));
  served = {
    inverters: ((await (await h.fetch('/api/latest')).json()) as { inverters: Record<string, unknown>[] }).inverters,
    devices: ((await (await h.fetch('/api/devices')).json()) as { devices: Record<string, unknown>[] }).devices,
    history: (await (await h.fetch('/api/devices/history')).json()) as typeof served.history,
  };
});
afterAll(() => h.close());

describe('the end-to-end fixtures match what the Worker sends', () => {
  it('the Worker answered with both systems and the hardware', () => {
    expect(served.inverters).toHaveLength(2);
    expect(served.devices.length).toBeGreaterThan(0);
  });

  it('every system row has exactly the fields /api/latest sends', () => {
    const real = fields(served.inverters[0]);
    for (const row of inverters()) expect(fields(row), String(row.id)).toEqual(real);
  });

  it('every device row has exactly the fields /api/devices sends', () => {
    const real = fields(served.devices[0]);
    for (const row of devices()) expect(fields(row), String(row.id)).toEqual(real);
  });

  it('the link history has the fields /api/devices/history sends', () => {
    const fx = deviceHistory();
    expect(fields(fx)).toEqual(fields(served.history));
    expect(served.history.samples.length).toBeGreaterThan(0);
    const real = fields(served.history.samples[0]);
    for (const row of fx.samples) expect(fields(row)).toEqual(real);
  });

  it('names each device in its history as /api/devices names it', () => {
    const ids = new Set(served.devices.map((d) => d.id));
    for (const r of served.history.samples) expect(ids.has(r.device_id)).toBe(true);
    // And the fixtures' history points at the fixtures' devices.
    const fxIds = new Set(devices().map((d) => d.id));
    for (const r of deviceHistory().samples) expect(fxIds.has(r.device_id)).toBe(true);
  });

  it('no end-to-end spec serves the raw payload the Worker withholds', () => {
    // The other specs build small rows of their own. The one field that must
    // never reappear in any of them is the one that hid gap 5.
    for (const name of readdirSync('tests/e2e').filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(`tests/e2e/${name}`, 'utf8');
      expect(src, name).not.toMatch(/\braw:\s/);
    }
  });
});

describe('what the Worker makes of the raw payload', () => {
  it('sends the alert fields as named columns', () => {
    const solarman = served.inverters.find((r) => r.provider === 'solarman')!;
    expect(solarman.warning_status).toBe('NORMAL');
    expect(solarman.network_status).toBe('NORMAL');
    // SolarMan does not report an alarm counter at all: null, not zero.
    expect(solarman.alarm_count).toBeNull();
  });

  it('sends the measurements for the Raw telemetry table, and no identifier', () => {
    for (const row of served.inverters) {
      const t = JSON.parse(String(row.telemetry)) as Record<string, unknown>;
      expect(Object.keys(t).length).toBeGreaterThan(10);
      // The fixtures' plant ids, serial and station name, under their vendor keys.
      for (const k of ['id', 'sno', 'systemId', 'stationName']) expect(t, k).not.toHaveProperty(k);
    }
    const text = JSON.stringify(served);
    expect(text).not.toContain('1000000000000000001');
    expect(text).not.toContain('62000000');
    expect(text).not.toContain('INV0001SERIAL');
  });
});

/**
 * The GitHub Pages demo makes its own answers up (demo/demo.js). They are held
 * to the real Worker's field by field, as the end-to-end fixtures are, so the
 * demo cannot show off a field the dashboard no longer gets - or miss one it
 * does, and look emptier than the real thing.
 */
describe('the demo matches what the Worker sends', () => {
  // demo/demo.js is a browser script; outside one it only publishes its data.
  const demo = (() => {
    const src = readFileSync('demo/demo.js', 'utf8');
    const box: { SolarLensDemo?: { sample(now: number): Record<string, Record<string, unknown>> } } = {};
    new Function('globalThis', 'window', 'document', src)(box, undefined, undefined);
    return box.SolarLensDemo!.sample(Math.floor(Date.now() / 1000));
  })();
  const rowsOf = (answer: Record<string, unknown>, key: string) => answer[key] as Record<string, unknown>[];
  let worker: Record<string, Record<string, unknown>>;

  beforeAll(async () => {
    // The vendor fixtures are dated; a sample from a minute ago gives the day
    // curve and the daily history something to answer with.
    const [{ id }] = h.d1.raw.prepare('SELECT id FROM inverters LIMIT 1').all() as { id: string }[];
    const now = Math.floor(Date.now() / 1000);
    await insertReading(h.env.DB, testReading({ inverterId: id, ts: now - 60 }) as never);
    // A position and an hour of sunlight, so the weather and the expected
    // output have something to answer with.
    await upsertLocation(h.env.DB, id, { lat: 10.5, lng: 20.5 });
    await storeWeather(h.env.DB, id, [{ ts: now - 60, ghi_wm2: 500, temp_c: 20, cloud_pct: 10 }], now);
    worker = {};
    for (const path of ['/api/series', '/api/history', '/api/status', '/api/health', '/api/expected', '/api/weather']) {
      worker[path] = (await (await h.fetch(path)).json()) as Record<string, unknown>;
    }
    worker['/api/locations'] = (await (await h.fetch('/api/locations', { headers: bearer('api-token-for-tests') })).json()) as Record<string, unknown>;
  });

  it('answers every read the dashboard makes', () => {
    for (const path of ['/api/latest', '/api/series', '/api/devices', '/api/devices/history', '/api/history', '/api/periods', '/api/alarms', '/api/health', '/api/status', '/api/expected', '/api/weather', '/api/locations', '/api/settings/tariff', '/auth/status', '/auth/settings']) {
      expect(demo, path).toHaveProperty([path]);
    }
  });

  it('its systems, devices and link history have exactly the Worker\'s fields', () => {
    const inv = fields(served.inverters[0]);
    for (const row of rowsOf(demo['/api/latest'], 'inverters')) expect(fields(row), String(row.id)).toEqual(inv);
    const dev = fields(served.devices[0]);
    for (const row of rowsOf(demo['/api/devices'], 'devices')) expect(fields(row), String(row.id)).toEqual(dev);
    const smp = fields(served.history.samples[0]);
    for (const row of rowsOf(demo['/api/devices/history'], 'samples')) expect(fields(row)).toEqual(smp);
  });

  it('its day curve and daily history have exactly the Worker\'s fields', () => {
    const point = fields(rowsOf(worker['/api/series'], 'points')[0]);
    for (const row of rowsOf(demo['/api/series'], 'points').slice(0, 5)) expect(fields(row)).toEqual(point);
    const day = fields(rowsOf(worker['/api/history'], 'rows')[0]);
    for (const row of rowsOf(demo['/api/history'], 'rows').slice(0, 5)) expect(fields(row)).toEqual(day);
  });

  it('its expected output, weather and positions have the Worker\'s fields', () => {
    const pairs: [string, string][] = [['/api/expected', 'systems'], ['/api/weather', 'hours'], ['/api/locations', 'locations']];
    for (const [path, key] of pairs) {
      expect(fields(demo[path]), path).toEqual(fields(worker[path]));
      const real = rowsOf(worker[path], key);
      expect(real.length, path).toBeGreaterThan(0);
      for (const row of rowsOf(demo[path], key)) expect(fields(row), path).toEqual(fields(real[0]));
    }
    const hour = fields((rowsOf(worker['/api/expected'], 'systems')[0].hours as Record<string, unknown>[])[0]);
    for (const sys of rowsOf(demo['/api/expected'], 'systems')) expect(fields((sys.hours as Record<string, unknown>[])[0])).toEqual(hour);
  });

  it('its tariff is one the Worker would keep, unchanged', () => {
    const t = (demo['/api/settings/tariff'] as { tariff: unknown }).tariff;
    expect(parseTariff(t)).toEqual({ tariff: t });
  });

  it('its status and health answers have the Worker\'s shape', () => {
    expect(fields(demo['/api/status'])).toEqual(fields(worker['/api/status']));
    expect(fields(demo['/api/health'])).toEqual(fields(worker['/api/health']));
  });

  it('names its devices in their history as it names them in the list', () => {
    const ids = new Set(rowsOf(demo['/api/devices'], 'devices').map((d) => d.id));
    for (const r of rowsOf(demo['/api/devices/history'], 'samples')) expect(ids.has(r.device_id)).toBe(true);
  });
});
