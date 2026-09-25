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
import { bearer, createHarness, type Harness } from '../helpers/worker';
import { devices, inverters } from '../fixtures/dashboard-api';

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...bearer('ingest-token-for-tests') },
  body: JSON.stringify(body),
});
const fixture = (name: string) => JSON.parse(readFileSync(`tests/fixtures/${name}`, 'utf8'));

/** Field names, sorted, so a failure lists exactly what is missing or extra. */
const fields = (row: object) => Object.keys(row).sort();

let h: Harness;
let served: { inverters: Record<string, unknown>[]; devices: Record<string, unknown>[] };

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
