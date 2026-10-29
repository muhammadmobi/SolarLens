/**
 * Where each system is, and the sunlight it has had.
 *
 * A position is the most identifying thing SolarLens holds, so these hold it to
 * three promises: it is read only from the vendor's own record, it goes to
 * nobody but the owner - and, rounded to about a kilometre, the weather
 * service - and it never appears in a public answer. The weather itself is
 * checked for what the page will lean on: hours stamped at their end, only
 * hours that have happened, three months on the first fetch and an hour after.
 * Open-Meteo is stubbed; nothing here reaches the network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIRST_DAYS, WEATHER_KEEP_S, fetchWeather, locationOf, locations, parseWeather, refreshWeather, storeWeather, upsertLocation, weatherSince } from '../../src/weather';
import { TYPICAL_RATIO, expectedToday } from '../../src/expected';
import { createTestD1, type TestD1 } from '../helpers/d1';
import { bearer, createHarness } from '../helpers/worker';

// A made-up position, well away from any real plant.
const HERE = { lat: 12.346, lng: -45.679 };

describe('a position, from a vendor record', () => {
  it("reads SolisCloud's latitude and longitude, and SolarMan's locationLat and locationLng", () => {
    expect(locationOf({ latitude: '12.346', longitude: '-45.679' })).toEqual(HERE);
    expect(locationOf({ locationLat: 12.346, locationLng: -45.679 })).toEqual(HERE);
  });

  it('refuses one that is out of range, missing, or 0,0 - the blank a form leaves', () => {
    expect(locationOf({ latitude: 91, longitude: 0 })).toBeNull();
    expect(locationOf({ latitude: 10, longitude: 181 })).toBeNull();
    expect(locationOf({ latitude: '', longitude: '5' })).toBeNull();
    expect(locationOf({ latitude: 0, longitude: 0 })).toBeNull();
    expect(locationOf({ name: 'No position' })).toBeNull();
    expect(locationOf(null)).toBeNull();
  });
});

describe("Open-Meteo's answer", () => {
  const answer = { hourly: { time: [3600, 7200, 'x'], shortwave_radiation: [0, 512.5], temperature_2m: [11.2, 13.9], cloud_cover: [80, 20] } };

  it('becomes rows, each stamped at the end of the hour it describes', () => {
    expect(parseWeather(answer)).toEqual([
      { ts: 3600, ghi_wm2: 0, temp_c: 11.2, cloud_pct: 80 },
      { ts: 7200, ghi_wm2: 512.5, temp_c: 13.9, cloud_pct: 20 },
    ]);
  });

  it('is nothing when it is not what was asked for', () => {
    expect(parseWeather(null)).toEqual([]);
    expect(parseWeather({ hourly: {} })).toEqual([]);
    expect(parseWeather({ error: true })).toEqual([]);
  });

  it('is asked for at the position rounded to about a kilometre, never the exact one', async () => {
    const asked: string[] = [];
    const fetcher = (async (url: string) => { asked.push(url); return new Response(JSON.stringify(answer)); }) as unknown as typeof fetch;
    await fetchWeather(HERE, 3, fetcher);
    const u = new URL(asked[0]);
    expect(u.searchParams.get('latitude')).toBe('12.35');
    expect(u.searchParams.get('longitude')).toBe('-45.68');
    expect(u.searchParams.get('past_days')).toBe('3');
    expect(asked[0]).not.toContain('12.346');
  });

  it('says what went wrong when the service refuses', async () => {
    const fetcher = (async () => new Response('busy', { status: 429 })) as unknown as typeof fetch;
    await expect(fetchWeather(HERE, 1, fetcher)).rejects.toThrow('HTTP 429');
  });
});

describe('the weather kept', () => {
  let d1: TestD1 | undefined;
  afterEach(() => { d1?.close(); d1 = undefined; });

  it('keeps only hours that have happened, and updates an hour seen before', async () => {
    d1 = createTestD1();
    await storeWeather(d1!.db, 'inv', [{ ts: 100, ghi_wm2: 1, temp_c: 1, cloud_pct: 1 }, { ts: 5000, ghi_wm2: 9, temp_c: 9, cloud_pct: 9 }], 1000);
    await storeWeather(d1!.db, 'inv', [{ ts: 100, ghi_wm2: 2, temp_c: 2, cloud_pct: 2 }], 1000);
    expect(await weatherSince(d1!.db, 0)).toEqual([{ inverter_id: 'inv', ts: 100, ghi_wm2: 2, temp_c: 2, cloud_pct: 2 }]);
  });

  it('fetches three months the first time, an hour at a time after, and forgets a year-old hour', async () => {
    d1 = createTestD1();
    const now = 10 * WEATHER_KEEP_S;
    await upsertLocation(d1!.db, 'inv', HERE);
    d1!.raw.prepare('INSERT INTO weather_hourly (inverter_id, ts, ghi_wm2) VALUES (?, ?, ?)').run('old', now - WEATHER_KEEP_S - 10, 1);
    const days: string[] = [];
    const fetcher = (async (url: string) => {
      days.push(new URL(url).searchParams.get('past_days')!);
      return new Response(JSON.stringify({ hourly: { time: [now - 3600, now + 3600], shortwave_radiation: [400, 500] } }));
    }) as unknown as typeof fetch;
    await refreshWeather(d1!.db, now, fetcher);
    await refreshWeather(d1!.db, now + 60, fetcher);        // not due yet
    await refreshWeather(d1!.db, now + 3700, fetcher);      // an hour on
    expect(days).toEqual([String(FIRST_DAYS), '1']);
    const kept = await weatherSince(d1!.db, 0);
    expect(kept.map((r) => r.inverter_id)).toEqual(['inv', 'inv']);   // the forecast hour and the old one are not
  });

  it('carries on with the others when one position fails', async () => {
    d1 = createTestD1();
    await upsertLocation(d1!.db, 'a', HERE);
    await upsertLocation(d1!.db, 'b', { lat: 1, lng: 1 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetcher = (async (url: string) => (new URL(url).searchParams.get('latitude') === '12.35'
      ? new Response('down', { status: 503 })
      : new Response(JSON.stringify({ hourly: { time: [100], shortwave_radiation: [300] } })))) as unknown as typeof fetch;
    await refreshWeather(d1!.db, 1000, fetcher);
    expect((await weatherSince(d1!.db, 0)).map((r) => r.inverter_id)).toEqual(['b']);
    expect(warn.mock.calls.join(' ')).not.toContain('12.3');
    warn.mockRestore();
  });

  it('keeps the known position when a record carries none', async () => {
    d1 = createTestD1();
    await upsertLocation(d1!.db, 'inv', HERE);
    await upsertLocation(d1!.db, 'inv', null);
    expect(await locations(d1!.db)).toEqual([{ inverter_id: 'inv', ...HERE }]);
  });
});

describe('positions and weather through the Worker', () => {
  const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...bearer('ingest-token-for-tests') }, body: JSON.stringify(body) });
  const relayed = { id: 'plant-9', stationName: 'Roof', power: 2, powerStr: 'kW', dayEnergy: 3, dayEnergyStr: 'kWh', latitude: '12.346', longitude: '-45.679', timeZone: 0 };

  it('keeps a relayed position, and no public answer carries it', async () => {
    const h = createHarness();
    await h.fetch('/api/ingest/station', post({ provider: 'soliscloud', plantId: 'plant-9', raw: relayed, source: 'soliscloud-relay' }));
    expect(await locations(h.env.DB)).toEqual([{ inverter_id: 'soliscloud:station:plant-9', ...HERE }]);
    for (const path of ['/api/latest', '/api/devices', '/api/health', '/api/series', '/api/weather']) {
      const text = await (await h.fetch(path)).text();
      expect(text, path).not.toContain('12.346');
      expect(text, path).not.toContain('45.679');
    }
    h.close();
  });

  it('serves positions to the owner, and to nobody else', async () => {
    const h = createHarness();
    await h.fetch('/api/ingest/station', post({ provider: 'soliscloud', plantId: 'plant-9', raw: relayed, source: 'soliscloud-relay' }));
    expect((await h.fetch('/api/locations')).status).toBe(401);
    const owner = await h.fetch('/api/locations', { headers: bearer('api-token-for-tests') });
    expect(await owner.json()).toMatchObject({ locations: [{ id: 's1', ...HERE }] });
    expect(owner.headers.get('cache-control')).toBe('no-store');
    h.close();
  });

  it('serves the weather under system aliases, for a window of one to fourteen days', async () => {
    const h = createHarness();
    await h.fetch('/api/ingest/station', post({ provider: 'soliscloud', plantId: 'plant-9', raw: relayed, source: 'soliscloud-relay' }));
    const now = Math.floor(Date.now() / 1000);
    await storeWeather(h.env.DB, 'soliscloud:station:plant-9', [{ ts: now - 3600, ghi_wm2: 610, temp_c: 21, cloud_pct: 10 }], now);
    const body = (await (await h.fetch('/api/weather')).json()) as { days: number; hours: Record<string, unknown>[] };
    expect(body.days).toBe(2);
    expect(body.hours).toEqual([{ inverter_id: 's1', ts: now - 3600, ghi_wm2: 610, temp_c: 21, cloud_pct: 10 }]);
    const days = async (q: string) => ((await (await h.fetch(`/api/weather?days=${q}`)).json()) as { days: number }).days;
    expect(await days('0')).toBe(1);
    expect(await days('99')).toBe(14);
    expect(await days('x')).toBe(2);
    h.close();
  });

  it('fetches the weather from the cron', async () => {
    const h = createHarness();
    await upsertLocation(h.env.DB, 'soliscloud:station:plant-9', HERE);
    const now = Math.floor(Date.now() / 1000);
    const stub = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ hourly: { time: [now - 3600], shortwave_radiation: [700] } })));
    await h.cron();
    expect((await weatherSince(h.env.DB, 0)).map((r) => r.ghi_wm2)).toEqual([700]);
    stub.mockRestore();
    h.close();
  });
});

/**
 * What a system should make, given its sun. The ratio is learned from full,
 * sunny days only, as the median, and a typical one stands in until three
 * such days exist.
 */
describe('expected output', () => {
  let d1: TestD1 | undefined;
  afterEach(() => { d1?.close(); d1 = undefined; });

  // A plant on UTC, 5 kWp, and a clear-sky day: sun from 06:00 to 18:00 peaking at 800 W/m2.
  const DAY = 86400;
  const now = 20 * DAY + 13 * 3600;   // 13:00 on day 20
  const sunHours = (day: number, scale = 1) => Array.from({ length: 12 }, (_, i) => ({
    ts: day * DAY + (7 + i) * 3600, ghi_wm2: Math.round(800 * scale * Math.sin((Math.PI * (i + 0.5)) / 12)), temp_c: 20, cloud_pct: 0,
  }));
  async function withDays(yields: [number, number, number][]) {
    d1 = createTestD1();
    d1!.raw.prepare("INSERT INTO inverters (id, provider, vendor_id, name, plant_id, capacity_w, tz_offset_sec, first_seen, last_seen) VALUES ('inv','solarman','v','Roof','p',5000,0,0,0)").run();
    for (const [day, kwh, scale] of yields) {
      await storeWeather(d1!.db, 'inv', sunHours(day, scale), now);
      // Enough readings to count as a full day, the day's total on the last.
      for (let k = 0; k < 70; k++) {
        d1!.raw.prepare("INSERT INTO readings (inverter_id, ts, source, today_kwh, tz_offset_sec) VALUES ('inv', ?, 'test', ?, 0)").run(day * DAY + 6 * 3600 + k * 600, k === 69 ? kwh : kwh * (k / 69));
      }
    }
    await storeWeather(d1!.db, 'inv', sunHours(20), now);
  }
  // Clear-day sunlight above: about 6.1 kWh/m2. At 5 kWp and a ratio of 0.75, about 22.9 kWh.
  const sunKwh = sunHours(0).reduce((a, h) => a + h.ghi_wm2 / 1000, 0);

  it('learns the ratio as the median of full, sunny days, and ignores a dark one', async () => {
    const r = (x: number) => Math.round(x * sunKwh * 5 * 10) / 10;
    await withDays([[15, r(0.7), 1], [16, r(0.75), 1], [17, r(0.8), 1], [18, 0.2, 0.1]]);
    const [e] = await expectedToday(d1!.db, [{ id: 'inv', capacity_w: 5000, tz_offset_sec: 0 }], now);
    expect(e.learned).toBe(true);
    expect(e.days).toBe(3);
    expect(e.ratio).toBeCloseTo(0.75, 2);
  });

  it("gives today's expected curve up to now, and the energy it adds up to", async () => {
    await withDays([[15, 20, 1], [16, 20, 1], [17, 20, 1]]);
    const [e] = await expectedToday(d1!.db, [{ id: 'inv', capacity_w: 5000, tz_offset_sec: 0 }], now);
    // Hours ending 07:00 to 13:00 of today.
    expect(e.hours.map((h) => (h.ts % DAY) / 3600)).toEqual([7, 8, 9, 10, 11, 12, 13]);
    // The ratio is reported to three places; the curve uses it unrounded.
    expect(e.hours[0].expected_w).toBeCloseTo(sunHours(20)[0].ghi_wm2 * 5 * e.ratio, -1);
    expect(e.expected_kwh).toBeCloseTo(e.hours.reduce((a, h) => a + h.expected_w / 1000, 0), 0);
  });

  it('says it is guessing until three days have been learned from', async () => {
    await withDays([[17, 20, 1]]);
    const [e] = await expectedToday(d1!.db, [{ id: 'inv', capacity_w: 5000, tz_offset_sec: 0 }], now);
    expect(e).toMatchObject({ learned: false, ratio: TYPICAL_RATIO, days: 1 });
  });

  it('leaves out a system with no size or no weather', async () => {
    await withDays([]);
    expect(await expectedToday(d1!.db, [{ id: 'inv', capacity_w: null, tz_offset_sec: 0 }, { id: 'nowhere', capacity_w: 5000, tz_offset_sec: 0 }], now)).toEqual([]);
  });

  it('is served under system aliases', async () => {
    const h = createHarness();
    const now2 = Math.floor(Date.now() / 1000);
    await h.fetch('/api/ingest/station', { method: 'POST', headers: { 'content-type': 'application/json', ...bearer('ingest-token-for-tests') },
      body: JSON.stringify({ provider: 'soliscloud', plantId: 'plant-9', capacityW: 5000, raw: { id: 'plant-9', power: 2, powerStr: 'kW', timeZone: 0 }, source: 'soliscloud-relay' }) });
    await storeWeather(h.env.DB, 'soliscloud:station:plant-9', [{ ts: now2 - 60, ghi_wm2: 500, temp_c: 20, cloud_pct: 0 }], now2);
    const body = (await (await h.fetch('/api/expected')).json()) as { systems: { inverter_id: string; ratio: number }[] };
    expect(body.systems).toMatchObject([{ inverter_id: 's1', ratio: TYPICAL_RATIO }]);
    h.close();
  });
});
