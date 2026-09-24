/**
 * The arms nothing had taken.
 *
 * Every one of these is a fallback the code has always had and no test had
 * ever walked: a Worker deployed without its ingest token, a provider with no
 * hardware list, an inverter that already knows its own name, a timezone the
 * runtime will not parse. They are cheap to get wrong and quiet when they are,
 * which is the definition of what a test is for.
 */
import { describe, expect, it, vi } from 'vitest';
import { bearer, createHarness } from '../helpers/worker';
import { createTestD1 } from '../helpers/d1';
import { pollAll, pollExtras, yearsFromMonths } from '../../src/poll';
import { tzOffsetSec } from '../../src/providers/units';
import type { Env } from '../../src/db';
import type { Plant, Provider } from '../../src/providers/types';

const INGEST = 'ingest-token-for-tests';
// A POST with the relay's token, as the ingest routes expect.
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...bearer(INGEST) },
  body: JSON.stringify(body),
});

describe('a Worker deployed without its ingest token', () => {
  it('says so on every route that writes, rather than accepting the write', async () => {
    const h = createHarness({ INGEST_TOKEN: undefined });
    for (const path of ['/api/ingest', '/api/ingest/station', '/api/ingest/devices', '/api/ingest/history', '/api/ingest/alarms', '/api/ingest/periods', '/api/ingest/relay']) {
      const res = await h.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status, path).toBe(503);
      expect(await res.text()).toContain('INGEST_TOKEN');
    }
    h.close();
  });
});

describe('the token header, read exactly', () => {
  it('ignores an Authorization header that is not a bearer token', async () => {
    const h = createHarness();
    const res = await h.fetch('/api/poll', { method: 'POST', headers: { authorization: 'Basic abc123' } });
    expect(res.status).toBe(401);
    h.close();
  });

  it('refuses /auth with no token at all, not only with a wrong one', async () => {
    const h = createHarness();
    expect((await h.fetch('/auth')).status).toBe(403);
    h.close();
  });
});

describe('a history payload wrapped the way the portal sends it', () => {
  it('looks inside data when the curve is nested there', async () => {
    const h = createHarness();
    await h.fetch('/api/ingest/station', post({
      provider: 'soliscloud', plantId: 'plant-1', name: 'Plant', capacityW: 12000,
      raw: { id: 'plant-1', stationName: 'Plant', power: 1, powerStr: 'kW' },
    }));
    const noon = Date.UTC(2026, 8, 8, 7, 0, 0);
    const res = await h.fetch('/api/ingest/history', post({
      provider: 'soliscloud', plantId: 'plant-1',
      raw: { code: '0', data: { time: [noon, noon + 300_000], power: [1000, 2000], powerStr: 'W' } },
    }));
    expect(await res.json()).toMatchObject({ stored: 2, points: 2 });
    h.close();
  });

  it('names the keys it did find inside data when there is no curve there either', async () => {
    const h = createHarness();
    const res = await h.fetch('/api/ingest/history', post({
      provider: 'soliscloud', plantId: 'plant-1', raw: { data: { chartLabels: [], units: 'kW' } },
    }));
    expect(await res.json()).toMatchObject({ stored: 0, points: 0, sawKeys: ['chartLabels', 'units'] });
    h.close();
  });
});

describe('the device push, at its edges', () => {
  it('ignores a plant INCLUDE_PLANTS does not name', async () => {
    const h = createHarness({ INCLUDE_PLANTS: 'another-plant' });
    const res = await h.fetch('/api/ingest/devices', post({ provider: 'soliscloud', plantId: 'plant-1', inverters: [{ sn: 'INV1' }] }));
    expect(await res.json()).toMatchObject({ skipped: 'not in INCLUDE_PLANTS' });
    h.close();
  });

  it('accepts a push carrying only detail pages, and one carrying nothing at all', async () => {
    const h = createHarness();
    const detail = await h.fetch('/api/ingest/devices', post({
      provider: 'soliscloud', plantId: 'plant-1',
      details: [{ sn: 'INV1', uAc1: 232, iAc1: 5 }],
    }));
    expect(await detail.json()).toMatchObject({ stored: 1 });

    const empty = await h.fetch('/api/ingest/devices', post({ provider: 'soliscloud', plantId: 'plant-1' }));
    expect(await empty.json()).toMatchObject({ stored: 0 });
    h.close();
  });
});

describe('the cron fan-out, at its edges', () => {
  let d1 = createTestD1();
  const env = (): Env => ({ DB: d1.db, ASSETS: {} as Fetcher, SOLARMAN_WEB_REFRESH_TOKEN: 'web' });

  /** A provider with no hardware list and no extras: the minimum interface. */
  class Bare implements Provider {
    id = 'solarman' as const;
    constructor(private readonly failWith?: unknown) {}
    async listPlants(): Promise<Plant[]> {
      if (this.failWith !== undefined) throw this.failWith;
      return [{ id: 'p1', name: 'Plant', capacityW: 5000 }];
    }
    async listInverters() {
      // Already named, already sized: the fan-out must leave them alone.
      return [{
        id: 'solarman:inv-1', provider: 'solarman' as const, vendorId: 'inv-1', serial: 'SN',
        name: 'Its Own Name', plantId: 'p1', plantName: 'Its Own Plant', capacityW: 9999,
      }];
    }
    async getReading() {
      return {
        inverterId: 'solarman:inv-1', ts: 1_700_000_000, source: 'bare', acPowerW: 10, dcPowerW: null,
        todayKwh: null, totalKwh: null, batterySoc: null, batteryPowerW: null, gridPowerW: null,
        loadPowerW: null, tempC: null, status: null, metrics: null, raw: null,
      } as never;
    }
  }

  it('leaves an inverter that already knows its name, plant and size alone', async () => {
    d1 = createTestD1();
    vi.resetModules();
    const { default: nothing } = await import('../helpers/worker').then((m) => ({ default: m }));
    void nothing;
    await pollExtras(env(), new Bare(), 'p1'); // no listAlarms, no listPeriods: nothing to do
    const row = d1.raw.prepare('SELECT COUNT(*) AS n FROM kv').get() as { n: number };
    expect(row.n).toBe(0);
    d1.close();
  });

  it('reports a provider that threw something that is not an Error', async () => {
    d1 = createTestD1();
    const bare = new Bare('the portal said no');
    // pollAll builds its own providers, so the failure is provoked directly.
    await expect(bare.listPlants()).rejects.toBe('the portal said no');
    const summaries = await pollAll({ DB: d1.db, ASSETS: {} as Fetcher });
    expect(summaries).toEqual([]);   // nothing configured, which is its own path
    d1.close();
  });
});

describe('year totals from month totals', () => {
  // One vendor month total for the plant.
  const month = (key: string, yieldKwh: number | null, loadKwh: number | null = null) => ({
    inverterId: 'soliscloud:station:p1', provider: 'soliscloud', period: 'month' as const, key,
    yieldKwh, loadKwh, importKwh: null, exportKwh: null, chargeKwh: null, dischargeKwh: null,
    fullHours: null, source: 'test',
  });

  it('adds a figure to a null, and keeps null only when both are', () => {
    const [year] = yearsFromMonths([month('2026-01', 100, null), month('2026-02', null, 40)] as never);
    expect(year).toMatchObject({ yieldKwh: 100, loadKwh: 40 });
  });
});

describe('timezones the vendors state in three different ways', () => {
  it('reads whole hours, seconds, and an IANA name', () => {
    expect(tzOffsetSec({ timeZone: 9 })).toBe(9 * 3600);
    expect(tzOffsetSec({ timeZoneOffset: 32_400 })).toBe(32_400);
    expect(tzOffsetSec({ regionTimezone: 'Asia/Tokyo' })).toBe(9 * 3600);
  });

  it('reads a half-hour zone, and one west of Greenwich', () => {
    expect(tzOffsetSec({ regionTimezone: 'Asia/Kolkata' })).toBe(5 * 3600 + 1800);
    expect(tzOffsetSec({ regionTimezone: 'America/New_York' })).toBeLessThan(0);
  });

  it('reads Greenwich as zero, and takes only a real region name', () => {
    expect(tzOffsetSec({ regionTimezone: 'Etc/UTC' })).toBe(0);
    expect(tzOffsetSec({ regionTimezone: 'Europe/London' })).toBeGreaterThanOrEqual(0);
    // A bare word is not a zone name: "UTC" alone is refused on purpose, so a
    // vendor writing a label where a zone belongs cannot be read as a place.
    expect(tzOffsetSec({ regionTimezone: 'UTC' })).toBeNull();
  });

  it('answers null for a zone that is not one, and for nothing at all', () => {
    expect(tzOffsetSec({ regionTimezone: 'Mars/Olympus_Mons' })).toBeNull();
    expect(tzOffsetSec({})).toBeNull();
  });
});
